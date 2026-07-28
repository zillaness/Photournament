// What breaks when the same harness is opened as a local file, which is the
// delivery model PRD section 8 commits to ("local HTML file, opened in a
// Chromium browser"). Runs the identical page under file:// and under
// http://localhost so every result has a control.

import { chromium, DIR, CORPUS, save } from './lib.mjs';
import { serve, waitPort } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 8134;
const WORKER_SRC = fs.readFileSync(path.join(DIR, 'pipeline_worker.js'), 'utf8');
const SUB = path.join(DIR, 'out', 'file_url_corpus');
fs.rmSync(SUB, { recursive: true, force: true });
fs.mkdirSync(SUB, { recursive: true });
const some = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name.endsWith('.jpg')) some.push(f);
  }
};
walk(CORPUS);
some.slice(0, 12).forEach((f) => fs.copyFileSync(f, path.join(SUB, path.basename(f))));

const srv = serve(PORT);
await waitPort(PORT);

const CHECKS = `async () => {
  const out = {};
  const t = async (name, fn) => {
    try { out[name] = { ok: true, value: await fn() }; }
    catch (e) { out[name] = { ok: false, error: (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)) }; }
  };

  out.origin = location.origin;
  out.protocol = location.protocol;
  out.isSecureContext = isSecureContext;
  out.crossOriginIsolated = crossOriginIsolated;
  out.hasPerformanceMemory = !!performance.memory;

  await t('classicWorkerFromUrl', () => new Promise((res, rej) => {
    let w;
    try { w = new Worker('pipeline_worker.js'); } catch (e) { return rej(e); }
    const to = setTimeout(() => { w.terminate(); rej(new Error('no reply in 3000ms')); }, 3000);
    w.onerror = (e) => { clearTimeout(to); w.terminate(); rej(new Error('worker onerror: ' + (e.message || 'blocked'))); };
    w.onmessage = (e) => { clearTimeout(to); w.terminate(); res('ready=' + (e.data && e.data.type)); };
    w.postMessage({ type: 'config', config: {} });
  }));

  await t('moduleWorkerFromUrl', () => new Promise((res, rej) => {
    let w;
    try { w = new Worker('pipeline_worker.js', { type: 'module' }); } catch (e) { return rej(e); }
    const to = setTimeout(() => { w.terminate(); rej(new Error('no reply in 3000ms')); }, 3000);
    w.onerror = (e) => { clearTimeout(to); w.terminate(); rej(new Error('worker onerror: ' + (e.message || 'blocked'))); };
    w.onmessage = (e) => { clearTimeout(to); w.terminate(); res('ready=' + (e.data && e.data.type)); };
    w.postMessage({ type: 'config', config: {} });
  }));

  await t('fetchOwnSource', async () => {
    const r = await fetch('pipeline_worker.js');
    return 'status=' + r.status + ' bytes=' + (await r.text()).length;
  });

  await t('blobUrlWorkerFromInlinedSource', () => new Promise((res, rej) => {
    const url = URL.createObjectURL(new Blob([window.__INLINE_WORKER__], { type: 'text/javascript' }));
    let w;
    try { w = new Worker(url); } catch (e) { return rej(e); }
    const to = setTimeout(() => { w.terminate(); rej(new Error('no reply in 3000ms')); }, 3000);
    w.onerror = (e) => { clearTimeout(to); w.terminate(); rej(new Error('worker onerror: ' + (e.message || 'blocked'))); };
    w.onmessage = (e) => { clearTimeout(to); w.terminate(); res('ready=' + (e.data && e.data.type)); };
    w.postMessage({ type: 'config', config: {} });
  }));

  await t('indexedDBOpen', () => new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open('file_probe', 1); } catch (e) { return rej(e); }
    r.onupgradeneeded = () => r.result.createObjectStore('s', { keyPath: 'k' });
    r.onsuccess = () => { r.result.close(); res('opened'); };
    r.onerror = () => rej(r.error || new Error('open error'));
    r.onblocked = () => rej(new Error('blocked'));
    setTimeout(() => rej(new Error('no reply in 3000ms')), 3000);
  }));

  await t('indexedDBWriteBlob', () => new Promise((res, rej) => {
    const r = indexedDB.open('file_probe2', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('s', { keyPath: 'k' });
    r.onerror = () => rej(r.error || new Error('open error'));
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('s', 'readwrite');
      tx.objectStore('s').put({ k: 'x', b: new Blob([new Uint8Array(1024)]) });
      tx.oncomplete = () => { db.close(); res('wrote 1KB blob'); };
      tx.onerror = () => rej(tx.error || new Error('tx error'));
    };
    setTimeout(() => rej(new Error('no reply in 3000ms')), 3000);
  }));

  await t('storageEstimate', async () => {
    const e = await navigator.storage.estimate();
    return 'quota=' + e.quota + ' usage=' + e.usage;
  });

  await t('storagePersist', () => navigator.storage.persist().then(String));

  await t('offscreenCanvasConvertToBlob', async () => {
    const c = new OffscreenCanvas(64, 64);
    c.getContext('2d').fillRect(0, 0, 64, 64);
    const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    return 'bytes=' + b.size;
  });

  await t('createImageBitmapFromFile', async () => {
    const f = window.__probe.files[0];
    if (!f) throw new Error('no file loaded');
    const b = await createImageBitmap(f, { resizeWidth: 1600, resizeQuality: 'high' });
    const dim = b.width + 'x' + b.height;
    b.close();
    return dim;
  });

  await t('showDirectoryPickerPresent', async () => typeof window.showDirectoryPicker);
  await t('fileSystemHandleInIDB', async () => typeof window.FileSystemDirectoryHandle);

  return out;
}`;

