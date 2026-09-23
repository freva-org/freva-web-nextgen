// The responsive header, driven in a real browser.
//
// Two levels of navigation have to collapse below desktop, and only a real browser can settle
// whether they do. The unit tests settle the markup; the questions left are measurements. Does
// the header actually fit its tabs at a tablet width instead of hiding all of them behind one
// button? Does the overflow control appear only when something has overflowed, and does the
// header ever wrap onto a second line or crowd the brand? Does the phone panel really cover the
// page, drill into a section, and come back? Is the outline reachable at every width below the
// desktop rail - including with JavaScript switched off? And does axe find anything, in both
// themes, at each width?
//
// Usage:  node browser-tests/nav-responsive.mjs [out-dir]

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
const OUT = resolve(process.argv[2] ?? join(tmpdir(), "nav-responsive-shots"));
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
  const root = mkdtempSync(join(tmpdir(), "navresp-browser-"));
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
  id: navresp
  title: Waterpark
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
  subtitle: The HEALPix data hub on S3
theme:
  preset: waterpark
  tokens:
    colorAccent: "#009688"
navigation:
  header:
    - landing: home
      label: Home
    - href: /docs/concepts/
      label: Documentation
chrome:
  header:
    enabled: true
    links:
      - label: Data Browser
        href: /docs/long/page-02/
      - label: STAC Browser
        href: /docs/long/
      - label: Remapping and benchmark
        href: /docs/alone/
      - label: Downloads
        href: /docs/concepts/zarr-and-s3/
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

  const out = join(root, "..", `navresp-site-${process.pid}`);
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
const TABLET = { width: 834, height: 1000 };
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

async function axeOn(page, label) {
  await page.addScriptTag({ url: `${base}__axe-core.js` });
  const run = await page.evaluate(async () => {
    // The header chrome, the footer and the Freva badge are EXCLUDED, and only those. This
    // deployment's accent is #009688, and white on it is 3.67:1 - a known, recorded AA failure of
    // the brand colour itself, owned by `tests/contracts/chrome-contrast.test.ts` and by the
    // deployment note that chose that colour. The footer and the badge fail the same way for the
    // same reason and belong to their own packages. Absorbing them here would make this suite
    // fail for something it cannot fix; ignoring contrast entirely would let a real one through.
    // So they are excluded BY SELECTOR and everything this suite owns - the phone panel, the
    // outline bar, the document - is held to the full standard. The panel is why that matters: a
    // slim band's accepted 3.67:1 must not be extended across a full screen of navigation.
    const result = await window.axe.run(
      { exclude: [[".portal-header"], [".portal-footer"], [".freva-badge"], [".badge"]] },
      { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } },
    );
    return result.violations.flatMap((v) =>
      v.nodes
        .slice(0, 3)
        .map(
          (n) => `${v.id} :: ${n.target.join(" ")} :: ${(n.any[0]?.message ?? "").slice(0, 90)}`,
        ),
    );
  });
  assert.deepEqual(run, [], `${label}: ${run.join(" | ")}`);
}

