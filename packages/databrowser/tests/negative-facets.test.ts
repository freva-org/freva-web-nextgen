// Negative facet selections: the `_not_` KEY contract.
//
// The unambiguous freva-rest form is a key suffix (`project_not_=cmip6`), and that is the browser's
// canonical representation - so it round-trips through the query string, the URL, the CLI tokens,
// the python kwargs and a flavour change without a second state shape.

import "./helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  installFetch,
  makeHost,
  overviewResponse,
  searchResponse,
  tick,
  wait,
  window as win,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";
import {
  baseFacetKey,
  baseScopeExclusions,
  buildUrlQuery,
  clearSelectedFacet,
  createInitialState,
  excludedValues,
  facetQueryString,
  facetSelectionCount,
  filterCommittable,
  includedValues,
  isExcluded,
  isGatedKey,
  negativeKey,
  parseFacetKey,
  parseUrlQuery,
  pythonCommand,
  selectionsEqual,
  terminalTokens,
  toggleFacetMode,
  translateFacetKey,
  translateSelection,
  BUILTIN_FLAVOUR_MAPS,
} from "../src/state.js";
import { cliCommand } from "../src/commands.js";
import type { AppState, DataBrowserHandle, ResolvedConfig } from "../src/types.js";

function state(over: Partial<AppState> = {}): AppState {
  const s = createInitialState({ flavour: "freva" } as unknown as ResolvedConfig);
  s.flavourMaps = structuredClone(BUILTIN_FLAVOUR_MAPS);
  return Object.assign(s, over);
}

// pure key algebra

test("_not_ is recognised ONLY as a suffix, and only with something in front of it", () => {
  assert.deepEqual(parseFacetKey("project_not_"), { baseKey: "project", negated: true });
  assert.deepEqual(parseFacetKey("project"), { baseKey: "project", negated: false });
  // Not a suffix -> not a negation. `_not_` in the middle is part of a (weird but legal) key name.
  assert.deepEqual(parseFacetKey("a_not_b"), { baseKey: "a_not_b", negated: false });
  // `_not_` alone would be the negation of the empty key, which is meaningless.
  assert.deepEqual(parseFacetKey("_not_"), { baseKey: "_not_", negated: false });
  assert.equal(negativeKey("project"), "project_not_");
  assert.equal(negativeKey("project_not_"), "project_not_", "building it twice is a no-op");
  assert.equal(baseFacetKey("project_not_"), "project");
});

test("include and exclude are mutually exclusive for one (facet, value)", () => {
  const s = state();
  toggleFacetMode(s, "project", "cmip6", false);
  assert.deepEqual(s.selected, { project: ["cmip6"] });
  // Excluding the SAME pair removes the include first - one commit, never both at once.
  toggleFacetMode(s, "project", "cmip6", true);
  assert.deepEqual(s.selected, { project_not_: ["cmip6"] });
  assert.ok(!includedValues(s, "project").includes("cmip6"));
  assert.ok(isExcluded(s, "project", "cmip6"));
  // …and back again.
  toggleFacetMode(s, "project", "cmip6", false);
  assert.deepEqual(s.selected, { project: ["cmip6"] });
  // A second toggle in the same mode clears it.
  toggleFacetMode(s, "project", "cmip6", false);
  assert.deepEqual(s.selected, {});
});

test("counts and clear cover BOTH modes for a facet", () => {
  const s = state({ selected: { project: ["a"], project_not_: ["b", "c"], variable: ["tas"] } });
  assert.equal(facetSelectionCount(s, "project"), 3, "1 include + 2 excludes");
  assert.deepEqual(includedValues(s, "project"), ["a"]);
  assert.deepEqual(excludedValues(s, "project"), ["b", "c"]);
  clearSelectedFacet(s, "project");
  assert.deepEqual(s.selected, { variable: ["tas"] }, "clearing a facet clears both modes");
});

// wire contract

test("multiple excluded values repeat the _not_ key", () => {
  const s = state({ selected: { project_not_: ["cmip6", "cordex"] } });
  assert.equal(facetQueryString(s), "project_not_=cmip6&project_not_=cordex");
});

