import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LoginTransactionError,
  MemoryStorage,
  NotAuthenticatedError,
  OriginNotAllowedError,
  PyOidcAuthClient,
  RefreshError,
  ServerManagedStorage,
  SessionExpiredError,
  type AuthConfig,
  type AuthEvent,
  type StoredToken,
  type TokenStorage,
} from "../src/index.js";
import { CookieStorage } from "../src/unsafe-compat.js";
import {
  accessOnlyResponse,
  fetchView,
  installFakeBroadcastChannel,
  jsonRes,
  makeJwt,
  stored,
  tokenResponse,
} from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const REDIRECT = "http://app.test/cb";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function makeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const view = fetchView(input, init);
    calls.push({ url: view.url, init: view.init });
    return handler(view.url, view.init);
  }) as typeof fetch;
  return { impl, calls };
}

const created: PyOidcAuthClient[] = [];

/**
 * handleCallback() now requires evidence that a login started in this tab
 * (login-CSRF defense), so most tests seed that transaction the way login()
 * would. Pass `seedLoginTxn: false` to exercise the defense itself.
 */
function mkClient(
  overrides: Partial<AuthConfig> & { storage: TokenStorage },
  opts: { seedLoginTxn?: boolean } = {},
) {
  const events: AuthEvent[] = [];
  const navigated: string[] = [];
  const client = new PyOidcAuthClient({
    authBaseUrl: BASE,
    redirectUri: REDIRECT,
    crossTab: false,
    now: () => NOW,
    navigate: (url) => navigated.push(url),
    onEvent: (e) => events.push(e),
    ...overrides,
    // The suite deliberately runs on a plaintext non-loopback origin.
    security: { allowInsecureTransport: true, ...overrides.security },
  });
  created.push(client);
  if (opts.seedLoginTxn ?? true) {
    sessionStorage.setItem(
      `${client.channelName}:txn`,
      JSON.stringify({ id: "test-txn", at: overrides.now ? overrides.now() : NOW }),
    );
  }
  return { client, events, navigated };
}

/**
 * A configuration with ZERO compatibility acknowledgements, so diagnose() can
 * legitimately be green. The default mkClient sets allowInsecureTransport
 * (the suite runs on a plaintext origin), which is itself an acknowledgement
 * and therefore always fails the report.
 */
function mkCleanClient(overrides: Partial<AuthConfig> & { storage: TokenStorage }) {
  const events: AuthEvent[] = [];
  const client = new PyOidcAuthClient({
    authBaseUrl: BASE,
    redirectUri: "https://app.example/cb",
    crossTab: false,
    now: () => NOW,
    navigate: () => undefined,
    onEvent: (e) => events.push(e),
    ...overrides,
    security: {
      allowedRedirectUris: ["https://app.example/cb"],
      ...overrides.security,
    },
  });
  created.push(client);
  return { client, events };
}

/** bff must declare a CSRF strategy; most tests are not about CSRF. */
const bffStorage = (extra: Record<string, unknown> = {}) =>
  new ServerManagedStorage({
    transport: "bff",
    acknowledgeNoCsrf: true,
    ...extra,
  } as ConstructorParameters<typeof ServerManagedStorage>[0]);

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  for (const c of created.splice(0)) c.destroy();
  sessionStorage.clear();
});

// ---------------------------------------------------------------------------
// Constructor & events
// ---------------------------------------------------------------------------

describe("constructor", () => {
  it("throws a self-explanatory error when storage is missing", () => {
    expect(
      () =>
        new PyOidcAuthClient({
          authBaseUrl: BASE,
          redirectUri: REDIRECT,
        } as unknown as AuthConfig),
    ).toThrowError(/storage is required/i);
  });

  it("emits security-warning for CookieStorage (refresh-capable, JS-readable)", () => {
    const { events } = mkClient({
      storage: new CookieStorage({
        allowInsecureTransport: true,
        acknowledgeInsecureCookie: true,
        acknowledgeBrokerSingleTokenContract: true,
      }),
    });
    const codes = events
      .filter((e) => e.type === "security-warning")
      .map((e) => (e as { code: string }).code);
    expect(codes).toContain("browser-readable-refresh-credential");
    // The acknowledgement itself is always announced.
    expect(codes).toContain("legacy-cookie-storage");
  });

  it("emits security-warning for unknown custom storage kinds", () => {
    const custom: TokenStorage = {
      load: () => null,
      save: () => undefined,
      clear: () => undefined,
    };
    const { events } = mkClient({ storage: custom });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "security-warning",
        code: "unverifiable-custom-storage",
      }),
    );
  });

  it("suppresses the storage-kind warning but never the acknowledgement", () => {
    const { events } = mkClient({
      storage: new CookieStorage({
        allowInsecureTransport: true,
        acknowledgeInsecureCookie: true,
        acknowledgeBrokerSingleTokenContract: true,
      }),
      security: { warnOnBrowserReadableRefresh: false },
    });
    const codes = events
      .filter((e) => e.type === "security-warning")
      .map((e) => (e as { code: string }).code);
    expect(codes).not.toContain("browser-readable-refresh-credential");
    // An explicit compatibility acknowledgement is not a warning you can mute.
    expect(codes).toContain("legacy-cookie-storage");
  });

  it("does not warn when nothing unsafe was acknowledged", () => {
    const { events } = mkCleanClient({ storage: new MemoryStorage() });
    expect(events.some((e) => e.type === "security-warning")).toBe(false);
  });

  it("fails closed on an unusable configuration", () => {
    const storage = new MemoryStorage();
    const base = (extra: Partial<AuthConfig>) =>
      new PyOidcAuthClient({
        authBaseUrl: BASE,
        redirectUri: REDIRECT,
        storage,
        security: { allowInsecureTransport: true },
        ...extra,
      } as AuthConfig);

    expect(
      () =>
        new PyOidcAuthClient({
          authBaseUrl: "http://api.insecure.test/auth/v2",
          redirectUri: "https://app.example/cb",
          storage,
        }),
    ).toThrow(/plaintext http/i);
    expect(() => base({ redirectUri: "not-a-url" })).toThrow(/redirectUri/);
    expect(() => base({ refreshTimeoutMs: 0 })).toThrow(/refreshTimeoutMs/);
    expect(() => base({ refreshBufferSeconds: Number.NaN })).toThrow(/refreshBufferSeconds/);
    // A4: syntactic "relative" checks are not enough - the browser normalizes
    // the backslash and this resolves to another origin entirely.
    expect(() => base({ authBaseUrl: "/\\attacker.example/auth" })).toThrow(/backslash/i);
    expect(() => base({ authBaseUrl: "//attacker.example/auth" })).toThrow(/protocol-relative/i);
    // A4: OAuth redirect URIs must not carry a fragment.
    expect(() => base({ redirectUri: "http://app.test/cb#frag" })).toThrow(/fragment/i);
  });
});

// ---------------------------------------------------------------------------
// loginUrl / login / isCallbackUrl
// ---------------------------------------------------------------------------

