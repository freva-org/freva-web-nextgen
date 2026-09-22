/**
 * The console, driven with a REAL POINTER. Nothing here is allowed to hand it focus.
 *
 * `console.mjs` drives the element's API and `console-keyboard.mjs` opens every check with
 * `window.__c.focusInput()`, so clicking on the console is performed by no other suite - and it did
 * not work: the surface library focuses itself through delegated handlers bound at the document,
 * and a shadow root retargets every event crossing its boundary to the host, so those selectors
 * never matched. Hence the rule here: NO `focusInput()`, no `element.focus()`, no `.click()` on a
 * node, only `page.mouse` at real coordinates.
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

    /** The command line's text, with the surface's no-break spaces normalised. */
    const command = () =>
      page.evaluate(
        () =>
          window.__el.shadowRoot
            .querySelector(".cmd-cursor-line")
            ?.textContent?.replace(/\u00a0/g, " ") ?? "",
      );
    const pushes = () => page.evaluate(() => [...window.__c.mock.pushes]);

    /** A point inside the transcript, as a fraction of its box. No element lookup, no click(). */
    const pointIn = async (fx, fy) => {
      const box = await page.evaluate(() => {
        const r = window.__el.shadowRoot.querySelector(".bp-transcript").getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      return [box.x + box.w * fx, box.y + box.h * fy];
    };

    /** Click where a person clicks, then type. The whole point of the suite. */
    const clickAndType = async (fx, fy, text) => {
      const [x, y] = await pointIn(fx, fy);
      await page.mouse.click(x, y);
      await page.waitForTimeout(120);
      await page.keyboard.type(text, { delay: 2 });
      await page.waitForTimeout(90);
    };
    const clearLine = async () => {
      for (let i = 0; i < 30; i++) await page.keyboard.press("Backspace");
      await page.waitForTimeout(60);
    };

    try {
      await page.goto(server.url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      await page.evaluate(() => window.__el.start());
      await page.waitForFunction(() => window.__c.mock.state === "ready", null, { timeout: 15000 });
      // Focus somewhere neutral first, so nothing inherits focus from startup.
      await page.mouse.click(2, 2);
      await page.waitForTimeout(80);

      // the four places people click
      const spots = [
        ["the middle of the transcript", 0.5, 0.5],
        ["the command line at the bottom", 0.3, 0.96],
        ["empty space below the last line", 0.8, 0.75],
        ["the banner text at the top", 0.25, 0.06],
      ];
      for (const [where, fx, fy] of spots) {
        await clearLine();
        await page.mouse.click(2, 2); // drop focus between checks - each click must earn it
        await page.waitForTimeout(80);
        await clickAndType(fx, fy, "marker");
        const line = await command();
        checks.push({
          name: `clicking ${where} lets you type`,
          pass: line.includes("marker"),
          detail: JSON.stringify({ command: line }),
        });
      }

      // and Enter still submits
      await clearLine();
      await page.evaluate(() => {
        window.__c.mock.pushes.length = 0;
      });
      await clickAndType(0.5, 0.5, "value = 40");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
      checks.push({
        name: "a statement typed after a click reaches the engine on Enter",
        pass: (await pushes()).includes("value = 40"),
        detail: JSON.stringify(await pushes()),
      });

      // selection must survive the fix
      await clearLine();
      // Anchored to a real line of output, not to a fraction of the box. A fraction is a guess
      // about where text happens to be, and it breaks the moment the transcript gains padding -
      // reporting "selection is broken" when selection is fine and the drag was over blank space.
      const line = await page.evaluate(() => {
        const el = window.__el.shadowRoot.querySelector(".bp-line-body");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y + r.height / 2,
          right: r.x + r.width,
          text: el.textContent ?? "",
        };
      });
      if (!line) throw new Error("no output line to select");
      await page.mouse.click(2, 2);
      await page.evaluate(() => {
        window.__selectionProbe = { selectStarts: 0, mouseupsPastConsole: 0 };
        const root = window.__el.shadowRoot;
        root.addEventListener(
          "selectstart",
          () => {
            window.__selectionProbe.selectStarts += 1;
          },
          true,
        );
        // The vendor's selection-collapsing mouseup handler is above the shadow root. If the
        // console correctly contains a drag release, it cannot reach this ordinary bubble
        // listener either. documentElement is intentionally below the vendor's document handler.
        document.documentElement.addEventListener("mouseup", () => {
          window.__selectionProbe.mouseupsPastConsole += 1;
        });
      });
      const [sx, sy] = [line.x + 4, line.y];
      const [ex, ey] = [Math.max(line.right - 4, line.x + 40), line.y];
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(ex, ey, { steps: 12 });
      const readSelection = () =>
        page.evaluate(() => {
          const root = window.__el.shadowRoot;
          return {
            shadow: root.getSelection?.()?.toString() ?? "",
            document: document.getSelection()?.toString() ?? "",
          };
        });
      const duringDrag = await readSelection();
      await page.mouse.up();
      await page.waitForTimeout(150);
      const afterMouseup = await readSelection();
      const probe = await page.evaluate(() => ({ ...window.__selectionProbe }));
      const selectedDuring = duringDrag.shadow || duringDrag.document;
      const selectedAfter = afterMouseup.shadow || afterMouseup.document;
      checks.push({
        name: "dragging across transcript text starts a native selection gesture",
        pass: probe.selectStarts > 0 || selectedDuring.trim().length > 0,
        detail: JSON.stringify({
          selectStarts: probe.selectStarts,
          duringShadow: duringDrag.shadow.slice(0, 40),
          duringDocument: duringDrag.document.slice(0, 40),
        }),
      });
      checks.push({
        name: "the drag release cannot reach the terminal handler that collapses the selection",
        pass: probe.mouseupsPastConsole === 0,
        detail: JSON.stringify({
          mouseupsPastConsole: probe.mouseupsPastConsole,
          afterShadow: afterMouseup.shadow.slice(0, 40),
          afterDocument: afterMouseup.document.slice(0, 40),
          selectedAfter: selectedAfter.slice(0, 40),
        }),
      });

      // and typing works again after
      await page.mouse.click(2, 2);
      await page.waitForTimeout(80);
      await clearLine();
      await clickAndType(0.5, 0.5, "after_selection");
      checks.push({
        name: "clicking after a selection returns focus to the command line",
        pass: (await command()).includes("after_selection"),
        detail: JSON.stringify({ command: await command() }),
      });

      // toolbar, then back to typing
      await clearLine();
      const clearButton = await page.evaluate(() => {
        const r = window.__el.shadowRoot
          .querySelector('[part="clear-button"]')
          .getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      });
      await page.mouse.click(clearButton[0], clearButton[1]);
      await page.waitForTimeout(120);
      await clickAndType(0.5, 0.5, "after_toolbar");
      checks.push({
        name: "typing works after using a toolbar button",
        pass: (await command()).includes("after_toolbar"),
        detail: JSON.stringify({ command: await command() }),
      });

      // The mouse WHEEL: a real wheel, at real coordinates. The console could not be scrolled with
      // a mouse at all - the surface library binds its own wheel handler and `preventDefault()`s it
      // to scroll `.terminal-scroller`, which inside this host is sized to its own content and can
      // never scroll. Measured with 120 lines of output: scrollHeight 2741 against clientHeight
      // 450, `scrollTop` still 0 after a 400px wheel, `defaultPrevented: true`.
      await page.evaluate(() => {
        for (let i = 0; i < 120; i += 1) {
          window.__c.mock.emit({ type: "stdout", text: `line ${i}\n`, executionId: `e${i}` });
        }
      });
      await page.waitForTimeout(400);

      const scrollState = () =>
        page.evaluate(() => {
          const el = window.__el.shadowRoot.querySelector(".bp-transcript");
          return {
            top: Math.round(el.scrollTop),
            overflow: el.scrollHeight - el.clientHeight,
          };
        });

      // WHEELED UP FIRST. Wheeling DOWN from wherever 120 lines of output left the transcript
      // cannot move it - the console follows the latest output, so it is already at the bottom, and
      // the two numbers were identical at 2228. Starting from a position that can move both ways
      // makes both assertions capable of failing.
      const [wx, wy] = await pointIn(0.5, 0.5);
      await page.mouse.move(wx, wy);
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(250);
      const before = await scrollState();
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(250);
      const down = await scrollState();
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(250);
      const up = await scrollState();

      checks.push({
        name: "there is something to scroll, and wheeling up moved off the bottom",
        pass: before.overflow > 100 && before.top < before.overflow,
        detail: JSON.stringify(before),
      });
      checks.push({
        name: "the mouse wheel scrolls the transcript down",
        pass: down.top > before.top,
        detail: JSON.stringify({ before: before.top, afterWheelDown: down.top }),
      });
      checks.push({
        name: "…and back up again",
        pass: up.top < down.top,
        detail: JSON.stringify({ afterWheelDown: down.top, afterWheelUp: up.top }),
      });

      // A TRY PRESS GOES TO THE END; BACKGROUND OUTPUT DOES NOT. Two halves of one rule, checked
      // together because a change to either could silently invert the other. Background output must
      // leave a parked reader where they are; a `Try in Python` press is a deliberate gesture whose
      // purpose is to watch something run.
      await page.evaluate(() => {
        const el = window.__el.shadowRoot.querySelector(".bp-transcript");
        el.scrollTop = 0;
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        window.__c.mock.emit({ type: "stdout", text: "background line\n", executionId: "bg" });
      });
      await page.waitForTimeout(350);
      const afterBackground = await scrollState();
      checks.push({
        name: "background output leaves a reader who has scrolled up where they are",
        pass: afterBackground.top < 200,
        detail: JSON.stringify(afterBackground),
      });

      await page.evaluate(() =>
        window.__el.runExample({ title: "Try me", source: "a = 1\nb = 2\n" }),
      );
      await page.waitForTimeout(500);
      const afterTry = await scrollState();
      checks.push({
        name: "…but a Try press takes them to the end, where the output is about to appear",
        pass: afterTry.top > afterBackground.top + 100,
        detail: JSON.stringify({ parked: afterBackground.top, afterTry: afterTry.top }),
      });

      return checks;
    } finally {
      await server.close();
    }
  },
  { browserName },
);

process.exit(report(`console pointer, real mouse (${browserName})`, result));
