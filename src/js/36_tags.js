/**
 * @file 36_tags.js
 * @version 1.1
 * @author Samuel Cao
 * @created 2026-10-30
 * @lastUpdated 2026-10-30
 * @description PRD 7.12 user tags: a session's short tag list, which photos carry which, and the one tag-bar control every screen that shows photos reuses.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * TAGS NEVER KEEP OR CUT (PRD 2). Nothing in this file touches a pool, a cut
 * pile, a quota or a bracket. A "maybe" tag must not be able to become a
 * second keep pile, so tags are deliberately inert to every stage: they only
 * ride along to the export, where they name extra result sets and fill the
 * manifest columns.
 *
 * TAGS ORGANIZE OUTPUT, NOT ALLOCATION. Allocation is fixed before judging
 * starts, when most tags do not exist yet, and a photo can carry several tags
 * but must sit in exactly one tournament unit. So "Tag" is deliberately not
 * one of PT.organize's categories.
 *
 * State lives in session.tags = { defs: [{id, name}], on: {photoId: [tagId]} },
 * persisted with the session like export labels are. Nine at most, because
 * Shift+1..9 is the keyboard and a tag list longer than that has stopped
 * being a quick mark.
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});
  var el = function () { return PT.dom.el.apply(null, arguments); };

  var MAX = 9;

  function state(s) {
    s = s || PT.store.get();
    var sess = s && s.session;
    if (!sess) return { defs: [], on: {} };
    return sess.tags || { defs: [], on: {} };
  }
  function ensure(s) {
    if (!s.session.tags) s.session.tags = { defs: [], on: {} };
    if (!s.session.tags.on) s.session.tags.on = {};
    if (!s.session.tags.defs) s.session.tags.defs = [];
    return s.session.tags;
  }

  function cleanName(name) {
    return String(name == null ? '' : name).replace(/[\u0000-\u001f\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32);
  }

  function defs() { return state().defs.slice(); }

  function of(id) { return (state().on[id] || []).slice(); }

  function has(id, tid) { return (state().on[id] || []).indexOf(tid) >= 0; }

  /** Tag names on a photo, in the tag list's order. */
  function names(id) {
    var on = state().on[id] || [];
    return state().defs.filter(function (d) { return on.indexOf(d.id) >= 0; }).map(function (d) { return d.name; });
  }

  /** 'all' | 'some' | 'none' for a tag across a set of photos. */
  function coverage(ids, tid) {
    var n = 0;
    ids.forEach(function (id) { if (has(id, tid)) n++; });
    return !n ? 'none' : n === ids.length ? 'all' : 'some';
  }

  /** Apply (on=true) or remove (on=false) a tag on every id; on omitted toggles as a set. */
  function set(ids, tid, on) {
    if (!ids || !ids.length) return;
    if (on === undefined) on = coverage(ids, tid) !== 'all';
    PT.store.dispatch('tags:set', function (s) {
      var t = ensure(s);
      ids.forEach(function (id) {
        var cur = t.on[id] || [];
        var i = cur.indexOf(tid);
        if (on && i < 0) cur = cur.concat([tid]);
        else if (!on && i >= 0) cur = cur.slice(0, i).concat(cur.slice(i + 1));
        if (cur.length) t.on[id] = cur; else delete t.on[id];
      });
    });
  }

  /** @returns {string|null} the new tag's id, or the existing one of that name. */
  function add(name) {
    name = cleanName(name);
    if (!name) return null;
    var existing = state().defs.filter(function (d) { return d.name.toLowerCase() === name.toLowerCase(); })[0];
    if (existing) return existing.id;
    if (state().defs.length >= MAX) return null;
    var id = null;
    PT.store.dispatch('tags:add', function (s) {
      var t = ensure(s);
      var k = 1;
      while (t.defs.some(function (d) { return d.id === 't' + k; })) k++;
      id = 't' + k;
      t.defs.push({ id: id, name: name });
    });
    return id;
  }

  function rename(tid, name) {
    name = cleanName(name);
    if (!name) return false;
    // add() refuses a duplicate name; rename must too, or two tags end up
    // indistinguishable in the bar and sharing one export folder.
    if (state().defs.some(function (d) { return d.id !== tid && d.name.toLowerCase() === name.toLowerCase(); })) return false;
    PT.store.dispatch('tags:rename', function (s) {
      ensure(s).defs.forEach(function (d) { if (d.id === tid) d.name = name; });
    });
    return true;
  }

  function remove(tid) {
    PT.store.dispatch('tags:remove', function (s) {
      var t = ensure(s);
      t.defs = t.defs.filter(function (d) { return d.id !== tid; });
      Object.keys(t.on).forEach(function (id) {
        var cur = t.on[id].filter(function (x) { return x !== tid; });
        if (cur.length) t.on[id] = cur; else delete t.on[id];
      });
    });
  }

  /** Photo ids carrying a tag, from a candidate list (order kept). */
  function photosWith(tid, ids) {
    return (ids || Object.keys(state().on)).filter(function (id) { return has(id, tid); });
  }

  /**
   * Shift+1..9 toggles the nth tag on `ids`. Matched on e.code, because
   * Shift+1 is '!' on a US layout and something else elsewhere.
   * @returns {boolean} whether the key was a tag key
   */
  function handleKey(e, ids) {
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
    var m = /^Digit([1-9])$/.exec(e.code || '');
    if (!m) return false;
    var d = state().defs[+m[1] - 1];
    if (!d || !ids || !ids.length) return false;
    e.preventDefault();
    set(ids, d.id);
    return true;
  }

  /**
   * The tag bar: one toggle chip per tag over whichever photos `getIds()`
   * returns, plus an inline "+ tag" that creates a tag AND applies it, since
   * the moment you think of a tag is the moment you are looking at a photo
   * that needs it. Re-renders itself on every tags:* action while attached;
   * detaches its subscription the first time it finds itself off the page,
   * so screens can throw bars away without bookkeeping.
   *
   * @param {{ids:function():string[], keys?:boolean, label?:string}} opts
   */
  function bar(opts) {
    var root = el('div', { class: 'pt-tags', dataset: { t: 'tag-bar' } });
    var adding = false;

    // Re-rendering replaces the chips, and a removed focused element drops
    // focus to <body> — outside the lightbox dialog whose keydown carries the
    // arrow and Shift+digit keys. So focus is carried across a render.
    var focusTag = null;
    function render() {
      var act = document.activeElement;
      if (act && root.contains(act) && act.dataset && act.dataset.tag) focusTag = act.dataset.tag;
      var hadFocus = !!(act && root.contains(act));
      PT.dom.clear(root);
      var ids = opts.ids() || [];
      if (opts.label) root.appendChild(el('span', { class: 'pt-tags-label', text: opts.label }));
      state().defs.forEach(function (d, i) {
        var cov = ids.length ? coverage(ids, d.id) : 'none';
        root.appendChild(el('button', {
          type: 'button',
          class: 'pt-tag' + (cov === 'all' ? ' on' : cov === 'some' ? ' some' : ''),
          'aria-pressed': cov === 'all' ? 'true' : cov === 'some' ? 'mixed' : 'false',
          dataset: { t: 'tag', tag: d.name },
          disabled: !ids.length,
          title: (cov === 'all' ? 'Remove "' : 'Tag with "') + d.name + '"' + (opts.keys ? ' (Shift+' + (i + 1) + ')' : ''),
          onclick: function () { set(opts.ids() || [], d.id); }
        }, [opts.keys ? el('kbd', { text: String(i + 1) }) : null, d.name]));
      });
      if (adding) {
        var input = el('input', { class: 'pt-tag-input', type: 'text', maxlength: '32', placeholder: 'new tag', dataset: { t: 'tag-new' } });
        input.addEventListener('keydown', function (e) {
          e.stopPropagation(); // arrows and digits here are typing, not navigation
          if (e.key === 'Enter') {
            // Leave adding mode BEFORE dispatching: add() re-renders this bar
            // synchronously, and that render must already show the new chip.
            // preventDefault, or this same Enter goes on to "click" the chip
            // that focus just moved to, and toggles the new tag straight off.
            e.preventDefault();
            var v = input.value;
            adding = false;
            focusTag = cleanName(v);
            var tid = add(v);
            if (tid && (opts.ids() || []).length) set(opts.ids(), tid, true);
            else render();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            adding = false;
            render();
          }
        });
        input.addEventListener('blur', function () { if (adding) { adding = false; render(); } });
        root.appendChild(input);
        setTimeout(function () { input.focus(); }, 0);
      } else if (state().defs.length < MAX) {
        root.appendChild(el('button', {
          type: 'button', class: 'pt-tag pt-tag-add', text: '+ tag', dataset: { t: 'tag-add' },
          title: 'Make a tag and apply it here',
          onclick: function () { adding = true; render(); }
        }));
      }
      if (hadFocus && !adding) {
        var back = focusTag && root.querySelector('[data-tag="' + focusTag.replace(/"/g, '\\"') + '"]');
        (back || root.querySelector('button') || root).focus();
        focusTag = null;
      }
    }

    // A bar off the page a second after it was made has been thrown away by a
    // re-render (or never used), so it stops listening.
    var born = Date.now();
    var off = PT.store.subscribe(function (s, name) {
      if (!root.isConnected) { if (Date.now() - born > 1000) off(); return; }
      if (/^tags:/.test(name)) render();
    });
    render();
    return { el: root, refresh: render };
  }

  /** The rename/delete list, in the shared #modal. */
  function manage() {
    var body = PT.dom.$('#modal-body');
    var dlg = PT.dom.$('#modal');
    if (!body || !dlg) return;
    function draw() {
      PT.dom.clear(body);
      body.appendChild(el('h2', { text: 'Tags' }));
      body.appendChild(el('p', { class: 'muted small', text:
        'Tags never keep or cut a photo. They ride along to the export, where each one can become its own result set.' }));
      var list = el('div', { class: 'pt-tag-manage' });
      var counts = {};
      Object.keys(state().on).forEach(function (id) { state().on[id].forEach(function (t) { counts[t] = (counts[t] || 0) + 1; }); });
      state().defs.forEach(function (d, i) {
        var input = el('input', { type: 'text', value: d.name, maxlength: '32', dataset: { t: 'tag-rename' } });
        input.addEventListener('change', function () { if (!rename(d.id, input.value)) input.value = d.name; });
        list.appendChild(el('div', { class: 'row' }, [
          el('kbd', { text: 'Shift+' + (i + 1) }),
          input,
          el('span', { class: 'small dim nums', text: (counts[d.id] || 0) + ' photo' + (counts[d.id] === 1 ? '' : 's') }),
          el('button', { class: 'btn btn-sm btn-quiet', type: 'button', text: 'Delete', dataset: { t: 'tag-delete' },
            onclick: function () { remove(d.id); draw(); } })
        ]));
      });
      if (!state().defs.length) list.appendChild(el('p', { class: 'small dim', text: 'No tags yet. Use "+ tag" under any photo.' }));
      body.appendChild(list);
      if (state().defs.length < MAX) {
        var fresh = el('input', { type: 'text', maxlength: '32', placeholder: 'Add a tag', dataset: { t: 'tag-manage-new' } });
        fresh.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { if (add(fresh.value)) draw(); }
        });
        body.appendChild(el('div', { class: 'row', style: 'margin-top:10px' }, [fresh]));
      }
      body.appendChild(el('div', { class: 'row', style: 'margin-top:14px' }, [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn btn-primary', type: 'button', text: 'Done', onclick: function () { dlg.close(); } })
      ]));
    }
    draw();
    if (!dlg.open) dlg.showModal();
  }

  PT.tags = {
    MAX: MAX,
    defs: defs,
    of: of,
    has: has,
    names: names,
    coverage: coverage,
    set: set,
    add: add,
    rename: rename,
    remove: remove,
    photosWith: photosWith,
    handleKey: handleKey,
    bar: bar,
    manage: manage
  };
})();

/*
CHANGELOG
v1.0 (2026-10-30): Initial release (PRD 7.12 draft). Session tag list (max
  nine), per-photo membership, set-wise toggling with mixed state, Shift+1..9,
  the self-detaching tag bar, and the rename/delete manager.
v1.1 (2026-10-30): rename() refuses a name another tag already has, as
  add() always did.
*/
