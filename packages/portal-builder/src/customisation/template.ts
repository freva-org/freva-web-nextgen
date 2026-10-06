// portal-template-v1: restricted markup for named slots, rendered at build time.
//
// The language is HTML plus four constructs - `{{ field }}`,
// `{% if field %}…{% else %}…{% endif %}`, `{% for x in list %}…{% endfor %}` and
// `{% part "name" %}` - over a typed, read-only context. The
// markup is parsed BEFORE anything is interpolated: template syntax is replaced by same-length
// sentinels, parse5 builds the tree, and values are then written into text nodes and attribute
// values only, so a value can never become markup, a tag, an attribute name or template syntax.
// The result goes through the content sanitizer with a slot profile and is serialized by the
// builder's own serializer. Sealed parts are framework markup the template only places.

import { parseFragment } from "parse5";
import type { Diagnostic, SourcePosition } from "../diagnostics.js";
import { CREDENTIAL_PATTERN } from "../model/credentials.js";
import { h, sanitize, serialize, t, type HElement, type HNode } from "../rendering/html.js";
import type { ContentProfile } from "../rendering/profile.js";
import { sanitizeSvg } from "../rendering/svg.js";
import type { FieldType, SlotsApi, SlotSpec } from "./api.js";

const MAX_TEMPLATE_BYTES = 64 * 1024;
/** Sentinels: Unicode private-use characters a template may not contain. */
const PUA = /[-]/;
const TOKEN_START = "";
const TOKEN_FILL = "";
const PART_OPEN = "";
const PART_CLOSE = "";

export const TEMPLATE_ELEMENTS = new Set([
  "a",
  "img",
  "picture",
  "source",
  "svg",
  "span",
  "div",
  "p",
  "ul",
  "ol",
  "li",
  "section",
  "strong",
  "em",
  "small",
  "br",
  "hr",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "address",
  "figure",
  "figcaption",
  "time",
]);

// aria-hidden is not offered: wrapped around a sealed part it would hide a control from assistive
// technology while leaving it on screen.
const GLOBAL_ATTRIBUTES = new Set(["class", "lang", "title", "role", "aria-label"]);
const ELEMENT_ATTRIBUTES: Record<string, string[]> = {
  a: ["href"],
  img: ["src", "alt", "width", "height", "loading", "decoding"],
  source: ["srcset", "media", "type"],
  time: ["datetime"],
};
const ALLOWED_ROLES = new Set([
  "presentation",
  "none",
  "img",
  "note",
  "group",
  "list",
  "listitem",
  "separator",
]);

type Path = string[];

export type TNode =
  | { t: "text"; value: string }
  | { t: "field"; path: Path; pos: SourcePosition }
  | {
      t: "element";
      tag: string;
      attrs: { name: string; pieces: (string | { path: Path })[]; pos: SourcePosition }[];
      children: TNode[];
      pos: SourcePosition;
      svg?: string;
    }
  | { t: "if"; path: Path; then: TNode[]; else: TNode[]; pos: SourcePosition }
  | { t: "for"; name: string; path: Path; body: TNode[]; pos: SourcePosition }
  | { t: "part"; name: string; pos: SourcePosition };

export interface CompiledTemplate {
  slot: string;
  file: string;
  nodes: TNode[];
  /** Parts the template inserts, in order. */
  parts: string[];
  /** `.site-*` classes on elements that contain a protected part (the account control). */
  protectedSiteClasses: string[];
}

export interface CompileOptions {
  slot: string;
  file: string;
  api: SlotsApi;
  /** Resolve a literal href; report and return undefined when it is not a valid link. */
  resolveHref(value: string, position: SourcePosition): string | undefined;
  /** Resolve a literal local image path (relative to the template); undefined when rejected. */
  resolveSrc(value: string, position: SourcePosition): string | undefined;
}