describe("login", () => {
  it("builds the login URL against the trimmed base", () => {
    const { client } = mkClient({
      storage: new MemoryStorage(),
      authBaseUrl: `${BASE}///`,
    });
    expect(client.loginUrl()).toBe(`${BASE}/login?redirect_uri=${encodeURIComponent(REDIRECT)}`);
  });

  it("carries prompt/scope/offline_access when provided", () => {
    const { client } = mkClient({ storage: new MemoryStorage() });
    const u = new URL(client.loginUrl({ prompt: "login", scope: "openid x", offlineAccess: true }));
    expect(u.searchParams.get("prompt")).toBe("login");
    expect(u.searchParams.get("scope")).toBe("openid x");
    expect(u.searchParams.get("offline_access")).toBe("true");
  });

  it("login() stores next, emits login-started, and navigates top-level", () => {
    const { client, events, navigated } = mkClient({
      storage: new MemoryStorage(),
    });
    client.login({ next: "/plots/42" });
    expect(sessionStorage.getItem(`${client.channelName}:next`)).toBe("/plots/42");
    expect(events.find((e) => e.type === "login-started")).toBeDefined();
    expect(navigated).toHaveLength(1);
    expect(navigated[0]).toContain(`${BASE}/login?`);
  });

  it("isCallbackUrl routes anything response-shaped on an owned route", () => {
    const { client } = mkClient({ storage: new MemoryStorage() });
    expect(client.isCallbackUrl("http://app.test/cb?code=a&state=b")).toBe(true);
    // Code-only used to be "not a callback", so the router skipped it and the
    // authorization code stayed in the address bar.
    expect(client.isCallbackUrl("http://app.test/cb?code=a")).toBe(true);
    expect(client.isCallbackUrl("http://app.test/cb?state=b")).toBe(true);
    expect(client.isCallbackUrl("http://app.test/cb")).toBe(false);
    expect(client.isCallbackUrl("http://app.test/")).toBe(false);
  });

  it("isCallbackUrl recognizes OIDC error redirects", () => {
    const { client } = mkClient({ storage: new MemoryStorage() });
    expect(client.isCallbackUrl("http://app.test/cb?error=access_denied")).toBe(true);
  });

  it("login({ next }) rejects non-relative return paths (open-redirect guard)", () => {
    const { client } = mkClient({ storage: new MemoryStorage() });
    expect(() => client.login({ next: "https://evil.example/" })).toThrow(/relative path/i);
    expect(() => client.login({ next: "//evil.example/x" })).toThrow(/relative path/i);
    expect(() => client.login({ next: "/\\evil.example" })).toThrow(/relative path/i);
  });

  it("consumeReturnPath nulls out a tampered absolute value and clears the slot", () => {
    const { client } = mkClient({ storage: new MemoryStorage() });
    sessionStorage.setItem(`${client.channelName}:next`, "https://evil.example/");
    expect(client.consumeReturnPath()).toBeNull();
    expect(sessionStorage.getItem(`${client.channelName}:next`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleCallback
// ---------------------------------------------------------------------------

describe("handleCallback", () => {
  const jwt = makeJwt({ sub: "jane", jti: "j1", exp: NOW + 3600 });

  it("exchanges code+state via GET {base}/callback and saves the token", async () => {
    const { impl, calls } = makeFetch(() => jsonRes(tokenResponse(jwt, NOW + 3600)));
    const storage = new MemoryStorage();
    const { client, events } = mkClient({ storage, fetchImpl: impl });

    const token = await client.handleCallback("http://app.test/cb?code=abc&state=xyz");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/callback?code=abc&state=xyz`);
    expect(token.accessToken).toBe(jwt);
    expect(token.refreshToken).toBe(jwt); // broker mode: one JWT, two roles
    expect(token.expiresAt).toBe(NOW + 3600);
    expect(await Promise.resolve(storage.load())).toMatchObject({ accessToken: jwt });
    expect(events.some((e) => e.type === "login-completed")).toBe(true);
  });

  it("reports the stashed return path in login-completed", async () => {
    const { impl } = makeFetch(() => jsonRes(tokenResponse(jwt, NOW + 3600)));
    const { client, events } = mkClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
    });
    sessionStorage.setItem(`${client.channelName}:next`, "/back/here");

    await client.handleCallback("http://app.test/cb?code=a&state=b");
    const done = events.find((e) => e.type === "login-completed") as {
      hasReturnPath: boolean;
    };
    // The path itself is application data and no longer rides into telemetry.
    expect(done.hasReturnPath).toBe(true);
    expect(JSON.stringify(events)).not.toContain("/back/here");
    expect(client.consumeReturnPath()).toBe("/back/here");
    expect(client.consumeReturnPath()).toBeNull(); // read-and-clear
  });

  it("scrubs ONLY the OIDC params from the address bar (current-location mode)", async () => {
    history.replaceState(null, "", "/cb?keep=1&code=abc&state=xyz#frag");
    expect(location.search).toContain("code=abc"); // happy-dom sanity probe

    const { impl } = makeFetch(() => jsonRes(tokenResponse(jwt, NOW + 3600)));
    const { client } = mkClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
      redirectUri: "http://app.test/cb?keep=1",
    });
    await client.handleCallback();

    expect(location.pathname).toBe("/cb");
    expect(location.search).toBe("?keep=1");
    expect(location.hash).toBe("#frag");
  });

  it("does not touch history when an explicit URL is passed", async () => {
    history.replaceState(null, "", "/somewhere?untouched=1");
    const { impl } = makeFetch(() => jsonRes(tokenResponse(jwt, NOW + 3600)));
    const { client } = mkClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
    });
    await client.handleCallback("http://app.test/cb?code=a&state=b");
    expect(location.search).toBe("?untouched=1");
  });

  it("scrubs when the explicit URL IS the current location (router-style)", async () => {
    history.replaceState(null, "", "/cb?keep=4&code=a&state=b");
    const { impl } = makeFetch(() => jsonRes(tokenResponse(jwt, NOW + 3600)));
    const { client } = mkClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
      redirectUri: "http://app.test/cb?keep=4",
    });
    await client.handleCallback(location.href); // common router integration
    expect(location.pathname).toBe("/cb");
    expect(location.search).toBe("?keep=4");
  });

  it("scrubs an error callback from the address bar before throwing", async () => {
    history.replaceState(null, "", "/cb?keep=2&error=access_denied&error_description=denied");
    const { client } = mkClient({
      storage: new MemoryStorage(),
      redirectUri: "http://app.test/cb?keep=2",
    });
    await expect(client.handleCallback()).rejects.toThrowError(/provider-error/);
    expect(location.pathname).toBe("/cb");
    expect(location.search).toBe("?keep=2");
  });

  it("scrubs code/state even when the exchange fails (state carries the PKCE verifier)", async () => {
    history.replaceState(null, "", "/cb?keep=3&code=a&state=secret");
    const { impl } = makeFetch(() => jsonRes({ detail: "down" }, 502));
    const { client } = mkClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
      redirectUri: "http://app.test/cb?keep=3",
    });
    await expect(client.handleCallback()).rejects.toThrowError(/502/);
    expect(location.search).toBe("?keep=3");
    expect(location.search).not.toContain("secret");
  });

  it("throws on IDP error params without calling the server", async () => {
    const { impl, calls } = makeFetch(() => jsonRes({}, 500));
    const { client } = mkClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
    });
    await expect(
      client.handleCallback("http://app.test/cb?error=access_denied&error_description=nope"),
    ).rejects.toThrowError(/provider-error/);
    expect(calls).toHaveLength(0);
  });

  it("throws when code or state is missing", async () => {
    const { client } = mkClient({ storage: new MemoryStorage() });
    await expect(client.handleCallback("http://app.test/cb?code=onlycode")).rejects.toThrowError(
      /missing-code-or-state/,
    );
  });

  it("throws on a non-OK exchange", async () => {
    const { impl } = makeFetch(() => jsonRes({ detail: "bad" }, 400));
    const { client } = mkClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
    });
    await expect(client.handleCallback("http://app.test/cb?code=a&state=b")).rejects.toThrowError(
      /400/,
    );
  });
});

// ---------------------------------------------------------------------------
// getToken / requireToken
// ---------------------------------------------------------------------------

describe("getToken", () => {
  const jwt = makeJwt({ sub: "jane", jti: "j2", exp: NOW + 3600 });

  it("returns null without any network call when storage is empty", async () => {
    const { impl, calls } = makeFetch(() => jsonRes({}));
    const { client } = mkClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
    });
    await expect(client.getToken()).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("refresh:'never' returns the stored token as-is, even when expired", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW - 100));
    const { impl, calls } = makeFetch(() => jsonRes({}));
    const { client } = mkClient({ storage, fetchImpl: impl });
    const t = await client.getToken({ refresh: "never" });
    expect(t?.expiresAt).toBe(NOW - 100);
    expect(calls).toHaveLength(0);
  });

  it("returns a fresh token without refreshing (auto)", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    const { impl, calls } = makeFetch(() => jsonRes({}));
    const { client } = mkClient({ storage, fetchImpl: impl });
    const t = await client.getToken();
    expect(t?.expiresAt).toBe(NOW + 3600);
    expect(calls).toHaveLength(0);
  });

  it("refreshes an expiring token (auto) and returns the rotated one", async () => {
    const fresh = makeJwt({ sub: "jane", jti: "j3", exp: NOW + 7200 });
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 60)); // inside 120s buffer
    const { impl, calls } = makeFetch(() => jsonRes(tokenResponse(fresh, NOW + 7200)));
    const { client, events } = mkClient({ storage, fetchImpl: impl });

    const t = await client.getToken();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/token`);
    expect(t?.accessToken).toBe(fresh);
    expect(await Promise.resolve(storage.load())).toMatchObject({
      accessToken: fresh,
    });
    expect(events.find((e) => e.type === "token-refreshed")).toMatchObject({ source: "self" });
  });

  it("refresh:'force' rotates even a fresh token", async () => {
    const fresh = makeJwt({ sub: "jane", jti: "j4", exp: NOW + 9999 });
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    const { impl, calls } = makeFetch(() => jsonRes(tokenResponse(fresh, NOW + 9999)));
    const { client } = mkClient({ storage, fetchImpl: impl });
    const t = await client.getToken({ refresh: "force" });
    expect(calls).toHaveLength(1);
    expect(t?.accessToken).toBe(fresh);
  });

  it("requireToken throws NotAuthenticatedError when signed out", async () => {
    const { client } = mkClient({ storage: new MemoryStorage() });
    await expect(client.requireToken()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});

// ---------------------------------------------------------------------------
// refresh: wire format, single-flight, classification, peer rotation
// ---------------------------------------------------------------------------

describe("refresh", () => {
  const jwt = makeJwt({ sub: "jane", jti: "j5", exp: NOW + 60 });

  it("POSTs the hyphenated refresh-token form field py-oidc-auth expects", async () => {
    const fresh = makeJwt({ sub: "jane", jti: "j6", exp: NOW + 7200 });
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 60));
    const { impl, calls } = makeFetch(() => jsonRes(tokenResponse(fresh, NOW + 7200)));
    const { client } = mkClient({ storage, fetchImpl: impl });
    await client.refresh();

    const call = calls[0]!;
    expect(call.init?.method).toBe("POST");
    expect(new Headers(call.init?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(call.init?.body));
    expect(body.get("refresh-token")).toBe(jwt);
    expect(body.has("refresh_token")).toBe(false);
  });

  it("single-flights concurrent refreshes into one POST", async () => {
    const fresh = makeJwt({ sub: "jane", jti: "j7", exp: NOW + 7200 });
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 60));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { impl, calls } = makeFetch(async () => {
      await gate;
      return jsonRes(tokenResponse(fresh, NOW + 7200));
    });
    const { client } = mkClient({ storage, fetchImpl: impl });

    const both = Promise.all([client.refresh(), client.refresh()]);
    release();
    const [a, b] = await both;
    expect(calls).toHaveLength(1);
    expect(a.accessToken).toBe(fresh);
    expect(b.accessToken).toBe(fresh);
  });

  it("401 is terminal: clears storage, emits, throws SessionExpiredError", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 60));
    const { impl } = makeFetch(() => jsonRes({ detail: "invalid" }, 401));
    const { client, events } = mkClient({ storage, fetchImpl: impl });

    await expect(client.refresh()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(await Promise.resolve(storage.load())).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "refresh-failed",
        kind: "terminal_invalid_session",
        status: 401,
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "session-expired" }));
  });

  it("getToken(auto) maps a terminal refresh to null, not a throw", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 60));
    const { impl } = makeFetch(() => jsonRes({}, 401));
    const { client } = mkClient({ storage, fetchImpl: impl });
    await expect(client.getToken()).resolves.toBeNull();
  });

  it("503 is transient: storage retained, stale-but-valid token returned", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 60)); // expiring (buffer 120) but NOT expired (skew 30)
    const { impl } = makeFetch(() => jsonRes({ detail: "down" }, 503));
    const { client, events } = mkClient({ storage, fetchImpl: impl });

    const t = await client.getToken();
    expect(t?.expiresAt).toBe(NOW + 60); // the stale token, still usable
    expect(await Promise.resolve(storage.load())).not.toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "refresh-failed",
        kind: "transient_server",
        status: 503,
      }),
    );
    expect(events.some((e) => e.type === "session-expired")).toBe(false);
  });

  it("503 with an already-expired token surfaces the RefreshError", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW - 100));
    const { impl } = makeFetch(() => jsonRes({}, 503));
    const { client } = mkClient({ storage, fetchImpl: impl });
    const err = await client.getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefreshError);
    expect((err as RefreshError).kind).toBe("transient_server");
    expect(await Promise.resolve(storage.load())).not.toBeNull(); // never cleared
  });

  it("network failure classifies as transient_network and keeps storage", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW - 100));
    const { impl } = makeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const { client, events } = mkClient({ storage, fetchImpl: impl });
    const err = await client.refresh().catch((e: unknown) => e);
    expect((err as RefreshError).kind).toBe("transient_network");
    expect(await Promise.resolve(storage.load())).not.toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "refresh-failed",
        kind: "transient_network",
      }),
    );
  });

  it("refuses to refresh a token marked refreshable=false", async () => {
    const storage = new MemoryStorage();
    await storage.save({ ...stored(jwt, NOW + 10), refreshable: false });
    const { impl, calls } = makeFetch(() => jsonRes({}));
    const { client } = mkClient({ storage, fetchImpl: impl });
    await expect(client.refresh()).rejects.toThrowError(/non-refreshable/i);
    expect(calls).toHaveLength(0);
  });

  it("re-checks refreshable=false on the token re-loaded under the lock", async () => {
    const tokA = stored(jwt, NOW + 60);
    const tokB: StoredToken = { ...stored(jwt, NOW + 60), refreshable: false };
    const loads: Array<StoredToken | null> = [tokA, tokB];
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => loads.shift() ?? tokB,
      save: () => undefined,
      clear: () => undefined,
    };
    const { impl, calls } = makeFetch(() => jsonRes({}, 500));
    const { client } = mkClient({
      storage,
      fetchImpl: impl,
      security: { warnOnBrowserReadableRefresh: false },
    });
    await expect(client.refresh()).rejects.toThrowError(/non-refreshable/i);
    expect(calls).toHaveLength(0);
  });

  it("short-circuits when a peer tab already rotated (re-load under lock)", async () => {
    const expiringA = stored(jwt, NOW + 60);
    const freshB: StoredToken = {
      ...stored(makeJwt({ jti: "peer", exp: NOW + 7200 }), NOW + 7200),
    };
    const loads: Array<StoredToken | null> = [expiringA, freshB];
    const saved: StoredToken[] = [];
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => loads.shift() ?? freshB,
      save: (t) => {
        saved.push(t);
      },
      clear: () => undefined,
    };
    const { impl, calls } = makeFetch(() => jsonRes({}, 500));
    const { client } = mkClient({
      storage,
      fetchImpl: impl,
      security: { warnOnBrowserReadableRefresh: false },
    });

    const t = await client.refresh();
    expect(t.sessionVersion).toBe(freshB.sessionVersion);
    expect(calls).toHaveLength(0); // no POST /token at all
    expect(saved).toHaveLength(0);
  });

  it("throws NotAuthenticatedError when refreshing with empty storage", async () => {
    const { client } = mkClient({ storage: new MemoryStorage() });
    await expect(client.refresh()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});

// ---------------------------------------------------------------------------
// fetch wrapper: Bearer decoration + gated single 401 retry
// ---------------------------------------------------------------------------

describe("auth.fetch", () => {
  const jwt = makeJwt({ sub: "jane", jti: "j8", exp: NOW + 3600 });
  const API = "https://api.test/api/freva-nextgen/databrowser/data-search";

  it("attaches Authorization from the stored token", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    const { impl, calls } = makeFetch(() => jsonRes({ ok: true }));
    const { client } = mkClient({ storage, fetchImpl: impl });

    const res = await client.fetch(API);
    expect(res.status).toBe(200);
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe(`Bearer ${jwt}`);
  });

  it("respects a caller-provided Authorization header", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    const { impl, calls } = makeFetch(() => jsonRes({}));
    const { client } = mkClient({ storage, fetchImpl: impl });
    await client.fetch(API, { headers: { Authorization: "Basic abc" } });
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Basic abc");
  });

  it("passes a permission 401 through untouched when the token is fresh", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600)); // fresh: outside buffer
    const { impl, calls } = makeFetch(() => jsonRes({ detail: "no" }, 401));
    const { client } = mkClient({ storage, fetchImpl: impl });

    const res = await client.fetch(API);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1); // no refresh attempt, no retry
  });

  it("retries exactly once on 401 + WWW-Authenticate invalid_token", async () => {
    const fresh = makeJwt({ sub: "jane", jti: "j9", exp: NOW + 7200 });
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    let apiHits = 0;
    const { impl, calls } = makeFetch((url) => {
      if (url.startsWith(`${BASE}/token`)) {
        return jsonRes(tokenResponse(fresh, NOW + 7200));
      }
      apiHits += 1;
      return apiHits === 1
        ? jsonRes({}, 401, {
            "WWW-Authenticate": 'Bearer error="invalid_token"',
          })
        : jsonRes({ ok: true });
    });
    const { client } = mkClient({ storage, fetchImpl: impl });

    const res = await client.fetch(API);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([API, `${BASE}/token`, API]);
    expect(new Headers(calls[2]!.init?.headers).get("Authorization")).toBe(`Bearer ${fresh}`);
  });

  it("retries when the token is locally expired even without WWW-Authenticate", async () => {
    const fresh = makeJwt({ sub: "jane", jti: "j10", exp: NOW + 7200 });
    const storage = new MemoryStorage();
    // Expired token; getToken(auto) will already refresh before the request.
    await storage.save(stored(jwt, NOW - 10));
    const { impl, calls } = makeFetch((url) => {
      if (url.startsWith(`${BASE}/token`)) {
        return jsonRes(tokenResponse(fresh, NOW + 7200));
      }
      return jsonRes({ ok: true });
    });
    const { client } = mkClient({ storage, fetchImpl: impl });
    const res = await client.fetch(API);
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(`${BASE}/token`); // pre-flight refresh
    expect(calls[1]!.url).toBe(API);
  });

  it("retryOn401:false passes the 401 through even when eligible", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    const { impl, calls } = makeFetch(() =>
      jsonRes({}, 401, { "WWW-Authenticate": 'Bearer error="invalid_token"' }),
    );
    const { client } = mkClient({ storage, fetchImpl: impl });
    const res = await client.fetch(API, {}, { retryOn401: false });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("requireAuth:false sends unauthenticated when signed out", async () => {
    const { impl, calls } = makeFetch(() => jsonRes({ public: true }));
    const { client } = mkClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
    });
    const res = await client.fetch(API, {}, { requireAuth: false });
    expect(res.status).toBe(200);
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBeNull();
  });

  it("default requireAuth throws NotAuthenticatedError when signed out", async () => {
    const { impl } = makeFetch(() => jsonRes({}));
    const { client } = mkClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
    });
    await expect(client.fetch(API)).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it("userinfo returns the parsed profile", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    const { impl } = makeFetch((url) =>
      url.endsWith("/userinfo") ? jsonRes({ preferred_username: "jane" }) : jsonRes({}, 404),
    );
    const { client } = mkClient({ storage, fetchImpl: impl });
    await expect(client.userinfo()).resolves.toEqual({
      preferred_username: "jane",
    });
  });
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe("logout", () => {
  const jwt = makeJwt({ sub: "jane", jti: "j11", exp: NOW + 3600 });

  it("clears storage, emits, and navigates to the server logout", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    const { impl } = makeFetch(() => jsonRes({}));
    const { client, events, navigated } = mkClient({
      storage,
      fetchImpl: impl,
      postLogoutRedirectUri: "http://app.test/bye",
    });

    await client.logout();
    expect(await Promise.resolve(storage.load())).toBeNull();
    expect(events).toContainEqual(expect.objectContaining({ type: "logout", localOnly: false }));
    expect(navigated).toHaveLength(1);
    const u = new URL(navigated[0]!);
    expect(u.pathname.endsWith("/logout")).toBe(true);
    expect(u.searchParams.get("post_logout_redirect_uri")).toBe("http://app.test/bye");
  });

  it("localOnly skips navigation", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    const { impl } = makeFetch(() => jsonRes({}));
    const { client, navigated } = mkClient({ storage, fetchImpl: impl });
    await client.logout({ localOnly: true });
    expect(navigated).toHaveLength(0);
    expect(await Promise.resolve(storage.load())).toBeNull();
  });

  it("an unshipped /revoke (404) fails the logout unless acknowledged", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    const { impl, calls } = makeFetch((url) =>
      url.endsWith("/revoke") ? jsonRes({}, 404) : jsonRes({}),
    );
    const { client } = mkClient({ storage, fetchImpl: impl });

    await expect(client.logout({ localOnly: true })).rejects.toThrow(/revocation failed/i);
    const revoke = calls.find((c) => c.url.endsWith("/revoke"))!;
    expect(revoke).toBeDefined();
    expect(revoke.init?.method).toBe("POST");
    expect(new Headers(revoke.init?.headers).get("Authorization")).toBe(`Bearer ${jwt}`);
  });
});

