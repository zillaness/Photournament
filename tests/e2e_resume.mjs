/**
 * file: e2e_resume.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Proves PRD 7.10 resume survives a real page reload mid-pass and mid-bracket, and that the optional Stage D cross-category final actually runs.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Both of these were completely uncovered until now, which matters more than any
 * missing feature: a real culling session runs for an evening across several
 * hundred photos, and a broken resume loses the whole night's judgements. Stage D
 * was wired up and off by default, so it had never once executed.
 *
 * Reload is a REAL page.reload(), not a simulated one — the decisions have to come
 * back out of IndexedDB, which is the only thing that survives.
 *
 * Run: node tests/e2e_resume.mjs
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

/* ------------------------------------------------------------- png corpus -- */

function crc32(b) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < b.length; n++) {
    c = (crc ^ b[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(t, d) {
  const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t, 'ascii'), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([l, td, c]);
}
function png(w, h, seed) {
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
  const i = Buffer.alloc(13);
  i.writeUInt32BE(w, 0); i.writeUInt32BE(h, 4); i[8] = 8; i[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', i), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------- run --- */

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

const tmp = path.join(os.tmpdir(), 'pt-resume-' + Date.now());
let n = 0;
for (const [dir, count] of [['Port/A', 18], ['Port/B', 18]]) {
  for (let i = 0; i < count; i++) {
    const abs = path.join(tmp, dir, `IMG_${1000 + n}.png`);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, png(160, 120, ++n));
  }
}

// A PERSISTENT profile. IndexedDB on a file:// origin lives in the profile
// directory, so a throwaway context would make "resume" untestable by
// construction — the database would vanish with the browser.
const profile = path.join(os.tmpdir(), 'pt-profile-' + Date.now());
const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1400, height: 900 } });
const page = ctx.pages()[0] || await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const screenNow = () => page.evaluate(() => document.body.dataset.screen);
async function clickText(re, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const ok = await page.evaluate((src) => {
      const rx = new RegExp(src, 'i');
      const b = Array.from(document.querySelectorAll('button'))
        .find((x) => rx.test(x.textContent) && !x.disabled && x.offsetParent !== null);
      if (b) { b.click(); return true; }
      return false;
    }, re.source);
    if (ok) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

await page.goto('file://' + ARTIFACT);
await page.waitForSelector('#dir-files', { state: 'attached' });
await page.setInputFiles('#dir-files', tmp);
await page.waitForFunction(() => {
  const b = document.querySelector('#ingest-actions button');
  return b && /finalist/i.test(b.textContent);
}, { timeout: 120000 });
await clickText(/finalist/);
await page.waitForSelector('#tree-host .tree-row');

// Two fixed leaves, and turn Stage D ON — the whole point of this run.
await page.evaluate(() => {
  const set = (name, v) => {
    const r = Array.from(document.querySelectorAll('#tree-host .tree-row'))
      .find((x) => (x.querySelector('.tree-name') || {}).textContent.trim() === name);
    if (!r) return;
    const i = r.querySelector('.tree-alloc');
    i.value = v; i.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('Port', '*'); set('A', '3'); set('B', '3');
  const cb = Array.from(document.querySelectorAll('#tree-footer input[type=checkbox]'))[0];
  if (cb && !cb.checked) cb.click();
});
const stageDOn = await page.evaluate(() => window.PT.store.get().session.settings.stageD);
check('Stage D can be enabled from the tree', stageDOn === true, stageDOn);

await clickText(/Start culling/);
await page.waitForTimeout(400);

/* ------------------------------------------- resume mid-pass (PRD 7.10) --- */

// Get into a live pass and make some decisions, then reload without warning.
if ((await screenNow()) === 'dupes') await clickText(/skip|continue|looks right|done/, 3000);
await page.waitForTimeout(300);
await clickText(/Start pass/, 4000);
await page.waitForTimeout(300);

await page.evaluate(() => {
  const c = Array.from(document.querySelectorAll('.photo-cell'));
  for (let i = 0; i < Math.min(3, c.length); i++) c[i].click();
});
await clickText(/continue|finish pass/, 4000);
await page.waitForTimeout(300);
await page.evaluate(() => {
  const c = Array.from(document.querySelectorAll('.photo-cell'));
  for (let i = 0; i < Math.min(2, c.length); i++) c[i].click();
});
await page.waitForTimeout(200);

const before = await page.evaluate(async () => {
  await window.PT.store.flush();
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  return {
    unitId: u.id,
    index: u.currentPass ? u.currentPass.index : null,
    kept: u.currentPass ? u.currentPass.kept.slice() : null,
    order: u.currentPass ? u.currentPass.order.slice(0, 8) : null,
    quotaMode: u.currentPass ? u.currentPass.quotaMode : null,
    photos: Object.keys(s.photos).length
  };
});
check('a pass is genuinely in progress before reload', before.index !== null && before.index > 0,
  'screen index ' + before.index);

await page.reload();
await page.waitForTimeout(1200);
const resumeOffered = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button')).some((b) => /resume/i.test(b.textContent)));
check('resume is offered after a reload', resumeOffered, resumeOffered);
await clickText(/^Resume$/, 6000);
await page.waitForTimeout(1200);

const after = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  return {
    unitId: u ? u.id : null,
    index: u && u.currentPass ? u.currentPass.index : null,
    kept: u && u.currentPass ? u.currentPass.kept.slice() : null,
    order: u && u.currentPass ? u.currentPass.order.slice(0, 8) : null,
    quotaMode: u && u.currentPass ? u.currentPass.quotaMode : null,
    photos: Object.keys(s.photos).length,
    screen: document.body.dataset.screen,
    stageD: s.session.settings.stageD
  };
});

