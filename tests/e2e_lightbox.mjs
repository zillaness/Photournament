/**
 * file: e2e_lightbox.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Verifies the expand view on the duplicate review: the chip opens the PREVIEW (not the thumbnail), arrows step through the group and wrap, 1:1 zoom toggles, esc closes, and expanding never changes the group's representative.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Run: node tests/e2e_lightbox.mjs
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

/* ------------------- burst corpus, LARGE so preview > thumb -------------- */

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
/**
 * Frames of one scene are PIXEL-IDENTICAL apart from a small corner stamp, so
 * they sit within the grouping gate at ANY render size — this corpus must be
 * large (preview > thumbnail is one of the assertions), and at large sizes a
 * global per-frame exposure step drifts past the ingest-hash gate.
 */
function makeFrame(w, h, scene, frame) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  const fx = 1 + scene, fy = 1 + ((scene * 3) % 4), ph = (scene * 1.7) % 6.283;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const stamp = x < 46 && y < 46;
      const v = 128
        + 68 * Math.sin((x / w) * Math.PI * 2 * fx + ph)
        + 52 * Math.cos((y / h) * Math.PI * 2 * fy + ph * 1.3);
      raw[p++] = clamp(stamp ? 40 + frame * 80 : v);
      raw[p++] = clamp(stamp ? 220 - frame * 70 : v * 0.86 + ((scene * 17) % 40));
      raw[p++] = clamp(stamp ? 60 + frame * 50 : v * 0.72 + ((scene * 29) % 60));
    }
  }
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

const tmp = path.join(os.tmpdir(), 'pt-lb-' + Date.now());
mkdirSync(path.join(tmp, 'Roll'), { recursive: true });
for (let f = 0; f < 3; f++) {
  writeFileSync(path.join(tmp, 'Roll', `burst_${f}.png`), makeFrame(900, 600, 0, f));
}
writeFileSync(path.join(tmp, 'Roll', 'lone.png'), makeFrame(900, 600, 2, 0));

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

await page.waitForSelector('#dupe-list .ro-group .dupe-cell', { timeout: 60000 });

const repBefore = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = Object.values(s.session.units)[0];
  return u.groups[0].rep || null;
});

/* --- the chip opens the PREVIEW over the group --------------------------- */

check('every member cell carries an expand chip', await page.evaluate(() =>
  Array.from(document.querySelectorAll('#dupe-list .dupe-cell'))
    .every((c) => !!c.querySelector('[data-t="expand"]'))));

// Open from the SECOND member, so the index is meaningful. Programmatic click:
// the chip is hover-revealed and thumbnails shift layout while they decode,
// which makes a pointer-driven click flaky inside the full suite.
await page.evaluate(() => {
  document.querySelectorAll('#dupe-list .dupe-cell')[1]
    .querySelector('[data-t="expand"]').click();
});
await page.waitForSelector('#lightbox[open]');

const opened = await page.evaluate(async () => {
  const img = document.querySelector('#lightbox .lb-wrap img');
  await new Promise((res) => {
    if (img.complete && img.naturalWidth) return res();
    img.addEventListener('load', res, { once: true });
    setTimeout(res, 3000);
  });
  return {
    count: document.querySelector('#lightbox .lb-count').textContent,
    name: document.querySelector('#lightbox .lb-name').textContent,
    naturalW: img.naturalWidth
  };
});
check('it opens on the member that was expanded', opened.count === '2 / 3', opened.count);
// The thumbnail is ~320px; only the preview can be wider than 400.
check('it shows the preview, not the thumbnail', opened.naturalW > 400, opened.naturalW + 'px wide');

/* --- arrows step and wrap ------------------------------------------------ */

await page.keyboard.press('ArrowRight');
const at3 = await page.evaluate(() => document.querySelector('#lightbox .lb-count').textContent);
check('the right arrow steps forward', at3 === '3 / 3', at3);
await page.keyboard.press('ArrowRight');
const wrapped = await page.evaluate(() => document.querySelector('#lightbox .lb-count').textContent);
check('…and wraps around the group', wrapped === '1 / 3', wrapped);

/* --- 1:1 zoom ------------------------------------------------------------ */

await page.click('#lightbox .lb-wrap img');
const zoomed = await page.evaluate(() => ({
  cls: document.querySelector('#lightbox .lb-wrap').classList.contains('zoomed'),
  label: Array.from(document.querySelectorAll('#lightbox .lb-bar button'))
    .some((b) => /fit/i.test(b.textContent))
}));
check('clicking the photo toggles 1:1', zoomed.cls === true && zoomed.label === true,
  JSON.stringify(zoomed));

/* --- esc closes, and nothing was decided --------------------------------- */

await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.getElementById('lightbox').open);
check('escape closes it', true);

const repAfter = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = Object.values(s.session.units)[0];
  return u.groups[0].rep || null;
});
check('looking never changes the representative', repAfter === repBefore,
  repBefore + ' vs ' + repAfter);

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await browser.close();
console.log(failed === 0 ? '\nLIGHTBOX OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Chip on every member cell, preview-not-
 *   thumbnail, arrow stepping with wrap, 1:1 toggle, esc, and no side effects.
 */
