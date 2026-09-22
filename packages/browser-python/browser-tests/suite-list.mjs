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
  "capability-fallbacks.mjs", // no JSPI, no sync access handles: the fallbacks, in every engine
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
 * WHAT EACH SUITE NEEDS FROM A BROWSER ENGINE, as data. Four categories:
 *
 *  - `console`: the component against a MOCK engine. Cheap, so the default gate runs these in every
 *    engine listed in `BROWSER_ENGINES`.
 *  - `portable`: a real interpreter, and nothing an engine may lack. Runs in the selected engine.
 *  - `capability`: a real interpreter, plus a capability an engine may or may not have
 *    (`capabilities` names it). The suite runs everywhere, asks the WORKER what it has, exercises
 *    the feature when it is there and the documented fallback when it is not - reporting the
 *    latter as NOT APPLICABLE with the reason, never as a pass. A suite that uses a capability
 *    for PART of its checks is `portable`, and reports those parts as not applicable instead.
 *  - `chromium`: exercises something only Chromium provides, with `reason` saying what. None of
 *    the default suites is in this category any more; it exists so a future one has to say why.
 *
 * `tests/browser-gate.test.ts` fails if a suite the runner can run has no entry here, if an entry
 * names a suite the runner does not know, or if a category or capability is not one of these.
 */
export const CAPABILITIES = Object.freeze({
  jspi:
    "WebAssembly JSPI (stack switching): a synchronous Python call waiting on an asynchronous " +
    "fetch, which is how a remote Zarr store is read",
  "sync-access-handles":
    "OPFS synchronous access handles in a dedicated Worker, which back the disk-based /workspace",
  // Parts of suites, not whole features:
  "memory-measurement":
    "performance.measureUserAgentSpecificMemory(), the only in-page view of ArrayBuffer memory",
  "save-file-picker": "window.showSaveFilePicker(), the native save dialog",
  "transferable-streams": "a WritableStream that can be transferred through postMessage",
  "user-activation": "navigator.userActivation, which makes user activation observable",
  "worker-request-observation":
    "automation that reports a dedicated Worker's requests, so a no-external-fetch claim can fail",
});

/**
 * THE DEFAULT GATE IS THE CHROMIUM BASELINE, and it has always asserted every one of these. In it
 * they are REQUIRED (`BROWSER_REQUIRED_CAPABILITIES`): a Chromium that loses one must fail the
 * gate, not turn quietly into "not applicable". An engine-full run requires none of them and lets
 * each suite detect what the worker has.
 */
export const DEFAULT_GATE_REQUIRES = Object.freeze(Object.keys(CAPABILITIES));

/** @type {Readonly<Record<string, {category: string, capabilities?: readonly string[], reason?: string}>>} */
export const SUITE_CLASSES = Object.freeze({
  // console - a mock engine, every engine
  "console.mjs": { category: "console" },
  "console-keyboard.mjs": { category: "console" },
  "console-mobile.mjs": { category: "console" },
  // Focus-after-click is exactly the kind of thing each engine gets subtly wrong on its own.
  "console-pointer.mjs": { category: "console" },
  "console-lifecycle.mjs": { category: "console" },
  "console-paste-and-caret.mjs": { category: "console" },
  "console-files.mjs": { category: "console" },

  // portable - the real interpreter
  "console-real-engine.mjs": { category: "portable" },
  "repl.mjs": { category: "portable" },
  "display.mjs": { category: "portable" },
  "http-adapter.mjs": { category: "portable" }, // awaited reads only: no JSPI involved
  "fsspec-adapter.mjs": { category: "portable" }, // awaited reads only
  "s3-adapter.mjs": { category: "portable" }, // awaited reads only
  "matplotlib.mjs": { category: "portable" },
  "micropip.mjs": { category: "portable" },
  "csp.mjs": { category: "portable" },
  "bundled-consumer.mjs": { category: "portable" },
  "capability-fallbacks.mjs": { category: "portable" }, // removes the capabilities itself
  // Portable with capability-dependent PARTS, reported as not applicable where absent: the OPFS
  // file inside the frame; and for two origins the workspace-backed downloads, the native picker,
  // transferable streams, `navigator.userActivation` and Chromium's memory API. The framing,
  // policies, handshake and the four bounded operations run everywhere.
  "embedding-waterpark.mjs": { category: "portable" },
  "embedding-two-origin.mjs": { category: "portable" },
  // Dask over a remote Zarr fixture needs JSPI; the Natural Earth half does not.
  "addons.mjs": { category: "portable" },
  // Chromium's memory instrumentation is a part; the transfer itself needs the workspace.
  "workspace-stream.mjs": { category: "capability", capabilities: ["sync-access-handles"] },

  // capability - the feature IS the capability
  "zarr.mjs": { category: "capability", capabilities: ["jspi"] },
  "workspace.mjs": { category: "capability", capabilities: ["sync-access-handles"] },
  "workspace-errors.mjs": { category: "capability", capabilities: ["sync-access-handles"] },
  "workspace-lifecycle.mjs": { category: "capability", capabilities: ["sync-access-handles"] },
  "persistence-restart.mjs": { category: "capability", capabilities: ["sync-access-handles"] },

  // opt-in: a public package index
  "freva-client.mjs": { category: "portable" },
  "freva-auth.mjs": { category: "portable" },
  "freva-persistence-restart.mjs": { category: "portable" },
  "csp-package-index.mjs": { category: "portable" },
  // opt-in: live third-party services
  "cmip6.mjs": { category: "capability", capabilities: ["jspi"] },
  "freva-live.mjs": { category: "portable" },
});

