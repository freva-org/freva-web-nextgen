// @vitest-environment jsdom
// Framed, focus and scrollIntoView scroll the notebook's own boxes only, never the page.
import { afterEach, describe, expect, it, vi } from "vitest";

import { alignment, containScrolling, scrollDelta, scrollWithin } from "../src/framed-scroll.js";

describe("scrolling inside a framed notebook", () => {
  it("computes how far a box scrolls, as scrollIntoView aligns", () => {
    // A 20px target 150px down in a 100px view.
    expect(scrollDelta(150, 20, 100, "start")).toBe(150);
    expect(scrollDelta(150, 20, 100, "end")).toBe(70);
    expect(scrollDelta(150, 20, 100, "center")).toBe(110);
    expect(scrollDelta(150, 20, 100, "nearest")).toBe(70);
    expect(scrollDelta(-30, 20, 100, "nearest")).toBe(-30);
    expect(scrollDelta(40, 20, 100, "nearest")).toBe(0);
    expect(alignment(false)).toEqual({ block: "end", inline: "nearest" });
    expect(alignment(undefined)).toEqual({ block: "start", inline: "nearest" });
    expect(alignment({ block: "center", behavior: "smooth" })).toEqual({
      block: "center",
      inline: "nearest",
      behavior: "smooth",
    });
  });

  /** A scrolling box (100px tall, content 400px) holding a target 150px down. */
  function scene() {
    const box = document.createElement("div");
    box.style.overflowY = "auto";
    const target = document.createElement("input");
    box.append(target);
    document.body.append(box);
    Object.defineProperties(box, {
      scrollHeight: { value: 400 },
      clientHeight: { value: 100 },
      scrollWidth: { value: 100 },
      clientWidth: { value: 100 },
    });
    box.getBoundingClientRect = () => ({ top: 0, left: 0, height: 100, width: 100 }) as DOMRect;
    target.getBoundingClientRect = () => ({ top: 150, left: 0, height: 20, width: 50 }) as DOMRect;
    box.scrollBy = vi.fn() as never;
    return { box, target };
  }

  let undo: (() => void) | null = null;
  afterEach(() => {
    undo?.();
    undo = null;
    document.body.replaceChildren();
  });

  it("moves the boxes inside the document and stops at its body", () => {
    const { box, target } = scene();
    const page = vi.spyOn(window, "scrollBy");
    scrollWithin(target, false);
    expect(box.scrollBy).toHaveBeenCalledWith({ top: 70, left: 0 });
    expect(page).not.toHaveBeenCalled();
  });

  it("framed, focus never scrolls on its own and scrollIntoView stays inside", () => {
    const { box, target } = scene();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    undo = containScrolling(window as Window & typeof globalThis);
    target.focus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(box.scrollBy).toHaveBeenCalledWith({ top: 70, left: 0 });
    // Asked not to scroll: it does not.
    (box.scrollBy as ReturnType<typeof vi.fn>).mockClear();
    target.focus({ preventScroll: true });
    expect(box.scrollBy).not.toHaveBeenCalled();
    target.scrollIntoView({ block: "center" });
    expect(box.scrollBy).toHaveBeenCalledWith({ top: 110, left: 0 });
    undo();
    undo = null;
    expect(HTMLElement.prototype.focus).toBe(focus);
  });
});
