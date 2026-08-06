/**
 * A structural claim is not a class.
 *
 * `TokenStorage` is a structural interface, so any object can set
 * `kind: "cookie"`. Waiving the `lifecycleIdentity` declaration for anything
 * that LOOKS built-in — reading the public `kind` (and `transport`) string and
 * returning an identity before the requirement is ever reached — makes the
 * requirement waivable by writing one extra property, and a tab-partitioned
 * storage that says `"cookie"` is then silently classified as
 * `shared-credential`, where a fingerprint mismatch REJECTS a peer's logout and
 * one tab's credential survives another tab's sign-out.
 */
import { describe, expect, it } from "vitest";
import {
  PyOidcAuthClient,
  type AuthConfig,
  type AuthEvent,
  type StoredToken,
  type TokenStorage,
} from "../src/index.js";
import { installFakeBroadcastChannel, jsonRes, makeJwt, stored } from "./helpers.js";

const NOW = 1_700_000_000;
const BASE = "https://api.test/api/freva-nextgen/auth/v2";
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await flush();
};

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

/** A plain object claiming to be a built-in, with NO declaration. */
function impersonator(extra: Record<string, unknown>): TokenStorage {
  return {
    persistent: true,
    load: () => null,
    save: () => undefined,
    clear: () => undefined,
    ...extra,
  } as TokenStorage;
}

// ---------------------------------------------------------------------------
// The declaration cannot be waived by claiming to be a built-in.
// ---------------------------------------------------------------------------

describe("a `kind` string does not waive the topology declaration", () => {
  const shapes: Array<[string, Record<string, unknown>]> = [
    ["memory", { kind: "memory" }],
    ["cookie", { kind: "cookie" }],
    ["server-managed bearer", { kind: "server-managed", transport: "bearer-from-endpoint" }],
    ["server-managed bff", { kind: "server-managed", transport: "bff" }],
  ];

  for (const [name, extra] of shapes) {
    it(`an undeclared storage claiming kind="${extra.kind}" is refused (${name})`, () => {
      expect(() => mk({ storage: impersonator(extra) })).toThrow(/lifecycleIdentity/i);
    });
  }

  it("a declaration that matches the claimed kind is accepted", () => {
    const { c } = mk({
      storage: impersonator({ kind: "cookie", lifecycleIdentity: "shared-credential" }),
    });
    expect(c.lifecycleIdentity).toBe("shared-credential");
    c.destroy();
    // ...and one that contradicts it is still refused, exactly as before.
    expect(() =>
      mk({ storage: impersonator({ kind: "memory", lifecycleIdentity: "shared-credential" }) }),
    ).toThrow(/contradict/i);
  });
});

// ---------------------------------------------------------------------------
// The exploitable consequence: a logout that does not reach the other tab.
// ---------------------------------------------------------------------------

describe("the bypass is an executable logout failure", () => {
  it("two tab-partitioned storages claiming kind=cookie cannot silently be shared", async () => {
    const restore = installFakeBroadcastChannel();
    const mine = makeJwt({ jti: "c2-mine", exp: NOW + 3600 });
    const theirs = makeJwt({ jti: "c2-theirs", exp: NOW + 3600 });

    // Two INDEPENDENT cells — tab-partitioned in fact, "cookie" by assertion.
    const cellA: { token: StoredToken | null } = { token: stored(theirs, NOW + 3600) };
    const cellB: { token: StoredToken | null } = { token: stored(mine, NOW + 3600) };
    const shape = (cell: { token: StoredToken | null }) => ({
      kind: "cookie" as const,
      persistent: true,
      load: () => cell.token,
      save: (t: StoredToken) => {
        cell.token = t;
      },
      clear: () => {
        cell.token = null;
      },
    });

    // Classified `shared-credential`, B would refuse A's logout as a
    // fingerprint mismatch and keep its token. Refusing to construct them at
    // all means the deployment finds out at startup rather than at the first
    // logout that silently does not work.
    expect(() => mk({ storage: shape(cellA) as unknown as TokenStorage })).toThrow(
      /lifecycleIdentity/i,
    );

    // Declared honestly, the same two storages sign out together.
    const honest = (cell: { token: StoredToken | null }) => ({
      ...shape(cell),
      kind: "custom" as const,
      lifecycleIdentity: "per-tab",
    });
    const impl = (async () => jsonRes({})) as typeof fetch;
    const { c: a } = mk({ storage: honest(cellA) as unknown as TokenStorage, fetchImpl: impl });
    const { c: b } = mk({ storage: honest(cellB) as unknown as TokenStorage, fetchImpl: impl });
    expect(a.channelName).toBe(b.channelName);
    expect((await b.getToken({ refresh: "never" }))?.accessToken).toBe(mine);

    await a.logout({ localOnly: true });
    await settle();

    expect(cellB.token).toBeNull();
    a.destroy();
    b.destroy();
    restore();
  });
});

// ---------------------------------------------------------------------------
// The crossTab: false split is unchanged.
// ---------------------------------------------------------------------------

describe("with cross-tab disabled the split is unchanged", () => {
  it("an omitted declaration is allowed, an invalid one still throws", () => {
    const { c } = mk({ storage: impersonator({ kind: "cookie" }), crossTab: false });
    expect(c.lifecycleIdentity).toBe("per-tab");
    c.destroy();

    expect(() =>
      mk({
        storage: impersonator({ kind: "cookie", lifecycleIdentity: "nonsense" }),
        crossTab: false,
      }),
    ).toThrow(/lifecycleIdentity/i);
  });
});
