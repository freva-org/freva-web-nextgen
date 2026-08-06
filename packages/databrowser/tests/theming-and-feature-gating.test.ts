// The theming contract, feature gating, and brand config.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { installFetch, makeHost, overviewResponse, searchResponse, wait } from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";

function q<T extends Element = Element>(root: ParentNode, sel: string): T | null {
  return root.querySelector<T>(sel);
}

const router = () => (call: { url: string }) => {
  if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], { project: [] }) };
  if (call.url.includes("search"))
    return {
      body: searchResponse({
        total: 1,
        rows: [{ file: "/d/a.nc" }],
        facets: { project: ["cmip6", 1] },
        primary: ["project"],
      }),
    };
  return { body: {} };
};

async function mount(
  cfg: Parameters<typeof mountDataBrowser>[1],
): Promise<{ root: HTMLElement; destroy: () => void }> {
  installFetch(router());
  const host = makeHost();
  const handle = mountDataBrowser(host, cfg);
  await wait(30);
  return {
    root: q<HTMLElement>(host, ".freva-db") as HTMLElement,
    destroy: () => handle.destroy(),
  };
}

test("feature gating: chrome elements are omitted when disabled (default: all present)", async () => {
  const on = await mount({});
  assert.ok(q(on.root, ".theme"), "theme toggle present by default");
  assert.ok(q(on.root, ".lens"), "lens present by default");
  assert.ok(q(on.root, ".search"), "search present by default");
  assert.ok(q(on.root, '.ctrl[aria-label="Overview"]'), "overview control present");
  assert.ok(q(on.root, '.iconbtn[aria-label="Export catalogue"]'), "export present");
  on.destroy();

  const off = await mount({
    features: {
      themeToggle: false,
      lensSwitcher: false,
      search: false,
      overview: false,
      export: false,
      terminal: false,
      details: false,
      brand: false,
    },
  });
  assert.equal(q(off.root, ".theme"), null, "theme toggle gated off");
  assert.equal(q(off.root, ".lens"), null, "lens gated off");
  assert.equal(q(off.root, ".search"), null, "search gated off");
  assert.equal(q(off.root, '.ctrl[aria-label="Overview"]'), null, "overview gated off");
  assert.equal(q(off.root, '.iconbtn[aria-label="Export catalogue"]'), null, "export gated off");
  assert.equal(
    q(off.root, '.iconbtn[aria-label="Command terminal"]'),
    null,
    "terminal launcher gated off",
  );
  assert.equal(q(off.root, ".brand"), null, "brand gated off");
  off.destroy();
});

test("theme tokens: embedder palette overrides land as CSS custom properties on the root", async () => {
  const { root, destroy } = await mount({
    theme: { both: { accent: "#ff0088" }, night: { bg: "#010203" } },
  });
  assert.equal(root.style.getPropertyValue("--accent"), "#ff0088", "both-override applied");
  assert.equal(
    root.style.getPropertyValue("--bg"),
    "#010203",
    "night-override applied (default theme is night)",
  );
  destroy();
});

test("theme: font override sets --ui; CSS-structural values are rejected (no injection)", async () => {
  const { root, destroy } = await mount({ theme: { font: '"Inter", system-ui, sans-serif' } });
  assert.equal(
    root.style.getPropertyValue("--ui"),
    '"Inter", system-ui, sans-serif',
    "font override sets --ui",
  );
  destroy();

  const { root: r2, destroy: d2 } = await mount({
    theme: { font: "x; } body{display:none}", both: { accent: "red } html{}" } },
  });
  assert.equal(r2.style.getPropertyValue("--ui"), "", "a font value with ; { } is rejected");
  assert.equal(r2.style.getPropertyValue("--accent"), "", "an accent value with { } is rejected");
  d2();
});

test("brand config: title / mark / description are honoured", async () => {
  const { root, destroy } = await mount({
    brand: { title: "MyPortal", mark: "MP", description: "climate archive" },
  });
  const brand = q<HTMLElement>(root, ".brand");
  assert.match(brand?.textContent ?? "", /MyPortal/);
  assert.match(brand?.textContent ?? "", /MP/);
  assert.equal(q<HTMLElement>(root, ".scope-desc")?.textContent, "climate archive");
  destroy();
});

test("value-first search: dropdown shows badge + value + metadata description; keyboard selects", async () => {
  installFetch((call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [] }) };
    if (call.url.includes("search"))
      return {
        body: searchResponse({
          total: 3,
          rows: [{ file: "/d/a.nc" }],
          facets: { project: ["cmip6", 2, "cmip5", 1] },
          primary: ["project"],
        }),
      };
    return { body: {} };
  });
  const host = makeHost();
  const handle = mountDataBrowser(host, {
    metadataScriptUrl: null,
    metadata: { project: { cmip6: "Coupled Model Intercomparison Project 6" } },
  });
  await wait(30);
  const root = q<HTMLElement>(host, ".freva-db") as HTMLElement;
  const input = q<HTMLInputElement>(root, ".search input") as HTMLInputElement;
  const wv = input.ownerDocument.defaultView as unknown as {
    Event: typeof Event;
    KeyboardEvent: typeof KeyboardEvent;
  };
  input.focus();
  input.value = "cmi";
  input.dispatchEvent(new wv.Event("input", { bubbles: true }));
  const items = Array.from(root.querySelectorAll<HTMLElement>(".vsearch-pop .vs-item"));
  assert.ok(items.length >= 2, "matches across facet values shown");
  assert.equal(
    items[0].querySelector(".vs-badge")?.textContent?.toLowerCase(),
    "project",
    "facet badge shown",
  );
  assert.ok(
    items.some((i) => (i.querySelector(".vs-desc")?.textContent ?? "").includes("Coupled Model")),
    "metadata description shown",
  );
  // Enter selects the highlighted (top) match -> applies facet=value
  input.dispatchEvent(new wv.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(40);
  assert.deepEqual(
    handle.getState().selected,
    { project: ["cmip6"] },
    "selecting a match applies facet=value",
  );
  assert.equal(q(root, ".vsearch-pop.show"), null, "dropdown closes after select");
  handle.destroy();
  assert.equal(
    host.querySelector(".freva-db"),
    null,
    "destroy() cleans up (incl. the search popover)",
  );
});
