/**
 * artifact-stream.ts - getting a large artifact out of the worker without it ever existing twice.
 *
 * Reading the whole file into a `Blob` keeps the WASM heap flat and is still wrong for the job: a
 * `Blob` is the entire artifact in browser-managed storage before a single byte reaches the
 * user's disk, so a 2 GiB NetCDF export needs 2 GiB of somebody's memory. This is a PULL instead
 * - the main thread asks for a chunk, writes it, and asks for the next only when the destination
 * has taken it, so the peak cost is the window size times the chunk size, and chunks cross
 * `postMessage` as transferred `ArrayBuffer`s. The destination is an interface rather than a
 * `FileSystemWritableFileStream`, because the right one is not this package's decision.
 */

/** Where a streamed artifact goes. Deliberately the shape `FileSystemWritableFileStream` already
 * has, so the common case is `await handle.createWritable()` passed straight in. A plain
 * `WritableStream<Uint8Array>` works too - see `toSink` - with its writer's `ready` backpressure. */
export interface ArtifactSink {
  write(chunk: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
  abort(reason?: unknown): void | Promise<void>;
  /** Give back anything the adapter took, whatever happened. Only the `WritableStream` adapter
   * has anything to do: acquiring a writer LOCKS the stream, and a stream left locked is one the
   * caller can never use or close again. Optional; `toSink` always supplies one. */
  release?(): void;
}

export interface ArtifactStreamOptions {
  /** Cancel the transfer. The sink is aborted and the lease released. */
  signal?: AbortSignal;
  /** Called after each chunk reaches the sink, and once more when the destination starts
   * closing. `phase` is what a UI needs to be honest about Cancel: while `transferring` it stops
   * the download and aborts the destination; once `finishing` every byte is written and the
   * destination is committing, so Cancel would do nothing. Show "Finishing..." instead. */
  onProgress?: (progress: {
    transferred: number;
    total: number;
    phase: "transferring" | "finishing";
  }) => void;
  /** Bytes per chunk. Clamped to something sane; see `CHUNK_BYTES`. */
  chunkBytes?: number;
  /** How many chunk requests may be outstanding at once. One is strictly serial: read, write,
   * read, write. Two lets the worker read the next chunk while the destination writes the last,
   * roughly halving the wall clock on a slow disk for one extra chunk of memory. Above about four
   * there is nothing left to overlap. */
  windowChunks?: number;
  /**
   * How long the engine will wait for the DESTINATION's `close()` or `abort()` before giving up.
   * Cleanup is the one place a transfer can be held hostage by the thing it is letting go of: a
   * `FileSystemWritableFileStream` whose disk has gone away can leave `close()` pending forever -
   * and with it the artifact's lease, which freezes the file in Python, and the engine-wide
   * memory budget, which refuses the next download. Timing out makes the transfer a FAILURE.
   */
  cleanupTimeoutMs?: number;
}

/** How long to wait for a destination's own cleanup. See `ArtifactStreamOptions`. */
export const SINK_CLEANUP_TIMEOUT_MS = 5000;

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const MIN_CHUNK_BYTES = 64 * 1024;
export const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
export const MAX_WINDOW_CHUNKS = 4;

/** Clamp a caller's chunk size into a range where the arithmetic still makes sense. */
export function resolveChunkBytes(requested: number | undefined): number {
  if (requested === undefined) return CHUNK_BYTES;
  if (!Number.isSafeInteger(requested) || requested <= 0) return CHUNK_BYTES;
  return Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, requested));
}

export function resolveWindow(requested: number | undefined): number {
  if (requested === undefined) return 2;
  if (!Number.isSafeInteger(requested) || requested <= 0) return 1;
  return Math.min(MAX_WINDOW_CHUNKS, requested);
}

/** Accept either shape of destination. A `WritableStream` is unwrapped to its writer, because
 * the writer is where the backpressure lives: `ready` resolves when the stream will take more, and
 * awaiting it stops a fast reader queueing a gigabyte inside a slow stream's internal buffer. */
