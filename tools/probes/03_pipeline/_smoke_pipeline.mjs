import { chromium, serve, waitPort, CORPUS, DIR } from './lib.mjs';

const PORT = 8132;
const srv = serve(PORT);
await waitPort(PORT);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/harness.html`);

console.log('setInputFiles(directory)...');
try {
  await page.setInputFiles('#picker', CORPUS);
  console.log('directory upload OK');
} catch (e) {
  console.log('directory upload FAILED:', e.message);
}
console.log(JSON.stringify(await page.evaluate(() => window.__probe.loadFilesFromInput()), null, 1));

await page.evaluate(() => window.__probe.clearDB());
const r = await page.evaluate(() =>
  window.__probe.runIngest({ workers: 4, kind: 'blob', strategy: 'sized', limit: 12 })
);
console.log(JSON.stringify(r, null, 1));

await browser.close();
srv.kill();
void DIR;
