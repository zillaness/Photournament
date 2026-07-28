/**
 * file: e2e_full.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Drives the built artifact through the entire prototype spine in real Chromium: ingest, allocation, Stage A grid passes, the bracket, and export review.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Deliberately UI-driven rather than API-driven. Calling PT functions directly
 * would prove the modules work while saying nothing about whether a person can
 * actually get from a folder to a finalist list, which is the only question that
 * matters for a prototype.
 *
 * Run: node tests/e2e_full.mjs
 */

import { chromium } from 'playwright';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT = path.join(ROOT, 'dist', 'photournament_v0.2.html');
if (!existsSync(ARTIFACT)) { console.error('run: node tools/build.mjs'); process.exit(1); }

/* --------------------------------------------------------- png generator -- */

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
function makePng(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0, s = (seed * 2654435761) >>> 0;
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
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ run --- */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const errors = [];
page.on('console', async (m) => {
  if (m.type() !== 'error') return;
  let where = '?';
  try { where = await page.evaluate(() => document.body.dataset.screen); } catch (e) { /* closing */ }
  errors.push('[' + where + '] ' + m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

/** Click the first enabled button whose text matches. */
async function clickText(re, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const done = await page.evaluate((src) => {
      const rx = new RegExp(src, 'i');
      const b = Array.from(document.querySelectorAll('button'))
        .find((x) => rx.test(x.textContent) && !x.disabled && x.offsetParent !== null);
      if (b) { b.click(); return true; }
      return false;
    }, re.source);
    if (done) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

const screenNow = () => page.evaluate(() => document.body.dataset.screen);

/** Printed when the driver gives up, so a stall names the screen it stalled on. */
async function dumpButtons(where) {
  const d = await page.evaluate(() => ({
    screen: document.body.dataset.screen,
    cells: document.querySelectorAll('.photo-cell').length,
    buttons: Array.from(document.querySelectorAll('button'))
      .filter((b) => b.offsetParent !== null)
      .map((b) => (b.disabled ? '[x] ' : '[ ] ') + b.textContent.trim().slice(0, 46))
  }));
  console.log('\n  STALLED at ' + where + ' (screen=' + d.screen + ', cells=' + d.cells + ')');
  d.buttons.forEach((b) => console.log('    ' + b));
  console.log('');
}

/* ---------------------------------------------------------------- corpus -- */

const tmp = path.join(os.tmpdir(), 'pt-full-' + Date.now());
let n = 0;
for (const [dir, count] of [['Trip/Day1', 24], ['Trip/Day2', 24]]) {
  for (let i = 0; i < count; i++) {
    const abs = path.join(tmp, dir, `IMG_${1000 + n}.png`);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, makePng(160, 120, ++n));
  }
}

await page.goto('file://' + ARTIFACT);
await page.waitForSelector('#dir-files', { state: 'attached', timeout: 10000 });
await page.setInputFiles('#dir-files', tmp);
await page.waitForFunction(() => {
  const b = document.querySelector('#ingest-actions button');
  return b && /finalist/i.test(b.textContent);
}, { timeout: 120000 });
check('ingest completed', true, '48 photos');

await clickText(/finalist/);
await page.waitForSelector('#tree-host .tree-row', { timeout: 10000 });

// Two fixed leaves: two independent tournaments, 3 finalists each.
await page.evaluate(() => {
  const set = (name, v) => {
    const row = Array.from(document.querySelectorAll('#tree-host .tree-row'))
      .find((r) => r.querySelector('.tree-name').textContent.trim() === name);
    const inp = row.querySelector('.tree-alloc');
    inp.value = v;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('Trip', '*'); set('Day1', '3'); set('Day2', '3');
});

const units = await page.evaluate(() => {
  const s = window.PT.store.get();
  return window.PT.tree.resolve(s.tree, s.session.allocs).units.length;
});
check('two tournament units derived', units === 2, units);

check('start culling is available', await clickText(/Start culling/), '');
await page.waitForTimeout(500);
check('reached a stage screen', ['grid', 'bracket'].includes(await screenNow()), await screenNow());

/* ------------------------------------------------------- drive the stages -- */

const MAX_STEPS = 700;
let steps = 0;
let sawGrid = false, sawBracket = false, sawQuotaLock = false;

while (steps++ < MAX_STEPS) {
  const scr = await screenNow();
  if (scr === 'export') break;

  if (scr === 'grid') {
    sawGrid = true;
    const hasCells = await page.evaluate(() => document.querySelectorAll('.photo-cell').length > 0);

    if (!hasCells) {
      // Between passes. Once the field is small enough for a bracket, go there
      // rather than passing forever; otherwise run another pass.
      const ready = await page.evaluate(() => {
        const s = window.PT.store.get();
        const u = s.session.units[s.session.activeUnitId];
        return !u || u.target == null ? true : u.pool.length <= Math.max(4, u.target * 3);
      });
      if (ready && await clickText(/bracket|rank them|start ranking/, 1500)) { await page.waitForTimeout(250); continue; }
      if (await clickText(/start pass|run another|another pass/, 1500)) { await page.waitForTimeout(200); continue; }
      if (await clickText(/bracket|rank|continue|next|skip/, 1500)) { await page.waitForTimeout(250); continue; }
      await dumpButtons('grid, between passes');
      break;
    }

    // Selecting everything first proves the advance control actually disables at
    // the quota boundary rather than silently rejecting clicks (PRD 7.1).
    const probe = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.photo-cell'));
      const adv = () => Array.from(document.querySelectorAll('button'))
        .find((b) => /continue|at most|finish pass/i.test(b.textContent));
      cells.forEach((c) => { if (c.classList.contains('kept')) c.click(); });
      cells.forEach((c) => c.click());
      const over = adv() ? adv().disabled : null;
      cells.forEach((c) => { if (c.classList.contains('kept')) c.click(); });
      return { count: cells.length, over };
    });
    if (probe.over === true) sawQuotaLock = true;

    await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.photo-cell'));
      const keep = Math.max(1, Math.floor(cells.length / 2));
      for (let i = 0; i < keep; i++) cells[i].click();
    });
    if (!(await clickText(/continue|finish pass/, 3000))) { await dumpButtons('grid, in pass'); break; }
    await page.waitForTimeout(120);
    continue;
  }

  if (scr === 'rescue') {
    if (await clickText(/skip|no thanks|continue|done|bracket|start the bracket/, 2000)) { await page.waitForTimeout(150); continue; }
    await dumpButtons('rescue'); break;
  }

  if (scr === 'bracket') {
    sawBracket = true;
    // Arrow keys are the documented way to choose (PRD 7.3), and they avoid the
    // pane's drag-to-pan handling entirely.
    const inMatchup = await page.evaluate(() => document.querySelectorAll('.bk-vp').length >= 2);
    if (inMatchup) {
      const before = await page.evaluate(() => {
        const s = window.PT.store.get();
        const u = s.session.units[s.session.activeUnitId];
        return (u.bracket && u.bracket.ops ? u.bracket.ops.length : 0);
      });
      await page.keyboard.press(steps % 3 === 0 ? 'ArrowRight' : 'ArrowLeft');
      await page.waitForTimeout(80);
      const after = await page.evaluate(() => {
        const s = window.PT.store.get();
        const u = s.session.units[s.session.activeUnitId];
        return (u.bracket && u.bracket.ops ? u.bracket.ops.length : 0);
      });
      if (after > before) continue;
      // The keyboard did not register a choice; fall through to the buttons.
    }
    if (await clickText(/continue|next|finish|done|results|export/, 2000)) { await page.waitForTimeout(200); continue; }
    await dumpButtons('bracket'); break;
  }

  if (scr === 'runoff') {
    if (await clickText(/skip|continue|done|no/, 2000)) { await page.waitForTimeout(150); continue; }
    await dumpButtons('runoff'); break;
  }
  await dumpButtons('unknown screen'); break;
}

const finalScreen = await screenNow();
check('Stage A grid pass ran', sawGrid);
check('quota lock disables advance when over', sawQuotaLock);
check('Stage B bracket ran', sawBracket);
check('flow reached export review', finalScreen === 'export', finalScreen + ' after ' + steps + ' steps');

const result = await page.evaluate(() => {
  const s = window.PT.store.get();
  const units = Object.keys(s.session.units).map((k) => s.session.units[k]);
  return {
    units: units.length,
    done: units.filter((u) => u.phase === 'done').length,
    winners: units.map((u) => u.winners.length),
    targets: units.map((u) => u.target),
    passes: units.map((u) => u.passes.length),
    comparisons: units.reduce((a, u) => a + (u.comparisons || 0), 0),
    distinct: new Set(units.flatMap((u) => u.winners)).size
  };
});

check('every unit finished', result.done === result.units, `${result.done}/${result.units}`);
check('each unit produced its target', JSON.stringify(result.winners) === JSON.stringify(result.targets),
  `winners ${result.winners} vs targets ${result.targets}`);
check('winners are distinct photos', result.distinct === result.winners.reduce((a, b) => a + b, 0),
  result.distinct);
check('grid passes were recorded', result.passes.every((p) => p >= 1), result.passes.join(','));
check('comparisons were recorded', result.comparisons > 0, result.comparisons);

if (finalScreen === 'export') {
  const exp = await page.evaluate(() => ({
    rows: document.querySelectorAll('.exp-row').length,
    dests: Array.from(document.querySelectorAll('.exp-dest')).slice(0, 3).map((e) => e.textContent),
    labelInputs: document.querySelectorAll('.exp-row input[type=text]').length
  }));
  check('export lists every finalist', exp.rows === result.winners.reduce((a, b) => a + b, 0), exp.rows);
  check('destination filenames are shown', exp.dests.every((d) => /\.png$/.test(d)), exp.dests[0]);
  check('every finalist has a label field', exp.labelInputs === exp.rows, exp.labelInputs);

  // A typed label must reach the destination filename (PRD 7.8).
  await page.evaluate(() => {
    const i = document.querySelector('.exp-row input[type=text]');
    i.value = 'hero for cover';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const dest = await page.$eval('.exp-dest', (e) => e.textContent);
  check('label becomes part of the filename', /hero_for_cover/.test(dest), dest);
  check('original filename is retained', /IMG_\d+\.png$/.test(dest), dest);
}

check('zero console errors through the whole run', errors.length === 0,
  errors.length ? '\n  ' + errors.slice(0, 6).join('\n  ') : '0');

await browser.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nFULL FLOW OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Drives ingest, allocation, Stage A grid
 *   passes with a quota-boundary probe, the bracket, and export review including
 *   label-to-filename verification.
 */
