/**
 * A download must not outlive the interpreter it is reading from.
 *
 * The race is reproducible and delivers a corrupt file that looks successful:
 *
 *   1. start downloading artifact A;
 *   2. pause the destination after the first chunk;
 *   3. restart the engine;
 *   4. the new Worker issues lease ids from its own counter, so it hands out `lease-1` too;
 *   5. resume the paused transfer.
 *
 * The remaining chunk requests carry a lease id the NEW Worker also recognises, so the transfer
 * reports success having written the first chunk of A followed by the middle of B, and its
 * cleanup then closes a lease belonging to the new Worker. Matching request ids is not enough,
 * and neither is a bigger counter: a transfer belongs to one Worker session, and every message
 * it sends is addressed to that session.
 */
import { describe, expect, it } from "vitest";

import { createBrowserPython } from "../src/browser-python.js";
import type { FakeWorker } from "./fake-worker.js";
import { healthyWorker } from "./fake-worker.js";

/**
 * 64 KiB is the smallest chunk `resolveChunkBytes` will accept, and the fake artifact is 192 KiB,
 * so every transfer below is exactly three chunks - enough to be paused in the middle of one.
 */
const CHUNK = 64 * 1024;

/** A sink that can be held open at a chosen write, and records exactly what happened to it. */
function pausableSink(pauseAtWrite: number) {
  const events: string[] = [];
  const chunks: Uint8Array[] = [];
  let release: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: (() => void) | undefined;
  const atPause = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let writes = 0;
  return {
    events,
    chunks,
    atPause,
    release: () => release?.(),
    sink: {
      async write(chunk: Uint8Array) {
        writes += 1;
        chunks.push(chunk.slice());
        events.push(`write:${chunk.byteLength}`);
        if (writes === pauseAtWrite) {
          reached?.();
          await paused;
        }
      },
      close() {
        events.push("close");
      },
      abort() {
        events.push("abort");
      },
    },
  };
}

