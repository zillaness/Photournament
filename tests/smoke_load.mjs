/**
 * file: smoke_load.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Loads every src/js module together in real Chromium from a file:// URL and asserts the public API surface exists with zero console errors.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * This is the integration check the unit tests cannot make: the modules are
 * classic scripts that share one global, so load order and namespace collisions
 * only surface in a browser. Run from a file:// URL specifically, because that is
 * the origin the shipped artifact actually runs on and it is far more restrictive
 * than http://localhost.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/smoke_load.mjs
 */

import { chromium } from 'playwright';
import { readdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const jsDir = path.join(root, 'src', 'js');
const files = readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort();

const page404 = path.join(root, 'tests', '.smoke.html');
writeFileSync(
  page404,
  `<!doctype html><meta charset="utf-8"><title>smoke</title><div id="screen"></div>` +
    files.map((f) => `<script src="../src/js/${f}"></script>`).join('\n')
);

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('file://' + page404);
await page.waitForTimeout(300);

const api = await page.evaluate(() => {
  const t = (v) => (v === undefined ? 'MISSING' : typeof v);
  const PT = window.PT || {};
  return {
    origin: location.protocol,
    version: PT.VERSION,
    core: {
      log: t(PT.log), bus_on: t(PT.bus && PT.bus.on), bus_emit: t(PT.bus && PT.bus.emit),
      store_dispatch: t(PT.store && PT.store.dispatch), store_subscribe: t(PT.store && PT.store.subscribe),
      db_put: t(PT.db && PT.db.put), db_usage: t(PT.db && PT.db.usage),
      fingerprint: t(PT.fingerprint), kindOf: t(PT.kindOf),
      dom_el: t(PT.dom && PT.dom.el), router_go: t(PT.router && PT.router.go),
      fmt_bytes: t(PT.fmt && PT.fmt.bytes)
    },
    phash: {
      dhash: t(PT.phash && PT.phash.dhash), phash: t(PT.phash && PT.phash.phash),
      hamming: t(PT.phash && PT.phash.hamming), sharpness: t(PT.phash && PT.phash.sharpness),
      cluster: t(PT.phash && PT.phash.cluster), nominate: t(PT.phash && PT.phash.nominate),
      DEFAULT_THRESHOLD: PT.phash && PT.phash.DEFAULT_THRESHOLD,
      THRESHOLD_RANGE: PT.phash && PT.phash.THRESHOLD_RANGE
    },
    ingest: {
      WORKER_SRC_bytes: PT.ingest && PT.ingest.WORKER_SRC ? PT.ingest.WORKER_SRC.length : 0,
      createPool: t(PT.ingest && PT.ingest.createPool),
      fingerprint: t(PT.ingest && PT.ingest.fingerprint)
    },
    tree: {
      build: t(PT.tree && PT.tree.build), resolve: t(PT.tree && PT.tree.resolve),
      parseAlloc: t(PT.tree && PT.tree.parseAlloc), distribute: t(PT.tree && PT.tree.distribute)
    }
  };
});

// Behavioural spot-checks: presence is not correctness.
const behaviour = await page.evaluate(async () => {
  const out = {};
  const PT = window.PT;

  // Hamming of a hash against itself must be 0, and against its complement 64.
  const a = 'ffffffffffffffff', b = '0000000000000000';
  out.hammingSelf = PT.phash.hamming(a, a);
  out.hammingOpposite = PT.phash.hamming(a, b);

  // The store must notify subscribers and record the action name.
  PT.store.init({ session: null, n: 0 });
  let seen = null;
  PT.store.subscribe((s, name) => { seen = name; });
  PT.store.dispatch('test:bump', (s) => { s.n++; });
  out.storeName = seen;
  out.storeValue = PT.store.get().n;

  // IndexedDB must actually round-trip on this origin.
  await PT.db.put('sessions', { id: 'smoke', v: 1 });
  const got = await PT.db.get('sessions', 'smoke');
  out.idbRoundTrip = got && got.v === 1;
  await PT.db.del('sessions', 'smoke');

  // A worker must spawn from a blob URL and answer.
  out.blobWorker = await new Promise((res) => {
    const w = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>postMessage(e.data*2)'])));
    const to = setTimeout(() => res('timeout'), 3000);
    w.onmessage = (e) => { clearTimeout(to); w.terminate(); res(e.data); };
    w.onerror = (e) => { clearTimeout(to); res('error: ' + e.message); };
    w.postMessage(21);
  });

  // The tree must resolve the PRD 4.3 example.
  const photos = [];
  const add = (dir, n) => { for (let i = 0; i < n; i++) photos.push({ id: dir + i, dir, path: dir + '/' + i }); };
  add('Trip/Day1', 80); add('Trip/Day2', 120); add('Trip/Day3', 150); add('Trip/Day4', 90); add('Trip/Misc', 40);
  const tr = PT.tree.build(photos);
  const al = {};
  for (const [p, v] of Object.entries({ Trip: '20', 'Trip/Day1': '5', 'Trip/Day2': '5', 'Trip/Day3': '', 'Trip/Day4': '0', 'Trip/Misc': '' })) {
    al[p] = PT.tree.parseAlloc(v);
  }
  const r = PT.tree.resolve(tr, al);
  out.treeUnits = r.units.length;
  out.treeTotal = r.projectedTotal;
  out.treeErrors = r.hasErrors;

  return out;
});

await browser.close();
rmSync(page404, { force: true });

/* ------------------------------------------------------------------ report */

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

console.log('modules loaded:', files.join(', '));
console.log('origin:', api.origin, '| PT.VERSION:', api.version, '\n');

for (const [group, obj] of Object.entries({ core: api.core, phash: api.phash, tree: api.tree })) {
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'DEFAULT_THRESHOLD' || k === 'THRESHOLD_RANGE') continue;
    check(`${group}.${k}`, v === 'function', v);
  }
}
check('ingest.createPool', api.ingest.createPool === 'function', api.ingest.createPool);
check('ingest.fingerprint', api.ingest.fingerprint === 'function', api.ingest.fingerprint);
check('ingest.WORKER_SRC non-empty', api.ingest.WORKER_SRC_bytes > 1000, api.ingest.WORKER_SRC_bytes + ' B');

console.log('');
check('phash.hamming(x,x) === 0', behaviour.hammingSelf === 0, behaviour.hammingSelf);
check('phash.hamming(x,~x) === 64', behaviour.hammingOpposite === 64, behaviour.hammingOpposite);
check('phash threshold is even (constant-weight code)', api.phash.DEFAULT_THRESHOLD % 2 === 0, api.phash.DEFAULT_THRESHOLD);
check('store notifies with action name', behaviour.storeName === 'test:bump', behaviour.storeName);
check('store applied the mutation', behaviour.storeValue === 1, behaviour.storeValue);
check('IndexedDB round-trips on file://', behaviour.idbRoundTrip === true, behaviour.idbRoundTrip);
check('blob-URL worker responds', behaviour.blobWorker === 42, behaviour.blobWorker);
check('tree resolves PRD 4.3 to 3 units', behaviour.treeUnits === 3, behaviour.treeUnits);
check('tree projects 20 finalists', behaviour.treeTotal === 20, behaviour.treeTotal);
check('tree reports no errors', behaviour.treeErrors === false, behaviour.treeErrors);

console.log('');
check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. API surface plus behavioural spot-checks
 *   for the store, IndexedDB, blob workers, hashing and the allocation tree.
 */
