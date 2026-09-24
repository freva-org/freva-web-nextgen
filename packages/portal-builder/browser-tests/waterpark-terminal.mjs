// The dataset tree's depth and the Python terminal's chrome, with a REAL interpreter.
//
// Every claim here is about pixels or about focus, and only a real browser in front of real
// output can settle one: whether a child row begins to the right of its parent, whether the
// terminal fills a maximized window or floats at the top of one, whether the title bar's groups
// are on the sides they belong on, whether a confirmation is the browser's own blocking dialog
// or the window's, and - the one that cannot be faked at all - whether a fresh prompt is visible,
// focused and usable after a traceback. So nothing here is stubbed: `python-playground.mjs`
// stubs the console because it is testing the coordinator, but a stub can agree with a
// coordinator that is wrong about what a console does, and error recovery is exactly that kind
// of claim. This suite starts the pinned Pyodide distribution from
// `packages/browser-python/.runtime`, served over TLS at an origin the artifact was built for.
//
// The fixture is `waterpark-shaped.mjs` - cosmos preset, a header, a footer, the Freva badge, and
// a catalogue with the reported archive's own seven levels. A bare page cannot show an
// indentation defect that is about the relationship between rows, and a bare window cannot show a
// terminal that fails to fill one.
//
// Usage:  node browser-tests/waterpark-terminal.mjs
//         FREVA_ONLY=<substring> node browser-tests/waterpark-terminal.mjs   (one check)

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { buildWaterparkShaped } from "./waterpark-shaped.mjs";
import { certificate, serveTls, portalPolicy, chromiumArgs } from "./fixtures/tls-origins.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const REPO = resolve(PKG, "..", "..");
const STRICT = process.env.BROWSER_STRICT === "1";
const ONLY = process.env.FREVA_ONLY;
const RUNTIME =
  process.env.FREVA_PYODIDE_RUNTIME ?? join(REPO, "packages", "browser-python", ".runtime");
const SHOTS = process.env.FREVA_TERM_SHOTS ?? join(PKG, "reports", "waterpark-terminal");

function skip(message) {
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

if (!existsSync(join(RUNTIME, "pyodide.js"))) {
  skip(
    `no local Pyodide runtime at ${RUNTIME}. Prepare it with ` +
      "`node bin/freva-browser-python.mjs prepare-runtime --out .runtime` in packages/browser-python.",
  );
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  skip(`playwright is not installed: ${error.message}`);
}

// the archive

/** The reported path, level by level. Seven nodes, six of them expandable. */
const ROOT = "cmip6";
const PATH = [
  ROOT,
  `${ROOT}/healpix`,
  `${ROOT}/healpix/cmip6`,
  `${ROOT}/healpix/cmip6/historical-r10i1p1f2`,
  `${ROOT}/healpix/cmip6/historical-r10i1p1f2/cnrm-cm6-1`,
  `${ROOT}/healpix/cmip6/historical-r10i1p1f2/cnrm-cm6-1/P1M`,
];
const LEAF = `${PATH[PATH.length - 1]}/level_0.zarr`;

// the origins

const RUN = mkdtempSync(join(tmpdir(), `wp-term-${Date.now()}-`));
const HOSTS = { portal: "waterpark.example.org", runtime: "runtime.example.org" };
let tls;
try {
  tls = certificate(join(RUN, "tls"), Object.values(HOSTS));
} catch (error) {
  skip(`openssl could not make a certificate: ${error.message}`);
}

mkdirSync(join(RUN, "site"), { recursive: true });
const runtimeServer = await serveTls(tls, HOSTS.runtime, {
  dir: RUNTIME,
  headers: { "access-control-allow-origin": "*" },
});
const portalServer = await serveTls(tls, HOSTS.portal, { dir: join(RUN, "site"), headers: {} });

// Built FOR the origin it will be served at: the recorded policy names it, and a portal served
// somewhere else fails its own CSP in ways that read as unrelated bugs.
const built = buildWaterparkShaped({
  canonicalUrl: portalServer.base,
  python: { runtimeIndexUrl: runtimeServer.base },
  outDir: join(RUN, "built"),
});
cpSync(built, join(RUN, "site"), { recursive: true });
portalServer.state.headers = { "content-security-policy": portalPolicy(built) };
console.log(`portal ${portalServer.origin} · runtime ${runtimeServer.origin}`);
console.log(`run dir ${RUN}`);

async function shutdown() {
  portalServer.server.close();
  runtimeServer.server.close();
}

let browser;
try {
  browser = await chromium.launch({
    args: chromiumArgs(Object.values(HOSTS)),
    executablePath: process.env.FREVA_PORTAL_CHROMIUM ?? "/opt/pw-browsers/chromium",
  });
} catch (error) {
  await shutdown();
  skip(`chromium would not launch: ${error.message}`);
}

const DESKTOP = { width: 1571, height: 899 };
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

/**
 * One page, with every diagnostic attached before it navigates. `nativeDialogs` replaces
 * `confirm`, `alert` and `prompt` with functions that THROW: nothing in this product may call
 * them, and a test that merely asserted a nicer dialog appeared would still pass against code
 * that called `confirm()` first and drew the sheet afterwards. A throw is the only assertion that
 * cannot be satisfied by accident.
 */
async function withPage(options, fn) {
  const { viewport = DESKTOP, colorScheme = "dark", theme = "dark" } = options;
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport,
    colorScheme,
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text().slice(0, 200));
  });
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("freva.portal.theme", t);
    } catch {
      // a context that refuses storage still renders
    }
    // THE ENGINE'S OWN STATE, recorded from the event the console emits. A live `.cmd` appears
    // the moment the terminal mounts - minutes before the interpreter exists - and lines typed in
    // that window are QUEUED, with the interactive queue keeping only the most recent, so an
    // earlier `kept = 42` is silently replaced by the line meant to read it back. The status
    // event is the only thing that says "there is an interpreter and it is idle".
    window.__pyStates = [];
    document.addEventListener("browser-python-status", (event) => {
      window.__pyStates.push(event.detail?.state);
    });
    window.__nativeDialogCalls = [];
    for (const name of ["confirm", "alert", "prompt"]) {
      Object.defineProperty(window, name, {
        configurable: true,
        writable: true,
        value: (...args) => {
          window.__nativeDialogCalls.push(`${name}(${String(args[0] ?? "").slice(0, 60)})`);
          throw new Error(`window.${name}() was called`);
        },
      });
    }
  }, theme);
  try {
    await page.goto(portalServer.base, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".dataset-tree", { timeout: 30_000 });
    await fn(page, problems);
    const calls = await page.evaluate(() => window.__nativeDialogCalls ?? []);
    assert.deepEqual(calls, [], `native browser dialogs were used: ${calls.join(", ")}`);
  } finally {
    await context.close();
  }
}

