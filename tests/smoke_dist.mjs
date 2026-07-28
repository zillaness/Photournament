/**
 * file: smoke_dist.mjs
 * version: 1.3
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Boots the built single-file artifact in real Chromium from a file:// URL and asserts it works exactly as the user will experience it.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * smoke_load.mjs tests the src/ modules. This tests the thing that ships. They
 * can diverge — the build inlines, escapes and reorders — and only this one
 * catches that.
 *
 * Run: node tests/smoke_dist.mjs [path/to/artifact.html]
 */

import { chromium } from 'playwright';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'dist', 'photournament_v1.0.html');

if (!existsSync(target)) {
  console.error('missing ' + target + ' — run: node tools/build.mjs');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
const requests = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('request', (r) => requests.push(r.url()));

const t0 = Date.now();
await page.goto('file://' + target);
await page.waitForTimeout(400);
const bootMs = Date.now() - t0;

const r = await page.evaluate(async () => {
  const PT = window.PT || {};
  const heicEl = document.getElementById('libheif-src');
  const out = {
    origin: location.protocol,
    version: PT.VERSION,
    modules: ['log', 'bus', 'store', 'db', 'router', 'dom', 'tree', 'phash', 'ingest'].filter((k) => PT[k]),
    screenHost: !!document.getElementById('screen'),
    // The HEIC payload must be present but NOT executed: a mostly-JPEG set
    // should never pay for it.
    heicPayloadBytes: heicEl ? heicEl.textContent.length : 0,
    heicNotExecuted: typeof window.libheif === 'undefined',
    // Colour-space agnostic: the stylesheet may express colours as rgb, oklch or
    // anything else, so assert that a design token resolved and that the page is
    // actually painted rather than matching one literal value.
    bgToken: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    // No stray build tokens survived into the artifact.
    tokensLeft: (document.documentElement.innerHTML.match(/BUILD:(CSS|JS|LIBHEIF|PHASH)/g) || []).length,
    // The favicon must be a data: URI. A sibling asset path would 404 on a
    // file:// origin and silently lose the identity in the shipped file.
    iconIsDataUri: (function () {
      var l = document.querySelector('link[rel="icon"]');
      return !!l && /^data:image\/svg\+xml/.test(l.getAttribute('href'));
    })(),
    themeColor: (document.querySelector('meta[name="theme-color"]') || {}).content || null,
    // Resolve --bg by painting: oklch read back from fillStyle stays oklch, and
    // meta[theme-color] does not accept it.
    bgHex: (function () {
      var c = document.createElement('canvas'); c.width = c.height = 1;
      var x = c.getContext('2d');
      x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      x.fillRect(0, 0, 1, 1);
      var d = x.getImageData(0, 0, 1, 1).data;
      return '#' + [d[0], d[1], d[2]].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
    })(),
    themeDefault: document.documentElement.dataset.theme || 'dark',
    hasThemeToggle: !!document.getElementById("topbar-theme"),
    // The mark is a <use> of a sprite symbol; an unresolved reference lays out
    // as a zero-sized box, so measuring it proves the reference actually bound.
    brandMark: (function () {
      // Two marks exist now — the topbar one is first in the DOM and hidden on
      // the entry screen, so measuring it would always read 0.
      var m = document.querySelector('.pt-lockup .pt-brandmark');
      if (!m) return false;
      var b = m.getBoundingClientRect();
      return b.width > 8 && b.height > 8 && !!document.getElementById('ptm-mark');
    })()
  };

  // The real end-to-end capability: spin a worker from the inlined source and
  // round-trip a message. This is the mechanism the whole ingest path rests on.
  out.workerFromInlineSrc = await new Promise((res) => {
    try {
      const src = PT.ingest && PT.ingest.WORKER_SRC;
      if (!src) return res('no WORKER_SRC');
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      const to = setTimeout(() => { w.terminate(); res('timeout'); }, 5000);
      w.onerror = (e) => { clearTimeout(to); res('error: ' + (e.message || 'unknown')); };
      w.onmessage = () => { clearTimeout(to); w.terminate(); res('alive'); };
      w.postMessage({ type: 'ping' });
    } catch (e) { res('threw: ' + e.message); }
  });

  return out;
});

await browser.close();

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

console.log('artifact: ' + path.relative(ROOT, target) + '  ' + (statSync(target).size / 1048576).toFixed(2) + ' MB');
console.log('boot: ' + bootMs + ' ms\n');

check('loads from file:// origin', r.origin === 'file:', r.origin);
check('PT.VERSION present', !!r.version, r.version);
check('all modules registered', r.modules.length === 9, r.modules.join(','));
check('screen host exists', r.screenHost);
check('design tokens resolved', r.bgToken.length > 0, r.bgToken || '(none)');
check('page background is painted', r.bodyBg && r.bodyBg !== 'rgba(0, 0, 0, 0)', r.bodyBg);
check('no build tokens left in output', r.tokensLeft === 0, r.tokensLeft);
check('favicon is embedded as a data URI', r.iconIsDataUri === true, r.iconIsDataUri);
// Must match the stylesheet's --bg, not the identity package's own background —
// otherwise the browser chrome is a different colour from the page under it.
check('theme colour matches the page background', r.themeColor === r.bgHex,
  r.themeColor + ' vs --bg ' + r.bgHex);
check('the recursive brand mark renders', r.brandMark === true, r.brandMark);
check('dark is the default theme', r.themeDefault === 'dark', r.themeDefault);
check('the theme control exists', r.hasThemeToggle === true, r.hasThemeToggle);
check('libheif payload embedded', r.heicPayloadBytes > 1000000, (r.heicPayloadBytes / 1048576).toFixed(2) + ' MB');
check('libheif NOT executed at boot', r.heicNotExecuted === true, r.heicNotExecuted);
check('worker spawns from inlined source', r.workerFromInlineSrc === 'alive', r.workerFromInlineSrc);

// The artifact must fetch nothing but itself. blob: URLs are excluded because
// they are locally constructed, not loaded — spawning a worker from inlined
// source necessarily creates one, and that is the mechanism working, not a leak.
const loaded = requests.filter((u) => !u.startsWith('blob:') && !u.startsWith('data:'));
const external = loaded.filter((u) => !u.startsWith('file://'));
check('zero external requests', external.length === 0, external.join(', ') || '0');
check('no sibling assets fetched', loaded.length === 1, loaded.length + ' file:// request(s)');
check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

console.log(failed === 0 ? '\nARTIFACT OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Boots the dist artifact from file://,
 *   asserts self-containment, deferred libheif, and a live worker.
  * v1.1 (2026-07-28): Colour-space agnostic background check, and guards for the
 *   embedded favicon and theme colour. data: URIs are excluded from the
 *   self-containment count because they are inline, not loaded.
 * v1.2 (2026-07-28): Theme colour asserted against the stylesheet's own --bg
 *   rather than a literal from the identity package, and the brand mark measured
 *   so an unresolved sprite reference cannot pass as rendered.
 * v1.3 (2026-07-28): Chrome colour asserted against the resolved --bg rather
 *   than a literal, plus the theme default and control.
*/
