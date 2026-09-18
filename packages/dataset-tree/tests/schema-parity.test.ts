// The published JSON Schema and the hand-written parser must agree.
//
// Two validators for one format is a liability unless something keeps them honest: the schema is
// what build tooling and editors validate against, the parser is what the browser actually runs,
// and a portal whose build passes and whose page then refuses the same file is the worst of both.
//
// Ajv is a devDependency here and only here. The shipped package validates with the parser alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import { parseDatasetTreeSearchIndexV1 } from "../src/search-index.js";
import { emptyCatalog, hostileCatalog, sampleCatalog } from "./fixtures/catalog.js";
import { completeIndex, hostileIndex, partialIndex } from "./fixtures/search-index.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schema = JSON.parse(
  readFileSync(join(PKG, "schema", "dataset-tree-catalog-v1.schema.json"), "utf8"),
) as object;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

function parserAccepts(input: unknown): boolean {
  try {
    parseDatasetTreeCatalogV1(input);
    return true;
  } catch {
    return false;
  }
}

/** Documents both validators must accept. */
const VALID: [string, unknown][] = [
  ["the sample catalog", sampleCatalog()],
  ["the empty catalog", emptyCatalog()],
  ["hostile strings, which are valid data", hostileCatalog()],
  ["a minimal node", { schemaVersion: 1, roots: [{ id: "a", kind: "file", name: "a" }] }],
  [
    "every optional member at once",
    {
      schemaVersion: 1,
      roots: [
        {
          id: "a",
          kind: "dataset",
          name: "a",
          title: "A",
          path: "s3://b/a",
          description: "d",
          hasChildren: false,
          size: 0,
          mediaType: "application/x-netcdf",
          modifiedAt: "2026-01-01T00:00:00Z",
          availability: "restricted",
          availabilityNote: "on request",
          access: [{ label: "L", href: "https://x.test", value: "v", description: "d" }],
          examples: [
            {
              id: "py",
              label: "Python",
              language: "python",
              code: "print(1)",
              description: "d",
              executable: true,
            },
            { id: "cli", label: "CLI", language: "shell", code: "ls" },
          ],
          metadata: { anything: { at: "all" } },
          children: [],
        },
      ],
    },
  ],
];

/** Documents both validators must refuse. */
const INVALID: [string, unknown][] = [
  ["a non-object", 42],
  ["a missing schemaVersion", { roots: [] }],
  ["a future schemaVersion", { schemaVersion: 2, roots: [] }],
  ["a string schemaVersion", { schemaVersion: "1", roots: [] }],
  ["missing roots", { schemaVersion: 1 }],
  ["roots as an object", { schemaVersion: 1, roots: {} }],
  ["an unknown document property", { schemaVersion: 1, roots: [], extra: 1 }],
  [
    "an unknown node property",
    { schemaVersion: 1, roots: [{ id: "a", kind: "file", name: "a", x: 1 }] },
  ],
  ["a missing id", { schemaVersion: 1, roots: [{ kind: "file", name: "a" }] }],
  ["an empty id", { schemaVersion: 1, roots: [{ id: "", kind: "file", name: "a" }] }],
  ["an empty name", { schemaVersion: 1, roots: [{ id: "a", kind: "file", name: "" }] }],
  ["an unknown kind", { schemaVersion: 1, roots: [{ id: "a", kind: "bucket", name: "a" }] }],
  [
    "a negative size",
    { schemaVersion: 1, roots: [{ id: "a", kind: "file", name: "a", size: -1 }] },
  ],
  [
    "a non-numeric size",
    { schemaVersion: 1, roots: [{ id: "a", kind: "file", name: "a", size: "1" }] },
  ],
  [
    "a non-boolean hasChildren",
    { schemaVersion: 1, roots: [{ id: "a", kind: "file", name: "a", hasChildren: "yes" }] },
  ],
  [
    "an unknown availability",
    { schemaVersion: 1, roots: [{ id: "a", kind: "file", name: "a", availability: "maybe" }] },
  ],
  [
    "metadata as an array",
    { schemaVersion: 1, roots: [{ id: "a", kind: "file", name: "a", metadata: [] }] },
  ],
  [
    "an example without an id",
    {
      schemaVersion: 1,
      roots: [
        {
          id: "a",
          kind: "file",
          name: "a",
          examples: [{ label: "Python", language: "python", code: "print(1)" }],
        },
      ],
    },
  ],
  [
    "an example without a language, which is what decides whether it may run",
    {
      schemaVersion: 1,
      roots: [
        { id: "a", kind: "file", name: "a", examples: [{ id: "p", label: "P", code: "print(1)" }] },
      ],
    },
  ],
  [
    "an example carrying a digest, which a catalogue author cannot have computed",
    {
      schemaVersion: 1,
      roots: [
        {
          id: "a",
          kind: "file",
          name: "a",
          examples: [
            {
              id: "p",
              label: "P",
              language: "python",
              code: "print(1)",
              digest: "a".repeat(64),
            },
          ],
        },
      ],
    },
  ],
  [
    "examples as an object",
    { schemaVersion: 1, roots: [{ id: "a", kind: "file", name: "a", examples: {} }] },
  ],
  [
    "an access entry without a label",
    {
      schemaVersion: 1,
      roots: [{ id: "a", kind: "file", name: "a", access: [{ href: "https://x.test" }] }],
    },
  ],
  [
    "an unknown access property",
    {
      schemaVersion: 1,
      roots: [{ id: "a", kind: "file", name: "a", access: [{ label: "L", proto: "x" }] }],
    },
  ],
  [
    "a malformed nested child",
    {
      schemaVersion: 1,
      roots: [{ id: "a", kind: "directory", name: "a", children: [{ id: "b" }] }],
    },
  ],
];

