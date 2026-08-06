/**
 * The ORIGINAL lease must survive every nested continuation.
 *
 * A lease captured at a public entry is what ties an in-flight operation to the
 * session that started it, and nested paths lose that tie three ways: one never
 * receives the lease (serverManagedRefresh), one captures a *fresh* one (the
 * fetch 401 retry calling public refresh()), and the peer-rotation and
 * 401-recovery early returns hand a credential back before any check runs. Each
 * case below pins one continuation boundary, so a token that belongs to an ended
 * session cannot be returned into its replacement.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  NotAuthenticatedError,
  PyOidcAuthClient,
  ServerManagedStorage,
  type AuthConfig,
  type AuthEvent,
  type StoredToken,
  type TokenStorage,
} from "../src/index.js";
import { fingerprint } from "../src/jwt.js";
import { withCrossTabLock } from "../src/crosstab.js";
import { fetchView, installFakeBroadcastChannel, jsonRes, makeJwt, stored } from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const RESOURCE = "https://api.test/data";
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (n = 8) => {
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

/** Resolve to the token's access value, or the marker "rejected". */
const outcome = (p: Promise<StoredToken | null>) =>
  p.then(
    (t) => t?.accessToken ?? "null",
    () => "rejected",
  );

// ---------------------------------------------------------------------------
// 1–2: an old refresh operation must never hand back a newer session's token
// ---------------------------------------------------------------------------