test("a negative selection round-trips through the shareable URL", () => {
  const s = state({ selected: { project: ["a"], project_not_: ["cmip6"] } });
  const qs = buildUrlQuery(s);
  const back = parseUrlQuery(qs);
  assert.deepEqual(back.selected, { project: ["a"], project_not_: ["cmip6"] });
  assert.ok(selectionsEqual(s.selected, back.selected), "equality checks see it as unchanged");
});

test("copied CLI and python commands carry the negative key verbatim", () => {
  const s = state({ selected: { project_not_: ["cmip6"], variable: ["tas"] } });
  assert.match(cliCommand(s), /project_not_=cmip6/);
  // `project_not_="cmip6"` is a valid python keyword argument, so the copied call runs as-is.
  assert.match(pythonCommand(s), /project_not_="cmip6"/);
  assert.match(terminalTokens(s), /project_not_=cmip6/);
});

test("a flavour change translates the BASE key and reapplies the suffix", () => {
  const s = state();
  const out = translateSelection(s, { project_not_: ["cmip6"], model: ["x"] }, "freva", "cmip6");
  // freva `project` is cmip6-flavour `mip_era`; `model` is `source_id`.
  assert.deepEqual(out, { mip_era_not_: ["cmip6"], source_id: ["x"] });
  // Translating the literal key would find no mapping and silently pass it through mis-keyed.
  assert.equal(translateFacetKey(s, "project_not_", "freva", "cmip6"), "mip_era_not_");
  assert.equal(translateFacetKey(s, "mip_era_not_", "cmip6", "freva"), "project_not_");
});

test("the commit guard validates the UNDERLYING positive key", () => {
  const s = state({
    facets: [
      { key: "project", label: "Project", values: [{ value: "cmip6", count: 2 }], hasMore: false },
    ],
    primaryFacets: ["project"],
  });
  const ok = filterCommittable(s, { project_not_: ["cmip6"] });
  assert.deepEqual(ok.accepted, { project_not_: ["cmip6"] }, "project_not_ is committable");
  assert.deepEqual(ok.rejected, []);
  const bad = filterCommittable(s, { nonsense_not_: ["x"] });
  assert.deepEqual(bad.accepted, {}, "an unknown base key is still rejected");
});

test("the guard refuses to both require and forbid the same value", () => {
  const s = state({
    facets: [
      {
        key: "project",
        label: "Project",
        values: [
          { value: "cmip6", count: 2 },
          { value: "cordex", count: 1 },
        ],
        hasMore: false,
      },
    ],
    primaryFacets: ["project"],
  });
  const out = filterCommittable(s, { project: ["cmip6"], project_not_: ["cmip6", "cordex"] });
  assert.deepEqual(out.accepted.project, ["cmip6"], "the include wins");
  assert.deepEqual(out.accepted.project_not_, ["cordex"], "the unrelated exclusion survives");
  assert.ok(
    out.rejected.includes("project_not_=cmip6"),
    "the contradiction is REPORTED, not silently dropped",
  );
});

// baseFilters, both forms

test("a POSITIVE base filter owns its key; a NEGATIVE one does not", () => {
  const positive = state({ baseFilters: { project: ["waterpark"] } });
  assert.ok(isGatedKey(positive, "project"), "a positive scope owns `project`");
  assert.ok(isGatedKey(positive, "project_not_"), "…and therefore the negative form of it too");

  const negative = state({ baseFilters: { project_not_: ["cmip6"] } });
  assert.ok(
    !isGatedKey(negative, "project"),
    "a negative scope narrows without claiming the key - the user can still narrow further",
  );
  // It is ALWAYS sent, so the excluded values stay unreachable…
  assert.match(facetQueryString(negative), /project_not_=cmip6/);
  // …while a user's own positive narrowing (a subset of the scope) still goes out.
  negative.selected = { project: ["cordex"] };
  const q = facetQueryString(negative);
  assert.match(q, /project_not_=cmip6/);
  assert.match(q, /(^|&)project=cordex(&|$)/);
});

test("a user cannot widen or contradict a POSITIVE scope, in either mode", () => {
  const s = state({ baseFilters: { project: ["waterpark"] } });
  s.selected = { project: ["cmip6"], project_not_: ["waterpark"] };
  const q = facetQueryString(s);
  assert.match(q, /(^|&)project=waterpark(&|$)/, "the scope value is sent");
  assert.doesNotMatch(q, /project=cmip6/, "a user include on the gated key never widens it");
  assert.doesNotMatch(
    q,
    /project_not_/,
    "…and a user EXCLUDE on it cannot empty the instance either",
  );
});

