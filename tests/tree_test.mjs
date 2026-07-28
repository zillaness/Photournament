/**
 * file: tree_test.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Tests for the PRD section 4 allocation math, including the worked example in 4.3 and every edge case listed in 4.5.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Run: node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 30_tree.js is a browser classic script attaching to window. Give it a window.
// Evaluated with new Function rather than node:vm deliberately: a vm context has
// its own realm, so objects it returns have a different Object.prototype and every
// deepStrictEqual would fail on prototype identity alone.
const win = {};
new Function('window', readFileSync(new URL('../src/js/30_tree.js', import.meta.url), 'utf8'))(win);
const T = win.PT.tree;

/** Build n photo records in a folder. */
function photos(dir, n, prefix = 'IMG') {
  return Array.from({ length: n }, (_, i) => ({
    id: `${dir}/${prefix}_${i}`,
    dir,
    path: `${dir}/${prefix}_${i}.jpg`
  }));
}

function allocs(map) {
  const out = {};
  for (const [path, raw] of Object.entries(map)) out[path] = T.parseAlloc(raw);
  return out;
}

/* ------------------------------------------------------------- parseAlloc */

test('parseAlloc covers all four states, and 0 is excluded not unlimited', () => {
  assert.deepEqual(T.parseAlloc('5'), { mode: 'fixed', value: 5 });
  assert.deepEqual(T.parseAlloc('0'), { mode: 'excluded', value: 0 });
  assert.deepEqual(T.parseAlloc(''), { mode: 'pooled', value: null });
  assert.deepEqual(T.parseAlloc(null), { mode: 'pooled', value: null });
  assert.deepEqual(T.parseAlloc('*'), { mode: 'uncapped', value: null });
  assert.deepEqual(T.parseAlloc('∞'), { mode: 'uncapped', value: null });
  // Both uncapped entry paths of PRD 4.2 land on the same state.
  assert.deepEqual(T.parseAlloc('*'), T.parseAlloc('inf'));
  // Garbage is rejected rather than silently coerced.
  assert.equal(T.parseAlloc('abc'), null);
  assert.equal(T.parseAlloc('-3'), null);
  assert.equal(T.parseAlloc('2.5'), null);
});

/* ------------------------------------------------------------- percentages */

test('a percentage is parsed as its own state, not coerced to a count', () => {
  assert.deepEqual(T.parseAlloc('5%'), { mode: 'percent', value: 5 });
  assert.deepEqual(T.parseAlloc('12.5%'), { mode: 'percent', value: 12.5 });
  assert.deepEqual(T.parseAlloc('100%'), { mode: 'percent', value: 100 });
  // Whitespace before the sign is how people actually type it.
  assert.deepEqual(T.parseAlloc('5 %'), { mode: 'percent', value: 5 });
  // The bug this fixes: "5%" used to fail the digits-only test, the field kept
  // the last value it HAD accepted, and the row silently meant "keep 5".
  assert.notDeepEqual(T.parseAlloc('5%'), T.parseAlloc('5'));
  // A share of nothing is nothing, which is the same statement as 0.
  assert.deepEqual(T.parseAlloc('0%'), { mode: 'excluded', value: 0 });
  // No reading of "keep 150% of this folder" is what the user meant.
  assert.equal(T.parseAlloc('101%'), null);
  assert.equal(T.parseAlloc('%'), null);
  assert.equal(T.parseAlloc('5%%'), null);
});

test('a percentage round-trips through the field it was typed into', () => {
  for (const raw of ['5%', '12.5%', '100%', '7', '0', '*', '']) {
    assert.equal(T.allocToInput(T.parseAlloc(raw)), raw);
  }
  // Normalised on the way back in, not preserved character for character.
  assert.equal(T.allocToInput(T.parseAlloc('5 %')), '5%');
});

test('percentToCount rounds to nearest but never silently to zero', () => {
  assert.equal(T.percentToCount(5, 746), 37);
  assert.equal(T.percentToCount(50, 7), 4);      // 3.5 rounds up
  assert.equal(T.percentToCount(100, 9), 9);
  // 5% of 12 is 0.6. Rounding that to 0 would exclude the folder, and exclusion
  // is a thing the user has to ask for by name.
  assert.equal(T.percentToCount(5, 12), 1);
  assert.equal(T.percentToCount(1, 3), 1);
  // Nothing to take a share of.
  assert.equal(T.percentToCount(5, 0), 0);
});

