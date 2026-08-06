/**
 * Session binding must follow the session, not a stale mirror of it.
 *
 * Deriving the binding from a `currentSessionVersion` field that only some paths
 * update leaves four holes: a logout that reads storage for the first time
 * captures the binding BEFORE the read, so both its messages go out unbound; a
 * peer rotation observed through `token-updated` is verified and then not
 * adopted; a versionless `session-cleared` skips the targeting decision
 * entirely; and the asynchronous read inside `token-updated` carries no lease at
 * all. Each hole ends with a lifecycle message aimed at the wrong session.
 */
import { describe, expect, it } from "vitest";
import {
  PyOidcAuthClient,
  type AuthConfig,
  type AuthEvent,
  type StoredToken,
  type TokenStorage,
} from "../src/index.js";
import { fingerprint } from "../src/jwt.js";
import { fetchView, installFakeBroadcastChannel, jsonRes, makeJwt, stored } from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await flush();
};

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

interface Posted {
  type: string;
  sessionVersion?: string;
  operationId?: string;
  startedAt?: number;
}

function mk(o: Partial<AuthConfig> & { storage: TokenStorage }) {
  const events: AuthEvent[] = [];
  const navigated: string[] = [];
  const c = new PyOidcAuthClient({
    authBaseUrl: BASE,
    redirectUri: "http://app.test/cb",
    crossTab: false,
    now: () => NOW,
    navigate: (u) => navigated.push(u),
    onEvent: (e) => events.push(e),
    ...o,
    security: { allowInsecureTransport: true, warnOnBrowserReadableRefresh: false, ...o.security },
  });
  return { c, events, navigated };
}

function channel(name: string) {
  return new (
    globalThis as unknown as {
      BroadcastChannel: new (n: string) => BroadcastChannel;
    }
  ).BroadcastChannel(name);
}

/** Record every lifecycle message this client broadcasts. */
function listen(name: string): Posted[] {
  const seen: Posted[] = [];
  const ch = channel(name) as BroadcastChannel;
  ch.onmessage = (ev: MessageEvent) => seen.push(ev.data as Posted);
  return seen;
}

// ---------------------------------------------------------------------------
// P1: a logout binds to the credential it actually destroyed
// ---------------------------------------------------------------------------

describe("logout messages are bound to the session they end", () => {
  it("a logout from an unobserved stored token still carries the fingerprint", async () => {
    const restore = installFakeBroadcastChannel();
    const jwt = makeJwt({ jti: "p1", exp: NOW + 3600 });
    let cur: StoredToken | null = stored(jwt, NOW + 3600);
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => cur,
      save: (t) => {
        cur = t;
      },
      clear: () => {
        cur = null;
      },
    };
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl, crossTab: true });
    const seen = listen(c.channelName);

    // No getToken(), no refresh(), no callback: this tab has never looked at
    // the credential. logout() reads and clears it all the same.
    await c.logout({ localOnly: true });
    await settle();

    const lifecycle = seen.filter((m) => m.type === "session-cleared" || m.type === "logout");
    expect(lifecycle).toHaveLength(2);
    for (const m of lifecycle) {
      // Unbound, either message is unusable to a peer that knows the session:
      // it cannot tell whether the message is about its own session or a
      // different one, so it must refuse — and stays authenticated.
      expect(m.sessionVersion).toBe(fingerprint(jwt));
    }
    c.destroy();
    restore();
  });
});

// ---------------------------------------------------------------------------
// P2: a verified peer rotation updates the binding
// ---------------------------------------------------------------------------

describe("an observed peer rotation is adopted", () => {
  it("after token-updated for B, a session-cleared bound to B is honoured", async () => {
    const restore = installFakeBroadcastChannel();
    const a = makeJwt({ jti: "p2-a", exp: NOW + 3600 });
    const b = makeJwt({ jti: "p2-b", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(a, NOW + 3600);
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => cur,
      save: (t) => {
        cur = t;
      },
      clear: () => {
        cur = null;
      },
    };
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c, events } = mk({ storage, fetchImpl: impl, crossTab: true });
    const raw = channel(c.channelName);

    // The client observes A.
    expect((await c.getToken({ refresh: "never" }))?.accessToken).toBe(a);

    // A peer rotates shared storage to B and announces it.
    cur = stored(b, NOW + 7200);
    raw.postMessage({
      type: "token-updated",
      tabId: "peer",
      sessionVersion: fingerprint(b),
      exp: NOW + 7200,
      at: Date.now(),
    });
    await settle();
    expect(events.some((e) => e.type === "token-refreshed")).toBe(true);

    // The peer now ends THAT session. A client that still believes it is in A
    // reads the fingerprint as a mismatch and refuses the clear.
    raw.postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "b1b1b1b1b1b1b1b1",
      sessionVersion: fingerprint(b),
      startedAt: Date.now(),
      at: Date.now(),
    });
    await settle();

    expect(cur).toBeNull();
    c.destroy();
    restore();
  });
});

