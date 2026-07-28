/**
 * @file 00_core.js
 * @version 1.1
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description Core runtime for Photournament: global namespace, event bus, observable store, IndexedDB wrapper, file fingerprinting, DOM helpers, and the screen router.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * Loaded first. Every other module assumes PT, PT.bus, PT.store, PT.db and PT.dom exist.
 *
 * Runtime constraints this file is written against, all measured (see
 * tools/probes/01_capability_matrix/FINDINGS.md):
 *   - The page may be opened from file://, where window.origin is the opaque string "null".
 *   - fetch(), XHR, module scripts with src, and relative-URL Workers are ALL CORS-blocked there.
 *     Nothing in this file may load anything by URL.
 *   - IndexedDB works fully on file:// and survives a browser restart, so it carries all persistence.
 *   - Every file:// page in a Chrome profile shares ONE origin bucket named file__0. There is no
 *     per-file isolation and the quota is shared with every other local HTML tool the user has open,
 *     so the database name is explicitly namespaced.
 *   - storage.persist() returns false even on localhost in a fresh profile. The cache is therefore
 *     EVICTABLE: everything cached here must be re-derivable from the originals on disk.
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});

  PT.VERSION = '0.2';

  /* ---------------------------------------------------------------- logging */

  var LOG_ON = true;
  PT.log = function (scope) {
    if (!LOG_ON) return;
    var rest = Array.prototype.slice.call(arguments, 1);
    console.log.apply(console, ['[' + scope + ']'].concat(rest));
  };
  PT.warn = function (scope) {
    var rest = Array.prototype.slice.call(arguments, 1);
    console.warn.apply(console, ['[' + scope + ']'].concat(rest));
  };
  PT.setLogging = function (on) { LOG_ON = !!on; };

  /* -------------------------------------------------------------- event bus */

  /**
   * Fire-and-forget pub/sub. Used for cross-module notifications that are not
   * state changes (progress ticks, screen transitions, toasts). Anything that
   * IS state belongs in the store instead, so it persists and replays.
   */
  var listeners = Object.create(null);

  PT.bus = {
    /** @returns {function():void} unsubscribe */
    on: function (name, fn) {
      (listeners[name] || (listeners[name] = [])).push(fn);
      return function () { PT.bus.off(name, fn); };
    },
    once: function (name, fn) {
      var un = PT.bus.on(name, function (d) { un(); fn(d); });
      return un;
    },
    off: function (name, fn) {
      var a = listeners[name];
      if (!a) return;
      var i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    emit: function (name, detail) {
      var a = listeners[name];
      if (!a) return;
      // Copy: a handler may unsubscribe during dispatch.
      a.slice().forEach(function (fn) {
        try { fn(detail); } catch (e) { PT.warn('bus', 'handler for "' + name + '" threw', e); }
      });
    }
  };

  /* ------------------------------------------------------------------ store */

  /**
   * Single source of truth. Mutations go through dispatch(name, mutatorFn) so that
   * every change has a name, subscribers fire once, and persistence is automatic
   * rather than something each screen has to remember.
   *
   * The decision JSON of PRD 7.8 falls out of the action log rather than being
   * assembled separately at export time.
   */
  var state = null;
  var subs = [];
  var actionLog = [];
  var saveTimer = null;
  var SAVE_DEBOUNCE_MS = 400;

  PT.store = {
    get: function () { return state; },

    init: function (initial) {
      state = initial;
      actionLog = [];
      subs.slice().forEach(function (fn) { fn(state, '@init'); });
    },

    /**
     * @param {string} name  action name, recorded in the log
     * @param {function(object):void} fn  mutates state in place
     * @param {{silent?:boolean, transient?:boolean}} [opts]
     *        silent    - do not notify subscribers (batching)
     *        transient - do not record in the action log or trigger a save
     *                    (use for high-frequency UI-only changes like hover)
     */
    dispatch: function (name, fn, opts) {
      opts = opts || {};
      if (!state) throw new Error('PT.store.dispatch before init');
      fn(state);
      if (!opts.transient) {
        actionLog.push({ t: Date.now(), a: name });
        scheduleSave();
      }
      if (!opts.silent) {
        subs.slice().forEach(function (s) {
          try { s(state, name); } catch (e) { PT.warn('store', 'subscriber threw on "' + name + '"', e); }
        });
      }
    },

    subscribe: function (fn) {
      subs.push(fn);
      return function () {
        var i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },

    actionLog: function () { return actionLog.slice(); },

    /** Force an immediate write, bypassing the debounce. Called before unload. */
    flush: function () {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      return persist();
    }
  };

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; persist(); }, SAVE_DEBOUNCE_MS);
  }

  function persist() {
    if (!state || !state.session) return Promise.resolve();
    // Photo Blobs live in their own store keyed by id; the session record holds
    // only structured data, so a save stays small and fast even at 500 photos.
    var snapshot = PT.serializeSession ? PT.serializeSession(state) : state.session;
    return PT.db.put('sessions', snapshot).catch(function (e) {
      PT.warn('store', 'persist failed', e);
    });
  }

  /* --------------------------------------------------------------- indexeddb */

  /**
   * Namespaced because every file:// page shares the single file__0 origin bucket
   * with every other local tool the user has ever opened.
   */
  var DB_NAME = 'photournament/v1';
  var DB_VERSION = 1;

  var STORES = {
    sessions:    { keyPath: 'id' },
    photos:      { keyPath: 'id' },   // photo records minus Blobs
    derivatives: { keyPath: 'id' },   // {id, thumb: Blob, preview: Blob, sidecar: Blob|null}
    handles:     { keyPath: 'key' }   // {key, handle} — FileSystemDirectoryHandle, structured-cloneable
  };

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        Object.keys(STORES).forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, STORES[name]);
          }
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { PT.warn('db', 'open blocked by another tab'); };
    });
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, mode);
        var store = t.objectStore(storeName);
        var out;
        try { out = fn(store); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  PT.db = {
    name: DB_NAME,

    get: function (store, key) {
      return tx(store, 'readonly', function (s) { return s.get(key); });
    },
    put: function (store, value) {
      return tx(store, 'readwrite', function (s) { return s.put(value); });
    },
    /** Writes many records in ONE transaction — materially faster at 500 photos. */
    putAll: function (store, values) {
      return tx(store, 'readwrite', function (s) {
        values.forEach(function (v) { s.put(v); });
        return values.length;
      });
    },
    del: function (store, key) {
      return tx(store, 'readwrite', function (s) { return s.delete(key); });
    },
    clear: function (store) {
      return tx(store, 'readwrite', function (s) { return s.clear(); });
    },
    all: function (store) {
      return tx(store, 'readonly', function (s) { return s.getAll(); });
    },
    keys: function (store) {
      return tx(store, 'readonly', function (s) { return s.getAllKeys(); });
    },

    /**
     * Cache size for PRD section 8's "show cache size, offer clear-cache" mitigation.
     * usageDetails.indexedDB is the honest number; quota tracks free disk.
     */
    usage: function () {
      if (!navigator.storage || !navigator.storage.estimate) {
        return Promise.resolve({ usage: 0, quota: 0, idb: 0, supported: false });
      }
      return navigator.storage.estimate().then(function (e) {
        return {
          usage: e.usage || 0,
          quota: e.quota || 0,
          idb: (e.usageDetails && e.usageDetails.indexedDB) || 0,
          supported: true
        };
      });
    },

    /**
     * Best-effort. Measured to return false even on localhost in a fresh profile,
     * so callers must treat a false result as normal, not as an error.
     */
    requestPersistence: function () {
      if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(false);
      return navigator.storage.persist().catch(function () { return false; });
    }
  };

  /* ------------------------------------------------------------ fingerprint */

  /**
   * PRD 7.9: fingerprint each photo as hash + filename + byte size + last modified,
   * so cached derivatives and decisions re-associate on return.
   *
   * Only the first and last 64KB are hashed rather than the whole file. Reading
   * 500 x 3MB through crypto.subtle at ingest would cost more than the decode it
   * is meant to let us skip, and combined with exact size + mtime + name the
   * collision risk is not meaningful for a local photo folder.
   */
  var FP_CHUNK = 65536;

  PT.fingerprint = function (file, path) {
    var head = file.slice(0, Math.min(FP_CHUNK, file.size));
    var tail = file.size > FP_CHUNK ? file.slice(Math.max(0, file.size - FP_CHUNK)) : null;
    var parts = tail ? [head, tail] : [head];

    return Promise.all(parts.map(function (b) { return b.arrayBuffer(); }))
      .then(function (bufs) {
        var total = bufs.reduce(function (n, b) { return n + b.byteLength; }, 0);
        var merged = new Uint8Array(total);
        var off = 0;
        bufs.forEach(function (b) { merged.set(new Uint8Array(b), off); off += b.byteLength; });
        return crypto.subtle.digest('SHA-256', merged);
      })
      .then(function (digest) {
        var hex = Array.prototype.map
          .call(new Uint8Array(digest, 0, 12), function (b) { return ('0' + b.toString(16)).slice(-2); })
          .join('');
        // Path is included so the same file copied into two folders stays two
        // photos — PRD section 4 allocates by folder, so identity is per-location.
        return hex + '-' + hash32(path + '|' + file.size + '|' + file.lastModified);
      });
  };

  function hash32(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /* ----------------------------------------------------------------- format */

  var EXT_KIND = {
    jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg',
    png: 'png', webp: 'webp', gif: 'gif',
    heic: 'heic', heif: 'heic', hif: 'heic',

    // Out of scope but EXPECTED, and that distinction matters. A real phone-photo
    // folder is mostly video by weight — one measured set had 175 clips at 6GB
    // against 746 stills at 1.6GB. Lumping those in with corrupt files would
    // produce 175 alarming "unsupported" rows describing something entirely
    // normal, so video and raw are named categories that get counted and
    // reported, not errors. PRD 9 puts both out of scope for v1.
    mp4: 'video', mov: 'video', m4v: 'video', avi: 'video', mkv: 'video',
    webm: 'video', mpg: 'video', mpeg: 'video', '3gp': 'video', wmv: 'video',

    cr2: 'raw', cr3: 'raw', nef: 'raw', arw: 'raw', dng: 'raw',
    raf: 'raw', orf: 'raw', rw2: 'raw', pef: 'raw', srw: 'raw'
  };

  /** PRD 7.9: flag unsupported files at load rather than dropping them silently. */
  PT.kindOf = function (filename) {
    var m = /\.([A-Za-z0-9]+)$/.exec(filename || '');
    if (!m) return 'unsupported';
    return EXT_KIND[m[1].toLowerCase()] || 'unsupported';
  };

  /**
   * GIF is included because it decodes natively in Chromium and real folders
   * contain a few. Only the first frame is used; nothing here animates.
   */
  PT.isImageKind = function (kind) {
    return kind === 'jpeg' || kind === 'png' || kind === 'webp' || kind === 'gif' || kind === 'heic';
  };

  /** Recognised, deliberately not culled. Reported as a count, never as an error. */
  PT.isSkippedKind = function (kind) {
    return kind === 'video' || kind === 'raw';
  };

  PT.KIND_LABEL = {
    jpeg: 'JPEG', png: 'PNG', webp: 'WebP', gif: 'GIF', heic: 'HEIC',
    video: 'video', raw: 'RAW', unsupported: 'unrecognised'
  };

  /* ------------------------------------------------------------ dom helpers */

  PT.dom = {
    el: function (tag, attrs, children) {
      var n = document.createElement(tag);
      if (attrs) {
        Object.keys(attrs).forEach(function (k) {
          var v = attrs[k];
          if (v == null || v === false) return;
          if (k === 'class') n.className = v;
          else if (k === 'text') n.textContent = v;
          else if (k === 'html') n.innerHTML = v;
          else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2).toLowerCase(), v);
          else if (k === 'dataset') Object.keys(v).forEach(function (d) { n.dataset[d] = v[d]; });
          else n.setAttribute(k, v === true ? '' : v);
        });
      }
      (children || []).forEach(function (c) {
        if (c == null) return;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
      return n;
    },
    $: function (sel, root) { return (root || document).querySelector(sel); },
    $$: function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); },
    clear: function (node) { while (node.firstChild) node.removeChild(node.firstChild); return node; },

    /**
     * Object URLs are revoked on replacement. At 500 photos, leaking one per
     * thumbnail keeps every Blob alive and defeats the bounded-memory strategy
     * PRD section 8 depends on.
     */
    setImg: function (img, blob) {
      var old = img._ptUrl;
      if (!blob) {
        img.removeAttribute('src');
        img._ptUrl = null;
        if (old) URL.revokeObjectURL(old);
        return;
      }
      var url = URL.createObjectURL(blob);
      img._ptUrl = url;
      img.src = url;
      // Safe now: the element no longer references the old URL.
      if (old) URL.revokeObjectURL(old);
    },

    /**
     * Detaches the source BEFORE revoking. Revoking a URL that an <img> is still
     * decoding aborts that load, and on a file:// origin the aborted request
     * surfaces as "Not allowed to load local resource: blob:null/..." in the
     * console. Clearing src first cancels the load cleanly instead.
     *
     * This matters because screens re-render faster than large previews decode,
     * so the race is the normal case rather than an edge one.
     */
    releaseImg: function (img) {
      if (!img || !img._ptUrl) return;
      var url = img._ptUrl;
      img._ptUrl = null;
      img.removeAttribute('src');
      URL.revokeObjectURL(url);
    }
  };

  PT.fmt = {
    bytes: function (n) {
      if (!n) return '0 B';
      var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
    },
    pct: function (x) { return Math.round(x * 100) + '%'; },
    duration: function (ms) {
      var s = Math.round(ms / 1000);
      if (s < 60) return s + 's';
      var m = Math.floor(s / 60);
      return m + 'm ' + (s % 60) + 's';
    },
    /** Zero-padded ordinal for PRD 7.8 export prefixes. */
    ordinal: function (n, total) {
      var width = Math.max(2, String(total || 0).length);
      return ('0000' + n).slice(-width);
    }
  };

  /* ----------------------------------------------------------------- router */

  /**
   * Screens are registered by name and own one container element. Only one is
   * mounted at a time; the previous screen's unmount() must release object URLs
   * and detach listeners, which is what keeps memory flat across stage changes.
   */
  var screens = Object.create(null);
  var current = null;

  PT.router = {
    register: function (name, def) { screens[name] = def; },

    go: function (name, params) {
      var next = screens[name];
      if (!next) throw new Error('unknown screen: ' + name);
      if (current && current.def.unmount) {
        try { current.def.unmount(current.root); } catch (e) { PT.warn('router', 'unmount threw', e); }
      }
      var host = PT.dom.$('#screen');
      PT.dom.clear(host);
      var root = PT.dom.el('div', { class: 'screen screen-' + name });
      host.appendChild(root);
      current = { name: name, def: next, root: root, params: params || {} };
      document.body.dataset.screen = name;
      PT.bus.emit('screen:change', { name: name, params: params || {} });
      try {
        next.mount(root, params || {});
      } catch (e) {
        PT.warn('router', 'mount threw for ' + name, e);
        root.appendChild(PT.dom.el('div', { class: 'error-box', text: 'This screen failed to load: ' + e.message }));
      }
      return current;
    },

    current: function () { return current ? current.name : null; },
    params: function () { return current ? current.params : {}; },
    /** Re-run mount with the same params, e.g. after a settings change. */
    refresh: function () { if (current) PT.router.go(current.name, current.params); }
  };

  /* ------------------------------------------------------------------ boot */

  PT.ready = function (fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  };

  // A mid-pass Stage A position is worth more than the few ms this costs.
  window.addEventListener('beforeunload', function () { PT.store.flush(); });

  PT.env = {
    isFileOrigin: location.protocol === 'file:',
    hasFSA: typeof window.showDirectoryPicker === 'function',
    cores: navigator.hardwareConcurrency || 4,
    /**
     * Disk write and resume need a directory handle, which needs the File System
     * Access API. Loose dragged files degrade to a session-only run — PRD section 8
     * requires that be stated plainly rather than failing quietly.
     */
    canPersistToDisk: function () { return PT.env.hasFSA; }
  };

  PT.log('core', 'ready', {
    version: PT.VERSION,
    origin: location.protocol,
    fsa: PT.env.hasFSA,
    cores: PT.env.cores
  });
})();

/** CHANGELOG
 * v1.0 (2026-07-28): Initial release. Namespace, event bus, observable store with
 *   named actions and debounced persistence, IndexedDB wrapper with a namespaced
 *   database, chunked file fingerprinting, format classification, DOM and format
 *   helpers, and the screen router.
  * v1.1 (2026-07-28): Added video, RAW and GIF to format classification so a real
 *   phone-photo folder triages correctly, with isSkippedKind separating expected
 *   out-of-scope files from genuinely unrecognised ones. Fixed a use-after-revoke
 *   race in dom.releaseImg: revoking an object URL while an <img> was still
 *   decoding aborted the load, surfacing on a file:// origin as "Not allowed to
 *   load local resource". src is now detached before revoking.
*/
