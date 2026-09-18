// tests/helpers.ts - a jsdom environment and the small fakes the suite needs.
//
// Imported first by every test that touches the DOM, because it installs the globals the component
// closes over at module scope. There is no network fake here at all: the core and the snapshot
// adapter have no network path to fake, and the S3 tests inject their own `fetch` rather than
// patching a global - which is also how a consumer is expected to use them.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://portal.test/",
  pretendToBeVisual: true,
});

const w = dom.window as unknown as Window & typeof globalThis;
const g = globalThis as unknown as Record<string, unknown>;

g.window = w;
g.document = w.document;
g.HTMLElement = w.HTMLElement;
g.HTMLButtonElement = w.HTMLButtonElement;
g.HTMLInputElement = w.HTMLInputElement;
g.Element = w.Element;
g.Node = w.Node;
g.Event = w.Event;
g.CustomEvent = w.CustomEvent;
g.KeyboardEvent = w.KeyboardEvent;
g.MouseEvent = w.MouseEvent;
g.DOMParser = w.DOMParser;
g.getComputedStyle = w.getComputedStyle.bind(w);

// Node 22 exposes a getter-only `navigator`; replace it so the clipboard fake below is reachable.
try {
  Object.defineProperty(globalThis, "navigator", {
    value: w.navigator,
    configurable: true,
    writable: true,
  });
} catch {
  // keep the platform navigator - the clipboard is installed on whichever object wins
}

/** Every successful clipboard write, in order. */
export const clipboardWrites: string[] = [];
/** Set to make the next writes reject, so the failure path is testable. */
export let clipboardBroken = false;
export function breakClipboard(broken: boolean): void {
  clipboardBroken = broken;
}

const workingClipboard = {
  writeText(text: string): Promise<void> {
    if (clipboardBroken) return Promise.reject(new Error("denied"));
    clipboardWrites.push(text);
    return Promise.resolve();
  },
};

/** Remove the clipboard entirely, for the "no clipboard API at all" case. */
export function removeClipboard(): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
}

/** Put it back, so one test's missing API is not every later test's missing API. */
export function restoreClipboard(): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: workingClipboard,
  });
}

/** Let queued microtasks and zero-delay timers run. */
export async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Wait until `predicate` holds, or fail loudly rather than hanging the suite. */
export async function until(
  predicate: () => boolean,
  what = "condition",
  limit = 200,
): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A detached host element, plus a helper to throw it away. */
export function makeHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

restoreClipboard();

export function resetDom(): void {
  document.body.replaceChildren();
  clipboardWrites.length = 0;
  clipboardBroken = false;
}

export function q<T extends Element = Element>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

export function qa<T extends Element = Element>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** The visible label of every rendered row, in document order. */
export function rowNames(root: ParentNode): string[] {
  return qa(root, ".dataset-tree__name").map((n) => n.textContent ?? "");
}

/** Click through the delegated handler the component actually installs. */
export function click(element: Element | null): void {
  if (!element) throw new Error("click: no element");
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

/** Type into the filter field and fire the event the component listens for. */
export function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

/** A promise plus its resolvers, for driving a source by hand. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
