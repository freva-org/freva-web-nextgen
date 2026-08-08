// Search-commit discipline and the performance contracts that are observable from the outside:
// terminal token-commit rules, the unified search-bar guard, popover-orphan close, per-mount
// render state, the recount race, quote consistency across tokenizer and quoter, dirty-draft
// persistence, incremental row updates, chunked value lists, streaming export, parallel
// bootstrap, and the no-transition theme flip.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAP_CONFIG } from "../src/map.js";

import {
  downloadClicks,
  abortedUrls,
  fetchCalls,
  downloadHrefs,
  installFetch,
  pickValue,
  makeHost,
  overviewResponse,
  searchResponse,
  wait,
  tick,
  window as win,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";
import type { DataBrowserConfig, DataBrowserHandle } from "../src/types.js";
import {
  facetQueryString,
  filterCommittable,
  parseFacetTokens,
  selectionsEqual,
  shellQuote,
  tokenize,
  tokenizeRich,
  createInitialState,
} from "../src/state.js";
import { validPart } from "../src/components/timeEditor.js";
import type { AppState } from "../src/types.js";

function q<T extends Element = Element>(root: ParentNode, sel: string): T | null {
  return root.querySelector<T>(sel);
}
function qa<T extends Element = Element>(root: ParentNode, sel: string): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}
function byText<T extends Element = Element>(
  root: ParentNode,
  sel: string,
  text: string,
): T | undefined {
  return qa<T>(root, sel).find((e) => (e.textContent ?? "").includes(text));
}
function openFacet(root: ParentNode, key: string): void {
  q<HTMLButtonElement>(root, `.facet[data-key="${key}"] .facet-head`)?.click();
}

async function mount(
  router: Parameters<typeof installFetch>[0],
  cfg: DataBrowserConfig = {},
): Promise<{
  handle: DataBrowserHandle;
  host: HTMLElement;
  root: HTMLElement;
}> {
  installFetch(router);
  const host = makeHost();
  const handle = mountDataBrowser(host, cfg);
  await wait(30);
  const root = q<HTMLElement>(host, ".freva-db");
  assert.ok(root, "root mounted");
  return { handle, host, root: root as HTMLElement };
}

/** project has a small CLOSED value list; variable is open (KNOWN_LARGE). */
const guardRouter = () => (call: { url: string }) => {
  if (call.url.includes("/overview"))
    return { body: overviewResponse(["freva"], { project: [], variable: [] }) };
  if (call.url.includes("/extended-search/") || call.url.includes("/metadata-search/")) {
    return {
      body: searchResponse({
        total: 3,
        rows: [
          { file: "/d/a_200601-200612.nc" },
          { file: "/d/b_200601-200612.nc" },
          { file: "/d/c.nc" },
        ],
        facets: {
          project: ["cmip6", 2, "cmip5", 1],
          variable: ["tas", 3],
          ensemble: ["not set", 3],
        },
        primary: ["project", "variable", "ensemble"],
      }),
    };
  }
  return { body: {} };
};

function termInput(root: HTMLElement): HTMLTextAreaElement {
  return q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
}
function type(input: HTMLTextAreaElement, value: string, caret = value.length): void {
  input.value = value;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}

// Terminal commit discipline

test("keystrokes never commit the token under the caret; whitespace completes it", async () => {
  const { handle, root } = await mount(guardRouter());
  const input = termInput(root);
  const searches = (): number =>
    fetchCalls.filter((c) => c.url.includes("/extended-search/")).length;
  const before = searches();

  // simulate typing project=c, project=cm, … caret always at the end of the token
  for (const v of ["p", "pro", "project", "project=", "project=c", "project=cmip", "project=cmip6"])
    type(input, v);
  await wait(320); // past the search debounce
  assert.equal(searches(), before, "no search fired for any partial keystroke");
  assert.deepEqual(
    handle.getState().selected,
    {},
    "nothing committed while the token is under the caret",
  );
  // the ONLY tolerated keystroke-adjacent request is the (debounced, key-excluded)
  // autocomplete enrichment - no request of any kind may carry a partial value as a filter
  assert.ok(
    !fetchCalls.some((c) => /project=/.test(c.url)),
    "no partial value ever reached the backend",
  );

  type(input, "project=cmip6 "); // trailing whitespace completes the token
  await wait(320);
  assert.deepEqual(handle.getState().selected, { project: ["cmip6"] }, "completed token committed");
  assert.ok(
    fetchCalls.some((c) => c.url.includes("project=cmip6")),
    "exactly the completed value was searched",
  );
  handle.destroy();
});