export function toSink(destination: ArtifactSink | WritableStream<Uint8Array>): ArtifactSink {
  const candidate = destination as { getWriter?: () => WritableStreamDefaultWriter<Uint8Array> };
  if (typeof candidate.getWriter !== "function") {
    const plain = destination as ArtifactSink;
    return {
      write: (chunk) => plain.write(chunk),
      close: () => plain.close(),
      abort: (reason) => plain.abort(reason),
      release: () => plain.release?.(),
    };
  }
  const writer = candidate.getWriter();
  // `settled` makes close and abort mutually exclusive and each at most once. Both are terminal
  // operations on a writer and calling the second throws, so a transfer that closed and then hit
  // an error in its `finally` would replace a clean failure with a `TypeError` about a stream that
  // is already closed.
  let settled = false;
  let released = false;
  return {
    async write(chunk) {
      await writer.ready;
      await writer.write(chunk);
    },
    async close() {
      if (settled) return;
      settled = true;
      await writer.close();
    },
    async abort(reason) {
      if (settled) return;
      settled = true;
      await writer.abort(reason);
    },
    release() {
      if (released) return;
      released = true;
      // A locked stream is one the caller can never use or close again. Released on every path,
      // including the ones where the lease never opened.
      try {
        writer.releaseLock();
      } catch {
        // already released, or the writer is in a state that forbids it
      }
    },
  };
}

/** Check one chunk reply before a byte of it reaches the destination. A matching request id is
 * not evidence: ids are unique per engine, but a reply is still a message from a Worker that may
 * have been replaced, carrying a lease id a replacement Worker also issues, describing an artifact
 * that may have changed. Every field identifying WHICH bytes these are is confirmed here. */
export function validateChunk(
  chunk: {
    workerSession: string;
    lease: string;
    offset: number;
    generation: number;
    eof: boolean;
    bytes: ArrayBuffer;
  },
  expected: {
    session: string;
    lease: { lease: string; size: number; generation: number };
    offset: number;
    length: number;
  },
): void {
  const complain = (why: string): never => {
    throw new ArtifactProtocolError(`The worker sent an unusable chunk: ${why}.`);
  };
  if (chunk.workerSession !== expected.session) {
    complain(`it came from worker session ${chunk.workerSession}, not ${expected.session}`);
  }
  if (chunk.lease !== expected.lease.lease) {
    complain(`it is for lease ${chunk.lease}, not ${expected.lease.lease}`);
  }
  if (chunk.generation !== expected.lease.generation) {
    // The artifact changed under the transfer. Continuing would deliver a file that is partly the
    // old version and partly the new one, with nothing to indicate it.
    complain(
      `the artifact changed while it was being read (generation ${expected.lease.generation} -> ` +
        `${chunk.generation})`,
    );
  }
  if (chunk.offset !== expected.offset) {
    complain(`it starts at byte ${chunk.offset}, but byte ${expected.offset} was requested`);
  }
  if (chunk.bytes.byteLength !== expected.length) {
    complain(
      `it carries ${chunk.bytes.byteLength} bytes where ${expected.length} were requested, which ` +
        `would leave a gap`,
    );
  }
  const reachesEnd = expected.offset + expected.length >= expected.lease.size;
  if (chunk.eof !== reachesEnd) {
    complain(
      `it reports eof=${String(chunk.eof)} at byte ${expected.offset + expected.length} of ` +
        `${expected.lease.size}`,
    );
  }
}

/** A reply that does not describe the bytes that were asked for. Never retried, always fatal. */
export class ArtifactProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactProtocolError";
  }
}

/** The engine-wide ceiling on bytes held by transfers in flight. Per ENGINE rather than per
 * transfer, because the default window is two chunks: one stream is already 8 MiB rather than
 * 4 MiB, and three concurrent streams are 24 MiB with nothing to say so. 32 MiB is four default
 * streams; beyond that a transfer is refused with a message naming the budget. */
export const TRANSFER_MEMORY_BUDGET_BYTES = 32 * 1024 * 1024;

/** Thrown when a caller aborts a transfer. Distinguished so a UI can stay quiet about it. */
export class ArtifactTransferAborted extends Error {
  constructor(message = "The download was cancelled.") {
    super(message);
    this.name = "ArtifactTransferAborted";
  }
}

/** Record `cleanupErrors` on `target` if possible. Returns whether it worked; NEVER throws - it
 * runs in a `finally`, where a throw replaces the failure being reported. Frozen, sealed,
 * read-only, accessor-only, proxied and primitive targets all reach here; a refusal is respected
 * and the caller rethrows its original value. */
export function attachCleanupDiagnostics(
  target: unknown,
  cleanupErrors: readonly unknown[],
): boolean {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) return false;
  try {
    (target as { cleanupErrors?: unknown }).cleanupErrors = [...cleanupErrors];
    return true;
  } catch {
    return false;
  }
}