describe("a transfer belongs to one Worker session", () => {
  it("rejects, and touches nothing in the new Worker, when the engine restarts mid-download", async () => {
    const workers: FakeWorker[] = [];
    const engine = createBrowserPython({
      workerFactory: () => {
        const worker = healthyWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    await engine.start();

    const first = pausableSink(1);
    const transfer = engine.streamArtifact("big.bin", first.sink, {
      chunkBytes: CHUNK,
      windowChunks: 1,
    });
    await first.atPause;

    // The old Worker is holding one lease at this point, and it is about to be replaced.
    expect((workers[0] as unknown as { openLeases: number }).openLeases).toBe(1);
    await engine.restart();
    expect(workers).toHaveLength(2);

    // A transfer in the NEW Worker, deliberately left open, so the test can prove the old
    // transfer's cleanup does not close somebody else's lease.
    const survivor = pausableSink(1);
    const surviving = engine.streamArtifact("big.bin", survivor.sink, {
      chunkBytes: CHUNK,
      windowChunks: 1,
    });
    await survivor.atPause;
    expect((workers[1] as unknown as { openLeases: number }).openLeases).toBe(1);

    const newWorkerTrafficBefore = workers[1].sent.length;
    first.release();
    await expect(transfer).rejects.toMatchObject({ code: "restarted" });

    // The destination is aborted exactly once and never closed: a closed half-written file is one
    // somebody opens.
    expect(first.events.filter((event) => event === "abort")).toHaveLength(1);
    expect(first.events).not.toContain("close");

    // Nothing the dead transfer did was addressed to the live Worker.
    const strayed = workers[1].sent
      .slice(newWorkerTrafficBefore)
      .filter((message) => message.kind === "artifact-chunk" || message.kind === "artifact-close");
    expect(strayed).toEqual([]);

    // And the live transfer's lease is still open, because its actual owner has not finished.
    expect((workers[1] as unknown as { openLeases: number }).openLeases).toBe(1);

    survivor.release();
    await expect(surviving).resolves.toMatchObject({ name: "big.bin" });
    expect((workers[1] as unknown as { openLeases: number }).openLeases).toBe(0);
    expect(survivor.events.at(-1)).toBe("close");
  });

  it("does not deliver bytes from two different workspaces as one file", async () => {
    // The corruption itself, asserted on the bytes. Each fake Worker stamps a different pattern
    // into `big.bin`, so a transfer that continued across a restart produces a file whose first
    // chunk carries one marker and whose later chunks carry another - and reports success.
    const workers: FakeWorker[] = [];
    const engine = createBrowserPython({
      workerFactory: () => {
        const worker = healthyWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    await engine.start();

    const held = pausableSink(1);
    const transfer = engine.streamArtifact("big.bin", held.sink, {
      chunkBytes: CHUNK,
      windowChunks: 1,
    });
    await held.atPause;
    await engine.restart();
    held.release();

    await expect(transfer).rejects.toThrow();
    // Whatever arrived, it is not a complete file: the transfer failed rather than stitching two
    // workspaces together.
    const delivered = held.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    expect(delivered).toBeLessThan(192 * 1024);
  });

  it("aborts the destination when the engine is disposed mid-download", async () => {
    // Dispose has no reply to reject a pending request with, and a transfer stalled inside
    // `sink.write()` has no pending request at all - so the engine has to reach the transfer
    // directly rather than relying on the request table.
    const engine = createBrowserPython({
      workerFactory: () => healthyWorker() as unknown as Worker,
    });
    await engine.start();

    const held = pausableSink(1);
    const transfer = engine.streamArtifact("big.bin", held.sink, {
      chunkBytes: CHUNK,
      windowChunks: 1,
    });
    await held.atPause;
    engine.dispose();
    held.release();

    await expect(transfer).rejects.toMatchObject({ code: "disposed" });
    expect(held.events.filter((event) => event === "abort")).toHaveLength(1);
    expect(held.events).not.toContain("close");
  });
});

// Everything else a transfer's lifecycle has to get exactly right: the paths where "mostly
// correct" produces a file the user opens - a destination closed after a failure, a stream left
// locked so the caller can never use it again, a cancellation during the last write that reports
// success because the loop had already finished.
describe("stream lifecycle", () => {
  const engineWith = async () => {
    const engine = createBrowserPython({
      workerFactory: () => healthyWorker() as unknown as Worker,
    });
    await engine.start();
    return engine;
  };

  /** A real `WritableStream`, so the locking behaviour under test is the browser's own. */
  function recordingStream() {
    const written: number[] = [];
    const events: string[] = [];
    let failAt: number | null = null;
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(chunk.byteLength);
        if (failAt !== null && written.length === failAt) throw new Error("the disk went away");
      },
      close() {
        events.push("close");
      },
      abort() {
        events.push("abort");
      },
    });
    return { stream, written, events, failAt: (n: number) => (failAt = n) };
  }

  it("does not lock the caller's stream when the artifact does not exist", async () => {
    // Acquiring a writer LOCKS the stream, and a lease that fails has to release it: otherwise the
    // caller's stream is permanently unusable, with nothing to release it and no indication why.
    const engine = await engineWith();
    const { stream } = recordingStream();

    await expect(engine.streamArtifact("absent.nc", stream)).rejects.toThrow(/no artifact called/);
    expect(stream.locked).toBe(false);
  });

  it("closes once and releases the lock on success", async () => {
    const engine = await engineWith();
    const { stream, written, events } = recordingStream();

    await engine.streamArtifact("big.bin", stream, { chunkBytes: CHUNK });

    expect(written.reduce((a, b) => a + b, 0)).toBe(192 * 1024);
    expect(events).toEqual(["close"]);
    expect(stream.locked).toBe(false);
  });

  it("releases the lock when the destination fails, and does not close it", async () => {
    // A `WritableStream` whose `write()` throws errors itself, so its own `abort` callback is not
    // invoked - the stream is already errored. What matters is that the transfer neither closes it
    // nor walks away holding the writer: a stream left locked can never be used or closed again.
    const engine = await engineWith();
    const { stream, events, failAt } = recordingStream();
    failAt(2);

    await expect(engine.streamArtifact("big.bin", stream, { chunkBytes: CHUNK })).rejects.toThrow(
      /disk went away/,
    );
    expect(events).not.toContain("close");
    expect(stream.locked).toBe(false);
    // The stream really is errored rather than merely abandoned.
    await expect(stream.getWriter().closed).rejects.toThrow(/disk went away/);
  });

  it("aborts when cancellation lands during the FINAL write", async () => {
    // The one that reports success if the ordering is wrong: the loop's last iteration writes, the
    // queue empties, and going straight to `sink.close()` turns a signal aborted between the last
    // write and the close into a closed destination and a resolved promise.
    const engine = await engineWith();
    const controller = new AbortController();
    const events: string[] = [];
    let writes = 0;

    await expect(
      engine.streamArtifact(
        "big.bin",
        {
          write() {
            writes += 1;
            if (writes === 3) controller.abort();
          },
          close() {
            events.push("close");
          },
          abort() {
            events.push("abort");
          },
        },
        { chunkBytes: CHUNK, windowChunks: 1, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "ArtifactTransferAborted" });

    expect(writes).toBe(3);
    expect(events).toEqual(["abort"]);
  });

  it("aborts before the first chunk when the signal is already aborted", async () => {
    const engine = await engineWith();
    const controller = new AbortController();
    controller.abort();
    const events: string[] = [];

    await expect(
      engine.streamArtifact(
        "big.bin",
        {
          write() {
            events.push("write");
          },
          close() {
            events.push("close");
          },
          abort() {
            events.push("abort");
          },
        },
        { chunkBytes: CHUNK, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "ArtifactTransferAborted" });
    expect(events).toEqual(["abort"]);
  });
});

describe("chunk replies are checked, not trusted", () => {
  /** A worker whose chunk replies can be corrupted one field at a time. */
  function tamperingWorker(tamper: (chunk: Record<string, unknown>) => void): FakeWorker {
    const worker = healthyWorker();
    const base = worker.autoRespond!;
    worker.autoRespond = (request) => {
      const reply = base(request);
      if (reply?.kind === "artifact-chunk-data")
        tamper(reply as unknown as Record<string, unknown>);
      return reply;
    };
    return worker;
  }

  const run = async (tamper: (chunk: Record<string, unknown>) => void) => {
    const engine = createBrowserPython({
      workerFactory: () => tamperingWorker(tamper) as unknown as Worker,
    });
    await engine.start();
    const events: string[] = [];
    return engine
      .streamArtifact(
        "big.bin",
        {
          write() {
            events.push("write");
          },
          close() {
            events.push("close");
          },
          abort() {
            events.push("abort");
          },
        },
        { chunkBytes: CHUNK, windowChunks: 1 },
      )
      .then(
        () => ({ ok: true, events }),
        (error: Error) => ({ ok: false, message: error.message, events }),
      );
  };

  it("refuses a chunk from another worker session", async () => {
    const result = await run((chunk) => (chunk.workerSession = "ws-somebody-else"));
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining("worker session") });
    expect(result.events).toContain("abort");
    expect(result.events).not.toContain("close");
  });

  it("refuses a chunk for another lease", async () => {
    const result = await run((chunk) => (chunk.lease = "lease-99"));
    expect(result).toMatchObject({ message: expect.stringContaining("lease") });
  });

  it("refuses a chunk whose artifact changed underneath the transfer", async () => {
    // Continuing would deliver a file that is partly the old version and partly the new one.
    const result = await run((chunk) => (chunk.generation = 42));
    expect(result).toMatchObject({ message: expect.stringContaining("changed while it was") });
  });

  it("refuses a chunk that starts at the wrong offset", async () => {
    const result = await run((chunk) => (chunk.offset = (chunk.offset as number) + 1));
    expect(result).toMatchObject({ message: expect.stringContaining("starts at byte") });
  });

  it("refuses a chunk that is shorter than requested", async () => {
    const result = await run((chunk) => {
      chunk.bytes = (chunk.bytes as ArrayBuffer).slice(0, 16);
    });
    expect(result).toMatchObject({ message: expect.stringContaining("would leave a gap") });
  });

  it("refuses a chunk whose eof flag disagrees with the arithmetic", async () => {
    const result = await run((chunk) => (chunk.eof = true));
    expect(result).toMatchObject({ message: expect.stringContaining("eof=true") });
  });
});

describe("the engine's transfer-memory budget", () => {
  it("refuses a transfer that would exceed the engine-wide budget", async () => {
    // The bound is engine-wide, not per transfer. The per-transfer number was never the
    // interesting one: the default window is two chunks, so one stream is already 8 MiB rather
    // than the 4 MiB a measurement watching only the chunk being written suggests, and nothing
    // stops six of them running at once.
    const engine = createBrowserPython({
      workerFactory: () => healthyWorker() as unknown as Worker,
    });
    await engine.start();

    let release: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => (release = resolve));
    let reached: () => void = () => undefined;
    const atFirstWrite = new Promise<void>((resolve) => (reached = resolve));

    // 8 MiB chunks with a window of four reserves the whole 32 MiB budget, and holds it for as
    // long as the destination is stalled - which is exactly the situation the budget is for.
    const first = engine.streamArtifact(
      "big.bin",
      {
        async write() {
          reached();
          await paused;
        },
        close() {},
        abort() {},
      },
      { chunkBytes: 8 * 1024 * 1024, windowChunks: 4 },
    );
    await atFirstWrite;

    await expect(
      engine.streamArtifact(
        "big.bin",
        { write() {}, close() {}, abort() {} },
        { chunkBytes: 8 * 1024 * 1024, windowChunks: 1 },
      ),
    ).rejects.toMatchObject({ code: "resource" });

    release();
    await first;

    // …and the budget is given back, so the next one succeeds.
    await expect(
      engine.streamArtifact(
        "big.bin",
        { write() {}, close() {}, abort() {} },
        { chunkBytes: 8 * 1024 * 1024, windowChunks: 4 },
      ),
    ).resolves.toMatchObject({ bytesWritten: 192 * 1024 });
  });
});
