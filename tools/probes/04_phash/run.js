/**
 * run.js — PROBE ONLY. Drives the pHash probe in real Chromium from a file://
 * URL, exactly the delivery model PRD section 8 commits to.
 *
 *   node tools/probes/04_phash/run.js [--samples]
 *
 * Requires: export NODE_PATH=/opt/node22/lib/node_modules
 *           export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
 *
 * Writes ./results/*.json. With --samples it also writes a contact sheet of a
 * few corpus frames to ./corpus/ for visual inspection; delete that directory
 * when you are done looking at it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR = __dirname;
const RESULTS = path.join(DIR, 'results');
const CORPUS = path.join(DIR, 'corpus');
const WANT_SAMPLES = process.argv.includes('--samples');

function w(name, obj) {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, name), JSON.stringify(obj, null, 2));
  console.log('  wrote results/' + name);
}

(async () => {
  const t0 = Date.now();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  const url = 'file://' + path.join(DIR, 'harness.html');
  console.log('opening ' + url);
  await page.goto(url);

  const shape = await page.evaluate(() => window.moduleShape());
  console.log('module shape:', JSON.stringify(shape, null, 2));
  if (shape.location !== 'file:') throw new Error('not a file:// origin');
  w('module_shape.json', shape);

  console.log('\nself tests...');
  const self = await page.evaluate(() => window.selfTest());
  self.checks.forEach((c) => console.log('  ' + (c.pass ? 'PASS' : 'FAIL') + '  ' + c.name +
    (c.detail !== undefined ? '   [' + c.detail + ']' : '')));
  w('selftest.json', self);
  if (!self.allPass) console.log('  !!! SELF TESTS FAILED');

  console.log('\nbuilding corpus (this is the slow part)...');
  const corpus = await page.evaluate(() => window.runCorpus(), null);
  console.log('  ' + corpus.records.length + ' frames, ' + corpus.samples.length + ' samples');
  const byCat = {};
  corpus.records.forEach((r) => { byCat[r.category] = (byCat[r.category] || 0) + 1; });
  console.log('  by category: ' + JSON.stringify(byCat));
  w('corpus_records.json', { count: corpus.records.length, byCategory: byCat, records: corpus.records });

  if (WANT_SAMPLES) {
    fs.mkdirSync(CORPUS, { recursive: true });
    corpus.samples.forEach((s) => {
      const file = path.join(CORPUS, s.id.replace(/[^a-z0-9]+/gi, '_') + '.jpg');
      fs.writeFileSync(file, Buffer.from(s.dataURL.split(',')[1], 'base64'));
    });
    console.log('  wrote ' + corpus.samples.length + ' sample jpgs to corpus/');
  }

  console.log('\nanalysis...');
  const analysis = await page.evaluate((recs) => window.runAnalysis(recs), corpus.records);
  w('analysis.json', analysis);

  console.log('\nbenchmarks...');
  const bench = await page.evaluate((recs) => window.runBench(recs), corpus.records);
  w('bench.json', bench);
  console.log(JSON.stringify(bench, null, 2));

  w('console_errors.json', consoleErrors);
  if (consoleErrors.length) console.log('\nCONSOLE ERRORS:\n' + consoleErrors.join('\n'));

  await browser.close();
  console.log('\ndone in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
})().catch((e) => { console.error(e); process.exit(1); });
