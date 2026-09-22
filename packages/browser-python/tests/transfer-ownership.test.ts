/**
 * A transfer belongs to the interpreter it was ASKED for, from the first line of the call.
 *
 * Every message a transfer sends is bound to a captured session, but WHERE the capture happens
 * matters too: `streamArtifact()` reads `this.#session` after `await this.#requireReady()`, so a
 * restart during that await makes the transfer adopt whichever interpreter exists by then -
 * succeeding against a Worker the caller never addressed, reading a file from another workspace.
 *
 * The same lateness runs through the rest of this file: cancellation installed after readiness
 * makes an abort during startup wait for the startup timeout; a lease whose cleanup is attached
 * only once the lease has been awaited is never closed when it arrives after a cancellation; and
 * `sink.release()` outside the guarded unwind lets a throwing release take the lease close and
 * the memory reservation with it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { FakeWorker, healthyWorker } from "./fake-worker.js";
import type { WorkerRequest } from "../src/protocol.js";

const CHUNK = 64 * 1024;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const READY = (id: string) => ({
  kind: "ready" as const,
  id,
  info: {
    profile: "minimal" as const,
    pythonVersion: "3.14.2",
    pyodideVersion: "314.0.6",
    packages: {},
    startupMs: 1,
    workspace: { available: true, path: "/workspace", maxFiles: 64, sessionId: "s" },
    addons: [],
    unavailableAddons: [],
    credentialsPersisted: false,
    jspi: false,
  },
});

/** A sink that records what happened to it and can be made to hang or throw anywhere. */
function recordingSink(
  behaviour: { hangWrite?: boolean; throwRelease?: boolean; hangClose?: boolean } = {},
) {
  const events: string[] = [];
  const never = new Promise<void>(() => {});
  return {
    events,
    bytes: 0,
    sink: {
      async write(chunk: Uint8Array) {
        events.push(`write:${chunk.byteLength}`);
        if (behaviour.hangWrite) await never;
      },
      async close() {
        events.push("close");
        if (behaviour.hangClose) await never;
      },
      async abort() {
        events.push("abort");
      },
      release() {
        events.push("release");
        if (behaviour.throwRelease) throw new Error("the destination's release blew up");
      },
    },
  };
}

let unhandled: unknown[] = [];
const record = (reason: unknown) => void unhandled.push(reason);
beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", record);
});
afterEach(() => process.off("unhandledRejection", record));

const leaseCount = (worker: FakeWorker) => (worker as unknown as { openLeases: number }).openLeases;
const artifactRequests = (worker: FakeWorker) =>
  worker.sent.filter((m) => m.kind.startsWith("artifact-"));

describe("1.1 the transfer never moves to a replacement interpreter", () => {
  it("rejects when a restart lands in the readiness await, and asks the new Worker nothing", async () => {
    const first = healthyWorker();
    const second = healthyWorker();
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    await python.start();

    const { sink, events } = recordingSink();
    const transfer = python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK });
    // No `await tick()`: the restart lands inside `streamArtifact`'s own first await, which is
    // exactly the window in which the session is read.
    const restarted = python.restart();

    await expect(transfer).rejects.toMatchObject({ code: "restarted" });
    await restarted;

    expect(artifactRequests(second)).toEqual([]);
    expect(events.filter((e) => e.startsWith("write"))).toEqual([]);
    expect(leaseCount(first)).toBe(0);
    expect(leaseCount(second)).toBe(0);

    // …and the replacement is perfectly usable afterwards.
    const ok = await python.streamArtifact("big.bin", {
      async write() {},
      async close() {},
      async abort() {},
    });
    expect(ok.bytesWritten).toBe(192 * 1024);
  });

  it("refuses outright when the engine has never been started", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    const { sink, events } = recordingSink();
    // Unlike a queued `push()` - which legitimately means "run this on whatever interpreter comes
    // up" - a download names a file in a workspace that does not exist yet, so adopting a session
    // that has not been created would be guessing.
    await expect(python.streamArtifact("big.bin", sink)).rejects.toMatchObject({
      code: "not-started",
    });
    expect(events).toEqual(["abort", "release"]);
    expect(worker.sent).toEqual([]);
  });

  it("binds a transfer started DURING startup to that startup attempt, and no other", async () => {
    const first = new FakeWorker();
    const second = healthyWorker();
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    first.autoRespond = (request: WorkerRequest) =>
      request.kind === "init" ? READY(request.id) : null;
    const starting = python.start();
    // Submitted before `ready` has arrived: the session exists (it is created with the Worker), so
    // this belongs to THIS attempt.
    const { sink } = recordingSink();
    const transfer = python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK });
    await starting;
    await python.restart();

    await expect(transfer).rejects.toMatchObject({ code: "restarted" });
    expect(artifactRequests(second)).toEqual([]);
  });
});

