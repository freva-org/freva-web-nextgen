// browser-python.ts - the main-thread engine. Owns the state machine, a table of in-flight
// requests keyed by id, and the worker's lifetime; no Python, no Pyodide and no knowledge of what
// a profile installs, which is the worker's side of `protocol.ts`. Requests live in a TABLE rather
// than one `pendingResolve` field, and restart, dispose, fatal and worker death each walk it whole.

import {
  ArtifactTransferAborted,
  SINK_CLEANUP_TIMEOUT_MS,
  TRANSFER_MEMORY_BUDGET_BYTES,
  resolveChunkBytes,
  resolveWindow,
  attachCleanupDiagnostics,
  toSink,
  validateChunk,
  type ArtifactSink,
  type ArtifactStreamOptions,
} from "./artifact-stream.js";
import { supportsOptional } from "./addons.js";
import {
  PROTOCOL_VERSION,
  createIdFactory,
  validateDisplay,
  type ArtifactChunkMessage,
  type ArtifactLeaseMessage,
  type WorkerMessage,
  type WorkerRequest,
} from "./protocol.js";
import {
  BrowserPythonError,
  type ArtifactData,
  type ArtifactInfo,
  type ArtifactsEvent,
  type ArtifactsListener,
  type ArtifactStreamResult,
  type StorageEvent,
  type StorageListener,
  type BrowserPython,
  type BrowserPythonOptions,
  type BrowserPythonProfile,
  type BrowserPythonReadyInfo,
  type BrowserPythonState,
  type CompletionResult,
  type ExecutionResult,
  type OutputEvent,
  type OutputListener,
  type PushResult,
  type StatusListener,
  type Unsubscribe,
  type WorkspaceStatus,
  MAX_WORKSPACE_FILES,
} from "./types.js";

/**
 * The pinned runtime: a version, never `latest`. A moving URL lets whoever last published to the
 * CDN change Python's version, the wheel set and the console API under a portal that changed
 * nothing. Upgrading is a deliberate edit here plus a test run.
 *
 * IT DOES NOT COMPOSE WITH THE DEFAULT POLICY, on purpose. `contentSecurityPolicy()` with no
 * arguments is `script-src 'self'` and `connect-src 'self'`, which blocks this URL: a security
 * helper that shipped a CDN in its own default allowlist would be widening a policy nobody asked
 * it to widen. Pass `runtimeOrigin` to allow this CDN, or self-host the runtime - which is the
 * production answer, because this is a dynamic import by URL, so pinning the URL is all the
 * integrity there is. Subresource integrity does not apply to it.
 */
export const DEFAULT_PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.6/full/";

const DEFAULT_START_TIMEOUT_MS = 180_000;

/**
 * The owner a caller that does not name itself gets. All anonymous pushes share it, so the check
 * only ever fires when two DIFFERENT owners are involved.
 */
const ANONYMOUS_OWNER = "\u0000anonymous";

/**
 * How long `disposeAsync()` waits for the worker to tidy up before terminating it anyway: long
 * enough to close a few dozen OPFS handles and remove a directory, short enough that a page
 * unloading does not appear to hang. A worker inside a long Python call never answers at all.
 */
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;

