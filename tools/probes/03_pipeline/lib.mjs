// Shared driver helpers for the 03_pipeline probes.
import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
export const { chromium } = require('playwright');

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export const DIR = '/home/user/Photournament/tools/probes/03_pipeline';
export const CORPUS = path.join(DIR, 'corpus');
export const OUT = path.join(DIR, 'out');
fs.mkdirSync(OUT, { recursive: true });

// In-process static server. An earlier version shelled out to
// `python3 -m http.server`; that process died partway through a 20-minute sweep
// and every subsequent page.goto failed with ERR_CONNECTION_REFUSED. Keeping the
// server inside the driver removes that failure mode.
export function serve(port) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.css': 'text/css',
  };
  const server = http.createServer((req, res) => {
    try {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const file = path.join(DIR, rel || 'harness.html');
      if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(fs.readFileSync(file));
    } catch (e) {
      res.writeHead(500).end(String(e && e.message));
    }
  });
  server.on('clientError', (e, sock) => sock.destroy());
  server.listen(port, '127.0.0.1');
  return { kill: () => server.close() };
}

export async function waitPort(port, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/harness.html`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server never came up on ' + port);
}

export function corpusFiles(limit) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.jpg')) out.push(f);
    }
  };
  walk(CORPUS);
  return limit ? out.slice(0, limit) : out;
}

// Total resident memory of the whole Chromium process tree. The JS heap misses
// ImageBitmap backing stores entirely — those live in the renderer's non-JS
// memory — so this is the number that actually answers "does it plateau".
export function browserRssMB(rootPid) {
  try {
    const pids = new Set([rootPid]);
    let changed = true;
    const all = fs
      .readdirSync('/proc')
      .filter((x) => /^\d+$/.test(x))
      .map((x) => {
        try {
          const st = fs.readFileSync(`/proc/${x}/stat`, 'utf8');
          const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
          return { pid: Number(x), ppid };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    while (changed) {
      changed = false;
      for (const p of all) {
        if (!pids.has(p.pid) && pids.has(p.ppid)) {
          pids.add(p.pid);
          changed = true;
        }
      }
    }
    let kb = 0;
    for (const pid of pids) {
      try {
        const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
        if (m) kb += Number(m[1]);
      } catch {
        /* process exited */
      }
    }
    return +(kb / 1024).toFixed(0);
  } catch {
    return null;
  }
}

// Same tree walk, but split by Chromium process type. The renderer number is
// the one that matters: ImageBitmap backing stores and Blob data live there (or
// in the browser process for large blobs), not in the JS heap.
export function rssByType(rootPid) {
  const pids = new Set([rootPid]);
  const all = fs
    .readdirSync('/proc')
    .filter((x) => /^\d+$/.test(x))
    .map((x) => {
      try {
        const st = fs.readFileSync(`/proc/${x}/stat`, 'utf8');
        return { pid: Number(x), ppid: Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of all) {
      if (!pids.has(p.pid) && pids.has(p.ppid)) {
        pids.add(p.pid);
        changed = true;
      }
    }
  }
  const out = { node: 0, browser: 0, renderer: 0, gpu: 0, utility: 0, other: 0, total: 0 };
  for (const pid of pids) {
    let rssKb = 0,
      cmd = '';
    try {
      const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
      if (m) rssKb = Number(m[1]);
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      continue;
    }
    const mb = rssKb / 1024;
    out.total += mb;
    if (pid === rootPid) out.node += mb;
    else if (/--type=renderer/.test(cmd)) out.renderer += mb;
    else if (/--type=gpu-process/.test(cmd)) out.gpu += mb;
    else if (/--type=utility/.test(cmd)) out.utility += mb;
    else if (/headless_shell|chrome|chromium/.test(cmd)) out.browser += mb;
    else out.other += mb;
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(0);
  return out;
}

export function typedSampler(pid, intervalMs = 200) {
  const s = [];
  const t = setInterval(() => s.push(rssByType(pid)), intervalMs);
  return {
    samples: s,
    stop() {
      clearInterval(t);
      if (!s.length) return null;
      const keys = ['renderer', 'browser', 'gpu', 'total'];
      const half = Math.floor(s.length / 2);
      const o = { samples: s.length };
      for (const k of keys) {
        const v = s.map((x) => x[k]);
        o[k] = {
          start: v[0],
          peak: Math.max(...v),
          end: v[v.length - 1],
          firstHalfMean: Math.round(v.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(1, half)),
          secondHalfMean: Math.round(v.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, v.length - half)),
          series: v.filter((_, i) => i % Math.max(1, Math.ceil(v.length / 30)) === 0),
        };
      }
      return o;
    },
  };
}

export function rssSampler(pid, intervalMs = 250) {
  const samples = [];
  const t = setInterval(() => {
    const v = browserRssMB(pid);
    if (v != null) samples.push(v);
  }, intervalMs);
  return {
    stop() {
      clearInterval(t);
      if (!samples.length) return null;
      const half = Math.floor(samples.length / 2);
      return {
        samples: samples.length,
        startMB: samples[0],
        peakMB: Math.max(...samples),
        endMB: samples[samples.length - 1],
        firstHalfMeanMB: Math.round(samples.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(1, half)),
        secondHalfMeanMB: Math.round(samples.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, samples.length - half)),
        series: samples.filter((_, i) => i % Math.max(1, Math.ceil(samples.length / 40)) === 0),
      };
    },
  };
}

let lastSaved = '';
export function save(name, obj) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 1));
  if (lastSaved !== name) {
    console.log('wrote out/' + name);
    lastSaved = name;
  }
}
