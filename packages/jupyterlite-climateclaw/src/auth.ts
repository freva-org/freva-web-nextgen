// Freva sign-in for a page that must never navigate away (a notebook with a live kernel and
// unsaved work).
//
// The click opens a blank popup synchronously - the only moment a browser allows it - and the
// auth client's `navigate` sends that popup, never this tab, to the login URL. Before that, the
// popup (still a same-origin blank page) is given a record naming this attempt (`./auth-relay.ts`).
// The identity provider returns to the shared callback (`/auth/callback/` on this origin), which
// takes that record and posts its own URL on a BroadcastChannel named after the attempt (not
// `window.opener`: a provider page with Cross-Origin-Opener-Policy severs the opener) and closes.
// Only this tab listens there, and this tab - holding the login transaction - exchanges the code.
//
// Storage: this tab's sessionStorage, in the portal's format (key `portal:auth:token`), so a
// reload stays signed in and a portal session on this origin is reused. It ends with the tab, is
// not shared with other tabs, and the kernel's Python (a Worker) cannot read it. Never
// localStorage, never a URL, never a setting.

import {
  MemoryStorage,
  PyOidcAuthClient,
  type StoredToken,
  type TokenStorage,
} from "@freva-org/ts-oidc-auth-client";
import { Signal } from "@lumino/signaling";

import {
  RELAY_CHANNEL_PREFIX,
  RELAY_TTL_MS,
  acceptRelayMessage,
  newAttemptId,
  refusal,
  relayAck,
  writeRelay,
} from "./auth-relay.js";
import type { IFrevaAuth } from "./token.js";

export const PORTAL_SESSION_KEY = "portal:auth:token";

/** A channel by name (tests pass their own). */
export type ChannelFactory = (
  name: string,
) => Pick<BroadcastChannel, "addEventListener" | "close" | "postMessage"> | null;

/** Messages posted to this window (tests pass their own); returns the teardown. */
export type WindowMessages = (listener: (event: MessageEvent) => void) => () => void;

const browserMessages: WindowMessages = (listener) => {
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
};

const browserChannel: ChannelFactory = (name) =>
  typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null;

export const SIGN_IN_EXPIRED = "The sign-in waited too long and expired. Sign in again.";

/** The portal's own session storage format, so a same-origin portal session is reused as is. */
export class PortalSessionStorage implements TokenStorage {
  readonly kind = "custom" as const;
  readonly persistent = true;
  readonly lifecycleIdentity = "per-tab" as const;
  private readonly listeners = new Set<(token: StoredToken | null) => void>();

  load(): StoredToken | null {
    try {
      const raw = window.sessionStorage.getItem(PORTAL_SESSION_KEY);
      return raw ? (JSON.parse(raw) as StoredToken) : null;
    } catch {
      return null;
    }
  }
  save(token: StoredToken): void {
    try {
      window.sessionStorage.setItem(PORTAL_SESSION_KEY, JSON.stringify(token));
    } catch {
      // Storage refused: the session degrades to a re-login.
    }
    this.notify(token);
  }
  clear(): void {
    try {
      window.sessionStorage.removeItem(PORTAL_SESSION_KEY);
    } catch {
      // Already unreachable.
    }
    this.notify(null);
  }
  subscribe(listener: (token: StoredToken | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(token: StoredToken | null): void {
    for (const listener of this.listeners) {
      try {
        listener(token);
      } catch {
        // One listener must not break the others.
      }
    }
  }
}

function sessionStorageWorks(): boolean {
  try {
    return typeof window.sessionStorage?.getItem === "function";
  } catch {
    return false;
  }
}

export function hasPortalSession(): boolean {
  try {
    return window.sessionStorage.getItem(PORTAL_SESSION_KEY) !== null;
  } catch {
    return false;
  }
}

export interface PopupAuthOptions {
  host: string;
  authBaseUrl: string;
  callbackUrl: string;
  expectedIssuer?: string;
  /** Called when no popup could be opened; `retry` opens it again from the user's next click. */
  onBlocked(retry: () => void): void;
  /** Called when a login this tab started fails. */
  onError(message: string): void;
  /** For tests. */
  openWindow?: (name: string, features: string) => Window | null;
  channel?: ChannelFactory;
  windowMessages?: WindowMessages;
  /** For tests. */
  now?: () => number;
}

/** Who is signed in, as the account button shows it. */
export interface FrevaProfile {
  username: string | null;
  /** "Jane Doe" from the user's first and last name; "" when the profile has none. */
  fullName: string;
  email: string;
}

/** The profile from a py-oidc-auth `userinfo` answer. */
export function profileOf(info: Record<string, unknown>): FrevaProfile {
  const text = (key: string) => (typeof info[key] === "string" ? (info[key] as string).trim() : "");
  let username: string | null = null;
  for (const key of ["username", "preferred_username", "pw_name", "email", "sub"]) {
    if (text(key)) {
      username = text(key);
      break;
    }
  }
  const fullName =
    [text("first_name") || text("given_name"), text("last_name") || text("family_name")]
      .filter(Boolean)
      .join(" ") || text("name");
  return { username, fullName, email: text("email") };
}

/** A JWT's payload, unverified (for showing a name only), or {} for anything else. */
export function tokenClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const json = atob(
      part
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(part.length / 4) * 4, "="),
    );
    const value: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export const LOGOUT_UNCONFIRMED =
  "Freva did not confirm the sign-out, so this tab stays locked. Check the connection and sign in again: the sign-out is retried first.";

export const SESSION_EXPIRED =
  "Your Freva sign-in has expired. Sign in again with the account button in the chat toolbar, then resend.";

export class FrevaPopupAuth implements IFrevaAuth {
  readonly host: string;
  private readonly client: PyOidcAuthClient;
  private readonly changedSignal: Signal<IFrevaAuth, void> = new Signal<IFrevaAuth, void>(this);
  private readonly channelFor: ChannelFactory;
  /** The pending sign-in's channel, named after its attempt. */
  private listening: ReturnType<ChannelFactory> = null;
  /** Stops listening for the popup's own `postMessage`. */
  private unlistenWindow: (() => void) | null = null;
  /** When the pending attempt started: past the record's lifetime it is let go. */
  private attemptStarted = 0;
  private popup: Window | null = null;
  private loginPending = false;
  /** The pending login attempt this tab will accept a callback for. */
  private attempt: string | null = null;
  private signedInValue = false;
  private user: FrevaProfile | null = null;
  /** A sign-out Freva did not confirm: the client stays locked until one completes. */
  private unconfirmedLogout = false;
  /**
   * Bumped by every sign-in check and every sign-out: a check that awaited (the token, the user's
   * profile) publishes its result only if nothing newer happened meanwhile.
   */
  private generation = 0;
  readonly reusesPortalSession: boolean;

