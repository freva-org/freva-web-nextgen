// The `DataReference` contract: the only thing that crosses the boundary between the picker and a
// lab application. It is versioned, discriminated, serialisable - and it carries no credentials.
//
// The credential rule gets a runtime guard AND a test rather than a comment, because the failure
// mode is silent and severe: a drag payload is readable by whatever page the user drops onto, so a
// token that leaked into one would be exfiltrated by the act of using the feature correctly.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DATA_REFERENCE_JSON_SCHEMA,
  DATA_REFERENCE_SCHEMA_VERSION,
  FREVA_DATA_REFERENCE_MIME,
  MAX_PICKER_ASSETS,
  describeReference,
  findCredentialField,
  isDataReference,
  isUriListSafe,
  uriListValue,
  parseDataReference,
  uriListFor,
  cloneAssetReference,
  URI_LIST_PROTOCOLS,
  type DataReference,
} from "../src/picker/reference.js";

const source = {
  apiBase: "/api/freva-nextgen/databrowser",
  flavour: "freva",
  uniqKey: "file" as const,
};

const asset: DataReference = {
  schemaVersion: 1,
  kind: "asset",
  source,
  asset: { id: "/archive/tas.nc", uri: "/archive/tas.nc", fsType: "posix", format: "netcdf" },
};

const selection: DataReference = {
  schemaVersion: 1,
  kind: "selection",
  source,
  assets: [
    { id: "a", uri: "swift://store/a.nc", fsType: "swift" },
    { id: "b", uri: "swift://store/b.nc", fsType: "swift" },
  ],
};

const query: DataReference = {
  schemaVersion: 1,
  kind: "query",
  source,
  query: {
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
  },
  estimatedCount: 41253,
};

test("the MIME constant is the documented vendor type", () => {
  assert.equal(FREVA_DATA_REFERENCE_MIME, "application/vnd.freva.data-reference+json");
});

test("all three kinds validate, and survive a JSON round-trip unchanged", () => {
  for (const ref of [asset, selection, query]) {
    assert.ok(isDataReference(ref), `${ref.kind} did not validate`);
    const round: unknown = JSON.parse(JSON.stringify(ref));
    assert.deepEqual(round, ref);
    assert.ok(isDataReference(round));
  }
});

test("the version is the discriminator a future consumer switches on", () => {
  assert.equal(DATA_REFERENCE_SCHEMA_VERSION, 1);
  assert.equal(isDataReference({ ...asset, schemaVersion: 2 }), false);
  assert.equal(isDataReference({ ...asset, schemaVersion: "1" }), false);
});

test("malformed payloads are rejected rather than half-read", () => {
  const bad: unknown[] = [
    null,
    "not json",
    {},
    { schemaVersion: 1, kind: "asset", source },
    {
      schemaVersion: 1,
      kind: "elephant",
      source,
      asset: asset.kind === "asset" ? asset.asset : {},
    },
    { schemaVersion: 1, kind: "asset", source: { apiBase: "/x" }, asset: { id: "a", uri: "u" } },
    { schemaVersion: 1, kind: "asset", source, asset: { id: "a", uri: "" } },
    { schemaVersion: 1, kind: "selection", source, assets: [] },
    { schemaVersion: 1, kind: "query", source, query: { flavour: "freva" } },
  ];
  for (const b of bad) assert.equal(isDataReference(b), false, `accepted: ${JSON.stringify(b)}`);
  assert.equal(parseDataReference("{"), null);
  assert.equal(parseDataReference(JSON.stringify(asset))?.kind, "asset");
});

test("an explicit selection may never exceed the cap", () => {
  const many = {
    ...selection,
    assets: Array.from({ length: MAX_PICKER_ASSETS + 1 }, (_, i) => ({
      id: `a${i}`,
      uri: `swift://s/${i}.nc`,
    })),
  };
  assert.equal(isDataReference(many), false);
  const exact = { ...selection, assets: many.assets.slice(0, MAX_PICKER_ASSETS) };
  assert.equal(isDataReference(exact), true);
});

test("a credential-shaped field anywhere invalidates the reference", () => {
  // Not a sanitiser - an assertion. The contract has no such field, so a hit means someone added
  // one, and this must fail rather than ship.
  const leaks: unknown[] = [
    { ...asset, source: { ...source, token: "abc" } },
    { ...asset, asset: { ...(asset as { asset: object }).asset, Authorization: "Bearer x" } },
    {
      ...query,
      query: { ...(query as { query: object }).query, "api-key": "k" },
    },
  ];
  for (const l of leaks) {
    assert.ok(findCredentialField(l), `no credential detected in ${JSON.stringify(l)}`);
    assert.equal(isDataReference(l), false);
  }
  for (const ok of [asset, selection, query]) assert.equal(findCredentialField(ok), null);
});

