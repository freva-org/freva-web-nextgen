// A per-mode page palette, driven in a real browser: `theme.tokens.light.colorBackground`.
//
// The full example portal is built again with the Waterpark case - the cosmos preset, a teal
// accent, and a white light-mode page like MkDocs Material's - and nothing else changed. (The teal
// is one white header text reads on: Waterpark's own #009688 measures 3.67:1 under white, which
// the build reports as FP1226 and which has nothing to do with the page colour.) Then:
// the light page is white and the dark page is still the design's; every surface a reader meets
// on a page (cards, admonitions, code, tables, the rail, the search dialog, announcement rows, the
// Data Browser and STAC Browser chrome) still stands off that white page; axe's colour-contrast
// rule passes in both modes; and the cosmos backdrop is the preset's own.
//
// Usage:  node browser-tests/paper-theme.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const REPO = resolve(PKG, "..", "..");
const STRICT = process.env.BROWSER_STRICT === "1";

const skip = (message) => {
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
};

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  skip(`playwright is not installed: ${error.message}`);
}

// The example enables the STAC Browser, so its build needs prepared materials (see run.mjs).
const materials = [
  process.env.FREVA_PORTAL_STAC_MATERIALS,
  resolve(PKG, "..", "stac-browser", "materials"),
].find((dir) => dir && existsSync(join(dir, "materials.json")));
if (!materials) skip("no prepared STAC materials; run 'npm run stac:prepare'");

const PAGE = "#ffffff";
const THEME = `theme:
  preset: cosmos
  tokens:
    colorAccent: "#00796b"
    light:
      colorBackground: "${PAGE}"
`;

function buildSite() {
  const work = mkdtempSync(join(tmpdir(), "paper-theme-"));
  const source = join(work, "source");
  cpSync(join(REPO, "examples", "full-portal"), source, { recursive: true });
  const config = join(source, "portal.yaml");
  const original = readFileSync(config, "utf8");
  const themed = original.replace(/^theme:\n(?:[ ].*\n)+/m, THEME);
  assert.notEqual(themed, original, "the example's theme block was not found");
  writeFileSync(config, themed);
  const out = join(work, "site");
  execFileSync(
    process.execPath,
    [
      join(PKG, "bin", "freva-portal-builder.mjs"),
      "build",
      "--source-root",
      source,
      "--config",
      config,
      "--out",
      out,
      "--quiet",
      "--effective-at",
      "2026-01-07T12:00:00Z",
      "--stac-materials",
      materials,
    ],
    { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
  );
  return out;
}

const SITE = buildSite();
const policy = JSON.parse(readFileSync(join(SITE, "host-policy.json"), "utf8"));
const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
const server = createPreviewServer({ dir: SITE, port: 0 });
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}${policy.mount.basePath}`;

async function launch() {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  try {
    return await chromium.launch({ args });
  } catch (error) {
    const pinned = process.env.FREVA_PORTAL_CHROMIUM ?? "/opt/pw-browsers/chromium";
    if (existsSync(pinned)) return chromium.launch({ args, executablePath: pinned });
    throw error;
  }
}
const browser = await launch();
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push(false);
    console.log(`  FAIL ${name}\n       ${String(error.message).split("\n")[0]}`);
  }
}

async function withPage(fn, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.route(`${base}__axe-core.js`, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: AXE }),
  );
  const page = await context.newPage();
  try {
    await fn(page);
  } finally {
    await context.close();
  }
}

/** Switch the page to `mode` with the header's own control, as a reader does. */
async function useMode(page, mode) {
  const current = await page.evaluate(
    () => document.documentElement.getAttribute("data-theme") ?? "light",
  );
  if (current !== mode) await page.locator(".portal-theme-toggle").click();
  await page.waitForFunction(
    (m) => document.documentElement.getAttribute("data-theme") === m,
    mode,
  );
}

/**
 * Custom properties as `#rrggbb`. The shipped stylesheet is minified, so `#ffffff` arrives as
 * `#fff`: a colour is compared, not its spelling.
 */
const tokens = (page, names) =>
  page.evaluate(
    (list) =>
      Object.fromEntries(
        list.map((name) => {
          const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
          const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw);
          const full = short
            ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
            : raw;
          return [name, full.toLowerCase()];
        }),
      ),
    names,
  );

/**
 * How far an element stands off the page: the contrast of its own fill against the page, and of
 * its border (the widest visible side). Measured in the page, so it is the painted result.
 */
const standOff = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rgb = (value) => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1]
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return a === 0 ? null : [r, g, b];
    };
    const lum = ([r, g, b]) => {
      const f = (c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const pageRgb = rgb(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255];
    const style = getComputedStyle(el);
    const fill = rgb(style.backgroundColor);
    let border = 1;
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const colour = rgb(style[`border${side}Color`]);
      if (colour && parseFloat(style[`border${side}Width`]) >= 1) {
        border = Math.max(border, ratio(colour, pageRgb));
      }
    }
    return { fill: fill ? ratio(fill, pageRgb) : 1, border };
  }, selector);

