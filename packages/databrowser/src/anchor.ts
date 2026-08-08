// anchor.ts - THE shared anchored-overlay positioning rule.
//
// The failure this exists to remove: an overlay appended INSIDE `.freva-db` but assigned viewport
// coordinates via `position: fixed`. That only works while `.freva-db` has no containing block
// above it. An embedding host - Waterpark relocates the mount into `.md-content`, gives it
// `height: calc(100vh - header)` and `overflow: hidden`, and navigates instantly - breaks both
// halves of the assumption: a transformed/filtered/contained ancestor makes `fixed` resolve against
// THAT ancestor instead of the viewport, and the clipping container hides whatever lands outside it.
// The result is menus detached from their trigger, or invisible.
//
// One rule, used by `popover.ts`, `components/searchBar.ts` and `components/tooltip.ts` alike:
//   • overlays live on the `.freva-db` root and are `position: absolute`;
//   • anchor viewport rects are converted to ROOT-LOCAL coordinates by subtracting the root rect;
//   • everything is clamped to the VISIBLE INTERSECTION of the component root and the viewport, so
//     an overlay can never be larger than, or positioned outside, the part of the component the
//     user can actually see.
//
// Nothing here reads `window.innerWidth` as if it were the component's width.

export type OverlayPlacement = "below" | "right";

/**
 * What a scroll does to an open overlay.
 *  • 'close'      - transient menus (row kebab, Export, flavour, the value-search dropdown). A menu
 *                   that follows its anchor across a scroll reads as stuck to the glass.
 *  • 'reposition' - editors that explicitly support re-anchoring and must survive their own action
 *                   re-rendering the row underneath them.
 */
export type ScrollBehavior = "close" | "reposition";

export interface VisibleBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Does this environment actually lay elements out? A DOM with no layout engine (jsdom) reports
 * every rect as 0x0, and so does a hidden subtree. Everything below FAILS OPEN on that: we cannot
 * judge visibility without geometry, so we must not hide or refuse to place an overlay because of
 * measurements that were never real.
 */
