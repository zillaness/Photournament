/* Photournament ingest worker (PRD 7.9).
 *
 * Per photo: grid thumbnail (~320px long edge) + matchup preview (~1600px long
 * edge) + perceptual hash, with a per-stage timing breakdown.
 *
 * Classic (non-module) worker on purpose: module workers are one more thing
 * that can break under file://, and this file has no imports.
 */
/* eslint-env worker */

let CFG = {
  thumbEdge: 320,
  previewEdge: 1600,
  format: 'image/jpeg',
  thumbQuality: 0.72,
  previewQuality: 0.8,
  // 'full'  : decode at native resolution, then downscale twice
  // 'sized' : ask the decoder for the preview size directly, never materialising
  //           the full-resolution RGBA surface
  strategy: 'sized',
  hash: 'dct', // 'dct' (pHash) | 'dhash'
};

// Reusable canvases. Allocating an OffscreenCanvas per image is measurable
// overhead at 500 images and keeps churning the renderer's surface cache.
const cvPrev = new OffscreenCanvas(16, 16);
const ctxPrev = cvPrev.getContext('2d', { alpha: false, willReadFrequently: false });
const cvThumb = new OffscreenCanvas(16, 16);
const ctxThumb = cvThumb.getContext('2d', { alpha: false, willReadFrequently: false });
const cvHash = new OffscreenCanvas(32, 32);
const ctxHash = cvHash.getContext('2d', { alpha: false, willReadFrequently: true });

// Minimal JPEG SOFn scan: returns [width, height] or null.
function jpegSize(u8) {
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return null;
  let i = 2;
  while (i < u8.length - 9) {
    if (u8[i] !== 0xff) {
      i++;
      continue;
    }
    const m = u8[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    // SOF0..SOF15 except DHT(c4), JPG(c8), DAC(cc)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return [(u8[i + 7] << 8) | u8[i + 8], (u8[i + 5] << 8) | u8[i + 6]];
    }
    if (m === 0xda) return null; // hit scan data without an SOF
    i += 2 + len;
  }
  return null;
}

