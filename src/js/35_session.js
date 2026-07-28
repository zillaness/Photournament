/**
 * @file 35_session.js
 * @version 1.1
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description Session model and stage flow for Photournament: settings defaults, tournament unit state, quota resolution, pass bookkeeping, and persistence shaping.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * The single source of truth for where the user is and what they have decided.
 * Screens read from here and dispatch through here; they never hold stage state
 * of their own. That is what makes PRD 7.10's mid-pass resume possible — the
 * position within a Stage A pass lives in the store, not in a screen's closure.
 *
 * Blobs (thumbnails, previews) are deliberately NOT part of the persisted
 * session. They live in the `derivatives` object store keyed by photo id, so a
 * save stays small at 500 photos, and an evicted cache costs re-derivation
 * rather than lost decisions.
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});

  /** PRD section 12 settings summary. Every default here is from that table. */
  var DEFAULTS = {
    gridSize: 9,                 // 6 | 9 | 12 | 16
    quotaMode: 'half',           // 'one' | 'half' | 'custom' | 'unlimited'
    quotaCustom: 4,
    shuffle: true,
    cullFloor: 0.25,             // 0 disables (PRD 7.2)
    stageD: false,               // cross-category final, off by default
    stageDTarget: 10,
    prefixes: true,              // ordered filename prefixes
    outputStructure: 'mirror',   // 'mirror' | 'flat'
    distribution: 'weighted',    // 'weighted' | 'even'
    sidecarLocation: 'subfolder',// '_sidecars' subfolder | 'alongside'
    exportHeicAs: 'ask',         // decided per export
    dupeThreshold: 14,           // measured in tools/probes/04_phash/FINDINGS.md
    dupeMode: 'strict'
  };

  var PHASES = ['gridA', 'rescue', 'dupes', 'bracket', 'runoff', 'done'];

  function newSession(rootName, sourceKind) {
    return {
      id: 'sess-' + Date.now().toString(36),
      createdAt: Date.now(),
      rootName: rootName || 'photos',
      sourceKind: sourceKind || 'files',   // 'handle' = can resume and write to disk
      settings: Object.assign({}, DEFAULTS),
      allocs: {},                          // path -> {mode, value}
      stage: 'ingest',                     // ingest | tree | unit | stageD | export | done
      activeUnitId: null,
      units: {},                           // unitId -> unit state
      stageDUnit: null,
      finished: false
    };
  }

  /**
   * Fresh per-unit state. `pool` is the live field; `cut` is everything Stage A
   * has rejected, which the rescue screen reads (PRD 7.5).
   */
  function newUnit(u) {
    return {
      id: u.id,
      kind: u.kind,                // fixed | pooled | uncapped
      label: u.label,
      target: u.target,            // null when uncapped
      allIds: u.photoIds.slice(),
      pool: u.photoIds.slice(),
      cut: [],
      rescued: [],
      phase: 'gridA',
      passes: [],                  // completed pass summaries
      currentPass: null,           // live pass, persisted so resume works mid-pass
      groups: null,                // near-duplicate groups once reviewed
      bracket: null,
      winners: [],
      startedAt: Date.now(),
      comparisons: 0
    };
  }

  /**
   * PRD 7.1 quota, resolved for a given screen size.
   * Returns Infinity for unlimited so callers can compare without special-casing.
   */
  function resolveQuota(settings, screenCount) {
    switch (settings.quotaMode) {
      case 'one':       return 1;
      case 'half':      return Math.max(1, Math.floor(screenCount / 2));
      case 'custom':    return Math.max(1, Math.min(settings.quotaCustom, screenCount));
      case 'unlimited': return Infinity;
      default:          return Math.max(1, Math.floor(screenCount / 2));
    }
  }

  function quotaLabel(settings) {
    switch (settings.quotaMode) {
      case 'one':       return 'Keep 1';
      case 'half':      return 'Keep up to half';
      case 'custom':    return 'Keep up to ' + settings.quotaCustom;
      case 'unlimited': return 'Unlimited';
      default:          return 'Keep up to half';
    }
  }

  /**
   * Deterministic shuffle so a resumed pass deals the same screens in the same
   * order. A Math.random() shuffle would reorder the remaining photos on reload
   * and silently show some twice and others never.
   */
  function seededShuffle(ids, seed) {
    var a = ids.slice();
    var s = seed >>> 0 || 1;
    for (var i = a.length - 1; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      var j = s % (i + 1);
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * Begin a Stage A pass. Configuration locks here for the duration (PRD section 2):
   * the settings are COPIED into the pass, so changing a setting mid-pass cannot
   * loosen the quota the user committed to.
   */
  /**
   * Collapse the pool into DEAL SLOTS: one per reviewed near-duplicate group,
   * one per ungrouped photo. This is where "a burst costs one decision rather
   * than several" becomes literally true — Stage A shows a burst as a single
   * cell wearing its representative, and keeping or cutting it keeps or cuts
   * every member together. The members are only prised apart later, in the
   * Stage C runoff, which exists for exactly that.
   *
   * A group whose members have been separated by earlier decisions (rescue can
   * pull one member back alone) only bundles the members still in the pool;
   * with one member left it degrades to an ordinary singleton. No reviewed
   * grouping at all — the user skipped the step before it computed, or an old
   * session predates it — degrades to one slot per photo, which is exactly the
   * pre-grouping behaviour.
   *
   * @returns {Array<{face:string, members:Array<string>}>} in pool order
   */
  function slotsFor(unit) {
    var groupOf = Object.create(null);
    (unit.groups || []).forEach(function (g, gi) {
      var ids = Array.isArray(g) ? g : ((g && g.ids) || []);
      ids.forEach(function (id) { groupOf[id] = gi; });
    });
    var inPool = Object.create(null);
    unit.pool.forEach(function (id) { inPool[id] = 1; });

    var done = Object.create(null);
    var slots = [];
    unit.pool.forEach(function (id) {
      if (done[id]) return;
      var gi = groupOf[id];
      if (gi === undefined) {
        done[id] = 1;
        slots.push({ face: id, members: [id] });
        return;
      }
      var g = unit.groups[gi];
      var ids = (Array.isArray(g) ? g : g.ids).filter(function (m) { return inPool[m]; });
      ids.forEach(function (m) { done[m] = 1; });
      if (ids.length < 2) {
        slots.push({ face: id, members: [id] });
        return;
      }
      var rep = (!Array.isArray(g) && g.rep && inPool[g.rep]) ? g.rep : ids[0];
      slots.push({ face: rep, members: ids });
    });
    return slots;
  }

  function startPass(unit, settings) {
    var seed = (Date.now() ^ (unit.passes.length * 2654435761)) >>> 0;
    // The pass deals slots, not photos: order holds one FACE per slot, and
    // pass.slots remembers each face's members as they were at deal time, so
    // the expansion at pass end is stable even if the grouping is edited
    // mid-pass.
    var slots = slotsFor(unit);
    var faces = slots.map(function (sl) { return sl.face; });
    var members = Object.create(null);
    slots.forEach(function (sl) { members[sl.face] = sl.members; });
    return {
      n: unit.passes.length + 1,
      gridSize: settings.gridSize,
      quotaMode: settings.quotaMode,
      quotaCustom: settings.quotaCustom,
      shuffled: settings.shuffle,
      seed: seed,
      order: settings.shuffle ? seededShuffle(faces, seed) : faces,
      slots: members,
      index: 0,               // screens completed
      kept: [],               // FACE ids kept so far this pass
      startedAt: Date.now(),
      fieldAtStart: unit.pool.length
    };
  }

  /** A face back to its members. Old sessions' passes have no slot map. */
  function expandSlot(pass, faceId) {
    return (pass && pass.slots && pass.slots[faceId]) || [faceId];
  }

  function screenAt(pass, i) {
    var start = i * pass.gridSize;
    return pass.order.slice(start, start + pass.gridSize);
  }

  function screensTotal(pass) {
    return Math.ceil(pass.order.length / pass.gridSize);
  }

  /**
   * Fold a completed pass back into the unit and produce the summary PRD 7.2
   * reports on. Everything not kept is cut, which is the forcing function the
   * whole tool exists to provide.
   */
  function finishPass(unit, pass) {
    var keptSet = Object.create(null);
    pass.kept.forEach(function (id) { keptSet[id] = 1; });

    // kept/order hold slot faces; the pool and the cut pile hold photos, so a
    // kept burst carries every member forward and a cut burst loses them all —
    // one decision, honestly accounted. Every summary number below is photos,
    // not decisions, because the summary is about the collection.
    var keptIds = [], cutNow = [];
    pass.kept.forEach(function (face) {
      expandSlot(pass, face).forEach(function (id) { keptIds.push(id); });
    });
    pass.order.forEach(function (face) {
      if (keptSet[face]) return;
      expandSlot(pass, face).forEach(function (id) { cutNow.push(id); });
    });

    var before = pass.fieldAtStart;
    var after = keptIds.length;

    var summary = {
      n: pass.n,
      gridSize: pass.gridSize,
      quotaMode: pass.quotaMode,
      quotaCustom: pass.quotaCustom,
      shuffled: pass.shuffled,
      before: before,
      after: after,
      cut: cutNow.length,
      cutPct: before ? cutNow.length / before : 0,
      screens: screensTotal(pass),
      ms: Date.now() - pass.startedAt
    };

    unit.pool = keptIds;
    unit.cut = unit.cut.concat(cutNow);
    unit.passes.push(summary);
    unit.currentPass = null;
    return summary;
  }

  /**
   * PRD 7.2: the low cull rate warning fires at the end of a completed pass, and
   * is unrelated to stopping early. A floor of 0 disables it.
   */
  function lowCullRate(summary, settings) {
    if (!settings.cullFloor) return false;
    return summary.cutPct < settings.cullFloor;
  }

  /**
   * PRD 7.1 handoff: for a fixed target, suggest moving to the bracket at roughly
   * 2 to 3 times the target. Uncapped units get no suggestion.
   */
  function bracketSuggestion(unit) {
    if (unit.target == null) return null;
    var lo = unit.target * 2, hi = unit.target * 3;
    if (unit.pool.length <= hi) {
      return {
        ready: true,
        message: unit.pool.length + ' left against a target of ' + unit.target +
                 '. That is small enough for a bracket.'
      };
    }
    return {
      ready: false,
      message: unit.pool.length + ' left. Another pass or two gets you toward ' + lo + '–' + hi + '.'
    };
  }

  /** The units still needing work, in a stable order. */
  function pendingUnits(session) {
    return Object.keys(session.units)
      .map(function (k) { return session.units[k]; })
      .filter(function (u) { return u.phase !== 'done'; });
  }

  function allUnitsDone(session) {
    var ks = Object.keys(session.units);
    return ks.length > 0 && ks.every(function (k) { return session.units[k].phase === 'done'; });
  }

  /** Union of every unit's winners — the field for the optional Stage D (PRD 7.6). */
  function allWinners(session) {
    var out = [];
    Object.keys(session.units).forEach(function (k) {
      session.units[k].winners.forEach(function (id) { if (out.indexOf(id) < 0) out.push(id); });
    });
    return out;
  }

  /**
   * What gets written to IndexedDB. Photo records are stripped of their Blobs;
   * derivatives live in their own store. PRD 7.10 needs decisions to survive even
   * when the evictable cache does not.
   */
  PT.serializeSession = function (state) {
    return state.session;
  };

  PT.session = {
    DEFAULTS: DEFAULTS,
    PHASES: PHASES,
    newSession: newSession,
    newUnit: newUnit,
    resolveQuota: resolveQuota,
    quotaLabel: quotaLabel,
    seededShuffle: seededShuffle,
    slotsFor: slotsFor,
    expandSlot: expandSlot,
    startPass: startPass,
    screenAt: screenAt,
    screensTotal: screensTotal,
    finishPass: finishPass,
    lowCullRate: lowCullRate,
    bracketSuggestion: bracketSuggestion,
    pendingUnits: pendingUnits,
    allUnitsDone: allUnitsDone,
    allWinners: allWinners
  };
})();

/** CHANGELOG
 * v1.0 (2026-07-28): Initial release. Settings defaults from PRD section 12,
 *   unit state, quota resolution, deterministic seeded shuffle so a resumed pass
 *   deals identically, pass lifecycle with locked configuration, low cull rate
 *   check, and bracket handoff suggestion.
  * v1.2 (2026-07-28): Bundled bursts. slotsFor() collapses the pool into deal
 *   slots — one per reviewed near-duplicate group, wearing its representative —
 *   and startPass deals faces with a frozen slot map, so a burst is one
 *   decision. finishPass expands kept and cut faces back to photos, keeping
 *   every summary number in photos.
*/
