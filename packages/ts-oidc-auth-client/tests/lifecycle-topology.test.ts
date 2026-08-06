/**
 * A credential fingerprint is not a session identity.
 *
 * Exact-fingerprint matching is correct for a shared persistent credential,
 * where every tab reads the same value, and wrong everywhere else: a
 * server-managed backend session mints a different short-lived bearer per tab,
 * and MemoryStorage gives every tab its own token. Two tabs of one deployment
 * legitimately disagree about the fingerprint, so requiring a match makes each
 * tab reject the other's logout.
 *
 * These probes use two REAL client instances on one derived channel.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  PyOidcAuthClient,
  ServerManagedStorage,
  type AuthConfig,
  type AuthEvent,
  type StoredToken,
  type TokenStorage,
} from "../src/index.js";
import { fetchView, installFakeBroadcastChannel, jsonRes, makeJwt, stored } from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await flush();
};

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

function mk(o: Partial<AuthConfig> & { storage: TokenStorage }) {
  const events: AuthEvent[] = [];
  const navigated: string[] = [];
  const c = new PyOidcAuthClient({
    authBaseUrl: BASE,
    redirectUri: "http://app.test/cb",
    crossTab: true,
    now: () => NOW,
    navigate: (u) => navigated.push(u),
    onEvent: (e) => events.push(e),
    ...o,
    security: { allowInsecureTransport: true, warnOnBrowserReadableRefresh: false, ...o.security },
  });
  return { c, events, navigated };
}

const blocked = (p: Promise<unknown>) =>
  p.then(
    () => false,
    () => true,
  );

/** A bearer-from-endpoint storage whose provider returns one fixed token. */
function managed(token: string, extra: Record<string, unknown> = {}) {
  return new ServerManagedStorage({
    transport: "bearer-from-endpoint",
    acknowledgeNoCsrf: true,
    tokenProvider: () => ({
      accessToken: token,
      tokenType: "Bearer",
      expiresAt: NOW + 600,
      sessionVersion: "ignored",
    }),
    ...extra,
  } as ConstructorParameters<typeof ServerManagedStorage>[0]);
}

// ---------------------------------------------------------------------------
// Two managed-bearer tabs of ONE backend session.
// ---------------------------------------------------------------------------

describe("server-managed bearer tabs share a backend session", () => {
  it("tab B invalidates and blocks while tab A's backend logout is pending", async () => {
    const restore = installFakeBroadcastChannel();
    const tokenA = makeJwt({ jti: "a0-tab-a", exp: NOW + 600 });
    const tokenB = makeJwt({ jti: "a0-tab-b", exp: NOW + 600 });
    const logoutGate = gate();

    const storageA = managed(tokenA, { logoutEndpoint: "http://app.test/logout" });
    const storageB = managed(tokenB);

    const implA = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.endsWith("/logout")) {
        await logoutGate.promise; // held open on purpose
        return jsonRes({});
      }
      return jsonRes({});
    }) as typeof fetch;
    const implB = (async () => jsonRes({})) as typeof fetch;

    const { c: a } = mk({
      storage: storageA,
      fetchImpl: implA,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    const { c: b } = mk({
      storage: storageB,
      fetchImpl: implB,
      security: { acknowledgeNoBackendLogout: true },
    });
    expect(a.channelName).toBe(b.channelName); // one deployment, one channel

    // 1. Both tabs hold their own short-lived bearer for the SAME session.
    expect((await a.getToken({ refresh: "never" }))?.accessToken).toBe(tokenA);
    expect((await b.getToken({ refresh: "never" }))?.accessToken).toBe(tokenB);
    expect(storageB.peek()?.accessToken).toBe(tokenB);

    // 2-3. A logs out; `session-cleared` is broadcast, the terminal message is
    //      not, because the backend logout has not answered.
    const logout = a.logout({ localOnly: true }).catch(() => undefined);
    await settle();

    // 4. B must have dropped its cached bearer and must refuse credential reads.
    expect(storageB.peek()).toBeNull();
    expect(await blocked(b.getToken({ refresh: "never" }))).toBe(true);

    logoutGate.release();
    await logout;
    await settle();
    a.destroy();
    b.destroy();
    restore();
  });
});

// ---------------------------------------------------------------------------
// MemoryStorage: the documented contract is a GLOBAL logout.
// ---------------------------------------------------------------------------

describe("MemoryStorage logout reaches every tab on the channel", () => {
  it("a completed logout in one tab clears another tab's own token", async () => {
    const restore = installFakeBroadcastChannel();
    const storageA = new MemoryStorage();
    const storageB = new MemoryStorage();
    await storageA.save(stored(makeJwt({ jti: "a3-a", exp: NOW + 3600 }), NOW + 3600));
    await storageB.save(stored(makeJwt({ jti: "a3-b", exp: NOW + 3600 }), NOW + 3600));

    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c: a } = mk({ storage: storageA, fetchImpl: impl });
    const { c: b } = mk({ storage: storageB, fetchImpl: impl });
    expect(a.channelName).toBe(b.channelName);

    // Each tab has observed its OWN token; the fingerprints differ by design.
    expect(await b.getToken({ refresh: "never" })).not.toBeNull();

    await a.logout({ localOnly: true });
    await settle();

    // The documented contract: logging out signs the user out everywhere.
    expect(await storageB.load()).toBeNull();
    expect(await b.getToken({ refresh: "never" }).catch(() => null)).toBeNull();
    a.destroy();
    b.destroy();
    restore();
  });
});