function fit(w, h, edge) {
  const s = Math.min(1, edge / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

// ---- perceptual hash -------------------------------------------------------

// 1-D DCT-II basis for N=32, precomputed once.
const N = 32;
const COS = new Float32Array(N * N);
for (let u = 0; u < N; u++) {
  for (let x = 0; x < N; x++) COS[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
}

function pHashDCT(gray) {
  // rows then cols, but we only need the top-left 8x8 block, so only compute
  // the 8 lowest frequencies in each direction.
  const K = 8;
  const tmp = new Float32Array(K * N);
  for (let u = 0; u < K; u++) {
    for (let x = 0; x < N; x++) {
      let s = 0;
      const row = x * N;
      for (let y = 0; y < N; y++) s += gray[row + y] * COS[u * N + y];
      tmp[u * N + x] = s;
    }
  }
  const blk = new Float32Array(K * K);
  for (let v = 0; v < K; v++) {
    for (let u = 0; u < K; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += tmp[u * N + x] * COS[v * N + x];
      blk[v * K + u] = s;
    }
  }
  // median of the 63 coefficients excluding DC
  const rest = Array.from(blk.slice(1)).sort((a, b) => a - b);
  const med = rest[Math.floor(rest.length / 2)];
  let hi = 0,
    lo = 0;
  for (let i = 0; i < 32; i++) if (blk[i] > med) hi |= 1 << (31 - i);
  for (let i = 32; i < 64; i++) if (blk[i] > med) lo |= 1 << (63 - i);
  return ((hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0'));
}

function dHash(gray) {
  // 32x32 grey -> compare each pixel with its right neighbour on an 8x9 grid
  let hi = 0,
    lo = 0,
    bit = 0;
  for (let y = 0; y < 8; y++) {
    const sy = ((y * 4 + 2) | 0) * N;
    for (let x = 0; x < 8; x++) {
      const a = gray[sy + x * 4 + 1];
      const b = gray[sy + x * 4 + 5];
      if (a > b) {
        if (bit < 32) hi |= 1 << (31 - bit);
        else lo |= 1 << (63 - bit);
      }
      bit++;
    }
  }
  return ((hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0'));
}

function hashFrom(src) {
  ctxHash.drawImage(src, 0, 0, N, N);
  const d = ctxHash.getImageData(0, 0, N, N).data;
  const gray = new Float32Array(N * N);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  }
  return CFG.hash === 'dhash' ? dHash(gray) : pHashDCT(gray);
}

// ---- main per-image pipeline ----------------------------------------------

async function process(job) {
  const t = {};
  const mark = (k, t0) => (t[k] = performance.now() - t0);
  let t0 = performance.now();

  let source = job.payload;
  let bitmap;
  let nativeW = 0,
    nativeH = 0;

  if (job.kind === 'imagebitmap') {
    bitmap = source; // decoded on the main thread, transferred in
    nativeW = bitmap.width;
    nativeH = bitmap.height;
    mark('decode', t0);
  } else {
    const blob = job.kind === 'arraybuffer' ? new Blob([source]) : source;
    if (CFG.strategy === 'sized') {
      // Read the native dimensions out of the JPEG header (a few KB) so we know
      // which axis is the long edge, then ask createImageBitmap to decode
      // straight to that size. Chromium's JPEG decoder scales during decode, so
      // the full-resolution RGBA surface is never allocated.
      const head = await blob.slice(0, 65536).arrayBuffer();
      const dim = jpegSize(new Uint8Array(head));
      let opts;
      if (dim) {
        nativeW = dim[0];
        nativeH = dim[1];
        opts =
          dim[0] >= dim[1]
            ? { resizeWidth: Math.min(CFG.previewEdge, dim[0]), resizeQuality: 'high' }
            : { resizeHeight: Math.min(CFG.previewEdge, dim[1]), resizeQuality: 'high' };
      } else {
        // Not a JPEG (PNG/WebP path) — fall back to a square bound, which
        // preserves aspect because only the binding axis is supplied.
        opts = { resizeWidth: CFG.previewEdge, resizeQuality: 'high' };
      }
      bitmap = await createImageBitmap(blob, opts);
      mark('decode', t0);
    } else {
      bitmap = await createImageBitmap(blob);
      nativeW = bitmap.width;
      nativeH = bitmap.height;
      mark('decode', t0);
    }
  }

  // preview
  t0 = performance.now();
  const [pw, ph] = fit(bitmap.width, bitmap.height, CFG.previewEdge);
  if (cvPrev.width !== pw || cvPrev.height !== ph) {
    cvPrev.width = pw;
    cvPrev.height = ph;
  }
  ctxPrev.drawImage(bitmap, 0, 0, pw, ph);
  mark('resizePreview', t0);

  t0 = performance.now();
  const preview = await cvPrev.convertToBlob({ type: CFG.format, quality: CFG.previewQuality });
  mark('encodePreview', t0);

  // thumbnail, downscaled from the preview rather than the original: one less
  // large read and visually indistinguishable at 320px.
  t0 = performance.now();
  const [tw, th] = fit(pw, ph, CFG.thumbEdge);
  if (cvThumb.width !== tw || cvThumb.height !== th) {
    cvThumb.width = tw;
    cvThumb.height = th;
  }
  ctxThumb.drawImage(cvPrev, 0, 0, tw, th);
  mark('resizeThumb', t0);

  t0 = performance.now();
  const thumb = await cvThumb.convertToBlob({ type: CFG.format, quality: CFG.thumbQuality });
  mark('encodeThumb', t0);

  t0 = performance.now();
  const phash = hashFrom(cvThumb);
  mark('hash', t0);

  bitmap.close();

  return {
    thumb,
    preview,
    phash,
    dims: { nativeW, nativeH, pw, ph, tw, th },
    bytes: { thumb: thumb.size, preview: preview.size },
    timings: t,
  };
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'config') {
    CFG = { ...CFG, ...msg.config };
    self.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'job') {
    const wall = performance.now();
    try {
      const r = await process(msg);
      r.timings.total = performance.now() - wall;
      self.postMessage(
        { type: 'done', id: msg.id, seq: msg.seq, ...r },
        [] // blobs are by-reference; nothing worth transferring back
      );
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, seq: msg.seq, error: String(err && err.message ? err.message : err) });
    }
    return;
  }
  if (msg.type === 'heap') {
    self.postMessage({
      type: 'heap',
      used: (self.performance && self.performance.memory && self.performance.memory.usedJSHeapSize) || null,
    });
  }
};
