// Relative-URL worker that importScripts() a URL handed to it.
self.onmessage = function (e) {
  var o = {};
  try {
    importScripts(e.data.url);
    o.importScripts = 'ok';
    o.libheifType = typeof self.libheif;
    if (typeof self.libheif === 'function') {
      var m = self.libheif();
      o.hasHeifDecoder = typeof m.HeifDecoder;
    }
  } catch (err) {
    o.importScripts = 'FAILED ' + err.name + ': ' + err.message;
  }
  o.location = String(self.location.href).slice(0, 60);
  self.postMessage(o);
};
