// Drives src/js/10_ingest_worker.js in real Chromium from a file:// URL.
//
// Usage: node run_ingest.mjs [heic|mixed|memory|raf|resume|inline|all]
//
// Files reach the page through a real <input type=file>, so the records under
// test are built from genuine File objects with real name/size/lastModified —
// the same shape the app gets from a folder drop.

import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
import fs from 'node:fs';
import path from 'node:path';
import { save, rssByType, typedSampler, OUT } from './lib.mjs';

const DIR = '/home/user/Photournament/tools/probes/03_pipeline';
const FIX = path.join(DIR, 'fixtures');
const HEIC = '/home/user/Photournament/tools/probes/02_heic/fixtures';
const HARNESS = 'file://' + path.join(DIR, 'harness.html');
const LIBHEIF = '/home/user/Photournament/node_modules/libheif-js/libheif-wasm/libheif-bundle.js';
const which = (process.argv[2] || 'all').toLowerCase();

async function open() {
  // Headless Chromium does not vsync-lock requestAnimationFrame, so the frame
  // timing test is also run headed under Xvfb (PT_HEADED=1) where 60 Hz is real.
  const browser = await chromium.launch({ args: ['--no-sandbox'], headless: !process.env.PT_HEADED });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(HARNESS);
  return { browser, page, errors };
}
const setFiles = (page, files) => page.setInputFiles('#picker', files);

async function writeDerivative(page, idx, which_, file) {
  const b64 = await page.evaluate(([i, w]) => window.D.blobB64(i, w), [idx, which_]);
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(path.join(OUT, file), buf);
  return { file, bytes: buf.length };
}

