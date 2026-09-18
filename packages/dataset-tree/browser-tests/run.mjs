// browser-tests/run.mjs - the checks jsdom cannot make.
//
// Everything here needs a real layout, a real cascade or a real focus ring: computed colours in two
// themes, a container query reacting to a 320px panel, `prefers-reduced-motion`, keyboard traversal
// and an axe pass. The unit suite covers behaviour; this covers the parts of the brief that are
// only true if a browser agrees.
//
// It serves the playground over loopback and makes no outbound request, so it runs offline.

import assert from "node:assert/strict";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

// server

const SERVED = ["playground", "dist"].map((d) => join(PKG, d));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  // A redirect rather than serving index.html at "/": the page's own URLs are relative to
  // /playground/, and serving it one directory up silently breaks every one of them.
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === "/" || url.pathname === "/playground") {
    response.writeHead(302, { location: "/playground/index.html" }).end();
    return;
  }
  const requested = url.pathname;
  const target = join(PKG, normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, ""));
  const contained = SERVED.some((dir) => target === dir || target.startsWith(dir + sep));
  if (!contained || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404).end("not found");
    return;
  }
  const extension = target.slice(target.lastIndexOf("."));
  response.writeHead(200, { "content-type": TYPES[extension] ?? "application/octet-stream" });
  createReadStream(target).pipe(response);
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}/playground/index.html`;

// harness

/**
 * Launch, with the same escape hatch the portal-builder's browser suite uses: a checkout whose
 * Playwright version does not match the browser build installed on the machine can point at one.
 */
async function launchChromium() {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  try {
    return await chromium.launch({ args });
  } catch (error) {
    const pinned = process.env.FREVA_DATASET_TREE_CHROMIUM ?? "/opt/pw-browsers/chromium";
    if (existsSync(pinned)) return chromium.launch({ args, executablePath: pinned });
    throw error;
  }
}

let browser;
try {
  browser = await launchChromium();
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

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`  ok   ${label}`);
  } catch (error) {
    results.push({ label, ok: false });
    console.error(
      `  FAIL ${label}\n       ${String(error.message).split("\n").slice(0, 40).join("\n       ")}`,
    );
  }
}

async function withPage(fn, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  try {
    await fn(page);
    assert.deepEqual(problems, [], `the page reported problems: ${problems.join(" | ")}`);
  } finally {
    await context.close();
  }
}

/** Wait for the wide tree's roots, which arrive after the playground's artificial delay. */
const waitForWideRoots = (page) =>
  page.waitForSelector("#tree-a .dataset-tree__node", { timeout: 15_000 });

const require_ = createRequire(import.meta.url);
const AXE = readFileSync(require_.resolve("axe-core/axe.min.js"), "utf8");

try {
  // rendering

  await check("both instances mount, independently, from one in-memory catalog", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await page.waitForSelector("#tree-b .dataset-tree__node");
      await waitForWideRoots(page);

      const counts = await page.evaluate(() => ({
        a: document.querySelectorAll("#tree-a .dataset-tree__node").length,
        b: document.querySelectorAll("#tree-b .dataset-tree__node").length,
      }));
      assert.ok(counts.a >= 4, `wide tree rendered ${counts.a} rows`);
      assert.ok(counts.b >= 4, `narrow tree rendered ${counts.b} rows`);

      // Expanding one must not touch the other.
      await page.click('#tree-b [data-dt-key="toggle:pg:scenarios"]');
      await page.waitForSelector('#tree-b [data-dataset-tree-id="pg:scenarios/ssp126"]');
      assert.equal(
        await page.locator('#tree-a [data-dataset-tree-id="pg:scenarios/ssp126"]').count(),
        0,
        "expanding the narrow tree expanded the wide one",
      );
    }),
  );

  await check("a collection is drawn as the heading of its branch, not as another row", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await waitForWideRoots(page);
      // The playground opens this branch on arrival, so its children are already on the page.
      await page.waitForSelector('#tree-a [data-dataset-tree-id="pg:reanalysis/surface"]');

      const seen = await page.evaluate(() => {
        const at = (id, part) =>
          document.querySelector(
            `#tree-a [data-dataset-tree-id="${id}"] > .dataset-tree__rowline > .dataset-tree__row${part}`,
          );
        const read = (node) => {
          const style = getComputedStyle(node);
          return {
            weight: Number(style.fontWeight),
            pad: parseFloat(style.paddingBlockStart),
            height: Math.round(node.getBoundingClientRect().height),
          };
        };
        return {
          collection: read(at("pg:reanalysis", "")),
          collectionName: read(at("pg:reanalysis", " > .dataset-tree__name")),
          child: read(at("pg:reanalysis/surface", "")),
          childName: read(at("pg:reanalysis/surface", " > .dataset-tree__name")),
        };
      });

      // Both of these lived behind a selector that could not match - the row is wrapped in a
      // `__rowline`, and the rules reached for it as a direct child of the node - so a collection
      // was rendered at exactly the weight and height of the directories inside it, and the tree
      // had no visible hierarchy at its top level. A dead rule fails silently; this is what makes
      // it fail loudly.
      assert.ok(
        seen.collectionName.weight > seen.childName.weight,
        `a collection is set at ${seen.collectionName.weight}, its children at ${seen.childName.weight}`,
      );
      assert.ok(
        seen.collection.pad > seen.child.pad,
        `a collection row is padded ${seen.collection.pad}px, its children ${seen.child.pad}px`,
      );
    }),
  );

  await check("the filter's caveat waits until there is a filter", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await waitForWideRoots(page);
      const hint = page.locator("#tree-a .dataset-tree__hint");
      const input = page.locator("#tree-a .dataset-tree__filter-input");

      // Present and described from the start - it is what `aria-describedby` points at - but not a
      // band across a panel nobody has filtered yet.
      assert.equal(await hint.count(), 1, "the caveat is not in the document");
      assert.equal(
        await input.getAttribute("aria-describedby"),
        await hint.getAttribute("id"),
        "the field is not described by the caveat",
      );
      assert.ok(await hint.isHidden(), "the caveat is on screen before anything is filtered");

      await input.fill("surface");
      await hint.waitFor({ state: "visible", timeout: 5_000 });
      await input.fill("");
      await hint.waitFor({ state: "hidden", timeout: 5_000 });
    }),
  );

  await check("the subject glyphs are filled shapes, and the controls are not", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await waitForWideRoots(page);
      const seen = await page.evaluate(() => {
        const grab = (sel) => {
          const node = document.querySelector(`#tree-a ${sel}`);
          return node
            ? { fill: node.getAttribute("fill"), stroke: node.getAttribute("stroke") }
            : null;
        };
        return {
          folder: grab(".dataset-tree__icon--collection"),
          chevron: grab(".dataset-tree__chev"),
          search: grab(".dataset-tree__filter-icon"),
        };
      });
      // A tree is scanned by its subject column, and at 13px an outlined folder and an outlined
      // cube are a couple of interior strokes apart - a page of them reads as one wireframe
      // repeated. The controls stay stroked, which is what a control's glyph looks like.
      assert.equal(seen.folder?.fill, "currentColor", "the folder is not a filled shape");
      assert.equal(seen.folder?.stroke, null, "the folder is stroked as well as filled");
      assert.equal(seen.chevron?.fill, "none", "the chevron is filled");
      assert.equal(seen.search?.fill, "none", "the magnifier is filled");
    }),
  );

  await check("a slow branch shows a spinner, then its contents", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await waitForWideRoots(page);
      await page.click('#tree-a [data-dt-key="toggle:pg:reanalysis/surface"]');
      await page.waitForSelector("#tree-a .dataset-tree__spin", { timeout: 5_000 });
      await page.waitForSelector('#tree-a [data-dataset-tree-id="pg:reanalysis/surface/tas"]', {
        timeout: 15_000,
      });
      assert.equal(await page.locator("#tree-a .dataset-tree__spin").count(), 0);
    }),
  );

  await check("a failing branch offers Retry, and the retry succeeds", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await waitForWideRoots(page);
      await page.click('#tree-a [data-dt-key="toggle:pg:scenarios"]');
      await page.waitForSelector("#tree-a .dataset-tree__msg--error", { timeout: 15_000 });
      const text = await page.textContent("#tree-a .dataset-tree__msg--error");
      assert.match(text, /Could not list/);

      await page.click('#tree-a [data-dt-key="retry:pg:scenarios"]');
      await page.waitForSelector('#tree-a [data-dataset-tree-id="pg:scenarios/ssp126"]', {
        timeout: 15_000,
      });
      assert.equal(await page.locator("#tree-a .dataset-tree__msg--error").count(), 0);
    }),
  );

  await check("details open inline, inside the tree, with no dialog anywhere", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await page.waitForSelector("#tree-b .dataset-tree__node");
      await page.click('#tree-b [data-dt-key="toggle:pg:scenarios"]');
      await page.click('#tree-b [data-dt-key="activate:pg:scenarios/ssp245"]');
      await page.waitForSelector("#tree-b .dataset-tree__details");

      const state = await page.evaluate(() => ({
        dialogs: document.querySelectorAll("dialog").length,
        inside: Boolean(document.querySelector("#tree-b .dataset-tree__details")),
        escaped: Boolean(
          document.querySelector("body > .dataset-tree__details, body > .dataset-tree"),
        ),
      }));
      assert.equal(state.dialogs, 0, "the package opened a dialog");
      assert.ok(state.inside, "details are not inside the host");
      assert.equal(state.escaped, false, "the component escaped its host element");
    }),
  );

  // theming

  await check("colours are inherited from the host's tokens, in light and in dark", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await page.waitForSelector("#tree-b .dataset-tree__node");

      const read = () =>
        page.evaluate(() => {
          const tree = document.querySelector("#tree-b .dataset-tree");
          const style = getComputedStyle(tree);
          const rootStyle = getComputedStyle(document.documentElement);
          return {
            background: style.backgroundColor,
            surface: rootStyle.getPropertyValue("--surface").trim(),
            ink: rootStyle.getPropertyValue("--ink").trim(),
            color: style.color,
          };
        });

      const toRgb = (hex) => {
        const value = hex.replace("#", "");
        const n = parseInt(value, 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };

      const light = await read();
      assert.equal(light.background, toRgb(light.surface), "light background ignored --surface");
      assert.equal(light.color, toRgb(light.ink), "light text colour ignored --ink");

      await page.click("#theme");
      await page.waitForFunction(
        () => document.documentElement.getAttribute("data-theme") === "dark",
      );
      const dark = await read();
      assert.equal(dark.background, toRgb(dark.surface), "dark background ignored --surface");
      assert.notEqual(dark.background, light.background, "the theme toggle changed nothing");
    }),
  );

  await check("with no host tokens at all the component still paints itself", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await page.waitForSelector("#tree-b .dataset-tree__node");
      await page.click("#tokens");
      await page.waitForFunction(
        () => document.documentElement.getAttribute("data-tokens") === "off",
      );
      const painted = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector("#tree-b .dataset-tree"));
        return {
          background: style.backgroundColor,
          color: style.color,
          border: style.borderTopColor,
        };
      });
      // The package's own fallbacks, not "transparent" and not the host's ground.
      assert.equal(painted.background, "rgb(255, 255, 255)");
      assert.equal(painted.color, "rgb(23, 35, 34)");
      assert.notEqual(painted.border, "rgba(0, 0, 0, 0)");
    }),
  );

  // layout

  await check("the narrow container gets the compact layout, the wide one does not", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await waitForWideRoots(page);
      await page.click('#tree-a [data-dt-key="toggle:pg:reanalysis/surface"]');
      await page.waitForSelector('#tree-a [data-dataset-tree-id="pg:reanalysis/surface/readme"]', {
        timeout: 15_000,
      });
      await page.click('#tree-b [data-dt-key="toggle:pg:reanalysis"]');
      await page.click('#tree-b [data-dt-key="toggle:pg:reanalysis/surface"]');
      await page.waitForSelector('#tree-b [data-dataset-tree-id="pg:reanalysis/surface/readme"]');

      const shown = (selector) =>
        page.evaluate((sel) => {
          const node = document.querySelector(sel);
          return node ? getComputedStyle(node).display !== "none" : null;
        }, selector);

      // The compact layout is measured on the collection's inline description rather than on a
      // modification timestamp, because there is no timestamp column: a media type and a modified
      // time on every row buy two columns of near-identical text at the expense of the one column
      // that differs, so both live outside the row.
      //
      // The description is the right probe anyway - it is the widest optional thing a row carries,
      // and it is what a 320px container has to drop first.
      assert.equal(
        await shown('#tree-a [data-dataset-tree-id="pg:reanalysis"] .dataset-tree__sub'),
        true,
        "the wide container hid the collection description",
      );
      assert.equal(
        await shown('#tree-b [data-dataset-tree-id="pg:reanalysis"] .dataset-tree__sub'),
        false,
        "the 320px container did not switch to the compact layout",
      );
      // And the two columns that were dropped are gone from a wide row as well.
      assert.equal(
        await page.locator("#tree-a .dataset-tree__when").count(),
        0,
        "the modified column is back on the row",
      );
      assert.equal(
        await page.locator("#tree-a .dataset-tree__tag").count(),
        0,
        "the media-type tag is back on the row",
      );
    }),
  );

  await check(
    "nothing overflows its container at 360px, and the page does not scroll sideways",
    () =>
      withPage(
        async (page) => {
          await page.goto(base, { waitUntil: "load" });
          await page.waitForSelector("#tree-b .dataset-tree__node");
          await page.click('#tree-b [data-dt-key="toggle:pg:reanalysis"]');
          await page.waitForSelector('#tree-b [data-dataset-tree-id="pg:reanalysis/surface"]');
          const overflow = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            tree: [...document.querySelectorAll(".dataset-tree")].map(
              (t) => t.scrollWidth - t.clientWidth,
            ),
          }));
          assert.ok(overflow.page <= 1, `the page scrolls sideways by ${overflow.page}px`);
          for (const amount of overflow.tree) {
            assert.ok(amount <= 1, `a tree overflows its container by ${amount}px`);
          }
        },
        { viewport: { width: 360, height: 720 } },
      ),
  );

  await check("text at 200% zoom still fits without a horizontal scrollbar", () =>
    withPage(
      async (page) => {
        await page.goto(base, { waitUntil: "load" });
        await page.waitForSelector("#tree-b .dataset-tree__node");
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        assert.ok(overflow <= 1, `the page scrolls sideways by ${overflow}px at 200%`);
      },
      { viewport: { width: 800, height: 900 } },
    ),
  );

  // motion

  await check("reduced motion stops the spinner and the chevron transition", () =>
    withPage(
      async (page) => {
        await page.goto(base, { waitUntil: "load" });
        await waitForWideRoots(page);
        await page.click('#tree-a [data-dt-key="toggle:pg:reanalysis/surface"]');
        await page.waitForSelector("#tree-a .dataset-tree__spin", { timeout: 5_000 });

        const motion = await page.evaluate(() => {
          const spin = getComputedStyle(document.querySelector(".dataset-tree__spin"));
          const chev = getComputedStyle(document.querySelector(".dataset-tree__chev"));
          return { animation: spin.animationName, transition: chev.transitionProperty };
        });
        assert.equal(motion.animation, "none", "the spinner still animates under reduced motion");
        assert.equal(
          motion.transition,
          "none",
          "the chevron still transitions under reduced motion",
        );
      },
      { reducedMotion: "reduce" },
    ),
  );

  await check("without the preference, the spinner does animate", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await waitForWideRoots(page);
      await page.click('#tree-a [data-dt-key="toggle:pg:reanalysis/surface"]');
      await page.waitForSelector("#tree-a .dataset-tree__spin", { timeout: 5_000 });
      const animation = await page.evaluate(
        () => getComputedStyle(document.querySelector(".dataset-tree__spin")).animationName,
      );
      assert.equal(animation, "dataset-tree-spin");
    }),
  );

  // keyboard

  await check("the whole tree is operable from the keyboard alone", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await waitForWideRoots(page);

      // Tab from the document into the wide tree's filter field.
      const reached = await page.evaluate(async () => {
        const input = document.querySelector("#tree-a .dataset-tree__filter-input");
        input.focus();
        return document.activeElement === input;
      });
      assert.ok(reached, "the filter field is not focusable");

      // Tab to the first row and open it with Enter - no pointer involved.
      await page.keyboard.press("Tab"); // Collapse all
      await page.keyboard.press("Tab"); // first row
      const key = await page.evaluate(() => document.activeElement?.dataset.dtKey ?? null);
      assert.equal(key, "toggle:pg:reanalysis", `Tab landed on ${key}`);

      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          document
            .querySelector('#tree-a [data-dt-key="toggle:pg:reanalysis"]')
            ?.getAttribute("aria-expanded") === "false",
      );
      await page.keyboard.press(" ");
      await page.waitForFunction(
        () =>
          document
            .querySelector('#tree-a [data-dt-key="toggle:pg:reanalysis"]')
            ?.getAttribute("aria-expanded") === "true",
      );
    }),
  );

  await check("focus is visible on every control type", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await waitForWideRoots(page);
      for (const selector of [
        "#tree-a .dataset-tree__filter-input",
        '#tree-a [data-dt-key="collapse-all"]',
        '#tree-a [data-dt-key="toggle:pg:reanalysis"]',
      ]) {
        const visible = await page.evaluate((sel) => {
          const element = document.querySelector(sel);
          element.focus();
          const style = getComputedStyle(element);
          return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
        }, selector);
        assert.ok(visible, `${selector} has no visible focus ring`);
      }
    }),
  );

  await check("an indexed search finds an unopened branch, and makes no request for it", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await waitForWideRoots(page);

      // The playground's lazy tree never lists `ocean` on its own; the index names it.
      await page.fill("#tree-a .dataset-tree__filter-input", "sea-surface");
      await page.waitForSelector('#tree-a [data-dataset-tree-id="pg:ocean/sst"]');

      const seen = await page.evaluate(() => {
        const host = document.querySelector("#tree-a");
        const results = [...host.querySelectorAll(".dataset-tree__node--result")];
        return {
          ids: results.map((n) => n.dataset.datasetTreeId),
          trail: host.querySelector(".dataset-tree__trail")?.textContent ?? "",
          header: host.querySelector(".dataset-tree__results")?.textContent ?? "",
          hint: host.querySelector(".dataset-tree__hint")?.textContent ?? "",
          // The field keeps the caret while the list under it is replaced.
          focused: document.activeElement === host.querySelector(".dataset-tree__filter-input"),
        };
      });
      // Both match on title, so the tie-break decides: path, and `sos.zarr` sorts before `sst.zarr`.
      assert.deepEqual(seen.ids, ["pg:ocean/sos", "pg:ocean/sst"]);
      assert.match(seen.trail, /in Ocean/);
      assert.match(seen.header, /2 results/);
      assert.match(seen.hint, /whole indexed archive/);
      assert.match(seen.hint, /Index generated 2026-02-01/);
      assert.ok(seen.focused, "the search field lost focus while results updated");

      // And clearing it puts the tree back, with the branch that was open still open.
      await page.fill("#tree-a .dataset-tree__filter-input", "");
      await page.waitForSelector('#tree-a [data-dataset-tree-id="pg:reanalysis/surface"]');
      const gone = await page.evaluate(
        () => document.querySelectorAll("#tree-a .dataset-tree__node--result").length,
      );
      assert.equal(gone, 0, "the result list survived clearing the query");
    }),
  );

  // try in python

  // The run control, in a real browser.
  //
  // The unit suite already owns the rule that decides whether it exists. What only a browser can
  // answer is whether it is a real control on the page: reachable by Tab, big enough to hit on a
  // phone, and sitting in the action row above the snippet rather than inside the card with Copy.
  await check("Try in Python sits in the action row, is reachable, and sends no code", () =>
    withPage(
      async (page) => {
        await page.goto(base, { waitUntil: "load" });
        await page.waitForSelector("#tree-b .dataset-tree__node");
        await page.click('#tree-b [data-dt-key="toggle:pg:scenarios"]');
        await page.waitForSelector('#tree-b [data-dataset-tree-id="pg:scenarios/ssp126"]');
        await page.click('#tree-b [data-dt-key="activate:pg:scenarios/ssp126"]');
        await page.click('#tree-b [data-dt-key="disclose:pg:scenarios/ssp126"]');
        await page.waitForSelector("#tree-b .dataset-tree__codecard");

        const copy = '#tree-b [data-dt-key="example:pg:scenarios/ssp126"]';
        const tryIt = '#tree-b [data-dt-key="try:pg:scenarios/ssp126"]';
        await page.waitForSelector(tryIt);
        const box = await page.locator(tryIt).boundingBox();
        const copyBox = await page.locator(copy).boundingBox();
        assert.ok(copyBox, "Copy disappeared when the run control arrived");
        assert.ok(box.height >= 24, `the run control is only ${box.height}px tall`);

        // Run is an alternative to Inspect, so it belongs in the panel's action row; Copy acts on
        // the snippet, so it stays in the card's own title bar, below it.
        const placed = await page.evaluate(
          ([t, c]) => ({
            runInActions: !!document.querySelector(t).closest(".dataset-tree__actions"),
            runInCard: !!document.querySelector(t).closest(".dataset-tree__codecard"),
            copyInCard: !!document.querySelector(c).closest(".dataset-tree__codecard"),
          }),
          [tryIt, copy],
        );
        assert.ok(placed.runInActions, "the run control is not in the panel's action row");
        assert.ok(!placed.runInCard, "the run control is back inside the code card");
        assert.ok(placed.copyInCard, "Copy is not in the snippet's own title bar");
        assert.ok(box.y < copyBox.y, "the run control is not above the snippet it runs");

        // Reachable from the keyboard, and activated by the platform's own Enter.
        await page.focus('#tree-b [data-dt-key="activate:pg:scenarios/ssp126"]');
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => document.activeElement?.dataset?.dtAction ?? "");
        assert.equal(focused, "try-python", `Tab from Inspect landed on ${focused}`);
        await page.keyboard.press("Enter");
        const reported = await page.textContent("#inspector [data-inspector-target]");
        assert.match(reported, /^Try in Python -> /, `the press reported: ${reported}`);
        for (const fragment of ["import", "xarray", "open_zarr"]) {
          assert.ok(!reported.includes(fragment), `the event carried ${fragment}`);
        }

        // The template tab is Python, executable and registered, and still gets no control.
        await page.click('#tree-b [data-dt-key="tab:pg:scenarios/ssp126:2"]');
        await page.waitForSelector(tryIt, { state: "detached" });
        assert.ok(await page.locator(copy).count(), "Copy left with it");
      },
      { viewport: { width: 380, height: 760 } },
    ),
  );

  // axe

  for (const theme of ["light", "dark"]) {
    await check(`axe finds no violations (${theme})`, () =>
      withPage(async (page) => {
        await page.goto(base, { waitUntil: "load" });
        await waitForWideRoots(page);
        if (theme === "dark") {
          await page.click("#theme");
          await page.waitForFunction(
            () => document.documentElement.getAttribute("data-theme") === "dark",
          );
        }
        // Open a branch and a details panel so the scan covers more than the empty state.
        await page.click('#tree-b [data-dt-key="toggle:pg:scenarios"]');
        await page.waitForSelector('#tree-b [data-dataset-tree-id="pg:scenarios/ssp126"]');
        await page.click('#tree-b [data-dt-key="activate:pg:scenarios/ssp126"]');
        await page.waitForSelector("#tree-b .dataset-tree__details");
        // And the access disclosure, which is where Copy and the run control live.
        await page.click('#tree-b [data-dt-key="disclose:pg:scenarios/ssp126"]');
        await page.waitForSelector("#tree-b .dataset-tree__codecard");
        // And a search result list, which is markup the tree never draws otherwise.
        await page.fill("#tree-a .dataset-tree__filter-input", "sea-surface");
        await page.waitForSelector('#tree-a [data-dataset-tree-id="pg:ocean/sst"]');

        await page.addScriptTag({ content: AXE });
        const violations = await page.evaluate(async () => {
          const run = await window.axe.run(document.body, {
            resultTypes: ["violations"],
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
          });
          return run.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.slice(0, 4).map((n) => ({
              target: n.target.join(" "),
              summary: (n.failureSummary ?? "").split("\n").slice(0, 3).join(" / "),
            })),
          }));
        });
        assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
      }),
    );
  }
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
