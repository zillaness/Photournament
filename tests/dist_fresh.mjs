/**
 * file: dist_fresh.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Fails when the committed dist artifact does not match a fresh build of src, so a stale artifact can never be shipped or tested by mistake.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * dist/ is committed because the built HTML file IS the product — someone should
 * be able to download it straight from the branch. The cost of that is drift: a
 * source change with no rebuild leaves a shipped artifact that is quietly a
 * revision behind, and every other test still passes because they all run
 * against whatever dist happens to contain.
 *
 * That already happened once. This makes it loud.
 *
 * Run: node tests/dist_fresh.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD = path.join(ROOT, 'tools', 'build.mjs');

// Read the version the build itself declares, so this test never needs updating
// when the app version moves.
const appVersion = /const APP_VERSION = '([^']+)'/.exec(readFileSync(BUILD, 'utf8'))[1];

const targets = [
  { name: `photournament_v${appVersion}.html`, args: [] },
  { name: `photournament_slim_v${appVersion}.html`, args: ['--no-heic', '--out', `photournament_slim_v${appVersion}.html`] }
];

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

console.log('app version declared by tools/build.mjs: ' + appVersion + '\n');

for (const t of targets) {
  const live = path.join(ROOT, 'dist', t.name);

  if (!existsSync(live)) {
    check(t.name + ' exists', false, 'missing — run: node tools/build.mjs');
    continue;
  }

  // Preserve the committed artifact, rebuild over it, compare, then restore so
  // the test never leaves the working tree dirty.
  const backup = live + '.freshcheck';
  copyFileSync(live, backup);
  try {
    const before = readFileSync(backup, 'utf8');
    execFileSync('node', [BUILD, ...t.args], { cwd: ROOT, stdio: 'pipe' });
    const after = readFileSync(live, 'utf8');

    if (before === after) {
      check(t.name + ' matches a fresh build', true, (after.length / 1048576).toFixed(2) + ' MB');
    } else {
      // The banner carries a build date, so a same-day rebuild differs only if
      // the content really changed. Report where, to make the diff actionable.
      const a = before.split('\n');
      const b = after.split('\n');
      let firstDiff = -1;
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) { firstDiff = i; break; }
      }
      check(t.name + ' matches a fresh build', false,
        `differs from line ${firstDiff + 1} (committed ${a.length} lines, fresh ${b.length}). ` +
        `Run: node tools/build.mjs  and commit the result.`);
    }
  } finally {
    copyFileSync(backup, live);
    rmSync(backup, { force: true });
  }
}

// Nothing should still reference a previous app version.
const strays = [];
for (const dir of ['tests', 'tools']) {
  const files = execFileSync('ls', [path.join(ROOT, dir)], { encoding: 'utf8' }).trim().split('\n');
  for (const f of files) {
    if (!/\.(mjs|js)$/.test(f)) continue;
    const body = readFileSync(path.join(ROOT, dir, f), 'utf8');
    const m = body.match(/photournament(_slim)?_v(\d+\.\d+)\.html/g) || [];
    for (const hit of m) {
      if (!hit.includes('_v' + appVersion + '.')) strays.push(dir + '/' + f + ' -> ' + hit);
    }
  }
}
check('no test or tool references a stale artifact version', strays.length === 0,
  strays.length ? '\n  ' + strays.join('\n  ') : '0');

console.log(failed === 0 ? '\nDIST FRESH' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Rebuilds over the committed artifacts and
 *   compares byte for byte, restoring them afterwards, and scans tests and tools
 *   for references to a superseded app version.
 */
