// The side bar ClimateClaw's panel opens in: wide enough for a conversation (about a third of
// the window), never narrower than the user left it.

/** JupyterLab's split between the left side bar, the main area and the right side bar. */
interface MainSplit {
  readonly node: HTMLElement;
  relativeSizes(): number[];
  setRelativeSizes(sizes: number[]): void;
}

/** The left side bar's share for a window `total` px wide, or null to leave the split as it is. */
export function widerLeft(sizes: readonly number[], total: number): number[] | null {
  if (sizes.length < 2 || total <= 0) return null;
  const want = Math.min(560, Math.max(420, total * 0.32)) / total;
  const left = sizes[0]!;
  if (left >= want) return null;
  const main = sizes[1]! - (want - left);
  // A small window keeps most of its room for the notebook.
  if (main < 0.35) return null;
  return [want, main, ...sizes.slice(2)];
}

function splitOf(shell: unknown): MainSplit | null {
  const split = (shell as { _hsplitPanel?: Partial<MainSplit> } | null)?._hsplitPanel;
  return split?.relativeSizes && split.setRelativeSizes && split.node ? (split as MainSplit) : null;
}

/**
 * Widens the left side bar when it is narrower than that. JupyterLab has no public setter for
 * the side bar's width: its shell's split panel is used when it is there, else nothing changes.
 * False while there is nothing to measure yet: the page (or the frame it is in) has no width,
 * or the side bar is still closed.
 */
export function widenLeftArea(shell: unknown): boolean {
  const split = splitOf(shell);
  if (!split) return true;
  const current = split.relativeSizes();
  if (split.node.clientWidth <= 0 || !(current[0]! > 0)) return false;
  const sizes = widerLeft(current, split.node.clientWidth);
  if (sizes) split.setRelativeSizes(sizes);
  return true;
}

/**
 * Widens it once the page can be measured: a notebook loaded in a frame that is not laid out yet
 * (a fresh visit, a frame further down the page) has no width at first. Tried at each resize
 * until it could be done, for `forMs` at most - never later, so it never undoes the user's drag.
 */
export function widenLeftAreaWhenReady(shell: unknown, forMs = 15_000): void {
  if (widenLeftArea(shell)) return;
  const split = splitOf(shell);
  if (!split || typeof ResizeObserver !== "function") return;
  const started = Date.now();
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    // After the layout this resize belongs to.
    frame = requestAnimationFrame(() => {
      if (widenLeftArea(shell) || Date.now() - started > forMs) observer.disconnect();
    });
  });
  observer.observe(split.node);
  // The side bar opening does not resize the split's node: look again a few times.
  for (const wait of [250, 1_000, 3_000]) {
    setTimeout(() => {
      if (Date.now() - started <= forMs && widenLeftArea(shell)) observer.disconnect();
    }, wait);
  }
  setTimeout(() => observer.disconnect(), forMs);
}

export function otherPanelRequested(href: string): boolean {
  try {
    const params = new URL(href).searchParams;
    const panel = params.get("panel");
    return params.has("dataset") || (panel !== null && panel !== "climateclaw");
  } catch {
    return false;
  }
}
