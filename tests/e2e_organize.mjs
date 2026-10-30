/**
 * file: e2e_organize.mjs
 * version: 1.1
 * author: Samuel Cao
 * created: 2026-10-30
 * last_updated: 2026-10-30
 * description: Organize-by inside culling (PRD 7.12): a flat roll regrouped by day on the allocation screen, the reset warning, one tournament per group, result sets named for their group, tags on finalists becoming a per-tag set in the CSV and the zip, the latent same-leaf folder clash, and tagging from a bracket pane without casting a vote.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * The invariant under test: organizing changes WHICH photos compete together
 * and nothing else. Tags ride along to the export and never decide a match.
 *
 * Run: node tests/e2e_organize.mjs
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { deflateSync } from 'node:zlib';
import { makeTiff, makeXmp, pngWith } from './lib/exif_fixture.mjs';

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

// One flat folder, three days, two photos a day: exactly the shape that used
// to get a single quota.
const tmp = path.join(os.tmpdir(), 'pt-org-' + Date.now());
mkdirSync(path.join(tmp, 'Roll'), { recursive: true });
for (let k = 0; k < 6; k++) {
  const tiff = makeTiff({ make: 'Canon', model: k % 2 ? 'Canon EOS R6' : 'Canon EOS R5', when: `2026:07:${14 + (k >> 1)} 1${k}:00:00` });
  writeFileSync(path.join(tmp, 'Roll', `IMG_${k}.png`), pngWith(pngBoard(160, 120, k + 3), { tiff }));
}

// The latent clash: two folders whose leaves share a name.
const clash = path.join(os.tmpdir(), 'pt-clash-' + Date.now());
['Day1/Canon', 'Day2/Canon'].forEach((d, j) => {
  mkdirSync(path.join(clash, d), { recursive: true });
  for (let k = 0; k < 2; k++) writeFileSync(path.join(clash, d, `C_${j}_${k}.png`), pngBoard(160, 120, 40 + k + j * 7));
});

// Non-Latin group names, carried in written XMP places on ASCII paths:
// Playwright cannot hand a page files from non-ASCII directory names.
const places = path.join(os.tmpdir(), 'pt-places-' + Date.now());
mkdirSync(places, { recursive: true });
['東京', '東京', '京都', '京都'].forEach((city, k) => {
  writeFileSync(path.join(places, `P_${k}.png`), pngWith(pngBoard(160, 120, 70 + k), { xmp: makeXmp({ city }) }));
});

function zipEntries(file) {
  const buf = readFileSync(file);
  const entries = [];
  let i = 0;
  while ((i = buf.indexOf('PK\x01\x02', i, 'binary')) !== -1) {
    const nameLen = buf.readUInt16LE(i + 28);
    entries.push(buf.slice(i + 46, i + 46 + nameLen).toString('utf8'));
    i += 46 + nameLen;
  }
  return entries;
}

/* ---------------------------------------------------------------- run --- */

async function open() {
  const profile = path.join(os.tmpdir(), 'pt-org-prof-' + Date.now() + Math.random());
  const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto('file://' + ARTIFACT);
  return { ctx, page, errors };
}

async function ingest(page, dir) {
  await page.setInputFiles('#dir-files', dir);
  await page.waitForFunction(() => {
    const b = document.querySelector('#ingest-actions button');
    return b && /finalist/i.test(b.textContent);
  }, { timeout: 60000 });
  await page.click('#ingest-actions button');
  await page.waitForSelector('.tree-row');
}

const rows = (page) => page.$$eval('input.tree-alloc[data-path]', (els) => els.map((e) => e.dataset.path));
const startCulling = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('button')).find((x) => /start culling/i.test(x.textContent) && !x.disabled).click());

