/**
 * types.ts - the package's PUBLIC contract. Framework- and UI-independent by construction, so one
 * engine instance serves a console, a notebook cell and a docs page.
 */

import type { ArtifactSink, ArtifactStreamOptions } from "./artifact-stream.js";

/** Re-exported so a consumer types a destination without a second import. */
export type { ArtifactSink, ArtifactStreamOptions };

// the workspace

/**
 * Why a browser cannot back Python's file output with real storage. Never fatal: files are still
 * written, into the WASM heap rather than onto disk.
 */
export type WorkspaceUnavailableReason =
  /** No `navigator.storage.getDirectory` - the origin has no private filesystem. */
  | "no-opfs"
  /** OPFS exists but `createSyncAccessHandle` does not, so nothing here can be synchronous. */
  | "no-sync-access-handles"
  /** Both exist and opening still failed: storage denied, a quota of zero, a locked origin. */
  | "open-failed";

/**
 * The most file slots a workspace will reserve, whatever it is asked for. Each is an OPFS handle
 * acquired before the interpreter is ready, so an unbounded value is an unbounded startup.
 */
export const MAX_WORKSPACE_FILES = 1024;

/** Whether `/workspace` is disk-backed in this browser, and what it can hold. */
export interface WorkspaceStatus {
  available: boolean;
  reason?: WorkspaceUnavailableReason;
  /** A sentence for a UI to show when `available` is false. */
  detail?: string;
  /** Where it is mounted, and the interpreter's working directory. */
  path: string;
  /**
   * The maximum number of files that may exist AT ONE TIME - a bound on retained files, not on
   * names or on files ever created. Deleting a file returns its handle.
   */
  maxFiles: number;
  /** Identifies this worker's storage. Changes on every restart - artifacts are session-scoped. */
  sessionId: string;
  /**
   * Set when the workspace holds fewer files than it was asked for: a slot whose storage misbehaves
   * is withdrawn rather than reused, and `maxFiles` reports what is left.
   */
  degraded?: string;
}

/** One file in the workspace, as the outside world sees it. */
export interface ArtifactInfo {
  /** Path relative to the workspace root, e.g. `"out/run1.nc"`. The artifact's identity. */
  name: string;
  size: number;
  modifiedMs: number;
  /**
   * `ready` - closed, complete, downloadable. `open` - Python still holds a descriptor.
   * `transferring` - a download is streaming it; frozen until that ends. `failed` - a write,
   * truncate or flush failed; quarantined and refused for download.
   */
  state: "ready" | "open" | "transferring" | "failed";
  /**
   * Bumped on every change and never reused: the identity of these BYTES, not of this filename. A
   * download checks it on every chunk, so a rewrite mid-transfer stops the transfer.
   */
  generation: number;
  /** Why it failed, when it did. */
  failure?: string;
  mime: string;
}

/** An artifact handed back for preview or download. */
export interface ArtifactData {
  name: string;
  mime: string;
  /** The artifact's FULL size, even when `blob` holds only a preview. */
  size: number;
  blob: Blob;
  /** True when `maxBytes` cut the blob short. */
  truncated: boolean;
}

/** What changed in the workspace, and what is in it now. */
export interface ArtifactsEvent {
  type: "artifacts";
  /** The execution that produced the change, when one did. */
  executionId?: string;
  artifacts: readonly ArtifactInfo[];
  added: readonly string[];
  updated: readonly string[];
  removed: readonly string[];
}

/** Where an engine is in its lifecycle. Always exactly one of these. */
export type BrowserPythonState =
  | "idle" // constructed, nothing downloaded, no worker
  | "loading" // start() or restart() is in flight
  | "ready" // an interpreter is up and accepting work
  | "busy" // an execution is in flight
  | "error" // start failed, or the worker died; recoverable only by restart()
  | "disposed"; // terminal - the instance cannot be used again

/**
 * Which Python environment to bring up. `minimal` is an interpreter and nothing else; `xarray-zarr`
 * adds the scientific stack and the browser HTTP filesystem, which makes `xr.open_zarr(<https
 * url>)` work. Matplotlib is in neither: the wheel is fetched only if Python imports it.
 */
export type BrowserPythonProfile = "minimal" | "xarray-zarr" | "freva-client";

