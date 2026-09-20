/**
 * Publication, decided by a function this can actually run, instead of by an untestable expression.
 *
 * `publish.yml` triggers on `workflow_run` so it cannot race CI, and keeps `workflow_dispatch` as
 * a manual escape hatch. Guarded as `github.event_name == 'workflow_dispatch' || (…the real
 * checks…)`, a human clicking "Run workflow" skips every one of them: no CI conclusion consulted,
 * no SHA compared, and the manual path's own testing is `npm test` plus two tarball checks. A
 * regex over the YAML cannot catch that, because the bypass is written in the words the regex
 * looks for, so these drive the decision itself through every event path that can reach it.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decide, fetchRuns, REQUIRED_WORKFLOW } from "../../../scripts/require-ci-success.mjs";

const SHA = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";

/** A CI run as the API reports one. */
const run = (over: Record<string, unknown> = {}) => ({
  id: 42,
  name: REQUIRED_WORKFLOW,
  head_sha: SHA,
  event: "push",
  status: "completed",
  conclusion: "success",
  ...over,
});

describe("the workflow_run path", () => {
  it("publishes when a push CI run for THIS commit succeeded", () => {
    const verdict = decide({
      eventName: "workflow_run",
      headSha: SHA,
      workflowRun: run(),
    });
    expect(verdict.ok, verdict.reason).toBe(true);
  });

  it.each([
    ["failure", "failure"],
    ["cancelled", "cancelled"],
    ["timed out", "timed_out"],
    ["skipped", "skipped"],
    ["still running", null],
  ])("refuses a CI run that %s", (_label, conclusion) => {
    const verdict = decide({
      eventName: "workflow_run",
      headSha: SHA,
      workflowRun: run({ conclusion }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/not success/);
  });

  it("refuses a CI run that was for a pull request rather than a push", () => {
    const verdict = decide({
      eventName: "workflow_run",
      headSha: SHA,
      workflowRun: run({ event: "pull_request" }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/not a push run/);
  });

  it("refuses when main has moved past the commit CI verified", () => {
    // The race this trigger exists to close: another push lands between CI finishing and this
    // workflow starting, and publishing then publishes a commit nothing looked at.
    const verdict = decide({
      eventName: "workflow_run",
      headSha: OTHER,
      workflowRun: run({ head_sha: SHA }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/Not publishing a commit no gate has looked at/);
  });

  it("refuses a workflow_run event with no run attached", () => {
    expect(decide({ eventName: "workflow_run", headSha: SHA, workflowRun: null }).ok).toBe(false);
  });
});

describe("the manual path cannot bypass the gate", () => {
  it("refuses a manual invocation with no CI run for the commit at all", () => {
    const verdict = decide({ eventName: "workflow_dispatch", headSha: SHA, runs: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/does not substitute for the gate/);
  });

  it("refuses when the only successful run is for a DIFFERENT commit", () => {
    const verdict = decide({
      eventName: "workflow_dispatch",
      headSha: SHA,
      runs: [run({ head_sha: OTHER })],
    });
    expect(verdict.ok).toBe(false);
  });

  it.each([
    ["failed", { conclusion: "failure" }],
    ["was cancelled", { conclusion: "cancelled" }],
    ["is still running", { status: "in_progress", conclusion: null }],
    ["was a pull_request run", { event: "pull_request" }],
    ["was a different workflow", { name: "Docs" }],
  ])("refuses when the run for this commit %s", (_label, over) => {
    const verdict = decide({
      eventName: "workflow_dispatch",
      headSha: SHA,
      runs: [run(over)],
    });
    expect(verdict.ok).toBe(false);
  });

  it("allows a manual re-run when CI really did pass on this exact commit", () => {
    // The escape hatch survives, and is now an escape hatch rather than a hole: a deliberate
    // re-publish of a commit the gate already approved.
    const verdict = decide({
      eventName: "workflow_dispatch",
      headSha: SHA,
      runs: [run({ conclusion: "failure", id: 1 }), run({ id: 2 })],
    });
    expect(verdict.ok, verdict.reason).toBe(true);
    expect(verdict.reason).toMatch(/run 2/);
  });

  it("refuses when nothing was checked out at all", () => {
    expect(decide({ eventName: "workflow_dispatch", headSha: "", runs: [run()] }).ok).toBe(false);
  });
});

describe("fetchRuns asks the right question", () => {
  it("queries the CI workflow's runs for exactly this commit", async () => {
    let asked = "";
    const runs = await fetchRuns({
      repository: "org/repo",
      headSha: SHA,
      token: "t",
      fetchImpl: (async (url: string) => {
        asked = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ workflow_runs: [run()] }),
        };
      }) as unknown as typeof fetch,
    });
    expect(asked).toContain("/repos/org/repo/actions/workflows/ci.yml/runs");
    expect(asked).toContain(`head_sha=${SHA}`);
    expect(runs).toHaveLength(1);
  });

  it("raises rather than reporting an empty list when the API refuses", async () => {
    await expect(
      fetchRuns({
        repository: "org/repo",
        headSha: SHA,
        fetchImpl: (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/403/);
  });
});

describe("the workflow actually uses the gate", () => {
  const PUBLISH = fileURLToPath(new URL("../../../.github/workflows/publish.yml", import.meta.url));
  const workflow = existsSync(PUBLISH) ? readFileSync(PUBLISH, "utf8") : null;

  it("runs the gate before anything that could publish", () => {
    expect(workflow).toBeTruthy();
    const gate = workflow!.indexOf("require-ci-success.mjs");
    const publish = workflow!.indexOf("publish-packages.mjs");
    const version = workflow!.indexOf("changeset version");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(version);
    expect(gate).toBeLessThan(publish);
  });

  it("does not let any event skip it", () => {
    // The bypass was an `||` in a job-level `if`. There must be no condition on the gate step
    // that names an event at all.
    const step = workflow!.slice(
      workflow!.lastIndexOf("- name:", workflow!.indexOf("require-ci-success.mjs")),
      workflow!.indexOf("require-ci-success.mjs"),
    );
    expect(step).not.toMatch(/if:/);
    expect(workflow).not.toMatch(/github\.event_name == 'workflow_dispatch' \|\|/);
  });
});

/**
 * The manual gate has to be allowed to ask the question it asks.
 *
 * On any path but `workflow_run` the gate calls
 * `GET /repos/{owner}/{repo}/actions/workflows/ci.yml/runs`. `GITHUB_TOKEN` is scoped by the job's
 * `permissions:` block, so with no Actions permission that request is unauthorised and works only
 * by falling through to whatever anonymous access a public repository allows. It fails CLOSED -
 * `fetchRuns` raises rather than reporting an empty list - but a manual re-publish then fails for
 * a reason that has nothing to do with the gate, and on a private repository it fails always.
 */
describe("the publish job may ask about CI runs", () => {
  const PUBLISH = fileURLToPath(new URL("../../../.github/workflows/publish.yml", import.meta.url));

  /** The effective permissions of the release job, parsed rather than pattern-matched. */
  const permissions = (): Record<string, string> => {
    const yaml = readFileSync(PUBLISH, "utf8");
    const job = yaml.slice(yaml.indexOf("  release:"));
    const block = job.slice(job.indexOf("permissions:"));
    const lines = block.split("\n").slice(1);
    const out: Record<string, string> = {};
    for (const line of lines) {
      if (/^\s*(#|$)/.test(line)) continue; // comments and blanks are part of the block
      const match = /^\s{6,}([a-z-]+):\s*([a-z-]+)/.exec(line);
      if (!match) break; // the first real line that is not a permission ends the block
      out[match[1]!] = match[2]!;
    }
    return out;
  };

  it("grants actions: read, so the manual path can query CI runs as itself", () => {
    expect(permissions().actions).toBe("read");
  });

  it("still grants exactly what publishing needs, and nothing new", () => {
    // Widening this block is how a release job quietly becomes able to do more than release.
    expect(permissions()).toEqual({
      actions: "read",
      contents: "write",
      "pull-requests": "write",
      "id-token": "write",
    });
  });

  it("and the gate is unchanged: exact SHA, push event, completed success", () => {
    // The permission is about being ABLE to ask. What counts as an answer is a separate rule.
    expect(
      decide({
        eventName: "workflow_dispatch",
        headSha: SHA,
        runs: [run({ status: "in_progress", conclusion: null })],
      }).ok,
    ).toBe(false);
    expect(decide({ eventName: "workflow_dispatch", headSha: SHA, runs: [run()] }).ok).toBe(true);
    expect(decide({ eventName: "workflow_dispatch", headSha: OTHER, runs: [run()] }).ok).toBe(
      false,
    );
    expect(
      decide({ eventName: "workflow_dispatch", headSha: SHA, runs: [run({ event: "schedule" })] })
        .ok,
    ).toBe(false);
  });
});
