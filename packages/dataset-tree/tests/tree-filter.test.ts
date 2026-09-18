// Filtering.
//
// The filter is the component's most honest feature and its most easily-broken promise. Over a
// COMPLETE source it searches the whole archive - every name, every title, every path, including
// branches nobody has opened - and says nothing, because there is nothing to warn about. Over a
// LAZY source it searches what is loaded, says so on screen, and must never quietly reach for the
// network to make its results look better than they are. Both contracts are tested here.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mountDatasetTree } from "../src/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import { click, makeHost, q, resetDom, rowNames, tick, type, until } from "./helpers.js";
import { lazySource, recordingSource } from "./sources.js";
import { sampleCatalog } from "./fixtures/catalog.js";

function mount(host: HTMLElement) {
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const source = recordingSource(createSnapshotSource(catalog));
  // Zero debounce: the debounce is tested once, on its own, rather than slowing every case here.
  const handle = mountDatasetTree(host, { source, filterDebounceMs: 0 });
  return { handle, source };
}

/** The same catalogue behind a source that does NOT claim completeness. */
function mountLazy(host: HTMLElement) {
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const source = lazySource(createSnapshotSource(catalog));
  const handle = mountDatasetTree(host, { source, filterDebounceMs: 0 });
  return { handle, source };
}

function filterField(host: ParentNode): HTMLInputElement {
  const input = q<HTMLInputElement>(host, ".dataset-tree__filter-input");
  assert.ok(input, "no filter field");
  return input;
}

function row(host: ParentNode, id: string): HTMLButtonElement | null {
  return q<HTMLButtonElement>(
    host,
    `[data-dataset-tree-id="${id}"] > .dataset-tree__rowline > .dataset-tree__row`,
  );
}

test("the field says what it searches, and over a complete snapshot says nothing else", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");

  const input = filterField(host);
  assert.equal(input.getAttribute("aria-label"), "Filter datasets and paths\u2026");
  assert.equal(input.getAttribute("placeholder"), "Filter datasets and paths\u2026");

  // The caveat is not merely hidden here - it is not in the document, and the field does not
  // describe itself with it.
  //
  // "Only items already loaded are searched" is a true and useful warning about a lazy source and
  // a false statement about a snapshot that is already entirely in memory. Printing it over a
  // complete catalogue tells a visitor their results are partial when they are not, which is the
  // same class of dishonesty as the omission it was written to prevent - and a dangling
  // `aria-describedby` would say it to a screen reader even with the element off screen.
  assert.equal(q(host, ".dataset-tree__hint"), null, "the caveat is on a complete snapshot");
  assert.equal(input.getAttribute("aria-describedby"), null);

  type(input, "surface");
  await until(() => rowNames(host).includes("surface"), "filtered");
  assert.equal(q(host, ".dataset-tree__hint"), null, "the caveat appeared once filtering started");
  handle.destroy();
});

test("over a lazy source the caveat is present, described and shown with the filter", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mountLazy(host);
  await until(() => rowNames(host).length === 3, "roots");

  const input = filterField(host);
  const hint = q<HTMLElement>(host, ".dataset-tree__hint");
  assert.equal(
    hint?.textContent,
    "Only items already loaded are searched. Expand a branch to include it.",
  );
  assert.equal(input.getAttribute("aria-describedby"), hint?.id);
  assert.equal(hint?.hidden, true, "the caveat is on screen before anything is filtered");

  type(input, "surface");
  await until(() => hint?.hidden === false, "the caveat did not appear with the filter");

  type(input, "");
  await until(() => hint?.hidden === true, "the caveat stayed after the filter was cleared");
  handle.destroy();
});

