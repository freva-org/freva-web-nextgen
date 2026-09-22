/**
 * The parent/child protocol for a two-origin embedding, and nothing else.
 *
 * WHY A SECOND ORIGIN. A Worker removes DOM access; it does not remove ORIGIN AUTHORITY. Visitor
 * Python and any package it installs run with the interpreter origin's full authority: fetch with
 * its cookies where CORS allows, read and write its IndexedDB, Cache Storage and OPFS, open
 * Workers on it. On the portal's own origin that is the portal's authority handed to arbitrary
 * user code. This module is the CONTRACT and carries no policy of its own. It protects the
 * PORTAL's credentials and storage, not a Freva token from code run beside it - a token from
 * `authenticate()` lives in the interpreter, and a broad `connect-src https:` lets anything there
 * transmit it. See the README's threat model.
 *
 * WHAT NEVER CROSSES. Artifact METADATA and artifact BYTES, in that order; the other way, the
 * NAME of a snippet the child already has. No token, no credential, and above all NO SOURCE -
 * `run-example` carries an id and a digest, so a peer can only ask for a snippet the child's own
 * build-time manifest already holds; see `./examples.ts` for what the digest proves. NOT a
 * defence against availability: a child that floods the parent with well-formed messages can
 * still make the portal page do work.
 */

/**
 * Bumped whenever a message shape changes in a way an older peer would misread. Checked on EVERY
 * message rather than only at the handshake: a page can be reloaded while its frame is not, a
 * deployment can update one half before the other, and a mismatch assumed for the rest of a
 * session is a mismatch that is not caught.
 */
export const EMBED_PROTOCOL_VERSION = 3;

export { MAX_TRANSCRIPT_CHARS } from "../transcript-limit.js";
import { MAX_TRANSCRIPT_CHARS } from "../transcript-limit.js";

/**
 * The bounded operations a parent may ask a playground to perform on itself. A CLOSED LIST, and
 * that is the whole design: the parent cannot reach into another origin's document, and the
 * tempting fix is a general "evaluate this" message - the remote code execution surface this
 * protocol exists not to have. Each operation is a NAME with no arguments. `transcript` asks for
 * the child's transcript, bounded (see `MAX_TRANSCRIPT_CHARS`); `clear-transcript` and
 * `clear-history` are the child's own console operations; `restart` brings up a new interpreter
 * in the same document, so unlike reloading the frame the session survives.
 */
export type BridgeOp = "transcript" | "clear-transcript" | "clear-history" | "restart";

/** The operation names, for validating a payload that arrived from a peer. */
const BRIDGE_OPS = new Set<string>(["transcript", "clear-transcript", "clear-history", "restart"]);

/** Whether an unknown value is one of the four operation names. */
export function isBridgeOp(value: unknown): value is BridgeOp {
  return typeof value === "string" && BRIDGE_OPS.has(value);
}

/** Every message carries this, so unrelated `postMessage` traffic is ignored rather than parsed. */
export const EMBED_CHANNEL = "freva-python-embed";

/** Artifact metadata: what the parent may know about a file. Bytes are not in it. */
export interface EmbeddedArtifact {
  name: string;
  size: number;
  mime: string;
  /** The engine's own artifact states, passed through unchanged. */
  state: "ready" | "open" | "failed" | "transferring";
  modifiedMs: number;
}

interface Envelope {
  channel: typeof EMBED_CHANNEL;
  version: number;
  /**
   * The parent-owned handshake nonce this message belongs to. A navigated iframe keeps the SAME
   * `contentWindow` while the document behind it is new, so binding every message to the first
   * session learned would filter out the new document's `hello`; "accept every hello" gives the
   * session away to anything that can reach the parent. Renewal is bound to a nonce the PARENT
   * owns and regenerates on construction, on every `load` of its frame, and whenever it re-hails.
   */
  challenge: string;
  /** Identifies THIS frame instance. A reloaded playground is a different session. */
  sessionId: string;
}

