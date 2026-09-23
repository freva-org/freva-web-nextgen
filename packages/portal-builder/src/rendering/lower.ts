// Closed IR to HTML tree.
//
// The only place that decides what a semantic node looks like as markup, which is why the
// task-list rule lives here: GFM's usual output is a disabled `<input type="checkbox">` and
// portal-content-v1 emits no form controls at all, so a task item becomes a state-bearing list
// item with a decorative marker and a screen-reader label.

import type { Diagnostic } from "../diagnostics.js";
import { h, t, type HElement, type HNode } from "./html.js";
import type { IrCode, IrDocument, IrNode } from "./ir.js";
import { lineOf } from "./location.js";
import { renderMath } from "./math.js";
import type { ContentProfile } from "./profile.js";
import { SlugRegistry } from "./slug.js";
import type { CodeStyleSheet, RunnableExample } from "./code.js";
import { highlight } from "./code.js";

export interface HeadingOut {
  depth: number;
  id: string;
  text: string;
}

export interface LinkTarget {
  href: string;
  /** External links receive the profile's rel policy. */
  external: boolean;
}

export interface LowerContext {
  profile: ContentProfile;
  file: string;
  diagnostics: Diagnostic[];
  codeSheet: CodeStyleSheet;
  /** Sanitized diagram trees, produced before lowering and keyed by IR node. */
  diagrams: Map<IrNode, { light: HElement; dark?: HElement }>;
  /**
   * Resolve a document link; returns undefined after reporting a diagnostic.
   * `options.bareWwwAutolink` is the parser's answer to "was this written as a bare `www.`
   * autolink", the only case the profile normalizes.
   */
  resolveLink(
    url: string,
    line: number | undefined,
    options?: { bareWwwAutolink?: boolean },
  ): LinkTarget | undefined;
  /** Resolve an image/asset reference. */
  resolveAsset(url: string, line: number | undefined): string | undefined;
  /** Heading ids the fragment produced, filled in during lowering. */
  headings: HeadingOut[];
  /** Footnote identifier to its citation number, filled in before lowering. */
  footnoteOrder: Map<string, number>;
  /**
   * Called when mathematics is rendered. The engine's stylesheet is a framework asset emitted
   * only when a site contains an equation; the profile is explicit that this CSS is
   * package-generated rather than accepted from authored content.
   */
  markMath(): void;
  /**
   * Called for EVERY code block, in document order, and answers whether this one runs. Every
   * one, not only the marked ones, because the identity a runnable block gets is "the n-th code
   * block of this file" and n has to mean what a reader would count. Returns `undefined` when
   * the block is not marked, or when the portal has no playground - which is how a marked block
   * in a portal without Python renders as ordinary copyable code and pulls nothing in.
   */
  registerCode?(node: IrCode): RunnableExample | undefined;
}

export function textOf(node: IrNode | IrDocument): string {
  const anyNode = node as { type: string; value?: string; children?: IrNode[] };
  if (anyNode.type === "text" || anyNode.type === "inlineCode") return anyNode.value ?? "";
  if (anyNode.type === "math" || anyNode.type === "inlineMath") return anyNode.value ?? "";
  return (anyNode.children ?? []).map(textOf).join("");
}

function demoteAuthoredH1(nodes: IrNode[], profile: ContentProfile): IrNode[] {
  if (!profile.headings.demoteAuthoredH1) return nodes;
  return nodes.map((node) =>
    node.type === "heading" && node.depth === 1 ? ({ ...node, depth: 2 } as IrNode) : node,
  );
}

/**
 * Title selection and heading normalization. The page layout owns the `<h1>`, so an authored
 * one becomes the title or is demoted; two `<h1>` elements on one page is a heading-order
 * failure, not a style preference.
 */
