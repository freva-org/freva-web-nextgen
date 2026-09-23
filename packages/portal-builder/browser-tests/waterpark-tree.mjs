// The Waterpark dataset tree, restored: root states, row affordances, store details and
// selection.
//
// Every claim here is about what a reader sees in front of a real archive: a first child in its
// parent's column, a circled `i` on every bucket, a details card on an ordinary folder, a green
// capsule on a directory that had merely been opened, "Could not list" for five different
// problems, a "coming soon" collection with a chevron that expands into an error.
//
// The fixture is the reported archive's own catalogue - eleven collections in their own order,
// with their own titles, project pages and the one `locked: "coming soon"` entry - in front of a
// gateway that speaks ListObjectsV2 and answers the three states a browser has to tell apart: a
// bucket with data, a bucket that lists and is empty, and a bucket that refuses. Nothing here is
// synthetic markup: the assertions read computed geometry and `elementFromPoint`.
//
// Usage:  node browser-tests/waterpark-tree.mjs
//         FREVA_ONLY=<substring> node browser-tests/waterpark-tree.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { buildWaterparkShaped } from "./waterpark-shaped.mjs";
import { startS3Gateway } from "./fixtures/s3-gateway.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const STRICT = process.env.BROWSER_STRICT === "1";
const ONLY = process.env.FREVA_ONLY;
const SHOTS = process.env.FREVA_WP_SHOTS ?? join(PKG, "reports", "waterpark-tree");

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
const PATH = [
  CMIP6,
  `${CMIP6}historical-r10i1p1f2/`,
  `${CMIP6}historical-r10i1p1f2/cnrm-cm6-1/`,
  `${CMIP6}historical-r10i1p1f2/cnrm-cm6-1/P1M/`,
];
const STORE = `${PATH[PATH.length - 1]}level_0.zarr/`;

