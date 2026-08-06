/**
 * RECOVERY is a lifecycle state, not an error path.
 *
 * A fail-closed state treated as a one-shot loses exactly what it exists to
 * protect: the credential that could not be revoked is forgotten instead of
 * retried, a block taken by one holder cannot be resolved by another, a terminal
 * `/token` rejection ends the session everywhere except in the lifecycle model,
 * and a callback refused for lifecycle reasons is refused with `code` and
 * `state` still in the address bar. Each case below drives one such state all
 * the way to its resolution.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  PyOidcAuthClient,
  type AuthConfig,
  type AuthEvent,
  type StoredToken,
  type TokenStorage,
} from "../src/index.js";
import { fetchView, installFakeBroadcastChannel, jsonRes, makeJwt, stored } from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const RESOURCE = "https://api.test/data";
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await flush();
};

function gate(): { promise: Promise<void>; release: () => void; fail: (e?: unknown) => void } {
  let release!: () => void;
  let fail!: (e?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    release = () => res();
    fail = (e) => rej(e ?? new Error("gate rejected"));
  });
  promise.catch(() => undefined); // never an unhandled rejection
  return { promise, release, fail };
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

/** Read the `token` field out of a recorded /revoke request body. */
async function revokedToken(init: RequestInit): Promise<string> {
  const body = typeof init.body === "string" ? init.body : "";
  return new URLSearchParams(body).get("token") ?? "";
}

const blocked = (p: Promise<unknown>) =>
  p.then(
    () => false,
    () => true,
  );

// ---------------------------------------------------------------------------
// 1 + 8: a failed invalidation must survive for retry
// ---------------------------------------------------------------------------

describe("failed invalidations are preserved for retry", () => {
  it("a second logout retries the revocation the first one could not complete", async () => {
    const jwt = makeJwt({ jti: "t1", exp: NOW + 3600 });
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
    const revoked: string[] = [];
    let revokeStatus = 500;
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const v = fetchView(i, init);
      if (v.url.endsWith("/revoke")) {
        revoked.push(await revokedToken(v.init));
        return jsonRes({}, revokeStatus);
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    await expect(c.logout({ localOnly: true })).rejects.toThrow();
    expect(revoked).toEqual([jwt]); // attempted once, unsuccessfully
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);

    revokeStatus = 200; // the server recovers
    await c.logout({ localOnly: true }); // the retry must actually retry

    expect(revoked).toEqual([jwt, jwt]); // the credential was remembered
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(false);
    c.destroy();
  });

  it("a failed orphan revocation is retried by a later logout", async () => {
    const oldJwt = makeJwt({ jti: "t8-old", exp: NOW + 30 });
    const orphan = makeJwt({ jti: "t8-orphan", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 30);
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
    const revoked: string[] = [];
    let revokeStatus = 500;
    const tokenGate = gate();
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const v = fetchView(i, init);
      if (v.url.endsWith("/token")) {
        await tokenGate.promise;
        return jsonRes({
          access_token: orphan,
          refresh_token: orphan,
          token_type: "Bearer",
          expires: NOW + 7200,
        });
      }
      if (v.url.endsWith("/revoke")) {
        revoked.push(await revokedToken(v.init));
        return jsonRes({}, revokeStatus);
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { acknowledgeUnsupportedRevocation: false },
    });

    const r = c.refresh({ force: true }).catch(() => null);
    await settle();
    // The first logout succeeds (the old credential revokes cleanly)...
    revokeStatus = 200;
    await c.logout({ localOnly: true }).catch(() => undefined);
    revokeStatus = 500; // ...but the ORPHAN's does not
    tokenGate.release();
    await r;
    await settle();

    expect(revoked).toContain(orphan); // attempted
    // The only reference to a live credential must not be dropped on the floor.
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);
    const before = revoked.filter((t) => t === orphan).length;
    revokeStatus = 200;
    await c.logout({ localOnly: true });
    expect(revoked.filter((t) => t === orphan).length).toBeGreaterThan(before);
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// 2 + 3: peer recovery is resolvable, and login is not an escape hatch
// ---------------------------------------------------------------------------

describe("peer recovery is a resolvable state", () => {
  it("a successful local logout releases a retained peer block", async () => {
    const restore = installFakeBroadcastChannel();
    const jwt = makeJwt({ jti: "t2", exp: NOW + 3600 });
    let cur: StoredToken | null = stored(jwt, NOW + 3600);
    let clearWorks = false;
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => cur,
      save: (t) => {
        cur = t;
      },
      clear: () => {
        if (!clearWorks) throw new Error("storage refused");
        cur = null;
      },
    };
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl, crossTab: true });
    const raw = channel(c.channelName);

    raw.postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "aaaa1111bbbb2222",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await settle();
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);

    clearWorks = true; // the storage fault is repaired
    await c.logout({ localOnly: true }); // a clean, complete local logout

    // Cleanly logged out AND unblocked: the peer block was resolved by the
    // very operation that resolved the condition it was protecting against.
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(false);
    expect(await c.getToken({ refresh: "never" })).toBeNull();

    // And the peer's terminal message is now harmless.
    raw.postMessage({
      type: "logout",
      tabId: "peer",
      reason: "user-logout",
      operationId: "aaaa1111bbbb2222",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await settle();
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(false);
    c.destroy();
    restore();
  });

  it("login is refused while a peer clear is still pending", async () => {
    const restore = installFakeBroadcastChannel();
    const jwt = makeJwt({ jti: "t3", exp: NOW + 3600 });
    const clearGate = gate();
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(jwt, NOW + 3600),
      save: () => undefined,
      clear: async () => {
        await clearGate.promise;
      },
    };
    const { c } = mk({ storage, crossTab: true });
    channel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "cccc3333dddd4444",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await settle();

    // The clear has NOT settled. Nothing is known about the credential yet, so
    // a login must not be allowed to declare the situation resolved.
    expect(() => c.beginLogin()).toThrow();
    expect(() => c.login()).toThrow();
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);

    clearGate.fail(); // it turns out the clear failed
    await settle();
    // The verdict has now settled: the credential is still there, the block is
    // RETAINED, and a login is refused while it is held — a login started
    // here produces a callback that `assertNotLoggingOut()` is guaranteed to
    // reject. `logout()` is the recovery operation.
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);
    expect(() => c.beginLogin()).toThrow(/fail-closed/i);
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);
    c.destroy();
    restore();
  });
});

