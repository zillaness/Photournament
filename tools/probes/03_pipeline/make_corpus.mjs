// Builds the small mixed-format corpus for the ingest probe.
//
// Deliberately tiny: 12 files, a few hundred KB total. The previous run in this
// directory generated 1.4 GB of synthetic photos and left it behind; the HEIC
// fixtures from probe 02 are the only large inputs needed and they already exist.
//
// JPEG/PNG/WebP are encoded in Chromium (nothing in this environment can encode
// them from Node). EXIF is injected here afterwards.

import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
import fs from 'node:fs';
import path from 'node:path';

const DIR = '/home/user/Photournament/tools/probes/03_pipeline';
const FIX = path.join(DIR, 'fixtures');
const HEIC = '/home/user/Photournament/tools/probes/02_heic/fixtures';
fs.mkdirSync(FIX, { recursive: true });

// ---- EXIF APP1 injection ---------------------------------------------------
// Builds a minimal big-endian TIFF with a single IFD0 entry: Orientation.
function exifApp1(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 offset
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18); // value, left-aligned in the 4-byte field
  tiff.writeUInt16BE(0, 20);
  tiff.writeUInt32BE(0, 22); // next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.alloc(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  payload.copy(seg, 4);
  return seg;
}

function withExif(jpegBuf, orientation) {
  if (jpegBuf[0] !== 0xff || jpegBuf[1] !== 0xd8) throw new Error('not a JPEG');
  // Insert APP1 right after SOI, before any existing APP0/JFIF.
  return Buffer.concat([jpegBuf.subarray(0, 2), exifApp1(orientation), jpegBuf.subarray(2)]);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('file://' + path.join(DIR, 'harness.html'));

const b64 = (fmt, w, h, q) => page.evaluate(([f, W, Hh, Q]) => window.D.genImage(f, W, Hh, Q), [fmt, w, h, q]);
const write = (name, buf) => {
  fs.writeFileSync(path.join(FIX, name), buf);
  return { name, bytes: buf.length };
};

const made = [];
const jpegBase = Buffer.from(await b64('image/jpeg', 800, 600, 0.9), 'base64');
made.push(write('plain_800x600.jpg', jpegBase));
made.push(write('exif_o6_800x600.jpg', withExif(jpegBase, 6))); // 90 deg CW
made.push(write('exif_o8_800x600.jpg', withExif(jpegBase, 8))); // 270 deg CW
made.push(write('exif_o3_800x600.jpg', withExif(jpegBase, 3))); // 180 deg
made.push(write('plain_640x480.png', Buffer.from(await b64('image/png', 640, 480), 'base64')));
made.push(write('plain_640x480.webp', Buffer.from(await b64('image/webp', 640, 480, 0.9), 'base64')));
made.push(write('tiny_40x30.jpg', Buffer.from(await b64('image/jpeg', 40, 30, 0.9), 'base64')));

// ---- deliberate failures ---------------------------------------------------
const full = fs.readFileSync(path.join(HEIC, 'photo_12mp.heic'));
made.push(write('truncated.heic', full.subarray(0, 50 * 1024)));

// Valid JPEG magic, garbage payload: sniffs as jpeg, must fail at decode.
const garbage = Buffer.alloc(20000);
garbage[0] = 0xff; garbage[1] = 0xd8; garbage[2] = 0xff; garbage[3] = 0xe0;
for (let i = 4; i < garbage.length; i++) garbage[i] = (i * 37) & 0xff;
made.push(write('corrupt.jpg', garbage));

made.push(write('notreally.jpg', Buffer.from('This is a plain text file that somebody renamed to .jpg.\n'.repeat(20), 'utf8')));
made.push(write('empty.jpg', Buffer.alloc(0)));

await browser.close();
console.log(JSON.stringify({ dir: FIX, files: made, totalBytes: made.reduce((a, b) => a + b.bytes, 0) }, null, 1));
