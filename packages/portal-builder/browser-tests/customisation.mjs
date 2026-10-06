// The customisation fixtures (examples/centre-a and examples/centre-b) in a real browser.
//
// What the unit and artifact tests cannot settle: that a customised portal is still accessible
// in both colour modes, works with JavaScript off, can be driven by keyboard - the phone menu
// included - keeps search and the account control visible and focusable, honours reduced motion,
// survives a theme preset swap, and asks for nothing from any other origin.
//
// Usage:  node browser-tests/customisation.mjs   (BROWSER_STRICT=1 makes a skip a failure)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const REPO = resolve(PKG, "..", "..");
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

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 900, height: 1000 };
const PHONE = { width: 390, height: 844 };
const work = mkdtempSync(join(tmpdir(), "portal-custom-browser-"));

function build(root, out) {
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
}

/** Centre A with another preset: the customisation has to hold on any registered theme. */
function presetSwap(preset) {
  const root = join(work, `centre-a-${preset}`);
  cpSync(join(REPO, "examples", "centre-a"), root, { recursive: true });
  const config = readFileSync(join(root, "portal.yaml"), "utf8");
  writeFileSync(join(root, "portal.yaml"), config.replace("preset: default", `preset: ${preset}`));
  return root;
}

const sites = [
  { name: "centre-a", root: join(REPO, "examples", "centre-a"), base: "/" },
  { name: "centre-b", root: join(REPO, "examples", "centre-b"), base: "/portal/" },
  { name: "centre-a/waterpark", root: presetSwap("waterpark"), base: "/" },
];

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

