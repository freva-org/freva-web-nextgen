// The MOUNTED negative-facet lifecycle.
//
// The pure helpers in state.ts are only half of it; the controller around them has to hold up too.
// Three behaviours: a deep-linked exclusion survives the first payload, a header badge that counts
// exclusions can also clear them, and URL sanitisation does not treat every base-filter key as
// owning its facet.

import "./helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

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
import { mountDataBrowser } from "../src/index.js";
import { facetQueryString } from "../src/state.js";
import type { DataBrowserConfig, DataBrowserHandle } from "../src/types.js";

const q = <T extends Element>(r: ParentNode, s: string): T | null => r.querySelector<T>(s);
const qa = <T extends Element>(r: ParentNode, s: string): T[] => [...r.querySelectorAll<T>(s)];

/** Every extended-search URL, reduced to its query - the wire record of what was actually asked. */
const searches = (): string[] =>
  fetchCalls
    .filter((c) => c.url.includes("/extended-search/"))
    .map((c) => c.url.slice(c.url.indexOf("?") + 1));

function router(facetKeys: Record<string, Array<string | number>>, flavours = ["freva"]) {
  return (call: { url: string }): Record<string, unknown> => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(flavours, { freva: Object.keys(facetKeys) }) };
    return {
      body: searchResponse({
        total: 2,
        rows: [{ file: "/a.nc" }, { file: "/b.nc" }],
        facets: facetKeys,
        primary: Object.keys(facetKeys),
      }),
    };
  };
}

/** Mount with a deep link already in the address bar (installFetch resets it, so set it after). */
async function mountWithUrl(
  r: (c: { url: string }) => Record<string, unknown>,
  search: string,
  cfg: DataBrowserConfig = {},
): Promise<{ handle: DataBrowserHandle; root: HTMLElement }> {
  installFetch(r as never);
  win.history.replaceState(null, "", search || "/");
  const host = makeHost();
  const handle = mountDataBrowser(host, cfg);
  await wait(400); // overview + search + any corrective re-search all settle
  return { handle, root: host.querySelector(".freva-db") as HTMLElement };
}

// deep-linked exclusions

test("a deep-linked exclusion survives reconciliation and keeps every search filtered", async () => {
  const { handle, root } = await mountWithUrl(
    router({ project: ["cordex", 1], variable: ["tas", 2] }),
    "/?project_not_=cmip6",
  );
  // Reconciliation must not validate the LITERAL key `project_not_` against a list of positive
  // facet names: that never matches, so the filter is dropped from state, dropped from the URL, and
  // a corrective UNFILTERED search goes out - while the address bar still advertises the exclusion.
  assert.deepEqual(handle.getState().selected, { project_not_: ["cmip6"] }, "state keeps it");
  assert.match(win.location.search, /project_not_=cmip6/, "the URL keeps it");
  const all = searches();
  assert.ok(all.length >= 1, "at least one search ran");
  for (const [i, s] of all.entries()) {
    assert.match(s, /project_not_=cmip6/, `search ${i + 1} is still negatively filtered: ${s}`);
  }
  assert.ok(!all.some((s) => !/project_not_/.test(s)), "no unfiltered corrective search fired");
  assert.equal(all.length, 1, "and no needless re-search at all");
  // The chip is present and removable, so the user can still get out of the deep link.
  const chip = qa<HTMLElement>(root, ".chips .chip").find((c) =>
    (c.textContent ?? "").includes("cmip6"),
  );
  assert.ok(chip, "the exclusion is a removable chip");
  handle.destroy();
});

test("the same holds for a translated flavour key (mip_era_not_)", async () => {
  const { handle } = await mountWithUrl(
    router({ mip_era: ["cordex", 1] }, ["freva", "cmip6"]),
    "/?flavour=cmip6&mip_era_not_=cmip6",
  );
  assert.deepEqual(handle.getState().selected, { mip_era_not_: ["cmip6"] });
  assert.equal(handle.getState().flavour, "cmip6");
  for (const s of searches()) assert.match(s, /mip_era_not_=cmip6/, `filtered: ${s}`);
  assert.match(win.location.search, /mip_era_not_=cmip6/);
  handle.destroy();
});

