/**
 * file: exif_fixture.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-10-30
 * last_updated: 2026-10-30
 * description: Builds real EXIF/TIFF, IPTC and XMP blocks and splices them into JPEG, PNG and WebP bytes, so capture-metadata tests run against the same byte layouts cameras write.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Writing the blocks by hand, rather than shipping camera files, keeps the
 * fixtures small, deterministic and free of anyone's real GPS position.
 */

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };

function rat(v) {
  // Six decimal places is finer than any camera writes.
  const den = 1000000;
  return [Math.round(v * den), den];
}

function dms(deg) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = (a - d - m / 60) * 3600;
  return [rat(d), rat(m), rat(s)];
}

/**
 * Serialize IFDs into a TIFF block. Each IFD is a list of
 * {tag, type, value} where value is a string (ASCII), a number, an array of
 * numbers, an array of [num, den] pairs (RATIONAL), or {ifd: index} for a
 * pointer to another IFD in the list.
 */
function serialize(ifds, le) {
  const entryBytes = (e) => {
    if (e.value && e.value.ifd !== undefined) return 4;
    if (e.type === T.ASCII) return e.value.length + 1;
    const n = Array.isArray(e.value) ? e.value.length : 1;
    return SIZE[e.type] * n;
  };
  const count = (e) => {
    if (e.value && e.value.ifd !== undefined) return 1;
    if (e.type === T.ASCII) return e.value.length + 1;
    return Array.isArray(e.value) ? e.value.length : 1;
  };

  // Layout: header, then each IFD followed by its out-of-line data.
  const offs = [];
  let off = 8;
  for (const ifd of ifds) {
    offs.push(off);
    off += 2 + ifd.length * 12 + 4;
    for (const e of ifd) {
      const b = entryBytes(e);
      if (b > 4) off += b + (b & 1);
    }
  }
  const buf = new ArrayBuffer(off);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8[0] = le ? 0x49 : 0x4d; u8[1] = u8[0];
  dv.setUint16(2, 42, le);
  dv.setUint32(4, offs[0], le);

  ifds.forEach((ifd, k) => {
    const sorted = ifd.slice().sort((a, b) => a.tag - b.tag);
    let p = offs[k];
    let data = p + 2 + sorted.length * 12 + 4;
    dv.setUint16(p, sorted.length, le);
    p += 2;
    for (const e of sorted) {
      const isPtr = e.value && e.value.ifd !== undefined;
      const type = isPtr ? T.LONG : e.type;
      dv.setUint16(p, e.tag, le);
      dv.setUint16(p + 2, type, le);
      dv.setUint32(p + 4, count(e), le);
      const b = entryBytes(e);
      const at = b <= 4 ? p + 8 : data;
      if (b > 4) { dv.setUint32(p + 8, data, le); data += b + (b & 1); }
      if (isPtr) dv.setUint32(at, offs[e.value.ifd], le);
      else if (type === T.ASCII) { for (let i = 0; i < e.value.length; i++) u8[at + i] = e.value.charCodeAt(i) & 0xff; }
      else {
        const vals = Array.isArray(e.value) ? e.value : [e.value];
        vals.forEach((v, i) => {
          if (type === T.BYTE) u8[at + i] = v;
          else if (type === T.SHORT) dv.setUint16(at + 2 * i, v, le);
          else if (type === T.LONG) dv.setUint32(at + 4 * i, v, le);
          else if (type === T.RATIONAL) { dv.setUint32(at + 8 * i, v[0], le); dv.setUint32(at + 8 * i + 4, v[1], le); }
        });
      }
      p += 12;
    }
    dv.setUint32(p, 0, le); // no next IFD
  });
  return u8;
}

/**
 * A TIFF block carrying whichever capture fields are given.
 * @param {object} f {make, model, when:'2026:07:14 09:12:33', tz, fl, fl35, f, exp, iso, lens, lat, lon, orientation}
 */
export function makeTiff(f = {}, le = true) {
  const ifd0 = [], exif = [], gps = [];
  if (f.make) ifd0.push({ tag: 0x010f, type: T.ASCII, value: f.make });
  if (f.model) ifd0.push({ tag: 0x0110, type: T.ASCII, value: f.model });
  if (f.orientation) ifd0.push({ tag: 0x0112, type: T.SHORT, value: f.orientation });
  if (f.modified) ifd0.push({ tag: 0x0132, type: T.ASCII, value: f.modified });
  if (f.exp) exif.push({ tag: 0x829a, type: T.RATIONAL, value: [f.exp < 1 ? [1, Math.round(1 / f.exp)] : rat(f.exp)] });
  if (f.f) exif.push({ tag: 0x829d, type: T.RATIONAL, value: [rat(f.f)] });
  if (f.iso) exif.push({ tag: 0x8827, type: T.SHORT, value: f.iso });
  if (f.when) exif.push({ tag: 0x9003, type: T.ASCII, value: f.when });
  if (f.tz) exif.push({ tag: 0x9011, type: T.ASCII, value: f.tz });
  if (f.fl) exif.push({ tag: 0x920a, type: T.RATIONAL, value: [rat(f.fl)] });
  if (f.fl35) exif.push({ tag: 0xa405, type: T.SHORT, value: f.fl35 });
  if (f.lens) exif.push({ tag: 0xa434, type: T.ASCII, value: f.lens });
  if (f.lat !== undefined && f.lon !== undefined) {
    gps.push({ tag: 1, type: T.ASCII, value: f.lat < 0 ? 'S' : 'N' });
    gps.push({ tag: 2, type: T.RATIONAL, value: dms(f.lat) });
    gps.push({ tag: 3, type: T.ASCII, value: f.lon < 0 ? 'W' : 'E' });
    gps.push({ tag: 4, type: T.RATIONAL, value: dms(f.lon) });
  }
  const ifds = [ifd0];
  if (exif.length) { ifd0.push({ tag: 0x8769, value: { ifd: ifds.length } }); ifds.push(exif); }
  if (gps.length) { ifd0.push({ tag: 0x8825, value: { ifd: ifds.length } }); ifds.push(gps); }
  return serialize(ifds, le);
}

