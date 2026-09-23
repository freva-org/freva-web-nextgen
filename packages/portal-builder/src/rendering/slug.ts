// The package-owned heading slug algorithm.
//
// Anchors are a compatibility promise, so the algorithm lives in the profile rather than in
// whichever slug library is installed. Unicode-aware - decompose, drop marks, keep letters and
// numbers - so a German or Greek heading gets a stable anchor instead of an empty one.

import type { ContentProfile } from "./profile.js";

export function slugify(text: string, profile: ContentProfile): string {
  const rules = profile.headings.slug;
  let s = text.normalize(rules.unicodeNormalization as "NFKD");
  if (rules.caseFold === "lowercase") s = s.toLowerCase();
  s = s.replace(/\p{M}+/gu, "");
  s = s.replace(/\s+/gu, rules.whitespaceReplacement);
  const keep = new RegExp(`[^${rules.keep}${rules.whitespaceReplacement}]`, "gu");
  s = s.replace(keep, "");
  const sep = rules.whitespaceReplacement;
  s = s.replace(new RegExp(`${sep}{2,}`, "g"), sep);
  s = s.replace(new RegExp(`^${sep}+|${sep}+$`, "g"), "");
  if (s.length > rules.maxLength) {
    s = s.slice(0, rules.maxLength).replace(new RegExp(`${sep}+$`), "");
  }
  return s === "" ? rules.emptyFallback : s;
}

/** Stable numeric suffixes, so a duplicated heading never steals another's anchor. */
export class SlugRegistry {
  private readonly seen = new Map<string, number>();

  constructor(private readonly profile: ContentProfile) {}

  next(text: string): string {
    const base = slugify(text, this.profile);
    const count = this.seen.get(base) ?? 1;
    this.seen.set(base, count + 1);
    if (count === 1) return base;
    const start = this.profile.headings.slug.duplicateStart;
    return `${base}-${count + start - 2}`;
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }
}
