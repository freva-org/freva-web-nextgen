// Live announcements, driven in a real browser under the artifact's own CSP.
//
// The feed is served by the test (Playwright answers `/api/announcements`), in the format the
// MkDocs-era Waterpark file already uses, so what is proved is that a migrated site keeps its
// server-side file. Checked: the notice renders as text with its link and level, dismissing it
// sticks for the session, an unreachable feed shows nothing and breaks nothing, and axe finds
// nothing in the banner.
//
// Usage:  node browser-tests/announcement-feed.mjs

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

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Mark</title><rect width="16" height="16" fill="#123456"/></svg>`;

function writeFixture() {
  const root = mkdtempSync(join(tmpdir(), "feed-browser-"));
  const put = (rel, content) => {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put("content/page.md", "---\ntitle: A page\n---\n\nText.\n");
  put(
    "landings/home.yaml",
    "schemaVersion: 1\ntitle: Home\nblocks:\n  - type: hero\n    heading: Hello\n",
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: feed
  title: Feed
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: waterpark
rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
landings:
  home:
    path: /
    source: ./landings/home.yaml
announcementFeed:
  url: /api/announcements
`,
  );
  const out = join(root, "..", `feed-site-${process.pid}`);
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
const browser = await launch();
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const FEED = {
  announcements: [
    {
      id: "storage-migration",
      text: "The archive is read-only until the migration finishes. <b>not markup</b>",
      level: "outage",
      expires: new Date(Date.now() + 3_600_000).toISOString(),
      link: "https://status.example.org/",
      link_text: "Status",
    },
    { id: "expired", text: "Old", level: "info", expires: "2020-01-01T00:00:00Z" },
  ],
};

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

async function withFeed(respond, fn) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(`${base}api/announcements`, respond);
  await context.route(`${base}__axe-core.js`, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: AXE }),
  );
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) problems.push(message.text());
  });
  try {
    await fn(page, problems);
  } finally {
    await context.close();
  }
}

const serve = (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FEED) });

try {
  await check("a live notice renders as text, with its level and link, under the CSP", () =>
    withFeed(serve, async (page, problems) => {
      await page.goto(`${base}docs/page/`, { waitUntil: "networkidle" });
      const seen = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".portal-announcement-live")];
        return rows.map((row) => ({
          level: row.dataset.level,
          text: row.querySelector(".portal-announcement-text").textContent,
          bold: row.querySelectorAll("b").length,
          link: row.querySelector("a")?.getAttribute("href"),
          dismiss: Boolean(row.querySelector(".portal-announcement-dismiss")),
        }));
      });
      assert.equal(seen.length, 1, `${seen.length} live notices (the expired one must not show)`);
      assert.equal(seen[0].level, "critical");
      assert.match(seen[0].text, /read-only.*<b>not markup<\/b>/);
      assert.equal(seen[0].bold, 0, "feed text was parsed as markup");
      assert.equal(seen[0].link, "https://status.example.org/");
      assert.ok(seen[0].dismiss);
      assert.deepEqual(problems, []);
    }),
  );

  await check("dismissing it sticks for the session", () =>
    withFeed(serve, async (page) => {
      await page.goto(`${base}docs/page/`, { waitUntil: "networkidle" });
      await page.locator(".portal-announcement-live .portal-announcement-dismiss").click();
      assert.equal(await page.locator(".portal-announcement-live").count(), 0);
      await page.goto(`${base}`, { waitUntil: "networkidle" });
      assert.equal(await page.locator(".portal-announcement-live").count(), 0);
    }),
  );

  await check("an unreachable or malformed feed shows nothing and breaks nothing", async () => {
    for (const respond of [
      (route) => route.fulfill({ status: 503, body: "down" }),
      (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{not json" }),
      (route) => route.abort(),
    ]) {
      await withFeed(respond, async (page, problems) => {
        await page.goto(`${base}docs/page/`, { waitUntil: "networkidle" });
        assert.equal(await page.locator(".portal-announcement-live").count(), 0);
        assert.deepEqual(
          problems.filter((p) => !/Failed to load resource/.test(p)),
          [],
        );
      });
    }
  });

  await check("the banner is clean to axe", () =>
    withFeed(serve, async (page) => {
      await page.goto(`${base}docs/page/`, { waitUntil: "networkidle" });
      await page.addScriptTag({ url: `${base}__axe-core.js` });
      const violations = await page.evaluate(async () => {
        const report = await window.axe.run(document.querySelector("#portal-announcements"), {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        });
        return report.violations.map((v) => v.id);
      });
      assert.deepEqual(violations, []);
    }),
  );
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(
  `\n${results.length - failed}/${results.length} announcement-feed browser checks passed`,
);
process.exit(failed === 0 ? 0 : 1);
