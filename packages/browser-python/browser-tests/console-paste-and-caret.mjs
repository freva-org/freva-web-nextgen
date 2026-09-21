// Two things a person does that no other suite did: paste, and look at the cursor. Both shipped
// broken, and both were "covered" by tests that could not have caught them.
//
// PASTE. A suite that calls `controller.execute()` exercises the programmatic API, which has
// always split its input into lines; nothing put text on the clipboard and pressed Ctrl+V.
// Through the terminal a paste arrives as ONE string with its newlines intact, so it reaches
// `submit()` as a single interactive statement, and `PyodideConsole` compiles in `single` mode:
// two statements answer "SyntaxError: multiple statements found while compiling a single
// statement".
//
// THE CARET. Typing worked, so the console looked fine to a test, but nothing painted the cursor:
// the package deliberately does not load the vendor stylesheet and copies the rules it needs by
// hand, and `.cmd-cursor` had no paint, no inversion and no `terminal-blink` keyframes. "Typing
// works" is not "the cursor is visible", and this file asserts the second thing.
//
// There are two deliberately separate layers. Every engine receives a ClipboardEvent carrying a
// real DataTransfer at the terminal's actual input, which exercises this component's paste-event
// path without depending on an automation runner's OS clipboard. Chromium additionally exercises
// the browser clipboard end to end; Playwright cannot grant that permission in Firefox or WebKit,
// so the cross-engine assertion must not pretend a keyboard shortcut populated their clipboard.
import { consolePage } from "./console-fixture.mjs";
import { bundleConsole, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();
bundleConsole();

const browserName = process.env.BROWSER_ENGINE ?? "chromium";

/** The node the vendor sheet actually inverts and animates - two levels inside `.cmd-cursor`. */
const CARET = ".cmd-cursor > span[data-text] span";

const result = await inBrowser(
  async (page) => {
    const server = await serve(consolePage());
    const checks = [];
    try {
      if (browserName === "chromium") {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: server.url,
        });
      }
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(server.url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      await page.evaluate(() => window.__el.start());
      await page.waitForFunction(() => window.__c.mock.state === "ready", null, { timeout: 15000 });

      const focusByPointer = async () => {
        const at = await page.evaluate(() => {
          const r = window.__el.shadowRoot.querySelector(".bp-transcript").getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        await page.mouse.click(at.x, at.y);
        await page.waitForTimeout(200);
      };

      /** Dispatch the browser event the component owns, at the real terminal input. */
      const dispatchPaste = async (source) => {
        await focusByPointer();
        return page.evaluate((text) => {
          const root = window.__el.shadowRoot;
          const target = root.querySelector(".cmd-clipboard, .cmd-editable");
          if (!(target instanceof HTMLElement)) throw new Error("terminal paste target not found");
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", text);
          let event = new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            composed: true,
            clipboardData,
          });
          let injectedClipboardData = false;
          // Firefox may construct the synthetic ClipboardEvent while discarding the supplied
          // DataTransfer. That says nothing about a real user paste, but it made this component
          // test wait 30 seconds for text the event did not carry. Give the synthetic event the
          // same readable clipboardData contract explicitly; Chromium's separate trusted-paste
          // check below still covers the real OS/browser integration.
          if (event.clipboardData?.getData("text/plain") !== text) {
            event = new Event("paste", {
              bubbles: true,
              cancelable: true,
              composed: true,
            });
            Object.defineProperty(event, "clipboardData", {
              configurable: false,
              enumerable: true,
              value: clipboardData,
            });
            injectedClipboardData = true;
          }
          const dispatchReturned = target.dispatchEvent(event);
          return {
            clipboardText: event.clipboardData?.getData("text/plain") ?? "",
            defaultPrevented: event.defaultPrevented,
            dispatchReturned,
            injectedClipboardData,
          };
        }, source);
      };

      // The component-level path, in Chromium, Firefox and WebKit.
      const source = "import numpy as np\nnp.arange(5)";
      const pasteEvent = await dispatchPaste(source);
      if (
        pasteEvent.clipboardText !== source ||
        !pasteEvent.defaultPrevented ||
        pasteEvent.dispatchReturned
      ) {
        checks.push({
          name: "the synthetic paste reached the component with readable text",
          pass: false,
          detail: JSON.stringify(pasteEvent),
        });
        return checks;
      }
      await page.waitForFunction((text) => window.__c.mock.pushes.includes(text), source, {
        timeout: 5000,
      });
      const pasted = await page.evaluate(() => [...window.__c.mock.pushes]);
      // ONE source string, newlines intact. The surface library submits a paste a line at a
      // time, as though each line had been typed and entered - that is the REPL protocol, and it
      // applies the REPL's rule that a blank line ends the current suite, so a valid program with
      // a blank line inside a `for` body arrives as a closed loop plus an orphaned indented
      // statement, or never completes at all. The block is taken whole in the capture phase and
      // run in file mode, so what the interpreter receives is what was on the clipboard.
      const submitted = pasted.filter((entry) => entry !== "");
      checks.push({
        name: "a multi-line paste reaches the interpreter as ONE source, newlines intact",
        pass: JSON.stringify(submitted) === JSON.stringify(["import numpy as np\nnp.arange(5)"]),
        detail: JSON.stringify(pasted),
      });
      checks.push({
        name: "…in exactly one submission, not one per line",
        pass: submitted.length === 1,
        detail: JSON.stringify(pasted),
      });
      checks.push({
        name: "the console owns and cancels the multi-line paste before the vendor can split it",
        pass:
          pasteEvent.clipboardText === source &&
          pasteEvent.defaultPrevented &&
          pasteEvent.dispatchReturned === false,
        detail: JSON.stringify(pasteEvent),
      });

      // Blank lines close blocks in Python; a paste that drops them changes the program.
      await page.evaluate(() => {
        window.__c.mock.pushes.length = 0;
      });
      const blockSource = "def f():\n    return 1\n\nf()";
      await dispatchPaste(blockSource);
      await page.waitForFunction((text) => window.__c.mock.pushes.includes(text), blockSource, {
        timeout: 5000,
      });
      const block = await page.evaluate(() => [...window.__c.mock.pushes]);
      checks.push({
        name: "the blank line inside the block survives the paste, byte for byte",
        pass:
          JSON.stringify(block.filter((entry) => entry !== "")) === JSON.stringify([blockSource]),
        detail: JSON.stringify(block),
      });

      // Browser/OS clipboard integration is a separate Chromium check. Unlike the synthetic
      // event above, this proves Playwright's trusted paste shortcut reaches the same input path.
      if (browserName === "chromium") {
        await page.evaluate(() => {
          window.__c.mock.pushes.length = 0;
        });
        const realClipboardSource = "values = [1, 2]\nsum(values)";
        await page.evaluate((text) => navigator.clipboard.writeText(text), realClipboardSource);
        await focusByPointer();
        await page.keyboard.press("ControlOrMeta+V");
        await page.waitForFunction(
          (text) => window.__c.mock.pushes.includes(text),
          realClipboardSource,
        );
        const realClipboardPushes = await page.evaluate(() => [...window.__c.mock.pushes]);
        checks.push({
          name: "Chromium's real clipboard and trusted paste shortcut reach the console",
          pass:
            JSON.stringify(realClipboardPushes.filter((entry) => entry !== "")) ===
            JSON.stringify([realClipboardSource]),
          detail: JSON.stringify(realClipboardPushes),
        });
      }

      // the caret
      await focusByPointer();
      const caret = await page.evaluate((sel) => {
        const el = window.__el.shadowRoot.querySelector(sel);
        if (!el) return { missing: true };
        const cs = getComputedStyle(el);
        return {
          animationName: cs.animationName,
          background: cs.backgroundColor,
          color: cs.color,
          width: el.getBoundingClientRect().width,
        };
      }, CARET);
      checks.push({
        name: "the caret is painted: it has a background, not just a transparent box",
        pass:
          !caret.missing &&
          caret.background !== "rgba(0, 0, 0, 0)" &&
          caret.background !== "transparent",
        detail: JSON.stringify(caret),
      });
      // Against the token the console ACTUALLY resolved, not against a hex constant: asserting
      // one of two remembered colours tests the palette, goes red the first time anyone retunes
      // the theme, and stays green if the caret is painted the right colour for the wrong reason.
      const themed = await page.evaluate((sel) => {
        const el = window.__el.shadowRoot.querySelector(sel);
        const token = getComputedStyle(el).getPropertyValue("--bp-console-foreground").trim();
        // Resolve the token through the browser so "#d8d8d2" and "rgb(216, 216, 210)" compare.
        const probe = document.createElement("span");
        probe.style.color = token;
        document.body.append(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return { background: getComputedStyle(el).backgroundColor, token, resolved };
      }, CARET);
      checks.push({
        name: "…in the console's own --bp-console-foreground, not the vendor's hard-coded grey",
        pass: themed.background === themed.resolved,
        detail: JSON.stringify(themed),
      });

      // That it BLINKS, not that an animation is named. `animationName === "terminal-blink"`
      // passes throughout a period where the caret does not blink at all: the package paints the
      // same element with `background-color: … !important`, and an `!important` author
      // declaration outranks a CSS animation, so the animation is attached, running and unable to
      // change a pixel. Sampling the painted colour across a full cycle is the only version of
      // this check that can fail for the right reason.
      const paints = new Set();
      for (let i = 0; i < 8; i += 1) {
        paints.add(
          await page.evaluate(
            (sel) => getComputedStyle(window.__el.shadowRoot.querySelector(sel)).backgroundColor,
            CARET,
          ),
        );
        await page.waitForTimeout(160);
      }
      checks.push({
        name: "…and it actually blinks: the painted colour changes across a cycle",
        pass: caret.animationName === "terminal-blink" && paints.size >= 2,
        detail: JSON.stringify({ animationName: caret.animationName, paints: [...paints] }),
      });

      // and is still visible with motion turned down
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForTimeout(150);
      const reduced = await page.evaluate((sel) => {
        const el = window.__el.shadowRoot.querySelector(sel);
        const cs = getComputedStyle(el);
        return { animationName: cs.animationName, background: cs.backgroundColor };
      }, CARET);
      checks.push({
        name: "reduced motion stops the blinking but keeps a visible caret",
        pass:
          reduced.animationName === "none" &&
          reduced.background !== "rgba(0, 0, 0, 0)" &&
          reduced.background !== "transparent",
        detail: JSON.stringify(reduced),
      });

      return checks;
    } finally {
      await server.close();
    }
  },
  { browserName },
);

process.exit(report(`paste and the caret (${browserName})`, result));
