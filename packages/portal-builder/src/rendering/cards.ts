// Card grids: `:::cards`, and Material for MkDocs' `<div class="grid cards" markdown>`.
//
// Both are a Markdown LIST inside a block, one card per item, which is how Material writes them:
//
//     -   [![](thumb.png)](01_first_map.md)
//         **[A map of one month](01_first_map.md)**
//         First paragraph of the example...
//
// This module reads that list - already parsed into IR - into `cards` > `card` nodes. It decides
// structure only: an optional leading image, an optional title, and the rest as the summary. What
// the image and the links point at is still resolved by the same passes that resolve every other
// image and link, because they stay ordinary IR nodes.
//
// Material allows the pieces in one paragraph (soft line breaks between them) or in separate
// paragraphs (blank lines between them), and a `---` rule between the title and the summary.
// All three shapes read the same.

import type { IrNode, SourceLocation } from "./ir.js";

export interface CardProblem {
  message: string;
  hint?: string;
  loc: SourceLocation;
}

type Children = { children: IrNode[] };

const isWhitespace = (node: IrNode): boolean =>
  node.type === "break" || (node.type === "text" && node.value.trim() === "");

/** Drop leading line breaks and blank text, and the leading newline of the first text. */
function trimStart(nodes: IrNode[]): IrNode[] {
  const out = [...nodes];
  while (out.length > 0 && isWhitespace(out[0]!)) out.shift();
  const first = out[0];
  if (first && first.type === "text") {
    const value = first.value.replace(/^\s+/, "");
    out[0] = { ...first, value };
  }
  return out;
}

/** An image, or a link whose only content is an image. */
function asMedia(node: IrNode): IrNode | undefined {
  if (node.type === "image") return node;
  if (node.type === "link") {
    const inner = node.children.filter((child) => !isWhitespace(child));
    if (inner.length === 1 && inner[0]!.type === "image") return node;
  }
  return undefined;
}

/** A link, or strong/emphasis text (usually holding a link). */
function asTitle(node: IrNode): IrNode | undefined {
  if (node.type === "link") return node;
  if (node.type === "strong" || node.type === "emphasis") return node;
  return undefined;
}

function linkIn(node: IrNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "link") return node.url;
  const children = (node as Partial<Children>).children ?? [];
  for (const child of children) {
    const found = linkIn(child);
    if (found) return found;
  }
  return undefined;
}

function imageOf(media: IrNode): IrNode & { type: "image" } {
  if (media.type === "image") return media;
  return (media as Children).children.find((c) => c.type === "image") as IrNode & {
    type: "image";
  };
}

/** One list item to one card. */
function toCard(item: IrNode & Children, problems: CardProblem[]): IrNode | undefined {
  const blocks = [...item.children];
  let media: IrNode | undefined;
  let title: IrNode | undefined;

  // Walk the leading paragraphs, taking at most one image and then at most one title, in that
  // order. A paragraph left with anything else in it ends the walk; what remains is the summary.
  const rest: IrNode[] = [];
  let reading = true;
  while (blocks.length > 0) {
    const block = blocks.shift()!;
    if (!reading) {
      rest.push(block);
      continue;
    }
    if (block.type === "thematicBreak" && title) {
      // Material's `---` between a card's title and its text: a separator, not content.
      reading = false;
      continue;
    }
    if (block.type !== "paragraph") {
      reading = false;
      rest.push(block);
      continue;
    }
    let inline = trimStart(block.children);
    if (!media && !title && inline.length > 0) {
      const candidate = asMedia(inline[0]!);
      if (candidate) {
        media = candidate;
        inline = trimStart(inline.slice(1));
      }
    }
    if (!title && inline.length > 0) {
      const candidate = asTitle(inline[0]!);
      // A title is a whole line: the thing that starts it, then a line break or the end of the
      // paragraph. `**Note** that…` is emphasis in a sentence, not a title.
      const after = inline[1];
      const endsLine =
        after === undefined ||
        after.type === "break" ||
        (after.type === "text" && /^\s*\n/.test(after.value));
      if (candidate && endsLine) {
        title = candidate;
        inline = trimStart(inline.slice(1));
      }
    }
    if (inline.length > 0) {
      rest.push({ ...block, children: inline } as IrNode);
      reading = false;
    }
  }

  if (!media && !title && rest.length === 0) {
    problems.push({ message: "A card is empty.", loc: item.loc });
    return undefined;
  }

  const children: IrNode[] = [];
  const titleHref = linkIn(title);
  if (media) {
    const image = imageOf(media);
    const mediaHref = media.type === "link" ? media.url : undefined;
    if (!mediaHref || (titleHref && mediaHref === titleHref)) {
      // The image is not a link of its own - never was, or goes to the same place as the title,
      // which keeps the one link per card. (The whole card is its click target: the title link
      // is stretched over it in CSS, so the image loses nothing, and a keyboard or screen-reader
      // user meets each destination once.) With a title, the thumbnail then only illustrates a
      // card the title already names.
      if (title) image.decorative = true;
      children.push(image);
    } else {
      // The image keeps a link of its own, to somewhere the title does not go. An image with no
      // alt text is that link's whole content, so the link would have no name at all - whether
      // or not the card has a title, which names a different destination.
      if (image.alt.trim() === "") {
        problems.push({
          message: title
            ? "A card image linked somewhere other than the card's title needs alt text on that image."
            : "A card whose image is its only link needs alt text on that image.",
          hint: title
            ? "Describe where the image link goes in its alt text, or link the image to the same page as the title."
            : "Give the image alt text, or give the card a title: `**[Title](page.md)**`.",
          loc: image.loc,
        });
        return undefined;
      }
      children.push(media);
    }
  }
  if (title) {
    // `**[Title](x.md)**` is a title that is a link; the bold is the author's way of saying
    // "title" in plain Markdown, and the card's own style says it now.
    const inner =
      (title.type === "strong" || title.type === "emphasis") &&
      title.children.length === 1 &&
      title.children[0]!.type === "link"
        ? title.children
        : [title];
    children.push({ type: "cardTitle", loc: title.loc, children: inner } as IrNode);
  }
  children.push(...rest);
  return { type: "card", loc: item.loc, children } as IrNode;
}

/**
 * Read a card block's parsed body into a `cards` node. The body must be exactly one list; each of
 * its items is one card.
 */
export function buildCards(
  body: IrNode[],
  loc: SourceLocation,
): { node?: IrNode; problems: CardProblem[] } {
  const problems: CardProblem[] = [];
  const blocks = body.filter((node) => !isWhitespace(node));
  const list = blocks[0];
  if (blocks.length !== 1 || !list || list.type !== "list") {
    problems.push({
      message: "A card grid holds one Markdown list, one card per item, and nothing else.",
      hint:
        "Write each card as a list item: an optional image, a title such as " +
        "`**[Title](page.md)**`, then its summary.",
      loc,
    });
    return { problems };
  }
  const cards: IrNode[] = [];
  for (const item of list.children) {
    if (item.type !== "listItem") continue;
    if (item.checked !== undefined) {
      problems.push({ message: "A card cannot be a task-list item.", loc: item.loc });
      continue;
    }
    const card = toCard(item, problems);
    if (card) cards.push(card);
  }
  if (problems.length > 0) return { problems };
  return { node: { type: "cards", loc, children: cards } as IrNode, problems };
}
