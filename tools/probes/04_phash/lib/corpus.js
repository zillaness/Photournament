/**
 * corpus.js — PROBE ONLY. Builds the near-duplicate test corpus, pushes every
 * frame through a real JPEG encode/decode round trip, and hashes it with the
 * SHIPPING module (src/js/20_phash.js, loaded as PT.phash) at both full
 * resolution and at the PRD 7.9 320px thumbnail size.
 *
 * Budget: ~120 rendered frames, all in memory. Nothing is written to disk
 * except a handful of sample data URLs the runner dumps for visual inspection.
 *
 * Categories:
 *   burst_tight    same scene, sub-1% subject displacement, +-2% exposure,
 *                  expression change, per-frame sensor grain, <0.2 deg jitter
 *   burst_loose    same scene seconds apart: 3-4% displacement, pose change,
 *                  +-6% exposure, reframe, <1 deg rotation
 *   expression     IDENTICAL frame except the face. Same grain seed, same
 *                  camera, same exposure. Isolates the PRD section 8 risk with
 *                  literally nothing else moving. Rendered at three subject
 *                  scales because whether an expression change survives hashing
 *                  depends entirely on how much of the frame the face occupies.
 *   recompose      same scene, deliberately different composition (hard neg)
 *   subject_move   same subject, completely different scene (hard neg)
 *   geom           rotate / crop of the base frame
 *   reencode       base frame at lower JPEG quality and lower resolution
 *   chain          8-frame pan: neighbours near-identical, ends unrelated.
 *                  The transitivity / linkage test.
 *   nominate       blur and downscale ladders for representative nomination
 *
 * Scene identity: every (scene, scale) family, the base family, the chain and
 * the moved-subject frame each get their OWN scene seed, so "different scene"
 * is unambiguous ground truth rather than a judgement call.
 *
 * Global: window.Corpus
 */
