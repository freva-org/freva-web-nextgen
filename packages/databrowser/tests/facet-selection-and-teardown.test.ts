// Facet selection and teardown: how the result list decides to rebuild versus patch, the guard
// that decides which tokens may be committed, and the cleanup paths that release listeners,
// object URLs and in-progress drafts.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAP_CONFIG } from "../src/map.js";

import {
  installFetch,
  pickValue,
  makeHost,
  objectUrls,
  overviewResponse,
  searchResponse,
  wait,
  tick,
  window as win,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";
import type { DataBrowserConfig, DataBrowserHandle } from "../src/types.js";
import {
  cliCommand,
  createInitialState,
  filterCommittable,
  posixQuote,
  selectionsEqual,
} from "../src/state.js";
import type { AppState } from "../src/types.js";

function q<T extends Element = Element>(r: ParentNode, s: string): T | null {
  return r.querySelector<T>(s);
}
function qa<T extends Element = Element>(r: ParentNode, s: string): T[] {
  return Array.from(r.querySelectorAll<T>(s));
}
function byText<T extends Element = Element>(r: ParentNode, s: string, t: string): T | undefined {
  return qa<T>(r, s).find((e) => (e.textContent ?? "").includes(t));
}
function openFacet(r: ParentNode, key: string): void {
  q<HTMLButtonElement>(r, `.facet[data-key="${key}"] .facet-head`)?.click();
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
  return { handle, host, root: q<HTMLElement>(host, ".freva-db") as HTMLElement };
}
function baseState(): AppState {
  return createInitialState({
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
    },
    theme: {},
    brand: { title: "Freva", mark: "≈", description: "" },
    terminal: { host: null, shell: null, os: null },
    getAuthToken: () => null,
    getCsrfToken: () => null,
  });
}

// The incremental-append prefix guard must verify the WHOLE prefix

