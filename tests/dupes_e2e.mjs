/**
 * file: dupes_e2e.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Drives the PRD 7.7 near-duplicate review in real Chromium from a file:// URL — grouping, the live even-stepping slider, split, merge, remove, representative override, reload survival, and manual edits surviving a threshold change.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * The corpus is four synthetic "scenes" of three frames each. Frames within a
 * scene differ only by a small brightness step and a little per-pixel noise —
 * a burst. Scenes differ by spatial frequency and phase, so they are genuinely
 * different pictures. That gives a grouping with something to split, something
 * to merge, and something to remove, which the E2E noise corpus does not.
 *
 * Run: node tools/build.mjs && node tests/dupes_e2e.mjs
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
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** One frame of a burst: scene sets the picture, frame perturbs it slightly. */
function makeFrame(w, h, scene, frame) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  let s = (((scene + 1) * 2654435761) ^ ((frame + 1) * 40503)) >>> 0;
  const fx = 1 + scene;               // horizontal frequency, distinct per scene
  const fy = 1 + ((scene * 3) % 4);   // vertical frequency
  const ph = (scene * 1.7) % 6.283;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const n = (((s >>> 24) & 0xff) - 128) * 0.05;   // sensor grain, tiny
      const v = 128
        + 68 * Math.sin((x / w) * Math.PI * 2 * fx + ph)
        + 52 * Math.cos((y / h) * Math.PI * 2 * fy + ph * 1.3)
        + 34 * Math.sin(((x + y) / (w + h)) * Math.PI * 6 + scene);
      const j = frame * 2 + n;                        // exposure step per frame
      raw[p++] = clamp(v + j);
      raw[p++] = clamp(v * 0.86 + j + ((scene * 17) % 40));
      raw[p++] = clamp(v * 0.72 + j + ((scene * 29) % 60));
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

const SCENES = 4, FRAMES = 3;
const tmp = path.join(os.tmpdir(), 'pt-dupes-' + Date.now());
for (let sc = 0; sc < SCENES; sc++) {
  for (let f = 0; f < FRAMES; f++) {
    const abs = path.join(tmp, 'Trip', 'Day1', `IMG_${2000 + sc * 10 + f}.png`);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, makeFrame(240, 180, sc, f));
  }
}

/* ------------------------------------------------------------------ run --- */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

const screenNow = () => page.evaluate(() => document.body.dataset.screen);

/** The live grouping as the DOM shows it, plus what the store believes. */
const shot = () => page.evaluate(() => {
  const groups = Array.from(document.querySelectorAll('#dupe-list .ro-group')).map((g) => ({
    key: g.dataset.group,
    ids: Array.from(g.querySelectorAll('.ro-cell')).map((c) => c.dataset.member),
    rep: (g.querySelector('.ro-cell.kept') || {}).dataset?.member || null,
    confirmed: g.classList.contains('confirmed')
  }));
  const s = window.PT.store.get().session;
  return {
    groups,
    threshold: s.groups.threshold,
    mode: s.groups.mode,
    stored: (s.groups.groups || []).map((g) => g.ids.slice()),
    reps: Object.keys(s.groups.reps),
    removed: Object.keys(s.groups.removed),
    unitGroups: Object.keys(s.units).map((k) => (s.units[k].groups || []).map((g) => g.ids.length))
  };
});

const sameGroup = (snap, a, b) => snap.groups.some((g) => g.ids.includes(a) && g.ids.includes(b));
const anyGroup = (snap, id) => snap.groups.some((g) => g.ids.includes(id));

/* ---------------------------------------------------- ingest and allocate -- */

await page.goto('file://' + ARTIFACT);
await page.waitForSelector('#dir-files', { state: 'attached', timeout: 10000 });
await page.setInputFiles('#dir-files', tmp);
await page.waitForFunction(() => {
  const b = document.querySelector('#ingest-actions button');
  return b && /finalist/i.test(b.textContent);
}, { timeout: 120000 });

await page.evaluate(() => Array.from(document.querySelectorAll('button'))
  .find((b) => /finalist/i.test(b.textContent)).click());
await page.waitForSelector('#tree-host .tree-row', { timeout: 10000 });
await page.evaluate(() => {
  const row = Array.from(document.querySelectorAll('#tree-host .tree-row'))
    .find((r) => r.querySelector('.tree-name').textContent.trim() === 'Day1');
  const i = row.querySelector('.tree-alloc');
  i.value = '3';
  i.dispatchEvent(new Event('input', { bubbles: true }));
});

