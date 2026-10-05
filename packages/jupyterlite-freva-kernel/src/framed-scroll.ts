// In a page that frames the notebook, a scroll inside the notebook stays inside it. The browser
// brings a focused element, or one asked to scroll into view, into view in every scrolling
// ancestor - the framing page too, so the page jumps whenever JupyterLab or the chat focuses an
// input or follows a new message. Framed only, both are routed to the notebook's own scrolling
// boxes: focus never scrolls on its own, and scrollIntoView moves only the boxes inside this
// document. Nothing changes in a notebook that is not framed.

type Block = "start" | "center" | "end" | "nearest";

interface Box {
  top: number;
  left: number;
  height: number;
  width: number;
}

/** How far a box must scroll so that `target` sits at `align` in a view of `size` (0: stay). */
export function scrollDelta(offset: number, length: number, size: number, align: Block): number {
  if (align === "start") return offset;
  if (align === "end") return offset + length - size;
  if (align === "center") return offset + length / 2 - size / 2;
  // nearest: only when not already whole in view; the start wins when it does not fit.
  if (offset < 0 || length > size) return offset;
  if (offset + length > size) return offset + length - size;
  return 0;
}

function scrolls(value: string): boolean {
  return value === "auto" || value === "scroll" || value === "overlay";
}

/** scrollIntoView's options, as the standard reads them. */
export function alignment(arg?: boolean | ScrollIntoViewOptions): {
  block: Block;
  inline: Block;
  behavior?: ScrollBehavior;
} {
  if (arg === false) return { block: "end", inline: "nearest" };
  if (arg === true || arg === undefined || arg === null)
    return { block: "start", inline: "nearest" };
  return {
    block: (arg.block as Block) ?? "start",
    inline: (arg.inline as Block) ?? "nearest",
    ...(arg.behavior ? { behavior: arg.behavior } : {}),
  };
}

/** Scrolls `element` into view in its scrolling ancestors within this document, and no further. */
export function scrollWithin(element: Element, arg?: boolean | ScrollIntoViewOptions): void {
  const { block, inline, behavior } = alignment(arg);
  const root = element.ownerDocument;
  for (let box = element.parentElement; box; box = box.parentElement) {
    if (box === root.body || box === root.documentElement) break;
    const style = getComputedStyle(box);
    const y = scrolls(style.overflowY) && box.scrollHeight > box.clientHeight;
    const x = scrolls(style.overflowX) && box.scrollWidth > box.clientWidth;
    if (!y && !x) continue;
    const target: Box = element.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    const top = y
      ? scrollDelta(target.top - view.top - box.clientTop, target.height, box.clientHeight, block)
      : 0;
    const left = x
      ? scrollDelta(target.left - view.left - box.clientLeft, target.width, box.clientWidth, inline)
      : 0;
    if (top || left) box.scrollBy({ top, left, ...(behavior ? { behavior } : {}) });
  }
}

/** Routes focus and scrollIntoView to the notebook's own boxes; returns the undo. */
export function containScrolling(win: Window & typeof globalThis = window): () => void {
  const element = win.Element.prototype;
  const html = win.HTMLElement.prototype;
  const focus = html.focus;
  const intoView = element.scrollIntoView;
  html.focus = function (this: HTMLElement, options?: FocusOptions) {
    focus.call(this, { ...options, preventScroll: true });
    if (!options?.preventScroll) scrollWithin(this, { block: "nearest", inline: "nearest" });
  };
  element.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    scrollWithin(this, arg);
  };
  return () => {
    html.focus = focus;
    element.scrollIntoView = intoView;
  };
}