test("a base exclusion is reported as an immutable scope, translated per flavour", () => {
  const s = state({ baseFilters: { project_not_: ["cmip6"] } });
  assert.deepEqual(baseScopeExclusions(s), [["project", "cmip6"]]);
  s.flavour = "cmip6";
  assert.deepEqual(
    baseScopeExclusions(s),
    [["mip_era", "cmip6"]],
    "the indicator uses the current flavour's naming",
  );
  assert.match(facetQueryString(s), /mip_era_not_=cmip6/, "…and so does the wire query");
});

// UI

const router = (call: { url: string }): Record<string, unknown> => {
  if (call.url.includes("/overview"))
    return { body: overviewResponse(["freva"], { freva: ["project"] }) };
  return {
    body: searchResponse({
      total: 2,
      rows: [{ file: "/a.nc" }],
      facets: {
        project: ["cmip6", 2, "cordex", 1],
      },
      primary: ["project"],
    }),
  };
};

async function mount(
  cfg: Record<string, unknown> = {},
): Promise<{ handle: DataBrowserHandle; root: HTMLElement }> {
  installFetch(router as never);
  const host = makeHost();
  const handle = mountDataBrowser(host, cfg as never);
  await wait(40);
  return { handle, root: host.querySelector(".freva-db") as HTMLElement };
}

function openFacet(root: HTMLElement): void {
  const head = [...root.querySelectorAll<HTMLElement>(".facet-head")].find((h) =>
    /project/i.test(h.textContent ?? ""),
  );
  head?.click();
}

test("the sidebar offers Include and Exclude as two keyboard-operable siblings", async () => {
  const { handle, root } = await mount();
  openFacet(root);
  await tick();
  const row = [...root.querySelectorAll<HTMLElement>(".side-scroll .fval-row")].find((r) =>
    (r.textContent ?? "").includes("cmip6"),
  );
  assert.ok(row, "the value renders as a row of controls");
  const include = row!.querySelector<HTMLButtonElement>(".fval");
  const exclude = row!.querySelector<HTMLButtonElement>(".fval-ex");
  assert.ok(include && exclude, "two controls, not one nested inside the other");
  assert.equal(exclude!.parentElement, include!.parentElement, "they are SIBLINGS");
  assert.equal(include!.getAttribute("aria-label"), "Include Project cmip6");
  assert.equal(exclude!.getAttribute("aria-label"), "Exclude Project cmip6");
  assert.equal(exclude!.tagName, "BUTTON", "the exclude control is keyboard operable");

  exclude!.click();
  await wait(320);
  assert.deepEqual(handle.getState().selected, { project_not_: ["cmip6"] });
  handle.destroy();
});

test("choosing one mode removes the other, in ONE search", async () => {
  const { handle, root } = await mount();
  openFacet(root);
  await tick();
  const row = [...root.querySelectorAll<HTMLElement>(".side-scroll .fval-row")].find((r) =>
    (r.textContent ?? "").includes("cmip6"),
  )!;
  row.querySelector<HTMLButtonElement>(".fval")!.click();
  await wait(320);
  assert.deepEqual(handle.getState().selected, { project: ["cmip6"] });
  openFacet(root);
  await tick();
  const row2 = [...root.querySelectorAll<HTMLElement>(".side-scroll .fval-row")].find((r) =>
    (r.textContent ?? "").includes("cmip6"),
  )!;
  row2.querySelector<HTMLButtonElement>(".fval-ex")!.click();
  await wait(320);
  assert.deepEqual(
    handle.getState().selected,
    { project_not_: ["cmip6"] },
    "the include was removed as part of the same commit",
  );
  handle.destroy();
});