test("Enter and blur complete the in-progress token", async () => {
  const { handle, root } = await mount(guardRouter());
  const input = termInput(root);

  type(input, "project=cmip5");
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(320);
  assert.deepEqual(handle.getState().selected, { project: ["cmip5"] }, "Enter commits");

  type(input, "project=cmip5 variable=tas");
  input.dispatchEvent(new win.Event("blur", { bubbles: true }));
  await wait(320);
  assert.deepEqual(
    handle.getState().selected,
    { project: ["cmip5"], variable: ["tas"] },
    "blur commits",
  );
  handle.destroy();
});

test("a value failing the closed-value-set check is never committed", async () => {
  const { handle, root } = await mount(guardRouter());
  const input = termInput(root);
  type(input, "project=bogus "); // completed token, but not in the closed {cmip6, cmip5} set
  await wait(320);
  assert.deepEqual(handle.getState().selected, {}, "invalid closed-set value not committed");
  assert.ok(
    !fetchCalls.some((c) => c.url.includes("bogus")),
    "invalid value never sent to the backend",
  );
  assert.ok(q(root, ".te-warn.show"), "warning shown");
  // an open value set (variable, hasMore) accepts unknown values
  type(input, "variable=zzz ");
  await wait(320);
  assert.deepEqual(handle.getState().selected, { variable: ["zzz"] }, "open-set value accepted");
  handle.destroy();
});

// Dirty drafts survive re-renders

test("an unknown token stays visible (with its warning) across blur and re-renders", async () => {
  const { handle, root } = await mount(guardRouter());
  const input = termInput(root);
  type(input, "nonsense=1 ");
  input.dispatchEvent(new win.Event("blur", { bubbles: true }));
  await wait(320);
  assert.equal(handle.getState().selected.nonsense, undefined, "unknown key not committed");
  // trigger external re-renders: a sidebar facet toggle re-syncs the terminal too
  openFacet(root, "project");
  byText<HTMLElement>(root, ".side-scroll .fval", "cmip6")!.click();
  await wait(320);
  assert.ok(input.value.includes("nonsense=1"), "raw draft kept after external re-render");
  assert.ok(q(root, ".te-warn.show"), "warning still visible");
  handle.destroy();
});

// The value-first main search bar

test("value-first search applies a matching facet=value and ignores non-matches", async () => {
  const { handle, root } = await mount(guardRouter());
  // a value that matches no facet value applies nothing (the key=value guard lives in
  // the terminal - see the terminal unknown-key test)
  pickValue(root, "definitely-not-a-value");
  await wait(30);
  assert.deepEqual(handle.getState().selected, {}, "a non-matching value applies nothing");
  assert.ok(
    !fetchCalls.some((c) => /definitely-not-a-value/.test(c.url)),
    "nothing invalid reached the backend",
  );
  // a real value applies facet=value
  pickValue(root, "cmip6");
  await wait(320);
  assert.deepEqual(
    handle.getState().selected,
    { project: ["cmip6"] },
    "the matching value applied",
  );
  handle.destroy();
});

// Popovers close when their anchor region re-renders