// ---------------------------------------------------------------------------
// server-managed transports through the client
// ---------------------------------------------------------------------------

describe("server-managed transports", () => {
  it("bff: fetch is credentialed and bare; tokens never enter JS", async () => {
    const storage = bffStorage();
    const { impl, calls } = makeFetch(() => jsonRes({ ok: true }));
    const { client } = mkClient({
      storage,
      fetchImpl: impl,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });

    await expect(client.getToken()).resolves.toBeNull();
    await expect(client.refresh()).rejects.toThrowError(/bff/i);

    const res = await client.fetch("http://app.test/api/proxied");
    expect(res.status).toBe(200);
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBeNull();
  });

  it("bff: userinfo() refuses the guaranteed-broken default endpoint", async () => {
    const { client } = mkClient({
      storage: bffStorage(),
    });
    await expect(client.userinfo()).rejects.toThrowError(/userinfoEndpoint/);
  });

  it("bff: userinfo() with userinfoEndpoint goes credentialed and bare", async () => {
    const ME = "http://app.test/api/me";
    const { impl, calls } = makeFetch((url) =>
      url === ME ? jsonRes({ preferred_username: "jane" }) : jsonRes({}, 404),
    );
    const { client } = mkClient({
      storage: bffStorage(),
      fetchImpl: impl,
      userinfoEndpoint: ME,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    await expect(client.userinfo()).resolves.toEqual({
      preferred_username: "jane",
    });
    expect(calls[0]!.url).toBe(ME);
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBeNull();
  });

  it("bearer-from-endpoint: client.refresh() health-pings, drops the cache, re-pulls", async () => {
    const rnow = Math.floor(Date.now() / 1000); // storage uses the real clock
    const jwt = makeJwt({ sub: "jane", jti: "sm1", exp: rnow + 600 });
    const endpoint = "http://app.test/api/auth/access-token";
    const health = "http://app.test/api/token-health/";

    const storageFetch = makeFetch(() => jsonRes(accessOnlyResponse(jwt, rnow + 600)));
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: endpoint,
      acknowledgeNoCsrf: true,
      healthUrl: health,
      fetchImpl: storageFetch.impl,
    });
    const clientFetch = makeFetch(() => jsonRes({ status: "ok" }));
    const { client, events } = mkClient({
      storage,
      fetchImpl: clientFetch.impl,
      now: undefined,
    });

    const t = await client.refresh();
    expect(t.accessToken).toBe(jwt);
    expect(clientFetch.calls.map((c) => c.url)).toEqual([health]);
    expect(clientFetch.calls[0]!.init?.credentials).toBe("include");
    expect(storageFetch.calls).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "token-refreshed", source: "self" }),
    );

    // The freshly pulled token is cached: no second endpoint hit.
    await client.getToken({ refresh: "never" });
    expect(storageFetch.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// diagnose()
// ---------------------------------------------------------------------------

describe("diagnose", () => {
  it("reports green for memory storage + reachable broker JWKS", async () => {
    const { impl } = makeFetch((url) =>
      url.endsWith("/.well-known/jwks.json") ? jsonRes({ keys: [] }) : jsonRes({}, 404),
    );
    const { client, events } = mkCleanClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
    });
    const report = await client.diagnose();
    expect(report.ok).toBe(true);
    expect(report.storageKind).toBe("memory");
    expect(report.checks.map((c) => c.name)).toEqual([
      "config",
      "resource-origins",
      "broker-jwks",
      "storage",
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "diagnose" }));
  });

  it("flags an unreachable API with a hint instead of refusing", async () => {
    const { impl } = makeFetch(() => {
      throw new TypeError("network down");
    });
    const { client } = mkCleanClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
    });
    const report = await client.diagnose();
    const jwks = report.checks.find((c) => c.name === "broker-jwks")!;
    expect(jwks.ok).toBe(false);
    expect(jwks.hint).toMatch(/CORS|reachable/i);
    // Non-fatal by design (SPEC 7): passthrough servers have no broker JWKS,
    // so this must not permanently redden every report on such a deployment.
    expect(jwks.severity).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("probeConnectivity() treats a 401 from the health endpoint as reachable", async () => {
    const health = "http://app.test/api/token-health/";
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenEndpoint: "http://app.test/api/auth/access-token",
      acknowledgeNoCsrf: true,
      healthUrl: health,
      fetchImpl: makeFetch(() => jsonRes({}, 401)).impl,
    });
    const { impl } = makeFetch((url) =>
      url === health ? jsonRes({}, 401) : jsonRes({ keys: [] }),
    );
    const { client } = mkClient({ storage, fetchImpl: impl });
    // diagnose() is passive and must NOT touch the network.
    const report = await client.diagnose();
    expect(report.checks.find((c) => c.name === "storage")!.detail).toMatch(/not probed/);
    // The explicit opt-in does probe, credentialed and bounded.
    const probe = await client.probeConnectivity();
    expect(probe.ok).toBe(true);
    expect(probe.detail).toMatch(/401.*session absent/);
  });

  it("bff with no endpoint is OK with a proxy hint; bearer without one is not", async () => {
    const { impl } = makeFetch(() => jsonRes({ keys: [] }));

    const bff = mkClient({
      storage: bffStorage(),
      fetchImpl: impl,
    });
    const bffReport = await bff.client.diagnose();
    const bffCheck = bffReport.checks.find((c) => c.name === "storage")!;
    expect(bffCheck.ok).toBe(true);
    expect(bffCheck.hint).toMatch(/prox/i);

    const bearer = mkClient({
      storage: new ServerManagedStorage({ transport: "bearer-from-endpoint" }),
      fetchImpl: impl,
    });
    const bearerReport = await bearer.client.diagnose();
    const bearerCheck = bearerReport.checks.find((c) => c.name === "storage")!;
    expect(bearerCheck.ok).toBe(false);
    expect(bearerCheck.hint).toMatch(/tokenEndpoint|healthUrl/);
  });

  it("recognizes a tokenProvider-backed server-managed setup as configured", async () => {
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      tokenProvider: () => null,
    });
    const { impl } = makeFetch(() => jsonRes({ keys: [] }));
    const { client } = mkCleanClient({ storage, fetchImpl: impl });
    const report = await client.diagnose();
    const st = report.checks.find((c) => c.name === "storage")!;
    expect(st.ok).toBe(true);
    expect(st.detail).toMatch(/tokenProvider/);
    expect(report.ok).toBe(true);
  });

  it("cookie probe runs with the ACTUAL attributes: Secure on http fails loudly", async () => {
    const { impl } = makeFetch(() => jsonRes({ keys: [] }));
    const { client } = mkClient({
      storage: new CookieStorage({
        secure: true,
        allowInsecureTransport: true,
        acknowledgeInsecureCookie: true,
        acknowledgeBrokerSingleTokenContract: true,
      }), // http origin in tests
      fetchImpl: impl,
      security: { warnOnBrowserReadableRefresh: false },
    });
    const report = await client.diagnose();
    const st = report.checks.find((c) => c.name === "storage")!;
    expect(st.ok).toBe(false);
    expect(st.hint).toMatch(/Secure/);
    expect(report.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cross-tab integration (deterministic fake BroadcastChannel)
// ---------------------------------------------------------------------------

describe("cross-tab", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installFakeBroadcastChannel();
  });
  afterEach(() => restore());

  function sharedStorage() {
    const box: { token: StoredToken | null } = { token: null };
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
    return { box, make };
  }

  it("logout in one tab clears and notifies the peer", async () => {
    const { box, make } = sharedStorage();
    const jwt = makeJwt({ sub: "jane", jti: "x1", exp: NOW + 3600 });
    box.token = stored(jwt, NOW + 3600);

    const { impl } = makeFetch(() => jsonRes({}));
    const a = mkClient({
      storage: make(),
      fetchImpl: impl,
      crossTab: true,
      useNavigatorLocks: false,
      security: { warnOnBrowserReadableRefresh: false },
    });
    const b = mkClient({
      storage: make(),
      fetchImpl: impl,
      crossTab: true,
      useNavigatorLocks: false,
      security: { warnOnBrowserReadableRefresh: false },
    });

    await a.client.logout({ localOnly: true });
    await flush();

    expect(box.token).toBeNull();
    expect(b.events).toContainEqual(expect.objectContaining({ type: "logout", localOnly: true }));
  });

  it("a refresh in one tab surfaces as token-refreshed(source: tab) in the peer", async () => {
    const { box, make } = sharedStorage();
    const oldJwt = makeJwt({ sub: "jane", jti: "x2", exp: NOW + 60 });
    const newJwt = makeJwt({ sub: "jane", jti: "x3", exp: NOW + 7200 });
    box.token = stored(oldJwt, NOW + 60);

    const { impl } = makeFetch(() => jsonRes(tokenResponse(newJwt, NOW + 7200)));
    const a = mkClient({
      storage: make(),
      fetchImpl: impl,
      crossTab: true,
      useNavigatorLocks: false,
      security: { warnOnBrowserReadableRefresh: false },
    });
    const b = mkClient({
      storage: make(),
      crossTab: true,
      useNavigatorLocks: false,
      security: { warnOnBrowserReadableRefresh: false },
    });

    await a.client.refresh();
    await flush();

    const peerEvent = b.events.find((e) => e.type === "token-refreshed") as
      | { source: string; token: Record<string, unknown> }
      | undefined;
    expect(peerEvent?.source).toBe("tab");
    // Redacted: the peer learns the session rotated, not what the token is.
    expect(peerEvent?.token.sessionVersion).toBe(box.token!.sessionVersion);
    expect(peerEvent?.token).not.toHaveProperty("accessToken");
    expect(JSON.stringify(peerEvent)).not.toContain(newJwt);
  });
});

