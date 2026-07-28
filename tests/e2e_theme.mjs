/**
 * file: e2e_theme.mjs
 * version: 1.0
 * author: Samuel Cao
 * created: 2026-07-28
 * last_updated: 2026-07-28
 * description: Verifies the dark/light surround toggle against the Claude Design spec: default, key binding, persistence, chrome colour, and the deliberate absence of an auto mode.
 * ai_update: Update last_updated and version. Append changelog at bottom.
 *
 * The light theme is deliberately NOT a white theme. A white surround makes a
 * photograph read darker, flatter and lower in contrast than the same photograph
 * against mid-grey, which is the interference the whole app exists to avoid;
 * ISO 3664 specifies mid-grey for a viewing surround. This test asserts that,
 * because "make it look cleaner" is exactly the change someone would make later
 * without knowing why it was grey.
 *
 * Run: node tests/e2e_theme.mjs
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT = path.join(ROOT, 'dist', 'photournament_v1.0.html');
if (!existsSync(ARTIFACT)) { console.error('run: node tools/build.mjs'); process.exit(1); }

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : ''));
};

// Persistent profile: localStorage has to survive a reload for this to mean anything.
const ctx = await chromium.launchPersistentContext(
  path.join(os.tmpdir(), 'pt-theme-' + Date.now()),
  { viewport: { width: 1400, height: 900 } }
);
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

/** Resolve tokens by PAINTING — oklch read back from fillStyle stays oklch. */
const snap = () => page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const x = c.getContext('2d');
  const rgb = (css) => { x.fillStyle = css; x.fillRect(0, 0, 1, 1); return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3); };
  const hex = (a) => '#' + a.map((v) => v.toString(16).padStart(2, '0')).join('');
  const cs = getComputedStyle(document.documentElement);
  const tok = (n) => rgb(cs.getPropertyValue(n).trim());
  return {
    theme: document.documentElement.dataset.theme || 'dark',
    bg: tok('--bg'), well: tok('--well'), text: tok('--text'),
    bgHex: hex(tok('--bg')),
    meta: (document.querySelector('meta[name="theme-color"]') || {}).content,
    colorScheme: cs.colorScheme,
    label: (document.querySelector('#topbar-theme') || {}).textContent
  };
});

await page.goto('file://' + ARTIFACT);
await page.waitForSelector('.pt-brandmark');

const d0 = await snap();
check('dark is the default', d0.theme === 'dark', d0.theme);
check('chrome colour matches the page', d0.meta === d0.bgHex, `${d0.meta} vs ${d0.bgHex}`);
check('the control offers the OTHER theme', /light/i.test(d0.label || ''), d0.label);

// T, from anywhere, with no field focused.
await page.keyboard.press('t');
await page.waitForTimeout(150);
const l = await snap();
check('T switches the surround', l.theme === 'light', l.theme);
check('chrome colour follows the theme', l.meta === l.bgHex, `${l.meta} vs ${l.bgHex}`);
check('color-scheme follows too, so native controls match', l.colorScheme === 'light', l.colorScheme);
check('the control now offers dark', /dark/i.test(l.label || ''), l.label);

// The point of the light theme.
const lum = (a) => 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
check('the light theme is NOT white', l.bgHex !== '#ffffff' && l.bg[0] < 240, l.bgHex);
check('the well is mid-grey, not white', l.well[0] > 90 && l.well[0] < 190,
  'well R=' + l.well[0]);
check('light really is lighter than dark', lum(l.bg) > lum(d0.bg),
  `${Math.round(lum(l.bg))} vs ${Math.round(lum(d0.bg))}`);
check('text inverts with the surround', lum(l.text) < lum(d0.text),
  `${Math.round(lum(l.text))} vs ${Math.round(lum(d0.text))}`);

// Persistence, and no flash of the wrong surround on the way back.
await page.reload();
await page.waitForTimeout(700);
const back = await snap();
check('the choice survives a reload', back.theme === 'light', back.theme);
check('chrome colour is correct after reload', back.meta === back.bgHex,
  `${back.meta} vs ${back.bgHex}`);

// Typing must never toggle the theme.
await page.evaluate(() => {
  var i = document.createElement('input');
  i.id = 'pt-typing-probe';
  document.body.appendChild(i);
  i.focus();
});
await page.keyboard.type('tttt');
const typed = await snap();
check('T inside a text field types instead of toggling', typed.theme === 'light', typed.theme);
await page.evaluate(() => { var e = document.getElementById('pt-typing-probe'); if (e) e.remove(); });

await page.keyboard.press('T');
await page.waitForTimeout(150);
check('shift-T toggles back', (await snap()).theme === 'dark');

// The spec is explicit that there is no auto mode.
const emulated = await (async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await page.waitForTimeout(600);
  return (await snap()).theme;
})();
check('the OS preference is ignored, as specified', emulated === 'dark', emulated);

check('zero console errors', errors.length === 0, errors.length ? '\n  ' + errors.join('\n  ') : '0');

await ctx.close();
console.log(failed === 0 ? '\nTHEME OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* CHANGELOG
 * v1.0 (2026-07-28): Initial release. Default, key binding, persistence, chrome
 *   colour, mid-grey assertions, typing safety, and the absence of an auto mode.
 */
