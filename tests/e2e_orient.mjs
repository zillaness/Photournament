/**
 * file: e2e_orient.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Verifies manual rotate/flip — cell controls redraw the cached derivative pixels, the dihedral state composes and persists, the correction survives a reload — and the photos-not-folder entry path.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Two invariants:
 *   1. A correction is PIXELS, not paint: after rotating, the derivative blob's
 *      own dimensions are swapped, so every renderer — including the bracket's
 *      fit math and the contact sheet — inherits it with no code of its own.
 *   2. The correction is durable: it survives four presses composing back to
 *      neutral, and it survives a reload, because the blobs and the state are
 *      both persisted.
 *
 * Run: node tests/e2e_orient.mjs
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

/* ------------------------------------------------------------- fixture --- */

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

/**
 * PORTRAIT frames (h > w), each with a bright RED LEFT EDGE over a per-seed
 * block pattern: the aspect proves rotation, the red edge proves the mirror.
 */
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const bits = ((seed * 2654435761) >>> 16) & 0xffff;
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    const by = Math.min(3, (y * 4 / h) | 0);
    for (let x = 0; x < w; x++) {
      if (x < w * 0.18) { raw[p++] = 235; raw[p++] = 30; raw[p++] = 30; continue; }
      const bx = Math.min(3, (x * 4 / w) | 0);
      const on = (bits >> (by * 4 + bx)) & 1;
      const v = on ? 190 : 58;
      raw[p++] = v; raw[p++] = v; raw[p++] = ((v * 0.9) | 0) + (seed % 20);
    }
  }
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

const tmp = path.join(os.tmpdir(), 'pt-orient-' + Date.now());
mkdirSync(tmp, { recursive: true });
const FILES = [];
for (let i = 0; i < 4; i++) {
  const abs = path.join(tmp, `pic_${i}.png`);
  writeFileSync(abs, png(120, 180, i));
  FILES.push(abs);
}

/* ---------------------------------------------------------------- run --- */

// A persistent profile, because half the point is surviving a reload.
const ctx = await chromium.launchPersistentContext(
  path.join(os.tmpdir(), 'pt-orient-prof-' + Date.now()),
  { viewport: { width: 1500, height: 980 } }
);
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('file://' + ARTIFACT);

/* --- entry offers photos as an equal choice ------------------------------ */

await page.waitForSelector('#pick-folder');
const entry = await page.evaluate(() => {
  const files = document.getElementById('pick-files');
  const drop = document.querySelector('.drop-title');
  return {
    photosBtn: !!files && /photos/i.test(files.textContent),
    visible: !!files && files.offsetParent !== null,
    dropSaysBoth: !!drop && /folder or photos/i.test(drop.textContent)
  };
});
check('“Choose photos” stands beside “Choose a folder”', entry.photosBtn && entry.visible,
  JSON.stringify(entry));
check('the dropzone invites both', entry.dropSaysBoth === true);

// Feed the loose-file input directly — the same path the button opens.
await page.setInputFiles('#loose-files', FILES);
await page.waitForFunction(() => {
  const b = document.querySelector('#ingest-actions button');
  return b && /finalist/i.test(b.textContent);
}, { timeout: 60000 });

const ingested = await page.evaluate(() => {
  const s = window.PT.store.get();
  return { photos: Object.keys(s.photos).length, root: s.session.rootName };
});
check('four loose photos ingested without a folder', ingested.photos === 4,
  JSON.stringify(ingested));

await page.click('#ingest-actions button');
await page.waitForSelector('.tree-row');
await page.evaluate(() => {
  const i = document.querySelector('.tree-row:not(.tree-head) .tree-alloc');
  i.value = '2'; i.dispatchEvent(new Event('input', { bubbles: true }));
  Array.from(document.querySelectorAll('button'))
    .find((x) => /start culling/i.test(x.textContent) && !x.disabled).click();
});
await page.waitForSelector('#dupe-skip, [data-t="start-pass"]', { timeout: 30000 });
if (await page.$('#dupe-skip')) await page.click('#dupe-skip');
await page.waitForSelector('[data-t="start-pass"]');
await page.click('[data-t="start-pass"]');
await page.waitForSelector('.photo-cell');

/* --- helpers ------------------------------------------------------------- */

