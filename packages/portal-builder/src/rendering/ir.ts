// `PortalDocumentIR` - the closed intermediate representation both parsers produce.
//
// Markdown and RST are two very different parsers with two very different opinions about
// source positions. They meet here, at a semantic tree with no arbitrary HTML in it, so the
// normalization, sanitization, linking and serialization stages exist once rather than twice.
// Round-tripping through helper-generated HTML would lose the positions this type keeps.

import type { AdmonitionKind } from "./admonitions.js";

/** Where a node came from. Never invented, never upgraded to look more precise. */
export type SourceLocation =
  | {
      kind: "parser";
      /** Source-root-relative, normalized. */
      file: string;
      /** One-based. */
      line: number;
      column?: number;
      endLine?: number;
      endColumn?: number;
    }
  | {
      kind: "inherited";
      file: string;
      line: number;
      column?: number;
      /** The profile rule that derived it, and the node it came from. */
      originRule: string;
      originType: string;
    }
  | {
      kind: "generated";
      file: string;
      /** Omitted when no single source position exists. */
      line?: number;
      transform: string;
      originType?: string;
    };

export interface IrNodeBase {
  type: string;
  loc: SourceLocation;
}

export interface IrParent extends IrNodeBase {
  children: IrNode[];
}

export interface IrText extends IrNodeBase {
  type: "text";
  value: string;
}

export interface IrInlineCode extends IrNodeBase {
  type: "inlineCode";
  value: string;
}

export interface IrCode extends IrNodeBase {
  type: "code";
  value: string;
  lang?: string;
  /**
   * The fence's `title="…"`, which names the file or command the snippet is. Deliberately not
   * a caption: a title is *part of the code presentation* - it sits in the block's own header
   * with the copy control - while a caption is a figure's description below it. The two can
   * appear together, and conflating them would make one impossible to express.
   */
  title?: string;
  /**
   * The fence carried `try-in-python`. A property of the block, not a language: `lang` still
   * says `python`, and everything that reads a language - the highlighter, the label, a reader
   * - is unaffected. Whether it means anything is decided later by the portal's configuration;
   * a marked block in a portal with no playground renders as ordinary copyable code.
   */
  runnable?: boolean;
}

export interface IrHeading extends IrParent {
  type: "heading";
  depth: number;
  /** Assigned by the normalization stage, not by the parser. */
  id?: string;
}

export interface IrLink extends IrParent {
  type: "link";
  url: string;
  title?: string;
  /**
   * True only for a GFM *bare* `www.` autolink. The profile normalizes that one form to
   * HTTPS; an explicitly authored `http://` link must still fail, and the two are
   * indistinguishable by the time only the final URL is left.
   */
  bareWwwAutolink?: boolean;
}

export interface IrImage extends IrNodeBase {
  type: "image";
  url: string;
  alt: string;
  title?: string;
  /**
   * Which theme this image belongs to, from a `#only-dark` / `#only-light` fragment on its
   * URL - Material for MkDocs' convention, and how a consumer ships a light and a dark
   * rendering of the same figure. Recorded here rather than left in the URL alone because the
   * *lookup* has to ignore it - the file on disk is `x.png`, not `x.png#only-dark` - while the
   * output has to keep it.
   */
  only?: "light" | "dark";
  /**
   * A width and an alignment absorbed from a trailing attribute list.
   * `![Alt](x.png){ width="600" .img-center }` is how Material for MkDocs sizes an image, and
   * consumer documentation is full of it. The subset understood here is exactly these two
   * things; see `absorbImageAttributes`.
   */
  width?: string;
  align?: "left" | "center" | "right";
}

export interface IrList extends IrParent {
  type: "list";
  ordered: boolean;
  start?: number;
}

export interface IrListItem extends IrParent {
  type: "listItem";
  /** GFM task list state, normalized to a passive shape at lowering time. */
  checked?: boolean;
}

export interface IrTable extends IrParent {
  type: "table";
  align: (("left" | "right" | "center") | null)[];
}

