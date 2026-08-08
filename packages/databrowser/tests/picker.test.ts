// The mounted picker: behaviour a lab integrator depends on.
//
// jsdom performs no layout, so anything positional lives in browser-tests/picker.mjs instead. What
// is asserted here is logic, and the subtle parts of it: picks stored as row keys must not
// evaporate when the row scrolls off, the base scope must be enforced in the UI and not only on
// the wire or it happily creates inert filters, a scoped custom flavour must not search with the
// unmapped key, a lens change must not throw the whole selection away, a disabled feature must not
// be enterable through restored state, `aria-hidden` on the virtual spacer must not hide every
// option from assistive technology, and an accepted drag must commit exactly once.

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
import { FREVA_DATA_REFERENCE_MIME, isDataReference } from "../src/picker/reference.js";
import type { DataReference } from "../src/picker/reference.js";
import type {
  DataPickerConfig,
  DataPickerHandle,
  FlavourMapping,
  PickerState,
} from "../src/picker/types.js";
import type { SearchClient, SearchRequest } from "../src/search/engine.js";
import type { SearchResult } from "../src/types.js";

const FACETS: Record<string, Array<string | number>> = {
  project: ["cmip6", 40, "cordex", 12],
  variable: ["tas", 30, "pr", 22],
};

function rows(n: number, prefix = "/archive/tas"): Array<{ file: string; fs_type: string }> {
  return Array.from({ length: n }, (_, i) => ({ file: `${prefix}_${i}.nc`, fs_type: "posix" }));
}

/** Last element - `Array.prototype.at` is newer than this package's ES2020 target. */
const last = <T>(a: readonly T[]): T | undefined => (a.length ? a[a.length - 1] : undefined);

/** A scripted client: records every request and answers from a callback. */
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

const result = (
  n: number,
  total = n,
  facets: Record<string, Array<string | number>> = FACETS,
  prefix = "/archive/tas",
): SearchResult =>
  searchResponse({
    total,
    rows: rows(n, prefix),
    facets,
    primary: Object.keys(facets),
  }) as unknown as SearchResult;

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

/** jsdom has no DataTransfer; this is the surface the picker actually uses. */
class FakeTransfer {
  readonly data = new Map<string, string>();
  effectAllowed = "none";
  dropEffect = "copy";
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  getData(type: string): string {
    return this.data.get(type) ?? "";
  }
}

function fireDrag(node: HTMLElement, type: "dragstart" | "dragend", dt: FakeTransfer): void {
  const ev = new win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  node.dispatchEvent(ev);
}

const key = (root: ParentNode, k: string, extra: KeyboardEventInit = {}): void => {
  q(root, ".fp-scroll").dispatchEvent(
    new win.KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }),
  );
};

// 1. Picks are durable

