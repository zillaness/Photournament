/**
 * file: heic_fresh.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-08-02
 * last_updated: 2026-08-02
 * description: Fails when the committed standalone HEIC converter does not match a fresh build of its source, so the artifact in tools/heic_convert can never be quietly a revision behind.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * The same guard dist_fresh.mjs puts on the app, for the same reason: the built
 * HTML file IS the deliverable, so it is committed, and a committed artifact
 * drifts the moment someone edits the source without rebuilding. Every other
 * check would still pass, because they all run against whatever the file
 * happens to contain.
 *
 * Run: node tests/heic_fresh.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = path.join(ROOT, 'tools', 'heic_convert');
const BUILD = path.join(DIR, 'build.mjs');

// Read the artifact name out of the build script, so a version bump needs no
// edit here.
const OUT = /const OUT = path\.join\(ROOT, '([^']+)'\)/.exec(readFileSync(BUILD, 'utf8'))[1];
const live = path.join(DIR, OUT);

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

if (!existsSync(live)) {
  check(OUT + ' exists', false, 'missing — run: npm run build:heic');
} else {
  const backup = live + '.freshcheck';
  copyFileSync(live, backup);
  try {
    const before = readFileSync(backup, 'utf8');
    execFileSync('node', [BUILD], { cwd: ROOT, stdio: 'pipe' });
    const after = readFileSync(live, 'utf8');
    check(OUT + ' matches a fresh build', before === after,
      before === after
        ? (after.length / 1048576).toFixed(2) + ' MB'
        : 'differs — run: npm run build:heic  and commit the result');
  } finally {
    copyFileSync(backup, live);
    rmSync(backup, { force: true });
  }

  // The whole point of the artifact is that it needs nothing else on disk.
  const body = readFileSync(live, 'utf8');
  check('the artifact is self-contained', !/<!--BUILD:/.test(body), 'no unreplaced placeholders');
  check('libheif is inlined, not fetched',
    body.includes('id="libheif-src"') && body.length > 1.2e6,
    (body.length / 1048576).toFixed(2) + ' MB');
  check('nothing loads over the network',
    !/\bsrc\s*=\s*["']https?:/i.test(body) && !/\bhref\s*=\s*["']https?:\/\/[^"']*\.css/i.test(body));
}

console.log(failed === 0 ? '\nHEIC CONVERTER FRESH' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-08-02): Initial release. Rebuilds over the committed converter and
 *   compares byte for byte, restoring it afterwards, then asserts the artifact
 *   is genuinely self-contained.
 */