describe("refresh keeps its originating lease across every boundary", () => {
  it("a refresh paused on its first storage load does not return the new token", async () => {
    const oldJwt = makeJwt({ jti: "r1-old", exp: NOW + 30 });
    const newJwt = makeJwt({ jti: "r1-new", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 30);
    const g = gate();
    let loads = 0;
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      // The FIRST load is already in flight when the session ends: it resolves
      // with what it read then (the old token), long after logout+login.
      load: async () => {
        const snapshot = cur;
        if (++loads === 1) {
          await g.promise;
          return snapshot;
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
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    const r = outcome(c.refresh({ force: true }));
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    c.login(); // a NEW session begins
    cur = stored(newJwt, NOW + 7200); // the new session's token
    g.release();
    await settle();

    expect(await r).toBe("rejected");
    c.destroy();
  });

  it("a refresh receiving 401 after logout+login does not return the new token", async () => {
    const oldJwt = makeJwt({ jti: "r2-old", exp: NOW + 30 });
    const newJwt = makeJwt({ jti: "r2-new", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 30);
    const g = gate();
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
    const impl = (async (i: RequestInfo | URL) => {
      const { url } = fetchView(i);
      if (url.endsWith("/token")) {
        await g.promise;
        return jsonRes({}, 401);
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    const r = outcome(c.refresh({ force: true }));
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    c.login();
    cur = stored(newJwt, NOW + 7200);
    g.release();
    await settle();

    expect(await r).toBe("rejected");
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// 3 + 10: a request must stay inside the operation (and session) that began it
// ---------------------------------------------------------------------------

describe("fetch retries stay in the originating operation", () => {
  it("an eligible 401 arriving after a new login does not refresh or retry", async () => {
    const oldJwt = makeJwt({ jti: "r3-old", exp: NOW + 3600 });
    const newJwt = makeJwt({ jti: "r3-new", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 3600);
    const g = gate();
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
    const calls: string[] = [];
    const impl = (async (i: RequestInfo | URL) => {
      const { url } = fetchView(i);
      calls.push(url);
      if (url === RESOURCE) {
        if (calls.filter((u) => u === RESOURCE).length === 1) {
          await g.promise;
          return new Response("no", {
            status: 401,
            headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
          });
        }
        return jsonRes({ ok: true });
      }
      if (url.endsWith("/token")) {
        const j = makeJwt({ jti: "r3-mint", exp: NOW + 7200 });
        return jsonRes({
          access_token: j,
          refresh_token: j,
          token_type: "Bearer",
          expires: NOW + 7200,
        });
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    const p = c.fetch(RESOURCE).then(
      () => "returned",
      () => "rejected",
    );
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    c.login();
    cur = stored(newJwt, NOW + 7200);
    g.release();
    await settle();

    expect(await p).toBe("rejected");
    expect(calls.filter((u) => u.endsWith("/token"))).toHaveLength(0);
    expect(calls.filter((u) => u === RESOURCE)).toHaveLength(1);
    c.destroy();
  });

  it("an authenticated response arriving after logout is not returned", async () => {
    const jwt = makeJwt({ jti: "r10", exp: NOW + 3600 });
    let cur: StoredToken | null = stored(jwt, NOW + 3600);
    const g = gate();
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
    const impl = (async (i: RequestInfo | URL) => {
      const { url } = fetchView(i);
      if (url === RESOURCE) {
        await g.promise;
        return jsonRes({ secret: "payload" });
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    const p = c.fetch(RESOURCE).then(
      () => "returned",
      () => "rejected",
    );
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    g.release();
    await settle();

    expect(await p).toBe("rejected");
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// 4: server-managed refresh never received a lease at all
// ---------------------------------------------------------------------------

describe("server-managed refresh carries the lease", () => {
  it("a refresh waiting on CSRF after logout sends no health request and returns no token", async () => {
    const g = gate();
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      healthUrl: "http://app.test/health",
      csrf: {
        headerName: "X-CSRFToken",
        token: async () => {
          await g.promise;
          return "T";
        },
      },
      tokenProvider: () => ({
        accessToken: "sm-token",
        tokenType: "Bearer",
        expiresAt: NOW + 600,
        sessionVersion: "v1",
      }),
    });
    const urls: string[] = [];
    const impl = (async (i: RequestInfo | URL) => {
      urls.push(fetchView(i).url);
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: {
        allowedResourceOrigins: ["http://app.test"],
        acknowledgeNoBackendLogout: true,
      },
    });

    const r = outcome(c.refresh({ force: true }));
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    g.release();
    await settle();

    expect(urls.some((u) => u.endsWith("/health"))).toBe(false);
    expect(await r).toBe("rejected");
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// 5: logout must invalidate the credential that was minted moments ago
// ---------------------------------------------------------------------------

describe("logout invalidates in-flight candidate credentials", () => {
  it("a token still inside storage.save() when logout begins is revoked", async () => {
    const oldJwt = makeJwt({ jti: "r5-old", exp: NOW + 30 });
    const newJwt = makeJwt({ jti: "r5-new", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 30);
    const saveGate = gate();
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => cur,
      save: async (t) => {
        await saveGate.promise;
        cur = t;
      },
      clear: () => {
        cur = null;
      },
    };
    const revoked: string[] = [];
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const v = fetchView(i, init);
      if (v.url.endsWith("/token")) {
        return jsonRes({
          access_token: newJwt,
          refresh_token: newJwt,
          token_type: "Bearer",
          expires: NOW + 7200,
        });
      }
      if (v.url.endsWith("/revoke")) {
        const body =
          typeof v.init.body === "string"
            ? v.init.body
            : await new Request("http://x/", {
                method: "POST",
                body: (v.init.body ?? "") as BodyInit,
              }).text();
        revoked.push(new URLSearchParams(body).get("token") ?? "");
        return jsonRes({});
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    const r = c.refresh({ force: true }).catch(() => null);
    await settle(); // the mint has happened; save is pending
    const lo = c.logout({ localOnly: true }).catch(() => undefined);
    await settle();
    saveGate.release();
    await r;
    await lo;
    await settle();

    // The value the server just minted is live until it is revoked. Revoking
    // only the token logout happened to read first leaves it usable.
    expect(revoked).toContain(newJwt);
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// 6–7: an incomplete logout must stay closed, not reopen in `finally`
// ---------------------------------------------------------------------------

describe("an incomplete logout is persistently fail-closed", () => {
  it("after a rejected local clear, getToken() remains blocked", async () => {
    const jwt = makeJwt({ jti: "r6", exp: NOW + 3600 });
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(jwt, NOW + 3600),
      save: () => undefined,
      clear: () => {
        throw new Error("storage refused");
      },
    };
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    await expect(c.logout({ localOnly: true })).rejects.toThrow(/Logout incomplete/i);
    // The credential is demonstrably still in storage, so it must stay unreadable.
    await expect(c.getToken({ refresh: "never" })).rejects.toThrow();
    c.destroy();
  });

  it("after a failed BFF backend logout, cookie-authenticated fetch remains blocked", async () => {
    const storage = new ServerManagedStorage({
      transport: "bff",
      logoutEndpoint: "http://app.test/logout",
      acknowledgeNoCsrf: true,
    });
    const impl = (async (i: RequestInfo | URL) => {
      const { url } = fetchView(i);
      if (url.endsWith("/logout")) return jsonRes({}, 500);
      return jsonRes({ ok: true });
    }) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });

    await expect(c.logout({ localOnly: true })).rejects.toThrow(/server-side session/i);
    await expect(c.fetch(RESOURCE)).rejects.toThrow();
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// 8–9: peer lifecycle recovery
// ---------------------------------------------------------------------------

describe("peer lifecycle recovery", () => {
  // A retained block refuses beginLogin() outright rather than letting it
  // proceed, because the callback such a login produces is guaranteed to be
  // rejected. The security assertion — the token stays unreadable — holds
  // either way; failing fast merely spares a round trip to the IDP.
  it("beginLogin() does not expose a token a failed peer clear left behind", async () => {
    const restore = installFakeBroadcastChannel();
    const jwt = makeJwt({ jti: "r8", exp: NOW + 3600 });
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(jwt, NOW + 3600),
      save: () => undefined,
      clear: () => {
        throw new Error("storage refused");
      },
    };
    const { c } = mk({ storage, crossTab: true });
    channel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "aaaa1111bbbb2222",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await settle();

    // Refused outright: a login whose callback cannot succeed is not recovery.
    expect(() => c.beginLogin()).toThrow(/fail-closed/i);
    await expect(c.getToken({ refresh: "never" })).rejects.toThrow();
    c.destroy();
    restore();
  });

  it("a retired peer operation's terminal message does not kill the new session", async () => {
    const restore = installFakeBroadcastChannel();
    const storage = new MemoryStorage();
    const oldJwt = makeJwt({ jti: "r9-old", exp: NOW + 3600 });
    const newJwt = makeJwt({ jti: "r9-new", exp: NOW + 7200 });
    await storage.save(stored(oldJwt, NOW + 3600));
    const { c } = mk({ storage, crossTab: true });
    const raw = channel(c.channelName);

    raw.postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "cccc3333dddd4444",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await settle(); // the peer clear SUCCEEDS

    // An unfinished peer operation holds a block, and login is refused while
    // one is held. `logout()` is the recovery operation — it releases
    // the peer-owned block and RETIRES the operation.
    await c.logout({ localOnly: true });
    c.beginLogin(); // a new session is safely established
    await storage.save(stored(newJwt, NOW + 7200));

    raw.postMessage({
      type: "logout",
      tabId: "peer",
      reason: "user-logout",
      operationId: "cccc3333dddd4444",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await settle();

    const t = await c.getToken({ refresh: "never" }).catch(() => null);
    expect(t?.accessToken).toBe(newJwt);
    c.destroy();
    restore();
  });
});

// ---------------------------------------------------------------------------
// Call-site controls.
//
// R1–R10 above are behavioural regressions and are deliberately defended in
// depth: several of them are caught by more than one check. The tests below
// exist so that each INDIVIDUAL call site is independently verifiable — each
// one ends the session at exactly one boundary and asserts the specific thing
// that must not happen if the check at that boundary is deleted. The mutation
// gate runs these by name, one per mutation.
// ---------------------------------------------------------------------------

describe("call-site controls", () => {
  it("a refresh whose first storage load resolves after logout fails as session-ended", async () => {
    // Without the post-load check the operation walks on into the refresh
    // machinery and fails with a *refresh* diagnostic instead — meaning it read
    // and interpreted a dead session's credential rather than stopping.
    const g = gate();
    let loads = 0;
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: async () => {
        if (++loads === 1) await g.promise;
        // Access-only: the refresh machinery rejects it with its own error, so
        // the two outcomes are distinguishable by error type.
        return {
          accessToken: makeJwt({ jti: "m1", exp: NOW + 30 }),
          tokenType: "Bearer",
          expiresAt: NOW + 30,
          sessionVersion: "m1",
        } as StoredToken;
      },
      save: () => undefined,
      clear: () => undefined,
    };
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    const r = c.refresh({ force: true }).catch((e: unknown) => e);
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    g.release();
    await settle();

    expect(await r).toBeInstanceOf(NotAuthenticatedError);
    c.destroy();
  });

  it("a refresh that acquires the cross-tab lock after logout reads no storage", async () => {
    const jwt = makeJwt({ jti: "m2", exp: NOW + 30 });
    let loads = 0;
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => {
        loads += 1;
        return stored(jwt, NOW + 30);
      },
      save: () => undefined,
      clear: () => undefined,
    };
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    // Hold the very lock the refresh needs, so it queues outside our code.
    // The IN-PAGE chain is scoped by session generation (a stranded refresh
    // from a dead session must not gate a new one), so the holder uses the
    // current generation's key.
    const lockGate = gate();
    const holder = withCrossTabLock(
      `${c.channelName}:refresh`,
      false,
      () => lockGate.promise,
      `${c.channelName}:refresh:0`,
    );
    const r = c.refresh({ force: true }).catch(() => null);
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    await settle();

    const before = loads; // everything up to the lock has happened
    lockGate.release();
    await holder;
    await settle();

    // The check at lock entry must stop it BEFORE the re-load under the lock.
    expect(loads).toBe(before);
    expect(await r).toBeNull();
    c.destroy();
  });

  it("a peer-rotation early return does not hand back a token read after logout", async () => {
    const oldJwt = makeJwt({ jti: "m3-old", exp: NOW + 30 });
    const newJwt = makeJwt({ jti: "m3-new", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 30);
    const g = gate();
    let loads = 0;
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      // The SECOND load — the one under the cross-tab lock — is the boundary.
      // Everything before it happens in a live session.
      load: async () => {
        if (++loads === 2) await g.promise;
        return cur;
      },
      save: (t) => {
        cur = t;
      },
      clear: () => {
        cur = null;
      },
    };
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    const r = outcome(c.refresh({ force: true }));
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    c.login();
    cur = stored(newJwt, NOW + 7200); // the new session's token
    g.release();
    await settle();

    // rotatedByPeer is true here: a different sessionVersion, not expiring.
    expect(await r).toBe("rejected");
    c.destroy();
  });

  it("a 401 retry does not mint or store a credential in a session it does not belong to", async () => {
    const oldJwt = makeJwt({ jti: "m6-old", exp: NOW + 3600 });
    const newJwt = makeJwt({ jti: "m6-new", exp: NOW + 7200 });
    const mintJwt = makeJwt({ jti: "m6-mint", exp: NOW + 7200 });
    // Comfortably fresh, so the initial getToken() returns it directly and the
    // 401 below is what starts the refresh — that is the path under test.
    let cur: StoredToken | null = stored(oldJwt, NOW + 3600);
    const saves: string[] = [];
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => cur,
      save: (t) => {
        saves.push(t.accessToken);
        cur = t;
      },
      clear: () => {
        cur = null;
      },
    };
    const tokenGate = gate();
    const calls: string[] = [];
    const impl = (async (i: RequestInfo | URL) => {
      const { url } = fetchView(i);
      calls.push(url);
      if (url === RESOURCE) {
        // The 401 arrives while the session is STILL ALIVE, so the response
        // check passes and the retry machinery legitimately starts.
        if (calls.filter((u) => u === RESOURCE).length === 1) {
          return new Response("no", {
            status: 401,
            headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
          });
        }
        return jsonRes({ ok: true });
      }
      if (url.endsWith("/token")) {
        await tokenGate.promise; // the session ends during the forced refresh
        return jsonRes({
          access_token: mintJwt,
          refresh_token: mintJwt,
          token_type: "Bearer",
          expires: NOW + 7200,
        });
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c, events } = mk({ storage, fetchImpl: impl });

    const p = c.fetch(RESOURCE).then(
      () => "returned",
      () => "rejected",
    );
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    c.login();
    cur = stored(newJwt, NOW + 7200);
    saves.length = 0; // only writes from here on matter
    tokenGate.release();
    await settle();

    expect(await p).toBe("rejected");
    // A retry that captured a NEW lease would treat the mint as a legitimate
    // refresh of the new session: persisting it and announcing it.
    expect(saves).not.toContain(mintJwt);
    expect(events.filter((e) => e.type === "token-refreshed")).toHaveLength(0);
    // The old session's request must not overwrite the new session's token.
    expect(cur?.accessToken).toBe(newJwt);
    c.destroy();
  });

  it("a transient NETWORK refresh failure after a peer clear returns no stale token", async () => {
    // The failure branch in getToken() is the last thing standing when the
    // refresh never got a response at all — there is no response boundary to
    // validate, so a transient error would otherwise become "use the old token".
    const restore = installFakeBroadcastChannel();
    const storage = new MemoryStorage();
    const m11Jwt = makeJwt({ jti: "m11", exp: NOW + 60 });
    await storage.save(stored(m11Jwt, NOW + 60));
    const g = gate();
    const impl = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.endsWith("/token")) {
        await g.promise;
        throw new TypeError("network down"); // no response, ever
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl, crossTab: true });

    const p = c.getToken().catch(() => null);
    await settle();
    channel(c.channelName).postMessage({
      // Bound to the session being ended (this tab has observed it).
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      sessionVersion: fingerprint(m11Jwt),
      at: Date.now(),
      operationId: "cccc000011112222",
      startedAt: Date.now(),
    });
    await settle();
    g.release();

    expect(await p).toBeNull();
    c.destroy();
    restore();
  });
});
