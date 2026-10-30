/**
 * file: organize_test.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-10-30
 * last_updated: 2026-10-30
 * description: Tests for PT.organize (PRD 7.12): category paths and nesting, named missing buckets, time-gap events, offline location clusters with written-name precedence and user names, and the hand-off to the unchanged PT.tree.build().
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Run: node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Same loading pattern as tree_test.mjs: classic scripts attaching to window.
const win = {};
const load = (f) => new Function('window', readFileSync(new URL('../src/js/' + f, import.meta.url), 'utf8'))(win);
load('30_tree.js');
load('32_organize.js');
const O = win.PT.organize;
const T = win.PT.tree;

let n = 0;
function photo(capture, extra = {}) {
  n++;
  return Object.assign({ id: 'p' + n, name: 'IMG_' + n + '.jpg', path: 'IMG_' + n + '.jpg', dir: '', kind: 'jpeg', w: 4000, h: 3000, capture }, extra);
}

const KYOTO = { lat: 35.0116, lon: 135.7681 };
const KYOTO_2KM = { lat: 35.0296, lon: 135.7681 };   // ~2 km north
const OSAKA = { lat: 34.6937, lon: 135.5023 };        // ~43 km away

test('Folders alone is today\'s behaviour: apply() returns the very same records', () => {
  const ps = [photo({}, { dir: 'Trip/Day1' }), photo({}, { dir: 'Trip/Day2' })];
  assert.equal(O.apply(ps, { cats: ['folder'] }), ps);
  assert.equal(O.apply(ps, { cats: [] }), ps);
  assert.ok(O.isFolders({ cats: [] }) && O.isFolders({ cats: ['folder'] }) && !O.isFolders({ cats: ['day'] }));
});

test('categories nest in the order chosen', () => {
  const a = photo({ when: '2026-07-14T09:00:00', make: 'Canon', model: 'Canon EOS R6' });
  const b = photo({ when: '2026-07-15T10:00:00', make: 'Apple', model: 'iPhone 15 Pro' });
  const p1 = O.plan([a, b], { cats: ['day', 'camera'] });
  assert.equal(p1.dir[a.id], '2026-07-14/Canon EOS R6');
  assert.equal(p1.dir[b.id], '2026-07-15/Apple iPhone 15 Pro');
  const p2 = O.plan([a, b], { cats: ['camera', 'day'] });
  assert.equal(p2.dir[a.id], 'Canon EOS R6/2026-07-14');
});

test('a missing field lands in a named bucket, never nowhere', () => {
  const none = photo({});
  const old = photo(undefined); // ingested before capture metadata existed
  const pl = O.plan([none, old], { cats: ['day', 'camera', 'location', 'lens', 'focal'] });
  assert.equal(pl.dir[none.id], 'No date/Unknown camera/No location/Unknown lens/Unknown focal length');
  assert.equal(pl.dir[old.id], pl.dir[none.id]);
  assert.equal(pl.noCapture, 1);
});

test('the make/model stutter is removed, but distinct makes are kept', () => {
  assert.equal(O.cameraLabel({ make: 'Canon', model: 'Canon EOS R6' }), 'Canon EOS R6');
  assert.equal(O.cameraLabel({ make: 'NIKON CORPORATION', model: 'NIKON Z 6' }), 'NIKON Z 6');
  assert.equal(O.cameraLabel({ make: 'Apple', model: 'iPhone 15 Pro' }), 'Apple iPhone 15 Pro');
  assert.equal(O.cameraLabel({ model: 'Pixel 9' }), 'Pixel 9');
  assert.equal(O.cameraLabel({}), null);
});

test('events split on gaps longer than the chosen gap, across all cameras', () => {
  const ps = [
    photo({ when: '2026-07-14T09:00:00', model: 'A' }),
    photo({ when: '2026-07-14T09:40:00', model: 'B' }),  // 40 min: same event at 2 h
    photo({ when: '2026-07-14T13:00:00', model: 'A' }),  // 3 h 20 later: new event
    photo({ when: '2026-07-15T00:30:00', model: 'A' })   // after midnight: a new event, and the day changes too
  ];
  const pl = O.plan(ps, { cats: ['event'], eventGapH: 2 });
  assert.equal(pl.events.length, 3);
  assert.equal(pl.dir[ps[0].id], '2026-07-14 09.00');
  assert.equal(pl.dir[ps[1].id], '2026-07-14 09.00');
  assert.equal(pl.dir[ps[2].id], '2026-07-14 13.00');
  // A 30-minute gap splits the first pair apart too.
  assert.equal(O.plan(ps, { cats: ['event'], eventGapH: 0.5 }).events.length, 4);
});

test('a late shoot past midnight stays one event even though the day changes', () => {
  const ps = [photo({ when: '2026-07-14T23:30:00' }), photo({ when: '2026-07-15T00:20:00' })];
  const pl = O.plan(ps, { cats: ['event'] });
  assert.equal(pl.events.length, 1);
  assert.equal(pl.dir[ps[1].id], '2026-07-14 23.30');
});

test('user event names replace the automatic label', () => {
  const ps = [photo({ when: '2026-07-14T09:00:00' })];
  const pl = O.plan(ps, { cats: ['event'], names: { 'event:2026-07-14T09:00:00': 'Ceremony' } });
  assert.equal(pl.dir[ps[0].id], 'Ceremony');
});

test('GPS photos within the radius share a location; far ones do not', () => {
  const a = photo(Object.assign({ when: '2026-07-14T09:00:00' }, KYOTO));
  const b = photo(Object.assign({ when: '2026-07-14T10:00:00' }, KYOTO_2KM));
  const c = photo(Object.assign({ when: '2026-07-14T15:00:00' }, OSAKA));
  const pl = O.plan([a, b, c], { cats: ['location'], radiusKm: 5 });
  assert.equal(pl.dir[a.id], pl.dir[b.id]);
  assert.notEqual(pl.dir[a.id], pl.dir[c.id]);
  assert.match(pl.dir[a.id], /^Near 35\.0\dN 135\.77E$/);
  // At 1 km the 2 km neighbours separate.
  const tight = O.plan([a, b, c], { cats: ['location'], radiusKm: 1 });
  assert.notEqual(tight.dir[a.id], tight.dir[b.id]);
});

test('a written place name wins, and lends itself to GPS-only neighbours', () => {
  const named = photo(Object.assign({ city: 'Kyoto', country: 'Japan' }, KYOTO));
  const phone = photo(Object.assign({}, KYOTO_2KM));            // GPS only, 2 km away
  const textOnly = photo({ city: 'Lisbon', country: 'Portugal' }); // a name, no GPS
  const pl = O.plan([named, phone, textOnly], { cats: ['location'] });
  assert.equal(pl.dir[named.id], 'Kyoto, Japan');
  assert.equal(pl.dir[phone.id], 'Kyoto, Japan');
  assert.equal(pl.dir[textOnly.id], 'Lisbon, Portugal');
});

test('a user name sticks to a place by distance, and survives a radius change', () => {
  const a = photo(Object.assign({}, KYOTO));
  const b = photo(Object.assign({}, KYOTO_2KM));
  const first = O.plan([a, b], { cats: ['location'], radiusKm: 5 });
  const key = first.locations[0].key;
  const names = { [key]: 'Gion' };
  assert.equal(O.plan([a, b], { cats: ['location'], radiusKm: 5, names }).dir[a.id], 'Gion');
  assert.equal(O.plan([a, b], { cats: ['location'], radiusKm: 25, names }).dir[b.id], 'Gion');
});

test('focal bands use the 35 mm equivalent when the file has it', () => {
  assert.equal(O.focalBand({ fl: 6.8, fl35: 24 }), 'Wide (24-35mm)');
  assert.equal(O.focalBand({ fl: 200 }), 'Tele (over 135mm)');
  assert.equal(O.focalBand({ fl35: 50 }), 'Normal (36-70mm)');
  assert.equal(O.focalBand({}), null);
});

test('orientation follows a manual quarter turn', () => {
  const p = photo({}, { w: 4000, h: 3000 });
  assert.equal(O.plan([p], { cats: ['orientation'] }).dir[p.id], 'Landscape');
  const q = photo({}, { w: 4000, h: 3000, orient: { r: 1, f: false } });
  assert.equal(O.plan([q], { cats: ['orientation'] }).dir[q.id], 'Portrait');
});

test('folder names are filesystem-safe and never contain the tree separator', () => {
  const p = photo({ model: 'AC/DC: "Back" <In> Black?', lens: '..hidden' });
  const pl = O.plan([p], { cats: ['camera', 'lens'] });
  const segs = pl.dir[p.id].split('/');
  assert.equal(segs.length, 2);
  assert.ok(!/[\\:*?"<>|]/.test(segs[0]), segs[0]);
  assert.ok(!segs[1].startsWith('.'));
});

test('Folders combined with a category keeps real depth, then nests', () => {
  const a = photo({ when: '2026-07-14T09:00:00' }, { dir: 'Trip/Day1' });
  const b = photo({ when: '2026-07-14T09:00:00' }, { dir: '' });
  const pl = O.plan([a, b], { cats: ['folder', 'day'] });
  assert.equal(pl.dir[a.id], 'Trip/Day1/2026-07-14');
  assert.equal(pl.dir[b.id], '2026-07-14');
});

test('chip summaries count groups including the missing bucket', () => {
  const ps = [
    photo({ when: '2026-07-14T09:00:00', model: 'A' }),
    photo({ when: '2026-07-15T09:00:00', model: 'A' }),
    photo({})
  ];
  const pl = O.plan(ps, { cats: [] });
  assert.deepEqual({ ...pl.summary.day }, { groups: 3, missing: 1 });
  assert.deepEqual({ ...pl.summary.camera }, { groups: 2, missing: 1 });
});

test('the organized records build an allocation tree whose leaves are the groups', () => {
  const ps = [
    photo({ when: '2026-07-14T09:00:00', model: 'A' }),
    photo({ when: '2026-07-14T10:00:00', model: 'B' }),
    photo({ when: '2026-07-15T09:00:00', model: 'A' })
  ];
  const tree = T.build(O.apply(ps, { cats: ['day', 'camera'] }));
  const paths = Object.keys(tree.nodes).sort();
  for (const p of ['2026-07-14', '2026-07-14/A', '2026-07-14/B', '2026-07-15', '2026-07-15/A']) {
    assert.ok(paths.includes(p), 'tree has ' + p + ' in ' + paths.join(', '));
  }
  assert.equal(tree.nodes['2026-07-14/A'].photoIds.length, 1);
  // The input records are not mutated: their real dirs are intact.
  assert.ok(ps.every((p) => p.dir === ''));
});

test('manifest rows carry where the photo went, its tags and its capture data', () => {
  const p = photo({ when: '2026-07-14T09:12:33', tz: '+09:00', make: 'Canon', model: 'Canon EOS R6', f: 2.8, iso: 400, lat: -33.85, lon: 151.2 }, { path: 'DCIM/IMG_1.jpg', size: 1234 });
  const r = O.manifestRow(p, '2026-07-14/Canon EOS R6', 'IMG_1.jpg', ['portfolio', 'print']);
  assert.equal(r.folder, '2026-07-14/Canon EOS R6');
  assert.equal(r.original_path, 'DCIM/IMG_1.jpg');
  assert.equal(r.tags, 'portfolio; print');
  assert.equal(r.taken, '2026-07-14 09:12:33');
  assert.equal(r.camera, 'Canon EOS R6');
  assert.equal(r.latitude, -33.85);
});

test('CSV quotes what needs quoting and defuses spreadsheet formulas', () => {
  const csv = O.toCsv([
    { folder: 'a,b', file: 'say "hi".jpg', tags: '=HYPERLINK("x")', latitude: -33.85, iso: '' },
    { folder: '@risk', file: '+1.jpg', tags: '-x' }
  ]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], O.MANIFEST_COLS.join(','));
  assert.ok(lines[1].startsWith('"a,b","say ""hi"".jpg",,"\'=HYPERLINK(""x"")"'), lines[1]);
  assert.ok(lines[1].includes(',-33.85,'), 'numbers stay numbers: ' + lines[1]);
  assert.ok(lines[2].startsWith("'@risk,'+1.jpg,,'-x"), lines[2]);
  assert.ok(csv.endsWith('\r\n'));
});

/*
CHANGELOG
v1.0 (2026-10-30): Initial release, with manifest-row and CSV cases.
*/