async function finishAll(page) {
  for (let k = 0; k < 8; k++) {
    if (await page.evaluate(() => window.PT.store.get().session.stage) === 'export') return;
    await page.waitForSelector('#dupe-skip, [data-t="finish-early"]', { timeout: 15000 });
    if (await page.$('#dupe-skip')) { await page.click('#dupe-skip'); continue; }
    await page.click('[data-t="finish-early"]');
    await page.waitForSelector('[data-t="finish-early-confirm"]');
    await page.click('[data-t="finish-early-confirm"]');
    await page.waitForTimeout(300);
  }
  await page.waitForFunction(() => window.PT.store.get().session.stage === 'export', { timeout: 15000 });
}

/* --- A: a flat roll, organized by day ------------------------------------ */

{
  const { ctx, page, errors } = await open();
  await ingest(page, tmp);
  const r0 = await rows(page);
  check('a flat roll offers one folder to allocate', r0.length === 2 && r0[1].endsWith('/Roll'), r0.join(', '));

  await page.fill('input.tree-alloc[data-path$="/Roll"]', '2');
  await page.click('[data-t="tree-org"] [data-t="org-chosen"][data-cat="folder"] [data-t="org-remove"]');
  await page.waitForSelector('#modal[open] [data-t="org-confirm"]');
  check('regrouping with counts typed asks before clearing them', true);
  await page.click('[data-t="org-confirm"]');
  await page.waitForSelector('[data-t="tree-org"]');
  check('the counts were cleared on confirm',
    await page.evaluate(() => Object.keys(window.PT.store.get().session.allocs).length) === 0);
  check('emptying the row is one group, not a snap back to folders',
    JSON.stringify(await rows(page)) === JSON.stringify(['']), (await rows(page)).join(', '));

  await page.click('[data-t="tree-org"] [data-t="org-add"][data-cat="day"]');
  await page.waitForSelector('[data-t="tree-org"] [data-t="org-chosen"][data-cat="day"]');
  const r1 = await rows(page);
  check('Day gives a row per day, straight under the root',
    JSON.stringify(r1) === JSON.stringify(['', '2026-07-14', '2026-07-15', '2026-07-16']), r1.join(', '));
  check('the screen says group, not folder', /each group\?/.test(await page.textContent('h1')));

  await page.fill('#tree-all-input', '1');
  await page.click('#tree-all-apply');
  await startCulling(page);
  await page.waitForSelector('#dupe-skip, [data-t="finish-early"]', { timeout: 30000 });
  const units = await page.evaluate(() => Object.values(window.PT.store.get().session.units).map((u) => u.label + ':' + u.allIds.length).sort());
  check('one tournament per day, each with that day\'s photos',
    JSON.stringify(units) === JSON.stringify(['2026-07-14:2', '2026-07-15:2', '2026-07-16:2']), units.join(' '));

  await finishAll(page);
  const sets = await page.$$eval('[data-t="exp-set"]', (els) => els.map((e) => e.dataset.folder + '|' + e.querySelector('h2').textContent));
  check('result sets are named for their group',
    JSON.stringify(sets) === JSON.stringify(['_finalists_2026-07-14|2026-07-14', '_finalists_2026-07-15|2026-07-15', '_finalists_2026-07-16|2026-07-16']),
    sets.join(' '));

  // Tag the first finalist in the review, then a second through Shift-free clicking.
  await page.click('[data-t="exp-set"] [data-t="tag-add"]');
  await page.fill('[data-t="exp-set"] [data-t="tag-new"]', 'print');
  await page.press('[data-t="exp-set"] [data-t="tag-new"]', 'Enter');
  await page.click('[data-t="exp-set"] >> nth=2 >> [data-t="tag"][data-tag="print"] >> nth=0');
  check('two finalists carry the tag',
    await page.evaluate(() => Object.keys(window.PT.store.get().session.tags.on).length) === 2);

  check('the per-tag option appears as soon as the first tag exists', await page.isVisible('[data-t="exp-tagsets"]'));
  await page.check('[data-t="exp-tagsets"] input');
  await page.waitForSelector('[data-t="exp-set"][data-folder="_tagged_print"]');
  check('a set per tag lists exactly the tagged finalists',
    (await page.$$('[data-t="exp-set"][data-folder="_tagged_print"] .exp-row')).length === 2);

  const [dlCsv] = await Promise.all([page.waitForEvent('download'), page.click('[data-t="exp-csv"]')]);
  const csvPath = path.join(os.tmpdir(), 'pt-org-' + Date.now() + '.csv');
  await dlCsv.saveAs(csvPath);
  const csv = readFileSync(csvPath, 'utf8').trim().split('\r\n');
  check('the finalists CSV has a row per exported file, tag set included', csv.length === 1 + 6 + 2, csv.length + ' lines');
  check('with tags and capture time', csv.some((l) => l.includes(',print,2026-07-1')), csv[1]);

  const [dlZip] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }),
    page.evaluate(() => Array.from(document.querySelectorAll('button')).find((b) => /one \.zip/i.test(b.textContent)).click())]);
  const zipPath = path.join(os.tmpdir(), 'pt-org-' + Date.now() + '.zip');
  await dlZip.saveAs(zipPath);
  const entries = zipEntries(zipPath);
  check('the zip holds the group folders and the tag folder',
    entries.length === 8 && entries.filter((e) => e.startsWith('_tagged_print/')).length === 2 &&
    entries.some((e) => e.startsWith('_finalists_2026-07-15/')), entries.join(', '));

  await page.selectOption('select:has(option[value="flat"])', 'flat');
  const [dlFlat] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }),
    page.evaluate(() => Array.from(document.querySelectorAll('button')).find((b) => /one \.zip/i.test(b.textContent)).click())]);
  const flatPath = path.join(os.tmpdir(), 'pt-org-flat-' + Date.now() + '.zip');
  await dlFlat.saveAs(flatPath);
  const flat = zipEntries(flatPath);
  check('flattening merges the result sets but keeps the per-tag copies apart',
    flat.length === 8 && new Set(flat).size === 8 && flat.filter((e) => e.startsWith('_finalists/')).length === 6 &&
    flat.filter((e) => e.startsWith('_tagged_print/')).length === 2, flat.join(', '));

  check('zero console errors (organized run)', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');
  await ctx.close();
}

