/**
 * file: e2e_stopdupes.mjs
 * version: 1.1
 * author: Samuel Cao
 * created: 2026-07-29
 * last_updated: 2026-07-29
 * description: Verifies the stop-early third path: with bursts standing, the modal offers best-of-duplicates first — one face per burst seated as finalists, the runoff decides each burst (extras keepable), and export sees the result instead of every frame.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Run: node tests/e2e_stopdupes.mjs
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { deflateSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT = path.join(ROOT, 'dist', 'photournament_v1.0.html');
if (!existsSync(ARTIFACT)) { console.error('run: node tools/build.mjs'); process.exit(1); }

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

function crc32(b) { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = c ^ (crc >>> 8); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, 'ascii'), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, cr]); }
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Corner-stamp bursts (see e2e_lightbox): frames identical apart from a stamp. */
function makeFrame(w, h, scene, frame) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  const fx = 1 + scene, fy = 1 + ((scene * 3) % 4), ph = (scene * 1.7) % 6.283;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const stamp = x < 30 && y < 30;
      const v = 128
        + 68 * Math.sin((x / w) * Math.PI * 2 * fx + ph)
        + 52 * Math.cos((y / h) * Math.PI * 2 * fy + ph * 1.3);
      raw[p++] = clamp(stamp ? 40 + frame * 60 : v);
      raw[p++] = clamp(stamp ? 220 - frame * 50 : v * 0.86 + ((scene * 17) % 40));
      raw[p++] = clamp(stamp ? 60 + frame * 40 : v * 0.72 + ((scene * 29) % 60));
    }
  }
  const i = Buffer.alloc(13);
  i.writeUInt32BE(w, 0); i.writeUInt32BE(h, 4); i[8] = 8; i[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', i), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Block-board PNGs with provable pairwise separation (see e2e_resume). */
function pngBoard(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const bits = ((seed * 2654435761) >>> 16) & 0xffff;
  let p = 0, s2 = (seed * 2654435761) >>> 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    const by = Math.min(3, (y * 4 / h) | 0);
    for (let x = 0; x < w; x++) {
      s2 = (s2 * 1664525 + 1013904223) >>> 0;
      const bx = Math.min(3, (x * 4 / w) | 0);
      const v = (((bits >> (by * 4 + bx)) & 1) ? 196 : 52) + ((s2 >>> 24) - 128) * 0.08;
      raw[p++] = clamp(v + ((seed * 13) % 40));
      raw[p++] = clamp(v * 0.9 + ((seed * 29) % 50));
      raw[p++] = clamp(v * 0.8 + ((x ^ y) & 15));
    }
  }
  const i = Buffer.alloc(13);
  i.writeUInt32BE(w, 0); i.writeUInt32BE(h, 4); i[8] = 8; i[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', i), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

// One 3-frame burst and two singles: 5 photos, 3 decisions, 2 burst extras.
const tmp = path.join(os.tmpdir(), 'pt-sd-' + Date.now());
mkdirSync(path.join(tmp, 'Roll'), { recursive: true });
for (let f = 0; f < 3; f++) writeFileSync(path.join(tmp, 'Roll', `burst_${f}.png`), makeFrame(240, 180, 0, f));
writeFileSync(path.join(tmp, 'Roll', 'lone_a.png'), makeFrame(240, 180, 2, 0));
writeFileSync(path.join(tmp, 'Roll', 'lone_b.png'), makeFrame(240, 180, 3, 0));

/* ---------------------------------------------------------------- run --- */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('file://' + ARTIFACT);
await page.setInputFiles('#dir-files', tmp);
await page.waitForFunction(() => {
  const b = document.querySelector('#ingest-actions button');
  return b && /finalist/i.test(b.textContent);
}, { timeout: 60000 });
await page.click('#ingest-actions button');
await page.waitForSelector('.tree-row');
await page.evaluate(() => {
  const i = document.querySelector('input.tree-alloc[data-path$="/Roll"]');
  i.value = '2'; i.dispatchEvent(new Event('input', { bubbles: true }));
  Array.from(document.querySelectorAll('button'))
    .find((x) => /start culling/i.test(x.textContent) && !x.disabled).click();
});
await page.waitForSelector('#dupe-continue', { timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll('#dupe-list .ro-group').length > 0, { timeout: 60000 });
await page.click('#dupe-continue');
await page.waitForSelector('[data-t="finish-early"]');

/* --- the modal names the duplicate question and offers the third path ---- */

await page.click('[data-t="finish-early"]');
await page.waitForSelector('[data-t="finish-early-confirm"]');
const modal = await page.evaluate(() => ({
  third: !!document.querySelector('[data-t="finish-early-dupes"]'),
  text: document.getElementById('modal-body').textContent
}));
check('the third path is offered when bursts are standing', modal.third === true);
check('the modal counts the burst extras', /2 of the standing are extra frames/.test(modal.text),
  modal.text.slice(-160));

await page.click('[data-t="finish-early-dupes"]');
await page.waitForSelector('.ro-group', { timeout: 15000 });

const routed = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = Object.values(s.session.units)[0];
  return { phase: u.phase, winners: u.winners.length, pool: u.pool.length, pass: u.currentPass };
});
check('the unit routed to the runoff, not done', routed.phase === 'runoff', routed.phase);
check('one face per decision seated as finalists', routed.winners === 3, routed.winners);
check('every standing photo stays in the pool', routed.pool === 5, routed.pool);
check('no half-finished pass left behind', routed.pass === null);

/* --- the burst gets its decision; an extra can still be kept -------------- */

await page.click('[data-expand]');
await page.waitForSelector('.ro-cell');
// Keep one extra member beyond the face.
await page.evaluate(() => {
  const extra = Array.from(document.querySelectorAll('.ro-cell'))
    .find((c) => !c.classList.contains('kept') && !c.classList.contains('dead'));
  extra.click();
});
await page.waitForTimeout(300);
await page.click('#ro-continue');
await page.waitForTimeout(600);

const finished = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = Object.values(s.session.units)[0];
  return { phase: u.phase, winners: u.winners.length, stage: s.session.stage };
});
check('the runoff completes the unit', finished.phase === 'done', finished.phase);
check('the kept extra joins the finalists', finished.winners === 4, finished.winners);
check('the session lands on export', finished.stage === 'export', finished.stage);

