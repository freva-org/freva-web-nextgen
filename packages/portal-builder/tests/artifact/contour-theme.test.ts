// The `contour` theme's drawn backdrop. A theme that switches on a runtime must not become a
// precedent, so the assertion that matters is that `default` is untouched and a build on any
// other preset contains no byte of the drawing. The rest is what the theme owns: the tuning
// numbers, in both modes, as custom properties the renderer reads rather than constants it
// carries.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, cleanupFixtures, tempRoot, writeSite } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { THEME_PRESETS, resolveThemeCss, themeNames } from "../../src/themes/registry.js";

afterAll(cleanupFixtures);

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

interface Built {
  out: string;
  files: string[];
  html: string;
  /** Everything the browser would execute or apply, as one string. */
  code: string;
}

async function build(preset: string, prefix: string): Promise<Built> {
  const root = tempRoot(prefix);
  writeSite(root, { theme: preset });
  const out = join(tempRoot(`${prefix}out-`), "site");
  const result = await buildFixture(root, out);
  expect(result.diagnostics.errors).toEqual([]);
  const files = tree(out);
  const code = files
    .filter((f) => f.endsWith(".js") || f.endsWith(".css"))
    .map((f) => readFileSync(join(out, ...f.split("/")), "utf8"))
    .join("\n");
  return { out, files, html: readFileSync(join(out, "index.html"), "utf8"), code };
}

/**
 * Traces only the contour drawing would put in a bundle. Deliberately not function names: the
 * bundler minifies those away, and a test looking for `mountContourBackdrop` passes on a build
 * that shipped the whole renderer under another name. String literals and numeric constants
 * survive minification, so the absence claim rests on these.
 */
const FINGERPRINTS = [
  "portal-contour",
  "--portal-contour-minor",
  // The field's own base pressure, and the hashing constant that gives the anomaly record its
  // interannual jitter.
  "1008",
  "12765.1234",
];

// `43758.5453` is deliberately not on that list: it is the constant from
// `fract(sin(x) * 43758.5453)`, the hash every shader-derived noise routine uses, so it traces
// the idiom rather than this drawing, and a second backdrop using it fails the absence test on a
// build containing no contour code at all. A fingerprint has to be specific to the thing it
// fingerprints; the presence test below is what keeps the rest honest.

