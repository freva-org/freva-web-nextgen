// `chrome.footer.bar`: shortcuts in the collapsed footer bar, measured on real pages.
//
// The bar is the one part of the footer on screen on every page, so the claims are about every
// kind of page: a landing, a documentation page and an application view (the Data Browser), at a
// desktop, a tablet and a phone width, in both colour modes. Against a build WITHOUT the option,
// the bar keeps its height; the shortcuts stay on one line, give way with an ellipsis rather than
// wrapping or scrolling, drop the lead below 640px, and are real links - clickable, focusable with
// a visible ring, and readable on the footer in every preset.
//
// Usage:  node browser-tests/footer-bar.mjs [screenshot-dir]

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.env.BROWSER_STRICT === "1";
const SHOTS = resolve(process.argv[2] ?? join(tmpdir(), "footer-bar-shots"));

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  if (STRICT) {
    console.error(`playwright is not installed: ${error.message}`);
    process.exit(1);
  }
  console.log(`SKIP  playwright is not installed: ${error.message}`);
  process.exit(0);
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Mark</title><rect width="16" height="16" fill="#123456"/></svg>`;

/** The Waterpark example, plus one internal link so a click can be followed without a new tab. */
const BAR = `    bar:
      lead: "Need support?"
      links:
        - label: waterpark@support.dkrz.de
          href: mailto:waterpark@support.dkrz.de
        - label: Newsletter
          href: https://waterpark.dkrz.de/subscription/form
        - label: Guide
          href: /docs/guide/
`;

function buildSite(preset, withBar) {
  const name = `${preset}-${withBar ? "bar" : "plain"}`;
  const root = mkdtempSync(join(tmpdir(), `footer-bar-${name}-`));
  const put = (rel, body) => {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put(
    "content/guide.md",
    "---\ntitle: Guide\n---\n\n# Guide\n\n" +
      "A documentation page, long enough to scroll.\n\n".repeat(40),
  );
  put(
    "landings/home.yaml",
    `schemaVersion: 1
title: Footer bar
blocks:
  - type: hero
    heading: The footer bar carries shortcuts
    summary: On every page.
`,
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: footer-bar-${name}
  title: Footer bar
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
  institution:
    name: Deutsches Klimarechenzentrum
theme:
  preset: ${preset}
rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
services:
  dataApi:
    kind: databrowser
    baseUrl: /api/freva-nextgen/databrowser
    authentication: optional
components:
  data:
    kind: databrowser
    enabled: true
    service: dataApi
    route: /databrowser/
chrome:
  footer:
    enabled: true
    groups:
      - title: Contact
        links:
          - label: Support
            href: mailto:waterpark@support.dkrz.de
${withBar ? BAR : ""}landings:
  home:
    path: /
    source: ./landings/home.yaml
`,
  );
  const out = join(root, "..", `footer-bar-site-${name}-${process.pid}`);
  execFileSync(
    process.execPath,
    // prettier-ignore
    [join(PKG, "bin", "freva-portal-builder.mjs"), "build", "--source-root", root,
     "--config", join(root, "portal.yaml"), "--out", out, "--quiet"],
    { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
  );
  return out;
}

const PRESETS = ["default", "freva", "waterpark", "contour", "cosmos"];
// Waterpark's own preset is the one photographed and measured in full; every preset is checked
// for contrast.
const MAIN = "cosmos";
const sites = {};
for (const preset of PRESETS) sites[`${preset}-bar`] = buildSite(preset, true);
sites[`${MAIN}-plain`] = buildSite(MAIN, false);

const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
const servers = [];
const bases = {};
for (const [key, dir] of Object.entries(sites)) {
  const server = createPreviewServer({ dir, port: 0 });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  bases[key] = `http://127.0.0.1:${server.address().port}/`;
}

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

const results = [];
async function check(name, fn) {
  if (process.env.FREVA_ONLY && !name.includes(process.env.FREVA_ONLY)) return;
  try {
    await fn();
    results.push(true);
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push(false);
    console.log(
      `  FAIL ${name}\n       ${String(error.message).split("\n").slice(0, 4).join("\n       ")}`,
    );
  }
}