test("the host-parameter contract is unchanged: junk is released, real facets are kept", async () => {
  const { handle } = await mountWithUrl(
    router({ project: ["cordex", 1] }),
    "/?project_not_=cmip6&utm_source=newsletter&page=3",
  );
  const state = handle.getState();
  assert.deepEqual(state.selected, { project_not_: ["cmip6"] }, "only the real facet is imported");
  assert.ok(!("utm_source" in state.selected), "a host param is not a facet");
  assert.ok(!("page" in state.selected));
  // …and it survives in the address bar, because the widget never claimed ownership of it.
  assert.match(win.location.search, /utm_source=newsletter/, "the host's own param is preserved");
  assert.match(win.location.search, /page=3/);
  assert.match(win.location.search, /project_not_=cmip6/);
  handle.destroy();
});

// exclusion-only clearing

async function excludeFirstValue(root: HTMLElement, label: RegExp): Promise<void> {
  qa<HTMLElement>(root, ".facet-head")
    .find((h) => label.test(h.textContent ?? ""))
    ?.click();
  await tick();
  const row = qa<HTMLElement>(root, ".side-scroll .fval-row")[0];
  row.querySelector<HTMLButtonElement>(".fval-ex")!.click();
  await wait(320);
}

test("the sidebar header badge clears an EXCLUSION-ONLY facet", async () => {
  const { handle, root } = await mountWithUrl(router({ project: ["cmip6", 2, "cordex", 1] }), "/");
  await excludeFirstValue(root, /project/i);
  assert.deepEqual(handle.getState().selected, { project_not_: ["cmip6"] });
  const badge = qa<HTMLElement>(root, ".facet .fh-count").find((b) =>
    (b.getAttribute("aria-label") ?? "").includes("Project"),
  );
  assert.ok(badge, "the header badge counts the exclusion");
  // An exclusion-only facet shows ONE badge, reading `-1` in a dashed shape - never a bare `1` that
  // looks identical to an inclusion, and never a distinction carried by colour alone.
  assert.ok(badge!.classList.contains("fb-exc"), "…dashed, not solid");
  assert.equal(badge!.querySelector(".fb-n")?.textContent, "\u22121", "…as one EXCLUSION");
  assert.match(badge!.getAttribute("aria-label") ?? "", /1 excluded/i, "spoken, not just drawn");
  badge!.click();
  await wait(320);
  assert.deepEqual(
    handle.getState().selected,
    {},
    "the badge CLEARS it - guarding only on the positive key would silently no-op",
  );
  handle.destroy();
});

