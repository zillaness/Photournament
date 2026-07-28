// PRD section 8 says "500 full-resolution decodes cannot coexist". This probe
// puts a number on that and on the streaming alternative, with renderer-process
// RSS broken out so the measurement is not swamped by fixed browser overhead.
//
// Three arms, same 500 files:
//   A  streaming pool (backpressure: at most `workers` images in flight)
//   B  eager read     (all 500 File objects read to ArrayBuffer up front)
//   C  eager decode   (all 500 held as ImageBitmap at once) -- the forbidden one

import { chromium, serve, waitPort, CORPUS, save, typedSampler, rssByType } from './lib.mjs';

const PORT = 8136;
const N = Number(process.env.N || 500);
const srv = serve(PORT);
await waitPort(PORT);

const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-precise-memory-info', '--js-flags=--max-old-space-size=4096'],
});

async function page() {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(`http://127.0.0.1:${PORT}/harness.html`);
  await pg.setInputFiles('#picker', CORPUS);
  await pg.evaluate(() => window.__probe.loadFilesFromInput());
  await pg.evaluate(() => window.__probe.clearDB());
  // let the file-list plumbing settle before taking the idle baseline
  await pg.waitForTimeout(1500);
  return { ctx, pg, errs };
}

const report = { N, arms: {} };

// ---- A: streaming ----------------------------------------------------------
for (const [name, opts] of [
  ['streaming_workers4_full', { workers: 4, kind: 'blob', strategy: 'full', limit: N }],
  ['streaming_workers4_sized', { workers: 4, kind: 'blob', strategy: 'sized', limit: N }],
  ['streaming_workers4_imagebitmap', { workers: 4, kind: 'imagebitmap', strategy: 'full', limit: N }],
  ['streaming_workers8_full', { workers: 8, kind: 'blob', strategy: 'full', limit: N }],
]) {
  const { ctx, pg, errs } = await page();
  const idle = rssByType(process.pid);
  const s = typedSampler(process.pid, 200);
  const r = await pg.evaluate((o) => window.__probe.runIngest(o), opts);
  const mem = s.stop();
  await ctx.close();
  report.arms[name] = {
    opts,
    idle,
    mem,
    wallMs: r.wallMs,
    completed: r.completed,
    errorCount: r.errorCount,
    pageHeap: r.heap,
    pageErrors: errs.slice(0, 3),
  };
  console.log(
    `${name.padEnd(32)} wall=${(r.wallMs / 1000).toFixed(1)}s  renderer idle=${idle.renderer}MB ` +
      `peak=${mem.renderer.peak}MB  1st/2nd half=${mem.renderer.firstHalfMean}/${mem.renderer.secondHalfMean}MB  ` +
      `browserProc peak=${mem.browser.peak}MB  total peak=${mem.total.peak}MB`
  );
}

// ---- B: eager read to ArrayBuffer ------------------------------------------
{
  const { ctx, pg } = await page();
  const idle = rssByType(process.pid);
  const s = typedSampler(process.pid, 200);
  const r = await pg.evaluate(async (n) => {
    const files = window.__probe.files.slice(0, n);
    const held = [];
    let err = null;
    const t0 = performance.now();
    try {
      for (const f of files) held.push(await f.arrayBuffer());
    } catch (e) {
      err = String(e && e.message ? e.message : e);
    }
    const bytes = held.reduce((a, b) => a + b.byteLength, 0);
    const heap = performance.memory ? performance.memory.usedJSHeapSize : null;
    return { held: held.length, bytes, err, wallMs: performance.now() - t0, heapMB: heap ? +(heap / 1048576).toFixed(0) : null };
  }, N);
  const mem = s.stop();
  await ctx.close();
  report.arms.eager_read_arraybuffer = { idle, mem, ...r };
  console.log(
    `eager_read_arraybuffer           held=${r.held} bytes=${(r.bytes / 1e6).toFixed(0)}MB jsHeap=${r.heapMB}MB ` +
      `renderer idle=${idle.renderer}MB peak=${mem.renderer.peak}MB err=${r.err}`
  );
}

// ---- C: eager decode, hold every ImageBitmap -------------------------------
{
  const { ctx, pg } = await page();
  const idle = rssByType(process.pid);
  const s = typedSampler(process.pid, 200);
  let r;
  try {
    r = await pg.evaluate((n) => window.__probe.unboundedControl(n), N);
  } catch (e) {
    r = { rendererCrashed: true, error: String(e.message).slice(0, 400), requested: N, held: null, failedAt: null, rgbaBytesIfMaterialised: 0 };
  }
  const mem = s.stop();
  try {
    await ctx.close();
  } catch {
    /* renderer may already be gone */
  }
  report.arms.eager_decode_imagebitmap = { idle, mem, ...r };
  console.log(
    `eager_decode_imagebitmap         held=${r.held}/${r.requested} failedAt=${r.failedAt} err=${r.error} ` +
      `rgbaIfMaterialised=${(r.rgbaBytesIfMaterialised / 1e6).toFixed(0)}MB renderer idle=${idle.renderer}MB peak=${mem.renderer.peak}MB ` +
      `gpu peak=${mem.gpu.peak}MB total peak=${mem.total.peak}MB`
  );
  console.log('   renderer series MB: ' + mem.renderer.series.join(' '));
}

await browser.close();
srv.kill();
save('memory.json', report);
