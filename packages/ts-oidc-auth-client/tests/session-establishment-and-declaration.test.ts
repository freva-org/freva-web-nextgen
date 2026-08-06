/**
 * Observing a credential is not establishing a session, and surviving a reload
 * is not sharing one.
 *
 * Topology-aware lifecycle targeting rests on two things that look like facts
 * and are not. Stamping `sessionEstablishedAt` the first time a tab OBSERVES a
 * token lets a tab that starts listening late, misses `session-cleared`, and
 * then pulls a bearer from a backend session already being torn down declare
 * itself "newer" than the logout and keep the credential cached. And
 * `TokenStorage.persistent` means "survives tab close/reopen", not "every tab
 * reads this credential": a persistent but tab-partitioned storage (IndexedDB
 * keyed by tab, sessionStorage, a partitioned worker cache) must be able to
 * declare that, or it is classified as `shared-credential` and a global logout
 * never reaches it.
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

/** A per-tab custom storage that nevertheless survives a reload. */
function partitioned(initial: StoredToken | null) {
  const cell: { token: StoredToken | null } = { token: initial };
  return {
    kind: "custom" as const,
    persistent: true, // survives tab close/reopen...
    lifecycleIdentity: "per-tab", // ...but each tab has its OWN copy
    load: () => cell.token,
    save: (t: StoredToken) => {
      cell.token = t;
    },
    clear: () => {
      cell.token = null;
    },
    cell,
  };
}

// ---------------------------------------------------------------------------
// A tab that misses `session-cleared` must still honour the terminal one.
// ---------------------------------------------------------------------------

describe("first token observation is not session establishment", () => {
  it("a managed-bearer late listener honours the terminal logout", async () => {
    const restore = installFakeBroadcastChannel();
    const tokenA = makeJwt({ jti: "b1-a", exp: NOW + 600 });
    const tokenB = makeJwt({ jti: "b1-b", exp: NOW + 600 });
    const logoutGate = gate();
    // The backend session is alive until A's logout actually completes; a
    // provider mints only while it lives, as a real deployment does.
    let backendAlive = true;

    const storageA = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      acknowledgeNoCsrf: true,
      logoutEndpoint: "http://app.test/logout",
      tokenProvider: () =>
        backendAlive
          ? {
              accessToken: tokenA,
              tokenType: "Bearer",
              expiresAt: NOW + 600,
              sessionVersion: "ignored",
            }
          : null,
    });
    const storageB = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      acknowledgeNoCsrf: true,
      tokenProvider: () =>
        backendAlive
          ? {
              accessToken: tokenB,
              tokenType: "Bearer",
              expiresAt: NOW + 600,
              sessionVersion: "ignored",
            }
          : null,
    });
    const implA = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.endsWith("/logout")) {
        await logoutGate.promise;
        backendAlive = false; // the session dies here
        return jsonRes({});
      }
      return jsonRes({});
    }) as typeof fetch;

    const { c: a } = mk({
      storage: storageA,
      fetchImpl: implA,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });

    // 1-2. A logs out; `session-cleared` goes out, the backend hangs.
    const logout = a.logout({ localOnly: true }).catch(() => undefined);
    await settle();

    // 3. B only now starts listening, so it never saw `session-cleared`.
    const { c: b, events: eventsB } = mk({
      storage: storageB,
      fetchImpl: (async () => jsonRes({})) as typeof fetch,
      security: { acknowledgeNoBackendLogout: true },
    });
    expect(a.channelName).toBe(b.channelName);

    // 4. B obtains a bearer from the still-live backend session.
    expect((await b.getToken({ refresh: "never" }))?.accessToken).toBe(tokenB);
    expect(storageB.peek()?.accessToken).toBe(tokenB);

    // 5. A's logout completes and the terminal message goes out.
    logoutGate.release();
    await logout;
    await settle();

    // 6. The terminal message is the fallback for a tab that missed the first
    //    one. Pulling a token is not evidence that B's session is newer than
    //    the logout - the pull succeeded BECAUSE the backend session was still
    //    alive, which is precisely what the logout is ending.
    expect(storageB.peek()).toBeNull();
    expect(eventsB.some((e) => e.type === "logout")).toBe(true);
    expect(await b.getToken({ refresh: "never" }).catch(() => null)).toBeNull();
    a.destroy();
    b.destroy();
    restore();
  });

  it("a preloaded per-tab credential is not a newer session", async () => {
    const restore = installFakeBroadcastChannel();
    const oldJwt = makeJwt({ jti: "b2-preloaded", exp: NOW + 3600 });
    const storageA = new MemoryStorage();
    const storageB = new MemoryStorage();
    await storageA.save(stored(makeJwt({ jti: "b2-a", exp: NOW + 3600 }), NOW + 3600));
    // B's storage was populated before this test's logout operation began.
    await storageB.save(stored(oldJwt, NOW + 3600));

    // Hold A's revocation so `session-cleared` is out but the terminal
    // message is not.
    const revokeGate = gate();
    const implA = (async (i: RequestInfo | URL) => {
      if (fetchView(i).url.endsWith("/revoke")) {
        await revokeGate.promise;
        return jsonRes({});
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c: a } = mk({ storage: storageA, fetchImpl: implA });

    const logout = a.logout({ localOnly: true });
    await settle();

    // B starts listening late and misses `session-cleared`.
    const { c: b } = mk({
      storage: storageB,
      fetchImpl: (async () => jsonRes({})) as typeof fetch,
    });
    // Merely LOADING the preloaded credential must not stamp a new epoch.
    expect((await b.getToken({ refresh: "never" }))?.accessToken).toBe(oldJwt);

    revokeGate.release();
    await logout;
    await settle();

    expect(await storageB.load()).toBeNull();
    expect(await b.getToken({ refresh: "never" }).catch(() => null)).toBeNull();
    a.destroy();
    b.destroy();
    restore();
  });
});

