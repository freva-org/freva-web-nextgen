// Keyboard, focus and announcement behaviour.
//
// The component deliberately uses nested lists and native buttons rather than an ARIA tree, so most
// of the keyboard story is the platform's. What is NOT free, and is therefore what these tests are
// about, is: accessible names that change with state, focus that survives a re-render, and a live
// region that says what happened - the three things the reference implementation left out.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountDatasetTree } from "../src/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import { click, makeHost, q, qa, resetDom, rowNames, until } from "./helpers.js";
import { manualSource, nodes } from "./sources.js";
import { sampleCatalog } from "./fixtures/catalog.js";

function row(host: ParentNode, id: string): HTMLButtonElement | null {
  return q<HTMLButtonElement>(
    host,
    `[data-dataset-tree-id="${id}"] > .dataset-tree__rowline > .dataset-tree__row`,
  );
}

function liveText(host: ParentNode): string {
  return q(host, '[role="status"]')?.textContent ?? "";
}

test("the tree is nested lists of real buttons, not a half-built ARIA tree", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const handle = mountDatasetTree(host, { source: createSnapshotSource(catalog) });
  await until(() => rowNames(host).length === 3, "roots");

  // Either a complete ARIA tree or semantic lists - never a mixture, which is what breaks
  // assistive technology worst.
  assert.equal(host.querySelector('[role="tree"]'), null);
  assert.equal(host.querySelector('[role="treeitem"]'), null);
  assert.ok(host.querySelector("ul > li"), "the tree is not a list");

  for (const control of qa<HTMLButtonElement>(
    host,
    ".dataset-tree__row:not(.dataset-tree__row--inert)",
  )) {
    assert.equal(control.tagName, "BUTTON");
    // `type=button`, or the component submits a form it happens to be mounted inside.
    assert.equal(control.getAttribute("type"), "button");
  }
  handle.destroy();
});

test("every control is reachable by Tab, in document order, with no positive tabindex", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const handle = mountDatasetTree(host, { source: createSnapshotSource(catalog) });
  await until(() => rowNames(host).length === 3, "roots");

  const focusable = qa(host, "button, input, a[href]");
  assert.ok(focusable.length >= 5);
  for (const element of focusable) {
    const tabindex = element.getAttribute("tabindex");
    assert.ok(
      tabindex === null || tabindex === "0",
      `${element.className} has tabindex=${tabindex}`,
    );
  }
  handle.destroy();
});

test("icon-only and repeated controls carry accessible names that name their row", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const handle = mountDatasetTree(host, { source: createSnapshotSource(catalog) });
  await until(() => rowNames(host).length === 3, "roots");

  assert.equal(row(host, "cat:reanalysis")?.getAttribute("aria-label"), "Expand Global Reanalysis");
  click(row(host, "cat:reanalysis"));
  await until(() => rowNames(host).includes("surface"), "children");
  assert.equal(
    row(host, "cat:reanalysis")?.getAttribute("aria-label"),
    "Collapse Global Reanalysis",
  );

  // Icons never announce themselves twice.
  for (const svg of qa(host, "svg")) {
    assert.equal(svg.getAttribute("aria-hidden"), "true");
    assert.equal(svg.getAttribute("focusable"), "false");
  }
  handle.destroy();
});

test("loading, completion, emptiness and failure are all announced", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });

  const live = q(host, '[role="status"]');
  assert.equal(live?.getAttribute("aria-live"), "polite");
  assert.equal(liveText(host), "Loading datasets.");

  source.resolveRoots(nodes("alpha", "beta"));
  await until(() => liveText(host) === "2 datasets loaded.", "roots announcement");

  click(row(host, "n:alpha"));
  await until(() => liveText(host) === "Loading contents of alpha.", "children announcement");
  source.resolveChildren("n:alpha", nodes("gamma"));
  await until(() => liveText(host) === "1 items loaded under alpha.", "loaded announcement");

  click(row(host, "n:beta"));
  await until(() => source.pending("n:beta"), "request");
  source.resolveChildren("n:beta", []);
  await until(() => liveText(host) === "beta is empty.", "empty announcement");

  // Kick the reload off first: it does not settle until the roots do, so awaiting before
  // resolving them would deadlock the test rather than the component.
  const reloading = handle.reload();
  source.resolveRoots(nodes("alpha"));
  await reloading;
  await until(() => rowNames(host).includes("alpha"), "reloaded");
  click(row(host, "n:alpha"));
  await until(() => source.pending("n:alpha"), "request again");
  source.rejectChildren("n:alpha", new Error("HTTP 500"));
  await until(() => liveText(host).startsWith("Loading alpha failed."), "failure announcement");
  assert.match(liveText(host), /HTTP 500/);
  handle.destroy();
});

