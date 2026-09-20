/**
 * protocol.ts - the wire between the page and the worker.
 *
 * Every request carries an `id` and every reply carries the id it answers; a single
 * `pendingResolve` settles the wrong promise, silently, as soon as two lifecycle events overlap.
 * Output events carry `executionId` and the worker emits them in order, so a UI can attribute a
 * line to the block that produced it. Everything crossing `postMessage` is structured-cloneable
 * - no PyProxy - except `ArtifactDataMessage.blob`, a reference into the blob store.
 */

import type {
  ArtifactInfo,
  BrowserPythonAddon,
  BrowserPythonProfile,
  BrowserPythonReadyInfo,
  BrowserPythonState,
  CompletionResult,
  DisplayMime,
  ExecutionResult,
  PushResult,
  UnsupportedReason,
} from "./types.js";

/**
 * Bumped when a message shape changes incompatibly. The worker refuses a mismatch.
 *
 * v2 added the artifact messages and turned `artifact-data`'s payload into a leased chunk
 * stream. v3 added `workerSession`, since lease ids are per-Worker counters a replacement Worker
 * reissues. v4 added curated add-ons; v5 added OPTIONAL ones. A NEW page with an OLD worker
 * fails quietly: a v3 worker ignores `addons` and the page goes Ready over an interpreter with
 * no Dask in it; a v4 worker treats every add-on as required and refuses to start.
 */
export const PROTOCOL_VERSION = 5;

// ------ main thread -> worker

export interface InitRequest {
  kind: "init";
  id: string;
  protocol: number;
  profile: BrowserPythonProfile;
  indexURL: string;
  packageBaseURL?: string;
  /** Where the Freva wheels are served from. Only meaningful for the `freva-client` profile. */
  wheelhouseURL?: string;
  /** Whether to mount IndexedDB-backed storage for credentials. Off unless the host asks. */
  persistCredentials?: boolean;
  packages: readonly string[];
  /** Curated add-ons to prepare after the profile's packages and before the REPL. */
  addons: readonly BrowserPythonAddon[];
  /**
   * The subset of `addons` whose absence must not stop the interpreter. Its own list rather than
   * a flag inside `addons`, so a worker that does not understand it sees the same `addons` and
   * refuses, which the version check turns into a message.
   */
  optionalAddons?: readonly BrowserPythonAddon[];
  /** Where the add-ons' pinned artefacts are served from. Defaults beside the runtime. */
  addonBaseURL?: string;
  /** How many files `/workspace` may hold at one time. See `WorkspaceStatus.maxFiles`. */
  workspaceMaxFiles?: number;
  /**
   * Identifies THIS Worker instance, chosen by the engine before the Worker is built. Lease ids
   * are a per-Worker counter, so without a session to address, a chunk request that outlived a
   * restart is answered from a different artifact - a file that arrives complete and is half one
   * export, half another.
   */
  workerSession: string;
}

export interface PushRequest {
  kind: "push";
  id: string;
  executionId: string;
  line: string;
}

export interface RunRequest {
  kind: "run";
  id: string;
  executionId: string;
  code: string;
}

export interface CompleteRequest {
  kind: "complete";
  id: string;
  source: string;
  /** UTF-16 code-unit offset, not Python characters: the Worker slices with it directly. */
  cursor: number;
}

export interface ClearBufferRequest {
  kind: "clear-buffer";
  id: string;
}

/**
 * Ctrl+C: stop whatever is running. THE ONE REQUEST THAT DOES NOT TAKE ITS TURN - it jumps the
 * worker's queue, which is already blocked behind the execution it is asking to end. Safe to
 * jump because it runs no visitor Python and awaits nothing: `asyncio.Task.cancel()` only
 * records a request, and Python's event loop delivers the `CancelledError` at the next
 * suspension point.
 */
export interface InterruptRequest {
  kind: "interrupt";
  id: string;
}

/**
 * Asks the worker to release Python resources before it is terminated. `restart()` does NOT rely
 * on this - it terminates the worker, the only thing that reliably stops running Python. This is
 * the polite path for an idle worker.
 */
export interface DisposeRequest {
  kind: "dispose";
  id: string;
}

// ------ artifacts

export interface ArtifactListRequest {
  kind: "artifact-list";
  id: string;
}

export interface ArtifactReadRequest {
  kind: "artifact-read";
  id: string;
  name: string;
  /** Cap the returned blob, for a preview. The reply still reports the artifact's real size. */
  maxBytes?: number;
}

