// End-to-end behaviour driven through the real mounted component against a scripted backend.
// helpers.ts MUST be imported first so the DOM globals exist before index.

import "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  abortedUrls,
  clipboardWrites,
  fetchCalls,
  installFetch,
  pickValue,
  makeHost,
  overviewResponse,
  searchResponse,
  tick,
  wait,
  window as win,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";
import { setInspectorImporterForTests } from "../src/components/inspector.js";
import { Disposables, el } from "../src/dom.js";
import type { DataBrowserConfig, DataBrowserHandle } from "../src/types.js";

const HOSTILE = "<img src=x onerror=alert(1)>";
const HOSTILE_PATH = `/data/${HOSTILE}/evil_200601-210012.nc`;

// Persisted prefs (theme/layout/view/overview/terminal) are namespaced under freva.db.* and read on
// mount. Without isolation they leak between tests and make the suite order-dependent. Clear them
// before every test so each starts from a pristine, first-run state.
beforeEach(() => {
  try {
    win.localStorage.clear();
  } catch {
    /* jsdom without storage */
  }
  try {
    win.history.replaceState(null, "", "/");
  } catch {
    /* jsdom without history */
  }
});

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

/** Open a sidebar facet accordion (value lists are filled lazily). */
function openFacet(root: ParentNode, key: string): void {
  q<HTMLButtonElement>(root, `.facet[data-key="${key}"] .facet-head`)?.click();
}

/** Mount and let the overview + first search settle. */
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
  const handle = mountDataBrowser(host, { syncUrl: false, ...cfg }); // URL sync off unless a test opts in
  await wait(30); // overview + first (non-debounced) search
  const root = q<HTMLElement>(host, ".freva-db");
  assert.ok(root, "root mounted");
  return { handle, host, root: root as HTMLElement };
}

const defaultRouter =
  (extra?: Partial<Parameters<typeof searchResponse>[0]>) => (call: { url: string }) => {
    if (call.url.includes("/overview")) {
      return {
        body: overviewResponse(["freva", "cmip5", "cmip6", "cordex", "user"], {
          project: [],
          variable: [],
        }),
      };
    }
    if (call.url.includes("/extended-search/")) {
      return {
        body: searchResponse({
          total: extra?.total ?? 2,
          rows: extra?.rows ?? [{ file: "/data/a_200601-200612.nc" }, { file: HOSTILE_PATH }],
          facets: extra?.facets ?? { project: [HOSTILE, 5, "cmip6", 3], variable: ["tas", 8] },
          primary: extra?.primary ?? ["project", "variable"],
        }),
      };
    }
    return { body: {} };
  };

test("XSS: hostile facet value, flavour label, and path render inert (incl. terminal overlay)", async () => {
  const { handle, root } = await mount(defaultRouter());

  // sidebar value renders the hostile string as TEXT, not as an <img>
  openFacet(root, "project"); // accordion bodies are filled lazily
  const valueRow = byText(root, ".side-scroll .fval", HOSTILE);
  assert.ok(valueRow, "hostile facet value row exists");
  assert.equal(q(valueRow!, "img"), null, "no <img> injected from the value");
  assert.ok((valueRow!.querySelector(".nm")?.textContent ?? "").includes(HOSTILE));

  // a hostile path renders as text in the results
  assert.ok(
    byText(root, ".row .path", "evil_200601-210012.nc") || byText(root, "#fdb-results", "evil"),
  );
  assert.equal(qa(root, "#fdb-results img").length, 0, "no <img> from a path");

  // select the hostile facet -> chip + terminal overlay must both stay inert
  (valueRow as HTMLElement).click();
  await wait(20);
  const chip = byText(root, ".chips .chip", HOSTILE);
  assert.ok(chip, "chip shows the hostile value");
  assert.equal(q(chip!, "img"), null, "chip has no injected <img>");

  const overlay = q<HTMLElement>(root, ".te-hl");
  assert.ok(overlay, "terminal overlay present");
  assert.equal(q(overlay!, "img"), null, "overlay escaped the value - no real <img>");
  assert.match(overlay!.innerHTML, /&lt;img/, "overlay shows escaped markup");

  // nowhere in the document did data become a script/img element (the brand logo is the one
  // legitimate <img> - a bundled data URI, not derived from any API/user string).
  assert.equal(qa(win.document, "script[data-evil], img:not(.brand-logo)").length, 0);
  handle.destroy();
});

test("overview: a card can be EXPANDED while stacked and it sticks across re-render", async () => {
  const { handle, root } = await mount(defaultRouter());
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')!.click();
  await tick();
  q<HTMLButtonElement>(root, ".ov-shelve")!.click(); // Stack
  await tick();
  assert.equal(handle.getState().overviewStacked, true, "stacked");
  const grid = q<HTMLElement>(root, ".facet-grid")!;
  const card = qa<HTMLElement>(grid, ".fcard[data-key]").find(
    (c) => !(c.dataset.key ?? "").startsWith("__") && c.classList.contains("collapsed"),
  )!;
  const key = card.dataset.key!;
  const chevron = card.querySelector<HTMLButtonElement>('.fcard-h button[aria-expanded="false"]')!;
  assert.ok(chevron, "the collapsed card has an expand control");
  chevron.click();
  await tick();
  const after = q<HTMLElement>(root, ".facet-grid")!.querySelector<HTMLElement>(
    `.fcard[data-key="${key}"]`,
  )!;
  assert.ok(
    !after.classList.contains("collapsed"),
    "the card expanded (and a re-render did not re-collapse it)",
  );
  // a second render must not undo it either
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')!.click();
  await tick();
  const again = q<HTMLElement>(root, ".facet-grid")!.querySelector<HTMLElement>(
    `.fcard[data-key="${key}"]`,
  )!;
  assert.ok(
    !again.classList.contains("collapsed"),
    "still expanded after another render while stacked",
  );
  handle.destroy();
});

test("overview Stack absorbs facets that arrive after stacking (persisted)", async () => {
  const base =
    (facets: Record<string, (string | number)[]>, primary: string[]) => (call: { url: string }) => {
      if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
      if (call.url.includes("/extended-search/"))
        return { body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }], facets, primary }) };
      return { body: {} };
    };
  // session 1: only `project`; stack it and persist
  const { handle, root } = await mount(base({ project: ["cmip6", 1] }, ["project"]));
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')!.click();
  await tick();
  q<HTMLButtonElement>(root, ".ov-shelve")!.click();
  await tick();
  assert.equal(handle.getState().overviewStacked, true, "stacked");
  handle.destroy();
  // session 2 (SAME origin, no beforeEach between mounts): the API now also returns `model`
  const { handle: h2, root: r2 } = await mount(
    base({ project: ["cmip6", 1], model: ["x", 1] }, ["project", "model"]),
  );
  q<HTMLButtonElement>(r2, '[aria-label="Overview"]')!.click();
  await tick();
  assert.equal(h2.getState().overviewStacked, true, "still stacked from persistence");
  const modelCard = q<HTMLElement>(r2, '.facet-grid .fcard[data-key="model"]');
  assert.ok(modelCard, "the newly-arrived model card is present");
  assert.ok(
    modelCard!.classList.contains("collapsed"),
    "a facet that arrived after Stack is collapsed, not expanded full-width",
  );
  h2.destroy();
});

test("overview Stack/Unstack is reversible - pre-stack collapse survives, specials stack too", async () => {
  const { handle, root } = await mount(defaultRouter());
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')!.click();
  await tick();
  const grid = q<HTMLElement>(root, ".facet-grid")!;
  const firstKey = grid.querySelector<HTMLElement>(".fcard[data-key]:not(.fcard-sp)")!.dataset.key!;
  q<HTMLElement>(
    grid.querySelector<HTMLElement>(`.fcard[data-key="${firstKey}"]`)!,
    ".fh-label",
  )!.click(); // user collapses one block
  await tick();
  assert.ok(
    handle.getState().overviewCollapsed.has(firstKey),
    "the block is collapsed by the user",
  );
  const before = [...handle.getState().overviewCollapsed].sort();

  const shelve = q<HTMLButtonElement>(root, ".ov-shelve")!;
  shelve.click();
  await tick(); // Stack
  assert.ok(
    handle.getState().overviewCollapsed.has("__time") &&
      handle.getState().overviewCollapsed.has("__bbox"),
    "stacking collapses the time/bbox specials too (derived from state, not just the DOM)",
  );
  assert.ok(
    handle.getState().overviewCollapsed.size > before.length,
    "stacking collapsed everything",
  );

  shelve.click();
  await tick(); // Unstack -> restore the exact pre-stack layout
  assert.deepEqual(
    [...handle.getState().overviewCollapsed].sort(),
    before,
    "Unstack restored the user\u2019s own collapse state rather than wiping it",
  );
  handle.destroy();
  try {
    win.localStorage.clear();
  } catch {
    /* jsdom */
  }
});

test("overview Stack toggles a full-width accordion, and Unstack restores the grid", async () => {
  const { handle, root } = await mount(defaultRouter());
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')!.click(); // enter the overview workspace
  await tick();
  const grid = q<HTMLElement>(root, ".facet-grid")!;
  const shelve = q<HTMLButtonElement>(root, ".ov-shelve")!;
  assert.ok(shelve && !shelve.hidden, "the Stack button is visible in the overview");
  assert.ok(!grid.classList.contains("stacked"), "not stacked to begin with");

  shelve.click();
  await tick();
  assert.equal(handle.getState().overviewStacked, true, "stacked state is on");
  assert.ok(grid.classList.contains("stacked"), "the grid becomes a single-column accordion");
  const cards = qa<HTMLElement>(grid, ".fcard[data-key]");
  assert.ok(
    cards.length > 0 && cards.every((c) => c.classList.contains("collapsed")),
    "every block is collapsed",
  );
  assert.match(
    shelve.querySelector(".tbtn-lbl")?.textContent ?? "",
    /Unstack/,
    "the label flips to Unstack",
  );

  shelve.click();
  await tick();
  assert.equal(handle.getState().overviewStacked, false, "unstacked");
  const grid2 = q<HTMLElement>(root, ".facet-grid")!;
  assert.ok(!grid2.classList.contains("stacked"), "the multi-column grid is restored");
  // unstack must return to day one - every block EXPANDED again, none stuck collapsed
  const after = qa<HTMLElement>(grid2, ".fcard[data-key]");
  assert.ok(
    after.length > 0 && after.every((c) => !c.classList.contains("collapsed")),
    "every block is expanded again after Unstack",
  );
  assert.equal(handle.getState().overviewCollapsed.size, 0, "no collapsed state lingers");
  handle.destroy();
  try {
    win.localStorage.clear();
  } catch {
    /* jsdom */
  } // don't leak stacked/collapsed prefs to later tests
});

test('flavour dropdown: label reads "Flavour" and the Manage entry is gone', async () => {
  const { handle, root } = await mount(defaultRouter());
  const lens = q<HTMLButtonElement>(root, ".lens")!;
  assert.equal(
    q<HTMLElement>(lens, ".k")?.textContent,
    "Flavour",
    "the lens label says Flavour, not Naming",
  );
  lens.click();
  await tick();
  const items = qa<HTMLElement>(root, ".lens-pop .pop-item");
  assert.ok(items.length > 0, "the flavour options are listed");
  assert.ok(
    !items.some((b) => /manage/i.test(b.textContent ?? "")),
    'no "Manage naming flavours" entry',
  );
  handle.destroy();
});

test("overview: clicking a block header toggles collapse/expand; header controls do not", async () => {
  const { handle, root } = await mount(defaultRouter());
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
  await tick();
  const grid = q<HTMLElement>(root, ".facet-grid")!;
  const card = qa<HTMLElement>(grid, ".fcard[data-key]").find(
    (c) => !c.classList.contains("collapsed") && !c.classList.contains("fcard-sp"),
  )!;
  assert.ok(card, "an expanded facet block exists");
  const key = card.dataset.key!;
  assert.ok(!handle.getState().overviewCollapsed.has(key), "starts expanded");

  // a click on the header body (the label - not a control) collapses the block
  q<HTMLElement>(card, ".fh-label")!.click();
  await tick();
  assert.ok(handle.getState().overviewCollapsed.has(key), "header click collapsed the block");

  // and again on the re-rendered (now collapsed) header expands it
  q<HTMLElement>(qa<HTMLElement>(root, `.fcard[data-key="${key}"]`)[0], ".fh-label")!.click();
  await tick();
  assert.ok(!handle.getState().overviewCollapsed.has(key), "header click expanded it again");

  // a click on a header CONTROL (sort) must NOT toggle collapse
  const card3 = qa<HTMLElement>(root, `.fcard[data-key="${key}"]`)[0];
  q<HTMLButtonElement>(card3, ".sortbtn")!.click();
  await tick();
  assert.ok(!handle.getState().overviewCollapsed.has(key), "sorting did not collapse the block");
  handle.destroy();
});

test("overview: the collapse control exposes aria-expanded to assistive tech", async () => {
  const { handle, root } = await mount(defaultRouter());
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
  await tick();
  const card = q<HTMLElement>(root, ".facet-grid .fcard[data-key]:not(.fcard-sp)")!;
  const collapseBtn = q<HTMLButtonElement>(card, '.fcard-h [aria-label="Minimize"]')!;
  assert.ok(collapseBtn, "the collapse control is present");
  assert.equal(
    collapseBtn.getAttribute("aria-expanded"),
    "true",
    "an expanded block reports aria-expanded=true",
  );
  q<HTMLElement>(card, ".fh-label")!.click(); // collapse it
  await tick();
  const collapsed = q<HTMLButtonElement>(
    root,
    `.facet-grid .fcard[data-key="${card.dataset.key}"] .fcard-h [aria-label="Expand"]`,
  )!;
  assert.equal(
    collapsed.getAttribute("aria-expanded"),
    "false",
    "a collapsed block reports aria-expanded=false",
  );
  handle.destroy();
});

test("lens menu: activating an item with the keyboard returns focus to the trigger (focus mgmt)", async () => {
  const { handle, root } = await mount(defaultRouter());
  const lens = q<HTMLButtonElement>(root, ".lens")!;
  lens.focus();
  lens.click();
  await tick();
  const item = qa<HTMLButtonElement>(root, ".lens-pop .pop-item")[0];
  assert.ok(item, "the flavour menu is open");
  item.focus(); // keyboard focus is inside the popover
  item.click(); // activate -> popover closes
  await tick();
  assert.equal(win.document.activeElement, lens, "focus returned to the lens trigger, not <body>");
  handle.destroy();
});

