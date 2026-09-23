#!/usr/bin/env node
// Pre-generate the Cosmos sky artwork.
//
//   node scripts/export-cosmos-art.mjs [--out <dir>] [--width 1440] [--space 1819.686]
//
// Writes `client/components/cosmos/scene/sky/*.webp` plus a `MANIFEST.json` recording what was
// drawn and at what size. Run it when `art/sky-art.mjs` changes; the result is committed, so a
// build - and a visitor - never runs any of this.
//
// WHY A BROWSER. The drawings are `CanvasRenderingContext2D` calls with radial gradients, shadow
// blur, clipping and `globalAlpha`; running them in the engine that would otherwise run them at
// page load makes "pre-generated" mean the identical pixels, earlier, not a reimplementation in
// another rasteriser. Chromium is already here, headless, for the browser tests.
//
// WHY WEBP. The artifact already serves the scene's object bodies as WebP. Everything here is
// LOSSY - quality 92 for the star disc, 95 for the two luminaries - because all three are fields
// of soft gradients where lossless is several times larger for no visible gain; `MANIFEST.json`
// records the quality actually used for each file.
//
// GEOMETRY. The defaults are the Waterpark landing page's solved geometry at 1440 CSS px. One
// geometry on purpose: these are images, not a renderer, and the page scales and places them.
// `--width` and `--space` allow a second set for another breakpoint.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : d;
};

const OUT = arg("out", join(PKG, "client", "components", "cosmos", "scene", "sky"));
const W = Number(arg("width", 1440));
const SPACE_END = Number(arg("space", 1819.686));

// The sphere's radius and texture scale, exactly as `buildSky` computes them: the pole sits at
// `0.84 w, 0.19 spaceEnd` and the sphere reaches the furthest corner of the band it turns behind,
// with two per cent to spare.
const poleX = W * 0.84;
const poleY = SPACE_END * 0.19;
const R =
  Math.max(
    Math.hypot(poleX, poleY),
    Math.hypot(W - poleX, poleY),
    Math.hypot(poleX, SPACE_END - poleY),
    Math.hypot(W - poleX, SPACE_END - poleY),
  ) * 1.02;
const ts = Math.min(0.5, 900 / R);
const TW = Math.round(2 * R * ts);

// The luminaries' own radii, also `scene.js`'s.
const sunR = Math.min(W, SPACE_END) * 0.125;
const moonR = sunR * 0.52;

const ART = readFileSync(join(PKG, "client", "components", "cosmos", "art", "sky-art.mjs"), "utf8");

// Which browser, with no hardcoded path: Playwright resolves its own managed Chromium from
// `PLAYWRIGHT_BROWSERS_PATH` or its default cache, which `npx playwright install chromium` fills.
// `--browser` and `COSMOS_EXPORT_BROWSER` are the escape hatch for a machine that would rather
// point at a Chrome it already has; `channel` tells Playwright to use an installed Chrome or Edge
// rather than a downloaded build.
const BROWSER_PATH = arg("browser", process.env.COSMOS_EXPORT_BROWSER);
const CHANNEL = arg("channel", process.env.COSMOS_EXPORT_CHANNEL);
let browser;
try {
  browser = await chromium.launch({
    ...(BROWSER_PATH ? { executablePath: BROWSER_PATH } : {}),
    ...(CHANNEL ? { channel: CHANNEL } : {}),
  });
} catch (error) {
  console.error(
    [
      "cosmos art export: could not launch a browser.",
      "",
      "  npx playwright install chromium        # install Playwright's own build, then re-run",
      "  node scripts/export-cosmos-art.mjs --channel chrome      # or use an installed Chrome",
      "  node scripts/export-cosmos-art.mjs --browser /path/to/chrome",
      "",
      "The committed art in client/components/cosmos/scene/sky/ is what the build publishes,",
      "so this script is only needed when art/sky-art.mjs changes.",
      "",
      String(error && error.message ? error.message : error),
    ].join("\n"),
  );
  process.exit(1);
}
const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
await page.setContent("<!doctype html><title>cosmos art export</title>");
// The module is imported from a blob URL and its exports hung on `window`, because a module
// script tag's bindings are not reachable from `evaluate`. Same file, one hop, no transformation.
await page.evaluate(async (src) => {
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  window.ART = await import(url);
  URL.revokeObjectURL(url);
}, ART);

/** Draw into an offscreen canvas and return raw bytes of the encoded image. */
async function render(name, { width, height, originX, originY, scale, type, quality, draw }) {
  const dataUrl = await page.evaluate(
    async ({ width, height, originX, originY, scale, type, quality, draw, params }) => {
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.ceil(width * scale));
      cv.height = Math.max(1, Math.ceil(height * scale));
      const c = cv.getContext("2d");
      c.setTransform(scale, 0, 0, scale, 0, 0);
      c.translate(originX, originY);

      new Function("c", "ART", "p", draw)(c, window.ART, params);
      return cv.toDataURL(type, quality);
    },
    {
      width,
      height,
      originX,
      originY,
      scale,
      type,
      quality,
      draw,
      params: { R, ts, TW, sunR, moonR, seed: 11311 },
    },
  );
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Buffer.from(b64, "base64");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), bytes);
  return {
    file: name,
    intrinsic: `${Math.ceil(width * scale)}x${Math.ceil(height * scale)}`,
    megapixels: +((Math.ceil(width * scale) * Math.ceil(height * scale)) / 1e6).toFixed(2),
    decodedMiB: +((Math.ceil(width * scale) * Math.ceil(height * scale) * 4) / 1048576).toFixed(1),
    encodedKiB: +(bytes.length / 1024).toFixed(1),
    encoding: type + (quality ? ` q${Math.round(quality * 100)}` : " lossless"),
  };
}

const manifest = {
  generatedFrom: "client/components/cosmos/art/sky-art.mjs",
  geometry: {},
  files: [],
};
manifest.geometry = {
  width: W,
  spaceEnd: SPACE_END,
  poleX: +poleX.toFixed(2),
  poleY: +poleY.toFixed(2),
  sphereRadius: +R.toFixed(2),
  textureScale: +ts.toFixed(4),
  textureSide: TW,
  displayedSide: +(2 * R).toFixed(1),
  sunR: +sunR.toFixed(2),
  moonR: +moonR.toFixed(2),
};

manifest.files.push(
  await render("sky-sphere.webp", {
    width: TW,
    height: TW,
    originX: 0,
    originY: 0,
    scale: 1,
    type: "image/webp",
    quality: 0.92,
    draw: "ART.drawStarSphere(c, { R: p.R, ts: p.ts, rng: ART.rngFrom(p.seed) })",
  }),
);
manifest.files.push(
  await render("moon.webp", {
    width: moonR * 2.1,
    height: moonR * 2.1,
    originX: moonR * 1.05,
    originY: moonR * 1.05,
    scale: 2,
    type: "image/webp",
    quality: 0.95,
    draw: "ART.drawMoon(c, { moonR: p.moonR })",
  }),
);
manifest.files.push(
  await render("sun.webp", {
    width: sunR * 2.2,
    height: sunR * 2.2,
    originX: sunR * 1.1,
    originY: sunR * 1.1,
    scale: 1.4,
    type: "image/webp",
    quality: 0.95,
    draw: "ART.drawSun(c, { sunR: p.sunR })",
  }),
);

writeFileSync(join(OUT, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
await browser.close();
console.log(JSON.stringify(manifest, null, 2));
