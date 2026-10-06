// The shared sign-in callback's relay protocol, the tab's half: a popup opened for signing in or
// out carries a record (written here into its session storage while it is still a same-origin
// blank page) naming the attempt and its purpose; the callback page it returns to takes that
// record once and answers on a channel named after the attempt, so only the tab that opened it
// hears the response, and only that tab - which owns the login transaction - exchanges the code.
//
// The callback pages that speak it: the portal's `auth/callback/` route and the notebook origin's
// copy (`@freva-org/portal-builder`, `client/auth-relay.ts`), and this package's own
// `callback/freva-login-callback.html`. A contract test keeps them in step.

export const RELAY_KEY = "freva-auth:relay";
export const RELAY_CHANNEL_PREFIX = "freva-auth-callback.";
export const RELAY_MESSAGE = "freva-auth-callback";
export const RELAY_TTL_MS = 10 * 60 * 1000;
/** The tab's answer that it received a response: the popup closes only on it. */
export const RELAY_ACK = "freva-auth-callback-ack";

export type RelayPurpose = "login" | "logout";

export interface RelayContext {
  v: 1;
  attempt: string;
  purpose: RelayPurpose;
  expires: number;
}

/**
 * What the callback page posts on `${RELAY_CHANNEL_PREFIX}${attempt}` and to its opener. Without
 * `attempt` when the popup had no record (a notebook framed by another site, whose storage the
 * popup does not share): then only its opener receives it.
 */
export interface RelayMessage {
  type: typeof RELAY_MESSAGE;
  v: 1;
  attempt?: string;
  purpose: RelayPurpose;
  outcome: "response" | "expired";
  url?: string;
}

const ATTEMPT = /^[0-9a-f]{32}$/;

export function newAttemptId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Records the attempt in the popup's session storage. False when the popup's storage refused. */
export function writeRelay(
  popup: Window,
  attempt: string,
  purpose: RelayPurpose,
  now = Date.now(),
): boolean {
  const record: RelayContext = { v: 1, attempt, purpose, expires: now + RELAY_TTL_MS };
  try {
    popup.sessionStorage.setItem(RELAY_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** The tab's acknowledgement of a response for `attempt` (none for an attempt-less one). */
export function relayAck(attempt: string | undefined): {
  type: typeof RELAY_ACK;
  v: 1;
  attempt?: string;
} {
  return { type: RELAY_ACK, v: 1, ...(attempt ? { attempt } : {}) };
}

/**
 * A message for `attempt`, checked: the shape, the attempt, the purpose, and for a sign-in
 * response a URL on exactly `callbackUrl` (origin and path). Null for anything else. A message
 * without an attempt is accepted only `fromPopup`: posted by the very window this tab opened for
 * this attempt (the caller compares `event.source`), which is as specific as the attempt.
 */
export function acceptRelayMessage(
  data: unknown,
  attempt: string,
  purpose: RelayPurpose,
  callbackUrl: string,
  fromPopup = false,
): RelayMessage | null {
  if (!data || typeof data !== "object" || !ATTEMPT.test(attempt)) return null;
  const message = data as Partial<RelayMessage>;
  if (message.type !== RELAY_MESSAGE || message.v !== 1) return null;
  if (message.purpose !== purpose) return null;
  if (message.attempt !== attempt && !(fromPopup && message.attempt === undefined)) return null;
  if (message.outcome === "expired") {
    return { type: RELAY_MESSAGE, v: 1, attempt, purpose, outcome: "expired" };
  }
  if (message.outcome !== "response") return null;
  if (purpose === "logout") {
    return { type: RELAY_MESSAGE, v: 1, attempt, purpose, outcome: "response" };
  }
  if (typeof message.url !== "string" || message.url.length > 8192) return null;
  try {
    const url = new URL(message.url);
    const expected = new URL(callbackUrl);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) return null;
    return { type: RELAY_MESSAGE, v: 1, attempt, purpose, outcome: "response", url: url.href };
  } catch {
    return null;
  }
}

/** What the provider said about a sign-in it did not grant, in a sentence; null with a code. */
export function refusal(url: string): string | null {
  let error: string | null = null;
  try {
    error = new URL(url).searchParams.get("error");
  } catch {
    return null;
  }
  if (!error) return null;
  if (error === "access_denied") return "The sign-in was cancelled.";
  if (error === "login_required" || error === "interaction_required") {
    return "Freva needs you to sign in again.";
  }
  return `Freva did not accept the sign-in (${error}).`;
}
