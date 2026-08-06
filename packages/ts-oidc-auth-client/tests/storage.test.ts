import { beforeEach, describe, expect, it, vi } from "vitest";
// CookieStorage lives behind the deliberately-unsafe entry point.
import { CookieStorage } from "../src/unsafe-compat.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { ServerManagedStorage } from "../src/storage/serverManaged.js";
import { accessOnlyResponse, jsonRes, makeJwt, stored, tokenResponse } from "./helpers.js";

const NOW = Math.floor(Date.now() / 1000);

/**
 * The suite deliberately runs on http://app.test (a non-loopback plaintext
 * origin) so the Secure-on-http probe has something real to fail against.
 * CookieStorage refuses that origin unless the caller says it means it.
 */
const INSECURE_OK = {
  allowInsecureTransport: true,
  acknowledgeInsecureCookie: true,
  // CookieStorage is legacy single-token storage: it only makes sense where
  // the server deliberately issues one JWT as both access and refresh token.
  acknowledgeBrokerSingleTokenContract: true,
} as const;

function clearAllCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}

describe("MemoryStorage", () => {
  it("round-trips, clears, and notifies subscribers", () => {
    const s = new MemoryStorage();
    const seen: unknown[] = [];
    s.subscribe((t) => seen.push(t));
    expect(s.load()).toBeNull();
    const t = stored(makeJwt({ exp: NOW + 3600 }), NOW + 3600);
    s.save(t);
    expect(s.load()).toBe(t);
    s.clear();
    expect(s.load()).toBeNull();
    expect(seen).toHaveLength(2);
    expect(s.persistent).toBe(false);
  });
});

