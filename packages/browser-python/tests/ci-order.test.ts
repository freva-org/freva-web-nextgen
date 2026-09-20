/**
 * The order CI and publishing actually run things in, asserted rather than remembered.
 *
 * `npm test` runs in the root CI job and again inside `npm publish`, and neither prepares a
 * runtime first, so a unit test reading `.runtime/pyodide-lock.json` turns every clean checkout
 * into failures that look like defects in the package. The rule preventing that lives in
 * `freva-closure.test.ts`; this is the other half, checking the workflow still puts the
 * production-asset gates where they fail EARLY, before dependent suites report a misleading NOT
 * RUN. Read as text, because a workflow file is a program nobody runs locally.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CI = join(ROOT, ".github/workflows/ci.yml");
const PUBLISH = join(ROOT, ".github/workflows/publish.yml");

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
/** Where a command first appears in a file, or Infinity if it never does. */
const at = (text: string, needle: string) => {
  const index = text.indexOf(needle);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
};

describe("the browser-python CI job", () => {
  const workflow = read(CI);

  it("exists", () => {
    expect(workflow).toBeTruthy();
  });

  it("assembles and VERIFIES the runtime before the browser gate", () => {
    const job = workflow!.slice(workflow!.indexOf("  browser-python:"));
    const prepare = at(job, "scripts/prepare-runtime.mjs");
    const check = at(job, "scripts/check-runtime.mjs");
    const gate = at(job, "test:browser:strict");
    expect(prepare).toBeLessThan(check);
    // The check must come BEFORE the gate. A suite whose wheels are missing exits 3 and is
    // printed as NOT RUN, which reads like a pass in a summary; failing on an incomplete runtime
    // first turns that into a red build with one legible line.
    expect(check).toBeLessThan(gate);
  });

  it("runs the packaging and byte gates after the build", () => {
    const job = workflow!.slice(workflow!.indexOf("  browser-python:"));
    expect(at(job, "npm run build")).toBeLessThan(at(job, "test:packaging"));
    expect(at(job, "npm run build")).toBeLessThan(at(job, "check:bytes"));
  });
});

describe("unit tests run where no runtime has been prepared", () => {
  it("the root CI job runs `npm test` without preparing one", () => {
    const workflow = read(CI)!;
    const unitJob = workflow.slice(0, workflow.indexOf("  browser-python:"));
    expect(unitJob).toMatch(/run: npm test/);
    // If this ever changes, the constraint below stops being free - but it is the constraint that
    // keeps a clean checkout green, so it should change deliberately.
    expect(unitJob).not.toMatch(/prepare-runtime/);
  });

  it("publishing runs `npm test` without preparing one either", () => {
    const workflow = read(PUBLISH);
    expect(workflow).toBeTruthy();
    expect(workflow!).toMatch(/run: npm test/);
    expect(workflow!).not.toMatch(/prepare-runtime/);
  });
});

/**
 * Publication must not race ahead of the gate that would have stopped it. A `push: [main]`
 * trigger on `publish.yml` starts it at the same moment as `ci.yml`, and the publish job's own
 * `npm test` is the monorepo's unit suites - for this package no runtime, no browser, no
 * packaging and no byte gate - so a commit that broke the strict Chromium acceptance suite, the
 * packed TypeScript consumer or the bundle budget could reach the registry while CI went red.
 */
describe("publishing waits for the gate", () => {
  const workflow = read(PUBLISH);

  it("exists", () => {
    expect(workflow).toBeTruthy();
  });

  it("is triggered by CI COMPLETING, not by the same push CI is still running on", () => {
    expect(workflow).toMatch(/workflow_run:/);
    expect(workflow).toMatch(/workflows:\s*\[?\s*["']?CI["']?/);
    // A `push:` trigger here would restore the race.
    const triggers = workflow!.slice(0, workflow!.indexOf("jobs:"));
    expect(triggers).not.toMatch(/^\s*push:/m);
  });

  it("refuses to run at all unless that CI run SUCCEEDED", () => {
    expect(workflow).toMatch(/workflow_run\.conclusion\s*==\s*'success'/);
  });

  it("hands the decision to a script that can be tested, on every path", () => {
    // Regexes over the YAML proving it contains `workflow_run.head_sha` and `rev-parse HEAD`
    // cannot catch a bypass written in the same words they match. What the SHA comparison does
    // is decided by `scripts/require-ci-success.mjs`, and `tests/publish-gate.test.ts` drives
    // that through every event path. What is left HERE is that the workflow calls it and passes
    // it what it needs.
    expect(workflow).toMatch(/require-ci-success\.mjs/);
    expect(workflow).toMatch(/rev-parse HEAD/);
    expect(workflow).toMatch(/WORKFLOW_RUN_JSON/);
  });

  it("still runs the gates that protect the artifact it is about to upload", () => {
    // The browser and runtime gates are CI's, and depending on them is the point of the trigger
    // above. These two are about the tarball itself and are cheap enough to repeat here.
    expect(workflow).toMatch(/test:packaging/);
    expect(workflow).toMatch(/check:bytes/);
  });
});
