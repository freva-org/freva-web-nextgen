/**
 * Logout, revocation and redirect handling stay closed: post-logout targets are
 * allow-listed by every public helper, credentialed requests never follow an
 * unvalidated redirect, and an unsupported revocation fails the logout.
 *
 * Each name states the behaviour that must not come back.
 */
import { describe, expect, it } from "vitest";
import {
  AuthError,
  MemoryStorage,
  PyOidcAuthClient,
  RedirectNotAllowedError,
  RevocationError,
  ServerManagedStorage,
  type AuthConfig,
  type AuthEvent,
  type TokenStorage,
} from "../src/index.js";
import { CookieStorage } from "../src/unsafe-compat.js";
import { fetchView, jsonRes, makeJwt, stored } from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const REDIRECT = "http://app.test/cb";
const COOKIE_OK = {
  allowInsecureTransport: true,
  acknowledgeInsecureCookie: true,
  acknowledgeBrokerSingleTokenContract: true,
} as const;

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

describe("1. no public helper bypasses the post-logout allowlist", () => {
  it("logoutUrl() validates exactly like logout()", () => {
    const { c } = mk({ storage: new MemoryStorage() });
    expect(() => c.logoutUrl("https://evil.example/bye")).toThrow(RedirectNotAllowedError);
    c.destroy();
  });

  it("accepts an allow-listed post-logout target", () => {
    const { c } = mk({
      storage: new MemoryStorage(),
      security: { allowedPostLogoutRedirectUris: ["http://app.test/bye"] },
    });
    expect(c.logoutUrl("http://app.test/bye")).toContain("post_logout_redirect_uri");
    c.destroy();
  });
});

describe("2. server-managed logout cannot succeed without the backend", () => {
  it("refuses to log out when no logoutEndpoint is configured", async () => {
    const storage = new ServerManagedStorage({ transport: "bff", acknowledgeNoCsrf: true });
    const { c, events, navigated } = mk({
      storage,
      fetchImpl: (async () => jsonRes({})) as typeof fetch,
    });
    await expect(c.logout()).rejects.toThrow(/logoutEndpoint/);
    expect(events.some((e) => e.type === "logout")).toBe(false);
    expect(navigated).toHaveLength(0);
    c.destroy();
  });

  it("the escape hatch is explicit and keeps diagnose() non-OK", async () => {
    const storage = new ServerManagedStorage({ transport: "bff", acknowledgeNoCsrf: true });
    const impl = (async () => jsonRes({ keys: [] })) as typeof fetch;
    const { c, events } = mk({
      storage,
      fetchImpl: impl,
      security: { acknowledgeNoBackendLogout: true },
    });
    await c.logout({ localOnly: true });
    expect(events.some((e) => e.type === "logout")).toBe(true);
    const report = await c.diagnose();
    expect(report.checks.find((x) => x.name === "ack:no-backend-logout")?.ok).toBe(false);
    expect(report.ok).toBe(false);
    c.destroy();
  });

  it("a backend logout that fails emits no completion event and does not navigate", async () => {
    const LOGOUT = "http://app.test/api/logout";
    const storage = new ServerManagedStorage({
      transport: "bff",
      logoutEndpoint: LOGOUT,
      acknowledgeNoCsrf: true,
    });
    const impl = (async (i: RequestInfo | URL) =>
      String(i) === LOGOUT ? jsonRes({}, 500) : jsonRes({})) as typeof fetch;
    const { c, events, navigated } = mk({
      storage,
      fetchImpl: impl,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    await expect(c.logout()).rejects.toThrow(/may still be alive/i);
    expect(events.some((e) => e.type === "logout")).toBe(false);
    expect(navigated).toHaveLength(0);
    c.destroy();
  });
});

describe("3. callback matching is query-aware", () => {
  function tenantClient() {
    return mk({
      storage: new MemoryStorage(),
      redirectUri: "http://app.test/cb?tenant=a",
      security: { allowedRedirectUris: ["http://app.test/cb?tenant=a"] },
    });
  }

  it("rejects a mismatched static value", () => {
    const { c } = tenantClient();
    expect(c.isCallbackUrl("http://app.test/cb?tenant=EVIL&code=x&state=y")).toBe(false);
    expect(c.isCallbackUrl("http://app.test/cb?tenant=a&code=x&state=y")).toBe(true);
    c.destroy();
  });

  it("rejects a missing static parameter", () => {
    const { c } = tenantClient();
    expect(c.isCallbackUrl("http://app.test/cb?code=x&state=y")).toBe(false);
    c.destroy();
  });

  it("routes (does not reject) an unexpected extra parameter", () => {
    const { c } = tenantClient();
    expect(c.isCallbackUrl("http://app.test/cb?tenant=a&code=x&state=y&debug=1")).toBe(true);
    c.destroy();
  });

  it("rejects a duplicated static key used to smuggle a second value", () => {
    const { c } = tenantClient();
    expect(c.isCallbackUrl("http://app.test/cb?tenant=a&tenant=EVIL&code=x&state=y")).toBe(false);
    c.destroy();
  });

  it("compares decoded values, so encoding cannot be used to differ", () => {
    const { c } = mk({
      storage: new MemoryStorage(),
      redirectUri: "http://app.test/cb?env=a%20b",
      security: { allowedRedirectUris: ["http://app.test/cb?env=a%20b"] },
    });
    expect(c.isCallbackUrl("http://app.test/cb?env=a+b&code=x&state=y")).toBe(true);
    expect(c.isCallbackUrl("http://app.test/cb?env=a%20c&code=x&state=y")).toBe(false);
    c.destroy();
  });

  it("allows every recognized OIDC response parameter to vary", () => {
    const { c } = tenantClient();
    expect(
      c.isCallbackUrl("http://app.test/cb?tenant=a&code=x&state=y&session_state=s&iss=i"),
    ).toBe(true);
    c.destroy();
  });

  it("handleCallback refuses a tenant-mismatched response", async () => {
    const { c } = tenantClient();
    await expect(
      c.handleCallback("http://app.test/cb?tenant=EVIL&code=x&state=y"),
    ).rejects.toBeInstanceOf(RedirectNotAllowedError);
    c.destroy();
  });
});

describe("4. credentialed requests never follow an unvalidated redirect", () => {
  it("pins redirect:error on a Bearer request", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "r4", exp: NOW + 3600 }), NOW + 3600));
    let seen: RequestInit | undefined;
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      seen = fetchView(i, init).init;
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    await c.fetch("https://api.test/data");
    expect(seen?.redirect).toBe("error");
    c.destroy();
  });

  it("pins redirect:error on a credentialed BFF request", async () => {
    const storage = new ServerManagedStorage({
      transport: "bff",
      csrf: { headerName: "X-CSRFToken", token: "t" },
    });
    let seen: RequestInit | undefined;
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      seen = fetchView(i, init).init;
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    await c.fetch("http://app.test/api/x");
    expect(seen?.redirect).toBe("error");
    c.destroy();
  });

  it("refuses a caller who asks for manual redirect handling on a credentialed request", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "r4b", exp: NOW + 3600 }), NOW + 3600));
    const { c } = mk({ storage, fetchImpl: (async () => jsonRes({})) as typeof fetch });
    await expect(c.fetch("https://api.test/data", { redirect: "manual" })).rejects.toBeInstanceOf(
      AuthError,
    );
    c.destroy();
  });
});

