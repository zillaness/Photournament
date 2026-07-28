// Injects an `irot` (image rotation) property into a real HEIC so orientation
// handling can actually be tested. None of the 02_heic fixtures carry irot/imir
// or a non-1 EXIF Orientation, so there was nothing to test against.
//
// Growing the `meta` box shifts `mdat`, so every construction_method==0 extent
// offset in `iloc` has to be patched by the same delta or the file decodes to
// garbage. That patch is the whole reason this file exists.
//
// Usage: node make_rotated_heic.mjs <in.heic> <out.heic> <ccwAngleIndex 0..3>
//        angle index is the irot value: 0=0deg 1=90 2=180 3=270 (counter-clockwise)

import fs from 'node:fs';

const [, , inPath, outPath, angleArg] = process.argv;
const ANGLE = Number(angleArg ?? 1) & 3;
const src = fs.readFileSync(inPath);

function boxes(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) size = end - off;
    out.push({ off, size, type, hdr, body: off + hdr });
    off += size;
  }
  return out;
}
const find = (list, t) => list.find((b) => b.type === t);

const top = boxes(src, 0, src.length);
const meta = find(top, 'meta');
const mdat = find(top, 'mdat');
if (!meta || !mdat) throw new Error('no meta/mdat');
const metaKids = boxes(src, meta.body + 4, meta.off + meta.size); // meta is a FullBox
const iprp = find(metaKids, 'iprp');
const iloc = find(metaKids, 'iloc');
const pitm = find(metaKids, 'pitm');
const iprpKids = boxes(src, iprp.body, iprp.off + iprp.size);
const ipco = find(iprpKids, 'ipco');
const ipma = find(iprpKids, 'ipma');

const pitmVer = src[pitm.body];
const primaryId = pitmVer === 0 ? src.readUInt16BE(pitm.body + 4) : src.readUInt32BE(pitm.body + 4);

const propCount = boxes(src, ipco.body, ipco.off + ipco.size).length;
const newPropIndex = propCount + 1;

// --- build the irot box: 8-byte header + 1 byte (6 reserved bits + 2 angle bits)
const irot = Buffer.alloc(9);
irot.writeUInt32BE(9, 0);
irot.write('irot', 4, 'latin1');
irot[8] = ANGLE;

// --- rewrite ipma, adding (essential, newPropIndex) to the primary item
function rewriteIpma() {
  const b = src;
  let p = ipma.body;
  const version = b[p];
  const flags = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
  p += 4;
  const wide = (flags & 1) === 1; // 15-bit property indices
  const count = b.readUInt32BE(p);
  p += 4;
  const chunks = [b.subarray(ipma.body, p)];
  let added = false;
  for (let i = 0; i < count; i++) {
    const entryStart = p;
    const itemId = version < 1 ? b.readUInt16BE(p) : b.readUInt32BE(p);
    p += version < 1 ? 2 : 4;
    const n = b[p];
    p += 1;
    p += n * (wide ? 2 : 1);
    if (itemId === primaryId) {
      const head = Buffer.from(b.subarray(entryStart, p));
      head[version < 1 ? 2 : 4] = n + 1; // bump association_count
      const assoc = Buffer.alloc(wide ? 2 : 1);
      if (wide) assoc.writeUInt16BE(0x8000 | newPropIndex, 0);
      else assoc[0] = 0x80 | newPropIndex; // essential bit set
      chunks.push(head, assoc);
      added = true;
    } else {
      chunks.push(Buffer.from(b.subarray(entryStart, p)));
    }
  }
  if (!added) throw new Error('primary item ' + primaryId + ' not found in ipma');
  const body = Buffer.concat(chunks);
  const box = Buffer.alloc(8 + body.length);
  box.writeUInt32BE(box.length, 0);
  box.write('ipma', 4, 'latin1');
  body.copy(box, 8);
  return box;
}
const newIpma = rewriteIpma();
const ipmaDelta = newIpma.length - ipma.size;
const DELTA = irot.length + ipmaDelta;

