// @vitest-environment jsdom
// Popup sign-in: a callback is taken only by the tab whose attempt it names.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FrevaPopupAuth,
  LOGOUT_UNCONFIRMED,
  PORTAL_SESSION_KEY,
  SIGN_IN_EXPIRED,
  profileOf,
} from "../src/auth.js";
import { RELAY_CHANNEL_PREFIX, RELAY_KEY, type RelayContext } from "../src/auth-relay.js";

// Each test is a fresh tab.
beforeEach(() => window.sessionStorage.clear());

const HOST = "https://freva.example.org";
const CALLBACK = `${window.location.origin}/auth/callback/`;

/** A blank popup with its own session storage, as `window.open("")` gives. */
function fakePopup() {
  const store = new Map<string, string>();
  return {
    closed: false,
    close: vi.fn(),
    focus: vi.fn(),
    postMessage: vi.fn(),
    location: { replace: vi.fn() },
    sessionStorage: {
      setItem: (k: string, v: string) => void store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    },
    store,
  };
}

/** BroadcastChannel between tabs: a message on a name reaches every tab listening on that name. */
function bus() {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const sent: Array<{ name: string; data: unknown }> = [];
  return {
    sent,
    factory: (name: string) => {
      const mine = new Set<(event: MessageEvent) => void>();
      return {
        addEventListener: (_: string, listener: (event: MessageEvent) => void) => {
          mine.add(listener);
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name)!.add(listener);
        },
        // What the tab sends back on the channel (its acknowledgements).
        postMessage: (data: unknown) => void sent.push({ name, data }),
        close: () => {
          for (const listener of mine) listeners.get(name)?.delete(listener);
        },
      } as unknown as BroadcastChannel;
    },
    post: (name: string, data: unknown) => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener({ data } as MessageEvent);
    },
    names: () => [...listeners.entries()].filter(([, set]) => set.size > 0).map(([name]) => name),
  };
}

let shared = bus();
beforeEach(() => (shared = bus()));

/** A tab: its auth and its popup (a new one for each window it opens, `popups`). */
function tab(options: { freshPopups?: boolean } = {}) {
  const popup = fakePopup();
  const popups: Array<ReturnType<typeof fakePopup>> = [];
  const opened: string[] = [];
  const clock = { now: 1_000_000 };
  const windowListeners: Array<(event: MessageEvent) => void> = [];
  const auth = new FrevaPopupAuth({
    host: HOST,
    authBaseUrl: `${HOST}/api/freva-nextgen/auth/v2`,
    callbackUrl: CALLBACK,
    onBlocked: vi.fn(),
    onError: vi.fn(),
    openWindow: (name) => {
      opened.push(name);
      const next = popups.length === 0 || !options.freshPopups ? popup : fakePopup();
      popups.push(next);
      return next as unknown as Window;
    },
    channel: shared.factory,
    windowMessages: (listener) => {
      windowListeners.push(listener);
      return () => void windowListeners.splice(windowListeners.indexOf(listener), 1);
    },
    now: () => clock.now,
  });
  /** A `postMessage` to this tab's window. */
  const deliverWindow = (data: unknown, source: unknown, origin = window.location.origin) => {
    for (const listener of [...windowListeners]) {
      listener({ data, source, origin } as unknown as MessageEvent);
    }
  };
  const record = () =>
    JSON.parse((popups.at(-1) ?? popup).store.get(RELAY_KEY) ?? "null") as RelayContext | null;
  const onError = (auth as unknown as { options: { onError: ReturnType<typeof vi.fn> } }).options
    .onError;
  return { auth, popup, popups, opened, record, onError, clock, deliverWindow, windowListeners };
}

const exchangesOf = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.filter(([url]) => String(url).includes("/auth/v2/callback"));

const response = (attempt: string, url: string) => ({
  type: "freva-auth-callback",
  v: 1,
  attempt,
  purpose: "login",
  outcome: "response",
  url,
});

