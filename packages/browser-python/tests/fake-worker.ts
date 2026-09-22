/**
 * A scriptable stand-in for the Python worker. The engine's job is lifecycle and correlation, and
 * none of that involves Python: whether a restart rejects what was in flight, whether a stray
 * reply can settle the wrong promise, whether a listener that throws takes the engine down. A
 * real interpreter would be slow and could not be made to send a reply for an id nobody asked
 * about. The REPL's own behaviour is covered in `browser-tests/`, against a real interpreter.
 */
import type { WorkerMessage, WorkerRequest } from "../src/protocol.js";
import type { WorkspaceStatus } from "../src/types.js";

/** The workspace a healthy fake worker reports: available, because that is the ordinary case. */
/** Distinguishes one fake worker's bytes from another's. See `BIG` below. */
let workerInstances = 0;

export const FAKE_WORKSPACE: WorkspaceStatus = {
  available: true,
  path: "/workspace",
  maxFiles: 64,
  sessionId: "fake-session",
};

export class FakeWorker implements Partial<Worker> {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readonly sent: WorkerRequest[] = [];
  terminated = 0;

  /** Set by a test to answer requests automatically. Return null to leave one hanging. */
  autoRespond: ((request: WorkerRequest) => WorkerMessage | null) | null = null;

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
    const reply = this.autoRespond?.(message);
    // Asynchronous, like a real worker: a synchronous reply would let a test pass against an
    // engine that registers its pending entry after posting, which a real one must not do.
    if (reply) queueMicrotask(() => this.emit(reply));
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** Deliver a message as if the worker had sent it. */
  emit(message: WorkerMessage): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }

  /** The id of the last request of a given kind. */
  lastId(kind: WorkerRequest["kind"]): string {
    const found = [...this.sent].reverse().find((m) => m.kind === kind);
    if (!found) throw new Error(`no ${kind} request was sent`);
    return found.id;
  }
}

/**
 * A worker that comes up cleanly and answers with plausible replies. `initOnly` answers `init` and
 * nothing else, which is what a test needs when it wants to control exactly when - and from which
 * worker - a reply arrives.
 */
