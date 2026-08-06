/**
 * The recovery state machine is only as good as its own bookkeeping.
 *
 * Three primitives fail in ways the state machine above them cannot compensate
 * for: a reservation that checks capacity without consuming it admits every
 * concurrent minting operation at once, a credential-producing boundary that
 * never enters the lifecycle (server-managed mints) drops a token minted after
 * logout instead of revoking it, and a peer-operation identity that holds
 * exactly one operation - correlated by operation rather than by the session it
 * ends - loses overlapping peers. A retained fail-closed state refuses login.
 */
import { describe, expect, it } from "vitest";
import {
  PyOidcAuthClient,
  ServerManagedStorage,
  type AuthConfig,
  type AuthEvent,
  type StoredToken,
  type TokenStorage,
} from "../src/index.js";
import { CredentialRegistry } from "../src/recovery.js";
import { parseCrossTabMessage } from "../src/crosstab.js";
import { fetchView, installFakeBroadcastChannel, jsonRes, makeJwt, stored } from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await flush();
};

function gate(): { promise: Promise<void>; release: () => void; fail: () => void } {
  let release!: () => void;
  let fail!: () => void;
  const promise = new Promise<void>((res, rej) => {
    release = () => res();
    fail = () => rej(new Error("gate rejected"));
  });
  promise.catch(() => undefined);
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

async function revokedToken(init: RequestInit): Promise<string> {
  const body = typeof init.body === "string" ? init.body : "";
  return new URLSearchParams(body).get("token") ?? "";
}

const blocked = (p: Promise<unknown>) =>
  p.then(
    () => false,
    () => true,
  );

/** A split-token credential: the access value is NOT the refresh value. */
function split(access: string, refresh: string, expiresAt: number): StoredToken {
  return {
    accessToken: access,
    refreshToken: refresh,
    tokenType: "Bearer",
    expiresAt,
    sessionVersion: `sv-${access.slice(-6)}`,
  };
}

// ---------------------------------------------------------------------------
// Reservations must consume capacity, not merely inspect it.
// ---------------------------------------------------------------------------

describe("credential reservations are atomic", () => {
  it("with capacity 1, a second reservation is refused", () => {
    const registry = new CredentialRegistry(1);
    registry.reserve("first");
    // A reservation that only READ the sizes would occupy nothing, so any
    // number of concurrent minting operations could pass the check together.
    expect(() => registry.reserve("second")).toThrow(/refused/i);
  });
});

// ---------------------------------------------------------------------------
// Server-managed mints are credential-producing boundaries too.
// ---------------------------------------------------------------------------

describe("server-managed mints enter the recovery lifecycle", () => {
  it("a token minted after logout is revoked, not silently dropped", async () => {
    const late = makeJwt({ jti: "v2-late", exp: NOW + 7200 });
    const provider = gate();
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      acknowledgeNoCsrf: true,
      tokenProvider: async () => {
        await provider.promise;
        return {
          accessToken: late,
          tokenType: "Bearer",
          expiresAt: NOW + 7200,
          sessionVersion: "v2",
        };
      },
    });
    const revoked: string[] = [];
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const v = fetchView(i, init);
      if (v.url.endsWith("/revoke")) {
        revoked.push(await revokedToken(v.init));
        return jsonRes({});
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { acknowledgeNoBackendLogout: true },
    });

    const r = c.refresh({ force: true }).catch(() => null);
    await settle();
    await c.logout({ localOnly: true }).catch(() => undefined);
    provider.release(); // the backend answers after logout
    await r;
    await settle();

    expect(await r).toBeNull(); // never returned to the application
    expect(revoked).toContain(late); // and not simply forgotten
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// A rejected refresh credential does not prove the access token is dead.
// ---------------------------------------------------------------------------

describe("terminal refresh invalidates the whole known credential", () => {
  it("a split-token terminal 401 still revokes the access token", async () => {
    const access = makeJwt({ jti: "v3-access", exp: NOW + 3600 });
    const refresh = makeJwt({ jti: "v3-refresh", exp: NOW + 86400 });
    let cur: StoredToken | null = split(access, refresh, NOW + 3600);
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
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const v = fetchView(i, init);
      if (v.url.endsWith("/token")) return jsonRes({}, 401);
      if (v.url.endsWith("/revoke")) {
        revoked.push(await revokedToken(v.init));
        return jsonRes({});
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    await c.refresh({ force: true }).catch(() => undefined);
    await settle();

    // The server rejected the REFRESH credential. The access token is a
    // separate, still-unexpired bearer; nothing has invalidated it.
    expect(revoked).toContain(access);
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// Peer lifecycle messages are bound to the session they end.
// ---------------------------------------------------------------------------

describe("peer lifecycle operations are independently correlated", () => {
  it("an older overlapping operation's terminal message spares the new session", async () => {
    const restore = installFakeBroadcastChannel();
    const oldJwt = makeJwt({ jti: "v4-old", exp: NOW + 3600 });
    const newJwt = makeJwt({ jti: "v4-new", exp: NOW + 7200 });
    let cur: StoredToken | null = stored(oldJwt, NOW + 3600);
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
    const { c } = mk({ storage, fetchImpl: impl, crossTab: true });
    const raw = channel(c.channelName);

    // TWO overlapping peer operations. A single id field would let B overwrite
    // A, leaving only B to be retired by the new session.
    raw.postMessage({
      type: "session-cleared",
      tabId: "peerA",
      reason: "user-logout",
      operationId: "aaaa0000aaaa0000",
      at: Date.now(),
      startedAt: Date.now(),
    });
    raw.postMessage({
      type: "session-cleared",
      tabId: "peerB",
      reason: "user-logout",
      operationId: "bbbb1111bbbb1111",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await settle();

    // Both peer operations hold a block; `logout()` is the recovery operation
    // and retires BOTH, not merely the last one it recorded.
    await c.logout({ localOnly: true });
    c.beginLogin();
    history.replaceState(null, "", "/cb?code=v4&state=s");
    await c.handleCallback();
    await settle();
    expect((await c.getToken({ refresh: "never" }))?.accessToken).toBe(newJwt);

    // A's terminal message, arriving late.
    raw.postMessage({
      type: "logout",
      tabId: "peerA",
      reason: "user-logout",
      operationId: "aaaa0000aaaa0000",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await settle();

    expect((await c.getToken({ refresh: "never" }))?.accessToken).toBe(newJwt);
    c.destroy();
    restore();
  });

  it("a terminal message for an operation never seen cannot clear a new session", async () => {
    const restore = installFakeBroadcastChannel();
    const jwt = makeJwt({ jti: "v5a", exp: NOW + 3600 });
    let cur: StoredToken | null = null;
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

    // A session established HERE, in this tab, just now.
    c.beginLogin();
    history.replaceState(null, "", "/cb?code=v5a&state=s");
    await c.handleCallback();
    await settle();

    // Well-formed, fresh, correctly shaped - and naming no session at all, for
    // an operation this tab has never been told anything about. An operation
    // id identifies an operation, not the session it was meant to end.
    channel(c.channelName).postMessage({
      type: "logout",
      tabId: "peerX",
      reason: "user-logout",
      operationId: "9999888877776666",
      startedAt: Date.now(),
      at: Date.now(),
    });
    await settle();

    expect((await c.getToken({ refresh: "never" }).catch(() => null))?.accessToken).toBe(jwt);

    // And one that DOES name our session is still honoured, even though its
    // session-cleared was lost.
    const version = (await c.getToken({ refresh: "never" }))!.sessionVersion;
    channel(c.channelName).postMessage({
      type: "logout",
      tabId: "peerY",
      reason: "user-logout",
      operationId: "5555444433332222",
      sessionVersion: version,
      startedAt: Date.now(),
      at: Date.now(),
    });
    await settle();
    expect(await c.getToken({ refresh: "never" }).catch(() => null)).toBeNull();
    c.destroy();
    restore();
  });

  it("lifecycle messages without an operation id are rejected by the parser", () => {
    const now = Date.now();
    for (const type of ["logout", "session-cleared"] as const) {
      expect(
        parseCrossTabMessage({ type, tabId: "peer", reason: "user-logout", at: now }, now),
      ).toBeNull();
    }
    // A correlated one still parses.
    expect(
      parseCrossTabMessage(
        {
          type: "logout",
          tabId: "peer",
          reason: "user-logout",
          operationId: "abcdabcdabcdabcd",
          at: now,
          startedAt: Date.now(),
        },
        now,
      ),
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A retained fail-closed state refuses login.
// ---------------------------------------------------------------------------

describe("login is refused in every fail-closed state", () => {
  it("after a failed peer clear, beginLogin() and login() throw and write nothing", async () => {
    const restore = installFakeBroadcastChannel();
    const jwt = makeJwt({ jti: "v6", exp: NOW + 3600 });
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
    const { c, navigated } = mk({ storage, crossTab: true });
    channel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "6666555544443333",
      at: Date.now(),
      startedAt: Date.now(),
    });
    await settle();

    sessionStorage.removeItem(`${c.channelName}:txn`);
    sessionStorage.removeItem(`${c.channelName}:next`);

    // Starting an authorization flow whose callback is guaranteed to be
    // refused is not a recovery path.
    expect(() => c.beginLogin()).toThrow();
    expect(() => c.login({ next: "/after" })).toThrow();
    expect(sessionStorage.getItem(`${c.channelName}:txn`)).toBeNull();
    expect(sessionStorage.getItem(`${c.channelName}:next`)).toBeNull();
    expect(navigated).toHaveLength(0);
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);
    c.destroy();
    restore();
  });
});

// ---------------------------------------------------------------------------
// Call-site controls: one observable per control the mutation gate removes.
// ---------------------------------------------------------------------------

describe("registry accounting controls", () => {
  it("a released reservation frees its slot again", () => {
    const registry = new CredentialRegistry(1);
    const a = registry.reserve("first");
    // A failed attempt must give the slot back, or three transient network
    // errors would permanently disable logging in.
    registry.releaseReservation(a);
    expect(() => registry.reserve("second")).not.toThrow();
  });

  it("a drained reservation classifies its late mint as an orphan", () => {
    const registry = new CredentialRegistry(4);
    const handle = registry.reserve("refresh()");
    registry.drainForInvalidation(); // a logout cuts the operation off
    expect(registry.wasCancelled(handle)).toBe(true);
    expect(registry.trackedCount()).toBe(0); // ...and the slot is usable again
  });

  it("a failed callback exchange does not leak its reservation", async () => {
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => null,
      save: () => undefined,
      clear: () => undefined,
    };
    let fail = true;
    const jwt = makeJwt({ jti: "w3", exp: NOW + 3600 });
    const impl = (async () =>
      fail
        ? jsonRes({}, 500)
        : jsonRes({
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

    for (let i = 0; i < 40; i++) {
      history.replaceState(null, "", `/cb?code=w3-${i}&state=s`);
      await expect(c.handleCallback()).rejects.toThrow();
    }
    fail = false;
    history.replaceState(null, "", "/cb?code=w3-ok&state=s");
    // Forty failures must not have consumed the tracking budget.
    expect((await c.handleCallback()).accessToken).toBe(jwt);
    c.destroy();
  });

  it("a peer clear failure reports a clear failure, not a memory mirror", async () => {
    const restore = installFakeBroadcastChannel();
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "w4", exp: NOW + 3600 }), NOW + 3600),
      save: () => undefined,
      clear: () => {
        throw new Error("QUOTA-EXCEEDED-w4-detail");
      },
    };
    const { c, events } = mk({ storage, crossTab: true });
    channel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "4444333322221111",
      startedAt: Date.now(),
      at: Date.now(),
    });
    await settle();

    expect(events.find((e) => e.type === "session-clear-failed")).toMatchObject({
      scope: "peer",
      reasonCode: "storage-threw",
      blocked: true,
    });
    // The old event MEANT "a freshly rotated token is in a memory mirror".
    // Nothing here was rotated and nothing is mirrored.
    expect(events.filter((e) => e.type === "storage-write-failed")).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("QUOTA-EXCEEDED-w4-detail");
    c.destroy();
    restore();
  });

  it("a duplicate peer session-cleared does not take a second block", async () => {
    const restore = installFakeBroadcastChannel();
    let cur: StoredToken | null = stored(makeJwt({ jti: "w5", exp: NOW + 3600 }), NOW + 3600);
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
    const raw = channel(c.channelName);
    const msg = {
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      operationId: "2222111100009999",
      startedAt: Date.now(),
      at: Date.now(),
    };
    raw.postMessage(msg);
    raw.postMessage(msg); // exact duplicate
    raw.postMessage({ ...msg, at: Date.now() });
    await settle();

    // One block, releasable by one logout. A second block that nothing ever
    // releases would leave the client permanently unusable.
    await c.logout({ localOnly: true });
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(false);
    c.destroy();
    restore();
  });

  it("a terminal transition whose revocation throws still releases its block", async () => {
    // An unexpected fault mid-transition must not strand the local block and
    // the pending-op counter, leaving a client nothing can ever unblock.
    const access = makeJwt({ jti: "w6-a", exp: NOW + 3600 });
    const refresh = makeJwt({ jti: "w6-r", exp: NOW + 86400 });
    let cur: StoredToken | null = split(access, refresh, NOW + 3600);
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
      if (url.endsWith("/token")) return jsonRes({}, 401);
      if (url.endsWith("/revoke")) throw new TypeError("network exploded");
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });

    await c.refresh({ force: true }).catch(() => undefined);
    await settle();
    // Fail-closed, because the credential could not be confirmed dead - but by
    // a RETAINED block, taken and released by an owner, not by a stranded
    // local block and a pending-op counter nothing decrements.
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);
    expect(() => c.beginLogin()).toThrow(/fail-closed/i);
    c.destroy();
  });
});

describe("overlapping peer operations are tracked independently", () => {
  it("one peer's terminal message does not unblock while another is outstanding", async () => {
    const restore = installFakeBroadcastChannel();
    let cur: StoredToken | null = stored(makeJwt({ jti: "w7", exp: NOW + 3600 }), NOW + 3600);
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
    const raw = channel(c.channelName);
    const A = { tabId: "peerA", operationId: "aaaa0000aaaa0000" };
    const B = { tabId: "peerB", operationId: "bbbb1111bbbb1111" };

    for (const p of [A, B]) {
      raw.postMessage({
        type: "session-cleared",
        ...p,
        reason: "user-logout",
        startedAt: Date.now(),
        at: Date.now(),
      });
    }
    await settle();
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);

    // A finishes. B has NOT - it may still fail, and its block is its own.
    raw.postMessage({
      type: "logout",
      ...A,
      reason: "user-logout",
      startedAt: Date.now(),
      at: Date.now(),
    });
    await settle();
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(true);

    raw.postMessage({
      type: "logout",
      ...B,
      reason: "user-logout",
      startedAt: Date.now(),
      at: Date.now(),
    });
    await settle();
    expect(await blocked(c.getToken({ refresh: "never" }))).toBe(false);
    c.destroy();
    restore();
  });
});
