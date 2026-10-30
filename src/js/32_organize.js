/**
 * @file 32_organize.js
 * @version 1.2
 * @author Samuel Cao
 * @created 2026-10-30
 * @lastUpdated 2026-10-30
 * @description PRD 7.12 organize-by: turns each photo's capture metadata and an ordered list of user-chosen categories into a folder path, for Sort mode and for the culling allocation tree alike.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * Pure, like 30_tree.js and for the same reason: it is the part most easily
 * got subtly wrong, so it takes records and a spec and returns data, touching
 * neither the DOM nor the store.
 *
 * THE SEAM. Everything downstream of the tree — allocation states, percent,
 * ranking, Stage D, export folders — only ever sees `photo.dir`. Organizing
 * therefore never teaches those modules anything new: it computes a synthetic
 * dir per photo and hands records carrying it to the unchanged PT.tree.build().
 * "Folders" alone returns every photo's real dir, which is today's behaviour
 * exactly.
 *
 * Every category yields a group for every photo. A photo missing the field
 * lands in a named bucket ("No date", "Unknown camera"), never nowhere: a
 * photo that silently fell out of the organization would also fall out of
 * the cull.
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});

  var DEFAULTS = { eventGapH: 2, radiusKm: 5 };
  var GAP_CHOICES = [0.5, 2, 6, 24];
  var RADIUS_CHOICES = [1, 5, 25];

  var NO_DATE = 'No date';
  var NO_PLACE = 'No location';

  var CATEGORIES = [
    { key: 'folder', label: 'Folders', hint: 'the folders on disk' },
    { key: 'year', label: 'Year', hint: 'capture year' },
    { key: 'month', label: 'Month', hint: 'capture month' },
    { key: 'day', label: 'Day', hint: 'capture day, by the camera clock' },
    { key: 'event', label: 'Event', hint: 'a new event after a gap in shooting' },
    { key: 'location', label: 'Location', hint: 'place name in the file, else nearby GPS' },
    { key: 'camera', label: 'Camera', hint: 'make and model' },
    { key: 'lens', label: 'Lens', hint: 'lens model' },
    { key: 'focal', label: 'Focal length', hint: '35 mm equivalent bands' },
    { key: 'orientation', label: 'Orientation', hint: 'portrait, landscape, square' },
    { key: 'format', label: 'Format', hint: 'JPEG, HEIC, PNG…' }
  ];
  var BY_KEY = {};
  CATEGORIES.forEach(function (c) { BY_KEY[c.key] = c; });

  /* --------------------------------------------------------------- helpers */

  /** A folder-name-safe path segment. '/' is the tree's separator, so it can never survive. */
  function seg(s) {
    s = String(s == null ? '' : s)
      .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 80)
      .trim();
    return s || '_';
  }

  /** Capture time as naive wall-clock ms: what the camera clock said, no zone. */
  function whenMs(cap) {
    if (!cap || !cap.when) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(cap.when);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  /**
   * Make + model without the stutter: "Canon" + "Canon EOS R6" is
   * "Canon EOS R6", "NIKON CORPORATION" + "NIKON Z 6" is "NIKON Z 6", while
   * "Apple" + "iPhone 15 Pro" keeps both.
   */
  function cameraLabel(cap) {
    if (!cap) return null;
    var make = (cap.make || '').trim();
    var model = (cap.model || '').trim();
    if (!make && !model) return null;
    if (!model) return make;
    if (!make) return model;
    var first = make.split(/\s+/)[0].toLowerCase();
    if (model.toLowerCase().indexOf(first) === 0) return model;
    return make + ' ' + model;
  }

  var FOCAL_BANDS = [
    { max: 23.5, label: 'Ultra-wide (under 24mm)' },
    { max: 35.5, label: 'Wide (24-35mm)' },
    { max: 70.5, label: 'Normal (36-70mm)' },
    { max: 135.5, label: 'Short tele (71-135mm)' },
    { max: Infinity, label: 'Tele (over 135mm)' }
  ];
  function focalBand(cap) {
    if (!cap) return null;
    // The 35 mm equivalent is the only number comparable across bodies; raw
    // focal length is a phone's 6.8 mm next to a full-frame's 35.
    var f = cap.fl35 || cap.fl;
    if (!(f > 0)) return null;
    for (var i = 0; i < FOCAL_BANDS.length; i++) if (f <= FOCAL_BANDS[i].max) return FOCAL_BANDS[i].label;
    return null;
  }

  function orientationOf(p) {
    var w = p.w || 0, h = p.h || 0;
    // A manual quarter turn (PT.orient) swaps the axes the user actually sees.
    var o = p.orient;
    if (o && (o.r === 1 || o.r === 3)) { var t = w; w = h; h = t; }
    if (!w || !h) return null;
    if (w > h * 1.02) return 'Landscape';
    if (h > w * 1.02) return 'Portrait';
    return 'Square';
  }

  function writtenPlace(cap) {
    if (!cap) return null;
    var local = cap.city || cap.sublocation || cap.state;
    if (local && cap.country && local !== cap.country) return local + ', ' + cap.country;
    return local || cap.country || null;
  }

  function hasGps(cap) {
    return !!cap && typeof cap.lat === 'number' && typeof cap.lon === 'number';
  }

  var EARTH_KM = 6371.0088;
  function km(aLat, aLon, bLat, bLon) {
    var r = Math.PI / 180;
    var dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function coordLabel(lat, lon) {
    return 'Near ' + Math.abs(lat).toFixed(2) + (lat >= 0 ? 'N' : 'S') + ' ' +
      Math.abs(lon).toFixed(2) + (lon >= 0 ? 'E' : 'W');
  }

  /** Stable key a user-given name hangs on: the cluster centre to ~100 m. */
  function placeKey(lat, lon) { return 'loc:' + lat.toFixed(3) + ',' + lon.toFixed(3); }
  function parsePlaceKey(k) {
    var m = /^loc:(-?[\d.]+),(-?[\d.]+)$/.exec(k);
    return m ? { lat: +m[1], lon: +m[2] } : null;
  }

  function byTime(photos) {
    return photos.slice().sort(function (a, b) {
      var ta = whenMs(a.capture), tb = whenMs(b.capture);
      if (ta !== tb) return (ta === null ? Infinity : ta) - (tb === null ? Infinity : tb);
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /* ---------------------------------------------------------------- events */

  /**
   * Time-gap events over the whole set: a new event starts wherever the
   * camera clocks show a gap longer than gapH. Computed across every photo,
   * not within each camera, so "Event" means a stretch of real time and
   * nesting ("Event > Camera") does the splitting.
   *
   * @returns {{of:Object<string,string>, list:Array<{key,label,start,end,count}>}}
   */
  function events(photos, gapH, names) {
    var gap = (gapH > 0 ? gapH : DEFAULTS.eventGapH) * 3600e3;
    var of = {}, list = [], cur = null, last = null;
    byTime(photos).forEach(function (p) {
      var t = whenMs(p.capture);
      if (t === null) { of[p.id] = null; return; }
      if (!cur || t - last > gap) {
        var w = p.capture.when;
        // "2026-07-14 09.12": sorts chronologically as a folder name, and two
        // events cannot start in the same minute when the smallest gap is 30.
        var key = 'event:' + w;
        cur = { key: key, auto: w.slice(0, 10) + ' ' + w.slice(11, 13) + '.' + w.slice(14, 16), start: t, end: t, count: 0 };
        cur.label = (names && names[key]) || cur.auto;
        list.push(cur);
      }
      cur.end = t;
      cur.count++;
      last = t;
      of[p.id] = cur.label;
    });
    return { of: of, list: list };
  }

  /* ------------------------------------------------------------- locations */

  /**
   * Location, read only from the photo's own metadata (PRD 7.12):
   *   1. a written place name in the file wins (IPTC/XMP City, Country);
   *   2. otherwise GPS coordinates are clustered offline — a photo joins the
   *      nearest cluster whose centre is within radiusKm, else seeds one;
   *   3. no GPS at all is "No location".
   * A cluster is named, in order: by the user; by the most common written
   * place among its own members (so a GPS-only phone frame taken beside a
   * Lightroom-named one joins that name); by its centre coordinates.
   *
   * Leader clustering in capture order is deterministic for a given set, and
   * a user's name is re-attached by distance rather than by cluster index, so
   * it survives a change of radius.
   */
  function locations(photos, radiusKm, names) {
    var R = radiusKm > 0 ? radiusKm : DEFAULTS.radiusKm;
    var clusters = [];
    var of = {};
    byTime(photos).forEach(function (p) {
      var cap = p.capture;
      if (!hasGps(cap)) return;
      var best = null, bestD = Infinity;
      for (var i = 0; i < clusters.length; i++) {
        var d = km(clusters[i].lat, clusters[i].lon, cap.lat, cap.lon);
        if (d <= R && d < bestD) { best = clusters[i]; bestD = d; }
      }
      if (!best) {
        best = { lat: cap.lat, lon: cap.lon, n: 0, ids: [], written: {} };
        clusters.push(best);
      }
      best.lat = (best.lat * best.n + cap.lat) / (best.n + 1);
      best.lon = (best.lon * best.n + cap.lon) / (best.n + 1);
      best.n++;
      best.ids.push(p.id);
      var wp = writtenPlace(cap);
      if (wp) best.written[wp] = (best.written[wp] || 0) + 1;
    });

    var named = [];
    Object.keys(names || {}).forEach(function (k) {
      var c = parsePlaceKey(k);
      if (c && names[k]) named.push({ lat: c.lat, lon: c.lon, name: names[k] });
    });

    var list = clusters.map(function (c) {
      var key = placeKey(c.lat, c.lon);
      var user = null, userD = Infinity;
      named.forEach(function (n) {
        var d = km(n.lat, n.lon, c.lat, c.lon);
        if (d <= R && d < userD) { user = n.name; userD = d; }
      });
      var top = null, topN = 0;
      Object.keys(c.written).forEach(function (w) { if (c.written[w] > topN) { top = w; topN = c.written[w]; } });
      var label = user || top || coordLabel(c.lat, c.lon);
      c.ids.forEach(function (id) { of[id] = label; });
      return { key: key, label: label, auto: top || coordLabel(c.lat, c.lon), named: !!user, lat: c.lat, lon: c.lon, count: c.n };
    });

    // A written name on the photo itself overrides its cluster's label.
    photos.forEach(function (p) {
      var wp = writtenPlace(p.capture);
      if (wp) of[p.id] = wp;
      else if (!(p.id in of)) of[p.id] = null;
    });
    return { of: of, list: list };
  }

  /* ------------------------------------------------------------------ plan */

  /** One photo's group label in one category, or null for the missing bucket. */
  function labelOf(cat, p, ctx) {
    var cap = p.capture;
    switch (cat) {
      case 'folder': return p.dir || '';
      case 'year': return cap && cap.when ? cap.when.slice(0, 4) : null;
      case 'month': return cap && cap.when ? cap.when.slice(0, 7) : null;
      case 'day': return cap && cap.when ? cap.when.slice(0, 10) : null;
      case 'event': return ctx.events.of[p.id] || null;
      case 'location': return ctx.locations.of[p.id] || null;
      case 'camera': return cameraLabel(cap);
      case 'lens': return cap && cap.lens ? cap.lens : null;
      case 'focal': return focalBand(cap);
      case 'orientation': return orientationOf(p);
      case 'format': return p.kind && p.kind !== 'unsupported' ? String(p.kind).toUpperCase() : null;
    }
    return null;
  }

  function missingLabel(cat, p) {
    if (cat === 'year' || cat === 'month' || cat === 'day' || cat === 'event') return NO_DATE;
    if (cat === 'location') return NO_PLACE;
    if (cat === 'camera') return 'Unknown camera';
    if (cat === 'lens') return 'Unknown lens';
    if (cat === 'focal') return 'Unknown focal length';
    if (cat === 'orientation') return 'Unknown shape';
    if (cat === 'format') return 'Other format';
    return 'Unknown';
  }

  function normSpec(spec) {
    spec = spec || {};
    var cats = (spec.cats || []).filter(function (c, i, a) { return BY_KEY[c] && a.indexOf(c) === i; });
    return {
      cats: cats,
      eventGapH: spec.eventGapH > 0 ? spec.eventGapH : DEFAULTS.eventGapH,
      radiusKm: spec.radiusKm > 0 ? spec.radiusKm : DEFAULTS.radiusKm,
      names: spec.names || {}
    };
  }

  /**
   * Is this spec today's behaviour (organize by disk folders only)? No spec at
   * all is; an explicit EMPTY list is not — it is the deliberate choice to put
   * every photo in one group, regardless of folders.
   */
  function isFolders(spec) {
    if (!spec) return true;
    var s = normSpec(spec);
    return s.cats.length === 1 && s.cats[0] === 'folder';
  }

  /**
   * @param {Array<object>} photos records with id, dir, kind, w, h, capture
   * @param {{cats:string[], eventGapH?:number, radiusKm?:number, names?:Object}} spec
   * @returns {{
   *   dir: Object<string,string>,          photo id -> synthetic dir ('' = root)
   *   groups: Object<string,number>,       dir -> photo count
   *   summary: Object<string,{groups:number, missing:number}>,  per category, for chip previews
   *   events: Array, locations: Array,     for naming UIs
   *   noCapture: number                    records from before capture metadata existed
   * }}
   */
  function plan(photos, spec) {
    var s = normSpec(spec);
    var ctx = {
      events: events(photos, s.eventGapH, s.names),
      locations: locations(photos, s.radiusKm, s.names)
    };

    var dir = {}, groups = {};
    var noCapture = 0;
    photos.forEach(function (p) {
      if (!p.capture) noCapture++;
      var parts = [];
      s.cats.forEach(function (cat) {
        var v = labelOf(cat, p, ctx);
        if (cat === 'folder') {
          // Real folders keep their own depth; root photos add no segment.
          if (v) v.split('/').forEach(function (x) { if (x) parts.push(seg(x)); });
          return;
        }
        parts.push(seg(v == null ? missingLabel(cat, p) : v));
      });
      var d = parts.join('/');
      dir[p.id] = d;
      groups[d] = (groups[d] || 0) + 1;
    });

    var summary = {};
    CATEGORIES.forEach(function (c) {
      var seen = {}, n = 0, missing = 0;
      photos.forEach(function (p) {
        var v = labelOf(c.key, p, ctx);
        if (v == null) { missing++; return; }
        if (!seen[v]) { seen[v] = 1; n++; }
      });
      summary[c.key] = { groups: n + (missing ? 1 : 0), missing: missing };
    });

    return {
      dir: dir,
      groups: groups,
      summary: summary,
      events: ctx.events.list,
      locations: ctx.locations.list,
      noCapture: noCapture
    };
  }

  /**
   * Records with `dir` swapped for the organized one, ready for
   * PT.tree.build(). Folders-only returns the input untouched, so the
   * default path stays byte-for-byte what it was.
   */
  function apply(photos, spec) {
    if (isFolders(spec)) return photos;
    var pl = plan(photos, spec);
    return photos.map(function (p) {
      var o = Object.assign({}, p);
      o.dir = pl.dir[p.id];
      return o;
    });
  }

  /** The allocation tree for a spec: PT.tree.build over the organized records. */
  function tree(photos, spec) {
    var live = photos.filter(function (p) { return !p.err; });
    return live.length ? PT.tree.build(apply(live, spec)) : null;
  }

  /* ---------------------------------------------------- display formatting */

  function exposureText(cap) {
    if (!cap) return '';
    var bits = [];
    if (cap.fl35) bits.push(Math.round(cap.fl35) + 'mm equiv.');
    else if (cap.fl) bits.push(Math.round(cap.fl * 10) / 10 + 'mm');
    if (cap.f) bits.push('f/' + cap.f);
    if (cap.exp) bits.push(cap.exp >= 1 ? cap.exp + 's' : '1/' + Math.round(1 / cap.exp) + 's');
    if (cap.iso) bits.push('ISO ' + cap.iso);
    return bits.join('  ');
  }

  /** Rows for an info panel: [label, value], absent fields omitted. */
  function infoRows(p) {
    var cap = p.capture;
    var rows = [];
    if (!cap) { rows.push(['Metadata', 'not read (ingested before metadata support)']); return rows; }
    if (cap.when) rows.push(['Taken', cap.when.replace('T', ' ') + (cap.tz ? ' ' + cap.tz : '') + (cap.whenSrc === 'modified' ? ' (edit time)' : '')]);
    var cam = cameraLabel(cap);
    if (cam) rows.push(['Camera', cam]);
    if (cap.lens) rows.push(['Lens', cap.lens]);
    var ex = exposureText(cap);
    if (ex) rows.push(['Settings', ex]);
    var wp = writtenPlace(cap);
    if (wp) rows.push(['Place', wp]);
    if (hasGps(cap)) rows.push(['GPS', cap.lat.toFixed(5) + ', ' + cap.lon.toFixed(5)]);
    if (!rows.length) rows.push(['Metadata', 'none in this file']);
    return rows;
  }

  /* -------------------------------------------------------------- manifest */

  var MANIFEST_COLS = ['folder', 'file', 'original_path', 'tags', 'taken', 'timezone', 'camera', 'lens',
    'focal_mm', 'focal_35mm', 'aperture', 'shutter_s', 'iso', 'latitude', 'longitude', 'place',
    'width', 'height', 'format', 'bytes'];

  /**
   * One manifest row: where the photo went, its tags, and everything the camera
   * recorded. Shared by the Sort export and the culling export, which prepends
   * its own rank/set/label columns.
   */
  function manifestRow(p, folder, file, tagNames) {
    var cap = p.capture || {};
    return {
      folder: folder || '',
      file: file || p.name,
      original_path: p.path || p.name,
      tags: (tagNames || []).join('; '),
      taken: cap.when ? cap.when.replace('T', ' ') : '',
      timezone: cap.tz || '',
      camera: cameraLabel(cap) || '',
      lens: cap.lens || '',
      focal_mm: cap.fl || '',
      focal_35mm: cap.fl35 || '',
      aperture: cap.f || '',
      shutter_s: cap.exp || '',
      iso: cap.iso || '',
      latitude: hasGps(cap) ? cap.lat : '',
      longitude: hasGps(cap) ? cap.lon : '',
      place: writtenPlace(cap) || '',
      width: p.w || '',
      height: p.h || '',
      format: p.kind || '',
      bytes: p.size || ''
    };
  }

  /**
   * RFC 4180 CSV. Text that a spreadsheet would read as a formula (=, +, -, @
   * at the start, or a leading tab/CR) is prefixed with an apostrophe: tags,
   * labels and filenames are user-controlled, and a manifest is exactly the
   * file people open in Excel. Numbers are written as numbers, so a southern
   * latitude stays -33.85.
   */
  function toCsv(rows, cols) {
    cols = cols || MANIFEST_COLS;
    var cell = function (v) {
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return isFinite(v) ? String(v) : '';
      var t = String(v);
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    var out = [cols.join(',')];
    rows.forEach(function (r) { out.push(cols.map(function (c) { return cell(r[c]); }).join(',')); });
    return out.join('\r\n') + '\r\n';
  }

  PT.organize = {
    CATEGORIES: CATEGORIES,
    DEFAULTS: DEFAULTS,
    GAP_CHOICES: GAP_CHOICES,
    RADIUS_CHOICES: RADIUS_CHOICES,
    plan: plan,
    apply: apply,
    tree: tree,
    isFolders: isFolders,
    normSpec: normSpec,
    cameraLabel: cameraLabel,
    focalBand: focalBand,
    writtenPlace: writtenPlace,
    exposureText: exposureText,
    infoRows: infoRows,
    placeKey: placeKey,
    km: km,
    seg: seg,
    MANIFEST_COLS: MANIFEST_COLS,
    manifestRow: manifestRow,
    toCsv: toCsv
  };
})();

/*
CHANGELOG
v1.0 (2026-10-30): Initial release (PRD 7.12 draft). Eleven categories, time-
  gap events, offline location clusters with written-name precedence and
  distance-matched user names, named missing buckets, per-category chip
  summaries, and apply() handing synthetic dirs to the unchanged tree.
v1.1 (2026-10-30): manifestRow and toCsv, shared by both exports. The CSV
  defuses spreadsheet formulas in user-controlled text and keeps numbers
  numeric.
v1.2 (2026-10-30): tree() helper. An explicit empty category list now
  means one group, not folders: emptying the row on the allocation screen
  used to snap back to Folders and nest the next choice under the disk
  folders.
*/
