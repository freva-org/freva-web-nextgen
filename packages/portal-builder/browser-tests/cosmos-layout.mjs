// The Cosmos landing composition and the document routes, measured rather than described.
//
// Every check here exists because something looked right in a stylesheet and wrong on a screen,
// and none of them could be caught by asserting that a CSS rule exists:
//
//   1. the hero row uses the page's width, not the Cosmos reading column - capped, the shell
//      divides 47 % of the viewport into two and squeezes a paragraph against a search card;
//   2. no one veil covers both hero columns, drawing a pale slab over a search box and a dataset
//      tree that already have surfaces of their own;
//   3. the backdrop attribute belongs to the landing only; written on every route, documentation
//      pages take the night-sky gradient and a translucent slab behind their prose;
//   4. the theme's stacking rule must not name `.portal-header` and `.portal-footer`, beat the
//      base shell on specificity and turn the fixed chrome into flow content, leaving the Freva
//      badge fixed in the overlay layer with no footer bar under it.
//
// So this measures rectangles and reads computed styles. It is deliberately cheap: two builds,
// one browser, no scene photography. The full scene probe is `cosmos-visual.mjs`, run once at
// the end.
//
// Usage:  node browser-tests/cosmos-layout.mjs [out-dir]

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { SAMPLE_PIXELS, sceneShot } from "./fixtures/scene-photo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const OUT = resolve(process.argv[2] ?? join(tmpdir(), "cosmos-layout-shots"));
const STRICT = process.env.BROWSER_STRICT === "1";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  const message = `playwright is not installed: ${error.message}`;
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

// fixture

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Mark</title><rect width="16" height="16" fill="#123456"/></svg>`;

/**
 * A landing shaped like a real one: a hero with copy and two calls to action, an aside, and enough
 * blocks after it that the reading column has something to apply to. Plus a documentation page with
 * a heading structure, because half of these checks are about what the theme must NOT do to one.
 */
function writeFixture(preset) {
  const root = mkdtempSync(join(tmpdir(), `cosmos-layout-${preset}-`));
  const put = (rel, body) => {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put(
    "content/guide.md",
    `---\ntitle: Remapping decisions\n---\n\n${[
      "A documentation page with a contents list, so the checks below are about a real layout.",
      "## Why HEALPix",
      "Equal-area pixels make a global mean an arithmetic mean.",
      "## Target level selection",
      "The zoom level is chosen from the native resolution.",
      "## Weight generation",
      "Weights are generated once and reused.",
      "## Missing values",
      "Renormalisation is the default.",
    ].join("\n\n")}\n`,
  );
  put(
    "content/_fragments/about.md",
    [
      "A landing carries what a documentation page carries, which is why this fragment is here:",
      "the width check compares a paragraph in this block against a paragraph in the guide.",
      "",
      "```python",
      "import xarray as xr",
      "",
      "ds = xr.open_dataset(",
      '    "https://s3.example.org/archive/reanalysis/t2m_hourly.zarr",',
      '    engine="zarr", chunks={},',
      ")",
      "```",
      "",
      "A code sample is the reason a landing is not a book column.",
    ].join("\n") + "\n",
  );
  put(
    "landings/home.yaml",
    `schemaVersion: 1
title: Layout Fixture
blocks:
  - type: hero
    heading: Research data, ready to explore
    summary: Find and inspect published datasets, then take them into your own analysis.
    actions:
      - label: Browse data
        component: data
      - label: Read the guide
        href: /docs/guide/
  - type: component-search
    heading: Search the archive
    component: data
    placeholder: Search climate data
    submitLabel: Search
  - type: prose
    heading: About this fixture
    source: ../content/_fragments/about.md
  - type: cards
    heading: Where to go next
    items:
      - title: Documentation
        summary: The data model and the workflows around it.
        href: /docs/guide/
`,
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: cosmos-layout-${preset}
  title: Layout Fixture
  subtitle: Discover data and project resources
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: ${preset}
rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
      files:
        include:
          - "**/*.md"
        exclude:
          - "_fragments/**"
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
    route: /data/
    options:
      defaultFlavour: freva
landings:
  home:
    path: /
    source: ./landings/home.yaml
`,
  );
  const out = join(root, "..", `cosmos-layout-site-${preset}-${process.pid}`);
  execFileSync(
    process.execPath,
    [
      join(PKG, "bin", "freva-portal-builder.mjs"),
      "build",
      "--source-root",
      root,
      "--config",
      join(root, "portal.yaml"),
      "--out",
      out,
      "--quiet",
    ],
    { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
  );
  return out;
}

const SITES = { cosmos: writeFixture("cosmos"), waterpark: writeFixture("waterpark") };

// server

const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
const servers = {};
const bases = {};
for (const [preset, root] of Object.entries(SITES)) {
  const server = createPreviewServer({ dir: root, port: 0 });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers[preset] = server;
  bases[preset] = `http://127.0.0.1:${server.address().port}/`;
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

let browser;
try {
  browser = await launch();
} catch (error) {
  for (const server of Object.values(servers)) server.close();
  const message = `chromium would not launch: ${error.message}`;
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
const results = [];
const measurements = {};

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${String(error.message).split("\n")[0]}`);
  }
}

const DESKTOP = { width: 1440, height: 900 };
const LAPTOP = { width: 1110, height: 881 };
const PHONE = { width: 390, height: 844 };

async function open(preset, path, viewport, theme, fn) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((m) => {
    try {
      localStorage.setItem("freva.portal.theme", m);
    } catch {
      // a context that refuses storage still renders the light theme
    }
  }, theme);
  const page = await context.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  try {
    await page.goto(`${bases[preset]}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(path === "" ? 700 : 250);
    const applied = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.equal(applied, theme, `asked for ${theme}, got ${applied}`);
    await fn(page, requests);
  } finally {
    await context.close();
  }
}