/** How the engine reaches the Pyodide runtime and its wheels. */
export interface PyodideOptions {
  /**
   * The directory holding `pyodide.mjs`, the WASM, the stdlib and the wheel index. PINNED, never
   * `latest`: a Pyodide upgrade is an interpreter upgrade. Point it at your own origin to
   * self-host.
   */
  indexURL?: string;
  /**
   * Where `micropip` and `loadPackage` look for wheels. Defaults to the runtime's own index, which
   * keeps a self-hosted `indexURL` self-contained.
   */
  packageBaseURL?: string;
}

/**
 * A curated browser capability, by name. A CLOSED set: not package names a caller may extend but
 * artefact sets this package pinned, with digests compiled into the bundle and a fixed install
 * order.
 *
 *  * `dask` - Dask core and `dask.array` on ONE synchronous scheduler, plus xarray's Dask-backed
 *    `chunks={}` path. Needs a profile that carries xarray.
 *  * `cartopy-natural-earth-110m` - the Natural Earth 110m coastline and border data
 *    `ax.coastlines()` and `feature.BORDERS` otherwise download at figure-render time.
 */
export type BrowserPythonAddon = "dask" | "cartopy-natural-earth-110m";

/** What one prepared add-on turned out to be, reported rather than assumed. */
export interface ReadyAddonInfo {
  id: BrowserPythonAddon;
  /** The registry's own one-line description, so a diagnostic can name it in words. */
  title: string;
  /** Resolved versions of what it installed, e.g. `{ dask: "2026.8.0" }`. */
  versions: Record<string, string>;
}

/**
 * An OPTIONAL add-on that was configured and did not arrive. Reported rather than thrown, in a form
 * a UI can render. `remedy` says what to do; `reason` says what happened.
 */
export interface UnavailableAddonInfo {
  id: BrowserPythonAddon;
  title: string;
  /** One line: what could not be obtained, and what the server said about it. */
  reason: string;
  /** One line: what would make it available. Names the config key and the preparation command. */
  remedy: string;
  /** Whether requesting the identical configuration again could plausibly succeed. */
  retryMayHelp: boolean;
}

export interface BrowserPythonOptions {
  profile?: BrowserPythonProfile;
  pyodide?: PyodideOptions;
  /**
   * Where the `freva-client` profile's wheels are served from. Static files, same-origin by
   * default: `freva-wheels/` beside the runtime's `indexURL`. Ignored by the other profiles.
   */
  wheelhouseURL?: string;
  /**
   * Python the HOST needs run before anyone may use the interpreter: extra wheels, a `sys.path`
   * entry, an import warmed. Run inside `start()`, after the profile is up and BEFORE the engine
   * reports ready, and again after every `restart()` - a restart is a new interpreter, so it is
   * new startup code too.
   *
   * INVISIBLE, and that is the point. It does not go through the console, so nothing is echoed at
   * a prompt and nothing enters history: a visitor opens a clean `>>> `. Putting the same source
   * through `execute()` would make it the first thing they see and the first thing `Up` recalls.
   *
   * IT MUST SUCCEED. A Python-level failure - a 404 on a wheel, an ImportError - rejects `start()`
   * with `code: "startup-source"` and the traceback as the message, so a host cannot announce a
   * ready console that has none of what it promised. This is the difference from calling
   * `run()` yourself: `run()` RESOLVES with `ExecutionResult.error` set, which is easy to forget
   * to check.
   */
  startupSource?: string;
  /**
   * Keep credentials across reloads, in IndexedDB. **Off by default, deliberately:** what is
   * persisted is a refresh token, and browser storage is readable by any same-origin script -
   * including a package the visitor installs at the prompt.
   */
  persistCredentials?: boolean;
  /**
   * Build the Worker yourself. The default is `new Worker(new
   * URL("./worker/browser-python.worker.js", import.meta.url), { type: "module" })`; this is for
   * bundlers that do not understand that idiom, a fixed public path, a CSP that forbids blob
   * workers, or a test.
   */
  workerFactory?: () => Worker;
  /** A ready-made URL for the worker module, when only the location differs from the default. */
  workerURL?: string | URL;
  /**
   * Curated add-ons to prepare during `start()`. Empty by default; order is ignored, since the
   * registry installs in its own fixed order. One that does not work with the chosen profile fails
   * `start()` with a message naming both.
   */
  addons?: readonly BrowserPythonAddon[];
  /**
   * Curated add-ons whose ABSENCE is tolerable, so the interpreter still starts without them. A
   * separate list rather than a flag on {@link BrowserPythonOptions.addons}, because making that
   * list best-effort would silently downgrade every deployment depending on it.
   *
   * NOT EVERY ADD-ON MAY BE LISTED HERE: one qualifies only when its preparation cannot partially
   * mutate the interpreter before it fails - see `supportsOptional`. Naming a non-qualifying
   * add-on, or an id in both lists, is a configuration error.
   */
  optionalAddons?: readonly BrowserPythonAddon[];
  /**
   * Where the add-ons' pinned artefacts are served from: `python-addons/` beside the runtime's
   * `indexURL` by default. Prepare it with `freva-browser-python prepare-addons`. Every file is
   * digest-checked, so a stale directory fails the start.
   */
  addonBaseURL?: string;
  /**
   * Extra Pyodide packages to load during `start()`, on top of the profile's own set. Use
   * sparingly: every entry is bytes on a visitor's first run, and imports auto-load anyway.
   */
  packages?: readonly string[];
  /** Milliseconds before `start()` gives up. Default 180000 - a cold cache on a slow link is slow. */
  startTimeoutMs?: number;
  /**
   * How many files `/workspace` may hold at one time. Default 64. Each costs an OPFS handle
   * reserved at startup - roughly 0.6 ms. See {@link WorkspaceStatus.maxFiles}.
   */
  workspaceMaxFiles?: number;
}

