/**
 * Configuration values are coerced strictly and outgoing requests keep their
 * integrity: a string "false" is never an opt-in, endpoints are read from the
 * snapshot rather than live config, and a Request input keeps its method,
 * headers and validation.
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
import { fetchView, jsonRes, makeJwt, stored } from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";

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

describe("configuration coercion and request integrity", () => {
  it("string 'false' enables allowInsecureTransport", () => {
    let ok = true;
    try {
      new PyOidcAuthClient({
        authBaseUrl: "http://insecure.test/auth/v2",
        redirectUri: "http://insecure.test/cb",
        storage: new MemoryStorage(),
        crossTab: false,
        security: { allowInsecureTransport: "false" as unknown as boolean },
      });
    } catch {
      ok = false;
    }
    expect(ok).toBe(false); // "false" must THROW, never enable http
  });

  it("string 'false' disables revocation", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "s1b", exp: NOW + 3600 }), NOW + 3600));
    let revokes = 0;
    const impl = (async (i: RequestInfo | URL) => {
      if (String(i).endsWith("/revoke")) revokes += 1;
      return jsonRes({});
    }) as typeof fetch;
    expect(() =>
      mk({
        storage,
        fetchImpl: impl,
        security: { acknowledgeNoRevocation: "false" as unknown as boolean },
      }),
    ).toThrow(/must be a real boolean/);
    const { c } = mk({ storage, fetchImpl: impl });
    await c.logout({ localOnly: true });
    expect(revokes).toBe(1); // revocation still happened
    c.destroy();
  });

  it("the userinfo endpoint is a snapshot, not the live config", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "s2", exp: NOW + 3600 }), NOW + 3600));
    const seen: string[] = [];
    const impl = (async (i: RequestInfo | URL) => {
      seen.push(fetchView(i).url);
      return jsonRes({});
    }) as typeof fetch;
    const cfg: AuthConfig = {
      authBaseUrl: BASE,
      redirectUri: "http://app.test/cb",
      storage,
      crossTab: false,
      now: () => NOW,
      navigate: () => undefined,
      fetchImpl: impl,
      userinfoEndpoint: "https://api.test/userinfo",
      security: { allowInsecureTransport: true, warnOnBrowserReadableRefresh: false },
    };
    const c = new PyOidcAuthClient(cfg);
    cfg.userinfoEndpoint = "https://api.test/OTHER-PLACE";
    await c.userinfo().catch(() => undefined);
    expect(seen[0]).toContain("/userinfo");
    expect(seen[0]).not.toContain("OTHER-PLACE"); // snapshot, not live config
    c.destroy();
  });

  it("a failed storage.clear() still reports a successful logout", async () => {
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: () => stored(makeJwt({ jti: "s3", exp: NOW + 3600 }), NOW + 3600),
      save: () => undefined,
      clear: () => {
        throw new Error("clear failed");
      },
    };
    const { c, events, navigated } = mk({
      storage,
      fetchImpl: (async () => jsonRes({})) as typeof fetch,
    });
    await c.logout().catch(() => undefined);
    // A local clear that fails means the credential is still here.
    expect(events.some((e) => e.type === "logout")).toBe(false);
    expect(navigated).toHaveLength(0);
    c.destroy();
  });

  it("getToken escapes during the initial logout storage read", async () => {
    let releaseLoad!: () => void;
    const gate = new Promise<void>((r) => (releaseLoad = r));
    const tok = stored(makeJwt({ jti: "s3b", exp: NOW + 3600 }), NOW + 3600);
    const storage: TokenStorage = {
      kind: "custom",
      lifecycleIdentity: "shared-credential",
      persistent: true,
      load: async () => {
        await gate;
        return tok;
      },
      save: () => undefined,
      clear: () => undefined,
    };
    const { c } = mk({ storage, fetchImpl: (async () => jsonRes({})) as typeof fetch });
    const p = c.logout({ localOnly: true });
    const escaped = await c.getToken({ refresh: "never" }).catch(() => null);
    releaseLoad();
    await p.catch(() => undefined);
    expect(escaped).toBeNull(); // blocked synchronously, before the first read
    c.destroy();
  });

  it("diagnose() makes a credentialed health request without CSRF or timeout", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(i), init });
      return jsonRes({ keys: [] });
    }) as typeof fetch;
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      healthUrl: "http://app.test/health",
      csrf: { headerName: "X-CSRFToken", token: "T" },
    });
    const { c } = mk({
      storage,
      fetchImpl: impl,
      security: { allowedResourceOrigins: ["http://app.test"] },
    });
    await c.diagnose();
    const health = calls.find((x) => x.url.includes("/health"));
    expect(health).toBeUndefined(); // diagnose() is passive
    // The explicit opt-in probes WITH csrf, timeout, no-store and redirect:error.
    await c.probeConnectivity();
    const probe = calls.find((x) => x.url.includes("/health"))!;
    expect(probe).toBeDefined();
    expect(new Headers(probe.init?.headers).get("X-CSRFToken")).toBe("T");
    expect(probe.init?.signal).toBeDefined();
    expect(probe.init?.cache).toBe("no-store");
    expect(probe.init?.redirect).toBe("error");
    c.destroy();
  });

  it("a Request input loses its method and headers", async () => {
    const storage = new MemoryStorage();
    await storage.save(stored(makeJwt({ jti: "s5", exp: NOW + 3600 }), NOW + 3600));
    let sentReq: Request | undefined;
    let seenUrl = "";
    const impl = (async (i: RequestInfo | URL) => {
      sentReq = i as Request;
      seenUrl = (i as Request).url;
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    const req = new Request("https://api.test/data", {
      method: "POST",
      body: "payload",
      headers: { "X-Custom": "kept" },
    });
    await c.fetch(req);
    expect(seenUrl).toBe("https://api.test/data");
    expect(sentReq?.method).toBe("POST");
    expect(sentReq?.headers.get("X-Custom")).toBe("kept");
    expect(sentReq?.headers.get("Authorization")).toContain("Bearer ");
    expect(await sentReq!.text()).toBe("payload");
    c.destroy();
  });

  it("a token in the callback fragment is neither routed nor scrubbed", async () => {
    history.replaceState(null, "", "/cb#access_token=FRAGMENT-TOKEN&token_type=Bearer");
    const { c } = mk({
      storage: new MemoryStorage(),
      security: { requireLoginTransaction: false, acknowledgeNoLoginTransaction: true },
    });
    const routed = c.isCallbackUrl();
    await c.handleCallback().catch(() => undefined);
    expect(routed).toBe(true); // routed
    expect(location.href).not.toContain("FRAGMENT-TOKEN"); // and scrubbed
    c.destroy();
  });

  it("tokenProvider output bypasses validation (non-Bearer scheme)", async () => {
    const storage = new ServerManagedStorage({
      transport: "bearer-from-endpoint",
      acknowledgeNoCsrf: true,
      tokenProvider: () => ({
        accessToken: "abc",
        tokenType: "Basic" as string,
        expiresAt: NOW + 600,
        sessionVersion: "v",
      }),
    });
    let auth = "";
    const impl = (async (i: RequestInfo | URL) => {
      auth = (i as Request).headers?.get("Authorization") ?? "";
      return jsonRes({});
    }) as typeof fetch;
    const { c } = mk({ storage, fetchImpl: impl });
    await c.fetch("https://api.test/data").catch(() => undefined);
    expect(auth).toBe(""); // the request never went out at all
    expect(auth.startsWith("Basic")).toBe(false);
    c.destroy();
  });
});
