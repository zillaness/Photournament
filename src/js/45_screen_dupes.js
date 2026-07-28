/**
 * @file 45_screen_dupes.js
 * @version 1.1
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description PRD 7.7 near-duplicate grouping review: live sensitivity slider stepping by 2, scrollable review of every group with all members, manual split / merge / remove / confirm, and one-click representative override that leaves the rest of the group attached for Stage C.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN IS FOR
 * ---------------------------------------------------------------------------
 * Grouping was already computed and used silently. A wrong group only surfaced
 * in Stage C, where the only recourse was the multi-keep escape hatch. This
 * screen puts the grouping in front of the user before any culling happens, so
 * a bad group is fixed once rather than worked around later.
 *
 * ---------------------------------------------------------------------------
 * THE THREE MEASURED FACTS THIS SCREEN IS BUILT AROUND
 * ---------------------------------------------------------------------------
 * All from tools/probes/04_phash/FINDINGS.md, re-verified in this build by
 * tests/dupes_e2e.mjs rather than taken on trust.
 *
 * 1. pHash IS A CONSTANT-WEIGHT CODE. Every value PT.phash.phash() returns has
 *    exactly 31 one-bits, which forces every pairwise distance to be EVEN.
 *    Odd thresholds are therefore dead stops: 15 behaves exactly like 14.
 *    THE SLIDER STEPS BY 2. This is the single most important detail on the
 *    screen — a step of 1 means the user drags and nothing happens half the
 *    time, which reads as a broken control.
 *
 * 2. THE DEFAULT IS threshold 14, mode 'strict'. Measured precision 1.000 and
 *    recall 1.000 over 7,381 labelled pairs. `strict` is complete linkage: a
 *    photo joins a group only if it is within the threshold of EVERY member, so
 *    a group's diameter can never exceed the number on the slider and the
 *    slider means exactly what it says. `union` (single linkage) reaches the
 *    same scores at 14 but degrades catastrophically two steps later — at 20 it
 *    had merged 93 of 122 photos into one group, against strict's 33 groups.
 *    Strict is kept as the default because ITS FAILURE MODE IS THE RECOVERABLE
 *    ONE: it over-splits, and splitting is fixed by a merge button. Union
 *    over-merges, and the user has to take a wrong group apart member by
 *    member. `union` is still offered, because linkage is a product decision
 *    and some users would rather see too much than too little.
 *
 * 3. cluster() COSTS 0.4 ms STRICT AT 500 ITEMS (1.5 ms union). That is far
 *    inside a frame, so the slider re-clusters on every `input` event with NO
 *    debounce and no worker. It should feel like the groups are attached to
 *    the thumb, because they are.
 *
 * ---------------------------------------------------------------------------
 * WHICH HASH THIS SCREEN CLUSTERS ON, AND WHY IT RECOMPUTES ONE
 * ---------------------------------------------------------------------------
 * MEASURED IN THIS BUILD: the `phash` field on a photo record is NOT
 * PT.phash.phash(). 40_screen_ingest.js calls PT.ingest.createPool() without
 * `extraSrc`, so 20_phash.js is never injected into the worker and
 * workerPhash() falls through to the worker's own inlined dHash. Over the
 * 48-photo E2E corpus those stored hashes had one-bit weights spread across
 * 25..37 and 527 of 1,128 pairwise distances were ODD — the exact opposite of
 * the constant-weight property the step-by-2 slider depends on. Threshold 14 is
 * also the wrong number for a dHash (its clean band is 8..10; at 14 its
 * measured precision is 0.516).
 *
 * So this screen derives a real pHash itself, on the main thread, from the
 * cached 320 px thumbnail each photo already has. Measured cost is 0.67 ms of
 * hashing plus a decode per photo, paid once per session and cached back onto
 * the photo record as `ptPhash` / `ptSharp`, so a reload does not repeat it.
 * The same pass recomputes PT.phash.sharpness(), because nominate() weights
 * sharpness at 0.70 and the worker's sharpness is a different metric on a
 * different plane. Photos whose thumbnail has been evicted fall back to the
 * stored hash, and the screen says so rather than quietly mixing two hash
 * families without telling anyone.
 *
 * ---------------------------------------------------------------------------
 * HOW MANUAL EDITS SURVIVE A THRESHOLD CHANGE
 * ---------------------------------------------------------------------------
 * This is the design decision the feature lives or dies on. A user splits a
 * group by hand, then nudges the slider, and every hand edit must still be
 * there afterwards.
 *
 * The rejected approach is to store the edited groups as RESULTS — a list of
 * lists. Re-clustering then has nothing to reconcile against: either it
 * overwrites the edit, or it refuses to touch edited groups and the slider
 * silently stops working on half the screen. Both are worse than not shipping
 * the slider.
 *
 * So manual edits are stored as CONSTRAINTS OVER PHOTO PAIRS, never as groups:
 *
 *     link["<idA>|<idB>"] = +1   must-link  — the user merged these
 *     link["<idA>|<idB>"] = -1   cannot-link — the user split these apart
 *     removed[id]                 — the user pulled this photo out entirely
 *     reps[id]                    — the user pinned this photo as representative
 *
 * Every recompute is: cluster fresh at the current threshold, then replay the
 * constraints on top. Splits are applied first (partition each auto group so no
 * cannot-link pair shares a bucket), then merges (union any groups joined by a
 * must-link). Photo ids are stable, so the constraints outlive any amount of
 * re-clustering, re-sorting or threshold dragging — which is exactly what a
 * result-shaped store cannot do.
 *
 * Two consequences worth stating plainly:
 *   - A pair can only hold one constraint, so the LAST edit to a pair wins.
 *     Splitting a group first clears the must-links among its members and vice
 *     versa, so "split then merge then split" behaves the way it reads.
 *   - Merges are applied after splits, so when a must-link and a cannot-link
 *     conflict TRANSITIVELY (a~b and b~c merged, a-c split), together wins.
 *     Keeping photos together is the recoverable direction: the user can see
 *     the extra member and split it out again.
 *
 * `Confirm` on a group is not just a checkmark — it writes must-links across
 * the group, which is what makes a confirmed group immune to the slider. That
 * is the whole point of confirming something before you go and move a control
 * that could take it apart.
 *
 * ---------------------------------------------------------------------------
 * WHAT STAGE C GETS
 * ---------------------------------------------------------------------------
 * runoffGroups() in 70_screen_bracket.js reads `unit.groups` and accepts either
 * a bare array of ids or an object with an `.ids` array. This screen writes the
 * object form, `{ids, rep}`, restricted to that unit's own photos, so the
 * runoff opens on the reviewed grouping instead of re-clustering the ingest
 * dHash at a threshold that was never calibrated for it. Every member stays in
 * the group — nominating a representative does not detach the others, because
 * the runoff's whole job is to let the user reconsider the frames the burst
 * lost (PRD 7.4).
 *
 * The review itself lives in `s.session.groups` so it survives a reload.
 *
 * ---------------------------------------------------------------------------
 * WHY EXCLUDED FOLDERS CANNOT APPEAR HERE
 * ---------------------------------------------------------------------------
 * PRD 7.7 requires that excluded folders (PRD 4.5) are never hashed and never
 * appear in a group. This screen does not filter them out — it never sees them.
 * The photo set is the union of the tournament units' `allIds`, and
 * 30_tree.js's makeUnit() walks the subtree skipping every excluded node, so an
 * excluded folder contributes no unit and no ids. Nothing to filter, and no
 * filter to forget to update.
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});
  var el = PT.dom.el;

  var HASH_LEN = 16;
  var STEP = 2;                                   // fact 1: pHash distances are even
  var RANGE = (PT.phash && PT.phash.THRESHOLD_RANGE) || [4, 20];

  /**
   * The distance at which the INGEST dHash is trusted enough to interrupt the
   * user with a review screen.
   *
   * The gate and the grouping are deliberately not the same test. Grouping,
   * once the screen is open, is pure pHash / strict / 14 as measured. But
   * OPENING the screen costs the user a stop in the flow, so it is gated on the
   * higher-precision signal that is already in memory: the ingest dHash at its
   * own measured clean threshold. FINDINGS.md section 4.1 puts dHash at 10 at
   * precision 1.000 with recall 0.952 — it fires on essentially every real
   * burst (burst-tight max 2 bits, expression 0-1, re-encode 2, burst-loose 11
   * at its worst) while not firing on merely similar-looking frames.
   *
   * Two honest caveats. The recall cost is real: a loose portrait burst or a
   * 5 % crop can sit above 10 on dHash, and those sessions will not be offered
   * the review even though the review would have grouped them — Stage C still
   * catches them. And the worker's inlined dHash bilinearly samples a 32x32
   * grey plane rather than box-downsampling a 9x8 one, so FINDINGS' dHash
   * numbers transfer approximately, not exactly.
   *
   * Checking this costs nothing: the hashes are already in the store, so a
   * session with no duplicates goes tree -> grid with no async work at all,
   * exactly as it did before this file existed.
   */
  /**
   * The gate was deliberately stricter than the grouping, because the ingest
   * hash was a dHash while the grouping threshold was calibrated for pHash —
   * two hash families in one session. 40_screen_ingest.js now feeds 20_phash.js
   * into the worker, so the ingest hash IS the pHash the threshold was measured
   * against, and "is there anything to review" can mean exactly "will the review
   * show any groups".
   */
  function gateDistance() {
    var s = sess();
    var t = s && s.settings && s.settings.dupeThreshold;
    return typeof t === 'number' ? t : PT.session.DEFAULTS.dupeThreshold;
  }

  /* ====================================================================== */
  /* state access                                                           */
  /* ====================================================================== */

  function st() { return PT.store.get(); }
  function sess() { var s = st(); return s ? s.session : null; }
  function photo(id) { var s = st(); return (s && s.photos && s.photos[id]) || null; }
  function nameOf(id) { var p = photo(id); return (p && (p.name || p.path)) || id; }

  /** Units in a stable order. Stage D is a re-field of winners, not a folder. */
  function unitsList() {
    var s = sess();
    if (!s || !s.units) return [];
    return Object.keys(s.units).sort().filter(function (k) {
      return k !== 'stageD' && k !== s.stageDUnit;
    }).map(function (k) { return s.units[k]; });
  }

  /**
   * Every photo eligible for grouping. Excluded folders are absent by
   * construction — see the header.
   */
  function eligibleIds() {
    var out = [], seen = Object.create(null);
    unitsList().forEach(function (u) {
      (u.allIds || []).forEach(function (id) {
        if (seen[id]) return;
        var p = photo(id);
        if (!p || p.err) return;
        seen[id] = 1;
        out.push(id);
      });
    });
    return out;
  }

  function evenClamp(v) {
    v = Math.round(Number(v) || 0);
    if (v < RANGE[0]) v = RANGE[0];
    if (v > RANGE[1]) v = RANGE[1];
    // Snap onto the slider's own stops so a value restored from an older
    // session cannot sit on a dead odd number.
    return RANGE[0] + Math.round((v - RANGE[0]) / STEP) * STEP;
  }

  /** Create s.session.groups if this session has never had a review. */
  function ensureState() {
    var s = sess();
    if (!s) return null;
    if (!s.groups) {
      PT.store.dispatch('dupes:init', function (ss) {
        var set = ss.session.settings || {};
        ss.session.groups = {
          v: 1,
          threshold: evenClamp(set.dupeThreshold == null ? 14 : set.dupeThreshold),
          mode: set.dupeMode === 'union' ? 'union' : 'strict',
          status: 'new',            // new | review | done
          nextUnitId: null,
          link: {},                 // "<idA>|<idB>" -> +1 must-link | -1 cannot-link
          reps: {},                 // photoId -> 1, user-pinned representative
          removed: {},              // photoId -> 1, pulled out of grouping
          confirmed: {},            // groupKey -> 1
          groups: []                // materialised result, for Stage C and reload
        };
      });
    }
    return sess().groups;
  }

  /* ====================================================================== */
  /* hashes                                                                 */
  /* ====================================================================== */

  /** id -> {hash, sharp, exact}. `exact` false means the ingest hash was used. */
  var HASH = Object.create(null);

  function blobFor(id) {
    var s = st();
    var d = s && s.derivatives ? s.derivatives[id] : null;
    return d ? (d.thumb || d.preview || null) : null;
  }

  function imageDataOf(blob) {
    return createImageBitmap(blob).then(function (bm) {
      var w = bm.width, h = bm.height;
      var c = (typeof OffscreenCanvas === 'function')
        ? new OffscreenCanvas(w, h)
        : (function () { var x = document.createElement('canvas'); x.width = w; x.height = h; return x; })();
      var cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(bm, 0, 0);
      bm.close();
      var data = cx.getImageData(0, 0, w, h);
      c.width = 0; c.height = 0;      // drop the backing store now, not at GC
      return data;
    });
  }

  /**
   * Fill HASH for every id, deriving a real pHash from the cached thumbnail
   * where the photo record does not already carry one. Sequential on purpose:
   * a parallel map over 500 blobs puts 500 decoded bitmaps in flight, which is
   * the bounded-memory rule this project is built around.
   */
  function prepare(ids, onProgress) {
    var pending = [];
    var fresh = [];

    ids.forEach(function (id) {
      var p = photo(id);
      if (!p) return;
      if (typeof p.ptPhash === 'string' && p.ptPhash.length === HASH_LEN) {
        HASH[id] = { hash: p.ptPhash, sharp: p.ptSharp, exact: true };
        return;
      }
      if (HASH[id]) return;
      pending.push(id);
    });

    var done = 0;
    var total = pending.length;
    if (onProgress) onProgress(0, total);

    var chain = Promise.resolve();
    pending.forEach(function (id) {
      chain = chain.then(function () {
        var blob = blobFor(id);
        var p = photo(id);
        if (!blob) {
          // Evicted cache. The ingest hash is a different family, so grouping
          // stays possible but the screen has to admit it is mixing them.
          if (p && typeof p.phash === 'string' && p.phash.length === HASH_LEN) {
            HASH[id] = { hash: p.phash, sharp: p.sharp, exact: false };
          }
          done++;
          if (onProgress && done % 8 === 0) onProgress(done, total);
          return null;
        }
        return imageDataOf(blob).then(function (img) {
          HASH[id] = {
            hash: PT.phash.phash(img),
            sharp: PT.phash.sharpness(img),
            exact: true
          };
          fresh.push(id);
        }).catch(function (e) {
          PT.warn('dupes', 'hash failed for ' + id, e);
          if (p && typeof p.phash === 'string' && p.phash.length === HASH_LEN) {
            HASH[id] = { hash: p.phash, sharp: p.sharp, exact: false };
          }
        }).then(function () {
          done++;
          if (onProgress && done % 8 === 0) onProgress(done, total);
        });
      });
    });

    return chain.then(function () {
      if (onProgress) onProgress(total, total);
      if (!fresh.length) return null;

      // Cache onto the photo records. These are derived and re-derivable, so
      // they belong with the photo rather than in the session snapshot; writing
      // them back to the photos store is what makes a reload cheap.
      PT.store.dispatch('dupes:hashes', function (s) {
        fresh.forEach(function (id) {
          var rec = s.photos[id];
          if (!rec) return;
          rec.ptPhash = HASH[id].hash;
          rec.ptSharp = HASH[id].sharp;
        });
      }, { transient: true, silent: true });

      var s = st();
      var recs = fresh.map(function (id) { return s.photos[id]; }).filter(Boolean);
      return PT.db.putAll('photos', recs).catch(function (e) {
        PT.warn('dupes', 'could not cache hashes', e);
      });
    });
  }

  function metaOf(id) {
    var p = photo(id) || {};
    var h = HASH[id];
    return {
      id: id,
      w: p.w,
      h: p.h,
      sharp: h && h.sharp != null ? h.sharp : p.sharp
    };
  }

  function anyFallback(ids) {
    for (var i = 0; i < ids.length; i++) {
      if (HASH[ids[i]] && !HASH[ids[i]].exact) return true;
    }
    return false;
  }

  /* ====================================================================== */
  /* constraints and clustering                                             */
  /* ====================================================================== */

  function byId(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  /** Partition one auto group so no cannot-link pair shares a bucket. */
  function splitByCantLink(ids, link) {
    var buckets = [];
    ids.forEach(function (id) {
      for (var i = 0; i < buckets.length; i++) {
        var ok = true;
        for (var j = 0; j < buckets[i].length; j++) {
          if (link[pairKey(id, buckets[i][j])] === -1) { ok = false; break; }
        }
        if (ok) { buckets[i].push(id); return; }
      }
      buckets.push([id]);
    });
    return buckets;
  }

  /** Union any groups joined by a must-link. Applied after splits; see header. */
  function mergeByMustLink(groups, link) {
    var where = Object.create(null);
    groups.forEach(function (g, i) { g.forEach(function (id) { where[id] = i; }); });

    var parent = groups.map(function (_, i) { return i; });
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }

    Object.keys(link).forEach(function (k) {
      if (link[k] !== 1) return;
      var ab = k.split('|');
      var a = where[ab[0]], b = where[ab[1]];
      if (a === undefined || b === undefined) return;
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    });

    var bucket = Object.create(null), order = [];
    groups.forEach(function (g, i) {
      var r = find(i);
      if (!bucket[r]) { bucket[r] = []; order.push(r); }
      bucket[r] = bucket[r].concat(g);
    });
    return order.map(function (r) { return bucket[r].slice().sort(byId); });
  }

  function repOf(ids, g) {
    var pinned = ids.filter(function (id) { return g.reps[id]; }).sort(byId);
    if (pinned.length) return pinned[0];
    try { return PT.phash.nominate(ids.map(metaOf)); }
    catch (e) { return ids[0]; }
  }

  /** Widest distance inside a group. Under strict it can never exceed the slider. */
  function diameterOf(ids) {
    var d = 0;
    for (var i = 0; i < ids.length; i++) {
      for (var j = i + 1; j < ids.length; j++) {
        var a = HASH[ids[i]], b = HASH[ids[j]];
        if (!a || !b) continue;
        try { d = Math.max(d, PT.phash.hamming(a.hash, b.hash)); } catch (e) { /* mixed families */ }
      }
    }
    return d;
  }

  function groupKey(ids) { return ids[0]; }

  function isManual(ids, link) {
    for (var i = 0; i < ids.length; i++) {
      for (var j = i + 1; j < ids.length; j++) {
        if (link[pairKey(ids[i], ids[j])]) return true;
      }
    }
    return false;
  }

  /**
   * Cluster fresh, then replay the manual constraints. Clustering is per unit:
   * a duplicate that spans two tournaments is not something the user can act on,
   * and Stage C consumes groups per unit anyway.
   */
  function computeGroups() {
    var g = sess().groups;
    var out = [];

    unitsList().forEach(function (u) {
      var items = [];
      (u.allIds || []).forEach(function (id) {
        if (g.removed[id]) return;
        var h = HASH[id];
        if (!h || typeof h.hash !== 'string' || h.hash.length !== HASH_LEN) return;
        var p = photo(id) || {};
        items.push({ id: id, hash: h.hash, w: p.w, h: p.h, sharp: h.sharp });
      });
      if (items.length < 2) return;

      var auto;
      try {
        auto = PT.phash.cluster(items, { threshold: g.threshold, mode: g.mode });
      } catch (e) {
        PT.warn('dupes', 'cluster failed for ' + u.id, e);
        return;
      }

      var parts = [];
      auto.forEach(function (grp) {
        splitByCantLink(grp, g.link).forEach(function (b) { parts.push(b); });
      });

      mergeByMustLink(parts, g.link).forEach(function (ids) {
        if (ids.length < 2) return;                 // singletons are not a group
        out.push({
          unitId: u.id,
          unitLabel: u.label,
          ids: ids,
          rep: repOf(ids, g),
          manual: isManual(ids, g.link),
          confirmed: !!g.confirmed[groupKey(ids)],
          diameter: diameterOf(ids)
        });
      });
    });

    return out;
  }

  /**
   * Recompute and persist. Writes the materialised result into
   * s.session.groups.groups AND into each unit's `groups` field, which is what
   * Stage C reads (70_screen_bracket.js runoffGroups).
   */
  function recompute() {
    var groups = computeGroups();
    PT.store.dispatch('dupes:regroup', function (s) {
      s.session.groups.groups = groups.map(function (gr) {
        return {
          unitId: gr.unitId, ids: gr.ids.slice(), rep: gr.rep,
          manual: gr.manual, confirmed: gr.confirmed
        };
      });
      var byUnit = Object.create(null);
      groups.forEach(function (gr) {
        (byUnit[gr.unitId] || (byUnit[gr.unitId] = [])).push({ ids: gr.ids.slice(), rep: gr.rep });
      });
      Object.keys(s.session.units).forEach(function (k) {
        if (k === 'stageD' || k === s.session.stageDUnit) return;
        s.session.units[k].groups = byUnit[k] || null;
      });
    });
    return groups;
  }

  /* ====================================================================== */
  /* edits                                                                  */
  /* ====================================================================== */

  /** Drop every constraint between the given ids, so a new edit is authoritative. */
  function clearLinksAmong(link, ids) {
    for (var i = 0; i < ids.length; i++) {
      for (var j = i + 1; j < ids.length; j++) delete link[pairKey(ids[i], ids[j])];
    }
  }

  function edit(name, fn) {
    PT.store.dispatch(name, function (s) { fn(s.session.groups, s); });
    paintList();
  }

  /* ====================================================================== */
  /* screen                                                                 */
  /* ====================================================================== */

  var D = null;   // live screen state, null when unmounted

  function counts(groups) {
    var photos = 0;
    groups.forEach(function (g) { photos += g.ids.length; });
    return { groups: groups.length, photos: photos };
  }

  function setImgFor(img, id) {
    var b = blobFor(id);
    if (b) { PT.dom.setImg(img, b); return; }
    PT.db.get('derivatives', id).then(function (rec) {
      // The screen may have been unmounted while this was in flight.
      if (!D || !img.isConnected) return;
      if (rec && (rec.thumb || rec.preview)) PT.dom.setImg(img, rec.thumb || rec.preview);
    }).catch(function () { /* no thumbnail; the cell stays an empty well */ });
  }

  function mount(root, params) {
    var s = sess();
    PT.dom.$('#topbar').hidden = false;
    PT.dom.$('#topbar-context').textContent = (s && s.rootName ? s.rootName + ' · ' : '') + 'near-duplicates';

    if (!s || !s.units || !Object.keys(s.units).length) {
      root.appendChild(el('div', { class: 'error-box', text: 'No tournaments to group yet.' }));
      return;
    }

    ensureState();
    D = { root: root, sel: Object.create(null), groups: [], busy: true };

    if (params && params.unitId) {
      PT.store.dispatch('dupes:enter', function (ss) {
        ss.session.groups.status = 'review';
        ss.session.groups.nextUnitId = params.unitId;
      });
    }

    root.appendChild(el('h1', { text: 'Photos that look like duplicates' }));

    D.status = el('div', { class: 'notice notice-note', id: 'dupe-status',
      text: 'Looking for near-duplicates…' });
    root.appendChild(D.status);

    D.toolbar = el('div', { class: 'card', id: 'dupe-toolbar' });
    root.appendChild(D.toolbar);

    D.list = el('div', { class: 'bk-results dupe-list', id: 'dupe-list' });
    root.appendChild(D.list);

    D.footer = el('div', { class: 'card row', id: 'dupe-footer' });
    root.appendChild(D.footer);

    var ids = eligibleIds();
    prepare(ids, function (done, total) {
      if (!D || !total) return;
      D.status.textContent = 'Reading ' + done + ' of ' + total + ' photos…';
    }).then(function () {
      if (!D) return;
      D.busy = false;
      D.fallback = anyFallback(ids);
      buildToolbar();
      buildFooter();
      paintList();
    }).catch(function (e) {
      PT.warn('dupes', 'preparation failed', e);
      if (!D) return;
      D.busy = false;
      D.status.className = 'notice notice-error';
      D.status.textContent = 'Could not read the thumbnails to compare photos: ' + e.message;
      buildFooter();
    });
  }

  /**
   * Built ONCE and then updated in place. Re-creating the slider on every input
   * event would replace the element mid-drag and the drag would die on the
   * first step — the same class of bug the tree screen hit with focus and the
   * caret.
   */
  function buildToolbar() {
    var g = sess().groups;
    PT.dom.clear(D.toolbar);

    D.slider = el('input', {
      type: 'range', id: 'dupe-threshold',
      min: String(RANGE[0]), max: String(RANGE[1]), step: String(STEP),
      class: 'dupe-range',
      title: 'How different two photos may be and still count as duplicates, in bits'
    });
    D.slider.value = String(g.threshold);
    D.slider.addEventListener('input', function () {
      var v = evenClamp(D.slider.value);
      PT.store.dispatch('dupes:threshold', function (s) {
        s.session.groups.threshold = v;
        s.session.settings.dupeThreshold = v;
      });
      // Measured at 0.4 ms for 500 items, so there is no debounce here on
      // purpose. Anything slower than immediate would be a downgrade.
      paintList();
    });

    D.readout = el('b', { class: 'nums', id: 'dupe-readout', text: String(g.threshold) });

    D.mode = el('select', { id: 'dupe-mode', class: 'dupe-mode',
      title: 'strict: every photo in a group is within the distance of every other. ' +
             'union: one close pair is enough to join two groups.' });
    [['strict', 'strict — tighter groups'], ['union', 'union — looser groups']].forEach(function (o) {
      var opt = el('option', { value: o[0], text: o[1] });
      if (g.mode === o[0]) opt.selected = true;
      D.mode.appendChild(opt);
    });
    D.mode.addEventListener('change', function () {
      var v = D.mode.value === 'union' ? 'union' : 'strict';
      PT.store.dispatch('dupes:mode', function (s) {
        s.session.groups.mode = v;
        s.session.settings.dupeMode = v;
      });
      paintList();
    });

    D.count = el('span', { class: 'small dim nums', id: 'dupe-count' });

    D.toolbar.appendChild(el('div', { class: 'row' }, [
      el('label', { class: 'small muted', for: 'dupe-threshold', text: 'Sensitivity' }),
      D.slider,
      el('span', { class: 'small' }, [D.readout, el('span', { class: 'dim', text: ' bits apart' })]),
      D.mode,
      el('span', { class: 'spacer' }),
      D.count
    ]));

    // The one thing about this control a user could not possibly guess.
    D.toolbar.appendChild(el('div', { class: 'small dim', id: 'dupe-stephint', text:
      'Moves in steps of 2. Every perceptual-hash distance is an even number, so the odd ' +
      'values in between would do nothing at all.' }));

    D.actions = el('div', { class: 'row', id: 'dupe-actions', style: 'margin-top:10px' });
    D.toolbar.appendChild(D.actions);
  }

  function buildFooter() {
    PT.dom.clear(D.footer);
    D.footer.appendChild(el('span', { class: 'small dim', text:
      'Nothing here throws a photo away. Groups only decide what gets compared side by side later.' }));
    D.footer.appendChild(el('span', { class: 'spacer' }));
    D.footer.appendChild(el('button', {
      class: 'btn btn-quiet', id: 'dupe-skip', text: 'Skip this step',
      title: 'Use the automatic grouping as it stands and start culling',
      onclick: function () { finish('dupes:skip'); }
    }));
    D.footer.appendChild(el('button', {
      class: 'btn btn-primary', id: 'dupe-continue', text: 'Looks right — start culling →',
      onclick: function () { finish('dupes:confirm'); }
    }));
  }

  function finish(action) {
    if (!D) return;
    var next = sess().groups.nextUnitId;
    PT.store.dispatch(action, function (s) { s.session.groups.status = 'done'; });
    var s = sess();
    if (!next || !s.units[next] || s.units[next].phase === 'done') {
      var pending = PT.session.pendingUnits(s);
      next = pending.length ? pending[0].id : null;
    }
    if (next) {
      PT.store.dispatch('dupes:next', function (ss) { ss.session.activeUnitId = next; });
      PT.router.go('grid', { unitId: next });
    } else if (typeof PT.advance === 'function') {
      PT.advance();
    } else {
      PT.router.go('tree');
    }
  }

  /* ------------------------------------------------------------ selection */

  function selected() { return Object.keys(D.sel); }

  function spannedGroups() {
    var hit = [];
    D.groups.forEach(function (gr) {
      if (gr.ids.some(function (id) { return D.sel[id]; })) hit.push(gr);
    });
    return hit;
  }

  function paintActions() {
    var sel = selected();
    var span = spannedGroups();
    PT.dom.clear(D.actions);

    if (!sel.length) {
      D.actions.appendChild(el('span', { class: 'small dim', text:
        'Click a photo to make it the one you keep. Tick photos to split, merge or remove them.' }));
      return;
    }

    D.actions.appendChild(el('span', { class: 'small muted nums',
      text: sel.length + ' selected in ' + span.length + ' group' + (span.length === 1 ? '' : 's') }));

    var canMerge = span.length >= 2;
    var one = span.length === 1 ? span[0] : null;
    var canSplit = !!one && sel.length < one.ids.length;

    D.actions.appendChild(el('button', {
      class: 'btn btn-sm', id: 'dupe-merge', text: 'Merge into one group',
      disabled: !canMerge,
      title: canMerge ? 'Treat these groups as one' : 'Tick photos in two or more groups first',
      onclick: function () {
        // Merge by linking one anchor per group rather than every pair: the
        // minimum constraint that joins them, so a later split of an individual
        // member is not fighting a wall of must-links.
        var anchors = span.map(function (gr) {
          var s = gr.ids.filter(function (id) { return D.sel[id]; });
          return (s.length ? s : gr.ids)[0];
        });
        var all = [];
        span.forEach(function (gr) { all = all.concat(gr.ids); });
        // Clear the selection BEFORE the edit: edit() repaints, and a repaint
        // that still sees the old selection leaves ticked boxes behind on
        // groups that no longer exist.
        D.sel = Object.create(null);
        edit('dupes:merge', function (g) {
          clearLinksAmong(g.link, all);
          for (var i = 1; i < anchors.length; i++) g.link[pairKey(anchors[0], anchors[i])] = 1;
          span.forEach(function (gr) { delete g.confirmed[groupKey(gr.ids)]; });
        });
      }
    }));

    D.actions.appendChild(el('button', {
      class: 'btn btn-sm', id: 'dupe-split', text: 'Split off selected',
      disabled: !canSplit,
      title: canSplit ? 'Move these into a group of their own'
                      : 'Tick some but not all of one group first',
      onclick: function () {
        var picked = one.ids.filter(function (id) { return D.sel[id]; });
        var rest = one.ids.filter(function (id) { return !D.sel[id]; });
        D.sel = Object.create(null);
        edit('dupes:split', function (g) {
          clearLinksAmong(g.link, one.ids);
          picked.forEach(function (a) {
            rest.forEach(function (b) { g.link[pairKey(a, b)] = -1; });
          });
          delete g.confirmed[groupKey(one.ids)];
        });
      }
    }));

    D.actions.appendChild(el('button', {
      class: 'btn btn-sm btn-danger', id: 'dupe-remove', text: 'Remove from grouping',
      title: 'These are not duplicates of anything. They stay in the tournament.',
      onclick: function () {
        D.sel = Object.create(null);
        edit('dupes:remove', function (g) { sel.forEach(function (id) { g.removed[id] = 1; }); });
      }
    }));

    D.actions.appendChild(el('button', {
      class: 'btn btn-sm btn-quiet', id: 'dupe-clear', text: 'Clear selection',
      onclick: function () { D.sel = Object.create(null); paintList(); }
    }));
  }

  /* -------------------------------------------------------------- painting */

  function paintList() {
    if (!D || D.busy) return;

    var t0 = (window.performance && performance.now) ? performance.now() : 0;
    D.groups = recompute();
    var g = sess().groups;
    var c = counts(D.groups);

    if (D.readout) D.readout.textContent = String(g.threshold);
    if (D.slider && D.slider.value !== String(g.threshold)) D.slider.value = String(g.threshold);
    if (D.count) {
      D.count.textContent = c.groups
        ? c.groups + ' group' + (c.groups === 1 ? '' : 's') + ' · ' + c.photos + ' photos'
        : 'no groups at this setting';
    }

    var removedCount = Object.keys(g.removed).length;
    D.status.className = 'notice notice-note';
    if (!c.groups) {
      D.status.textContent = 'Nothing looks like a duplicate at ' + g.threshold +
        ' bits. Drag the slider right to group more loosely, or start culling.';
    } else if (D.fallback) {
      D.status.className = 'notice notice-warn';
      D.status.textContent = 'Some thumbnails were cleared by the browser, so a few photos ' +
        'are compared with the coarser hash recorded at import. Grouping still works, but ' +
        'those photos may group less accurately.';
    } else {
      D.status.textContent = c.photos + ' of these photos look like near-duplicates of ' +
        'something else, in ' + c.groups + ' group' + (c.groups === 1 ? '' : 's') +
        '. The one on a white mount is the one that carries the group forward; click another ' +
        'to change it. The rest stay attached, so you can still choose between them later.' +
        (removedCount ? ' ' + removedCount + ' photo' + (removedCount === 1 ? '' : 's') +
          ' removed from grouping by hand.' : '');
    }

    // The whole list is rebuilt on every edit, and an emptied scroll container
    // clamps its scrollTop to 0 — so confirming a group halfway down the page
    // threw the user back to the top. Hold the reading position across the
    // rebuild; the browser re-clamps it if the list got shorter.
    var scroll = D.list.scrollTop;

    PT.dom.$$('img', D.list).forEach(function (img) { PT.dom.releaseImg(img); });
    PT.dom.clear(D.list);
    D.groups.forEach(function (gr) { D.list.appendChild(groupEl(gr, g)); });
    D.list.scrollTop = scroll;

    if (!D.groups.length && removedCount) {
      D.list.appendChild(el('div', { class: 'notice notice-note', id: 'dupe-empty' }, [
        el('span', { text: 'Every group has been taken apart or removed. ' }),
        el('button', {
          class: 'btn btn-sm btn-quiet', id: 'dupe-reset', text: 'Undo all my edits',
          onclick: function () {
            edit('dupes:reset', function (gg) {
              gg.link = {}; gg.reps = {}; gg.removed = {}; gg.confirmed = {};
            });
          }
        })
      ]));
    }

    paintActions();

    if (t0) PT.log('dupes', 'regrouped at', g.threshold, g.mode, 'in',
      (performance.now() - t0).toFixed(1) + 'ms', c.groups + ' groups');
  }

  function groupEl(gr, g) {
    var key = groupKey(gr.ids);
    var wrap = el('div', {
      class: 'ro-group dupe-group' + (gr.confirmed ? ' confirmed' : ''),
      dataset: { group: key, unit: gr.unitId, size: String(gr.ids.length) }
    });

    var repImg = el('img', { alt: '', class: 'dupe-rep-thumb' });
    setImgFor(repImg, gr.rep);

    var facts = gr.ids.length + ' photos · up to ' + gr.diameter + ' bits apart';
    if (gr.unitLabel) facts += ' · ' + gr.unitLabel;
    if (gr.manual) facts += ' · edited by hand';

    wrap.appendChild(el('div', { class: 'ro-head' }, [
      repImg,
      el('span', { class: 'bk-name' }, [
        el('div', { class: 'dupe-rep-name', text: nameOf(gr.rep) }),
        el('div', { class: 'small dim', text: facts })
      ]),
      el('button', {
        class: 'btn btn-sm' + (gr.confirmed ? ' btn-primary' : ''),
        dataset: { confirm: key },
        text: gr.confirmed ? 'Confirmed' : 'Confirm',
        title: gr.confirmed
          ? 'Pinned together. Click to unpin.'
          : 'Pin these together so moving the slider cannot take them apart',
        onclick: function () {
          edit('dupes:confirm-group', function (gg) {
            if (gg.confirmed[key]) {
              delete gg.confirmed[key];
              clearLinksAmong(gg.link, gr.ids);
            } else {
              gg.confirmed[key] = 1;
              // Confirming is what makes a group immune to the slider: it
              // writes the must-links, it does not just draw a tick.
              for (var i = 1; i < gr.ids.length; i++) {
                gg.link[pairKey(gr.ids[0], gr.ids[i])] = 1;
              }
            }
          });
        }
      }),
      el('button', {
        class: 'btn btn-sm btn-quiet', dataset: { splitall: key }, text: 'Split all apart',
        title: 'These are not duplicates of each other at all',
        onclick: function () {
          edit('dupes:split-all', function (gg) {
            clearLinksAmong(gg.link, gr.ids);
            for (var i = 0; i < gr.ids.length; i++) {
              for (var j = i + 1; j < gr.ids.length; j++) {
                gg.link[pairKey(gr.ids[i], gr.ids[j])] = -1;
              }
            }
            delete gg.confirmed[key];
          });
        }
      })
    ]));

    // A fixed track rather than the grid pass's grid-6/9/12/16: those size a
    // screen to fill a viewport, and this screen is a scrollable list where a
    // three-member group must not eat the whole window. Members stay a constant
    // size whatever the group holds, so groups are comparable down the page.
    var grid = el('div', { class: 'grid dupe-grid' });

    gr.ids.forEach(function (id) {
      var isRep = id === gr.rep;
      var cell = el('div', {
        class: 'photo-cell ro-cell dupe-cell' + (isRep ? ' kept' : '') + (D.sel[id] ? ' picked' : ''),
        dataset: { member: id, group: key },
        title: nameOf(id) + (isRep ? ' — kept as this group’s representative' : ' — click to keep this one instead'),
        onclick: function (ev) {
          if (ev.target && ev.target.classList && ev.target.classList.contains('dupe-pick')) return;
          // PRD 7.7: one click overrides the nomination. Everything else in the
          // group stays exactly where it is, ready for the Stage C runoff.
          edit('dupes:representative', function (gg) {
            gr.ids.forEach(function (m) { delete gg.reps[m]; });
            gg.reps[id] = 1;
          });
        }
      });

      var img = el('img', { class: 'thumb', alt: '' });
      cell.appendChild(img);

      var pick = el('input', { type: 'checkbox', class: 'dupe-pick', dataset: { pick: id },
        title: 'Select for split, merge or remove' });
      pick.checked = !!D.sel[id];
      pick.addEventListener('change', function () {
        if (pick.checked) D.sel[id] = 1; else delete D.sel[id];
        cell.classList.toggle('picked', pick.checked);
        paintActions();
      });
      cell.appendChild(pick);

      var tags = [];
      if (isRep) tags.push(sess().groups.reps[id] ? 'your pick' : 'sharpest');
      if (tags.length) cell.appendChild(el('span', { class: 'tag', text: tags.join(' · ') }));

      grid.appendChild(cell);
      setImgFor(img, id);
    });

    wrap.appendChild(el('div', { class: 'ro-body' }, [grid]));
    return wrap;
  }

  function unmount(root) {
    PT.dom.$$('img', root).forEach(function (img) { PT.dom.releaseImg(img); });
    var c = PT.dom.$('#topbar-counters');
    if (c) c.textContent = '';
    D = null;
  }

  PT.router.register('dupes', { mount: mount, unmount: unmount });

  /* ====================================================================== */
  /* entry point used by the tree screen                                    */
  /* ====================================================================== */

  /**
   * Does this session have anything worth reviewing? Synchronous, over the
   * hashes already in the store. See gateDistance() for why the gate is a
   * different, higher-precision test than the grouping itself.
   */
  function hasCandidates() {
    var found = false;
    unitsList().forEach(function (u) {
      if (found) return;
      var items = [];
      (u.allIds || []).forEach(function (id) {
        var p = photo(id);
        if (!p || p.err) return;
        // Deliberately the INGEST hash and only the ingest hash, which is now
        // the same pHash family the threshold was calibrated against.
        if (typeof p.phash === 'string' && p.phash.length === HASH_LEN) {
          items.push({ id: id, hash: p.phash });
        }
      });
      if (items.length < 2) return;
      try {
        found = PT.phash.cluster(items, { threshold: gateDistance(), mode: 'strict' })
          .some(function (grp) { return grp.length > 1; });
      } catch (e) { /* a malformed hash is not a reason to block the flow */ }
    });
    return found;
  }

  /**
   * Called from 50_screen_tree.js once the units exist. Routes into the review
   * only when there is something to review; otherwise the session goes straight
   * to the first grid pass exactly as it did before this screen existed.
   */
  function route(unitId) {
    var toGrid = function () {
      if (unitId) PT.router.go('grid', { unitId: unitId });
    };
    var s = sess();
    if (!s || !s.units || !Object.keys(s.units).length) return toGrid();

    var resuming = s.groups && s.groups.status === 'review';
    if (s.groups && s.groups.status === 'done') return toGrid();
    if (!resuming && !hasCandidates()) return toGrid();

    ensureState();
    PT.router.go('dupes', { unitId: unitId });
  }

  PT.dupes = {
    route: route,
    hasCandidates: hasCandidates,
    /** Open the review on demand — useful from the console and for tests. */
    open: function () {
      var s = sess();
      ensureState();
      var pending = s ? PT.session.pendingUnits(s) : [];
      PT.router.go('dupes', { unitId: pending.length ? pending[0].id : (s && s.activeUnitId) || null });
    },
    gateDistance: gateDistance,
    STEP: STEP,
    _internal: {
      computeGroups: computeGroups,
      splitByCantLink: splitByCantLink,
      mergeByMustLink: mergeByMustLink,
      pairKey: pairKey,
      evenClamp: evenClamp,
      hashes: function () { return HASH; }
    }
  };

  PT.log('dupes', 'screen registered');
})();

/** CHANGELOG
 * v1.0 (2026-07-28): Initial release. PRD 7.7 near-duplicate review: live
 *   sensitivity slider stepping by 2 with no debounce, per-unit clustering,
 *   scrollable review of every group with all members, manual split / merge /
 *   remove / confirm stored as PAIRWISE CONSTRAINTS rather than as results so
 *   hand edits survive any threshold change, one-click representative override
 *   with the rest of the group left attached for Stage C, and results written to
 *   both s.session.groups and each unit's `groups` field.
 *
 *   Also: the screen derives its own pHash from the cached thumbnails. The
 *   `phash` field written at ingest is the worker's inlined dHash — measured
 *   over the E2E corpus as 527 of 1,128 pairwise distances ODD and one-bit
 *   weights spread over 25..37 — so the constant-weight property the step-by-2
 *   slider depends on does not hold for it, and threshold 14 is calibrated for
 *   the wrong hash family. The derived hashes are cached back onto the photo
 *   records as ptPhash / ptSharp.
  * v1.1 (2026-07-28): The list keeps its scroll position across the rebuild
 *   every edit triggers — confirming a group halfway down no longer throws the
 *   user back to the top.
*/