export function extractTitle(
  doc: IrDocument,
  profile: ContentProfile,
): { title?: string; children: IrNode[] } {
  if (doc.frontmatter.title) {
    const lead = doc.children[0];
    // A document that opens with its own front-matter title as an `# H1` is the ordinary
    // MkDocs shape, and demoting that heading would print the same words twice, once as the
    // page title and once as the first section heading. The duplicate is dropped instead: the
    // title is already on the page, and nothing the author wrote is lost.
    if (
      lead &&
      lead.type === "heading" &&
      lead.depth === 1 &&
      textOf(lead).trim() === doc.frontmatter.title.trim()
    ) {
      return {
        title: doc.frontmatter.title,
        children: demoteAuthoredH1(doc.children.slice(1), profile),
      };
    }
    return { title: doc.frontmatter.title, children: demoteAuthoredH1(doc.children, profile) };
  }
  const first = doc.children[0];
  if (first && first.type === "heading" && first.depth === 1) {
    return {
      title: textOf(first).trim(),
      children: demoteAuthoredH1(doc.children.slice(1), profile),
    };
  }
  return { children: demoteAuthoredH1(doc.children, profile) };
}

/**
 * The order footnotes are first cited in, which is the order they are numbered. An identifier
 * is what the *author* calls a note - `[^snyder]`, `[^wgs84]` - and printing it makes a
 * citation read as the word "snyder" in superscript over an unnumbered list. A reader expects
 * a number, in citation order, matching a numbered list; the identifier is the link, not the
 * label.
 */
function numberFootnotes(nodes: IrNode[], order: Map<string, number>): void {
  for (const node of nodes) {
    if (node.type === "footnoteReference") {
      const id = (node as { identifier: string }).identifier;
      if (!order.has(id)) order.set(id, order.size + 1);
    }
    const children = (node as { children?: IrNode[] }).children;
    if (children) numberFootnotes(children, order);
  }
}

export async function lower(nodes: IrNode[], ctx: LowerContext): Promise<HNode[]> {
  const slugs = new SlugRegistry(ctx.profile);
  numberFootnotes(nodes, ctx.footnoteOrder);
  return lowerAll(nodes, ctx, slugs);
}

async function lowerAll(nodes: IrNode[], ctx: LowerContext, slugs: SlugRegistry): Promise<HNode[]> {
  const out: HNode[] = [];
  for (const node of nodes) out.push(...(await lowerNode(node, ctx, slugs)));
  return out;
}

