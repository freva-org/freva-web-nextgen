// perf.ts - dev-flag-gated instrumentation. When config.devNotes is on, the
// controller wraps the hot phases (fetch+parse, wire->view normalisation, each render region)
// in performance.mark/measure pairs and keeps a rolling per-label summary. Disabled, every
// call is a no-op passthrough with zero allocation beyond the closure. Numbers are readable
// via `window.__frevaPerf` in a dev session and via getSummary() from the bench harness.

export interface PerfTimer {
  /** Time a synchronous phase. */
  time<T>(label: string, fn: () => T): T;
  /** Start a phase manually; returns a stop() that records the measure. */
  start(label: string): () => void;
  /** label -> { count, totalMs, maxMs, lastMs } for everything recorded so far. */
  getSummary(): Record<string, { count: number; totalMs: number; maxMs: number; lastMs: number }>;
  readonly enabled: boolean;
}

const noop: PerfTimer = {
  time: <T>(_label: string, fn: () => T): T => fn(),
  start: () => () => undefined,
  getSummary: () => ({}),
  enabled: false,
};

export function createPerf(enabled: boolean): PerfTimer {
  if (!enabled) return noop;
  const summary: Record<string, { count: number; totalMs: number; maxMs: number; lastMs: number }> =
    {};
  const hasPerf = typeof performance !== "undefined" && typeof performance.now === "function";
  const now = (): number => (hasPerf ? performance.now() : Date.now());
  const record = (label: string, ms: number): void => {
    const s = summary[label] ?? (summary[label] = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 });
    s.count++;
    s.totalMs += ms;
    s.lastMs = ms;
    if (ms > s.maxMs) s.maxMs = ms;
    if (
      hasPerf &&
      typeof performance.mark === "function" &&
      typeof performance.measure === "function"
    ) {
      try {
        performance.measure(`fdb:${label}`, {
          start: now() - ms,
          duration: ms,
        } as unknown as string);
      } catch {
        /* older performance.measure signatures - the summary object still has the numbers */
      }
    }
  };
  const timer: PerfTimer = {
    enabled: true,
    time<T>(label: string, fn: () => T): T {
      const t0 = now();
      try {
        return fn();
      } finally {
        record(label, now() - t0);
      }
    },
    start(label: string): () => void {
      const t0 = now();
      return () => record(label, now() - t0);
    },
    getSummary: () => summary,
  };
  // expose for interactive dev sessions (devNotes only - never in production mounts)
  (globalThis as Record<string, unknown>).__frevaPerf = timer;
  return timer;
}