test("the badge clears BOTH modes of a mixed-mode facet in one commit", async () => {
  const { handle, root } = await mountWithUrl(
    router({ project: ["cmip6", 2, "cordex", 1, "cmip5", 1] }),
    "/",
  );
  qa<HTMLElement>(root, ".facet-head")
    .find((h) => /project/i.test(h.textContent ?? ""))
    ?.click();
  await tick();
  qa<HTMLElement>(root, ".side-scroll .fval-row")[0]
    .querySelector<HTMLButtonElement>(".fval-ex")!
    .click();
  await wait(320);
  qa<HTMLElement>(root, ".facet-head")
    .find((h) => /project/i.test(h.textContent ?? ""))
    ?.click();
  await tick();
  const rows = qa<HTMLElement>(root, ".side-scroll .fval-row");
  rows[rows.length - 1].querySelector<HTMLButtonElement>(".fval")!.click();
  await wait(320);
  const before = handle.getState().selected;
  assert.ok(Object.keys(before).length === 2, `mixed mode set up: ${JSON.stringify(before)}`);
  const searchesBefore = searches().length;
  // Mixed mode shows TWO INDEPENDENT buttons: `+1` and `-1`. Clearing one leaves the other alone,
  // which is the whole reason they are separate controls.
  const badges = qa<HTMLElement>(root, ".facet .fh-count");
  const inc = badges.find((b) => b.classList.contains("fb-inc"))!;
  const exc = badges.find((b) => b.classList.contains("fb-exc"))!;
  assert.equal(inc.querySelector(".fb-n")?.textContent, "+1");
  assert.equal(exc.querySelector(".fb-n")?.textContent, "\u22121");
  assert.match(inc.getAttribute("aria-label") ?? "", /clear 1 included/i);
  assert.match(exc.getAttribute("aria-label") ?? "", /clear 1 excluded/i);
  exc.click();
  await wait(320);
  assert.deepEqual(
    Object.keys(handle.getState().selected),
    ["project"],
    "clearing the EXCLUSIONS left the inclusion untouched",
  );
  assert.equal(searches().length, searchesBefore + 1, "…in ONE commit, not two");
  qa<HTMLElement>(root, ".facet .fh-count")
    .find((b) => b.classList.contains("fb-inc"))!
    .click();
  await wait(320);
  assert.deepEqual(handle.getState().selected, {}, "and then the inclusion clears too");
  assert.equal(searches().length, searchesBefore + 2, "one commit each, never a combined one");
  handle.destroy();
});

test("the overview header badge clears an exclusion-only facet too", async () => {
  const { handle, root } = await mountWithUrl(router({ project: ["cmip6", 2, "cordex", 1] }), "/");
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
  await wait(60);
  const card = qa<HTMLElement>(root, '.fcard[data-key="project"]')[0];
  assert.ok(card, "the project card is on the grid");
  card.querySelector<HTMLButtonElement>(".fval-row .fval-ex")!.click();
  await wait(340);
  assert.deepEqual(handle.getState().selected, { project_not_: ["cmip6"] });
  const badge = q<HTMLElement>(qa<HTMLElement>(root, '.fcard[data-key="project"]')[0], ".fh-count");
  assert.ok(badge, "the card's header badge appears for an exclusion");
  badge!.click();
  await wait(320);
  assert.deepEqual(handle.getState().selected, {}, "and it clears");
  handle.destroy();
});

// base-scope URL sanitisation

test("a NEGATIVE base scope lets the URL add further exclusions", async () => {
  const { handle, root } = await mountWithUrl(
    router({ project: ["cmip5", 1] }),
    "/?project_not_=cordex",
    { baseFilters: { project_not_: "cmip6" } },
  );
  assert.deepEqual(
    handle.getState().selected,
    { project_not_: ["cordex"] },
    "the user's own exclusion is kept - a negative scope does not own the facet",
  );
  const wire = facetQueryString(handle.getState());
  assert.match(wire, /project_not_=cmip6/, "the scope's exclusion is on the wire");
  assert.match(wire, /project_not_=cordex/, "…alongside the user's");
  assert.equal(
    (wire.match(/project_not_=/g) ?? []).length,
    2,
    "exactly two, with no duplicate pairs",
  );
  // …and the user can still NARROW positively inside that scope.
  qa<HTMLElement>(root, ".facet-head")
    .find((h) => /project/i.test(h.textContent ?? ""))
    ?.click();
  await tick();
  qa<HTMLElement>(root, ".side-scroll .fval")[0]?.click();
  await wait(320);
  assert.match(
    facetQueryString(handle.getState()),
    /(^|&)project=cmip5(&|$)/,
    "a positive narrowing inside a negative scope still reaches the wire",
  );
  handle.destroy();
});

