/**
 * file: capture_test.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-10-30
 * last_updated: 2026-10-30
 * description: Tests for the whitelist capture-metadata reader in 10_ingest_worker.js (PRD 7.12): EXIF time, camera, lens, exposure and GPS in both byte orders, place names from XMP and IPTC, PNG and WebP carriers, and the never-fail contract on malformed input.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Run: node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTiff, makeXmp, makeIptc, jpegWith, pngWith, webpWith } from './lib/exif_fixture.mjs';

// The shared ingest code installs itself on whatever `this` the file's IIFE
// receives when `self` is absent, so calling the source with a plain object as
// `this` yields the exact helper set the worker gets.
const g = {};
new Function(readFileSync(new URL('../src/js/10_ingest_worker.js', import.meta.url), 'utf8')).call(g);
const H = g.__PTI;

// Smallest legal shells: SOI+EOI for JPEG; signature+IHDR+IDAT+IEND for PNG;
// a VP8X header for WebP. The reader never decodes pixels, so that is enough.
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
const PNG = Uint8Array.from(Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d4944415478da63f8cfc0f01f0005000201a3c2d1ab0000000049454e44ae426082', 'hex'));
const WEBP = Uint8Array.from(Buffer.from('52494646160000005745425056503858' + '0a00000000000000000000000000', 'hex'));

const FULL = {
  make: 'Canon', model: 'Canon EOS R6', when: '2026:07:14 09:12:33', tz: '+09:00',
  fl: 35, fl35: 35, f: 2.8, exp: 1 / 250, iso: 400, lens: 'RF35mm F1.8 MACRO IS STM',
  lat: 35.011636, lon: 135.768029
};

test('a JPEG with a full EXIF block yields every whitelisted field', () => {
  const c = H.readCapture(jpegWith(JPEG, { tiff: makeTiff(FULL) }), 'jpeg');
  assert.equal(c.make, 'Canon');
  assert.equal(c.model, 'Canon EOS R6');
  assert.equal(c.when, '2026-07-14T09:12:33');
  assert.equal(c.whenSrc, 'original');
  assert.equal(c.tz, '+09:00');
  assert.equal(c.fl, 35);
  assert.equal(c.fl35, 35);
  assert.equal(c.f, 2.8);
  assert.equal(c.exp, 1 / 250);
  assert.equal(c.iso, 400);
  assert.equal(c.lens, 'RF35mm F1.8 MACRO IS STM');
  assert.ok(Math.abs(c.lat - 35.011636) < 1e-5, 'latitude ' + c.lat);
  assert.ok(Math.abs(c.lon - 135.768029) < 1e-5, 'longitude ' + c.lon);
});

test('big-endian (Motorola) TIFF reads the same as little-endian', () => {
  const be = H.readCapture(jpegWith(JPEG, { tiff: makeTiff(FULL, false) }), 'jpeg');
  const le = H.readCapture(jpegWith(JPEG, { tiff: makeTiff(FULL, true) }), 'jpeg');
  assert.deepEqual(JSON.parse(JSON.stringify(be)), JSON.parse(JSON.stringify(le)));
});

test('southern and western hemispheres come out negative', () => {
  const c = H.readCapture(jpegWith(JPEG, { tiff: makeTiff({ lat: -33.8568, lon: -70.6483 }) }), 'jpeg');
  assert.ok(c.lat < -33.85 && c.lat > -33.86);
  assert.ok(c.lon < -70.64 && c.lon > -70.65);
});

test('0,0 is treated as "no fix", not a place', () => {
  const c = H.readCapture(jpegWith(JPEG, { tiff: makeTiff({ make: 'X', lat: 0, lon: 0 }) }), 'jpeg');
  assert.equal(c.lat, undefined);
  assert.equal(c.lon, undefined);
  assert.equal(c.make, 'X');
});

test('an unset camera clock is not a date', () => {
  const c = H.readCapture(jpegWith(JPEG, { tiff: makeTiff({ make: 'X', when: '0000:00:00 00:00:00' }) }), 'jpeg');
  assert.equal(c.when, undefined);
});

test('IFD0 DateTime stands in when DateTimeOriginal is absent, and says so', () => {
  const c = H.readCapture(jpegWith(JPEG, { tiff: makeTiff({ modified: '2025:01:02 03:04:05' }) }), 'jpeg');
  assert.equal(c.when, '2025-01-02T03:04:05');
  assert.equal(c.whenSrc, 'modified');
});

test('a written place name in XMP is read, as attributes or as elements', () => {
  for (const asEl of [false, true]) {
    const xmp = makeXmp({ city: 'Kyōto', state: 'Kyoto', country: 'Japan', sublocation: 'Gion & Higashiyama' }, asEl);
    const c = H.readCapture(jpegWith(JPEG, { xmp }), 'jpeg');
    assert.equal(c.city, 'Kyōto');
    assert.equal(c.state, 'Kyoto');
    assert.equal(c.country, 'Japan');
    assert.equal(c.sublocation, 'Gion & Higashiyama');
  }
});

test('IPTC IIM place names fill in when there is no XMP', () => {
  const c = H.readCapture(jpegWith(JPEG, { iptc: makeIptc({ city: 'Reykjavík', country: 'Iceland' }) }), 'jpeg');
  assert.equal(c.city, 'Reykjavík');
  assert.equal(c.country, 'Iceland');
});

test('XMP wins over IPTC when both carry a city (the one an edit updates)', () => {
  const c = H.readCapture(jpegWith(JPEG, {
    xmp: makeXmp({ city: 'Lisbon' }), iptc: makeIptc({ city: 'Porto', country: 'Portugal' })
  }), 'jpeg');
  assert.equal(c.city, 'Lisbon');
  assert.equal(c.country, 'Portugal', 'IPTC still fills the gaps XMP left');
});

test('PNG eXIf and iTXt XMP are both read', () => {
  const c = H.readCapture(pngWith(PNG, { tiff: makeTiff({ make: 'Apple', model: 'iPhone 15 Pro', when: '2026:03:01 12:00:00' }), xmp: makeXmp({ city: 'Oslo' }) }), 'png');
  assert.equal(c.make, 'Apple');
  assert.equal(c.when, '2026-03-01T12:00:00');
  assert.equal(c.city, 'Oslo');
});

test('WebP EXIF and XMP chunks are both read, with or without the Exif prefix', () => {
  const c = H.readCapture(webpWith(WEBP, { tiff: makeTiff({ model: 'Pixel 9', iso: 50 }), xmp: makeXmp({ country: 'Chile' }) }), 'webp');
  assert.equal(c.model, 'Pixel 9');
  assert.equal(c.iso, 50);
  assert.equal(c.country, 'Chile');
});

test('a file with no metadata yields an empty object, not a failure', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(H.readCapture(JPEG, 'jpeg'))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(H.readCapture(PNG, 'png'))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(H.readCapture(new Uint8Array(0), 'heic'))), {});
});

test('truncated and corrupted blocks never throw and never invent values', () => {
  const good = jpegWith(JPEG, { tiff: makeTiff(FULL) });
  for (let cut = 4; cut < good.length; cut += 7) {
    const c = H.readCapture(good.subarray(0, cut), 'jpeg');
    if (c.make !== undefined) assert.equal(c.make, 'Canon');
    if (c.iso !== undefined) assert.equal(c.iso, 400);
  }
  // Seeded byte flips across the whole block.
  let seed = 7;
  for (let round = 0; round < 300; round++) {
    const bad = good.slice();
    for (let k = 0; k < 6; k++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      bad[seed % bad.length] = seed >>> 24;
    }
    assert.doesNotThrow(() => H.readCapture(bad, 'jpeg'));
  }
});

test('control characters and padding are stripped from camera strings', () => {
  const c = H.readCapture(jpegWith(JPEG, { tiff: makeTiff({ make: '  NIKON CORPORATION\u0001  ', model: 'NIKON Z 6' }) }), 'jpeg');
  assert.equal(c.make, 'NIKON CORPORATION');
});

/*
CHANGELOG
v1.0 (2026-10-30): Initial release. Covers both byte orders, hemispheres,
  no-fix GPS, unset clocks, the DateTime fallback, XMP/IPTC place names and
  their precedence, PNG and WebP carriers, and a truncation/byte-flip fuzz.
*/
