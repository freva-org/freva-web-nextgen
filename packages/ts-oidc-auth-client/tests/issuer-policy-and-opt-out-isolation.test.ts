/**
 * Issuer policy is strict, routing stays separate from validation, and each
 * security opt-out reports its own exact code.
 *
 * The acknowledgement suite is deliberately ISOLATED: every client is built
 * with a secure configuration and exactly ONE acknowledgement, so a blanket
 * `allowInsecureTransport: true` in a helper can never be what satisfies
 * another acknowledgement's assertion.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  OriginNotAllowedError,
  PyOidcAuthClient,
  ServerManagedStorage,
  type AuthConfig,
  type AuthEvent,
  type SecurityWarningCode,
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
const SECURE_REDIRECT = "https://app.example/cb";
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const jwks = (async () => jsonRes({ keys: [] })) as typeof fetch;

/** A client with NO acknowledgements at all unless the test adds exactly one. */
function secureClient(o: Partial<AuthConfig> & { storage: TokenStorage }) {
  const events: AuthEvent[] = [];
  const navigated: string[] = [];
  const client = new PyOidcAuthClient({
    authBaseUrl: BASE,
    redirectUri: SECURE_REDIRECT,
    crossTab: false,
    now: () => NOW,
    navigate: (u) => navigated.push(u),
    onEvent: (e) => events.push(e),
    fetchImpl: jwks,
    ...o,
    security: { allowedRedirectUris: [SECURE_REDIRECT], ...o.security },
  });
  return { client, events, navigated };
}

/** Local-origin client for behaviour that needs the page's own callback route. */
function localClient(o: Partial<AuthConfig> & { storage: TokenStorage }) {
  const events: AuthEvent[] = [];
  const navigated: string[] = [];
  const client = new PyOidcAuthClient({
    authBaseUrl: BASE,
    redirectUri: "http://app.test/cb",
    crossTab: false,
    now: () => NOW,
    navigate: (u) => navigated.push(u),
    onEvent: (e) => events.push(e),
    ...o,
    security: {
      allowInsecureTransport: true,
      warnOnBrowserReadableRefresh: false,
      ...o.security,
    },
  });
  return { client, events, navigated };
}

const PLANTED = makeJwt({ jti: "planted", exp: NOW + 99 });

describe("1. cross-tab content never becomes event content", () => {
  it("drops a planted free-form reason instead of forwarding it", async () => {
    const restore = installFakeBroadcastChannel();
    const { client, events } = localClient({ storage: new MemoryStorage(), crossTab: true });
    const raw = new (
      globalThis as unknown as {
        BroadcastChannel: new (n: string) => BroadcastChannel;
      }
    ).BroadcastChannel(client.channelName);
    for (const reason of [`pwned ${PLANTED}`, "x".repeat(500), { evil: true }, 42, undefined]) {
      raw.postMessage({
        type: "session-cleared",
        tabId: "evil",
        at: Date.now(),
        reason,
        operationId: "dddd000011112222",
        startedAt: Date.now(),
      });
    }
    await flush();
    expect(JSON.stringify(events)).not.toContain(PLANTED);
    // Not one of the planted messages was delivered (the only event present is
    // the construction-time insecure-transport acknowledgement).
    expect(events.filter((e) => e.type === "session-cleared")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logout")).toHaveLength(0);
    client.destroy();
    restore();
  });

  it("accepts only the closed reason union, and reports it as a code", async () => {
    const restore = installFakeBroadcastChannel();
    const { client, events } = localClient({ storage: new MemoryStorage(), crossTab: true });
    const raw = new (
      globalThis as unknown as {
        BroadcastChannel: new (n: string) => BroadcastChannel;
      }
    ).BroadcastChannel(client.channelName);
    raw.postMessage({
      type: "session-cleared",
      tabId: "peer",
      at: Date.now(),
      reason: "user-logout",
      operationId: "eeee000011112222",
      startedAt: Date.now(),
    });
    await flush();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "session-cleared", reasonCode: "user-logout" }),
    );
    client.destroy();
    restore();
  });
});

