// Same body as the inline HEAVY_WORKER in probe.html, as a real relative-URL worker script.
self.onmessage = async function (e) {
  var out = { steps: {} };
  try {
    var bmp = await createImageBitmap(e.data.blob);
    out.steps.createImageBitmap = bmp.width + 'x' + bmp.height;
    var oc = new OffscreenCanvas(bmp.width, bmp.height);
    var ctx = oc.getContext('2d');
    out.steps.offscreen2d = !!ctx;
    ctx.drawImage(bmp, 0, 0);
    var px = ctx.getImageData(0, 0, 1, 1).data;
    out.steps.getImageData = Array.from(px).join(',');
    var jb = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    out.steps.convertToBlob = jb.type + ' ' + jb.size + 'B';
    var mod = await WebAssembly.instantiate(e.data.wasm, {});
    out.steps.wasm = mod.instance.exports.add(20, 22);
    out.steps.crypto = !!(self.crypto && self.crypto.subtle);
    if (self.crypto && self.crypto.subtle) {
      var d = await self.crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3]));
      out.steps.digestBytes = d.byteLength;
    }
    out.steps.indexedDBInWorker = (typeof indexedDB !== 'undefined');
    out.steps.fetchInWorker = (typeof fetch === 'function');
    out.steps.isSecureContext = self.isSecureContext;
    out.steps.location = String(self.location.href).slice(0, 80);
  } catch (err) { out.error = (err && err.name) + ': ' + (err && err.message); }
  self.postMessage(out);
};
