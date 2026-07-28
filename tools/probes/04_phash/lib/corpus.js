/**
 * corpus.js — PROBE ONLY. Builds the near-duplicate test corpus, encodes every
 * frame through a real JPEG round trip, and hashes it at both full resolution
 * and at the PRD §7.9 320px thumbnail size.
 *
 * Categories (PRD §7.7 grouping, §8 "expression may not group" risk row):
 *   burst_tight   same scene, sub-1% subject displacement, ±2% exposure,
 *                 expression change, per-frame sensor grain, <0.2 deg jitter
 *   burst_loose   same scene seconds apart: 2-5% displacement, pose change,
 *                 ±9% exposure, reframe, <1 deg rotation
 *   expression    IDENTICAL frame except the face — same grain seed, same
 *                 everything. Isolates the §8 risk with nothing else moving.
 *   recompose     same scene, deliberately different composition (hard negative)
 *   subject_move  same subject, completely different scene (hard negative)
 *   geom          rotate / crop / resize of one frame
 *   reencode      same frame at 5 JPEG qualities and 4 resolutions
 *   blur          one frame at 5 sharpness levels (representative nomination)
 *   chain         8-frame pan: neighbours near-identical, ends unrelated
 *                 (the single-linkage transitivity test)
 *
 * Every burst family is generated at three subject scales (head ~3%, ~9%, ~39%
 * of frame height) because whether an expression change breaks grouping depends
 * entirely on how much of the frame the face occupies. That is the measurement
 * PRD §8 is missing.
 *
 * SCENE IDENTITY. Each (scene, scale) family, each base family and each chain
 * gets its OWN scene seed, so "different scene identity" is unambiguous ground
 * truth. Without that, a wide shot and a portrait of the same background are an
 * arguable pair and every precision number becomes a judgement call.
 *
 * Global: window.Corpus
 */
