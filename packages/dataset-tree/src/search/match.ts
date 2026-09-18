// search/match.ts - normalisation and deterministic ranking, shared by every search surface, and
// reachable from the core entry because the component itself has to rank results. The strict index
// parser lives in `search/parse.ts` behind its own entry point, so a consumer that never validates
// an index does not carry a validator. Nothing here cares where an entry came from: a loaded node
// and an index entry rank by the same rules, the only reason a list mixing the two can be ordered.

import type { DatasetTreeNode, DatasetTreeSearchIndexEntry } from "../types.js";

/**
 * The lowercase forms a query is compared against, computed once: a 200,000-entry index
 * re-lowercased on every keystroke is 600,000 string allocations per character typed, where one
 * pass at accept time leaves each keystroke scanning already-normalised strings.
 */
export interface SearchableText {
  readonly name: string;
  readonly title: string;
  readonly path: string;
  /** The path split on `/`, lowercased, for the exact-segment rank. Empty when there is no path. */
  readonly segments: readonly string[];
}

/**
 * How well something matched, as a small integer; lower is better. The order is the one a person
 * would use by hand: the thing you named, the thing you started to name, the directory you named,
 * the friendly title, then anything that merely contains what you typed. A fixed ladder, not a
 * weighted score, so "why is that fifth?" always has an answer.
 */
export const RANK = {
  exactName: 0,
  namePrefix: 1,
  exactSegment: 2,
  title: 3,
  substring: 4,
  none: 5,
} as const;

export type SearchRank = (typeof RANK)[keyof typeof RANK];

const EMPTY_SEGMENTS: readonly string[] = Object.freeze([]);

function segmentsOf(path: string): readonly string[] {
  if (path.length === 0) return EMPTY_SEGMENTS;
  const out: string[] = [];
  for (const part of path.split("/")) if (part.length > 0) out.push(part);
  return out;
}

/** Normalise the three searchable strings of anything that has them. */
export function searchableOf(value: {
  name?: string;
  title?: string;
  path?: string;
}): SearchableText {
  const name = typeof value.name === "string" ? value.name.toLowerCase() : "";
  const title = typeof value.title === "string" ? value.title.toLowerCase() : "";
  const path = typeof value.path === "string" ? value.path.toLowerCase() : "";
  return { name, title, path, segments: segmentsOf(path) };
}

/**
 * Loaded nodes are normalised lazily and remembered against the node object itself. A loaded tree
 * is small - it is what somebody opened - so a build pass gains nothing, and keying the cache on
 * the object makes a node replaced by a reload a miss and collects a dropped one with its entry.
 */
const nodeCache = new WeakMap<DatasetTreeNode, SearchableText>();

export function searchableOfNode(node: DatasetTreeNode): SearchableText {
  let found = nodeCache.get(node);
  if (found === undefined) {
    found = searchableOf(node);
    nodeCache.set(node, found);
  }
  return found;
}

/**
 * Rank one candidate against an already-lowercased query. `RANK.none` means it did not match at
 * all; every other value means it did, and orders it.
 */
export function rankOf(text: SearchableText, query: string): SearchRank {
  if (query.length === 0) return RANK.none;
  if (text.name === query) return RANK.exactName;
  if (text.name.startsWith(query)) return RANK.namePrefix;
  for (const segment of text.segments) {
    if (segment === query) return RANK.exactSegment;
  }
  if (text.title.length > 0 && text.title.includes(query)) return RANK.title;
  if (text.name.includes(query) || text.path.includes(query)) return RANK.substring;
  return RANK.none;
}

/**
 * The final tie-breaker: path, then name, then id, compared by code point rather than a locale
 * collator, for the same reason timestamps are UTC - two people looking at the same archive should
 * see the same order, and `Intl.Collator` orders `Z` and `ä` differently by locale.
 */
export function compareTieBreak(
  a: { text: SearchableText; id: string },
  b: { text: SearchableText; id: string },
): number {
  const aKey = a.text.path.length > 0 ? a.text.path : a.text.name;
  const bKey = b.text.path.length > 0 ? b.text.path : b.text.name;
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** One index entry with its normalised text, produced once when the index is accepted. */
export interface PreparedSearchEntry {
  readonly entry: DatasetTreeSearchIndexEntry;
  readonly text: SearchableText;
}

/** Normalise a whole index. Called once, at mount; everything after that is a scan of these. */
export function prepareSearchEntries(
  entries: readonly DatasetTreeSearchIndexEntry[],
): readonly PreparedSearchEntry[] {
  const out: PreparedSearchEntry[] = new Array(entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    out[i] = { entry, text: searchableOf(entry) };
  }
  return out;
}

/** Normalise a query the same way the haystacks were normalised. */
export function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}
