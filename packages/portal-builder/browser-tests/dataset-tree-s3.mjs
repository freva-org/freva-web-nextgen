// The live S3 source: what the page asks for, when, and what it never asks for.
//
// Waterpark's archive is not a catalogue the build can embed: it is an object store that answers
// one prefix at a time, and the correct behaviour is to ask for a prefix WHEN A ROW IS OPENED and
// never before. That is a claim about network traffic, so the only place it can be settled is a
// real browser in front of a real gateway, with the gateway keeping the receipts. Every check
// below is therefore phrased against `gateway.requests` - the paths the page actually asked for -
// rather than against the DOM alone. A tree that renders the right rows by listing the whole
// archive at load would pass a DOM-only suite and fail this one, which is the point.
//
// The gateway is local, and the report says so. The reported archive is reachable from a browser
// and not from this sandbox - the egress proxy refuses the CONNECT - so `fixtures/s3-gateway.mjs`
// serves the same ListObjectsV2 wire format over the same key layout, including the exact path
// the report verified. What that cannot prove is DKRZ's own CORS configuration; nothing here
// implies otherwise.
//
// Usage:  node browser-tests/dataset-tree-s3.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { buildWaterparkShaped } from "./waterpark-shaped.mjs";
import { startS3Gateway } from "./fixtures/s3-gateway.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const STRICT = process.env.BROWSER_STRICT === "1";
const SHOTS = process.env.FREVA_TREE_SHOTS ?? join(PKG, "reports", "dataset-tree-s3");

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

// the archive

const CMIP6 = "s3://cmip6/healpix/cmip6/";
const MEMBER = `${CMIP6}historical-r10i1p1f2/`;
const MODEL = `${MEMBER}cnrm-cm6-1/`;
const FREQ = `${MODEL}P1M/`;
/** The exact store the report verified, as the adapter names it: a prefix, so it ends in `/`. */
const STORE = `${FREQ}level_0.zarr/`;

// the fixtures

const gateway = await startS3Gateway({});

// `maxKeys: 2` is the pagination check, not a performance setting: the busiest prefix in the
// fixture holds four entries, so a two-key page forces the adapter to follow a continuation token
// where a default 1000-key page would finish in one request and hide a broken pagination path.
//
// TWO ROOTS, both populated and both reachable. This suite's subject is traffic - what was asked
// for, when, and what was never asked for - and every claim is of the form "exactly these
// requests and no others". The full archive carries a forbidden bucket, an absent one and an
// announced one, whose 403, 404 and silence belong to `waterpark-tree.mjs` and would here only
// make the request log depend on which bucket failed. Both of these are real roots of the real
// archive, in its own order.
const liveSite = buildWaterparkShaped({
  s3: { endpoint: gateway.endpoint, maxKeys: 2 },
  buckets: ["cmip6", "cordex"],
});
const snapshotSite = buildWaterparkShaped({});
// A THIRD BUILD, for the symlinked collection, with its own root so it has its own traffic. The
// checks above are of the form "exactly these requests and no others", so a bucket added to the
// live site would change every count in the suite. This one is separate: one root, one gateway,
// and the shape the hub actually serves for a linked collection - `.zarr` levels that arrive as
// 51-byte OBJECTS rather than as prefixes, and a directory that is itself a link.
const symlinkSite = buildWaterparkShaped({
  s3: { endpoint: gateway.endpoint, maxKeys: 2 },
  buckets: ["nextgems"],
  // Its OWN output directory: the default is derived from the mode and the process id, so a second
  // live build overwrites the first and every check above it starts reading the wrong archive.
  outDir: join(tmpdir(), `wp-shaped-site-symlinks-${process.pid}`),
});

const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
const servers = [];
async function serve(dir) {
  const server = createPreviewServer({ dir, port: 0 });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
}
const LIVE = await serve(liveSite);
const SNAPSHOT = await serve(snapshotSite);
const SYMLINKS = await serve(symlinkSite);

async function shutdown() {
  for (const s of servers) s.close();
  await gateway.close();
}

