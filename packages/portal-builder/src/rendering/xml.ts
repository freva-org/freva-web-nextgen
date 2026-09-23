// A strict, small XML reader for exactly two things: project-supplied SVG and the SVG the
// pinned diagram transform emits. Strict on purpose: in front of a sanitizer, "what the parser
// thought" and "what a browser will think" have to agree, so anything it cannot read exactly is
// rejected with a diagnostic rather than repaired into something plausible.

import type { HElement, HNode } from "./html.js";

export class XmlError extends Error {}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body];
    return named ?? whole;
  });
}

const NAME = /[A-Za-z_:][A-Za-z0-9_:.-]*/y;

/** Parse a document into element/text nodes. Comments, PIs and doctypes are dropped. */
export function parseXml(source: string): HNode[] {
  let i = 0;
  const root: HElement = { type: "element", tag: "#root", attrs: [], children: [] };
  const stack: HElement[] = [root];

  const top = (): HElement => stack[stack.length - 1]!;

  const readName = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(source);
    if (!m || m.index !== i) throw new XmlError(`Expected a name at offset ${i}`);
    i = NAME.lastIndex;
    return m[0];
  };

  const skipSpace = (): void => {
    while (i < source.length && /\s/.test(source[i]!)) i++;
  };

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      const rest = source.slice(i);
      if (rest.trim()) top().children.push({ type: "text", value: decodeEntities(rest) });
      break;
    }
    if (lt > i) {
      const text = source.slice(i, lt);
      if (text.trim() || top().tag !== "#root") {
        top().children.push({ type: "text", value: decodeEntities(text) });
      }
      i = lt;
    }
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end === -1) throw new XmlError("Unterminated comment");
      i = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      if (end === -1) throw new XmlError("Unterminated CDATA section");
      top().children.push({ type: "text", value: source.slice(i + 9, end) });
      i = end + 3;
      continue;
    }
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end === -1) throw new XmlError("Unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (source.startsWith("<!", i)) {
      // DOCTYPE and friends, including an internal subset.
      let depth = 0;
      let j = i + 2;
      for (; j < source.length; j++) {
        const c = source[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      if (j >= source.length) throw new XmlError("Unterminated declaration");
      i = j + 1;
      continue;
    }
    if (source.startsWith("</", i)) {
      i += 2;
      const name = readName();
      skipSpace();
      if (source[i] !== ">") throw new XmlError(`Malformed closing tag </${name}`);
      i++;
      const open = stack.pop();
      if (!open || open.tag !== name || stack.length === 0) {
        throw new XmlError(`Mismatched closing tag </${name}>`);
      }
      continue;
    }

    i++; // '<'
    const tag = readName();
    const element: HElement = { type: "element", tag, attrs: [], children: [] };
    for (;;) {
      skipSpace();
      if (i >= source.length) throw new XmlError(`Unterminated tag <${tag}`);
      if (source.startsWith("/>", i)) {
        i += 2;
        top().children.push(element);
        break;
      }
      if (source[i] === ">") {
        i++;
        top().children.push(element);
        stack.push(element);
        break;
      }
      const attrName = readName();
      skipSpace();
      if (source[i] !== "=") throw new XmlError(`Attribute ${attrName} has no value`);
      i++;
      skipSpace();
      const quote = source[i];
      if (quote !== '"' && quote !== "'") throw new XmlError(`Attribute ${attrName} is not quoted`);
      i++;
      const end = source.indexOf(quote, i);
      if (end === -1) throw new XmlError(`Unterminated value for ${attrName}`);
      element.attrs.push([attrName, decodeEntities(source.slice(i, end))]);
      i = end + 1;
    }
  }

  if (stack.length !== 1) throw new XmlError(`Unclosed element <${top().tag}>`);
  return root.children;
}
