/**
 * WHICH SUITES CI RUNS, as data rather than as a side effect of running them. `run.mjs` is a
 * script: importing it executes every suite, so the list it iterates lives here, where the
 * release-gate audit in `tests/browser-gate.test.ts` can read it without launching a browser.
 */

/** Every suite the aggregate run executes by default, in the order it runs them. */
export const SUITES = [
  "console.mjs", // the component, against a mock engine - fast, and cross-browser
  "console-keyboard.mjs", // every shortcut, driven with real keystrokes
  "console-pointer.mjs", // a real mouse: clicking the console must let you type in it
  "console-lifecycle.mjs", // startup, a failed start, and whether a retry retries
  "console-paste-and-caret.mjs", // a real clipboard paste, and whether the cursor is painted
  "console-mobile.mjs", // the component at 390px with touch, where there are no modifier keys
  "console-files.mjs", // the file panel: preview, download, two-step delete
  "console-real-engine.mjs", // the component, against a real interpreter
  "repl.mjs", // needs the interpreter only - runs anywhere
  "workspace-errors.mjs", // the disk-backed workspace's failure paths, with the failures injected
  "workspace.mjs", // real file output: NetCDF, Parquet, PNG, ZIP, download, delete, two tabs
  "workspace-stream.mjs", // a large artifact streamed out, hashed, cancelled and frozen
  "workspace-lifecycle.mjs", // protocol mismatch, simultaneous tabs, graceful and forced shutdown
  "csp.mjs", // the published Content-Security-Policy, served and enforced
  "embedding-waterpark.mjs", // the console framed by a portal, under the two production headers
  "embedding-two-origin.mjs", // the RECOMMENDED topology: two origins, and a parent-owned download
  "persistence-restart.mjs", // a REAL browser restart: what survives it, and what is reclaimed
  "bundled-consumer.mjs", // packs, installs and BUNDLES the package, the way a portal does
  "http-adapter.mjs", // needs the interpreter only - runs anywhere
  "display.mjs", // needs the interpreter only - runs anywhere
  "fsspec-adapter.mjs", // needs the fsspec wheel (pure Python, so widely obtainable)
  "s3-adapter.mjs", // anonymous s3:// mapping and refusals; the fsspec wheel only
  "zarr.mjs", // needs the scientific wheels
  "addons.mjs", // curated add-ons: mirrored Dask wheels and offline Natural Earth data
  "matplotlib.mjs", // needs the matplotlib wheel
  "micropip.mjs", // needs the micropip wheel; installs a local fixture wheel, never PyPI
];

/**
 * Suites that reach a PUBLIC PACKAGE INDEX, off by default and appended under
 * `BROWSER_PYTHON_PACKAGE_INDEX=1`.
 *
 * SEPARATE FROM `NETWORK_SUITES`, because the two say different things. Those measure whether
 * someone else's SERVICE behaves - a CMIP6 store, a live Freva deployment - and a red result is
 * an acceptance finding about that server. These need only PyPI, and they need it because the
 * `freva-client` profile installs its wheel with dependency resolution: micropip resolves the
 * ordinary dependencies from the index during startup. A suite that cannot run without it is
 * not a default gate, whatever it is testing, because a PyPI outage would then be indistinguishable
 * from a regression - and a default gate a developer cannot run on a train is one they stop
 * running. CI enables this explicitly, in a step named for what it needs.
 */
export const PACKAGE_INDEX_SUITES = [
  "freva-client.mjs", // the freva-client profile: imports, constructs, excludes intake-esm
  "freva-auth.mjs", // device flow against a local OIDC provider - never Eve, but PyPI for the wheel
  "freva-persistence-restart.mjs", // the real token, through a real browser restart
  // The published `packageIndex: true` grant, served as a real header, in both directions. Here
  // rather than in `csp.mjs` because it starts the same profile those three do, off the same
  // derived wheel and the same index; `csp.mjs` stays a default gate that needs neither.
  "csp-package-index.mjs",
];

/**
 * Suites that are OFF by default and appended only under `BROWSER_PYTHON_NETWORK=1`. A required
 * test that depends on a third party's uptime teaches a team to ignore red CI, so the real CMIP6
 * store is opt-in - and so is the live Freva deployment, which measures whether SOMEONE ELSE'S
 * server permits this origin. CORS is the deployment's decision and cannot be repaired from inside
 * the page, so a red result there is an acceptance finding about a server, not a regression here.
 */
export const NETWORK_SUITES = ["cmip6.mjs", "freva-live.mjs"];

/**
 * The console suites run in every engine that is installed; the Pyodide ones do not. `console.mjs`
 * uses a mock engine precisely so it can afford three browsers, and the engine's own JSPI
 * requirements make Firefox and WebKit a separate question that the engine phase owns.
 */
export const CROSS_BROWSER = Object.freeze([
  "console.mjs",
  "console-keyboard.mjs",
  "console-mobile.mjs",
  // Focus-after-click is exactly the kind of thing each engine gets subtly wrong on its own.
  "console-pointer.mjs",
  "console-lifecycle.mjs",
  "console-paste-and-caret.mjs",
  "console-files.mjs",
]);
