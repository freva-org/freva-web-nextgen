/**
 * The pieces of a streamed download that need no browser: the option clamps and the sink adapter.
 * Small, and worth having because they are small. `resolveChunkBytes` and `resolveWindow` decide
 * how much memory a transfer can occupy, so "a caller passed NaN" has to mean a default and not
 * `new Uint8Array(NaN)`; `toSink` decides whether a `WritableStream`'s backpressure is honoured,
 * since unwrapping to a writer and never awaiting `ready` lets a fast reader queue a gigabyte.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  MAX_WINDOW_CHUNKS,
  MIN_CHUNK_BYTES,
  resolveChunkBytes,
  resolveWindow,
  toSink,
  ArtifactTransferAborted,
} from "../src/artifact-stream.js";

describe("chunk size", () => {
  it("defaults when unset", () => {
    expect(resolveChunkBytes(undefined)).toBe(CHUNK_BYTES);
  });

  it("defaults rather than propagating nonsense", () => {
    // `new Uint8Array(NaN)` is an empty array, and a transfer built on one makes no progress and
    // never terminates. Every one of these has to become a number.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(resolveChunkBytes(bad)).toBe(CHUNK_BYTES);
    }
  });

  it("clamps into a range where the arithmetic still makes sense", () => {
    expect(resolveChunkBytes(1)).toBe(MIN_CHUNK_BYTES);
    expect(resolveChunkBytes(1024 * 1024 * 1024)).toBe(MAX_CHUNK_BYTES);
    expect(resolveChunkBytes(1024 * 1024)).toBe(1024 * 1024);
  });
});

describe("window size", () => {
  it("overlaps one read with one write by default", () => {
    expect(resolveWindow(undefined)).toBe(2);
  });

  it("never exceeds the cap, and never drops below one", () => {
    // The window multiplies the peak memory, so an unbounded value would undo the bound.
    expect(resolveWindow(999)).toBe(MAX_WINDOW_CHUNKS);
    expect(resolveWindow(0)).toBe(1);
    expect(resolveWindow(Number.NaN)).toBe(1);
  });
});

describe("the sink adapter", () => {
  it("wraps a plain destination without changing what it does", async () => {
    // Wrapped rather than returned as-is, so `release()` always exists and every call site can
    // use it unconditionally. The wrapper must be transparent otherwise.
    const sink = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
    const wrapped = toSink(sink);
    const chunk = new Uint8Array([1, 2]);
    await wrapped.write(chunk);
    await wrapped.close();
    await wrapped.abort("why");
    wrapped.release?.();
    expect(sink.write).toHaveBeenCalledWith(chunk);
    expect(sink.close).toHaveBeenCalledTimes(1);
    expect(sink.abort).toHaveBeenCalledWith("why");
  });

  it("awaits a WritableStream's `ready` before every write", async () => {
    // The assertion that matters. A writer's `ready` is the destination saying it will take
    // more; writing without awaiting it queues into the stream's internal buffer instead, which is
    // the unbounded accumulation being avoided one layer up. The order below - ready, write,
    // ready, write - is what backpressure looks like from here.
    const order: string[] = [];
    const writer = {
      get ready() {
        order.push("ready");
        return Promise.resolve();
      },
      write: vi.fn(async () => {
        order.push("write");
      }),
      close: vi.fn(async () => {
        order.push("close");
      }),
      abort: vi.fn(async () => {
        order.push("abort");
      }),
    };
    const sink = toSink({ getWriter: () => writer } as unknown as WritableStream<Uint8Array>);

    await sink.write(new Uint8Array([1]));
    await sink.write(new Uint8Array([2]));
    await sink.close();

    expect(order).toEqual(["ready", "write", "ready", "write", "close"]);
    expect(writer.write).toHaveBeenCalledTimes(2);
  });

  it("aborts with the reason rather than closing", async () => {
    const writer = {
      ready: Promise.resolve(),
      write: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
    };
    const sink = toSink({ getWriter: () => writer } as unknown as WritableStream<Uint8Array>);
    const reason = new Error("the disk went away");
    await sink.abort(reason);
    // Closing a half-written file leaves something a person will open. Aborting does not.
    expect(writer.abort).toHaveBeenCalledWith(reason);
    expect(writer.close).not.toHaveBeenCalled();
  });
});

describe("cancellation", () => {
  it("is its own error type, so a UI can stay quiet about it", () => {
    const error = new ArtifactTransferAborted();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ArtifactTransferAborted");
    // A cancelled download is a thing the user chose. Reporting it as a failure is noise.
    expect(error.message).toMatch(/cancelled/i);
  });
});
