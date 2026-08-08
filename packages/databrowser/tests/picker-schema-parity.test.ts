// Two validators, one verdict.
//
// The picker exports BOTH a runtime guard (`isDataReference`, shipped, dependency-free) and a JSON
// Schema (for hosts validating with their own tooling, possibly in another language). A host that
// validates with the schema and a picker that validates with the guard must agree, or the contract
// means two different things depending on which side of the boundary you stand on.
//
// The ways they drift apart are concrete: a schema left open at every object level accepts a
// credential field the guard rejects, and a guard that waves through `stac: { href: 42 }` or
// `estimatedCount: -1` accepts what no sane schema would. This test runs a REAL draft-2020-12
// validator (ajv, dev-only; the shipped package gains no validator dependency) and the guard
// against ONE fixture corpus and fails on any disagreement, so neither can be tightened or
// loosened alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

import {
  DATA_REFERENCE_JSON_SCHEMA,
  MAX_PICKER_ASSETS,
  isDataReference,
} from "../src/picker/reference.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(DATA_REFERENCE_JSON_SCHEMA as unknown as object);

const source = { apiBase: "/api/freva-nextgen/databrowser", flavour: "freva", uniqKey: "file" };
const asset = { id: "/archive/a.nc", uri: "/archive/a.nc", fsType: "posix", format: "netcdf" };
const query = {
  flavour: "freva",
  uniqKey: "file",
  queryString: "project=cmip6&variable_not_=pr",
  params: [
    ["project", "cmip6"],
    ["variable_not_", "pr"],
  ],
  selectionParams: [
    ["project", "cmip6"],
    ["variable_not_", "pr"],
  ],
};

const ref = (over: Record<string, unknown>): Record<string, unknown> => ({
  schemaVersion: 1,
  source,
  ...over,
});

interface Fixture {
  name: string;
  value: unknown;
  valid: boolean;
}

const assets = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => ({ id: `a${i}`, uri: `swift://s/${i}.nc` }));