(function (global) {
  'use strict';

  var SG = global.SceneGen;

  function PH() { return global.PT.phash; }

  var BASE_W = 1200, BASE_H = 800;
  var BASE_Q = 0.9;
  var THUMB_EDGE = 320;   // PRD 7.9 grid thumbnail long edge

  var SCENES = [0, 1, 2].map(function (i) {
    return {
      name: 'S' + i,
      seed: 101 + i * 37,
      shirt: ['#b5453c', '#33608f', '#d8a13a'][i],
      hair: ['#3a2b22', '#171310', '#8a6a3a'][i],
      skin: ['#e0b48c', '#c98f61', '#f0d2b4'][i],
      x: [0.36, 0.58, 0.45][i]
    };
  });

  var SCALES = {
    wide: { height: 0.22, headY: 0.50, seedOff: 0 },        // head ~3% of frame height
    medium: { height: 0.62, headY: 0.42, seedOff: 1301 },   // head ~9%
    portrait: { height: 2.60, headY: 0.42, seedOff: 2603 }  // head ~39%
  };
  var BURST_SCALES = ['wide', 'portrait'];
  var EXPR_SCALES = ['wide', 'medium', 'portrait'];

  var BASE_SEED_OFF = 4007, CHAIN_SEED_OFF = 5011, MOVED_SEED_OFF = 6029;

  // Each burst family gets its own terrain on top of the scale offset, so that
  // "burst_tight/S0/wide" and "expression/S0/wide" are genuinely different
  // scenes. Without this they share a seed and land at Hamming distance 0,
  // which would be scored as a false positive when it is really correct
  // behaviour on an ambiguously-labelled pair.
  var FAMILY_SEED_OFF = { burst_tight: 0, burst_loose: 311, expression: 617 };

  function subjectY(scaleName, dy) {
    var sc = SCALES[scaleName];
    return sc.headY + 0.425 * sc.height + (dy || 0);
  }

  function subjectFor(scene, scaleName, over) {
    var s = {
      x: scene.x, y: subjectY(scaleName, 0), height: SCALES[scaleName].height,
      expression: 'neutral', headTurn: 0, armRaise: 0,
      shirt: scene.shirt, hair: scene.hair, skin: scene.skin
    };
    for (var k in (over || {})) if (Object.prototype.hasOwnProperty.call(over, k)) s[k] = over[k];
    return s;
  }

  // frame deltas ------------------------------------------------------------
  var TIGHT = [
    { dx: 0.0000, dy: 0.0000, expr: 'smile', exp: 1.000, pan: 0.0000, rot: 0.00, turn: 0.00 },
    { dx: 0.0020, dy: 0.0010, expr: 'laugh', exp: 1.012, pan: 0.0012, rot: 0.10, turn: 0.10 },
    { dx: -0.0015, dy: -0.0010, expr: 'blink', exp: 0.992, pan: -0.0010, rot: -0.08, turn: -0.10 }
  ];
  var LOOSE = [
    { dx: 0.000, dy: 0.000, expr: 'smile', exp: 1.000, pan: 0.000, rot: 0.0, turn: 0.0, arm: 0, zoom: 1.000 },
    { dx: 0.030, dy: 0.008, expr: 'laugh', exp: 1.055, pan: 0.012, rot: 0.5, turn: 0.4, arm: 0.5, zoom: 1.012 },
    { dx: -0.042, dy: -0.010, expr: 'surprised', exp: 0.935, pan: -0.014, rot: -0.7, turn: -0.5, arm: 1, zoom: 0.982 }
  ];
  var EXPRS = ['neutral', 'smile', 'laugh'];

  // image plumbing ----------------------------------------------------------

  function toBlob(canvas, quality) {
    return new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', quality); });
  }

  function blobToDataURL(blob) {
    return new Promise(function (res) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.readAsDataURL(blob);
    });
  }

  function decodeToCanvas(blob) {
    return createImageBitmap(blob).then(function (bmp) {
      var c = SG.newCanvas(bmp.width, bmp.height);
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      return c;
    });
  }

  function getImageData(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height);
  }

  function thumbCanvas(canvas, edge) {
    var w = canvas.width, h = canvas.height, tw, th;
    if (w >= h) { tw = Math.min(edge, w); th = Math.max(1, Math.round(h * tw / w)); }
    else { th = Math.min(edge, h); tw = Math.max(1, Math.round(w * th / h)); }
    var c = SG.newCanvas(tw, th);
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, tw, th);
    return c;
  }

  function renderSpec(spec) {
    var base = SG.newCanvas(spec.w || BASE_W, spec.h || BASE_H);
    SG.renderScene(base, spec.scene);
    if (spec.xform) base = SG.transform(base, spec.xform);
    return base;
  }

  /** Render -> JPEG -> decode -> hash at full res and at 320px thumbnail. */
  function processSpec(spec) {
    var canvas = renderSpec(spec);
    return toBlob(canvas, spec.quality == null ? BASE_Q : spec.quality)
      .then(function (blob) {
        return decodeToCanvas(blob).then(function (dec) {
          var ph = PH();
          var fullId = getImageData(dec);
          var t0 = performance.now();
          var dFull = ph.dhash(fullId);
          var t1 = performance.now();
          var pFull = ph.phash(fullId);
          var t2 = performance.now();
          var sFull = ph.sharpness(fullId);
          var t3 = performance.now();

          var tc = thumbCanvas(dec, THUMB_EDGE);
          var thumbId = getImageData(tc);
          var t4 = performance.now();
          var dThumb = ph.dhash(thumbId);
          var pThumb = ph.phash(thumbId);
          var sThumb = ph.sharpness(thumbId);
          var t5 = performance.now();

          var rec = {
            id: spec.id, category: spec.category, scene: spec.sceneName,
            sceneId: spec.sceneId, family: spec.family, set: spec.set,
            role: spec.role, scale: spec.scale || null,
            w: fullId.width, h: fullId.height, bytes: blob.size,
            quality: spec.quality == null ? BASE_Q : spec.quality,
            dhash: dFull, phash: pFull, sharp: sFull,
            dhashThumb: dThumb, phashThumb: pThumb, sharpThumb: sThumb,
            thumbW: thumbId.width, thumbH: thumbId.height,
            truth: spec.truth || null,
            nomSet: spec.nomSet || null, nomRole: spec.nomRole || null,
            chainStep: spec.chainStep == null ? null : spec.chainStep,
            msFullDhash: t1 - t0, msFullPhash: t2 - t1, msFullSharp: t3 - t2,
            msThumbAll: t5 - t4
          };

          var samplePromise = spec._sample
            ? blobToDataURL(blob).then(function (u) { return { id: spec.id, dataURL: u }; })
            : Promise.resolve(null);

          return samplePromise.then(function (sample) {
            dec.width = dec.height = 1;
            tc.width = tc.height = 1;
            canvas.width = canvas.height = 1;
            return { rec: rec, sample: sample };
          });
        });
      });
  }

  // the corpus spec ---------------------------------------------------------

  function buildSpecs() {
    var specs = [];

    SCENES.forEach(function (scene, si) {

      // ---- burst families, one scene identity per (scene, scale) ----------
      BURST_SCALES.forEach(function (scaleName) {
        var scaleSeed = scene.seed + SCALES[scaleName].seedOff;
        var sceneId = scene.name + '/' + scaleName;

        TIGHT.forEach(function (f, i) {
          specs.push({
            id: 'burst_tight/' + sceneId + '/f' + i, category: 'burst_tight',
            sceneName: scene.name, sceneId: sceneId,
            family: 'burst_tight/' + sceneId, set: 'burst_tight/' + sceneId,
            role: 'f' + i, scale: scaleName,
            scene: {
              seed: scaleSeed + FAMILY_SEED_OFF.burst_tight, camera: { panX: f.pan, panY: 0, zoom: 1 }, exposure: f.exp,
              grainSeed: 5000 + si * 97 + i,
              subject: subjectFor(scene, scaleName, {
                x: scene.x + f.dx, y: subjectY(scaleName, f.dy),
                expression: f.expr, headTurn: f.turn
              })
            },
            xform: f.rot ? { rotDeg: f.rot, scale: 1.004 } : null,
            _sample: (scene.name === 'S0' && scaleName === 'portrait')
          });
        });

        LOOSE.forEach(function (f, i) {
          specs.push({
            id: 'burst_loose/' + sceneId + '/f' + i, category: 'burst_loose',
            sceneName: scene.name, sceneId: sceneId,
            family: 'burst_loose/' + sceneId, set: 'burst_loose/' + sceneId,
            role: 'f' + i, scale: scaleName,
            scene: {
              seed: scaleSeed + FAMILY_SEED_OFF.burst_loose, camera: { panX: f.pan, panY: 0, zoom: f.zoom }, exposure: f.exp,
              grainSeed: 6000 + si * 89 + i,
              subject: subjectFor(scene, scaleName, {
                x: scene.x + f.dx, y: subjectY(scaleName, f.dy),
                expression: f.expr, headTurn: f.turn, armRaise: f.arm
              })
            },
            xform: f.rot ? { rotDeg: f.rot, scale: 1.01 } : null
          });
        });
      });

      // ---- expression-only: nothing moves but the face --------------------
      EXPR_SCALES.forEach(function (scaleName) {
        var seed = scene.seed + SCALES[scaleName].seedOff + FAMILY_SEED_OFF.expression;
        var sceneId = scene.name + '/' + scaleName;
        EXPRS.forEach(function (e) {
          specs.push({
            id: 'expression/' + sceneId + '/' + e, category: 'expression',
            sceneName: scene.name, sceneId: sceneId,
            family: 'expression/' + sceneId, set: 'expression/' + sceneId,
            role: e, scale: scaleName,
            scene: {
              seed: seed, camera: { panX: 0, panY: 0, zoom: 1 }, exposure: 1,
              grainSeed: 7000 + si,   // identical grain: only the face differs
              subject: subjectFor(scene, scaleName, { expression: e })
            },
            _sample: (scene.name === 'S0' && (scaleName === 'portrait' || scaleName === 'wide'))
          });
        });
      });

      // ---- base family ----------------------------------------------------
      var baseSceneId = scene.name + '/base';
      var baseScene = {
        seed: scene.seed + BASE_SEED_OFF, camera: { panX: 0, panY: 0, zoom: 1 },
        exposure: 1, grainSeed: 8000 + si,
        subject: subjectFor(scene, 'medium', { expression: 'smile' })
      };
      var recomposeScene = {
        seed: scene.seed + BASE_SEED_OFF, camera: { panX: 0.20, panY: 0.06, zoom: 1.45 },
        exposure: 1, grainSeed: 8100 + si,
        subject: subjectFor(scene, 'medium', { x: scene.x + 0.24, expression: 'neutral' })
      };

      specs.push({
        id: 'base/' + scene.name, category: 'base', sceneName: scene.name,
        sceneId: baseSceneId, family: 'base/' + scene.name, set: 'base/' + scene.name,
        role: 'base', scene: baseScene, _sample: true,
        nomSet: 'nom/' + scene.name + '/base', nomRole: 'sharp'
      });

      specs.push({
        id: 'recompose/' + scene.name + '/r0', category: 'recompose',
        sceneName: scene.name, sceneId: baseSceneId + '/recompose0',
        family: 'recompose/' + scene.name, set: 'recompose/' + scene.name, role: 'r0',
        scene: recomposeScene, _sample: scene.name === 'S0',
        nomSet: 'nom/' + scene.name + '/recompose', nomRole: 'sharp'
      });

      specs.push({
        id: 'subject_move/' + scene.name, category: 'subject_move', sceneName: scene.name,
        sceneId: scene.name + '/moved', family: 'subject_move/' + scene.name,
        set: 'subject_move/' + scene.name, role: 'moved',
        scene: {
          seed: scene.seed + MOVED_SEED_OFF, camera: { panX: 0, panY: 0, zoom: 1 },
          exposure: 1, grainSeed: 8200 + si,
          subject: subjectFor(scene, 'medium', { expression: 'smile' })
        }
      });

      [
        { r: 'rot1', xform: { rotDeg: 1, scale: 1.02 }, truth: 'minor' },
        { r: 'rot5', xform: { rotDeg: 5, scale: 1.10 }, truth: 'major' },
        { r: 'crop5', xform: { crop: 0.05 }, truth: 'minor' },
        { r: 'crop20', xform: { crop: 0.20 }, truth: 'major' }
      ].forEach(function (g) {
        specs.push({
          id: 'geom/' + scene.name + '/' + g.r,
          category: g.truth === 'minor' ? 'geom_minor' : 'geom_major',
          sceneName: scene.name, sceneId: baseSceneId,
          family: 'base/' + scene.name, set: 'geom/' + scene.name, role: g.r,
          scene: baseScene, xform: g.xform, truth: g.truth
        });
      });

      [
        { r: 'q85', quality: 0.85 },
        { r: 'q50', quality: 0.50 },
        { r: 'q30', quality: 0.30 }
      ].forEach(function (q) {
        specs.push({
          id: 'reencode/' + scene.name + '/' + q.r, category: 'reencode',
          sceneName: scene.name, sceneId: baseSceneId, family: 'base/' + scene.name,
          set: 'reencode/' + scene.name, role: q.r, scene: baseScene, quality: q.quality
        });
      });
      specs.push({
        id: 'reencode/' + scene.name + '/res400', category: 'reencode',
        sceneName: scene.name, sceneId: baseSceneId, family: 'base/' + scene.name,
        set: 'reencode/' + scene.name, role: 'res400', scene: baseScene,
        xform: { outW: 400, outH: 267 }
      });

      // ---- nomination ladders --------------------------------------------
      // Two source frames per scene, each with three degraded siblings. The
      // sharp originals above (base/, recompose/) are the ground-truth winners.
      [
        { key: 'base', src: baseScene },
        { key: 'recompose', src: recomposeScene }
      ].forEach(function (nom) {
        [
          { r: 'blur1_5', xform: { blurPx: 1.5 } },
          { r: 'blur4', xform: { blurPx: 4 } },
          { r: 'lowres_crisp', xform: { outW: 480, outH: 320 } }
        ].forEach(function (v) {
          specs.push({
            id: 'nominate/' + scene.name + '/' + nom.key + '/' + v.r, category: 'nominate',
            sceneName: scene.name, sceneId: baseSceneId + '/' + nom.key,
            family: 'nom/' + scene.name + '/' + nom.key,
            set: 'nom/' + scene.name + '/' + nom.key, role: v.r,
            scene: nom.src, xform: v.xform,
            nomSet: 'nom/' + scene.name + '/' + nom.key, nomRole: 'degraded',
            truth: 'degraded',
            _sample: (scene.name === 'S0' && nom.key === 'base')
          });
        });
      });
    });

    // ---- one 8-frame pan: the transitivity / linkage test -----------------
    var chainScene = SCENES[0];
    for (var k = 0; k < 8; k++) {
      specs.push({
        id: 'chain/c' + k, category: 'chain', sceneName: chainScene.name,
        sceneId: 'chain/step' + k, family: 'chain', set: 'chain', role: 'c' + k,
        chainStep: k,
        scene: {
          seed: chainScene.seed + CHAIN_SEED_OFF,
          camera: { panX: k * 0.055, panY: 0, zoom: 1 },
          exposure: 1 + k * 0.004, grainSeed: 8300 + k,
          subject: subjectFor(chainScene, 'medium', {
            x: chainScene.x + k * 0.055, expression: 'neutral'
          })
        },
        _sample: (k === 0 || k === 7)
      });
    }

    return specs;
  }

  function build(onProgress) {
    var specs = buildSpecs();
    var records = [], samples = [];
    var i = 0;
    function step() {
      if (i >= specs.length) {
        return Promise.resolve({ records: records, samples: samples, count: specs.length });
      }
      return processSpec(specs[i]).then(function (out) {
        records.push(out.rec);
        if (out.sample) samples.push(out.sample);
        i++;
        if (onProgress && i % 5 === 0) onProgress(i, specs.length);
        if (i % 12 === 0) {
          return new Promise(function (r) { setTimeout(r, 0); }).then(step);
        }
        return step();
      });
    }
    return step();
  }

  global.Corpus = {
    build: build,
    buildSpecs: buildSpecs,
    SCENES: SCENES,
    SCALES: SCALES,
    BURST_SCALES: BURST_SCALES,
    EXPR_SCALES: EXPR_SCALES,
    BASE_W: BASE_W,
    BASE_H: BASE_H,
    THUMB_EDGE: THUMB_EDGE
  };
})(window);