// ---------------------------------------------------------------------------
// P3: a stale versionless clear cannot destroy a newer session
// ---------------------------------------------------------------------------

describe("session-cleared uses the same targeting decision as logout", () => {
  it("a versionless clear that predates the session is refused", async () => {
    const restore = installFakeBroadcastChannel();
    const jwt = makeJwt({ jti: "p3", exp: NOW + 3600 });
    const cell: { token: StoredToken | null } = { token: null };
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => cell.token,
      save: (t) => {
        cell.token = t;
      },
      clear: () => {
        cell.token = null;
      },
    };
    const impl = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.includes("/callback?")) {
        return jsonRes({
          access_token: jwt,
          refresh_token: jwt,
          token_type: "Bearer",
          expires: NOW + 3600,
        });
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl, crossTab: true });

    // A session established HERE, now.
    c.beginLogin();
    history.replaceState(null, "", "/cb?code=p3&state=s");
    await c.handleCallback();
    await settle();
    const establishedAt = Date.now();

    // An untracked, versionless clear from an operation that began BEFORE this
    // session existed. "Fail closed" is not a licence to destroy a session the
    // message demonstrably predates.
    channel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "peerStale",
      reason: "user-logout",
      operationId: "5151515151515151",
      startedAt: establishedAt - 1_000,
      at: Date.now(),
    });
    await settle();

    expect(cell.token?.accessToken).toBe(jwt);
    expect((await c.getToken({ refresh: "never" }).catch(() => null))?.accessToken).toBe(jwt);
    c.destroy();
    restore();
  });
});

// ---------------------------------------------------------------------------
// P5: the asynchronous token-updated read belongs to its own generation
// ---------------------------------------------------------------------------

describe("token-updated handling is bound to its lifecycle generation", () => {
  it("a read that resolves after logout and a replacement login does nothing", async () => {
    const restore = installFakeBroadcastChannel();
    const oldJwt = makeJwt({ jti: "p5-old", exp: NOW + 3600 });
    const newJwt = makeJwt({ jti: "p5-new", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 3600);
    const readGate = gate();
    let gatedRead = false;
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: async () => {
        if (gatedRead) {
          gatedRead = false;
          await readGate.promise;
          return stored(oldJwt, NOW + 3600);
        }
        return cur;
      },
      save: (t) => {
        cur = t;
      },
      clear: () => {
        cur = null;
      },
    };
    const impl = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.includes("/callback?")) {
        return jsonRes({
          access_token: newJwt,
          refresh_token: newJwt,
          token_type: "Bearer",
          expires: NOW + 7200,
        });
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c, events } = mk({ storage, fetchImpl: impl, crossTab: true });

    // A peer announces a rotation; the read that verifies it is held open.
    gatedRead = true;
    channel(c.channelName).postMessage({
      type: "token-updated",
      tabId: "peer",
      sessionVersion: fingerprint(oldJwt),
      exp: NOW + 3600,
      at: Date.now(),
    });
    await flush();

    // Meanwhile the session ends and a completely different one replaces it.
    await c.logout({ localOnly: true }).catch(() => undefined);
    c.beginLogin();
    history.replaceState(null, "", "/cb?code=p5&state=s");
    await c.handleCallback();
    await settle();
    const before = events.filter((e) => e.type === "token-refreshed").length;

    readGate.release(); // the old read finally resolves
    await settle();

    const after = events.filter((e) => e.type === "token-refreshed");
    // Nothing from the ended session may be announced into its replacement.
    expect(after).toHaveLength(before);
    expect(after.some((e) => e.type === "token-refreshed" && e.source === "tab")).toBe(false);
    c.destroy();
    restore();
  });
});
