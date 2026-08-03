/*
 * Sevens — pure rules engine. No DOM, no network.
 *
 * House rules in force:
 *   - Two to eight players. The deck is dealt out as evenly as it goes, so with
 *     an awkward number some hands carry one extra card. The deal rotates.
 *   - Whoever holds the 7 of spades opens with it.
 *   - Spades set the pace. A spade extends the spade run by one rank in either
 *     direction, as in ordinary Fan Tan. A card of any OTHER suit is only
 *     playable once the spade of the same rank is already on the table — and it
 *     must still extend its own suit's run.
 *   - You must play if you legally can.
 *   - If you cannot, you ask the player who last laid a card for one. They
 *     choose which card to hand over. You take it into your hand and forfeit
 *     your turn; you play again when your turn next comes round.
 *   - The first player to empty their hand wins the deal.
 */
(function (global) {
  'use strict';

  var SUITS = ['s', 'h', 'd', 'c'];
  var SUIT_NAMES = { s: 'Spades', h: 'Hearts', d: 'Diamonds', c: 'Clubs' };
  var SUIT_GLYPHS = { s: '♠', h: '♥', d: '♦', c: '♣' };
  var RANK_LABELS = [null, 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUIT_ORDER = { s: 0, h: 1, d: 2, c: 3 };

  var LEAD_SUIT = 's';
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
   * evenly, and the short hands win markedly more often, so rotating the offset
   * each hand passes that edge around the table instead of parking it on the
   * same seats all evening.
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
      pending: null,        // {requester, giver} while a card is owed
      winner: null,
      stuck: false,
      log: [],
      played: 0
    };
  }

  // Has the spade of this rank been laid? Everything outside spades waits on it.
  function leadReady(state, rank) {
    var run = state.table[LEAD_SUIT];
    return !!run && rank >= run.low && rank <= run.high;
  }

  function isLegal(state, card) {
    if (state.played === 0) return card === OPENING_CARD;   // the deal opens on s7

    var s = suitOf(card), r = rankOf(card);

    // Spades set the pace; every other suit follows a rank only once the
    // matching spade is down.
    if (s !== LEAD_SUIT && !leadReady(state, r)) return false;

    var run = state.table[s];
    if (!run) return r === 7;
    return r === run.low - 1 || r === run.high + 1;
  }

  function legalMoves(state, seat) {
    if (state.winner !== null || state.stuck || state.pending) return [];
    var hand = state.hands[seat] || [];
    var out = [];
    for (var i = 0; i < hand.length; i++) {
      if (isLegal(state, hand[i])) out.push(hand[i]);
    }
    return out;
  }

  // Who a stuck player must ask: the last person to put a card down. If that is
  // somehow themselves — everyone since their own last play has been asking
  // too — they turn to the player immediately before them.
  function giverFor(state, seat) {
    for (var i = state.log.length - 1; i >= 0; i--) {
      var e = state.log[i];
      if (e.type === 'play' && e.seat !== seat) return e.seat;
    }
    return (seat - 1 + state.n) % state.n;
  }

  // Hand the turn on. Whoever receives it either has a play or must ask for a
  // card — there is no silent pass.
  function advance(state) {
    state.turn = (state.turn + 1) % state.n;
    if (legalMoves(state, state.turn).length === 0) {
      state.pending = { requester: state.turn, giver: giverFor(state, state.turn) };
    }
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
    if (state.pending) return 'A card has been asked for first.';
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

  /*
   * Hand a card to the player who asked for it. The asker forfeits their turn:
   * they take the card and play carries on to the next seat.
   *
   * A giver down to their last card empties their hand by giving it away, which
   * wins them the deal — the hand is empty however it emptied.
   */
  function giveCard(state, giver, card) {
    if (state.winner !== null) return 'The deal is already over.';
    if (!state.pending) return 'Nobody has asked for a card.';
    if (state.pending.giver !== giver) return 'You were not the one asked.';

    var idx = state.hands[giver].indexOf(card);
    if (idx === -1) return 'That card is not in your hand.';

    var asker = state.pending.requester;
    state.hands[giver].splice(idx, 1);
    state.hands[asker].push(card);
    state.log.push({ type: 'give', seat: giver, to: asker, card: card });
    state.pending = null;

    if (state.hands[giver].length === 0) {
      state.winner = giver;
      state.log.push({ type: 'win', seat: giver });
      return null;
    }

    state.turn = asker;      // they forfeit it immediately
    advance(state);
    return null;
  }

  /* ---- the computer players -------------------------------------------
   *
   * The only decision when playing is which legal card to let go, so that is
   * where the whole game sits: keep feeding suits you can follow yourself, and
   * shed the cards that are only playable in a narrow window before it closes.
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

    // Spades unlock every other suit, so a spade is worth rather more than the
    // same card elsewhere: it is the only way anybody's hand keeps moving.
    if (s === LEAD_SUIT) score += 2;

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

  // How far a card is from ever being playable — counting the spade that gates
  // it as well as its own suit. Higher means more stranded.
  function giftCost(state, card) {
    var s = suitOf(card), r = rankOf(card);

    var run = state.table[s];
    var d;
    if (!run) d = Math.abs(r - 7) + 1;
    else if (r < run.low) d = run.low - r;
    else if (r > run.high) d = r - run.high;
    else d = 0;

    if (s !== LEAD_SUIT) {
      var lead = state.table[LEAD_SUIT];
      var ld;
      if (!lead) ld = Math.abs(r - 7) + 1;
      else if (r < lead.low) ld = lead.low - r;
      else if (r > lead.high) ld = r - lead.high;
      else ld = 0;
      d = Math.max(d, ld);
    }
    return d;
  }

  // Give away the card you are least likely ever to play. It is the cheapest
  // for you to lose and, being the furthest from legal, the least use to them.
  function chooseGift(state, giver) {
    var hand = state.hands[giver] || [];
    if (!hand.length) return null;

    var best = hand[0], bestCost = -Infinity;
    for (var i = 0; i < hand.length; i++) {
      var cost = giftCost(state, hand[i]) + Math.random() * 0.4;
      if (cost > bestCost) { bestCost = cost; best = hand[i]; }
    }
    return best;
  }

  /* ---- per-seat view --------------------------------------------------- */

  // Everything one player may see and nothing more: their own hand in full,
  // everyone else's as a count. A gifted card is shown only to the two people
  // involved, exactly as passing a card across a table would be.
  function viewFor(state, seat) {
    var pending = state.pending;

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
      yourTurn: state.turn === seat && state.winner === null && !state.stuck && !pending,
      pending: pending ? { requester: pending.requester, giver: pending.giver } : null,
      youGive: !!pending && pending.giver === seat,
      youAsk: !!pending && pending.requester === seat,
      winner: state.winner,
      stuck: state.stuck,
      log: state.log.slice(-10).map(function (e) {
        var out = { type: e.type, seat: e.seat };
        if (e.to != null) out.to = e.to;
        if (e.card) {
          // a gift is private to giver and receiver
          if (e.type !== 'give' || e.seat === seat || e.to === seat) out.card = e.card;
        }
        return out;
      })
    };
  }

  global.SevensGame = {
    SUITS: SUITS,
    SUIT_NAMES: SUIT_NAMES,
    SUIT_GLYPHS: SUIT_GLYPHS,
    RANK_LABELS: RANK_LABELS,
    LEAD_SUIT: LEAD_SUIT,
    OPENING_CARD: OPENING_CARD,
    MIN_PLAYERS: MIN_PLAYERS,
    MAX_PLAYERS: MAX_PLAYERS,
    suitOf: suitOf,
    rankOf: rankOf,
    label: label,
    isRed: isRed,
    sortHand: sortHand,
    newGame: newGame,
    leadReady: leadReady,
    isLegal: isLegal,
    legalMoves: legalMoves,
    play: play,
    giveCard: giveCard,
    chooseCard: chooseCard,
    chooseGift: chooseGift,
    viewFor: viewFor
  };
})(typeof window !== 'undefined' ? window : this);
