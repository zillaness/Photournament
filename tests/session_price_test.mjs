/**
 * file: session_price_test.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-30
 * last_updated: 2026-07-30
 * description: Tests for the ranking price model and the Stage A schedule projection in 35_session.js, anchored to comparison counts measured on the real bracket engine and to the worked 742-photo case in docs/research_faster_culling_v1.0.md.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Run: node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 35_session.js is a browser classic script attaching to window. Same loading
// pattern as tree_test.mjs, same reason for new Function over node:vm.
const win = {};
new Function('window', readFileSync(new URL('../src/js/35_session.js', import.meta.url), 'utf8'))(win);
const S = win.PT.session;

/* --------------------------------------------------------------- rankPrice */

// Measured on the real engine at HEAD: perfect simulated judge, 3 seeds per
// point, averaged. The model is a fit, so the assertion is a tolerance, not
// equality — and the tolerance doubles as a drift alarm: if the engine's cost
// profile ever changes materially, this is the test that notices.
const MEASURED = [
  [30, 1, 29], [30, 5, 45], [30, 10, 67], [30, 30, 116],
  [60, 1, 59], [60, 5, 84], [60, 10, 110], [60, 20, 161], [60, 60, 290],
  [100, 10, 158], [100, 16, 195], [100, 100, 556],
  [200, 16, 324], [742, 16, 920]
];

test('rankPrice lands within 10% of the measured engine at every point', () => {
  for (const [n, depth, measured] of MEASURED) {
    const priced = S.rankPrice(n, depth);
    const err = Math.abs(priced - measured) / measured;
    assert.ok(err <= 0.10,
      `n=${n} depth=${depth}: priced ${priced} vs measured ${measured} (${Math.round(err * 100)}% off)`);
  }
});

test('rankPrice: full order is far below the textbook count', () => {
  // Repechage answer-reuse is why ranking mode is affordable; the textbook
  // (n-1)+(t-1)log2(n) would say 171 for a full order of 30, the engine needs
  // ~116. The model must reflect the engine, not the textbook.
  assert.ok(S.rankPrice(30, 30) < 130);
  assert.ok(S.rankPrice(100, 100) < 600);
});

test('rankPrice edges: tiny fields, clamped depth, null depth', () => {
  assert.equal(S.rankPrice(0, 5), 0);
  assert.equal(S.rankPrice(1, 1), 0);           // one photo, nothing to compare
  assert.equal(S.rankPrice(2, 1), 1);
  assert.equal(S.rankPrice(30, 99), S.rankPrice(30, 30));  // depth clamps to n
  assert.equal(S.rankPrice(30, null), S.rankPrice(30, 30)); // null means full
  assert.ok(S.rankPrice(30, 1) === 29);          // winner only is exactly n-1
});

/* --------------------------------------------------------- projectSchedule */

test('projectSchedule reproduces the worked 742-photo case', () => {
  // docs/research_faster_culling_v1.0.md section 1: 742 photos, target 16,
  // 9-up keep-half, worst case: passes of 83/37/17/8 screens = 145, handing
  // off a field of 29.
  const p = S.projectSchedule(742, S.DEFAULTS, 16);
  assert.equal(p.passes.length, 4);
  assert.deepEqual(p.passes.map((x) => x.screens), [83, 37, 17, 8]);
  assert.equal(p.screens, 145);
  assert.equal(p.handoffField, 29);
  assert.ok(p.seconds > 0);
});

test('projectSchedule stops at the handoff point, not at the target', () => {
  // 40 photos against a target of 16: already inside 3x target, so no passes
  // at all — culling from here is just the bracket.
  const p = S.projectSchedule(40, S.DEFAULTS, 16);
  assert.equal(p.passes.length, 0);
  assert.equal(p.handoffField, 40);
});

test('projectSchedule refuses the cases that have no projection', () => {
  assert.equal(S.projectSchedule(100, S.DEFAULTS, null), null);  // uncapped
  assert.equal(S.projectSchedule(1, S.DEFAULTS, 1), null);       // nothing to cull
  // Unlimited quota makes no progress; the projection stops rather than looping.
  const unlimited = Object.assign({}, S.DEFAULTS, { quotaMode: 'unlimited' });
  const p = S.projectSchedule(100, unlimited, 5);
  assert.equal(p.passes.length, 0);
});

/* ------------------------------------------------------------ unit fields */

test('newUnit carries rank intent and starts with no depth', () => {
  const u = S.newUnit({ id: 'x', kind: 'fixed', label: 'x', target: 5, photoIds: ['a'], rank: true });
  assert.equal(u.rank, true);
  assert.equal(u.rankDepth, null);
  const v = S.newUnit({ id: 'y', kind: 'fixed', label: 'y', target: 5, photoIds: ['a'] });
  assert.equal(v.rank, false);
});

/* CHANGELOG
 * v1.0 (2026-07-30): Initial release. Anchors rankPrice to fourteen engine-
 *   measured points at 10% tolerance, checks the full-order discount that makes
 *   ranking affordable, and pins projectSchedule to the research doc's worked
 *   742-photo schedule.
 */