describe("2. routing is separate from validation", () => {
  function cb(security: Record<string, unknown> = {}) {
    return localClient({
      storage: new MemoryStorage(),
      fetchImpl: (async () =>
        jsonRes({
          access_token: "a.b.c",
          refresh_token: "a.b.c",
          token_type: "Bearer",
          expires: NOW + 3600,
        })) as typeof fetch,
      security: {
        requireLoginTransaction: false,
        acknowledgeNoLoginTransaction: true,
        ...security,
      },
    });
  }
  const bad = [
    ["duplicate code", "?code=a&code=b&state=s"],
    ["duplicate state", "?code=a&state=s&state=t"],
    ["mixed success/error", "?code=a&state=s&error=denied"],
  ] as const;

  for (const [label, qs] of bad) {
    it(`still routes a ${label} response to handleCallback()`, () => {
      const { client } = cb();
      expect(client.isCallbackUrl(`http://app.test/cb${qs}`)).toBe(true);
      client.destroy();
    });
  }

  it("scrubs the credential out of the URL before throwing", async () => {
    history.replaceState(null, "", "/cb?keep=1&code=REALCODE&code=b&state=s");
    const { client } = localClient({
      storage: new MemoryStorage(),
      redirectUri: "http://app.test/cb?keep=1",
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
    expect(client.isCallbackUrl()).toBe(true);
    await expect(client.handleCallback()).rejects.toThrow(/duplicate-parameter/i);
    expect(location.search).toBe("?keep=1"); // static param preserved
    expect(location.href).not.toContain("REALCODE"); // credential gone
    client.destroy();
  });

  it("scrubs a bad-issuer response too", async () => {
    history.replaceState(null, "", "/cb?code=REALCODE2&state=s&iss=https%3A%2F%2Fevil.example");
    const { client } = cb({ expectedIssuer: "https://idp.test/realms/freva" });
    expect(client.isCallbackUrl()).toBe(true);
    await expect(client.handleCallback()).rejects.toThrow(/issuer-mismatch|issuer/i);
    expect(location.href).not.toContain("REALCODE2");
    client.destroy();
  });

  it("never scrubs an unregistered route", async () => {
    history.replaceState(null, "", "/somewhere-else?code=KEEPME&state=s");
    const { client } = cb();
    expect(client.isCallbackUrl()).toBe(false);
    await expect(client.handleCallback()).rejects.toThrow(/not on the allowlist/i);
    expect(location.href).toContain("KEEPME"); // not ours to rewrite
    client.destroy();
  });
});

describe("3. issuer policy is strict", () => {
  it("rejects an unusable expectedIssuer at construction", () => {
    for (const bad of [
      "http://idp.test",
      "https://idp.test?x=1",
      "https://idp.test#f",
      "not-a-url",
    ]) {
      expect(() =>
        secureClient({
          storage: new MemoryStorage(),
          security: { expectedIssuer: bad },
        }),
      ).toThrow();
    }
    expect(() =>
      secureClient({
        storage: new MemoryStorage(),
        security: { expectedIssuer: "https://idp.test/realms/freva" },
      }),
    ).not.toThrow();
  });

  it("requires iss once expectedIssuer is configured", async () => {
    const { client } = localClient({
      storage: new MemoryStorage(),
      fetchImpl: (async () =>
        jsonRes({
          access_token: "a.b.c",
          refresh_token: "a.b.c",
          token_type: "Bearer",
          expires: NOW + 3600,
        })) as typeof fetch,
      security: {
        expectedIssuer: "https://idp.test/realms/freva",
        requireLoginTransaction: false,
        acknowledgeNoLoginTransaction: true,
      },
    });
    await expect(client.handleCallback("http://app.test/cb?code=a&state=s")).rejects.toThrow(
      /issuer-missing/,
    );
    client.destroy();
  });

  it("legacy providers need a named acknowledgement", async () => {
    const { client, events } = localClient({
      storage: new MemoryStorage(),
      fetchImpl: (async () =>
        jsonRes({
          access_token: "a.b.c",
          refresh_token: "a.b.c",
          token_type: "Bearer",
          expires: NOW + 3600,
        })) as typeof fetch,
      security: {
        expectedIssuer: "https://idp.test/realms/freva",
        acknowledgeMissingIssuer: true,
        requireLoginTransaction: false,
        acknowledgeNoLoginTransaction: true,
      },
    });
    await expect(client.handleCallback("http://app.test/cb?code=a&state=s")).resolves.toBeTruthy();
    expect(
      events.some(
        (e) => e.type === "security-warning" && (e as { code: string }).code === "missing-issuer",
      ),
    ).toBe(true);
    expect((await client.diagnose()).ok).toBe(false);
    client.destroy();
  });
});

describe("4. refresh capability cannot be self-asserted", () => {
  it("a token claiming a legacy contract is still refused", async () => {
    const storage = new MemoryStorage();
    await storage.save({
      accessToken: makeJwt({ jti: "q4", exp: NOW + 60 }),
      tokenType: "Bearer",
      expiresAt: NOW + 60,
      sessionVersion: "v",
      legacySingleTokenContract: true, // not part of StoredToken any more
    } as never);
    let tokenCalls = 0;
    const impl = (async (i: RequestInfo | URL) => {
      if (String(i).endsWith("/token")) tokenCalls += 1;
      return jsonRes({});
    }) as typeof fetch;
    const { client } = localClient({ storage, fetchImpl: impl });
    await expect(client.refresh({ force: true })).rejects.toThrow(/no refresh credential/i);
    expect(tokenCalls).toBe(0);
    client.destroy();
  });
});

describe("5. no token acquisition before policy checks", () => {
  it("logout never mints from a provider", async () => {
    let provides = 0;
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      logoutEndpoint: "http://app.test/lo",
      acknowledgeNoCsrf: true,
      tokenProvider: () => {
        provides += 1;
        return null;
      },
    });
    const { client } = localClient({
      storage,
      fetchImpl: (async () => jsonRes({})) as typeof fetch,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    await client.logout({ localOnly: true }).catch(() => {});
    expect(provides).toBe(0);
    client.destroy();
  });

  it("a rejected destination costs zero token calls in fetch()", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "q6", exp: NOW + 30 }), NOW + 30)); // expiring
    let tokenCalls = 0;
    const impl = (async (i: RequestInfo | URL) => {
      if (String(i).endsWith("/token")) tokenCalls += 1;
      return jsonRes({});
    }) as typeof fetch;
    const { client } = localClient({ storage, fetchImpl: impl });
    await expect(client.fetch("https://evil.example/x")).rejects.toBeInstanceOf(
      OriginNotAllowedError,
    );
    expect(tokenCalls).toBe(0);
    client.destroy();
  });

  it("a rejected destination costs zero token calls in buildRequest()", async () => {
    let provides = 0;
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      acknowledgeNoCsrf: true,
      tokenProvider: () => {
        provides += 1;
        return null;
      },
    });
    const { client } = localClient({ storage });
    await expect(client.buildRequest("https://evil.example/x")).rejects.toBeInstanceOf(
      OriginNotAllowedError,
    );
    expect(provides).toBe(0);
    client.destroy();
  });
});

