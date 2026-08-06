/**
 * The core security invariants, from the first adversarial review.
 *
 * Redaction, CSRF, destination policy, URL resolution, allowlists, revocation
 * reporting, the bearer-from-endpoint contract, cookie injection and refresh
 * randomness. Each `it` name states the behaviour that must NOT come back.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CsrfUnavailableError,
  MemoryStorage,
  OriginNotAllowedError,
  PyOidcAuthClient,
  RedirectNotAllowedError,
  RevocationError,
  ServerManagedStorage,
  StorageContractError,
  type AuthConfig,
  type AuthEvent,
  type TokenStorage,
} from "../src/index.js";
import { CookieStorage } from "../src/unsafe-compat.js";
import { accessOnlyResponse, jsonRes, makeJwt, stored, tokenResponse } from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const REDIRECT = "http://app.test/cb";

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
    security: {
      allowInsecureTransport: true,
      warnOnBrowserReadableRefresh: false,
      ...o.security,
    },
  });
  return { c, events, navigated };
}

/** A JWT plus an opaque secret, both of which must never surface. */
const LEAKY_JWT = makeJwt({ jti: "leak", exp: NOW + 99 });
const OPAQUE = "OPAQUE-SECRET-XYZ";

describe("event and log redaction is absolute", () => {
  it("never copies a storage exception message into events or console", async () => {
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "o", exp: NOW + 60 }), NOW + 60),
      save: () => {
        throw new Error(`quota exceeded storing ${LEAKY_JWT} / ${OPAQUE}`);
      },
      clear: () => undefined,
    };
    const impl = (async () =>
      jsonRes(tokenResponse(makeJwt({ jti: "n", exp: NOW + 7200 }), NOW + 7200))) as typeof fetch;
    const { c, events } = mk({ storage, fetchImpl: impl });
    await c.refresh({ force: true });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(LEAKY_JWT);
    expect(serialized).not.toContain(OPAQUE);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "storage-write-failed", reasonCode: "storage-threw" }),
    );
    c.destroy();
  });

  it("keeps the credential out of console.warn when nothing is listening", async () => {
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "o2", exp: NOW + 60 }), NOW + 60),
      save: () => {
        throw new Error(`disk full: ${LEAKY_JWT} ${OPAQUE}`);
      },
      clear: () => undefined,
    };
    const impl = (async () =>
      jsonRes(tokenResponse(makeJwt({ jti: "n2", exp: NOW + 7200 }), NOW + 7200))) as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = new PyOidcAuthClient({
      authBaseUrl: BASE,
      redirectUri: REDIRECT,
      storage,
      crossTab: false,
      now: () => NOW,
      navigate: () => undefined,
      fetchImpl: impl,
      security: { allowInsecureTransport: true, warnOnBrowserReadableRefresh: false },
    }); // NOTE: no onEvent -> console.warn path
    await c.refresh({ force: true });
    const logged = warn.mock.calls.flat().join(" ");
    expect(warn).toHaveBeenCalled();
    expect(logged).not.toContain(LEAKY_JWT);
    expect(logged).not.toContain(OPAQUE);
    warn.mockRestore();
    c.destroy();
  });
});

describe("BFF CSRF fails closed", () => {
  const cases: Array<[string, () => string]> = [
    [
      "throwing provider",
      () => {
        throw new Error(`no cookie ${OPAQUE}`);
      },
    ],
    ["empty provider", () => ""],
  ];
  for (const [label, token] of cases) {
    it(`sends zero requests with a ${label}`, async () => {
      const storage = new ServerManagedStorage({
        transport: "bff",
        csrf: { headerName: "X-CSRFToken", token },
      });
      let sent = 0;
      const impl = (async () => {
        sent += 1;
        return jsonRes({});
      }) as typeof fetch;
      const { c } = mk({
        storage,
        fetchImpl: impl,
        security: { allowedResourceOrigins: ["http://app.test"] },
      });
      await expect(c.fetch("http://app.test/api/x")).rejects.toBeInstanceOf(CsrfUnavailableError);
      expect(sent).toBe(0);
      c.destroy();
    });
  }

  it("does not leak the provider's error text", async () => {
    const storage = new ServerManagedStorage({
      transport: "bff",
      csrf: {
        headerName: "X-CSRFToken",
        token: () => {
          throw new Error(OPAQUE);
        },
      },
    });
    const err = await storage.csrfHeaders().catch((e: unknown) => e as Error);
    expect(err.message).not.toContain(OPAQUE);
  });
});