test("overview: keyboard reorder - ArrowRight on a grip moves the card later and keeps focus (a11y)", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["x", 1], model: ["y", 1] },
          primary: ["project", "model"],
        }),
      };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')!.click();
  await tick();
  const keysOf = (): string[] =>
    qa<HTMLElement>(q<HTMLElement>(root, ".facet-grid")!, ".fcard[data-key]")
      .map((c) => c.dataset.key ?? "")
      .filter((k) => k && !k.startsWith("__"));
  const before = keysOf();
  assert.ok(before.length >= 2, "two reorderable cards");
  const first = before[0];
  const grip = q<HTMLElement>(root, `.fcard[data-key="${first}"] .drag-grip`)!;
  assert.equal(grip.tagName, "BUTTON", "the grip is a real focusable control");
  grip.focus();
  grip.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await tick();
  const after = keysOf();
  assert.equal(after[1], first, "the card moved one position later");
  // The persisted order covers EVERY card, Time and BBox included - they reorder like any other.
  const allKeys = qa<HTMLElement>(q<HTMLElement>(root, ".facet-grid")!, ".fcard[data-key]").map(
    (c) => c.dataset.key ?? "",
  );
  assert.deepEqual(handle.getState().overviewOrder, allKeys, "the new order is persisted to state");
  assert.ok(allKeys.includes("__time") && allKeys.includes("__bbox"));
  assert.equal(
    win.document.activeElement,
    q<HTMLElement>(root, `.fcard[data-key="${first}"] .drag-grip`),
    "focus returned to the moved card’s grip",
  );
  handle.destroy();
});

test("overview: keyboard resize - ArrowRight/ArrowUp on the corner grows span/rows (a11y)", async () => {
  const { handle, root } = await mount(defaultRouter());
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')!.click();
  await tick();
  const card = qa<HTMLElement>(q<HTMLElement>(root, ".facet-grid")!, ".fcard[data-key]").find(
    (c) => !(c.dataset.key ?? "").startsWith("__"),
  )!;
  const key = card.dataset.key!;
  const rz = card.querySelector<HTMLElement>(".fcard-resize")!;
  assert.equal(rz.tagName, "BUTTON", "the resize corner is focusable");
  rz.focus();
  rz.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await tick();
  assert.equal(handle.getState().overviewSpan[key], 2, "ArrowRight widened the card to span 2");
  q<HTMLElement>(root, `.fcard[data-key="${key}"] .fcard-resize`)!.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
  );
  await tick();
  assert.equal(handle.getState().overviewH[key], 2, "ArrowUp grew the card to 2 rows");
  handle.destroy();
});

test("getState() returns a decoupled snapshot - mutating it never reaches internal state", async () => {
  const { handle } = await mount(defaultRouter());
  const snap = handle.getState();
  snap.pickedKeys.add("ghost");
  (snap.selected as Record<string, string[]>).injected = ["x"];
  const fresh = handle.getState();
  assert.ok(
    !fresh.pickedKeys.has("ghost"),
    "mutating the snapshot Set did not touch internal state",
  );
  assert.ok(
    !("injected" in fresh.selected),
    "mutating the snapshot object did not touch internal state",
  );
  handle.destroy();
});

test("el(): a `title` never overrides a visible text label; icon-only still gets a name", () => {
  const help = "Any overlap between your box and the file counts";
  const labelled = el("button", { text: "flexible", title: help });
  assert.equal(labelled.getAttribute("data-tip"), help, "the tip text is still set");
  assert.equal(
    labelled.getAttribute("aria-label"),
    null,
    "visible text stays the accessible name, not the help sentence",
  );
  const iconOnly = el("button", { title: "Close" }, [el("span", { class: "i" })]);
  assert.equal(
    iconOnly.getAttribute("aria-label"),
    "Close",
    "an icon-only control still gets an accessible name",
  );
  const explicit = el("button", { text: "x", title: "tip", "aria-label": "Explicit" });
  assert.equal(
    explicit.getAttribute("aria-label"),
    "Explicit",
    "an explicit aria-label always wins",
  );
});

test("destroy() during an overview drag releases the page-wide drag lock", async () => {
  const { handle, root } = await mount(defaultRouter());
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
  await tick();
  const grip = q<HTMLElement>(root, ".fcard .drag-grip");
  assert.ok(grip, "an overview block has a drag grip");
  // Pointer Events: mouse, pen and touch share ONE code path, so the test drives that path.
  grip!.dispatchEvent(pointerEvent("pointerdown", { bubbles: true }));
  assert.ok(win.document.body.classList.contains("fdb-dragging"), "the drag lock engaged");
  handle.destroy();
  assert.ok(
    !win.document.body.classList.contains("fdb-dragging"),
    "destroy() mid-drag cleared the body lock",
  );
});

test("tooltip: a visible tip hides when its anchor is removed by a re-render, with no pointer event", async () => {
  const { handle, root } = await mount(defaultRouter());
  const btn = qa<HTMLElement>(root, "[data-tip]")[0]!;
  const tip = q<HTMLElement>(root, ".fdb-tip")!;
  btn.dispatchEvent(new win.MouseEvent("pointerover", { bubbles: true }));
  await wait(120); // past SHOW_DELAY
  assert.ok(tip.classList.contains("show"), "tip shows after the delay");
  // Remove the anchor the way a region re-render would - no pointerout/focusout fires.
  btn.remove();
  await tick();
  await tick(); // let the MutationObserver callback run
  assert.ok(!tip.classList.contains("show"), "the tip hid itself once its anchor detached");
  handle.destroy();
});

test("tooltip: moving onto an inner child does not dismiss the tip", async () => {
  const { handle, root } = await mount(defaultRouter());
  const btn = qa<HTMLElement>(root, "[data-tip]").find((e) => e.children.length > 0)!;
  assert.ok(btn, "a tooltipped control with an inner child exists");
  const child = btn.children[0] as HTMLElement;
  const tip = q<HTMLElement>(root, ".fdb-tip")!;
  btn.dispatchEvent(new win.MouseEvent("pointerover", { bubbles: true }));
  await wait(120); // past SHOW_DELAY
  assert.ok(tip.classList.contains("show"), "tip shows after the delay");
  btn.dispatchEvent(new win.MouseEvent("pointerout", { bubbles: true, relatedTarget: child }));
  assert.ok(
    tip.classList.contains("show"),
    "staying inside the control (onto its child) keeps the tip up",
  );
  btn.dispatchEvent(new win.MouseEvent("pointerout", { bubbles: true, relatedTarget: root }));
  assert.ok(!tip.classList.contains("show"), "leaving the control hides the tip");
  handle.destroy();
});

test("overview: a facet committed from the terminal patches the grid highlight in place", async () => {
  const { handle, root } = await mount(defaultRouter());
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
  await tick();
  q<HTMLButtonElement>(root, '[aria-label="Command terminal"]')!.click();
  await tick();
  const input = q<HTMLTextAreaElement>(root, ".te-input")!;
  input.value = "project=cmip6 "; // trailing space completes the token so it commits
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(20);
  assert.deepEqual(
    handle.getState().selected.project,
    ["cmip6"],
    "the terminal committed the facet",
  );
  const grid = q<HTMLElement>(root, ".facet-grid")!;
  const row = qa<HTMLElement>(grid, ".fval").find(
    (r) => r.querySelector(".nm")?.textContent === "cmip6",
  );
  assert.ok(row, "the cmip6 value row is in the overview");
  assert.ok(
    row!.classList.contains("sel"),
    "the terminal-committed value is highlighted without waiting for the search",
  );
  assert.equal(row!.getAttribute("aria-checked"), "true", "aria-checked patched too");
  handle.destroy();
});

test("details cache is flavour-scoped - switching flavour refetches metadata, never serves stale", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva", "cmip6"], {}) };
    if (call.url.includes("/file?"))
      return { body: { search_results: [{ file: "/a.nc" }], facets: { project: ["x", 1] } } };
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }] }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '.seg [aria-label="List view"]')?.click();
  await tick();
  q<HTMLElement>(root, "#fdb-results .cb")!.click(); // pick the file
  await tick();
  q<HTMLButtonElement>(root, '[aria-label="Details panel"]')!.click(); // open -> fetch metadata under freva
  await wait(60);
  // the per-file metadata endpoint is the one carrying a `file=` param (the plain search has none)
  const meta = (fl: string): number =>
    fetchCalls.filter((c) => c.url.includes(`/${fl}/file?`) && /[?&]file=/.test(c.url)).length;
  assert.ok(meta("freva") >= 1, "metadata fetched under the freva lens");

  q<HTMLButtonElement>(root, ".lens")!.click();
  await tick();
  byText<HTMLButtonElement>(root, ".lens-pop .pop-item", "cmip6")!.click();
  await wait(320);
  assert.ok(
    meta("cmip6") >= 1,
    "metadata REfetched under the new lens (not served from the freva cache)",
  );
  handle.destroy();
});

test("overview: toggling a facet value patches selection in place - no grid rebuild", async () => {
  const { handle, root } = await mount(defaultRouter());
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
  await tick();
  const grid = q<HTMLElement>(root, ".facet-grid")!;
  const card = grid.querySelector<HTMLElement>(".fcard[data-key]:not(.fcard-sp)")!;
  card.dataset.sentinel = "keep"; // survives only if this node is NOT torn down and rebuilt
  const row = card.querySelector<HTMLElement>(".fval")!;
  assert.ok(!row.classList.contains("sel"), "row starts unselected");
  row.click();
  await tick();
  assert.equal(
    grid.querySelector<HTMLElement>(".fcard[data-key]")!.dataset.sentinel ?? card.dataset.sentinel,
    "keep",
    "the grid was not rebuilt on toggle",
  );
  assert.ok(
    card.querySelector(".fval")!.classList.contains("sel"),
    "selection highlight patched in place",
  );
  assert.equal(
    card.querySelector(".fval")!.getAttribute("aria-checked"),
    "true",
    "aria-checked patched",
  );
  assert.ok(card.querySelector(".fh-count"), "the clear-facet badge appeared in place");
  handle.destroy();
});

test("overview: a persisted Overview layout does not auto-load Leaflet without a gesture", async () => {
  const { setLeafletLoaderForTests } = await import("../src/map.js");
  const g = globalThis as unknown as Record<string, unknown>;
  const realIO = g.IntersectionObserver;
  // a fake IO that reports EVERYTHING as immediately on screen - the strongest form of the check:
  // even with the bbox card fully visible, no Leaflet must load until the user clicks Zoom.
  class EagerIO {
    constructor(cb: (e: Array<{ isIntersecting: boolean; target: Element }>) => void) {
      this.cb = cb;
    }
    cb: (e: Array<{ isIntersecting: boolean; target: Element }>) => void;
    observe(t: Element): void {
      this.cb([{ isIntersecting: true, target: t }]);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  g.IntersectionObserver = EagerIO as unknown as typeof IntersectionObserver;
  (win as unknown as Record<string, unknown>).IntersectionObserver = EagerIO;
  let loads = 0;
  setLeafletLoaderForTests(async () => {
    loads++;
    throw new Error("offline");
  });
  win.localStorage.setItem("freva.db.layout", "overview");
  try {
    const { handle, root } = await mount(defaultRouter());
    await wait(40);
    assert.equal(
      loads,
      0,
      "Leaflet is NOT loaded just because the overview bbox card is on screen",
    );
    const zoom = q<HTMLButtonElement>(root, ".fcard-sp .map-zoom, .facet-grid .map-zoom");
    assert.ok(zoom, "the overview bbox card offers an explicit Zoom button instead");
    zoom!.click();
    await wait(30);
    assert.equal(loads, 1, "Leaflet loads only on the explicit gesture");
    handle.destroy();
  } finally {
    setLeafletLoaderForTests(null);
    win.localStorage.removeItem("freva.db.layout");
    g.IntersectionObserver = realIO;
    (win as unknown as Record<string, unknown>).IntersectionObserver = realIO;
  }
});

test("tooltips: `title` becomes an immediate styled tooltip (data-tip), never the native popup", async () => {
  const { handle, root } = await mount(defaultRouter());
  // the single reused tooltip bubble is installed on the app root
  assert.ok(q(root, ".fdb-tip"), "the tooltip bubble is present");
  // a titled button (Export) carries data-tip and NO native title attribute
  const exportBtn = q<HTMLElement>(root, '[aria-label^="Export catalogue"]')!;
  assert.equal(exportBtn.getAttribute("data-tip"), "Export catalogue", "title routed to data-tip");
  assert.equal(exportBtn.getAttribute("title"), null, "no native title (so no slow browser popup)");
  assert.equal(qa(root, "[title]").length, 0, "no element uses the native title attribute");
  handle.destroy();
});

test("Browsing fetches NO per-file metadata", async () => {
  const { handle } = await mount(defaultRouter());
  // A per-file metadata call is distinguished by a file= query param (the uniqKey path segment
  // is also literally "file", so the path alone is not the signal).
  const fileCalls = fetchCalls.filter((c) => /[?&]file=/.test(c.url));
  assert.equal(fileCalls.length, 0, "no ?file= per-file fetches while only browsing");
  // and the main search did run
  assert.ok(
    fetchCalls.some((c) => c.url.includes("/extended-search/") && !/[?&]file=/.test(c.url)),
  );

  // positive control: opening Details for a focused file DOES fetch per-file metadata
  const { root } = { root: q<HTMLElement>(win.document, ".freva-db")! };
  q<HTMLElement>(root, "#fdb-results .row")?.click(); // focus a file
  q<HTMLButtonElement>(root, '[aria-label="Details panel"]')!.click(); // open details
  await wait(30);
  assert.ok(
    fetchCalls.some((c) => /[?&]file=/.test(c.url)),
    "Details lazily fetches per-file metadata",
  );
  handle.destroy();
});

test("Export locked (greyed + inert) past the 100k ceiling, clickable under it", async () => {
  const { handle, root } = await mount(defaultRouter({ total: 200000 }));
  const exportBtn = q<HTMLButtonElement>(root, '[aria-label^="Export catalogue"]');
  assert.ok(exportBtn);
  assert.equal(exportBtn!.getAttribute("aria-disabled"), "true", "export gated above the ceiling");
  assert.ok(exportBtn!.classList.contains("is-disabled"), "export button is greyed/locked");
  const before = fetchCalls.length;
  exportBtn!.click();
  await tick();
  assert.equal(qa(root, ".export-pop").length, 0, "no export menu opens when gated");
  assert.equal(fetchCalls.length, before, "no catalogue request issued");
  assert.match(q<HTMLElement>(root, ".status .mono")!.textContent ?? "", /more than/i);
  handle.destroy();

  // positive control: at/under the ceiling the button is not locked
  const { handle: h2, root: r2 } = await mount(defaultRouter({ total: 100000 }));
  const btn2 = q<HTMLButtonElement>(r2, '[aria-label^="Export catalogue"]')!;
  assert.equal(
    btn2.getAttribute("aria-disabled"),
    "false",
    "exactly at the ceiling is still allowed",
  );
  assert.ok(!btn2.classList.contains("is-disabled"), "not greyed at/under the ceiling");
  h2.destroy();
});

test('Export surfaces the exact 413 "Result stream too big."', async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("-catalogue/"))
      return { status: 413, body: { detail: "Result stream too big." } };
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 5, rows: [{ file: "/a.nc" }] }) };
    return { body: {} };
  };
  // a bearer token forces the FETCH path (a plain <a download> can't carry an Authorization
  // header) - that's the only path where JS sees the response, so errors/object URLs live here.
  const { handle, root } = await mount(router, { authEnabled: true, getAuthToken: () => "tok" });
  q<HTMLButtonElement>(root, '[aria-label^="Export catalogue"]')!.click();
  await tick();
  const intake = byText<HTMLButtonElement>(root, ".xm-item", "Intake catalogue");
  assert.ok(intake, "intake option present");
  intake!.click();
  await wait(20);
  assert.match(q<HTMLElement>(root, ".status .mono")!.textContent ?? "", /too big/i);
  handle.destroy();
});

