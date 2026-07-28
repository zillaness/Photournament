/**
 * bench.js — PROBE ONLY. Throughput of PT.phash.
 *
 *   1. dhash / phash / sharpness cost at the three pixel scales the app
 *      actually deals with: the 320px grid thumbnail, the 1600px matchup
 *      preview, and a full 12MP decode (matching probe 02's fixture, so the
 *      numbers compose with the HEIC ingest budget).
 *   2. hamming() throughput, since cluster() calls it O(n^2) times.
 *   3. cluster() wall time at 100 / 250 / 500 items in both modes.
 *
 * The pixel buffers here are synthetic noise-plus-structure, not corpus images:
 * hashing cost depends on pixel count, not on content.
 *
 * Global: window.Bench
 */
(function (global) {
  'use strict';

  function PH() { return global.PT.phash; }

  function makeImageData(w, h, seed) {
    var d = new Uint8ClampedArray(w * h * 4);
    var s = seed >>> 0;
    function rnd() {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    for (var y = 0, i = 0; y < h; y++) {
      for (var x = 0; x < w; x++, i += 4) {
        var base = 128 + 90 * Math.sin(x / (w / 9)) * Math.cos(y / (h / 7));
        var n = (rnd() - 0.5) * 40;
        d[i] = base + n; d[i + 1] = base * 0.9 + n; d[i + 2] = base * 0.8 + n; d[i + 3] = 255;
      }
    }
    return { width: w, height: h, data: d };
  }

  function timeIt(fn, reps) {
    fn(); // warm
    var t0 = performance.now();
    for (var i = 0; i < reps; i++) fn();
    var ms = performance.now() - t0;
    return +(ms / reps).toFixed(4);
  }

  function hashThroughput() {
    var ph = PH();
    var sizes = [
      { name: '320px thumbnail', w: 320, h: 240, reps: 200 },
      { name: '1600px preview', w: 1600, h: 1200, reps: 20 },
      { name: '12MP full decode', w: 3992, h: 2992, reps: 4 }
    ];
    return sizes.map(function (s) {
      var img = makeImageData(s.w, s.h, 1234 + s.w);
      var d = timeIt(function () { ph.dhash(img); }, s.reps);
      var p = timeIt(function () { ph.phash(img); }, s.reps);
      var sh = timeIt(function () { ph.sharpness(img); }, s.reps);
      return {
        name: s.name, w: s.w, h: s.h, mp: +(s.w * s.h / 1e6).toFixed(2), reps: s.reps,
        dhashMs: d, phashMs: p, sharpMs: sh, bothHashesMs: +(d + p).toFixed(4),
        allThreeMs: +(d + p + sh).toFixed(4)
      };
    });
  }

  function hammingThroughput(hashes) {
    var ph = PH();
    var n = hashes.length;
    var reps = 2000000;
    var acc = 0;
    var t0 = performance.now();
    for (var i = 0; i < reps; i++) {
      acc += ph.hamming(hashes[i % n], hashes[(i * 7 + 3) % n]);
    }
    var ms = performance.now() - t0;
    return {
      calls: reps, totalMs: +ms.toFixed(1),
      nsPerCall: +((ms * 1e6) / reps).toFixed(1),
      millionPerSec: +((reps / ms) / 1000).toFixed(2),
      checksum: acc
    };
  }

  /**
   * Realistic clustering input: `groups` families of `perGroup` frames, each
   * family a random base hash with 0..noise bits flipped, plus enough
   * unrelated singletons to reach n.
   */
  function synthHashes(n, seed) {
    var s = seed >>> 0;
    function rnd() {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function randBits() {
      var b = new Uint8Array(8);
      for (var i = 0; i < 8; i++) b[i] = Math.floor(rnd() * 256);
      return b;
    }
    function hex(b) {
      var out = '';
      for (var i = 0; i < 8; i++) out += ('0' + b[i].toString(16)).slice(-2);
      return out;
    }
    var items = [];
    var perGroup = 4, noise = 6;
    var made = 0, g = 0;
    while (made < n) {
      var base = randBits();
      var size = Math.min(perGroup, n - made);
      for (var k = 0; k < size; k++) {
        var v = base.slice();
        var flips = Math.floor(rnd() * (noise + 1));
        for (var f = 0; f < flips; f++) {
          var bit = Math.floor(rnd() * 64);
          v[bit >> 3] ^= 0x80 >> (bit & 7);
        }
        items.push({
          id: 'img_' + ('0000' + made).slice(-4), hash: hex(v),
          w: 4000, h: 3000, sharp: rnd() * 10
        });
        made++;
      }
      g++;
    }
    return items;
  }

  /** Degenerate inputs: one giant group, and no group at all. */
  function edgeItems(n, kind) {
    var items = [];
    for (var i = 0; i < n; i++) {
      var hx;
      if (kind === 'allIdentical') hx = '0f1e2d3c4b5a6978';
      else {
        // spread out: every hash far from every other
        var b = new Uint8Array(8);
        for (var k = 0; k < 8; k++) b[k] = (i * 37 + k * 61 + (k === 0 ? i * 13 : 0)) & 255;
        hx = '';
        for (var m = 0; m < 8; m++) hx += ('0' + b[m].toString(16)).slice(-2);
      }
      items.push({ id: 'img_' + ('0000' + i).slice(-4), hash: hx, w: 4000, h: 3000, sharp: i });
    }
    return items;
  }

  function clusterEdgeCost() {
    var ph = PH();
    var out = [];
    ['allIdentical', 'allDistinct'].forEach(function (kind) {
      var items = edgeItems(500, kind);
      ['union', 'strict'].forEach(function (mode) {
        var groups = null;
        var t0 = performance.now();
        for (var i = 0; i < 5; i++) groups = ph.cluster(items, { threshold: 14, mode: mode });
        out.push({
          kind: kind, n: 500, mode: mode,
          ms: +((performance.now() - t0) / 5).toFixed(2),
          groups: groups.length,
          largest: groups.reduce(function (m, g) { return Math.max(m, g.length); }, 0)
        });
      });
    });
    return out;
  }

  function clusterCost() {
    var ph = PH();
    var out = [];
    [100, 250, 500].forEach(function (n) {
      var items = synthHashes(n, 99 + n);
      ['union', 'strict'].forEach(function (mode) {
        var t0 = performance.now();
        var groups = null;
        var reps = n >= 500 ? 5 : 20;
        for (var i = 0; i < reps; i++) groups = ph.cluster(items, { threshold: 12, mode: mode });
        var ms = (performance.now() - t0) / reps;
        out.push({
          n: n, mode: mode, ms: +ms.toFixed(2), reps: reps,
          groups: groups.length,
          nonSingleton: groups.filter(function (g) { return g.length > 1; }).length,
          pairs: (n * (n - 1)) / 2
        });
      });
    });
    return out;
  }

  function nominateCost() {
    var ph = PH();
    var members = [];
    for (var i = 0; i < 8; i++) {
      members.push({ id: 'm' + i, w: 4000, h: 3000, sharp: Math.random() * 5 });
    }
    return { ms: timeIt(function () { ph.nominate(members); }, 20000), size: 8 };
  }

  function run(corpusHashes) {
    return {
      hash: hashThroughput(),
      hamming: hammingThroughput(corpusHashes),
      cluster: clusterCost(),
      clusterEdge: clusterEdgeCost(),
      nominate: nominateCost(),
      hardwareConcurrency: navigator.hardwareConcurrency || null
    };
  }

  global.Bench = { run: run, synthHashes: synthHashes, makeImageData: makeImageData };
})(window);
