/**
 * @file 50_screen_tree.js
 * @version 1.1
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description PRD 4 allocation tree UI: four states per node, both math directions, live totals, weighted distribution, and the section 4.5 conflict, clamp and dead-state messages.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * All the arithmetic lives in 30_tree.js, which is pure and unit-tested. This
 * file is only the surface over it: render, capture input, re-resolve, re-render.
 * Every keystroke re-resolves the whole tree, which at a few hundred nodes is far
 * cheaper than maintaining incremental state and getting it subtly wrong.
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});
  var el = PT.dom.el;

  var STYLE_ID = 'pt-tree-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.tree-row{display:flex;align-items:center;gap:10px;padding:5px 8px;border-radius:6px}' +
      '.tree-head{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-mute);' +
        'border-bottom:1px solid var(--line);margin-bottom:4px;padding-bottom:6px}' +
      '.tree-head:hover{background:none}' +
      '.tree-head .tree-alloc{border:none;background:none;text-align:center}' +
      '.tree-row:hover{background:var(--surface-2)}' +
      '.tree-row.excluded .tree-name{text-decoration:line-through;opacity:.45}' +
      '.tree-row.has-error{box-shadow:inset 0 0 0 1px #5c2f2b}' +
      '.tree-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.tree-count{color:var(--text-mute);font-size:12px;font-variant-numeric:tabular-nums;min-width:62px;text-align:right}' +
      '.tree-alloc{width:62px;text-align:center;font-variant-numeric:tabular-nums}' +
      '.tree-state{font-size:11px;min-width:74px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.4px}' +
      '.tree-inf{padding:2px 7px;font-size:13px;line-height:1.3}' +
      '.tree-inf.on{background:var(--accent);border-color:var(--accent);color:#0b0b0c}' +
      '.tree-issues{display:flex;flex-direction:column;gap:6px;margin-top:10px}' +
      '.totals{display:flex;gap:18px;align-items:baseline;font-variant-numeric:tabular-nums}' +
      '.totals b{font-size:22px}';
    document.head.appendChild(el('style', { id: STYLE_ID, text: css }));
  }

  PT.router.register('tree', {
    mount: function (root) {
      injectStyle();
      var st = PT.store.get();
      PT.dom.$('#topbar').hidden = false;
      PT.dom.$('#topbar-context').textContent = st.session.rootName;

      if (!st.tree) {
        root.appendChild(el('div', { class: 'error-box', text: 'No photos loaded yet.' }));
        return;
      }

      root.appendChild(el('div', { class: 'row' }, [
        el('h1', { text: 'How many photos do you want to KEEP from each folder?' })
      ]));

      root.appendChild(el('div', { class: 'muted small', html:
        'The number is how many photos <b>survive</b> — the keepers, not the ones thrown away. ' +
        'Type <b>5</b> and you end up with 5 photos from that folder.<br>' +
        'Use <b>0</b> to skip a folder entirely, <b>*</b> (or the ∞ button) to cull with no fixed ' +
        'target, or leave it blank to let a folder compete with its blank siblings for whatever ' +
        'its parent has left over.' }));

      var treeHost = el('div', { class: 'card', id: 'tree-host' });
      var issuesHost = el('div', { class: 'tree-issues', id: 'tree-issues' });
      var footer = el('div', { class: 'card row', id: 'tree-footer' });

      root.appendChild(treeHost);
      root.appendChild(issuesHost);
      root.appendChild(footer);

      render();

      function render() {
        var s = PT.store.get();
        var res = PT.tree.resolve(s.tree, s.session.allocs);
        s.resolution = res;

        // Re-rendering destroys and recreates every input, which silently steals
        // focus and the caret from whichever field is being typed into. The
        // symptom is that only the first digit of a two-digit number ever lands.
        // Remember where the cursor was and put it back afterwards.
        var active = document.activeElement;
        var focusPath = active && active.classList && active.classList.contains('tree-alloc')
          ? active.dataset.path : null;
        var caret = focusPath ? active.selectionStart : null;

        PT.dom.clear(treeHost);
        treeHost.appendChild(headerRow());
        s.tree.order.forEach(function (path) {
          var node = res.nodes[path];
          if (!node) return;
          // A root wrapper with a single child adds a level of indent and no
          // information; skip it unless it holds photos of its own.
          if (path === '' && s.tree.nodes[''].childPaths.length === 1 && !node.ownCount) return;
          treeHost.appendChild(rowFor(s, res, path, node));
        });

        renderIssues(res);
        renderFooter(res);

        if (focusPath !== null) {
          var again = treeHost.querySelector('.tree-alloc[data-path="' + cssEscape(focusPath) + '"]');
          if (again) {
            again.focus();
            try { again.setSelectionRange(caret, caret); } catch (e) { /* not a text input */ }
          }
        }
      }

      function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1'); }

      function headerRow() {
        return el('div', { class: 'tree-row tree-head' }, [
          el('span', { class: 'tree-name', text: 'Folder' }),
          el('span', { class: 'tree-count', text: 'has' }),
          el('span', { class: 'tree-state', text: '' }),
          el('span', { class: 'tree-alloc', text: 'keep' }),
          el('span', { style: 'width:30px' })
        ]);
      }

      function rowFor(s, res, path, node) {
        var depth = path === '' ? 0 : path.split('/').length;
        var hasError = res.issues.some(function (i) { return i.path === path && i.level === 'error'; });

        var input = el('input', {
          type: 'text',
          inputmode: 'numeric',
          maxlength: '4',
          class: 'tree-alloc' + (hasError ? ' invalid' : ''),
          value: PT.tree.allocToInput(node.alloc),
          placeholder: '—',
          dataset: { path: path },
          title: 'How many photos from this folder you want to KEEP. ' +
                 '0 skips the folder, * means no limit, blank shares the parent\u2019s leftovers.'
        });

        input.addEventListener('input', function () {
          var parsed = PT.tree.parseAlloc(input.value);
          if (!parsed) { input.classList.add('invalid'); return; }
          input.classList.remove('invalid');
          setAlloc(path, parsed);
        });

        var infOn = node.alloc.mode === 'uncapped';
        var inf = el('button', {
          class: 'btn btn-sm tree-inf' + (infOn ? ' on' : ''),
          text: '∞',
          title: 'Cull until satisfied, with no target',
          onclick: function () {
            setAlloc(path, infOn ? { mode: 'pooled', value: null } : { mode: 'uncapped', value: null });
          }
        });

        var stateWord = node.excluded ? 'skipped'
          : node.alloc.mode === 'uncapped' ? 'uncapped'
          : node.alloc.mode === 'fixed' ? (node.clamped ? 'clamped ' + node.target : 'fixed')
          : node.unitId ? 'pooled' : 'pooled';

        var row = el('div', {
          class: 'tree-row' + (node.excluded ? ' excluded' : '') + (hasError ? ' has-error' : '')
        }, [
          el('span', { class: 'tree-name', style: 'padding-left:' + depth * 16 + 'px',
                       text: (path === '' ? s.session.rootName : node.name) }),
          el('span', { class: 'tree-count', text: node.subtreeCount + ' photo' + (node.subtreeCount === 1 ? '' : 's') }),
          el('span', { class: 'tree-state', text: stateWord }),
          input,
          inf
        ]);

        // Offer top-down distribution only where it is meaningful (PRD 4.4).
        if (node.alloc.mode === 'fixed' && s.tree.nodes[path].childPaths.length) {
          row.appendChild(el('button', {
            class: 'btn btn-sm btn-quiet', text: 'split',
            title: 'Suggest a split of ' + node.alloc.value + ' across the subfolders',
            onclick: function () { offerSplit(path, node.alloc.value); }
          }));
        }
        return row;
      }

      function setAlloc(path, parsed) {
        PT.store.dispatch('tree:alloc', function (s) { s.session.allocs[path] = parsed; });
        render();
      }

      function offerSplit(path, total) {
        var s = PT.store.get();
        var mode = s.session.settings.distribution;
        var sug = PT.tree.distribute(s.tree, s.resolution, path, total, mode);
        var names = Object.keys(sug);
        if (!names.length) return;

        var body = PT.dom.$('#modal-body');
        PT.dom.clear(body);
        body.appendChild(el('h2', { text: 'Split ' + total + ' across ' + names.length + ' subfolders' }));

        var listHost = el('div', { style: 'margin:12px 0' });
        var draw = function (m) {
          var d = PT.tree.distribute(s.tree, s.resolution, path, total, m);
          PT.dom.clear(listHost);
          Object.keys(d).forEach(function (c) {
            listHost.appendChild(el('div', { class: 'row small' }, [
              el('span', { class: 'tree-name', text: s.tree.nodes[c].name }),
              el('span', { class: 'muted nums', text: s.resolution.nodes[c].subtreeCount + ' photos' }),
              el('b', { class: 'nums', text: String(d[c]) })
            ]));
          });
          return d;
        };
        var current = draw(mode);

        body.appendChild(listHost);
        body.appendChild(el('div', { class: 'row' }, [
          el('button', { class: 'btn btn-sm', text: 'Weighted by photo count',
            onclick: function () { current = draw('weighted'); } }),
          el('button', { class: 'btn btn-sm', text: 'Even split',
            onclick: function () { current = draw('even'); } }),
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn btn-quiet', text: 'Cancel',
            onclick: function () { PT.dom.$('#modal').close(); } }),
          el('button', { class: 'btn btn-primary', text: 'Apply', onclick: function () {
            PT.store.dispatch('tree:distribute', function (ss) {
              Object.keys(current).forEach(function (c) {
                ss.session.allocs[c] = { mode: 'fixed', value: current[c] };
              });
            });
            PT.dom.$('#modal').close();
            render();
          } })
        ]));
        body.appendChild(el('p', { class: 'small dim', style: 'margin-top:10px',
          text: 'These are suggestions. Every one is editable afterwards.' }));
        PT.dom.$('#modal').showModal();
      }

      function renderIssues(res) {
        PT.dom.clear(issuesHost);
        var rank = { error: 0, warn: 1, note: 2 };
        res.issues.slice().sort(function (a, b) { return rank[a.level] - rank[b.level]; })
          .forEach(function (i) {
            var s = PT.store.get();
            var where = i.path === '' ? s.session.rootName : (s.tree.nodes[i.path] || {}).name || i.path;
            issuesHost.appendChild(el('div', { class: 'notice notice-' + i.level }, [
              el('b', { text: where + ': ' }),
              el('span', { text: i.message })
            ]));
          });
      }

      function renderFooter(res) {
        PT.dom.clear(footer);
        var s = PT.store.get();

        footer.appendChild(el('div', { class: 'totals' }, [
          el('span', { class: 'muted small', text: 'Photos you will keep' }),
          el('b', { text: res.projectedTotal === null ? '—' : String(res.projectedTotal) }),
          el('span', { class: 'muted small', text:
            res.projectedTotal === null
              ? 'no target: uncapped folders finish when you say so'
              : 'from ' + res.units.length + ' tournament' + (res.units.length === 1 ? '' : 's') })
        ]));

        footer.appendChild(el('span', { class: 'spacer' }));

        footer.appendChild(el('label', { class: 'check small' }, [
          (function () {
            var cb = el('input', { type: 'checkbox' });
            cb.checked = s.session.settings.stageD;
            cb.addEventListener('change', function () {
              PT.store.dispatch('settings:stageD', function (ss) { ss.session.settings.stageD = cb.checked; });
            });
            return cb;
          })(),
          el('span', { text: 'Also run a best-of-the-best round across all winners' })
        ]));

        var go = el('button', {
          class: 'btn btn-primary',
          text: 'Start culling →',
          onclick: function () { startUnits(res); }
        });
        if (res.hasErrors || !res.units.length) {
          go.disabled = true;
          go.title = res.hasErrors
            ? 'Resolve the problems above first'
            : 'Give at least one folder a finalist count';
        }
        footer.appendChild(go);
      }

      function startUnits(res) {
        PT.store.dispatch('units:create', function (s) {
          res.units.forEach(function (u) {
            if (!s.session.units[u.id]) s.session.units[u.id] = PT.session.newUnit(u);
          });
          s.session.stage = 'unit';
          var pending = PT.session.pendingUnits(s.session);
          s.session.activeUnitId = pending.length ? pending[0].id : null;
        });
        var id = PT.store.get().session.activeUnitId;
        if (id) PT.router.go('grid', { unitId: id });
      }
    },

    unmount: function () {
      PT.dom.$('#topbar-counters').textContent = '';
    }
  });
})();

/** CHANGELOG
 * v1.0 (2026-07-28): Initial release. Per-node allocation input with both the
 *   typed * and the toggle entry paths, live re-resolution on every keystroke,
 *   ranked issue list, weighted and even distribution with an editable preview,
 *   projected total, Stage D opt-in, and unit creation.
  * v1.1 (2026-07-28): Fixed two-digit entry. Re-rendering on every keystroke
 *   recreated the input and stole focus, so only the first digit of a number ever
 *   landed; focus and caret are now restored after render. Reworded throughout to
 *   say the number is how many photos you KEEP, and added a column header.
*/