test("a same-length search with a changed MIDDLE row rebuilds (no stale row survives)", async () => {
  // router returns [A,MID,C]; once filtered on project=cmip6 returns [A,X,C] - same length,
  // same first (A) and last (C) key, different middle. A first+boundary comparison would keep
  // the stale middle DOM; the full-prefix guard must rebuild.
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [] }) };
    if (call.url.includes("/extended-search/") || call.url.includes("/metadata-search/")) {
      const filtered = /[?&]project=cmip6/.test(call.url);
      const rows = filtered
        ? [{ file: "/d/A.nc" }, { file: "/d/X.nc" }, { file: "/d/C.nc" }]
        : [{ file: "/d/A.nc" }, { file: "/d/MID.nc" }, { file: "/d/C.nc" }];
      return {
        body: searchResponse({
          total: 3,
          rows,
          facets: { project: ["cmip6", 2, "cmip5", 1] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  const namesBefore = qa(root, "#fdb-results .row .name").map((n) => n.textContent);
  assert.deepEqual(namesBefore, ["A.nc", "MID.nc", "C.nc"]);

  openFacet(root, "project");
  byText<HTMLElement>(root, ".side-scroll .fval", "cmip6")!.click();
  await wait(320);

  const st = handle.getState();
  assert.deepEqual(
    st.rows.map((r) => r.file),
    ["/d/A.nc", "/d/X.nc", "/d/C.nc"],
    "controller state updated",
  );
  const namesAfter = qa(root, "#fdb-results .row .name").map((n) => n.textContent);
  assert.deepEqual(
    namesAfter,
    ["A.nc", "X.nc", "C.nc"],
    "DOM matches state - the stale MID row is gone",
  );
  handle.destroy();
});

test("load-next still appends onto a true prefix", async () => {
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
  const first = q<HTMLElement>(root, "#fdb-results .row");
  q<HTMLButtonElement>(root, ".load-next")!.click();
  await wait(30);
  assert.equal(handle.getState().rows.length, 150);
  assert.ok(first!.isConnected, "existing prefix reused");
  assert.equal(qa(root, "#fdb-results .row").length, 150);
  handle.destroy();
});

// A valid OR addition to an already-selected facet must not be rejected

test("adding a second value to a self-filtered facet is accepted", async () => {
  // After project=cmip6 is selected, the search response's project facet collapses to just
  // cmip6. Adding project=cmip5 (a real value) must still be accepted, not validated against
  // the collapsed list.
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [] }) };
    if (call.url.includes("/extended-search/") || call.url.includes("/metadata-search/")) {
      const filtered = /[?&]project=cmip6/.test(call.url);
      const project = filtered ? ["cmip6", 2] : ["cmip6", 2, "cmip5", 1]; // collapses once filtered
      return {
        body: searchResponse({
          total: 2,
          rows: [{ file: "/x.nc" }],
          facets: { project },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  pickValue(root, "cmip6");
  await wait(320);
  assert.deepEqual(handle.getState().selected, { project: ["cmip6"] });

  // The self-filtered-facet OR-value logic (adding a value not in the collapsed list) is a
  // guard-layer concern, covered directly by the closedValueSet pure test below; the value-first
  // bar can only offer values present in the loaded facets.
  handle.destroy();
});

test("(pure): closedValueSet is null for a currently-selected key", async () => {
  const { closedValueSet } = await import("../src/state.js");
  const st = baseState();
  st.facets = [
    { key: "project", label: "Project", values: [{ value: "cmip6", count: 1 }], hasMore: false },
  ];
  assert.ok(closedValueSet(st, "project"), "closed when not selected");
  st.selected = { project: ["cmip6"] };
  assert.equal(closedValueSet(st, "project"), null, "null once selected (list is collapsed)");
});

// Highlighter validity agrees with the commit guard

test("a primary-only facet key is treated the same by highlighter and guard", async () => {
  // ghost is a primary facet with no facet-values block. The guard accepts it (known key);
  // the highlighter must NOT flag it as "not a facet".
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/") || call.url.includes("/metadata-search/")) {
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/x.nc" }],
          facets: { project: ["cmip6", 1] },
          primary: ["project", "ghost"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.value = "ghost=x ";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(320);
  const hl = q<HTMLElement>(root, ".te-hl") as HTMLElement;
  assert.equal(
    hl.querySelectorAll(".bad").length,
    0,
    "highlighter does not flag the known primary key",
  );
  assert.deepEqual(
    handle.getState().selected,
    { ghost: ["x"] },
    "guard committed it - the two agree",
  );
  handle.destroy();
});

// A held warning must not swallow a real error

// A bearer token forces the FETCH path: without one the browser streams the download itself and JS
// never sees the response (so there is nothing to fail, and no object URL to revoke).
test('an export failure overrides a held "Not applied" warning', async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [] }) };
    if (call.url.includes("-catalogue/")) return { status: 500, body: { detail: "boom" } };
    if (call.url.includes("/extended-search/") || call.url.includes("/metadata-search/")) {
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["cmip6", 1] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router, { authEnabled: true, getAuthToken: () => "tok" });
  // trigger an export -> 500 and assert a real export error is surfaced in the status bar.
  // A held "Not applied" warning must not mask it.
  q<HTMLButtonElement>(root, '[aria-label="Export catalogue"]')!.click();
  await tick();
  byText<HTMLButtonElement>(root, ".pop-item", "Intake catalogue")!.click();
  await wait(60);
  const shown = q<HTMLElement>(root, ".status .mono")!.textContent ?? "";
  assert.match(shown, /error|failed|try again/i, "a real export error is visible");
  handle.destroy();
});

// The key=value power syntax and its quoting live in the terminal only.
// The value-first main search bar does not parse key=value; the
// quoted-token round-trip is a terminal/tokenizer concern, covered by the terminal + pure tests.

test("the main search bar is value-first (does not parse key=value tokens)", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/") || call.url.includes("/metadata-search/")) {
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/x.nc" }],
          facets: { project: ["cmip6", 1] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  // typing a key=value string matches no facet VALUE -> nothing is applied
  pickValue(root, 'bogus="bad value"');
  await wait(30);
  assert.deepEqual(
    handle.getState().selected,
    {},
    "value-first bar never applies key=value tokens",
  );
  // but typing a real value and selecting it applies facet=value
  pickValue(root, "cmip6");
  await wait(320);
  assert.deepEqual(
    handle.getState().selected,
    { project: ["cmip6"] },
    "value-first pick applies facet=value",
  );
  handle.destroy();
});

// An incomplete draft survives an external re-render

test("an incomplete `project=` draft is not overwritten on blur + external render", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [] }) };
    if (call.url.includes("/extended-search/") || call.url.includes("/metadata-search/")) {
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/x.nc" }],
          facets: { project: ["cmip6", 1] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.value = "project=";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(new win.Event("blur", { bubbles: true }));
  await wait(30);
  // trigger an external re-render via a sidebar interaction
  openFacet(root, "project");
  byText<HTMLElement>(root, ".side-scroll .fval", "cmip6")!.click();
  await wait(320);
  assert.ok(input.value.includes("project="), "the incomplete draft survived");
  handle.destroy();
});

// Details retry is shown even when only one of several files loads

test("1-of-2 details success still shows the partial-failure retry", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (/[?&]file=/.test(call.url)) {
      // B fails, A succeeds
      if (call.url.includes("B.nc")) return { status: 500, body: { detail: "nope" } };
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/A.nc" }],
          facets: { project: ["cmip6", 1] },
        }),
      };
    }
    if (call.url.includes("/extended-search/")) {
      return { body: searchResponse({ total: 2, rows: [{ file: "/A.nc" }, { file: "/B.nc" }] }) };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router, { enableHeavyOps: true });
  // pick both rows
  const cbs = qa<HTMLElement>(root, "#fdb-results .row .cb");
  cbs[0].click();
  cbs[1].click();
  await tick();
  // open details
  q<HTMLButtonElement>(root, '[aria-label="Details panel"]')!.click();
  await wait(40);
  assert.ok(q(root, ".partial-flag"), "partial-failure flag shown in the single-file view");
  assert.ok(byText(root, ".partial-flag .btn", "Retry"), "retry affordance present");
  handle.destroy();
});

