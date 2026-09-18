// The visible behaviour of a mounted tree: what renders, what opens, what loads when, and what the
// four states look like from outside.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountDatasetTree } from "../src/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import { click, makeHost, q, qa, resetDom, rowNames, tick, until } from "./helpers.js";
import { lazySource, manualSource, nodes, recordingSource } from "./sources.js";
import { sampleCatalog } from "./fixtures/catalog.js";

function snapshotTree(host: HTMLElement, extra: Record<string, unknown> = {}) {
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const source = recordingSource(createSnapshotSource(catalog));
  const handle = mountDatasetTree(host, { source, ...extra });
  return { handle, source };
}

/** The same catalogue behind a source that makes no completeness claim. */
function lazyTree(host: HTMLElement, extra: Record<string, unknown> = {}) {
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const source = lazySource(createSnapshotSource(catalog));
  const handle = mountDatasetTree(host, { source, ...extra });
  return { handle, source };
}

/** The row button for a node, found by the id the component stamps on its `<li>`. */
function row(host: ParentNode, id: string): HTMLButtonElement | null {
  return q<HTMLButtonElement>(
    host,
    `[data-dataset-tree-id="${id}"] > .dataset-tree__rowline > .dataset-tree__row`,
  );
}

test("roots render in catalog order once the source settles", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = snapshotTree(host);
  await until(() => qa(host, ".dataset-tree__node").length > 0, "roots");

  assert.deepEqual(rowNames(host), [
    "Global Reanalysis",
    "Regional Downscaling",
    "Scenario Ensemble",
  ]);
  handle.destroy();
});

test("children are not requested until the branch is opened, and not again after that", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  // A LAZY source: laziness is the property under test, and a complete source is walked at mount
  // on purpose - that is what makes `Expand all` and a whole-archive filter possible.
  const { handle, source } = lazyTree(host);
  await until(() => rowNames(host).length === 3, "roots");

  assert.deepEqual(source.calls, ["<roots>"], "a closed tree fetched a branch");

  click(row(host, "cat:reanalysis"));
  await until(() => rowNames(host).includes("surface"), "children");
  assert.deepEqual(source.calls, ["<roots>", "cat:reanalysis"]);

  // Collapse and re-open: the data is already here, so nothing is asked for a second time.
  click(row(host, "cat:reanalysis"));
  await tick();
  assert.ok(!rowNames(host).includes("surface"), "the branch did not collapse");
  click(row(host, "cat:reanalysis"));
  await until(() => rowNames(host).includes("surface"), "children again");
  assert.deepEqual(source.calls, ["<roots>", "cat:reanalysis"], "re-opening re-fetched");

  handle.destroy();
});

test("`aria-expanded` tracks the branch, and points at the list it opens", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = snapshotTree(host);
  await until(() => rowNames(host).length === 3, "roots");

  const control = row(host, "cat:reanalysis");
  assert.equal(control?.getAttribute("aria-expanded"), "false");
  assert.equal(
    control?.getAttribute("aria-controls"),
    null,
    "a closed row named a missing element",
  );

  click(control);
  await until(() => rowNames(host).includes("surface"), "children");
  const open = row(host, "cat:reanalysis");
  assert.equal(open?.getAttribute("aria-expanded"), "true");
  const controls = open?.getAttribute("aria-controls");
  assert.ok(controls, "an open row named no list");
  assert.ok(host.querySelector(`#${controls}`), "aria-controls points at nothing");

  handle.destroy();
});

test("a branch that declares itself empty opens and says so", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = snapshotTree(host);
  await until(() => rowNames(host).length === 3, "roots");
  click(row(host, "cat:reanalysis"));
  await until(() => rowNames(host).includes("pressure-levels"), "children");

  click(row(host, "cat:reanalysis/pressure"));
  await until(
    () =>
      Boolean(
        q(host, '[data-dataset-tree-id="cat:reanalysis/pressure"] .dataset-tree__msg--empty'),
      ),
    "empty message",
  );
  const empty = q(
    host,
    '[data-dataset-tree-id="cat:reanalysis/pressure"] .dataset-tree__msg--empty',
  );
  assert.equal(empty?.textContent, "Empty");
  handle.destroy();
});

