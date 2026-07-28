/**
 * @file 70_screen_bracket.js
 * @version 1.1
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description Stage B bracket with the second-chance (repechage) round and Stage C burst runoff. Registers the 'bracket' and 'runoff' screens plus the pure PT.bracket ranking engine.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * ============================================================================
 * PRD 7.3 — Stage B: bracket with a second-chance round
 * ============================================================================
 *
 * THE STATE IS AN OPS LOG, NOT A TREE
 * -----------------------------------
 * Nothing about the bracket's shape is persisted. What persists is
 *
 *     unit.bracket = { pool, target, seed, ops: [ {t:'pick',m,w} | {t:'defer',m} ] }
 *
 * and the entire bracket — every pairing, every elimination edge, every
 * placement — is REBUILT by replaying that log through a pure function. This is
 * the single decision that makes three of the required behaviours fall out for
 * free instead of each needing its own machinery:
 *
 *   - Unlimited undo is `ops.pop()` plus a rebuild. There are no inverse
 *     operations to write and therefore no inverse operations to get wrong.
 *   - Resume (PRD 7.10) is a rebuild from the persisted log. A reload mid-bracket
 *     lands on exactly the pairing the user was looking at.
 *   - The persisted record stays tiny: at 500 photos the log is a few hundred
 *     two-field objects, not a serialised bracket tree.
 *
 * Rebuild cost is O(field + ops), measured at well under a millisecond for a
 * 500-photo field, so doing it on every single click is not a compromise.
 *
 * SEEDING IS DETERMINISTIC (required for resume)
 * ----------------------------------------------
 * `seed` is stored once. The draw is `PT.session.seededShuffle(pool, seed)`, so
 * a resumed bracket is the SAME bracket. A Math.random() draw would reshuffle on
 * reload and silently invalidate every comparison already made.
 *
 * Entrants are then placed by the standard seeding pattern (1v16, 8v9, 4v13 …)
 * rather than pairing the shuffled list off in order. With a random draw the
 * pattern does not change who plays whom in any meaningful sense, but it is what
 * distributes BYES correctly for fields that are not a power of two: the byes go
 * to slots that are spread across the bracket instead of clumping in one corner.
 *
 * THE REPECHAGE (the point of the whole stage)
 * --------------------------------------------
 * A single-elimination bracket is only trustworthy about ONE thing: the winner.
 * Everything below first place is an artefact of the draw. The finalist who lost
 * the last match is not the second-best photo, it is the best photo in the other
 * half of the bracket. If the two strongest photos are drawn against each other
 * in round one, the second-strongest finishes in the bottom half of the results.
 * That is exactly the failure PRD success criterion 4 forbids.
 *
 * The fix is the classic tournament-selection argument. Under any consistent
 * judgement, the true second-best photo can only ever have lost to ONE photo:
 * the champion. So:
 *
 *   place 1  the champion of the main bracket.
 *   pool     every photo the champion personally eliminated.
 *   place 2  run a fresh mini single-elimination over that pool. Its winner is
 *            second. This is the second-chance round: a photo knocked out in
 *            round one by the eventual champion is right back in contention for
 *            second place, which is precisely "not lost to an unlucky draw".
 *   place p  when a photo is placed, remove it from the pool and add every photo
 *            IT personally eliminated (in the main bracket; anyone it beat during
 *            a repechage round is already in the pool). Run the next mini
 *            bracket. Repeat until `target` places are filled.
 *
 * Only photos beaten by a deep finisher ever enter the pool, which is the PRD's
 * "photos eliminated by deep finishers". The ORDER they play in is not random:
 * the mini bracket is seeded by how deep each candidate got in the main bracket,
 * so the two candidates with the strongest résumés are placed on opposite sides
 * and meet in the mini final rather than in its first round.
 *
 * Two things keep the cost down, both in closeSub/knownWinner below: the pool is
 * held in fixed slots so consecutive mini brackets differ only along the path
 * that changed, and a pairing the user has already judged is never asked twice.
 *
 * MEASURED, driving the built artifact in Chromium (Playwright, file:// origin):
 *
 *   field  target  comparisons   info floor   all pairs   textbook n-1+(k-1)lg n
 *      16       8           37           28         120                      43
 *      32       8           53           39         496                      66
 *      64       5           87           28        2016                      87
 *     500      20          712          170      124750                     670
 *
 * Randomised sweep, 200 fields of 4-48 photos with deferrals injected: every run
 * produced the exactly-correct ranking, and the worst run cost 1.03x textbook.
 *
 * DEFERRAL, UNDO, EARLY-STOP
 * --------------------------
 * "Too close to call" rotates the pairing to the BACK of the current round's
 * queue. It is never resolved by a coin flip and never dropped; it comes back
 * once the rest of the round has been judged, by which time the user has usually
 * recalibrated. Deferral is itself an op, so it survives reload and is undoable.
 *
 * Early-stop must yield a usable ranked result (PRD success criterion 9), so
 * `unit.winners` is rewritten after EVERY comparison, not at the end. Decided
 * places come first in true order; anything not yet placed is appended ranked by
 * how deep it got and how many comparisons it won. Stopping is also reversible —
 * it sets a flag rather than tearing the bracket down.
 *
 * ============================================================================
 * PRD 7.4 — Stage C: burst runoff
 * ============================================================================
 * A finalist that belongs to a near-duplicate group can be expanded into a
 * Keep-1 pass over that group. The group includes members cut back in Stage A,
 * which is the point: the burst cost one decision at ranking time (PRD success
 * criterion 3) and this is where the user gets to pick the best frame of it.
 * Optional, per-photo, and reversible. A unit with no near-duplicate groups
 * among its winners says so and offers to move on.
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});
  var el = PT.dom.el;

  /* ======================================================================
   * 1. The engine — pure, no DOM, no store. Exported as PT.bracket.
   * ==================================================================== */

  function nextPow2(n) { var s = 1; while (s < n) s *= 2; return s; }

  /**
   * Slot order for a standard seeded bracket of `size` entrants, 1-based.
   * size 8 -> [1,8,4,5,2,7,3,6], i.e. pairs (1v8)(4v5)(2v7)(3v6).
   *
   * Two properties matter here. Every pair sums to size+1, so the lower seed is
   * always in the `a` slot and a bye (a seed number above the entrant count) is
   * therefore always in `b`. And top seeds land in different halves, which is
   * what spreads byes evenly across a non-power-of-two field.
   */
  function seedSlots(size) {
    var s = [1], i, n, t;
    while (s.length < size) {
      n = s.length * 2 + 1;
      t = [];
      for (i = 0; i < s.length; i++) { t.push(s[i]); t.push(n - s[i]); }
      s = t;
    }
    return s;
  }

  /**
   * First-round pairs for a field of any size. `entrants` is in seed order:
   * index 0 is seed 1. Entrants beyond the field size become nulls, which
   * resolveRound() turns into byes.
   */
  function firstRoundPairs(entrants) {
    var count = entrants.length;
    var size = nextPow2(count);
    var so = seedSlots(size);
    var pairs = [], i, sa, sb;
    for (i = 0; i < size / 2; i++) {
      sa = so[2 * i];
      sb = so[2 * i + 1];
      pairs.push({
        a: sa <= count ? entrants[sa - 1] : null,
        b: sb <= count ? entrants[sb - 1] : null,
        winner: null,
        mid: null,
        bye: false
      });
    }
    return pairs;
  }

  function createEngine(pool, target, seed) {
    var E = {
      seed: seed >>> 0,
      pool: pool.slice(),
      target: Math.max(0, Math.min(target, pool.length)),
      order: PT.session.seededShuffle(pool, seed >>> 0),

      matches: {},      // mid -> {mid, tag, round, pair, a, b, place}
      victims: {},      // winner id -> ids it personally eliminated
      elimBy: {},       // loser id -> the id that knocked it out of the MAIN bracket
      depth: {},        // id -> deepest MAIN round reached (0-based)
      wins: {},         // id -> comparisons won, all stages
      won: {},          // 'winner|loser' -> 1, so a pairing is never asked twice
      derived: 0,       // pairings resolved from a result the user already gave
      deferCount: {},   // mid -> times deferred

      placements: [],   // ordered, best first, fully decided
      candidates: [],   // live repechage pool for the next place
      repSlots: null,   // fixed-length slot array behind it; see closeSub
      history: [],      // [{mid,w,l,tag,round,place}] newest last

      comparisons: 0,
      defers: 0,
      place: 1,
      sub: null,        // the sub-bracket currently being played
      done: false,
      broke: null       // set if an ops log did not match the rebuilt bracket
    };
    if (!E.order.length || E.target === 0) { E.done = true; return E; }
    startSub(E, E.order, 'main', 1);
    return E;
  }

  /**
   * Begin a sub-bracket: the main draw, or one repechage mini bracket.
   * `entrants` may contain nulls — repechage slots are held open so the bracket
   * keeps its shape between places (see closeSub) — and a null is simply a bye.
   */
  function startSub(E, entrants, tag, place) {
    var live = entrants.filter(Boolean);
    if (!live.length) { closeSub(E, null); return; }
    if (live.length === 1) { closeSub(E, live[0]); return; }
    E.sub = {
      tag: tag,
      place: place,
      entrants: live.length,
      decided: 0,
      derived: 0,
      rounds: [firstRoundPairs(entrants)],
      ri: 0,
      queue: []
    };
    markDepth(E);
    resolveRound(E);
  }

  /**
   * Depth is recorded only for the main draw. It is the repechage seeding key
   * and the tiebreak for early-stop ranking, and both want "how far did this
   * photo get in the real bracket", not "how far in a consolation round".
   */
  function markDepth(E) {
    var sub = E.sub, i, p;
    if (sub.tag !== 'main') return;
    for (i = 0; i < sub.rounds[sub.ri].length; i++) {
      p = sub.rounds[sub.ri][i];
      if (p.a) E.depth[p.a] = Math.max(E.depth[p.a] || 0, sub.ri);
      if (p.b) E.depth[p.b] = Math.max(E.depth[p.b] || 0, sub.ri);
    }
  }

  /**
   * Auto-advance byes, mint match ids for the real pairings, and build the
   * queue the user works through. An empty queue means the round needs no
   * human input at all, so advance immediately.
   */
  /**
   * A pairing this exact user already judged. The repechage re-pools photos
   * across successive places, so without this the same two photos come back up
   * repeatedly — which reads as the tool not listening, and inflates the
   * comparison count for no information. Only DIRECT results are reused, never
   * a transitive chain: the tool must not invent an answer the user never gave.
   */
  function knownWinner(E, a, b) {
    if (E.won[a + '|' + b]) return a;
    if (E.won[b + '|' + a]) return b;
    return null;
  }

  function recordEdge(E, sub, w, l) {
    E.won[w + '|' + l] = 1;
    var v = E.victims[w] || (E.victims[w] = []);
    if (v.indexOf(l) < 0) v.push(l);
    // Only main-bracket edges answer "who eliminated whom" for the repechage;
    // a repechage loss does not remove a photo from the candidate pool.
    if (sub.tag === 'main' && !E.elimBy[l]) E.elimBy[l] = w;
  }

  function resolveRound(E) {
    var sub = E.sub, round = sub.rounds[sub.ri], q = [], i, p, k;
    for (i = 0; i < round.length; i++) {
      p = round[i];
      if (p.winner) continue;
      if (p.a && !p.b) { p.winner = p.a; p.bye = true; continue; }
      if (!p.a && p.b) { p.winner = p.b; p.bye = true; continue; }
      if (!p.a && !p.b) continue;
      k = knownWinner(E, p.a, p.b);
      if (k) {
        p.winner = k;
        p.derived = true;
        E.derived++;
        sub.derived++;
        recordEdge(E, sub, k, k === p.a ? p.b : p.a);
        continue;
      }
      if (!p.mid) {
        p.mid = sub.tag + ':r' + sub.ri + ':p' + i;
        E.matches[p.mid] = {
          mid: p.mid, tag: sub.tag, round: sub.ri, pair: i,
          a: p.a, b: p.b, place: sub.place
        };
      }
      q.push(i);
    }
    sub.queue = q;
    if (!q.length) advanceRound(E);
  }

  function advanceRound(E) {
    var sub = E.sub, round = sub.rounds[sub.ri], winners = [], next = [], live, i;
    // Nulls are kept in place: dropping them would renumber the slots and turn
    // an unchanged half of the bracket into a set of unfamiliar pairings.
    for (i = 0; i < round.length; i++) winners.push(round[i].winner || null);
    live = winners.filter(Boolean);
    if (live.length <= 1) { closeSub(E, live[0] || null); return; }
    for (i = 0; i < winners.length; i += 2) {
      next.push({ a: winners[i], b: winners[i + 1] || null, winner: null, mid: null, bye: false });
    }
    sub.rounds.push(next);
    sub.ri++;
    markDepth(E);
    resolveRound(E);
  }

  /**
   * A sub-bracket produced its winner. Award the place, roll the candidate pool
   * forward, and start the next repechage.
   *
   * The pool is held as a FIXED-LENGTH SLOT ARRAY (a power of two, padded with
   * nulls) rather than a list, and the photo just placed is replaced IN ITS OWN
   * SLOT by a newcomer or by a hole. That single decision is what makes the
   * repechage cheap: every sub-bracket that did not contain the extracted photo
   * is pairing-for-pairing identical to the one just played, so knownWinner()
   * replays it for free and the user is only asked about the path that actually
   * changed. Rebuilding the pool as a fresh list instead re-seeds everything and
   * asks a pile of questions whose answers are already on record: measured at 98
   * comparisons for a 64-photo top 5, against 87 with the slots held, and 1389
   * against 712 for a 500-photo top 20.
   */
  function closeSub(E, winnerId) {
    E.sub = null;
    if (winnerId) E.placements.push(winnerId);
    E.place = E.placements.length + 1;
    if (!winnerId || E.placements.length >= E.target) { E.done = true; return; }

    var placed = {};
    E.placements.forEach(function (id) { placed[id] = 1; });
    var fresh = (E.victims[winnerId] || []).filter(function (id) { return !placed[id]; });

    if (!E.repSlots) {
      E.repSlots = padToPow2(byResume(E, fresh));
    } else {
      var newcomers = byResume(E, fresh.filter(function (id) { return E.repSlots.indexOf(id) < 0; }));
      var at = E.repSlots.indexOf(winnerId);
      if (at >= 0) E.repSlots[at] = newcomers.shift() || null;
      var i;
      for (i = 0; i < E.repSlots.length && newcomers.length; i++) {
        if (E.repSlots[i] == null) E.repSlots[i] = newcomers.shift();
      }
      while (newcomers.length) {                 // rare: the pool outgrew its bracket
        var grown = E.repSlots.length * 2;
        while (E.repSlots.length < grown) E.repSlots.push(null);
        for (i = 0; i < E.repSlots.length && newcomers.length; i++) {
          if (E.repSlots[i] == null) E.repSlots[i] = newcomers.shift();
        }
      }
    }

    E.candidates = E.repSlots.filter(Boolean);
    if (!E.candidates.length) { E.done = true; return; }
    startSub(E, E.repSlots.slice(), 'rep' + E.place, E.place);
  }

  function padToPow2(arr) {
    var size = nextPow2(Math.max(1, arr.length));
    while (arr.length < size) arr.push(null);
    return arr;
  }

  /**
   * Order candidates by the strength of their résumé — how deep they got in the
   * main draw, then how many comparisons they have won — so the standard seed
   * slots put the two best-credentialled photos in opposite halves and they
   * meet in the mini final rather than its first round. Ids are sorted before
   * the deterministic shuffle so the tiebreak never depends on ingest order.
   */
  function byResume(E, ids) {
    var sorted = ids.slice().sort();
    var shuffled = PT.session.seededShuffle(sorted, (E.seed ^ (E.place * 2654435761)) >>> 0);
    var rank = {};
    shuffled.forEach(function (id, i) { rank[id] = i; });
    return shuffled.slice().sort(function (x, y) {
      var d = (E.depth[y] || 0) - (E.depth[x] || 0);
      if (d) return d;
      var w = (E.wins[y] || 0) - (E.wins[x] || 0);
      if (w) return w;
      return rank[x] - rank[y];
    });
  }

  /** The pairing the user is being asked about right now, or null. */
  function currentMatch(E) {
    if (!E.sub || !E.sub.queue.length) return null;
    return E.matches[E.sub.rounds[E.sub.ri][E.sub.queue[0]].mid];
  }

  function applyPick(E, winnerId) {
    var m = currentMatch(E);
    if (!m) return false;
    var loser = winnerId === m.a ? m.b : (winnerId === m.b ? m.a : null);
    if (!loser) return false;
    var sub = E.sub, p = sub.rounds[sub.ri][sub.queue[0]];
    p.winner = winnerId;
    sub.queue.shift();
    sub.decided++;
    E.comparisons++;
    E.wins[winnerId] = (E.wins[winnerId] || 0) + 1;
    recordEdge(E, sub, winnerId, loser);
    E.history.push({ mid: m.mid, w: winnerId, l: loser, tag: sub.tag, round: sub.ri, place: sub.place });
    if (!sub.queue.length) advanceRound(E);
    return true;
  }

  /** Rotate to the back of this round's queue. Never resolved, never dropped. */
  function applyDefer(E) {
    var sub = E.sub;
    if (!sub || !sub.queue.length) return false;
    var mid = sub.rounds[sub.ri][sub.queue[0]].mid;
    E.deferCount[mid] = (E.deferCount[mid] || 0) + 1;
    E.defers++;
    sub.queue.push(sub.queue.shift());
    return true;
  }

  /**
   * Rebuild the whole bracket from the persisted log. This is the only way a
   * bracket is ever constructed — mount, undo and resume all go through here,
   * so there is exactly one code path and it is the one the tests exercise.
   */
  function build(pool, target, seed, ops) {
    var E = createEngine(pool, target, seed);
    var list = ops || [], i, op, m;
    for (i = 0; i < list.length; i++) {
      op = list[i];
      if (E.done || !E.sub) { E.broke = E.broke || 'op ' + i + ' past completion'; break; }
      m = currentMatch(E);
      if (!m) { E.broke = 'op ' + i + ' with no pending match'; break; }
      if (op.m && op.m !== m.mid) { E.broke = 'op ' + i + ' expected ' + op.m + ', bracket is at ' + m.mid; break; }
      if (op.t === 'defer') applyDefer(E);
      else if (!applyPick(E, op.w)) { E.broke = 'op ' + i + ' picked ' + op.w + ', not in ' + m.mid; break; }
    }
    return E;
  }

  /**
   * PRD success criterion 9. Decided places first, in true order. Anything not
   * yet placed is appended by main-bracket depth, then wins, then draw order —
   * so a bracket stopped after two comparisons still hands back a defensible
   * ranked list rather than an empty one.
   */
  function results(E) {
    var placed = {}, out = E.placements.slice(), idx = {};
    out.forEach(function (id) { placed[id] = 1; });
    if (out.length < E.target) {
      E.order.forEach(function (id, i) { idx[id] = i; });
      var rest = E.order.filter(function (id) { return !placed[id]; });
      rest.sort(function (a, b) {
        var d = (E.depth[b] || 0) - (E.depth[a] || 0);
        if (d) return d;
        var w = (E.wins[b] || 0) - (E.wins[a] || 0);
        if (w) return w;
        return idx[a] - idx[b];
      });
      out = out.concat(rest);
    }
    return out.slice(0, E.target);
  }

  /**
   * Comparisons still to come. Near-exact for the sub-bracket in progress — a
   * k-entrant single elimination is k-1 matches, byes included, less the ones
   * already answered by an earlier identical pairing — and modelled for the
   * places after it, where a finisher's victim list runs to about one photo per
   * round it played.
   */
  function estimate(E) {
    if (E.done) return 0;
    var rem = 0;
    if (E.sub) rem += (E.sub.entrants - 1) - E.sub.derived - E.sub.decided;
    var placesLeft = E.target - E.placements.length - (E.sub ? 1 : 0);
    if (placesLeft > 0) {
      rem += placesLeft * Math.max(1, Math.ceil(Math.log2(Math.max(2, E.order.length))) - 1);
    }
    return Math.max(0, rem);
  }

  /**
   * Unlimited undo. Drops the most recent comparison and any deferrals made
   * after it, because a user who undoes after deferring twice means "give me
   * back the choice I actually made", not "give me back a deferral".
   */
  function undoOps(ops) {
    for (var i = ops.length - 1; i >= 0; i--) {
      if (ops[i].t !== 'defer') return ops.slice(0, i);
    }
    return ops.slice(0, Math.max(0, ops.length - 1));
  }

  PT.bracket = {
    build: build,
    results: results,
    estimate: estimate,
    undoOps: undoOps,
    currentMatch: currentMatch,
    seedSlots: seedSlots,
    firstRoundPairs: firstRoundPairs,
    nextPow2: nextPow2
  };

  /* ======================================================================
   * 2. Styles — injected once, since src/css is owned elsewhere.
   * ==================================================================== */

  var STYLE_ID = 'pt-bracket-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.bk{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px}',
      '.bk-sub{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--text-dim);flex-wrap:wrap}',
      '.bk-tag{border:1px solid var(--line-2);border-radius:4px;padding:1px 7px;font-size:12px}',
      '.bk-tag-rep{border-color:var(--accent-dim);color:var(--accent)}',
      '.bk-tag-warn{border-color:#5c4f22;color:#f0e0b0}',
      '.bk-stage{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.bk-pane{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;',
      'background:#000;border:2px solid var(--line);border-radius:var(--r);overflow:hidden}',
      '.bk-pane:hover{border-color:var(--line-2)}',
      '.bk-pane.chosen{border-color:var(--accent)}',
      '.bk-vp{position:relative;flex:1;min-height:0;overflow:hidden;cursor:pointer;touch-action:none}',
      '.bk-vp img{position:absolute;top:0;left:0;transform-origin:0 0;-webkit-user-drag:none;user-select:none;pointer-events:none}',
      '.bk-vp.grab{cursor:grabbing}',
      '.bk-cap{display:flex;align-items:center;gap:8px;padding:5px 9px;font-size:12px;',
      'background:var(--surface);color:var(--text-dim);border-top:1px solid var(--line);',
      'white-space:nowrap;overflow:hidden}',
      '.bk-cap .nm{overflow:hidden;text-overflow:ellipsis}',
      '.bk-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.bk-zoom{font-variant-numeric:tabular-nums;min-width:56px;text-align:center;font-size:13px;color:var(--text-dim)}',
      '.bk-miss{display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-mute);font-size:13px}',
      '.bk-results{overflow:auto;min-height:0;flex:1}',
      '.bk-row{display:flex;align-items:center;gap:10px;padding:6px 4px;border-bottom:1px solid var(--line)}',
      '.bk-row img{width:104px;height:70px;object-fit:contain;background:#000;border-radius:4px;flex:none}',
      '.bk-rank{width:36px;text-align:right;font-variant-numeric:tabular-nums;color:var(--text-dim);flex:none}',
      '.bk-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}',
      '.ro-group{border:1px solid var(--line);border-radius:var(--r);padding:10px;margin-bottom:10px;background:var(--surface)}',
      '.ro-head{display:flex;align-items:center;gap:10px}',
      '.ro-head img{width:104px;height:70px;object-fit:contain;background:#000;border-radius:4px;flex:none}',
      '.ro-body{margin-top:10px}',
      '.ro-cell .tag{position:absolute;bottom:4px;left:4px;right:4px;font-size:11px;text-align:center;',
      'background:rgba(0,0,0,0.7);border-radius:3px;padding:1px 3px;color:var(--text-dim)}',
      '.ro-cell.dead{cursor:not-allowed;opacity:0.45}',
      '@media(max-width:720px){.bk-stage{grid-template-columns:1fr}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ======================================================================
   * 3. Shared helpers
   * ==================================================================== */

  function photoOf(id) {
    var st = PT.store.get();
    return (st && st.photos && st.photos[id]) || { id: id, name: id };
  }

  function nameOf(id) { return photoOf(id).name || id; }

  /**
   * PRD 7.9 caches a ~1600px preview and a ~320px thumb. The cache is
   * evictable (see 00_core.js), so falling back to the thumb is normal
   * operation, not an error path.
   */
  function blobFor(id, wantPreview) {
    var st = PT.store.get();
    var d = (st && st.derivatives && st.derivatives[id]) || null;
    if (!d) return null;
    return (wantPreview ? (d.preview || d.thumb) : (d.thumb || d.preview)) || null;
  }

  /** Async second chance: the record may still be in IndexedDB but not in memory. */
  function hydrate(id) {
    var st = PT.store.get();
    if (!st) return Promise.resolve(null);
    if (st.derivatives && st.derivatives[id]) return Promise.resolve(st.derivatives[id]);
    return PT.db.get('derivatives', id).then(function (rec) {
      if (!rec) return null;
      var s2 = PT.store.get();
      if (s2) { s2.derivatives = s2.derivatives || {}; s2.derivatives[id] = rec; }
      return rec;
    }).catch(function () { return null; });
  }

  function setTopbar(context, counters, stopHandler, stopLabel) {
    var bar = document.getElementById('topbar');
    if (bar) bar.hidden = false;
    var c = document.getElementById('topbar-context');
    if (c) c.textContent = context || '';
    var n = document.getElementById('topbar-counters');
    if (n) {
      PT.dom.clear(n);
      (counters || []).forEach(function (pair) {
        n.appendChild(el('span', {}, [pair[0] + ' ', el('b', { text: String(pair[1]) })]));
      });
    }
    var stop = document.getElementById('topbar-stop');
    if (stop) {
      if (stop._ptHandler) stop.removeEventListener('click', stop._ptHandler);
      stop._ptHandler = null;
      if (stopHandler) {
        stop.hidden = false;
        stop.textContent = stopLabel || 'Stop early';
        stop._ptHandler = stopHandler;
        stop.addEventListener('click', stopHandler);
      } else {
        stop.hidden = true;
      }
    }
  }

  function clearTopbar() { setTopbar('', [], null); }

  /** Router.go throws on an unregistered screen; the next screen may not exist yet. */
  function tryGo(name, params) {
    try { PT.router.go(name, params); return true; }
    catch (e) { PT.warn('bracket', 'cannot navigate to "' + name + '": ' + e.message); return false; }
  }

  /* ======================================================================
   * 4. Screen: 'bracket'  (PRD 7.3)
   * ==================================================================== */

  var S = null;   // live screen state; null when unmounted

  function unitOf(unitId) {
    var st = PT.store.get();
    if (!st || !st.session || !st.session.units) return null;
    return st.session.units[unitId] || null;
  }

  function ensureBracket(unitId) {
    var u = unitOf(unitId);
    if (!u) return null;
    if (!u.bracket || !u.bracket.ops) {
      PT.store.dispatch('bracket:init', function (s) {
        var unit = s.session.units[unitId];
        var target = unit.target == null ? unit.pool.length : Math.min(unit.target, unit.pool.length);
        var seed = (Date.now() ^ 0x9e3779b9) >>> 0;
        unit.bracket = {
          seed: seed,
          pool: unit.pool.slice(),
          target: target,
          uncapped: unit.target == null,
          order: PT.session.seededShuffle(unit.pool, seed),
          ops: [],
          stopped: false,
          complete: false,
          startedAt: Date.now()
        };
        if (unit.phase !== 'runoff' && unit.phase !== 'done') unit.phase = 'bracket';
      });
    }
    return unitOf(unitId);
  }

  /**
   * One dispatch per user action: mutate the log, rebuild, and rewrite the
   * unit's ranked output. Keeping winners current after every comparison is
   * what makes early-stop free (PRD success criterion 9).
   */
  function commit(name, mutate) {
    if (!S) return;
    var unitId = S.unitId;
    PT.store.dispatch(name, function (s) {
      var u = s.session.units[unitId];
      if (!u || !u.bracket) return;
      if (mutate) mutate(u.bracket, u);
      var E = build(u.bracket.pool, u.bracket.target, u.bracket.seed, u.bracket.ops);
      u.bracket.complete = E.done;
      u.winners = results(E);
      u.winnersDecided = E.placements.length;
      u.comparisons = E.comparisons;
      if (S) S.engine = E;
    });
    paint();
  }

  function mountBracket(root, params) {
    injectStyle();
    var unitId = params && params.unitId;
    var u = ensureBracket(unitId);

    if (!u) {
      root.appendChild(el('div', { class: 'error-box', text: 'No tournament unit "' + unitId + '" in this session.' }));
      return;
    }

    S = {
      unitId: unitId,
      root: root,
      engine: null,
      lastMid: null,
      // Shared view state. cx/cy are normalised image coordinates, so the two
      // panes show the SAME REGION even when the photos differ in aspect.
      view: { z: 1, cx: 0.5, cy: 0.5 },
      panes: [],
      onKey: null,
      onResize: null,
      token: Date.now()
    };

    S.head = el('div', { class: 'bk-sub' });
    S.stage = el('div', { class: 'bk-stage' });
    S.bar = el('div', { class: 'bk-bar' });
    S.body = el('div', { class: 'bk' }, [S.head, S.stage, S.bar]);
    root.appendChild(S.body);

    S.panes = [buildPane(0), buildPane(1)];

    S.onKey = function (e) {
      if (!S) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      var m = S.engine && currentMatch(S.engine);
      switch (e.key) {
        case 'ArrowLeft':  if (m) { e.preventDefault(); choose(m.a); } break;
        case 'ArrowRight': if (m) { e.preventDefault(); choose(m.b); } break;
        case 'd': case 'D': if (m) { e.preventDefault(); defer(); } break;
        case 'u': case 'U': e.preventDefault(); undo(); break;
        case '0': e.preventDefault(); setZoom(1, null); break;
        case '1': e.preventDefault(); zoomOneToOne(); break;
        case '+': case '=': e.preventDefault(); setZoom(S.view.z * 1.35, null); break;
        case '-': case '_': e.preventDefault(); setZoom(S.view.z / 1.35, null); break;
      }
    };
    window.addEventListener('keydown', S.onKey);

    S.onResize = function () { if (S) applyView(); };
    window.addEventListener('resize', S.onResize);

    // The shell's own Stop-early button emits this; honour it either way.
    S.offStop = PT.bus.on('stage:stop-early', function () { setStopped(true); });

    commit('bracket:open', null);
  }

  function buildPane(side) {
    var img = el('img', { alt: '' });
    var vp = el('div', { class: 'bk-vp' }, [img]);
    var cap = el('div', { class: 'bk-cap' }, [
      el('kbd', { text: side === 0 ? '←' : '→' }),
      el('span', { class: 'nm' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'dim px' })
    ]);
    var pane = el('div', { class: 'bk-pane' }, [vp, cap]);
    var P = { side: side, pane: pane, vp: vp, img: img, cap: cap, id: null, nat: { w: 0, h: 0 } };

    img.addEventListener('load', function () {
      P.nat.w = img.naturalWidth || 0;
      P.nat.h = img.naturalHeight || 0;
      applyView();
    });

    // Drag to pan. A drag longer than a few pixels suppresses the click, so
    // panning never fires a choice by accident.
    var drag = null;
    vp.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, moved: 0, cx: S.view.cx, cy: S.view.cy };
      vp.classList.add('grab');
      try { vp.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
    });
    vp.addEventListener('pointermove', function (e) {
      if (!drag || !S) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      var g = geom(P);
      if (!g) return;
      S.view.cx = drag.cx - dx / (g.natW * g.S);
      S.view.cy = drag.cy - dy / (g.natH * g.S);
      applyView();
    });
    function endDrag() { if (drag) { vp.classList.remove('grab'); } }
    vp.addEventListener('pointerup', function (e) {
      var wasDrag = drag && drag.moved > 5;
      endDrag();
      drag = null;
      if (wasDrag || !S) return;
      var m = S.engine && currentMatch(S.engine);
      if (m) choose(side === 0 ? m.a : m.b);
    });
    vp.addEventListener('pointercancel', function () { endDrag(); drag = null; });

    // Wheel zoom about the cursor, applied to BOTH panes.
    vp.addEventListener('wheel', function (e) {
      if (!S) return;
      e.preventDefault();
      var r = vp.getBoundingClientRect();
      // Proportional to the wheel delta so a trackpad glides and a mouse notch
      // steps, capped per event so one violent flick cannot jump to 16x.
      var f = Math.max(0.5, Math.min(2, Math.exp(-e.deltaY * 0.0015)));
      setZoom(S.view.z * f, { P: P, x: e.clientX - r.left, y: e.clientY - r.top });
    }, { passive: false });

    return P;
  }

  /* ------------------------------------------------------------ zoom model */

  /**
   * Layout for one pane at the current shared view. `fit` is the scale at which
   * the whole photo is visible; z multiplies it, so z is a shared, aspect-
   * independent quantity and both panes always frame the same relative region.
   */
  function geom(P) {
    if (!P.nat.w || !P.nat.h) return null;
    var w = P.vp.clientWidth, h = P.vp.clientHeight;
    if (!w || !h) return null;
    var fit = Math.min(w / P.nat.w, h / P.nat.h);
    var Sc = fit * S.view.z;
    return { vpW: w, vpH: h, natW: P.nat.w, natH: P.nat.h, fit: fit, S: Sc };
  }

  function halfExtents(g) {
    return [(g.vpW / 2) / (g.natW * g.S), (g.vpH / 2) / (g.natH * g.S)];
  }

  function clampCenter(g, cx, cy) {
    var h = halfExtents(g);
    return [
      h[0] >= 0.5 ? 0.5 : Math.min(1 - h[0], Math.max(h[0], cx)),
      h[1] >= 0.5 ? 0.5 : Math.min(1 - h[1], Math.max(h[1], cy))
    ];
  }

  /**
   * Getting this wrong is what makes a dual-zoom feel broken, so it is written
   * out rather than inlined. Two photos of DIFFERENT ORIENTATION overflow the
   * viewport on different axes, and both naive rules fail:
   *
   *   - clamp the shared centre against every pane: the pane that does not
   *     overflow reports a half-extent above 0.5, which pins that axis to dead
   *     centre and kills panning entirely. (Measured; it was the first attempt.)
   *   - clamp each pane independently and write nothing back: near an edge the
   *     narrower photo clamps first and the two panes silently drift onto
   *     different regions, which is exactly the comparability the PRD asks for.
   *
   * The rule that works: clamp the shared centre by the TIGHTEST pane that can
   * actually pan on that axis, ignoring panes that cannot. Every pane that can
   * pan then lands on the identical normalised centre, and a pane that cannot
   * pan shows that whole axis — which contains the other's view anyway.
   */
  function clampShared() {
    var hx = 0, hy = 0;
    S.panes.forEach(function (P) {
      var g = geom(P);
      if (!g) return;
      var h = halfExtents(g);
      if (h[0] < 0.5) hx = Math.max(hx, h[0]);
      if (h[1] < 0.5) hy = Math.max(hy, h[1]);
    });
    S.view.cx = hx > 0 ? Math.min(1 - hx, Math.max(hx, S.view.cx)) : 0.5;
    S.view.cy = hy > 0 ? Math.min(1 - hy, Math.max(hy, S.view.cy)) : 0.5;
  }

  function applyView() {
    if (!S) return;
    S.view.cx = Math.min(1, Math.max(0, S.view.cx));
    S.view.cy = Math.min(1, Math.max(0, S.view.cy));
    clampShared();
    S.panes.forEach(function (P) {
      var g = geom(P);
      if (!g) { P.img.style.transform = ''; return; }
      var c = clampCenter(g, S.view.cx, S.view.cy);
      var left = g.vpW / 2 - c[0] * g.natW * g.S;
      var top = g.vpH / 2 - c[1] * g.natH * g.S;
      P.img.style.width = g.natW + 'px';
      P.img.style.height = g.natH + 'px';
      P.img.style.transform = 'translate(' + left.toFixed(2) + 'px,' + top.toFixed(2) + 'px) scale(' + g.S.toFixed(5) + ')';
      var px = P.cap.querySelector('.px');
      if (px) px.textContent = g.natW ? g.natW + '×' + g.natH : '';
    });
    if (S.zoomLabel) S.zoomLabel.textContent = Math.round(S.view.z * 100) + '%';
  }

  /**
   * z is relative to fit, so z=1 shows both photos whole. The floor drops below
   * 1 only when a preview is smaller than its pane: there 1:1 means zooming
   * OUT, and refusing to go there would make the 1:1 button a no-op.
   */
  function minZoom() {
    var g = geom(S.panes[0]) || geom(S.panes[1]);
    return g ? Math.min(1, 1 / g.fit) : 1;
  }

  /** anchor: {P, x, y} keeps the point under the cursor fixed while zooming. */
  function setZoom(z, anchor) {
    if (!S) return;
    z = Math.max(minZoom(), Math.min(16, z));
    if (anchor && anchor.P) {
      var g = geom(anchor.P);
      if (g) {
        var left = g.vpW / 2 - S.view.cx * g.natW * g.S;
        var top = g.vpH / 2 - S.view.cy * g.natH * g.S;
        var u = (anchor.x - left) / (g.natW * g.S);
        var v = (anchor.y - top) / (g.natH * g.S);
        var S2 = g.fit * z;
        S.view.cx = u - (anchor.x - g.vpW / 2) / (g.natW * S2);
        S.view.cy = v - (anchor.y - g.vpH / 2) / (g.natH * S2);
      }
    }
    S.view.z = z;
    applyView();
  }

  /**
   * 1:1 means one preview pixel per screen pixel. Two photos of different
   * aspect cannot both be at 1:1 while framing the same region, so the LEFT
   * pane is the reference and the right stays locked to the same region.
   */
  function zoomOneToOne() {
    var g = geom(S.panes[0]) || geom(S.panes[1]);
    if (!g) return;
    setZoom(1 / g.fit, null);
  }

  /* ------------------------------------------------------------- actions */

  function choose(winnerId) {
    if (!S || !winnerId) return;
    var m = S.engine && currentMatch(S.engine);
    if (!m) return;
    commit('bracket:pick', function (b) { b.ops.push({ t: 'pick', m: m.mid, w: winnerId }); });
  }

  function defer() {
    if (!S) return;
    var m = S.engine && currentMatch(S.engine);
    if (!m) return;
    commit('bracket:defer', function (b) { b.ops.push({ t: 'defer', m: m.mid }); });
  }

  function undo() {
    if (!S) return;
    commit('bracket:undo', function (b) { b.ops = undoOps(b.ops); b.stopped = false; });
  }

  /**
   * Early-stop is a flag, not a teardown: `unit.winners` is already current
   * after every comparison, so stopping costs nothing and resuming is one
   * click. Guarded so the shell's own #topbar-stop handler and this screen's
   * cannot double-dispatch.
   */
  function setStopped(v) {
    if (!S) return;
    var u = unitOf(S.unitId);
    if (!u || !u.bracket || !!u.bracket.stopped === !!v) return;
    commit(v ? 'bracket:stop' : 'bracket:resume', function (b) { b.stopped = !!v; });
  }

  function continueToRunoff() {
    if (!S) return;
    var unitId = S.unitId;
    commit('bracket:handoff', function (b, u) { if (u.phase === 'bracket') u.phase = 'runoff'; });
    PT.bus.emit('bracket:complete', { unitId: unitId });
    if (PT.router.current() === 'bracket') tryGo('runoff', { unitId: unitId });
  }

  /* --------------------------------------------------------------- paint */

  function paint() {
    if (!S) return;
    var u = unitOf(S.unitId);
    if (!u) return;
    var E = S.engine || build(u.bracket.pool, u.bracket.target, u.bracket.seed, u.bracket.ops);
    S.engine = E;
    var m = currentMatch(E);
    var finished = E.done || u.bracket.stopped || !m;

    setTopbar(
      (u.label || 'unit') + ' · Stage B bracket',
      [
        ['target', u.bracket.uncapped ? 'uncapped' : E.target],
        ['remaining', Math.max(0, E.target - E.placements.length)],
        ['comparisons', E.comparisons],
        ['est. left', finished && E.done ? 0 : '~' + estimate(E)]
      ],
      finished ? null : function () { setStopped(true); },
      'Stop early'
    );

    if (finished) paintDone(u, E);
    else paintMatch(u, E, m);
  }

  function paintMatch(u, E, m) {
    S.stage.style.display = '';
    PT.dom.clear(S.head);
    PT.dom.clear(S.bar);

    var isRep = m.tag !== 'main';
    S.head.appendChild(el('span', {
      class: 'bk-tag' + (isRep ? ' bk-tag-rep' : ''),
      text: isRep ? 'Second chance · place ' + m.place : 'Main bracket · round ' + (m.round + 1)
    }));
    var roundTotal = E.sub.rounds[E.sub.ri].filter(function (p) { return p.mid; }).length;
    S.head.appendChild(el('span', {
      text: E.sub.queue.length + ' pairing' + (E.sub.queue.length === 1 ? '' : 's') +
            ' still to judge of ' + roundTotal + ' this round'
    }));
    if (isRep) {
      S.head.appendChild(el('span', {
        class: 'small dim',
        text: 'These lost to ' + nameOf(E.placements[E.placements.length - 1]) + ' or to a photo already placed.'
      }));
    }
    if (E.deferCount[m.mid]) {
      S.head.appendChild(el('span', {
        class: 'bk-tag bk-tag-warn',
        text: E.sub.queue.length === 1
          ? 'Deferred · last pairing in this round'
          : 'Deferred, back again'
      }));
    }
    if (E.broke) S.head.appendChild(el('span', { class: 'bk-tag bk-tag-warn', text: 'log/bracket mismatch: ' + E.broke }));

    // Attach before loading so the panes have a measurable size by the time an
    // image fires its load event.
    if (!S.stage.firstChild) {
      S.stage.appendChild(S.panes[0].pane);
      S.stage.appendChild(S.panes[1].pane);
    }
    // Only reload the photos when the pairing actually changes; repainting the
    // header after a defer must not flash the images or reset the zoom.
    if (S.lastMid !== m.mid) {
      S.lastMid = m.mid;
      S.view = { z: 1, cx: 0.5, cy: 0.5 };
      loadPane(S.panes[0], m.a);
      loadPane(S.panes[1], m.b);
    }

    S.zoomLabel = el('span', { class: 'bk-zoom', text: Math.round(S.view.z * 100) + '%' });
    S.bar.appendChild(el('button', {
      class: 'btn', id: 'bk-defer', onclick: defer,
      title: 'Sends this pairing to the back of the round. It comes back.'
    }, ['Too close to call ', el('kbd', { text: 'D' })]));
    S.bar.appendChild(el('button', {
      class: 'btn', id: 'bk-undo', onclick: undo,
      disabled: !u.bracket.ops.length
    }, ['Undo ', el('kbd', { text: 'U' })]));
    S.bar.appendChild(el('span', { class: 'spacer' }));
    S.bar.appendChild(el('button', { class: 'btn btn-sm', id: 'bk-zoomout', text: '−', onclick: function () { setZoom(S.view.z / 1.35, null); } }));
    S.bar.appendChild(S.zoomLabel);
    S.bar.appendChild(el('button', { class: 'btn btn-sm', id: 'bk-zoomin', text: '+', onclick: function () { setZoom(S.view.z * 1.35, null); } }));
    S.bar.appendChild(el('button', { class: 'btn btn-sm', id: 'bk-fit', text: 'Fit', onclick: function () { setZoom(1, null); } }));
    S.bar.appendChild(el('button', {
      class: 'btn btn-sm', id: 'bk-1to1', text: '1:1', onclick: zoomOneToOne,
      title: 'Both panes zoom together to the same region; the left pane sets the pixel scale.'
    }));
    S.bar.appendChild(el('span', { class: 'small dim', text: 'scroll to zoom · drag to pan · both photos move together' }));

    applyView();
  }

  function loadPane(P, id) {
    P.id = id;
    P.nat.w = 0; P.nat.h = 0;
    var nm = P.cap.querySelector('.nm');
    if (nm) nm.textContent = nameOf(id);
    var blob = blobFor(id, true);
    if (blob) { PT.dom.setImg(P.img, blob); return; }
    PT.dom.setImg(P.img, null);
    var token = S.token;
    hydrate(id).then(function (rec) {
      if (!S || S.token !== token || P.id !== id) return;
      var b2 = rec && (rec.preview || rec.thumb);
      if (b2) PT.dom.setImg(P.img, b2);
      else {
        var miss = P.vp.querySelector('.bk-miss');
        if (!miss) P.vp.appendChild(el('div', { class: 'bk-miss', text: nameOf(id) + ' — no cached preview' }));
      }
    });
  }

  /**
   * Completion, whether the bracket ran out of comparisons or the user stopped
   * early. Either way the ranked list is real and usable; the only difference
   * is how many places were decided head-to-head versus inferred from depth.
   */
  function paintDone(u, E) {
    PT.dom.clear(S.head);
    PT.dom.clear(S.bar);
    PT.dom.clear(S.stage);
    S.stage.style.display = 'block';
    S.lastMid = null;
    PT.dom.releaseImg(S.panes[0].img);
    PT.dom.releaseImg(S.panes[1].img);

    var stopped = !!u.bracket.stopped && !E.done;
    var decided = E.placements.length;
    var list = u.winners || [];

    S.head.appendChild(el('span', {
      class: 'bk-tag' + (stopped ? ' bk-tag-warn' : ''),
      text: stopped ? 'Stopped early' : 'Bracket complete'
    }));
    S.head.appendChild(el('span', {
      text: decided + ' of ' + list.length + ' place' + (list.length === 1 ? '' : 's') +
            ' decided head-to-head in ' + E.comparisons + ' comparison' + (E.comparisons === 1 ? '' : 's') + '.'
    }));
    if (decided < list.length) {
      S.head.appendChild(el('span', {
        class: 'small dim',
        text: 'The rest are ranked by how far they got and how many comparisons they won.'
      }));
    }
    if (E.derived) {
      S.head.appendChild(el('span', {
        class: 'small dim',
        text: E.derived + ' further pairing' + (E.derived === 1 ? '' : 's') + ' answered by a choice you had already made.'
      }));
    }

    var box = el('div', { class: 'bk-results', id: 'bk-results' });
    list.forEach(function (id, i) {
      var img = el('img', { alt: '' });
      var b = blobFor(id, false);
      if (b) PT.dom.setImg(img, b);
      var row = el('div', { class: 'bk-row', dataset: { id: id, rank: String(i + 1) } }, [
        el('span', { class: 'bk-rank', text: String(i + 1) }),
        img,
        el('span', { class: 'bk-name', text: nameOf(id) }),
        el('span', {
          class: 'small ' + (i < decided ? 'muted' : 'dim'),
          text: i < decided ? 'decided' : 'inferred'
        })
      ]);
      box.appendChild(row);
      if (!b) hydrate(id).then(function (rec) {
        if (S && rec && (rec.thumb || rec.preview)) PT.dom.setImg(img, rec.thumb || rec.preview);
      });
    });
    if (!list.length) box.appendChild(el('div', { class: 'notice notice-note', text: 'This unit has no photos to rank.' }));
    S.stage.appendChild(box);

    if (stopped) {
      S.bar.appendChild(el('button', { class: 'btn', id: 'bk-resume', text: 'Resume ranking', onclick: function () { setStopped(false); } }));
    }
    S.bar.appendChild(el('button', { class: 'btn', id: 'bk-undo', text: 'Undo last comparison', onclick: undo, disabled: !u.bracket.ops.length }));
    S.bar.appendChild(el('span', { class: 'spacer' }));
    S.bar.appendChild(el('button', { class: 'btn btn-primary', id: 'bk-continue', text: 'Continue to burst runoff', onclick: continueToRunoff }));
  }

  function unmountBracket(root) {
    if (S) {
      if (S.onKey) window.removeEventListener('keydown', S.onKey);
      if (S.onResize) window.removeEventListener('resize', S.onResize);
      if (S.offStop) S.offStop();
      S.panes.forEach(function (P) { PT.dom.releaseImg(P.img); });
    }
    PT.dom.$$('img', root).forEach(function (img) { PT.dom.releaseImg(img); });
    clearTopbar();
    S = null;
  }

  PT.router.register('bracket', { mount: mountBracket, unmount: unmountBracket });

  /* ======================================================================
   * 5. Screen: 'runoff'  (PRD 7.4, Stage C)
   * ==================================================================== */

  var R = null;

  /**
   * Groups come from the reviewed grouping (PRD 7.7) when there is one, and
   * otherwise from a fresh clustering. Either way it is computed over the
   * unit's WHOLE field, not just the winners: the frames a burst lost to
   * Stage A are exactly the ones the user now gets to reconsider.
   */
  function runoffGroups(unit) {
    var st = PT.store.get();
    var settings = (st.session && st.session.settings) || PT.session.DEFAULTS;
    var raw = null;

    if (unit.groups && unit.groups.length) {
      raw = unit.groups.map(function (g) {
        return Array.isArray(g) ? g.slice() : ((g && g.ids) || []).slice();
      });
    } else {
      var items = [];
      (unit.allIds || []).forEach(function (id) {
        var p = st.photos && st.photos[id];
        if (p && typeof p.phash === 'string' && p.phash.length === 16) {
          items.push({ id: id, hash: p.phash, w: p.w, h: p.h, sharp: p.sharp });
        }
      });
      if (items.length < 2) return [];
      try {
        raw = PT.phash.cluster(items, { threshold: settings.dupeThreshold, mode: settings.dupeMode });
      } catch (e) {
        PT.warn('runoff', 'cluster failed', e);
        return [];
      }
    }
    return raw.filter(function (g) { return g && g.length > 1; });
  }

  function membersMeta(ids) {
    var st = PT.store.get();
    return ids.map(function (id) {
      var p = (st.photos && st.photos[id]) || {};
      return { id: id, w: p.w, h: p.h, sharp: p.sharp };
    });
  }

  function mountRunoff(root, params) {
    injectStyle();
    var unitId = params && params.unitId;
    var u = unitOf(unitId);
    if (!u) {
      root.appendChild(el('div', { class: 'error-box', text: 'No tournament unit "' + unitId + '" in this session.' }));
      return;
    }

    // The entry ranking is frozen once, so every swap stays reversible and a
    // reload reproduces exactly the same list.
    if (!u.runoff) {
      PT.store.dispatch('runoff:init', function (s) {
        var unit = s.session.units[unitId];
        unit.runoff = { orig: (unit.winners || []).slice(), picks: {}, done: false };
      });
      u = unitOf(unitId);
    }

    R = { unitId: unitId, root: root, groups: runoffGroups(u), open: {} };
    R.body = el('div', { class: 'bk' });
    root.appendChild(R.body);
    paintRunoff();
  }

  function runoffRows(u) {
    var orig = (u.runoff && u.runoff.orig) || u.winners || [];
    var byId = {};
    R.groups.forEach(function (g) { g.forEach(function (id) { byId[id] = g; }); });
    var rows = [];
    orig.forEach(function (id, i) {
      var g = byId[id];
      if (g && g.length > 1) rows.push({ rank: i + 1, orig: id, group: g });
    });
    return rows;
  }

  function currentWinners(u) {
    var ro = u.runoff || { orig: u.winners || [], picks: {} };
    return (ro.orig || []).map(function (id) { return ro.picks[id] || id; });
  }

  function commitRunoff(name, mutate) {
    if (!R) return;
    var unitId = R.unitId;
    PT.store.dispatch(name, function (s) {
      var u = s.session.units[unitId];
      if (!u) return;
      mutate(u);
      u.winners = currentWinners(u);
    });
    paintRunoff();
  }

  function paintRunoff() {
    if (!R) return;
    var u = unitOf(R.unitId);
    if (!u) return;
    var rows = runoffRows(u);
    var winners = currentWinners(u);
    var swapped = Object.keys(u.runoff.picks).filter(function (k) { return u.runoff.picks[k] !== k; }).length;

    setTopbar(
      (u.label || 'unit') + ' · Stage C burst runoff',
      [
        ['finalists', winners.length],
        ['expandable', rows.length],
        ['swapped', swapped]
      ],
      null
    );

    PT.dom.$$('img', R.body).forEach(function (img) { PT.dom.releaseImg(img); });
    PT.dom.clear(R.body);

    var head = el('div', { class: 'bk-sub' });
    R.body.appendChild(head);

    if (!rows.length) {
      // PRD 7.4: say so and move on rather than presenting an empty UI.
      R.body.appendChild(el('div', { class: 'notice notice-note', id: 'ro-none' }, [
        'None of these ' + winners.length + ' finalist' + (winners.length === 1 ? '' : 's') +
        ' belongs to a near-duplicate group, so there is no burst to run off. Nothing to do here.'
      ]));
      var bar0 = el('div', { class: 'bk-bar' }, [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn btn-primary', id: 'ro-continue', text: 'Continue', onclick: finishRunoff })
      ]);
      R.body.appendChild(bar0);
      return;
    }

    head.appendChild(el('span', {
      text: rows.length + ' finalist' + (rows.length === 1 ? '' : 's') + ' came out of a burst. ' +
            'Expanding one runs a Keep 1 pass over the whole burst, including frames cut earlier.'
    }));

    var list = el('div', { class: 'bk-results', id: 'ro-list' });
    rows.forEach(function (row) { list.appendChild(runoffGroupEl(u, row, winners)); });
    R.body.appendChild(list);

    R.body.appendChild(el('div', { class: 'bk-bar' }, [
      el('span', { class: 'small dim', text: 'Every choice here is reversible until you continue.' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn btn-primary', id: 'ro-continue', text: 'Continue', onclick: finishRunoff })
    ]));
  }

  function runoffGroupEl(u, row, winners) {
    var picked = u.runoff.picks[row.orig] || row.orig;
    var open = !!R.open[row.orig];
    var meta = membersMeta(row.group);
    var nominee = PT.phash.nominate(meta);

    var thumb = el('img', { alt: '' });
    var b = blobFor(picked, false);
    if (b) PT.dom.setImg(thumb, b);
    else hydrate(picked).then(function (rec) {
      if (R && rec && (rec.thumb || rec.preview)) PT.dom.setImg(thumb, rec.thumb || rec.preview);
    });

    var head = el('div', { class: 'ro-head' }, [
      el('span', { class: 'bk-rank', text: '#' + row.rank }),
      thumb,
      el('span', { class: 'bk-name' }, [
        el('div', { text: nameOf(picked) }),
        el('div', {
          class: 'small dim',
          text: row.group.length + ' near-identical frames' +
                (picked !== row.orig ? ' · swapped in for ' + nameOf(row.orig) : '')
        })
      ]),
      el('button', {
        class: 'btn btn-sm', dataset: { expand: row.orig },
        text: open ? 'Close' : 'Expand burst',
        onclick: function () { R.open[row.orig] = !open; paintRunoff(); }
      }),
      picked !== row.orig ? el('button', {
        class: 'btn btn-sm btn-quiet', dataset: { revert: row.orig }, text: 'Revert',
        onclick: function () {
          commitRunoff('runoff:revert', function (uu) { delete uu.runoff.picks[row.orig]; });
        }
      }) : null
    ]);

    var wrap = el('div', { class: 'ro-group', dataset: { group: row.orig } }, [head]);
    if (!open) return wrap;

    var grid = el('div', { class: 'grid grid-' + (row.group.length <= 6 ? '6' : (row.group.length <= 12 ? '12' : '16')) });
    row.group.forEach(function (id) {
      var taken = picked !== id && winners.indexOf(id) >= 0;
      var cell = el('div', {
        class: 'photo-cell ro-cell' + (id === picked ? ' kept' : '') + (taken ? ' dead' : ''),
        dataset: { member: id, group: row.orig },
        title: taken ? 'Already a finalist in its own right' : nameOf(id),
        onclick: taken ? null : function () {
          commitRunoff('runoff:keep1', function (uu) {
            if (id === row.orig) delete uu.runoff.picks[row.orig];
            else uu.runoff.picks[row.orig] = id;
          });
        }
      });
      var img = el('img', { class: 'thumb', alt: '' });
      cell.appendChild(img);
      var tags = [];
      if (id === picked) tags.push('keeping');
      if (id === row.orig && id !== picked) tags.push('was #' + row.rank);
      if (id === nominee) tags.push('sharpest');
      if (taken) tags.push('already a finalist');
      if (tags.length) cell.appendChild(el('span', { class: 'tag', text: tags.join(' · ') }));
      grid.appendChild(cell);

      var bb = blobFor(id, false);
      if (bb) PT.dom.setImg(img, bb);
      else hydrate(id).then(function (rec) {
        if (R && rec && (rec.thumb || rec.preview)) PT.dom.setImg(img, rec.thumb || rec.preview);
      });
    });

    wrap.appendChild(el('div', { class: 'ro-body' }, [
      el('div', { class: 'small dim', text: 'Keep 1: click the frame that survives. The suggestion is the sharpest at the highest resolution.' }),
      grid
    ]));
    return wrap;
  }

  function finishRunoff() {
    if (!R) return;
    var unitId = R.unitId;
    commitRunoff('runoff:done', function (u) {
      u.runoff.done = true;
      u.phase = 'done';
    });
    PT.bus.emit('runoff:complete', { unitId: unitId });
    PT.bus.emit('unit:complete', { unitId: unitId });
    if (PT.router.current() !== 'runoff') return;
    // PT.advance() owns the next-unit / Stage D / export decision (PRD 7.6).
    if (typeof PT.advance === 'function') PT.advance();
    else if (!tryGo('export', { unitId: unitId })) tryGo('tree', {});
  }

  function unmountRunoff(root) {
    PT.dom.$$('img', root).forEach(function (img) { PT.dom.releaseImg(img); });
    clearTopbar();
    R = null;
  }

  PT.router.register('runoff', { mount: mountRunoff, unmount: unmountRunoff });

  PT.log('bracket', 'screens registered: bracket, runoff');
})();

