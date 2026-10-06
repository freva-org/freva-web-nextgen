// ClimateClaw's side bar: about a third of the window, never narrower than the user left it.
import { describe, expect, it } from "vitest";

import { widerLeft } from "../src/layout.js";

describe("the side bar's width", () => {
  it("widens a narrow side bar to about a third of the window", () => {
    const sizes = widerLeft([0.15, 0.85, 0], 1500)!;
    expect(sizes[0]).toBeCloseTo(480 / 1500);
    expect(sizes[0]! + sizes[1]! + sizes[2]!).toBeCloseTo(1);
  });

  it("keeps a side bar the user made wider, and a small window's notebook room", () => {
    expect(widerLeft([0.5, 0.5, 0], 1500)).toBeNull();
    expect(widerLeft([0.2, 0.6, 0.2], 800)).toBeNull();
  });
});

describe("widening once the page can be measured", () => {
  it("waits for a width (a frame laid out late), widens once, then leaves the user's drag alone", async () => {
    const { widenLeftAreaWhenReady } = await import("../src/layout.js");
    let width = 0;
    let sizes = [0.15, 0.85, 0];
    const set: number[][] = [];
    const shell = {
      _hsplitPanel: {
        node: {
          get clientWidth() {
            return width;
          },
        },
        relativeSizes: () => sizes,
        setRelativeSizes: (next: number[]) => {
          sizes = next;
          set.push(next);
        },
      },
    };
    const observers: Array<() => void> = [];
    const g = globalThis as Record<string, unknown>;
    const saved = [g.ResizeObserver, g.requestAnimationFrame, g.cancelAnimationFrame];
    g.ResizeObserver = class {
      constructor(private readonly callback: () => void) {
        observers.push(() => this.callback());
      }
      observe() {}
      disconnect() {
        observers.length = 0;
      }
    };
    g.requestAnimationFrame = (fn: () => void) => (fn(), 1);
    g.cancelAnimationFrame = () => undefined;
    try {
      widenLeftAreaWhenReady(shell);
      expect(set).toEqual([]);
      width = 1500;
      observers.forEach((notify) => notify());
      expect(set).toHaveLength(1);
      expect(sizes[0]).toBeCloseTo(480 / 1500);
      // The user drags it narrower: nothing changes it back.
      sizes = [0.1, 0.9, 0];
      observers.forEach((notify) => notify());
      expect(set).toHaveLength(1);
    } finally {
      [g.ResizeObserver, g.requestAnimationFrame, g.cancelAnimationFrame] = saved;
    }
  });
});
