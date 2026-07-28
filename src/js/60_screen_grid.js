/**
 * @file 60_screen_grid.js
 * @version 1.0
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description Stage A grid pass screen (PRD 7.1), the low cull rate offer (PRD 7.2), and the cut pile rescue screen (PRD 7.5). Registers the 'grid' and 'rescue' screens.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * This is the forcing function of PRD section 2 made concrete. Three properties
 * are load-bearing and everything else here is in service of them:
 *
 *   1. The quota locks at pass start. PT.session.startPass COPIES the settings
 *      into the pass, and every quota decision on this screen reads the pass copy,
 *      never session.settings. Changing a setting mid-pass therefore cannot loosen
 *      the commitment even if some other screen writes to settings. The config
 *      controls are still rendered during a pass, disabled, next to a lock badge —
 *      PRD 7.1 asks for the constraint to be visible rather than silent.
 *
 *   2. All stage state lives in the store, never in a closure here. unit.currentPass
 *      holds order/index/kept/sel and is written on every toggle and every advance,
 *      so PRD 7.10's mid-pass resume is a consequence of the data model rather than
 *      a feature bolted on. A reload mid-pass re-enters on the same screen with the
 *      same selection.
 *
 *   3. Only the photos on screen hold object URLs. Every screen advance releases
 *      the previous cells, and the rescue pile — which can be hundreds of photos in
 *      one scroller — attaches and releases through an IntersectionObserver. At 500
 *      photos, holding every thumbnail URL defeats the bounded-memory strategy PRD
 *      section 8 depends on.
 *
 * Two fields are added to the unit record beyond PT.session.newUnit:
 *   unit.lastSummary        the finished pass summary being reported (PRD 7.2)
 *   unit.lastPassSnapshot   pool + cut as they were BEFORE that pass, so the
 *                           re-run offer can actually undo it. Persisted rather
 *                           than held in memory because the user may reload while
 *                           the offer is on screen.
 *   unit.rescueLimit        the pre-committed rescue cap (PRD 7.5), locked once set
 *   unit.rescueSel          in-progress rescue selection, so review survives reload
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});
  var dom = PT.dom;
  var el = dom.el;
  var S = PT.session;

  var STYLE_ID = 'pt-grid-style';

  /* ------------------------------------------------------------------ style */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.pt-wrap{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;}',
      '.pt-config{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:10px 12px;}',
      '.pt-config .f{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-dim);}',
      '.pt-config select,.pt-config input[type="number"]{padding:3px 6px;font-size:13px;}',
      '.pt-config input[type="number"]{width:72px;}',
      '.pt-config.locked{opacity:.8;}',
      '.pt-lock{font-size:12px;border:1px solid var(--warn);color:var(--warn);border-radius:4px;padding:2px 8px;white-space:nowrap;}',
      '.pt-grid{flex:1 1 auto;min-height:0;overflow-y:auto;align-content:start;}',
      '.pt-pile{flex:1 1 auto;min-height:0;overflow-y:auto;}',
      '.pt-cell-name{position:absolute;left:0;right:0;bottom:0;font-size:11px;padding:3px 6px;' +
        'background:linear-gradient(transparent,rgba(0,0,0,.85));color:var(--text-dim);' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;}',
      '.pt-missing{display:flex;align-items:center;justify-content:center;height:100%;' +
        'color:var(--text-mute);font-size:11px;text-align:center;padding:8px;}',
      '.pt-actions{position:sticky;bottom:0;background:var(--bg);padding-top:8px;}',
      '.pt-hint{color:var(--warn);font-size:13px;}',
      '.pt-sum b{color:var(--text);}',
      '.pt-title{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}'
    ].join('\n');
    document.head.appendChild(el('style', { id: STYLE_ID, text: css }));
  }

  /* ---------------------------------------------------------------- helpers */

  function st() { return PT.store.get(); }

  function unitId(params) {
    var s = st();
    if (params && params.unitId) return params.unitId;
    return s && s.session ? s.session.activeUnitId : null;
  }

  function getUnit(id) {
    var s = st();
    if (!s || !s.session || !s.session.units) return null;
    return s.session.units[id] || null;
  }

  /** Mutate the unit through the store so the change persists and resume works. */
  function editUnit(id, name, fn) {
    PT.store.dispatch(name, function (state) {
      var u = state.session.units[id];
      if (u) fn(u, state);
    });
  }

  function photoName(id) {
    var s = st();
    var p = s && s.photos ? s.photos[id] : null;
    return (p && (p.name || p.path)) || id;
  }

  function thumbOf(id) {
    var s = st();
    var d = s && s.derivatives ? s.derivatives[id] : null;
    return d ? (d.thumb || d.preview || null) : null;
  }

  function toast(msg) {
    var host = document.getElementById('toasts');
    if (!host) return;
    var t = el('div', { class: 'toast', text: msg });
    host.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
  }

  /**
   * Navigate without exploding when a downstream screen is not in this build.
   * A half-built artifact should say so, not throw out of a click handler.
   */
  function goSafe(name, params) {
    try {
      PT.router.go(name, params);
      return true;
    } catch (e) {
      PT.warn('grid', 'navigation to "' + name + '" failed', e);
      toast('The ' + name + ' screen is not available in this build yet.');
      return false;
    }
  }

  function setTopbar(contextText, counterNodes) {
    var bar = document.getElementById('topbar');
    if (bar) bar.hidden = false;
    var ctx = document.getElementById('topbar-context');
    if (ctx) ctx.textContent = contextText || '';
    var cnt = document.getElementById('topbar-counters');
    if (cnt) {
      dom.clear(cnt);
      (counterNodes || []).forEach(function (n) { cnt.appendChild(n); });
    }
  }

  function clearTopbar() {
    var ctx = document.getElementById('topbar-context');
    if (ctx) ctx.textContent = '';
    var cnt = document.getElementById('topbar-counters');
    if (cnt) dom.clear(cnt);
  }

  function counter(label, value) {
    return el('span', {}, [label + ' ', el('b', { text: String(value) })]);
  }

  /* ------------------------------------------------------------ pure logic */

  /** The locked configuration of a live pass, shaped like a settings object. */
  function passSettings(pass) {
    return { quotaMode: pass.quotaMode, quotaCustom: pass.quotaCustom };
  }

  function quotaFor(pass, screenCount) {
    return S.resolveQuota(passSettings(pass), screenCount);
  }

  /**
   * PRD 7.1 counters. Pure so it can be unit tested and so the topbar and the
   * action row cannot disagree about what the numbers are.
   */
  function passCounters(unit, pass) {
    var total = pass.order.length;
    var screens = S.screensTotal(pass);
    var screen = S.screenAt(pass, pass.index);
    var sel = pass.sel || [];
    var shown = pass.index * pass.gridSize + screen.length;
    var keptLive = pass.kept.length + sel.length;
    var unseen = Math.max(0, total - shown);
    return {
      remaining: total - pass.index * pass.gridSize, // this screen included
      screensLeft: screens - pass.index,
      screensTotal: screens,
      screenNo: pass.index + 1,
      field: keptLive + unseen,                      // projected survivors
      target: unit.target,
      cutPct: shown ? (shown - keptLive) / shown : 0
    };
  }

  /**
   * PRD 7.2: the offer is to re-run "with a tighter quota", so the tool has to
   * propose one. One notch tighter each time, bottoming out at Keep 1 — which is
   * the tightest quota that still lets a pass make progress.
   */
  function tightenQuota(cfg, gridSize) {
    var size = gridSize || cfg.gridSize || 9;
    switch (cfg.quotaMode) {
      case 'unlimited':
        return { quotaMode: 'half', quotaCustom: cfg.quotaCustom };
      case 'half':
        return { quotaMode: 'custom', quotaCustom: Math.max(1, Math.floor(size / 2) - 1) };
      case 'custom':
        return cfg.quotaCustom > 1
          ? { quotaMode: 'custom', quotaCustom: cfg.quotaCustom - 1 }
          : { quotaMode: 'one', quotaCustom: 1 };
      default:
        return { quotaMode: 'one', quotaCustom: 1 };
    }
  }

  /** PRD 7.5: fixed number, percentage of the cut pile, or unlimited. */
  function rescueMax(limit, cutCount) {
    if (!limit) return 0;
    if (limit.mode === 'unlimited') return Infinity;
    if (limit.mode === 'pct') {
      var pct = Math.max(0, Math.min(100, Number(limit.value) || 0));
      if (!pct) return 0;
      return Math.min(cutCount, Math.max(1, Math.round((cutCount * pct) / 100)));
    }
    return Math.min(cutCount, Math.max(0, Math.floor(Number(limit.value) || 0)));
  }

  function rescueLimitLabel(limit, cutCount) {
    if (!limit) return 'not set';
    if (limit.mode === 'unlimited') return 'unlimited';
    if (limit.mode === 'pct') return limit.value + '% of ' + cutCount + ' = ' + rescueMax(limit, cutCount);
    return String(rescueMax(limit, cutCount));
  }

  function capLabel(quota) {
    return quota === Infinity ? 'no limit' : 'keep at most ' + quota;
  }

  /* ================================================================== GRID */

  var G = null; // live mount state; nulled by unmount

  function releaseCells() {
    if (!G) return;
    G.imgs.forEach(function (img) { dom.releaseImg(img); });
    G.imgs = [];
  }

  /**
   * A photo cell. `pos` is 1-based and drives the number-key mapping; the tenth
   * cell is labelled 0 because that is the key that selects it.
   */
  function photoCell(id, pos, onClick) {
    var img = el('img', { class: 'thumb', alt: '' });
    var blob = thumbOf(id);
    var body;
    if (blob) {
      dom.setImg(img, blob);
      body = img;
    } else {
      body = el('div', { class: 'pt-missing', text: 'no thumbnail' });
    }
    var cell = el('div', {
      class: 'photo-cell',
      dataset: { id: id, pos: String(pos), t: 'cell' },
      title: photoName(id),
      onclick: function () { onClick(id); }
    }, [
      body,
      el('span', { class: 'idx', text: pos <= 9 ? String(pos) : (pos === 10 ? '0' : String(pos)) }),
      el('span', { class: 'pt-cell-name', text: photoName(id) })
    ]);
    return { cell: cell, img: blob ? img : null };
  }

  /* --------------------------------------------------------- config card */

  /**
   * PRD 7.1's configuration table. Rendered in both views: live before a pass,
   * disabled with a lock badge during one. Disabling rather than hiding is
   * deliberate — the user needs to see what they committed to.
   */
  function configCard(unit, locked) {
    var s = st().session;
    var cfg = locked ? unit.currentPass : s.settings;
    var wrap = el('div', { class: 'card card-tight pt-config' + (locked ? ' locked' : ''), dataset: { t: 'config' } });

    function field(label, control) {
      return el('label', { class: 'f' }, [label, control]);
    }

    var gridSel = el('select', {
      dataset: { t: 'cfg-grid' },
      disabled: locked,
      onchange: function () {
        var v = parseInt(gridSel.value, 10);
        PT.store.dispatch('settings:gridSize', function (state) { state.session.settings.gridSize = v; });
        render();
      }
    }, [6, 9, 12, 16].map(function (n) {
      return el('option', { value: String(n), text: String(n) + ' per screen', selected: cfg.gridSize === n });
    }));

    var quotaSel = el('select', {
      dataset: { t: 'cfg-quota' },
      disabled: locked,
      onchange: function () {
        var v = quotaSel.value;
        PT.store.dispatch('settings:quotaMode', function (state) { state.session.settings.quotaMode = v; });
        render();
      }
    }, [
      ['one', 'Keep 1'],
      ['half', 'Keep up to half'],
      ['custom', 'Custom number'],
      ['unlimited', 'Unlimited']
    ].map(function (o) {
      return el('option', { value: o[0], text: o[1], selected: cfg.quotaMode === o[0] });
    }));

    var customIn = el('input', {
      type: 'number', min: '1', max: '64',
      value: String(cfg.quotaCustom || 1),
      dataset: { t: 'cfg-custom' },
      disabled: locked,
      onchange: function () {
        var v = Math.max(1, parseInt(customIn.value, 10) || 1);
        customIn.value = String(v);
        PT.store.dispatch('settings:quotaCustom', function (state) { state.session.settings.quotaCustom = v; });
        render();
      }
    });

    var shuffleIn = el('input', {
      type: 'checkbox',
      dataset: { t: 'cfg-shuffle' },
      disabled: locked,
      onchange: function () {
        var v = shuffleIn.checked;
        PT.store.dispatch('settings:shuffle', function (state) { state.session.settings.shuffle = v; });
      }
    });
    shuffleIn.checked = locked ? !!cfg.shuffled : !!s.settings.shuffle;

    var floorIn = el('input', {
      type: 'number', min: '0', max: '100',
      value: String(Math.round((s.settings.cullFloor || 0) * 100)),
      dataset: { t: 'cfg-floor' },
      disabled: locked,
      title: 'Low cull rate warning floor (PRD 7.2). 0 disables it.',
      onchange: function () {
        var v = Math.max(0, Math.min(100, parseInt(floorIn.value, 10) || 0));
        floorIn.value = String(v);
        PT.store.dispatch('settings:cullFloor', function (state) { state.session.settings.cullFloor = v / 100; });
      }
    });

    wrap.appendChild(field('Grid', gridSel));
    wrap.appendChild(field('Quota', quotaSel));
    if ((locked ? cfg.quotaMode : s.settings.quotaMode) === 'custom') wrap.appendChild(field('Keep up to', customIn));
    wrap.appendChild(field('Shuffle', shuffleIn));
    wrap.appendChild(field('Low cull floor %', floorIn));

    if (locked) {
      wrap.appendChild(el('span', { class: 'pt-lock', dataset: { t: 'lock-badge' },
        text: 'Locked for pass ' + cfg.n + ': ' + S.quotaLabel(passSettings(cfg)) }));
      wrap.appendChild(el('span', { class: 'small dim', dataset: { t: 'lock-note' },
        text: 'The quota is locked until this pass ends. Changes take effect on the next pass.' }));
    }
    return wrap;
  }

  /* -------------------------------------------------------- setup / between */

  function renderSetup(unit) {
    var s = st().session;
    var root = G.root;
    dom.clear(root);
    releaseCells();

    var wrap = el('div', { class: 'pt-wrap screen-narrow' });
    root.appendChild(wrap);

    setTopbar(unit.label + ' · Stage A', [
      counter('pool', unit.pool.length),
      counter('cut', unit.cut.length),
      counter('target', unit.target == null ? '—' : unit.target),
      counter('passes', unit.passes.length)
    ]);

    wrap.appendChild(el('div', { class: 'pt-title' }, [
      el('h1', { text: unit.label }),
      el('span', { class: 'muted small', dataset: { t: 'unit-line' },
        text: unit.pool.length + ' in the pool · ' + unit.cut.length + ' cut · ' +
              (unit.target == null ? 'uncapped' : 'target ' + unit.target) })
    ]));

    /* ---- PRD 7.2: report the last pass, and offer the re-run if it was thin */
    if (unit.lastSummary) {
      var sum = unit.lastSummary;
      var card = el('div', { class: 'card pt-sum', dataset: { t: 'summary' } }, [
        el('h2', { text: 'Pass ' + sum.n + ' complete' }),
        el('p', { class: 'muted small', dataset: { t: 'summary-line' } }, [
          'Cut ', el('b', { text: String(sum.cut) }), ' of ', el('b', { text: String(sum.before) }),
          ' (', el('b', { text: PT.fmt.pct(sum.cutPct) }), ' cut) across ',
          el('b', { text: String(sum.screens) }), ' screens. ',
          el('b', { text: String(sum.after) }), ' survive.'
        ])
      ]);
      wrap.appendChild(card);

      if (unit.lastPassSnapshot && S.lowCullRate(sum, s.settings)) {
        var tighter = tightenQuota(sum, sum.gridSize);
        var note = el('div', { class: 'notice notice-warn', dataset: { t: 'lowcull' } }, [
          el('p', {}, [
            'That pass cut only ', el('b', { text: PT.fmt.pct(sum.cutPct) }), ', below your ',
            el('b', { text: PT.fmt.pct(s.settings.cullFloor) }), ' floor. It cost ' + sum.screens +
            ' screens and left the pile largely intact.'
          ]),
          el('p', { class: 'small', text:
            'You can re-run pass ' + sum.n + ' with a tighter quota (' +
            S.quotaLabel(tighter) + '), which puts the ' + sum.cut +
            ' cut photos back first. Or keep the result as it stands.' }),
          el('div', { class: 'row' }, [
            el('button', { class: 'btn btn-primary', dataset: { t: 'rerun' },
              text: 'Re-run pass ' + sum.n + ' — ' + S.quotaLabel(tighter),
              onclick: function () { rerunPass(tighter); } }),
            el('button', { class: 'btn', dataset: { t: 'decline' }, text: 'Keep these results',
              onclick: function () {
                editUnit(G.unitId, 'grid:declineRerun', function (u) { u.lastPassSnapshot = null; });
                render();
              } })
          ])
        ]);
        card.appendChild(note);
      }
    }

    /* ---- PRD 7.1 handoff suggestion; uncapped units get none */
    if (unit.passes.length) {
      var sug = S.bracketSuggestion(unit);
      wrap.appendChild(el('div', {
        class: 'notice ' + (sug && sug.ready ? 'notice-note' : 'notice-note'),
        dataset: { t: 'suggestion' },
        text: sug ? sug.message
                  : unit.pool.length + ' left. This folder is uncapped, so there is no target — ' +
                    'run passes until you are happy with what is left.'
      }));
    }

    /* ---- configuration for the NEXT pass */
    if (unit.rerunOf) {
      wrap.appendChild(el('div', { class: 'notice notice-note', dataset: { t: 'rerun-note' },
        text: 'Re-running pass ' + unit.rerunOf + '. The quota below is one notch tighter — ' +
              'adjust it if you like, then start. It locks again when the pass begins.' }));
    }
    wrap.appendChild(configCard(unit, false));

    var canPass = unit.pool.length > 0;
    var startLabel = 'Start pass ' + (unit.passes.length + 1) +
      ' · ' + S.quotaLabel(s.settings) + ' · ' + s.settings.gridSize + ' per screen';

    var actions = el('div', { class: 'row' }, [
      el('button', {
        class: 'btn btn-primary', dataset: { t: 'start-pass' }, text: startLabel,
        disabled: !canPass, onclick: beginPass
      }),
      el('button', {
        class: 'btn', dataset: { t: 'cutpile' },
        text: 'Review cut pile (' + unit.cut.length + ')',
        disabled: unit.cut.length === 0,
        onclick: function () { goSafe('rescue', { unitId: G.unitId }); }
      }),
      el('button', {
        class: 'btn', dataset: { t: 'tobracket' }, text: 'Move on to the bracket',
        onclick: function () {
          editUnit(G.unitId, 'unit:toBracket', function (u) { u.phase = 'bracket'; });
          if (!goSafe('bracket', { unitId: G.unitId })) {
            editUnit(G.unitId, 'unit:toBracket:revert', function (u) { u.phase = 'gridA'; });
            render();
          }
        }
      })
    ]);
    wrap.appendChild(actions);

    if (!canPass) {
      wrap.appendChild(el('div', { class: 'notice notice-warn', dataset: { t: 'empty' },
        text: 'The pool is empty. Rescue something from the cut pile, or move on.' }));
    }
  }

  /* -------------------------------------------------------------- the pass */

  function beginPass() {
    var s = st().session;
    editUnit(G.unitId, 'grid:startPass', function (u) {
      u.currentPass = S.startPass(u, s.settings);
      u.currentPass.sel = [];
      // Starting a new pass forecloses re-running the previous one.
      u.lastPassSnapshot = null;
      u.lastSummary = null;
      u.rerunOf = null;
      u.phase = 'gridA';
    });
    render();
  }

  function renderPass(unit) {
    var root = G.root;
    dom.clear(root);
    releaseCells();

    var wrap = el('div', { class: 'pt-wrap' });
    root.appendChild(wrap);

    G.els = {};
    wrap.appendChild(configCard(unit, true));

    G.els.grid = el('div', { class: 'grid pt-grid', dataset: { t: 'grid' } });
    wrap.appendChild(G.els.grid);

    G.els.back = el('button', { class: 'btn', dataset: { t: 'back' }, text: 'Back', onclick: goBack });
    G.els.undo = el('button', { class: 'btn', dataset: { t: 'undo' }, text: 'Undo', onclick: undo });
    G.els.hint = el('span', { class: 'pt-hint', dataset: { t: 'hint' } });
    G.els.progress = el('span', { class: 'muted small nums', dataset: { t: 'progress' } });
    G.els.advance = el('button', {
      class: 'btn btn-primary', dataset: { t: 'advance' }, text: 'Continue', onclick: advance
    });

    wrap.appendChild(el('div', { class: 'row pt-actions' }, [
      G.els.back,
      G.els.undo,
      G.els.progress,
      G.els.hint,
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small' }, [
        el('kbd', { text: '1' }), '–', el('kbd', { text: '9' }), ' select · ',
        el('kbd', { text: '0' }), ' tenth · ',
        el('kbd', { text: 'Enter' }), ' advance · ',
        el('kbd', { text: 'U' }), ' undo · ',
        el('kbd', { text: '←' }), ' back'
      ]),
      G.els.advance
    ]));

    paintScreen();
  }

  /** Rebuild the cells for the current screen. Every previous URL is released. */
  function paintScreen() {
    var unit = getUnit(G.unitId);
    var pass = unit.currentPass;
    releaseCells();
    var host = G.els.grid;
    dom.clear(host);
    host.className = 'grid pt-grid grid-' + pass.gridSize;

    var ids = S.screenAt(pass, pass.index);
    G.screenIds = ids;
    G.cells = [];
    G.undoStack = [];
    ids.forEach(function (id, i) {
      var made = photoCell(id, i + 1, toggle);
      if (made.img) G.imgs.push(made.img);
      G.cells.push(made.cell);
      host.appendChild(made.cell);
    });
    paintState();
  }

  /** Cheap repaint: classes, counters, button state. No image churn. */
  function paintState() {
    var unit = getUnit(G.unitId);
    var pass = unit.currentPass;
    var sel = pass.sel || [];
    var quota = quotaFor(pass, G.screenIds.length);
    var over = sel.length - (quota === Infinity ? sel.length : quota);

    G.cells.forEach(function (c) {
      var on = sel.indexOf(c.dataset.id) >= 0;
      c.classList.toggle('kept', on);
    });

    var c = passCounters(unit, pass);
    var last = pass.index + 1 >= c.screensTotal;

    G.els.progress.textContent = 'screen ' + c.screenNo + ' of ' + c.screensTotal +
      ' · ' + sel.length + ' selected · ' + capLabel(quota);
    G.els.back.disabled = pass.index === 0;
    G.els.undo.disabled = G.undoStack.length === 0 && pass.index === 0;

    if (over > 0) {
      G.els.advance.disabled = true;
      G.els.advance.textContent = 'keep at most ' + quota;
      G.els.hint.textContent = 'keep at most ' + quota + ' — deselect ' + over;
    } else {
      G.els.advance.disabled = false;
      G.els.advance.textContent = last
        ? 'Finish pass ' + pass.n + ' · keep ' + sel.length
        : 'Keep ' + sel.length + ' · continue';
      G.els.hint.textContent = '';
    }

    setTopbar(unit.label + ' · pass ' + pass.n + ' · ' + S.quotaLabel(passSettings(pass)), [
      counter('remaining', c.remaining),
      counter('screens left', c.screensLeft),
      counter('field', c.field + (c.target == null ? ' (uncapped)' : ' / ' + c.target)),
      counter('cut this pass', PT.fmt.pct(c.cutPct))
    ]);
  }

  /**
   * PRD 7.1 is explicit that going over the quota must not silently reject the
   * click: the selection is allowed to exceed, and the advance button is what
   * refuses, with the reason on it.
   */
  function toggle(id) {
    editUnit(G.unitId, 'grid:toggle', function (u) {
      var p = u.currentPass;
      if (!p) return;
      p.sel = p.sel || [];
      var i = p.sel.indexOf(id);
      if (i >= 0) p.sel.splice(i, 1); else p.sel.push(id);
    });
    G.undoStack.push(id);
    paintState();
  }

  function undo() {
    if (G.undoStack.length) {
      var id = G.undoStack.pop();
      editUnit(G.unitId, 'grid:undo', function (u) {
        var p = u.currentPass;
        var i = p.sel.indexOf(id);
        if (i >= 0) p.sel.splice(i, 1); else p.sel.push(id);
      });
      paintState();
      return;
    }
    goBack();
  }

  /**
   * Back-navigation within the pass. The kept list is authoritative, so stepping
   * back means pulling this screen's ids out of it and back into the selection —
   * the user sees exactly what they had kept there.
   */
  function goBack() {
    var unit = getUnit(G.unitId);
    if (!unit.currentPass || unit.currentPass.index === 0) return;
    editUnit(G.unitId, 'grid:back', function (u) {
      var p = u.currentPass;
      p.index--;
      var ids = S.screenAt(p, p.index);
      var back = [];
      p.kept = p.kept.filter(function (id) {
        if (ids.indexOf(id) >= 0) { back.push(id); return false; }
        return true;
      });
      p.sel = back;
    });
    paintScreen();
  }

  function advance() {
    var unit = getUnit(G.unitId);
    var pass = unit.currentPass;
    var quota = quotaFor(pass, G.screenIds.length);
    if ((pass.sel || []).length > quota) return; // the button already says why
    var last = pass.index + 1 >= S.screensTotal(pass);

    if (!last) {
      editUnit(G.unitId, 'grid:advance', function (u) {
        var p = u.currentPass;
        p.kept = p.kept.concat(p.sel || []);
        p.sel = [];
        p.index++;
      });
      paintScreen();   // releases the previous screen's object URLs
      return;
    }

    editUnit(G.unitId, 'grid:finishPass', function (u) {
      var p = u.currentPass;
      p.kept = p.kept.concat(p.sel || []);
      p.sel = [];
      // Snapshot BEFORE folding the pass in, so the PRD 7.2 re-run can restore
      // the pool and the cut pile exactly as they were.
      u.lastPassSnapshot = { pool: u.pool.slice(), cut: u.cut.slice() };
      var summary = S.finishPass(u, p);
      u.lastSummary = summary;
      if (!S.lowCullRate(summary, st().session.settings)) u.lastPassSnapshot = null;
    });
    releaseCells();
    render();
  }

  /** PRD 7.2 re-run: restore the pre-pass state, then offer a tighter quota. */
  function rerunPass(tighter) {
    var unit = getUnit(G.unitId);
    if (!unit.lastPassSnapshot) return;
    var n = unit.lastSummary ? unit.lastSummary.n : unit.passes.length;
    PT.store.dispatch('grid:rerunPass', function (state) {
      var u = state.session.units[G.unitId];
      var snap = u.lastPassSnapshot;
      u.pool = snap.pool.slice();
      u.cut = snap.cut.slice();
      u.passes.pop();
      u.lastPassSnapshot = null;
      u.lastSummary = null;
      u.rerunOf = n;
      state.session.settings.quotaMode = tighter.quotaMode;
      if (tighter.quotaCustom != null) state.session.settings.quotaCustom = tighter.quotaCustom;
    });
    toast('Pass ' + n + ' rolled back. ' + getUnit(G.unitId).pool.length + ' photos back in the pool.');
    render();
  }

  /* ------------------------------------------------------------- keyboard */

  function onKey(e) {
    if (!G || !G.mode) return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    var unit = getUnit(G.unitId);
    if (!unit || !unit.currentPass) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      if (!G.els.advance.disabled) advance();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
    if (e.key === 'u' || e.key === 'U' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z')) {
      e.preventDefault(); undo(); return;
    }
    if (/^[0-9]$/.test(e.key)) {
      // 1..9 are positions 1..9; 0 is the tenth cell.
      var pos = e.key === '0' ? 10 : parseInt(e.key, 10);
      var id = G.screenIds[pos - 1];
      if (id) { e.preventDefault(); toggle(id); }
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  function render() {
    var unit = getUnit(G.unitId);
    if (!unit) {
      dom.clear(G.root);
      G.root.appendChild(el('div', { class: 'error-box', text: 'No tournament unit to work on.' }));
      return;
    }
    G.mode = unit.currentPass ? 'pass' : 'setup';
    if (unit.currentPass) {
      // PRD 7.10: a pass restored from storage may predate the `sel` field.
      if (!unit.currentPass.sel) {
        editUnit(G.unitId, 'grid:resumeInit', function (u) { u.currentPass.sel = []; });
      }
      renderPass(getUnit(G.unitId));
    } else {
      renderSetup(unit);
    }
  }

  PT.router.register('grid', {
    mount: function (root, params) {
      injectStyle();
      var s = st();
      if (!s || !s.session) {
        root.appendChild(el('div', { class: 'error-box', text: 'No session loaded.' }));
        return;
      }
      G = { root: root, unitId: unitId(params), imgs: [], cells: [], screenIds: [], undoStack: [], els: {}, mode: null };
      var u = getUnit(G.unitId);
      if (u && s.session.activeUnitId !== G.unitId) {
        PT.store.dispatch('session:activeUnit', function (state) { state.session.activeUnitId = G.unitId; });
      }
      G.keyHandler = onKey;
      document.addEventListener('keydown', G.keyHandler);
      render();
      if (u && u.currentPass) PT.log('grid', 'resumed mid-pass', { pass: u.currentPass.n, screen: u.currentPass.index + 1 });
    },
    unmount: function () {
      if (!G) return;
      document.removeEventListener('keydown', G.keyHandler);
      releaseCells();
      clearTopbar();
      G = null;
    }
  });

  /* ================================================================ RESCUE */

  var R = null;

  function rescueRelease() {
    if (!R) return;
    R.imgs.forEach(function (img) { dom.releaseImg(img); });
    R.imgs = [];
  }

  function renderRescue() {
    var unit = getUnit(R.unitId);
    var root = R.root;
    dom.clear(root);
    rescueRelease();
    if (R.observer) { R.observer.disconnect(); R.observer = null; }

    if (!unit) {
      root.appendChild(el('div', { class: 'error-box', text: 'No tournament unit to review.' }));
      return;
    }

    var wrap = el('div', { class: 'pt-wrap' });
    root.appendChild(wrap);

    if (!unit.cut.length) {
      wrap.appendChild(el('h1', { text: 'Cut pile — ' + unit.label }));
      wrap.appendChild(el('div', { class: 'notice notice-note', dataset: { t: 'empty' },
        text: 'Nothing has been cut yet, so there is nothing to rescue.' }));
      wrap.appendChild(el('div', { class: 'row' }, [
        el('button', { class: 'btn', dataset: { t: 'rescue-back' }, text: 'Back to Stage A',
          onclick: function () { goSafe('grid', { unitId: R.unitId }); } })
      ]));
      return;
    }

    if (!unit.rescueLimit) renderRescueLimit(wrap, unit);
    else renderRescueReview(wrap, unit);
  }

  /**
   * PRD 7.5: the limit is pre-committed, before the user has seen a single photo
   * they might want back. Once locked it is never raised — that is the whole
   * mechanism, since an adjustable rescue cap voids every quota upstream.
   */
  function renderRescueLimit(wrap, unit) {
    var n = unit.cut.length;
    setTopbar(unit.label + ' · cut pile', [counter('cut', n)]);

    wrap.appendChild(el('h1', { text: 'Cut pile — ' + n + ' photos' }));
    wrap.appendChild(el('p', { class: 'muted', text:
      'Set your rescue limit before you look. It locks for the whole review: a nine-way ' +
      'screen can drop a strong photo that landed among stronger ones, but an adjustable ' +
      'rescue cap would void every quota you have held yourself to so far.' }));

    var mode = el('select', { dataset: { t: 'rescue-mode' } }, [
      el('option', { value: 'fixed', text: 'A fixed number' }),
      el('option', { value: 'pct', text: 'A percentage of the cut pile' }),
      el('option', { value: 'unlimited', text: 'Unlimited' })
    ]);
    var value = el('input', { type: 'number', min: '0', max: '999', value: '5', dataset: { t: 'rescue-value' } });
    var preview = el('span', { class: 'muted small', dataset: { t: 'rescue-preview' } });

    function refresh() {
      value.disabled = mode.value === 'unlimited';
      var lim = { mode: mode.value, value: Number(value.value) };
      var max = rescueMax(lim, n);
      preview.textContent = max === Infinity
        ? 'no limit — every cut photo may come back'
        : 'allows ' + max + ' of ' + n + ' back into the pool';
    }
    mode.addEventListener('change', refresh);
    value.addEventListener('input', refresh);

    var card = el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        el('label', { class: 'f' }, ['Rescue limit ', mode]),
        value,
        preview
      ]),
      el('div', { class: 'row', style: 'margin-top:12px' }, [
        el('button', {
          class: 'btn btn-primary', dataset: { t: 'rescue-lock' }, text: 'Lock the limit and review',
          onclick: function () {
            var lim = { mode: mode.value, value: Number(value.value), committedAt: Date.now() };
            editUnit(R.unitId, 'rescue:lockLimit', function (u) {
              u.rescueLimit = lim;
              u.rescueSel = u.rescueSel || [];
            });
            renderRescue();
          }
        }),
        el('button', { class: 'btn btn-quiet', dataset: { t: 'rescue-skip' }, text: 'Skip the cut pile',
          onclick: function () { goSafe('grid', { unitId: R.unitId }); } })
      ])
    ]);
    refresh();
    wrap.appendChild(card);
  }

  function renderRescueReview(wrap, unit) {
    var n = unit.cut.length;
    var max = rescueMax(unit.rescueLimit, n);

    wrap.appendChild(el('div', { class: 'pt-title' }, [
      el('h1', { text: 'Cut pile — ' + n + ' photos' }),
      el('span', { class: 'pt-lock', dataset: { t: 'rescue-locked' },
        text: 'Rescue limit locked: ' + rescueLimitLabel(unit.rescueLimit, n) })
    ]));
    wrap.appendChild(el('p', { class: 'muted small', text:
      'Click anything worth another look. Rescued photos go back into the pool and ' +
      'into the bracket. The limit was set before you looked and cannot be raised now.' }));

    var pile = el('div', { class: 'grid pt-pile grid-' + (st().session.settings.gridSize || 9), dataset: { t: 'pile' } });
    wrap.appendChild(pile);
    R.els = {};
    R.cells = [];

    // Only what is near the viewport holds an object URL. The cut pile can be
    // several hundred photos in one scroller; attaching them all would undo the
    // bounded-memory guarantee the grid pass works so hard to keep.
    R.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var img = en.target;
        if (en.isIntersecting) {
          if (!img._ptUrl) {
            var b = thumbOf(img.dataset.id);
            if (b) { dom.setImg(img, b); if (R.imgs.indexOf(img) < 0) R.imgs.push(img); }
          }
        } else if (img._ptUrl) {
          dom.releaseImg(img);
          img.removeAttribute('src');
        }
      });
    }, { root: pile, rootMargin: '300px 0px' });

    unit.cut.forEach(function (id, i) {
      var img = el('img', { class: 'thumb', alt: '', dataset: { id: id } });
      var cell = el('div', {
        class: 'photo-cell', dataset: { id: id, t: 'pile-cell' }, title: photoName(id),
        onclick: function () { toggleRescue(id); }
      }, [
        img,
        el('span', { class: 'idx', text: String(i + 1) }),
        el('span', { class: 'pt-cell-name', text: photoName(id) })
      ]);
      R.cells.push(cell);
      pile.appendChild(cell);
      R.observer.observe(img);
    });

    R.els.hint = el('span', { class: 'pt-hint', dataset: { t: 'rescue-hint' } });
    R.els.count = el('span', { class: 'muted small nums', dataset: { t: 'rescue-count' } });
    R.els.done = el('button', { class: 'btn btn-primary', dataset: { t: 'rescue-done' },
      text: 'Done', onclick: commitRescue });

    wrap.appendChild(el('div', { class: 'row pt-actions' }, [
      el('button', { class: 'btn', dataset: { t: 'rescue-clear' }, text: 'Clear selection',
        onclick: function () {
          editUnit(R.unitId, 'rescue:clear', function (u) { u.rescueSel = []; });
          paintRescue();
        } }),
      R.els.count,
      R.els.hint,
      el('span', { class: 'spacer' }),
      R.els.done
    ]));

    R.max = max;
    paintRescue();
  }

  function toggleRescue(id) {
    editUnit(R.unitId, 'rescue:toggle', function (u) {
      u.rescueSel = u.rescueSel || [];
      var i = u.rescueSel.indexOf(id);
      if (i >= 0) u.rescueSel.splice(i, 1); else u.rescueSel.push(id);
    });
    paintRescue();
  }

  function paintRescue() {
    var unit = getUnit(R.unitId);
    var sel = unit.rescueSel || [];
    var max = R.max;
    R.cells.forEach(function (c) { c.classList.toggle('kept', sel.indexOf(c.dataset.id) >= 0); });

    var over = max === Infinity ? 0 : sel.length - max;
    R.els.count.textContent = 'rescuing ' + sel.length + ' of ' +
      (max === Infinity ? unit.cut.length + ' (no limit)' : max + ' allowed');
    if (over > 0) {
      R.els.done.disabled = true;
      R.els.done.textContent = 'rescue at most ' + max;
      R.els.hint.textContent = 'rescue at most ' + max + ' — deselect ' + over;
    } else {
      R.els.done.disabled = false;
      R.els.done.textContent = sel.length
        ? 'Return ' + sel.length + ' to the pool'
        : 'Rescue nothing and continue';
      R.els.hint.textContent = '';
    }

    setTopbar(unit.label + ' · cut pile', [
      counter('cut', unit.cut.length),
      counter('rescuing', sel.length),
      counter('limit', max === Infinity ? '∞' : max)
    ]);
  }

  function commitRescue() {
    var unit = getUnit(R.unitId);
    var sel = (unit.rescueSel || []).slice();
    var max = R.max;
    if (max !== Infinity && sel.length > max) return;
    editUnit(R.unitId, 'rescue:commit', function (u) {
      var keep = {};
      sel.forEach(function (id) { keep[id] = 1; });
      u.cut = u.cut.filter(function (id) { return !keep[id]; });
      u.pool = u.pool.concat(sel);
      u.rescued = (u.rescued || []).concat(sel);
      u.rescueSel = [];
      u.rescueDone = true;
    });
    if (sel.length) toast(sel.length + ' photo' + (sel.length === 1 ? '' : 's') + ' back in the pool.');
    goSafe('grid', { unitId: R.unitId });
  }

  PT.router.register('rescue', {
    mount: function (root, params) {
      injectStyle();
      var s = st();
      if (!s || !s.session) {
        root.appendChild(el('div', { class: 'error-box', text: 'No session loaded.' }));
        return;
      }
      R = { root: root, unitId: unitId(params), imgs: [], cells: [], els: {}, observer: null, max: 0 };
      renderRescue();
    },
    unmount: function () {
      if (!R) return;
      if (R.observer) { R.observer.disconnect(); R.observer = null; }
      rescueRelease();
      clearTopbar();
      R = null;
    }
  });

  /* ------------------------------------------------------------------- api */

  // Exposed for tests and for any screen that needs the same arithmetic.
  PT.gridScreen = {
    passCounters: passCounters,
    tightenQuota: tightenQuota,
    rescueMax: rescueMax,
    rescueLimitLabel: rescueLimitLabel,
    quotaFor: quotaFor,
    capLabel: capLabel
  };

  if (typeof PT.log === 'function') PT.log('grid', 'screens registered: grid, rescue');
})();

/** CHANGELOG
 * v1.0 (2026-07-28): Initial release. Stage A grid pass with locked per-pass
 *   configuration, click and number-key selection, quota-disabled advance carrying
 *   its own reason, undo, in-pass back-navigation that restores the previous
 *   screen's keeps, PRD 7.1 counters in the topbar, mid-pass resume from the
 *   persisted currentPass, the PRD 7.2 low cull rate offer with a true pool and
 *   cut-pile rollback, and the PRD 7.5 cut pile rescue screen with a pre-committed
 *   locked limit and viewport-bounded thumbnail attachment.
 */
