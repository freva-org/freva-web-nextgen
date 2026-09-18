// Catalog validation: what it accepts, what it refuses, and whether the refusal is useful enough
// to act on. A validator that says "invalid" is a validator someone routes around.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DatasetTreeCatalogError,
  parseDatasetTreeCatalogV1,
  type DatasetTreeCatalog,
  type DatasetTreeCatalogNode,
} from "../src/snapshot.js";
import { emptyCatalog, hostileCatalog, sampleCatalog } from "./fixtures/catalog.js";

/** Run the parser and return the diagnostics, failing if it unexpectedly accepted the input. */
function refuse(input: unknown): ReturnType<typeof diagnosticsOf> {
  try {
    parseDatasetTreeCatalogV1(input);
  } catch (error) {
    assert.ok(error instanceof DatasetTreeCatalogError, `wrong error type: ${String(error)}`);
    return diagnosticsOf(error);
  }
  throw new assert.AssertionError({ message: "the parser accepted an invalid catalog" });
}

function diagnosticsOf(error: DatasetTreeCatalogError): {
  paths: string[];
  codes: string[];
  text: string;
} {
  return {
    paths: error.diagnostics.map((d) => d.path),
    codes: error.diagnostics.map((d) => d.code),
    text: error.message,
  };
}

test("a well-formed catalog parses, and keeps every value it was given", () => {
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.roots.length, 3);

  const reanalysis = catalog.roots[0];
  assert.equal(reanalysis.kind, "collection");
  assert.equal(reanalysis.title, "Global Reanalysis");
  const surface = reanalysis.children?.[0];
  const tas = surface?.children?.[0];
  assert.equal(tas?.size, 1_503_238_553);
  assert.equal(tas?.mediaType, "application/vnd.zarr");
  assert.equal(tas?.access?.length, 2);
  assert.deepEqual(tas?.metadata?.vars, ["tas", "tas_min", "tas_max"]);
});

test("the empty catalog is valid - a portal with nothing to show is not a broken portal", () => {
  const catalog = parseDatasetTreeCatalogV1(emptyCatalog());
  assert.deepEqual(catalog.roots, []);
});

test("`hasChildren` is derived from the declaration, not guessed from the kind", () => {
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  const reanalysis = catalog.roots[0];
  // Declared `children: []`: knowably empty, and still openable so the tree can say "Empty".
  const pressure = reanalysis.children?.[1];
  assert.equal(pressure?.name, "pressure-levels");
  assert.equal(pressure?.hasChildren, true);
  // An explicit `false` is honoured even on a collection.
  assert.equal(catalog.roots[1].hasChildren, false);
  // A dataset that declared nothing keeps `hasChildren` unset, so the view decides from the kind.
  const tas = reanalysis.children?.[0]?.children?.[0];
  assert.equal(tas?.hasChildren, undefined);
});

test("declared order is preserved exactly, and parsing twice gives the same order and ids", () => {
  const first = parseDatasetTreeCatalogV1(sampleCatalog());
  const second = parseDatasetTreeCatalogV1(sampleCatalog());
  const ids = (catalog: DatasetTreeCatalog): string[] => {
    const out: string[] = [];
    const walk = (list: readonly DatasetTreeCatalogNode[]): void => {
      for (const node of list) {
        out.push(node.id);
        if (node.children) walk(node.children);
      }
    };
    walk(catalog.roots);
    return out;
  };
  assert.deepEqual(ids(first), ids(second));
  assert.equal(ids(first).length, 9);
  assert.deepEqual(
    first.roots.map((r) => r.id),
    ["cat:reanalysis", "cat:downscaling", "cat:scenarios"],
  );
  // Not sorted: `scenarios` follows `downscaling` because the document says so.
  assert.notDeepEqual(
    first.roots.map((r) => r.id),
    [...first.roots.map((r) => r.id)].sort(),
  );
});

test("the parsed catalog is frozen, so a consumer cannot mutate the tree's own data", () => {
  const catalog = parseDatasetTreeCatalogV1(sampleCatalog());
  assert.throws(() => {
    (catalog.roots as unknown as unknown[]).push({});
  });
  assert.throws(() => {
    (catalog.roots[0] as unknown as { name: string }).name = "changed";
  });
});

test("a duplicate id is refused, and the diagnostic names both places", () => {
  const { codes, text } = refuse({
    schemaVersion: 1,
    roots: [
      { id: "same", kind: "collection", name: "a" },
      { id: "same", kind: "collection", name: "b" },
    ],
  });
  assert.ok(codes.includes("duplicate-id"), codes.join(","));
  assert.match(text, /duplicate id "same"/);
  assert.match(text, /first seen at \/roots\/0/);
});

