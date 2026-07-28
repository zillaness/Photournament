/**
 * file: screenshots.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Drives the built artifact through every screen and captures a PNG of each, for design review.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Run: node tools/screenshots.mjs   ->  docs/screens/*.png
 */

import { chromium } from 'playwright';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT = path.join(ROOT, 'dist', 'photournament_v1.0.html');
const OUT = path.join(ROOT, 'docs', 'screens');
mkdirSync(OUT, { recursive: true });

function crc32(b) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = c ^ (crc >>> 8); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(t, d) {
  const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t, 'ascii'), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([l, td, c]);
}
/** Photo-ish content: soft colour fields plus noise, so the grid does not look like test cards. */
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0, s = (seed * 2654435761) >>> 0;
  const hue = (seed * 47) % 360;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const n = (s >>> 26) - 32;
      const gx = x / w, gy = y / h;
      const base = 60 + 120 * (0.6 * gy + 0.4 * Math.sin(gx * 3 + seed));
      raw[p++] = Math.max(0, Math.min(255, base + n + 60 * Math.cos((hue / 57) + gx * 2)));
      raw[p++] = Math.max(0, Math.min(255, base + n + 30 * Math.sin((hue / 57) + gy * 2)));
      raw[p++] = Math.max(0, Math.min(255, base + n + 50 * Math.cos((hue / 57) + 1.7)));
    }
  }
  const i = Buffer.alloc(13);
  i.writeUInt32BE(w, 0); i.writeUInt32BE(h, 4); i[8] = 8; i[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', i), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

const tmp = path.join(os.tmpdir(), 'pt-shot-' + Date.now());
let n = 0;
for (const [dir, count] of [['Trip/Day1', 14], ['Trip/Day2', 14], ['Trip/Misc', 8]]) {
  for (let i = 0; i < count; i++) {
    const abs = path.join(tmp, dir, `IMG_${1000 + n}.png`);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, png(480, 360, ++n));
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('captured', name);
};
const clickText = async (re, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const ok = await page.evaluate((src) => {
      const rx = new RegExp(src, 'i');
      const b = Array.from(document.querySelectorAll('button'))
        .find((x) => rx.test(x.textContent) && !x.disabled && x.offsetParent !== null);
      if (b) { b.click(); return true; }
      return false;
    }, re.source);
    if (ok) return true;
    await page.waitForTimeout(100);
  }
  return false;
};
const screen = () => page.evaluate(() => document.body.dataset.screen);

await page.goto('file://' + ARTIFACT);
await page.waitForSelector('#pick-folder');
await shot('01_entry');

await page.setInputFiles('#dir-files', tmp);
await page.waitForTimeout(900);
await shot('02_ingest');
await page.waitForFunction(() => {
  const b = document.querySelector('#ingest-actions button');
  return b && /finalist/i.test(b.textContent);
}, { timeout: 120000 });
await shot('03_ingest_done');

await clickText(/finalist/);
await page.waitForSelector('#tree-host .tree-row');
await page.evaluate(() => {
  const set = (name, v) => {
    const r = Array.from(document.querySelectorAll('#tree-host .tree-row'))
      .find((x) => x.querySelector('.tree-name').textContent.trim() === name);
    if (!r) return;
    const i = r.querySelector('.tree-alloc');
    i.value = v; i.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('Trip', '8'); set('Day1', '3'); set('Day2', '3');
});
await shot('04_tree');

await clickText(/Start culling/);
await page.waitForTimeout(700);
if ((await screen()) === 'dupes') {
  await shot('12_duplicate_review');
  await clickText(/looks right|skip this step/, 3000);
  await page.waitForTimeout(500);
}
await shot('05_grid_config');

await clickText(/Start pass/);
await page.waitForTimeout(500);
await shot('06_grid_pass');

// Over-quota state: the advance button must refuse and say why.
await page.evaluate(() => document.querySelectorAll('.photo-cell').forEach((c) => c.click()));
await shot('07_grid_over_quota');
await page.evaluate(() => document.querySelectorAll('.photo-cell.kept').forEach((c) => c.click()));

let guard = 0;
while (guard++ < 300 && (await screen()) !== 'export') {
  const s = await screen();
  if (s === 'grid') {
    const cells = await page.evaluate(() => document.querySelectorAll('.photo-cell').length);
    if (!cells) {
      const ready = await page.evaluate(() => {
        const st = window.PT.store.get();
        const u = st.session.units[st.session.activeUnitId];
        return !u || u.target == null ? true : u.pool.length <= Math.max(4, u.target * 3);
      });
      if (ready && await clickText(/bracket|rank them/, 1200)) continue;
      if (await clickText(/start pass|run another/, 1200)) continue;
      if (await clickText(/bracket|continue|next|skip/, 1200)) continue;
      break;
    }
    await page.evaluate(() => {
      const c = Array.from(document.querySelectorAll('.photo-cell'));
      for (let i = 0; i < Math.max(1, Math.floor(c.length / 2)); i++) c[i].click();
    });
    if (!(await clickText(/continue|finish pass/, 2000))) break;
    continue;
  }
  if (s === 'bracket') {
    const inMatch = await page.evaluate(() => document.querySelectorAll('.bk-vp').length >= 2);
    if (inMatch) {
      if (guard < 6) await shot('08_bracket_matchup');
      const before = await page.evaluate(() => {
        const st = window.PT.store.get();
        const u = st.session.units[st.session.activeUnitId];
        return u.bracket && u.bracket.ops ? u.bracket.ops.length : 0;
      });
      await page.keyboard.press(guard % 3 === 0 ? 'ArrowRight' : 'ArrowLeft');
      await page.waitForTimeout(60);
      const after = await page.evaluate(() => {
        const st = window.PT.store.get();
        const u = st.session.units[st.session.activeUnitId];
        return u.bracket && u.bracket.ops ? u.bracket.ops.length : 0;
      });
      if (after > before) continue;
    }
    if (await clickText(/continue|next|finish|done|results|duplicates/, 1500)) continue;
    break;
  }
  if (s === 'dupes') {
    await shot('12_duplicate_review');
    if (await clickText(/looks right|skip this step/, 1500)) continue;
    break;
  }
  if (s === 'runoff') { await shot('09_duplicates'); if (await clickText(/skip|continue|done/, 1500)) continue; break; }
  if (s === 'rescue') { await shot('10_rescue'); if (await clickText(/skip|continue|done|bracket/, 1500)) continue; break; }
  break;
}

if ((await screen()) === 'export') await shot('11_export');

await browser.close();
rmSync(tmp, { recursive: true, force: true });
console.log('done ->', path.relative(ROOT, OUT));

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Captures entry, ingest, tree, grid
 *   configuration, a live pass, the over-quota state, a bracket matchup, the
 *   duplicate review, the Stage C duplicates screen and export review.
 */
