/**
 * @file 99_app.js
 * @version 1.0
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description Application boot: environment checks, session resume, stage routing, toasts, and the global keyboard layer.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * Loads last. Every screen module has registered itself by the time this runs.
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});
  var el = PT.dom.el;

  /* ------------------------------------------------------------- toasts --- */

  PT.bus.on('toast', function (msg) {
    var host = PT.dom.$('#toasts');
    if (!host) return;
    var t = el('div', { class: 'toast', text: String(msg) });
    host.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      t.style.transition = 'opacity 250ms';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, 3200);
  });

  PT.toast = function (msg) { PT.bus.emit('toast', msg); };

  /* -------------------------------------------------------------- modal --- */

  var modal = null;
  PT.ready(function () {
    modal = PT.dom.$('#modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        // Click outside the panel closes; clicks inside must not.
        if (e.target === modal) modal.close();
      });
    }
  });

  /* ------------------------------------------------------------ routing --- */

  /**
   * Where a restored session should land. Screens own their own internal
   * position (a half-finished Stage A pass resumes from unit.currentPass), so
   * this only has to pick the right screen.
   */
  function screenForSession(session) {
    if (!session) return { name: 'welcome' };
    switch (session.stage) {
      case 'tree':   return { name: 'tree' };
      case 'export': return { name: 'export' };
      case 'unit': {
        var u = session.units[session.activeUnitId];
        if (!u) {
          var pending = PT.session.pendingUnits(session);
          if (!pending.length) return { name: 'export' };
          return { name: 'grid', params: { unitId: pending[0].id } };
        }
        var byPhase = {
          gridA: 'grid', rescue: 'rescue', dupes: 'grid',
          bracket: 'bracket', runoff: 'runoff', done: 'grid'
        };
        return { name: byPhase[u.phase] || 'grid', params: { unitId: u.id } };
      }
      default: return { name: 'welcome' };
    }
  }

  /**
   * Called by stage screens when a unit finishes. Advances to the next pending
   * unit, then Stage D if enabled (PRD 7.6), then export.
   */
  PT.advance = function () {
    var s = PT.store.get();
    var session = s.session;
    var pending = PT.session.pendingUnits(session);

    if (pending.length) {
      PT.store.dispatch('unit:next', function (ss) { ss.session.activeUnitId = pending[0].id; });
      PT.router.go('grid', { unitId: pending[0].id });
      return;
    }

    if (session.settings.stageD && !session.stageDUnit) {
      var field = PT.session.allWinners(session);
      if (field.length > 1) {
        PT.store.dispatch('stageD:create', function (ss) {
          var u = PT.session.newUnit({
            id: 'stageD',
            kind: 'fixed',
            label: 'best of the best',
            target: Math.min(ss.session.settings.stageDTarget, field.length),
            photoIds: field
          });
          ss.session.units.stageD = u;
          ss.session.stageDUnit = 'stageD';
          ss.session.activeUnitId = 'stageD';
        });
        PT.router.go('grid', { unitId: 'stageD' });
        return;
      }
    }

    PT.store.dispatch('stage:export', function (ss) {
      ss.session.stage = 'export';
      ss.session.activeUnitId = null;
    });
    PT.router.go('export');
  };

  /* ------------------------------------------------------------- resume --- */

  /**
   * PRD 7.10. Decisions live in the sessions store and survive independently of
   * the derivative cache, which the browser may evict at any time (probe 01
   * measured storage.persist() returning false even on localhost).
   */
  function tryResume() {
    return PT.db.all('sessions').then(function (rows) {
      if (!rows || !rows.length) return null;
      rows.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      var session = rows[0];
      if (!session || session.finished) return null;
      if (session.stage === 'ingest') return null;
      return session;
    }).catch(function () { return null; });
  }

  function offerResume(session) {
    var root = PT.dom.$('#screen');
    PT.dom.clear(root);
    var wrap = el('div', { class: 'screen screen-narrow' });
    root.appendChild(wrap);

    var when = new Date(session.createdAt).toLocaleString();
    var units = Object.keys(session.units || {});
    var done = units.filter(function (k) { return session.units[k].phase === 'done'; }).length;

    wrap.appendChild(el('div', { class: 'card' }, [
      el('h1', { text: 'Pick up where you left off?' }),
      el('p', { class: 'muted', text:
        session.rootName + ' — started ' + when + '. ' +
        (units.length ? done + ' of ' + units.length + ' tournaments finished.' : '') }),
      el('div', { class: 'row', style: 'margin-top:14px' }, [
        el('button', { class: 'btn btn-primary', text: 'Resume', onclick: function () { doResume(session); } }),
        el('button', { class: 'btn', text: 'Start fresh', onclick: function () {
          PT.db.clear('sessions');
          PT.router.go('welcome');
        } })
      ])
    ]));
  }

  function doResume(session) {
    Promise.all([PT.db.all('photos'), PT.db.all('derivatives')]).then(function (r) {
      var photos = {}, derivatives = {};
      (r[0] || []).forEach(function (p) { photos[p.id] = p; });
      (r[1] || []).forEach(function (d) { derivatives[d.id] = d; });

      var live = Object.keys(photos).map(function (k) { return photos[k]; })
        .filter(function (p) { return !p.err; });

      PT.store.init({
        session: session,
        photos: photos,
        derivatives: derivatives,
        tree: live.length ? PT.tree.build(live) : null,
        resolution: null
      });

      if (!Object.keys(derivatives).length && live.length) {
        PT.toast('The thumbnail cache was cleared by the browser. Your decisions are intact.');
      }

      var target = screenForSession(session);
      PT.router.go(target.name, target.params);
    }).catch(function (e) {
      PT.warn('resume', e);
      PT.router.go('welcome');
    });
  }

  /* -------------------------------------------------------------- boot ---- */

  PT.ready(function () {
    // Chromium-only is a deliberate PRD 8 decision, but it must be stated rather
    // than surfacing as a mysteriously broken button.
    if (!PT.env.hasFSA) {
      PT.log('app', 'File System Access API unavailable: resume and disk output are off');
    }

    var stop = PT.dom.$('#topbar-stop');
    if (stop) {
      stop.addEventListener('click', function () { PT.bus.emit('stage:stop-early'); });
    }

    tryResume().then(function (session) {
      if (session) offerResume(session);
      else PT.router.go('welcome');
    });
  });

  /* --------------------------------------------------------- diagnostics -- */

  /** Handy from the console; also what the smoke tests drive. */
  PT.debug = {
    state: function () { return PT.store.get(); },
    resetAll: function () {
      return Promise.all([
        PT.db.clear('sessions'), PT.db.clear('photos'),
        PT.db.clear('derivatives'), PT.db.clear('handles')
      ]).then(function () { location.reload(); });
    },
    screens: function () { return Object.keys(PT.router._screens || {}); }
  };
})();

/** CHANGELOG
 * v1.0 (2026-07-28): Initial release. Toasts, modal dismissal, stage routing
 *   with per-phase screen selection, unit advance including the optional Stage D,
 *   session resume with an evicted-cache notice, and console diagnostics.
 */
