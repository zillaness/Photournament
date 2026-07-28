/**
 * scenegen.js — PROBE ONLY. Deterministic synthetic "photographs" for the
 * near-duplicate corpus. Not app code.
 *
 * The probe has no network access, so there are no real photographs available.
 * These renders aim for photo-like *statistics* rather than photo-like looks:
 * multi-octave fractal noise terrain (1/f-ish spectrum, like real scenes),
 * mid-frequency clutter (foliage, windows), a subject figure with a real face,
 * per-frame sensor grain, and a vignette. Everything is seeded, so re-rendering
 * with one parameter changed produces a frame that differs only where the real
 * world would have differed — which is the whole point for burst simulation.
 *
 * Global: window.SceneGen
 */
(function (global) {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Value noise with bilinear interpolation, seeded. */
  function valueNoise2D(seed, gw, gh) {
    var rnd = mulberry32(seed);
    var g = new Float32Array(gw * gh);
    for (var i = 0; i < g.length; i++) g[i] = rnd();
    return function (x, y) { // x,y in [0,1)
      var fx = x * (gw - 1), fy = y * (gh - 1);
      var x0 = Math.floor(fx), y0 = Math.floor(fy);
      var x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
      var tx = fx - x0, ty = fy - y0;
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      var a = g[y0 * gw + x0], b = g[y0 * gw + x1], c = g[y1 * gw + x0], d = g[y1 * gw + x1];
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    };
  }

  function fbm(seed, octaves) {
    var layers = [];
    for (var o = 0; o < octaves; o++) layers.push(valueNoise2D(seed + o * 7919, 4 + o * 6, 4 + o * 6));
    return function (x, y) {
      var sum = 0, amp = 1, norm = 0;
      for (var o = 0; o < layers.length; o++) {
        sum += amp * layers[o](x, y); norm += amp; amp *= 0.55;
      }
      return sum / norm;
    };
  }

  var PALETTES = [
    { sky: ['#8fbfe8', '#dbe9f4'], land: ['#5b7d3a', '#93a75c', '#c8b27a'], accent: '#3c5228' }, // meadow
    { sky: ['#f2b56b', '#f7e0b8'], land: ['#7a5233', '#a97b45', '#d9b382'], accent: '#4a2f1c' }, // desert dusk
    { sky: ['#5d7fa8', '#b8c9d8'], land: ['#3f4a52', '#6d7a82', '#a2adb3'], accent: '#242b30' }, // overcast city
    { sky: ['#243b55', '#6b7f96'], land: ['#1b2a33', '#33505c', '#628193'], accent: '#0e1519' }, // blue hour
    { sky: ['#9fd6d2', '#e6f5f2'], land: ['#2f6f66', '#57998c', '#9dc4b4'], accent: '#1c443e' }, // coast
    { sky: ['#c9a3b8', '#f0dbe3'], land: ['#6b4a5c', '#9a7186', '#c9a5b2'], accent: '#3a2430' }  // pink dusk
  ];

  function lerpColor(c1, c2, t) {
    function hx(c) { return [parseInt(c.substr(1, 2), 16), parseInt(c.substr(3, 2), 16), parseInt(c.substr(5, 2), 16)]; }
    var a = hx(c1), b = hx(c2);
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' + Math.round(a[1] + (b[1] - a[1]) * t) + ',' + Math.round(a[2] + (b[2] - a[2]) * t) + ')';
  }

  /**
   * @param {object} p
   *   seed          scene identity: terrain, palette, clutter placement
   *   w,h           pixel size
   *   subject       {x, y, height, expression, headTurn, armRaise, shirt}
   *                 x,y are fractions of the frame; height is the figure height
   *                 as a fraction of frame height (>1 = portrait crop framing)
   *   camera        {panX, panY, zoom} fractions — reframing, applied at render
   *   grainSeed     per-frame sensor noise seed
   *   exposure      multiplier applied to every drawn colour (1.0 = base)
   */
  function renderScene(canvas, p) {
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    var rnd = mulberry32(p.seed);
    var pal = PALETTES[p.seed % PALETTES.length];
    var cam = p.camera || { panX: 0, panY: 0, zoom: 1 };
    var exposure = p.exposure == null ? 1 : p.exposure;

    ctx.save();
    // Camera: zoom about centre, then pan. Everything below draws in scene space.
    ctx.translate(w / 2, h / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-w / 2 - cam.panX * w, -h / 2 - cam.panY * h);

    var horizon = 0.42 + rnd() * 0.2;

    // --- sky ------------------------------------------------------------
    var sky = ctx.createLinearGradient(0, -h, 0, horizon * h);
    sky.addColorStop(0, pal.sky[0]); sky.addColorStop(1, pal.sky[1]);
    ctx.fillStyle = sky;
    ctx.fillRect(-w, -h, 3 * w, horizon * h + h);

    // clouds: soft fbm blobs
    var cloudN = 3 + Math.floor(rnd() * 5);
    for (var c = 0; c < cloudN; c++) {
      var cx = rnd() * w * 1.4 - 0.2 * w, cy = rnd() * horizon * h * 0.8;
      var cr = (0.05 + rnd() * 0.12) * w;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.25 + rnd() * 0.4).toFixed(2) + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, cr, 0, 7); ctx.fill();
    }

    // --- terrain: fbm elevation bands ------------------------------------
    var noise = fbm(p.seed * 31 + 17, 5);
    var bands = 34;
    for (var b = 0; b < bands; b++) {
      var t = b / (bands - 1);
      var yBase = horizon * h + t * (1 - horizon) * h * 1.15;
      ctx.beginPath();
      ctx.moveTo(-w, yBase + 40);
      for (var x = -w; x <= 2 * w; x += 10) {
        var nx = (x / w + 1) / 3;
        var e = noise(nx, 0.1 + t * 0.8);
        ctx.lineTo(x, yBase - e * (1 - t) * h * 0.13);
      }
      ctx.lineTo(2 * w, h * 2); ctx.lineTo(-w, h * 2); ctx.closePath();
      var col = t < 0.5 ? lerpColor(pal.land[0], pal.land[1], t * 2) : lerpColor(pal.land[1], pal.land[2], (t - 0.5) * 2);
      ctx.fillStyle = col; ctx.fill();
    }

    // --- mid-frequency clutter: foliage clumps ---------------------------
    var trees = 10 + Math.floor(rnd() * 18);
    for (var i = 0; i < trees; i++) {
      var tx = rnd() * w * 1.3 - 0.15 * w;
      var depth = rnd();
      var ty = horizon * h + depth * (1 - horizon) * h;
      var tr = (0.012 + depth * 0.05) * w;
      ctx.fillStyle = lerpColor(pal.accent, pal.land[1], rnd() * 0.6);
      ctx.beginPath();
      for (var k = 0; k < 9; k++) {
        var ang = (k / 9) * Math.PI * 2;
        var rr = tr * (0.7 + rnd() * 0.6);
        var px = tx + Math.cos(ang) * rr, py = ty + Math.sin(ang) * rr * 0.8;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(40,30,20,0.55)';
      ctx.fillRect(tx - tr * 0.08, ty, tr * 0.16, tr * 0.7);
    }

    // --- buildings (some scenes) -----------------------------------------
    if (p.seed % 3 === 0) {
      var bn = 3 + Math.floor(rnd() * 5);
      for (var bi = 0; bi < bn; bi++) {
        var bx = rnd() * w, bw = (0.05 + rnd() * 0.1) * w, bh = (0.1 + rnd() * 0.28) * h;
        var by = horizon * h - bh + rnd() * 0.05 * h;
        ctx.fillStyle = lerpColor(pal.accent, '#ffffff', 0.15 + rnd() * 0.3);
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = 'rgba(255,240,200,0.65)';
        for (var wy = by + 6; wy < by + bh - 8; wy += 12) {
          for (var wx = bx + 4; wx < bx + bw - 6; wx += 10) {
            if (rnd() > 0.45) ctx.fillRect(wx, wy, 5, 7);
          }
        }
      }
    }

    // --- scene texture ----------------------------------------------------
    // Without this the render is almost all low-frequency gradient, which is
    // nothing like a photograph: unrelated frames end up much closer in Hamming
    // distance than real unrelated photos would, and every threshold conclusion
    // drawn from the corpus would be optimistic in the wrong direction.
    // Drawn INSIDE the camera transform so that panning and zooming reveal
    // different texture, exactly as a real camera move would.
    drawTexture(ctx, w, h, p.seed);

    // --- subject ---------------------------------------------------------
    if (p.subject) drawFigure(ctx, w, h, p.subject, pal);

    ctx.restore();

    // --- exposure ---------------------------------------------------------
    if (exposure !== 1) {
      var id = ctx.getImageData(0, 0, w, h), d = id.data;
      for (var q = 0; q < d.length; q += 4) {
        d[q] = Math.min(255, d[q] * exposure);
        d[q + 1] = Math.min(255, d[q + 1] * exposure);
        d[q + 2] = Math.min(255, d[q + 2] * exposure);
      }
      ctx.putImageData(id, 0, 0);
    }

    // --- sensor grain (per-frame) ----------------------------------------
    if (p.grainSeed != null) addGrain(ctx, w, h, p.grainSeed, p.grainAmount == null ? 7 : p.grainAmount);

    // --- vignette ---------------------------------------------------------
    var vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);

    return canvas;
  }

  /**
   * Multi-octave 1/f luminance texture, cached per scene seed. Generated at
   * 1.6x the frame in scene space so that a camera pan or zoom uncovers texture
   * the previous framing never showed.
   */
  var TEXTURE_CACHE = {};
  function textureCanvas(seed, tw, th) {
    var key = seed + ':' + tw + 'x' + th;
    if (TEXTURE_CACHE[key]) return TEXTURE_CACHE[key];
    var c = document.createElement('canvas');
    c.width = tw; c.height = th;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(tw, th);
    var d = img.data;
    // Five octaves, halving amplitude, doubling frequency. The finest octave is
    // a per-pixel hash so there is real energy above the 32x32 DCT grid.
    var GRIDS = [7, 19, 53, 131];
    var oct = [];
    for (var o = 0; o < GRIDS.length; o++) oct.push(valueNoise2D(seed * 131 + o * 6151, GRIDS[o], GRIDS[o]));
    var rnd = mulberry32(seed * 977 + 13);
    var fine = new Float32Array(4096);
    for (var q = 0; q < fine.length; q++) fine[q] = rnd();
    for (var y = 0, i = 0; y < th; y++) {
      var fy = y / th;
      for (var x = 0; x < tw; x++, i += 4) {
        var fx = x / tw;
        var v = 0, amp = 1, norm = 0;
        for (var k = 0; k < oct.length; k++) { v += amp * oct[k](fx, fy); norm += amp; amp *= 0.55; }
        v = v / norm;
        v = 0.85 * v + 0.15 * fine[((y * 71 + x * 37) & 4095)];
        // Averaging octaves pulls everything toward 0.5, which under 'overlay'
        // is a no-op. Stretch the contrast back out or the texture is invisible.
        v = 0.5 + (v - 0.5) * 3.2;
        var g = v < 0 ? 0 : (v > 1 ? 255 : v * 255);
        d[i] = g; d[i + 1] = g; d[i + 2] = g; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    TEXTURE_CACHE[key] = c;
    return c;
  }

  function drawTexture(ctx, w, h, seed) {
    var tw = Math.round(w * 0.9), th = Math.round(h * 0.9);
    var tex = textureCanvas(seed, tw, th);
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.8;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tex, -0.3 * w, -0.3 * h, 1.6 * w, 1.6 * h);
    ctx.restore();
  }

  /** A person: body, head, hair, eyes, brows, mouth. Expression is real geometry. */
  function drawFigure(ctx, w, h, s, pal) {
    var fh = s.height * h;                 // figure height in px
    var cx = s.x * w;
    var feetY = s.y * h + fh * 0.5;
    var headR = fh * 0.075;
    var headY = feetY - fh + headR;

    ctx.save();
    // legs + torso
    ctx.fillStyle = '#2f3440';
    ctx.fillRect(cx - fh * 0.055, feetY - fh * 0.45, fh * 0.045, fh * 0.45);
    ctx.fillRect(cx + fh * 0.012, feetY - fh * 0.45, fh * 0.045, fh * 0.45);
    ctx.fillStyle = s.shirt || '#b5453c';
    roundRect(ctx, cx - fh * 0.085, headY + headR * 0.9, fh * 0.17, fh * 0.42, fh * 0.03);
    ctx.fill();
    // arms
    ctx.strokeStyle = s.shirt || '#b5453c';
    ctx.lineWidth = fh * 0.035; ctx.lineCap = 'round';
    var raise = s.armRaise || 0;
    ctx.beginPath();
    ctx.moveTo(cx - fh * 0.075, headY + headR * 1.3);
    ctx.lineTo(cx - fh * 0.13, headY + headR * 1.3 + fh * 0.25 * (1 - raise) - fh * 0.2 * raise);
    ctx.moveTo(cx + fh * 0.075, headY + headR * 1.3);
    ctx.lineTo(cx + fh * 0.13, headY + headR * 1.3 + fh * 0.25);
    ctx.stroke();

    // head
    var turn = (s.headTurn || 0) * headR * 0.35;
    ctx.fillStyle = s.skin || '#e0b48c';
    ctx.beginPath(); ctx.ellipse(cx, headY, headR * 0.82, headR, 0, 0, 7); ctx.fill();
    // hair
    ctx.fillStyle = s.hair || '#3a2b22';
    ctx.beginPath(); ctx.ellipse(cx, headY - headR * 0.28, headR * 0.86, headR * 0.72, 0, Math.PI, 2 * Math.PI); ctx.fill();

    // eyes
    var eyeY = headY - headR * 0.1, eyeDx = headR * 0.33, eyeR = headR * 0.11;
    var expr = s.expression || 'neutral';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#2b2119'; ctx.lineWidth = Math.max(1, headR * 0.05);
    if (expr === 'blink') {
      ctx.beginPath();
      ctx.moveTo(cx - eyeDx - eyeR + turn, eyeY); ctx.lineTo(cx - eyeDx + eyeR + turn, eyeY);
      ctx.moveTo(cx + eyeDx - eyeR + turn, eyeY); ctx.lineTo(cx + eyeDx + eyeR + turn, eyeY);
      ctx.stroke();
    } else {
      var er = expr === 'surprised' ? eyeR * 1.5 : eyeR;
      ctx.beginPath(); ctx.ellipse(cx - eyeDx + turn, eyeY, er, er * 0.75, 0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx + eyeDx + turn, eyeY, er, er * 0.75, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#2b2119';
      ctx.beginPath(); ctx.arc(cx - eyeDx + turn, eyeY, er * 0.5, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + eyeDx + turn, eyeY, er * 0.5, 0, 7); ctx.fill();
    }
    // brows
    ctx.strokeStyle = s.hair || '#3a2b22';
    ctx.lineWidth = Math.max(1, headR * 0.07);
    var browLift = expr === 'surprised' ? headR * 0.12 : 0;
    ctx.beginPath();
    ctx.moveTo(cx - eyeDx - eyeR * 1.2 + turn, eyeY - headR * 0.26 - browLift);
    ctx.lineTo(cx - eyeDx + eyeR * 1.2 + turn, eyeY - headR * 0.3 - browLift);
    ctx.moveTo(cx + eyeDx - eyeR * 1.2 + turn, eyeY - headR * 0.3 - browLift);
    ctx.lineTo(cx + eyeDx + eyeR * 1.2 + turn, eyeY - headR * 0.26 - browLift);
    ctx.stroke();

    // mouth — the expression change the PRD §8 risk row is about
    var mY = headY + headR * 0.45, mW = headR * 0.34;
    ctx.strokeStyle = '#8c4a44'; ctx.lineWidth = Math.max(1, headR * 0.09); ctx.lineCap = 'round';
    ctx.beginPath();
    if (expr === 'smile') {
      ctx.arc(cx + turn, mY - headR * 0.12, mW, 0.25 * Math.PI, 0.75 * Math.PI);
      ctx.stroke();
    } else if (expr === 'laugh') {
      ctx.fillStyle = '#7a3a36';
      ctx.ellipse(cx + turn, mY, mW * 0.95, headR * 0.22, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.ellipse(cx + turn, mY - headR * 0.1, mW * 0.8, headR * 0.07, 0, 0, 7); ctx.fill();
    } else if (expr === 'surprised') {
      ctx.fillStyle = '#7a3a36';
      ctx.ellipse(cx + turn, mY, mW * 0.5, headR * 0.28, 0, 0, 7); ctx.fill();
    } else if (expr === 'frown') {
      ctx.arc(cx + turn, mY + headR * 0.3, mW, 1.25 * Math.PI, 1.75 * Math.PI);
      ctx.stroke();
    } else { // neutral
      ctx.moveTo(cx - mW + turn, mY); ctx.lineTo(cx + mW + turn, mY); ctx.stroke();
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function addGrain(ctx, w, h, seed, amount) {
    var rnd = mulberry32(seed);
    var id = ctx.getImageData(0, 0, w, h), d = id.data;
    for (var i = 0; i < d.length; i += 4) {
      var n = (rnd() - 0.5) * amount;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(id, 0, 0);
  }

  /**
   * Post-capture transform: rotate / scale / translate / crop / blur, then
   * re-render at a target size. Used for the rotation, crop, resize and blur
   * corpus categories.
   */
  function transform(src, opts) {
    opts = opts || {};
    var outW = opts.outW || src.width, outH = opts.outH || src.height;
    var out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    var ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    var filters = [];
    if (opts.blurPx) filters.push('blur(' + opts.blurPx + 'px)');
    if (opts.brightness) filters.push('brightness(' + opts.brightness + ')');
    if (opts.contrast) filters.push('contrast(' + opts.contrast + ')');
    if (filters.length) ctx.filter = filters.join(' ');

    // Source rect (crop), default full frame.
    var crop = opts.crop || 0; // fraction trimmed off each edge
    var sx = src.width * crop, sy = src.height * crop;
    var sw = src.width * (1 - 2 * crop), sh = src.height * (1 - 2 * crop);

    ctx.save();
    ctx.translate(outW / 2 + (opts.dx || 0), outH / 2 + (opts.dy || 0));
    if (opts.rotDeg) ctx.rotate((opts.rotDeg * Math.PI) / 180);
    var scale = opts.scale || 1;
    ctx.scale(scale, scale);
    ctx.drawImage(src, sx, sy, sw, sh, -outW / 2, -outH / 2, outW, outH);
    ctx.restore();
    return out;
  }

  function newCanvas(w, h) {
    var c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }

  global.SceneGen = {
    renderScene: renderScene,
    transform: transform,
    newCanvas: newCanvas,
    mulberry32: mulberry32,
    PALETTES: PALETTES
  };
})(window);
