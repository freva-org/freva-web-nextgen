// The Python playground, in a real browser, without ever starting an interpreter.
//
// Downloading Pyodide is tens of megabytes over a network this suite does not assume it has, and
// `@freva-org/browser-python` already runs the real interpreter in its own browser suites. What
// only THIS layer can be asked is everything around the interpreter: whether pressing a button
// in a tree opens a window without moving the page, whether that window is above the portal's
// own content, whether it survives being minimized, whether a second session is warned about
// before it is created, and whether the whole thing is still absent from a portal that did not
// ask for it.
//
// So the console element is stubbed - defined before the coordinator gets there, with the same
// methods and no Worker behind them. That is not a weaker test of the coordinator; it is the
// only way to test the coordinator rather than Pyodide.
//
// Usage:  node browser-tests/python-playground.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
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

// fixture

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Mark</title><rect width="16" height="16" fill="#123456"/></svg>`;

const OPEN = 'import xarray as xr\n\nds = xr.open_zarr("s3://example/tas")\nprint(ds)\n';

const CATALOG = {
  schemaVersion: 1,
  generatedAt: "2026-01-06T10:00:00Z",
  source: "https://s3.example.org",
  roots: [
    {
      id: "cmip6",
      kind: "collection",
      name: "cmip6",
      title: "CMIP6",
      children: [
        {
          id: "cmip6/tas",
          kind: "dataset",
          name: "tas_hourly.zarr",
          path: "s3://example/cmip6/tas_hourly.zarr",
          size: 48210944,
          availability: "available",
          examples: [
            { id: "python", label: "Python", language: "python", code: OPEN, executable: true },
            { id: "cli", label: "CLI", language: "shell", code: "s5cmd cp s3://example/tas ." },
            {
              id: "token",
              label: "Python (token)",
              language: "python",
              code: 'xr.open_zarr("<YOUR-BUCKET>/tas")\n',
              executable: true,
            },
          ],
        },
      ],
    },
  ],
};

/**
 * A portal-owned modal, drawn as a div with a z-index in the dialog band. The stacking test needs
 * something that stacks. The Data Browser's own File Inspector is a real dialog element in the
 * browser's TOP LAYER, which no z-index can cover and which this test therefore does not pretend
 * to - see the report for that conflict. This is the other kind of portal modal, the kind
 * alwaysOnTop is actually about.
 */
const PORTAL_MODAL = `
  const install = () => {
    const modal = document.createElement("div");
    modal.id = "portal-test-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", "A portal dialog");
    modal.textContent = "A portal-owned dialog";
    Object.assign(modal.style, {
      position: "fixed", inset: "20% 20%", background: "#fff", border: "1px solid #333",
      padding: "1rem", zIndex: "2500", display: "none",
    });
    document.body.append(modal);
    window.__openModal = () => { modal.style.display = "block"; };
  };
  // An init script runs before the document has a body, so the node is added once one exists.
  if (document.body) install();
  else document.addEventListener("DOMContentLoaded", install, { once: true });
`;

function writeFixture(python, options = {}) {
  const suffix = options.suffix ?? (python ? "on" : "off");
  const root = mkdtempSync(join(tmpdir(), `py-browser-${suffix}-`));
  const put = (rel, body) => {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put("data/archive.json", JSON.stringify(options.noExamples ? BARE_CATALOG : CATALOG, null, 2));
  put(
    "landings/home.yaml",
    `schemaVersion: 1
title: Python Playground
blocks:
  - type: hero
    heading: A portal with a runnable archive
    summary: Long enough that the page scrolls, so a press can be checked against the scroll.
  - type: cards
    heading: Filler
    items:
${Array.from({ length: 8 }, (_, i) => `      - title: Card ${i + 1}\n        summary: Filler so the document is taller than the viewport.\n        href: https://example.org/${i}`).join("\n")}
  - type: dataset-tree
    catalog: ../data/archive.json
    expand:
      - cmip6
${
  python
    ? `    python:
      enabled: true
      profile: minimal
      autostart: ${options.autostart ?? "never"}
      maxSessions: 2
${options.initialSource ? `      initialSource: |\n        ${options.initialSource}\n` : ""}      terminal:
        style: freva-client-terminal
        osControls: linux
        alwaysOnTop: ${options.alwaysOnTop ?? true}
        rememberAppearance: true
`
    : ""
}`,
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: py-${suffix}
  title: Python Playground
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: default
landings:
  home:
    path: /
    source: ./landings/home.yaml
`,
  );
  const out = join(root, "..", `py-site-${suffix}-${process.pid}`);
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

/** The same archive with nothing runnable in it: the case the launcher exists for. */
const BARE_CATALOG = {
  ...CATALOG,
  roots: CATALOG.roots.map((root) => ({
    ...root,
    children: root.children.map((node) => ({
      ...node,
      // Only the shell example survives, so the tree has code to show and nothing to run.
      examples: node.examples.filter((e) => e.language !== "python"),
    })),
  })),
};

const SITES = {
  on: writeFixture(true),
  off: writeFixture(false),
  warm: writeFixture(true, {
    suffix: "warm",
    autostart: "after-interactive",
    initialSource: 'print("ready")',
  }),
  eager: writeFixture(true, {
    suffix: "eager",
    autostart: "immediately",
    initialSource: 'print("ready")',
  }),
  bare: writeFixture(true, { suffix: "bare", noExamples: true }),
  floating: writeFixture(true, { suffix: "floating", alwaysOnTop: false }),
};

const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
const servers = {};
const bases = {};
for (const [key, root] of Object.entries(SITES)) {
  const server = createPreviewServer({ dir: root, port: 0 });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers[key] = server;
  bases[key] = `http://127.0.0.1:${server.address().port}/`;
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

let browser;
try {
  browser = await launch();
} catch (error) {
  for (const server of Object.values(servers)) server.close();
  const message = `chromium would not launch: ${error.message}`;
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

/**
 * A console element with the real API and no interpreter. Registered BEFORE the portal's own
 * bundle runs, so `defineBrowserPythonConsole()` finds the name taken and leaves it alone.
 * Everything the coordinator calls is here; nothing here downloads anything. What it records -
 * the sources it was asked to run, in order - is the assertion.
 */
const STUB = `
  class StubConsole extends HTMLElement {
    constructor() {
      // A custom element constructor may not add children - the platform refuses the element
      // outright if it does - so everything visible happens on connect.
      super();
      this.ran = [];
      this.startCalls = 0;
      this.restarts = 0;
      this.cleared = 0;
      this._transcript = "";
    }
    connectedCallback() {
      this.style.display = "block";
      this.style.minHeight = "80px";
      if (!this.firstChild) this.textContent = "stub console";
    }
    async start() {
      this.startCalls += 1;
      window.__order.push("start");
      // A real start is not instant, and the ordering rule is only meaningful if this one is
      // not either: an initialSource that ran before the interpreter would still look right.
      await new Promise((r) => setTimeout(r, 30));
      /*
       * THE READY REPORT, which the real element sets from what the worker sent.
       *
       * The package help panel reads it rather than the configuration, so a stub that left it
       * unset would only ever exercise the "nothing is running" branch. These are the shapes the
       * real payload has - and deliberately NOT the same values as the portal's configuration, so
       * a panel that quietly printed the config back would be visible as a difference.
       */
      this.readyInfo = window.__readyInfo ?? null;
      window.__order.push("started");
    }
    async execute(source) {
      window.__order.push("execute:" + source.trim());
      this._transcript += source;
    }
    async runExample(example) {
      window.__order.push("example:" + example.title);
      this.ran.push(example);
      this._transcript += "\\n-- " + example.title + " --\\n" + example.source;
    }
    transcript() { return this._transcript; }
    focus() { this.focused = true; }
    clear() { this.cleared += 1; this._transcript = ""; }
    clearHistory() {}
    async restart() { this.restarts += 1; window.__order.push("restart"); }
    dispose() {}
  }
  window.__order = [];
  window.__readyInfo = window.__readyInfo ?? null;
  customElements.define("freva-python-console", StubConsole);
  window.__consoles = () => [...document.querySelectorAll("freva-python-console")];
`;

/** The page problems a check has collected so far, for an assertion that wants to read them. */
const problemsOf = (ctx) => ctx.problems;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    const detail = process.env.BROWSER_VERBOSE
      ? String(error.stack ?? error.message)
      : String(error.message).split("\n").slice(0, 6).join("\n       ");
    console.log(`  FAIL ${name}\n       ${detail}`);
  }
}