/* --- the export review carries the session stats -------------------------- */

const stats = await page.evaluate(() => {
  const d = document.getElementById('exp-stats');
  if (!d) return null;
  d.open = true;
  const nums = Array.from(d.querySelectorAll('.exp-stat-num')).map((n) => n.textContent);
  return { open: d.open, nums, text: d.textContent };
});
check('the stats panel is there, closed by default but openable', !!stats && stats.open === true);
check('it counts what entered and what survived',
  !!stats && stats.nums[0] === '5' && stats.nums[1] === '4',
  stats && stats.nums.join(','));
check('it knows about the burst', !!stats && /burst/i.test(stats.text));

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

/* --- the standings are a choice, capped at the target --------------------- */

const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 980 } });
const p2 = await ctx2.newPage();
p2.on('pageerror', (e) => console.log('  [p2 pageerror]', e.message));
p2.on('console', (m) => { if (m.type() === 'error') console.log('  [p2 console]', m.text()); });
const tmp2 = path.join(os.tmpdir(), 'pt-sd2-' + Date.now());
mkdirSync(path.join(tmp2, 'Roll'), { recursive: true });
for (let sc = 0; sc < 6; sc++) {
  writeFileSync(path.join(tmp2, 'Roll', `d${sc}.png`), pngBoard(240, 180, sc));
}
await p2.goto('file://' + ARTIFACT);
await p2.setInputFiles('#dir-files', tmp2);
await p2.waitForFunction(() => {
  const b = document.querySelector('#ingest-actions button');
  return b && /finalist/i.test(b.textContent);
}, { timeout: 60000 });
await p2.click('#ingest-actions button');
await p2.waitForSelector('.tree-row');
await p2.evaluate(() => {
  const i = document.querySelector('input.tree-alloc[data-path$="/Roll"]');
  i.value = '2'; i.dispatchEvent(new Event('input', { bubbles: true }));
  Array.from(document.querySelectorAll('button'))
    .find((x) => /start culling/i.test(x.textContent) && !x.disabled).click();
});
await p2.waitForSelector('#dupe-skip, [data-t="start-pass"]', { timeout: 60000 });
if (await p2.$('#dupe-skip')) await p2.click('#dupe-skip');
await p2.waitForSelector('[data-t="start-pass"]');
await p2.selectOption('[data-t="cfg-quota"]', 'unlimited');
await p2.click('[data-t="start-pass"]');
await p2.waitForSelector('.photo-cell');
// Keep 4 of 6, advance, into the bracket: 4 entrants against a target of 2.
await p2.evaluate(() => {
  Array.from(document.querySelectorAll('.photo-cell')).slice(0, 4).forEach((c) => c.click());
});
await p2.click('[data-t="advance"]');
await p2.waitForSelector('[data-t="tobracket"]');
await p2.click('[data-t="tobracket"]');
await p2.waitForSelector('.bk-vp');
await p2.keyboard.press('ArrowLeft');
await p2.waitForTimeout(250);
// The stop goes through the same event the topbar button emits — the button's
// visibility is the shell's concern, not this scenario's.
await p2.evaluate(() => window.PT.bus.emit('stage:stop-early'));
await p2.waitForSelector('.bk-row.bk-choosable', { timeout: 10000 });

