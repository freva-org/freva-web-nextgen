/**
 * Renders every documented console state to a PNG, for human review.
 *
 *   node scripts/console-screenshots.mjs [--out screenshots]
 *
 * Deliberately a REVIEW TOOL and not a gate. A pixel-diff baseline for a console is a promise
 * this package cannot keep: the transcript is a monospace grid whose metrics come from the
 * visitor's font stack, three engines rasterise text differently, and `prefers-color-scheme`
 * and `prefers-reduced-motion` each double the matrix - baselines for that fail on a font
 * update and teach everyone to re-bless without looking. What IS gated lives in
 * `browser-tests/console.mjs`, where the same states are asserted structurally: the prompt
 * string, the line kinds and their order, the listbox roles, the token classes, the `::part()`
 * names.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consolePage, TINY_PNG } from "../browser-tests/console-fixture.mjs";
import { bundleConsole, requireDist, serve } from "../browser-tests/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOut = process.argv.indexOf("--out");
const OUT = path.resolve(HERE, "..", argOut === -1 ? "screenshots" : process.argv[argOut + 1]);

requireDist();
bundleConsole();

const playwright = await import("playwright");
const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** Each state: what to set up in the page, and at what viewport and colour scheme. */
const STATES = [
  {
    name: "01-loading",
    note: "the engine is downloading; the console says so and takes input anyway",
    setUp: async (page) => {
      // Hold the mock in `loading` so the state is photographable rather than a flash.
      await page.evaluate(() => {
        window.__c.mock.start = () =>
          new Promise(() =>
            window.__c.mock._emitStatus("loading", "downloading the Python runtime"),
          );
        void window.__el.start();
      });
      await page.waitForTimeout(200);
    },
  },
  {
    name: "02-ready",
    note: "started, banner shown, prompt waiting",
    setUp: async (page) => await start(page),
  },
  {
    name: "03-stdout-and-result",
    note: "printed output followed by the expression's value",
    setUp: async (page) => {
      await start(page);
      await run(page, 'print("loading 3 variables")', [
        { type: "stdout", executionId: "e1", text: "loading 3 variables\n" },
        { type: "result", executionId: "e1", text: "42" },
      ]);
    },
  },
  {
    name: "04-traceback",
    note: "a real traceback on stderr - not highlighted, because it is not source",
    setUp: async (page) => {
      await start(page);
      await run(page, "1 / 0", [
        {
          type: "stderr",
          executionId: "e1",
          text:
            "Traceback (most recent call last):\n" +
            '  File "<console>", line 1, in <module>\n' +
            "ZeroDivisionError: division by zero\n",
        },
      ]);
    },
  },
  {
    name: "05-multi-line",
    note: "a continuation prompt, mid-block",
    setUp: async (page) => {
      await start(page);
      await page.evaluate(async () => {
        window.__c.mock.pushImpl = async () => ({
          executionId: "e",
          syntax: "incomplete",
          executed: false,
        });
        await window.__el.execute("def double(value):");
      });
      await page.evaluate(() => window.__c.focusInput());
      await page.keyboard.type("    return value * 2", { delay: 1 });
      await page.waitForTimeout(120);
    },
  },
  {
    name: "06-completion-menu",
    note: "Tab, with the engine's matches in a listbox",
    setUp: async (page) => {
      await start(page);
      await page.evaluate(() => {
        window.__c.mock.completeImpl = async () => ({
          start: 5,
          matches: ["open_zarr(", "open_dataset(", "open_mfdataset(", "open_dataarray("],
        });
        window.__c.focusInput();
      });
      await page.keyboard.type("xr.op", { delay: 1 });
      await page.keyboard.press("Tab");
      await page.waitForTimeout(150);
    },
  },
  {
    name: "07-history-suggestion",
    note: "the greyed-out completion of a previous command, accepted with the right arrow",
    setUp: async (page) => {
      await start(page);
      await typeAndEnter(page, "ds = xr.open_zarr(URL, consolidated=True)");
      await page.evaluate(() => window.__c.focusInput());
      await page.keyboard.type("ds = xr.", { delay: 1 });
      await page.waitForTimeout(150);
    },
  },
  {
    name: "08-reverse-search",
    note: "Ctrl+R, searching backwards through history",
    setUp: async (page) => {
      await start(page);
      await typeAndEnter(page, "ds = xr.open_zarr(URL, consolidated=True)");
      await typeAndEnter(page, "wind = ds.sfcWind.isel(time=0)");
      await page.evaluate(() => window.__c.focusInput());
      await page.keyboard.press("Control+r");
      await page.keyboard.type("zarr", { delay: 1 });
      await page.waitForTimeout(150);
    },
  },
  {
    name: "09-inline-figure",
    note: "a Matplotlib PNG, as a blob URL with alt text and a download link",
    setUp: async (page) => {
      await start(page);
      await run(page, "wind.plot()", [
        {
          type: "display",
          executionId: "e1",
          mime: "image/png",
          encoding: "base64",
          data: TINY_PNG,
          metadata: { figure: 1 },
        },
      ]);
    },
  },
  {
    name: "10-engine-died",
    note: "the engine died; the console says so and offers the only honest recovery",
    setUp: async (page) => {
      await start(page);
      await page.evaluate(() =>
        window.__c.mock._emitStatus("error", "the Python worker stopped responding"),
      );
      await page.waitForTimeout(120);
    },
  },
  {
    name: "11-light",
    note: "the same ready state under prefers-color-scheme: light",
    colorScheme: "light",
    setUp: async (page) => {
      await start(page);
      await run(page, "wind.mean().item()", [{ type: "result", executionId: "e1", text: "7.43" }]);
    },
  },
  {
    name: "12-narrow",
    note: "360px, where the toolbar and a long traceback have to fit anyway",
    viewport: { width: 360, height: 640 },
    setUp: async (page) => {
      await start(page);
      await run(page, "ds", [
        {
          type: "stdout",
          executionId: "e1",
          text: "<xarray.Dataset> Size: 2GB\nDimensions:  (time: 1980, lat: 192, lon: 384)\n",
        },
      ]);
    },
  },
  {
    name: "13-highlighted-python",
    note: "the transcript's own commands, tokenised - the theming contract's classes",
    setUp: async (page) => {
      await start(page);
      await typeAndEnter(page, "# load one timestep");
      await typeAndEnter(page, "ds = xr.open_zarr(URL, consolidated=True, chunks=None)");
      await typeAndEnter(page, "total = sum([1, 2, 3]) * 2.5");
      await page.evaluate(() => window.__c.focusInput());
      await page.keyboard.type(`name = f"{ds.attrs['title']!r}"`, { delay: 1 });
      await page.waitForTimeout(150);
    },
  },
  {
    name: "14-themed",
    note: "nine custom properties, no stylesheet override - what a host actually does",
    setUp: async (page) => {
      await start(page);
      await page.evaluate(() => {
        window.__el.setAttribute(
          "style",
          [
            "--bp-console-background:#101418",
            "--bp-console-foreground:#e3e8ef",
            "--bp-console-accent:#7cc4ff",
            "--bp-console-prompt:#8fe3b0",
            "--bp-console-result:#d9c2ff",
            "--bp-console-border:#243040",
            "--bp-console-radius:14px",
            "--bp-syntax-keyword:#ff9ecb",
            "--bp-syntax-string:#ffd28a",
          ].join(";"),
        );
      });
      await typeAndEnter(page, 'greeting = "hello"');
      await run(page, "len(greeting)", [{ type: "result", executionId: "e1", text: "5" }]);
    },
  },
];