/** Rectangles and computed styles, in one round trip. */
const LANDING_PROBE = () => {
  const box = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  const style = (sel, prop) => {
    const e = document.querySelector(sel);
    return e ? getComputedStyle(e)[prop] : null;
  };
  const pseudo = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const s = getComputedStyle(e, "::before");
    return {
      content: s.content,
      width: s.width,
      height: s.height,
      image: s.backgroundImage,
      // THE SCRIM IS A BACKGROUND COLOUR, NOT AN IMAGE. It is
      // `rgba(0, 0, 0, var(--portal-cosmos-hero-scrim))` painted flat and then masked, so
      // `backgroundImage` is the MASK's business and the colour is where the scrim actually is.
      color: s.backgroundColor,
    };
  };
  const heading = document.querySelector(".portal-hero-heading");
  const cta = [...document.querySelectorAll(".portal-hero-actions a")].pop();
  const footer = document.querySelector(".portal-footer");
  const badge = document.querySelector("#portal-footer-badge");
  return {
    heroRow: box(".portal-hero-row"),
    heroLead: box(".portal-hero-lead"),
    heroAside: box(".portal-hero-aside"),
    landing: box(".portal-landing"),
    heading: box(".portal-hero-heading"),
    headingLines: heading
      ? Math.round(
          heading.getBoundingClientRect().height / parseFloat(getComputedStyle(heading).lineHeight),
        )
      : null,
    // The reading column, described as a reader experiences it. `chars` divides the block's width
    // by the width of a zero in ITS OWN font, which is the only honest way to talk about line
    // length: the CSS cap is in `ch` resolved against a different element, so the number in the
    // stylesheet and the number on the page are not the same one. `clear` is how much window is
    // left for the scene beside it.
    card: (() => {
      const rect = box(".portal-cards");
      if (!rect) return null;
      const element = document.querySelector(".portal-cards");
      const text = element.querySelector("p, h2, h3") ?? element;
      const cs = getComputedStyle(text);
      const measure = document.createElement("canvas").getContext("2d");
      measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const zero = measure.measureText("0".repeat(50)).width / 50;
      // Scene left clear on each side of the column, measured against the window rather than
      // against the container: the canvas is full-bleed, so the window is what the reader sees.
      return {
        ...rect,
        chars: Math.round(rect.w / zero),
        clearLeft: Math.round(rect.x),
        clearRight: Math.round(window.innerWidth - (rect.x + rect.w)),
        siblings: document.querySelectorAll(".portal-landing > *:not(.portal-hero-row)").length,
      };
    })(),
    headerPosition: style(".portal-header", "position"),
    footerPosition: style(".portal-footer", "position"),
    footerRect: box(".portal-footer"),
    badgeRect: badge ? box("#portal-footer-badge") : null,
    canvasOpacity: style(".portal-cosmos", "opacity"),
    canvasFilter: style(".portal-cosmos", "filter"),
    rowVeil: pseudo(".portal-hero-row"),
    leadVeil: pseudo(".portal-hero-lead"),
    leadVeilImage: pseudo(".portal-hero-lead")?.image ?? "none",
    leadVeilColor: pseudo(".portal-hero-lead")?.color ?? "none",
    headingColor: style(".portal-hero-heading", "color"),
    headingShadow: style(".portal-hero-heading", "textShadow"),
    storyScreens: +(document.documentElement.scrollHeight / window.innerHeight).toFixed(2),
    // The renderer's own division of that track, in screens, straight from its diagnostics
    // channel. `null` until the scene has drawn a frame.
    bands: (() => {
      const g = window.__portalCosmos?.geom;
      if (!g || !(g.H > 0)) return null;
      const h = g.h || window.innerHeight;
      return {
        h,
        story: +(g.H / h).toFixed(3),
        cosmos: +(g.spaceEnd / h).toFixed(3),
        section: +((g.groundY - g.chartTop) / h).toFixed(3),
        ocean: +((g.oceanBot - g.seaY) / h).toFixed(3),
        bottom: Math.round(g.H - g.oceanBot),
      };
    })(),
    // What is below the last thing on the page. The story's tail is empty story: the reader has
    // finished the content and is still scrolling. Measured in screens and against the ocean
    // band, because "how much water is there after the last block" is the question, and a number
    // in `vh` answers a different one.
    tail: (() => {
      const landing = document.querySelector(".portal-landing");
      const blocks = [...(landing?.children ?? [])].filter(
        (el) => el.getBoundingClientRect().height > 0 && el.tagName !== "CANVAS",
      );
      const last = blocks[blocks.length - 1];
      if (!landing || !last) return null;
      const g = window.__portalCosmos?.geom;
      const h = g?.h || window.innerHeight;
      const lastBottom = last.getBoundingClientRect().bottom + window.scrollY;
      const landingBottom = landing.getBoundingClientRect().bottom + window.scrollY;
      return {
        px: Math.round(landingBottom - lastBottom),
        screens: +((landingBottom - lastBottom) / h).toFixed(3),
        oceanBands: g ? +((landingBottom - lastBottom) / (g.oceanBot - g.seaY)).toFixed(3) : null,
        padBottom: getComputedStyle(landing).paddingBottom,
      };
    })(),
    ctaBottom: cta ? Math.round(cta.getBoundingClientRect().bottom) : null,
    footerTop: footer ? Math.round(footer.getBoundingClientRect().top) : null,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    landingPadTop: style(".portal-landing", "paddingTop"),
  };
};

