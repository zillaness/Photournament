/**
 * @file 99_app.js
 * @version 1.3
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

  /* -------------------------------------------------------------- theme --- */

  /**
   * Dark by default, light on request. A DELIBERATE choice, never inferred:
   * there is no auto mode and no prefers-color-scheme query, because which
   * surround suits depends on the light in the room the culling is happening in
   * and the operating system does not know that.
   *
   * The light theme is a mid-grey page with an L*50 well, not a white one. A
   * white surround makes a photograph read darker, flatter and lower in contrast
   * than the same photograph against mid-grey — precisely the interference the
   * app exists to avoid. ISO 3664 specifies mid-grey for a viewing surround.
   *
   * The shell applies the stored theme before first paint; this only handles
   * changing it afterwards.
   */
  var THEME_KEY = 'photournament.theme';

  function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  function applyTheme(next) {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* storage may be blocked */ }

    syncThemeColor();
    PT.dom.$$('.theme-toggle, #topbar-theme').forEach(paintToggle);
    PT.bus.emit('theme:change', next);
  }

  /**
   * Keeps the browser chrome matching the page it frames, reading the resolved
   * --bg rather than hard-coding either theme's value so the two cannot drift.
   *
   * Resolved by PAINTING and reading the pixel back. Setting canvas fillStyle and
   * reading it again returns the oklch string verbatim, and meta[theme-color]
   * does not accept oklch — the chrome would silently keep the previous colour.
   */
  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var css = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (!css) return;
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      var x = c.getContext('2d');
      x.fillStyle = css;
      x.fillRect(0, 0, 1, 1);
      var d = x.getImageData(0, 0, 1, 1).data;
      meta.setAttribute('content', '#' + [d[0], d[1], d[2]]
        .map(function (v) { return v.toString(16).padStart(2, '0'); }).join(''));
    } catch (e) { /* leave the existing value rather than writing a broken one */ }
  }

  /** Labelled with the theme it switches TO, which is what the user is choosing. */
  function paintToggle(btn) {
    if (!btn) return;
    var to = currentTheme() === 'dark' ? 'light' : 'dark';
    btn.textContent = to === 'light' ? 'Light' : 'Dark';
    btn.title = 'Switch to the ' + to + ' surround  (T)';
    btn.setAttribute('aria-label', 'Switch to the ' + to + ' surround');
  }

  PT.theme = {
    get: currentTheme,
    set: applyTheme,
    toggle: function () { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); },
    /** Screens call this for their own copy of the control. */
    attach: function (btn) {
      if (!btn) return btn;
      btn.classList.add('theme-toggle');
      btn.addEventListener('click', function () { PT.theme.toggle(); });
      paintToggle(btn);
      return btn;
    }
  };

  /* ------------------------------------------------------------ routing --- */

  /**
   * Where a restored session should land. Screens own their own internal
   * position (a half-finished Stage A pass resumes from unit.currentPass), so
   * this only has to pick the right screen.
   */
  function screenForSession(session) {
    if (!session) return { name: 'welcome' };
    // PRD 7.7: a review that was open when the tab closed reopens, so a hand
    // edit is never stranded behind a reload.
    if (session.groups && session.groups.status === 'review') return { name: 'dupes' };
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

      // PRD 7.10: new photos detected on resume, with a prompt to fold them in
      // or start fresh. Deliberately AFTER the screen is mounted — the user is
      // back where they left off first, and the question arrives as a prompt
      // over it rather than as a gate in front of it.
      checkForNewPhotos(session, photos);
    }).catch(function (e) {
      PT.warn('resume', e);
      PT.router.go('welcome');
    });
  }

  /**
   * Re-walks the stored folder handle and compares against the photo ids already
   * in the session. Fingerprints are stable across sessions (content hash plus
   * path, size and mtime), so anything unrecognised is genuinely new.
   *
   * Silent when nothing changed, and silent when there is no handle to walk —
   * a dropped-files session has nothing to re-read.
   */
  function checkForNewPhotos(session, photos) {
    if (session.sourceKind !== 'handle' || !PT.env.hasFSA) return;

    PT.db.get('handles', 'root').then(function (rec) {
      if (!rec || !rec.handle) return;
      return rec.handle.queryPermission({ mode: 'read' }).then(function (p) {
        // Re-granting needs a user gesture, and this runs without one. Staying
        // quiet is correct: the alternative is a permission prompt the user did
        // not ask for, every time they resume.
        if (p !== 'granted') return;
        return PT.scanForNew(rec.handle, photos);
      });
    }).then(function (found) {
      if (!found || !found.length) return;
      promptNewPhotos(found);
    }).catch(function (e) {
      PT.warn('resume', 'new-photo check failed', e);
    });
  }

  function promptNewPhotos(found) {
    var body = PT.dom.$('#modal-body');
    if (!body) return;
    PT.dom.clear(body);
    body.appendChild(el('h2', {
      text: found.length + ' new photo' + (found.length === 1 ? '' : 's') + ' since you started'
    }));
    body.appendChild(el('p', { class: 'muted small', text:
      found.slice(0, 5).map(function (f) { return f.name; }).join(', ') +
      (found.length > 5 ? ', and ' + (found.length - 5) + ' more' : '') }));
    body.appendChild(el('p', { class: 'muted small', text:
      'Folding them in means re-running the folder counts, because the field they ' +
      'compete in has changed. Your existing decisions are kept either way.' }));
    body.appendChild(el('div', { class: 'row', style: 'margin-top:14px' }, [
      el('button', { class: 'btn', text: 'Ignore them for now', onclick: function () {
        PT.dom.$('#modal').close();
      } }),
      el('button', { class: 'btn btn-primary', text: 'Start fresh with everything',
        onclick: function () {
          PT.dom.$('#modal').close();
          Promise.all([
            PT.db.clear('sessions'), PT.db.clear('photos'), PT.db.clear('derivatives')
          ]).then(function () { location.reload(); });
        } })
    ]));
    PT.dom.$('#modal').showModal();
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

    PT.theme.attach(PT.dom.$('#topbar-theme'));
    // The shell applied the stored theme before first paint, but nothing has
    // brought the chrome colour and the control labels into line with it yet.
    syncThemeColor();

    /*
     * T, globally. The reason to switch is never "I prefer light mode" — it is
     * "does this photograph read differently against the other surround", asked
     * mid-judgement about one specific image. Having to leave the keyboard and
     * find a button means the question stops being asked. T is free in every
     * screen: the grid pass uses 0-9, Enter, U and the arrows; the bracket uses
     * the arrows, D and U.
     */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 't' && e.key !== 'T') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
                t.isContentEditable)) return;
      e.preventDefault();
      PT.theme.toggle();
    });

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
  * v1.1 (2026-07-28): Reopens an in-progress duplicate review on resume, so a
 *   hand edit is never stranded behind a reload.
 * v1.2 (2026-07-28): PRD 7.10 new-photo detection on resume. Re-walks the stored
 *   folder handle, compares by fingerprint, and prompts to fold new files in or
 *   start fresh. Silent when nothing changed, when there is no handle to walk, and
 *   when read permission would need a fresh gesture — the alternative is a
 *   permission prompt on every resume that the user never asked for.
 * v1.3 (2026-07-28): Added the dark/light surround toggle. Deliberate choice
 *   only — no auto mode and no prefers-color-scheme, because which surround suits
 *   depends on the light in the room and the OS does not know that. Bound to T
 *   globally, since the question is asked mid-judgement about one photograph and
 *   leaving the keyboard means it stops being asked. Chrome colour is resolved by
 *   painting --bg and reading the pixel: fillStyle returns oklch verbatim and
 *   meta[theme-color] does not accept it.
*/
