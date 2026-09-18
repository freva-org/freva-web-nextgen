// Cancellation, staleness, reload, teardown and coexistence.
//
// These are the tests that matter when the component is embedded in something long-lived. A tree
// that leaks a listener, or renders a response belonging to a request the user walked away from,
// fails in production and never in a demo.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountDatasetTree } from "../src/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import { click, makeHost, q, qa, resetDom, rowNames, tick, until } from "./helpers.js";
import { manualSource, nodes } from "./sources.js";
import { sampleCatalog } from "./fixtures/catalog.js";
import type { DatasetTreeNode } from "../src/types.js";

function row(host: ParentNode, id: string): HTMLButtonElement | null {
  return q<HTMLButtonElement>(
    host,
    `[data-dataset-tree-id="${id}"] > .dataset-tree__rowline > .dataset-tree__row`,
  );
}

test("collapsing a branch aborts the request it started", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots(nodes("alpha"));
  await until(() => rowNames(host).includes("alpha"), "roots");

  click(row(host, "n:alpha"));
  await until(() => source.pending("n:alpha"), "request");
  const signal = source.signalFor("n:alpha");
  assert.equal(signal?.aborted, false);

  click(row(host, "n:alpha"));
  await tick();
  assert.equal(signal?.aborted, true, "collapsing left the request running");
  handle.destroy();
});

test("a response that arrives after its branch was collapsed is discarded", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots(nodes("alpha"));
  await until(() => rowNames(host).includes("alpha"), "roots");

  click(row(host, "n:alpha"));
  await until(() => source.pending("n:alpha"), "request");
  click(row(host, "n:alpha"));
  await tick();

  // The late answer to a question nobody is asking any more.
  source.resolveChildren("n:alpha", nodes("ghost"));
  await tick(5);
  assert.ok(!rowNames(host).includes("ghost"), "a stale response was rendered");
  handle.destroy();
});

test("a response from before a reload cannot overwrite the tree", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots(nodes("alpha"));
  await until(() => rowNames(host).includes("alpha"), "roots");

  click(row(host, "n:alpha"));
  await until(() => source.pending("n:alpha"), "request");

  const reloaded = handle.reload();
  source.resolveRoots(nodes("gamma"));
  await reloaded;
  await until(() => rowNames(host).includes("gamma"), "reloaded roots");

  // The pre-reload branch answers now. It belongs to a tree that no longer exists.
  source.resolveChildren("n:alpha", nodes("ghost"));
  await tick(5);
  assert.deepEqual(rowNames(host), ["gamma"], "a pre-reload response leaked into the new tree");
  handle.destroy();
});

test("reload discards loaded state and starts from the roots again", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const handle = mountDatasetTree(host, { source: createSnapshotSource(catalog) });
  await until(() => rowNames(host).length === 3, "roots");
  click(row(host, "cat:reanalysis"));
  await until(() => rowNames(host).includes("surface"), "children");

  await handle.reload();
  await until(() => rowNames(host).length === 3, "roots again");
  assert.ok(!rowNames(host).includes("surface"), "reload kept an expanded branch open");
  handle.destroy();
});

test("reload aborts everything in flight before it starts", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots(nodes("alpha", "beta"));
  await until(() => rowNames(host).includes("beta"), "roots");
  click(row(host, "n:alpha"));
  click(row(host, "n:beta"));
  await until(() => source.pending("n:alpha") && source.pending("n:beta"), "requests");
  const a = source.signalFor("n:alpha");
  const b = source.signalFor("n:beta");

  void handle.reload();
  await tick();
  assert.equal(a?.aborted, true);
  assert.equal(b?.aborted, true);
  handle.destroy();
});

