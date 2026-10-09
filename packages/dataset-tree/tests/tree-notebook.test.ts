import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountDatasetTree } from "../src/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import { click, makeHost, q, resetDom, rowNames, until } from "./helpers.js";
import type { DatasetTreeNode } from "../src/types.js";

const CATALOG = {
  schemaVersion: 1,
  roots: [
    {
      id: "c1",
      kind: "collection",
      name: "Reanalysis",
      path: "s3://archive/reanalysis/",
      children: [
        { id: "d1", kind: "dataset", name: "tas.zarr", path: "s3://archive/reanalysis/tas.zarr" },
      ],
    },
  ],
};

function row(host: ParentNode, id: string): HTMLButtonElement | null {
  return q<HTMLButtonElement>(
    host,
    `[data-dataset-tree-id="${id}"] > .dataset-tree__rowline > .dataset-tree__row`,
  );
}

async function mount(onOpenNotebook?: (node: DatasetTreeNode) => void) {
  const host = makeHost();
  const handle = mountDatasetTree(host, {
    source: createSnapshotSource(parseDatasetTreeCatalogV1(CATALOG)),
    ...(onOpenNotebook ? { onOpenNotebook } : {}),
  });
  await until(() => rowNames(host).includes("Reanalysis"), "roots");
  click(row(host, "c1"));
  await until(() => rowNames(host).includes("tas.zarr"), "children");
  click(row(host, "d1"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");
  return { host, handle };
}

test("a dataset's panel offers Open in notebook, which hands over that node", async () => {
  resetDom();
  const opened: DatasetTreeNode[] = [];
  const { host, handle } = await mount((node) => opened.push(node));
  const button = q<HTMLButtonElement>(host, '[data-dt-key="notebook:d1"]');
  assert.ok(button);
  assert.equal(button.textContent, "Open in notebook");
  assert.equal(button.getAttribute("aria-label"), "Open tas.zarr in a notebook");
  click(button);
  assert.deepEqual(
    opened.map((n) => n.id),
    ["d1"],
  );
  handle.destroy();
});

test("without a host for it, or on a folder, there is no notebook button", async () => {
  resetDom();
  const { host, handle } = await mount();
  assert.equal(q(host, '[data-dt-key^="notebook:"]'), null);
  handle.destroy();
  resetDom();
  const opened: DatasetTreeNode[] = [];
  const again = await mount((node) => opened.push(node));
  assert.equal(q(again.host, '[data-dt-key="notebook:c1"]'), null);
  again.handle.destroy();
});

function stubScroll(): void {
  const proto = globalThis.HTMLElement.prototype as { scrollIntoView?: () => void };
  proto.scrollIntoView ??= () => undefined;
}

test("reveal opens the branches down to a node, selects it and draws it", async () => {
  resetDom();
  stubScroll();
  const host = makeHost();
  const handle = mountDatasetTree(host, {
    source: createSnapshotSource(parseDatasetTreeCatalogV1(CATALOG)),
  });
  assert.equal(await handle.reveal(["c1", "d1"]), true);
  await until(() => rowNames(host).includes("tas.zarr"), "revealed");
  assert.equal(await handle.reveal(["c1", "nope"]), false);
  handle.destroy();
});

test("reveal waits for a live branch to load", async () => {
  resetDom();
  stubScroll();
  const host = makeHost();
  const children: Record<string, { id: string; kind: "dataset"; name: string }[]> = {
    "s3://a/": [{ id: "s3://a/x.zarr/", kind: "dataset", name: "x.zarr" }],
  };
  const handle = mountDatasetTree(host, {
    source: {
      loadRoots: async () => [{ id: "s3://a/", kind: "collection", name: "a" }],
      loadChildren: async (node) => {
        await new Promise((done) => setTimeout(done, 20));
        return children[node.id] ?? [];
      },
    },
  });
  assert.equal(await handle.reveal(["s3://a/", "s3://a/x.zarr/"]), true);
  assert.ok(rowNames(host).includes("x.zarr"));
  handle.destroy();
});

test("a dataset with nothing else to show still gets a panel with the notebook button", async () => {
  resetDom();
  const host = makeHost();
  const handle = mountDatasetTree(host, {
    source: createSnapshotSource(
      parseDatasetTreeCatalogV1({
        schemaVersion: 1,
        roots: [{ id: "bare", kind: "dataset", name: "bare.zarr" }],
      }),
    ),
    onOpenNotebook: () => undefined,
  });
  await until(() => rowNames(host).includes("bare.zarr"), "roots");
  click(row(host, "bare"));
  await until(() => Boolean(q(host, '[data-dt-key="notebook:bare"]')), "notebook button");
  handle.destroy();
});
