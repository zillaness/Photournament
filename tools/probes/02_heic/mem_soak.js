/**
 * Probe 02_heic — memory soak + error handling.
 *
 * The 12-decode bench showed the emscripten heap climbing 17MB -> 149MB.
 * Emscripten heaps only ever GROW (ALLOW_MEMORY_GROWTH); they are never
 * returned to the OS. The question that decides the ingest architecture is
 * whether that growth PLATEAUS (fragmentation settling) or is UNBOUNDED (leak).
 * 500 photos is the PRD's stated volume, so this runs 60 sequential decodes of
 * the 12MP fixture in one worker and reports the heap curve.
 *
 * Also checks: what happens when a non-HEIC file is handed to the decoder
 * (PRD 7.9 "flag unsupported files at load rather than dropping them silently").
 *
 * usage: node mem_soak.js [N]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const N = +(process.argv[2] || 60);
const ABS = 'file://' + path.resolve(ROOT, '../../../node_modules/libheif-js/libheif-wasm/libheif-bundle.js');

const HTML = `<!doctype html><meta charset=utf-8><script>
const CODE = \`
  importScripts(${JSON.stringify(ABS)});
  const lib = libheif();
  self.postMessage({ type: 'ready', wasmHeap: lib.HEAPU8.length });
  self.onmessage = async (e) => {
    const { bytes, n, freeImages } = e.data;
    const curve = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const d = new lib.HeifDecoder();
      const imgs = d.decode(new Uint8Array(bytes));
      const img = imgs[0];
      const w = img.get_width(), h = img.get_height();
      const buf = new Uint8ClampedArray(w*h*4);
      await new Promise((res, rej) => img.display({data:buf,width:w,height:h}, r => r?res(r):rej(new Error('fail'))));
      if (freeImages) { for (const im of imgs) { if (im.free) im.free(); } }
      curve.push({ i, ms: +(performance.now()-t0).toFixed(0), wasmHeapMB: +(lib.HEAPU8.length/1e6).toFixed(1) });
      if (i % 10 === 0) self.postMessage({ type: 'progress', i, wasmHeapMB: +(lib.HEAPU8.length/1e6).toFixed(1) });
    }
    self.postMessage({ type: 'done', curve });
  };
\`;
window.soak = (bytes, n, freeImages) => new Promise((resolve, reject) => {
  const w = new Worker(URL.createObjectURL(new Blob([CODE], {type:'text/javascript'})));
  const prog = [];
  w.onerror = e => reject(new Error('worker error: ' + (e.message || 'blocked')));
  w.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') { w.postMessage({ bytes: bytes.slice(), n, freeImages }); return; }
    if (m.type === 'progress') { prog.push(m); return; }
    w.terminate();
    resolve({ curve: m.curve, progress: prog });
  };
});
// error-handling probe, main thread
window.badInput = (bytes, label) => {
  const out = { label };
  try {
    const d = new window.__lib.HeifDecoder();
    const imgs = d.decode(new Uint8Array(bytes));
    out.threw = false;
    out.imageCount = imgs.length;
    if (imgs.length) {
      try { out.dims = imgs[0].get_width() + 'x' + imgs[0].get_height(); }
      catch (e) { out.dimsThrew = String(e.message || e); }
    }
  } catch (e) { out.threw = true; out.error = String(e && e.message || e); }
  return out;
};
</script>
<script src="../../../../node_modules/libheif-js/libheif-wasm/libheif-bundle.js"></script>
<script>window.__lib = libheif(); window.__ready = true;</script>
<body>soak`;

(async () => {
  const p1 = path.join(OUT, 'soak.html');
  fs.writeFileSync(p1, HTML);
  const b = await chromium.launch({ args: ['--no-proxy-server'] });
  const page = await (await b.newContext()).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('file://' + p1, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true');

  const bytes = Array.from(fs.readFileSync(path.join(ROOT, 'fixtures/photo_12mp.heic')));

  const withFree = await page.evaluate(([b2, n]) => window.soak(b2, n, true), [bytes, N]);
  const withoutFree = await page.evaluate(([b2, n]) => window.soak(b2, n, false), [bytes, Math.min(N, 30)]);

  // ---- unsupported input handling ----------------------------------------
  const jpegBytes = Array.from(fs.readFileSync(path.join(OUT, 'sidecar_file_wasm_photo_12mp_heic.jpg')).subarray(0, 200000));
  const truncated = bytes.slice(0, 50000);
  const garbage = Array.from(Buffer.alloc(4096, 0x41));
  const badInputs = [];
  for (const [label, bts] of [['jpeg fed to HeifDecoder', jpegBytes],
                              ['truncated heic (first 50KB)', truncated],
                              ['4KB of 0x41', garbage],
                              ['empty buffer', []]]) {
    badInputs.push(await page.evaluate(([b2, l]) => window.badInput(b2, l), [bts, label]));
  }

  const curve = withFree.curve;
  const heap = curve.map(c => c.wasmHeapMB);
  const report = {
    probe: '02_heic/mem_soak',
    decodes: N,
    fixture: 'photo_12mp.heic (3992x2992, 11.94MP)',
    withImageFree: {
      startHeapMB: heap[0], endHeapMB: heap[heap.length - 1], maxHeapMB: Math.max(...heap),
      heapAtDecode: { 1: heap[0], 5: heap[4], 10: heap[9], 20: heap[19], 30: heap[29], 45: heap[44], 60: heap[59] },
      growthLast20MB: +(heap[heap.length - 1] - heap[Math.max(0, heap.length - 21)]).toFixed(1),
      msFirst: curve[0].ms,
      msLast10Median: (() => { const s = curve.slice(-10).map(c => c.ms).sort((a, c) => a - c); return s[5]; })(),
      curve
    },
    withoutImageFree: {
      decodes: withoutFree.curve.length,
      startHeapMB: withoutFree.curve[0].wasmHeapMB,
      endHeapMB: withoutFree.curve[withoutFree.curve.length - 1].wasmHeapMB,
      curve: withoutFree.curve
    },
    unsupportedInput: badInputs,
    pageErrors: errs
  };
  fs.writeFileSync(path.join(OUT, 'mem_soak.json'), JSON.stringify(report, null, 2));
  const { curve: _c, ...brief } = report.withImageFree;
  console.log(JSON.stringify({ ...report, withImageFree: brief,
    withoutImageFree: { ...report.withoutImageFree, curve: undefined } }, null, 2));
  await b.close();
})().catch(e => { console.error('FATAL', e); process.exit(2); });
