// dom.ts - the minimal DOM helpers and disposer registry this package needs.
//
// Deliberately a small first-party copy rather than a dependency: the package ships with zero
// third-party runtime dependencies and must not import the databrowser (which would recreate the
// coupling the extraction exists to remove).
//
// Rule, unchanged from the rest of the monorepo: dynamic text NEVER reaches innerHTML. It goes in
// through textContent. The single exception is svgIcon(), whose markup is always a caller-side
// compile-time constant.

export type Attrs = Record<string, string | number | boolean | null | undefined>;
export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs & { class?: string; text?: string },
  children?: Child[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = String(v);
      else if (k === "text") node.textContent = String(v);
      else node.setAttribute(k, String(v));
    }
  }
  if (children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      node.append(typeof c === "string" ? document.createTextNode(c) : c);
    }
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

/** Build an icon from COMPILE-TIME-CONSTANT markup. Never pass data-derived strings here. */
export function svgIcon(constMarkup: string, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = constMarkup;
  return svg;
}

type Disposer = () => void;

/** The only sanctioned way to attach listeners/timers here; destroy() flushes everything. */
export class Disposables {
  private items: Disposer[] = [];
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }
  get size(): number {
    return this.items.length;
  }

  add(fn: Disposer): Disposer {
    if (this.disposed) {
      fn();
      return () => {};
    }
    this.items.push(fn);
    return () => this.remove(fn);
  }

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
      this.remove(clear);
      fn();
    }, ms);
    const clear = (): void => window.clearTimeout(id);
    this.add(clear);
    return id;
  }

  private remove(fn: Disposer): void {
    const i = this.items.indexOf(fn);
    if (i >= 0) this.items.splice(i, 1);
  }

  flush(): void {
    if (this.disposed) return;
    this.disposed = true;
    while (this.items.length) {
      const fn = this.items.pop();
      try {
        fn?.();
      } catch {
        /* teardown must not throw */
      }
    }
  }
}

/** A debounce bound to a registry, so a pending timer is cleared on destroy. */
export function makeDebounce(dis: Disposables): (fn: () => void, ms: number) => void {
  let timer: number | null = null;
  dis.add(() => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  });
  return (fn: () => void, ms: number) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}