test('a percentage resolves against the folder’s own count', () => {
  const tree = T.build([...photos('Trip/Day1', 200), ...photos('Trip/Day2', 50)]);
  const res = T.resolve(tree, allocs({ 'Trip/Day1': '10%', 'Trip/Day2': '10%' }));

  // Same percentage, different folders, different counts — which is the point.
  assert.equal(res.nodes['Trip/Day1'].target, 20);
  assert.equal(res.nodes['Trip/Day2'].target, 5);
  assert.equal(res.projectedTotal, 25);
  assert.equal(res.hasErrors, false);
});

test('a percentage keeps what the user typed and reports what it came to', () => {
  const tree = T.build(photos('Trip/Day1', 40));
  const n = T.resolve(tree, allocs({ 'Trip/Day1': '25%' })).nodes['Trip/Day1'];

  // The field has to render "25%" back, so the typed state survives resolution.
  assert.deepEqual(n.alloc, { mode: 'percent', value: 25 });
  assert.equal(T.allocToInput(n.alloc), '25%');
  // And everything downstream sees a plain fixed count.
  assert.deepEqual(n.eff, { mode: 'fixed', value: 10 });
  assert.equal(n.percentCount, 10);
  assert.equal(n.target, 10);
});

test('a percentage behaves as a fixed count everywhere the rules look at one', () => {
  const tree = T.build([
    ...photos('Trip/Day1', 100),
    ...photos('Trip/Day2', 100),
    ...photos('Trip/Day3', 100)
  ]);

  // Under a fixed parent, a percentage child consumes the pool like any number:
  // 10% of 100 is 10, leaving 30 - 10 = 20 for the two pooled siblings.
  const res = T.resolve(tree, allocs({ 'Trip': '30', 'Trip/Day1': '10%' }));
  assert.equal(res.nodes['Trip/Day1'].target, 10);

  const pooled = res.units.find((u) => u.kind === 'pooled');
  assert.equal(pooled.target, 20);
  assert.deepEqual(pooled.memberPaths.sort(), ['Trip/Day2', 'Trip/Day3']);
  assert.equal(res.projectedTotal, 30);
  assert.equal(res.hasErrors, false);
});

test('percentage children can oversubscribe a fixed parent, and it is caught', () => {
  const tree = T.build([...photos('Trip/Day1', 100), ...photos('Trip/Day2', 100)]);
  // 60% + 60% of 100 each = 120, against a parent that only has 50 places.
  const res = T.resolve(tree, allocs({ 'Trip': '50', 'Trip/Day1': '60%', 'Trip/Day2': '60%' }));
  assert.equal(res.hasErrors, true);
  assert.ok(res.issues.some((i) => i.code === 'oversubscribed'));
});

test('a percentage counts as an allocation for dead-pool detection', () => {
  const tree = T.build([...photos('Trip/Day1', 40), ...photos('Trip/Day2', 40)]);
  // Pooled under uncapped is normally a dead state, but Day1 asking for 25% is a
  // real allocation, so only the genuinely-blank sibling is flagged.
  const res = T.resolve(tree, allocs({ 'Trip': '*', 'Trip/Day1': '25%' }));
  const dead = res.issues.filter((i) => i.code === 'dead-pool').map((i) => i.path);
  assert.deepEqual(dead, ['Trip/Day2']);
  assert.equal(res.nodes['Trip/Day1'].target, 10);
});

test('100% keeps everything, and a percentage of an empty folder keeps nothing', () => {
  const tree = T.build(photos('Trip/Day1', 12));
  const full = T.resolve(tree, allocs({ 'Trip/Day1': '100%' }));
  assert.equal(full.nodes['Trip/Day1'].target, 12);
  assert.equal(full.nodes['Trip/Day1'].clamped, false);

  // An excluded sibling has no photos to take a share of, and must not warn
  // about being clamped to zero.
  const two = T.build([...photos('Trip/Day1', 12), ...photos('Trip/Day2', 6)]);
  const res = T.resolve(two, allocs({ 'Trip/Day1': '50%', 'Trip/Day2': '0' }));
  assert.equal(res.nodes['Trip/Day1'].target, 6);
  assert.equal(res.nodes['Trip/Day2'].excluded, true);
  assert.equal(res.issues.filter((i) => i.code === 'clamped').length, 0);
});

/* -------------------------------------------------- PRD 4.3 worked example */