test("focus stays where the visitor left it while a branch loads", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots(nodes("alpha", "beta"));
  await until(() => rowNames(host).includes("beta"), "roots");

  const alpha = row(host, "n:alpha");
  alpha?.focus();
  click(alpha);
  await until(() => source.pending("n:alpha"), "request");
  // The re-render that shows the spinner must not steal focus from the row that caused it.
  assert.equal(document.activeElement?.getAttribute("data-dt-key"), "toggle:n:alpha");

  source.resolveChildren("n:alpha", nodes("gamma"));
  await until(() => rowNames(host).includes("gamma"), "children");
  assert.equal(
    document.activeElement?.getAttribute("data-dt-key"),
    "toggle:n:alpha",
    "focus moved when the children arrived",
  );
  handle.destroy();
});

test("focus moves somewhere sensible after a retry rather than being dropped on <body>", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots(nodes("alpha"));
  await until(() => rowNames(host).includes("alpha"), "roots");

  click(row(host, "n:alpha"));
  await until(() => source.pending("n:alpha"), "request");
  source.rejectChildren("n:alpha", new Error("nope"));
  await until(() => Boolean(q(host, '[data-dt-key="retry:n:alpha"]')), "retry control");

  const retry = q<HTMLButtonElement>(host, '[data-dt-key="retry:n:alpha"]');
  retry?.focus();
  click(retry);
  source.resolveChildren("n:alpha", nodes("gamma"));
  await until(() => rowNames(host).includes("gamma"), "children");

  // The Retry button no longer exists; focus lands on the branch it belonged to, not on nothing.
  assert.notEqual(document.activeElement, document.body, "focus was dropped after a retry");
  assert.equal(document.activeElement?.getAttribute("data-dt-key"), "toggle:n:alpha");
  handle.destroy();
});

test("focus survives a filter re-render when it is in the field itself", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const handle = mountDatasetTree(host, {
    source: createSnapshotSource(catalog),
    filterDebounceMs: 0,
  });
  await until(() => rowNames(host).length === 3, "roots");

  const input = q<HTMLInputElement>(host, ".dataset-tree__filter-input");
  input?.focus();
  input!.value = "Scenario Ensemble";
  input!.dispatchEvent(new window.Event("input", { bubbles: true }));
  await until(() => rowNames(host).length === 1, "filtered");

  // The toolbar is built once and never re-rendered, so the caret is never disturbed.
  assert.equal(document.activeElement, input, "filtering stole focus from the field");
  assert.equal(input?.value, "Scenario Ensemble");
  handle.destroy();
});

test("the busy state is exposed while the roots are loading", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  assert.equal(q(host, ".dataset-tree__body")?.getAttribute("aria-busy"), "true");
  source.resolveRoots(nodes("alpha"));
  await until(() => rowNames(host).includes("alpha"), "roots");
  assert.equal(q(host, ".dataset-tree__body")?.getAttribute("aria-busy"), "false");
  handle.destroy();
});

test("labels can be replaced wholesale, including the filter caveat", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, {
    source,
    labels: { filter: "Filtern", collapseAll: "Alle einklappen", rootsEmpty: "Nichts gefunden." },
  });
  source.resolveRoots([]);
  await until(() => Boolean(q(host, ".dataset-tree__msg--empty")), "empty");

  assert.equal(q<HTMLInputElement>(host, ".dataset-tree__filter-input")?.placeholder, "Filtern");
  assert.equal(q(host, '[data-dt-key="collapse-all"]')?.textContent, "Alle einklappen");
  assert.equal(q(host, ".dataset-tree__msg-text")?.textContent, "Nichts gefunden.");
  // Unlisted labels keep their defaults - the footer's own placeholder, which no override named.
  assert.equal(
    q(host, ".dataset-tree__path--empty")?.textContent,
    "Select an item to see its path",
  );
  handle.destroy();
});

test("every row carries the depth it is drawn at, as `aria-level` on its list item", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const handle = mountDatasetTree(host, {
    source: createSnapshotSource(catalog),
    initialExpandedIds: ["cat:reanalysis", "cat:reanalysis/surface"],
  });
  await until(() => rowNames(host).length > 3, "an opened branch");

  // `aria-level` ON A LIST ITEM, which is where it belongs here.
  //
  // This component is nested lists of native buttons rather than an ARIA tree - the test above
  // holds that line, and a half-built tree is worse for assistive technology than either whole
  // thing. But `listitem` supports `aria-level` too, so the depth a sighted reader sees in the
  // indentation is the depth a screen reader is told, from the same number, without inventing a
  // widget. Without it the two could disagree and nothing would say so.
  const levels = new Map<string, number>();
  for (const item of qa<HTMLElement>(host, ".dataset-tree__node")) {
    const id = item.getAttribute("data-dataset-tree-id");
    const level = item.getAttribute("aria-level");
    assert.ok(id && level, `a row has no level: ${item.className}`);
    levels.set(id!, Number(level));
  }

  // One-based, because ARIA levels are.
  assert.equal(Math.min(...levels.values()), 1, "the roots are not level 1");
  // And the number is the depth, checked against the identifiers' own nesting rather than against
  // a second copy of the expectation.
  for (const [id, level] of levels) {
    const parent = id.slice(0, id.lastIndexOf("/"));
    if (!levels.has(parent)) continue;
    assert.equal(level, levels.get(parent)! + 1, `${id} claims level ${level}`);
  }
  handle.destroy();
});