/** child -> parent, without the envelope the sender adds. */
export type PlaygroundPayload =
  /** "I exist." Carries no challenge yet; it only prompts the parent to hail. */
  | { kind: "hello" }
  /** The answer to a specific hail. THIS is what establishes a session. */
  | { kind: "ready" }
  | { kind: "artifacts"; artifacts: EmbeddedArtifact[] }
  | { kind: "download-refused"; requestId: string; reason: string }
  /** The named example was resolved in this child's manifest and handed to the interpreter. */
  | { kind: "example-accepted"; exampleId: string }
  /**
   * It was not, and why. Reported rather than swallowed: the usual cause is a portal and a
   * playground from two different deployments, and a button that silently does nothing is the
   * hardest possible way to discover that.
   */
  | { kind: "example-refused"; exampleId: string; reason: string }
  /**
   * The child's transcript, bounded and marked when it had to be cut. Pushed on change as well as
   * on request, so the parent's Copy control can be SYNCHRONOUS: writing to the clipboard needs
   * the visitor's activation, which does not survive an `await` on a cross-origin round trip.
   * `truncated` says the OLDEST end was dropped, the end the console's own pruning drops, so what
   * survives is the most recent output.
   */
  | { kind: "transcript"; text: string; truncated: boolean }
  /** The answer to one `op`. `ok: false` carries a reason a portal can show a visitor. */
  | { kind: "op-result"; requestId: string; ok: boolean; message?: string };

/** child -> parent */
export type PlaygroundMessage = Envelope & PlaygroundPayload;

/** parent -> child, without the envelope the sender adds. */
export type HostPayload =
  /** "Answer this nonce with your session." The only thing that starts or renews a session. */
  | { kind: "hail" }
  | { kind: "list" }
  | { kind: "download"; requestId: string; name: string; chunkBytes?: number }
  /**
   * "Run the example you know by this name." The three fields are the whole payload, and there is
   * deliberately nowhere in it to put Python. `targetSession` lets a portal running more than one
   * playground address a specific one; a child whose session id is not the one named ignores it.
   */
  | { kind: "run-example"; exampleId: string; digest: string; targetSession?: string }
  /**
   * "Perform this operation on yourself." One of four names and a request id, with nowhere to put
   * a command, a method name or a payload. See `BridgeOp`.
   */
  | { kind: "op"; requestId: string; op: BridgeOp; targetSession?: string };

/** parent -> child */
export type HostMessage = Envelope & HostPayload;

/** child -> parent, over the dedicated MessagePort for one download. */
export type ChunkMessage =
  | { kind: "chunk"; bytes: ArrayBuffer }
  | { kind: "done"; bytesWritten: number }
  | { kind: "error"; message: string };

/**
 * parent -> child, over the same port. One ack per chunk: that IS the backpressure.
 *
 * `cancel` is not a courtesy. Closing a `MessagePort` does NOT notify the peer, so a parent that
 * gave up and closed its end would leave the child streaming into nothing - holding a lease, and
 * therefore holding an artifact frozen - until its own transfer finished.
 */
export type ChunkAck = { kind: "ack" } | { kind: "cancel"; reason: string };

/**
 * Is this a message from the peer we are talking to, in the shape we understand? Five checks, all
 * load-bearing:
 *
 *  * `origin` - the exact expected origin string. Not a prefix, not a suffix, not `*`. An
 *    `endsWith` check on "portal.example" also matches "evil-portal.example".
 *  * `source` - the exact `Window` expected. Any frame on the peer origin has that origin.
 *  * `channel` and `version` - unrelated traffic on the same window is ignored rather than parsed,
 *    and a peer from another release is refused rather than half-understood.
 *  * `sessionId` - a reply for a previous instance of the frame cannot reach the current one.
 *  * `challenge` - a session is established or renewed only by answering a nonce the parent issued.
 */
