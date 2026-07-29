/**
 * file: e2e_stop.mjs
 * version: 1.1
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Verifies the finish-early exit: stopping mid-pass keeps everything not yet cut — including photos on screens the user never reached — marks the unit done, and lands on export with exactly those finalists.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * The invariant under test: stopping early NEVER costs a photo its place.
 * A photo leaves the running only by being passed over on a screen the user
 * actually advanced. Everything else — kept, selected, or simply never shown —
 * must survive the stop.
 *
 * Run: node tests/e2e_stop.mjs
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT = path.join(ROOT, 'dist', 'photournament_v1.0.html');
if (!existsSync(ARTIFACT)) { console.error('run: node tools/build.mjs'); process.exit(1); }

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

/* ------------------------------------------------------------- fixture --- */

let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return c ^ -1;
}

/** Visually distinct PNGs so the perceptual hash never groups any of them. */
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const v = ((x * (seed + 3) ^ y * (seed * 7 + 1)) + seed * 41) & 255;
      raw[row + 1 + x * 3] = v;
      raw[row + 2 + x * 3] = (v * 3 + seed * 29) & 255;
      raw[row + 3 + x * 3] = (255 - v + seed * 13) & 255;
    }
  }
  const chunk = (t, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const b = Buffer.concat([Buffer.from(t, 'ascii'), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b) >>> 0);
    return Buffer.concat([l, b, c]);
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

// 21 photos, 9 per screen: screen 1 (judged), screen 2 (current when we stop),
// screen 3 (never reached). One folder so there is exactly one unit.
const N = 21;
const tmp = path.join(os.tmpdir(), 'pt-stop-' + Date.now());
mkdirSync(path.join(tmp, 'Roll'), { recursive: true });
for (let i = 0; i < N; i++) {
  writeFileSync(path.join(tmp, 'Roll', `img${String(i).padStart(2, '0')}.png`), png(96, 64, i));
}

/* ---------------------------------------------------------------- run --- */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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

// Target 4, so stopping with far more than 4 standing proves the target
// does not cap a finish-early.
await page.fill('input.tree-alloc[data-path$="/Roll"]', '4');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button'))
    .find((x) => /start culling/i.test(x.textContent) && !x.disabled);
  b.click();
});

// The dupes review may interpose; skip straight through it.
await page.waitForSelector('#dupe-skip, [data-t="start-pass"]', { timeout: 30000 });
if (await page.$('#dupe-skip')) await page.click('#dupe-skip');
await page.waitForSelector('[data-t="start-pass"]', { timeout: 30000 });

// On the setup screen, the explicit exit must be there and say the full count.
const setupBtn = await page.$('[data-t="finish-early"]');
check('the setup screen offers "Finish here"', !!setupBtn);
if (setupBtn) {
  const label = await setupBtn.textContent();
  check('…and it keeps ALL of the pool', new RegExp('\\b' + N + '\\b').test(label), label);
}
check('the topbar Stop early is visible on setup', await page.evaluate(() => {
  const s = document.getElementById('topbar-stop');
  return !!s && !s.hidden;
}));

// Start a pass: 9 per screen, Keep 1 — the harshest quota, to prove stopping
// early overrides it.
await page.selectOption('[data-t="cfg-quota"]', 'one');
await page.click('[data-t="start-pass"]');
await page.waitForSelector('.photo-cell');

check('the topbar Stop early is visible mid-pass', await page.evaluate(() => {
  const s = document.getElementById('topbar-stop');
  return !!s && !s.hidden;
}));

// Screen 1: keep exactly one (position 1), advance. 8 photos are now judged out.
await page.keyboard.press('1');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);

// Screen 2: select one but do NOT advance — the screen is unjudged.
await page.keyboard.press('2');
await page.waitForTimeout(100);

const before = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  return {
    pool: u.pool.length, kept: u.currentPass.kept.length,
    index: u.currentPass.index, total: u.currentPass.order.length
  };
});
check('mid-pass state is as staged', before.kept === 1 && before.index === 1 && before.total === N,
  JSON.stringify(before));

// Stop early from the topbar.
await page.click('#topbar-stop');
await page.waitForSelector('[data-t="finish-early-confirm"]');

// Keys must be dead behind the dialog: '3' here used to toggle cell 3 on the
// screen the modal is covering.
const selBefore = await page.evaluate(() => {
  const s = window.PT.store.get();
  return (s.session.units[s.session.activeUnitId].currentPass.sel || []).length;
});
await page.keyboard.press('3');
await page.waitForTimeout(120);
const selAfter = await page.evaluate(() => {
  const s = window.PT.store.get();
  return (s.session.units[s.session.activeUnitId].currentPass.sel || []).length;
});
check('keys are inert behind the confirm dialog', selAfter === selBefore,
  selBefore + ' -> ' + selAfter);

