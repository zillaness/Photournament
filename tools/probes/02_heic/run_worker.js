/**
 * Probe 02_heic — Web Worker decode (PRD 7.9 requires worker-threaded ingest).
 *
 * usage: node run_worker.js <file|http> [--inline]
 *
 * Strategies exercised:
 *   A  blob-URL worker + importScripts(<absolute URL of libheif-bundle.js>)
 *   B  blob-URL worker + importScripts(<relative path>)   [expected to fail]
 *   C  classic worker from a sibling .js file             [file:// origin test]
 *   D  blob-URL worker with the whole bundle source inlined in the HTML
 *      (only when --inline; produces a ~1.5MB single-file harness)
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const mode = process.argv[2] || 'file';
const inline = process.argv.includes('--inline');
const port = process.env.PROBE_PORT || '8099';
fs.mkdirSync(OUT, { recursive: true });

// classic sibling worker for strategy C
fs.writeFileSync(path.join(OUT, 'worker_classic.js'), `
try {
  importScripts('../../../../node_modules/libheif-js/libheif-wasm/libheif-bundle.js');
  var lib = libheif();
  self.postMessage({ ok: true, hasDecoder: typeof lib.HeifDecoder === 'function' });
} catch (e) { self.postMessage({ ok: false, error: String(e && e.message || e) }); }
`);

let html = fs.readFileSync(path.join(ROOT, 'worker_probe.html'), 'utf8');
if (inline) {
  const src = fs.readFileSync(path.join(ROOT, '../../../node_modules/libheif-js/libheif-wasm/libheif-bundle.js'), 'utf8');
  if (/<\/script/i.test(src)) throw new Error('bundle contains </script — needs escaping');
  html = html.replace('<!-- INLINE_LIBHEIF -->',
    '<script id="libheif-src" type="text/plain">' + src + '</script>');
}
const htmlPath = path.join(OUT, inline ? 'w_inline.html' : 'w.html');
fs.writeFileSync(htmlPath, html);

(async () => {
  const url = mode === 'file'
    ? 'file://' + htmlPath
    : `http://localhost:${port}/tools/probes/02_heic/out/${path.basename(htmlPath)}`;

  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const ctx = await browser.newContext();
  const requests = [];
  await ctx.route('**/*', (r, req) => { requests.push(req.url()); r.continue(); });
  const page = await ctx.newPage();
  page.on('request', r => requests.push(r.url()));
  const logs = [];
  page.on('console', m => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => logs.push('pageerror: ' + e.message));
  page.on('worker', w => logs.push('worker created: ' + w.url().slice(0, 60)));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true');

  const bytes = Array.from(fs.readFileSync(path.join(ROOT, 'fixtures/photo_12mp.heic')));

  const report = { probe: '02_heic/run_worker', mode, inline, url, htmlBytes: fs.statSync(htmlPath).size };

  report.A_blobImportScriptsAbsolute =
    await page.evaluate(b => window.__runBlobImportScripts('wasm', b), bytes);
  report.B_blobImportScriptsRelative =
    await page.evaluate(() => window.__runBlobRelative('wasm'));
  report.C_classicSiblingFileWorker =
    await page.evaluate(() => window.__runClassicFileWorker());
  if (inline) {
    report.D_inlinedSourceBlobWorker =
      await page.evaluate(b => window.__runInlinedBlob(b), bytes);
  }

  const uniq = [...new Set(requests)];
  report.network = {
    allRequestUrls: uniq,
    wasmRequests: uniq.filter(u => /\.wasm(\?|$)/.test(u)),
    remoteRequests: uniq.filter(u => !/^(file:|http:\/\/localhost|blob:)/.test(u))
  };
  report.console = logs;

  fs.writeFileSync(path.join(OUT, `report_worker_${mode}${inline ? '_inline' : ''}.json`),
    JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(2); });
