/**
 * The browser suites' phase deadlines are real, Node-side, and do not depend on cleanup.
 *
 * `page.evaluate()` has no timeout and ignores a third argument. The first replacement armed a
 * timer that CLOSED the browser context and hoped that would unwind the pending evaluate(); in
 * Firefox it did not, and the suite sat at "DEADLINE EXCEEDED" until the 15-minute watchdog. Now
 * `phases.run(name, ms, work)` RACES the work and rejects at the deadline by itself; termination is
 * started afterwards, bounded, and reported on its own. These tests hold exactly that - including
 * a cleanup that never settles.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DeadlineExceeded,
  PhaseDeadline,
  cleanupChecks,
  createPhases,
  phaseFailureCheck,
  withDeadline,
} from "../browser-tests/deadline.mjs";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => undefined);
const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));
afterEach(() => {
  unhandled.length = 0;
});

describe("withDeadline", () => {
  it("passes a value through when the work finishes in time", async () => {
    await expect(
      withDeadline(
        sleep(5).then(() => 42),
        500,
        "quick",
      ),
    ).resolves.toBe(42);
  });

  it("rejects with a NAMED deadline when it does not", async () => {
    await expect(withDeadline(never(), 20, "the startup")).rejects.toMatchObject({
      name: "DeadlineExceeded",
      what: "the startup",
      ms: 20,
    });
  });

  it("keeps the work's own failure when that comes first", async () => {
    await expect(withDeadline(Promise.reject(new Error("boom")), 500, "x")).rejects.toThrow("boom");
  });

  it("leaves no unhandled rejection when the losing work fails later", async () => {
    const late = sleep(40).then(() => {
      throw new Error("the abandoned evaluate() finally rejected");
    });
    await expect(withDeadline(late, 10, "abandoned")).rejects.toBeInstanceOf(DeadlineExceeded);
    await sleep(80);
    expect(unhandled).toEqual([]);
  });
});

describe("phases.run", () => {
  it("returns the work's value and logs start and finish with the elapsed time", async () => {
    const lines: string[] = [];
    let clock = 1000;
    const phases = createPhases("suite", { log: (l) => lines.push(l), now: () => clock });
    const value = await phases.run("probe", 1000, async () => {
      clock += 25;
      return "ok";
    });
    expect(value).toBe("ok");
    expect(lines).toEqual([
      "[suite] phase: probe - started (deadline 1000 ms)",
      "[suite] phase: probe - finished in 25 ms",
    ]);
    expect(phases.expired).toBeNull();
    expect(phases.current).toBeNull();
  });

  it("rejects the PHASE at its deadline even when the work never settles", async () => {
    const phases = createPhases("suite", { log: () => undefined, onDeadline: () => undefined });
    const started = Date.now();
    await expect(phases.run("bounded bridge operations", 30, never)).rejects.toBeInstanceOf(
      PhaseDeadline,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(phases.expired).toEqual({ name: "bounded bridge operations", ms: 30 });
  });

  it("…and even when its CLEANUP never settles: cleanup is bounded and reported separately", async () => {
    const lines: string[] = [];
    let cleanupStarted = 0;
    const phases = createPhases("suite", {
      log: (l) => lines.push(l),
      cleanupMs: 40,
      onDeadline: () => {
        cleanupStarted += 1;
        return never(); // a context.close() that never returns
      },
    });
    const started = Date.now();
    await expect(phases.run("wedged", 20, never)).rejects.toMatchObject({
      name: "PhaseDeadline",
      phase: "wedged",
    });
    // The phase rejected at ITS deadline - it did not wait for the cleanup.
    expect(Date.now() - started).toBeLessThan(35);
    expect(cleanupStarted).toBe(1);
    const failures = await cleanupChecks(phases); // bounded by cleanupMs
    expect(Date.now() - started).toBeLessThan(1000);
    expect(failures).toEqual([
      {
        name: 'cleanup after "wedged" finished',
        pass: false,
        detail: expect.stringMatching(/did not finish within 40 ms/),
      },
    ]);
    expect(lines.some((l) => /wedged - DEADLINE EXCEEDED after 20 ms/.test(l))).toBe(true);
    expect(lines.some((l) => /cleanup after wedged - FAILED/.test(l))).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it("records the phase as expired BEFORE cleanup runs, so the failure is attributable", async () => {
    const seen: Array<string | null> = [];
    const phases = createPhases("suite", {
      log: () => undefined,
      onDeadline: (expired) => {
        seen.push(expired.name);
        seen.push(phases.expired?.name ?? null);
      },
    });
    await phases.run("large transfer", 10, never).catch(() => undefined);
    await phases.cleanups();
    expect(seen).toEqual(["large transfer", "large transfer"]);
  });

  it("does not fire for a phase that finished in time", async () => {
    let terminated = 0;
    const phases = createPhases("suite", { log: () => undefined, onDeadline: () => terminated++ });
    await phases.run("quick", 30, async () => "done");
    await sleep(60);
    expect(terminated).toBe(0);
    expect(await cleanupChecks(phases)).toEqual([]);
  });

  it("passes the work's own failure through as a failure, not a deadline", async () => {
    const lines: string[] = [];
    const phases = createPhases("suite", { log: (l) => lines.push(l) });
    const error = await phases
      .run("startup", 1000, async () => {
        throw new Error("the worker failed to load");
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PhaseDeadline);
    expect(lines.at(-1)).toMatch(/startup - failed in \d+ ms/);
    expect(phaseFailureCheck(error)).toMatchObject({
      name: "the suite ran to the end",
      pass: false,
    });
  });

  it("names the phase in the failed check a deadline produces", async () => {
    const phases = createPhases("suite", { log: () => undefined });
    const error = await phases.run("bridge operation: clear history", 10, never).catch((e) => e);
    expect(phaseFailureCheck(error)).toEqual({
      name: 'phase "bridge operation: clear history" finished within 0.01 s',
      pass: false,
      detail: expect.stringMatching(/terminated separately/),
    });
  });

  it("still allows a later phase after one ran out of time, and says so", async () => {
    const lines: string[] = [];
    const phases = createPhases("suite", { log: (l) => lines.push(l) });
    await phases.run("stuck", 10, never).catch(() => undefined);
    await expect(phases.run("cleanup", 1000, async () => 1)).resolves.toBe(1);
    expect(lines.some((l) => /cleanup - started .*after stuck ran out of time/.test(l))).toBe(true);
  });
});