/** What actually came up, reported rather than assumed. */
export interface BrowserPythonReadyInfo {
  profile: BrowserPythonProfile;
  /** e.g. `"3.14.2"` - read from the interpreter, never hardcoded by a caller. */
  pythonVersion: string;
  pyodideVersion: string;
  /**
   * Resolved versions of whatever the profile loaded, e.g. `{ xarray: "2026.2.0", zarr: "3.2.1" }`.
   * Empty for `minimal`. A UI should PRINT these rather than claim its own numbers.
   */
  packages: Readonly<Record<string, string>>;
  /**
   * The curated add-ons that were actually prepared, with the versions they installed. Empty when
   * none were configured. There is no partial state to report - a failed add-on fails the start.
   */
  addons: readonly ReadyAddonInfo[];
  /**
   * Optional add-ons that were configured and could not be prepared, so a host can say "offline
   * coastlines are unavailable" in its own chrome. A REQUIRED add-on never appears here.
   */
  unavailableAddons: readonly UnavailableAddonInfo[];
  /** Wall-clock milliseconds from the `init` message to readiness, for a status line. */
  startupMs: number;
  /**
   * Whether Python's file output is backed by real storage in this browser, and what it can hold.
   * Reported rather than assumed: OPFS synchronous access handles are not in every browser.
   */
  workspace: WorkspaceStatus;
  /**
   * Whether credentials will survive a reload, for the `freva-client` profile. `false` when
   * `persistCredentials` was not asked for, and ALSO when it was and the browser refused.
   */
  credentialsPersisted: boolean;
  /**
   * Whether this engine can suspend WebAssembly to await JavaScript - "JSPI", stack switching.
   * Reported rather than enforced: nothing needs it but reading a REMOTE dataset, where a
   * synchronous Zarr decode calls an asynchronous fetch underneath.
   */
  jspi: boolean;
}

/** Where the interpreter's parser is after the last `push()`. */
export type ReplSyntaxState = "complete" | "incomplete" | "syntax-error";

/** The outcome of one `push()` - one line into an interactive console. */
export interface PushResult {
  executionId: string;
  /**
   * `incomplete` means the console is mid-statement and the UI should show a continuation prompt.
   * NOTHING was executed in that case.
   */
  syntax: ReplSyntaxState;
  /** True when the buffer was consumed and executed (i.e. `syntax === "complete"`). */
  executed: boolean;
  /** `repr()` of the value of an expression statement, when there was one. */
  result?: string;
  /** A formatted Python traceback. Text, always - see the security notes in the README. */
  error?: string;
}

