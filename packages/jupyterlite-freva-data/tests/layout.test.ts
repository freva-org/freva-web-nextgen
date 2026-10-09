import { describe, expect, it } from "vitest";

import { widenLeftArea, widerLeft } from "../src/layout.js";

describe("the side bar the data panel opens in", () => {
  it("is widened to about a third of the window, never narrowed", () => {
    const sizes = widerLeft([0.15, 0.85], 1500)!;
    expect(sizes[0]! * 1500).toBeCloseTo(480);
    expect(sizes[0]! + sizes[1]!).toBeCloseTo(1);
    expect(widerLeft([0.4, 0.6], 1500)).toBeNull();
    expect(widerLeft([0.5, 0.3], 900)).toBeNull();
  });

  it("is resized through the shell's split, when there is one", () => {
    let set: number[] | null = null;
    const shell = {
      _hsplitPanel: {
        node: { clientWidth: 1500 },
        relativeSizes: () => [0.15, 0.85],
        setRelativeSizes: (sizes: number[]) => {
          set = sizes;
        },
      },
    };
    expect(widenLeftArea(shell)).toBe(true);
    expect(set![0]! * 1500).toBeCloseTo(480);
    expect(widenLeftArea({})).toBe(true);
  });
});
