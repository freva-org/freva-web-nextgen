/**
 * highlight.ts - Python syntax highlighting, as DOM nodes.
 *
 * Prism's core plus its `clike` and `python` grammars and nothing else: 4.8 KiB gzipped, where
 * importing `prismjs` whole brings every language it ships. A hand-rolled Python tokeniser gets
 * f-strings, triple quotes, raw strings and nested brackets wrong on somebody's real code.
 *
 * The output is NODES, never markup: `Prism.tokenize()` returns a token tree, walked here into
 * `createElement`/`createTextNode`, where `Prism.highlight()`'s HTML string would rest this
 * console's safety on Prism's escaping being complete for a grammar this package neither owns nor
 * tests. Highlighting is PURELY VISUAL - the authoritative command is the plain source string the
 * adapter holds, and nothing produced here is ever read back as input.
 */

import Prism from "prismjs/components/prism-core.js";
import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-python.js";

/**
 * Prism's token names, mapped onto this package's OWN class names. The indirection is the theming
 * contract: Prism's categories are Prism's to rename, and a consumer styling `.token.keyword`
 * would depend on a third party's internals. Every class emitted here is `bp-tok-*`.
 */
const TOKEN_CLASS: Readonly<Record<string, string>> = {
  comment: "bp-tok-comment",
  "triple-quoted-string": "bp-tok-string",
  string: "bp-tok-string",
  "string-interpolation": "bp-tok-string",
  interpolation: "bp-tok-string",
  keyword: "bp-tok-keyword",
  builtin: "bp-tok-builtin",
  boolean: "bp-tok-keyword",
  number: "bp-tok-number",
  "class-name": "bp-tok-class",
  function: "bp-tok-function",
  decorator: "bp-tok-function",
  operator: "bp-tok-operator",
  punctuation: "bp-tok-punctuation",
};

const UNKNOWN_TOKEN_CLASS = "bp-tok-other";

export function highlightingAvailable(): boolean {
  return Boolean(Prism?.languages?.python);
}

type PrismToken = string | { type: string; content: unknown; alias?: string | string[] };

/**
 * Tokenise `source` and append the result to `target` as text and `<span>` nodes. Returns the
 * number of characters emitted, which the caller compares against `source.length`: a tokeniser
 * that dropped or duplicated one character would render text that no longer lines up with the
 * caret, and that silent visual drift gets blamed on the terminal for weeks.
 */
export function appendHighlighted(target: Node, source: string, doc: Document): number {
  if (source === "") return 0;
  if (!highlightingAvailable()) {
    target.appendChild(doc.createTextNode(source));
    return source.length;
  }
  let tokens: PrismToken[];
  try {
    tokens = Prism.tokenize(source, Prism.languages.python) as PrismToken[];
  } catch {
    // A grammar failure must degrade to plain text, never to a missing command.
    target.appendChild(doc.createTextNode(source));
    return source.length;
  }
  return appendTokens(target, tokens, doc);
}

function appendTokens(target: Node, tokens: PrismToken[], doc: Document): number {
  let emitted = 0;
  for (const token of tokens) {
    if (typeof token === "string") {
      target.appendChild(doc.createTextNode(token));
      emitted += token.length;
      continue;
    }
    const span = doc.createElement("span");
    const alias = Array.isArray(token.alias) ? token.alias[0] : token.alias;
    const mapped = TOKEN_CLASS[token.type] ?? (alias ? TOKEN_CLASS[alias] : undefined);
    span.classList.add(mapped ?? UNKNOWN_TOKEN_CLASS);
    emitted += appendContent(span, token.content, doc);
    target.appendChild(span);
  }
  return emitted;
}

/** A token's content is a string, a nested token, or an array of either. */
function appendContent(target: Node, content: unknown, doc: Document): number {
  if (typeof content === "string") {
    target.appendChild(doc.createTextNode(content));
    return content.length;
  }
  if (Array.isArray(content)) return appendTokens(target, content as PrismToken[], doc);
  if (content && typeof content === "object") {
    return appendTokens(target, [content as PrismToken], doc);
  }
  return 0;
}

/**
 * A standalone element holding highlighted source, for a submitted command in the transcript.
 * Assistive technology sees one coherent string: the spans carry no roles, no labels and no
 * `aria-hidden`, so the container's accessible name is the command exactly as typed. Colour is
 * never the only signal - the prompt prefix marks a command whether or not highlighting rendered.
 */
export function highlightedElement(source: string, doc: Document): HTMLElement {
  const span = doc.createElement("span");
  span.className = "bp-python";
  const emitted = appendHighlighted(span, source, doc);
  if (emitted !== source.length) {
    // The tokeniser and the source disagree. Rather than render something that no longer matches
    // what will be executed, fall back to plain text - always correct, just plainer.
    span.replaceChildren(doc.createTextNode(source));
  }
  return span;
}

/**
 * The token class for every character of `source`, or `null` where a character has none.
 *
 * This is what makes LIVE highlighting possible without touching the input: the surface owns the
 * command line and re-renders it on every keystroke, one element per character, so colouring it
 * adds a class to elements that already exist rather than replacing markup the surface is about
 * to rebuild - and rather than putting Python source near `innerHTML` or the library's own
 * `[[ ]]` formatting syntax. Returns `null` for the whole source unless the tokens account for
 * exactly `source.length` characters, because a mapping off by one paints the wrong character.
 */
export function tokenClassesPerCharacter(source: string): Array<string | null> | null {
  if (source === "" || !highlightingAvailable()) return null;
  let tokens: PrismToken[];
  try {
    tokens = Prism.tokenize(source, Prism.languages.python) as PrismToken[];
  } catch {
    return null;
  }
  const classes: Array<string | null> = [];
  walk(tokens, null, classes);
  return classes.length === source.length ? classes : null;
}

/** Depth-first, innermost class wins - the same precedence the nested `<span>`s produce. */
function walk(tokens: PrismToken[], inherited: string | null, out: Array<string | null>): void {
  for (const token of tokens) {
    if (typeof token === "string") {
      for (let i = 0; i < token.length; i += 1) out.push(inherited);
      continue;
    }
    const alias = Array.isArray(token.alias) ? token.alias[0] : token.alias;
    const mapped =
      TOKEN_CLASS[token.type] ?? (alias ? TOKEN_CLASS[alias] : undefined) ?? UNKNOWN_TOKEN_CLASS;
    const { content } = token;
    if (typeof content === "string") {
      for (let i = 0; i < content.length; i += 1) out.push(mapped);
    } else if (Array.isArray(content)) {
      walk(content as PrismToken[], mapped, out);
    } else if (content && typeof content === "object") {
      walk([content as PrismToken], mapped, out);
    }
  }
}