export function healthyWorker({ initOnly = false } = {}): FakeWorker {
  const worker = new FakeWorker();
  // A workspace with one file in it, and STATE: a delete has to actually remove it, or a test that
  // checks "the list is empty afterwards" passes against an engine that never sent the request.
  const CONTENT = new TextEncoder().encode("time,tas\n1,2\n");
  // A second artifact, big enough to need several chunks. `resolveChunkBytes` clamps a caller's
  // chunk size up to 64 KiB, so a 13-byte fixture can only ever be one chunk - and a transfer that
  // finishes in one chunk cannot be paused part-way, which every interesting lifecycle test needs.
  // The byte pattern differs per worker instance so a test can tell WHICH worker's bytes arrived.
  const BIG_BYTES = 192 * 1024;
  const marker = ++workerInstances;
  const BIG = new Uint8Array(BIG_BYTES);
  for (let i = 0; i < BIG_BYTES; i += 1) BIG[i] = (i + marker) % 256;

  const bodyFor = (name: string): Uint8Array => (name === "big.bin" ? BIG : CONTENT);

  // Echoed on every artifact reply, exactly as the real worker does, so a test can prove a message
  // was answered by the worker it was addressed to.
  let session = "";
  let files = [
    {
      name: "out.csv",
      size: CONTENT.byteLength,
      modifiedMs: 1_000,
      generation: 1,
      state: "ready" as const,
      mime: "text/csv",
    },
    {
      name: "big.bin",
      size: BIG.byteLength,
      modifiedMs: 1_000,
      generation: 1,
      state: "ready" as const,
      mime: "application/octet-stream",
    },
  ];
  /** Open leases, so a test can prove one is released on every exit path. */
  const leases = new Map<string, { name: string; size: number; generation: number }>();
  let nextLease = 0;
  worker.autoRespond = (request) => {
    if (initOnly && request.kind !== "init") return null;
    switch (request.kind) {
      case "init":
        session = request.workerSession;
        return {
          kind: "ready",
          id: request.id,
          info: {
            profile: request.profile,
            pythonVersion: "3.14.2",
            pyodideVersion: "314.0.6",
            packages: {},
            startupMs: 1,
            workspace: FAKE_WORKSPACE,
            addons: [],
            unavailableAddons: [],
            credentialsPersisted: false,
            jspi: false,
          },
        };
      case "push":
        return {
          kind: "push-reply",
          id: request.id,
          result: { executionId: request.executionId, syntax: "complete", executed: true },
        };
      case "run":
        return {
          kind: "run-reply",
          id: request.id,
          result: { executionId: request.executionId },
        };
      case "complete":
        return { kind: "completion", id: request.id, result: { start: 0, matches: [] } };
      case "artifact-list":
        return {
          kind: "artifacts",
          id: request.id,
          artifacts: files,
          added: [],
          updated: [],
          removed: [],
        };
      case "artifact-delete": {
        const existed = files.some((file) => file.name === request.name);
        files = files.filter((file) => file.name !== request.name);
        return {
          kind: "artifacts",
          id: request.id,
          artifacts: files,
          added: [],
          updated: [],
          removed: existed ? [request.name] : [],
        };
      }
      case "artifact-read": {
        const limit = Math.min(request.maxBytes ?? CONTENT.byteLength, CONTENT.byteLength);
        return {
          kind: "artifact-data",
          id: request.id,
          name: request.name,
          mime: "text/csv",
          size: CONTENT.byteLength,
          blob: new Blob([CONTENT.slice(0, limit)], { type: "text/csv" }),
          truncated: limit < CONTENT.byteLength,
        };
      }
      case "artifact-open": {
        const file = files.find((f) => f.name === request.name);
        if (!file) {
          return {
            kind: "request-error",
            id: request.id,
            message: `There is no artifact called ${request.name} in the workspace.`,
          };
        }
        const lease = `lease-${++nextLease}`;
        leases.set(lease, { name: file.name, size: file.size, generation: file.generation });
        return {
          kind: "artifact-lease",
          id: request.id,
          workerSession: session,
          lease,
          name: file.name,
          size: file.size,
          mime: file.mime,
          generation: file.generation,
        };
      }
      case "artifact-chunk": {
        const held = leases.get(request.lease);
        if (!held) {
          return {
            kind: "request-error",
            id: request.id,
            message: "This transfer has already finished or was cancelled.",
          };
        }
        const end = Math.min(held.size, request.offset + request.length);
        const slice = bodyFor(held.name).slice(request.offset, end);
        return {
          kind: "artifact-chunk-data",
          id: request.id,
          workerSession: session,
          lease: request.lease,
          offset: request.offset,
          bytes: slice.buffer as ArrayBuffer,
          generation: files.find((f) => f.name === held.name)?.generation ?? 1,
          eof: end >= held.size,
        };
      }
      case "artifact-close":
        leases.delete(request.lease);
        return { kind: "ack", id: request.id };
      case "interrupt":
        // Nothing runs in the fake, so there is never anything to interrupt. The reply shape is
        // what matters here: the engine settles `interrupt-reply` on its own kind, and a stray
        // `ack` must not resolve it.
        return { kind: "interrupt-reply", id: request.id, requested: false };
      case "clear-buffer":
      case "dispose":
        return { kind: "ack", id: request.id };
    }
  };
  /** How many leases the worker still holds - a transfer that leaks one freezes an artifact. */
  Object.defineProperty(worker, "openLeases", { get: () => leases.size });
  /** The byte marker this worker stamps into `big.bin`, so a test can tell whose bytes arrived. */
  Object.defineProperty(worker, "marker", { get: () => marker });
  return worker;
}
