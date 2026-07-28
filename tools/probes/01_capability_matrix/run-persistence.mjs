// Phase 2: does IndexedDB data written from a file:// page survive
//   (a) a page reload,
//   (b) a full browser restart on the same Chrome profile?
// Plus control experiments that disambiguate File System Access picker failure modes.
//
//   node run-persistence.mjs
//
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_('/opt/node22/lib/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8101;
const FILE_URL = 'file://' + path.join(HERE, 'persist.html');
const HTTP_URL = `http://localhost:${PORT}/persist.html`;
const MB = 40; // payload size written into IndexedDB

function startServer() {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(HERE, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    p.stdout.on('data', (d) => { if (!done && String(d).includes('SERVER_READY')) { done = true; res(p); } });
    p.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    setTimeout(() => { if (!done) rej(new Error('server timeout')); }, 8000);
  });
}

async function visit(profileDir, url, args, fn) {
  const ctx = await chromium.launchPersistentContext(profileDir, { headless: true, args, channel: 'chromium' });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.name}: ${e.message}`));
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 15000 });
  let out;
  try { out = await fn(page); } finally { await ctx.close(); }
  return { out, logs };
}

function du(dir) {
  let total = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}

function findIdbDirs(profileDir) {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (/IndexedDB/i.test(e.name)) {
        let kids = [];
        try { kids = fs.readdirSync(p); } catch {}
        hits.push({ path: p.replace(profileDir, '<profile>'), entries: kids, bytes: du(p) });
      } else walk(p, depth + 1);
    }
  };
  walk(profileDir, 0);
  return hits;
}

async function scenario(label, url, args) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-profile-'));
  const rec = { label, url, args, profile };
  try {
    // --- run 1: write ---
    const w = await visit(profile, url, args, (p) => p.evaluate((mb) => window.writeState(mb), MB));
    rec.write = w.out;
    rec.writeLogs = w.logs;

    // --- run 1b: reload within the SAME browser session ---
    const r1 = await visit(profile, url, args, async (p) => {
      const first = await p.evaluate(() => window.readState());
      await p.reload({ waitUntil: 'load' });
      await p.waitForFunction('window.__READY__ === true');
      const second = await p.evaluate(() => window.readState());
      return { afterFreshLaunch: first, afterReload: second };
    });
    rec.readAfterRestart = r1.out.afterFreshLaunch;   // this launch IS a browser restart
    rec.readAfterReload = r1.out.afterReload;
    rec.readLogs = r1.logs;

    rec.idbOnDisk = findIdbDirs(profile);
    rec.profileBytes = du(profile);

    // --- picker control experiments ---
    const c = await visit(profile, url, args, async (p) => {
      const noGesture = await p.evaluate(() => window.pickerNoGesture());
      const iframe = await p.evaluate(() => window.pickerInSandboxedIframe());
      return { noGesture, iframe };
    });
    rec.pickerControls = c.out;
  } catch (e) {
    rec.error = `${e.name}: ${e.message}`;
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  return rec;
}

const server = await startServer();
const out = { generatedAt: new Date().toISOString(), payloadMB: MB, scenarios: [] };
try {
  for (const s of [
    { label: 'file_default', url: FILE_URL, args: [] },
    { label: 'http_localhost', url: HTTP_URL, args: [] },
    { label: 'file_allowFileAccess', url: FILE_URL, args: ['--allow-file-access-from-files'] }
  ]) {
    process.stderr.write(`\n=== ${s.label} ===\n`);
    const r = await scenario(s.label, s.url, s.args);
    out.scenarios.push(r);
    process.stderr.write(`  write=${JSON.stringify(r.write)}\n  restartRead.marker=${JSON.stringify(r.readAfterRestart && r.readAfterRestart.marker)}\n`);
  }
} finally {
  server.kill('SIGTERM');
}
fs.writeFileSync(path.join(HERE, 'raw-persistence.json'), JSON.stringify(out, null, 2));
process.stderr.write('\nWROTE raw-persistence.json\n');
