// API-layer behaviour that does not need a mounted UI: the JSON-POST auth header and the
// one-off AbortController set staying bounded. helpers.js is imported first for the DOM
// globals + the recording mock fetch.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAP_CONFIG } from "../src/map.js";

import { fetchCalls, installFetch } from "./helpers.js";
import { Api } from "../src/api.js";
import { Disposables } from "../src/dom.js";
import type { ResolvedConfig } from "../src/types.js";

function cfg(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    map: DEFAULT_MAP_CONFIG,
    inspectorUrl: "",

    apiBase: "/api/freva-nextgen/databrowser",
    flavour: "freva",
    devNotes: false,
    authEnabled: false,
    enableHeavyOps: false,
    syncUrl: false,
    enableStrictBBoxModes: false,

    metadata: {},
    metadataScriptUrl: null,
    defaultLayout: "results",
    overview: { order: [], mainFacets: null },
    scopeRemovable: false,
    features: {
      themeToggle: true,
      terminal: true,
      overview: true,
      export: true,
      details: true,
      search: true,
      lensSwitcher: true,
      inspect: true,
      brand: true,
      footer: true,
    },
    theme: {},
    brand: { title: "Freva", mark: "≈", description: "", showMark: true, showTitle: true },
    terminal: { host: null, shell: null, os: null },
    getAuthToken: () => null,
    getCsrfToken: () => null,
    dataPortalBase: "/api/freva-nextgen/data-portal",
    signIn: null,
    ...over,
  };
}

test("JSON POST carries Authorization alongside Content-Type when authEnabled", async () => {
  installFetch(() => ({ body: {} }));
  const dis = new Disposables();
  const api = new Api(cfg({ authEnabled: true, getAuthToken: () => "tok123" }), dis);

  // The request path every call shares: init headers must not drop the bearer (or vice versa).
  const request = (
    api as unknown as { request(url: string, init: RequestInit): Promise<Response> }
  ).request.bind(api);
  await request("/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  const call = fetchCalls.find((c) => c.url === "/api/x");
  assert.ok(call, "the POST was sent");
  const headers = (call!.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer tok123", "bearer survives the JSON body init");
  assert.equal(headers["Content-Type"], "application/json", "content-type still set");
  assert.equal(call!.init?.method, "POST");
  dis.flush();
});

test("an async token supplier is awaited per request (OIDC refresh-before-use)", async () => {
  installFetch(() => ({ body: {} }));
  const dis = new Disposables();
  // Mimics `async () => (await auth.getToken())?.accessToken` from ts-oidc-auth-client: the
  // client rotates the token between requests, and each request must carry the CURRENT one.
  let n = 0;
  const api = new Api(cfg({ authEnabled: true, getAuthToken: async () => `rotated-${++n}` }), dis);
  await api.listFlavours();
  await api.overview();
  const bearers = fetchCalls
    .slice(-2)
    .map((c) => ((c.init?.headers ?? {}) as Record<string, string>)["Authorization"]);
  assert.deepEqual(bearers, ["Bearer rotated-1", "Bearer rotated-2"]);
  dis.flush();
});

test("a rejecting token supplier degrades that request to anonymous, never fails it", async () => {
  installFetch(() => ({ body: {} }));
  const dis = new Disposables();
  const api = new Api(
    cfg({
      authEnabled: true,
      getAuthToken: () => Promise.reject(new Error("SessionExpiredError")),
    }),
    dis,
  );
  await api.listFlavours();
  const h = (fetchCalls[fetchCalls.length - 1].init?.headers ?? {}) as Record<string, string>;
  assert.ok(!("Authorization" in h), "no bearer, request still sent");
  dis.flush();
});

test("the token supplier is not consulted while authEnabled is off", async () => {
  installFetch(() => ({ body: {} }));
  const dis = new Disposables();
  let asked = 0;
  const api = new Api(cfg({ getAuthToken: async () => (asked++, "t") }), dis);
  await api.listFlavours();
  assert.equal(asked, 0);
  dis.flush();
});

test("X-CSRFToken is sent only when a supplier is provided", async () => {
  installFetch(() => ({ body: {} }));
  // default: no CSRF supplier -> header absent
  const disA = new Disposables();
  const apiA = new Api(cfg({ authEnabled: true, getAuthToken: () => "t" }), disA);
  await apiA.listFlavours();
  let h = (fetchCalls[fetchCalls.length - 1].init?.headers ?? {}) as Record<string, string>;
  assert.ok(!("X-CSRFToken" in h), "no CSRF header by default");
  disA.flush();

  // with a supplier -> header present
  const disB = new Disposables();
  const apiB = new Api(cfg({ getCsrfToken: () => "csrf-9" }), disB);
  await apiB.listFlavours();
  h = (fetchCalls[fetchCalls.length - 1].init?.headers ?? {}) as Record<string, string>;
  assert.equal(h["X-CSRFToken"], "csrf-9");
  disB.flush();
});

test("one-off controller set is bounded: tracked in flight, cleared on completion", async () => {
  installFetch(() => ({ body: {}, delayMs: 40 }));
  const dis = new Disposables();
  const api = new Api(cfg(), dis);

  const inflight = api.listFlavours();
  assert.equal(api.oneOffPending(), 1, "tracked while in flight");
  await inflight;
  assert.equal(api.oneOffPending(), 0, "removed once it settles");

  for (let i = 0; i < 6; i++) await api.listFlavours();
  assert.equal(api.oneOffPending(), 0, "no accumulation across repeated completed requests");
  dis.flush();
});

test("authHeadersFor: the bearer goes to the API's and the data-portal's origins only", async () => {
  const dis = new Disposables();
  let asked = 0;
  const api = new Api(
    cfg({
      authEnabled: true,
      getAuthToken: () => (asked++, "t"),
      dataPortalBase: "https://portal.example.org/api/freva-nextgen/data-portal",
    }),
    dis,
  );
  assert.deepEqual(
    await api.authHeadersFor("/api/freva-nextgen/data-portal/zarr/a.zarr/.zmetadata"),
    {
      Authorization: "Bearer t",
    },
  );
  assert.deepEqual(await api.authHeadersFor("https://portal.example.org/x.zarr/.zmetadata"), {
    Authorization: "Bearer t",
  });
  const before = asked;
  assert.deepEqual(await api.authHeadersFor("https://s3.example.org/bucket/x.zarr/.zmetadata"), {});
  assert.equal(asked, before, "a foreign URL never even asks for the token");
  dis.flush();
});