test("the shipped schema itself compiles under strict Ajv", () => {
  assert.equal(typeof validate, "function");
});

test("both validators accept every valid document", () => {
  for (const [what, input] of VALID) {
    assert.ok(validate(input), `the schema refused ${what}: ${ajv.errorsText(validate.errors)}`);
    assert.ok(parserAccepts(input), `the parser refused ${what}`);
  }
});

test("both validators refuse every invalid document", () => {
  for (const [what, input] of INVALID) {
    assert.equal(validate(input), false, `the schema accepted ${what}`);
    assert.equal(parserAccepts(input), false, `the parser accepted ${what}`);
  }
});

test("the one rule the schema cannot express is enforced by the parser", () => {
  // JSON Schema has no way to say "unique across the whole document", so uniqueness is the parser's
  // job alone. Stating it here keeps the gap deliberate rather than accidental.
  const duplicates = {
    schemaVersion: 1,
    roots: [
      { id: "same", kind: "file", name: "a" },
      { id: "same", kind: "file", name: "b" },
    ],
  };
  assert.ok(validate(duplicates), "the schema unexpectedly catches duplicate ids");
  assert.equal(parserAccepts(duplicates), false, "the parser must catch what the schema cannot");
});

test("the schema is closed everywhere a node can appear", () => {
  const text = readFileSync(join(PKG, "schema", "dataset-tree-catalog-v1.schema.json"), "utf8");
  const document = JSON.parse(text) as {
    additionalProperties: boolean;
    $defs: Record<string, { additionalProperties?: boolean; properties?: Record<string, unknown> }>;
  };
  assert.equal(document.additionalProperties, false);
  assert.equal(document.$defs.node.additionalProperties, false);
  assert.equal(document.$defs.access.additionalProperties, false);
  // `metadata` is the one deliberately open object: it carries whatever a source knows.
  const metadata = document.$defs.node.properties?.metadata as { additionalProperties?: boolean };
  assert.equal(metadata.additionalProperties, true);
});

// the search index
//
// The same discipline for the second format. Two validators for one format is a liability unless
// something keeps them honest, and an index is generated by tooling that validates against the
// schema and then read by a browser that validates with the parser - the exact gap where a build
// passes and the page then refuses the file it was handed.

const searchSchema = JSON.parse(
  readFileSync(join(PKG, "schema", "dataset-tree-search-index-v1.schema.json"), "utf8"),
) as object;
const validateSearch = ajv.compile(searchSchema);

function searchParserAccepts(input: unknown): boolean {
  try {
    parseDatasetTreeSearchIndexV1(input);
    return true;
  } catch {
    return false;
  }
}

