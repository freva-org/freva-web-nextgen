// intent.ts - the versioned, URL-serialised search handoff (`SearchIntentV1`).
//
// A landing page needs to hand a search to this component without touching its DOM, without a
// global variable and without an in-memory value that a reload would erase. So the handoff is a
// URL: the landing serialises an intent into the query string, and this module is the typed
// initializer that reads it back. A search therefore survives reload, bookmarking and sharing,
// and the two sides are coupled only through the exported type below.
//
// The wire form is deliberately this component's OWN query contract (`flavour` plus facet pairs),
// not a private envelope: a link produced by a landing page is indistinguishable from a link a
// user copied out of the address bar after searching here, and both reload identically. `siv`
// carries the intent version so an older artefact and a newer component can recognise each other,
// and it is a reserved key that never becomes a facet.

import type { DataBrowserConfig, FlavourName } from "./types.js";

/** The version this build produces and accepts. */
export const SEARCH_INTENT_VERSION = 1;

/** The reserved query key carrying the intent version. */
export const SEARCH_INTENT_VERSION_KEY = "siv";

/** The reserved query key carrying free text before it is mapped onto a facet. */
export const SEARCH_INTENT_TEXT_KEY = "q";

export interface SearchIntentV1 {
  v: 1;
  /** Free text. Mapped onto the component's uniq key as a wildcard value. */
  q?: string;
  flavour?: FlavourName;
  /** Freva-canonical facet keys to values. */
  facets?: Record<string, string[]>;
}

const FLAVOUR_SHAPE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Lucene metacharacters that would otherwise turn free text into an operator. `*` is NOT escaped:
 * the wildcards this function adds are the point of the mapping.
 */
const LUCENE_SPECIAL = /([+\-!(){}[\]^"~?:\\/&|])/g;

/** Free text becomes a wildcard value on the uniq key, which the search API supports directly. */
export function textToFacetValue(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned === "") return "";
  return `*${cleaned.replace(LUCENE_SPECIAL, "\\$1").replace(/ /g, "*")}*`;
}

/** Serialise an intent into this component's own query contract. */
export function serializeSearchIntentV1(
  intent: SearchIntentV1,
  uniqKey: "file" | "uri" = "file",
): string {
  const params = new URLSearchParams();
  params.set(SEARCH_INTENT_VERSION_KEY, String(intent.v ?? SEARCH_INTENT_VERSION));
  if (intent.flavour) params.set("flavour", intent.flavour);
  for (const [key, values] of Object.entries(intent.facets ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const value of values) params.append(key, value);
  }
  const text = intent.q ? textToFacetValue(intent.q) : "";
  if (text) params.append(uniqKey, text);
  return params.toString();
}

export interface ParsedIntent {
  intent: SearchIntentV1;
  /** The query string with the reserved intent keys removed and free text mapped. */
  normalizedSearch: string;
  /** True when the query string carried an intent version this build does not accept. */
  unsupportedVersion?: number;
}

/**
 * Read an intent back. Unknown/absent `siv` is not an error: a plain deep link that predates the
 * intent is still a valid query for this component, it simply carries no version.
 */
export function parseSearchIntentV1(
  search: string,
  uniqKey: "file" | "uri" = "file",
): ParsedIntent {
  const params = new URLSearchParams(search);
  const rawVersion = params.get(SEARCH_INTENT_VERSION_KEY);
  const version = rawVersion === null ? undefined : Number(rawVersion);
  params.delete(SEARCH_INTENT_VERSION_KEY);

  const text = params.get(SEARCH_INTENT_TEXT_KEY) ?? undefined;
  params.delete(SEARCH_INTENT_TEXT_KEY);

  // Shape-checked only. Which flavours actually exist is the component's own
  // question, answered against the loaded flavour list - not duplicated here.
  const rawFlavour = params.get("flavour");
  const flavour =
    rawFlavour && FLAVOUR_SHAPE.test(rawFlavour) ? (rawFlavour as FlavourName) : undefined;

  const facets: Record<string, string[]> = {};
  for (const [key, value] of params.entries()) {
    if (key === "flavour") continue;
    (facets[key] ??= []).push(value);
  }

  if (text && text.trim() !== "") {
    const mapped = textToFacetValue(text);
    if (mapped) {
      params.append(uniqKey, mapped);
      (facets[uniqKey] ??= []).push(mapped);
    }
  }

  const intent: SearchIntentV1 = { v: SEARCH_INTENT_VERSION };
  if (text && text.trim() !== "") intent.q = text.trim();
  if (flavour) intent.flavour = flavour;
  if (Object.keys(facets).length > 0) intent.facets = facets;

  const parsed: ParsedIntent = { intent, normalizedSearch: params.toString() };
  if (version !== undefined && version !== SEARCH_INTENT_VERSION)
    parsed.unsupportedVersion = version;
  return parsed;
}

/** Apply the parts of an intent that are component configuration rather than URL state. */
export function applySearchIntentV1(
  config: DataBrowserConfig,
  intent: SearchIntentV1,
): DataBrowserConfig {
  return intent.flavour ? { ...config, flavour: intent.flavour } : { ...config };
}