test("a slow branch shows a loading state, and clears it when the data lands", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });

  assert.ok(q(host, ".dataset-tree__msg--loading"), "the initial load showed nothing");
  source.resolveRoots(nodes("alpha"));
  await until(() => rowNames(host).includes("alpha"), "roots");

  click(row(host, "n:alpha"));
  await until(
    () => Boolean(q(host, ".dataset-tree__children .dataset-tree__msg--loading")),
    "spinner",
  );
  assert.equal(q(host, ".dataset-tree__children .dataset-tree__msg-text")?.textContent, "Listing…");

  source.resolveChildren("n:alpha", nodes("beta"));
  await until(() => rowNames(host).includes("beta"), "children");
  assert.equal(q(host, ".dataset-tree__children .dataset-tree__msg--loading"), null);
  handle.destroy();
});

test("a failed branch reports the reason, offers Retry, and stays retryable", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots(nodes("alpha"));
  await until(() => rowNames(host).includes("alpha"), "roots");

  click(row(host, "n:alpha"));
  await until(() => source.pending("n:alpha"), "request");
  source.rejectChildren("n:alpha", new Error("HTTP 503"));
  await until(() => Boolean(q(host, ".dataset-tree__msg--error")), "error");

  assert.match(
    q(host, ".dataset-tree__msg--error")?.textContent ?? "",
    /Could not list - HTTP 503/,
  );
  const retry = q<HTMLButtonElement>(host, '[data-dt-key="retry:n:alpha"]');
  assert.ok(retry, "no retry control");

  // The original never retried: a failed branch was marked loaded and stayed empty forever.
  click(retry);
  await until(() => source.pending("n:alpha"), "second request");
  source.resolveChildren("n:alpha", nodes("beta"));
  await until(() => rowNames(host).includes("beta"), "children after retry");
  assert.equal(q(host, ".dataset-tree__msg--error"), null);
  handle.destroy();
});

test("a failed root load reports the reason and can be retried", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.rejectRoots(new Error("offline"));
  await until(() => Boolean(q(host, ".dataset-tree__msg--error")), "error");
  assert.match(
    q(host, ".dataset-tree__msg--error")?.textContent ?? "",
    /Could not load datasets - offline/,
  );

  click(q(host, '[data-dt-key="retry-roots"]'));
  await until(() => source.calls.filter((c) => c === "<roots>").length === 2, "retry");
  source.resolveRoots(nodes("alpha"));
  await until(() => rowNames(host).includes("alpha"), "roots after retry");
  handle.destroy();
});

test("an empty catalog says so instead of rendering a blank panel", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots([]);
  await until(() => Boolean(q(host, ".dataset-tree__msg--empty")), "empty");
  assert.equal(q(host, ".dataset-tree__msg-text")?.textContent, "No datasets to show.");
  handle.destroy();
});

test("a dataset row opens a panel of the fields the source published, and nothing else", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = snapshotTree(host);
  await until(() => rowNames(host).length === 3, "roots");
  click(row(host, "cat:reanalysis"));
  await until(() => rowNames(host).includes("surface"), "level 2");
  click(row(host, "cat:reanalysis/surface"));
  await until(() => rowNames(host).includes("tas.zarr"), "level 3");

  click(row(host, "cat:reanalysis/surface/tas"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");

  const details = q(host, ".dataset-tree__details");
  const text = details?.textContent ?? "";

  // What the panel is for: the identity, the location, and the source's own fields.
  assert.match(text, /tas\.zarr/, "the panel does not name the store");
  assert.match(text, /example:\/\/reanalysis\/surface\/tas\.zarr/, "path pill missing");
  assert.match(text, /DIMS/);
  assert.match(text, /time 350 640/, "a detail value lost its emphasis half");
  assert.match(text, /VARS/);
  assert.match(text, /tas_min/);

  // What it is NOT for. None of these gets an automatic row.
  //
  // The size and the media type are already on the row above; the timestamp is not something a
  // reader of a landing-page archive browser acts on; and `metadata` is whatever the source
  // happened to attach, turned into chips because it could be rather than because anyone asked.
  // Together they make a panel whose length is decided by the catalogue's verbosity.
  assert.doesNotMatch(text, /1\.4 GB/, "the size is duplicated from the row");
  assert.doesNotMatch(text, /application\/vnd\.zarr/, "the media type is back in the panel");
  assert.doesNotMatch(text, /2026-02-11/, "the modification time is back in the panel");
  assert.doesNotMatch(text, /2 m air temperature/, "arbitrary metadata reached the UI");
  assert.doesNotMatch(text, /350\u2009640/, "the metadata dump is back");

  // The panel lives inside the tree, not in a dialog at the top of the document.
  assert.equal(document.querySelector("dialog"), null);
  assert.ok(host.contains(details), "details escaped the host");
  handle.destroy();
});

test("a dataset keeps the archive's name; the friendly title is not its identity", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = snapshotTree(host, {
    initialExpandedIds: ["cat:reanalysis", "cat:reanalysis/surface"],
  });
  await until(() => rowNames(host).includes("tas.zarr"), "deep");

  // The node carries `title: "Near-surface air temperature"`. A tree that shows that instead of
  // `tas.zarr` stops being a picture of the archive: the reader can no longer match a row to the
  // path they are about to copy, and two stores of the same variable at different cadences become
  // two identical rows.
  assert.ok(rowNames(host).includes("tas.zarr"), "the dataset lost its own name");
  assert.ok(
    !rowNames(host).includes("Near-surface air temperature"),
    "a friendly description replaced a store name",
  );
  // A grouping is different: it is named by whatever reads best.
  assert.ok(rowNames(host).includes("Global Reanalysis"), "a collection lost its title");
  handle.destroy();
});