describe("6. every security opt-out is reported, in isolation", () => {
  const cases: Array<{
    label: string;
    code: SecurityWarningCode;
    check: string;
    build: () => ReturnType<typeof secureClient>;
  }> = [
    {
      label: "allowInsecureTransport",
      code: "insecure-transport",
      check: "ack:insecure-transport",
      build: () =>
        secureClient({ storage: new MemoryStorage(), security: { allowInsecureTransport: true } }),
    },
    {
      label: "acknowledgeNoLoginTransaction",
      code: "no-login-transaction",
      check: "ack:no-login-transaction",
      build: () =>
        secureClient({
          storage: new MemoryStorage(),
          security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
        }),
    },
    {
      label: "acknowledgeMissingIssuer",
      code: "missing-issuer",
      check: "ack:missing-issuer",
      build: () =>
        secureClient({
          storage: new MemoryStorage(),
          security: { expectedIssuer: "https://idp.test/x", acknowledgeMissingIssuer: true },
        }),
    },
    {
      label: "acknowledgeNoRevocation",
      code: "no-revocation",
      check: "ack:no-revocation",
      build: () =>
        secureClient({ storage: new MemoryStorage(), security: { acknowledgeNoRevocation: true } }),
    },
    {
      label: "acknowledgeNoBackendLogout",
      code: "no-backend-logout",
      check: "ack:no-backend-logout",
      build: () =>
        secureClient({
          storage: new ServerManagedStorage({ transport: "bff", acknowledgeNoCsrf: true }),
          security: { acknowledgeNoBackendLogout: true },
        }),
    },
    {
      label: "acknowledgeUnsupportedRevocation",
      code: "unsupported-revocation",
      check: "ack:unsupported-revocation",
      build: () =>
        secureClient({
          storage: new MemoryStorage(),
          security: { acknowledgeUnsupportedRevocation: true },
        }),
    },
    {
      label: "CookieStorage allowInsecureTransport",
      code: "insecure-cookie-transport",
      check: "ack:insecure-cookie-transport",
      build: () =>
        secureClient({
          storage: new CookieStorage({
            name: "iso1",
            allowInsecureTransport: true,
            acknowledgeInsecureCookie: true,
            acknowledgeBrokerSingleTokenContract: true,
          }),
        }),
    },
    {
      label: "bff acknowledgeNoCsrf",
      code: "bff-without-csrf",
      check: "ack:bff-without-csrf",
      build: () =>
        secureClient({
          storage: new ServerManagedStorage({
            transport: "bff",
            acknowledgeNoCsrf: true,
            logoutEndpoint: "https://api.test/lo",
          }),
        }),
    },
    {
      label: "allowRefreshCapableToken",
      code: "refresh-capable-managed-token",
      check: "ack:refresh-capable-managed-token",
      build: () =>
        secureClient({
          storage: new ServerManagedStorage({
            transport: "bearer-from-endpoint",
            allowRefreshCapableToken: true,
            tokenProvider: () => null,
          }),
        }),
    },
    {
      label: "GET minting",
      code: "unsafe-token-endpoint-method",
      check: "ack:unsafe-token-endpoint-method",
      build: () =>
        secureClient({
          storage: new ServerManagedStorage({
            transport: "bearer-from-endpoint",
            tokenEndpoint: "https://api.test/t",
            tokenEndpointMethod: "GET",
            acknowledgeUnsafeTokenEndpointMethod: true,
            csrf: { headerName: "X-CSRFToken", token: "t" },
          }),
        }),
    },
    {
      label: "minting without CSRF",
      code: "token-endpoint-without-csrf",
      check: "ack:token-endpoint-without-csrf",
      build: () =>
        secureClient({
          storage: new ServerManagedStorage({
            transport: "bearer-from-endpoint",
            tokenEndpoint: "https://api.test/t",
            acknowledgeNoCsrf: true,
          }),
        }),
    },
  ];

  for (const c of cases) {
    it(`${c.label} -> exact code "${c.code}" and failed check "${c.check}"`, async () => {
      const { client, events } = c.build();
      const codes = events
        .filter((e) => e.type === "security-warning")
        .map((e) => (e as { code: string }).code);
      expect(codes).toContain(c.code);
      const report = await client.diagnose();
      const check = report.checks.find((x) => x.name === c.check);
      expect(check).toBeDefined();
      expect(check!.ok).toBe(false);
      expect(check!.severity ?? "error").toBe("error");
      expect(report.ok).toBe(false);
      client.destroy();
    });
  }

  it("a clean configuration produces no acknowledgement at all", async () => {
    const { client, events } = secureClient({ storage: new MemoryStorage() });
    expect(events.filter((e) => e.type === "security-warning")).toHaveLength(0);
    const report = await client.diagnose();
    expect(report.checks.filter((x) => x.name.startsWith("ack:"))).toHaveLength(0);
    expect(report.ok).toBe(true);
    client.destroy();
  });

  it("requireLoginTransaction:false without its acknowledgement is refused", () => {
    expect(() =>
      secureClient({
        storage: new MemoryStorage(),
        security: { requireLoginTransaction: false },
      }),
    ).toThrow(/acknowledgeNoLoginTransaction/);
  });
});

