// The site-wide search index (`chrome.header.search`), built with the artifact. No search
// service: one static, content-hashed JSON file, in the manifests and `checksums.sha256`, fetched
// same-origin on first use, so the CSP needs only the `connect-src 'self'` it already has.
//
// One entry per page SECTION (split at the table-of-contents headings), so a result lands on the
// heading that matched and its snippet comes from that section.
//
// Deterministic: routes in model order, sections in document order, text from the sanitized HTML
// the page ships, no locale-dependent step.

import { createHash } from "node:crypto";
import { parseFragment } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { ResolvedRoute } from "./types.js";

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

/** One searchable section. Short keys: this file is fetched by every reader who searches. */
export interface SearchEntry {
  /** The page's URL, base-path-aware. */
  u: string;
  /** The page's title. */
  t: string;
  /** The section's heading, absent for the text before the first heading. */
  h?: string;
  /** The heading's id, for `#anchor`. */
  a?: string;
  /** The section's text, whitespace-collapsed. */
  x: string;
  /** Where the page sits: its section-navigation title, when it has one. */
  p?: string;
  s?: string;
}

export interface SearchIndexDocument {
  v: 1;
  entries: SearchEntry[];
}

/** Elements whose text is not prose a reader would search for. */
const SKIP_CLASSES = [
  "katex-mathml", // the hidden MathML copy of a formula
  "katex-html", // the drawn formula: glyphs, not words
  "portal-heading-anchor",
  "portal-code-lang", // the language label above a code block
  "portal-footnote-back",
  "portal-code-copy",
  "portal-diagram",
  "portal-visually-hidden",
];
const SKIP_TAGS = new Set(["svg", "button", "script", "style", "template", "math"]);
const BLOCK_TAGS = new Set([
  "p",
  "li",
  "dt",
  "dd",
  "pre",
  "td",
  "th",
  "caption",
  "figcaption",
  "blockquote",
  "div",
  "section",
  "aside",
  "summary",
  "details",
  "tr",
  "br",
]);
/** Headings that start a new entry: the table of contents' depth. */
const SECTION_TAGS = new Set(["h2", "h3"]);
/** Per-section ceiling. A generated reference page must not make every reader download itself. */
const MAX_SECTION_CHARS = 8000;

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

function skipped(element: Element): boolean {
  if (SKIP_TAGS.has(element.tagName)) return true;
  const classes = (attr(element, "class") ?? "").split(/\s+/);
  return classes.some((c) => SKIP_CLASSES.includes(c));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textOf(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterTypes.TextNode).value;
  if (!("childNodes" in node)) return "";
  const element = node as Element;
  if (element.tagName && skipped(element)) return "";
  const inner = (element.childNodes ?? []).map(textOf).join("");
  return BLOCK_TAGS.has(element.tagName) ? ` ${inner} ` : inner;
}

/** Split one page's HTML into its sections. */
export function sectionsOf(html: string): { heading?: string; id?: string; text: string }[] {
  const fragment = parseFragment(html);
  const sections: { heading?: string; id?: string; parts: string[] }[] = [{ parts: [] }];
  const walk = (nodes: Node[]): void => {
    for (const node of nodes) {
      const element = node as Element;
      if (element.tagName && SECTION_TAGS.has(element.tagName)) {
        const id = attr(element, "id");
        sections.push({
          heading: collapse(textOf(element)),
          ...(id ? { id } : {}),
          parts: [],
        });
        continue;
      }
      if (element.tagName && skipped(element)) continue;
      // Descend into containers so a heading nested in a `<section>` still splits.
      if (element.tagName && element.childNodes?.some((child) => containsHeading(child))) {
        walk(element.childNodes);
        continue;
      }
      sections[sections.length - 1]!.parts.push(textOf(node));
    }
  };
  walk(fragment.childNodes);
  return sections
    .map((section) => ({
      ...(section.heading ? { heading: section.heading } : {}),
      ...(section.id ? { id: section.id } : {}),
      text: collapse(section.parts.join(" ")).slice(0, MAX_SECTION_CHARS),
    }))
    .filter((section) => section.heading || section.text);
}

function containsHeading(node: Node): boolean {
  const element = node as Element;
  if (!element.tagName) return false;
  if (SECTION_TAGS.has(element.tagName)) return true;
  return (element.childNodes ?? []).some(containsHeading);
}

/** Build the index document for every content page. */
export function buildSearchIndex(
  routes: readonly ResolvedRoute[],
  basePath: string,
  sectionOf?: (route: ResolvedRoute) => string | undefined,
): SearchIndexDocument {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const entries: SearchEntry[] = [];
  for (const route of routes) {
    if (route.kind !== "content" || !route.content) continue;
    const url = `${base}${route.path}`;
    const place = route.sectionNavigation?.title;
    const group = sectionOf?.(route);
    const description = route.description ? `${route.description} ` : "";
    sectionsOf(route.content.html).forEach((section, index) => {
      entries.push({
        u: url,
        t: route.title,
        ...(section.heading ? { h: section.heading } : {}),
        ...(section.id ? { a: section.id } : {}),
        // The description leads the page's first entry: it is what the author said the page is.
        x: index === 0 ? collapse(`${description}${section.text}`) : section.text,
        ...(place && place !== route.title ? { p: place } : {}),
        ...(group ? { s: group } : {}),
      });
    });
  }
  return { v: 1, entries };
}

export function searchFacets(document: SearchIndexDocument): { label: string; count: number }[] {
  const pages = new Map<string, Set<string>>();
  for (const entry of document.entries) {
    if (!entry.s) continue;
    const set = pages.get(entry.s) ?? new Set<string>();
    set.add(entry.u);
    pages.set(entry.s, set);
  }
  return [...pages]
    .map(([label, set]) => ({ label, count: set.size }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/**
 * The published file: bytes, and a name carrying an 8-character content hash, so the file is in
 * the `immutable` cache class the manifest already gives content-hashed framework output.
 */
export function publishSearchIndex(
  document: SearchIndexDocument,
  basePath: string,
): { file: string; url: string; bytes: Buffer } {
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  const hash = createHash("sha256").update(bytes).digest("base64url").slice(0, 8);
  const file = `_portal/search-index.${hash}.json`;
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return { file, url: `${base}/${file}`, bytes };
}

/**
 * The header search's evidence registration. With search off, its island, its stylesheet or an
 * index file anywhere in the artifact is `FP1601`/`FP1602`: "nothing is shipped when it is
 * disabled" is checked against the build graph and the emitted files, not assumed.
 */
export const SITE_SEARCH_EVIDENCE = {
  id: "site-search",
  kind: "site-search" as const,
  ownedModuleRoots: [
    // A prefix: the island, its DOM-free core and its stylesheet.
    "builder:client/components/site-search",
  ],
  ownedStaticRoots: [] as string[],
  ownedEmittedNames: ["search-index."],
  assetNamespaces: [] as string[],
  allowedSharedModules: ["builder:client/shell.ts"],
};
