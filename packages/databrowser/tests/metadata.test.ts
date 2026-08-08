// The metadata.js contract: allow-listed script-global reading, config-wins merge, silent
// degradation, and the describeValue selector + hover wiring.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAP_CONFIG } from "../src/map.js";

import {
  readScriptGlobals,
  mergeMetadata,
  sanitizeConfigMetadata,
  initialMetadata,
  resolveMetadata,
  METADATA_FACET_KEYS,
} from "../src/metadata.js";
import { createInitialState, describeValue } from "../src/state.js";
import type { ResolvedConfig } from "../src/types.js";

function cfg(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    map: DEFAULT_MAP_CONFIG,
    inspectorUrl: "",

    apiBase: "/api",
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
      footer: true,
    },
    theme: {},
    brand: { title: "Freva", mark: "≈", description: "", showMark: true, showTitle: true },
    terminal: { host: null, shell: null, os: null },
    getAuthToken: () => null,
    getCsrfToken: () => null,
    ...over,
  };
}

test("readScriptGlobals reads only allow-listed facet keys with string->string blocks", () => {
  const source: Record<string, unknown> = {
    project: { cmip6: "Coupled Model Intercomparison Project 6", cmip5: "CMIP5" },
    variable: { tas: "near-surface air temperature" },
    // must be ignored: not in allow-list
    __proto__polluted: { x: "y" },
    evilGlobal: { a: "b" },
    // must be ignored: not a string->string block
    ensemble: { r1i1p1: 42 as unknown as string },
    // must be ignored: empty
    realm: {},
  };
  const m = readScriptGlobals(source);
  assert.deepEqual(m.project, { cmip6: "Coupled Model Intercomparison Project 6", cmip5: "CMIP5" });
  assert.deepEqual(m.variable, { tas: "near-surface air temperature" });
  assert.equal("ensemble" in m, false); // non-string value dropped
  assert.equal("realm" in m, false); // empty dropped
  assert.equal("evilGlobal" in m, false); // not allow-listed
  assert.ok(METADATA_FACET_KEYS.includes("project"));
});

test("readScriptGlobals returns a copy, never a reference to the source block", () => {
  const block = { cmip6: "x" };
  const source = { project: block };
  const m = readScriptGlobals(source);
  m.project.cmip6 = "mutated";
  assert.equal(block.cmip6, "x"); // source untouched
});

test("mergeMetadata: config (override) wins per key/value, script fills gaps", () => {
  const script = { project: { cmip6: "from script", cmip5: "script only" } };
  const config = { project: { cmip6: "from config" }, variable: { tas: "config only" } };
  const merged = mergeMetadata(script, config);
  assert.equal(merged.project.cmip6, "from config"); // override wins
  assert.equal(merged.project.cmip5, "script only"); // gap filled by script
  assert.equal(merged.variable.tas, "config only"); // config-only key present
});

test("sanitizeConfigMetadata drops malformed blocks", () => {
  const m = sanitizeConfigMetadata({
    project: { cmip6: "ok" },
    bad: { n: 3 as unknown as string },
    alsoBad: "not-an-object" as unknown as Record<string, string>,
  });
  assert.deepEqual(m, { project: { cmip6: "ok" } });
  assert.deepEqual(sanitizeConfigMetadata(undefined), {});
});

test("initialMetadata surfaces config synchronously", () => {
  const m = initialMetadata(cfg({ metadata: { project: { cmip6: "desc" } } }));
  assert.equal(m.project.cmip6, "desc");
});

test("resolveMetadata with scriptUrl null is config-only", async () => {
  const dis = {
    add() {},
    setTimeout() {
      return 0;
    },
  } as never;
  const root = document.createElement("div");
  const m = await resolveMetadata(
    cfg({ metadata: { project: { cmip6: "c" } }, metadataScriptUrl: null }),
    dis,
    root,
  );
  assert.deepEqual(m, { project: { cmip6: "c" } });
});

test("describeValue looks up by native key and degrades to null", () => {
  const state = createInitialState(cfg());
  state.metadata = { project: { cmip6: "Coupled Model…" } };
  assert.equal(describeValue(state, "project", "cmip6"), "Coupled Model…");
  assert.equal(describeValue(state, "project", "unknown"), null);
  assert.equal(describeValue(state, "variable", "tas"), null); // key absent
  state.metadata = { project: { cmip6: "" } };
  assert.equal(describeValue(state, "project", "cmip6"), null); // empty string -> null
});

// integration: config metadata surfaces as hover titles on facet value rows
import { installFetch, makeHost, overviewResponse, searchResponse, wait } from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";