// ---------------------------------------------------------------------------
// 1. Real HEIC end to end, plus orientation
// ---------------------------------------------------------------------------
async function testHeic() {
  const { browser, page, errors } = await open();
  const files = [
    path.join(HEIC, 'photo_12mp.heic'),
    path.join(FIX, 'rot90_ccw.heic'),
    path.join(FIX, 'rot180.heic'),
    path.join(HEIC, 'example_strukturag.heic'),
    path.join(HEIC, 'nokia_C003.heic')
  ];
  await setFiles(page, files);
  const poolInfo = await page.evaluate(() => window.D.makePool({ size: 2 }));
  const t0 = Date.now();
  const recs = await page.evaluate(() => window.D.runAll());
  const wall = Date.now() - t0;

  const written = [];
  for (let i = 0; i < files.length; i++) {
    const base = path.basename(files[i]).replace(/\.[^.]+$/, '');
    written.push(await writeDerivative(page, i, 'thumb', `thumb_${base}.jpg`));
    written.push(await writeDerivative(page, i, 'preview', `preview_${base}.jpg`));
  }

  // Did libheif actually apply irot, or only renumber the dimensions?
  const rot90 = await page.evaluate(() => window.D.compareRotations(0, 1));
  const rot180 = await page.evaluate(() => window.D.compareRotations(0, 2));

  const stats = await page.evaluate(() => window.D.stats());
  const logs = await page.evaluate(() => window.PT.__logs);
  await page.evaluate(() => window.D.terminate());
  await browser.close();
  const out = {
    poolInfo, wallMs: wall, stats, records: recs, written: written.filter(Boolean), pageErrors: errors, logs,
    orientation: {
      note: 'mean abs RGB difference (0-255) of the base thumbnail vs the irot fixture thumbnail under each quarter-turn hypothesis; the smallest is what happened',
      'irot=1 (90 CCW) fixture': rot90,
      'irot=2 (180) fixture': rot180
    }
  };
  save('heic.json', out);
  console.log(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------------------
// 2. Memory: N sequential 12 MP HEIC decodes through one pool
// ---------------------------------------------------------------------------
async function testMemory(n = 60) {
  const { browser, page, errors } = await open();
  await setFiles(page, [path.join(HEIC, 'photo_12mp.heic')]);
  await page.evaluate(() => window.D.makePool({ size: 1 }));
  const pid = browser.__pid || process.pid;
  const sampler = typedSampler(pid, 400);
  const t0 = Date.now();
  const res = await page.evaluate(([count]) => window.D.runSequential(0, count, 10), [n]);
  const wall = Date.now() - t0;
  const rss = sampler.stop();
  const stats = await page.evaluate(() => window.D.stats());
  await page.evaluate(() => window.D.terminate());
  await browser.close();

  const heaps = res.checkpoints.map((c) => c.wasmHeapBytes[0]);
  const times = res.times.slice().sort((a, b) => a - b);
  const out = {
    decodes: n,
    wallMs: wall,
    msPerImage: Math.round(wall / n),
    perImage: {
      min: times[0], median: times[Math.floor(times.length / 2)],
      p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1]
    },
    wasmHeapMB: res.checkpoints.map((c) => ({ afterDecodes: c.n, mb: +(c.wasmHeapBytes[0] / 1048576).toFixed(1) })),
    heapGrowthPerDecodeMB: heaps.length > 1
      ? +(((heaps[heaps.length - 1] - heaps[0]) / 1048576) / (res.checkpoints[res.checkpoints.length - 1].n - res.checkpoints[0].n)).toFixed(4)
      : null,
    projectedAt500MB: heaps.length > 1
      ? +((heaps[0] + ((heaps[heaps.length - 1] - heaps[0]) / (res.checkpoints[res.checkpoints.length - 1].n - res.checkpoints[0].n)) * 500) / 1048576).toFixed(0)
      : null,
    processRssMB: rss,
    lastPhash: res.lastPhash, lastDims: [res.lastW, res.lastH], firstErr: res.firstErr || null,
    stats, pageErrors: errors
  };
  save('memory.json', out);
  console.log(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------------------
// 3. Mixed corpus: right kind, right derivatives, failures set err
// ---------------------------------------------------------------------------
async function testMixed() {
  const { browser, page, errors } = await open();
  const files = [
    'plain_800x600.jpg', 'exif_o6_800x600.jpg', 'exif_o8_800x600.jpg', 'exif_o3_800x600.jpg',
    'plain_640x480.png', 'plain_640x480.webp', 'tiny_40x30.jpg',
    'truncated.heic', 'corrupt.jpg', 'notreally.jpg', 'empty.jpg'
  ].map((f) => path.join(FIX, f));
  files.push(path.join(HEIC, 'nokia_C003.heic'));
  await setFiles(page, files);
  await page.evaluate(() => window.D.makePool({ size: 4 }));
  const recs = await page.evaluate(() => window.D.runAll());
  const corners = [];
  for (let i = 0; i < 4; i++) corners.push(await page.evaluate(([k]) => window.D.corners(k), [i]));
  for (let i = 0; i < 7; i++) {
    await writeDerivative(page, i, 'thumb', `mixed_thumb_${path.basename(files[i])}.jpg`);
  }
  const stats = await page.evaluate(() => window.D.stats());
  const events = await page.evaluate(() => window.PT.__events.filter((e, i, a) => a.indexOf(e) === i));
  await page.evaluate(() => window.D.terminate());
  await browser.close();
  const out = {
    records: recs.map((r, i) => ({ file: path.basename(files[i]), ...r })),
    cornerColours: corners.map((c, i) => ({ file: path.basename(files[i]), ...c })),
    stats, busEvents: events, pageErrors: errors
  };
  save('mixed.json', out);
  console.log(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------------------
// 4. Main-thread responsiveness during a real run
// ---------------------------------------------------------------------------
async function testRaf(n = 60) {
  const { browser, page, errors } = await open();
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push(path.join(HEIC, process.env.PT_ALL12MP ? 'photo_12mp.heic'
      : i % 3 === 0 ? 'photo_12mp.heic' : i % 3 === 1 ? 'example_strukturag.heic' : 'nokia_C003.heic'));
  }
  await setFiles(page, list);
  await page.evaluate(() => window.D.makePool({ size: 4 }));

  const baseline = await page.evaluate(() => {
    window.D.rafStart();
    window.D.latStart();
    return new Promise((r) => setTimeout(() => r({ raf: window.D.rafStop(), lat: window.D.latStop() }), 3000));
  });

  // Every job is queued at once, so this also answers "does memory stay bounded
  // regardless of queue depth" (PRD 8).
  await page.evaluate(() => { window.D.rafStart(); window.D.latStart(); });
  const sampler = typedSampler(process.pid, 300);
  const t0 = Date.now();
  const recs = await page.evaluate(() => window.D.runAll());
  const wall = Date.now() - t0;
  const rss = sampler.stop();
  const during = await page.evaluate(() => ({ raf: window.D.rafStop(), lat: window.D.latStop() }));
  const stats = await page.evaluate(() => window.D.stats());
  await page.evaluate(() => window.D.terminate());
  await browser.close();
  const failed = recs.filter((r) => r.err);
  const out = {
    images: n, workers: 4, wallMs: wall, msPerImage: Math.round(wall / n),
    idle: baseline, duringIngest: during, headed: !!process.env.PT_HEADED, all12mp: !!process.env.PT_ALL12MP, processRssMB: rss,
    stats, failedCount: failed.length, failedSample: failed.slice(0, 3), pageErrors: errors
  };
  save('raf.json', out);
  console.log(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------------------
// 5. Fingerprint stability + skip-on-resume
// ---------------------------------------------------------------------------
async function testResume() {
  const { browser, page, errors } = await open();
  const files = [
    path.join(HEIC, 'photo_12mp.heic'),
    path.join(FIX, 'plain_800x600.jpg'),
    path.join(FIX, 'plain_640x480.png')
  ];
  await setFiles(page, files);

  // Pass 1: cold, no cache.
  await page.evaluate(() => window.D.makePool({ size: 2, lookup: true }));
  const t1 = Date.now();
  const pass1 = await page.evaluate(() => window.D.runAll());
  const wall1 = Date.now() - t1;
  // Seed the cache with what pass 1 produced.
  await page.evaluate(() => {
    window.D.records.forEach((r) => window.D.seedCache(r.id, { w: r.w, h: r.h, phash: r.phash, sharp: r.sharp, kind: r.kind, thumb: r.thumb, preview: r.preview }));
  });
  await page.evaluate(() => window.D.terminate());

  // Pass 2: same files, warm cache. Should skip decoding entirely.
  await page.evaluate(() => window.D.makePool({ size: 2, lookup: true }));
  const t2 = Date.now();
  const pass2 = await page.evaluate(() => window.D.runAll());
  const wall2 = Date.now() - t2;
  const hits = await page.evaluate(() => window.D.lookupHits());

  // Main-thread PT.ingest.fingerprint must agree with the worker's.
  const mainFp = [];
  for (let i = 0; i < files.length; i++) mainFp.push(await page.evaluate(([k]) => window.D.fingerprintFile(k), [i]));

  await page.evaluate(() => window.D.terminate());
  await browser.close();
  const out = {
    pass1: { wallMs: wall1, ids: pass1.map((r) => r.id), phash: pass1.map((r) => r.phash), fromCache: pass1.map((r) => r.fromCache) },
    pass2: { wallMs: wall2, ids: pass2.map((r) => r.id), phash: pass2.map((r) => r.phash), fromCache: pass2.map((r) => r.fromCache) },
    idsStable: JSON.stringify(pass1.map((r) => r.id)) === JSON.stringify(pass2.map((r) => r.id)),
    mainThreadFingerprints: mainFp,
    mainMatchesWorker: JSON.stringify(mainFp) === JSON.stringify(pass1.map((r) => r.id)),
    lookupHits: hits,
    speedup: +(wall1 / Math.max(1, wall2)).toFixed(1),
    pageErrors: errors
  };
  save('resume.json', out);
  console.log(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------------------
// 6. Inlined libheif source (the single-file build path)
// ---------------------------------------------------------------------------
async function testInline() {
  const { browser, page, errors } = await open();
  const src = fs.readFileSync(LIBHEIF, 'utf8');
  await page.evaluate((s) => { window.__libheifSrc = s; }, src);
  await setFiles(page, [path.join(HEIC, 'nokia_C003.heic'), path.join(FIX, 'plain_800x600.jpg')]);
  const info = await page.evaluate(() => window.D.makePool({ size: 1, inline: true }));
  const recs = await page.evaluate(() => window.D.runAll());
  const workerSrcLen = await page.evaluate(() => window.D.workerSrcLength());
  await page.evaluate(() => window.D.terminate());
  await browser.close();
  const out = { poolInfo: info, libheifSrcBytes: src.length, workerSrcLength: workerSrcLen, records: recs, pageErrors: errors };
  save('inline.json', out);
  console.log(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------------------
// 7. Contract details: default pool size, WORKER_SRC shape, PT.phash override
// ---------------------------------------------------------------------------
async function testContract() {
  const { browser, page, errors } = await open();
  await setFiles(page, [path.join(FIX, 'plain_800x600.jpg')]);
  const shape = await page.evaluate(() => {
    var src = PT.ingest.WORKER_SRC;
    return {
      hardwareConcurrency: navigator.hardwareConcurrency,
      hasWorkerSrc: typeof src === 'string',
      workerSrcBytes: src.length,
      esmTokens: /(^|\n)\s*(import|export)\s/.test(src),
      api: ['WORKER_SRC', 'createPool', 'fingerprint', 'setLibheifSource', 'blankRecord']
        .map(function (k) { return k + '=' + typeof PT.ingest[k]; })
    };
  });
  const defaultSize = await page.evaluate(() => {
    var p = PT.ingest.createPool({ libheifUrl: null });
    var s = p.size;
    p.terminate();
    return s;
  });

  // A fake PT.phash injected as extraSrc must win over the inlined dhash.
  const withHook = await page.evaluate(() => {
    var extra = 'self.PT = self.PT || {}; self.PT.phash = function(){ return "deadbeefcafe1234"; };';
    var pool = PT.ingest.createPool({ size: 1, libheifUrl: null, extraSrc: extra });
    return pool.process(window.D.files()[0], { path: 'a/b.jpg' }).then(function (r) {
      pool.terminate();
      return { phash: r.phash, err: r.err };
    });
  });
  // A PT.phash that returns rubbish must be ignored, not trusted.
  const withBadHook = await page.evaluate(() => {
    var extra = 'self.PT = self.PT || {}; self.PT.phash = function(){ return "not-a-hash"; };';
    var pool = PT.ingest.createPool({ size: 1, libheifUrl: null, extraSrc: extra });
    return pool.process(window.D.files()[0], { path: 'a/b.jpg' }).then(function (r) {
      pool.terminate();
      return { phash: r.phash, err: r.err };
    });
  });
  // A HEIC with no libheif configured at all must fail cleanly, not hang.
  await setFiles(page, [path.join(HEIC, 'nokia_C003.heic')]);
  const noLibheif = await page.evaluate(() => {
    var pool = PT.ingest.createPool({ size: 1, libheifUrl: null });
    return pool.process(window.D.files()[0], { path: 'a/b.heic' }).then(function (r) {
      pool.terminate();
      return { kind: r.kind, err: r.err, thumb: !!r.thumb };
    });
  });
  // The real 20_phash.js, injected as extraSrc. It exports a namespace object,
  // not a bare function, so this checks the hook actually reaches PT.phash.phash.
  const phashSrc = fs.readFileSync('/home/user/Photournament/src/js/20_phash.js', 'utf8');
  await setFiles(page, [path.join(FIX, 'plain_800x600.jpg')]);
  const withRealPhash = await page.evaluate((extra) => {
    var pool = PT.ingest.createPool({ size: 1, libheifUrl: null, extraSrc: extra });
    return pool.process(window.D.files()[0], { path: 'a/b.jpg' }).then(function (r) {
      pool.terminate();
      return { phash: r.phash, sharp: r.sharp, err: r.err };
    });
  }, phashSrc);
  const withoutRealPhash = await page.evaluate(() => {
    var pool = PT.ingest.createPool({ size: 1, libheifUrl: null });
    return pool.process(window.D.files()[0], { path: 'a/b.jpg' }).then(function (r) {
      pool.terminate();
      return { phash: r.phash, sharp: r.sharp, err: r.err };
    });
  });

  await browser.close();
  const out = { shape, defaultSize, withHook, withBadHook, noLibheif, withRealPhash, withoutRealPhash, pageErrors: errors };
  save('contract.json', out);
  console.log(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------------------
const runs = {
  contract: testContract,
  heic: testHeic,
  memory: () => testMemory(Number(process.argv[3] || 60)),
  mixed: testMixed,
  raf: () => testRaf(Number(process.argv[3] || 60)),
  resume: testResume,
  inline: testInline
};
if (which === 'all') {
  for (const k of ['heic', 'mixed', 'inline', 'resume', 'raf', 'memory']) {
    console.log('\n===== ' + k + ' =====');
    await runs[k]();
  }
} else if (runs[which]) {
  await runs[which]();
} else {
  console.error('unknown: ' + which);
  process.exit(2);
}
void rssByType;
