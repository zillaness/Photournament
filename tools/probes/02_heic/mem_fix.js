/**
 * Probe 02_heic — isolate and fix the heap leak found by mem_soak.js.
 *
 * Root cause read out of the shipped wrapper in libheif-bundle.js:
 *
 *   HeifDecoder.prototype.decode = function (buf) {
 *     if (this.decoder) Module.heif_context_free(this.decoder);   // <-- only frees
 *     this.decoder = Module.heif_context_alloc();                 //     the PREVIOUS
 *     ...                                                          //     context
 *   };
 *
 * The heif_context is freed only by the NEXT decode() on the SAME HeifDecoder
 * instance. `new HeifDecoder()` per image therefore strands one full context
 * (file bytes + decoded planes) in the emscripten heap, forever. There is no
 * public destructor on the decoder.
 *
 * Variants measured, 60 x 11.94MP decodes each, one worker:
 *   A  new HeifDecoder() per image, no image.free()      (naive; what README implies)
 *   B  new HeifDecoder() per image, image.free()          (README + free)
 *   C  ONE shared HeifDecoder reused for every image      (proposed fix)
 *   D  shared HeifDecoder + image.free()                  (proposed fix, belt+braces)
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
  let shared = null;
  self.postMessage({ type: 'ready' });
  self.onmessage = async (e) => {
    const { bytes, n, share, free } = e.data;
    const curve = [];
    const u8 = new Uint8Array(bytes);
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      let d;
      if (share) { if (!shared) shared = new lib.HeifDecoder(); d = shared; }
      else d = new lib.HeifDecoder();
      const imgs = d.decode(u8);
      const img = imgs[0];
      const w = img.get_width(), h = img.get_height();
      const buf = new Uint8ClampedArray(w*h*4);
      await new Promise((res, rej) => img.display({data:buf,width:w,height:h}, r => r?res(r):rej(new Error('fail'))));
      if (free) for (const im of imgs) { if (im.free) im.free(); }
      curve.push({ i, ms: +(performance.now()-t0).toFixed(0), heapMB: +(lib.HEAPU8.length/1e6).toFixed(1) });
    }
    self.postMessage({ type: 'done', curve });
  };
\`;
window.run = (bytes, n, share, free) => new Promise((resolve, reject) => {
  const w = new Worker(URL.createObjectURL(new Blob([CODE], {type:'text/javascript'})));
  w.onerror = e => reject(new Error('worker error: ' + (e.message || 'blocked')));
  w.onmessage = e => {
    if (e.data.type === 'ready') { w.postMessage({ bytes: bytes.slice(), n, share, free }); return; }
    w.terminate(); resolve(e.data.curve);
  };
});
window.__ready = true;
</script><body>memfix`;

const summarize = (label, curve) => {
  const h = curve.map(c => c.heapMB), ms = curve.map(c => c.ms);
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    variant: label,
    decodes: curve.length,
    heapStartMB: h[0], heapEndMB: h[h.length - 1], heapMaxMB: Math.max(...h),
    heapAt: { 1: h[0], 10: h[9], 20: h[19], 40: h[39], 60: h[h.length - 1] },
    heapGrowthPerDecodeMB: +((h[h.length - 1] - h[0]) / (curve.length - 1)).toFixed(2),
    growthOverLast20MB: +(h[h.length - 1] - h[Math.max(0, h.length - 21)]).toFixed(1),
    medianDecodeMs: sorted[Math.floor(sorted.length / 2)],
    projected500HeapMB: +(h[0] + ((h[h.length - 1] - h[0]) / (curve.length - 1)) * 500).toFixed(0)
  };
};

(async () => {
  const p1 = path.join(OUT, 'memfix.html');
  fs.writeFileSync(p1, HTML);
  const b = await chromium.launch({ args: ['--no-proxy-server'] });
  const page = await (await b.newContext()).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message)));
  await page.goto('file://' + p1, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true');
  const bytes = Array.from(fs.readFileSync(path.join(ROOT, 'fixtures/photo_12mp.heic')));

  const variants = [
    ['A: new HeifDecoder per image, no free()', false, false],
    ['B: new HeifDecoder per image + image.free()', false, true],
    ['C: ONE shared HeifDecoder, no free()', true, false],
    ['D: ONE shared HeifDecoder + image.free()', true, true]
  ];
  const results = [];
  const curves = {};
  for (const [label, share, free] of variants) {
    process.stderr.write('running ' + label + '\n');
    const curve = await page.evaluate(([b2, n, s, f]) => window.run(b2, n, s, f), [bytes, N, share, free]);
    curves[label] = curve;
    results.push(summarize(label, curve));
  }
  const report = { probe: '02_heic/mem_fix', decodesPerVariant: N,
    fixture: 'photo_12mp.heic 3992x2992 (11.94MP)', results, pageErrors: errs, curves };
  fs.writeFileSync(path.join(OUT, 'mem_fix.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, curves: undefined }, null, 2));
  await b.close();
})().catch(e => { console.error('FATAL', e); process.exit(2); });
