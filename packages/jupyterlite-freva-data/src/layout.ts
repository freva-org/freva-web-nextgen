interface MainSplit {
  readonly node: HTMLElement;
  relativeSizes(): number[];
  setRelativeSizes(sizes: number[]): void;
}

export function widerLeft(sizes: readonly number[], total: number): number[] | null {
  if (sizes.length < 2 || total <= 0) return null;
  const want = Math.min(560, Math.max(420, total * 0.32)) / total;
  const left = sizes[0]!;
  if (left >= want) return null;
  const main = sizes[1]! - (want - left);
  if (main < 0.35) return null;
  return [want, main, ...sizes.slice(2)];
}

function splitOf(shell: unknown): MainSplit | null {
  const split = (shell as { _hsplitPanel?: Partial<MainSplit> } | null)?._hsplitPanel;
  return split?.relativeSizes && split.setRelativeSizes && split.node ? (split as MainSplit) : null;
}

export function widenLeftArea(shell: unknown): boolean {
  const split = splitOf(shell);
  if (!split) return true;
  const current = split.relativeSizes();
  if (split.node.clientWidth <= 0 || !(current[0]! > 0)) return false;
  const sizes = widerLeft(current, split.node.clientWidth);
  if (sizes) split.setRelativeSizes(sizes);
  return true;
}

export function widenLeftAreaWhenReady(shell: unknown, forMs = 15_000): void {
  if (widenLeftArea(shell)) return;
  const split = splitOf(shell);
  if (!split || typeof ResizeObserver !== "function") return;
  const started = Date.now();
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (widenLeftArea(shell) || Date.now() - started > forMs) observer.disconnect();
    });
  });
  observer.observe(split.node);
  for (const wait of [250, 1_000, 3_000]) {
    setTimeout(() => {
      if (Date.now() - started <= forMs && widenLeftArea(shell)) observer.disconnect();
    }, wait);
  }
  setTimeout(() => observer.disconnect(), forMs);
}
