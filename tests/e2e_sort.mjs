/**
 * file: e2e_sort.mjs
 * version: 1.1
 * author: Samuel Cao
 * created: 2026-10-30
 * last_updated: 2026-10-30
 * description: Sort mode end to end (PRD 7.12): capture metadata read at ingest, the Organize-by control regrouping a whole shoot, written place names and GPS clusters, selection and tagging, the lightbox metadata row and Shift+digit, both exports (the list parsed; the organized copy written for real and never overwritten), and resume.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Served over localhost rather than file://, for one reason: the copy export
 * writes through a directory handle, the native picker cannot be driven
 * headlessly, and the origin-private file system (which speaks the same
 * handle API) refuses file://. Everything else behaves identically served.
 *
 * Run: node tests/e2e_sort.mjs
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { deflateSync } from 'node:zlib';
import { makeTiff, makeXmp, jpegWith, pngWith } from './lib/exif_fixture.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT = path.join(ROOT, 'dist', 'photournament_v1.0.html');
if (!existsSync(ARTIFACT)) { console.error('run: node tools/build.mjs'); process.exit(1); }

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

/* ------------------------------------------------------------- fixture --- */

// The block-board generator: provably distinct images (see e2e_zip.mjs), so
// nothing here depends on how the perceptual hash happens to cluster.
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

// A plausible two-camera trip. Coordinates are public landmarks, not anyone's.
const KYOTO = { lat: 35.0116, lon: 135.7681 };
const OSAKA = { lat: 34.6937, lon: 135.5023 };
const SHOTS = [
  { make: 'Canon', model: 'Canon EOS R6', when: '2026:07:14 09:12:33', fl: 35, ...KYOTO },
  { make: 'Canon', model: 'Canon EOS R6', when: '2026:07:14 09:40:00', fl: 85, lat: 35.0121, lon: 135.7690 },
  { make: 'Apple', model: 'iPhone 15 Pro', when: '2026:07:14 15:00:00', fl35: 24, ...OSAKA },
  { make: 'Apple', model: 'iPhone 15 Pro', when: '2026:07:15 10:00:00', fl35: 24, lat: 34.6940, lon: 135.5030 },
  { make: 'Canon', model: 'Canon EOS R6', when: '2026:07:15 10:05:00', fl: 200 },
  null,                                                     // no metadata at all
  { make: 'Apple', model: 'iPhone 15 Pro', when: '2026:07:16 08:00:00', fl35: 13, xmp: { city: 'Nara', country: 'Japan' } }
];

const tmp = path.join(os.tmpdir(), 'pt-sort-' + Date.now());
mkdirSync(path.join(tmp, 'DCIM'), { recursive: true });
SHOTS.forEach((f, k) => {
  const png = pngBoard(160, k === 2 ? 220 : 120, k + 11);
  const bytes = f ? pngWith(png, { tiff: makeTiff(f), xmp: f.xmp ? makeXmp(f.xmp) : undefined }) : png;
  writeFileSync(path.join(tmp, 'DCIM', `IMG_${1000 + k}.png`), bytes);
});

/* ---------------------------------------------------------------- run --- */

const server = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(readFileSync(ARTIFACT));
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const URL0 = 'http://127.0.0.1:' + server.address().port + '/';

const profile = path.join(os.tmpdir(), 'pt-sort-prof-' + Date.now());
const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1400, height: 950 }, acceptDownloads: true });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL0);

/* --- the job is chosen before the photos arrive --------------------------- */

await page.click('[data-t="mode-sort"]');
check('choosing Sort and tag says nothing will be cut',
  /Nothing is cut/.test(await page.textContent('#entry-lede')));

await page.setInputFiles('#dir-files', tmp);
await page.waitForSelector('[data-t="to-sort"]', { timeout: 60000 });

const caps = await page.evaluate(() => {
  const ph = window.PT.store.get().photos;
  return Object.values(ph).sort((a, b) => a.name < b.name ? -1 : 1).map((p) => p.capture);
});
check('every photo carries a capture record, empty where the file had none',
  caps.length === 7 && caps.every((c) => c && typeof c === 'object') && Object.keys(caps[5]).length === 0);