try {
  // tablet: priority+

  await check("at a tablet width the header shows tabs, not one Menu button", () =>
    withPage("docs/concepts/why-healpix/", "light", TABLET, async (page) => {
      const seen = await page.evaluate(() => {
        const visible = (el) => el.getBoundingClientRect().height > 0;
        const tabs = [...document.querySelectorAll(".portal-nav-li")].filter(visible);
        const more = document.querySelector(".portal-more-button");
        const compact = document.querySelector(".portal-compact-button");
        return {
          tabs: tabs.map((li) => li.textContent.trim()),
          moreHidden: more.hidden,
          moreText: more.textContent.trim(),
          compactHidden: compact.hidden,
        };
      });
      measurements.tablet = seen;
      // `COMPACT_BREAKPOINT` must not swallow tablet widths: at 1120 every viewport under a
      // desktop hides ALL of its tabs behind `Menu`, leaving 834px a logo and one button with
      // room for four tabs going spare. Compact is for the width where no tab fits beside the
      // brand; the overflow split is a measurement and works at any width.
      assert.ok(seen.tabs.length >= 2, `only ${seen.tabs.length} tabs are shown at a tablet width`);
      assert.equal(seen.compactHidden, true, "the compact Menu button is showing on a tablet");
      assert.equal(seen.moreHidden, false, "nothing overflowed, so nothing was measured");
      assert.match(
        seen.moreText,
        /^More \(\d+\)$/,
        `the overflow control reads "${seen.moreText}"`,
      );
    }),
  );

  await check("the header never wraps, and never crowds the brand", async () => {
    for (const viewport of [TABLET, LAPTOP, DESKTOP, { width: 900, height: 800 }]) {
      await withPage("docs/concepts/why-healpix/", "light", viewport, async (page) => {
        const seen = await page.evaluate(() => {
          const header = document.querySelector(".portal-header").getBoundingClientRect();
          const brand = document.querySelector(".portal-brand").getBoundingClientRect();
          const nav = document.querySelector(".portal-nav").getBoundingClientRect();
          return {
            headerHeight: Math.round(header.height),
            brandRight: Math.round(brand.right),
            navLeft: Math.round(nav.left),
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          };
        });
        // One row: a wrapped header is twice its own height, and this design's is 68px.
        assert.ok(
          seen.headerHeight <= 96,
          `the header is ${seen.headerHeight}px tall at ${viewport.width}: it wrapped`,
        );
        assert.ok(
          seen.navLeft >= seen.brandRight - 1,
          `the nav overlaps the brand at ${viewport.width}px`,
        );
        assert.equal(
          seen.scrollWidth,
          seen.innerWidth,
          `the header scrolls sideways at ${viewport.width}px`,
        );
      });
    }
  });

  await check("the overflow control opens the entries it hid, and nothing else", () =>
    withPage("docs/concepts/why-healpix/", "light", TABLET, async (page) => {
      const hidden = await page.evaluate(() => {
        const more = document.querySelector(".portal-more-button");
        return Number(/\((\d+)\)/.exec(more.textContent)?.[1] ?? "0");
      });
      await page.locator(".portal-more-button").click();
      await page.waitForTimeout(150);
      const opened = await page.evaluate(() => {
        const panel = document.querySelector(".portal-more .portal-panel");
        return {
          expanded: document.querySelector(".portal-more-button").getAttribute("aria-expanded"),
          items: [...panel.querySelectorAll(".portal-panel-item")].map((a) => a.textContent.trim()),
          visible: panel.getBoundingClientRect().height > 0,
        };
      });
      assert.equal(opened.expanded, "true", "the control does not report itself open");
      assert.equal(opened.visible, true, "the panel opened but drew nothing");
      assert.equal(
        opened.items.length,
        hidden,
        `it hid ${hidden} entries and listed ${opened.items.length}`,
      );
    }),
  );

  // phone: the drill-down

  await check("on a phone the Menu button opens a full-screen panel", () =>
    withPage("docs/concepts/why-healpix/", "light", PHONE, async (page) => {
      const before = await page.evaluate(() => ({
        compactHidden: document.querySelector(".portal-compact-button").hidden,
        panelHidden: document.querySelector(".portal-navpanel").hidden,
        tabsVisible: [...document.querySelectorAll(".portal-nav-li")].some(
          (li) => li.getBoundingClientRect().height > 0,
        ),
      }));
      assert.equal(before.compactHidden, false, "there is no Menu button on a phone");
      assert.equal(before.panelHidden, true, "the panel is open before anything was pressed");
      assert.equal(before.tabsVisible, false, "the tab list is still drawn on a phone");

      await page.locator(".portal-compact-button").click();
      await page.waitForTimeout(300);
      const opened = await page.evaluate(() => {
        const panel = document.querySelector(".portal-navpanel").getBoundingClientRect();
        return {
          expanded: document.querySelector(".portal-compact-button").getAttribute("aria-expanded"),
          width: Math.round(panel.width),
          height: Math.round(panel.height),
          left: Math.round(panel.left),
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          level: document.querySelector(".portal-navpanel").dataset.level,
          backHidden: document.querySelector("[data-portal-navpanel-back]").hidden,
          sections: [
            ...document.querySelectorAll("[data-portal-navpanel-root] .portal-navpanel-link"),
          ].map((a) => a.textContent.trim()),
        };
      });
      // "Full-screen" is a measurement, not an adjective.
      assert.equal(opened.expanded, "true", "the button does not report itself open");
      assert.equal(opened.width, opened.innerWidth, "the panel does not cover the width");
      assert.equal(opened.height, opened.innerHeight, "the panel does not cover the height");
      assert.equal(opened.left, 0, "the panel did not finish sliding in");
      assert.equal(opened.level, "root", "the panel did not open at the section list");
      assert.equal(opened.backHidden, true, "a Back control is offered at the top level");
      assert.ok(opened.sections.length >= 3, `only ${opened.sections.length} sections listed`);
    }),
  );

  await check("a section drills into its pages, and Back returns", () =>
    withPage("docs/concepts/why-healpix/", "light", PHONE, async (page) => {
      await page.locator(".portal-compact-button").click();
      await page.waitForTimeout(300);
      const rootTitle = await page.evaluate(() =>
        document.querySelector("[data-portal-navpanel-title]").textContent.trim(),
      );

      await page.locator("[data-portal-navpanel-drill]").first().click();
      await page.waitForTimeout(200);
      const drilled = await page.evaluate(() => {
        const level = document.querySelector("[data-portal-navpanel-section]:not([hidden])");
        return {
          level: document.querySelector(".portal-navpanel").dataset.level,
          title: document.querySelector("[data-portal-navpanel-title]").textContent.trim(),
          backHidden: document.querySelector("[data-portal-navpanel-back]").hidden,
          rootHidden: document.querySelector("[data-portal-navpanel-root]").hidden,
          pages: level ? level.querySelectorAll(".portal-navpanel-link").length : 0,
          groups: level ? level.querySelectorAll("details.portal-navpanel-group").length : 0,
          openGroups: level
            ? level.querySelectorAll("details.portal-navpanel-group[open]").length
            : 0,
        };
      });
      assert.equal(drilled.level, "section", "the panel did not change level");
      assert.equal(drilled.rootHidden, true, "the section list is still showing");
      assert.equal(drilled.backHidden, false, "there is no way back");
      assert.notEqual(drilled.title, rootTitle, "the title still names the site, not the section");
      assert.ok(drilled.pages >= 2, `only ${drilled.pages} pages in the section`);
      // Nested groups exist, and the page being read arrives open.
      assert.ok(drilled.groups >= 1, "no expandable groups in the outline");
      assert.equal(drilled.openGroups, 1, `${drilled.openGroups} groups arrived open`);

      await page.locator("[data-portal-navpanel-back]").click();
      await page.waitForTimeout(200);
      const back = await page.evaluate(() => ({
        level: document.querySelector(".portal-navpanel").dataset.level,
        title: document.querySelector("[data-portal-navpanel-title]").textContent.trim(),
        backHidden: document.querySelector("[data-portal-navpanel-back]").hidden,
      }));
      assert.equal(back.level, "root", "Back did not return to the sections");
      assert.equal(back.title, rootTitle, "Back did not restore the title");
      assert.equal(back.backHidden, true, "Back is still offered at the top level");
    }),
  );

  await check("Escape steps back a level, then closes", () =>
    withPage("docs/concepts/why-healpix/", "light", PHONE, async (page) => {
      await page.locator(".portal-compact-button").click();
      await page.waitForTimeout(300);
      await page.locator("[data-portal-navpanel-drill]").first().click();
      await page.waitForTimeout(200);

      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      assert.equal(
        await page.evaluate(() => document.querySelector(".portal-navpanel").dataset.level),
        "root",
        "the first Escape did not step back a level",
      );

      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      const closed = await page.evaluate(() => ({
        expanded: document.querySelector(".portal-compact-button").getAttribute("aria-expanded"),
        open: document.querySelector(".portal-navpanel").getAttribute("data-open"),
      }));
      assert.equal(closed.expanded, "false", "the second Escape did not close the panel");
      assert.equal(closed.open, null, "the panel is still marked open");
    }),
  );

  await check("the close button returns to the page and restores focus", () =>
    withPage("docs/concepts/why-healpix/", "light", PHONE, async (page) => {
      await page.locator(".portal-compact-button").click();
      await page.waitForTimeout(300);
      await page.locator("[data-portal-navpanel-close]").click();
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => ({
        open: document.querySelector(".portal-navpanel").getAttribute("data-open"),
        focused: document.activeElement?.className ?? "",
        bodyOverflow: getComputedStyle(document.body).overflow,
      }));
      assert.equal(after.open, null, "Close did not close the panel");
      assert.match(after.focused, /portal-compact-button/, "focus was not returned to the trigger");
      assert.notEqual(after.bodyOverflow, "hidden", "the page is still locked from scrolling");
    }),
  );

  await check("every destination is in the HTML, with no JavaScript at all", () =>
    withPage(
      "docs/concepts/why-healpix/",
      "light",
      PHONE,
      async (page) => {
        // The panel is script-driven, so a scriptless phone gets the `<noscript>` list instead,
        // and it has to carry every declared destination or a visitor without JavaScript has a
        // header with nothing in it.
        const seen = await page.evaluate(() => ({
          fallback: document.querySelectorAll(".portal-compact-fallback .portal-panel-item").length,
          outline: document.querySelectorAll(".portal-outlinebar-item").length,
        }));
        assert.ok(
          seen.fallback >= 5,
          `the no-script menu lists only ${seen.fallback} destinations`,
        );
        assert.ok(seen.outline >= 2, "the page outline is unreachable without JavaScript");
      },
      { js: false },
    ),
  );

  // both themes

  for (const [name, viewport] of [
    ["1440x900", DESKTOP],
    ["834x1000", TABLET],
    ["390x844", PHONE],
  ]) {
    for (const theme of ["light", "dark"]) {
      await check(`axe finds no violations at ${name}, ${theme}`, () =>
        withPage("docs/concepts/why-healpix/", theme, viewport, (page) =>
          axeOn(page, `${name} ${theme}`),
        ),
      );
    }
  }

  await check("the phone panel is clean to axe while it is open", async () => {
    for (const theme of ["light", "dark"]) {
      await withPage("docs/concepts/why-healpix/", theme, PHONE, async (page) => {
        await page.locator(".portal-compact-button").click();
        await page.waitForTimeout(300);
        await axeOn(page, `panel open, ${theme}`);
      });
    }
  });

  for (const [name, viewport] of [
    ["1440x900", DESKTOP],
    ["834x1000", TABLET],
    ["390x844", PHONE],
  ]) {
    for (const theme of ["light", "dark"]) {
      await check(`it is photographed at ${name}, ${theme}`, () =>
        withPage("docs/concepts/why-healpix/", theme, viewport, async (page) => {
          await page.screenshot({ path: join(OUT, `nav-${name}-${theme}.png`) });
        }),
      );
    }
  }
} finally {
  await browser.close();
  server.close();
}

writeFileSync(join(OUT, "measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} nav-responsive browser checks passed`);
process.exit(failed === 0 ? 0 : 1);