// ---------------------------------------------------------------------------
// Security tranche - one describe per invariant
// ---------------------------------------------------------------------------

describe("resource-origin policy (credential escape)", () => {
  const jwt = makeJwt({ jti: "o1", exp: NOW + 3600 });
  const evil = "https://attacker.example/collect";

  async function withToken() {
    const storage = new MemoryStorage();
    await storage.save(stored(jwt, NOW + 3600));
    return storage;
  }

  it("refuses to attach the credential to an unlisted origin", async () => {
    const { impl, calls } = makeFetch(() => jsonRes({}));
    const { client } = mkClient({ storage: await withToken(), fetchImpl: impl });
    await expect(client.fetch(evil)).rejects.toBeInstanceOf(OriginNotAllowedError);
    expect(calls).toHaveLength(0); // nothing left the browser at all
  });

  it("allows the authBaseUrl origin by default", async () => {
    const { impl, calls } = makeFetch(() => jsonRes({ ok: true }));
    const { client } = mkClient({ storage: await withToken(), fetchImpl: impl });
    await client.fetch(`https://api.test/data`);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe(`Bearer ${jwt}`);
  });

  it("allows the page's own origin, but only over a secure transport", async () => {
    // The suite deliberately runs on http://app.test, so the page origin is
    // auto-allowed by identity yet still refused by the transport rule.
    const { impl, calls } = makeFetch(() => jsonRes({ ok: true }));
    const storage = await withToken();
    const strict = mkClient({
      storage,
      fetchImpl: impl,
      authBaseUrl: BASE,
      redirectUri: "https://app.example/cb",
      security: { allowInsecureTransport: false, allowedRedirectUris: ["https://app.example/cb"] },
    });
    expect(strict.client.allowedResourceOrigins).toContain("http://app.test");
    await expect(strict.client.fetch("/relative/path")).rejects.toThrow(/plaintext http/i);

    const relaxed = mkClient({
      storage,
      fetchImpl: impl,
      security: { allowInsecureTransport: true },
    });
    await relaxed.client.fetch("/relative/path");
    expect(calls).toHaveLength(1);
  });

  it("accepts an explicitly allow-listed extra origin", async () => {
    const { impl, calls } = makeFetch(() => jsonRes({ ok: true }));
    const { client } = mkClient({
      storage: await withToken(),
      fetchImpl: impl,
      security: { allowedResourceOrigins: ["https://other-api.test"] },
    });
    await client.fetch("https://other-api.test/x");
    expect(calls).toHaveLength(1);
    expect(client.allowedResourceOrigins).toContain("https://other-api.test");
  });

  it("refuses plaintext http targets outside loopback", async () => {
    const { impl } = makeFetch(() => jsonRes({}));
    const { client } = mkClient({
      storage: await withToken(),
      fetchImpl: impl,
      // Even when the integrator names it, http cannot carry this credential.
      redirectUri: "https://app.example/cb",
      security: {
        allowInsecureTransport: false,
        allowedRedirectUris: ["https://app.example/cb"],
        allowedResourceOrigins: ["https://plain.test"],
      },
    });
    await expect(client.fetch("http://plain.test/x")).rejects.toThrow(/plaintext http/i);
  });

  it("rejects an unusable allowedResourceOrigins entry at construction", () => {
    expect(() =>
      mkClient({
        storage: new MemoryStorage(),
        security: { allowedResourceOrigins: ["not-a-url"] },
      }),
    ).toThrow(/allowedResourceOrigins/);
  });

  it("buildRequest applies the same policy", async () => {
    const { client } = mkClient({ storage: await withToken() });
    await expect(client.buildRequest(evil)).rejects.toBeInstanceOf(OriginNotAllowedError);
    const req = await client.buildRequest("https://api.test/data");
    expect(req.headers.get("Authorization")).toBe(`Bearer ${jwt}`);
    expect(req.url).toBe("https://api.test/data"); // bound to the destination
  });
});