// ---------------------------------------------------------------------------
// Preserved protections
// ---------------------------------------------------------------------------

describe("topology widening does not lose the fingerprint protections", () => {
  it("a shared-credential tab still requires an exact fingerprint match", async () => {
    const restore = installFakeBroadcastChannel();
    const mine = makeJwt({ jti: "a4-mine", exp: NOW + 3600 });
    const cell: { token: StoredToken | null } = { token: stored(mine, NOW + 3600) };
    // `persistent: true` and not server-managed: every tab reads THIS value, so
    // a fingerprint really is the session identity here.
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
    const { c } = mk({ storage });
    expect((await c.getToken({ refresh: "never" }))?.accessToken).toBe(mine);

    new (
      globalThis as unknown as {
        BroadcastChannel: new (n: string) => BroadcastChannel;
      }
    ).BroadcastChannel(c.channelName).postMessage({
      type: "logout",
      tabId: "peer",
      reason: "user-logout",
      operationId: "a4a4a4a4a4a4a4a4",
      sessionVersion: "0000deadbeef0000",
      startedAt: Date.now(),
      at: Date.now(),
    });
    await settle();

    expect(cell.token?.accessToken).toBe(mine);
    expectUnblocked(await blocked(c.getToken({ refresh: "never" })));
    c.destroy();
    restore();
  });

  it("a stale operation cannot clear a genuinely newer per-tab session", async () => {
    const restore = installFakeBroadcastChannel();
    const jwt = makeJwt({ jti: "a5", exp: NOW + 3600 });
    const storage = new MemoryStorage(); // per-tab topology
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
    const { c } = mk({ storage, fetchImpl: impl });

    const before = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    c.beginLogin();
    history.replaceState(null, "", "/cb?code=a5&state=s");
    await c.handleCallback();
    await settle();

    // An operation that began BEFORE this session existed. Widening the
    // fingerprint rule must not cost this protection.
    new (
      globalThis as unknown as {
        BroadcastChannel: new (n: string) => BroadcastChannel;
      }
    ).BroadcastChannel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "stale",
      reason: "user-logout",
      operationId: "a5a5a5a5a5a5a5a5",
      startedAt: before - 1_000,
      at: Date.now(),
    });
    await settle();

    expect((await storage.load())?.accessToken).toBe(jwt);
    c.destroy();
    restore();
  });

  it("no cross-tab message ever carries a token value", async () => {
    const restore = installFakeBroadcastChannel();
    const jwt = makeJwt({ jti: "a6-secret-value", exp: NOW + 3600 });
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    const seen: unknown[] = [];
    const spy = new (
      globalThis as unknown as {
        BroadcastChannel: new (n: string) => BroadcastChannel;
      }
    ).BroadcastChannel(c.channelName);
    spy.onmessage = (ev: MessageEvent) => seen.push(ev.data);

    await c.getToken({ refresh: "never" });
    await c.logout({ localOnly: true });
    await settle();

    expect(seen.length).toBeGreaterThan(0);
    const wire = JSON.stringify(seen);
    expect(wire).not.toContain(jwt);
    for (const part of jwt.split(".")) expect(wire).not.toContain(part);
    c.destroy();
    restore();
  });
});

/** Readability helper: A4's client must remain usable. */
function expectUnblocked(isBlocked: boolean): void {
  expect(isBlocked).toBe(false);
}

describe("a peer lifecycle message reaches the managed cache", () => {
  it("a server-managed storage whose clear() spares its cache is still invalidated", async () => {
    const restore = installFakeBroadcastChannel();
    const mine = makeJwt({ jti: "a7", exp: NOW + 600 });
    // A custom storage that declares the managed contract. Its `clear()` drops
    // persisted state only - the in-memory bearer cache is dropped by
    // `invalidateCache()`, exactly as the ServerManagedStorage contract says.
    let cache: StoredToken | null = stored(mine, NOW + 600);
    let persisted: StoredToken | null = stored(mine, NOW + 600);
    const storage = {
      kind: "server-managed" as const,
      persistent: true,
      transport: "bearer-from-endpoint",
      // A `kind` string is a claim, not a class. Every storage declares its own
      // topology; this one's must agree with the transport it claims.
      lifecycleIdentity: "managed-bearer",
      load: () => cache,
      save: () => undefined,
      clear: () => {
        persisted = null;
      },
      peek: () => cache,
      invalidateCache: () => {
        cache = null;
      },
    };
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({
      storage: storage as unknown as TokenStorage,
      fetchImpl: impl,
      security: { acknowledgeNoBackendLogout: true },
    });
    await c.getToken({ refresh: "never" });

    new (
      globalThis as unknown as {
        BroadcastChannel: new (n: string) => BroadcastChannel;
      }
    ).BroadcastChannel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "a7a7a7a7a7a7a7a7",
      startedAt: Date.now(),
      at: Date.now(),
    });
    await settle();

    expect(storage.peek()).toBeNull(); // the cached bearer is gone
    expect(persisted).toBeNull(); // and so is the persisted state
    c.destroy();
    restore();
  });
});