/* --- B: folders with the same leaf name no longer share an output folder -- */

{
  const { ctx, page, errors } = await open();
  await ingest(page, clash);
  await page.fill('#tree-all-input', '1');
  await page.click('#tree-all-apply');
  await startCulling(page);
  await finishAll(page);
  const folders = await page.$$eval('[data-t="exp-set"]', (els) => els.map((e) => e.dataset.folder).sort());
  check('Day1/Canon and Day2/Canon write to different folders',
    folders.length === 2 && folders.filter((f) => /Day1_Canon$/.test(f)).length === 1 && folders.filter((f) => /Day2_Canon$/.test(f)).length === 1,
    folders.join(', '));
  check('zero console errors (clash)', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');
  await ctx.close();
}

{
  const { ctx, page, errors } = await open();
  await ingest(page, places);
  await page.click('[data-t="tree-org"] [data-t="org-chosen"][data-cat="folder"] [data-t="org-remove"]');
  await page.waitForSelector('[data-t="tree-org"]');
  await page.click('[data-t="tree-org"] [data-t="org-add"][data-cat="location"]');
  await page.waitForSelector('[data-t="tree-org"] [data-t="org-chosen"][data-cat="location"]');
  await page.fill('#tree-all-input', '1');
  await page.click('#tree-all-apply');
  await startCulling(page);
  await finishAll(page);
  const folders = await page.$$eval('[data-t="exp-set"]', (els) => els.map((e) => e.dataset.folder).sort());
  check('non-Latin group names keep their own folders instead of collapsing to "_"',
    JSON.stringify(folders) === JSON.stringify(['_finalists_京都', '_finalists_東京']), folders.join(', '));
  check('zero console errors (places)', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');
  await ctx.close();
}

/* --- D: naming an event after counts are typed still asks, then sticks --- */

{
  const { ctx, page, errors } = await open();
  await ingest(page, tmp);
  await page.click('[data-t="tree-org"] [data-t="org-chosen"][data-cat="folder"] [data-t="org-remove"]');
  await page.waitForSelector('[data-t="tree-org"]');
  await page.click('[data-t="tree-org"] [data-t="org-add"][data-cat="event"]');
  await page.waitForSelector('[data-t="tree-org"] [data-t="org-chosen"][data-cat="event"]');
  await page.fill('#tree-all-input', '1');
  await page.click('#tree-all-apply');
  await page.click('[data-t="org-name"]');
  await page.waitForSelector('#modal[open] [data-t="org-name-input"]');
  await page.fill('#modal [data-t="org-name-input"] >> nth=0', 'Breakfast');
  await page.click('[data-t="org-name-save"]');
  const asked = await page.waitForSelector('#modal[open] [data-t="org-confirm"]', { timeout: 5000 }).then(() => true, () => false);
  check('saving names with counts typed asks before regrouping', asked);
  if (asked) await page.click('[data-t="org-confirm"]');
  await page.waitForSelector('[data-t="tree-org"]');
  check('and the name takes', (await rows(page)).includes('Breakfast'), (await rows(page)).join(', '));
  check('zero console errors (naming)', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');
  await ctx.close();
}

/* --- C: tagging from a bracket pane never casts a vote -------------------- */

{
  const { ctx, page, errors } = await open();
  await ingest(page, tmp);
  await page.click('[data-t="tree-org"] [data-t="org-chosen"][data-cat="folder"] [data-t="org-remove"]');
  await page.waitForSelector('[data-t="tree-org"]');
  await page.click('[data-t="tree-org"] [data-t="org-add"][data-cat="month"]');
  await page.waitForSelector('[data-t="tree-org"] [data-t="org-chosen"][data-cat="month"]');
  await page.fill('input.tree-alloc[data-path="2026-07"]', '3');
  await page.click('[data-t="rank-toggle"][data-path="2026-07"]');
  await startCulling(page);
  await page.waitForSelector('[data-t="rank-card"]', { timeout: 60000 });
  await page.click('[data-t="rank-opt-full"]');
  await page.click('[data-t="rank-start"]');
  await page.waitForSelector('.bk-vp');

  check('each bracket pane carries a tag row', (await page.$$('[data-t="bk-tags"]')).length === 2);
  const before = await page.evaluate(() => {
    const u = Object.values(window.PT.store.get().session.units)[0];
    // The bracket's decisions are its replayed ops; comparisons is their count.
    return JSON.stringify({ ops: u.bracket.ops, n: u.comparisons });
  });
  await page.click('[data-t="bk-tags"] >> nth=1 >> [data-t="tag-add"]');
  await page.fill('[data-t="bk-tags"] [data-t="tag-new"]', 'family');
  await page.press('[data-t="bk-tags"] [data-t="tag-new"]', 'Enter');
  const after = await page.evaluate(() => {
    const s = window.PT.store.get();
    const u = Object.values(s.session.units)[0];
    return { log: JSON.stringify({ ops: u.bracket.ops, n: u.comparisons }), tagged: Object.keys(s.session.tags.on).length };
  });
  check('the tag lands on the photo in that pane', after.tagged === 1);
  check('and no match was decided by it', after.log === before && /"ops":\[/.test(before), before);
  // Control: a real choice DOES change that record, so the check above can fail.
  await page.keyboard.press('ArrowLeft');
  const chose = await page.evaluate(() => Object.values(window.PT.store.get().session.units)[0].comparisons);
  check('while an actual choice is recorded', chose === 1, String(chose));
  check('zero console errors (bracket)', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');
  await ctx.close();
}

console.log(failed === 0 ? '\nORGANIZE OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-10-30): Initial release.
 * v1.1 (2026-10-30): Review fixes covered: resume scope, keyboard open,
 *   resumable never-overwrite copies, the copied column, the BOM, non-Latin
 *   folder names, flatten with tag sets, naming with counts typed.
 */