check('resumed into the same unit', after.unitId === before.unitId, after.unitId);
check('resumed onto the same screen of the pass', after.index === before.index,
  `${after.index} vs ${before.index}`);
check('kept photos survived the reload',
  JSON.stringify(after.kept) === JSON.stringify(before.kept),
  `${(after.kept || []).length} ids`);
// The shuffle is seeded precisely so a resumed pass deals the same screens; if the
// order drifted, some photos would be shown twice and others never.
check('the shuffled deal order is identical',
  JSON.stringify(after.order) === JSON.stringify(before.order), 'first 8 ids');
check('the locked quota survived', after.quotaMode === before.quotaMode, after.quotaMode);
check('photo records were restored', after.photos === before.photos,
  `${after.photos}/${before.photos}`);
check('the Stage D choice survived', after.stageD === true, after.stageD);
check('landed back on a stage screen', ['grid', 'bracket'].includes(after.screen), after.screen);

/* ------------------------------------ drive to the end, through Stage D --- */

let guard = 0, sawStageD = false, reloadedInBracket = false;
while (guard++ < 900) {
  const scr = await screenNow();
  if (scr === 'export') break;

  if (await page.evaluate(() => window.PT.store.get().session.activeUnitId === 'stageD')) sawStageD = true;

  if (scr === 'grid') {
    const cells = await page.evaluate(() => document.querySelectorAll('.photo-cell').length);
    if (!cells) {
      const ready = await page.evaluate(() => {
        const s = window.PT.store.get();
        const u = s.session.units[s.session.activeUnitId];
        return !u || u.target == null ? true : u.pool.length <= Math.max(4, u.target * 3);
      });
      if (ready && await clickText(/bracket|rank them/, 1200)) continue;
      if (await clickText(/start pass|run another/, 1200)) continue;
      if (await clickText(/bracket|continue|next|skip/, 1200)) continue;
      break;
    }
    await page.evaluate(() => {
      const c = Array.from(document.querySelectorAll('.photo-cell'));
      for (let i = 0; i < Math.max(1, Math.floor(c.length / 2)); i++) c[i].click();
    });
    if (!(await clickText(/continue|finish pass/, 2500))) break;
    continue;
  }

  if (scr === 'bracket') {
    const inMatch = await page.evaluate(() => document.querySelectorAll('.bk-vp').length >= 2);
    if (inMatch) {
      // Reload once, mid-bracket. An ops-log replay is a different resume path
      // from a mid-pass one and deserves its own proof.
      if (!reloadedInBracket) {
        reloadedInBracket = true;
        // Make real decisions first. Reloading at zero comparisons would assert
        // that nothing survived nothing.
        for (let k = 0; k < 4; k++) {
          const b0 = await page.evaluate(() => {
            const s = window.PT.store.get();
            return s.session.units[s.session.activeUnitId].bracket.ops.length;
          });
          await page.keyboard.press(k % 2 ? 'ArrowRight' : 'ArrowLeft');
          await page.waitForTimeout(90);
          const a0 = await page.evaluate(() => {
            const s = window.PT.store.get();
            return s.session.units[s.session.activeUnitId].bracket.ops.length;
          });
          if (a0 === b0) break;
        }
        const opsBefore = await page.evaluate(async () => {
          await window.PT.store.flush();
          const s = window.PT.store.get();
          const u = s.session.units[s.session.activeUnitId];
          return { ops: u.bracket.ops.length, seed: u.bracket.seed, unit: u.id };
        });
        await page.reload();
        await page.waitForTimeout(1000);
        await clickText(/^Resume$/, 6000);
        await page.waitForTimeout(1000);
        const opsAfter = await page.evaluate(() => {
          const s = window.PT.store.get();
          const u = s.session.units[s.session.activeUnitId];
          return u && u.bracket
            ? { ops: u.bracket.ops.length, seed: u.bracket.seed, unit: u.id }
            : { ops: -1, seed: null, unit: null };
        });
        check('comparisons were actually made before reloading', opsBefore.ops > 0,
          opsBefore.ops + ' ops');
        check('bracket comparisons survived a reload', opsAfter.ops === opsBefore.ops,
          `${opsAfter.ops} vs ${opsBefore.ops}`);
        check('the bracket seed is unchanged, so it is the same bracket',
          opsAfter.seed === opsBefore.seed, String(opsAfter.seed));
        continue;
      }
      const b = await page.evaluate(() => {
        const s = window.PT.store.get();
        const u = s.session.units[s.session.activeUnitId];
        return u.bracket.ops.length;
      });
      await page.keyboard.press(guard % 3 === 0 ? 'ArrowRight' : 'ArrowLeft');
      await page.waitForTimeout(70);
      const a = await page.evaluate(() => {
        const s = window.PT.store.get();
        const u = s.session.units[s.session.activeUnitId];
        return u.bracket.ops.length;
      });
      if (a > b) continue;
    }
    if (await clickText(/continue|next|finish|done|results|duplicates/, 1500)) continue;
    break;
  }

  if (['runoff', 'rescue', 'dupes'].includes(scr)) {
    if (await clickText(/skip|continue|done|bracket|looks right/, 1500)) continue;
    break;
  }
  break;
}