test("Terminal fallback: plain textarea still parses and copies", async () => {
  const { handle, root } = await mount(defaultRouter());
  root.dataset.terminalFallback = "true";
  q<HTMLButtonElement>(root, '[aria-label="Command terminal"]')!.click();
  await tick();
  assert.ok(q(root, ".cmd.fallback"), "fallback class applied");

  const input = q<HTMLTextAreaElement>(root, ".te-input")!;
  // the token under the caret is never committed - the trailing space completes it.
  input.value = "project=cmip6 variable=tas ";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(20);
  const st = handle.getState();
  assert.deepEqual(
    st.selected,
    { project: ["cmip6"], variable: ["tas"] },
    "textarea parsed into selection",
  );

  q<HTMLButtonElement>(root, ".copy-btn")!.click();
  await tick();
  assert.equal(clipboardWrites.length, 1, "copy wrote once");
  assert.match(clipboardWrites[0], /freva-client databrowser data-search/);
  assert.match(clipboardWrites[0], /project=cmip6/);
  handle.destroy();
});

test("Esc: an open popover does not silence the host page's own Escape listeners", async () => {
  const { handle, root } = await mount(defaultRouter());
  let hostSaw = 0;
  const hostListener = (): void => {
    hostSaw++;
  };
  win.document.addEventListener("keydown", hostListener); // registered AFTER the popover's listener
  try {
    q<HTMLButtonElement>(root, ".lens")!.click();
    await tick();
    assert.ok(q<HTMLElement>(root, ".lens-pop"), "popover open");
    win.document.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await tick();
    assert.ok(!q<HTMLElement>(root, ".lens-pop"), "popover closed on Escape");
    assert.equal(
      hostSaw,
      1,
      "the host page still received the Escape - not silenced by the popover",
    );
  } finally {
    win.document.removeEventListener("keydown", hostListener);
    handle.destroy();
  }
});

test("Esc closes the open popover but NOT the Help panel underneath it", async () => {
  const { handle, root } = await mount(defaultRouter());
  const help = q<HTMLElement>(root, ".help-pop")!;
  help.classList.add("show"); // Help is open
  q<HTMLButtonElement>(root, ".lens")!.click();
  await tick();
  assert.ok(q<HTMLElement>(root, ".lens-pop"), "the lens popover is open on top of Help");
  win.document.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await tick();
  assert.ok(!q<HTMLElement>(root, ".lens-pop"), "Escape closed the popover");
  assert.ok(help.classList.contains("show"), "Help stayed open - one Escape does not close both");
  handle.destroy();
});

test("bbox editor: stays open (re-anchored) after applying a box re-renders the sidebar", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/flavours")) return { body: {} };
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({
          total: 2,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["waterpark", 2] },
          primary: ["project"],
        }),
      };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '.special[aria-label="Edit bounding box"]')!.click();
  await tick();
  assert.ok(q(root, ".pop.editor-pop"), "bbox editor popover opened");

  // apply a valid box from inside the popover - mirrors a completed draw (syncFields -> change -> applyLive)
  const pop = q<HTMLElement>(root, ".pop.editor-pop")!;
  const vals: Record<string, string> = { minLon: "-10", maxLon: "20", minLat: "0", maxLat: "30" };
  for (const label of Object.keys(vals)) {
    const inp = q<HTMLInputElement>(pop, `input[aria-label="${label}"]`)!;
    inp.value = vals[label];
    inp.dispatchEvent(new win.Event("input", { bubbles: true }));
  }
  q<HTMLInputElement>(pop, 'input[aria-label="maxLat"]')!.dispatchEvent(
    new win.Event("change", { bubbles: true }),
  );
  await wait(450); // debounced search settles -> sidebar re-renders -> detach-check microtask runs

  assert.ok(q(root, ".pop.editor-pop"), "the editor is STILL open, re-anchored to the rebuilt row");
  handle.destroy();
});

test("css hygiene: the details panel uses .details-panel, not the generic .info that status/toasts also carry", async () => {
  const { handle, root } = await mount(defaultRouter());
  assert.ok(
    q(root, "aside.details-panel"),
    "details panel uses the namespaced .details-panel class",
  );
  assert.ok(
    !q(root, "aside.info"),
    "no bare .info panel that would inherit status-severity styling (or vice-versa)",
  );
  handle.destroy();
});

test("theme: features.themeToggle:false hides the toggle so a host can own the control", async () => {
  const shown = await mount(defaultRouter());
  assert.ok(q(shown.root, ".theme"), "toggle shown by default");
  shown.handle.destroy();
  const hidden = await mount(defaultRouter(), { features: { themeToggle: false } });
  assert.ok(!q(hidden.root, ".theme"), "toggle hidden when the host opts out");
  hidden.handle.destroy();
});

test("theme: a host can set the initial mode and drive it via handle.setTheme + onModeChange", async () => {
  const seen: string[] = [];
  const { handle, root } = await mount(defaultRouter(), {
    theme: { mode: "day", onModeChange: (m) => seen.push(m) },
  });
  assert.equal(
    root.getAttribute("data-theme"),
    "day",
    "the widget opened in the host-supplied mode",
  );
  handle.setTheme("night");
  await tick();
  assert.equal(root.getAttribute("data-theme"), "night", "handle.setTheme flipped the mode");
  assert.deepEqual(seen, ["night"], "onModeChange fired with the new mode");
  handle.destroy();
});

test('sidebar: a truncated (hasMore) facet drops the "more values" hint; values scroll like the overview', async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/flavours")) return { body: {} };
    // "variable" is a KNOWN_LARGE facet -> hasMore is true even with only a few sampled values
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({
          total: 3,
          rows: [{ file: "/a.nc" }],
          facets: { variable: ["tas", 3, "pr", 2, "psl", 1] },
          primary: ["variable"],
        }),
      };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  openFacet(root, "variable");
  const body = q<HTMLElement>(root, '.facet[data-key="variable"] .facet-body')!;
  assert.ok(!/more values/i.test(body.textContent ?? ""), 'no "more values" hint');
  assert.ok(q(root, '.facet[data-key="variable"] .fval'), "values still render and scroll");
  handle.destroy();
});

test("grid view: cards show the full path (directory), matching the list view", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/flavours")) return { body: {} };
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/reanalysis/healpix/oras5/level_4.zarr" }],
        }),
      };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '[aria-label="Grid view"]')!.click();
  await tick();
  const card = q<HTMLElement>(root, ".gcard");
  assert.ok(card, "grid card present");
  // ONE complete path per card - not a basename plus a separate directory line.
  assert.equal(
    qa(card!, ".name, .dir").length,
    0,
    "the split basename/directory presentation is gone",
  );
  const path = q<HTMLElement>(card!, ".path");
  assert.ok(path, "grid card shows a path node");
  const card0 = q<HTMLElement>(root, ".gcard")!;
  const whole = card0.dataset.file ?? "";
  assert.ok(whole, "the card records the file it is for");
  assert.equal(path!.textContent, whole, "the card shows the COMPLETE path as one value");
  assert.match(whole, /reanalysis\/healpix\/oras5/, "…directory and all");
  // `title` is routed to the styled tooltip, and the accessible name carries the clipped value.
  assert.equal(path!.getAttribute("data-tip"), whole);
  assert.equal(path!.getAttribute("aria-label"), whole);
  handle.destroy();
});

test("overview: known facet blocks stay (rendered empty) when a later query matches nothing", async () => {
  let empty = false;
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/flavours")) return { body: {} };
    if (call.url.includes("/extended-search/")) {
      return empty
        ? { body: searchResponse({ total: 0, rows: [], facets: {}, primary: [] }) }
        : {
            body: searchResponse({
              total: 5,
              rows: [{ file: "/a.nc" }],
              facets: { project: ["waterpark", 5], model: ["x", 3] },
              primary: ["project", "model"],
            }),
          };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')!.click();
  await tick();
  assert.ok(q(root, '.fcard[data-key="project"]'), "project block present with data");

  empty = true; // subsequent queries match nothing
  q<HTMLButtonElement>(root, '.fcard[data-key="project"] .fval')!.click(); // triggers a re-search -> empty
  await wait(400);
  assert.ok(
    q(root, '.fcard[data-key="project"]'),
    "project block STILL present after a no-match query",
  );
  assert.ok(q(root, '.fcard[data-key="model"]'), "model block also kept");
  assert.ok(
    q(root, '.fcard[data-key="project"] .fcard-empty'),
    "kept block shows an honest zero-state",
  );
  handle.destroy();
});

test("performance: the Overview tree is NOT built while Results view hides it, only on demand (perf)", async () => {
  const facets: Record<string, (string | number)[]> = {};
  for (let i = 0; i < 8; i++) facets[`f${i}`] = ["a", 1, "b", 1, "c", 1];
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({
          total: 3,
          rows: [{ file: "/a.nc" }],
          facets,
          primary: Object.keys(facets),
        }),
      };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  assert.equal(handle.getState().layout, "results", "default layout is results");
  assert.equal(
    qa<HTMLElement>(root, ".facet-grid .fcard").length,
    0,
    "no overview cards built while hidden",
  );
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')!.click();
  await tick();
  assert.ok(
    qa<HTMLElement>(root, ".facet-grid .fcard").length > 0,
    "cards built on demand when Overview is shown",
  );
  handle.destroy();
});

test("custom flavour: a URL flavour unknown at mount is applied once /overview lists it", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva", "custom"], {}) };
    if (call.url.includes("/flavours")) return { body: {} };
    if (call.url.includes("/extended-search/custom/"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { programme: ["x", 1] },
          primary: ["programme"],
        }),
      };
    return { body: searchResponse({ total: 0, rows: [] }) };
  };
  installFetch(router);
  win.history.replaceState(null, "", "/?flavour=custom&programme=x"); // custom isn't a builtin
  const host = makeHost();
  const handle = mountDataBrowser(host, { syncUrl: true });
  await wait(450); // /overview applies the pending flavour, then a debounced (250ms) search runs
  assert.equal(
    handle.getState().flavour,
    "custom",
    "the pending custom flavour was applied once /overview listed it",
  );
  const call = [...fetchCalls]
    .reverse()
    .find((c) => c.url.includes("/extended-search/custom/file?"));
  assert.ok(call, "a search ran under the custom flavour");
  assert.match(call!.url, /programme=x/, "the deep-linked facet applied under the custom flavour");
  handle.destroy();
});

test("custom flavour: baseFilters re-translate when the custom map arrives late", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva", "custom"], {}) };
    if (call.url.includes("/flavours"))
      return {
        body: { flavours: [{ flavour_name: "custom", mapping: { project: "programme" } }] },
      };
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }], facets: {}, primary: [] }),
      };
    return { body: {} };
  };
  // flavour set via CONFIG (state.flavour is 'custom' from mount) so ONLY the late map can correct the
  // base-filter translation - isolating the map-change re-query.
  const { handle } = await mount(router, {
    flavour: "custom",
    baseFilters: { project: "waterpark" },
  });
  await wait(450); // custom map arrives via /flavours, then the held first search fires with the right key
  const call = [...fetchCalls]
    .reverse()
    .find(
      (c) => c.url.includes("/extended-search/custom/file?") && /programme=waterpark/.test(c.url),
    );
  assert.ok(call, "the base filter used the custom key (programme=waterpark) once the map loaded");
  // fail-closed: the mis-keyed gate must NEVER have been sent, not even once before the map arrived
  const misKeyed = [...fetchCalls].some(
    (c) => c.url.includes("/extended-search/custom/file?") && /project=waterpark/.test(c.url),
  );
  assert.ok(!misKeyed, "no request ever carried the mis-keyed gate (project=waterpark)");
  handle.destroy();
});

test("custom flavour: a scoped instance fails CLOSED when the flavour map never loads", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva", "custom"], {}) };
    if (call.url.includes("/flavours")) return { status: 500, body: { detail: "nope" } }; // map discovery fails
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }] }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router, {
    flavour: "custom",
    baseFilters: { project: "waterpark" },
  });
  await wait(450);
  // no search may have been issued at all for the scoped custom flavour without a known map
  const anySearch = [...fetchCalls].some((c) => c.url.includes("/extended-search/custom/file?"));
  assert.ok(!anySearch, "no mis-scoped search was issued when the map is unavailable");
  assert.equal(
    handle.getState().search,
    "error",
    "the widget is in a visible error state (fail closed)",
  );
  void root;
  handle.destroy();
});

test("URL flavour: a known builtin from the link is reflected in the header dropdown label", async () => {
  installFetch(defaultRouter());
  win.history.replaceState(null, "", "/?flavour=cmip6"); // AFTER installFetch (which resets the URL)
  const host = makeHost();
  const handle = mountDataBrowser(host, { syncUrl: true });
  await wait(60);
  const root = q<HTMLElement>(host, ".freva-db");
  assert.equal(
    q(root!, ".lens .v")?.textContent,
    "cmip6",
    "the lens dropdown shows the URL flavour, not the default freva",
  );
  win.history.replaceState(null, "", "/");
  handle.destroy();
});

test("perf: a builtin flavour whose server /flavours map is functionally identical does NOT fire a second (canceled) search", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    // The server returns freva with an EXPLICIT map (different shape/order from the baked identity) but
    // the same translation for the keys in play - the raw map stringifies differently, yet the wire
    // query is unchanged, so it must NOT trigger a wasted re-query that cancels the first search.
    if (call.url.includes("/flavours"))
      return {
        body: {
          flavours: [
            { flavour_name: "freva", mapping: { project: "project", variable: "variable" } },
          ],
        },
      };
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }], facets: {}, primary: [] }),
      };
    return { body: {} };
  };
  const { handle } = await mount(router, { baseFilters: { project: "waterpark" } });
  await wait(500);
  const searches = [...fetchCalls].filter((c) => c.url.includes("/extended-search/freva/file?"));
  assert.equal(
    searches.length,
    1,
    "exactly one search fired - the server map did not spuriously re-query",
  );
  handle.destroy();
});

test("custom flavour via URL transition: the switch HOLDS until the map arrives - no mis-keyed scoped request", async () => {
  // Mounts as a BUILTIN (freva) so the bootstrap fail-closed guard does NOT apply; the custom flavour
  // arrives via the URL (pendingUrlFlavour) and is applied only once /overview lists it - the exact
  // transition path that bypasses the one-shot bootstrap check.
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva", "custom"], {}) };
    if (call.url.includes("/flavours"))
      return {
        body: { flavours: [{ flavour_name: "custom", mapping: { project: "programme" } }] },
        delayMs: 350,
      };
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }], facets: {}, primary: [] }),
      };
    return { body: {} };
  };
  installFetch(router);
  win.history.replaceState(null, "", "/?flavour=custom");
  const host = makeHost();
  const handle = mountDataBrowser(host, { syncUrl: true, baseFilters: { project: "waterpark" } });
  await wait(700); // /flavours resolves at 350ms (past the 250ms search debounce) - the real race window
  const misKeyed = [...fetchCalls].some(
    (c) => c.url.includes("/extended-search/custom/file?") && /project=waterpark/.test(c.url),
  );
  assert.ok(!misKeyed, "no /custom search ever carried the freva-keyed gate (project=waterpark)");
  const keyed = [...fetchCalls].some(
    (c) => c.url.includes("/extended-search/custom/file?") && /programme=waterpark/.test(c.url),
  );
  assert.ok(
    keyed,
    "the custom-keyed scoped search fired once the map arrived (programme=waterpark)",
  );
  handle.destroy();
});