// A rule that cannot match cannot be seen to be missing: a collection is the heading of its branch,
// and a selector that never matches leaves it drawn at exactly the weight and height of the
// directories inside it.
//
// `.dataset-tree__node--collection > .dataset-tree__row` is that selector: the row is wrapped in a
// `__rowline` so a details toggle can sit beside it without nesting one button in another. The test
// is against the STYLESHEET rather than against a computed style, because these tests run without a
// layout engine, and the selector is what is checkable here.
test("the collection rules address the row where the row actually is", () => {
  // Resolved from the package root, because these tests run from `dist-test/`.
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const css = readFileSync(resolve(pkg, "src", "styles.css"), "utf8");
  // Comments out, then whitespace collapsed: Prettier breaks a long selector over four lines, and
  // the shape being checked here is the selector, not its formatting.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  // The lookahead matters: `__rowline` starts with `__row`, and without it a correct rule matches
  // the pattern that describes the fault.
  const orphans = [
    ...rules.matchAll(/\.dataset-tree__node--[a-z]+ > \.dataset-tree__row(?![\w-])/g),
  ];
  assert.deepEqual(
    orphans.map((m) => m[0]),
    [],
    "a rule reaches for __row as a direct child of __node, which is never how it is rendered",
  );
  for (const needed of [
    ".dataset-tree__node--collection > .dataset-tree__rowline > .dataset-tree__row > .dataset-tree__name",
    ".dataset-tree__node--collection > .dataset-tree__rowline > .dataset-tree__row",
    ".dataset-tree__node--file > .dataset-tree__rowline > .dataset-tree__row .dataset-tree__name",
  ]) {
    assert.ok(rules.includes(needed), `the stylesheet lost ${needed}`);
  }
});

test("every selector in the stylesheet matches something a real tree renders", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");
  click(row(host, "cat:reanalysis"));
  await until(() => rowNames(host).includes("surface"), "children");

  // Not every selector - a stylesheet has states this fixture does not reach - but every one that
  // describes the resting shape of a loaded tree. These are the ones whose failure is silent.
  for (const selector of [
    ".dataset-tree__node--collection > .dataset-tree__rowline > .dataset-tree__row",
    ".dataset-tree__node--collection > .dataset-tree__rowline > .dataset-tree__row > .dataset-tree__name",
    ".dataset-tree__node--directory > .dataset-tree__rowline > .dataset-tree__row",
    ".dataset-tree__children > .dataset-tree__list > .dataset-tree__node",
  ]) {
    assert.ok(q(host, selector), `nothing in a loaded tree matches ${selector}`);
  }
  handle.destroy();
});

test("filtering narrows to matches and keeps their ancestors for context", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");
  click(row(host, "cat:reanalysis"));
  await until(() => rowNames(host).includes("surface"), "children");

  // `pressure-levels` is a name that appears in exactly one node and in no path.
  type(filterField(host), "pressure");
  await until(() => rowNames(host).length === 2, "filtered");
  // The match, plus the parent that gives it meaning. Nothing else.
  assert.deepEqual(rowNames(host), ["Global Reanalysis", "pressure-levels"]);
  handle.destroy();
});

test("a match one level down brings its whole ancestry, and only that", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");

  // `surface` is a directory name AND a segment of two paths under it, so all four rows are hits
  // or ancestors of hits - and the two other collections are neither.
  type(filterField(host), "surface");
  await until(() => rowNames(host).length === 4, "filtered");
  assert.deepEqual(rowNames(host), ["Global Reanalysis", "surface", "tas.zarr", "README.md"]);
  handle.destroy();
});

test("the matching text is marked, not the whole row, and not its ancestors", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");

  // `sur` is a fragment of one name, so what is marked has to be the fragment and not the label.
  // The two nodes below it match on their PATH, whose text is not on the row, so nothing in them
  // is marked either - a mark says "this is the text you searched for", not "this row is a result".
  type(filterField(host), "surf");
  await until(() => rowNames(host).length === 4, "filtered");
  const marks = Array.from(host.querySelectorAll(".dataset-tree__mark")).map((n) => n.textContent);
  assert.deepEqual(marks, ["surf"], "the mark is not the matched substring");
  // The ancestor is shown for context; it did not match, so nothing in it is marked.
  const ancestor = q(
    host,
    '[data-dataset-tree-id="cat:reanalysis"] > .dataset-tree__rowline .dataset-tree__mark',
  );
  assert.equal(ancestor, null, "an ancestor was marked as though it had matched");
  handle.destroy();
});

test("a filter hit is marked case-insensitively, keeping the archive's own casing", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");

  type(filterField(host), "GLOBAL REAN");
  await until(() => rowNames(host).length === 1, "filtered");
  assert.equal(q(host, ".dataset-tree__mark")?.textContent, "Global Rean");
  handle.destroy();
});

