/**
 * Everything a transfer acquires, released on every path - including the paths nobody plans for.
 *
 * A download acquires four things: a slice of the engine-wide transfer budget, a lease that
 * FREEZES the artifact in the worker, a writer that LOCKS the caller's stream, and in-flight chunk
 * requests. A lost lease means Python can no longer write that file, a lost reservation refuses
 * the next download for memory nothing is using, and a lost writer lock means the caller's stream
 * can never be used or closed again. The gaps all have one shape - an acquisition outside the
 * scope that releases it, or an await with nothing to interrupt it:
 *
 *   - `toSink()` running AFTER the reservation and the lease and OUTSIDE the try, so an
 *     already-locked stream throws past both;
 *   - a cancellation read only between awaits, so a `write()` that never settles holds the
 *     artifact leased and the promise pending for as long as the page lives;
 *   - `close()` and `abort()` awaited without limit, so a hostile destination keeps the engine
 *     hostage during its own cleanup;
 *   - prefetched chunk rejections handled in `finally`, one turn too late when the second chunk
 *     fails while the first write is paused.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { healthyWorker, type FakeWorker } from "./fake-worker.js";
import type { WorkerRequest } from "../src/protocol.js";

/** 64 KiB is the smallest chunk the engine accepts; `big.bin` is 192 KiB, so three chunks. */
const CHUNK = 64 * 1024;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function engineWith(worker: FakeWorker) {
  return createBrowserPython({ workerFactory: () => worker as unknown as Worker });
}

/** A sink whose every operation can be made to hang forever. */
function hangingSink(hang: { write?: boolean; close?: boolean; abort?: boolean } = {}) {
  const events: string[] = [];
  const never = new Promise<void>(() => {});
  return {
    events,
    sink: {
      async write() {
        events.push("write");
        if (hang.write) await never;
      },
      async close() {
        events.push("close");
        if (hang.close) await never;
      },
      async abort() {
        events.push("abort");
        if (hang.abort) await never;
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
afterEach(() => {
  process.off("unhandledRejection", record);
});

describe("acquisition is all-or-nothing", () => {
  it("refuses an already-locked WritableStream without taking a lease or any budget", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();

    const stream = new WritableStream<Uint8Array>();
    stream.getWriter(); // somebody else already owns it

    await expect(python.streamArtifact("big.bin", stream)).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);

    // The budget is proved free by USING it: a full-size transfer must still be admitted.
    const ok = await python.streamArtifact("big.bin", {
      async write() {},
      async close() {},
      async abort() {},
    });
    expect(ok.bytesWritten).toBe(192 * 1024);
  });

  it("releases the lease and the budget when the lease itself fails", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();

    await expect(
      python.streamArtifact("does-not-exist.bin", {
        async write() {},
        async close() {},
        async abort() {},
      }),
    ).rejects.toBeTruthy();
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);

    const ok = await python.streamArtifact("big.bin", {
      async write() {},
      async close() {},
      async abort() {},
    });
    expect(ok.bytesWritten).toBe(192 * 1024);
  });

  it("aborts a destination it adopted, when it fails before the first byte", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    const { events, sink } = hangingSink();

    // The engine owns the destination from the moment it is passed in, so a lease failure has to
    // abort it rather than leave a FileSystemWritableFileStream open on the caller's disk.
    await expect(python.streamArtifact("does-not-exist.bin", sink)).rejects.toBeTruthy();
    expect(events).toEqual(["abort"]);
  });

  it("aborts exactly once, never twice, and never closes after a failure", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    const events: string[] = [];
    const sink = {
      async write() {
        events.push("write");
        throw new Error("the disk went away");
      },
      async close() {
        events.push("close");
      },
      async abort() {
        events.push("abort");
      },
    };

    await expect(python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK })).rejects.toThrow(
      /disk went away/,
    );
    expect(events).toEqual(["write", "abort"]);
  });
});

describe("nothing waits forever", () => {
  it("settles promptly when the signal aborts during a write that never returns", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    const controller = new AbortController();
    const { sink } = hangingSink({ write: true });

    const transfer = python.streamArtifact("big.bin", sink, {
      chunkBytes: CHUNK,
      signal: controller.signal,
    });
    await tick();
    controller.abort();

    await expect(transfer).rejects.toMatchObject({ name: "ArtifactTransferAborted" });
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);
  });

  it("settles promptly when a restart happens during a write that never returns", async () => {
    const first = healthyWorker();
    const second = healthyWorker();
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    await python.start();
    const { sink } = hangingSink({ write: true });

    const transfer = python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK });
    await tick();
    await python.restart();

    await expect(transfer).rejects.toMatchObject({ code: "restarted" });
  });

  it("settles when a chunk reply never arrives and the caller aborts", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    // Answer the lease, then go silent on chunks.
    const inner = worker.autoRespond!;
    worker.autoRespond = (request: WorkerRequest) =>
      request.kind === "artifact-chunk" ? null : inner(request);

    const controller = new AbortController();
    const transfer = python.streamArtifact(
      "big.bin",
      { async write() {}, async close() {}, async abort() {} },
      { chunkBytes: CHUNK, signal: controller.signal },
    );
    await tick();
    controller.abort();

    await expect(transfer).rejects.toMatchObject({ name: "ArtifactTransferAborted" });
  });

  it("does not let a hanging close() hold the engine", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    const { sink } = hangingSink({ close: true });

    // A close that never settles is a FAILED transfer, not a successful one: the file was not
    // finished, and saying it was is the one answer that must never be given.
    await expect(
      python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK, cleanupTimeoutMs: 20 }),
    ).rejects.toBeTruthy();
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);

    const ok = await python.streamArtifact("big.bin", {
      async write() {},
      async close() {},
      async abort() {},
    });
    expect(ok.bytesWritten).toBe(192 * 1024);
  });

  it("does not let a hanging abort() hold the engine either", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    const events: string[] = [];
    const never = new Promise<void>(() => {});
    const sink = {
      async write() {
        events.push("write");
        throw new Error("destination failed");
      },
      async close() {},
      async abort() {
        events.push("abort");
        await never;
      },
    };

    await expect(
      python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK, cleanupTimeoutMs: 20 }),
    ).rejects.toThrow(/destination failed/);
    expect(events).toEqual(["write", "abort"]);
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);
  });
});

describe("prefetched chunks", () => {
  it("a chunk that rejects while a write is paused does not become an unhandled rejection", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();

    // The exact shape: chunk 1 is answered, chunk 2 is REFUSED, and the sink is holding the first
    // write while that refusal lands. The transfer is still awaiting the write, so nothing is
    // looking at chunk 2's promise - and a handler attached in `finally` has not run.
    const inner = worker.autoRespond!;
    let chunks = 0;
    worker.autoRespond = (request: WorkerRequest) => {
      if (request.kind !== "artifact-chunk") return inner(request);
      chunks += 1;
      if (chunks === 2) {
        return { kind: "request-error", id: request.id, message: "the workspace went away" };
      }
      return inner(request);
    };

    let releaseWrite!: () => void;
    const held = new Promise<void>((resolve) => (releaseWrite = resolve));
    let writes = 0;
    const sink = {
      async write() {
        writes += 1;
        if (writes === 1) await held;
      },
      async close() {},
      async abort() {},
    };

    const transfer = python.streamArtifact("big.bin", sink, { chunkBytes: CHUNK, windowChunks: 3 });
    // Let the refusal land while the first write is still held.
    await tick();
    await tick();
    releaseWrite();

    await expect(transfer).rejects.toBeTruthy();
    await tick();
    await tick();
    expect(unhandled).toEqual([]);
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);
  });
});
