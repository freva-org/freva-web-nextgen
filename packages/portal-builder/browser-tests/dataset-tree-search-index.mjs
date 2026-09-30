// A live dataset tree's search index, in a real browser in front of a gateway that keeps receipts.
//
// The index lets a search cover stores nobody has opened WITHOUT listing the store on a keystroke,
// so the load-bearing checks are about traffic: a query finds an index-only entry and the gateway
// saw nothing; the tree is up before the index arrives; a missing or broken index changes only the
// search's reach. The rest is what the reader sees: which copy of a node wins, and the index's age.
//
// Usage:  node browser-tests/dataset-tree-search-index.mjs

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { buildWaterparkShaped } from "./waterpark-shaped.mjs";
import { startS3Gateway } from "./fixtures/s3-gateway.mjs";

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

// the archive, and an index of it

const CMIP6 = "s3://cmip6/healpix/cmip6/";
/** A member directory the gateway serves: loaded once the root is opened, and ALSO in the index. */
const SHARED = `${CMIP6}historical-r10i1p1f2/`;
/** A member the gateway serves and the index does not name: findable only once loaded. */
const LOADED_ONLY = `${CMIP6}historical-r1i1p1f2/`;
/** A store only the index knows about. Finding it must cost the gateway nothing. */
const INDEX_ONLY = `${CMIP6}ssp585-r1i1p1f2/cnrm-cm6-1/P1D/tas_index_only.zarr/`;

const INDEX = {
  schemaVersion: 1,
  generatedAt: "2026-09-30T04:00:00Z",
  source: "s3://cmip6",
  complete: true,
  entries: [
    {
      id: INDEX_ONLY,
      kind: "dataset",
      name: "tas_index_only.zarr",
      path: INDEX_ONLY,
      ancestors: [
        { id: CMIP6, name: "cmip6" },
        { id: `${CMIP6}ssp585-r1i1p1f2/`, name: "ssp585-r1i1p1f2" },
      ],
    },
    {
      // The same id as a node the gateway lists, with a title only the index has. When both
      // exist the loaded node wins, and this title must not be what the reader sees.
      id: SHARED,
      kind: "directory",
      name: "historical-r10i1p1f2",
      title: "FROM THE INDEX",
      path: SHARED,
      ancestors: [{ id: CMIP6, name: "cmip6" }],
    },
  ],
};

const gateway = await startS3Gateway({});
const withIndexSite = buildWaterparkShaped({
  s3: { endpoint: gateway.endpoint, maxKeys: 2, searchIndex: INDEX },
  buckets: ["cmip6"],
  outDir: join(tmpdir(), `wp-shaped-tree-index-${process.pid}`),
});
const withoutIndexSite = buildWaterparkShaped({
  s3: { endpoint: gateway.endpoint, maxKeys: 2 },
  buckets: ["cmip6"],
  outDir: join(tmpdir(), `wp-shaped-tree-noindex-${process.pid}`),
});

const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
const servers = [];
async function serve(dir) {
  const server = createPreviewServer({ dir, port: 0 });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
}
const WITH = await serve(withIndexSite);
const WITHOUT = await serve(withoutIndexSite);

async function shutdown() {
  for (const s of servers) s.close();
  await gateway.close();
}

/** Playwright's own browser first, then an explicit or sandbox path. */
async function launch() {
  const args = ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"];
  const explicit = process.env.FREVA_PORTAL_CHROMIUM;
  if (explicit) return chromium.launch({ args, executablePath: explicit });
  try {
    return await chromium.launch({ args });
  } catch (error) {
    const fallback = "/opt/pw-browsers/chromium";
    if (existsSync(fallback)) return chromium.launch({ args, executablePath: fallback });
    throw error;
  }
}

let browser;
try {
  browser = await launch();
} catch (error) {
  await shutdown();
  const message = `chromium would not launch: ${error.message}`;
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(
      `  FAIL ${name}\n       ${String(error.message).split("\n").slice(0, 6).join("\n       ")}`,
    );
  }
}

const INDEX_FILE = "**/_portal/dataset-tree-index.*.json";

/**
 * One page. `route` lets a check delay, remove or corrupt the index file; `warnings` collects the
 * console warnings the island may log, `problems` page errors and CSP violations.
 */
async function withPage(base, options, fn) {
  gateway.set({});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  const warnings = [];
  const indexRequests = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
    if (m.type() === "warning") warnings.push(m.text());
  });
  page.on("request", (r) => {
    if (r.url().includes("dataset-tree-index.")) indexRequests.push(r.url());
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  if (options.route) await page.route(INDEX_FILE, options.route);
  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".dataset-tree .dataset-tree__row", { timeout: 20_000 });
    await fn(page, { problems, warnings, indexRequests });
    problems.push(...(await page.evaluate(() => window.__cspViolations ?? [])));
  } finally {
    await context.close();
  }
}

const field = ".dataset-tree__filter-input";
const placeholder = (page) => page.getAttribute(field, "placeholder");
const hint = (page) => page.textContent(".dataset-tree__hint");
async function search(page, query) {
  await page.fill(field, query);
  await page.waitForTimeout(400);
}
const results_ = (page) =>
  page.$$eval(".dataset-tree__node--result", (items) =>
    items.map((li) => ({
      id: li.getAttribute("data-dataset-tree-id"),
      from: li.getAttribute("data-dt-result"),
      text: li.textContent ?? "",
    })),
  );