await page.evaluate(() => Array.from(document.querySelectorAll('button'))
  .find((b) => /Start culling/i.test(b.textContent) && !b.disabled).click());

await page.waitForSelector('#dupe-list .ro-group', { timeout: 30000 });
check('Start culling routes into the review', (await screenNow()) === 'dupes', await screenNow());

// The gate runs on the ingest hashes once the units exist, which is the only
// moment it is meaningful — before that there are no units to walk.
const gate = await page.evaluate(() => window.PT.dupes.hasCandidates());
check('the ingest-hash gate is what opened the review', gate === true, gate);

/* ------------------------------------------------------- 1. groups render -- */

let snap = await shot();
check('groups render with all their members',
  snap.groups.length >= 2 && snap.groups.every((g) => g.ids.length >= 2),
  snap.groups.map((g) => g.ids.length).join('+') + ' members, ' + snap.groups.length + ' groups');
check('every group nominates exactly one representative',
  snap.groups.every((g) => g.rep && g.ids.includes(g.rep)),
  snap.groups.map((g) => g.rep && g.rep.slice(0, 6)).join(','));
check('default threshold is 14, mode strict',
  snap.threshold === 14 && snap.mode === 'strict', snap.threshold + '/' + snap.mode);
check('the reviewed grouping reaches Stage C via unit.groups',
  JSON.stringify(snap.unitGroups.flat().sort()) ===
  JSON.stringify(snap.groups.map((g) => g.ids.length).sort()),
  JSON.stringify(snap.unitGroups));

/* ------------------ measured: the hashes clustered on are constant-weight -- */

const parity = await page.evaluate(() => {
  const H = window.PT.dupes._internal.hashes();
  const ids = Object.keys(H);
  const bits = (h) => { let c = 0; for (const ch of h) c += (parseInt(ch, 16).toString(2).match(/1/g) || []).length; return c; };
  const weights = [...new Set(ids.map((i) => bits(H[i].hash)))];
  let odd = 0, pairs = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    pairs++;
    if (window.PT.phash.hamming(H[ids[i]].hash, H[ids[j]].hash) % 2) odd++;
  }
  return { n: ids.length, weights, odd, pairs };
});
check('every hash clustered on has the same one-bit weight',
  parity.weights.length === 1 && parity.weights[0] === 31, 'weights ' + parity.weights.join(','));
check('every pairwise distance is even, so odd slider stops are dead',
  parity.odd === 0, parity.odd + ' odd of ' + parity.pairs + ' pairs');

/* ------------------------------------------------- 2. the slider is live -- */

// An odd value cannot be reached at all: the control sanitises to its own steps.
const odd = await page.evaluate(() => {
  const s = document.querySelector('#dupe-threshold');
  const seen = [];
  for (const v of ['5', '7', '11', '13', '15', '17', '19']) { s.value = v; seen.push(s.value); }
  return { step: s.step, min: s.min, max: s.max, seen };
});
check('slider steps by 2 over the measured 4–20 range',
  odd.step === '2' && odd.min === '4' && odd.max === '20', odd.min + '–' + odd.max + ' step ' + odd.step);
check('odd values cannot be set on the slider at all',
  odd.seen.every((v) => Number(v) % 2 === 0), 'asked 5,7,11,13,15,17,19 → got ' + odd.seen.join(','));

// Sweep with the keyboard, the way a user actually nudges it, and record what
// the store ends up holding plus whether the DOM had already changed.
const sweep = await page.evaluate(async () => {
  const s = document.querySelector('#dupe-threshold');
  s.focus();
  s.value = '4';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  const stops = [];
  for (let i = 0; i < 9; i++) {
    stops.push({
      value: Number(s.value),
      stored: window.PT.store.get().session.groups.threshold,
      groups: document.querySelectorAll('#dupe-list .ro-group').length
    });
    s.value = String(Number(s.value) + Number(s.step));
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return stops;
});
check('every stop the slider lands on is even',
  sweep.every((x) => x.value % 2 === 0 && x.stored % 2 === 0),
  sweep.map((x) => x.value).join(','));
check('the store follows the slider on every input event',
  sweep.every((x) => x.value === x.stored), 'values ' + sweep.map((x) => x.stored).join(','));
check('re-clustering is synchronous — the DOM is already updated, no debounce',
  new Set(sweep.map((x) => x.groups)).size > 1,
  'groups by threshold: ' + sweep.map((x) => x.value + ':' + x.groups).join(' '));

// Timing, measured rather than assumed.
const ms = await page.evaluate(() => {
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) window.PT.dupes._internal.computeGroups();
  return (performance.now() - t0) / 20;
});
console.log('      (re-cluster + replay: ' + ms.toFixed(2) + ' ms per input event, ' + parity.n + ' photos)');

