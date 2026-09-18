// dom.ts - element construction helpers. There is no `innerHTML` anywhere in this package,
// including for icons: every element, attribute and text node goes through here. A dataset catalog
// is untrusted input, and the cheapest way to be sure no catalog string is ever parsed as markup is
// to own no code path that could parse one.

const SVG_NS = "http://www.w3.org/2000/svg";

export interface ElementSpec {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  children?: readonly (Node | null | undefined)[];
}

/** Create an element, set its class and text, apply attributes, append children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  spec: ElementSpec = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (spec.class) node.className = spec.class;
  if (spec.text !== undefined) node.textContent = spec.text;
  if (spec.title !== undefined) node.title = spec.title;
  if (spec.attrs) {
    for (const [name, value] of Object.entries(spec.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(name, value === true ? "" : String(value));
    }
  }
  if (spec.children) {
    for (const child of spec.children) if (child) node.appendChild(child);
  }
  return node;
}

/**
 * A `<button type="button">`. The type matters: this component may be mounted inside a consumer's
 * `<form>` - a landing page is a plausible host - where a default-typed button submits it, and an
 * expand control that navigates the page is a spectacular bug to debug from a screenshot.
 */
export function button(spec: ElementSpec & { action?: string; key?: string }): HTMLButtonElement {
  const node = el("button", spec);
  node.type = "button";
  if (spec.action) node.dataset.dtAction = spec.action;
  if (spec.key) node.dataset.dtKey = spec.key;
  return node;
}

/**
 * An inline icon, built from path data, in two treatments on one 16x16 grid. The controls -
 * chevron, magnifier, information, external link - are stroked, because a 1.5px outline is what a
 * control's glyph looks like next to text. The subjects - a folder, a store, a file - are filled,
 * because they are what the eye scans a tree by: at 13px outlined shapes differ by a couple of
 * interior strokes and a list of them reads as a column of identical wireframes, while solid
 * silhouettes are distinguishable at a glance and down a page, and survive a 200% zoom and a coarse
 * display better than a hairline does. Always `aria-hidden`: every control that carries an icon
 * also carries a real accessible name, so announcing the glyph would double the announcement.
 */
export function icon(
  paths: readonly string[],
  className: string,
  treatment: "stroke" | "fill" = "stroke",
): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 16 16");
  if (treatment === "fill") {
    svg.setAttribute("fill", "currentColor");
    // Even-odd, so a filled glyph can carry a hole - the open top of the store, the folded corner
    // of the page - without a second colour or element.
    svg.setAttribute("fill-rule", "evenodd");
  } else {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  }
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** Text that only assistive technology reads. */
export function visuallyHidden(text: string): HTMLElement {
  return el("span", { class: "dataset-tree__sr", text });
}
