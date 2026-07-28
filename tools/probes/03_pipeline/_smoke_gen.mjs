// Quick feasibility check: how big and how slow is one synthetic 4000x3000 JPEG?
import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
import { spawn } from 'node:child_process';

const DIR = '/home/user/Photournament/tools/probes/03_pipeline';
const srv = spawn('python3', ['-m', 'http.server', '8131', '--directory', DIR], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage();
p.on('console', (m) => console.log('[page]', m.text()));
await p.goto('http://127.0.0.1:8131/gen_corpus.html');
for (const q of [0.82, 0.9]) {
  const r = await p.evaluate(async (q) => {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const blob = await window.__genOne(1000 + i, q);
      out.push({ ms: Math.round(performance.now() - t), bytes: blob.size });
    }
    return out;
  }, q);
  console.log('quality', q, JSON.stringify(r));
}
await b.close();
srv.kill();
