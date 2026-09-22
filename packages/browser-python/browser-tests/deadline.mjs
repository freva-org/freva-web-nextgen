/**
 * Real deadlines for browser-suite phases, enforced in NODE.
 *
 * A Playwright `page.evaluate()` waits for its promise with no timeout of its own - and ignores a
 * third argument, so `evaluate(fn, arg, { timeout })` is not a deadline at all. Two tools, both
 * test-only and printed on the test's own stdout, never in the Python transcript:
 *
 *  - `withDeadline(promise, ms, what)` bounds one operation. The losing promise keeps a rejection
 *    handler, so it cannot surface later as an unhandled rejection.
 *  - `createPhases(label, { onDeadline })` runs NAMED work: `await phases.run(name, ms, work)`.
 *    The returned promise REJECTS at the deadline whatever happens next - it races the work rather
 *    than hoping a side effect unwinds it. Only then is `onDeadline` called to terminate what the
 *    phase abandoned (close the browser context, dispose the engine); that cleanup is itself
 *    bounded, runs detached from the phase, and is reported separately. A cleanup that never
 *    settles cannot keep the phase - or the suite - waiting.
 */

export class DeadlineExceeded extends Error {
  constructor(what, ms) {
    super(`${what} did not finish within ${ms} ms`);
    this.name = "DeadlineExceeded";
    this.what = what;
    this.ms = ms;
  }
}

/** A phase that ran out of time. Distinct from its work's own failure. */
export class PhaseDeadline extends DeadlineExceeded {
  constructor(label, name, ms) {
    super(`[${label}] phase "${name}"`, ms);
    this.name = "PhaseDeadline";
    this.phase = name;
  }
}

/** Settle with `promise`, or reject with `DeadlineExceeded` after `ms`. */
export function withDeadline(promise, ms, what) {
  const work = Promise.resolve(promise);
  work.catch(() => undefined); // the loser of the race must not become an unhandled rejection
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(what, ms)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** How long the termination after a deadline may take before it is reported as failed. */
export const CLEANUP_MS = 15_000;

/**
 * Named, supervised phases. `run(name, ms, work)` logs the start, then settles with the work's
 * outcome - or rejects with `PhaseDeadline` at `ms`, recording `expired` FIRST and then starting the
 * bounded termination. `cleanups()` settles once every termination started so far has finished or
 * timed out; `cleanupFailures` lists those that did not finish cleanly.
 */
export function createPhases(
  label,
  { onDeadline, log = console.log, now = Date.now, cleanupMs = CLEANUP_MS } = {},
) {
  let current = null;
  let expired = null;
  const history = [];
  const pendingCleanups = [];
  const cleanupFailures = [];

  const record = (name, outcome, started) => {
    const elapsedMs = now() - started;
    history.push({ name, outcome, elapsedMs });
    log(`[${label}] phase: ${name} - ${outcome} in ${elapsedMs} ms`);
  };

  const terminate = (phase) => {
    const cleanup = withDeadline(
      Promise.resolve().then(() => onDeadline?.(phase)),
      cleanupMs,
      `terminating after "${phase.name}"`,
    ).then(
      () => log(`[${label}] cleanup after ${phase.name} - finished`),
      (error) => {
        const message = String(error?.message ?? error).split("\n")[0];
        cleanupFailures.push({ phase: phase.name, message });
        log(`[${label}] cleanup after ${phase.name} - FAILED: ${message}`);
      },
    );
    pendingCleanups.push(cleanup);
  };

  return {
    async run(name, ms, work) {
      const started = now();
      current = name;
      log(
        `[${label}] phase: ${name} - started (deadline ${ms} ms)` +
          (expired ? `, after ${expired.name} ran out of time` : ""),
      );
      const body = Promise.resolve().then(work);
      body.catch(() => undefined); // abandoned at a deadline, it may still reject later
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const phase = { name, ms };
          expired = phase;
          log(`[${label}] phase: ${name} - DEADLINE EXCEEDED after ${ms} ms; terminating it`);
          reject(new PhaseDeadline(label, name, ms));
          terminate(phase);
        }, ms);
        timer.unref?.();
      });
      try {
        const value = await Promise.race([body, deadline]);
        record(name, "finished", started);
        return value;
      } catch (error) {
        record(name, error instanceof PhaseDeadline ? "timed out" : "failed", started);
        throw error;
      } finally {
        clearTimeout(timer);
        if (current === name) current = null;
      }
    },
    /** Every termination started so far, settled - each is already bounded by `cleanupMs`. */
    cleanups() {
      return Promise.all(pendingCleanups).then(() => undefined);
    },
    get cleanupFailures() {
      return [...cleanupFailures];
    },
    get current() {
      return current;
    },
    get expired() {
      return expired;
    },
    get history() {
      return [...history];
    },
  };
}

/** The failed check for an error a phase body threw: named by the phase when it ran out of time. */
export function phaseFailureCheck(error) {
  const message = String(error?.message ?? error)
    .split("\n")[0]
    .slice(0, 200);
  if (error instanceof PhaseDeadline) {
    return {
      name: `phase "${error.phase}" finished within ${error.ms / 1000} s`,
      pass: false,
      detail: `rejected at its deadline; the work it abandoned was terminated separately`,
    };
  }
  return { name: "the suite ran to the end", pass: false, detail: message };
}

/**
 * Wait for every termination a deadline started - each already bounded - and turn the ones that
 * did not finish cleanly into their own failed checks. Never waits longer than the longest cleanup.
 */
export async function cleanupChecks(phases) {
  await phases.cleanups();
  return phases.cleanupFailures.map((failure) => ({
    name: `cleanup after "${failure.phase}" finished`,
    pass: false,
    detail: failure.message,
  }));
}
