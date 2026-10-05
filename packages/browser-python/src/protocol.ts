/**
 * protocol.ts - the wire between the page and the worker.
 *
 * Every request carries an `id` and every reply carries the id it answers; a single
 * `pendingResolve` settles the wrong promise, silently, as soon as two lifecycle events overlap.
 * Output events carry `executionId` and the worker emits them in order, so a UI can attribute a
 * line to the block that produced it. Everything crossing `postMessage` is structured-cloneable
 * - no PyProxy - except `ArtifactDataMessage.blob`, a reference into the blob store.
 */

import type { NoticeKind } from "./notices.js";
import { NOTICE_MIME } from "./types.js";
import type {
  ArtifactInfo,
  BrowserPythonAddon,
  BrowserPythonProfile,
  BrowserPythonReadyInfo,
  BrowserPythonState,
  BundleMetadata,
  BundleMime,
  CellResult,
  CompletionResult,
  DisplayMime,
  MimeBundle,
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
 * no Dask in it; a v4 worker treats every add-on as required and refuses to start. v6 added
 * notebook cells, MIME bundles, workspace imports and resource samples.
 */
export const PROTOCOL_VERSION = 6;

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

/** One notebook cell. Answered by `cell-reply`; output arrives between, tagged `executionId`. */
export interface ExecuteCellRequest {
  kind: "execute-cell";
  id: string;
  executionId: string;
  source: string;
  token?: string;
  silent: boolean;
  storeHistory: boolean;
  filename?: string;
}

/** Answered from outside the queue, like `interrupt`: a sample must not wait behind a cell. */
export interface ResourcesRequest {
  kind: "resources";
  id: string;
}

/** Bytes INTO `/workspace`, one bounded chunk at a time: see `BrowserPython.writeWorkspaceFile`. */
export interface WorkspaceImportOpenRequest {
  kind: "import-open";
  id: string;
  name: string;
  size: number;
  overwrite: boolean;
}

export interface WorkspaceImportChunkRequest {
  kind: "import-chunk";
  id: string;
  handle: string;
  offset: number;
  bytes: ArrayBuffer;
}

export interface WorkspaceImportCloseRequest {
  kind: "import-close";
  id: string;
  handle: string;
  commit: boolean;
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
  | ExecuteCellRequest
  | ResourcesRequest
  | WorkspaceImportOpenRequest
  | WorkspaceImportChunkRequest
  | WorkspaceImportCloseRequest
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
  /** See `StreamEvent.notice`. */
  notice?: NoticeKind;
}

export interface DisplayMessage {
  kind: "display";
  executionId: string;
  mime: DisplayMime;
  encoding: "base64" | "utf8";
  data: string;
  metadata?: { figure?: number; width?: number; height?: number };
}

/** A cell started: always before any of its output. */
export interface CellStartMessage {
  kind: "execute-input";
  executionId: string;
  token?: string;
  executionCount: number | null;
}

/** Shaped as the `BundleEvent` it becomes, plus `kind`. */
export interface BundleMessage {
  kind: "bundle";
  type: "display_data" | "execute_result";
  executionId: string;
  data: MimeBundle;
  metadata?: BundleMetadata;
  executionCount?: number | null;
  background?: true;
}

export interface ClearOutputMessage {
  kind: "clear-output";
  executionId: string;
  wait: boolean;
  background?: true;
}

/** A cell's exception, once, in order with its output. `text` is the traceback joined. */
export interface CellErrorMessage {
  kind: "cell-error";
  executionId: string;
  text: string;
  ename: string;
  evalue: string;
  traceback: readonly string[];
}

export interface CellReplyMessage {
  kind: "cell-reply";
  id: string;
  result: CellResult;
}

/** What only the worker can measure. Absent fields are unknown, never zero. */
export interface WorkerResourceSample {
  wasmCapacityBytes?: number;
  workspaceBytes?: number;
  fetchedDecodedBytes?: number;
  transferBytesEstimate?: number;
}

export interface ResourcesReplyMessage {
  kind: "resources-reply";
  id: string;
  sample: WorkerResourceSample;
}

export interface ImportHandleMessage {
  kind: "import-handle";
  id: string;
  handle: string;
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
  | CellStartMessage
  | BundleMessage
  | ClearOutputMessage
  | CellErrorMessage
  | CellReplyMessage
  | ResourcesReplyMessage
  | ImportHandleMessage
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

/** What a bundle may carry: the display types plus markup and the typed notice. */
export const BUNDLE_MIMES: readonly BundleMime[] = [
  ...DISPLAY_MIMES,
  "text/html",
  "image/svg+xml",
  NOTICE_MIME,
];

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

/** One `text/html` representation: markup to parse. A pandas or xarray repr is tens of KiB. */
export const MAX_DISPLAY_HTML_CHARS = 1024 * 1024;

/** One `image/svg+xml` representation. */
export const MAX_DISPLAY_SVG_CHARS = 4 * 1024 * 1024;

/** One notice: a kind and a paragraph. */
export const MAX_DISPLAY_NOTICE_CHARS = 16 * 1024;

/** Every representation of ONE bundle together. Mirrored in `rich_display.py`. */
export const MAX_BUNDLE_CHARS = 24 * 1024 * 1024;

/** A cell's traceback, all lines together. A deep recursion is not worth a frozen tab. */
export const MAX_TRACEBACK_CHARS = 256 * 1024;

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
 * True for a MIME type a single `display` event will carry. Short deliberately: `text/html` and
 * `image/svg+xml` carry script, so they travel only inside bundles (`isBundleMime`), and only reach
 * a DOM through the sanitiser in `@freva-org/browser-python/display`.
 */
export function isDisplayMime(value: unknown): value is DisplayMime {
  return typeof value === "string" && (DISPLAY_MIMES as readonly string[]).includes(value);
}

export function isBundleMime(value: unknown): value is BundleMime {
  return typeof value === "string" && (BUNDLE_MIMES as readonly string[]).includes(value);
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
  const problem = checkRepresentation(c.mime, c.data, c.encoding);
  if (problem) return { ok: false, error: problem };

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

/** The per-representation limit, in characters. */
const LIMITS: Partial<Record<BundleMime, number>> = {
  "text/plain": MAX_DISPLAY_TEXT_CHARS,
  "text/html": MAX_DISPLAY_HTML_CHARS,
  "image/svg+xml": MAX_DISPLAY_SVG_CHARS,
  [NOTICE_MIME]: MAX_DISPLAY_NOTICE_CHARS,
};

export function displayLimit(mime: BundleMime): number {
  return LIMITS[mime] ?? MAX_DISPLAY_ENCODED_CHARS;
}

const mib = (chars: number): string => `${(chars / 1048576).toFixed(1)} MiB`;

/** Size, encoding and shape of one representation; null when it may be carried. */
function checkRepresentation(mime: BundleMime, data: string, encoding: string): string | null {
  const limit = displayLimit(mime);
  if (data.length > limit) {
    return (
      `${mime} payload is ${mib(data.length)}, over the ${mib(limit)} limit for one display. ` +
      `Reduce the figure size or dpi, or save it to a file in /workspace and download it instead.`
    );
  }
  // A binary MIME must not arrive as text: a consumer branching on `mime` alone would then hand
  // raw bytes to a text node, or a text blob to an <img>.
  if (mime === "image/png") {
    return encoding !== "base64"
      ? "image/png must be base64"
      : isCanonicalBase64(data)
        ? null
        : "data is not valid base64";
  }
  // A notice's JSON is parsed - and refused when malformed - where it is drawn (`renderNotice`).
  return encoding !== "utf8" ? `${mime} must be utf8` : null;
}

/**
 * Validate one MIME bundle, at both boundaries. Every key must be a carried MIME type and
 * `text/plain` must be present: Python only ever sends those, so anything else is forged and the
 * whole bundle is refused rather than partly shown. Metadata keeps pixel sizes only.
 */
export function validateBundle(
  candidate: unknown,
):
  | { ok: true; value: { data: MimeBundle; metadata: BundleMetadata } }
  | { ok: false; error: string } {
  const c = (candidate ?? {}) as { data?: unknown; metadata?: Record<string, unknown> };
  if (!c.data || typeof c.data !== "object") return { ok: false, error: "data must be an object" };
  const data: Record<string, string> = {};
  const metadata: Record<string, Record<string, number>> = {};
  let total = 0;
  // An array's keys are "0", "1", …: refused below as unsupported MIME types.
  for (const [mime, value] of Object.entries(c.data)) {
    const error = !isBundleMime(mime)
      ? `unsupported mime ${mime}`
      : typeof value !== "string"
        ? `${mime} must be a string`
        : checkRepresentation(mime, value, mime === "image/png" ? "base64" : "utf8");
    if (error) return { ok: false, error };
    total += (data[mime] = value as string).length;
    const meta = (c.metadata?.[mime] ?? {}) as Record<string, unknown>;
    const sizes = Object.fromEntries(
      ["width", "height"]
        .map((key) => [key, meta[key]] as const)
        .filter(([, n]) => typeof n === "number" && n > 0 && n <= 100_000),
    ) as Record<string, number>;
    if (Object.keys(sizes).length > 0) metadata[mime] = sizes;
  }
  if (typeof data["text/plain"] !== "string") return { ok: false, error: "text/plain is missing" };
  if (total > MAX_BUNDLE_CHARS) {
    return {
      ok: false,
      error: `one output is ${mib(total)}, over the ${mib(MAX_BUNDLE_CHARS)} limit`,
    };
  }
  return { ok: true, value: { data: data as MimeBundle, metadata: metadata as BundleMetadata } };
}

/** Bound a traceback to {@link MAX_TRACEBACK_CHARS}, keeping its head and saying what was cut. */
export function boundTraceback(lines: readonly unknown[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const text = String(line);
    if (used + text.length > MAX_TRACEBACK_CHARS) {
      out.push(`[browser-python] traceback truncated: ${lines.length - out.length} lines omitted`);
      break;
    }
    used += text.length + 1;
    out.push(text);
  }
  return out;
}

/** A monotonic, collision-free id source. One per engine instance and one per worker. */
export function createIdFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