test('PRD 4.3 worked example resolves exactly as documented', () => {
  const all = [
    ...photos('Trip/Day1', 80),
    ...photos('Trip/Day2', 120),
    ...photos('Trip/Day3', 150),
    ...photos('Trip/Day4', 90),
    ...photos('Trip/Misc', 40)
  ];
  const tree = T.build(all);
  const a = allocs({
    'Trip': '20',
    'Trip/Day1': '5',
    'Trip/Day2': '5',
    'Trip/Day3': '',
    'Trip/Day4': '0',
    'Trip/Misc': ''
  });
  const r = T.resolve(tree, a);

  assert.equal(r.hasErrors, false, 'the documented example must be valid');

  // Day4 excluded: skipped everywhere and not counted in totals (PRD 4.5).
  assert.equal(r.nodes['Trip/Day4'].excluded, true);
  assert.equal(r.nodes['Trip/Day4'].subtreeCount, 0);
  assert.equal(r.nodes['Trip'].subtreeCount, 80 + 120 + 150 + 40);

  // Day1 and Day2 are guaranteed 5 each.
  assert.equal(r.nodes['Trip/Day1'].target, 5);
  assert.equal(r.nodes['Trip/Day2'].target, 5);

  // 10 remaining, pooled across Day3 + Misc as ONE unit.
  const pooled = r.units.filter((u) => u.kind === 'pooled');
  assert.equal(pooled.length, 1);
  assert.equal(pooled[0].target, 10, '20 - 5 - 5 = 10');
  assert.deepEqual(pooled[0].memberPaths.sort(), ['Trip/Day3', 'Trip/Misc']);
  assert.equal(pooled[0].photoIds.length, 190, 'the pool competes over Day3 + Misc photos');
  assert.equal(
    pooled[0].photoIds.some((id) => id.startsWith('Trip/Day4')), false,
    'excluded photos must never enter a tournament'
  );

  // Three units total: two fixed leaves and one pool.
  assert.equal(r.units.length, 3);
  assert.equal(r.projectedTotal, 20);
});

test('all children fixed is pure chronological representation', () => {
  const tree = T.build([...photos('T/A', 50), ...photos('T/B', 50)]);
  const r = T.resolve(tree, allocs({ 'T': '10', 'T/A': '5', 'T/B': '5' }));
  assert.equal(r.hasErrors, false);
  assert.equal(r.units.length, 2);
  assert.equal(r.projectedTotal, 10);
  assert.equal(r.units.every((u) => u.kind === 'fixed'), true);
});

test('all children pooled is one tournament across everything', () => {
  const tree = T.build([...photos('T/A', 50), ...photos('T/B', 50), ...photos('T/C', 50)]);
  const r = T.resolve(tree, allocs({ 'T': '10', 'T/A': '', 'T/B': '', 'T/C': '' }));
  assert.equal(r.hasErrors, false);
  assert.equal(r.units.length, 1);
  assert.equal(r.units[0].kind, 'pooled');
  assert.equal(r.units[0].target, 10);
  assert.equal(r.units[0].photoIds.length, 150);
});

/* ------------------------------------------------------ PRD 4.5 edge cases */

test('children summing above a fixed parent is an error that names the sum', () => {
  const tree = T.build([...photos('T/A', 50), ...photos('T/B', 50)]);
  const r = T.resolve(tree, allocs({ 'T': '10', 'T/A': '8', 'T/B': '7' }));
  assert.equal(r.hasErrors, true);
  const e = r.issues.find((i) => i.code === 'oversubscribed');
  assert.ok(e, 'must flag oversubscription');
  assert.match(e.message, /15/, 'the offending sum must be shown');
  assert.match(e.message, /uncapped/, 'switching the parent to uncapped is the offered resolution');
});

test('a fixed count above the folder photo count clamps and flags', () => {
  const tree = T.build(photos('T/A', 3));
  const r = T.resolve(tree, allocs({ 'T': '*', 'T/A': '10' }));
  assert.equal(r.nodes['T/A'].target, 3);
  assert.equal(r.nodes['T/A'].clamped, true);
  assert.ok(r.issues.find((i) => i.code === 'clamped'));
});

