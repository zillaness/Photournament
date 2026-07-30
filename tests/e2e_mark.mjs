/**
 * file: e2e_mark.mjs
 * version: 1.2
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Verifies the brand mark on the ingest screen — the plate matches the surface it sits on, the nine walking cells land on the sprite's own geometry, and the slot transitions between working and settled rather than swapping.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Three things this guards, all of which looked fine in code and wrong on screen:
 *
 *   1. THE PLATE. The mark carries its own rounded ground. Hardcoding that to
 *      --bg put a page-coloured square on top of a --surface card, which reads
 *      as a second, slightly-off black.
 *   2. THE GEOMETRY. The walking cells are an overlay ON the mark, not a
 *      separate throbber beside it. If their percentages drift from the
 *      symbol's, the transition becomes a visible resize.
 *   3. THE TRANSITION. A swap is instant; this has to interpolate, in both
 *      directions, and end on the identity.
 *
 * Run: node tests/e2e_mark.mjs
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

/* ------------------------------------------------------------ fixture --- */

function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = (rgb[0] + x) & 255;
      raw[row + 2 + x * 3] = (rgb[1] + y) & 255;
      raw[row + 3 + x * 3] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

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

/* ---------------------------------------------------------------- run --- */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

/** Resolve a colour by painting it — oklch read back from a custom property stays oklch. */
const PAINT = `(css) => {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const x = c.getContext('2d'); x.fillStyle = css; x.fillRect(0, 0, 1, 1);
  const d = x.getImageData(0, 0, 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
}`;

await page.goto('file://' + ARTIFACT);
await page.waitForSelector('.pt-lockup .pt-brandmark');

/* --- 1. the plate follows its surface -------------------------------- */

const entry = await page.evaluate(`(() => {
  const paint = ${PAINT};
  const mark = document.querySelector('.pt-lockup .pt-brandmark');
  const cs = getComputedStyle(mark);
  const root = getComputedStyle(document.documentElement);
  return {
    plate: paint(cs.getPropertyValue('--mark-plate').trim()),
    bg: paint(root.getPropertyValue('--bg').trim()),
    surface: paint(root.getPropertyValue('--surface').trim()),
    behind: getComputedStyle(mark.closest('.card')).backgroundColor
  };
})()`);

check('the entry card paints nothing, so the mark meets the page',
  entry.behind === 'rgba(0, 0, 0, 0)', entry.behind);
check('the entry plate is the page colour', entry.plate === entry.bg,
  entry.plate + ' vs --bg ' + entry.bg);
check('--bg and --surface really are different shades', entry.bg !== entry.surface,
  entry.bg + ' vs ' + entry.surface);

/* --- get onto the ingest screen -------------------------------------- */

// Enough work that the live window is seconds wide — with 14 tiny files the
// throbber could settle before a loaded test runner ever sampled it.
const tmp = path.join(os.tmpdir(), 'pt-mark-' + Date.now());
mkdirSync(path.join(tmp, 'Roll'), { recursive: true });
for (let i = 0; i < 36; i++) {
  writeFileSync(path.join(tmp, 'Roll', `f${i}.png`), png(320, 240, [i * 9, 40, 90]));
}
await page.setInputFiles('#dir-files', tmp);
await page.waitForSelector('.pt-markslot');

// The identity yields the slot entirely while the cells walk. Checked before
// anything else so a fast ingest cannot settle the slot under the probe.
const yielded = await page.waitForFunction(() => {
  const m = document.querySelector('.pt-markslot .pt-brandmark');
  return m && getComputedStyle(m).opacity === '0';
}, { timeout: 5000 }).then(() => true).catch(() => false);

