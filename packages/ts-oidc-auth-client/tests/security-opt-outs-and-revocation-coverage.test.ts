/**
 * Security opt-outs are always reported and revocation coverage is complete:
 * diagnose() stays side-effect-free, every acknowledgement warns and fails
 * diagnose(), and split-token revocation reaches the refresh credential.
 *
 * Each name states the behaviour that must not come back.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  PyOidcAuthClient,
  RevocationError,
  ServerManagedStorage,
  type AuthConfig,
  type AuthEvent,
  type TokenStorage,
} from "../src/index.js";
import { CookieStorage } from "../src/unsafe-compat.js";
import {
  accessOnlyResponse,
  installFakeBroadcastChannel,
  jsonRes,
  makeJwt,
  stored,
} from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const REDIRECT = "http://app.test/cb";
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function mk(o: Partial<AuthConfig> & { storage: TokenStorage }) {
  const events: AuthEvent[] = [];
  const navigated: string[] = [];
  const c = new PyOidcAuthClient({
    authBaseUrl: BASE,
    redirectUri: REDIRECT,
    crossTab: false,
    now: () => NOW,
    navigate: (u) => navigated.push(u),
    onEvent: (e) => events.push(e),
    ...o,
    security: { allowInsecureTransport: true, warnOnBrowserReadableRefresh: false, ...o.security },
  });
  return { c, events, navigated };
}

describe("1. diagnose() is side-effect-free", () => {
  it("never invokes a tokenProvider", async () => {
    let calls = 0;
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenProvider: () => {
        calls += 1;
        return null;
      },
    });
    const { c } = mk({ storage, fetchImpl: (async () => jsonRes({ keys: [] })) as typeof fetch });
    await c.diagnose();
    expect(calls).toBe(0);
    c.destroy();
  });

  it("never contacts a tokenEndpoint", async () => {
    let endpointHits = 0;
    const TOK = "http://app.test/api/tok";
    const storageFetch = (async () => {
      endpointHits += 1;
      return jsonRes(accessOnlyResponse(makeJwt({ exp: NOW + 600 }), NOW + 600));
    }) as typeof fetch;
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: TOK,
      acknowledgeNoCsrf: true,
      fetchImpl: storageFetch,
    });
    const { c } = mk({ storage, fetchImpl: (async () => jsonRes({ keys: [] })) as typeof fetch });
    await c.diagnose();
    expect(endpointHits).toBe(0);
    c.destroy();
  });

  it("does not clear, mint or rotate any authentication state", async () => {
    const ops: string[] = [];
    const tok = stored(makeJwt({ jti: "d1", exp: NOW + 3600 }), NOW + 3600);
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => {
        ops.push("load");
        return tok;
      },
      save: () => {
        ops.push("save");
      },
      clear: () => {
        ops.push("clear");
      },
    };
    const { c } = mk({ storage, fetchImpl: (async () => jsonRes({ keys: [] })) as typeof fetch });
    await c.diagnose();
    expect(ops).toEqual([]); // a diagnostic touches nothing
    c.destroy();
  });
});

describe("2. cross-tab logout completion is not premature", () => {
  function sharedPair(fetchImpl: typeof fetch, security: Record<string, unknown> = {}) {
    const restore = installFakeBroadcastChannel();
    const box: { token: ReturnType<typeof stored> | null } = {
      token: stored(makeJwt({ jti: "x", exp: NOW + 3600 }), NOW + 3600),
    };
    const make = (): TokenStorage => ({
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => box.token,
      save: (t) => {
        box.token = t;
      },
      clear: () => {
        box.token = null;
      },
    });
    const a = mk({
      storage: make(),
      fetchImpl,
      crossTab: true,
      useNavigatorLocks: false,
      security,
    });
    const b = mk({
      storage: make(),
      fetchImpl,
      crossTab: true,
      useNavigatorLocks: false,
      security,
    });
    return { a, b, box, restore };
  }

  it("a peer clears but does NOT report success when revocation fails", async () => {
    const impl = (async (i: RequestInfo | URL) =>
      String(i).endsWith("/revoke") ? jsonRes({}, 500) : jsonRes({})) as typeof fetch;
    const { a, b, box, restore } = sharedPair(impl);
    await expect(a.c.logout()).rejects.toBeInstanceOf(RevocationError);
    await flush();
    expect(box.token).toBeNull(); // cleared promptly
    expect(b.events.some((e) => e.type === "session-cleared")).toBe(true);
    expect(b.events.some((e) => e.type === "logout")).toBe(false); // not "logged out"
    a.c.destroy();
    b.c.destroy();
    restore();
  });

  it("a peer does not report success when backend logout fails", async () => {
    const LO = "http://app.test/api/logout";
    const impl = (async (i: RequestInfo | URL) =>
      String(i) === LO ? jsonRes({}, 500) : jsonRes({})) as typeof fetch;
    const restore = installFakeBroadcastChannel();
    const smA = new ServerManagedStorage({
      transport: "bff",
      logoutEndpoint: LO,
      acknowledgeNoCsrf: true,
    });
    const sec = { allowedResourceOrigins: ["http://app.test"] };
    const a = mk({ storage: smA, fetchImpl: impl, crossTab: true, security: sec });
    const b = mk({ storage: new MemoryStorage(), fetchImpl: impl, crossTab: true, security: sec });
    await expect(a.c.logout()).rejects.toThrow(/may still be alive/i);
    await flush();
    expect(b.events.some((e) => e.type === "logout")).toBe(false);
    a.c.destroy();
    b.c.destroy();
    restore();
  });

  it("a peer DOES report success once everything succeeded", async () => {
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { a, b, restore } = sharedPair(impl);
    await a.c.logout({ localOnly: true });
    await flush();
    expect(b.events.some((e) => e.type === "session-cleared")).toBe(true);
    expect(b.events.some((e) => e.type === "logout")).toBe(true);
    a.c.destroy();
    b.c.destroy();
    restore();
  });

  it("acknowledged unsupported revocation still completes for peers", async () => {
    const impl = (async (i: RequestInfo | URL) =>
      String(i).endsWith("/revoke") ? jsonRes({}, 405) : jsonRes({})) as typeof fetch;
    const { a, b, restore } = sharedPair(impl, { acknowledgeUnsupportedRevocation: true });
    await a.c.logout({ localOnly: true });
    await flush();
    expect(b.events.some((e) => e.type === "logout")).toBe(true);
    a.c.destroy();
    b.c.destroy();
    restore();
  });
});

describe("3. there is no unreported way to skip revocation", () => {
  it("logout() always revokes; the per-call opt-out is gone", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "p3", exp: NOW + 3600 }), NOW + 3600));
    let revokes = 0;
    const impl = (async (i: RequestInfo | URL) => {
      if (String(i).endsWith("/revoke")) revokes += 1;
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    // A stray `revoke: false` is not part of the type and must not be honoured.
    await (c.logout as (o: unknown) => Promise<void>)({ revoke: false });
    expect(revokes).toBe(1);
    c.destroy();
  });

  it("skipping revocation requires an acknowledgement that fails diagnose()", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "p3b", exp: NOW + 3600 }), NOW + 3600));
    let revokes = 0;
    const impl = (async (i: RequestInfo | URL) => {
      if (String(i).endsWith("/revoke")) revokes += 1;
      return jsonRes({ keys: [] });
    }) as typeof fetch;
    const { c, events } = mk({
      storage,
      fetchImpl: impl,
      security: { acknowledgeNoRevocation: true },
    });
    await c.logout({ localOnly: true });
    expect(revokes).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "security-warning", code: "no-revocation" }),
    );
    expect((await c.diagnose()).ok).toBe(false);
    c.destroy();
  });
});

describe("4. every acknowledgement warns and fails diagnose()", () => {
  const cases: Array<[string, () => ReturnType<typeof mk>]> = [
    [
      "allowInsecureTransport",
      () =>
        mk({
          storage: new MemoryStorage(),
          fetchImpl: (async () => jsonRes({ keys: [] })) as typeof fetch,
        }),
    ],
    [
      "acknowledgeNoBackendLogout",
      () =>
        mk({
          storage: new ServerManagedStorage({ transport: "bff", acknowledgeNoCsrf: true }),
          fetchImpl: (async () => jsonRes({ keys: [] })) as typeof fetch,
          security: { acknowledgeNoBackendLogout: true },
        }),
    ],
    [
      "acknowledgeUnsupportedRevocation",
      () =>
        mk({
          storage: new MemoryStorage(),
          fetchImpl: (async () => jsonRes({ keys: [] })) as typeof fetch,
          security: { acknowledgeUnsupportedRevocation: true },
        }),
    ],
    [
      "acknowledgeBrokerSingleTokenContract",
      () =>
        mk({
          storage: new CookieStorage({
            name: "ack6",
            allowInsecureTransport: true,
            acknowledgeInsecureCookie: true,
            acknowledgeBrokerSingleTokenContract: true,
          }),
          fetchImpl: (async () => jsonRes({ keys: [] })) as typeof fetch,
        }),
    ],
    [
      "acknowledgeNoCsrf",
      () =>
        mk({
          storage: new ServerManagedStorage({
            transport: "bff",
            acknowledgeNoCsrf: true,
            logoutEndpoint: "http://app.test/lo",
          }),
          fetchImpl: (async () => jsonRes({ keys: [] })) as typeof fetch,
          security: { allowedResourceOrigins: ["http://app.test"] },
        }),
    ],
    [
      "allowRefreshCapableToken",
      () =>
        mk({
          storage: new ServerManagedStorage({
            transport: "bearer-from-endpoint",
            allowRefreshCapableToken: true,
            tokenProvider: () => null,
          }),
          fetchImpl: (async () => jsonRes({ keys: [] })) as typeof fetch,
        }),
    ],
  ];

  for (const [name, build] of cases) {
    it(`${name} emits a warning and makes diagnose() non-OK`, async () => {
      const { c, events } = build();
      expect(events.some((e) => e.type === "security-warning")).toBe(true);
      const report = await c.diagnose();
      const failed = report.checks.filter((x) => !x.ok && (x.severity ?? "error") === "error");
      expect(failed.length).toBeGreaterThan(0);
      expect(report.ok).toBe(false);
      c.destroy();
    });
  }

  it("warnOnBrowserReadableRefresh:false cannot mute an acknowledgement", () => {
    const { events } = mk({
      storage: new MemoryStorage(),
      security: { warnOnBrowserReadableRefresh: false, acknowledgeNoRevocation: true },
    });
    const codes = events
      .filter((e) => e.type === "security-warning")
      .map((e) => (e as { code: string }).code);
    expect(codes).toContain("no-revocation");
  });
});

describe("5. refresh capability fails closed", () => {
  it("refuses to send an access-only token to /token", async () => {
    const storage = new MemoryStorage();
    await storage.save({
      accessToken: makeJwt({ jti: "p5", exp: NOW + 60 }),
      tokenType: "Bearer",
      expiresAt: NOW + 60,
      sessionVersion: "v",
    });
    let tokenCalls = 0;
    const impl = (async (i: RequestInfo | URL) => {
      if (String(i).endsWith("/token")) tokenCalls += 1;
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    await expect(c.refresh({ force: true })).rejects.toThrow(/no refresh credential/i);
    expect(tokenCalls).toBe(0);
    c.destroy();
  });

  it("still refreshes with a real refresh token", async () => {
    const storage = new MemoryStorage();
    const rt = makeJwt({ jti: "rt", exp: NOW + 99999 });
    await storage.save({
      accessToken: makeJwt({ jti: "at", exp: NOW + 60 }),
      refreshToken: rt,
      tokenType: "Bearer",
      expiresAt: NOW + 60,
      sessionVersion: "v",
    });
    let body = "";
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).endsWith("/token")) {
        body = String(init?.body);
      }
      return jsonRes(accessOnlyResponse(makeJwt({ jti: "n", exp: NOW + 7200 }), NOW + 7200));
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    await c.refresh({ force: true });
    expect(body).toContain(encodeURIComponent(rt));
    c.destroy();
  });

  it("preserves the acknowledged legacy single-token contract", async () => {
    const jwt = makeJwt({ jti: "legacy", exp: NOW + 60 });
    const cookie = new CookieStorage({
      name: "legacyok",
      allowInsecureTransport: true,
      acknowledgeInsecureCookie: true,
      acknowledgeBrokerSingleTokenContract: true,
      // The suite pins a 2023 clock, so an exp-derived Max-Age would be
      // negative and the browser would drop the cookie immediately.
      maxAgeFromTokenExp: false,
      maxAgeSeconds: 600,
    });
    cookie.save(stored(jwt, NOW + 60));
    let body = "";
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).endsWith("/token")) {
        body = String(init?.body);
      }
      return jsonRes({
        access_token: jwt,
        refresh_token: jwt,
        token_type: "Bearer",
        expires: NOW + 7200,
      });
    }) as typeof fetch;
    const { c } = mk({ storage: cookie, fetchImpl: impl });
    await c.refresh({ force: true });
    expect(body).toContain(encodeURIComponent(jwt));
    c.destroy();
  });
});

describe("6. split-token revocation covers the refresh credential", () => {
  it("revokes the refresh token with the RFC 7009 hint", async () => {
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
      if (String(i).endsWith("/revoke")) bodies.push(String(init?.body));
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    await c.logout({ localOnly: true });
    const joined = bodies.join("&");
    expect(joined).toContain(encodeURIComponent(rt));
    expect(joined).toContain("token_type_hint=refresh_token");
    expect(joined).toContain(encodeURIComponent(at));
    c.destroy();
  });

  it("fails the logout when the refresh credential cannot be revoked", async () => {
    const storage = new MemoryStorage();
    const at = makeJwt({ jti: "at2", exp: NOW + 600 });
    const rt = makeJwt({ jti: "rt2", exp: NOW + 99999 });
    await storage.save({
      accessToken: at,
      refreshToken: rt,
      tokenType: "Bearer",
      expiresAt: NOW + 600,
      sessionVersion: "v",
    });
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).endsWith("/revoke")) {
        return String(init?.body).includes("refresh_token") ? jsonRes({}, 500) : jsonRes({});
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c, navigated } = mk({ storage, fetchImpl: impl });
    await expect(c.logout()).rejects.toBeInstanceOf(RevocationError);
    expect(navigated).toHaveLength(0);
    c.destroy();
  });

  it("single-token broker mode still sends one revocation", async () => {
    const storage = new MemoryStorage();
    const jwt = makeJwt({ jti: "one", exp: NOW + 600 });
    await storage.save(stored(jwt, NOW + 600));
    const bodies: string[] = [];
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).endsWith("/revoke")) bodies.push(String(init?.body));
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    await c.logout({ localOnly: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("token_type_hint=refresh_token");
    c.destroy();
  });
});

describe("7. authorization-response parsing is strict", () => {
  const jwt = makeJwt({ jti: "cb", exp: NOW + 3600 });
  const okFetch = (async () =>
    jsonRes({
      access_token: jwt,
      refresh_token: jwt,
      token_type: "Bearer",
      expires: NOW + 3600,
    })) as typeof fetch;

  function client(security: Record<string, unknown> = {}) {
    return mk({
      storage: new MemoryStorage(),
      fetchImpl: okFetch,
      security: {
        requireLoginTransaction: false,
        acknowledgeNoLoginTransaction: true,
        ...security,
      },
    });
  }

  for (const dup of [
    "code=a&code=b&state=s",
    "code=a&state=s&state=t",
    "code=a&state=s&iss=x&iss=y",
  ]) {
    it(`rejects duplicated protocol parameters (${dup.split("&")[1]})`, async () => {
      const { c } = client();
      await expect(c.handleCallback(`http://app.test/cb?${dup}`)).rejects.toThrow(
        /duplicate-parameter|not on the allowlist/i,
      );
      c.destroy();
    });
  }

  it("rejects a mixed success/error response", async () => {
    const { c } = client();
    await expect(
      c.handleCallback("http://app.test/cb?code=a&state=s&error=denied"),
    ).rejects.toThrow(/mixed-response|not on the allowlist/i);
    c.destroy();
  });

  it("rejects iss when no expectedIssuer is configured", async () => {
    const { c } = client();
    await expect(
      c.handleCallback("http://app.test/cb?code=a&state=s&iss=https://evil.example"),
    ).rejects.toThrow(/issuer-unexpected/);
    c.destroy();
  });

  it("compares iss exactly (RFC 9207)", async () => {
    const good = client({ expectedIssuer: "https://idp.test/realms/freva" });
    await expect(
      good.c.handleCallback(
        "http://app.test/cb?code=a&state=s&iss=https%3A%2F%2Fidp.test%2Frealms%2Ffreva",
      ),
    ).resolves.toMatchObject({ accessToken: jwt });
    good.c.destroy();

    for (const bad of [
      "https://idp.test/realms/freva/",
      "https://IDP.test/realms/freva",
      "https://evil.example",
    ]) {
      const { c } = client({ expectedIssuer: "https://idp.test/realms/freva" });
      await expect(
        c.handleCallback(`http://app.test/cb?code=a&state=s&iss=${encodeURIComponent(bad)}`),
      ).rejects.toThrow(/issuer-mismatch|issuer/i);
      c.destroy();
    }
  });

  it("requires a login transaction for error responses too", async () => {
    const { c } = mk({ storage: new MemoryStorage(), fetchImpl: okFetch });
    await expect(c.handleCallback("http://app.test/cb?error=access_denied")).rejects.toThrow(
      /transaction/i,
    );
    c.destroy();
  });

  it("scrubs error_uri along with every other response parameter", async () => {
    history.replaceState(null, "", "/cb?error=denied&error_uri=https://idp.test/e/1&keep=9");
    const { c } = mk({
      storage: new MemoryStorage(),
      fetchImpl: okFetch,
      redirectUri: "http://app.test/cb?keep=9",
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
    await expect(c.handleCallback()).rejects.toThrow();
    expect(location.search).toBe("?keep=9");
    expect(location.search).not.toContain("error_uri");
    c.destroy();
  });
});