describe("1.2 cancellation does not wait for a startup that may never finish", () => {
  it("settles at once when the Worker never answers init", async () => {
    const worker = new FakeWorker(); // answers nothing at all
    const python = createBrowserPython({
      workerFactory: () => worker as unknown as Worker,
      startTimeoutMs: 180_000,
    });
    void python.start().catch(() => undefined);

    const controller = new AbortController();
    const { sink, events } = recordingSink();
    const transfer = python.streamArtifact("big.bin", sink, {
      chunkBytes: CHUNK,
      signal: controller.signal,
    });
    controller.abort();

    const started = Date.now();
    await expect(transfer).rejects.toMatchObject({ name: "ArtifactTransferAborted" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(events).toEqual(["abort", "release"]);
    expect(artifactRequests(worker)).toEqual([]);
    python.dispose();
  });

  it("honours a signal that was already aborted before the call", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    const controller = new AbortController();
    controller.abort();
    const { sink, events } = recordingSink();

    await expect(
      python.streamArtifact("big.bin", sink, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "ArtifactTransferAborted" });
    expect(events).toEqual(["abort", "release"]);
    expect(artifactRequests(worker)).toEqual([]);
  });
});

describe("1.3 a lease that arrives after the cancellation is still closed", () => {
  it("closes it in its own session, exactly once, with no unhandled rejection", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();

    // Hold the lease reply until after the cancellation.
    const inner = worker.autoRespond!;
    let releaseLease: (() => void) | undefined;
    worker.autoRespond = (request: WorkerRequest) => {
      if (request.kind !== "artifact-open") return inner(request);
      const reply = inner(request);
      releaseLease = () => reply && worker.emit(reply);
      return null;
    };

    const controller = new AbortController();
    const { sink } = recordingSink();
    const transfer = python.streamArtifact("big.bin", sink, {
      chunkBytes: CHUNK,
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    await expect(transfer).rejects.toMatchObject({ name: "ArtifactTransferAborted" });

    // The Worker answers the open AFTER the caller has been told the transfer failed.
    releaseLease?.();
    await tick();
    await tick();

    expect(leaseCount(worker)).toBe(0);
    expect(worker.sent.filter((m) => m.kind === "artifact-close")).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });
});

// A GRANTED LEASE HAS EXACTLY ONE OWNER, whenever it arrives. Closing a lease only once a
// `cleanedUp` boolean is set - at the END of the unwind - leaves a reply arriving while the
// destination's `abort()` is still being awaited belonging to nobody: the unwind is already past
// its lease step and the flag is not yet set, and the artifact stays frozen for the life of the
// Worker. Ownership is explicit, so every arrival time has exactly one owner and one close.
describe("2 a granted lease has exactly one owner, whenever it arrives", () => {
  /** Answer `artifact-open` only when the test says so. */
  function heldLease(worker: FakeWorker) {
    const inner = worker.autoRespond!;
    let deliver: (() => void) | undefined;
    worker.autoRespond = (request: WorkerRequest) => {
      if (request.kind !== "artifact-open") return inner(request);
      const reply = inner(request);
      deliver = () => reply && worker.emit(reply);
      return null;
    };
    return () => deliver?.();
  }

  const closes = (worker: FakeWorker) =>
    worker.sent.filter((m) => m.kind === "artifact-close").length;

  it("closes a reply that arrives DURING an asynchronous abort", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    const deliver = heldLease(worker);

    let releaseAbort!: () => void;
    const aborting = new Promise<void>((resolve) => (releaseAbort = resolve));
    const events: string[] = [];
    const sink = {
      async write() {},
      async close() {
        events.push("close");
      },
      async abort() {
        events.push("abort");
        // The reply lands here: cleanup has begun and has not finished.
        deliver();
        await aborting;
      },
    };

    const controller = new AbortController();
    const transfer = python.streamArtifact("big.bin", sink, {
      chunkBytes: CHUNK,
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    await tick();
    releaseAbort();

    await expect(transfer).rejects.toMatchObject({ name: "ArtifactTransferAborted" });
    await tick();
    await tick();
    expect(events).toEqual(["abort"]);
    expect(leaseCount(worker)).toBe(0);
    expect(closes(worker)).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it("closes a reply that arrives after cleanup has finished, exactly once", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    const deliver = heldLease(worker);

    const controller = new AbortController();
    const transfer = python.streamArtifact("big.bin", recordingSink().sink, {
      chunkBytes: CHUNK,
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    await expect(transfer).rejects.toMatchObject({ name: "ArtifactTransferAborted" });
    await tick();

    deliver();
    await tick();
    await tick();
    expect(leaseCount(worker)).toBe(0);
    expect(closes(worker)).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it("closes it once when it arrives BEFORE the cancellation, too", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    // The lease is answered normally; the cancel arrives during the first chunk request.
    const inner = worker.autoRespond!;
    worker.autoRespond = (request: WorkerRequest) =>
      request.kind === "artifact-chunk" ? null : inner(request);

    const controller = new AbortController();
    const transfer = python.streamArtifact("big.bin", recordingSink().sink, {
      chunkBytes: CHUNK,
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    await expect(transfer).rejects.toMatchObject({ name: "ArtifactTransferAborted" });
    await tick();
    expect(leaseCount(worker)).toBe(0);
    expect(closes(worker)).toBe(1);
  });

  it("sends no close to a replacement Worker when the reply arrives after a restart", async () => {
    const first = healthyWorker();
    const second = healthyWorker();
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    await python.start();
    const deliver = heldLease(first);

    const transfer = python.streamArtifact("big.bin", recordingSink().sink, { chunkBytes: CHUNK });
    await tick();
    await python.restart();
    await expect(transfer).rejects.toMatchObject({ code: "restarted" });

    deliver(); // the old Worker answers, far too late
    await tick();
    await tick();
    // Nothing is sent anywhere: the old session's leases died with it, and a close addressed to
    // the replacement would free a lease belonging to somebody else's transfer.
    expect(closes(second)).toBe(0);
    expect(second.sent.filter((m) => m.kind.startsWith("artifact-"))).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});

describe("1.4 a throwing release() does not cancel the rest of the cleanup", () => {
  it("still closes the lease and returns the budget, four times over", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();

    for (let i = 0; i < 4; i += 1) {
      const { sink } = recordingSink({ throwRelease: true });
      // The transfer itself succeeds; only the destination's release is broken.
      await python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK });
    }
    expect(leaseCount(worker)).toBe(0);

    // The budget is proved free by USING it: four leaked reservations refuse this one.
    const ok = await python.streamArtifact("big.bin", {
      async write() {},
      async close() {},
      async abort() {},
    });
    expect(ok.bytesWritten).toBe(192 * 1024);
    expect(unhandled).toEqual([]);
  });

  it("reports the transfer's own failure, not the release's, when both go wrong", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    const sink = {
      async write() {
        throw new Error("the disk went away");
      },
      async close() {},
      async abort() {},
      release() {
        throw new Error("the destination's release blew up");
      },
    };
    await expect(python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK })).rejects.toThrow(
      /disk went away/,
    );
    expect(leaseCount(worker)).toBe(0);
  });
});

describe("1.5 the finishing phase is not cancellable, and says so", () => {
  it("cancelling before the last write aborts", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    const controller = new AbortController();
    const events: string[] = [];
    let writes = 0;
    const sink = {
      async write() {
        writes += 1;
        events.push(`write${writes}`);
        if (writes === 2) controller.abort();
      },
      async close() {
        events.push("close");
      },
      async abort() {
        events.push("abort");
      },
    };
    await expect(
      python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "ArtifactTransferAborted" });
    expect(events).toContain("abort");
    expect(events).not.toContain("close");
  });

  it("cancelling once close() has begun completes: the destination is already committed", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    const controller = new AbortController();
    const events: string[] = [];
    const sink = {
      async write() {
        events.push("write");
      },
      async close() {
        events.push("close");
        // The cancel lands while the destination is committing.
        controller.abort();
        await tick();
      },
      async abort() {
        events.push("abort");
      },
    };
    const result = await python.streamArtifact("big.bin", sink, {
      chunkBytes: CHUNK,
      signal: controller.signal,
    });
    expect(result.bytesWritten).toBe(192 * 1024);
    expect(events).not.toContain("abort");
  });

  it("a close that FAILS is a failed transfer, cancelled or not", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    const sink = {
      async write() {},
      async close() {
        throw new Error("the disk filled up on close");
      },
      async abort() {},
    };
    await expect(python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK })).rejects.toThrow(
      /disk filled up/,
    );
    expect(leaseCount(worker)).toBe(0);
  });

  it("reports whether cancellation is still possible, so a UI can say `Finishing…`", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    const phases: string[] = [];
    const result = await python.streamArtifact(
      "big.bin",
      { async write() {}, async close() {}, async abort() {} },
      {
        chunkBytes: CHUNK,
        onProgress: (progress) => phases.push(progress.phase ?? "transferring"),
      },
    );
    expect(result.bytesWritten).toBe(192 * 1024);
    expect(phases.at(-1)).toBe("finishing");
    expect(phases.filter((p) => p === "finishing")).toHaveLength(1);
  });
});