export const CATEGORIES = Object.freeze(["console", "portable", "capability", "chromium"]);

/** The suites the DEFAULT gate runs in every engine of `BROWSER_ENGINES`: the console ones. */
export const CROSS_BROWSER = Object.freeze(
  Object.entries(SUITE_CLASSES)
    .filter(([, c]) => c.category === "console")
    .map(([suite]) => suite),
);

/**
 * Suites whose behaviour does not depend on the browser engine: what they test is Python, Node or
 * the files they produce, and the engine only hosts the interpreter. They run in full in the
 * Chromium run - the reference engine - and a Firefox or WebKit run may leave them out with
 * `--skip-engine-independent`, which CI does to keep those jobs short (Playwright's Firefox runs
 * WebAssembly ~5x slower). Each entry says why, and why what IS engine-specific about it is
 * covered by another suite that still runs everywhere.
 */
export const ENGINE_INDEPENDENT = Object.freeze({
  "addons.mjs":
    "add-on wheels, digest pinning and staged Cartopy data are Python and file checks; " +
    "remote Zarr through JSPI is covered by zarr.mjs",
  "workspace.mjs":
    "the file formats are written by Python libraries; the engine's OPFS workspace is covered by " +
    "workspace-errors, workspace-stream and workspace-lifecycle",
  "bundled-consumer.mjs":
    "the Vite build runs in Node; starting an interpreter is covered by every other suite",
  "micropip.mjs": "installing a wheel is Python; fetching one is covered by the adapter suites",
  "matplotlib.mjs": "figure rendering is Python; displaying one is covered by display.mjs",
});

/**
 * The suites an engine-specific FULL run executes in `engine`, and the ones it does not, each with
 * the reason. `chromium` suites are withheld from other engines. With `skipEngineIndependent` a
 * NON-Chromium run also leaves out the ENGINE_INDEPENDENT suites, reported as covered by the
 * Chromium run; Chromium, the reference engine, always runs everything. A `capability` suite
 * always runs and decides for itself from what the worker reports.
 */
export function planFor(engine, suites, { skipEngineIndependent = false } = {}) {
  const run = [];
  const withheld = [];
  const coveredElsewhere = [];
  for (const suite of suites) {
    const entry = SUITE_CLASSES[suite];
    if (entry?.category === "chromium" && engine !== "chromium") {
      withheld.push({ suite, reason: entry.reason ?? "Chromium-specific" });
    } else if (skipEngineIndependent && engine !== "chromium" && ENGINE_INDEPENDENT[suite]) {
      coveredElsewhere.push({ suite, reason: ENGINE_INDEPENDENT[suite] });
    } else {
      run.push(suite);
    }
  }
  return { run, withheld, coveredElsewhere };
}