test("details close again, and the row's accessible name flips with them", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots([
    { id: "d1", kind: "dataset", name: "one.zarr", path: "s3://b/one.zarr", size: 10 },
  ]);
  await until(() => rowNames(host).includes("one.zarr"), "roots");

  assert.equal(row(host, "d1")?.getAttribute("aria-label"), "Show details for one.zarr");
  click(row(host, "d1"));
  await tick();
  assert.ok(q(host, ".dataset-tree__details"));
  assert.equal(row(host, "d1")?.getAttribute("aria-label"), "Hide details for one.zarr");
  click(row(host, "d1"));
  await tick();
  assert.equal(q(host, ".dataset-tree__details"), null);
  handle.destroy();
});

test("a leaf with nothing to show is inert rather than a button that does nothing", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots([{ id: "f1", kind: "file", name: "notes.txt" }]);
  await until(() => rowNames(host).includes("notes.txt"), "roots");

  assert.ok(q(host, ".dataset-tree__row--inert"), "an empty leaf rendered as a control");
  assert.equal(q(host, '[data-dt-key="activate:f1"]'), null);
  handle.destroy();
});

test("availability is shown only when the data says so - the component never probes", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = snapshotTree(host);
  await until(() => rowNames(host).length === 3, "roots");

  const badges = qa(host, ".dataset-tree__badge").map((b) => b.textContent);
  assert.deepEqual(badges, ["coming soon"], "an availability badge appeared without input data");
  // One pill, no state variant. A colour-coded PLANNED / RESTRICTED / UNAVAILABLE taxonomy is a
  // status vocabulary the component invented; the source said "coming soon" and that is what a
  // reader gets, in the row's own colour and in the case it was written in.
  assert.equal(q(host, ".dataset-tree__badge--planned"), null, "a state variant is still drawn");
  const style = q<HTMLElement>(host, ".dataset-tree__badge");
  assert.equal(style?.className, "dataset-tree__badge");
  handle.destroy();
});

test("`initialExpandedIds` opens nested branches as they arrive", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = snapshotTree(host, {
    initialExpandedIds: ["cat:reanalysis", "cat:reanalysis/surface"],
  });
  await until(() => rowNames(host).includes("tas.zarr"), "deep auto-expand");
  handle.destroy();
});

test("`onNavigate` fires for a leaf, and `onInspect` only exists when supplied", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const navigated: string[] = [];
  const inspected: string[] = [];
  const source = manualSource();
  const handle = mountDatasetTree(host, {
    source,
    onNavigate: (node) => navigated.push(node.id),
    onInspect: (node) => {
      inspected.push(node.id);
    },
  });
  source.resolveRoots([
    {
      id: "d1",
      kind: "dataset",
      name: "one.zarr",
      path: "s3://b/one.zarr",
      inspect: "https://example.test/one.zarr",
    },
    // Same consumer, same callback, no inspectable location: no control.
    { id: "d2", kind: "dataset", name: "two.zarr", path: "s3://b/two.zarr" },
  ]);
  await until(() => rowNames(host).includes("one.zarr"), "roots");

  click(row(host, "d1"));
  await tick();
  assert.deepEqual(navigated, ["d1"]);
  click(q(host, '[data-dt-key="inspect:d1"]'));
  await tick();
  assert.deepEqual(inspected, ["d1"]);

  click(row(host, "d2"));
  await tick();
  assert.equal(
    q(host, '[data-dt-key="inspect:d2"]'),
    null,
    "a node with nowhere to inspect got an inspect button anyway",
  );
  handle.destroy();
});

