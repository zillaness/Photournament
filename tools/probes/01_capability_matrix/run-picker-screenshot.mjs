// Attempted visual proof that showDirectoryPicker() opens a real native
// folder-chooser dialog on a file:// origin.
//
// NOTE: the bundled ffmpeg (/opt/pw-browsers/ffmpeg-1011) is compiled WITHOUT
// x11grab, so the screenshot step fails ("Unknown input format: 'x11grab'") and
// no PNG is produced. The script still prints the decisive evidence: the
// showDirectoryPicker() promise stays in phase "pending" while the dialog is
// open, instead of rejecting with AbortError as it does headlessly.
//
//   xvfb-run -a --server-args="-screen 0 1280x1024x24" node run-picker-screenshot.mjs
//
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_('/opt/node22/lib/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = '/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux';
const URL_ = 'file://' + path.join(HERE, 'probe.html');
const OUT = path.join(HERE, 'file-origin-directory-picker.png');

const browser = await chromium.launch({ headless: false, channel: 'chromium', args: ['--window-size=1200,900'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction('window.__DONE__ === true', null, { timeout: 90000 }).catch(() => {});
page.click('#pickerDir').catch(() => {});
await page.waitForTimeout(2500);

const state = await page.evaluate(() => JSON.parse(JSON.stringify(window.__pickerResult)));
console.error('picker state while dialog should be open:', JSON.stringify(state));

const r = spawnSync(FFMPEG, ['-y', '-f', 'x11grab', '-video_size', '1280x1024',
  '-i', process.env.DISPLAY || ':99', '-frames:v', '1', OUT], { encoding: 'utf8' });
console.error('ffmpeg exit', r.status, (r.stderr || '').split('\n').slice(-4).join('\n'));

await browser.close();
console.error('screenshot ->', OUT);
