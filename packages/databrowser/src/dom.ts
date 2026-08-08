// dom.ts - DOM safety helpers and the tracked disposer registry.
//
// Rule: dynamic, API-/user-derived strings NEVER reach innerHTML. They go in via
// textContent / setAttribute. The single exception is escapeHtml(), used only for the
// terminal's highlight overlay, where every token is escaped before assembling markup.

/** Escape the five HTML-significant characters. Used only for the terminal overlay. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type Attrs = Record<string, string | number | boolean | null | undefined>;
export type Child = Node | string | null | undefined | false;

/**
 * Create an element. Attributes are applied via setAttribute; the special keys
 * `class` and `text` set className / textContent. `text` is the ONLY way to put
 * dynamic text in - there is deliberately no `html` escape hatch.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs & { class?: string; text?: string },
  children?: Child[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  let tipTitle: string | null = null;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = String(v);
      else if (k === "text") node.textContent = String(v);
      else if (k === "title") {
        // Route `title` to our immediate, styled tooltip (see components/tooltip.ts) instead of the
        // browser's slow (~1s), unstyled native popup. The accessible-name fallback is decided AFTER
        // children exist (below), so a visible text label is never clobbered by the tip text.
        node.setAttribute("data-tip", String(v));
        tipTitle = String(v);
      } else node.setAttribute(k, String(v));
    }
  }
  if (children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      node.append(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  // Only mirror `title`->`aria-label` when the node is otherwise unlabelled: no
  // explicit ARIA name AND no visible text. An icon-only control still gets an accessible name; a
  // control that reads "flexible"/"strict" keeps that name instead of the long help sentence.
  if (
    tipTitle &&
    !node.getAttribute("aria-label") &&
    !node.getAttribute("aria-labelledby") &&
    !(node.textContent && node.textContent.trim())
  ) {
    node.setAttribute("aria-label", tipTitle);
  }
  return node;
}

export function replaceChildren(host: Element, ...nodes: Child[]): void {
  host.textContent = "";
  for (const n of nodes) {
    if (n === null || n === undefined || n === false) continue;
    host.append(typeof n === "string" ? document.createTextNode(n) : n);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build an inline SVG icon from a COMPILE-TIME-CONSTANT path string. The `d`/markup
 * passed here is always a literal in icons.ts, never API data, so innerHTML is safe.
 */
