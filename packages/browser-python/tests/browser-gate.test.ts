/**
 * The strict browser gate has to be able to FAIL, and the exit code is the only thing CI reads.
 *
 * `browser-tests/run.mjs` distinguishes three outcomes by exit code - 0 pass, 3 NOT RUN, anything
 * else a failure - so a suite that prints "FAIL" and exits 0 is reported as a pass; and
 * `[].every(...)` is `true`, so a status recomputed from an EMPTY array of checks turns a
 * recorded failure back into a pass. That is exercised through fixtures under
 * `tests/fixtures/gate/` which import the harness's own `inBrowser` and `report` - not copies -
 * and read no `dist/`, no `.runtime/` and no network. The real suites are checked STRUCTURALLY
 * instead: that they route their outcomes through those shared primitives.
 */
import { execFileSync, execFileSync as run } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { report } from "../browser-tests/harness.mjs";
import { NETWORK_SUITES, PACKAGE_INDEX_SUITES, SUITES } from "../browser-tests/suite-list.mjs";
import {
  SUITE_OPTIONAL_PACKAGES,
  SUITE_REQUIREMENTS,
} from "../browser-tests/suite-requirements.mjs";

const BROWSER_TESTS = fileURLToPath(new URL("../browser-tests", import.meta.url));
const GATE_FIXTURES = fileURLToPath(new URL("./fixtures/gate", import.meta.url));
const MISSING = "/definitely/missing/chromium";

