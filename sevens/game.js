/*
 * Sevens (Fan Tan) — pure rules engine. No DOM, no network.
 *
 * House rules in force:
 *   - Two to eight players. The deck is dealt out as evenly as it goes, so with
 *     an awkward number some hands carry one extra card.
 *   - Whoever holds the 7 of spades opens with it.
 *   - Thereafter a card is legal if it is a seven of an unstarted suit, or if it
 *     extends an existing suit run by one rank in either direction.
 *   - Strict passing: you must play whenever you legally can, so a pass is never
 *     a choice. The engine passes for you automatically.
 *   - The first player to empty their hand wins the deal.
 */
(function (global) {
  'use strict';

  var SUITS = ['s', 'h', 'd', 'c'];
  var SUIT_NAMES = { s: 'Spades', h: 'Hearts', d: 'Diamonds', c: 'Clubs' };
  var SUIT_GLYPHS = { s: '♠', h: '♥', d: '♦', c: '♣' };
  var RANK_LABELS = [null, 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUIT_ORDER = { s: 0, h: 1, d: 2, c: 3 };

  var OPENING_CARD = 's7';
  var MIN_PLAYERS = 2;
  var MAX_PLAYERS = 8;

  function suitOf(card) { return card.charAt(0); }
  function rankOf(card) { return parseInt(card.slice(1), 10); }
  function label(card) { return RANK_LABELS[rankOf(card)] + SUIT_GLYPHS[suitOf(card)]; }
  function isRed(card) { return card.charAt(0) === 'h' || card.charAt(0) === 'd'; }

  function newDeck() {
    var deck = [];
    for (var i = 0; i < SUITS.length; i++) {
      for (var r = 1; r <= 13; r++) deck.push(SUITS[i] + r);
    }
    return deck;
  }

  function shuffle(deck) {
    var out = deck.slice();
    var rand = randomInt();
    for (var i = out.length - 1; i > 0; i--) {
      var j = rand(i + 1);
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  function randomInt() {
    var crypto = global.crypto || global.msCrypto;
    if (crypto && crypto.getRandomValues) {
      return function (bound) {
        var buf = new Uint32Array(1);
        var limit = Math.floor(0x100000000 / bound) * bound;   // reject the tail so the draw stays flat
        var v;
        do { crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
        return v % bound;
      };
    }
    return function (bound) { return Math.floor(Math.random() * bound); };
  }

  function sortHand(hand) {
    return hand.slice().sort(function (a, b) {
      if (SUIT_ORDER[suitOf(a)] !== SUIT_ORDER[suitOf(b)]) {
        return SUIT_ORDER[suitOf(a)] - SUIT_ORDER[suitOf(b)];
      }
      return rankOf(a) - rankOf(b);
    });
  }

  /* ---- state ---------------------------------------------------------- */

  /*
   * dealOffset names the seat the deal starts on. Fifty-two cards rarely split
   * evenly, and the short hands win markedly more often, so whoever deals first
   * matters. Rotating the offset each hand passes that edge around the table
   * instead of parking it on the same seats all evening.
   */
  function newGame(playerCount, dealOffset) {
    var n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, playerCount | 0));
    var off = ((dealOffset | 0) % n + n) % n;
    var deck = shuffle(newDeck());
    var hands = [];
    for (var i = 0; i < n; i++) hands.push([]);
    for (var c = 0; c < deck.length; c++) hands[(c + off) % n].push(deck[c]);

    var opener = 0;
    for (var s = 0; s < n; s++) {
      if (hands[s].indexOf(OPENING_CARD) !== -1) { opener = s; break; }
    }

    return {
      n: n,
      table: { s: null, h: null, d: null, c: null },   // null, or {low, high}
      hands: hands,
      turn: opener,
      opener: opener,
      dealOffset: off,
      winner: null,
      stuck: false,
      log: [],
      played: 0
    };
  }

  function isLegal(state, card) {
    // The deal opens with the seven of spades and nothing else.
    if (state.played === 0) return card === OPENING_CARD;
    var run = state.table[suitOf(card)];
    var r = rankOf(card);
    if (!run) return r === 7;
    return r === run.low - 1 || r === run.high + 1;
  }

  function legalMoves(state, seat) {
    if (state.winner !== null || state.stuck) return [];
    var hand = state.hands[seat] || [];
    var out = [];
    for (var i = 0; i < hand.length; i++) {
      if (isLegal(state, hand[i])) out.push(hand[i]);
    }
    return out;
  }

  // Hand the turn on, passing anyone with nothing legal. A full circuit of
  // passes cannot happen while cards remain, but the loop is bounded anyway.
  function advance(state) {
    for (var steps = 0; steps < state.n; steps++) {
      state.turn = (state.turn + 1) % state.n;
      if (legalMoves(state, state.turn).length > 0) return;
      state.log.push({ type: 'pass', seat: state.turn });
    }
    state.stuck = true;
  }

  /*
   * Apply a play. Returns null on success, or a string explaining the refusal.
   * Every rejection path matters: the host runs this on messages arriving from
   * other phones, so it is all that stands between a bad message and a corrupt
   * game.
   */
  function play(state, seat, card) {
    if (state.winner !== null) return 'The deal is already over.';
    if (state.stuck) return 'The deal is stuck.';
    if (!(seat >= 0 && seat < state.n)) return 'Unknown player.';
    if (state.turn !== seat) return 'Not your turn.';

    var idx = state.hands[seat].indexOf(card);
    if (idx === -1) return 'That card is not in your hand.';
    if (!isLegal(state, card)) return 'That card cannot be played yet.';

    state.hands[seat].splice(idx, 1);
    var s = suitOf(card), r = rankOf(card);
    if (!state.table[s]) state.table[s] = { low: r, high: r };
    else if (r < state.table[s].low) state.table[s].low = r;
    else state.table[s].high = r;

    state.played++;
    state.log.push({ type: 'play', seat: seat, card: card });

    if (state.hands[seat].length === 0) {
      state.winner = seat;
      state.log.push({ type: 'win', seat: seat });
      return null;
    }

    advance(state);
    return null;
  }

  /* ---- the computer players -------------------------------------------
   *
   * Strict passing means the only decision is which of the legal cards to let
   * go, so the whole game is in that choice. Two things drive it: keep feeding
   * suits you can follow yourself, and shed the cards that are only playable in
   * a narrow window before that window closes.
   */

  function runLength(have, suit, from, dir) {
    var n = 0, r = from + dir;
    while (r >= 1 && r <= 13 && have[suit + r]) { n++; r += dir; }
    return n;
  }

  function scoreMove(hand, card) {
    var have = {};
    for (var i = 0; i < hand.length; i++) have[hand[i]] = true;

    var s = suitOf(card), r = rankOf(card);
    var score;

    if (r === 7) {
      // Opening a suit hands every other player a fresh avenue, so it is only
      // worth doing when you are long enough in that suit to use it yourself.
      score = (runLength(have, s, 7, -1) + runLength(have, s, 7, 1)) * 3 - 5;
    } else {
      var dir = r < 7 ? -1 : 1;
      score = runLength(have, s, r, dir) * 3;
      // Aces and kings only ever become playable at the very end of a run —
      // take the chance to be rid of them while it exists.
      score += Math.abs(r - 7) * 0.8;
    }
    return score;
  }

  function chooseCard(state, seat) {
    var moves = legalMoves(state, seat);
    if (moves.length === 0) return null;

    var hand = state.hands[seat];
    var best = moves[0], bestScore = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      // A little noise so two computers in the same spot do not play in lockstep.
      var score = scoreMove(hand, moves[i]) + Math.random() * 0.6;
      if (score > bestScore) { bestScore = score; best = moves[i]; }
    }
    return best;
  }

  /* ---- per-seat view --------------------------------------------------- */

  // Everything one player may see and nothing more: their own hand in full,
  // everyone else's as a count. Names are the caller's business.
  function viewFor(state, seat) {
    return {
      n: state.n,
      you: seat,
      table: {
        s: state.table.s && { low: state.table.s.low, high: state.table.s.high },
        h: state.table.h && { low: state.table.h.low, high: state.table.h.high },
        d: state.table.d && { low: state.table.d.low, high: state.table.d.high },
        c: state.table.c && { low: state.table.c.low, high: state.table.c.high }
      },
      hand: sortHand(state.hands[seat] || []),
      legal: legalMoves(state, seat),
      counts: state.hands.map(function (h) { return h.length; }),
      turn: state.turn,
      yourTurn: state.turn === seat && state.winner === null && !state.stuck,
      winner: state.winner,
      stuck: state.stuck,
      log: state.log.slice(-10)
    };
  }

  global.SevensGame = {
    SUITS: SUITS,
    SUIT_NAMES: SUIT_NAMES,
    SUIT_GLYPHS: SUIT_GLYPHS,
    RANK_LABELS: RANK_LABELS,
    OPENING_CARD: OPENING_CARD,
    MIN_PLAYERS: MIN_PLAYERS,
    MAX_PLAYERS: MAX_PLAYERS,
    suitOf: suitOf,
    rankOf: rankOf,
    label: label,
    isRed: isRed,
    sortHand: sortHand,
    newGame: newGame,
    isLegal: isLegal,
    legalMoves: legalMoves,
    play: play,
    chooseCard: chooseCard,
    viewFor: viewFor
  };
})(typeof window !== 'undefined' ? window : this);
