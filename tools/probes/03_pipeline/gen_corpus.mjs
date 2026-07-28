// Generates the synthetic 4000x3000 JPEG corpus onto disk.
//
// Images are drawn in Chromium (OffscreenCanvas -> convertToBlob) because
// nothing in this environment can encode JPEG from Node: the bundled ffmpeg is
// a Playwright-minimal build with only png/libvpx encoders and no lavfi.
// Blobs reach disk via the browser's own download machinery, which avoids
// pushing ~1.5 GB back through the CDP connection as base64.
//
// Usage: node gen_corpus.mjs [count] [tabs] [quality]

import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = '/home/user/Photournament/tools/probes/03_pipeline';
const OUT = path.join(DIR, 'corpus');
const COUNT = Number(process.argv[2] || 500);
const TABS = Number(process.argv[3] || 4);
const QUALITY = Number(process.argv[4] || 0.82);
const PORT = 8131;

// Folder tree so the ingest probe exercises PRD 4.1 recursive structure.
const FOLDERS = ['Day1', 'Day2', 'Day3', 'Day4/Morning', 'Day4/Evening', 'Misc'];
const WEIGHTS = [0.18, 0.22, 0.2, 0.12, 0.13, 0.15];

function planFiles(n) {
  const plan = [];
  let i = 0;
  FOLDERS.forEach((f, fi) => {
    const k = fi === FOLDERS.length - 1 ? n - plan.length : Math.round(n * WEIGHTS[fi]);
    for (let j = 0; j < k; j++) {
      plan.push({ seed: 10000 + i, rel: `${f}/IMG_${String(1000 + i).padStart(5, '0')}.jpg` });
      i++;
    }
  });
  return plan.slice(0, n);
}

const plan = planFiles(COUNT);
fs.rmSync(OUT, { recursive: true, force: true });
for (const f of FOLDERS) fs.mkdirSync(path.join(OUT, f), { recursive: true });

const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', DIR], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const t0 = Date.now();
let done = 0;

const chunks = Array.from({ length: TABS }, () => []);
plan.forEach((p, i) => chunks[i % TABS].push(p));

await Promise.all(
  chunks.map(async (chunk, ti) => {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/gen_corpus.html`);
    for (const item of chunk) {
      const flat = item.rel.replace(/\//g, '__');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120000 }),
        page.evaluate(
          async ([seed, q, name]) => {
            const blob = await window.__genOne(seed, q);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            return blob.size;
          },
          [item.seed, QUALITY, flat]
        ),
      ]);
      await download.saveAs(path.join(OUT, item.rel));
      done++;
      if (done % 25 === 0) {
        process.stdout.write(`  ${done}/${COUNT}  ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
      }
    }
    await ctx.close();
    void ti;
  })
);

await browser.close();
srv.kill();

let bytes = 0;
const listing = [];
for (const p of plan) {
  const st = fs.statSync(path.join(OUT, p.rel));
  bytes += st.size;
  listing.push({ rel: p.rel, size: st.size });
}
fs.writeFileSync(path.join(DIR, 'corpus_manifest.json'), JSON.stringify({ count: plan.length, bytes, files: listing }, null, 1));
console.log(
  `corpus: ${plan.length} files, ${(bytes / 1e6).toFixed(0)} MB total, ` +
    `mean ${(bytes / plan.length / 1e6).toFixed(2)} MB, in ${((Date.now() - t0) / 1000).toFixed(1)}s`
);
