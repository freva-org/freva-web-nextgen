// engine-sessions.ts - the engine's session operations: writing files INTO `/workspace`,
// resource samples, and quiescing for a checkpoint. Loaded by the engine on first use.

// Types only from the engine's own modules: a runtime import would split them into a shared chunk
// every page pays for. Errors are built through `engine.error()` instead.
import type { EngineInternals, WorkerSession } from "./engine-internals.js";
import type { WorkerResourceSample } from "./protocol.js";
import type { CellOptions, CellResult, SessionResources, WorkspaceWriteResult } from "./types.js";

/** One chunk of a workspace import: bounded, and only one in flight. */
export const IMPORT_CHUNK_BYTES = 1024 * 1024;

/** Resource samples: at most one per this interval, and a reply this late is stale. */
export const SAMPLE_INTERVAL_MS = 1_000;
export const SAMPLE_TIMEOUT_MS = 1_500;

/**
 * One workspace import, run as the queued work it was submitted as (the engine reserved its
 * place and captured `session` when it was called). The queue is HELD for the whole import: no
 * Python runs while a file is half-written. A read of the caller's stream that never settles is
 * cancelled when the import is aborted or the interpreter ends, so it cannot block the queue.
 */
export async function writeWorkspaceFile(
  engine: EngineInternals,
  session: WorkerSession,
  name: string,
  source: Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
  options: { size?: number; overwrite?: boolean; signal?: AbortSignal } = {},
): Promise<WorkspaceWriteResult> {
  let size = options.size;
  let stream: ReadableStream<Uint8Array>;
  if (source instanceof ReadableStream) {
    stream = source;
  } else {
    const blob =
      source instanceof Blob
        ? source
        : new Blob([
            source instanceof ArrayBuffer
              ? source
              : new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice(),
          ]);
    size ??= blob.size;
    if (size !== blob.size) throw new RangeError(`size ${size} is not the data's ${blob.size}.`);
    stream = blob.stream();
  }
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
    if (source instanceof ReadableStream) source.cancel().catch(() => undefined);
    throw new RangeError("writeWorkspaceFile needs the size of a stream.");
  }
  const total = size;
  const reader = stream.getReader();
  // Ends a pending read: the import's own abort, or the interpreter going away.
  const stop = (): void => {
    reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  session.ended.addEventListener("abort", stop, { once: true });
  const read = async () => {
    const next = await reader.read();
    if (options.signal?.aborted) throw engine.error("aborted");
    if (!session.alive) {
      throw engine.error(
        "restarted",
        `The interpreter was replaced while ${name} was being imported, so it was not written.`,
      );
    }
    return next;
  };
  try {
    if (options.signal?.aborted) throw engine.error("aborted");
    const { handle } = await engine.request<{ handle: string }>(
      "import-handle",
      (id) => ({ kind: "import-open", id, name, size: total, overwrite: !!options.overwrite }),
      { session },
    );
    let offset = 0;
    let pending: Uint8Array | null = null;
    try {
      for (;;) {
        if (options.signal?.aborted) throw engine.error("aborted");
        if (!pending?.byteLength) {
          const next = await read();
          if (next.done) break;
          pending = next.value;
          continue;
        }
        const part = pending.slice(0, IMPORT_CHUNK_BYTES);
        // Read before the transfer detaches it.
        const length = part.byteLength;
        pending = pending.subarray(length);
        if (offset + length > total) {
          throw new RangeError(`${name} is longer than the ${total} bytes declared.`);
        }
        await engine.request<void>(
          "ack",
          (id) => ({ kind: "import-chunk", id, handle, offset, bytes: part.buffer }),
          { session, transfer: [part.buffer] },
        );
        offset += length;
      }
      if (offset !== total) {
        throw new RangeError(`${name} ended at ${offset} of the ${total} bytes declared.`);
      }
      await engine.request<void>(
        "ack",
        (id) => ({ kind: "import-close", id, handle, commit: true }),
        { session },
      );
    } catch (error) {
      if (session.alive) {
        engine
          .request<void>("ack", (id) => ({ kind: "import-close", id, handle, commit: false }), {
            session,
          })
          .catch(() => undefined);
      }
      throw error;
    }
    return { name, size: total };
  } finally {
    options.signal?.removeEventListener("abort", stop);
    session.ended.removeEventListener("abort", stop);
    reader.cancel().catch(() => undefined);
  }
}

