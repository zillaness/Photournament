/**
 * run.js — PROBE ONLY. Drives the whole pHash probe:
 *
 *   1. serves this directory over http (Chromium refuses fetch/createImageBitmap
 *      chains from file:// in enough cases that it isn't worth fighting)
 *   2. builds + hashes the corpus in a real Chromium page
 *   3. writes a visual sample of the corpus to ./corpus
 *   4. does all the distance / threshold / clustering / nomination analysis in
 *      Node, using the SAME phash.js the page used
 *   5. runs the 500-image throughput benchmark
 *   6. writes ./results/*.json + tables.md
 *
 * Usage: node tools/probes/04_phash/run.js [--no-bench] [--port 8099]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const DIR = __dirname;
const RESULTS = path.join(DIR, 'results');
const CORPUS = path.join(DIR, 'corpus');

const argv = process.argv.slice(2);
const NO_BENCH = argv.includes('--no-bench');
const PORT = (() => { const i = argv.indexOf('--port'); return i >= 0 ? +argv[i + 1] : 8099; })();

// Load phash.js into this Node process so the analysis uses the exact same code.
vm.runInThisContext(fs.readFileSync(path.join(DIR, 'phash.js'), 'utf8'), { filename: 'phash.js' });
const PH = globalThis.PhotournamentHash;

// ---------------------------------------------------------------------------
// tiny static server
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
function serve(port) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(DIR, rel || 'harness.html');
    if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

// ---------------------------------------------------------------------------
// stats helpers
// ---------------------------------------------------------------------------
function stats(arr) {
  if (!arr.length) return { n: 0 };
  const a = arr.slice().sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / a.length);
  return { n: a.length, min: a[0], p05: q(0.05), p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95), p99: q(0.99), max: a[a.length - 1], mean: +mean.toFixed(2), sd: +sd.toFixed(2) };
}
function fmt(v) { return typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v); }

// ---------------------------------------------------------------------------
// pair construction
// ---------------------------------------------------------------------------
function pairsWithin(records, keyFn) {
  const by = new Map();
  records.forEach((r, i) => {
    const k = keyFn(r); if (k == null) return;
    if (!by.has(k)) by.set(k, []); by.get(k).push(i);
  });
  const out = [];
  for (const [k, idx] of by) for (let i = 0; i < idx.length; i++) for (let j = i + 1; j < idx.length; j++) out.push([idx[i], idx[j], k]);
  return out;
}

function dist(records, i, j, field) { return PH.hamming(records[i][field], records[j][field]); }

const FIELDS = { dhash: 'dhash', phash: 'phash', dhashThumb: 'dhashThumb', phashThumb: 'phashThumb' };

// ---------------------------------------------------------------------------
// threshold sweep
// ---------------------------------------------------------------------------
/**
 * @param {Array<{d:number,pos:boolean,hard?:boolean}>} pairs
 * @returns {{rows:Array, best:object, bestYouden:object}}
 */
function sweep(pairs) {
  const P = pairs.filter((p) => p.pos).length;
  const N = pairs.length - P;
  const hardN = pairs.filter((p) => !p.pos && p.hard).length;
  const rows = [];
  for (let t = 0; t <= 32; t++) {
    let tp = 0, fp = 0, hardFp = 0;
    for (const p of pairs) {
      if (p.d <= t) { if (p.pos) tp++; else { fp++; if (p.hard) hardFp++; } }
    }
    const fn = P - tp, tn = N - fp;
    const recall = P ? tp / P : 0;
    const precision = tp + fp ? tp / (tp + fp) : 1;
    rows.push({
      t, tp, fp, fn, tn,
      recall: +recall.toFixed(4), precision: +precision.toFixed(4),
      fnr: +(1 - recall).toFixed(4), fpr: N ? +(fp / N).toFixed(5) : 0,
      hardFpr: hardN ? +(hardFp / hardN).toFixed(4) : 0,
      f1: recall + precision ? +((2 * recall * precision) / (recall + precision)).toFixed(4) : 0,
      youden: +(recall - (N ? fp / N : 0)).toFixed(4),
      accuracy: +((tp + tn) / pairs.length).toFixed(5)
    });
  }
  const best = rows.reduce((a, b) => (b.f1 > a.f1 ? b : a));
  const bestY = rows.reduce((a, b) => (b.youden > a.youden ? b : a));
  const zeroFp = rows.filter((r) => r.fp === 0).reduce((a, b) => (b.t > a.t ? b : a), rows[0]);
  return { rows, best, bestYouden: bestY, largestZeroFP: zeroFp, P, N, hardN };
}

