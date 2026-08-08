// A jsdom environment for the package's own tests. Importing this installs the DOM globals, so it
// must come before the module under test.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.test/",
  pretendToBeVisual: true,
});

const w = dom.window as unknown as Window & typeof globalThis;
const g = globalThis as unknown as Record<string, unknown>;
g.window = w;
g.document = w.document;
g.HTMLElement = w.HTMLElement;
g.HTMLButtonElement = w.HTMLButtonElement;
g.HTMLInputElement = w.HTMLInputElement;
g.HTMLTextAreaElement = w.HTMLTextAreaElement;
g.Element = w.Element;
g.Node = w.Node;
g.Event = w.Event;
g.KeyboardEvent = w.KeyboardEvent;
g.MouseEvent = w.MouseEvent;
g.getComputedStyle = w.getComputedStyle.bind(w);

try {
  Object.defineProperty(globalThis, "navigator", {
    value: w.navigator,
    configurable: true,
    writable: true,
  });
} catch {
  /* keep the platform navigator */
}

export const clipboardWrites: string[] = [];
for (const navObj of new Set<object>(
  [w.navigator, (globalThis as unknown as { navigator?: object }).navigator].filter(
    Boolean,
  ) as object[],
)) {
  try {
    Object.defineProperty(navObj, "clipboard", {
      configurable: true,
      value: {
        writeText: (t: string): Promise<void> => {
          clipboardWrites.push(t);
          return Promise.resolve();
        },
      },
    });
  } catch {
    /* locked on some platforms; the other object carries the stub */
  }
}

export function makeHost(): HTMLElement {
  const host = w.document.createElement("div");
  w.document.body.appendChild(host);
  return host;
}

export function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
export function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A DOMRect literal, for stubbing layout that jsdom does not perform. */
export function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Install per-element rects; returns a restore function. */
export function stubLayout(boxes: Map<Element, DOMRect>, fallback = rect(0, 0, 0, 0)): () => void {
  const proto = w.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    return boxes.get(this) ?? fallback;
  };
  return () => {
    proto.getBoundingClientRect = original;
  };
}

export { w as window };
