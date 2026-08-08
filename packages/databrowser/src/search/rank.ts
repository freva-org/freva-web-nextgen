// search/rank.ts - the value-first autocomplete ranking, shared by the full browser's search bar
// and the picker's search field.
//
// It is a small function, which is exactly why it is shared rather than copied: a landing
// page or a picker that ranks "tas" differently from the browser it hands off to is a bug the user
// experiences as the tool being unreliable, and nothing in either codebase would ever fail.
//
// The rule: values whose text STARTS WITH the query come first, then substring hits (including hits
// in a value's human description), each group ordered by descending facet count. Already-applied
// values are excluded by the caller's predicate.

import type { Facet } from "../types.js";

export interface ValueMatch {
  /** Facet key in the CURRENT flavour's naming. */
  key: string;
  label: string;
  value: string;
  count: number;
  desc: string | null;
}

export interface RankOptions {
  /** Display label for a facet key. Defaults to the facet's own `label`. */
  label?: (facet: Facet) => string;
  /** Human description for a (key, value), when the deployment supplies one. */
  describe?: (key: string, value: string) => string | null;
  /** Values already applied - excluded from the list. */
  isApplied?: (key: string, value: string) => boolean;
  limit?: number;
}

export const DEFAULT_MATCH_LIMIT = 40;

export function rankValueMatches(
  facets: readonly Facet[],
  raw: string,
  opts: RankOptions = {},
): ValueMatch[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const prefix: ValueMatch[] = [];
  const substr: ValueMatch[] = [];
  for (const facet of facets) {
    const label = opts.label ? opts.label(facet) : facet.label;
    for (const v of facet.values) {
      if (opts.isApplied?.(facet.key, v.value)) continue;
      const val = v.value.toLowerCase();
      const desc = opts.describe?.(facet.key, v.value) ?? null;
      const inVal = val.includes(q);
      const inDesc = desc ? desc.toLowerCase().includes(q) : false;
      if (!inVal && !inDesc) continue;
      const m: ValueMatch = { key: facet.key, label, value: v.value, count: v.count, desc };
      if (val.startsWith(q)) prefix.push(m);
      else substr.push(m);
    }
  }
  const byCount = (a: ValueMatch, b: ValueMatch): number => b.count - a.count;
  prefix.sort(byCount);
  substr.sort(byCount);
  return [...prefix, ...substr].slice(0, opts.limit ?? DEFAULT_MATCH_LIMIT);
}