// ---------------------------------------------------------------------------
// clustering evaluation
// ---------------------------------------------------------------------------
function evalClustering(records, groups, field) {
  // pairwise precision / recall against trueGroup
  const idxGroup = new Array(records.length).fill(-1);
  groups.forEach((g, gi) => g.forEach((i) => { idxGroup[i] = gi; }));
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const same = idxGroup[i] === idxGroup[j];
      const trueSame = records[i].trueGroup === records[j].trueGroup;
      if (same && trueSame) tp++; else if (same && !trueSame) fp++; else if (!same && trueSame) fn++;
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  let maxDiam = 0, sumDiam = 0, nMulti = 0;
  const items = records.map((r) => ({ hash: r[field] }));
  for (const g of groups) {
    if (g.length < 2) continue;
    const d = PH.groupDiameter(items, g);
    maxDiam = Math.max(maxDiam, d); sumDiam += d; nMulti++;
  }
  return {
    groups: groups.length, multiMemberGroups: nMulti,
    largestGroup: groups.reduce((a, g) => Math.max(a, g.length), 0),
    pairPrecision: +precision.toFixed(4), pairRecall: +recall.toFixed(4),
    pairF1: +((2 * precision * recall) / (precision + recall || 1)).toFixed(4),
    tp, fp, fn,
    maxGroupDiameter: maxDiam, meanGroupDiameter: nMulti ? +(sumDiam / nMulti).toFixed(2) : 0
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.mkdirSync(CORPUS, { recursive: true });

  const server = await serve(PORT);
  let browser;
  try {
    const { chromium } = require(process.env.PW_REQUIRE || 'playwright');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/harness.html`, { waitUntil: 'load' });

    const self = await page.evaluate(() => window.selfTest());
    console.log('selfTest:', JSON.stringify(self));
    if (!self.stable || self.hexLen !== 16 || self.hammingMax !== 64) throw new Error('phash.js self test failed');

    console.log('building corpus...');
    const t0 = Date.now();
    const { records, samples } = await page.evaluate(() => window.runCorpus(), null, { timeout: 900000 });
    console.log(`corpus: ${records.length} images in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${samples.length} samples`);

    // ---- write sample images -------------------------------------------
    for (const s of samples) {
      const p = path.join(CORPUS, s.id.replace(/[^A-Za-z0-9/._-]/g, '_') + '.jpg');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(s.dataURL.split(',')[1], 'base64'));
    }
    fs.writeFileSync(path.join(RESULTS, 'hashes.json'), JSON.stringify(records, null, 1));

    // =====================================================================
    // ANALYSIS
    // =====================================================================
    const analysis = { generatedAt: new Date().toISOString(), corpusSize: records.length, selfTest: self };
    const idOf = new Map(records.map((r, i) => [r.id, i]));
    const csvRows = [['pairClass', 'a', 'b', 'dhash', 'phash', 'dhashThumb', 'phashThumb'].join(',')];

    function addCsv(cls, i, j) {
      csvRows.push([cls, records[i].id, records[j].id,
        dist(records, i, j, 'dhash'), dist(records, i, j, 'phash'),
        dist(records, i, j, 'dhashThumb'), dist(records, i, j, 'phashThumb')].join(','));
    }

    // ---- 1. category distance distributions ------------------------------
    const catPairs = {};      // name -> [[i,j], ...]
    function reg(name, list) { catPairs[name] = (catPairs[name] || []).concat(list); }

    // within-set pairs for the burst families, split by scale
    for (const cat of ['burst_tight', 'burst_loose', 'expression']) {
      const sub = records.map((r, i) => ({ r, i })).filter((x) => x.r.category === cat);
      const bySet = new Map();
      sub.forEach((x) => { if (!bySet.has(x.r.set)) bySet.set(x.r.set, []); bySet.get(x.r.set).push(x.i); });
      for (const [set, idx] of bySet) {
        const scale = records[idx[0]].scale;
        const list = [];
        for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) list.push([idx[a], idx[b]]);
        reg(cat, list); reg(`${cat}:${scale}`, list);
      }
    }
    // tight-vs-loose across the same scene identity (a realistic "run of shots")
    {
      const bySceneScale = new Map();
      records.forEach((r, i) => {
        if (r.category !== 'burst_tight' && r.category !== 'burst_loose') return;
        const k = r.sceneId; if (!bySceneScale.has(k)) bySceneScale.set(k, { t: [], l: [] });
        bySceneScale.get(k)[r.category === 'burst_tight' ? 't' : 'l'].push(i);
      });
      for (const [, v] of bySceneScale) {
        const list = [];
        v.t.forEach((a) => v.l.forEach((b) => list.push([a, b])));
        reg('burst_cross', list);
      }
    }
    // base-relative categories
    records.forEach((r, i) => {
      if (['geom_minor', 'geom_major', 'reencode', 'blur', 'recompose', 'subject_move'].indexOf(r.category) < 0) return;
      const baseIdx = idOf.get('base/' + r.scene);
      if (baseIdx == null || baseIdx === i) return;
      const cls = r.category === 'reencode' ? (r.role[0] === 'q' ? 'reencode_quality' : 'reencode_resolution')
        : r.category === 'blur' ? 'blur_vs_sharp' : r.category;
      reg(cls, [[baseIdx, i]]);
      reg(`role:${r.category}/${r.role}`, [[baseIdx, i]]);
    });
    // unrelated: different scene identity AND different scene name (fully unrelated)
    {
      const list = [];
      const pool = records.map((r, i) => i).filter((i) => ['burst_tight', 'base', 'expression', 'chain'].indexOf(records[i].category) >= 0);
      for (let a = 0; a < pool.length; a++) {
        for (let b = a + 1; b < pool.length; b++) {
          if (records[pool[a]].sceneId !== records[pool[b]].sceneId) list.push([pool[a], pool[b]]);
        }
      }
      reg('unrelated', list);
    }
    // chain
    {
      const byScene = new Map();
      records.forEach((r, i) => { if (r.category === 'chain') { if (!byScene.has(r.scene)) byScene.set(r.scene, []); byScene.get(r.scene).push(i); } });
      for (const [, idx] of byScene) {
        idx.sort((a, b) => records[a].role.localeCompare(records[b].role));
        for (let k = 0; k + 1 < idx.length; k++) reg('chain_adjacent', [[idx[k], idx[k + 1]]]);
        for (let k = 0; k + 2 < idx.length; k++) reg('chain_step2', [[idx[k], idx[k + 2]]]);
        reg('chain_ends', [[idx[0], idx[idx.length - 1]]]);
      }
    }

    const catTable = {};
    for (const [name, list] of Object.entries(catPairs)) {
      const row = {};
      for (const f of Object.keys(FIELDS)) row[f] = stats(list.map(([i, j]) => dist(records, i, j, f)));
      catTable[name] = row;
      if (!name.startsWith('role:')) {
        const sample = name === 'unrelated' ? list.filter((_, k) => k % 7 === 0) : list;
        sample.forEach(([i, j]) => addCsv(name, i, j));
      }
    }
    analysis.categoryDistances = catTable;

    // ---- 2. threshold sweep ----------------------------------------------
    // Analysed set excludes the deliberately ambiguous records.
    const anIdx = records.map((r, i) => i).filter((i) => ['chain', 'geom_major'].indexOf(records[i].category) < 0);
    const sweeps = {};
    for (const f of Object.keys(FIELDS)) {
      const pairs = [];
      for (let a = 0; a < anIdx.length; a++) {
        for (let b = a + 1; b < anIdx.length; b++) {
          const i = anIdx[a], j = anIdx[b];
          pairs.push({
            d: dist(records, i, j, f),
            pos: records[i].trueGroup === records[j].trueGroup,
            hard: records[i].trueGroup !== records[j].trueGroup && records[i].sceneId === records[j].sceneId
          });
        }
      }
      sweeps[f] = sweep(pairs);
    }
    analysis.thresholdSweep = sweeps;

    // recall per category at a set of candidate thresholds
    const candidates = [4, 6, 8, 10, 12, 14, 16];
    const recallByCat = {};
    for (const [name, list] of Object.entries(catPairs)) {
      if (name.startsWith('role:')) continue;
      recallByCat[name] = {};
      for (const f of Object.keys(FIELDS)) {
        recallByCat[name][f] = candidates.map((t) => {
          const n = list.filter(([i, j]) => dist(records, i, j, f) <= t).length;
          return +(n / list.length).toFixed(3);
        });
      }
    }
    analysis.groupRateByCategory = { thresholds: candidates, data: recallByCat };

    // ---- 3. clustering ----------------------------------------------------
    const clusterResults = {};
    for (const f of ['phashThumb', 'dhashThumb', 'phash', 'dhash']) {
      clusterResults[f] = {};
      for (const t of [8, 10, 12, 14]) {
        clusterResults[f][t] = {};
        for (const linkage of ['single', 'capped', 'complete']) {
          const items = anIdx.map((i) => ({ id: records[i].id, hash: records[i][f] }));
          const out = PH.cluster(items, t, { linkage, maxDiameter: 2 * t });
          const groupsGlobal = out.groups.map((g) => g.map((k) => anIdx[k]));
          const subset = anIdx.map((i) => records[i]);
          const localGroups = out.groups;
          clusterResults[f][t][linkage] = evalClustering(subset, localGroups, f);
          clusterResults[f][t][linkage].rejectedMerges = out.stats.rejectedMerges || 0;
          void groupsGlobal;
        }
      }
    }
    analysis.clustering = clusterResults;

    // ---- 4. chain behaviour ----------------------------------------------
    const chainReport = {};
    for (const f of ['phashThumb', 'dhashThumb']) {
      chainReport[f] = {};
      for (const t of [8, 10, 12]) {
        chainReport[f][t] = {};
        for (const linkage of ['single', 'capped', 'complete']) {
          const perScene = [];
          for (const sc of ['S0', 'S1', 'S2', 'S3', 'S4']) {
            const idx = records.map((r, i) => i).filter((i) => records[i].category === 'chain' && records[i].scene === sc)
              .sort((a, b) => records[a].role.localeCompare(records[b].role));
            const items = idx.map((i) => ({ hash: records[i][f] }));
            const out = PH.cluster(items, t, { linkage, maxDiameter: 2 * t });
            perScene.push({
              scene: sc,
              groups: out.groups.map((g) => g.map((k) => records[idx[k]].role)),
              diameters: out.groups.map((g) => PH.groupDiameter(items, g)),
              adjacent: idx.slice(0, -1).map((v, k) => PH.hamming(records[idx[k]][f], records[idx[k + 1]][f])),
              endToEnd: PH.hamming(records[idx[0]][f], records[idx[idx.length - 1]][f])
            });
          }
          chainReport[f][t][linkage] = perScene;
        }
      }
    }
    analysis.chain = chainReport;

    // ---- 5. representative nomination ------------------------------------
    const nomination = { blurSets: [], weightSweep: [], mixedSets: [] };
    const blurSets = new Map();
    records.forEach((r, i) => { if (r.category === 'blur') { if (!blurSets.has(r.scene)) blurSets.set(r.scene, []); blurSets.get(r.scene).push(i); } });

    function nominate(idxList, sharpField, resFromRecord, opts) {
      const members = idxList.map((i) => ({
        sharpness: records[i][sharpField],
        width: resFromRecord ? records[i].w : 1, height: resFromRecord ? records[i].h : 1
      }));
      return PH.nominateRepresentative(members, opts);
    }

    let correctFull = 0, correctThumb = 0, correctNoRes = 0, total = 0;
    for (const [scene, idx] of blurSets) {
      const roles = idx.map((i) => records[i].role);
      const nFull = nominate(idx, 'sharpness', true);
      const nThumb = nominate(idx, 'sharpnessThumb', true);
      const nNoRes = nominate(idx, 'sharpness', true, { sharpnessWeight: 1, resolutionWeight: 0 });
      const truthIdx = roles.indexOf('sharp');
      total++;
      if (nFull.index === truthIdx) correctFull++;
      if (nThumb.index === truthIdx) correctThumb++;
      if (nNoRes.index === truthIdx) correctNoRes++;
      nomination.blurSets.push({
        scene, roles,
        sharpnessFull: idx.map((i) => +records[i].sharpness.toFixed(4)),
        sharpnessThumb: idx.map((i) => +records[i].sharpnessThumb.toFixed(4)),
        megapixels: idx.map((i) => +((records[i].w * records[i].h) / 1e6).toFixed(2)),
        pickedFull: roles[nFull.index], pickedThumb: roles[nThumb.index], pickedSharpOnly: roles[nNoRes.index],
        scoresFull: nFull.scores.map((s) => +s.toFixed(3)),
        monotonic: (() => { // does sharpness decrease with blur rank?
          const pairs = idx.map((i) => [records[i].blurRank, records[i].sharpness]).filter((p) => p[0] != null);
          pairs.sort((a, b) => a[0] - b[0]);
          let ok = true; for (let k = 1; k < pairs.length; k++) if (pairs[k][1] > pairs[k - 1][1] + 1e-9 && pairs[k][0] > pairs[k - 1][0]) ok = false;
          return ok;
        })()
      });
    }
    nomination.accuracy = {
      sets: total,
      fullResSharpness: +(correctFull / total).toFixed(3),
      thumbnailSharpness: +(correctThumb / total).toFixed(3),
      sharpnessOnlyNoResolution: +(correctNoRes / total).toFixed(3)
    };

    // mixed sets: the realistic group = sharp original + downscaled export + blurred frames
    for (const [scene, idx] of blurSets) {
      const extra = records.map((r, i) => i).filter((i) => records[i].scene === scene && records[i].category === 'reencode' && /^res(200|400)$/.test(records[i].role));
      const all = idx.concat(extra);
      const roles = all.map((i) => records[i].category === 'reencode' ? 'reenc_' + records[i].role : records[i].role);
      const n = nominate(all, 'sharpness', true);
      nomination.mixedSets.push({ scene, roles, picked: roles[n.index], correct: roles[n.index] === 'sharp' });
    }
    // weight sensitivity
    for (const ws of [1.0, 0.9, 0.75, 0.6, 0.5, 0.35, 0.2]) {
      let ok = 0, okMixed = 0;
      for (const [scene, idx] of blurSets) {
        const roles = idx.map((i) => records[i].role);
        const n = nominate(idx, 'sharpness', true, { sharpnessWeight: ws, resolutionWeight: 1 - ws });
        if (roles[n.index] === 'sharp') ok++;
        const extra = records.map((r, i) => i).filter((i) => records[i].scene === scene && records[i].category === 'reencode' && /^res(200|400)$/.test(records[i].role));
        const all = idx.concat(extra);
        const roles2 = all.map((i) => records[i].category === 'reencode' ? 'reenc_' + records[i].role : records[i].role);
        const n2 = nominate(all, 'sharpness', true, { sharpnessWeight: ws, resolutionWeight: 1 - ws });
        if (roles2[n2.index] === 'sharp') okMixed++;
      }
      nomination.weightSweep.push({ sharpnessWeight: ws, blurSetAccuracy: +(ok / total).toFixed(3), mixedSetAccuracy: +(okMixed / total).toFixed(3) });
    }
    // does the nominee change if the group is a real burst (no artificial blur)?
    {
      const burstPicks = [];
      const bySet = new Map();
      records.forEach((r, i) => { if (r.category === 'burst_tight' || r.category === 'burst_loose') { if (!bySet.has(r.sceneId)) bySet.set(r.sceneId, []); bySet.get(r.sceneId).push(i); } });
      for (const [sid, idx] of bySet) {
        const n = nominate(idx, 'sharpness', true);
        const nT = nominate(idx, 'sharpnessThumb', true);
        burstPicks.push({ sceneId: sid, picked: records[idx[n.index]].id, pickedThumb: records[idx[nT.index]].id, agree: n.index === nT.index });
      }
      nomination.burstSets = { agreeFullVsThumb: burstPicks.filter((p) => p.agree).length, total: burstPicks.length, picks: burstPicks };
    }
    analysis.nomination = nomination;

    // ---- 6. full-res vs thumbnail hashing --------------------------------
    {
      const dSame = records.filter((r) => r.dhash === r.dhashThumb).length;
      const pSame = records.filter((r) => r.phash === r.phashThumb).length;
      analysis.fullVsThumbHash = {
        records: records.length,
        dhashIdentical: dSame, phashIdentical: pSame,
        dhashDist: stats(records.map((r) => PH.hamming(r.dhash, r.dhashThumb))),
        phashDist: stats(records.map((r) => PH.hamming(r.phash, r.phashThumb)))
      };
    }

    fs.writeFileSync(path.join(RESULTS, 'pairs.csv'), csvRows.join('\n'));

    // ---- 7. benchmark -----------------------------------------------------
    if (!NO_BENCH) {
      console.log('benchmarking 500 images...');
      const bench = await page.evaluate(() => window.runBench(500), null, { timeout: 900000 });
      analysis.bench = bench;
      fs.writeFileSync(path.join(RESULTS, 'bench.json'), JSON.stringify(bench, null, 1));
      console.log('bench:', JSON.stringify({
        decodeMs: Math.round(bench.decodeMs), fullResHashMs: Math.round(bench.fullResHashMs),
        thumbHashMs: Math.round(bench.thumbHashMs), pairwiseMs: +bench.pairwiseMs.toFixed(1)
      }));
    }

    fs.writeFileSync(path.join(RESULTS, 'analysis.json'), JSON.stringify(analysis, null, 1));

    // ---- 8. printable tables ---------------------------------------------
    const md = [];
    md.push('# Measured tables\n');
    md.push('## Hamming distance by pair category (320px thumbnail hashes)\n');
    md.push('| category | n | pHash med | pHash p95 | pHash max | dHash med | dHash p95 | dHash max |');
    md.push('|---|---|---|---|---|---|---|---|');
    const order = ['burst_tight', 'burst_tight:wide', 'burst_tight:medium', 'burst_tight:portrait',
      'expression', 'expression:wide', 'expression:medium', 'expression:portrait',
      'burst_loose', 'burst_loose:wide', 'burst_loose:medium', 'burst_loose:portrait', 'burst_cross',
      'reencode_quality', 'reencode_resolution', 'geom_minor', 'blur_vs_sharp', 'geom_major',
      'chain_adjacent', 'chain_step2', 'chain_ends', 'recompose', 'subject_move', 'unrelated'];
    for (const k of order) {
      const r = catTable[k]; if (!r) continue;
      md.push(`| ${k} | ${r.phashThumb.n} | ${r.phashThumb.median} | ${r.phashThumb.p95} | ${r.phashThumb.max} | ${r.dhashThumb.median} | ${r.dhashThumb.p95} | ${r.dhashThumb.max} |`);
    }
    md.push('\n## Per-role detail (base frame vs variant)\n');
    md.push('| variant | pHash | dHash |');
    md.push('|---|---|---|');
    for (const [k, v] of Object.entries(catTable)) {
      if (!k.startsWith('role:')) continue;
      md.push(`| ${k.slice(5)} | ${v.phashThumb.median} | ${v.dhashThumb.median} |`);
    }
    md.push('\n## Threshold sweep (pHash, thumbnail)\n');
    md.push('| t | recall | FNR | precision | FPR | hard-neg FPR | F1 | Youden J |');
    md.push('|---|---|---|---|---|---|---|---|');
    for (const r of sweeps.phashThumb.rows) {
      if (r.t > 24) break;
      md.push(`| ${r.t} | ${r.recall} | ${r.fnr} | ${r.precision} | ${r.fpr} | ${r.hardFpr} | ${r.f1} | ${r.youden} |`);
    }
    md.push('\n## Threshold sweep (dHash, thumbnail)\n');
    md.push('| t | recall | FNR | precision | FPR | hard-neg FPR | F1 | Youden J |');
    md.push('|---|---|---|---|---|---|---|---|');
    for (const r of sweeps.dhashThumb.rows) {
      if (r.t > 24) break;
      md.push(`| ${r.t} | ${r.recall} | ${r.fnr} | ${r.precision} | ${r.fpr} | ${r.hardFpr} | ${r.f1} | ${r.youden} |`);
    }
    md.push('\n## Clustering at t (pHash thumbnail)\n');
    md.push('| t | linkage | groups | largest | pair P | pair R | pair F1 | max diameter | rejected merges |');
    md.push('|---|---|---|---|---|---|---|---|---|');
    for (const t of [8, 10, 12, 14]) {
      for (const l of ['single', 'capped', 'complete']) {
        const c = clusterResults.phashThumb[t][l];
        md.push(`| ${t} | ${l} | ${c.groups} | ${c.largestGroup} | ${c.pairPrecision} | ${c.pairRecall} | ${c.pairF1} | ${c.maxGroupDiameter} | ${c.rejectedMerges} |`);
      }
    }
    md.push('\n## Group rate by category at candidate thresholds (pHash thumbnail)\n');
    md.push('| category | ' + candidates.map((t) => 't=' + t).join(' | ') + ' |');
    md.push('|---' + candidates.map(() => '|---').join('') + '|');
    for (const k of order) {
      const r = recallByCat[k]; if (!r) continue;
      md.push(`| ${k} | ${r.phashThumb.join(' | ')} |`);
    }
    fs.writeFileSync(path.join(RESULTS, 'tables.md'), md.join('\n'));

    console.log('\n=== SUMMARY ===');
    console.log('pHash thumb  best F1  :', JSON.stringify(sweeps.phashThumb.best));
    console.log('pHash thumb  best J   :', JSON.stringify(sweeps.phashThumb.bestYouden));
    console.log('dHash thumb  best F1  :', JSON.stringify(sweeps.dhashThumb.best));
    console.log('pHash full   best F1  :', JSON.stringify(sweeps.phash.best));
    console.log('nomination            :', JSON.stringify(nomination.accuracy));
    console.log('full-vs-thumb hash    :', JSON.stringify(analysis.fullVsThumbHash.phashDist));
    console.log('wrote', path.join(RESULTS, 'analysis.json'));
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
