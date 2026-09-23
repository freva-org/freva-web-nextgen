// Containment for the embedded catalogue's stylesheet.
//
// The portal serves the STAC Browser's compiled CSS out of its own artifact, into its own
// document, beside its own shell. Upstream imports the whole of Bootstrap, whose reboot is
// written for a document Bootstrap owns: it styles `*`, `:root`, `a`, `h1`-`h6`, `p`, `ul`,
// `button`, `img`, `svg`, `code` and `[hidden]` by element name, with no class and no scope, so
// in the portal's document those selectors restyle the shell's header, navigation, footer and
// prose. Measured on a built example portal with the catalogue loaded, 27 selectors match
// elements outside the mount: `*` (357 nodes, `box-sizing`), `:root` (`scroll-behavior`), `a`
// (33 nodes, colour and underline), `button` (12 nodes, radius, margin, font and `appearance`),
// `img` and `svg` (35 nodes, `vertical-align`), and Bootstrap's `.badge` on a `button.badge`.
//
// It is done in the builder and not in the recipe. The preparation stage - the
// `@freva-org/stac-browser` workspace's own build step - keeps a pass of its own that rewrites
// `:root`, `html` and `body`, because it is the stage that knows Bootstrap's theme blocks and
// why the dark one has to keep an id's worth of specificity. (The path is spelled out that way
// deliberately: `tests/no-runtime-preparation.test.mjs` refuses any literal reference to the
// preparation scripts in the builder's shipped `dist/`, and a comment is a reference as far as
// a text search is concerned.) Containment, though, is a property of the HOST DOCUMENT - which
// element the application is mounted into, and what else is on the page with it - and the
// builder owns both. Doing it here also contains a deployment holding materials prepared by an
// earlier recipe by upgrading the builder alone, rather than re-fetching and recompiling an
// 800-dependency upstream application.
//
// `:where()` rather than a bare `#stac-browser-mount ` prefix: an id on every selector in a
// 300 KB third-party stylesheet would rewrite the cascade inside the embed, where Bootstrap's
// `.btn { text-decoration: none }` at one class must keep beating its own
// `a:hover { text-decoration: underline }` at one class and one element. `:where()` has zero
// specificity, so every rule matches exactly the elements it matched INSIDE the mount at exactly
// the weight it carried; the only difference is outside, which is nothing. The
// `:root`/`html`/`body` family is the exception and is REPLACED rather than prefixed, because
// those select an ancestor of the mount: replacing them with the mount keeps Bootstrap's
// variables declared on an element the application is inside, deliberately in the id form - see
// `scopeDocumentSelector`.

import postcss, { type Rule } from "postcss";

/** The element the portal mounts the application into; the recipe's `output.mountId`. */
export const STAC_MOUNT_ID = "stac-browser-mount";

const MOUNT = `#${STAC_MOUNT_ID}`;

/**
 * A selector that already names the embed's root is left alone. `#stac-browser-mount …` and
 * `#stac-browser …` both end at an element inside the mount, so prefixing them again would give
 * `:where(#stac-browser-mount) #stac-browser-mount`, which matches nothing because the mount is
 * not inside itself - that is how a containment pass silently deletes a stylesheet.
 */
const namesTheEmbed = (selector: string) => selector.includes("#stac-browser");

/**
 * `:host` is left alone too. It matches only from inside a shadow tree's own stylesheet, so in
 * a document stylesheet it already matches nothing - and a descendant combinator in front of it
 * would not be a narrower selector, just a differently broken one.
 */
const isShadowHost = (selector: string) => selector.includes(":host");

/** The leading `:root` / `html` / `body` compound, if the selector opens with one. */
const DOCUMENT_HEAD = /^(:root|html|body)(?![\w-])/;

/**
 * Split a selector list on commas that are not inside brackets or quotes. PostCSS's own
 * `rule.selectors` does this, but it is reimplemented for the one case it cannot know about: a
 * minified stylesheet whose selector list is re-joined here, where the separator has to be
 * exactly a comma and the parts have to come back in source order.
 */