test("text/uri-list admits only fetchable http(s) URLs", () => {
  // `text/uri-list` is a handoff to the BROWSER. A `scheme://` shape test is not a safety check:
  // it admits `javascript://%0Aalert(...)`, which is a genuinely dangerous thing to put on a
  // drag payload. Every other scheme still travels inside the versioned reference.
  // [input, the canonical value it should contribute - null means "never offered"]
  const CASES: Array<[string, string | null]> = [
    ["https://store.example/tas.nc", "https://store.example/tas.nc"],
    ["http://store.example/tas.nc", "http://store.example/tas.nc"],
    // Valid but non-canonical inputs are NORMALISED, so what a drop target receives is exactly
    // what a browser would fetch.
    ["HTTPS://STORE.EXAMPLE/tas.nc", "https://store.example/tas.nc"],
    ["https://store.example:8443/a b.nc", "https://store.example:8443/a%20b.nc"],
    ["http:/malformed", "http://malformed/"],
    // Executable, local and opaque schemes never reach the browser handoff.
    ["javascript://%0Aalert(document.domain)", null],
    ["javascript:alert(1)", null],
    ["data:text/html;base64,PHNjcmlwdD4=", null],
    ["file:///etc/passwd", null],
    ["file://host/share/a.nc", null],
    ["swift://store/a.nc", null],
    ["s3://bucket/a.nc", null],
    ["ftp://host/a.nc", null],
    ["vbscript:msgbox(1)", null],
    ["blob:https://x/1234", null],
    // Not absolute URLs at all.
    ["/archive/tas.nc", null],
    ["archive/tas.nc", null],
    ["", null],
    ["://nope", null],
    ["ht tp://spaces.example/", null],
    // An http(s) URL with no host denotes nothing to download.
    ["https://", null],
  ];
  for (const [uri, expected] of CASES) {
    assert.equal(isUriListSafe(uri), expected !== null, `isUriListSafe(${JSON.stringify(uri)})`);
    assert.equal(uriListValue(uri), expected, `uriListValue(${JSON.stringify(uri)})`);
    const ref: DataReference = { ...asset, asset: { id: "x", uri: uri || "/fallback.nc" } };
    assert.equal(
      uriListFor(ref),
      expected,
      `uriListFor(${JSON.stringify(uri)}) leaked an unsafe scheme`,
    );
  }
  assert.deepEqual([...URI_LIST_PROTOCOLS].sort(), ["http:", "https:"]);
});

test("a mixed selection contributes only its safe members, or nothing at all", () => {
  assert.equal(uriListFor(asset), null, "a posix path must not be offered as a URI");
  assert.equal(uriListFor(selection), null, "swift:// is not a browser-fetchable URL");
  assert.equal(uriListFor(query), null, "a query has no URIs by construction");
  const mixed: DataReference = {
    ...selection,
    assets: [
      { id: "a", uri: "/archive/a.nc" },
      { id: "b", uri: "https://store.example/b.nc" },
      { id: "c", uri: "javascript:alert(1)" },
      { id: "d", uri: "http://store.example/d.nc" },
    ],
  };
  assert.equal(uriListFor(mixed), "https://store.example/b.nc\r\nhttp://store.example/d.nc");
});

test("an unsafe URI still travels in the reference and the text description", () => {
  // The contract is a location, and the archive's own locator is what it is. Only the BROWSER
  // handoff is restricted.
  const ref: DataReference = { ...asset, asset: { id: "s", uri: "swift://store/a.nc" } };
  assert.ok(isDataReference(ref));
  assert.equal(JSON.parse(JSON.stringify(ref)).asset.uri, "swift://store/a.nc");
  assert.equal(describeReference(ref), "swift://store/a.nc");
});

test("cloneAssetReference copies the nested STAC locator, not a pointer to it", () => {
  const original = {
    id: "a",
    uri: "https://s/a.nc",
    stac: { collection: "cmip6", item: "a", href: "https://stac/a" },
  };
  const copy = cloneAssetReference(original);
  assert.deepEqual(copy, original);
  assert.notEqual(copy.stac, original.stac);
  copy.stac!.href = "https://evil/";
  assert.equal(original.stac.href, "https://stac/a");
  // An asset with no stac is still a fresh object.
  const plain = { id: "b", uri: "/b.nc" };
  assert.notEqual(cloneAssetReference(plain), plain);
});

test("the text/plain fallback is human-readable for every kind", () => {
  assert.equal(describeReference(asset), "/archive/tas.nc");
  assert.match(describeReference(selection), /a\.nc\nswift:\/\/store\/b\.nc$/);
  assert.equal(
    describeReference(query),
    "freva search (freva), 41253 files: project=cmip6 variable_not_=pr",
  );
});

test("a query reference is bounded in size no matter how large the result set", () => {
  // The whole point: 41,253 matching files must not become 41,253 URIs in a drag payload.
  const bytes = JSON.stringify(query).length;
  assert.ok(bytes < 800, `a query reference grew to ${bytes} bytes`);
  assert.equal("assets" in query, false);
});

test("the exported JSON Schema describes the same shapes the guard accepts", () => {
  const s = DATA_REFERENCE_JSON_SCHEMA as unknown as {
    $id: string;
    properties: { schemaVersion: { const: number }; kind: { enum: string[] } };
    oneOf: unknown[];
    $defs: Record<string, unknown>;
  };
  assert.equal(s.properties.schemaVersion.const, DATA_REFERENCE_SCHEMA_VERSION);
  assert.deepEqual(s.properties.kind.enum, ["asset", "selection", "query"]);
  assert.equal(s.oneOf.length, 3);
  for (const def of ["source", "asset", "query", "pairs"]) assert.ok(def in s.$defs);
  // No credential-shaped property may appear in the schema either.
  assert.equal(findCredentialField(DATA_REFERENCE_JSON_SCHEMA), null);
  // It must itself be serialisable - a host validates with its own tooling, possibly in another
  // language, so the schema has to travel as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(s)).$id, s.$id);
});

test("STAC fields are optional enrichment and never carry the `_not_` selection", () => {
  const withStac: DataReference = {
    ...asset,
    asset: {
      id: "a",
      uri: "https://store.example/a.nc",
      stac: { collection: "cmip6", item: "a", href: "https://stac.example/items/a" },
    },
  };
  assert.ok(isDataReference(withStac));
  // The exclusion lives in the QUERY contract, where its grammar is defined - never pushed into a
  // STAC filter, whose negation semantics are not the same thing.
  const text = JSON.stringify(withStac);
  assert.equal(text.includes("_not_"), false);
});