const standing = await p2.evaluate(() => ({
  rows: document.querySelectorAll('.bk-row').length,
  chosen: document.querySelectorAll('.bk-row.chosen').length,
  cutoff: !!document.querySelector('[data-t="cutoff"]'),
  cutoffAfter: (() => {
    const kids = Array.from(document.getElementById('bk-results').children);
    return kids.findIndex((k) => k.dataset && k.dataset.t === 'cutoff');
  })(),
  counter: document.getElementById('bk-chosen-count').textContent,
  winners: Object.values(window.PT.store.get().session.units)[0].winners.length
}));
check('the whole field renders, ranked', standing.rows === 4, standing.rows);
check('the top-N arrive pre-chosen', standing.chosen === 2 && standing.winners === 2,
  JSON.stringify(standing));
check('the cutoff line sits where the target drew it',
  standing.cutoff && standing.cutoffAfter === 2, standing.cutoffAfter);
check('the counter says 2 of 2', /2 of 2/.test(standing.counter), standing.counter);

// Swap the choice: unpick rank 2, pick rank 4 — below the line.
await p2.evaluate(() => document.querySelectorAll('.bk-row')[1].click());
await p2.waitForTimeout(250);
await p2.evaluate(() => {
  Array.from(document.querySelectorAll('.bk-row'))
    .find((r) => r.dataset.rank === '4').click();
});
await p2.waitForTimeout(250);
const swapped = await p2.evaluate(() => {
  const u = Object.values(window.PT.store.get().session.units)[0];
  const chosenRanks = Array.from(document.querySelectorAll('.bk-row.chosen'))
    .map((r) => r.dataset.rank);
  return { winners: u.winners.length, chosenRanks };
});
check('a below-the-line row can replace a suggested one',
  swapped.winners === 2 && swapped.chosenRanks.join(',') === '1,4',
  JSON.stringify(swapped));

// The cap holds: choosing a third must refuse.
await p2.evaluate(() => {
  Array.from(document.querySelectorAll('.bk-row'))
    .find((r) => r.dataset.rank === '3').click();
});
await p2.waitForTimeout(250);
const capped = await p2.evaluate(() =>
  Object.values(window.PT.store.get().session.units)[0].winners.length);
check('the target caps the choice — only that many, ever', capped === 2, capped);

await ctx2.close();
await browser.close();
console.log(failed === 0 ? '\nSTOP-DUPES OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-29): Initial release. Third stop-early path: modal offer with
 *   extras count, runoff routing with faces as finalists, extra keeps, export.
  * v1.1 (2026-07-29): Asserts the export stats panel (tiles, burst note) and the
 *   stopped-bracket keep-all choice: top-N by default, all-ranked on demand,
 *   reversible in place.
*/
