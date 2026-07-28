/**
 * file: e2e_flow.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Drives the built artifact through entry, ingest, and the allocation tree in real Chromium, using synthetic images fed through the loose-file input.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Uses the loose-file path rather than the folder picker, because a native
 * directory dialog cannot be completed headlessly. That path exercises the same
 * triage, worker pool, tree construction and allocation UI; only the
 * FileSystemDirectoryHandle differs. The picker itself needs a human.
 *
 * Run: node tests/e2e_flow.mjs
 */

import { chromium } from 'playwright';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT = path.join(ROOT, 'dist', 'photournament_v1.0.html');
if (!existsSync(ARTIFACT)) { console.error('run: node tools/build.mjs'); process.exit(1); }

/* -------------------------------------------------- minimal PNG encoder --- */

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

/** A small RGB PNG with a deterministic pattern, so hashes differ between seeds. */
function makePng(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  let s = seed * 2654435761 >>> 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      raw[p++] = (x * 7 + seed * 13 + (s >>> 24)) & 0xff;
      raw[p++] = (y * 5 + seed * 29) & 0xff;
      raw[p++] = ((x ^ y) + seed * 3) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Mirrors the shape of the user's real folder: mostly stills across a few day
 * folders, plus video files that must be counted and skipped rather than
 * treated as failures.
 */
function buildCorpus() {
  const files = [];
  const add = (dir, n, ext, mime, seedBase) => {
    for (let i = 0; i < n; i++) {
      files.push({
        name: `${dir}/IMG_${seedBase + i}.${ext}`,
        mimeType: mime,
        buffer: ext === 'mp4' || ext === 'mov'
          ? Buffer.from('\0\0\0\x18ftypmp42fake video payload')
          : makePng(160, 120, seedBase + i)
      });
    }
  };
  // The five folders of the PRD 4.3 worked example, so the allocation assertions
  // below reproduce the documented result exactly. Day4 exists to be excluded.
  add('Trip/Day1', 12, 'png', 'image/png', 100);
  add('Trip/Day2', 16, 'png', 'image/png', 200);
  add('Trip/Day3', 20, 'png', 'image/png', 300);
  add('Trip/Day4', 10, 'png', 'image/png', 500);
  add('Trip/Misc', 8, 'png', 'image/png', 400);
  add('Trip/Day1', 5, 'mp4', 'video/mp4', 900);
  add('Trip/Day2', 3, 'mov', 'video/quicktime', 950);
  return files;
}

/* ------------------------------------------------------------------ run --- */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

await page.goto('file://' + ARTIFACT);
await page.waitForSelector('#pick-folder', { timeout: 10000 });
check('entry screen renders', true);

const corpus = buildCorpus();
const images = corpus.filter((f) => f.mimeType.startsWith('image/')).length;
const videos = corpus.length - images;

// webkitRelativePath cannot be synthesised, so the corpus is written to a real
// temp directory and handed to the webkitdirectory input. That is also the exact
// path a user without the File System Access API takes.
const tmp = path.join(os.tmpdir(), 'pt-e2e-' + Date.now());
for (const f of corpus) {
  const abs = path.join(tmp, f.name);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, f.buffer);
}
await page.setInputFiles('#dir-files', tmp);

await page.waitForFunction(() => {
  const b = document.querySelector('#ingest-actions button');
  return b && /finalist/i.test(b.textContent);
}, { timeout: 90000 });

const ingested = await page.evaluate(() => {
  const s = window.PT.store.get();
  const ids = Object.keys(s.photos);
  return {
    total: ids.length,
    ok: ids.filter((i) => !s.photos[i].err).length,
    withThumb: Object.keys(s.derivatives).length,
    withHash: ids.filter((i) => s.photos[i].phash).length,
    summary: document.getElementById('ingest-summary').textContent
  };
});

check('all images ingested', ingested.ok === images, `${ingested.ok}/${images}`);
check('thumbnails generated', ingested.withThumb === images, `${ingested.withThumb}/${images}`);
check('perceptual hashes computed', ingested.withHash === images, `${ingested.withHash}/${images}`);
check('videos counted and skipped, not failed',
  new RegExp(`${videos} video file`).test(ingested.summary), `${videos} expected`);
check('videos never entered the photo set', ingested.total === images, `${ingested.total} records`);

await page.click('#ingest-actions button');
await page.waitForSelector('#tree-host .tree-row', { timeout: 10000 });

