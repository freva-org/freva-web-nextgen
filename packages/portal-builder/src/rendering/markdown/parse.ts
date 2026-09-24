// Markdown to `PortalDocumentIR`.
//
// CommonMark plus the four GFM extensions the profile names, plus exactly four container
// directives. Everything else - raw HTML, MDX, an unknown directive name, a reference to a
// definition that does not exist - is a source-located error, not literal text that ships.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import type { Root, RootContent, PhrasingContent, Definition, FootnoteDefinition } from "mdast";
import type { Diagnostic } from "../../diagnostics.js";
import { loadYaml } from "../../config/yaml.js";
import type { IrDocument, IrNode, SourceLocation } from "../ir.js";
import {
  CAPTION_DIRECTIVE,
  FIGURE_DIRECTIVE,
  LEGEND_DIRECTIVE,
  normalizeBlockSyntax,
} from "./block-source.js";
import { resolveAdmonition } from "../admonitions.js";
import { RUNNABLE_MARKER } from "../runnable.js";
import { locationFor, type OriginContext, type OriginNode } from "../location.js";
import type { ContentProfile } from "../profile.js";

export interface MarkdownParseResult {
  document?: IrDocument;
  diagnostics: Diagnostic[];
}

interface MdNode {
  type: string;
  position?: {
    start: { line: number; column: number; offset?: number };
    end: { line: number; column: number; offset?: number };
  };
  [key: string]: unknown;
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkDirective)
  .use(remarkMath);

function reported(
  node: MdNode,
  lineMap?: readonly number[],
): {
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
} {
  const p = node.position;
  if (!p) return {};
  // Normalizing the admonition spellings moves lines about. The map puts a diagnostic back on
  // the line the author actually wrote, which is the only line they can act on.
  const back = (line: number): number => lineMap?.[line - 1] ?? line;
  return {
    line: back(p.start.line),
    column: p.start.column,
    endLine: back(p.end.line),
    endColumn: p.end.column,
  };
}

/**
 * Whether this link node is a GFM bare `www.` autolink, decided from the source. The slice the
 * parser recorded for the node is compared with the node's own text: they are equal only when
 * the author wrote the URL and nothing else. Without a position - a synthesized node - the
 * answer is no, because a link that cannot be proved to be an autolink is treated as authored.
 */
function isBareWwwAutolink(node: MdNode, source: string, literal: string): boolean {
  const position = node.position;
  if (!position || position.start.offset === undefined || position.end.offset === undefined) {
    return false;
  }
  if (literal === "" || !literal.startsWith("www.")) return false;
  const slice = source.slice(position.start.offset, position.end.offset);
  if (slice !== literal) return false;
  return String((node as { url?: unknown }).url) === `http://${literal}`;
}

/**
 * Split a Material-style theme fragment off an image URL. `assets/x.png#only-dark` names the
 * file `assets/x.png` and says it belongs to the dark theme. The URL keeps the fragment - the
 * convention the consumer wrote, which makes their own stylesheets work elsewhere - and the
 * variant is recorded separately so asset resolution can look up the real file and the theme
 * can show one of the pair.
 */
function themedUrl(raw: string): { url: string; only?: "light" | "dark" } {
  const match = /^(.*)#only-(light|dark)$/.exec(raw);
  if (!match) return { url: raw };
  return { url: raw, only: match[2] as "light" | "dark" };
}

