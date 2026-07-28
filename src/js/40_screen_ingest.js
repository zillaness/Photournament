/**
 * @file 40_screen_ingest.js
 * @version 1.7
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

  /**
   * The BRAND MARK is the real recursive identity, referenced from the sprite
   * defined once in the shell. Identity, so it is the identity artwork.
   */
  function brandMark() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'pt-brandmark');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Photournament');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#ptm-mark-plate');
    svg.appendChild(use);
    return svg;
  }

  /**
   * The mark, plus an overlay of nine cells laid out on the mark's own geometry.
   * Not a second object: fading the overlay in flattens the recursion into the
   * plain nine-square grid and walks it, fading it out lets the recursion back
   * through. The slot returns a `settle` so the caller can say "the work is
   * done" without knowing anything about how that is drawn.
   *
   * The overlay starts hidden and is switched to `live` on the next frame — a
   * transition needs two computed values to interpolate between, and an element
   * that has never been laid out only has one.
   */
  function workingMark() {
    var cells = [];
    for (var i = 0; i < 9; i++) cells.push(el('i'));

    var slot = el('span', { class: 'pt-markslot' }, [
      brandMark(),
      el('span', { class: 'pt-markcells', 'aria-hidden': 'true' }, cells)
    ]);

    requestAnimationFrame(function () {
      if (!slot.dataset.state) slot.dataset.state = 'live';
    });

    slot.settle = function () {
      slot.dataset.state = 'rest';
    };
    return slot;
  }

  /* ------------------------------------------------------------- entry ---- */

  PT.router.register('welcome', {
    mount: function (root) {
      PT.dom.$('#topbar').hidden = true;

      root.appendChild(el('div', { class: 'card' }, [
        // Mark and wordmark are one lockup, not two stacked things.
        el('div', { class: 'pt-lockup' }, [
          brandMark(),
          el('h1', { class: 'pt-wordmark', text: 'Photournament' })
        ]),
        el('p', { class: 'muted', text:
          'Point it at a folder of photos. It cuts the field down with quota-enforced grid ' +
          'passes, then ranks what survives head to head.' })
      ]));

      // The webkitdirectory input is the workhorse. It preserves the folder tree,
      // works on every Chromium build and on a file:// origin, and needs no
      // permission grant. showDirectoryPicker is strictly an upgrade on top for
      // writing results back to disk — never a prerequisite for getting started.
      var dirInput = el('input', { type: 'file', id: 'dir-files', multiple: true, style: 'display:none' });
      dirInput.setAttribute('webkitdirectory', '');

      var looseInput = el('input', {
        type: 'file', id: 'loose-files', multiple: true, accept: 'image/*', style: 'display:none'
      });

      var drop = el('div', { class: 'dropzone', id: 'dropzone' }, [
        el('div', { class: 'dropzone-inner' }, [
          el('div', { class: 'drop-title', text: 'Drop a folder here' }),
          el('div', { class: 'muted small', text: 'or' }),
          el('button', { class: 'btn btn-primary', id: 'pick-folder', text: 'Choose a folder' }),
          el('div', { class: 'small dim', id: 'fallback-note' })
        ])
      ]);

      var extras = el('div', { class: 'row small' }, [
        dirInput, looseInput,
        el('button', {
          class: 'btn btn-quiet btn-sm', id: 'pick-files', text: 'Pick individual files instead',
          onclick: function () { looseInput.click(); }
        })
      ]);

      root.appendChild(drop);
      root.appendChild(extras);
      root.appendChild(el('div', { id: 'entry-msg' }));
      root.appendChild(el('div', { class: 'small dim', id: 'entry-diag', style: 'margin-top:14px' }));

      // The topbar is hidden on this screen, so the theme control needs a home
      // here too — otherwise the surround cannot be chosen until after ingest.
      root.appendChild(el('div', { class: 'row', style: 'margin-top:10px' }, [
        PT.theme.attach(el('button', { class: 'btn btn-quiet btn-sm', type: 'button' }))
      ]));

      /**
       * One button that always works. It reaches for the File System Access API
       * first because that is what unlocks writing finalists back to disk, but
       * ANY failure other than the user cancelling falls straight through to the
       * directory input rather than dead-ending on an error message.
       */
      PT.dom.$('#pick-folder').addEventListener('click', function () {
        if (!PT.env.hasFSA || typeof window.showDirectoryPicker !== 'function') {
          dirInput.click();
          return;
        }
        var p;
        try {
          p = window.showDirectoryPicker({ mode: 'readwrite' });
        } catch (e) {
          fallbackToInput(e);
          return;
        }
        Promise.resolve(p)
          .then(function (handle) { beginFromHandle(handle); })
          .catch(function (e) {
            // A cancelled dialog is an ordinary outcome, not a failure.
            if (e && e.name === 'AbortError') return;
            fallbackToInput(e);
          });
      });

      function fallbackToInput(e) {
        var name = (e && e.name) || 'Error';
        var msg = (e && e.message) || String(e);
        PT.dom.clear(PT.dom.$('#entry-msg')).appendChild(
          el('div', { class: 'notice notice-warn small', html:
            '<b>This browser would not open its folder picker here (' + name + ').</b><br>' +
            'Opening the ordinary folder chooser instead. Everything works the same, except ' +
            'finalists have to be downloaded rather than written back into the folder.' +
            '<br><span class="dim">' + escapeHtml(msg) + '</span>' })
        );
        PT.env.fsaBlocked = true;
        renderDiag();
        dirInput.click();
      }

      looseInput.addEventListener('change', function (ev) {
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

      renderDiag();
      wireDragDrop(drop);

      /** Visible environment readout, so a failure here is diagnosable rather than mysterious. */
      function renderDiag() {
        var host = PT.dom.$('#entry-diag');
        if (!host) return;
        var bits = [
          'opened from ' + location.protocol.replace(':', ''),
          (PT.env.hasFSA ? 'folder picker available' : 'no folder picker in this browser'),
          (PT.env.fsaBlocked ? 'picker blocked here — using the fallback' : null),
          navigator.hardwareConcurrency ? navigator.hardwareConcurrency + ' cores' : null
        ].filter(Boolean);
        host.textContent = bits.join('  ·  ');
      }
    },

    unmount: function () {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }

  function swallow(e) { e.preventDefault(); }

  function wireDragDrop(drop) {
    // Without these, dropping anywhere navigates the tab to the dropped file.
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);

    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });

    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.classList.remove('over');

      // DataTransfer is only valid synchronously during the event, so everything
      // needed later has to be pulled out of it right now.
      var dt = e.dataTransfer;
      var items = Array.prototype.slice.call(dt.items || []);
      var files = Array.prototype.slice.call(dt.files || []);

      var handlePromises = items.map(function (it) {
        return typeof it.getAsFileSystemHandle === 'function'
          ? it.getAsFileSystemHandle().catch(function () { return null; })
          : Promise.resolve(null);
      });
      var entries = items.map(function (it) {
        return typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
      }).filter(Boolean);

      PT.dom.clear(PT.dom.$('#entry-msg'));

      Promise.all(handlePromises).then(function (handles) {
        var dir = handles.filter(Boolean).filter(function (h) { return h.kind === 'directory'; })[0];
        if (dir) return beginFromHandle(dir);

        // THE FALLBACK THAT MATTERS. When the File System Access API is missing
        // or blocked, dataTransfer.files is EMPTY for a dropped folder, so
        // falling back to it can never work — which is exactly why dropping a
        // folder appeared to do nothing. webkitGetAsEntry is the older Chrome
        // API that does expose a dropped directory.
        var dirEntry = entries.filter(function (en) { return en && en.isDirectory; })[0];
        if (dirEntry) {
          var out = [];
          return walkEntry(dirEntry, out, 0).then(function () {
            if (!out.length) {
              showEntryError(new Error('That folder had no readable files in it.'));
              return;
            }
            beginFromEntries(out, dirEntry.name || 'photos');
          });
        }

        if (files.length) return beginFromFiles(files);

        showEntryError(new Error(
          'Nothing readable was dropped. Use the "Choose a folder" button instead — some ' +
          'browsers will not hand a dropped folder to a page that was opened from a file.'
        ));
      }).catch(showEntryError);
    });
  }

  /**
   * Recursively reads a dropped directory through the legacy entry API.
   * readEntries returns at most 100 children per call and signals the end with an
   * empty batch, so it must be drained in a loop rather than called once. An
   * unreadable entry resolves rather than rejecting: one bad file must never
   * stall the whole import.
   */
  function walkEntry(entry, out, depth) {
    depth = depth || 0;
    if (!entry || depth > 32) return Promise.resolve(out);

    if (entry.isFile) {
      return new Promise(function (resolve) {
        entry.file(function (f) {
          var rel = String(entry.fullPath || ('/' + f.name)).replace(/^\//, '');
          var i = rel.lastIndexOf('/');
          out.push({ name: f.name, path: rel, dir: i < 0 ? '' : rel.slice(0, i), file: f });
          resolve(out);
        }, function () { resolve(out); });
      });
    }

    if (entry.isDirectory) {
      // Never re-ingest our own output on a second run.
      if (/^_(finalists|sidecars)/.test(entry.name) || entry.name.charAt(0) === '.') {
        return Promise.resolve(out);
      }
      var reader = entry.createReader();
      var kids = [];
      return new Promise(function (resolve) {
        (function drain() {
          reader.readEntries(function (batch) {
            if (!batch || !batch.length) {
              var chain = Promise.resolve();
              kids.forEach(function (k) {
                chain = chain.then(function () { return walkEntry(k, out, depth + 1); });
              });
              chain.then(function () { resolve(out); });
              return;
            }
            kids = kids.concat(Array.prototype.slice.call(batch));
            drain();
          }, function () { resolve(out); });
        })();
      });
    }

    return Promise.resolve(out);
  }

  function showEntryError(e) {
    var host = PT.dom.$('#entry-msg');
    if (!host) return;
    PT.dom.clear(host).appendChild(
      el('div', { class: 'error-box', text: (e && e.message) || String(e) })
    );
  }

  /**
   * PRD 7.10: which files in the folder are not already in this session.
   *
   * Compares by FINGERPRINT, not by path — the fingerprint is content plus path,
   * size and mtime, so a file that was merely renamed still reads as new, and a
   * file that was moved is genuinely a different photo as far as PRD 4's
   * per-folder allocation is concerned.
   *
   * @param {FileSystemDirectoryHandle} dirHandle
   * @param {Object} known  id -> photo record
   * @returns {Promise<Array<{name:string, path:string}>>}
   */
  PT.scanForNew = function (dirHandle, known) {
    return walkHandle(dirHandle, '', [], 0, null).then(function (entries) {
      var images = entries.filter(function (e) { return PT.isImageKind(PT.kindOf(e.name)); });
      var out = [];
      var chain = Promise.resolve();
      images.forEach(function (e) {
        chain = chain.then(function () {
          return e.handle.getFile()
            .then(function (file) { return PT.fingerprint(file, e.path); })
            .then(function (id) { if (!known[id]) out.push({ name: e.name, path: e.path }); })
            .catch(function () { /* an unreadable file is not a new one */ });
        });
      });
      return chain.then(function () { return out; });
    });
  };

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
    var session = PT.session.newSession(rootName || 'selected photos', 'files');
    PT.store.init({ session: session, photos: {}, derivatives: {}, tree: null, resolution: null });
    PT.router.go('ingest', { source: { type: 'files', files: files } });
  }

  /**
   * Entry point for a folder dropped without a File System Access handle. The
   * entries already carry their source-relative paths from walkEntry, so the
   * folder tree survives even though there is no directory handle to write into.
   */
  function beginFromEntries(entries, rootName) {
    var session = PT.session.newSession(rootName || 'dropped folder', 'files');
    PT.store.init({ session: session, photos: {}, derivatives: {}, tree: null, resolution: null });
    PT.router.go('ingest', { source: { type: 'entries', entries: entries } });
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

      root.classList.add('screen-ingest');

      // The mark walks while work is happening and resolves back into itself
      // when it stops, so the animation ending and the work ending are the same
      // event rather than two things the user has to correlate.
      var markSlot = workingMark();
      var settleMark = function () { markSlot.settle(); };

      var status = el('div', { class: 'muted', text: 'Reading the folder…' });
      var bar = el('div', { class: 'bar' }, [el('i', { style: 'width:0%' })]);
      var count = el('div', { class: 'ingest-count nums' });
      var detail = el('div', { class: 'small dim' });
      var summary = el('div', { id: 'ingest-summary' });
      var actions = el('div', { class: 'row', id: 'ingest-actions' });

      root.appendChild(el('div', { class: 'card screen-narrow' }, [
        el('div', { class: 'row' }, [markSlot, el('h1', { text: 'Reading photos' })]),
        status, count, bar, detail, summary, actions
      ]));

      var setProgress = function (done, total, note) {
        bar.firstChild.style.width = (total ? (done / total) * 100 : 0) + '%';
        count.textContent = done + ' / ' + total;
        detail.textContent = note || '';
      };

      var scan = params.source.type === 'handle'
        ? walkHandle(params.source.handle, '', [], 0, function (n) {
            status.textContent = 'Reading the folder… ' + n + ' files';
          })
        : params.source.type === 'entries'
          ? Promise.resolve(params.source.entries)
          : Promise.resolve(fromFileList(params.source.files));

      scan
        .then(function (entries) {
          var t = triage(entries);
          renderTriage(summary, t, entries.length);

          if (!t.images.length) {
            status.textContent = 'No photos found here.';
            settleMark();
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
              settleMark();
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
          settleMark();
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

    // Without this the worker falls back to its own inlined dHash while still
    // writing the result to a field called `phash`, so everything calibrated for
    // pHash — notably the threshold of 14 — is quietly measuring the wrong hash
    // family. The shim exists because a Worker has no `window` and 20_phash.js
    // attaches to it.
    var phashSrc = null;
    var phashNode = document.getElementById('phash-src');
    if (phashNode && phashNode.textContent && phashNode.textContent.length > 1000) {
      phashSrc = 'var window = self;\n' + phashNode.textContent;
    }

    var pool = PT.ingest.createPool({
      previewPx: PREVIEW_PX,
      libheifSrc: libheifSrc,
      libheifUrl: libheifSrc ? null : undefined,
      extraSrc: phashSrc
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
  * v1.1 (2026-07-28): Reworked entry after both folder paths failed for a real
 *   user. The Choose-a-folder button now falls through to the webkitdirectory
 *   input on any picker failure instead of dead-ending on an error, and drag-drop
 *   falls back to webkitGetAsEntry, because dataTransfer.files is EMPTY for a
 *   dropped folder and the old fallback therefore could never work. Added a
 *   visible environment readout so a failure here is diagnosable.
 * v1.2 (2026-07-28): Adopted photournament_ui_v2.0.css. Removed the injected
 *   style block, split the ingest count from its time estimate so the count can
 *   carry display size, and added the CSS-drawn nine-square mark.
 * v1.3 (2026-07-28): Feeds 20_phash.js into the ingest worker. Without it the
 *   worker fell back to its own inlined dHash while still writing the result to a
 *   field called `phash`, so everything calibrated for pHash — the threshold of
 *   14 above all — was quietly measuring the wrong hash family. Measured before:
 *   weights spread 30-37 and 55 of 120 distances odd. After: every weight exactly
 *   31, zero odd distances.
 * v1.4 (2026-07-28): Added PT.scanForNew for PRD 7.10, comparing by fingerprint
 *   rather than by path so a renamed file reads as new.
 * v1.5 (2026-07-28): The entry screen now shows the real recursive identity mark,
 *   referenced from the sprite defined once in the shell. The nine animated CSS
 *   cells stay as the ingest activity indicator — animating the identity artwork
 *   would turn a logo into a spinner.
 * v1.6 (2026-07-28): Theme control on the entry screen, where the topbar is
 *   hidden, and the brand mark now uses the plated sprite so it keeps its own
 *   ground in both themes.
 * v1.7 (2026-07-28): The throbber and the mark are one object. workingMark()
 *   stacks the nine walking cells over the brand mark on the sprite's own
 *   geometry and cross-fades between them, so the logo flattens into the
 *   nine-cell grid while ingest runs and resolves back when it finishes.
*/