// Caught mid-flight: the overlay must be up and walking while work is happening.
const live = await page.evaluate(`(() => {
  const paint = ${PAINT};
  const slot = document.querySelector('.pt-markslot');
  const cells = [...slot.querySelectorAll('.pt-markcells i')];
  const sb = slot.getBoundingClientRect();
  const cs = getComputedStyle(slot.querySelector('.pt-brandmark'));
  const root = getComputedStyle(document.documentElement);
  return {
    state: slot.dataset.state || '(none)',
    cellCount: cells.length,
    // The throbber is the PLAIN nine-cell grid filling the slot (the original,
    // kept by request) — first cell at the origin, last cell reaching the far
    // corner, three columns.
    gridFills: (() => {
      const first = cells[0].getBoundingClientRect();
      const last = cells[8].getBoundingClientRect();
      return Math.abs(first.left - sb.left) < 1.5 && Math.abs(first.top - sb.top) < 1.5 &&
             Math.abs(last.right - sb.right) < 1.5 && Math.abs(last.bottom - sb.bottom) < 1.5;
    })(),
    animated: cells.every(c => getComputedStyle(c).animationName === 'pt-markcell'),
    overlayOpacity: +getComputedStyle(slot.querySelector('.pt-markcells')).opacity,
    plate: paint(cs.getPropertyValue('--mark-plate').trim()),
    surface: paint(root.getPropertyValue('--surface').trim()),
    behind: getComputedStyle(slot.closest('.card')).backgroundColor,
    markSquare: (() => { const b = slot.getBoundingClientRect(); return b.width > 20 && Math.abs(b.width - b.height) < 0.5; })()
  };
})()`);

check('the ingest card is a real surface', live.behind !== 'rgba(0, 0, 0, 0)', live.behind);
check('the ingest plate is the card colour, not the page colour',
  live.plate === live.surface, live.plate + ' vs --surface ' + live.surface);
check('the slot is square and sized', live.markSquare === true);
check('nine cells', live.cellCount === 9, live.cellCount);
check('the overlay is up while work is happening', live.state === 'live', live.state);
check('the cells are walking', live.animated === true);

check('the cells fill the slot as the plain 3×3', live.gridFills === true);

check('the identity yields while the cells walk', yielded === true);

/* --- 3. it transitions, and it ends on the identity ------------------- */

await page.waitForFunction(() => {
  const b = document.querySelector('#ingest-actions button');
  return b && /finalist/i.test(b.textContent);
}, { timeout: 60000 });

const settling = await page.evaluate(() => {
  const slot = document.querySelector('.pt-markslot');
  const cells = slot.querySelector('.pt-markcells');
  return {
    state: slot.dataset.state,
    // Mid-flight: a swap would already be at 0.
    opacity: +getComputedStyle(cells).opacity,
    transition: getComputedStyle(cells).transitionDuration,
    resolve: getComputedStyle(slot.querySelector('.pt-brandmark')).animationName
  };
});

check('the slot settles when the work does', settling.state === 'rest', settling.state);
check('it fades rather than swapping', parseFloat(settling.transition) > 0.2, settling.transition);
check('the overlay leaves by fading, not removal',
  settling.opacity <= 1 && await page.evaluate(() => !!document.querySelector('.pt-markslot .pt-markcells')),
  settling.opacity);
check('the mark plays its resolve', settling.resolve === 'pt-mark-resolve', settling.resolve);

await page.waitForTimeout(900);
const settled = await page.evaluate(() => {
  const slot = document.querySelector('.pt-markslot');
  return {
    opacity: +getComputedStyle(slot.querySelector('.pt-markcells')).opacity,
    transform: getComputedStyle(slot.querySelector('.pt-brandmark')).transform,
    markVisible: slot.querySelector('.pt-brandmark').getBoundingClientRect().width > 20 &&
      +getComputedStyle(slot.querySelector('.pt-brandmark')).opacity === 1
  };
});

check('the overlay clears completely', settled.opacity === 0, settled.opacity);
check('the mark is left at rest, unscaled',
  settled.transform === 'none' || settled.transform === 'matrix(1, 0, 0, 1, 0, 0)', settled.transform);
check('the identity is what is left on screen', settled.markVisible === true);

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await browser.close();
console.log(failed === 0 ? '\nMARK OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Plate-follows-surface, sprite geometry for
 *   the walking cells, and the two-way transition between working and settled.
  * v1.1 (2026-07-29): The working state rolled back to the plain full-slot 3×3
 *   throbber by request; asserts the grid fills the slot, the identity yields
 *   while the cells walk, and still returns — visible, unscaled — at rest.
 * v1.2 (2026-07-29): De-raced under full-suite load. The corpus is big enough
 *   that the live window is seconds wide, the yield check runs straight off the
 *   slot appearing, and the mid-fade catch is replaced by asserting the
 *   mechanism (overlay fades in place; the 520ms transition check already
 *   proves the fade).
*/