// Back to the measured default for the rest of the run.
await page.evaluate(() => {
  const s = document.querySelector('#dupe-threshold');
  s.value = '14';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
snap = await shot();
check('slider returns to the default grouping', snap.threshold === 14 && snap.groups.length >= 2,
  snap.groups.length + ' groups at 14');

/* ------------------------------------------------------------- 3. split --- */

const big = snap.groups.find((g) => g.ids.length >= 3);
check('a group of three or more exists to split', !!big, big ? big.ids.length + ' members' : 'none');

const splitA = big.ids[0], splitB = big.ids[1];
await page.evaluate((id) => {
  document.querySelector(`.dupe-pick[data-pick="${id}"]`).click();
}, splitA);
await page.click('#dupe-split');
snap = await shot();
check('split separates the ticked photo from its group',
  !sameGroup(snap, splitA, splitB) && anyGroup(snap, splitB),
  'split ' + splitA.slice(0, 6) + ' off ' + splitB.slice(0, 6));

/* ------------- 8. a threshold change must not destroy that manual edit ---- */

await page.evaluate(() => {
  const s = document.querySelector('#dupe-threshold');
  s.value = '20';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
snap = await shot();
check('the split survives loosening the threshold to 20',
  !sameGroup(snap, splitA, splitB), 'threshold ' + snap.threshold);

await page.evaluate(() => {
  const s = document.querySelector('#dupe-threshold');
  s.value = '8';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  s.value = '14';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
snap = await shot();
check('the split survives tightening to 8 and returning to 14',
  !sameGroup(snap, splitA, splitB) && snap.threshold === 14, 'threshold ' + snap.threshold);

/* ------------------------------------------------------------- 4. merge --- */

// Tick one member of two different groups and merge them.
const g0 = snap.groups[0], g1 = snap.groups[1];
const mergeA = g0.ids[0], mergeB = g1.ids[0];
await page.evaluate(([a, b]) => {
  document.querySelectorAll('.dupe-pick:checked').forEach((c) => c.click());
  document.querySelector(`.dupe-pick[data-pick="${a}"]`).click();
  document.querySelector(`.dupe-pick[data-pick="${b}"]`).click();
}, [mergeA, mergeB]);
const mergeEnabled = await page.evaluate(() => !document.querySelector('#dupe-merge').disabled);
check('merge becomes available once two groups are ticked', mergeEnabled === true, mergeEnabled);
await page.click('#dupe-merge');
snap = await shot();
check('merge combines the two groups into one',
  sameGroup(snap, mergeA, mergeB), mergeA.slice(0, 6) + ' + ' + mergeB.slice(0, 6));

// Regression: the selection is cleared before the repaint, so no tick is left
// behind on a group that the edit has just rebuilt.
const stale = await page.evaluate(() => document.querySelectorAll('.dupe-pick:checked').length);
check('an edit leaves no stale ticks behind', stale === 0, stale + ' still ticked');

await page.evaluate(() => {
  const s = document.querySelector('#dupe-threshold');
  s.value = '6';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
snap = await shot();
check('the merge survives tightening the threshold to 6',
  sameGroup(snap, mergeA, mergeB), 'threshold ' + snap.threshold);
await page.evaluate(() => {
  const s = document.querySelector('#dupe-threshold');
  s.value = '14';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});

/* ------------------------------------------------------------ 5. remove --- */

snap = await shot();
const victimGroup = snap.groups.find((g) => g.ids.length >= 3) || snap.groups[0];
const victim = victimGroup.ids[victimGroup.ids.length - 1];
await page.evaluate((id) => {
  document.querySelectorAll('.dupe-pick:checked').forEach((c) => c.click());
  document.querySelector(`.dupe-pick[data-pick="${id}"]`).click();
}, victim);
await page.click('#dupe-remove');
snap = await shot();
check('remove drops the member from every group',
  !anyGroup(snap, victim) && snap.removed.includes(victim), victim.slice(0, 6));

/* --------------------------------------------- 6. representative override -- */

snap = await shot();
const target = snap.groups.find((g) => g.ids.length >= 2);
const oldRep = target.rep;
const newRep = target.ids.find((id) => id !== oldRep);
await page.evaluate((id) => {
  document.querySelector(`.ro-cell[data-member="${id}"]`).click();
}, newRep);
snap = await shot();
const after = snap.groups.find((g) => g.ids.includes(newRep));
check('clicking a member makes it the representative in one click',
  after && after.rep === newRep, oldRep.slice(0, 6) + ' → ' + newRep.slice(0, 6));
check('the other members stay attached for a Stage C runoff',
  after && after.ids.length === target.ids.length && after.ids.includes(oldRep),
  after ? after.ids.length + ' members' : 'group lost');
check('the override is recorded in the session', snap.reps.includes(newRep), snap.reps.length + ' pinned');

/* ------------------------------------------------------------ 7. confirm --- */

await page.evaluate((key) => {
  document.querySelector(`.ro-group[data-group="${key}"] button[data-confirm]`).click();
}, after.key);
snap = await shot();
const confirmed = snap.groups.find((g) => g.ids.includes(newRep));
check('confirm pins a group', confirmed && confirmed.confirmed === true, !!(confirmed && confirmed.confirmed));

/* ------------------------------------------------------ 7b. reload survival */

const beforeReload = {
  rep: newRep,
  ids: confirmed.ids.slice(),
  splitA, splitB, mergeA, mergeB, victim,
  groups: snap.groups.map((g) => g.ids.slice().sort().join(',')).sort()
};

await page.reload();
await page.waitForFunction(() => Array.from(document.querySelectorAll('button'))
  .some((b) => /^Resume$/i.test(b.textContent.trim()) && b.offsetParent !== null), { timeout: 20000 });
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button'))
    .find((x) => /^Resume$/i.test(x.textContent.trim())).click();
});
await page.waitForSelector('#dupe-list .ro-group', { timeout: 30000 });
check('a reload returns to the review, not past it', (await screenNow()) === 'dupes', await screenNow());

snap = await shot();
const survived = snap.groups.find((g) => g.ids.includes(beforeReload.rep));
check('the representative choice survives a page reload',
  survived && survived.rep === beforeReload.rep,
  survived ? survived.rep.slice(0, 6) : 'group missing');
check('the whole grouping survives a page reload',
  JSON.stringify(snap.groups.map((g) => g.ids.slice().sort().join(',')).sort()) ===
  JSON.stringify(beforeReload.groups),
  snap.groups.length + ' groups');
check('the hand split survives a reload', !sameGroup(snap, beforeReload.splitA, beforeReload.splitB));
check('the hand merge survives a reload', sameGroup(snap, beforeReload.mergeA, beforeReload.mergeB));
check('the removed photo stays removed after a reload', !anyGroup(snap, beforeReload.victim));

/* ----------------------------------- 8b. edits survive a threshold change -- */

await page.evaluate(() => {
  const s = document.querySelector('#dupe-threshold');
  for (const v of ['4', '10', '16', '20', '14']) {
    s.value = v;
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
snap = await shot();
check('after sweeping the whole slider range, the split is still there',
  !sameGroup(snap, beforeReload.splitA, beforeReload.splitB));
check('after sweeping the whole slider range, the merge is still there',
  sameGroup(snap, beforeReload.mergeA, beforeReload.mergeB));
check('after sweeping the whole slider range, the removal is still there',
  !anyGroup(snap, beforeReload.victim));
check('after sweeping the whole slider range, the representative is still mine',
  (snap.groups.find((g) => g.ids.includes(beforeReload.rep)) || {}).rep === beforeReload.rep);

/* ---------------------------------------------------- continue to culling -- */

const handOff = await page.evaluate(() => {
  const s = window.PT.store.get().session;
  return Object.keys(s.units).map((k) => ({
    unit: k,
    groups: (s.units[k].groups || []).map((g) => ({ n: g.ids.length, rep: !!g.rep }))
  }));
});
check('Stage C receives {ids, rep} groups on the unit',
  handOff.some((u) => u.groups.length && u.groups.every((g) => g.n > 1 && g.rep)),
  JSON.stringify(handOff.map((u) => u.groups.length)));

await page.click('#dupe-continue');
await page.waitForTimeout(400);
check('continuing leads to the first grid pass', (await screenNow()) === 'grid', await screenNow());
const status = await page.evaluate(() => window.PT.store.get().session.groups.status);
check('the review is marked done so it does not reopen', status === 'done', status);

/* ------------------------------------------------------------ skip route -- */

check('zero console errors through the whole run', errors.length === 0,
  errors.length ? '\n  ' + errors.slice(0, 6).join('\n  ') : '0');

await browser.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nDUPES OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Burst corpus, grouping, constant-weight
 *   hash verification, even-only slider stops with no debounce, split, merge,
 *   remove, confirm, one-click representative override, reload survival, and
 *   manual edits surviving a full sweep of the slider range.
 */