const gateway = await startS3Gateway({});
const site = buildWaterparkShaped({ s3: { endpoint: gateway.endpoint } });
const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
const server = createPreviewServer({ dir: site, port: 0 });
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}/`;

async function shutdown() {
  server.close();
  await gateway.close();
}

let browser;
try {
  browser = await chromium.launch({
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
const COMPACT = { width: 920, height: 650 };
const MOBILE = { width: 390, height: 780 };

const results = [];
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
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

async function withPage({ viewport = DESKTOP, theme = "dark" } = {}, fn) {
  gateway.reset();
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 160)));
  page.on("console", (m) => {
    // A 403 and a 404 are what the fixture's own buckets answer; the console records them and the
    // tree turns them into sentences, which is the behaviour under test rather than a fault.
    const text = m.text();
    if (m.type() === "error" && !/status of (403|404)/.test(text))
      problems.push(text.slice(0, 160));
  });
  try {
    // `domcontentloaded`, NOT `networkidle`. This archive has a forbidden bucket and an absent
    // one, and the availability probes for them are answered with a 403 and a 404 that the
    // adapter may retry, so "the network went quiet for half a second" is only a property of how
    // those retries happened to be spaced. Each check waits for the thing it is about instead.
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".dataset-tree__row", { timeout: 30_000 });
    await fn(page, problems);
  } finally {
    await context.close();
  }
}

const open = async (page, id, { settle = 500 } = {}) => {
  const selector = `[data-dt-row="${id}"]`;
  await page.waitForSelector(selector, { timeout: 20_000 });
  if ((await page.getAttribute(selector, "aria-expanded")) !== "true") await page.click(selector);
  await page.waitForTimeout(settle);
};

const openPath = async (page) => {
  for (const id of PATH) await open(page, id);
  await page.waitForSelector(`[data-dt-row="${STORE}"]`, { timeout: 20_000 });
};

/** Where each row's chevron, icon and label start, and the depth it claims. */
const depths = (page, ids) =>
  page.evaluate((list) => {
    const at = (node) => Math.round(node.getBoundingClientRect().x);
    return list.map((id) => {
      const row = document.querySelector(`[data-dt-row="${id}"]`);
      if (!row) return { id, missing: true };
      return {
        id,
        chev: at(row.querySelector(".dataset-tree__chev")),
        icon: at(row.querySelector(".dataset-tree__icon")),
        name: at(row.querySelector(".dataset-tree__name")),
        level: Number(row.closest("li").getAttribute("aria-level")),
      };
    });
  }, ids);

try {
  // root states

  await check("the archive's own roots, with a project page and a quiet information control", () =>
    withPage({}, async (page, problems) => {
      await page.waitForTimeout(2_000);
      const rows = await page.$$eval(".dataset-tree__row", (list) =>
        list.map((row) => row.getAttribute("data-dt-row")),
      );
      assert.equal(rows.length, 11, `the archive drew ${rows.length} collections`);

      // A CIRCLED `i` ON EVERY BUCKET, AND NONE OF THEM PAINTED. A root says something a reader
      // cannot get from the row - the bucket's own name, which is rarely the name the deployment
      // chose to display - so it has a control that says so; painted at rest on eleven rows it
      // would make the list read as eleven two-control lines. It is invisible until the row is
      // under the pointer or a keyboard reaches it, which is measured rather than assumed, with
      // the animation finished first: a computed opacity read mid-transition is the animated
      // value and a headless compositor is slow to settle.
      //
      // EVERY BROWSABLE ROOT, which is all of them but the announced one. A collection that is
      // not published yet is the one row with nothing to say about itself, and the package
      // refuses it a panel on purpose: a card there would look exactly like a card on a bucket
      // that exists.
      const announced = await page
        .locator(".dataset-tree__badge", { hasText: "coming soon" })
        .count();
      const controls = await page.locator(".dataset-tree__info-btn").count();
      assert.equal(
        controls,
        rows.length - announced,
        `${controls} controls for ${rows.length} buckets, ${announced} of them announced`,
      );
      const painted = await page.$$eval(
        ".dataset-tree__info-btn",
        (list) =>
          list
            .map((element) => {
              for (const animation of element.getAnimations()) animation.finish();
              return getComputedStyle(element).opacity;
            })
            .filter((value) => value !== "0").length,
      );
      assert.equal(painted, 0, `${painted} information controls are painted at rest`);
      // BESIDE THE NAME, not at the row's right edge, and after the project link where there is
      // one. A collection's row reads `name  description  [link]`, and a control between the
      // description and the link splits a pair that belongs together.
      const placed = await page.$$eval(
        ".dataset-tree__rowline > .dataset-tree__infowrap",
        (list) =>
          list.filter((wrap) => {
            const before = wrap.previousElementSibling;
            return (
              before?.classList.contains("dataset-tree__doclink") === true ||
              before?.classList.contains("dataset-tree__row") === true
            );
          }).length,
      );
      assert.equal(placed, controls, `${placed} of ${controls} controls sit next to their name`);
      // The project page IS drawn, as an explicit external link, for the seven roots that declare
      // one - which is what a reader presses to read about the project rather than list its bucket.
      const links = await page.$$eval(".dataset-tree__doclink", (list) =>
        list.map((a) => a.getAttribute("href")),
      );
      assert.equal(links.length, 8, `${links.length} project links`);
      assert.ok(
        links.every((href) => href.startsWith("https://")),
        "a project link is not https",
      );
      assert.ok(
        !links.some((href) => href.includes("127.0.0.1")),
        "a project link points at the storage endpoint",
      );
      assert.deepEqual(problems, [], problems.join(" | "));
    }),
  );

  await check("only a bucket proven empty says so, and a failure never does", () =>
    withPage({}, async (page) => {
      await page.waitForTimeout(2_500);
      const badges = await page.$$eval(".dataset-tree__badge", (list) =>
        list.map((b) => ({
          text: b.textContent.trim(),
          row: b.closest("li").getAttribute("data-dataset-tree-id"),
        })),
      );
      // TWO badges, and which two is the whole point. `cordex` lists successfully and holds
      // nothing - the one state that may say so. `icdc` refuses and `palmod` does not exist; both
      // FAILED, and a failure is not evidence that a bucket is empty. Labelling either would put
      // a factual claim on screen that nothing checked.
      assert.deepEqual(
        badges.map((b) => `${b.row} ${b.text}`).sort(),
        ["s3://cordex/healpix/cordex/ no data yet", "s3://xspies/ coming soon"],
        `badges were ${JSON.stringify(badges)}`,
      );

      // One probe per probeable root, one key each, and never a second page.
      const probes = gateway.requests.filter((r) => r.includes("max-keys=1"));
      assert.equal(probes.length, 10, `${probes.length} probes for ten probeable roots`);
      assert.ok(!probes.some((r) => r.includes("continuation-token")), "a probe paginated");
      // The locked collection costs nothing at all.
      assert.ok(!gateway.requests.some((r) => r.includes("xspies")), "the locked root was fetched");
      // And nothing asked the archive root, which a real gateway answers with 403.
      assert.ok(!gateway.requests.some((r) => r === "/" || r.startsWith("/?")), "ListBuckets");
    }),
  );

  await check(
    "a coming-soon collection cannot be opened, and never looked as though it could",
    () =>
      withPage({}, async (page) => {
        const shape = await page.evaluate(() => {
          const row = document.querySelector('[data-dt-row="s3://xspies/"]');
          return {
            expanded: row.getAttribute("aria-expanded"),
            leafChevron: Boolean(row.querySelector(".dataset-tree__chev--leaf")),
            badge: row.parentElement.querySelector(".dataset-tree__badge")?.textContent.trim(),
            level: row.closest("li").getAttribute("aria-level"),
          };
        });
        // No promise of an expansion in the markup a screen reader reads…
        assert.equal(shape.expanded, null, "a planned collection announces an expanded state");
        // …and none in the chevron column either, which is a blank spacer rather than an arrow.
        assert.ok(shape.leafChevron, "a planned collection draws an expansion chevron");
        assert.equal(shape.badge, "coming soon");
        assert.equal(shape.level, "1");

        await page.click('[data-dt-row="s3://xspies/"]');
        await page.waitForTimeout(600);
        // Nothing opened, nothing was requested, and no panel of any kind appeared under it.
        assert.equal(await page.locator(".dataset-tree__row").count(), 11, "it opened something");
        assert.equal(
          await page
            .locator('[data-dataset-tree-id="s3://xspies/"] .dataset-tree__details')
            .count(),
          0,
          "a planned collection opened a details card",
        );
        assert.ok(
          !gateway.requests.some((r) => r.includes("xspies")),
          "pressing it cost a request",
        );
      }),
  );

  await check("each failure says what it is, in its own branch, and the tree stays usable", () =>
    withPage({}, async (page) => {
      await page.waitForTimeout(2_000);
      await open(page, "s3://cmip6/healpix/cmip6/", { settle: 800 });
      const before = await page.$$eval("[data-dataset-tree-id]", (list) =>
        list.map((n) => n.getAttribute("data-dataset-tree-id")),
      );

      await open(page, "s3://icdc/", { settle: 900 });
      await open(page, "s3://palmod/", { settle: 900 });

      const messages = await page.$$eval(".dataset-tree__msg--error", (list) =>
        list.map((m) => m.textContent.trim()),
      );
      // The component's own words, verbatim, hyphen and all. `@freva-org/dataset-tree` spells
      // these with a HYPHEN as of 2610.0.0 - upstream replaced the em dashes across `labels.ts`
      // and `s3/errors.ts` and moved its own tests with them. What is checked is the exact
      // sentence a visitor reads, produced by the package rather than paraphrased here, with the
      // two failures told apart by their text.
      assert.deepEqual(messages.sort(), [
        "Access denied - this bucket does not permit anonymous browser listing.",
        "Bucket not found - “palmod” does not exist at the configured storage service.",
      ]);
      // No stack, no URL, no continuation token in what a visitor reads.
      for (const message of messages) {
        assert.doesNotMatch(message, /https?:\/\/|s3:\/\/|at .*\(|list-type/);
      }
      // NEITHER offers Retry: the same request will be refused, and the same bucket will still
      // be absent. A control that promises what it cannot do is worse than none.
      assert.equal(await page.locator("[data-dt-key^='retry:']").count(), 0, "a dead Retry");
      // The rest of the tree is untouched. Not "the row count did not drop" - a count survives a
      // wholesale re-render that replaced every node with a different one. Every node that existed
      // before the two failures is still there, by id, and the branch that worked is still open.
      const after = new Set(
        await page.$$eval("[data-dataset-tree-id]", (list) =>
          list.map((n) => n.getAttribute("data-dataset-tree-id")),
        ),
      );
      const lost = before.filter((id) => !after.has(id));
      assert.deepEqual(lost, [], `a failed branch removed ${lost.length} unrelated nodes`);
      assert.equal(
        await page
          .locator(
            '[data-dataset-tree-id="s3://cmip6/healpix/cmip6/"] > .dataset-tree__rowline > .dataset-tree__row',
          )
          .getAttribute("aria-expanded"),
        "true",
        "a failed branch closed the branch that worked",
      );
      // …and clicking a failed collection never navigated anywhere.
      assert.equal(page.url(), BASE, "a failed listing navigated the page");
    }),
  );

  // hierarchy

  for (const [label, viewport, minStep] of [
    ["desktop", DESKTOP, 12],
    ["mobile", MOBILE, 6],
  ]) {
    await check(`every level begins to the right of the one above it (${label})`, () =>
      withPage({ viewport }, async (page) => {
        await openPath(page);
        const rows = await depths(page, [...PATH, STORE]);
        assert.ok(
          rows.every((row) => !row.missing),
          `missing: ${rows.filter((r) => r.missing).map((r) => r.id)}`,
        );
        const step = rows[1].chev - rows[0].chev;
        assert.ok(step >= minStep, `the first child steps in by only ${step}px`);
        for (let i = 1; i < rows.length; i += 1) {
          for (const part of ["chev", "icon", "name"]) {
            const delta = rows[i][part] - rows[i - 1][part];
            assert.ok(
              Math.abs(delta - step) <= 2,
              `${part} moved ${delta}px from ${rows[i - 1].id} to ${rows[i].id}, wanted ${step}px`,
            );
          }
          assert.equal(rows[i].level, rows[i - 1].level + 1, `aria-level jumped at ${rows[i].id}`);
        }
        assert.equal(rows[0].level, 1);
        // The connector rail sits in the gutter the step opens, not through either column.
        const rail = await page.evaluate(() => {
          const box = document.querySelector(".dataset-tree__children");
          const style = getComputedStyle(box, "::before");
          return {
            left: parseFloat(style.left),
            pad: parseFloat(getComputedStyle(box).paddingLeft),
          };
        });
        assert.ok(
          rail.left > 0 && rail.left < rail.pad,
          `the rail at ${rail.left}px is not inside the ${rail.pad}px gutter`,
        );
      }),
    );
  }

  // stores and directories

  await check("an ordinary directory expands and does nothing else", () =>
    withPage({}, async (page) => {
      await openPath(page);
      const directory = PATH[PATH.length - 1];
      const shape = await page.evaluate((id) => {
        const item = document.querySelector(`[data-dataset-tree-id="${id}"]`);
        const row = item.querySelector(".dataset-tree__row");
        return {
          details: item.querySelector(":scope > .dataset-tree__details") !== null,
          info:
            item.querySelector(":scope > .dataset-tree__rowline .dataset-tree__info-btn") !== null,
          current: row.getAttribute("aria-current"),
          expanded: row.getAttribute("aria-expanded"),
        };
      }, directory);
      // OPENING A FOLDER STILL OPENS ONLY THE FOLDER: the row's own press lists children, draws
      // no card, and leaves no selected-store treatment on it. The circled `i` beside it is how a
      // branch publishes where it is - the bucket and the prefix, which a reader would otherwise
      // reassemble from the rows above. It is not painted at rest, which is the condition on
      // which it exists at all, because one per branch turns a column of names into a column of
      // icons. Its opacity is checked below.
      assert.equal(shape.details, false, "a directory opened a details card");
      assert.equal(shape.info, true, "a directory has no information control");
      assert.equal(shape.expanded, "true");
      // AT REST means neither hovered nor focused, and a test has to arrange both: the click that
      // opened the row left the pointer on it and the focus in it, and each of those reveals the
      // control deliberately - a keyboard must never meet a control it cannot see. The fade is
      // then FINISHED rather than waited out: `getComputedStyle` during a running transition
      // reports the animated value, and a headless compositor clock can leave a 120ms fade
      // "running" for far longer, so a timed wait is a flake looking for a slow machine.
      // `finish()` asks for the end state, which is the value this check is about.
      await page.mouse.move(2, 2);
      const infoOpacity = await page.evaluate((id) => {
        document.activeElement?.blur?.();
        const button = document.querySelector(
          `[data-dataset-tree-id="${id}"] .dataset-tree__info-btn`,
        );
        for (const animation of button.getAnimations()) animation.finish();
        return getComputedStyle(button).opacity;
      }, directory);
      assert.equal(infoOpacity, "0", "the information control is painted on every branch at rest");
      const treatment = await page.evaluate((id) => {
        const row = document.querySelector(`[data-dataset-tree-id="${id}"] .dataset-tree__row`);
        const style = getComputedStyle(row);
        return { outline: style.outlineStyle, shadow: style.boxShadow };
      }, directory);
      // No capsule: no outline, no inset marker. It is an open folder, not a selected store.
      assert.equal(treatment.outline, "none", "an opened directory is outlined like a store");
      assert.ok(!/inset/.test(treatment.shadow), "an opened directory has a selection marker");
    }),
  );

  await check("every store gets Inspect, How to access and its one recipe", () =>
    withPage({}, async (page) => {
      await openPath(page);
      const before = gateway.requests.length;
      await open(page, STORE, { settle: 500 });
      // A `.zarr/` prefix is a LEAF. Opening it shows its panel and asks the gateway for nothing:
      // the tree stops at the store rather than descending into its chunk objects.
      assert.equal(gateway.requests.length, before, "opening a store listed its contents");

      const panel = await page.evaluate((id) => {
        const item = document.querySelector(`[data-dataset-tree-id="${id}"]`);
        const details = item.querySelector(".dataset-tree__details");
        if (!details) return null;
        return {
          name: details.querySelector(".dataset-tree__dname")?.textContent.trim(),
          actions: [...details.querySelectorAll(".dataset-tree__actions button")].map((b) =>
            b.textContent.trim(),
          ),
          path: details.querySelector(".dataset-tree__path code")?.textContent.trim(),
          disclosure: details.querySelector(".dataset-tree__disclose")?.textContent.trim(),
          accessOpen: details.querySelector(".dataset-tree__access-body")?.hidden === false,
        };
      }, STORE);
      assert.ok(panel, "the store opened no panel");
      assert.equal(panel.name, "level_0.zarr");
      // THE ACTION ROW IS WHAT YOU CAN DO WITH THE STORE, and copying an address is not that:
      // `Copy path` is an icon inside the address box below, where the thing it copies is. This
      // build configures no playground, so `Try in Python` - which sits beside `Inspect` - is
      // absent, and `Inspect` is the whole row.
      assert.deepEqual(panel.actions, ["Inspect"]);
      assert.ok(
        await page.$(
          `[data-dataset-tree-id="${STORE}"] .dataset-tree__path .dataset-tree__path-copy`,
        ),
        "the copy control is not inside the address box",
      );
      assert.equal(panel.path, STORE);
      assert.match(panel.disclosure, /How to access/);
      assert.equal(panel.accessOpen, false, "How to access is open before anyone asked");

      await page.click(`.dataset-tree__disclose[data-dt-id="${STORE}"]`);
      await page.waitForTimeout(400);
      // ONE RECIPE, AND NO TABLIST. An `s3fs` route needs botocore and a credential chain, so it
      // is in no browser profile and can carry no run control, and a tablist of one asks a reader
      // to choose from a set of one.
      const recipes = await page.$$eval(".dataset-tree__tab", (tabs) =>
        tabs.map((t) => t.textContent.trim()),
      );
      assert.deepEqual(recipes, []);

      const shown = await page.$eval(".dataset-tree__access-body code", (c) => c.textContent);
      assert.match(shown, /xr\.open_dataset/);
      assert.match(shown, /\/cmip6\/healpix\/cmip6\/.*level_0\.zarr/);
      assert.ok(!shown.includes("s3fs"), "the s3fs recipe is still being shown");
    }),
  );

  await check("Inspect opens the portal's inspector, once, and lists nothing", () =>
    withPage({}, async (page) => {
      await openPath(page);
      await open(page, STORE, { settle: 400 });
      const before = gateway.requests.length;

      await page.click(`[data-dt-key="inspect:${STORE}"]`);
      // The MODAL, not the element. `<data-inspector>` renders its panel into a `position: fixed`
      // backdrop, so the custom element itself is an inline box with nothing in flow inside it
      // and no size of its own - it is `open` and it is not, and cannot be, "visible". What a
      // reader sees is `.di-modal`, and that is what has to appear. The element adopts a
      // constructed stylesheet, which no policy governs; appended as a `<style>` with inline
      // content it would be refused by `style-src 'self'` - this artifact's own recorded policy -
      // leaving an inline element with unstyled children in flow for a check to pass against.
      await page.waitForSelector("data-inspector[open] .di-modal", { timeout: 20_000 });
      await page.waitForTimeout(500);

      const state = await page.evaluate(() => {
        const inspectors = document.querySelectorAll("data-inspector");
        const one = inspectors[0];
        return {
          count: inspectors.length,
          url: one?.getAttribute("zarr-url"),
          file: one?.getAttribute("file"),
          tabs: window.__openedTabs ?? 0,
        };
      });
      // ONE inspector, targeted at this store, derived from the configured endpoint.
      assert.equal(state.count, 1, `${state.count} inspectors opened`);
      assert.match(state.url, /^http:\/\/127\.0\.0\.1:\d+\/cmip6\/healpix\/cmip6\//);
      assert.match(state.url, /level_0\.zarr\/$/);
      // THE PATH FIELD HOLDS THE STORE'S URL, not its name. `file` is the element's editable path
      // input and its `Load` button re-reads whatever is in it, so a bare `level_0.zarr` there is
      // a path that resolves to nothing the moment anybody presses the button beside it. The Data
      // Browser puts the store URL there for the same reason.
      assert.equal(state.file, state.url);
      // WHAT INSPECT MAY ASK FOR, and what it may not. It reads the store's own metadata documents
      // - `.zmetadata`, `zarr.json`, `.zgroup` - and that is the whole point of it: the panel is
      // empty without them. What it must NOT do is descend into the store as a directory, because
      // the tree deliberately stops at a `.zarr` prefix and a hierarchy of chunk objects is not a
      // thing anybody wants listed. So: no new LISTING, and every new request a document GET.
      const asked = gateway.requests.slice(before);
      assert.ok(asked.length > 0, "Inspect fetched nothing, so the panel has nothing in it");
      assert.deepEqual(
        asked.filter((path) => path.includes("list-type")),
        [],
        `Inspect listed the store's contents: ${asked.join(", ")}`,
      );
      assert.deepEqual(
        asked.filter(
          (path) => !/\/(\.zmetadata|zarr\.json|\.zgroup|\.zattrs|\.zarray)$/.test(path),
        ),
        [],
        `Inspect asked for something other than the store's metadata: ${asked.join(", ")}`,
      );

      // AND IT CLOSES. The element owns no dismissal: its close button, a click on its own
      // backdrop and Escape all emit `inspector-close` and change nothing themselves, waiting for
      // whoever mounted it to act. Without a listener in the portal a reader who pressed Inspect
      // is left with a modal over the page and no way out - which is also why "press Inspect
      // twice" cannot be done by clicking: the open modal covers the row, exactly as a modal
      // should, so the second press is only reachable after the first is dismissed.
      await page.click("#nc-close-btn");
      await page.waitForTimeout(400);
      assert.equal(
        await page.locator("data-inspector").count(),
        0,
        "the inspector could not be closed",
      );

      // And opening it again gives one inspector, not a second one stacked on the first.
      await page.click(`[data-dt-key="inspect:${STORE}"]`);
      await page.waitForSelector("data-inspector[open] .di-modal", { timeout: 20_000 });
      assert.equal(await page.locator("data-inspector").count(), 1, "a second inspector opened");
      // Reading it again is reading it again - what must not reappear is a listing.
      assert.deepEqual(
        gateway.requests.slice(before).filter((path) => path.includes("list-type")),
        [],
        "reopening Inspect listed the store",
      );
    }),
  );

  await check("an opened store is outlined without moving, and a folder is not", () =>
    withPage({}, async (page) => {
      await openPath(page);
      const geometry = async (id) =>
        page.evaluate((node) => {
          const row = document.querySelector(`[data-dt-row="${node}"]`);
          const box = row.getBoundingClientRect();
          const style = getComputedStyle(row);
          return {
            x: Math.round(box.x),
            width: Math.round(box.width),
            outline: style.outlineStyle,
            outlineColor: style.outlineColor,
            offset: style.outlineOffset,
          };
        }, id);

      const closed = await geometry(STORE);
      await open(page, STORE, { settle: 400 });
      const opened = await geometry(STORE);

      // NO LAYOUT SHIFT. The outline is drawn inside the row's own box, so becoming the open
      // store changes no dimension and moves no neighbour - which a filled capsule with a left
      // marker does both of.
      assert.equal(opened.x, closed.x, "the row moved horizontally when it was opened");
      assert.equal(opened.width, closed.width, "the row changed width when it was opened");
      assert.equal(opened.outline, "solid", "the open store has no outline");
      // Inside the box, so it cannot push a neighbour.
      assert.ok(
        opened.offset.startsWith("-"),
        `the outline is drawn outside the row (${opened.offset})`,
      );
      // WARM, not the portal's teal. Teal marks what a store IS - its icon, its Inspect action,
      // the leading edge of its panel - and a focused store outlined in the same colour reads as
      // one more of those rather than as the one the reader opened.
      const [r, g, b] = opened.outlineColor.match(/\d+/g).map(Number);
      assert.ok(
        r > g && g > b && r > b + 40,
        `the outline is not warm - a warm accent runs red > green > blue: ${opened.outlineColor}`,
      );

      // The detail panel is aligned under its store and does not cover the rail beside it.
      const panel = await page.evaluate((id) => {
        const item = document.querySelector(`[data-dataset-tree-id="${id}"]`);
        const details = item.querySelector(".dataset-tree__details");
        const row = item.querySelector(".dataset-tree__row");
        const rail = item.closest(".dataset-tree__children");
        return {
          left: Math.round(details.getBoundingClientRect().left),
          rowLeft: Math.round(row.getBoundingClientRect().left),
          railLeft: Math.round(rail.getBoundingClientRect().left),
        };
      }, STORE);
      assert.ok(panel.left > panel.rowLeft, "the panel is not indented under its store");
      assert.ok(panel.left > panel.railLeft, "the panel covers the hierarchy guide beside it");
    }),
  );

  // photographs

  await check("photographs the archive at three widths, in both themes", async () => {
    mkdirSync(SHOTS, { recursive: true });
    for (const [label, viewport] of [
      ["desktop", DESKTOP],
      ["920x650", COMPACT],
      ["mobile", MOBILE],
    ]) {
      for (const theme of ["light", "dark"]) {
        await withPage({ viewport, theme }, async (page) => {
          // Root states: populated, empty, planned - all on one screen.
          await page.waitForTimeout(2_500);
          await page.screenshot({ path: join(SHOTS, `${label}-${theme}-roots.png`) });

          // A failed bucket beside working ones.
          await open(page, "s3://icdc/", { settle: 900 });
          await page.screenshot({ path: join(SHOTS, `${label}-${theme}-failed.png`) });

          // The selected store, its panel and its recipes.
          await openPath(page);
          await open(page, STORE, { settle: 400 });
          await page.click(`.dataset-tree__disclose[data-dt-id="${STORE}"]`);
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(SHOTS, `${label}-${theme}-store.png`) });

          // …and the same tree maximized.
          await page.click("[data-portal-tree-expand]");
          await page.waitForSelector(".portal-sheet", { timeout: 10_000 });
          await page.waitForTimeout(500);
          await page.screenshot({ path: join(SHOTS, `${label}-${theme}-maximized.png`) });
        });
      }
    }
    assert.ok(existsSync(join(SHOTS, "desktop-dark-store.png")));
    console.log(`       screenshots in ${SHOTS}`);
  });
} finally {
  await browser.close();
  await shutdown();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} Waterpark tree checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
