// ES module loaded via <script type="module" src="./m.js">
window.__MODULE_SCRIPT_LOADED__ = true;
window.dispatchEvent(new CustomEvent('probe-module-loaded'));
export const ok = true;