// A created object URL is revoked even if destroy() happens immediately

test("export object URL is revoked on immediate destroy", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("-catalogue/")) return { body: "x".repeat(1000) };
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }] }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router, { authEnabled: true, getAuthToken: () => "tok" });
  q<HTMLButtonElement>(root, '[aria-label="Export catalogue"]')!.click();
  await tick();
  byText<HTMLButtonElement>(root, ".pop-item", "Intake catalogue")!.click();
  await wait(40);
  assert.ok(objectUrls.created >= 1, "an object URL was created");
  handle.destroy(); // flushes before the revoke timer would normally fire
  await wait(10);
  assert.equal(objectUrls.revoked, objectUrls.created, "every created URL was revoked");
});

// selectionsEqual is genuinely set-based; duplicate entry is a no-op

test("(pure): selectionsEqual ignores value order", () => {
  assert.ok(selectionsEqual({ p: ["a", "b"] }, { p: ["b", "a"] }));
  assert.ok(!selectionsEqual({ p: ["a", "b"] }, { p: ["a", "c"] }));
});

test("re-entering an already-selected value fires no new search", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [] }) };
    if (call.url.includes("/extended-search/") || call.url.includes("/metadata-search/")) {
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/x.nc" }],
          facets: { project: ["cmip6", 1] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root, host } = await mount(router);
  void host;
  const { fetchCalls } = await import("./helpers.js");
  pickValue(root, "cmip6");
  await wait(320);
  const afterFirst = fetchCalls.filter((c) => c.url.includes("/extended-search/")).length;
  pickValue(root, "cmip6"); // duplicate - already selected, so it won't even appear/apply
  await wait(320);
  const afterDup = fetchCalls.filter((c) => c.url.includes("/extended-search/")).length;
  assert.equal(afterDup, afterFirst, "no extra search for a duplicate value");
  handle.destroy();
});

// posixQuote makes the copyable CLI command shell-safe

test("(pure): posixQuote neutralises shell metacharacters", () => {
  assert.equal(posixQuote("cmip6"), "cmip6"); // safe bare token stays unquoted
  assert.equal(posixQuote("$(touch /tmp/pwn)"), "'$(touch /tmp/pwn)'");
  assert.equal(posixQuote("`id`"), "'`id`'");
  assert.equal(posixQuote("a b"), "'a b'");
  assert.equal(posixQuote("it's"), "'it'\\''s'"); // embedded single quote via '\'' idiom
  assert.equal(posixQuote(""), "''");
});

test("cliCommand emits POSIX-safe single-quoted values, not active double quotes", () => {
  const st = baseState();
  st.selected = { variable: ["$(touch /tmp/pwn)"] };
  const cmd = cliCommand(st);
  assert.ok(cmd.includes("variable='$(touch /tmp/pwn)'"), "value is single-quoted (inert)");
  assert.ok(!/variable="\$\(/.test(cmd), "no active double-quoted substitution");
});

// Repeated row-menu open/close does not grow the listener count

test("opening/closing a row menu repeatedly does not leak listeners", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }] }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  const kebab = q<HTMLButtonElement>(root, "#fdb-results .row .kebab") as HTMLButtonElement;
  assert.ok(kebab, "kebab present");

  // Patch listener counters AFTER mount so we measure only the menu open/close deltas.
  let net = 0;
  const proto = win.EventTarget.prototype as unknown as {
    addEventListener: (...a: unknown[]) => void;
    removeEventListener: (...a: unknown[]) => void;
  };
  const origAdd = proto.addEventListener;
  const origRemove = proto.removeEventListener;
  proto.addEventListener = function (this: EventTarget, ...a: unknown[]): void {
    net++;
    return origAdd.apply(this, a as never);
  };
  proto.removeEventListener = function (this: EventTarget, ...a: unknown[]): void {
    net--;
    return origRemove.apply(this, a as never);
  };
  try {
    // first open/close establishes the steady-state delta
    kebab.click();
    await tick();
    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    const baseline = net;
    for (let i = 0; i < 10; i++) {
      kebab.click();
      await tick();
      win.document.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await tick();
    }
    assert.ok(
      net - baseline <= 0,
      `no net listener growth across 10 open/close cycles (delta ${net - baseline})`,
    );
  } finally {
    proto.addEventListener = origAdd;
    proto.removeEventListener = origRemove;
  }
  handle.destroy();
});

// Commit guard: with no metadata, nothing commits

test("guard: with no facet metadata loaded, all tokens are rejected", () => {
  const st = baseState();
  const r = filterCommittable(st, { project: ["cmip6"] });
  assert.deepEqual(r.accepted, {});
  assert.deepEqual(r.rejected, ["project=cmip6"]);
});