function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const utf8 = (s) => new TextEncoder().encode(s);

function segment(marker, body) {
  const len = body.length + 2;
  return concat(Uint8Array.of(0xff, marker, len >> 8, len & 0xff), body);
}

/** An XMP packet carrying Photoshop place fields, as Lightroom writes them. */
export function makeXmp({ city, state, country, sublocation } = {}, asElements = false) {
  const attrs = [];
  const els = [];
  const add = (k, v) => {
    if (!v) return;
    const esc = v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    if (asElements) els.push(`<${k}>${esc}</${k}>`); else attrs.push(`${k}="${esc}"`);
  };
  add('photoshop:City', city);
  add('photoshop:State', state);
  add('photoshop:Country', country);
  add('Iptc4xmpCore:Location', sublocation);
  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" ' +
    'xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/" ' + attrs.join(' ') + '>' +
    els.join('') + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
}

/** A Photoshop APP13 body with an IPTC IIM block (8BIM 0x0404). */
export function makeIptc({ city, state, country, sublocation } = {}) {
  const fields = [];
  const ds = (n, v) => {
    if (!v) return;
    const b = utf8(v);
    fields.push(Uint8Array.of(0x1c, 2, n, b.length >> 8, b.length & 0xff), b);
  };
  ds(90, city); ds(92, sublocation); ds(95, state); ds(101, country);
  const iim = concat(...fields);
  const size = iim.length;
  const res = concat(ascii('8BIM'), Uint8Array.of(0x04, 0x04, 0, 0),
    Uint8Array.of(size >>> 24, (size >> 16) & 255, (size >> 8) & 255, size & 255), iim,
    size & 1 ? Uint8Array.of(0) : new Uint8Array(0));
  return concat(ascii('Photoshop 3.0\u0000'), res);
}

/**
 * Splice metadata segments into a JPEG right after SOI.
 * @param {Uint8Array} jpeg
 * @param {{tiff?:Uint8Array, xmp?:string, iptc?:Uint8Array}} m
 */
export function jpegWith(jpeg, m) {
  const segs = [];
  if (m.tiff) segs.push(segment(0xe1, concat(ascii('Exif\u0000\u0000'), m.tiff)));
  if (m.xmp) segs.push(segment(0xe1, concat(ascii('http://ns.adobe.com/xap/1.0/\u0000'), utf8(m.xmp))));
  if (m.iptc) segs.push(segment(0xed, m.iptc));
  return concat(jpeg.subarray(0, 2), ...segs, jpeg.subarray(2));
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Uint8Array.of(data.length >>> 24, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255);
  const td = concat(ascii(type), data);
  const c = crc32(td);
  return concat(head, td, Uint8Array.of(c >>> 24, (c >> 16) & 255, (c >> 8) & 255, c & 255));
}

/** Insert eXIf and/or an uncompressed iTXt XMP chunk before IDAT. */
export function pngWith(png, m) {
  let p = 8;
  while (p < png.length) {
    const len = ((png[p] << 24) >>> 0) + (png[p + 1] << 16) + (png[p + 2] << 8) + png[p + 3];
    const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    if (type === 'IDAT') break;
    p += 12 + len;
  }
  const extra = [];
  if (m.tiff) extra.push(pngChunk('eXIf', m.tiff));
  if (m.xmp) extra.push(pngChunk('iTXt', concat(ascii('XML:com.adobe.xmp\u0000'), Uint8Array.of(0, 0, 0, 0), utf8(m.xmp))));
  return concat(png.subarray(0, p), ...extra, png.subarray(p));
}

/** Append EXIF / XMP chunks to an extended (VP8X) or simple WebP. */
export function webpWith(webp, m) {
  const chunk = (fourcc, data) => {
    const n = data.length;
    return concat(ascii(fourcc), Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24), data,
      n & 1 ? Uint8Array.of(0) : new Uint8Array(0));
  };
  const parts = [webp.subarray(12)];
  if (m.tiff) parts.push(chunk('EXIF', m.tiff));
  if (m.xmp) parts.push(chunk('XMP ', utf8(m.xmp)));
  const body = concat(...parts);
  const size = body.length + 4;
  return concat(ascii('RIFF'), Uint8Array.of(size & 255, (size >> 8) & 255, (size >> 16) & 255, size >>> 24), ascii('WEBP'), body);
}

/*
CHANGELOG
v1.0 (2026-10-30): Initial release. TIFF writer (both byte orders, sub-IFD
  pointers, rationals), XMP and IPTC IIM builders, and splicers for JPEG,
  PNG and WebP.
*/