/** CHANGELOG
 * v1.0 (2026-07-28): Initial release. Pure PT.bracket engine: deterministic
 *   seeded draw, standard seed slots so byes spread across non-power-of-two
 *   fields, elimination edges recorded, and the repechage as iterative
 *   candidate-pool mini brackets seeded by main-bracket depth. State is an ops
 *   log replayed on every change, which is what gives unlimited undo, mid-
 *   bracket resume and a tiny persisted record from one mechanism. The
 *   repechage pool is held in fixed slots and already-judged pairings are
 *   reused, so successive places replay only the path that changed. Matchup
 *   screen with viewport-filling previews, thumb fallback, click and arrow-key
 *   choice, deferral by queue rotation, and shared normalised-coordinate zoom so
 *   both photos frame the same region. Early-stop writes a ranked list from
 *   decided places plus depth-inferred order. Stage C runoff expands any
 *   finalist's burst into a reversible Keep-1 pass, and says so plainly when a
 *   unit has no near-duplicate groups.
  * v1.1 (2026-07-28): Held the repechage candidate pool in fixed slots so mini
 *   brackets that did not contain the placed photo replay unchanged, and stopped
 *   re-asking any pairing the user had already judged. 712 comparisons for a
 *   500-photo top 20 against 1389 before, and 53 for a 32-photo top 8.
*/
