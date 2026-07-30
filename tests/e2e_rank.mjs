/**
 * file: e2e_rank.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-30
 * last_updated: 2026-07-30
 * description: Ranking mode end to end: rank intent set on the tree, the duplicate gate skipped with bundles still materialised, the priced offer leading the setup screen, full-order ranking through the bracket with depth decoupled from the keep cap, and the standings pre-choosing the folder's target.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * The invariant under test: ranking is an ORDERING, not a cut. A rank-marked
 * folder never sees a grid pass or the review gate, bursts still compete as
 * one, the engine decides the depth the user priced, and the keep cap stays
 * the folder's target.
 *
 * Run: node tests/e2e_rank.mjs
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
/* Same corpus construction as e2e_bundle.mjs: frames of a scene differ by an
 * exposure step and grain (a burst), scenes differ by spatial frequency and
 * phase (genuinely different pictures). */

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

// One burst of three, five distinct singles: 8 photos, 6 competitors.
const tmp = path.join(os.tmpdir(), 'pt-rank-' + Date.now());
mkdirSync(path.join(tmp, 'Roll'), { recursive: true });
for (let f = 0; f < 3; f++) {
  writeFileSync(path.join(tmp, 'Roll', `burst_${f}.png`), makeFrame(240, 180, 0, f));
}
for (let sc = 2; sc < 7; sc++) {
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

/* --- rank intent on the tree --------------------------------------------- */

await page.fill('input.tree-alloc[data-path$="/Roll"]', '3');
await page.click('[data-t="rank-toggle"][data-path$="/Roll"]');
const toggled = await page.evaluate(() => ({
  on: !!document.querySelector('[data-t="rank-toggle"].on'),
  stored: Object.keys(window.PT.store.get().session.rankPaths || {})
}));
check('the rank toggle takes and persists per path', toggled.on && toggled.stored.length === 1,
  JSON.stringify(toggled.stored));

await page.evaluate(() => {
  Array.from(document.querySelectorAll('button'))
    .find((x) => /start culling/i.test(x.textContent) && !x.disabled).click();
});

/* --- the gate is skipped, the grouping is not ----------------------------- */

await page.waitForSelector('[data-t="rank-card"]', { timeout: 60000 });
const skipped = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = Object.values(s.session.units)[0];
  const nameOf = (id) => (s.photos[id] && s.photos[id].name) || id;
  const nameSets = (u.groups || []).map((g) => g.ids.map(nameOf));
  return {
    dupeScreen: !!document.querySelector('#dupe-continue'),
    groupStatus: s.session.groups && s.session.groups.status,
    unitRank: u.rank,
    burstWhole: nameSets.some((ns) => [0, 1, 2].every((f) => ns.indexOf('burst_' + f + '.png') >= 0))
  };
});
check('the review gate is skipped', !skipped.dupeScreen && skipped.groupStatus === 'done',
  'status=' + skipped.groupStatus);
check('the burst is still bundled, without the review', skipped.burstWhole);
check('rank intent landed on the unit', skipped.unitRank === true);

/* --- the offer leads, priced ---------------------------------------------- */

const offer = await page.evaluate(() => {
  const card = document.querySelector('[data-t="rank-card"]');
  const start = document.querySelector('[data-t="start-pass"]');
  const opts = Array.from(card.querySelectorAll('.rank-opt')).map((b) => ({
    t: b.dataset.t,
    pressed: b.getAttribute('aria-pressed'),
    priced: /~\d+ comparisons/.test(b.textContent)
  }));
  return {
    leads: !!(card && start && (card.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING)),
    opts: opts,
    projection: (document.querySelector('[data-t="rank-projection"]') || {}).textContent || ''
  };
});
check('the offer leads the setup screen for a rank-marked folder', offer.leads);
check('every depth option carries its price', offer.opts.length >= 2 && offer.opts.every((o) => o.priced),
  JSON.stringify(offer.opts.map((o) => o.t)));
check('the culling path is priced beside it', /screens|bracket/i.test(offer.projection),
  offer.projection.slice(0, 60));
check('the folder target arrives pre-selected as the depth', offer.opts.some(
  (o) => o.t === 'rank-opt-top' && o.pressed === 'true'));

/* --- full-order ranking: depth apart from cap ----------------------------- */

await page.click('[data-t="rank-opt-full"]');
await page.click('[data-t="rank-start"]');
await page.waitForSelector('.bk-vp');

const seated = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = Object.values(s.session.units)[0];
  return { phase: u.phase, rank: u.bracket.rank, depth: u.bracket.target, cap: u.bracket.cap,
           competitors: u.bracket.pool.length, rankDepth: u.rankDepth };
});
check('the engine seats the priced depth, the cap stays the target',
  seated.phase === 'bracket' && seated.rank === true &&
  seated.depth === seated.competitors && seated.cap === 3,
  JSON.stringify(seated));

// Judge every pairing (left always wins); a full order of 6 is bounded well
// under 40 comparisons, so the loop cannot spin.
for (let i = 0; i < 40; i++) {
  const done = await page.evaluate(() => !!document.querySelector('.bk-row.bk-choosable'));
  if (done) break;
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(60);
}
await page.waitForSelector('.bk-row.bk-choosable', { timeout: 10000 });

const standings = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = Object.values(s.session.units)[0];
  const kids = Array.from(document.getElementById('bk-results').children);
  return {
    tag: (document.querySelector('.bk-tag') || {}).textContent,
    rows: document.querySelectorAll('.bk-row').length,
    chosen: document.querySelectorAll('.bk-row.chosen').length,
    cutoffAfter: kids.findIndex((k) => k.dataset && k.dataset.t === 'cutoff'),
    winners: u.winners.length,
    decided: u.winnersDecided,
    comparisons: u.comparisons
  };
});
// The competitor count comes from the store, not a constant: the procedural
// corpus is allowed to cluster its "singles" (the known trap — see the bundle
// test), and the invariant is every-competitor-ranked, not any exact number.
check('the whole field arrives ranked, every place decided',
  standings.rows === seated.competitors && standings.decided === seated.competitors,
  JSON.stringify(standings));
check('the standings say Ranking complete', standings.tag === 'Ranking complete', standings.tag);
check('the cap pre-chooses the folder target through the full order',
  standings.chosen === 3 && standings.winners === 3 && standings.cutoffAfter === 3,
  'chosen=' + standings.chosen + ' cutoff@' + standings.cutoffAfter);

/* --- the runoff still opens for the bundled burst -------------------------- */

await page.click('#bk-continue');
await page.waitForSelector('#ro-list', { timeout: 10000 });
const runoff = await page.evaluate(() => {
  const s = window.PT.store.get();
  const u = Object.values(s.session.units)[0];
  return { phase: u.phase, groups: document.querySelectorAll('#ro-list .ro-group').length };
});
check('the runoff opens downstream of a ranking', runoff.phase === 'runoff');

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await browser.close();
console.log(failed === 0 ? '\nRANK OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-30): Initial release. Tree toggle to skipped gate to priced
 *   offer to full-order ranking, asserting depth/cap separation, bundle
 *   survival without the review, and the pre-chosen target on the standings.
 */
