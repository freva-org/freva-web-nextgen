/**
 * Which browser suite needs which Pyodide wheels - declared ONCE, and read by both sides.
 *
 * The two sides drift invisibly otherwise: a suite whose runtime lacks a wheel exits 3, which
 * `run.mjs` reports as NOT RUN rather than a failure, so CI can assemble a runtime, skip the suite
 * that needed the missing wheels and announce a green run. The assembler derives its download
 * list from here, and `tests/runtime-wheels.test.ts` fails if any suite asks
 * `runtimeHasPackages` for something this file does not list. Names are Pyodide PACKAGE names as
 * they appear in `pyodide-lock.json`, not import names - `pillow`, not `PIL` - and dependencies
 * are resolved from the lock file's own graph, so only what a suite names directly belongs here.
 */

/** @type {Readonly<Record<string, readonly string[]>>} */
export const SUITE_REQUIREMENTS = Object.freeze({
  // EVERY suite has an entry, `[]` included: "no entry" and "needs nothing" otherwise look the
  // same, which is how a suite that genuinely needs wheels hides among the ones that do not -
  // `freva-live.mjs` starts the `freva-client` profile, needs micropip, and appeared in neither
  // this file nor a `requireRuntimeFor` call, so an incomplete runtime made it report a test
  // FAILURE rather than NOT RUN. `tests/browser-gate.test.ts` fails if the runner runs a suite
  // this file does not name.

  // The console component against a MOCK engine: no interpreter, no wheels, three browsers.
  "console.mjs": [],
  "console-keyboard.mjs": [],
  "console-pointer.mjs": [],
  "console-lifecycle.mjs": [],
  "console-paste-and-caret.mjs": [],
  "console-mobile.mjs": [],
  "console-files.mjs": [],
  // The interpreter and nothing else: what these measure is the REPL, the display pipeline and
  // the HTTP helpers, none of which is a wheel.
  "repl.mjs": [],
  "display.mjs": [],
  "http-adapter.mjs": [],
  "cmip6.mjs": ["xarray", "zarr", "fsspec", "numcodecs", "numpy"],
  // The live deployment, on the freva-client profile - so it needs that profile's wheel.
  "freva-live.mjs": ["micropip"],
  // Nothing beyond the interpreter. The figure check inside it needs matplotlib and is declared
  // OPTIONAL below, so an incomplete runtime costs that one check rather than the other fifteen.
  "console-real-engine.mjs": [],
  "freva-auth.mjs": ["micropip"],
  // The same wheelhouse as freva-auth: a real device flow, then a real browser restart.
  "freva-persistence-restart.mjs": ["micropip"],
  "freva-client.mjs": ["micropip"],
  // The published CSP's package-index grant, proved by starting the freva-client profile under
  // it - so it needs that profile's wheel, and the index behind it.
  "csp-package-index.mjs": ["micropip"],
  "fsspec-adapter.mjs": ["fsspec"],
  "s3-adapter.mjs": ["fsspec"],
  "matplotlib.mjs": ["matplotlib", "numpy"],
  "micropip.mjs": ["micropip"],
  "zarr.mjs": ["xarray", "zarr", "fsspec", "numcodecs", "numpy"],
  // The curated add-ons, on the runtime's own wheels plus three MIRRORED ones. Everything here
  // comes from the pinned lock: Dask's dependency closure minus the three pure-Python packages
  // the lock does not carry (`dask`, `partd`, `locket`), and Cartopy's whole chain, which the
  // runtime does carry. The mirrored wheels are not runtime packages, so they are not declared
  // here; `prepare-addons` fetches them.
  "addons.mjs": [
    "xarray",
    "zarr",
    "fsspec",
    "numcodecs",
    "numpy",
    "micropip",
    "toolz",
    "cloudpickle",
    "click",
    "packaging",
    "pyyaml",
    "cartopy",
    "matplotlib",
    "shapely",
    "pyproj",
    "pyshp",
    "scipy",
  ],
  // The formats a scientific session actually exports.
  "workspace.mjs": ["numpy", "pandas", "xarray", "netcdf4", "pyarrow", "matplotlib", "pillow"],
  // Streams a large artifact out. Needs nothing beyond the interpreter: the file is written with
  // plain `open()` on purpose, so the delivery path is tested without a library in the way.
  "workspace-stream.mjs": [],
  "workspace-errors.mjs": [],
  "workspace-lifecycle.mjs": [],
  "csp.mjs": [],
  // The embedded arrangement and the restart evidence both need the interpreter and the workspace,
  // and nothing from the scientific stack: what is under test is headers and storage.
  "embedding-waterpark.mjs": [],
  // The two-origin topology and the 96 MiB bridge measurement: the interpreter, and nothing else.
  "embedding-two-origin.mjs": [],
  "persistence-restart.mjs": [],
  // Nothing beyond the interpreter: what is being tested is whether a bundler's rewriting of the
  // Worker URL survives, which needs a Worker and not a wheel.
  "bundled-consumer.mjs": [],
});

/**
 * Wheels a suite uses for SOME of its checks, but can run without.
 *
 * The two have opposite right answers: a suite that cannot do anything without its wheels must
 * report NOT RUN, while one that would lose a single check out of sixteen must not, or an
 * incomplete runtime throws away fifteen real results. Keeping both lists in one file stops the
 * second kind from looking like an undeclared requirement - the assembler downloads both, and the
 * gate audit knows which suites may ask `runtimeHasPackages` inline rather than gating on it.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const SUITE_OPTIONAL_PACKAGES = Object.freeze({
  // The inline Matplotlib figure. The other fifteen checks are the console itself.
  "console-real-engine.mjs": ["matplotlib", "numpy"],
});

/** Every package any suite needs or can use, deduplicated and sorted. */
export function suitePackages() {
  return [
    ...new Set([
      ...Object.values(SUITE_REQUIREMENTS).flat(),
      ...Object.values(SUITE_OPTIONAL_PACKAGES).flat(),
    ]),
  ].sort();
}
