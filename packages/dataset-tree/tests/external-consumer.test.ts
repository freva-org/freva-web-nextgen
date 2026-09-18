// EXTERNAL-CONSUMER TEST - the one file in this package that models a real deployment's data.
//
// The brief for this round says Waterpark-shaped fixtures belong in a separately labelled
// external-consumer test outside the published package, and this is it: `tests/` is not in the
// package's `files` list, so nothing here is published. Everything else in the suite uses the
// package's own synthetic fixtures.
//
// What it is for: the existing Grid Doctor deployment publishes a FLAT descriptive document - a
// list of bucket names plus a map of per-bucket title/label/link/locked - which is not a tree and
// carries no children, sizes or times. That is a good adversarial test of whether this package is
// really generic, because it is a shape the package was not designed around. The answer has to be
// "a consumer writes an adapter", not "the package grows a special case": nothing in `src/` knows
// this format exists.
//
// This asserts adaptability, not compatibility. It does NOT claim that this component is a drop-in
// replacement for that deployment's tree, and no such claim has been tested.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountDatasetTree } from "../src/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import type { DatasetTreeNode, DatasetTreeSource } from "../src/types.js";
import { click, makeHost, q, resetDom, rowNames, until } from "./helpers.js";

/**
 * The shape of a deployment's descriptive index: bucket names, plus a map keyed by bucket name.
 * Identity is the key, there is no nesting, and `locked` is the only availability signal.
 */
interface DeploymentIndex {
  buckets: string[];
  datasets: Record<
    string,
    { title?: string; label?: string; href?: string; locked?: boolean | string }
  >;
}

/** A deployment's own index, with placeholder names - no real archive is described here. */
const INDEX: DeploymentIndex = {
  buckets: ["alpha-reanalysis", "beta-observations", "gamma-simulations"],
  datasets: {
    "alpha-reanalysis": {
      title: "ALPHA",
      label: "Hourly reanalysis on a global grid",
      href: "https://example.test/alpha",
    },
    "beta-observations": { title: "Beta Observations", label: "Assorted observational products" },
    "gamma-simulations": { title: "GAMMA", label: "Flagship simulations", locked: "coming soon" },
  },
};

/**
 * The adapter a consumer writes. Thirty lines, in the consumer's own repository, using nothing but
 * the package's public types.
 */
function toCatalogV1(index: DeploymentIndex): unknown {
  return {
    schemaVersion: 1,
    roots: index.buckets.map((bucket) => {
      const entry = index.datasets[bucket] ?? {};
      const node: Record<string, unknown> = {
        // Identity is the bucket name, which is stable across builds and unique by definition.
        id: `s3://${bucket}/`,
        kind: "collection",
        name: bucket,
        path: `s3://${bucket}/`,
      };
      if (entry.title) node.title = entry.title;
      if (entry.label) node.description = entry.label;
      if (entry.href) node.access = [{ label: "Project page", href: entry.href }];
      if (entry.locked) {
        node.availability = "planned";
        node.availabilityNote = typeof entry.locked === "string" ? entry.locked : "coming soon";
        node.hasChildren = false;
      }
      return node;
    }),
  };
}

test("a flat deployment index adapts to the catalog format with no change to the package", () => {
  const catalog = parseDatasetTreeCatalogV1(toCatalogV1(INDEX));
  assert.equal(catalog.roots.length, 3);
  assert.deepEqual(
    catalog.roots.map((r) => r.id),
    ["s3://alpha-reanalysis/", "s3://beta-observations/", "s3://gamma-simulations/"],
  );
  assert.equal(catalog.roots[0].title, "ALPHA");
  assert.equal(catalog.roots[2].availability, "planned");
  assert.equal(catalog.roots[2].availabilityNote, "coming soon");
  assert.equal(catalog.roots[2].hasChildren, false);
});

test("the adapted index renders, including the locked entry's badge and the project link", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const catalog = parseDatasetTreeCatalogV1(toCatalogV1(INDEX));
  const handle = mountDatasetTree(host, { source: createSnapshotSource(catalog) });
  await until(() => rowNames(host).length === 3, "roots");

  assert.deepEqual(rowNames(host), ["ALPHA", "Beta Observations", "GAMMA"]);
  assert.equal(q(host, ".dataset-tree__badge")?.textContent, "coming soon");

  click(q(host, '[data-dt-key="info:s3://alpha-reanalysis/"]'));
  await until(() => Boolean(q(host, ".dataset-tree__infocard")), "info card");
  const link = q<HTMLAnchorElement>(host, ".dataset-tree__infocard a");
  assert.equal(link?.getAttribute("href"), "https://example.test/alpha");
  handle.destroy();
});

test("a locked entry cannot be opened, and an unlocked one can", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const catalog = parseDatasetTreeCatalogV1(toCatalogV1(INDEX));

  // A hybrid source: descriptions from the flat index, children from wherever the deployment
  // actually lists them. This is the arrangement a live portal would use.
  const listed: string[] = [];
  const source: DatasetTreeSource = {
    loadRoots: (context) => createSnapshotSource(catalog).loadRoots(context),
    loadChildren: (node): Promise<readonly DatasetTreeNode[]> => {
      listed.push(node.id);
      return Promise.resolve([
        { id: `${node.id}surface/`, kind: "directory", name: "surface", hasChildren: true },
      ]);
    },
  };
  const handle = mountDatasetTree(host, { source });
  await until(() => rowNames(host).length === 3, "roots");

  // The planned bucket declares `hasChildren: false`, so there is no control to press.
  assert.equal(
    q(host, '[data-dt-key="toggle:s3://gamma-simulations/"]'),
    null,
    "a planned collection offered a way in",
  );
  click(q(host, '[data-dt-key="toggle:s3://alpha-reanalysis/"]'));
  await until(() => rowNames(host).includes("surface"), "children");
  assert.deepEqual(listed, ["s3://alpha-reanalysis/"]);
  handle.destroy();
});

test("the package itself knows nothing about this format", async () => {
  // The adapter above lives in this test file. If any of these appeared in `src/`, the package
  // would have quietly acquired a deployment-specific special case.
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join, resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

  const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".css"),
  );
  for (const file of files) {
    const source = readFileSync(join(srcDir, file), "utf8").toLowerCase();
    for (const term of [
      "waterpark",
      "griddoctor",
      "grid-doctor",
      "healpix",
      "coming soon",
      "no data yet",
    ]) {
      assert.ok(!source.includes(term), `src/${file} mentions ${term}`);
    }
    // `buckets`/`datasets` as a top-level format is this deployment's, not the package's.
    assert.ok(!/["']buckets["']\s*:/.test(source), `src/${file} knows a bucket index format`);
  }
});
