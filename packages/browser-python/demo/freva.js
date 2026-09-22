/**
 * The freva-client profile, demonstrated. Separate from `terminal.js` because this profile needs
 * two things that one does not: the wheels, and a decision about credentials. Both are shown
 * explicitly rather than defaulted, since both are what a deployment has to think about.
 */
import { defineBrowserPythonConsole } from "/bundle/console.js";
import { createBrowserPython } from "/dist/index.js";

defineBrowserPythonConsole();

const element = document.getElementById("console");

element.engine = createBrowserPython({
  profile: "freva-client",
  pyodide: { indexURL: new URL("/runtime/", location.href).href },
  // Static files, same origin. The default is `freva-wheels/` beside the runtime; the demo server
  // publishes exactly that path.
  wheelhouseURL: new URL("/freva-wheels/", location.href).href,
  // Deliberately OFF in the demo. Persistence keeps a refresh token in IndexedDB, readable by any
  // same-origin script - including a package installed at this very prompt. A demo served from a
  // shared origin is the wrong place to make that trade, and leaving it off keeps the default
  // honest.
  persistCredentials: false,
});

// `session`, not `local`: someone trying this out may well paste a presigned URL or a token, and a
// history that outlives the tab is a place for those to sit.
element.historyOptions = { persistence: "session", key: "browser-python-freva-demo" };

element.start().catch((error) => {
  console.error("[demo] the freva-client profile did not start", error);
});