let browser;
try {
  browser = await chromium.launch({
    // `--no-proxy-server`: this sandbox exports an egress proxy, which cannot reach loopback.
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    executablePath: process.env.FREVA_PORTAL_CHROMIUM ?? "/opt/pw-browsers/chromium",
  });
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

const DESKTOP = { width: 1571, height: 899 };
const MOBILE = { width: 390, height: 780 };

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

/**
 * One page, with the gateway's log cleared first so every check reads only its own traffic.
 * `problems` collects page errors, console errors AND CSP violations: a `connect-src` that did
 * not name the gateway shows up there as a violation rather than as a missing row, which is what
 * tells the difference between "the policy is wrong" and "the code is wrong".
 */
async function withLive(options, fn) {
  const { viewport = DESKTOP, theme = "dark", failFirst = 0, delayMs = 0, base = LIVE } = options;
  gateway.set({ failFirst, delayMs });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("freva.portal.theme", t);
    } catch {
      // a context that refuses storage still renders
    }
  }, theme);
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  try {
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForSelector(".dataset-tree", { timeout: 20_000 });
    await fn(page, problems);
    problems.push(...(await page.evaluate(() => window.__cspViolations ?? [])));
  } finally {
    await context.close();
  }
}

/**
 * Open a row and wait for the listing it triggers to settle. The ids are `s3://bucket/prefix/` -
 * slashes and a colon - which need no escaping inside an attribute-value selector's quotes, and
 * are worth matching on exactly because they are the adapter's own identity for a node rather
 * than a position in a list.
 */
async function open(page, id, { settle = 900 } = {}) {
  await page.click(`[data-dt-row="${id}"]`);
  await page.waitForTimeout(settle);
}

const rowIds = (page) =>
  page.$$eval(".dataset-tree__row, .dataset-tree__row--inert", (rows) =>
    rows.map((r) => r.getAttribute("data-dt-row")),
  );

/**
 * The two request shapes, kept apart, because they answer different questions.
 *
 * A LISTING is what an opened row asks for: this prefix, `maxKeys` at a time, following
 * continuation tokens until the prefix is exhausted. A PROBE is the one-key request the component
 * makes once per browsable root at load, to learn whether a collection has anything in it at all
 * - the single sanctioned exception to "no requests before expansion", and the only thing that
 * lets a row say "no data yet" without a reader opening it to find out. `max-keys=1` tells them
 * apart here because this fixture lists two keys at a time; a suite setting `maxKeys: 1` would
 * need another way.
 */
const listings = () =>
  gateway.requests.filter((r) => r.includes("list-type=2") && !r.includes("max-keys=1&"));
const probes = () =>
  gateway.requests.filter((r) => r.includes("list-type=2") && r.includes("max-keys=1&"));

// static evidence

function jsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith(".js")) out.push(p);
    }
  };
  walk(dir);
  return out;
}
/**
 * The adapter's fingerprint in emitted output: the XML element names it parses. Not the query
 * string - the minifier splits `list-type=2` into two literals, so a check for it would match
 * nothing in either build and would report "the snapshot build is clean" for a build that shipped
 * the whole adapter.
 */
const s3Chunks = (dir) =>
  jsFiles(dir).filter((f) => /ListBucketResult|CommonPrefixes/.test(readFileSync(f, "utf8")));

const csp = (dir) => JSON.parse(readFileSync(join(dir, "host-policy.json"), "utf8")).csp.portal;

