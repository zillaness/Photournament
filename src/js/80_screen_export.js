/**
 * @file 80_screen_export.js
 * @version 1.0
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description PRD 7.8 export review and output: per-finalist intent labels, ordered prefixes, per-source folder naming, mirrored or flat structure, disk writing with collision handling, download bundles, and the decision JSON.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * Nothing is written until the user has seen exactly what will be written. The
 * review screen lists every finalist with its rank, source folder and final
 * destination filename, and the label field feeds directly into that filename so
 * the reasoning survives the export (PRD success criterion 8).
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});
  var el = PT.dom.el;
  var STYLE_ID = 'pt-export-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    document.head.appendChild(el('style', { id: STYLE_ID, text:
      '.exp-row{display:grid;grid-template-columns:34px 76px 1fr 1.4fr;gap:10px;align-items:center;' +
        'padding:6px;border-radius:6px}' +
      '.exp-row:hover{background:var(--surface-2)}' +
      '.exp-rank{font-variant-numeric:tabular-nums;color:var(--text-mute);text-align:right}' +
      '.exp-thumb{width:76px;height:52px;object-fit:contain;background:#000;border-radius:4px}' +
      '.exp-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.exp-dest{font-family:var(--mono);font-size:11px;color:var(--text-dim);' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.exp-set{margin-bottom:18px}'
    }));
  }

  /** PRD 7.8: labels are optional, and become part of the filename. */
  function slugLabel(s) {
    return String(s || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48);
  }

  /**
   * Destination filename. The original name is always the final component so
   * provenance survives renaming (PRD 7.8), and the ordered prefix keeps
   * sequence through alphabetical sorting in slideshow tools.
   */
  function destName(photo, rank, total, settings, label) {
    var parts = [];
    if (settings.prefixes) parts.push(PT.fmt.ordinal(rank, total));
    var lab = slugLabel(label);
    if (lab) parts.push(lab);
    parts.push(photo.name);
    return parts.join('_');
  }

  /** Each result set writes to its own folder named for its source (PRD 7.8). */
  function folderFor(unit) {
    if (unit.id === 'stageD') return '_finalists_overall';
    if (unit.kind === 'pooled') return '_finalists_pooled';
    var leaf = String(unit.label || 'unit').split('/').pop();
    return '_finalists_' + leaf.replace(/[^A-Za-z0-9._-]+/g, '_');
  }

  function resultSets(session) {
    return Object.keys(session.units)
      .map(function (k) { return session.units[k]; })
      .filter(function (u) { return u.winners && u.winners.length; })
      .map(function (u) { return { unit: u, folder: folderFor(u), ids: u.winners.slice() }; });
  }

  PT.router.register('export', {
    mount: function (root) {
      injectStyle();
      var st = PT.store.get();
      var session = st.session;
      PT.dom.$('#topbar').hidden = false;
      PT.dom.$('#topbar-context').textContent = session.rootName;
      PT.dom.$('#topbar-counters').textContent = '';

      var sets = resultSets(session);

      root.appendChild(el('h1', { text: 'Export review' }));

      if (!sets.length) {
        root.appendChild(el('div', { class: 'card' }, [
          el('p', { text: 'No finalists yet. Finish at least one tournament first.' }),
          el('button', { class: 'btn', text: 'Back to the folder tree',
            onclick: function () { PT.router.go('tree'); } })
        ]));
        return;
      }

      var opts = el('div', { class: 'card row' });
      var listHost = el('div');
      var actions = el('div', { class: 'card row' });
      root.appendChild(opts);
      root.appendChild(listHost);
      root.appendChild(actions);

      session.labels = session.labels || {};

      /* --------------------------------------------------------- options -- */

      function toggle(labelText, key, title) {
        var cb = el('input', { type: 'checkbox' });
        cb.checked = !!session.settings[key];
        cb.addEventListener('change', function () {
          PT.store.dispatch('export:opt', function (s) { s.session.settings[key] = cb.checked; });
          renderList();
        });
        return el('label', { class: 'check small', title: title || '' }, [cb, el('span', { text: labelText })]);
      }

      opts.appendChild(toggle('Numbered prefixes', 'prefixes',
        'Keeps rank order when a slideshow tool sorts alphabetically'));

      var structSel = el('select', {});
      [['mirror', 'Mirror the source folders'], ['flat', 'Flatten into one folder']].forEach(function (o) {
        var op = el('option', { value: o[0], text: o[1] });
        if (session.settings.outputStructure === o[0]) op.selected = true;
        structSel.appendChild(op);
      });
      structSel.addEventListener('change', function () {
        PT.store.dispatch('export:struct', function (s) { s.session.outputStructure = structSel.value; s.session.settings.outputStructure = structSel.value; });
        renderList();
      });
      opts.appendChild(structSel);
      opts.appendChild(el('span', { class: 'spacer' }));
      opts.appendChild(el('span', { class: 'small dim', id: 'exp-total' }));

      /* ------------------------------------------------------------ list -- */

      function renderList() {
        var s = PT.store.get();
        PT.dom.clear(listHost);
        var totalFiles = 0, totalBytes = 0;

        sets.forEach(function (set) {
          var card = el('div', { class: 'card exp-set' });
          card.appendChild(el('div', { class: 'row' }, [
            el('h2', { text: set.unit.label }),
            el('span', { class: 'muted small mono', text:
              (s.session.settings.outputStructure === 'flat' ? '_finalists' : set.folder) + '/' }),
            el('span', { class: 'spacer' }),
            el('span', { class: 'muted small', text: set.ids.length + ' finalists' })
          ]));

          set.ids.forEach(function (id, i) {
            var photo = s.photos[id];
            if (!photo) return;
            totalFiles++;
            totalBytes += photo.size || 0;

            var img = el('img', { class: 'exp-thumb', alt: '' });
            var d = s.derivatives[id];
            if (d && d.thumb) PT.dom.setImg(img, d.thumb);

            var dest = el('div', { class: 'exp-dest' });
            var labelInput = el('input', {
              type: 'text', placeholder: 'why this one won, or how it will be used',
              value: s.session.labels[id] || ''
            });
            var refresh = function () {
              dest.textContent = destName(photo, i + 1, set.ids.length, s.session.settings, labelInput.value);
            };
            labelInput.addEventListener('input', function () {
              PT.store.dispatch('export:label', function (ss) { ss.session.labels[id] = labelInput.value; });
              refresh();
            });
            refresh();

            card.appendChild(el('div', { class: 'exp-row' }, [
              el('span', { class: 'exp-rank', text: String(i + 1) }),
              img,
              el('div', {}, [
                el('div', { class: 'exp-name', text: photo.name }),
                el('div', { class: 'small dim', text: photo.dir || '/' })
              ]),
              el('div', {}, [labelInput, dest])
            ]));
          });

          listHost.appendChild(card);
        });

        // PRD 8: duplication across sets is deliberate, so report the real total.
        PT.dom.$('#exp-total').textContent =
          totalFiles + ' files, about ' + PT.fmt.bytes(totalBytes) + ' to write';
      }

      renderList();

      /* --------------------------------------------------------- actions -- */

      var canWrite = session.sourceKind === 'handle' && PT.env.hasFSA;

      var writeBtn = el('button', {
        class: 'btn btn-primary',
        text: canWrite ? 'Write finalists to disk' : 'Writing to disk needs a folder handle',
        onclick: function () { doWrite(sets); }
      });
      writeBtn.disabled = !canWrite;
      if (!canWrite) {
        writeBtn.title = 'This session was started from dropped files, so there is no folder to write into. ' +
          'Download the bundle instead.';
      }

      actions.appendChild(writeBtn);
      actions.appendChild(el('button', { class: 'btn', text: 'Download as files',
        onclick: function () { doDownload(sets); } }));
      actions.appendChild(el('button', { class: 'btn', text: 'Copy filename list',
        onclick: function () { copyList(sets); } }));
      actions.appendChild(el('button', { class: 'btn btn-quiet', text: 'Decision JSON',
        onclick: function () { downloadJson(sets); } }));
      actions.appendChild(el('span', { class: 'spacer' }));
      actions.appendChild(el('span', { class: 'small dim', id: 'exp-status' }));
    },

    unmount: function (root) {
      PT.dom.$$('.exp-thumb', root).forEach(function (img) { PT.dom.releaseImg(img); });
    }
  });

  function status(msg) {
    var n = PT.dom.$('#exp-status');
    if (n) n.textContent = msg;
  }

  /** Reads the original bytes back for export. */
  function originalBlob(id) {
    var src = PT.sources[id];
    if (!src) return Promise.reject(new Error('the original file is no longer available in this session'));
    if (typeof src.getFile === 'function') return src.getFile();
    return Promise.resolve(src);
  }

  function plan(sets) {
    var s = PT.store.get();
    var flat = s.session.settings.outputStructure === 'flat';
    var out = [];
    sets.forEach(function (set) {
      set.ids.forEach(function (id, i) {
        var photo = s.photos[id];
        if (!photo) return;
        out.push({
          id: id,
          photo: photo,
          folder: flat ? '_finalists' : set.folder,
          name: destName(photo, i + 1, set.ids.length, s.session.settings, s.session.labels[id]),
          rank: i + 1,
          unit: set.unit.label
        });
      });
    });
    return out;
  }

  /**
   * PRD 7.8: collision handling applies to disk writes only. When a target folder
   * already exists with contents, ask — never silently overwrite.
   */
  function resolveCollision(dirHandle, folder) {
    return dirHandle.getDirectoryHandle(folder, { create: false })
      .then(function (existing) {
        return (async function () {
          for await (var _ of existing.values()) return true;
          return false;
        })();
      })
      .then(function (hasContents) {
        if (!hasContents) return { mode: 'add', folder: folder };
        return ask(folder);
      })
      .catch(function () { return { mode: 'add', folder: folder }; });
  }

  function ask(folder) {
    return new Promise(function (resolve) {
      var body = PT.dom.$('#modal-body');
      PT.dom.clear(body);
      body.appendChild(el('h2', { text: folder + ' already has files in it' }));
      body.appendChild(el('p', { class: 'muted small', text:
        'Nothing is overwritten unless you choose to replace.' }));
      var pick = function (mode) {
        return function () {
          PT.dom.$('#modal').close();
          resolve({
            mode: mode,
            folder: mode === 'sibling'
              ? folder + '_' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
              : folder
          });
        };
      };
      body.appendChild(el('div', { class: 'row' }, [
        el('button', { class: 'btn', text: 'Add alongside', onclick: pick('add') }),
        el('button', { class: 'btn btn-danger', text: 'Replace contents', onclick: pick('replace') }),
        el('button', { class: 'btn btn-primary', text: 'New timestamped folder', onclick: pick('sibling') })
      ]));
      PT.dom.$('#modal').showModal();
    });
  }

  function doWrite(sets) {
    var items = plan(sets);
    status('Preparing…');

    PT.db.get('handles', 'root').then(function (rec) {
      if (!rec || !rec.handle) throw new Error('no folder handle stored for this session');
      var dir = rec.handle;

      return dir.queryPermission({ mode: 'readwrite' }).then(function (p) {
        // A stored handle comes back as "prompt" after a browser restart, and
        // re-granting requires a user gesture — which this click is.
        if (p === 'granted') return 'granted';
        return dir.requestPermission({ mode: 'readwrite' });
      }).then(function (p) {
        if (p !== 'granted') throw new Error('permission to write was not granted');

        var folders = {};
        items.forEach(function (it) { folders[it.folder] = 1; });

        var chain = Promise.resolve();
        var mapping = {};
        Object.keys(folders).forEach(function (f) {
          chain = chain.then(function () {
            return resolveCollision(dir, f).then(function (choice) { mapping[f] = choice; });
          });
        });

        return chain.then(function () {
          var written = 0;
          var seq = Promise.resolve();
          items.forEach(function (it) {
            seq = seq.then(function () {
              var choice = mapping[it.folder];
              return dir.getDirectoryHandle(choice.folder, { create: true })
                .then(function (fh) {
                  if (choice.mode === 'replace' && !choice._cleared) {
                    choice._cleared = true;
                    return (async function () {
                      var names = [];
                      for await (var e of fh.values()) names.push(e.name);
                      for (var i = 0; i < names.length; i++) {
                        await fh.removeEntry(names[i], { recursive: true });
                      }
                      return fh;
                    })();
                  }
                  return fh;
                })
                .then(function (fh) {
                  return originalBlob(it.id).then(function (blob) {
                    return fh.getFileHandle(it.name, { create: true })
                      .then(function (file) { return file.createWritable(); })
                      .then(function (w) {
                        return w.write(blob).then(function () { return w.close(); });
                      });
                  });
                })
                .then(function () {
                  written++;
                  if (written % 5 === 0) status('Writing… ' + written + ' / ' + items.length);
                });
            });
          });
          return seq.then(function () { return written; });
        });
      });
    }).then(function (written) {
      status(written + ' files written.');
      PT.toast('Wrote ' + written + ' finalists into ' + PT.store.get().session.rootName + '.');
      PT.store.dispatch('export:done', function (s) { s.session.finished = true; });
    }).catch(function (e) {
      PT.warn('export', e);
      status('');
      PT.toast('Could not write: ' + e.message);
    });
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /**
   * Downloads each finalist individually rather than zipping. A zip would need a
   * compression library; Chromium prompts once for multiple downloads and the
   * names already carry the folder in them.
   */
  function doDownload(sets) {
    var items = plan(sets);
    var i = 0;
    status('Downloading…');
    (function next() {
      if (i >= items.length) { status(items.length + ' files downloaded.'); return; }
      var it = items[i++];
      originalBlob(it.id)
        .then(function (blob) { saveBlob(blob, it.folder + '__' + it.name); })
        .catch(function () { /* a missing original must not stall the rest */ })
        .then(function () { setTimeout(next, 120); });
    })();
  }

  function copyList(sets) {
    var text = plan(sets).map(function (it) { return it.folder + '/' + it.name; }).join('\n');
    navigator.clipboard.writeText(text)
      .then(function () { PT.toast('Filename list copied.'); })
      .catch(function () { PT.toast('Could not reach the clipboard.'); });
  }

  /** PRD 7.8: decision history including labels and the full filename mapping. */
  function downloadJson(sets) {
    var s = PT.store.get();
    var items = plan(sets);
    var doc = {
      _metadata: {
        file: 'photournament_decisions.json',
        version: '1.0',
        app: 'Photournament v' + PT.VERSION,
        exported: new Date().toISOString(),
        source: s.session.rootName
      },
      settings: s.session.settings,
      allocations: s.session.allocs,
      units: Object.keys(s.session.units).map(function (k) {
        var u = s.session.units[k];
        return {
          id: u.id, label: u.label, kind: u.kind, target: u.target,
          field: u.allIds.length, comparisons: u.comparisons,
          passes: u.passes, rescued: u.rescued.length,
          winners: u.winners
        };
      }),
      mapping: items.map(function (it) {
        return {
          id: it.id, rank: it.rank, unit: it.unit,
          original: it.photo.path,
          label: s.session.labels[it.id] || '',
          exported: it.folder + '/' + it.name
        };
      }),
      actionLog: PT.store.actionLog()
    };
    saveBlob(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
      'photournament_decisions_v1.0.json');
    PT.toast('Decision JSON downloaded.');
  }
})();

/** CHANGELOG
 * v1.0 (2026-07-28): Initial release. Review list with rank, source and
 *   destination filename, per-finalist intent labels feeding the filename,
 *   toggleable ordered prefixes, mirrored or flat output, per-source folder
 *   naming, disk writing with permission re-grant and collision prompts,
 *   individual downloads, clipboard list, and the decision JSON.
 */