test("overviewShape: a lens switch clears the remembered shape - no stale-flavour blocks", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva", "cmip6"], {}) };
    if (call.url.includes("/flavours")) return { body: {} };
    if (call.url.includes("/extended-search/cmip6/"))
      return { body: searchResponse({ total: 0, rows: [], facets: {}, primary: [] }) };
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({
          total: 3,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["x", 3], model: ["y", 2] },
          primary: ["project", "model"],
        }),
      };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
  await tick();
  assert.ok(q(root, '.fcard[data-key="project"]'), "freva blocks present with data");

  const lens = q<HTMLButtonElement>(root, ".lens")!;
  lens.click();
  await tick();
  const cmip6 = qa<HTMLButtonElement>(root, ".lens-pop .pop-item").find((b) =>
    /cmip6/.test(b.textContent ?? ""),
  )!;
  cmip6.click();
  await wait(400); // re-query under cmip6 -> no match

  assert.ok(
    !q(root, '.fcard[data-key="project"]'),
    'the old freva "project" block did not linger under cmip6',
  );
  assert.ok(!q(root, '.fcard[data-key="model"]'), 'nor the old "model" block');
  handle.destroy();
});

test("deep-link: both /overview AND first search failing still releases a stuck host param (fallback vocab)", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { status: 500, body: {} };
    if (call.url.includes("/flavours")) return { body: {} };
    if (call.url.includes("/extended-search/")) {
      if (/junk=/.test(call.url)) return { status: 422, body: { detail: "unknown facet junk" } };
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
  installFetch(router);
  win.history.replaceState(null, "", "/?junk=host-param&project=cmip6");
  const host = makeHost();
  const handle = mountDataBrowser(host, { syncUrl: true });
  await wait(500);
  assert.ok(
    !("junk" in handle.getState().selected),
    "the host param was released even though both endpoints failed",
  );
  assert.deepEqual(
    handle.getState().selected.project,
    ["cmip6"],
    "the real freva facet key survived (it is in the fallback vocab)",
  );
  const clean = [...fetchCalls].some(
    (c) =>
      c.url.includes("/extended-search/freva/file?") &&
      !/junk=/.test(c.url) &&
      /project=cmip6/.test(c.url),
  );
  assert.ok(clean, "a clean retry without the junk param was issued");
  handle.destroy();
});

test("deep-link: a first-request failure on a junk URL facet self-heals (drops it and retries)", async () => {
  let sawJunkRequest = false;
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { freva: ["project"] }) };
    if (call.url.includes("/flavours")) return { body: {} };
    if (call.url.includes("/extended-search/")) {
      if (/[?&]page=7/.test(call.url)) {
        sawJunkRequest = true;
        return { status: 422, body: { detail: "unknown facet page" } };
      }
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
  installFetch(router);
  win.history.replaceState(null, "", "/?page=7&project=cmip6");
  const host = makeHost();
  const handle = mountDataBrowser(host, { syncUrl: true });
  await wait(400); // first (maybe-junk) search + reconcile + debounced clean retry (250ms)

  assert.ok(!("page" in handle.getState().selected), "the junk facet was dropped");
  assert.deepEqual(handle.getState().selected.project, ["cmip6"], "the real facet survived");
  assert.notEqual(
    handle.getState().search,
    "error",
    "the browser did not get stuck in the error state",
  );
  const ok = [...fetchCalls].some(
    (c) =>
      c.url.includes("/extended-search/freva/file?") &&
      /project=cmip6/.test(c.url) &&
      !/page=7/.test(c.url),
  );
  assert.ok(ok, "a clean retry without the junk facet was issued");
  void sawJunkRequest;
  handle.destroy();
});

test("baseFilters: a same-key URL selection cannot widen the gate - inescapable", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva", "cmip6"], {}) };
    if (call.url.includes("/flavours")) return { body: {} };
    if (call.url.includes("/extended-search/cmip6/"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { mip_era: ["waterpark", 1] },
          primary: ["mip_era"],
        }),
      };
    return { body: {} };
  };
  installFetch(router);
  win.history.replaceState(null, "", "/?flavour=cmip6&mip_era=other"); // attacker widens via the URL, in the lens where project->mip_era
  const host = makeHost();
  const handle = mountDataBrowser(host, { baseFilters: { project: "waterpark" }, syncUrl: true });
  await wait(60);
  const wire = [...fetchCalls]
    .reverse()
    .find((c) => c.url.includes("/extended-search/cmip6/file?"))!;
  assert.match(wire.url, /mip_era=waterpark/, "the gate is applied under the URL flavour");
  assert.ok(!/mip_era=other/.test(wire.url), "the same-key URL value did NOT widen the gate");
  assert.ok(
    !("mip_era" in handle.getState().selected),
    "the gated key was not imported as a removable facet",
  );
  handle.destroy();
});

test("baseFilters: the gate is fail-closed - an out-of-scope value in the gated facet is inert everywhere", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/flavours")) return { body: {} };
    // the gated facet ALSO offers a value outside the scope
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({
          total: 5,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["waterpark", 5, "other", 9] },
          primary: ["project"],
        }),
      };
    return { body: {} };
  };
  const { handle, root } = await mount(router, {
    baseFilters: { project: "waterpark" },
    syncUrl: true,
  });
  await tick();
  const search = () =>
    [...fetchCalls].reverse().find((c) => c.url.includes("/extended-search/freva/file?"))!;

  openFacet(root, "project");
  // sidebar: the gated facet shows ONLY its scope value; "other" is never rendered
  assert.ok(
    byText<HTMLButtonElement>(root, ".side-scroll .fval", "waterpark"),
    "the scope value is shown",
  );
  assert.ok(
    !byText<HTMLButtonElement>(root, ".side-scroll .fval", "other"),
    '"other" is not rendered in the gated facet',
  );
  const scopeVal = byText<HTMLButtonElement>(root, ".side-scroll .fval", "waterpark")!;
  assert.equal(
    scopeVal.getAttribute("aria-disabled"),
    "true",
    "the scope value is locked (non-toggleable)",
  );
  scopeVal.click(); // clicking the locked scope is inert
  await wait(320);
  assert.ok(!("project" in handle.getState().selected), "a gated key never enters state.selected");
  assert.ok(!q(root, '.chip[aria-label*="other"]'), "no chip for any out-of-scope value");
  assert.ok(
    !/project=other/.test(search().url),
    "the wire query never carries an out-of-scope value",
  );
  assert.match(search().url, /project=waterpark/, "only the scope value is sent");

  // overview: same - "other" is not rendered in the gated card
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')!.click();
  await tick();
  assert.ok(
    !byText<HTMLButtonElement>(root, ".facet-grid .fval", "other"),
    '"other" absent in the overview gated card',
  );
  handle.destroy();
});

test("baseFilters: an invisible, always-applied scope - the hosted-filtered-instance gate", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/flavours")) return { body: {} };
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({
          total: 5,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["waterpark", 5], variable: ["tas", 3, "pr", 2] },
          primary: ["project", "variable"],
        }),
      };
    return { body: {} };
  };
  const { handle, root } = await mount(router, {
    baseFilters: { project: "waterpark" },
    syncUrl: true,
  });
  await tick();

  const search = () =>
    [...fetchCalls].reverse().find((c) => c.url.includes("/extended-search/freva/file?"))!;
  assert.match(search().url, /project=waterpark/, "the base scope is applied to the wire query");
  assert.ok(
    !("project" in handle.getState().selected),
    "the gate is NOT part of the removable selection",
  );
  assert.equal(
    q(root, '.chip[aria-label*="waterpark"]'),
    null,
    "no removable chip is shown for the gate",
  );
  assert.ok(q(root, '.facet[data-key="project"]'), "the gated facet box stays visible");
  openFacet(root, "project");
  assert.ok(
    q(root, '.facet[data-key="project"] .fval.locked'),
    "its value renders as a locked scope, not a removable chip",
  );
  assert.ok(!/project=/.test(win.location.search), "the gate is not written to the shareable URL");

  // a user filter within the scope layers ON TOP of the gate
  openFacet(root, "variable");
  byText<HTMLElement>(root, ".side-scroll .fval", "tas")!.click();
  await wait(320);
  assert.match(search().url, /project=waterpark/, "gate still applied alongside the user filter");
  assert.match(search().url, /variable=tas/, "user filter is layered on top of the gate");

  // Clear all wipes the user filter but NOT the gate
  const clear = byText<HTMLButtonElement>(root, "button", "Clear all");
  if (clear) {
    clear.click();
    await wait(320);
  }
  assert.match(search().url, /project=waterpark/, "Clear all does not remove the gate");
  assert.ok(!/variable=tas/.test(search().url), "Clear all removed the user filter");
  handle.destroy();
});

test("baseFilters: a URL param that matches the gate is not also imported as a removable facet", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/flavours")) return { body: {} };
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["waterpark", 1] },
          primary: ["project"],
        }),
      };
    return { body: {} };
  };
  installFetch(router);
  win.history.replaceState(null, "", "/?project=waterpark"); // the address-bar gate
  const host = makeHost();
  const handle = mountDataBrowser(host, { baseFilters: { project: "waterpark" }, syncUrl: true });
  await wait(40);
  assert.ok(
    !("project" in handle.getState().selected),
    "the URL gate key did not become a removable facet",
  );
  const wire = [...fetchCalls]
    .reverse()
    .find((c) => c.url.includes("/extended-search/freva/file?"))!;
  assert.match(wire.url, /project=waterpark/, "the scope is still applied to the query");
  handle.destroy();
});

test("deep-link: reserved/host params are not facets; bad flavour ignored; foreign params survive Clear all", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva", "cmip6"], {}) };
    if (call.url.includes("/flavours")) return { body: {} };
    if (call.url.includes("/extended-search/"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["cmip6", 1] },
          primary: ["project"],
        }),
      };
    return { body: {} };
  };
  installFetch(router); // resets URL
  win.history.replaceState(
    null,
    "",
    "/?page=7&utm_source=news&max-results=-1&translate=false&flavour=evil&project=cmip6",
  );
  const host = makeHost();
  const handle = mountDataBrowser(host, { syncUrl: true });
  await wait(80); // first search + reconcile + re-search

  const sel = handle.getState().selected;
  assert.ok(
    !("max-results" in sel) && !("translate" in sel),
    "reserved transport keys never became facets",
  );
  assert.equal(
    handle.getState().flavour,
    "freva",
    "an unknown flavour is ignored; the request path stays freva",
  );
  assert.deepEqual(sel.project, ["cmip6"], "the genuine facet was imported");
  assert.ok(
    !("page" in sel) && !("utm_source" in sel),
    "host/tracking params were released, not kept as facets",
  );

  const wire = [...fetchCalls]
    .reverse()
    .find((c) => c.url.includes("/extended-search/freva/file?"))!;
  assert.ok(
    !/max-results=-1/.test(wire.url) && !/translate=false/.test(wire.url),
    "reserved values were never forwarded to the API",
  );

  const root = q<HTMLElement>(host, ".freva-db")!;
  const clear = byText<HTMLButtonElement>(root, "button", "Clear all");
  if (clear) {
    clear.click();
    await wait(30);
  }
  assert.match(win.location.search, /page=7/, "a foreign host param survives Clear all");
  assert.match(
    win.location.search,
    /utm_source=news/,
    "a foreign tracking param survives Clear all",
  );
  assert.ok(
    !/project=/.test(win.location.search),
    "the widget-owned facet was cleared from the URL",
  );
  handle.destroy();
});

test("deep-link: the URL is the source of truth on load and updates on change", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva", "cmip6"], { cmip6: ["mip_era"] }) };
    if (call.url.includes("/flavours")) return { body: { flavours: [] } };
    if (call.url.includes("/extended-search/cmip6/"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { mip_era: ["waterpark", 1] },
          primary: ["mip_era"],
        }),
      };
    return { body: {} };
  };
  installFetch(router); // resets URL to '/'
  win.history.replaceState(null, "", "/?flavour=cmip6&mip_era=waterpark"); // set the deep link AFTER the reset
  const host = makeHost();
  const handle = mountDataBrowser(host, { syncUrl: true });
  await wait(40);
  assert.equal(handle.getState().flavour, "cmip6", "flavour restored from the URL");
  assert.deepEqual(
    handle.getState().selected,
    { mip_era: ["waterpark"] },
    "selection restored from the URL",
  );
  const call = [...fetchCalls].find(
    (c) => c.url.includes("/extended-search/cmip6/") && /mip_era=waterpark/.test(c.url),
  );
  assert.ok(call, "the first search used the URL-declared flavour + facet");

  const root = q<HTMLElement>(host, ".freva-db")!;
  const clear = byText<HTMLButtonElement>(root, "button", "Clear all");
  if (clear) {
    clear.click();
    await wait(30);
  }
  assert.ok(!/mip_era=waterpark/.test(win.location.search), "the facet left the URL when cleared");
  handle.destroy();
});

test("Flavour switch re-keys from BUILTIN maps even before /flavours loads (race)", async () => {
  // router deliberately does NOT answer /flavours -> only the baked-in builtin maps are available
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva", "cmip6"], {}) };
    if (call.url.includes("/flavours")) return { body: {} }; // no maps from the server
    if (call.url.includes("/extended-search/freva/"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["waterpark", 1] },
          primary: ["project"],
        }),
      };
    if (call.url.includes("/extended-search/cmip6/"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { mip_era: ["waterpark", 1] },
          primary: ["mip_era"],
        }),
      };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  openFacet(root, "project");
  byText<HTMLElement>(root, ".side-scroll .fval", "waterpark")!.click();
  await wait(320);
  q<HTMLButtonElement>(root, ".lens")!.click();
  await tick();
  byText<HTMLButtonElement>(root, ".lens-pop .pop-item", "cmip6")!.click();
  await wait(320);
  assert.deepEqual(
    handle.getState().selected,
    { mip_era: ["waterpark"] },
    "re-keyed project->mip_era from the builtin fallback",
  );
  const call = [...fetchCalls]
    .reverse()
    .find((c) => c.url.includes("/extended-search/cmip6/file?"));
  assert.match(
    call!.url,
    /mip_era=waterpark/,
    "wire query uses cmip6 key without needing /flavours",
  );
  handle.destroy();
});