const listings = () => gateway.requests.filter((r) => r.includes("list-type=2"));

try {
  console.log("=== dataset-tree search index (live block) ===");

  await check("the index is fetched from this origin and searched with no gateway request", () =>
    withPage(WITH, {}, async (page, { problems, indexRequests }) => {
      await page.waitForFunction(
        (sel) => document.querySelector(sel)?.getAttribute("placeholder")?.startsWith("Search"),
        field,
        { timeout: 15_000 },
      );
      assert.equal(indexRequests.length, 1, `index requests: ${indexRequests.join(", ")}`);
      assert.ok(new URL(indexRequests[0]).origin === new URL(WITH).origin, "not same-origin");
      const before = gateway.requests.length;
      await search(page, "index_only");
      const found = await results_(page);
      assert.deepEqual(
        found.map((r) => [r.id, r.from]),
        [[INDEX_ONLY, "indexed"]],
      );
      assert.equal(gateway.requests.length, before, `the search asked the gateway: ${listings()}`);
      assert.deepEqual(problems, []);
    }),
  );

  await check("the hint says how old the index is", () =>
    withPage(WITH, {}, async (page) => {
      await page.waitForFunction(
        (sel) => document.querySelector(sel)?.getAttribute("placeholder")?.startsWith("Search"),
        field,
      );
      await search(page, "tas");
      const text = await hint(page);
      assert.match(text ?? "", /whole indexed archive/);
      assert.match(text ?? "", /Index generated 2026-09-30 04:00 UTC/);
    }),
  );

  await check("a node loaded after the index is still found, and the loaded copy wins", () =>
    withPage(WITH, {}, async (page) => {
      await page.waitForFunction(
        (sel) => document.querySelector(sel)?.getAttribute("placeholder")?.startsWith("Search"),
        field,
      );
      // Before the root is opened, the shared id can only come from the index.
      await search(page, "historical-r1");
      let found = await results_(page);
      assert.deepEqual(
        found.map((r) => [r.id, r.from]),
        [[SHARED, "indexed"]],
      );
      await search(page, "");
      await page.click(`[data-dt-row="${CMIP6}"]`);
      await page.waitForSelector(`[data-dt-row="${LOADED_ONLY}"]`, { timeout: 10_000 });
      const before = gateway.requests.length;
      await search(page, "historical-r1");
      found = await results_(page);
      const byId = Object.fromEntries(found.map((r) => [r.id, r]));
      assert.equal(byId[LOADED_ONLY]?.from, "loaded", "a newly loaded node was not found");
      assert.equal(byId[SHARED]?.from, "loaded", "the index copy won over the loaded node");
      assert.ok(!byId[SHARED].text.includes("FROM THE INDEX"), "the index's title is shown");
      assert.equal(gateway.requests.length, before, "the search asked the gateway");
    }),
  );

  await check("the tree is browsable before the index arrives", () => {
    let release;
    const held = new Promise((done) => (release = done));
    return withPage(
      WITH,
      {
        route: async (route) => {
          await held;
          await route.continue();
        },
      },
      async (page) => {
        // Rows are up and the field is still the plain filter: the index is being held back.
        assert.equal(await placeholder(page), "Filter datasets and paths…");
        await page.click(`[data-dt-row="${CMIP6}"]`);
        await page.waitForSelector(`[data-dt-row="${SHARED}"]`, { timeout: 10_000 });
        release();
        await page.waitForFunction(
          (sel) => document.querySelector(sel)?.getAttribute("placeholder")?.startsWith("Search"),
          field,
          { timeout: 15_000 },
        );
      },
    );
  });

  for (const [what, route] of [
    ["missing (404)", (r) => r.fulfill({ status: 404, body: "not found" })],
    ["not JSON", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{ no" })],
    [
      "not a valid index",
      (r) =>
        r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ schemaVersion: 1, entries: [] }),
        }),
    ],
  ]) {
    await check(`an index that is ${what} leaves the tree as it was, and says so once`, () =>
      withPage(WITH, { route }, async (page, { warnings, problems }) => {
        await page.waitForTimeout(1500);
        assert.equal(await placeholder(page), "Filter datasets and paths…");
        await search(page, "index_only");
        assert.deepEqual(await results_(page), [], "a result list without an index");
        assert.match((await hint(page)) ?? "", /Only items already loaded are searched/);
        const mine = warnings.filter((w) => w.includes("dataset-tree search index"));
        assert.equal(mine.length, 1, `warnings: ${JSON.stringify(warnings)}`);
        // Browsing is untouched.
        await search(page, "");
        await page.click(`[data-dt-row="${CMIP6}"]`);
        await page.waitForSelector(`[data-dt-row="${SHARED}"]`, { timeout: 10_000 });
        assert.deepEqual(
          problems.filter((p) => !p.includes("404")),
          [],
        );
      }),
    );
  }

  await check("a block without an index behaves exactly as before", () =>
    withPage(WITHOUT, {}, async (page, { indexRequests, warnings }) => {
      await page.waitForTimeout(800);
      assert.deepEqual(indexRequests, []);
      assert.equal(await placeholder(page), "Filter datasets and paths…");
      await search(page, "index_only");
      assert.deepEqual(await results_(page), []);
      assert.deepEqual(
        warnings.filter((w) => w.includes("search index")),
        [],
      );
    }),
  );
} finally {
  await browser.close();
  await shutdown();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n[tree-index] ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
