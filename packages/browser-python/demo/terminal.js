/**
 * The single-terminal demo. One engine, one console, no controls. Deliberately shorter than
 * `main.js`: that file exercises the API surface, this one exists so the default appearance can be
 * looked at without anything else on the page arguing with it.
 */
import { defineBrowserPythonConsole } from "/bundle/console.js";
import { createBrowserPython } from "/dist/index.js";

defineBrowserPythonConsole();

const element = document.getElementById("console");

element.engine = createBrowserPython({
  profile: "minimal",
  pyodide: { indexURL: new URL("/runtime/", location.href).href },
});
element.historyOptions = { persistence: "local", key: "browser-python-terminal-demo" };

// Autostart: the page has nothing else on it, so waiting for a click to begin a twenty-second
// download would just be twenty seconds of an empty box.
element.start().catch((error) => {
  // The console renders the failure itself through its status listener; this keeps the reason in
  // the browser console too, where someone debugging a CDN or a CSP will look for it.
  console.error("[demo] the interpreter did not start", error);
});