export function accepted(
  event: MessageEvent,
  expect: {
    origin: string;
    source: unknown;
    sessionId?: string | undefined;
    challenge?: string | undefined;
  },
): boolean {
  if (event.origin !== expect.origin) return false;
  if (expect.source !== undefined && event.source !== expect.source) return false;
  const data = event.data as Partial<Envelope> | null;
  if (!data || typeof data !== "object") return false;
  if (data.channel !== EMBED_CHANNEL) return false;
  if (data.version !== EMBED_PROTOCOL_VERSION) return false;
  if (expect.sessionId !== undefined && data.sessionId !== expect.sessionId) return false;
  if (expect.challenge !== undefined && data.challenge !== expect.challenge) return false;
  return true;
}

/**
 * Is this really artifact metadata, from a peer that may be lying or simply broken? A cross-origin
 * payload is DATA, and a structured clone preserves whatever the other side put in it - a size of
 * `NaN`, a name that is a number, a `state` nobody defined. Checked at the boundary rather than
 * where it is used, so a bad entry never becomes a `NaN` byte budget or a picker opened for a
 * file that is still being written.
 */
export function isEmbeddedArtifact(value: unknown): value is EmbeddedArtifact {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  if (typeof a.name !== "string" || a.name.length === 0) return false;
  if (typeof a.mime !== "string") return false;
  if (typeof a.size !== "number" || !Number.isSafeInteger(a.size) || a.size < 0) return false;
  if (typeof a.modifiedMs !== "number" || !Number.isFinite(a.modifiedMs)) return false;
  return (
    a.state === "ready" || a.state === "open" || a.state === "failed" || a.state === "transferring"
  );
}

/**
 * A transcript a peer sent, bounded before it is believed. The child bounds what it sends; this
 * bounds what the parent accepts, because the two are not the same claim - a string is the one
 * payload in this protocol whose size is entirely the sender's choice. Cut from the OLDEST end,
 * matching the console's own pruning, so what survives is the most recent output.
 */
export function boundTranscript(value: unknown): { text: string; truncated: boolean } | null {
  if (typeof value !== "string") return null;
  if (value.length <= MAX_TRANSCRIPT_CHARS) return { text: value, truncated: false };
  return { text: value.slice(value.length - MAX_TRANSCRIPT_CHARS), truncated: true };
}

/** A byte count a peer sent: a non-negative safe integer, and nothing else. */
export function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The last path segment of an artifact name, for use as a suggested filename. A workspace name may
 * contain separators, and handing one to `showSaveFilePicker` as `suggestedName` is at best
 * rejected and at worst a path the visitor did not choose. Returns `null` for anything unusable -
 * `.`, `..`, or a name that is all separators - so a caller refuses rather than inventing one.
 */
export function basename(name: string): string | null {
  const last = name.split(/[/\\]/).pop() ?? "";
  if (last === "" || last === "." || last === "..") return null;
  return last;
}

/**
 * A protocol identity: a session id, or a handshake challenge. CRYPTOGRAPHIC, with no fallback -
 * `Math.random().toString(36)` is a predictable value standing in for the thing that decides
 * whether a message is accepted, not seeded for unpredictability and recoverable from a handful
 * of outputs. Both APIs used here exist in every context this package runs in (secure contexts,
 * which a Worker and OPFS already require), so a missing one should be reported.
 */
export function newIdentity(): string {
  const crypto = globalThis.crypto as
    | { randomUUID?: () => string; getRandomValues?: <T>(array: T) => T }
    | undefined;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  throw new Error(
    "The embedding bridge needs crypto.randomUUID() or crypto.getRandomValues() for its session " +
      "and challenge identities, and this context has neither. It will not substitute " +
      "Math.random(): a predictable identity is not an identity.",
  );
}

/** A per-frame identity. */
export const newSessionId = newIdentity;

/** A parent-owned handshake nonce. Regenerated on construction and on every frame navigation. */
export const newChallenge = newIdentity;
