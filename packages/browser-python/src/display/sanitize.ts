// sanitize.ts - the DOM boundary for Python-authored markup. Visitor Python can publish any bytes
// under any MIME type, so HTML and SVG are parsed by DOMPurify against a Freva allowlist, then
// every id is renamed into a per-output namespace and every in-document reference follows it.
//
// What survives: text, structure, tables, lists, links (opened in a new tab, no referrer), images
// as inline PNG/JPEG/GIF/WebP data, xarray's checkbox-and-label sections and its local SVG icons.
// What does not: scripts and event handlers, forms and every control but a checkbox, frames and
// embeds, `<style>`, `<link>`, `<meta>`, `<base>`, the `style` attribute, SVG animation and
// `foreignObject`, and every attribute or URL that would load something from anywhere.

import DOMPurify from "dompurify";

type Purifier = ReturnType<typeof DOMPurify>;

const TEXT_TAGS = [
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
  "wbr",
];

const SVG_TAGS = [
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "path",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "rect",
  "text",
  "tspan",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "pattern",
  "marker",
];

const ATTRIBUTES = [
  "abbr",
  "align",
  "alt",
  "border",
  "checked",
  "cite",
  "class",
  "colspan",
  "datetime",
  "dir",
  "disabled",
  "for",
  "headers",
  "height",
  "href",
  "id",
  "lang",
  "open",
  "rel",
  "reversed",
  "role",
  "rowspan",
  "scope",
  "span",
  "src",
  "start",
  "target",
  "title",
  "type",
  "valign",
  "value",
  "width",
  // SVG presentation and geometry. No `style`, no event handlers, no `xlink:href` but on <use>.
  "clip-path",
  "clip-rule",
  "cx",
  "cy",
  "d",
  "dx",
  "dy",
  "fill",
  "fill-opacity",
  "fill-rule",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "gradienttransform",
  "gradientunits",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "offset",
  "opacity",
  "points",
  "preserveaspectratio",
  "r",
  "rx",
  "ry",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "transform",
  "version",
  "viewbox",
  "x",
  "x1",
  "x2",
  "xlink:href",
  "xmlns",
  "xmlns:xlink",
  "y",
  "y1",
  "y2",
  "aria-describedby",
  "aria-hidden",
  "aria-label",
  "aria-labelledby",
];

const FORBIDDEN_TAGS = [
  "style",
  "link",
  "meta",
  "base",
  "script",
  "noscript",
  "template",
  "slot",
  "form",
  "button",
  "select",
  "option",
  "textarea",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "audio",
  "video",
  "source",
  "track",
  "picture",
  "canvas",
  "math",
  "foreignobject",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "image",
  "feimage",
  "filter",
  "dialog",
  "portal",
];

const FORBIDDEN_ATTRIBUTES = [
  "style",
  "srcset",
  "sizes",
  "ping",
  "formaction",
  "background",
  "poster",
];

