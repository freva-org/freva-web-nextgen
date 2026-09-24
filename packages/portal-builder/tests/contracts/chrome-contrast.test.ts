// The chrome is the deployment's colour, flat, with white on it. Nothing here derives an ink by
// measurement, compensates a fill against the page, or substitutes a translucent material with a
// darker colour: each of those produces a bar nobody recognises.
//
// The contrast of white on a given accent is *reported* here, not enforced. `#ffffff` on
// `#009688` is 3.67:1, below the 4.5:1 WCAG asks of body text, and that is a decision about the
// deployment's colour rather than something this layer may quietly correct.

import { describe, expect, it } from "vitest";
import { chromeContrast, resolveThemeCss, themeNames } from "../../src/themes/registry.js";

/** The real deployment accent, first, plus the presets' own. */
const ACCENTS = ["#009688", "#006f86", "#17324d", "#4285bd", "#8c1d1d"];

function token(css: string, name: string): string | undefined {
  return new RegExp(`--chrome-${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
}

describe("the restored chrome", () => {
  it("fills both bars with the accent itself, untransformed", () => {
    for (const accent of ACCENTS) {
      const { css } = resolveThemeCss("waterpark", { colorAccent: accent });
      expect(token(css, "bg"), accent).toBe(accent);
      // And the accent stays the accent everywhere else.
      expect(css).toContain(`--accent: ${accent};`);
    }
  });

  it("puts white on them, whatever the accent measures", () => {
    for (const accent of ACCENTS) {
      const { css } = resolveThemeCss("waterpark", { colorAccent: accent });
      expect(token(css, "ink"), accent).toBe("#ffffff");
    }
  });

  it("emits none of the rejected material tokens", () => {
    for (const accent of ACCENTS) {
      const { css } = resolveThemeCss("waterpark", { colorAccent: accent });
      for (const name of [
        "alpha",
        "alpha-scrolled",
        "veil",
        "veil-scrolled",
        "sheen",
        "face-top",
        "cast",
        "pill",
        "blur",
      ]) {
        expect(token(css, name), `${accent} still emits --chrome-${name}`).toBeUndefined();
      }
    }
  });

  it("reports what white measures on the bar without changing it", () => {
    // A report, not a threshold. The number for the real deployment accent is pinned so a
    // change to it shows in a diff and reaches a person rather than an automatic correction.
    expect(chromeContrast("#009688")).toBeCloseTo(3.67, 2);
    expect(chromeContrast("#006f86")).toBeCloseTo(5.8, 2);
    expect(chromeContrast("#17324d")).toBeCloseTo(13.13, 2);
    expect(chromeContrast("not-a-colour")).toBeUndefined();
  });

  it("derives nothing: the same accent in and out, for every preset", () => {
    for (const name of themeNames()) {
      const { css } = resolveThemeCss(name, { colorAccent: "#009688" });
      expect(token(css, "bg"), name).toBe("#009688");
      expect(token(css, "ink"), name).toBe("#ffffff");
    }
  });
});