  constructor(private readonly options: PopupAuthOptions) {
    this.host = options.host;
    this.reusesPortalSession = hasPortalSession();
    // Per tab, across reloads; memory only where sessionStorage is unavailable.
    const storage = sessionStorageWorks() ? new PortalSessionStorage() : new MemoryStorage();
    this.client = new PyOidcAuthClient({
      authBaseUrl: options.authBaseUrl,
      redirectUri: options.callbackUrl,
      storage,
      // Tabs share nothing in memory; a reused portal session keeps the portal's behaviour.
      crossTab: this.reusesPortalSession,
      navigate: (url) => this.navigate(url),
      security: {
        allowedResourceOrigins: [options.host],
        allowedRedirectUris: [options.callbackUrl],
        allowedPostLogoutRedirectUris: [options.callbackUrl],
        // Freva's auth server (py-oidc-auth) has no POST /revoke: its 404 would lock the tab for
        // good. Sign out ends the provider's session instead; any other failure still locks.
        acknowledgeUnsupportedRevocation: true,
        ...(options.expectedIssuer ? { expectedIssuer: options.expectedIssuer } : {}),
      },
      onEvent: (event) => {
        if (
          event.type === "session-cleared" ||
          event.type === "session-expired" ||
          event.type === "logout"
        ) {
          this.generation += 1;
          this.setSignedIn(false, null);
        }
      },
    });
    this.channelFor = options.channel ?? browserChannel;
    if (this.reusesPortalSession) void this.refreshState();
  }

  get changed(): Signal<IFrevaAuth, void> {
    return this.changedSignal;
  }
  get signedIn(): boolean {
    return this.signedInValue;
  }
  get username(): string | null {
    return this.user?.username ?? null;
  }
  get profile(): FrevaProfile | null {
    return this.user;
  }

  login(): void {
    const now = this.options.now?.() ?? Date.now();
    if (this.popup && !this.popup.closed && this.loginPending) {
      if (now - this.attemptStarted < RELAY_TTL_MS) {
        this.popup.focus();
        return;
      }
      // That attempt's record has run out: its window cannot finish it. Start again.
      this.abandon();
    }
    const open = this.options.openWindow ?? ((name, features) => window.open("", name, features));
    // A new attempt for each popup: its name too, so two tabs never share one window.
    this.stopListening();
    const attempt = newAttemptId();
    // Synchronous, inside the click: a popup opened after an await is blocked.
    const popup = open(`freva-login-${attempt}`, "popup=yes,width=520,height=720");
    this.loginPending = true;
    if (!popup) {
      this.popup = null;
      this.options.onBlocked(() => this.login());
      return;
    }
    this.popup = popup;
    this.listen(attempt, popup);
    if (this.unconfirmedLogout) {
      // The client stays locked after a sign-out Freva did not confirm: finish that one first.
      void this.client.logout({ localOnly: true }).then(
        () => {
          this.unconfirmedLogout = false;
          this.startLogin(popup);
        },
        () => {
          this.loginPending = false;
          this.stopListening();
          popup.close();
          this.options.onError(LOGOUT_UNCONFIRMED);
        },
      );
      return;
    }
    this.startLogin(popup);
  }