check('capture time, camera and GPS are read off the file at ingest',
  caps[0].when === '2026-07-14T09:12:33' && caps[0].model === 'Canon EOS R6' && Math.abs(caps[0].lat - 35.0116) < 1e-4,
  JSON.stringify(caps[0]));
check('a written place name is read from XMP', caps[6].city === 'Nara' && caps[6].country === 'Japan');

await page.click('[data-t="to-sort"]');
await page.waitForSelector('[data-t="so-group"]');

const groups = () => page.$$eval('[data-t="so-group"]', (els) =>
  els.map((e) => e.dataset.dir + ':' + e.querySelectorAll('[data-t="so-cell"]').length));

const g0 = await groups();
check('a dated camera roll opens grouped by day, undated last',
  JSON.stringify(g0) === JSON.stringify(['2026-07-14:3', '2026-07-15:2', '2026-07-16:1', 'No date:1']), g0.join(' '));

/* --- regroup: Day > Camera, then Camera > Location ------------------------ */

await page.click('[data-t="org-add"][data-cat="camera"]');
const g1 = await groups();
check('adding Camera nests it under Day',
  g1.includes('2026-07-14/Canon EOS R6:2') && g1.includes('2026-07-14/Apple iPhone 15 Pro:1') && g1.includes('No date/Unknown camera:1'),
  g1.join(' '));

await page.click('[data-t="org-chosen"][data-cat="camera"] [data-t="org-left"]');
const g2 = await groups();
check('moving Camera up a level swaps the nesting', g2.includes('Canon EOS R6/2026-07-14:2'), g2.join(' '));

await page.click('[data-t="org-chosen"][data-cat="day"] [data-t="org-remove"]');
await page.click('[data-t="org-add"][data-cat="location"]');
const g3 = await groups();
check('GPS photos within the radius share a place; a written name is its own group',
  g3.includes('Canon EOS R6/Near 35.01N 135.77E:2') &&
  g3.includes('Apple iPhone 15 Pro/Near 34.69N 135.50E:2') &&
  g3.includes('Apple iPhone 15 Pro/Nara, Japan:1') &&
  g3.includes('Canon EOS R6/No location:1'), g3.join(' '));

/* --- naming a place renames its folder ------------------------------------ */

await page.click('[data-t="org-name"]');
await page.waitForSelector('#modal[open] [data-t="org-name-input"]');
await page.fill('#modal [data-t="org-name-input"] >> nth=0', 'Gion');
await page.click('[data-t="org-name-save"]');
const g4 = await groups();
check('a named place becomes the folder name', g4.includes('Canon EOS R6/Gion:2'), g4.join(' '));

/* --- select, tag, and the tag never touches anything else ----------------- */

await page.click('[data-t="so-group"][data-dir="Canon EOS R6/Gion"] [data-t="so-select-group"]');
check('select group selects exactly its photos',
  (await page.textContent('[data-t="so-sel-count"]')).startsWith('2 selected'));
await page.click('[data-t="so-selbar"] [data-t="tag-add"]');
await page.fill('[data-t="so-selbar"] [data-t="tag-new"]', 'portfolio');
await page.press('[data-t="so-selbar"] [data-t="tag-new"]', 'Enter');
const tagged = await page.evaluate(() => {
  const t = window.PT.store.get().session.tags;
  return { defs: t.defs.map((d) => d.name), on: Object.keys(t.on).length };
});
check('a new tag is created and applied to the whole selection in one step',
  tagged.defs.join() === 'portfolio' && tagged.on === 2, JSON.stringify(tagged));
check('the tag shows under each tagged photo',
  (await page.$$('[data-t="so-group"][data-dir="Canon EOS R6/Gion"] .so-tag')).length === 2);

await page.keyboard.press('Escape');
await page.click('[data-t="so-group"][data-dir="Apple iPhone 15 Pro/Nara, Japan"] [data-t="so-cell"]');
await page.keyboard.press('Shift+Digit1');
check('Shift+1 applies the first tag to the selection',
  await page.evaluate(() => Object.keys(window.PT.store.get().session.tags.on).length) === 3);

