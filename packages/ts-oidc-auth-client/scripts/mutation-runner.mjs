/**
 * The part of the mutation gate that decides what a test run MEANT.
 *
 * The false-green this exists to prevent is worth stating plainly: a gate that
 * reads "the child process exited non-zero" as "the test failed, so the control
 * is doing its job" will print "killed" for every mutation and exit 0 when the
 * test runner is simply not launchable - reporting that every security control
 * was verified when not a single test had started.
 *
 * A gate that cannot tell "your control is broken" from "my toolchain is
 * broken" is worse than no gate, because it produces confident evidence for a
 * release. So the only outcome that counts as a kill is one where Vitest
 * demonstrably started, ran the intended test, and reported a FAILING test.
 * Everything else - spawn errors, signals, missing commands, config/import
 * failures, missing test files, a filter that matched nothing - is an
 * INFRASTRUCTURE failure and fails the gate.
 *
 * Two things make an infrastructure failure ACTIONABLE rather than merely
 * loud, and both are load-bearing:
 *
 *  - Vitest is resolved from node_modules and run with this same Node binary,
 *    never through a PATH lookup. A `npx vitest` shells out to a resolver that
 *    silently falls back to fetching the package from the registry when the
 *    working directory's local bin does not have it; in a workspace checkout
 *    that turns a layout detail into 53 identical unexplained failures.
 *  - Every infrastructure verdict carries the tail of the child's own output.
 *    Without it, the gate reports that something is wrong and destroys the
 *    only evidence of what.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

/** Vitest summary lines: "Tests  1 failed | 14 skipped (15)". */
const TESTS_FAILED = /Tests\s+(\d+) failed/;
const TESTS_PASSED = /Tests\s+(\d+) passed/;

/**
 * Output patterns that mean Vitest never got as far as running tests. These
 * all coexist with a non-zero exit code, which is exactly why exit code alone
 * cannot be trusted.
 */
const STARTUP_FAILURES = [
  /Startup Error/i,
  /failed to load config/i,
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find package/i,
  /No test files found/i,
  /Error: Failed to parse/i,
  /command not found/i,
  /is not recognized as an internal or external command/i,
];

/**
 * The runner was never launched: a package manager or shell refused before
 * Vitest existed. Separated from STARTUP_FAILURES only so the report names the
 * cause - "could not be launched" points at the checkout, not at the test.
 */
const LAUNCH_FAILURES = [
  /could not determine executable to run/i,
  /^npm error/im,
  /^npm ERR!/im,
  /ENOTCACHED/,
  /EAI_AGAIN/,
  /ERR_INVALID_PACKAGE_TARGET/,
];

/** The last few meaningful lines of child output, for a one-line report. */
function tail(out, lines = 4) {
  const kept = out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-lines);
  return kept.length ? ` - child output: ${kept.join(" ⏎ ")}` : "";
}

/**
 * Classify one child-process result.
 *
 * @returns {{verdict: "killed"|"survived"|"infrastructure", detail: string}}
 */
export function classifyRun(result, { targeted }) {
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  // 1. The process never ran, or died abnormally.
  if (result.error) {
    const code = result.error.code ? ` (${result.error.code})` : "";
    return {
      verdict: "infrastructure",
      detail: `the test command could not be started${code}: ${result.error.message}`,
    };
  }
  if (result.signal) {
    return {
      verdict: "infrastructure",
      detail: `the test command was terminated by signal ${result.signal}${tail(out)}`,
    };
  }
  if (result.status === null || result.status === undefined) {
    return {
      verdict: "infrastructure",
      detail: `the test command produced no exit status${tail(out)}`,
    };
  }
  // 127 is the shell's "command not found"; 126 is "found but not executable".
  if (result.status === 127 || result.status === 126) {
    return {
      verdict: "infrastructure",
      detail: `the test command is not runnable (exit ${result.status})${tail(out)}`,
    };
  }

  // 2. A package manager refused before Vitest was ever reached. Checked ahead
  //    of the Vitest-specific patterns because this output contains none of
  //    them, which is precisely how it used to reach the generic branch below.
  for (const pattern of LAUNCH_FAILURES) {
    if (pattern.test(out)) {
      return {
        verdict: "infrastructure",
        detail:
          "Vitest could not be launched - the package manager failed before any " +
          `test started (${pattern.source})${tail(out)}`,
      };
    }
  }

  // 3. Vitest started but never reached the tests.
  for (const pattern of STARTUP_FAILURES) {
    if (pattern.test(out)) {
      return {
        verdict: "infrastructure",
        detail: `Vitest did not run any tests (${pattern.source})${tail(out)}`,
      };
    }
  }

  const failed = TESTS_FAILED.exec(out);
  const passed = TESTS_PASSED.exec(out);

  // 4. A non-zero exit is only a KILL when a test actually failed.
  if (result.status !== 0) {
    if (failed && Number(failed[1]) > 0) {
      return {
        verdict: "killed",
        detail: `${failed[1]} test(s) failed with the control removed`,
      };
    }
    return {
      verdict: "infrastructure",
      detail:
        `the test command exited ${result.status} without reporting a failing ` +
        `test; this is a toolchain failure, not a killed mutation${tail(out)}`,
    };
  }

  // 5. A zero exit only means SURVIVED when a test actually passed. A `-t`
  //    filter that matches nothing also exits 0, having proven nothing.
  if (!passed || Number(passed[1]) === 0) {
    return {
      verdict: "infrastructure",
      detail: targeted
        ? "the run succeeded but executed no tests; check the -t pattern"
        : "the run succeeded but executed no tests",
    };
  }
  return {
    verdict: "survived",
    detail: `${passed[1]} test(s) still pass with the control removed`,
  };
}

/**
 * Absolute path to the installed Vitest CLI.
 *
 * Resolved through Node's own algorithm from this file, so it finds the
 * dependency wherever the package manager hoisted it and fails loudly - with
 * the one instruction that fixes it - when it is genuinely not installed.
 */
let cachedBin;
export function vitestBinPath() {
  if (cachedBin) return cachedBin;
  const require = createRequire(import.meta.url);
  let manifestPath;
  try {
    manifestPath = require.resolve("vitest/package.json");
  } catch (cause) {
    throw new Error(
      "the mutation gate cannot find Vitest in node_modules. Run `npm ci` at " +
        `the repository root before running this gate. (${cause.message})`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vitest;
  if (!rel) throw new Error(`the installed vitest (${manifestPath}) declares no CLI binary`);
  cachedBin = resolve(dirname(manifestPath), rel);
  return cachedBin;
}

/**
 * Run one targeted Vitest invocation and classify it.
 *
 * `command` exists for the self-test, which needs to spawn something that is
 * genuinely absent from PATH. Left unset - the way the gate itself calls this -
 * the CLI is resolved from node_modules and run with this same Node binary.
 */
export function runTest({ file, only, command }) {
  // `-t` is treated as a regex, and these names contain `()` and `+`. An
  // unescaped pattern matches nothing, the run exits 0, and the mutation would
  // look survived (or worse, pass) for the wrong reason.
  const filter = only ? ["-t", only.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")] : [];
  const [bin, args] = command
    ? [command, ["vitest", "run", file, ...filter]]
    : [process.execPath, [vitestBinPath(), "run", file, ...filter]];
  const result = spawnSync(bin, args, { encoding: "utf8" });
  return classifyRun(result, { targeted: !!only });
}