const rows = await page.$$eval('#tree-host .tree-row', (els) =>
  els.map((e) => e.querySelector('.tree-name').textContent.trim()));
check('tree renders every folder', rows.length >= 5, rows.join(', '));

// Reproduce the PRD 4.3 worked example through the actual UI.
const setAlloc = async (name, value) => {
  await page.evaluate(({ name, value }) => {
    const rows = Array.from(document.querySelectorAll('#tree-host .tree-row'));
    const row = rows.find((r) => r.querySelector('.tree-name').textContent.trim() === name);
    const input = row.querySelector('.tree-alloc');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { name, value });
};

await setAlloc('Trip', '20');
await setAlloc('Day1', '5');
await setAlloc('Day2', '5');
await setAlloc('Day4', '0');

const resolved = await page.evaluate(() => {
  const s = window.PT.store.get();
  const r = window.PT.tree.resolve(s.tree, s.session.allocs);
  return {
    total: r.projectedTotal, units: r.units.length, errors: r.hasErrors,
    pooled: (r.units.find((u) => u.kind === 'pooled') || {}).target
  };
});

check('projected total is 20', resolved.total === 20, resolved.total);
check('pooled remainder is 10', resolved.pooled === 10, resolved.pooled);
check('no allocation errors', resolved.errors === false, resolved.errors);

// Typing a two-digit number must actually land. The tree re-renders on every
// keystroke, and if that re-render steals focus from the field being typed into,
// only the first digit survives — which is invisible in code review and obvious
// the moment a person types "12".
await page.evaluate(() => {
  const row = Array.from(document.querySelectorAll('#tree-host .tree-row'))
    .find((r) => (r.querySelector('.tree-name') || {}).textContent?.trim() === 'Day3');
  row.querySelector('.tree-alloc').focus();
});
await page.keyboard.type('12', { delay: 40 });
const twoDigit = await page.evaluate(() => {
  const row = Array.from(document.querySelectorAll('#tree-host .tree-row'))
    .find((r) => (r.querySelector('.tree-name') || {}).textContent?.trim() === 'Day3');
  const inp = row.querySelector('.tree-alloc');
  const s = window.PT.store.get();
  // The path is whatever the chosen root was called, so read it off the field
  // rather than assuming it.
  return { field: inp.value, path: inp.dataset.path, stored: s.session.allocs[inp.dataset.path] };
});
check('a two-digit number can be typed into the tree', twoDigit.field === '12', twoDigit.field);
check('the two-digit value reaches the store', (twoDigit.stored || {}).value === 12,
  JSON.stringify(twoDigit.stored));

// Put it back so the assertions below still describe the PRD 4.3 example.
await page.evaluate(() => {
  const row = Array.from(document.querySelectorAll('#tree-host .tree-row'))
    .find((r) => (r.querySelector('.tree-name') || {}).textContent?.trim() === 'Day3');
  const i = row.querySelector('.tree-alloc');
  i.value = '';
  i.dispatchEvent(new Event('input', { bubbles: true }));
});

const startEnabled = await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('#tree-footer button'))
    .find((x) => /Start culling/.test(x.textContent));
  return b ? !b.disabled : null;
});
check('start button enabled once valid', startEnabled === true, startEnabled);

// An oversubscribed tree must block the start button (PRD 4.5).
// The values must be within each folder's photo count, because clamping applies
// first: asking Day1 for 18 out of 12 clamps to 12 and never oversubscribes.
// Day1 holds 12 and Day2 holds 16, so 12 + 16 = 28 against a parent of 20.
await setAlloc('Day1', '12');
await setAlloc('Day2', '16');
const blocked = await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('#tree-footer button'))
    .find((x) => /Start culling/.test(x.textContent));
  return { disabled: b.disabled, issues: document.getElementById('tree-issues').textContent };
});
check('oversubscription blocks the start', blocked.disabled === true, blocked.disabled);
check('oversubscription is explained', /more than/.test(blocked.issues),
  blocked.issues.slice(0, 90));

await setAlloc('Day1', '5');
await setAlloc('Day2', '5');
check('zero console errors through the whole flow', errors.length === 0,
  errors.length ? '\n  ' + errors.slice(0, 5).join('\n  ') : '0');

await browser.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nE2E OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Entry, ingest with mixed image and video
 *   corpus, triage assertions, tree rendering, the PRD 4.3 worked example driven
 *   through the UI, and oversubscription blocking.
 */
