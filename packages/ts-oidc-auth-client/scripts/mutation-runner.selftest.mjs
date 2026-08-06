/**
 * Self-test for the mutation runner's verdict logic.
 *
 * The gate is release evidence, so the thing that produces the evidence needs
 * evidence of its own. Every case here is a way the toolchain can fail while
 * looking, to a naive gate, exactly like a successfully killed mutation.
 */
import { classifyRun, runTest, vitestBinPath } from "./mutation-runner.mjs";

let failures = 0;
const check = (name, actual, expected) => {
  if (actual === expected) {
    console.log(`  runner self-test: ${name} -> ${actual}`);
  } else {
    console.error(`  runner self-test FAILED: ${name} -> ${actual}, want ${expected}`);
    failures++;
  }
};

// --- the classic false-green: `npx` absent from PATH -----------------------
// A real spawn of a command that does not exist. On Linux this surfaces as
// spawnSync().error with code ENOENT, which a naive gate maps to "killed".
const missing = runTest({
  file: "tests/config-coercion-and-request-integrity.test.ts",
  command: "definitely-not-a-real-command-9d3f",
});
check("command not found", missing.verdict, "infrastructure");

// --- the launch path itself, end to end ------------------------------------
// Every other real spawn here proves the runner notices a BROKEN toolchain.
// This one proves the WORKING path works: it resolves the Vitest CLI the way
// the gate does and runs one real, unmutated test, which must be reported as a
// survivor. Without it, a checkout where Vitest cannot be launched reports
// every mutation as an unexplained failure and never says why.
const live = runTest({
  file: "tests/token.test.ts",
  only: "fnv1a is stable and short",
});
check("vitest is launchable", live.verdict, "survived");
if (live.verdict !== "survived") {
  console.error(`  runner self-test: ${live.detail}`);
  console.error(`  runner self-test: resolved CLI -> ${vitestBinPath()}`);
}

// --- synthetic child-process results ---------------------------------------
const cases = [
  {
    name: "spawn error",
    result: { error: Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" }) },
    targeted: true,
    want: "infrastructure",
  },
  {
    name: "killed by signal",
    result: { status: null, signal: "SIGKILL", stdout: "", stderr: "" },
    targeted: true,
    want: "infrastructure",
  },
  {
    name: "null exit status",
    result: { status: null, stdout: "", stderr: "" },
    targeted: true,
    want: "infrastructure",
  },
  {
    name: "shell command-not-found exit 127",
    result: { status: 127, stdout: "", stderr: "npx: command not found" },
    targeted: true,
    want: "infrastructure",
  },
  {
    name: "vitest config failure",
    result: {
      status: 1,
      stdout: "",
      stderr: "failed to load config from vitest.config.ts\nStartup Error",
    },
    targeted: true,
    want: "infrastructure",
  },
  {
    name: "missing test file",
    result: { status: 1, stdout: "No test files found, exiting with code 1", stderr: "" },
    targeted: true,
    want: "infrastructure",
  },
  {
    name: "non-zero exit with no failing test reported",
    result: { status: 1, stdout: "something went sideways", stderr: "" },
    targeted: true,
    want: "infrastructure",
  },
  {
    name: "zero exit with a filter that matched nothing",
    result: { status: 0, stdout: "Test Files  no tests\n Tests  no tests", stderr: "" },
    targeted: true,
    want: "infrastructure",
  },
  {
    name: "package manager could not resolve the runner",
    result: {
      status: 1,
      stdout: "",
      stderr: "npm error could not determine executable to run",
    },
    targeted: true,
    want: "infrastructure",
  },
  {
    name: "registry unreachable while resolving the runner",
    result: {
      status: 1,
      stdout: "",
      stderr:
        "npm error code ENOTCACHED\nnpm error request to https://registry.npmjs.org/vitest failed",
    },
    targeted: true,
    want: "infrastructure",
  },
  {
    name: "genuine kill",
    result: {
      status: 1,
      stdout: " Test Files  1 failed (1)\n      Tests  1 failed | 14 skipped (15)",
      stderr: "",
    },
    targeted: true,
    want: "killed",
  },
  {
    name: "genuine survivor",
    result: {
      status: 0,
      stdout: " Test Files  1 passed (1)\n      Tests  1 passed | 14 skipped (15)",
      stderr: "",
    },
    targeted: true,
    want: "survived",
  },
];

for (const c of cases) {
  check(c.name, classifyRun(c.result, { targeted: c.targeted }).verdict, c.want);
}

if (failures) {
  console.error(`mutation-runner self-test FAILED: ${failures} case(s)`);
  process.exit(1);
}
console.log("mutation-runner self-test: PASS");
