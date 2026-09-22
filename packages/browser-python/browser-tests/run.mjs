/**
 * One documented entry point for the browser suites: `npm run test:browser`. Each suite is a
 * standalone driver with its own server and browser, run as a separate process, so a crashed
 * engine in one cannot take the rest of the run with it and any suite stays individually runnable
 * (`node browser-tests/repl.mjs`) while you debug it.
 *
 * Two shapes of run:
 *
 *  - DEFAULT (`node run.mjs`): the console suites in every engine of `BROWSER_ENGINES`, and every
 *    other suite once, in Chromium - named explicitly rather than by accident.
 *  - ENGINE-FULL (`node run.mjs --engine firefox`): EVERY suite in that one engine. Console,
 *    portable and capability suites all run; a capability suite asks the worker what it has and
 *    reports NOT APPLICABLE with the reason when the feature cannot exist there. Only a suite
 *    classified `chromium` in `suite-list.mjs` is withheld, and the summary names it and why.
 *
 * Suite names given after the options select a subset, under the same supervision.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ENGINES, EXIT_NOT_APPLICABLE, EXIT_NOT_RUN, EXIT_RETRYABLE } from "./harness.mjs";
import { checkStamp } from "../scripts/build-stamp.mjs";
import {
  CROSS_BROWSER,
  DEFAULT_GATE_REQUIRES,
  NETWORK_SUITES,
  PACKAGE_INDEX_SUITES,
  SUITES as DEFAULT_SUITES,
  planFor,
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

// ------------------------------------------------------------------------------ arguments

const args = process.argv.slice(2);
let fullEngine = null;
let build = true;
const requestedSuites = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--engine") {
    fullEngine = args[++i] ?? "";
  } else if (arg.startsWith("--engine=")) {
    fullEngine = arg.slice("--engine=".length);
  } else if (arg === "--no-build") {
    // For a CI step that built immediately before. The freshness check below still runs.
    build = false;
  } else if (arg.startsWith("--")) {
    console.error(`Unknown option ${arg}. Use --engine <${ENGINES.join("|")}> and suite names.`);
    process.exit(2);
  } else {
    requestedSuites.push(arg);
  }
}
if (fullEngine !== null && !ENGINES.includes(fullEngine)) {
  console.error(
    `--engine must be one of ${ENGINES.join(", ")}; received ${JSON.stringify(fullEngine)}.`,
  );
  process.exit(2);
}

// A named subset keeps the same process supervision as the full gate. Running a suite module
// directly is useful while debugging, but it loses the parent watchdog precisely when a wedged
// browser is the thing under investigation.
const selected = [...new Set(requestedSuites)];
if (selected.length > 0) {
  const unknown = selected.filter((suite) => !SUITES.includes(suite));
  if (unknown.length > 0) {
    console.error(`Unknown or disabled browser suite(s): ${unknown.join(", ")}.`);
    process.exit(2);
  }
  SUITES.splice(0, SUITES.length, ...selected);
}

// ------------------------------------------------------------------------------ the build
//
// EVERY documented browser-test command comes through here, so this is the one place that makes
// sure the suites test the sources that are checked out: `npm run build` first, then a content
// digest of the sources compared with the one the build recorded (scripts/build-stamp.mjs). A
// stale `dist/` is refused, never used; `requireDist()` in each suite checks the same digest.
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (build) {
  console.log("--- building @freva-org/browser-python before the browser suites ---");
  const built = spawnSync("npm", ["run", "build"], {
    cwd: PKG_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (built.status !== 0) {
    console.error(`The build failed (${built.error?.message ?? `exit ${built.status}`}).`);
    process.exit(2);
  }
}
{
  const fresh = checkStamp(PKG_DIR);
  if (!fresh.ok) {
    console.error(fresh.reason);
    process.exit(2);
  }
}

/**
 * Exit code 3 means "the runtime this suite needs is not assembled" - a distinct outcome from both
 * pass and fail, reported as its own line. Collapsing it into "pass" is how a run announces that
 * everything is fine when the scientific stack was never loaded. The suites produce it through
 * `requireRuntimeFor`, which is the only place it comes from.
 */