/** Decode a photo's cached thumb and report dimensions + which edge is red. */
const probe = (id) => page.evaluate(async (pid) => {
  const s = window.PT.store.get();
  const blob = s.derivatives[pid].thumb;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0);
  const redAt = (px) => {
    const d = x.getImageData(px, Math.floor(bmp.height / 2), 1, 1).data;
    return d[0] > 150 && d[1] < 110;
  };
  const out = {
    w: bmp.width, h: bmp.height,
    redLeft: redAt(2), redRight: redAt(bmp.width - 3),
    orient: (s.photos[pid] && s.photos[pid].orient) || null
  };
  bmp.close();
  return out;
}, id);

const firstCellId = await page.evaluate(() =>
  document.querySelector('.photo-cell').dataset.id);

/* --- portrait photos start upright --------------------------------------- */

const base = await probe(firstCellId);
check('a portrait photo arrives portrait, red edge left', base.h > base.w && base.redLeft && !base.redRight,
  JSON.stringify(base));

/* --- the controls exist, and rotating is pixels not paint ----------------- */

const controls = await page.evaluate(() => {
  const cell = document.querySelector('.photo-cell');
  return {
    rot: !!cell.querySelector('[data-t="rot"]'),
    flip: !!cell.querySelector('[data-t="flip"]')
  };
});
check('every cell carries rotate and flip', controls.rot && controls.flip);

await page.click('.photo-cell [data-t="rot"]');
await page.waitForFunction((pid) => {
  const s = window.PT.store.get();
  const o = s.photos[pid].orient;
  return o && o.r === 1;
}, firstCellId, { timeout: 10000 });

const rotated = await probe(firstCellId);
check('one press turns the pixels a quarter clockwise', rotated.w === base.h && rotated.h === base.w,
  base.w + 'x' + base.h + ' -> ' + rotated.w + 'x' + rotated.h);
check('a left red edge lands on top, not left or right', !rotated.redLeft && !rotated.redRight);
check('the state records one clockwise turn', rotated.orient && rotated.orient.r === 1 && !rotated.orient.f,
  JSON.stringify(rotated.orient));

// The cell's rendered image follows the new blob without a repaint of the screen.
const cellFollows = await page.evaluate(() => {
  const img = document.querySelector('.photo-cell .thumb');
  return img && img.naturalWidth > img.naturalHeight;
});
check('the cell shows the corrected pixels immediately', cellFollows === true);

/* --- three more presses compose back to neutral --------------------------- */

for (let i = 0; i < 3; i++) {
  await page.click('.photo-cell [data-t="rot"]');
  await page.waitForTimeout(350);
}
const neutral = await probe(firstCellId);
check('four turns come home: dimensions restored, state cleared',
  neutral.w === base.w && neutral.h === base.h && neutral.orient === null && neutral.redLeft,
  JSON.stringify({ w: neutral.w, h: neutral.h, orient: neutral.orient }));

/* --- the mirror ----------------------------------------------------------- */

await page.click('.photo-cell [data-t="flip"]');
await page.waitForFunction((pid) => {
  const s = window.PT.store.get();
  const o = s.photos[pid].orient;
  return o && o.f === true;
}, firstCellId, { timeout: 10000 });

const flipped = await probe(firstCellId);
check('the mirror moves the red edge to the right', flipped.redRight && !flipped.redLeft);
check('the state records the mirror alone', flipped.orient && flipped.orient.f === true && flipped.orient.r === 0,
  JSON.stringify(flipped.orient));

/* --- and it all survives a reload ----------------------------------------- */

await page.reload();
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button'))
    .find((x) => /resume|continue/i.test(x.textContent));
  if (b) b.click();
});
await page.waitForTimeout(800);

const after = await probe(firstCellId);
check('the mirrored derivative survives the reload', after.redRight && !after.redLeft,
  JSON.stringify({ redLeft: after.redLeft, redRight: after.redRight }));
check('the recorded state survives with it', after.orient && after.orient.f === true,
  JSON.stringify(after.orient));

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await ctx.close();
console.log(failed === 0 ? '\nORIENT OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Loose-photo entry, upright portrait
 *   arrival, rotate/flip as pixel redraws with dihedral-state bookkeeping,
 *   composition back to neutral, and reload durability.
 */