describe("8. credential minting is a POST with CSRF by default", () => {
  it("defaults to POST", async () => {
    let method = "";
    const s = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: "https://api.test/t",
      csrf: { headerName: "X-CSRFToken", token: "t" },
      fetchImpl: (async (_i: RequestInfo | URL, init?: RequestInit) => {
        method = String(init?.method);
        return jsonRes(accessOnlyResponse(makeJwt({ exp: NOW + 600 }), NOW + 600));
      }) as typeof fetch,
    });
    await s.load();
    expect(method).toBe("POST");
  });

  it("refuses GET minting without the acknowledgement", () => {
    expect(
      () =>
        new ServerManagedStorage({
          transport: "bearer-from-endpoint",
          tokenEndpoint: "https://api.test/t",
          tokenEndpointMethod: "GET",
          csrf: { headerName: "X", token: "t" },
        }),
    ).toThrow(/neither safe nor idempotent/i);
  });

  it("refuses cookie-authenticated minting without a CSRF decision", () => {
    expect(
      () =>
        new ServerManagedStorage({
          transport: "bearer-from-endpoint",
          tokenEndpoint: "https://api.test/t",
        }),
    ).toThrow(/CSRF/i);
  });

  it("a tokenProvider needs neither, since we send no cookie request", () => {
    expect(
      () =>
        new ServerManagedStorage({
          transport: "bearer-from-endpoint",
          tokenProvider: () => null,
        }),
    ).not.toThrow();
  });
});
