/**
 * file: e2e_applyall.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-29
 * last_updated: 2026-07-29
 * description: Verifies the allocation broadcast: one count or one share applied to every photo-holding folder, containers left as pass-through, totals correct, invalid input refused, and blank resetting the slate.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Run: node tests/e2e_applyall.mjs
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
function chunk(t, d) {
  const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t, 'ascii'), d]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td));
  return Buffer.concat([l, td, cr]);
}
/** Block-board PNGs with provable pairwise separation (see e2e_resume). */
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const bits = ((seed * 2654435761) >>> 16) & 0xffff;
  let p = 0, s = (seed * 2654435761) >>> 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    const by = Math.min(3, (y * 4 / h) | 0);
    for (let x = 0; x < w; x++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const bx = Math.min(3, (x * 4 / w) | 0);
      const v = (((bits >> (by * 4 + bx)) & 1) ? 196 : 52) + ((s >>> 24) - 128) * 0.08;
      const c = (q) => (q < 0 ? 0 : q > 255 ? 255 : q | 0);
      raw[p++] = c(v + ((seed * 13) % 40));
      raw[p++] = c(v * 0.9 + ((seed * 29) % 50));
      raw[p++] = c(v * 0.8 + ((x ^ y) & 15));
    }
  }
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

// Uneven folders, so a count clamps somewhere and a share differs per folder.
const SHAPE = { 'Trip/Day1': 8, 'Trip/Day2': 4, 'Trip/Day3': 2 };
const tmp = path.join(os.tmpdir(), 'pt-all-' + Date.now());
let n = 0;
for (const [dir, count] of Object.entries(SHAPE)) {
  mkdirSync(path.join(tmp, dir), { recursive: true });
  for (let k = 0; k < count; k++) {
    writeFileSync(path.join(tmp, dir, `p${n}.png`), png(120, 90, n));
    n++;
  }
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
await page.waitForSelector('#tree-all-input');

/** The resolution as the store sees it, keyed by folder name. */
const snap = () => page.evaluate(() => {
  const s = window.PT.store.get();
  const res = window.PT.tree.resolve(s.tree, s.session.allocs);
  const out = { targets: {}, allocs: {}, total: res.projectedTotal, errors: res.hasErrors };
  Object.keys(res.nodes).forEach((p) => {
    const node = res.nodes[p];
    if (s.tree.nodes[p].photoIds.length > 0) {
      out.targets[node.name] = node.target;
      out.allocs[node.name] = node.alloc.mode + ':' + node.alloc.value;
    }
  });
  return out;
});

/* --- the same count from every folder ------------------------------------ */

await page.fill('#tree-all-input', '3');
await page.click('#tree-all-apply');
const fixed = await snap();
check('a count reaches every photo-holding folder',
  fixed.allocs.Day1 === 'fixed:3' && fixed.allocs.Day2 === 'fixed:3' && fixed.allocs.Day3 === 'fixed:3',
  JSON.stringify(fixed.allocs));
check('small folders clamp instead of erroring',
  fixed.targets.Day1 === 3 && fixed.targets.Day2 === 3 && fixed.targets.Day3 === 2 && !fixed.errors,
  JSON.stringify(fixed.targets));
check('the projected total is the honest sum', fixed.total === 8, fixed.total);

/* --- the same share of every folder -------------------------------------- */

await page.fill('#tree-all-input', '50%');
await page.click('#tree-all-apply');
const pct = await snap();
check('a share reaches every folder as a share',
  Object.values(pct.allocs).every((a) => a === 'percent:50'), JSON.stringify(pct.allocs));
check('each folder resolves against its own count',
  pct.targets.Day1 === 4 && pct.targets.Day2 === 2 && pct.targets.Day3 === 1,
  JSON.stringify(pct.targets));
check('the share total sums per folder', pct.total === 7, pct.total);

/* --- a broadcast replaces, never layers ---------------------------------- */

const containerClean = await page.evaluate(() => {
  const s = window.PT.store.get();
  return Object.keys(s.session.allocs).every((p) => s.tree.nodes[p].photoIds.length > 0);
});
check('containers stay blank pass-through', containerClean === true);

/* --- garbage is refused, the last good state stands ----------------------- */

await page.fill('#tree-all-input', 'abc');
await page.click('#tree-all-apply');
const refused = await page.evaluate(() => ({
  invalid: document.getElementById('tree-all-input').classList.contains('invalid'),
  still: Object.values(window.PT.store.get().session.allocs).every((a) => a.mode === 'percent')
}));
check('garbage is refused and marked', refused.invalid === true && refused.still === true,
  JSON.stringify(refused));

/* --- blank resets the slate ---------------------------------------------- */

await page.fill('#tree-all-input', '');
await page.click('#tree-all-apply');
const cleared = await page.evaluate(() => Object.keys(window.PT.store.get().session.allocs).length);
check('blank resets every folder to competing', cleared === 0, cleared + ' allocs left');

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await browser.close();
console.log(failed === 0 ? '\nAPPLY-ALL OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-29): Initial release. Count and share broadcasts, per-folder
 *   resolution, container pass-through, refusal of garbage, blank reset.
 */