const SEARCH_VALID: [string, unknown][] = [
  ["the complete index", completeIndex()],
  ["the partial index", partialIndex()],
  ["hostile strings, which are valid data", hostileIndex()],
  ["an empty index", { schemaVersion: 1, complete: false, entries: [] }],
  [
    "a minimal entry",
    { schemaVersion: 1, complete: true, entries: [{ id: "a", kind: "file", name: "a" }] },
  ],
  [
    "every optional member at once",
    {
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00Z",
      source: "https://example.test",
      complete: true,
      entries: [
        {
          id: "a",
          kind: "dataset",
          name: "a.zarr",
          title: "A",
          path: "s3://b/a.zarr",
          size: 0,
          modifiedAt: "2026-01-01T00:00:00Z",
          ancestors: [{ id: "r", name: "r", title: "R", path: "s3://b" }],
        },
      ],
    },
  ],
];

const SEARCH_INVALID: [string, unknown][] = [
  ["a non-object", 42],
  ["a missing schemaVersion", { complete: true, entries: [] }],
  ["a future schemaVersion", { schemaVersion: 2, complete: true, entries: [] }],
  ["a string schemaVersion", { schemaVersion: "1", complete: true, entries: [] }],
  ["a missing complete", { schemaVersion: 1, entries: [] }],
  ["a non-boolean complete", { schemaVersion: 1, complete: "yes", entries: [] }],
  ["missing entries", { schemaVersion: 1, complete: true }],
  ["entries as an object", { schemaVersion: 1, complete: true, entries: {} }],
  ["an unknown document property", { schemaVersion: 1, complete: true, entries: [], extra: 1 }],
  [
    "an unknown entry property",
    { schemaVersion: 1, complete: true, entries: [{ id: "a", kind: "file", name: "a", x: 1 }] },
  ],
  ["a missing id", { schemaVersion: 1, complete: true, entries: [{ kind: "file", name: "a" }] }],
  [
    "an empty id",
    { schemaVersion: 1, complete: true, entries: [{ id: "", kind: "file", name: "a" }] },
  ],
  [
    "an empty name",
    { schemaVersion: 1, complete: true, entries: [{ id: "a", kind: "file", name: "" }] },
  ],
  [
    "an unknown kind",
    { schemaVersion: 1, complete: true, entries: [{ id: "a", kind: "bucket", name: "a" }] },
  ],
  [
    "a negative size",
    { schemaVersion: 1, complete: true, entries: [{ id: "a", kind: "file", name: "a", size: -1 }] },
  ],
  [
    "a non-numeric size",
    {
      schemaVersion: 1,
      complete: true,
      entries: [{ id: "a", kind: "file", name: "a", size: "1" }],
    },
  ],
  [
    "an ancestor without a name",
    {
      schemaVersion: 1,
      complete: true,
      entries: [{ id: "a", kind: "file", name: "a", ancestors: [{ id: "r" }] }],
    },
  ],
  [
    "an unknown ancestor property",
    {
      schemaVersion: 1,
      complete: true,
      entries: [
        { id: "a", kind: "file", name: "a", ancestors: [{ id: "r", name: "r", depth: 1 }] },
      ],
    },
  ],
];

test("the shipped search-index schema itself compiles under strict Ajv", () => {
  assert.equal(typeof validateSearch, "function");
});

test("both search-index validators accept every valid document", () => {
  for (const [what, input] of SEARCH_VALID) {
    assert.ok(
      validateSearch(input),
      `the schema refused ${what}: ${ajv.errorsText(validateSearch.errors)}`,
    );
    assert.ok(searchParserAccepts(input), `the parser refused ${what}`);
  }
});

test("both search-index validators refuse every invalid document", () => {
  for (const [what, input] of SEARCH_INVALID) {
    assert.equal(validateSearch(input), false, `the schema accepted ${what}`);
    assert.equal(searchParserAccepts(input), false, `the parser accepted ${what}`);
  }
});

test("the search index's one unexpressible rule is the parser's alone", () => {
  const duplicates = {
    schemaVersion: 1,
    complete: true,
    entries: [
      { id: "same", kind: "file", name: "a" },
      { id: "same", kind: "file", name: "b" },
    ],
  };
  assert.ok(validateSearch(duplicates), "the schema unexpectedly catches duplicate ids");
  assert.equal(
    searchParserAccepts(duplicates),
    false,
    "the parser must catch what the schema cannot",
  );
});

test("the search-index schema is closed everywhere", () => {
  const document = searchSchema as {
    additionalProperties: boolean;
    $defs: Record<string, { additionalProperties?: boolean }>;
  };
  assert.equal(document.additionalProperties, false);
  assert.equal(document.$defs.entry.additionalProperties, false);
  assert.equal(document.$defs.ancestor.additionalProperties, false);
});