async function probe(label, url, extraArgs) {
  const browser = await chromium.launch({ args: ['--no-sandbox', ...(extraArgs || [])] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('console: ' + m.text());
  });
  await page.goto(url);
  await page.evaluate((s) => {
    window.__INLINE_WORKER__ = s;
  }, WORKER_SRC);
  await page.setInputFiles('#picker', SUB);
  const loaded = await page.evaluate(() => window.__probe.loadFilesFromInput());

  const checks = await page.evaluate(`(${CHECKS})()`);

  // Can a full ingest actually run here?
  let ingest = null;
  try {
    ingest = await page.evaluate(() =>
      window.__probe.runIngest({ workers: 2, limit: 8, useBlobUrl: false, sampleFrames: true })
    );
  } catch (e) {
    ingest = { fatal: String(e.message).slice(0, 300) };
  }
  let ingestViaBlobWorker = null;
  try {
    ingestViaBlobWorker = await page.evaluate(() => {
      window.__probe.workerSource = window.__INLINE_WORKER__;
      return window.__probe.runIngest({ workers: 2, limit: 8, useBlobUrl: true, sampleFrames: false });
    });
  } catch (e) {
    ingestViaBlobWorker = { fatal: String(e.message).slice(0, 300) };
  }

  await browser.close();
  const brief = (r) =>
    r && !r.fatal
      ? {
          completed: r.completed,
          errorCount: r.errorCount,
          errors: r.errors,
          wallMs: r.wallMs,
          idbError: r.idbError,
          previewMean: r.bytes && r.bytes.previewMean,
        }
      : r;
  return { label, url, filesLoaded: loaded.count, checks, ingestFromUrlWorker: brief(ingest), ingestFromBlobWorker: brief(ingestViaBlobWorker), pageErrors: errs.slice(0, 8) };
}

const results = [];
results.push(await probe('http://localhost (control)', `http://127.0.0.1:${PORT}/harness.html`, []));
results.push(await probe('file:// default flags', 'file://' + path.join(DIR, 'harness.html'), []));
results.push(await probe('file:// --allow-file-access-from-files', 'file://' + path.join(DIR, 'harness.html'), ['--allow-file-access-from-files']));

srv.kill();

for (const r of results) {
  console.log('\n### ' + r.label + '   files=' + r.filesLoaded);
  console.log('   origin=' + r.checks.origin + ' secure=' + r.checks.isSecureContext + ' coi=' + r.checks.crossOriginIsolated);
  for (const [k, v] of Object.entries(r.checks)) {
    if (v && typeof v === 'object' && 'ok' in v) {
      console.log('   ' + (v.ok ? 'OK   ' : 'FAIL ') + k.padEnd(34) + ' ' + (v.ok ? v.value : v.error));
    }
  }
  console.log('   ingest via URL worker : ' + JSON.stringify(r.ingestFromUrlWorker));
  console.log('   ingest via blob worker: ' + JSON.stringify(r.ingestFromBlobWorker));
  if (r.pageErrors.length) console.log('   pageErrors: ' + JSON.stringify(r.pageErrors));
}

save('file_url.json', results);
