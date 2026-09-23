/**
 * Navigation overflow.
 *
 * Navigation is runtime-defined: an administrator can add a tab called "Frequently asked questions
 * about the reanalysis archive" and the header must neither wrap nor hide it. So this module
 * MEASURES rather than estimating from `label.length`, which is wrong for CJK labels, for any
 * proportional font, and for every label containing an em dash. Each tab is rendered once at its
 * natural width, the widths are read in a single pass, and the split point is arithmetic. A
 * `ResizeObserver` on the nav container re-runs it whenever the available width changes - window
 * resizes, a sidebar opening, a font finishing loading, zoom.
 *
 * Two properties the tests pin: every entry is reachable in every state (visible, in `More`, or
 * in the compact menu), and at least one tab stays visible, so the bar never collapses to just
 * `More` while there is room for something.
 */

export interface MeasuredItem {
  readonly id: string;
  readonly width: number;
}

export interface OverflowSplit {
  readonly visible: readonly string[];
  readonly overflow: readonly string[];
}

/**
 * Split measured items into those that fit and those that do not. `moreWidth` is reserved only
 * when something actually overflows, because reserving it unconditionally pushes out a tab that
 * would otherwise have fitted exactly - hence the two passes.
 */
export function splitForWidth(
  items: readonly MeasuredItem[],
  options: { available: number; gap: number; moreWidth: number },
): OverflowSplit {
  if (items.length === 0) return { visible: [], overflow: [] };

  const total = items.reduce((sum, item, index) => sum + item.width + (index ? options.gap : 0), 0);
  if (total <= options.available) {
    return { visible: items.map((item) => item.id), overflow: [] };
  }

  const budget = options.available - options.moreWidth - options.gap;
  const visible: string[] = [];
  let used = 0;
  for (const item of items) {
    const cost = item.width + (visible.length ? options.gap : 0);
    if (used + cost > budget) break;
    used += cost;
    visible.push(item.id);
  }
  // Never collapse to nothing: one truncated tab plus `More` beats a bare `More`.
  if (visible.length === 0 && items.length > 0) visible.push(items[0]!.id);

  const shown = new Set(visible);
  return { visible, overflow: items.filter((item) => !shown.has(item.id)).map((item) => item.id) };
}

export interface OverflowControllerOptions {
  /** The element whose inline size is the budget. */
  readonly container: HTMLElement;
  /** Measure every entry at its natural width. Called on each recompute. */
  readonly measure: () => readonly MeasuredItem[];
  /** Natural width of the `More` button. */
  readonly moreWidth: () => number;
  readonly gap: number;
  readonly apply: (split: OverflowSplit) => void;
  /** See `PortalFooter`: constructors live on the global scope, not on `Window`. */
  readonly window: Window & typeof globalThis;
}

/**
 * Drives the split from real measurements. Recomputes are coalesced into an animation frame: a
 * `ResizeObserver` fires many times during a drag-resize, and laying out the nav on each one is
 * wasteful and visibly jittery.
 */
export class NavOverflowController {
  private readonly options: OverflowControllerOptions;
  private observer: ResizeObserver | null = null;
  private frame: number | null = null;
  private resizeHandler: (() => void) | null = null;

  constructor(options: OverflowControllerOptions) {
    this.options = options;
  }

  start(): void {
    const { window: win, container } = this.options;
    if (typeof win.ResizeObserver === "function") {
      this.observer = new win.ResizeObserver(() => this.schedule());
      this.observer.observe(container);
    } else {
      // Environments without ResizeObserver (older browsers, some test DOMs) still get correct
      // behaviour, just at window granularity.
      this.resizeHandler = () => this.schedule();
      win.addEventListener("resize", this.resizeHandler);
    }
    this.recompute();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.resizeHandler) this.options.window.removeEventListener("resize", this.resizeHandler);
    this.resizeHandler = null;
    if (this.frame !== null) this.options.window.cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  /** Force a recompute, e.g. after the manifest changed the entry list. */
  schedule(): void {
    if (this.frame !== null) return;
    this.frame = this.options.window.requestAnimationFrame(() => {
      this.frame = null;
      this.recompute();
    });
  }

  private recompute(): void {
    const available = this.options.container.clientWidth;
    // A container with no layout yet (display:none, not attached) measures 0. Showing everything
    // is the safe reading: nothing becomes unreachable.
    if (available <= 0) {
      this.options.apply({ visible: this.options.measure().map((i) => i.id), overflow: [] });
      return;
    }
    this.options.apply(
      splitForWidth(this.options.measure(), {
        available,
        gap: this.options.gap,
        moreWidth: this.options.moreWidth(),
      }),
    );
  }
}

/**
 * Below this width the whole nav becomes one compact control.
 *
 * A phone breakpoint, not a desktop one: compact mode and the overflow split are separate
 * decisions. The overflow split is a measurement and works at any width; compact is for the width
 * where no tab fits beside the brand lockup at all. At 1120 an 834px header shows one button and
 * a logo with room for four tabs going spare. Priority+ covers everything from here up, and this
 * governs only the phone panel.
 */
export const COMPACT_BREAKPOINT = 720;

export function isCompact(win: Window): boolean {
  return win.innerWidth < COMPACT_BREAKPOINT;
}