/* --- the lightbox shows what the camera recorded, and tags ---------------- */

const selBefore = await page.textContent('[data-t="so-sel-count"]');
await page.focus('[data-t="so-group"][data-dir="Canon EOS R6/Gion"] [data-t="so-expand"] >> nth=0');
await page.keyboard.press('Enter');
await page.waitForSelector('#lightbox[open] [data-t="lb-info"]');
check('Enter on the expand button opens the photo and leaves the selection alone',
  await page.textContent('[data-t="so-sel-count"]') === selBefore);
const info = await page.textContent('#lightbox [data-t="lb-info"]');
check('the lightbox lists time, camera and settings', /2026-07-14 09:12:33/.test(info) && /Canon EOS R6/.test(info) && /35mm/.test(info), info);
await page.keyboard.press('Shift+Digit1');
check('Shift+1 in the lightbox toggles the tag off the shown photo',
  await page.evaluate(() => Object.keys(window.PT.store.get().session.tags.on).length) === 2);
await page.keyboard.press('Shift+Digit1');
await page.keyboard.press('Escape');

/* --- export: the list ----------------------------------------------------- */

await page.click('[data-t="so-export"]');
await page.waitForSelector('[data-t="so-exp-go"]');
await page.click('[data-t="so-exp-list"]');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-t="so-exp-go"]')]);
const csvPath = path.join(os.tmpdir(), 'pt-sort-' + Date.now() + '.csv');
await dl.saveAs(csvPath);
const csvRaw = readFileSync(csvPath, 'utf8');
check('the CSV opens as UTF-8 in Excel (BOM)', csvRaw.charCodeAt(0) === 0xfeff);
const csv = csvRaw.replace(/^\ufeff/, '').trim().split('\r\n');
check('the list is a CSV with a row per photo', csv.length === 8 && csv[0].startsWith('folder,file,original_path,tags,taken'),
  csv.length + ' lines');
const nara = csv.find((l) => l.includes('Nara'));
check('rows carry group, tags and place', !!nara && nara.startsWith('"Apple iPhone 15 Pro/Nara, Japan"') && nara.includes(',portfolio,'), nara);

/* --- export: the organized copy, for real, then never overwritten --------- */

await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  window.showDirectoryPicker = async () => root.getDirectoryHandle('out', { create: true });
});
await page.click('[data-t="so-exp-copy"]');
await page.check('[data-t="so-exp-tags"]');
const price = await page.textContent('label.so-exp-opt.on');
check('the copy option is priced before choosing', /7 photos, .*B \+ 3 tagged copies/.test(price), price.trim().slice(0, 80));
await page.click('[data-t="so-exp-go"]');
await page.waitForFunction(() => /^Copied/.test((document.querySelector('[data-t="so-exp-status"]') || {}).textContent || ''), { timeout: 30000 });

const listOut = () => page.evaluate(async () => {
  const out = [];
  async function walk(d, pre) {
    for await (const [n, h] of d.entries()) {
      if (h.kind === 'directory') await walk(h, pre + n + '/');
      else out.push(pre + n + ':' + (await h.getFile()).size);
    }
  }
  await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('out'), '');
  return out.sort();
});
const out1 = await listOut();
const names1 = out1.map((x) => x.split(':')[0]);
check('every photo is copied into its group folder',
  names1.includes('Canon EOS R6/Gion/IMG_1000.png') && names1.includes('Apple iPhone 15 Pro/Nara, Japan/IMG_1006.png') &&
  names1.includes('Unknown camera/No location/IMG_1005.png'), names1.join(' '));
check('each tag gets its own set, and the manifest sits beside them',
  names1.filter((n) => n.startsWith('_tagged_portfolio/')).length === 3 &&
  names1.includes('photournament_sort_manifest_v1.0.csv') && names1.includes('photournament_sort_manifest_v1.0.json'));
const srcSize = (n) => readFileSync(path.join(tmp, 'DCIM', n)).length;
check('copies are the originals, byte count for byte count',
  out1.filter((x) => /IMG_/.test(x)).every((x) => { const [p, n] = x.split(':'); return +n === srcSize(p.split('/').pop()); }));
