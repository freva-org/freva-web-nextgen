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
import {
  EXIT_NOT_APPLICABLE,
  EXIT_NOT_RUN,
  EXIT_RETRYABLE,
  report,
} from "../browser-tests/harness.mjs";
import {
  CAPABILITIES,
  CATEGORIES,
  CROSS_BROWSER,
  DEFAULT_GATE_REQUIRES,
  ENGINE_INDEPENDENT,
  NETWORK_SUITES,
  PACKAGE_INDEX_SUITES,
  SUITES,
  SUITE_CLASSES,
  planFor,
} from "../browser-tests/suite-list.mjs";
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

  it("reports an explicit skip - a missing browser - as NOT RUN, never as a pass", () => {
    expect(report("skip", { status: "skipped", detail: "no browser", checks: [] })).toBe(
      EXIT_NOT_RUN,
    );
  });

  it("gives NOT APPLICABLE its own code, only with a reason and passing fallback checks", () => {
    const fallback = [{ name: "the documented fallback held", pass: true }];
    expect(
      report("n/a", { status: "not-applicable", reason: "no JSPI here", checks: fallback }),
    ).toBe(EXIT_NOT_APPLICABLE);
    expect(EXIT_NOT_APPLICABLE).not.toBe(0);
    expect(EXIT_NOT_APPLICABLE).not.toBe(EXIT_NOT_RUN);
  });

  it("refuses NOT APPLICABLE without a reason, with no checks, or over a failing check", () => {
    const passing = [{ name: "a", pass: true }];
    expect(report("no reason", { status: "not-applicable", checks: passing })).toBe(1);
    expect(report("no checks", { status: "not-applicable", reason: "x", checks: [] })).toBe(1);
    expect(
      report("bad fallback", {
        status: "not-applicable",
        reason: "no JSPI here",
        checks: [{ name: "the fallback", pass: false }],
      }),
    ).toBe(1);
  });

  it("gives a narrowly classified transient browser failure its own exit code", () => {
    expect(
      report("retryable", {
        status: "fail",
        retryable: true,
        checks: [{ name: "memory probe", pass: false }],
      }),
    ).toBe(EXIT_RETRYABLE);
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
    const pasteSuite = readFileSync(`${BROWSER_TESTS}/console-paste-and-caret.mjs`, "utf8");
    const adapter = readFileSync(
      fileURLToPath(new URL("../src/console/adapters/jquery-terminal-adapter.ts", import.meta.url)),
      "utf8",
    );
    expect(pasteSuite).toContain('new ClipboardEvent("paste"');
    expect(pasteSuite).toContain("new DataTransfer()");
    expect(pasteSuite).toContain('Object.defineProperty(event, "clipboardData"');
    expect(pasteSuite).toContain("timeout: 5000");
    expect(adapter).toContain('getData("text/plain")');
    expect(pasteSuite).toContain('browserName === "chromium"');
    expect(pasteSuite).toContain("grantPermissions");
    expect(pasteSuite).toContain("navigator.clipboard.writeText");
    expect(pasteSuite).not.toContain("copyFromTextarea");
  });

  it("runs memory measurements in full Chromium rather than forcing a crashing Blink flag", () => {
    const harness = readFileSync(`${BROWSER_TESTS}/harness.mjs`, "utf8");
    expect(harness).toContain('channel: "chromium"');
    expect(harness).toContain("export async function inFullBrowser");
    for (const suite of ["workspace-stream.mjs", "embedding-two-origin.mjs"]) {
      const source = readFileSync(`${BROWSER_TESTS}/${suite}`, "utf8");
      expect(source).toContain("inFullBrowser");
      expect(source).not.toContain("PerformanceManagerInstrumentation");
    }
  });

  it("bounds the implementation-defined memory probe before the process-level timeout", () => {
    const harness = readFileSync(`${BROWSER_TESTS}/harness.mjs`, "utf8");
    const suite = readFileSync(`${BROWSER_TESTS}/workspace-stream.mjs`, "utf8");
    expect(harness).toContain("MemoryMeasurementTimeout");
    expect(harness).toContain("Promise.race");
    expect(harness).toContain("memoryProbeStopped = true");
    expect(suite).toContain("MEMORY_PROBE_TIMEOUT_MS");
    expect(suite).toContain("memoryTimeoutMs: MEMORY_PROBE_TIMEOUT_MS");
    expect(suite).toContain("[workspace-stream] phase:");
    expect(suite).toContain("{ retryable: true }");
  });

  it("gives the Zarr suite named phase deadlines and forceable fixture cleanup", () => {
    const harness = readFileSync(`${BROWSER_TESTS}/harness.mjs`, "utf8");
    const suite = readFileSync(`${BROWSER_TESTS}/zarr.mjs`, "utf8");
    const packageJson = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    expect(suite).toContain("ZARR_START_TIMEOUT_MS");
    expect(suite).toContain("ZARR_PHASE_TIMEOUT_MS");
    expect(suite).toContain("[zarr] starting:");
    expect(suite).toContain("lastExchanges");
    expect(harness).toContain("server.closeAllConnections?.()");
    expect(packageJson.scripts["test:browser:paste"]).toContain("console-paste-and-caret.mjs");
    expect(packageJson.scripts["test:browser:zarr"]).toContain("zarr.mjs");
  });

  it("does not turn WebKit's hidden selection into a passing skip", () => {
    const source = readFileSync(`${BROWSER_TESTS}/console-pointer.mjs`, "utf8");
    const component = readFileSync(
      fileURLToPath(new URL("../src/console/browser-python-console.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain('"selectstart"');
    expect(source).toContain("mouseupsPastConsole");
    expect(source).not.toContain("bp-selection-copy-probe");
    expect(source).not.toMatch(/WebKit[\s\S]{0,300}pass:\s*true/);
    expect(component).toContain("const preserveSelection = dragged || this.#selectionHeld()");
  });
});

describe("the aggregate runner supervises every browser-suite process", () => {
  const source = readFileSync(`${BROWSER_TESTS}/run.mjs`, "utf8");

  it("names a suite before its child process starts", () => {
    expect(source).toMatch(
      /console\.log\(`\\n--- starting \$\{label\} ---`\);[\s\S]{0,300}runChild\(/,
    );
  });

  it("puts a finite, configurable watchdog around each child, and its whole process group", () => {
    expect(source).toContain("BROWSER_SUITE_TIMEOUT_MS");
    expect(source).toMatch(/spawn\(process\.execPath[\s\S]{0,200}detached:/);
    expect(source).toMatch(
      /setTimeout\(\(\) => \{[\s\S]{0,120}kill\("SIGTERM"\)[\s\S]{0,200}SUITE_TIMEOUT_MS\)/,
    );
    expect(source).toContain("process.kill(-child.pid, signal)");
    expect(source).toMatch(/TIMEOUT \$\{label\}/);
  });

  it("never counts an exit 0 without a report() outcome as a pass", () => {
    expect(source).toContain("BROWSER_RESULT_FILE");
    expect(source).toMatch(/r\.status === 0 && outcome\?\.outcome === "pass"/);
    expect(source).toMatch(/exited \$\{r\.status\} without a matching report\(\) outcome/);
    expect(source).toMatch(/Zero executions is not a pass/);
  });

  it("summarises passed, failed, timed out and not applicable separately", () => {
    for (const heading of ["passed", "failed", "timed out", "not applicable"]) {
      expect(source).toContain(`console.log(\`${heading.padEnd(16)}`);
    }
  });

  it("sets the engine explicitly for EVERY suite it starts", () => {
    expect(source).toMatch(/BROWSER_ENGINE: engine,/);
    expect(source).toMatch(/\[\{ suite, engine: "chromium", requires: DEFAULT_GATE_REQUIRES \}\]/);
  });

  it("retries only classified workspace-memory failures in a fresh process", () => {
    expect(source).toContain('new Set(["workspace-stream.mjs"])');
    expect(source).toContain("r.status === EXIT_RETRYABLE");
    expect(source).toContain("BROWSER_RETRY_COUNT");
    expect(source).toContain("fresh browser process");
    expect(source).toMatch(/RETRYABLE_SUITES\.has\(suite\)[\s\S]{0,160}classifiedRetry/);
  });

  it("never retries Firefox or WebKit: the classified failure is Chromium's memory probe", () => {
    expect(source).toContain('const RETRYABLE_ENGINES = new Set(["chromium"])');
    expect(source).toMatch(/RETRYABLE_SUITES\.has\(suite\) &&\s+RETRYABLE_ENGINES\.has\(engine\)/);
  });
});

describe("every suite has an explicit engine classification", () => {
  const all = [...SUITES, ...NETWORK_SUITES, ...PACKAGE_INDEX_SUITES];

  it("classifies every suite the runner can run, and nothing else", () => {
    expect(all.filter((suite) => !(suite in SUITE_CLASSES))).toEqual([]);
    expect(Object.keys(SUITE_CLASSES).filter((suite) => !all.includes(suite))).toEqual([]);
  });

  it.each(Object.entries(SUITE_CLASSES))("%s has a known category and capabilities", (suite, c) => {
    expect(CATEGORIES).toContain(c.category);
    if (c.category === "capability") {
      expect(c.capabilities?.length, `${suite} must name its capability`).toBeGreaterThan(0);
    }
    for (const capability of c.capabilities ?? [])
      expect(Object.keys(CAPABILITIES)).toContain(capability);
    if (c.category === "chromium") {
      expect(c.reason, `${suite} must say why only Chromium can run it`).toBeTruthy();
    }
  });

  it("keeps the default gate's cross-browser set exactly the console category", () => {
    expect([...CROSS_BROWSER].sort()).toEqual(
      Object.entries(SUITE_CLASSES)
        .filter(([, c]) => c.category === "console")
        .map(([suite]) => suite)
        .sort(),
    );
    expect(CROSS_BROWSER.length).toBe(7);
  });

  it.each(["firefox", "webkit"])(
    "a full %s run executes every non-Chromium suite and loses none",
    (engine) => {
      const plan = planFor(engine, all);
      const accounted = [...plan.run, ...plan.withheld.map((w) => w.suite)].sort();
      expect(accounted).toEqual([...all].sort());
      for (const suite of plan.run) expect(SUITE_CLASSES[suite]?.category).not.toBe("chromium");
      for (const w of plan.withheld) expect(w.reason.length).toBeGreaterThan(0);
      // The real interpreter, not just the mock console: the point of the full run.
      expect(plan.run).toEqual(expect.arrayContaining(["repl.mjs", "zarr.mjs", "workspace.mjs"]));
      expect(
        plan.run.filter((s) => SUITE_CLASSES[s]?.category !== "console").length,
      ).toBeGreaterThan(15);
    },
  );

  it("leaves engine-independent suites out of Firefox and WebKit only when asked, never Chromium", () => {
    const names = Object.keys(ENGINE_INDEPENDENT);
    // Each one is a real default suite, with a reason that names what covers the engine part.
    for (const suite of names) {
      expect(all).toContain(suite);
      expect(ENGINE_INDEPENDENT[suite]!.length).toBeGreaterThan(20);
    }
    // The suites that test what DOES differ between engines are never on the list.
    for (const kept of [
      "zarr.mjs",
      "workspace-errors.mjs",
      "workspace-stream.mjs",
      "workspace-lifecycle.mjs",
      "persistence-restart.mjs",
      "csp.mjs",
      "embedding-two-origin.mjs",
      "embedding-waterpark.mjs",
      "capability-fallbacks.mjs",
      "console-real-engine.mjs",
      ...CROSS_BROWSER,
    ]) {
      expect(names).not.toContain(kept);
    }
    for (const engine of ["firefox", "webkit"]) {
      const skipping = planFor(engine, all, { skipEngineIndependent: true });
      expect(skipping.coveredElsewhere.map((c) => c.suite).sort()).toEqual([...names].sort());
      for (const suite of names) expect(skipping.run).not.toContain(suite);
      // Nothing is lost: every suite is run, withheld or covered elsewhere.
      const accounted = [
        ...skipping.run,
        ...skipping.withheld.map((w) => w.suite),
        ...skipping.coveredElsewhere.map((c) => c.suite),
      ].sort();
      expect(accounted).toEqual([...all].sort());
      // Without the flag, they run.
      expect(planFor(engine, all).coveredElsewhere).toEqual([]);
    }
    // Chromium runs them whatever it is asked, and the runner refuses the flag there.
    const reference = planFor("chromium", all, { skipEngineIndependent: true });
    expect(reference.coveredElsewhere).toEqual([]);
    for (const suite of names) expect(reference.run).toContain(suite);
    const runner = readFileSync(`${BROWSER_TESTS}/run.mjs`, "utf8");
    expect(runner).toContain(
      'if (skipEngineIndependent && (fullEngine === null || fullEngine === "chromium")) {',
    );
  });

  it("REQUIRES every capability in Chromium - default gate and engine-full - and none elsewhere", () => {
    const runner = readFileSync(`${BROWSER_TESTS}/run.mjs`, "utf8");
    expect([...DEFAULT_GATE_REQUIRES].sort()).toEqual(Object.keys(CAPABILITIES).sort());
    expect(runner).toMatch(/\{ suite, engine: "chromium", requires: DEFAULT_GATE_REQUIRES \}/);
    // `--engine chromium` is the reference run CI uses, so it requires them too; Firefox and
    // WebKit get no requirement and report an absent capability as not applicable.
    expect(runner).toContain(
      'const requires = fullEngine === "chromium" ? { requires: DEFAULT_GATE_REQUIRES } : {};',
    );
    expect(runner).toMatch(
      /plan\.run\.map\(\(suite\) => \(\{ suite, engine: fullEngine, \.\.\.requires \}\)\)/,
    );
    expect(runner).toContain('BROWSER_REQUIRED_CAPABILITIES: (requires ?? []).join(",")');
  });

  it("turns a missing REQUIRED capability into a failing check, not a not-applicable part", () => {
    const script = [
      `const h = await import(${JSON.stringify(`${BROWSER_TESTS}/harness.mjs`)});`,
      "const checks = []; const na = [];",
      'const recorded = h.capabilityAbsent(checks, na, "jspi", "remote Zarr", "no JSPI");',
      'const reason = h.unavailableUnlessRequired(checks, "jspi", "no JSPI");',
      "console.log(JSON.stringify({ recorded, reason, checks, na }));",
    ].join("\n");
    const outcome = (required: string) =>
      JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, BROWSER_REQUIRED_CAPABILITIES: required },
          encoding: "utf8",
        }),
      );
    const required = outcome("jspi,sync-access-handles");
    expect(required.recorded).toBe(false);
    expect(required.reason).toBeUndefined();
    expect(required.na).toEqual([]);
    expect(required.checks.every((c: { pass: boolean }) => c.pass === false)).toBe(true);
    expect(required.checks.length).toBe(2);
    const optional = outcome("");
    expect(optional.recorded).toBe(true);
    expect(optional.reason).toBe("no JSPI");
    expect(optional.checks).toEqual([]);
    expect(optional.na).toEqual([{ name: "remote Zarr", reason: "no JSPI" }]);
  });

  it("offers the engine-full commands, strict, through the supervised runner", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    for (const engine of ["chromium", "firefox", "webkit"]) {
      const script = pkg.scripts[`test:browser:${engine}`];
      expect(script).toContain("BROWSER_STRICT=1");
      expect(script).toContain(`browser-tests/run.mjs --engine ${engine}`);
    }
    // Every engine script runs EVERY suite. Only Firefox's `:ci` variant - the slow job - leaves
    // the engine-independent ones to the Chromium job; Chromium and WebKit have none.
    for (const engine of ["chromium", "firefox", "webkit"]) {
      expect(pkg.scripts[`test:browser:${engine}`]).not.toContain("--skip-engine-independent");
    }
    expect(pkg.scripts["test:browser:chromium:ci"]).toBeUndefined();
    expect(pkg.scripts["test:browser:webkit:ci"]).toBeUndefined();
    const ci = pkg.scripts["test:browser:firefox:ci"];
    expect(ci).toContain("BROWSER_STRICT=1");
    expect(ci).toContain("browser-tests/run.mjs --engine firefox --skip-engine-independent");
  });

  it("routes the selected engine into every launch the harness makes", () => {
    const harness = readFileSync(`${BROWSER_TESTS}/harness.mjs`, "utf8");
    expect(harness).toMatch(
      /const \{ browserName = ENGINE, fullBrowser = false, viewport \} = options;/,
    );
    expect(harness).toMatch(/const \{ browserName = ENGINE, \.\.\.contextOptions \} = options;/);
    expect(harness).toContain('process.env.BROWSER_ENGINE ?? "chromium"');
  });

  it.each(all.filter((suite) => SUITE_CLASSES[suite]?.category !== "chromium"))(
    "%s does not hard-code Chromium for its own launches",
    (suite) => {
      const source = readFileSync(`${BROWSER_TESTS}/${suite}`, "utf8");
      expect(source).not.toMatch(/playwright\.chromium\./);
      expect(source).not.toMatch(/browserName:\s*"chromium"/);
    },
  );
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

describe("long browser phases have real, named, terminating deadlines", () => {
  const read = (suite: string) => readFileSync(`${BROWSER_TESTS}/${suite}`, "utf8");
  const all = [...SUITES, ...NETWORK_SUITES, ...PACKAGE_INDEX_SUITES];

  it.each(all)("%s never passes evaluate() a timeout it would ignore", (suite) => {
    const offending = read(suite)
      .split("\n")
      .filter((line) => /\.evaluate\(/.test(line) && /,\s*null,\s*\{\s*timeout/.test(line));
    expect(offending, "page.evaluate(fn, arg) takes no options; use a phase deadline").toEqual([]);
  });

  it("two-origin embedding runs every step as an awaited phase that rejects at its deadline", () => {
    const source = read("embedding-two-origin.mjs");
    expect(source).toContain('createPhases("embedding-two-origin"');
    expect(source).toContain("onDeadline: () => page.context().close()");
    // The racing API only: a marker that merely ARMS a timer cannot unwind a pending evaluate().
    expect(source).not.toMatch(/phases\.start\(|phases\.finish\(|phases\.fail\(/);
    for (const phase of [
      "capability probe",
      "portal and iframe navigation",
      "platform facts",
      "Python startup in the playground",
      "bridge handshake",
      "small artifact setup",
      "forged-envelope checks",
      "small parent-mediated download",
      "large artifact creation",
      "complete artifact transfer",
      "memory measurement negative control",
      "interrupted transfer",
      "session renewal after the interrupted transfer",
      "playground document reachable after the interrupted transfer",
      "bridge operation: transcript setup",
      "bridge operation: transcript request",
      "bridge operation: clear transcript",
      "bridge operation: clear history",
      "bridge operation: interpreter restart",
      "bridge operation: unknown-operation refusal",
      "iframe renewal",
      "policy violations",
    ]) {
      expect(source, phase).toMatch(new RegExp(`run\\(\\s*\`?"?${phase}`));
    }
    // No aggregate phase left for the bridge operations: each has its own deadline and marker.
    expect(source).not.toContain('"bounded bridge operations"');
    expect(source).toMatch(/300_000, \(\) =>\s+frame\.evaluate\(\(\) => window\.__pg\.start\(\)\)/);
    expect(source).toContain("checks.push(...(await cleanupChecks(phases)));");
  });

  it("proves the session renewed after the reload BEFORE any bridge operation", () => {
    const source = read("embedding-two-origin.mjs");
    // The fixture drops the old session exactly when the host does, and exposes the host's own.
    expect(source).toContain(
      "onInvalidated: (why) => { state.ready = null; state.invalidations.push(why); },",
    );
    expect(source).toContain("hostSession: () => host.sessionId,");
    // Renewal means: a NEW, non-null session that the host and the fixture agree on.
    expect(source).toMatch(
      /ready !== null && ready !== old && window\.__portal\.hostSession\(\) === ready/,
    );
    const reload = source.indexOf("const sessionBeforeReload");
    const renewal = source.indexOf('"session renewal after the interrupted transfer"');
    const firstOperation = source.indexOf('"bridge operation: transcript setup"');
    expect(reload).toBeGreaterThan(0);
    expect(renewal).toBeGreaterThan(reload);
    expect(firstOperation).toBeGreaterThan(renewal);
    // …and no sleep stands in for it.
    const between = source.slice(reload, firstOperation);
    expect(between).not.toMatch(/waitForTimeout|setTimeout/);
  });

  it("after a reload, reaches the child through the fixture's postMessage line, not the driver", () => {
    const source = read("embedding-two-origin.mjs");
    // The line is the fixture's own: a separate channel, accepted only from the parent window at
    // the host origin, answered only to it, with a closed set of operations.
    expect(source).toContain('data.channel !== "fixture-control" || !(data.op in FIXTURE_OPS)');
    expect(source).toContain("event.source !== parent || event.origin !==");
    expect(source).toContain("event.source !== frame.contentWindow");
    expect(source).toMatch(/did not answer fixture operation " \+ op \+ " within 10 s/);
    // Both reloads are started from inside the child, and every child read after the first reload
    // goes through the line: no Playwright evaluation in the child from the reload onwards. The
    // one driver evaluation left in the renewal helper is a bounded diagnostic that only logs.
    const reload = source.indexOf("const sessionBeforeReload");
    const tail = source.slice(reload, source.indexOf("return await finish();", reload));
    expect(tail).not.toMatch(/frame\.evaluate\(/);
    expect(source).toMatch(/withDeadline\(\s*frame\.evaluate\(\(\) => true\),\s*5_000/);
    expect(tail.match(/window\.__portal\.child\("reload"\)/g)?.length).toBe(2);
    // Renewal is proved from inside the NEW document, by the session id it reports.
    const renewal = source.indexOf('"session renewal after the interrupted transfer"');
    const reach = source.indexOf('"playground document reachable after the interrupted transfer"');
    const firstChildUse = source.indexOf('"bridge operation: transcript setup"');
    expect(reach).toBeGreaterThan(renewal);
    expect(firstChildUse).toBeGreaterThan(reach);
    expect(source).toContain("reached.childSession === renewed.ready");
    expect(source).toContain("reached.childSession === renewal.value.ready");
    expect(tail).not.toMatch(/waitForTimeout/);
  });

  it("sizes the two-origin transfer by what can be measured, and uses that size throughout", () => {
    const source = read("embedding-two-origin.mjs");
    expect(source).toContain("const MEMORY_TEST_MIB = 96;");
    expect(source).toContain("const PORTABLE_MIB = 16;");
    expect(source).toContain("const transferMiB = canMeasure ? MEMORY_TEST_MIB : PORTABLE_MIB;");
    expect(source).not.toMatch(/BIG_MIB/);
    expect(source).toContain("Math.min(8 * 1024 * 1024, transferBytes / 4)");
  });

  it("checks forged envelopes against the CURRENT protocol, with a positive control first", () => {
    const source = read("embedding-two-origin.mjs");
    expect(source).toContain(
      'import { EMBED_CHANNEL, EMBED_PROTOCOL_VERSION } from "../dist/embed/protocol.js";',
    );
    expect(source).not.toMatch(/version:\s*\d/);
    expect(source).toContain("version: EMBED_PROTOCOL_VERSION + 1");
    const control = source.indexOf("a well-formed envelope from the child IS accepted");
    const negative = source.indexOf("a message with the wrong protocol version is ignored");
    expect(control).toBeGreaterThan(0);
    expect(negative).toBeGreaterThan(control);
    const unit = readFileSync(
      fileURLToPath(new URL("./embed-transfers.test.ts", import.meta.url)),
      "utf8",
    );
    expect(unit).not.toMatch(/version:\s*\d/);
    expect(unit).toContain("version: EMBED_PROTOCOL_VERSION");
  });

  it("capability-fallbacks bounds its starts and terminates the engine at a deadline", () => {
    const source = read("capability-fallbacks.mjs");
    expect(source).toContain('createPhases("capability-fallbacks"');
    expect(source).toContain("onDeadline: () => terminateEngines(page)");
    expect(source).not.toMatch(/phases\.start\(/);
    for (const phase of [
      "no-JSPI startup",
      "native JSPI startup",
      "sync handles removed: startup",
      "console with sync handles removed",
    ]) {
      expect(source, phase).toContain(`phases.run("${phase}"`);
    }
    expect(source).toMatch(
      /phases\.run\("no-JSPI startup", START_TIMEOUT_MS, \(\) =>\s+startEngine/,
    );
    expect(read("zarr.mjs")).toMatch(/ZarrPhaseTimeout\) \{[\s\S]{0,500}terminateEngines\(page\)/);
  });

  it("bounds teardown: dispose, context.close() and browser.close()", () => {
    const harness = readFileSync(`${BROWSER_TESTS}/harness.mjs`, "utf8");
    expect(harness).toMatch(
      /withDeadline\(\s*page\.evaluate\(async \(\) => \{[\s\S]{0,600}TEARDOWN_MS/,
    );
    expect(harness).toContain('await close("context.close()", () => context.close());');
    expect(harness).toContain('await close("browser.close()", () => browser.close());');
    expect(harness).toMatch(/withDeadline\(operation\(\), TEARDOWN_MS, what\)/);
  });

  it.each(all)("%s never parses a Python repr as JSON by slicing its quotes", (suite) => {
    expect(read(suite)).not.toMatch(/JSON\.parse\([^)]*\.slice\(1, -1\)/);
  });
});

describe("WebKit fixes stay capability-driven and narrow", () => {
  const read = (suite: string) => readFileSync(`${BROWSER_TESTS}/${suite}`, "utf8");
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("capability-fallbacks expects the reason the probe says is right, not one fixed reason", () => {
    const source = code(read("capability-fallbacks.mjs"));
    expect(source).toContain("expectedReasonWithoutSyncHandles(native)");
    expect(source).toContain("workspace?.reason === expected");
    expect(source).toContain("detailMatchesReason(workspace)");
    // The refusal and the console both show what the ENGINE reported, whichever reason it was.
    expect(source).toContain("listing.error === workspace?.detail");
    expect(source).toContain("panel.showsReportedReason");
    expect(source).not.toContain('includes("synchronous file access handles")');
  });

  it("csp keeps every policy check and makes only the OPFS readback capability-aware", () => {
    const source = code(read("csp.mjs"));
    expect(source).toContain("if (status?.available === true) {");
    expect(source).toContain("workspaceAbsenceConsistent(status, probed)");
    expect(source).toContain('"sync-access-handles",');
    expect(source).toContain("fallback.refused === status?.detail");
    for (const kept of [
      "no directive blocked anything the engine or the console needed",
      "the header is genuinely in force: a cross-origin fetch is refused",
      "a module Worker and a WebAssembly interpreter start under this policy",
    ]) {
      expect(read("csp.mjs")).toContain(kept);
    }
  });

  it("csp bounds every network probe and proves a refusal by what reached the server", () => {
    const source = code(read("csp.mjs"));
    expect(source).toContain('createPhases("csp", { onDeadline: () => terminateEngines(page) })');
    for (const phase of [
      "worker fetch: granted origin",
      "worker fetch: refused origin",
      "page fetch: refused by the page policy",
    ]) {
      expect(source, phase).toContain(`phases.run("${phase}"`);
    }
    // Bounded inside Python as well, and a timeout is reported as unsettled, not as a refusal.
    expect(source).toContain("asyncio.wait_for(pyfetch(");
    // A refusal is proved by the refused origin receiving NOTHING; the granted one by one request.
    expect(source).toContain("blockedHits.count === 0");
    expect(source).toContain("allowedHits.count === 1");
    expect(source).toContain("granted.outcome?.settled === true");
    // The run's error and the probe's own outcome are never merged into one object.
    expect(source).toContain("return { runError: r.error ?? null, outcome: parsed, text };");
    expect(source).toContain("checks.push(...(await cleanupChecks(phases)));");
    // The servers close within a bound, so a wedged connection cannot hold the process.
    expect(source).not.toMatch(/await (server|allowed|blocked)\.close\(\);/);
  });

  it("the Waterpark negative control reads the refused frame from INSIDE, never via the parent", () => {
    const source = code(read("embedding-waterpark.mjs"));
    expect(source).not.toMatch(/\.contentDocument/);
    expect(source).toContain("strictChild.evaluate(");
    // No error is filtered anywhere: neither in this suite nor in the shared harness.
    expect(source).not.toMatch(/pageerror/);
    const harness = read("harness.mjs");
    expect(harness).toContain('page.on("pageerror", (e) => errors.push(e.message));');
    expect(harness).toContain(
      'checks.push({ name: "no page errors", pass: false, detail: errors[0] });',
    );
  });

  it("the workspace fallback checks the reason against an independent probe", () => {
    const harness = read("harness.mjs");
    expect(harness).toMatch(
      /export async function workspaceFallbackChecks[\s\S]{0,600}workspaceAbsenceConsistent\(status, worker\)/,
    );
  });
});