// ---------------------------------------------------------------------------
// 4 + 5: a terminal /token rejection is a session transition
// ---------------------------------------------------------------------------

describe("a terminal refresh ends the session", () => {
  it("it invalidates leases held by earlier operations", async () => {
    const jwt = makeJwt({ jti: "t4", exp: NOW + 3600 });
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
    const resGate = gate();
    const impl = (async (i: RequestInfo | URL) => {
      const { url } = fetchView(i);
      if (url === RESOURCE) {
        await resGate.promise;
        return jsonRes({ secret: 1 });
      }
      if (url.endsWith("/token")) return jsonRes({}, 401);
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    // An earlier operation is in flight, holding a lease on this session.
    const p = c.fetch(RESOURCE).then(
      () => "returned",
      () => "rejected",
    );
    await settle();
    // The server declares the session dead.
    await c.refresh({ force: true }).catch(() => undefined);
    await settle();
    resGate.release();
    await settle();

    expect(await p).toBe("rejected");
    c.destroy();
  });

  it("a clear failure during the terminal transition stays fail-closed", async () => {
    const jwt = makeJwt({ jti: "t5", exp: NOW + 3600 });
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
    const impl = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.endsWith("/token")) return jsonRes({}, 401);
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    await c.refresh({ force: true }).catch(() => undefined);
    await settle();

    // The credential the server just rejected is demonstrably still in storage.
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);
    expect(await blocked(c.fetch(RESOURCE))).toBe(true);
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// 6: a callback refused for lifecycle reasons is still scrubbed
// ---------------------------------------------------------------------------

describe("callback scrubbing precedes lifecycle rejection", () => {
  it("a callback refused because logout is running leaves no code in the URL", async () => {
    const clearGate = gate();
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "t6", exp: NOW + 3600 }), NOW + 3600),
      save: () => undefined,
      clear: async () => {
        await clearGate.promise;
      },
    };
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });

    const lo = c.logout({ localOnly: true }).catch(() => undefined);
    await flush(); // the gate is blocked, not settled
    history.replaceState(null, "", "/cb?keep=1&code=SCRUBME&state=STATE1");
    await expect(c.handleCallback()).rejects.toThrow();

    expect(location.href).not.toContain("SCRUBME");
    expect(location.href).not.toContain("STATE1");
    expect(location.href).toContain("keep=1"); // the app's own params survive
    clearGate.release();
    await lo;
    c.destroy();
  });

  it("an unregistered route is never rewritten", async () => {
    const { c } = mk({ storage: new MemoryStorage() });
    history.replaceState(null, "", "/not-ours?code=KEEPME&state=s");
    await expect(c.handleCallback(location.href)).rejects.toThrow();
    expect(location.href).toContain("KEEPME");
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// 7: application event listeners are re-entrant boundaries
// ---------------------------------------------------------------------------

describe("event listeners are re-entrant boundaries", () => {
  it("a listener that logs out during token-refreshed prevents the return", async () => {
    const oldJwt = makeJwt({ jti: "t7-old", exp: NOW + 30 });
    const newJwt = makeJwt({ jti: "t7-new", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 30);
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
      if (fetchView(i).url.endsWith("/token")) {
        return jsonRes({
          access_token: newJwt,
          refresh_token: newJwt,
          token_type: "Bearer",
          expires: NOW + 7200,
        });
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    c.on((e) => {
      // A perfectly ordinary application reaction: "the token changed, and I
      // have decided this user must be signed out."
      if (e.type === "token-refreshed") void c.logout({ localOnly: true });
    });

    const out = await c.refresh({ force: true }).then(
      (t) => t.accessToken,
      () => "rejected",
    );
    expect(out).toBe("rejected");
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// 9: refreshes are not serialized across generations
// ---------------------------------------------------------------------------

describe("refresh single-flight does not span generations", () => {
  it("a new session's refresh does not wait for a stranded old one", async () => {
    const oldJwt = makeJwt({ jti: "t9-old", exp: NOW + 30 });
    const newJwt = makeJwt({ jti: "t9-new", exp: NOW + 60 });
    const mintJwt = makeJwt({ jti: "t9-mint", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 30);
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
    const stuck = gate();
    let tokenCalls = 0;
    const impl = (async (i: RequestInfo | URL) => {
      const { url } = fetchView(i);
      if (url.endsWith("/token")) {
        if (++tokenCalls === 1) {
          await stuck.promise;
          return jsonRes({}, 503);
        }
        return jsonRes({
          access_token: mintJwt,
          refresh_token: mintJwt,
          token_type: "Bearer",
          expires: NOW + 7200,
        });
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    const stranded = c.refresh({ force: true }).catch(() => null);
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    c.login(); // a NEW session
    cur = stored(newJwt, NOW + 60);

    // The new session must be able to refresh NOW, while the old attempt is
    // still hanging on a request that may never return.
    const fresh = await Promise.race([
      c.refresh({ force: true }).then(
        (t) => t.accessToken,
        (e) => `err:${(e as Error).name}`,
      ),
      settle(40).then(() => "TIMED-OUT-WAITING-FOR-OLD-REFRESH"),
    ]);
    expect(fresh).toBe(mintJwt);

    stuck.release();
    await stranded;
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// Call-site controls.
//
// T1–T9 are behavioural regressions. The tests below pin the individual
// controls the mutation gate removes, each asserting the one thing that must
// not happen when that specific control is gone.
// ---------------------------------------------------------------------------

describe("recovery-state controls", () => {
  it("diagnose() fails while a recovery state is held", async () => {
    const jwt = makeJwt({ jti: "mdiag", exp: NOW + 3600 });
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

    const before = await c.diagnose();
    // No recovery state yet. (The report is already non-ok here because the
    // fixture acknowledges insecure transport; that is a separate check.)
    expect(before.checks.some((x) => x.name === "recovery-state")).toBe(false);

    await c.logout({ localOnly: true }).catch(() => undefined);
    const after = await c.diagnose();
    expect(after.ok).toBe(false);
    expect(after.checks.some((x) => x.name === "recovery-state" && !x.ok)).toBe(true);
    c.destroy();
  });

  it("a failed orphan revocation is not reported as clean", async () => {
    // Isolates the RESULT INSPECTION: revokeAll returns its error rather than
    // throwing, so a bare try/catch around it sees nothing at all.
    const oldJwt = makeJwt({ jti: "morph-old", exp: NOW + 30 });
    const orphan = makeJwt({ jti: "morph", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 30);
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
    const tokenGate = gate();
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const v = fetchView(i, init);
      if (v.url.endsWith("/token")) {
        await tokenGate.promise;
        return jsonRes({
          access_token: orphan,
          refresh_token: orphan,
          token_type: "Bearer",
          expires: NOW + 7200,
        });
      }
      // Every revocation fails, including the orphan's.
      if (v.url.endsWith("/revoke")) return jsonRes({}, 500);
      return jsonRes({});
    }) as typeof fetch;
    const { c, events } = mk({ storage, fetchImpl: impl });

    const r = c.refresh({ force: true }).catch(() => null);
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    tokenGate.release();
    await r;
    await settle();

    expect(
      events.some((e) => e.type === "security-warning" && e.code === "pending-revocation-blocked"),
    ).toBe(true);
    c.destroy();
  });

  it("an unsettled peer clear refuses login", async () => {
    const restore = installFakeBroadcastChannel();
    const clearGate = gate();
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "mpp", exp: NOW + 3600 }), NOW + 3600),
      save: () => undefined,
      clear: async () => {
        await clearGate.promise;
      },
    };
    const { c } = mk({ storage, crossTab: true });
    channel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "eeee5555ffff6666",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await settle();

    expect(() => c.beginLogin()).toThrow(/fail-closed/i);
    clearGate.release();
    await settle();
    c.destroy();
    restore();
  });

  it("a completed logout releases a peer-owned block", async () => {
    const restore = installFakeBroadcastChannel();
    let clearWorks = false;
    let cur: StoredToken | null = stored(makeJwt({ jti: "mpr", exp: NOW + 3600 }), NOW + 3600);
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => cur,
      save: (t) => {
        cur = t;
      },
      clear: () => {
        if (!clearWorks) throw new Error("storage refused");
        cur = null;
      },
    };
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl, crossTab: true });
    channel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "1111aaaa2222bbbb",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await settle();
    clearWorks = true;
    await c.logout({ localOnly: true });
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(false);
    c.destroy();
    restore();
  });

  it("a retained credential is resent to /revoke", async () => {
    const jwt = makeJwt({ jti: "mretry", exp: NOW + 3600 });
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
    const revoked: string[] = [];
    let status = 500;
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const v = fetchView(i, init);
      if (v.url.endsWith("/revoke")) {
        revoked.push(await revokedToken(v.init));
        return jsonRes({}, status);
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    await c.logout({ localOnly: true }).catch(() => undefined);
    status = 200;
    await c.logout({ localOnly: true }).catch(() => undefined);
    // Storage is empty by now, so the ONLY way a second request happens is the
    // retained reference.
    expect(revoked).toHaveLength(2);
    c.destroy();
  });

  it("a terminal refresh invalidates an unrelated in-flight lease", async () => {
    const jwt = makeJwt({ jti: "mtg", exp: NOW + 3600 });
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
    const resGate = gate();
    const impl = (async (i: RequestInfo | URL) => {
      const { url } = fetchView(i);
      if (url === RESOURCE) {
        await resGate.promise;
        return jsonRes({ ok: 1 });
      }
      if (url.endsWith("/token")) return jsonRes({}, 401);
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    const p = c.fetch(RESOURCE).then(
      () => "returned",
      () => "rejected",
    );
    await settle();
    await c.refresh({ force: true }).catch(() => undefined);
    await settle();
    resGate.release();
    await settle();
    expect(await p).toBe("rejected");
    c.destroy();
  });

  it("a terminal transition whose clear fails stays blocked", async () => {
    const jwt = makeJwt({ jti: "mtc", exp: NOW + 3600 });
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
    const impl = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.endsWith("/token")) return jsonRes({}, 401);
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    await c.refresh({ force: true }).catch(() => undefined);
    await settle();
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);
    c.destroy();
  });

  it("a callback refused by the blocked-session check is already scrubbed", async () => {
    const clearGate = gate();
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "ms", exp: NOW + 3600 }), NOW + 3600),
      save: () => undefined,
      clear: async () => {
        await clearGate.promise;
      },
    };
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
    const lo = c.logout({ localOnly: true }).catch(() => undefined);
    await flush();
    history.replaceState(null, "", "/cb?code=MSCRUB&state=MSTATE");
    await expect(c.handleCallback()).rejects.toThrow();
    expect(location.href).not.toContain("MSCRUB");
    clearGate.release();
    await lo;
    c.destroy();
  });

  it("a logout started by a token-refreshed listener wins", async () => {
    const oldJwt = makeJwt({ jti: "mre-old", exp: NOW + 30 });
    const newJwt = makeJwt({ jti: "mre-new", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 30);
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
      if (fetchView(i).url.endsWith("/token")) {
        return jsonRes({
          access_token: newJwt,
          refresh_token: newJwt,
          token_type: "Bearer",
          expires: NOW + 7200,
        });
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    c.on((e) => {
      if (e.type === "token-refreshed") void c.logout({ localOnly: true });
    });
    const out = await c.refresh({ force: true }).then(
      () => "returned",
      () => "rejected",
    );
    expect(out).toBe("rejected");
    c.destroy();
  });

  it("a new generation's refresh starts without the old one settling", async () => {
    const oldJwt = makeJwt({ jti: "mgw-old", exp: NOW + 30 });
    const newJwt = makeJwt({ jti: "mgw-new", exp: NOW + 60 });
    const mintJwt = makeJwt({ jti: "mgw-mint", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 30);
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
    const stuck = gate();
    let n = 0;
    const impl = (async (i: RequestInfo | URL) => {
      const { url } = fetchView(i);
      if (url.endsWith("/token")) {
        if (++n === 1) {
          await stuck.promise;
          return jsonRes({}, 503);
        }
        return jsonRes({
          access_token: mintJwt,
          refresh_token: mintJwt,
          token_type: "Bearer",
          expires: NOW + 7200,
        });
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    const stranded = c.refresh({ force: true }).catch(() => null);
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    c.login();
    cur = stored(newJwt, NOW + 60);
    const fresh = await Promise.race([
      c.refresh({ force: true }).then(
        (t) => t.accessToken,
        () => "err",
      ),
      settle(40).then(() => "TIMED-OUT"),
    ]);
    expect(fresh).toBe(mintJwt);
    stuck.release();
    await stranded;
    c.destroy();
  });
});
