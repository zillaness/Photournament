// PRD 7.9 resumability: interrupt ingest at 50%, restart, and confirm the
// already-processed items are skipped via the fingerprint
// (hash + filename + byte size + last modified).
//
// Uses launchPersistentContext and a full browser restart between the two
// halves, so this is a real cross-session resume, not just a page reload.

import { chromium, serve, waitPort, CORPUS, OUT, save, rssSampler } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 8133;
const SUB = path.join(OUT, 'resume_corpus');
const PROFILE = path.join(OUT, 'resume_profile');
const HALF_OF = 60;

// Build a small isolated copy of the corpus we are free to mutate.
fs.rmSync(SUB, { recursive: true, force: true });
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(path.join(SUB, 'Day1'), { recursive: true });
const src = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name.endsWith('.jpg')) src.push(f);
  }
};
walk(CORPUS);
const picked = src.slice(0, HALF_OF);
picked.forEach((f) => fs.copyFileSync(f, path.join(SUB, 'Day1', path.basename(f))));

const srv = serve(PORT);
await waitPort(PORT);

const report = { corpusFiles: picked.length, phases: [] };

async function session(fn) {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    args: ['--no-sandbox', '--enable-precise-memory-info'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/harness.html`);
  await page.setInputFiles('#picker', SUB);
  await page.evaluate(() => window.__probe.loadFilesFromInput());
  const out = await fn(page);
  await ctx.close();
  return { ...out, pageErrors: errs };
}

// ---- phase 1: clean start, interrupt at 50% --------------------------------
const half = Math.floor(HALF_OF / 2);
const p1 = await session(async (page) => {
  await page.evaluate(() => window.__probe.clearDB());
  const samp = rssSampler(process.pid, 200);
  const r = await page.evaluate((n) => window.__probe.runIngest({ workers: 4, stopAfter: n, batch: 8 }), half);
  const rss = samp.stop();
  const db = await page.evaluate(() => window.__probe.dbSummary());
  return { run: r, db: { records: db.records, estimate: db.estimate }, hashes: db.hashes, rss };
});
report.phases.push({
  phase: 'initial-interrupted',
  requestedStopAfter: half,
  completed: p1.run.completed,
  interrupted: p1.run.interrupted,
  wallMs: p1.run.wallMs,
  idbRecords: p1.db.records,
  errors: p1.run.errorCount,
});
console.log(`phase1: completed=${p1.run.completed} interrupted=${p1.run.interrupted} idbRecords=${p1.db.records} wall=${p1.run.wallMs}ms`);

const hashesBefore = new Map(p1.hashes.map((h) => [h.key, h.phash]));

// ---- phase 2: browser fully restarted, resume ------------------------------
const p2 = await session(async (page) => {
  const r = await page.evaluate(() => window.__probe.runIngest({ workers: 4, resume: true, batch: 8 }));
  const db = await page.evaluate(() => window.__probe.dbSummary());
  return { run: r, db: { records: db.records }, hashes: db.hashes };
});
report.phases.push({
  phase: 'resume-after-browser-restart',
  skipped: p2.run.skipped,
  processed: p2.run.completed,
  wallMs: p2.run.wallMs,
  idbRecords: p2.db.records,
  errors: p2.run.errorCount,
});
console.log(
  `phase2: skipped=${p2.run.skipped} processed=${p2.run.completed} idbRecords=${p2.db.records} wall=${p2.run.wallMs}ms`
);

// Did the survivors of phase 1 keep the same perceptual hash after resume?
const hashesAfter = new Map(p2.hashes.map((h) => [h.key, h.phash]));
let stable = 0,
  drifted = 0;
for (const [k, v] of hashesBefore) {
  if (hashesAfter.has(k)) hashesAfter.get(k) === v ? stable++ : drifted++;
}
report.hashStability = { compared: stable + drifted, identical: stable, drifted };
console.log(`hash stability across sessions: ${stable} identical, ${drifted} drifted`);

// ---- phase 3: third run, everything already cached -------------------------
const p3 = await session(async (page) => {
  const r = await page.evaluate(() => window.__probe.runIngest({ workers: 4, resume: true }));
  return { run: r };
});
report.phases.push({
  phase: 'fully-cached',
  skipped: p3.run.skipped,
  processed: p3.run.completed,
  wallMs: p3.run.wallMs,
});
console.log(`phase3 (all cached): skipped=${p3.run.skipped} processed=${p3.run.completed} wall=${p3.run.wallMs}ms`);

// ---- phase 4: perturb the fingerprint components ---------------------------
// One file per mutation, to see exactly which component invalidates the cache.
const files = fs.readdirSync(path.join(SUB, 'Day1')).sort();
const touched = files[0]; // same bytes, new mtime
const grown = files[1]; // one extra byte appended (comment marker, still decodable)
const renamed = files[2]; // same bytes, new name
const untouched = files[3];

const tp = path.join(SUB, 'Day1', touched);
const future = new Date(Date.now() + 86400000);
fs.utimesSync(tp, future, future);

const gp = path.join(SUB, 'Day1', grown);
fs.appendFileSync(gp, Buffer.from([0x00])); // trailing byte after EOI; decoders ignore it

const rpOld = path.join(SUB, 'Day1', renamed);
const rpNew = path.join(SUB, 'Day1', 'RENAMED_' + renamed);
fs.renameSync(rpOld, rpNew);

const p4 = await session(async (page) => {
  const r = await page.evaluate(() => window.__probe.runIngest({ workers: 4, resume: true }));
  const db = await page.evaluate(() => window.__probe.dbSummary());
  return { run: r, hashes: db.hashes, records: db.records };
});
const after4 = new Map(p4.hashes.map((h) => [h.key, h.phash]));

// A perturbed file leaves the old record behind under its old key, so return
// every record whose key mentions this basename rather than the first hit.
function findHash(map, basename) {
  const hits = [];
  for (const [k, v] of map) if (k.includes(basename)) hits.push({ key: k, phash: v });
  return hits;
}
const brief = (hits) => (hits || []).map((h) => h.key.split('|').slice(1).join('|') + ' -> ' + h.phash);

report.fingerprintPerturbation = {
  reprocessed: p4.run.completed,
  skipped: p4.run.skipped,
  expectReprocessed: 3,
  mutations: {
    touchedMtime: { file: touched, before: findHash(hashesAfter, touched), after: findHash(after4, touched) },
    appendedByte: { file: grown, before: findHash(hashesAfter, grown), after: findHash(after4, grown) },
    renamed: { from: renamed, to: 'RENAMED_' + renamed, before: findHash(hashesAfter, renamed), after: findHash(after4, renamed) },
    untouched: { file: untouched, before: findHash(hashesAfter, untouched), after: findHash(after4, untouched) },
  },
  idbRecordsAfter: p4.records,
};
console.log(
  `phase4 (mtime touch + 1 byte appended + rename): reprocessed=${p4.run.completed} skipped=${p4.run.skipped} ` +
    `(expected 3 reprocessed)  idbRecords=${p4.records}`
);
for (const [k, m] of Object.entries(report.fingerprintPerturbation.mutations)) {
  console.log(`  ${k}: records now = ${JSON.stringify(brief(m.after))}`);
}

srv.kill();
save('resume.json', report);