test("an open row menu closes when a settling search rebuilds the results region", async () => {
  // filtering changes the row SET here, so the settling search does a full rebuild (not the
  // append fast-path) - which detaches the kebab the menu was anchored to.
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [] }) };
    if (call.url.includes("/extended-search/") || call.url.includes("/metadata-search/")) {
      const filtered = /[?&]project=cmip6/.test(call.url);
      const rows = filtered ? [{ file: "/d/z.nc" }] : [{ file: "/d/a.nc" }, { file: "/d/b.nc" }];
      return {
        body: searchResponse({
          total: rows.length,
          rows,
          facets: { project: ["cmip6", 2, "cmip5", 1] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, "#fdb-results .row .kebab")!.click();
  await tick();
  assert.ok(q(root, ".pop.show"), "row menu open");
  // a facet toggle -> debounced search -> results region rebuilds with a different row set
  openFacet(root, "project");
  byText<HTMLElement>(root, ".side-scroll .fval", "cmip6")!.click();
  await wait(320);
  assert.equal(q(root, ".pop.show"), null, "orphaned menu closed by the region re-render");
  handle.destroy();
});

// Two mounted instances never share render/listener state

test("two concurrent mounts keep independent listeners and state", async () => {
  installFetch(guardRouter());
  const hostA = makeHost();
  const hostB = makeHost();
  const a = mountDataBrowser(hostA, {});
  const b = mountDataBrowser(hostB, {});
  await wait(30);
  const rootA = q<HTMLElement>(hostA, ".freva-db") as HTMLElement;
  const rootB = q<HTMLElement>(hostB, ".freva-db") as HTMLElement;

  // interleave renders: open facets in both, then interact with A only
  openFacet(rootA, "project");
  openFacet(rootB, "project");
  byText<HTMLElement>(rootA, ".side-scroll .fval", "cmip6")!.click();
  await wait(320);
  assert.deepEqual(a.getState().selected, { project: ["cmip6"] }, "A committed");
  assert.deepEqual(b.getState().selected, {}, "B untouched");
  // …and B still works after A re-rendered
  byText<HTMLElement>(rootB, ".side-scroll .fval", "cmip5")!.click();
  await wait(320);
  assert.deepEqual(b.getState().selected, { project: ["cmip5"] }, "B committed independently");
  a.destroy();
  b.destroy();
});

// A stale recount cannot overwrite fresher facet counts

test("a slow recount settling after a newer search is dropped", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/metadata-search/")) {
      // the stale recount: huge counts, very slow
      return {
        body: searchResponse({ total: 1, facets: { project: ["cmip6", 999999] } }),
        delayMs: 400,
      };
    }
    if (call.url.includes("/extended-search/")) {
      const filtered = /[?&]project=/.test(call.url);
      return {
        body: searchResponse({
          total: filtered ? 2 : 3,
          rows: [{ file: "/x.nc" }],
          facets: { project: ["cmip6", filtered ? 2 : 3] },
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  // switch to overview -> schedules the (slow) recount
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')!.click();
  await wait(320); // recount debounce elapses; slow metadata-search now in flight
  // a facet commit -> newer extended-search settles while the recount is still pending
  pickValue(root, "cmip6");
  await wait(600); // fast search settles, THEN the stale recount settles
  const project = handle.getState().facets.find((f) => f.key === "project");
  assert.ok(project, "project facet present");
  assert.equal(
    project!.values[0].count,
    2,
    "counts come from the newer search, not the stale recount",
  );
  handle.destroy();
});

// Quote consistency across tokenizer / highlighter / shellQuote

test("quoted values render as ONE valid token in the highlight overlay", async () => {
  const { handle, root } = await mount(guardRouter());
  const input = termInput(root);
  type(input, 'ensemble="not set" ');
  await wait(320);
  assert.deepEqual(
    handle.getState().selected,
    { ensemble: ["not set"] },
    "quoted value committed as one token",
  );
  const hl = q<HTMLElement>(root, ".te-hl") as HTMLElement;
  assert.equal(hl.querySelectorAll(".bad").length, 0, "nothing flagged invalid");
  assert.equal(hl.querySelectorAll(".k").length, 1, "exactly one key span (not two broken tokens)");
  assert.ok(
    (hl.querySelector(".v")?.textContent ?? "").includes('"not set"'),
    "raw quoted form rendered verbatim",
  );
  handle.destroy();
});

test("(pure): tokenizer honours the escapes shellQuote emits", () => {
  // whitespace value round-trip
  assert.deepEqual(tokenize(`ensemble=${shellQuote("not set")}`), ["ensemble=not set"]);
  // literal quote round-trip - an unquoted value here would break tokenize
  const withQuote = 'say "hi"';
  assert.deepEqual(tokenize(`k=${shellQuote(withQuote)}`), [`k=${withQuote}`]);
  // literal backslash + quote round-trip
  const nasty = 'a\\"b c';
  assert.deepEqual(tokenize(`k=${shellQuote(nasty)}`), [`k=${nasty}`]);
  // rich segmentation keeps raw offsets aligned with the input
  const text = 'a=1  b="x y"';
  const segs = tokenizeRich(text);
  assert.equal(segs.map((s) => s.raw).join(""), text, "raw segments reassemble the input exactly");
  assert.deepEqual(
    segs.filter((s) => s.kind === "tok").map((s) => s.value),
    ["a=1", "b=x y"],
  );
  // parse agrees
  assert.deepEqual(parseFacetTokens('ensemble="not set"'), { ensemble: ["not set"] });
});

// Encoding, calendar validation, and keyboard activation

test("(pure): facetQueryString encodes keys as well as values", () => {
  const state: AppState = createInitialState({
    map: DEFAULT_MAP_CONFIG,
    inspectorUrl: "",

    apiBase: "",
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
  });
  state.selected = { "weird&key": ["a b"] };
  assert.equal(facetQueryString(state), "weird%26key=a%20b");
});

test("(pure): time validation rejects impossible months/days/hours", () => {
  assert.ok(validPart("2000"));
  assert.ok(validPart("2000-12"));
  assert.ok(validPart("2000-02-29"));
  assert.ok(validPart("2000-01-31 23:59"));
  assert.ok(validPart("2000-01-31T23:59:59"));
  assert.ok(!validPart("2000-13"), "month 13 rejected");
  assert.ok(!validPart("2000-00"), "month 00 rejected");
  assert.ok(!validPart("2000-01-32"), "day 32 rejected");
  assert.ok(!validPart("2000-01-00"), "day 00 rejected");
  assert.ok(!validPart("2000-01-01 24:00"), "hour 24 rejected");
  assert.ok(!validPart("2000-01-01 12:61"), "minute 61 rejected");
  // real-calendar validation - a plain 01–31 day range would accept impossible dates
  assert.ok(!validPart("2023-02-31"), "Feb 31 rejected");
  assert.ok(!validPart("2023-04-31"), "Apr 31 rejected (30-day month)");
  assert.ok(!validPart("2023-02-29"), "Feb 29 in a non-leap year rejected");
  assert.ok(validPart("2024-02-29"), "Feb 29 in a leap year accepted");
  // Date.UTC remaps years 0–99 to the 1900s; climate extents start at 0001-01-01
  assert.ok(validPart("0001-01-01"), "year 0001 accepted (not remapped to 1901)");
  assert.ok(validPart("0099-12-31"), "year 0099 accepted");
  assert.ok(validPart("0100-01-01"), "year 0100 accepted");
});

test("menu items and terminal tabs respond to the Space key", async () => {
  const { handle, root } = await mount(guardRouter());
  // row menu item via Space
  q<HTMLButtonElement>(root, "#fdb-results .row .kebab")!.click();
  await tick();
  const details = byText<HTMLElement>(root, ".pop-item", "Details");
  assert.ok(details);
  details!.dispatchEvent(new win.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  await tick();
  assert.ok(!q(root, ".info.collapsed"), "Details opened via Space");
  // terminal tab via Space
  const pyTab = q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement;
  pyTab.dispatchEvent(new win.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  assert.equal(handle.getState().terminalTab, "py", "tab switched via keyboard");
  handle.destroy();
});

// Performance contracts that are observable in jsdom

test("long facet value lists render in chunks with a working fallback affordance", async () => {
  const values: Array<string | number> = [];
  for (let i = 0; i < 150; i++) values.push(`v${i}`, i + 1);
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/")) {
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/x.nc" }],
          facets: { model: values },
          primary: ["model"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  openFacet(root, "model");
  const body = q<HTMLElement>(root, '.facet[data-key="model"] .facet-body') as HTMLElement;
  assert.equal(body.querySelectorAll(".fval").length, 60, "first chunk only");
  const more = q<HTMLButtonElement>(body, ".chunk-more");
  assert.ok(more, "fallback affordance present (no IntersectionObserver in jsdom)");
  more!.click();
  assert.equal(body.querySelectorAll(".fval").length, 120, "second chunk appended");
  // a late-chunk row is fully wired - the async-creation path gets the same listeners
  const late = body.querySelectorAll<HTMLElement>(".fval")[100];
  late.click();
  await wait(320);
  assert.equal(Object.keys(handle.getState().selected).length, 1, "late-chunk row listener works");
  handle.destroy();
});

test("focusing/picking a row patches in place; load-next appends without rebuilding", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/")) {
      const m = call.url.match(/[?&]start=(\d+)/);
      const start = m ? Number(m[1]) : 0;
      const rows = Array.from({ length: start === 0 ? 100 : 50 }, (_, i) => ({
        file: `/f_${start + i}.nc`,
      }));
      return { body: searchResponse({ total: 150, rows }) };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  const first = q<HTMLElement>(root, "#fdb-results .row") as HTMLElement;
  first.click();
  assert.ok(
    first.isConnected && first.classList.contains("focus"),
    "focus patched onto the SAME node",
  );
  (first.querySelector(".cb") as HTMLElement).click();
  assert.ok(
    first.isConnected && first.classList.contains("picked"),
    "pick patched onto the SAME node",
  );
  q<HTMLButtonElement>(root, ".load-next")!.click();
  await wait(30);
  assert.equal(handle.getState().rows.length, 150);
  assert.ok(first.isConnected, "existing rows were NOT rebuilt by the append");
  assert.equal(qa(root, "#fdb-results .row").length, 150, "new rows appended");
  assert.ok(first.classList.contains("picked"), "pick state survived the append");
  handle.destroy();
});

test("the theme flip suppresses transitions for exactly one committed frame", async () => {
  const { handle, root } = await mount(guardRouter());
  const app = root; // .freva-db carries data-theme
  const btn = q<HTMLButtonElement>(root, ".theme") as HTMLButtonElement;
  btn.click();
  assert.equal(app.getAttribute("data-notransition"), "true", "transitions off during the flip");
  assert.equal(app.getAttribute("data-theme"), "day");
  await wait(80); // two rAFs (rAF is timer-backed in the test env)
  assert.equal(app.getAttribute("data-notransition"), null, "transitions restored");
  handle.destroy();
});

test("the first search does not wait for /overview", async () => {
  const order: string[] = [];
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) {
      order.push("overview-start");
      return { body: overviewResponse(["freva"], {}), delayMs: 150 }; // slow overview
    }
    if (call.url.includes("/extended-search/")) {
      order.push("search-start");
      return { body: searchResponse({ total: 1, rows: [{ file: "/x.nc" }] }) };
    }
    return { body: {} };
  };
  installFetch(router);
  const host = makeHost();
  const handle = mountDataBrowser(host, {});
  await wait(60); // overview still pending
  assert.equal(
    handle.getState().search,
    "loaded",
    "search settled while overview was still in flight",
  );
  assert.ok(order.includes("search-start"), "search was issued without waiting");
  await wait(150);
  handle.destroy();
});

test("a no-auth 413 is caught by the HEAD preflight - error surfaced, nothing downloaded", async () => {
  const router = (call: { url: string; init?: RequestInit }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 5, rows: [{ file: "/a.nc" }] }) };
    if (call.url.includes("-catalogue/") && call.init?.method === "HEAD")
      return { status: 413, body: {} };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '[aria-label^="Export catalogue"]')!.click();
  await tick();
  byText<HTMLButtonElement>(root, ".xm-item", "Intake catalogue")!.click();
  await wait(50);
  assert.deepEqual(downloadClicks, [], "the 413 error body was NOT saved as a file");
  assert.match(
    q<HTMLElement>(root, ".status .mono")!.textContent ?? "",
    /too large/i,
    "the reason is surfaced",
  );
  handle.destroy();
});

test("catalogue download is handed to the BROWSER (streams to disk, no buffering)", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 5, rows: [{ file: "/a.nc" }] }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '[aria-label="Export catalogue"]')!.click();
  await tick();
  byText<HTMLButtonElement>(root, ".xm-item", "Intake catalogue")!.click();
  await wait(50);

  // the browser is given the URL directly - no JS fetch, so nothing is buffered in memory and the
  // response streams straight to disk
  assert.deepEqual(downloadClicks, ["freva-intake.json"], "a download was triggered");
  assert.match(
    downloadHrefs[0].href,
    /-catalogue\/|intake/,
    "the anchor points at the catalogue endpoint",
  );
  assert.equal(
    fetchCalls.filter((c) => c.url.includes("-catalogue/") && c.init?.method !== "HEAD").length,
    0,
    "the catalogue body is NOT fetched into memory by JS (a HEAD preflight carries no body)",
  );
  handle.destroy();
});

