/**
 * The part of the mutation gate that decides what a test run MEANT.
 *
 * The false-green this exists to prevent is worth stating plainly: a gate that
 * reads "the child process exited non-zero" as "the test failed, so the control
 * is doing its job" will print "killed" for every mutation and exit 0 when `npx`
 * is simply missing from PATH — reporting that every security control was
 * verified when not a single test had started.
 *
 * A gate that cannot tell "your control is broken" from "my toolchain is
 * broken" is worse than no gate, because it produces confident evidence for a
 * release. So the only outcome that counts as a kill is one where Vitest
 * demonstrably started, ran the intended test, and reported a FAILING test.
 * Everything else — spawn errors, signals, missing commands, config/import
 * failures, missing test files, a filter that matched nothing — is an
 * INFRASTRUCTURE failure and fails the gate.
 */
import { spawnSync } from "node:child_process";

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
      detail: `the test command was terminated by signal ${result.signal}`,
    };
  }
  if (result.status === null || result.status === undefined) {
    return {
      verdict: "infrastructure",
      detail: "the test command produced no exit status",
    };
  }
  // 127 is the shell's "command not found"; 126 is "found but not executable".
  if (result.status === 127 || result.status === 126) {
    return {
      verdict: "infrastructure",
      detail: `the test command is not runnable (exit ${result.status}); is npx on PATH?`,
    };
  }

  // 2. Vitest started but never reached the tests.
  for (const pattern of STARTUP_FAILURES) {
    if (pattern.test(out)) {
      return {
        verdict: "infrastructure",
        detail: `Vitest did not run any tests (${pattern.source})`,
      };
    }
  }

  const failed = TESTS_FAILED.exec(out);
  const passed = TESTS_PASSED.exec(out);

  // 3. A non-zero exit is only a KILL when a test actually failed.
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
        "test; this is a toolchain failure, not a killed mutation",
    };
  }

  // 4. A zero exit only means SURVIVED when a test actually passed. A `-t`
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

/** Run one targeted Vitest invocation and classify it. */
export function runTest({ file, only, command = "npx" }) {
  const args = ["vitest", "run", file];
  // `-t` is treated as a regex, and these names contain `()` and `+`. An
  // unescaped pattern matches nothing, the run exits 0, and the mutation would
  // look survived (or worse, pass) for the wrong reason.
  if (only) args.push("-t", only.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const result = spawnSync(command, args, { encoding: "utf8" });
  return classifyRun(result, { targeted: !!only });
}
