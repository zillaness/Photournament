/**
 * @file 20_phash.js
 * @version 1.0
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description Perceptual hashing, sharpness scoring, near-duplicate clustering and representative nomination for PRD 7.7.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 */

/* eslint-disable no-bitwise */
(function (global) {
  'use strict';

  global.PT = global.PT || {};
  var PT = global.PT;

  // ---------------------------------------------------------------------------
  // Tuning constants — every number here is measured, see
  // tools/probes/04_phash/FINDINGS.md
  // ---------------------------------------------------------------------------

  /**
   * Recommended Hamming distance for "these are the same shot", calibrated for
   * phash() (see RECOMMENDED_HASH).
   *
   * Measured on a 122-frame corpus, 7,381 labelled pairs: pHash + strict at 14
   * scored precision 1.000 and recall 1.000 — every burst, expression variant,
   * re-encode and minor crop/rotation grouped, and not one unrelated pair did.
   * The first false positive appears at 16; the first false negative at 13.
   * Full sweep in tools/probes/04_phash/FINDINGS.md.
   *
   * dHash needs a different number. Its clean band is 8-10, and it has no
   * threshold that separates the two populations completely.
   */
  var DEFAULT_THRESHOLD = 14;

  /**
   * Useful span for the PRD 7.7 sensitivity slider. Below 4 only re-encodes of
   * the same file group; above 20 pHash precision falls under 0.75 and the user
   * spends more time splitting groups than the grouping saves.
   *
   * pHash is a constant-weight code (every hash has exactly 31 one-bits), so
   * every pHash distance is EVEN and odd thresholds behave identically to the
   * even one below. Step the slider by 2.
   */
  var THRESHOLD_RANGE = [4, 20];

  /** Default linkage for cluster(). See FINDINGS.md section 6. */
  var DEFAULT_MODE = 'strict';

  /**
   * Which hash to cluster on. pHash beat dHash on every measure that matters:
   * complete separation of positives from negatives, 27 non-transitive triples
   * against dHash's 356, and a precision curve that stays at 1.000 while recall
   * climbs monotonically, so the sensitivity slider behaves predictably.
   * dhash() stays exported: it is 1.2x cheaper and useful as a fast pre-filter.
   */
  var RECOMMENDED_HASH = 'phash';

  var DHASH_W = 9;   // 9x8 grey -> 8 rows x 8 horizontal comparisons = 64 bits
  var DHASH_H = 8;
  var PHASH_N = 32;  // DCT input edge
  var PHASH_K = 8;   // low-frequency block kept
  var SHARP_EDGE = 256; // grey plane long edge the sharpness metric works on

  /** Nomination weights. Sharpness dominates; resolution breaks near-ties. */
  var NOMINATE_SHARP_WEIGHT = 0.70;
  var NOMINATE_RES_WEIGHT = 0.30;

  // ---------------------------------------------------------------------------
  // Lookup tables
  // ---------------------------------------------------------------------------

  var HEXCHARS = '0123456789abcdef';

  /** hex char code -> nibble, -1 for anything else. */
  var HEXVAL = (function () {
    var t = new Int8Array(128);
    for (var i = 0; i < 128; i++) t[i] = -1;
    for (var d = 0; d < 10; d++) t[48 + d] = d;
    for (var a = 0; a < 6; a++) { t[97 + a] = 10 + a; t[65 + a] = 10 + a; }
    return t;
  })();

  /**
   * Separable DCT-II basis, orthonormally scaled:
   * DCT_COS[u*N + x] = s(u) * cos((2x+1) * u * PI / (2N))
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

  // Scratch buffers. A worker is single threaded and the app hashes one image
  // at a time, so reusing these is safe and saves ~9KB of allocation per image.
  var _dctTmp = new Float64Array(PHASH_N * PHASH_N);
  var _dctLow = new Float64Array(PHASH_K * PHASH_K);
  var _medBuf = new Float64Array(PHASH_K * PHASH_K);

  // ---------------------------------------------------------------------------
  // Pixel helpers
  // ---------------------------------------------------------------------------

  function isImageData(img) {
    return !!img && typeof img.width === 'number' && typeof img.height === 'number' &&
      img.data && typeof img.data.length === 'number' &&
      img.data.length >= img.width * img.height * 4;
  }

  function assertImageData(img, who) {
    if (!isImageData(img)) throw new TypeError('PT.phash.' + who + ': expected an ImageData-like {width,height,data}');
    if (img.width < 1 || img.height < 1) throw new TypeError('PT.phash.' + who + ': empty ImageData');
  }

  /**
   * Rec.601 luma, 0..255, as Float32. Alpha is ignored on purpose: photos are
   * opaque, and compositing onto an assumed background would make the hash
   * depend on something the user never sees.
   * @param {ImageData} img
   * @returns {Float32Array}
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
   * Box averaging rather than point sampling matters a lot here: point-sampling
   * a 1200px frame down to 32px aliases high-frequency texture into the hash,
   * and two frames of the same burst alias differently, which shows up directly
   * as burst-pair distance.
   *
   * Implemented as a scatter: one sequential pass over the source accumulating
   * into output buckets. The obvious gather form (walk the output, sum the
   * source box) is 3.5x slower at 9x8 output on a 1600px source, because each
   * output cell strides across ~1MB of source and the next cell walks the same
   * rows again. Measured, not assumed — see FINDINGS.md section 7.
   *
   * @param {Float32Array} src
   * @param {number} w source width
   * @param {number} h source height
   * @param {number} ow target width
   * @param {number} oh target height
   * @returns {Float32Array}
   */
  function downsampleGrey(src, w, h, ow, oh) {
    var out = new Float32Array(ow * oh);
    var x, y;

    // Upsampling has no box to average, so fall back to nearest-neighbour.
    if (ow > w || oh > h) {
      for (y = 0; y < oh; y++) {
        var sy = Math.min(h - 1, Math.floor((y * h) / oh));
        for (x = 0; x < ow; x++) {
          out[y * ow + x] = src[sy * w + Math.min(w - 1, Math.floor((x * w) / ow))];
        }
      }
      return out;
    }

    // Column and row bucket maps, plus how many source pixels land in each.
    // Both maps are monotonically non-decreasing, which is what lets the inner
    // loop accumulate in a register and only touch memory at a bucket boundary.
    var colBucket = new Int32Array(w);
    var colCount = new Int32Array(ow);
    for (x = 0; x < w; x++) {
      var cb = Math.min(ow - 1, Math.floor((x * ow) / w));
      colBucket[x] = cb;
      colCount[cb]++;
    }
    var rowCount = new Int32Array(oh);
    for (y = 0; y < h; y++) rowCount[Math.min(oh - 1, Math.floor((y * oh) / h))]++;

    for (y = 0; y < h; y++) {
      var orow = Math.min(oh - 1, Math.floor((y * oh) / h)) * ow;
      var srow = y * w;
      var sum = 0;
      var bucket = 0;
      for (x = 0; x < w; x++) {
        var b = colBucket[x];
        if (b !== bucket) { out[orow + bucket] += sum; sum = 0; bucket = b; }
        sum += src[srow + x];
      }
      out[orow + bucket] += sum;
    }

    for (var oy2 = 0; oy2 < oh; oy2++) {
      for (var ox2 = 0; ox2 < ow; ox2++) {
        var n = colCount[ox2] * rowCount[oy2];
        if (n) out[oy2 * ow + ox2] /= n;
      }
    }
    return out;
  }

  function bytesToHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      s += HEXCHARS[bytes[i] >> 4] + HEXCHARS[bytes[i] & 15];
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // dHash
  // ---------------------------------------------------------------------------

  /**
   * 64-bit difference hash. 9x8 greyscale box-downsample, one bit per
   * horizontal adjacent-pixel comparison. All 64 bits are informative.
   *
   * Cheap, and immune to any monotonic exposure change because it only ever
   * compares neighbours inside the same frame.
   *
   * @param {ImageData} imageData RGBA pixels
   * @returns {string} 16 lowercase hex chars
   */
  function dhash(imageData) {
    assertImageData(imageData, 'dhash');
    var g = downsampleGrey(toGrey(imageData), imageData.width, imageData.height, DHASH_W, DHASH_H);
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

  /**
   * 64-bit DCT hash. 32x32 greyscale box-downsample, separable 2-D DCT-II, the
   * top-left 8x8 low-frequency block thresholded at the median of its 63
   * non-DC coefficients.
   *
   * The DC bit is forced to 0: DC is always the largest coefficient, so its bit
   * would be a constant 1 and would carry no information while inflating every
   * distance by nothing. So the hash is 64 bits wide with 63 informative bits.
   *
   * @param {ImageData} imageData RGBA pixels
   * @returns {string} 16 lowercase hex chars
   */
  function phash(imageData) {
    assertImageData(imageData, 'phash');
    var g = downsampleGrey(toGrey(imageData), imageData.width, imageData.height, PHASH_N, PHASH_N);
    var N = PHASH_N, u, x, y, v, sum;

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
    // Columns, but only the 8 rows that survive into the hash.
    for (v = 0; v < PHASH_K; v++) {
      var cv = v * N;
      for (u = 0; u < PHASH_K; u++) {
        sum = 0;
        for (y = 0; y < N; y++) sum += _dctTmp[y * N + u] * DCT_COS[cv + y];
        _dctLow[v * PHASH_K + u] = sum;
      }
    }

    var m = 0;
    for (v = 0; v < PHASH_K; v++) {
      for (u = 0; u < PHASH_K; u++) {
        if (v === 0 && u === 0) continue;
        _medBuf[m++] = _dctLow[v * PHASH_K + u];
      }
    }
    var med = medianOf(_medBuf, m);

    var bytes = new Uint8Array(8);
    var bit = 0;
    for (v = 0; v < PHASH_K; v++) {
      for (u = 0; u < PHASH_K; u++, bit++) {
        if (v === 0 && u === 0) continue;               // DC bit stays 0
        if (_dctLow[v * PHASH_K + u] > med) bytes[bit >> 3] |= 0x80 >> (bit & 7);
      }
    }
    return bytesToHex(bytes);
  }

  /** Median of the first n entries of buf. Copies; buf is untouched. */
  function medianOf(buf, n) {
    var a = new Array(n);
    for (var i = 0; i < n; i++) a[i] = buf[i];
    a.sort(function (p, q) { return p - q; });
    return (n & 1) ? a[(n - 1) >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
  }

  // ---------------------------------------------------------------------------
  // Hamming distance
  // ---------------------------------------------------------------------------

  /** Population count of a 32-bit word, no table lookup. */
  function popcnt32(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return (x * 0x01010101) >>> 24;
  }

  /** Parse 8 hex chars starting at off into an unsigned 32-bit word. */
  function hexWord(s, off) {
    var w = 0;
    for (var i = off; i < off + 8; i++) {
      var v = HEXVAL[s.charCodeAt(i) & 127];
      if (v < 0) throw new TypeError('PT.phash.hamming: not a hex hash: ' + s);
      w = (w << 4) | v;
    }
    return w >>> 0;
  }

  /**
   * Hamming distance between two 16-char hex hashes, 0..64.
   *
   * Called O(n^2) times by cluster(), so it does no allocation: two manual
   * 8-char hex parses and two branchless popcounts. Measured throughput is in
   * FINDINGS.md section 7.
   *
   * @param {string} hexA
   * @param {string} hexB
   * @returns {number} 0..64
   */
  function hamming(hexA, hexB) {
    if (typeof hexA !== 'string' || typeof hexB !== 'string') {
      throw new TypeError('PT.phash.hamming: expected two hex strings');
    }
    if (hexA.length !== 16 || hexB.length !== 16) {
      throw new TypeError('PT.phash.hamming: expected 16-char hashes, got ' + hexA.length + '/' + hexB.length);
    }
    return popcnt32(hexWord(hexA, 0) ^ hexWord(hexB, 0)) +
           popcnt32(hexWord(hexA, 8) ^ hexWord(hexB, 8));
  }

  // ---------------------------------------------------------------------------
  // Sharpness
  // ---------------------------------------------------------------------------

  /**
   * Contrast-normalised variance of the 4-neighbour Laplacian, measured on a
   * fixed 256px-long-edge greyscale plane. Higher is sharper.
   *
   * Raw variance-of-Laplacian is the textbook blur metric but it is not
   * comparable between the images that actually land in one near-duplicate
   * group. It scales with resolution (more pixels per edge means a smaller
   * per-pixel second derivative) and with scene contrast (a bright high-contrast
   * frame beats a flat one regardless of focus). A group routinely mixes a
   * 12MP original with a downscaled re-export, so both corrections are needed:
   *
   *   1. resample to a fixed long edge, so resolution does not set the scale
   *   2. divide by the variance of the grey plane, so contrast does not either
   *
   * What is left is edge energy per unit contrast. Resolution then re-enters
   * the decision deliberately and separately, as a weighted term in nominate().
   *
   * @param {ImageData} imageData RGBA pixels
   * @returns {number} >= 0, higher is sharper
   */
  function sharpness(imageData) {
    assertImageData(imageData, 'sharpness');
    var w = imageData.width, h = imageData.height;
    var grey = toGrey(imageData);

    var sw, sh;
    if (w >= h) { sw = Math.min(SHARP_EDGE, w); sh = Math.max(1, Math.round((h / w) * sw)); }
    else { sh = Math.min(SHARP_EDGE, h); sw = Math.max(1, Math.round((w / h) * sh)); }
    var g = (sw === w && sh === h) ? grey : downsampleGrey(grey, w, h, sw, sh);

    if (sw < 3 || sh < 3) return 0;

    var lapSum = 0, lapSq = 0, n = 0;
    for (var y = 1; y < sh - 1; y++) {
      var r = y * sw;
      for (var x = 1; x < sw - 1; x++) {
        var i = r + x;
        var lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - sw] - g[i + sw];
        lapSum += lap; lapSq += lap * lap; n++;
      }
    }
    if (n === 0) return 0;
    var lapMean = lapSum / n;
    var lapVar = lapSq / n - lapMean * lapMean;

    var gSum = 0, gSq = 0, m = sw * sh;
    for (var k = 0; k < m; k++) { gSum += g[k]; gSq += g[k] * g[k]; }
    var gMean = gSum / m;
    var gVar = gSq / m - gMean * gMean;

    var s = lapVar / Math.max(gVar, 1e-6);
    return s > 0 ? s : 0;
  }

  // ---------------------------------------------------------------------------
  // Clustering
  // ---------------------------------------------------------------------------

  function byId(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  /**
   * Group near-duplicates by Hamming distance.
   *
   * Perceptual hashes are not transitive: A~B and B~C does not imply A~C. The
   * linkage rule is therefore a product decision, not an implementation detail,
   * and it is exposed as `mode`:
   *
   *   "union"  single linkage / union-find. Any single edge merges two groups.
   *            Maximum recall, but chaining is not a corner case: at the
   *            default threshold of 14 the probe corpus produced a group whose
   *            own diameter was 26 — members nearly twice the threshold apart,
   *            in a group the user is told is a set of duplicates.
   *   "strict" complete linkage. A photo joins a group only if it is within
   *            `threshold` of EVERY current member, so a group's diameter can
   *            never exceed the threshold and the slider means exactly what it
   *            says. This is the default; see FINDINGS.md section 6.
   *
   * Determinism: items are processed in sorted-id order and a joining photo
   * picks the group whose worst-case distance is smallest, so the result never
   * depends on ingest order. Groups come back sorted by their smallest member
   * id, ids sorted within each group, singletons included.
   *
   * @param {Array<{id:string, hash:string, w?:number, h?:number, sharp?:number}>} items
   * @param {{threshold?:number, mode?:"union"|"strict"}} [opts]
   * @returns {Array<Array<string>>} groups of ids
   */
  function cluster(items, opts) {
    if (!items || !items.length) return [];
    opts = opts || {};
    var threshold = opts.threshold == null ? DEFAULT_THRESHOLD : opts.threshold;
    var mode = opts.mode || DEFAULT_MODE;
    if (mode !== 'union' && mode !== 'strict') {
      throw new TypeError('PT.phash.cluster: mode must be "union" or "strict", got ' + mode);
    }

    // Sorted-id order is what makes both modes order-independent.
    var order = items.slice().sort(function (a, b) { return byId(a.id, b.id); });
    var n = order.length;

    // Decode every hash once into two 32-bit words. This is the whole reason
    // cluster() at 500 items is cheap: the O(n^2) inner loop never touches a
    // string.
    var hi = new Int32Array(n), lo = new Int32Array(n);
    for (var i = 0; i < n; i++) {
      var hx = order[i].hash;
      if (typeof hx !== 'string' || hx.length !== 16) {
        throw new TypeError('PT.phash.cluster: item ' + order[i].id + ' has no 16-char hash');
      }
      hi[i] = hexWord(hx, 0) | 0;
      lo[i] = hexWord(hx, 8) | 0;
    }
    function dist(a, b) {
      return popcnt32(hi[a] ^ hi[b]) + popcnt32(lo[a] ^ lo[b]);
    }

    var groups;
    if (mode === 'union') {
      var parent = new Int32Array(n);
      for (var p = 0; p < n; p++) parent[p] = p;
      var find = function (a) {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
      };
      for (var a1 = 0; a1 < n; a1++) {
        for (var b1 = a1 + 1; b1 < n; b1++) {
          if (dist(a1, b1) <= threshold) {
            var ra = find(a1), rb = find(b1);
            if (ra !== rb) parent[rb] = ra;
          }
        }
      }
      var buckets = {};
      for (var k = 0; k < n; k++) {
        var root = find(k);
        (buckets[root] || (buckets[root] = [])).push(k);
      }
      groups = [];
      for (var key in buckets) if (Object.prototype.hasOwnProperty.call(buckets, key)) groups.push(buckets[key]);
    } else {
      // Complete linkage, greedy in sorted-id order, best-fit rather than
      // first-fit so the outcome does not depend on which group happened to be
      // created first.
      groups = [];
      for (var idx = 0; idx < n; idx++) {
        var bestG = -1, bestWorst = Infinity;
        for (var g = 0; g < groups.length; g++) {
          var worst = 0, ok = true;
          for (var m2 = 0; m2 < groups[g].length; m2++) {
            var d = dist(idx, groups[g][m2]);
            if (d > threshold) { ok = false; break; }
            if (d > worst) worst = d;
          }
          if (ok && worst < bestWorst) { bestWorst = worst; bestG = g; }
        }
        if (bestG >= 0) groups[bestG].push(idx);
        else groups.push([idx]);
      }
    }

    var out = groups.map(function (grp) {
      return grp.map(function (ix) { return order[ix].id; }).sort(byId);
    });
    out.sort(function (x, y) { return byId(x[0], y[0]); });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Representative nomination (PRD 7.7)
  // ---------------------------------------------------------------------------

  /**
   * Pick the representative of a near-duplicate group, per PRD 7.7's
   * "sharpness and resolution heuristic". One click overrides this in the UI,
   * so the job is to be right most of the time, not to be right always.
   *
   * Both terms are normalised inside the group, so the score is a ranking
   * within that group and never compares absolute values across groups:
   *
   *   score = 0.70 * (sharp / maxSharp) + 0.30 * (pixels / maxPixels)
   *
   * Sharpness carries most of the weight because blur is what a human actually
   * notices. Resolution carries the rest for margin: sharpness() is deliberately
   * resolution-invariant, so a downscaled crisp re-export lands within 3-13% of
   * the full-size original it came from, and 3% is inside the noise of JPEG
   * quality and scene content. The resolution term turns that into a decisive
   * 0.25 gap. On one earlier corpus, weighting sharpness alone picked the
   * 480px copy over its 1200px source in 4 of 42 trials. FINDINGS.md section 8
   * has the numbers and the crossover table.
   *
   * Ties break on the smallest id, so the nomination is stable across runs.
   *
   * @param {Array<{id:string, w?:number, h?:number, sharp?:number}>} members
   * @returns {string} the winning id
   */
  function nominate(members) {
    if (!members || !members.length) throw new TypeError('PT.phash.nominate: empty group');
    if (members.length === 1) return members[0].id;

    var maxS = 0, maxP = 0, i, px;
    for (i = 0; i < members.length; i++) {
      var s = +members[i].sharp;
      if (isFinite(s) && s > maxS) maxS = s;
      px = (+members[i].w || 0) * (+members[i].h || 0);
      if (px > maxP) maxP = px;
    }
    if (!(maxS > 0)) maxS = 1;
    if (!(maxP > 0)) maxP = 1;

    var bestId = null, bestScore = -Infinity;
    for (i = 0; i < members.length; i++) {
      var sv = +members[i].sharp;
      if (!isFinite(sv) || sv < 0) sv = 0;
      px = (+members[i].w || 0) * (+members[i].h || 0);
      var score = NOMINATE_SHARP_WEIGHT * (sv / maxS) + NOMINATE_RES_WEIGHT * (px / maxP);
      if (score > bestScore || (score === bestScore && byId(members[i].id, bestId) < 0)) {
        bestScore = score;
        bestId = members[i].id;
      }
    }
    return bestId;
  }

  // ---------------------------------------------------------------------------

  PT.phash = {
    dhash: dhash,
    phash: phash,
    hamming: hamming,
    sharpness: sharpness,
    cluster: cluster,
    nominate: nominate,
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
    THRESHOLD_RANGE: THRESHOLD_RANGE,
    DEFAULT_MODE: DEFAULT_MODE,
    RECOMMENDED_HASH: RECOMMENDED_HASH,
    // internals, exposed for the probe harness and for anything that already
    // holds a greyscale plane
    _internal: {
      toGrey: toGrey,
      downsampleGrey: downsampleGrey,
      bytesToHex: bytesToHex,
      popcnt32: popcnt32,
      NOMINATE_SHARP_WEIGHT: NOMINATE_SHARP_WEIGHT,
      NOMINATE_RES_WEIGHT: NOMINATE_RES_WEIGHT,
      SHARP_EDGE: SHARP_EDGE
    }
  };

  if (typeof PT.log === 'function') PT.log('phash', 'ready, default threshold', DEFAULT_THRESHOLD, DEFAULT_MODE);
})(typeof window !== 'undefined' ? window : self);

/*
 * CHANGELOG
 * ---------
 * v1.0 (2026-07-28) — Initial release. dHash (9x8 difference) and pHash
 *   (32x32 DCT-II, 8x8 low-frequency block, median threshold, DC bit zeroed),
 *   allocation-free 32-bit Hamming distance, contrast-normalised
 *   variance-of-Laplacian sharpness at a fixed 256px long edge, union and
 *   strict linkage clustering with deterministic ordering, and weighted
 *   sharpness+resolution representative nomination. Thresholds and weights set
 *   from the measurements in tools/probes/04_phash/FINDINGS.md.
 */