test("no inspector integration means no inspect control, not a dead one", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  // The node says where it could be inspected; the consumer has supplied no inspector.
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots([
    {
      id: "d1",
      kind: "dataset",
      name: "one.zarr",
      path: "s3://b/one.zarr",
      inspect: "https://example.test/one.zarr",
    },
  ]);
  await until(() => rowNames(host).includes("one.zarr"), "roots");
  click(row(host, "d1"));
  await tick();
  assert.ok(q(host, ".dataset-tree__details"), "the panel did not open");
  assert.equal(q(host, '[data-dt-key="inspect:d1"]'), null);
  handle.destroy();
});

test("Collapse closes every branch and clears the filter in one move", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = snapshotTree(host);
  await until(() => rowNames(host).length === 3, "roots");
  click(row(host, "cat:reanalysis"));
  await until(() => rowNames(host).includes("surface"), "children");

  click(q(host, '[data-dt-key="collapse-all"]'));
  await tick();
  assert.deepEqual(rowNames(host), [
    "Global Reanalysis",
    "Regional Downscaling",
    "Scenario Ensemble",
  ]);
  handle.destroy();
});

test("a complete source is walked once at mount, and never asked again", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle, source } = snapshotTree(host);
  await until(() => rowNames(host).length === 3, "roots");
  await until(() => source.calls.includes("cat:reanalysis/surface"), "materialised");

  const after = [...source.calls];
  // Every expandable node, exactly once, breadth-first - and no duplicates.
  assert.equal(new Set(after).size, after.length, "the walk asked for a node twice");
  assert.ok(after.includes("cat:scenarios"));

  click(row(host, "cat:reanalysis"));
  await until(() => rowNames(host).includes("surface"), "opened");
  assert.deepEqual(source.calls, after, "opening a branch went back to a complete source");
  handle.destroy();
});

test("Expand all opens every branch in the snapshot; Collapse returns to the roots", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = snapshotTree(host);
  await until(() => rowNames(host).length === 3, "roots");

  const expand = q<HTMLButtonElement>(host, '[data-dt-key="expand-all"]');
  assert.ok(expand, "no Expand all control on a complete snapshot");
  assert.equal(expand.textContent, "Expand all");

  expand.focus();
  click(expand);
  await until(() => rowNames(host).includes("tas.zarr"), "expanded");
  assert.deepEqual(rowNames(host), [
    "Global Reanalysis",
    "surface",
    "tas.zarr",
    "README.md",
    "pressure-levels",
    "Regional Downscaling",
    "Scenario Ensemble",
    "ssp245.zarr",
    "ssp585.zarr",
  ]);
  // The toolbar keeps focus: a control that moves focus away from itself cannot be pressed twice.
  assert.equal(document.activeElement, expand, "Expand all lost focus to the tree");
  assert.equal(row(host, "cat:reanalysis")?.getAttribute("aria-expanded"), "true");

  const collapse = q<HTMLButtonElement>(host, '[data-dt-key="collapse-all"]');
  assert.equal(collapse?.textContent, "Collapse");
  collapse?.focus();
  click(collapse);
  await tick();
  assert.deepEqual(rowNames(host), [
    "Global Reanalysis",
    "Regional Downscaling",
    "Scenario Ensemble",
  ]);
  assert.equal(document.activeElement, collapse, "Collapse lost focus to the tree");
  assert.equal(row(host, "cat:reanalysis")?.getAttribute("aria-expanded"), "false");
  handle.destroy();
});