export function observeResources(engine: EngineInternals): Promise<SessionResources> {
  const cache = engine.shared;
  const last = cache.sample;
  if (last && Date.now() - last.sampledAt < SAMPLE_INTERVAL_MS) return Promise.resolve(last);
  cache.sampling ??= takeSample(engine).finally(() => (cache.sampling = null));
  return cache.sampling;
}

async function takeSample(engine: EngineInternals): Promise<SessionResources> {
  const session = engine.session();
  let sample: WorkerResourceSample | null = null;
  if (session?.alive && engine.state() !== "loading") {
    // Not through the queue: the worker answers this between awaits, so a sample can be taken
    // while a cell waits on the network. A synchronous loop answers nothing: the sample is stale.
    const reply = engine.request<WorkerResourceSample>(
      "resources-reply",
      (id) => ({ kind: "resources", id }),
      { session },
    );
    reply.catch(() => undefined);
    sample = await Promise.race([
      reply,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SAMPLE_TIMEOUT_MS)),
    ]);
  }
  const stale = sample === null;
  const previous =
    engine.shared.sample?.workerGeneration === session?.id ? engine.shared.sample : null;
  const from: Partial<SessionResources> = (stale ? previous : sample) ?? {};
  const next: SessionResources = {
    workerGeneration: session?.id ?? "",
    sampledAt: Date.now(),
    pendingExecutions: engine.executions(),
    activeTransfers: engine.transfers() + engine.shared.imports,
    sampleStale: stale,
  };
  for (const key of [
    "wasmCapacityBytes",
    "workspaceBytes",
    "fetchedDecodedBytes",
    "transferBytesEstimate",
  ] as const) {
    const value = from[key];
    if (typeof value === "number") next[key] = value;
  }
  const { startupMs, timeToUsableMs } = engine.shared;
  if (startupMs !== undefined) next.startupMs = startupMs;
  if (timeToUsableMs !== undefined) next.timeToUsableMs = timeToUsableMs;
  engine.shared.sample = next;
  return next;
}

export async function quiesce(engine: EngineInternals): Promise<() => void> {
  const busy = (): string | null =>
    engine.executions() > 0
      ? "code is running or queued"
      : engine.transfers() + engine.shared.imports > 0
        ? "a file transfer is in progress"
        : null;
  let reason = busy();
  if (!reason) {
    const open = (await engine.artifacts()).find(
      (a) => a.state === "open" || a.state === "transferring",
    );
    reason = busy() ?? (open ? `${open.name} is ${open.state}` : null);
  }
  if (reason) throw engine.error("busy", `Python cannot sleep now: ${reason}.`);
  if (engine.shared.quiesced) throw engine.error("quiesced", "Python is already quiesced.");
  engine.shared.quiesced = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    engine.shared.quiesced = false;
  };
}

/** One cell, once its turn in the queue has come. `cell.dropped` means it was cancelled first. */
export function executeCell(
  engine: EngineInternals,
  session: WorkerSession,
  cell: { executionId: string; dropped: boolean },
  source: string,
  options: CellOptions,
): Promise<CellResult> {
  const { token, silent = false, filename } = options;
  const { executionId } = cell;
  if (cell.dropped) {
    return Promise.resolve({
      executionId,
      ...(token !== undefined ? { token } : {}),
      status: "cancelled",
      executionCount: null,
    });
  }
  return engine.whileBusy(() =>
    engine.request<CellResult>(
      "cell-reply",
      (id) => ({
        kind: "execute-cell",
        id,
        executionId,
        source,
        silent,
        storeHistory: !silent && options.storeHistory !== false,
        ...(token !== undefined ? { token } : {}),
        ...(filename !== undefined ? { filename } : {}),
      }),
      { session },
    ),
  );
}