test("a negative chip is removable and does not rely on colour alone", async () => {
  const { handle, root } = await mount();
  openFacet(root);
  await tick();
  const row = [...root.querySelectorAll<HTMLElement>(".side-scroll .fval-row")].find((r) =>
    (r.textContent ?? "").includes("cmip6"),
  )!;
  row.querySelector<HTMLButtonElement>(".fval-ex")!.click();
  await wait(320);
  const chip = [...root.querySelectorAll<HTMLElement>(".chips .chip")].find((c) =>
    (c.textContent ?? "").includes("cmip6"),
  );
  assert.ok(chip, "an excluded value gets a chip");
  assert.match(chip!.textContent ?? "", /≠/, "a GLYPH carries the meaning, not just a hue");
  assert.match(chip!.textContent ?? "", /NOT/, "…reinforced by a word");
  chip!.click();
  await wait(320);
  assert.deepEqual(handle.getState().selected, {}, "the chip removes the exclusion");
  handle.destroy();
});

test("an excluded value that vanishes from the facet list keeps its removable chip", async () => {
  // The server legitimately stops returning an excluded value (nothing matches it any more). The
  // chip is then the ONLY way to see - and undo - the exclusion.
  installFetch(((call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { freva: ["project"] }) };
    const excluded = call.url.includes("project_not_");
    return {
      body: searchResponse({
        total: 1,
        rows: [{ file: "/a.nc" }],
        // once excluded, cmip6 is simply absent from the response
        facets: { project: excluded ? ["cordex", 1] : ["cmip6", 2, "cordex", 1] },
        primary: ["project"],
      }),
    };
  }) as never);
  const host = makeHost();
  const handle = mountDataBrowser(host, {} as never);
  await wait(40);
  const root = host.querySelector(".freva-db") as HTMLElement;
  openFacet(root);
  await tick();
  const row = [...root.querySelectorAll<HTMLElement>(".side-scroll .fval-row")].find((r) =>
    (r.textContent ?? "").includes("cmip6"),
  )!;
  row.querySelector<HTMLButtonElement>(".fval-ex")!.click();
  await wait(340);
  assert.equal(
    [...root.querySelectorAll(".side-scroll .fval")].filter((n) =>
      (n.textContent ?? "").includes("cmip6"),
    ).length,
    0,
    "the excluded value is gone from the facet list, as the server returned it",
  );
  const chip = [...root.querySelectorAll<HTMLElement>(".chips .chip")].find((c) =>
    (c.textContent ?? "").includes("cmip6"),
  );
  assert.ok(chip, "the chip survives as the stable handle on the exclusion");
  handle.destroy();
});

test("an immutable Scope indicator shows a base exclusion, and Clear all leaves it", async () => {
  const { handle, root } = await mount({ baseFilters: { project_not_: "cmip6" } });
  const scope = [...root.querySelectorAll<HTMLElement>(".chips .chip.scope")];
  assert.equal(scope.length, 1, "the base exclusion is stated");
  assert.match(scope[0].textContent ?? "", /Scope: project ≠ cmip6/);
  assert.equal(scope[0].tagName, "SPAN", "not a button - there is nothing to click");
  openFacet(root);
  await tick();
  const row = [...root.querySelectorAll<HTMLElement>(".side-scroll .fval-row")].find((r) =>
    (r.textContent ?? "").includes("cordex"),
  )!;
  row.querySelector<HTMLButtonElement>(".fval")!.click();
  await wait(320);
  (root.querySelector(".clear-btn") as HTMLElement).click();
  await wait(320);
  assert.deepEqual(handle.getState().selected, {}, "Clear all removed the user's own filter");
  assert.equal(
    root.querySelectorAll(".chips .chip.scope").length,
    1,
    "…but not the instance's scope",
  );
  assert.match(
    (win.location.search ?? "") + facetQueryString(handle.getState()),
    /project_not_=cmip6/,
    "the scope is still on the wire",
  );
  handle.destroy();
});

test("the terminal accepts, highlights and completes a negative key", async () => {
  const { handle, root } = await mount();
  const input = root.querySelector(".te-input") as HTMLTextAreaElement;
  input.focus();
  input.value = "project_not_=cmip6 ";
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(340);
  assert.deepEqual(handle.getState().selected, { project_not_: ["cmip6"] });
  assert.equal(
    root.querySelector(".te-warn.show"),
    null,
    "a valid negative key is NOT flagged as an unknown facet",
  );
  // The default key list is not doubled; the negative form appears once the typed key asks for it.
  input.value = "project_not";
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(20);
  const ghost = root.querySelector(".te-hl .te-ghost");
  assert.equal(ghost?.textContent, "_", 'typing "_not" completes to the negative key');
  handle.destroy();
});