/** The outcome of one `run()` - a whole snippet, as if from a file. */
export interface ExecutionResult {
  executionId: string;
  result?: string;
  error?: string;
}

export interface CompletionResult {
  /** Where the replaced token starts: a UTF-16 CODE-UNIT offset, not bytes or Python chars. */
  start: number;
  matches: readonly string[];
}

/** MIME types the protocol will carry. Anything else is rejected at the boundary. */
export type DisplayMime = "image/png" | "text/plain";

export interface StatusEvent {
  type: "status";
  state: BrowserPythonState;
  /** A short, human-readable phase for a loading indicator, e.g. `"loading xarray"`. */
  detail?: string;
}

export interface StreamEvent {
  type: "stdout" | "stderr" | "result";
  executionId: string;
  text: string;
  /** True when this arrived outside any execution - see `StreamMessage.background`. */
  background?: true;
}

export interface DisplayEvent {
  type: "display";
  executionId: string;
  mime: DisplayMime;
  encoding: "base64" | "utf8";
  data: string;
  metadata?: {
    figure?: number;
    width?: number;
    height?: number;
  };
}

export interface ErrorEvent {
  type: "error";
  executionId: string;
  /** A Python traceback, as text. */
  text: string;
}

/**
 * The interpreter is gone: the worker crashed, `init` failed, or the runtime could not be reached.
 * Every in-flight request is rejected and the engine goes to `error`. Only `restart()` recovers.
 */
export interface FatalEvent {
  type: "fatal";
  message: string;
  /** Set when the cause is known to be environmental rather than a bug - see `UnsupportedReason`. */
  reason?: UnsupportedReason;
}

/**
 * Why an environment cannot run this engine, when that is knowable up front. Reported rather than
 * thrown as an opaque failure, because each has a different actionable answer: a header to set, a
 * browser to use, a URL to fix.
 */
export type UnsupportedReason =
  | "no-worker" // no module Worker support
  | "no-webassembly"
  | "runtime-unreachable" // the pinned indexURL did not serve pyodide.mjs
  | "packages-unreachable"; // the runtime came up, but a profile's wheels did not arrive

export type OutputEvent = StreamEvent | DisplayEvent | ErrorEvent;

export type Unsubscribe = () => void;
export type StatusListener = (event: StatusEvent) => void;
export type OutputListener = (event: OutputEvent) => void;
export type ArtifactsListener = (event: ArtifactsEvent) => void;

/**
 * Credential storage changed its answer after startup: the only event carrying
 * `credentialsPersisted: false` after `ready` said `true`. The session and the token in memory are
 * unaffected.
 */
export interface StorageEvent {
  credentialsPersisted: boolean;
  /** What the browser said, for a log. Never contains a credential. */
  detail: string;
}
export type StorageListener = (event: StorageEvent) => void;

export interface BrowserPython {
  readonly state: BrowserPythonState;
  /** Null until `start()` has resolved once. See {@link WorkspaceStatus}. */
  readonly workspace: WorkspaceStatus | null;

  /** Bring up a worker and an interpreter. Idempotent: a second call returns the first result. */
  start(): Promise<BrowserPythonReadyInfo>;
  /**
   * Feed ONE logical line to the interactive console. See {@link PushResult}. `owner` matters only
   * when several components share one engine: the interpreter has ONE line buffer, so a push from
   * another owner while a continuation is open is rejected rather than appended to it.
   */
  push(line: string, options?: { owner?: string }): Promise<PushResult>;
  /** Execute a complete snippet, as if it were a file. Does not touch the REPL's line buffer. */
  run(code: string): Promise<ExecutionResult>;
  /** `cursor` is a UTF-16 offset defaulting to `source.length`; `start` uses the same unit. */
  complete(source: string, cursor?: number): Promise<CompletionResult>;
  /** Throw away a half-typed multi-line statement. To stop a RUNNING one, see `interrupt`. */
  clearBuffer(): Promise<void>;
  /**
   * Ctrl+C: ask the running execution to stop, and report whether there was one. The task running
   * the visitor's code is cancelled and the `CancelledError` delivered at whatever `await` it sits
   * on. `true` means a cancellation was RECORDED, not that anything stopped: a synchronous loop
   * never reaches a suspension point, so only `restart()` ends one.
   */
  interrupt(): Promise<boolean>;
  /** Terminate the worker and bring up a fresh interpreter. The only reliable escape hatch. */
  restart(): Promise<BrowserPythonReadyInfo>;
  /** Terminal. Rejects everything in flight and releases the worker immediately. */
  dispose(): void;
  /**
   * Terminal, but orderly: waits for the worker to release its storage before terminating it.
   * Prefer it wherever there is time - `beforeunload`, an unmount, a test teardown. Falls back to
   * `dispose()` after a short timeout.
   */
  disposeAsync(options?: { timeoutMs?: number }): Promise<void>;

