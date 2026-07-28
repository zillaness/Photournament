/* Worker pool + instrumentation for the Photournament ingest probe.
 *
 * Everything the Playwright drivers touch hangs off window.__probe.
 */

const WORKER_URL = 'pipeline_worker.js';

// ---------------------------------------------------------------- worker pool

async function makeWorker(useBlobUrl) {
  if (!useBlobUrl) return new Worker(WORKER_URL);
  // file:// fallback: fetch the source and boot from a blob: URL. Under file://
  // fetch() itself is blocked, so this only works when the source is inlined —
  // see window.__probe.workerSource.
  const src = window.__probe.workerSource;
  if (!src) throw new Error('no inlined worker source');
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  return new Worker(url);
}

class Pool {
  constructor(size, config, useBlobUrl) {
    this.size = size;
    this.config = config;
    this.useBlobUrl = useBlobUrl;
    this.workers = [];
    this.idle = [];
  }

  async start() {
    for (let i = 0; i < this.size; i++) {
      const w = await makeWorker(this.useBlobUrl);
      w.__i = i;
      const ready = new Promise((res) => {
        const h = (e) => {
          if (e.data.type === 'ready') {
            w.removeEventListener('message', h);
            res();
          }
        };
        w.addEventListener('message', h);
      });
      w.postMessage({ type: 'config', config: this.config });
      await ready;
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  terminate() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.idle = [];
  }
}

// -------------------------------------------------------------- instrument

function startFrameSampler() {
  const gaps = [];
  let last = performance.now();
  let running = true;
  const spinner = document.getElementById('spinner');
  let deg = 0;
  const tick = (now) => {
    if (!running) return;
    gaps.push(now - last);
    last = now;
    // A real ingest screen is animating a progress bar and painting thumbs.
    // Keep something moving so an idle-page measurement isn't mistaken for a
    // responsive one.
    deg = (deg + 6) % 360;
    if (spinner) spinner.style.transform = `rotate(${deg}deg)`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stop() {
      running = false;
      // drop the first sample: it spans the gap between sampler start and the
      // first frame, which is not an ingest-induced stall
      const g = gaps.slice(1).sort((a, b) => a - b);
      const q = (p) => (g.length ? g[Math.min(g.length - 1, Math.floor((p / 100) * g.length))] : null);
      return {
        frames: g.length,
        median: q(50),
        p95: q(95),
        p99: q(99),
        max: g.length ? g[g.length - 1] : null,
        over50ms: g.filter((x) => x > 50).length,
        over100ms: g.filter((x) => x > 100).length,
      };
    },
  };
}

function heapNow() {
  return performance.memory ? performance.memory.usedJSHeapSize : null;
}

// -------------------------------------------------------------- IndexedDB

const DB_NAME = 'photournament_probe';
const STORE = 'derivatives';

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function idbPutMany(db, records) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    records.forEach((rec) => st.put(rec));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function idbAllKeys(db) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).getAllKeys();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function idbGetAll(db) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// PRD 7.9 fingerprint. The cheap half (name + size + lastModified) is known
// before any work happens and is what the skip check keys on; the perceptual
// hash is only knowable after processing, so it is stored alongside for
// re-association rather than used as the lookup key.
function preKey(file) {
  return `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
}

// ------------------------------------------------------------------- run

async function runIngest(opts) {
  const {
    workers = 4,
    kind = 'blob', // blob | arraybuffer | imagebitmap
    strategy = 'sized',
    format = 'image/jpeg',
    thumbQuality = 0.72,
    previewQuality = 0.8,
    thumbEdge = 320,
    previewEdge = 1600,
    hash = 'dct',
    limit = 0,
    batch = 24, // how many finished records are flushed to IndexedDB at once
    persist = true,
    resume = false,
    stopAfter = 0, // simulate an interruption after N images
    keepBlobs = false,
    useBlobUrl = false,
    sampleFrames = true,
    renderThumbs = false, // paint each thumb into a grid as the real ingest UI would
  } = opts || {};

  const grid = document.getElementById('grid');
  if (grid) grid.innerHTML = '';
  const objectUrls = [];

  const all = window.__probe.files;
  const files = limit ? all.slice(0, limit) : all;

  let db = null;
  let skipKeys = new Set();
  let idbError = null;
  if (persist) {
    try {
      db = await openDB();
      if (resume) skipKeys = new Set(await idbAllKeys(db));
    } catch (e) {
      idbError = String(e && e.message ? e.message : e);
    }
  }

  const queue = [];
  let skipped = 0;
  for (const f of files) {
    if (skipKeys.has(preKey(f))) {
      skipped++;
      continue;
    }
    queue.push(f);
  }

  const pool = new Pool(workers, { strategy, format, thumbQuality, previewQuality, thumbEdge, previewEdge, hash }, useBlobUrl);
  await pool.start();

  const sampler = sampleFrames ? startFrameSampler() : null;
  const heapSamples = [];
  const progress = [];
  const timings = [];
  const errors = [];
  const results = [];
  let pending = [];
  let completed = 0;
  let bytesThumb = 0;
  let bytesPreview = 0;
  let mainThreadReadMs = 0;
  let interrupted = false;

  const heapTimer = setInterval(() => {
    const h = heapNow();
    if (h != null) heapSamples.push({ t: performance.now(), used: h, done: completed });
  }, 200);

  const t0 = performance.now();

  await new Promise((resolve) => {
    let next = 0;
    let inflight = 0;

    const flush = async () => {
      if (!db || !pending.length) return;
      const batchRecs = pending;
      pending = [];
      try {
        await idbPutMany(db, batchRecs);
      } catch (e) {
        idbError = idbError || String(e && e.message ? e.message : e);
      }
    };

    const finish = async () => {
      await flush();
      resolve();
    };

    const pump = async (w) => {
      if (interrupted) {
        if (inflight === 0) finish();
        return;
      }
      if (next >= queue.length) {
        if (inflight === 0) finish();
        return;
      }
      const file = queue[next];
      const seq = next;
      next++;
      inflight++;

      // The payload is only materialised at dispatch time — this is what keeps
      // memory bounded. A File is a lazy handle to bytes on disk; reading it
      // eagerly for all 500 would be the unbounded version.
      let payload = file;
      let transfer = [];
      if (kind === 'arraybuffer') {
        const r0 = performance.now();
        payload = await file.arrayBuffer();
        mainThreadReadMs += performance.now() - r0;
        transfer = [payload];
      } else if (kind === 'imagebitmap') {
        const r0 = performance.now();
        payload = await createImageBitmap(file);
        mainThreadReadMs += performance.now() - r0;
        transfer = [payload];
      }
      w.postMessage({ type: 'job', id: preKey(file), seq, kind, payload }, transfer);
    };

    const onMessage = async (e) => {
      const m = e.data;
      if (m.type !== 'done' && m.type !== 'error') return;
      const w = e.currentTarget;
      inflight--;
      completed++;
      if (m.type === 'error') {
        errors.push({ id: m.id, error: m.error });
      } else {
        timings.push(m.timings);
        bytesThumb += m.bytes.thumb;
        bytesPreview += m.bytes.preview;
        const file = queue[m.seq];
        const rec = {
          key: m.id,
          name: file.webkitRelativePath || file.name,
          size: file.size,
          lastModified: file.lastModified,
          phash: m.phash,
          dims: m.dims,
          thumb: m.thumb,
          preview: m.preview,
        };
        if (db) pending.push(rec);
        if (renderThumbs && grid) {
          const u = URL.createObjectURL(m.thumb);
          objectUrls.push(u);
          const img = document.createElement('img');
          img.src = u;
          img.width = 160;
          img.loading = 'eager';
          img.decoding = 'sync';
          grid.appendChild(img);
        }
        if (keepBlobs) results.push({ key: m.id, phash: m.phash, dims: m.dims, tb: m.bytes.thumb, pb: m.bytes.preview });
        else results.push({ key: m.id, phash: m.phash, tb: m.bytes.thumb, pb: m.bytes.preview });
      }
      if (completed % 10 === 0 || completed === queue.length) {
        progress.push({ done: completed, t: performance.now() - t0 });
        const el = document.getElementById('log');
        if (el) el.textContent = `${completed}/${queue.length}`;
      }
      if (pending.length >= batch) await flush();
      if (stopAfter && completed >= stopAfter) interrupted = true;
      pump(w);
    };

    pool.workers.forEach((w) => {
      w.addEventListener('message', onMessage);
      pump(w);
    });
  });

  const wall = performance.now() - t0;
  clearInterval(heapTimer);
  const frames = sampler ? sampler.stop() : null;

  // worker-side heaps before teardown
  const workerHeaps = await Promise.all(
    pool.workers.map(
      (w) =>
        new Promise((res) => {
          const h = (e) => {
            if (e.data.type === 'heap') {
              w.removeEventListener('message', h);
              res(e.data.used);
            }
          };
          w.addEventListener('message', h);
          w.postMessage({ type: 'heap' });
          setTimeout(() => res(null), 2000);
        })
    )
  );

  pool.terminate();

  const agg = {};
  if (timings.length) {
    for (const k of Object.keys(timings[0])) {
      const v = timings.map((x) => x[k]).sort((a, b) => a - b);
      agg[k] = {
        mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2),
        p50: +v[Math.floor(v.length * 0.5)].toFixed(2),
        p95: +v[Math.floor(v.length * 0.95)].toFixed(2),
        max: +v[v.length - 1].toFixed(2),
      };
    }
  }

  const heapUsed = heapSamples.map((s) => s.used);
  const renderedThumbs = grid ? grid.childElementCount : 0;
  return {
    renderedThumbs,
    objectUrlsHeld: objectUrls.length,
    opts: { workers, kind, strategy, format, thumbQuality, previewQuality, hash, batch, persist, resume, stopAfter },
    counted: queue.length,
    skipped,
    completed,
    interrupted,
    errors: errors.slice(0, 5),
    errorCount: errors.length,
    wallMs: +wall.toFixed(1),
    perImageMs: queue.length ? +(wall / Math.min(completed, queue.length)).toFixed(2) : null,
    throughputPerSec: +((Math.min(completed, queue.length) / wall) * 1000).toFixed(2),
    mainThreadReadMs: +mainThreadReadMs.toFixed(1),
    stageMs: agg,
    frames,
    heap: heapUsed.length
      ? {
          samples: heapUsed.length,
          startMB: +(heapUsed[0] / 1048576).toFixed(1),
          peakMB: +(Math.max(...heapUsed) / 1048576).toFixed(1),
          endMB: +(heapUsed[heapUsed.length - 1] / 1048576).toFixed(1),
          firstHalfMeanMB: +(
            heapUsed.slice(0, Math.floor(heapUsed.length / 2)).reduce((a, b) => a + b, 0) /
            Math.max(1, Math.floor(heapUsed.length / 2)) /
            1048576
          ).toFixed(1),
          secondHalfMeanMB: +(
            heapUsed.slice(Math.floor(heapUsed.length / 2)).reduce((a, b) => a + b, 0) /
            Math.max(1, heapUsed.length - Math.floor(heapUsed.length / 2)) /
            1048576
          ).toFixed(1),
          series: heapUsed.filter((_, i) => i % Math.max(1, Math.ceil(heapUsed.length / 40)) === 0).map((x) => +(x / 1048576).toFixed(1)),
        }
      : null,
    workerHeapMB: workerHeaps.map((x) => (x == null ? null : +(x / 1048576).toFixed(1))),
    bytes: {
      thumbTotal: bytesThumb,
      previewTotal: bytesPreview,
      thumbMean: completed ? Math.round(bytesThumb / completed) : 0,
      previewMean: completed ? Math.round(bytesPreview / completed) : 0,
    },
    idbError,
    progress,
    sampleHashes: results.slice(0, 5),
  };
}

// ------------------------------------------------------- exported harness API

window.__probe = {
  files: [],
  workerSource: null,
  runIngest,
  preKey,

  async loadFilesFromInput() {
    const input = document.getElementById('picker');
    const fl = Array.from(input.files || []);
    fl.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
    window.__probe.files = fl;
    return {
      count: fl.length,
      totalBytes: fl.reduce((a, f) => a + f.size, 0),
      sample: fl.slice(0, 3).map((f) => ({ path: f.webkitRelativePath, size: f.size, lastModified: f.lastModified })),
    };
  },

  async clearDB() {
    try {
      const db = await openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
      return 'cleared';
    } catch (e) {
      return 'error: ' + (e && e.message ? e.message : e);
    }
  },

  async dbSummary() {
    try {
      const db = await openDB();
      const all = await idbGetAll(db);
      let tb = 0,
        pb = 0;
      for (const r of all) {
        tb += r.thumb ? r.thumb.size : 0;
        pb += r.preview ? r.preview.size : 0;
      }
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      db.close();
      return {
        records: all.length,
        thumbBytes: tb,
        previewBytes: pb,
        firstKeys: all.slice(0, 3).map((r) => r.key),
        hashes: all.slice(0, 200).map((r) => ({ key: r.key, phash: r.phash })),
        estimate: est ? { usage: est.usage, quota: est.quota } : null,
      };
    } catch (e) {
      return { error: String(e && e.message ? e.message : e) };
    }
  },

  // Hash an arbitrary list of blobs through one worker. Used to check the
  // perceptual hash is actually perceptual (PRD 7.7 needs Hamming distance to
  // mean something) rather than a content digest in disguise.
  async hashBlobs(blobs, hash) {
    const w = new Worker(WORKER_URL);
    await new Promise((res) => {
      const h = (e) => {
        if (e.data.type === 'ready') {
          w.removeEventListener('message', h);
          res();
        }
      };
      w.addEventListener('message', h);
      w.postMessage({ type: 'config', config: { hash: hash || 'dct' } });
    });
    const out = [];
    for (let i = 0; i < blobs.length; i++) {
      out.push(
        await new Promise((res) => {
          const h = (e) => {
            if (e.data.seq === i) {
              w.removeEventListener('message', h);
              res(e.data.phash || 'ERR:' + e.data.error);
            }
          };
          w.addEventListener('message', h);
          w.postMessage({ type: 'job', id: 'h' + i, seq: i, kind: 'blob', payload: blobs[i] });
        })
      );
    }
    w.terminate();
    return out;
  },

  // Build near-duplicate variants of a source image, the burst-frame analogue.
  async makeVariants(file) {
    const bmp = await createImageBitmap(file);
    const mk = async (w, h, draw, q) => {
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext('2d');
      draw(x);
      return c.convertToBlob({ type: 'image/jpeg', quality: q == null ? 0.82 : q });
    };
    const W = bmp.width,
      H = bmp.height;
    const v = {};
    v.identicalReencode = await mk(W, H, (x) => x.drawImage(bmp, 0, 0), 0.82);
    v.lowQualityReencode = await mk(W, H, (x) => x.drawImage(bmp, 0, 0), 0.35);
    v.shifted12px = await mk(W, H, (x) => x.drawImage(bmp, 12, 9));
    v.crop95pct = await mk(W, H, (x) => x.drawImage(bmp, W * 0.025, H * 0.025, W * 0.95, H * 0.95, 0, 0, W, H));
    v.brighter = await mk(W, H, (x) => {
      x.drawImage(bmp, 0, 0);
      x.globalCompositeOperation = 'lighter';
      x.fillStyle = 'rgba(255,255,255,0.08)';
      x.fillRect(0, 0, W, H);
    });
    v.rotated2deg = await mk(W, H, (x) => {
      x.translate(W / 2, H / 2);
      x.rotate((2 * Math.PI) / 180);
      x.drawImage(bmp, -W / 2, -H / 2);
    });
    v.halfResolution = await mk(W >> 1, H >> 1, (x) => x.drawImage(bmp, 0, 0, W >> 1, H >> 1));
    bmp.close();
    return v;
  },

  // Control arm for PRD section 8: decode everything up front and hold it.
  async unboundedControl(limit) {
    const files = window.__probe.files.slice(0, limit);
    const held = [];
    const heap = [];
    const t0 = performance.now();
    let failedAt = null;
    let err = null;
    try {
      for (let i = 0; i < files.length; i++) {
        held.push(await createImageBitmap(files[i]));
        if (i % 10 === 0 && performance.memory) heap.push({ i, mb: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) });
      }
    } catch (e) {
      failedAt = held.length;
      err = String(e && e.message ? e.message : e);
    }
    const res = {
      requested: files.length,
      held: held.length,
      failedAt,
      error: err,
      wallMs: +(performance.now() - t0).toFixed(0),
      rgbaBytesIfMaterialised: held.reduce((a, b) => a + b.width * b.height * 4, 0),
      heap,
    };
    held.forEach((b) => b.close());
    return res;
  },
};

document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('log');
  if (el) el.textContent = 'ready';
});