check('12 files in all', out1.length === 12, String(out1.length));

const manifestCsv = await page.evaluate(async () => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('out');
  return (await (await d.getFileHandle('photournament_sort_manifest_v1.0.csv')).getFile()).text();
});
check('the copy manifest says which photos are in the folder',
  /,copied\r\n/.test(manifestCsv) && (manifestCsv.match(/,yes\r\n/g) || []).length === 7);

// A DIFFERENT file already holding one of the names, as after an edit.
await page.evaluate(async () => {
  const d = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('out'))
    .getDirectoryHandle('Canon EOS R6')).getDirectoryHandle('Gion');
  const w = await (await d.getFileHandle('IMG_1000.png')).createWritable();
  await w.write('someone else'); await w.close();
});
await page.evaluate(() => { document.querySelector('[data-t="so-exp-status"]').textContent = ''; });
await page.click('[data-t="so-exp-go"]');
await page.waitForFunction(() => /^Copied/.test(document.querySelector('[data-t="so-exp-status"]').textContent), { timeout: 30000 });
const out2 = await listOut();
const names2 = out2.map((x) => x.split(':')[0]);
check('running it again copies nothing already there, so a stopped export resumes',
  /9 were already there/.test(await page.textContent('[data-t="so-exp-status"]')), await page.textContent('[data-t="so-exp-status"]'));
check('and never overwrites a different file of the same name: it gets _2 beside it',
  names2.includes('Canon EOS R6/Gion/IMG_1000_2.png') &&
  out2.includes('Canon EOS R6/Gion/IMG_1000.png:12') && out2.length === 15, out2.length + ' files');
await page.click('[data-t="so-exp-close"]');

/* --- resume --------------------------------------------------------------- */

await page.waitForTimeout(700); // past the store's save debounce
await page.goto(URL0);
await page.waitForSelector('button:has-text("Resume")');
check('the resume card calls it sorting', /Sorting and tagging/.test(await page.textContent('#screen')));
await page.click('button:has-text("Resume")');
await page.waitForSelector('[data-t="so-group"]');
const g5 = await groups();
check('a resumed sort session comes back organized, names and all', g5.includes('Canon EOS R6/Gion:2'), g5.join(' '));
check('and tagged', (await page.$$('.so-tag')).length === 3);

/* --- a later session's resume shows only its own photos ------------------- */

const tmp2 = path.join(os.tmpdir(), 'pt-sort2-' + Date.now());
mkdirSync(tmp2, { recursive: true });
for (let k = 0; k < 2; k++) {
  writeFileSync(path.join(tmp2, `B_${k}.png`), pngWith(pngBoard(160, 120, 90 + k), { tiff: makeTiff({ when: '2026:08:01 10:0' + k + ':00' }) }));
}
await page.waitForTimeout(700);
await page.goto(URL0);
await page.waitForSelector('button:has-text("Start fresh")');
await page.click('button:has-text("Start fresh")');
await page.click('[data-t="mode-sort"]');
await page.setInputFiles('#dir-files', tmp2);
await page.waitForSelector('[data-t="to-sort"]', { timeout: 60000 });
await page.click('[data-t="to-sort"]');
await page.waitForSelector('[data-t="so-group"]');
await page.waitForTimeout(700);
await page.goto(URL0);
await page.waitForSelector('button:has-text("Resume")');
await page.click('button:has-text("Resume")');
await page.waitForSelector('[data-t="so-group"]');
check('resume brings back only this session\'s photos, not every photo ever cached',
  (await page.$$('[data-t="so-cell"]')).length === 2, String((await page.$$('[data-t="so-cell"]')).length));

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await ctx.close();
server.close();
console.log(failed === 0 ? '\nSORT OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-10-30): Initial release.
 * v1.1 (2026-10-30): Review fixes covered: resume scope, keyboard open,
 *   resumable never-overwrite copies, the copied column, the BOM, non-Latin
 *   folder names, flatten with tag sets, naming with counts typed.
 */
