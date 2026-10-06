// engine-internals.ts - what the engine lends `engine-sessions.ts`: narrow, typed access to its
// queue, its request table and its counters, so session operations can live in a module that is
// loaded only when one is used. Types only; nothing here is public API.

import type { WorkerMessage, WorkerRequest } from "./protocol.js";
import type { ArtifactInfo, BrowserPythonState, SessionResources } from "./types.js";

/**
 * One Worker instance, and everything that identifies it. A transfer captures the session it
 * opened its lease in; when the session is replaced `alive` goes false and the transfer fails
 * rather than running on against a Worker that has reissued that lease id to somebody else.
 */
export interface WorkerSession {
  readonly id: string;
  readonly generation: number;
  readonly worker: Worker;
  alive: boolean;
  /** Aborted when the session ends (restart, dispose or a fatal error). */
  readonly ended: AbortSignal;
}

/** Plain state the engine and `engine-sessions.ts` both read and write. */
export interface EngineShared {
  /** Workspace imports in progress. */
  imports: number;
  /** Set while a checkpoint holds the engine. */
  quiesced: boolean;
  startupMs?: number | undefined;
  timeToUsableMs?: number | undefined;
  /** The last resource sample, and the one being taken. */
  sample: SessionResources | null;
  sampling: Promise<SessionResources> | null;
}

export interface EngineInternals {
  submit<T>(work: (session: WorkerSession, release: () => void) => Promise<T>): Promise<T>;
  request<T>(
    expect: WorkerMessage["kind"],
    build: (id: string) => WorkerRequest,
    options?: { timeoutMs?: number; session?: WorkerSession; transfer?: Transferable[] },
  ): Promise<T>;
  session(): WorkerSession | null;
  state(): BrowserPythonState;
  artifacts(): Promise<readonly ArtifactInfo[]>;
  whileBusy<T>(work: () => Promise<T>): Promise<T>;
  /** Executions running or queued. */
  executions(): number;
  /** Downloads in progress (imports are `shared.imports`). */
  transfers(): number;
  shared: EngineShared;
  /** `aborted`: an `ArtifactTransferAborted`; otherwise a `BrowserPythonError` with that code. */
  error(kind: "aborted" | "busy" | "quiesced" | "restarted", message?: string): Error;
}