test('pooled children under an uncapped parent are a dead state', () => {
  const tree = T.build([...photos('T/A', 50), ...photos('T/B', 50)]);
  const r = T.resolve(tree, allocs({ 'T': '*', 'T/A': '5', 'T/B': '' }));
  assert.equal(r.hasErrors, true);
  const dead = r.issues.find((i) => i.code === 'dead-pool');
  assert.ok(dead, 'must flag the dead state');
  assert.equal(dead.path, 'T/B');
  assert.match(dead.message, /no remainder/i);
});

test('every child fixed under a fixed parent leaves an unused remainder, stated plainly', () => {
  const tree = T.build([...photos('T/A', 50), ...photos('T/B', 50)]);
  const r = T.resolve(tree, allocs({ 'T': '20', 'T/A': '5', 'T/B': '5' }));
  assert.equal(r.hasErrors, false, 'this is a note, not an error');
  const n = r.issues.find((i) => i.code === 'unused-remainder');
  assert.ok(n);
  assert.equal(n.level, 'note');
  assert.match(n.message, /10/, 'the unused count must be named');
});

test('excluded subtrees are skipped everywhere, including nested children', () => {
  const tree = T.build([...photos('T/A/x', 10), ...photos('T/A/y', 10), ...photos('T/B', 10)]);
  const r = T.resolve(tree, allocs({ 'T': '5', 'T/A': '0', 'T/B': '' }));
  assert.equal(r.nodes['T/A/x'].excluded, true, 'exclusion inherits down the subtree');
  assert.equal(r.nodes['T/A/y'].excluded, true);
  assert.equal(r.nodes['T'].subtreeCount, 10, 'excluded photos are not counted in totals');
  const ids = r.units.flatMap((u) => u.photoIds);
  assert.equal(ids.some((id) => id.startsWith('T/A')), false);
});

test('an uncapped parent floats its total to the sum of its children', () => {
  const tree = T.build([...photos('T/A', 50), ...photos('T/B', 50)]);
  const r = T.resolve(tree, allocs({ 'T': '*', 'T/A': '5', 'T/B': '7' }));
  assert.equal(r.hasErrors, false);
  assert.equal(r.nodes['T'].uncapped, true);
  assert.equal(r.nodes['T'].target, null, 'an uncapped parent has no target of its own');
  assert.equal(r.projectedTotal, 12, 'the total is computed from the children');
});

test('an uncapped leaf produces a unit with no target', () => {
  const tree = T.build(photos('T/A', 50));
  const r = T.resolve(tree, allocs({ 'T': '*', 'T/A': '*' }));
  assert.equal(r.units.length, 1);
  assert.equal(r.units[0].kind, 'uncapped');
  assert.equal(r.units[0].target, null);
  assert.equal(r.projectedTotal, null, 'no target means no projected total');
});

test('an uncapped child under a fixed parent is an error', () => {
  const tree = T.build([...photos('T/A', 50), ...photos('T/B', 50)]);
  const r = T.resolve(tree, allocs({ 'T': '10', 'T/A': '*', 'T/B': '5' }));
  assert.equal(r.hasErrors, true);
  assert.ok(r.issues.find((i) => i.code === 'uncapped-under-fixed'));
});

test('a pool holding fewer photos than the open remainder is clamped and warned', () => {
  const tree = T.build([...photos('T/A', 50), ...photos('T/B', 3)]);
  const r = T.resolve(tree, allocs({ 'T': '20', 'T/A': '5', 'T/B': '' }));
  const u = r.units.find((x) => x.kind === 'pooled');
  assert.equal(u.target, 3, 'only 3 photos exist so only 3 can survive');
  assert.ok(r.issues.find((i) => i.code === 'pool-clamped'));
});

test('fixed siblings consuming every place leave pooled siblings with nothing', () => {
  const tree = T.build([...photos('T/A', 50), ...photos('T/B', 50)]);
  const r = T.resolve(tree, allocs({ 'T': '5', 'T/A': '5', 'T/B': '' }));
  assert.equal(r.units.filter((u) => u.kind === 'pooled').length, 0);
  assert.ok(r.issues.find((i) => i.code === 'no-remainder'));
});

/* --------------------------------------------------- PRD 4.6 / 4.1 shapes */

test('PRD 4.6 single folder is one node, one state, one tournament', () => {
  const tree = T.build(photos('Shoot', 200));
  const r = T.resolve(tree, allocs({ 'Shoot': '10' }));
  assert.equal(r.hasErrors, false);
  assert.equal(r.units.length, 1);
  assert.equal(r.units[0].target, 10);
  assert.equal(r.units[0].photoIds.length, 200);
});

