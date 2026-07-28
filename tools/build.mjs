/**
 * file: build.mjs
 * version: 1.1
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Zero-dependency build that concatenates src/ into a single self-contained HTML artifact in dist/.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * Why a single file rather than an HTML file plus an asset folder: from a file://
 * origin Chromium blocks fetch, XHR, module scripts with src, and relative-URL
 * Workers, all because the origin is the opaque string "null". Classic
 * <script src> survives, so an asset folder would technically work for JS — but
 * one file is what a user can actually move, copy and double-click without
 * losing half the app. See tools/probes/01_capability_matrix/FINDINGS.md.
 *
 * Deliberately does not minify. This is a tool someone should be able to open in
 * an editor and read.
 *
 * Usage:
 *   node tools/build.mjs                 full build
 *   node tools/build.mjs --no-heic       omit libheif (~1.4MB smaller, no HEIC support)
 *   node tools/build.mjs --out foo.html  override the output filename
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const APP_VERSION = '0.2';
const OUT_NAME = `photournament_v${APP_VERSION}.html`;

const argv = process.argv.slice(2);
const noHeic = argv.includes('--no-heic');
const outIdx = argv.indexOf('--out');
const outName = outIdx >= 0 ? argv[outIdx + 1] : OUT_NAME;

const LIBHEIF = path.join(ROOT, 'node_modules', 'libheif-js', 'libheif-wasm', 'libheif-bundle.js');

/** Numeric filename prefixes define load order. Sorting is the whole mechanism. */
function ordered(dir, ext) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => path.join(dir, f));
}

function readAll(files) {
  return files.map((f) => ({ name: path.basename(f), body: readFileSync(f, 'utf8') }));
}

/**
 * Guards against a class of bug that only shows up in the built artifact: a
 * module using ESM syntax works fine when served but silently fails to execute
 * as a classic script.
 */
function assertClassicScript(name, body) {
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const bad = /^\s*(import|export)\s/m.exec(stripped);
  if (bad) {
    throw new Error(
      `${name} uses ESM syntax ("${bad[0].trim()}"). Modules with src are CORS-blocked ` +
      `on file://, so every src/js file must be a classic script.`
    );
  }
}

/** A closing script tag inside a string literal would end the script element early. */
function safeForInlineScript(text) {
  return text.replace(/<\/script/gi, '<\\/script');
}

function human(n) {
  const u = ['B', 'KB', 'MB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

/* -------------------------------------------------------------------- build */

const shellPath = path.join(SRC, 'index.html');
if (!existsSync(shellPath)) throw new Error('missing src/index.html');
let html = readFileSync(shellPath, 'utf8');

const cssFiles = ordered(path.join(SRC, 'css'), '.css');
const jsFiles = ordered(path.join(SRC, 'js'), '.js');
if (!jsFiles.length) throw new Error('no src/js/*.js found — nothing to build');

const css = readAll(cssFiles);
const js = readAll(jsFiles);
js.forEach((f) => assertClassicScript(f.name, f.body));

const cssBlock =
  '<style>\n' +
  css.map((f) => `/* ===== ${f.name} ===== */\n${f.body}`).join('\n') +
  '\n</style>';

const jsBlock = js
  .map((f) => `<script>\n/* ===== ${f.name} ===== */\n${safeForInlineScript(f.body)}\n</script>`)
  .join('\n');

let libheif = '';
let libheifNote = 'omitted (--no-heic): HEIC files will be flagged as unsupported';
if (!noHeic) {
  if (!existsSync(LIBHEIF)) {
    throw new Error(`missing ${path.relative(ROOT, LIBHEIF)} — run: npm install`);
  }
  libheif = safeForInlineScript(readFileSync(LIBHEIF, 'utf8'));
  libheifNote = `libheif-js wasm bundle, ${human(libheif.length)}, inert until the first HEIC is seen`;
}

const built = new Date().toISOString().slice(0, 10);
const banner =
  `<!--\n` +
  `  Photournament v${APP_VERSION} — built ${built}\n` +
  `  GENERATED FILE. Do not edit; edit src/ and re-run: node tools/build.mjs\n` +
  `  ${js.length} script(s), ${css.length} stylesheet(s). ${libheifNote}.\n` +
  `  Open by double-clicking. Chromium only: resume and disk-write need the\n` +
  `  File System Access API, which Chromium alone implements.\n` +
  `-->`;

// Replace the dev-mode blocks wholesale, tokens included.
//
// The replacements MUST be functions, never strings. In String.replace, a
// replacement string treats $$, $&, $`, $' and $1 as substitution patterns, so
// passing source code directly silently rewrites it. This bit for real: `$$:` in
// a DOM helper object literal became `$:`, which redefined PT.dom.$ as
// querySelectorAll and broke every screen — while src/ still read correctly.
// A replacer function disables that interpretation entirely.
html = html.replace(/<!--BUILD:CSS-->[\s\S]*?<!--\/BUILD:CSS-->/, () => cssBlock);
html = html.replace(/<!--BUILD:JS-->[\s\S]*?<!--\/BUILD:JS-->/, () => jsBlock);
html = html.replace('<!--BUILD:LIBHEIF-->', () => libheif);
html = banner + '\n' + html;

for (const token of ['BUILD:CSS', 'BUILD:JS', 'BUILD:LIBHEIF']) {
  if (html.includes(`<!--${token}-->`)) throw new Error(`build token ${token} was not replaced`);
}

// Every byte of every source file must survive into the artifact. This is the
// guard against silent rewriting during assembly — the failure mode that
// produced a working src/ and a subtly broken dist/, which is the worst kind of
// bug this build can have.
for (const f of js) {
  if (!html.includes(safeForInlineScript(f.body))) {
    throw new Error(
      `${f.name} was altered during assembly — the artifact does not contain it verbatim. ` +
      `Check for string-replacement pattern expansion ($$, $&, $\`, $', $1) in build.mjs.`
    );
  }
}
for (const f of css) {
  if (!html.includes(f.body)) {
    throw new Error(`${f.name} was altered during assembly — the artifact does not contain it verbatim.`);
  }
}

mkdirSync(DIST, { recursive: true });
const outPath = path.join(DIST, outName);
writeFileSync(outPath, html);

const size = statSync(outPath).size;
console.log(`built  ${path.relative(ROOT, outPath)}  ${human(size)}`);
console.log(`       ${js.length} scripts: ${js.map((f) => f.name).join(', ')}`);
console.log(`       ${css.length} stylesheets: ${css.map((f) => f.name).join(', ') || '(none)'}`);
console.log(`       ${libheifNote}`);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Ordered concatenation, CSS and JS
 *   inlining, inert libheif payload, ESM-syntax guard, closing-tag escaping,
 *   and a --no-heic slim build.
  * v1.1 (2026-07-28): Replacements are now functions rather than strings, because
 *   String.replace expands $$, $&, $`, $' and $1 in a replacement string and was
 *   silently rewriting source during assembly. Added a guard asserting every
 *   source file survives into the artifact verbatim.
*/
