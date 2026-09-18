// Searching an optional index.
//
// The feature's whole claim is a negative one: a search over a lazily-listed object store may cover
// objects nobody has opened, WITHOUT the component listing the store because somebody typed a
// letter. So the load-bearing assertions here are about what does not happen - no source call, no
// node written into the browsing tree, no expansion state disturbed - and the visible results are
// what proves the negative was worth having.
//
// The other half is that a consumer who supplies no index gets exactly what they had before.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountDatasetTree } from "../src/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import { parseDatasetTreeSearchIndexV1 } from "../src/search-index.js";
import { click, makeHost, q, qa, resetDom, rowNames, tick, type, until } from "./helpers.js";
import { lazySource, recordingSource } from "./sources.js";
import { sampleCatalog } from "./fixtures/catalog.js";
import { completeIndex, hostileIndex, largeIndex, partialIndex } from "./fixtures/search-index.js";
import type { DatasetTreeOptions, DatasetTreeSearchIndex } from "../src/types.js";

function catalog() {
  return parseDatasetTreeCatalogV1(sampleCatalog());
}

/** A lazy source over the sample catalogue, with an optional index. */
function mountLazy(
  host: HTMLElement,
  index?: DatasetTreeSearchIndex,
  extra?: Partial<DatasetTreeOptions>,
) {
  const source = lazySource(createSnapshotSource(catalog()));
  const handle = mountDatasetTree(host, {
    source,
    filterDebounceMs: 0,
    ...(index ? { searchIndex: index } : {}),
    ...extra,
  });
  return { handle, source };
}

/** The same catalogue behind a source that DOES claim completeness. */
function mountComplete(host: HTMLElement, index?: DatasetTreeSearchIndex) {
  const source = recordingSource(createSnapshotSource(catalog()));
  const handle = mountDatasetTree(host, {
    source,
    filterDebounceMs: 0,
    ...(index ? { searchIndex: index } : {}),
  });
  return { handle, source };
}

function field(host: ParentNode): HTMLInputElement {
  const input = q<HTMLInputElement>(host, ".dataset-tree__filter-input");
  assert.ok(input, "no filter field");
  return input;
}

function resultIds(host: ParentNode): string[] {
  return qa(host, ".dataset-tree__node--result").map(
    (li) => (li as HTMLElement).dataset.datasetTreeId ?? "",
  );
}

function hintText(host: ParentNode): string {
  return q(host, ".dataset-tree__hint")?.textContent ?? "";
}

function liveText(host: ParentNode): string {
  return q(host, ".dataset-tree__sr[role=status]")?.textContent ?? "";
}

// no index

test("without an index a lazy source behaves exactly as it did: loaded only, and says so", async () => {
  const host = makeHost();
  const { handle, source } = mountLazy(host);
  await until(() => rowNames(host).length > 0, "roots");
  const before = source.calls.length;

  type(field(host), "tas");
  await tick();

  // No result list at all - this is the tree, filtered.
  assert.equal(qa(host, ".dataset-tree__node--result").length, 0);
  assert.equal(source.calls.length, before, "filtering called the source");
  assert.match(hintText(host), /Only items already loaded are searched/);
  assert.equal(q(host, ".dataset-tree__hint")?.hasAttribute("hidden"), false);

  // `tas.zarr` is two branches down and nobody opened them, so it is not found.
  assert.equal(
    rowNames(host).some((n) => n.includes("tas.zarr")),
    false,
  );
  handle.destroy();
  resetDom();
});

test("without an index the loaded-only caveat is still what the field points at", async () => {
  const host = makeHost();
  const { handle } = mountLazy(host);
  await until(() => rowNames(host).length > 0, "roots");
  const input = field(host);
  assert.equal(input.getAttribute("placeholder"), "Filter datasets and paths…");
  assert.ok(input.getAttribute("aria-describedby"));
  handle.destroy();
  resetDom();
});

// with an index

test("a complete index finds an object no branch has ever been opened for", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(completeIndex());
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");

  type(field(host), "tasmax");
  await tick();

  assert.deepEqual(resultIds(host), ["idx:downscaling/eur-11/tasmax.zarr"]);
  handle.destroy();
  resetDom();
});

test("searching an index makes no source call whatsoever", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(completeIndex());
  const { handle, source } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");
  const before = source.calls.length;

  for (const query of ["t", "ta", "tas", "tasmax", "downscaling", "example://", "zarr"]) {
    type(field(host), query);
    await tick();
  }

  assert.equal(source.calls.length, before, `the source was called: ${source.calls.join(", ")}`);
  handle.destroy();
  resetDom();
});

test("an index result never enters the browsing tree, and clearing restores it exactly", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(completeIndex());
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");

  // Open a branch, so there is real expansion state to lose.
  click(q(host, '[data-dataset-tree-id="cat:reanalysis"] .dataset-tree__row'));
  await until(() => rowNames(host).some((n) => n === "surface"), "expanded branch");
  const expanded = rowNames(host);

  type(field(host), "downscaling");
  await tick();
  assert.ok(resultIds(host).includes("idx:downscaling"));

  type(field(host), "");
  await tick();
  assert.deepEqual(rowNames(host), expanded, "expansion state was not restored");
  // And nothing from the index is in the tree.
  assert.equal(q(host, '[data-dataset-tree-id="idx:downscaling"]'), null);
  handle.destroy();
  resetDom();
});

