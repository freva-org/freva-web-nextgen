/**
 * The destination that was validated is the destination that gets sent, and no
 * credential or provider string ever reaches telemetry.
 *
 * Each name states the behaviour that must not come back.
 */
import { describe, expect, it } from "vitest";
import {
  AuthError,
  MemoryStorage,
  NotAuthenticatedError,
  OriginNotAllowedError,
  PyOidcAuthClient,
  ServerManagedStorage,
  StorageContractError,
  type AuthConfig,
  type AuthEvent,
  type TokenStorage,
} from "../src/index.js";
import { CookieStorage } from "../src/unsafe-compat.js";
import { fetchView, installFakeBroadcastChannel, jsonRes, makeJwt, stored } from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
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

describe("1. the validated destination is the destination that is sent", () => {
  it("a URL mutated during token loading cannot redirect the credential", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "r1", exp: NOW + 3600 }), NOW + 3600));
    const seen: string[] = [];
    const impl = (async (i: RequestInfo | URL) => {
      seen.push(fetchView(i).url);
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    const u = new URL("https://api.test/data");
    const p = c.fetch(u);
    u.hostname = "evil.example"; // mutate while the token loads
    await p;
    expect(seen).toEqual(["https://api.test/data"]);
    expect(seen.join()).not.toContain("evil.example");
    c.destroy();
  });

  it("buildRequest returns a destination-bound Request", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "r1b", exp: NOW + 3600 }), NOW + 3600));
    const { c } = mk({ storage });
    const req = await c.buildRequest("https://api.test/data");
    expect(req).toBeInstanceOf(Request);
    expect(req.url).toBe("https://api.test/data");
    expect(req.headers.get("Authorization")).toContain("Bearer ");
    await expect(c.buildRequest("https://evil.example/x")).rejects.toBeInstanceOf(
      OriginNotAllowedError,
    );
    c.destroy();
  });

  it("rejects control characters in a fetch destination", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "r1c", exp: NOW + 3600 }), NOW + 3600));
    const { c } = mk({ storage });
    await expect(c.fetch(`https://api.test/${TAB}evil`)).rejects.toThrow(/resolve/i);
    c.destroy();
  });

  it("freezes the exposed origin policy", () => {
    const { c } = mk({ storage: new MemoryStorage() });
    expect(Object.isFrozen(c.allowedResourceOrigins)).toBe(true);
    c.destroy();
  });
});

describe("2. return paths are canonicalized, not string-checked", () => {
  const hostile: Array<[string, string]> = [
    ["tab", `/${TAB}/evil.example/x`],
    ["newline", `/${LF}/evil.example`],
    ["backslash", "/" + String.fromCharCode(92) + "evil.example"],
    ["protocol-relative", "//evil.example"],
    ["space", "/ /evil.example"],
    ["overlong", "/" + "x".repeat(4000)],
  ];
  for (const [label, bad] of hostile) {
    it(`rejects a ${label} return path`, () => {
      const { c } = mk({ storage: new MemoryStorage() });
      expect(() => c.login({ next: bad })).toThrow(/relative path/i);
      c.destroy();
    });
  }

  it("accepts and canonicalizes a safe path with query and hash", () => {
    const { c } = mk({ storage: new MemoryStorage() });
    c.login({ next: "/plots/42?x=1#top" });
    expect(sessionStorage.getItem(`${c.channelName}:next`)).toBe("/plots/42?x=1#top");
    expect(c.consumeReturnPath()).toBe("/plots/42?x=1#top");
    c.destroy();
  });

  it("revalidates a tampered sessionStorage value identically", () => {
    const { c } = mk({ storage: new MemoryStorage() });
    sessionStorage.setItem(`${c.channelName}:next`, `/${TAB}/evil.example/x`);
    expect(c.consumeReturnPath()).toBeNull();
    c.destroy();
  });
});

describe("3. storage contracts fail closed", () => {
  it("a contract rejection is rethrown, not degraded to memory", async () => {
    const storage = new CookieStorage({ name: "fc", ...COOKIE_OK });
    const impl = (async () =>
      jsonRes({
        access_token: "a.b.c",
        token_type: "Bearer",
        expires: NOW + 7200, // access-only
      })) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
    const err = await c.handleCallback("http://app.test/cb?code=a&state=s").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StorageContractError);
    expect(c.isStorageDegraded()).toBe(false); // NOT retained in memory
    c.destroy();
  });

  it("server-managed topologies refuse the browser-visible code flow", async () => {
    const storages = [
      new ServerManagedStorage({
        transport: "bff",
        acknowledgeNoCsrf: true,
        logoutEndpoint: "http://app.test/lo",
      }),
      new ServerManagedStorage({
        transport: "bearer-from-endpoint",
        acknowledgeNoCsrf: true,
        tokenProvider: () => null,
      }),
    ];
    for (const storage of storages) {
      const { c } = mk({ storage, security: { allowedResourceOrigins: ["http://app.test"] } });
      expect(() => c.loginUrl()).toThrow(/not available in/);
      expect(() => c.login()).toThrow(/not available in/);
      await expect(c.handleCallback("http://app.test/cb?code=a&state=s")).rejects.toThrow(
        /not available in/,
      );
      c.destroy();
    }
  });
});

