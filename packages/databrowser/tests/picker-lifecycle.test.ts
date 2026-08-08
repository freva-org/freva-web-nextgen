// Lifecycle correctness for the picker: flavour transitions, the validity of a query reference, the
// active-descendant contract, and the alias-freedom of everything handed to a host.
//
// The common thread is TIME: a flavour map that has not arrived yet, a result that belongs to a
// question the user has already changed, an option element that has been recycled away, an object
// handed out and then mutated. Each is individually invisible and jointly the difference between
// "works in the demo" and "works in a lab".

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchCalls,
  installFetch,
  makeHost,
  overviewResponse,
  searchResponse,
  tick,
  wait,
  window as win,
} from "./helpers.js";
import { mountDataPicker } from "../src/picker/mount.js";
import type { DataPickerConfig, DataPickerHandle, FlavourMapping } from "../src/picker/types.js";
import type { SearchClient, SearchRequest } from "../src/search/engine.js";
import type { SearchResult } from "../src/types.js";

const CUSTOM_MAP: FlavourMapping[] = [
  { flavour_name: "custom", mapping: { project: "dataset", variable: "var_name" } },
];

function rows(n: number, prefix = "/archive/tas"): Array<{ file: string; fs_type: string }> {
  return Array.from({ length: n }, (_, i) => ({ file: `${prefix}_${i}.nc`, fs_type: "posix" }));
}

const result = (
  n: number,
  total = n,
  facets: Record<string, Array<string | number>> = { project: ["cmip6", 9, "cordex", 4] },
): SearchResult =>
  searchResponse({
    total,
    rows: rows(n),
    facets,
    primary: Object.keys(facets),
  }) as unknown as SearchResult;

function scriptedClient(
  answer: (req: SearchRequest) => SearchResult | Promise<SearchResult>,
): SearchClient & { requests: SearchRequest[] } {
  const requests: SearchRequest[] = [];
  return {
    requests,
    async search(req) {
      requests.push(req);
      return answer(req);
    },
  };
}

/** A `resolveFlavourMaps` hook the test decides when (and whether) to settle. */
function mapGate(): {
  hook: () => Promise<FlavourMapping[]>;
  resolve: (m?: FlavourMapping[]) => void;
  reject: () => void;
} {
  const g: { res?: (m: FlavourMapping[]) => void; rej?: (e: Error) => void } = {};
  const p = new Promise<FlavourMapping[]>((res, rej) => {
    g.res = res;
    g.rej = rej;
  });
  return {
    hook: () => p,
    resolve: (m = CUSTOM_MAP) => g.res?.(m),
    reject: () => g.rej?.(new Error("flavours unavailable")),
  };
}

async function mount(
  config: DataPickerConfig = {},
): Promise<{ handle: DataPickerHandle; root: HTMLElement; host: HTMLElement }> {
  const host = makeHost();
  const handle = mountDataPicker(host, { debounceMs: 1, ...config });
  await wait(30);
  const root = host.querySelector(".freva-picker") as HTMLElement;
  assert.ok(root, "the picker did not mount");
  return { handle, root, host };
}

function q<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const n = root.querySelector<T>(sel);
  assert.ok(n, `missing ${sel}`);
  return n;
}

const last = <T>(a: readonly T[]): T | undefined => (a.length ? a[a.length - 1] : undefined);
const searchUrls = (): string[] =>
  fetchCalls.filter((c) => c.url.includes("/extended-search/")).map((c) => c.url);

// 1. Flavour transitions are atomic with mapping resolution