// ------ page helpers

async function start(page) {
  await page.evaluate(() => window.__el.start());
  await page.waitForFunction(() => window.__c.mock.state === "ready", null, { timeout: 15000 });
  await page.waitForTimeout(80);
}

async function typeAndEnter(page, source) {
  await page.evaluate(() => window.__c.focusInput());
  await page.keyboard.type(source, { delay: 1 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(80);
}

/** Type a command, then have the mock emit what a real engine would have produced. */
async function run(page, source, events) {
  await typeAndEnter(page, source);
  await page.evaluate((list) => {
    for (const event of list) window.__c.mock.emit(event);
  }, events);
  await page.waitForTimeout(120);
}

// ------ the run

const browser = await playwright.chromium.launch({
  ...(override ? { executablePath: override } : {}),
  args: ["--no-sandbox"],
});
const server = await serve(consolePage());
let captured = 0;

try {
  for (const state of STATES) {
    const page = await browser.newPage({
      viewport: state.viewport ?? { width: 900, height: 620 },
      colorScheme: state.colorScheme ?? "dark",
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    await state.setUp(page);

    const file = path.join(OUT, `${state.name}.png`);
    await page.locator("#c").screenshot({ path: file });
    await page.close();

    captured += 1;
    console.log(
      `  ${state.name.padEnd(24)} ${state.note}${errors.length ? `  [PAGE ERROR: ${errors[0]}]` : ""}`,
    );
    // A page error means the screenshot shows a broken console, which is worth failing over even
    // though the appearance itself is not gated.
    if (errors.length) process.exitCode = 1;
  }
} finally {
  await server.close();
  await browser.close();
}

console.log(`\n${captured} states captured in ${path.relative(process.cwd(), OUT)}/`);
console.log(
  "Review them by eye. They are not a pass/fail gate - see the note at the top of this file.",
);