/** `src` on an <img>: inline raster data only. Nothing is fetched. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
/** `href` on an <a>: a web or mail link, or a fragment inside this output. */
const LINK = /^(https?:|mailto:|#)/i;
/** Attributes holding id references, rewritten into the output's namespace. */
const ID_LISTS = ["headers", "aria-labelledby", "aria-describedby"] as const;
/** SVG paint references, `url(#id)` with an optional fallback paint. */
const PAINT_REFERENCES = ["fill", "stroke"] as const;
/** The other SVG `url(#id)` references the allowlist keeps. */
const URL_REFERENCES = ["clip-path", "mask", "marker-start", "marker-mid", "marker-end"] as const;
/** `url(#id)`, `url('#id')` or `url("#id")`, then whatever follows (a paint's fallback). */
const LOCAL_URL = /^url\(\s*(['"]?)#([^'")]+)\1\s*\)\s*(.*)$/is;

const purifiers = new WeakMap<Window, Purifier>();
let nextNamespace = 0;

function purifierFor(view: Window): Purifier {
  let purifier = purifiers.get(view);
  if (purifier) return purifier;
  purifier = DOMPurify(view as unknown as Parameters<typeof DOMPurify>[0]);
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    const name = data.attrName;
    const value = data.attrValue.trim();
    const tag = node.nodeName.toLowerCase();
    if (name === "href" || name === "xlink:href") {
      // <use> may only point inside this output; <a> may link out; nothing else has an href.
      data.keepAttr = tag === "use" ? value.startsWith("#") : tag === "a" && LINK.test(value);
    } else if (name === "src") {
      data.keepAttr = tag === "img" && DATA_IMAGE.test(value);
    } else if (name === "type") {
      data.keepAttr = tag === "input" ? value.toLowerCase() === "checkbox" : tag === "ol";
    } else if (name === "value") {
      data.keepAttr = tag === "li" || tag === "data";
    }
  });
  purifier.addHook("afterSanitizeAttributes", (node) => {
    const tag = node.nodeName.toLowerCase();
    if (tag === "input" && node.getAttribute("type")?.toLowerCase() !== "checkbox") {
      node.remove();
    } else if (tag === "a" && node.hasAttribute("href")) {
      if (!node.getAttribute("href")?.startsWith("#")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      } else node.removeAttribute("target");
    } else if (tag === "img" && !node.hasAttribute("src")) {
      node.remove();
    }
  });
  // A DOM that only imitates a browser can leave DOMPurify walking nothing and returning its
  // input. Proven here, once per window, before any output is trusted to it.
  const probe = purifier.sanitize('<p id="a"><img src="x" onerror="1"><script>1</script></p>', {
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment;
  if (!purifier.isSupported || probe.querySelector("script,[onerror]")) {
    throw new Error("This document cannot sanitise HTML, so rich output is shown as text.");
  }
  purifiers.set(view, purifier);
  return purifier;
}

function config(svg: boolean) {
  return {
    ALLOWED_TAGS: svg ? SVG_TAGS : [...TEXT_TAGS, ...SVG_TAGS],
    ALLOWED_ATTR: ATTRIBUTES,
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    WHOLE_DOCUMENT: false,
    RETURN_DOM_FRAGMENT: true as const,
    // The namespace below already makes ids collision-free; this keeps DOMPurify's own guard on.
    SANITIZE_DOM: true,
  };
}

/** Rename every id into a fresh namespace and follow every reference; drop dangling ones. */
function namespaceIds(root: DocumentFragment): void {
  const prefix = `fv${(nextNamespace += 1).toString(36)}${Math.random().toString(36).slice(2, 7)}-`;
  const renamed = new Map<string, string>();
  for (const node of root.querySelectorAll("[id]")) {
    const id = node.getAttribute("id") ?? "";
    if (!renamed.has(id)) renamed.set(id, prefix + id);
    node.setAttribute("id", renamed.get(id) ?? "");
  }
  const follow = (node: Element, attribute: string, fragment: boolean): void => {
    const value = node.getAttribute(attribute);
    if (value === null) return;
    if (fragment) {
      const target = value.startsWith("#") ? renamed.get(value.slice(1)) : undefined;
      if (target) node.setAttribute(attribute, `#${target}`);
      else if (value.startsWith("#") || node.nodeName.toLowerCase() === "use") {
        node.removeAttribute(attribute);
      }
      return;
    }
    const ids = value.split(/\s+/).filter(Boolean);
    const kept = ids.map((id) => renamed.get(id)).filter((id): id is string => !!id);
    if (kept.length > 0) node.setAttribute(attribute, kept.join(" "));
    else node.removeAttribute(attribute);
  };
  for (const node of root.querySelectorAll("label[for]")) follow(node, "for", false);
  for (const attribute of ID_LISTS) {
    for (const node of root.querySelectorAll(`[${attribute}]`)) follow(node, attribute, false);
  }
  for (const node of root.querySelectorAll("a[href], use[href]")) follow(node, "href", true);
  for (const node of root.querySelectorAll("use")) follow(node, "xlink:href", true);
  // `url(...)` references: into the namespace when local and present; otherwise (dangling, or
  // anything not in this output) gone - a paint falls back to its fallback or to `none`, which
  // is how a browser draws an unresolved paint server; the others are dropped.
  const followUrl = (node: Element, attribute: string, paint: boolean): void => {
    const value = node.getAttribute(attribute)?.trim();
    if (!value || !/url\(/i.test(value)) return;
    const local = LOCAL_URL.exec(value);
    const target = local ? renamed.get(local[2] ?? "") : undefined;
    const fallback = local?.[3]?.trim() ?? "";
    if (target && !/url\(/i.test(fallback)) {
      node.setAttribute(attribute, `url(#${target})${fallback ? ` ${fallback}` : ""}`);
    } else if (paint) {
      node.setAttribute(attribute, fallback && !/url\(/i.test(fallback) ? fallback : "none");
    } else node.removeAttribute(attribute);
  };
  for (const attribute of PAINT_REFERENCES) {
    for (const node of root.querySelectorAll(`[${attribute}]`)) followUrl(node, attribute, true);
  }
  for (const attribute of URL_REFERENCES) {
    for (const node of root.querySelectorAll(`[${attribute}]`)) followUrl(node, attribute, false);
  }
}

/** An <svg> holding only <defs> is a sprite sheet whose inline hiding was removed: mark it. */
function markSpriteSheets(root: DocumentFragment): void {
  for (const svg of root.querySelectorAll("svg")) {
    const drawn = [...svg.children].some((child) => child.nodeName.toLowerCase() !== "defs");
    if (!drawn) svg.classList.add("fv-defs");
  }
}

/** Sanitise Python-authored HTML into a fragment owned by `doc`, ready to append. */
export function sanitizeHtml(html: string, doc: Document): DocumentFragment {
  const view = doc.defaultView;
  if (!view) throw new Error("sanitizeHtml needs a document with a window.");
  const fragment = purifierFor(view).sanitize(html, config(false)) as DocumentFragment;
  const owned = doc.importNode(fragment, true);
  namespaceIds(owned);
  markSpriteSheets(owned);
  return owned;
}

/**
 * Sanitise a standalone SVG document to its restricted subset, serialised. It is then shown as an
 * image, where a browser runs no script and loads nothing, so this is the second of two walls.
 */
export function sanitizeSvg(svg: string, doc: Document): string | null {
  const view = doc.defaultView;
  if (!view) return null;
  const fragment = purifierFor(view).sanitize(svg, config(true)) as DocumentFragment;
  const root = fragment.firstElementChild;
  if (!root || root.nodeName.toLowerCase() !== "svg") return null;
  if (!root.getAttribute("xmlns")) root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new view.XMLSerializer().serializeToString(root);
}
