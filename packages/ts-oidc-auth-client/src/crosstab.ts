import { fnv1a } from "./jwt.js";
import { SESSION_END_REASONS } from "./types.js";
import type { CrossTabMessage, SessionEndReason } from "./types.js";

/**
 * Cross-tab coordination. Two independent layers:
 *
 * 1. withCrossTabLock - serializes refresh across tabs via the Web Locks API
 *    when present; otherwise an in-page mutex (still gives per-tab
 *    single-flight; the message layer covers the rest).
 *
 * 2. CrossTab - BroadcastChannel with a localStorage fallback. The fallback
 *    key carries METADATA ONLY ({type, sessionVersion, exp, ...}); a JWT in
 *    localStorage is a bug by definition, in every storage mode.
 *
 * Inbound messages are schema-validated and freshness-bounded before they
 * reach the client. Any same-origin script can post to a BroadcastChannel or
 * write the localStorage key, so a malformed or replayed message must not be
 * able to drive the auth state machine into an odd corner. This is an
 * availability hardening only: same-origin hostile script already wins.
 */

const localChains = new Map<string, Promise<unknown>>();

/** Messages older than this (or from that far in the future) are ignored. */
const MESSAGE_MAX_AGE_MS = 5 * 60 * 1000;
/**
 * The same bound in seconds, for callers that keep state whose usefulness ends
 * when a message carrying it can no longer be accepted.
 */
export const MESSAGE_MAX_AGE_SECONDS = MESSAGE_MAX_AGE_MS / 1000;
/**
 * The freshness bound, in the SAME unit as every other timestamp that travels
 * in a message (`at`, `startedAt`): milliseconds since the Unix epoch, from
 * `Date.now()`. Deliberately not the client's injectable `now()` clock, which
 * is in seconds and exists to make token expiry testable.
 */
export const MESSAGE_MAX_AGE = MESSAGE_MAX_AGE_MS;

export async function withCrossTabLock<T>(
  name: string,
  useNavigatorLocks: boolean,
  fn: () => Promise<T>,
  /**
   * Key for the IN-PAGE fallback chain, when it differs from the cross-tab
   * lock name.
   *
   * Callers scope this by session generation. Serializing a rotation for a
   * session that no longer exists against one for the current session protects
   * nothing - the dead operation cannot store or return anything, its lease
   * having been invalidated - while making the live session wait on a request
   * that may never return. The cross-tab lock NAME is deliberately not scoped:
   * that lock exists so two tabs do not rotate at once, and generations are
   * per-tab counters that would silently stop tabs from coordinating.
   */
  chainKey: string = name,
): Promise<T> {
  const locks =
    useNavigatorLocks && typeof navigator !== "undefined"
      ? (navigator as Navigator & { locks?: LockManager }).locks
      : undefined;
  if (locks?.request) {
    return locks.request(name, fn) as Promise<T>;
  }
  const prev = localChains.get(chainKey) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Keep the chain alive regardless of fn's outcome. The map must store the
  // SAME promise the cleanup compares against, or the entry leaks forever.
  const chain = run.catch(() => undefined);
  localChains.set(chainKey, chain);
  try {
    return await run;
  } finally {
    if (localChains.get(chainKey) === chain) localChains.delete(chainKey);
  }
}

/** Test hook: number of in-page lock chains currently retained. */
export function pendingLocalLockChains(): number {
  return localChains.size;
}

interface LockManager {
  request<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
}

export function deriveChannelName(parts: {
  authBaseUrl: string;
  storageKey: string;
  namespace?: string;
}): string {
  const origin = typeof location !== "undefined" ? location.origin : "no-origin";
  return `poa:${fnv1a(
    [origin, parts.authBaseUrl, parts.namespace ?? "", parts.storageKey].join("|"),
  )}`;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface CrossTabHandle {
  post(message: DistributiveOmit<CrossTabMessage, "tabId" | "at">): void;
  close(): void;
  readonly tabId: string;
}

function isSessionEndReason(v: unknown): v is SessionEndReason {
  return (
    typeof v === "string" &&
    v.length <= 32 &&
    (SESSION_END_REASONS as readonly string[]).includes(v)
  );
}

/** A session fingerprint: short, opaque, and never JWT-shaped. */
function isPlausibleSessionVersion(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes(".")
  );
}

/**
 * Runtime schema + freshness check for anything arriving from another context.
 * Returns the narrowed message, or null when it must be ignored.
 */