test("a duplicate id nested deep in the tree is still caught", () => {
  const { paths } = refuse({
    schemaVersion: 1,
    roots: [
      {
        id: "a",
        kind: "collection",
        name: "a",
        children: [
          {
            id: "b",
            kind: "directory",
            name: "b",
            children: [{ id: "a", kind: "file", name: "c" }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(paths, ["/roots/0/children/0/children/0/id"]);
});

test("an unknown property is an error, never a silent drop", () => {
  const { paths, codes } = refuse({
    schemaVersion: 1,
    roots: [{ id: "a", kind: "collection", name: "a", titel: "typo" }],
  });
  assert.deepEqual(codes, ["unknown-property"]);
  assert.deepEqual(paths, ["/roots/0/titel"]);
});

test("an unknown property at the document level is caught too", () => {
  const { paths } = refuse({ schemaVersion: 1, roots: [], generated: "2026-01-01" });
  assert.deepEqual(paths, ["/generated"]);
});

test("an invalid kind names the value it got and the values it wanted", () => {
  const { paths, text } = refuse({
    schemaVersion: 1,
    roots: [{ id: "a", kind: "bucket", name: "a" }],
  });
  assert.deepEqual(paths, ["/roots/0/kind"]);
  assert.match(text, /collection, directory, dataset, file/);
  assert.match(text, /got "bucket"/);
});

test("every malformed value is reported in one pass, not one per run", () => {
  const { paths } = refuse({
    schemaVersion: 1,
    roots: [
      {
        id: "",
        kind: "collection",
        name: 42,
        size: -1,
        hasChildren: "yes",
        modifiedAt: 7,
        metadata: [],
        access: "no",
      },
    ],
  });
  // One diagnostic per problem, each pointing at its own value.
  for (const expected of [
    "/roots/0/id",
    "/roots/0/name",
    "/roots/0/size",
    "/roots/0/hasChildren",
    "/roots/0/modifiedAt",
    "/roots/0/metadata",
    "/roots/0/access",
  ]) {
    assert.ok(paths.includes(expected), `${expected} was not reported: ${paths.join(", ")}`);
  }
});

test("missing required members are named individually", () => {
  const { paths, codes } = refuse({ schemaVersion: 1, roots: [{}] });
  assert.deepEqual(paths.sort(), ["/roots/0/id", "/roots/0/kind", "/roots/0/name"]);
  assert.deepEqual(new Set(codes), new Set(["missing-property"]));
});

test("a wrong or missing schemaVersion is refused rather than assumed", () => {
  assert.match(refuse({ roots: [] }).text, /`schemaVersion` is required/);
  assert.match(refuse({ schemaVersion: 2, roots: [] }).text, /schemaVersion: 1.*got 2/s);
  assert.match(refuse({ schemaVersion: "1", roots: [] }).text, /got "1"/);
});

test("a non-object document, and a non-array roots, both fail cleanly", () => {
  for (const input of [null, 42, "catalog", [], undefined]) {
    assert.throws(() => parseDatasetTreeCatalogV1(input), DatasetTreeCatalogError);
  }
  assert.deepEqual(refuse({ schemaVersion: 1, roots: {} }).paths, ["/roots"]);
});

test("a JSON pointer stays usable when a key contains a slash or a tilde", () => {
  const { paths } = refuse({
    schemaVersion: 1,
    roots: [{ id: "a", kind: "collection", name: "a", metadata: {}, "we/ird~key": 1 }],
  });
  assert.deepEqual(paths, ["/roots/0/we~1ird~0key"]);
});

test("access entries are validated as closed objects with a required label", () => {
  const { paths, codes } = refuse({
    schemaVersion: 1,
    roots: [
      {
        id: "a",
        kind: "dataset",
        name: "a",
        access: [{ href: "https://example.test" }, { label: "x", protocol: "dap" }, "nope"],
      },
    ],
  });
  assert.ok(paths.includes("/roots/0/access/0/label"));
  assert.ok(paths.includes("/roots/0/access/1/protocol"));
  assert.ok(paths.includes("/roots/0/access/2"));
  assert.ok(codes.includes("not-an-object"));
});

test("hostile strings survive parsing untouched - escaping is the view's job, not the parser's", () => {
  // The parser must not sanitise: a value that arrives as markup should still arrive as markup, so
  // that the one place responsible for escaping it is the one place that renders it.
  const catalog = parseDatasetTreeCatalogV1(hostileCatalog());
  assert.equal(catalog.roots[0].name, "<img src=x onerror=alert(1)>");
  assert.equal(catalog.roots[0].path, "javascript:alert('path')");
});

test("a node's examples are parsed, closed, and identified", () => {
  const catalog = parseDatasetTreeCatalogV1({
    schemaVersion: 1,
    roots: [
      {
        id: "d1",
        kind: "dataset",
        name: "tas.zarr",
        examples: [
          {
            id: "py",
            label: "Python",
            language: "python",
            code: "import xarray as xr\n",
            description: "Open it",
            executable: true,
          },
          { id: "cli", label: "CLI", language: "shell", code: "ls" },
        ],
      },
    ],
  });
  const examples = catalog.roots[0]?.examples ?? [];
  assert.equal(examples.length, 2);
  assert.deepEqual(
    { ...examples[0] },
    {
      id: "py",
      label: "Python",
      language: "python",
      code: "import xarray as xr\n",
      description: "Open it",
      executable: true,
    },
  );
  // Absent means absent, not `false`: the property is not invented on the way through.
  assert.equal("executable" in examples[1], false);
  assert.equal("digest" in examples[0], false, "the parser invented a digest");
  assert.throws(() => Object.assign(examples[0] as object, { code: "x" }));
});

test("an example that could change meaning silently is a catalogue error", () => {
  const bad = (examples: unknown) => () =>
    parseDatasetTreeCatalogV1({
      schemaVersion: 1,
      roots: [{ id: "d1", kind: "dataset", name: "a", examples }],
    });

  // No id, no language: both are what stop a reordered or relabelled catalogue changing which
  // code a run button executes.
  assert.throws(bad([{ label: "P", language: "python", code: "x" }]));
  assert.throws(bad([{ id: "p", label: "P", code: "x" }]));
  // A digest is the build's to compute, so the catalogue format has nowhere to put one.
  assert.throws(bad([{ id: "p", label: "P", language: "python", code: "x", digest: "a" }]));
  // Two entries for one name means the node cannot say what that name is.
  assert.throws(
    bad([
      { id: "p", label: "P", language: "python", code: "x" },
      { id: "p", label: "Q", language: "python", code: "y" },
    ]),
    /twice/,
  );
  assert.throws(bad({}));
});