test("Flavour switch: the active selection re-keys to the new flavour (project=cmip6 -> mip_era=cmip6)", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return {
        body: overviewResponse(["freva", "cmip6"], { freva: ["project"], cmip6: ["mip_era"] }),
      };
    if (call.url.includes("/flavours"))
      return {
        body: {
          flavours: [
            { flavour_name: "freva", mapping: { project: "project", model: "model" } },
            { flavour_name: "cmip6", mapping: { project: "mip_era", model: "source_id" } },
          ],
        },
      };
    if (call.url.includes("/extended-search/freva/"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["cmip6", 1] },
          primary: ["project"],
        }),
      };
    if (call.url.includes("/extended-search/cmip6/"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { mip_era: ["cmip6", 1] },
          primary: ["mip_era"],
        }),
      };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  await wait(30); // let /flavours settle so the maps are loaded
  openFacet(root, "project");
  byText<HTMLElement>(root, ".side-scroll .fval", "cmip6")!.click();
  await wait(320);
  assert.deepEqual(
    handle.getState().selected,
    { project: ["cmip6"] },
    "selected under freva by the freva key",
  );

  q<HTMLButtonElement>(root, ".lens")!.click();
  await tick();
  byText<HTMLButtonElement>(root, ".lens-pop .pop-item", "cmip6")!.click();
  await wait(320);

  assert.equal(handle.getState().flavour, "cmip6");
  assert.deepEqual(
    handle.getState().selected,
    { mip_era: ["cmip6"] },
    "selection re-keyed project -> mip_era (value unchanged)",
  );
  const cmip6Call = [...fetchCalls]
    .reverse()
    .find((c) => c.url.includes("/extended-search/cmip6/file?"));
  assert.ok(cmip6Call, "searched under the cmip6 lens");
  assert.match(cmip6Call!.url, /mip_era=cmip6/, "the wire query uses the cmip6 key");
  assert.ok(!/project=cmip6/.test(cmip6Call!.url), "the freva key is gone from the query");
  handle.destroy();
});

test("Pagination: Load next 100 sends start=rows.length and appends", async () => {
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
  assert.equal(handle.getState().rows.length, 100, "first page");
  const next = q<HTMLButtonElement>(root, ".load-next");
  assert.ok(next, "load-next affordance shown when total > shown");
  next!.click();
  await wait(20);
  assert.ok(
    fetchCalls.some((c) => /[?&]start=100\b/.test(c.url)),
    "second page requested start=100",
  );
  assert.equal(handle.getState().rows.length, 150, "rows appended");
  handle.destroy();
});

test("Concurrency: a superseding search aborts the prior and wins", async () => {
  let n = 0;
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/")) {
      n += 1;
      // bootstrap (n=1) fast; first user search slow; second user search fast
      const hasProject = /[?&]project=/.test(call.url);
      const hasModel = /[?&]model=/.test(call.url);
      const total = hasModel ? 222 : hasProject ? 111 : 1;
      const delayMs = hasProject && !hasModel ? 120 : 10; // the project-only search is the slow one
      // the search bar enforces the known-key guard: the backend must advertise the keys
      return {
        body: searchResponse({
          total,
          rows: [{ file: "/x.nc" }],
          facets: { project: ["a", 1], model: ["b", 1] },
        }),
        delayMs,
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  void n;

  // first user search: project only (slow) - pick the value 'a' from the value-first dropdown
  pickValue(root, "a");
  await wait(270); // debounce elapses, slow search starts

  // superseding search: project + model (fast) before the slow one resolves
  pickValue(root, "b");
  await wait(300); // debounce + fast resolve + slow would-be resolve

  const st = handle.getState();
  assert.deepEqual(st.selected, { project: ["a"], model: ["b"] }, "both filters applied");
  assert.equal(st.totalCount, 222, "the superseding (fast) response won - no stale overwrite");
  assert.ok(
    abortedUrls.some((u) => /project=a/.test(u) && !/model=b/.test(u)),
    "the prior project-only request was aborted",
  );
  handle.destroy();
});

test("destroy(): removes the root and aborts the in-flight request", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], {}), delayMs: 5 };
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }] }), delayMs: 200 };
    return { body: {} };
  };
  installFetch(router);
  const host = makeHost();
  const handle = mountDataBrowser(host, {});
  await wait(30); // overview done; the first search is in flight (200ms)
  assert.ok(q(host, ".freva-db"), "mounted");
  handle.destroy();
  await wait(20);
  assert.equal(q(host, ".freva-db"), null, "root removed on destroy");
  assert.ok(
    abortedUrls.some((u) => u.includes("/extended-search/")),
    "in-flight search aborted",
  );
  // a second destroy is safe
  assert.doesNotThrow(() => handle.destroy());
});

test("selection is capped at 25; the 26th is refused without changing state", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ file: `/f_${i}.nc` }));
  const { handle, root } = await mount(defaultRouter({ total: 30, rows }), {
    authEnabled: true,
    enableHeavyOps: true,
  });
  const cbs = (): HTMLElement[] => qa<HTMLElement>(root, "#fdb-results .cb");
  // 24 -> under the cap, nothing is disabled yet
  for (let i = 0; i < 24; i++) {
    cbs()[i].click();
    await tick();
  }
  assert.equal(handle.getState().pickedKeys.size, 24, "24 selected");
  assert.equal(
    qa<HTMLElement>(root, '#fdb-results .cb[aria-disabled="true"]').length,
    0,
    "under the cap nothing is marked disabled",
  );
  // 25 -> exactly at the cap
  cbs()[24].click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 25, "25 selected - exactly the cap");
  // 26 -> refused. The state does not change at all, and the reason is announced.
  cbs()[25].click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 25, "the 26th selection changes nothing");
  assert.ok(
    !handle.getState().pickedKeys.has("/f_25.nc"),
    "the refused file was not selected, and nothing was swapped out for it",
  );
  const disabled = qa<HTMLElement>(root, '#fdb-results .cb[aria-disabled="true"]');
  assert.ok(disabled.length > 0, "at the cap, UNSELECTED checkboxes expose aria-disabled");
  assert.match(
    disabled[0].getAttribute("aria-label") ?? "",
    /selection limit/i,
    "…with a reason, not a bare disabled state",
  );
  // A SELECTED file stays fully enabled - a selection you cannot undo would be a trap.
  const picked = qa<HTMLElement>(root, "#fdb-results .row.picked .cb")[0];
  assert.equal(picked.getAttribute("aria-disabled"), "false", "selected rows stay deselectable");
  picked.click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 24, "deselecting still works at the cap");
  handle.destroy();
});

test("the pickbar shows N / 25 and Aggregate keeps its own lower 10-file cap", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ file: `/f_${i}.nc` }));
  const { handle, root } = await mount(defaultRouter({ total: 30, rows }), {
    authEnabled: true,
    enableHeavyOps: true,
  });
  for (let i = 0; i < 11; i++) {
    qa<HTMLElement>(root, "#fdb-results .cb")[i].click();
    await tick();
  }
  const bar = q<HTMLElement>(root, ".pickbar") as HTMLElement;
  const find = (t: string): HTMLButtonElement | undefined =>
    qa<HTMLButtonElement>(bar, ".btn").find((b) => (b.textContent ?? "").includes(t));
  assert.match(q<HTMLElement>(bar, ".cnt")?.textContent ?? "", /11 \/ 25 selected/);
  assert.equal(find("Aggregate")!.getAttribute("disabled"), "true", "Aggregate locks over ITS cap");
  assert.ok(!find("Details")!.getAttribute("disabled"), "Details stays available past that cap");
  assert.ok(!find("Download")!.getAttribute("disabled"), "Download stays available past that cap");
  assert.match(q<HTMLElement>(bar, ".scope-note")?.textContent ?? "", /max 10/i);
  // deselect one -> back to 10 -> Aggregate unlocks
  qa<HTMLElement>(root, "#fdb-results .cb")[0].click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 10);
  assert.ok(!find("Aggregate")!.getAttribute("disabled"), "Aggregate unlocks at exactly its cap");
  handle.destroy();
});

test('Details: a 2xx response with no facets does not strand the panel in "loading"', async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/file?")) return { body: { search_results: [{ file: "/a.nc" }] } }; // malformed: NO facets
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }] }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '.seg [aria-label="List view"]')?.click();
  await tick();
  q<HTMLElement>(root, "#fdb-results .cb")!.click(); // pick the file
  await tick();
  q<HTMLButtonElement>(root, '[aria-label="Details panel"]')!.click(); // open the panel -> fetch metadata
  await wait(60);
  assert.ok(
    fetchCalls.some((c) => c.url.includes("/file?")),
    "per-file metadata was requested",
  );
  assert.notEqual(
    handle.getState().details,
    "loading",
    "a malformed 2xx did not leave the panel spinning",
  );
  handle.destroy();
});

test("Terminal: a well-formed but unknown facet key is not committed to the query", async () => {
  const { handle, root } = await mount(defaultRouter());
  q<HTMLButtonElement>(root, '[aria-label="Command terminal"]')!.click();
  await tick();
  const input = q<HTMLTextAreaElement>(root, ".te-input")!;
  input.value = "project=cmip6 zzz=1";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(20);
  const sel = handle.getState().selected;
  assert.deepEqual(sel.project, ["cmip6"], "known key committed");
  assert.ok(!("zzz" in sel), "unknown key not committed");
  handle.destroy();
});

test("Load next 100 failure preserves the loaded page - no full error panel", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/")) {
      const m = call.url.match(/[?&]start=(\d+)/);
      if (m && m[1] === "100") return { status: 500, body: { detail: "boom" } };
      return {
        body: searchResponse({
          total: 150,
          rows: Array.from({ length: 100 }, (_, i) => ({ file: `/f_${i}.nc` })),
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  assert.equal(handle.getState().rows.length, 100);
  q<HTMLButtonElement>(root, ".load-next")!.click();
  await wait(20);
  assert.equal(handle.getState().rows.length, 100, "existing rows preserved");
  assert.equal(handle.getState().search, "loaded", "stays loaded, not error");
  assert.equal(qa(root, "#fdb-results .state-msg.err").length, 0, "no full error panel");
  assert.match(q<HTMLElement>(root, ".status .mono")!.textContent ?? "", /could not load more/i);
  handle.destroy();
});

test("No net listener growth across many re-renders", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ file: `/f_${i}.nc` }));
  const { handle, root } = await mount(defaultRouter({ total: 5, rows }));

  const proto = (win as unknown as { EventTarget: { prototype: EventTarget } }).EventTarget
    .prototype as unknown as {
    addEventListener: (...a: unknown[]) => unknown;
    removeEventListener: (...a: unknown[]) => unknown;
  };
  const origAdd = proto.addEventListener;
  const origRem = proto.removeEventListener;
  let adds = 0;
  let removes = 0;
  proto.addEventListener = function (this: EventTarget, ...a: unknown[]): unknown {
    adds++;
    return origAdd.apply(this, a);
  };
  proto.removeEventListener = function (this: EventTarget, ...a: unknown[]): unknown {
    removes++;
    return origRem.apply(this, a);
  };
  try {
    const list = q<HTMLButtonElement>(root, '[aria-label="List view"]')!;
    const grid = q<HTMLButtonElement>(root, '[aria-label="Grid view"]')!;
    grid.click(); // warm up to steady state (one results re-render per click)
    list.click();
    const base = adds - removes;
    for (let i = 0; i < 25; i++) (i % 2 ? list : grid).click();
    const after = adds - removes;
    assert.ok(
      after - base <= 60,
      `net retained listeners grew by ${after - base} across 25 re-renders (leak)`,
    );
  } finally {
    proto.addEventListener = origAdd;
    proto.removeEventListener = origRem;
  }
  handle.destroy();
});

test("Heavy ops gated: Aggregate is disabled without enableHeavyOps and issues no fetch", async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ file: `/f_${i}.nc` }));
  // authEnabled true but enableHeavyOps left at its default (false)
  const { handle, root } = await mount(defaultRouter({ total: 3, rows }), { authEnabled: true });
  // pick a file so the pickbar renders
  qa<HTMLElement>(root, "#fdb-results .cb")[0].click();
  await tick();
  const btns = qa<HTMLButtonElement>(root, ".pickbar .btn");
  assert.equal(btns.length, 3, "three actions: Details / Download / Aggregate");
  const aggregate = btns.find((b) => (b.textContent ?? "").includes("Aggregate"))!;
  assert.equal(
    aggregate.getAttribute("disabled"),
    "true",
    "Aggregate (heavy) disabled without enableHeavyOps",
  );

  const before = fetchCalls.length;
  aggregate.click();
  await wait(20);
  assert.equal(fetchCalls.length, before, "the disabled heavy action issues no network call");
  assert.match(q<HTMLElement>(root, ".pickbar .scope-note")!.textContent ?? "", /data-portal/i);
  handle.destroy();
});

test("Disposables.listen: manual off() de-registers the disposer (no registry growth)", () => {
  const dis = new Disposables();
  const base = dis.size;
  const target = new win.EventTarget();
  const offs: Array<() => void> = [];
  for (let i = 0; i < 100; i++) offs.push(dis.listen(target, "x", () => {}));
  assert.equal(dis.size, base + 100, "each listen adds one disposer");
  for (const off of offs) off();
  assert.equal(dis.size, base, "every manual off() removed its own registry entry");
  // idempotent: calling again is a no-op and does not underflow
  offs[0]();
  assert.equal(dis.size, base);
});

test("Disposables.add: returned handle de-registers without running the fn", () => {
  const dis = new Disposables();
  const base = dis.size;
  let ran = 0;
  const off = dis.add(() => {
    ran++;
  });
  assert.equal(dis.size, base + 1);
  off();
  assert.equal(dis.size, base, "handle removed the entry");
  assert.equal(ran, 0, "de-registering did not run the teardown");
});

test("Disposables.child: flushing a child scope removes it from the parent (no growth over cycles)", () => {
  // This is exactly the inspector open/close mechanism: each open() takes a child scope, close()
  // flushes it, and repeated open/close must not accumulate entries in the parent registry.
  const parent = new Disposables();
  const base = parent.size;
  let liveDialogs = 0;
  for (let i = 0; i < 20; i++) {
    const scope = parent.child(); // "open"
    scope.add(() => {
      liveDialogs--;
    }); // dialog teardown
    liveDialogs++;
    scope.flush(); // "close" - flushes AND detaches from parent
  }
  assert.equal(parent.size, base, "no net disposer growth across 20 open/close cycles");
  assert.equal(liveDialogs, 0, "every dialog was torn down");
  parent.flush();
});

test("a global (0…360) bbox paints across the whole map, not just the eastern half", async () => {
  const { worldSVG, paintRect } = await import("../src/geo.js");
  const svg = worldSVG(290, 150);
  // exactly what the API returns for a global store, after ENVELOPE parsing
  paintRect(
    svg,
    { minLon: -180, maxLon: 180, minLat: -90, maxLat: 90, mode: "flexible" },
    290,
    150,
  );
  const r = svg.querySelector(".selrect") as SVGRectElement;
  assert.equal(r.getAttribute("x"), "0", "starts at the left edge");
  assert.equal(r.getAttribute("width"), "290", "spans the full width of the map");

  // and an antimeridian-crossing box paints as TWO pieces rather than one wrong wide one
  paintRect(
    svg,
    { minLon: 150, maxLon: -150, minLat: -10, maxLat: 10, mode: "flexible" },
    290,
    150,
  );
  const r2 = svg.querySelector(".selrect2") as SVGRectElement;
  assert.ok(Number(r.getAttribute("width")) > 0, "piece one: from minLon to the antimeridian");
  assert.ok(Number(r2.getAttribute("width")) > 0, "piece two: from the other side to maxLon");
});