describe("terminal 401 must not destroy a peer's rotated session", () => {
  it("adopts the peer token instead of clearing when storage moved on", async () => {
    const mine = stored(makeJwt({ jti: "loser", exp: NOW + 60 }), NOW + 60);
    const peer = stored(makeJwt({ jti: "winner", exp: NOW + 7200 }), NOW + 7200);
    // load #1 = pre-lock, #2 = under lock, #3 = the post-401 re-read
    const loads: StoredToken[] = [mine, mine, peer];
    const cleared: string[] = [];
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => loads.shift() ?? peer,
      save: () => undefined,
      clear: (r) => {
        cleared.push(String(r));
      },
    };
    const { impl } = makeFetch(() => jsonRes({ detail: "invalid" }, 401));
    const { client, events } = mkClient({
      storage,
      fetchImpl: impl,
      security: { warnOnBrowserReadableRefresh: false },
    });

    const token = await client.refresh({ force: true });
    expect(token.sessionVersion).toBe(peer.sessionVersion);
    expect(cleared).toEqual([]); // the winner's session survives
    expect(events.some((e) => e.type === "session-expired")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "token-refreshed", source: "tab" }),
    );
  });

  it("still clears when storage holds the very credential that was rejected", async () => {
    const mine = stored(makeJwt({ jti: "only", exp: NOW + 60 }), NOW + 60);
    const cleared: string[] = [];
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => mine,
      save: () => undefined,
      clear: (r) => {
        cleared.push(String(r));
      },
    };
    const { impl } = makeFetch(() => jsonRes({}, 401));
    const { client, events } = mkClient({
      storage,
      fetchImpl: impl,
      security: { warnOnBrowserReadableRefresh: false },
    });
    await expect(client.refresh({ force: true })).rejects.toBeInstanceOf(SessionExpiredError);
    expect(cleared).toEqual(["refresh-token-rejected"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "session-expired" }));
  });
});