describe("CookieStorage", () => {
  beforeEach(clearAllCookies);

  it("stores the raw JWT and derives metadata from claims on load", () => {
    const jwt = makeJwt({ sub: "janedoe", exp: NOW + 3600 });
    const s = new CookieStorage({ name: "test_token", ...INSECURE_OK });
    s.save(stored(jwt, NOW + 3600));
    expect(document.cookie).toContain(`test_token=${jwt}`);
    const loaded = s.load();
    expect(loaded?.accessToken).toBe(jwt);
    // Broker contract: the same JWT is the refresh credential.
    expect(loaded?.refreshToken).toBe(jwt);
    expect(loaded?.accessTokenIsRefreshCredential).toBe(true);
    expect(loaded?.expiresAt).toBe(NOW + 3600);
    expect(s.persistent).toBe(true);
  });

  it("compat mode defaults to freva_auth_token and strips legacy quoting", () => {
    const s = new CookieStorage({
      compatibilityMode: "freva-web-single-token",
      ...INSECURE_OK,
    });
    expect(s.name).toBe("freva_auth_token");
    const jwt = makeJwt({ exp: NOW + 60 });
    document.cookie = `freva_auth_token="${jwt}"; Path=/`;
    expect(s.load()?.accessToken).toBe(jwt);
  });

  it("treats a JWT without exp as expiresAt=0 (refresh-credential-only)", () => {
    const jwt = makeJwt({ sub: "x" });
    const s = new CookieStorage({ name: "noexp", ...INSECURE_OK });
    document.cookie = `noexp=${jwt}; Path=/`;
    expect(s.load()?.expiresAt).toBe(0);
  });

  it("probe() round-trips with the ACTUAL configured attributes", () => {
    expect(new CookieStorage({ name: "p1", ...INSECURE_OK }).probe()).toBe(true);
    // The test origin is plain http (non-localhost), where Secure cookies
    // are rejected - probe() must report that honestly, not probe a fiction.
    expect(new CookieStorage({ name: "p2", secure: true, ...INSECURE_OK }).probe()).toBe(false);
    // Second real-attribute failure mode: a Path that does not cover this page.
    expect(new CookieStorage({ name: "p3", path: "/elsewhere", ...INSECURE_OK }).probe()).toBe(
      false,
    );
  });

  it("save() refuses cookie-unsafe token values instead of corrupting them", () => {
    const s = new CookieStorage({ name: "unsafe", ...INSECURE_OK });
    expect(() => s.save(stored("opaque;token with spaces", NOW + 60))).toThrow(/cookie-unsafe/i);
  });

  it("clear removes the cookie; SameSite=None requires Secure", () => {
    const s = new CookieStorage({ name: "gone", ...INSECURE_OK });
    s.save(stored(makeJwt({ exp: NOW + 60 }), NOW + 60));
    s.clear();
    expect(s.load()).toBeNull();
    expect(() => new CookieStorage({ sameSite: "None", secure: false, ...INSECURE_OK })).toThrow(
      /Secure/,
    );
  });

  it("refuses an oversized token instead of letting the browser drop it silently", () => {
    // A broker JWT grows with the role list; browsers cap a cookie at 4096
    // bytes and discard the write with no error at all.
    const big = makeJwt({
      exp: NOW + 3600,
      roles: Array.from({ length: 400 }, (_, i) => `role-number-${i}`),
    });
    expect(big.length).toBeGreaterThan(4096);
    const s = new CookieStorage({ name: "bigtok", ...INSECURE_OK });
    expect(() => s.save(stored(big, NOW + 3600))).toThrow(/does not fit/i);
  });

  it("accepts a token that fits, right up to the limit", () => {
    const s = new CookieStorage({ name: "fits", ...INSECURE_OK });
    const jwt = makeJwt({ exp: NOW + 3600, pad: "x".repeat(2000) });
    expect(jwt.length).toBeLessThan(4096);
    expect(() => s.save(stored(jwt, NOW + 3600))).not.toThrow();
    expect(s.load()?.accessToken).toBe(jwt);
  });

  it("refuses a plaintext non-loopback origin unless explicitly acknowledged", () => {
    expect(
      () =>
        new CookieStorage({
          name: "nope",
          acknowledgeInsecureCookie: true,
          acknowledgeBrokerSingleTokenContract: true,
        }),
    ).toThrow(/plaintext origin/i);
    // ...and a refresh cookie without Secure is refused on its own terms.
    expect(
      () =>
        new CookieStorage({
          name: "nope2",
          allowInsecureTransport: true,
          acknowledgeBrokerSingleTokenContract: true,
        }),
    ).toThrow(/Secure attribute/i);
    expect(() => new CookieStorage({ name: "nope", ...INSECURE_OK })).not.toThrow();
  });

  it("enforces the __Host- / __Secure- cookie prefix contracts", () => {
    expect(
      () => new CookieStorage({ name: "__Host-tok", secure: true, path: "/sub", ...INSECURE_OK }),
    ).toThrow(/__Host-/);
    expect(() => new CookieStorage({ name: "__Host-tok", secure: false, ...INSECURE_OK })).toThrow(
      /__Host-/,
    );
    expect(
      () => new CookieStorage({ name: "__Secure-tok", secure: false, ...INSECURE_OK }),
    ).toThrow(/__Secure-/);
    expect(
      () => new CookieStorage({ name: "__Host-tok", secure: true, ...INSECURE_OK }),
    ).not.toThrow();
  });

  it("rejects malformed cookie names and paths", () => {
    expect(() => new CookieStorage({ name: "bad name", ...INSECURE_OK })).toThrow(
      /valid cookie name/i,
    );
    expect(() => new CookieStorage({ name: "ok", path: "relative", ...INSECURE_OK })).toThrow(
      /must start with/i,
    );
  });
});

describe("ServerManagedStorage (bearer-from-endpoint)", () => {
  it("pulls from the endpoint once and caches until stale", async () => {
    const jwt = makeJwt({ exp: NOW + 3600 });
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
      jsonRes(accessOnlyResponse(jwt, NOW + 3600)),
    );
    const s = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: "https://app.test/api/access-token",
      acknowledgeNoCsrf: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const first = await s.load();
    const second = await s.load();
    expect(first?.accessToken).toBe(jwt);
    expect(second?.accessToken).toBe(jwt);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      // A minted credential must never come from a cache or a followed redirect.
      cache: "no-store",
      redirect: "error",
    });
  });

  it("sends the CSRF header and honours tokenEndpointMethod", async () => {
    const jwt = makeJwt({ exp: NOW + 3600 });
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
      jsonRes(accessOnlyResponse(jwt, NOW + 3600)),
    );
    const s = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: "https://app.test/api/access-token",
      acknowledgeNoCsrf: true,
      tokenEndpointMethod: "POST",
      csrf: { headerName: "X-CSRFToken", token: () => "csrf-abc" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await s.load();
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-CSRFToken")).toBe("csrf-abc");
  });

  it("returns null when the backend session is absent (401)", async () => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
      jsonRes({ detail: "nope" }, 401),
    );
    const s = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: "https://app.test/api/access-token",
      acknowledgeNoCsrf: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await s.load()).toBeNull();
  });

  it("bff transport exposes no token to JS", async () => {
    const s = new ServerManagedStorage({
      transport: "bff",
      acknowledgeNoCsrf: true,
    });
    expect(await s.load()).toBeNull();
    expect(s.transport).toBe("bff");
  });

  it("bff refuses to be constructed without a CSRF strategy", () => {
    expect(() => new ServerManagedStorage({ transport: "bff" })).toThrow(/CSRF/i);
    expect(
      () =>
        new ServerManagedStorage({
          transport: "bff",
          csrf: { headerName: "X-CSRFToken", token: "t" },
        }),
    ).not.toThrow();
  });
});