test('sidebar: one Filter header with an active count and Clear all (no "Facets" label)', async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("search")) {
      return {
        body: searchResponse({
          total: 3,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["cmip6", 3, "cordex", 2] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  const side = q<HTMLElement>(root, ".side") as HTMLElement;
  assert.ok(
    !/facets/i.test(side.textContent ?? ""),
    'the Solr word "Facets" is gone from the sidebar',
  );
  assert.equal(q<HTMLElement>(root, ".side-filterhead .sf-title")?.textContent, "Filter");
  assert.equal(
    q<HTMLElement>(root, ".side-filterhead .sf-badge"),
    null,
    "no badge while nothing is selected",
  );

  pickValue(root, "cmip6");
  await wait(320);
  // ONE number. The include/exclude split belongs to the per-facet controls, where it is
  // actionable; here the badge only ever clears everything.
  assert.equal(q<HTMLElement>(root, ".side-filterhead .sf-n")?.textContent, "1", "active count");
  assert.equal(q<HTMLElement>(root, ".side-filterhead .fb-inc"), null, "no breakdown here");
  assert.equal(q<HTMLElement>(root, ".side-filterhead .fb-exc"), null, "no breakdown here");
  // the selected value reads as a subtitle under the section name - no expanding needed
  assert.equal(q<HTMLElement>(root, '.facet[data-key="project"] .fh-sel')?.textContent, "cmip6");
  // the count badge IS the clear-all control - there is no separate sidebar "Clear all" link
  assert.equal(
    q<HTMLElement>(root, ".side-filterhead .sf-clear"),
    null,
    "the sidebar Clear all link is gone",
  );
  const badge = q<HTMLButtonElement>(root, ".side-filterhead .sf-badge");
  assert.ok(badge, "the FILTER count badge is present");
  badge!.click();
  await wait(60);
  assert.deepEqual(handle.getState().selected, {}, "clicking the count badge clears all filters");
  handle.destroy();
});

test("sidebar: a huge facet gets its own search box and a capped scroll area", async () => {
  const many: (string | number)[] = [];
  for (let i = 0; i < 400; i++) many.push(`val_${i}`, 400 - i);
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("search")) {
      return {
        body: searchResponse({
          total: 9,
          rows: [{ file: "/a.nc" }],
          facets: { project: many },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  const head = q<HTMLButtonElement>(
    root,
    '.facet[data-key="project"] .facet-head',
  ) as HTMLButtonElement;
  head.click();
  await wait(30);

  const list = q<HTMLElement>(root, '.facet[data-key="project"] .fval-list');
  assert.ok(
    list,
    "values live in a dedicated scroll container (capped in CSS, so 5000 values are fine)",
  );
  const search = q<HTMLInputElement>(root, '.facet[data-key="project"] .fval-search');
  assert.ok(search, "a big facet gets its own search box");

  search!.value = "val_37";
  search!.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(30);
  const labels = qa<HTMLElement>(root, '.facet[data-key="project"] .fval .nm').map(
    (n) => n.textContent,
  );
  assert.ok(
    labels.length > 0 && labels.every((l) => (l ?? "").includes("val_37")),
    "the list filters as you type",
  );
  assert.ok(labels.includes("val_37"), "including the exact match");
  handle.destroy();
});

test("map: Leaflet is never loaded up-front, and an offline failure keeps the SVG", async () => {
  const { setLeafletLoaderForTests } = await import("../src/map.js");
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("search"))
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["cmip6", 1] },
          primary: ["project"],
        }),
      };
    return { body: {} };
  };
  let loads = 0;
  setLeafletLoaderForTests(async () => {
    loads++;
    throw new Error("offline");
  });
  try {
    const { handle, root } = await mount(router);
    await wait(30);
    // Merely rendering the app (results, details, sidebar) must not pull Leaflet in: the SVG world
    // map is the zero-cost default and Leaflet is never on the initial paint.
    assert.equal(loads, 0, "Leaflet is not fetched on load");

    // the details panel keeps the cheap SVG + an explicit on-demand upgrade
    q<HTMLElement>(root, "#fdb-results .row")?.click();
    await wait(60);
    const zoom = q<HTMLButtonElement>(root, ".details .map-zoom");
    if (zoom) {
      assert.equal(loads, 0, "still not loaded just because a map is on screen");
      zoom.click();
      await wait(30);
      assert.equal(loads, 1, "loaded on demand, once");
      assert.ok(
        q(root, ".details .minimap svg"),
        "a failed load leaves the SVG intact - nothing breaks",
      );
      assert.match(zoom.textContent ?? "", /unavailable/i, "and the button says so");
    }
    handle.destroy();
  } finally {
    setLeafletLoaderForTests(null);
  }
});

test("map: Leaflet is never initialised into a zero-size container", async () => {
  const { setLeafletLoaderForTests, setLeafletCssInjectorForTests } = await import("../src/map.js");
  setLeafletCssInjectorForTests(async () => {
    /* no real stylesheet in jsdom */
  });
  const { mountLeafletMap } = await import("../src/components/leafletMap.js");
  const { Disposables } = await import("../src/dom.js");

  // A fake Leaflet that records the size of the container it is given. Initialising into a 0x0 box
  // is what makes the real Leaflet mis-tile and mis-map its coordinates (broken map, dead
  // selection) - so the mount must simply not happen until the container has a real size.
  let seen: { w: number; h: number } | null = null;
  setLeafletLoaderForTests(async () => ({
    map: (el: HTMLElement) => {
      seen = { w: el.offsetWidth, h: el.offsetHeight };
      return {
        attributionControl: { setPrefix: () => {} },
        dragging: { enable: () => {}, disable: () => {} },
        on: () => {},
        off: () => {},
        setView: () => {},
        fitBounds: () => {},
        invalidateSize: () => {},
        remove: () => {},
      };
    },
    tileLayer: () => ({ addTo: () => {} }),
    rectangle: () => ({}),
    layerGroup: () => ({ addTo: () => ({}), remove: () => {} }),
    DomEvent: { disableClickPropagation: () => {} },
  }));
  try {
    const dis = new Disposables();
    const host = document.createElement("div"); // never laid out -> offsetHeight is 0
    document.body.appendChild(host);
    const ctx = { cfg: { map: { js: "x", css: "y", tileUrl: "t", attribution: "a" } } } as never;
    const handle = await mountLeafletMap(ctx, dis, host, {
      editable: true,
      bbox: null,
      onChange: () => {},
    });

    assert.equal(handle, null, "no map is mounted into a zero-size box - the caller keeps the SVG");
    assert.equal(seen, null, "Leaflet was never handed a 0x0 container");
    assert.equal(host.querySelector(".lmap"), null, "and no orphaned map canvas is left behind");
    dis.flush();
    host.remove();
  } finally {
    setLeafletLoaderForTests(null);
    setLeafletCssInjectorForTests(null);
  }
});

test("map: once a JS build is pinned, a later CSS URL is never paired with it", async () => {
  const { loadLeaflet, setLeafletLoaderForTests, setLeafletCssInjectorForTests } =
    await import("../src/map.js");
  const { Disposables } = await import("../src/dom.js");
  const dis = new Disposables();
  const cssAsked: string[] = [];
  let failCss: string | null = "css-a"; // css-a fails on its first attempt, then succeeds
  setLeafletCssInjectorForTests(async (href: string) => {
    cssAsked.push(href);
    if (href === failCss) {
      failCss = null;
      throw new Error("stylesheet failed");
    }
  });
  setLeafletLoaderForTests(
    async (cfg: { js: string }) =>
      ({ __js: cfg.js }) as unknown as Awaited<ReturnType<typeof loadLeaflet>>,
  );
  try {
    // js-a loads, css-a fails -> the pair rejects, but js-a is now pinned
    await assert.rejects(
      loadLeaflet({ js: "js-a", css: "css-a", tileUrl: "t", attribution: "a" } as never, dis),
    );
    // retry with a DIFFERENT config: must reinstall css-a (the pinned CSS) and return js-a - never css-b
    const mod = (await loadLeaflet(
      { js: "js-b", css: "css-b", tileUrl: "t", attribution: "a" } as never,
      dis,
    )) as unknown as { __js: string };
    assert.equal(mod.__js, "js-a", "the pinned JS build is returned, not js-b");
    assert.ok(cssAsked.includes("css-a"), "css-a (pinned to js-a) was reinstalled on retry");
    assert.ok(!cssAsked.includes("css-b"), "css-b was NEVER paired with the pinned js-a");
  } finally {
    setLeafletLoaderForTests(null);
    setLeafletCssInjectorForTests(null);
  }
});

test("bbox: a flat (zero-area) box is not applied; a real box applies live", async () => {
  const { handle, root } = await mount(defaultRouter());
  q<HTMLButtonElement>(root, '.special[aria-label="Edit bounding box"]')!.click();
  await wait(20);
  const fields = qa<HTMLInputElement>(root, ".pop .editor .bbox-fields input");
  assert.equal(fields.length, 4, "minLon/maxLon/minLat/maxLat");
  // Editors apply LIVE - there is no Apply button, only Clear.
  const btns = qa<HTMLButtonElement>(root, ".pop .editor .actions .btn");
  assert.ok(
    !btns.some((b) => /apply/i.test(b.textContent ?? "")),
    "no Apply button - the editor applies live",
  );
  assert.ok(
    btns.some((b) => /clear/i.test(b.textContent ?? "")),
    "Clear is kept",
  );

  const type = (vals: string[]): void => {
    fields.forEach((f, i) => {
      f.value = vals[i];
      f.dispatchEvent(new win.Event("input", { bubbles: true })); // validation / .bad
      f.dispatchEvent(new win.Event("change", { bubbles: true })); // live apply
    });
  };
  // exactly what a straight horizontal swipe produced: wide, but zero height -> NOT applied
  type(["116.54", "117.62", "50.76", "50.76"]);
  await wait(10);
  assert.equal(
    handle.getState().bbox,
    null,
    "a box with no height (a line, not a region) is not applied",
  );

  // a real box applies live
  type(["-10", "10", "35", "60"]);
  await wait(10);
  assert.deepEqual(handle.getState().bbox, {
    minLon: -10,
    maxLon: 10,
    minLat: 35,
    maxLat: 60,
    mode: "flexible",
  });
  handle.destroy();
});

test("map: a component flush must NOT uninstall Leaflet's stylesheet", async () => {
  const {
    loadLeaflet,
    setLeafletLoaderForTests,
    setLeafletCssInjectorForTests,
    DEFAULT_MAP_CONFIG,
  } = await import("../src/map.js");
  const { Disposables } = await import("../src/dom.js");

  // fake the two global installs so the lifecycle can be driven without a network
  let cssInjections = 0;
  setLeafletCssInjectorForTests(async (href: string) => {
    cssInjections++;
    const link = document.createElement("link");
    link.id = "freva-leaflet-css";
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.loaded = "true";
    document.head.appendChild(link);
  });
  const fakeL = { fake: true };
  setLeafletLoaderForTests(async () => fakeL);
  const cssLink = (): HTMLElement | null => document.getElementById("freva-leaflet-css");
  for (const stray of Array.from(document.querySelectorAll("#freva-leaflet-css"))) stray.remove();

  try {
    // 1) the DETAILS map loads Leaflet first, using the details region's disposables…
    const detailsRegion = new Disposables();
    await loadLeaflet(DEFAULT_MAP_CONFIG, detailsRegion);
    assert.ok(cssLink(), "stylesheet installed");

    // 2) …then the bbox/facet map loads it too, with its own region
    const facetRegion = new Disposables();
    await loadLeaflet(DEFAULT_MAP_CONFIG, facetRegion);
    assert.ok(cssLink(), "still installed");

    // 3) the details panel re-renders -> its region is flushed. The stylesheet is GLOBAL and must
    //    survive: it was never the details panel's to own. Removing it here would leave every
    //    other map with Leaflet's JS but none of its CSS -> offset tiles, dead selection.
    detailsRegion.flush();
    assert.ok(cssLink(), "a component flush does not uninstall the global stylesheet");

    // 4) and if the stylesheet ever does go missing, a CACHED Leaflet call restores it - a cached
    //    module is not proof the CSS is still in the document
    cssLink()!.remove();
    assert.equal(cssLink(), null, "stylesheet removed by something else");
    await loadLeaflet(DEFAULT_MAP_CONFIG, facetRegion);
    assert.ok(cssLink(), "a cached load re-verifies the stylesheet and restores it");
    assert.equal(cssInjections, 2, "installed once, then restored once - not on every call");

    facetRegion.flush();
  } finally {
    setLeafletLoaderForTests(null);
    setLeafletCssInjectorForTests(null);
    document.getElementById("freva-leaflet-css")?.remove();
  }
});

test("controls: two labelled task modes on top; view/details/export live with the results", async () => {
  const { handle, root } = await mount(defaultRouter());

  // TOP: only the workspace switch, and it is labelled - not a row of icon-only buttons mixing
  // a workspace switch, a layout switch and a panel toggle at identical weight
  const cluster = q<HTMLElement>(root, ".ctrl-cluster") as HTMLElement;
  const modes = qa<HTMLButtonElement>(cluster, ".ctrl");
  assert.equal(modes.length, 2, "exactly two controls on top - Browse and Overview");
  assert.deepEqual(
    modes.map((b) => q<HTMLElement>(b, ".ctrl-lbl")?.textContent),
    ["Browse", "Overview"],
    "both carry a visible text label",
  );
  assert.equal(
    q(cluster, '[aria-label="Details panel"]'),
    null,
    "the panel toggle is NOT in the workspace switch",
  );

  // ORDER: the workspace switch sits to the RIGHT of the chips.
  const toprow = q<HTMLElement>(root, ".toprow") as HTMLElement;
  const kids = Array.from(toprow.children);
  const clusterIdx = kids.indexOf(cluster);
  const chipsIdx = kids.indexOf(q<HTMLElement>(toprow, ".chips") as HTMLElement);
  assert.ok(
    clusterIdx >= 0 && chipsIdx >= 0 && clusterIdx > chipsIdx,
    "the mode cluster comes after the chips in the top row",
  );

  // RESULT BAR: the controls that act on the result list
  const bar = q<HTMLElement>(root, ".res-bar") as HTMLElement;
  assert.ok(q(bar, '.seg [aria-label="List view"]'), "layout switch sits with the results");
  assert.ok(
    q(bar, '[aria-label="Details panel"]'),
    "the details toggle sits next to what it opens",
  );
  assert.ok(
    q(bar, '[aria-label^="Export catalogue"]'),
    "export is an action, in the same bar but separated",
  );
  // visible labels for the two controls whose icons are not self-explanatory
  assert.equal(
    q<HTMLElement>(bar, '[aria-label="Details panel"] .tbtn-lbl')?.textContent,
    "Details",
  );
  assert.equal(
    q<HTMLElement>(bar, '[aria-label^="Export catalogue"] .tbtn-lbl')?.textContent,
    "Export",
  );

  // the count is status text, not a pill that looks clickable
  assert.equal(q(root, ".scope-tag"), null, 'the "WHOLE RESULT SET" pill is gone');
  assert.ok(q(root, ".scope-lbl"), "replaced by plain status text");

  // and Details still works from the results bar
  q<HTMLButtonElement>(bar, '[aria-label="Details panel"]')!.click();
  await tick();
  assert.equal(
    handle.getState().detailsOpen,
    true,
    "the toggle in the results bar opens the panel",
  );
  handle.destroy();
});

