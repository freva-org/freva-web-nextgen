// A worker without WebAssembly stack switching. See strip-jspi.mjs. Static imports evaluate in
// order, so the capability is gone before the real worker module - and Pyodide - load.
import "./strip-jspi.mjs";
import "/dist/worker/browser-python.worker.js";
