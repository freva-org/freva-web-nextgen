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
    },
    theme: {},
    brand: { title: "Freva", mark: "≈", description: "" },
    terminal: { host: null, shell: null, os: null },
    getAuthToken: () => null,
    getCsrfToken: () => null,
    ...over,
  };
}

test("JSON POST carries Authorization alongside Content-Type when authEnabled", async () => {
  installFetch(() => ({ body: { urls: [] } }));
  const dis = new Disposables();
  const api = new Api(cfg({ authEnabled: true, getAuthToken: () => "tok123" }), dis);

  await api.zarrConvert({ path: ["/a.nc"] });

  const call = fetchCalls.find((c) => c.url.includes("/data-portal/zarr/convert"));
  assert.ok(call, "convert was POSTed");
  const headers = (call!.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer tok123", "bearer survives the JSON body init");
  assert.equal(headers["Content-Type"], "application/json", "content-type still set");
  assert.equal(call!.init?.method, "POST");
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
