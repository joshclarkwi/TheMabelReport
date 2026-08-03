/*
 * Sevens — table wiring: screens, rendering, and the link between the phones.
 *
 * Networking is peer-to-peer over WebRTC (PeerJS). One phone hosts and is the
 * sole authority on game state; every other phone sends requests and renders
 * whatever the host sends back. That keeps the rules honest even though all
 * ends run the same code, it means a dropped connection loses nothing, and no
 * player is ever sent anyone else's cards.
 *
 * The host also runs the computer players, and stands in for a human whose
 * phone has gone quiet so a table of eight cannot be held up by one flat
 * battery.
 */
(function () {
  'use strict';

  var G = window.SevensGame;
  var PREFIX = 'mabelsevens-';
  var ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';   // no look-alikes to mistype
  var ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  };

  // Correspondents of long standing, available to make up the numbers.
  var BOT_NAMES = ['Ada', 'Bramble', 'Clement', 'Dorsey', 'Esme', 'Fitch', 'Greer'];

  var TICK_MS = 500;        // host clock: bots, stand-ins, liveness
  var BEAT_EVERY = 6;       // ping every sixth tick
  var DEAD_MS = 11000;      // silence after which a link is presumed dead
  var BOT_DELAY = 900;      // let humans watch the computer think
  var STANDIN_MS = 20000;   // how long a vanished player holds up the table

  function el(id) { return document.getElementById(id); }

  var App = {
    role: null,            // 'host' | 'guest'
    code: null,
    myName: 'You',
    clientId: null,
    peer: null,
    conn: null,            // guest: the link to the host
    clients: {},           // host: clientId -> { conn, name, seat, lastRecv }
    order: [],             // host: clientIds in the order they sat down
    tbl: null,             // host: the table itself
    payload: null,         // last thing rendered
    played: {},            // suit -> {low, high} as last drawn, for the land flourish
    playedTotal: 0,
    tick: null,
    ticks: 0,
    lastRecv: 0,
    awaySig: '',
    rejoinTimer: null,
    rejoinTries: 0,
    idTries: 0
  };

  /* ================= small helpers ================= */

  function showScreen(name) {
    ['lobby', 'wait', 'game', 'rules'].forEach(function (s) {
      el('screen-' + s).classList.toggle('is-active', s === name);
    });
  }

  function notice(id, text, bad) {
    var n = el(id);
    n.textContent = text || '';
    n.classList.toggle('bad', !!bad);
  }

  function cleanName(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 14);
  }

  function makeCode() {
    var out = '';
    for (var i = 0; i < 4; i++) out += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
    return out;
  }

  function myClientId() {
    if (App.clientId) return App.clientId;
    var id = null;
    try { id = localStorage.getItem('sevens-client'); } catch (e) {}
    if (!id) {
      id = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      try { localStorage.setItem('sevens-client', id); } catch (e) {}
    }
    App.clientId = id;
    return id;
  }

  function listOf(names) {
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ' and ' + names[1];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  function eachClient(fn) {
    Object.keys(App.clients).forEach(function (cid) {
      var c = App.clients[cid];
      if (c) fn(c, cid);
    });
  }

  function trySend(conn, msg) {
    if (conn && conn.open) { try { conn.send(msg); } catch (e) {} }
  }

  function isPlaying() { return el('screen-game').classList.contains('is-active'); }

  /* ================= persistence =================
   * iOS is quick to evict a backgrounded tab. Stashing the table means a reload
   * silently picks the game back up instead of ending the evening. */

  function saveSession() {
    try {
      var blob = { role: App.role, code: App.code, myName: App.myName };
      if (App.role === 'host' && App.tbl) {
        blob.tbl = {
          started: App.tbl.started,
          botCount: App.tbl.botCount,
          seats: App.tbl.seats,
          state: App.tbl.state,
          score: App.tbl.score,
          scored: App.tbl.scored,
          deals: App.tbl.deals
        };
        blob.roster = App.order.map(function (cid) {
          return { clientId: cid, name: App.clients[cid] ? App.clients[cid].name : 'Player' };
        });
      }
      sessionStorage.setItem('sevens', JSON.stringify(blob));
    } catch (e) { /* private mode: play on without a safety net */ }
  }

  function clearSession() {
    try { sessionStorage.removeItem('sevens'); } catch (e) {}
  }

  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem('sevens') || 'null'); }
    catch (e) { return null; }
  }

  /* ================= peer plumbing ================= */

  function makePeer(id) {
    if (typeof Peer === 'undefined') return null;   // script blocked or failed to load
    var peer = id ? new Peer(id, { config: ICE }) : new Peer({ config: ICE });
    peer.on('disconnected', function () {
      if (!peer.destroyed) { try { peer.reconnect(); } catch (e) {} }
    });
    return peer;
  }

  function newTable() {
    return {
      started: false,
      botCount: 0,
      seats: [],
      state: null,
      score: [],
      scored: false,
      deals: 0,
      lastTurn: -1,
      turnAt: 0,
      standIn: {}        // seats the house is currently playing for
    };
  }

  function startHosting(resumeCode) {
    App.role = 'host';
    myClientId();
    if (!App.tbl) App.tbl = newTable();
    App.code = resumeCode || makeCode();
    el('code-display').textContent = App.code;

    if (!resumeCode) {
      el('screen-wait').classList.add('is-host');
      showScreen('wait');
      notice('wait-notice', '');
      renderWaitFromTable();
    }

    App.peer = makePeer(PREFIX + App.code);
    if (!App.peer) {
      notice('wait-notice', 'The connection library did not load. Reload the page.', true);
      return;
    }

    App.peer.on('open', function () { App.idTries = 0; saveSession(); });

    App.peer.on('connection', function (conn) {
      conn.on('data', function (msg) { hostReceive(conn, msg); });
      conn.on('close', function () { touchAway(); });
      conn.on('error', function () { touchAway(); });
    });

    App.peer.on('error', function (err) {
      if (err.type === 'unavailable-id' && App.idTries < 4) {
        App.idTries++;
        try { App.peer.destroy(); } catch (e) {}
        if (resumeCode) {
          // Our own stale registration from before the reload. Wait for it to
          // clear rather than moving to a code the others know nothing about.
          setTimeout(function () { startHosting(resumeCode); }, 1500);
        } else {
          startHosting(null);   // genuine clash on a fresh table — take another
        }
        return;
      }
      if (err.type === 'network' || err.type === 'server-error') return;
      notice('wait-notice', 'Could not open a table. Check the signal and try again.', true);
    });

    startTick();
  }

  function startJoining(code) {
    App.role = 'guest';
    myClientId();
    App.code = code;
    el('screen-wait').classList.remove('is-host');

    App.peer = makePeer(null);
    if (!App.peer) {
      notice('lobby-notice', 'The connection library did not load. Reload the page.', true);
      showScreen('lobby');
      return;
    }

    App.peer.on('open', function () { dial(); });

    App.peer.on('error', function (err) {
      if (err.type === 'peer-unavailable') {
        if (isPlaying() || onWaitScreen()) { scheduleRejoin(); return; }   // host briefly away
        notice('lobby-notice', 'No table found under that code.', true);
        teardown();
        showScreen('lobby');
        return;
      }
      if (err.type === 'network' || err.type === 'server-error') return;
      if (!isPlaying() && !onWaitScreen()) {
        notice('lobby-notice', 'Could not reach the table. Try again in a moment.', true);
        teardown();
        showScreen('lobby');
      }
    });

    startTick();
  }

  function onWaitScreen() { return el('screen-wait').classList.contains('is-active'); }

  function dial() {
    if (!App.peer || App.peer.destroyed) return;
    attachGuestConn(App.peer.connect(PREFIX + App.code, { reliable: true }));
  }

  function attachGuestConn(conn) {
    if (App.conn && App.conn !== conn) { try { App.conn.close(); } catch (e) {} }
    App.conn = conn;

    conn.on('open', function () {
      App.rejoinTries = 0;
      App.lastRecv = Date.now();
      hideNetTrouble();
      trySend(conn, { t: 'hello', name: App.myName, clientId: myClientId() });
      saveSession();
    });

    conn.on('data', function (msg) {
      if (!msg || typeof msg !== 'object') return;
      App.lastRecv = Date.now();
      if (msg.t === 'ping') return;
      guestReceive(msg);
    });

    conn.on('close', function () {
      if (App.conn === conn) App.conn = null;
      onDrop();
    });
    conn.on('error', function () { onDrop(); });
  }

  function onDrop() {
    if (!isPlaying() && !onWaitScreen()) return;
    if (App.role !== 'guest') return;
    showNetTrouble('Trying to reach the table…');
    scheduleRejoin();
  }

  function scheduleRejoin() {
    if (App.rejoinTimer) return;
    var wait = Math.min(1000 * Math.pow(1.6, App.rejoinTries), 8000);
    App.rejoinTries++;
    App.rejoinTimer = setTimeout(function () {
      App.rejoinTimer = null;
      if (App.conn && App.conn.open) return;
      dial();
      if (!App.conn || !App.conn.open) scheduleRejoin();
    }, wait);
  }

  function showNetTrouble(text) {
    el('net-sub').textContent = text;
    el('net-overlay').classList.add('is-open');
  }
  function hideNetTrouble() { el('net-overlay').classList.remove('is-open'); }

  function teardown() {
    stopTick();
    if (App.rejoinTimer) { clearTimeout(App.rejoinTimer); App.rejoinTimer = null; }
    if (App.conn) { try { App.conn.close(); } catch (e) {} App.conn = null; }
    eachClient(function (c) { if (c.conn) { try { c.conn.close(); } catch (e) {} } });
    if (App.peer) { try { App.peer.destroy(); } catch (e) {} App.peer = null; }
    App.clients = {};
    App.order = [];
    App.tbl = null;
    App.payload = null;
    App.role = null;
    App.rejoinTries = 0;
    App.played = {};
    App.playedTotal = 0;
    hideNetTrouble();
    el('overlay').classList.remove('is-open');
    clearSession();
  }

  /* ================= host: the table ================= */

  function roster() {
    var out = [{ kind: 'human', name: App.myName, clientId: myClientId() }];
    App.order.forEach(function (cid) {
      var c = App.clients[cid];
      if (c) out.push({ kind: 'human', name: c.name, clientId: cid });
    });
    return out;
  }

  function seatPreview() {
    var out = roster().map(function (p) { return { name: p.name, kind: 'human' }; });
    for (var i = 0; i < App.tbl.botCount; i++) out.push({ name: BOT_NAMES[i], kind: 'bot' });
    return out;
  }

  function clampBots() {
    var room = G.MAX_PLAYERS - roster().length;
    App.tbl.botCount = Math.max(0, Math.min(room, App.tbl.botCount));
  }

  function setBots(want) {
    if (!App.tbl || App.tbl.started) return;
    var room = G.MAX_PLAYERS - roster().length;
    App.tbl.botCount = Math.max(0, Math.min(room, want));
    saveSession();
    broadcast();
  }

  function startGame() {
    var seats = roster();
    for (var i = 0; i < App.tbl.botCount; i++) seats.push({ kind: 'bot', name: BOT_NAMES[i] });
    if (seats.length < G.MIN_PLAYERS) return;

    App.tbl.seats = seats;
    App.tbl.score = seats.map(function () { return 0; });
    App.tbl.started = true;
    App.tbl.deals = 0;

    seats.forEach(function (s, i) {
      if (s.kind === 'human' && s.clientId !== myClientId() && App.clients[s.clientId]) {
        App.clients[s.clientId].seat = i;
      }
    });
    deal();
  }

  function deal() {
    var t = App.tbl;
    // The deal rotates so the short hands — which win noticeably more often —
    // move around the table instead of favouring the same seats all evening.
    t.state = G.newGame(t.seats.length, t.deals);
    t.deals++;
    t.scored = false;
    t.lastTurn = -1;
    t.standIn = {};
    App.played = {};
    App.playedTotal = 0;
    saveSession();
    broadcast();
  }

  function settle() {
    var t = App.tbl;
    if (t.state && t.state.winner !== null && !t.scored) {
      t.score[t.state.winner]++;
      t.scored = true;
    }
  }

  function isOver() {
    var st = App.tbl && App.tbl.state;
    return !!st && (st.winner !== null || st.stuck);
  }

  function seatAway(i) {
    var t = App.tbl;
    var s = t.seats[i];
    if (!s || s.kind === 'bot' || s.clientId === myClientId()) return false;
    var c = App.clients[s.clientId];
    return !c || !c.conn || !c.conn.open || (Date.now() - c.lastRecv > DEAD_MS);
  }

  /*
   * The host's own connection banner. A single absent player is shown on their
   * chip, not across the whole screen — the banner is only right when nobody
   * the host is expecting is reachable at all. Getting this wrong locks the
   * host out of their own cards, since the overlay swallows every tap.
   */
  function hostNetState() {
    var t = App.tbl;
    if (!t || !t.started) { hideNetTrouble(); return; }

    var expected = 0, reachable = 0;
    t.seats.forEach(function (s) {
      if (s.kind !== 'human' || s.clientId === myClientId()) return;
      expected++;
      var c = App.clients[s.clientId];
      if (c && c.conn && c.conn.open) reachable++;
    });

    if (expected === 0 || reachable > 0) hideNetTrouble();
    else showNetTrouble('Waiting for the other players to come back…');
  }

  function touchAway() {
    if (!App.tbl || !App.tbl.started) { if (App.tbl) broadcast(); return; }
    var sig = App.tbl.seats.map(function (s, i) { return seatAway(i) ? '1' : '0'; }).join('');
    if (sig !== App.awaySig) { App.awaySig = sig; broadcast(); }
  }

  function hostReceive(conn, msg) {
    if (!msg || typeof msg !== 'object' || !App.tbl) return;

    if (msg.t === 'hello') {
      var cid = String(msg.clientId == null ? '' : msg.clientId).slice(0, 48);
      if (!cid) return;
      var name = cleanName(msg.name) || 'Player';
      var existing = App.clients[cid];

      if (existing) {
        existing.conn = conn;                       // a reconnect keeps its seat
        existing.name = name;
        existing.lastRecv = Date.now();
        // They are back, so hand their cards over to them again.
        if (existing.seat != null) delete App.tbl.standIn[existing.seat];
      } else if (App.tbl.started) {
        trySend(conn, { t: 'denied', why: 'That game has already started.' });
        return;
      } else if (roster().length + App.tbl.botCount >= G.MAX_PLAYERS) {
        trySend(conn, { t: 'denied', why: 'That table is full.' });
        return;
      } else {
        App.clients[cid] = { conn: conn, name: name, seat: null, lastRecv: Date.now() };
        App.order.push(cid);
        clampBots();
      }
      conn.__cid = cid;
      saveSession();
      broadcast();
      hostNetState();
      return;
    }

    var c = conn.__cid ? App.clients[conn.__cid] : null;
    if (!c) return;
    c.lastRecv = Date.now();
    if (msg.t === 'ping') return;

    if (msg.t === 'play' && App.tbl.started && c.seat != null) {
      // A refusal is not worth reporting: re-broadcasting resyncs the sender,
      // which is the only real cause of an out-of-date request.
      G.play(App.tbl.state, c.seat, String(msg.card));
      settle();
      saveSession();
      broadcast();
      return;
    }

    if (msg.t === 'rematch' && App.tbl.started && isOver()) deal();
  }

  function broadcast() {
    var t = App.tbl;
    if (!t) return;

    if (!t.started) {
      var players = seatPreview();
      var names = roster();
      eachClient(function (c, cid) {
        var idx = -1;
        for (var i = 0; i < names.length; i++) if (names[i].clientId === cid) idx = i;
        trySend(c.conn, { t: 'lobby', players: players, you: idx, host: App.myName });
      });
      renderWaitFromTable();
      return;
    }

    var meta = {
      names: t.seats.map(function (s) { return s.name; }),
      kinds: t.seats.map(function (s) { return s.kind; }),
      away: t.seats.map(function (s, i) { return seatAway(i); }),
      score: t.score.slice()
    };

    eachClient(function (c) {
      if (c.seat == null) return;
      trySend(c.conn, {
        t: 'sync', v: G.viewFor(t.state, c.seat),
        names: meta.names, kinds: meta.kinds, away: meta.away, score: meta.score
      });
    });

    applyPayload({
      v: G.viewFor(t.state, 0),
      names: meta.names, kinds: meta.kinds, away: meta.away, score: meta.score
    });
  }

  /* ---- host clock: computer players, stand-ins, liveness ---- */

  function startTick() {
    if (App.tick) return;
    App.tick = setInterval(function () {
      App.ticks++;
      if (App.role === 'host') {
        if (App.ticks % BEAT_EVERY === 0) {
          eachClient(function (c) { trySend(c.conn, { t: 'ping' }); });
          touchAway();
          hostNetState();
        }
        hostTick();
      } else {
        if (App.ticks % BEAT_EVERY === 0 && App.conn && App.conn.open) {
          trySend(App.conn, { t: 'ping' });
        }
        if ((isPlaying() || onWaitScreen()) && App.lastRecv &&
            Date.now() - App.lastRecv > DEAD_MS) {
          if (App.conn) { try { App.conn.close(); } catch (e) {} App.conn = null; }
          onDrop();
        }
      }
    }, TICK_MS);
  }

  function stopTick() {
    if (App.tick) { clearInterval(App.tick); App.tick = null; }
  }

  function hostTick() {
    var t = App.tbl;
    if (!t || !t.started || !t.state) return;
    var st = t.state;
    if (st.winner !== null || st.stuck) return;

    if (t.lastTurn !== st.turn) { t.lastTurn = st.turn; t.turnAt = Date.now(); }
    var seat = t.seats[st.turn];
    if (!seat) return;
    var waited = Date.now() - t.turnAt;

    if (seat.kind === 'bot') {
      if (waited >= BOT_DELAY) autoPlay(st.turn);
    } else if (seat.clientId !== myClientId() && seatAway(st.turn)) {
      // Someone's phone has gone quiet. Give them a decent grace period the
      // first time, but once a seat is known to be away it plays at the same
      // speed as a computer — otherwise one person walking off would cost the
      // whole table twenty seconds on every single one of their turns.
      var grace = App.tbl.standIn[st.turn] ? BOT_DELAY : STANDIN_MS;
      if (waited >= grace) {
        App.tbl.standIn[st.turn] = true;
        autoPlay(st.turn);
      }
    }
  }

  function autoPlay(seat) {
    var st = App.tbl.state;
    var card = G.chooseCard(st, seat);
    if (!card) return;
    G.play(st, seat, card);
    settle();
    saveSession();
    broadcast();
  }

  /* ================= guest ================= */

  function guestReceive(msg) {
    if (msg.t === 'lobby') {
      el('screen-wait').classList.remove('is-host');
      if (!isPlaying()) showScreen('wait');
      hideNetTrouble();
      renderWait(msg.players || [], msg.you, msg.host || 'the host', false);
      return;
    }
    if (msg.t === 'sync' && msg.v) {
      hideNetTrouble();
      applyPayload(msg);
      return;
    }
    if (msg.t === 'denied') {
      notice('lobby-notice', msg.why || 'That table would not take you.', true);
      teardown();
      showScreen('lobby');
    }
  }

  function requestPlay(card) {
    if (App.role === 'host') {
      G.play(App.tbl.state, 0, card);
      settle();
      saveSession();
      broadcast();
    } else {
      trySend(App.conn, { t: 'play', card: card });
    }
  }

  function requestRematch() {
    if (App.role === 'host') { if (isOver()) deal(); }
    else trySend(App.conn, { t: 'rematch' });
  }

  /* ================= rendering: lobby / waiting ================= */

  function renderWaitFromTable() {
    renderWait(seatPreview(), 0, App.myName, true);
  }

  function renderWait(players, youIdx, hostName, isHost) {
    var list = el('seat-list');
    list.innerHTML = '';

    players.forEach(function (p, i) {
      var li = document.createElement('li');
      li.className = 'seat' + (p.kind === 'bot' ? ' is-bot' : '') + (i === youIdx ? ' is-you' : '');

      var nm = document.createElement('span');
      nm.className = 'seat-name';
      nm.textContent = p.name;
      li.appendChild(nm);

      var tag = document.createElement('span');
      tag.className = 'seat-tag';
      tag.textContent = p.kind === 'bot' ? 'computer' : (i === youIdx ? 'you' : 'joined');
      li.appendChild(tag);

      list.appendChild(li);
    });

    var total = players.length;
    el('seat-heading').textContent = 'At the table · ' + total + ' of ' + G.MAX_PLAYERS;

    if (isHost) {
      el('bot-count').textContent = App.tbl.botCount;
      el('bot-minus').disabled = App.tbl.botCount <= 0;
      el('bot-plus').disabled = roster().length + App.tbl.botCount >= G.MAX_PLAYERS;
      el('btn-start').disabled = total < G.MIN_PLAYERS;
      el('wait-hint').textContent = total < G.MIN_PLAYERS
        ? 'Add a computer player, or wait for somebody to join.'
        : 'Start whenever you like — you do not have to wait for a full table.';
    } else {
      el('wait-hint').textContent = 'Waiting for ' + hostName + ' to start the game…';
    }
  }

  /* ================= rendering: the game ================= */

  function buildTable() {
    var area = el('table-area');
    if (area.childElementCount) return;
    var html = '';
    G.SUITS.forEach(function (s) {
      var red = (s === 'h' || s === 'd');
      html += '<div class="suit-row">';
      html += '<div class="suit-mark' + (red ? ' red' : '') + '">' + G.SUIT_GLYPHS[s] + '</div>';
      html += '<div class="strip">';
      for (var r = 1; r <= 13; r++) {
        html += '<div class="cell' + (r === 7 ? ' is-pivot' : '') + (red ? ' red' : '') +
                '" data-cell="' + s + r + '">' + G.RANK_LABELS[r] + '</div>';
      }
      html += '</div></div>';
    });
    area.innerHTML = html;
  }

  function applyPayload(p) {
    App.payload = p;
    buildTable();
    showScreen('game');
    renderPlayers(p);
    renderTable(p.v);
    renderHand(p.v);
    renderStatus(p);
    renderOutcome(p);
  }

  function nameOf(p, seat) {
    return seat === p.v.you ? 'You' : (p.names[seat] || 'Player');
  }

  function renderPlayers(p) {
    var v = p.v;
    var strip = el('players');
    strip.innerHTML = '';

    for (var i = 0; i < v.n; i++) {
      var chip = document.createElement('div');
      var cls = 'chip';
      if (i === v.turn && v.winner === null && !v.stuck) cls += ' is-turn';
      if (i === v.you) cls += ' is-you';
      if (p.kinds[i] === 'bot') cls += ' is-bot';
      if (p.away[i]) cls += ' is-away';
      if (v.counts[i] === 0) cls += ' is-out';
      chip.className = cls;

      var nm = document.createElement('span');
      nm.className = 'chip-name';
      nm.textContent = nameOf(p, i);
      chip.appendChild(nm);

      var ct = document.createElement('span');
      ct.className = 'chip-count';
      ct.textContent = v.counts[i];
      chip.appendChild(ct);

      strip.appendChild(chip);
    }

    // keep whoever is on turn in view when eight chips will not fit at once
    var turnChip = strip.children[v.turn];
    if (turnChip && turnChip.scrollIntoView) {
      try { turnChip.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
    }
  }

  function renderTable(v) {
    var open = {};
    if (v.yourTurn) v.legal.forEach(function (c) { open[c] = true; });

    // Fewer cards down than last time means a fresh deal, so the diff behind the
    // "card landed" flourish has to start over.
    var total = 0;
    G.SUITS.forEach(function (s) {
      if (v.table[s]) total += v.table[s].high - v.table[s].low + 1;
    });
    if (total < App.playedTotal) App.played = {};
    App.playedTotal = total;

    G.SUITS.forEach(function (s) {
      var run = v.table[s];
      var before = App.played[s];
      for (var r = 1; r <= 13; r++) {
        var cell = document.querySelector('[data-cell="' + s + r + '"]');
        if (!cell) continue;
        var played = !!run && r >= run.low && r <= run.high;
        var wasPlayed = !!before && r >= before.low && r <= before.high;

        cell.classList.toggle('is-played', played);
        cell.classList.toggle('is-open', !played && !!open[s + r]);
        if (played && !wasPlayed) {
          cell.classList.remove('just-played');
          void cell.offsetWidth;                       // restart the animation
          cell.classList.add('just-played');
        }
      }
      App.played[s] = run ? { low: run.low, high: run.high } : null;
    });
  }

  function renderHand(v) {
    var legal = {};
    v.legal.forEach(function (c) { legal[c] = true; });

    el('hand').innerHTML = v.hand.map(function (card) {
      var ok = !!legal[card];
      return '<button class="card' + (G.isRed(card) ? ' red' : '') + (ok ? ' is-legal' : ' is-dead') +
             '" data-card="' + card + '"' + (ok && v.yourTurn ? '' : ' disabled') + '>' +
             '<span class="rank">' + G.RANK_LABELS[G.rankOf(card)] + '</span>' +
             '<span class="pip">' + G.SUIT_GLYPHS[G.suitOf(card)] + '</span></button>';
    }).join('');

    el('hand').classList.toggle('is-locked', !v.yourTurn);
    el('hand-label-text').textContent = 'Your Hand · ' + v.hand.length;
  }

  function renderStatus(p) {
    var v = p.v;
    var bar = el('status-bar');
    var text;

    if (v.winner !== null) {
      text = 'The deal is over.';
    } else if (v.stuck) {
      text = 'The table is blocked.';
    } else {
      // Everything after the last card played is a run of forced passes.
      var passed = [];
      for (var i = v.log.length - 1; i >= 0 && v.log[i].type === 'pass'; i--) {
        passed.unshift(nameOf(p, v.log[i].seat));
      }
      var parts = [];
      if (passed.length) parts.push(listOf(passed) + ' had no legal card.');
      parts.push(v.yourTurn ? 'Your play.' : 'Waiting for ' + nameOf(p, v.turn) + '…');
      text = parts.join(' ');
    }

    bar.textContent = text;
    bar.classList.toggle('is-you', v.yourTurn);
  }

  function renderOutcome(p) {
    var v = p.v;
    var overlay = el('overlay');
    if (v.winner === null && !v.stuck) { overlay.classList.remove('is-open'); return; }

    if (v.stuck) {
      el('overlay-kicker').textContent = 'Curious';
      el('overlay-head').textContent = 'Blocked';
      el('overlay-sub').textContent = 'Nobody can move. Deal a fresh hand.';
    } else {
      el('overlay-kicker').textContent = 'Final Edition';
      el('overlay-head').textContent = v.winner === v.you ? 'You Win' : p.names[v.winner] + ' Wins';
      el('overlay-sub').textContent = v.winner === v.you
        ? 'You are out first.'
        : 'You were left holding ' + v.counts[v.you] + (v.counts[v.you] === 1 ? ' card.' : ' cards.');
    }

    var order = [];
    for (var i = 0; i < v.n; i++) order.push(i);
    order.sort(function (a, b) { return v.counts[a] - v.counts[b]; });

    var list = el('standings');
    list.innerHTML = '';
    order.forEach(function (seat) {
      var li = document.createElement('li');
      li.className = 'standing' + (seat === v.you ? ' is-you' : '') + (seat === v.winner ? ' is-winner' : '');

      var nm = document.createElement('span');
      nm.className = 'standing-name';
      nm.textContent = nameOf(p, seat) + (p.kinds[seat] === 'bot' ? ' ◇' : '');
      li.appendChild(nm);

      var left = document.createElement('span');
      left.className = 'standing-left';
      left.textContent = v.counts[seat] === 0 ? 'out' : v.counts[seat] + ' left';
      li.appendChild(left);

      var won = document.createElement('span');
      won.className = 'standing-won';
      won.textContent = (p.score[seat] || 0) + (p.score[seat] === 1 ? ' win' : ' wins');
      li.appendChild(won);

      list.appendChild(li);
    });

    overlay.classList.add('is-open');
  }

  /* ================= events ================= */

  function shareLink() { return location.origin + location.pathname + '?join=' + App.code; }

  function readName() {
    var n = cleanName(el('name-input').value);
    App.myName = n || 'The Host';
    try { localStorage.setItem('sevens-name', n); } catch (e) {}
  }

  el('btn-host').addEventListener('click', function () {
    readName();
    notice('lobby-notice', '');
    App.tbl = newTable();
    startHosting(null);
  });

  el('btn-join').addEventListener('click', function () {
    var code = (el('code-input').value || '').trim().toUpperCase();
    if (code.length !== 4) { notice('lobby-notice', 'A table code is four letters.', true); return; }
    readName();
    notice('lobby-notice', 'Reaching the table…');
    startJoining(code);
  });

  el('code-input').addEventListener('input', function () {
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  el('bot-minus').addEventListener('click', function () { setBots(App.tbl.botCount - 1); });
  el('bot-plus').addEventListener('click', function () { setBots(App.tbl.botCount + 1); });

  el('btn-start').addEventListener('click', function () {
    if (!App.tbl || App.tbl.started) return;
    if (roster().length + App.tbl.botCount < G.MIN_PLAYERS) {
      notice('wait-notice', 'You need at least one other player.', true);
      return;
    }
    startGame();
  });

  el('btn-share').addEventListener('click', function () {
    var url = shareLink();
    var text = 'Sevens — join my table. Code ' + App.code + '.';
    if (navigator.share) navigator.share({ title: 'Sevens', text: text, url: url }).catch(function () {});
    else copy(url);
  });

  el('btn-copy').addEventListener('click', function () { copy(shareLink()); });

  function copy(text) {
    var done = function () { notice('wait-notice', 'Link copied.'); };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(done, function () { prompt('Copy this link:', text); });
    } else {
      prompt('Copy this link:', text);
    }
  }

  el('btn-cancel').addEventListener('click', leaveTable);
  el('btn-quit').addEventListener('click', leaveTable);
  el('btn-net-quit').addEventListener('click', leaveTable);

  function leaveTable() {
    teardown();
    notice('lobby-notice', '');
    showScreen('lobby');
  }

  el('hand').addEventListener('click', function (e) {
    var btn = e.target.closest('.card');
    if (!btn || btn.disabled) return;
    var v = App.payload && App.payload.v;
    if (!v || !v.yourTurn) return;
    var card = btn.getAttribute('data-card');
    if (v.legal.indexOf(card) === -1) return;
    btn.disabled = true;
    requestPlay(card);
  });

  el('btn-rematch').addEventListener('click', function () {
    el('overlay').classList.remove('is-open');
    requestRematch();
  });

  var rulesFrom = 'lobby';
  el('btn-rules-lobby').addEventListener('click', function () { rulesFrom = 'lobby'; showScreen('rules'); });
  el('btn-rules-game').addEventListener('click', function () { rulesFrom = 'game'; showScreen('rules'); });
  el('btn-rules-back').addEventListener('click', function () { showScreen(rulesFrom); });

  // Coming back from a locked screen: iOS tears the data channel down without
  // closing it, so nudge the link the moment the page is visible again.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (!isPlaying() && !onWaitScreen()) return;

    if (App.role === 'guest') {
      if (App.conn && App.conn.open) {
        App.lastRecv = Date.now() - (DEAD_MS - 4000);   // short grace, then the tick decides
        trySend(App.conn, { t: 'ping' });
      } else {
        App.rejoinTries = 0;
        scheduleRejoin();
      }
    } else if (App.tbl) {
      broadcast();
    }
  });

  window.addEventListener('pagehide', saveSession);

  /* ================= boot ================= */

  (function init() {
    myClientId();
    try {
      var saved = localStorage.getItem('sevens-name');
      if (saved) el('name-input').value = saved;
    } catch (e) {}

    var joinCode = (new URLSearchParams(location.search).get('join') || '').toUpperCase();
    var prior = loadSession();

    if (joinCode && /^[A-Z0-9]{4}$/.test(joinCode)) {
      el('code-input').value = joinCode;
      showScreen('lobby');
      notice('lobby-notice', 'Table ' + joinCode + ' is waiting. Put your name in and join.');
      return;
    }

    // Silently retake a table this phone was already at.
    if (prior && prior.code) {
      App.myName = prior.myName || App.myName;

      if (prior.role === 'host' && prior.tbl) {
        App.tbl = newTable();
        App.tbl.started = prior.tbl.started;
        App.tbl.botCount = prior.tbl.botCount || 0;
        App.tbl.seats = prior.tbl.seats || [];
        App.tbl.state = prior.tbl.state || null;
        App.tbl.score = prior.tbl.score || [];
        App.tbl.scored = !!prior.tbl.scored;
        App.tbl.deals = prior.tbl.deals || 0;

        // Rebuild who was sitting here, so their reconnect lands on the same
        // seat instead of being turned away as a stranger.
        (prior.roster || []).forEach(function (r) {
          App.clients[r.clientId] = { conn: null, name: r.name, seat: null, lastRecv: 0 };
          App.order.push(r.clientId);
        });
        App.tbl.seats.forEach(function (s, i) {
          if (s.kind === 'human' && s.clientId && App.clients[s.clientId]) {
            App.clients[s.clientId].seat = i;
          }
        });

        el('screen-wait').classList.add('is-host');
        startHosting(prior.code);
        if (App.tbl.started && App.tbl.state) {
          broadcast();
          showNetTrouble('Reconnecting to the other players…');
        } else {
          showScreen('wait');
          renderWaitFromTable();
        }
        return;
      }

      if (prior.role === 'guest') {
        startJoining(prior.code);
        showScreen('lobby');
        notice('lobby-notice', 'Rejoining table ' + prior.code + '…');
        return;
      }
    }

    showScreen('lobby');
  })();
})();