const INCOMPLETE = EXIT_NOT_RUN;

const CONSOLE_ENGINES = (process.env.BROWSER_ENGINES ?? "chromium").split(/[\s,]+/).filter(Boolean);
const badEngine = CONSOLE_ENGINES.find((engine) => !ENGINES.includes(engine));
if (badEngine) {
  console.error(`BROWSER_ENGINES names ${JSON.stringify(badEngine)}; use ${ENGINES.join(", ")}.`);
  process.exit(2);
}
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
// cannot run the page-side deadline. Every retry starts a new Node and browser process. The
// measurement exists only in Chromium, so no other engine is ever retried.
const RETRYABLE_SUITES = new Set(["workspace-stream.mjs"]);
const RETRYABLE_ENGINES = new Set(["chromium"]);

// ------------------------------------------------------------------------------ the plan

/** @type {{suite: string, engine: string, requires?: readonly string[]}[]} */
let runs;
/** Suites a full run deliberately does not execute here, each with its reason. */
let withheld = [];
if (fullEngine !== null) {
  const plan = planFor(fullEngine, SUITES);
  runs = plan.run.map((suite) => ({ suite, engine: fullEngine }));
  withheld = plan.withheld.map(({ suite, reason }) => ({
    label: `${suite} (${fullEngine})`,
    reason,
  }));
} else {
  runs = SUITES.flatMap((suite) =>
    crossBrowser.has(suite)
      ? CONSOLE_ENGINES.map((engine) => ({ suite, engine }))
      : // Explicitly Chromium: the default gate's real-interpreter half. An engine-full run is
        // where the other engines get it.
        // The capabilities that baseline has always asserted are REQUIRED here, so losing one
        // fails rather than becoming not applicable - see DEFAULT_GATE_REQUIRES.
        [{ suite, engine: "chromium", requires: DEFAULT_GATE_REQUIRES }],
  );
}

// ------------------------------------------------------------------------------ one child

/** How many trailing output lines are kept per suite, for the failure diagnostics below. */
const TAIL_LINES = 40;
/** A line that says where a suite was: a phase marker, a request log, or a watchdog report. */
const DIAGNOSTIC = /phase|starting|request|exchange|watchdog|timed? ?out|TIMEOUT|FAIL|NOT A PASS/i;

/** The suite process running now, so an interrupted runner can take it (and its browser) down. */
let activeChild = null;
/** Removed on every exit path, including an interrupted one. */
let resultsDir = null;
const signalGroup = (child, signal) => {
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // already gone
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    const finish = () => {
      if (resultsDir) rmSync(resultsDir, { recursive: true, force: true });
      process.exit(130);
    };
    // The child runs in its own process group, which a terminal's Ctrl+C no longer reaches. SIGTERM
    // first, so Playwright closes its browsers; SIGKILL only if the suite does not exit.
    const child = activeChild;
    if (!child?.pid) return finish();
    child.once("close", finish);
    signalGroup(child, "SIGTERM");
    setTimeout(() => {
      signalGroup(child, "SIGKILL");
      finish();
    }, 10_000).unref();
  });
}

/**
 * Run one suite in its own Node process and process group. Output is forwarded live and the tail is
 * kept, so a failure can be summarised by where it was. Playwright launches each browser in a group
 * of its OWN, so the watchdog starts with SIGTERM - on which Playwright closes the browsers it
 * launched - and only escalates to SIGKILL on the suite's group if that is ignored.
 */
function runChild(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    activeChild = child;
    const tail = [];
    let partial = "";
    const keep = (chunk, stream) => {
      stream.write(chunk);
      const text = partial + chunk.toString("utf8");
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    };
    child.stdout.on("data", (chunk) => keep(chunk, process.stdout));
    child.stderr.on("data", (chunk) => keep(chunk, process.stderr));

    let timedOut = false;
    const kill = (signal) => signalGroup(child, signal);
    // The final line of supervision. A page.evaluate() waits for its returned Promise without a
    // Playwright timeout, so a wedged Worker or browser can otherwise hold the child until the CI
    // provider cancels the whole job. SIGTERM first, SIGKILL if that is ignored.
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 10_000).unref();
    }, SUITE_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, error, timedOut: false, tail });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      activeChild = null;
      if (partial) tail.push(partial);
      resolve({ status, signal, timedOut, tail });
    });
  });
}