test("Escape clears the search and restores the tree", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(completeIndex());
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");
  const before = rowNames(host);

  const input = field(host);
  type(input, "downscaling");
  await tick();
  assert.ok(resultIds(host).length > 0);

  input.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await tick();
  assert.equal(input.value, "");
  assert.deepEqual(rowNames(host), before);
  handle.destroy();
  resetDom();
});

test("name, title, path and case are all matched", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(completeIndex());
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");
  const input = field(host);

  // by name
  type(input, "pr.zarr");
  await tick();
  assert.ok(resultIds(host).includes("idx:reanalysis/surface/pr.zarr"));

  // by title, in the wrong case
  type(input, "PRECIPITATION");
  await tick();
  assert.deepEqual(resultIds(host), ["idx:reanalysis/surface/pr.zarr"]);

  // by path segment
  type(input, "eur-11");
  await tick();
  assert.deepEqual(resultIds(host), ["idx:downscaling/eur-11/tasmax.zarr"]);

  handle.destroy();
  resetDom();
});

test("ranking is deterministic: exact name, prefix, exact segment, title, substring", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1({
    schemaVersion: 1,
    complete: true,
    entries: [
      { id: "e:sub", kind: "file", name: "zzz_alpha_zzz", path: "p/zzz_alpha_zzz" },
      { id: "e:title", kind: "file", name: "zzz2", title: "An alpha thing", path: "p/zzz2" },
      { id: "e:segment", kind: "file", name: "zzz3", path: "p/alpha/zzz3" },
      { id: "e:prefix", kind: "file", name: "alphabet", path: "p/alphabet" },
      { id: "e:exact", kind: "file", name: "alpha", path: "p/alpha-exact" },
    ],
  });
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");

  type(field(host), "alpha");
  await tick();
  assert.deepEqual(resultIds(host), ["e:exact", "e:prefix", "e:segment", "e:title", "e:sub"]);
  handle.destroy();
  resetDom();
});

test("ties break on path, then name, then id - stably, and not by declaration order", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1({
    schemaVersion: 1,
    complete: true,
    entries: [
      { id: "t:3", kind: "file", name: "beta_c", path: "z/beta_c" },
      { id: "t:1", kind: "file", name: "beta_a", path: "a/beta_a" },
      { id: "t:2", kind: "file", name: "beta_b", path: "m/beta_b" },
    ],
  });
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");
  type(field(host), "beta");
  await tick();
  assert.deepEqual(resultIds(host), ["t:1", "t:2", "t:3"]);
  handle.destroy();
  resetDom();
});

test("a loaded node and an index entry with one id produce one result, with the loaded data", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(completeIndex());
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");

  // Load the branch that holds `cat:reanalysis/surface/tas`, so both sides know it.
  click(q(host, '[data-dataset-tree-id="cat:reanalysis"] .dataset-tree__row'));
  await until(() => rowNames(host).includes("surface"), "surface");
  click(q(host, '[data-dataset-tree-id="cat:reanalysis/surface"] .dataset-tree__row'));
  await until(() => rowNames(host).some((n) => n.includes("tas.zarr")), "tas.zarr");

  type(field(host), "tas.zarr");
  await tick();

  const ids = resultIds(host);
  assert.equal(ids.filter((id) => id === "cat:reanalysis/surface/tas").length, 1, "duplicated");
  const row = q(host, '[data-dataset-tree-id="cat:reanalysis/surface/tas"]');
  assert.ok(row);
  assert.equal((row as HTMLElement).dataset.dtResult, "loaded");
  // The loaded node carries a size; the index entry for the same id does not.
  assert.match(row.textContent ?? "", /1\.4 GB/);
  handle.destroy();
  resetDom();
});

test("a loaded node the index does not know is still found", async () => {
  const host = makeHost();
  // An index that covers only the downscaling side of the archive.
  const index = parseDatasetTreeSearchIndexV1(partialIndex());
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");

  type(field(host), "reanalysis");
  await tick();
  assert.ok(
    resultIds(host).includes("cat:reanalysis"),
    `loaded root missing from results: ${resultIds(host).join(", ")}`,
  );
  handle.destroy();
  resetDom();
});

// honesty

test("a complete index drops the loaded-only claim and states the reach and the date", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(completeIndex());
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");

  type(field(host), "tas");
  await tick();

  const text = hintText(host);
  assert.match(text, /The whole indexed archive is searched/);
  assert.doesNotMatch(text, /Only items already loaded/);
  // The generation time as the index stated it, formatted, never invented.
  assert.match(text, /Index generated 2026-02-01 00:00 UTC/);
  assert.equal(field(host).getAttribute("placeholder"), "Search datasets and paths…");
  handle.destroy();
  resetDom();
});