test("destroy aborts in-flight work, removes the DOM, and leaves the document alone", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots(nodes("alpha"));
  await until(() => rowNames(host).includes("alpha"), "roots");
  click(row(host, "n:alpha"));
  await until(() => source.pending("n:alpha"), "request");
  const signal = source.signalFor("n:alpha");

  handle.destroy();
  assert.equal(signal?.aborted, true, "destroy left a request running");
  assert.equal(host.children.length, 0, "destroy left DOM behind");
  assert.equal(document.querySelector(".dataset-tree"), null);

  // A response arriving after teardown must not touch anything.
  source.resolveChildren("n:alpha", nodes("ghost"));
  await tick(5);
  assert.equal(host.children.length, 0);
});

test("destroy is idempotent, and the handle is inert afterwards", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  source.resolveRoots(nodes("alpha"));
  await until(() => rowNames(host).includes("alpha"), "roots");

  handle.destroy();
  handle.destroy();
  await handle.reload();
  assert.equal(host.children.length, 0, "reload after destroy re-mounted the component");
});

test("the component adds no document-level listeners while it lives", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const seen: string[] = [];
  const originalDoc = document.addEventListener.bind(document);
  const originalWin = window.addEventListener.bind(window);
  document.addEventListener = ((type: string, ...rest: unknown[]) => {
    seen.push(`document:${type}`);
    return (originalDoc as (...args: unknown[]) => void)(type, ...rest);
  }) as typeof document.addEventListener;
  window.addEventListener = ((type: string, ...rest: unknown[]) => {
    seen.push(`window:${type}`);
    return (originalWin as (...args: unknown[]) => void)(type, ...rest);
  }) as typeof window.addEventListener;

  try {
    const source = manualSource();
    const handle = mountDatasetTree(host, { source });
    source.resolveRoots(nodes("alpha"));
    await until(() => rowNames(host).includes("alpha"), "roots");
    click(row(host, "n:alpha"));
    await tick();
    handle.destroy();
  } finally {
    document.addEventListener = originalDoc as typeof document.addEventListener;
    window.addEventListener = originalWin as typeof window.addEventListener;
  }

  assert.deepEqual(seen, [], `document/window listeners were installed: ${seen.join(", ")}`);
});

test("two trees on one page keep their own state, ids and teardown", async (t) => {
  t.after(resetDom);
  const hostA = makeHost();
  const hostB = makeHost();
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const a = mountDatasetTree(hostA, { source: createSnapshotSource(catalog) });
  const b = mountDatasetTree(hostB, { source: createSnapshotSource(catalog) });
  await until(() => rowNames(hostA).length === 3 && rowNames(hostB).length === 3, "both roots");

  click(row(hostA, "cat:reanalysis"));
  await until(() => rowNames(hostA).includes("surface"), "A expanded");
  assert.ok(!rowNames(hostB).includes("surface"), "expanding one tree expanded the other");

  // Generated DOM ids must not collide, or `aria-controls` points into the wrong component.
  const idsA = qa(hostA, "[id]").map((n) => n.id);
  const idsB = qa(hostB, "[id]").map((n) => n.id);
  const shared = idsA.filter((id) => idsB.includes(id));
  assert.deepEqual(shared, [], `two instances minted the same ids: ${shared.join(", ")}`);

  a.destroy();
  assert.equal(hostA.children.length, 0);
  assert.equal(hostB.children.length, 1, "destroying one tree removed the other");
  b.destroy();
});

test("a source that repeats an id within one response cannot overwrite its own sibling", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const source = manualSource();
  const handle = mountDatasetTree(host, { source });
  const dupes: DatasetTreeNode[] = [
    { id: "same", kind: "file", name: "first" },
    { id: "same", kind: "file", name: "second" },
  ];
  source.resolveRoots(dupes);
  await until(() => rowNames(host).length > 0, "roots");
  assert.deepEqual(rowNames(host), ["first"], "a duplicate id displaced its sibling");
  handle.destroy();
});

test("mount refuses a missing host or a missing source rather than half-starting", () => {
  assert.throws(
    () => mountDatasetTree(null as unknown as HTMLElement, { source: manualSource() }),
    TypeError,
  );
  assert.throws(() => mountDatasetTree(makeHost(), {} as unknown as { source: never }), TypeError);
  resetDom();
});