describe("bearer-from-endpoint security contract", () => {
  const endpoint = "https://app.test/api/access-token";
  const jwt = makeJwt({ exp: NOW + 600 });

  it("rejects a response that hands the browser refresh capability", async () => {
    const s = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: endpoint,
      acknowledgeNoCsrf: true,
      // tokenResponse() mirrors broker mode: access_token === refresh_token
      fetchImpl: (async () => jsonRes(tokenResponse(jwt, NOW + 600))) as typeof fetch,
    });
    await expect(s.load()).rejects.toThrow(/refresh_token|refresh capability/i);
  });

  it("accepts an access-only response", async () => {
    const s = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: endpoint,
      acknowledgeNoCsrf: true,
      fetchImpl: (async () => jsonRes(accessOnlyResponse(jwt, NOW + 600))) as typeof fetch,
    });
    const t = await s.load();
    expect(t?.refreshToken).toBeUndefined();
    expect(t?.accessTokenIsRefreshCredential).toBeUndefined();
  });

  it("allows the downgrade only when it is asked for explicitly", async () => {
    const s = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: endpoint,
      acknowledgeNoCsrf: true,
      allowRefreshCapableToken: true,
      fetchImpl: (async () => jsonRes(tokenResponse(jwt, NOW + 600))) as typeof fetch,
    });
    expect((await s.load())?.accessTokenIsRefreshCredential).toBe(true);
  });

  it("flags a token that outlives the short-lifetime threshold", async () => {
    const long = makeJwt({ exp: NOW + 100000 });
    const s = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: endpoint,
      acknowledgeNoCsrf: true,
      fetchImpl: (async () =>
        jsonRes(accessOnlyResponse(long, Math.floor(Date.now() / 1000) + 100000))) as typeof fetch,
    });
    await s.load();
    expect(s.longLivedTokenObserved).toBe(true);
  });

  it("CSRF failure aborts instead of sending an unprotected request", async () => {
    const s = new ServerManagedStorage({
      transport: "bff",
      csrf: { headerName: "X-CSRFToken", token: () => "" },
    });
    await expect(s.csrfHeaders()).rejects.toThrow(/CSRF/);
  });
});

describe("CookieStorage broker-contract acknowledgement", () => {
  const jwt = makeJwt({ exp: NOW + 600 });

  it("cannot even be constructed without the explicit acknowledgement", () => {
    expect(
      () =>
        new CookieStorage({
          name: "unack",
          allowInsecureTransport: true,
          acknowledgeInsecureCookie: true,
        }),
    ).toThrow(/acknowledgeBrokerSingleTokenContract/);
  });

  it("refuses an access-only token instead of inventing refresh capability", () => {
    const s = new CookieStorage({ name: "acconly", ...INSECURE_OK });
    expect(() =>
      s.save({
        accessToken: jwt,
        tokenType: "Bearer",
        expiresAt: NOW + 600,
        sessionVersion: "v",
      }),
    ).toThrow(/access-only/i);
  });

  it("refuses a token explicitly marked non-refreshable", () => {
    const s = new CookieStorage({ name: "nonref", ...INSECURE_OK });
    expect(() => s.save({ ...stored(jwt, NOW + 600), refreshable: false })).toThrow(
      /refreshable=false/,
    );
  });

  it("still accepts a genuine broker single-token pair", () => {
    const s = new CookieStorage({ name: "brokerok", ...INSECURE_OK });
    expect(() => s.save(stored(jwt, NOW + 600))).not.toThrow();
    expect(s.load()?.accessTokenIsRefreshCredential).toBe(true);
  });
});
