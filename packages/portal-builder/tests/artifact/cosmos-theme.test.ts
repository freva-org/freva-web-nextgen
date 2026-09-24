// The `cosmos` theme's drawn backdrop, which is STILL. Three kinds of question:
//
// CONTAINMENT: no other preset may contain a byte of the scene, a Cosmos documentation page may
// not fetch it, and the files it ships must be exactly the ones the package holds.
//
// READABILITY: every number is a custom property in both modes, and the scene's own opacity is 1 -
// readability is bought per surface rather than by dimming the picture, so a well-meaning tweak to
// that one value would quietly undo it.
//
// STILLNESS: no animation of any kind - no generated keyframes, no `.anim` class, no Web
// Animations, no frame loop, no timer, no scroll handler, no IntersectionObserver, no visibility
// switch. The assertions require ZERO animation objects rather than paused ones, because "paused"
// is a state something can come back from. Satellites, wind barbs, comets, clouds, aircraft, the
// sonde train, the vessel and the buoy are absent from the source AND from the artifact.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, cleanupFixtures, tempRoot, writeSite } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { THEME_PRESETS, resolveThemeCss, themeNames } from "../../src/themes/registry.js";

afterAll(cleanupFixtures);

const PKG = join(REPO_ROOT, "packages", "portal-builder");
const SCENE_DIR = join(PKG, "client", "components", "cosmos", "scene");
const SCENE = join(PKG, "client", "components", "cosmos", "scene.js");

/**
 * The renderer's EXECUTABLE text, with comments removed. Every assertion about what the scene does
 * not do - no frame loop, no timer, no remote host - is about code, and the scene's own comments
 * name those same prohibitions when explaining why they hold.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");
}

function sceneCode(): string {
  return stripComments(readFileSync(SCENE, "utf8"));
}

/** The island's executable text, on the same terms and for the same reason. */
function islandCode(): string {
  return stripComments(readFileSync(join(PKG, "client", "components", "cosmos.ts"), "utf8"));
}

