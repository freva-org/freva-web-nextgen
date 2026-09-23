// The dataset-tree landing block, driven in a real browser.
//
// Everything about this block that a unit test can settle is settled in
// `tests/artifact/dataset-tree-block.test.ts`: the schema, the validation, the containment, the
// embedded bytes. What is left is what only a browser knows. Does the component actually start
// from a catalogue that was embedded rather than fetched, with no request of any kind? Does the
// page work as one thing - the block reachable by keyboard from the page around it, the tree
// announcing itself, the filter that says `Filter loaded items` actually filtering? Is it still
// legible over the Cosmos scene, measured rather than eyeballed? And does axe find anything, on
// rendered output, in both themes?
//
// Usage:  node browser-tests/dataset-tree-block.mjs [out-dir]

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const OUT = resolve(process.argv[2] ?? join(tmpdir(), "dataset-tree-shots"));
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
 * A catalogue with enough shape to exercise the component: two collections, nested directories,
 * datasets with metadata, a planned entry, and a plain file. Names are distinct strings so a
 * filter can be checked by what disappears.
 */
const CATALOG = {
  schemaVersion: 1,
  generatedAt: "2026-01-06T10:00:00Z",
  source: "https://s3.example.org",
  roots: [
    {
      id: "cmip6",
      kind: "collection",
      name: "cmip6",
      title: "CMIP6",
      description: "Coupled Model Intercomparison Project, phase 6",
      path: "s3://example/cmip6",
      link: { href: "https://example.test/cmip6", label: "CMIP6 project page" },
      children: [
        {
          id: "cmip6/atmos",
          kind: "directory",
          name: "atmosphere",
          path: "s3://example/cmip6/atmosphere",
          children: [
            {
              id: "cmip6/atmos/tas",
              kind: "dataset",
              // The store's own name. `title` is the friendly description, and it must NOT take
              // the row: a tree that shows one is a picture of somebody's opinion of an archive.
              name: "tas_hourly.zarr",
              title: "Near-surface air temperature",
              path: "s3://example/cmip6/atmosphere/tas_hourly.zarr",
              size: 48210944,
              mediaType: "application/netcdf",
              modifiedAt: "2026-02-11T09:14:00Z",
              metrics: [{ label: "HP", value: "7" }],
              details: [
                {
                  label: "DIMS",
                  values: [
                    { text: "time", value: "350 640" },
                    { text: "cell", value: "12 582 912" },
                  ],
                },
                { label: "VARS", values: [{ text: "tas" }, { text: "sp" }, { text: "tp" }] },
              ],
              metadata: { provenance: "should never be rendered" },
              availability: "available",
            },
            {
              id: "cmip6/atmos/pr",
              kind: "dataset",
              name: "pr_daily.zarr",
              title: "Precipitation flux",
              path: "s3://example/cmip6/atmosphere/pr_daily.zarr",
              size: 51330000,
              availability: "available",
            },
          ],
        },
        {
          id: "cmip6/ocean",
          kind: "directory",
          name: "ocean",
          path: "s3://example/cmip6/ocean",
          children: [
            {
              id: "cmip6/ocean/tos",
              kind: "dataset",
              name: "tos_monthly.zarr",
              path: "s3://example/cmip6/ocean/tos_monthly.zarr",
              availability: "planned",
              availabilityNote: "available 2027",
            },
          ],
        },
      ],
    },
    {
      id: "obs",
      kind: "collection",
      name: "obs",
      title: "Observations",
      description: "Assorted observational products",
      path: "s3://example/obs",
      children: [
        {
          id: "obs/era5",
          kind: "dataset",
          name: "era5.zarr",
          path: "s3://example/obs/era5.zarr",
          size: 990000000,
          availability: "available",
        },
        {
          id: "obs/readme",
          kind: "file",
          name: "README.txt",
          path: "s3://example/obs/README.txt",
          size: 1024,
          mediaType: "text/plain",
        },
      ],
    },
  ],
};