test("a partial index keeps an honest caveat, and states no date when it has none", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(partialIndex());
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");

  type(field(host), "tasmax");
  await tick();

  const text = hintText(host);
  assert.match(text, /may not cover everything/);
  assert.doesNotMatch(text, /Index generated/);
  handle.destroy();
  resetDom();
});

test("the live region reports search counts and the empty state", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(completeIndex());
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");

  type(field(host), "tasmax");
  await tick();
  assert.match(liveText(host), /1 results for tasmax\./);

  type(field(host), "nothing-matches-this");
  await tick();
  assert.match(liveText(host), /0 results for/);
  assert.match(q(host, ".dataset-tree__msg--empty")?.textContent ?? "", /Nothing matches/);

  type(field(host), "");
  await tick();
  assert.match(liveText(host), /Filter cleared\./);
  handle.destroy();
  resetDom();
});

// complete sources

test("a complete source keeps its whole-catalog filter, and an index changes nothing", async () => {
  const host = makeHost();
  const withIndex = makeHost();
  const plain = mountComplete(host);
  const indexed = mountComplete(withIndex, parseDatasetTreeSearchIndexV1(completeIndex()));
  await until(() => rowNames(host).length > 0, "roots");
  await until(() => rowNames(withIndex).length > 0, "roots");

  type(field(host), "tas");
  type(field(withIndex), "tas");
  await tick();

  // The same tree, filtered the same way - not a result list.
  assert.deepEqual(rowNames(withIndex), rowNames(host));
  assert.equal(qa(withIndex, ".dataset-tree__node--result").length, 0);
  // And no caveat, because none is true of a complete source.
  assert.equal(q(withIndex, ".dataset-tree__hint"), null);
  plain.handle.destroy();
  indexed.handle.destroy();
  resetDom();
});

// safety

test("hostile index text becomes text, and a `javascript:` path never becomes a link", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(hostileIndex());
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");

  type(field(host), "zarr");
  await tick();

  const item = q(host, '[data-dataset-tree-id="hostile:1"]');
  assert.ok(item, "the hostile entry did not render");
  assert.equal(item.querySelector("img"), null);
  assert.equal(item.querySelector("script"), null);
  assert.equal(item.querySelector("svg[onload]"), null);
  assert.match(item.textContent ?? "", /<img src=x onerror=alert\(1\)>\.zarr/);

  // Open its detail panel: the path is shown as a literal, and nothing in the component links it.
  click(item.querySelector(".dataset-tree__row"));
  await tick();
  for (const anchor of qa<HTMLAnchorElement>(host, "a[href]")) {
    assert.doesNotMatch(anchor.getAttribute("href") ?? "", /^javascript:/i);
  }
  handle.destroy();
  resetDom();
});

test("a hostile ancestor name renders as a breadcrumb of text", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(hostileIndex());
  const { handle } = mountLazy(host, index);
  await until(() => rowNames(host).length > 0, "roots");
  type(field(host), "zarr");
  await tick();

  const trail = q(host, '[data-dataset-tree-id="hostile:1"] .dataset-tree__trail');
  assert.ok(trail, "no breadcrumb");
  assert.equal(trail.querySelector("*"), null, "the breadcrumb contains elements");
  assert.match(trail.textContent ?? "", /svg onload=alert\(4\)/);
  handle.destroy();
  resetDom();
});

// scale

test("a large index renders a capped list and reports the true total", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(largeIndex(50_000));
  const { handle } = mountLazy(host, index, { searchResultLimit: 25 });
  await until(() => rowNames(host).length > 0, "roots");

  type(field(host), "zarr");
  await tick();

  const rendered = qa(host, ".dataset-tree__node--result").length;
  assert.equal(rendered, 25, `rendered ${rendered} rows for a 50,000-entry match`);
  const header = q(host, ".dataset-tree__results")?.textContent ?? "";
  assert.match(header, /Showing the first 25 of 50000 results\./);
  handle.destroy();
  resetDom();
});

test("searching a large index stays well inside a keystroke's budget", async () => {
  const host = makeHost();
  const index = parseDatasetTreeSearchIndexV1(largeIndex(50_000));
  const { handle } = mountLazy(host, index, { searchResultLimit: 50 });
  await until(() => rowNames(host).length > 0, "roots");
  const input = field(host);

  // A generous, deliberately non-flaky threshold.
  //
  // The number being defended is not "fast" - it is "not quadratic, and not re-normalising the
  // index on every keystroke". Eight queries over 50,000 entries with the strings already
  // lowercased is a few million character comparisons; rebuilding the haystacks each time is two
  // orders of magnitude more, and would not fit in this budget on any machine. A CI box under
  // load will still pass it.
  const started = Date.now();
  for (const query of ["v", "va", "var", "var1", "var12", "var123", "proj", "zarr"]) {
    type(input, query);
    await tick(1);
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8000, `eight searches over 50,000 entries took ${elapsed}ms`);
  handle.destroy();
  resetDom();
});