export function parseCrossTabMessage(input: unknown, now: number): CrossTabMessage | null {
  if (!input || typeof input !== "object") return null;
  const m = input as Record<string, unknown>;
  if (typeof m.tabId !== "string" || m.tabId.length === 0) return null;
  if (typeof m.at !== "number" || !Number.isFinite(m.at)) return null;
  if (Math.abs(now - m.at) > MESSAGE_MAX_AGE_MS) return null;

  if (m.type === "logout" || m.type === "session-cleared") {
    // Closed union only. Free-form text from another context must never reach
    // an AuthEvent - it lands in console output and telemetry verbatim, and a
    // hostile same-origin script controls every byte of it.
    if (!isSessionEndReason(m.reason)) return null;
    // Bounded opaque id: hex only, short, and MANDATORY. A lifecycle message
    // that names no operation cannot be judged stale, duplicate, or relevant
    // to this tab's session at all, so accepting one lets an unidentified
    // message clear a newer session.
    if (typeof m.operationId !== "string" || !/^[0-9a-f]{1,32}$/.test(m.operationId)) {
      return null;
    }
    // Session binding is METADATA ONLY: a fingerprint, never a credential.
    let sessionVersion: string | undefined;
    if (m.sessionVersion !== undefined) {
      if (!isPlausibleSessionVersion(m.sessionVersion)) return null;
      sessionVersion = m.sessionVersion;
    }
    if (typeof m.startedAt !== "number" || !Number.isFinite(m.startedAt)) return null;
    return {
      type: m.type,
      tabId: m.tabId,
      reason: m.reason,
      operationId: m.operationId,
      sessionVersion,
      startedAt: m.startedAt,
      at: m.at,
    };
  }
  if (m.type === "token-updated") {
    if (!isPlausibleSessionVersion(m.sessionVersion)) return null;
    if (typeof m.exp !== "number" || !Number.isFinite(m.exp)) return null;
    return {
      type: "token-updated",
      tabId: m.tabId,
      sessionVersion: m.sessionVersion,
      exp: m.exp,
      at: m.at,
    };
  }
  return null;
}

export function createCrossTab(
  name: string,
  onMessage: (message: CrossTabMessage) => void,
): CrossTabHandle {
  const tabId = fnv1a(`${Math.random()}|${Date.now()}`);
  const storageKey = `${name}:sync`;

  const accept = (raw: unknown): void => {
    const msg = parseCrossTabMessage(raw, Date.now());
    if (!msg || msg.tabId === tabId) return;
    safeDeliver(onMessage, msg);
  };

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(name);
    channel.onmessage = (ev: MessageEvent) => accept(ev.data);
  }

  const storageListener = (ev: StorageEvent) => {
    if (ev.key !== storageKey || !ev.newValue) return;
    try {
      accept(JSON.parse(ev.newValue));
    } catch {
      /* malformed sync key: ignore */
    }
  };
  const hasWindow = typeof window !== "undefined";
  if (hasWindow) window.addEventListener("storage", storageListener);

  return {
    tabId,
    post(message) {
      const full = { ...message, tabId, at: Date.now() } as CrossTabMessage;
      assertNoToken(full);
      if (channel) {
        try {
          channel.postMessage(full);
        } catch {
          /* channel closed */
        }
      } else if (hasWindow && typeof localStorage !== "undefined") {
        // TRUE fallback, not a second active path: in browsers with both
        // mechanisms a dual send would deliver every logout/token-updated
        // twice. Mixed-capability tabs cannot exist within one browser, so
        // exclusive-sender is safe. Storage events fire in OTHER tabs only -
        // exactly what we want; the nonce makes identical payloads distinct.
        try {
          localStorage.setItem(storageKey, JSON.stringify({ ...full, nonce: Math.random() }));
        } catch {
          /* quota/disabled: per-tab single-flight still applies */
        }
      }
    },
    close() {
      try {
        channel?.close();
      } catch {
        /* already closed */
      }
      if (hasWindow) window.removeEventListener("storage", storageListener);
    },
  };
}

function safeDeliver(fn: (m: CrossTabMessage) => void, msg: CrossTabMessage): void {
  try {
    fn(msg);
  } catch {
    /* receiver errors must not break other tabs */
  }
}

/** Defense in depth: refuse to broadcast anything that smells like a JWT. */
function assertNoToken(msg: Record<string, unknown>): void {
  for (const value of Object.values(msg)) {
    if (typeof value === "string" && value.length > 64 && value.split(".").length === 3) {
      throw new Error("CrossTab message appears to contain a token; refusing to broadcast.");
    }
  }
}
