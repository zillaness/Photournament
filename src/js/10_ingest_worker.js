/**
 * @file 10_ingest_worker.js
 * @version 1.0
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description PRD 7.9 ingest: a blob-URL worker pool that decodes JPEG/PNG/WebP/HEIC off the main thread and emits thumbnails, previews, perceptual hashes, sharpness scores and stable fingerprints.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 */

/* eslint-env browser */
/* global PT */
(function (global) {
  'use strict';

  var PT = (global.PT = global.PT || {});
  var ingest = (PT.ingest = PT.ingest || {});

  function log() {
    if (typeof PT.log === 'function') {
      try {
        PT.log.apply(PT, ['ingest'].concat(Array.prototype.slice.call(arguments)));
      } catch (e) {
        /* logging must never break ingest */
      }
    }
  }
  function emit(name, detail) {
    if (PT.bus && typeof PT.bus.emit === 'function') {
      try {
        PT.bus.emit(name, detail);
      } catch (e) {
        /* a listener throwing must not abort the pool */
      }
    }
  }

  // =========================================================================
  // SHARED CODE
  //
  // This function is installed on the main thread AND stringified into the
  // worker source, so format sniffing, orientation parsing and fingerprinting
  // are byte-identical in both places. A fingerprint that differed between the
  // two would silently break resume (PRD 7.10), so they must not be two
  // implementations that merely look the same.
  //
  // It must not close over anything outside itself.
  // =========================================================================
  function PT_INGEST_SHARED(g) {
    'use strict';
    var H = {};
    g.__PTI = H;

    H.MAX_PIXELS = 200e6; // refuse absurd dimensions rather than OOM the tab

    // ---- format sniffing -------------------------------------------------
    // Magic bytes, never the extension. PRD 7.9 requires unsupported files be
    // flagged rather than dropped, and a .txt renamed to .jpg must be caught.
    var HEIF_BRANDS = {
      heic: 1, heix: 1, heim: 1, heis: 1, hevc: 1, hevx: 1, hevm: 1, hevs: 1,
      mif1: 1, msf1: 1, miaf: 1, mia1: 1
    };
    H.sniff = function (u8) {
      var n = u8.length;
      if (n >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return { kind: 'jpeg', format: 'jpeg' };
      if (n >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 &&
          u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a) return { kind: 'png', format: 'png' };
      if (n >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
          u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return { kind: 'webp', format: 'webp' };
      if (n >= 12 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
        var brand = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
        if (HEIF_BRANDS[brand]) return { kind: 'heic', format: 'heic:' + brand };
        if (brand === 'avif' || brand === 'avis') return { kind: 'unsupported', format: 'avif' };
        return { kind: 'unsupported', format: 'iso-bmff:' + brand };
      }
      if (n >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return { kind: 'unsupported', format: 'gif' };
      if (n >= 2 && u8[0] === 0x42 && u8[1] === 0x4d) return { kind: 'unsupported', format: 'bmp' };
      if (n >= 4 && ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 0x2a) || (u8[0] === 0x4d && u8[1] === 0x4d && u8[3] === 0x2a)))
        return { kind: 'unsupported', format: 'tiff' };
      if (n === 0) return { kind: 'unsupported', format: 'empty' };
      return { kind: 'unsupported', format: 'unrecognised' };
    };

    // ---- EXIF ------------------------------------------------------------
    // Reads only tag 0x0112 (Orientation) out of IFD0. Deliberately tiny: a
    // general EXIF parser is not needed and is a much bigger attack surface on
    // malformed files.
    H.exifOrientationFromTiff = function (u8, tiffStart) {
      try {
        if (tiffStart + 8 > u8.length) return 0;
        var le;
        if (u8[tiffStart] === 0x49 && u8[tiffStart + 1] === 0x49) le = true;
        else if (u8[tiffStart] === 0x4d && u8[tiffStart + 1] === 0x4d) le = false;
        else return 0;
        var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        if (dv.getUint16(tiffStart + 2, le) !== 42) return 0;
        var ifd = tiffStart + dv.getUint32(tiffStart + 4, le);
        if (ifd + 2 > u8.length) return 0;
        var count = dv.getUint16(ifd, le);
        if (count > 1024) return 0;
        for (var i = 0; i < count; i++) {
          var e = ifd + 2 + i * 12;
          if (e + 12 > u8.length) return 0;
          if (dv.getUint16(e, le) === 0x0112) {
            var v = dv.getUint16(e + 8, le);
            return v >= 1 && v <= 8 ? v : 0;
          }
        }
      } catch (err) {
        /* malformed EXIF is not an ingest failure */
      }
      return 0;
    };

    H.jpegOrientation = function (u8) {
      // Walk JPEG markers looking for APP1/Exif. Bounded to the header region;
      // EXIF never legitimately appears after the first few segments.
      var p = 2;
      var limit = Math.min(u8.length, 4 * 1024 * 1024);
      while (p + 4 <= limit) {
        if (u8[p] !== 0xff) { p++; continue; }
        var marker = u8[p + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
        if (marker === 0xda || marker === 0xd9) break; // start of scan / end
        var len = (u8[p + 2] << 8) | u8[p + 3];
        if (len < 2) break;
        if (marker === 0xe1 && p + 4 + 6 <= u8.length &&
            u8[p + 4] === 0x45 && u8[p + 5] === 0x78 && u8[p + 6] === 0x69 && u8[p + 7] === 0x66 &&
            u8[p + 8] === 0x00) {
          var o = H.exifOrientationFromTiff(u8, p + 10);
          if (o) return o;
        }
        p += 2 + len;
      }
      return 0;
    };

    // ---- ISO-BMFF / HEIF -------------------------------------------------
    H.bmffChildren = function (u8, start, end) {
      var out = [];
      var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      var off = start;
      var guard = 0;
      while (off + 8 <= end && guard++ < 4096) {
        var size = dv.getUint32(off);
        var type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
        var hdr = 8;
        if (size === 1) {
          if (off + 16 > end) break;
          size = Number(dv.getBigUint64(off + 8));
          hdr = 16;
        } else if (size === 0) size = end - off;
        if (size < hdr || off + size > end) break;
        out.push({ off: off, size: size, type: type, body: off + hdr });
        off += size;
      }
      return out;
    };

    // Returns {orientation, hasTransform, transform:{irot,imir}} for a HEIF file.
    // hasTransform is the important one: libheif applies irot/imir itself, so a
    // file that carries them must NOT also have EXIF orientation applied on top.
    H.heifMeta = function (u8) {
      var res = { orientation: 0, hasTransform: false, irot: 0, imir: -1 };
      try {
        var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        var top = H.bmffChildren(u8, 0, u8.length);
        var meta = null;
        for (var i = 0; i < top.length; i++) if (top[i].type === 'meta') meta = top[i];
        if (!meta) return res;
        var kids = H.bmffChildren(u8, meta.body + 4, meta.off + meta.size); // meta is a FullBox
        var iinf = null, iloc = null, iprp = null;
        for (var j = 0; j < kids.length; j++) {
          if (kids[j].type === 'iinf') iinf = kids[j];
          else if (kids[j].type === 'iloc') iloc = kids[j];
          else if (kids[j].type === 'iprp') iprp = kids[j];
        }

        // -- irot / imir, anywhere in ipco
        if (iprp) {
          var ip = H.bmffChildren(u8, iprp.body, iprp.off + iprp.size);
          for (var k = 0; k < ip.length; k++) {
            if (ip[k].type !== 'ipco') continue;
            var props = H.bmffChildren(u8, ip[k].body, ip[k].off + ip[k].size);
            for (var m = 0; m < props.length; m++) {
              if (props[m].type === 'irot') {
                res.irot = u8[props[m].body] & 3;
                if (res.irot) res.hasTransform = true;
              } else if (props[m].type === 'imir') {
                res.imir = u8[props[m].body] & 1;
                res.hasTransform = true;
              }
            }
          }
        }

        // -- locate the 'Exif' item via iinf, then its bytes via iloc
        if (!iinf || !iloc) return res;
        var exifId = -1;
        var iinfVer = u8[iinf.body];
        var ep = iinf.body + 4;
        var nEntries;
        if (iinfVer === 0) { nEntries = dv.getUint16(ep); ep += 2; } else { nEntries = dv.getUint32(ep); ep += 4; }
        var infes = H.bmffChildren(u8, ep, iinf.off + iinf.size);
        for (var q = 0; q < infes.length && q < nEntries + 4; q++) {
          var box = infes[q];
          if (box.type !== 'infe') continue;
          var ver = u8[box.body];
          if (ver < 2) continue;
          var b = box.body + 4;
          var itemId = ver === 2 ? dv.getUint16(b) : dv.getUint32(b);
          b += ver === 2 ? 2 : 4;
          b += 2; // protection index
          var itemType = String.fromCharCode(u8[b], u8[b + 1], u8[b + 2], u8[b + 3]);
          if (itemType === 'Exif') { exifId = itemId; break; }
        }
        if (exifId < 0) return res;

        var lp = iloc.body;
        var lver = u8[lp];
        lp += 4;
        var offsetSize = u8[lp] >> 4;
        var lengthSize = u8[lp] & 15;
        var baseOffsetSize = u8[lp + 1] >> 4;
        var indexSize = lver === 1 || lver === 2 ? u8[lp + 1] & 15 : 0;
        lp += 2;
        var itemCount;
        if (lver < 2) { itemCount = dv.getUint16(lp); lp += 2; } else { itemCount = dv.getUint32(lp); lp += 4; }
        var rd = function (o, n) {
          if (n === 0) return 0;
          if (n === 4) return dv.getUint32(o);
          if (n === 8) return Number(dv.getBigUint64(o));
          var v = 0;
          for (var z = 0; z < n; z++) v = v * 256 + u8[o + z];
          return v;
        };
        for (var it = 0; it < itemCount; it++) {
          var id = lver < 2 ? dv.getUint16(lp) : dv.getUint32(lp);
          lp += lver < 2 ? 2 : 4;
          var construction = 0;
          if (lver === 1 || lver === 2) { construction = dv.getUint16(lp) & 15; lp += 2; }
          lp += 2; // data_reference_index
          var base = rd(lp, baseOffsetSize);
          lp += baseOffsetSize;
          var extents = dv.getUint16(lp);
          lp += 2;
          for (var x = 0; x < extents; x++) {
            if (indexSize) lp += indexSize;
            var eo = rd(lp, offsetSize);
            lp += offsetSize;
            var el = rd(lp, lengthSize);
            lp += lengthSize;
            if (id === exifId && construction === 0 && x === 0) {
              var payload = base + eo;
              if (payload + 4 < u8.length) {
                // Exif item payload: 4-byte header offset, then the TIFF header.
                var skip = dv.getUint32(payload);
                var tiff = payload + 4 + skip;
                var o2 = H.exifOrientationFromTiff(u8, tiff);
                if (!o2) o2 = H.exifOrientationFromTiff(u8, payload + 4);
                if (o2) res.orientation = o2;
              }
              void el;
            }
          }
        }
      } catch (err) {
        /* orientation is best-effort; never fail an ingest over it */
      }
      return res;
    };

    // ---- fingerprint (PRD 7.9: hash + filename + byte size + last modified) --
    H.hex = function (buf) {
      var v = new Uint8Array(buf);
      var s = '';
      for (var i = 0; i < v.length; i++) s += (v[i] < 16 ? '0' : '') + v[i].toString(16);
      return s;
    };
    H.sha256Hex = function (bytes) {
      var ab;
      if (bytes instanceof ArrayBuffer) ab = bytes;
      else if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) ab = bytes.buffer;
      else ab = bytes.slice().buffer;
      return g.crypto.subtle.digest('SHA-256', ab).then(H.hex);
    };
    H.fingerprint = function (bytes, name, size, lastMod) {
      return H.sha256Hex(bytes).then(function (contentHash) {
        var meta = contentHash + '|' + String(name == null ? '' : name) + '|' + String(size) + '|' + String(lastMod || 0);
        return H.sha256Hex(new TextEncoder().encode(meta));
      });
    };

    // ---- perceptual hash (self-contained dhash) --------------------------
    // Inlined so the worker has no load-order dependency on 20_phash.js.
    // If a compatible PT.phash turns up at runtime it wins; see workerPhash.
    H.dhashFromGray = function (gray, gw, gh) {
      var W = 9, Hh = 8;
      var small = new Float32Array(W * Hh);
      for (var y = 0; y < Hh; y++) {
        for (var x = 0; x < W; x++) {
          // bilinear sample of the source grid
          var fx = ((x + 0.5) * gw) / W - 0.5;
          var fy = ((y + 0.5) * gh) / Hh - 0.5;
          var x0 = Math.floor(fx), y0 = Math.floor(fy);
          var tx = fx - x0, ty = fy - y0;
          var x1 = x0 + 1, y1 = y0 + 1;
          if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
          if (x1 > gw - 1) x1 = gw - 1; if (y1 > gh - 1) y1 = gh - 1;
          if (x0 > gw - 1) x0 = gw - 1; if (y0 > gh - 1) y0 = gh - 1;
          var a = gray[y0 * gw + x0], b = gray[y0 * gw + x1];
          var c = gray[y1 * gw + x0], d = gray[y1 * gw + x1];
          small[y * W + x] = a + (b - a) * tx + (c - a + (d - c - b + a) * tx) * ty;
        }
      }
      var bits = new Uint8Array(64);
      var i = 0;
      for (var yy = 0; yy < Hh; yy++) {
        for (var xx = 0; xx < W - 1; xx++) {
          bits[i++] = small[yy * W + xx] < small[yy * W + xx + 1] ? 1 : 0;
        }
      }
      var out = '';
      for (var n = 0; n < 64; n += 4) {
        out += ((bits[n] << 3) | (bits[n + 1] << 2) | (bits[n + 2] << 1) | bits[n + 3]).toString(16);
      }
      return out;
    };

    // ---- sharpness: variance of the Laplacian on a normalised grayscale ---
    H.sharpness = function (gray, w, h) {
      if (w < 3 || h < 3) return 0;
      var sum = 0, sum2 = 0, n = 0;
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var i = y * w + x;
          var l = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
          sum += l;
          sum2 += l * l;
          n++;
        }
      }
      if (!n) return 0;
      var mean = sum / n;
      return Math.round((sum2 / n - mean * mean) * 100) / 100;
    };

    H.grayFromRGBA = function (data, w, h) {
      var gray = new Float32Array(w * h);
      for (var i = 0, p = 0; i < gray.length; i++, p += 4) {
        gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      }
      return gray;
    };

    // ---- orientation maths -----------------------------------------------
    H.swapsAxes = function (o) { return o >= 5 && o <= 8; };

    // A 16x4 JPEG carrying EXIF Orientation=6, used as a runtime self-test for
    // whether createImageBitmap applies EXIF for us. It has to be measured, not
    // assumed: Chromium deprecated imageOrientation:'none' and now silently
    // treats it as 'from-image', which double-rotates anything that also
    // applies the transform by hand. 803 bytes.
    H.EXIF_PROBE_JPEG_B64 =
      '/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQ' +
      'EAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYA' +
      'AQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWF' +
      'laAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJD' +
      'AAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AA' +
      'ADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQA' +
      'AAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQ' +
      'BuAGMALgAgADIAMAAxADb/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKB' +
      'TmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fH' +
      'x8fHx8fHz/wAARCAAEABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAYEAEAAwEAAAAAAAAAAAAAAAAAB0WD' +
      'wv/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwBIVfpyjAB//9k=';
    H.EXIF_PROBE_UNROTATED = [16, 4];

    H.b64ToBlob = function (b64, type) {
      var bin = atob(b64);
      var u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return new Blob([u], { type: type });
    };

    // Applies the EXIF transform in DESTINATION space. w/h are the *scaled,
    // unrotated* draw dimensions; the canvas must already be sized
    // swapsAxes(o) ? (h,w) : (w,h).
    H.applyOrientation = function (ctx, o, w, h) {
      switch (o) {
        case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
        case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
        case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
        case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
        case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
        case 7: ctx.transform(0, -1, -1, 0, h, w); break;
        case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
        default: break;
      }
    };

    H.blankRecord = function (meta) {
      meta = meta || {};
      var path = meta.path || meta.name || '';
      var slash = path.lastIndexOf('/');
      return {
        id: meta.id || '',
        name: meta.name || (slash >= 0 ? path.slice(slash + 1) : path),
        path: path,
        dir: meta.dir != null ? meta.dir : slash > 0 ? path.slice(0, slash) : '',
        size: meta.size || 0,
        lastMod: meta.lastMod || 0,
        kind: meta.kind || 'unsupported',
        w: 0,
        h: 0,
        thumb: null,
        preview: null,
        phash: null,
        sharp: null,
        err: null
      };
    };

    return H;
  }

  // =========================================================================
  // WORKER BODY
  //
  // Stringified via Function.prototype.toString and spawned from a blob URL,
  // because probe 01 proved new Worker('./x.js') is a SecurityError on file://
  // (opaque 'null' origin) while blob-URL workers are fine.
  //
  // It must not close over anything outside itself.
  // =========================================================================
  function PT_INGEST_WORKER(self) {
    'use strict';
    var H = self.__PTI;

    var cfg = {
      thumbPx: 320,
      previewPx: 1600,
      thumbQuality: 0.8,
      previewQuality: 0.85,
      libheifUrl: null,
      libheifSrc: null,
      askBeforeDecode: false,
      decodeTimeoutMs: 180000
    };

    // ONE HeifDecoder for the whole worker lifetime. Probe 02 measured that a
    // per-image decoder strands a heif_context in the Emscripten heap forever:
    // 6.35 MB per image, ~3.2 GB at 500 photos. The context is only released by
    // the NEXT decode() on the same instance, so the instance must be shared.
    var heifDecoder = null;
    var heifModule = null;
    var heifLoading = null;
    var heifError = null;

    // The libheif display() callback runs inside a setTimeout, so a throw in
    // there lands as an uncaught worker error rather than a rejection. Park the
    // active rejector here so the global error handler can fail the right job.
    var activeReject = null;

    function loadHeif() {
      if (heifLoading) return heifLoading;
      heifLoading = (function () {
        return Promise.resolve().then(function () {
          if (typeof self.libheif === 'undefined') {
            if (cfg.libheifSrc) {
              // Indirect eval so the bundle's top-level `var libheif` lands on
              // the worker global. new Function() would scope it away.
              (0, eval)(cfg.libheifSrc);
            } else if (cfg.libheifUrl) {
              // Must be absolute: inside a blob worker location.href is
              // blob:null/<uuid>, so a relative importScripts throws.
              self.importScripts(cfg.libheifUrl);
            } else {
              throw new Error('libheif not configured (no libheifUrl and no injected source)');
            }
          }
          var factory = self.libheif;
          if (typeof factory !== 'function') {
            throw new Error('libheif global is not the Emscripten MODULARIZE factory (got ' + typeof factory + ')');
          }
          // MODULARIZE: call the factory and await it. `new libheif.HeifDecoder()`
          // as shown in the libheif-js README throws "not a constructor".
          return factory();
        }).then(function (mod) {
          if (!mod || typeof mod.HeifDecoder !== 'function') throw new Error('libheif module exposes no HeifDecoder');
          heifModule = mod;
          heifDecoder = new mod.HeifDecoder();
          return mod;
        }).catch(function (e) {
          heifError = e && e.message ? e.message : String(e);
          throw e;
        });
      })();
      return heifLoading;
    }

    // One-shot: does createImageBitmap apply EXIF orientation for us? Measured,
    // not assumed, and only paid for when a file actually carries orientation.
    var exifProbe = null;
    var browserAppliesExif = null;
    function probeBrowserExif() {
      if (exifProbe) return exifProbe;
      exifProbe = createImageBitmap(H.b64ToBlob(H.EXIF_PROBE_JPEG_B64, 'image/jpeg'), { imageOrientation: 'from-image' })
        .then(function (bm) {
          var w = bm.width, h = bm.height;
          bm.close();
          // The probe is 16x4 with Orientation=6 (90 deg CW). If it comes back
          // 4x16 the browser rotated it and we must not rotate it again.
          browserAppliesExif = w === H.EXIF_PROBE_UNROTATED[1] && h === H.EXIF_PROBE_UNROTATED[0];
          return browserAppliesExif;
        })
        .catch(function () {
          browserAppliesExif = true; // safer to under-rotate than to double-rotate
          return true;
        });
      return exifProbe;
    }

    function fail(code, message) {
      var e = new Error(message);
      e.ptCode = code;
      return e;
    }

    function decodeHeic(u8) {
      return loadHeif().then(function () {
        // decode() never throws; an empty array means "not decodable".
        var images = heifDecoder.decode(u8);
        return Promise.resolve()
          .then(function () {
            if (!images || !images.length) throw fail('unsupported', 'HEIC decode produced no images (unsupported or corrupt container)');
            var img = images[0];
            var w = img.get_width();
            var h = img.get_height();
            if (!(w > 0 && h > 0)) throw fail('corrupt', 'HEIC reported invalid dimensions ' + w + 'x' + h);
            if (w * h > H.MAX_PIXELS) throw fail('too-large', 'HEIC is ' + w + 'x' + h + ', over the ' + H.MAX_PIXELS + ' pixel ceiling');
            var imageData;
            try {
              imageData = new ImageData(w, h);
            } catch (e) {
              throw fail('too-large', 'cannot allocate ' + w + 'x' + h + ' RGBA buffer: ' + (e && e.message));
            }
            return new Promise(function (resolve, reject) {
              var settled = false;
              var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                activeReject = null;
                reject(fail('timeout', 'HEIC decode did not complete within ' + cfg.decodeTimeoutMs + 'ms'));
              }, cfg.decodeTimeoutMs);
              activeReject = function (e) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                activeReject = null;
                reject(e);
              };
              try {
                img.display(imageData, function (out) {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  activeReject = null;
                  // THE error signal. A truncated HEIC parses its metadata and
                  // hands back a handle reporting full dimensions; the failure
                  // only surfaces as a null here.
                  if (!out) reject(fail('corrupt', 'HEIC pixel decode failed (display returned null) - file is truncated or corrupt'));
                  else resolve(out);
                });
              } catch (e) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                activeReject = null;
                reject(e);
              }
            });
          })
          .then(
            function (v) { freeAll(images); return v; },
            function (e) { freeAll(images); throw e; }
          );
      });
    }

    // EVERY handle in the array, not just [0]. A multi-image HEIC (thumbnail
    // pair, Live Photo, burst) returns several and each holds wasm memory.
    function freeAll(images) {
      if (!images) return;
      for (var i = 0; i < images.length; i++) {
        try { images[i].free(); } catch (e) { /* already freed */ }
      }
    }

    function ctx2d(canvas, readback) {
      return canvas.getContext('2d', { alpha: false, willReadFrequently: !!readback });
    }

    // Prefer a runtime-provided PT.phash when the host has injected 20_phash.js
    // via createPool({extraSrc}), but only when it actually returns the record
    // contract's 16-char lowercase hex. That module is owned by another agent
    // and may be absent, may be a bare function, or may be the namespace object
    // it currently is; none of those may become a load-order dependency here.
    function workerPhash(hashImageData, gray, w, h) {
      var P = self.PT && self.PT.phash;
      try {
        var v = null;
        if (typeof P === 'function') v = P(gray, w, h);
        else if (P && typeof P === 'object') {
          var fn = (P.RECOMMENDED_HASH && typeof P[P.RECOMMENDED_HASH] === 'function' && P[P.RECOMMENDED_HASH]) ||
            (typeof P.phash === 'function' && P.phash) ||
            (typeof P.dhash === 'function' && P.dhash);
          if (fn) v = fn(hashImageData);
        }
        if (typeof v === 'string' && /^[0-9a-f]{16}$/.test(v)) return v;
      } catch (e) { /* fall through to the inlined dhash */ }
      return H.dhashFromGray(gray, w, h);
    }

    function workerSharpness(sharpImageData, gray, w, h) {
      var P = self.PT && self.PT.phash;
      try {
        if (P && typeof P.sharpness === 'function') {
          var v = P.sharpness(sharpImageData);
          if (typeof v === 'number' && isFinite(v)) return v;
        }
      } catch (e) { /* fall through to the inlined variance-of-Laplacian */ }
      return H.sharpness(gray, w, h);
    }

    // Full-resolution source in -> thumbnail, preview, phash, sharpness out.
    // Only one of these runs per worker at a time and the bitmap is closed the
    // moment the preview exists, so at most `poolSize` full decodes coexist
    // (PRD 8: "500 full-resolution decodes cannot coexist").
    function derive(bitmap, orientation) {
      var sw = bitmap.width, sh = bitmap.height;
      var swap = H.swapsAxes(orientation);
      var ow = swap ? sh : sw, oh = swap ? sw : sh;

      var pScale = Math.min(1, cfg.previewPx / Math.max(ow, oh));
      var dw = Math.max(1, Math.round(sw * pScale));
      var dh = Math.max(1, Math.round(sh * pScale));
      var preview = new OffscreenCanvas(swap ? dh : dw, swap ? dw : dh);
      var pctx = ctx2d(preview, false);
      pctx.imageSmoothingEnabled = true;
      pctx.imageSmoothingQuality = 'high';
      pctx.fillStyle = '#ffffff';
      pctx.fillRect(0, 0, preview.width, preview.height);
      pctx.save();
      H.applyOrientation(pctx, orientation, dw, dh);
      pctx.drawImage(bitmap, 0, 0, dw, dh);
      pctx.restore();
      bitmap.close();

      var tScale = Math.min(1, cfg.thumbPx / Math.max(preview.width, preview.height));
      var thumb = new OffscreenCanvas(
        Math.max(1, Math.round(preview.width * tScale)),
        Math.max(1, Math.round(preview.height * tScale))
      );
      var tctx = ctx2d(thumb, true);
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(preview, 0, 0, thumb.width, thumb.height);

      // Same pass as the derivatives, per PRD 7.9.
      var tData = tctx.getImageData(0, 0, thumb.width, thumb.height);
      var tGray = H.grayFromRGBA(tData.data, thumb.width, thumb.height);
      var sharp = workerSharpness(tData, tGray, thumb.width, thumb.height);

      var hs = 32;
      var hc = new OffscreenCanvas(hs, hs);
      var hctx = ctx2d(hc, true);
      hctx.imageSmoothingEnabled = true;
      hctx.imageSmoothingQuality = 'high';
      hctx.drawImage(preview, 0, 0, hs, hs);
      var hData = hctx.getImageData(0, 0, hs, hs);
      var hGray = H.grayFromRGBA(hData.data, hs, hs);
      // The 320 px thumbnail goes to an external hasher (it does its own
      // downsampling); the 32x32 greyscale feeds the inlined dhash.
      var phash = workerPhash(tData, hGray, hs, hs);

      return Promise.all([
        preview.convertToBlob({ type: 'image/jpeg', quality: cfg.previewQuality }),
        thumb.convertToBlob({ type: 'image/jpeg', quality: cfg.thumbQuality })
      ]).then(function (blobs) {
        // Drop the backing stores immediately rather than waiting for GC.
        preview.width = preview.height = 0;
        thumb.width = thumb.height = 0;
        hc.width = hc.height = 0;
        return {
          w: ow,
          h: oh,
          preview: blobs[0],
          thumb: blobs[1],
          phash: phash,
          sharp: sharp,
          previewW: swap ? dh : dw,
          previewH: swap ? dw : dh
        };
      });
    }

    function ingestBytes(u8, blob) {
      var sniffed = H.sniff(u8);
      var out = { kind: sniffed.kind, format: sniffed.format, orientationSource: 'none', orientation: 1 };

      if (sniffed.kind === 'unsupported') {
        out.err = 'unsupported file format (' + sniffed.format + ')';
        return Promise.resolve(out);
      }

      var orientation = 1; // what the file declares
      var heif = null;
      if (sniffed.kind === 'heic') {
        heif = H.heifMeta(u8);
        // libheif applies irot/imir during decode (measured: an irot=1 fixture
        // comes back with its axes swapped and its pixels genuinely rotated).
        // So a file carrying them must have any EXIF Orientation ignored, or it
        // gets rotated twice.
        if (heif.hasTransform) {
          out.orientationSource = 'irot/imir, applied by libheif';
        } else if (heif.orientation > 1) {
          orientation = heif.orientation;
          out.orientationSource = 'heif-exif';
        }
        out.heif = heif;
      } else if (sniffed.kind === 'jpeg') {
        var jo = H.jpegOrientation(u8);
        if (jo > 1) { orientation = jo; out.orientationSource = 'jpeg-exif'; }
      }
      out.orientation = orientation;

      var gate = orientation > 1 && sniffed.kind !== 'heic' ? probeBrowserExif() : Promise.resolve(null);

      return gate
        .then(function () {
          // The transform WE still have to apply. For non-HEIC that is nothing
          // when the browser already did it; for HEIC it is always ours to do,
          // because libheif never looks at EXIF.
          var toApply = orientation;
          if (sniffed.kind !== 'heic' && orientation > 1 && browserAppliesExif) toApply = 1;
          out.orientationApplied = toApply;
          out.browserAppliesExif = browserAppliesExif;

          if (sniffed.kind === 'heic') {
            return decodeHeic(u8).then(function (imageData) {
              var p = createImageBitmap(imageData);
              // Drop our reference immediately. createImageBitmap keeps its own
              // until it settles, and holding both means 96 MB per worker for a
              // 12 MP image instead of 48 MB.
              imageData = null;
              return p.then(function (bm) { return [bm, toApply]; });
            });
          }
          return createImageBitmap(blob, { imageOrientation: 'from-image' })
            .then(function (bm) { return [bm, toApply]; })
            .catch(function (e) {
              throw fail('corrupt', 'decode failed: ' + (e && e.message ? e.message : String(e)));
            });
        })
        .then(function (pair) {
          var bitmap = pair[0];
          if (bitmap.width * bitmap.height > H.MAX_PIXELS) {
            bitmap.close();
            throw fail('too-large', 'image is ' + bitmap.width + 'x' + bitmap.height);
          }
          return derive(bitmap, pair[1]);
        })
        .then(function (d) {
          out.w = d.w; out.h = d.h;
          out.thumb = d.thumb; out.preview = d.preview;
          out.phash = d.phash; out.sharp = d.sharp;
          out.previewW = d.previewW; out.previewH = d.previewH;
          return out;
        })
        .catch(function (e) {
          out.err = (e && e.ptCode ? '[' + e.ptCode + '] ' : '') + (e && e.message ? e.message : String(e));
          return out;
        });
    }

    var pendingResume = Object.create(null);

    function handleJob(msg) {
      var jid = msg.jid;
      var blob = msg.file;
      var meta = msg.meta || {};
      var t0 = (self.performance && self.performance.now) ? self.performance.now() : Date.now();
      var u8 = null;

      return Promise.resolve()
        .then(function () { return blob.arrayBuffer(); })
        .then(function (buf) {
          u8 = new Uint8Array(buf);
          return H.fingerprint(u8, meta.name || blob.name || '', blob.size, meta.lastMod || blob.lastModified || 0);
        })
        .then(function (id) {
          if (!cfg.askBeforeDecode) return { id: id, skip: false };
          self.postMessage({ t: 'fp', jid: jid, id: id });
          return new Promise(function (resolve) {
            pendingResume[jid] = function (skip) { resolve({ id: id, skip: !!skip }); };
          });
        })
        .then(function (gate) {
          if (gate.skip) {
            u8 = null;
            return { skipped: true, id: gate.id };
          }
          return ingestBytes(u8, blob).then(function (r) {
            u8 = null;
            r.id = gate.id;
            return r;
          });
        })
        .then(function (r) {
          var t1 = (self.performance && self.performance.now) ? self.performance.now() : Date.now();
          r.ms = Math.round((t1 - t0) * 10) / 10;
          self.postMessage({ t: 'ok', jid: jid, res: r });
        })
        .catch(function (e) {
          self.postMessage({ t: 'ok', jid: jid, res: { err: '[fatal] ' + (e && e.message ? e.message : String(e)), kind: 'unsupported' } });
        });
    }

    self.addEventListener('error', function (ev) {
      // libheif's display() callback fires from a setTimeout, so a throw inside
      // it arrives here rather than as a rejected promise. Convert it into a
      // failure for the job that is actually running.
      if (activeReject) {
        var r = activeReject;
        activeReject = null;
        try { ev.preventDefault(); } catch (e) { /* not cancelable */ }
        r(fail('corrupt', 'decode threw: ' + (ev.message || 'unknown worker error')));
      }
    });

    self.addEventListener('message', function (ev) {
      var msg = ev.data;
      if (!msg || !msg.t) return;
      if (msg.t === 'cfg') {
        for (var k in msg.cfg) if (Object.prototype.hasOwnProperty.call(msg.cfg, k)) cfg[k] = msg.cfg[k];
        self.postMessage({ t: 'ready' });
      } else if (msg.t === 'job') {
        handleJob(msg);
      } else if (msg.t === 'resume') {
        var fn = pendingResume[msg.jid];
        delete pendingResume[msg.jid];
        if (fn) fn(msg.skip);
      } else if (msg.t === 'warm') {
        loadHeif().then(
          function () { self.postMessage({ t: 'warm', ok: true }); },
          function (e) { self.postMessage({ t: 'warm', ok: false, message: String(e && e.message || e) }); }
        );
      } else if (msg.t === 'diag') {
        self.postMessage({
          t: 'diag',
          heifLoaded: !!heifDecoder,
          heifError: heifError,
          // The wasm arena is the number that actually moves when the decoder
          // leaks; the JS heap barely reflects it.
          wasmHeapBytes: heifModule && heifModule.HEAPU8 ? heifModule.HEAPU8.length : null
        });
      }
    });

    self.postMessage({ t: 'boot' });
  }

  // =========================================================================
  // ASSEMBLY
  // =========================================================================
  PT_INGEST_SHARED(global); // main thread copy

  ingest.WORKER_SRC =
    '/* Photournament ingest worker (generated from 10_ingest_worker.js) */\n' +
    '(' + PT_INGEST_SHARED.toString() + ')(self);\n' +
    '(' + PT_INGEST_WORKER.toString() + ')(self);\n';

  // Host pages that inline the libheif bundle (the fully self-contained
  // single-file build) call this instead of pointing at a URL.
  ingest.libheifSrc = ingest.libheifSrc || null;
  ingest.setLibheifSource = function (text) {
    ingest.libheifSrc = text || null;
    return ingest.libheifSrc ? ingest.libheifSrc.length : 0;
  };
  ingest.DEFAULT_LIBHEIF_URL = 'assets/libheif-bundle.js';

  /**
   * PRD 7.9 fingerprint: content hash + filename + byte size + last modified,
   * folded into one 64-char hex id. Main-thread convenience; the pool computes
   * the identical value inside the worker so ingest never reads a file twice.
   * @param {File|Blob|FileSystemFileHandle} file
   * @returns {Promise<string>}
   */
  ingest.fingerprint = function (file) {
    return Promise.resolve()
      .then(function () {
        return file && typeof file.getFile === 'function' ? file.getFile() : file;
      })
      .then(function (f) {
        return f.arrayBuffer().then(function (buf) {
          return global.__PTI.fingerprint(new Uint8Array(buf), f.name || '', f.size, f.lastModified || 0);
        });
      });
  };

  ingest.blankRecord = function (meta) { return global.__PTI.blankRecord(meta); };

  /**
   * @param {object} [opts]
   * @param {number} [opts.size] worker count; defaults to min(hardwareConcurrency, 4).
   *   Probe 02 measured scaling stopping dead at the core count: 8 workers were
   *   no faster than 4 and doubled memory.
   * @param {string|null} [opts.libheifUrl] URL of libheif-bundle.js, resolved to
   *   absolute here on the main thread. null means "expect injected source".
   * @param {string} [opts.libheifSrc] the bundle's source text, for the inlined build.
   * @param {string} [opts.extraSrc] extra classic-script source prepended into the
   *   worker (e.g. 20_phash.js, so PT.phash is reachable in-worker).
   * @param {function} [opts.lookup] (id, meta) => record|null|Promise. Non-null
   *   short-circuits decoding entirely, which is how resume skips known photos.
   */
  /**
   * Probe 02 measured scaling stopping dead at the core count on a 4-core box —
   * 8 workers were no faster than 4 there. That measurement was read too
   * narrowly as "cap at 4", which leaves most of a 16-core machine idle on a
   * 742-photo ingest. Scale with the machine, leaving a core for the main
   * thread, and cap at 8 because each worker holds its own ~72MB wasm arena
   * once HEIC is involved.
   */
  function defaultPoolSize() {
    var cores = navigator.hardwareConcurrency || 4;
    return Math.max(2, Math.min(cores - 1, 8));
  }

  ingest.createPool = function (opts) {
    opts = opts || {};
    var hw = (global.navigator && global.navigator.hardwareConcurrency) || 4;
    var size = Math.max(1, opts.size || Math.min(hw, 4));

    var libheifSrc = opts.libheifSrc || ingest.libheifSrc || null;
    var libheifUrl = null;
    if (!libheifSrc) {
      var rel = opts.libheifUrl === undefined ? ingest.DEFAULT_LIBHEIF_URL : opts.libheifUrl;
      if (rel) {
        // Resolve here: inside a blob worker location.href is blob:null/<uuid>,
        // so the worker cannot resolve a relative path itself.
        try { libheifUrl = new URL(rel, global.location.href).href; } catch (e) { libheifUrl = rel; }
      }
    }

    var src = (opts.extraSrc ? opts.extraSrc + '\n' : '') + ingest.WORKER_SRC;
    var blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));

    var cfg = {
      thumbPx: opts.thumbPx || 320,
      previewPx: opts.previewPx || 1600,
      thumbQuality: opts.thumbQuality || 0.8,
      previewQuality: opts.previewQuality || 0.85,
      libheifUrl: libheifUrl,
      libheifSrc: libheifSrc,
      askBeforeDecode: typeof opts.lookup === 'function',
      decodeTimeoutMs: opts.decodeTimeoutMs || 180000
    };

    var workers = [];
    var idle = [];
    var queue = [];
    var jobs = Object.create(null);
    var seq = 0;
    var dead = false;
    var stat = { done: 0, failed: 0, skipped: 0, t0: 0, busyMs: 0 };

    function spawn() {
      var w = new Worker(blobUrl);
      w.__busy = null;
      w.onmessage = function (ev) { onMessage(w, ev.data); };
      w.onerror = function (ev) {
        log('worker error', ev.message);
        if (w.__busy) {
          var job = jobs[w.__busy];
          delete jobs[w.__busy];
          w.__busy = null;
          if (job) {
            job.rec.err = '[worker] ' + (ev.message || 'worker crashed');
            finish(job, w);
          }
        }
      };
      w.postMessage({ t: 'cfg', cfg: cfg });
      workers.push(w);
      idle.push(w);
      return w;
    }

    function finish(job, w) {
      if (job.rec.err) stat.failed++; else stat.done++;
      idle.push(w);
      job.resolve(job.rec);
      emit('ingest:photo', job.rec);
      emit('ingest:progress', pool.stats());
      pump();
    }

    function onMessage(w, msg) {
      if (!msg || !msg.t) return;
      if (msg.t === 'boot' || msg.t === 'ready') return;
      if (msg.t === 'fp') {
        var j = jobs[msg.jid];
        if (!j) return;
        j.rec.id = msg.id;
        Promise.resolve()
          .then(function () { return opts.lookup(msg.id, j.meta); })
          .then(function (cached) {
            if (cached) { j.cached = cached; w.postMessage({ t: 'resume', jid: msg.jid, skip: true }); }
            else w.postMessage({ t: 'resume', jid: msg.jid, skip: false });
          })
          .catch(function () { w.postMessage({ t: 'resume', jid: msg.jid, skip: false }); });
        return;
      }
      if (msg.t === 'ok') {
        var job = jobs[msg.jid];
        delete jobs[msg.jid];
        w.__busy = null;
        if (!job) return;
        var r = msg.res || {};
        var rec = job.rec;
        if (r.id) rec.id = r.id;
        if (r.skipped) {
          stat.skipped++;
          var c = job.cached || {};
          for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k) && c[k] !== undefined) rec[k] = c[k];
          rec.id = r.id || rec.id;
          rec.fromCache = true;
        } else {
          if (r.kind) rec.kind = r.kind;
          rec.w = r.w || 0;
          rec.h = r.h || 0;
          rec.thumb = r.thumb || null;
          rec.preview = r.preview || null;
          rec.phash = r.phash || null;
          rec.sharp = r.sharp === undefined ? null : r.sharp;
          rec.err = r.err || null;
          rec.format = r.format;
          rec.orientation = r.orientation;
          rec.orientationApplied = r.orientationApplied;
          rec.browserAppliesExif = r.browserAppliesExif;
          rec.orientationSource = r.orientationSource;
          rec.ms = r.ms;
        }
        finish(job, w);
      }
    }

    function pump() {
      while (!dead && idle.length && queue.length) {
        var w = idle.shift();
        var job = queue.shift();
        if (!stat.t0) stat.t0 = (global.performance || Date).now();
        job.worker = w;
        w.__busy = job.jid;
        jobs[job.jid] = job;
        w.postMessage({ t: 'job', jid: job.jid, file: job.file, meta: job.meta });
      }
    }

    for (var i = 0; i < size; i++) spawn();

    var pool = {
      size: size,
      libheifUrl: libheifUrl,
      libheifInline: !!libheifSrc,

      /**
       * @param {File|FileSystemFileHandle} input
       * @param {object} [meta] {path, dir, name, kind}
       * @returns {Promise<object>} a photo record
       */
      process: function (input, meta) {
        meta = meta || {};
        if (dead) return Promise.reject(new Error('pool terminated'));
        return Promise.resolve()
          .then(function () {
            return input && typeof input.getFile === 'function' ? input.getFile() : input;
          })
          .then(function (file) {
            if (!file || typeof file.arrayBuffer !== 'function') throw new Error('process() needs a File/Blob or FileSystemFileHandle');
            var m = {
              name: meta.name || file.name || '',
              path: meta.path || meta.name || file.name || '',
              dir: meta.dir,
              size: file.size,
              lastMod: meta.lastMod != null ? meta.lastMod : file.lastModified || 0,
              kind: meta.kind
            };
            var rec = global.__PTI.blankRecord(m);
            return new Promise(function (resolve) {
              queue.push({ jid: ++seq, file: file, meta: m, rec: rec, resolve: resolve, cached: null });
              pump();
            });
          });
      },

      /** Force the libheif load now instead of on the first HEIC. */
      warm: function () {
        return Promise.all(workers.map(function (w) {
          return new Promise(function (res) {
            var h = function (ev) {
              if (ev.data && ev.data.t === 'warm') { w.removeEventListener('message', h); res(ev.data); }
            };
            w.addEventListener('message', h);
            w.postMessage({ t: 'warm' });
          });
        }));
      },

      /** Per-worker wasm arena size and libheif state. Used by the memory probe. */
      diag: function () {
        return Promise.all(workers.map(function (w) {
          return new Promise(function (res) {
            var h = function (ev) {
              if (ev.data && ev.data.t === 'diag') { w.removeEventListener('message', h); res(ev.data); }
            };
            w.addEventListener('message', h);
            w.postMessage({ t: 'diag' });
          });
        }));
      },

      stats: function () {
        var now = (global.performance || Date).now();
        var elapsed = stat.t0 ? now - stat.t0 : 0;
        var handled = stat.done + stat.failed;
        return {
          done: stat.done,
          failed: stat.failed,
          skipped: stat.skipped,
          inFlight: Object.keys(jobs).length,
          queued: queue.length,
          msPerImage: handled ? Math.round((elapsed / handled) * 10) / 10 : 0
        };
      },

      terminate: function () {
        if (dead) return;
        dead = true;
        for (var i = 0; i < workers.length; i++) {
          try { workers[i].terminate(); } catch (e) { /* already gone */ }
        }
        workers.length = 0;
        idle.length = 0;
        for (var jid in jobs) {
          var j = jobs[jid];
          j.rec.err = '[terminated] ingest pool was shut down';
          j.resolve(j.rec);
        }
        jobs = Object.create(null);
        while (queue.length) {
          var q = queue.shift();
          q.rec.err = '[terminated] ingest pool was shut down';
          q.resolve(q.rec);
        }
        try { URL.revokeObjectURL(blobUrl); } catch (e) { /* already revoked */ }
        emit('ingest:terminated', null);
      }
    };

    log('pool up: ' + size + ' workers, libheif=' + (libheifSrc ? 'inline(' + libheifSrc.length + 'B)' : libheifUrl || 'none'));
    return pool;
  };
})(typeof self !== 'undefined' ? self : this);

