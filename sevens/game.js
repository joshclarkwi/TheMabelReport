/*
 * Sevens (Fan Tan) — pure rules engine. No DOM, no network.
 *
 * House rules in force:
 *   - Two players, 26 cards each.
 *   - Whoever holds the 7 of diamonds opens with it.
 *   - A card is legal if it is a seven of an unstarted suit, or if it extends
 *     an existing suit run by one rank in either direction.
 *   - Strict passing: you must play whenever you legally can, so a pass is
 *     never a choice. The engine passes for you automatically.
 *   - First player to empty their hand wins; the loser's remaining cards are
 *     the margin of defeat.
 */
(function (global) {
  'use strict';

  var SUITS = ['s', 'h', 'd', 'c'];
  var SUIT_NAMES = { s: 'Spades', h: 'Hearts', d: 'Diamonds', c: 'Clubs' };
  var SUIT_GLYPHS = { s: '♠', h: '♥', d: '♦', c: '♣' };
  var RANK_LABELS = [null, 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUIT_ORDER = { s: 0, h: 1, d: 2, c: 3 };

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

  // Fisher-Yates, seeded from crypto where available so deals are properly random.
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
        // Rejection sampling keeps the distribution flat.
        var limit = Math.floor(0x100000000 / bound) * bound;
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

  function newGame() {
    var deck = shuffle(newDeck());
    var hands = [[], []];
    for (var i = 0; i < deck.length; i++) hands[i % 2].push(deck[i]);

    var opener = hands[0].indexOf('d7') !== -1 ? 0 : 1;

    return {
      table: { s: null, h: null, d: null, c: null },  // null, or {low, high}
      hands: hands,
      turn: opener,
      opener: opener,
      winner: null,
      stuck: false,
      log: [],
      played: 0
    };
  }

  function isLegal(state, card) {
    // The hand opens with the seven of diamonds and nothing else.
    if (state.played === 0) return card === 'd7';
    var run = state.table[suitOf(card)];
    var r = rankOf(card);
    if (!run) return r === 7;
    return r === run.low - 1 || r === run.high + 1;
  }

  function legalMoves(state, seat) {
    if (state.winner !== null || state.stuck) return [];
    var hand = state.hands[seat];
    var out = [];
    for (var i = 0; i < hand.length; i++) {
      if (isLegal(state, hand[i])) out.push(hand[i]);
    }
    return out;
  }

  // Hand the turn over, auto-passing anyone with nothing legal to play.
  function advance(state) {
    state.turn = 1 - state.turn;
    var guard = 0;
    while (state.winner === null && legalMoves(state, state.turn).length === 0) {
      if (guard >= 2) { state.stuck = true; break; }   // unreachable in Fan Tan, but never hang
      state.log.push({ type: 'pass', seat: state.turn });
      state.turn = 1 - state.turn;
      guard++;
    }
  }

  /*
   * Apply a play. Returns null on success, or a string explaining the refusal.
   * Every rejection path matters: the host runs this on the guest's requests,
   * so it is the only thing standing between a bad message and a corrupt game.
   */
  function play(state, seat, card) {
    if (state.winner !== null) return 'The hand is already over.';
    if (state.stuck) return 'The hand is stuck.';
    if (seat !== 0 && seat !== 1) return 'Unknown player.';
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
      state.log.push({ type: 'win', seat: seat, margin: state.hands[1 - seat].length });
      return null;
    }

    advance(state);
    return null;
  }

  /* ---- per-seat view --------------------------------------------------- */

  // Everything one player is allowed to see, and nothing more. The opponent's
  // hand never leaves the host except as a count.
  function viewFor(state, seat) {
    var mine = sortHand(state.hands[seat]);
    var legal = legalMoves(state, seat);

    return {
      table: {
        s: state.table.s && { low: state.table.s.low, high: state.table.s.high },
        h: state.table.h && { low: state.table.h.low, high: state.table.h.high },
        d: state.table.d && { low: state.table.d.low, high: state.table.d.high },
        c: state.table.c && { low: state.table.c.low, high: state.table.c.high }
      },
      hand: mine,
      legal: legal,
      oppCount: state.hands[1 - seat].length,
      yourTurn: state.turn === seat && state.winner === null && !state.stuck,
      winner: state.winner === null ? null : (state.winner === seat ? 'you' : 'them'),
      margin: state.winner === null ? 0 : state.hands[1 - state.winner].length,
      stuck: state.stuck,
      log: state.log.slice(-6).map(function (e) {
        return {
          type: e.type,
          who: e.seat === seat ? 'you' : 'them',
          card: e.card || null,
          margin: e.margin || 0
        };
      })
    };
  }

  global.SevensGame = {
    SUITS: SUITS,
    SUIT_NAMES: SUIT_NAMES,
    SUIT_GLYPHS: SUIT_GLYPHS,
    RANK_LABELS: RANK_LABELS,
    suitOf: suitOf,
    rankOf: rankOf,
    label: label,
    isRed: isRed,
    sortHand: sortHand,
    newGame: newGame,
    isLegal: isLegal,
    legalMoves: legalMoves,
    play: play,
    viewFor: viewFor
  };
})(typeof window !== 'undefined' ? window : this);