describe("the contour preset", () => {
  it("is registered without disturbing the others", () => {
    expect(themeNames()).toEqual(["contour", "cosmos", "default", "freva", "waterpark"]);
    // `default` is the one preset a backdrop may never reach.
    expect(THEME_PRESETS.default!.backdrop).toBeUndefined();
    expect(THEME_PRESETS.freva!.backdrop).toBeUndefined();
    expect(THEME_PRESETS.waterpark!.backdrop).toBeUndefined();
    expect(THEME_PRESETS.contour!.backdrop).toBe("contour");
  });

  it("still contains visual behaviour only", () => {
    const preset = THEME_PRESETS.contour!;
    for (const key of Object.keys(preset.tokens)) {
      expect(key).toMatch(/^(color|density|cornerStyle|headingScale)/);
    }
    const serialized = JSON.stringify(preset).toLowerCase();
    for (const forbidden of ["http://", "https://", "/api/", "logo", "favicon", "analytics"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("publishes every tuning number the brief specifies, in both modes", () => {
    const { css } = resolveThemeCss("contour", undefined);
    // The stylesheet has several `:root` blocks - the closed token set writes its own - so the
    // two that matter are found by what is in them rather than by position.
    const blocks = [...css.matchAll(/(:root[^{]*)\{([^}]*)\}/g)]
      .map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))
      .filter((b) => b.body.includes("--portal-contour-"));
    expect(blocks).toHaveLength(2);
    const light = blocks.find((b) => b.selector === ":root")!.body;
    const dark = blocks.find((b) => b.selector.includes("dark"))!.body;
    const expected: [string, string, string][] = [
      ["minor", "0.08", "0.1"],
      ["major", "0.16", "0.18"],
      ["label", "0.24", "0.28"],
      ["stripes", "0.14", "0.12"],
      ["veil", "0.92", "0.88"],
      ["card", "0.94", "0.92"],
    ];
    for (const [name, lightValue, darkValue] of expected) {
      expect(light).toContain(`--portal-contour-${name}: ${lightValue};`);
      expect(dark).toContain(`--portal-contour-${name}: ${darkValue};`);
    }
  });

  it("fades the veil away from the reading column rather than covering the page", () => {
    const { css } = resolveThemeCss("contour", undefined);
    expect(css).toContain("--portal-contour-veil-far");
    // Strongest where the copy is, weakest at the open side.
    expect(css).toMatch(/linear-gradient\(\s*100deg/);
    const veil = Number.parseFloat(/--portal-contour-veil: ([\d.]+)/.exec(css)![1]!);
    const far = Number.parseFloat(/--portal-contour-veil-far: ([\d.]+)/.exec(css)![1]!);
    expect(veil).toBeGreaterThan(far);
  });
});

describe("a portal built on the contour preset", () => {
  let contour: Built;

  beforeAll(async () => {
    contour = await build("contour", "portal-contour-");
  }, 180_000);

  it("emits the two canvases, behind the landing page and nowhere else", () => {
    expect(contour.html).toContain('class="portal-contour"');
    expect(contour.html).toContain('class="portal-contour-stripes"');
    expect(contour.html).toContain('data-backdrop="contour"');
    // Inert: no label, no tab stop, nothing announced.
    expect(contour.html).toMatch(/<canvas class="portal-contour" aria-hidden="true"/);
  });

  it("carries the runtime and the tuning numbers", () => {
    for (const fingerprint of FINGERPRINTS) {
      expect(contour.code.includes(fingerprint), `contour lost '${fingerprint}'`).toBe(true);
    }
  });

  it("caps the backing store, in the renderer rather than in the theme", () => {
    // Asserted against the source, because the bundler inlines the 2 into a renamed constant.
    // That the cap *works* is a browser question, answered by `contour-visual.mjs`, which
    // measures the backing store.
    const source = readFileSync(
      join(REPO_ROOT, "packages/portal-builder/client/components/contour.ts"),
      "utf8",
    );
    expect(source).toContain("const MAX_DPR = 2;");
    expect(source).toContain("Math.min(window.devicePixelRatio || 1, MAX_DPR)");
    // And it is not a custom property, so a deployment cannot tune it up.
    expect(resolveThemeCss("contour", undefined).css).not.toContain("dpr");
  });
});

describe("a portal built on any other preset", () => {
  // The fingerprints have to be present in the build they fingerprint. Without this the list
  // rots into vacuity: a constant is refactored away, or turns out to be a shared idiom rather
  // than a trace of this renderer, and the absence test keeps passing while proving nothing.
  it("has every fingerprint in its own build", async () => {
    const built = await build("contour", "portal-fingerprint-contour-");
    for (const fingerprint of FINGERPRINTS) {
      expect(built.code.includes(fingerprint), `contour no longer contains '${fingerprint}'`).toBe(
        true,
      );
    }
  }, 120_000);

  it("contains no byte of the contour runtime", async () => {
    // `cosmos` is in this list for the same reason as the others: it is a different backdrop,
    // and one backdrop must not drag the other into a build.
    for (const preset of ["default", "freva", "waterpark", "cosmos"]) {
      const built = await build(preset, `portal-plain-${preset}-`);
      for (const fingerprint of FINGERPRINTS) {
        expect(built.code.includes(fingerprint), `${preset} shipped '${fingerprint}'`).toBe(false);
      }
      expect(built.html).not.toContain("portal-contour");
      // `cosmos` has a backdrop of its own, so the attribute belongs there; what must never
      // appear on any of them is *this* backdrop.
      if (preset === "cosmos") expect(built.html).toContain('data-backdrop="cosmos"');
      else expect(built.html).not.toContain("data-backdrop");
    }
  }, 300_000);

  it("is byte-identical to what it was, preset for preset", async () => {
    // The swap test for the presets that draw nothing: changing between them changes the
    // stylesheet and nothing else.
    const [a, b] = await Promise.all([
      build("default", "portal-swap-a-"),
      build("freva", "portal-swap-b-"),
    ]);
    const strip = (html: string): string => html.replace(/_portal\/[^"]+\.css/g, "STYLESHEET");
    expect(strip(a.html)).toBe(strip(b.html));
  }, 300_000);
});