/** WCAG contrast of two computed colours, `rgb()`/`rgba()` or `color(srgb …)`, over `bg`. */
function contrastOf(fg, bg) {
  const parse = (value) => {
    const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(value);
    if (srgb) return [...srgb.slice(1, 4).map((c) => Number(c) * 255), Number(srgb[4] ?? 1)];
    const rgb = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/.exec(value);
    if (rgb) return [...rgb.slice(1, 4).map(Number), Number(rgb[4] ?? 1)];
    throw new Error(`unparsed colour ${value}`);
  };
  const [br, bgG, bb] = parse(bg);
  const [fr, fg2, fb, fa] = parse(fg);
  const mix = [fr * fa + br * (1 - fa), fg2 * fa + bgG * (1 - fa), fb * fa + bb * (1 - fa)];
  const lum = (rgb) =>
    rgb
      .map((c) => c / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(mix), lum([br, bgG, bb])].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const browser = await launch();
async function withPage(key, path, viewport, mode, fn) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  await context.addInitScript((m) => {
    try {
      localStorage.setItem("freva.portal.theme", m);
    } catch {
      // storage refused: the page renders in its default mode
    }
  }, mode);
  const page = await context.newPage();
  try {
    await page.goto(`${bases[key]}${path}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".portal-footer-bar", { timeout: 15_000 });
    await page.waitForFunction(
      (m) => document.documentElement.getAttribute("data-theme") === m,
      mode,
    );
    return await fn(page);
  } finally {
    await context.close();
  }
}

/** The bar and its shortcuts, as laid out. */
const MEASURE = () => {
  const bar = document.querySelector(".portal-footer-bar");
  const nav = document.querySelector(".portal-footer-shortcuts");
  const box = (el) => el.getBoundingClientRect();
  const links = [...(nav?.querySelectorAll("a") ?? [])].map((a) => {
    const r = box(a);
    const navBox = box(nav);
    // On a phone the last link that shows may be cut by the ellipsis: what is on screen of it is
    // what a pointer can reach, and that is what is tested.
    const left = Math.max(r.left, navBox.left);
    const shown = Math.min(r.right, navBox.right - 3) - left;
    const visible = r.width > 0 && shown >= 16;
    const hit = visible ? document.elementFromPoint(left + 8, r.top + r.height / 2) : null;
    return {
      label: a.textContent.trim(),
      href: a.getAttribute("href"),
      target: a.getAttribute("target"),
      rel: a.getAttribute("rel"),
      visible,
      whole: r.width > 0 && r.right <= navBox.right - 2,
      clickable: hit === a || a.contains(hit),
    };
  });
  const lead = nav?.querySelector(".portal-footer-shortcuts-lead");
  return {
    barHeight: Math.round(box(bar).height * 100) / 100,
    nav: nav
      ? {
          shown: getComputedStyle(nav).display !== "none" && box(nav).width > 0,
          label: nav.getAttribute("aria-label"),
          height: box(nav).height,
          lineHeight: parseFloat(getComputedStyle(nav).lineHeight),
          truncated: nav.scrollWidth > nav.clientWidth,
          insideBar: box(nav).top >= box(bar).top - 0.5 && box(nav).bottom <= box(bar).bottom + 0.5,
          separatorsHidden: [...nav.querySelectorAll(".portal-footer-shortcuts-sep")].every(
            (s) => s.getAttribute("aria-hidden") === "true",
          ),
        }
      : null,
    leadShown: lead ? getComputedStyle(lead).display !== "none" : null,
    links,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 360, height: 740 },
];
const PAGES = [
  { name: "landing", path: "" },
  { name: "document", path: "docs/guide/" },
  { name: "Data Browser", path: "databrowser/" },
];

try {
  mkdirSync(SHOTS, { recursive: true });
  for (const pageSpec of PAGES) {
    for (const viewport of VIEWPORTS) {
      for (const mode of ["light", "dark"]) {
        const at = `${pageSpec.name}, ${viewport.width}px, ${mode}`;
        await check(`the bar keeps its height and its shortcuts work (${at})`, async () => {
          const plain = await withPage(`${MAIN}-plain`, pageSpec.path, viewport, mode, (page) =>
            page.evaluate(MEASURE),
          );
          const m = await withPage(`${MAIN}-bar`, pageSpec.path, viewport, mode, async (page) => {
            await page.locator(".portal-footer").screenshot({
              path: join(
                SHOTS,
                `${pageSpec.name.replace(/ /g, "-")}-${viewport.width}-${mode}.png`,
              ),
            });
            return page.evaluate(MEASURE);
          });
          const detail = JSON.stringify(m);
          assert.equal(m.barHeight, plain.barHeight, `bar height changed ${detail}`);
          assert.ok(m.nav?.shown, `no shortcuts ${detail}`);
          assert.equal(m.nav.label, "Footer shortcuts");
          assert.ok(m.nav.separatorsHidden, detail);
          assert.ok(m.nav.insideBar, `the shortcuts spill out of the bar ${detail}`);
          assert.ok(m.nav.height < m.nav.lineHeight * 2, `the shortcuts wrapped ${detail}`);
          assert.equal(m.overflow, 0, `horizontal scroll ${detail}`);
          assert.equal(m.leadShown, viewport.width > 640, `lead ${detail}`);
          // Every link that is on screen is a link a pointer reaches; the first always is.
          assert.ok(m.links[0].visible && m.links[0].clickable, `first link ${detail}`);
          for (const link of m.links.filter((l) => l.visible)) {
            assert.ok(link.clickable, `${link.label} is covered ${detail}`);
          }
          // Where they do not all fit, they end in an ellipsis rather than wrapping.
          if (m.links.some((l) => !l.whole)) assert.ok(m.nav.truncated, detail);
          // mailto: gets neither target nor rel; https:// opens a new tab; a site path neither.
          assert.deepEqual(
            m.links.map((l) => [l.target, l.rel]),
            [
              [null, null],
              ["_blank", "noopener noreferrer"],
              [null, null],
            ],
          );
        });
      }
    }
  }

  await check("a click on a shortcut follows it", () =>
    withPage(`${MAIN}-bar`, "", VIEWPORTS[0], "light", async (page) => {
      await page.click(".portal-footer-shortcut >> text=Guide");
      await page.waitForURL(/\/docs\/guide\/$/, { timeout: 10_000 });
    }),
  );

  await check("a shortcut takes the keyboard focus with a visible ring", () =>
    withPage(`${MAIN}-bar`, "docs/guide/", VIEWPORTS[0], "dark", async (page) => {
      await page.keyboard.press("Tab");
      await page.focus(".portal-footer-shortcut >> nth=1");
      const ring = await page.$eval(".portal-footer-shortcut >> nth=1", (a) => {
        const s = getComputedStyle(a);
        return {
          focusVisible: a.matches(":focus-visible"),
          outline: `${s.outlineStyle} ${s.outlineWidth}`,
          underline: s.textDecorationLine,
          colour: s.color,
          strong: getComputedStyle(document.documentElement).getPropertyValue("--footer-strong"),
        };
      });
      assert.equal(ring.focusVisible, true);
      assert.equal(ring.outline, "solid 2px", JSON.stringify(ring));
      assert.equal(ring.underline, "underline", JSON.stringify(ring));
    }),
  );

  for (const preset of PRESETS) {
    for (const mode of ["light", "dark"]) {
      await check(`the shortcuts are readable on the footer (${preset}, ${mode})`, () =>
        withPage(`${preset}-bar`, "docs/guide/", VIEWPORTS[0], mode, async (page) => {
          const colours = await page.evaluate(() => {
            const bg = getComputedStyle(document.querySelector(".portal-footer")).backgroundColor;
            const link = document.querySelector(".portal-footer-shortcut");
            const lead = document.querySelector(".portal-footer-shortcuts-lead");
            const strong = getComputedStyle(document.documentElement)
              .getPropertyValue("--footer-strong")
              .trim();
            // The hover colour, resolved the same way the browser resolves the link's own.
            const probe = document.createElement("span");
            probe.style.color = strong;
            document.querySelector(".portal-footer-bar").append(probe);
            const hover = getComputedStyle(probe).color;
            probe.remove();
            return {
              bg,
              link: getComputedStyle(link).color,
              lead: getComputedStyle(lead).color,
              hover,
            };
          });
          for (const which of ["link", "lead", "hover"]) {
            const ratio = contrastOf(colours[which], colours.bg);
            assert.ok(
              ratio >= 4.5,
              `${which} ${colours[which]} on ${colours.bg} is ${ratio.toFixed(2)}:1`,
            );
          }
        }),
      );
    }
  }
} catch (error) {
  console.error(error);
  results.push(false);
} finally {
  await browser.close();
  for (const server of servers) server.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} footer bar checks passed; screenshots in ${SHOTS}`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
