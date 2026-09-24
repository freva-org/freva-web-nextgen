// dom.ts - the two element helpers the Cosmos island needs.
//
// Small on purpose. The scene itself is a canvas, so the only DOM this theme builds is the Scene
// key: a control, a panel and a handful of rows. Everything is created and given text; nothing is
// parsed from a string.

export interface ElementSpec {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  children?: readonly Node[];
}

/** Create an element, set its class and text, apply attributes, append children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  spec: ElementSpec = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (spec.class) node.className = spec.class;
  if (spec.text !== undefined) node.textContent = spec.text;
  if (spec.attrs) {
    for (const [name, value] of Object.entries(spec.attrs)) node.setAttribute(name, value);
  }
  if (spec.children) {
    for (const child of spec.children) node.appendChild(child);
  }
  return node;
}

/**
 * Keep a disclosure's three moving parts in step: `aria-expanded` on the control, `hidden` on the
 * panel, and the two pointing at each other. Separated by a hundred lines they are how one of them
 * ends up not being updated.
 */
export function setDisclosure(control: HTMLElement, panel: HTMLElement, open: boolean): void {
  control.setAttribute("aria-expanded", String(open));
  panel.hidden = !open;
}
