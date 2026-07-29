/**
 * file: e2e_marquee.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-29
 * last_updated: 2026-07-29
 * description: Verifies marquee selection on the duplicate review: a real mouse sweep selects the swept cells, shift-drag adds across groups, the swept set feeds remove-from-grouping in one action, and a stray background click selects nothing.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Run: node tests/e2e_marquee.mjs
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

/** Corner-stamp bursts: frames identical apart from a small stamp, so they
 *  group at any size (same construction e2e_lightbox measures with). */
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

const tmp = path.join(os.tmpdir(), 'pt-marq-' + Date.now());
mkdirSync(path.join(tmp, 'Roll'), { recursive: true });
for (let f = 0; f < 5; f++) writeFileSync(path.join(tmp, 'Roll', `burstA_${f}.png`), makeFrame(240, 180, 0, f));
for (let f = 0; f < 4; f++) writeFileSync(path.join(tmp, 'Roll', `burstB_${f}.png`), makeFrame(240, 180, 1, f));

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
await page.waitForSelector('#dupe-list .dupe-cell', { timeout: 60000 });
await page.waitForTimeout(400);

/* --- a sweep from the group background across three cells ---------------- */

const sweep = await page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('#dupe-list .dupe-cell'));
  const gb = document.querySelector('#dupe-list .ro-body').getBoundingClientRect();
  const c2 = cells[2].getBoundingClientRect();
  return { x0: gb.left + 2, y0: gb.top + 2, x1: c2.right - 6, y1: c2.bottom - 6 };
});
await page.mouse.move(sweep.x0, sweep.y0);
await page.mouse.down();
await page.mouse.move(sweep.x1, sweep.y1, { steps: 8 });
const boxDuring = await page.evaluate(() => !!document.getElementById('dupe-marquee'));
await page.mouse.up();
const after = await page.evaluate(() => ({
  box: !!document.getElementById('dupe-marquee'),
  picked: document.querySelectorAll('#dupe-list .dupe-cell.picked').length,
  toolbar: document.getElementById('dupe-actions').textContent
}));
check('the box appears while sweeping', boxDuring === true);
check('the box is gone after release', after.box === false);
check('the sweep selected the swept cells', after.picked === 3, after.picked + ' picked');
check('the toolbar reflects the swept selection', /3 selected/.test(after.toolbar));

/* --- shift-drag adds the second group ------------------------------------ */

const g2 = await page.evaluate(() => {
  const groups = Array.from(document.querySelectorAll('#dupe-list .ro-group'));
  const body = groups[1].querySelector('.ro-body');
  const cells = groups[1].querySelectorAll('.dupe-cell');
  const b = body.getBoundingClientRect();
  const last = cells[cells.length - 1].getBoundingClientRect();
  return { x0: b.left + 2, y0: b.top + 2, x1: last.right - 6, y1: last.bottom - 6, n: cells.length };
});
await page.keyboard.down('Shift');
await page.mouse.move(g2.x0, g2.y0);
await page.mouse.down();
await page.mouse.move(g2.x1, g2.y1, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Shift');
const added = await page.evaluate(() => ({
  picked: document.querySelectorAll('#dupe-list .dupe-cell.picked').length,
  toolbar: document.getElementById('dupe-actions').textContent
}));
check('shift-drag adds across groups', added.picked === 3 + g2.n, added.picked + ' picked');
check('merge is offered across two groups', /Merge/i.test(added.toolbar));

/* --- the swept set feeds the existing actions ----------------------------- */

await page.click('#dupe-remove');
await page.waitForTimeout(300);
const removed = await page.evaluate(() =>
  Object.keys(window.PT.store.get().session.groups.removed).length);
check('one action ungroups the whole sweep', removed === 3 + g2.n, removed + ' removed');

/* --- a stray click is not a sweep ----------------------------------------- */

// Which groups survive the remove depends on group ordering; any background
// (a remaining group's body, or the list itself) serves the stray-click check.
const bg = await page.evaluate(() => {
  const host = document.querySelector('#dupe-list .ro-body') || document.getElementById('dupe-list');
  const b = host.getBoundingClientRect();
  return { x: b.left + 4, y: b.top + 4 };
});
await page.mouse.click(bg.x, bg.y);
const still = await page.evaluate(() =>
  document.querySelectorAll('#dupe-list .dupe-cell.picked').length);
check('a stray background click sweeps nothing', still === 0, still + ' picked');

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await browser.close();
console.log(failed === 0 ? '\nMARQUEE OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-29): Initial release. Real-mouse sweep, shift-add across
 *   groups, one-action remove of the swept set, stray-click guard.
 */