/** Run a script and report its exit code and combined output, whatever it does. */
function runScript(path: string, env: Record<string, string>) {
  try {
    const stdout = run(process.execPath, [path], {
      env: { ...process.env, PLAYWRIGHT_CHROMIUM_PATH: MISSING, ...env },
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120_000,
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("a suite that could not run is never a pass, in any checkout state", () => {
  it("exits non-zero when the browser cannot launch, under BROWSER_STRICT=1", () => {
    const { code, output } = runScript(`${GATE_FIXTURES}/launch-failure-suite.mjs`, {
      BROWSER_STRICT: "1",
    });
    expect(code, output.slice(0, 600)).not.toBe(0);
    // Not 3 either: `run.mjs` reads 3 as NOT RUN, which under strict mode is the same lie.
    expect(code, "3 means NOT RUN, which a failed launch is not").not.toBe(3);
    expect(output).toMatch(/NOT A PASS/);
  });

  it("exits non-zero for a suite that claims a pass having executed nothing", () => {
    const { code, output } = runScript(`${GATE_FIXTURES}/empty-pass-suite.mjs`, {
      BROWSER_STRICT: "1",
    });
    expect(code, output.slice(0, 600)).not.toBe(0);
    expect(code).not.toBe(3);
    expect(output).toMatch(/no checks ran at all/);
  });

  it("does the same with strict mode OFF, because zero checks is not a pass either way", () => {
    // BROWSER_STRICT governs whether a MISSING BROWSER may be reported as a skip. It has never
    // governed whether an empty result may be called a pass: a suite that ran nothing has
    // demonstrated nothing regardless of how it was invoked.
    const { code } = runScript(`${GATE_FIXTURES}/empty-pass-suite.mjs`, { BROWSER_STRICT: "0" });
    expect(code).not.toBe(0);
  });
});

describe("report() is the single authority on what a pass is", () => {
  it("refuses to call zero executed checks a pass", () => {
    expect(report("empty", { status: "pass", checks: [] })).not.toBe(0);
  });

  it("never lets check aggregation overrule an explicit failure", () => {
    expect(report("explicit", { status: "fail", checks: [{ name: "a", pass: true }] })).not.toBe(0);
  });

  it("still fails on a failing check", () => {
    expect(report("failing", { status: "pass", checks: [{ name: "a", pass: false }] })).not.toBe(0);
  });

  it("passes only when the status says so and at least one check really ran", () => {
    expect(report("good", { status: "pass", checks: [{ name: "a", pass: true }] })).toBe(0);
  });

  it("keeps an explicit skip a skip, which is how a missing browser is reported", () => {
    expect(report("skip", { status: "skipped", detail: "no browser", checks: [] })).toBe(0);
  });
});

describe("browser input and feature flags are portable", () => {
  it("lets Playwright resolve the host platform's native paste modifier", () => {
    for (const suite of ["console-paste-and-caret.mjs", "console-real-engine.mjs"]) {
      const source = readFileSync(`${BROWSER_TESTS}/${suite}`, "utf8");
      expect(source, `${suite} must use Playwright's platform-aware paste shortcut`).toMatch(
        /keyboard\.press\("ControlOrMeta\+V"\)/,
      );
      expect(source).not.toMatch(/keyboard\.press\("Control\+V"\)/);
    }
  });

  it("enables memory instrumentation as a Blink runtime feature", () => {
    for (const suite of ["workspace-stream.mjs", "embedding-two-origin.mjs"]) {
      const source = readFileSync(`${BROWSER_TESTS}/${suite}`, "utf8");
      expect(source).toContain("--enable-blink-features=PerformanceManagerInstrumentation");
      expect(source).not.toContain("--enable-features=PerformanceManagerInstrumentation");
    }
  });
});

describe("the aggregate runner supervises every browser-suite process", () => {
  const source = readFileSync(`${BROWSER_TESTS}/run.mjs`, "utf8");

  it("names a suite before the blocking child process starts", () => {
    expect(source).toMatch(
      /console\.log\(`\\n--- starting \$\{label\} ---`\);[\s\S]{0,300}spawnSync\(/,
    );
  });

  it("puts a finite, configurable timeout around each child", () => {
    expect(source).toContain("BROWSER_SUITE_TIMEOUT_MS");
    expect(source).toMatch(/spawnSync\([\s\S]{0,500}timeout: SUITE_TIMEOUT_MS/);
    expect(source).toMatch(/TIMEOUT \$\{label\}/);
  });
});

// The structural half. `report()` cannot be fail-open, but a suite can route around it by
// exiting 0 itself or writing its own copy of the prerequisite guard with a laxer exit code. Nine
// suites had hand-written copies, three with hard-coded package lists that could drift from
// `suite-requirements.mjs`. These read the sources rather than running them.
describe("every suite routes its outcome through the shared primitives", () => {
  // The runner's OWN list, not a directory scan. `browser-tests/` also holds helpers -
  // `harness.mjs`, `console-fixture.mjs`, `bundle-console.mjs` - which are imported rather than
  // executed and have no exit code to audit. Reading `SUITES` audits exactly what CI runs; the
  // opt-in suites `run.mjs` appends under BROWSER_PYTHON_NETWORK=1 and
  // BROWSER_PYTHON_PACKAGE_INDEX=1 are added back.
  const suites = [...SUITES, ...NETWORK_SUITES, ...PACKAGE_INDEX_SUITES];

  it("finds the suites at all, so nothing below is vacuous", () => {
    expect(suites.length).toBeGreaterThan(20);
  });

  it.each(suites)("%s ends by exiting report(), never a bare exit code", (suite) => {
    const source = readFileSync(`${BROWSER_TESTS}/${suite}`, "utf8");
    expect(source, `${suite} does not call report()`).toMatch(/report\(/);
    expect(
      source,
      `${suite} must exit through report() so an empty or failed result cannot become 0`,
    ).toMatch(/process\.exit\(\s*report\(/);
  });

  it.each(suites)("%s never exits 0 by hand", (suite) => {
    const source = readFileSync(`${BROWSER_TESTS}/${suite}`, "utf8");
    // `process.exit(0)` is the fail-open shape in its most direct form.
    expect(source, `${suite} exits 0 without going through report()`).not.toMatch(
      /process\.exit\(\s*0\s*\)/,
    );
  });

  const wheelDependent = Object.entries(SUITE_REQUIREMENTS)
    .filter(([, packages]) => packages.length > 0)
    .map(([suite]) => suite);

  // The other half of the same rule. A suite with OPTIONAL wheels may ask `runtimeHasPackages`
  // inline, because it runs either way and skips one check - reporting NOT RUN would throw away
  // every check that needs no wheel. What it must not do is gate on them.
  const optionalOnly = Object.keys(SUITE_OPTIONAL_PACKAGES);

  it("has wheel-dependent suites to check", () => {
    expect(wheelDependent.length).toBeGreaterThan(5);
  });

  it.each(wheelDependent)("%s declares its prerequisites through requireRuntimeFor", (suite) => {
    const source = readFileSync(`${BROWSER_TESTS}/${suite}`, "utf8");
    expect(
      source,
      `${suite} needs wheels and must say so through the shared guard, not its own copy`,
    ).toMatch(new RegExp(`requireRuntimeFor\\([\\s\\S]{0,200}?"${suite.replace(/\./g, "\\.")}"`));
    // No hand-written prerequisite exit: that is the copy that drifts.
    expect(source, `${suite} still has a hand-written runtime guard`).not.toMatch(
      /if \(!runtimeHasPackages\(/,
    );
  });

  it.each(optionalOnly)("%s uses optional wheels inline and does not gate on them", (suite) => {
    const source = readFileSync(`${BROWSER_TESTS}/${suite}`, "utf8");
    expect(source, `${suite} declares optional wheels but never checks for them`).toMatch(
      /runtimeHasPackages\(/,
    );
    expect(
      source,
      `${suite} gates on wheels it declared optional, which throws away its other checks`,
    ).not.toMatch(/requireRuntimeFor\(/);
  });

  it("has an inventory entry for EVERY suite, including the empty ones", () => {
    // "No entry" and "declared to need nothing" must be distinguishable, or a suite that needs
    // wheels hides. `freva-live.mjs` starts the `freva-client` profile, which needs micropip;
    // undeclared, an incomplete runtime makes it report a test FAILURE rather than NOT RUN. An
    // explicit `[]` is a claim that can be checked; an absent key is only silence.
    const undeclared = suites.filter((suite) => !(suite in SUITE_REQUIREMENTS));
    expect(
      undeclared,
      "every suite needs an entry in suite-requirements.mjs, `[]` included",
    ).toEqual([]);
  });

  it("names no suite the runner does not run", () => {
    const stale = Object.keys(SUITE_REQUIREMENTS).filter((suite) => !suites.includes(suite));
    expect(stale, "suite-requirements.mjs names suites the runner never runs").toEqual([]);
  });

  it("keeps the two wheel declarations disjoint", () => {
    for (const suite of optionalOnly) {
      expect(
        SUITE_REQUIREMENTS[suite] ?? [],
        `${suite} cannot have wheels that are both required and optional`,
      ).toEqual([]);
    }
  });
});

// And the primitive itself, driven directly. `requireRuntimeFor` decides between "not built",
// "prerequisites absent" and "carry on", which is the whole contract `run.mjs` reads. Each is
// asserted through a real process exit, with the wheel check pointed at a directory the test
// controls.
describe("requireRuntimeFor is the one way a suite says its wheels are absent", () => {
  /** Invoke the primitive in a child process with a chosen runtime directory. */
  function invoke(suite: string, runtimeDir: string) {
    const script = [
      `process.env.BROWSER_PYTHON_RUNTIME_DIR = ${JSON.stringify(runtimeDir)};`,
      `const { requireRuntimeFor } = await import(${JSON.stringify(`${BROWSER_TESTS}/harness.mjs`)});`,
      `requireRuntimeFor("fixture", ${JSON.stringify(suite)});`,
      `console.log("CARRIED ON");`,
    ].join("\n");
    try {
      const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 60_000,
      });
      return { code: 0, output: stdout };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  it("exits 3 - NOT RUN, not a failure - when the wheels are absent", () => {
    const { code, output } = invoke("workspace.mjs", "/definitely/missing/runtime");
    expect(code, output.slice(0, 400)).toBe(3);
    expect(output).toMatch(/RUNTIME INCOMPLETE/);
    // The reason names the packages, so a NOT RUN line is actionable rather than mysterious.
    expect(output).toMatch(/netcdf4/);
  });

  it("carries on for a suite that needs no wheels, whatever the runtime holds", () => {
    const { code, output } = invoke("csp.mjs", "/definitely/missing/runtime");
    expect(code, output.slice(0, 400)).toBe(0);
    expect(output).toMatch(/CARRIED ON/);
  });

  it("refuses a suite that is not declared in suite-requirements.mjs", () => {
    // Undeclared is a mistake in the suite, not a statement about the runtime, so it is not 3:
    // `run.mjs` would print NOT RUN and the gap would look like coverage.
    const { code, output } = invoke("not-a-real-suite.mjs", "/definitely/missing/runtime");
    expect(code).not.toBe(0);
    expect(code, "an undeclared suite must not masquerade as NOT RUN").not.toBe(3);
    expect(output).toMatch(/suite-requirements/);
  });
});

// The property this whole file exists to have: the unit result does not depend on which generated
// files happen to be lying around. Both states from the report are exercised directly, by pointing
// the harness at directories guaranteed absent rather than by deleting the developer's.
describe("the gate's own result does not depend on dist/ or .runtime/", () => {
  /** Re-run this file's own suites in a child vitest, with chosen prerequisites. */
  function rerunSelf(env: Record<string, string>) {
    const self = fileURLToPath(new URL("./browser-gate.test.ts", import.meta.url));
    try {
      const stdout = execFileSync(
        process.execPath,
        [fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)), "run", self],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { ...process.env, ...env, BROWSER_GATE_CHILD: "1" },
          encoding: "utf8",
          stdio: "pipe",
          timeout: 300_000,
        },
      );
      return { code: 0, output: stdout };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  // Guard against infinite recursion: the child runs everything above, but not this.
  const outer = process.env.BROWSER_GATE_CHILD !== "1";

  it.runIf(outer)("passes with .runtime/ absent, wherever the real one is", () => {
    const { code, output } = rerunSelf({
      BROWSER_PYTHON_RUNTIME_DIR: "/definitely/missing/runtime",
    });
    const plainOutput = stripVTControlCharacters(output);
    expect(code, plainOutput.slice(-1500)).toBe(0);
    // Proof the child really RAN the suites rather than collecting nothing: vitest exits 0 for
    // an empty selection too, which would make this assertion vacuous.
    const ran = /Tests\s+(\d+) passed/.exec(plainOutput);
    expect(ran, `no test count in:\n${plainOutput.slice(-1200)}`).not.toBeNull();
    expect(Number(ran?.[1] ?? 0)).toBeGreaterThan(50);
    expect(plainOutput).toMatch(/Test Files\s+1 passed/);
  });

  it("reads no built or assembled file itself", () => {
    // A cheap structural guard on the same property. Every assertion above works from suite
    // SOURCES, the harness's exported functions, and fixtures that import neither `dist/` nor
    // `.runtime/`. Comments are stripped first, because this file and its fixtures TALK about
    // those directories at length; what matters is whether any code reaches for one.
    const withoutComments = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const fixture of ["launch-failure-suite.mjs", "empty-pass-suite.mjs"]) {
      const code = withoutComments(readFileSync(`${GATE_FIXTURES}/${fixture}`, "utf8"));
      expect(code, `${fixture} must not read dist/`).not.toMatch(/dist/);
      expect(code, `${fixture} must not read .runtime/`).not.toMatch(/\.runtime|RUNTIME_DIR/);
      expect(code, `${fixture} must not require a build`).not.toMatch(/requireDist|bundleConsole/);
      // And it must go through the real harness, not a copy of it.
      expect(code, `${fixture} must import the harness itself`).toMatch(
        /from "\.\.\/\.\.\/\.\.\/browser-tests\/harness\.mjs"/,
      );
    }
  });
});
