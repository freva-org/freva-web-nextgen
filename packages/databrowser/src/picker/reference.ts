// picker/reference.ts - the versioned, serialisable contract the picker hands to its host.
//
// This is the ONLY thing that crosses the boundary between the picker and a lab application, both
// on a drag payload and through `onCommit`. It is deliberately a discriminated union with an
// explicit `schemaVersion`, so a lab built against v1 can detect - rather than misread - a later
// revision.
//
// THREE KINDS, because they answer three different questions:
//   • `asset`     - this one file.
//   • `selection` - these N files the user explicitly ticked (hard-capped, see MAX_PICKER_ASSETS).
//   • `query`     - "everything that matches what I am looking at". Carries the effective REST
//                   query, NOT hundreds of URIs: a filtered set of 40,000 files is a query, and
//                   materialising it into a drag payload is how you build something that works in
//                   the demo and dies in production.
//
// TWO VALIDATORS, ONE VERDICT. `isDataReference()` (runtime, shipped, dependency-free) and
// `DATA_REFERENCE_JSON_SCHEMA` (for hosts validating with their own tooling, possibly in another
// language) must accept and reject exactly the same documents; a schema that accepts what the guard
// rejects is a silent divergence. Both are CLOSED: every object declares its
// properties and forbids the rest, which is also what makes "no credentials" a structural property
// rather than a denylist. `tests/picker-schema-parity.test.ts` runs both against one fixture corpus
// with a real draft-2020-12 validator and fails on any disagreement.
//
// CREDENTIALS ARE NEVER INCLUDED. A reference is a location plus a question; it is not an
// authorisation. A `DataTransfer` payload is readable by whatever page the user drops onto, so a
// token that leaked into one would be exfiltrated by using the feature correctly.

import type { EffectiveSearchQuery } from "../search/query.js";

export type { EffectiveSearchQuery };

/** The MIME type used on `DataTransfer` and expected by a receiving lab. */
export const FREVA_DATA_REFERENCE_MIME = "application/vnd.freva.data-reference+json";

/** Bump ONLY for a breaking change; consumers switch on it. */
export const DATA_REFERENCE_SCHEMA_VERSION = 1 as const;

/** Hard cap on how many assets an explicit `selection` reference may carry. */
export const MAX_PICKER_ASSETS = 25;

/** Where the data lives. No token, no cookie, no session id - by contract. */
export interface DataSource {
  /** Base URL of the freva-nextgen databrowser REST API the reference was produced from. */
  apiBase: string;
  /** The metadata lens the query and the facet keys are expressed in. */
  flavour: string;
  /** Which identity the archive keys files by. */
  uniqKey: "file" | "uri";
}

/**
 * OPTIONAL STAC enrichment on an asset. Purely additive: a consumer that speaks STAC can use it,
 * and one that does not ignores it. It is NEVER a substitute for `uri`, and the picker never pushes
 * `_not_` selections into a STAC filter - STAC's filter grammar is not this contract's negation
 * grammar, and silently reinterpreting an exclusion is the exact class of bug `_not_` exists to
 * avoid.
 */
export interface StacLocator {
  collection?: string;
  item?: string;
  href?: string;
}

/** One concrete file. `uri` is the only required locator. */
export interface AssetReference {
  /** Stable identity within `source` - the archive's own key for this file. */
  id: string;
  /** The file's URI or path, exactly as the archive reports it. */
  uri: string;
  /** Storage backend (`posix`, `swift`, `s3`, …) when the archive reports one. */
  fsType?: string;
  /** File format (`netcdf`, `zarr`, …) when known. Absent is normal, not an error. */
  format?: string;
  stac?: StacLocator;
}

interface Base {
  schemaVersion: typeof DATA_REFERENCE_SCHEMA_VERSION;
  source: DataSource;
}

export interface AssetDataReference extends Base {
  kind: "asset";
  asset: AssetReference;
}