/**
 * The accessibility scanner, served from the page's OWN origin. The artifact's policy is
 * `script-src 'self'` and it stays in force for the whole run: injecting axe inline would need
 * the policy relaxed, which is the one condition under which an accessibility pass proves least.
 */
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

async function withPage(key, fn, { stub = true, confirmAnswer = true, readyInfo = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route(`${bases[key]}__axe-core.js`, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: AXE }),
  );
  const page = await context.newPage();
  const problems = [];
  // EVERY URL THIS PAGE ASKS FOR, recorded from the browser rather than inferred from the source.
  // The claim a curated playground makes is about network traffic ("no package index is
  // reached"), and the only honest way to check a claim about traffic is to watch it. A grep over
  // the bundle would miss a URL assembled at runtime; this does not.
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  // A NATIVE dialog is a failure rather than something to answer. `confirm()`, `alert()` and
  // `prompt()` render as `127.0.0.1 says…` in the browser's own chrome, block the whole page
  // rather than the window, and are unstyleable and unreachable by the window's own focus
  // handling. Nothing in this product may raise one, so the handler records it as a problem and
  // dismisses it rather than treating it as the question under test.
  page.on("dialog", (dialog) => {
    problems.push(`native dialog: ${dialog.type()} ${dialog.message().slice(0, 80)}`);
    void dialog.dismiss();
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window.__csp ??= []).push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
  // The window's own confirmation, answered the way a person would. An observer rather than a
  // polling loop, because the dialog appears synchronously inside the menu row's click handler
  // and a test that awaited a timeout first would race it. What it records is the title and body,
  // so `ctx.dialogs()` keeps meaning "what was the visitor asked".
  await page.addInitScript((answer) => {
    window.__confirms = [];
    const answerOne = (panel) => {
      const text = `${panel.querySelector(".term-confirm-title")?.textContent ?? ""} ${
        panel.querySelector(".term-confirm-body")?.textContent ?? ""
      }`;
      window.__confirms.push(text);
      const buttons = panel.querySelectorAll(".term-confirm-btn");
      (answer ? buttons[1] : buttons[0])?.click();
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const panel = node.matches?.(".term-confirm")
            ? node
            : node.querySelector?.(".term-confirm");
          if (panel) answerOne(panel);
        }
      }
    });
    const start = () => observer.observe(document.body, { childList: true, subtree: true });
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
  }, confirmAnswer);
  // Set BEFORE the stub, because the stub reads it when a session starts.
  if (readyInfo) await page.addInitScript((info) => (window.__readyInfo = info), readyInfo);
  if (stub) await page.addInitScript(STUB);
  await page.addInitScript(PORTAL_MODAL);
  try {
    await page.goto(bases[key], { waitUntil: "networkidle" });
    await page.waitForSelector(".dataset-tree", { timeout: 15_000 });
    // `violations` is read at ASSERTION time, not here: a snapshot taken before the test has done
    // anything would report the page load's policy record and miss everything the press causes,
    // which is the half that matters.
    await fn(page, {
      problems,
      requests,
      dialogs: async () => page.evaluate(() => window.__confirms ?? []),
    });
  } catch (error) {
    if (process.env.BROWSER_VERBOSE) console.log("  page problems:", problems.slice(0, 6));
    throw error;
  } finally {
    await context.close();
  }
}

/** Open the dataset's details and its access disclosure, and return the Try control's selector. */
async function openExample(page) {
  // `cmip6` is in the block's `expand` list, so it is already open when the tree mounts; clicking
  // its row here would CLOSE it, and the child this waits for would never appear.
  if ((await page.locator('[data-dataset-tree-id="cmip6/tas"]').count()) === 0) {
    await page.click('[data-dt-key="toggle:cmip6"]');
  }
  await page.waitForSelector('[data-dataset-tree-id="cmip6/tas"]', { timeout: 10_000 });
  await page.click('[data-dt-key="activate:cmip6/tas"]');
  await page.waitForSelector(".dataset-tree__details", { timeout: 10_000 });
  await page.click('[data-dt-key="disclose:cmip6/tas"]');
  await page.waitForSelector(".dataset-tree__codecard", { timeout: 10_000 });
  return '[data-dt-key="try:cmip6/tas"]';
}

