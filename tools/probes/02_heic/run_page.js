/**
 * Probe 02_heic — page-context decode under file:// and http://localhost.
 *
 * usage: node run_page.js <file|http> <wasm|asm> [--png] [--repeat N]
 *
 * Hard assertions:
 *   - ZERO network requests other than the harness html and the libheif script
 *     itself. Any request for *.wasm, or to any remote host, fails the probe.
 *   - page.route('**\/*') is installed BEFORE navigation and records everything
 *     Chromium's network stack sees, including file:// loads.
 *   - an in-page tripwire overrides fetch/XHR/WebSocket/EventSource and throws.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
const FIXTURES = path.join(ROOT, 'fixtures');

const mode = process.argv[2] || 'file';
const build = process.argv[3] || 'wasm';
const wantPng = process.argv.includes('--png');
const repeatIdx = process.argv.indexOf('--repeat');
const repeatN = repeatIdx > -1 ? parseInt(process.argv[repeatIdx + 1], 10) : 0;
const fixIdx = process.argv.indexOf('--fixture');
const fixture = fixIdx > -1 ? process.argv[fixIdx + 1] : 'photo_12mp.heic';
const httpPort = process.env.PROBE_PORT || '8099';

(async () => {
  require('./gen_harness.js');

  const pageUrl = mode === 'file'
    ? 'file://' + path.join(OUT, `h_${build}.html`)
    : `http://localhost:${httpPort}/tools/probes/02_heic/out/h_${build}.html`;

  const browser = await chromium.launch({
    args: ['--js-flags=--expose-gc', '--no-proxy-server']
  });
  const ctx = await browser.newContext();

  const requests = [];
  await ctx.route('**/*', (route, req) => {
    requests.push({ url: req.url(), method: req.method(), rt: req.resourceType() });
    route.continue();
  });
  const page = await ctx.newPage();
  page.on('request', r => requests.push({ url: r.url(), method: r.method(), rt: r.resourceType(), via: 'event' }));
  const consoleMsgs = [];
  page.on('console', m => consoleMsgs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => consoleMsgs.push('pageerror: ' + e.message));

  const tNav0 = Date.now();
  await page.goto(pageUrl, { waitUntil: 'load' });
  const navMs = Date.now() - tNav0;

  await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });
  const info = await page.evaluate('window.__probe.buildInfo()');

  const buf = fs.readFileSync(path.join(FIXTURES, fixture));
  // hand the bytes in the way the real app would: as an in-memory array, NOT a fetch
  const bytes = Array.from(buf);

  const res = await page.evaluate(
    ([b, o]) => window.__probe.decode(b, o),
    [bytes, { png: wantPng, jpeg: true }]
  );

  let repeat = null;
  if (repeatN > 0) {
    repeat = await page.evaluate(([b, n]) => window.__probe.decodeRepeat(b, n), [bytes, repeatN]);
  }

  // ---- network assertion -------------------------------------------------
  const uniq = [...new Set(requests.map(r => r.url))];
  const harnessUrl = pageUrl;
  const libheifTail = build === 'wasm' ? 'libheif-bundle.js' : 'libheif/libheif.js';
  const allowed = u =>
    u === harnessUrl ||
    u.endsWith(libheifTail) ||
    u.endsWith('/favicon.ico');
  const violations = uniq.filter(u => !allowed(u));
  const wasmReqs = uniq.filter(u => /\.wasm(\?|$)/.test(u));
  const remote = uniq.filter(u => !/^(file:|http:\/\/localhost)/.test(u));

  const report = {
    probe: '02_heic/run_page',
    mode, build, fixture, pageUrl,
    navMs,
    parseInitMs: info.parseInitMs,
    libheifGlobalType: info.globalType,
    hasDecoder: info.hasDecoder,
    scriptParseMs: info.scriptParseMs,
    factoryMs: info.factoryMs,
    wasmHeapBytesAfterInit: info.wasmHeapBytes,
    jsHeapAfterInit: info.heapBytes,
    decode: (() => { const { png, jpeg, ...rest } = res; return rest; })(),
    repeat,
    network: {
      allRequestUrls: uniq,
      requestCount: uniq.length,
      violations,
      wasmRequests: wasmReqs,
      remoteRequests: remote,
      inPageTripwireEvents: res.net
    },
    console: consoleMsgs,
    PASS_no_network: violations.length === 0 && wasmReqs.length === 0 &&
                     remote.length === 0 && res.net.length === 0
  };

  if (res.png) {
    const p = path.join(OUT, `decoded_${mode}_${build}_${fixture.replace(/\W/g, '_')}.png`);
    fs.writeFileSync(p, Buffer.from(res.png.split(',')[1], 'base64'));
    report.pngWritten = p;
    report.pngBytes = fs.statSync(p).size;
  }
  if (res.jpeg) {
    const p = path.join(OUT, `sidecar_${mode}_${build}_${fixture.replace(/\W/g, '_')}.jpg`);
    fs.writeFileSync(p, Buffer.from(res.jpeg.split(',')[1], 'base64'));
    report.jpegWritten = p;
    report.jpegBytes = fs.statSync(p).size;
  }

  fs.writeFileSync(
    path.join(OUT, `report_${mode}_${build}.json`),
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(report.PASS_no_network ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
