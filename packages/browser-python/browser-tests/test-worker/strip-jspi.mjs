/**
 * Remove WebAssembly stack switching from THIS worker, before anything reads it.
 *
 * Imported first by `no-jspi.mjs`, so it evaluates before the real worker module and therefore
 * before Pyodide's own `"Suspending" in WebAssembly` check. The result is a worker whose
 * capability detection sees exactly what a browser without JSPI shows it - in every engine,
 * including the ones that have JSPI. A test seam only: it is served by the browser-test harness
 * and reached through the public `workerURL` option.
 */
for (const name of ["Suspending", "Suspender", "promising"]) {
  try {
    delete WebAssembly[name];
  } catch {
    // reported below
  }
}
if ("Suspending" in WebAssembly || "Suspender" in WebAssembly || "promising" in WebAssembly) {
  // Fail loudly rather than run the "no JSPI" suite against a worker that still has it.
  throw new Error("test seam: could not remove WebAssembly stack switching from this worker");
}