// ------ streaming a transfer
//
// A download is PULLED: the main thread asks for a chunk, writes it, and only then asks for the
// next, so nothing accumulates - unlike a Blob, where the whole artifact sits in browser memory
// before a byte reaches disk. While a lease is open the artifact is frozen against Python and
// the UI alike, and every chunk re-checks the generation the lease was taken at, so a file that
// does change stops the transfer rather than mixing two versions.

export interface ArtifactOpenRequest {
  kind: "artifact-open";
  id: string;
  name: string;
  /** The Worker this transfer belongs to. See `InitRequest.workerSession`. */
  workerSession: string;
}

export interface ArtifactChunkRequest {
  kind: "artifact-chunk";
  id: string;
  workerSession: string;
  lease: string;
  offset: number;
  length: number;
}

export interface ArtifactCloseRequest {
  kind: "artifact-close";
  id: string;
  workerSession: string;
  lease: string;
  /** Why the transfer ended. Only used for the worker's own logging; both paths free the lease. */
  reason?: "done" | "cancelled" | "failed";
}

export interface ArtifactDeleteRequest {
  kind: "artifact-delete";
  id: string;
  name: string;
}

export type WorkerRequest =
  | InitRequest
  | PushRequest
  | RunRequest
  | CompleteRequest
  | ClearBufferRequest
  | InterruptRequest
  | ArtifactListRequest
  | ArtifactReadRequest
  | ArtifactDeleteRequest
  | ArtifactOpenRequest
  | ArtifactChunkRequest
  | ArtifactCloseRequest
  | DisposeRequest;

// ------ worker -> main thread

export interface StatusMessage {
  kind: "status";
  state: BrowserPythonState;
  detail?: string;
}

export interface ReadyMessage {
  kind: "ready";
  id: string;
  info: BrowserPythonReadyInfo;
}

export interface StreamMessage {
  kind: "stdout" | "stderr" | "result";
  executionId: string;
  text: string;
  /**
   * True when this output arrived OUTSIDE any execution: a `__del__` on a later collection, an
   * `atexit` hook, a callback. `executionId` still names the last execution, but the flag stops a
   * console filing the line inside a block that finished minutes earlier.
   */
  background?: true;
}

export interface DisplayMessage {
  kind: "display";
  executionId: string;
  mime: DisplayMime;
  encoding: "base64" | "utf8";
  data: string;
  metadata?: { figure?: number; width?: number; height?: number };
}

export interface PushReplyMessage {
  kind: "push-reply";
  id: string;
  result: PushResult;
}

export interface RunReplyMessage {
  kind: "run-reply";
  id: string;
  result: ExecutionResult;
}

export interface CompletionMessage {
  kind: "completion";
  id: string;
  result: CompletionResult;
}

export interface AckMessage {
  kind: "ack";
  id: string;
}

/**
 * What the interrupt found. `requested: false` means there was nothing running, which a console
 * answers the way CPython answers a Ctrl+C at an idle prompt. `true` means a cancellation was
 * recorded - NOT that anything has stopped: Python delivers it at the next suspension point.
 */
export interface InterruptReplyMessage {
  kind: "interrupt-reply";
  id: string;
  requested: boolean;
}

/**
 * What is in the workspace now, and what changed. Sent unprompted after any execution that
 * touched a file, and as the reply to `artifact-list` or `artifact-delete` when `id` is set.
 * Carries the WHOLE list rather than a delta: it is a handful of small objects, and a UI that
 * missed one message would permanently disagree with the interpreter.
 */
export interface ArtifactsMessage {
  kind: "artifacts";
  /** Present when this message answers a request; absent when it is a spontaneous update. */
  id?: string;
  executionId?: string;
  artifacts: readonly ArtifactInfo[];
  added: readonly string[];
  updated: readonly string[];
  removed: readonly string[];
}

// `ArtifactDataMessage.blob` is this file's one exception to "plain data only". A Blob crosses
// `postMessage` as a reference into the browser's blob store, so a two-gigabyte artifact does not
// become two gigabytes of JS heap on its way to a download link.

/** A lease on a frozen artifact, and everything needed to read it. */
export interface ArtifactLeaseMessage {
  kind: "artifact-lease";
  id: string;
  workerSession: string;
  lease: string;
  name: string;
  size: number;
  mime: string;
  generation: number;
}