function writeFixture(preset) {
  const root = mkdtempSync(join(tmpdir(), `dt-browser-${preset}-`));
  const put = (rel, body) => {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put("data/archive.json", JSON.stringify(CATALOG, null, 2));
  put(
    "landings/home.yaml",
    `schemaVersion: 1
title: Dataset Tree
blocks:
  - type: hero
    heading: A portal with a browsable archive
    summary: The tree beside this text is a build-time snapshot, embedded in the page.
  - type: dataset-tree
    catalog: ../data/archive.json
    expand:
      - cmip6
`,
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: dt-${preset}
  title: Dataset Tree
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: ${preset}
landings:
  home:
    path: /
    source: ./landings/home.yaml
`,
  );
  const out = join(root, "..", `dt-site-${preset}-${process.pid}`);
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

const SITES = { default: writeFixture("default"), cosmos: writeFixture("cosmos") };

// server

/**
 * One preview server per artifact, each at its own port.
 *
 * The builder's own `createPreviewServer` rather than a plain static server, because it sends the
 * headers the artifact recorded - including its Content Security Policy. That turns "the
 * catalogue travels as data, so it needs nothing from `script-src`" from a claim into something
 * the browser either allows or refuses. One server per artifact and not one with path prefixes:
 * the artifacts reference their assets from the site root, so prefixes would send every asset
 * request to the wrong tree and the failure would look like "the component never mounts".
 */
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

/**
 * Open a page and record everything it asked the network for. The request log is the point: a
 * block that claims to need no service has to be watched, not trusted, and the only honest way to
 * do that is to count what the browser actually fetched.
 */
async function withPage(preset, theme, viewport, fn) {
  const context = await browser.newContext({ viewport });
  // The accessibility scanner is served from the page's own origin. The artifact's policy is
  // `script-src 'self'` plus one hash and it stays in force through the whole run; injecting axe
  // as an inline script would need the policy relaxed, which is the one condition under which an
  // accessibility pass proves the least.
  await context.route(`${bases[preset]}__axe-core.js`, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: AXE }),
  );
  const page = await context.newPage();
  const requests = [];
  const problems = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  // A blocked resource under the artifact's own policy shows up here and nowhere else.
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window.__cspViolations ??= []).push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
  await page.addInitScript((mode) => {
    try {
      localStorage.setItem("freva.portal.theme", mode);
    } catch {
      // a context that refuses storage still renders the light theme
    }
  }, theme);
  try {
    await page.goto(bases[preset], { waitUntil: "networkidle" });
    await page.waitForSelector(".dataset-tree", { timeout: 10_000 });
    // The theme is asserted rather than assumed: a wrong storage key photographs four light-mode
    // screenshots, two of them labelled "dark".
    const applied = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.equal(applied, theme, `asked for ${theme}, got ${applied}`);
    const violations = await page.evaluate(() => window.__cspViolations ?? []);
    await fn(page, { requests, problems, violations });
  } finally {
    await context.close();
  }
}

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const measurements = {};

try {
  await check("the tree mounts from the page's own bytes, with no request at all", () =>
    withPage("default", "light", DESKTOP, async (page, { requests, problems }) => {
      assert.deepEqual(problems, [], problems.join(" | "));
      const rows = await page.locator("[data-dt-key]").count();
      assert.ok(rows >= 4, `only ${rows} rows`);
      // Nothing was fetched that could have been the catalogue.
      const data = requests.filter((u) => u.endsWith(".json") || u.includes("archive"));
      assert.deepEqual(data, [], `unexpected data requests: ${data.join(", ")}`);
      measurements.requests = requests.length;
      // And the data block it was built from is gone, so the catalogue is in memory once.
      assert.equal(await page.locator("script[data-portal-dataset-tree-catalog]").count(), 0);
    }),
  );

  await check("it mounts under the artifact's own Content Security Policy", () =>
    withPage("default", "light", DESKTOP, async (page, { violations, problems }) => {
      // The catalogue rides in a `<script type="application/json">`. No browser executes one, so
      // `script-src` never gates it - which is why the recorded policy is byte-identical with and
      // without this block. Asserted in the unit tests; this is the browser agreeing.
      assert.deepEqual(violations, [], violations.join(" | "));
      assert.deepEqual(problems, [], problems.join(" | "));
      assert.ok(await page.locator(".dataset-tree").first().isVisible());
    }),
  );

  await check("the configured branch is open on arrival and the rest is not", () =>
    withPage("default", "light", DESKTOP, async (page) => {
      await assert.doesNotReject(page.getByText("atmosphere").first().waitFor({ timeout: 2000 }));
      assert.equal(await page.getByText("Near-surface air temperature").count(), 0);
    }),
  );

  await check("a branch expands, and what it reveals is what the catalogue said", () =>
    withPage("default", "light", DESKTOP, async (page) => {
      await page.getByText("atmosphere").first().click();
      await page.getByText("tas_hourly.zarr").first().waitFor({ timeout: 2000 });
      assert.ok(await page.getByText("pr_daily.zarr").first().isVisible());
      // The friendly title is in the catalogue and is NOT what the row shows.
      assert.equal(
        await page.getByText("Near-surface air temperature").count(),
        0,
        "a friendly description replaced a store name",
      );
    }),
  );

  await check("Expand all opens the whole snapshot; Reload is not offered", () =>
    withPage("default", "light", DESKTOP, async (page) => {
      const labels = await page.locator(".dataset-tree__bar .dataset-tree__btn").allInnerTexts();
      assert.deepEqual(labels, ["Expand all", "Collapse"], `toolbar reads ${labels.join(", ")}`);

      const expand = page.locator('[data-dt-key="expand-all"]');
      await expand.focus();
      await expand.click();
      await page.getByText("tos_monthly.zarr").first().waitFor({ timeout: 2000 });
      assert.ok(await page.getByText("era5.zarr").first().isVisible(), "a second root stayed shut");
      // Focus stays where it was pressed, so it can be pressed again.
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent),
        "Expand all",
        "Expand all lost focus into the tree",
      );

      await page.locator('[data-dt-key="collapse-all"]').click();
      await page.waitForTimeout(150);
      assert.equal(await page.getByText("atmosphere").count(), 0, "Collapse left a branch open");
    }),
  );

  await check("only the approved compact metadata reaches a row", () =>
    withPage("default", "light", DESKTOP, async (page) => {
      await page.locator('[data-dt-key="expand-all"]').click();
      await page.getByText("tas_hourly.zarr").first().waitFor({ timeout: 2000 });
      const line = page
        .locator('[data-dataset-tree-id="cmip6/atmos/tas"] > .dataset-tree__rowline')
        .first();
      const text = await line.innerText();
      assert.match(text, /HP\s*7/, "the declared metric is missing");
      assert.match(text, /46\.0 MB/, "the size is missing");
      assert.ok(!/application\/netcdf/.test(text), "the media type is back on the row");
      assert.ok(!/2026-02-11/.test(text), "the modification time is back on the row");
      // And the availability note is the source's own words, lowercase, uncoloured.
      const badge = await page.locator(".dataset-tree__badge").first().innerText();
      assert.equal(badge.trim(), "available 2027");
    }),
  );

  await check("a dataset panel shows the published fields and no metadata dump", () =>
    withPage("default", "light", DESKTOP, async (page) => {
      await page.locator('[data-dt-key="expand-all"]').click();
      await page.getByText("tas_hourly.zarr").first().waitFor({ timeout: 2000 });
      await page.getByText("tas_hourly.zarr").first().click();
      await page.locator(".dataset-tree__details").first().waitFor({ timeout: 2000 });
      const panel = await page.locator(".dataset-tree__details").first().innerText();
      assert.match(panel, /tas_hourly\.zarr/);
      assert.match(panel, /s3:\/\/example\/cmip6\/atmosphere\/tas_hourly\.zarr/);
      // COPYING THE ADDRESS IS AN AFFORDANCE OF THE ADDRESS: `Copy path` is an icon inside the
      // address box rather than a labelled button beside the name, so what the panel READS is the
      // address and the control sits with the thing it copies.
      assert.ok(!panel.includes("Copy path"), "Copy path is still a labelled button in the panel");
      assert.equal(
        await page
          .locator(".dataset-tree__details .dataset-tree__path .dataset-tree__path-copy")
          .count(),
        1,
        "the copy control is not inside the address box",
      );
      assert.match(panel, /DIMS/);
      assert.match(panel, /VARS/);
      for (const forbidden of ["SIZE", "TYPE", "MODIFIED", "provenance", "should never"]) {
        assert.ok(!panel.includes(forbidden), `the panel printed ${forbidden}`);
      }
      // No inspector is wired in this portal, so there is no control - not a dead one.
      assert.ok(!panel.includes("Inspect"), "an inspect control appeared with no integration");
    }),
  );

  await check("the filter searches the whole snapshot, marks the match, and asks for nothing", () =>
    withPage("default", "light", DESKTOP, async (page, { requests }) => {
      const field = page.getByPlaceholder("Filter datasets and paths…");
      await field.waitFor({ timeout: 2000 });
      assert.equal(
        await page.locator(".dataset-tree__hint").count(),
        0,
        "the lazy-source caveat is printed over a complete snapshot",
      );
      const before = requests.length;

      // `tos_monthly.zarr` lives two levels below a branch nobody opened, in the OTHER root: a
      // filter that searched only what is loaded would answer "no matches" for a store the page
      // already has in memory.
      await field.fill("tos_monthly");
      await page.waitForTimeout(300);
      await page.getByText("tos_monthly.zarr").first().waitFor({ timeout: 2000 });
      assert.equal(await page.getByText("era5.zarr").count(), 0, "a non-match survived");
      assert.equal(
        await page.locator(".dataset-tree__mark").first().innerText(),
        "tos_monthly",
        "the matching text is not marked",
      );

      // A path segment, which appears in no name and no title.
      await field.fill("cmip6/ocean");
      await page.waitForTimeout(300);
      await page.getByText("tos_monthly.zarr").first().waitFor({ timeout: 2000 });

      await field.fill("");
      await page.waitForTimeout(300);
      assert.ok(
        await page.getByText("Observations").first().isVisible(),
        "clearing did not restore",
      );
      assert.deepEqual(
        requests.slice(before),
        [],
        `filtering issued ${requests.length - before} requests`,
      );
    }),
  );

  await check("the tree is reachable and operable from the keyboard alone", () =>
    withPage("default", "light", DESKTOP, async (page) => {
      const reached = await page.evaluate(async () => {
        const root = document.querySelector(".dataset-tree");
        const focusable = root.querySelectorAll(
          'a[href], button, input, [tabindex]:not([tabindex="-1"])',
        );
        return focusable.length;
      });
      assert.ok(reached > 2, `only ${reached} focusable controls inside the tree`);
      // Tab from the top of the document until focus lands inside the tree.
      let inside = false;
      for (let i = 0; i < 40 && !inside; i += 1) {
        await page.keyboard.press("Tab");
        inside = await page.evaluate(() => !!document.activeElement?.closest?.(".dataset-tree"));
      }
      assert.ok(inside, "tabbing never reached the tree");
    }),
  );

  await check("the footer states the catalogue's facts and no build commentary", () =>
    withPage("default", "light", DESKTOP, async (page) => {
      const text = await page.locator(".dataset-tree__foot").innerText();
      assert.ok(text.includes("SNAPSHOT"), "no snapshot pill");
      assert.ok(text.includes("2026-01-06 10:00 UTC"), "the generation time is missing");
      assert.ok(text.includes("https://s3.example.org"), "the public source is missing");
      // "Built into this page - 9 entries" describes how the portal was compiled and counts nodes
      // nobody acts on. A footer may say what the generator recorded, and nothing else.
      for (const commentary of ["Built into this page", "entries", "no network"]) {
        assert.ok(!text.includes(commentary), `the footer printed "${commentary}"`);
      }
    }),
  );

  await check("it stands beside the hero, in a column wide enough for what it draws", async () => {
    const box = async (viewport) => {
      let value;
      await withPage("default", "light", viewport, async (page) => {
        value = await page.evaluate(() => {
          const panel = document.querySelector(".dataset-tree").getBoundingClientRect();
          const hero = document.querySelector(".portal-hero").getBoundingClientRect();
          return {
            panelLeft: panel.left,
            panelWidth: panel.width,
            panelTop: panel.top,
            heroBottom: hero.bottom,
            heroRight: hero.right,
            descriptions: [...document.querySelectorAll(".dataset-tree__sub")].filter(
              (el) => el.getBoundingClientRect().height > 0,
            ).length,
            viewportWidth: window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
      });
      return value;
    };

    // Beside the hero, not below it. A full-width band under the hero treats the tree as a
    // workspace rather than a widget - true about what it IS and wrong about this page: the tree
    // beside the headline is the landing's composition, the hero saying what Waterpark is with
    // the archive it describes right there, and a band pushes those two apart into separate
    // screens. What a band really solves is HEIGHT, and the maximize control solves that without
    // moving anything.
    const wide = await box(DESKTOP);
    measurements.layout = wide;
    assert.ok(
      wide.panelTop < wide.heroBottom,
      `the panel starts at ${Math.round(wide.panelTop)}, below the hero's ${Math.round(wide.heroBottom)}`,
    );
    assert.ok(
      wide.panelLeft > wide.heroRight - 1,
      `the panel overlaps the hero column: panel ${Math.round(wide.panelLeft)} vs hero right ${Math.round(wide.heroRight)}`,
    );

    // And wide enough to still be the product. The component drops its collection descriptions
    // below 30rem of CONTAINER width, so this is the number that decides whether the aside holds
    // the tree or a small card of it.
    assert.ok(wide.panelWidth > 480, `the panel is only ${Math.round(wide.panelWidth)}px at 1440`);
    assert.ok(
      wide.descriptions > 0,
      "the collection descriptions were dropped: the column is under 30rem",
    );
    assert.equal(wide.scrollWidth, wide.viewportWidth, "the page scrolls sideways");

    // A laptop, where an even split would put the column under the threshold.
    const laptop = await box({ width: 1100, height: 900 });
    assert.ok(
      laptop.descriptions > 0,
      `the descriptions were dropped at 1100px, in a ${Math.round(laptop.panelWidth)}px column`,
    );

    // On a phone the row is one column and the tree follows the hero.
    const narrow = await box(PHONE);
    assert.ok(narrow.panelTop >= narrow.heroBottom - 1, "the block did not stack on a phone");
    assert.equal(narrow.scrollWidth, narrow.viewportWidth, "the phone layout scrolls sideways");
  });

  await check("the maximize control names itself, and never says Collapse", async () => {
    await withPage("default", "light", DESKTOP, async (page) => {
      // TWO CONTROLS MUST NOT SHARE A WORD. This control sits IN the toolbar as a toolbar extra,
      // inches from buttons labelled `Expand all` / `Collapse`, and the two words would be doing
      // entirely different things - one collapsing branches, one leaving full screen. The
      // component's own buttons are therefore everything in the bar EXCEPT this control, which is
      // what the filter below says; widened to "everything in the bar" the check would pass by
      // comparing the label with itself.
      const resting = await page.evaluate(() => {
        const button = document.querySelector("[data-portal-tree-expand]");
        const toolbar = [...document.querySelectorAll(".dataset-tree__bar button")]
          .filter((b) => !b.hasAttribute("data-portal-tree-expand"))
          .map((b) => b.textContent.trim().toLowerCase());
        return {
          label: document.querySelector(".portal-tree-expand-text").textContent.trim(),
          name: button.getAttribute("aria-label"),
          labelWidth: Math.round(
            document.querySelector(".portal-tree-expand-text").getBoundingClientRect().width,
          ),
          toolbar,
        };
      });
      // Icon-only at rest - the label is collapsed to nothing - but it still has a name.
      assert.equal(resting.labelWidth, 0, "the label is showing before the control is hovered");
      assert.ok(resting.name && resting.name.length > 0, "the icon-only control has no name");
      assert.ok(
        !resting.toolbar.includes(resting.label.toLowerCase()),
        `"${resting.label}" collides with the tree's own toolbar: ${resting.toolbar.join(", ")}`,
      );

      // Hovering reveals it, which is the whole point of an icon that names itself.
      await page.locator("[data-portal-tree-expand]").hover();
      await page.waitForTimeout(300);
      const hovered = await page.evaluate(() =>
        Math.round(
          document.querySelector(".portal-tree-expand-text").getBoundingClientRect().width,
        ),
      );
      assert.ok(hovered > 20, `the label is still ${hovered}px wide after hovering`);

      // And maximized it says something the toolbar cannot also be saying.
      await page.locator("[data-portal-tree-expand]").click();
      await page.waitForTimeout(300);
      const maximized = await page.evaluate(() => {
        const toolbar = [...document.querySelectorAll(".dataset-tree__bar button")]
          .filter((b) => !b.hasAttribute("data-portal-tree-expand"))
          .map((b) => b.textContent.trim().toLowerCase());
        return {
          label: document.querySelector(".portal-tree-expand-text").textContent.trim(),
          toolbar,
        };
      });
      assert.ok(
        !maximized.toolbar.includes(maximized.label.toLowerCase()),
        `"${maximized.label}" collides with the tree's own toolbar`,
      );
      assert.notEqual(maximized.label.toLowerCase(), "collapse");
    });
  });

  await check("maximizing fills the screen as a sheet and keeps the tree's state", async () => {
    await withPage("default", "light", DESKTOP, async (page) => {
      // Open a branch and choose a node, so there is state that a re-mount would destroy.
      await page.locator('.dataset-tree__row:has-text("atmosphere")').first().click();
      await page.waitForTimeout(150);
      const before = await page.evaluate(() => ({
        rows: document.querySelectorAll(".dataset-tree__row").length,
        path: document.querySelector(".dataset-tree__path")?.textContent?.trim(),
      }));

      await page.locator("[data-portal-tree-expand]").click();
      await page.waitForTimeout(250);
      const expanded = await page.evaluate(() => {
        const block = document.querySelector(".portal-dataset-tree-block");
        const pageHeader = document.querySelector(".portal-header")?.getBoundingClientRect();
        const panel = document.querySelector(".dataset-tree").getBoundingClientRect();
        const foot = document.querySelector(".dataset-tree__foot").getBoundingClientRect();
        const sheet = block.getBoundingClientRect();
        return {
          sheetBottom: Math.round(sheet.bottom),
          sheetTop: Math.round(sheet.top),
          sheetLeft: Math.round(sheet.left),
          flag: block.dataset.expanded,
          pressed: document
            .querySelector("[data-portal-tree-expand]")
            .getAttribute("aria-expanded"),
          label: document.querySelector(".portal-tree-expand-text").textContent.trim(),
          panelHeight: Math.round(panel.height),
          footBottom: Math.round(foot.bottom),
          viewportHeight: window.innerHeight,
          headerBottom: pageHeader ? Math.round(pageHeader.bottom) : 0,
          inOverlay: block.parentElement?.classList.contains("portal-sheet") === true,
          rows: document.querySelectorAll(".dataset-tree__row").length,
          path: document.querySelector(".dataset-tree__path")?.textContent?.trim(),
        };
      });
      assert.equal(expanded.flag, "true", "the block did not expand");
      assert.equal(expanded.pressed, "true", "the control does not report its state");
      assert.equal(expanded.label, "Exit full screen", "the control still says Maximize");
      // The panel fills the SHEET. A fraction of the VIEWPORT would measure the page header,
      // because the sheet begins cleanly below it - the deliberate half of the two available
      // answers - so the header's height comes off the top by design. What has to be true is that
      // the tree gets everything the sheet has, apart from the sheet's own heading row.
      assert.ok(
        expanded.panelHeight > expanded.sheetBottom - expanded.sheetTop - 120,
        `the panel is ${expanded.panelHeight} in a sheet of ${expanded.sheetBottom - expanded.sheetTop}`,
      );
      // THE DELIBERATE HEADER CHOICE: below it, never under it.
      assert.ok(
        expanded.sheetTop >= expanded.headerBottom,
        `the sheet starts at ${expanded.sheetTop}, above the header's ${expanded.headerBottom}`,
      );
      // …and it is in the overlay, not in the page. See `client/components/tree-maximize.ts`.
      assert.ok(expanded.inOverlay, "the block is still in the document rather than in the sheet");
      // A SHEET, not a takeover: inset from every edge, so the page is visibly still underneath.
      // Edge-to-edge it reads as navigation to a different page, with one button as the only clue
      // you can come back.
      assert.ok(
        expanded.sheetTop > 4,
        `the sheet is welded to the top edge at ${expanded.sheetTop}`,
      );
      assert.ok(
        expanded.sheetLeft > 4,
        `the sheet is welded to the left edge at ${expanded.sheetLeft}`,
      );
      // The footer is pinned to the bottom OF THE SHEET, not floating in the middle of it.
      assert.ok(
        Math.abs(expanded.footBottom - expanded.sheetBottom) < 40,
        `the footer sits at ${expanded.footBottom} in a sheet ending at ${expanded.sheetBottom}`,
      );
      // NOTHING WAS RE-MOUNTED. The block's own node is MOVED into the overlay and back - moving
      // is not remounting - so the branch that was open is still open and the node that was
      // chosen is still chosen.
      assert.equal(expanded.rows, before.rows, "the tree was rebuilt: the open branch is gone");
      assert.equal(expanded.path, before.path, "the selection was lost");

      // Escape is a real way out, and it restores the page underneath.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      const after = await page.evaluate(() => ({
        flag: document.querySelector(".portal-dataset-tree-block").dataset.expanded ?? null,
        label: document.querySelector(".portal-tree-expand-text").textContent.trim(),
        rows: document.querySelectorAll(".dataset-tree__row").length,
      }));
      assert.equal(after.flag, null, "Escape did not collapse it");
      assert.equal(after.label, "Maximize", "the control did not go back to Maximize");
      assert.equal(after.rows, before.rows, "collapsing rebuilt the tree");
    });
  });

  await check("a chosen node is marked, and its path is spelled out in the footer", async () => {
    await withPage("default", "light", DESKTOP, async (page) => {
      const empty = await page.evaluate(
        () => document.querySelector(".dataset-tree__path--empty")?.textContent?.trim() ?? null,
      );
      assert.ok(empty && empty.length > 0, "the footer says nothing before anything is chosen");

      await page.locator('.dataset-tree__row:has-text("atmosphere")').first().click();
      await page.waitForTimeout(200);
      const chosen = await page.evaluate(() => {
        const current = document.querySelectorAll('.dataset-tree__row[aria-current="true"]');
        const steps = [...document.querySelectorAll(".dataset-tree__path-step")].map((b) =>
          b.textContent.trim(),
        );
        return { marked: current.length, steps };
      });
      // Exactly one node is current, and the path names it and every ancestor above it.
      assert.equal(chosen.marked, 1, `${chosen.marked} rows claim to be current`);
      assert.ok(chosen.steps.length >= 2, `the path has only ${chosen.steps.length} segments`);
      assert.equal(chosen.steps.at(-1), "atmosphere", "the path does not end at the chosen node");

      // Pressing an ancestor segment moves the selection up, rather than navigating anywhere.
      const url = page.url();
      await page.locator(".dataset-tree__path-step").first().click();
      await page.waitForTimeout(200);
      const walked = await page.evaluate(() => ({
        steps: [...document.querySelectorAll(".dataset-tree__path-step")].map((b) =>
          b.textContent.trim(),
        ),
      }));
      assert.equal(page.url(), url, "a path segment navigated away");
      assert.equal(walked.steps.length, 1, "pressing the root did not shorten the path");
    });
  });

  for (const [preset, theme] of [
    ["default", "light"],
    ["default", "dark"],
    ["cosmos", "light"],
    ["cosmos", "dark"],
  ]) {
    await check(`it is photographed on ${preset}, ${theme}`, () =>
      withPage(preset, theme, DESKTOP, async (page) => {
        await page.getByText("atmosphere").first().click();
        await page.getByText("tas_hourly.zarr").first().waitFor({ timeout: 2000 });
        await page.getByText("tas_hourly.zarr").first().click();
        await page.waitForTimeout(700);
        await page
          .locator(".portal-dataset-tree-block")
          .screenshot({ path: join(OUT, `${preset}-${theme}.png`) });
      }),
    );
  }

  await check("over the Cosmos scene the surface is translucent and the scene is not dimmed", () =>
    withPage("cosmos", "light", DESKTOP, async (page) => {
      await page.waitForTimeout(800);
      const seen = await page.evaluate(() => {
        // One surface, on the component's own panel: the wrapper is structurally quiet, and two
        // nested translucent cards multiply their alphas into a muddier centre.
        const block = document.querySelector(".portal-dataset-tree .dataset-tree");
        const canvas = document.querySelector(".portal-cosmos");
        const wrapper = document.querySelector(".portal-dataset-tree-block");
        return {
          wrapperBackground: getComputedStyle(wrapper).backgroundColor,
          background: getComputedStyle(block).backgroundColor,
          sceneOpacity: canvas ? getComputedStyle(canvas).opacity : null,
          sceneFilter: canvas ? getComputedStyle(canvas).filter : null,
        };
      });
      measurements.cosmos = seen;
      // Translucent: the computed colour carries an alpha below 1.
      const alpha = Number(
        /[\d.]+\s*\)$/.exec(seen.background.replace(/\s/g, ""))?.[0]?.replace(")", "") ?? "1",
      );
      assert.ok(alpha > 0.5 && alpha < 1, `block background is ${seen.background}`);
      assert.equal(
        seen.wrapperBackground,
        "rgba(0, 0, 0, 0)",
        `the wrapper draws a second card: ${seen.wrapperBackground}`,
      );
      // And the scene it sits over is untouched. This is the rule the whole composition rests on.
      assert.equal(seen.sceneOpacity, "1", `scene opacity is ${seen.sceneOpacity}`);
      assert.ok(
        seen.sceneFilter === "none" || !seen.sceneFilter.includes("blur"),
        `scene filter is ${seen.sceneFilter}`,
      );
    }),
  );

  await check(
    "reduced transparency makes the surface opaque and still does not touch the scene",
    () =>
      (async () => {
        const context = await browser.newContext({ viewport: DESKTOP });
        const page = await context.newPage();
        // Playwright cannot emulate `prefers-reduced-transparency`, so the theme's own override
        // is applied the way that preference applies it, and the result is measured. Reduced
        // MOTION is deliberately NOT emulated: with it on, Chromium keeps a stale alpha for a
        // `color-mix()` whose percentage is a `calc(var(...))` when only the variable changes -
        // the variable reads back as 1 while the computed background stays at 0.9, re-serialised
        // into another colour space for good measure. That is a quirk of the emulated media path
        // and not of the page, and reduced motion has nothing to do with what this check is about.
        await page.goto(bases.cosmos, { waitUntil: "networkidle" });
        await page.waitForSelector(".dataset-tree", { timeout: 10_000 });
        // Set on the element rather than through a stylesheet. The theme defines this variable in
        // several places - the light block, the dark block, the reduced-transparency block - and
        // an injected `:root` rule loses to `:root[data-theme=...]` on specificity, leaving the
        // check measuring the unchanged value and calling it a pass.
        await page.evaluate(() =>
          document.documentElement.style.setProperty("--portal-cosmos-card-alpha", "1"),
        );
        const seen = await page.evaluate(() => ({
          background: getComputedStyle(document.querySelector(".portal-dataset-tree-block"))
            .backgroundColor,
          sceneOpacity: getComputedStyle(document.querySelector(".portal-cosmos")).opacity,
        }));
        // Opaque means "no alpha channel in the computed value at all", not "the string ends in 1".
        assert.ok(
          !/\/\s*0?\.\d+\s*\)/.test(seen.background),
          `still translucent: ${seen.background}`,
        );
        assert.equal(seen.sceneOpacity, "1");
        await context.close();
      })(),
  );

  for (const [preset, theme] of [
    ["default", "light"],
    ["default", "dark"],
    ["cosmos", "dark"],
  ]) {
    await check(`axe finds no violations with the tree expanded (${preset}, ${theme})`, () =>
      withPage(preset, theme, DESKTOP, async (page) => {
        await page.getByText("atmosphere").first().click();
        await page.waitForTimeout(500);
        await page.addScriptTag({ url: `${bases[preset]}__axe-core.js` });
        const violations = await page.evaluate(async () => {
          const run = await window.axe.run(document.body, {
            resultTypes: ["violations"],
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
          });
          return run.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.slice(0, 3).map((n) => ({
              target: n.target.join(" "),
              summary: (n.failureSummary ?? "").split("\n").slice(0, 3).join(" / "),
            })),
          }));
        });
        measurements[`axe-${preset}-${theme}`] = violations;
        assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
      }),
    );
  }
} finally {
  await browser.close();
  for (const server of Object.values(servers)) server.close();
}

writeFileSync(join(OUT, "measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} dataset-tree browser checks passed`,
);
process.exit(failed.length > 0 ? 1 : 0);