  /**
   * This attempt's record in the popup's own session storage (it is still a same-origin blank
   * page) and this tab on the attempt's channel: the callback page takes the record and answers
   * there, so another tab's pending login never hears this response.
   */
  private listen(attempt: string, popup: Window): void {
    this.attempt = attempt;
    this.attemptStarted = this.options.now?.() ?? Date.now();
    // Without the record the callback cannot name this attempt; it then answers its opener.
    writeRelay(popup, attempt, "login", this.attemptStarted);
    const channel = this.channelFor(`${RELAY_CHANNEL_PREFIX}${attempt}`);
    channel?.addEventListener("message", (event: Event) => {
      void this.onCallback(attempt, (event as MessageEvent).data, false);
    });
    this.listening = channel;
    // The popup's own `postMessage`: what still arrives where this notebook is framed by another
    // site and the channel is partitioned away. Only from this origin and from that very window.
    this.unlistenWindow = (this.options.windowMessages ?? browserMessages)((event) => {
      if (event.origin !== window.location.origin || event.source !== popup) return;
      void this.onCallback(attempt, event.data, true);
    });
  }

  private stopListening(): void {
    this.listening?.close();
    this.listening = null;
    this.unlistenWindow?.();
    this.unlistenWindow = null;
  }

  /** Lets go of the pending attempt and its window. */
  private abandon(): void {
    this.loginPending = false;
    this.attempt = null;
    this.stopListening();
    try {
      this.popup?.close();
    } catch {
      // A severed popup is not ours to close.
    }
    this.popup = null;
  }

  /** Tells the popup its response arrived, so it closes (and never says it failed). */
  private acknowledge(attempt: string | undefined, popup: Window | null): void {
    const ack = relayAck(attempt);
    try {
      this.listening?.postMessage(ack);
    } catch {
      // Closed already.
    }
    try {
      popup?.postMessage(ack, window.location.origin);
    } catch {
      // A severed popup hears the channel only.
    }
  }