const metaRouter = () => (call: { url: string }) => {
  if (call.url.includes("/overview"))
    return { body: overviewResponse(["freva"], { project: [], variable: [] }) };
  if (call.url.includes("/extended-search/") || call.url.includes("/metadata-search/")) {
    return {
      body: searchResponse({
        total: 3,
        rows: [{ file: "/d/a.nc" }],
        facets: { project: ["cmip6", 2, "cmip5", 1], variable: ["tas", 3] },
        primary: ["project", "variable"],
      }),
    };
  }
  return { body: {} };
};

test("config metadata surfaces as a hover title on sidebar facet values (config path, script off)", async () => {
  installFetch(metaRouter());
  const host = makeHost();
  const handle = mountDataBrowser(host, {
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
      footer: true,
    },
    theme: {},
    brand: { title: "Freva", mark: "≈", description: "", showMark: true, showTitle: true }, // config-only, deterministic in jsdom
    metadata: { project: { cmip6: "Coupled Model Intercomparison Project 6" } },
  });
  await wait(40);
  const root = host.querySelector(".freva-db") as HTMLElement;
  // open the project accordion so its value rows materialise
  (root.querySelector('.facet[data-key="project"] .facet-head') as HTMLButtonElement).click();
  const cmip6 = Array.from(
    root.querySelectorAll<HTMLButtonElement>('.facet[data-key="project"] .fval'),
  ).find((b) => (b.querySelector(".nm")?.textContent ?? "") === "cmip6");
  assert.ok(cmip6, "cmip6 value row rendered");
  assert.match(cmip6!.getAttribute("data-tip") ?? "", /Coupled Model Intercomparison Project 6/);
  // a value with no description falls back to just the value text
  const cmip5 = Array.from(
    root.querySelectorAll<HTMLButtonElement>('.facet[data-key="project"] .fval'),
  ).find((b) => (b.querySelector(".nm")?.textContent ?? "") === "cmip5");
  assert.equal(cmip5!.getAttribute("data-tip"), "cmip5");
  handle.destroy();
  assert.equal(host.querySelector(".freva-db"), null, "destroy() leaves nothing behind");
});

// probe: a missing/HTML metadata.js must never reach a <script> (uncatchable SyntaxError)
import { loadMetadataScript } from "../src/metadata.js";
import { Disposables } from "../src/dom.js";

test("loadMetadataScript skips non-JS responses (no <script> injected)", async () => {
  const orig = globalThis.fetch;
  const root = document.createElement("div");
  const dis = new Disposables();
  // a 200 "Not found" / HTML page - parsing it as JS/JSON would throw SyntaxError
  globalThis.fetch = (async () => ({
    ok: true,
    headers: { get: () => "text/html" },
    text: async () => "<!doctype html>Not found",
  })) as unknown as typeof fetch;
  const m = await loadMetadataScript("/static/js/metadata.js", dis, root);
  assert.deepEqual(m, {}, "degrades to empty");
  assert.equal(root.querySelector("script"), null, "no <script> injected for an HTML/error page");
  globalThis.fetch = orig;
});

test("loadMetadataScript skips a 404", async () => {
  const orig = globalThis.fetch;
  const root = document.createElement("div");
  const dis = new Disposables();
  globalThis.fetch = (async () => ({
    ok: false,
    headers: { get: () => "" },
    text: async () => "",
  })) as unknown as typeof fetch;
  assert.deepEqual(await loadMetadataScript("/x.js", dis, root), {});
  assert.equal(root.querySelector("script"), null);
  globalThis.fetch = orig;
});

test("loadMetadataScript rejects application/json (never injected as a script)", async () => {
  const orig = globalThis.fetch;
  const root = document.createElement("div");
  const dis = new Disposables();
  globalThis.fetch = (async () => ({
    ok: true,
    headers: { get: (h: string) => (h === "content-type" ? "application/json" : "") },
    text: async () => '{"project": {}}',
  })) as unknown as typeof fetch;
  assert.deepEqual(await loadMetadataScript("/meta.js", dis, root), {}, "JSON degrades to empty");
  assert.equal(root.querySelector("script"), null, "no <script> injected for a JSON response");
  globalThis.fetch = orig;
});

test("loadMetadataScript settles (and injects nothing) if destroyed while probing", async () => {
  const orig = globalThis.fetch;
  const root = document.createElement("div");
  const dis = new Disposables();
  globalThis.fetch = (async () => {
    dis.flush(); // browser destroyed while the probe is in flight
    return {
      ok: true,
      headers: { get: () => "text/javascript" },
      text: async () => "window.project={}",
    };
  }) as unknown as typeof fetch;
  const result = await Promise.race([
    loadMetadataScript("/meta.js", dis, root),
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 300)),
  ]);
  assert.deepEqual(result, {}, "resolves to empty rather than hanging");
  assert.equal(root.querySelector("script"), null, "no <script> appended to the detached root");
  globalThis.fetch = orig;
});