describe("a rotated credential is never dropped silently", () => {
  it("reports storage-write-failed and keeps the session on a memory mirror", async () => {
    const old = stored(makeJwt({ jti: "s1", exp: NOW + 60 }), NOW + 60);
    const fresh = makeJwt({ jti: "s2", exp: NOW + 7200 });
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => old,
      save: () => {
        throw new Error("cookie write refused");
      },
      clear: () => undefined,
    };
    const { impl } = makeFetch(() => jsonRes(tokenResponse(fresh, NOW + 7200)));
    const { client, events } = mkClient({
      storage,
      fetchImpl: impl,
      security: { warnOnBrowserReadableRefresh: false },
    });

    // The old jti is already dead server-side, so refresh must still succeed.
    const token = await client.refresh({ force: true });
    expect(token.accessToken).toBe(fresh);
    expect(client.isStorageDegraded()).toBe(true);

    const failure = events.find((e) => e.type === "storage-write-failed") as
      | { reasonCode: string; degradedToMemory: boolean; token: Record<string, unknown> }
      | undefined;
    expect(failure).toBeDefined();
    expect(failure!.reasonCode).toBe("storage-threw");
    // The storage's own message must NOT be copied through.
    expect(JSON.stringify(failure)).not.toContain("cookie write refused");
    expect(failure!.degradedToMemory).toBe(true);
    expect(failure!.token).not.toHaveProperty("accessToken");

    // The mirror wins over the stale value still sitting in storage.
    expect((await client.getToken({ refresh: "never" }))?.accessToken).toBe(fresh);
    const report = await client.diagnose();
    expect(report.checks.some((c) => c.name === "storage-degraded")).toBe(true);
  });
});

