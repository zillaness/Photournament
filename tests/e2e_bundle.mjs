/**
 * file: e2e_bundle.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Verifies bundled bursts through the whole flow: Stage A deals one badged cell per near-duplicate group, the bundle expands mid-pass to switch its face, keeping keeps every member, the bracket seats one badged competitor per group with a face swap that carries its standing, and the runoff still opens the group.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * The invariant under test: a burst is ONE decision wearing ONE face, and the
 * face is always swappable without redoing any decision — mid-pass, mid-bracket,
 * and again in the runoff. Members are never silently lost by bundling: keeping
 * the face keeps them all.
 *
 * Run: node tests/e2e_bundle.mjs
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

/* --------------------------------------------------------- png generator -- */
/* Same corpus construction dupes_e2e.mjs measures the grouping with: frames of
 * a scene differ by an exposure step and grain (a burst), scenes differ by
 * spatial frequency and phase (genuinely different pictures). */

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

function makeFrame(w, h, scene, frame) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  let s = (((scene + 1) * 2654435761) ^ ((frame + 1) * 40503)) >>> 0;
  const fx = 1 + scene;
  const fy = 1 + ((scene * 3) % 4);
  const ph = (scene * 1.7) % 6.283;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const n = (((s >>> 24) & 0xff) - 128) * 0.05;
      const v = 128
        + 68 * Math.sin((x / w) * Math.PI * 2 * fx + ph)
        + 52 * Math.cos((y / h) * Math.PI * 2 * fy + ph * 1.3)
        + 34 * Math.sin(((x + y) / (w + h)) * Math.PI * 6 + scene);
      const j = frame * 2 + n;
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

// Two bursts of three, four genuinely distinct singles: 10 photos, 6 decisions.
const tmp = path.join(os.tmpdir(), 'pt-bundle-' + Date.now());
mkdirSync(path.join(tmp, 'Roll'), { recursive: true });
for (let f = 0; f < 3; f++) {
  writeFileSync(path.join(tmp, 'Roll', `burstA_${f}.png`), makeFrame(240, 180, 0, f));
  writeFileSync(path.join(tmp, 'Roll', `burstB_${f}.png`), makeFrame(240, 180, 1, f));
}
for (let sc = 2; sc < 6; sc++) {
  writeFileSync(path.join(tmp, 'Roll', `single_${sc}.png`), makeFrame(240, 180, sc, 0));
}

/* ------------------------------------------------------------------ run --- */

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
await page.fill('input.tree-alloc[data-path$="/Roll"]', '3');
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button'))
    .find((x) => /start culling/i.test(x.textContent) && !x.disabled).click();
});

/* --- the review sees the two bursts, and we take it as it stands --------- */

await page.waitForSelector('#dupe-continue', { timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll('#dupe-list .ro-group').length > 0, { timeout: 60000 });
// The two constructed bursts MUST group; the synthetic "singles" are allowed to
// cluster among themselves too (the corpus is procedural, and precision on it
// is not what this test is about) — every downstream assert derives from the
// store's real slotting rather than assuming exactly two groups.
const review = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = Object.values(s.session.units)[0];
  const nameOf = (id) => (s.photos[id] && s.photos[id].name) || id;
  const nameSets = (u.groups || []).map((g) => g.ids.map(nameOf));
  return {
    count: nameSets.length,
    burstsWhole: ['burstA', 'burstB'].map((tag) =>
      nameSets.some((ns) => [0, 1, 2].every((f) => ns.indexOf(tag + '_' + f + '.png') >= 0)))
  };
});
check('the review finds both constructed bursts, whole', review.burstsWhole.every(Boolean),
  review.count + ' groups');
await page.click('#dupe-continue');

/* --- Stage A deals decisions, not photos --------------------------------- */

await page.waitForSelector('[data-t="start-pass"]');
await page.click('[data-t="start-pass"]');
await page.waitForSelector('.photo-cell');