(function (global) {
  'use strict';

  var SG = global.SceneGen;
  var PH = global.PhotournamentHash;

  var BASE_W = 1200, BASE_H = 800;
  var BASE_Q = 0.9;
  var THUMB_EDGE = 320;   // PRD §7.9 grid thumbnail size

  var SCENES = [0, 1, 2, 3, 4].map(function (i) {
    return {
      name: 'S' + i,
      seed: 101 + i * 37,
      shirt: ['#b5453c', '#33608f', '#d8a13a', '#5a7d4a', '#7a4a86'][i],
      hair: ['#3a2b22', '#171310', '#8a6a3a', '#5a4436', '#241c18'][i],
      skin: ['#e0b48c', '#c98f61', '#f0d2b4', '#8d5f3d', '#e8c2a0'][i],
      x: [0.36, 0.58, 0.45, 0.66, 0.30][i]
    };
  });

  var SCALES = {
    wide: { height: 0.22, headY: 0.50, seedOff: 0 },      // head ~3% of frame height
    medium: { height: 0.62, headY: 0.42, seedOff: 1301 }, // head ~9%
    portrait: { height: 2.60, headY: 0.42, seedOff: 2603 }// head ~39%
  };
  var BASE_SEED_OFF = 4007, CHAIN_SEED_OFF = 5011, MOVED_SEED_OFF = 6029;

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
    for (var k in (over || {})) s[k] = over[k];
    return s;
  }

  // --- burst frame deltas ---------------------------------------------------
  var TIGHT = [
    { dx: 0.0000, dy: 0.0000, expr: 'smile', exp: 1.000, pan: 0.0000, rot: 0.00, turn: 0.00 },
    { dx: 0.0020, dy: 0.0010, expr: 'laugh', exp: 1.012, pan: 0.0012, rot: 0.10, turn: 0.10 },
    { dx: -0.0015, dy: -0.0010, expr: 'neutral', exp: 0.992, pan: -0.0010, rot: -0.08, turn: -0.10 },
    { dx: 0.0030, dy: 0.0015, expr: 'blink', exp: 1.020, pan: 0.0015, rot: 0.15, turn: 0.05 }
  ];
  var LOOSE = [
    { dx: 0.000, dy: 0.000, expr: 'smile', exp: 1.000, pan: 0.000, rot: 0.0, turn: 0.0, arm: 0, zoom: 1.000 },
    { dx: 0.022, dy: 0.006, expr: 'laugh', exp: 1.050, pan: 0.010, rot: 0.5, turn: 0.4, arm: 0.5, zoom: 1.010 },
    { dx: -0.030, dy: -0.008, expr: 'surprised', exp: 0.940, pan: -0.012, rot: -0.4, turn: -0.5, arm: 0, zoom: 0.985 },
    { dx: 0.045, dy: 0.010, expr: 'neutral', exp: 1.090, pan: 0.014, rot: 0.8, turn: 0.2, arm: 1, zoom: 1.020 }
  ];
  var EXPRS = ['neutral', 'smile', 'laugh', 'blink'];

  // --- image plumbing -------------------------------------------------------

  function toBlob(canvas, quality) {
    return new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', quality); });
  }

  function blobToDataURL(blob) {
    return new Promise(function (res) {
      var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.readAsDataURL(blob);
    });
  }

  async function decodeToImageData(blob) {
    var bmp = await createImageBitmap(blob);
    var c = SG.newCanvas(bmp.width, bmp.height);
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return { imageData: ctx.getImageData(0, 0, c.width, c.height), canvas: c };
  }

  function thumbnailImageData(canvas, edge) {
    var w = canvas.width, h = canvas.height, tw, th;
    if (w >= h) { tw = Math.min(edge, w); th = Math.max(1, Math.round(h * tw / w)); }
    else { th = Math.min(edge, h); tw = Math.max(1, Math.round(w * th / h)); }
    var c = SG.newCanvas(tw, th);
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, tw, th);
    return { imageData: ctx.getImageData(0, 0, tw, th), canvas: c };
  }

  function renderSpec(spec) {
    var base = SG.newCanvas(spec.w || BASE_W, spec.h || BASE_H);
    SG.renderScene(base, spec.scene);
    if (spec.xform) base = SG.transform(base, spec.xform);
    return base;
  }

  /** Full pipeline for one spec: render -> JPEG -> decode -> hash (full + thumb). */
  async function processSpec(spec) {
    var canvas = renderSpec(spec);
    var blob = await toBlob(canvas, spec.quality == null ? BASE_Q : spec.quality);
    var dec = await decodeToImageData(blob);
    var full = PH.hashImageData(dec.imageData);
    var th = thumbnailImageData(dec.canvas, THUMB_EDGE);
    var thumb = PH.hashImageData(th.imageData);

    var rec = {
      id: spec.id, category: spec.category, scene: spec.sceneName,
      sceneId: spec.sceneId, trueGroup: spec.trueGroup,
      set: spec.set, role: spec.role, scale: spec.scale || null,
      w: dec.imageData.width, h: dec.imageData.height, bytes: blob.size,
      quality: spec.quality == null ? BASE_Q : spec.quality,
      dhash: full.dhash, phash: full.phash, sharpness: full.sharpness,
      dhashThumb: thumb.dhash, phashThumb: thumb.phash, sharpnessThumb: thumb.sharpness,
      truth: spec.truth || null, blurRank: spec.blurRank == null ? null : spec.blurRank
    };
    var sample = null;
    if (spec._sample) {
      sample = { id: spec.id, dataURL: await blobToDataURL(blob) }; // exact bytes hashed
    }
    dec.canvas.width = dec.canvas.height = 1;
    th.canvas.width = th.canvas.height = 1;
    canvas.width = canvas.height = 1;
    return { rec: rec, sample: sample };
  }

  // --- the corpus spec ------------------------------------------------------

  function buildSpecs() {
    var specs = [];

    SCENES.forEach(function (scene, si) {

      // ---- burst families, one scene identity per (scene, scale) -----------
      Object.keys(SCALES).forEach(function (scaleName) {
        var seed = scene.seed + SCALES[scaleName].seedOff;
        var sceneId = scene.name + '/' + scaleName;

        TIGHT.forEach(function (f, i) {
          specs.push({
            id: 'burst_tight/' + sceneId + '/f' + i, category: 'burst_tight',
            sceneName: scene.name, sceneId: sceneId, trueGroup: sceneId,
            set: 'burst_tight/' + sceneId, role: 'f' + i, scale: scaleName,
            scene: {
              seed: seed, camera: { panX: f.pan, panY: 0, zoom: 1 }, exposure: f.exp,
              grainSeed: 5000 + si * 97 + i,
              subject: subjectFor(scene, scaleName, {
                x: scene.x + f.dx, y: subjectY(scaleName, f.dy),
                expression: f.expr, headTurn: f.turn
              })
            },
            xform: f.rot ? { rotDeg: f.rot, scale: 1.004 } : null
          });
        });

        LOOSE.forEach(function (f, i) {
          specs.push({
            id: 'burst_loose/' + sceneId + '/f' + i, category: 'burst_loose',
            sceneName: scene.name, sceneId: sceneId, trueGroup: sceneId,
            set: 'burst_loose/' + sceneId, role: 'f' + i, scale: scaleName,
            scene: {
              seed: seed, camera: { panX: f.pan, panY: 0, zoom: f.zoom }, exposure: f.exp,
              grainSeed: 6000 + si * 89 + i,
              subject: subjectFor(scene, scaleName, {
                x: scene.x + f.dx, y: subjectY(scaleName, f.dy),
                expression: f.expr, headTurn: f.turn, armRaise: f.arm
              })
            },
            xform: f.rot ? { rotDeg: f.rot, scale: 1.01 } : null
          });
        });

        EXPRS.forEach(function (e) {
          specs.push({
            id: 'expression/' + sceneId + '/' + e, category: 'expression',
            sceneName: scene.name, sceneId: sceneId, trueGroup: sceneId,
            set: 'expression/' + sceneId, role: e, scale: scaleName,
            scene: {
              seed: seed, camera: { panX: 0, panY: 0, zoom: 1 }, exposure: 1,
              grainSeed: 7000 + si,   // identical grain: nothing moves but the face
              subject: subjectFor(scene, scaleName, { expression: e })
            }
          });
        });
      });

      // ---- base family: base + reencode + geom + blur ----------------------
      var baseSceneId = scene.name + '/base';
      var baseScene = {
        seed: scene.seed + BASE_SEED_OFF, camera: { panX: 0, panY: 0, zoom: 1 },
        exposure: 1, grainSeed: 8000 + si,
        subject: subjectFor(scene, 'medium', { expression: 'smile' })
      };
      specs.push({
        id: 'base/' + scene.name, category: 'base', sceneName: scene.name,
        sceneId: baseSceneId, trueGroup: baseSceneId, set: 'base/' + scene.name,
        role: 'base', scene: baseScene, _sample: true
      });

      // recompose: same scene, different composition — the hard negative
      [{ z: 1.45, px: 0.20, py: 0.06, sx: 0.24 }, { z: 1.75, px: -0.22, py: -0.07, sx: -0.24 }].forEach(function (r, ri) {
        specs.push({
          id: 'recompose/' + scene.name + '/r' + ri, category: 'recompose',
          sceneName: scene.name, sceneId: baseSceneId,
          trueGroup: baseSceneId + '/recompose' + ri,     // its own group: user must compare
          set: 'recompose/' + scene.name, role: 'r' + ri,
          scene: {
            seed: scene.seed + BASE_SEED_OFF, camera: { panX: r.px, panY: r.py, zoom: r.z },
            exposure: 1, grainSeed: 8100 + si * 3 + ri,
            subject: subjectFor(scene, 'medium', { x: scene.x + r.sx, expression: 'neutral' })
          },
          _sample: scene.name === 'S0'
        });
      });

      // same subject, completely different scene
      specs.push({
        id: 'subject_move/' + scene.name, category: 'subject_move', sceneName: scene.name,
        sceneId: scene.name + '/moved', trueGroup: scene.name + '/moved',
        set: 'subject_move/' + scene.name, role: 'moved',
        scene: {
          seed: scene.seed + MOVED_SEED_OFF, camera: { panX: 0, panY: 0, zoom: 1 },
          exposure: 1, grainSeed: 8200 + si,
          subject: subjectFor(scene, 'medium', { expression: 'smile' })
        }
      });

      // geometry variants of the base frame
      [
        { r: 'rot0.5', xform: { rotDeg: 0.5, scale: 1.01 }, minor: true },
        { r: 'rot1', xform: { rotDeg: 1, scale: 1.02 }, minor: true },
        { r: 'rot2', xform: { rotDeg: 2, scale: 1.04 }, minor: true },
        { r: 'rot5', xform: { rotDeg: 5, scale: 1.10 }, minor: false },
        { r: 'rot90', xform: { rotDeg: 90, scale: 1, outW: BASE_H, outH: BASE_W }, minor: false },
        { r: 'crop2', xform: { crop: 0.02 }, minor: true },
        { r: 'crop5', xform: { crop: 0.05 }, minor: true },
        { r: 'crop10', xform: { crop: 0.10 }, minor: false },
        { r: 'crop20', xform: { crop: 0.20 }, minor: false },
        { r: 'resize50', xform: { outW: 600, outH: 400 }, minor: true },
        { r: 'resize25', xform: { outW: 300, outH: 200 }, minor: true },
        { r: 'resize200', xform: { outW: 2400, outH: 1600 }, minor: true }
      ].forEach(function (g) {
        specs.push({
          id: 'geom/' + scene.name + '/' + g.r, category: g.minor ? 'geom_minor' : 'geom_major',
          sceneName: scene.name, sceneId: baseSceneId,
          trueGroup: g.minor ? baseSceneId : baseSceneId + '/ambiguous_' + g.r,
          set: 'geom/' + scene.name, role: g.r, scene: baseScene, xform: g.xform,
          truth: g.minor ? 'minor' : 'major'
        });
      });

      // re-encode ladders
      [0.95, 0.85, 0.7, 0.5, 0.3].forEach(function (q) {
        specs.push({
          id: 'reencode/' + scene.name + '/q' + Math.round(q * 100), category: 'reencode',
          sceneName: scene.name, sceneId: baseSceneId, trueGroup: baseSceneId,
          set: 'reencode/' + scene.name, role: 'q' + Math.round(q * 100),
          scene: baseScene, quality: q
        });
      });
      [[900, 600], [600, 400], [400, 267], [200, 133]].forEach(function (r) {
        specs.push({
          id: 'reencode/' + scene.name + '/res' + r[0], category: 'reencode',
          sceneName: scene.name, sceneId: baseSceneId, trueGroup: baseSceneId,
          set: 'reencode/' + scene.name, role: 'res' + r[0],
          scene: baseScene, xform: { outW: r[0], outH: r[1] }
        });
      });

      // blur ladder (representative nomination)
      [
        { r: 'sharp', xform: null, rank: 0 },
        { r: 'blur1', xform: { blurPx: 1 }, rank: 1 },
        { r: 'blur2.5', xform: { blurPx: 2.5 }, rank: 2 },
        { r: 'blur5', xform: { blurPx: 5 }, rank: 3 },
        { r: 'lowres_crisp', xform: { outW: 480, outH: 320 }, rank: 1 }
      ].forEach(function (bl) {
        specs.push({
          id: 'blur/' + scene.name + '/' + bl.r, category: 'blur', sceneName: scene.name,
          sceneId: baseSceneId, trueGroup: baseSceneId, set: 'blur/' + scene.name,
          role: bl.r, scene: baseScene, xform: bl.xform,
          truth: bl.rank === 0 ? 'sharpest' : 'degraded', blurRank: bl.rank,
          _sample: scene.name === 'S0'
        });
      });

      // ---- chain: 8-frame pan, neighbours near-identical, ends unrelated ---
      for (var k = 0; k < 8; k++) {
        specs.push({
          id: 'chain/' + scene.name + '/c' + k, category: 'chain', sceneName: scene.name,
          sceneId: scene.name + '/chain', trueGroup: scene.name + '/chain/' + k,
          set: 'chain/' + scene.name, role: 'c' + k, chainStep: k,
          scene: {
            seed: scene.seed + CHAIN_SEED_OFF, camera: { panX: k * 0.055, panY: 0, zoom: 1 },
            exposure: 1 + k * 0.004, grainSeed: 8300 + si * 11 + k,
            subject: subjectFor(scene, 'medium', { x: scene.x + k * 0.055, expression: 'neutral' })
          },
          _sample: scene.name === 'S0'
        });
      }
    });

    // sample a couple of burst / expression sets for visual inspection
    specs.forEach(function (s) {
      if (s.set === 'burst_tight/S0/medium' || s.set === 'burst_loose/S0/medium' ||
          s.set === 'expression/S0/portrait' || s.set === 'expression/S0/wide') s._sample = true;
    });

    return specs;
  }

  async function build(onProgress) {
    var specs = buildSpecs();
    var records = [], samples = [];
    for (var i = 0; i < specs.length; i++) {
      var out = await processSpec(specs[i]);
      records.push(out.rec);
      if (out.sample) samples.push(out.sample);
      if (onProgress && i % 10 === 0) onProgress(i, specs.length);
      if (i % 20 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
    return { records: records, samples: samples, scales: Object.keys(SCALES) };
  }

  global.Corpus = {
    build: build, buildSpecs: buildSpecs, SCENES: SCENES, SCALES: SCALES,
    BASE_W: BASE_W, BASE_H: BASE_H, THUMB_EDGE: THUMB_EDGE
  };
})(window);