describe("4. no credential or provider string reaches telemetry", () => {
  it("recursive sentinel sweep over every event and thrown error", async () => {
    const SENTINELS = ["SECRET-SCOPE", "/secret/path", "PROVIDER-DESCRIPTION"];
    const jwt = makeJwt({ jti: "s", exp: NOW + 3600 });
    const events: AuthEvent[] = [];
    const messages: string[] = [];
    const storage = new MemoryStorage();
    const impl = (async () =>
      jsonRes({
        access_token: jwt,
        refresh_token: jwt,
        token_type: "Bearer",
        expires: NOW + 3600,
        scope: "SECRET-SCOPE",
      })) as typeof fetch;
    const c = new PyOidcAuthClient({
      authBaseUrl: BASE,
      redirectUri: "http://app.test/cb",
      storage,
      crossTab: false,
      now: () => NOW,
      navigate: () => undefined,
      fetchImpl: impl,
      onEvent: (e) => events.push(e),
      security: {
        allowInsecureTransport: true,
        warnOnBrowserReadableRefresh: false,
        requireLoginTransaction: false,
        acknowledgeNoLoginTransaction: true,
      },
    });
    sessionStorage.setItem(`${c.channelName}:next`, "/secret/path");
    await c.handleCallback("http://app.test/cb?code=a&state=s");
    await c.diagnose().catch(() => undefined);
    await c
      .handleCallback("http://app.test/cb?error=denied&error_description=PROVIDER-DESCRIPTION")
      .catch((e: Error) => messages.push(e.message));

    const haystack =
      JSON.stringify(events) + String.fromCharCode(10) + messages.join(String.fromCharCode(10));
    for (const sentinel of SENTINELS) expect(haystack).not.toContain(sentinel);
    expect(haystack).not.toContain(jwt);
    c.destroy();
  });

  it("rejects an unsupported token_type instead of echoing it", async () => {
    const storage = new MemoryStorage();
    const impl = (async () =>
      jsonRes({
        access_token: "a.b.c",
        token_type: "SECRET-TOKEN-TYPE",
        expires: NOW + 3600,
      })) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
    const err = await c.handleCallback("http://app.test/cb?code=a&state=s").catch((e: Error) => e);
    expect((err as Error).message).not.toContain("SECRET-TOKEN-TYPE");
    expect((err as Error).message).toMatch(/Bearer/);
    c.destroy();
  });
});

describe("5. configuration is snapshotted and runtime-validated", () => {
  it("mutating the caller's options object changes nothing", async () => {
    const opts = {
      transport: "bearer-from-endpoint" as const,
      tokenEndpoint: "http://app.test/t",
      acknowledgeNoCsrf: true,
      fetchImpl: (async () =>
        jsonRes({
          access_token: "a.b.c",
          token_type: "Bearer",
          expires: NOW + 600,
        })) as typeof fetch,
    };
    const s = new ServerManagedStorage(opts);
    let sent = "";
    (opts as { tokenEndpoint: string }).tokenEndpoint = "https://evil.example/t";
    (opts as { fetchImpl: typeof fetch }).fetchImpl = (async (i: RequestInfo | URL) => {
      sent = String(i);
      return jsonRes({ access_token: "a.b.c", token_type: "Bearer", expires: NOW + 600 });
    }) as typeof fetch;
    await s.load();
    expect(sent).toBe(""); // the swapped impl was never used
    expect(s.tokenEndpoint).toContain("app.test");
    expect(s.tokenEndpoint).not.toContain("evil.example");
  });

  it("a string 'false' is never read as an acknowledgement", () => {
    expect(
      () =>
        new CookieStorage({
          name: "sf",
          allowInsecureTransport: "false" as unknown as boolean,
        }),
    ).toThrow(/must be a real boolean/);
    expect(
      () =>
        new ServerManagedStorage({
          transport: "bff",
          acknowledgeNoCsrf: "false" as unknown as boolean,
        }),
    ).toThrow(/must be a real boolean/);
  });

  it("rejects out-of-enum and non-finite runtime values", () => {
    expect(
      () =>
        new ServerManagedStorage({
          transport: "sneaky" as never,
          acknowledgeNoCsrf: true,
        }),
    ).toThrow(/transport/);
    expect(
      () =>
        new CookieStorage({
          name: "e1",
          sameSite: "Whatever" as never,
          ...COOKIE_OK,
        }),
    ).toThrow(/sameSite/);
    expect(
      () =>
        new CookieStorage({
          name: "e2",
          maxAgeSeconds: Number.POSITIVE_INFINITY,
          ...COOKIE_OK,
        }),
    ).toThrow(/maxAgeSeconds/);
  });
});