const DOC_PROBE = () => {
  const style = (sel, prop) => {
    const e = document.querySelector(sel);
    return e ? getComputedStyle(e)[prop] : null;
  };
  const box = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  return {
    backdrop: document.querySelector(".portal-shell")?.getAttribute("data-backdrop") ?? null,
    shellBackgroundImage: style(".portal-shell", "backgroundImage"),
    proseBackground: style(".portal-prose", "backgroundColor"),
    contentBlockBackground: style(".portal-content-block", "backgroundColor"),
    headerPosition: style(".portal-header", "position"),
    footerPosition: style(".portal-footer", "position"),
    footerRect: box(".portal-footer"),
    documentRect: box(".portal-document"),
    tocRect: box(".portal-doc-toc") ?? box("nav[class*='toc']"),
    canvas: !!document.querySelector(".portal-cosmos"),
    sceneKey: !!document.querySelector("[data-portal-cosmos-key]"),
  };
};

try {
  // the hero row
  await check("the hero row uses the page's width, not the reading column", () =>
    open("cosmos", "", DESKTOP, "light", async (page) => {
      const m = await page.evaluate(LANDING_PROBE);
      measurements["landing-1440x900-light"] = m;
      // The reading column is 47vw = 677 px at this viewport. The row must be far wider: it is
      // the page's own content width, less the shell gutters.
      assert.ok(m.heroRow.w > 1100, `hero row is ${m.heroRow.w}px wide`);
      assert.ok(
        m.heroRow.w >= m.landing.w - 140,
        `hero row ${m.heroRow.w} is much narrower than the landing ${m.landing.w}`,
      );
      // Centred: equal gutters either side, within a pixel of rounding.
      const left = m.heroRow.x - m.landing.x;
      const right = m.landing.x + m.landing.w - (m.heroRow.x + m.heroRow.w);
      assert.ok(Math.abs(left - right) <= 2, `gutters differ: ${left} vs ${right}`);
    }),
  );

  await check("copy is on the left and the aside on the right, with room to breathe", () =>
    open("cosmos", "", DESKTOP, "light", async (page) => {
      const m = await page.evaluate(LANDING_PROBE);
      assert.ok(
        m.heroLead.x + m.heroLead.w <= m.heroAside.x,
        `lead ends at ${m.heroLead.x + m.heroLead.w}, aside starts at ${m.heroAside.x}`,
      );
      assert.ok(m.heroAside.w >= 360, `aside is only ${m.heroAside.w}px wide`);
      const gap = m.heroAside.x - (m.heroLead.x + m.heroLead.w);
      assert.ok(gap >= 60, `column gap is ${gap}px`);
    }),
  );

  await check("a landing block is as wide as a document's, with the same measure", async () => {
    // The Cosmos landing has no reading column of its own: a paragraph on it must get the same
    // measure a paragraph in the documentation gets, and a block must fill the page container the
    // way a document does. So the assertion is an equality against the document view, at four
    // widths spanning the 64rem breakpoint, rather than against a number.
    //
    // A cap looks right in a stylesheet and wrong on the page: `47vw` gives 54 characters at 1280
    // and 84 at 1920 with a constant ~730px of empty scene, and `min(76ch, 58vw)` gives a stable
    // 66 with the same void moved to one side. A landing carries what a documentation page
    // carries - wide code samples, card grids, link rows - and `.portal-prose` in the shell
    // already says exactly that, which is why its own measure is 108ch and not a book column.
    const MEASURE = () => {
      const prose = document.querySelector(".portal-prose");
      const paragraph = prose?.querySelector("p") ?? prose;
      const host = document.querySelector(".portal-landing, .portal-document");
      const hostStyle = getComputedStyle(host);
      const inner =
        host.getBoundingClientRect().width -
        parseFloat(hostStyle.paddingLeft) -
        parseFloat(hostStyle.paddingRight);
      const style = getComputedStyle(paragraph);
      const ruler = document.createElement("canvas").getContext("2d");
      ruler.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const zero = ruler.measureText("0".repeat(50)).width / 50;
      const width = paragraph.getBoundingClientRect().width;
      const block = document.querySelector(".portal-landing > *:not(.portal-hero-row)");
      const blockStyle = block ? getComputedStyle(block) : null;
      return {
        inner: Math.round(inner),
        prose: Math.round(width),
        proseCap: prose ? getComputedStyle(prose).maxWidth : null,
        chars: Math.round(width / zero),
        blockWidth: block ? Math.round(block.getBoundingClientRect().width) : null,
        blockCap: blockStyle ? blockStyle.maxWidth : null,
      };
    };

    for (const width of [2560, 1440, 1230, 1023]) {
      const viewport = { width, height: 900 };
      let landing;
      let document_;
      await open("cosmos", "", viewport, "light", async (page) => {
        landing = await page.evaluate(MEASURE);
      });
      await open("cosmos", "docs/guide/", viewport, "light", async (page) => {
        document_ = await page.evaluate(MEASURE);
      });

      // Never the narrower of the two. The documentation page in this fixture carries a contents
      // rail, so above about 1700 its article is the narrower one - 101 characters at 2560
      // against the landing's 108 - and asserting equality there would be asserting the rail.
      // The same rule, literally: `.portal-prose` carries one measure for the whole shell, and a
      // landing must be governed by it rather than by a cap of its own.
      assert.equal(
        landing.proseCap,
        document_.proseCap,
        `at ${width} the landing prose is capped at ${landing.proseCap} and the documentation at ${document_.proseCap}`,
      );
      // And the landing is never the narrower page. Compared on the CONTAINER rather than on the
      // paragraph, because a landing block is a panel with its own padding and a document is not:
      // at 1023 that padding costs the landing five characters, by design and not a cap.
      assert.ok(
        landing.inner >= document_.inner,
        `at ${width} the landing has ${landing.inner}px to a document's ${document_.inner}px`,
      );
      // Where the container is wide enough for the shared cap to be what binds, the landing lands
      // exactly on it - the assertion a cap of 47vw (54 characters at 1280, 84 at 1920) or
      // `min(76ch, 58vw)` (a stable 66) would each fail.
      if (landing.prose < landing.inner - 60) {
        assert.equal(
          landing.chars,
          108,
          `at ${width} the landing measures ${landing.chars} characters, not the shell's 108`,
        );
      }
      // And the block is the container, uncapped, at every width.
      assert.equal(
        landing.blockCap,
        "none",
        `at ${width} a landing block is capped at ${landing.blockCap}`,
      );
      assert.ok(
        Math.abs(landing.blockWidth - landing.inner) <= 1,
        `at ${width} a block is ${landing.inner - landing.blockWidth}px narrower than its container`,
      );
    }
  });

  await check("a block carries one surface, not two", () =>
    open("cosmos", "", DESKTOP, "light", async (page) => {
      // The prose surface rule must not name `.portal-content-block` and `.portal-prose`
      // together: on a landing the prose is always inside the content block, so both paint, two
      // coats of 0.93 composite to 0.9951, and the scene shows through a prose block at 0.49% -
      // not the 7% the number says - with the inner coat visible as a paler rectangle around the
      // paragraphs. Counted from the paragraph outwards, because that is where the coats land.
      const seen = await page.evaluate(() => {
        const paragraph = document.querySelector(".portal-landing .portal-prose p");
        const coats = [];
        for (let node = paragraph; node && node !== document.body; node = node.parentElement) {
          const colour = getComputedStyle(node).backgroundColor;
          const parts = (colour.match(/[\d.]+/g) ?? []).map(Number);
          const alpha = parts.length === 4 ? parts[3] : colour === "rgba(0, 0, 0, 0)" ? 0 : 1;
          if (alpha > 0) {
            coats.push({
              cls: [...node.classList].find((c) => c.startsWith("portal-")) ?? node.tagName,
              alpha,
            });
          }
        }
        return {
          coats,
          through: +(coats.reduce((acc, c) => acc * (1 - c.alpha), 1) * 100).toFixed(1),
        };
      });
      assert.equal(
        seen.coats.length,
        1,
        `${seen.coats.length} surfaces stack behind a paragraph: ${JSON.stringify(seen.coats)}`,
      );
      assert.ok(
        seen.through >= 10,
        `only ${seen.through}% of the scene reads through a prose block`,
      );
    }),
  );

  await check("body text stays legible over the brightest thing behind a block", async () => {
    // The requirement the surface alphas exist to meet, measured rather than asserted as a
    // number: MUTED body text, over the block's surface composited onto the brightest pixel the
    // scene draws under that block, in both themes. The worst case is the paper-coloured
    // cross-section band under a dark-theme block, which reaches rgb(255,246,234).
    //
    // PHOTOGRAPHING THE SCENE, not reading a canvas: the scene is retained DOM, so "the ground
    // the text sits on" is a composite of gradients, baked sprites and SVG rather than one
    // surface, and `sceneShot` takes the page with everything that is not the scene made
    // invisible. Reading the backdrop canvas instead can sample it before this fixture has
    // painted it, scoring every block against black so the check cannot fail.
    for (const theme of ["light", "dark"]) {
      await open("cosmos", "", { width: 1440, height: 950 }, theme, async (page) => {
        await page.waitForFunction(() => window.__portalCosmos?.geom?.H > 0, null, {
          timeout: 15_000,
        });
        const blocks = await page.evaluate(() => {
          const host = document.querySelector(".portal-landing");
          // The elements that actually CARRY a surface, not the landing's children. A cards row
          // is a transparent wrapper around cards that carry their own, so measuring the wrapper
          // measures an alpha of 0 and reports the raw scene as if text sat on it.
          return [
            ...host.querySelectorAll(
              ".portal-content-block, .portal-admonition, .portal-card, .portal-links li",
            ),
          ]
            .filter((node) => !node.closest(".portal-hero-row"))
            .map((node, index) => {
              node.dataset.probe = String(index);
              const style = getComputedStyle(node);
              const parts = (style.backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
              return {
                index,
                alpha: parts.length === 4 ? parts[3] : 1,
                cls: [...node.classList].find((c) => c.startsWith("portal-")),
              };
            });
        });
        assert.ok(blocks.length > 0, `${theme}: nothing measurable behind a block`);

        const swatches = await page.evaluate(() => {
          const channels = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          const swatch = document.createElement("div");
          swatch.style.position = "fixed";
          swatch.style.left = "-9999px";
          document.body.appendChild(swatch);
          const resolve = (expression) => {
            swatch.style.backgroundColor = expression;
            return channels(getComputedStyle(swatch).backgroundColor);
          };
          const out = { surface: resolve("var(--surface)"), muted: resolve("var(--ink-2)") };
          swatch.remove();
          return out;
        });

        const luminance = (rgb) => {
          const [r, g, b] = rgb.map((c) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const contrast = (a, b) => {
          const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
          return (hi + 0.05) / (lo + 0.05);
        };

        let lowest = null;
        for (const block of blocks) {
          const box = await page.evaluate((i) => {
            const node = document.querySelector(`[data-probe="${i}"]`);
            node.scrollIntoView({ block: "center" });
            const r = node.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, left: r.left, width: r.width };
          }, block.index);
          const shot = await sceneShot(page, { width: 1440, height: 950 });
          const strips = [];
          for (let y = Math.max(2, box.top + 4); y < Math.min(948, box.bottom - 4); y += 12) {
            strips.push({ x: box.left, y, w: box.width });
          }
          if (strips.length === 0) continue;
          const samples = await page.evaluate(SAMPLE_PIXELS, [shot, strips, "light"]);
          let brightest = null;
          for (const px of samples) {
            if (brightest === null || luminance(px) > luminance(brightest)) brightest = px;
          }
          if (!brightest) continue;
          const ground = brightest.map(
            (c, i) => swatches.surface[i] * block.alpha + c * (1 - block.alpha),
          );
          const ratio = +contrast(swatches.muted, ground).toFixed(2);
          if (lowest === null || ratio < lowest.ratio) {
            lowest = { ratio, alpha: block.alpha, scene: brightest, cls: block.cls };
          }
        }
        assert.ok(lowest, `${theme}: nothing measurable behind a block`);
        assert.ok(
          lowest.ratio >= 4.5,
          `${theme}: muted body text measures ${lowest.ratio}:1 on ${lowest.cls} at alpha ${lowest.alpha} over scene rgb(${lowest.scene})`,
        );
      });
    }
  });

  await check("a heading that sits on the scene is lifted off it", async () => {
    // `.portal-cards`, `.portal-links` and `.portal-admonition` put their heading OUTSIDE the
    // panel, which on this preset means on the picture. Measured against the brightest thing
    // drawn under them, those headings run at 3.10:1 in the light theme and 1.47:1 in the dark
    // one - a near-white heading over a cloud, which is invisible. A ring is not a background and
    // WCAG cannot score one, so this asserts the mechanism rather than a ratio: every heading
    // with no surface behind it carries the letterform outline, in the theme's own surface colour
    // so it works in both directions, and every heading that IS on a surface does not - a ring on
    // paper is just a fuzz.
    for (const theme of ["light", "dark"]) {
      await open("cosmos", "", DESKTOP, theme, async (page) => {
        const seen = await page.evaluate(() => {
          const host = document.querySelector(".portal-landing");
          return [...host.children]
            .filter((node) => !node.classList.contains("portal-hero-row"))
            .map((block) => {
              const heading = block.querySelector(":scope > .portal-block-heading");
              if (!heading) return null;
              const colour = getComputedStyle(block).backgroundColor;
              const parts = (colour.match(/[\d.]+/g) ?? []).map(Number);
              const alpha = parts.length === 4 ? parts[3] : colour === "rgba(0, 0, 0, 0)" ? 0 : 1;
              return {
                text: heading.textContent.trim().slice(0, 24),
                surfaced: alpha > 0,
                ring: getComputedStyle(heading).textShadow,
              };
            })
            .filter(Boolean);
        });
        assert.ok(seen.length > 0, `${theme}: no block headings on the landing`);
        for (const heading of seen) {
          if (heading.surfaced) {
            assert.equal(
              heading.ring,
              "none",
              `${theme}: "${heading.text}" is on a surface and still carries a ring`,
            );
          } else {
            assert.ok(
              heading.ring !== "none" && heading.ring.split(",").length >= 8,
              `${theme}: "${heading.text}" sits on the scene with ${heading.ring}`,
            );
          }
        }
      });
    }
  });

  await check("the alphas are spent on the scene, not on an opaque thing inside the block", () =>
    open("cosmos", "", DESKTOP, "light", async (page) => {
      // A card grid painting `--surface-2` across itself with the cards on top, or an admonition
      // as one opaque surface, buys nothing from `--portal-cosmos-card-alpha` on two of the four
      // block kinds a landing can carry, whatever the number says. Nothing between a translucent
      // surface and the canvas may be opaque.
      const opaque = await page.evaluate(() => {
        const host = document.querySelector(".portal-landing");
        const solid = [];
        for (const node of host.querySelectorAll("*")) {
          if (node.closest(".portal-hero-row")) continue;
          // A code sample is deliberately opaque: syntax colour is meaning, not decoration.
          if (node.closest(".portal-code, pre")) continue;
          const colour = getComputedStyle(node).backgroundColor;
          const parts = (colour.match(/[\d.]+/g) ?? []).map(Number);
          const alpha = parts.length === 4 ? parts[3] : colour === "rgba(0, 0, 0, 0)" ? 0 : 1;
          if (alpha < 1) continue;
          // Opaque is only a problem where it covers the scene across a block.
          const box = node.getBoundingClientRect();
          if (box.width < 240 || box.height < 40) continue;
          solid.push({
            cls: [...node.classList].find((c) => c.startsWith("portal-")) ?? node.tagName,
            w: Math.round(box.width),
          });
        }
        return solid;
      });
      assert.deepEqual(
        opaque,
        [],
        `opaque surfaces cover the scene inside a block: ${JSON.stringify(opaque)}`,
      );
    }),
  );

  await check("the story gaps are spacing, not clearance", () =>
    open("cosmos", "", { width: 1440, height: 950 }, "light", async (page) => {
      const seen = await page.evaluate(() => {
        const host = document.querySelector(".portal-landing");
        const kids = [...host.children];
        const gaps = [];
        for (let i = 1; i < kids.length; i += 1) {
          gaps.push(
            Math.round(
              kids[i].getBoundingClientRect().top - kids[i - 1].getBoundingClientRect().bottom,
            ),
          );
        }
        return {
          gaps,
          declared: getComputedStyle(document.documentElement)
            .getPropertyValue("--portal-cosmos-story-gap")
            .trim(),
        };
      });
      // A 54vh gap puts 513px between every pair of blocks on this viewport and 770px after the
      // hero, which is clearance for a scene that cannot be seen through the content. The
      // surfaces above are what buy that instead.
      for (const gap of seen.gaps) {
        assert.ok(gap <= 160, `a gap of ${gap}px between blocks is clearance, not spacing`);
      }
      // And it is not measured in viewport heights. A `vh` gap separates content by a fraction of
      // the WINDOW, so the ratio of scene to content moves with how tall a browser happens to be
      // rather than with what the page holds.
      assert.ok(
        !/vh/.test(seen.declared),
        `the story gap is ${seen.declared}, which follows the window rather than the page`,
      );
    }),
  );

  await check("the heading fits in two or three lines at 1440px", () =>
    open("cosmos", "", DESKTOP, "light", async (page) => {
      const m = await page.evaluate(LANDING_PROBE);
      assert.ok(m.headingLines <= 3, `heading wrapped to ${m.headingLines} lines`);
    }),
  );

  // the veil
  for (const theme of ["light", "dark"]) {
    await check(`the hero has no veil, and its copy carries an outline instead (${theme})`, () =>
      open("cosmos", "", DESKTOP, theme, async (page) => {
        const m = await page.evaluate(LANDING_PROBE);
        // The surface behind the hero copy is a black scrim, the same in both themes. The
        // theme's own `--surface` would be pale in the light theme: a grey slab hanging in a
        // starfield beside two crisp panels. Black at a low alpha is the same substance in both
        // modes because the thing behind it is the same in both modes. It is attached to the copy
        // column, never to the row - on the row it would cover the search box as well, which has
        // a surface of its own.
        assert.equal(m.rowVeil.content, "none", "the hero row draws a surface across both columns");
        assert.notEqual(m.leadVeil.content, "none", "the hero copy has no scrim behind it");
        assert.match(
          m.leadVeilColor,
          /rgba\(0,\s*0,\s*0,\s*0?\.\d+\)/,
          `the hero scrim is not a transparent black: ${m.leadVeilColor}`,
        );

        const ink = (m.headingColor.match(/\d+/g) ?? []).slice(0, 3).map(Number);
        const luminance = (p) => {
          const f = (v) =>
            v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4;
          return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
        };
        assert.ok(luminance(ink) > 0.8, `hero heading ink is ${m.headingColor}, not light`);

        // The ring is what carries the contrast: a soft glow alone measures 1.0:1 against the
        // brightest thing the renderer draws - the sun's limb in light, the moon in dark - and
        // both pass directly behind this copy at some viewport widths.
        const ringOffsets = (m.headingShadow.match(/-?1px/g) ?? []).length;
        assert.ok(ringOffsets >= 12, `hero heading shadow has no ring: ${m.headingShadow}`);
        // Recorded per theme so the check below can compare them.
        measurements[`hero-${theme}`] = {
          scrim: m.leadVeilColor,
          ink: m.headingColor,
          shadow: m.headingShadow,
        };
      }),
    );
  }

  await check("the hero surface is the same in day and in night", () => {
    // The point of a black scrim rather than the theme's surface colour: it does not change with
    // the theme, because the thing behind it does not. If these two ever diverge, someone has
    // reintroduced a per-theme surface and the light one will be pale again.
    const light = measurements["hero-light"];
    const dark = measurements["hero-dark"];
    assert.ok(light && dark, "both themes must be measured before this check");
    assert.equal(light.scrim, dark.scrim, "the hero scrim differs between themes");
    assert.equal(light.ink, dark.ink, "the hero ink differs between themes");
    assert.equal(light.shadow, dark.shadow, "the hero outline differs between themes");
  });

  await check("the scene key is gone, and the canvas still says what it is", () =>
    open("cosmos", "", DESKTOP, "light", async (page) => {
      // There is no scene key, and the statement it would carry - that these are synthetic fields
      // and not an analysis - is drawn by the renderer on the canvas itself, which is the only
      // place it has to be. This check exists so that removing the key can never quietly remove
      // the disclaimer too.
      const present = await page.evaluate(() => ({
        key: !!document.querySelector("[data-portal-cosmos-key]"),
        slot: !!document.querySelector("[data-portal-cosmos-utility]"),
      }));
      assert.equal(present.key, false, "the scene key is still mounted");
      assert.equal(present.slot, false, "the scene key's slot is still emitted");
      const drawn = await page.evaluate(() => window.__portalCosmos?.geom?.H > 0);
      assert.ok(drawn, "the scene is not running");
    }),
  );

  await check("a short landing gets a short story, and the scene fits it", () =>
    open("cosmos", "", DESKTOP, "light", async (page) => {
      await page.waitForFunction(() => window.__portalCosmos?.geom?.H > 0, null, {
        timeout: 15_000,
      });
      const m = await page.evaluate(LANDING_PROBE);
      const b = m.bands;
      assert.ok(b, "the scene published no geometry");

      // This fixture's landing is short on purpose - a hero, a search box, one row of cards - and
      // that is the case this has to get right, because it is the ordinary one. A floor padding
      // it out costs the page: at 3.45 screens, the renderer's own minimum for a readable
      // transect, the run BELOW THE LAST BLOCK measures 1972px at this viewport - 2.19 screens,
      // three times the whole ocean band - and a reader scrolls all of it having finished the
      // content. The floor says only "enough page to scroll the story": two viewports, the clamp
      // the engine already applies to its own story height. The scene fits what it is given.
      assert.ok(m.storyScreens < 2.6, `a short landing came out ${m.storyScreens} screens long`);
      assert.ok(
        m.tail.screens < 0.75,
        `${m.tail.px}px of empty story below the last block (${m.tail.screens} screens)`,
      );
      // The ending is still an ending: the story finishes on water rather than flush against the
      // last block.
      assert.ok(m.tail.px > 120, `the last block ends ${m.tail.px}px above the story's bottom`);

      // And the compression is shared. Below every band's minimum at once the allocator scales
      // the three together rather than starving one, so the transect keeps its full span from
      // 50 hPa to the ocean floor and is drawn at a smaller aspect. The three ratios are the
      // assertion: a starved band would show up as one ratio well below the others.
      const ratios = [b.cosmos / 1.1, b.section / 1.6, b.ocean / 0.72];
      const spread = Math.max(...ratios) - Math.min(...ratios);
      assert.ok(
        spread < 0.02,
        `the bands were not scaled together: ${ratios.map((r) => r.toFixed(3)).join(", ")}`,
      );

      // The three of them, the gap above the chart and the tail below the seafloor are the story.
      const sum = b.cosmos + b.section + b.ocean;
      assert.ok(
        Math.abs(b.story - sum - 0.03 - b.bottom / b.h) < 0.01,
        `the bands (${sum}) do not add up to the story (${b.story})`,
      );
    }),
  );

  await check("the daylit sky is a sky, not the night sky with a Sun in it", async () => {
    // The two themes swap the luminary - a Sun by day, a Moon by night, deliberately offset so
    // the switch does not read as "the Sun turned grey" - and for the top half of the cosmos band
    // the gradients behind them must not be within a few units of each other: (10,18,32) by day
    // against (1,2,5) by night at the zenith, or (14,26,43) against (3,5,12) a third of the way
    // down, is black either way on a screen, and a reader who switches theme sees the sky not
    // change.
    //
    // Sampled from a photograph of the scene alone - see `sceneShot` - at three heights in the
    // upper band, well away from the luminary's own corner, each one scrolled into view first so
    // the row is a row a reader could be looking at. The day sky must be measurably lighter AND
    // measurably bluer - a lift alone would be grey - and the zenith must still be dark enough
    // for the star field that is drawn over it.
    const fracs = [0.06, 0.3, 0.52];
    const MID = 420;
    const read = async (theme) => {
      const out = [];
      await open("cosmos", "", DESKTOP, theme, async (page) => {
        await page.waitForFunction(() => window.__portalCosmos?.geom?.H > 0, null, {
          timeout: 15_000,
        });
        const geom = await page.evaluate(() => window.__portalCosmos.geom);
        for (const f of fracs) {
          const storyY = geom.spaceEnd * f;
          await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, Math.round(storyY - MID)));
          await page.waitForTimeout(120);
          const top = await page.evaluate(() => window.scrollY);
          const shot = await sceneShot(page, DESKTOP);
          const [px] = await page.evaluate(SAMPLE_PIXELS, [
            shot,
            [{ x: DESKTOP.width * 0.42, y: storyY - top, w: 48 }],
            "dark",
          ]);
          out.push(px);
        }
      });
      return out;
    };
    const day = await read("light");
    const night = await read("dark");
    assert.ok(day.length === 3 && night.length === 3, "the scene published no sky to read");
    day.forEach((d, i) => {
      const n = night[i];
      const lift = d[0] + d[1] + d[2] - (n[0] + n[1] + n[2]);
      // 75, not "brighter than night". A gradient 54-63 lighter than the night one at these
      // heights still looks identical on a screen, which is the whole complaint; a threshold
      // under that would pass the thing being measured.
      assert.ok(lift >= 75, `at ${fracs[i]} of the band the day sky is only ${lift} lighter`);
      // And the lift is blue. 28-31 of blue over the night sky is a grey wash; this asks for the
      // separation to be in the channel that makes it a sky.
      assert.ok(
        d[2] - n[2] >= 40 && d[2] >= d[0] * 2 && d[2] > d[1],
        `at ${fracs[i]} the day sky is rgb(${d.join(",")}) over a night rgb(${n.join(",")})`,
      );
    });
    // ... and the zenith is still a place stars can be seen against.
    assert.ok(day[0][0] + day[0][1] + day[0][2] < 200, `the zenith is rgb(${day[0].join(",")})`);
  });

  // the fixed chrome
  for (const [label, path] of [
    ["landing", ""],
    ["documentation", "docs/guide/"],
  ]) {
    await check(`the header and footer stay fixed on the ${label} route`, () =>
      open("cosmos", path, DESKTOP, "light", async (page) => {
        const probe = path === "" ? LANDING_PROBE : DOC_PROBE;
        const m = await page.evaluate(probe);
        assert.equal(m.headerPosition, "fixed", `header is ${m.headerPosition}`);
        assert.equal(m.footerPosition, "fixed", `footer is ${m.footerPosition}`);
        // A fixed footer bar is at the bottom of the viewport and spans it.
        assert.ok(
          Math.abs(m.footerRect.y + m.footerRect.h - 900) <= 2,
          `footer bottom is at ${m.footerRect.y + m.footerRect.h}`,
        );
        assert.equal(m.footerRect.w, 1440, `footer is ${m.footerRect.w}px wide`);
      }),
    );
  }

  await check("the badge sits in the footer bar rather than alone above it", () =>
    open("cosmos", "", DESKTOP, "light", async (page) => {
      const m = await page.evaluate(LANDING_PROBE);
      assert.ok(m.badgeRect, "no badge anchor on the page");
      // The badge is fixed in the overlay layer and overhangs the bar by design. What must not
      // happen is the bar leaving the viewport underneath it: the badge's own bottom edge has to
      // be inside the footer's band.
      const footerBottom = m.footerRect.y + m.footerRect.h;
      assert.ok(
        m.badgeRect.y + m.badgeRect.h <= footerBottom + 4,
        `badge ends at ${m.badgeRect.y + m.badgeRect.h}, footer at ${footerBottom}`,
      );
    }),
  );

  await check("the calls to action are above the footer in the first viewport", () =>
    open("cosmos", "", DESKTOP, "light", async (page) => {
      const m = await page.evaluate(LANDING_PROBE);
      assert.ok(m.ctaBottom > 0, "the call to action is above the fold's top");
      assert.ok(
        m.ctaBottom < m.footerTop,
        `the last call to action ends at ${m.ctaBottom}, under the footer at ${m.footerTop}`,
      );
      // And the lead-in above it is bounded.
      assert.ok(
        parseFloat(m.landingPadTop) <= 80,
        `story lead is ${m.landingPadTop}, which is most of a screen`,
      );
    }),
  );

  // the document
  for (const theme of ["light", "dark"]) {
    await check(`a documentation page is an ordinary document (${theme})`, () =>
      open("cosmos", "docs/guide/", DESKTOP, theme, async (page, requests) => {
        const m = await page.evaluate(DOC_PROBE);
        measurements[`docs-1440x900-${theme}`] = m;
        assert.equal(m.backdrop, null, `the shell declares data-backdrop="${m.backdrop}"`);
        assert.equal(m.shellBackgroundImage, "none", `the shell paints ${m.shellBackgroundImage}`);
        // Transparent prose: no Cosmos slab behind the text.
        assert.ok(
          /rgba\(0, 0, 0, 0\)|transparent/.test(m.proseBackground),
          `prose sits on ${m.proseBackground}`,
        );
        assert.equal(m.canvas, false, "the scene canvas is on a documentation page");
        assert.equal(m.sceneKey, false, "the Scene key is on a documentation page");
        // Scene bodies only. Matching every `.webp` would catch the Freva badge's own artwork,
        // which every route legitimately loads.
        const scene = requests.filter((u) =>
          /_cosmos\/|sat-|sonde-|research-|airliner|surface-buoy/.test(u),
        );
        assert.deepEqual(scene, [], `scene assets were requested: ${scene.join(", ")}`);
      }),
    );
  }

  await check("the documentation layout matches the preset that has no backdrop", () =>
    (async () => {
      const read = async (preset) => {
        let value;
        await open(preset, "docs/guide/", DESKTOP, "light", async (page) => {
          value = await page.evaluate(DOC_PROBE);
        });
        return value;
      };
      const cosmos = await read("cosmos");
      const waterpark = await read("waterpark");
      // Same document geometry on both presets. A preset may change colour; it may not change
      // where the text and the contents list are.
      assert.deepEqual(cosmos.documentRect, waterpark.documentRect, "document rectangle moved");
      assert.deepEqual(cosmos.tocRect, waterpark.tocRect, "contents list moved");
      assert.equal(cosmos.headerPosition, waterpark.headerPosition);
      assert.equal(cosmos.footerPosition, waterpark.footerPosition);
    })(),
  );

  // the viewports
  for (const [label, viewport] of [
    ["1110x881", LAPTOP],
    ["390x844", PHONE],
  ]) {
    await check(`the landing has no horizontal overflow at ${label}`, () =>
      open("cosmos", "", viewport, "light", async (page) => {
        const m = await page.evaluate(LANDING_PROBE);
        measurements[`landing-${label}-light`] = m;
        assert.equal(m.overflow, 0, `${m.overflow}px of horizontal overflow`);
      }),
    );
  }

  await check("the hero stacks on a phone instead of squeezing two columns", () =>
    open("cosmos", "", PHONE, "light", async (page) => {
      const m = await page.evaluate(LANDING_PROBE);
      assert.ok(
        m.heroAside.y >= m.heroLead.y + m.heroLead.h - 4,
        `aside at ${m.heroAside.y} overlaps the lead ending at ${m.heroLead.y + m.heroLead.h}`,
      );
      assert.ok(m.heroAside.w > 280, `aside is ${m.heroAside.w}px on a 390px phone`);
    }),
  );

  // the scene
  await check("the scene is still drawn at full strength", () =>
    open("cosmos", "", DESKTOP, "light", async (page) => {
      const m = await page.evaluate(LANDING_PROBE);
      assert.equal(m.canvasOpacity, "1", `canvas opacity is ${m.canvasOpacity}`);
      assert.ok(
        m.canvasFilter === "none" || !m.canvasFilter.includes("blur"),
        `canvas filter is ${m.canvasFilter}`,
      );
    }),
  );

  await check("a preset with no backdrop is untouched by any of this", () =>
    open("waterpark", "", DESKTOP, "light", async (page) => {
      const m = await page.evaluate(LANDING_PROBE);
      measurements["waterpark-landing-1440x900-light"] = m;
      assert.equal(m.headerPosition, "fixed");
      assert.equal(m.footerPosition, "fixed");
      assert.equal(m.rowVeil.content, "none", "a hero surface appeared on a preset with no scene");
      assert.equal(m.leadVeil.content, "none", "a hero surface appeared on a preset with no scene");
      assert.equal(m.canvasOpacity, null, "a canvas appeared on a preset with no scene");
      assert.ok(m.heroRow.w > 1100, `hero row is ${m.heroRow.w}px wide`);
    }),
  );

  // screenshots
  for (const [label, viewport] of [
    ["1440x900", DESKTOP],
    ["1110x881", LAPTOP],
    ["390x844", PHONE],
  ]) {
    for (const theme of ["light", "dark"]) {
      await check(`landing photographed at ${label} (${theme})`, () =>
        open("cosmos", "", viewport, theme, async (page) => {
          await page.screenshot({ path: join(OUT, `landing-${label}-${theme}.png`) });
        }),
      );
      await check(`documentation photographed at ${label} (${theme})`, () =>
        open("cosmos", "docs/guide/", viewport, theme, async (page) => {
          await page.screenshot({ path: join(OUT, `docs-${label}-${theme}.png`) });
        }),
      );
    }
  }
} finally {
  await browser.close();
  for (const server of Object.values(servers)) server.close();
}

writeFileSync(join(OUT, "layout-measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} cosmos layout checks passed`);
console.log(`measurements and screenshots in ${OUT}`);
process.exit(failed.length > 0 ? 1 : 0);