export function svgIcon(
  constMarkup: string,
  opts?: { size?: number; viewBox?: string },
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  const size = opts?.size ?? 18;
  svg.setAttribute("viewBox", opts?.viewBox ?? "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  // constMarkup is a trusted literal from icons.ts
  svg.innerHTML = constMarkup;
  return svg;
}

// Disposables - the ONLY sanctioned way to attach document/window listeners,
// timers, AbortControllers and rAF handles. destroy() flushes everything.

type Disposer = () => void;

export class Disposables {
  private items: Disposer[] = [];
  private disposed = false;

  /** Whether flush() has run - used to refuse late async work after teardown. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Number of live disposers currently registered - used by tests/bench to assert no growth. */
  get size(): number {
    return this.items.length;
  }

  /** Track a teardown function directly. Returns a handle that de-registers it (without running
   *  it) so a caller that tears down early doesn't leave a dead closure in the registry. */
  add(fn: Disposer): Disposer {
    if (this.disposed) {
      fn();
      return () => {};
    }
    this.items.push(fn);
    return () => this.removeDisposer(fn);
  }

  /** addEventListener that auto-removes on dispose. The returned remover both detaches the
   *  listener AND de-registers itself, so manual cleanup (e.g. a dismissed toast) leaves nothing
   *  behind in the registry. Idempotent. */
  listen<T extends EventTarget>(
    target: T,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): Disposer {
    target.addEventListener(type, handler, options);
    let active = true;
    let deregister: Disposer = () => {};
    const off = (): void => {
      if (!active) return;
      active = false;
      target.removeEventListener(type, handler, options);
      deregister();
    };
    deregister = this.add(off);
    return off;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.removeDisposer(clear);
      fn();
    }, ms);
    const clear = () => window.clearTimeout(id);
    this.add(clear);
    return id;
  }

  setInterval(fn: () => void, ms: number): number {
    const id = window.setInterval(fn, ms);
    this.add(() => window.clearInterval(id));
    return id;
  }

  raf(fn: FrameRequestCallback): number {
    const id = window.requestAnimationFrame((t) => {
      this.removeDisposer(clear);
      fn(t);
    });
    const clear = () => window.cancelAnimationFrame(id);
    this.add(clear);
    return id;
  }

  /** Track an AbortController so an in-flight request is aborted on destroy. */
  abortController(): AbortController {
    const ac = new AbortController();
    const fn = () => ac.abort();
    this.add(fn);
    return ac;
  }

  /**
   * A sub-registry the parent flushes on destroy. Used for per-region listener buckets:
   * a long-lived render region calls child() once, then flushes+replaces that bucket on every
   * re-render so detached-node listeners don't accumulate in the app-wide registry. A child
   * flushed on its own also detaches from the parent so it isn't double-run.
   */
  child(): Disposables {
    const c = new Disposables();
    const fn = (): void => c.flush();
    this.add(fn);
    c.detach = (): void => this.removeDisposer(fn);
    return c;
  }

  /** set by the parent when this is a child registry; removes our flush hook from the parent. */
  private detach: (() => void) | null = null;

  private removeDisposer(fn: Disposer): void {
    const i = this.items.indexOf(fn);
    if (i >= 0) this.items.splice(i, 1);
  }

  flush(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach?.();
    this.detach = null;
    // Dispose in reverse order of registration.
    while (this.items.length) {
      const fn = this.items.pop();
      try {
        fn?.();
      } catch {
        /* swallow - teardown must not throw */
      }
    }
  }
}

/**
 * Incrementally render a long list: the first `chunk` items are created synchronously; the rest
 * materialise when a sentinel row scrolls into view (IntersectionObserver), falling back to a
 * "Show N more" button where IO is unavailable (jsdom / very old engines - also makes the
 * behaviour deterministic in tests). The observer / button listener is tracked on `reg`, so a
 * region re-render or destroy() tears it down.
 */
export function appendChunked(
  reg: Disposables,
  host: HTMLElement,
  total: number,
  make: (i: number) => Node,
  chunk = 60,
): void {
  let next = 0;
  const renderChunk = (): void => {
    const end = Math.min(total, next + chunk);
    const frag = document.createDocumentFragment();
    for (; next < end; next++) frag.append(make(next));
    host.append(frag);
  };
  renderChunk();
  if (next >= total) return;

  if (typeof IntersectionObserver === "function") {
    const sentinel = el("div", { class: "chunk-sentinel", "aria-hidden": "true" });
    host.append(sentinel);
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      renderChunk();
      if (next >= total) {
        io.disconnect();
        sentinel.remove();
      } else {
        host.append(sentinel); // keep the sentinel last
      }
    });
    io.observe(sentinel);
    reg.add(() => io.disconnect());
  } else {
    const more = el("button", { class: "chunk-more", type: "button" });
    const label = (): void => {
      more.textContent = `Show ${Math.min(chunk, total - next)} more (${total - next} remaining)`;
    };
    label();
    host.append(more);
    reg.listen(more, "click", () => {
      more.remove();
      renderChunk();
      if (next < total) {
        label();
        host.append(more);
      }
    });
  }
}

/** A debounce bound to a Disposables registry so its pending timer is cleared on destroy. */
export function makeDebounce(dis: Disposables): (fn: () => void, ms: number) => void {
  let timer: number | null = null;
  const cancel = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  dis.add(cancel);
  return (fn: () => void, ms: number) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}
