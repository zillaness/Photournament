// Minimal static server with explicit MIME types (so .wasm is served as application/wasm).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8099);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? '/probe.html' : url;
  // Probe pages reference ../../../node_modules/libheif-js/*. Over http the browser
  // clamps that to /node_modules/..., so serve that prefix from the repo root and
  // everything else from this directory.
  const REPO = path.resolve(ROOT, '../../..');
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = safe.startsWith('/node_modules/')
    ? path.join(REPO, safe)
    : path.join(ROOT, safe);
  if (!file.startsWith(ROOT) && !file.startsWith(path.join(REPO, 'node_modules'))) {
    res.writeHead(403).end('forbidden'); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(buf);
  });
});
server.listen(PORT, '127.0.0.1', () => console.log('SERVER_READY http://localhost:' + PORT + '/'));
