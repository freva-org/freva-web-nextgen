// What the mounted application is allowed to fetch, and from where. The catalogue application
// draws a map on every document with a footprint, and upstream's basemap table fetches those
// tiles from `openstreetmap.org`, which a self-contained artifact under `default-src 'none'`
// refuses: a blank map and a console full of policy violations on every collection and item
// page, invisible to a suite whose only STAC page is the root, which has no map.
//
// Neither "block it harder" nor "allow it quietly": a deployment lists the origins it accepts
// third-party tile requests from, and that one statement reaches the application through the
// generated adapter and `img-src` through the host policy, so the two cannot disagree. The
// default lists none and makes no third-party request.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot, write, writeSite } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite, STAC_MATERIALS } from "../helpers/site.js";

afterAll(cleanupFixtures);

const OSM = "https://tile.openstreetmap.org";

interface Built {
  policy: Record<string, string>;
  adapter: string;
}

async function build(stacOptions?: string): Promise<Built> {
  const source = writeMatrixSite({
    databrowser: false,
    stac: true,
    auth: false,
    ...(stacOptions ? { stacOptions } : {}),
  });
  const out = join(tempRoot("portal-stac-policy-"), "site");
  const result = await buildFixture(source, out);
  expect(result.diagnostics.errors).toEqual([]);
  const policy = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")) as {
    csp: { portal: Record<string, string> };
  };
  // The adapter is bundled, and the compiler may emit it as a file or inline it into the route
  // document; either way its values are somewhere in the shipped JavaScript.
  const bundles = readdirSync(join(out, "_portal"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(out, "_portal", file), "utf8"));
  return {
    policy: policy.csp.portal,
    adapter: [...bundles, readFileSync(join(out, "catalog", "index.html"), "utf8")].join("\n"),
  };
}

describe.skipIf(!STAC_MATERIALS)("a deployment that asks for no basemap", () => {
  it("permits no third-party origin, and tells the application the same thing", async () => {
    const built = await build();
    // No THIRD party. The catalogue's own service origin is a different claim, granted
    // separately - see "the catalogue's own imagery" below - so this asserts the absence of the
    // tile host rather than of every URL.
    expect(built.policy["img-src"]).not.toMatch(/openstreetmap|usgs/);
    expect(built.policy["default-src"]).toBe("'none'");
    expect(built.policy["connect-src"]).not.toMatch(/openstreetmap/);
    // The application is told the list, not left to its own defaults: an empty list is what makes
    // the patched basemap configuration keep no layer.
    expect(built.adapter).toContain("allowedBasemapOrigins");
    expect(built.adapter).not.toContain("tile.openstreetmap.org");
  }, 180_000);

  it("states each directive value once", async () => {
    const built = await build();
    for (const [directive, value] of Object.entries(built.policy)) {
      const values = value.split(" ").filter(Boolean);
      expect(new Set(values).size, `${directive}: ${value}`).toBe(values.length);
    }
  }, 180_000);

  it("grants no capability the pinned build does not use", async () => {
    const built = await build();
    // The prepared application inlines no font - no font file, no `@font-face` anywhere in the
    // tree - so `font-src data:` is not a STAC requirement. What needs it is the portal's own
    // mathematics stylesheet, whose KaTeX faces are `data:` URLs, so the grant follows that
    // stylesheet being published; this matrix site has no mathematics and gets neither. Recorded
    // against STAC instead, it leaves a portal with mathematics and no catalogue refusing its own
    // fonts. Checked against the tree, because a recorded requirement should be verifiable.
    expect(built.policy["font-src"]).toBe("'self'");
    const materials = STAC_MATERIALS!;
    const manifest = JSON.parse(readFileSync(join(materials, "materials.json"), "utf8")) as {
      files: { path: string }[];
    };
    const fonts = manifest.files.filter((file) => /\.(woff2?|ttf|otf|eot)$/i.test(file.path));
    expect(fonts).toEqual([]);
    const styles = manifest.files
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => readFileSync(join(materials, ...file.path.split("/")), "utf8"));
    expect(styles.some((css) => css.includes("@font-face"))).toBe(false);

    // `blob:` is granted and is used: the map, the GeoTIFF preview and the code box all render
    // through `URL.createObjectURL`.
    expect(built.policy["img-src"]).toContain("blob:");
  }, 180_000);
});

describe.skipIf(!STAC_MATERIALS)("a deployment that asks for one", () => {
  it("carries the origin into the policy and into the application, and nowhere else", async () => {
    const built = await build(`      access:\n        basemapOrigins:\n          - ${OSM}/\n`);
    const values = built.policy["img-src"]!.split(" ").filter(Boolean);
    expect(values).toContain(OSM);
    // Once, as an origin: a trailing path or a second copy would make the policy and the
    // application's own comparison disagree about what was allowed.
    expect(values.filter((value) => value === OSM)).toHaveLength(1);
    expect(built.policy["img-src"]).not.toContain(`${OSM}/`);
    expect(built.adapter).toContain(OSM);

    // Only images. A basemap is tiles, so nothing else widens.
    expect(built.policy["connect-src"]).not.toMatch(/openstreetmap/);
    expect(built.policy["script-src"]).not.toMatch(/openstreetmap/);
    expect(built.policy["style-src"]).not.toMatch(/openstreetmap/);
    expect(built.policy["default-src"]).toBe("'none'");
  }, 180_000);
});

