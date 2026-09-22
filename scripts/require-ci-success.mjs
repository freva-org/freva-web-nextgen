/**
 * Refuse to publish anything CI has not actually passed on THIS commit.
 *
 * `publish.yml` gained a `workflow_run` trigger so it could not race CI - but it kept
 * `workflow_dispatch` as a manual escape hatch, and the guards were written as
 * `github.event_name == 'workflow_dispatch' || (…the real checks…)`. A human clicking "Run
 * workflow" therefore skipped every one of them: no CI conclusion was consulted, no SHA was
 * compared, and the manual path's own testing was `npm test` plus two tarball checks - no runtime
 * assembly, no strict browser acceptance, no cross-engine console suite. The one path a person
 * reaches for when something is already going wrong was the one with no gate on it.
 *
 * The decision is here, as a function, rather than in a workflow expression, because a workflow
 * expression cannot be tested and this can: `decide()` is pure, and `tests/publish-gate.test.ts`
 * drives it through every reachable event path.
 *
 * WHAT COUNTS AS A GATE THAT PASSED: a run of the CI workflow, for the exact commit about to be
 * published, triggered by a push, with conclusion `success`. Not "a recent green run", not "the
 * run that triggered this one, whatever it was for".
 */

/** The workflow whose success is required. Its `name:`, as the API reports it. */
export const REQUIRED_WORKFLOW = "CI";

/**
 * Decide whether publishing may proceed.
 *
 * @param {object} input
 * @param {string} input.eventName            `workflow_run` or `workflow_dispatch`.
 * @param {string} input.headSha              The commit checked out, i.e. what would be published.
 * @param {object|null} [input.workflowRun]   `github.event.workflow_run`, when there is one.
 * @param {Array<object>} input.runs          CI runs the API reports for `headSha`.
 * @returns {{ok: true, reason: string} | {ok: false, reason: string}}
 */
export function decide({ eventName, headSha, workflowRun = null, runs = [] }) {
  if (!headSha) {
    return { ok: false, reason: "no commit to verify: nothing was checked out." };
  }

  /*
   * On the `workflow_run` path the triggering run is itself evidence, but only if it is evidence
   * about THIS commit. `main` can move between CI finishing and this workflow starting, and
   * publishing then would publish a commit nothing looked at.
   */
  if (eventName === "workflow_run") {
    if (!workflowRun) {
      return { ok: false, reason: "a workflow_run event with no run attached." };
    }
    if (workflowRun.conclusion !== "success") {
      return {
        ok: false,
        reason: `the CI run that triggered this concluded ${String(workflowRun.conclusion)}, not success.`,
      };
    }
    if (workflowRun.event !== "push") {
      return {
        ok: false,
        reason: `the CI run that triggered this was a ${String(workflowRun.event)} run, not a push run.`,
      };
    }
    if (workflowRun.head_sha !== headSha) {
      return {
        ok: false,
        reason:
          `main is now ${headSha}, but the CI run that passed verified ${String(workflowRun.head_sha)}. ` +
          `Not publishing a commit no gate has looked at.`,
      };
    }
    return { ok: true, reason: `CI run ${String(workflowRun.id)} verified ${headSha}.` };
  }

  /*
   * EVERY OTHER PATH - `workflow_dispatch` above all - has to find the evidence rather than be
   * handed it. Same standard: the CI workflow, this commit, a push run, concluded success.
   */
  const matching = runs.filter(
    (run) =>
      run &&
      run.head_sha === headSha &&
      run.event === "push" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      (run.name === undefined || run.name === REQUIRED_WORKFLOW),
  );
  if (matching.length === 0) {
    return {
      ok: false,
      reason:
        `no successful ${REQUIRED_WORKFLOW} push run exists for ${headSha}. A manual publish does ` +
        `not substitute for the gate: run CI on this commit, or push it, and let the run that ` +
        `succeeds trigger the release.`,
    };
  }
  return {
    ok: true,
    reason: `${REQUIRED_WORKFLOW} run ${String(matching[0].id)} verified ${headSha}.`,
  };
}

/** Ask GitHub which CI runs exist for a commit. Injectable so the CLI can be exercised offline. */
export async function fetchRuns({ repository, headSha, token, fetchImpl = fetch }) {
  const url =
    `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs` +
    `?head_sha=${encodeURIComponent(headSha)}&per_page=50`;
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for the CI runs of ${headSha}.`);
  }
  const body = await response.json();
  return Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
}

/* the CLI */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const headSha = process.env.VERIFY_SHA ?? "";
  const workflowRun = process.env.WORKFLOW_RUN_JSON
    ? JSON.parse(process.env.WORKFLOW_RUN_JSON)
    : null;
  let runs = [];
  if (eventName !== "workflow_run") {
    runs = await fetchRuns({
      repository: process.env.GITHUB_REPOSITORY ?? "",
      headSha,
      token: process.env.GITHUB_TOKEN,
    });
  }
  const verdict = decide({ eventName, headSha, workflowRun, runs });
  console.log(
    verdict.ok ? `publishing: ${verdict.reason}` : `refusing to publish: ${verdict.reason}`,
  );
  process.exit(verdict.ok ? 0 : 1);
}
