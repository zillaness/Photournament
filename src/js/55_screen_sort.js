/**
 * @file 55_screen_sort.js
 * @version 1.2
 * @author Samuel Cao
 * @created 2026-10-30
 * @lastUpdated 2026-10-30
 * @description PRD 7.12 Sort mode: every photo of a shoot, grouped by the categories the user chooses, selectable and taggable, with an export that writes an organized copy or a manifest.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * Sort mode is the other job: nothing is kept or cut and there is no quota,
 * because nothing is being narrowed. It shares ingest, PT.organize, the
 * Organize-by control, the lightbox and the tags with culling; what it adds is
 * a screen that shows the WHOLE set, grouped, and an export for the whole set.
 *
 * The organization lives on session.organize and persists; the selection is
 * deliberately transient (a reload lands with nothing selected, which is
 * never wrong, where a stale selection can be).
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});
  var el = function () { return PT.dom.el.apply(null, arguments); };

  var S = null; // screen state while mounted

  function livePhotos() {
    var s = PT.store.get();
    return Object.keys(s.photos || {}).map(function (k) { return s.photos[k]; })
      .filter(function (p) { return p && !p.err && (!S || !S.ids || S.ids[p.id]); });
  }

  /**
   * Sort mode's opening view. Day when most photos carry a capture date (the
   * usual shape of a camera roll), folders otherwise; either way it is only a
   * starting point and the chips are right there.
   */
  function defaultSpec(photos) {
    var dated = photos.filter(function (p) { return p.capture && p.capture.when; }).length;
    return { cats: dated * 2 >= photos.length && dated ? ['day'] : ['folder'] };
  }

  function spec() {
    var sess = PT.store.get().session;
    return sess.organize || { cats: [] };
  }

  function thumbFor(id) {
    var s = PT.store.get();
    var d = s.derivatives && s.derivatives[id];
    if (d && (d.thumb || d.preview)) return Promise.resolve(d.thumb || d.preview);
    return PT.db.get('derivatives', id).then(function (r) { return r ? (r.thumb || r.preview) : null; })
      .catch(function () { return null; });
  }

  /* ------------------------------------------------------------- groups -- */

  function grouped() {
    var photos = livePhotos();
    var pl = PT.organize.plan(photos, spec());
    var byDir = {};
    photos.forEach(function (p) {
      var d = pl.dir[p.id];
      (byDir[d] = byDir[d] || []).push(p);
    });
    var dirs = Object.keys(byDir).sort(function (a, b) {
      // Missing-data buckets sink to the end of their level.
      var ua = /(^|\/)(No date|No location|Unknown [^/]*|Other format)(\/|$)/.test(a);
      var ub = /(^|\/)(No date|No location|Unknown [^/]*|Other format)(\/|$)/.test(b);
      if (ua !== ub) return ua ? 1 : -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    var order = [];
    var groups = dirs.map(function (d) {
      var ps = byDir[d].sort(function (a, b) {
        var ta = a.capture && a.capture.when || '', tb = b.capture && b.capture.when || '';
        if (ta !== tb) return ta < tb ? -1 : 1;
        return (a.path || a.name) < (b.path || b.name) ? -1 : 1;
      });
      ps.forEach(function (p) { order.push(p.id); });
      return { dir: d, ids: ps.map(function (p) { return p.id; }) };
    });
    return { groups: groups, order: order, plan: pl };
  }

  /* ------------------------------------------------------------- render -- */

  function renderGroups() {
    var host = S.groupsHost;
    if (S.io) S.io.disconnect();
    PT.dom.$$('img', host).forEach(function (img) { PT.dom.releaseImg(img); });
    PT.dom.clear(host);

    var g = grouped();
    S.order = g.order;
    S.cells = {};
    S.summary.textContent = g.order.length + ' photo' + (g.order.length === 1 ? '' : 's') + ' in ' +
      g.groups.length + ' group' + (g.groups.length === 1 ? '' : 's');

    // Thumbnails load as they scroll into view: a 742-photo shoot is 742
    // object URLs otherwise, all decoded up front.
    S.io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var img = e.target;
        S.io.unobserve(img);
        thumbFor(img.dataset.id).then(function (b) { if (b && S && img.isConnected) PT.dom.setImg(img, b); });
      });
    }, { root: null, rootMargin: '600px 0px' });

    g.groups.forEach(function (gr) {
      var title = gr.dir ? gr.dir.split('/').join('  ›  ') : 'All photos';
      var head = el('div', { class: 'so-head' }, [
        el('h3', { class: 'so-title', text: title }),
        el('span', { class: 'small dim nums', text: gr.ids.length + ' photo' + (gr.ids.length === 1 ? '' : 's') }),
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: 'Select group', dataset: { t: 'so-select-group' },
          onclick: function () {
            var all = gr.ids.every(function (id) { return S.sel[id]; });
            gr.ids.forEach(function (id) { if (all) delete S.sel[id]; else S.sel[id] = 1; });
            S.anchor = null;
            paintSelection();
          } })
      ]);
      var grid = el('div', { class: 'so-grid' });
      gr.ids.forEach(function (id) { grid.appendChild(cell(id, gr.ids)); });
      host.appendChild(el('section', { class: 'so-group', dataset: { t: 'so-group', dir: gr.dir } }, [head, grid]));
    });
    paintSelection();
  }

  function cell(id, groupIds) {
    var p = PT.store.get().photos[id];
    var img = el('img', { alt: '', dataset: { id: id }, loading: 'lazy' });
    var tags = el('div', { class: 'so-tags' });
    var c = el('div', { class: 'so-cell', dataset: { t: 'so-cell', id: id }, tabindex: '0',
      title: p.name + ' — click to select, shift-click for a range' }, [
      el('div', { class: 'so-frame' }, [
        img,
        el('button', { type: 'button', class: 'expand-btn', text: '⤢', title: 'Open large (and see its metadata)',
          dataset: { t: 'so-expand' },
          onclick: function (e) { e.stopPropagation(); PT.lightbox.open(groupIds.slice(), groupIds.indexOf(id)); } })
      ]),
      el('div', { class: 'so-cap' }, [el('span', { class: 'so-name', text: p.name }), tags])
    ]);
    c.addEventListener('click', function (e) { select(id, e.shiftKey); });
    c.addEventListener('keydown', function (e) {
      // Only keys on the cell itself: Enter on the expand button inside it
      // must open the photo, not toggle its selection.
      if (e.target !== c) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); select(id, e.shiftKey); }
    });
    S.cells[id] = { el: c, tags: tags };
    paintTags(id);
    S.io.observe(img);
    return c;
  }

  function select(id, range) {
    if (range && S.anchor && S.order.indexOf(S.anchor) >= 0) {
      var a = S.order.indexOf(S.anchor), b = S.order.indexOf(id);
      var lo = Math.min(a, b), hi = Math.max(a, b);
      for (var i = lo; i <= hi; i++) S.sel[S.order[i]] = 1;
    } else {
      if (S.sel[id]) delete S.sel[id]; else S.sel[id] = 1;
      S.anchor = id;
    }
    paintSelection();
  }

  function selectedIds() {
    return S.order.filter(function (id) { return S.sel[id]; });
  }

  function paintSelection() {
    Object.keys(S.cells).forEach(function (id) {
      S.cells[id].el.classList.toggle('sel', !!S.sel[id]);
      S.cells[id].el.setAttribute('aria-selected', S.sel[id] ? 'true' : 'false');
    });
    var n = selectedIds().length;
    S.selCount.textContent = n ? n + ' selected' : 'Nothing selected — click photos, or Select group';
    S.selBar.classList.toggle('active', n > 0);
    S.tagBar.refresh();
  }

  function paintTags(id) {
    var c = S.cells[id];
    if (!c) return;
    PT.dom.clear(c.tags);
    PT.tags.names(id).forEach(function (n) { c.tags.appendChild(el('span', { class: 'so-tag', text: n })); });
  }

  /* ------------------------------------------------------------- screen -- */

  PT.router.register('sort', {
    mount: function (root) {
      var st = PT.store.get();
      PT.dom.$('#topbar').hidden = false;
      PT.dom.$('#topbar-context').textContent = st.session.rootName;
      PT.dom.$('#topbar-stop').hidden = true;
      var counters = PT.dom.$('#topbar-counters');
      if (counters) counters.textContent = '';

      S = { sel: {}, anchor: null, order: [], cells: {}, io: null, ids: null };

      if (!st.session.organize) {
        var first = defaultSpec(livePhotos());
        PT.store.dispatch('sort:organize', function (s) { s.session.organize = first; });
      }

      S.summary = el('span', { class: 'muted small' });
      var bar = PT.organizeBar({
        spec: spec,
        photos: livePhotos,
        onChange: function (next) {
          PT.store.dispatch('sort:organize', function (s) { s.session.organize = next; });
          bar.refresh();
          renderGroups();
        }
      });

      root.appendChild(el('div', { class: 'card so-top' }, [
        el('div', { class: 'row' }, [
          el('h1', { text: 'Sort and tag' }),
          S.summary,
          el('span', { class: 'spacer' }),
          el('button', { type: 'button', class: 'btn btn-quiet', text: 'Tags…', dataset: { t: 'so-manage-tags' },
            onclick: function () { PT.tags.manage(); } }),
          el('button', { type: 'button', class: 'btn btn-primary', text: 'Export…', dataset: { t: 'so-export' },
            onclick: function () { if (PT.sortExport) PT.sortExport.open(); } })
        ]),
        el('p', { class: 'muted small', text:
          'Nothing here is kept or cut. Choose how to group the shoot, tag what you like, then export ' +
          'an organized copy or just the list.' }),
        bar.el
      ]));

      S.groupsHost = el('div', { class: 'so-groups' });
      root.appendChild(S.groupsHost);

      S.selCount = el('span', { class: 'small nums', dataset: { t: 'so-sel-count' } });
      S.tagBar = PT.tags.bar({ ids: selectedIds, keys: true, label: 'Tag selection' });
      S.selBar = el('div', { class: 'so-selbar', dataset: { t: 'so-selbar' } }, [
        S.selCount,
        S.tagBar.el,
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: 'Select all', dataset: { t: 'so-select-all' },
          onclick: function () { S.order.forEach(function (id) { S.sel[id] = 1; }); paintSelection(); } }),
        el('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: 'Clear', dataset: { t: 'so-clear' },
          onclick: function () { S.sel = {}; S.anchor = null; paintSelection(); } })
      ]);
      root.appendChild(S.selBar);

      S.off = PT.store.subscribe(function (s, name) {
        if (!S) return;
        if (/^tags:/.test(name)) Object.keys(S.cells).forEach(paintTags);
      });

      S.onKey = function (e) {
        if (!S || document.querySelector('dialog[open]')) return;
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        if (PT.tags.handleKey(e, selectedIds())) return;
        if (e.key === 'Escape') { S.sel = {}; S.anchor = null; paintSelection(); }
      };
      document.addEventListener('keydown', S.onKey);

      renderGroups();
    },

    unmount: function () {
      if (!S) return;
      if (S.io) S.io.disconnect();
      if (S.off) S.off();
      document.removeEventListener('keydown', S.onKey);
      PT.dom.$$('#screen img').forEach(function (img) { PT.dom.releaseImg(img); });
      S = null;
    }
  });

  /* ------------------------------------------------------------- export -- */

  /**
   * PRD 7.12 Sort export, chosen each time and priced first, because the two
   * outputs cost wildly different amounts: a copy is the whole shoot again on
   * disk, a manifest is a few kilobytes.
   *
   *   Copy  -> <picked folder>/<organized path>/<original name>, plus optional
   *            per-tag sets (_tagged_<tag>/) and the manifest beside them.
   *   List  -> the manifest only, as CSV and JSON downloads.
   *
   * Never overwrites: a name already taken, on disk or earlier in this same
   * export (two source folders can both hold IMG_0001.jpg), gets _2, _3...
   */
  function sources(ids) {
    return ids.filter(function (id) { return !PT.sources[id]; });
  }

  function exportPlan(withTags) {
    var g = grouped();
    var s = PT.store.get();
    var items = [];
    g.groups.forEach(function (gr) {
      gr.ids.forEach(function (id) { items.push({ id: id, photo: s.photos[id], folder: gr.dir }); });
    });
    var tagged = [];
    if (withTags) {
      PT.tags.defs().forEach(function (d) {
        PT.tags.photosWith(d.id, g.order).forEach(function (id) {
          tagged.push({ id: id, photo: s.photos[id], folder: '_tagged_' + PT.organize.seg(d.name) });
        });
      });
    }
    return { items: items, tagged: tagged, order: g.order };
  }

  function bytesOf(list) {
    return list.reduce(function (n, it) { return n + (it.photo.size || 0); }, 0);
  }

  /**
   * @param written null for the list export; for a copy, id -> {file} for
   *   every photo actually in the folder, so the manifest says which are.
   */
  function manifestDocs(plan, written) {
    var s = PT.store.get();
    var rows = plan.items.map(function (it) {
      var w = written && written[it.id];
      var r = PT.organize.manifestRow(it.photo, it.folder, w ? w.file : it.photo.name, PT.tags.names(it.id));
      if (written) r.copied = w ? 'yes' : 'no';
      return r;
    });
    var cols = written ? PT.organize.MANIFEST_COLS.concat(['copied']) : PT.organize.MANIFEST_COLS;
    var json = {
      _metadata: {
        file: 'photournament_sort_manifest_v1.0.json',
        version: '1.0',
        app: 'Photournament v' + PT.VERSION,
        exported: new Date().toISOString(),
        source: s.session.rootName
      },
      organize: PT.organize.normSpec(s.session.organize),
      tags: PT.tags.defs(),
      photos: plan.items.map(function (it) {
        var w = written && written[it.id];
        return {
          id: it.id, original: it.photo.path, folder: it.folder,
          file: w ? w.file : it.photo.name, copied: written ? !!w : undefined, tags: PT.tags.names(it.id),
          capture: it.photo.capture || null, w: it.photo.w, h: it.photo.h,
          format: it.photo.kind, bytes: it.photo.size
        };
      })
    };
    return {
      // The BOM is what makes Excel read the file as UTF-8 (place names, tags).
      csv: new Blob(['\ufeff' + PT.organize.toCsv(rows, cols)], { type: 'text/csv' }),
      json: new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
    };
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /** Walks (creating) a nested folder path under a directory handle. */
  function dirAt(root, path) {
    var parts = String(path || '').split('/').filter(Boolean);
    return parts.reduce(function (p, seg) {
      return p.then(function (d) { return d.getDirectoryHandle(seg, { create: true }); });
    }, Promise.resolve(root));
  }

  /**
   * Where a file goes in this folder: {name, same}. A name already used
   * earlier in THIS export, or on disk by a different file, is never touched:
   * the next _2, _3 is used instead. When `size` is given and a file of that
   * name and exact size is already there, that is this photo from an earlier
   * run, so it is reported as `same` and not copied again. That makes a
   * stopped or partly failed export resumable by simply running it again.
   */
  function freeName(dir, name, taken, size) {
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    var k = 1;
    function next() {
      var cand = k === 1 ? name : stem + '_' + k + ext;
      if (taken[cand.toLowerCase()]) { k++; return next(); }
      return dir.getFileHandle(cand, { create: false }).then(function (h) {
        if (size === undefined) { k++; return next(); }
        return h.getFile().then(function (f) {
          if (f.size === size) { taken[cand.toLowerCase()] = 1; return { name: cand, same: true }; }
          k++;
          return next();
        });
      }, function () { taken[cand.toLowerCase()] = 1; return { name: cand, same: false }; });
    }
    return next();
  }

  function writeFile(dir, name, blob) {
    return dir.getFileHandle(name, { create: true })
      .then(function (f) { return f.createWritable(); })
      .then(function (w) { return w.write(blob).then(function () { return w.close(); }); });
  }

  function original(id) {
    var src = PT.sources[id];
    if (!src) return Promise.reject(new Error('original not reachable'));
    return typeof src.getFile === 'function' ? src.getFile() : Promise.resolve(src);
  }

  PT.sortExport = {
    open: function () {
      var body = PT.dom.$('#modal-body');
      var dlg = PT.dom.$('#modal');
      if (!body || !dlg) return;
      var canCopy = typeof window.showDirectoryPicker === 'function';
      var mode = canCopy ? 'copy' : 'list';
      var withTags = false;
      var busy = false;
      var cancelled = false;

      function draw() {
        var plan = exportPlan(withTags);
        var missing = sources(plan.items.map(function (it) { return it.id; }));
        PT.dom.clear(body);
        body.appendChild(el('h2', { text: 'Export the sorted shoot' }));

        var copyText = plan.items.length + ' photos, ' + PT.fmt.bytes(bytesOf(plan.items)) +
          (plan.tagged.length ? ' + ' + plan.tagged.length + ' tagged cop' + (plan.tagged.length === 1 ? 'y' : 'ies') + ', ' + PT.fmt.bytes(bytesOf(plan.tagged)) : '') +
          ' — written into a folder you pick, in the groups you see, with the manifest beside them. ' +
          'Pick an empty folder (the dialog can make one). Your originals are not touched.';
        var opt = function (key, title, text, disabled) {
          var input = el('input', { type: 'radio', name: 'so-exp-mode', value: key, dataset: { t: 'so-exp-' + key }, disabled: disabled });
          input.checked = mode === key;
          input.addEventListener('change', function () { mode = key; draw(); });
          return el('label', { class: 'so-exp-opt' + (mode === key ? ' on' : '') + (disabled ? ' off' : '') }, [
            input, el('span', {}, [el('b', { text: title }), el('span', { class: 'small dim', text: text })])
          ]);
        };
        body.appendChild(opt('copy', 'Copy into a new folder', canCopy ? copyText :
          'This browser cannot write into a folder you pick (Chromium can). The list still works.', !canCopy));
        body.appendChild(opt('list', 'Just the list',
          'A CSV and a JSON of every photo: its group, tags, and what the camera recorded. A few kilobytes; nothing is copied.'));

        if (mode === 'copy' && PT.tags.defs().length) {
          var cb = el('input', { type: 'checkbox', dataset: { t: 'so-exp-tags' } });
          cb.checked = withTags;
          cb.addEventListener('change', function () { withTags = cb.checked; draw(); });
          body.appendChild(el('label', { class: 'so-exp-check small' }, [cb,
            el('span', { text: 'Also copy each tag into its own folder (_tagged_<tag>/). A photo with two tags is copied twice.' })]));
        }

        if (mode === 'copy' && missing.length) {
          var input = el('input', { type: 'file', multiple: true, style: 'display:none', dataset: { t: 'so-reconnect-input' } });
          input.setAttribute('webkitdirectory', '');
          input.addEventListener('change', function () {
            var s = PT.store.get();
            var byPath = Object.create(null);
            Object.keys(s.photos).forEach(function (id) { byPath[s.photos[id].path] = id; });
            var hits = 0;
            Array.prototype.forEach.call(input.files, function (f) {
              var id = byPath[f.webkitRelativePath || f.name];
              if (id) { PT.sources[id] = f; hits++; }
            });
            PT.toast(hits ? 'Reconnected ' + hits + ' original' + (hits === 1 ? '' : 's') + '.' :
              'Nothing matched \u2014 is that the folder this session was read from?');
            draw();
          });
          body.appendChild(el('div', { class: 'notice notice-warn small', style: 'margin-top:10px' }, [
            el('span', { text: missing.length + ' of ' + plan.items.length + ' originals are not reachable: the page was reloaded since the folder was read. ' +
              'Reconnect it to copy them; the list works without.' }),
            input,
            el('button', { class: 'btn btn-sm', type: 'button', text: 'Reconnect the folder\u2026', onclick: function () { input.click(); } })
          ]));
        }

        var status = el('div', { class: 'small', dataset: { t: 'so-exp-status' } });
        var go = el('button', { class: 'btn btn-primary', type: 'button', dataset: { t: 'so-exp-go' },
          text: mode === 'copy' ? 'Choose a folder and copy' : 'Download the list',
          disabled: busy || (mode === 'copy' && (!canCopy || missing.length === plan.items.length)),
          onclick: function () { run(plan, status, go); } });
        body.appendChild(status);
        body.appendChild(el('div', { class: 'row', style: 'margin-top:14px' }, [
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn', type: 'button', text: busy ? 'Stop' : 'Close', dataset: { t: 'so-exp-close' },
            onclick: function () { if (busy) cancelled = true; else dlg.close(); } }),
          go
        ]));
      }

      function run(plan, status, go) {
        var stem = 'photournament_sort_manifest_v1.0';
        if (mode === 'list') {
          var docs = manifestDocs(plan, null);
          download(docs.csv, stem + '.csv');
          download(docs.json, stem + '.json');
          status.textContent = 'Downloaded the list for ' + plan.items.length + ' photos.';
          return;
        }
        var root;
        busy = true; cancelled = false;
        go.disabled = true;
        // The button was labelled when the dialog drew; it is Stop from here.
        var closeBtn = PT.dom.$('[data-t="so-exp-close"]', body);
        if (closeBtn) closeBtn.textContent = 'Stop';
        Promise.resolve(window.showDirectoryPicker({ mode: 'readwrite' }))
          .then(function (d) {
            root = d;
            return d.requestPermission ? d.requestPermission({ mode: 'readwrite' }) : 'granted';
          })
          .then(function (perm) {
            if (perm !== 'granted') throw new Error('permission to write was not granted');
            var jobs = plan.items.concat(plan.tagged);
            var taken = {};      // folder -> {lowercased name: 1}
            var written = {};    // id -> {file} for the organized copy
            var done = 0, already = 0, skipped = [], failed = [];
            var seq = Promise.resolve();
            jobs.forEach(function (it, k) {
              seq = seq.then(function () {
                if (cancelled) return;
                if (!PT.sources[it.id]) { skipped.push(it.photo.name); return; }
                return dirAt(root, it.folder).then(function (dir) {
                  var t = taken[it.folder] = taken[it.folder] || {};
                  return freeName(dir, it.photo.name, t, it.photo.size).then(function (spot) {
                    var copy = spot.same ? Promise.resolve() :
                      original(it.id).then(function (blob) { return writeFile(dir, spot.name, blob); });
                    return copy.then(function () {
                      if (k < plan.items.length) written[it.id] = { file: spot.name };
                      if (spot.same) already++; else done++;
                      status.textContent = 'Copying\u2026 ' + (done + already) + ' / ' + jobs.length;
                    });
                  });
                // One unwritable file (a name the disk refuses, a vanished
                // original) is reported, not allowed to abandon the rest.
                }).catch(function (e) {
                  PT.warn('sort-export', it.photo.name, e);
                  failed.push(it.photo.name);
                });
              });
            });
            return seq.then(function () {
              var docs = manifestDocs(plan, written);
              var t = {};
              return freeName(root, stem + '.csv', t)
                .then(function (n) { return writeFile(root, n.name, docs.csv); })
                .then(function () { return freeName(root, stem + '.json', t); })
                .then(function (n) { return writeFile(root, n.name, docs.json); })
                .then(function () { return { done: done, already: already, total: jobs.length, skipped: skipped, failed: failed }; });
            });
          })
          .then(function (r) {
            busy = false;
            draw();
            var msg = (cancelled ? 'Stopped after ' : 'Copied ') + r.done + ' of ' + r.total + ' into ' + root.name + '.' +
              (r.already ? ' ' + r.already + ' were already there from an earlier run.' : '') +
              (r.skipped.length ? ' ' + r.skipped.length + ' not reachable: reconnect the folder and run it again.' : '') +
              (r.failed.length ? ' ' + r.failed.length + ' could not be written (' + r.failed.slice(0, 3).join(', ') +
                (r.failed.length > 3 ? '\u2026' : '') + ').' : '') +
              (cancelled || r.skipped.length || r.failed.length ? ' Running it again into the same folder picks up where this left off.' : '');
            PT.dom.$('[data-t="so-exp-status"]', body).textContent = msg;
            PT.toast(msg);
          })
          .catch(function (e) {
            busy = false;
            draw();
            if (e && e.name === 'AbortError') return;
            PT.warn('sort-export', e);
            PT.dom.$('[data-t="so-exp-status"]', body).textContent = 'Could not copy: ' + (e && e.message || e);
          });
      }

      draw();
      if (!dlg.open) dlg.showModal();
    },
    /** Exposed for tests: the plan an export would carry out. */
    plan: exportPlan,
    manifest: manifestDocs
  };

  PT.sortScreen = {
    /** The photos in the current organization, in on-screen order, with their dirs. */
    current: function () {
      var g = grouped();
      return g;
    }
  };
})();

/*
CHANGELOG
v1.0 (2026-10-30): Initial release (PRD 7.12 draft). Whole-shoot grouped
  view driven by the shared Organize-by control, lazy thumbnails, click and
  shift-click selection, per-group select, a selection bar carrying the tag
  bar (Shift+1..9), lightbox per group, and the Export entry point.
v1.1 (2026-10-30): Export, priced and chosen each time: copy into a
  picked folder in the organized layout (optional per-tag sets, manifest
  beside them, never overwriting) or just the list as CSV and JSON. Reconnect
  for reloaded sessions.
v1.2 (2026-10-30): From review. Enter on a cell's expand button opens the
  photo instead of toggling selection. Copy export: a file already there with
  the same name and size is this photo from an earlier run and is not copied
  again (a stopped export resumes by running it again); one unwritable file is
  reported instead of abandoning the rest; the button reads Stop while
  copying; the manifest says which photos were copied; CSVs carry a BOM so
  Excel reads UTF-8.
*/