/**
 * An authored table title, from `.. table:: A caption`. Deliberately not the figure `caption`
 * node: the two lower to different elements (`<caption>` inside `<table>`, `<figcaption>`
 * inside `<figure>`) and carry different provenance rules, so sharing one node type would make
 * the profile's origin rules ambiguous and the lowering guess.
 */
export interface IrTableCaption extends IrParent {
  type: "tableCaption";
}

export interface IrTableRow extends IrParent {
  type: "tableRow";
  /** True for a row the parser reported as belonging to the table head. */
  header?: boolean;
}

export interface IrTableCell extends IrParent {
  type: "tableCell";
  header?: boolean;
  align?: "left" | "right" | "center" | null;
}

export interface IrAdmonition extends IrParent {
  type: "admonition";
  /** The semantic kind the theme draws; see `rendering/admonitions.ts`. */
  level: AdmonitionKind;
  title?: string;
  /** Set when the source asked for a collapsible block, with its initial state. */
  collapsible?: "open" | "closed";
}

export interface IrMath extends IrNodeBase {
  type: "math" | "inlineMath";
  value: string;
}

export interface IrDiagram extends IrNodeBase {
  type: "diagram";
  language: "mermaid";
  value: string;
  /** Filled in by the build-time render transform. */
  svg?: string;
  id?: string;
}

export interface IrFootnoteReference extends IrNodeBase {
  type: "footnoteReference";
  identifier: string;
  label?: string;
}

export interface IrFootnoteDefinition extends IrParent {
  type: "footnoteDefinition";
  identifier: string;
  label?: string;
}

export interface IrTableOfContents extends IrNodeBase {
  type: "tableOfContents";
}

export interface IrSimpleParent extends IrParent {
  type:
    | "root"
    | "paragraph"
    | "emphasis"
    | "strong"
    | "delete"
    | "subscript"
    | "superscript"
    | "blockquote"
    | "definitionList"
    | "definitionTerm"
    | "definitionDescription"
    | "caption"
    | "legend"
    | "container";
}

/**
 * A figure: one or more images, a code block, a diagram or a quotation, plus the caption that
 * describes it. `width` and `align` are the two presentation options the closed MyST subset
 * and the docutils `figure` directive share; `name` becomes the element's id so a document can
 * link to its own figure. Nothing here numbers anything.
 */
export interface IrFigure extends IrParent {
  type: "figure";
  width?: string;
  align?: "left" | "center" | "right";
  name?: string;
}

export interface IrLeaf extends IrNodeBase {
  type: "thematicBreak" | "break";
}

export type IrNode =
  | IrSimpleParent
  | IrFigure
  | IrText
  | IrInlineCode
  | IrCode
  | IrHeading
  | IrLink
  | IrImage
  | IrList
  | IrListItem
  | IrTable
  | IrTableCaption
  | IrTableRow
  | IrTableCell
  | IrAdmonition
  | IrMath
  | IrDiagram
  | IrFootnoteReference
  | IrFootnoteDefinition
  | IrTableOfContents
  | IrLeaf;

export interface IrDocument {
  type: "root";
  loc: SourceLocation;
  children: IrNode[];
  frontmatter: {
    title?: string;
    description?: string;
    path?: string;
    toc?: boolean;
    /**
     * Where this page sits among its siblings in the derived section navigation. Ordering
     * only: no route changes, no page created or removed, and it means nothing outside its own
     * directory. Lower comes first; duplicates are allowed and broken by source filename, so a
     * section can be partly ordered without every file declaring a number.
     */
    navOrder?: number;
  };
}

export function isParent(node: IrNode): node is IrNode & { children: IrNode[] } {
  return Array.isArray((node as { children?: unknown }).children);
}

export function visitIr(
  node: IrNode | IrDocument,
  fn: (node: IrNode, parent: IrNode | IrDocument | undefined) => void,
  parent?: IrNode | IrDocument,
): void {
  if (parent !== undefined || node.type !== "root") fn(node as IrNode, parent);
  const children = (node as { children?: IrNode[] }).children;
  if (children) for (const child of children) visitIr(child, fn, node);
}

/** Count every node, for the profile's per-document limit. */
export function countNodes(doc: IrDocument): number {
  let n = 0;
  visitIr(doc, () => {
    n += 1;
  });
  return n;
}