async function lowerNode(node: IrNode, ctx: LowerContext, slugs: SlugRegistry): Promise<HNode[]> {
  const line = lineOf(node.loc);
  const kids = async (): Promise<HNode[]> =>
    lowerAll(((node as { children?: IrNode[] }).children ?? []) as IrNode[], ctx, slugs);

  switch (node.type) {
    case "paragraph":
      return [h("p", {}, await kids())];
    case "emphasis":
      return [h("em", {}, await kids())];
    case "strong":
      return [h("strong", {}, await kids())];
    case "subscript":
      return [h("sub", {}, await kids())];
    case "superscript":
      return [h("sup", {}, await kids())];
    case "delete":
      return [h("del", {}, await kids())];
    case "blockquote":
      return [h("blockquote", {}, await kids())];
    case "thematicBreak":
      return [h("hr")];
    case "break":
      return [h("br")];
    case "text":
      return [t(node.value)];
    case "inlineCode":
      return [
        h("code", { class: ctx.profile.highlighting.classPrefix + "-inline" }, [t(node.value)]),
      ];
    case "heading": {
      const text = textOf(node).trim();
      const id = slugs.next(text);
      ctx.headings.push({ depth: node.depth, id, text });
      // Every heading carries its own link: a section a reader can point someone else at is
      // worth more than one they have to describe, and the anchor already exists. Written at
      // build time rather than added by a script, so it works with JavaScript off and is in
      // the document a screen reader walks; hidden until the heading is hovered or the link
      // itself is focused, so it is keyboard-reachable without being decoration.
      const anchor = h(
        "a",
        {
          class: "portal-heading-anchor",
          href: `#${id}`,
          "aria-label": `Permanent link to ${text}`,
        },
        [t("#")],
      );
      return [h("h" + String(node.depth), { id }, [...(await kids()), anchor])];
    }
    case "code": {
      const runnable = ctx.registerCode?.(node);
      const result = await highlight(
        node.value,
        node.lang,
        ctx.profile,
        ctx.codeSheet,
        node.title,
        runnable,
      );
      if (result.unknownLanguage) {
        ctx.diagnostics.push({
          code: "PC1013",
          severity: "warning",
          message:
            "Unknown highlighting language '" +
            result.unknownLanguage +
            "'; the block is rendered as escaped plain code.",
          file: ctx.file,
          ...(line !== undefined ? { position: { line } } : {}),
        });
      }
      return [result.node];
    }
    case "link": {
      const target = ctx.resolveLink(node.url, line, {
        ...(node.bareWwwAutolink ? { bareWwwAutolink: true } : {}),
      });
      if (!target) return kids();
      const attrs: Record<string, string> = { href: target.href };
      if (target.external) attrs.rel = ctx.profile.html.linkRel.externalHttps.join(" ");
      return [h("a", attrs, await kids())];
    }
    case "image": {
      // The theme fragment names a variant, not a file. `x.png#only-dark` is looked up as
      // `x.png` - what exists on disk and what the asset manifest records - and the fragment
      // goes back on the emitted URL, where it is the consumer's own convention and inert to
      // the browser.
      const bare = node.only ? node.url.replace(/#only-(?:light|dark)$/, "") : node.url;
      const resolved = ctx.resolveAsset(bare, line);
      if (!resolved) return [];
      const src = node.only ? `${resolved}#only-${node.only}` : resolved;
      if (!node.alt.trim()) {
        ctx.diagnostics.push({
          code: "PC1014",
          severity: "warning",
          message: "Image '" + node.url + "' has no alternative text.",
          file: ctx.file,
          ...(line !== undefined ? { position: { line } } : {}),
          hint: 'Describe the image, or write alt="" only when it is purely decorative.',
        });
      }
      return [
        h("img", {
          src,
          alt: node.alt,
          loading: "lazy",
          decoding: "async",
          ...(node.only ? { "data-portal-only": node.only } : {}),
          // Only present on an image that is not in a figure: the attachment
          // pass lifts both onto the figure when there is one.
          ...(node.width ? { width: node.width.replace(/[^0-9a-z%.]/gi, "") } : {}),
          ...(node.align ? { "data-portal-align": node.align } : {}),
        }),
      ];
    }
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const attrs: Record<string, string | number> = {};
      if (node.ordered && node.start !== undefined && node.start !== 1) attrs.start = node.start;
      return [h(tag, attrs, await kids())];
    }
    case "listItem": {
      const children = await kids();
      if (node.checked === undefined) return [h("li", {}, children)];
      const cfg = ctx.profile.tasklist;
      const marker = h(cfg.markerElement, { class: cfg.markerClass, "aria-hidden": "true" }, [
        t(node.checked ? "☑" : "☐"),
      ]);
      const label = h("span", { class: cfg.labelClass }, [
        t(node.checked ? cfg.checkedLabel : cfg.uncheckedLabel),
      ]);
      const attrs: Record<string, string> = {};
      attrs[cfg.listItemAttribute] = node.checked ? "done" : "todo";
      return [h("li", attrs, [marker, label, ...children])];
    }
    case "table": {
      // Header rows are the ones the parser said were header rows. Promoting the first row
      // regardless would give an RST body-only table a `<thead>` it never had, and would lose
      // all but the first line of a multi-row head.
      const rows = ((node as { children?: IrNode[] }).children ?? []) as IrNode[];
      const renderRow = async (row: IrNode): Promise<HElement> => {
        const rowIsHeader = (row as { header?: boolean }).header === true;
        const cells = ((row as { children?: IrNode[] }).children ?? []) as IrNode[];
        const rendered: HNode[] = [];
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i] as (IrNode & { header?: boolean }) | undefined;
          const header = cell?.header === true || rowIsHeader;
          const align = node.align?.[i] ?? null;
          const attrs: Record<string, string> = {};
          if (align) attrs.align = align;
          if (header) attrs.scope = "col";
          const cellChildren = ((cell as { children?: IrNode[] } | undefined)?.children ??
            []) as IrNode[];
          rendered.push(h(header ? "th" : "td", attrs, await lowerAll(cellChildren, ctx, slugs)));
        }
        return h("tr", {}, rendered);
      };

      const captionNode = rows.find((child) => child.type === "tableCaption");
      const headRows = rows.filter(
        (row) => row.type === "tableRow" && (row as { header?: boolean }).header === true,
      );
      const bodyRows = rows.filter(
        (row) => row.type === "tableRow" && (row as { header?: boolean }).header !== true,
      );
      const children: HNode[] = [];
      // `<caption>` must be the table's first child; HTML says so and a browser
      // moves it if it is not.
      if (captionNode) {
        const captionChildren = ((captionNode as { children?: IrNode[] }).children ??
          []) as IrNode[];
        children.push(h("caption", {}, await lowerAll(captionChildren, ctx, slugs)));
      }
      if (headRows.length > 0) {
        const rendered: HNode[] = [];
        for (const row of headRows) rendered.push(await renderRow(row));
        children.push(h("thead", {}, rendered));
      }
      if (bodyRows.length > 0) {
        const rendered: HNode[] = [];
        for (const row of bodyRows) rendered.push(await renderRow(row));
        children.push(h("tbody", {}, rendered));
      }
      return [h("table", { class: "portal-table" }, children)];
    }
    case "tableCaption":
      // Reached only if a caption is somehow not a table's child; a caption on
      // its own is still the table's accessible name and never a paragraph.
      return [h("caption", {}, await kids())];
    case "admonition": {
      const title = node.title ?? node.level.charAt(0).toUpperCase() + node.level.slice(1);
      const classes = `portal-admonition portal-admonition-${node.level}`;
      const body = h("div", { class: "portal-admonition-body" }, await kids());
      // The icon is an empty span the theme fills through a mask, so the markup
      // carries no artwork and the sanitizer has no drawing to inspect.
      const icon = h("span", { class: "portal-admonition-icon", "aria-hidden": "true" }, []);

      if (node.collapsible) {
        // A collapsible block is `<details>`, the element that already has the behaviour, the
        // keyboard support and the announced state. A div with a click handler is a worse
        // copy that stops working when the script does.
        const attrs: Record<string, string> = { class: `${classes} portal-admonition-collapsible` };
        if (node.collapsible === "open") attrs.open = "";
        return [
          h("details", attrs, [
            h("summary", { class: "portal-admonition-title" }, [icon, t(title)]),
            body,
          ]),
        ];
      }

      return [
        h("aside", { class: classes, role: "note" }, [
          h("p", { class: "portal-admonition-title" }, [icon, t(title)]),
          body,
        ]),
      ];
    }
    case "math":
    case "inlineMath": {
      const result = renderMath(node.value, node.type === "math", ctx.file, line, ctx.profile);
      ctx.diagnostics.push(...result.diagnostics);
      if (result.diagnostics.some((d) => d.severity === "error")) return [];
      ctx.markMath();
      return node.type === "math"
        ? [h("div", { class: "portal-math-block" }, result.nodes)]
        : result.nodes;
    }
    case "diagram": {
      const drawn = ctx.diagrams.get(node);
      if (!drawn) return [];
      // One figure, two palettes, no script. Mermaid bakes its colours into the SVG at build
      // time, so a single copy can only match one theme. Both are emitted and the stylesheet
      // shows the one that matches `data-theme`, which keeps the switch instant, scriptless
      // and correct on first paint, with no flash of the wrong diagram. When only one palette
      // rendered it is emitted unlabelled and used in both themes: a diagram in the wrong
      // colours still carries its content, and a missing diagram does not.
      const figure = h("figure", { class: "portal-diagram" }, [
        ...(drawn.dark
          ? [
              // Distinguished by class rather than by a data attribute: the content profile is a
              // closed allow-list and `span` carries no theme attribute, while a framework class
              // in the portal namespace is already how generated markup labels itself.
              h("span", { class: "portal-diagram-copy portal-diagram-light" }, [drawn.light]),
              h("span", { class: "portal-diagram-copy portal-diagram-dark" }, [drawn.dark]),
            ]
          : [drawn.light]),
      ]);
      figure.generatedBy = "mermaid";
      return [figure];
    }
    case "footnoteReference": {
      const id = "fn-" + node.identifier;
      const number = ctx.footnoteOrder.get(node.identifier);
      const label = number === undefined ? (node.label ?? node.identifier) : String(number);
      return [
        h("sup", { class: "portal-footnote-ref", id: "fnref-" + node.identifier }, [
          h(
            "a",
            {
              href: "#" + id,
              // The link's own text is the number, so the accessible name says
              // which note it goes to rather than just "1".
              "aria-label": `Reference ${label}`,
            },
            [t(label)],
          ),
        ]),
      ];
    }
    case "footnoteDefinition": {
      const number = ctx.footnoteOrder.get(node.identifier);
      const marker =
        number === undefined
          ? []
          : [
              h("span", { class: "portal-footnote-number", "aria-hidden": "true" }, [
                t(`${number}`),
              ]),
            ];
      // The number, the note, and a way back to where it was cited: without the return link a
      // reader who follows a citation to the bottom of a long document has no way back to the
      // sentence they were reading.
      const back = h(
        "a",
        {
          class: "portal-footnote-back",
          href: "#fnref-" + node.identifier,
          "aria-label": `Back to reference ${number ?? node.identifier}`,
        },
        [t("\u21a9")],
      );
      return [
        h("div", { class: "portal-footnote", id: "fn-" + node.identifier }, [
          ...marker,
          h("div", { class: "portal-footnote-body" }, [...(await kids()), back]),
        ]),
      ];
    }
    case "figure": {
      // One figure, whatever it holds: images, a code block, a diagram or a quotation. The
      // caption is the figure's last child, so the association is structural - `<figcaption>`
      // inside `<figure>` is what makes assistive technology read the two as one thing, with
      // no `aria-describedby` to keep in step and no id to collide.
      const attrs: Record<string, string> = { class: "portal-figure" };
      if (node.name) attrs.id = node.name;
      if (node.align) attrs["data-portal-align"] = node.align;
      const rendered = await kids();
      // A diagram brings its own `<figure>`, because a diagram on its own is still a figure.
      // Captioned, that would nest one inside the other, so the inner one is unwrapped and
      // its class moves outward: one element, one caption, one thing.
      const merged: HNode[] = [];
      for (const child of rendered) {
        if (
          typeof child === "object" &&
          "tag" in child &&
          child.tag === "figure" &&
          (child as HElement).attrs.some(([k, v]) => k === "class" && v === "portal-diagram")
        ) {
          attrs.class = "portal-figure portal-diagram";
          merged.push(...(child as HElement).children);
          continue;
        }
        merged.push(child);
      }
      if (node.width) {
        // The authored width applies to the *image*, not to the caption: a
        // caption set to 40% of the column is a caption in a gutter.
        const width = node.width.replace(/[^0-9a-z%.]/gi, "");
        for (const child of merged) {
          if (typeof child === "object" && "tag" in child && child.tag === "img") {
            (child as HElement).attrs.push(["width", width]);
          }
        }
      }
      const figure = h("figure", attrs, merged);
      // A merged diagram keeps the transform tag its SVG needs to survive the
      // sanitizer's style rule.
      if (attrs.class?.includes("portal-diagram")) figure.generatedBy = "mermaid";
      return [figure];
    }
    case "caption":
      return [h("figcaption", { class: "portal-figcaption" }, await kids())];
    case "legend":
      // The longer body of a docutils or MyST figure. Inside the figure because it describes
      // the figure, a separate element because the short caption and the long legend are
      // different things: the caption names the picture, the legend explains it.
      return [h("div", { class: "portal-figure-legend" }, await kids())];
    case "container":
    case "definitionList":
    case "definitionTerm":
    case "definitionDescription": {
      const map: Record<string, string> = {
        container: "div",
        definitionList: "dl",
        definitionTerm: "dt",
        definitionDescription: "dd",
      };
      return [h(map[node.type]!, {}, await kids())];
    }
    case "tableOfContents":
      return [];
    default:
      return [];
  }
}
