// The sign-in callback, shared: one page at `<base path><callbackPath>` (default
// `auth/callback/`) answers the portal's same-tab sign-in and a notebook's popup sign-in, and the
// returns from signing out, from one place. The portal's route runs it with its same-tab handler
// (`components/auth-callback.ts`); a notebook origin's copy runs it without one.
//
// WHICH FLOW is read from what the starting window recorded, never guessed from the response:
//
// - A popup carries its own record (`RELAY_KEY`, in the popup's session storage, written by the
//   tab that opened it): the response is handed to that tab alone, on a channel named after its
//   attempt AND by `postMessage` to the window that opened the popup (same origin only). The tab
//   owns the login transaction (state, PKCE, issuer), acknowledges, and exchanges the code;
//   nothing here does, so no code is exchanged twice and no other tab can take it. The popup
//   closes once the tab has acknowledged; without an acknowledgement it says so and stays.
// - Two transports because neither always arrives. A notebook framed by a page of ANOTHER SITE
//   has its storage and its channels partitioned under that site, so neither the record nor the
//   channel reaches the popup, which is a top-level page; the opener's `postMessage` does, unless
//   the provider's Cross-Origin-Opener-Policy severed the opener. A popup with no record but an
//   opener therefore hands the response to its opener, which accepts it only from the popup it
//   opened. Where neither reaches, the page says to open the notebook in its own tab.
// - A same-tab sign-in has its transaction in this tab (the auth client's own record): the
//   portal's handler exchanges it here and returns to the validated page it started on.
// - A same-tab sign-out recorded where to return (`RETURN_KEY`).
// - Anything else is a direct visit: a neutral message and a link home.
//
// Each record is taken once (read and removed), and expires: a popup reloaded, or a response that
// arrives after the record ran out, is reported, never relayed or exchanged.
//
// The same protocol is spoken by `@freva-org/jupyterlite-climateclaw` (its `auth-relay` module,
// and its shipped callback page); a contract test keeps the two in step.

/** Session storage key of a popup's record: which sign-in (or sign-out) it was opened for. */
export const RELAY_KEY = "freva-auth:relay";
/** Session storage key of a same-tab sign-out: where to return. */
export const RETURN_KEY = "freva-auth:logout-return";
/** A popup's response goes out on `${RELAY_CHANNEL_PREFIX}${attempt}`. */
export const RELAY_CHANNEL_PREFIX = "freva-auth-callback.";
export const RELAY_MESSAGE = "freva-auth-callback";
/** How long a record is good for. */
export const RELAY_TTL_MS = 10 * 60 * 1000;
/** The tab's answer that it received a response. */
export const RELAY_ACK = "freva-auth-callback-ack";
/** How long the popup waits for that answer before saying the response did not arrive. */
export const ACK_TIMEOUT_MS = 4000;

export type RelayPurpose = "login" | "logout";

export interface RelayContext {
  v: 1;
  /** 32 hex characters, from the starting tab. */
  attempt: string;
  purpose: RelayPurpose;
  /** Epoch milliseconds. */
  expires: number;
}

export interface RelayMessage {
  type: typeof RELAY_MESSAGE;
  v: 1;
  /** Absent when the popup had no record (a partitioned frame) and answers its opener only. */
  attempt?: string;
  purpose: RelayPurpose;
  /** "response": the provider answered (`url` for a sign-in); "expired": the record ran out. */
  outcome: "response" | "expired";
  url?: string;
}

interface ReturnContext {
  v: 1;
  /** A path on this deployment. */
  returnTo: string;
  expires: number;
}

const ATTEMPT = /^[0-9a-f]{32}$/;
/** Parameters that make a URL an authorization response. */
const RESPONSE_PARAMS = ["code", "state", "error", "iss", "session_state"];

