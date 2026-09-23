// Theme presets. The load-bearing assertion is the swap test: changing the preset changes the
// stylesheet and *nothing else*. A theme that could reach any other field would leak "which
// project is this" into a visual choice.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, resolveFixture, tempRoot, write, writeSite } from "../helpers/fixture.js";
import { resolveThemeCss, THEME_PRESETS, themeNames } from "../../src/themes/registry.js";
import { canonicalizeRoot } from "../../src/config/paths.js";
import { buildSite } from "../../src/artifact/index.js";

afterAll(cleanupFixtures);

const FORBIDDEN_IN_A_THEME = [
  "example",
  "waterpark portal",
  "logo",
  "favicon",
  "http://",
  "https://",
  "/api/",
  "analytics",
];

describe("the theme registry", () => {
  it("registers presets that contain visual behaviour only", () => {
    expect(themeNames()).toEqual(["contour", "cosmos", "default", "freva", "waterpark"]);
    for (const preset of Object.values(THEME_PRESETS)) {
      const serialized = JSON.stringify(preset).toLowerCase();
      for (const forbidden of FORBIDDEN_IN_A_THEME) {
        expect(serialized).not.toContain(forbidden);
      }
      // Only token names, never a route, endpoint or component switch.
      for (const key of Object.keys(preset.tokens)) {
        expect(key).toMatch(/^(color|density|cornerStyle|headingScale)/);
      }
    }
  });

  it("applies consumer token overrides on top of the preset", () => {
    const { tokens, css } = resolveThemeCss("waterpark", { colorAccent: "#123456" });
    expect(tokens.colorAccent).toBe("#123456");
    expect(css).toContain("--portal-color-accent: #123456;");
    expect(css).toContain("--portal-space:");
  });

  it("refuses arbitrary CSS by having nowhere to put it", async () => {
    const root = tempRoot();
    writeSite(root);
    write(
      root,
      "portal.yaml",
      readFileSync(join(root, "portal.yaml"), "utf8").replace(
        "theme:\n  preset: default\n",
        'theme:\n  preset: default\n  css: "body{display:none}"\n',
      ),
    );
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors.map((d) => d.code)).toContain("FP1104");
  });
});

describe("swapping a preset", () => {
  // `contour` and `cosmos` are deliberately absent: they ask for a drawn backdrop as well as a
  // stylesheet, so the swap test would assert a property they do not have, and weakening it to
  // accommodate them would remove the guarantee for the presets that do. Each has its own suite
  // proving the narrower thing - that no *other* preset gains a byte of it.
  it("changes styling and nothing else", async () => {
    const built: Record<string, { html: string; manifest: string }> = {};
    for (const preset of ["freva", "waterpark"]) {
      const root = tempRoot();
      write(root, "content/guide.md", "---\ntitle: Guide\n---\n\nBody.\n");
      writeSite(root, {
        theme: preset,
        extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
services:
  dataApi:
    kind: databrowser
    baseUrl: https://data.example.org/api
components:
  data:
    kind: databrowser
    enabled: true
    service: dataApi
    route: /data/
`,
      });
      const out = join(tempRoot("portal-theme-out-"), "site");
      const result = await buildSite({
        sourceRoot: canonicalizeRoot(root),
        configPath: join(root, "portal.yaml"),
        outDir: out,
        quiet: true,
        sourceDateEpoch: 1_760_000_000,
      });
      expect(result.diagnostics.errors).toEqual([]);
      const manifest = JSON.parse(readFileSync(join(out, "portal-manifest.json"), "utf8")) as {
        site: { theme: string };
        routes: unknown;
        components: unknown;
        services: unknown;
      };
      built[preset] = {
        // The stylesheet link differs by hash; the rest of the document must not.
        html: readFileSync(join(out, "index.html"), "utf8").replace(
          /_portal\/[^"]+\.css/g,
          "_portal/STYLESHEET",
        ),
        manifest: JSON.stringify({
          routes: manifest.routes,
          components: manifest.components,
          services: manifest.services,
        }),
      };
      expect(manifest.site.theme).toBe(preset);
    }
    expect(built.waterpark!.html).toBe(built.freva!.html);
    expect(built.waterpark!.manifest).toBe(built.freva!.manifest);
  }, 180_000);
});