// --- patch iloc extent offsets that point into the file (construction_method 0)
function patchIloc() {
  const b = Buffer.from(src.subarray(iloc.off, iloc.off + iloc.size));
  // FullBox: [0..3]=size [4..7]='iloc' [8]=version [9..11]=flags, then the field-size nibbles.
  const version = b[8];
  let p = 12;
  const offsetSize = b[p] >> 4;
  const lengthSize = b[p] & 15;
  const baseOffsetSize = b[p + 1] >> 4;
  const indexSize = version === 1 || version === 2 ? b[p + 1] & 15 : 0;
  p += 2;
  let itemCount;
  if (version < 2) {
    itemCount = b.readUInt16BE(p);
    p += 2;
  } else {
    itemCount = b.readUInt32BE(p);
    p += 4;
  }
  const rd = (o, n) => (n === 0 ? 0 : n === 4 ? b.readUInt32BE(o) : n === 8 ? Number(b.readBigUInt64BE(o)) : b.readUIntBE(o, n));
  const wr = (o, n, v) => {
    if (n === 4) b.writeUInt32BE(v, o);
    else if (n === 8) b.writeBigUInt64BE(BigInt(v), o);
    else if (n > 0) b.writeUIntBE(v, o, n);
  };
  let patched = 0;
  for (let i = 0; i < itemCount; i++) {
    p += version < 2 ? 2 : 4; // item_ID
    let construction = 0;
    if (version === 1 || version === 2) {
      construction = b.readUInt16BE(p) & 15;
      p += 2;
    }
    p += 2; // data_reference_index
    const baseOff = p;
    const base = rd(baseOff, baseOffsetSize);
    p += baseOffsetSize;
    const extentCount = b.readUInt16BE(p);
    p += 2;
    const fileOffsets = construction === 0;
    if (fileOffsets && baseOffsetSize > 0 && base > 0) {
      wr(baseOff, baseOffsetSize, base + DELTA);
      patched++;
    }
    for (let e = 0; e < extentCount; e++) {
      if ((version === 1 || version === 2) && indexSize > 0) p += indexSize;
      if (fileOffsets && !(baseOffsetSize > 0 && base > 0)) {
        wr(p, offsetSize, rd(p, offsetSize) + DELTA);
        patched++;
      }
      p += offsetSize + lengthSize;
    }
  }
  return { buf: b, patched, version, offsetSize, baseOffsetSize, itemCount };
}
const ilocPatch = patchIloc();

// --- reassemble
function withSize(type, oldBox, innerBuffers) {
  const body = Buffer.concat(innerBuffers);
  const box = Buffer.alloc(8 + body.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 'latin1');
  body.copy(box, 8);
  void oldBox;
  return box;
}

const newIpco = withSize('ipco', ipco, [src.subarray(ipco.body, ipco.off + ipco.size), irot]);
const newIprp = withSize('iprp', iprp, [newIpco, newIpma]);

// meta children, in original order, with iprp and iloc swapped for the new ones
const metaPieces = [src.subarray(meta.body, meta.body + 4)]; // FullBox version/flags
for (const k of metaKids) {
  if (k.type === 'iprp') metaPieces.push(newIprp);
  else if (k.type === 'iloc') metaPieces.push(ilocPatch.buf);
  else metaPieces.push(src.subarray(k.off, k.off + k.size));
}
const newMeta = withSize('meta', meta, metaPieces);
if (newMeta.length - meta.size !== DELTA) throw new Error(`meta grew by ${newMeta.length - meta.size}, expected ${DELTA}`);

const outPieces = [];
for (const t of top) outPieces.push(t.type === 'meta' ? newMeta : src.subarray(t.off, t.off + t.size));
const out = Buffer.concat(outPieces);
fs.writeFileSync(outPath, out);

console.log(
  JSON.stringify(
    {
      in: inPath,
      out: outPath,
      irotAngleCcw: ANGLE * 90,
      primaryId,
      newPropIndex,
      delta: DELTA,
      ipmaDelta,
      iloc: { version: ilocPatch.version, offsetSize: ilocPatch.offsetSize, baseOffsetSize: ilocPatch.baseOffsetSize, items: ilocPatch.itemCount, extentsPatched: ilocPatch.patched },
      inBytes: src.length,
      outBytes: out.length,
      mdatMovedFrom: mdat.off,
      mdatMovedTo: mdat.off + DELTA,
    },
    null,
    1
  )
);