/** The files the renderer actually asks for, read from the renderer itself. */
function sceneAssets(): string[] {
  const scene = sceneCode();
  return [...scene.matchAll(/assetUrl\("([^"]+)"\)/g)].map((m) => m[1] as string).sort();
}

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

async function build(preset: string, prefix: string, extra?: string): Promise<Built> {
  const root = tempRoot(prefix);
  writeSite(root, { theme: preset, ...(extra ? { extra } : {}) });
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
 * Traces only the Cosmos scene would put in a bundle. Deliberately not function names: the bundler
 * minifies those away, so a test looking for `mountCosmosBackdrop` passes on a build that shipped
 * the whole scene under mangled names. String literals and file names survive minification.
 */
const FINGERPRINTS = [
  "portal-cosmos",
  "--portal-cosmos-card-alpha",
  "--portal-cosmos-hero-scrim",
  // The disclaimer the renderer draws on the canvas.
  "SYNTHETIC CROSS-SECTION",
  // The sky art, the only file set the scene loads: no object body is drawn.
  "sky/sky-sphere.webp",
  // A label the scene draws on its one retained object. Strings, not numbers: the bundler folds
  // the physics constants (`8.24493e-1` does not survive as written), and a fingerprint absent
  // from the output proves nothing about output that lacks it.
  "ICE STATION",
  "ILLUSTRATIVE, NOT AN ANALYSIS",
];

const OTHER_PRESETS = ["default", "freva", "waterpark", "contour"];

describe("the cosmos preset", () => {
  it("is registered, declares its backdrop, and leaves the other presets alone", () => {
    expect(themeNames()).toEqual(["contour", "cosmos", "default", "freva", "waterpark"]);
    expect(THEME_PRESETS.cosmos?.backdrop).toBe("cosmos");
    for (const name of ["default", "freva", "waterpark"]) {
      expect(THEME_PRESETS[name]?.backdrop).toBeUndefined();
    }
    expect(THEME_PRESETS.contour?.backdrop).toBe("contour");
  });

  it("is accepted by the closed schema", () => {
    const schema = JSON.parse(
      readFileSync(join(PKG, "schema", "portal.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const text = JSON.stringify(schema);
    expect(text).toContain('"cosmos"');
    // Still closed: the enum gained a value, it did not become an open string.
    expect(text).toContain('["contour","cosmos","default","freva","waterpark"]');
  });

  it("resolves to a stylesheet that carries its backdrop", () => {
    const resolved = resolveThemeCss("cosmos", undefined);
    expect(resolved.backdrop).toBe("cosmos");
    expect(resolved.css).toContain(".portal-cosmos");
  });

  // The composition rule: scene opacity is 1 in both modes and readability is bought per surface.
  // Turning the opacity down costs the scene its contours, ranges and labels long before the body
  // copy gets comfortable.
  it("draws the scene at full strength and buys readability per surface", () => {
    const { css } = resolveThemeCss("cosmos", undefined);
    const opacities = [...css.matchAll(/--portal-cosmos-scene-opacity:\s*([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(opacities.length).toBeGreaterThanOrEqual(2);
    for (const value of opacities) expect(value).toBe(1);

    // No global dimming or blurring of the canvas, in any form.
    expect(css).not.toMatch(/\.portal-cosmos\s*\{[^}]*filter:\s*blur/);
    expect(css).not.toMatch(/\.portal-cosmos\s*\{[^}]*opacity:\s*0\./);

    // Local surfaces instead, one per kind of content. The hero is not among them: it carries a
    // letterform outline rather than a surface, which the test below asserts.
    for (const property of ["--portal-cosmos-card-alpha", "--portal-cosmos-prose-alpha"]) {
      // Present in both modes.
      expect([...css.matchAll(new RegExp(`${property}:`, "g"))].length).toBeGreaterThanOrEqual(2);
    }
    // The landing container itself is never a surface.
    expect(css).toMatch(/\.portal-landing\s*\{\s*background:\s*transparent/);
  });

  // The hero carries no surface: a veil behind the copy reads as a grey slab hanging in the sky
  // beside two crisp panels. The copy is light type with a letterform-bound outline instead, and
  // the outline is what carries the contrast - at least eight one-pixel offsets, near-opaque.
  // `browser-tests/cosmos-layout.mjs` checks the computed result, and `hero-contrast` measures it
  // against the brightest thing the renderer draws.
  it("gives the hero copy an outline instead of a veil", () => {
    const { css } = resolveThemeCss("cosmos", undefined);
    expect(css).not.toContain("--portal-cosmos-hero-veil");
    const hero = css.slice(css.indexOf(".portal-hero-heading"));
    const rule = hero.slice(0, hero.indexOf("}"));
    expect(rule).toContain("color: #f3f7fb");
    const offsets = rule.match(/-?1px -?1px 0 |-?1px 0 0 |0 -?1px 0 /g) ?? [];
    expect(offsets.length).toBeGreaterThanOrEqual(8);
    expect(rule).toMatch(/rgba\(6, 16, 28, 0\.9\d\)/);
  });

  it("opens on a sky the colour of the scene, so a scriptless page is still readable", () => {
    const { css } = resolveThemeCss("cosmos", undefined);
    // Both themes open dark at the top, following the renderer's own bands. A pale-blue light
    // fallback flashes on every load while the renderer paints space, and leaves the light hero
    // type unreadable for a reader with no JavaScript.
    const light = css.slice(
      css.indexOf(':root[data-theme="light"] .portal-shell[data-backdrop="cosmos"]'),
    );
    const rule = light.slice(0, light.indexOf("}"));
    expect(rule).toMatch(/#0d1b2c 0%/);
  });

  it("raises surface opacity for reduced transparency, and never touches the scene", () => {
    const { css } = resolveThemeCss("cosmos", undefined);
    const block = css.slice(css.indexOf("prefers-reduced-transparency"));
    expect(block).toContain("--portal-cosmos-card-alpha: 1");
    expect(block).toContain("--portal-cosmos-prose-alpha: 1");
    // The hero has no translucent surface left to make opaque, so it gets a solid outline instead.
    expect(block).toContain("rgb(6, 16, 28)");
    expect(block.slice(0, block.indexOf("}\n}"))).not.toContain("--portal-cosmos-scene-opacity");
  });

  it("gives the story enough vertical track to reach the ocean floor", () => {
    const { css } = resolveThemeCss("cosmos", undefined);
    for (const property of [
      "--portal-cosmos-story-lead",
      "--portal-cosmos-story-gap",
      "--portal-cosmos-story-tail",
    ]) {
      expect(css).toContain(property);
    }
    // The gap is a clamp, not a bare `vh` length: measuring it in viewport heights makes the
    // amount of empty page a function of how tall the browser is rather than of what the page
    // holds. Asserted on the desktop declarations, where the decisions are made - a phone override
    // carrying a bare `40vh` gap would otherwise satisfy a looser check.
    expect(css).toMatch(/--portal-cosmos-story-gap:\s*clamp\(/);
    // The LEAD is bounded, which is the difference between a lead-in and an empty screen: at
    // `16vh` a 900px viewport spends 144px before the hero, pushing the heading and its calls to
    // action down the page for no gain, since the orbit stage is above the fold either way. A
    // clamp keeps it proportional on a tall display and stops it growing without limit.
    expect(css).toMatch(/--portal-cosmos-story-lead:\s*clamp\(\s*\d+px,\s*\d+vh,\s*\d+px\s*\)/);
    // The story's floor is about scrolling, not aspect: the page must be scrollable far enough to
    // walk the story, or the reader is parked at the top and orbit is the only stage they ever
    // see. 200vh is the two viewports the engine clamps its own story to, so the two agree.
    //
    // A floor of 3.45 screens - one tall enough to read per band - costs the page instead:
    // measured on the short landing at 1440x900 the run below the last block came to 1972px, 2.19
    // screens, three times the whole ocean band, all of it scrolled after the content ends. A
    // landing shorter than 3.45 screens is the ordinary case. The allocator in `scene.js` already
    // handles being given less than every band wants: it scales the three together rather than
    // starving one, so the transect keeps its full span at a smaller aspect.
    //
    // Comments stripped: the note above names a value that must not be declared, and a note is
    // not a rule.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).toContain("--portal-cosmos-story-min: 200vh");
    expect(declarations).toContain("min-height: var(--portal-cosmos-story-min)");
    expect(declarations).not.toContain("345vh");
    // The tail is spacing, and spacing is not measured in viewport heights: a `vh` tail sets the
    // empty page after the last block by how tall the browser happens to be. About a third of the
    // ocean band, which is what "the story ends on water rather than on a block" needs.
    expect(css).toMatch(/--portal-cosmos-story-tail:\s*clamp\(\s*\d+px,\s*\d+vh,\s*\d+px\s*\)/);
    expect(css).not.toMatch(/--portal-cosmos-story-tail:\s*\d+vh/);
  });
});

describe("a cosmos build", () => {
  it("emits the canvas and the sky art, and no object body at all", async () => {
    const built = await build("cosmos", "portal-cosmos-");

    expect(built.html).toContain('data-backdrop="cosmos"');
    expect(built.html).toContain('class="portal-cosmos"');
    expect(built.html).toMatch(/class="portal-cosmos"[^>]*aria-hidden="true"/);
    expect(built.html).not.toContain("data-portal-cosmos-utility");

    const emitted = built.files.filter((f) => f.startsWith("_cosmos/"));
    const names = emitted.map((f) => f.split("/").slice(2).join("/")).sort();
    expect(names).toEqual([
      "sky/MANIFEST.json",
      "sky/moon.webp",
      "sky/sky-sphere.webp",
      "sky/sun.webp",
    ]);

    // No object body, in the artifact or in the package. A file nothing can ask for is an artifact
    // whose contents do not describe its behaviour, so these are deleted rather than
    // published-and-unused.
    for (const gone of [
      "sat-imager.webp",
      "sat-scatterometer.webp",
      "sat-gnssro.webp",
      "sat-altimeter.webp",
      "research-aircraft.webp",
      "research-vessel.webp",
      "regional-aircraft.webp",
      "airliner.webp",
      "sonde-balloon.webp",
      "sonde-payload.webp",
      "sonde-parachute.webp",
      "sonde-parachute-stowed.webp",
      "surface-buoy.webp",
    ]) {
      expect(built.files.some((f) => f.endsWith(gone))).toBe(false);
      expect(existsSync(join(SCENE_DIR, gone))).toBe(false);
    }

    // One content-addressed directory, named in the HTML.
    const dirs = new Set(emitted.map((f) => f.split("/")[1]));
    expect(dirs.size).toBe(1);
    expect([...dirs][0]).toMatch(/^[0-9a-f]{8}$/);
    expect(built.html).toContain(`_cosmos/${[...dirs][0]}/`);
  });

  it("emits the art byte-for-byte as supplied", async () => {
    const built = await build("cosmos", "portal-cosmos-bytes-");
    const emitted = built.files.filter((f) => f.startsWith("_cosmos/"));
    expect(emitted.length).toBeGreaterThan(0);
    for (const file of emitted) {
      // Copied, not processed: art the build re-encoded would not be the art that was reviewed.
      const rel = file.split("/").slice(2);
      const shipped = readFileSync(join(built.out, ...file.split("/")));
      const source = readFileSync(join(SCENE_DIR, ...rel));
      expect(shipped.equals(source)).toBe(true);
    }
  });

  it("records every published file in the input manifest, with a digest", async () => {
    const built = await build("cosmos", "portal-cosmos-manifest-");
    const manifest = JSON.parse(readFileSync(join(built.out, "input-manifest.json"), "utf8")) as {
      sources: { ref: { path: string }; digest: string; bytes: number }[];
    };
    const rows = manifest.sources.filter((row) => row.ref.path.includes("cosmos/scene/"));
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(row.bytes).toBeGreaterThan(0);
    }
  });

  // The chunk must be a chunk, and there must be ONE of it. A statically imported kernel would
  // sit in the entry bundle and download on every route of a Cosmos portal, documentation
  // included; the island is small and eager, the scene large and deferred behind finding a canvas.
  // A second scene chunk means an animated renderer, selected by a switch such as `?cosmos=proto`,
  // has entered the artifact.
  it("defers the scene into exactly one chunk", async () => {
    const built = await build("cosmos", "portal-cosmos-chunk-");
    const js = built.files.filter((f) => f.endsWith(".js"));
    const withScene = js.filter((f) =>
      readFileSync(join(built.out, ...f.split("/")), "utf8").includes("sky/sky-sphere.webp"),
    );
    expect(withScene.length).toBe(1);
    expect(withScene[0]).toMatch(/scene/);
    expect(built.files.some((f) => /candidate/.test(f))).toBe(false);

    // And the entry, whichever it is, must not be that file.
    const entries = js.filter((f) =>
      readFileSync(join(built.out, ...f.split("/")), "utf8").includes("initShell"),
    );
    for (const entry of entries) expect(withScene).not.toContain(entry);
  });

  it("runs the scene on the landing only", async () => {
    const built = await build("cosmos", "portal-cosmos-landing-");
    const pages = built.files.filter((f) => f.endsWith(".html") && f !== "index.html");
    expect(pages.length).toBeGreaterThan(0);
    expect(built.html).toContain('class="portal-cosmos"');
    for (const page of pages) {
      const html = readFileSync(join(built.out, ...page.split("/")), "utf8");
      expect(html).not.toContain('class="portal-cosmos"');
    }
  });

  it("declares the backdrop on the landing, so the theme has something to hang off", async () => {
    const built = await build("cosmos", "portal-cosmos-backdrop-");
    expect(built.html).toMatch(/data-backdrop="cosmos"/);
    expect(built.html).toMatch(/class="portal-landing/);
  });
});

describe("containment", () => {
  it("puts no byte of the scene in any other preset", async () => {
    for (const preset of OTHER_PRESETS) {
      const built = await build(preset, `portal-${preset}-`);
      for (const print of FINGERPRINTS) expect(built.code).not.toContain(print);
      expect(built.files.some((f) => f.startsWith("_cosmos/"))).toBe(false);
    }
  }, 240_000);

  it("imports the cosmos island literally, and only for a cosmos backdrop", () => {
    const projection = readFileSync(join(PKG, "src", "artifact", "runtime-projection.ts"), "utf8");
    expect(projection).toContain('CLIENT("components/cosmos.ts")');
    // Emitted only when the resolved backdrop is cosmos; every other preset gets no import at all.
    expect(projection).toContain('projection.backdrop?.kind === "cosmos"');
  });
});

// STILLNESS. Each of these asserts the absence of a MECHANISM, not the absence of movement in a
// screenshot: a scene with a paused animation looks identical to one with no animation and is a
// completely different thing to own.

describe("the scene never moves", () => {
  it("generates no keyframes and installs no animation", () => {
    const scene = sceneCode();
    for (const token of [
      "@keyframes",
      "animationName",
      "animationDuration",
      "animationDelay",
      "animationTimingFunction",
      "animation-play-state",
      ".animate(",
      "getAnimations",
      "requestAnimationFrame",
      "setInterval",
    ]) {
      expect(scene).not.toContain(token);
    }
    // The two helpers an animating renderer builds its keyframes and animations with.
    expect(scene).not.toMatch(/\bfunction kf\(/);
    expect(scene).not.toMatch(/\bfunction anim\(/);
    // And nothing tags an element as animated.
    expect(scene).not.toMatch(/classList\.add\("anim"\)/);
    expect(scene).not.toMatch(/"[^"]*\banim\b[^"]*"/);
  });

  it("has no stage gating left, in the renderer or in the stylesheet", () => {
    const scene = sceneCode();
    for (const token of ["data-z", "dataset.z", "dataset.live", "ZONES"]) {
      expect(scene).not.toContain(token);
    }
    const { css } = resolveThemeCss("cosmos", undefined);
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const token of [
      "data-live",
      'data-z="',
      "data-motion",
      ".anim",
      ".zone",
      "animation-play-state",
      "animation-timing-function",
      "animation-iteration-count",
    ]) {
      expect(rules).not.toContain(token);
    }
  });

  it("needs no reduced-motion rule, because there is no motion to reduce", () => {
    const { css } = resolveThemeCss("cosmos", undefined);
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toContain("prefers-reduced-motion");
  });

  it("watches nothing: no observer, no visibility switch, no timer but the settle ones", () => {
    const island = islandCode();
    for (const token of [
      "IntersectionObserver",
      "visibilitychange",
      "data-motion",
      "dataset.motion",
      "dataset.live",
      "prefers-reduced-motion",
      "matchMedia",
      'addEventListener("scroll"',
    ]) {
      expect(island).not.toContain(token);
    }
    // What is kept, none of it a subscription to idle work: a MutationObserver on `data-theme`,
    // which fires when a reader flips one switch; `resize` and `orientationchange`, debounced,
    // which rebuild for a change of SHAPE; and `document.fonts.ready`, which settles once.
    expect(island).toContain("MutationObserver");
    expect(island).toContain('addEventListener("resize"');
    expect(island).toContain("fonts");
  });

  it("offers no URL that can bring an animated renderer back", () => {
    const island = islandCode();
    expect(island).not.toContain("cosmos=proto");
    expect(island).not.toContain("URLSearchParams");
    expect(island).not.toContain("candidate");
    // One import, and it is the static scene.
    const imports = [...island.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(imports).toEqual(["./cosmos/scene.js"]);
    expect(existsSync(join(PKG, "client", "components", "cosmos", "candidate.js"))).toBe(false);
    expect(existsSync(join(PKG, "client", "components", "cosmos", "candidate.d.ts"))).toBe(false);
  });

  it("promotes no layer it was not asked to, and asks for none", () => {
    const scene = sceneCode();
    const { css } = resolveThemeCss("cosmos", undefined);
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const token of ["will-change", "backface-visibility", "translateZ", "translate3d"]) {
      expect(scene).not.toContain(token);
      expect(rules).not.toContain(token);
    }
    // No blanket promotion, no full-page filter, no backdrop blur over the scene.
    expect(rules).not.toMatch(/\.portal-cosmos\s*\{[^}]*filter:/);
  });

  it("runs no frame loop, no interval and no periodic timer", () => {
    const scene = sceneCode();
    for (const token of ["requestAnimationFrame", "setInterval", "setTimeout", "onscroll"]) {
      expect(scene).not.toContain(token);
    }
  });

  it("generates its rules through a constructable stylesheet, not an inline <style>", () => {
    const scene = sceneCode();
    expect(scene).toContain("new CSSStyleSheet()");
    expect(scene).toContain("adoptedStyleSheets");
    expect(scene).not.toContain('createElement("style")');
  });

  it("fetches nothing but its own committed art", () => {
    const scene = sceneCode().split("http://www.w3.org/2000/svg").join("");
    expect(scene).not.toMatch(/https?:\/\//);
    expect(scene).not.toContain("fetch(");
    expect(scene).not.toContain("XMLHttpRequest");
    expect(sceneAssets()).toEqual(["sky/moon.webp", "sky/sky-sphere.webp", "sky/sun.webp"]);
  });
});

describe("what the brief removed", () => {
  it("draws no satellite, wind barb, comet or cloud", () => {
    const scene = sceneCode();
    for (const token of [
      "buildOrbit",
      "satImager",
      "satScat",
      "SCATTEROMETER",
      "POLAR / IMAGER",
      "barbLyr",
      "function barb(",
      "COMETS",
      "buildClouds",
      "buildAircraft",
      "buildSondes",
      "SEA_HEAVE",
      "buildZones",
    ]) {
      expect(scene).not.toContain(token);
    }
    // And the registry that named the packaged bodies.
    expect(scene).not.toMatch(/\bconst SPR\b/);
    expect(scene).not.toMatch(/\bconst SIZE\b/);
  });

  it("reports no object bodies to the packager, and says so rather than failing to answer", () => {
    const scene = readFileSync(SCENE, "utf8");
    expect(scene).toMatch(/export function sceneBodies\(\)\s*\{\s*return \[\];\s*\}/);
  });
});

describe("what the brief kept", () => {
  it("still builds every retained band", () => {
    const scene = sceneCode();
    for (const builder of [
      "buildSky",
      "buildLuminaries",
      "buildAtmosphere",
      "buildEarth",
      "buildMountains",
      "buildStrand",
      "buildOcean",
      "buildFloats",
      "buildCaption",
    ]) {
      expect(scene).toContain(builder + "(");
    }
  });

  it("puts the Sun in a day sky and the Moon in a night sky, and builds one of them", () => {
    const scene = sceneCode();
    expect(scene).toContain('assetUrl("sky/sun.webp")');
    expect(scene).toContain('assetUrl("sky/moon.webp")');
    expect(scene).toContain('host.dataset.sky !== "day"');
  });

  it("lays the star sphere out at the exported texture's own size", () => {
    const scene = sceneCode();
    const declared = /SPHERE_TEXTURE\s*=\s*(\d+)/.exec(scene);
    expect(declared).not.toBeNull();
    const manifest = JSON.parse(readFileSync(join(SCENE_DIR, "sky", "MANIFEST.json"), "utf8")) as {
      geometry?: { textureSide?: number };
      files?: { file: string; intrinsic: string }[];
    };
    const sphere = manifest.files?.find((f) => f.file === "sky-sphere.webp");
    expect(sphere).toBeDefined();
    const side = Number(sphere!.intrinsic.split("x")[0]);
    expect(Number(declared![1])).toBe(side);
    // And the manifest's own record of what it exported agrees with the file it exported.
    expect(manifest.geometry?.textureSide).toBe(side);
  });

  it("draws no star field at runtime - the sphere is a file and only a file", () => {
    const scene = sceneCode();
    for (const token of ["TINTS", "rngFrom", "drawStarSphere"]) {
      expect(scene).not.toContain(token);
    }
  });

  it("stands the iceberg on the same waterline the surface band is drawn at", () => {
    const scene = sceneCode();
    // One element carrying a plain 2D placement, at `groundY` - the line the band above uses.
    expect(scene).toMatch(/transform:translate\(\$\{f2\(cx\)\}px,\$\{f2\(groundY\)\}px\)/);
    expect(scene).toContain("ICE STATION");
  });

  it("keeps the provenance caption, because the fields are still synthetic", () => {
    expect(sceneCode()).toContain("ILLUSTRATIVE, NOT AN ANALYSIS");
  });
});

describe("the theme switch", () => {
  it("rebuilds for a theme change, and keeps the geometry it already solved", () => {
    const island = islandCode();
    expect(island).toContain('attributeFilter: ["data-theme"]');
    // `keepGeometry: true` - bands stay where they were solved, so nothing moves under a reader.
    expect(island).toMatch(/rebuild\(true\)/);
  });

  it("lets the page change colour before it redraws the sky", () => {
    const island = islandCode();
    // A frame and then a task: a rAF callback runs BEFORE the paint it belongs to.
    expect(island).toContain("requestAnimationFrame");
    expect(island).toMatch(/setTimeout\(rebuildSky, 0\)/);
    // And both halves are cancelled on teardown.
    expect(island).toContain("cancelAnimationFrame");
    expect(island).toContain("clearTimeout(pendingTask)");
  });
});

describe("the LIVE status dot", () => {
  const TREE = join(REPO_ROOT, "packages", "dataset-tree", "src", "styles.css");

  it("has no pulse, and its keyframes are deleted rather than unreferenced", () => {
    const css = readFileSync(TREE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toContain("dataset-tree-pulse");
    expect(css).not.toMatch(/\.dataset-tree__mode--live \.dataset-tree__dot\s*\{[^}]*animation:/);
  });

  it("keeps the dot, the label and the status meaning", () => {
    const css = readFileSync(TREE, "utf8");
    expect(css).toContain(".dataset-tree__dot {");
    expect(css).toContain(".dataset-tree__mode--live {");
    const tree = readFileSync(
      join(REPO_ROOT, "packages", "dataset-tree", "src", "tree.ts"),
      "utf8",
    );
    expect(tree).toContain("dataset-tree__mode--${status.tone}");
  });

  it("leaves the functional spinner alone", () => {
    const css = readFileSync(TREE, "utf8");
    expect(css).toContain(".dataset-tree__spin");
  });
});

describe("the shipped scene assets", () => {
  it("are the set the renderer names, and are documented", () => {
    const shipped = readdirSync(join(SCENE_DIR, "sky")).sort();
    expect(shipped).toEqual(["MANIFEST.json", "moon.webp", "sky-sphere.webp", "sun.webp"]);
    // No stray body left behind in the folder.
    expect(readdirSync(SCENE_DIR).filter((f) => f.endsWith(".webp"))).toEqual([]);
    expect(existsSync(join(SCENE_DIR, "README.md"))).toBe(true);
  });

  it("is a modest, local, self-contained set", () => {
    let bytes = 0;
    for (const name of readdirSync(join(SCENE_DIR, "sky"))) {
      bytes += statSync(join(SCENE_DIR, "sky", name)).size;
    }
    // A third of a megabyte of sky, and no object bodies at all.
    expect(bytes).toBeLessThan(400_000);
  });
});