describe("destination policy covers every credentialed endpoint", () => {
  it("refuses an off-origin logoutEndpoint at construction", () => {
    const storage = new ServerManagedStorage({
      transport: "bff",
      logoutEndpoint: "https://evil.example/logout",
      csrf: { headerName: "X-CSRFToken", token: "CSRF-SECRET" },
    });
    expect(() => mk({ storage })).toThrow(OriginNotAllowedError);
  });

  it("refuses an off-origin tokenEndpoint and healthUrl", () => {
    for (const key of ["tokenEndpoint", "healthUrl"] as const) {
      const storage = new ServerManagedStorage({
        transport: "bearer-from-endpoint",
        acknowledgeNoCsrf: true,
        [key]: "https://evil.example/x",
      } as never);
      expect(() => mk({ storage })).toThrow(OriginNotAllowedError);
    }
  });
});

describe("URL validation resolves before it decides", () => {
  it("rejects a backslash form that normalizes to another origin", () => {
    expect(new URL("/\\attacker.example/auth", "https://app.test").origin).toBe(
      "https://attacker.example",
    );
    expect(() =>
      mk({ storage: new MemoryStorage(), authBaseUrl: "/\\attacker.example/auth" }),
    ).toThrow(/backslash/i);
  });

  it("rejects protocol-relative and fragment-bearing config", () => {
    expect(() => mk({ storage: new MemoryStorage(), authBaseUrl: "//evil.example/a" })).toThrow(
      /protocol-relative/i,
    );
    expect(() => mk({ storage: new MemoryStorage(), redirectUri: "http://app.test/cb#f" })).toThrow(
      /fragment/i,
    );
  });

  it("refuses a fetch target containing a backslash", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "b", exp: NOW + 3600 }), NOW + 3600));
    const { c } = mk({ storage, fetchImpl: (async () => jsonRes({})) as typeof fetch });
    await expect(c.fetch("/\\evil.example/x")).rejects.toThrow(/backslash|resolve/i);
    c.destroy();
  });
});

describe("redirect and callback allowlists", () => {
  it("refuses an unlisted login redirectUri", () => {
    const { c } = mk({ storage: new MemoryStorage() });
    expect(() => c.loginUrl({ redirectUri: "https://evil.example/steal" })).toThrow(
      RedirectNotAllowedError,
    );
    expect(() => c.login({ redirectUri: "https://evil.example/steal" })).toThrow(
      RedirectNotAllowedError,
    );
    c.destroy();
  });

  it("accepts an explicitly allow-listed second redirect URI", () => {
    const { c } = mk({
      storage: new MemoryStorage(),
      security: { allowedRedirectUris: [REDIRECT, "https://alt.example/cb"] },
    });
    expect(c.loginUrl({ redirectUri: "https://alt.example/cb" })).toContain("alt.example");
    c.destroy();
  });

  it("refuses a callback response on a foreign URL", async () => {
    const impl = (async () =>
      jsonRes(tokenResponse(makeJwt({ jti: "cb", exp: NOW + 3600 }), NOW + 3600))) as typeof fetch;
    const { c } = mk({
      storage: new MemoryStorage(),
      fetchImpl: impl,
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
    await expect(
      c.handleCallback("https://evil.example/anywhere?code=a&state=b"),
    ).rejects.toBeInstanceOf(RedirectNotAllowedError);
    c.destroy();
  });

  it("isCallbackUrl ignores an app URL that merely carries ?error=", () => {
    const { c } = mk({ storage: new MemoryStorage() });
    expect(c.isCallbackUrl("http://app.test/dashboard?error=quota")).toBe(false);
    expect(c.isCallbackUrl("http://app.test/cb?error=access_denied")).toBe(true);
    c.destroy();
  });

  it("refuses an unlisted post-logout redirect", async () => {
    const { c } = mk({
      storage: new MemoryStorage(),
      fetchImpl: (async () => jsonRes({})) as typeof fetch,
    });
    await expect(
      c.logout({ postLogoutRedirectUri: "https://evil.example/bye" }),
    ).rejects.toBeInstanceOf(RedirectNotAllowedError);
    c.destroy();
  });
});

describe("revocation reports failure", () => {
  async function logoutWithRevokeStatus(status: number) {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "rv", exp: NOW + 3600 }), NOW + 3600));
    const impl = (async (i: RequestInfo | URL) =>
      String(i).endsWith("/revoke")
        ? jsonRes({ detail: "x" }, status)
        : jsonRes({})) as typeof fetch;
    const { c, navigated, events } = mk({ storage, fetchImpl: impl });
    const err = await c.logout().then(
      () => null,
      (e: unknown) => e,
    );
    const cleared = await storage.load();
    c.destroy();
    return { err, navigated, events, cleared };
  }

  it("treats a 500 as a failure and does not bounce to the IDP", async () => {
    const { err, navigated, cleared } = await logoutWithRevokeStatus(500);
    expect(err).toBeInstanceOf(RevocationError);
    expect(navigated).toHaveLength(0);
    expect(cleared).toBeNull(); // local credentials still cleared
  });

  it("treats a 401 as a failure too", async () => {
    const { err } = await logoutWithRevokeStatus(401);
    expect(err).toBeInstanceOf(RevocationError);
  });

  it("treats 404/405 as a failure too, and diagnose() reports it", async () => {
    const { err, navigated } = await logoutWithRevokeStatus(404);
    expect(err).toBeInstanceOf(RevocationError);
    expect(navigated).toHaveLength(0);

    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "d", exp: NOW + 3600 }), NOW + 3600));
    const impl = (async (i: RequestInfo | URL) =>
      String(i).endsWith("/revoke") ? jsonRes({}, 405) : jsonRes({ keys: [] })) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { acknowledgeUnsupportedRevocation: true },
    });
    await c.logout({ localOnly: true }); // acknowledged: no throw
    const report = await c.diagnose();
    expect(report.checks.some((x) => x.name === "revocation")).toBe(true);
    expect(report.ok).toBe(false); // acknowledgement never makes it healthy
    c.destroy();
  });
});

