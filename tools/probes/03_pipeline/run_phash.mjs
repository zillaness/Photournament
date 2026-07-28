// Does the hash the pipeline emits actually behave like a perceptual hash?
// PRD 7.7 groups near-duplicates by Hamming distance, so a hash that separates
// re-encodes as hard as it separates unrelated frames would be useless.

import { chromium, serve, waitPort, CORPUS, save } from './lib.mjs';

const PORT = 8135;
const srv = serve(PORT);
await waitPort(PORT);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/harness.html`);
await page.setInputFiles('#picker', CORPUS);
await page.evaluate(() => window.__probe.loadFilesFromInput());

function ham(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

const out = { algorithms: {} };

for (const algo of ['dct', 'dhash']) {
  // baseline: 120 unrelated corpus images
  const baseHashes = await page.evaluate(
    async (a) => window.__probe.hashBlobs(window.__probe.files.slice(0, 120), a),
    algo
  );
  const dists = [];
  for (let i = 0; i < baseHashes.length; i++) {
    for (let j = i + 1; j < baseHashes.length; j++) dists.push(ham(baseHashes[i], baseHashes[j]));
  }
  dists.sort((a, b) => a - b);
  const q = (p) => dists[Math.floor((p / 100) * (dists.length - 1))];

  // near-duplicate variants of 4 different source images
  const variantRuns = [];
  for (const idx of [0, 40, 90, 200]) {
    const r = await page.evaluate(
      async ([i, a]) => {
        const f = window.__probe.files[i];
        const v = await window.__probe.makeVariants(f);
        const names = Object.keys(v);
        const hashes = await window.__probe.hashBlobs([f, ...names.map((n) => v[n])], a);
        return { file: f.webkitRelativePath, names, hashes, sizes: names.map((n) => v[n].size) };
      },
      [idx, algo]
    );
    const base = r.hashes[0];
    variantRuns.push({
      file: r.file,
      baseHash: base,
      variants: r.names.map((n, k) => ({ name: n, hash: r.hashes[k + 1], hamming: ham(base, r.hashes[k + 1]) })),
    });
  }

  const perVariant = {};
  for (const run of variantRuns) {
    for (const v of run.variants) {
      (perVariant[v.name] = perVariant[v.name] || []).push(v.hamming);
    }
  }

  out.algorithms[algo] = {
    unrelatedPairs: {
      pairs: dists.length,
      min: dists[0],
      p1: q(1),
      p5: q(5),
      median: q(50),
      p95: q(95),
      max: dists[dists.length - 1],
      under8: dists.filter((x) => x <= 8).length,
      under12: dists.filter((x) => x <= 12).length,
    },
    nearDuplicateHamming: Object.fromEntries(
      Object.entries(perVariant).map(([k, v]) => [k, { values: v, max: Math.max(...v) }])
    ),
    runs: variantRuns,
  };

  console.log(`\n== ${algo} ==`);
  console.log(
    `unrelated pairs (n=${dists.length}): min=${dists[0]} p1=${q(1)} p5=${q(5)} median=${q(50)} ` +
      `| <=8: ${dists.filter((x) => x <= 8).length}  <=12: ${dists.filter((x) => x <= 12).length}`
  );
  for (const [k, v] of Object.entries(perVariant)) console.log(`  ${k.padEnd(22)} hamming ${v.join(', ')}`);
}

await browser.close();
srv.kill();
save('phash.json', out);
