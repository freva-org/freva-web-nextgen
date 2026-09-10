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

test("resolveMetadata with no script URL still resolves, from the built-in set", async () => {
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
  // Config still wins on the value it names...
  assert.equal(m.project.cmip6, "c");
  // ...and the built-in set fills in everything it does not.
  assert.equal(m.project.cmip5, "Coupled Model Intercomparison Project 5");
  assert.ok(Object.keys(m.variable).length > 1000);
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
  // A value the config says nothing about picks up the built-in description rather than falling
  // back to bare value text: a description does not depend on a deployment having configured it or
  // served a script.
  const cmip5 = Array.from(
    root.querySelectorAll<HTMLButtonElement>('.facet[data-key="project"] .fval'),
  ).find((b) => (b.querySelector(".nm")?.textContent ?? "") === "cmip5");
  /*
   * The description, and now the value's share of the result set after it: the sidebar draws the
   * same count bar the overview cards do, and the title says what the bar means. Matched rather
   * than compared whole, so this test stays about the DESCRIPTION - which is what it is named for -
   * and does not fail the next time the share is worded differently.
   */
  const tip = cmip5!.getAttribute("data-tip") ?? "";
  assert.match(tip, /^cmip5 - Coupled Model Intercomparison Project 5/);
  assert.match(tip, /% of results\)$/);
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

/* Built-in metadata.
 *
 * The shared climate descriptions are data in this package. These check that the mappings are
 * complete, that nothing about them reaches `window`, and that a default mount asks the network for
 * nothing.
 */

test("the built-in set carries a representative description for each kind of facet", async () => {
  const { BUILTIN_METADATA } = await import("../src/metadata-builtin.js");

  // project
  assert.equal(BUILTIN_METADATA.project.cmip6, "Coupled Model Intercomparison Project 6");
  // variable
  assert.equal(BUILTIN_METADATA.variable.tas, "Near-Surface Air Temperature");
  // model
  assert.ok(
    (BUILTIN_METADATA.model["mpi-esm-lr"] ?? "").length > 0,
    `a representative model has a description, got ${JSON.stringify(BUILTIN_METADATA.model["mpi-esm-lr"])}`,
  );
  // experiment, as the legacy file spelled it: the activity/product block. The legacy script had
  // no `experiment` block of its own, and inventing one would be inventing content.
  assert.equal(BUILTIN_METADATA.product.scenariomip, "Scenario Model Intercomparison Project");
  // institute
  assert.ok((BUILTIN_METADATA.institute["mpi-m"] ?? "").length > 0);
});

test("every built-in block is a string->string map under an allow-listed facet key", async () => {
  const { BUILTIN_METADATA } = await import("../src/metadata-builtin.js");
  for (const [facet, block] of Object.entries(BUILTIN_METADATA)) {
    assert.ok(METADATA_FACET_KEYS.includes(facet), `${facet} is not an allow-listed facet key`);
    for (const [value, description] of Object.entries(block)) {
      assert.equal(typeof value, "string");
      assert.equal(typeof description, "string");
    }
  }
});

test("loading the built-in set creates no globals", async () => {
  const before = new Set(Object.keys(globalThis as unknown as Record<string, unknown>));
  const { loadBuiltinMetadata } = await import("../src/metadata.js");
  const m = await loadBuiltinMetadata();
  assert.ok(Object.keys(m).length > 0, "the built-in set loaded");
  const after = Object.keys(globalThis as unknown as Record<string, unknown>);
  const added = after.filter((k) => !before.has(k));
  assert.deepEqual(added, [], `new globals: ${added.join(", ")}`);
  // And specifically not the ones the legacy script assigned.
  for (const key of ["project", "variable", "model", "institute", "product"]) {
    assert.equal(
      (globalThis as unknown as Record<string, unknown>)[key],
      undefined,
      `${key} leaked onto the global object`,
    );
  }
});

test("a default mount fetches no metadata and injects no script", async () => {
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    requested.push(String(input));
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const dis = {
    add() {},
    setTimeout() {
      return 0;
    },
  } as never;
  const root = document.createElement("div");
  try {
    const m = await resolveMetadata(cfg({ metadata: {}, metadataScriptUrl: null }), dis, root);
    assert.ok(Object.keys(m).length > 0, "descriptions are available without a request");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(requested, [], `unexpected requests: ${requested.join(", ")}`);
  assert.equal(root.querySelector("script"), null, "a <script> was injected");
});

test("an explicit script URL is still honoured, over the built-in set and under config", () => {
  // The merge order, stated directly: builtin < script < config.
  const builtin = { project: { a: "builtin-a", b: "builtin-b", c: "builtin-c" } };
  const script = { project: { b: "script-b", c: "script-c" } };
  const config = { project: { c: "config-c" } };
  const merged = mergeMetadata(mergeMetadata(builtin, script), config);
  assert.deepEqual(merged.project, { a: "builtin-a", b: "script-b", c: "config-c" });
});

// The public `@freva-org/databrowser/metadata` surface.
//
// The portal's landing search box offers the same facet values the Data Browser
// will show, so it has to describe them identically or it reads as a different
// tool that happens to look similar. That parity is only real if the lookup is
// one function rather than two implementations, and if the subpath a host can
// reach actually exports it.

test("describeMetadataValue maps a flavour key back to the native one", async () => {
  const { describeMetadataValue, BUILTIN_FLAVOUR_MAPS } = await import("../src/metadata-public.js");
  const metadata = {
    project: { cmip5: "Coupled Model Intercomparison Project 5" },
    model: { "mpi-esm-lr": "MPI Earth System Model, low resolution" },
  };

  // Native keys need no mapping at all.
  assert.equal(
    describeMetadataValue(metadata, undefined, "project", "cmip5"),
    "Coupled Model Intercomparison Project 5",
  );

  // Under a translating flavour the facet arrives as `mip_era`, and the
  // descriptions are still keyed by `project`.
  const backward = BUILTIN_FLAVOUR_MAPS.cmip6?.backward;
  assert.equal(backward?.mip_era, "project");
  assert.equal(
    describeMetadataValue(metadata, backward, "mip_era", "cmip5"),
    "Coupled Model Intercomparison Project 5",
  );

  // A value nobody described, and a facet nobody described, are both "no
  // description" rather than an error or an empty string.
  assert.equal(describeMetadataValue(metadata, undefined, "project", "nope"), null);
  assert.equal(describeMetadataValue(metadata, undefined, "nosuch", "cmip5"), null);
  assert.equal(describeMetadataValue({ project: { x: "" } }, undefined, "project", "x"), null);
});

test("describeValue and the public lookup agree on the same state", async () => {
  const { describeMetadataValue } = await import("../src/metadata-public.js");
  const state = createInitialState(cfg());
  state.metadata = { project: { cmip5: "Coupled Model Intercomparison Project 5" } };
  state.flavour = "cmip6";
  assert.equal(
    describeValue(state, "mip_era", "cmip5"),
    describeMetadataValue(state.metadata, state.flavourMaps.cmip6?.backward, "mip_era", "cmip5"),
  );
  assert.equal(describeValue(state, "mip_era", "cmip5"), "Coupled Model Intercomparison Project 5");
});

test("the metadata subpath serves the built-in descriptions without an app", async () => {
  const mod = await import("../src/metadata-public.js");
  const metadata = await mod.loadBuiltinMetadata();
  assert.equal(
    mod.describeMetadataValue(metadata, undefined, "project", "cmip5"),
    "Coupled Model Intercomparison Project 5",
  );
  // The barrel is data only: nothing on it mounts, renders or touches a DOM.
  assert.deepEqual(
    Object.keys(mod).filter((k) => /mount|render|create[A-Z]/.test(k)),
    [],
  );
});