export function hasLayout(root: HTMLElement): boolean {
  const r = root.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * The visible intersection of `root` and the browser viewport, in ROOT-LOCAL coordinates.
 * Width/height are clamped at 0, so a fully-scrolled-away root yields an empty box rather than
 * negative sizes that would silently invert every later comparison.
 */
export function visibleBox(root: HTMLElement): VisibleBox {
  const r = root.getBoundingClientRect();
  const vw = window.innerWidth || r.width;
  const vh = window.innerHeight || r.height;
  const left = Math.max(r.left, 0) - r.left;
  const top = Math.max(r.top, 0) - r.top;
  const right = Math.min(r.right, vw) - r.left;
  const bottom = Math.min(r.bottom, vh) - r.top;
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** An element's box in ROOT-LOCAL coordinates. */
export function localRect(
  root: HTMLElement,
  node: HTMLElement,
): { top: number; left: number; right: number; bottom: number; width: number; height: number } {
  const r = root.getBoundingClientRect();
  const n = node.getBoundingClientRect();
  return {
    top: n.top - r.top,
    left: n.left - r.left,
    right: n.right - r.left,
    bottom: n.bottom - r.top,
    width: n.width,
    height: n.height,
  };
}

/**
 * Is the anchor still attached AND at least partly inside the component's visible area? An anchor
 * scrolled out of a nested result scroller is gone as far as the user is concerned, so an overlay
 * pointing at it is pointing at nothing.
 */
export function anchorVisible(root: HTMLElement, anchor: HTMLElement): boolean {
  // Attachment is the one thing we can always answer, and it is the only hard requirement.
  if (!anchor.isConnected || !root.contains(anchor)) return false;
  if (!hasLayout(root)) return true; // no geometry to judge by - see hasLayout()
  const box = visibleBox(root);
  if (box.width === 0 || box.height === 0) return false; // the component is scrolled fully away
  const a = localRect(root, anchor);
  if (a.width === 0 && a.height === 0) return false; // display:none
  return a.right > box.left && a.left < box.right && a.bottom > box.top && a.top < box.bottom;
}

export interface PositionOptions {
  placement?: OverlayPlacement;
  /** Space kept between the overlay and the edges of the visible box. */
  margin?: number;
  /** Space between the anchor and the overlay. */
  gap?: number;
  /** Minimum width to request; still clamped to the visible box. */
  minWidth?: number;
  maxWidth?: number;
  /**
   * The tallest this overlay wants to be, in pixels. OPTIONAL, and only ever a further restriction:
   * the effective cap is `min(availableHeight, maxHeight)`, so the visible box still wins when it is
   * the smaller of the two and an embedded host can never be overflowed by a caller's number.
   *
   * Without it, the height written here is the whole available height - which SILENTLY OVERRIDES a
   * stylesheet's own `max-height`, because an inline style beats a rule. That is what lets the
   * value search dropdown grow to nearly the full component height despite `.vsearch-pop` asking
   * for 340px.
   */
  maxHeight?: number;
}

/**
 * Place `overlay` (a child of `root`, `position: absolute`) against `anchor`.
 *
 * Order of operations matters: the size caps are applied BEFORE measuring, so a tall or wide
 * overlay is measured at the size it will actually be drawn - measuring first and capping after is
 * what lets a popover overhang an edge by exactly the amount it was later shrunk by.
 */
export function positionAnchored(
  root: HTMLElement,
  overlay: HTMLElement,
  anchor: HTMLElement,
  opts: PositionOptions = {},
): void {
  const margin = opts.margin ?? 8;
  const gap = opts.gap ?? 6;
  const placement = opts.placement ?? "below";
  if (!hasLayout(root)) return; // nothing to measure against - leave the overlay's own defaults
  const box = visibleBox(root);
  if (box.width === 0 || box.height === 0) return; // nothing of the component is on screen

  // Never larger than the visible intersection - in EITHER axis. Its own content scrolls instead.
  const availW = Math.max(0, box.width - margin * 2);
  const availH = Math.max(0, box.height - margin * 2);
  // The caller's request is a FURTHER restriction, never a licence to grow: whichever is smaller
  // wins. The same number is then used for the style, the measurement, the flip decision and the
  // clamp - using the available height for some of those and the requested cap for others is how an
  // overlay ends up flipped or clamped against a height it was never going to have.
  const maxW = Math.min(availW, opts.maxWidth ?? availW);
  const maxH = Math.min(availH, opts.maxHeight ?? availH);
  overlay.style.maxWidth = `${maxW}px`;
  overlay.style.maxHeight = `${maxH}px`;
  overlay.style.overflowY = "auto";
  if (opts.minWidth) overlay.style.minWidth = `${Math.min(opts.minWidth, maxW)}px`;

  const a = localRect(root, anchor);
  // Measure from the BOX, not offsetWidth/offsetHeight: the box is fractional, survives transforms,
  // and is what actually determines whether the overlay overhangs an edge.
  const own = overlay.getBoundingClientRect();
  const w = Math.min(own.width || overlay.offsetWidth, maxW);
  // The overlay is CONTENT-SIZED up to the cap: a dropdown with three results measures three rows
  // tall and is placed against that, not against the cap it never reached.
  const h = Math.min(own.height || overlay.offsetHeight, maxH);

  let top: number;
  let left: number;
  if (placement === "right") {
    top = a.top;
    left = a.right + margin;
    if (left + w > box.right - margin) left = a.left - w - margin; // flip to the left
  } else {
    top = a.bottom + gap;
    left = a.left;
    if (top + h > box.bottom - margin) top = a.top - h - gap; // flip above
  }
  left = Math.min(left, box.right - margin - w);
  left = Math.max(left, box.left + margin);
  top = Math.min(top, box.bottom - margin - h);
  top = Math.max(top, box.top + margin);

  overlay.style.left = `${Math.round(left)}px`;
  overlay.style.top = `${Math.round(top)}px`;
}