type Pending = {
  resolve: (value: never) => void;
  reject: (error: unknown) => void;
  /** Which reply kind settles this. A mismatched reply is a protocol error, not a silent resolve. */
  expect: WorkerMessage["kind"];
  /** The Worker generation this request was sent to. A reply from any other cannot settle it. */
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * One Worker instance, and everything that identifies it. A transfer captures the session it
 * opened its lease in; when the session is replaced `alive` goes false and the transfer fails
 * rather than running on against a Worker that has reissued that lease id to somebody else.
 */
interface WorkerSession {
  readonly id: string;
  readonly generation: number;
  readonly worker: Worker;
  alive: boolean;
}

/** A transfer the engine can reach into and stop, from outside its own promise chain. */
interface LiveTransfer {
  readonly session: WorkerSession;
  cancel(error: unknown): void;
}

class BrowserPythonEngine implements BrowserPython {
  #state: BrowserPythonState = "idle";
  #worker: Worker | null = null;
  #pending = new Map<string, Pending>();
  #statusListeners = new Set<StatusListener>();
  #outputListeners = new Set<OutputListener>();
  #artifactListeners = new Set<ArtifactsListener>();
  #storageListeners = new Set<StorageListener>();
  // Mirrors the `ready` answer and is withdrawn by a `storage` message. Kept on the engine rather
  // than in the resolved `ready` info because the answer can change and a resolved object cannot.
  #credentialsPersisted = false;
  #workspace: WorkspaceStatus | null = null;
  #nextId = createIdFactory("req");
  #nextExecutionId = createIdFactory("exec");
  #startPromise: Promise<BrowserPythonReadyInfo> | null = null;
  /** Executions in flight. See `#whileBusy`. */
  #busyCount = 0;
  /** Who is part-way through a multi-line statement, if anyone. See `push`. */
  #continuationOwner: string | null = null;
  /**
   * ONE queue for every submission that changes the interpreter's state. See `#submit`. Separate
   * channels race: `push("x = 1"); run("print(x)")` reaches the Worker in the opposite order,
   * because the push spends a microtask hop in the chain that the run does not.
   */
  #submissions: Promise<void> = Promise.resolve();
  /**
   * Bumped on every worker replacement. A message from a terminated worker that was already queued
   * in the event loop must not be able to resolve a request belonging to its successor.
   */
  #generation = 0;
  /** The live Worker session, or null between one and the next. */
  #session: WorkerSession | null = null;
  /**
   * Transfers currently running. One stalled inside `sink.write()` has no pending request, so
   * rejecting the request table does not reach it and a restart would leave it writing into a
   * destination the caller believes is finished. Restart and dispose walk this set.
   */
  #transfers = new Set<LiveTransfer>();
  /** Bytes currently reserved by running transfers. See `#reserveTransfer`. */
  #reservedBytes = 0;

  readonly #options: Required<
    Pick<BrowserPythonOptions, "profile" | "packages" | "addons" | "optionalAddons">
  > & {
    indexURL: string;
    addonBaseURL?: string;
    packageBaseURL?: string;
    wheelhouseURL?: string;
    startupSource?: string;
    persistCredentials?: boolean;
    workerFactory: () => Worker;
    startTimeoutMs: number;
    workspaceMaxFiles?: number;
  };

  constructor(options: BrowserPythonOptions = {}) {
    const indexURL = options.pyodide?.indexURL ?? DEFAULT_PYODIDE_INDEX_URL;
    this.#options = {
      profile: options.profile ?? "minimal",
      packages: options.packages ?? [],
      // Deduplicated and sorted at the boundary. The worker installs in the registry's own order
      // regardless, so a caller's order or a repeated entry could only change a diagnostic - and
      // two identical configurations that print differently are two bug reports about one engine.
      addons: [...new Set(options.addons ?? [])].sort(),
      optionalAddons: [...new Set(options.optionalAddons ?? [])].sort(),
      indexURL: absoluteURL(indexURL, { trailingSlash: true }),
      workerFactory: resolveWorkerFactory(options),
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    };
    if (options.pyodide?.packageBaseURL !== undefined) {
      this.#options.packageBaseURL = absoluteURL(options.pyodide.packageBaseURL, {
        trailingSlash: true,
      });
    }
    if (options.wheelhouseURL !== undefined) {
      this.#options.wheelhouseURL = absoluteURL(options.wheelhouseURL, { trailingSlash: true });
    }
    if (options.startupSource !== undefined) {
      this.#options.startupSource = options.startupSource;
    }
    if (options.addonBaseURL !== undefined) {
      this.#options.addonBaseURL = absoluteURL(options.addonBaseURL, { trailingSlash: true });
    }
    if (options.persistCredentials !== undefined) {
      this.#options.persistCredentials = options.persistCredentials;
    }
    if (options.workspaceMaxFiles !== undefined) {
      // Validated HERE, at construction, not only in the worker. The worker reports a bad value
      // as an unavailable workspace, which is right over a message boundary and poor for a typo:
      // everything comes up and file output has quietly gone away. `NaN` or `-1` is a host's
      // mistake it can fix, so it is told immediately.
      if (
        !Number.isSafeInteger(options.workspaceMaxFiles) ||
        options.workspaceMaxFiles < 1 ||
        options.workspaceMaxFiles > MAX_WORKSPACE_FILES
      ) {
        throw new RangeError(
          `workspaceMaxFiles must be a whole number between 1 and ${MAX_WORKSPACE_FILES}, not ` +
            `${String(options.workspaceMaxFiles)}.`,
        );
      }
      this.#options.workspaceMaxFiles = options.workspaceMaxFiles;
    }
    // OPTIONAL ADD-ONS, checked here rather than only in the worker: both are typos a host can
    // fix that would otherwise surface as a start failure after a runtime download. A caller who
    // asked for best-effort Dask must not have it silently made required.
    for (const id of this.#options.optionalAddons) {
      if (!this.#options.addons.includes(id)) {
        throw new RangeError(
          `'${id}' is in optionalAddons but not in addons. An optional add-on is one of the ` +
            `configured add-ons whose absence is tolerable, not a separate list of extras.`,
        );
      }
      if (!supportsOptional(id)) {
        throw new RangeError(
          `The '${id}' add-on cannot be optional: it installs wheels into the interpreter, so a ` +
            `failure part-way through would leave a session holding some of its dependencies and ` +
            `not the capability. It is required or absent, never best-effort.`,
        );
      }
    }
  }

  get state(): BrowserPythonState {
    return this.#state;
  }

  /**
   * What `start()` reported about storage, or null before it resolved. Whether Python's file
   * output reaches disk is a property of the visitor's browser, and a UI offering a download for
   * a file living in the WASM heap promises something the tab may not survive.
   */
  get workspace(): WorkspaceStatus | null {
    return this.#workspace;
  }

  onStatus(listener: StatusListener): Unsubscribe {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onOutput(listener: OutputListener): Unsubscribe {
    this.#outputListeners.add(listener);
    return () => this.#outputListeners.delete(listener);
  }

  onArtifacts(listener: ArtifactsListener): Unsubscribe {
    this.#artifactListeners.add(listener);
    return () => this.#artifactListeners.delete(listener);
  }

  get credentialsPersisted(): boolean {
    return this.#credentialsPersisted;
  }

  onStorage(listener: StorageListener): Unsubscribe {
    this.#storageListeners.add(listener);
    return () => this.#storageListeners.delete(listener);
  }

  start(): Promise<BrowserPythonReadyInfo> {
    if (this.#state === "disposed") {
      return Promise.reject(new BrowserPythonError("disposed", "This engine was disposed."));
    }
    // Idempotent on purpose: a page with three components that each call `start()` should get one
    // interpreter and one download, not three.
    if (this.#startPromise) return this.#startPromise;
    // The attempt is created, THEN adopted, and only ever cleared by itself. `#boot()` runs
    // synchronously as far as its first await, so a `workerFactory` that throws - a CSP forbidding
    // the Worker URL, a bundler that emitted no asset - throws in that window, and assigning the
    // rejected promise over the `null` `#failStart` set would memoise the failure for good.
    return this.#adopt(this.#boot());
  }

  /**
   * Queue one state-mutating submission, bound to the interpreter it was written against.
   *
   * ORDER: the Worker executes what it is sent in the order it is sent, so `push`, `run` and
   * `clearBuffer` all come through here. SESSION: captured synchronously before the first
   * `await`, because every later await is a suspension point a `restart()` can land in and a
   * submission must never be retargeted at the REPLACEMENT interpreter; it is rejected instead.
   * `null` at capture time means the engine has not started yet, which is legitimate.
   */
  #submit<T>(work: (session: WorkerSession, release: () => void) => Promise<T>): Promise<T> {
    const captured = this.#session;
    // When the NEXT submission may be posted. A posted submission has already taken its place in
    // the program, so `run()` releases as soon as its request is on the wire. `push()` and
    // `clearBuffer()` do not, because both decide something the next submission has to see: a
    // push's ownership transition is known only from its reply, a clear only once acknowledged.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const attempt = this.#submissions.then(async () => {
      // A fatal clears the start promise, so `#requireReady()` would tell a queued submission to
      // "call start() before running Python" - untrue, since what it needs is a restart. The
      // state says which happened, so a queued caller gets the same answer as one in flight.
      if (this.#currentState() === "error") {
        throw new BrowserPythonError(
          "worker-failed",
          "The interpreter failed while this was waiting to run, so it did not run. Call " +
            "restart() to bring up a fresh one.",
        );
      }
      await this.#requireReady();
      const session = captured ?? this.#session;
      if (!session || !session.alive || session !== this.#session) {
        throw new BrowserPythonError(
          "restarted",
          "The interpreter was replaced before this line ran, so it was not run. The command " +
            "belonged to the previous interpreter and running it in the new one would not be the " +
            "same thing. Submit it again if you still want it.",
        );
      }
      return work(session, release);
    });
    // Whichever comes first, and never a rejection: a chain that broke on one refused submission
    // would deadlock every later one.
    this.#submissions = Promise.race([
      attempt.then(
        () => undefined,
        () => undefined,
      ),
      released,
    ]);
    return attempt;
  }

  async push(line: string, options: { owner?: string } = {}): Promise<PushResult> {
    const owner = options.owner ?? ANONYMOUS_OWNER;
    // ONE line buffer, and whoever is mid-statement owns it: several components share one engine
    // and `PyodideConsole` has a single buffer, so a line pushed from a second console would be
    // appended to the first's half-written function. The check and the transition are one
    // decision, both inside the submission below, because testing the owner before posting and
    // setting it after the reply leaves a window a round trip wide that two racing pushes pass.
    return this.#submit(async (session) => {
      if (this.#continuationOwner !== null && this.#continuationOwner !== owner) {
        throw new BrowserPythonError(
          "protocol",
          "Another console is part-way through a multi-line statement on this interpreter, and " +
            "there is only one input buffer. Finish that statement, or call clearBuffer(), before " +
            "typing here.",
        );
      }
      const executionId = this.#nextExecutionId();
      const result = await this.#whileBusy(() =>
        this.#request<PushResult>("push-reply", (id) => ({ kind: "push", id, executionId, line }), {
          session,
        }),
      );
      this.#continuationOwner = result.syntax === "incomplete" ? owner : null;
      return result;
    });
  }

  /**
   * Run a whole block. A separate channel from `push()` on the Python side too: `run` compiles and
   * executes the source on its own and never touches the console's line buffer. Same queue,
   * though - both change the same interpreter and their ORDER is the program.
   */
  async run(code: string): Promise<ExecutionResult> {
    return this.#submit(async (session, release) => {
      const executionId = this.#nextExecutionId();
      return this.#whileBusy(() => {
        const reply = this.#request<ExecutionResult>(
          "run-reply",
          (id) => ({ kind: "run", id, executionId, code }),
          { session },
        );
        // On the wire, and therefore already ahead of whatever is submitted next: the queue can
        // let the next one through without waiting for this block to finish executing.
        release();
        return reply;
      });
    });
  }

  /**
   * Close one lease, in the session that issued it, without waiting for the acknowledgement: the
   * Worker may be wedged and no engine state depends on the ack. Only ever in the ORIGINAL
   * session - a close sent to whatever Worker is current would free somebody else's lease.
   */
  #closeLease(session: WorkerSession, lease: string, reason: "done" | "failed"): void {
    if (!session.alive || session !== this.#session) return;
    this.#request<void>(
      "ack",
      (id) => ({ kind: "artifact-close", id, workerSession: session.id, lease, reason }),
      { session },
    ).catch(() => undefined);
  }

  /**
   * Run one execution with the engine in `busy`, and put it back afterwards; the console's
   * "Running" label depends on this setting it. Counted rather than a boolean, because `push` and
   * `complete` can overlap in the queue and the first to finish must not report the engine idle.
   * Restored only if the state is still `busy` - a fatal or a dispose has had the last word.
   */
  async #whileBusy<T>(work: () => Promise<T>): Promise<T> {
    this.#busyCount += 1;
    if (this.#busyCount === 1 && this.#state === "ready") this.#setState("busy");
    try {
      return await work();
    } finally {
      this.#busyCount = Math.max(0, this.#busyCount - 1);
      if (this.#busyCount === 0 && this.#state === "busy") this.#setState("ready");
    }
  }

  /**
   * What the interpreter would offer as completions - an OBSERVATION, taken in order. It changes
   * no interpreter state, but an observation of a moving target has to be taken at a defined point
   * in the sequence: `push("variable = 1")` then `complete("vari")` arriving as `complete, push`
   * computes against a namespace without `variable` in it. It RELEASES the queue as soon as it is
   * posted, so an autocomplete popup cannot delay the next line the user runs.
   */
  // `cursor` and the returned `start` are UTF-16 offsets. See `CompletionResult`.
  async complete(source: string, cursor?: number): Promise<CompletionResult> {
    return this.#submit(async (session, release) => {
      const reply = this.#request<CompletionResult>(
        "completion",
        (id) => ({ kind: "complete", id, source, cursor: cursor ?? source.length }),
        { session },
      );
      release();
      return reply;
    });
  }

  /**
   * Throw away whatever half-written statement is in the interpreter's line buffer. Queued with
   * the submissions because it changes the same state they do: a clear that overtook the push in
   * front of it would discard a line the caller had already been told was accepted.
   */
  async clearBuffer(): Promise<void> {
    return this.#submit(async (session) => {
      await this.#request<void>("ack", (id) => ({ kind: "clear-buffer", id }), { session });
      // The buffer is gone, so nobody owns it. This is the documented way out of a continuation
      // whose owner has been closed, unmounted or navigated away from.
      this.#continuationOwner = null;
    });
  }

  /**
   * Ctrl+C: ask the interpreter to abandon whatever it is running.
   *
   * THE ONE THING HERE THAT DOES NOT GO THROUGH `#submit`, because an interrupt changes no
   * namespace and queued behind the execution it is aimed at would arrive only once that
   * execution had ended by itself. It IS bound to a session. `true` means a cancellation was
   * recorded, NOT that anything has stopped: Python delivers it at the next suspension point, a
   * loop with none never reaches one, and `restart()` is what stops that.
   */
  async interrupt(): Promise<boolean> {
    const session = this.#session;
    if (!session || !session.alive || this.#state === "disposed") return false;
    return this.#request<boolean>("interrupt-reply", (id) => ({ kind: "interrupt", id }), {
      session,
    });
  }

  /**
   * One artifact operation, bound to the interpreter it was asked of and taking its turn.
   *
   * THE SHARED RULE for `artifacts()`, `readArtifact()`, `deleteArtifact()` and `streamArtifact()`:
   * the synchronously captured session stops a restart in the readiness await from answering out
   * of the REPLACEMENT interpreter, and the queue stops `push("create_file()"); artifacts()`
   * asking for the listing before the file exists. `hold` is what differs - a LIST or a READ
   * observes state and releases the queue on posting, while a DELETE changes state and code after
   * it may assume the file is gone, which is only true once the worker has said so.
   */
  #artifactOperation<T>(
    expect: WorkerMessage["kind"],
    build: (id: string) => WorkerRequest,
    { hold }: { hold: boolean },
  ): Promise<T> {
    return this.#submit(async (session, release) => {
      const reply = this.#request<T>(expect, build, { session });
      if (!hold) release();
      return reply;
    });
  }

  async artifacts(): Promise<readonly ArtifactInfo[]> {
    const event = await this.#artifactOperation<ArtifactsEvent>(
      "artifacts",
      (id) => ({ kind: "artifact-list", id }),
      { hold: false },
    );
    return event.artifacts;
  }

  async readArtifact(name: string, options: { maxBytes?: number } = {}): Promise<ArtifactData> {
    if (options.maxBytes !== undefined) {
      // Checked before the round trip. `maxBytes: NaN` would otherwise travel to the worker, fail
      // a comparison there, and come back as a generic request error naming nothing useful.
      if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
        throw new RangeError(
          `maxBytes must be a non-negative whole number, not ${String(options.maxBytes)}.`,
        );
      }
    }
    return this.#artifactOperation<ArtifactData>(
      "artifact-data",
      (id) => ({
        kind: "artifact-read",
        id,
        name,
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      }),
      { hold: false },
    );
  }

  /**
   * Stream one artifact to a destination, a chunk at a time. The transfer is pulled - a chunk is
   * requested, written, and only then is the next asked for - so at most `windowChunks` chunks
   * exist outside the worker at once; `readArtifact` instead builds the whole file as a `Blob`,
   * is capped at `MAX_BLOB_BYTES` and is for previews.
   *
   * Three load-bearing properties, each with its own test. IT BELONGS TO ONE WORKER: the session
   * is captured when the lease is opened, and since lease ids are a per-Worker counter a
   * replacement issues `lease-1` too. EVERY REPLY IS CHECKED: `validateChunk` confirms session,
   * lease, artifact generation, offset, length and `eof` before a byte reaches the destination.
   * THE DESTINATION IS LEFT UNAMBIGUOUS: exactly one of close and abort happens, exactly once,
   * and a writer's lock is released on every path.
   */
  async streamArtifact(
    name: string,
    destination: ArtifactSink | WritableStream<Uint8Array>,
    options: ArtifactStreamOptions = {},
  ): Promise<{ bytesWritten: number; name: string; mime: string }> {
    // THE DESTINATION IS ADOPTED FIRST, and the engine owns it from here: a failure before
    // adoption - a budget refusal, a missing artifact, a file still open in Python - would leave
    // the caller holding an open `FileSystemWritableFileStream` with no way to know it needed
    // closing. `toSink` itself can throw, and that case has acquired nothing.
    //
    // THE SESSION IS CAPTURED HERE, before `toSink` and before ANY caller-controlled code runs,
    // because `toSink(destination)` calls `destination.getWriter()`, which may do anything -
    // including `restart()`, after which the transfer would adopt the replacement and SUCCEED
    // against an interpreter the caller never addressed. `null` means the engine has not started
    // and is refused: a download names a file in a workspace that does not exist yet.
    const session = this.#session;

    let sink: ArtifactSink;
    try {
      sink = toSink(destination);
    } catch (error) {
      throw new BrowserPythonError(
        "protocol",
        `${name} cannot be downloaded to that destination: its writer could not be acquired, ` +
          `which usually means the stream is already locked by something else.`,
        { cause: error },
      );
    }

    /** Unwound in reverse on every exit, so a partial acquisition is not a leak. */
    const unwind: Array<() => void> = [];
    const cleanupMs = options.cleanupTimeoutMs ?? SINK_CLEANUP_TIMEOUT_MS;
    /** Cleanup faults, kept and reported rather than swallowed. See the unwind loop. */
    const cleanupErrors: unknown[] = [];
    // Lease ownership, explicit rather than timed. `handedOff` is set before the first cleanup
    // step runs, so a granted lease is never ownerless: before it, the unwind closes whatever
    // `claimLease` recorded; after it, `claimLease` closes at once. `releaseLease` is idempotent,
    // so both arriving is harmless and neither arriving is impossible.
    let leaseToClose: string | null = null;
    let leaseClosed = false;
    let handedOff = false;
    let finished = false;
    /** The successful result, if there is one, so cleanup faults can be attached to it. */
    let outcome: ArtifactStreamResult | null = null;

    // FAILED is a boolean; WHY is data, `null` included - `failure ??= error` would read a `null`
    // rejection as "nothing wrong yet" and let the next fault overwrite it. Set once, by whoever
    // ends the transfer first: close and abort are mutually exclusive.
    let hasFailure = false;
    let failure: unknown;
    // The interrupt. A flag read between awaits cannot stop an await that never returns, and
    // every await here is one somebody else controls, so each registers a waiter that `fail()`
    // rejects and the public promise settles when the CALLER asked. A SET OF WAITERS, not
    // `Promise.race([work, stopped])`: that attaches a reaction living as long as `stopped`,
    // which retains the derived promise and its resolved value, here a four-megabyte chunk -
    // `workspace-stream.mjs` measured 12 MiB of growth become 56 MiB on a 96 MiB file.
    const waiters = new Set<(error: unknown) => void>();
    // Once `close()` has begun the transfer is COMMITTING and cancellation no longer applies:
    // every byte is written, and aborting would leave a complete file reported as cancelled, or
    // call `abort()` on a closing stream and replace a real outcome with a `TypeError`. A
    // cancellation here is ignored and `onProgress` announces the `finishing` phase so a UI can
    // disable Cancel. A close that FAILS is still a failure: this ignores cancellation, not errors.
    let committing = false;
    const isCancellation = (error: unknown): boolean =>
      error instanceof ArtifactTransferAborted ||
      (error instanceof BrowserPythonError && error.code === "restarted");
    const fail = (error: unknown): void => {
      if (committing && isCancellation(error)) return;
      if (!hasFailure) {
        hasFailure = true;
        failure = error;
      }
      const listening = [...waiters];
      waiters.clear();
      for (const waiter of listening) waiter(failure);
    };

    /** Await something the engine does not control, but never past a cancellation. */
    /** Record a lease that was granted. Closes it at once if cleanup has already begun. */
    const claimLease = (lease: string): void => {
      leaseToClose = lease;
      if (handedOff) releaseLease();
    };
    /** Close the lease, at most once, and only ever in the session that issued it. */
    const releaseLease = (): void => {
      if (leaseClosed || leaseToClose === null || !session) return;
      leaseClosed = true;
      this.#closeLease(session, leaseToClose, finished ? "done" : "failed");
    };

    const race = <T>(work: Promise<T>): Promise<T> => {
      // The loser can still reject later; that rejection is expected and must not go global.
      work.catch(() => undefined);
      if (hasFailure) return Promise.reject(failure);
      return new Promise<T>((resolve, reject) => {
        const waiter = (error: unknown): void => reject(error);
        waiters.add(waiter);
        work.then(
          (value) => {
            waiters.delete(waiter);
            resolve(value);
          },
          (error: unknown) => {
            waiters.delete(waiter);
            reject(error);
          },
        );
      });
    };

    /**
     * Close or abort the destination, at most once, and never for longer than `cleanupTimeoutMs`.
     * ONCE, because both are terminal and a destination asked for the second may throw, replacing
     * a clean failure with a `TypeError`. BOUNDED, because a `FileSystemWritableFileStream` whose
     * disk has gone away leaves `close()` pending forever, and with it the lease and the budget.
     */
    let settled = false;
    const finish = async (kind: "close" | "abort"): Promise<void> => {
      if (settled) return;
      settled = true;
      const work = Promise.resolve(kind === "close" ? sink.close() : sink.abort(failure));
      work.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BrowserPythonError(
                "timeout",
                `The download destination's ${kind}() did not return within ${cleanupMs}ms, so ` +
                  `${name} was given up on rather than left holding the interpreter.`,
              ),
            ),
          cleanupMs,
        );
      });
      limit.catch(() => undefined);
      try {
        await Promise.race([work, limit]);
      } finally {
        clearTimeout(timer);
      }
    };

    // Cancellation is installed FIRST, before readiness and before anything is acquired.
    // Installed after `await this.#requireReady()`, an abort during startup has nothing
    // listening: with a Worker that never answers `init`, `streamArtifact()` stays pending until
    // the 180-second startup timeout, holding a destination the caller has given up on.
    const onAbort = (): void => fail(new ArtifactTransferAborted());
    if (options.signal) {
      if (options.signal.aborted) fail(new ArtifactTransferAborted());
      options.signal.addEventListener("abort", onAbort);
      unwind.push(() => options.signal?.removeEventListener("abort", onAbort));
    }

    try {
      if (!session) {
        throw new BrowserPythonError(
          "not-started",
          `${name} cannot be downloaded yet: this engine has no running interpreter. Await ` +
            `start() before asking for a file, so the download belongs to a workspace that exists.`,
        );
      }
      const live: LiveTransfer = { session, cancel: (error) => fail(error) };
      this.#transfers.add(live);
      unwind.push(() => this.#transfers.delete(live));

      const chunkBytes = resolveChunkBytes(options.chunkBytes);
      const window = resolveWindow(options.windowChunks);

      // ACQUISITION GOES THROUGH THE SUBMISSION QUEUE, the delivery does not. A download reads a
      // file the lines before it may have just written, so opening it takes its turn behind them;
      // the transfer itself must not, since a 96 MiB download holding the queue would block every
      // later line. The queue is released the moment the lease request is on the wire. The
      // acquisition is raced against cancellation, and when cancellation wins it carries on in
      // the background and hands whatever it obtained to the cleanup - see `claimLease`.
      const reservation = this.#reserveTransfer(chunkBytes * window);
      unwind.push(() => reservation.release());
      // Registered BEFORE the lease is asked for: pushed only after a successful acquisition, a
      // transfer cancelled while `artifact-open` was in flight would unwind without a lease step
      // and the reply, recorded by `claimLease`, would then be owned by nobody.
      unwind.push(() => releaseLease());

      if (hasFailure) throw failure;

      const acquisition = this.#submit(async (queued, release) => {
        if (queued !== session) {
          throw new BrowserPythonError(
            "restarted",
            "The interpreter was replaced before this download started, so it was not started. " +
              "The file belonged to the previous interpreter's workspace; the replacement's " +
              "copy, if it has one, is a different file.",
          );
        }
        const request = this.#request<ArtifactLeaseMessage>(
          "artifact-lease",
          (id) => ({ kind: "artifact-open", id, name, workerSession: session.id }),
          { session },
        );
        // On the wire and addressed to the right Worker: later work may go out behind it.
        release();
        const opened = await request;
        claimLease(opened.lease);
        return opened;
      });
      // EXACTLY ONE OWNER for a lease that was actually granted. Ownership is explicit rather
      // than timed: `claimLease` records the lease, `releaseLease` closes it at most once, and
      // `handedOff` is set BEFORE any cleanup begins, so whichever arrives second does the
      // closing. A timed handover leaks the lease when a reply lands during `abort()`.
      acquisition.catch(() => undefined);
      const lease = await race(acquisition);
      if (lease.workerSession !== session.id) {
        throw new BrowserPythonError(
          "protocol",
          `The worker answered a lease for session ${lease.workerSession}, not ${session.id}.`,
        );
      }
      // The lease is only ever closed in the session that issued it: when a session is gone its
      // leases went with it, and a close sent to whatever Worker is current now would free
      // somebody else's lease. The unwind step registered above owns closing it.

      /** Every chunk request in flight. Each carries a rejection handler from the moment it exists. */
      const inFlight: Array<Promise<ArtifactChunkMessage>> = [];
      let written = 0;
      let requested = 0;

      const stop = (): void => {
        if (options.signal?.aborted) fail(new ArtifactTransferAborted());
        if (!session.alive || session !== this.#session) {
          fail(
            new BrowserPythonError(
              "restarted",
              "The interpreter was replaced while this download was in progress, so it was " +
                "stopped rather than continued against a different one.",
            ),
          );
        }
      };

      const requestChunk = (offset: number): void => {
        const length = Math.min(chunkBytes, lease.size - offset);
        const pending = this.#request<ArtifactChunkMessage>(
          "artifact-chunk-data",
          (id) => ({
            kind: "artifact-chunk",
            id,
            workerSession: session.id,
            lease: lease.lease,
            offset,
            length,
          }),
          { session },
        ).then((chunk) => {
          validateChunk(chunk, { session: session.id, lease, offset, length });
          return chunk;
        });
        // The handler goes on NOW, not in `finally`. A window of three means two more requests
        // are in the air while the first write happens, and if the second is refused during that
        // write nothing is awaiting it yet: a `finally` that has not run cannot have attached
        // anything, so the rejection reaches the host as a global `unhandledrejection`.
        pending.catch(() => undefined);
        inFlight.push(pending);
        requested = offset + length;
      };

      try {
        stop();
        if (hasFailure) throw failure;
        while (requested < lease.size && inFlight.length < window) requestChunk(requested);

        while (inFlight.length > 0) {
          const next = inFlight.shift();
          if (!next) break;
          const chunk = await race(next);
          stop();
          if (hasFailure) throw failure;

          const bytes = new Uint8Array(chunk.bytes);
          if (chunk.offset !== written) {
            throw new BrowserPythonError(
              "protocol",
              `The worker sent bytes ${chunk.offset}… while ${written} had been written: a gap ` +
                `or an overlap, either of which would corrupt the file.`,
            );
          }
          // `Promise.resolve` because a sink may be synchronous: the contract allows it.
          await race(Promise.resolve(sink.write(bytes)));
          written += bytes.byteLength;
          options.onProgress?.({ transferred: written, total: lease.size, phase: "transferring" });
          // Checked AFTER the write too: a cancellation that lands during the final write must
          // abort, not close and report success.
          stop();
          if (hasFailure) throw failure;
          if (requested < lease.size) requestChunk(requested);
        }

        if (written !== lease.size) {
          throw new BrowserPythonError(
            "worker-failed",
            `${name} stopped after ${written} of ${lease.size} bytes. The download is ` +
              `incomplete and has not been finished.`,
          );
        }
        // From here the transfer is COMMITTING: all the bytes are written and only the
        // destination's own close remains. Announced, so a UI can stop offering a Cancel that
        // would no longer do anything - see `fail()`.
        committing = true;
        options.onProgress?.({ transferred: written, total: lease.size, phase: "finishing" });
        // A close that fails or times out means the file was NOT finished, whatever was written.
        await finish("close");
        finished = true;
        outcome = { bytesWritten: written, name: lease.name, mime: lease.mime };
        return outcome;
      } catch (error) {
        fail(error);
        throw failure;
      }
    } catch (error) {
      // ONE catch for the whole method, which is the point of adopting the destination first: a
      // failed lease, a budget refusal or an absent worker all happen after the engine has taken
      // ownership, and all must leave it aborted rather than open. A destination closed after a
      // failure looks finished, which on a real filesystem is a truncated file wearing the name.
      fail(error);
      try {
        await finish("abort");
      } catch (abortError) {
        // KEPT, not swallowed. It must not REPLACE the cause - `failure` is already set and is
        // what is thrown - but a destination whose `abort()` throws is left in an unknown state,
        // exactly as a `release()` that throws is, and a host debugging a stuck stream needs both.
        cleanupErrors.push(abortError);
      }
      throw failure;
    } finally {
      // EVERY cleanup step runs, whatever any other one does. `sink.release?.()` is one unwind
      // step like the others rather than an unguarded call outside the loop: a destination whose
      // release threw would otherwise take the lease close and the memory reservation with it, so
      // four such transfers leave four frozen artifacts and 32 MiB of budget spoken for. A cleanup
      // fault never becomes the transfer's outcome but is reported on `cleanupErrors`.
      // `handedOff` is set BEFORE the first cleanup step, so a lease reply arriving during
      // `abort()` has an owner instead of falling between the unwind and a flag not yet set.
      handedOff = true;
      unwind.push(() => sink.release?.());
      for (const step of unwind.reverse()) {
        try {
          step();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        // ANY Error, not only a `BrowserPythonError`: the failure a transfer reports is often the
        // destination's own - a `TypeError` from a closed stream, a `DOMException` from a
        // `FileSystemWritableFileStream` - which is exactly when a failing `release()` matters.
        // Safe: a throwing `finally` would replace the failure being reported.
        if (outcome) attachCleanupDiagnostics(outcome, cleanupErrors);
        else attachCleanupDiagnostics(failure, cleanupErrors);
      }
    }
  }

  async deleteArtifact(name: string): Promise<void> {
    // Held: a delete changes what follows it, so the queue waits for the acknowledgement.
    await this.#artifactOperation<ArtifactsEvent>(
      "artifacts",
      (id) => ({ kind: "artifact-delete", id, name }),
      { hold: true },
    );
  }

  /**
   * Terminate and replace. The order is the point: in-flight requests are rejected FIRST, then the
   * worker is terminated, then a new one is built - terminating first leaves promises that can
   * never settle. Termination is also the only honest way to stop running Python here: a Pyodide
   * interrupt needs a SharedArrayBuffer, which needs cross-origin isolation headers this package
   * cannot set on a host's behalf. See the README.
   */
  async restart(): Promise<BrowserPythonReadyInfo> {
    if (this.#state === "disposed") {
      throw new BrowserPythonError("disposed", "This engine was disposed.");
    }
    this.#rejectAll(new BrowserPythonError("restarted", "The interpreter was restarted."));
    this.#teardownWorker();
    // A new interpreter has a new, empty buffer.
    this.#continuationOwner = null;
    // Announced, not silently emptied. Artifacts are session-scoped - a restart is a new OPFS
    // session directory and the old one is reclaimed - so a UI that kept its previous list would
    // show downloads that cannot be served. The empty event says so once.
    this.#workspace = null;
    this.#emitArtifacts({ type: "artifacts", artifacts: [], added: [], updated: [], removed: [] });
    return this.#adopt(this.#boot());
  }

  /**
   * Shut down cleanly, and wait for the worker to say it is done. `dispose()` posts a `dispose`
   * message and terminates immediately, which is right for a crash and wrong for an orderly exit:
   * the worker is killed mid-message, so OPFS sync access handles are released by the browser and
   * this session's storage directory is left for the next session's stale sweep. The timeout is
   * not optional - a worker stuck inside a long Python call never answers - so this degrades to
   * exactly what `dispose()` does.
   */
  async disposeAsync(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.#state === "disposed") return;
    const worker = this.#worker;
    if (worker) {
      const timeoutMs = options.timeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
      try {
        await Promise.race([
          this.#request<void>("ack", (id) => ({ kind: "dispose", id })),
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      } catch {
        // The worker died, or rejected. Either way the hard path below is what is left.
      }
    }
    this.dispose();
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.#rejectAll(new BrowserPythonError("disposed", "This engine was disposed."));
    this.#teardownWorker({ polite: true });
    this.#startPromise = null;
    this.#setState("disposed");
    this.#workspace = null;
    // Every listener set, so a disposed engine holds no reference to a host that has gone. A set
    // left behind here keeps its callbacks - and whatever they close over - alive for as long as
    // the engine object is.
    this.#statusListeners.clear();
    this.#outputListeners.clear();
    this.#artifactListeners.clear();
    this.#storageListeners.clear();
  }

  // internals

  async #boot(): Promise<BrowserPythonReadyInfo> {
    this.#setState("loading", "starting worker");
    // Checked AFTER the status event, because listeners run synchronously inside it: a host that
    // disposes from a `loading` listener would otherwise get a Worker built anyway, and report
    // `disposed` while holding a live interpreter nothing would terminate. `#currentState()`
    // rather than the field, because TypeScript narrows the field from the check in `start()`.
    if (this.#currentState() === "disposed") {
      throw new BrowserPythonError("disposed", "This engine was disposed while it was starting.");
    }
    const generation = ++this.#generation;

    let worker: Worker;
    try {
      worker = this.#options.workerFactory();
    } catch (cause) {
      const error = new BrowserPythonError(
        "unsupported",
        "Could not create a module Worker. This engine requires Web Workers with ES module support.",
        { reason: "no-worker", cause },
      );
      this.#failStart(error);
      throw error;
    }
    this.#worker = worker;
    // The session identity, created with the Worker and dead with it. Everything long-running
    // captures this object rather than "whatever Worker is current", so a restart makes those
    // operations fail instead of silently retargeting them.
    const session: WorkerSession = {
      id: `ws-${generation}-${Math.random().toString(36).slice(2, 10)}`,
      generation,
      worker,
      alive: true,
    };
    this.#session = session;

    worker.onmessage = (event: MessageEvent) => {
      if (generation !== this.#generation) return; // a message from a replaced worker
      this.#onMessage(event.data as WorkerMessage);
    };
    // A worker that fails to LOAD (a bad URL, a CSP refusal, a syntax error in the module) never
    // sends anything, so without this the start promise would hang until the timeout instead of
    // saying what is wrong.
    worker.onerror = (event: unknown) => {
      if (generation !== this.#generation) return;
      const message =
        typeof event === "object" && event !== null && "message" in event
          ? String((event as { message: unknown }).message)
          : "The Python worker failed to load.";
      this.#onFatal(new BrowserPythonError("worker-failed", message));
    };

    const init: Omit<Extract<WorkerRequest, { kind: "init" }>, "id"> = {
      kind: "init",
      protocol: PROTOCOL_VERSION,
      profile: this.#options.profile,
      indexURL: this.#options.indexURL,
      packages: this.#options.packages,
      addons: this.#options.addons,
      ...(this.#options.optionalAddons.length > 0
        ? { optionalAddons: this.#options.optionalAddons }
        : {}),
      workerSession: session.id,
      ...(this.#options.packageBaseURL !== undefined
        ? { packageBaseURL: this.#options.packageBaseURL }
        : {}),
      ...(this.#options.wheelhouseURL !== undefined
        ? { wheelhouseURL: this.#options.wheelhouseURL }
        : {}),
      ...(this.#options.addonBaseURL !== undefined
        ? { addonBaseURL: this.#options.addonBaseURL }
        : {}),
      ...(this.#options.persistCredentials !== undefined
        ? { persistCredentials: this.#options.persistCredentials }
        : {}),
      ...(this.#options.workspaceMaxFiles !== undefined
        ? { workspaceMaxFiles: this.#options.workspaceMaxFiles }
        : {}),
    };

    try {
      const info = await this.#request<BrowserPythonReadyInfo>(
        "ready",
        (id) => ({ ...init, id }) as WorkerRequest,
        { timeoutMs: this.#options.startTimeoutMs },
      );
      // Re-checked AFTER the await, and a real race: `dispose()` or `restart()` can land between
      // the worker's `ready` arriving and this continuation running, and the reply has already
      // settled the pending entry, so nothing rejects.
      if (generation !== this.#generation || this.#state === "disposed") {
        throw new BrowserPythonError(
          this.#state === "disposed" ? "disposed" : "restarted",
          this.#state === "disposed"
            ? "This engine was disposed while it was starting."
            : "The interpreter was replaced while it was starting.",
        );
      }
      this.#workspace = info.workspace;
      // The host's startup code, BEFORE `ready` and outside `#submit`: the queue gates on the
      // state this is running in order to reach, and `run()` would wait for a readiness that has
      // not been declared yet. Bound to the session, so a restart landing mid-run fails it rather
      // than letting it finish against the replacement.
      const startupSource = this.#options.startupSource;
      if (startupSource) {
        const outcome = await this.#request<ExecutionResult>(
          "run-reply",
          (id) => ({ kind: "run", id, executionId: this.#nextExecutionId(), code: startupSource }),
          { session },
        );
        // CHECKED, because a Python-level failure RESOLVES: the worker answers `run-reply` with
        // `error` set and nothing rejects. An unchecked call here is how a console announces that
        // it is ready with none of the wheels its host just tried to install.
        if (outcome.error) {
          throw new BrowserPythonError(
            "startup-source",
            `The host's startupSource failed, so the interpreter is not configured as intended:\n${outcome.error}`,
          );
        }
      }
      this.#setState("ready");
      return info;
    } catch (error) {
      this.#failStart(error);
      throw error;
    }
  }

  /**
   * Make one boot the current attempt, and let only that attempt clear itself. The memoised
   * promise and the attempt that produced it have to be the same object, or a replaced boot clears
   * its successor's promise and a synchronously failing boot writes its rejection over the `null`
   * its own failure handler just set, memoising the failure for every later `start()`.
   */
  #adopt(attempt: Promise<BrowserPythonReadyInfo>): Promise<BrowserPythonReadyInfo> {
    this.#startPromise = attempt;
    attempt.catch(() => {
      // A failed start is not memoised into a permanently poisoned engine: the next `start()` gets
      // a fresh attempt, which is what a host retrying a fixed configuration needs.
      if (this.#startPromise === attempt) this.#startPromise = null;
    });
    return attempt;
  }

  #failStart(error: unknown): void {
    // A start that lost its race was already superseded: the worker it would tear down belongs to
    // its successor, and the state it would set is the successor's to set.
    if (error instanceof BrowserPythonError && error.code === "restarted") return;
    this.#teardownWorker();
    // Cleared, not kept: a failed start must not be memoised into a permanently poisoned engine,
    // and the next `start()` gets a fresh attempt. Announced once, too: a worker `fatal` reaches
    // here twice - `#onFatal` sets the error state and rejects every pending request, one of
    // which is the `ready` this `#boot` awaits - and a console rendering one line per event would
    // print the traceback twice. `#boot` sets `loading` before anything can fail, so `error` here
    // means `#onFatal` has just been through.
    if (this.#state !== "disposed" && this.#state !== "error") {
      this.#setState("error", errorMessage(error));
    }
  }

  async #requireReady(): Promise<void> {
    if (this.#state === "disposed") {
      throw new BrowserPythonError("disposed", "This engine was disposed.");
    }
    if (!this.#startPromise) {
      throw new BrowserPythonError("not-started", "Call start() before running Python.");
    }
    await this.#startPromise;
    // Re-checked AFTER the await, which is a suspension point `dispose()` or a fatal can land in.
    // Otherwise the caller is told "there is no live Python worker", which is true and useless:
    // the answer is that the engine was disposed, or that only `restart()` will bring it back.
    // Read through a method, not the field - TypeScript narrows `this.#state` from the check at
    // the top and reports the direct comparison as impossible when it is what this exists for.
    if (this.#currentState() === "disposed") {
      throw new BrowserPythonError("disposed", "This engine was disposed.");
    }
    if (!this.#worker) {
      throw new BrowserPythonError(
        "worker-failed",
        "The interpreter is not running. Call restart() to bring up a fresh one.",
      );
    }
  }

  /**
   * Reserve part of the engine's transfer-memory budget, or refuse. What is bounded is the window
   * of chunk buffers a transfer holds OUTSIDE the worker at once. A refusal is a `resource` error
   * naming the budget and what is using it, because a host that starts six downloads at once has
   * made a decision it can revisit and a silent queue would look like six stalled downloads.
   */
  #reserveTransfer(bytes: number): { release(): void } {
    if (this.#reservedBytes + bytes > TRANSFER_MEMORY_BUDGET_BYTES) {
      throw new BrowserPythonError(
        "resource",
        `This download needs ${Math.round(bytes / 1024 / 1024)} MiB of transfer buffer and only ` +
          `${Math.round((TRANSFER_MEMORY_BUDGET_BYTES - this.#reservedBytes) / 1024 / 1024)} MiB ` +
          `of the engine's ${Math.round(TRANSFER_MEMORY_BUDGET_BYTES / 1024 / 1024)} MiB budget ` +
          `is free. Wait for a download to finish, or use a smaller chunkBytes/windowChunks.`,
      );
    }
    this.#reservedBytes += bytes;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#reservedBytes -= bytes;
      },
    };
  }

  /** See `#requireReady`: deliberately opaque to control-flow narrowing. */
  #currentState(): BrowserPythonState {
    return this.#state;
  }

  #request<T>(
    expect: WorkerMessage["kind"],
    build: (id: string) => WorkerRequest,
    options: { timeoutMs?: number; session?: WorkerSession } = {},
  ): Promise<T> {
    // A request addressed to a SESSION goes to that session or nowhere. Otherwise a message built
    // for one Worker is posted to whichever is current when it is sent - for a transfer that
    // outlived a restart, chunk requests answered from another workspace and a `close` that frees
    // somebody else's lease.
    if (options.session && (options.session !== this.#session || !options.session.alive)) {
      return Promise.reject(
        new BrowserPythonError(
          "restarted",
          "The interpreter was replaced while this operation was in flight.",
        ),
      );
    }
    const session = options.session ?? this.#session;
    const worker = session?.worker ?? this.#worker;
    if (!worker) {
      return Promise.reject(
        new BrowserPythonError("worker-failed", "There is no live Python worker."),
      );
    }
    const generation = session?.generation ?? this.#generation;
    const timeoutMs = options.timeoutMs;
    const id = this.#nextId();
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        resolve: resolve as (value: never) => void,
        reject,
        expect,
        generation,
      };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.#pending.delete(id);
          const error = new BrowserPythonError(
            "timeout",
            `The Python runtime did not respond within ${timeoutMs}ms. ` +
              `Check that ${this.#options.indexURL} is reachable from this page.`,
            { reason: "runtime-unreachable" },
          );
          this.#onFatal(error);
          reject(error);
        }, timeoutMs);
      }
      this.#pending.set(id, entry);
      try {
        worker.postMessage(build(id));
      } catch (error) {
        // `postMessage` can throw - a value that will not structured-clone, a port already closed
        // by a `terminate()` that raced this call. The pending entry is registered by then, so
        // leaving it would be a promise nobody ever settles and a timer nobody ever clears.
        this.#pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(
          new BrowserPythonError(
            "worker-failed",
            `The request could not be sent to the Python worker: ${errorMessage(error)}`,
            { cause: error },
          ),
        );
      }
    });
  }

  #settle(id: string, expect: WorkerMessage["kind"], value: unknown): void {
    const entry = this.#pending.get(id);
    if (!entry) return; // already rejected by a restart, a dispose or a fatal - not an error
    if (entry.generation !== this.#generation) {
      // A reply that outlived its Worker. Ids are unique per engine so this should be unreachable,
      // and it is checked anyway: settling a request with another generation's answer is the exact
      // class of bug this table exists to prevent.
      return;
    }
    if (entry.expect !== expect) {
      // The correlation table's other half: an id may only be settled by the reply KIND it asked
      // for. Without this, a stray `ack` could resolve a `push` with `undefined`.
      this.#pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(
        new BrowserPythonError(
          "protocol",
          `Request ${id} expected ${entry.expect} but the worker sent ${expect}.`,
        ),
      );
      return;
    }
    this.#pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(value as never);
  }

  #reject(id: string, error: unknown): void {
    const entry = this.#pending.get(id);
    if (!entry) return;
    this.#pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(error);
  }

  #rejectAll(error: unknown): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    // Transfers too, and not through the request table: one stalled inside `sink.write()` has no
    // pending request, so it would wake after the restart and carry on writing into a destination
    // the caller believes is finished with. Told directly, it fails at its next checkpoint.
    for (const transfer of [...this.#transfers]) transfer.cancel(error);
  }

  #onMessage(message: WorkerMessage): void {
    switch (message.kind) {
      case "status":
        // A worker's own phase reporting ("loading xarray") must not overwrite the engine's
        // authoritative lifecycle state; it only ever annotates it.
        this.#emitStatus(this.#state, message.detail);
        return;
      case "storage":
        this.#credentialsPersisted = message.credentialsPersisted;
        this.#emitStorage({
          credentialsPersisted: message.credentialsPersisted,
          detail: message.detail,
        });
        return;

      case "ready":
        this.#credentialsPersisted = message.info.credentialsPersisted;
        this.#settle(message.id, "ready", message.info);
        return;
      case "push-reply":
        this.#settle(message.id, "push-reply", message.result);
        return;
      case "run-reply":
        this.#settle(message.id, "run-reply", message.result);
        return;
      case "completion":
        this.#settle(message.id, "completion", message.result);
        return;
      case "ack":
        this.#settle(message.id, "ack", undefined);
        return;
      case "interrupt-reply":
        this.#settle(message.id, "interrupt-reply", message.requested);
        return;
      case "artifacts": {
        const event: ArtifactsEvent = {
          type: "artifacts",
          ...(message.executionId !== undefined ? { executionId: message.executionId } : {}),
          artifacts: message.artifacts,
          added: message.added,
          updated: message.updated,
          removed: message.removed,
        };
        // Settled AND emitted, in that order, when it answers a request. Every listener hears the
        // same change too, so a UI does not have to know whether a delete came from its own button
        // or from an `os.remove()` at the prompt.
        if (message.id !== undefined) this.#settle(message.id, "artifacts", event);
        this.#emitArtifacts(event);
        return;
      }
      case "artifact-lease":
        this.#settle(message.id, "artifact-lease", message);
        return;
      case "artifact-chunk-data":
        this.#settle(message.id, "artifact-chunk-data", message);
        return;
      case "artifact-data":
        this.#settle(message.id, "artifact-data", {
          name: message.name,
          mime: message.mime,
          size: message.size,
          blob: message.blob,
          truncated: message.truncated,
        } satisfies ArtifactData);
        return;
      case "stdout":
      case "stderr":
      case "result":
        this.#emitOutput({
          type: message.kind,
          executionId: message.executionId,
          text: message.text,
          ...(message.background === true ? { background: true } : {}),
        });
        return;
      case "display": {
        // Re-validated on arrival. See `validateDisplay` for why both sides check.
        const checked = validateDisplay(message);
        if (!checked.ok) {
          this.#emitOutput({
            type: "stderr",
            executionId: message.executionId,
            text: `[browser-python] dropped a display payload: ${checked.error}\n`,
          });
          return;
        }
        this.#emitOutput({
          type: "display",
          executionId: message.executionId,
          ...checked.value,
        });
        return;
      }
      case "request-error":
        this.#reject(message.id, new BrowserPythonError("worker-failed", message.message));
        return;
      case "fatal": {
        const error = new BrowserPythonError("worker-failed", message.message, {
          ...(message.reason !== undefined ? { reason: message.reason } : {}),
        });
        this.#onFatal(error);
        return;
      }
    }
  }

  #onFatal(error: BrowserPythonError): void {
    if (this.#state === "disposed") return;
    // The interpreter is gone, and with it the OPFS session that held the artifacts. Reporting a
    // stale list would offer downloads for files whose storage handles no longer exist.
    this.#workspace = null;
    this.#rejectAll(error);
    this.#teardownWorker();
    this.#startPromise = null;
    this.#setState("error", error.message);
  }

  #teardownWorker(options: { polite?: boolean } = {}): void {
    const worker = this.#worker;
    const session = this.#session;
    this.#worker = null;
    this.#session = null;
    if (session) session.alive = false;
    this.#generation += 1;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    if (options.polite) {
      // Best effort only. `terminate()` below is what actually guarantees the worker stops, and it
      // is what stops a long-running Python call; this just lets an idle interpreter tidy up.
      try {
        worker.postMessage({ kind: "dispose", id: this.#nextId() } satisfies WorkerRequest);
      } catch {
        // the port may already be closed
      }
    }
    worker.terminate();
  }

  #setState(state: BrowserPythonState, detail?: string): void {
    this.#state = state;
    this.#emitStatus(state, detail);
  }

  #emitStatus(state: BrowserPythonState, detail?: string): void {
    for (const listener of [...this.#statusListeners]) {
      try {
        listener({ type: "status", state, ...(detail !== undefined ? { detail } : {}) });
      } catch {
        // A listener that throws is the consumer's bug and must not take down the engine or stop
        // the other listeners from hearing about the same event.
      }
    }
  }

  #emitOutput(event: OutputEvent): void {
    for (const listener of [...this.#outputListeners]) {
      try {
        listener(event);
      } catch {
        // see #emitStatus
      }
    }
  }

  #emitStorage(event: StorageEvent): void {
    for (const listener of [...this.#storageListeners]) {
      try {
        listener(event);
      } catch {
        // see #emitStatus
      }
    }
  }

  #emitArtifacts(event: ArtifactsEvent): void {
    for (const listener of [...this.#artifactListeners]) {
      try {
        listener(event);
      } catch {
        // see #emitStatus
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve a URL option against the PAGE, before it crosses into the worker. A relative `indexURL`
 * does not survive the trip: inside a worker a relative URL resolves against the WORKER's own URL,
 * so `"runtime/"` configured by a page at `/app/` becomes `/dist/worker/runtime/` and the runtime
 * download 404s. `document.baseURI` here means what the host meant.
 */
function absoluteURL(value: string, options: { trailingSlash?: boolean } = {}): string {
  const base =
    typeof document !== "undefined" && document.baseURI
      ? document.baseURI
      : typeof location !== "undefined"
        ? location.href
        : undefined;
  let resolved: string;
  try {
    resolved = base === undefined ? value : new URL(value, base).href;
  } catch {
    // Not parseable even against a base - leave it alone and let the worker report the failure
    // with the URL the host actually wrote, which is more useful than a mangled one.
    resolved = value;
  }
  if (options.trailingSlash && !resolved.endsWith("/")) resolved = `${resolved}/`;
  return resolved;
}

/**
 * Decide how the Worker gets built. The default uses `new URL("./worker/...", import.meta.url)`,
 * the one form every modern bundler recognises and which resolves from `node_modules` in the
 * published package - the worker is emitted as its own file rather than inlined precisely so this
 * URL exists at runtime. The overrides cover a fixed public path, or a test with a fake worker.
 */
function resolveWorkerFactory(options: BrowserPythonOptions): () => Worker {
  if (options.workerFactory) return options.workerFactory;
  if (options.workerURL !== undefined) {
    const url = options.workerURL;
    return () => new Worker(url, { type: "module" });
  }
  return () =>
    new Worker(new URL("./worker/browser-python.worker.js", import.meta.url), { type: "module" });
}

/** Create an engine. Nothing is downloaded until `start()`. */
export function createBrowserPython(options: BrowserPythonOptions = {}): BrowserPython {
  return new BrowserPythonEngine(options);
}

export { BrowserPythonEngine };
export type { BrowserPythonProfile };
