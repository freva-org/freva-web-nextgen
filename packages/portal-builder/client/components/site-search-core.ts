// The header search's matching and ranking, with no DOM, so it tests on its own.
// `site-search.ts` is the island that draws it.

export interface Entry {
  u: string;
  t: string;
  h?: string;
  a?: string;
  x: string;
  p?: string;
}

export interface Prepared extends Entry {
  nt: string;
  nh: string;
  nx: string;
}

export interface Hit {
  entry: Prepared;
  score: number;
}

export const MAX_RESULTS = 20;
const SNIPPET = 160;

/** Case- and accent-insensitive form, the same on both sides of every comparison. */
export function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function terms(query: string): string[] {
  return [
    ...new Set(
      normalize(query)
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((term) => term.length > 0),
    ),
  ];
}

export function prepare(entries: Entry[]): Prepared[] {
  return entries.map((entry) => ({
    ...entry,
    nt: normalize(entry.t),
    nh: normalize(entry.h ?? ""),
    nx: normalize(entry.x),
  }));
}

/** Where a term starts a word: `rem` matches `remapping` strongly, `apping` weakly. */
function wordStart(haystack: string, term: string): boolean {
  let at = haystack.indexOf(term);
  while (at !== -1) {
    if (at === 0 || !/[\p{L}\p{N}_]/u.test(haystack[at - 1]!)) return true;
    at = haystack.indexOf(term, at + 1);
  }
  return false;
}

/**
 * Every term must match somewhere in the entry. Title matches weigh most, then the section
 * heading, then the text; a match at the start of a word weighs more than one inside a word.
 */
export function search(entries: Prepared[], query: string): Hit[] {
  const wanted = terms(query);
  if (wanted.length === 0 || wanted.join("").length < 2) return [];
  const hits: Hit[] = [];
  for (const entry of entries) {
    let score = 0;
    let all = true;
    for (const term of wanted) {
      let found = 0;
      if (entry.nt.includes(term)) found += wordStart(entry.nt, term) ? 12 : 6;
      if (entry.nh.includes(term)) found += wordStart(entry.nh, term) ? 8 : 4;
      if (entry.nx.includes(term)) found += wordStart(entry.nx, term) ? 2 : 1;
      if (found === 0) {
        all = false;
        break;
      }
      score += found;
    }
    // The page's own first section ranks above its sub-sections for a title match.
    if (all) hits.push({ entry, score: score + (entry.h ? 0 : 1) });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (a.entry.t < b.entry.t ? -1 : a.entry.t > b.entry.t ? 1 : 0) ||
      ((a.entry.h ?? "") < (b.entry.h ?? "") ? -1 : (a.entry.h ?? "") > (b.entry.h ?? "") ? 1 : 0),
  );
  return hits.slice(0, MAX_RESULTS);
}

/** A window of the entry's text around its first match. */
export function snippet(text: string, wanted: string[]): string {
  const lower = normalize(text);
  const at = Math.min(...wanted.map((t) => lower.indexOf(t)).filter((i) => i >= 0), Infinity);
  if (!Number.isFinite(at) || text.length <= SNIPPET) return text.slice(0, SNIPPET);
  const start = Math.max(0, at - 40);
  const cut = text.slice(start, start + SNIPPET);
  return `${start > 0 ? "…" : ""}${cut}${start + SNIPPET < text.length ? "…" : ""}`;
}
