/**
 * One documented entry point for the browser suites: `npm run test:browser`. Each suite is a
 * standalone driver with its own server and browser, run as a separate process, so a crashed
 * engine in one cannot take the rest of the run with it and any suite stays individually runnable
 * (`node browser-tests/repl.mjs`) while you debug it.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EXIT_NOT_RUN } from "./harness.mjs";
import {
  CROSS_BROWSER,
  NETWORK_SUITES,
  PACKAGE_INDEX_SUITES,
  SUITES as DEFAULT_SUITES,
} from "./suite-list.mjs";

/** A mutable copy: the opt-in suites are appended below. */
const SUITES = [...DEFAULT_SUITES];
const crossBrowser = new Set(CROSS_BROWSER);

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (process.env.BROWSER_PYTHON_NETWORK === "1") SUITES.push(...NETWORK_SUITES);
// A public package index, which is a weaker requirement than a named third party's
// service - see PACKAGE_INDEX_SUITES. `BROWSER_PYTHON_NETWORK=1` implies it: a run that
// has accepted a live Freva deployment has certainly accepted PyPI.
if (process.env.BROWSER_PYTHON_PACKAGE_INDEX === "1" || process.env.BROWSER_PYTHON_NETWORK === "1")
  SUITES.push(...PACKAGE_INDEX_SUITES);

/**
 * Exit code 3 means "the runtime this suite needs is not assembled" - a distinct outcome from both
 * pass and fail, reported as its own line. Collapsing it into "pass" is how a run announces that
 * everything is fine when the scientific stack was never loaded. The suites produce it through
 * `requireRuntimeFor`, which is the only place it comes from.
 */
const INCOMPLETE = EXIT_NOT_RUN;

const CONSOLE_ENGINES = (process.env.BROWSER_ENGINES ?? "chromium").split(/[\s,]+/).filter(Boolean);

let failed = 0;
const incomplete = [];

const runs = SUITES.flatMap((suite) =>
  crossBrowser.has(suite)
    ? CONSOLE_ENGINES.map((engine) => ({ suite, engine }))
    : [{ suite, engine: null }],
);
for (const { suite, engine } of runs) {
  const r = spawnSync(process.execPath, [path.join(HERE, suite)], {
    stdio: "inherit",
    env: engine ? { ...process.env, BROWSER_ENGINE: engine } : process.env,
  });
  if (r.status === INCOMPLETE) incomplete.push(suite);
  else if (r.status !== 0) failed++;
}

const ran = runs.length - incomplete.length;
if (failed === 0) console.log(`\nAll ${ran} runnable browser suites pass.`);
else console.log(`\n${failed} of ${ran} runnable browser suites FAILED.`);

// Under BROWSER_STRICT=1, "did not run" is a FAILURE. Exit 3 exists so a workstation without the
// scientific wheels can still run the console suites; that is wrong for a gate, where the whole
// scientific half - remote Zarr, Matplotlib, micropip - can be absent from a run that exits 0 with
// only a line in the middle of the log. Assemble the runtime with
// `node bin/freva-browser-python.mjs prepare-runtime --version <v> --full --out .runtime`.
const strict = process.env.BROWSER_STRICT === "1";
if (incomplete.length) {
  console.log(
    `${incomplete.length} suite(s) did NOT run - the runtime lacks their wheels: ` +
      `${incomplete.join(", ")}.`,
  );
  console.log(
    strict
      ? "  BROWSER_STRICT=1: this FAILS the run. A gate cannot tell a pass from a skip.\n" +
          "  node bin/freva-browser-python.mjs prepare-runtime --version 314.0.6 --full --out .runtime"
      : "  Run `node scripts/prepare-runtime.mjs` (or the CLI's prepare-runtime) and re-run.",
  );
}
const blocked = strict && incomplete.length > 0;
process.exit(failed === 0 && !blocked ? 0 : 1);
