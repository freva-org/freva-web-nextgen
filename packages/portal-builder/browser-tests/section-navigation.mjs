// Section navigation, driven in a real browser.
//
// Everything a unit test can settle about this feature is settled in
// `tests/model/section-navigation.test.ts`: the membership rules, the ordering, the title
// derivation, the markup. What is left is what only a browser knows. Does the rail actually sit
// beside the document and stay there while the page scrolls, without colliding with the fixed
// header or the fixed footer? Does the document stay the dominant area? Does a phone get the list
// in normal flow with no horizontal overflow? Does the long-section disclosure work with
// JavaScript switched off entirely? And does axe find anything, in both themes, on the page that
// has both groups?
//
// Usage:  node browser-tests/section-navigation.mjs [out-dir]

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const OUT = resolve(process.argv[2] ?? join(tmpdir(), "section-nav-shots"));
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

const front = (title) => `---\ntitle: ${JSON.stringify(title)}\n---\n\n`;
const body = (paragraphs) =>
  Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i + 1} of the document.`).join("\n\n");

/**
 * Three directories, each testing one shape of rail:
 *
 *   `concepts/`  three pages, one with no headings at all - the case that must not cost the
 *                whole left column;
 *   `long/`      nine pages, so the narrow layout gets its native disclosure;
 *   `alone.md`   a single page, which must keep the centred document with no gutter.
 */
function writeFixture() {
  const root = mkdtempSync(join(tmpdir(), "secnav-browser-"));
  const put = (rel, content) => {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);

  put(
    "content/concepts/index.md",
    `${front("HEALPix in Zarr on S3")}A short section introduction with no headings at all.\n`,
  );
  put(
    "content/concepts/why-healpix.md",
    `${front("Why HEALPix?")}${body(2)}\n\n## Equal-area pixels\n\n${body(6)}\n\n## A natural multi-resolution hierarchy\n\n${body(6)}\n\n## No pole singularity\n\n${body(8)}\n\n## Choosing the target level\n\n${body(8)}\n`,
  );
  put(
    "content/concepts/zarr-and-s3.md",
    `${front("Why Zarr and S3?")}${body(2)}\n\n## Chunks\n\n${body(4)}\n\n## Object storage\n\n${body(4)}\n`,
  );

  for (let i = 1; i <= 9; i += 1) {
    put(
      `content/long/${i === 1 ? "index" : `page-${String(i).padStart(2, "0")}`}.md`,
      `${front(i === 1 ? "Long section" : `Page ${i}`)}${body(3)}\n`,
    );
  }
  put("content/alone.md", `${front("Alone")}${body(3)}\n\n## One heading\n\n${body(3)}\n`);

  put(
    "landings/home.yaml",
    `schemaVersion: 1
title: Section Navigation
blocks:
  - type: hero
    heading: A portal with a documentation section
`,
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: secnav
  title: Section Navigation
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: default
rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
landings:
  home:
    path: /
    source: ./landings/home.yaml
`,
  );

  const out = join(root, "..", `secnav-site-${process.pid}`);
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

const SITE = writeFixture();

// server

const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
const server = createPreviewServer({ dir: SITE, port: 0 });
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}/`;

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
  server.close();
  const message = `chromium would not launch: ${error.message}`;
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1440, height: 900 };
const LAPTOP = { width: 1110, height: 881 };
const PHONE = { width: 390, height: 844 };
const measurements = {};
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${String(error.message).replace(/\n/g, "\n       ")}`);
  }
}

async function withPage(path, theme, viewport, fn, options = {}) {
  const context = await browser.newContext({ viewport, javaScriptEnabled: options.js !== false });
  await context.route(`${base}__axe-core.js`, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: AXE }),
  );
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (event) => problems.push(String(event)));
  if (options.js !== false) {
    await page.addInitScript((mode) => {
      try {
        localStorage.setItem("freva.portal.theme", mode);
      } catch {
        // a context that refuses storage still renders the light theme
      }
    }, theme);
  }
  try {
    await page.goto(base + path, { waitUntil: "networkidle" });
    if (options.js !== false) {
      const applied = await page.evaluate(() => document.documentElement.dataset.theme);
      assert.equal(applied, theme, `asked for ${theme}, got ${applied}`);
    }
    await fn(page, { problems });
  } finally {
    await context.close();
  }
}

// Whether an element is actually on the screen.
//
// Not `getBoundingClientRect().height > 0`. A closed `<details>` hides its content through
// `::details-content`, which is `content-visibility: hidden` - the subtree is not painted and not
// hit-testable, but its layout is PRESERVED, so a rect probe reports a 302px-tall list nobody can
// see, and a check for "the closed section shows no list" would really be measuring whichever
// author `display: none` rule happened to zero the rect. `checkVisibility()` answers the question
// actually being asked, including for a `content-visibility: hidden` ancestor.
const isVisible = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return Boolean(
      el &&
      el.checkVisibility({
        contentVisibilityAuto: true,
        opacityProperty: true,
        visibilityProperty: true,
      }),
    );
  }, selector);

async function axeOn(page, label) {
  await page.addScriptTag({ url: `${base}__axe-core.js` });
  const run = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return result.violations.map((v) => `${v.id}: ${v.nodes.length}`);
  });
  assert.deepEqual(run, [], `${label}: ${run.join(" | ")}`);
}

try {
  await check("the rail sits beside the document, and the document dominates", () =>
    withPage("docs/concepts/why-healpix/", "light", DESKTOP, async (page) => {
      const seen = await page.evaluate(() => {
        const rail = document.querySelector(".portal-doc-rail").getBoundingClientRect();
        const doc = document.querySelector(".portal-document").getBoundingClientRect();
        const header = document.querySelector(".portal-header").getBoundingClientRect();
        return {
          railLeft: rail.left,
          railWidth: rail.width,
          railTop: rail.top,
          docLeft: doc.left,
          docWidth: doc.width,
          headerBottom: header.bottom,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
      measurements.desktop = seen;
      assert.ok(seen.railLeft < seen.docLeft, "the rail is not to the left of the document");
      // The document is the page. A rail that took half the width would be a second document.
      assert.ok(
        seen.docWidth > seen.railWidth * 3,
        `document ${Math.round(seen.docWidth)} vs rail ${Math.round(seen.railWidth)}`,
      );
      assert.ok(seen.railTop >= seen.headerBottom - 1, "the rail starts under the fixed header");
      assert.equal(seen.scrollWidth, seen.innerWidth, "the page scrolls sideways");
    }),
  );

  await check("the rail stays put while the page scrolls, and never covers the footer", () =>
    withPage("docs/concepts/why-healpix/", "light", DESKTOP, async (page) => {
      const before = await page.evaluate(
        () => document.querySelector(".portal-doc-rail").getBoundingClientRect().top,
      );
      await page.evaluate(() => window.scrollTo(0, 1200));
      await page.waitForTimeout(200);
      const seen = await page.evaluate(() => {
        const rail = document.querySelector(".portal-doc-rail").getBoundingClientRect();
        const header = document.querySelector(".portal-header").getBoundingClientRect();
        const badge = document.querySelector(".freva-badge, .portal-footer");
        return {
          top: rail.top,
          bottom: rail.bottom,
          headerBottom: header.bottom,
          badgeTop: badge ? badge.getBoundingClientRect().top : Number.POSITIVE_INFINITY,
          viewport: window.innerHeight,
        };
      });
      measurements.sticky = { before, ...seen };
      // Sticky, and pinned below the header at its full height so it does not move when the
      // header shrinks on scroll.
      assert.ok(seen.top >= seen.headerBottom - 1, `rail top ${seen.top} is under the header`);
      assert.ok(seen.top < before + 4, "the rail scrolled away with the document");
      // And it stops before the fixed footer and the badge that sits above it.
      assert.ok(seen.bottom <= seen.viewport + 1, "the rail runs past the bottom of the viewport");
    }),
  );

  await check("one scroll region, not two nested ones", () =>
    withPage("docs/concepts/why-healpix/", "light", DESKTOP, async (page) => {
      const scrollers = await page.evaluate(() => {
        const inside = [
          ".portal-doc-rail",
          ".portal-section-nav",
          ".portal-section-nav-list",
          ".portal-toc",
          ".portal-toc-list",
        ];
        return inside.filter((selector) => {
          const node = document.querySelector(selector);
          if (!node) return false;
          const style = getComputedStyle(node);
          return style.overflowY === "auto" || style.overflowY === "scroll";
        });
      });
      // The rail scrolls. Nothing inside it does, because a box inside a box inside a 16rem gutter
      // is a thing a pointer gets stuck in and a keyboard cannot reach the bottom of.
      assert.deepEqual(scrollers, [".portal-doc-rail"], `scrollers: ${scrollers.join(", ")}`);
    }),
  );

  await check("the current page is marked once, and marked visibly", () =>
    withPage("docs/concepts/why-healpix/", "light", DESKTOP, async (page) => {
      const seen = await page.evaluate(() => {
        const current = document.querySelector('.portal-section-nav-link[aria-current="page"]');
        const other = [...document.querySelectorAll(".portal-section-nav-link")].find(
          (a) => a !== current,
        );
        return {
          count: document.querySelectorAll('[aria-current="page"]').length,
          text: current?.textContent.trim(),
          currentWeight: getComputedStyle(current).fontWeight,
          currentColour: getComputedStyle(current).color,
          otherWeight: getComputedStyle(other).fontWeight,
          otherColour: getComputedStyle(other).color,
          currentBorder: getComputedStyle(current).borderLeftColor,
          otherBorder: getComputedStyle(other).borderLeftColor,
        };
      });
      measurements.current = seen;
      assert.equal(seen.count, 1);
      assert.equal(seen.text, "Why HEALPix?");
      // Distinguished by more than one channel, so it survives a colour deficiency.
      assert.notEqual(seen.currentWeight, seen.otherWeight, "the current page is not set heavier");
      assert.notEqual(seen.currentColour, seen.otherColour, "the current page is not recoloured");
      assert.notEqual(seen.currentBorder, seen.otherBorder, "the current page has no marker");
    }),
  );

  await check("the section survives a page with no headings at all", () =>
    withPage("docs/concepts/", "light", DESKTOP, async (page) => {
      const seen = await page.evaluate(() => ({
        rail: Boolean(document.querySelector(".portal-doc-rail")),
        section: document.querySelectorAll(".portal-section-nav-link").length,
        toc: document.querySelectorAll(".portal-toc-link").length,
        railWidth: document.querySelector(".portal-doc-rail")?.getBoundingClientRect().width,
      }));
      assert.ok(seen.rail, "the rail vanished on the section introduction");
      assert.equal(seen.section, 3);
      assert.equal(seen.toc, 0);
      assert.ok(seen.railWidth > 100, "the rail is present but has no width");
    }),
  );

  await check("a page with neither group keeps the centred document and no empty gutter", () =>
    withPage("docs/alone/", "light", DESKTOP, async (page) => {
      const seen = await page.evaluate(() => {
        const layout = document.querySelector(".portal-doc-layout");
        const doc = document.querySelector(".portal-document").getBoundingClientRect();
        return {
          rail: Boolean(document.querySelector(".portal-doc-rail")),
          railFlag: layout.dataset.rail,
          display: getComputedStyle(layout).display,
          docLeft: doc.left,
          docWidth: doc.width,
          innerWidth: window.innerWidth,
        };
      });
      measurements.bare = seen;
      // `alone.md` is the only file in the content root, so there is no section, and its single
      // heading is below the contents list's two-entry floor. Neither group has anything to say,
      // so the layout is the centred column, not a centred column with an empty 16rem gutter.
      assert.equal(seen.railFlag, "false");
      assert.equal(seen.rail, false, "an empty rail was drawn");
      assert.notEqual(seen.display, "grid", "the two-column grid was applied with nothing in it");
      // Centred: the same gap either side.
      const right = seen.innerWidth - (seen.docLeft + seen.docWidth);
      assert.ok(
        Math.abs(right - seen.docLeft) < 2,
        `document is off-centre by ${right - seen.docLeft}px`,
      );
    }),
  );

  await check("on a phone the outline is in the bar, and works with no JavaScript at all", () =>
    withPage(
      "docs/long/",
      "light",
      PHONE,
      async (page) => {
        // The rail is a desktop column; every narrower width gets the breadcrumb bar under the
        // header instead, rather than a boxed list above the article - a full screen of contents
        // before the first sentence. Either way the outline is real without script: the bar's
        // disclosure is a native `<details>`, so it opens, takes focus and is in the accessibility
        // tree before any island loads, which is what running this with JavaScript disabled proves.
        const bar = await page.evaluate(() => {
          const menu = document.querySelector(".portal-outlinebar-menu");
          const summary = document.querySelector(".portal-outlinebar-button");
          return {
            present: Boolean(menu),
            tag: menu ? menu.tagName.toLowerCase() : null,
            summaryTag: summary ? summary.tagName.toLowerCase() : null,
            open: menu ? menu.open : null,
            links: document.querySelectorAll(".portal-outlinebar-item").length,
          };
        });
        assert.equal(bar.present, true, "no outline bar on a phone");
        assert.equal(bar.tag, "details", "the disclosure is not a native one");
        assert.equal(bar.summaryTag, "summary", "the control is not a native summary");
        assert.equal(bar.open, false, "the outline arrived open, covering the page");
        assert.ok(bar.links >= 9, `only ${bar.links} outline links`);

        // The rail is not drawn as well: one outline on the screen, not two.
        assert.equal(await isVisible(page, ".portal-doc-rail"), false, "the rail is still drawn");

        await page.locator(".portal-outlinebar-button").click();
        await page.waitForTimeout(150);
        const open = await page.evaluate(
          () => document.querySelector(".portal-outlinebar-menu").open,
        );
        assert.equal(open, true, "the control did not open");
        assert.equal(
          await isVisible(page, ".portal-outlinebar-panel"),
          true,
          "an open disclosure shows no list",
        );
      },
      { javaScriptEnabled: false },
    ),
  );

  await check("the disclosure's state is the state that is on the screen", () =>
    withPage("docs/long/", "light", DESKTOP, async (page) => {
      // A `<details>` whose content is revealed by a stylesheet rather than by its own `open`
      // state tells two stories at once: the list is on the screen and the control announces
      // itself as collapsed. Activating it then reports a state change with no visible change at
      // all - worse than no control, because a reader operating it by keyboard or with a screen
      // reader is told something happened and cannot find what.
      const seen = {
        open: await page.evaluate(() => document.querySelector(".portal-section-nav-body").open),
        listVisible: await isVisible(page, ".portal-section-nav-list"),
      };
      assert.equal(seen.listVisible, true, "a long section is not shown on a desktop");
      assert.equal(
        seen.open,
        true,
        "the list is on the screen while the control says it is closed",
      );

      // And the control has to do something. Collapsing it must remove the list from the page.
      await page.locator("summary.portal-section-nav-title").click();
      await page.waitForTimeout(150);
      const after = {
        open: await page.evaluate(() => document.querySelector(".portal-section-nav-body").open),
        listVisible: await isVisible(page, ".portal-section-nav-list"),
      };
      assert.equal(after.open, false, "the control did not close");
      assert.equal(after.listVisible, false, "collapsing it changed nothing on the screen");
    }),
  );

  await check("a three-page section reaches the phone outline in full", () =>
    withPage("docs/concepts/", "light", PHONE, async (page) => {
      // Every sibling page is in the bar's dropdown; nothing is dropped for want of room.
      const seen = await page.evaluate(() => {
        document.querySelector(".portal-outlinebar-menu").open = true;
        const block = document.querySelector(".portal-outlinebar-block");
        return {
          pages: block ? block.querySelectorAll(".portal-outlinebar-item").length : 0,
          title: block
            ? block.querySelector(".portal-outlinebar-blocktitle").textContent.trim()
            : null,
        };
      });
      assert.equal(seen.pages, 3);
      assert.ok(seen.title && seen.title.length > 0, "the page group has no name");
    }),
  );

  await check("on a phone the outline bar leads the document and never covers it", () =>
    withPage("docs/concepts/why-healpix/", "light", PHONE, async (page) => {
      const seen = await page.evaluate(() => {
        const bar = document.querySelector(".portal-outlinebar").getBoundingClientRect();
        const doc = document.querySelector(".portal-document").getBoundingClientRect();
        return {
          barHeight: Math.round(bar.height),
          barBottom: Math.round(bar.bottom),
          docTop: Math.round(doc.top),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
      measurements.phone = seen;
      // The bar is a BAR: one row, not a panel. The point of putting the outline here is that a
      // reader meets the document immediately, so anything approaching a screenful defeats it.
      assert.ok(seen.barHeight <= 96, `the outline bar is ${seen.barHeight}px tall`);
      assert.ok(seen.barBottom <= seen.docTop + 1, "the bar overlaps the document");
      assert.equal(seen.scrollWidth, seen.innerWidth, "the phone layout scrolls sideways");
    }),
  );

  await check("at 200% zoom the rail neither overlaps nor hides the document", () =>
    withPage("docs/concepts/why-healpix/", "light", DESKTOP, async (page) => {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await page.waitForTimeout(200);
      const seen = await page.evaluate(() => {
        const rail = document.querySelector(".portal-doc-rail").getBoundingClientRect();
        const doc = document.querySelector(".portal-document").getBoundingClientRect();
        return {
          overlap: rail.right > doc.left + 1 && rail.bottom > doc.top + 1 && rail.top < doc.bottom,
          docVisible: doc.width > 200,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
      assert.equal(seen.overlap, false, "the rail overlaps the document at 200%");
      assert.ok(seen.docVisible, "the document is not readable at 200%");
      assert.equal(seen.scrollWidth, seen.innerWidth, "200% zoom scrolls the page sideways");
    }),
  );

  await check("every outline target is comfortable on a touch screen", () =>
    withPage("docs/concepts/why-healpix/", "light", PHONE, async (page) => {
      // Measured on the OUTLINE BAR, which is what a phone actually has - the rail is a desktop
      // column and reports zero height here. The control that opens the outline is measured too:
      // on a phone it is the only way in, and a 34px pill is a pointer's target, not a thumb's.
      const seen = await page.evaluate(() => {
        const opener = document.querySelector(".portal-outlinebar-button").getBoundingClientRect();
        document.querySelector(".portal-outlinebar-menu").open = true;
        return {
          opener: Math.round(opener.height),
          items: [...document.querySelectorAll(".portal-outlinebar-item")].map((a) =>
            Math.round(a.getBoundingClientRect().height),
          ),
        };
      });
      measurements.touch = seen;
      assert.ok(seen.opener >= 44, `the outline opener is only ${seen.opener}px tall`);
      assert.ok(seen.items.length > 0, "the outline has no items to measure");
      for (const height of seen.items) assert.ok(height >= 40, `an item is only ${height}px tall`);
    }),
  );

  await check("keyboard focus reaches every section link and is visible", () =>
    withPage("docs/concepts/why-healpix/", "light", DESKTOP, async (page) => {
      let reached = 0;
      let outlined = 0;
      for (let i = 0; i < 30 && reached < 3; i += 1) {
        await page.keyboard.press("Tab");
        const state = await page.evaluate(() => {
          const active = document.activeElement;
          if (!active?.classList?.contains("portal-section-nav-link")) return null;
          const style = getComputedStyle(active);
          return { outline: style.outlineStyle, width: style.outlineWidth };
        });
        if (state) {
          reached += 1;
          if (state.outline !== "none" && Number.parseFloat(state.width) > 0) outlined += 1;
        }
      }
      assert.equal(reached, 3, `tabbing reached ${reached} of 3 section links`);
      assert.equal(outlined, 3, "a focused section link has no visible ring");
    }),
  );

  for (const [theme, path, label] of [
    ["light", "docs/concepts/why-healpix/", "both groups, light"],
    ["dark", "docs/concepts/why-healpix/", "both groups, dark"],
    ["light", "docs/concepts/", "section only, light"],
    ["dark", "docs/long/", "long section, dark"],
  ]) {
    await check(`axe finds no violations (${label})`, () =>
      withPage(path, theme, DESKTOP, (page) => axeOn(page, label)),
    );
  }

  for (const [theme, viewport, name] of [
    ["light", DESKTOP, "1440x900"],
    ["dark", DESKTOP, "1440x900"],
    ["light", LAPTOP, "1110x881"],
    ["dark", LAPTOP, "1110x881"],
    ["light", PHONE, "390x844"],
    ["dark", PHONE, "390x844"],
  ]) {
    await check(`it is photographed at ${name}, ${theme}`, () =>
      withPage("docs/concepts/why-healpix/", theme, viewport, async (page) => {
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(OUT, `section-nav-${theme}-${name}.png`) });
      }),
    );
  }
} finally {
  writeFileSync(join(OUT, "measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
  await browser.close();
  server.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} section-navigation browser checks passed`);
if (passed !== results.length) process.exit(1);
