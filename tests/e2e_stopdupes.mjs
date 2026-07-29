/**
 * file: e2e_stopdupes.mjs
 * version: 1.0
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

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await browser.close();
console.log(failed === 0 ? '\nSTOP-DUPES OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-29): Initial release. Third stop-early path: modal offer with
 *   extras count, runoff routing with faces as finalists, extra keeps, export.
 */
