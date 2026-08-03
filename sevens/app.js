/*
 * Sevens — table wiring: screens, rendering, and the link between two phones.
 *
 * Networking is peer-to-peer over WebRTC (PeerJS). One phone hosts and is the
 * sole authority on game state; the other sends requests and renders whatever
 * the host sends back. That keeps the rules honest even though both ends run
 * the same code, and it means a dropped connection loses nothing — the guest
 * reconnects and the host re-sends the table.
 */
(function () {
  'use strict';

  var G = window.SevensGame;
  var PREFIX = 'mabelsevens-';
  var ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';  // no look-alikes to mistype
  var ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  };

  function el(id) { return document.getElementById(id); }

  var App = {
    role: null,          // 'host' | 'guest'
    seat: 0,
    code: null,
    myName: 'You',
    theirName: 'Opponent',
    peer: null,
    conn: null,
    match: null,         // host only: { score:[host,guest], state, scored }
    view: null,
    played: {},          // suit -> {low, high} as last rendered, for the land animation
    playedTotal: 0,
    rejoinTimer: null,
    rejoinTries: 0,
    idTries: 0,
    beat: null,
    lastRecv: 0
  };

  // iOS does not always close a data channel politely — it just stops carrying
  // traffic. Without this, a phone can sit happily "connected" to nothing while
  // the other player's moves go nowhere.
  var BEAT_MS = 3000;
  var DEAD_MS = 11000;

  /* ================= screens ================= */

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

  function makeCode() {
    var out = '';
    for (var i = 0; i < 4; i++) {
      out += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
    }
    return out;
  }

  /* ================= persistence =================
   * iOS is quick to evict a backgrounded tab. Stashing the table means a
   * reload silently picks the game back up instead of ending the evening. */

  function saveSession() {
    try {
      var blob = { role: App.role, code: App.code, myName: App.myName, theirName: App.theirName };
      if (App.role === 'host' && App.match) {
        blob.score = App.match.score;
        blob.state = App.match.state;
        blob.scored = App.match.scored;
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
      // Signalling dropped but the peer object is still usable — get it back.
      if (!peer.destroyed) { try { peer.reconnect(); } catch (e) {} }
    });

    return peer;
  }

  function startHosting(resumeCode) {
    App.role = 'host';
    App.seat = 0;
    App.code = resumeCode || makeCode();

    el('code-display').textContent = App.code;
    if (!resumeCode) { showScreen('wait'); notice('wait-notice', 'Waiting for the second player…'); }

    App.peer = makePeer(PREFIX + App.code);
    if (!App.peer) {
      notice('wait-notice', 'The connection library did not load. Reload the page.', true);
      return;
    }

    App.peer.on('open', function () {
      App.idTries = 0;
      saveSession();
    });

    App.peer.on('connection', function (conn) {
      attachConn(conn);
    });

    App.peer.on('error', function (err) {
      if (err.type === 'unavailable-id' && App.idTries < 4) {
        App.idTries++;
        try { App.peer.destroy(); } catch (e) {}
        if (resumeCode) {
          // This is our own stale registration from before the reload. Wait for
          // it to clear rather than moving to a code she knows nothing about.
          setTimeout(function () { startHosting(resumeCode); }, 1500);
        } else {
          startHosting(null);   // genuine clash on a fresh table — take another
        }
        return;
      }
      if (err.type === 'network' || err.type === 'server-error') return;  // reconnect handles it
      notice('wait-notice', 'Could not open a table. Check the signal and try again.', true);
    });
  }

  function startJoining(code) {
    App.role = 'guest';
    App.seat = 1;
    App.code = code;
    App.peer = makePeer(null);
    if (!App.peer) {
      notice('lobby-notice', 'The connection library did not load. Reload the page.', true);
      showScreen('lobby');
      return;
    }

    App.peer.on('open', function () { dial(); });

    App.peer.on('error', function (err) {
      if (err.type === 'peer-unavailable') {
        if (isPlaying()) { scheduleRejoin(); return; }   // host briefly away
        notice('lobby-notice', 'No table found under that code.', true);
        teardown();
        showScreen('lobby');
        return;
      }
      if (err.type === 'network' || err.type === 'server-error') return;
      if (!isPlaying()) {
        notice('lobby-notice', 'Could not reach the table. Try again in a moment.', true);
        teardown();
        showScreen('lobby');
      }
    });
  }

  function dial() {
    if (!App.peer || App.peer.destroyed) return;
    var conn = App.peer.connect(PREFIX + App.code, { reliable: true });
    attachConn(conn);
  }

  function attachConn(conn) {
    // A fresh connection always wins — this is how a reconnect takes over.
    if (App.conn && App.conn !== conn) { try { App.conn.close(); } catch (e) {} }
    App.conn = conn;

    conn.on('open', function () {
      App.rejoinTries = 0;
      App.lastRecv = Date.now();
      hideNetTrouble();
      startBeat();
      if (App.role === 'guest') {
        send({ t: 'hello', name: App.myName });
        saveSession();
      } else {
        notice('wait-notice', 'Connected. Dealing…');
        if (!App.match) newMatch();
        broadcast();
      }
    });

    conn.on('data', function (msg) {
      if (!msg || typeof msg !== 'object') return;
      App.lastRecv = Date.now();
      if (msg.t === 'ping') return;
      if (App.role === 'host') hostReceive(msg);
      else guestReceive(msg);
    });

    conn.on('close', function () {
      if (App.conn === conn) App.conn = null;
      onDrop();
    });

    conn.on('error', function () { onDrop(); });
  }

  function send(msg) {
    if (App.conn && App.conn.open) {
      try { App.conn.send(msg); } catch (e) {}
    }
  }

  function isPlaying() {
    return el('screen-game').classList.contains('is-active');
  }

  function startBeat() {
    if (App.beat) return;
    App.beat = setInterval(function () {
      if (!isPlaying()) return;
      if (App.conn && App.conn.open) {
        try { App.conn.send({ t: 'ping' }); } catch (e) {}
      }
      if (Date.now() - App.lastRecv > DEAD_MS) {
        if (App.conn) { try { App.conn.close(); } catch (e) {} App.conn = null; }
        onDrop();
      }
    }, BEAT_MS);
  }

  function stopBeat() {
    if (App.beat) { clearInterval(App.beat); App.beat = null; }
  }

  function onDrop() {
    if (!isPlaying()) return;
    showNetTrouble(App.role === 'host'
      ? App.theirName + ' dropped off. Holding the table…'
      : 'Trying to reach the other telephone…');
    if (App.role === 'guest') scheduleRejoin();
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
    stopBeat();
    if (App.rejoinTimer) { clearTimeout(App.rejoinTimer); App.rejoinTimer = null; }
    if (App.conn) { try { App.conn.close(); } catch (e) {} App.conn = null; }
    if (App.peer) { try { App.peer.destroy(); } catch (e) {} App.peer = null; }
    App.match = null;
    App.view = null;
    App.role = null;
    App.rejoinTries = 0;
    hideNetTrouble();
    el('overlay').classList.remove('is-open');
    clearSession();
  }

  /* ================= host: the authority ================= */

  function newMatch() {
    App.match = { score: [0, 0], state: G.newGame(), scored: false };
    saveSession();
  }

  function newHand() {
    App.match.state = G.newGame();
    App.match.scored = false;
    App.played = {};
    saveSession();
  }

  function settle() {
    var m = App.match;
    if (m.state.winner !== null && !m.scored) {
      m.score[m.state.winner]++;
      m.scored = true;
    }
  }

  function hostReceive(msg) {
    var m = App.match;
    if (msg.t === 'hello') {
      if (typeof msg.name === 'string' && msg.name.trim()) {
        App.theirName = msg.name.trim().slice(0, 14);
      }
      if (!m) newMatch();
      broadcast();
      return;
    }
    if (!m) return;

    if (msg.t === 'play' && typeof msg.card === 'string') {
      // A refusal is not worth reporting: re-broadcasting resyncs the guest,
      // which is the only real cause of an illegal request.
      G.play(m.state, 1, msg.card);
      settle();
      saveSession();
      broadcast();
      return;
    }
    if (msg.t === 'rematch') {
      if (m.state.winner !== null || m.state.stuck) { newHand(); broadcast(); }
    }
  }

  function broadcast() {
    var m = App.match;
    if (!m) return;
    send({
      t: 'sync',
      v: G.viewFor(m.state, 1),
      them: App.myName,
      score: [m.score[1], m.score[0]]
    });
    render(G.viewFor(m.state, 0), App.theirName, [m.score[0], m.score[1]]);
  }

  /* ================= guest ================= */

  function guestReceive(msg) {
    if (msg.t !== 'sync' || !msg.v) return;
    if (typeof msg.them === 'string' && msg.them.trim()) App.theirName = msg.them.trim().slice(0, 14);
    render(msg.v, App.theirName, msg.score || [0, 0]);
  }

  function requestPlay(card) {
    if (App.role === 'host') {
      G.play(App.match.state, 0, card);
      settle();
      saveSession();
      broadcast();
    } else {
      send({ t: 'play', card: card });
    }
  }

  function requestRematch() {
    if (App.role === 'host') {
      if (App.match.state.winner !== null || App.match.state.stuck) { newHand(); broadcast(); }
    } else {
      send({ t: 'rematch' });
    }
  }

  /* ================= rendering ================= */

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

  function render(v, oppName, score) {
    App.view = v;
    buildTable();
    showScreen('game');

    el('opp-name').textContent = oppName;
    el('opp-count').textContent = v.oppCount;
    var tally = 'You ' + score[0] + ' – ' + score[1] + ' ' + oppName;
    el('tally').textContent = tally;
    el('tally').title = tally;
    el('hand-label-text').textContent = 'Your Hand · ' + v.hand.length;

    renderTable(v);
    renderHand(v);
    renderStatus(v, oppName);
    renderOutcome(v, oppName, score);
  }

  function renderTable(v) {
    var open = {};
    if (v.yourTurn) v.legal.forEach(function (c) { open[c] = true; });

    // Fewer cards down than last time means a fresh deal, so the diff used for
    // the "card landed" flourish has to start over.
    var total = 0;
    G.SUITS.forEach(function (s) {
      if (v.table[s]) total += v.table[s].high - v.table[s].low + 1;
    });
    if (total < (App.playedTotal || 0)) App.played = {};
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
          void cell.offsetWidth;              // restart the animation
          cell.classList.add('just-played');
        }
      }
      App.played[s] = run ? { low: run.low, high: run.high } : null;
    });
  }

  function renderHand(v) {
    var legal = {};
    v.legal.forEach(function (c) { legal[c] = true; });

    var html = v.hand.map(function (card) {
      var red = G.isRed(card);
      var ok = !!legal[card];
      return '<button class="card' + (red ? ' red' : '') + (ok ? ' is-legal' : ' is-dead') +
             '" data-card="' + card + '"' + (ok && v.yourTurn ? '' : ' disabled') + '>' +
             '<span class="rank">' + G.RANK_LABELS[G.rankOf(card)] + '</span>' +
             '<span class="pip">' + G.SUIT_GLYPHS[G.suitOf(card)] + '</span></button>';
    }).join('');

    el('hand').innerHTML = html;
    el('hand').classList.toggle('is-locked', !v.yourTurn);
  }

  function renderStatus(v, oppName) {
    var bar = el('status-bar');
    var tail = v.log.length ? v.log[v.log.length - 1] : null;
    var text;

    if (v.winner !== null) {
      text = 'The hand is over.';
    } else if (v.stuck) {
      text = 'The table is blocked.';
    } else if (tail && tail.type === 'pass' && tail.who === 'you') {
      text = 'No legal card — you passed. ' + oppName + ' plays again.';
    } else if (tail && tail.type === 'pass' && tail.who === 'them') {
      text = oppName + ' had no legal card. Your turn again.';
    } else if (v.yourTurn) {
      text = tail && tail.type === 'play'
        ? oppName + ' laid the ' + G.label(tail.card) + '. Your play.'
        : 'Your play.';
    } else {
      text = 'Waiting for ' + oppName + '…';
    }

    bar.textContent = text;
    bar.classList.toggle('is-you', v.yourTurn);
  }

  function renderOutcome(v, oppName, score) {
    var overlay = el('overlay');
    if (v.winner === null && !v.stuck) { overlay.classList.remove('is-open'); return; }

    if (v.stuck) {
      el('overlay-kicker').textContent = 'Curious';
      el('overlay-head').textContent = 'Blocked';
      el('overlay-sub').textContent = 'Neither of you can move. Deal a fresh hand.';
    } else if (v.winner === 'you') {
      el('overlay-kicker').textContent = 'Final Edition';
      el('overlay-head').textContent = 'You Win';
      el('overlay-sub').textContent = 'By ' + v.margin + (v.margin === 1 ? ' card' : ' cards') +
        '. Games ' + score[0] + '–' + score[1] + '.';
    } else {
      el('overlay-kicker').textContent = 'Final Edition';
      el('overlay-head').textContent = oppName + ' Wins';
      el('overlay-sub').textContent = 'You were left holding ' + v.margin +
        (v.margin === 1 ? ' card' : ' cards') + '. Games ' + score[0] + '–' + score[1] + '.';
    }
    overlay.classList.add('is-open');
  }

  /* ================= events ================= */

  function shareLink() {
    return location.origin + location.pathname + '?join=' + App.code;
  }

  function readName() {
    var n = (el('name-input').value || '').trim().slice(0, 14);
    App.myName = n || 'Your Opponent';
    try { localStorage.setItem('sevens-name', n); } catch (e) {}
  }

  el('btn-host').addEventListener('click', function () {
    readName();
    notice('lobby-notice', '');
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

  el('btn-share').addEventListener('click', function () {
    var url = shareLink();
    var text = 'Sevens — join my table. Code ' + App.code + '.';
    if (navigator.share) {
      navigator.share({ title: 'Sevens', text: text, url: url }).catch(function () {});
    } else {
      copy(url);
    }
  });

  el('btn-copy').addEventListener('click', function () { copy(shareLink()); });

  function copy(text) {
    var done = function () { notice('wait-notice', 'Link copied. Waiting for her…'); };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(done, function () { prompt('Copy this link:', text); });
    } else {
      prompt('Copy this link:', text);
    }
  }

  el('btn-cancel').addEventListener('click', function () {
    teardown();
    notice('lobby-notice', '');
    showScreen('lobby');
  });

  el('hand').addEventListener('click', function (e) {
    var btn = e.target.closest('.card');
    if (!btn || btn.disabled || !App.view || !App.view.yourTurn) return;
    var card = btn.getAttribute('data-card');
    if (App.view.legal.indexOf(card) === -1) return;
    btn.disabled = true;
    requestPlay(card);
  });

  el('btn-rematch').addEventListener('click', function () {
    el('overlay').classList.remove('is-open');
    requestRematch();
  });

  el('btn-quit').addEventListener('click', leaveTable);
  el('btn-net-quit').addEventListener('click', leaveTable);

  function leaveTable() {
    teardown();
    notice('lobby-notice', '');
    showScreen('lobby');
  }

  var rulesFrom = 'lobby';
  el('btn-rules-lobby').addEventListener('click', function () { rulesFrom = 'lobby'; showScreen('rules'); });
  el('btn-rules-game').addEventListener('click', function () { rulesFrom = 'game'; showScreen('rules'); });
  el('btn-rules-back').addEventListener('click', function () { showScreen(rulesFrom); });

  // Coming back from a locked screen: iOS tears the data channel down, so nudge
  // the connection the moment the page is visible again.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !isPlaying()) return;

    if (App.conn && App.conn.open) {
      // The link may or may not have survived. Ping it and allow a short grace
      // period before the heartbeat calls it dead.
      App.lastRecv = Date.now() - (DEAD_MS - 4000);
      try { App.conn.send({ t: 'ping' }); } catch (e) {}
      if (App.role === 'host') broadcast();
      return;
    }
    if (App.role === 'guest') {
      App.rejoinTries = 0;
      scheduleRejoin();
    }
  });

  window.addEventListener('pagehide', saveSession);

  /* ================= boot ================= */

  (function init() {
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

    // Silently retake a table this phone was already hosting or joined.
    if (prior && prior.code) {
      App.myName = prior.myName || App.myName;
      App.theirName = prior.theirName || App.theirName;
      if (prior.role === 'host' && prior.state) {
        App.match = { score: prior.score || [0, 0], state: prior.state, scored: !!prior.scored };
        startHosting(prior.code);
        render(G.viewFor(App.match.state, 0), App.theirName, [App.match.score[0], App.match.score[1]]);
        showNetTrouble('Reconnecting to ' + App.theirName + '…');
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
