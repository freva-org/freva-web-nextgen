/**
 * Shared harness for the real-browser regression tests.
 *
 * No hardcoded paths: `dist` is resolved relative to this file, and browsers
 * come from Playwright's own resolution. PLAYWRIGHT_<NAME>_PATH is honoured
 * only as an escape hatch for sandboxes that ship a pre-installed binary.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { selectBrowsers } from "./browsers.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DIST = path.resolve(HERE, "..", "dist");

export function requireDist() {
  if (!fs.existsSync(path.join(DIST, "index.js"))) {
    console.error("dist/ not found - run `npm run build` first.");
    process.exit(2);
  }
}

/** Serve a file out of dist/ for a /dist/... request path. */
export function serveDist(pathname) {
  const rel = pathname.replace(/^\/dist\//, "");
  const file = path.resolve(DIST, rel);
  if (!file.startsWith(DIST)) return null; // no traversal
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Strict mode: a missing required browser is a failure, not a skip. */
export function isStrict() {
  return process.env.BROWSER_STRICT === "1";
}

/**
 * The engines this run will drive, from the shared platform-aware selector.
 *
 * Exits non-zero with an explanation when the strict gate cannot honestly run
 * here - it never falls back to a smaller matrix, because the whole point of
 * the strict gate is that "it passed" means the same thing on every machine.
 */
function resolveBrowsers() {
  try {
    const selection = selectBrowsers({
      platform: process.platform,
      strict: isStrict(),
      override: process.env.BROWSERS,
    });
    for (const note of selection.notes) console.log(`[browsers] ${note}`);
    return selection.browsers;
  } catch (e) {
    console.error(`\n${e.message}\n`);
    process.exit(e.code === "STRICT_UNAVAILABLE" ? 3 : 2);
  }
}

/**
 * Browsers to run. Each is launched through Playwright's own resolution;
 * a browser that is not installed is reported as skipped, not failed.
 */
export async function eachBrowser(run) {
  const playwright = await import("playwright");
  const names = resolveBrowsers();
  const results = [];
  for (const name of names) {
    const type = playwright[name];
    if (!type) {
      results.push({ name, status: "skipped", detail: "unknown browser" });
      continue;
    }
    const override = process.env[`PLAYWRIGHT_${name.toUpperCase()}_PATH`];
    let browser;
    try {
      browser = await type.launch({
        ...(override ? { executablePath: override } : {}),
        args: name === "chromium" ? ["--no-sandbox"] : [],
      });
    } catch {
      results.push({
        name,
        status: isStrict() ? "fail" : "skipped",
        detail: `not installed - run \`npm run browsers:install\``,
      });
      continue;
    }
    try {
      const outcome = await run(browser, name);
      results.push({ name, status: outcome.pass ? "pass" : "fail", detail: outcome.detail });
    } catch (e) {
      results.push({ name, status: "fail", detail: e.message });
    } finally {
      await browser.close();
    }
  }
  return results;
}

export function report(title, results) {
  console.log(`\n=== ${title} ===`);
  for (const r of results) {
    console.log(`  ${r.name.padEnd(9)} ${r.status.toUpperCase().padEnd(8)} ${r.detail ?? ""}`);
  }
  const ran = results.filter((r) => r.status !== "skipped");
  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skipped");
  if (isStrict() && skipped.length > 0) {
    console.log(`  STRICT: ${skipped.length} required browser(s) missing - this is a failure.`);
    return 1;
  }
  if (ran.length === 0) {
    console.log("  no browsers available - run `npm run browsers:install`");
    return 2;
  }
  if (skipped.length) {
    console.log(
      `  (relaxed mode: ${skipped.length} browser(s) skipped; release CI must run with BROWSER_STRICT=1)`,
    );
  }
  return failed.length ? 1 : 0;
}
