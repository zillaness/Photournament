// Generates out/h_<build>.html from harness.html by substituting the classic
// <script src> for the chosen libheif build. Relative path is 4 levels up from
// out/, i.e. the repo root, so the SAME html works under file:// and http://.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

const BUILDS = {
  wasm: '../../../../node_modules/libheif-js/libheif-wasm/libheif-bundle.js',
  asm: '../../../../node_modules/libheif-js/libheif/libheif.js'
};

const tpl = fs.readFileSync(path.join(ROOT, 'harness.html'), 'utf8');

for (const [name, src] of Object.entries(BUILDS)) {
  const html = tpl.replace('<!-- BUILD_SCRIPT_TAG -->', `<script src="${src}"></script>`);
  const p = path.join(OUT, `h_${name}.html`);
  fs.writeFileSync(p, html);
  console.log('wrote', p);
}
module.exports = { BUILDS, OUT, ROOT };
