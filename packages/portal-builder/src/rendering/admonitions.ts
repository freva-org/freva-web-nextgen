// The admonition vocabulary.
//
// Consumers arrive with documentation written for MkDocs, MyST, GitHub or Docutils, and every
// one spells an admonition differently, so the portal accepts all of those spellings and
// normalizes them into one internal kind. The list is closed and its aliases are explicit: a
// closed list lets the theme own an icon and a colour per kind, and explicit aliases let
// `hint` and `tip` look the same. An unknown but otherwise safe type does not fail the build
// and does not lose the author's words: it renders as a neutral admonition titled with the
// word the author wrote, because a build that stops over `:::musing` turns a styling question
// into an outage.

/** The semantic kinds the theme styles. */
export const ADMONITION_KINDS = [
  "note",
  "abstract",
  "info",
  "tip",
  "success",
  "question",
  "warning",
  "failure",
  "danger",
  "bug",
  "example",
  "quote",
] as const;

export type AdmonitionKind = (typeof ADMONITION_KINDS)[number];

/**
 * Every accepted spelling, mapped to its kind. The groupings follow the Material for MkDocs
 * vocabulary that most of this documentation is written against: `summary` reads as
 * `abstract`, `hint` as `tip`, `caution` as `warning`, `error` as `danger`. The alias is kept
 * in the rendered output as the *title*, so a `caution` still says "Caution" while drawn as a
 * warning.
 */
const ALIASES: Record<string, AdmonitionKind> = {
  note: "note",
  seealso: "note",
  "see-also": "note",
  abstract: "abstract",
  summary: "abstract",
  tldr: "abstract",
  info: "info",
  information: "info",
  todo: "info",
  tip: "tip",
  hint: "tip",
  important: "tip",
  success: "success",
  check: "success",
  done: "success",
  question: "question",
  help: "question",
  faq: "question",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  failure: "failure",
  fail: "failure",
  missing: "failure",
  danger: "danger",
  error: "danger",
  bug: "bug",
  example: "example",
  bugreport: "bug",
  quote: "quote",
  cite: "quote",
};

export interface ResolvedAdmonition {
  /** The kind the theme draws. */
  kind: AdmonitionKind;
  /** The default title, which is the author's own word when it was unknown. */
  title: string;
  /** False when the type was not in the vocabulary and fell back to neutral. */
  known: boolean;
}

/** A name safe to put in a class attribute and a title. */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,48}$/;

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Resolve an authored type name. Unknown-but-safe names become `note` with their own word as
 * the title, so nothing the author wrote is lost. An unsafe name - one that could not be a
 * class or a heading - also falls back, with the neutral word as its title, because the
 * alternative is putting unvalidated text where a class name goes.
 */
export function resolveAdmonition(rawName: string): ResolvedAdmonition {
  const name = rawName.trim();
  const key = name.toLowerCase().replace(/[\s_-]+/g, "");
  const direct = ALIASES[name.toLowerCase()] ?? ALIASES[key];
  if (direct) return { kind: direct, title: titleCase(name), known: true };
  if (SAFE_NAME.test(name)) return { kind: "note", title: titleCase(name), known: false };
  return { kind: "note", title: "Note", known: false };
}

/** Every spelling the profile advertises, sorted, for documentation and tests. */
export function admonitionAliases(): string[] {
  return Object.keys(ALIASES).sort();
}

/** True when this name is one the vocabulary knows. */
export function isKnownAdmonition(name: string): boolean {
  return resolveAdmonition(name).known;
}