test('the tree mirrors source structure at arbitrary depth (PRD 4.1, no depth cap)', () => {
  const tree = T.build(photos('a/b/c/d/e/f', 12));
  assert.ok(tree.nodes['a/b/c/d/e/f'], 'six levels deep must exist');
  // Only the root and the leaf are allocated. Every folder between them is blank,
  // and must be treated as a pass-through container rather than a dead pool.
  const r = T.resolve(tree, allocs({ 'a': '*', 'a/b/c/d/e/f': '3' }));
  assert.equal(r.hasErrors, false, 'blank intermediate folders are not an error');
  assert.equal(r.issues.filter((i) => i.code === 'dead-pool').length, 0);
  assert.equal(r.units.length, 1);
  assert.equal(r.units[0].target, 3);
});

test('a blank folder under an uncapped parent IS dead when nothing below it is allocated', () => {
  const tree = T.build([...photos('T/A/deep', 10), ...photos('T/B', 10)]);
  const r = T.resolve(tree, allocs({ 'T': '*', 'T/B': '5' }));
  const dead = r.issues.filter((i) => i.code === 'dead-pool');
  assert.equal(dead.length, 1, 'T/A has no allocated descendant, so it is genuinely dead');
  assert.equal(dead[0].path, 'T/A');
});

test('loose photos beside subfolders become their own competing node', () => {
  const tree = T.build([...photos('T', 10, 'LOOSE'), ...photos('T/A', 10)]);
  const loose = 'T/' + T.LOOSE;
  assert.ok(tree.nodes[loose], 'loose files get a synthetic node');
  assert.equal(tree.nodes['T'].photoIds.length, 0, 'they move off the parent');
  assert.equal(tree.nodes[loose].photoIds.length, 10);

  const r = T.resolve(tree, allocs({ 'T': '6', 'T/A': '4', [loose]: '' }));
  assert.equal(r.hasErrors, false);
  const pool = r.units.find((u) => u.kind === 'pooled');
  assert.equal(pool.target, 2, 'loose files compete for the parent remainder');
  assert.deepEqual(pool.memberPaths, [loose]);
});

/* ------------------------------------------------------------- distribute */

test('weighted distribution splits by photo count and sums exactly to the total', () => {
  const tree = T.build([...photos('T/A', 80), ...photos('T/B', 120), ...photos('T/C', 200)]);
  const r = T.resolve(tree, allocs({ 'T': '*', 'T/A': '', 'T/B': '', 'T/C': '' }));
  const d = T.distribute(tree, r, 'T', 20, 'weighted');
  const sum = Object.values(d).reduce((a, b) => a + b, 0);
  assert.equal(sum, 20, 'largest-remainder apportionment must not drift');
  assert.ok(d['T/C'] > d['T/B'] && d['T/B'] > d['T/A'], 'bigger folders get more');
});

test('even distribution ignores photo count and still sums exactly', () => {
  const tree = T.build([...photos('T/A', 80), ...photos('T/B', 120), ...photos('T/C', 200)]);
  const r = T.resolve(tree, allocs({ 'T': '*' }));
  const d = T.distribute(tree, r, 'T', 9, 'even');
  assert.deepEqual(Object.values(d).sort(), [3, 3, 3]);
});

test('distribution never suggests more finalists than a folder holds', () => {
  const tree = T.build([...photos('T/A', 2), ...photos('T/B', 500)]);
  const r = T.resolve(tree, allocs({ 'T': '*' }));
  const d = T.distribute(tree, r, 'T', 20, 'even');
  assert.ok(d['T/A'] <= 2, 'a 2-photo folder cannot yield 10 finalists');
  assert.equal(Object.values(d).reduce((a, b) => a + b, 0), 20, 'the excess moves to B');
});

test('distribution skips excluded children entirely', () => {
  const tree = T.build([...photos('T/A', 50), ...photos('T/B', 50)]);
  const r = T.resolve(tree, allocs({ 'T': '*', 'T/A': '0' }));
  const d = T.distribute(tree, r, 'T', 10, 'weighted');
  assert.equal(d['T/A'], undefined, 'an excluded folder gets no suggestion');
  assert.equal(d['T/B'], 10);
});

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Covers parseAlloc, the PRD 4.3 worked
 *   example, every PRD 4.5 edge case, arbitrary depth, single-folder use,
 *   loose-file nodes, and both distribution modes.
 */