describe("FrevaPopupAuth callbacks", () => {
  it("records each attempt in its popup; a response reaches and is exchanged by that tab only, once", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const a = tab();
      const b = tab();
      a.auth.login();
      b.auth.login();
      const attemptA = a.record()!.attempt;
      const attemptB = b.record()!.attempt;
      expect(a.record()).toMatchObject({ v: 1, purpose: "login" });
      expect(a.record()!.expires).toBe(a.clock.now + 10 * 60 * 1000);
      expect(attemptA).toMatch(/^[0-9a-f]{32}$/);
      expect(attemptA).not.toBe(attemptB);
      // Each popup has its own window name, and each tab listens on its own attempt only.
      expect(a.opened[0]).toBe(`freva-login-${attemptA}`);
      expect(shared.names().sort()).toEqual(
        [`${RELAY_CHANNEL_PREFIX}${attemptA}`, `${RELAY_CHANNEL_PREFIX}${attemptB}`].sort(),
      );
      const state = new URL(String(a.popup.location.replace.mock.calls[0]![0])).searchParams.get(
        "state",
      );
      const message = response(attemptA, `${CALLBACK}?code=c&state=${state}`);
      // On B's channel, A's response is not B's: ignored.
      shared.post(`${RELAY_CHANNEL_PREFIX}${attemptB}`, message);
      shared.post(`${RELAY_CHANNEL_PREFIX}${attemptA}`, message);
      // Delivered twice: exchanged once.
      shared.post(`${RELAY_CHANNEL_PREFIX}${attemptA}`, message);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(exchangesOf(fetch)).toHaveLength(1);
      // A stopped listening; B still waits for its own.
      expect(shared.names()).toEqual([`${RELAY_CHANNEL_PREFIX}${attemptB}`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("exchanges once even where a closed channel still delivers a duplicate", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const listeners: Array<(event: MessageEvent) => void> = [];
      const popup = fakePopup();
      const auth = new FrevaPopupAuth({
        host: HOST,
        authBaseUrl: `${HOST}/api/freva-nextgen/auth/v2`,
        callbackUrl: CALLBACK,
        onBlocked: vi.fn(),
        onError: vi.fn(),
        openWindow: () => popup as unknown as Window,
        // close() does nothing here: the guard is the tab's own, not the channel's.
        channel: () =>
          ({
            addEventListener: (_: string, l: (event: MessageEvent) => void) => listeners.push(l),
            close: () => undefined,
          }) as unknown as BroadcastChannel,
      });
      auth.login();
      const attempt = (JSON.parse(popup.store.get(RELAY_KEY)!) as RelayContext).attempt;
      const message = response(attempt, `${CALLBACK}?code=c&state=s`);
      const onError = (auth as unknown as { options: { onError: ReturnType<typeof vi.fn> } })
        .options.onError;
      // Twice in the same turn, before the first exchange has answered.
      for (const listener of listeners) listener({ data: message } as MessageEvent);
      for (const listener of listeners) listener({ data: message } as MessageEvent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(exchangesOf(fetch)).toHaveLength(1);
      // One outcome (this mock refuses the exchange); the duplicate is ignored, not reported.
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("from a frame on another site: the popup's own postMessage, from that window only", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const a = tab();
      a.auth.login();
      const state = new URL(String(a.popup.location.replace.mock.calls[0]![0])).searchParams.get(
        "state",
      );
      // No record reached the popup (partitioned storage): no attempt in its message.
      const message = {
        type: "freva-auth-callback",
        v: 1,
        purpose: "login",
        outcome: "response",
        url: `${CALLBACK}?code=c&state=${state}`,
      };
      a.deliverWindow(message, {}); // another window
      a.deliverWindow(message, a.popup, "https://evil.example.org"); // another origin
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(exchangesOf(fetch)).toHaveLength(0);
      a.deliverWindow(message, a.popup);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(exchangesOf(fetch)).toHaveLength(1);
      // Acknowledged to the popup, so it closes rather than saying it failed.
      expect(a.popup.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "freva-auth-callback-ack", v: 1 }),
        window.location.origin,
      );
      // And no longer listening.
      expect(a.windowListeners).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("acknowledges a channel response on the channel and to the popup", async () => {
    const a = tab();
    a.auth.login();
    const attempt = a.record()!.attempt;
    shared.post(
      `${RELAY_CHANNEL_PREFIX}${attempt}`,
      response(attempt, `${CALLBACK}?code=c&state=s`),
    );
    const ack = { type: "freva-auth-callback-ack", v: 1, attempt };
    expect(shared.sent).toContainEqual({ name: `${RELAY_CHANNEL_PREFIX}${attempt}`, data: ack });
    expect(a.popup.postMessage).toHaveBeenCalledWith(ack, window.location.origin);
  });

  it("an expired attempt is let go: its popup closes and the next click starts afresh", async () => {
    const a = tab({ freshPopups: true });
    a.auth.login();
    const first = a.record()!.attempt;
    // Within the attempt's lifetime a click brings its window forward...
    a.auth.login();
    expect(a.popup.focus).toHaveBeenCalledTimes(1);
    expect(a.popups).toHaveLength(1);
    // ...past it, the old window is closed and a new attempt opens a new one.
    a.clock.now += 11 * 60 * 1000;
    a.auth.login();
    expect(a.popup.close).toHaveBeenCalled();
    expect(a.popups).toHaveLength(2);
    const second = JSON.parse(a.popups[1]!.store.get(RELAY_KEY)!) as RelayContext;
    expect(second.attempt).not.toBe(first);
    expect(shared.names()).toEqual([`${RELAY_CHANNEL_PREFIX}${second.attempt}`]);
  });

  it("told by the callback that its record expired: lets go, so Sign in opens a new window", async () => {
    const a = tab({ freshPopups: true });
    a.auth.login();
    const attempt = a.record()!.attempt;
    shared.post(`${RELAY_CHANNEL_PREFIX}${attempt}`, {
      type: "freva-auth-callback",
      v: 1,
      attempt,
      purpose: "login",
      outcome: "expired",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(a.onError).toHaveBeenCalledWith(SIGN_IN_EXPIRED);
    expect(a.popup.close).toHaveBeenCalled();
    a.auth.login();
    expect(a.popup.focus).not.toHaveBeenCalled();
    expect(a.popups).toHaveLength(2);
  });

  it("ignores messages of another shape, purpose or callback URL", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const a = tab();
      a.auth.login();
      const attempt = a.record()!.attempt;
      const channel = `${RELAY_CHANNEL_PREFIX}${attempt}`;
      const good = response(attempt, `${CALLBACK}?code=c&state=s`);
      shared.post(channel, { ...good, url: `${window.location.origin}/elsewhere/?code=c&state=s` });
      shared.post(channel, { ...good, url: `https://evil.example.org/auth/callback/?code=c` });
      shared.post(channel, { ...good, purpose: "logout" });
      shared.post(channel, { ...good, v: 2 });
      shared.post(channel, { ...good, type: "freva-login-callback" });
      shared.post(channel, { ...good, attempt: "f".repeat(32) });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(exchangesOf(fetch)).toHaveLength(0);
      expect(a.onError).not.toHaveBeenCalled();
      // Still waiting for its response.
      expect(shared.names()).toEqual([channel]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says a cancelled or refused sign-in plainly, and an expired one, without an exchange", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const a = tab();
      a.auth.login();
      let attempt = a.record()!.attempt;
      shared.post(
        `${RELAY_CHANNEL_PREFIX}${attempt}`,
        response(attempt, `${CALLBACK}?error=access_denied&state=s`),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(a.onError).toHaveBeenLastCalledWith("The sign-in was cancelled.");

      a.auth.login();
      attempt = a.record()!.attempt;
      shared.post(
        `${RELAY_CHANNEL_PREFIX}${attempt}`,
        response(attempt, `${CALLBACK}?error=server_error&state=s`),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(a.onError).toHaveBeenLastCalledWith(
        "Freva did not accept the sign-in (server_error).",
      );

      a.auth.login();
      attempt = a.record()!.attempt;
      shared.post(`${RELAY_CHANNEL_PREFIX}${attempt}`, {
        type: "freva-auth-callback",
        v: 1,
        attempt,
        purpose: "login",
        outcome: "expired",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(a.onError).toHaveBeenLastCalledWith(SIGN_IN_EXPIRED);
      expect(exchangesOf(fetch)).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("FrevaPopupAuth state", () => {
  it("a profile that arrives after sign-out does not sign the page in again", async () => {
    const { auth } = tab();
    const client = (auth as unknown as { client: Record<string, unknown> }).client;
    let token: { accessToken: string } | null = { accessToken: "t" };
    let answer!: (info: Record<string, unknown>) => void;
    client.getToken = async () => token;
    client.userinfo = () => new Promise((resolve) => (answer = resolve));
    client.logout = async () => {
      token = null;
    };
    const refresh = (auth as unknown as { refreshState(): Promise<void> }).refreshState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await auth.logout();
    answer({ preferred_username: "jdoe" });
    await refresh;
    expect(auth.signedIn).toBe(false);
    expect(auth.username).toBeNull();
    expect(await auth.accessToken()).toBeNull();
  });

  it("of two overlapping checks, the newer one decides", async () => {
    const { auth } = tab();
    const client = (auth as unknown as { client: Record<string, unknown> }).client;
    const answers: Array<(info: Record<string, unknown>) => void> = [];
    client.getToken = async () => ({ accessToken: "t" });
    client.userinfo = () => new Promise((resolve) => answers.push(resolve));
    const refresh = () => (auth as unknown as { refreshState(): Promise<void> }).refreshState();
    const older = refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newer = refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    answers[1]!({ preferred_username: "new-user" });
    await newer;
    answers[0]!({ preferred_username: "old-user" });
    await older;
    expect(auth.username).toBe("new-user");
  });
});

describe("FrevaPopupAuth profile and sign-out", () => {
  it("names the user from userinfo: full name, username, e-mail", () => {
    expect(
      profileOf({ username: "k204221", first_name: "Jane", last_name: "Doe", email: "j@x.org" }),
    ).toEqual({ username: "k204221", fullName: "Jane Doe", email: "j@x.org" });
    expect(profileOf({ preferred_username: "jdoe" })).toEqual({
      username: "jdoe",
      fullName: "",
      email: "",
    });
  });

  it("Sign out ends the identity provider's session too, in a popup from the click", async () => {
    const { auth, popup, record, opened } = tab();
    const client = (auth as unknown as { client: Record<string, unknown> }).client;
    const order: string[] = [];
    client.logout = async (options: { localOnly?: boolean }) => {
      order.push(`logout local=${options.localOnly}`);
    };
    await auth.signOut();
    expect(order).toEqual(["logout local=true"]);
    // The popup carries a sign-out record: its callback says "signed out" and hands nothing on.
    expect(record()).toMatchObject({ v: 1, purpose: "logout" });
    expect(opened[0]).toBe(`freva-logout-${record()!.attempt}`);
    const target = new URL(popup.location.replace.mock.calls[0]![0] as string);
    expect(target.pathname).toBe("/api/freva-nextgen/auth/v2/logout");
    expect(target.searchParams.get("post_logout_redirect_uri")).toBe(CALLBACK);
    expect(auth.signedIn).toBe(false);
  });

  it("a sign-out Freva did not confirm is said, and retried before the next sign-in", async () => {
    const { auth, popup } = tab();
    const onError = (auth as unknown as { options: { onError: ReturnType<typeof vi.fn> } }).options
      .onError;
    const client = (auth as unknown as { client: Record<string, unknown> }).client;
    let fail = true;
    const calls: string[] = [];
    client.logout = async () => {
      calls.push("logout");
      if (fail) throw new Error("revocation failed");
    };
    client.login = () => void calls.push("login");
    await auth.signOut();
    expect(onError).toHaveBeenCalledWith(LOGOUT_UNCONFIRMED);
    // Still locked: the next sign-in finishes the sign-out first, then logs in.
    fail = false;
    auth.login();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["logout", "logout", "login"]);
    // If it fails again, the sign-in is not started and the popup closes.
    fail = true;
    await auth.signOut();
    calls.length = 0;
    popup.close.mockClear();
    auth.login();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["logout"]);
    expect(popup.close).toHaveBeenCalled();
  });

  it("against Freva's server (no /revoke), sign-out completes and the next sign-in starts", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/revoke")
        ? new Response('{"detail":"Not Found"}', { status: 404 })
        : new Response("{}", { status: 400 }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const { auth, popup } = tab();
      const onError = (auth as unknown as { options: { onError: ReturnType<typeof vi.fn> } })
        .options.onError;
      const client = (auth as unknown as { client: { storage: { save(t: object): unknown } } })
        .client;
      await client.storage.save({
        accessToken: "access",
        refreshToken: "refresh",
        tokenType: "Bearer",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        sessionVersion: "v1",
      });
      await auth.signOut();
      expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/revoke"))).toBe(true);
      expect(onError).not.toHaveBeenCalled();
      expect(await auth.accessToken()).toBeNull();
      // Not locked: the sign-in goes straight to the provider.
      popup.location.replace.mockClear();
      auth.login();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onError).not.toHaveBeenCalled();
      expect(String(popup.location.replace.mock.calls.at(-1)?.[0])).toContain("/login");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("FrevaPopupAuth across a reload", () => {
  it("stays signed in after a reload of the tab, and a sign-out ends that", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    try {
      const first = tab();
      const client = (
        first.auth as unknown as { client: { storage: { save(t: object): unknown } } }
      ).client;
      await client.storage.save({
        accessToken: "access",
        refreshToken: "refresh",
        tokenType: "Bearer",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        sessionVersion: "v1",
      });
      expect(window.sessionStorage.getItem(PORTAL_SESSION_KEY)).not.toBeNull();
      expect(window.localStorage.length).toBe(0);
      // The same tab, reloaded: the session is there.
      const reloaded = tab();
      expect(reloaded.auth.reusesPortalSession).toBe(true);
      expect(await reloaded.auth.accessToken()).toBe("access");
      await reloaded.auth.signOut();
      expect(window.sessionStorage.getItem(PORTAL_SESSION_KEY)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
