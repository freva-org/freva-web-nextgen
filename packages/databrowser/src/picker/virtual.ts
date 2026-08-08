// picker/virtual.ts - a windowed list, so N results cost O(visible) live nodes and listeners.
//
// The full browser renders incrementally (`appendChunked`) and accepts a growing node count,
// because a user who has scrolled through 1,000 rows there generally wants them all present -
// selection, comparison and export all work across the loaded set. A picker is the opposite: it is
// a transient dialog inside someone else's application, opened and closed repeatedly, and 1,000
// live rows with 1,000 listeners is a cost the host pays for nothing.
//
// So this recycles. A fixed row height turns "which rows are visible" into arithmetic instead of
// measurement, a single spacer carries the full scroll height, and exactly one delegated listener
// serves every row - the rows themselves have none.
//
// ACCESSIBILITY. The spacer and the moving viewport are structural: they exist to make scrolling
// arithmetic work, and they carry no meaning. They are therefore `role="presentation"`, NOT
// `aria-hidden="true"`. That distinction is the whole ball game: `aria-hidden` on an ancestor
// removes its entire subtree from the accessibility tree, so `aria-hidden` here would hide every
// `role="option"` row behind it and the result list would not exist for assistive technology.
// `presentation` does the opposite - it makes the wrappers transparent, so the options are exposed
// as direct children of the listbox, which is also what ARIA's parent/child requirement wants.
//
// jsdom has no layout, so `clientHeight` is 0 there. Rather than render nothing (which would make
// every list test vacuous), an unmeasurable viewport falls back to a fixed window: still bounded,
// still exercised, and honest about which branch it took via `usedFallback`.

import { el } from "../dom.js";

export interface VirtualListOptions<T> {
  /** The scrolling element. Must be able to scroll; the list manages its children. */
  scroller: HTMLElement;
  rowHeight: number;
  /** Extra rows rendered above and below the viewport, to hide fast scrolling. */
  overscan?: number;
  /** Window size used when the viewport cannot be measured (jsdom, display:none). */
  fallbackWindow?: number;
  renderRow: (item: T, index: number) => HTMLElement;
}

export interface VirtualList<T> {
  setItems(items: T[]): void;
  /** Re-render the currently visible window in place (e.g. after a selection change). */
  refresh(): void;
  /** Live row elements right now - the number a leak test counts. */
  liveRowCount(): number;
  /** True when the viewport could not be measured and the fallback window was used. */
  usedFallback(): boolean;
  /** Index range currently materialised, as [first, lastExclusive). */
  range(): [number, number];
  /**
   * Scroll `index` into view and materialise it. Returns true when the row exists. Needed by the
   * listbox keyboard pattern: `aria-activedescendant` must point at an element that is actually in
   * the DOM, which in a recycling list is only true once its window has been painted.
   */
  scrollToIndex(index: number): boolean;
  scrollToTop(): void;
  destroy(): void;
}

export function createVirtualList<T>(opts: VirtualListOptions<T>): VirtualList<T> {
  const overscan = opts.overscan ?? 6;
  const fallbackWindow = opts.fallbackWindow ?? 30;
  // `presentation`, never `aria-hidden` - see the header comment.
  const spacer = el("div", { class: "fp-vspace", role: "presentation" });
  const viewport = el("div", { class: "fp-vrows", role: "presentation" });
  spacer.style.position = "relative";
  viewport.style.position = "absolute";
  viewport.style.left = "0";
  viewport.style.right = "0";
  viewport.style.top = "0";
  spacer.append(viewport);
  opts.scroller.append(spacer);

  let items: T[] = [];
  let fallback = false;
  let destroyed = false;
  let first = 0;
  let last = 0;
  /**
   * The index the window must contain. In MEASURED mode `scrollTop` decides that and this is
   * ignored; in FALLBACK mode there is no scroll position to read, so without it the window would
   * be pinned to [0, fallbackWindow) and `scrollToIndex(49)` could never materialise its row -
   * which would leave `aria-activedescendant` pointing at nothing.
   */
  let anchor = 0;

  const paint = (): void => {
    if (destroyed) return;
    spacer.style.height = `${items.length * opts.rowHeight}px`;
    const h = opts.scroller.clientHeight;
    fallback = !(h > 0);
    const visible = fallback ? fallbackWindow : Math.ceil(h / opts.rowHeight) + overscan * 2;
    first = fallback
      ? Math.max(0, Math.min(anchor - Math.floor(visible / 2), items.length - visible))
      : Math.max(0, Math.floor(opts.scroller.scrollTop / opts.rowHeight) - overscan);
    last = Math.min(items.length, first + visible);
    viewport.style.transform = `translateY(${first * opts.rowHeight}px)`;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(opts.renderRow(items[i], i));
    // One replacement, not N removals: the old rows go with their listeners (there are none on
    // them by design), and nothing detached is left referenced.
    viewport.textContent = "";
    viewport.append(frag);
  };

  const onScroll = (): void => paint();
  opts.scroller.addEventListener("scroll", onScroll, { passive: true });

  return {
    setItems(next: T[]) {
      items = next;
      anchor = 0; // a new result set starts at the top
      paint();
    },
    refresh: paint,
    liveRowCount: () => viewport.childElementCount,
    usedFallback: () => fallback,
    range: () => [first, last],
    scrollToIndex(index: number) {
      if (index < 0 || index >= items.length) return false;
      anchor = index;
      if (!fallback) {
        const top = index * opts.rowHeight;
        const viewTop = opts.scroller.scrollTop;
        const viewBottom = viewTop + opts.scroller.clientHeight;
        if (top < viewTop) opts.scroller.scrollTop = top;
        else if (top + opts.rowHeight > viewBottom) {
          opts.scroller.scrollTop = top + opts.rowHeight - opts.scroller.clientHeight;
        }
      }
      paint(); // synchronous, so the caller can point aria-activedescendant at a real element
      return index >= first && index < last;
    },
    scrollToTop() {
      opts.scroller.scrollTop = 0;
      anchor = 0;
      paint();
    },
    destroy() {
      destroyed = true;
      opts.scroller.removeEventListener("scroll", onScroll);
      spacer.remove();
    },
  };
}