describe("6. every response-shaped callback is routed and scrubbed", () => {
  function client() {
    return mk({
      storage: new MemoryStorage(),
      // A structurally valid response proceeds to the exchange; make that
      // deterministic so the test is about routing and scrubbing.
      fetchImpl: (async () => jsonRes({ detail: "no" }, 500)) as typeof fetch,
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
  }
  const cases: Array<[string, string]> = [
    ["code-only", "code=SCRUB1"],
    ["state-only", "state=s"],
    ["extra unknown key", "code=SCRUB1&state=s&utm_source=x"],
    ["front-channel id_token", "id_token=SCRUB1"],
    ["front-channel access_token", "access_token=SCRUB1"],
  ];
  for (const [label, qs] of cases) {
    it(`routes and scrubs a ${label} response`, async () => {
      history.replaceState(null, "", `/cb?${qs}`);
      const { c } = client();
      expect(c.isCallbackUrl()).toBe(true);
      await expect(c.handleCallback()).rejects.toBeInstanceOf(AuthError);
      expect(location.href).not.toContain("SCRUB1");
      c.destroy();
    });
  }

  it("still refuses to rewrite an unrelated route", async () => {
    history.replaceState(null, "", "/elsewhere?code=KEEPME");
    const { c } = client();
    expect(c.isCallbackUrl()).toBe(false);
    await expect(c.handleCallback()).rejects.toThrow(/not on the allowlist/i);
    expect(location.href).toContain("KEEPME");
    c.destroy();
  });
});

describe("7. an inbound cross-tab message cannot make us mint", () => {
  function channel(name: string) {
    return new (
      globalThis as unknown as {
        BroadcastChannel: new (n: string) => BroadcastChannel;
      }
    ).BroadcastChannel(name);
  }

  it("token-updated never calls a token provider", async () => {
    const restore = installFakeBroadcastChannel();
    let provides = 0;
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      acknowledgeNoCsrf: true,
      tokenProvider: () => {
        provides += 1;
        return null;
      },
    });
    const { c } = mk({ storage, crossTab: true });
    channel(c.channelName).postMessage({
      type: "token-updated",
      tabId: "evil",
      sessionVersion: "abcd",
      exp: NOW + 999,
      at: Date.now(),
    });
    await flush();
    await flush();
    expect(provides).toBe(0);
    c.destroy();
    restore();
  });

  it("only emits when the locally read fingerprint matches the announcement", async () => {
    const restore = installFakeBroadcastChannel();
    const jwt = makeJwt({ jti: "peer", exp: NOW + 7200 });
    const box = { token: stored(jwt, NOW + 7200) };
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => box.token,
      save: () => undefined,
      clear: () => undefined,
    };
    const { c, events } = mk({ storage, crossTab: true });
    channel(c.channelName).postMessage({
      type: "token-updated",
      tabId: "evil",
      sessionVersion: "deadbeefdeadbeef",
      exp: 1,
      at: Date.now(),
    });
    await flush();
    await flush();
    expect(events.some((e) => e.type === "token-refreshed")).toBe(false);
    c.destroy();
    restore();
  });

  it("a throwing storage read does not become an unhandled rejection", async () => {
    const restore = installFakeBroadcastChannel();
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => {
        throw new Error("boom");
      },
      save: () => undefined,
      clear: () => undefined,
    };
    const { c } = mk({ storage, crossTab: true });
    channel(c.channelName).postMessage({
      type: "token-updated",
      tabId: "evil",
      sessionVersion: "abcd1234",
      exp: 1,
      at: Date.now(),
    });
    await flush();
    await flush();
    c.destroy();
    restore();
  });
});

describe("8. logout drops the credential locally before any network wait", () => {
  it("authenticated work is withheld the moment logout starts", async () => {
    const LO = "http://app.test/api/logout";
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const storage = new ServerManagedStorage({
      transport: "bff",
      logoutEndpoint: LO,
      acknowledgeNoCsrf: true,
    });
    const impl = (async (i: RequestInfo | URL) => {
      if (String(i) === LO) {
        await gate;
        return jsonRes({});
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    const p = c.logout({ localOnly: true });
    await flush();
    await expect(c.fetch("http://app.test/api/x")).rejects.toBeInstanceOf(NotAuthenticatedError);
    release();
    await p;
    c.destroy();
  });

  it("local credentials are gone before the backend call resolves", async () => {
    const LO = "http://app.test/api/logout";
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cleared: string[] = [];
    const storage: TokenStorage = {
      kind: "server-managed",
      persistent: true,
      load: () => null,
      save: () => undefined,
      clear: (r) => {
        cleared.push(String(r));
      },
    };
    (storage as unknown as { logoutEndpoint: string }).logoutEndpoint = LO;
    (storage as unknown as { transport: string }).transport = "bff";
    const impl = (async (i: RequestInfo | URL) => {
      if (String(i) === LO) {
        await gate;
        return jsonRes({});
      }
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    const p = c.logout({ localOnly: true });
    await flush();
    expect(cleared).toContain("logout"); // cleared BEFORE the backend resolved
    release();
    await p;
    c.destroy();
  });
});
