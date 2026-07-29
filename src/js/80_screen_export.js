/**
 * @file 80_screen_export.js
 * @version 1.5
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

  /**
   * The session, in numbers. Everything here is computed from state the run
   * already produced — photo dimensions and sharpness from ingest, pass
   * summaries and comparisons from the stages, groups from the review — so the
   * panel costs nothing and invents nothing. Rates are only shown where the
   * denominator is big enough to mean something; a 2-photo category "trend"
   * would be noise wearing a percent sign.
   */
  function computeStats(st, session, sets) {
    var photos = st.photos || {};
    var finalSet = Object.create(null);
    sets.forEach(function (set) { set.ids.forEach(function (id) { finalSet[id] = 1; }); });

    var units = Object.keys(session.units)
      .filter(function (k) { return k !== session.stageDUnit; })
      .map(function (k) { return session.units[k]; });

    var entered = Object.create(null);
    var folders = [];
    var passes = 0, screens = 0, comparisons = 0, rescued = 0;
    units.forEach(function (u) {
      (u.allIds || []).forEach(function (id) { entered[id] = 1; });
      var kept = (u.winners || []).filter(function (id) { return finalSet[id]; }).length;
      folders.push({ label: u.label, entered: (u.allIds || []).length, kept: kept });
      passes += (u.passes || []).length;
      (u.passes || []).forEach(function (ps) { screens += ps.screens || 0; });
      comparisons += u.comparisons || 0;
      rescued += (u.rescued || []).length;
    });

    var enteredIds = Object.keys(entered);
    var finalists = Object.keys(finalSet).length;

    // Keep-rate per category, computed over everything that ENTERED, so the
    // rates answer "of what I shot, what survived" rather than describing the
    // finalists alone.
    function rate(classify) {
      var by = Object.create(null);
      enteredIds.forEach(function (id) {
        var p = photos[id];
        if (!p || p.err) return;
        var k = classify(p);
        if (!k) return;
        var b = by[k] || (by[k] = { entered: 0, kept: 0 });
        b.entered++;
        if (finalSet[id]) b.kept++;
      });
      return Object.keys(by)
        .filter(function (k) { return by[k].entered >= 5; })
        .map(function (k) { return { label: k, entered: by[k].entered, kept: by[k].kept }; })
        .sort(function (a, b) { return b.entered - a.entered; });
    }

    var orientation = rate(function (p) {
      if (!p.w || !p.h) return null;
      return p.w > p.h ? 'landscape' : (p.h > p.w ? 'portrait' : 'square');
    });
    var formats = rate(function (p) { return p.kind || null; });

    // Sharpness of what survived vs what did not, as medians — a single soft
    // keeper must not be averaged away.
    function median(list) {
      if (!list.length) return null;
      var a = list.slice().sort(function (x, y) { return x - y; });
      var m = a.length >> 1;
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    }
    var sharpKept = [], sharpCut = [];
    enteredIds.forEach(function (id) {
      var p = photos[id];
      if (!p || p.err || typeof p.sharp !== 'number') return;
      (finalSet[id] ? sharpKept : sharpCut).push(p.sharp);
    });

    // Bursts: how many groups, how many frames inside them, how many finalists
    // came out of a group, and how often the user overrode the sharpest pick.
    var burstGroups = 0, burstFrames = 0, burstFinalists = 0;
    units.forEach(function (u) {
      (u.groups || []).forEach(function (g) {
        var ids = g.ids || [];
        if (ids.length < 2) return;
        burstGroups++;
        burstFrames += ids.length;
        ids.forEach(function (id) { if (finalSet[id]) burstFinalists++; });
      });
    });
    var overrides = Object.keys((session.groups && session.groups.reps) || {}).length;

    return {
      entered: enteredIds.length,
      finalists: finalists,
      folders: folders.filter(function (f) { return f.entered > 0; }),
      passes: passes, screens: screens, comparisons: comparisons, rescued: rescued,
      startedAt: session.createdAt,
      orientation: orientation,
      formats: formats,
      sharpKept: median(sharpKept), sharpCut: median(sharpCut),
      burstGroups: burstGroups, burstFrames: burstFrames,
      burstFinalists: burstFinalists, repOverrides: overrides
    };
  }

  /** The stats panel: closed by default — interesting, never mandatory. */
  function statsCard(stats) {
    var pct = function (kept, entered) {
      return entered ? Math.round((kept / entered) * 100) : 0;
    };
    var tile = function (value, label) {
      return el('div', { class: 'exp-stat' }, [
        el('div', { class: 'exp-stat-num nums', text: String(value) }),
        el('div', { class: 'exp-stat-label', text: label })
      ]);
    };
    var barRow = function (label, kept, entered) {
      return el('div', { class: 'exp-bar-row' }, [
        el('span', { class: 'exp-bar-label', text: label }),
        el('span', { class: 'exp-bar nums', text: kept + ' of ' + entered }),
        el('span', { class: 'tree-bar', style: '--p:' + (entered ? kept / entered : 0) }, [el('i')]),
        el('span', { class: 'exp-bar-pct nums', text: pct(kept, entered) + '%' })
      ]);
    };

    var body = el('div', { class: 'exp-stats-body' });

    body.appendChild(el('div', { class: 'exp-stat-tiles' }, [
      tile(stats.entered, 'photos entered'),
      tile(stats.finalists, 'finalists'),
      tile((100 - pct(stats.finalists, stats.entered)) + '%', 'culled'),
      tile(stats.screens + stats.comparisons, 'decisions made')
    ]));

    if (stats.folders.length > 1) {
      body.appendChild(el('h3', { text: 'By folder' }));
      stats.folders.forEach(function (f) { body.appendChild(barRow(f.label, f.kept, f.entered)); });
    }

    var taste = [];
    if (stats.orientation.length > 1) {
      taste.push(el('h3', { text: 'What survived, by shape' }));
      stats.orientation.forEach(function (o) { taste.push(barRow(o.label, o.kept, o.entered)); });
    }
    if (stats.formats.length > 1) {
      taste.push(el('h3', { text: 'By format' }));
      stats.formats.forEach(function (f) { taste.push(barRow(f.label, f.kept, f.entered)); });
    }
    taste.forEach(function (n) { body.appendChild(n); });

    var lines = [];
    if (stats.sharpKept != null && stats.sharpCut != null && stats.sharpCut > 0) {
      var ratio = stats.sharpKept / stats.sharpCut;
      lines.push('Your keepers measure ' +
        (ratio >= 1.05 ? Math.round((ratio - 1) * 100) + '% sharper than' :
         ratio <= 0.95 ? Math.round((1 - ratio) * 100) + '% softer than' : 'about as sharp as') +
        ' what you cut — median sharpness ' + Math.round(stats.sharpKept) +
        ' vs ' + Math.round(stats.sharpCut) + '.');
    }
    if (stats.burstGroups > 0) {
      lines.push(stats.burstGroups + ' burst' + (stats.burstGroups === 1 ? '' : 's') +
        ' held ' + stats.burstFrames + ' frames; ' + stats.burstFinalists +
        ' made the finalists' +
        (stats.repOverrides > 0
          ? ', and you overrode the sharpest-frame suggestion ' + stats.repOverrides +
            ' time' + (stats.repOverrides === 1 ? '' : 's') + '.'
          : '.'));
    }
    if (stats.rescued > 0) {
      lines.push(stats.rescued + ' photo' + (stats.rescued === 1 ? '' : 's') +
        ' came back from the cut pile — the first instinct is not always the last word.');
    }
    if (stats.passes > 0) {
      lines.push(stats.passes + ' grid pass' + (stats.passes === 1 ? '' : 'es') + ' over ' +
        stats.screens + ' screens, then ' + stats.comparisons + ' head-to-head comparison' +
        (stats.comparisons === 1 ? '' : 's') + '.');
    }
    if (lines.length) {
      body.appendChild(el('h3', { text: 'Notes' }));
      lines.forEach(function (t) { body.appendChild(el('p', { class: 'small dim', text: t })); });
    }

    return el('details', { class: 'card exp-stats', id: 'exp-stats' }, [
      el('summary', { text: 'Session stats — what you culled, what you kept' }),
      body
    ]);
  }

  function resultSets(session) {
    return Object.keys(session.units)
      .map(function (k) { return session.units[k]; })
      .filter(function (u) { return u.winners && u.winners.length; })
      .map(function (u) { return { unit: u, folder: folderFor(u), ids: u.winners.slice() }; });
  }

  PT.router.register('export', {
    mount: function (root) {
      var st = PT.store.get();
      var session = st.session;
      PT.dom.$('#topbar').hidden = false;
      PT.dom.$('#topbar-context').textContent = session.rootName;
      PT.dom.$('#topbar-counters').textContent = '';

      var sets = resultSets(session);

      root.appendChild(el('h1', { text: 'Export review' }));

      // Files are written exactly as shot; a manual rotation or flip lives in
      // the derivatives, so it shows here and on the contact sheet but not in
      // an exported original. Said only when it actually applies.
      var st0 = PT.store.get();
      var oriented = sets.some(function (set) {
        return set.ids.some(function (id) {
          var ph = st0.photos[id];
          return ph && ph.orient;
        });
      });
      if (oriented) {
        root.appendChild(el('div', { class: 'notice notice-note small', text:
          'Some finalists were rotated or flipped by hand. That correction shows everywhere in ' +
          'this tool, including the contact sheet \u2014 but exported files are written exactly ' +
          'as shot, so fix the orientation in your photo app after export.' }));
      }

      if (sets.length) {
        root.appendChild(statsCard(computeStats(st0, session, sets)));
      }

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
            // Built as three children rather than one string so the stylesheet can
            // brighten the part the user typed, making it visible that what they
            // write becomes part of what gets written to disk.
            var refresh = function () {
              PT.dom.clear(dest);
              var slug = slugLabel(labelInput.value);
              if (s.session.settings.prefixes) {
                dest.appendChild(document.createTextNode(
                  PT.fmt.ordinal(i + 1, set.ids.length) + '_'));
              }
              if (slug) dest.appendChild(el('span', { class: 'exp-slug', text: slug + '_' }));
              dest.appendChild(document.createTextNode(photo.name));
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
      actions.appendChild(el('button', {
        class: 'btn', text: 'Save all to a folder…',
        title: 'Pick one destination folder. Everything is written there in one go, with no ' +
               'download prompts.',
        onclick: function () { doSaveToFolder(sets); }
      }));
      actions.appendChild(el('button', {
        class: 'btn', text: 'Download as one .zip',
        title: 'A single download containing every finalist, foldered. Works in any browser.',
        onclick: function () { doDownloadZip(sets); }
      }));
      actions.appendChild(el('button', {
        class: 'btn', text: 'Contact sheet',
        title: 'One PNG showing every finalist in rank order, grouped by source folder',
        onclick: function () { doContactSheet(sets); }
      }));
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

  /* ------------------------------------------------------------- zip out -- */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
  function u16(v) { return [v & 255, (v >>> 8) & 255]; }

  /**
   * Builds a STORED (uncompressed) zip. Photographs are already compressed, so
   * deflating them would cost CPU and save almost nothing — which is what makes
   * a dependency-free zip writer worth having here. One download instead of N
   * is the whole point: browsers prompt on multi-file downloads and some ask for
   * a location per file.
   *
   * Bytes are read one file at a time, but every file ends up in the finished
   * Blob, so peak memory is roughly the total export size.
   */
  function buildZip(items, onProgress) {
    var parts = [];
    var central = [];
    var offset = 0;
    var enc = new TextEncoder();
    var done = 0;

    var chain = Promise.resolve();
    items.forEach(function (it) {
      chain = chain.then(function () {
        return originalBlob(it.id).then(function (blob) {
          return blob.arrayBuffer();
        }).then(function (ab) {
          var bytes = new Uint8Array(ab);
          var name = enc.encode(it.folder + '/' + it.name);
          var crc = crc32(bytes);

          var local = new Uint8Array([].concat(
            u32(0x04034b50), u16(20), u16(0), u16(0),
            u16(0), u16(0),                       // fixed timestamp: keeps output deterministic
            u32(crc), u32(bytes.length), u32(bytes.length),
            u16(name.length), u16(0)
          ));
          parts.push(local, name, bytes);
          central.push({ name: name, crc: crc, size: bytes.length, offset: offset });
          offset += local.length + name.length + bytes.length;

          done++;
          if (onProgress) onProgress(done, items.length);
        }).catch(function (e) {
          PT.warn('export', 'skipping ' + it.name + ': ' + e.message);
        });
      });
    });

    return chain.then(function () {
      var dirStart = offset;
      var dirSize = 0;
      central.forEach(function (c) {
        var head = new Uint8Array([].concat(
          u32(0x02014b50), u16(20), u16(20), u16(0), u16(0),
          u16(0), u16(0),
          u32(c.crc), u32(c.size), u32(c.size),
          u16(c.name.length), u16(0), u16(0), u16(0), u16(0),
          u32(0), u32(c.offset)
        ));
        parts.push(head, c.name);
        dirSize += head.length + c.name.length;
      });
      parts.push(new Uint8Array([].concat(
        u32(0x06054b50), u16(0), u16(0),
        u16(central.length), u16(central.length),
        u32(dirSize), u32(dirStart), u16(0)
      )));
      return new Blob(parts, { type: 'application/zip' });
    });
  }

  function doDownloadZip(sets) {
    var items = plan(sets);
    if (!items.length) return;
    status('Building the zip…');
    buildZip(items, function (n, total) { status('Packing ' + n + ' / ' + total + '…'); })
      .then(function (blob) {
        var s = PT.store.get();
        var stamp = new Date().toISOString().slice(0, 10);
        saveBlob(blob, slugLabel(s.session.rootName || 'photournament') + '_finalists_' + stamp + '.zip');
        status(items.length + ' files in one zip, ' + PT.fmt.bytes(blob.size) + '.');
      })
      .catch(function (e) {
        PT.warn('export', e);
        status('');
        PT.toast('Could not build the zip: ' + e.message);
      });
  }

  /* --------------------------------------------------------- folder save -- */

  /**
   * Writes every finalist into ONE folder the user picks, creating the per-source
   * subfolders inside it. This is the answer to a browser asking where to put
   * each file: one dialog, one destination, no download prompts at all. It works
   * even when the session came from dropped files, because the destination handle
   * is independent of the source.
   */
  function doSaveToFolder(sets) {
    if (typeof window.showDirectoryPicker !== 'function') {
      PT.toast('This browser cannot pick an output folder. Use the zip instead.');
      return;
    }
    var items = plan(sets);
    var dir;
    Promise.resolve(window.showDirectoryPicker({ mode: 'readwrite' }))
      .then(function (d) {
        dir = d;
        return d.requestPermission ? d.requestPermission({ mode: 'readwrite' }) : 'granted';
      })
      .then(function (p) {
        if (p !== 'granted') throw new Error('permission to write was not granted');
        var written = 0;
        var seq = Promise.resolve();
        items.forEach(function (it) {
          seq = seq.then(function () {
            return dir.getDirectoryHandle(it.folder, { create: true })
              .then(function (fh) {
                return originalBlob(it.id).then(function (blob) {
                  return fh.getFileHandle(it.name, { create: true })
                    .then(function (f) { return f.createWritable(); })
                    .then(function (w) { return w.write(blob).then(function () { return w.close(); }); });
                });
              })
              .then(function () {
                written++;
                status('Saving… ' + written + ' / ' + items.length);
              });
          });
        });
        return seq.then(function () { return written; });
      })
      .then(function (written) {
        status(written + ' files saved into ' + dir.name + '.');
        PT.toast('Saved ' + written + ' finalists into ' + dir.name + '.');
      })
      .catch(function (e) {
        if (e && e.name === 'AbortError') { status(''); return; }
        PT.warn('export', e);
        status('');
        PT.toast('Could not save: ' + e.message);
      });
  }

  /* --------------------------------------------------------- contact sheet -- */

  /**
   * PRD 7.8: "ranked finalists as a thumbnail grid, grouped by source."
   *
   * Composed onto a canvas and saved as one PNG rather than rendered as a web
   * view, because the useful artifact for a portfolio is a single image you can
   * open, print or send — not another screen inside the tool. Thumbnails are
   * already cached, so this costs no decoding.
   */
  function buildContactSheet(sets) {
    var s = PT.store.get();
    var COLS = 5, CELL = 260, PAD = 18, HEAD = 46, LABEL = 26, TITLE = 64;

    var blocks = sets.map(function (set) {
      var ids = set.ids.filter(function (id) { return s.derivatives[id] && s.derivatives[id].thumb; });
      return { set: set, ids: ids, rows: Math.ceil(ids.length / COLS) || 0 };
    }).filter(function (b) { return b.ids.length; });

    if (!blocks.length) return Promise.reject(new Error('no cached thumbnails to build a sheet from'));

    var width = PAD * 2 + COLS * CELL + (COLS - 1) * PAD;
    var height = TITLE + blocks.reduce(function (h, b) {
      return h + HEAD + b.rows * (CELL + LABEL + PAD);
    }, 0) + PAD;

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');

    // Neutral grey, no cast — the same rule that governs the app's own chrome
    // applies to a sheet whose whole purpose is comparing photographs.
    ctx.fillStyle = '#0d0d0e';
    ctx.fillRect(0, 0, width, height);
    ctx.textBaseline = 'top';

    ctx.fillStyle = '#e8e8ea';
    ctx.font = '600 26px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(s.session.rootName + ' — finalists', PAD, PAD);

    var y = TITLE;
    var jobs = [];

    blocks.forEach(function (b) {
      var headY = y;
      jobs.push(function () {
        ctx.fillStyle = '#9a9aa2';
        ctx.font = '600 17px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(b.set.unit.label + '  ·  ' + b.ids.length, PAD, headY + 12);
        return Promise.resolve();
      });
      y += HEAD;

      b.ids.forEach(function (id, i) {
        var col = i % COLS, row = Math.floor(i / COLS);
        var x = PAD + col * (CELL + PAD);
        var cy = y + row * (CELL + LABEL + PAD);
        var photo = s.photos[id];
        var blob = s.derivatives[id].thumb;
        var rank = i + 1;

        jobs.push(function () {
          return createImageBitmap(blob).then(function (bmp) {
            ctx.fillStyle = '#000';
            ctx.fillRect(x, cy, CELL, CELL);
            // contain, never crop: a cropped contact sheet misrepresents the frame
            var sc = Math.min(CELL / bmp.width, CELL / bmp.height);
            var w = bmp.width * sc, h = bmp.height * sc;
            ctx.drawImage(bmp, x + (CELL - w) / 2, cy + (CELL - h) / 2, w, h);
            bmp.close();

            ctx.fillStyle = '#6b6b73';
            ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
            var name = photo ? photo.name : id;
            if (name.length > 30) name = name.slice(0, 29) + '…';
            ctx.fillText(rank + '. ' + name, x, cy + CELL + 6);
          }).catch(function () { /* one unreadable thumbnail must not kill the sheet */ });
        });
      });

      y += b.rows * (CELL + LABEL + PAD);
    });

    var chain = Promise.resolve();
    jobs.forEach(function (j) { chain = chain.then(j); });
    return chain.then(function () {
      return new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
    });
  }

  function doContactSheet(sets) {
    status('Building the contact sheet…');
    buildContactSheet(sets).then(function (blob) {
      var s = PT.store.get();
      saveBlob(blob, slugLabel(s.session.rootName || 'photournament') + '_contact_sheet.png');
      status('Contact sheet saved, ' + PT.fmt.bytes(blob.size) + '.');
    }).catch(function (e) {
      PT.warn('export', e);
      status('');
      PT.toast('Could not build the contact sheet: ' + e.message);
    });
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
  * v1.1 (2026-07-28): Replaced the one-download-per-file export, which made
 *   browsers ask for a location per photo, with two options that each need one
 *   interaction: "Save all to a folder", which writes everything into a single
 *   picked destination even when the session came from dropped files, and
 *   "Download as one .zip", a dependency-free STORED zip (photographs are already
 *   compressed, so deflating them would buy nothing).
 * v1.2 (2026-07-28): Adopted photournament_ui_v2.0.css. Removed the injected
 *   style block and split the destination filename into three nodes so the part
 *   the user typed can be highlighted as it becomes part of the written name.
 * v1.3 (2026-07-28): Added the PRD 7.8 ranked thumbnail grid as a downloadable
 *   contact sheet — one PNG, grouped by source, rank-ordered. Composed on a canvas
 *   rather than rendered as another screen, because the useful artifact for a
 *   portfolio is a single image you can open, print or send.
 * v1.4 (2026-07-28): Says so when finalists carry a manual rotation or flip:
 *   the exported originals are as shot; the correction lives in the derivatives.
 * v1.5 (2026-07-29): Session stats on the review, closed by default. Entered /
 *   finalists / culled / decisions tiles, per-folder and per-shape and
 *   per-format keep rates (only where the denominator earns a percentage),
 *   keeper-vs-cut sharpness medians, burst and rescue and effort notes — all
 *   from state the run already produced.
*/
