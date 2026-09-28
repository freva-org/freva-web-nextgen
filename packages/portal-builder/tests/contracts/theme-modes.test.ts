// Per-mode page palettes: `theme.tokens.light` and `theme.tokens.dark`.
//
// A mode block repaints that mode's page and no other, derives the surfaces from the chosen
// background instead of asking for them, and re-measures every text rule against what it derived.
// A browser drives the same on a built portal in `browser-tests/paper-theme.mjs`; this settles the
// arithmetic, over many backgrounds rather than the one a deployment happens to want today.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";
import { resolveThemeCss } from "../../src/themes/registry.js";
import { contrast, mix } from "../../src/themes/color.js";
import { ADMONITION_COLOURS, DESIGN_PALETTE, type ColorMode } from "../../src/themes/palette.js";
import { CodeStyleSheet } from "../../src/rendering/code.js";
import { PACKAGE_ROOT } from "../../src/util/package.js";

afterAll(cleanupFixtures);

const STYLES = join(PACKAGE_ROOT, "astro", "src", "styles");

/** The last value a block gives `property` - later declarations win - or undefined. */
function valueIn(css: string, mode: ColorMode, property: string): string | undefined {
  const blocks = [...css.matchAll(/(:root(?:\[data-theme="dark"\])?) \{([^}]*)\}/g)]
    .filter(([, selector]) => (mode === "dark") === selector!.includes("dark"))
    .map(([, , body]) => body!);
  const values = blocks.flatMap((body) =>
    [...body.matchAll(new RegExp(`\\s${property}: (#[0-9a-f]{6});`, "g"))].map((m) => m[1]!),
  );
  return values.at(-1);
}

/** The page palette a mode ends up with: the theme's value where it set one, else the design's. */
function effective(css: string, mode: ColorMode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [property, design] of Object.entries(DESIGN_PALETTE[mode])) {
    out[property] = valueIn(css, mode, property) ?? design;
  }
  out["--accent-text"] = valueIn(css, mode, "--accent-text")!;
  return out;
}

