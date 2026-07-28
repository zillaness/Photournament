/**
 * phash.js — perceptual hashing, Hamming distance, sharpness and near-duplicate
 * clustering for Photournament (PRD v1.8 §7.7, §7.9).
 *
 * Dependency-free classic script. Exports a single global:
 *
 *     window.PhotournamentHash  (also globalThis.PhotournamentHash)
 *
 * Works unchanged in a Web Worker, in a plain page, and under Node via
 * `vm.runInThisContext(fs.readFileSync('phash.js','utf8'))`.
 *
 * ---------------------------------------------------------------------------
 * Design notes
 * ---------------------------------------------------------------------------
 * Input is always RGBA pixel data: `{ width, height, data: Uint8ClampedArray }`
 * — i.e. an `ImageData`, exactly what `ctx.getImageData()` and
 * `OffscreenCanvas` hand back. The caller decides what it draws in; the app
 * should hash the ~320px grid thumbnail it already generates at ingest, not the
 * full-resolution decode (see FINDINGS.md — measured identical grouping, ~40x
 * cheaper).
 *
 * Two hashes, both 64-bit, stored as 16-char lowercase hex:
 *
 *   dHash  — 9x8 greyscale downsample, one bit per horizontal adjacent-pixel
 *            comparison. 64 informative bits. Very fast, very robust to
 *            exposure/gain, weak against rotation.
 *   pHash  — 32x32 greyscale downsample, 2-D DCT-II, top-left 8x8 low-frequency
 *            block, each coefficient compared against the median of the 63
 *            non-DC coefficients. The DC bit is forced to 0 (DC is always the
 *            largest coefficient, so its bit would be a constant): the hash is
 *            64 bits wide with 63 informative bits. Slower, more robust to
 *            blur, crop and mild rotation.
 *
 * Bit i of a hash lives in byte (i >> 3) at bit position 7 - (i & 7), so the
 * hex string reads left-to-right in scan order. Hamming distance is a
 * table-driven byte XOR popcount over the hex string, no BigInt, no allocation.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants and lookup tables
  // ---------------------------------------------------------------------------

  var DHASH_W = 9;   // 9x8 grey -> 8 rows x 8 horizontal comparisons = 64 bits
  var DHASH_H = 8;
  var PHASH_N = 32;  // DCT input size
  var PHASH_K = 8;   // low-frequency block kept

  /** popcount[0..255] */
  var POPCOUNT = (function () {
    var t = new Uint8Array(256);
    for (var i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1];
    return t;
  })();

  /** hex char code -> nibble value, -1 for invalid. */
  var HEXVAL = (function () {
    var t = new Int8Array(128).fill(-1);
    for (var i = 0; i < 10; i++) t[48 + i] = i;            // '0'-'9'
    for (var j = 0; j < 6; j++) { t[97 + j] = 10 + j; t[65 + j] = 10 + j; } // a-f A-F
    return t;
  })();

  var HEXCHARS = '0123456789abcdef';

  /**
   * Precomputed DCT-II basis: COS[u * N + x] = cos((2x+1) * u * PI / (2N)),
   * already multiplied by the orthonormal scale factor for u.
   * Separable application costs 2 * N^3 multiply-adds per image (~65k at N=32).
   */
  var DCT_COS = (function (N) {
    var c = new Float64Array(N * N);
    var s0 = Math.sqrt(1 / N);
    var s = Math.sqrt(2 / N);
    for (var u = 0; u < N; u++) {
      var scale = u === 0 ? s0 : s;
      for (var x = 0; x < N; x++) {
        c[u * N + x] = scale * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
      }
    }
    return c;
  })(PHASH_N);

  // ---------------------------------------------------------------------------
  // Greyscale extraction and downsampling
  // ---------------------------------------------------------------------------

  /**
   * Rec.601 luma of an RGBA buffer, as Float32 in 0..255.
   * Alpha is ignored: photos are opaque, and compositing onto white would make
   * the hash depend on a background the user never sees.
   *
   * @param {{width:number,height:number,data:Uint8ClampedArray}} img
   * @returns {Float32Array} length width*height
   */
  function toGrey(img) {
    var d = img.data;
    var n = img.width * img.height;
    var out = new Float32Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      out[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    }
    return out;
  }

  /**
   * Area-average (box) downsample of a greyscale plane.
   *
   * Box averaging rather than nearest-neighbour or bilinear point sampling
   * matters: point sampling a 4000px photo down to 32px aliases high-frequency
   * texture into the hash, and two frames of the same burst alias differently.
   * Measured effect on burst distance was large (see FINDINGS.md).
   *
   * Handles upsampling too (ow > w), degenerating to nearest-neighbour.
   *
   * @param {Float32Array} src
   * @param {number} w source width
   * @param {number} h source height
   * @param {number} ow target width
   * @param {number} oh target height
   * @returns {Float32Array} length ow*oh
   */
  function downsampleGrey(src, w, h, ow, oh) {
    var out = new Float32Array(ow * oh);
    var sx = w / ow;
    var sy = h / oh;
    for (var oy = 0; oy < oh; oy++) {
      var y0 = Math.floor(oy * sy);
      var y1 = Math.min(h, Math.max(y0 + 1, Math.ceil((oy + 1) * sy)));
      for (var ox = 0; ox < ow; ox++) {
        var x0 = Math.floor(ox * sx);
        var x1 = Math.min(w, Math.max(x0 + 1, Math.ceil((ox + 1) * sx)));
        var sum = 0;
        var count = (y1 - y0) * (x1 - x0);
        for (var y = y0; y < y1; y++) {
          var row = y * w;
          for (var x = x0; x < x1; x++) sum += src[row + x];
        }
        out[oy * ow + ox] = sum / count;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Bit packing
  // ---------------------------------------------------------------------------

  /** @param {Uint8Array} bytes 8 bytes @returns {string} 16 hex chars */
  function bytesToHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      s += HEXCHARS[bytes[i] >> 4] + HEXCHARS[bytes[i] & 15];
    }
    return s;
  }

  /** @param {string} hex @returns {Uint8Array} */
  function hexToBytes(hex) {
    var n = hex.length >> 1;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      out[i] = (HEXVAL[hex.charCodeAt(2 * i)] << 4) | HEXVAL[hex.charCodeAt(2 * i + 1)];
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // dHash
  // ---------------------------------------------------------------------------

  /**
   * Difference hash from an already-9x8 greyscale plane.
   * @param {Float32Array} g length 72, row-major 9 wide
   * @returns {string} 16 hex chars
   */
  function dHashFromGrey9x8(g) {
    var bytes = new Uint8Array(8);
    var bit = 0;
    for (var y = 0; y < DHASH_H; y++) {
      var row = y * DHASH_W;
      for (var x = 0; x < DHASH_W - 1; x++, bit++) {
        if (g[row + x] > g[row + x + 1]) bytes[bit >> 3] |= 0x80 >> (bit & 7);
      }
    }
    return bytesToHex(bytes);
  }

  // ---------------------------------------------------------------------------
  // pHash
  // ---------------------------------------------------------------------------

  var _dctTmp = new Float64Array(PHASH_N * PHASH_N);
  var _dctOut = new Float64Array(PHASH_N * PHASH_N);
  var _medBuf = new Float64Array(PHASH_K * PHASH_K);

  /**
   * Perceptual hash from an already-32x32 greyscale plane.
   * Separable 2-D DCT-II, then threshold the 8x8 low-frequency block at the
   * median of its 63 non-DC coefficients.
   *
   * Uses module-level scratch buffers: not reentrant, which is fine because a
   * Worker is single-threaded and the app hashes one image at a time.
   *
   * @param {Float32Array} g length 1024
   * @returns {string} 16 hex chars
   */
  function pHashFromGrey32x32(g) {
    var N = PHASH_N, u, x, y, sum, i;

    // Rows: tmp[y][u] = sum_x g[y][x] * cos(u,x)
    for (y = 0; y < N; y++) {
      var gr = y * N;
      for (u = 0; u < N; u++) {
        sum = 0;
        var cu = u * N;
        for (x = 0; x < N; x++) sum += g[gr + x] * DCT_COS[cu + x];
        _dctTmp[gr + u] = sum;
      }
    }
    // Columns, but only the PHASH_K rows we actually keep.
    for (var v = 0; v < PHASH_K; v++) {
      var cv = v * N;
      for (u = 0; u < PHASH_K; u++) {
        sum = 0;
        for (y = 0; y < N; y++) sum += _dctTmp[y * N + u] * DCT_COS[cv + y];
        _dctOut[v * N + u] = sum;
      }
    }

    // Median of the 63 non-DC coefficients.
    var m = 0;
    for (v = 0; v < PHASH_K; v++) {
      for (u = 0; u < PHASH_K; u++) {
        if (v === 0 && u === 0) continue;
        _medBuf[m++] = _dctOut[v * N + u];
      }
    }
    var med = median(_medBuf, m);

    var bytes = new Uint8Array(8);
    var bit = 0;
    for (v = 0; v < PHASH_K; v++) {
      for (u = 0; u < PHASH_K; u++, bit++) {
        if (v === 0 && u === 0) continue;                 // DC bit stays 0
        if (_dctOut[v * N + u] > med) bytes[bit >> 3] |= 0x80 >> (bit & 7);
      }
    }
    return bytesToHex(bytes);
  }

  /** Median of the first `n` entries of `buf`. Copies, so `buf` is untouched. */
  function median(buf, n) {
    var a = Array.prototype.slice.call(buf, 0, n);
    a.sort(function (p, q) { return p - q; });
    return n & 1 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
  }

  // ---------------------------------------------------------------------------
  // Sharpness (PRD §7.7 representative nomination)
  // ---------------------------------------------------------------------------

  var SHARP_EDGE = 256; // grey plane long edge used for the sharpness metric

  /**
   * Variance of the 4-neighbour Laplacian, normalised by image contrast.
   *
   * Raw variance-of-Laplacian is the standard blur metric but it is not
   * comparable across images: it scales with resolution (more pixels per edge
   * = lower per-pixel second derivative) and with contrast (a high-contrast
   * scene beats a low-contrast one regardless of focus). Both matter here
   * because a near-duplicate group can mix a 12MP original with a downscaled
   * re-export.
   *
   * So: resample every image to a fixed long edge before measuring, and divide
   * by the variance of the grey plane itself. The result is a dimensionless
   * "edge energy per unit contrast" that is comparable within a group.
   *
   * @param {Float32Array} grey
   * @param {number} w
   * @param {number} h
   * @returns {number} higher is sharper
   */
  function sharpnessVarLap(grey, w, h) {
    var lapSum = 0, lapSq = 0, n = 0;
    for (var y = 1; y < h - 1; y++) {
      var r = y * w;
      for (var x = 1; x < w - 1; x++) {
        var i = r + x;
        var lap = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - w] - grey[i + w];
        lapSum += lap; lapSq += lap * lap; n++;
      }
    }
    if (n === 0) return 0;
    var lapVar = lapSq / n - (lapSum / n) * (lapSum / n);

    var gSum = 0, gSq = 0, m = w * h;
    for (var k = 0; k < m; k++) { gSum += grey[k]; gSq += grey[k] * grey[k]; }
    var gVar = gSq / m - (gSum / m) * (gSum / m);

    return lapVar / Math.max(gVar, 1e-6);
  }

  // ---------------------------------------------------------------------------
  // Public: hash an ImageData
  // ---------------------------------------------------------------------------

  /**
   * Compute both hashes plus the sharpness metric in one pass over the pixels.
   *
   * @param {{width:number,height:number,data:Uint8ClampedArray}} img
   * @param {{sharpness?:boolean}} [opts] sharpness defaults to true
   * @returns {{dhash:string, phash:string, sharpness:number, width:number, height:number}}
   */
  function hashImageData(img, opts) {
    var wantSharp = !opts || opts.sharpness !== false;
    var w = img.width, h = img.height;
    var grey = toGrey(img);

    var g32 = downsampleGrey(grey, w, h, PHASH_N, PHASH_N);
    var g98 = downsampleGrey(grey, w, h, DHASH_W, DHASH_H);

    var sharp = 0;
    if (wantSharp) {
      var sw, sh;
      if (w >= h) { sw = Math.min(SHARP_EDGE, w); sh = Math.max(1, Math.round((h / w) * sw)); }
      else { sh = Math.min(SHARP_EDGE, h); sw = Math.max(1, Math.round((w / h) * sh)); }
      var gs = (sw === w && sh === h) ? grey : downsampleGrey(grey, w, h, sw, sh);
      sharp = sharpnessVarLap(gs, sw, sh);
    }

    return {
      dhash: dHashFromGrey9x8(g98),
      phash: pHashFromGrey32x32(g32),
      sharpness: sharp,
      width: w,
      height: h
    };
  }

  // ---------------------------------------------------------------------------
  // Hamming distance
  // ---------------------------------------------------------------------------

  /**
   * Hamming distance between two 16-char hex hashes. 0..64.
   * Byte-at-a-time XOR popcount; no allocation, no BigInt.
   * ~40M comparisons/sec measured — 500 photos is 124,750 pairs, ~3ms.
   *
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  function hamming(a, b) {
    var d = 0;
    for (var i = 0; i < a.length; i += 2) {
      var x = ((HEXVAL[a.charCodeAt(i)] << 4) | HEXVAL[a.charCodeAt(i + 1)]) ^
              ((HEXVAL[b.charCodeAt(i)] << 4) | HEXVAL[b.charCodeAt(i + 1)]);
      d += POPCOUNT[x];
    }
    return d;
  }

  /** Hamming distance between two equal-length Uint8Arrays. */
  function hammingBytes(a, b) {
    var d = 0;
    for (var i = 0; i < a.length; i++) d += POPCOUNT[a[i] ^ b[i]];
    return d;
  }

  // ---------------------------------------------------------------------------
  // Clustering (PRD §7.7 auto-group)
  // ---------------------------------------------------------------------------

  /**
   * Group items whose hashes are within `threshold` of each other.
   *
   * Perceptual hashes are not transitive: A~B and B~C does not make A~C, so the
   * linkage rule is a real product decision, not an implementation detail.
   *
   *   'single'   union-find on the threshold graph (single linkage). Any edge
   *              merges. Cheap, order-independent, chains: a long burst walking
   *              across a scene can end up in one group with endpoints that
   *              look nothing alike.
   *   'complete' a member joins a group only if it is within `threshold` of
   *              EVERY existing member (complete linkage, greedy). No chaining,
   *              but the result depends on input order and real bursts get
   *              split.
   *   'capped'   single linkage, but a merge is rejected if the merged group's
   *              diameter (max pairwise distance) would exceed `maxDiameter`.
   *              Recommended: keeps single linkage's recall, bounds the damage.
   *
   * @param {Array<{id:*, hash:string}>} items
   * @param {number} threshold max Hamming distance for an edge
   * @param {{linkage?:string, maxDiameter?:number}} [opts]
   * @returns {{groups:Array<Array<number>>, stats:object}} groups are arrays of
   *   indices into `items`; singletons included.
   */
  function cluster(items, threshold, opts) {
    opts = opts || {};
    var linkage = opts.linkage || 'capped';
    var maxDiameter = opts.maxDiameter != null ? opts.maxDiameter : Math.round(threshold * 2);
    var n = items.length;

    if (linkage === 'complete') return clusterComplete(items, threshold);

    // Precompute the edge list once (i<j, distance <= threshold), sorted by
    // distance so 'capped' merges the most-similar pairs first.
    var edges = [];
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var d = hamming(items[i].hash, items[j].hash);
        if (d <= threshold) edges.push([d, i, j]);
      }
    }
    edges.sort(function (a, b) { return a[0] - b[0]; });

    var parent = new Int32Array(n);
    for (var k = 0; k < n; k++) parent[k] = k;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }

    var members = [];
    for (var m = 0; m < n; m++) members.push([m]);

    var rejected = 0;
    for (var e = 0; e < edges.length; e++) {
      var ra = find(edges[e][1]), rb = find(edges[e][2]);
      if (ra === rb) continue;
      if (linkage === 'capped') {
        var diam = 0, A = members[ra], B = members[rb];
        outer:
        for (var p = 0; p < A.length; p++) {
          for (var q = 0; q < B.length; q++) {
            var dd = hamming(items[A[p]].hash, items[B[q]].hash);
            if (dd > diam) diam = dd;
            if (diam > maxDiameter) break outer;
          }
        }
        if (diam > maxDiameter) { rejected++; continue; }
      }
      parent[rb] = ra;
      members[ra] = members[ra].concat(members[rb]);
      members[rb] = null;
    }

    var groups = [];
    for (var g = 0; g < n; g++) if (find(g) === g && members[g]) groups.push(members[g].slice().sort(function (a, b) { return a - b; }));
    return { groups: groups, stats: { linkage: linkage, threshold: threshold, maxDiameter: maxDiameter, edges: edges.length, rejectedMerges: rejected } };
  }

  /** Greedy complete-linkage: join only if within threshold of every member. */
  function clusterComplete(items, threshold) {
    var groups = [];
    for (var i = 0; i < items.length; i++) {
      var placed = false;
      for (var g = 0; g < groups.length && !placed; g++) {
        var ok = true;
        for (var k = 0; k < groups[g].length; k++) {
          if (hamming(items[i].hash, items[groups[g][k]].hash) > threshold) { ok = false; break; }
        }
        if (ok) { groups[g].push(i); placed = true; }
      }
      if (!placed) groups.push([i]);
    }
    return { groups: groups, stats: { linkage: 'complete', threshold: threshold } };
  }

  /** Max pairwise Hamming distance inside a group of indices. */
  function groupDiameter(items, idx) {
    var d = 0;
    for (var i = 0; i < idx.length; i++) {
      for (var j = i + 1; j < idx.length; j++) {
        var v = hamming(items[idx[i]].hash, items[idx[j]].hash);
        if (v > d) d = v;
      }
    }
    return d;
  }

  // ---------------------------------------------------------------------------
  // Representative nomination (PRD §7.7)
  // ---------------------------------------------------------------------------

  /**
   * Nominate one representative for a near-duplicate group using sharpness and
   * resolution, per PRD §7.7. One click overrides; this only picks the default.
   *
   * Both terms are normalised within the group, so the score is a relative
   * ranking and never compares absolute values across groups:
   *
   *     score = wSharp * (sharpness / maxSharpness)
   *           + wRes   * (pixels    / maxPixels)
   *
   * Default weights 0.75/0.25: sharpness is the thing a human notices, but a
   * meaningfully larger file should break a near-tie in sharpness. Measured
   * accuracy on the probe corpus is in FINDINGS.md.
   *
   * @param {Array<{sharpness:number,width:number,height:number}>} members
   * @param {{sharpnessWeight?:number, resolutionWeight?:number}} [opts]
   * @returns {{index:number, scores:number[]}}
   */
  function nominateRepresentative(members, opts) {
    opts = opts || {};
    var ws = opts.sharpnessWeight != null ? opts.sharpnessWeight : 0.75;
    var wr = opts.resolutionWeight != null ? opts.resolutionWeight : 0.25;

    var maxS = 0, maxP = 0, i;
    for (i = 0; i < members.length; i++) {
      if (members[i].sharpness > maxS) maxS = members[i].sharpness;
      var px = members[i].width * members[i].height;
      if (px > maxP) maxP = px;
    }
    maxS = maxS || 1; maxP = maxP || 1;

    var scores = [], best = 0;
    for (i = 0; i < members.length; i++) {
      var s = ws * (members[i].sharpness / maxS) +
              wr * ((members[i].width * members[i].height) / maxP);
      scores.push(s);
      if (s > scores[best]) best = i;
    }
    return { index: best, scores: scores };
  }

  // ---------------------------------------------------------------------------

  global.PhotournamentHash = {
    // hashing
    hashImageData: hashImageData,
    dHashFromGrey9x8: dHashFromGrey9x8,
    pHashFromGrey32x32: pHashFromGrey32x32,
    toGrey: toGrey,
    downsampleGrey: downsampleGrey,
    // distance
    hamming: hamming,
    hammingBytes: hammingBytes,
    hexToBytes: hexToBytes,
    bytesToHex: bytesToHex,
    // grouping
    cluster: cluster,
    groupDiameter: groupDiameter,
    // representative
    sharpnessVarLap: sharpnessVarLap,
    nominateRepresentative: nominateRepresentative,
    // tuning constants, exposed for the §7.7 sensitivity slider
    DEFAULT_THRESHOLD: 10,
    SLIDER_RANGE: { min: 0, max: 20, defaultValue: 10, hash: 'phash' }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
