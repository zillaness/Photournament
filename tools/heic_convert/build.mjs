/**
 * @file build.mjs
 * @version 1.0
 * @author Samuel Cao
 * @created 2026-08-02
 * @lastUpdated 2026-08-02
 * @description Inlines the libheif-js WASM bundle into src/app.html and emits the standalone single-file converter.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * The same shape as Photournament's tools/build.mjs, minus everything that
 * project needs and this one does not: one source file, one placeholder, one
 * artifact. libheif-bundle.js carries its own wasm as base64 (~1.38 MB of the
 * 1.46 MB file), which is why the output needs no sidecar .wasm and runs from
 * file:// with no network at all.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const SRC = path.join(ROOT, 'src', 'app.html');
const OUT = path.join(ROOT, 'heic_convert_v1.0.html');

// The app's own dependency, so the converter and Photournament decode with the
// identical libheif build rather than drifting apart.
const LIBHEIF = path.join(
  ROOT, '..', '..', 'node_modules', 'libheif-js', 'libheif-wasm', 'libheif-bundle.js'
);

if (!existsSync(LIBHEIF)) {
  throw new Error(`missing ${LIBHEIF} — run: npm install`);
}

/** A closing script tag inside the payload would end the script element early. */
function safeForInlineScript(text) {
  return text.replace(/<\/script/gi, '<\\/script');
}

function human(n) {
  const u = ['B', 'KB', 'MB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

let html = readFileSync(SRC, 'utf8');
const libheif = safeForInlineScript(readFileSync(LIBHEIF, 'utf8'));

if (!html.includes('<!--BUILD:LIBHEIF-->')) throw new Error('src/app.html has no <!--BUILD:LIBHEIF--> placeholder');
html = html.replace('<!--BUILD:LIBHEIF-->', () => libheif);

// A leftover placeholder means a silently broken artifact, so fail loudly.
if (html.includes('<!--BUILD:')) throw new Error('an unreplaced BUILD placeholder survived');

writeFileSync(OUT, html);
console.log(`built  ${path.relative(ROOT, OUT)}  ${human(html.length)}`);
console.log(`       libheif-js wasm bundle inlined, ${human(libheif.length)}`);

/** CHANGELOG
 * v1.0 (2026-08-02): Initial release.
 */
