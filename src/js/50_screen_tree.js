/**
 * @file 50_screen_tree.js
 * @version 1.6
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



  PT.router.register('tree', {
    mount: function (root) {
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

      root.classList.add('screen-tree');

      root.appendChild(el('div', { class: 'tree-help', html:
        'The number is how many photos <b>survive</b> — the keepers, not the ones thrown away. ' +
        'Type <b>5</b> and you end up with 5 photos from that folder.' }));

      var help = el('details', { class: 'tree-help' }, [
        el('summary', { text: 'Blank, zero and no-limit' }),
        el('div', { html:
          'Use <b>0</b> to skip a folder entirely, <b>*</b> (or the ∞ button) to cull with no fixed ' +
          'target, or leave it blank to let a folder compete with its blank siblings for whatever ' +
          'its parent has left over.' })
      ]);
      root.appendChild(help);

      // The broadcast: one value, every folder that holds photos. "The same 5
      // from each day" and "10% of everything, folder by folder" are one
      // gesture here instead of a row-by-row retype. It REPLACES the whole
      // allocation — photo-holding folders get the value, containers go back
      // to blank pass-through — because a broadcast layered over leftover
      // per-row settings would breed the oversubscription errors the resolver
      // exists to catch.
      var allInput = el('input', {
        type: 'text', inputmode: 'numeric', maxlength: '6',
        class: 'tree-alloc', id: 'tree-all-input', placeholder: '5 or 10%',
        title: 'A count (5) keeps that many from every folder; a share (10%) keeps that share of ' +
               'each folder\u2019s own photos. Blank resets every folder to competing.'
      });
      var applyAll = function () {
        var parsed = PT.tree.parseAlloc(allInput.value);
        if (!parsed) { allInput.classList.add('invalid'); return; }
        allInput.classList.remove('invalid');
        PT.store.dispatch('tree:applyAll', function (ss) {
          ss.session.allocs = {};
          if (parsed.mode === 'pooled') return;   // blank = clean slate
          Object.keys(ss.tree.nodes).forEach(function (path) {
            if (ss.tree.nodes[path].photoIds.length > 0) {
              ss.session.allocs[path] = { mode: parsed.mode, value: parsed.value };
            }
          });
        });
        render();
      };
      allInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); applyAll(); }
      });
      root.appendChild(el('div', { class: 'card row tree-all', id: 'tree-all' }, [
        el('span', { class: 'small', text: 'Every folder:' }),
        allInput,
        el('button', { class: 'btn btn-sm', id: 'tree-all-apply', text: 'Apply to all', onclick: applyAll }),
        el('span', { class: 'small dim', text:
          'replaces the settings below \u2014 a count from each folder, or a share of each' })
      ]));

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
        // Must mirror rowFor()'s child order exactly or the columns drift.
        return el('div', { class: 'tree-row tree-head' }, [
          el('span', { class: 'tree-name', text: 'Folder' }),
          el('span', { class: 'tree-count', text: 'has' }),
          el('span', { class: 'tree-alloc', text: 'keep' }),
          el('span', {}), el('span', {}), el('span', {}), el('span', {})
        ]);
      }

      function rowFor(s, res, path, node) {
        var depth = path === '' ? 0 : path.split('/').length;
        var hasError = res.issues.some(function (i) { return i.path === path && i.level === 'error'; });

        var input = el('input', {
          type: 'text',
          inputmode: 'numeric',
          // Long enough for "12.5%". A bare count never needs more than four.
          maxlength: '6',
          class: 'tree-alloc' + (hasError ? ' invalid' : ''),
          value: PT.tree.allocToInput(node.alloc),
          placeholder: '—',
          dataset: { path: path },
          title: 'How many photos from this folder you want to KEEP. ' +
                 'A count (12), or a share of what this folder holds (5%). ' +
                 '0 skips the folder, * means no limit, blank shares the parent\u2019s leftovers.'
        });

        input.addEventListener('input', function () {
          var parsed = PT.tree.parseAlloc(input.value);
          if (!parsed) { input.classList.add('invalid'); return; }
          input.classList.remove('invalid');
          setAlloc(path, parsed);
        });

        // Both buttons change what the NUMBER MEANS rather than what it is, so
        // they share one column instead of sitting apart.
        var pctOn = node.alloc.mode === 'percent';
        var pct = el('button', {
          class: 'btn btn-sm tree-unit' + (pctOn ? ' on' : ''),
          text: '%',
          title: pctOn
            ? 'Back to a fixed count (' + node.percentCount + ')'
            : 'Keep a share of what this folder holds, rather than a fixed count',
          onclick: function () {
            // Flipping the unit keeps the meaning: whatever the row resolves to
            // now is re-expressed the other way round, so the number on screen
            // does not jump when you switch.
            if (pctOn) {
              setAlloc(path, node.percentCount > 0
                ? { mode: 'fixed', value: node.percentCount }
                : { mode: 'pooled', value: null });
              return;
            }
            // The flip must re-express the SAME count. The shortest decimal
            // that resolves back to it is found by widening precision until
            // percentToCount round-trips — one decimal covers ordinary
            // folders (2 of 300 -> 0.7%), and "keep 1 of 30,000" gets the
            // extra places it needs instead of silently becoming 30.
            var share = 10;
            if (node.eff.mode === 'fixed' && node.subtreeCount > 0) {
              var exact = (node.eff.value * 100) / node.subtreeCount;
              for (var d = 0; d <= 6; d++) {
                var pow = Math.pow(10, d);
                var cand = Math.round(exact * pow) / pow;
                if (cand > 0 && cand <= 100 &&
                    PT.tree.percentToCount(cand, node.subtreeCount) === node.eff.value) {
                  share = cand;
                  break;
                }
                if (d === 6) share = Math.min(100, Math.max(exact, 1e-6));
              }
            }
            setAlloc(path, { mode: 'percent', value: share });
          }
        });

        var infOn = node.alloc.mode === 'uncapped';
        var inf = el('button', {
          class: 'btn btn-sm tree-unit tree-inf' + (infOn ? ' on' : ''),
          text: '∞',
          title: 'Cull until satisfied, with no target',
          onclick: function () {
            setAlloc(path, infOn ? { mode: 'pooled', value: null } : { mode: 'uncapped', value: null });
          }
        });

        var units = el('span', { class: 'tree-units' }, [pct, inf]);

        // A percentage is a promise about a number the user cannot see, so the
        // state column spends itself saying what it came to.
        var stateWord = node.excluded ? 'skipped'
          : node.alloc.mode === 'uncapped' ? 'uncapped'
          : node.alloc.mode === 'percent'
            ? (node.clamped ? 'clamped ' + node.target : '= ' + node.percentCount)
          : node.eff.mode === 'fixed' ? (node.clamped ? 'clamped ' + node.target : 'fixed')
          : node.unitId ? 'pooled' : 'pooled';

        // How brutal this cut is, as a fraction. Uncapped reads as full.
        var p = node.uncapped ? 1
          : (node.target != null && node.subtreeCount) ? node.target / node.subtreeCount
          : 0;
        var bar = el('span', { class: 'tree-bar', style: '--p:' + Math.max(0, Math.min(1, p)) },
                     [el('i')]);

        // A <label> so clicking anywhere on the row — the folder name especially —
        // lands in that row's keep field. Depth moves to a custom property so CSS
        // owns both the indent and the hierarchy rails.
        var row = el('label', {
          class: 'tree-row' + (node.excluded ? ' excluded' : '') + (hasError ? ' has-error' : ''),
          style: '--d:' + depth
        }, [
          el('span', { class: 'tree-name',
                       text: (path === '' ? s.session.rootName : node.name) }),
          el('span', { class: 'tree-count', text: node.subtreeCount + ' photo' + (node.subtreeCount === 1 ? '' : 's') }),
          input,
          units,
          bar,
          el('span', { class: 'tree-state', text: stateWord })
        ]);

        // Offer top-down distribution only where it is meaningful (PRD 4.4).
        if (node.eff.mode === 'fixed' && node.eff.value > 0 && s.tree.nodes[path].childPaths.length) {
          row.appendChild(el('button', {
            class: 'btn btn-sm btn-quiet', text: 'split',
            title: 'Suggest a split of ' + node.eff.value + ' across the subfolders',
            onclick: function () { offerSplit(path, node.eff.value); }
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

        // PRD 7.6. The target sits beside the toggle rather than in a settings
        // page: enabling the round and saying how big it should be is one
        // decision, and splitting them leaves a number nobody ever finds.
        var stageDTarget = el('input', {
          type: 'text', inputmode: 'numeric', maxlength: '4',
          class: 'tree-alloc',
          value: String(s.session.settings.stageDTarget),
          title: 'How many photos the best-of-the-best round should end up with'
        });
        stageDTarget.addEventListener('input', function () {
          if (!/^\d+$/.test(stageDTarget.value.trim())) return;
          var v = parseInt(stageDTarget.value, 10);
          if (!(v >= 1)) { stageDTarget.classList.add('invalid'); return; }
          stageDTarget.classList.remove('invalid');
          PT.store.dispatch('settings:stageDTarget', function (ss) {
            ss.session.settings.stageDTarget = v;
          });
        });
        stageDTarget.hidden = !s.session.settings.stageD;

        footer.appendChild(el('label', { class: 'check small' }, [
          (function () {
            var cb = el('input', { type: 'checkbox' });
            cb.checked = s.session.settings.stageD;
            cb.addEventListener('change', function () {
              PT.store.dispatch('settings:stageD', function (ss) { ss.session.settings.stageD = cb.checked; });
              stageDTarget.hidden = !cb.checked;
            });
            return cb;
          })(),
          el('span', { text: 'Also run a best-of-the-best round across all winners' })
        ]));
        footer.appendChild(stageDTarget);

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
        if (!id) return;
        // PRD 7.7: review the near-duplicate grouping before the first grid
        // pass, but only when there is something to review. PT.dupes.route owns
        // that decision and falls through to the grid when there is not.
        if (PT.dupes && PT.dupes.route) PT.dupes.route(id);
        else PT.router.go('grid', { unitId: id });
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
 * v1.2 (2026-07-28): Adopted photournament_ui_v2.0.css. Removed the injected
 *   style block. The row is now a <label> ordered name / count / keep / infinity /
 *   proportion bar / state, so it reads as the sentence the screen asks — "Trip
 *   has 36, keep 8" — instead of stranding the field at the far right. Depth moved
 *   to a --d custom property so CSS owns the indent and hierarchy rails, and the
 *   second paragraph of help became a disclosure.
 * v1.3 (2026-07-28): Routes into the PRD 7.7 duplicate review after the units
 *   are created, when there is anything to review.
 * v1.4 (2026-07-28): Exposed stageDTarget beside its own toggle. It was the one
 *   PRD 12 setting with no UI at all — the round could be enabled but not sized.
 * v1.5 (2026-07-28): Percentage quotas. The keep field accepts "10%", the new %
 *   toggle flips a row between count and share re-expressing the same resolved
 *   number, and the state column shows what a percentage came to ("= 37").
 *   Split and the state word now read the derived eff alloc.
 * v1.6 (2026-07-29): The broadcast row. One value applied to every folder that
 *   holds photos — a count or a share — replacing the whole allocation so no
 *   stale per-row setting can oversubscribe against it; blank resets to pooled.
*/
