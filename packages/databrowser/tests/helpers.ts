// A jsdom environment + a recording mock fetch. Importing this module
// installs the DOM globals (so it must be imported before the component under test) and
// exposes installFetch() to script the backend per test, recording every request URL so a
// test can assert which endpoints were (and were not) hit.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.test/",
  pretendToBeVisual: true,
});

const w = dom.window as unknown as Window & typeof globalThis;

// Core DOM globals
const g = globalThis as unknown as Record<string, unknown>;
g.window = w;
g.document = w.document;
// Node 22 exposes a getter-only global `navigator`; redefine it (or, failing that, patch clipboard).
try {
  Object.defineProperty(globalThis, "navigator", {
    value: w.navigator,
    configurable: true,
    writable: true,
  });
} catch {
  /* keep the platform navigator; clipboard is patched below on whichever object wins */
}
g.HTMLElement = w.HTMLElement;
g.HTMLButtonElement = w.HTMLButtonElement;
g.HTMLInputElement = w.HTMLInputElement;
g.HTMLTextAreaElement = w.HTMLTextAreaElement;
g.Element = w.Element;
g.Node = w.Node;
g.MutationObserver = w.MutationObserver;
g.SVGElement = w.SVGElement;
g.Event = w.Event;
g.CustomEvent = w.CustomEvent;
g.KeyboardEvent = w.KeyboardEvent;
g.MouseEvent = w.MouseEvent;
g.getComputedStyle = w.getComputedStyle.bind(w);

// jsdom lacks matchMedia - stub a non-matching implementation.
if (typeof w.matchMedia !== "function") {
  w.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof w.matchMedia;
}

// rAF via timers (jsdom's is fine, but make sure it exists on globalThis too)
if (typeof g.requestAnimationFrame !== "function") {
  g.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    Number(setTimeout(() => cb(Date.now()), 0));
  g.cancelAnimationFrame = (id: number): void => clearTimeout(id);
}

// A recording clipboard so the copy path is testable.
export const clipboardWrites: string[] = [];

// jsdom implements neither object URLs nor anchor-click navigation - stub both so the
// streaming-export success path is testable. Every triggered download records
// its download attribute here.
export const downloadClicks: string[] = [];
/** Same clicks, with the href - lets tests assert the BROWSER was handed the streaming job. */
export const downloadHrefs: Array<{ href: string; name: string }> = [];
// Track object-URL lifecycle so the export-teardown test can assert every created URL
// is revoked (whether by the timer or by destroy()).
export const objectUrls: { created: number; revoked: number } = { created: 0, revoked: 0 };
// The component calls the GLOBAL `URL.createObjectURL`; in this Node+jsdom setup that resolves
// to Node's native URL, not jsdom's w.URL - patch whichever the component sees.
const urlObj = ((globalThis as unknown as { URL?: unknown }).URL ?? w.URL) as unknown as Record<
  string,
  unknown
>;
urlObj.createObjectURL = () => {
  objectUrls.created++;
  return `blob:jsdom/${Math.random().toString(36).slice(2)}`;
};
urlObj.revokeObjectURL = () => {
  objectUrls.revoked++;
};
const anchorProto = w.HTMLAnchorElement.prototype as unknown as { click: () => void };
const origAnchorClick = anchorProto.click;
anchorProto.click = function (this: HTMLAnchorElement): void {
  if (this.hasAttribute("download")) {
    downloadClicks.push(this.getAttribute("download") ?? "");
    downloadHrefs.push({
      href: this.getAttribute("href") ?? "",
      name: this.getAttribute("download") ?? "",
    });
    return; // never attempt jsdom navigation for downloads
  }
  origAnchorClick.call(this);
};
const clipboardStub = {
  writeText: (t: string): Promise<void> => {
    clipboardWrites.push(t);
    return Promise.resolve();
  },
};
for (const navObj of new Set<object>(
  [w.navigator, (globalThis as unknown as { navigator?: object }).navigator].filter(
    Boolean,
  ) as object[],
)) {
  try {
    Object.defineProperty(navObj, "clipboard", { configurable: true, value: clipboardStub });
  } catch {
    /* navigator.clipboard may be locked on some platforms; the stub on the other object covers us */
  }
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
  signal: AbortSignal | undefined;
}

