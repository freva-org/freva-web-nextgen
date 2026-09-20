/**
 * Every documented keyboard shortcut, driven with REAL keystrokes.
 *
 * `console.mjs` drives most behaviour through the element's API, which proves the behaviour is
 * right and nothing about whether a key reaches it. jQuery Terminal normalises the event before
 * handing it on, and does so by MUTATING it (`e.key = ie_key_fix(e)`), so `Tab` arrives as `TAB`,
 * `ArrowUp` as `ARROWUP` and a typed `z` as `Z`. Nothing throws: Tab completion simply never
 * fires, Escape never closes the menu, and reverse search records the query in capitals. So
 * nothing here calls a method - every check is a key press and an observable consequence.
 */
import { consolePage } from "./console-fixture.mjs";
import { bundleConsole, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();
bundleConsole();

const browserName = process.env.BROWSER_ENGINE ?? "chromium";

const result = await inBrowser(
  async (page) => {
    const server = await serve(consolePage());
    const checks = [];

    /** State readable after every key. Nothing here drives the console. */
    const look = () =>
      page.evaluate(() => {
        const root = window.__el.shadowRoot;
        const menu = root.querySelector(".bp-completion");
        const line = root.querySelector(".cmd-cursor-line");
        // THE GHOST IS INSIDE THE COMMAND LINE, so reading the line's `textContent` whole would
        // report a suggestion nobody accepted as though it had been typed. The probe separates
        // the two, and every `command` assertion below is about the buffer alone.
        const ghostNode = line?.querySelector(".bp-ghost") ?? null;
        const ghost = ghostNode?.textContent ?? "";
        const whole = line?.textContent ?? "";
        return {
          // The surface paints every space as a NO-BREAK SPACE so a run of them cannot
          // collapse. Normalised here so assertions can be written in ordinary spaces.
          command: (ghost ? whole.slice(0, whole.length - ghost.length) : whole).replace(
            /\u00a0/g,
            " ",
          ),
          ghost,
          buffer: window.__c.mock.lastCommand ?? null,
          pushes: [...window.__c.mock.pushes],
          prompt: root.querySelector(".cmd-prompt")?.textContent ?? "",
          menuOpen: menu ? !menu.hidden : false,
          // Without the `N of M` counter, which is decoration on the selected row rather than a
          // candidate the engine offered.
          menuItems: [...(menu?.children ?? [])].map((li) =>
            [...li.childNodes]
              .filter((n) => !(n.nodeType === 1 && n.classList.contains("bp-completion-count")))
              .map((n) => n.textContent)
              .join(""),
          ),
          menuActive: [...(menu?.children ?? [])].findIndex(
            (li) => li.getAttribute("aria-selected") === "true",
          ),
          // The suggestion as it is actually shown: inline at the caret. The `.bp-suggestion` bar
          // is the fallback for a surface that cannot take a node inside its command line, and is
          // read here too so this check keeps its meaning on either path.
          suggestion:
            ghost ||
            (() => {
              const s = root.querySelector(".bp-suggestion");
              return s && !s.hidden ? s.textContent : null;
            })(),
          search: (() => {
            const s = root.querySelector(".bp-search");
            return s && !s.hidden ? s.textContent : null;
          })(),
          lines: root.querySelectorAll(".bp-line").length,
        };
      });

    /** Type into the terminal itself. `delay` because the plugin batches on keypress. */
    const type = async (text) => {
      await page.evaluate(() => window.__c.focusInput());
      await page.keyboard.type(text, { delay: 2 });
      await page.waitForTimeout(60);
    };
    const press = async (...keys) => {
      for (const key of keys) await page.keyboard.press(key);
      await page.waitForTimeout(90);
    };
    const reset = async () =>
      await page.evaluate(() => {
        window.__c.mock.pushes.length = 0;
        window.__c.element.clear();
      });

    try {
      await page.goto(server.url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      await page.evaluate(() => window.__el.start());
      await page.waitForFunction(() => window.__c.mock.state === "ready", null, { timeout: 15000 });

      // Enter

      await type("value = 21 * 2");
      await press("Enter");
      checks.push({
        name: "Enter submits the line",
        pass: (await look()).pushes.includes("value = 21 * 2"),
      });

      // Shift+Enter

      await reset();
      await type("total = (");
      await press("Shift+Enter");
      await type("    1 + 2)");
      const multiline = await look();
      checks.push({
        name: "Shift+Enter inserts a newline WITHOUT submitting",
        pass: multiline.pushes.length === 0 && multiline.command.includes("1 + 2)"),
        detail: JSON.stringify({ pushes: multiline.pushes.length, command: multiline.command }),
      });
      await press("Enter");

      // Tab

      await reset();
      await page.evaluate(() => {
        window.__c.mock.completeImpl = async () => ({
          start: 3,
          matches: ["open_zarr(", "open_dataset(", "open_mfdataset("],
        });
      });
      await type("xr.op");
      await press("Tab");
      const menu = await look();
      checks.push({
        name: "Tab asks the engine for completions and opens the menu",
        pass: menu.menuOpen && menu.menuItems.length === 3 && menu.menuActive === 0,
        detail: JSON.stringify({ items: menu.menuItems, active: menu.menuActive }),
      });

      // Tab / Shift+Tab cycle

      // THE ARROWS MOVE THE MENU. Tab alone is the shell convention, and not what a list with one
      // row highlighted asks for.
      await press("ArrowDown");
      const arrowDown = (await look()).menuActive;
      await press("ArrowUp");
      const arrowUp = await look();
      checks.push({
        name: "↓ and ↑ move the highlight while the menu is open",
        pass: arrowDown === 1 && arrowUp.menuActive === 0 && arrowUp.menuOpen,
        detail: JSON.stringify({ arrowDown, back: arrowUp.menuActive }),
      });
      checks.push({
        name: "…and the arrows do not touch history while the menu owns them",
        pass: arrowUp.command.trim().startsWith("xr.op"),
        detail: JSON.stringify(arrowUp.command),
      });

      await press("Tab");
      const forward = (await look()).menuActive;
      await press("Shift+Tab", "Shift+Tab");
      const backward = (await look()).menuActive;
      checks.push({
        name: "Tab and Shift+Tab cycle the menu in both directions, wrapping",
        pass: forward === 1 && backward === 2,
        detail: JSON.stringify({ afterTab: forward, afterTwoShiftTabs: backward }),
      });

      // Escape

      await press("Escape");
      const closed = await look();
      checks.push({
        name: "Escape closes the menu and inserts nothing",
        pass: !closed.menuOpen && closed.command.trim() === "xr.op",
        detail: JSON.stringify({ open: closed.menuOpen, command: closed.command }),
      });

      // Enter on the menu

      await press("Tab"); // re-open
      await press("Enter");
      const accepted = await look();
      checks.push({
        name: "Enter on an open menu INSERTS the completion and does not run the line",
        pass: accepted.pushes.length === 0 && accepted.command.includes("xr.open_zarr("),
        detail: JSON.stringify({ pushes: accepted.pushes, command: accepted.command.trim() }),
      });
      await press("Control+c"); // abandon the half-typed line

      // Tab indents

      await reset();
      await page.evaluate(() => (window.__c.mock.completeCalls.length = 0));
      await type("");
      await press("Tab");
      const indented = await look();
      checks.push({
        name: "Tab on an empty line indents rather than offering a module list",
        pass:
          indented.command.startsWith("    ") &&
          (await page.evaluate(() => window.__c.mock.completeCalls.length)) === 0,
        detail: JSON.stringify({ command: JSON.stringify(indented.command) }),
      });
      await press("Control+c");

      // history: arrows

      await reset();
      await type("first = 1");
      await press("Enter");
      await type("second = 2");
      await press("Enter");
      await press("ArrowUp");
      const up1 = (await look()).command.trim();
      await press("ArrowUp");
      const up2 = (await look()).command.trim();
      await press("ArrowDown");
      const down1 = (await look()).command.trim();
      checks.push({
        name: "Up walks back through history and Down walks forward again",
        pass: up1 === "second = 2" && up2 === "first = 1" && down1 === "second = 2",
        detail: JSON.stringify({ up1, up2, down1 }),
      });

      // history: Ctrl+P / Ctrl+N

      await press("Control+c");
      await press("Control+p");
      const ctrlP = (await look()).command.trim();
      await press("Control+n");
      const ctrlN = (await look()).command.trim();
      checks.push({
        name: "Ctrl+P and Ctrl+N do the same as the arrows",
        pass: ctrlP === "second = 2" && ctrlN === "",
        detail: JSON.stringify({ ctrlP, ctrlN }),
      });

      // prefix navigation

      await press("Control+c");
      await type("first");
      await press("ArrowUp");
      const prefix = (await look()).command.trim();
      checks.push({
        name: "Up filters history by what is already typed",
        pass: prefix === "first = 1",
        detail: prefix,
      });
      await press("Control+c");

      // suggestion

      await type("sec");
      const suggested = await look();
      checks.push({
        name: "typing shows the greyed-out completion of a previous command",
        pass: (suggested.suggestion ?? "").includes("ond = 2"),
        detail: JSON.stringify(suggested.suggestion),
      });

      await press("ArrowRight");
      const acceptedSuggestion = (await look()).command.trim();
      checks.push({
        name: "Right at end of line accepts the suggestion",
        pass: acceptedSuggestion === "second = 2",
        detail: acceptedSuggestion,
      });

      // A MULTI-LINE ENTRY GHOSTS AS ONE LINE. History keeps a pasted block as ONE entry, so
      // `suggest()` can return a suffix with newlines in it, and drawn literally those newlines go
      // into the command line - the typed characters stranded among five lines of somebody's
      // example. The whole entry is still what accepting inserts; the ellipsis is what says so.
      await press("Control+c");
      await reset();
      await page.evaluate(() =>
        window.__c.element.execute("import xarray as xr\nds = xr.open_dataset(URL)\nprint(ds)"),
      );
      await page.waitForTimeout(150);
      await type("import x");
      const block = await look();
      checks.push({
        name: "a multi-line history entry is suggested as its first line and an ellipsis",
        pass:
          !(block.ghost ?? "").includes("\n") &&
          (block.ghost ?? "").trim().endsWith("…") &&
          (block.ghost ?? "").includes("array as xr"),
        detail: JSON.stringify(block.ghost),
      });
      await press("ArrowRight");
      // Read from `.cmd-wrapper` rather than the cursor line: a multi-line buffer is drawn as
      // several elements and the cursor line is only the one the caret is on, so it would report
      // the last line and pass for the wrong reason.
      const acceptedBlock = await page.evaluate(() => {
        const wrapper = window.__el.shadowRoot.querySelector(".cmd .cmd-wrapper");
        const ghost = wrapper?.querySelector(".bp-ghost")?.textContent ?? "";
        const whole = (wrapper?.textContent ?? "").replace(/\u00a0/g, " ");
        return ghost ? whole.slice(0, whole.length - ghost.length) : whole;
      });
      checks.push({
        name: "…and accepting it still takes the whole block, not just the line that was shown",
        pass: acceptedBlock.includes("import xarray as xr") && acceptedBlock.includes("print(ds)"),
        detail: JSON.stringify(acceptedBlock),
      });
      await press("Control+c");
      await reset();

      await type("second = 2");
      await press("Enter");
      await press("Control+c");
      await type("sec");
      await press("Control+e");
      const ctrlE = (await look()).command.trim();
      checks.push({
        name: "Ctrl+E accepts it too",
        pass: ctrlE === "second = 2",
        detail: ctrlE,
      });
      await press("Control+c");

      // reverse search

      await press("Control+r");
      await type("fir");
      const searching = await look();
      checks.push({
        name: "Ctrl+R opens reverse search and records the query in the case it was typed",
        // The bug this suite was written for: `FIR` here would mean the key never reached us
        // unmangled, and a search for `fir` would find nothing in a history of lowercase Python.
        pass:
          (searching.search ?? "").includes("fir") && (searching.search ?? "").includes("first"),
        detail: JSON.stringify(searching.search),
      });

      await press("Backspace");
      const afterBackspace = await look();
      checks.push({
        name: "Backspace shortens the search query",
        pass: (afterBackspace.search ?? "").includes("fi"),
        detail: JSON.stringify(afterBackspace.search),
      });

      await press("Enter");
      const searchAccepted = await look();
      checks.push({
        name: "Enter accepts the match into the command line without running it",
        pass: searchAccepted.search === null && searchAccepted.command.includes("first = 1"),
        detail: JSON.stringify({
          search: searchAccepted.search,
          command: searchAccepted.command.trim(),
        }),
      });
      await press("Control+c");

      await press("Control+r");
      await type("fir");
      await press("Control+g");
      checks.push({
        name: "Ctrl+G leaves the search",
        pass: (await look()).search === null,
      });

      // Ctrl+L and Ctrl+C

      await reset();
      await type("x = 1");
      await press("Enter");
      const before = (await look()).lines;
      await press("Control+l");
      const after = (await look()).lines;
      checks.push({
        name: "Ctrl+L clears the transcript",
        pass: before > 0 && after === 0,
        detail: JSON.stringify({ before, after }),
      });

      await type("half typed statement");
      await press("Control+c");
      const cleared = await look();
      checks.push({
        name: "Ctrl+C clears the half-typed statement and submits nothing",
        pass: cleared.command.trim() === "" && !cleared.pushes.includes("half typed statement"),
        detail: JSON.stringify({ command: cleared.command, pushes: cleared.pushes }),
      });

      return checks;
    } finally {
      await server.close();
    }
  },
  { browserName },
);

process.exit(report(`console keyboard, real keystrokes (${browserName})`, result));
