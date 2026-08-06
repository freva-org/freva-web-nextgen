/**
 * Work that arrives after a logout — a peer clear, a refresh response, a
 * tokenProvider result — never repopulates or unblocks the session, and the
 * callback, request and login-option handling around it stays strict.
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
import { canonicalizeStoredToken } from "../src/token.js";
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

describe("post-logout arrivals and late-resolving work", () => {
  it("a peer clear releases a still-running local logout", async () => {
    const restore = installFakeBroadcastChannel();
    let releaseClear!: () => void;
    const gate = new Promise<void>((r) => (releaseClear = r));
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "t1", exp: NOW + 3600 }), NOW + 3600),
      save: () => undefined,
      clear: async () => {
        await gate;
      },
    };
    const { c } = mk({
      storage,
      crossTab: true,
      fetchImpl: (async () => {
        await gate;
        return jsonRes({});
      }) as typeof fetch,
    });
    const p = c.logout({ localOnly: true });
    await flush();
    // A peer's session-cleared arrives and its (fast) clear finishes.
    channel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      at: Date.now(),
      operationId: "ffff000011112222",
      startedAt: Date.now(),
    });
    await flush();
    await flush();
    await flush();
    const escaped = await c.getToken({ refresh: "never" }).then(
      (t) => t !== null,
      () => false,
    );
    releaseClear();
    await p.catch(() => undefined);
    // A peer's clear must NOT release the local logout's own block.
    expect(escaped).toBe(false);
    c.destroy();
    restore();
  });

  it("a peer session-cleared reopens after its own clear resolves", async () => {
    const restore = installFakeBroadcastChannel();
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "t2", exp: NOW + 3600 }), NOW + 3600));
    const { c } = mk({ storage, crossTab: true });
    channel(c.channelName).postMessage({
      type: "session-cleared",
      tabId: "peer",
      reason: "user-logout",
      at: Date.now(),
      operationId: "1111aaaa2222bbbb",
      startedAt: Date.now(),
    });
    await flush();
    await flush();
    await storage.save(stored(makeJwt({ jti: "t2b", exp: NOW + 3600 }), NOW + 3600));
    const reopened = await c.getToken({ refresh: "never" }).then(
      (t) => t !== null,
      () => false,
    );
    // A peer-only session-cleared stays blocked until terminal completion.
    expect(reopened).toBe(false);
    c.destroy();
    restore();
  });

  it("a refresh response arriving after logout still persists", async () => {
    const saved: string[] = [];
    let releaseToken!: () => void;
    const gate = new Promise<void>((r) => (releaseToken = r));
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "t3", exp: NOW + 30 }), NOW + 30),
      save: (t) => {
        saved.push(t.accessToken);
      },
      clear: () => undefined,
    };
    const fresh = makeJwt({ jti: "t3-new", exp: NOW + 7200 });
    const impl = (async (i: RequestInfo | URL) => {
      const url = fetchView(i).url;
      if (url.endsWith("/token")) {
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
    await c.logout({ localOnly: true }).catch(() => undefined);
    releaseToken();
    await r;
    expect(saved).not.toContain(fresh); // discarded, not persisted
    c.destroy();
  });

  it("a tokenProvider resolving after logout repopulates the cache", async () => {
    let releaseProvider!: () => void;
    const gate = new Promise<void>((r) => (releaseProvider = r));
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      acknowledgeNoCsrf: true,
      logoutEndpoint: "http://app.test/lo",
      tokenProvider: async () => {
        await gate;
        return {
          accessToken: "late.token.value",
          tokenType: "Bearer",
          expiresAt: NOW + 600,
          sessionVersion: "v",
        };
      },
    });
    const { c } = mk({
      storage,
      fetchImpl: (async () => jsonRes({})) as typeof fetch,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    const pull = storage.load();
    await c.logout({ localOnly: true }).catch(() => undefined);
    releaseProvider();
    await pull;
    expect(storage.peek()).toBeNull(); // the stale pull cannot repopulate
    c.destroy();
  });

  it("canonicalize erases an explicit accessTokenIsRefreshCredential", () => {
    const t = canonicalizeStoredToken(
      {
        accessToken: "a.b.c",
        tokenType: "Bearer",
        expiresAt: NOW + 600,
        accessTokenIsRefreshCredential: true,
      },
      "token-provider",
    );
    expect(t.accessTokenIsRefreshCredential).toBe(true); // explicit true preserved
  });

  it("bearer-from-endpoint therefore accepts a self-declared refresh-capable token", async () => {
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      acknowledgeNoCsrf: true,
      tokenProvider: () => ({
        accessToken: "a.b.c",
        tokenType: "Bearer",
        expiresAt: NOW + 600,
        sessionVersion: "v",
        accessTokenIsRefreshCredential: true,
      }),
    });
    await expect(storage.load()).rejects.toThrow(/refresh/i);
  });

  it("malformed fragment encoding makes isCallbackUrl throw", () => {
    const { c } = mk({ storage: new MemoryStorage() });
    let threw = false;
    try {
      c.isCallbackUrl("http://app.test/cb#access_token=FRAGMENT-SECRET&%ZZ");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // routing predicate is total
    c.destroy();
  });

  it("BFF drops headers from a Request input", async () => {
    const storage = new ServerManagedStorage({
      transport: "bff",
      csrf: { headerName: "X-CSRFToken", token: "TOK" },
    });
    let sent: Request | undefined;
    const impl = (async (i: RequestInfo | URL) => {
      sent = i as Request;
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    await c.fetch(
      new Request("http://app.test/api/x", {
        method: "POST",
        body: "payload",
        headers: { "X-Custom": "kept" },
      }),
    );
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("X-Custom")).toBe("kept");
    expect(sent?.headers.get("X-CSRFToken")).toBe("TOK");
    expect(sent?.credentials).toBe("include");
    expect(await sent!.text()).toBe("payload");
    c.destroy();
  });

  it("every revocation is attempted even after a failure", async () => {
    const storage = new MemoryStorage();
    const at = makeJwt({ jti: "at", exp: NOW + 600 });
    const rt = makeJwt({ jti: "rt", exp: NOW + 99999 });
    await storage.save({
      accessToken: at,
      refreshToken: rt,
      tokenType: "Bearer",
      expiresAt: NOW + 600,
      sessionVersion: "v",
    });
    const bodies: string[] = [];
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const v = fetchView(i, init);
      if (v.url.endsWith("/revoke")) {
        const body = String(v.init.body ?? "");
        bodies.push(body);
        return body.includes("refresh_token") ? jsonRes({}, 500) : jsonRes({});
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    await c.logout().catch(() => undefined);
    // Both revocations are attempted even though the first failed.
    expect(bodies).toHaveLength(2);
    expect(bodies.some((b) => b.includes("refresh_token"))).toBe(true);
    expect(bodies.some((b) => b.includes("access_token"))).toBe(true);
    c.destroy();
  });

  it("loginUrl accepts erased-type option values", () => {
    const { c } = mk({ storage: new MemoryStorage() });
    for (const bad of [
      { offlineAccess: "false" as unknown as boolean },
      { prompt: "anything" as unknown as "login" },
      { scope: 42 as unknown as string },
    ]) {
      expect(() => c.loginUrl(bad)).toThrow();
      // ...and nothing was written or navigated as a side effect.
      expect(sessionStorage.getItem(`${c.channelName}:txn`)).toBeNull();
    }
    c.destroy();
  });

  it("per-call relative redirect is sent uncanonicalized", () => {
    const { c } = mk({
      storage: new MemoryStorage(),
      security: { allowedRedirectUris: ["http://app.test/cb", "/cb"] },
    });
    const url = c.loginUrl({ redirectUri: "/cb" });
    const sent = new URL(url).searchParams.get("redirect_uri");
    expect(sent).toBe("http://app.test/cb"); // canonical absolute, as validated
    c.destroy();
  });
});