export interface SelectionDataReference extends Base {
  kind: "selection";
  /**
   * Every asset the user explicitly chose - never a partial view of it. There is deliberately no
   * "truncated" flag: the picker holds durable asset snapshots rather than row keys, so a selection
   * cannot lose members just because they scrolled off the loaded page, and a reference that could
   * not represent the whole selection is not emitted at all.
   */
  assets: AssetReference[];
}

export interface QueryDataReference extends Base {
  kind: "query";
  query: EffectiveSearchQuery;
  /** The server's `total_count` when the reference was made. Advisory; a non-negative integer. */
  estimatedCount?: number;
}

export type DataReference = AssetDataReference | SelectionDataReference | QueryDataReference;

// Validation
//
// Both validators enforce CLOSED objects. Everything below is expressed twice on purpose - once as
// TypeScript-checkable runtime code, once as JSON Schema - and the parity test is what keeps the
// two honest.

const SOURCE_KEYS = new Set(["apiBase", "flavour", "uniqKey"]);
const ASSET_KEYS = new Set(["id", "uri", "fsType", "format", "stac"]);
const STAC_KEYS = new Set(["collection", "item", "href"]);
const QUERY_KEYS = new Set(["flavour", "uniqKey", "queryString", "params", "selectionParams"]);
const BASE_KEYS = ["schemaVersion", "kind", "source"];
const KIND_KEYS: Record<string, string[]> = {
  asset: [...BASE_KEYS, "asset"],
  selection: [...BASE_KEYS, "assets"],
  query: [...BASE_KEYS, "query", "estimatedCount"],
};

const CREDENTIAL_KEYS = new Set([
  "token",
  "accesstoken",
  "idtoken",
  "refreshtoken",
  "authorization",
  "auth",
  "bearer",
  "password",
  "secret",
  "apikey",
  "cookie",
  "csrf",
  "csrftoken",
  "sessionid",
  "sessiontoken",
  "credentials",
]);

/**
 * Deep scan for a credential-shaped property name. Kept as a SEPARATE, explicit check even though
 * the closed-object rules already reject unknown properties: it names the failure, it survives a
 * future decision to reopen part of the schema, and it is the thing a reader looks for when asking
 * "can a token get into a drag payload?".
 */