function readOutcome(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------ the run

resultsDir = mkdtempSync(path.join(tmpdir(), "browser-python-results-"));
const passed = [];
const failures = [];
const timedOut = [];
const notApplicable = [];
const partlyNotApplicable = [];
const incomplete = [];
const recoveredOnRetry = [];

if (fullEngine !== null) {
  console.log(
    `\nFull ${fullEngine} run: ${runs.length} suite(s)` +
      (withheld.length ? `, ${withheld.length} withheld as Chromium-specific` : "") +
      ".",
  );
}

let index = 0;
for (const { suite, engine, requires } of runs) {
  index += 1;
  const label = `${suite} (${engine})`;
  let attempt = 0;
  let r;
  let elapsed;
  let outcome;
  while (true) {
    attempt += 1;
    const started = Date.now();
    const resultFile = path.join(resultsDir, `${index}-${attempt}.json`);
    // Suites report only when they finish. Name the child BEFORE starting it, otherwise a hung
    // suite leaves CI pointing at the preceding suite's successful report.
    console.log(`\n--- starting ${label} ---`);
    if (attempt > 1) console.log(`--- retry attempt ${attempt} in a fresh browser process ---`);
    r = await runChild(path.join(HERE, suite), {
      ...process.env,
      BROWSER_ENGINE: engine,
      BROWSER_REQUIRED_CAPABILITIES: (requires ?? []).join(","),
      BROWSER_RETRY_ATTEMPT: String(attempt),
      BROWSER_RESULT_FILE: resultFile,
    });
    elapsed = ((Date.now() - started) / 1000).toFixed(1);
    outcome = readOutcome(resultFile);
    const classifiedRetry = r.status === EXIT_RETRYABLE;
    const mayRetry =
      RETRYABLE_SUITES.has(suite) &&
      RETRYABLE_ENGINES.has(engine) &&
      attempt <= MAX_RETRIES &&
      (r.timedOut || classifiedRetry);
    if (!mayRetry) break;
    const reason = r.timedOut
      ? `the process timed out after ${elapsed}s`
      : `the suite reported exit ${EXIT_RETRYABLE}`;
    console.log(`--- RETRY ${label}: ${reason}; discarding it and starting fresh ---`);
  }

  const diagnostics = () => {
    const where = r.tail.filter((line) => DIAGNOSTIC.test(line)).slice(-6);
    return where.length > 0 ? where : r.tail.slice(-6);
  };

  if (r.timedOut) {
    console.log(
      `--- TIMEOUT ${label} after ${elapsed}s ` +
        `(limit ${Math.round(SUITE_TIMEOUT_MS / 1000)}s) ---`,
    );
    timedOut.push({ label, diagnostics: diagnostics() });
  } else if (r.error) {
    console.log(`--- FAILED TO RUN ${label} after ${elapsed}s: ${r.error.message} ---`);
    failures.push({ label, reason: r.error.message, diagnostics: [] });
  } else {
    console.log(`--- finished ${label} in ${elapsed}s ---`);
    if (r.status === INCOMPLETE) {
      incomplete.push({
        label,
        reason:
          outcome?.reason ?? "its prerequisites are absent - see the suite's own output above",
      });
    } else if (r.status === EXIT_NOT_APPLICABLE && outcome?.outcome === "not-applicable") {
      notApplicable.push({ label, reason: outcome.reason, checks: outcome.checks });
      for (const note of outcome.notApplicable ?? []) {
        partlyNotApplicable.push({ label, name: note.name, reason: note.reason });
      }
    } else if (r.status === 0 && outcome?.outcome === "pass") {
      passed.push(attempt > 1 ? `${label} (attempt ${attempt})` : label);
      if (attempt > 1) recoveredOnRetry.push(`${label} (attempt ${attempt})`);
      for (const note of outcome.notApplicable ?? []) {
        partlyNotApplicable.push({ label, name: note.name, reason: note.reason });
      }
    } else {
      // Anything else fails, INCLUDING a zero exit with no report behind it: only `report()` may
      // call a suite passed, and a process that exited 0 without one has proved nothing.
      const reason =
        r.status === 0 || r.status === EXIT_NOT_APPLICABLE
          ? `exited ${r.status} without a matching report() outcome`
          : (outcome?.reason ??
            (r.signal ? `killed by ${r.signal}` : `exited ${r.status ?? "abnormally"}`));
      failures.push({
        label,
        reason: outcome?.firstFailure
          ? `${reason}; first failing check: ${outcome.firstFailure}`
          : reason,
        diagnostics: diagnostics(),
      });
    }
  }
}
rmSync(resultsDir, { recursive: true, force: true });

// ------------------------------------------------------------------------------ the summary

const heading = fullEngine !== null ? `Full ${fullEngine} run` : "Browser run";
console.log(`\n=== ${heading}: summary ===`);
console.log(`passed          ${passed.length}`);
for (const label of passed) console.log(`  pass  ${label}`);
console.log(`failed          ${failures.length}`);
for (const f of failures) {
  console.log(`  FAIL  ${f.label} - ${f.reason}`);
  for (const line of f.diagnostics) console.log(`          | ${line}`);
}
console.log(`timed out       ${timedOut.length}`);
for (const t of timedOut) {
  console.log(`  TIMEOUT  ${t.label} (limit ${Math.round(SUITE_TIMEOUT_MS / 1000)}s)`);
  for (const line of t.diagnostics) console.log(`          | ${line}`);
}
console.log(`not applicable  ${notApplicable.length + withheld.length}`);
for (const n of notApplicable) console.log(`  n/a   ${n.label} - ${n.reason}`);
for (const w of withheld) console.log(`  n/a   ${w.label} - withheld: ${w.reason}`);
if (partlyNotApplicable.length > 0) {
  console.log(`parts not applicable inside suites  ${partlyNotApplicable.length}`);
  for (const p of partlyNotApplicable) console.log(`  n/a   ${p.label}: ${p.name} - ${p.reason}`);
}
if (recoveredOnRetry.length)
  console.log(`passed on a fresh-process retry: ${recoveredOnRetry.join(", ")}.`);

// Under BROWSER_STRICT=1, "did not run" is a FAILURE. Exit 3 exists so a workstation without the
// scientific wheels can still run the console suites; that is wrong for a gate, where the whole
// scientific half - remote Zarr, Matplotlib, micropip - can be absent from a run that exits 0 with
// only a line in the middle of the log. Assemble the runtime with
// `node bin/freva-browser-python.mjs prepare-runtime --version <v> --full --out .runtime`.
const strict = process.env.BROWSER_STRICT === "1";
if (incomplete.length) {
  console.log(`did NOT run     ${incomplete.length}`);
  for (const i of incomplete) console.log(`  --    ${i.label} - ${i.reason}`);
  console.log(
    strict
      ? "  BROWSER_STRICT=1: this FAILS the run. A gate cannot tell a pass from a skip.\n" +
          "  node bin/freva-browser-python.mjs prepare-runtime --version 314.0.6 --full --out .runtime"
      : "  Assemble the runtime (`node scripts/prepare-runtime.mjs` or the CLI's prepare-runtime),\n" +
          "  or install the missing Playwright browser, and re-run.",
  );
}

const executed = passed.length + failures.length + timedOut.length + notApplicable.length;
const bad = failures.length + timedOut.length;
if (executed === 0) console.log("\nNOTHING RAN. Zero executions is not a pass.");
else if (bad === 0)
  console.log(`\nAll ${executed} executed browser suite runs pass or are not applicable.`);
else console.log(`\n${bad} of ${executed} executed browser suite runs FAILED or TIMED OUT.`);

const blocked = strict && incomplete.length > 0;
process.exit(bad === 0 && !blocked && executed > 0 ? 0 : 1);