describe("a mode block repaints its own mode only", () => {
  it("applies the light --bg and leaves the dark --bg the design's", () => {
    const { css, findings } = resolveThemeCss("cosmos", {
      colorAccent: "#00796b",
      light: { colorBackground: "#ffffff" },
    });
    expect(valueIn(css, "light", "--bg")).toBe("#ffffff");
    // Nothing of the page palette is restated for dark: the design's dark block stands.
    for (const property of Object.keys(DESIGN_PALETTE.dark)) {
      expect(valueIn(css, "dark", property), property).toBeUndefined();
    }
    expect(findings).toEqual([]);
  });

  it("does the same the other way round", () => {
    const { css } = resolveThemeCss("default", { dark: { colorBackground: "#000000" } });
    expect(valueIn(css, "dark", "--bg")).toBe("#000000");
    expect(valueIn(css, "light", "--bg")).toBeUndefined();
  });

  it("without a mode block, the page palette is the design's in both modes", () => {
    const { css, codeBackgrounds } = resolveThemeCss("waterpark", { colorAccent: "#006f86" });
    for (const mode of ["light", "dark"] as const) {
      expect(valueIn(css, mode, "--bg")).toBeUndefined();
      expect(valueIn(css, mode, "--surface")).toBeUndefined();
    }
    expect(codeBackgrounds).toEqual({});
  });

  it("the stylesheet is emitted in an order the cascade honours", () => {
    // The light palette is in the plain `:root` block, which the design's dark block outranks by
    // specificity; the dark palette is under the dark selector.
    const { css } = resolveThemeCss("default", {
      light: { colorBackground: "#ffffff" },
      dark: { colorBackground: "#000000" },
    });
    expect(css).toMatch(/:root \{[^}]*--bg: #ffffff;[^}]*\}/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*--bg: #000000;[^}]*\}/);
  });
});

describe("the derived palette, over many backgrounds", () => {
  const LIGHT = ["#ffffff", "#fafafa", "#f6f5f1", "#fdf6e3", "#eef3f8", "#f0f0f0", "#e4e4e4"];
  const DARK = ["#000000", "#0d1117", "#1e1e1e", "#10161d", "#202124", "#12202e"];
  const ACCENTS = ["#00796b", "#17324d", "#26699a", "#8c2f2f", "#5b4b8a", "#9a4f00"];
  const cases = [
    ...LIGHT.map((bg) => ["light", bg] as const),
    ...DARK.map((bg) => ["dark", bg] as const),
  ].flatMap(([mode, bg]) => ACCENTS.map((accent) => [mode, bg, accent] as const));

  it.each(cases)("%s page %s with accent %s: every rule holds", (mode, bg, accent) => {
    const { css, findings, codeBackgrounds } = resolveThemeCss("default", {
      colorAccent: accent,
      [mode]: { colorBackground: bg },
    });
    const p = effective(css, mode);
    const code = codeBackgrounds[mode]!;
    const adm = [...Object.values(ADMONITION_COLOURS[mode]), accent].map((c) =>
      mix(c, p["--surface"]!, 0.08),
    );
    const page = [p["--bg"]!, p["--surface"]!, p["--surface-2"]!];
    const atLeast = (fg: string, grounds: string[], ratio: number, what: string): void => {
      for (const ground of grounds) {
        expect(contrast(fg, ground), `${what} ${fg} on ${ground}`).toBeGreaterThanOrEqual(ratio);
      }
    };

    expect(p["--bg"]).toBe(bg);
    // Surfaces stand off the page, and chips and rules off the surfaces.
    atLeast(p["--surface"]!, [bg], 1.03, "surface");
    atLeast(p["--chip"]!, [p["--surface"]!], 1.03, "chip");
    atLeast(p["--line"]!, [bg], 1.15, "rule");
    atLeast(p["--line-2"]!, [bg], 1.2, "strong rule");
    // Text.
    atLeast(p["--ink"]!, [...page, p["--chip"]!, code, ...adm], 4.5, "body text");
    atLeast(p["--ink-2"]!, [...page, p["--chip"]!], 4.5, "secondary text");
    atLeast(p["--muted"]!, page, 4.5, "muted text");
    atLeast(p["--accent-text"]!, [...page, ...adm], 4.5, "accent text");
    atLeast(p["--danger"]!, [...page, p["--danger-bg"]!], 4.5, "danger text");
    atLeast(p["--warning"]!, [...page, p["--warning-bg"]!], 4.5, "warning text");
    for (const name of ["comment", "keyword", "string", "number", "name", "punct", "output"]) {
      atLeast(p[`--syn-${name}`]!, [code], 4.5, `syntax ${name}`);
    }
    expect(findings.filter((f) => f.mode === mode)).toEqual([]);
  });

  it("on a white page raised surfaces step towards the text, and stay quieter than a chip", () => {
    const { css } = resolveThemeCss("default", { light: { colorBackground: "#ffffff" } });
    const p = effective(css, "light");
    // A card lighter than white does not exist: it is a step DOWN, and a smaller one than a chip.
    expect(contrast(p["--surface"]!, "#ffffff")).toBeLessThan(contrast(p["--chip"]!, "#ffffff"));
    expect(p["--surface"]).not.toBe("#ffffff");
  });

  it("on the design's own page it reproduces the design's steps", () => {
    const { css } = resolveThemeCss("default", { light: { colorBackground: "#f6f5f1" } });
    const p = effective(css, "light");
    for (const property of ["--surface", "--line", "--line-2", "--chip"]) {
      const design = DESIGN_PALETTE.light[property]!;
      expect(
        Math.abs(contrast(p[property]!, "#f6f5f1") - contrast(design, "#f6f5f1")),
        property,
      ).toBeLessThan(0.02);
    }
  });
});

describe("a surface alone re-measures the text that sits on it", () => {
  const SURFACES = ["#cccccc", "#d8d8d8", "#ffffff", "#e9e4d6"];
  it.each(SURFACES)("light surface %s: secondary, muted and status text still read", (colour) => {
    const { css, findings } = resolveThemeCss("default", { light: { colorSurface: colour } });
    const p = effective(css, "light");
    expect(p["--surface"]).toBe(colour);
    const page = [p["--bg"]!, p["--surface"]!, p["--surface-2"]!];
    for (const [name, grounds] of [
      ["--ink-2", [...page, p["--chip"]!]],
      ["--muted", page],
      ["--danger", page],
      ["--warning", page],
    ] as const) {
      for (const ground of grounds) {
        expect(contrast(p[name]!, ground), `${name} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(findings.filter((f) => f.pointer.endsWith("colorTextMuted"))).toEqual([]);
  });

  it("keeps the design's text where the new surface leaves it readable", () => {
    const { css } = resolveThemeCss("default", { light: { colorSurface: "#ffffff" } });
    for (const property of ["--ink-2", "--muted", "--danger", "--warning"]) {
      expect(valueIn(css, "light", property), property).toBeUndefined();
    }
  });

  it("the reported case: #cccccc no longer leaves muted text at 3.16:1", () => {
    const { css } = resolveThemeCss("default", { light: { colorSurface: "#cccccc" } });
    const muted = effective(css, "light")["--muted"]!;
    expect(contrast(DESIGN_PALETTE.light["--muted"]!, "#cccccc")).toBeLessThan(4.5);
    expect(muted).not.toBe(DESIGN_PALETTE.light["--muted"]);
    expect(contrast(muted, "#cccccc")).toBeGreaterThanOrEqual(4.5);
  });

  it("does the same in dark mode", () => {
    const { css } = resolveThemeCss("default", { dark: { colorSurface: "#2e3a48" } });
    const p = effective(css, "dark");
    for (const name of ["--ink-2", "--muted", "--danger", "--warning"]) {
      expect(contrast(p[name]!, "#2e3a48"), name).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("a colour the consumer set is theirs, and a failing one is reported", () => {
  it("names the token and the pair", () => {
    const { findings } = resolveThemeCss("default", {
      light: {
        colorBackground: "#ffffff",
        colorSurface: "#fefefe",
        colorTextMuted: "#9a9a9a",
        colorText: "#8a8a8a",
      },
    });
    const pointers = findings.map((f) => f.pointer).sort();
    expect(pointers).toEqual([
      "/theme/tokens/light/colorSurface",
      "/theme/tokens/light/colorText",
      "/theme/tokens/light/colorTextMuted",
    ]);
    expect(findings.find((f) => f.pointer.endsWith("colorTextMuted"))!.message).toMatch(
      /#9a9a9a.*4\.5:1/,
    );
  });

  it("keeps the consumer's value rather than moving it", () => {
    const { css } = resolveThemeCss("default", {
      light: { colorBackground: "#ffffff", colorTextMuted: "#9a9a9a", colorSurface: "#f4f4f4" },
    });
    expect(valueIn(css, "light", "--muted")).toBe("#9a9a9a");
    expect(valueIn(css, "light", "--surface")).toBe("#f4f4f4");
  });

  it("reports an accent neither ink reads on, in the mode a block repainted", () => {
    // A mid-tone orange: 4.33:1 under the light ink, 4.02:1 under the dark one. A fill colour is the
    // deployment's to choose, so it is reported, not changed.
    const { findings } = resolveThemeCss("default", {
      colorAccent: "#b35c00",
      light: { colorBackground: "#ffffff" },
    });
    const onFill = findings.filter((f) => f.mode === "light");
    expect(onFill).toHaveLength(1);
    expect(onFill[0]).toMatchObject({ pointer: "/theme/tokens/colorAccent" });
    expect(onFill[0]!.message).toMatch(/buttons and badges need 4\.5:1/);
  });

  it("reports an accent white header text does not read on", () => {
    const { findings } = resolveThemeCss("waterpark", { colorAccent: "#009688" });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ mode: "both", pointer: "/theme/tokens/colorAccent" });
    expect(findings[0]!.message).toMatch(/3\.67:1/);
    // A preset's own accent is the design's decision, not a finding.
    expect(resolveThemeCss("cosmos", undefined).findings).toEqual([]);
  });
});

describe("the build", () => {
  it("accepts mode blocks without FP1212, and reports a failing colour as FP1226", async () => {
    const root = tempRoot();
    writeSite(root, {
      themeTokens: [
        '    colorAccent: "#00796b"',
        "    light:",
        '      colorBackground: "#ffffff"',
        '      colorTextMuted: "#a0a0a0"',
      ].join("\n"),
    });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    expect(codes(result.diagnostics)).not.toContain("FP1212");
    const reported = result.diagnostics.items.filter((d) => d.code === "FP1226");
    expect(reported.map((d) => d.pointer)).toEqual(["/theme/tokens/light/colorTextMuted"]);
    expect(result.model!.theme.css).toMatch(/--bg: #ffffff;/);
  });

  it("refuses a token a mode block does not own", async () => {
    const root = tempRoot();
    writeSite(root, { themeTokens: '    light:\n      colorAccent: "#00796b"' });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors.length).toBeGreaterThan(0);
  });

  it("recolours code against the code background the page will draw", () => {
    // A darker light-mode page gives a darker code background; a colour that read on the
    // design's is moved until it reads on this one, and the design's own is untouched.
    const background = "#b8b8b8";
    const sheet = new CodeStyleSheet("t-", { light: background });
    sheet.classFor("#6a737d");
    const colour = /\.t-[0-9a-f]+\{color:(#[0-9a-f]{6})\}/.exec(sheet.css())![1]!;
    expect(contrast(colour, background)).toBeGreaterThanOrEqual(4.5);
    const plain = new CodeStyleSheet("t-");
    plain.classFor("#6a737d");
    expect(plain.css()).not.toBe(sheet.css());
  });
});

describe("the tables this derives from are the stylesheet's", () => {
  it("DESIGN_PALETTE is freva-tokens.css", () => {
    const css = readFileSync(join(STYLES, "freva-tokens.css"), "utf8");
    const block = (selector: RegExp): string => selector.exec(css)![1]!;
    const light = block(/^:root \{([\s\S]*?)^\}/m);
    const dark = block(/^:root\[data-theme="dark"\] \{([\s\S]*?)^\}/m);
    for (const [mode, body] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const [property, value] of Object.entries(DESIGN_PALETTE[mode])) {
        expect(body, `${mode} ${property}`).toContain(`${property}: ${value};`);
      }
    }
  });

  it("ADMONITION_COLOURS is freva-shell.css", () => {
    const css = readFileSync(join(STYLES, "freva-shell.css"), "utf8");
    const found: Record<ColorMode, Record<string, string>> = { light: {}, dark: {} };
    for (const m of css.matchAll(
      /(:root\[data-theme="dark"\] )?\.portal-admonition\.portal-admonition-([a-z-]+) \{\s*--adm: (#[0-9a-f]{6});/g,
    )) {
      found[m[1] ? "dark" : "light"][m[2]!] = m[3]!;
    }
    expect(found).toEqual(ADMONITION_COLOURS);
  });
});