export function findCredentialField(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findCredentialField(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [k, v] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(k.toLowerCase().replace(/[-_\s]/g, ""))) return `${path}.${k}`;
    const hit = findCredentialField(v, `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every own key is in `allowed` - the runtime twin of `additionalProperties: false`. */
const onlyKeys = (o: Record<string, unknown>, allowed: Set<string> | string[]): boolean => {
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  return Object.keys(o).every((k) => set.has(k));
};

/** Optional string property: absent, or a non-empty string. Anything else fails. */
const optString = (o: Record<string, unknown>, k: string): boolean =>
  o[k] === undefined || (typeof o[k] === "string" && (o[k] as string).length > 0);

function isSource(v: unknown): v is DataSource {
  if (!isPlainObject(v) || !onlyKeys(v, SOURCE_KEYS)) return false;
  return (
    typeof v.apiBase === "string" &&
    typeof v.flavour === "string" &&
    v.flavour.length > 0 &&
    (v.uniqKey === "file" || v.uniqKey === "uri")
  );
}

function isStac(v: unknown): v is StacLocator {
  if (!isPlainObject(v) || !onlyKeys(v, STAC_KEYS)) return false;
  // Every declared STAC field is a string or absent: `stac: { href: 42 }` is rejected.
  return STAC_KEYS.size > 0 && [...STAC_KEYS].every((k) => optString(v, k));
}

function isAsset(v: unknown): v is AssetReference {
  if (!isPlainObject(v) || !onlyKeys(v, ASSET_KEYS)) return false;
  if (typeof v.id !== "string" || v.id.length === 0) return false;
  if (typeof v.uri !== "string" || v.uri.length === 0) return false;
  if (!optString(v, "fsType") || !optString(v, "format")) return false;
  if (v.stac !== undefined && !isStac(v.stac)) return false;
  return true;
}

const isPairList = (x: unknown): boolean =>
  Array.isArray(x) &&
  x.every((p) => Array.isArray(p) && p.length === 2 && p.every((s) => typeof s === "string"));

function isQuery(v: unknown): v is EffectiveSearchQuery {
  if (!isPlainObject(v) || !onlyKeys(v, QUERY_KEYS)) return false;
  if (typeof v.flavour !== "string" || v.flavour.length === 0) return false;
  if (v.uniqKey !== "file" && v.uniqKey !== "uri") return false;
  if (typeof v.queryString !== "string") return false;
  return isPairList(v.params) && isPairList(v.selectionParams);
}

/** A non-negative INTEGER count. Rejects -1, 1.5, Infinity and NaN. */
const isCount = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Runtime guard for a value that arrived from OUTSIDE - a drop payload, `postMessage`, restored
 * host state. Checks the discriminant, the version, the closed shape at every level, the value
 * types AND the no-credentials rule.
 */
export function isDataReference(value: unknown): value is DataReference {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== DATA_REFERENCE_SCHEMA_VERSION) return false;
  if (typeof value.kind !== "string") return false;
  const allowed = KIND_KEYS[value.kind];
  if (!allowed || !onlyKeys(value, allowed)) return false;
  if (!isSource(value.source)) return false;
  if (findCredentialField(value) !== null) return false;
  switch (value.kind) {
    case "asset":
      return isAsset(value.asset);
    case "selection":
      return (
        Array.isArray(value.assets) &&
        value.assets.length > 0 &&
        value.assets.length <= MAX_PICKER_ASSETS &&
        value.assets.every(isAsset)
      );
    case "query":
      return (
        isQuery(value.query) &&
        (value.estimatedCount === undefined || isCount(value.estimatedCount))
      );
    default:
      return false;
  }
}

/** Parse a `DataTransfer` payload. Returns null for anything that is not a valid v1 reference. */
export function parseDataReference(text: string): DataReference | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isDataReference(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A deep, alias-free copy of an asset. The nested `stac` object is the reason this exists. */
export function cloneAssetReference(a: AssetReference): AssetReference {
  return { ...a, ...(a.stac ? { stac: { ...a.stac } } : {}) };
}

/**
 * Protocols allowed into `text/uri-list`.
 *
 * `text/uri-list` is a HANDOFF TO THE BROWSER: a drop target may hand what it receives straight to
 * a link, a fetch, or a download. A `scheme://` shape test is not a safety check - it happily
 * admits `javascript://%0Aalert(document.domain)`, which is a genuinely dangerous thing to place on
 * a clipboard-adjacent surface. Only protocols that denote a fetchable remote resource qualify.
 *
 * An archive URI of any other scheme still travels in full inside the versioned `DataReference`
 * and in the human-readable `text/plain` description - it is simply not offered as a URL.
 */
export const URI_LIST_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * The CANONICAL form to place in `text/uri-list`, or null when `uri` does not qualify.
 *
 * Returning the parser's `href` rather than the input string matters: `HTTPS://S/A` and
 * `http:/host` are both valid absolute URLs that a drop target should receive in normalised form,
 * and normalising here means the value handed over is always exactly what a browser would fetch.
 * A non-empty host is required as well - `http://` on its own denotes nothing to download.
 */
export function uriListValue(uri: string): string | null {
  let parsed: URL;
  try {
    // The one-argument form is deliberate: with a base, a relative path like `/archive/tas.nc`
    // would be resolved into an http(s) URL that the archive never published.
    parsed = new URL(uri);
  } catch {
    return null; // not an absolute URL at all - a POSIX path, or malformed
  }
  if (!URI_LIST_PROTOCOLS.has(parsed.protocol) || parsed.host === "") return null;
  return parsed.href;
}

/** True when `uri` is a fetchable remote URL on an allowed protocol. */
export function isUriListSafe(uri: string): boolean {
  return uriListValue(uri) !== null;
}

/**
 * The URIs a `text/uri-list` fallback should carry, or null when there is nothing safe to put
 * there. Only assets on a fetchable remote protocol qualify: a POSIX archive path is not a URL,
 * and an executable or opaque scheme must never be handed to a drop target as one.
 */
export function uriListFor(ref: DataReference): string | null {
  if (ref.kind === "asset") return uriListValue(ref.asset.uri);
  if (ref.kind === "selection") {
    const uris = ref.assets.map((a) => uriListValue(a.uri)).filter((u): u is string => u !== null);
    return uris.length ? uris.join("\r\n") : null;
  }
  return null;
}

/** Human-readable one-liner - the `text/plain` fallback for a drop target that speaks neither. */
export function describeReference(ref: DataReference): string {
  switch (ref.kind) {
    case "asset":
      return ref.asset.uri;
    case "selection":
      return ref.assets.map((a) => a.uri).join("\n");
    case "query": {
      const n = ref.estimatedCount;
      const filters = ref.query.selectionParams.map(([k, v]) => `${k}=${v}`).join(" ");
      const scope = filters || "no filters";
      return n === undefined
        ? `freva search (${ref.query.flavour}): ${scope}`
        : `freva search (${ref.query.flavour}), ${n} file${n === 1 ? "" : "s"}: ${scope}`;
    }
  }
}

/**
 * JSON Schema (draft 2020-12) for the contract, exported so a host can validate a payload with its
 * own tooling - in another language, or at an HTTP boundary the TypeScript guard cannot reach.
 *
 * Every object is CLOSED. The top level uses `unevaluatedProperties: false` rather than
 * `additionalProperties: false`, because the kind-specific properties are contributed by the
 * `oneOf` branches and `additionalProperties` cannot see them; `unevaluatedProperties` can.
 *
 * The shipped package carries NO validator - this is data. `tests/picker-schema-parity.test.ts`
 * runs it through a real draft-2020-12 validator (a dev-only dependency) against the same fixtures
 * as `isDataReference`.
 */
export const DATA_REFERENCE_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://freva.org/schemas/data-reference/v1.json",
  title: "Freva data reference",
  description:
    "A location plus a question. Never an authorisation: every object here is closed, so a credential-shaped field cannot appear at any level.",
  type: "object",
  required: ["schemaVersion", "kind", "source"],
  properties: {
    schemaVersion: { const: 1 },
    kind: { enum: ["asset", "selection", "query"] },
    source: { $ref: "#/$defs/source" },
  },
  oneOf: [
    {
      required: ["asset"],
      properties: { kind: { const: "asset" }, asset: { $ref: "#/$defs/asset" } },
    },
    {
      required: ["assets"],
      properties: {
        kind: { const: "selection" },
        assets: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PICKER_ASSETS,
          items: { $ref: "#/$defs/asset" },
        },
      },
    },
    {
      required: ["query"],
      properties: {
        kind: { const: "query" },
        query: { $ref: "#/$defs/query" },
        estimatedCount: { type: "integer", minimum: 0 },
      },
    },
  ],
  unevaluatedProperties: false,
  $defs: {
    source: {
      type: "object",
      required: ["apiBase", "flavour", "uniqKey"],
      additionalProperties: false,
      properties: {
        apiBase: { type: "string" },
        flavour: { type: "string", minLength: 1 },
        uniqKey: { enum: ["file", "uri"] },
      },
    },
    stac: {
      type: "object",
      additionalProperties: false,
      properties: {
        collection: { type: "string", minLength: 1 },
        item: { type: "string", minLength: 1 },
        href: { type: "string", minLength: 1 },
      },
    },
    asset: {
      type: "object",
      required: ["id", "uri"],
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        uri: { type: "string", minLength: 1 },
        fsType: { type: "string", minLength: 1 },
        format: { type: "string", minLength: 1 },
        stac: { $ref: "#/$defs/stac" },
      },
    },
    pairs: {
      type: "array",
      items: {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: { type: "string" },
      },
    },
    query: {
      type: "object",
      required: ["flavour", "uniqKey", "queryString", "params", "selectionParams"],
      additionalProperties: false,
      properties: {
        flavour: { type: "string", minLength: 1 },
        uniqKey: { enum: ["file", "uri"] },
        queryString: { type: "string" },
        params: { $ref: "#/$defs/pairs" },
        selectionParams: { $ref: "#/$defs/pairs" },
      },
    },
  },
} as const;
