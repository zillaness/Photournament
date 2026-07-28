/**
 * analysis.js — PROBE ONLY. Ground-truth labelling, distance distributions,
 * threshold sweeps, clustering-mode comparison and nomination trials.
 *
 * Everything here calls the SHIPPING module through window.PT.phash. No copy of
 * the algorithm lives in this file.
 *
 * Global: window.Analysis
 */
(function (global) {
  'use strict';

  function PH() { return global.PT.phash; }

  var HASH_FIELDS = ['dhash', 'phash', 'dhashThumb', 'phashThumb'];

  // ---------------------------------------------------------------------------
  // Ground truth
  // ---------------------------------------------------------------------------

  /** Identity of the underlying captured photograph a record is a rendition of. */
  function photoOf(r) {
    switch (r.category) {
      case 'base': case 'reencode': case 'geom_minor': case 'geom_major':
        return 'P/' + r.scene + '/base';
      case 'recompose':
        return 'P/' + r.scene + '/recompose';
      case 'nominate':
        return 'P/' + r.scene + '/' + r.nomSet.split('/')[2];
      case 'subject_move':
        return 'P/' + r.scene + '/moved';
      case 'chain':
        return 'P/chain/' + r.chainStep;
      default:
        return 'P/' + r.id;   // every burst and expression frame is its own capture
    }
  }

  /** Variant class inside one photo identity. */
  function variantOf(r) {
    if (r.category === 'nominate') return r.role === 'lowres_crisp' ? 'lowres' : 'blur';
    if (r.category === 'geom_major') return 'geom_major';
    if (r.category === 'geom_minor') return 'geom_minor';
    if (r.category === 'reencode') return 'reencode';
    return 'original';
  }

  /**
   * Label a pair.
   *   POS_*  should end up in the same near-duplicate group
   *   NEG_*  must not
   *   AMB_*  reported but excluded from the headline error rates, because
   *          reasonable people disagree about whether they belong together
   */
  function labelPair(a, b) {
    var pa = photoOf(a), pb = photoOf(b);

    if (pa === pb) {
      var va = variantOf(a), vb = variantOf(b);
      if (va === 'blur' || vb === 'blur' || va === 'lowres' || vb === 'lowres') return 'AMB_degraded';
      if (va === 'geom_major' || vb === 'geom_major') return 'AMB_geom_major';
      if (va === 'geom_minor' || vb === 'geom_minor') return 'POS_geom_minor';
      return 'POS_reencode';
    }

    if (a.set === b.set) {
      if (a.category === 'burst_tight') return 'POS_burst_tight/' + a.scale;
      if (a.category === 'burst_loose') return 'POS_burst_loose/' + a.scale;
      if (a.category === 'expression') return 'POS_expression/' + a.scale;
    }

    if (a.category === 'chain' && b.category === 'chain') {
      var d = Math.abs(a.chainStep - b.chainStep);
      // A 5.5%-of-frame pan per step. One step apart is a judgement call, so it
      // is reported but kept out of the headline error rates; four or more
      // steps (>= 22% pan) is unambiguously a different photograph.
      if (d === 1) return 'AMB_chain_adjacent';
      if (d >= 4) return 'NEG_chain_far';
      return 'AMB_chain_mid';
    }

    if (a.scene === b.scene && a.category !== 'chain' && b.category !== 'chain') {
      if (pa.indexOf('/recompose') > 0 || pb.indexOf('/recompose') > 0) return 'NEG_recompose';
      // Same subject appearance, different terrain seed.
      return 'NEG_same_subject_diff_scene';
    }

    return 'NEG_unrelated';
  }

  function kindOf(label) { return label.slice(0, 3); }

  // ---------------------------------------------------------------------------
  // Stats helpers
  // ---------------------------------------------------------------------------

  function summarise(values) {
    if (!values.length) return null;
    var v = values.slice().sort(function (x, y) { return x - y; });
    function q(p) { return v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]; }
    var sum = 0;
    for (var i = 0; i < v.length; i++) sum += v[i];
    return {
      n: v.length, min: v[0], p05: q(0.05), p25: q(0.25), median: q(0.5),
      p75: q(0.75), p95: q(0.95), max: v[v.length - 1],
      mean: +(sum / v.length).toFixed(2)
    };
  }

  // ---------------------------------------------------------------------------
  // Pairwise distances
  // ---------------------------------------------------------------------------

  function allPairs(records) {
    var ph = PH();
    var pairs = [];
    for (var i = 0; i < records.length; i++) {
      for (var j = i + 1; j < records.length; j++) {
        var a = records[i], b = records[j];
        var p = { a: a.id, b: b.id, label: labelPair(a, b) };
        for (var f = 0; f < HASH_FIELDS.length; f++) {
          p[HASH_FIELDS[f]] = ph.hamming(a[HASH_FIELDS[f]], b[HASH_FIELDS[f]]);
        }
        pairs.push(p);
      }
    }
    return pairs;
  }

  function distributionByLabel(pairs) {
    var byLabel = {};
    pairs.forEach(function (p) {
      (byLabel[p.label] || (byLabel[p.label] = [])).push(p);
    });
    var out = {};
    Object.keys(byLabel).sort().forEach(function (lab) {
      out[lab] = { kind: kindOf(lab), n: byLabel[lab].length };
      HASH_FIELDS.forEach(function (f) {
        out[lab][f] = summarise(byLabel[lab].map(function (p) { return p[f]; }));
      });
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Threshold sweep
  // ---------------------------------------------------------------------------

  /**
   * Sweep every threshold 0..40 and count pair-level errors.
   * POS pairs at distance > t are false negatives (a burst that fails to group).
   * NEG pairs at distance <= t are false positives (unrelated photos grouped).
   * AMB pairs are counted but reported separately.
   */
  function thresholdSweep(pairs, field, opts) {
    opts = opts || {};
    var excludeLabels = opts.excludeLabels || [];
    var rows = [];
    var pos = [], neg = [];
    pairs.forEach(function (p) {
      if (excludeLabels.indexOf(p.label) >= 0) return;
      if (p.label.slice(0, 3) === 'POS') pos.push(p[field]);
      else if (p.label.slice(0, 3) === 'NEG') neg.push(p[field]);
    });
    for (var t = 0; t <= 40; t++) {
      var tp = 0, fn = 0, fp = 0, tn = 0, i;
      for (i = 0; i < pos.length; i++) { if (pos[i] <= t) tp++; else fn++; }
      for (i = 0; i < neg.length; i++) { if (neg[i] <= t) fp++; else tn++; }
      rows.push({
        t: t, tp: tp, fn: fn, fp: fp, tn: tn,
        fnr: pos.length ? +(fn / pos.length).toFixed(4) : 0,
        fpr: neg.length ? +(fp / neg.length).toFixed(6) : 0,
        precision: (tp + fp) ? +(tp / (tp + fp)).toFixed(4) : 1,
        recall: pos.length ? +(tp / pos.length).toFixed(4) : 1,
        f1: (2 * tp + fp + fn) ? +((2 * tp) / (2 * tp + fp + fn)).toFixed(4) : 0,
        youden: +((pos.length ? tp / pos.length : 0) - (neg.length ? fp / neg.length : 0)).toFixed(4)
      });
    }
    return { nPos: pos.length, nNeg: neg.length, rows: rows };
  }

  // ---------------------------------------------------------------------------
  // Clustering
  // ---------------------------------------------------------------------------

  function itemsFor(records, field) {
    return records.map(function (r) {
      return { id: r.id, hash: r[field], w: r.w, h: r.h, sharp: r.sharp };
    });
  }

  /** Pair-level precision/recall of a clustering against the pair labels. */
  function scoreClustering(groups, pairs) {
    var groupOf = {};
    groups.forEach(function (g, gi) { g.forEach(function (id) { groupOf[id] = gi; }); });
    var tp = 0, fp = 0, fn = 0, ambTogether = 0, ambApart = 0;
    pairs.forEach(function (p) {
      var together = groupOf[p.a] === groupOf[p.b];
      var k = kindOf(p.label);
      if (k === 'POS') { if (together) tp++; else fn++; }
      else if (k === 'NEG') { if (together) fp++; }
      else { if (together) ambTogether++; else ambApart++; }
    });
    return {
      groups: groups.length,
      nonSingleton: groups.filter(function (g) { return g.length > 1; }).length,
      largest: groups.reduce(function (m, g) { return Math.max(m, g.length); }, 0),
      tp: tp, fp: fp, fn: fn,
      precision: (tp + fp) ? +(tp / (tp + fp)).toFixed(4) : 1,
      recall: (tp + fn) ? +(tp / (tp + fn)).toFixed(4) : 1,
      ambTogether: ambTogether, ambApart: ambApart
    };
  }

  function diameters(groups, records, field) {
    var ph = PH();
    var byId = {};
    records.forEach(function (r) { byId[r.id] = r; });
    return groups.map(function (g) {
      var d = 0;
      for (var i = 0; i < g.length; i++) {
        for (var j = i + 1; j < g.length; j++) {
          var v = ph.hamming(byId[g[i]][field], byId[g[j]][field]);
          if (v > d) d = v;
        }
      }
      return d;
    });
  }

  function clusterReport(records, pairs, field, thresholds, modes) {
    var ph = PH();
    var items = itemsFor(records, field);
    var out = [];
    modes.forEach(function (mode) {
      thresholds.forEach(function (t) {
        var t0 = performance.now();
        var groups = ph.cluster(items, { threshold: t, mode: mode });
        var ms = performance.now() - t0;
        var sc = scoreClustering(groups, pairs);
        var dia = diameters(groups, records, field);
        sc.mode = mode; sc.threshold = t; sc.ms = +ms.toFixed(2);
        sc.maxDiameter = dia.reduce(function (m, d) { return Math.max(m, d); }, 0);
        out.push(sc);
      });
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Chain / transitivity
  // ---------------------------------------------------------------------------

  function chainReport(records, field, thresholds) {
    var ph = PH();
    var chain = records.filter(function (r) { return r.category === 'chain'; })
      .sort(function (a, b) { return a.chainStep - b.chainStep; });
    var matrix = chain.map(function (a) {
      return chain.map(function (b) { return ph.hamming(a[field], b[field]); });
    });
    var items = itemsFor(chain, field);
    var modes = {};
    ['union', 'strict'].forEach(function (mode) {
      modes[mode] = thresholds.map(function (t) {
        var groups = ph.cluster(items, { threshold: t, mode: mode });
        var dia = diameters(groups, chain, field);
        return {
          threshold: t,
          groups: groups.map(function (g) {
            return g.map(function (id) { return id.replace('chain/', ''); });
          }),
          maxDiameter: dia.reduce(function (m, d) { return Math.max(m, d); }, 0)
        };
      });
    });
    return { ids: chain.map(function (r) { return r.id; }), matrix: matrix, modes: modes };
  }

  /** Explicit A~B~C where A-C exceeds the threshold: count such triples. */
  function transitivityTriples(records, field, threshold) {
    var ph = PH();
    var n = records.length;
    var d = [];
    for (var i = 0; i < n; i++) {
      d.push([]);
      for (var j = 0; j < n; j++) d[i].push(i === j ? 0 : ph.hamming(records[i][field], records[j][field]));
    }
    var broken = 0, total = 0, examples = [];
    for (var a = 0; a < n; a++) {
      for (var b = 0; b < n; b++) {
        if (b === a || d[a][b] > threshold) continue;
        for (var c = a + 1; c < n; c++) {
          if (c === b || d[b][c] > threshold) continue;
          total++;
          if (d[a][c] > threshold) {
            broken++;
            if (examples.length < 8) {
              examples.push({
                a: records[a].id, b: records[b].id, c: records[c].id,
                ab: d[a][b], bc: d[b][c], ac: d[a][c]
              });
            }
          }
        }
      }
    }
    return { threshold: threshold, triples: total, nonTransitive: broken, examples: examples };
  }

  // ---------------------------------------------------------------------------
  // Nomination
  // ---------------------------------------------------------------------------

  function subsets(arr) {
    var out = [];
    for (var mask = 1; mask < (1 << arr.length); mask++) {
      var s = [];
      for (var i = 0; i < arr.length; i++) if (mask & (1 << i)) s.push(arr[i]);
      out.push(s);
    }
    return out;
  }

  /**
   * Every nomination set is one sharp full-resolution original plus three
   * degraded siblings. A trial is the original plus any non-empty subset of the
   * degraded siblings; the original is the ground-truth answer in all of them.
   */
  function nomSets(records) {
    var sets = {};
    records.forEach(function (r) {
      if (!r.nomSet) return;
      if (!sets[r.nomSet]) sets[r.nomSet] = { sharp: null, degraded: [] };
      if (r.nomRole === 'sharp') sets[r.nomSet].sharp = r;
      else sets[r.nomSet].degraded.push(r);
    });
    return sets;
  }

  /**
   * Run every trial once, with `sharpField` deciding whether sharpness was
   * measured on the full-resolution decode or on the 320px thumbnail. The
   * thumbnail run is the one that matters: it is what the app will actually
   * have at hand after PRD 7.9 ingest.
   */
  function nominationRun(records, sharpField, weightVariants) {
    var ph = PH();
    var sets = nomSets(records);
    var trials = [];

    Object.keys(sets).sort().forEach(function (key) {
      var s = sets[key];
      if (!s.sharp) return;
      subsets(s.degraded).forEach(function (sub) {
        var members = [s.sharp].concat(sub).map(function (r) {
          return { id: r.id, w: r.w, h: r.h, sharp: r[sharpField] };
        });
        // Reverse-sort by id so the truth is never first in the array: any
        // accidental first-wins behaviour would show up as a failure.
        members.sort(function (a, b) { return a.id < b.id ? 1 : -1; });
        var picked = ph.nominate(members);
        trials.push({
          set: key, size: members.length, truth: s.sharp.id, picked: picked,
          correct: picked === s.sharp.id,
          composition: sub.map(function (r) { return r.role; }).sort().join('+')
        });
      });
    });

    // Weight-variant controls. A variant only scores a trial as correct if the
    // truth is the UNIQUE maximum: a variant that ties and then wins on a
    // tie-break has not actually decided anything.
    var byVariant = {};
    (weightVariants || []).forEach(function (wv) {
      var right = 0, tied = 0, n = 0;
      Object.keys(sets).sort().forEach(function (key) {
        var s = sets[key];
        if (!s.sharp) return;
        subsets(s.degraded).forEach(function (sub) {
          n++;
          var members = [s.sharp].concat(sub);
          var maxS = 0, maxP = 0;
          members.forEach(function (r) {
            if (r[sharpField] > maxS) maxS = r[sharpField];
            if (r.w * r.h > maxP) maxP = r.w * r.h;
          });
          maxS = maxS || 1; maxP = maxP || 1;
          var scores = members.map(function (r) {
            return wv.ws * (r[sharpField] / maxS) + wv.wr * ((r.w * r.h) / maxP);
          });
          var best = -Infinity, bestI = -1, ties = 0;
          scores.forEach(function (sc, i) {
            if (sc > best + 1e-12) { best = sc; bestI = i; ties = 1; }
            else if (Math.abs(sc - best) <= 1e-12) ties++;
          });
          if (ties > 1) tied++;
          else if (members[bestI].id === s.sharp.id) right++;
        });
      });
      byVariant[wv.name] = { trials: n, uniquelyCorrect: right, undecidedTies: tied };
    });

    var correct = trials.filter(function (t) { return t.correct; }).length;
    return {
      sharpField: sharpField,
      nSets: Object.keys(sets).length,
      trials: trials.length, correct: correct,
      accuracy: +(correct / trials.length).toFixed(4),
      bySize: [2, 3, 4].map(function (n2) {
        var t = trials.filter(function (x) { return x.size === n2; });
        return { size: n2, n: t.length, correct: t.filter(function (x) { return x.correct; }).length };
      }),
      wrong: trials.filter(function (t) { return !t.correct; }),
      variants: byVariant
    };
  }

  /** Is the sharpness metric monotonic in blur radius, per ladder? */
  function sharpnessMonotonicity(records) {
    var sets = nomSets(records);
    var rows = [];
    Object.keys(sets).sort().forEach(function (key) {
      var s = sets[key];
      if (!s.sharp) return;
      var byRole = {};
      s.degraded.forEach(function (r) { byRole[r.role] = r; });
      ['sharp', 'sharpThumb'].forEach(function (f) {
        rows.push({
          set: key, field: f,
          orderedFullRes: s.sharp[f] > byRole.blur1_5[f] && byRole.blur1_5[f] > byRole.blur4[f],
          origin: +s.sharp[f].toFixed(4),
          blur1_5: +byRole.blur1_5[f].toFixed(4),
          blur4: +byRole.blur4[f].toFixed(4),
          lowresCrisp: +byRole.lowres_crisp[f].toFixed(4),
          lowresBeatsOriginal: byRole.lowres_crisp[f] >= s.sharp[f]
        });
      });
    });
    return rows;
  }

  /**
   * Where does the resolution term flip the decision? Closed form for the
   * shipped score, so the weight choice can be read rather than guessed.
   *
   * A full-size frame with relative sharpness q beats a smaller frame that is
   * the group's sharpest (q = 1) with pixel ratio r when
   *     ws*q + wr*1  >  ws*1 + wr*r    i.e.   q > 1 - (wr/ws)*(1 - r)
   */
  function resolutionCrossover(ws, wr, ratios) {
    return ratios.map(function (r) {
      return { pixelRatio: r, sharpnessNeeded: +(1 - (wr / ws) * (1 - r)).toFixed(4) };
    });
  }

  function nominationTrials(records, weightVariants) {
    var ph = PH();
    var i = ph._internal;
    return {
      full: nominationRun(records, 'sharp', weightVariants),
      thumb: nominationRun(records, 'sharpThumb', weightVariants),
      monotonicity: sharpnessMonotonicity(records),
      crossover: resolutionCrossover(
        i.NOMINATE_SHARP_WEIGHT, i.NOMINATE_RES_WEIGHT,
        [1, 0.5, 0.25, 0.16, 0.0625, 0.01]
      ),
      ladder: Object.keys(nomSets(records)).sort().map(function (key) {
        var s = nomSets(records)[key];
        return {
          set: key,
          members: [s.sharp].concat(s.degraded).map(function (r) {
            return {
              role: r.role, w: r.w, h: r.h,
              sharp: +r.sharp.toFixed(4), sharpThumb: +r.sharpThumb.toFixed(4)
            };
          })
        };
      })
    };
  }

  // ---------------------------------------------------------------------------

  global.Analysis = {
    HASH_FIELDS: HASH_FIELDS,
    photoOf: photoOf,
    variantOf: variantOf,
    labelPair: labelPair,
    allPairs: allPairs,
    distributionByLabel: distributionByLabel,
    thresholdSweep: thresholdSweep,
    clusterReport: clusterReport,
    chainReport: chainReport,
    transitivityTriples: transitivityTriples,
    nominationTrials: nominationTrials,
    summarise: summarise,
    itemsFor: itemsFor,
    scoreClustering: scoreClustering
  };
})(window);