describe("forced refresh never joins a non-forced one", () => {
  it("chains instead of returning the unforced result", async () => {
    const first = makeJwt({ jti: "f1", exp: NOW + 7200 });
    const second = makeJwt({ jti: "f2", exp: NOW + 9000 });
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "f0", exp: NOW + 60 }), NOW + 60));

    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { impl } = makeFetch(async (url) => {
      if (!url.startsWith(`${BASE}/token`)) return jsonRes({});
      posts += 1;
      if (posts === 1) {
        await gate;
        return jsonRes(tokenResponse(first, NOW + 7200));
      }
      return jsonRes(tokenResponse(second, NOW + 9000));
    });
    const { client } = mkClient({ storage, fetchImpl: impl });

    const unforced = client.refresh();
    const forced = client.refresh({ force: true });
    release();
    const [a, b] = await Promise.all([unforced, forced]);

    // The queued-behind refresh DID rotate, so the forced caller adopts its
    // brand-new credential. Rotating again would immediately invalidate the
    // token the first caller is still holding and burn a server rotation.
    expect(posts).toBe(1);
    expect(a.accessToken).toBe(first);
    expect(b.accessToken).toBe(first);
    expect(second).toBeTruthy();
  });

  it("does its own round trip when the prior refresh did NOT rotate", async () => {
    // The original bug: a force joining a non-force that short-circuits gets
    // handed back the very token the server just rejected.
    const fresh = makeJwt({ jti: "f9", exp: NOW + 7200 });
    const storage = new MemoryStorage();
    const current = stored(makeJwt({ jti: "f8", exp: NOW + 9999 }), NOW + 9999);
    await storage.save(current); // not expiring: an unforced refresh no-ops
    let posts = 0;
    const { impl } = makeFetch((url) => {
      if (!url.startsWith(`${BASE}/token`)) return jsonRes({});
      posts += 1;
      return jsonRes(tokenResponse(fresh, NOW + 7200));
    });
    const { client } = mkClient({ storage, fetchImpl: impl });
    const unforced = client.refresh();
    const forced = client.refresh({ force: true });
    const [a, b] = await Promise.all([unforced, forced]);
    expect(posts).toBe(1);
    expect(a.accessToken).toBe(current.accessToken); // short-circuited
    expect(b.accessToken).toBe(fresh); // forced caller really refreshed
  });

  it("still single-flights like-for-like callers", async () => {
    const fresh = makeJwt({ jti: "f3", exp: NOW + 7200 });
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "f4", exp: NOW + 60 }), NOW + 60));
    const { impl, calls } = makeFetch(() => jsonRes(tokenResponse(fresh, NOW + 7200)));
    const { client } = mkClient({ storage, fetchImpl: impl });
    await Promise.all([client.refresh({ force: true }), client.refresh({ force: true })]);
    expect(calls.filter((c) => c.url.startsWith(`${BASE}/token`))).toHaveLength(1);
  });
});

