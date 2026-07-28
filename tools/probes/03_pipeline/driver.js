/* Page-side test driver for the 03_pipeline probes.
   Everything here runs inside the file:// harness page; run_ingest.mjs calls
   into window.D.* over CDP. Kept separate from the harness HTML so the module
   under test is loaded exactly the way the real app will load it. */
(function () {
  'use strict';
  var D = (window.D = {});
  var LIBHEIF_REL = '../../../node_modules/libheif-js/libheif-wasm/libheif-bundle.js';

  D.libheifRel = LIBHEIF_REL;
  D.files = function () {
    return Array.prototype.slice.call(document.getElementById('picker').files);
  };

  D.makePool = function (o) {
    o = o || {};
    var opts = { size: o.size || 1 };
    if (o.inline) opts.libheifSrc = window.__libheifSrc;
    else opts.libheifUrl = LIBHEIF_REL;
    if (o.previewPx) opts.previewPx = o.previewPx;
    if (o.thumbPx) opts.thumbPx = o.thumbPx;
    if (o.lookup) opts.lookup = D.__lookup;
    D.pool = PT.ingest.createPool(opts);
    return { size: D.pool.size, libheifUrl: D.pool.libheifUrl, inline: D.pool.libheifInline };
  };

  D.__cache = Object.create(null);
  D.__lookupHits = 0;
  D.__lookup = function (id) {
    if (D.__cache[id]) { D.__lookupHits++; return D.__cache[id]; }
    return null;
  };
  D.seedCache = function (id, rec) { D.__cache[id] = rec; };
  D.lookupHits = function () { return D.__lookupHits; };

  function strip(r) {
    return {
      id: r.id, name: r.name, path: r.path, dir: r.dir, size: r.size, lastMod: r.lastMod,
      kind: r.kind, w: r.w, h: r.h,
      thumb: r.thumb ? r.thumb.size : null, thumbType: r.thumb ? r.thumb.type : null,
      preview: r.preview ? r.preview.size : null, previewType: r.preview ? r.preview.type : null,
      phash: r.phash, sharp: r.sharp, err: r.err,
      format: r.format, orientation: r.orientation, orientationApplied: r.orientationApplied,
      browserAppliesExif: r.browserAppliesExif, orientationSource: r.orientationSource,
      ms: r.ms, fromCache: r.fromCache || false
    };
  }
  D.strip = strip;

  // Records are kept whole (Blobs intact) so later calls can read pixels back.
  D.records = [];

  D.runAll = function (indices, meta) {
    var files = D.files();
    var list = indices || files.map(function (_, i) { return i; });
    D.records = [];
    return Promise.all(list.map(function (i) {
      var f = files[i];
      var m = (meta && meta[i]) || {};
      m.path = m.path || 'Trip/' + f.name;
      return D.pool.process(f, m);
    })).then(function (recs) {
      D.records = recs;
      return recs.map(strip);
    });
  };

  // Sequential, one at a time, N repetitions of the same file. Used for the
  // memory soak: nothing else is in flight so the heap trend is unambiguous.
  D.runSequential = function (fileIndex, n, checkpointEvery) {
    var f = D.files()[fileIndex];
    var i = 0;
    var out = { times: [], checkpoints: [] };
    function step() {
      if (i >= n) return Promise.resolve(out);
      return D.pool.process(f, { path: 'soak/' + i + '.heic' }).then(function (r) {
        out.times.push(r.ms || 0);
        if (r.err) out.firstErr = out.firstErr || r.err;
        out.lastPhash = r.phash;
        out.lastW = r.w; out.lastH = r.h;
        i++;
        if (i % checkpointEvery === 0 || i === 1) {
          return D.pool.diag().then(function (d) {
            out.checkpoints.push({
              n: i,
              wasmHeapBytes: d.map(function (x) { return x.wasmHeapBytes; }),
              jsHeap: performance.memory ? performance.memory.usedJSHeapSize : null
            });
            return step();
          });
        }
        return step();
      });
    }
    return step();
  };

  // ---- main-thread responsiveness -------------------------------------
  D.rafStart = function () {
    D.__raf = { deltas: [], stop: false, last: 0 };
    var tick = function (t) {
      if (D.__raf.last) D.__raf.deltas.push(t - D.__raf.last);
      D.__raf.last = t;
      if (!D.__raf.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  D.rafStop = function () {
    D.__raf.stop = true;
    var d = D.__raf.deltas.slice().sort(function (a, b) { return a - b; });
    if (!d.length) return null;
    var q = function (p) { return Math.round(d[Math.min(d.length - 1, Math.floor(d.length * p))] * 100) / 100; };
    return {
      frames: d.length,
      median: q(0.5), p95: q(0.95), p99: q(0.99),
      worst: Math.round(d[d.length - 1] * 100) / 100,
      over50ms: d.filter(function (x) { return x > 50; }).length,
      over100ms: d.filter(function (x) { return x > 100; }).length
    };
  };

  // Event-loop latency. Headless Chromium does not vsync-lock rAF, so rAF
  // deltas alone are a weak proxy for "the page stays responsive". A
  // MessageChannel ping-pong is a genuine macrotask: any main-thread block
  // shows up in it directly.
  D.latStart = function () {
    D.__lat = { samples: [], stop: false };
    var ch = new MessageChannel();
    var sent = 0;
    ch.port1.onmessage = function () {
      D.__lat.samples.push(performance.now() - sent);
      if (!D.__lat.stop) { sent = performance.now(); ch.port2.postMessage(0); }
    };
    sent = performance.now();
    ch.port2.postMessage(0);
  };
  D.latStop = function () {
    D.__lat.stop = true;
    var d = D.__lat.samples.slice().sort(function (a, b) { return a - b; });
    if (!d.length) return null;
    var q = function (p) { return Math.round(d[Math.min(d.length - 1, Math.floor(d.length * p))] * 100) / 100; };
    return {
      samples: d.length, median: q(0.5), p95: q(0.95), p99: q(0.99),
      worst: Math.round(d[d.length - 1] * 100) / 100,
      over16ms: d.filter(function (x) { return x > 16; }).length,
      over50ms: d.filter(function (x) { return x > 50; }).length
    };
  };

  // ---- pixel readback for orientation checks ---------------------------
  function bitmapPixels(blob, w, h) {
    return createImageBitmap(blob).then(function (bm) {
      var c = document.createElement('canvas');
      c.width = w || bm.width; c.height = h || bm.height;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bm, 0, 0, c.width, c.height);
      var d = ctx.getImageData(0, 0, c.width, c.height);
      bm.close();
      return { w: c.width, h: c.height, data: d.data };
    });
  }

  // Average colour of each corner quadrant of a record's thumbnail.
  D.corners = function (idx) {
    var r = D.records[idx];
    if (!r || !r.thumb) return Promise.resolve(null);
    return bitmapPixels(r.thumb).then(function (p) {
      var q = function (x0, y0) {
        var sx = Math.floor(p.w * 0.12), sy = Math.floor(p.h * 0.12);
        var ox = Math.floor(x0 * (p.w - sx)), oy = Math.floor(y0 * (p.h - sy));
        var s = [0, 0, 0], n = 0;
        for (var y = oy; y < oy + sy; y++) {
          for (var x = ox; x < ox + sx; x++) {
            var i = (y * p.w + x) * 4;
            s[0] += p.data[i]; s[1] += p.data[i + 1]; s[2] += p.data[i + 2]; n++;
          }
        }
        return [Math.round(s[0] / n), Math.round(s[1] / n), Math.round(s[2] / n)];
      };
      return { w: p.w, h: p.h, tl: q(0, 0), tr: q(1, 0), bl: q(0, 1), br: q(1, 1) };
    });
  };

  // Mean absolute RGB difference between record A's thumbnail and record B's,
  // under each of the four quarter-turn hypotheses. Grids are aspect-matched
  // (A at 64x48, B at 48x64 for the quarter turns) so a rotated image is not
  // penalised for being squashed into a square. The winning hypothesis is what
  // actually happened to the pixels, which is how "did libheif apply irot"
  // gets answered with evidence rather than assertion.
  D.compareRotations = function (a, b) {
    var ra = D.records[a], rb = D.records[b];
    var W = 64, Hh = 48;
    return Promise.all([
      bitmapPixels(ra.thumb, W, Hh),
      bitmapPixels(rb.thumb, W, Hh),
      bitmapPixels(rb.thumb, Hh, W)
    ]).then(function (p) {
      var A = p[0].data;
      function diff(B, bw, bh, map) {
        var sum = 0, n = 0;
        for (var y = 0; y < Hh; y++) {
          for (var x = 0; x < W; x++) {
            var m = map(x, y);
            if (m[0] < 0 || m[1] < 0 || m[0] >= bw || m[1] >= bh) continue;
            var ia = (y * W + x) * 4, ib = (m[1] * bw + m[0]) * 4;
            sum += Math.abs(A[ia] - B[ib]) + Math.abs(A[ia + 1] - B[ib + 1]) + Math.abs(A[ia + 2] - B[ib + 2]);
            n += 3;
          }
        }
        return n ? Math.round((sum / n) * 100) / 100 : null;
      }
      return {
        identity: diff(p[1].data, W, Hh, function (x, y) { return [x, y]; }),
        rot180: diff(p[1].data, W, Hh, function (x, y) { return [W - 1 - x, Hh - 1 - y]; }),
        rot90ccw: diff(p[2].data, Hh, W, function (x, y) { return [y, W - 1 - x]; }),
        rot90cw: diff(p[2].data, Hh, W, function (x, y) { return [Hh - 1 - y, x]; })
      };
    });
  };

  D.blobB64 = function (idx, which) {
    var r = D.records[idx];
    var b = r && r[which];
    if (!b) return Promise.resolve(null);
    return b.arrayBuffer().then(function (buf) {
      var u = new Uint8Array(buf), s = '';
      for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return btoa(s);
    });
  };

  D.fingerprintFile = function (i) { return PT.ingest.fingerprint(D.files()[i]); };
  D.stats = function () { return D.pool.stats(); };
  D.terminate = function () { D.pool.terminate(); };
  D.workerSrcLength = function () { return PT.ingest.WORKER_SRC.length; };

  // Generates the small mixed-format corpus. Done in-browser because nothing in
  // this environment can encode JPEG/WebP from Node.
  D.genImage = function (fmt, w, h, quality) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    // Corner-coded so orientation can be checked programmatically.
    ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, w, h);
    var cw = Math.floor(w * 0.3), ch = Math.floor(h * 0.3);
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = '#00c000'; ctx.fillRect(w - cw, 0, cw, ch);
    ctx.fillStyle = '#0000ff'; ctx.fillRect(0, h - ch, cw, ch);
    ctx.fillStyle = '#ffff00'; ctx.fillRect(w - cw, h - ch, cw, ch);
    ctx.fillStyle = '#000000';
    ctx.font = Math.floor(h * 0.4) + 'px sans-serif';
    ctx.fillText('F', Math.floor(w * 0.4), Math.floor(h * 0.6));
    // some high-frequency detail so sharpness scores are not degenerate
    for (var i = 0; i < 400; i++) {
      ctx.fillStyle = i % 2 ? '#fff' : '#111';
      ctx.fillRect((i * 37) % w, (i * 61) % h, 3, 3);
    }
    return new Promise(function (res) {
      c.toBlob(function (b) {
        b.arrayBuffer().then(function (buf) {
          var u = new Uint8Array(buf), s = '';
          for (var k = 0; k < u.length; k += 0x8000) s += String.fromCharCode.apply(null, u.subarray(k, k + 0x8000));
          res(btoa(s));
        });
      }, fmt, quality);
    });
  };
})();