const modalText = await page.evaluate(() => document.getElementById('modal-body').textContent);
// 1 kept + 12 never judged (screen 2's 9 + screen 3's 3) = 13 standing.
check('the modal counts 13 standing', /\b13\b/.test(modalText), modalText.slice(0, 140));
check('no best-of-duplicates path when nothing is grouped',
  await page.evaluate(() => !document.querySelector('[data-t="finish-early-dupes"]')));
check('the modal separates kept from unjudged',
  /1 you kept/.test(modalText) && /12 not yet judged/.test(modalText));

await page.click('[data-t="finish-early-confirm"]');
await page.waitForSelector('.screen-export, #export-list, [data-screen="export"], h1', { timeout: 15000 });

const after = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[Object.keys(s.session.units)[0]];
  return {
    phase: u.phase,
    winners: u.winners.length,
    cut: u.cut.length,
    pool: u.pool.length,
    currentPass: u.currentPass,
    stage: s.session.stage,
    screen: location.hash || document.body.className
  };
});

check('the unit is done', after.phase === 'done', after.phase);
check('13 finalists survive the stop', after.winners === 13, after.winners);
check('the 8 passed-over photos are cut, no more', after.cut === 8, after.cut);
check('the pool agrees with the winners', after.pool === 13, after.pool);
check('no half-finished pass is left behind', after.currentPass === null);
check('the session advanced to export', after.stage === 'export', after.stage);

// The finalists on the export screen are the same 13, not the target's 4.
const exported = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[Object.keys(s.session.units)[0]];
  return { winners: u.winners.length, target: u.target };
});
check('the target did not cap the finish', exported.winners > exported.target,
  exported.winners + ' kept vs target ' + exported.target);

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

/* --- keeping nothing closes the folder out, no empty bracket march -------- */

const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const p2 = await ctx2.newPage();
await p2.goto('file://' + ARTIFACT);
await p2.setInputFiles('#dir-files', tmp);
await p2.waitForFunction(() => {
  const b = document.querySelector('#ingest-actions button');
  return b && /finalist/i.test(b.textContent);
}, { timeout: 60000 });
await p2.click('#ingest-actions button');
await p2.waitForSelector('.tree-row');
await p2.fill('input.tree-alloc[data-path$="/Roll"]', '4');
await p2.evaluate(() => {
  Array.from(document.querySelectorAll('button'))
    .find((x) => /start culling/i.test(x.textContent) && !x.disabled).click();
});
await p2.waitForSelector('#dupe-skip, [data-t="start-pass"]', { timeout: 30000 });
if (await p2.$('#dupe-skip')) await p2.click('#dupe-skip');
await p2.waitForSelector('[data-t="start-pass"]');
await p2.click('[data-t="start-pass"]');
await p2.waitForSelector('.photo-cell');
// Advance every screen keeping nothing.
for (let i = 0; i < 4; i++) {
  const done = await p2.evaluate(() => !document.querySelector('[data-t="advance"]'));
  if (done) break;
  await p2.click('[data-t="advance"]');
  await p2.waitForTimeout(250);
}
const emptySetup = await p2.evaluate(() => ({
  finishEmpty: !!document.querySelector('[data-t="finish-empty"]'),
  bracketOffered: !!document.querySelector('[data-t="tobracket"]')
}));
check('an empty pool offers finish, not the bracket',
  emptySetup.finishEmpty === true && emptySetup.bracketOffered === false,
  JSON.stringify(emptySetup));
await p2.click('[data-t="finish-empty"]');
await p2.waitForTimeout(600);
const closedOut = await p2.evaluate(() => {
  const s = window.PT.store.get();
  const u = Object.values(s.session.units)[0];
  return { phase: u.phase, winners: u.winners.length, stage: s.session.stage };
});
check('the folder closes with zero finalists, straight to the end',
  closedOut.phase === 'done' && closedOut.winners === 0 && closedOut.stage === 'export',
  JSON.stringify(closedOut));
await ctx2.close();

await browser.close();
console.log(failed === 0 ? '\nSTOP-EARLY OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Mid-pass finish-early from the topbar:
 *   kept + unjudged survive, judged-out photos join the cut pile, the unit
 *   completes, and export shows the uncapped survivor count.
  * v1.2 (2026-07-29): Asserts the best-of-duplicates path is absent when nothing
 *   is grouped, and that a keep-nothing pass closes the folder out directly —
 *   zero finalists, no empty bracket, no empty duplicates round.
*/