describe("5. unsupported revocation is a logout failure", () => {
  for (const status of [404, 405, 501, 500]) {
    it(`status ${status} fails the logout and suppresses navigation`, async () => {
      const storage = new MemoryStorage();
      await storage.save(stored(makeJwt({ jti: "r5", exp: NOW + 3600 }), NOW + 3600));
      const impl = (async (i: RequestInfo | URL) =>
        String(i).endsWith("/revoke") ? jsonRes({}, status) : jsonRes({})) as typeof fetch;
      const { c, navigated, events } = mk({ storage, fetchImpl: impl });
      await expect(c.logout()).rejects.toBeInstanceOf(RevocationError);
      expect(navigated).toHaveLength(0);
      expect(events.some((e) => e.type === "logout")).toBe(false);
      c.destroy();
    });
  }

  it("acknowledged unsupported revocation warns and keeps diagnose() non-OK", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "r5b", exp: NOW + 3600 }), NOW + 3600));
    const impl = (async (i: RequestInfo | URL) =>
      String(i).endsWith("/revoke") ? jsonRes({}, 405) : jsonRes({ keys: [] })) as typeof fetch;
    const { c, events, navigated } = mk({
      storage,
      fetchImpl: impl,
      security: { acknowledgeUnsupportedRevocation: true, warnOnBrowserReadableRefresh: true },
    });
    await c.logout();
    expect(navigated).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "security-warning", code: "unsupported-revocation" }),
    );
    expect((await c.diagnose()).ok).toBe(false);
    c.destroy();
  });
});

describe("6. CookieStorage never manufactures a refresh credential", () => {
  it("refuses an access-only token", () => {
    const s = new CookieStorage({ name: "r6", ...COOKIE_OK });
    expect(() =>
      s.save({
        accessToken: makeJwt({ jti: "r6", exp: NOW + 600 }),
        tokenType: "Bearer",
        expiresAt: NOW + 600,
        sessionVersion: "v",
      }),
    ).toThrow(/access-only/i);
  });

  it("requires the broker single-token contract at CONSTRUCTION", () => {
    // A storage whose every operation throws must not be constructible at all:
    // diagnose() would otherwise report it as present and healthy.
    expect(
      () =>
        new CookieStorage({
          name: "r6b",
          allowInsecureTransport: true,
          acknowledgeInsecureCookie: true,
        }),
    ).toThrow(/acknowledgeBrokerSingleTokenContract/);
  });

  it("marks the legacy mode non-OK in diagnose()", async () => {
    const { c } = mk({
      storage: new CookieStorage({ name: "r6c", ...COOKIE_OK }),
      fetchImpl: (async () => jsonRes({ keys: [] })) as typeof fetch,
    });
    const report = await c.diagnose();
    expect(report.checks.find((x) => x.name === "ack:legacy-cookie-storage")?.ok).toBe(false);
    expect(report.ok).toBe(false);
    c.destroy();
  });
});