test("no toolbar offers Reload, and Collapse is the end of the row", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const snapshot = snapshotTree(host);
  await until(() => rowNames(host).length === 3, "roots");

  // `Reload` IS GONE FROM BOTH TOOLBARS, and this is what asserts it stays gone.
  //
  // Over a snapshot it never made sense: re-reading a catalogue baked into the same document
  // cannot produce different data, so the control's only observable effect was to redraw the page.
  // Over a lazy source it made a different kind of nonsense - it discarded every branch the reader
  // had opened, to answer a question they had not asked, from the position at the end of the row
  // where the eye goes looking for `Collapse`. Whichever source a portal used, the last control in
  // the toolbar meant something different.
  //
  // `reload()` stays on the handle, where a consumer that means it can call it.
  assert.equal(q(host, '[data-dt-key="reload"]'), null, "Reload is in the snapshot toolbar");
  const labels = qa(host, ".dataset-tree__bar .dataset-tree__btn").map((b) => b.textContent);
  assert.deepEqual(labels, ["Expand all", "Collapse"]);
  // The handle still has it: other source types need it, and so do tests.
  assert.equal(typeof snapshot.handle.reload, "function");
  snapshot.handle.destroy();
  resetDom();

  const second = makeHost();
  const lazy = lazyTree(second);
  await until(() => rowNames(second).length === 3, "lazy roots");
  assert.equal(q(second, '[data-dt-key="reload"]'), null, "Reload is in the lazy toolbar");
  assert.deepEqual(
    qa(second, ".dataset-tree__bar .dataset-tree__btn").map((b) => b.textContent),
    ["Collapse all"],
    "a lazy toolbar is one control now",
  );
  assert.equal(q(second, '[data-dt-key="expand-all"]'), null, "a lazy source offered Expand all");
  assert.equal(typeof lazy.handle.reload, "function");
  lazy.handle.destroy();
});

test("a host's own control stands in the toolbar, before Collapse", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const mine = document.createElement("button");
  mine.type = "button";
  mine.id = "host-control";
  mine.textContent = "Maximize";
  const { handle } = snapshotTree(host, { toolbarExtras: [mine] });
  await until(() => rowNames(host).length === 3, "roots");

  const bar = q(host, ".dataset-tree__bar");
  assert.ok(bar?.contains(mine), "the host's control is not in the toolbar");
  // The SAME NODE, not a copy. A consumer keeps a reference to a control whose label changes -
  // `Maximize` becomes `Exit full screen` - and a component that cloned it would leave them
  // updating an element nobody can see.
  assert.equal(q(host, "#host-control"), mine);
  const order = Array.from(bar?.children ?? []).map((child) =>
    child === mine ? "extra" : ((child as HTMLElement).dataset.dtKey ?? child.className),
  );
  assert.deepEqual(order.slice(1), ["extra", "expand-all", "collapse-all"]);

  // Destroy gives it back rather than deleting it. The component did not create this element and
  // has no business disposing of it; the consumer may well put it somewhere else.
  handle.destroy();
  assert.equal(mine.isConnected, false, "the extra was left inside a destroyed toolbar");
});

test("the row's own metadata is only what the source asked for", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = snapshotTree(host, {
    initialExpandedIds: ["cat:reanalysis", "cat:reanalysis/surface"],
  });
  await until(() => rowNames(host).includes("tas.zarr"), "deep");

  const line = q(
    host,
    '[data-dataset-tree-id="cat:reanalysis/surface/tas"] > .dataset-tree__rowline',
  );
  const text = line?.textContent ?? "";
  assert.match(text, /L7/, "the source's declared metric is missing");
  assert.match(text, /1\.4 GB/, "the size is missing");
  assert.doesNotMatch(text, /application\/vnd\.zarr/, "the media type is back on the row");
  assert.doesNotMatch(text, /2026-02-11/, "the modification time is back on the row");
  assert.equal(qa(host, ".dataset-tree__tag").length, 0, "the media-type tag still renders");

  // And the accessible name is the thing, not the thing plus its facts. Everything inside a button
  // becomes part of its name, so the metric and the size live beside the row rather than in it.
  const button = row(host, "cat:reanalysis/surface/tas");
  assert.equal(button?.getAttribute("aria-label"), "Show details for tas.zarr");
  assert.equal(button?.querySelector(".dataset-tree__size"), null);
  assert.equal(button?.querySelector(".dataset-tree__lvl"), null);
  handle.destroy();
});

test("a collection's project link is a real anchor beside its description", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = snapshotTree(host);
  await until(() => rowNames(host).length === 3, "roots");

  const line = q(host, '[data-dataset-tree-id="cat:reanalysis"] > .dataset-tree__rowline');
  const link = line?.querySelector<HTMLAnchorElement>(".dataset-tree__doclink");
  assert.ok(link, "the collection link is missing");
  assert.equal(link.getAttribute("href"), "https://example.test/reanalysis");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(link.getAttribute("aria-label"), "Project page");
  // It cannot be inside the row: a button may not contain a link, and a link inside one is neither.
  assert.equal(row(host, "cat:reanalysis")?.querySelector("a"), null);
  handle.destroy();
});