test("overview: the bar is a value's share of the WHOLE result set, not of its own card", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("search")) {
      // 1000 results; the top project covers half of them, the next a quarter
      return {
        body: searchResponse({
          total: 1000,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["half", 500, "quarter", 250] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
  await wait(20);

  const rows = qa<HTMLElement>(root, '.fcard[data-key="project"] .fval');
  assert.ok(rows.length >= 2, "values rendered");
  // Every bar is measured against the WHOLE result set, not against the card's own biggest value,
  // so the same measure applies everywhere and cards can be compared with one another.
  assert.equal(rows[0].style.getPropertyValue("--pct"), "50%", "500 of 1000 results -> half a bar");
  assert.equal(rows[1].style.getPropertyValue("--pct"), "25%", "250 of 1000 results -> a quarter");
  assert.match(
    rows[0].getAttribute("data-tip") ?? "",
    /50\.0% of results/,
    "the exact share is in the tooltip",
  );
  // and the bar costs no DOM: it is a ::before, not an element
  assert.equal(q(rows[0], ".vbar"), null, "no extra node per value row");
  handle.destroy();
});

test("overview-merge: View/Details are shown only while the file panel is on screen (keyboard-safe)", async () => {
  // jsdom ships no IntersectionObserver - install a controllable one so we can drive the file
  // panel in and out of view and assert the migration. It records instances and their targets
  // so we can pick out the panel observer (the one watching #fdb-results).
  interface MockIO {
    cb: (e: Array<{ target: Element; isIntersecting: boolean }>) => void;
    targets: Element[];
    fire(v: boolean): void;
  }
  const observers: MockIO[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const realIO = g.IntersectionObserver;
  const realWinIO = (win as unknown as Record<string, unknown>).IntersectionObserver;
  class FakeIO implements MockIO {
    cb: MockIO["cb"];
    targets: Element[] = [];
    constructor(cb: MockIO["cb"]) {
      this.cb = cb;
      observers.push(this);
    }
    observe(t: Element): void {
      this.targets.push(t);
    }
    unobserve(t: Element): void {
      this.targets = this.targets.filter((x) => x !== t);
    }
    disconnect(): void {
      this.targets = [];
    }
    fire(v: boolean): void {
      this.cb(this.targets.map((target) => ({ target, isIntersecting: v })));
    }
  }
  g.IntersectionObserver = FakeIO as unknown as typeof IntersectionObserver;
  (win as unknown as Record<string, unknown>).IntersectionObserver = FakeIO;
  try {
    const { handle, root } = await mount(defaultRouter());
    const panelctl = q<HTMLElement>(root, ".panelctl") as HTMLElement;
    assert.ok(panelctl, "the file-panel control group exists");
    const buttons = (): HTMLButtonElement[] => qa<HTMLButtonElement>(panelctl, "button");
    const shelve = q<HTMLButtonElement>(root, ".ov-shelve")!; // Stack toggle

    // Force Browse first - an earlier test may have persisted layout='overview' (loadLayout()
    // reads localStorage), and this test must not depend on suite order.
    q<HTMLButtonElement>(root, '.ctrl[aria-label="Browse results"]')!.click();
    await tick();

    // BROWSE: the file panel is always on screen -> controls shown, in the tab order, no observer.
    assert.equal(panelctl.classList.contains("in"), true, "Browse: controls visible");
    assert.equal(panelctl.getAttribute("aria-hidden"), "false", "Browse: not hidden from AT");
    assert.ok(
      buttons().every((b) => b.tabIndex === 0),
      "Browse: controls in the tab order",
    );
    assert.equal(shelve.hidden, true, "Browse: Stack is hidden (overview-only)");

    // OVERVIEW: only the metadata cards are on screen -> controls hide, leave the tab order,
    // aria-hidden. The single observer watches the file list (#fdb-results).
    q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
    await tick();
    assert.equal(panelctl.classList.contains("in"), false, "Overview @ top: controls hidden");
    assert.equal(panelctl.getAttribute("aria-hidden"), "true", "Overview @ top: hidden from AT");
    assert.ok(
      buttons().every((b) => b.tabIndex === -1),
      "Overview @ top: out of the tab order",
    );
    assert.equal(shelve.hidden, false, "Overview @ top: Stack is shown");

    const panelObs = observers.find((o) =>
      o.targets.some((t) => (t as HTMLElement).id === "fdb-results"),
    );
    assert.ok(panelObs, "an observer watches the file list region");

    // scroll the file panel into view -> controls merge into the same bar.
    panelObs!.fire(true);
    assert.equal(
      panelctl.classList.contains("in"),
      true,
      "file panel visible -> controls merge in",
    );
    assert.equal(panelctl.getAttribute("aria-hidden"), "false", "restored to AT");
    assert.ok(
      buttons().every((b) => b.tabIndex === 0),
      "restored to the tab order",
    );
    assert.ok(
      (q<HTMLElement>(root, ".res-bar") as HTMLElement).classList.contains("merged"),
      "bar shows the merged cue in overview",
    );
    assert.equal(shelve.hidden, true, "file panel reached -> Stack hidden");

    // scroll back up -> hidden again (hysteresis is in rootMargin, not tested here).
    panelObs!.fire(false);
    assert.equal(panelctl.classList.contains("in"), false, "scrolled away -> hidden again");
    assert.equal(shelve.hidden, false, "back over the blocks -> Stack shown again");

    // back to BROWSE -> always shown regardless of the observer.
    q<HTMLButtonElement>(root, '.ctrl[aria-label="Browse results"]')!.click();
    await tick();
    assert.equal(panelctl.classList.contains("in"), true, "Browse again: controls back");
    assert.equal(
      (q<HTMLElement>(root, ".res-bar") as HTMLElement).classList.contains("merged"),
      false,
      "no merged cue in Browse",
    );
    handle.destroy();
  } finally {
    g.IntersectionObserver = realIO;
    (win as unknown as Record<string, unknown>).IntersectionObserver = realWinIO;
  }
});
test("list view: a lean search still carries a uri | fs type column header + fs_type cell", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/")) {
      return {
        body: searchResponse({
          total: 2,
          rows: [{ file: "/data/tas_day.nc" }, { file: "/data/pr.zarr", fs_type: "s3" }],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  // an earlier test may have persisted grid view; force list.
  q<HTMLButtonElement>(root, '.seg button[aria-label="List view"]')!.click();
  await tick();

  // The main search must NOT ask for project/experiment/format - those columns are gone, so
  // querying the fields would just be dead cost. fs_type rides along on the existing thin row.
  const searchCall = fetchCalls.find((c) => c.url.includes("/extended-search/"));
  assert.ok(searchCall, "a main search happened");
  for (const f of ["fields=project", "fields=experiment", "fields=format"]) {
    assert.ok(!searchCall!.url.includes(f), `main search does not request ${f}`);
  }

  // The list view carries a column header (uri | fs type).
  const head = q<HTMLElement>(root, ".list-head");
  assert.ok(head, "list-view column header present");
  assert.equal(q<HTMLElement>(head!, ".lh-uri")?.textContent, "uri");
  assert.equal(q<HTMLElement>(head!, ".lh-fs")?.textContent, "fs type");

  // Rows keep checkbox + URI (name/dir) + a plain fs_type cell + kebab - no rich metadata cells.
  const rows = qa<HTMLElement>(root, "#fdb-results .row");
  assert.equal(qa(rows[0], ".cb").length, 1, "checkbox kept");
  assert.ok(q(rows[0], ".uricell .path"), "the complete URI is shown as one value");
  assert.equal(qa(rows[0], ".name, .dir").length, 0, "no split basename/directory nodes");
  assert.ok(q(rows[0], ".kebab"), "kebab kept");
  assert.equal(qa(rows[0], ".cell").length, 0, "no Project/Experiment/Format cells");
  assert.equal(
    q<HTMLElement>(rows[1], ".fs")?.textContent,
    "s3",
    "fs_type shown from the thin row",
  );
  handle.destroy();
});
test("facet header badge clears the whole facet (sidebar and overview)", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [] }) };
    if (call.url.includes("search")) {
      return {
        body: searchResponse({
          total: 100,
          rows: [{ file: "/a.nc" }],
          facets: { project: ["cmip6", 50, "cmip5", 30, "cordex", 20] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);

  // select two project values via the sidebar
  openFacet(root, "project");
  byText<HTMLElement>(root, ".side-scroll .fval", "cmip6")!.click();
  await wait(20);
  byText<HTMLElement>(root, ".side-scroll .fval", "cmip5")!.click();
  await wait(20);
  assert.deepEqual(handle.getState().selected.project, ["cmip6", "cmip5"], "two values selected");

  // the selected-count badge shows 2 and is an actionable "clear this facet" control
  const badge = q<HTMLElement>(root, '.facet[data-key="project"] .fh-count') as HTMLElement;
  assert.ok(badge, "sidebar selected-count badge present");
  assert.equal(badge.tagName, "BUTTON", "it is a real button, and a SIBLING of the disclosure one");
  assert.equal(badge.closest("button"), badge, "…never nested inside another button");
  assert.equal(badge.querySelector(".fb-n")?.textContent, "+2", "two INCLUDED, marked with +");
  assert.equal(root.querySelector('.facet[data-key="project"] .fb-exc'), null, "none excluded");
  assert.match(badge.getAttribute("aria-label") ?? "", /clear 2 included project values/i);

  // clicking it clears the WHOLE facet - not the accordion, not one value
  badge.click();
  await wait(20);
  assert.equal(
    handle.getState().selected.project,
    undefined,
    "badge click cleared every project value",
  );
  assert.equal(byText(root, ".chips .chip", "cmip6"), undefined, "the chips cleared with it");
  // facet accordion did not toggle shut on the badge click (stopPropagation)
  assert.ok(
    q(root, '.facet[data-key="project"]')?.classList.contains("open"),
    "accordion stayed open",
  );

  // same control exists in the overview card header and clears there too
  byText<HTMLElement>(root, ".side-scroll .fval", "cmip6")!.click();
  await wait(20);
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
  await wait(30);
  const ovBadge = q<HTMLElement>(root, '.fcard[data-key="project"] .fh-count') as HTMLElement;
  assert.ok(ovBadge, "overview card header shows the selected-count badge");
  assert.equal(ovBadge.tagName, "BUTTON", "overview badge is a real button too");
  assert.match(ovBadge.getAttribute("aria-label") ?? "", /clear 1 included/i);
  ovBadge.click();
  await wait(20);
  assert.equal(handle.getState().selected.project, undefined, "overview badge cleared the facet");
  handle.destroy();
});
test("clicking Overview jumps the scroller to the top so the cards are visible", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: ["cmip6"] }) };
    if (call.url.includes("search"))
      return { body: searchResponse({ total: 5, rows: [{ file: "/a.nc" }] }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  const scroller = q<HTMLElement>(root, ".results-scroll") as HTMLElement;
  const calls: Array<{ top?: number }> = [];
  // jsdom has no real scrolling - spy on the call the component makes.
  (scroller as unknown as { scrollTo: (o: { top?: number }) => void }).scrollTo = (o) => {
    calls.push(o);
  };

  // switching TO overview snaps the scroller to the top (so the off-screen cards come into view)
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
  await tick();
  assert.equal(calls.length, 1, "scrolled exactly once when entering overview");
  assert.equal(calls[0].top, 0, "jumped to the very top");

  // switching BACK to Browse must leave the scroll position alone
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Browse results"]')!.click();
  await tick();
  assert.equal(calls.length, 1, "no forced scroll when returning to the file list");
  handle.destroy();
});
test("stale-counts pill: shown with an explanation when a recount fails, and is self-describing", async () => {
  const failRecount = true;
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: ["cmip6"] }) };
    if (call.url.includes("/metadata-search/")) {
      return failRecount
        ? { status: 500 }
        : {
            body: searchResponse({
              total: 5,
              facets: { project: ["cmip6", 5] },
              primary: ["project"],
            }),
          };
    }
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

  // entering overview kicks off a recount (metadata-search) - which we fail
  q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]')!.click();
  await wait(420); // recount debounce (300ms) + settle

  assert.ok(handle.getState().overviewStale, "a failed recount flags the counts as stale");
  const pill = q<HTMLElement>(root, ".stale-pill");
  assert.ok(pill, "the stale-counts pill is shown");
  // the pill explains itself on hover
  assert.match(pill!.getAttribute("data-tip") ?? "", /refresh the facet counts failed/i);
  handle.destroy();
});
test("Details comparison covers the whole selection, even past 10 files", async () => {
  let detailCalls = 0;
  const rows = Array.from({ length: 12 }, (_, i) => ({ file: `/d/f_${i}.nc` }));
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/") && call.url.includes("file=")) {
      detailCalls++; // one per-file details fetch
      const m = call.url.match(/file=([^&]+)/);
      const f = m ? decodeURIComponent(m[1]) : "";
      return { body: searchResponse({ total: 1, rows: [{ file: f }] }) };
    }
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 12, rows }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  // pick all 12 (past the 10-file aggregate cap)
  for (let i = 0; i < 12; i++) {
    qa<HTMLElement>(root, "#fdb-results .cb")[i].click();
    await tick();
  }
  assert.equal(handle.getState().pickedKeys.size, 12, "12 files picked");

  qa<HTMLButtonElement>(root, ".pickbar .btn")
    .find((b) => (b.textContent ?? "").includes("Details"))!
    .click();
  await wait(250); // pooled per-file fetches settle

  assert.equal(
    detailCalls,
    12,
    "every picked file was fetched for the comparison (nothing dropped)",
  );
  assert.match(q<HTMLElement>(root, ".info-name")?.textContent ?? "", /12 files selected/);
  handle.destroy();
});

