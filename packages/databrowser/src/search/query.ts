// search/query.ts - the DOM-free search/query boundary shared by the full data browser and the
// compact `/picker` entry.
//
// This module deliberately contains almost no logic of its own. Everything that DECIDES a query -
// the facet algebra, `_not_` semantics, flavour translation, base-scope gating, the time/bbox
// representation, the encoding - already lives in `state.ts` and operates on `QueryScope`, the
// smallest slice of state that determines the effective REST query. What is added here is the last
// step: turning a scope into the exact REST URL, so the two consumers cannot
// disagree about the endpoint, `translate=true`, or the result cap.
//
// Why this exists: the picker is a real second consumer, and
// the alternative - a copy of the query rules that evolves independently - fails silently the first
// time freva-rest changes its negation or translation contract.
//
// Nothing in this file touches the DOM, `window.location`, or any credential.

import type { QueryScope, UniqKey } from "../types.js";
import { facetQueryString, queryPairs } from "../state.js";

export type { QueryScope };

/** Where a query runs. Carries NO credentials - a token supplier is a transport concern. */
export interface QueryTarget {
  apiBase: string;
  flavour: string;
  uniqKey: UniqKey;
}

/**
 * The serialisable description of what a scope actually asks the server for. `params` are the
 * WIRE pairs (base scope merged in, deduped, gated keys enforced); `queryString` is those pairs
 * encoded. `selectionParams` are the pairs the USER chose, without the invisible base scope - the
 * shareable half.
 */
export interface EffectiveSearchQuery {
  flavour: string;
  uniqKey: UniqKey;
  /** Encoded wire query, exactly as sent (no leading `?`/`&`). */
  queryString: string;
  /** Decoded wire pairs, in the same order. */
  params: Array<[string, string]>;
  /** The user's own selection pairs (no base scope) - what a shareable link would carry. */
  selectionParams: Array<[string, string]>;
}

/**
 * The single conversion from "a scope" to "what the server is asked". Both the full browser's
 * search lifecycle and the picker call this; `tests/search-boundary.test.ts` pins that the same
 * serialised state yields byte-identical queries through either path.
 */
export function effectiveSearchQuery(scope: QueryScope): EffectiveSearchQuery {
  const queryString = facetQueryString(scope);
  const params: Array<[string, string]> = [];
  for (const [k, v] of new URLSearchParams(queryString).entries()) params.push([k, v]);
  return {
    flavour: scope.flavour,
    uniqKey: scope.uniqKey,
    queryString,
    params,
    selectionParams: queryPairs(scope),
  };
}

/** Options accepted by every search-ish endpoint. */
export interface SearchUrlOptions {
  maxResults?: number;
  start?: number;
}

/**
 * THE search URL builder. `Api.searchUrl()` and the picker's transport both call it, so
 * `translate=true` (which is what makes the returned facet keys flavour-named, and therefore what
 * makes the whole translation layer coherent) can never be present on one path and missing on the
 * other.
 */
export function buildSearchUrl(
  apiBase: string,
  endpoint: "extended-search" | "metadata-search",
  flavour: string,
  uniqKey: UniqKey,
  query: string,
  opts: SearchUrlOptions = {},
): string {
  const base = apiBase.replace(/\/+$/, "");
  let url = `${base}/${endpoint}/${encodeURIComponent(flavour)}/${uniqKey}?translate=true`;
  if (opts.maxResults !== undefined) url += `&max-results=${opts.maxResults}`;
  if (opts.start) url += `&start=${opts.start}`;
  if (query) url += `&${query}`;
  return url;
}

/** The URL for a scope's own search, with no caller-side query assembly. */
export function searchUrlForScope(
  target: QueryTarget,
  scope: QueryScope,
  opts: SearchUrlOptions = {},
): string {
  return buildSearchUrl(
    target.apiBase,
    "extended-search",
    scope.flavour,
    scope.uniqKey,
    facetQueryString(scope),
    opts,
  );
}

/** A scope with nothing selected - the neutral element every consumer starts from. */
export function emptyScope(init: Partial<QueryScope> = {}): QueryScope {
  return {
    flavour: init.flavour ?? "freva",
    uniqKey: init.uniqKey ?? "file",
    selected: init.selected ?? {},
    baseFilters: init.baseFilters ?? {},
    time: init.time ?? null,
    bbox: init.bbox ?? null,
    flavourMaps: init.flavourMaps ?? {},
  };
}
