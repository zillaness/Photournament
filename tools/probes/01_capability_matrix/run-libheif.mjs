// Phase 4: which of the three libheif-js builds can actually initialise under
// file:// with no flags? This is the concrete consequence of the fetch/module
// results for PRD §8 (HEIC WASM decode).
//
//   node run-libheif.mjs
//
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_('/opt/node22/lib/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8103;
const FILE_URL = 'file://' + path.join(HERE, 'heic.html');
const HTTP_URL = `http://localhost:${PORT}/heic.html`;

function startServer() {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(HERE, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    p.stdout.on('data', (d) => { if (!done && String(d).includes('SERVER_READY')) { done = true; res(p); } });
    setTimeout(() => { if (!done) rej(new Error('server timeout')); }, 8000);
  });
}

async function one(label, url, which, args = []) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args });
  const rec = { label, which, console: [] };
  try {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') rec.console.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => rec.console.push('[pageerror] ' + e.message.slice(0, 300)));
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__DONE__ === true', null, { timeout: 60000 }).catch((e) => { rec.wait = e.message; });
    const t0 = Date.now();
    rec.result = await page.evaluate((w) => {
      if (w === 'asm') return window.testAsm();
      if (w === 'bundle') return window.testBundle();
      return window.testSplit();
    }, which);
    rec.ms = Date.now() - t0;
  } catch (e) { rec.error = `${e.name}: ${e.message}`; }
  await browser.close().catch(() => {});
  return rec;
}

const server = await startServer();
const out = { generatedAt: new Date().toISOString(), runs: [] };
try {
  for (const which of ['asm', 'bundle', 'split']) {
    out.runs.push(await one(`file_default/${which}`, FILE_URL, which, []));
    out.runs.push(await one(`http_localhost/${which}`, HTTP_URL, which, []));
  }
} finally { server.kill('SIGTERM'); }
fs.writeFileSync(path.join(HERE, 'raw-libheif.json'), JSON.stringify(out, null, 2));
console.error(JSON.stringify(out, null, 2).slice(0, 12000));