describe.skipIf(!STAC_MATERIALS)("what the prepared tree publishes", () => {
  it("carries no service worker and no host configuration file", () => {
    const materials = STAC_MATERIALS!;
    for (const name of ["sw.js", "mitm.html", ".htaccess", "index.html", "runtime-config.js"]) {
      expect(existsSync(join(materials, name)), name).toBe(false);
    }
  });
});

// KaTeX inlines its font faces as `data:` URLs, so a portal publishing the mathematics stylesheet
// needs `font-src data:` and one without it does not. Sourcing that grant from the STAC
// component's recorded requirements instead leaves a site with mathematics and no catalogue
// refusing its own fonts, unseen by a browser suite whose scanned pages all enable STAC.
describe("the mathematics stylesheet and the font policy", () => {
  async function policyFor(body: string): Promise<Record<string, string>> {
    const root = tempRoot("portal-math-csp-");
    write(root, "content/page.md", `---\ntitle: Page\n---\n\n${body}\n`);
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
`,
    });
    const out = join(tempRoot("portal-math-csp-out-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);
    const policy = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")) as {
      csp: { portal: Record<string, string> };
    };
    return policy.csp.portal;
  }

  it("permits inline font data exactly when it ships a stylesheet that carries some", async () => {
    const withMath = await policyFor("Inline $x^2$ mathematics.");
    expect(withMath["font-src"]).toBe("'self' data:");

    const without = await policyFor("Ordinary prose with no mathematics.");
    expect(without["font-src"]).toBe("'self'");
  }, 180_000);
});

// The catalogue's own imagery. A STAC document carries thumbnails, previews and overviews as
// assets, served by the same API that serves the document, so deriving a service origin into
// `connect-src` alone - how the artifact reaches a service - fetches the catalogue and not one
// image it points at, and every collection tile draws its `alt` text, "Thumbnail".
//
// `access.basemapOrigins` is not the answer: it states which third-party MAP TILE origins are
// accepted, and a deployment listing its own API there misleads a reader of the policy and the
// application, which reads the same list to decide which tile layers to draw.
describe.skipIf(!STAC_MATERIALS)("the catalogue's own imagery", () => {
  it("grants the service origin in `img-src`, not only in `connect-src`", async () => {
    const built = await build();
    const origin = "https://catalog.example.org";
    expect(built.policy["connect-src"]).toContain(origin);
    expect(built.policy["img-src"]).toContain(origin);
  }, 180_000);

  it("is a grant a browser would honour: the origin, no path, no wildcard", async () => {
    const built = await build();
    const values = built.policy["img-src"]!.split(" ").filter(Boolean);
    expect(values).toContain("https://catalog.example.org");
    // Not `https://catalog.example.org/stac/`: a source expression with a path only matches that
    // path prefix, and a thumbnail sits wherever the API puts it.
    expect(values.some((value) => value.startsWith("https://catalog.example.org/"))).toBe(false);
    expect(values).not.toContain("*");
    expect(values).not.toContain("https:");
  }, 180_000);

  it("does not widen every directive, and does not widen it for every service", async () => {
    const built = await build();
    const origin = "https://catalog.example.org";
    // The grant is imagery, because that is what a catalogue points at. Not scripts, not styles,
    // not frames - a service origin appearing in `script-src` would be a different feature.
    expect(built.policy["script-src"]).not.toContain(origin);
    expect(built.policy["style-src"]).not.toContain(origin);
    expect(built.policy["font-src"]).not.toContain(origin);
    expect(built.policy["default-src"]).toBe("'none'");
  }, 180_000);

  it("a databrowser's API origin stays in `connect-src` alone", async () => {
    // The other half of the rule. The Data Browser renders its results as markup and loads no
    // image its API points at, so its origin has no business in a loading directive; granting
    // every service origin everywhere would put it there silently on every deployment.
    const source = writeMatrixSite({ databrowser: true, stac: false, auth: false });
    const out = join(tempRoot("portal-db-policy-"), "site");
    const result = await buildFixture(source, out);
    expect(result.diagnostics.errors).toEqual([]);
    const policy = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")) as {
      csp: { portal: Record<string, string> };
    };
    expect(policy.csp.portal["connect-src"]).toMatch(/https:\/\//);
    expect(policy.csp.portal["img-src"]).not.toMatch(/https?:\/\//);
  }, 180_000);
});