/** The callback's URL: this origin, the deployment's base path, the configured callback path. */
export function callbackUrl(origin: string, basePath: string, callbackPath: string): string {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const path = callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`;
  return new URL(`${base}${path}`, origin).href;
}

/** A record read once: removed whatever it held. `expired` for one that ran out. */
export function takeRecord<T extends { expires: number }>(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
  now: number,
  valid: (value: Record<string, unknown>) => boolean,
): { record: T; expired: boolean } | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
    storage.removeItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.expires !== "number" || !valid(record)) return null;
  return { record: record as unknown as T, expired: record.expires < now };
}

export const isRelayContext = (value: Record<string, unknown>): boolean =>
  typeof value.attempt === "string" &&
  ATTEMPT.test(value.attempt) &&
  (value.purpose === "login" || value.purpose === "logout");

/** Whether `url` is an authorization response (query or fragment). */
export function isResponse(url: URL): boolean {
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  return RESPONSE_PARAMS.some((key) => url.searchParams.has(key) || fragment.has(key));
}

/** What the provider said, in a sentence for the page: null for a response with a code. */
export function responseError(url: URL): string | null {
  const error = url.searchParams.get("error");
  if (!error) return null;
  if (error === "access_denied") return "The sign-in was cancelled.";
  if (error === "login_required" || error === "interaction_required") {
    return "Freva needs you to sign in again.";
  }
  // The provider's own description is not repeated: it controls that text.
  return `Freva did not accept the sign-in (${error}).`;
}

/** A same-origin path on this deployment, or null. */
export function deploymentPath(value: unknown, basePath: string, origin: string): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  // No control characters, backslashes or whitespace.
  if ([...value].some((c) => c.charCodeAt(0) < 0x20 || c === "\\" || /\s/.test(c))) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return null;
    const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
    const path = `${url.pathname}${url.search}${url.hash}`;
    return url.pathname === base.slice(0, -1) || url.pathname.startsWith(base) ? path : null;
  } catch {
    return null;
  }
}

/** Records a same-tab sign-out's return before the tab leaves for the provider. */
export function recordLogoutReturn(
  storage: Pick<Storage, "setItem">,
  returnTo: string,
  now: number,
): void {
  const record: ReturnContext = { v: 1, returnTo, expires: now + RELAY_TTL_MS };
  try {
    storage.setItem(RETURN_KEY, JSON.stringify(record));
  } catch {
    // Without it the callback sends the tab home.
  }
}

export type CallbackState = "working" | "done" | "error" | "idle";

/** A channel as the page uses it. */
export interface RelayChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

/** What the page needs from its window (injected, so it can be tested). */
export interface CallbackEnv {
  href: string;
  origin: string;
  sessionStorage: Pick<Storage, "getItem" | "removeItem">;
  /** Replaces the address bar's URL (history.replaceState). */
  scrub(path: string): void;
  channel(name: string): RelayChannel | null;
  /** The window that opened this popup, when it is still there; null otherwise. */
  opener(): { postMessage(message: unknown, targetOrigin: string): void } | null;
  /** Messages from the opener, on this origin only; returns the teardown. */
  onOpenerMessage(listener: (data: unknown) => void): () => void;
  wait(ms: number): Promise<void>;
  /** Leaves for `path` (location.replace). */
  go(path: string): void;
  /** Closes this window (a popup), after the page said what happened. */
  close(): void;
  say(state: CallbackState, message: string, link?: { href: string; label: string }): void;
  now(): number;
}

export interface CallbackOptions {
  /** The deployment's base path ("/" or "/showroom/"). */
  basePath: string;
  /** Where "home" is for a direct visit or a failure. */
  home: { href: string; label: string };
  /**
   * The same-tab sign-in, when this deployment has one: exchanges the response this tab started
   * and returns the path to go back to. Throws for a response this tab has no transaction for.
   */
  sameTab?: (href: string) => Promise<string | null>;
}

const NOT_HANDED_BACK =
  "This sign-in could not be handed back to the notebook. If the notebook is shown inside " +
  "another site's page, open it in its own tab and sign in there.";

/**
 * Hands `message` to the tab: on the attempt's channel (when there is an attempt) and to the
 * opener (same origin only). With `ack`, waits for the tab's acknowledgement and says whether it
 * came; without, sends and returns.
 */
async function handOver(env: CallbackEnv, message: RelayMessage, ack: boolean): Promise<boolean> {
  const channel = message.attempt ? env.channel(`${RELAY_CHANNEL_PREFIX}${message.attempt}`) : null;
  const opener = env.opener();
  let acknowledged!: () => void;
  const answered = new Promise<boolean>((resolve) => (acknowledged = () => resolve(true)));
  const isAck = (data: unknown) => {
    const value = data as { type?: unknown; v?: unknown; attempt?: unknown } | null;
    return (
      value?.type === RELAY_ACK &&
      value.v === 1 &&
      (message.attempt ? value.attempt === message.attempt : true)
    );
  };
  if (ack) channel?.addEventListener("message", (event) => isAck(event.data) && acknowledged());
  const stop = ack ? env.onOpenerMessage((data) => isAck(data) && acknowledged()) : () => {};
  channel?.postMessage(message);
  try {
    opener?.postMessage(message, env.origin);
  } catch {
    // A severed or closed opener: the channel is the only way.
  }
  const reached = !ack
    ? Boolean(channel || opener)
    : channel || opener
      ? await Promise.race([answered, env.wait(ACK_TIMEOUT_MS).then(() => false)])
      : false;
  stop();
  channel?.close();
  return reached;
}

/** Runs the callback page. Resolves when it has said or done what it does. */
export async function runCallback(env: CallbackEnv, options: CallbackOptions): Promise<void> {
  // FIRST, before anything renders: the response leaves the address bar and the history.
  const href = env.href;
  const url = new URL(href);
  env.scrub(url.pathname);
  const response = isResponse(url);
  const refused = responseError(url);
  const home = options.home;

  // 1. A popup with a record: hand the response to the tab that opened it, by its attempt.
  const taken = takeRecord<RelayContext>(env.sessionStorage, RELAY_KEY, env.now(), isRelayContext);
  if (taken) {
    const { record, expired } = taken;
    const base = { type: RELAY_MESSAGE, v: 1, attempt: record.attempt, purpose: record.purpose };
    if (expired) {
      // The tab is told, so it lets go of the attempt and a new sign-in starts afresh.
      await handOver(env, { ...base, outcome: "expired" } as RelayMessage, false);
      env.say("error", "This sign-in waited too long and expired. Start it again.", home);
      env.close();
      return;
    }
    if (record.purpose === "logout") {
      await handOver(env, { ...base, outcome: "response" } as RelayMessage, false);
      env.say("done", "Signed out of Freva. You can close this window.");
      env.close();
      return;
    }
    if (!response) {
      await handOver(env, { ...base, outcome: "expired" } as RelayMessage, false);
      env.say("error", "The sign-in came back without an answer. Sign in again.");
      env.close();
      return;
    }
    const reached = await handOver(
      env,
      { ...base, outcome: "response", url: href } as RelayMessage,
      true,
    );
    if (!reached) {
      env.say("error", NOT_HANDED_BACK, home);
      return;
    }
    env.say(refused ? "error" : "done", refused ?? "Signed in.");
    env.close();
    return;
  }

  // 2. A response with no popup record: this tab's own sign-in, a partitioned popup's, or nobody's.
  if (response) {
    if (!options.sameTab) {
      // No record here can mean a notebook framed by another site, whose storage this popup does
      // not share: its opener, if still there, takes the response from this very popup.
      if (env.opener()) {
        const message = {
          type: RELAY_MESSAGE,
          v: 1,
          purpose: "login",
          outcome: "response",
          url: href,
        };
        if (await handOver(env, message as RelayMessage, true)) {
          env.say(refused ? "error" : "done", refused ?? "Signed in.");
          env.close();
          return;
        }
        env.say("error", NOT_HANDED_BACK, home);
        return;
      }
      env.say(
        "error",
        refused ??
          "This sign-in was not started here, or it already finished. If the notebook is shown " +
            "inside another site's page, open it in its own tab and sign in there.",
        home,
      );
      return;
    }
    env.say("working", "Completing the sign-in.");
    let next: string | null;
    try {
      next = await options.sameTab(href);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      env.say(
        "error",
        refused ??
          (name === "LoginTransactionError"
            ? "This sign-in expired, finished already, or was started in another tab. Start it again."
            : "The sign-in could not be completed. Start it again."),
        home,
      );
      return;
    }
    if (refused) {
      env.say("error", refused, home);
      return;
    }
    env.say("done", "Signed in. Returning to where you were.");
    env.go(deploymentPath(next, options.basePath, env.origin) ?? home.href);
    return;
  }

  // 3. Back from a same-tab sign-out.
  const back = takeRecord<ReturnContext>(
    env.sessionStorage,
    RETURN_KEY,
    env.now(),
    (value) => typeof value.returnTo === "string",
  );
  if (back && !back.expired) {
    env.say("done", "Signed out. Returning to where you were.");
    env.go(deploymentPath(back.record.returnTo, options.basePath, env.origin) ?? home.href);
    return;
  }
  if (back) {
    env.say("done", "Signed out.", home);
    return;
  }

  // 4. A direct visit.
  env.say("idle", "There is no sign-in in progress here.", home);
}

/** The page's window, for `runCallback`. */
export function browserEnv(root: HTMLElement | null): CallbackEnv {
  return {
    href: window.location.href,
    origin: window.location.origin,
    sessionStorage: window.sessionStorage,
    scrub: (path) => {
      try {
        window.history.replaceState(null, "", path);
      } catch {
        // Nothing else to do.
      }
    },
    channel: (name) => (typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null),
    opener: () => {
      try {
        return window.opener && !(window.opener as Window).closed
          ? (window.opener as Window)
          : null;
      } catch {
        return null;
      }
    },
    onOpenerMessage: (listener) => {
      const handler = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (!window.opener || event.source !== window.opener) return;
        listener(event.data);
      };
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    },
    wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    go: (path) => window.location.replace(path),
    close: () => window.setTimeout(() => window.close(), 400),
    say: (state, message, link) => {
      if (!root) return;
      root.dataset.authCallbackState = state;
      const text = root.querySelector<HTMLElement>("[data-auth-callback-message]");
      if (text) text.textContent = message;
      const anchor = root.querySelector<HTMLAnchorElement>("[data-auth-callback-link]");
      if (anchor) {
        anchor.hidden = !link;
        if (link) {
          anchor.href = link.href;
          anchor.textContent = link.label;
        }
      }
    },
    now: () => Date.now(),
  };
}
