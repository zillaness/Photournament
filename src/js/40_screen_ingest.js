/**
 * @file 40_screen_ingest.js
 * @version 1.0
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description PRD 7.9 ingest: folder entry by picker or drag, recursive scan, format triage, worker-pool derivative generation with progress, and cache reporting.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * Registers two screens: 'welcome' (entry) and 'ingest' (scan + process).
 *
 * SIZING, from a real measured folder rather than the PRD's estimate: 746 stills
 * (601 JPEG, 137 HEIC, 3 PNG, 3 WebP, 2 GIF) alongside 175 video files. PRD 3
 * says "roughly 500 photos"; the real figure was 50% higher, and video — which
 * PRD 9 puts out of scope — accounted for 79% of the bytes. Both drive design
 * here: previews are capped at 1280px so the derivative cache stays near 190MB
 * rather than 400MB against a quota measured as low as 0.96GB, and video is a
 * named, counted category rather than an error.
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});
  var el = PT.dom.el;

  /**
   * Runtime-only handle map, id -> File | FileSystemFileHandle. Never persisted:
   * File objects are not meaningfully revivable and handles are re-walked from
   * the stored directory handle on resume.
   */
  PT.sources = PT.sources || Object.create(null);

  var PREVIEW_PX = 1280;

  /* ------------------------------------------------------------- entry ---- */

  PT.router.register('welcome', {
    mount: function (root) {
      PT.dom.$('#topbar').hidden = true;

      var card = el('div', { class: 'card' }, [
        el('h1', { text: 'Photournament' }),
        el('p', { class: 'muted', text:
          'Point it at a folder of photos. It cuts the field down with quota-enforced grid ' +
          'passes, then ranks what survives head to head.' })
      ]);

      var drop = el('div', { class: 'dropzone', id: 'dropzone' }, [
        el('div', { class: 'dropzone-inner' }, [
          el('div', { class: 'drop-title', text: 'Drop a folder here' }),
          el('div', { class: 'muted small', text: 'or' }),
          el('button', { class: 'btn btn-primary', id: 'pick-folder', text: 'Choose a folder' }),
          el('div', { class: 'small dim', id: 'fallback-note' })
        ])
      ]);

      // A webkitdirectory input yields webkitRelativePath on every file, so the
      // folder tree survives even without the File System Access API. It cannot
      // write results back to disk, but it is a far better fallback than a flat
      // file list: the whole allocation model in PRD 4 depends on structure.
      var dirInput = el('input', {
        type: 'file', id: 'dir-files', multiple: true, style: 'display:none'
      });
      dirInput.setAttribute('webkitdirectory', '');

      var loose = el('div', { class: 'row small' }, [
        dirInput,
        el('input', { type: 'file', id: 'loose-files', multiple: true, accept: 'image/*', style: 'display:none' }),
        el('button', {
          class: 'btn btn-quiet btn-sm', text: 'Choose a folder without disk output',
          title: 'Keeps the folder structure, but results must be downloaded rather than written back',
          onclick: function () { dirInput.click(); }
        }),
        el('button', {
          class: 'btn btn-quiet btn-sm', text: 'Pick individual files',
          onclick: function () { PT.dom.$('#loose-files').click(); }
        })
      ]);

      root.appendChild(card);
      root.appendChild(drop);
      root.appendChild(loose);
      root.appendChild(el('div', { id: 'entry-msg' }));

      // PRD 8: state the degraded mode plainly rather than failing quietly.
      var note = PT.dom.$('#fallback-note');
      if (!PT.env.hasFSA) {
        note.appendChild(el('div', { class: 'notice notice-warn', html:
          '<b>This browser cannot write results to disk or resume a session.</b><br>' +
          'The File System Access API is Chromium-only. In Chrome, Edge, Brave or Opera you get ' +
          'resume and disk output. Here you can still cull, but results must be downloaded ' +
          'and the session ends when you close the tab.' }));
        PT.dom.$('#pick-folder').disabled = true;
      }

      PT.dom.$('#pick-folder').addEventListener('click', function () {
        // Must be inside the user gesture. AbortError is a cancelled dialog,
        // which is an ordinary outcome, not a failure (probe 01).
        window.showDirectoryPicker({ mode: 'readwrite' })
          .then(function (handle) { beginFromHandle(handle); })
          .catch(function (e) {
            if (e && e.name === 'AbortError') return;
            showEntryError(e);
          });
      });

      PT.dom.$('#loose-files').addEventListener('change', function (ev) {
        var files = Array.prototype.slice.call(ev.target.files || []);
        if (files.length) beginFromFiles(files);
      });

      dirInput.addEventListener('change', function (ev) {
        var files = Array.prototype.slice.call(ev.target.files || []);
        if (!files.length) return;
        // webkitRelativePath is "<chosen folder>/a/b/file.jpg", so the first
        // segment names the root the user picked.
        var first = files[0].webkitRelativePath || '';
        beginFromFiles(files, first.split('/')[0] || 'photos');
      });

      wireDragDrop(drop);
    },

    unmount: function () {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    }
  });

  function swallow(e) { e.preventDefault(); }

  function wireDragDrop(drop) {
    // Without these, dropping anywhere navigates the tab to the file.
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);

    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });

    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.classList.remove('over');
      var items = Array.prototype.slice.call(e.dataTransfer.items || []);

      // A dragged folder yields a real directory handle in Chromium, which is
      // what makes resume and disk-write possible. Prefer it over a file list.
      var first = items[0];
      if (first && typeof first.getAsFileSystemHandle === 'function') {
        Promise.all(items.map(function (it) { return it.getAsFileSystemHandle(); }))
          .then(function (handles) {
            var dir = handles.filter(Boolean).filter(function (h) { return h.kind === 'directory'; })[0];
            if (dir) return beginFromHandle(dir);
            var files = Array.prototype.slice.call(e.dataTransfer.files || []);
            if (files.length) return beginFromFiles(files);
            showEntryError(new Error('Drop a folder, not a shortcut or a link.'));
          })
          .catch(showEntryError);
        return;
      }
      var files = Array.prototype.slice.call(e.dataTransfer.files || []);
      if (files.length) beginFromFiles(files);
    });
  }

  function showEntryError(e) {
    var host = PT.dom.$('#entry-msg');
    if (!host) return;
    PT.dom.clear(host).appendChild(
      el('div', { class: 'error-box', text: (e && e.message) || String(e) })
    );
  }

  /* -------------------------------------------------------------- scan ---- */

  function beginFromHandle(dirHandle) {
    var session = PT.session.newSession(dirHandle.name, 'handle');
    PT.store.init({ session: session, photos: {}, derivatives: {}, tree: null, resolution: null });
    PT.db.put('handles', { key: 'root', handle: dirHandle }).catch(function (e) {
      PT.warn('ingest', 'could not persist the folder handle; resume will not work', e);
    });
    PT.router.go('ingest', { source: { type: 'handle', handle: dirHandle } });
  }

  function beginFromFiles(files, rootName) {
    var session = PT.session.newSession(rootName || 'dropped files', 'files');
    PT.store.init({ session: session, photos: {}, derivatives: {}, tree: null, resolution: null });
    PT.router.go('ingest', { source: { type: 'files', files: files } });
  }

  /**
   * Walks a directory handle, building source-relative paths.
   * Depth is uncapped so the tree mirrors the source structure (PRD 4.1), but a
   * limit guards against a symlink cycle taking the tab down.
   */
  function walkHandle(dirHandle, prefix, out, depth, onTick) {
    if (depth > 32) return Promise.resolve(out);
    var entries = [];
    return (async function () {
      for await (var entry of dirHandle.values()) entries.push(entry);
    })().then(function () {
      var chain = Promise.resolve();
      entries.forEach(function (entry) {
        // Our own output folders must never be re-ingested on a second run.
        if (entry.kind === 'directory' && /^_(finalists|sidecars)/.test(entry.name)) return;
        if (entry.name.charAt(0) === '.') return;

        chain = chain.then(function () {
          var path = prefix ? prefix + '/' + entry.name : entry.name;
          if (entry.kind === 'directory') {
            return walkHandle(entry, path, out, depth + 1, onTick);
          }
          out.push({ name: entry.name, path: path, dir: prefix, handle: entry });
          if (out.length % 50 === 0 && onTick) onTick(out.length);
          return null;
        });
      });
      return chain.then(function () { return out; });
    });
  }

  function fromFileList(files) {
    return files.map(function (f) {
      var rel = f.webkitRelativePath || f.name;
      var i = rel.lastIndexOf('/');
      return {
        name: f.name,
        path: rel,
        dir: i < 0 ? '' : rel.slice(0, i),
        file: f
      };
    });
  }

  /** Split a flat entry list into what we cull, what we skip, and what is broken. */
  function triage(entries) {
    var images = [], skipped = [], unknown = [], counts = {};
    entries.forEach(function (e) {
      var kind = PT.kindOf(e.name);
      counts[kind] = (counts[kind] || 0) + 1;
      e.kind = kind;
      if (PT.isImageKind(kind)) images.push(e);
      else if (PT.isSkippedKind(kind)) skipped.push(e);
      else unknown.push(e);
    });
    return { images: images, skipped: skipped, unknown: unknown, counts: counts };
  }

  /* ------------------------------------------------------------ ingest ---- */

  PT.router.register('ingest', {
    mount: function (root, params) {
      var topbar = PT.dom.$('#topbar');
      topbar.hidden = false;
      PT.dom.$('#topbar-context').textContent = PT.store.get().session.rootName;

      var status = el('div', { class: 'muted', text: 'Reading the folder…' });
      var bar = el('div', { class: 'bar' }, [el('i', { style: 'width:0%' })]);
      var detail = el('div', { class: 'small dim nums' });
      var summary = el('div', { id: 'ingest-summary' });
      var actions = el('div', { class: 'row', id: 'ingest-actions' });

      root.appendChild(el('div', { class: 'card screen-narrow' }, [
        el('h1', { text: 'Reading photos' }), status, bar, detail, summary, actions
      ]));

      var setProgress = function (done, total, note) {
        bar.firstChild.style.width = (total ? (done / total) * 100 : 0) + '%';
        detail.textContent = done + ' / ' + total + (note ? '   ' + note : '');
      };

      var scan = params.source.type === 'handle'
        ? walkHandle(params.source.handle, '', [], 0, function (n) {
            status.textContent = 'Reading the folder… ' + n + ' files';
          })
        : Promise.resolve(fromFileList(params.source.files));

      scan
        .then(function (entries) {
          var t = triage(entries);
          renderTriage(summary, t, entries.length);

          if (!t.images.length) {
            status.textContent = 'No photos found here.';
            actions.appendChild(el('button', {
              class: 'btn', text: 'Choose a different folder',
              onclick: function () { PT.router.go('welcome'); }
            }));
            return null;
          }

          status.textContent = 'Building thumbnails…';
          return processAll(t.images, setProgress, status)
            .then(function () {
              status.textContent = 'Ready.';
              return reportCache(summary);
            })
            .then(function () {
              PT.dom.clear(actions).appendChild(el('button', {
                class: 'btn btn-primary', text: 'Set finalist counts →',
                onclick: function () {
                  PT.store.dispatch('stage:tree', function (s) { s.session.stage = 'tree'; });
                  PT.router.go('tree');
                }
              }));
            });
        })
        .catch(function (e) {
          PT.warn('ingest', e);
          status.textContent = '';
          summary.appendChild(el('div', { class: 'error-box', text: 'Ingest failed: ' + e.message }));
        });
    },

    unmount: function () {
      if (PT._pool) { PT._pool.terminate(); PT._pool = null; }
    }
  });

  /**
   * PRD 7.9 requires unsupported files be flagged rather than dropped silently.
   * Video and RAW get their own line because they are expected and out of scope
   * (PRD 9) — showing 175 clips as "unsupported" would read as 175 problems.
   */
  function renderTriage(host, t, total) {
    PT.dom.clear(host);
    var rows = [];
    ['jpeg', 'heic', 'png', 'webp', 'gif'].forEach(function (k) {
      if (t.counts[k]) rows.push(PT.KIND_LABEL[k] + ' ' + t.counts[k]);
    });

    host.appendChild(el('div', { class: 'row small', style: 'margin-top:10px' }, [
      el('b', { text: t.images.length + ' photos' }),
      el('span', { class: 'muted', text: rows.join(' · ') })
    ]));

    if (t.skipped.length) {
      var vids = t.skipped.filter(function (e) { return e.kind === 'video'; }).length;
      var raws = t.skipped.length - vids;
      var parts = [];
      if (vids) parts.push(vids + ' video file' + (vids === 1 ? '' : 's'));
      if (raws) parts.push(raws + ' RAW file' + (raws === 1 ? '' : 's'));
      host.appendChild(el('div', { class: 'notice notice-note small', style: 'margin-top:8px', text:
        parts.join(' and ') + ' skipped. Photournament does not cull video or RAW; ' +
        'they are left exactly where they are.' }));
    }

    if (t.unknown.length) {
      host.appendChild(el('div', { class: 'notice notice-warn small', style: 'margin-top:8px', text:
        t.unknown.length + ' file' + (t.unknown.length === 1 ? '' : 's') +
        ' not recognised as an image: ' +
        t.unknown.slice(0, 4).map(function (e) { return e.name; }).join(', ') +
        (t.unknown.length > 4 ? ', …' : '') }));
    }

    host.appendChild(el('div', { class: 'small dim', style: 'margin-top:6px',
      text: total + ' files seen in total.' }));
  }

  function processAll(images, setProgress, status) {
    var libheifSrc = null;
    var heicCount = images.filter(function (e) { return e.kind === 'heic'; }).length;
    if (heicCount) {
      var node = document.getElementById('libheif-src');
      if (node && node.textContent && node.textContent.length > 1000) libheifSrc = node.textContent;
    }

    var pool = PT.ingest.createPool({
      previewPx: PREVIEW_PX,
      libheifSrc: libheifSrc,
      libheifUrl: libheifSrc ? null : undefined
    });
    PT._pool = pool;

    var total = images.length;
    var done = 0;
    var t0 = Date.now();
    var records = [];
    var derivatives = [];

    setProgress(0, total, heicCount ? heicCount + ' HEIC will take the longest' : '');

    // Sequential dispatch into the pool's own queue. The pool bounds concurrency,
    // so this cannot put 746 full-resolution decodes in flight at once.
    var chain = Promise.resolve();
    images.forEach(function (e) {
      chain = chain.then(function () {
        return pool.process(e.handle || e.file, {
          name: e.name, path: e.path, dir: e.dir, kind: e.kind
        }).then(function (rec) {
          done++;
          PT.sources[rec.id] = e.handle || e.file;

          if (rec.thumb || rec.preview) {
            derivatives.push({ id: rec.id, thumb: rec.thumb, preview: rec.preview });
          }
          var lean = {};
          Object.keys(rec).forEach(function (k) {
            if (k !== 'thumb' && k !== 'preview') lean[k] = rec[k];
          });
          records.push(lean);

          if (done % 5 === 0 || done === total) {
            var rate = (Date.now() - t0) / done;
            var left = Math.round((rate * (total - done)) / 1000);
            setProgress(done, total, left > 1 ? '~' + PT.fmt.duration(left * 1000) + ' left' : '');
          }
        });
      });
    });

    return chain.then(function () {
      status.textContent = 'Saving…';
      var failed = records.filter(function (r) { return r.err; });

      PT.store.dispatch('ingest:done', function (s) {
        records.forEach(function (r) { s.photos[r.id] = r; });
        derivatives.forEach(function (d) { s.derivatives[d.id] = d; });
        s.tree = PT.tree.build(records.filter(function (r) { return !r.err; }));
      });

      if (failed.length) {
        PT.bus.emit('toast', failed.length + ' file' + (failed.length === 1 ? '' : 's') +
          ' could not be read and will be left out.');
      }

      return PT.db.putAll('photos', records)
        .then(function () { return PT.db.putAll('derivatives', derivatives); })
        .then(function () { return PT.db.requestPersistence(); });
    });
  }

  /** PRD 8 mitigation: show cache size, and say something useful if it is large. */
  function reportCache(host) {
    return PT.db.usage().then(function (u) {
      if (!u.supported) return;
      var line = el('div', { class: 'small dim', style: 'margin-top:8px', text:
        'Cached thumbnails and previews: ' + PT.fmt.bytes(u.idb || u.usage) +
        (u.quota ? ' of ' + PT.fmt.bytes(u.quota) + ' available' : '') });
      host.appendChild(line);

      if (u.quota && (u.idb || u.usage) / u.quota > 0.6) {
        host.appendChild(el('div', { class: 'notice notice-warn small', style: 'margin-top:6px', text:
          'That is a large share of this browser profile’s storage. Everything cached here can be ' +
          'rebuilt from the originals, so clearing it costs time rather than decisions.' }));
      }
    }).catch(function () { /* usage reporting is never worth failing ingest over */ });
  }
})();

/** CHANGELOG
 * v1.0 (2026-07-28): Initial release. Folder picker and drag-drop entry with a
 *   stated loose-file fallback, recursive scan at uncapped depth, format triage
 *   separating out-of-scope video and RAW from genuinely unrecognised files,
 *   worker-pool processing with progress and time estimate, and cache reporting.
 */