export function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const char of list) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Rewrite one selector so it cannot match anything outside the mount, in one of two shapes
 * depending on whether it names the DOCUMENT or something in it.
 *
 * A selector opening with `:root`, `html` or `body` names an ancestor of the mount and cannot
 * be prefixed - `:where(#stac-browser-mount) body` matches nothing - so the document element is
 * REPLACED by the mount and the rest of the compound kept: `body.sidebar .drawer` becomes
 * `#stac-browser-mount.sidebar .drawer`. The id form is required, not `:where()`: upstream
 * declares its light theme on `:root,[data-bs-theme=light]` and its dark theme on
 * `[data-bs-theme=dark]` at equal specificity, so source order decides and dark wins, and
 * giving the light block an id but not the dark one leaves everything driven by a Bootstrap
 * variable silently light. Both blocks land on the same element here, so both are rewritten the
 * same way; a leading `[data-bs-theme=…]` is CONCATENATED rather than descended into, because
 * Bootstrap sets that attribute on the element it themes. Everything else is prefixed with
 * `:where(#stac-browser-mount) `, which adds a containment requirement and no specificity.
 */
export function scopeSelector(selector: string): string {
  const trimmed = selector.trim();
  if (!trimmed) return selector;
  if (namesTheEmbed(trimmed) || isShadowHost(trimmed)) return trimmed;
  if (/^\[data-bs-theme/.test(trimmed)) return `${MOUNT}${trimmed}`;
  const head = DOCUMENT_HEAD.exec(trimmed)?.[1];
  if (head) return `${MOUNT}${trimmed.slice(head.length)}`;
  return `:where(${MOUNT}) ${trimmed}`;
}

/** A rule inside `@keyframes` is a step - `from`, `to`, `42%` - and is not a selector. */
function insideKeyframes(rule: Rule): boolean {
  for (let node = rule.parent; node; node = (node as { parent?: unknown }).parent as never) {
    const at = node as { type?: string; name?: string };
    if (at.type === "atrule" && /(^|-)keyframes$/i.test(at.name ?? "")) return true;
  }
  return false;
}

/**
 * A selector that can still match outside the mount after the pass has run. The check is
 * deliberately not "did the rewrite change the string", since a rewrite that produced something
 * unmatchable would also have changed it: the result must NAME the mount, or be a shadow-tree
 * selector that cannot match in a document at all.
 */
export function escapesTheMount(selector: string): boolean {
  const trimmed = selector.trim();
  if (!trimmed) return false;
  return !namesTheEmbed(trimmed) && !isShadowHost(trimmed);
}

export interface ContainmentResult {
  /** The rewritten stylesheet. */
  css: string;
  /** How many selectors were rewritten. */
  scoped: number;
  /** Selectors that could still reach the host document; empty when the pass succeeded. */
  escaped: string[];
}

/**
 * Contain one stylesheet from the prepared materials. The parse is a real CSS parse rather than
 * a regular expression over the text: an expression anchored on `(^|[},])` cannot see a rule
 * that opens an at-rule block - `@media (prefers-reduced-motion: no-preference){:root{scroll-
 * behavior: smooth}}`, preceded by `{` - and that is one of the 27 measured reaching the shell.
 *
 * Unparseable input is returned UNCHANGED with the failure recorded rather than thrown, because
 * a stylesheet this cannot read is one it must not rewrite; `verifyContainment` is what refuses
 * to ship it.
 */
export function containStylesheet(css: string): ContainmentResult {
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    return { css, scoped: 0, escaped: ["<unparseable stylesheet>"] };
  }
  let scoped = 0;
  root.walkRules((rule) => {
    if (insideKeyframes(rule)) return;
    const list = splitSelectorList(rule.selector).map((part) => part.trim());
    const next = list.map(scopeSelector);
    if (next.join(",") === list.join(",")) return;
    for (let i = 0; i < list.length; i += 1) if (next[i] !== list[i]) scoped += 1;
    rule.selector = next.join(",");
  });
  const out = root.toString();
  return { css: out, scoped, escaped: findEscapes(out) };
}

/** Every selector in a stylesheet that can match outside the mount. */
export function findEscapes(css: string): string[] {
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    return ["<unparseable stylesheet>"];
  }
  const escaped: string[] = [];
  root.walkRules((rule) => {
    if (insideKeyframes(rule)) return;
    for (const selector of splitSelectorList(rule.selector)) {
      if (escapesTheMount(selector)) escaped.push(selector.trim());
    }
  });
  return escaped;
}