export type RouteResult = Response | { status?: number; body?: unknown; delayMs?: number };

export type Router = (call: FetchCall) => RouteResult | Promise<RouteResult>;

export const fetchCalls: FetchCall[] = [];
export const abortedUrls: string[] = [];

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function toResponse(r: RouteResult): Response {
  if (r instanceof Response) return r;
  const status = r.status ?? 200;
  const body = r.body === undefined ? {} : r.body;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload, { status, headers: { "content-type": "application/json" } });
}

/** Install a router as the global fetch; returns a reset() to clear recordings. */
export function installFetch(router: Router): () => void {
  fetchCalls.length = 0;
  abortedUrls.length = 0;
  clipboardWrites.length = 0;
  downloadClicks.length = 0;
  downloadHrefs.length = 0;
  objectUrls.created = 0;
  try {
    w.history.replaceState(null, "", "/");
  } catch {
    /* jsdom without history - deep-link sync is a no-op then */
  }
  objectUrls.revoked = 0;

  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const signal = init?.signal ?? undefined;
    fetchCalls.push({ url, init, signal });

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        abortedUrls.push(url);
        reject(abortError());
        return;
      }
      Promise.resolve(router({ url, init, signal: signal ?? undefined })).then((routed) => {
        const delay = routed instanceof Response ? 0 : (routed.delayMs ?? 0);
        const finish = (): void => resolve(toResponse(routed));
        if (delay <= 0) {
          finish();
          return;
        }
        const t = setTimeout(finish, delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          abortedUrls.push(url);
          reject(abortError());
        });
      }, reject);
    });
  };

  try {
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: impl });
  } catch {
    (g as Record<string, unknown>).fetch = impl;
  }
  w.fetch = impl as typeof w.fetch;

  return () => {
    fetchCalls.length = 0;
    abortedUrls.length = 0;
    clipboardWrites.length = 0;
  };
}

/** A standard search response. Pass facets as { key: [value, count, …] }. */
export function searchResponse(opts: {
  total: number;
  rows?: Array<{
    file: string;
    fs_type?: string;
    project?: string[];
    experiment?: string[];
    format?: string;
  }>;
  facets?: Record<string, Array<string | number>>;
  primary?: string[];
  mapping?: Record<string, string>;
}): Record<string, unknown> {
  return {
    total_count: opts.total,
    facets: opts.facets ?? {},
    primary_facets: opts.primary ?? Object.keys(opts.facets ?? {}),
    facet_mapping: opts.mapping ?? {},
    // spread preserves any per-row fields (project/experiment/format) the backend returns when
    // the search requests them via &fields=; fs_type defaults to posix when not given.
    search_results: (opts.rows ?? []).map((r) => ({ fs_type: "posix", ...r })),
  };
}

export function overviewResponse(
  flavours: string[],
  attributes: Record<string, string[]>,
): Record<string, unknown> {
  return { flavours, attributes };
}

/** Wait n milliseconds (real timers). */
export function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Flush microtasks + a macrotask turn. */
export function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export function makeHost(): HTMLElement {
  const host = w.document.createElement("div");
  w.document.body.appendChild(host);
  return host;
}

export { w as window };

/**
 * Apply a facet filter through the value-first main search bar:
 * type a VALUE, open the dropdown, and Enter-select the top match. The `key=value` power
 * syntax lives in the terminal only, so it has no equivalent here.
 */
export function pickValue(root: ParentNode, value: string): void {
  const input = root.querySelector(".search input") as HTMLInputElement;
  const wv = input.ownerDocument.defaultView as unknown as {
    Event: typeof Event;
    KeyboardEvent: typeof KeyboardEvent;
  };
  input.focus?.();
  input.value = value;
  input.dispatchEvent(new wv.Event("input", { bubbles: true }));
  input.dispatchEvent(new wv.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}