try {
  await check("a portal without a playground draws Copy and no run control", () =>
    withPage("off", async (page) => {
      const tryIt = await openExample(page);
      assert.ok(await page.locator('[data-dt-key="example:cmip6/tas"]').count(), "no Copy control");
      assert.equal(await page.locator(tryIt).count(), 0, "a run control with no playground");
      // …and nothing of the interpreter reached the page.
      const scripts = await page.evaluate(() =>
        [...document.querySelectorAll("script[src]")].map((s) => s.src),
      );
      assert.ok(scripts.length > 0, "the page loaded no script at all");
    }),
  );

  await check("Copy sits with the code, Try in Python with the store, per tab", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt, { timeout: 10_000 });
      // COPY ACTS ON THE TEXT; RUN ACTS ON THE STORE, so they do not sit together. `Copy code`
      // belongs in the snippet's title bar, because it copies what is under it, while running the
      // example is the alternative to inspecting the store. The action row at the top of the
      // panel holds the pair of things a reader can DO, and the card holds the one thing that
      // acts on its own text.
      assert.deepEqual(
        await page.evaluate(() =>
          [...document.querySelectorAll(".dataset-tree__codehead .dataset-tree__btn")].map((b) =>
            b.getAttribute("data-dt-action"),
          ),
        ),
        ["copy-example"],
        "the code card still carries a second action",
      );
      assert.deepEqual(
        await page.evaluate(() =>
          [...document.querySelectorAll(".dataset-tree__actions .dataset-tree__btn")].map((b) =>
            b.getAttribute("data-dt-action"),
          ),
        ),
        ["try-python"],
        "the run control is not in the action row",
      );
      assert.equal(
        await page.locator(".dataset-tree__tabbar .dataset-tree__btn").count(),
        0,
        "the tab strip still carries an action",
      );

      // The shell tab is not Python; the template tab is Python and still has a blank in it.
      await page.click('[data-dt-key="tab:cmip6/tas:1"]');
      await page.waitForSelector(tryIt, { state: "detached" });
      await page.click('[data-dt-key="tab:cmip6/tas:2"]');
      await page.waitForTimeout(100);
      assert.equal(await page.locator(tryIt).count(), 0, "a template got a run control");
    }),
  );

  await check("pressing it opens a window and does not move the page", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      // Scrolled to the control FIRST, and measured after. Playwright scrolls an element into
      // view before clicking it, so a position recorded before `click()` would be compared
      // against a position the test itself moved, failing on a page that behaved perfectly. What
      // is asserted is that pressing the button does not move the page from where the reader was.
      await page.locator(tryIt).scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => window.scrollY);
      assert.ok(before > 0, "the control was at the top of the page, so nothing was measured");
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 15_000 });
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => window.scrollY);
      assert.equal(after, before, `the page scrolled from ${before} to ${after}`);

      const ran = await page.evaluate(() => window.__consoles()[0]?.ran ?? []);
      assert.equal(ran.length, 1, `ran ${ran.length} examples`);
      assert.equal(ran[0].source, OPEN);
      assert.ok(ran[0].title.length > 0, "the example was run with no title for its divider");
    }),
  );

  await check("the window sits above the portal's own content, in the overlay layer", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 15_000 });
      const placed = await page.evaluate(() => {
        const shell = document.querySelector(".portal-python-window");
        // Either overlay root counts: an ordinary window goes in the shell's own root, and an
        // always-on-top one in the sibling root the layer manager owns. Both are fixed,
        // pointer-transparent, full-viewport layers; what must not happen is a loose child of
        // `<body>`, which is the manager's last-resort fallback.
        const parent = shell?.parentElement ?? null;
        const term = document.querySelector(".freva-term");
        const box = term.getBoundingClientRect();
        const middle = document.elementFromPoint(box.left + box.width / 2, box.top + 8);
        return {
          inOverlay: Boolean(parent?.classList.contains("portal-overlay-root")),
          rootId: parent?.id ?? "",
          rootIsBodyChild: parent?.parentElement === document.body,
          zIndex: shell.style.zIndex,
          onTop: Boolean(middle && middle.closest(".freva-term")),
        };
      });
      assert.ok(
        placed.inOverlay,
        `the window is not in an overlay layer (parent ${placed.rootId})`,
      );
      assert.ok(placed.rootIsBodyChild || placed.rootId === "portal-overlay-root");
      assert.ok(Number(placed.zIndex) >= 1000, `z-index is ${placed.zIndex}`);
      assert.ok(placed.onTop, "something portal-owned is drawn over the window");
    }),
  );

  await check("minimize keeps the session, and pressing again restores it", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 15_000 });

      await page.click(".freva-term .tl.min");
      assert.ok(
        await page.evaluate(() =>
          document.querySelector(".freva-term").classList.contains("minimized"),
        ),
        "the window did not minimize",
      );

      await page.click(tryIt);
      await page.waitForTimeout(200);
      const state = await page.evaluate(() => {
        const term = document.querySelector(".freva-term");
        return {
          minimized: term.classList.contains("minimized"),
          consoles: window.__consoles().length,
          ran: window.__consoles()[0].ran.length,
          transcript: window.__consoles()[0].transcript(),
        };
      });
      assert.equal(state.minimized, false, "a minimized window was left minimized");
      // ONE console, and the second run appended to it: the session survived, it was not replaced.
      assert.equal(state.consoles, 1, `${state.consoles} interpreters for two presses`);
      assert.equal(state.ran, 2);
      assert.ok(state.transcript.includes("open_zarr"), "the transcript was reset");
    }),
  );

  await check("a second session is warned about, and the limit is two", () =>
    withPage("on", async (page, ctx) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 15_000 });

      const newSession = async () => {
        await page.click(".freva-term .term-kebab");
        await page.waitForSelector(".term-menu.show", { timeout: 5_000 });
        const item = page.locator(".tmn-sections .tmn-item", { hasText: "New session" });
        if (await item.isDisabled()) return false;
        await item.click();
        await page.waitForTimeout(250);
        return true;
      };

      assert.ok(await newSession(), "the New session row was already disabled");
      const asked = await ctx.dialogs();
      assert.ok(
        asked.some((m) => /additional CPU and memory/i.test(m)),
        `no warning before the second interpreter: ${JSON.stringify(asked)}`,
      );
      // Asked by the WINDOW, in the window, and never by the browser.
      assert.deepEqual(
        problemsOf(ctx).filter((m) => m.startsWith("native dialog")),
        [],
        "the warning was a native browser dialog",
      );
      assert.equal(await page.evaluate(() => window.__consoles().length), 2);
      // The tab strip appears exactly when there is a choice to make.
      assert.equal(await page.locator(".portal-python-tab").count(), 2);

      // …and a third is refused rather than offered.
      assert.equal(await newSession(), false, "a third interpreter was offered");
      assert.equal(await page.evaluate(() => window.__consoles().length), 2);
    }),
  );

  await check("declining the warning creates nothing", () =>
    withPage(
      "on",
      async (page) => {
        const tryIt = await openExample(page);
        await page.waitForSelector(tryIt);
        await page.click(tryIt);
        await page.waitForSelector(".freva-term.show", { timeout: 15_000 });
        await page.click(".freva-term .term-kebab");
        await page.waitForSelector(".term-menu.show");
        await page.locator(".tmn-sections .tmn-item", { hasText: "New session" }).click();
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => window.__consoles().length), 1);
      },
      { confirmAnswer: false },
    ),
  );

  await check("the settings menu carries appearance, transcript and session rows", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 15_000 });
      await page.click(".freva-term .term-kebab");
      await page.waitForSelector(".term-menu.show");

      const menu = await page.evaluate(() => {
        const root = document.querySelector(".term-menu");
        return {
          sections: [...root.querySelectorAll(".tmn-sections > .tmn-block > .tmn-h")].map(
            (h) => h.textContent,
          ),
          appearanceSide: Boolean(root.querySelector(".tmn-group--side")),
          appearanceOpen: Boolean(root.querySelector(".tmn-group.open")),
          swatches: root.querySelectorAll(".bg-sw").length,
          hasAlpha: Boolean(root.querySelector(".term-alpha")),
          hasScale: Boolean(root.querySelector(".term-scale")),
          items: [...root.querySelectorAll(".tmn-sections .tmn-item")].map((i) => i.textContent),
        };
      });
      // THE ORDER IS THE HOST'S, and the appearance controls are in it rather than above it: a
      // colour picker, two sliders and a reset pinned open at the top would sit above every row a
      // visitor actually opens this menu for. They are a row the host places, opening to the
      // side, second from last. `Session` leads because the actions that change what the prompt
      // IS are what a terminal's menu is mostly for.
      assert.deepEqual(menu.sections, ["Session", "Transcript", "Terminal", "Help"]);
      assert.ok(menu.appearanceSide, "the appearance group is not a side panel");
      assert.ok(!menu.appearanceOpen, "the appearance panel is open before it was asked for");
      assert.ok(menu.swatches > 0 && menu.hasAlpha && menu.hasScale);
      assert.deepEqual(menu.items, [
        "New session…",
        "Restart session…",
        "End session…",
        "Copy transcript",
        "Clear transcript",
        "Download transcript",
        "Clear history",
        "Reset appearance",
        "Keyboard shortcuts",
        "Python packages",
      ]);

      // And the panel opens where it was put, without the menu clipping it.
      await page.click(".freva-term .tmn-sub");
      await page.waitForTimeout(150);
      const opened = await page.evaluate(() => {
        const root = document.querySelector(".term-menu");
        const panel = root.querySelector(".tmn-group--side .tmn-subpanel");
        const box = panel.getBoundingClientRect();
        const menuBox = root.getBoundingClientRect();
        return {
          shown: getComputedStyle(panel).display !== "none",
          unclipped: getComputedStyle(root).overflow === "visible",
          // Beside the menu, not inside its column.
          outside: box.right <= menuBox.left + 1 || box.left >= menuBox.right - 1,
        };
      });
      assert.ok(opened.shown, "the appearance panel did not open");
      assert.ok(opened.unclipped, "the menu still clips, so the panel is cut off at its edge");
      assert.ok(opened.outside, "the panel opened inside the menu rather than beside it");
    }),
  );

  await check("text size changes the content and not the chrome", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 15_000 });
      await page.click(".freva-term .term-kebab");
      await page.waitForSelector(".term-menu.show");

      const barBefore = await page.evaluate(() =>
        Math.round(document.querySelector(".term-bar").getBoundingClientRect().height),
      );
      await page.evaluate(() => {
        const slider = document.querySelector(".term-scale");
        slider.value = "1.5";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        scale: document.querySelector(".freva-term").style.getPropertyValue("--term-scale"),
        bar: Math.round(document.querySelector(".term-bar").getBoundingClientRect().height),
      }));
      assert.equal(after.scale, "1.5");
      assert.equal(after.bar, barBefore, "the title bar grew with the text");
    }),
  );

  await check("nothing was refused by the artifact's own policy", () =>
    withPage("on", async (page, ctx) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 15_000 });
      await page.waitForTimeout(300);
      const violations = await page.evaluate(() => window.__csp ?? []);
      assert.deepEqual(violations, [], JSON.stringify(violations));
      const real = ctx.problems.filter((p) => !/favicon/i.test(p));
      assert.deepEqual(real, [], JSON.stringify(real));
    }),
  );

  await check("the run control is reachable and operable from the keyboard", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      // FROM THE ROW, FORWARD. The run control is the first thing in the panel - the action row
      // comes before the address and before the snippet - so this walks in from the store's own
      // row rather than from `Copy code`, which is below it.
      await page.focus(`[data-dt-row="cmip6/tas"]`);
      await page.keyboard.press("Tab");
      const action = await page.evaluate(() => document.activeElement?.dataset?.dtAction ?? "");
      assert.equal(action, "try-python", `Tab from the store's row landed on ${action}`);
      await page.keyboard.press("Enter");
      await page.waitForSelector(".freva-term.show", { timeout: 15_000 });
      // The press starts the interpreter first and queues the example behind it, so the run is not
      // there on the same tick the window appears.
      await page.waitForFunction(() => (window.__consoles()[0]?.ran.length ?? 0) === 1, null, {
        timeout: 20_000,
      });
    }),
  );

  // autostart

  await check("autostart: never starts nothing until something is asked for", () =>
    withPage("on", async (page) => {
      await page.waitForTimeout(1200);
      const before = await page.evaluate(() => window.__order.slice());
      assert.deepEqual(before, [], `something started on its own: ${JSON.stringify(before)}`);
      assert.equal(await page.locator(".freva-term").count(), 0, "a window opened by itself");
    }),
  );

  await check("autostart: after-interactive warms the interpreter without showing anything", () =>
    withPage("warm", async (page) => {
      await page.waitForFunction(() => window.__order.includes("started"), null, {
        timeout: 20_000,
      });
      const order = await page.evaluate(() => window.__order.slice());
      // Started, and the portal's own opening lines ran into it.
      assert.deepEqual(
        order,
        ["start", "started", 'execute:print("ready")'],
        JSON.stringify(order),
      );
      // …and nothing appeared. Warming is a download, not a window.
      const shown = await page.evaluate(
        () => document.querySelector(".freva-term")?.classList.contains("show") ?? false,
      );
      assert.equal(shown, false, "warming opened a window nobody asked for");
    }),
  );

  await check("autostart: immediately starts Python during initialisation, and shows it", () =>
    withPage("eager", async (page) => {
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.waitForFunction(() => window.__order.includes("started"), null, {
        timeout: 20_000,
      });
      const order = await page.evaluate(() => window.__order.slice());
      assert.deepEqual(
        order,
        ["start", "started", 'execute:print("ready")'],
        JSON.stringify(order),
      );
    }),
  );

  await check("initialSource runs after the interpreter is ready and before any example", () =>
    withPage("warm", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForFunction(() => window.__order.some((s) => s.startsWith("example:")), null, {
        timeout: 20_000,
      });
      const order = await page.evaluate(() => window.__order.slice());
      const started = order.indexOf("started");
      const initial = order.indexOf('execute:print("ready")');
      const example = order.findIndex((s) => s.startsWith("example:"));
      assert.ok(
        started >= 0 && initial > started,
        `initialSource before ready: ${JSON.stringify(order)}`,
      );
      assert.ok(example > initial, `an example overtook initialSource: ${JSON.stringify(order)}`);
    }),
  );

  await check("a restart is a new interpreter, and gets the opening lines again", () =>
    withPage("warm", async (page) => {
      await page.waitForFunction(() => window.__order.includes("started"), null, {
        timeout: 20_000,
      });
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.evaluate(() => (window.__order.length = 0));

      await page.click(".freva-term .term-kebab");
      await page.waitForSelector(".term-menu.show");
      await page.locator(".tmn-sections .tmn-item", { hasText: "Restart session" }).click();
      await page.waitForFunction(() => window.__order.includes("restart"), null, {
        timeout: 20_000,
      });
      await page.waitForTimeout(200);
      const order = await page.evaluate(() => window.__order.slice());
      assert.deepEqual(order, ["restart", 'execute:print("ready")'], JSON.stringify(order));
    }),
  );

  // ways in, and ways back

  await check("no standing Python control is drawn anywhere on the page", () =>
    withPage("bare", async (page) => {
      // NO STANDING LAUNCHER, and this check is what keeps one from coming back by accident. A
      // pill in the bottom-right corner of every page - `Show Python · 1 · Python is ready` -
      // overlaps the dataset tree and the footer, says things about the terminal from somewhere
      // that is not the terminal, and cannot be dismissed; a `Python` button in the dataset-tree
      // block's header row is one button alone above a panel that is about datasets, now that the
      // block's maximize control lives in the tree's own toolbar.
      //
      // What that leaves unserved: a page whose catalogue has nothing runnable has no
      // `Try in Python` anywhere, so on THIS fixture there is no way to a prompt at all.
      // `autostart` is the setting for a portal that wants one up; a permanent way in belongs
      // somewhere that is honestly the page's.
      await page.waitForSelector(".dataset-tree__row", { timeout: 20_000 });
      assert.equal(
        await page.locator("[data-portal-python-entry]").count(),
        0,
        "a Python control is still drawn in the block toolbar",
      );
      assert.equal(
        await page.locator("[data-portal-python-launcher]").count(),
        0,
        "the floating bottom-right Python strip is still on the page",
      );
      // The catalogue really does offer nothing to run, which is the case this covers.
      await openExample(page);
      assert.equal(
        await page.locator('[data-dt-key^="try:"]').count(),
        0,
        "a run control appeared",
      );
      // And nothing started an interpreter on its own.
      assert.equal(await page.evaluate(() => window.__consoles().length), 0);
    }),
  );

  await check(
    "closing the window keeps the session, and a second Try brings the same one back",
    () =>
      withPage("on", async (page) => {
        const tryIt = await openExample(page);
        await page.waitForSelector(tryIt);
        await page.click(tryIt);
        await page.waitForSelector(".freva-term.show", { timeout: 20_000 });

        await page.click(".freva-term .tl.close");
        await page.waitForTimeout(300);
        assert.equal(
          await page.locator("[data-portal-python-entry]").count(),
          0,
          "closing the window drew a launcher",
        );

        // THE REMAINING WAY BACK, and the property that matters about it: a run control reaches
        // the window that already exists rather than building a second one. Hiding is hiding, not
        // ending.
        await page.click(tryIt);
        await page.waitForSelector(".freva-term.show", { timeout: 10_000 });
        const state = await page.evaluate(() => ({
          consoles: window.__consoles().length,
          transcript: window.__consoles()[0].transcript(),
        }));
        assert.equal(state.consoles, 1, `${state.consoles} interpreters after a close`);
        assert.ok(state.transcript.includes("open_zarr"), "the session was replaced");
      }),
  );

  await check("a Try press restores a closed window and does not open a third session", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.click(".freva-term .term-kebab");
      await page.waitForSelector(".term-menu.show");
      await page.locator(".tmn-sections .tmn-item", { hasText: "New session" }).click();
      await page.waitForTimeout(300);
      await page.click(".freva-term .tl.close");
      await page.waitForTimeout(300);

      // It restores; it does not create.
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show");
      assert.equal(await page.evaluate(() => window.__consoles().length), 2);
    }),
  );

  // stacking

  await check("alwaysOnTop keeps the window over a portal-owned dialog", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.evaluate(() => window.__openModal());
      await page.waitForTimeout(120);

      const stacking = await page.evaluate(() => {
        const shell = document.querySelector(".portal-python-window");
        const modal = document.getElementById("portal-test-modal");
        const box = document.querySelector(".freva-term").getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 8);
        return {
          window: Number(shell.style.zIndex),
          modal: Number(getComputedStyle(modal).zIndex),
          onTop: Boolean(hit && hit.closest(".freva-term")),
        };
      });
      assert.ok(
        stacking.window > stacking.modal,
        `window ${stacking.window} is not above the dialog ${stacking.modal}`,
      );
      assert.ok(stacking.onTop, "the portal dialog is painted over the window");

      // …and while MINIMIZED it is still above it, which is the half a dock usually loses.
      await page.click(".freva-term .tl.min");
      await page.waitForTimeout(120);
      const docked = await page.evaluate(() => {
        const shell = document.querySelector(".portal-python-window");
        const modal = document.getElementById("portal-test-modal");
        return Number(shell.style.zIndex) > Number(getComputedStyle(modal).zIndex);
      });
      assert.ok(docked, "the minimized window fell behind the dialog");
    }),
  );

  await check("alwaysOnTop: false takes ordinary floating-window ordering", () =>
    withPage("floating", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.evaluate(() => window.__openModal());
      await page.waitForTimeout(120);
      const stacking = await page.evaluate(() => {
        const shell = document.querySelector(".portal-python-window");
        const modal = document.getElementById("portal-test-modal");
        const box = document.querySelector(".freva-term").getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 8);
        return {
          window: Number(shell.style.zIndex),
          modal: Number(getComputedStyle(modal).zIndex),
          covered: Boolean(hit && !hit.closest(".freva-term")),
        };
      });
      assert.ok(
        stacking.window < stacking.modal,
        `floating window ${stacking.window} outranked the dialog ${stacking.modal}`,
      );
      assert.ok(stacking.covered, "the dialog did not cover an ordinary floating window");
    }),
  );

  // accessibility

  await check("two sessions are a real tablist, with panels the tabs point at", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.click(".freva-term .term-kebab");
      await page.getByText("New session…").click();
      await page.waitForFunction(
        () => document.querySelectorAll(".portal-python-tab").length === 2,
      );

      const wiring = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll(".portal-python-tab")];
        const strip = document.querySelector(".portal-python-tabs");
        return {
          stripRole: strip?.getAttribute("role"),
          stripLabel: strip?.getAttribute("aria-label"),
          stripShown: strip ? !strip.hidden : false,
          tabs: tabs.map((tab) => {
            const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
            return {
              selected: tab.getAttribute("aria-selected"),
              tabIndex: tab.tabIndex,
              controls: tab.getAttribute("aria-controls"),
              panelRole: panel?.getAttribute("role") ?? null,
              panelLabelledBy: panel?.getAttribute("aria-labelledby") ?? null,
              pointsBack: panel?.getAttribute("aria-labelledby") === tab.id,
            };
          }),
        };
      });
      assert.equal(wiring.stripRole, "tablist");
      assert.ok(wiring.stripLabel, "the tablist has no accessible name");
      assert.ok(wiring.stripShown, "the tablist is hidden with two sessions");
      assert.equal(wiring.tabs.length, 2);
      for (const tab of wiring.tabs) {
        assert.ok(tab.controls, "a tab controls nothing");
        assert.equal(tab.panelRole, "tabpanel", JSON.stringify(tab));
        assert.ok(tab.pointsBack, `the panel does not name its tab: ${JSON.stringify(tab)}`);
      }
      // Roving tabindex: exactly one tab is in the page's tab order.
      assert.equal(
        wiring.tabs.filter((t) => t.tabIndex === 0).length,
        1,
        JSON.stringify(wiring.tabs.map((t) => t.tabIndex)),
      );
      assert.equal(wiring.tabs.filter((t) => t.selected === "true").length, 1);
    }),
  );

  await check("the arrow keys move between sessions, and the panel follows", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.click(".freva-term .term-kebab");
      await page.getByText("New session…").click();
      await page.waitForFunction(
        () => document.querySelectorAll(".portal-python-tab").length === 2,
      );

      // Session 2 is the active one after creating it; Left goes back to session 1.
      await page.click(".portal-python-tab.is-active");
      await page.keyboard.press("ArrowLeft");
      const afterLeft = await page.evaluate(() => ({
        // The tab carries a close control as well as its name, so the NAME is what is compared.
        focused:
          document.activeElement?.querySelector(".portal-python-tab-label")?.textContent ?? "",
        active:
          document.querySelector(".portal-python-tab.is-active .portal-python-tab-label")
            ?.textContent ?? "",
        shownPanels: [...document.querySelectorAll(".portal-python-session")].filter(
          (p) => !p.hidden,
        ).length,
      }));
      assert.equal(afterLeft.focused, "Session 1", JSON.stringify(afterLeft));
      assert.equal(afterLeft.active, "Session 1", JSON.stringify(afterLeft));
      assert.equal(afterLeft.shownPanels, 1, "more than one panel is visible at once");

      // …and it wraps, which is what makes a two-tab strip usable with one key.
      await page.keyboard.press("ArrowLeft");
      assert.equal(
        await page.evaluate(
          () =>
            document.activeElement?.querySelector(".portal-python-tab-label")?.textContent ?? "",
        ),
        "Session 2",
      );
      await page.keyboard.press("Home");
      assert.equal(
        await page.evaluate(
          () =>
            document.activeElement?.querySelector(".portal-python-tab-label")?.textContent ?? "",
        ),
        "Session 1",
      );
    }),
  );

  await check("with one session the strip is still there, named, with a way to open another", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      const shown = await page.evaluate(() => {
        const strip = document.querySelector(".portal-python-tabs");
        const tabs = [...document.querySelectorAll(".portal-python-tab")];
        const add = document.querySelector(".portal-python-tab-add");
        return {
          strip: strip ? !strip.hidden : false,
          names: tabs.map((t) => t.querySelector(".portal-python-tab-label")?.textContent ?? ""),
          closes: tabs.map((t) => !t.querySelector(".portal-python-tab-close")?.hidden),
          add: Boolean(add) && !add.disabled,
          addInList: Boolean(add?.closest('[role="tablist"]')),
        };
      });
      // THE STRIP IS ALWAYS THERE. Hiding it below two sessions is right while it is only a
      // chooser - one choice is no choice - and wrong the moment it also carries the control that
      // opens a session, because a control you only meet after finding another way to do the same
      // thing is a control nobody uses.
      assert.ok(shown.strip, "the one-tab strip is hidden");
      assert.deepEqual(shown.names, ["Session 1"], JSON.stringify(shown));
      // No close on the last session: ending it would leave a terminal with no prompt in it.
      assert.deepEqual(shown.closes, [false], "the only session offers a close control");
      assert.ok(shown.add, "there is no control to open a session beside the tabs");
      // A tablist may contain tabs and nothing else; `+` selects nothing and controls no panel.
      assert.ok(!shown.addInList, "the add control is inside the tablist");
    }),
  );

  await check("a second session can be opened and ended from the tab strip alone", () =>
    withPage("on", async (page, ctx) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });

      // The harness answers the window's confirmation as soon as it appears - see `withPage` - so
      // what is asserted here is that the question WAS asked, not that a dialog was left on
      // screen long enough to be found.
      await page.click(".portal-python-tab-add");
      await page.waitForFunction(
        () => document.querySelectorAll(".portal-python-tab").length === 2,
        null,
        { timeout: 20_000 },
      );
      assert.ok(
        (await ctx.dialogs()).some((m) => /additional CPU and memory/i.test(m)),
        "the plus opened a second interpreter without asking",
      );

      // At the ceiling the control says why rather than disappearing.
      const full = await page.evaluate(() => {
        const add = document.querySelector(".portal-python-tab-add");
        return { disabled: add.disabled, label: add.getAttribute("aria-label") };
      });
      assert.ok(full.disabled, "the add control is still live at the session limit");
      assert.match(full.label ?? "", /2 interpreters/);

      // Both tabs can be closed now, and closing asks the same question the menu row asks.
      await page.click(".portal-python-tab.is-active .portal-python-tab-close");
      await page.waitForFunction(
        () => document.querySelectorAll(".portal-python-tab").length === 1,
        null,
        { timeout: 20_000 },
      );
      assert.ok(
        (await ctx.dialogs()).some((m) => /interpreter is shut down/i.test(m)),
        "the close control ended a session without asking",
      );
      assert.equal(
        await page.evaluate(() => document.querySelector(".portal-python-tab-add").disabled),
        false,
        "the add control stayed disabled after a session ended",
      );
    }),
  );

  await check("the shortcut panel is a panel, and Escape closes it", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.click(".freva-term .term-kebab");
      await page.waitForSelector(".term-menu.show");
      await page.locator(".tmn-sections .tmn-item", { hasText: "Keyboard shortcuts" }).click();
      await page.waitForSelector(".portal-python-sheet", { timeout: 10_000 });

      // A PANEL, NOT A STATUS LINE. Six key combinations and their meanings run together with
      // middle dots, in a one-line strip sized for "Python is ready", wraps, pushes the console
      // down, cannot be read as a list because it is not one, and can only be dismissed by making
      // something else happen.
      const sheet = await page.evaluate(() => {
        const panel = document.querySelector(".portal-python-sheet");
        const notice = document.querySelector(".portal-python-notice");
        return {
          role: panel.getAttribute("role"),
          named: panel.getAttribute("aria-label"),
          pairs: panel.querySelectorAll(".portal-python-sheet-keys dt").length,
          insideWindow: Boolean(panel.closest(".freva-term")),
          noticeUsed: Boolean(notice) && !notice.hidden,
        };
      });
      assert.equal(sheet.role, "dialog");
      assert.equal(sheet.named, "Keyboard shortcuts");
      assert.ok(sheet.pairs >= 6, `only ${sheet.pairs} shortcuts are listed`);
      assert.ok(sheet.insideWindow, "the panel is not inside the terminal it describes");
      assert.ok(!sheet.noticeUsed, "the shortcuts are still being written into the status line");

      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      assert.equal(await page.locator(".portal-python-sheet").count(), 0, "Escape left it open");

      // And the package guide is the other half of Help. It is checked on its own, below.
      assert.ok(
        await page.locator(".tmn-sections .tmn-item", { hasText: "Python packages" }).count(),
        "the Help section no longer offers the package panel",
      );
    }),
  );

  // THE PACKAGE PANEL STATES A POLICY, not a command. Advertising `await micropip.install("name")`
  // and naming PyPI as the source of pure-Python wheels is false here: the policy this same build
  // writes names the runtime, the services and the data origins and no package index, so the
  // command fails in metadata lookup with `ValueError: Can't fetch metadata for …`, raised before
  // wheel compatibility is even considered. A wrong panel satisfies `/micropip/` and `/no pip/i` -
  // a test that matches a word rather than a claim cannot see a false claim - so what is asserted
  // is the POLICY the panel states, and the specific sentences that would be untrue.
  await check("the package panel states the curated policy and offers no install by name", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.click(".freva-term .term-kebab");
      await page.waitForSelector(".term-menu.show");
      await page.locator(".tmn-sections .tmn-item", { hasText: "Python packages" }).click();
      await page.waitForSelector(".portal-python-sheet", { timeout: 10_000 });

      const packages = await page.evaluate(() => {
        const panel = document.querySelector(".portal-python-sheet");
        const rows = [...panel.querySelectorAll(".portal-python-sheet-keys dt")].map((dt) => [
          dt.textContent ?? "",
          dt.nextElementSibling?.textContent ?? "",
        ]);
        return {
          title: panel.getAttribute("aria-label") ?? "",
          text: panel.textContent ?? "",
          rows,
          link: panel.querySelector(".portal-python-sheet-link")?.getAttribute("href") ?? "",
          linkLabel: panel.querySelector(".portal-python-sheet-link")?.textContent ?? "",
        };
      });
      const row = (name) => packages.rows.find(([key]) => key === name)?.[1] ?? "";

      // 1. The title says what it is, not what it cannot do.
      assert.equal(packages.title, "Python packages");

      // 2. The command that could not work is gone - and nothing else name-shaped replaced it.
      assert.doesNotMatch(packages.text, /micropip\.install\(/);
      assert.doesNotMatch(packages.text, /no pip/i);
      assert.doesNotMatch(packages.text, /no disk/i);
      assert.doesNotMatch(packages.text, /fetch a wheel and import it/i);

      // 3. micropip is still here, because the curated installs run on it and a visitor can look.
      assert.equal(row("import micropip"), "the installer this interpreter carries");
      assert.equal(row("micropip.list()"), "what this session actually has");

      // 4. The policy, in the words the addendum required.
      assert.match(packages.text, /curated Python environment/);
      assert.match(packages.text, /load automatically when you import them/);
      assert.match(packages.text, /installed only when the portal operator has enabled/);
      // The restricted sentence, in the words the panel uses: "packages by name from a public
      // index" rather than "arbitrary packages ... from public PyPI", because the claim is
      // identical and "public PyPI" was never the only index the refusal covered. This fixture is
      // a RESTRICTED deployment, so the sentence must be here; the same panel has a second thing
      // to say when the deployment is the open one, which
      // `tests/contracts/package-help.test.ts` holds it to.
      assert.match(
        packages.text,
        /packages by name from a public index is not enabled by this site/,
      );

      // 5. The resolved environment: this fixture is `minimal` with no add-ons, and says so.
      assert.equal(row("profile"), "minimal");
      assert.equal(row("add-ons"), "none enabled for this portal");
      // …and the origin row comes from the same value that wrote the page's connect-src.
      assert.match(row("packages come from"), /^the pinned runtime at https:\/\//);

      // 6. Nothing is claimed about an interpreter that is not reporting: this stub sends no
      //    ready payload, so the panel omits versions and says how to see them.
      assert.equal(row("loaded"), "");
      assert.equal(row("/workspace"), "");
      assert.match(packages.text, /Start the interpreter to see what it loaded/);
      // WHAT ENDS A SESSION, stated the way it actually works. Closing the window HIDES it and
      // the session keeps running, so "Nothing survives the session" beside a sentence claiming
      // that closing the window ends the interpreter makes a visitor believe their variables are
      // gone. The two sentences that say it correctly are what is checked, and that one must not
      // come back.
      assert.match(packages.text, /`Restart session` replaces it/);
      assert.match(packages.text, /Closing this window only hides it/);
      assert.match(packages.text, /the session keeps running/);
      assert.doesNotMatch(packages.text, /Nothing survives the session/);

      // 7. The link stays, framed so it cannot be read as a promise about THIS deployment.
      assert.match(packages.link, /micropip\.pyodide\.org/);
      assert.match(packages.linkLabel, /describes micropip in general; this site is stricter/);
    }),
  );

  await check("…and reports what the interpreter said, once one has reported anything", () =>
    withPage(
      "on",
      async (page) => {
        const tryIt = await openExample(page);
        await page.waitForSelector(tryIt);
        await page.click(tryIt);
        await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
        await page.click(".freva-term .term-kebab");
        await page.waitForSelector(".term-menu.show");
        await page.locator(".tmn-sections .tmn-item", { hasText: "Python packages" }).click();
        await page.waitForSelector(".portal-python-sheet", { timeout: 10_000 });
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll(".portal-python-sheet-keys dt")].map((dt) => [
            dt.textContent ?? "",
            dt.nextElementSibling?.textContent ?? "",
          ]),
        );
        const row = (name) => rows.find(([key]) => key === name)?.[1] ?? "";
        const text = await page.evaluate(
          () => document.querySelector(".portal-python-sheet")?.textContent ?? "",
        );

        // The versions the INTERPRETER reported, not numbers written into the portal.
        assert.match(row("loaded"), /micropip 0\.9\.9/);
        assert.match(row("loaded"), /xarray 2026\.2\.0/);
        // An add-on it actually prepared, keyed by the add-on's own id.
        assert.match(row("dask"), /dask 2026\.8\.0/);
        // AND THE WORKSPACE AS REPORTED. "no disk" unconditionally is false whenever OPFS is
        // available - the ordinary case - and is the difference between "your file is on disk
        // until this session ends" and "it is in this tab's memory".
        assert.match(row("/workspace"), /disk-backed/);
        assert.match(row("/workspace"), /64/);
        assert.match(row("/workspace"), /only for this session/);
        assert.match(text, /What is listed above is what this interpreter reported/);
      },
      {
        readyInfo: {
          profile: "xarray-zarr",
          pythonVersion: "3.14.2",
          pyodideVersion: "314.0.6",
          packages: { micropip: "0.9.9", xarray: "2026.2.0" },
          addons: [{ id: "dask", title: "Browser Dask", versions: { dask: "2026.8.0" } }],
          workspace: { available: true, maxFiles: 64, path: "/workspace", sessionId: "s1" },
        },
      },
    ),
  );

  await check("…and says the workspace is not disk-backed when the interpreter says so", () =>
    withPage(
      "on",
      async (page) => {
        const tryIt = await openExample(page);
        await page.waitForSelector(tryIt);
        await page.click(tryIt);
        await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
        await page.click(".freva-term .term-kebab");
        await page.waitForSelector(".term-menu.show");
        await page.locator(".tmn-sections .tmn-item", { hasText: "Python packages" }).click();
        await page.waitForSelector(".portal-python-sheet", { timeout: 10_000 });
        const workspace = await page.evaluate(() => {
          const dt = [...document.querySelectorAll(".portal-python-sheet-keys dt")].find(
            (node) => node.textContent === "/workspace",
          );
          return dt?.nextElementSibling?.textContent ?? "";
        });
        assert.match(workspace, /not disk-backed here/);
        // The interpreter's own sentence, carried through rather than paraphrased.
        assert.match(workspace, /this browser has no synchronous storage handles/);
        assert.match(workspace, /files stay in this tab's memory/);
      },
      {
        readyInfo: {
          profile: "minimal",
          pythonVersion: "3.14.2",
          pyodideVersion: "314.0.6",
          packages: {},
          addons: [],
          workspace: {
            available: false,
            detail: "this browser has no synchronous storage handles",
            path: "/workspace",
            maxFiles: 0,
            sessionId: "s2",
          },
        },
      },
    ),
  );

  await check("no package index is contacted by a page that carries a playground", () =>
    withPage("on", async (page, ctx) => {
      // A CLAIM ABOUT TRAFFIC, CHECKED AS TRAFFIC. The interpreter is stubbed here, so this is
      // not evidence about what a running Pyodide fetches - `@freva-org/browser-python`'s own
      // `browser-tests/addons.mjs` observes that, with a real interpreter, and asserts the same
      // absence. What THIS layer can prove is that the portal's own page - its bundle, its
      // config, its help panel - reaches no index while a visitor opens the terminal.
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.click(".freva-term .term-kebab");
      await page.waitForSelector(".term-menu.show");
      await page.locator(".tmn-sections .tmn-item", { hasText: "Python packages" }).click();
      await page.waitForSelector(".portal-python-sheet", { timeout: 10_000 });

      const indexes = ctx.requests.filter((url) =>
        /pypi\.org|pythonhosted\.org|test\.pypi\.org/.test(url),
      );
      assert.deepEqual(indexes, [], `a package index was contacted: ${indexes.join(", ")}`);
      // Not vacuous: the page did fetch things, and they were all its own origin.
      assert.ok(ctx.requests.length > 3, "no requests were recorded at all");
      assert.ok(
        ctx.requests.every((url) => url.startsWith("http://127.0.0.1:") || url.startsWith("data:")),
        `something off-origin was fetched: ${ctx.requests.filter((u) => !u.startsWith("http://127.0.0.1:") && !u.startsWith("data:")).join(", ")}`,
      );
    }),
  );

  await check("the window opens on the interpreter's own lines and nothing else", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });

      // THE CONSOLE'S OWN BANNER IS OFF, and the first-load notice follows it. The console opens
      // with a keyboard guide - "Enter runs · Tab completes · ↑ history · Ctrl+R search" - and,
      // on a first visit, a line saying the runtime is being downloaded. Both are written for a
      // console standing alone on a page; in here the shortcuts have a panel of their own on
      // Ctrl+/ and the download has the status line, so the two lines would be the first thing a
      // visitor reads and the least useful, pushing the interpreter's own version line out of the
      // top of a short window.
      const opening = await page.evaluate(() => {
        const el = document.querySelector("freva-python-console");
        return { banner: el?.banner, hasElement: Boolean(el) };
      });
      assert.ok(opening.hasElement, "no console in the window");
      assert.equal(opening.banner, false, "the console still writes its own opening lines");
    }),
  );

  await check("a minimized window locks the actions it cannot ask about", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.evaluate(() => document.querySelector(".freva-term .tl.min")?.click());
      await page.waitForTimeout(300);
      await page.evaluate(() => document.querySelector(".freva-term .term-kebab")?.click());
      await page.waitForSelector(".term-menu.show");

      // Each of the three raises a confirmation, and a confirmation is drawn in the window's own
      // body - which a minimized window has collapsed to its title bar. The dialog would be
      // rendered into a two-pixel strip: a sliver of a question with its buttons off the bottom
      // and no way to answer or dismiss it.
      const rows = await page.$$eval(".tmn-sections .tmn-item", (list) =>
        list.map((b) => ({
          label: b.textContent.trim(),
          disabled: b.disabled === true,
          hint: b.getAttribute("title") ?? "",
        })),
      );
      for (const label of ["New session", "Restart session", "End session"]) {
        const row = rows.find((r) => r.label.startsWith(label));
        assert.ok(row, `${label} is missing from the menu`);
        assert.ok(row.disabled, `${label} is still live while the window is minimized`);
        // Disabled and unexplained is the other half of the same mistake, so the reason is
        // asserted on the row's hover help rather than inside its label. "(restore the window
        // first)" IN THE LABEL puts the same four words on six of eleven rows, widening the menu
        // to the longest of them and wrapping it, writing the thing to do next six times and
        // offering it nowhere. The remedy is a row, asserted below.
        assert.match(row.hint, /window is minimized/i, `${label} is disabled without saying why`);
      }
      const restore = rows.find((r) => r.label === "Restore the window");
      assert.ok(restore, "a stowed window's menu offers no way to restore it");
      assert.ok(!restore.disabled, "the restore row is disabled");
      // The transcript rows still work: none of them asks a question.
      assert.ok(
        rows.some((r) => r.label === "Copy transcript" && !r.disabled),
        "the transcript rows were locked too",
      );
    }),
  );

  await check("hiding the window puts the focus back where the visitor left it", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      // FOCUS the control rather than clicking it, so there is a definite element to return to.
      await page.focus(tryIt);
      await page.keyboard.press("Enter");
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      const inside = await page.evaluate(
        () => !!document.activeElement?.closest(".freva-term, .portal-python-window"),
      );
      assert.ok(inside, "the window did not take the focus when it opened");

      // SCROLLED AWAY FIRST, deliberately, because that is the state the second half of this
      // check is about: a visitor opens the terminal from a control near the top of a long page
      // and then reads their way down. Closing it must not take them back.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(120);
      const scrolledTo = await page.evaluate(() => window.scrollY);

      await page.click(".freva-term .tl.close");
      await page.waitForFunction(
        () => !document.querySelector(".freva-term")?.classList.contains("show"),
      );
      const back = await page.evaluate(
        () => document.activeElement?.getAttribute("data-dt-key") ?? "",
      );
      assert.equal(back, "try:cmip6/tas", `focus went to ${back || "nowhere"}`);
      // ...and it does so WITHOUT scrolling. Focusing an element is also a request to reveal it,
      // which would jump the page back to whichever `Try in Python` opened the window, throwing
      // away wherever the visitor had read to. `preventScroll` keeps the focus move and declines
      // the reveal; the browser brings the control into view on their next key, when it is their
      // own movement doing it.
      const after = await page.evaluate(() => window.scrollY);
      assert.ok(
        scrolledTo > 0,
        "the page does not scroll, so this cannot tell whether closing moves it",
      );
      assert.ok(
        Math.abs(after - scrolledTo) < 4,
        `closing the terminal scrolled the page from ${scrolledTo} to ${after}`,
      );
    }),
  );

  await check("maximizing puts the caret back at the prompt", () =>
    withPage("on", async (page) => {
      // The point of filling the screen with a console is typing into it. Maximizing leaves the
      // focus on the zoom control that was just pressed unless it is moved, so a visitor who did
      // exactly that would have to click into the transcript before the keyboard reached Python.
      // The press came from inside the window, so moving the focus the last few pixels to the
      // prompt is not taking it from the page - it is finishing the gesture. Restoring is asserted
      // too, for the same reason: the window is still the thing being worked in after it shrinks.
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });

      for (const pass of ["maximize", "restore"]) {
        await page.click(".freva-term .tl.zoom");
        await page.waitForTimeout(120);
        const on = await page.evaluate(() => ({
          zoomed: !!document.querySelector(".freva-term")?.classList.contains("zoomed"),
          onZoomButton: !!document.activeElement?.closest?.(".tl.zoom"),
          inConsole: !!document.activeElement?.closest(".freva-term, .portal-python-window"),
        }));
        assert.equal(on.zoomed, pass === "maximize", `${pass} did not change the window state`);
        assert.ok(!on.onZoomButton, `the focus stayed on the zoom control after ${pass}`);
        assert.ok(on.inConsole, `the focus left the window on ${pass}`);
      }
    }),
  );

  await check("a Try press focuses the prompt even when the window is already open", () =>
    withPage("on", async (page) => {
      // The ORDINARY case: the first press is what opens the window, so every press after it is
      // a press on an open one. Focus conditional on the window not already being shown leaves
      // the second example running into a console the caret is not in - the visitor watches their
      // code execute, then has to click the transcript to type the next line.
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });

      // Put the focus back out on the page, the way reading the article again would.
      await page.focus(tryIt);
      const left = await page.evaluate(
        () => !document.activeElement?.closest(".freva-term, .portal-python-window"),
      );
      assert.ok(left, "the focus could not be moved out of the window, so nothing was measured");

      await page.click(tryIt);
      await page.waitForTimeout(150);
      const back = await page.evaluate(
        () => !!document.activeElement?.closest(".freva-term, .portal-python-window"),
      );
      assert.ok(back, "a second Try press left the focus outside the window");

      const ran = await page.evaluate(() => window.__consoles()[0]?.ran ?? []);
      assert.equal(ran.length, 2, `ran ${ran.length} examples, expected both presses to run`);
    }),
  );

  await check("axe finds no violations with the window open and two sessions", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });
      await page.click(".freva-term .term-kebab");
      await page.getByText("New session…").click();
      await page.waitForFunction(
        () => document.querySelectorAll(".portal-python-tab").length === 2,
      );
      await page.click(".portal-python-tab.is-active");

      await page.addScriptTag({ url: `${bases.on}__axe-core.js` });
      const violations = await page.evaluate(async () => {
        const run = await window.axe.run(document.body, {
          resultTypes: ["violations"],
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        });
        return run.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
        }));
      });
      assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
    }),
  );

  await check("the window keeps out of the way of a virtual keyboard", () =>
    withPage("on", async (page) => {
      const tryIt = await openExample(page);
      await page.waitForSelector(tryIt);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 20_000 });

      // A REAL virtual keyboard cannot be opened by automation and `visualViewport` is read-only,
      // so what is exercised here is the handler's own arithmetic against a synthesised event:
      // the shell shrinking, and a window below the fold being lifted. That a keyboard shrinks
      // the visual viewport and not the layout viewport is a platform fact this suite takes as
      // given rather than re-establishing.
      const moved = await page.evaluate(() => {
        const shell = document.querySelector(".portal-python-window");
        const term = document.querySelector(".freva-term");
        // Put the window at the bottom, where a keyboard would cover it.
        term.style.top = `${window.innerHeight - 120}px`;
        const before = term.getBoundingClientRect().top;
        const vv = window.visualViewport;
        Object.defineProperty(vv, "height", {
          value: window.innerHeight - 300,
          configurable: true,
        });
        vv.dispatchEvent(new Event("resize"));
        return {
          supported: Boolean(vv),
          bottom: shell.style.bottom,
          before,
          after: term.getBoundingClientRect().top,
        };
      });
      if (!moved.supported) return;
      assert.equal(moved.bottom, "300px", JSON.stringify(moved));
      assert.ok(moved.after < moved.before, `the window did not move up: ${JSON.stringify(moved)}`);
    }),
  );
} finally {
  await browser.close();
  for (const server of Object.values(servers)) server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} python playground checks passed`,
);
process.exit(failed.length > 0 ? 1 : 0);