test("filtering matches the visible name, in either its `name` or `title` form", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");

  // `Global Reanalysis` is the title; `reanalysis` is the name. Both are things a visitor can read.
  type(filterField(host), "GLOBAL");
  await until(() => rowNames(host).length === 1, "title match");
  assert.deepEqual(rowNames(host), ["Global Reanalysis"]);

  // The node's `name` is `scenarios`; so is a segment of both children's paths, so all three show.
  type(filterField(host), "scenarios");
  await until(() => rowNames(host)[0] === "Scenario Ensemble", "name match");
  assert.deepEqual(rowNames(host), ["Scenario Ensemble", "ssp245.zarr", "ssp585.zarr"]);
  handle.destroy();
});

test("over a complete snapshot the filter reaches an unopened branch, and fetches nothing", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle, source } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");
  // The whole archive is walked once at mount; after that the source is never touched again.
  await until(() => source.calls.length > 1, "materialised");
  const before = [...source.calls];

  // `tas.zarr` is two levels below a branch nobody has opened. A visitor typing the name of a
  // dataset they know is there must not get "No loaded item matches tas": over a snapshot the
  // component has the answer in memory, so the code path has to tell a snapshot from a live bucket.
  type(filterField(host), "tas.zarr");
  await until(() => rowNames(host).includes("tas.zarr"), "deep match");
  assert.deepEqual(
    rowNames(host),
    ["Global Reanalysis", "surface", "tas.zarr"],
    "the match arrived without its ancestors",
  );
  assert.deepEqual(source.calls, before, "the filter went back to the source");
  handle.destroy();
});

test("the filter matches a path, which is what people paste", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");

  // Appears in no name and no title - only in `path`.
  type(filterField(host), "surface/tas");
  await until(() => rowNames(host).includes("tas.zarr"), "path match");
  assert.deepEqual(rowNames(host), ["Global Reanalysis", "surface", "tas.zarr"]);
  handle.destroy();
});

test("over a lazy source the filter still only searches what has been loaded", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle, source } = mountLazy(host);
  await until(() => rowNames(host).length === 3, "roots");
  const before = [...source.calls];

  type(filterField(host), "tas");
  await tick(4);
  assert.deepEqual(source.calls, before, "the filter went to the source");
  assert.ok(q(host, ".dataset-tree__msg--empty"), "no 'no matches' message");
  assert.match(q(host, ".dataset-tree__msg-text")?.textContent ?? "", /Nothing matches tas\./);
  handle.destroy();
});

test("a matched branch with no matching children does not claim to be empty", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");
  click(row(host, "cat:scenarios"));
  await until(() => rowNames(host).includes("ssp245.zarr"), "children");

  // Matches the collection's title and nothing beneath it - the children's paths say `scenarios`.
  type(filterField(host), "Scenario Ensemble");
  await until(() => rowNames(host).length === 1, "filtered");
  assert.deepEqual(rowNames(host), ["Scenario Ensemble"]);
  assert.equal(q(host, ".dataset-tree__msg--empty"), null, "a matched branch rendered as Empty");
  handle.destroy();
});

test("clearing the filter restores the expansion the visitor had before it", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");
  click(row(host, "cat:scenarios"));
  await until(() => rowNames(host).includes("ssp245.zarr"), "children");
  const before = rowNames(host);

  type(filterField(host), "ssp585");
  await until(() => rowNames(host).length === 2, "filtered");
  assert.deepEqual(rowNames(host), ["Scenario Ensemble", "ssp585.zarr"]);
  type(filterField(host), "");
  await until(() => rowNames(host).length === before.length, "restored");
  assert.deepEqual(rowNames(host), before, "clearing the filter lost the visitor's place");
  handle.destroy();
});

test("Escape clears the field", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = mount(host);
  await until(() => rowNames(host).length === 3, "roots");
  const input = filterField(host);
  type(input, "Scenario Ensemble");
  await until(() => rowNames(host).length === 1, "filtered");

  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => rowNames(host).length === 3, "cleared");
  assert.equal(input.value, "");
  handle.destroy();
});

test("keystrokes are debounced, so a long tree is not re-rendered per character", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const handle = mountDatasetTree(host, {
    source: createSnapshotSource(catalog),
    filterDebounceMs: 40,
  });
  await until(() => rowNames(host).length === 3, "roots");
  const input = filterField(host);

  type(input, "e");
  type(input, "en");
  type(input, "ensemble");
  // Still unfiltered immediately after the last keystroke.
  assert.equal(rowNames(host).length, 3, "the filter ran before its debounce elapsed");
  await until(() => rowNames(host).length === 1, "debounced filter");
  assert.deepEqual(rowNames(host), ["Scenario Ensemble"]);
  handle.destroy();
});
