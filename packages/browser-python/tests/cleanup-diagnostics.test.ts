/**
 * A cleanup fault is never the outcome of a transfer, and never silence either.
 *
 * A download owns the destination it was handed, so on every path it closes or aborts it, releases
 * the writer, closes its lease and returns its memory. Any of those can fail - a `release()` that
 * throws has been seen in the wild - and none can change what already happened to the bytes, so
 * they are collected on `cleanupErrors`. Two holes, both about the TYPE: `ArtifactStreamResult`
 * has to be an exported name carrying `cleanupErrors`, or reading it is `TS2339`; and the failure
 * path has to attach them for a plain `Error` too, since a sink throwing `TypeError: stream is
 * closed` is exactly where a following `release()` fault matters.
 */
import { describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { BrowserPythonError, type ArtifactStreamResult } from "../src/types.js";
import { healthyWorker, type FakeWorker } from "./fake-worker.js";

const engineWith = (worker: FakeWorker) =>
  createBrowserPython({ workerFactory: () => worker as unknown as Worker });

/** A destination that works, and whose `release()` fails on the way out. */
const brokenRelease = (fault: unknown) => ({
  async write() {},
  async close() {},
  async abort() {},
  release() {
    throw fault;
  },
});

describe("cleanup faults survive every outcome", () => {
  it("names the successful result, with `cleanupErrors` on it", async () => {
    const python = engineWith(healthyWorker());
    await python.start();

    const fault = new Error("the writer would not let go");
    // TYPED, deliberately: this annotation is the regression. `ArtifactStreamResult` has to be an
    // exported name, and `cleanupErrors` has to be part of it, or this file does not compile.
    const result: ArtifactStreamResult = await python.streamArtifact(
      "big.bin",
      brokenRelease(fault),
    );

    expect(result.bytesWritten).toBe(192 * 1024);
    expect(result.name).toBe("big.bin");
    expect(result.cleanupErrors).toEqual([fault]);
  });

  it("carries them on a BrowserPythonError", async () => {
    const python = engineWith(healthyWorker());
    await python.start();

    const fault = new Error("release failed too");
    const sink = { ...brokenRelease(fault) };
    await expect(python.streamArtifact("does-not-exist.bin", sink)).rejects.toBeInstanceOf(
      BrowserPythonError,
    );

    let caught: unknown;
    try {
      await python.streamArtifact("does-not-exist.bin", { ...brokenRelease(fault) });
    } catch (error) {
      caught = error;
    }
    expect((caught as BrowserPythonError).cleanupErrors).toEqual([fault]);
  });

  it("carries them on an ORDINARY Error, which is where they were being lost", async () => {
    // The reported case. A destination that throws a plain `Error` from `write()` fails the
    // transfer with that error - not a `BrowserPythonError` - so an `instanceof BrowserPythonError`
    // guard drops a `release()` fault that follows, leaving the stuck writer with no explanation.
    const python = engineWith(healthyWorker());
    await python.start();

    const writeFault = new TypeError("the underlying sink is closed");
    const releaseFault = new Error("and the writer would not let go either");
    const sink = {
      async write() {
        throw writeFault;
      },
      async close() {},
      async abort() {},
      release() {
        throw releaseFault;
      },
    };

    let caught: unknown;
    try {
      await python.streamArtifact("big.bin", sink, { chunkBytes: 64 * 1024 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(writeFault);
    expect((caught as Error & { cleanupErrors?: unknown[] }).cleanupErrors).toEqual([releaseFault]);
  });

  it("does not invent the field when cleanup was clean", async () => {
    const python = engineWith(healthyWorker());
    await python.start();
    const result = await python.streamArtifact("big.bin", {
      async write() {},
      async close() {},
      async abort() {},
    });
    expect(result.cleanupErrors).toBeUndefined();
  });
});

/**
 * The remaining asynchronous edges of a transfer's cleanup - three of them, all the same shape:
 * something the CALLER controls runs at a moment the engine had assumed was its own.
 * `toSink(destination)` calls `destination.getWriter()`, so the session has to be captured first
 * or a getter that calls `restart()` moves the engine to a Worker the transfer then adopts;
 * `abort()` failing during cleanup is a cleanup fault exactly as `release()` failing is; and with
 * a failed write, abort and release, the primary error has to survive all three.
 */
describe("cleanup at the edges", () => {
  it("captures the session BEFORE the caller's getWriter() can move it", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();

    let restarted: Promise<unknown> | null = null;
    // A REENTRANT destination. `getWriter()` is the caller's code and may do anything at all;
    // this one restarts the engine, the worst legal thing it can do to a transfer that has not
    // captured its session yet.
    const reentrant = {
      getWriter() {
        restarted = python.restart();
        return {
          ready: Promise.resolve(),
          async write() {},
          async close() {},
          async abort() {},
          releaseLock() {},
        };
      },
    } as unknown as WritableStream<Uint8Array>;

    await expect(python.streamArtifact("big.bin", reentrant)).rejects.toMatchObject({
      code: "restarted",
    });
    await restarted;
    // Bound to the ORIGINAL session, so the replacement Worker was never addressed at all.
    const replacement = (worker as unknown as { replacement?: FakeWorker }).replacement;
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);
    expect(
      (replacement as unknown as { received?: unknown[] })?.received?.length ?? 0,
    ).toBeLessThanOrEqual(1);
  });

  it("records an abort() that fails, not only a release() that does", async () => {
    const python = engineWith(healthyWorker());
    await python.start();

    const abortFault = new Error("the stream would not abort");
    const sink = {
      async write() {},
      async close() {},
      async abort() {
        throw abortFault;
      },
    };

    let caught: unknown;
    try {
      // A lease that fails: the destination is adopted, then aborted, and the abort throws.
      await python.streamArtifact("does-not-exist.bin", sink);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrowserPythonError);
    expect((caught as BrowserPythonError).code).not.toBe("protocol");
    // `toContain` alone is not enough: it does not fail on `undefined` in this runner, so the
    // array has to be asserted into existence before anything is asserted about its contents.
    const faults = (caught as BrowserPythonError).cleanupErrors;
    expect(Array.isArray(faults)).toBe(true);
    expect(faults).toContain(abortFault);
  });

  it("keeps the write failure primary while recording BOTH abort and release faults", async () => {
    const python = engineWith(healthyWorker());
    await python.start();

    const writeFault = new TypeError("the disk went away mid-write");
    const abortFault = new Error("and the abort failed");
    const releaseFault = new Error("and so did the release");
    const sink = {
      async write() {
        throw writeFault;
      },
      async close() {},
      async abort() {
        throw abortFault;
      },
      release() {
        throw releaseFault;
      },
    };

    let caught: unknown;
    try {
      await python.streamArtifact("big.bin", sink, { chunkBytes: 64 * 1024 });
    } catch (error) {
      caught = error;
    }
    // The transfer's own error, unreplaced by anything that happened while tidying up after it.
    expect(caught).toBe(writeFault);
    const faults = (caught as Error & { cleanupErrors?: unknown[] }).cleanupErrors;
    expect(Array.isArray(faults)).toBe(true);
    expect(faults).toContain(abortFault);
    expect(faults).toContain(releaseFault);
  });

  it("says nothing about lease closes, because their acknowledgement is discarded", async () => {
    // `#closeLease` posts the message and drops the reply, because the alternative is holding
    // the caller's promise open on a Worker that may already be gone - so a lease that cannot be
    // closed can never appear in `cleanupErrors`. This pins what IS true: a Worker that never
    // acknowledges the close neither delays the transfer nor invents a cleanup fault.
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();

    // Silence for the close, and only for it: `autoRespond` returning null sends no reply at all.
    const answer = worker.autoRespond!;
    let swallowed = 0;
    worker.autoRespond = (request) => {
      if (request.kind === "artifact-close") {
        swallowed += 1;
        return null;
      }
      return answer(request);
    };

    const result = await python.streamArtifact("big.bin", {
      async write() {},
      async close() {},
      async abort() {},
    });
    expect(result.bytesWritten).toBe(192 * 1024);
    expect(result.cleanupErrors).toBeUndefined();
    expect(swallowed).toBe(1);
  });

  it("leaks nothing when every cleanup step fails", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();

    const hostile = {
      async write() {
        throw new Error("no");
      },
      async close() {
        throw new Error("no");
      },
      async abort() {
        throw new Error("no");
      },
      release() {
        throw new Error("no");
      },
    };
    for (let i = 0; i < 4; i += 1) {
      await python.streamArtifact("big.bin", hostile, { chunkBytes: 64 * 1024 }).catch(() => {});
    }
    // No frozen artifacts, and the budget is proved free by USING it for a full-size transfer.
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);
    const ok = await python.streamArtifact("big.bin", {
      async write() {},
      async close() {},
      async abort() {},
    });
    expect(ok.bytesWritten).toBe(192 * 1024);
  });
});