export function parseMarkdown(
  source: string,
  file: string,
  profile: ContentProfile,
): MarkdownParseResult {
  const diagnostics: Diagnostic[] = [];
  // Accept the block spellings real documentation is written in, before the parser sees the
  // text. Nothing else about the source is rewritten.
  const normalized = normalizeBlockSyntax(source);
  const lineMap = normalized.lineMap;
  source = normalized.text;
  // What the normalizer recognized and refused. Errors, not warnings: a caption block the
  // profile cannot accept would otherwise be printed at the reader as `/// caption` in the
  // middle of their page, the defect this whole lane exists to remove.
  for (const problem of normalized.problems) {
    diagnostics.push({
      code: problem.code,
      severity: "error",
      message: problem.message,
      file,
      position: { line: problem.line },
      ...(problem.hint ? { hint: problem.hint } : {}),
    });
  }
  const tree = processor.parse(source) as Root;

  const definitions = new Map<string, Definition>();
  const footnotes = new Map<string, FootnoteDefinition>();
  const collect = (node: RootContent | Root): void => {
    if (node.type === "definition") definitions.set(node.identifier, node);
    if (node.type === "footnoteDefinition") footnotes.set(node.identifier, node);
    const children = (node as { children?: RootContent[] }).children;
    if (children) for (const child of children) collect(child);
  };
  collect(tree);

  const frontmatter: IrDocument["frontmatter"] = {};
  const error = (code: string, message: string, node?: MdNode, hint?: string): void => {
    const d: Diagnostic = { code, severity: "error", message, file };
    const line = node ? reported(node, lineMap).line : undefined;
    if (line !== undefined) {
      const column = node?.position?.start.column;
      d.position = column === undefined ? { line } : { line, column };
    }
    if (hint) d.hint = hint;
    diagnostics.push(d);
  };

  /**
   * The document's first child carrying a parser position, computed once. It is the origin the
   * profile names for a footnote definition, which remark reports without one.
   */
  let documentFirstChild: OriginNode | undefined;

  const loc = (node: MdNode, origins: OriginContext): SourceLocation =>
    locationFor(profile, node.type, file, reported(node, lineMap), origins);

  const convertAll = (nodes: (RootContent | PhrasingContent)[], origins: OriginContext): IrNode[] =>
    nodes.flatMap((n) => convert(n as unknown as MdNode, origins));

  const convert = (node: MdNode, origins: OriginContext): IrNode[] => {
    const l = loc(node, origins);
    const me: OriginNode = { loc: l, type: node.type };
    // A node with a real position becomes the nearest positioned ancestor for everything
    // below it; one without keeps the ancestor it inherited.
    const self: OriginContext = {
      ...origins,
      ...(l.kind === "parser" ? { "nearest-ancestor-with-position": me } : {}),
      ...(node.type === "figure" ? { "parent-figure": me } : {}),
    };
    const kids = (): IrNode[] =>
      convertAll(((node.children as RootContent[]) ?? []) as RootContent[], self);

    switch (node.type) {
      case "yaml":
        return [];
      case "definition":
        return [];
      case "html":
        error(
          "PC1002",
          "Raw HTML is rejected by portal-content-v1.",
          node,
          "Use Markdown, a `:::note` directive, or move the material to a trusted documentation subsite.",
        );
        return [];
      case "paragraph":
      case "emphasis":
      case "strong":
      case "delete":
      case "blockquote":
      case "tableRow":
        return [{ type: node.type, loc: l, children: kids() } as IrNode];
      case "heading": {
        const depth = node.depth as number;
        if (depth > profile.limits.maxHeadingDepth) {
          error("PC1016", `Heading depth ${depth} exceeds the profile limit.`, node);
        }
        return [{ type: "heading", loc: l, depth, children: kids() } as IrNode];
      }
      case "text":
        return [{ type: "text", loc: l, value: String(node.value) }];
      case "inlineCode":
        return [{ type: "inlineCode", loc: l, value: String(node.value) }];
      case "break":
      case "thematicBreak":
        return [{ type: node.type, loc: l } as IrNode];
      case "code": {
        const lang = typeof node.lang === "string" ? node.lang : undefined;
        const value = String(node.value);
        // The fence's metadata: `title="…"`, `try-in-python`, in either order. Two things and
        // only two, and the second is not a language: execution is a PROPERTY of a block whose
        // language is Python, not a dialect of it, so the fence still says `python` and a
        // highlighter, a screen reader and a reader's eye all see the same thing. Anything
        // else on the fence is a feature this profile does not have, and accepting it
        // silently would be a promise.
        const meta = typeof node.meta === "string" ? node.meta.trim() : "";
        let title: string | undefined;
        let runnable = false;
        if (meta) {
          const titles = [...meta.matchAll(/title\s*=\s*"([^"]*)"/g)];
          const rest = meta.replace(/title\s*=\s*"[^"]*"/g, " ");
          const words = rest.split(/\s+/).filter((word) => word !== "");
          const markers = words.filter((word) => word === RUNNABLE_MARKER);
          const leftover = words.filter((word) => word !== RUNNABLE_MARKER).join(" ");
          if (titles.length > 1) {
            error("PC1021", "This code fence carries more than one title.", node);
            return [];
          }
          if (markers.length > 1) {
            error(
              "PC1022",
              `This code fence carries '${RUNNABLE_MARKER}' more than once.`,
              node,
              "Once is what it means; twice is a typo that would otherwise be ignored.",
            );
            return [];
          }
          if (leftover) {
            error(
              "PC1021",
              `Code fence metadata '${leftover}' is not part of portal-content-v1.`,
              node,
              `Only title="…" and ${RUNNABLE_MARKER} are accepted.`,
            );
            return [];
          }
          if (titles.length === 0 && markers.length === 0) {
            error(
              "PC1021",
              `Code fence metadata '${meta}' is not part of portal-content-v1.`,
              node,
              `Only title="…" and ${RUNNABLE_MARKER} are accepted.`,
            );
            return [];
          }
          if (titles.length === 1) title = titles[0]![1]!;
          runnable = markers.length === 1;
        }
        if (lang === "mermaid") {
          if (Buffer.byteLength(value) > profile.limits.maxDiagramBytes) {
            error("PC1016", "Diagram source exceeds the profile limit.", node);
            return [];
          }
          return [{ type: "diagram", loc: l, language: "mermaid", value }];
        }
        return [
          {
            type: "code",
            loc: l,
            value,
            ...(lang ? { lang } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(runnable ? { runnable: true } : {}),
          } as IrNode,
        ];
      }
      case "link": {
        const url = String(node.url);
        // A GFM *bare* `www.` autolink and an explicitly authored link can be identical in the
        // tree: remark rewrites `www.example.org` to `http://www.example.org` and leaves the
        // original text as the only child, exactly the shape of
        // `[www.example.org](http://www.example.org)`. The source slice decides instead: a
        // bare autolink occupies exactly the characters of its own text, an authored link its
        // brackets and parentheses as well. It matters because a bare autolink is upgraded to
        // HTTPS while an authored `http://` URL is refused.
        const bare = isBareWwwAutolink(node, source, plainText(node));
        return [
          {
            type: "link",
            loc: l,
            url,
            ...(node.title ? { title: String(node.title) } : {}),
            ...(bare ? { bareWwwAutolink: true } : {}),
            children: kids(),
          } as IrNode,
        ];
      }
      case "linkReference": {
        const def = definitions.get(String(node.identifier));
        if (!def) {
          error(
            "PC1008",
            `Link reference [${String(node.label ?? node.identifier)}] has no definition.`,
            node,
          );
          return [];
        }
        return [
          {
            type: "link",
            loc: l,
            url: def.url,
            ...(def.title ? { title: def.title } : {}),
            children: kids(),
          } as IrNode,
        ];
      }
      case "image":
        return [
          {
            type: "image",
            loc: l,
            ...themedUrl(String(node.url)),
            alt: typeof node.alt === "string" ? node.alt : "",
            ...(node.title ? { title: String(node.title) } : {}),
          } as IrNode,
        ];
      case "imageReference": {
        const def = definitions.get(String(node.identifier));
        if (!def) {
          error(
            "PC1010",
            `Image reference [${String(node.label ?? node.identifier)}] has no definition.`,
            node,
          );
          return [];
        }
        return [
          {
            type: "image",
            loc: l,
            ...themedUrl(def.url),
            alt: typeof node.alt === "string" ? node.alt : "",
            ...(def.title ? { title: def.title } : {}),
          } as IrNode,
        ];
      }
      case "list":
        return [
          {
            type: "list",
            loc: l,
            ordered: Boolean(node.ordered),
            ...(typeof node.start === "number" && node.start !== null ? { start: node.start } : {}),
            children: kids(),
          } as IrNode,
        ];
      case "listItem":
        return [
          {
            type: "listItem",
            loc: l,
            ...(typeof node.checked === "boolean" ? { checked: node.checked } : {}),
            children: kids(),
          } as IrNode,
        ];
      case "table": {
        // GFM's first row is the header row, and that is recorded here rather
        // than re-derived by the lowerer from position alone.
        const rows = convertAll(((node.children as RootContent[]) ?? []) as RootContent[], self);
        const marked = rows.map((row, index) =>
          index === 0 && row.type === "tableRow"
            ? ({
                ...row,
                header: true,
                children: (row as { children: IrNode[] }).children.map((cell) =>
                  cell.type === "tableCell" ? { ...cell, header: true } : cell,
                ),
              } as IrNode)
            : row,
        );
        return [
          {
            type: "table",
            loc: l,
            align: (node.align as (("left" | "right" | "center") | null)[]) ?? [],
            children: marked,
          } as IrNode,
        ];
      }
      case "tableCell":
        return [{ type: "tableCell", loc: l, children: kids() } as IrNode];
      case "math":
        return [{ type: "math", loc: l, value: String(node.value) }];
      case "inlineMath":
        return [{ type: "inlineMath", loc: l, value: String(node.value) }];
      case "footnoteReference":
        if (!footnotes.has(String(node.identifier))) {
          error("PC1008", `Footnote [^${String(node.identifier)}] has no definition.`, node);
          return [];
        }
        return [
          {
            type: "footnoteReference",
            loc: l,
            identifier: String(node.identifier),
            ...(node.label ? { label: String(node.label) } : {}),
          } as IrNode,
        ];
      case "footnoteDefinition":
        return [
          {
            type: "footnoteDefinition",
            loc: l,
            identifier: String(node.identifier),
            ...(node.label ? { label: String(node.label) } : {}),
            children: kids(),
          } as IrNode,
        ];
      case "containerDirective": {
        const name = String(node.name);
        // The three directives the normalizer emits. They are not authored vocabulary -
        // `/// caption` and `:::{figure}` are - but they are ordinary container directives by
        // the time the parser sees them, so the caption's inline Markdown is parsed by the
        // same parser as everything else, with the same link rewriting and the same sanitizer.
        if (name === CAPTION_DIRECTIVE) {
          return [{ type: "caption", loc: l, children: kids() } as IrNode];
        }
        if (name === LEGEND_DIRECTIVE) {
          return [{ type: "legend", loc: l, children: kids() } as IrNode];
        }
        if (name === FIGURE_DIRECTIVE) {
          const attrs = (node.attributes ?? {}) as Record<string, string>;
          const src = attrs.src ?? "";
          const image: IrNode = {
            type: "image",
            loc: l,
            ...themedUrl(src),
            alt: attrs.alt ?? "",
          } as IrNode;
          const align = attrs.align as "left" | "center" | "right" | undefined;
          return [
            {
              type: "figure",
              loc: l,
              ...(attrs.width ? { width: attrs.width } : {}),
              ...(align ? { align } : {}),
              ...(attrs.name ? { name: attrs.name } : {}),
              children: [image, ...kids()],
            } as IrNode,
          ];
        }
        // Any name the vocabulary knows, plus a neutral fallback for one it does not: a build
        // that stops because somebody wrote `:::musing` turns a styling question into an
        // outage, and the author's word survives as the title either way.
        const resolved = resolveAdmonition(name);
        if (!resolved.known) {
          diagnostics.push({
            code: "PC1017",
            severity: "warning",
            message: `Unknown admonition type '${name}'; rendered as a neutral note titled '${resolved.title}'.`,
            file,
            ...(reported(node, lineMap).line !== undefined
              ? { position: { line: reported(node, lineMap).line! } }
              : {}),
            hint: `Known types: ${profile.markdown.containerDirectives.join(", ")}.`,
          });
        }

        const attrs = (node.attributes ?? {}) as Record<string, string>;
        const collapsibleAttr = attrs.collapsible;
        for (const key of Object.keys(attrs)) {
          if (key === "collapsible") continue;
          error("PC1001", `Directive ':::${name}' does not accept the attribute '${key}'.`, node);
          return [];
        }
        if (
          collapsibleAttr !== undefined &&
          collapsibleAttr !== "open" &&
          collapsibleAttr !== "closed"
        ) {
          error(
            "PC1001",
            `Directive ':::${name}' accepts collapsible="open" or collapsible="closed".`,
            node,
          );
          return [];
        }

        // remark-directive represents `:::warning[Title]` as a leading paragraph child tagged
        // `directiveLabel`; it is the admonition title, not body.
        const children = ((node.children as RootContent[]) ?? []) as MdNode[];
        let title: string | undefined;
        let body = children;
        const first = children[0] as (MdNode & { data?: { directiveLabel?: boolean } }) | undefined;
        if (first?.data?.directiveLabel) {
          title = plainText(first);
          body = children.slice(1);
        }
        return [
          {
            type: "admonition",
            loc: l,
            level: resolved.kind,
            title: title ?? resolved.title,
            ...(collapsibleAttr ? { collapsible: collapsibleAttr } : {}),
            children: convertAll(body as unknown as RootContent[], self),
          } as IrNode,
        ];
      }
      case "leafDirective":
      case "textDirective":
        error(
          "PC1001",
          `Directive '${String(node.name)}' is not part of portal-content-v1.`,
          node,
          "Only the four container admonitions are accepted.",
        );
        return [];
      default:
        error("PC1001", `Unsupported Markdown construct '${node.type}'.`, node);
        return [];
    }
  };

  const plainText = (node: MdNode): string => {
    if (node.type === "text" || node.type === "inlineCode") return String(node.value);
    const children = (node.children as MdNode[]) ?? [];
    return children.map(plainText).join("");
  };

  // Frontmatter is parsed and removed before anything else looks at the document.
  const first = tree.children[0];
  if (first && first.type === "yaml") {
    const parsed = loadYaml<Record<string, unknown>>(first.value, file);
    diagnostics.push(...parsed.diagnostics);
    const data = parsed.value ?? {};
    for (const [key, value] of Object.entries(data)) {
      if (!profile.frontmatter.allowedKeys.includes(key)) {
        diagnostics.push({
          code: "PC1005",
          severity: "error",
          message: `Unknown frontmatter key '${key}'.`,
          file,
          position: { line: first.position?.start.line ?? 1 },
          hint: `Allowed: ${profile.frontmatter.allowedKeys.join(", ")}.`,
        });
        continue;
      }
      if (
        (key === "title" || key === "description" || key === "path") &&
        typeof value !== "string"
      ) {
        diagnostics.push({
          code: "PC1005",
          severity: "error",
          message: `Frontmatter '${key}' must be a string.`,
          file,
        });
        continue;
      }
      if (key === "toc" && typeof value !== "boolean") {
        diagnostics.push({
          code: "PC1005",
          severity: "error",
          message: "Frontmatter 'toc' must be a boolean.",
          file,
        });
        continue;
      }
      // `navOrder` is bounded and integral, and both halves are load-bearing. A float sorts
      // perfectly well and signals somebody thought this was a weight rather than a position;
      // a value outside the range is almost always a year or a timestamp pasted into the wrong
      // key, which sorts silently and wrongly. YAML also parses `010` as 10 and `1_0` as 10,
      // which is why the check is on the parsed number rather than on the text.
      if (key === "navOrder") {
        const [low, high] = profile.frontmatter.navOrderRange;
        if (typeof value !== "number" || !Number.isInteger(value)) {
          diagnostics.push({
            code: "PC1005",
            severity: "error",
            message: "Frontmatter 'navOrder' must be an integer.",
            file,
            hint: `An integer between ${low} and ${high}; it orders siblings and nothing else.`,
          });
          continue;
        }
        if (value < low || value > high) {
          diagnostics.push({
            code: "PC1005",
            severity: "error",
            message: `Frontmatter 'navOrder' must be between ${low} and ${high} (got ${value}).`,
            file,
            hint: "A value this large is usually a year or a timestamp in the wrong key.",
          });
          continue;
        }
      }
      Object.assign(frontmatter, { [key]: value });
    }
  }

  const rootLoc = locationFor(profile, "root", file, {}, undefined);
  const rootOrigin: OriginNode = { loc: rootLoc, type: "root" };

  // Resolve the document's first positioned child before converting, so the
  // `parent-document-first-child` rule has something real to name.
  for (const child of tree.children) {
    const line = (child as { position?: { start: { line: number } } }).position?.start.line;
    if (line !== undefined) {
      documentFirstChild = {
        loc: { kind: "parser", file, line },
        type: child.type,
      };
      break;
    }
  }

  const document: IrDocument = {
    type: "root",
    loc: rootLoc,
    frontmatter,
    children: convertAll(tree.children, {
      "nearest-ancestor-with-position": rootOrigin,
      ...(documentFirstChild ? { "parent-document-first-child": documentFirstChild } : {}),
    }),
  };

  return diagnostics.some((d) => d.severity === "error")
    ? { diagnostics }
    : { document, diagnostics };
}
