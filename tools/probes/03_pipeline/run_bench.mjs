// Concurrency / transfer / decode-strategy / encode-format sweep over the
// 500-image corpus, plus the unbounded-decode control arm for PRD section 8.
//
// Usage: node run_bench.mjs [suite]
//   suite: all (default) | concurrency | transfer | strategy | format | control

import { chromium, serve, waitPort, CORPUS, rssSampler, save, browserRssMB } from './lib.mjs';

const PORT = 8132;
const SUITE = process.argv[2] || 'all';
const N = Number(process.env.N || 500);

const srv = serve(PORT);
await waitPort(PORT);

const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-precise-memory-info', '--js-flags=--max-old-space-size=4096'],
});

async function freshPage() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('console: ' + m.text());
  });
  await page.goto(`http://127.0.0.1:${PORT}/harness.html`);
  await page.setInputFiles('#picker', CORPUS);
  const loaded = await page.evaluate(() => window.__probe.loadFilesFromInput());
  await page.evaluate(() => window.__probe.clearDB());
  return { ctx, page, errs, loaded };
}

const nodeBaselineMB = browserRssMB(process.pid);
const results = { env: {}, nodeBaselineMB, runs: [] };

async function run(label, opts) {
  const { ctx, page, errs, loaded } = await freshPage();
  if (!results.env.hardwareConcurrency) {
    results.env = await page.evaluate(() => ({
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory || null,
      ua: navigator.userAgent,
      crossOriginIsolated: self.crossOriginIsolated,
      hasPerformanceMemory: !!performance.memory,
      preciseMemory: !!(performance.memory && performance.memory.usedJSHeapSize),
    }));
    results.env.filesSeen = loaded.count;
    results.env.corpusBytes = loaded.totalBytes;
  }
  const idleRss = browserRssMB(process.pid);
  const samp = rssSampler(process.pid, 200);
  const t0 = Date.now();
  const r = await page.evaluate((o) => window.__probe.runIngest(o), opts);
  const driverWallMs = Date.now() - t0;
  const rss = samp.stop();
  const db = await page.evaluate(() => window.__probe.dbSummary());
  await ctx.close();

  const row = {
    label,
    opts,
    driverWallMs,
    wallMs: r.wallMs,
    perImageMs: r.perImageMs,
    throughputPerSec: r.throughputPerSec,
    completed: r.completed,
    errorCount: r.errorCount,
    errors: r.errors,
    mainThreadReadMs: r.mainThreadReadMs,
    stageMs: r.stageMs,
    frames: r.frames,
    pageHeap: r.heap,
    processRss: { idleBeforeMB: idleRss, ...rss },
    bytes: r.bytes,
    idbRecords: db.records,
    idbThumbBytes: db.thumbBytes,
    idbPreviewBytes: db.previewBytes,
    idbEstimate: db.estimate,
    idbError: r.idbError,
    pageErrors: errs.slice(0, 5),
  };
  results.runs.push(row);
  save(`bench_${SUITE}.json`, results); // checkpoint after every run
  console.log(
    `${label.padEnd(34)} wall=${(r.wallMs / 1000).toFixed(1)}s  ` +
      `${r.perImageMs}ms/img  thr=${r.throughputPerSec}/s  ` +
      `rafP95=${r.frames ? r.frames.p95.toFixed(1) : '-'}ms rafMax=${r.frames ? r.frames.max.toFixed(0) : '-'}ms  ` +
      `rssPeak=${rss ? rss.peakMB : '-'}MB  heapPeak=${r.heap ? r.heap.peakMB : '-'}MB  err=${r.errorCount}`
  );
  return row;
}

const base = { limit: N, strategy: 'sized', kind: 'blob', format: 'image/jpeg', persist: true, batch: 24 };

if (SUITE === 'all' || SUITE === 'concurrency') {
  console.log('\n== concurrency sweep (kind=blob, strategy=sized) ==');
  for (const w of [1, 2, 3, 4, 6, 8]) await run(`workers=${w}`, { ...base, workers: w });
}

if (SUITE === 'all' || SUITE === 'transfer') {
  console.log('\n== transfer strategy sweep (workers=4) ==');
  for (const kind of ['blob', 'arraybuffer', 'imagebitmap']) {
    await run(`kind=${kind}`, { ...base, workers: 4, kind });
  }
}

if (SUITE === 'all' || SUITE === 'strategy') {
  console.log('\n== decode strategy sweep (workers=4, kind=blob) ==');
  for (const s of ['sized', 'full']) await run(`strategy=${s}`, { ...base, workers: 4, strategy: s });
  console.log('\n== hash variant ==');
  for (const h of ['dct', 'dhash']) await run(`hash=${h}`, { ...base, workers: 4, hash: h });
  console.log('\n== IndexedDB cost + batch size ==');
  await run('persist=false', { ...base, workers: 4, persist: false });
  for (const b of [1, 8, 24, 64]) await run(`batch=${b}`, { ...base, workers: 4, batch: b });
  console.log('\n== realistic UI: paint every thumb into a grid ==');
  await run('renderThumbs=true', { ...base, workers: 4, renderThumbs: true });
}

if (SUITE === 'all' || SUITE === 'format') {
  console.log('\n== encode format / quality (workers=4) ==');
  for (const f of ['image/jpeg', 'image/webp']) {
    for (const q of [0.6, 0.72, 0.85]) {
      await run(`${f} q=${q}`, { ...base, workers: 4, format: f, thumbQuality: q, previewQuality: q });
    }
  }
}

if (SUITE === 'all' || SUITE === 'control') {
  console.log('\n== control: hold every decode at once (PRD section 8) ==');
  const { ctx, page } = await freshPage();
  const samp = rssSampler(process.pid, 200);
  let r;
  try {
    r = await page.evaluate((n) => window.__probe.unboundedControl(n), N);
  } catch (e) {
    // A renderer OOM-crash is itself the answer to "can 500 decodes coexist".
    r = { rendererCrashed: true, error: String(e.message).slice(0, 400), requested: N, held: null, rgbaBytesIfMaterialised: 0, wallMs: 0 };
  }
  const rss = samp.stop();
  results.unboundedControl = { ...r, processRss: rss };
  console.log(
    `held=${r.held}/${r.requested} failedAt=${r.failedAt} crashed=${!!r.rendererCrashed} err=${r.error} ` +
      `rgba=${(r.rgbaBytesIfMaterialised / 1e6).toFixed(0)}MB rssPeak=${rss ? rss.peakMB : '-'}MB wall=${(r.wallMs / 1000).toFixed(1)}s`
  );
  save(`bench_${SUITE}.json`, results);
  try {
    await ctx.close();
  } catch {
    /* context may already be gone if the renderer crashed */
  }
}

await browser.close();
srv.kill();
save(`bench_${SUITE}.json`, results);