test("a restored selection on a not-yet-mappable gated key is dropped once the map lands", async () => {
  // Before the map, `baseFilterKeys` cannot translate the scope's `project` into this flavour, so
  // `dataset` does not look gated and survives - leaving state the wire correctly ignores.
  const gate = mapGate();
  const client = scriptedClient(() => result(2));
  const { handle, root, host } = await mount({
    client,
    flavour: "custom",
    baseFilters: { project: "waterpark" },
    resolveFlavourMaps: gate.hook,
    initialState: { selected: { dataset: ["other"] } },
  });
  try {
    await wait(30);
    assert.equal(client.requests.length, 0, "a request went out before the map arrived");

    gate.resolve();
    await wait(60);

    assert.deepEqual(handle.getState().selected, {}, "inert state survived the mapping");
    assert.equal(root.querySelectorAll(".fp-chip").length, 0);
    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0].query, "dataset=waterpark");
    // The now-known mapping also makes the facet render locked.
    assert.ok(q(root, ".fp-scope").textContent?.includes("waterpark"));
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("switching to a custom lens before the map arrives sends nothing, then exactly one mapped request", async () => {
  const gate = mapGate();
  const reset = installFetch(({ url }) => {
    if (url.includes("/overview")) {
      return { body: overviewResponse(["freva", "custom"], { freva: ["project", "variable"] }) };
    }
    return { body: searchResponse({ total: 3, rows: rows(3), facets: { project: ["cmip6", 3] } }) };
  });
  const host = makeHost();
  const handle = mountDataPicker(host, {
    debounceMs: 1,
    apiBase: "/api/x",
    features: { flavour: true },
    resolveFlavourMaps: gate.hook,
    initialState: { selected: { project_not_: ["cmip5"] } },
  });
  try {
    await wait(50);
    const root = host.querySelector(".freva-picker") as HTMLElement;
    const before = searchUrls().length;
    assert.ok(before >= 1, "the freva search never ran");

    const sel = q<HTMLSelectElement>(root, ".fp-flavour");
    sel.value = "custom";
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await wait(60);

    // NOTHING for the new lens: the old key would have been silently wrong and never retried.
    assert.equal(
      searchUrls().length,
      before,
      `a premature request went out: ${last(searchUrls())}`,
    );
    assert.equal(handle.getState().flavour, "freva", "the lens changed before it could be entered");
    assert.deepEqual(handle.getState().selected, { project_not_: ["cmip5"] });
    assert.match(q(root, ".fp-state").textContent ?? "", /Preparing scoped browsing/);
    // The control still shows what the user asked for.
    assert.equal(sel.value, "custom");

    gate.resolve();
    await wait(80);

    const added = searchUrls().slice(before);
    assert.equal(
      added.length,
      1,
      `expected one request, got ${added.length}: ${added.join(" | ")}`,
    );
    assert.match(added[0], /\/extended-search\/custom\/file\?/);
    assert.match(added[0], /dataset_not_=cmip5/);
    assert.doesNotMatch(added[0], /project_not_/);
    assert.deepEqual(handle.getState().selected, { dataset_not_: ["cmip5"] });
    assert.equal(handle.getState().flavour, "custom");
  } finally {
    handle.destroy();
    host.remove();
    reset();
  }
});

test("setState({ flavour }) alone TRANSLATES the existing selection", async () => {
  const client = scriptedClient(() => result(3));
  const { handle, host } = await mount({
    client,
    initialState: { selected: { project_not_: ["cmip5"], variable: ["tas"] } },
  });
  try {
    handle.setState({ flavour: "cmip6" });
    await wait(40);
    assert.deepEqual(handle.getState().selected, {
      mip_era_not_: ["cmip5"],
      variable_id: ["tas"],
    });
    assert.equal(handle.getState().flavour, "cmip6");
    const req = last(client.requests);
    assert.equal(req?.flavour, "cmip6");
    assert.match(req?.query ?? "", /mip_era_not_=cmip5/);
    assert.doesNotMatch(req?.query ?? "", /project_not_/);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("setState({ flavour, selected }) treats the keys as ALREADY in that flavour", async () => {
  const client = scriptedClient(() => result(3));
  const { handle, host } = await mount({
    client,
    initialState: { selected: { project_not_: ["cmip5"] } },
  });
  try {
    handle.setState({ flavour: "cmip6", selected: { mip_era_not_: ["cmip5"] } });
    await wait(40);
    // Verbatim - NOT translated a second time into something like `mip_era_not__not_`.
    assert.deepEqual(handle.getState().selected, { mip_era_not_: ["cmip5"] });
    assert.match(last(client.requests)?.query ?? "", /mip_era_not_=cmip5/);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("a FAILED mapping on a lens switch keeps the last valid state and issues no request", async () => {
  const gate = mapGate();
  const reset = installFetch(({ url }) => {
    if (url.includes("/overview")) {
      return { body: overviewResponse(["freva", "custom"], { freva: ["project"] }) };
    }
    return { body: searchResponse({ total: 3, rows: rows(3), facets: { project: ["cmip6", 3] } }) };
  });
  const host = makeHost();
  const handle = mountDataPicker(host, {
    debounceMs: 1,
    apiBase: "/api/x",
    features: { flavour: true },
    baseFilters: { project: "waterpark" },
    resolveFlavourMaps: gate.hook,
    initialState: { selected: { variable: ["tas"] } },
  });
  try {
    await wait(50);
    const root = host.querySelector(".freva-picker") as HTMLElement;
    const before = searchUrls().length;
    const sel = q<HTMLSelectElement>(root, ".fp-flavour");
    sel.value = "custom";
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await wait(40);

    gate.reject();
    await wait(80);

    assert.equal(searchUrls().length, before, "a request went out after a failed mapping");
    assert.equal(handle.getState().flavour, "freva", "the lens changed anyway");
    assert.deepEqual(handle.getState().selected, { variable: ["tas"] }, "the selection was lost");
    const state = q(root, ".fp-state");
    assert.ok(state.classList.contains("err"));
    assert.match(state.textContent ?? "", /Scoped browsing is unavailable/);
    // The control snaps back to the lens the picker is actually on.
    assert.equal(sel.value, "freva");
  } finally {
    handle.destroy();
    host.remove();
    reset();
  }
});

// 2. A query reference describes a real, current search

test("query mode is withdrawn when the lens becomes unmappable - no stale count, no wrong key", async () => {
  const gate = mapGate();
  const client = scriptedClient(() => result(9, 9));
  const { handle, root, host } = await mount({
    client,
    flavour: "freva",
    baseFilters: { project: "waterpark" },
    features: { allFiltered: true, flavour: false },
    resolveFlavourMaps: gate.hook,
  });
  try {
    await wait(40);
    // A real, successful, scoped search first.
    assert.equal(client.requests.length, 1);
    const all = q<HTMLButtonElement>(root, '.fp-mode[data-mode="query"]');
    assert.equal(all.disabled, false);
    all.click();
    await tick();
    const good = handle.getReference();
    assert.equal(good?.kind, "query");
    assert.equal(good?.kind === "query" ? good.estimatedCount : 0, 9);

    // Now ask for a lens whose mapping never arrives.
    handle.setState({ flavour: "custom" });
    await wait(20);
    gate.reject();
    await wait(80);

    assert.match(q(root, ".fp-state").textContent ?? "", /Scoped browsing is unavailable/);
    assert.equal(handle.getReference(), null, "a query reference survived a mapping failure");
    assert.equal(q<HTMLButtonElement>(root, ".fp-add").disabled, true);
    assert.equal(q<HTMLButtonElement>(root, '.fp-mode[data-mode="query"]').disabled, true);
    // The stale number is suppressed rather than shown next to a control it no longer describes.
    assert.doesNotMatch(q(root, '.fp-mode[data-mode="query"]').textContent ?? "", /\b9\b/);
    assert.equal(client.requests.length, 1, "a request went out for the unmappable lens");
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("query mode is unavailable while results belong to an older revision, and after a failure", async () => {
  let mode: "ok" | "fail" = "ok";
  const client: SearchClient = {
    search: (req) =>
      new Promise<SearchResult>((resolve, reject) => {
        const t = setTimeout(() => {
          if (mode === "fail") reject(new Error("Service error - try again."));
          else resolve(result(9, 9));
        }, 40);
        req.signal.addEventListener("abort", () => {
          clearTimeout(t);
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }),
  };
  const { handle, root, host } = await mount({ client, debounceMs: 5 });
  try {
    await wait(80);
    q<HTMLButtonElement>(root, '.fp-mode[data-mode="query"]').click();
    await tick();
    assert.equal(handle.getReference()?.kind, "query");

    // Change the question: the visible count now answers a question nobody asked.
    handle.setState({ selected: { project: ["cordex"] } });
    await tick();
    assert.equal(handle.getReference(), null, "a stale-revision query reference was offered");
    assert.equal(q<HTMLButtonElement>(root, ".fp-add").disabled, true);
    assert.equal(q<HTMLButtonElement>(root, '.fp-mode[data-mode="query"]').disabled, true);

    await wait(120); // the replacement lands
    assert.equal(handle.getReference()?.kind, "query");
    assert.equal(q<HTMLButtonElement>(root, ".fp-add").disabled, false);

    // A failed search likewise withdraws it.
    mode = "fail";
    handle.setState({ selected: { project: ["cmip6"] } });
    await wait(120);
    assert.equal(handle.getReference(), null, "a query reference survived a failed search");
    assert.equal(q<HTMLButtonElement>(root, ".fp-add").disabled, true);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("explicit assets stay committable through every state a query reference is withdrawn in", async () => {
  const client: SearchClient = {
    async search() {
      throw new Error("Service error - try again.");
    },
  };
  const { handle, root, host } = await mount({
    client,
    initialState: { assets: [{ id: "a", uri: "https://store.example/a.nc" }] },
  });
  try {
    await wait(40);
    // The search failed outright…
    assert.match(q(root, ".fp-state").textContent ?? "", /Service error/);
    // …and the files the user already chose are still committable, because they do not depend on it.
    const ref = handle.getReference();
    assert.equal(ref?.kind, "asset");
    assert.equal(q<HTMLButtonElement>(root, ".fp-add").disabled, false);
  } finally {
    handle.destroy();
    host.remove();
  }
});

// 3. The active-descendant lifecycle

test("aria-activedescendant never outlives the option it names", async () => {
  let n = 20;
  const client = scriptedClient(() => result(n, n));
  const { handle, root, host } = await mount({ client });
  try {
    const scroller = q(root, ".fp-scroll");
    const activeId = (): string | null => scroller.getAttribute("aria-activedescendant");
    const namesLiveElement = (): boolean => {
      const id = activeId();
      return id === null || !!root.querySelector(`#${id}`);
    };

    scroller.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.ok(activeId(), "ArrowDown did not activate an option");
    assert.ok(namesLiveElement());

    // A new result set replaces every option: the id must go with them.
    n = 5;
    handle.setState({ selected: { project: ["cordex"] } });
    await wait(40);
    assert.equal(activeId(), null, "a stale descendant id survived a new result set");
    assert.ok(namesLiveElement());

    // An EMPTY result set renders no options at all.
    scroller.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.ok(activeId());
    n = 0;
    handle.setState({ selected: { project: ["nothing"] } });
    await wait(40);
    assert.equal(root.querySelectorAll(".fp-row").length, 0);
    assert.equal(activeId(), null, "a stale descendant id survived an empty result set");
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("an ERROR state also clears the active option", async () => {
  let fail = false;
  const client: SearchClient = {
    async search() {
      if (fail) throw new Error("Service error - try again.");
      return result(10, 10);
    },
  };
  const { handle, root, host } = await mount({ client });
  try {
    const scroller = q(root, ".fp-scroll");
    scroller.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.ok(scroller.getAttribute("aria-activedescendant"));
    fail = true;
    handle.setState({ selected: { project: ["cordex"] } });
    await wait(60);
    assert.equal(scroller.getAttribute("aria-activedescendant"), null);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("virtual options carry their position in the FULL result set", async () => {
  const client = scriptedClient(() => result(20, 873));
  const { handle, root, host } = await mount({ client });
  try {
    const options = [...root.querySelectorAll<HTMLElement>('[role="option"].fp-row')];
    assert.ok(options.length > 0);
    assert.equal(options[0].getAttribute("aria-posinset"), "1");
    assert.equal(options[1].getAttribute("aria-posinset"), "2");
    // The window shows a slice; the SET is the whole result set the server reported.
    for (const o of options) assert.equal(o.getAttribute("aria-setsize"), "873");
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("the search combobox keeps its own aria-activedescendant in step, and clears it on close", async () => {
  const client = scriptedClient(() => result(3));
  const { handle, root, host } = await mount({ client });
  try {
    const input = q<HTMLInputElement>(root, ".fp-input");
    assert.equal(input.getAttribute("aria-activedescendant"), null);

    input.value = "c";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    const first = input.getAttribute("aria-activedescendant");
    assert.ok(first, "no option was announced for the initial highlight");
    assert.equal(root.querySelector(`#${first}`)?.classList.contains("hl"), true);
    assert.equal(root.querySelector(`#${first}`)?.getAttribute("aria-posinset"), "1");

    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const second = input.getAttribute("aria-activedescendant");
    assert.notEqual(second, first, "the announced option did not follow the highlight");
    assert.equal(root.querySelector(`#${second}`)?.classList.contains("hl"), true);

    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(
      input.getAttribute("aria-activedescendant"),
      null,
      "a closed list still named an option",
    );
    assert.equal(input.getAttribute("aria-expanded"), "false");
  } finally {
    handle.destroy();
    host.remove();
  }
});

// 4. Nothing handed to a host aliases internal state

test("references and snapshots are deep copies - mutating one cannot reach the picker", async () => {
  const client = scriptedClient(() => result(3));
  const stac = { collection: "cmip6", item: "a", href: "https://stac.example/items/a" };
  const commits: unknown[] = [];
  const { handle, root, host } = await mount({
    client,
    onCommit: (r) => commits.push(r),
    initialState: { assets: [{ id: "a", uri: "https://s/a.nc", stac }] },
  });
  try {
    await wait(20);
    const ref = handle.getReference();
    assert.equal(ref?.kind, "asset");
    if (ref?.kind !== "asset") throw new Error("unreachable");

    // The nested `stac` object must not be shared with internal state.
    ref.asset.stac!.href = "https://evil.example/";
    ref.asset.uri = "https://evil.example/x.nc";
    assert.equal(handle.getState().assets[0].stac?.href, "https://stac.example/items/a");
    assert.equal(handle.getState().assets[0].uri, "https://s/a.nc");
    // getState() is a copy too, at every level.
    const st = handle.getState();
    st.assets[0].stac!.collection = "tampered";
    st.selected["injected"] = ["x"];
    assert.equal(handle.getState().assets[0].stac?.collection, "cmip6");
    assert.deepEqual(handle.getState().selected, {});

    // …and so is what onCommit receives.
    q<HTMLButtonElement>(root, ".fp-add").click();
    const committed = commits[0] as { asset: { stac: { href: string } } };
    committed.asset.stac.href = "https://also-evil.example/";
    assert.equal(handle.getState().assets[0].stac?.href, "https://stac.example/items/a");

    // Two references taken in a row do not share anything either.
    const a = handle.getReference();
    const b = handle.getReference();
    assert.notEqual(a, b);
    if (a?.kind === "asset" && b?.kind === "asset") assert.notEqual(a.asset.stac, b.asset.stac);
  } finally {
    handle.destroy();
    host.remove();
  }
});

// 6. The drag matrix

class FakeTransfer {
  readonly data = new Map<string, string>();
  effectAllowed = "none";
  dropEffect = "copy";
  setData(t: string, v: string): void {
    this.data.set(t, v);
  }
  getData(t: string): string {
    return this.data.get(t) ?? "";
  }
}

const dragFrom = (node: HTMLElement): FakeTransfer => {
  const dt = new FakeTransfer();
  const ev = new win.Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  node.dispatchEvent(ev);
  return dt;
};
const MIME = "application/vnd.freva.data-reference+json";

test("the drag matrix: selected row, unselected row, query mode, and the Add button", async () => {
  const client = scriptedClient(() => result(5, 5));
  const commits: unknown[] = [];
  const { handle, root, host } = await mount({ client, onCommit: (r) => commits.push(r) });
  try {
    const rowNodes = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".fp-row")];

    // Two rows selected
    rowNodes()[0].click();
    rowNodes()[1].click();
    await tick();

    // A SELECTED row drags the whole explicit selection - the same thing Add commits.
    const fromSelected = JSON.parse(dragFrom(rowNodes()[0]).getData(MIME)) as { kind: string };
    assert.equal(fromSelected.kind, "selection");
    assert.equal(JSON.stringify(fromSelected), JSON.stringify(handle.getReference()));

    // An UNSELECTED row drags just itself, and does not disturb the selection.
    const fromUnselected = JSON.parse(dragFrom(rowNodes()[3]).getData(MIME)) as {
      kind: string;
      asset: { uri: string };
    };
    assert.equal(fromUnselected.kind, "asset");
    assert.equal(fromUnselected.asset.uri, "/archive/tas_3.nc");
    assert.equal(handle.getState().assets.length, 2, "dragging changed the selection");

    // The Add button commits the SELECTION, not the row that was last dragged.
    q<HTMLButtonElement>(root, ".fp-add").click();
    assert.equal(commits.length, 1);
    assert.equal(JSON.stringify(commits[0]), JSON.stringify(fromSelected));

    // Query mode
    q<HTMLButtonElement>(root, '.fp-mode[data-mode="query"]').click();
    await tick();
    assert.equal(handle.getReference()?.kind, "query");

    // Dragging a ROW in query mode transfers THAT ASSET - a row is a file, whatever mode the
    // footer is in - while Add commits the query. Both are the same versioned contract; they are
    // deliberately not the same reference.
    const inQueryMode = JSON.parse(dragFrom(rowNodes()[0]).getData(MIME)) as { kind: string };
    assert.equal(inQueryMode.kind, "asset");
    q<HTMLButtonElement>(root, ".fp-add").click();
    assert.equal(commits.length, 2);
    assert.equal((commits[1] as { kind: string }).kind, "query");
  } finally {
    handle.destroy();
    host.remove();
  }
});

// 6. The mode radio group stays operable while query mode is unavailable

/** A client the test settles by hand, so "loading" and "stale" are real states, not sleeps. */
function gatedClient(): SearchClient & {
  requests: SearchRequest[];
  settle: (r: SearchResult) => void;
  fail: (msg?: string) => void;
  pending: number;
} {
  const queue: Array<{ res: (r: SearchResult) => void; rej: (e: Error) => void }> = [];
  const requests: SearchRequest[] = [];
  return {
    requests,
    get pending() {
      return queue.length;
    },
    settle(r) {
      queue.shift()?.res(r);
    },
    fail(msg = "search failed") {
      queue.shift()?.rej(new Error(msg));
    },
    search(req) {
      requests.push(req);
      return new Promise<SearchResult>((res, rej) => queue.push({ res, rej }));
    },
  };
}

const modeFiles = (r: ParentNode): HTMLButtonElement =>
  q<HTMLButtonElement>(r, '.fp-mode[data-mode="files"]');
const modeQuery = (r: ParentNode): HTMLButtonElement =>
  q<HTMLButtonElement>(r, '.fp-mode[data-mode="query"]');

/** The shape under test: which control is checked, which is reachable, which is dead. */
const groupState = (
  r: ParentNode,
): {
  checked: string;
  filesTabIndex: number;
  queryTabIndex: number;
  queryDisabled: boolean;
} => ({
  checked: modeQuery(r).getAttribute("aria-checked") === "true" ? "query" : "files",
  filesTabIndex: modeFiles(r).tabIndex,
  queryTabIndex: modeQuery(r).tabIndex,
  queryDisabled: modeQuery(r).disabled,
});

test("a disabled query radio is never the group's only tab stop - loading, stale, failure, recovery", async () => {
  const client = gatedClient();
  const { handle, root, host } = await mount({ client });
  try {
    // Loading: the first search has not answered yet
    await wait(20);
    assert.equal(client.requests.length, 1);
    assert.deepEqual(groupState(root), {
      checked: "files",
      filesTabIndex: 0,
      queryTabIndex: -1,
      queryDisabled: true,
    });
    // Arrowing right must not walk into a mode that cannot be entered.
    q(root, ".fp-modes").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await tick();
    assert.equal(handle.getState().useAllFiltered, false, "an arrow entered disabled query mode");

    // A successful, current result: normal radio navigation is restored
    client.settle(result(9, 120));
    await wait(30);
    assert.equal(groupState(root).queryDisabled, false);
    modeQuery(root).click();
    await tick();
    assert.deepEqual(groupState(root), {
      checked: "query",
      filesTabIndex: -1,
      queryTabIndex: 0,
      queryDisabled: false,
    });
    assert.equal(handle.getReference()?.kind, "query");
    modeQuery(root).focus();
    assert.equal(win.document.activeElement, modeQuery(root));

    // Stale: a replacement search is in flight while query mode is CHECKED
    handle.setState({ selected: { project: ["cordex"] } });
    await wait(20);
    assert.equal(client.pending, 1, "the replacement search is not actually in flight");
    const stale = groupState(root);
    assert.equal(stale.checked, "query", "the checked mode changed on its own");
    assert.equal(stale.queryDisabled, true, "a stale count is still offered as an answer");
    // The only tab stop must not be the disabled radio, with focus left sitting on it.
    assert.equal(stale.queryTabIndex, -1, "a disabled radio kept the group's tab stop");
    assert.equal(stale.filesTabIndex, 0, "there is no reachable control in the group");
    assert.equal(
      win.document.activeElement,
      modeFiles(root),
      "focus was left on the disabled radio",
    );
    // …and nothing was committed or materialised on the way.
    assert.equal(handle.getReference(), null, "a stale query reference was still offered");
    assert.equal(root.querySelectorAll(".fp-row.picked").length, 0);

    // Failure: same guarantees
    client.fail();
    await wait(30);
    const failed = groupState(root);
    assert.equal(failed.queryDisabled, true);
    assert.equal(failed.filesTabIndex, 0);
    assert.equal(failed.queryTabIndex, -1);
    assert.equal(handle.getReference(), null);

    // Recovery
    handle.setState({ selected: {} });
    await wait(20);
    client.settle(result(9, 120));
    await wait(30);
    assert.equal(groupState(root).queryDisabled, false, "query mode never came back");
    q(root, ".fp-modes").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await tick();
    assert.deepEqual(groupState(root), {
      checked: "query",
      filesTabIndex: -1,
      queryTabIndex: 0,
      queryDisabled: false,
    });
    assert.equal(handle.getReference()?.kind, "query");
  } finally {
    handle.destroy();
    host.remove();
  }
});

// 7. Repainting the Time/Area controls does not accumulate listeners

test("toggling the Time and Area disclosures keeps the listener count bounded, and destroy clears it", async () => {
  // `paintControls()` allocates new inputs and new disclosure buttons and registers listeners for
  // all of them on `ctlBucket`. The disclosure toggle must flush that bucket first: without that,
  // every open and close leaves a full set of dead registrations behind - 2 live control listeners
  // on mount become 42 after twenty toggles.
  //
  // Counting is done by instrumenting `EventTarget` itself rather than by reading a private
  // disposer count: a leak is a listener the DOM still holds, which is the thing to measure.
  const client = scriptedClient(() => result(5, 5));
  const proto = win.EventTarget.prototype;
  const addOrig = proto.addEventListener;
  const remOrig = proto.removeEventListener;
  const live = new Map<EventTarget, Map<string, Set<unknown>>>();
  const count = (): number => {
    let n = 0;
    for (const byType of live.values()) for (const fns of byType.values()) n += fns.size;
    return n;
  };
  proto.addEventListener = function (this: EventTarget, type: string, fn: never, ...rest: never[]) {
    const byType = live.get(this) ?? new Map<string, Set<unknown>>();
    const fns = byType.get(type) ?? new Set<unknown>();
    fns.add(fn);
    byType.set(type, fns);
    live.set(this, byType);
    return addOrig.call(this, type, fn, ...rest);
  } as typeof proto.addEventListener;
  proto.removeEventListener = function (
    this: EventTarget,
    type: string,
    fn: never,
    ...rest: never[]
  ) {
    live.get(this)?.get(type)?.delete(fn);
    return remOrig.call(this, type, fn, ...rest);
  } as typeof proto.removeEventListener;

  const baseline = count(); // everything the harness and earlier tests already hold
  let handle: DataPickerHandle | null = null;
  let host: HTMLElement | null = null;
  try {
    const m = await mount({ client, features: { time: true, bbox: true } });
    handle = m.handle;
    host = m.host;
    const root = m.root;

    const owned = (): number => count() - baseline; // listeners this picker is responsible for
    const atMount = owned();
    assert.ok(atMount > 0, "the instrumentation saw nothing at all");

    const heads = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".fp-disc-h")];
    assert.equal(heads().length, 2, "expected a Time and an Area disclosure");

    // Twenty toggles. Each one rebuilds the controls; with the bucket flushed, the count returns
    // to where it started rather than climbing by one set per toggle.
    for (let i = 0; i < 20; i++) {
      heads()[i % 2].click();
      await tick();
    }
    const afterToggles = owned();
    // The only legitimate difference is the inputs of whichever disclosure is open (Time has 2,
    // Area has 4). Twenty toggles must not add twenty sets - a growth of 40.
    assert.ok(
      afterToggles <= atMount + 4,
      `listeners grew with use: ${atMount} at mount, ${afterToggles} after 20 toggles`,
    );

    // Open BOTH and toggle twenty more times: still bounded by the same ceiling.
    for (const h of heads()) if (h.getAttribute("aria-expanded") === "false") h.click();
    await tick();
    const bothOpen = owned();
    for (let i = 0; i < 20; i++) {
      heads()[i % 2].click();
      await tick();
      heads()[i % 2].click();
      await tick();
    }
    assert.ok(
      owned() <= bothOpen + 4,
      `a second round grew the count: ${bothOpen} then ${owned()}`,
    );

    handle.destroy();
    handle = null;
    assert.equal(owned(), 0, `destroy left ${owned()} listeners behind`);
  } finally {
    proto.addEventListener = addOrig;
    proto.removeEventListener = remOrig;
    handle?.destroy();
    host?.remove();
  }
});