/** Walk down the reported path, opening only what is not already open. */
async function openPath(page) {
  for (const id of PATH) {
    const sel = `[data-dt-row="${id}"]`;
    await page.waitForSelector(sel, { timeout: 20_000 });
    if ((await page.getAttribute(sel, "aria-expanded")) !== "true") await page.click(sel);
    await page.waitForTimeout(160);
  }
  await page.waitForSelector(`[data-dt-row="${LEAF}"]`, { timeout: 20_000 });
}

/** Where each row's chevron, icon and label actually start, and what depth it claims. */
async function depths(page, ids) {
  return page.evaluate((list) => {
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
}

/** Open the leaf's access panel and press Try in Python; resolve once the window is on screen. */
async function openTerminal(page) {
  await page.click(`[data-dt-row="${LEAF}"]`);
  await page.waitForSelector(`[data-dt-key="disclose:${LEAF}"]`, { timeout: 20_000 });
  await page.click(`[data-dt-key="disclose:${LEAF}"]`);
  await page.waitForSelector(`[data-dt-key="try:${LEAF}"]`, { timeout: 20_000 });
  await page.click(`[data-dt-key="try:${LEAF}"]`);
  await page.waitForSelector(".freva-term.show", { timeout: 30_000 });
}

/** Resolve once the interpreter is up and the prompt is live. */
async function waitReady(page, timeout = 240_000) {
  await page.waitForFunction(
    () => {
      const states = window.__pyStates ?? [];
      if (states[states.length - 1] !== "ready") return false;
      const el = document.querySelector("freva-python-console");
      const root = el?.shadowRoot;
      return (
        Boolean(root?.querySelector(".cmd")) && !root.querySelector(".terminal.terminal-paused")
      );
    },
    null,
    { timeout },
  );
  // The prompt is redrawn on the frame after the state settles; one more lands the layout.
  await page.waitForTimeout(500);
}

/** Type a line into the live prompt and wait for the interpreter to finish with it. */
async function run(page, source, { settle = 1500 } = {}) {
  await page.evaluate(() => {
    document.querySelector("freva-python-console")?.focus();
  });
  await page.keyboard.type(source);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(settle);
}

/**
 * Run a whole program, the way `Try in Python` does. `run` types at the prompt, and a REPL prompt
 * is line-at-a-time: `for i in range(400): print(i)` typed there opens a `...` continuation and
 * executes nothing until a blank line closes it. A program with a body goes through `execute`,
 * the same path a registered example takes, which has file semantics.
 */
async function exec(page, source, { settle = 2500 } = {}) {
  await page.evaluate((text) => {
    void document.querySelector("freva-python-console").execute(text);
  }, source);
  await page.waitForTimeout(settle);
}

/** The console's plain-text transcript, as the product itself reports it. */
const transcript = (page) =>
  page.evaluate(() => document.querySelector("freva-python-console")?.transcript() ?? "");

/**
 * Where the live prompt is, and whether it is inside the box the reader can see. The live prompt
 * is jQuery Terminal's `.cmd`, one element and never part of the scrolled-back transcript:
 * finding `>>>` somewhere in the text proves nothing about whether the ACTIVE one is on screen,
 * which is the whole of what was reported.
 */
const promptGeometry = (page) =>
  page.evaluate(() => {
    const el = document.querySelector("freva-python-console");
    const root = el.shadowRoot;
    const scroller = root.querySelector(".bp-transcript");
    const cmds = root.querySelectorAll(".cmd");
    const cmd = cmds[cmds.length - 1];
    if (!scroller || !cmd) return null;
    const box = scroller.getBoundingClientRect();
    const line = cmd.getBoundingClientRect();
    const caret = cmd.querySelector(".cmd-cursor") ?? cmd;
    const cbox = caret.getBoundingClientRect();
    return {
      cmdCount: cmds.length,
      promptText: (cmd.querySelector(".cmd-prompt")?.textContent ?? "").trim(),
      visible: line.top >= box.top - 1 && line.bottom <= box.bottom + 1,
      caretVisible: cbox.top >= box.top - 1 && cbox.bottom <= box.bottom + 1,
      focusInside: root.activeElement !== null,
      paused: Boolean(root.querySelector(".terminal.terminal-paused")),
      jumpShown: !root.querySelector(".bp-jump")?.hidden,
      scrollTop: Math.round(scroller.scrollTop),
      scrollMax: Math.round(scroller.scrollHeight - scroller.clientHeight),
    };
  });

/**
 * Assert the console recovered: whole traceback, one live prompt, visible and usable. `focus` is
 * a parameter rather than an always-on assertion, and the distinction is the contract rather than
 * a convenience. Output the reader CAUSED - a line they typed, a Try press they made - must leave
 * the caret where they can carry on typing; output that merely ARRIVED must not reach into the
 * page and take the focus from wherever they actually are. Both are checked, separately, because
 * they are opposite requirements.
 */
async function assertRecovered(page, expected, { focus = true } = {}) {
  const text = await transcript(page);
  for (const fragment of expected) {
    assert.ok(text.includes(fragment), `the transcript is missing ${JSON.stringify(fragment)}`);
  }
  const prompt = await promptGeometry(page);
  assert.ok(prompt, "there is no live prompt at all");
  assert.equal(prompt.cmdCount, 1, `${prompt.cmdCount} live prompts after the error`);
  assert.equal(prompt.promptText, ">>>", `the prompt reads ${JSON.stringify(prompt.promptText)}`);
  assert.equal(prompt.paused, false, "the session is still busy");
  assert.ok(prompt.visible, "the new prompt is outside the visible transcript");
  assert.ok(prompt.caretVisible, "the caret is outside the visible transcript");
  if (focus) assert.ok(prompt.focusInside, "the keyboard focus is not in the console");
}

try {
  // the tree's depth

  await check("every level of the archive begins to the right of the one above it", () =>
    withPage({}, async (page) => {
      await openPath(page);
      const rows = await depths(page, [...PATH, LEAF]);
      assert.ok(
        rows.every((r) => !r.missing),
        `rows missing: ${rows
          .filter((r) => r.missing)
          .map((r) => r.id)
          .join(", ")}`,
      );

      // The STEP is measured from the first pair and then required of every pair, which makes
      // this a test of one recursive rule rather than of seven hand-placed levels. The reported
      // defect was precisely a first pair whose step was zero while the rest were not.
      const step = rows[1].chev - rows[0].chev;
      assert.ok(step >= 8, `the first child steps in by only ${step}px`);
      for (let i = 1; i < rows.length; i += 1) {
        const previous = rows[i - 1];
        const row = rows[i];
        for (const part of ["chev", "icon", "name"]) {
          const delta = row[part] - previous[part];
          assert.ok(
            Math.abs(delta - step) <= 2,
            `${part} moved ${delta}px from ${previous.id} to ${row.id}, expected ${step}px`,
          );
        }
        // The number a screen reader is told is the number the eye is shown.
        assert.equal(row.level, previous.level + 1, `aria-level jumped at ${row.id}`);
      }
      assert.equal(rows[0].level, 1, "the roots are not aria-level 1");
      // Folders, datasets and files are measured together on purpose: the leaf is a `.zarr` store
      // and it has to land on the same column its sibling folders would have.
      assert.equal(rows[rows.length - 1].level, rows.length, "the leaf's level is wrong");
    }),
  );

  await check("a narrow viewport keeps a smaller step, and never collapses two levels", () =>
    withPage({ viewport: MOBILE }, async (page) => {
      await openPath(page);
      const rows = await depths(page, [...PATH, LEAF]);
      const steps = rows.slice(1).map((row, i) => row.icon - rows[i].icon);
      assert.ok(
        steps.every((s) => s >= 6),
        `a level collapsed on mobile: steps ${steps.join(", ")}`,
      );
      const first = steps[0];
      assert.ok(
        steps.every((s) => Math.abs(s - first) <= 2),
        `mobile steps are uneven: ${steps.join(", ")}`,
      );
      // Smaller than the desktop step, which is the only reason the media query exists.
      assert.ok(first < 17, `the mobile step is ${first}px, no smaller than desktop`);
    }),
  );

  // the terminal's chrome

  await check("there is no standing Python control anywhere on the page", () =>
    withPage({}, async (page) => {
      await page.waitForTimeout(800);
      // NEITHER LAUNCHER, and both are worth naming. A floating pill in the bottom-right corner
      // of every page overlaps the dataset tree and the footer and cannot be dismissed; a
      // `Python` button in the dataset-tree block's header row is a lone control above a panel
      // about datasets, which is not where a page's entry point to an interpreter belongs. The
      // way in is a `Try in Python` control beside a runnable recipe.
      assert.equal(
        await page.locator("[data-portal-python-launcher]").count(),
        0,
        "the bottom-right Python launcher is still on the page",
      );
      assert.equal(
        await page.locator("[data-portal-python-entry]").count(),
        0,
        "a standing Python control is still drawn in the block toolbar",
      );
    }),
  );

  await check("the title bar is window controls and title left, Copy, Transcript and ⋮ right", () =>
    withPage({}, async (page) => {
      await openPath(page);
      await openTerminal(page);
      const bar = await page.evaluate(() => {
        const names = (sel) =>
          [...document.querySelectorAll(`.freva-term ${sel} > *`)].map(
            (n) => String(n.className).split(" ")[0],
          );
        const box = (sel) => document.querySelector(`.freva-term ${sel}`).getBoundingClientRect();
        return {
          start: names(".term-bar-start"),
          end: names(".term-bar-end"),
          startRight: box(".term-bar-start").right,
          endLeft: box(".term-bar-end").left,
          kebabRight: box(".term-kebab").right,
          barRight: box(".term-bar").right,
          endChildren: [...document.querySelectorAll(".freva-term .term-bar-end > *")].map(
            (n) => String(n.className).split(" ")[0],
          ),
        };
      });
      assert.ok(bar.start.includes("traffic"), `the window controls are not left: ${bar.start}`);
      assert.ok(
        bar.start.some((c) => c.startsWith("portal-python-")),
        `the session title is not left: ${bar.start}`,
      );
      assert.deepEqual(
        bar.end,
        ["copy-btn", "term-kebab"],
        `the right group is ${bar.end.join(", ")}`,
      );
      // The ⋮ is the last application control in the row, at the right edge of the bar.
      assert.equal(bar.endChildren[bar.endChildren.length - 1], "term-kebab");
      assert.ok(bar.barRight - bar.kebabRight < 24, "the ⋮ menu is not at the right edge");
      // And the two groups really are on opposite sides, with the gap between them.
      assert.ok(bar.endLeft > bar.startRight, "the two title-bar groups are not separated");
    }),
  );

  for (const scheme of ["light", "dark"]) {
    await check(`the maximized terminal is one continuous surface (${scheme})`, () =>
      withPage({ colorScheme: scheme, theme: scheme }, async (page) => {
        await openPath(page);
        await openTerminal(page);
        await waitReady(page);
        await page.click(".freva-term .tl.zoom");
        await page.waitForTimeout(600);

        const geometry = await page.evaluate(() => {
          const term = document.querySelector(".freva-term");
          const body = term.querySelector(".term-body");
          const console_ = document.querySelector("freva-python-console");
          const container = console_.shadowRoot.querySelector(".bp-container");
          const scroller = console_.shadowRoot.querySelector(".bp-transcript");
          const b = (n) => {
            const r = n.getBoundingClientRect();
            return {
              top: Math.round(r.top),
              bottom: Math.round(r.bottom),
              h: Math.round(r.height),
            };
          };
          const paint = getComputedStyle(container).backgroundColor;
          // What the browser would hand a click at the very bottom of the window's body.
          const bodyBox = body.getBoundingClientRect();
          const atFloor = document.elementFromPoint(
            Math.round(bodyBox.left + bodyBox.width / 2),
            Math.round(bodyBox.bottom - 4),
          );
          return {
            body: b(body),
            container: b(container),
            scroller: b(scroller),
            containerMaxHeight: getComputedStyle(container).maxHeight,
            paint,
            floorIsConsole: atFloor?.tagName?.toLowerCase() ?? "none",
          };
        });

        // THE TEST IS THE FLOOR, not the numbers beside it. A console that reaches "most of the
        // way" is a short card at the top with several hundred pixels of the window's own
        // background underneath. So: the terminal's own surface has to reach the bottom edge of
        // the body, and the element the browser would hand a click four pixels above that edge
        // has to be the console.
        assert.ok(
          Math.abs(geometry.container.bottom - geometry.body.bottom) <= 2,
          `the terminal stops ${geometry.body.bottom - geometry.container.bottom}px short of the window body`,
        );
        assert.ok(
          Math.abs(geometry.scroller.bottom - geometry.body.bottom) <= 2,
          "the transcript scroller does not reach the bottom of the body",
        );
        assert.equal(
          geometry.containerMaxHeight,
          "none",
          `the terminal still carries max-height ${geometry.containerMaxHeight}`,
        );
        assert.equal(
          geometry.floorIsConsole,
          "freva-python-console",
          `the bottom of the window body is owned by ${geometry.floorIsConsole}`,
        );
        // Its own theme paints the whole of it: no window background showing through.
        assert.ok(
          /^rgb\(/.test(geometry.paint),
          `the terminal surface is not opaque: ${geometry.paint}`,
        );

        // Long output scrolls INSIDE the terminal rather than growing or clipping the window.
        const before = geometry.body.h;
        await exec(page, "for i in range(400):\n    print('line', i)\n", { settle: 4000 });
        const after = await page.evaluate(() => {
          const term = document.querySelector(".freva-term");
          const body = term.querySelector(".term-body");
          const scroller = document
            .querySelector("freva-python-console")
            .shadowRoot.querySelector(".bp-transcript");
          return {
            bodyHeight: Math.round(body.getBoundingClientRect().height),
            overflowing: scroller.scrollHeight > scroller.clientHeight + 4,
            windowBottom: Math.round(term.getBoundingClientRect().bottom),
            viewport: window.innerHeight,
          };
        });
        assert.equal(after.bodyHeight, before, "long output changed the window's height");
        assert.ok(after.overflowing, "400 lines did not overflow the transcript");
        assert.ok(after.windowBottom <= after.viewport + 2, "the window grew past the viewport");
        // Nobody typed this: it ran programmatically while the focus sat on the maximize
        // control. The last line has to be on screen, the caret has to be inside the viewport,
        // and the focus has to stay exactly where the reader left it.
        await assertRecovered(page, ["line 399"], { focus: false });
        assert.equal(
          await page.evaluate(
            () => document.activeElement?.className?.toString?.().split(" ")[0] ?? "",
          ),
          "tl",
          "output that nobody asked for pulled the focus into the console",
        );
      }),
    );
  }

  await check("minimize and restore keep the same window and the same session", () =>
    withPage({}, async (page) => {
      await openPath(page);
      await openTerminal(page);
      await waitReady(page);
      await run(page, "kept = 41 + 1");

      await page.click(".freva-term .tl.min");
      await page.waitForTimeout(400);
      const docked = await page.evaluate(() => {
        const term = document.querySelector(".freva-term");
        return {
          minimized: term.classList.contains("minimized"),
          shown: term.classList.contains("show"),
          // Its OWN title bar is still the thing on screen - not a separate launcher.
          barVisible: term.querySelector(".term-bar").getBoundingClientRect().height > 0,
          bodyVisible: term.querySelector(".term-body").getBoundingClientRect().height > 0,
          consoles: document.querySelectorAll("freva-python-console").length,
          entryShown: document.querySelectorAll("[data-portal-python-entry]").length > 0,
        };
      });
      assert.ok(docked.minimized && docked.shown, "the window did not minimize");
      assert.ok(docked.barVisible, "the minimized window lost its title bar");
      assert.ok(!docked.bodyVisible, "the minimized window did not collapse to its chrome");
      assert.equal(docked.consoles, 1, "minimizing replaced the session");
      assert.ok(!docked.entryShown, "a separate launcher appeared beside the minimized window");

      await page.click(".freva-term .tl.min");
      await page.waitForTimeout(400);
      await run(page, "print('kept is', kept)");
      const text = await transcript(page);
      assert.ok(
        text.includes("kept is 42"),
        `the interpreter did not survive minimize/restore; transcript tail: ${JSON.stringify(text.slice(-400))}`,
      );
    }),
  );

  // confirmations

  await check("the session confirmations are the window's own, by mouse and by keyboard", () =>
    withPage({}, async (page) => {
      await openPath(page);
      await openTerminal(page);
      await waitReady(page);
      await run(page, "marker = 'original'");

      const openMenu = async () => {
        await page.click(".freva-term .term-kebab");
        await page.waitForSelector(".freva-term .term-menu.show", { timeout: 5_000 });
      };
      const dialog = () => page.locator(".freva-term .term-confirm");

      // restart, cancelled with the mouse: nothing changes.
      await openMenu();
      await page.locator(".freva-term .tmn-item", { hasText: "Restart session" }).click();
      await dialog().waitFor({ state: "visible", timeout: 5_000 });
      const shape = await page.evaluate(() => {
        const panel = document.querySelector(".freva-term .term-confirm");
        const root = document.querySelector(".freva-term");
        const named = panel.getAttribute("aria-labelledby");
        const described = panel.getAttribute("aria-describedby");
        return {
          role: panel.getAttribute("role"),
          modal: panel.getAttribute("aria-modal"),
          title: root.querySelector(`#${named}`)?.textContent ?? "",
          body: root.querySelector(`#${described}`)?.textContent ?? "",
          focused: document.activeElement?.textContent?.trim() ?? "",
          menuOpen: Boolean(root.querySelector(".term-menu.show")),
          buttons: [...panel.querySelectorAll("button")].map((b) => b.textContent.trim()),
          danger: Boolean(panel.querySelector(".term-confirm-danger")),
        };
      });
      assert.equal(shape.role, "alertdialog");
      assert.equal(shape.modal, "true");
      assert.match(shape.title, /^Restart Session 1\?$/);
      assert.equal(
        shape.body,
        "Its variables, imports and in-memory interpreter state will be lost.",
      );
      assert.deepEqual(shape.buttons, ["Cancel", "Restart session"]);
      assert.equal(shape.focused, "Cancel", `${shape.focused} was focused, not Cancel`);
      assert.equal(shape.menuOpen, false, "the settings menu stayed open behind the dialog");
      assert.ok(shape.danger, "the destructive answer is not treated as destructive");

      await page.locator(".freva-term .term-confirm-btn", { hasText: "Cancel" }).click();
      await dialog().waitFor({ state: "hidden", timeout: 5_000 });
      // Focus went back to the row that raised it, and the interpreter is untouched.
      const returned = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
      assert.match(returned, /Restart session/, `focus went to ${JSON.stringify(returned)}`);
      await run(page, "print('marker is', marker)");
      assert.ok((await transcript(page)).includes("marker is original"), "Cancel restarted anyway");

      // restart, cancelled with Escape.
      await openMenu();
      await page.locator(".freva-term .tmn-item", { hasText: "Restart session" }).click();
      await dialog().waitFor({ state: "visible", timeout: 5_000 });
      await page.keyboard.press("Escape");
      await dialog().waitFor({ state: "hidden", timeout: 5_000 });
      await run(page, "print('still', marker)");
      assert.ok((await transcript(page)).includes("still original"), "Escape restarted anyway");

      // Tab is trapped between the two buttons and nowhere else.
      await openMenu();
      await page.locator(".freva-term .tmn-item", { hasText: "Restart session" }).click();
      await dialog().waitFor({ state: "visible", timeout: 5_000 });
      const cycle = [];
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press("Tab");
        cycle.push(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
      }
      assert.deepEqual(
        cycle,
        ["Restart session", "Cancel", "Restart session", "Cancel"],
        `Tab escaped the dialog: ${cycle.join(" → ")}`,
      );

      // confirmed with the keyboard: exactly one restart.
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");
      await dialog().waitFor({ state: "hidden", timeout: 10_000 });
      await waitReady(page);
      await run(page, "print('after restart', 'marker' in dir())");
      const text = await transcript(page);
      assert.ok(
        text.includes("after restart False"),
        "the restart did not happen, or did not land",
      );
      assert.equal(
        await page.evaluate(() => document.querySelectorAll("freva-python-console").length),
        1,
        "the restart produced a second console",
      );
    }),
  );

  await check("a new session is asked for once, named, and never started twice", () =>
    withPage({}, async (page) => {
      await openPath(page);
      await openTerminal(page);
      await waitReady(page);

      await page.click(".freva-term .term-kebab");
      await page.waitForSelector(".freva-term .term-menu.show");
      await page.locator(".freva-term .tmn-item", { hasText: "New session" }).click();
      await page.locator(".freva-term .term-confirm").waitFor({ state: "visible", timeout: 5_000 });
      const shape = await page.evaluate(() => {
        const panel = document.querySelector(".freva-term .term-confirm");
        const root = document.querySelector(".freva-term");
        return {
          title: root.querySelector(`#${panel.getAttribute("aria-labelledby")}`).textContent,
          body: root.querySelector(`#${panel.getAttribute("aria-describedby")}`).textContent,
          buttons: [...panel.querySelectorAll("button")].map((b) => b.textContent.trim()),
        };
      });
      assert.equal(shape.title, "Start another Python session?");
      assert.equal(
        shape.body,
        "It runs an independent WebAssembly interpreter, consumes additional CPU and memory, " +
          "and does not share variables with Session 1.",
      );
      assert.deepEqual(shape.buttons, ["Cancel", "Start session"]);

      // PRESSED TWICE, as fast as the page will take it. A confirmation that resolves once per
      // press starts two interpreters for one intention, which is the expensive mistake this
      // dialog exists to prevent, so the double press is the test rather than an edge case.
      const button = page.locator(".freva-term .term-confirm-btn", { hasText: "Start session" });
      await button.click();
      await page.waitForTimeout(1_500);
      assert.equal(
        await page.evaluate(() => document.querySelectorAll("freva-python-console").length),
        2,
        "confirming did not start exactly one session",
      );

      // At the ceiling the row explains itself instead of raising a question that cannot succeed.
      await page.click(".freva-term .term-kebab");
      await page.waitForSelector(".freva-term .term-menu.show");
      const row = await page.evaluate(() => {
        const item = [...document.querySelectorAll(".freva-term .tmn-item")].find((n) =>
          n.textContent.includes("New session"),
        );
        return { text: item.textContent.trim(), disabled: item.disabled };
      });
      assert.match(row.text, /limit of 2 reached/);
      assert.equal(row.disabled, true);
      assert.equal(
        await page.locator(".freva-term .term-confirm").count(),
        0,
        "a confirmation was raised for an action that cannot succeed",
      );
    }),
  );

  // error recovery

  await check("an import error leaves a visible, focused, usable prompt", () =>
    withPage({}, async (page) => {
      await openPath(page);
      await openTerminal(page);
      await waitReady(page);

      await run(page, "kept = 'survivor'");
      await run(page, "import definitely_missing_package", { settle: 2500 });
      await assertRecovered(page, [
        "Traceback (most recent call last):",
        "ModuleNotFoundError",
        "definitely_missing_package",
      ]);

      // The SAME interpreter: the value defined before the error is still there.
      await run(page, "print('kept is', kept)");
      assert.ok(
        (await transcript(page)).includes("kept is survivor"),
        "recovery replaced the interpreter",
      );
    }),
  );

  await check(
    "a long traceback, a failed await and a failed example all recover the same way",
    () =>
      withPage({}, async (page) => {
        await openPath(page);
        await openTerminal(page);
        await waitReady(page);
        await run(page, "kept = 'survivor'");

        // 1. A traceback taller than the window.
        await exec(page, "def deep(n):\n    return 1 if n == 0 else deep(n - 1) + deep.missing\n", {
          settle: 1_500,
        });
        await run(page, "deep(30)", { settle: 4_000 });
        await assertRecovered(page, ["AttributeError"]);

        // 2. A top-level await that raises.
        await run(page, "import asyncio", { settle: 1_500 });
        await run(page, "await asyncio.sleep(0) or (1 / 0)", { settle: 2_500 });
        await assertRecovered(page, ["ZeroDivisionError"]);

        // 3. A registered example that fails - the Try in Python path, not the prompt.
        await page.evaluate(() => {
          const key = [...document.querySelectorAll("[data-dt-key^='try:']")][0];
          key?.click();
        });
        await page.waitForTimeout(2_500);
        await assertRecovered(page, ["kept"]);
        await run(page, "print('kept is', kept)");
        assert.ok((await transcript(page)).includes("kept is survivor"), "state was lost");
      }),
  );

  // reading, copying, and the submenu

  await check("a line of the transcript can be dragged out and copied", () =>
    withPage({}, async (page) => {
      await openPath(page);
      await openTerminal(page);
      await waitReady(page);
      await run(page, "print('paste me into a bug report')");

      // THE PRESS MUST NOT BE CANCELLED. Cancelling the default of a mousedown in the window's
      // body - which is how a press on empty space is kept from blurring the prompt - also
      // cancels the browser's selection gesture, and because the console is a custom element the
      // window cannot see where inside it a press landed. Every press on transcript text would
      // then be treated as empty space, and nobody could drag out a line of a traceback to paste
      // anywhere. Asserted first, because it is the cause and it fails loudly.
      const cancelled = await page.evaluate(() => {
        const root = document.querySelector("freva-python-console")?.shadowRoot;
        const line = [...(root?.querySelectorAll(".bp-line") ?? [])].pop();
        if (!line) return "no transcript line";
        const press = new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        line.dispatchEvent(press);
        return press.defaultPrevented;
      });
      assert.equal(cancelled, false, "the press that starts a selection is still being cancelled");

      // And then the gesture itself, with a real pointer, on a line that is on the screen.
      const line = page.locator("freva-python-console .bp-line").first();
      await line.scrollIntoViewIfNeeded().catch(() => {});
      const box = await line.boundingBox();
      assert.ok(box, "no transcript line to drag across");
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + 2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + Math.max(40, box.width - 6), y, { steps: 16 });
      await page.mouse.up();
      await page.waitForTimeout(250);

      // Read AFTER the release has been handled, not during the drag: the surface library decides
      // on mouseup whether that was a click by asking `window.getSelection()`, and from outside a
      // shadow root that question comes back empty - concluding "nothing selected", focusing its
      // hidden clipboard textarea and collapsing the selection a reader had just made.
      const selected = await page.evaluate(() => {
        const root = document.querySelector("freva-python-console")?.shadowRoot;
        const sel = root?.getSelection ? root.getSelection() : document.getSelection();
        return sel ? sel.toString() : "";
      });
      assert.ok(
        selected.trim().length > 0,
        `the drag selected nothing: ${JSON.stringify(selected)}`,
      );
    }),
  );

  await check("the terminal settings submenu opens where it can be seen", () =>
    withPage({ viewport: { width: 1100, height: 430 } }, async (page) => {
      await openPath(page);
      await openTerminal(page);
      await waitReady(page);

      await page.click(".freva-term .term-kebab");
      await page.waitForSelector(".freva-term .term-menu.show", { timeout: 10_000 });
      await page.click(".freva-term .tmn-group--side > .tmn-sub");
      await page.waitForTimeout(250);

      // A SHORT WINDOW IS THE CASE THAT FAILS. The panel is around 260px tall, so pinned to the
      // top of the row that opens it a terminal in the lower half of a laptop screen opens it off
      // the bottom edge, where the colours are simply not on the screen. It is measured against
      // the viewport, on both axes.
      const fit = await page.evaluate(() => {
        const panel = document.querySelector(".freva-term .tmn-group--side.open .tmn-subpanel");
        if (!panel) return null;
        const r = panel.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left),
          right: Math.round(r.right),
          vh: window.innerHeight,
          vw: window.innerWidth,
        };
      });
      assert.ok(fit, "the appearance submenu did not open");
      assert.ok(fit.top >= 0, `it starts above the top edge: ${JSON.stringify(fit)}`);
      assert.ok(fit.bottom <= fit.vh, `it runs off the bottom: ${JSON.stringify(fit)}`);
      assert.ok(fit.left >= 0, `it runs off the left: ${JSON.stringify(fit)}`);
      assert.ok(fit.right <= fit.vw, `it runs off the right: ${JSON.stringify(fit)}`);

      // The three session rows say what they do, for a visitor who has not pressed one before.
      const titled = await page.evaluate(() =>
        [...document.querySelectorAll(".freva-term .term-menu .tmn-item")]
          .map((n) => ({ label: (n.textContent ?? "").trim(), title: n.getAttribute("title") }))
          .filter((row) => /^(New|Restart|End) session/.test(row.label)),
      );
      assert.equal(titled.length, 3, `session rows: ${JSON.stringify(titled)}`);
      for (const row of titled) {
        assert.ok(
          (row.title ?? "").length > 20,
          `"${row.label}" carries no hover explanation: ${JSON.stringify(row)}`,
        );
      }
    }),
  );

  await check("recovery survives the settings menu, a resize, maximize and minimize", () =>
    withPage({}, async (page) => {
      await openPath(page);
      await openTerminal(page);
      await waitReady(page);

      const fail = async (label) => {
        await run(page, `raise RuntimeError('${label}')`, { settle: 2_000 });
        await assertRecovered(page, [`RuntimeError: ${label}`]);
      };

      await fail("plain");

      // …with the ⋮ menu open, a second thing competing for the focus.
      await page.click(".freva-term .term-kebab");
      await page.waitForSelector(".freva-term .term-menu.show");
      await fail("menu-open");
      await page.keyboard.press("Escape");

      // …after the viewport changed under it.
      await page.setViewportSize({ width: 1100, height: 700 });
      await page.waitForTimeout(400);
      await fail("resized");

      // …maximized.
      await page.click(".freva-term .tl.zoom");
      await page.waitForTimeout(500);
      await fail("maximized");

      // …and after a trip through the dock.
      await page.click(".freva-term .tl.min");
      await page.waitForTimeout(400);
      await page.click(".freva-term .tl.min");
      await page.waitForTimeout(500);
      await fail("restored");
    }),
  );

  await check("scrolling up holds its place, and Jump to latest gives it back", () =>
    withPage({}, async (page) => {
      await openPath(page);
      await openTerminal(page);
      await waitReady(page);
      await page.click(".freva-term .tl.zoom");
      await page.waitForTimeout(400);

      await exec(page, "for i in range(300):\n    print('a', i)\n", { settle: 4_000 });
      // Deliberately away from the bottom, the way a reader looking something up would be.
      await page.evaluate(() => {
        document
          .querySelector("freva-python-console")
          .shadowRoot.querySelector(".bp-transcript")
          .scrollTo({ top: 0 });
      });
      await page.waitForTimeout(300);
      const parked = await promptGeometry(page);

      // Output arrives while they are up there. Their position must not move, and the fact that
      // something happened must be said - together, that is what "do not steal the scroll" and
      // "do not look frozen" mean at the same time.
      await exec(page, "for i in range(80):\n    print('b', i)\n", { settle: 3_000 });
      const held = await promptGeometry(page);
      assert.ok(
        Math.abs(held.scrollTop - parked.scrollTop) <= 4,
        `background output moved the reader from ${parked.scrollTop} to ${held.scrollTop}`,
      );
      assert.ok(held.jumpShown, "no unread-output affordance appeared");

      await page.evaluate(() => {
        document.querySelector("freva-python-console").shadowRoot.querySelector(".bp-jump").click();
      });
      await page.waitForTimeout(500);
      const back = await promptGeometry(page);
      assert.ok(back.scrollTop >= back.scrollMax - 24, "Jump to latest did not reach the bottom");
      assert.ok(!back.jumpShown, "the affordance stayed after it was used");
      assert.ok(back.visible, "the prompt is still not visible after jumping");

      // And submitting a command resumes following on its own.
      await page.evaluate(() => {
        document
          .querySelector("freva-python-console")
          .shadowRoot.querySelector(".bp-transcript")
          .scrollTo({ top: 0 });
      });
      await page.waitForTimeout(200);
      await run(page, "print('resumed')", { settle: 1_500 });
      const resumed = await promptGeometry(page);
      assert.ok(resumed.visible, "submitting a command did not bring the prompt back");
    }),
  );

  // layering

  await check("the terminal stays above the maximized dataset browser", () =>
    withPage({}, async (page) => {
      await openPath(page);
      await openTerminal(page);
      await waitReady(page);
      await page.click("[data-portal-tree-expand]");
      await page.waitForSelector(".portal-sheet", { timeout: 10_000 });
      await page.waitForTimeout(400);
      const owner = await page.evaluate(() => {
        const term = document.querySelector(".freva-term").getBoundingClientRect();
        const el = document.elementFromPoint(
          Math.round(term.left + term.width / 2),
          Math.round(term.top + 6),
        );
        return el?.closest(".freva-term, .portal-sheet, .portal-sheet-backdrop")?.className ?? "?";
      });
      assert.match(owner, /freva-term/, `the maximized tree covered the terminal (${owner})`);
    }),
  );

  // photographs

  await check("photographs the tree and the terminal at both widths in both themes", async () => {
    mkdirSync(SHOTS, { recursive: true });
    for (const [label, viewport] of [
      ["desktop", DESKTOP],
      ["mobile", MOBILE],
    ]) {
      for (const scheme of ["light", "dark"]) {
        await withPage({ viewport, colorScheme: scheme, theme: scheme }, async (page) => {
          await openPath(page);
          await page.waitForTimeout(500);
          await page.screenshot({ path: join(SHOTS, `${label}-${scheme}-tree.png`) });
          await openTerminal(page);
          await waitReady(page);
          await run(page, "print('hello from', 'Python')", { settle: 1_200 });
          await page.screenshot({ path: join(SHOTS, `${label}-${scheme}-terminal.png`) });
          await page.click(".freva-term .tl.zoom");
          await page.waitForTimeout(600);
          await page.screenshot({ path: join(SHOTS, `${label}-${scheme}-terminal-max.png`) });
        });
      }
    }
    assert.ok(existsSync(join(SHOTS, "desktop-dark-terminal-max.png")));
    console.log(`       screenshots in ${SHOTS}`);
  });
} finally {
  await browser.close();
  await shutdown();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} Waterpark terminal checks passed`,
);
process.exit(failed.length > 0 ? 1 : 0);
