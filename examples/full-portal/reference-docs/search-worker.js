// A stand-in for a documentation generator's search index worker. It exists so
// the artifact's `worker-src 'self'` is exercised by a real worker rather than
// asserted from a policy file.
self.onmessage = (event) => {
  self.postMessage(`indexed:${String(event.data)}`);
};
