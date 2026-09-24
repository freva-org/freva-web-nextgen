// Attaching a caption to the block it describes.
//
// The authored form puts the caption *after* its target:
//
//     ![Equal area comparison](assets/healpix-equal-area.png)
//     /// caption
//     Cells coloured by their relative area.
//     ///
//
// The normalizer has already turned that into a caption node next to an ordinary image
// paragraph; this pass makes the relationship structural: the pair becomes one `figure`, or -
// for a table - a native `<caption>` inside the table, the only place HTML lets a table's
// description live. Doing it on the IR rather than on the source makes the target rules
// checkable, since "the preceding block" is a node with a type: a caption after a heading is
// refused with the heading's own line number, and a second caption on one figure is refused
// rather than silently drawn twice.

import type { Diagnostic } from "../../diagnostics.js";
import type { IrDocument, IrNode } from "../ir.js";

/** What a caption may describe. */
const TARGETS: Record<string, string> = {
  figure: "figure",
  table: "table",
  code: "code block",
  diagram: "diagram",
  blockquote: "quotation",
  paragraph: "image",
};

function lineOf(node: IrNode): number | undefined {
  const loc = node.loc as { line?: number } | undefined;
  return typeof loc?.line === "number" ? loc.line : undefined;
}

/** True for a paragraph whose entire content is images. */
function isImageParagraph(node: IrNode): boolean {
  if (node.type !== "paragraph") return false;
  const children = (node as { children?: IrNode[] }).children ?? [];
  const images = children.filter((child) => child.type === "image");
  if (images.length === 0) return false;
  return children.every(
    (child) =>
      child.type === "image" ||
      child.type === "break" ||
      (child.type === "text" && !(child as { value?: string }).value?.trim()),
  );
}

/**
 * The Material for MkDocs attribute list, in the one place it is worth reading.
 * `![Alt](x.png){ width="600" .img-center }` is how consumer documentation sizes and centres
 * an image; left to the parser it is not markup at all - the braces are printed at the reader
 * and the paragraph is no longer images-only, so a `/// caption` under it has nothing it may
 * attach to. Read here as a closed subset - `width`, `height` and the three alignment classes
 * - anything else is refused with the author's own line. Not attribute-list support, just
 * enough of one that a real captioned image works.
 */