const end = await page.evaluate(() => {
  const s = window.PT.store.get();
  const d = s.session.units.stageD;
  const perFolder = Object.keys(s.session.units).filter((k) => k !== 'stageD');
  return {
    screen: document.body.dataset.screen,
    hasStageD: !!d,
    stageDField: d ? d.allIds.length : 0,
    stageDWinners: d ? d.winners.length : 0,
    stageDTarget: d ? d.target : null,
    perFolderWinners: perFolder.reduce((a, k) => a + s.session.units[k].winners.length, 0),
    sets: Object.keys(s.session.units).length
  };
});

check('Stage D ran', sawStageD || end.hasStageD, 'unit present: ' + end.hasStageD);
check('Stage D field is the union of the folder winners',
  end.stageDField === end.perFolderWinners, `${end.stageDField} vs ${end.perFolderWinners}`);
check('Stage D produced its target', end.stageDWinners === end.stageDTarget,
  `${end.stageDWinners}/${end.stageDTarget}`);
// PRD 7.6: Stage D ADDS a second set alongside the per-folder winners rather than
// replacing them, and duplication across the two is intentional.
check('per-folder winners are kept alongside Stage D', end.perFolderWinners > 0,
  end.perFolderWinners);
check('reached export with all result sets', end.screen === 'export', end.screen);

const exportRows = await page.evaluate(() => document.querySelectorAll('.exp-row').length);
check('export lists every set including Stage D',
  exportRows === end.perFolderWinners + end.stageDWinners,
  `${exportRows} rows`);

check('zero console errors across two reloads', errors.length === 0,
  errors.length ? '\n  ' + errors.slice(0, 6).join('\n  ') : '0');

await ctx.close();
rmSync(tmp, { recursive: true, force: true });
rmSync(profile, { recursive: true, force: true });
console.log(failed === 0 ? '\nRESUME + STAGE D OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Mid-pass and mid-bracket reload against a
 *   persistent profile, and a full Stage D run through to export.
 */
