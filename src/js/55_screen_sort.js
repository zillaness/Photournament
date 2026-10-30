/**
 * @file 55_screen_sort.js
 * @version 1.0
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
*/