  /** Everything in `/workspace` right now. */
  artifacts(): Promise<readonly ArtifactInfo[]>;
  /**
   * Read a SMALL artifact into a Blob, for a preview. Hard-capped at 8 MiB; anything larger is
   * `streamArtifact`. Rejects for a file Python still has open and for one marked `failed`.
   * `maxBytes` caps the blob; `size` is the artifact's real length.
   */
  readArtifact(name: string, options?: { maxBytes?: number }): Promise<ArtifactData>;
  /**
   * Stream an artifact to a destination, in bounded chunks, with backpressure. Pass a
   * `FileSystemWritableFileStream` from `showSaveFilePicker()` and the bytes reach the user's
   * chosen file without the whole artifact existing in memory.
   *
   * While the transfer runs the artifact is frozen: Python cannot write, rename or delete it, and
   * every chunk re-checks that it has not changed. `options.signal` cancels; the destination is
   * aborted rather than closed.
   */
  streamArtifact(
    name: string,
    destination: ArtifactSink | WritableStream<Uint8Array>,
    options?: ArtifactStreamOptions,
  ): Promise<ArtifactStreamResult>;
  deleteArtifact(name: string): Promise<void>;

  onStatus(listener: StatusListener): Unsubscribe;
  onOutput(listener: OutputListener): Unsubscribe;
  /** Fires after every execution that changed the workspace, and after a delete. */
  onArtifacts(listener: ArtifactsListener): Unsubscribe;
  /**
   * Whether credentials will survive a reload, right now. Starts as the `ready` answer and can only
   * go from `true` to `false`, when the browser withdraws the storage.
   */
  readonly credentialsPersisted: boolean;
  /** Fires when persistent credential storage stops being available. */
  onStorage(listener: StorageListener): Unsubscribe;
}

/**
 * What a completed `streamArtifact` returns. NAMED, and exported, because a caller has to be able
 * to type a variable holding one and to write a helper that takes one.
 */
export interface ArtifactStreamResult {
  /** Bytes actually delivered to the destination. Equal to the artifact's size, or the call threw. */
  bytesWritten: number;
  /** The artifact's name, as the worker resolved it. */
  name: string;
  /** The MIME type the workspace inferred for it. */
  mime: string;
  /**
   * Faults from CLEANING UP after a transfer that otherwise succeeded: a destination's `release()`
   * or `abort()` that threw afterwards. Worth logging, never a failed download. NOT lease closes,
   * which are fire-and-forget to the Worker.
   */
  cleanupErrors?: unknown[];
}

/** Thrown for every rejected request, so a caller can branch on `code` rather than on a string. */
export class BrowserPythonError extends Error {
  readonly code:
    | "disposed"
    | "not-started"
    | "restarted"
    | "worker-failed"
    | "timeout"
    | "unsupported"
    | "protocol"
    /** `startupSource` raised. The interpreter is up; what the host asked for did not happen. */
    | "startup-source"
    /** A limit the engine enforces on itself, such as the transfer-memory budget. */
    | "resource";
  readonly reason?: UnsupportedReason;
  /**
   * Faults that happened while CLEANING UP after this error, never instead of it: the destination's
   * own `release()` and `abort()`, neither of which changes what happened to the transfer.
   * BEST-EFFORT - a frozen, sealed, read-only, proxied or primitive failure cannot carry this, so
   * absent means "could not be recorded".
   */
  cleanupErrors?: unknown[];

  constructor(
    code: BrowserPythonError["code"],
    message: string,
    options?: { reason?: UnsupportedReason; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserPythonError";
    this.code = code;
    if (options?.reason !== undefined) this.reason = options.reason;
  }
}
