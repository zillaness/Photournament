// Module worker, loaded from a same-directory relative URL.
self.onmessage = (e) => {
  self.postMessage({ echo: e.data, kind: 'module-file', ts: Date.now() });
};
export {};