test("details priority: the last action wins - a clicked row overrides the picked bunch", async () => {
  const rows = [{ file: "/d/a.nc" }, { file: "/d/b.nc" }, { file: "/d/c.nc" }];
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/") && call.url.includes("file=")) {
      const m = call.url.match(/file=([^&]+)/);
      const f = m ? decodeURIComponent(m[1]) : "";
      return { body: searchResponse({ total: 1, rows: [{ file: f }] }) };
    }
    if (call.url.includes("/extended-search/")) return { body: searchResponse({ total: 3, rows }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '.seg button[aria-label="List view"]')!.click();
  await tick();

  // 1) click row A, open details -> the panel describes just A
  qa<HTMLElement>(root, "#fdb-results .row")[0].click();
  q<HTMLButtonElement>(root, '[aria-label="Details panel"]')!.click();
  await wait(80);
  assert.match(
    q<HTMLElement>(root, ".info-name")?.textContent ?? "",
    /a\.nc/,
    "clicking a row shows that one file",
  );

  // 2) select B and C -> the panel switches to the picked bunch
  qa<HTMLElement>(root, "#fdb-results .cb")[1].click();
  await tick();
  qa<HTMLElement>(root, "#fdb-results .cb")[2].click();
  await tick();
  await wait(80);
  assert.match(
    q<HTMLElement>(root, ".info-name")?.textContent ?? "",
    /2 files selected/,
    "selecting shows the picked bunch",
  );

  // 3) click row A again -> focus overrides the still-present picks (last action wins)
  qa<HTMLElement>(root, "#fdb-results .row")[0].click();
  await wait(80);
  assert.equal(handle.getState().pickedKeys.size, 2, "the selection is untouched");
  assert.match(
    q<HTMLElement>(root, ".info-name")?.textContent ?? "",
    /a\.nc/,
    "a later row click overrides the picks",
  );
  handle.destroy();
});

test("details actions: a bunch shows a LOCKED Aggregate (auth/max), not Inspect", async () => {
  const rows = [{ file: "/d/a.nc" }, { file: "/d/b.nc" }];
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/") && call.url.includes("file=")) {
      const m = call.url.match(/file=([^&]+)/);
      return {
        body: searchResponse({ total: 1, rows: [{ file: m ? decodeURIComponent(m[1]) : "" }] }),
      };
    }
    if (call.url.includes("/extended-search/")) return { body: searchResponse({ total: 2, rows }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router, { authEnabled: false });
  qa<HTMLElement>(root, "#fdb-results .cb")[0].click();
  await tick();
  qa<HTMLElement>(root, "#fdb-results .cb")[1].click();
  await tick();
  q<HTMLButtonElement>(root, '[aria-label="Details panel"]')!.click();
  await wait(150);
  const actions = q<HTMLElement>(root, ".info-actions");
  assert.ok(actions, "the actions block rendered for the bunch");
  const primary = q<HTMLButtonElement>(root, ".info-actions .btn.primary");
  assert.match(
    primary?.textContent ?? "",
    /Aggregate/,
    "the primary action is Aggregate for a bunch",
  );
  assert.equal(primary?.disabled, true, "it is locked (auth off)");
  assert.ok(!/Inspect data/.test(actions!.textContent ?? ""), "Inspect is NOT offered for a bunch");
  handle.destroy();
});

test("Select all picks every loaded row and toggles off", async () => {
  const { handle, root } = await mount(
    defaultRouter({
      total: 3,
      rows: [{ file: "/d/a.nc" }, { file: "/d/b.nc" }, { file: "/d/c.nc" }],
    }),
  );
  const selall = q<HTMLButtonElement>(root, ".selall");
  assert.ok(selall, "the Select-all control is present in the results bar");
  selall!.click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 3, "every loaded row is selected");
  selall!.click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 0, "clicking again deselects all");
  handle.destroy();
});

test("Select all is truthful past the cap: it selects the first 25 and says how many it left", async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ file: `/f_${i}.nc` }));
  const { handle, root } = await mount(defaultRouter({ total: 40, rows }));
  const selall = q<HTMLButtonElement>(root, ".selall") as HTMLButtonElement;
  selall.click();
  await tick();
  const picked = handle.getState().pickedKeys;
  assert.equal(picked.size, 25, "the cap is honoured by the BULK path too");
  // …and it is the first 25 IN RESULT ORDER, not an arbitrary 25.
  for (let i = 0; i < 25; i++) assert.ok(picked.has(`/f_${i}.nc`), `row ${i} selected`);
  assert.ok(!picked.has("/f_25.nc"), "row 25 was left out");
  const status = q<HTMLElement>(root, ".status .mono")?.textContent ?? "";
  assert.match(status, /first 25/i, "the cap is announced");
  assert.match(status, /15/, "…along with how many listed rows were NOT selected");
  // A second bulk action at the capped state clears the selection rather than doing nothing.
  selall.click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 0, "a bulk action at the cap clears it");
  handle.destroy();
});

test("comparison modal: a details re-render (not close) still restores focus, not <body>", async () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ file: `/d/g_${i}.nc` }));
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/") && call.url.includes("file=")) {
      const f = decodeURIComponent(call.url.match(/file=([^&]+)/)?.[1] ?? "");
      const i = Number(f.match(/g_(\d+)/)?.[1] ?? 0);
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: f }],
          facets: { project: [i % 2 ? "odd" : "even", 1] },
        }),
      };
    }
    if (call.url.includes("/extended-search/")) return { body: searchResponse({ total: 4, rows }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, ".selall")!.click();
  await tick();
  q<HTMLButtonElement>(root, '[aria-label="Details panel"]')!.click();
  await wait(400);
  const enlarge = q<HTMLButtonElement>(root, ".diff-enlarge");
  assert.ok(enlarge, "Enlarge present");
  enlarge!.focus();
  enlarge!.click();
  await tick();
  assert.ok(q(root, ".dmm-backdrop"), "modal open");
  // Change the picks -> the details panel re-renders and flushes the modal WITHOUT calling close().
  q<HTMLButtonElement>(root, ".selall")!.click();
  await wait(50);
  assert.equal(q(root, ".dmm-backdrop"), null, "the modal was torn down by the re-render");
  assert.notEqual(win.document.activeElement, win.document.body, "focus did not fall to <body>");
  assert.equal(
    win.document.activeElement,
    q(root, '[aria-label="Details panel"]'),
    "focus fell back to the stable Details launcher",
  );
  handle.destroy();
});

test("comparison: fetches are capped past DIFF_MAX and Enlarge opens a full-screen matrix", async () => {
  let detailCalls = 0;
  const rows = Array.from({ length: 30 }, (_, i) => ({ file: `/d/f_${i}.nc` }));
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/extended-search/") && call.url.includes("file=")) {
      detailCalls++;
      const m = call.url.match(/file=([^&]+)/);
      const f = m ? decodeURIComponent(m[1]) : "";
      const i = Number(f.match(/f_(\d+)/)?.[1] ?? 0);
      return {
        body: searchResponse({
          total: 1,
          rows: [{ file: f }],
          facets: { project: [i % 2 ? "odd" : "even", 1] },
        }),
      };
    }
    if (call.url.includes("/extended-search/"))
      return { body: searchResponse({ total: 30, rows }) };
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, ".selall")!.click();
  await tick(); // select all 30
  q<HTMLButtonElement>(root, '[aria-label="Details panel"]')!.click();
  await wait(600); // pooled per-file fetches settle
  assert.ok(
    detailCalls <= 25,
    `per-file fetches capped at DIFF_MAX (was ${detailCalls}, expected ≤ 25)`,
  );
  const enlarge = q<HTMLButtonElement>(root, ".diff-enlarge");
  assert.ok(enlarge, "Enlarge button present in the comparison");
  enlarge!.focus();
  enlarge!.click();
  await tick();
  const modal = q<HTMLElement>(root, ".dmm-modal");
  assert.ok(q(root, ".dmm-backdrop .dmatrix"), "the full-screen comparison matrix opened");
  assert.equal(modal!.getAttribute("role"), "dialog", "the modal announces role=dialog");
  assert.equal(modal!.getAttribute("aria-modal"), "true", "aria-modal is set");
  assert.ok(modal!.contains(win.document.activeElement), "focus moved into the dialog on open");
  // Escape closes it and returns focus to the trigger
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  assert.equal(q(root, ".dmm-backdrop"), null, "Escape closed the modal");
  assert.equal(win.document.activeElement, enlarge, "focus returned to the Enlarge button");
  handle.destroy();
});

// Inspector: the lazy @freva-org/data-inspector, driven through the import seam
// A fake module WITHOUT DataInspectorElement (so the loader skips customElements.define); the dialog
// is then a plain <data-inspector> element whose attributes/properties we can read. loadZarrMetadataHtml
// probes the store itself, so it throws for a non-zarr URL.
function fakeInspectorModule(isZarr: boolean, seen?: { auth: Record<string, string> | null }) {
  return {
    loadZarrMetadataHtml: async (
      _url: string,
      o: { getAuthHeaders?: () => Record<string, string> },
    ) => {
      if (seen) seen.auth = o.getAuthHeaders ? o.getAuthHeaders() : null;
      if (!isZarr) throw new Error("not a zarr store");
      return '<div class="xr-repr">zarr metadata here</div>';
    },
  };
}
/**
 * A pointerdown/move/up event, using PointerEvent where the environment has it and falling back to
 * MouseEvent (jsdom exposes the constructor but not always with pointer fields). The component
 * listens for pointer events so one gesture path serves mouse, pen and touch.
 */
function pointerEvent(type: string, init: Record<string, unknown> = {}): Event {
  const w = win as unknown as { PointerEvent?: typeof MouseEvent; MouseEvent: typeof MouseEvent };
  const Ctor = w.PointerEvent ?? w.MouseEvent;
  return new Ctor(type, { bubbles: true, ...init } as MouseEventInit);
}

async function clickInspect(root: HTMLElement): Promise<void> {
  q<HTMLElement>(root, "#fdb-results .row")?.click(); // focus a file
  q<HTMLButtonElement>(root, '[aria-label="Details panel"]')!.click(); // open the details panel
  await wait(40); // per-file metadata settles -> actions render
  const btn = qa<HTMLButtonElement>(root, ".info-actions .btn").find((b) =>
    (b.textContent ?? "").includes("Inspect data"),
  );
  assert.ok(btn, "the Inspect action is present in the details panel");
  btn!.click();
  await wait(40); // loadInspector + zarr probe settle
}

test("Inspect: an already-zarr file renders client-side with NO auth", async () => {
  const seen = { auth: null as Record<string, string> | null };
  setInspectorImporterForTests(async () => fakeInspectorModule(true, seen));
  try {
    // authEnabled:false - the zarr path must still work with no sign-in
    const { handle, root } = await mount(
      defaultRouter({ total: 1, rows: [{ file: "/d/a.zarr" }] }),
      { authEnabled: false },
    );
    await clickInspect(root);
    const dlg = q<HTMLElement & { output?: string; status?: string }>(root, "data-inspector");
    assert.ok(dlg, "the inspector dialog opened even without auth");
    assert.equal(dlg!.getAttribute("status"), "ready", "a zarr store renders -> ready");
    assert.match(dlg!.output ?? "", /zarr metadata here/, "client-side xarray repr populated");
    // zarr-url must be set or the component keeps its metadata region hidden
    assert.equal(
      dlg!.getAttribute("zarr-url"),
      "/d/a.zarr",
      "zarr-url set -> the metadata region is revealed",
    );
    assert.deepEqual(seen.auth, {}, "NO Authorization header was sent on the zarr path");
    handle.destroy();
  } finally {
    setInspectorImporterForTests(null);
  }
});

test("Inspect: destroying the widget mid-import aborts cleanly - no dialog, no store read", async () => {
  const seen = { auth: null as Record<string, string> | null };
  let resolveMod: (m: unknown) => void = () => {};
  const gate = new Promise<unknown>((res) => {
    resolveMod = res;
  });
  setInspectorImporterForTests(() => gate as Promise<ReturnType<typeof fakeInspectorModule>>);
  try {
    const { handle, root } = await mount(
      defaultRouter({ total: 1, rows: [{ file: "/d/a.zarr" }] }),
      { authEnabled: false },
    );
    q<HTMLElement>(root, "#fdb-results .row")?.click();
    q<HTMLButtonElement>(root, '[aria-label="Details panel"]')!.click();
    await wait(40);
    qa<HTMLButtonElement>(root, ".info-actions .btn")
      .find((b) => (b.textContent ?? "").includes("Inspect data"))!
      .click();
    await tick(); // open() is now awaiting the (gated) import
    handle.destroy(); // …destroyed BEFORE the module resolves
    resolveMod(fakeInspectorModule(true, seen));
    await wait(30); // let the guarded continuation run
    assert.equal(
      seen.auth,
      null,
      "the store was never read after destroy - open() bailed on the disposed scope",
    );
    assert.equal(
      win.document.querySelector("data-inspector"),
      null,
      "no inspector element anywhere in the document",
    );
    assert.equal(root.querySelector("data-inspector"), null, "none under the torn-down root");
  } finally {
    setInspectorImporterForTests(null);
  }
});

test("Inspect: a non-zarr file is gated (needs the data-portal) when auth is off", async () => {
  setInspectorImporterForTests(async () => fakeInspectorModule(false));
  try {
    const { handle, root } = await mount(defaultRouter({ total: 1, rows: [{ file: "/d/b.nc" }] }), {
      authEnabled: false,
    });
    await clickInspect(root);
    const dlg = q<HTMLElement & { error?: string; status?: string }>(root, "data-inspector");
    assert.ok(dlg, "dialog opened");
    assert.equal(
      dlg!.getAttribute("status"),
      "error",
      "a non-zarr file without auth ends in an honest error",
    );
    assert.match(dlg!.error ?? "", /sign-in|data-portal/i, "the reason names what is missing");
    handle.destroy();
  } finally {
    setInspectorImporterForTests(null);
  }
});

test("Inspect: a non-zarr file surfaces an honest error (server ncdump not wired) even with auth on", async () => {
  setInspectorImporterForTests(async () => fakeInspectorModule(false));
  try {
    const { handle, root } = await mount(defaultRouter({ total: 1, rows: [{ file: "/d/b.nc" }] }), {
      authEnabled: true,
      enableHeavyOps: true,
    });
    await clickInspect(root);
    const dlg = q<HTMLElement & { error?: string; status?: string }>(root, "data-inspector");
    assert.ok(dlg, "dialog opened");
    assert.equal(
      dlg!.getAttribute("status"),
      "error",
      "a non-zarr file cannot be read client-side -> error",
    );
    assert.match(dlg!.error ?? "", /zarr store|could not read/i, "the error explains why");
    handle.destroy();
  } finally {
    setInspectorImporterForTests(null);
  }
});

test("Inspect: the header launcher opens the inspector EMPTY (no file, no store URL - the prompt state)", async () => {
  const seen = { auth: null as Record<string, string> | null };
  setInspectorImporterForTests(async () => fakeInspectorModule(true, seen));
  try {
    const { handle, root } = await mount(
      defaultRouter({ total: 1, rows: [{ file: "/d/a.zarr" }] }),
    );
    q<HTMLButtonElement>(root, '[aria-label="Inspect data"]')!.click(); // the top-bar launcher
    await wait(40);
    const dlg = q<HTMLElement & { output?: string }>(root, "data-inspector");
    assert.ok(dlg, "the inspector opened from the header button");
    assert.equal(dlg!.getAttribute("zarr-url"), null, "no store URL yet - nothing is auto-loaded");
    assert.equal(
      dlg!.getAttribute("status"),
      "ready",
      'ready + no zarr-url -> the "enter a path" empty state',
    );
    assert.equal(dlg!.getAttribute("file"), null, "no file was set");
    assert.equal(
      seen.auth,
      null,
      "nothing was fetched - it just waits for the user to enter a URL",
    );
    handle.destroy();
  } finally {
    setInspectorImporterForTests(null);
  }
});