// ---------------------------------------------------------------------------
// Persistence is not sharing.
// ---------------------------------------------------------------------------

describe("lifecycle topology is declared, not inferred from persistence", () => {
  it("a persistent tab-partitioned storage is per-tab and honours a global logout", async () => {
    const restore = installFakeBroadcastChannel();
    const mine = makeJwt({ jti: "b3-mine", exp: NOW + 3600 });
    const theirs = makeJwt({ jti: "b3-theirs", exp: NOW + 3600 });
    const storeA = partitioned(stored(theirs, NOW + 3600));
    const storeB = partitioned(stored(mine, NOW + 3600));

    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c: a } = mk({ storage: storeA as unknown as TokenStorage, fetchImpl: impl });
    const { c: b } = mk({ storage: storeB as unknown as TokenStorage, fetchImpl: impl });

    expect(b.lifecycleIdentity).toBe("per-tab");
    expect((await b.getToken({ refresh: "never" }))?.accessToken).toBe(mine);

    await a.logout({ localOnly: true });
    await settle();

    // Different fingerprints by design; the logout must still reach B.
    expect(storeB.cell.token).toBeNull();
    a.destroy();
    b.destroy();
    restore();
  });

  it("a persistent shared custom storage is shared-credential", async () => {
    const jwt = makeJwt({ jti: "b4", exp: NOW + 3600 });
    const cell: { token: StoredToken | null } = { token: stored(jwt, NOW + 3600) };
    const storage = {
      kind: "custom" as const,
      persistent: true,
      lifecycleIdentity: "shared-credential",
      load: () => cell.token,
      save: (t: StoredToken) => {
        cell.token = t;
      },
      clear: () => {
        cell.token = null;
      },
    };
    const { c } = mk({ storage: storage as unknown as TokenStorage });
    expect(c.lifecycleIdentity).toBe("shared-credential");
    c.destroy();
  });

  it("a custom storage with cross-tab enabled must declare its topology", () => {
    const bare: TokenStorage = {
      kind: "custom",
      persistent: true,
      load: () => null,
      save: () => undefined,
      clear: () => undefined,
    };
    expect(() => mk({ storage: bare })).toThrow(/lifecycleIdentity/i);
  });

  it("an invalid or contradictory declaration fails construction", () => {
    const bogus = {
      kind: "custom" as const,
      persistent: true,
      lifecycleIdentity: "shared", // not in the closed union
      load: () => null,
      save: () => undefined,
      clear: () => undefined,
    };
    expect(() => mk({ storage: bogus as unknown as TokenStorage })).toThrow(/lifecycleIdentity/i);

    // A built-in whose declaration contradicts what it actually is.
    const lying = new MemoryStorage() as unknown as { lifecycleIdentity: string };
    lying.lifecycleIdentity = "shared-credential";
    expect(() => mk({ storage: lying as unknown as TokenStorage })).toThrow(
      /contradict|lifecycleIdentity/i,
    );
  });

  it("the declaration is snapshotted at construction", async () => {
    const jwt = makeJwt({ jti: "b7", exp: NOW + 3600 });
    const cell: { token: StoredToken | null } = { token: stored(jwt, NOW + 3600) };
    const storage = {
      kind: "custom" as const,
      persistent: true,
      lifecycleIdentity: "shared-credential",
      load: () => cell.token,
      save: (t: StoredToken) => {
        cell.token = t;
      },
      clear: () => {
        cell.token = null;
      },
    };
    const { c } = mk({ storage: storage as unknown as TokenStorage });
    await c.getToken({ refresh: "never" });

    // Later mutation must not change policy.
    (storage as { lifecycleIdentity: string }).lifecycleIdentity = "per-tab";
    expect(c.lifecycleIdentity).toBe("shared-credential");

    new (
      globalThis as unknown as {
        BroadcastChannel: new (n: string) => BroadcastChannel;
      }
    ).BroadcastChannel(c.channelName).postMessage({
      type: "logout",
      tabId: "peer",
      reason: "user-logout",
      operationId: "b7b7b7b7b7b7b7b7",
      sessionVersion: "0000not-ours0000",
      startedAt: Date.now(),
      at: Date.now(),
    });
    await settle();
    // Still shared-credential: the mismatched fingerprint is refused.
    expect(cell.token?.accessToken).toBe(jwt);
    c.destroy();
  });
});

describe("the declaration requirement is unconditional", () => {
  it("a non-persistent custom storage must declare its topology too", () => {
    // Persistence is not the trigger - the requirement is about SHARING, and a
    // custom storage of any kind has to say which it is.
    const bare: TokenStorage = {
      kind: "custom",
      persistent: false,
      load: () => null,
      save: () => undefined,
      clear: () => undefined,
    };
    expect(() => mk({ storage: bare })).toThrow(/lifecycleIdentity/i);
  });

  it("with cross-tab disabled an undeclared custom storage is allowed", () => {
    const bare: TokenStorage = {
      kind: "custom",
      persistent: true,
      load: () => null,
      save: () => undefined,
      clear: () => undefined,
    };
    // No lifecycle message can ever arrive, so the value is never consulted.
    // It reports the conservative one rather than claiming sharing.
    const { c } = mk({ storage: bare, crossTab: false });
    expect(c.lifecycleIdentity).toBe("per-tab");
    c.destroy();
  });
});
