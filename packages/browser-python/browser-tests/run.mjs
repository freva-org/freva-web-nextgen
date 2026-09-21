/**
 * One documented entry point for the browser suites: `npm run test:browser`. Each suite is a
 * standalone driver with its own server and browser, run as a separate process, so a crashed
 * engine in one cannot take the rest of the run with it and any suite stays individually runnable
 * (`node browser-tests/repl.mjs`) while you debug it.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EXIT_NOT_RUN, EXIT_RETRYABLE } from "./harness.mjs";
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

// A named subset keeps the same process supervision as the full gate. Running a suite module
// directly is useful while debugging, but it loses the parent watchdog precisely when a wedged
// browser is the thing under investigation.
const requestedSuites = [...new Set(process.argv.slice(2))];
if (requestedSuites.length > 0) {
  const unknown = requestedSuites.filter((suite) => !SUITES.includes(suite));
  if (unknown.length > 0) {
    console.error(`Unknown or disabled browser suite(s): ${unknown.join(", ")}.`);
    process.exit(2);
  }
  SUITES.splice(0, SUITES.length, ...requestedSuites);
}

/**
 * Exit code 3 means "the runtime this suite needs is not assembled" - a distinct outcome from both
 * pass and fail, reported as its own line. Collapsing it into "pass" is how a run announces that
 * everything is fine when the scientific stack was never loaded. The suites produce it through
 * `requireRuntimeFor`, which is the only place it comes from.
 */
const INCOMPLETE = EXIT_NOT_RUN;

const CONSOLE_ENGINES = (process.env.BROWSER_ENGINES ?? "chromium").split(/[\s,]+/).filter(Boolean);
const configuredTimeout = Number(process.env.BROWSER_SUITE_TIMEOUT_MS ?? 15 * 60_000);
if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout <= 0) {
  console.error(
    "BROWSER_SUITE_TIMEOUT_MS must be a positive integer number of milliseconds; received " +
      JSON.stringify(process.env.BROWSER_SUITE_TIMEOUT_MS),
  );
  process.exit(2);
}
const SUITE_TIMEOUT_MS = configuredTimeout;
const configuredRetries = Number(process.env.BROWSER_RETRY_COUNT ?? 1);
if (!Number.isSafeInteger(configuredRetries) || configuredRetries < 0) {
  console.error(
    "BROWSER_RETRY_COUNT must be a non-negative integer; received " +
      JSON.stringify(process.env.BROWSER_RETRY_COUNT),
  );
  process.exit(2);
}
const MAX_RETRIES = configuredRetries;

// Retrying arbitrary failures hides regressions. This one suite depends on Chromium's
// implementation-defined memory measurement, and marks only a measurement timeout or target
// crash with EXIT_RETRYABLE. A process-level timeout is included because a totally wedged renderer
// cannot run the page-side deadline. Every retry starts a new Node and browser process.
const RETRYABLE_SUITES = new Set(["workspace-stream.mjs"]);

let failed = 0;
const incomplete = [];
const timedOut = [];
const recoveredOnRetry = [];

const runs = SUITES.flatMap((suite) =>
  crossBrowser.has(suite)
    ? CONSOLE_ENGINES.map((engine) => ({ suite, engine }))
    : [{ suite, engine: null }],
);
for (const { suite, engine } of runs) {
  const label = engine ? `${suite} (${engine})` : suite;
  let attempt = 0;
  let r;
  let elapsed;
  let didTimeOut;
  while (true) {
    attempt += 1;
    const started = Date.now();
    // Suites report only when they finish. Name the child BEFORE starting it, otherwise a hung
    // suite leaves CI pointing at the preceding suite's successful report.
    console.log(`\n--- starting ${label} ---`);
    if (attempt > 1) console.log(`--- retry attempt ${attempt} in a fresh browser process ---`);
    r = spawnSync(process.execPath, [path.join(HERE, suite)], {
      stdio: "inherit",
      env: {
        ...process.env,
        ...(engine ? { BROWSER_ENGINE: engine } : {}),
        BROWSER_RETRY_ATTEMPT: String(attempt),
      },
      // A page.evaluate() waits for its returned Promise without a Playwright timeout. If a Worker
      // or browser process wedges, the child can therefore live until the CI provider cancels the
      // whole job. Bound the PROCESS as the final line of supervision and carry on with later suites.
      timeout: SUITE_TIMEOUT_MS,
    });
    elapsed = ((Date.now() - started) / 1000).toFixed(1);
    didTimeOut = r.error?.code === "ETIMEDOUT";
    const classifiedRetry = r.status === EXIT_RETRYABLE;
    const mayRetry =
      RETRYABLE_SUITES.has(suite) && attempt <= MAX_RETRIES && (didTimeOut || classifiedRetry);
    if (!mayRetry) break;
    const reason = didTimeOut
      ? `the process timed out after ${elapsed}s`
      : `the suite reported exit ${EXIT_RETRYABLE}`;
    console.log(`--- RETRY ${label}: ${reason}; discarding it and starting fresh ---`);
  }

  if (r.error?.code === "ETIMEDOUT") {
    console.log(
      `--- TIMEOUT ${label} after ${elapsed}s ` +
        `(limit ${Math.round(SUITE_TIMEOUT_MS / 1000)}s) ---`,
    );
    timedOut.push(label);
    failed++;
  } else if (r.error) {
    console.log(`--- FAILED TO RUN ${label} after ${elapsed}s: ${r.error.message} ---`);
    failed++;
  } else {
    console.log(`--- finished ${label} in ${elapsed}s ---`);
    if (r.status === INCOMPLETE) incomplete.push(suite);
    else if (r.status !== 0) failed++;
    else if (attempt > 1) recoveredOnRetry.push(`${label} (attempt ${attempt})`);
  }
}

const ran = runs.length - incomplete.length;
if (failed === 0) console.log(`\nAll ${ran} runnable browser suites pass.`);
else console.log(`\n${failed} of ${ran} runnable browser suites FAILED.`);
if (timedOut.length) console.log(`Timed out: ${timedOut.join(", ")}.`);
if (recoveredOnRetry.length)
  console.log(`Passed on a fresh-process retry: ${recoveredOnRetry.join(", ")}.`);

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
