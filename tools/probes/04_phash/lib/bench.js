/**
 * bench.js — PROBE ONLY. Throughput benchmark for 500 images (PRD §7.9: the
 * hash is computed in the same ingest pass as the thumbnail, in a Worker).
 *
 * Measures the three costs separately, because they land in different places
 * in the ingest budget:
 *   1. decode JPEG -> ImageData          (already paid for by thumbnailing)
 *   2. hash from full-resolution pixels  (what a naive implementation does)
 *   3. hash from the 320px thumbnail     (what the app should do)
 *   4. pairwise Hamming over 500 hashes  (the §7.7 sensitivity slider redraw)
 *   5. clustering, per linkage rule
 *
 * Global: window.Bench
 */
(function (global) {
  'use strict';

  var SG = global.SceneGen, PH = global.PhotournamentHash;

  function now() { return performance.now(); }

  function toBlob(canvas, q) {
    return new Promise(function (r) { canvas.toBlob(r, 'image/jpeg', q); });
  }

  /** 500 distinct 1200x800 JPEGs: 20 renders x 25 cheap post-capture variants. */
  async function makeBlobs(n, w, h, onProgress) {
    var blobs = [], bases = [], nBases = 20;
    for (var b = 0; b < nBases; b++) {
      var c = SG.newCanvas(w, h);
      SG.renderScene(c, {
        seed: 900 + b * 17, camera: { panX: 0, panY: 0, zoom: 1 }, exposure: 1,
        grainSeed: 900 + b,
        subject: { x: 0.3 + (b % 5) * 0.1, y: 0.68, height: 0.6, expression: 'smile', shirt: '#b5453c', hair: '#3a2b22', skin: '#e0b48c' }
      });
      bases.push(c);
    }
    var i = 0;
    while (blobs.length < n) {
      var base = bases[i % nBases];
      var k = Math.floor(i / nBases);
      var v = SG.transform(base, { rotDeg: (k % 7) * 0.3, dx: (k % 5) * 2, dy: (k % 3) * 2, scale: 1 + (k % 4) * 0.01 });
      blobs.push(await toBlob(v, 0.9));
      v.width = v.height = 1;
      i++;
      if (onProgress && i % 50 === 0) onProgress(i, n);
    }
    bases.forEach(function (c) { c.width = c.height = 1; });
    return blobs;
  }

  async function decodeToCanvas(blob) {
    var bmp = await createImageBitmap(blob);
    var c = SG.newCanvas(bmp.width, bmp.height);
    c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0);
    bmp.close();
    return c;
  }

  function thumbOf(canvas, edge) {
    var w = canvas.width, h = canvas.height, tw, th;
    if (w >= h) { tw = Math.min(edge, w); th = Math.round(h * tw / w); }
    else { th = Math.min(edge, h); tw = Math.round(w * th / h); }
    var c = SG.newCanvas(tw, th);
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, tw, th);
    return c;
  }

  async function run(n, onProgress) {
    n = n || 500;
    var W = 1200, H = 800, EDGE = 320;
    var res = { n: n, sourceW: W, sourceH: H, thumbEdge: EDGE };

    var t0 = now();
    var blobs = await makeBlobs(n, W, H, onProgress);
    res.generateMs = now() - t0;
    res.avgBytes = Math.round(blobs.reduce(function (a, b) { return a + b.size; }, 0) / n);

    // --- pass 1: decode + full-res hash ------------------------------------
    var decodeMs = 0, fullHashMs = 0, thumbMakeMs = 0, thumbHashMs = 0;
    var thumbData = [], hashesFull = [], hashesThumb = [];
    for (var i = 0; i < n; i++) {
      var a = now();
      var canvas = await decodeToCanvas(blobs[i]);
      var idFull = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
      decodeMs += now() - a;

      a = now();
      var hf = PH.hashImageData(idFull);
      fullHashMs += now() - a;
      hashesFull.push(hf);

      a = now();
      var tc = thumbOf(canvas, EDGE);
      var idT = tc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, tc.width, tc.height);
      thumbMakeMs += now() - a;

      a = now();
      var ht = PH.hashImageData(idT);
      thumbHashMs += now() - a;
      hashesThumb.push(ht);

      if (i < 200) thumbData.push(idT);   // keep a subset for the hash-only loop
      canvas.width = canvas.height = 1; tc.width = tc.height = 1;
      if (onProgress && i % 50 === 0) onProgress(i, n, 'hash');
    }
    res.decodeMs = decodeMs;
    res.fullResHashMs = fullHashMs;
    res.thumbnailMs = thumbMakeMs;
    res.thumbHashMs = thumbHashMs;

    // hash-only, repeated, on the retained thumbnails (steady state, no decode)
    var reps = Math.ceil(n / thumbData.length);
    var a2 = now();
    for (var r = 0; r < reps; r++) for (var j = 0; j < thumbData.length; j++) PH.hashImageData(thumbData[j]);
    res.thumbHashOnlyMs = (now() - a2) / (reps * thumbData.length) * n;

    a2 = now();
    for (r = 0; r < reps; r++) for (j = 0; j < thumbData.length; j++) PH.hashImageData(thumbData[j], { sharpness: false });
    res.thumbHashNoSharpMs = (now() - a2) / (reps * thumbData.length) * n;

    // agreement between full-res and thumbnail hashing
    var agreeD = 0, agreeP = 0, dSum = 0, pSum = 0, dMax = 0, pMax = 0;
    for (i = 0; i < n; i++) {
      var dd = PH.hamming(hashesFull[i].dhash, hashesThumb[i].dhash);
      var pp = PH.hamming(hashesFull[i].phash, hashesThumb[i].phash);
      if (dd === 0) agreeD++; if (pp === 0) agreeP++;
      dSum += dd; pSum += pp; dMax = Math.max(dMax, dd); pMax = Math.max(pMax, pp);
    }
    res.fullVsThumb = {
      dhashIdentical: agreeD, phashIdentical: agreeP,
      dhashMean: dSum / n, phashMean: pSum / n, dhashMax: dMax, phashMax: pMax
    };

    // --- pairwise Hamming ---------------------------------------------------
    var items = hashesThumb.map(function (x, k) { return { id: k, hash: x.phash }; });
    a2 = now();
    var acc = 0;
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) acc += PH.hamming(items[i].hash, items[j].hash);
    res.pairwiseMs = now() - a2;
    res.pairCount = (n * (n - 1)) / 2;
    res.pairwiseChecksum = acc;

    // --- clustering ---------------------------------------------------------
    res.clusterMs = {};
    ['single', 'capped', 'complete'].forEach(function (linkage) {
      var s = now();
      var out = PH.cluster(items, 10, { linkage: linkage, maxDiameter: 20 });
      res.clusterMs[linkage] = { ms: now() - s, groups: out.groups.length };
    });

    return res;
  }

  global.Bench = { run: run };
})(window);