describe("login transaction binding (login-CSRF)", () => {
  const jwt = makeJwt({ jti: "t1", exp: NOW + 3600 });

  it("refuses a callback that no login in this tab started", async () => {
    const { impl, calls } = makeFetch(() => jsonRes(tokenResponse(jwt, NOW + 3600)));
    const { client } = mkClient(
      { storage: new MemoryStorage(), fetchImpl: impl },
      { seedLoginTxn: false },
    );
    await expect(
      client.handleCallback("http://app.test/cb?code=planted&state=x"),
    ).rejects.toBeInstanceOf(LoginTransactionError);
    expect(calls).toHaveLength(0); // the planted code is never exchanged
  });

  it("login() records the transaction that handleCallback then consumes", async () => {
    const { impl } = makeFetch(() => jsonRes(tokenResponse(jwt, NOW + 3600)));
    const { client } = mkClient(
      { storage: new MemoryStorage(), fetchImpl: impl },
      { seedLoginTxn: false },
    );
    client.login({ next: "/back" });
    expect(sessionStorage.getItem(`${client.channelName}:txn`)).toBeTruthy();

    await expect(client.handleCallback("http://app.test/cb?code=a&state=b")).resolves.toMatchObject(
      { accessToken: jwt },
    );
    // One-time use: a replayed callback no longer has a transaction.
    expect(sessionStorage.getItem(`${client.channelName}:txn`)).toBeNull();
    await expect(client.handleCallback("http://app.test/cb?code=a&state=b")).rejects.toBeInstanceOf(
      LoginTransactionError,
    );
  });

  it("rejects a stale transaction", async () => {
    const { impl } = makeFetch(() => jsonRes(tokenResponse(jwt, NOW + 3600)));
    const { client } = mkClient(
      { storage: new MemoryStorage(), fetchImpl: impl },
      { seedLoginTxn: false },
    );
    sessionStorage.setItem(
      `${client.channelName}:txn`,
      JSON.stringify({ id: "old", at: NOW - 601 }),
    );
    await expect(client.handleCallback("http://app.test/cb?code=a&state=b")).rejects.toThrow(
      /expired/i,
    );
  });

  it("can be opted out of for genuinely IDP-initiated flows", async () => {
    const { impl } = makeFetch(() => jsonRes(tokenResponse(jwt, NOW + 3600)));
    const { client } = mkClient(
      {
        storage: new MemoryStorage(),
        fetchImpl: impl,
        security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
      },
      { seedLoginTxn: false },
    );
    await expect(client.handleCallback("http://app.test/cb?code=a&state=b")).resolves.toMatchObject(
      { accessToken: jwt },
    );
  });
});

describe("events carry no credential", () => {
  it("login-completed and token-refreshed are redacted summaries", async () => {
    const jwt = makeJwt({ jti: "r1", exp: NOW + 3600 });
    const storage = new MemoryStorage();
    const { impl } = makeFetch(() => jsonRes(tokenResponse(jwt, NOW + 3600)));
    const { client, events } = mkClient({ storage, fetchImpl: impl });
    await client.handleCallback("http://app.test/cb?code=a&state=b");

    const done = events.find((e) => e.type === "login-completed")!;
    expect(JSON.stringify(events)).not.toContain(jwt);
    const summary = (done as unknown as { token: Record<string, unknown> }).token;
    expect(summary).toMatchObject({
      tokenType: "Bearer",
      expiresAt: NOW + 3600,
    });
    expect(summary).not.toHaveProperty("accessToken");
    expect(summary).not.toHaveProperty("refreshToken");
  });

  it("flags a Bearer that is also a refresh credential", async () => {
    const jwt = makeJwt({ jti: "r2", exp: NOW + 3600 });
    const { impl } = makeFetch(() => jsonRes(tokenResponse(jwt, NOW + 3600)));
    const { client, events } = mkClient({
      storage: new MemoryStorage(),
      fetchImpl: impl,
    });
    const token = await client.handleCallback("http://app.test/cb?code=a&state=b");
    expect(token.accessTokenIsRefreshCredential).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "security-warning",
        code: "refresh-capable-bearer",
      }),
    );
    const report = await client.diagnose();
    const check = report.checks.find((c) => c.name === "refresh-capable-bearer")!;
    expect(check).toBeDefined();
    expect(check.severity).toBe("warn"); // server-side fix, not a client fault
  });
});

describe("bff CSRF and backend logout", () => {
  const API = "http://app.test/api/proxied";
  const allow = { allowedResourceOrigins: ["http://app.test"] };

  it("attaches the configured CSRF header to credentialed calls", async () => {
    const storage = new ServerManagedStorage({
      transport: "bff",
      csrf: { headerName: "X-CSRFToken", token: () => "tok-123" },
    });
    const { impl, calls } = makeFetch(() => jsonRes({ ok: true }));
    const { client } = mkClient({ storage, fetchImpl: impl, security: allow });
    await client.fetch(API);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("X-CSRFToken")).toBe("tok-123");
    expect(headers.get("Authorization")).toBeNull();
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("warns when bff runs without a library-managed CSRF strategy", () => {
    const { events } = mkClient({ storage: bffStorage(), security: allow });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "security-warning",
        code: "bff-without-csrf",
      }),
    );
  });

  it("kills the backend session before bouncing to the IDP", async () => {
    const LOGOUT = "http://app.test/api/logout";
    const storage = new ServerManagedStorage({
      transport: "bff",
      logoutEndpoint: LOGOUT,
      csrf: { headerName: "X-CSRFToken", token: "tok-9" },
    });
    const { impl, calls } = makeFetch(() => jsonRes({ ok: true }));
    const { client, navigated } = mkClient({
      storage,
      fetchImpl: impl,
      security: allow,
    });
    await client.logout();
    const call = calls.find((c) => c.url === LOGOUT)!;
    expect(call.init?.method).toBe("POST");
    expect(call.init?.credentials).toBe("include");
    expect(new Headers(call.init?.headers).get("X-CSRFToken")).toBe("tok-9");
    expect(navigated).toHaveLength(1); // IDP logout only after the backend one
  });

  it("reports a failed backend logout instead of pretending it worked", async () => {
    const LOGOUT = "http://app.test/api/logout";
    const storage = new ServerManagedStorage({
      transport: "bff",
      logoutEndpoint: LOGOUT,
      acknowledgeNoCsrf: true,
    });
    const { impl } = makeFetch((url) =>
      url === LOGOUT ? jsonRes({ detail: "boom" }, 500) : jsonRes({}),
    );
    const { client, navigated, events } = mkClient({
      storage,
      fetchImpl: impl,
      security: allow,
    });
    await expect(client.logout()).rejects.toThrow(/server-side session may still be alive/i);
    // Local state is still cleared, and we do NOT redirect as if all was well.
    expect(navigated).toHaveLength(0);
    // Event ordering: the completion event fires only after the backend
    // logout succeeds, so a caller can never be told the session is gone
    // while it is still alive.
    expect(events.some((e) => e.type === "logout")).toBe(false);
  });
});