const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
let browser;
try {
  browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
} catch (error) {
  const message = `chromium would not launch: ${error.message}`;
  if (STRICT) throw new Error(message);
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

try {
  for (const site of sites) {
    const out = join(work, `out-${site.name.replace("/", "-")}`);
    build(site.root, out);
    const server = createPreviewServer({ dir: out, port: 0 });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const base = `${origin}${site.base}`;

    const withPage = async (path, fn, options = {}) => {
      const context = await browser.newContext({
        viewport: options.viewport ?? DESKTOP,
        javaScriptEnabled: options.js !== false,
        reducedMotion: options.reducedMotion ?? "no-preference",
      });
      await context.route(`${origin}/__axe-core.js`, (route) =>
        route.fulfill({ status: 200, contentType: "text/javascript", body: AXE }),
      );
      const page = await context.newPage();
      const requests = [];
      const problems = [];
      page.on("request", (request) => requests.push(request.url()));
      page.on("pageerror", (error) => problems.push(String(error)));
      page.on("console", (message) => {
        if (/Content Security Policy|Refused to/i.test(message.text()))
          problems.push(message.text());
      });
      if (options.theme) {
        await page.addInitScript((mode) => {
          try {
            localStorage.setItem("freva.portal.theme", mode);
          } catch {
            // storage refused: the light theme
          }
        }, options.theme);
      }
      try {
        await page.goto(base + path, { waitUntil: "networkidle" });
        await fn(page, { requests, problems });
      } finally {
        await context.close();
      }
    };

    const axe = async (page, label) => {
      await page.addScriptTag({ url: `${origin}/__axe-core.js` });
      const violations = await page.evaluate(async () => {
        // The Freva badge is a vendored package with its own suite; everything else is held to
        // the full standard, the customised header and footer included.
        const result = await window.axe.run(
          { exclude: [[".fb"]] },
          { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } },
        );
        return result.violations.flatMap((v) =>
          v.nodes.slice(0, 3).map((n) => `${v.id} :: ${n.target.join(" ")}`),
        );
      });
      assert.deepEqual(violations, [], `${label}: ${violations.join(" | ")}`);
    };

    const pages = ["", site.name === "centre-b" ? "docs/methods/" : "docs/guide/"];
    for (const theme of ["light", "dark"]) {
      for (const path of pages) {
        await check(`${site.name}: axe on /${path} (${theme})`, () =>
          withPage(path, (page) => axe(page, `${path} ${theme}`), { theme }),
        );
      }
      await check(`${site.name}: axe on / at phone width (${theme})`, () =>
        withPage("", (page) => axe(page, `phone ${theme}`), { theme, viewport: PHONE }),
      );
    }

    await check(`${site.name}: nothing is requested from another origin`, () =>
      withPage("", async (page, { requests, problems }) => {
        await page.mouse.wheel(0, 4000);
        await page.waitForTimeout(400);
        const foreign = requests.filter((url) => !url.startsWith(origin));
        assert.deepEqual(foreign, []);
        assert.deepEqual(problems, []);
      }),
    );

    await check(`${site.name}: the site stylesheet applies, after the framework's`, () =>
      withPage("", async (page) => {
        const sheets = await page.evaluate(() =>
          [...document.styleSheets].map((s) => new URL(s.href ?? location.href).pathname),
        );
        assert.match(sheets.at(-1), /\/_portal\/site-style\.[0-9a-f]{8}\.css$/);
      }),
    );

    await check(`${site.name}: works without JavaScript`, () =>
      withPage(
        "",
        async (page) => {
          const state = await page.evaluate(() => ({
            h1: document.querySelectorAll("h1").length,
            header: Boolean(document.querySelector('[data-part="header"]')),
            footer: Boolean(document.querySelector('[data-part="footer"]')),
            skip: Boolean(document.querySelector('[data-part="skip-link"]')),
            // The header is opaque without JavaScript: nothing would track the scroll.
            headerBackground: getComputedStyle(document.querySelector(".portal-header"))
              .backgroundColor,
            links: [...document.querySelectorAll("a[href]")].length,
          }));
          assert.equal(state.h1, 1);
          assert.ok(state.header && state.footer && state.skip);
          assert.notEqual(state.headerBackground, "rgba(0, 0, 0, 0)");
          assert.ok(state.links > 4);
          // The sections are reachable: the side navigation at this width, or the noscript list.
          const reachable = await page.evaluate(
            () =>
              document.querySelectorAll(".portal-sidenav a, .portal-nav-list a, noscript").length,
          );
          assert.ok(reachable > 0);
        },
        { js: false },
      ),
    );

    await check(`${site.name}: keyboard starts at the skip link, which moves focus to main`, () =>
      withPage("", async (page) => {
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement?.dataset.part), "skip-link");
        await page.keyboard.press("Enter");
        assert.equal(await page.evaluate(() => document.activeElement?.id), "portal-main");
      }),
    );

    await check(`${site.name}: search and the account control are visible and focusable`, () =>
      withPage("", async (page) => {
        for (const part of ["header-search", "header-auth"]) {
          const control = page.locator(`[data-part="${part}"]`).first();
          await control.waitFor({ state: "visible", timeout: 5000 });
          const target = part === "header-auth" ? control.locator("button").first() : control;
          await target.focus();
          assert.equal(
            await target.evaluate((el) => el === document.activeElement),
            true,
            `${part} did not take focus`,
          );
          const box = await target.boundingBox();
          assert.ok(box && box.width > 8 && box.height > 8, `${part} has no size`);
        }
        // Reached by Tab, too: walk the header.
        const seen = new Set();
        for (let i = 0; i < 25; i += 1) {
          await page.keyboard.press("Tab");
          const part = await page.evaluate(
            () => document.activeElement?.closest("[data-part]")?.dataset.part,
          );
          if (part) seen.add(part);
        }
        assert.ok(seen.has("header-search"), `Tab never reached search: ${[...seen]}`);
        assert.ok(seen.has("header-auth"), `Tab never reached the account control: ${[...seen]}`);
      }),
    );

    await check(`${site.name}: the phone menu opens and closes from the keyboard`, () =>
      withPage(
        "",
        async (page) => {
          const toggle = page.locator('[data-part="nav-toggle"]');
          await toggle.waitFor({ state: "visible", timeout: 5000 });
          await toggle.focus();
          await page.keyboard.press("Enter");
          await page.waitForTimeout(400);
          assert.equal(await toggle.getAttribute("aria-expanded"), "true");
          const panel = page.locator(".portal-navpanel");
          assert.ok(await panel.isVisible(), "the panel did not open");
          await page.keyboard.press("Escape");
          await page.waitForTimeout(400);
          assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        },
        { viewport: PHONE },
      ),
    );

    if (site.name === "centre-b") {
      await check(
        `${site.name}: the menu button stays and opens at tablet width, where there are no tabs`,
        () =>
          withPage(
            "",
            async (page) => {
              const toggle = page.locator('[data-part="nav-toggle"]');
              await toggle.waitFor({ state: "visible", timeout: 5000 });
              await toggle.click();
              await page.waitForTimeout(400);
              assert.ok(await page.locator(".portal-navpanel").isVisible(), "no panel opened");
            },
            { viewport: TABLET },
          ),
      );
      await check(`${site.name}: the side navigation is a landmark with the current section`, () =>
        withPage("docs/methods/", async (page) => {
          const nav = page.locator('nav[data-part="side-nav"]');
          assert.ok(await nav.isVisible());
          assert.equal(await nav.locator('[data-state="current"]').count(), 1);
        }),
      );
    }

    await check(`${site.name}: reduced motion turns transitions off`, () =>
      withPage(
        "",
        async (page) => {
          const durations = await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                '[data-part="card"], .portal-header, .portal-theme-toggle',
              ),
            ]
              .map((el) => getComputedStyle(el).transitionDuration)
              .filter((d) => d.split(",").some((part) => Number.parseFloat(part) > 0.02)),
          );
          assert.deepEqual(durations, []);
        },
        { reducedMotion: "reduce" },
      ),
    );

    server.close();
  }
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed > 0 ? 1 : 0);