const dealt = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  const slots = u.currentPass.slots;
  const sizes = u.currentPass.order.map((f) => (slots[f] || [f]).length);
  return {
    cells: document.querySelectorAll('.photo-cell').length,
    pool: u.pool.length,
    decisions: u.currentPass.order.length,
    photosDealt: sizes.reduce((a, b) => a + b, 0),
    badges: Array.from(document.querySelectorAll('.photo-cell .stack-badge')).map((b) => b.textContent).sort(),
    bundleSizes: sizes.filter((n) => n > 1).sort()
  };
});
check('every photo is dealt exactly once, as decisions', dealt.photosDealt === 10 && dealt.pool === 10,
  dealt.photosDealt + ' of ' + dealt.pool);
check('the screen shows decisions, fewer than photos',
  dealt.cells === dealt.decisions && dealt.cells < 10,
  dealt.cells + ' cells for ' + dealt.decisions + ' decisions');
check('every bundle wears its member count',
  JSON.stringify(dealt.badges) === JSON.stringify(dealt.bundleSizes.map(String)) &&
    dealt.badges.filter((b) => b === '3').length === 2,
  JSON.stringify(dealt.badges));

/* --- expand a bundle mid-pass and switch its face ------------------------ */

const beforeSwap = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  const cell = Array.from(document.querySelectorAll('.photo-cell')).find((c) =>
    (u.currentPass.slots[c.dataset.id] || []).length === 3);
  cell.dataset.probe = '1';
  return { id: cell.dataset.id };
});
await page.click('.photo-cell[data-probe] .stack-badge');
await page.waitForSelector('.stack-pick');

const stack = await page.evaluate(() => ({
  options: document.querySelectorAll('.stack-pick .stack-opt').length,
  current: document.querySelectorAll('.stack-pick .stack-opt.current').length
}));
check('the bundle opens with its 3 members, one current', stack.options === 3 && stack.current === 1,
  JSON.stringify(stack));

await page.click('.stack-pick .stack-opt:not(.current)');
await page.waitForTimeout(200);

const afterSwap = await page.evaluate((oldId) => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  const cells = Array.from(document.querySelectorAll('.photo-cell'));
  const group = u.groups.find((g) => g.ids.indexOf(oldId) >= 0);
  const newFace = group.rep;
  return {
    stillShowsOld: cells.some((c) => c.dataset.id === oldId),
    newFaceInOrder: u.currentPass.order.indexOf(newFace) >= 0,
    repMoved: newFace !== oldId && group.ids.indexOf(newFace) >= 0,
    slotRenamed: !u.currentPass.slots[oldId] && (u.currentPass.slots[newFace] || []).length === 3
  };
}, beforeSwap.id);
check('the cell now wears the chosen member', afterSwap.stillShowsOld === false);
check('the pass order carries the new face', afterSwap.newFaceInOrder === true);
check('the group’s representative moved with it', afterSwap.repMoved === true);
check('the slot map was renamed, members intact', afterSwap.slotRenamed === true);

/* --- keeping the face keeps the whole burst ------------------------------ */

// Keep the swapped 3-bundle and one true single, then advance. Quota is half
// the screen, so two keeps are always inside it.
const keptPlan = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  const slots = u.currentPass.slots;
  const cells = Array.from(document.querySelectorAll('.photo-cell'));
  const bundle = cells.find((c) => (slots[c.dataset.id] || []).length === 3);
  const single = cells.find((c) => (slots[c.dataset.id] || [c.dataset.id]).length === 1);
  bundle.click(); single.click();
  return { expectPool: 3 + 1 };
});
await page.click('[data-t="advance"]');
await page.waitForSelector('[data-t="tobracket"]');

const folded = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  return { pool: u.pool.length, cut: u.cut.length };
});
check('keeping 2 decisions kept 4 of 10 photos', folded.pool === keptPlan.expectPool && folded.cut === 6,
  JSON.stringify(folded));

/* --- the bracket seats one competitor per group -------------------------- */

await page.click('[data-t="tobracket"]');
await page.waitForSelector('.bk-vp');

