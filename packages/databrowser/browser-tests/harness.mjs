/**
 * Shared harness for the real-Chromium layout checks.
 *
 * These exist because jsdom performs NO layout. Every check in this directory asks a question only a
 * real engine can answer - where a line box actually broke, whether two boxes overlap, what
 * `position` actually resolved against - and the unit suite deliberately does not try to fake them.
 *
 * The page under test loads the ACTUAL BUILD OUTPUT of both packages through an import map, so the
 * thing being measured is the artifact that ships, not a copy of its rules.
 *
 * Follows the same shape as packages/ts-oidc-auth-client/browser-tests: dist is resolved relative to
 * this file, the browser comes from Playwright's own resolution, and a missing engine is a skip
 * unless BROWSER_STRICT=1.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const PACKAGES = path.resolve(PKG, "..");

const DIST = {
  "@freva-org/databrowser": path.join(PKG, "dist"),
  "@freva-org/freva-client-terminal": path.join(PACKAGES, "freva-client-terminal", "dist"),
};

/** Both packages must be BUILT - these tests measure the shipped artifacts, not the sources. */
export function requireDist() {
  for (const [name, dir] of Object.entries(DIST)) {
    if (!fs.existsSync(path.join(dir, "index.js"))) {
      console.error(`${name}: dist/ not found - run \`npm run build\` first.`);
      process.exit(2);
    }
  }
}

const TYPES = { ".js": "text/javascript", ".html": "text/html", ".map": "application/json" };

/**
 * Serve the two dist trees under /pkg/<name>/… plus an inline page at /.
 * Returns { url, close }.
 */
export async function serve(html) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(html);
    }
    for (const [name, dir] of Object.entries(DIST)) {
      const prefix = `/pkg/${name}/`;
      if (!url.pathname.startsWith(prefix)) continue;
      const file = path.resolve(dir, url.pathname.slice(prefix.length));
      if (!file.startsWith(dir)) break; // no traversal
      try {
        res.writeHead(200, {
          "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
        });
        return res.end(fs.readFileSync(file));
      } catch {
        break;
      }
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** The import map every fixture page uses to reach the built packages. */
export const IMPORT_MAP = `<script type="importmap">
{"imports":{
  "@freva-org/databrowser":"/pkg/@freva-org/databrowser/index.js",
  "@freva-org/databrowser/picker":"/pkg/@freva-org/databrowser/picker.js",
  "@freva-org/freva-client-terminal":"/pkg/@freva-org/freva-client-terminal/index.js"
}}
</script>`;

/**
 * A deterministic fake backend, installed as `window.fetch` before the component loads.
 * `rows`/`facets` are inlined into the page so no test depends on network conditions.
 *
 * `primary` names the facets the overview shows by default; anything else lands behind "Show
 * additional facets". Omit it and every facet is primary, which is the usual case.
 */
export function fakeApi({ rows, facets, flavours = ["freva", "cmip6"], total, primary }) {
  return `<script>
    const ROWS = ${JSON.stringify(rows)};
    const FACETS = ${JSON.stringify(facets)};
    const PRIMARY = ${primary ? JSON.stringify(primary) : "Object.keys(FACETS)"};
    window.fetch = async (url) => new Response(JSON.stringify(
      String(url).includes("/overview")
        ? { flavours: ${JSON.stringify(flavours)}, attributes: { freva: Object.keys(FACETS) } }
        : { total_count: ${total ?? "ROWS.length"}, facets: FACETS,
            primary_facets: PRIMARY, facet_mapping: {}, search_results: ROWS }
    ), { headers: { "content-type": "application/json" } });
  </script>`;
}

export function isStrict() {
  return process.env.BROWSER_STRICT === "1";
}

/**
 * Run `fn(page)` in Chromium. A missing engine is a skip (or a failure under BROWSER_STRICT=1),
 * never a silent pass.
 */
export async function inChromium(fn, { viewport } = {}) {
  const playwright = await import("playwright");
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  let browser;
  try {
    browser = await playwright.chromium.launch({
      ...(override ? { executablePath: override } : {}),
      args: ["--no-sandbox"],
    });
  } catch (e) {
    return {
      status: isStrict() ? "fail" : "skipped",
      detail: `chromium not installed (${e.message.split("\n")[0]}) - run \`npx playwright install chromium\``,
      checks: [],
    };
  }
  const page = await browser.newPage({ viewport: viewport ?? { width: 1280, height: 820 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const checks = await fn(page);
    if (errors.length) checks.push({ name: "no page errors", pass: false, detail: errors[0] });
    return { status: checks.every((c) => c.pass) ? "pass" : "fail", checks };
  } catch (e) {
    return { status: "fail", detail: e.message, checks: [] };
  } finally {
    await browser.close();
  }
}

/** Print a suite's outcome and return the process exit code. */
export function report(title, result) {
  console.log(`\n=== ${title} ===`);
  if (result.status === "skipped") {
    console.log(`  SKIPPED  ${result.detail}`);
    return 0;
  }
  for (const c of result.checks) {
    console.log(`  ${c.pass ? "pass" : "FAIL"}  ${c.name}${c.detail ? `  - ${c.detail}` : ""}`);
  }
  if (result.detail && !result.checks.length) console.log(`  FAIL  ${result.detail}`);
  const failed = result.checks.filter((c) => !c.pass).length;
  console.log(`  ${result.checks.length - failed}/${result.checks.length} checks pass`);
  return result.status === "pass" ? 0 : 1;
}

/** Two boxes overlap when they intersect on BOTH axes (touching edges do not count). */
export const overlaps = (a, b) =>
  a.left < b.right - 0.5 &&
  b.left < a.right - 0.5 &&
  a.top < b.bottom - 0.5 &&
  b.top < a.bottom - 0.5;
