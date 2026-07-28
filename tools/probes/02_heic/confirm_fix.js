/**
 * Probe 02_heic — confirm the leak fix holds at PRD volume.
 *
 * Variant D from mem_fix.js (ONE shared HeifDecoder + image.free() on every
 * returned HeifImage) run for 200 sequential 11.94MP decodes in one worker,
 * with a pixel checksum on the first and last decode to prove correctness did
 * not regress.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const N = +(process.argv[2] || 200);
const ABS = 'file://' + path.resolve(ROOT, '../../../node_modules/libheif-js/libheif-wasm/libheif-bundle.js');

const HTML = `<!doctype html><meta charset=utf-8><script>
const CODE = \`
  importScripts(${JSON.stringify(ABS)});
  const lib = libheif();
  self.postMessage({ type: 'ready' });
  self.onmessage = async (e) => {
    const { bytes, n } = e.data;
    const u8 = new Uint8Array(bytes);
    const decoder = new lib.HeifDecoder();      // ONE instance, reused
    const curve = [];
    let firstSum = null, lastSum = null;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const imgs = decoder.decode(u8);
      const img = imgs[0];
      const w = img.get_width(), h = img.get_height();
      const buf = new Uint8ClampedArray(w*h*4);
      await new Promise((res, rej) => img.display({data:buf,width:w,height:h}, r => r?res(r):rej(new Error('fail'))));
      if (i === 0 || i === n - 1) {
        let s = 0; for (let k = 0; k < buf.length; k += 997*4) s += buf[k]+buf[k+1]+buf[k+2];
        if (i === 0) firstSum = s; else lastSum = s;
      }
      for (const im of imgs) if (im.free) im.free();   // release EVERY handle
      curve.push({ i, ms: +(performance.now()-t0).toFixed(0), heapMB: +(lib.HEAPU8.length/1e6).toFixed(1) });
      if (i % 25 === 0) self.postMessage({ type: 'p', i, heapMB: +(lib.HEAPU8.length/1e6).toFixed(1) });
    }
    self.postMessage({ type: 'done', curve, firstSum, lastSum });
  };
\`;
window.run = (bytes, n) => new Promise((resolve, reject) => {
  const w = new Worker(URL.createObjectURL(new Blob([CODE], {type:'text/javascript'})));
  const prog = [];
  w.onerror = e => reject(new Error('worker error: ' + (e.message || 'blocked')));
  w.onmessage = e => {
    if (e.data.type === 'ready') { w.postMessage({ bytes: bytes.slice(), n }); return; }
    if (e.data.type === 'p') { prog.push(e.data); return; }
    w.terminate(); resolve({ ...e.data, prog });
  };
});
window.__ready = true;
</script><body>confirm`;

(async () => {
  const p1 = path.join(OUT, 'confirm.html');
  fs.writeFileSync(p1, HTML);
  const b = await chromium.launch({ args: ['--no-proxy-server'] });
  const page = await (await b.newContext()).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message)));
  await page.goto('file://' + p1, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true');
  const bytes = Array.from(fs.readFileSync(path.join(ROOT, 'fixtures/photo_12mp.heic')));
  const r = await page.evaluate(([b2, n]) => window.run(b2, n), [bytes, N]);
  const h = r.curve.map(c => c.heapMB), ms = r.curve.map(c => c.ms).sort((a, c) => a - c);
  const report = {
    probe: '02_heic/confirm_fix',
    pattern: 'ONE shared HeifDecoder reused for every image + image.free() on every returned HeifImage',
    decodes: r.curve.length,
    heapStartMB: h[0], heapEndMB: h[h.length - 1], heapMaxMB: Math.max(...h),
    heapGrowthMB: +(h[h.length - 1] - h[0]).toFixed(1),
    heapCheckpoints: r.prog,
    decodeMs: { min: ms[0], median: ms[Math.floor(ms.length / 2)], p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1] },
    pixelChecksumFirstDecode: r.firstSum,
    pixelChecksumLastDecode: r.lastSum,
    checksumsMatch: r.firstSum === r.lastSum,
    pageErrors: errs,
    projectedHeapAt500MB: +(h[0] + (h[h.length - 1] - h[0]) / (r.curve.length - 1) * 500).toFixed(0)
  };
  fs.writeFileSync(path.join(OUT, 'confirm_fix.json'), JSON.stringify({ ...report, curve: r.curve }, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await b.close();
})().catch(e => { console.error('FATAL', e); process.exit(2); });
