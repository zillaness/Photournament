/**
 * file: e2e_heic.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-08-02
 * last_updated: 2026-08-02
 * description: Drives the standalone HEIC converter from a file:// origin against the real probe 02 fixtures, including the 12MP tiled-grid HEIC, a truncated file and a mislabelled one.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * The invariant under test: every fixture that CAN decode does, and every one
 * that cannot says why in the words of the failure rather than failing
 * mysteriously. The truncated case is the one worth having — it reports valid
 * dimensions and only fails inside the display callback, which is the whole
 * reason probe 02 exists.
 *
 * Run: node tests/e2e_heic.mjs
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = path.join(ROOT, 'tools', 'heic_convert', 'heic_convert_v1.0.html');
const FIX = path.join(ROOT, 'tools', 'probes', '02_heic', 'fixtures');
if (!existsSync(APP)) { console.error('run: npm run build:heic'); process.exit(1); }

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

const real = ['photo_12mp.heic', 'example_strukturag.heic', 'nokia_C003.heic'].map((f) => path.join(FIX, f));

// A truncated HEIC parses its metadata and reports full dimensions; it only
// fails at the display callback. And a plain text file wearing a .heic name,
// which must be caught by the ftyp brand rather than the extension.
const tmp = path.join(os.tmpdir(), 'pt-heic-' + Date.now());
mkdirSync(tmp, { recursive: true });
const truncated = path.join(tmp, 'truncated.heic');
const liar = path.join(tmp, 'notreally.heic');
writeFileSync(truncated, readFileSync(real[0]).subarray(0, 60000));
writeFileSync(liar, Buffer.from('this is not a heif container at all.'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('file://' + APP);

await page.setInputFiles('input[type=file]:not([webkitdirectory])', [...real, truncated, liar]);
check('every dropped file is queued', (await page.locator('.frow').count()) === 5);

await page.click('#convert');
await page.waitForFunction(
  () => document.querySelectorAll('.fstat.done, .fstat.failed').length >= 5,
  { timeout: 180000 }
);
await page.waitForTimeout(400);

const rows = await page.evaluate(() =>
  [...document.querySelectorAll('.frow')]
    .filter((r) => r.querySelector('.fname'))
    .map((r) => ({
      name: r.querySelector('.fname').textContent,
      meta: r.querySelector('.fmeta').textContent.trim(),
      status: r.querySelector('.fstat').textContent
    })));

const by = (n) => rows.find((r) => r.name === n) || {};
check('the 12MP tiled-grid HEIC decodes at full size',
  by('photo_12mp.heic').status === 'done' && /3992×2992/.test(by('photo_12mp.heic').meta),
  by('photo_12mp.heic').meta);
check('libheif’s own example decodes', by('example_strukturag.heic').status === 'done');
check('the Nokia conformance file decodes', by('nokia_C003.heic').status === 'done');
check('a truncated file is called corrupt, not merely failed',
  by('truncated.heic').status === 'corrupt', by('truncated.heic').status);
check('a mislabelled file is caught by its ftyp brand',
  by('notreally.heic').status === 'not-heif', by('notreally.heic').status);

const why = await page.locator('.ferr').allTextContents();
check('each failure says why in words', why.length === 2 && why.every((t) => t.length > 20),
  JSON.stringify(why));

// The bytes have to be a real JPEG at the right size, not just a blob.
const blobs = await page.evaluate(async () => {
  const out = [];
  for (const img of [...document.querySelectorAll('.frow img.thumb')].filter((i) => i.src)) {
    const b = await fetch(img.src).then((r) => r.blob());
    const head = new Uint8Array(await b.slice(0, 3).arrayBuffer());
    const bm = await createImageBitmap(b);
    out.push({ type: b.type, jpeg: head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff, dim: bm.width + 'x' + bm.height });
    bm.close();
  }
  return out;
});
check('every output is a decodable JPEG', blobs.length === 3 && blobs.every((b) => b.jpeg && b.type === 'image/jpeg'),
  JSON.stringify(blobs.map((b) => b.dim)));

// PNG with a max edge, which exercises the resize path rather than putImageData.
await page.click('#clear');
await page.selectOption('#fmt', 'image/png');
await page.fill('#maxdim', '800');
await page.setInputFiles('input[type=file]:not([webkitdirectory])', [real[1]]);
await page.click('#convert');
await page.waitForFunction(() => document.querySelectorAll('.fstat.done').length === 1, { timeout: 120000 });
const png = await page.evaluate(async () => {
  const b = await fetch(document.querySelector('.frow img.thumb').src).then((r) => r.blob());
  const bm = await createImageBitmap(b);
  const dim = bm.width + 'x' + bm.height; bm.close();
  return { type: b.type, dim: dim, meta: document.querySelector('.fmeta').textContent.trim() };
});
check('PNG output resizes to the max edge, preserving aspect',
  png.type === 'image/png' && png.dim === '800x534', JSON.stringify(png));

// Write-through: the picker is native, so the handle is stubbed. What is under
// test is this file's own streaming logic, not Chromium's dialog.
await page.click('#clear');
await page.evaluate(() => {
  window.__written = [];
  window.showDirectoryPicker = async () => ({
    name: 'Stub',
    getFileHandle: async (name) => ({
      createWritable: async () => ({
        write: async (blob) => { window.__written.push({ name, bytes: blob.size }); },
        close: async () => {}
      })
    })
  });
});
await page.selectOption('#fmt', 'image/jpeg');
await page.fill('#maxdim', '0');
await page.click('#pick-out');
await page.setInputFiles('input[type=file]:not([webkitdirectory])', [real[2]]);
await page.click('#convert');
await page.waitForFunction(() => document.querySelectorAll('.fstat.written').length === 1, { timeout: 120000 });
const streamed = await page.evaluate(() => ({
  written: window.__written,
  previewsHeld: [...document.querySelectorAll('.frow img.thumb')].filter((i) => i.src).length,
  zipHidden: document.querySelector('#save-zip').hidden
}));
check('writing through puts real bytes on disk',
  streamed.written.length === 1 && streamed.written[0].name === 'nokia_C003.jpg' && streamed.written[0].bytes > 10000,
  JSON.stringify(streamed.written));
check('and releases the result rather than holding it',
  streamed.previewsHeld === 0 && streamed.zipHidden === true, JSON.stringify(streamed));

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await browser.close();
console.log(failed === 0 ? '\nHEIC CONVERTER OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-08-02): Initial release. Real fixtures through the real artifact
 *   from file://, both failure paths named, JPEG and PNG output verified by
 *   decoding it back, and the write-through path checked against a stubbed
 *   directory handle.
 */