/*
CHANGELOG
---------
v1.0 - 2026-07-28 - Samuel Cao
  Initial release. Blob-URL worker pool for PRD 7.9 ingest.
  - WORKER_SRC is built by stringifying two real functions rather than being a
    template literal, so the worker body stays lintable JS with no escaping.
  - Shared sniff/EXIF/fingerprint code is installed on both the main thread and
    inside the worker from one source, so fingerprints cannot drift apart.
  - One HeifDecoder per worker for its whole lifetime, and .free() on every
    handle decode() returns. Probe 02 measured 6.35 MB/image leaked when either
    half is missing (~3.2 GB at 500 photos).
  - libheif loads lazily on the first HEIC, from either an absolute importScripts
    URL (resolved on the main thread) or injected source text.
  - Ingest failure is detected on the display() callback receiving null, because
    a truncated HEIC returns a handle reporting valid dimensions.
  - Orientation: HEIF irot/imir is left to libheif (measured: an irot=1 fixture
    decodes with its axes swapped and its pixels genuinely rotated), and EXIF is
    suppressed when those boxes are present. For JPEG/PNG/WebP the worker runs a
    one-time 803-byte self-test to find out whether createImageBitmap already
    applies EXIF, because Chromium ignores imageOrientation:'none' and treats it
    as 'from-image' - applying the transform on top of that rotates twice.
  - PT.phash / PT.phash.sharpness are used when the host injects 20_phash.js via
    createPool({extraSrc}) and the result validates; otherwise the inlined dhash
    and variance-of-Laplacian are used. No load-order dependency either way.
  Measurements: tools/probes/03_pipeline/FINDINGS.md
*/
