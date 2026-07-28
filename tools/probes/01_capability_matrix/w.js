// Classic worker, loaded from a same-directory relative URL.
self.onmessage = function (e) {
  self.postMessage({ echo: e.data, kind: 'classic-file', ts: Date.now() });
};