const pageUrl = (path) => `${base}${path}`;

try {
  await check("the light page is the configured white, and the dark page is the design's", () =>
    withPage(async (page) => {
      await page.goto(pageUrl("docs/guide/"), { waitUntil: "load" });
      await useMode(page, "light");
      const light = await tokens(page, ["--bg", "--surface"]);
      assert.equal(light["--bg"], PAGE);
      assert.notEqual(light["--surface"], PAGE, "the light surface is the page colour");
      const painted = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.equal(painted, "rgb(255, 255, 255)");
      await useMode(page, "dark");
      const dark = await tokens(page, ["--bg", "--surface", "--ink", "--muted"]);
      // The design's dark palette, untouched: freva-tokens.css.
      assert.deepEqual(dark, {
        "--bg": "#10161d",
        "--surface": "#171f28",
        "--ink": "#e9eef3",
        "--muted": "#8794a1",
      });
    }),
  );

  await check("every surface stands off the white page", () =>
    withPage(async (page) => {
      const surfaces = [
        ["docs/showcase/", ".portal-cardgrid-card", "a card"],
        ["docs/guide/", ".portal-admonition", "an admonition"],
        ["docs/guide/", ".portal-code-block", "a code block"],
        ["docs/guide/", ".portal-prose table th", "a table header cell"],
        ["docs/guide/", ".portal-doc-rail", "the document rail"],
        ["docs/guide/", ".portal-announcement", "an announcement row"],
        ["catalog/", ".portal-feature-stac", "the STAC Browser"],
        // The widget's root is a transparent wrapper; its application draws its own ground.
        ["data/", ".freva-db .fdb-app", "the Data Browser"],
      ];
      const weak = [];
      for (const [path, selector, what] of surfaces) {
        await page.goto(pageUrl(path), { waitUntil: "load" });
        await useMode(page, "light");
        await page.waitForSelector(selector, { state: "attached", timeout: 15_000 });
        const seen = await standOff(page, selector);
        // A fill a step off the page, or a visible rule round it.
        if (!seen || (seen.fill < 1.03 && seen.border < 1.15)) {
          weak.push(
            `${what} (${selector}): fill ${seen?.fill.toFixed(3)}, border ${seen?.border.toFixed(3)}`,
          );
        }
      }
      // The header search dialog, open.
      await page.goto(pageUrl("docs/guide/"), { waitUntil: "load" });
      await page.locator("[data-portal-sitesearch-open]").click();
      await page.locator("dialog.portal-sitesearch").waitFor({ state: "visible" });
      const dialog = await standOff(page, "dialog.portal-sitesearch");
      if (!dialog || (dialog.fill < 1.03 && dialog.border < 1.15)) {
        weak.push(
          `the search dialog: fill ${dialog?.fill.toFixed(3)}, border ${dialog?.border.toFixed(3)}`,
        );
      }
      assert.deepEqual(weak, [], `surfaces lost on the white page: ${weak.join("; ")}`);
    }),
  );

  for (const mode of ["light", "dark"]) {
    await check(`text contrast holds in ${mode} mode (axe colour-contrast)`, () =>
      withPage(async (page) => {
        const failures = [];
        for (const path of ["", "docs/guide/", "docs/showcase/"]) {
          await page.goto(pageUrl(path), { waitUntil: "load" });
          await useMode(page, mode);
          await page.addScriptTag({ url: `${base}__axe-core.js` });
          const found = await page.evaluate(async () => {
            const report = await window.axe.run(document, {
              runOnly: { type: "rule", values: ["color-contrast"] },
            });
            return report.violations.flatMap((v) =>
              v.nodes.map((n) => `${n.target.join(" ")}: ${n.any[0]?.message ?? v.id}`),
            );
          });
          failures.push(...found.map((f) => `/${path} ${f}`));
        }
        assert.deepEqual(failures, [], `${failures.length}: ${failures.slice(0, 3).join(" | ")}`);
      }),
    );
  }

  await check("the cosmos backdrop is the preset's, not the page colour", () =>
    withPage(async (page) => {
      await page.goto(pageUrl(""), { waitUntil: "load" });
      await useMode(page, "light");
      const backdrop = await page.evaluate(() => {
        const shell = document.querySelector('.portal-shell[data-backdrop="cosmos"]');
        return shell ? getComputedStyle(shell).backgroundImage : null;
      });
      assert.ok(backdrop, "the landing has no cosmos backdrop");
      // The light sky's own stops, from the preset: space at the top, the ocean at the bottom.
      assert.match(backdrop, /rgb\(13, 27, 44\) 0%/);
      assert.match(backdrop, /rgb\(143, 182, 207\) 100%/);
    }),
  );
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} paper-theme browser checks passed`);
process.exit(failed === 0 ? 0 : 1);
