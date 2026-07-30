/**
 * file: e2e_zip.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-29
 * last_updated: 2026-07-29
 * description: Verifies the zip export end to end — the downloaded archive really contains the finalists — and the reloaded-session path: an empty build refuses to download, the reconnect notice re-attaches originals by path, and the rebuilt zip is whole.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * The bug this pins down: file sources die with the page, and buildZip used to
 * "skip" every unreadable original with a console warning, then download a
 * valid EMPTY archive announcing the planned count. Every reloaded session got
 * that zip. The archive's central directory is parsed here, not assumed.
 *
 * Run: node tests/e2e_zip.mjs
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

/* ------------------------------------------------------------- fixture --- */

function crc32(b) { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = c ^ (crc >>> 8); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, 'ascii'), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, cr]); }
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
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

const tmp = path.join(os.tmpdir(), 'pt-zip-' + Date.now());
mkdirSync(path.join(tmp, 'Roll'), { recursive: true });
for (let k = 0; k < 4; k++) {
  writeFileSync(path.join(tmp, 'Roll', `pic_${k}.png`), pngBoard(160, 120, k));
}

/** Central-directory census of a real zip file: [{name, size}]. */
function zipEntries(file) {
  const buf = readFileSync(file);
  const entries = [];
  let i = 0;
  while ((i = buf.indexOf('PK\x01\x02', i, 'binary')) !== -1) {
    const size = buf.readUInt32LE(i + 24);
    const nameLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 46, i + 46 + nameLen).toString('utf8');
    entries.push({ name, size });
    i += 46 + nameLen;
  }
  return entries;
}

/* ---------------------------------------------------------------- run --- */

const profile = path.join(os.tmpdir(), 'pt-zip-prof-' + Date.now());
const ctx = await chromium.launchPersistentContext(profile, {
  viewport: { width: 1500, height: 980 },
  acceptDownloads: true
});
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const driveToExport = async () => {
  await page.setInputFiles('#dir-files', tmp);
  await page.waitForFunction(() => {
    const b = document.querySelector('#ingest-actions button');
    return b && /finalist/i.test(b.textContent);
  }, { timeout: 60000 });
  await page.click('#ingest-actions button');
  await page.waitForSelector('.tree-row');
  await page.evaluate(() => {
    const i = document.querySelector('input.tree-alloc[data-path$="/Roll"]');
    i.value = '3'; i.dispatchEvent(new Event('input', { bubbles: true }));
    Array.from(document.querySelectorAll('button'))
      .find((x) => /start culling/i.test(x.textContent) && !x.disabled).click();
  });
  await page.waitForSelector('#dupe-skip, [data-t="finish-early"]', { timeout: 30000 });
  if (await page.$('#dupe-skip')) await page.click('#dupe-skip');
  await page.waitForSelector('[data-t="finish-early"]');
  await page.click('[data-t="finish-early"]');
  await page.waitForSelector('[data-t="finish-early-confirm"]');
  await page.click('[data-t="finish-early-confirm"]');
  await page.waitForFunction(() =>
    window.PT.store.get().session.stage === 'export' &&
    Array.from(document.querySelectorAll('button')).some((b) => /one \.zip/i.test(b.textContent)),
  { timeout: 15000 });
};

await page.goto('file://' + ARTIFACT);
await driveToExport();

/* --- in-session: the archive really contains the finalists ---------------- */

check('no reconnect notice while sources are alive',
  await page.evaluate(() => !document.querySelector('[data-t="reconnect"]')));

const clickZip = () => page.evaluate(() => {
  Array.from(document.querySelectorAll('button'))
    .find((b) => /one \.zip/i.test(b.textContent)).click();
});

const dl = page.waitForEvent('download', { timeout: 20000 });
await clickZip();
const zipPath = path.join(os.tmpdir(), 'pt-zip-out-' + Date.now() + '.zip');
await (await dl).saveAs(zipPath);

const entries = zipEntries(zipPath);
check('the zip holds all four finalists', entries.length === 4,
  entries.map((e) => e.name).join(', '));
check('every entry carries real bytes', entries.every((e) => e.size > 500),
  entries.map((e) => e.size).join(','));

/* --- after a reload the sources are gone; the zip must not lie ------------ */

await page.reload();
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button'))
    .find((x) => /resume|continue/i.test(x.textContent));
  if (b) b.click();
});
await page.waitForFunction(() =>
  window.PT.store.get().session.stage === 'export' &&
  Array.from(document.querySelectorAll('button')).some((b) => /one \.zip/i.test(b.textContent)),
{ timeout: 15000 });

check('the reloaded session says the originals are unreachable',
  await page.evaluate(() => !!document.querySelector('[data-t="reconnect"]')));

let downloaded = false;
page.once('download', () => { downloaded = true; });
await clickZip();
await page.waitForTimeout(2500);
check('an empty build refuses to download', downloaded === false);

/* --- reconnecting the folder makes the zip whole again -------------------- */

await page.setInputFiles('#exp-reconnect-files', tmp);
await page.waitForFunction(() => !document.querySelector('[data-t="reconnect"]'), { timeout: 10000 });
check('reconnecting by path clears the notice', true);

const dl2 = page.waitForEvent('download', { timeout: 20000 });
await clickZip();
const zipPath2 = path.join(os.tmpdir(), 'pt-zip-out2-' + Date.now() + '.zip');
await (await dl2).saveAs(zipPath2);
const entries2 = zipEntries(zipPath2);
check('the rebuilt zip holds all four again', entries2.length === 4,
  entries2.map((e) => e.name).join(', '));
check('with real bytes', entries2.every((e) => e.size > 500));

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await ctx.close();
console.log(failed === 0 ? '\nZIP OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-29): Initial release. Central-directory census of the real
 *   download, the reloaded-session refusal, and the path-matched reconnect.
 */
