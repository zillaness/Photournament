// Phase 3: disambiguate File System Access picker outcomes.
//
//  (a) HEADED Chromium under Xvfb — a real GTK dialog can actually open, so a
//      *pending* promise proves the picker was permitted on that origin.
//  (b) A genuinely blocked origin (cross-origin iframe, no permissions-policy
//      grant) — establishes what "blocked" looks like, so AbortError elsewhere
//      cannot be misread as a block.
//
//   xvfb-run -a node run-picker-controls.mjs
//
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_('/opt/node22/lib/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8102;
const FILE_URL = 'file://' + path.join(HERE, 'probe.html');
const HTTP_URL = `http://localhost:${PORT}/probe.html`;

function startServer() {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(HERE, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    p.stdout.on('data', (d) => { if (!done && String(d).includes('SERVER_READY')) { done = true; res(p); } });
    setTimeout(() => { if (!done) rej(new Error('server timeout')); }, 8000);
  });
}

async function headedPicker(label, url, args, headless) {
  const rec = { label, url, args, headless, display: process.env.DISPLAY || '(none)' };
  let browser;
  try {
    browser = await chromium.launch({ headless, args, channel: 'chromium' });
  } catch (e) { rec.launchError = `${e.name}: ${e.message}`; return rec; }
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__DONE__ === true', null, { timeout: 90000 }).catch(() => {});
    await page.click('#pickerDir');
    // sample the promise state after 1.5s (dialog would still be open) and after 5s
    await page.waitForTimeout(1500);
    rec.at1500ms = await page.evaluate(() => JSON.parse(JSON.stringify(window.__pickerResult)));
    await page.waitForTimeout(4000);
    rec.at5500ms = await page.evaluate(() => JSON.parse(JSON.stringify(window.__pickerResult)));
    await browser.close();
    return rec;
  } catch (e) {
    rec.error = `${e.name}: ${e.message}`;
    await browser.close().catch(() => {});
    return rec;
  }
}

// A truly blocked origin: cross-origin iframe (127.0.0.1 inside localhost page)
// with no allow="file-system-access" permissions-policy delegation.
async function blockedOriginControl() {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/probe.html`, { waitUntil: 'load' });
  const out = await page.evaluate(async (port) => {
    const f = document.createElement('iframe');
    f.src = `http://127.0.0.1:${port}/probe.html`;   // different origin, no allow=
    document.body.appendChild(f);
    await new Promise((r) => f.addEventListener('load', r, { once: true }));
    return new Promise((res) => {
      window.addEventListener('message', (e) => { if (e.data && e.data.__x) res(e.data.__x); }, { once: true });
      f.contentWindow.postMessage('unused', '*');
      // inject via a same-file trick is impossible cross-origin; instead ask the
      // iframe's own probe page (which is the same probe.html) to report its picker result
      setTimeout(() => res('TIMEOUT — cross-origin iframe cannot be scripted from parent (expected)'), 4000);
    });
  }, PORT);
  // Drive the iframe directly through its own frame handle instead.
  const frame = page.frames().find((fr) => fr.url().includes('127.0.0.1'));
  let framePicker = 'frame not found';
  if (frame) {
    await frame.evaluate(() => {
      window.__x = null;
      const b = document.getElementById('pickerDir');
      b && b.click();
    }).catch(() => {});
    await page.waitForTimeout(3000);
    framePicker = await frame.evaluate(() => JSON.parse(JSON.stringify(window.__pickerResult || {}))).catch((e) => String(e));
    var frameCtx = await frame.evaluate(() => ({
      origin: String(self.origin), secure: self.isSecureContext,
      hasPicker: 'showDirectoryPicker' in self
    })).catch((e) => String(e));
  }
  await browser.close();
  return { parentAttempt: out, crossOriginIframeContext: typeof frameCtx !== 'undefined' ? frameCtx : null, crossOriginIframePicker: framePicker };
}

const server = await startServer();
const out = { generatedAt: new Date().toISOString(), display: process.env.DISPLAY || '(none)', runs: [] };
try {
  out.runs.push(await headedPicker('HEADED_file', FILE_URL, [], false));
  out.runs.push(await headedPicker('HEADED_http_localhost', HTTP_URL, [], false));
  out.runs.push(await headedPicker('HEADLESS_file_for_comparison', FILE_URL, [], true));
  out.blockedOriginControl = await blockedOriginControl();
} finally {
  server.kill('SIGTERM');
}
fs.writeFileSync(path.join(HERE, 'raw-picker-controls.json'), JSON.stringify(out, null, 2));
console.error(JSON.stringify(out, null, 2));