describe("1.6 every asynchronous boundary, interrupted", () => {
  const boundaries: Array<[string, (worker: FakeWorker) => void]> = [
    [
      "the lease request",
      (worker) => {
        const inner = worker.autoRespond!;
        worker.autoRespond = (request) =>
          request.kind === "artifact-open" ? null : inner(request);
      },
    ],
    [
      "a chunk request",
      (worker) => {
        const inner = worker.autoRespond!;
        worker.autoRespond = (request) =>
          request.kind === "artifact-chunk" ? null : inner(request);
      },
    ],
  ];

  for (const [what, silence] of boundaries) {
    it(`survives a cancellation during ${what}`, async () => {
      const worker = healthyWorker();
      const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
      await python.start();
      silence(worker);

      const controller = new AbortController();
      const { sink } = recordingSink();
      const transfer = python.streamArtifact("big.bin", sink, {
        chunkBytes: CHUNK,
        signal: controller.signal,
      });
      await tick();
      controller.abort();
      await expect(transfer).rejects.toMatchObject({ name: "ArtifactTransferAborted" });
      expect(unhandled).toEqual([]);
    });
  }

  it("a restart during a chunk request leaves no lease and no budget behind", async () => {
    const first = healthyWorker();
    const second = healthyWorker();
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    await python.start();
    const inner = first.autoRespond!;
    first.autoRespond = (request) => (request.kind === "artifact-chunk" ? null : inner(request));

    const { sink } = recordingSink();
    const transfer = python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK });
    await tick();
    await python.restart();
    await expect(transfer).rejects.toMatchObject({ code: "restarted" });
    expect(artifactRequests(second)).toEqual([]);

    const ok = await python.streamArtifact("big.bin", {
      async write() {},
      async close() {},
      async abort() {},
    });
    expect(ok.bytesWritten).toBe(192 * 1024);
    expect(unhandled).toEqual([]);
  });

  it("a dispose during a transfer settles it and leaves nothing running", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    const inner = worker.autoRespond!;
    worker.autoRespond = (request) => (request.kind === "artifact-chunk" ? null : inner(request));
    const { sink, events } = recordingSink();
    const transfer = python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK });
    await tick();
    python.dispose();
    await expect(transfer).rejects.toBeTruthy();
    expect(events).toContain("abort");
    expect(events).not.toContain("close");
    expect(unhandled).toEqual([]);
  });
});