describe("bearer-from-endpoint contract", () => {
  it("rejects a refresh-capable token from the endpoint", async () => {
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: "http://app.test/api/tok",
      acknowledgeNoCsrf: true,
      fetchImpl: (async () =>
        jsonRes(
          tokenResponse(makeJwt({ jti: "bf", exp: NOW + 3600 }), NOW + 3600),
        )) as typeof fetch,
    });
    const { c } = mk({ storage, fetchImpl: (async () => jsonRes({})) as typeof fetch });
    await expect(c.getToken({ refresh: "never" })).rejects.toBeInstanceOf(StorageContractError);
    c.destroy();
  });

  it("warns about a refresh-capable Bearer on the plain read path", async () => {
    const storage = new MemoryStorage();
    const jwt = makeJwt({ jti: "rc", exp: NOW + 3600 });
    await storage.save({ ...stored(jwt, NOW + 3600), accessTokenIsRefreshCredential: true });
    const { c, events } = mk({ storage, security: { warnOnBrowserReadableRefresh: true } });
    await c.getToken({ refresh: "never" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "security-warning", code: "refresh-capable-bearer" }),
    );
    c.destroy();
  });

  it("still accepts a compliant access-only token", async () => {
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: "http://app.test/api/tok",
      acknowledgeNoCsrf: true,
      fetchImpl: (async () =>
        jsonRes(
          accessOnlyResponse(makeJwt({ jti: "ok", exp: NOW + 600 }), NOW + 600),
        )) as typeof fetch,
    });
    const { c } = mk({ storage, fetchImpl: (async () => jsonRes({})) as typeof fetch });
    expect((await c.getToken({ refresh: "never" }))?.refreshToken).toBeUndefined();
    c.destroy();
  });
});

describe("CookieStorage injection and split tokens", () => {
  it("rejects a path that would inject cookie attributes", () => {
    for (const path of ["/; Domain=example.test", "/a,b", "/a\\b", "/a b"]) {
      expect(
        () =>
          new CookieStorage({
            name: "inj",
            path,
            allowInsecureTransport: true,
            acknowledgeInsecureCookie: true,
            acknowledgeBrokerSingleTokenContract: true,
          }),
      ).toThrow(/path must start/i);
    }
    expect(
      () =>
        new CookieStorage({
          name: "ok",
          path: "/app",
          allowInsecureTransport: true,
          acknowledgeInsecureCookie: true,
          acknowledgeBrokerSingleTokenContract: true,
        }),
    ).not.toThrow();
  });

  it("refuses a split access/refresh pair instead of dropping the refresh token", () => {
    const s = new CookieStorage({
      name: "split",
      allowInsecureTransport: true,
      acknowledgeInsecureCookie: true,
      acknowledgeBrokerSingleTokenContract: true,
    });
    expect(() =>
      s.save({
        accessToken: makeJwt({ jti: "a", exp: NOW + 600 }),
        refreshToken: makeJwt({ jti: "r", exp: NOW + 99999 }),
        tokenType: "Bearer",
        expiresAt: NOW + 600,
        sessionVersion: "v1",
      }),
    ).toThrow(/split access\/refresh/i);
  });
});

describe("refresh correctness and randomness", () => {
  it("requires a CSPRNG for the login transaction id", () => {
    const g = globalThis as unknown as { crypto: Crypto };
    const real = Object.getOwnPropertyDescriptor(g, "crypto");
    Object.defineProperty(g, "crypto", { value: undefined, configurable: true });
    try {
      const { c } = mk({ storage: new MemoryStorage() });
      expect(() => c.login({ next: "/x" })).toThrow(/getRandomValues|Math\.random/i);
      c.destroy();
    } finally {
      if (real) Object.defineProperty(g, "crypto", real);
    }
  });
});
