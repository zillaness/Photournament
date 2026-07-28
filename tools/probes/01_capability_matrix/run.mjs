// Photournament capability probe driver.
// Runs tools/probes/01_capability_matrix/probe.html in real Chromium under several
// (origin x flags x browser build) configurations and dumps raw JSON results.
//
//   export NODE_PATH=/opt/node22/lib/node_modules
//   node run.mjs
//
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// NODE_PATH only affects CommonJS resolution, so reach playwright through require().
const require_ = createRequire(import.meta.url);
const { chromium } = require_('/opt/node22/lib/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8099;
const FILE_URL = 'file://' + path.join(HERE, 'probe.html');
const HTTP_URL = `http://localhost:${PORT}/probe.html`;

function startServer() {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(HERE, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    p.stdout.on('data', (d) => {
      if (!done && String(d).includes('SERVER_READY')) { done = true; res(p); }
    });
    p.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    p.on('exit', (c) => { if (!done) rej(new Error('server exited ' + c)); });
    setTimeout(() => { if (!done) rej(new Error('server start timeout')); }, 8000);
  });
}

async function runOne({ name, url, args = [], channel }) {
  const record = { name, url, args, channel: channel || 'headless-shell (playwright default)', console: [], pageErrors: [] };
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args, ...(channel ? { channel } : {}) });
  } catch (e) {
    record.launchError = `${e.name}: ${e.message}`;
    return record;
  }
  try {
    record.browserVersion = browser.version();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('console', (m) => record.console.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => record.pageErrors.push(`${e.name}: ${e.message}`));

    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    try {
      await page.waitForFunction('window.__DONE__ === true', null, { timeout: 90000 });
    } catch (e) {
      record.waitError = `probe did not finish: ${e.message}`;
    }
    record.results = await page.evaluate(() => window.__RESULTS__ || null);

    // ---- File System Access pickers, inside a REAL trusted user gesture ----
    await page.click('#pickerDir').catch((e) => { record.clickDirError = String(e.message).slice(0, 200); });
    await page.waitForTimeout(4500);
    await page.click('#pickerFile').catch((e) => { record.clickFileError = String(e.message).slice(0, 200); });
    await page.waitForTimeout(4500);
    record.picker = await page.evaluate(() => window.__pickerResult || null);

    await ctx.close();
  } catch (e) {
    record.driverError = `${e.name}: ${e.message}`;
  } finally {
    await browser.close().catch(() => {});
  }
  return record;
}

const CONFIGS = [
  { name: 'file_default',            url: FILE_URL, args: [] },
  { name: 'http_default',            url: HTTP_URL, args: [] },
  { name: 'file_allowFileAccess',    url: FILE_URL, args: ['--allow-file-access-from-files'] },
  { name: 'file_allowFileAccess_plus', url: FILE_URL,
    args: ['--allow-file-access-from-files', '--allow-running-insecure-content', '--disable-web-security'] },
  { name: 'file_fullChromium',       url: FILE_URL, args: [], channel: 'chromium' },
  { name: 'http_fullChromium',       url: HTTP_URL, args: [], channel: 'chromium' },
  { name: 'file_fullChromium_allowFileAccess', url: FILE_URL, args: ['--allow-file-access-from-files'], channel: 'chromium' }
];

const server = await startServer();
const out = { generatedAt: new Date().toISOString(), node: process.version, runs: [] };
try {
  for (const c of CONFIGS) {
    process.stderr.write(`\n=== ${c.name} ===\n`);
    const r = await runOne(c);
    out.runs.push(r);
    process.stderr.write(`  done. results=${r.results ? Object.keys(r.results).length : 'NONE'} launchError=${r.launchError || '-'}\n`);
  }
} finally {
  server.kill('SIGTERM');
}
fs.writeFileSync(path.join(HERE, 'raw-results.json'), JSON.stringify(out, null, 2));
process.stderr.write('\nWROTE raw-results.json\n');