const seated = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  return {
    entrants: u.bracket.pool.length,
    capBadges: document.querySelectorAll('.stack-badge-cap').length
  };
});
check('4 photos seat as 2 competitors', seated.entrants === 2, seated.entrants);
check('the burst’s pane says it is a group', seated.capBadges === 1, seated.capBadges);

/* --- swap the competing face mid-bracket --------------------------------- */

const beforeBk = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  return u.bracket.pool.find((id) => (u.bracket.slots[id] || []).length > 1);
});
await page.click('.stack-badge-cap');
await page.waitForSelector('.stack-pick');
await page.click('.stack-pick .stack-opt:not(.current)');
await page.waitForTimeout(200);

const afterBk = await page.evaluate((oldId) => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  const nameOf = (id) => (s.photos[id] && s.photos[id].name) || id;
  const names = Array.from(document.querySelectorAll('.bk-cap .nm')).map((n) => n.textContent);
  const face = u.bracket.pool.find((id) => (u.bracket.slots[id] || []).length > 1);
  return {
    swapped: face !== oldId,
    inOrder: u.bracket.order.indexOf(face) >= 0,
    paneShowsIt: names.indexOf(nameOf(face)) >= 0,
    names: names, expected: nameOf(face)
  };
}, beforeBk);
check('the competitor face swapped', afterBk.swapped === true);
check('the bracket order carries the new face', afterBk.inOrder === true);
check('the pane shows the chosen frame', afterBk.paneShowsIt === true,
  JSON.stringify(afterBk.names) + ' vs ' + afterBk.expected);

/* --- decide the final; the standing belongs to the face ------------------ */

// Drive the bracket to completion — main final plus the second-chance round —
// always favouring the burst's face when it is on screen.
const winnerFace = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  return u.bracket.pool.find((id) => (u.bracket.slots[id] || []).length > 1);
});
for (let i = 0; i < 8; i++) {
  const st = await page.evaluate(() => {
    const s = window.PT.store.get();
    const u = s.session.units[s.session.activeUnitId];
    return { complete: u.bracket.complete, hasMatch: !!document.querySelector('.bk-vp img[src]') };
  });
  if (st.complete || !st.hasMatch) break;
  // Picks land on pointerup with real pointer state, so drive the choice the
  // way the cap legend says to: arrow keys, favouring the face's side.
  const side = await page.evaluate((face) => {
    const s = window.PT.store.get();
    const nameOf = (id) => (s.photos[id] && s.photos[id].name) || id;
    const names = Array.from(document.querySelectorAll('.bk-cap .nm')).map((n) => n.textContent);
    return names.indexOf(nameOf(face));
  }, winnerFace);
  await page.keyboard.press(side === 1 ? 'ArrowRight' : 'ArrowLeft');
  await page.waitForTimeout(250);
}

const decided = await page.evaluate((face) => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  return {
    complete: u.bracket.complete,
    winners: u.winners.slice(),
    faceFirst: u.winners[0] === face
  };
}, winnerFace);
check('the bracket runs to completion', decided.complete === true, JSON.stringify(decided.winners));
check('the swapped face holds the standing it won', decided.faceFirst === true, decided.winners[0]);

/* --- and the runoff still opens the bundle ------------------------------- */

const runoff = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = s.session.units[s.session.activeUnitId];
  const g = u.groups.find((gr) => gr.ids.length > 1 && gr.ids.indexOf(u.winners[0]) >= 0);
  return { finalistIsGrouped: !!g, members: g ? g.ids.length : 0, rep: g ? g.rep : null };
});
check('the winning face still belongs to its group of 3', runoff.finalistIsGrouped && runoff.members === 3,
  JSON.stringify(runoff));
check('the group’s rep is the face that won', runoff.rep === decided.winners[0]);

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await browser.close();
console.log(failed === 0 ? '\nBUNDLE OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Bundle-per-decision dealing, badge counts,
 *   mid-pass and mid-bracket face swaps, whole-burst keeps, and the runoff
 *   linkage surviving it all.
 */