test("a pick survives filtering it out of the results, and still commits", async () => {
  // End to end: state must not report one file selected with the button enabled while
  // `getReference()` returns null because the row is no longer on the loaded page.
  const client = scriptedClient((req) =>
    req.query.includes("cordex")
      ? result(3, 3, FACETS, "/archive/other") // a completely different set - A is gone
      : result(3, 3),
  );
  const commits: DataReference[] = [];
  const { handle, root, host } = await mount({ client, onCommit: (r) => commits.push(r) });
  try {
    q<HTMLElement>(root, ".fp-row").click();
    await tick();
    const chosen = handle.getState().assets;
    assert.equal(chosen.length, 1);
    assert.equal(chosen[0].uri, "/archive/tas_0.nc");

    // Filter until the chosen file is not in the result list at all.
    handle.setState({ selected: { project: ["cordex"] } });
    await wait(30);
    assert.equal(
      [...root.querySelectorAll(".fp-uri")].some((n) => n.textContent === "/archive/tas_0.nc"),
      false,
      "the fixture did not actually filter the chosen row away",
    );

    // The pick survives, the reference is complete, and the button agrees with it.
    assert.deepEqual(handle.getState().assets, chosen);
    const ref = handle.getReference();
    assert.equal(ref?.kind, "asset");
    assert.equal(ref?.kind === "asset" ? ref.asset.uri : null, "/archive/tas_0.nc");
    const add = q<HTMLButtonElement>(root, ".fp-add");
    assert.equal(add.disabled, false);
    add.click();
    assert.equal(commits.length, 1);
    assert.equal(commits[0].kind, "asset");
    assert.ok(isDataReference(commits[0]));
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("selected assets restore BEFORE their rows load, and never yield a partial reference", async () => {
  const gate: { release?: () => void } = {};
  const client: SearchClient = {
    search: () =>
      new Promise<SearchResult>((resolve) => {
        gate.release = () => resolve(result(3));
      }),
  };
  const host = makeHost();
  const handle = mountDataPicker(host, {
    client,
    debounceMs: 1,
    initialState: {
      assets: [
        { id: "/archive/a.nc", uri: "/archive/a.nc", fsType: "posix" },
        { id: "swift://s/b.nc", uri: "swift://s/b.nc", fsType: "swift" },
      ],
    },
  });
  try {
    await wait(20);
    const root = host.querySelector(".freva-picker") as HTMLElement;
    // No rows have arrived at all yet…
    assert.equal(root.querySelectorAll(".fp-row").length, 0);
    // …and the selection is already whole.
    const ref = handle.getReference();
    assert.equal(ref?.kind, "selection");
    assert.equal(ref?.kind === "selection" ? ref.assets.length : 0, 2);
    assert.ok(isDataReference(ref));
    assert.equal(q<HTMLButtonElement>(root, ".fp-add").disabled, false);
    assert.match(q(root, '.fp-mode[data-mode="files"]').textContent ?? "", /2 files/);

    gate.release?.();
    await wait(30);
    // Rows arriving neither adds to nor subtracts from the selection.
    assert.deepEqual(handle.getReference(), ref);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("the Add button is enabled exactly when getReference() is non-null", async () => {
  const client = scriptedClient(() => result(3));
  const commits: DataReference[] = [];
  const { handle, root, host } = await mount({ client, onCommit: (r) => commits.push(r) });
  try {
    const add = q<HTMLButtonElement>(root, ".fp-add");
    const agree = (): void =>
      assert.equal(add.disabled, handle.getReference() === null, "button and reference disagreed");
    agree();
    assert.equal(add.disabled, true);

    q<HTMLElement>(root, ".fp-row").click();
    await tick();
    agree();
    assert.equal(add.disabled, false);

    q<HTMLElement>(root, ".fp-row").click(); // deselect
    await tick();
    agree();
    assert.equal(add.disabled, true);

    // A disabled button cannot commit an empty reference even if something calls click().
    add.click();
    assert.equal(commits.length, 0);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("restore sanitises, deduplicates and caps assets at 25", async () => {
  const client = scriptedClient(() => result(3));
  const dupes = [
    { id: "a", uri: "/a.nc" },
    { id: "a", uri: "/a.nc" }, // duplicate id
    { id: "b" }, // no uri - unusable, dropped
    { uri: "/c.nc" }, // no id - derived from the uri
    "nope",
    null,
  ];
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, uri: `/x${i}.nc` }));
  const { handle, host } = await mount({ client, initialState: { assets: dupes as never } });
  try {
    const a = handle.getState().assets;
    assert.deepEqual(
      a.map((x) => x.id),
      ["a", "/c.nc"],
    );
    handle.setState({ assets: many });
    await wait(20);
    assert.equal(handle.getState().assets.length, 25);
    const ref = handle.getReference();
    assert.equal(ref?.kind === "selection" ? ref.assets.length : 0, 25);
    assert.ok(isDataReference(ref));
    // The cap is enforced, and there is no "truncated" flag pretending a partial set is whole.
    assert.equal("truncated" in (ref as object), false);
  } finally {
    handle.destroy();
    host.remove();
  }
});

// 2. Base-scope semantics in the UI

test("a POSITIVE scope locks its facet and cannot produce an inert selection", async () => {
  const client = scriptedClient(() =>
    result(3, 3, { project: ["waterpark", 3, "other", 9], variable: ["tas", 3] }),
  );
  const { handle, root, host } = await mount({ client, baseFilters: { project: "waterpark" } });
  try {
    // The gated facet renders LOCKED, showing only in-scope values.
    const projectBlock = [...root.querySelectorAll(".fp-facet")].find((b) =>
      /project/i.test(b.querySelector(".fp-fname")?.textContent ?? ""),
    ) as HTMLElement;
    assert.ok(projectBlock, "the project facet is not rendered at all");
    assert.ok(projectBlock.classList.contains("locked"));
    const shown = [...projectBlock.querySelectorAll(".fp-v-t")].map((n) => n.textContent);
    assert.deepEqual(shown, ["waterpark"], "an out-of-scope value was offered");
    // No toggles at all on a locked facet - not disabled buttons, no buttons.
    assert.equal(projectBlock.querySelectorAll("button.fp-v, button.fp-x").length, 0);
    assert.ok(projectBlock.querySelector(".fp-lock"));

    // The scope is stated, immutably.
    assert.match(q(root, ".fp-scope").textContent ?? "", /Project = waterpark/i);

    // Neither restoration nor setState can create a selection on the owned key.
    handle.setState({ selected: { project: ["other"], project_not_: ["x"], variable: ["tas"] } });
    await wait(30);
    assert.deepEqual(handle.getState().selected, { variable: ["tas"] });
    assert.equal(
      [...root.querySelectorAll(".fp-chip-k")].some((n) => /project/i.test(n.textContent ?? "")),
      false,
      "an inert project chip was rendered",
    );
    // …and the wire query carries the scope, once.
    assert.equal(last(client.requests)?.query, "project=waterpark&variable=tas");
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("initialState on a scope-owned key is refused before the first render", async () => {
  const client = scriptedClient(() => result(2));
  const { handle, root, host } = await mount({
    client,
    baseFilters: { project: "waterpark" },
    initialState: { selected: { project: ["other"] } },
  });
  try {
    assert.deepEqual(handle.getState().selected, {});
    assert.equal(root.querySelectorAll(".fp-chip").length, 0);
    assert.equal(client.requests[0].query, "project=waterpark");
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("the autocomplete never offers a value on a scope-owned key", async () => {
  const client = scriptedClient(() =>
    result(3, 3, { project: ["waterpark", 3, "other", 9], variable: ["tas", 3] }),
  );
  const { handle, root, host } = await mount({ client, baseFilters: { project: "waterpark" } });
  try {
    const input = q<HTMLInputElement>(root, ".fp-input");
    input.value = "wat";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.equal(
      [...root.querySelectorAll(".fp-ac-v")].map((n) => n.textContent).length,
      0,
      "the locked scope value was completable",
    );
    input.value = "ta";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.deepEqual(
      [...root.querySelectorAll(".fp-ac-v")].map((n) => n.textContent),
      ["tas"],
      "a non-gated facet stopped completing",
    );
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("a NEGATIVE scope stays visible and still allows further narrowing", async () => {
  const client = scriptedClient(() => result(3));
  const { handle, root, host } = await mount({ client, baseFilters: { project_not_: "cmip6" } });
  try {
    // A base-excluded value never appears in the facet list, so the strip is the only place it can
    // be shown - and it is immutable.
    assert.match(q(root, ".fp-scope").textContent ?? "", /Project ≠ cmip6/i);
    assert.equal(q(root, ".fp-scope").querySelectorAll("button").length, 0);

    // The key is NOT owned: narrowing within the scope stays available in both modes.
    const projectBlock = [...root.querySelectorAll(".fp-facet")].find((b) =>
      /project/i.test(b.querySelector(".fp-fname")?.textContent ?? ""),
    ) as HTMLElement;
    assert.equal(projectBlock.classList.contains("locked"), false);
    const inc = [...projectBlock.querySelectorAll<HTMLButtonElement>("button.fp-v")].find((b) =>
      /cordex/.test(b.getAttribute("aria-label") ?? ""),
    )!;
    inc.click();
    await wait(20);
    assert.deepEqual(handle.getState().selected, { project: ["cordex"] });
    assert.equal(last(client.requests)?.query, "project_not_=cmip6&project=cordex");

    // Clear all clears the USER's question and leaves the scope standing.
    q<HTMLButtonElement>(root, ".fp-clear").click();
    await wait(20);
    assert.deepEqual(handle.getState().selected, {});
    assert.match(q(root, ".fp-scope").textContent ?? "", /Project ≠ cmip6/i);
    assert.equal(last(client.requests)?.query, "project_not_=cmip6");
  } finally {
    handle.destroy();
    host.remove();
  }
});

// 3. Fail-closed scoping for a custom flavour

test("a scoped CUSTOM flavour issues no search until its mapping arrives, then exactly one", async () => {
  const client = scriptedClient(() => result(2));
  const gate: { resolve?: (m: FlavourMapping[]) => void } = {};
  const { handle, root, host } = await mount({
    client,
    flavour: "custom",
    baseFilters: { project: "waterpark" },
    resolveFlavourMaps: () =>
      new Promise<FlavourMapping[]>((res) => {
        gate.resolve = res;
      }),
  });
  try {
    await wait(40);
    // ZERO premature requests: the freva-canonical `project=` would have been silently mis-scoped.
    assert.equal(client.requests.length, 0, "a request was sent before the mapping was known");
    assert.match(q(root, ".fp-state").textContent ?? "", /Preparing scoped browsing/);

    gate.resolve?.([{ flavour_name: "custom", mapping: { project: "dataset" } }]);
    await wait(40);
    assert.equal(client.requests.length, 1, "the mapped search did not fire exactly once");
    assert.equal(client.requests[0].flavour, "custom");
    assert.equal(client.requests[0].query, "dataset=waterpark");
    assert.equal(handle.getState().flavour, "custom");
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("a FAILED mapping shows a visible error and still issues no request", async () => {
  const client = scriptedClient(() => result(2));
  const { root, host, handle } = await mount({
    client,
    flavour: "custom",
    baseFilters: { project: "waterpark" },
    resolveFlavourMaps: () => Promise.reject(new Error("boom")),
  });
  try {
    await wait(60);
    assert.equal(client.requests.length, 0, "a potentially mis-scoped request was sent");
    const state = q(root, ".fp-state");
    assert.ok(state.classList.contains("show"));
    assert.ok(state.classList.contains("err"));
    assert.match(state.textContent ?? "", /Scoped browsing is unavailable/);
    assert.equal(q<HTMLButtonElement>(root, ".fp-add").disabled, true);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("an UNSCOPED custom flavour searches immediately - the gate is about the scope, not the lens", async () => {
  const client = scriptedClient(() => result(2));
  const { handle, host } = await mount({ client, flavour: "custom" });
  try {
    await wait(30);
    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0].flavour, "custom");
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("an injected client with no mapping hook fails closed rather than guessing", async () => {
  const client = scriptedClient(() => result(2));
  const { root, host, handle } = await mount({
    client,
    flavour: "custom",
    baseFilters: { project: "waterpark" },
  });
  try {
    await wait(60);
    assert.equal(client.requests.length, 0);
    assert.match(q(root, ".fp-state").textContent ?? "", /Scoped browsing is unavailable/);
  } finally {
    handle.destroy();
    host.remove();
  }
});

// 4. Flavour changes translate rather than discard

test("a lens change TRANSLATES the selection, `_not_` included, and keeps the asset picks", async () => {
  const reset = installFetch(({ url }) => {
    if (url.includes("/overview")) {
      return { body: overviewResponse(["freva", "cmip6"], { freva: ["project", "variable"] }) };
    }
    if (url.includes("/flavours")) return { body: { flavours: [] } };
    return { body: searchResponse({ total: 3, rows: rows(3), facets: FACETS }) };
  });
  const host = makeHost();
  const handle = mountDataPicker(host, {
    debounceMs: 1,
    apiBase: "/api/x",
    features: { flavour: true },
    initialState: { selected: { project_not_: ["cmip5"], variable: ["tas"] } },
  });
  try {
    await wait(60);
    const root = host.querySelector(".freva-picker") as HTMLElement;
    q<HTMLElement>(root, ".fp-row").click();
    await tick();
    assert.equal(handle.getState().assets.length, 1);

    const sel = q<HTMLSelectElement>(root, ".fp-flavour");
    assert.deepEqual(
      [...sel.options].map((o) => o.value),
      ["freva", "cmip6"],
    );
    sel.value = "cmip6";
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await wait(40);

    // Suffix-aware: the BASE key is re-keyed and `_not_` is reapplied.
    assert.deepEqual(handle.getState().selected, {
      mip_era_not_: ["cmip5"],
      variable_id: ["tas"],
    });
    // Explicit picks are concrete files; the lens has nothing to do with them.
    assert.equal(handle.getState().assets.length, 1);
    assert.equal(handle.getReference()?.kind, "asset");
    const searches = fetchCalls.filter((c) => c.url.includes("/extended-search/"));
    assert.match(last(searches)!.url, /\/extended-search\/cmip6\/file\?/);
    assert.match(last(searches)!.url, /mip_era_not_=cmip5/);
    assert.match(last(searches)!.url, /variable_id=tas/);
  } finally {
    handle.destroy();
    host.remove();
    reset();
  }
});

// 5. Feature flags are enforced in state, not just in the DOM

test("allFiltered:false cannot be entered through initialState, setState, or a stray checkbox", async () => {
  const client = scriptedClient(() => result(5, 999));
  const { handle, root, host } = await mount({
    client,
    features: { allFiltered: false },
    initialState: { useAllFiltered: true },
  });
  try {
    assert.equal(handle.getState().useAllFiltered, false, "restored a hidden mode");
    assert.equal(
      root.querySelector(".fp-modes"),
      null,
      "the mode choice is rendered while disabled",
    );
    assert.equal(handle.getReference(), null);

    handle.setState({ useAllFiltered: true });
    await wait(20);
    assert.equal(handle.getState().useAllFiltered, false, "setState reached a hidden mode");
    assert.equal(handle.getReference(), null);
    assert.equal(q<HTMLButtonElement>(root, ".fp-add").disabled, true);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("query mode and an explicit selection can never coexist", async () => {
  const client = scriptedClient(() => result(5, 999));
  const { handle, root, host } = await mount({ client });
  try {
    // Restoring both: the explicit selection wins and the flag is dropped.
    handle.setState({
      assets: [{ id: "a", uri: "/a.nc" }],
      useAllFiltered: true,
    });
    await wait(20);
    assert.equal(handle.getState().useAllFiltered, false);
    assert.equal(handle.getReference()?.kind, "asset");

    // Turning the mode on clears the selection.
    q<HTMLButtonElement>(root, '.fp-mode[data-mode="query"]').click();
    await tick();
    assert.deepEqual(handle.getState().assets, []);
    assert.equal(handle.getState().useAllFiltered, true);
    assert.equal(handle.getReference()?.kind, "query");

    // And picking a file turns it back off.
    q<HTMLElement>(root, ".fp-row").click();
    await tick();
    assert.equal(handle.getState().useAllFiltered, false);
    assert.equal(handle.getReference()?.kind, "asset");
  } finally {
    handle.destroy();
    host.remove();
  }
});

// 6. Accessibility

test("virtualised options are exposed to assistive technology, not hidden behind the spacer", async () => {
  const client = scriptedClient(() => result(200, 200));
  const { handle, root, host } = await mount({ client });
  try {
    const scroller = q(root, ".fp-scroll");
    assert.equal(scroller.getAttribute("role"), "listbox");
    assert.equal(scroller.getAttribute("aria-multiselectable"), "true");
    assert.equal(scroller.getAttribute("tabindex"), "0");

    const options = [...root.querySelectorAll('[role="option"].fp-row')];
    assert.ok(options.length > 0, "no options rendered at all");

    // No ancestor between the listbox and its options may be aria-hidden, and the
    // structural wrappers must be `presentation` so the options are exposed as the listbox's
    // children.
    for (const opt of options) {
      for (let n: Element | null = opt; n && n !== scroller; n = n.parentElement) {
        assert.notEqual(
          n.getAttribute("aria-hidden"),
          "true",
          `option hidden by an aria-hidden ancestor: ${n.className}`,
        );
      }
    }
    for (const sel of [".fp-vspace", ".fp-vrows"]) {
      const wrap = q(root, sel);
      assert.equal(wrap.getAttribute("aria-hidden"), null);
      assert.equal(wrap.getAttribute("role"), "presentation");
    }
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("the listbox keyboard pattern is complete: arrows, Home/End, Enter/Space, managed focus", async () => {
  const client = scriptedClient(() => result(50, 50));
  const { handle, root, host } = await mount({ client });
  try {
    const scroller = q(root, ".fp-scroll");
    const activeId = (): string | null => scroller.getAttribute("aria-activedescendant");
    const activeText = (): string =>
      root.querySelector(`#${activeId()} .fp-uri`)?.textContent ?? "";

    assert.equal(activeId(), null, "an option was active before any interaction");

    key(root, "ArrowDown");
    assert.ok(activeId(), "ArrowDown did not activate an option");
    assert.equal(activeText(), "/archive/tas_0.nc");

    key(root, "ArrowDown");
    assert.equal(activeText(), "/archive/tas_1.nc");

    key(root, "ArrowUp");
    assert.equal(activeText(), "/archive/tas_0.nc");

    key(root, "ArrowUp"); // clamps at the top rather than wrapping into nothing
    assert.equal(activeText(), "/archive/tas_0.nc");

    key(root, "End");
    assert.equal(activeText(), "/archive/tas_49.nc");
    key(root, "Home");
    assert.equal(activeText(), "/archive/tas_0.nc");

    // Enter and Space both select, and the active option is unchanged by selecting it - the
    // keyboard position must survive the row's state changing.
    key(root, "Enter");
    await tick();
    assert.equal(handle.getState().assets.length, 1);
    assert.equal(activeText(), "/archive/tas_0.nc");
    assert.equal(root.querySelector(`#${activeId()}`)?.getAttribute("aria-selected"), "true");

    key(root, "ArrowDown");
    key(root, " ");
    await tick();
    assert.equal(handle.getState().assets.length, 2);
    assert.equal(activeText(), "/archive/tas_1.nc");

    // The whole flow was keyboard-only, and the primary action is now operable.
    const add = q<HTMLButtonElement>(root, ".fp-add");
    assert.equal(add.tagName, "BUTTON");
    assert.equal(add.disabled, false);
    assert.match(add.getAttribute("aria-label") ?? "", /2 files$/);
  } finally {
    handle.destroy();
    host.remove();
  }
});

// 7. Drag ownership

test("one accepted drag causes exactly ONE host-side addition", async () => {
  // The README wires `onCommit` and the drop handler to the same function, which is the natural
  // integration. The picker must therefore not also commit on `dragend`.
  const client = scriptedClient(() => result(5));
  const added: DataReference[] = [];
  const { handle, root, host } = await mount({
    client,
    onCommit: (r) => added.push(r), // the host's Add-button path
  });
  try {
    q<HTMLElement>(root, ".fp-row").click();
    await tick();

    const node = q<HTMLElement>(root, ".fp-row");
    const dt = new FakeTransfer();
    fireDrag(node, "dragstart", dt);
    const payload = dt.getData(FREVA_DATA_REFERENCE_MIME);
    assert.ok(isDataReference(JSON.parse(payload)));

    // The host's DROP handler runs - this is the one and only addition.
    const dropped: unknown = JSON.parse(payload);
    if (isDataReference(dropped)) added.push(dropped);

    // The browser then fires dragend on an accepted drop. The picker must stay silent.
    const accepted = new FakeTransfer();
    accepted.dropEffect = "copy";
    fireDrag(node, "dragend", accepted);
    await tick();

    assert.equal(added.length, 1, "one gesture produced more than one addition");
    assert.deepEqual(added[0], handle.getReference());
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("the drag payload, getReference() and the Add-button payload are byte-equivalent", async () => {
  const client = scriptedClient(() => result(5));
  const commits: DataReference[] = [];
  const { handle, root, host } = await mount({ client, onCommit: (r) => commits.push(r) });
  try {
    key(root, "ArrowDown");
    key(root, "Enter");
    key(root, "ArrowDown");
    key(root, "Enter");
    await tick();
    assert.equal(handle.getState().assets.length, 2);

    const fromHandle = handle.getReference();
    const dt = new FakeTransfer();
    fireDrag(q<HTMLElement>(root, ".fp-row.picked"), "dragstart", dt);
    const dragged: unknown = JSON.parse(dt.getData(FREVA_DATA_REFERENCE_MIME));

    q<HTMLButtonElement>(root, ".fp-add").click();
    assert.equal(commits.length, 1);

    assert.equal(JSON.stringify(dragged), JSON.stringify(fromHandle));
    assert.equal(JSON.stringify(commits[0]), JSON.stringify(fromHandle));
    assert.equal(dt.getData("text/uri-list"), "", "a posix path was offered as a URI");
    assert.match(dt.getData("text/plain"), /archive\/tas_0\.nc/);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("a remote single asset also populates text/uri-list", async () => {
  const client: SearchClient = {
    async search() {
      return searchResponse({
        total: 1,
        rows: [{ file: "https://store.example/tas.nc", fs_type: "s3" }],
        facets: FACETS,
      }) as unknown as SearchResult;
    },
  };
  const { handle, root, host } = await mount({ client });
  try {
    q<HTMLElement>(root, ".fp-row").click();
    await tick();
    const dt = new FakeTransfer();
    fireDrag(q<HTMLElement>(root, ".fp-row"), "dragstart", dt);
    assert.equal(dt.getData("text/uri-list"), "https://store.example/tas.nc");
    assert.equal(dt.getData("text/plain"), "https://store.example/tas.nc");
    assert.equal(handle.getReference()?.kind, "asset");
  } finally {
    handle.destroy();
    host.remove();
  }
});

// Further behaviour that must hold

test("include and exclude are mutually exclusive for one (facet, value)", async () => {
  const client = scriptedClient(() => result(3));
  const { handle, root, host } = await mount({ client });
  try {
    const incBtn = (): HTMLButtonElement =>
      [...root.querySelectorAll<HTMLButtonElement>("button.fp-v")].find((b) =>
        /(Include|Remove filter) .*cmip6$/.test(b.getAttribute("aria-label") ?? ""),
      )!;
    const excBtn = (): HTMLButtonElement =>
      [...root.querySelectorAll<HTMLButtonElement>(".fp-x")].find((b) =>
        /cmip6/.test(b.getAttribute("aria-label") ?? ""),
      )!;

    incBtn().click();
    await wait(20);
    assert.deepEqual(handle.getState().selected, { project: ["cmip6"] });

    excBtn().click();
    await wait(20);
    assert.deepEqual(handle.getState().selected, { project_not_: ["cmip6"] });
    assert.equal(last(client.requests)?.query.includes("project_not_=cmip6"), true);
    assert.equal(last(client.requests)?.query.includes("project=cmip6"), false);

    excBtn().click(); // same mode again -> removes it
    await wait(20);
    assert.deepEqual(handle.getState().selected, {});
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("a chip removes its own filter, and Clear all empties the question", async () => {
  const client = scriptedClient(() => result(3));
  const { handle, root, host } = await mount({ client });
  try {
    handle.setState({ selected: { project: ["cmip6"], variable_not_: ["pr"] } });
    await wait(20);
    assert.equal(root.querySelectorAll(".fp-chip").length, 2);
    assert.equal(root.querySelectorAll(".fp-chip.neg").length, 1);

    q<HTMLButtonElement>(root, ".fp-chip.neg").click();
    await wait(20);
    assert.deepEqual(handle.getState().selected, { project: ["cmip6"] });

    q<HTMLButtonElement>(root, ".fp-clear").click();
    await wait(20);
    assert.deepEqual(handle.getState().selected, {});
    assert.equal(root.querySelectorAll(".fp-chip").length, 0);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("a superseded search is aborted and its late response never lands", async () => {
  const seen: SearchRequest[] = [];
  const client: SearchClient = {
    search(req) {
      seen.push(req);
      const slow = req.query.includes("cmip6");
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(slow ? result(5, 5) : result(2, 2)), slow ? 120 : 5);
        req.signal.addEventListener("abort", () => {
          clearTimeout(t);
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    },
  };
  const { handle, root, host } = await mount({ client });
  try {
    handle.setState({ selected: { project: ["cmip6"] } }); // the SLOW one
    await wait(20);
    handle.setState({ selected: { project: ["cordex"] } }); // supersedes it
    await wait(200);

    assert.equal(
      seen.some((r) => r.query.includes("cmip6")),
      true,
    );
    assert.equal(last(seen)?.query.includes("cordex"), true);
    assert.match(q(root, ".fp-lh").textContent ?? "", /^2 files$/);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("state restores from initialState and round-trips through getState/setState", async () => {
  const client = scriptedClient(() => result(4));
  const initial: Partial<PickerState> = {
    flavour: "cmip6",
    selected: { mip_era_not_: ["cmip5"] },
    time: { from: "2000", to: "2010", mode: "flexible" },
    search: "tas",
  };
  const { handle, root, host } = await mount({ client, initialState: initial });
  try {
    const st = handle.getState();
    assert.equal(st.version, 1);
    assert.equal(st.flavour, "cmip6");
    assert.deepEqual(st.selected, { mip_era_not_: ["cmip5"] });
    assert.equal(st.time?.from, "2000");
    assert.equal(q<HTMLInputElement>(root, ".fp-input").value, "tas");
    assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
    // …and NOT the internal AppState.
    assert.equal("pickedKeys" in st, false);
    assert.equal("rowsVersion" in st, false);

    handle.setState({ selected: { mip_era: ["cmip6"] }, search: "" });
    await wait(20);
    assert.deepEqual(handle.getState().selected, { mip_era: ["cmip6"] });
    // setState MERGES - the restored time survives a selection-only update, and rides the query.
    assert.equal(
      last(client.requests)?.query,
      "mip_era=cmip6&time=2000%20TO%202010&time_select=flexible",
    );

    handle.setState({ selected: { junk: "no" } as never });
    await wait(20);
    assert.deepEqual(handle.getState().selected, {});
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("two picker instances coexist without sharing a byte of state", async () => {
  const a = scriptedClient(() => result(3, 3));
  const b = scriptedClient(() => result(7, 7, { model: ["mpi", 7] }));
  const one = await mount({ client: a });
  const two = await mount({ client: b, commitLabel: "Attach" });
  try {
    one.handle.setState({ selected: { project: ["cmip6"] } });
    await wait(30);
    assert.deepEqual(one.handle.getState().selected, { project: ["cmip6"] });
    assert.deepEqual(two.handle.getState().selected, {});
    assert.match(q(one.root, ".fp-lh").textContent ?? "", /3 files/);
    assert.match(q(two.root, ".fp-lh").textContent ?? "", /7 files/);
    assert.equal(q(one.root, ".fp-add").textContent, "Add selection");
    assert.equal(q(two.root, ".fp-add").textContent, "Attach");
    assert.equal(win.document.querySelectorAll(".fp-ac").length, 2);

    one.handle.destroy();
    one.host.remove();
    two.handle.setState({ selected: { model: ["mpi"] } });
    await wait(30);
    assert.deepEqual(two.handle.getState().selected, { model: ["mpi"] });
    assert.equal(win.document.querySelectorAll(".freva-picker").length, 1);
  } finally {
    two.handle.destroy();
    two.host.remove();
  }
});

test("selection is capped at 25, and 'all filtered' commits a bounded query reference", async () => {
  const client = scriptedClient(() => result(60, 41253));
  const commits: DataReference[] = [];
  const { handle, root, host } = await mount({ client, onCommit: (r) => commits.push(r) });
  try {
    const rowNodes = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".fp-row")];
    for (const r of rowNodes()) r.click();
    await tick();
    assert.equal(handle.getState().assets.length, Math.min(25, rowNodes().length));

    if (handle.getState().assets.length === 25) {
      const before = handle.getState().assets.length;
      rowNodes()[26]?.click();
      await tick();
      assert.equal(handle.getState().assets.length, before, "the cap was exceeded");
      assert.match(q(root, ".fp-note").textContent ?? "", /At most 25/);
    }

    q<HTMLButtonElement>(root, '.fp-mode[data-mode="query"]').click();
    await tick();
    assert.deepEqual(handle.getState().assets, []);
    const ref = handle.getReference();
    assert.equal(ref?.kind, "query");
    assert.equal(ref?.kind === "query" ? ref.estimatedCount : 0, 41253);
    // A 41,253-file answer is a query, never a list of URIs.
    assert.ok(JSON.stringify(ref).length < 600);

    q<HTMLButtonElement>(root, ".fp-add").click();
    assert.equal(commits.length, 1);
    assert.equal(commits[0].kind, "query");
    assert.ok(isDataReference(commits[0]));
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("1,000 results do not create 1,000 live rows", async () => {
  const client = scriptedClient(() => result(1000, 1000));
  const { handle, root, host } = await mount({ client });
  try {
    assert.match(q(root, ".fp-lh").textContent ?? "", /1,000 files/);
    const live = root.querySelectorAll(".fp-row").length;
    assert.ok(live > 0, "the list rendered nothing at all");
    assert.ok(live <= 64, `the windowed list materialised ${live} rows`);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("loading, empty and error states are all reachable and announced", async () => {
  let mode: "empty" | "error" = "empty";
  const client: SearchClient = {
    async search() {
      if (mode === "error") throw new Error("Service error - try again.");
      return searchResponse({ total: 0, rows: [], facets: {} }) as unknown as SearchResult;
    },
  };
  const { handle, root, host } = await mount({ client });
  try {
    const state = q(root, ".fp-state");
    assert.equal(state.getAttribute("aria-live"), "polite");
    assert.match(state.textContent ?? "", /No files match/);

    mode = "error";
    handle.setState({ selected: { project: ["cmip6"] } });
    await wait(40);
    assert.match(state.textContent ?? "", /Service error/);
    assert.ok(state.classList.contains("err"));
    assert.equal(root.querySelectorAll(".fp-row").length, 0);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("destroy leaves nothing behind, and a late response after it is harmless", async () => {
  let resolveLate: ((r: SearchResult) => void) | undefined;
  const client: SearchClient = {
    search() {
      return new Promise<SearchResult>((res) => {
        resolveLate = res;
      });
    },
  };
  const host = makeHost();
  const handle = mountDataPicker(host, { client, debounceMs: 1 });
  await wait(20);
  assert.equal(host.querySelectorAll(".freva-picker").length, 1);
  handle.destroy();
  assert.equal(host.querySelectorAll(".freva-picker").length, 0);
  assert.equal(win.document.querySelectorAll(".fp-ac").length, 0);
  resolveLate?.(searchResponse({ total: 1, rows: rows(1), facets: {} }) as unknown as SearchResult);
  await wait(20);
  assert.equal(host.querySelectorAll(".freva-picker").length, 0);
  host.remove();

  for (let i = 0; i < 3; i++) {
    const h2 = makeHost();
    const p = mountDataPicker(h2, { client, debounceMs: 1 });
    p.destroy();
    h2.remove();
  }
  assert.equal(win.document.querySelectorAll(".freva-picker").length, 0);
  assert.equal(win.document.querySelectorAll(".fp-ac").length, 0);
});

test("the default transport speaks freva-rest, sends no token by default, and never writes the URL", async () => {
  const reset = installFetch(({ url }) => {
    if (url.includes("/overview")) return { body: overviewResponse(["freva"], { freva: [] }) };
    if (url.includes("/flavours")) return { body: { flavours: [] } };
    return { body: searchResponse({ total: 2, rows: rows(2), facets: FACETS }) };
  });
  win.history.replaceState(null, "", "/host-page?keep=me");
  const host = makeHost();
  const handle = mountDataPicker(host, { debounceMs: 1, apiBase: "/api/x" });
  try {
    await wait(40);
    handle.setState({ selected: { project_not_: ["cmip6"] } });
    await wait(40);
    const searches = fetchCalls.filter((c) => c.url.includes("/extended-search/"));
    assert.ok(searches.length >= 2);
    assert.match(searches[0].url, /^\/api\/x\/extended-search\/freva\/file\?translate=true/);
    assert.match(last(searches)!.url, /project_not_=cmip6/);
    for (const c of fetchCalls) {
      const h = (c.init?.headers ?? {}) as Record<string, string>;
      assert.equal("Authorization" in h, false);
    }
    assert.equal(win.location.search, "?keep=me");
  } finally {
    handle.destroy();
    host.remove();
    win.history.replaceState(null, "", "/");
    reset();
  }
});

test("no credential ever reaches picker state or a drag payload, even with a token supplier", async () => {
  const reset = installFetch(({ url }) => {
    if (url.includes("/overview")) return { body: overviewResponse(["freva"], { freva: [] }) };
    if (url.includes("/flavours")) return { body: { flavours: [] } };
    return { body: searchResponse({ total: 1, rows: rows(1), facets: FACETS }) };
  });
  const host = makeHost();
  const handle = mountDataPicker(host, {
    debounceMs: 1,
    apiBase: "/api/x",
    getAuthToken: () => "super-secret-token",
  });
  try {
    await wait(40);
    const auth = fetchCalls.map((c) => (c.init?.headers ?? {}) as Record<string, string>);
    assert.ok(auth.some((h) => h["Authorization"] === "Bearer super-secret-token"));

    const root = host.querySelector(".freva-picker") as HTMLElement;
    q<HTMLElement>(root, ".fp-row").click();
    await tick();
    const dt = new FakeTransfer();
    fireDrag(q<HTMLElement>(root, ".fp-row"), "dragstart", dt);

    const surfaces = [
      JSON.stringify(handle.getState()),
      JSON.stringify(handle.getReference()),
      dt.getData(FREVA_DATA_REFERENCE_MIME),
      dt.getData("text/plain"),
      dt.getData("text/uri-list"),
    ];
    for (const s of surfaces) assert.equal(s.includes("super-secret-token"), false);
  } finally {
    handle.destroy();
    host.remove();
    reset();
  }
});

test("onStateChange reports a serialisable snapshot the host can store and replay", async () => {
  const client = scriptedClient(() => result(3));
  const seen: PickerState[] = [];
  const { handle, root, host } = await mount({ client, onStateChange: (s) => seen.push(s) });
  try {
    q<HTMLElement>(root, ".fp-row").click();
    handle.setState({ selected: { variable: ["tas"] } });
    await wait(30);
    assert.ok(seen.length >= 1);
    const snap = last(seen)!;
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
    assert.deepEqual(snap.selected, { variable: ["tas"] });
    assert.equal(snap.assets.length, 1);
    // Mutating the reported snapshot must not reach back into the picker.
    snap.selected.variable.push("pr");
    snap.assets.push({ id: "x", uri: "/x.nc" });
    assert.deepEqual(handle.getState().selected, { variable: ["tas"] });
    assert.equal(handle.getState().assets.length, 1);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("the autocomplete ranks and applies values, and Shift+Enter excludes", async () => {
  const client = scriptedClient(() => result(3));
  const { handle, root, host } = await mount({ client });
  try {
    const input = q<HTMLInputElement>(root, ".fp-input");
    input.value = "c";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    const items = [...root.querySelectorAll(".fp-ac-item .fp-ac-v")].map((n) => n.textContent);
    // Prefix hits first, ordered by count: cmip6 (40) before cordex (12).
    assert.deepEqual(items, ["cmip6", "cordex"]);
    assert.equal(input.getAttribute("aria-expanded"), "true");

    input.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    await wait(20);
    assert.deepEqual(handle.getState().selected, { project_not_: ["cmip6"] });
    assert.equal(input.getAttribute("aria-expanded"), "false");
  } finally {
    handle.destroy();
    host.remove();
  }
});