const FIXTURES: Fixture[] = [
  // The three valid kinds
  { name: "asset", value: ref({ kind: "asset", asset }), valid: true },
  {
    name: "asset, minimal (id + uri only)",
    value: ref({ kind: "asset", asset: { id: "a", uri: "/a.nc" } }),
    valid: true,
  },
  {
    name: "asset with a full STAC locator",
    value: ref({
      kind: "asset",
      asset: {
        id: "a",
        uri: "https://s/a.nc",
        stac: { collection: "cmip6", item: "a", href: "https://stac/items/a" },
      },
    }),
    valid: true,
  },
  { name: "selection of two", value: ref({ kind: "selection", assets: assets(2) }), valid: true },
  {
    name: `selection of exactly ${MAX_PICKER_ASSETS}`,
    value: ref({ kind: "selection", assets: assets(MAX_PICKER_ASSETS) }),
    valid: true,
  },
  { name: "query", value: ref({ kind: "query", query }), valid: true },
  {
    name: "query with an estimatedCount",
    value: ref({ kind: "query", query, estimatedCount: 41253 }),
    valid: true,
  },
  {
    name: "query, count zero",
    value: ref({ kind: "query", query, estimatedCount: 0 }),
    valid: true,
  },
  {
    name: "query with no filters at all",
    value: ref({
      kind: "query",
      query: { ...query, queryString: "", params: [], selectionParams: [] },
    }),
    valid: true,
  },

  // Version / discriminant
  {
    name: "wrong schemaVersion",
    value: ref({ kind: "asset", asset, schemaVersion: 2 }),
    valid: false,
  },
  {
    name: "stringly-typed schemaVersion",
    value: ref({ kind: "asset", asset, schemaVersion: "1" }),
    valid: false,
  },
  { name: "unknown kind", value: ref({ kind: "elephant", asset }), valid: false },
  { name: "missing kind", value: ref({ asset }), valid: false },
  { name: "kind without its payload", value: ref({ kind: "asset" }), valid: false },
  {
    name: "payload of the wrong kind",
    value: ref({ kind: "asset", assets: assets(2) }),
    valid: false,
  },
  {
    name: "two payloads at once",
    value: ref({ kind: "asset", asset, assets: assets(2) }),
    valid: false,
  },

  // Unknown properties, every level
  {
    name: "unknown property at the top",
    value: ref({ kind: "asset", asset, extra: 1 }),
    valid: false,
  },
  {
    name: "unknown property on source",
    value: ref({ kind: "asset", asset, source: { ...source, region: "eu" } }),
    valid: false,
  },
  {
    name: "unknown property on an asset",
    value: ref({ kind: "asset", asset: { ...asset, size: 12 } }),
    valid: false,
  },
  {
    name: "unknown property on stac",
    value: ref({ kind: "asset", asset: { id: "a", uri: "u", stac: { license: "cc" } } }),
    valid: false,
  },
  {
    name: "unknown property on query",
    value: ref({ kind: "query", query: { ...query, rows: 10 } }),
    valid: false,
  },

  // Credential-shaped fields, every level
  {
    name: "credential at the top",
    value: ref({ kind: "asset", asset, token: "abc" }),
    valid: false,
  },
  {
    name: "credential on source",
    value: ref({ kind: "asset", asset, source: { ...source, authorization: "Bearer x" } }),
    valid: false,
  },
  {
    name: "credential on an asset",
    value: ref({ kind: "asset", asset: { ...asset, apiKey: "k" } }),
    valid: false,
  },
  {
    name: "credential inside stac",
    value: ref({ kind: "asset", asset: { id: "a", uri: "u", stac: { cookie: "c" } } }),
    valid: false,
  },
  {
    name: "credential on a selection member",
    value: ref({ kind: "selection", assets: [{ id: "a", uri: "u", secret: "s" }, ...assets(1)] }),
    valid: false,
  },
  {
    name: "credential inside query",
    value: ref({ kind: "query", query: { ...query, sessionId: "s" } }),
    valid: false,
  },

  // Invalid STAC types
  {
    name: "stac.href is a number",
    value: ref({ kind: "asset", asset: { id: "a", uri: "u", stac: { href: 42 } } }),
    valid: false,
  },
  {
    name: "stac.collection is an object",
    value: ref({ kind: "asset", asset: { id: "a", uri: "u", stac: { collection: {} } } }),
    valid: false,
  },
  {
    name: "stac is an array",
    value: ref({ kind: "asset", asset: { id: "a", uri: "u", stac: [] } }),
    valid: false,
  },
  {
    name: "stac.item is empty",
    value: ref({ kind: "asset", asset: { id: "a", uri: "u", stac: { item: "" } } }),
    valid: false,
  },

  // Counts
  {
    name: "negative count",
    value: ref({ kind: "query", query, estimatedCount: -1 }),
    valid: false,
  },
  {
    name: "fractional count",
    value: ref({ kind: "query", query, estimatedCount: 1.5 }),
    valid: false,
  },
  {
    name: "infinite count",
    value: ref({ kind: "query", query, estimatedCount: Number.POSITIVE_INFINITY }),
    valid: false,
  },
  {
    name: "NaN count",
    value: ref({ kind: "query", query, estimatedCount: Number.NaN }),
    valid: false,
  },
  {
    name: "stringly-typed count",
    value: ref({ kind: "query", query, estimatedCount: "12" }),
    valid: false,
  },

  // Selections
  { name: "empty selection", value: ref({ kind: "selection", assets: [] }), valid: false },
  {
    name: `selection of ${MAX_PICKER_ASSETS + 1} (over the cap)`,
    value: ref({ kind: "selection", assets: assets(MAX_PICKER_ASSETS + 1) }),
    valid: false,
  },
  {
    name: "selection containing a non-object",
    value: ref({ kind: "selection", assets: ["/archive/a.nc", { id: "b", uri: "u" }] }),
    valid: false,
  },
  {
    name: "asset with an empty uri",
    value: ref({ kind: "asset", asset: { id: "a", uri: "" } }),
    valid: false,
  },
  {
    name: "asset with a non-string uri",
    value: ref({ kind: "asset", asset: { id: "a", uri: 7 } }),
    valid: false,
  },
  {
    name: "asset missing its id",
    value: ref({ kind: "asset", asset: { uri: "/a.nc" } }),
    valid: false,
  },
  {
    name: "asset with an empty fsType",
    value: ref({ kind: "asset", asset: { id: "a", uri: "u", fsType: "" } }),
    valid: false,
  },

  // Source / query structure
  { name: "missing source", value: { schemaVersion: 1, kind: "asset", asset }, valid: false },
  {
    name: "source with an unknown uniqKey",
    value: ref({ kind: "asset", asset, source: { ...source, uniqKey: "dataset" } }),
    valid: false,
  },
  {
    name: "source missing apiBase",
    value: ref({ kind: "asset", asset, source: { flavour: "freva", uniqKey: "file" } }),
    valid: false,
  },
  {
    name: "source with an empty flavour",
    value: ref({ kind: "asset", asset, source: { ...source, flavour: "" } }),
    valid: false,
  },
  {
    name: "query missing selectionParams",
    value: ref({
      kind: "query",
      query: { flavour: "freva", uniqKey: "file", queryString: "", params: [] },
    }),
    valid: false,
  },
  {
    name: "query params is not a pair list",
    value: ref({ kind: "query", query: { ...query, params: [["only-one"]] } }),
    valid: false,
  },
  {
    name: "query params holds a non-string",
    value: ref({ kind: "query", query: { ...query, params: [["k", 1]] } }),
    valid: false,
  },
  {
    name: "query params is an object",
    value: ref({ kind: "query", query: { ...query, params: { k: "v" } } }),
    valid: false,
  },

  // Not objects at all
  { name: "null", value: null, valid: false },
  { name: "a string", value: "asset", valid: false },
  { name: "an array", value: [], valid: false },
  { name: "an empty object", value: {}, valid: false },
];

test("the exported schema compiles under a real draft-2020-12 validator", () => {
  assert.equal(typeof validate, "function");
  assert.equal(
    (DATA_REFERENCE_JSON_SCHEMA as { $schema: string }).$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
});

for (const f of FIXTURES) {
  test(`guard and schema agree - ${f.name} is ${f.valid ? "valid" : "invalid"}`, () => {
    const bySchema = validate(f.value) === true;
    const byGuard = isDataReference(f.value);
    assert.equal(byGuard, f.valid, `the runtime guard said ${byGuard}, expected ${f.valid}`);
    assert.equal(
      bySchema,
      f.valid,
      `the JSON Schema said ${bySchema}, expected ${f.valid}: ${ajv.errorsText(validate.errors)}`,
    );
    assert.equal(byGuard, bySchema, "the two validators disagreed");
  });
}

test("the corpus actually exercises both outcomes", () => {
  // A corpus that is all-invalid (or all-valid) would pass trivially while proving nothing.
  assert.ok(FIXTURES.filter((f) => f.valid).length >= 8);
  assert.ok(FIXTURES.filter((f) => !f.valid).length >= 30);
});

test("the shipped package does not depend on a runtime validator", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  // ajv is dev-only: hosts get a schema they can validate with their own tooling, not a validator
  // bolted into the bundle.
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ["@freva-org/freva-client-terminal"]);
  assert.ok("ajv" in (pkg.devDependencies ?? {}));
});