/**
 * One chunk of a transfer. `bytes` is an `ArrayBuffer` and it is TRANSFERRED, not copied, so
 * peak download cost is chunks-in-flight times chunk size, whatever the file's size is.
 */
export interface ArtifactChunkMessage {
  kind: "artifact-chunk-data";
  id: string;
  workerSession: string;
  lease: string;
  offset: number;
  bytes: ArrayBuffer;
  /** The artifact generation this chunk was read at - see `ArtifactInfo.generation`. */
  generation: number;
  /** True when this chunk reaches the end of the artifact. */
  eof: boolean;
}

export interface ArtifactDataMessage {
  kind: "artifact-data";
  id: string;
  name: string;
  mime: string;
  /** The artifact's FULL size, even when `blob` holds only the first `maxBytes` of it. */
  size: number;
  blob: Blob;
  truncated: boolean;
}

/** A request failed, but the interpreter is still alive. Only that request is rejected. */
export interface RequestErrorMessage {
  kind: "request-error";
  id: string;
  message: string;
}

/** The interpreter is gone. EVERY in-flight request is rejected and the engine goes to `error`. */
export interface FatalMessage {
  kind: "fatal";
  /** Present when the failure belongs to one request; absent when it belongs to the runtime. */
  id?: string;
  message: string;
  reason?: UnsupportedReason;
}

/**
 * Persistent credential storage has changed its mind about being available. Sent only to
 * WITHDRAW a promise, never to make one: `ready` reports the answer at startup, and this covers
 * the flush that worked then and stopped working later, the quota having filled or the origin's
 * storage having been evicted.
 */
export interface StorageMessage {
  kind: "storage";
  credentialsPersisted: boolean;
  detail: string;
}

export type WorkerMessage =
  | StatusMessage
  | ReadyMessage
  | StreamMessage
  | DisplayMessage
  | PushReplyMessage
  | RunReplyMessage
  | CompletionMessage
  | AckMessage
  | InterruptReplyMessage
  | ArtifactsMessage
  | ArtifactDataMessage
  | ArtifactLeaseMessage
  | ArtifactChunkMessage
  | StorageMessage
  | RequestErrorMessage
  | FatalMessage;

// ------ boundary validation

const DISPLAY_MIMES: readonly DisplayMime[] = ["image/png", "text/plain"];

/**
 * Hard ceilings on ONE display payload, enforced before any expensive conversion. Every
 * representation of a large matplotlib figure exists at once on the way through - Python bytes,
 * a base64 string, its structured-clone copy, the decoded bytes, a Blob - so five copies of
 * 40 MiB is 200 MiB for one plot. Checked on the ENCODED length first: base64 is 4/3 of the
 * bytes, so a 24 MiB cap admits an 18 MiB image.
 */
export const MAX_DISPLAY_ENCODED_CHARS = 24 * 1024 * 1024;

/** The same limit expressed in decoded bytes, for callers that have the bytes rather than the text. */
export const MAX_DISPLAY_BYTES = 18 * 1024 * 1024;

/**
 * A `text/plain` display is TEXT and counts against the text budget, not the image one. An
 * 18 MiB image budget would put a whole DataFrame in the transcript as a single node; this is
 * generous for a repr and small enough to render.
 */
export const MAX_DISPLAY_TEXT_CHARS = 256 * 1024;

/**
 * How much text ONE execution may send the page before the rest is dropped.
 * `for i in range(2_000_000): print(i)` is a typo away from any legitimate loop, and an unbounded
 * transcript grows until the tab is killed. Keep a generous PREFIX, not a tail: the beginning
 * holds the traceback, the header and the shape of the loop.
 */
export const MAX_EXECUTION_TEXT_CHARS = 2 * 1024 * 1024;

/**
 * How many encoded display characters ONE execution may send. `MAX_DISPLAY_ENCODED_CHARS` bounds
 * a single figure; a cell drawing one plot per station passes that check two hundred times, and
 * the page retains every payload. Deliberately several figures' worth.
 */
export const MAX_EXECUTION_DISPLAY_CHARS = 64 * 1024 * 1024;
const ENCODINGS = ["base64", "utf8"] as const;

/**
 * True for a MIME type this protocol will carry. Short deliberately: `text/html` and
 * `image/svg+xml` are the obvious next candidates and both can carry script, which would make it
 * this package's job to sanitise arbitrary Python-authored markup.
 */
export function isDisplayMime(value: unknown): value is DisplayMime {
  return typeof value === "string" && (DISPLAY_MIMES as readonly string[]).includes(value);
}

