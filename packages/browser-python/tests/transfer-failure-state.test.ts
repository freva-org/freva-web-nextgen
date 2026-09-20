/**
 * Whether a transfer failed is a boolean. WHY it failed is data, and `null` is data.
 *
 * Keeping both in one nullable variable and asking `if (failure)` makes `null` and `undefined`
 * indistinguishable from "nothing has gone wrong yet", so a destination that rejects with either is
 * not recorded as a failure and the NEXT thing to go wrong overwrites it. The reported shape:
 * `sink.write()` throws `null`, the interpreter restarts while `abort()` is pending, and the caller
 * is told `BrowserPythonError: The interpreter was restarted` - pointing a host debugging its own
 * sink at the engine.
 *
 * `throw null` is not strange: `Promise.reject()` with no argument rejects with `undefined`, and a
 * wrapper that normalises its errors to `null` produces exactly this.
 */
import { describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { healthyWorker } from "../tests/fake-worker.js";

const CHUNK = 64 * 1024;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every value that is falsy, and therefore invisible to `if (failure)`, plus a control. */
const FALSY: Array<[string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["0", 0],
  ["false", false],
  ['""', ""],
  ["NaN", Number.NaN],
  ["0n", 0n],
  ["an Error (the control)", new Error("the disk went away")],
];

const isSame = (actual: unknown, expected: unknown): boolean =>
  Object.is(actual, expected) || (Number.isNaN(expected as number) && Number.isNaN(actual));

describe("a falsy rejection from the destination is still a failure", () => {
  for (const [label, thrown] of FALSY) {
    it(`a write that throws ${label} fails the transfer with that value`, async () => {
      const python = createBrowserPython({
        workerFactory: () => healthyWorker() as unknown as Worker,
      });
      await python.start();

      const calls: string[] = [];
      const sink = {
        async write() {
          calls.push("write");
          throw thrown;
        },
        async close() {
          calls.push("close");
        },
        async abort() {
          calls.push("abort");
        },
        release() {
          calls.push("release");
        },
      };

      let caught: unknown;
      let threw = false;
      try {
        await python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK });
      } catch (error) {
        threw = true;
        caught = error;
      }

      expect(threw, `${label} must fail the transfer`).toBe(true);
      expect(isSame(caught, thrown), `rejected with ${label} itself`).toBe(true);
      // Aborted, never closed: a destination closed after a failure is a truncated file wearing the
      // name of a complete one.
      expect(calls).toEqual(["write", "abort", "release"]);
    });

    it(`a restart during cleanup does not overwrite a ${label} failure`, async () => {
      // THE REPORTED CASE. The write fails, `abort()` hangs, and while the engine is waiting on it
      // the interpreter restarts - calling `fail()` again with a `restarted` error. First failure
      // wins, so the caller still learns what their destination did.
      const first = healthyWorker();
      const second = healthyWorker();
      let made = 0;
      const python = createBrowserPython({
        workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
      });
      await python.start();

      let releaseAbort: () => void = () => undefined;
      const sink = {
        async write() {
          throw thrown;
        },
        async close() {},
        abort: () =>
          new Promise<void>((resolve) => {
            releaseAbort = resolve;
          }),
        release() {},
      };

      const transfer = python.streamArtifact("big.bin", sink, {
        chunkBytes: CHUNK,
        cleanupTimeoutMs: 5_000,
      });
      transfer.catch(() => undefined);
      // Let the write fail and the abort start.
      await tick();
      await tick();

      await python.restart();
      releaseAbort();

      let caught: unknown;
      try {
        await transfer;
      } catch (error) {
        caught = error;
      }
      expect(
        isSame(caught, thrown),
        `the caller must still see ${label}, not the restart that came after it`,
      ).toBe(true);
      expect(caught, "a restart error would name the interpreter, not the sink").not.toMatchObject({
        code: "restarted",
      });
    });
  }

  it("still reports a restart when THAT is what went wrong first", async () => {
    // The control for the control. Making falsy reasons survive must not make the engine deaf to
    // its own failures: a restart during a write that never returns is still a `restarted` error,
    // because nothing failed before it.
    const first = healthyWorker();
    const second = healthyWorker();
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    await python.start();

    const never = new Promise<void>(() => {});
    const transfer = python.streamArtifact(
      "big.bin",
      { write: () => never, async close() {}, async abort() {} },
      { chunkBytes: CHUNK },
    );
    transfer.catch(() => undefined);
    await tick();
    await python.restart();

    await expect(transfer).rejects.toMatchObject({ code: "restarted" });
  });
});
