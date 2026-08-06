/**
 * A logout owns the session until it finishes: a concurrent login, save,
 * request, peer message or stale inflight pointer can neither clear its block
 * nor slip credentialed work past it.
 *
 * Each name states the behaviour that must not come back.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  PyOidcAuthClient,
  ServerManagedStorage,
  type AuthConfig,
  type AuthEvent,
  type TokenStorage,
} from "../src/index.js";
import { fetchView, installFakeBroadcastChannel, jsonRes, makeJwt, stored } from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

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

describe("logout ownership under concurrency", () => {
  it("login() cannot clear a locally owned logout block", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "u1", exp: NOW + 3600 }), NOW + 3600),
      save: () => undefined,
      clear: async () => {
        await gate;
      },
    };
    const { c, navigated } = mk({ storage, fetchImpl: (async () => jsonRes({})) as typeof fetch });
    const p = c.logout({ localOnly: true });
    await flush();
    let loginStarted = false;
    try {
      c.login();
      loginStarted = true;
    } catch {
      loginStarted = false;
    }
    const escaped = loginStarted
      ? await c.getToken({ refresh: "never" }).then(
          (t) => t !== null,
          () => false,
        )
      : false;
    release();
    await p.catch(() => undefined);
    expect(loginStarted).toBe(false); // login cannot cancel a running logout
    expect(escaped).toBe(false);
    c.destroy();
    void navigated;
  });

  it("a save awaiting storage is discarded when logout completes", async () => {
    const saved: string[] = [];
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((r) => (releaseSave = r));
    const fresh = makeJwt({ jti: "u2-new", exp: NOW + 7200 });
    let cleared = 0;
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "u2", exp: NOW + 30 }), NOW + 30),
      save: async (t) => {
        await saveGate;
        saved.push(t.accessToken);
      },
      clear: () => {
        cleared += 1;
      },
    };
    const impl = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.endsWith("/token")) {
        return jsonRes({
          access_token: fresh,
          refresh_token: fresh,
          token_type: "Bearer",
          expires: NOW + 7200,
        });
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    const r = c.refresh({ force: true }).catch(() => null);
    await flush();
    await flush();
    // Logout takes the block synchronously, then WAITS for the in-flight save
    // to release the storage mutex (the specified ordering).
    const lo = c.logout({ localOnly: true }).catch(() => undefined);
    await flush();
    releaseSave();
    await r;
    await lo;
    // The save was allowed to finish (it already owned the mutex), but the
    // credential it wrote is then cleared rather than left behind a completed
    // logout: one clear from logout itself, one undoing the late save.
    expect(saved).toContain(fresh);
    expect(cleared).toBeGreaterThanOrEqual(2);
    expect(await r).toBeNull(); // and the refresh reports failure, not success
    c.destroy();
  });

  it("a BFF request awaiting CSRF is not sent after logout", async () => {
    let releaseCsrf!: () => void;
    const csrfGate = new Promise<void>((r) => (releaseCsrf = r));
    const storage = new ServerManagedStorage({
      transport: "bff",
      logoutEndpoint: "http://app.test/lo",
      csrf: {
        headerName: "X-CSRFToken",
        token: async () => {
          await csrfGate;
          return "TOK";
        },
      },
    });
    const sent: string[] = [];
    const impl = (async (i: RequestInfo | URL) => {
      sent.push(fetchView(i).url);
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    const req = c.fetch("http://app.test/api/x").catch(() => null);
    await flush();
    const lo = c.logout({ localOnly: true }).catch(() => undefined);
    releaseCsrf();
    await req;
    await lo;
    expect(sent.some((u) => u.endsWith("/api/x"))).toBe(false);
    c.destroy();
  });

  it("a transient refresh failure after logout returns nothing", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "u4", exp: NOW + 60 }), NOW + 60));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const impl = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.endsWith("/token")) {
        await gate;
        return jsonRes({}, 503);
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    const p = c.getToken().catch(() => null);
    await flush();
    await flush();
    await c.logout({ localOnly: true }).catch(() => undefined);
    release();
    const result = await p;
    expect(result).toBeNull(); // no stale-token fallback across a logout
    c.destroy();
  });

  it("an old pull cannot clear a newer pull inflight pointer", async () => {
    let n = 0;
    const gates: Array<() => void> = [];
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      acknowledgeNoCsrf: true,
      tokenProvider: async () => {
        const mine = ++n;
        await new Promise<void>((r) => gates.push(r));
        return {
          accessToken: `tok-${mine}`,
          tokenType: "Bearer",
          expiresAt: NOW + 600,
          sessionVersion: "v",
        };
      },
    });
    const first = storage.load();
    storage.clear(); // invalidates the first pull
    const second = storage.load(); // a NEW pull
    gates[0]?.(); // old pull finishes...
    await first;
    gates[1]?.();
    await second;
    // The old pull is invalidated by clear(); the NEWER pull owns the cache
    // and the old one must not have nulled its inflight pointer.
    expect(storage.peek()?.accessToken).toBe("tok-2");
  });

  it("a peer logout whose clear rejects stays blocked", async () => {
    const restore = installFakeBroadcastChannel();
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "u6", exp: NOW + 3600 }), NOW + 3600),
      save: () => undefined,
      clear: async () => {
        throw new Error("clear rejected");
      },
    };
    const { c } = mk({ storage, crossTab: true });
    const raw = new (
      globalThis as unknown as {
        BroadcastChannel: new (n: string) => BroadcastChannel;
      }
    ).BroadcastChannel(c.channelName);
    raw.postMessage({
      type: "logout",
      tabId: "peer",
      reason: "user-logout",
      at: Date.now(),
      operationId: "aaaa000011112222",
      startedAt: Date.now(),
    });
    await flush();
    await flush();
    await flush();
    const readable = await c.getToken({ refresh: "never" }).then(
      (t) => t !== null,
      () => false,
    );
    expect(readable).toBe(false); // stays blocked while the token is readable
    c.destroy();
    restore();
  });

  it("a backend-logout setup failure still allows revocation", async () => {
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      logoutEndpoint: "http://app.test/lo",
      csrf: {
        headerName: "X-CSRFToken",
        token: () => {
          throw new Error("no csrf");
        },
      },
      tokenProvider: () => ({
        accessToken: "a.b.c",
        tokenType: "Bearer",
        expiresAt: NOW + 600,
        sessionVersion: "v",
      }),
    });
    await storage.load(); // populate the cache so a credential exists to revoke
    const urls: string[] = [];
    const impl = (async (i: RequestInfo | URL) => {
      urls.push(fetchView(i).url);
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    await c.logout({ localOnly: true }).catch(() => undefined);
    // Backend logout and revocation are independent invalidation steps.
    expect(urls.some((u) => u.endsWith("/revoke"))).toBe(true);
    c.destroy();
  });

  it("loginUrl refuses a destination-like next", () => {
    const { c } = mk({ storage: new MemoryStorage() });
    let ok = true;
    try {
      c.loginUrl({ next: "https://evil.example/steal" });
    } catch {
      ok = false;
    }
    expect(ok).toBe(false); // `next` is not accepted by the pure builder
    c.destroy();
  });
});
