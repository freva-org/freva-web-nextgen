// The maximized dataset browser: who owns the overlay, and who owns the pixels.
//
// A `z-index` on the block is not comparable with one on `body::after`: the block sits inside the
// landing's own stacking contexts, so its number orders it against its siblings while the body's
// is allocated in the root context. A larger `z-index` that still loses is exactly the failure
// this file exists to catch - a maximized browser painted under the page dim, its heading clipped
// by the header, its exit control hidden and the footer's Freva badge on top of it - and only the
// painted result can catch it. So `getComputedStyle().zIndex` is recorded because it is cheap,
// but what each check proves is `elementFromPoint`: which element the browser would hand a click
// at that coordinate.
//
// The fixture is `waterpark-shaped.mjs` - cosmos preset, a real header, a real footer, the Freva
// badge, and a catalogue with the shape of the reported one. A bare block on a blank page cannot
// show this defect, because the defect is entirely about the things around it.
//
// Usage:  node browser-tests/dataset-tree-overlay.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { buildWaterparkShaped } from "./waterpark-shaped.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const STRICT = process.env.BROWSER_STRICT === "1";
const SHOTS = process.env.FREVA_TREE_SHOTS ?? join(PKG, "reports", "dataset-tree-overlay");

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

/**
 * A console defined before the coordinator arrives, so the terminal opens without downloading an
 * interpreter. The layer question is about the WINDOW, not about Python.
 */
const STUB = `
  class StubConsole extends HTMLElement {
    connectedCallback() { this.style.display = "block"; this.style.minHeight = "80px";
      if (!this.firstChild) this.textContent = "stub console"; }
    async start() {}
    async execute() {}
    async runExample() {}
    transcript() { return ""; }
    focus() {}
    clear() {}
    clearHistory() {}
    async restart() {}
    dispose() {}
  }
  customElements.define("freva-python-console", StubConsole);
`;

const plainSite = buildWaterparkShaped({});
const pythonSite = buildWaterparkShaped({ python: true });

const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
const servers = [];
async function serve(dir) {
  const server = createPreviewServer({ dir, port: 0 });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
}
const PLAIN = await serve(plainSite);
const PYTHON = await serve(pythonSite);

let browser;
try {
  browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    executablePath: process.env.FREVA_PORTAL_CHROMIUM ?? "/opt/pw-browsers/chromium",
  });
} catch (error) {
  for (const s of servers) s.close();
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
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(
      `  FAIL ${name}\n       ${String(error.message).split("\n").slice(0, 5).join("\n       ")}`,
    );
  }
}

async function withPage(base, { viewport = DESKTOP, theme = "dark", stub = false } = {}, fn) {
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
  if (stub) await page.addInitScript(STUB);
  try {
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForSelector(".dataset-tree", { timeout: 20_000 });
    await fn(page, problems);
  } finally {
    await context.close();
  }
}

const maximize = async (page) => {
  await page.click("[data-portal-tree-expand]");
  await page.waitForSelector(".portal-sheet", { timeout: 10_000 });
  await page.waitForTimeout(250);
};

/** What the browser would hand a click at this point, as a readable name. */
const NAME_AT = (x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return "none";
  const own = el.closest(
    ".portal-sheet, .portal-sheet-backdrop, .portal-header, .portal-footer, .freva-term",
  );
  return own ? (own.className.toString().split(" ")[0] ?? own.tagName) : el.tagName.toLowerCase();
};