try {
  // nothing until it is asked

  await check("a freshly loaded live page lists nothing, and probes each root exactly once", () =>
    withLive({}, async (page, problems) => {
      const ids = await rowIds(page);
      assert.deepEqual(
        listings(),
        [],
        `the page listed ${listings().length} prefixes before anything was opened`,
      );
      // THE ONE SANCTIONED REQUEST BEFORE EXPANSION, bounded on every axis: one per browsable
      // root, one key each, no continuation token, ever. It buys the difference between "this
      // collection is empty" and "nobody has looked yet", which cannot be told from declared
      // configuration and which a reader would otherwise pay a full listing to discover.
      // Everything else in this file keeps the rule: nothing is listed until it is opened.
      const asked = probes().map((r) =>
        decodeURIComponent(new URL(r, "http://g").searchParams.get("prefix") ?? ""),
      );
      assert.deepEqual(
        asked.sort(),
        ["healpix/cmip6/", "healpix/cordex/"],
        `probes were ${asked.join(", ")}`,
      );
      assert.equal(new Set(asked).size, asked.length, "a root was probed more than once");
      for (const probe of probes()) {
        assert.ok(!probe.includes("continuation-token"), `a probe paginated: ${probe}`);
      }
      // The roots are DECLARED, so they are on screen without a request having been made.
      assert.deepEqual(ids, [CMIP6, "s3://cordex/healpix/cordex/"], `roots were ${ids.join(", ")}`);
      assert.deepEqual(problems, [], problems.join(" | "));
    }),
  );

  await check("ListBuckets is never issued - the archive root is 403 and nothing may ask", () =>
    withLive({}, async (page) => {
      await open(page, CMIP6);
      await open(page, MEMBER);
      const bare = gateway.requests.filter((r) => r === "/" || r.startsWith("/?"));
      assert.deepEqual(bare, [], `the page asked the archive root for ${bare.join(", ")}`);
      // Every listing names a bucket the configuration declared.
      for (const request of listings()) {
        assert.match(request, /^\/(cmip6|cordex)\?/, `unexpected listing ${request}`);
      }
    }),
  );

  await check("opening one root lists that prefix and no other", () =>
    withLive({}, async (page) => {
      await open(page, CMIP6);
      const prefixes = listings().map((r) =>
        decodeURIComponent(new URL(r, "http://g").searchParams.get("prefix")),
      );
      assert.deepEqual(
        [...new Set(prefixes)],
        ["healpix/cmip6/"],
        `listed prefixes were ${prefixes.join(", ")}`,
      );
      // And the sibling root is still un-listed, because nobody opened it.
      assert.ok(
        !listings().some((r) => r.startsWith("/cordex")),
        "opening cmip6 also listed cordex",
      );
    }),
  );

  await check("a listing longer than one page is completed with a continuation token", () =>
    withLive({}, async (page) => {
      await open(page, CMIP6);
      const forPrefix = listings().filter(
        (r) => r.includes("prefix=healpix%2Fcmip6%2F&") || r.endsWith("prefix=healpix%2Fcmip6%2F"),
      );
      assert.ok(
        forPrefix.length >= 2,
        `expected a continued listing, saw ${forPrefix.length} request(s)`,
      );
      assert.ok(
        forPrefix.some((r) => r.includes("continuation-token=")),
        "no continuation token was followed",
      );
      // The whole prefix arrived, across the pages: three members and the README.
      const ids = await rowIds(page);
      assert.ok(ids.includes(`${CMIP6}ssp585-r1i1p1f2/`), "the second page's rows are missing");
      assert.ok(ids.includes(`${CMIP6}README.md`), "the second page's objects are missing");
    }),
  );

  // depth and leaves

  await check("depth is not limited - six levels open, one request each", () =>
    withLive({}, async (page) => {
      for (const id of [CMIP6, MEMBER, MODEL, FREQ]) await open(page, id);
      const ids = await rowIds(page);
      assert.ok(ids.includes(STORE), `the store is not on screen; rows were ${ids.length}`);
      // Nothing refused to go deeper: every opened branch produced its own listing.
      const opened = new Set(
        listings().map((r) => new URL(r, "http://g").searchParams.get("prefix")),
      );
      assert.equal(opened.size, 4, `expected four listed prefixes, saw ${[...opened].join(", ")}`);
    }),
  );

  await check("a `.zarr` prefix is a dataset leaf, and opening it lists nothing inside it", () =>
    withLive({}, async (page) => {
      for (const id of [CMIP6, MEMBER, MODEL, FREQ]) await open(page, id);
      const kind = await page.$eval(
        `[data-dt-row="${STORE}"]`,
        (row) => row.closest("li").className,
      );
      assert.match(kind, /dataset-tree__node--dataset/, `the store rendered as ${kind}`);
      const before = listings().length;
      await open(page, STORE);
      assert.equal(
        listings().length - before,
        0,
        `opening the store issued ${listings().length - before} request(s) into its chunks`,
      );
      // Its forty-two chunk objects are not rows, because they were never asked for.
      const ids = await rowIds(page);
      assert.ok(!ids.some((id) => id.includes(".zarr/tas")), "chunk objects were listed");
      assert.ok(!ids.some((id) => id.endsWith(".zmetadata")), "store internals were listed");
    }),
  );

  await check("no `Expand all` is offered over a source that lists on demand", () =>
    withLive({}, async (page) => {
      const live = await page.$$eval(".dataset-tree__bar .dataset-tree__btn", (b) =>
        b.map((x) => x.textContent.trim()),
      );
      // `Collapse all` alone. `Expand all` cannot honestly be offered over a source that lists
      // on demand, and `Reload` is offered over nothing: it discards every branch the reader had
      // opened, from the position at the end of the row where the eye goes looking for
      // `Collapse`. Collapsing and reopening one row re-reads that prefix with one request.
      assert.deepEqual(live, ["Collapse all"], `live toolbar was ${live.join(", ")}`);
    }),
  );

  await check("the same block over a snapshot still offers `Expand all`", () =>
    withLive({ base: SNAPSHOT }, async (page) => {
      const snap = await page.$$eval(".dataset-tree__bar .dataset-tree__btn", (b) =>
        b.map((x) => x.textContent.trim()),
      );
      assert.deepEqual(snap, ["Expand all", "Collapse"], `snapshot toolbar was ${snap.join(", ")}`);
      assert.deepEqual(listings(), [], "a snapshot page contacted the gateway");
    }),
  );

  // failure and rescue

  await check("a 503 is retried within the bound and the branch still loads", () =>
    withLive({ failFirst: 1 }, async (page, problems) => {
      await open(page, CMIP6, { settle: 1600 });
      const ids = await rowIds(page);
      assert.ok(ids.includes(MEMBER), "the branch did not recover from one 503");
      assert.ok(listings().length >= 2, "the failed listing was not retried");
      // A recovered request is not an error the visitor has to read.
      assert.equal(
        await page.$$eval(".dataset-tree__msg--error", (m) => m.length),
        0,
        "a recovered branch still showed an error",
      );
      assert.deepEqual(
        problems.filter((p) => !p.includes("503")),
        [],
        problems.join(" | "),
      );
    }),
  );

  await check("a branch that keeps failing gets its own error and its own Retry", () =>
    withLive({ failFirst: 50 }, async (page) => {
      await open(page, CMIP6, { settle: 2200 });
      const retry = await page.$$eval("[data-dt-key^='retry:']", (b) =>
        b.map((x) => x.getAttribute("data-dt-key")),
      );
      assert.deepEqual(retry, [`retry:${CMIP6}`], `retry controls were ${retry.join(", ")}`);
      // Per row: the sibling root is untouched and still openable.
      const ids = await rowIds(page);
      assert.ok(ids.includes("s3://cordex/healpix/cordex/"), "the failure took out the whole tree");

      // And Retry actually retries - against a gateway that has stopped failing.
      gateway.set({});
      await page.click(`[data-dt-key="retry:${CMIP6}"]`);
      await page.waitForTimeout(1200);
      assert.ok((await rowIds(page)).includes(MEMBER), "Retry did not reload the branch");
    }),
  );

  await check("collapsing a branch mid-flight aborts the listing it started", () =>
    withLive({ delayMs: 1500 }, async (page) => {
      await page.click(`[data-dt-row="${CMIP6}"]`);
      await page.waitForTimeout(300);
      assert.equal(listings().length, 1, "the listing did not start");
      await page.click(`[data-dt-row="${CMIP6}"]`); // collapse, while the response is still held
      await page.waitForTimeout(600);
      assert.deepEqual(
        gateway.aborted.length,
        1,
        `the in-flight listing was not cancelled (${gateway.aborted.length} aborts)`,
      );
    }),
  );

  // leaf routes

  await check("a live store offers its path and its one read recipe, and nothing to run", () =>
    withLive({}, async (page) => {
      for (const id of [CMIP6, MEMBER, MODEL, FREQ]) await open(page, id);
      await open(page, STORE, { settle: 400 });

      // The path itself is not a tab: it is the panel's own line, with Copy beside it.
      const path = await page.$eval(
        `
        [data-dataset-tree-id="${STORE}"] .dataset-tree__path code`,
        (e) => e.textContent.trim(),
      );
      assert.equal(path, STORE, `the store's path read ${path}`);

      const disclose = await page.$(`.dataset-tree__disclose[data-dt-id="${STORE}"]`);
      assert.ok(disclose, "the leaf offers no `How to access`");
      assert.match((await disclose.textContent()).trim(), /How to access/);
      await disclose.click();
      await page.waitForTimeout(400);

      // ONE RECIPE, AND THEREFORE NO TABLIST. `s3fs` against the endpoint needs botocore and a
      // credential chain, so it is in no browser profile, can carry no run control, and would
      // leave a reader with a tab they cannot run beside a tab they can. With one way to open the
      // store there is nothing to choose between, so the strip that asks is absent too.
      const tabs = await page.$$eval(".dataset-tree__tab", (t) =>
        t.map((x) => x.textContent.trim()),
      );
      assert.deepEqual(tabs, [], `a tablist was drawn for one recipe: ${tabs.join(", ")}`);
      assert.equal(
        await page.$$eval(".dataset-tree__access-body", (b) =>
          b
            .map((x) => x.textContent)
            .join("")
            .includes("s3fs")
            ? 1
            : 0,
        ),
        0,
        "the s3fs recipe is still in the panel",
      );

      const http = await page.$eval(".dataset-tree__access-body code", (e) => e.textContent);
      assert.match(http, /xr\.open_dataset/);
      // The HTTPS address of this store, built from the CONFIGURED endpoint, appears inside it.
      assert.ok(
        http.includes(
          `${gateway.endpoint}/cmip6/healpix/cmip6/historical-r10i1p1f2/cnrm-cm6-1/P1M/level_0.zarr/`,
        ),
        `the HTTP recipe does not name this store: ${http}`,
      );

      // NO RUN CONTROL, on either tab, because this build configured no playground. The stronger
      // claim - that a live store's Try button carries a registered recipe id and a validated
      // store parameter rather than a generated program - is `python-playground.mjs`'s. What
      // matters here is that the absence of a playground removes the control entirely instead of
      // leaving one that fails when pressed.
      assert.equal(
        await page.$$eval(".dataset-tree__btn--run", (b) => b.length),
        0,
        "a build with no playground offered a run control",
      );
    }),
  );

  // a collection made of links

  // A SHAPE S3 CANNOT DESCRIBE, end to end in a browser. The hub serves some collections as
  // symlinks, and S3 has no way to say so: each level comes back as a `Contents` object of 51
  // bytes - the byte length of the link target - with no `CommonPrefixes` anywhere in the answer.
  // Classified by which element carried the key, ten Zarr pyramids render as ten unopenable
  // files. What is asserted here is what a reader sees: a store's icon, a store's panel, and a
  // store's inspect control.
  await check("a .zarr that arrives as an object is a store, with everything a store has", () =>
    withLive({ base: SYMLINKS }, async (page) => {
      const root = "s3://nextgems/";
      await open(page, root);
      await open(page, `${root}healpix/`);
      await open(page, `${root}healpix/ngc3028/`);
      await open(page, `${root}healpix/ngc3028/PT30M/`);

      const levels = (await rowIds(page)).filter((id) => id && id.includes("PT30M/level_"));
      assert.deepEqual(
        levels,
        [
          `${root}healpix/ngc3028/PT30M/level_0.zarr`,
          `${root}healpix/ngc3028/PT30M/level_1.zarr`,
          `${root}healpix/ngc3028/PT30M/level_2.zarr`,
        ],
        `the linked levels listed as ${levels.join(", ")}`,
      );

      // A STORE, not a file: the cube icon, and no 51 B size passed off as the store's own.
      const store = `${root}healpix/ngc3028/PT30M/level_0.zarr`;
      const kind = await page.$eval(
        `[data-dt-row="${store}"] .dataset-tree__icon`,
        (e) => e.className.baseVal ?? e.getAttribute("class"),
      );
      assert.match(kind, /dataset-tree__icon--dataset/, `the level rendered as ${kind}`);
      const sizes = await page.$$eval(
        `[data-dt-row="${store}"] ~ .dataset-tree__size, [data-dt-row="${store}"] + .dataset-tree__size`,
        (n) => n.map((x) => x.textContent.trim()),
      );
      assert.deepEqual(sizes, [], `the link's own byte length was shown as a size: ${sizes}`);

      await open(page, store, { settle: 400 });
      const actions = await page.$$eval(".dataset-tree__actions button", (b) =>
        b.map((x) => x.getAttribute("data-dt-action")),
      );
      assert.ok(actions.includes("inspect"), `a linked store offers ${actions.join(", ")}`);
      const path = await page.$eval(
        `[data-dataset-tree-id="${store}"] .dataset-tree__path code`,
        (e) => e.textContent.trim(),
      );
      assert.equal(path, store, `the linked store's address read ${path}`);
    }),
  );

  await check("a directory that is itself a link opens, because listing resolves it", () =>
    withLive({ base: SYMLINKS }, async (page) => {
      const root = "s3://nextgems/";
      await open(page, root);
      await open(page, `${root}healpix/`);
      // `ngc4008` has no extension and arrived as a 37-byte object. The adapter cannot know it
      // is a link, so it treats listing it as the source of truth - and the gateway resolves it.
      await open(page, `${root}healpix/ngc4008/`);
      const inside = (await rowIds(page)).filter(
        (id) => id && id.startsWith(`${root}healpix/ngc4008/`) && id !== `${root}healpix/ngc4008/`,
      );
      assert.deepEqual(
        inside,
        [`${root}healpix/ngc4008/P1D/`, `${root}healpix/ngc4008/PT15M/`],
        `listing through the link gave ${inside.join(", ")}`,
      );
      await open(page, `${root}healpix/ngc4008/P1D/`);
      const levels = (await rowIds(page)).filter((id) => id && id.includes("P1D/level_"));
      assert.equal(
        levels.length,
        2,
        `the linked directory's levels listed as ${levels.join(", ")}`,
      );
    }),
  );

  await check("a branch says where it is, behind a control that is quiet until wanted", () =>
    withLive({ base: SYMLINKS }, async (page) => {
      const root = "s3://nextgems/";
      await open(page, root);
      // `cycle3/` rather than `healpix/`, because a row BELOW the card is needed: `healpix/` is the
      // last child of this root, and "the tree did not move" cannot be measured against nothing.
      const branch = `${root}cycle3/`;

      // PRESENT, FOCUSABLE, AND NOT DRAWN AT REST. Every branch can say where it is, so every
      // branch has this control, and painting all of them would turn a column of names into a
      // column of icons. Opacity, not `visibility` or `display`: it stays in the tab order and a
      // keyboard brings it back.
      const info = `.dataset-tree__info-btn[data-dt-id="${branch}"]`;
      // The fade is FINISHED before it is measured, in both states. `getComputedStyle` during a
      // running transition reports the animated value, and a headless compositor can leave a 120ms
      // fade running for much longer, so a timed wait here is a flake looking for a slow machine.
      const settled = (selector) =>
        page.$eval(selector, (element) => {
          for (const animation of element.getAnimations()) animation.finish();
          return getComputedStyle(element).opacity;
        });
      const resting = await settled(info);
      assert.equal(resting, "0", `the info control is painted at rest (opacity ${resting})`);
      await page.hover(`[data-dt-row="${branch}"]`);
      const hovered = await settled(info);
      assert.equal(hovered, "1", `hovering the row left the control at opacity ${hovered}`);

      await page.click(info);
      await page.waitForSelector(".dataset-tree__infocard", { timeout: 5000 });
      // Read per CELL, because a row's `textContent` runs the key straight into the value.
      const fields = await page.$$eval(".dataset-tree__infocard .dataset-tree__metarow", (rows) =>
        rows.map((r) => [...r.children].map((c) => c.textContent.trim())),
      );
      assert.ok(
        fields.some(([key, value]) => key === "Bucket" && value === "nextgems"),
        `the panel does not name the bucket: ${JSON.stringify(fields)}`,
      );
      assert.ok(
        fields.some(([key, value]) => key === "Prefix" && value === "cycle3/"),
        `the panel does not name the prefix: ${JSON.stringify(fields)}`,
      );
      const address = await page.$eval(".dataset-tree__infocard .dataset-tree__path code", (e) =>
        e.textContent.trim(),
      );
      assert.equal(address, branch, `the branch's address read ${address}`);
      // And the copy control is inside the address box rather than up beside the name.
      assert.equal(
        await page.$$eval(".dataset-tree__actions [data-dt-action='copy-path']", (b) => b.length),
        0,
        "Copy path is still a button in the action row",
      );
      assert.ok(
        await page.$(".dataset-tree__infocard .dataset-tree__path .dataset-tree__path-copy"),
        "the copy control is not inside the address box",
      );

      // A CARD, NOT A PANEL: the rows below it do not move. A panel under the row pushes the tree
      // down the screen to say four short things, and reading one costs a reader their place.
      const below = `[data-dt-row="${root}healpix/"]`;
      const beforeTop = await page.$eval(below, (e) => Math.round(e.getBoundingClientRect().top));
      await page.waitForTimeout(150);
      const afterTop = await page.$eval(below, (e) => Math.round(e.getBoundingClientRect().top));
      assert.equal(afterTop, beforeTop, "opening the card moved the rows under it");

      // Escape closes it; the control opens it again; a press outside closes it.
      await page.keyboard.press("Escape");
      await page.waitForSelector(".dataset-tree__infocard", { state: "detached", timeout: 5000 });
      await page.click(info);
      await page.waitForSelector(".dataset-tree__infocard", { timeout: 5000 });
      await page.click(".dataset-tree__filter-input");
      await page.waitForSelector(".dataset-tree__infocard", { state: "detached", timeout: 5000 });
    }),
  );

  await check("the snapshot block's Inspect control is wired rather than dead data", () =>
    withLive({ base: SNAPSHOT }, async (page) => {
      const leaf = "eerie/eerie-hist-1950-v20240618_P1M_mean_2.zarr";
      await open(page, leaf, { settle: 400 });
      const actions = await page.$$eval(".dataset-tree__actions button", (b) =>
        b.map((x) => x.getAttribute("data-dt-action")),
      );
      assert.ok(actions.includes("inspect"), `actions were ${actions.join(", ")}`);

      // The event first, and it is cancelable: a deployment that mounts its own inspector wins.
      const seen = await page.evaluate(async (id) => {
        const got = [];
        document.addEventListener("portal:dataset-inspect", (event) => {
          got.push({ id: event.detail?.node?.id, inspect: event.detail?.inspect });
          event.preventDefault(); // so nothing opens a tab during the test
        });
        document.querySelector(`[data-dt-key="inspect:${id}"]`).click();
        await new Promise((r) => setTimeout(r, 300));
        return got;
      }, leaf);
      assert.equal(seen.length, 1, `the control fired ${seen.length} events`);
      assert.equal(seen[0].id, leaf);
      assert.match(seen[0].inspect, /^https:\/\/inspect\.example\.org\//);
      assert.equal(
        page.context().pages().length,
        1,
        "a preventDefault'd inspect still opened a tab",
      );
    }),
  );

  // artifact evidence

  await check("the adapter ships only in the build that asked for it", () => {
    const live = s3Chunks(liveSite).map((f) => f.slice(liveSite.length));
    const snap = s3Chunks(snapshotSite).map((f) => f.slice(snapshotSite.length));
    assert.equal(live.length, 1, `live build has ${live.length} S3 chunks: ${live.join(", ")}`);
    assert.deepEqual(snap, [], `a snapshot build shipped the S3 adapter: ${snap.join(", ")}`);
  });

  await check("the recorded policy names the gateway origin, and widens nothing else", () => {
    const live = csp(liveSite);
    const snap = csp(snapshotSite);
    assert.equal(snap["connect-src"], "'self'", `snapshot connect-src is ${snap["connect-src"]}`);
    assert.equal(
      live["connect-src"],
      `'self' ${gateway.origin}`,
      `live connect-src is ${live["connect-src"]}`,
    );
    // Every OTHER directive is byte-identical: the source mode buys one origin and nothing more.
    for (const key of Object.keys(snap)) {
      if (key === "connect-src") continue;
      assert.equal(live[key], snap[key], `${key} differs: '${live[key]}' vs '${snap[key]}'`);
    }
    assert.deepEqual(Object.keys(live), Object.keys(snap), "the live policy has extra directives");
  });

  // photographs

  await check("photographs the live archive, opened, at desktop and mobile", async () => {
    mkdirSync(SHOTS, { recursive: true });
    for (const [label, viewport] of [
      ["desktop", DESKTOP],
      ["mobile", MOBILE],
    ]) {
      for (const theme of ["light", "dark"]) {
        await withLive({ viewport, theme }, async (page, problems) => {
          await page.screenshot({ path: join(SHOTS, `${label}-${theme}-closed.png`) });
          for (const id of [CMIP6, MEMBER, MODEL, FREQ]) await open(page, id);
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(SHOTS, `${label}-${theme}-open.png`) });
          assert.deepEqual(problems, [], problems.join(" | "));
        });
      }
    }
    assert.ok(existsSync(join(SHOTS, "desktop-dark-open.png")));
    console.log(`       screenshots in ${SHOTS}`);
  });
} finally {
  await browser.close();
  await shutdown();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} dataset-tree S3 checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