const ATTRIBUTE_LIST = /^\{[ \t]*([^{}]*?)[ \t]*\}/;
const ATTRIBUTE = /([.#]?[A-Za-z][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s}]+)))?/g;
const ALIGNMENT: Record<string, "left" | "center" | "right"> = {
  ".img-left": "left",
  ".img-center": "center",
  ".img-right": "right",
};
/** A length the theme can use, and nothing that could carry a CSS expression. */
const LENGTH = /^\d+(?:\.\d+)?(?:px|em|rem|%)?$/;

export interface AttachResult {
  children: IrNode[];
  diagnostics: Diagnostic[];
}

/**
 * Walk the tree, attaching each caption to the block before it. Depth-first, because a caption
 * is legal wherever a block is - inside an admonition, a list item, a blockquote - and the rule
 * is the same everywhere: it belongs to its immediately preceding sibling.
 */
export function attachCaptions(doc: IrDocument, file: string): AttachResult {
  const diagnostics: Diagnostic[] = [];

  const refuse = (node: IrNode, message: string, hint?: string): void => {
    const line = lineOf(node);
    diagnostics.push({
      code: "PC1020",
      severity: "error",
      message,
      file,
      ...(line !== undefined ? { position: { line } } : {}),
      ...(hint ? { hint } : {}),
    });
  };

  /**
   * Read a trailing attribute list off the text that follows an image. Only the prefix is
   * consumed, so `![a](x.png){ width="600" } and then prose` keeps its prose.
   */
  const absorb = (nodes: IrNode[]): IrNode[] => {
    const out: IrNode[] = [];
    for (const node of nodes) {
      const previous = out[out.length - 1];
      if (node.type !== "text" || previous?.type !== "image") {
        out.push(node);
        continue;
      }
      const value = (node as { value: string }).value;
      const list = ATTRIBUTE_LIST.exec(value);
      if (!list) {
        out.push(node);
        continue;
      }
      const image = previous as IrNode & {
        width?: string;
        align?: "left" | "center" | "right";
      };
      ATTRIBUTE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ATTRIBUTE.exec(list[1] ?? "")) !== null) {
        const key = match[1]!;
        const raw = match[2] ?? match[3] ?? match[4] ?? "";
        const alignment = ALIGNMENT[key];
        if (alignment) {
          image.align = alignment;
        } else if (key === "width" && LENGTH.test(raw)) {
          image.width = raw;
        } else if (key === "height" && LENGTH.test(raw)) {
          // Accepted and ignored: the theme sizes by width and keeps the
          // aspect ratio, and an authored height is how images get squashed.
        } else {
          refuse(
            node,
            `Image attribute '${key}' is not part of portal-content-v1.`,
            "An image attribute list may set width or height, or one of .img-left, .img-center and .img-right.",
          );
        }
      }
      const rest = value.slice(list[0].length);
      if (rest.trim() !== "") out.push({ ...node, value: rest } as IrNode);
    }
    return out;
  };

  const walk = (nodes: IrNode[], insideFigure = false): IrNode[] => {
    const out: IrNode[] = [];
    for (const node of absorb(nodes)) {
      const children = (node as { children?: IrNode[] }).children;
      if (children) {
        (node as { children: IrNode[] }).children = walk(children, node.type === "figure");
      }

      // A caption already inside a figure is already attached - that is how the MyST
      // `:::{figure}` form arrives, caption and legend written as the figure's own body. Only
      // a caption standing next to its target is looking for one.
      if (node.type !== "caption" || insideFigure) {
        out.push(node);
        continue;
      }

      const target = out[out.length - 1];
      if (!target) {
        refuse(
          node,
          "This caption describes nothing: there is no block before it.",
          "A caption follows the image, table, code block, diagram or quotation it describes.",
        );
        continue;
      }

      // A table keeps its caption inside itself: HTML has an element for exactly this, and a
      // `<figure>` around a table would not be associated with it, losing the accessible name.
      if (target.type === "table") {
        const rows = (target as { children: IrNode[] }).children;
        if (rows.some((row) => row.type === "tableCaption")) {
          refuse(node, "This table already has a caption.");
          continue;
        }
        rows.unshift({
          type: "tableCaption",
          loc: node.loc,
          children: (node as { children: IrNode[] }).children,
        } as IrNode);
        continue;
      }

      if (target.type === "figure") {
        const kids = (target as { children: IrNode[] }).children;
        if (kids.some((child) => child.type === "caption")) {
          refuse(node, "This figure already has a caption.");
          continue;
        }
        kids.push(node);
        continue;
      }

      const captionable =
        target.type === "code" ||
        target.type === "diagram" ||
        target.type === "blockquote" ||
        isImageParagraph(target);
      if (!captionable) {
        refuse(
          node,
          `A ${TARGETS[target.type] ?? target.type} cannot carry a caption.`,
          "A caption follows an image, a table, a code block, a diagram or a quotation.",
        );
        continue;
      }

      // An image paragraph is unwrapped into the figure rather than nested inside it: a `<p>`
      // wrapping the images would put a paragraph between the figure and its content, and
      // unwrapping keeps a light/dark pair - two images on consecutive lines, so one
      // paragraph - inside a single figure with a single caption.
      const content = isImageParagraph(target)
        ? ((target as { children?: IrNode[] }).children ?? []).filter(
            (child) => child.type === "image",
          )
        : [target];
      out.pop();
      // A width or an alignment written on the image belongs to the figure once there is one:
      // a caption should sit under the image at the image's own width, and a centred figure
      // centres its caption with it.
      const first = content[0] as (IrNode & { width?: string; align?: string }) | undefined;
      const width = first?.width;
      const align = first?.align;
      if (first) {
        delete first.width;
        delete first.align;
      }
      out.push({
        type: "figure",
        loc: target.loc,
        ...(width ? { width } : {}),
        ...(align ? { align } : {}),
        children: [...content, node],
      } as IrNode);
    }
    return out;
  };

  return { children: walk(doc.children), diagnostics };
}
