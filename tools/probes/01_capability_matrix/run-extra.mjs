// Phase 5: how a worker can actually get a big library (libheif) loaded, and
// whether a[download] works, under file:// vs http://localhost.
//
//   node run-extra.mjs
//
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_('/opt/node22/lib/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8104;
const LIB = '../../../node_modules/libheif-js/libheif/libheif.js';
const FILE_URL = 'file://' + path.join(HERE, 'extra.html');
const HTTP_URL = `http://localhost:${PORT}/extra.html`;

function startServer() {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(HERE, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    p.stdout.on('data', (d) => { if (!done && String(d).includes('SERVER_READY')) { done = true; res(p); } });
    setTimeout(() => { if (!done) rej(new Error('server timeout')); }, 8000);
  });
}

async function one(label, url, args = []) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args });
  const rec = { label, args, downloads: [], console: [] };
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('download', async (d) => {
      const p = path.join(HERE, 'dl-' + label.replace(/\W/g, '_') + '.txt');
      try { await d.saveAs(p); rec.downloads.push({ suggested: d.suggestedFilename(), savedBytes: fs.statSync(p).size }); fs.unlinkSync(p); }
      catch (e) { rec.downloads.push({ suggested: d.suggestedFilename(), error: String(e.message).slice(0, 120) }); }
    });
    page.on('console', (m) => { if (m.type() === 'error') rec.console.push(m.text().slice(0, 220)); });
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 15000 });
    rec.result = await page.evaluate((lib) => window.runExtra(lib), LIB);
    await page.waitForTimeout(3000);   // let any download settle
    await ctx.close();
  } catch (e) { rec.error = `${e.name}: ${e.message}`; }
  await browser.close().catch(() => {});
  return rec;
}

const server = await startServer();
const out = { generatedAt: new Date().toISOString(), runs: [] };
try {
  out.runs.push(await one('file_default', FILE_URL, []));
  out.runs.push(await one('http_localhost', HTTP_URL, []));
  out.runs.push(await one('file_allowFileAccess', FILE_URL, ['--allow-file-access-from-files']));
} finally { server.kill('SIGTERM'); }
fs.writeFileSync(path.join(HERE, 'raw-extra.json'), JSON.stringify(out, null, 2));
console.error(JSON.stringify(out, null, 2));