export function isDisplayEncoding(value: unknown): value is "base64" | "utf8" {
  return typeof value === "string" && (ENCODINGS as readonly string[]).includes(value);
}

/**
 * Base64 as Python's `base64.b64encode` produces it: no whitespace, canonical padding.
 *
 * Scanned rather than matched against a quantified-group regex, because V8 recurses per
 * repetition of such a group: `RangeError: Maximum call stack size exceeded` lands between 4 MB
 * and 8 MB of payload (measured - 4 MB passes in 81 ms, 8 MB throws). A throw here escapes
 * `validateDisplay`, which both sides call, and is a fatal in the worker or takes out the main
 * thread's message handler.
 */
function isCanonicalBase64(value: string): boolean {
  const length = value.length;
  if (length % 4 !== 0) return false;
  // Padding lives only in the final quartet, and is at most two characters.
  let end = length;
  if (length > 0) {
    if (value.charCodeAt(length - 1) === 61) end -= 1; // "="
    if (end > 0 && value.charCodeAt(end - 1) === 61) end -= 1;
    // "====" is not padding, it is four pad characters where a quartet should be.
    if (length - end === 2 && end % 4 !== 2) return false;
    if (length - end === 1 && end % 4 !== 3) return false;
  }
  for (let i = 0; i < end; i += 1) {
    const code = value.charCodeAt(i);
    const alphanumeric =
      (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (!alphanumeric && code !== 43 && code !== 47) return false; // "+" and "/"
  }
  return true;
}

/**
 * Validate ONE display payload at the boundary, in both directions: the worker checks what
 * Python handed it and the engine checks what the worker sent. Different trust boundaries -
 * Python is user code; the worker is a separate script a host could in principle swap.
 */
export function validateDisplay(
  candidate: unknown,
):
  | { ok: true; value: Omit<DisplayMessage, "kind" | "executionId"> }
  | { ok: false; error: string } {
  if (!candidate || typeof candidate !== "object") return { ok: false, error: "not an object" };
  const c = candidate as Record<string, unknown>;
  if (!isDisplayMime(c.mime)) return { ok: false, error: `unsupported mime ${String(c.mime)}` };
  if (!isDisplayEncoding(c.encoding)) {
    return { ok: false, error: `unsupported encoding ${String(c.encoding)}` };
  }
  if (typeof c.data !== "string") return { ok: false, error: "data must be a string" };
  // SIZE BEFORE VALIDITY, and before anything decodes it: a string this long has already been
  // cloned across `postMessage` once, and refusing here stops it being decoded, re-encoded into a
  // Blob and retained by the DOM as well. Text and images have separate budgets because a repr is
  // not a figure, and the message states the reason so the limit is discoverable.
  const limit = c.mime === "text/plain" ? MAX_DISPLAY_TEXT_CHARS : MAX_DISPLAY_ENCODED_CHARS;
  if (c.data.length > limit) {
    return {
      ok: false,
      error:
        `${c.mime} payload is ${Math.round(c.data.length / 1024 / 1024)} MiB, over the ` +
        `${Math.round(limit / 1024 / 1024)} MiB limit for one display. Reduce the figure size or ` +
        `dpi, or save it to a file in /workspace and download it instead.`,
    };
  }
  if (c.encoding === "base64" && !isCanonicalBase64(c.data)) {
    return { ok: false, error: "data is not valid base64" };
  }
  // A binary MIME must not arrive as text: a consumer branching on `mime` alone would then hand
  // raw bytes to a text node, or a text blob to an <img>.
  if (c.mime === "image/png" && c.encoding !== "base64") {
    return { ok: false, error: "image/png must be base64" };
  }
  if (c.mime === "text/plain" && c.encoding !== "utf8") {
    return { ok: false, error: "text/plain must be utf8" };
  }

  const value: Omit<DisplayMessage, "kind" | "executionId"> = {
    mime: c.mime,
    encoding: c.encoding,
    data: c.data,
  };
  const meta = c.metadata;
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    const out: NonNullable<DisplayMessage["metadata"]> = {};
    if (typeof m.figure === "number") out.figure = m.figure;
    if (typeof m.width === "number") out.width = m.width;
    if (typeof m.height === "number") out.height = m.height;
    if (Object.keys(out).length > 0) value.metadata = out;
  }
  return { ok: true, value };
}

/** A monotonic, collision-free id source. One per engine instance and one per worker. */
export function createIdFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
