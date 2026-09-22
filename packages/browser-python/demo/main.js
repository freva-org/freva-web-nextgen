/**
 * The demo's script: plain JavaScript, importing the built package as any consumer would. It
 * doubles as the plain-HTML/JavaScript example, so there is deliberately no framework, no bundler
 * step visible to the reader, and no styling decision beyond the nine custom properties in the
 * page's own CSS.
 */
import { defineBrowserPythonConsole } from "/bundle/console.js";
import { createBrowserPython } from "/dist/index.js";

defineBrowserPythonConsole();

const element = document.getElementById("console");
const themed = document.getElementById("themed");
const $ = (id) => document.getElementById(id);

// ONE engine for the page, shared by both consoles - the pattern a portal wants, where a second
// console must not mean a second interpreter and a second twenty-megabyte download. The engine is
// injected, so neither element owns it or will dispose it when it is moved in the DOM.
let engine = createBrowserPython({
  profile: "minimal",
  pyodide: { indexURL: new URL("/runtime/", location.href).href },
});
element.engine = engine;
themed.engine = engine;
themed.banner = false;

element.historyOptions = { persistence: "local", key: "browser-python-demo" };

$("theme").addEventListener("change", (event) => {
  element.theme = event.target.value;
});

$("persistence").addEventListener("change", (event) => {
  // Applied live. Switching to `memory` or `none` is what a shared machine wants, and it takes
  // effect for everything typed afterwards.
  element.historyOptions = { persistence: event.target.value, key: "browser-python-demo" };
});

$("live-highlight").addEventListener("change", (event) => {
  // Live highlighting can be turned off independently; submitted commands stay highlighted.
  element.highlightOptions = { live: event.target.checked, submittedCommands: true };
});

$("profile").addEventListener("change", async (event) => {
  // A profile change needs a new interpreter, so the old one is disposed explicitly - this page
  // owns the engine it created.
  engine.dispose();
  engine = createBrowserPython({
    profile: event.target.value,
    pyodide: { indexURL: new URL("/runtime/", location.href).href },
  });
  element.engine = engine;
  themed.engine = engine;
  await element.start();
});

void element.start();
