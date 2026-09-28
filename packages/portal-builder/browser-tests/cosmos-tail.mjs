// `theme.backdrop.tail` on the cosmos landing: what follows the last block before the footer.
//
// Measured on a content-rich landing - the case the option is for - in three builds that differ
// only in the option: `full` (the default ending), `short` (96px of scene after the last block)
// and `none` (the page ends at it). The footer's own clearance (the shell's reserve above the fixed
// footer bar) is the same in all three, so the spacing asserted is the option's plus that
// clearance, measured in the page.
//
// Usage:  node browser-tests/cosmos-tail.mjs            (FREVA_DUMP=1 prints the measurements)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.env.BROWSER_STRICT === "1";

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

function buildSite(tail, { sections = 4 } = {}) {
  const name = sections === 4 ? tail : `${tail}-brief`;
  const root = mkdtempSync(join(tmpdir(), `cosmos-tail-${name}-`));
  const put = (rel, body) => {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put(
    "prose/section.md",
    Array.from(
      { length: 8 },
      (_, i) =>
        `Paragraph ${i + 1} of a content-rich landing, long enough to take a few lines on a wide ` +
        "window, so that the page is several screens tall before any story spacing is added.",
    ).join("\n\n") + "\n",
  );
  put(
    "landings/home.yaml",
    `schemaVersion: 1
title: Tail
blocks:
  - type: hero
    heading: A content-rich landing
    summary: Enough blocks that the content, not the story, sets the length of the page.
${"  - type: prose\n    source: ../prose/section.md\n".repeat(sections)}`,
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: cosmos-tail-${name}
  title: Tail
  language: en
  canonicalUrl: https://tail.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: cosmos
${tail === "unset" ? "" : `  backdrop:\n    tail: ${tail}\n`}landings:
  home:
    path: /
    source: ./landings/home.yaml
`,
  );
  const out = join(root, "..", `cosmos-tail-site-${name}-${process.pid}`);
  execFileSync(
    process.execPath,
    // prettier-ignore
    [join(PKG, "bin", "freva-portal-builder.mjs"), "build", "--source-root", root,
     "--config", join(root, "portal.yaml"), "--out", out, "--quiet"],
    { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
  );
  return out;
}

const TAILS = ["unset", "full", "short", "none"];
const SITES = {
  ...Object.fromEntries(TAILS.map((tail) => [tail, buildSite(tail)])),
  // A landing shorter than the story's usual floor (1.6 screens), where fitting the page is the
  // scene's job rather than a no-op.
  brief: buildSite("none", { sections: 1 }),
};

const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
const servers = [];
const bases = {};
for (const [tail, dir] of Object.entries(SITES)) {
  const server = createPreviewServer({ dir, port: 0 });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  bases[tail] = `http://127.0.0.1:${server.address().port}/`;
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

/**
 * Scrolled to the end: where the last block ends, where the footer bar begins, the footer's own
 * clearance (the main region's bottom reserve less the bar), and the scene's solved height.
 */
const MEASURE = async () => {
  window.scrollTo(0, document.documentElement.scrollHeight);
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const landing = document.querySelector(".portal-landing");
  const blocks = [...landing.children].filter(
    (el) => el.getBoundingClientRect().height > 0 && el.tagName !== "CANVAS",
  );
  const last = blocks[blocks.length - 1];
  const footer = document.querySelector(".portal-footer");
  const main = document.querySelector(".portal-main");
  const geom = window.__portalCosmos?.geom;
  return {
    gap: Math.round(footer.getBoundingClientRect().top - last.getBoundingClientRect().bottom),
    clearance: Math.round(
      parseFloat(getComputedStyle(main).paddingBottom) - footer.getBoundingClientRect().height,
    ),
    page: document.documentElement.scrollHeight,
    shell: Math.round(document.querySelector(".portal-shell").getBoundingClientRect().height),
    story: geom ? Math.round(geom.H) : null,
    oceanBottom: geom ? Math.round(geom.oceanBot) : null,
    viewport: window.innerHeight,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

const browser = await launch();
async function measure(tail, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  try {
    await page.goto(bases[tail], { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__portalCosmos?.geom?.H > 0, null, {
      timeout: 15_000,
    });
    return await page.evaluate(MEASURE);
  } finally {
    await context.close();
  }
}

// Waterpark's own window, an ordinary laptop, and a phone.
const VIEWPORTS = [
  { width: 1456, height: 1769 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

let briefCases = 0;
try {
  for (const viewport of VIEWPORTS) {
    const at = `${viewport.width}x${viewport.height}`;
    const m = {};
    for (const tail of TAILS) m[tail] = await measure(tail, viewport);
    if (process.env.FREVA_DUMP) {
      for (const tail of TAILS) console.log(`       ${at} ${tail}: ${JSON.stringify(m[tail])}`);
    }

    await check(`full is today's ending, and the default (${at})`, () => {
      assert.equal(m.full.gap, m.unset.gap, JSON.stringify(m));
      // At least the story's tail after the last block, and the story at least two screens.
      assert.ok(m.full.gap >= 72 + m.full.clearance, JSON.stringify(m.full));
      assert.ok(m.full.page >= viewport.height * 2 - 2, JSON.stringify(m.full));
    });

    await check(`short puts 96px of scene after the last block (${at})`, () => {
      assert.ok(Math.abs(m.short.gap - (96 + m.short.clearance)) <= 1, JSON.stringify(m.short));
      assert.ok(m.short.gap < m.full.gap, JSON.stringify({ short: m.short, full: m.full }));
    });

    await check(`none ends the page at the last block (${at})`, () => {
      assert.ok(Math.abs(m.none.gap - m.none.clearance) <= 1, JSON.stringify(m.none));
    });

    await check(`the scene compresses to the shorter page (${at})`, () => {
      for (const tail of ["short", "none"]) {
        const x = m[tail];
        // Told down exactly the page it has, floor included, and never past its end.
        assert.ok(
          Math.abs(x.story - Math.max(x.shell, x.viewport)) <= 2,
          `${tail} ${JSON.stringify(x)}`,
        );
        assert.ok(x.oceanBottom <= x.story, `${tail} ${JSON.stringify(x)}`);
      }
    });

    await check(`on a brief landing the whole scene still fits the page (${at})`, async () => {
      const x = await measure("brief", viewport);
      // Never shorter than the window; otherwise it ends at the last block.
      if (x.page > viewport.height)
        assert.ok(Math.abs(x.gap - x.clearance) <= 1, JSON.stringify(x));
      else assert.equal(x.page, viewport.height, JSON.stringify(x));
      // Below the usual 1.6-screen floor the scene is told down the page it has, not past it.
      assert.ok(Math.abs(x.story - Math.max(x.shell, x.viewport)) <= 2, JSON.stringify(x));
      assert.ok(x.oceanBottom <= x.page, `the ocean floor is below the page ${JSON.stringify(x)}`);
      assert.equal(x.overflow, 0);
      if (x.page < viewport.height * 1.6) briefCases += 1;
    });

    await check(`no horizontal overflow (${at})`, () => {
      for (const tail of TAILS)
        assert.equal(m[tail].overflow, 0, `${tail} ${JSON.stringify(m[tail])}`);
    });
  }
  await check(
    "the brief landing was shorter than 1.6 screens somewhere, so the fit was tested",
    () => {
      assert.ok(briefCases > 0);
    },
  );
} catch (error) {
  console.error(error);
  results.push(false);
} finally {
  await browser.close();
  for (const server of servers) server.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} cosmos tail checks passed`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
