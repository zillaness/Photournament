/**
 * Probe 02_heic — benchmarks.
 *
 *  1. COLD parse+init, fresh browser process per trial, both builds, file://
 *  2. WARM per-image decode, N iterations, both builds, all fixtures
 *  3. MEMORY: 12 sequential 12MP decodes, JS heap + wasm heap tracked
 *  4. PARALLEL: 1/2/4/8 blob workers decoding the 12MP fixture, wall-clock
 *  5. FULL INGEST STEP: decode + OffscreenCanvas JPEG sidecar + 320px thumb,
 *     inside a worker — the thing PRD 7.9 actually has to do per photo
 *
 * usage: node bench.js [--iters N] [--quick]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const FIX = path.join(ROOT, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });
require('./gen_harness.js');

const itersIdx = process.argv.indexOf('--iters');
const ITERS = itersIdx > -1 ? +process.argv[itersIdx + 1] : 7;
const COLD_TRIALS = process.argv.includes('--quick') ? 3 : 5;
const BUILD_URL = {
  wasm: '../../../../node_modules/libheif-js/libheif-wasm/libheif-bundle.js',
  asm: '../../../../node_modules/libheif-js/libheif/libheif.js'
};
const FIXTURES = ['photo_12mp.heic', 'example_strukturag.heic', 'nokia_C003.heic'];
const bytesOf = f => Array.from(fs.readFileSync(path.join(FIX, f)));

const stat = a => {
  const s = [...a].sort((x, y) => x - y);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: +s[0].toFixed(1), median: +q(0.5).toFixed(1), max: +s[s.length - 1].toFixed(1),
    mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(1) };
};

const launch = () => chromium.launch({ args: ['--no-proxy-server', '--js-flags=--expose-gc'] });

async function coldInit(build) {
  const trials = [];
  for (let i = 0; i < COLD_TRIALS; i++) {
    const b = await launch();                       // fresh process -> no code cache
    const ctx = await b.newContext();               // fresh context -> no disk cache reuse
    const p = await ctx.newPage();
    await p.goto('file://' + path.join(OUT, `h_${build}.html`), { waitUntil: 'load' });
    await p.waitForFunction('window.__ready === true');
    const info = await p.evaluate('window.__probe.buildInfo()');
    trials.push(info);
    await b.close();
  }
  return {
    scriptParseMs: stat(trials.map(t => t.scriptParseMs)),
    factoryMs: stat(trials.map(t => t.factoryMs)),
    totalInitMs: stat(trials.map(t => t.parseInitMs)),
    wasmHeapAfterInit: trials[0].wasmHeapBytes
  };
}

async function warmDecode(build) {
  const b = await launch();
  const p = await (await b.newContext()).newPage();
  await p.goto('file://' + path.join(OUT, `h_${build}.html`), { waitUntil: 'load' });
  await p.waitForFunction('window.__ready === true');
  const res = {};
  for (const f of FIXTURES) {
    const bytes = bytesOf(f);
    const runs = await p.evaluate(([bts, n]) => window.__probe.decodeRepeat(bts, n), [bytes, ITERS]);
    const dims = await p.evaluate(bts => {
      const d = new window.__lib.HeifDecoder(); const im = d.decode(new Uint8Array(bts))[0];
      return { w: im.get_width(), h: im.get_height() };
    }, bytes);
    res[f] = {
      dims, mp: +((dims.w * dims.h) / 1e6).toFixed(2),
      firstRunMs: +runs[0].ms.toFixed(1),
      steadyStateMs: stat(runs.slice(1).map(r => r.ms)),
      msPerMegapixel: +(stat(runs.slice(1).map(r => r.ms)).median / ((dims.w * dims.h) / 1e6)).toFixed(1)
    };
  }
  await b.close();
  return res;
}

async function memory(build) {
  const b = await launch();
  const p = await (await b.newContext()).newPage();
  await p.goto('file://' + path.join(OUT, `h_${build}.html`), { waitUntil: 'load' });
  await p.waitForFunction('window.__ready === true');
  const before = await p.evaluate('window.__probe.buildInfo()');
  const runs = await p.evaluate(([bts, n]) => window.__probe.decodeRepeat(bts, n), [bytesOf('photo_12mp.heic'), 12]);
  await b.close();
  return {
    jsHeapAfterInitMB: +(before.heapBytes / 1e6).toFixed(1),
    wasmHeapAfterInitMB: +(before.wasmHeapBytes / 1e6).toFixed(1),
    perRun: runs.map(r => ({ i: r.i, ms: +r.ms.toFixed(0),
      jsHeapMB: r.heap ? +(r.heap / 1e6).toFixed(1) : null,
      wasmHeapMB: r.wasmHeap ? +(r.wasmHeap / 1e6).toFixed(1) : null })),
    wasmHeapGrowthMB: +((runs[runs.length - 1].wasmHeap - before.wasmHeapBytes) / 1e6).toFixed(1),
    note: 'performance.memory is bucketed to ~5MB in Chromium; wasm HEAPU8 length is exact.'
  };
}

// ---- parallel workers + full ingest step -----------------------------------
const PARALLEL_HTML = (absUrl) => `<!doctype html><meta charset=utf-8><script>
const SRC=${JSON.stringify(absUrl)};
const CODE = \`
  importScripts(\${JSON.stringify(SRC)});
  const lib = libheif();
  self.onmessage = async (e) => {
    const { bytes, reps, sidecar } = e.data;
    const out = [];
    for (let k = 0; k < reps; k++) {
      const t0 = performance.now();
      const d = new lib.HeifDecoder();
      const img = d.decode(new Uint8Array(bytes))[0];
      const w = img.get_width(), h = img.get_height();
      const buf = new Uint8ClampedArray(w*h*4);
      await new Promise((res, rej) => img.display({data:buf,width:w,height:h}, r => r?res(r):rej(new Error('fail'))));
      const tDec = performance.now();
      let sidecarMs = null, thumbMs = null, previewMs = null, sidecarBytes = null;
      if (sidecar) {
        const oc = new OffscreenCanvas(w, h);
        oc.getContext('2d').putImageData(new ImageData(buf, w, h), 0, 0);
        const bmp = oc.transferToImageBitmap();
        const t1 = performance.now();
        // 1600px matchup preview (PRD 7.9)
        const s1 = 1600 / Math.max(w, h);
        const pc = new OffscreenCanvas(Math.round(w*s1), Math.round(h*s1));
        pc.getContext('2d').drawImage(bmp, 0, 0, pc.width, pc.height);
        const pblob = await pc.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        const t2 = performance.now(); previewMs = t2 - t1;
        // 320px grid thumbnail (PRD 7.9)
        const s2 = 320 / Math.max(w, h);
        const tc = new OffscreenCanvas(Math.round(w*s2), Math.round(h*s2));
        tc.getContext('2d').drawImage(bmp, 0, 0, tc.width, tc.height);
        const tblob = await tc.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
        const t3 = performance.now(); thumbMs = t3 - t2;
        // full-size JPEG sidecar (PRD section 8)
        const sc = new OffscreenCanvas(w, h);
        sc.getContext('2d').drawImage(bmp, 0, 0);
        const sblob = await sc.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
        sidecarMs = performance.now() - t3; sidecarBytes = sblob.size;
        bmp.close();
      }
      if (img.free) img.free();
      out.push({ decodeMs: tDec - t0, previewMs, thumbMs, sidecarMs, sidecarBytes,
                 totalMs: performance.now() - t0 });
    }
    self.postMessage(out);
  };
\`;
window.runParallel = function (n, bytes, reps, sidecar) {
  const t0 = performance.now();
  const ws = [];
  const ps = [];
  for (let i = 0; i < n; i++) {
    const w = new Worker(URL.createObjectURL(new Blob([CODE], {type:'text/javascript'})));
    ws.push(w);
    ps.push(new Promise((res, rej) => {
      w.onmessage = e => res(e.data);
      w.onerror = e => rej(new Error('worker: ' + (e.message || 'blocked')));
    }));
    w.postMessage({ bytes: bytes.slice(), reps, sidecar });
  }
  return Promise.all(ps).then(all => {
    const wall = performance.now() - t0;
    ws.forEach(w => w.terminate());
    const flat = all.flat();
    return { workers: n, reps, images: flat.length, wallMs: wall,
             msPerImageWall: wall / flat.length,
             perImage: flat };
  });
};
window.__ready = true;
</script><body>parallel bench`;

async function parallel() {
  const abs = 'file://' + path.resolve(ROOT, '../../../node_modules/libheif-js/libheif-wasm/libheif-bundle.js');
  const p2 = path.join(OUT, 'bench_parallel.html');
  fs.writeFileSync(p2, PARALLEL_HTML(abs));
  const b = await launch();
  const p = await (await b.newContext()).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e.message)));
  await p.goto('file://' + p2, { waitUntil: 'load' });
  await p.waitForFunction('window.__ready === true');
  const bytes = bytesOf('photo_12mp.heic');
  const out = { hostCpus: require('os').cpus().length, errs };
  for (const n of [1, 2, 4, 8]) {
    const r = await p.evaluate(([n2, b2]) => window.runParallel(n2, b2, 3, false), [n, bytes]);
    out['decodeOnly_' + n + 'w'] = {
      workers: n, images: r.images, wallMs: +r.wallMs.toFixed(0),
      msPerImageWall: +r.msPerImageWall.toFixed(0),
      throughputImgPerSec: +(1000 / r.msPerImageWall).toFixed(2)
    };
  }
  // full ingest step (decode + 1600px preview + 320px thumb + full JPEG sidecar)
  for (const n of [1, 4]) {
    const r = await p.evaluate(([n2, b2]) => window.runParallel(n2, b2, 3, true), [n, bytes]);
    const med = k => stat(r.perImage.map(x => x[k]).filter(v => v != null));
    out['fullIngest_' + n + 'w'] = {
      workers: n, images: r.images, wallMs: +r.wallMs.toFixed(0),
      msPerImageWall: +r.msPerImageWall.toFixed(0),
      decodeMs: med('decodeMs'), previewMs: med('previewMs'),
      thumbMs: med('thumbMs'), sidecarMs: med('sidecarMs'),
      sidecarBytes: r.perImage[0].sidecarBytes
    };
  }
  await b.close();
  return out;
}

(async () => {
  const report = { probe: '02_heic/bench', host: { cpus: require('os').cpus().length,
    model: require('os').cpus()[0].model, totalMemGB: +(require('os').totalmem() / 1e9).toFixed(1) },
    iters: ITERS, coldTrials: COLD_TRIALS, fixtures: {} };
  for (const f of FIXTURES) {
    const s = fs.statSync(path.join(FIX, f));
    report.fixtures[f] = { bytes: s.size };
  }
  for (const build of ['wasm', 'asm']) {
    process.stderr.write(`cold init ${build}...\n`);
    report[build] = { coldInit: await coldInit(build) };
    process.stderr.write(`warm decode ${build}...\n`);
    report[build].warmDecode = await warmDecode(build);
    process.stderr.write(`memory ${build}...\n`);
    report[build].memory = await memory(build);
  }
  process.stderr.write('parallel...\n');
  report.parallel = await parallel();

  // ---- 500-photo projection (PRD section 3) ------------------------------
  const d1 = report.wasm.warmDecode['photo_12mp.heic'].steadyStateMs.median;
  const p1 = report.parallel.decodeOnly_1w.msPerImageWall;
  const p4 = report.parallel.decodeOnly_4w.msPerImageWall;
  const f1 = report.parallel.fullIngest_1w.msPerImageWall;
  const f4 = report.parallel.fullIngest_4w.msPerImageWall;
  const a1 = report.asm.warmDecode['photo_12mp.heic'].steadyStateMs.median;
  report.projection500 = {
    basis: '11.94MP genuine HEIC, measured not extrapolated',
    wasm_mainThread_decodeOnly_sec: +(500 * d1 / 1000).toFixed(0),
    asm_mainThread_decodeOnly_sec: +(500 * a1 / 1000).toFixed(0),
    wasm_1worker_decodeOnly_sec: +(500 * p1 / 1000).toFixed(0),
    wasm_4workers_decodeOnly_sec: +(500 * p4 / 1000).toFixed(0),
    wasm_1worker_fullIngest_sec: +(500 * f1 / 1000).toFixed(0),
    wasm_4workers_fullIngest_sec: +(500 * f4 / 1000).toFixed(0),
    note: 'fullIngest = HEIC decode + 1600px preview JPEG + 320px thumb JPEG + full-size JPEG sidecar, all in-worker via OffscreenCanvas. Excludes perceptual hash, IndexedDB writes and disk writes.'
  };

  fs.writeFileSync(path.join(OUT, 'bench.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error('FATAL', e); process.exit(2); });
