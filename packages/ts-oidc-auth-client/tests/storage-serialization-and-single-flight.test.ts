/**
 * Storage mutations are serialized and single-flight ownership is
 * identity-checked, and cross-tab lifecycle messages are correlated to the
 * session they name.
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
import { fingerprint } from "../src/jwt.js";
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
function channel(name: string) {
  return new (
    globalThis as unknown as {
      BroadcastChannel: new (n: string) => BroadcastChannel;
    }
  ).BroadcastChannel(name);
}

describe("storage mutations are serialized", () => {
  it("logout holding the lock refuses a later save", async () => {
    const ops: string[] = [];
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((r) => (releaseClear = r));
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((r) => (releaseToken = r));
    const fresh = makeJwt({ jti: "late-save", exp: NOW + 7200 });
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "ls", exp: NOW + 30 }), NOW + 30),
      save: () => {
        ops.push("save");
      },
      clear: async () => {
        ops.push("clear-start");
        await clearGate;
        ops.push("clear-end");
      },
    };
    const impl = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.endsWith("/token")) {
        await tokenGate;
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
    const lo = c.logout({ localOnly: true }).catch(() => undefined); // takes the lock
    await flush();
    releaseToken(); // the refresh response arrives while logout holds it
    await flush();
    await flush();
    releaseClear();
    await r;
    await lo;
    // The late save queues behind the clear and then finds its lease invalid.
    expect(ops).not.toContain("save");
    c.destroy();
  });
});

describe("single-flight ownership is identity-checked", () => {
  it("an old pull completing does not orphan the newer pull", async () => {
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
    storage.clear();
    const second = storage.load();
    gates[0]?.();
    await first; // the OLD pull completes
    const third = storage.load(); // must JOIN the newer pull, not start a third
    expect(n).toBe(2);
    gates[1]?.();
    await second;
    await third;
    expect(n).toBe(2);
  });
});

describe("delayed dependencies revalidate", () => {
  it("a callback response waiting on storage save is discarded after logout", async () => {
    const saved: string[] = [];
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((r) => (releaseSave = r));
    const jwt = makeJwt({ jti: "cb", exp: NOW + 3600 });
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => null,
      save: async (t) => {
        await saveGate;
        saved.push(t.accessToken);
      },
      clear: () => undefined,
    };
    const impl = (async () =>
      jsonRes({
        access_token: jwt,
        refresh_token: jwt,
        token_type: "Bearer",
        expires: NOW + 3600,
      })) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
    const cb = c.handleCallback("http://app.test/cb?code=a&state=s").catch(() => null);
    await flush();
    await flush();
    const lo = c.logout({ localOnly: true }).catch(() => undefined);
    await flush();
    releaseSave();
    await cb;
    await lo;
    expect(await cb).toBeNull(); // the callback reports failure, not success
    c.destroy();
  });

  it("a connectivity probe waiting on CSRF is not sent after logout", async () => {
    let releaseCsrf!: () => void;
    const csrfGate = new Promise<void>((r) => (releaseCsrf = r));
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      healthUrl: "http://app.test/health",
      logoutEndpoint: "http://app.test/lo",
      csrf: {
        headerName: "X-CSRFToken",
        token: async () => {
          await csrfGate;
          return "T";
        },
      },
      tokenProvider: () => null,
    });
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
    const probe = c.probeConnectivity().catch(() => null);
    await flush();
    const lo = c.logout({ localOnly: true }).catch(() => undefined);
    releaseCsrf();
    await probe;
    await lo;
    expect(urls.some((u) => u.endsWith("/health"))).toBe(false);
    c.destroy();
  });

  it("an old refresh response cannot return a token to a newer session", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "old", exp: NOW + 30 }), NOW + 30));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fresh = makeJwt({ jti: "late", exp: NOW + 7200 });
    const impl = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.endsWith("/token")) {
        await gate;
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
    await c.logout({ localOnly: true }).catch(() => undefined);
    c.login(); // a NEW session begins
    release();
    expect(await r).toBeNull();
    c.destroy();
  });
});

describe("cross-tab logout correlation", () => {
  it("a stale terminal peer message cannot release a newer block", async () => {
    const restore = installFakeBroadcastChannel();
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "st", exp: NOW + 3600 }), NOW + 3600));
    const { c } = mk({ storage, crossTab: true });
    const raw = channel(c.channelName);
    raw.postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "aaaa1111",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await flush();
    await flush();
    // A terminal message from a DIFFERENT (older) operation must be ignored.
    raw.postMessage({
      type: "logout",
      tabId: "peer",
      reason: "user-logout",
      operationId: "bbbb2222",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await flush();
    await flush();
    await storage.save(stored(makeJwt({ jti: "st2", exp: NOW + 3600 }), NOW + 3600));
    const readable = await c.getToken({ refresh: "never" }).then(
      (t) => t !== null,
      () => false,
    );
    expect(readable).toBe(false); // still blocked
    c.destroy();
    restore();
  });

  it("rejects an out-of-format operation id", async () => {
    const restore = installFakeBroadcastChannel();
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "of", exp: NOW + 3600 }), NOW + 3600));
    const { c, events } = mk({ storage, crossTab: true });
    channel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "NOT-HEX-" + "x".repeat(80),
      at: Date.now(),
      startedAt: Date.now(),
    });
    await flush();
    await flush();
    expect(events.some((e) => e.type === "session-cleared")).toBe(false);
    c.destroy();
    restore();
  });
});

describe("token-response validation", () => {
  it("rejects malformed capability metadata from the token endpoint", async () => {
    const storage = new MemoryStorage();
    const impl = (async () =>
      jsonRes({
        access_token: "a.b.c",
        refresh_token: "a.b.c",
        token_type: "Bearer",
        expires: NOW + 3600,
        refreshable: "yes",
      })) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
    await expect(c.handleCallback("http://app.test/cb?code=a&state=s")).rejects.toThrow(
      /non-boolean/i,
    );
    c.destroy();
  });

  it("does not trust a response-supplied session version", async () => {
    const storage = new MemoryStorage();
    const jwt = makeJwt({ jti: "sv", exp: NOW + 3600 });
    const impl = (async () =>
      jsonRes({
        access_token: jwt,
        refresh_token: jwt,
        token_type: "Bearer",
        expires: NOW + 3600,
        sessionVersion: "ATTACKER-CHOSEN",
      })) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
    const t = await c.handleCallback("http://app.test/cb?code=a&state=s");
    expect(t.sessionVersion).not.toBe("ATTACKER-CHOSEN");
    expect(t.sessionVersion).toMatch(/^[0-9a-f]{16}$/);
    c.destroy();
  });
});

describe("login option contract", () => {
  it("beginLogin accepts and validates next; loginUrl refuses it", () => {
    const { c } = mk({ storage: new MemoryStorage() });
    expect(() => c.loginUrl({ next: "/plots/7" })).toThrow(/pure builder/i);
    expect(() => c.beginLogin({ next: "https://evil.example/x" })).toThrow(/relative path/i);
    const url = c.beginLogin({ next: "/plots/7" });
    expect(url).toContain("/login?");
    expect(sessionStorage.getItem(`${c.channelName}:next`)).toBe("/plots/7");
    c.destroy();
  });
});

describe("controls exercised directly", () => {
  it("serializes two concurrent persists rather than interleaving them", async () => {
    const ops: string[] = [];
    const gates: Array<() => void> = [];
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "ser", exp: NOW + 30 }), NOW + 30),
      save: async (t) => {
        ops.push(`start:${t.expiresAt}`);
        await new Promise<void>((r) => gates.push(r));
        ops.push(`end:${t.expiresAt}`);
      },
      clear: () => undefined,
    };
    let n = 0;
    const impl = (async () => {
      const exp = NOW + 7200 + ++n;
      return jsonRes({
        access_token: makeJwt({ jti: `s${n}`, exp }),
        refresh_token: makeJwt({ jti: `s${n}`, exp }),
        token_type: "Bearer",
        expires: exp,
      });
    }) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
    // Two independent callbacks each persist a token; their saves are gated so
    // both are outstanding at once unless the mutex serializes them.
    const a = c.handleCallback("http://app.test/cb?code=a&state=s").catch(() => null);
    const b = c.handleCallback("http://app.test/cb?code=b&state=s").catch(() => null);
    for (let i = 0; i < 6; i++) await flush();
    expect(ops.filter((o) => o.startsWith("start:")).length).toBe(1);
    gates[0]?.();
    for (let i = 0; i < 6; i++) await flush();
    gates[1]?.();
    for (let i = 0; i < 6; i++) await flush();
    await a;
    await b;
    // Strict mutex property: saves never overlap. Walking the log, every
    // "start" must be immediately followed by its own "end".
    expect(ops.length).toBeGreaterThanOrEqual(2);
    let depth = 0;
    for (const op of ops) {
      if (op.startsWith("start:")) depth += 1;
      else depth -= 1;
      expect(depth).toBeLessThanOrEqual(1); // never two saves in flight at once
    }
    c.destroy();
  });

  it("a transient refresh failure after a PEER clear does not return the stale token", async () => {
    const restore = installFakeBroadcastChannel();
    const storage = new MemoryStorage();
    const pfJwt = makeJwt({ jti: "pf", exp: NOW + 60 });
    await storage.save(stored(pfJwt, NOW + 60));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const impl = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.endsWith("/token")) {
        await gate;
        return jsonRes({}, 503);
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl, crossTab: true });
    const p = c.getToken().catch(() => null);
    await flush();
    await flush();
    // A PEER announces the session is gone; no local logout is involved, so
    // only the refresh failure branch can stop the stale-token fallback.
    channel(c.channelName).postMessage({
      // A peer binds its lifecycle message to the session it is ending.
      // This tab HAS observed the token (getToken() above), so an unbound
      // message is no longer evidence about this session.
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      sessionVersion: fingerprint(pfJwt),
      at: Date.now(),
      operationId: "bbbb000011112222",
      startedAt: Date.now(),
    });
    await flush();
    await flush();
    release();
    expect(await p).toBeNull();
    c.destroy();
    restore();
  });
});