try {
  // the transaction

  await check("maximizing MOVES the same node into the overlay root, leaving a placeholder", () =>
    withPage(PLAIN, {}, async (page) => {
      const before = await page.evaluate(() => {
        const panel = document.querySelector("[data-portal-tree-panel]");
        // A property on the DOM node itself: it survives a move and cannot survive a remount.
        panel.__portalIdentity = "the-one-and-only";
        const parent = panel.parentElement;
        return {
          parentClass: parent.className,
          index: [...parent.children].indexOf(panel),
          siblings: parent.children.length,
        };
      });
      await maximize(page);
      const during = await page.evaluate(() => {
        const panel = document.querySelector("[data-portal-tree-panel]");
        const sheet = document.querySelector(".portal-sheet");
        const placeholder = document.querySelector(".portal-dataset-tree-placeholder");
        return {
          identity: panel.__portalIdentity ?? null,
          insideSheet: sheet.contains(panel),
          sheetParent: sheet.parentElement?.id,
          backdropSibling:
            document.querySelector(".portal-sheet-backdrop")?.parentElement === sheet.parentElement,
          placeholderIndex: placeholder
            ? [...placeholder.parentElement.children].indexOf(placeholder)
            : -1,
        };
      });
      assert.equal(during.identity, "the-one-and-only", "the node was recreated, not moved");
      assert.ok(during.insideSheet, "the panel is not inside the sheet");
      assert.equal(
        during.sheetParent,
        "portal-overlay-root",
        "the sheet is not in the overlay root",
      );
      assert.ok(during.backdropSibling, "the backdrop is not a sibling of the sheet");
      assert.equal(
        during.placeholderIndex,
        before.index,
        "the placeholder is not where the block was",
      );

      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      const after = await page.evaluate(() => {
        const panel = document.querySelector("[data-portal-tree-panel]");
        const parent = panel.parentElement;
        return {
          identity: panel.__portalIdentity ?? null,
          parentClass: parent.className,
          index: [...parent.children].indexOf(panel),
          siblings: parent.children.length,
          placeholders: document.querySelectorAll(".portal-dataset-tree-placeholder").length,
          sheets: document.querySelectorAll(".portal-sheet").length,
        };
      });
      assert.equal(after.identity, "the-one-and-only", "the node was recreated on the way back");
      assert.equal(after.parentClass, before.parentClass);
      assert.equal(after.index, before.index, "the block came back at a different position");
      assert.equal(after.siblings, before.siblings, "the placeholder was left behind");
      assert.equal(after.placeholders, 0);
      assert.equal(after.sheets, 0);
    }),
  );

  await check("expansion, selection, scroll and listeners all survive the move", () =>
    withPage(PLAIN, {}, async (page) => {
      // Open a branch and choose a node, then scroll the list somewhere non-trivial.
      await page.click('[data-dt-key="toggle:cordex"]');
      await page.click(
        '[data-dt-key="activate:eerie/eerie-future-ssp245-v20240618_P1M_mean_3.zarr"]',
      );
      await page.waitForTimeout(200);
      // `.dataset-tree__body` is the package's scrolling region - the one element whose
      // `scrollTop` a move does NOT carry, because a detached element's scroll offset is not
      // preserved by the platform, so the transaction restores it explicitly.
      const scroller = ".dataset-tree__body";
      const before = await page.evaluate((sel) => {
        const list = document.querySelector(sel);
        list.scrollTop = 240;
        return {
          scrollTop: list.scrollTop,
          // The TREE's own toggles only. The maximize control carries `aria-expanded` too, and it
          // legitimately flips on the way in - counting it would make this check about itself.
          open: [...document.querySelectorAll('[data-dt-key^="toggle:"][aria-expanded="true"]')]
            .map((e) => e.getAttribute("data-dt-key"))
            .sort(),
          chosen: document.querySelectorAll(".dataset-tree__details").length,
        };
      }, scroller);
      assert.ok(before.scrollTop > 0, "the list did not scroll, so the check would prove nothing");

      await maximize(page);
      const during = await page.evaluate((sel) => {
        const list = document.querySelector(sel);
        return {
          scrollTop: list.scrollTop,
          // The TREE's own toggles only. The maximize control carries `aria-expanded` too, and it
          // legitimately flips on the way in - counting it would make this check about itself.
          open: [...document.querySelectorAll('[data-dt-key^="toggle:"][aria-expanded="true"]')]
            .map((e) => e.getAttribute("data-dt-key"))
            .sort(),
          chosen: document.querySelectorAll(".dataset-tree__details").length,
        };
      }, scroller);
      assert.deepEqual(during.open, before.open, "an expanded branch closed on the way in");
      assert.equal(during.chosen, before.chosen, "the chosen node lost its detail panel");
      assert.equal(during.scrollTop, before.scrollTop, "the scroll offset was lost on the way in");

      // The listeners: a toggle still toggles, which nothing but a live listener can do.
      await page.click('[data-dt-key="toggle:dyamond"]');
      await page.waitForTimeout(150);
      assert.equal(
        await page.evaluate(() =>
          document.querySelector('[data-dt-key="toggle:dyamond"]').getAttribute("aria-expanded"),
        ),
        "true",
        "the tree stopped responding after the move",
      );

      // Re-read the offset before leaving. Opening a branch is a real state change and may move
      // the list; what the way OUT has to preserve is where the visitor is now, and asserting the
      // older number would be asserting that the tree never moves.
      const leaving = await page.evaluate((sel) => document.querySelector(sel).scrollTop, scroller);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      const after = await page.evaluate((sel) => {
        const list = document.querySelector(sel);
        return {
          scrollTop: list.scrollTop,
          chosen: document.querySelectorAll(".dataset-tree__details").length,
        };
      }, scroller);
      assert.equal(after.chosen, before.chosen, "the chosen node was lost on the way out");
      assert.equal(after.scrollTop, leaving, "the scroll offset was lost on the way out");
    }),
  );

  // ownership

  for (const [label, viewport] of [
    ["desktop", DESKTOP],
    ["920x650", COMPACT],
    ["mobile", MOBILE],
  ]) {
    for (const theme of ["light", "dark"]) {
      await check(`the sheet owns its own pixels (${label}, ${theme})`, () =>
        withPage(PLAIN, { viewport, theme }, async (page) => {
          await maximize(page);
          const seen = await page.evaluate((nameAtSource) => {
            const nameAt = new Function(`return (${nameAtSource})`)();
            const sheet = document.querySelector(".portal-sheet");
            const box = sheet.getBoundingClientRect();
            const header = document.querySelector(".portal-header").getBoundingClientRect();
            const z = (sel) => {
              const el = document.querySelector(sel);
              return el ? Number(getComputedStyle(el).zIndex) : null;
            };
            return {
              backdropZ: z(".portal-sheet-backdrop"),
              sheetZ: z(".portal-sheet"),
              topEdge: nameAt(box.left + box.width / 2, box.top + 4),
              middle: nameAt(box.left + box.width / 2, box.top + box.height / 2),
              bottomEdge: nameAt(box.left + box.width / 2, box.bottom - 4),
              leftEdge: nameAt(box.left + 4, box.top + box.height / 2),
              rightEdge: nameAt(box.right - 4, box.top + box.height / 2),
              overHeader: nameAt(window.innerWidth / 2, header.top + header.height / 2),
              outside: box.top > 8 ? nameAt(window.innerWidth / 2, 2) : null,
              sheetTop: box.top,
              headerBottom: header.bottom,
            };
          }, NAME_AT.toString());

          // The sheet owns every pixel of itself - the backdrop and the header own none of them.
          for (const [where, owner] of Object.entries({
            topEdge: seen.topEdge,
            middle: seen.middle,
            bottomEdge: seen.bottomEdge,
            leftEdge: seen.leftEdge,
            rightEdge: seen.rightEdge,
          })) {
            assert.equal(owner, "portal-sheet", `${where} is owned by ${owner}`);
          }
          // …and the backdrop owns the page, header included.
          assert.equal(
            seen.overHeader,
            "portal-sheet-backdrop",
            `the header pixel is ${seen.overHeader}`,
          );
          if (seen.outside !== null) {
            assert.equal(
              seen.outside,
              "portal-sheet-backdrop",
              `above the sheet is ${seen.outside}`,
            );
          }
          assert.ok(seen.sheetZ > seen.backdropZ, `${seen.sheetZ} is not above ${seen.backdropZ}`);
          // THE DELIBERATE HEADER CHOICE: the sheet begins cleanly below it, never under it.
          assert.ok(
            seen.sheetTop >= seen.headerBottom,
            `the sheet starts at ${seen.sheetTop}, above the header's ${seen.headerBottom}`,
          );
        }),
      );
    }
  }

  await check("the footer and the Freva badge stay behind the backdrop", () =>
    withPage(PLAIN, {}, async (page) => {
      await maximize(page);
      const seen = await page.evaluate((nameAtSource) => {
        const nameAt = new Function(`return (${nameAtSource})`)();
        const badge = document.querySelector(".portal-footer, footer");
        const box = badge?.getBoundingClientRect();
        const sheet = document.querySelector(".portal-sheet").getBoundingClientRect();
        return {
          // A point outside the sheet horizontally, low on the screen: the badge's own corner.
          corner: nameAt(Math.max(2, sheet.left / 2), window.innerHeight - 4),
          footerFound: Boolean(box),
        };
      }, NAME_AT.toString());
      assert.ok(seen.footerFound, "the fixture has no footer, so this proves nothing");
      assert.equal(
        seen.corner,
        "portal-sheet-backdrop",
        `the footer corner is owned by ${seen.corner}`,
      );
    }),
  );

  await check("nothing of the heading or the exit control is clipped, at any width", async () => {
    for (const [label, viewport] of [
      ["desktop", DESKTOP],
      ["920x650", COMPACT],
      ["mobile", MOBILE],
    ]) {
      await withPage(PLAIN, { viewport }, async (page) => {
        await maximize(page);
        const seen = await page.evaluate(() => {
          const block = document.querySelector('[data-expanded="true"]');
          const bar = block.querySelector(".portal-dataset-tree-bar");
          const heading = bar.querySelector(".portal-block-heading");
          const summary = bar.querySelector(".portal-dataset-tree-summary");
          // The exit control is a toolbar extra inside the component's own bar, so it is looked
          // for in the BLOCK rather than in the header. The question asked of it is unchanged: is
          // all of it inside the sheet.
          const control = block.querySelector(".portal-tree-expand");
          const sheet = document.querySelector(".portal-sheet").getBoundingClientRect();
          const inside = (el) => {
            const b = el.getBoundingClientRect();
            return b.top >= sheet.top - 1 && b.bottom <= sheet.bottom + 1 && b.height > 0;
          };
          return {
            barClipped: bar.scrollHeight > bar.clientHeight + 1,
            headingInside: inside(heading),
            summaryInside: inside(summary),
            controlInside: inside(control),
            controlLabel: (control.textContent ?? "").trim(),
          };
        });
        assert.equal(seen.barClipped, false, `${label}: the sheet header is clipped`);
        assert.ok(seen.headingInside, `${label}: the heading is outside the sheet`);
        assert.ok(seen.summaryInside, `${label}: the summary is outside the sheet`);
        assert.ok(seen.controlInside, `${label}: the exit control is outside the sheet`);
        assert.ok(
          seen.controlLabel.includes("Exit"),
          `${label}: the control still says ${seen.controlLabel}`,
        );
      });
    }
  });

  // the ways out

  for (const [name, exit] of [
    ["Escape", async (page) => page.keyboard.press("Escape")],
    ["the browser Back button", async (page) => page.goBack()],
    [
      "a click outside the sheet",
      async (page) => {
        const point = await page.evaluate(() => {
          const box = document.querySelector(".portal-sheet").getBoundingClientRect();
          return { x: Math.max(2, box.left / 2), y: Math.round(box.top + box.height / 2) };
        });
        await page.mouse.click(point.x, point.y);
      },
    ],
  ]) {
    await check(`${name} leaves full screen`, () =>
      withPage(PLAIN, {}, async (page) => {
        await maximize(page);
        await exit(page);
        await page.waitForTimeout(350);
        const seen = await page.evaluate(() => ({
          sheets: document.querySelectorAll(".portal-sheet").length,
          backdrops: document.querySelectorAll(".portal-sheet-backdrop").length,
          expanded: document.documentElement.hasAttribute("data-tree-expanded"),
          control: document
            .querySelector("[data-portal-tree-expand]")
            .getAttribute("aria-expanded"),
          focused: document.activeElement?.getAttribute("data-portal-tree-expand") !== null,
        }));
        assert.equal(seen.sheets, 0, "the sheet is still there");
        assert.equal(seen.backdrops, 0, "the backdrop is still there");
        assert.equal(seen.expanded, false);
        assert.equal(seen.control, "false");
        assert.ok(seen.focused, "the focus was not returned to the control");
      }),
    );
  }

  await check("the landing composition is exactly what it was before", () =>
    withPage(PLAIN, {}, async (page) => {
      const before = await page.evaluate(() => {
        const b = document.querySelector("[data-portal-tree-panel]").getBoundingClientRect();
        return {
          x: Math.round(b.x),
          y: Math.round(b.y),
          w: Math.round(b.width),
          h: Math.round(b.height),
        };
      });
      await maximize(page);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => {
        const b = document.querySelector("[data-portal-tree-panel]").getBoundingClientRect();
        return {
          x: Math.round(b.x),
          y: Math.round(b.y),
          w: Math.round(b.width),
          h: Math.round(b.height),
        };
      });
      assert.deepEqual(after, before, "the block came back somewhere else, or a different size");
    }),
  );

  // the terminal is above

  await check("the Python terminal stays above the maximized tree", () =>
    withPage(PYTHON, { stub: true }, async (page) => {
      // Open the terminal first, then maximize the tree over the page it is floating on.
      await page.click('[data-dt-key="toggle:cmip6"]').catch(() => undefined);
      await page.click(
        '[data-dt-key="activate:eerie/eerie-future-ssp245-v20240618_P1M_mean_0.zarr"]',
      );
      await page.waitForSelector(".dataset-tree__details", { timeout: 10_000 });
      await page.click(
        '[data-dt-key="disclose:eerie/eerie-future-ssp245-v20240618_P1M_mean_0.zarr"]',
      );
      await page.waitForSelector(".dataset-tree__codecard", { timeout: 10_000 });
      await page.click('[data-dt-key="try:eerie/eerie-future-ssp245-v20240618_P1M_mean_0.zarr"]');
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });

      await maximize(page);
      const seen = await page.evaluate((nameAtSource) => {
        const nameAt = new Function(`return (${nameAtSource})`)();
        const term = document.querySelector(".freva-term").getBoundingClientRect();
        const shell = document.querySelector(".portal-python-window");
        const sheet = document.querySelector(".portal-sheet");
        return {
          overTerminal: nameAt(term.left + term.width / 2, term.top + 6),
          terminalRoot: shell?.parentElement?.id,
          terminalZ: Number(getComputedStyle(shell).zIndex),
          sheetZ: Number(getComputedStyle(sheet).zIndex),
          termOverlapsSheet:
            term.left < sheet.getBoundingClientRect().right &&
            term.right > sheet.getBoundingClientRect().left,
        };
      }, NAME_AT.toString());
      assert.ok(
        seen.termOverlapsSheet,
        "the terminal is not over the sheet, so this proves nothing",
      );
      // The painted answer, not the number: the terminal owns its own pixels over the sheet.
      assert.equal(
        seen.overTerminal,
        "freva-term",
        `the terminal's own pixel is owned by ${seen.overTerminal}`,
      );
      assert.ok(
        seen.terminalZ > seen.sheetZ,
        `terminal ${seen.terminalZ} is not above sheet ${seen.sheetZ}`,
      );
    }),
  );

  // photographs

  await check(
    "photographs the normal and maximized states at every viewport and theme",
    async () => {
      mkdirSync(SHOTS, { recursive: true });
      for (const [label, viewport] of [
        ["desktop", DESKTOP],
        ["920x650", COMPACT],
        ["mobile", MOBILE],
      ]) {
        for (const theme of ["light", "dark"]) {
          await withPage(PLAIN, { viewport, theme }, async (page, problems) => {
            await page.waitForTimeout(900);
            await page.screenshot({ path: join(SHOTS, `${label}-${theme}-normal.png`) });
            await maximize(page);
            await page.waitForTimeout(500);
            await page.screenshot({ path: join(SHOTS, `${label}-${theme}-maximized.png`) });
            assert.deepEqual(problems, [], problems.join(" | "));
          });
        }
      }
      assert.ok(existsSync(join(SHOTS, "desktop-dark-maximized.png")));
      console.log(`       screenshots in ${SHOTS}`);
    },
  );
} finally {
  await browser.close();
  for (const s of servers) s.close();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} dataset-tree overlay checks passed`,
);
process.exit(failed.length > 0 ? 1 : 0);