type Token =
  | { kind: "field"; path: Path }
  | { kind: "if"; path: Path }
  | { kind: "else" }
  | { kind: "endif" }
  | { kind: "for"; name: string; path: Path }
  | { kind: "endfor" }
  | { kind: "part"; name: string };

const PATH = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

function positionAt(source: string, offset: number): SourcePosition {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      last = i;
    }
  }
  return { line, column: offset - last };
}

export function compileTemplate(
  source: string,
  opts: CompileOptions,
): { template?: CompiledTemplate; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const spec = opts.api.slots[opts.slot];
  const error = (code: string, message: string, position?: SourcePosition, hint?: string): void => {
    diagnostics.push({
      code,
      severity: "error",
      message,
      file: opts.file,
      ...(position ? { position } : {}),
      ...(hint ? { hint } : {}),
    });
  };
  if (!spec) {
    error("FP1913", `Unknown slot '${opts.slot}'.`);
    return { diagnostics };
  }
  if (Buffer.byteLength(source, "utf8") > MAX_TEMPLATE_BYTES) {
    error("FP1407", `A slot template is at most ${MAX_TEMPLATE_BYTES} bytes.`);
    return { diagnostics };
  }
  const pua = PUA.exec(source);
  if (pua) {
    error(
      "FP1911",
      "Private-use characters (U+E000-U+E0FF) are reserved.",
      positionAt(source, pua.index),
    );
    return { diagnostics };
  }
  // The parser decodes character references, so `&#xE010;` would recreate a reserved marker
  // after the check above. Refuse a reference to any private-use code point before parsing.
  for (const m of source.matchAll(/&#(?:[xX]([0-9a-fA-F]+)|([0-9]+))/g)) {
    const code = Number.parseInt(m[1] ?? m[2]!, m[1] ? 16 : 10);
    if (code >= 0xe000 && code <= 0xf8ff) {
      error(
        "FP1911",
        "Character references to private-use code points are reserved.",
        positionAt(source, m.index!),
      );
      return { diagnostics };
    }
  }
  if (CREDENTIAL_PATTERN.test(source)) {
    const match = CREDENTIAL_PATTERN.exec(source)!;
    error(
      "FP1210",
      "This template contains something that looks like a credential. Rendered slots are published.",
      positionAt(source, match.index),
    );
  }

  // 1. Template syntax -> same-length sentinels, so parse5's offsets and positions stay true.
  const tokens: { token: Token; pos: SourcePosition }[] = [];
  let marked = "";
  let cursor = 0;
  const syntax = /\{\{([^{}]*)\}\}|\{%([^{}]*)%\}|\{\{|\{%|\}\}|%\}/g;
  for (let m = syntax.exec(source); m; m = syntax.exec(source)) {
    const pos = positionAt(source, m.index);
    marked += source.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    const raw = m[0];
    let token: Token | undefined;
    if (raw.includes("\n")) {
      error("FP1911", "Template syntax may not span lines.", pos);
    } else if (m[1] !== undefined) {
      const field = m[1].trim();
      if (PATH.test(field)) token = { kind: "field", path: field.split(".") };
      else
        error(
          "FP1911",
          `'{{ ${field} }}' is not a field. Fields are dotted names: no expressions, filters or calls.`,
          pos,
        );
    } else if (m[2] !== undefined) {
      const stmt = m[2].trim();
      let s: RegExpExecArray | null;
      if ((s = /^if\s+(\S+)$/.exec(stmt)) && PATH.test(s[1]!))
        token = { kind: "if", path: s[1]!.split(".") };
      else if (stmt === "else") token = { kind: "else" };
      else if (stmt === "endif") token = { kind: "endif" };
      else if ((s = /^for\s+([a-z][a-zA-Z0-9]*)\s+in\s+(\S+)$/.exec(stmt)) && PATH.test(s[2]!))
        token = { kind: "for", name: s[1]!, path: s[2]!.split(".") };
      else if (stmt === "endfor") token = { kind: "endfor" };
      else if ((s = /^part\s+"([a-z][a-z-]*)"$/.exec(stmt))) token = { kind: "part", name: s[1]! };
      else
        error(
          "FP1911",
          `'{% ${stmt} %}' is not a portal-template-v1 statement: if, else, endif, for … in, endfor and part "…".`,
          pos,
        );
    } else {
      error("FP1911", `Unbalanced template delimiter '${raw}'.`, pos);
    }
    const index = tokens.length;
    tokens.push({ token: token ?? { kind: "else" }, pos });
    const id = index.toString(36);
    if (raw.length < id.length + 2) {
      error("FP1911", "Too many template constructs.", pos);
      marked += raw;
      continue;
    }
    marked += TOKEN_START + id + TOKEN_FILL.repeat(raw.length - id.length - 1);
  }
  marked += source.slice(cursor);
  if (diagnostics.some((d) => d.code === "FP1911")) return { diagnostics };

  const markerRe = new RegExp(`${TOKEN_START}([0-9a-z]+)${TOKEN_FILL}+`, "g");
  const splitMarkers = (text: string): (string | number)[] => {
    const out: (string | number)[] = [];
    let at = 0;
    for (const m of text.matchAll(markerRe)) {
      if (m.index! > at) out.push(text.slice(at, m.index));
      out.push(Number.parseInt(m[1]!, 36));
      at = m.index! + m[0].length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  };

  // `{{ }}` where a tag name would start: parse5 reads it as text, so it is caught here.
  for (const m of source.matchAll(/<\/?\s*(\{\{|\{%)/g)) {
    error("FP1911", "Template syntax may not appear in a tag name.", positionAt(source, m.index!));
  }
  if (diagnostics.length > 0 && diagnostics.some((d) => d.severity === "error"))
    return { diagnostics };

  // 2. Parse the static markup.
  type P5Node = {
    nodeName: string;
    tagName?: string;
    value?: string;
    data?: string;
    attrs?: { name: string; value: string }[];
    childNodes?: P5Node[];
    namespaceURI?: string;
    sourceCodeLocation?: {
      startLine: number;
      startCol: number;
      startOffset: number;
      endOffset: number;
      attrs?: Record<string, { startLine: number; startCol: number }>;
    };
  };
  const fragment = parseFragment(marked, { sourceCodeLocationInfo: true }) as unknown as P5Node;

  const parts: string[] = [];
  const protectedClasses = new Set<string>();
  const forbidden = new Set(spec.forbiddenElements ?? []);

  type Flat = TNode | { t: "token"; index: number };
  const convert = (node: P5Node, ancestorsClasses: string[], parent = "", depth = 0): Flat[] => {
    const loc = node.sourceCodeLocation;
    const pos: SourcePosition = loc ? { line: loc.startLine, column: loc.startCol } : { line: 1 };
    if (node.nodeName === "#comment") {
      if (node.data && markerRe.test(node.data))
        error("FP1911", "Template syntax inside an HTML comment is not rendered.", pos);
      markerRe.lastIndex = 0;
      return [];
    }
    if (node.nodeName === "#text") {
      return splitMarkers(node.value ?? "").map((piece) =>
        typeof piece === "string"
          ? { t: "text" as const, value: piece }
          : { t: "token" as const, index: piece },
      );
    }
    const tag = (node.tagName ?? node.nodeName).toLowerCase();
    if (!TEMPLATE_ELEMENTS.has(tag) || forbidden.has(tag)) {
      error(
        "FP1914",
        forbidden.has(tag)
          ? `<${tag}> is not allowed in the ${opts.slot} slot.`
          : `<${tag}> is not part of portal-template-v1.`,
        pos,
        [
          "script",
          "style",
          "iframe",
          "object",
          "embed",
          "form",
          "input",
          "button",
          "template",
        ].includes(tag)
          ? "Scripts, styles, frames, embeds and form controls never come from a template; interactive controls are sealed parts."
          : undefined,
      );
      return [];
    }
    // `<source>` is only a candidate image of a `<picture>`; anywhere else it means media.
    if (tag === "source" && parent !== "picture") {
      error("FP1914", "<source> is allowed only directly inside <picture>.", pos);
      return [];
    }
    if (tag === "svg") {
      const svgSource = loc ? source.slice(loc.startOffset, loc.endOffset) : "";
      if (/\{\{|\{%/.test(svgSource)) {
        error("FP1911", "Template syntax may not appear inside <svg>.", pos);
        return [];
      }
      return [{ t: "element", tag, attrs: [], children: [], pos, svg: svgSource }];
    }
    const attrs: { name: string; pieces: (string | { path: Path })[]; pos: SourcePosition }[] = [];
    let classes: string[] = [];
    for (const attr of node.attrs ?? []) {
      const aloc = loc?.attrs?.[attr.name];
      const apos: SourcePosition = aloc ? { line: aloc.startLine, column: aloc.startCol } : pos;
      if (attr.name.includes(TOKEN_START) || attr.name.includes(TOKEN_FILL)) {
        error("FP1911", "Template syntax may not appear in an attribute name.", apos);
        continue;
      }
      const name = attr.name.toLowerCase();
      if (
        /^on/.test(name) ||
        name === "style" ||
        name === "id" ||
        name === "target" ||
        name === "rel"
      ) {
        error(
          "FP1914",
          `Attribute '${name}' is not part of portal-template-v1.`,
          apos,
          name === "style" ? "Style a .site-* class in the portal-style-v1 stylesheet." : undefined,
        );
        continue;
      }
      if (!GLOBAL_ATTRIBUTES.has(name) && !(ELEMENT_ATTRIBUTES[tag] ?? []).includes(name)) {
        error("FP1914", `Attribute '${name}' is not allowed on <${tag}>.`, apos);
        continue;
      }
      const pieces: (string | { path: Path })[] = splitMarkers(attr.value).map((piece) => {
        if (typeof piece === "string") return piece;
        const token = tokens[piece]!.token;
        if (token.kind !== "field") {
          error("FP1911", "Only {{ field }} may appear in an attribute value.", apos);
          return "";
        }
        return { path: token.path };
      });
      const hasField = pieces.some((p) => typeof p !== "string");
      const literal = pieces.filter((p): p is string => typeof p === "string").join("");
      if (name === "class") {
        if (hasField) {
          error("FP1911", "class takes literal names only.", apos);
          continue;
        }
        classes = literal.split(/\s+/).filter(Boolean);
        const bad = classes.filter((c) => !/^site-[a-z0-9][a-z0-9-]*$/.test(c));
        if (bad.length > 0) {
          error(
            "FP1914",
            `Class '${bad[0]}' is not a .site-* class.`,
            apos,
            "Template markup uses the site- prefix; framework classes are not public.",
          );
          continue;
        }
      }
      if (name === "role" && (hasField || !ALLOWED_ROLES.has(literal))) {
        error(
          "FP1914",
          `role='${literal}' is not allowed: landmarks belong to the framework.`,
          apos,
        );
        continue;
      }
      if (name === "href" || name === "src" || name === "srcset") {
        if (hasField && (pieces.length !== 1 || typeof pieces[0] === "string")) {
          error(
            "FP1911",
            `${name} is either a literal or exactly one {{ field }}, never both.`,
            apos,
          );
          continue;
        }
        if (!hasField) {
          // Checked here as well as by the resolver: entities are already decoded by the parser,
          // so `&#106;avascript:` arrives as what a browser would follow.
          const target = literal.trim();
          const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase();
          const unsafe =
            target.startsWith("//") ||
            [...target].some((c) => c.charCodeAt(0) < 0x20 || c === "\\") ||
            (name === "href"
              ? scheme !== undefined && scheme !== "https" && scheme !== "mailto"
              : scheme !== undefined || target.startsWith("/"));
          if (unsafe) {
            error(
              "FP1917",
              name === "href"
                ? `Link '${target}' is not allowed: use a site path, a fragment, https: or mailto:.`
                : `Image '${target}' must be a local file relative to the template.`,
              apos,
            );
            continue;
          }
          const resolved =
            name === "href" ? opts.resolveHref(literal, apos) : opts.resolveSrc(literal, apos);
          if (!resolved) continue;
          attrs.push({ name, pieces: [resolved], pos: apos });
          continue;
        }
      }
      if (
        name === "media" &&
        (hasField || !/^\(prefers-color-scheme:\s*(light|dark)\)$/.test(literal.trim()))
      ) {
        error("FP1914", "<source media> takes (prefers-color-scheme: light|dark) only.", apos);
        continue;
      }
      attrs.push({ name, pieces, pos: apos });
    }
    if (tag === "img" && !(node.attrs ?? []).some((a) => a.name === "alt")) {
      error("FP1914", '<img> needs an alt attribute (alt="" for a decorative image).', pos);
    }
    const scope = [...ancestorsClasses, ...classes];
    const children = structure(
      (node.childNodes ?? []).flatMap((child) => convert(child, scope, tag, depth + 1)),
      pos,
      scope,
      depth + 1,
    );
    return [{ t: "element", tag, attrs, children, pos }];
  };

  /** Turn the flat sequence of nodes and statement tokens into nested if/for/part nodes. */
  const structure = (
    flat: Flat[],
    parentPos: SourcePosition,
    classes: string[],
    depth = 0,
  ): TNode[] => {
    const root: TNode[] = [];
    const stack: { node: TNode & { t: "if" | "for" }; inElse: boolean }[] = [];
    const sink = (): TNode[] => {
      const top = stack[stack.length - 1];
      if (!top) return root;
      if (top.node.t === "for") return top.node.body;
      return top.inElse ? top.node.else : top.node.then;
    };
    for (const item of flat) {
      if (item.t !== "token") {
        sink().push(item);
        continue;
      }
      const { token, pos } = tokens[item.index]!;
      switch (token.kind) {
        case "field":
          sink().push({ t: "field", path: token.path, pos });
          break;
        case "if": {
          const node = { t: "if" as const, path: token.path, then: [], else: [], pos };
          sink().push(node);
          stack.push({ node, inElse: false });
          break;
        }
        case "for": {
          const node = { t: "for" as const, name: token.name, path: token.path, body: [], pos };
          sink().push(node);
          stack.push({ node, inElse: false });
          break;
        }
        case "else": {
          const top = stack[stack.length - 1];
          if (!top || top.node.t !== "if" || top.inElse)
            error("FP1911", "{% else %} without a matching {% if %} in the same element.", pos);
          else top.inElse = true;
          break;
        }
        case "endif":
        case "endfor": {
          const top = stack.pop();
          const want = token.kind === "endif" ? "if" : "for";
          if (!top || top.node.t !== want) {
            error(
              "FP1911",
              `{% ${token.kind} %} without a matching {% ${want} %} in the same element.`,
              pos,
            );
          }
          break;
        }
        case "part": {
          sink().push({ t: "part", name: token.name, pos });
          parts.push(token.name);
          const partSpec = opts.api.parts[token.name];
          if (partSpec?.protected) {
            for (const c of classes) protectedClasses.add(c);
            // Each wrapper can be styled, and what styles add up: one wrapper at most.
            if (depth > 1) {
              error(
                "FP1913",
                `{% part "${token.name}" %} may sit inside at most one element; it is inside ${depth}.`,
                pos,
              );
            }
          }
          break;
        }
      }
    }
    for (const open of stack) {
      error(
        "FP1911",
        `{% ${open.node.t} %} is not closed in the same element.`,
        open.node.pos ?? parentPos,
      );
    }
    return root;
  };

  const nodes = structure(
    (fragment.childNodes ?? []).flatMap((child) => convert(child, [])),
    { line: 1 },
    [],
  );

  // 3. Static checks against the slot's declared context and parts.
  const context: Record<string, FieldType> = { ...opts.api.context, ...spec.extraContext };
  checkFields(nodes, context, {}, spec, opts, error, false);
  const counts = new Map<string, number>();
  for (const part of parts) counts.set(part, (counts.get(part) ?? 0) + 1);
  for (const required of spec.requiredParts ?? []) {
    if ((counts.get(required) ?? 0) !== 1) {
      error("FP1913", `The ${opts.slot} slot must insert {% part "${required}" %} exactly once.`, {
        line: 1,
      });
    }
  }
  for (const [part, count] of counts) {
    if (count > 1)
      error("FP1913", `{% part "${part}" %} may appear once per template.`, { line: 1 });
  }

  if (diagnostics.some((d) => d.severity === "error")) return { diagnostics };
  return {
    template: {
      slot: opts.slot,
      file: opts.file,
      nodes,
      parts,
      protectedSiteClasses: [...protectedClasses].sort(),
    },
    diagnostics,
  };
}

function lookupType(
  path: Path,
  context: Record<string, FieldType>,
  scope: Record<string, FieldType>,
): FieldType | undefined {
  let type: FieldType | undefined = scope[path[0]!] ?? context[path[0]!];
  for (const key of path.slice(1)) {
    if (!type || typeof type === "string" || type.type !== "object") return undefined;
    type = type.fields[key];
  }
  return type;
}

function checkFields(
  nodes: TNode[],
  context: Record<string, FieldType>,
  scope: Record<string, FieldType>,
  spec: SlotSpec,
  opts: CompileOptions,
  error: (code: string, message: string, position?: SourcePosition, hint?: string) => void,
  inLoop: boolean,
  inIf = false,
): void {
  for (const node of nodes) {
    switch (node.t) {
      case "field": {
        const type = lookupType(node.path, context, scope);
        if (!type)
          error(
            "FP1912",
            `Unknown field '${node.path.join(".")}' in the ${opts.slot} context.`,
            node.pos,
          );
        else if (typeof type !== "string" || type === "boolean")
          error(
            "FP1912",
            `'${node.path.join(".")}' is not text; {{ }} prints strings only.`,
            node.pos,
          );
        break;
      }
      case "element":
        for (const attr of node.attrs) {
          for (const piece of attr.pieces) {
            if (typeof piece === "string") continue;
            const type = lookupType(piece.path, context, scope);
            if (!type)
              error(
                "FP1912",
                `Unknown field '${piece.path.join(".")}' in the ${opts.slot} context.`,
                attr.pos,
              );
            else if (typeof type !== "string" || type === "boolean")
              error("FP1912", `'${piece.path.join(".")}' is not text.`, attr.pos);
            else if (attr.name === "href" && type !== "url")
              error(
                "FP1912",
                `href takes a url field; '${piece.path.join(".")}' is ${type}.`,
                attr.pos,
              );
            else if ((attr.name === "src" || attr.name === "srcset") && type !== "image")
              // A link may leave the site; an image may not: only builder-published files.
              error(
                "FP1912",
                `${attr.name} takes an image field (a file this build published); '${piece.path.join(".")}' is ${type}.`,
                attr.pos,
              );
          }
        }
        checkFields(node.children, context, scope, spec, opts, error, inLoop, inIf);
        break;
      case "if": {
        const type = lookupType(node.path, context, scope);
        if (!type)
          error(
            "FP1912",
            `Unknown field '${node.path.join(".")}' in the ${opts.slot} context.`,
            node.pos,
          );
        checkFields(node.then, context, scope, spec, opts, error, inLoop, true);
        checkFields(node.else, context, scope, spec, opts, error, inLoop, true);
        break;
      }
      case "for": {
        const type = lookupType(node.path, context, scope);
        if (!type || typeof type === "string" || type.type !== "array") {
          error(
            "FP1912",
            `'${node.path.join(".")}' is not a list in the ${opts.slot} context.`,
            node.pos,
          );
          break;
        }
        if (node.name in context || node.name in scope) {
          error("FP1912", `The loop name '${node.name}' hides a context field.`, node.pos);
          break;
        }
        checkFields(
          node.body,
          context,
          { ...scope, [node.name]: type.items },
          spec,
          opts,
          error,
          true,
          inIf,
        );
        break;
      }
      case "part":
        if (!opts.api.parts[node.name]) {
          error(
            "FP1913",
            `Unknown part '${node.name}'. Parts: ${Object.keys(opts.api.parts).join(", ")}.`,
            node.pos,
          );
        } else if (!spec.parts.includes(node.name)) {
          error(
            "FP1913",
            `The ${opts.slot} slot does not take {% part "${node.name}" %}; it takes ${spec.parts.join(", ") || "none"}.`,
            node.pos,
          );
        } else if (inLoop) {
          error("FP1913", "A part may not be inserted inside a loop.", node.pos);
        } else if (
          inIf &&
          (opts.api.parts[node.name]!.protected || spec.requiredParts?.includes(node.name))
        ) {
          // A protected or required part is always rendered; a condition could drop it.
          error("FP1913", `{% part "${node.name}" %} may not sit inside {% if %}.`, node.pos);
        }
        break;
      case "text":
        break;
    }
  }
}

export interface RenderOptions {
  profile: ContentProfile;
  api: SlotsApi;
  /** Whether a sealed part has anything to render in this portal. */
  partEnabled(part: string): boolean;
}

export type Segment = { html: string } | { part: string };

export interface RenderResult {
  segments: Segment[];
  diagnostics: Diagnostic[];
  /** Parts the template asked for that render nothing here. */
  emptyParts: string[];
}

/** Render a compiled template against one context. Deterministic: same context, same bytes. */
export function renderTemplate(
  template: CompiledTemplate,
  context: Record<string, unknown>,
  opts: RenderOptions,
): RenderResult {
  const diagnostics: Diagnostic[] = [];
  const emptyParts: string[] = [];
  let iterations = 0;
  const error = (code: string, message: string, position: SourcePosition): void => {
    diagnostics.push({ code, severity: "error", message, file: template.file, position });
  };
  const clean = (value: unknown): string =>
    typeof value === "string" ? value.replace(/[-]/g, "") : "";
  const get = (path: Path, scope: Record<string, unknown>): unknown => {
    let value: unknown = path[0]! in scope ? scope[path[0]!] : context[path[0]!];
    for (const key of path.slice(1)) {
      value =
        value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    }
    return value;
  };
  const truthy = (value: unknown): boolean =>
    Array.isArray(value)
      ? value.length > 0
      : typeof value === "string"
        ? value !== ""
        : value === true;

  const render = (nodes: TNode[], scope: Record<string, unknown>): HNode[] => {
    const out: HNode[] = [];
    for (const node of nodes) {
      switch (node.t) {
        case "text":
          // Only a part node may produce a part marker.
          out.push(t(clean(node.value)));
          break;
        case "field":
          out.push(t(clean(get(node.path, scope))));
          break;
        case "if":
          out.push(...render(truthy(get(node.path, scope)) ? node.then : node.else, scope));
          break;
        case "for": {
          const list = get(node.path, scope);
          const items = Array.isArray(list) ? list : [];
          if (items.length > opts.api.iterationCap) {
            error(
              "FP1916",
              `'${node.path.join(".")}' has ${items.length} entries; a loop renders at most ${opts.api.iterationCap}.`,
              node.pos,
            );
            break;
          }
          for (const item of items) {
            iterations += 1;
            if (iterations > opts.api.totalIterationCap) {
              error(
                "FP1916",
                `The template renders more than ${opts.api.totalIterationCap} loop iterations.`,
                node.pos,
              );
              return out;
            }
            out.push(...render(node.body, { ...scope, [node.name]: item }));
          }
          break;
        }
        case "part":
          if (opts.partEnabled(node.name)) out.push(t(`${PART_OPEN}${node.name}${PART_CLOSE}`));
          else if (!emptyParts.includes(node.name)) emptyParts.push(node.name);
          break;
        case "element": {
          if (node.svg !== undefined) {
            const result = sanitizeSvg(node.svg, template.file, opts.profile);
            for (const d of result.diagnostics) diagnostics.push({ ...d, position: node.pos });
            if (result.ok && result.root) out.push(result.root);
            break;
          }
          const attrs: Record<string, string> = {};
          for (const attr of node.attrs) {
            attrs[attr.name] = attr.pieces
              .map((piece) => clean(typeof piece === "string" ? piece : get(piece.path, scope)))
              .join("");
          }
          // Checked again on the value: an image is a same-origin path, whatever filled it.
          const image = attrs.src ?? attrs.srcset;
          if (image && !/^\/(?!\/)[^\s\\]*$/.test(image)) {
            error("FP1917", `Image '${image}' is not a file this build published.`, node.pos);
            break;
          }
          if (
            (attrs.href === "" || attrs.src === "" || attrs.srcset === "") &&
            node.attrs.some((a) => a.pieces.some((p) => typeof p !== "string"))
          ) {
            // A link or image whose url field is empty in this context renders its content only.
            if (node.tag === "img" || node.tag === "source") break;
            out.push(...render(node.children, scope));
            break;
          }
          const element = h(node.tag, attrs, render(node.children, scope));
          if (node.tag === "a" && /^(https:|mailto:)/.test(attrs.href ?? "")) {
            element.attrs.push(["rel", "noopener noreferrer"]);
          }
          out.push(element);
          break;
        }
      }
    }
    return out;
  };

  const tree = render(template.nodes, {});
  const sanitized = sanitize(tree, {
    profile: slotProfile(opts.profile),
    file: template.file,
    diagnostics,
  });
  const html = serialize(sanitized, opts.profile);
  const segments: Segment[] = [];
  const partRe = new RegExp(`${PART_OPEN}([a-z-]+)${PART_CLOSE}`, "g");
  let at = 0;
  for (const m of html.matchAll(partRe)) {
    if (m.index! > at) segments.push({ html: html.slice(at, m.index) });
    segments.push({ part: m[1]! });
    at = m.index! + m[0].length;
  }
  if (at < html.length) segments.push({ html: html.slice(at) });
  return { segments, diagnostics, emptyParts };
}

/** The content profile, narrowed to what a slot template may contain. */
export function slotProfile(profile: ContentProfile): ContentProfile {
  const elementAttributes: Record<string, string[]> = {};
  for (const [tag, list] of Object.entries(ELEMENT_ATTRIBUTES)) elementAttributes[tag] = [...list];
  elementAttributes.a = [...(elementAttributes.a ?? []), "rel"];
  return {
    ...profile,
    html: {
      ...profile.html,
      allowedElements: [...TEMPLATE_ELEMENTS],
      globalAttributes: [...GLOBAL_ATTRIBUTES],
      elementAttributes,
      classNamespaces: ["site-"],
      // The content profile forbids `<source>` because a document's media would load through it;
      // a template's elements are its own allowlist, checked at compile time, so they are taken
      // out of the inherited list rather than rejected twice with contradicting answers.
      forbiddenElements: [
        ...new Set([
          ...profile.html.forbiddenElements.filter((tag) => !TEMPLATE_ELEMENTS.has(tag)),
          "script",
          "style",
          "iframe",
          "object",
          "embed",
          "form",
          "input",
          "button",
          "template",
        ]),
      ],
      generatedElements: {},
    },
  } as ContentProfile;
}

/** The serialized form of one segment list, parts dropped: for tests and the evidence digest. */
export function segmentsText(segments: Segment[]): string {
  return segments.map((s) => ("html" in s ? s.html : `{% part "${s.part}" %}`)).join("");
}

export type { HElement };