test("a POSITIVE base scope rejects a removable positive URL selection on its key", async () => {
  const { handle } = await mountWithUrl(router({ project: ["waterpark", 2] }), "/?project=other", {
    baseFilters: { project: "waterpark" },
  });
  assert.deepEqual(handle.getState().selected, {}, "no removable project state");
  const wire = facetQueryString(handle.getState());
  assert.match(wire, /(^|&)project=waterpark(&|$)/);
  assert.doesNotMatch(wire, /project=other/, "the scope cannot be widened from the URL");
  handle.destroy();
});

test("a POSITIVE base scope also rejects a NEGATIVE URL selection on its key", async () => {
  const { handle, root } = await mountWithUrl(
    router({ project: ["waterpark", 2] }),
    "/?project_not_=waterpark",
    { baseFilters: { project: "waterpark" } },
  );
  assert.deepEqual(handle.getState().selected, {}, "no inert negative state");
  assert.equal(
    qa<HTMLElement>(root, ".chips .chip:not(.scope)").length,
    0,
    "…and no misleading chip the user cannot act on",
  );
  const wire = facetQueryString(handle.getState());
  assert.match(wire, /(^|&)project=waterpark(&|$)/);
  assert.doesNotMatch(
    wire,
    /project_not_/,
    "a user exclusion cannot empty the instance it is scoped to",
  );
  handle.destroy();
});

test("base-scope ownership is suffix- and flavour-aware", async () => {
  const { handle } = await mountWithUrl(
    router({ mip_era: ["waterpark", 2] }, ["freva", "cmip6"]),
    "/?flavour=cmip6&mip_era_not_=waterpark&mip_era=other",
    { baseFilters: { project: "waterpark" } },
  );
  assert.deepEqual(
    handle.getState().selected,
    {},
    "the freva-canonical scope owns `mip_era` under the cmip6 lens, in both modes",
  );
  assert.match(facetQueryString(handle.getState()), /mip_era=waterpark/);
  handle.destroy();
});

// the bulk control

test("past the cap, the bulk control SAYS what it will do", async () => {
  installFetch(((call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    return {
      body: searchResponse({
        total: 40,
        rows: Array.from({ length: 40 }, (_, i) => ({ file: `/f_${i}.nc` })),
      }),
    };
  }) as never);
  const host = makeHost();
  const handle = mountDataBrowser(host, { syncUrl: false });
  await wait(60);
  const root = host.querySelector(".freva-db") as HTMLElement;
  const btn = q<HTMLElement>(root, ".selall")!;
  const label = (): string => q<HTMLElement>(btn, ".ctrl-lbl")?.textContent ?? "";

  assert.equal(label(), "Select first 25", "40 rows loaded: 'all' is not on offer");
  assert.match(btn.getAttribute("aria-label") ?? "", /first 25 of 40/);

  btn.click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 25);
  // The label must not read "Select all" while the next click would clear.
  assert.equal(label(), "Clear 25 selected", "the visible label matches the next action");
  assert.match(
    btn.getAttribute("aria-label") ?? "",
    /^Clear the 25 selected files$/,
    "…and so does the accessible name",
  );
  assert.equal(btn.getAttribute("aria-checked"), "true", "…and the checkbox state agrees");

  btn.click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 0, "and it does clear");
  assert.equal(label(), "Select first 25", "back to offering the capped selection");
  handle.destroy();
});

test("under the cap the control still reads Select all / Clear", async () => {
  installFetch(((call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    return {
      body: searchResponse({
        total: 3,
        rows: [{ file: "/a.nc" }, { file: "/b.nc" }, { file: "/c.nc" }],
      }),
    };
  }) as never);
  const host = makeHost();
  const handle = mountDataBrowser(host, { syncUrl: false });
  await wait(60);
  const root = host.querySelector(".freva-db") as HTMLElement;
  const btn = q<HTMLElement>(root, ".selall")!;
  const label = (): string => q<HTMLElement>(btn, ".ctrl-lbl")?.textContent ?? "";
  assert.equal(label(), "Select all");
  btn.click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 3);
  assert.equal(label(), "Clear 3 selected");
  btn.click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 0);
  handle.destroy();
});