test("URI manifest export: data-search .txt handed to the browser with the same query scope", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [] }) };
    if (call.url.includes("/extended-search/")) {
      return {
        body: searchResponse({
          total: 5,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["cmip6", 5] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  // narrow to a facet so the export query is non-empty (same scope stac/intake would use)
  openFacet(root, "project");
  byText<HTMLElement>(root, ".side-scroll .fval", "cmip6")!.click();
  await wait(30);

  q<HTMLButtonElement>(root, '[aria-label="Export catalogue"]')!.click();
  await tick();
  const item = byText<HTMLButtonElement>(root, ".xm-item", "URI manifest");
  assert.ok(item, "the export menu offers a URI manifest, alongside Intake and STAC");
  item!.click();
  await wait(50);

  // handed straight to the browser (no JS fetch), a .txt filename, from the data-search endpoint,
  // carrying the current facet selection - the same scope stac/intake export.
  assert.deepEqual(downloadClicks, ["freva-uris.txt"], "a .txt manifest download fired");
  assert.match(downloadHrefs[0].href, /\/data-search\//, "points at the data-search endpoint");
  assert.match(downloadHrefs[0].href, /project=cmip6/, "carries the current facet query");
  assert.equal(
    fetchCalls.filter((c) => c.url.includes("/data-search/") && c.init?.method !== "HEAD").length,
    0,
    "the manifest body is NOT fetched into memory by JS (browser streams it; HEAD carries no body)",
  );
  handle.destroy();
});

test("two catalogue downloads can run at the same time", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 5, rows: [{ file: "/a.nc" }] }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  const openMenu = async (): Promise<void> => {
    q<HTMLButtonElement>(root, '[aria-label="Export catalogue"]')!.click();
    await tick();
  };
  await openMenu();
  byText<HTMLButtonElement>(root, ".xm-item", "Intake catalogue")!.click();
  await openMenu();
  byText<HTMLButtonElement>(root, ".xm-item", "STAC catalogue")!.click();
  await wait(50);
  // starting the second must NOT cancel the first - the downloads need independent abort channels
  assert.deepEqual(downloadClicks, ["freva-intake.json", "freva-stac.zip"], "both downloads fired");
  assert.equal(
    abortedUrls.filter((u: string) => u.includes("-catalogue/")).length,
    0,
    "neither was aborted",
  );
  handle.destroy();
});

// Pure helpers behind the commit guard

test("filterCommittable / selectionsEqual behave as the single commit guard", () => {
  const state: AppState = createInitialState({
    map: DEFAULT_MAP_CONFIG,
    inspectorUrl: "",
    apiBase: "",
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
  });
  // no metadata -> nothing commits
  let r = filterCommittable(state, { project: ["x"] });
  assert.deepEqual(r.accepted, {});
  assert.deepEqual(r.rejected, ["project=x"]);
  // closed set enforces values; open set accepts anything; unknown keys rejected
  state.facets = [
    { key: "project", label: "Project", values: [{ value: "cmip6", count: 1 }], hasMore: false },
    { key: "variable", label: "Variable", values: [{ value: "tas", count: 1 }], hasMore: true },
  ];
  r = filterCommittable(state, {
    project: ["cmip6", "nope"],
    variable: ["anything"],
    bogus: ["1"],
  });
  assert.deepEqual(r.accepted, { project: ["cmip6"], variable: ["anything"] });
  assert.deepEqual(r.rejected.sort(), ["bogus=1", "project=nope"]);

  assert.ok(selectionsEqual({ a: ["1"] }, { a: ["1"] }));
  assert.ok(!selectionsEqual({ a: ["1"] }, { a: ["1", "2"] }));
  assert.ok(!selectionsEqual({ a: ["1"] }, { b: ["1"] }));
  assert.ok(!selectionsEqual({}, { b: ["1"] }));
});