  private startLogin(popup: Window): void {
    try {
      this.client.login();
    } catch (error) {
      this.loginPending = false;
      this.attempt = null;
      this.stopListening();
      popup.close();
      this.options.onError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Never this tab: the popup if there is one, otherwise the blocked-popup notice. */
  private navigate(url: string): void {
    // A logout navigates to the provider's end-session page; this page ends only its own session.
    if (!this.loginPending) return;
    const popup = this.popup;
    if (popup && !popup.closed) {
      popup.location.replace(url);
      return;
    }
    this.options.onBlocked(() => this.login());
  }

  private async onCallback(attempt: string, data: unknown, fromPopup: boolean): Promise<void> {
    // Only this tab's current attempt, once: a second delivery finds the attempt gone.
    if (!this.loginPending || this.attempt !== attempt) return;
    const message = acceptRelayMessage(data, attempt, "login", this.options.callbackUrl, fromPopup);
    if (!message) return;
    if (message.url && !this.client.isCallbackUrl(message.url)) return;
    const popup = this.popup;
    this.acknowledge(message.attempt, popup);
    this.attempt = null;
    this.stopListening();
    if (message.outcome === "expired" || !message.url) {
      this.abandon();
      this.options.onError(SIGN_IN_EXPIRED);
      return;
    }
    const url = message.url;
    const refused = refusal(url);
    try {
      // Validates state, PKCE and issuer against this tab's transaction, which it consumes.
      await this.client.handleCallback(url);
      this.loginPending = false;
      try {
        this.popup?.close();
      } catch {
        // A severed popup is not ours to close; the page closes itself.
      }
      this.popup = null;
      await this.refreshState();
    } catch (error) {
      this.loginPending = false;
      this.options.onError(
        refused ??
          `Sign-in did not complete: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async refreshState(): Promise<void> {
    const mine = (this.generation += 1);
    let token: StoredToken | null = null;
    try {
      token = await this.client.getToken();
    } catch {
      token = null;
    }
    if (mine !== this.generation) return;
    if (!token) {
      this.setSignedIn(false, null);
      return;
    }
    let profile: FrevaProfile = { username: null, fullName: "", email: "" };
    try {
      profile = profileOf(await this.client.userinfo<Record<string, unknown>>());
    } catch {
      // Signed in all the same; the button shows no name.
    }
    if (!profile.fullName) {
      // userinfo has no name where the provider's mapping leaves it out: the token's own claims
      // (read for display only) usually carry it.
      const claims = tokenClaims(token.accessToken);
      profile = { ...profile, fullName: profileOf(claims).fullName };
      profile.username ??= profileOf(claims).username;
    }
    // A sign-out (or a newer check) while the profile loaded: this result is not the state.
    if (mine !== this.generation) return;
    this.setSignedIn(true, profile);
  }

  private setSignedIn(signedIn: boolean, user: FrevaProfile | null): void {
    const same =
      this.signedInValue === signedIn && JSON.stringify(this.user) === JSON.stringify(user);
    if (same) return;
    this.signedInValue = signedIn;
    this.user = signedIn ? user : null;
    this.changedSignal.emit();
  }

  /**
   * fetch with the bearer, to the Freva host only, over HTTPS (or loopback, for tests), with one
   * refresh-and-retry on 401. Not the auth client's own `fetch`: it re-wraps the request, and in
   * Chromium a re-wrapped request with a body is sent as a streaming upload, which an HTTP/1.1
   * server refuses (net::ERR_ALPN_NEGOTIATION_FAILED). Bodies here are strings, so a retry can
   * send them again.
   */
  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input, window.location.href);
    if (url.origin !== this.host) {
      throw new Error(`The Freva sign-in is not sent to ${url.origin}.`);
    }
    const loopback = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("The Freva sign-in is sent over HTTPS only.");
    }
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      throw new TypeError("Only string bodies are sent with the Freva sign-in.");
    }
    const send = (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(url.href, { ...init, headers, credentials: "omit", redirect: "error" });
    };
    let token: Awaited<ReturnType<PyOidcAuthClient["getToken"]>>;
    try {
      token = await this.client.getToken();
    } catch {
      // The refresh was refused (the identity provider's session ended): sign out, say so.
      await this.expire();
      throw new Error(SESSION_EXPIRED);
    }
    if (!token) throw new Error("Sign in with Freva first.");
    const response = await send(token.accessToken);
    if (response.status !== 401) return response;
    let fresh: Awaited<ReturnType<PyOidcAuthClient["refresh"]>>;
    try {
      fresh = await this.client.refresh({ force: true });
    } catch {
      await this.expire();
      throw new Error(SESSION_EXPIRED);
    }
    return send(fresh.accessToken);
  }

  /** A credential that can no longer be refreshed: forget it, so the next step is a sign-in. */
  private async expire(): Promise<void> {
    this.generation += 1;
    try {
      await this.client.logout({ localOnly: true });
    } catch {
      // Revoking an expired credential may fail: the next sign-in retries the sign-out first.
      this.unconfirmedLogout = true;
    }
    this.setSignedIn(false, null);
  }

  async accessToken(): Promise<string | null> {
    try {
      return (await this.client.getToken())?.accessToken ?? null;
    } catch {
      return null;
    }
  }

  /** Revokes and clears this tab's sign-in; the identity provider's session stays. */
  async logout(): Promise<void> {
    this.loginPending = false;
    this.attempt = null;
    this.stopListening();
    this.generation += 1;
    try {
      // No navigation: `localOnly` skips only the end-session redirect.
      await this.client.logout({ localOnly: true });
      this.unconfirmedLogout = false;
    } catch (error) {
      // Locked until a sign-out completes; the next sign-in retries it first.
      this.unconfirmedLogout = true;
      throw error;
    } finally {
      this.setSignedIn(false, null);
    }
  }

  /**
   * "Sign out": this tab's sign-in, then the identity provider's session too, in a popup (call
   * synchronously from a click), so the next sign-in asks for the password again.
   */
  signOut(): Promise<void> {
    const open = this.options.openWindow ?? ((name, features) => window.open("", name, features));
    const attempt = newAttemptId();
    const popup = open(`freva-logout-${attempt}`, "popup=yes,width=520,height=600");
    // A sign-out record: the callback says "signed out" and closes, and hands nothing on.
    if (popup) writeRelay(popup, attempt, "logout");
    const local = this.logout().then(
      () => true,
      () => false,
    );
    return local.then((confirmed) => {
      if (popup && !popup.closed) {
        try {
          popup.location.replace(this.client.logoutUrl(this.options.callbackUrl));
        } catch {
          popup.close();
        }
      }
      if (!confirmed) this.options.onError(LOGOUT_UNCONFIRMED);
    });
  }

  dispose(): void {
    this.stopListening();
    this.client.destroy();
  }
}
