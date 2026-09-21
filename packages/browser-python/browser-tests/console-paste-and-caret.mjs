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
// Playwright can grant a real clipboard only in Chromium, so paste runs there while the caret runs
// in every configured engine. Each report names which scope it actually covered.
import { consolePage } from "./console-fixture.mjs";
import { bundleConsole, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();
bundleConsole();

const browserName = process.env.BROWSER_ENGINE ?? "chromium";

/** The node the vendor sheet actually inverts and animates - two levels inside `.cmd-cursor`. */
const CARET = ".cmd-cursor > span[data-text] span";

let pasteCovered = false;

const result = await inBrowser(
  async (page) => {
    const server = await serve(consolePage());
    const checks = [];
    try {
      // A REAL clipboard, or no paste checks. Playwright currently grants clipboard permissions
      // only in Chromium, where the default run proves the paste path. Firefox and WebKit still
      // exercise the independent caret checks below; omitting paste there is explicit rather than
      // silently comparing an empty prompt against another empty prompt.
      let clipboardAvailable = false;
      try {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: server.url,
        });
        clipboardAvailable = true;
        pasteCovered = true;
      } catch (error) {
        const detail = String(error?.message ?? error).split("\n")[0];
        // The two non-Chromium engines reject these permissions by design. Any other error - and
        // any loss of Chromium's real clipboard - remains a gate failure rather than a hidden skip.
        if (
          browserName === "chromium" ||
          !/Unknown permission: clipboard-(read|write)/.test(detail)
        ) {
          checks.push({
            name: "the browser grants the real clipboard needed by the paste checks",
            pass: false,
            detail,
          });
        }
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

      if (clipboardAvailable) {
        // paste
        const source = "import numpy as np\nnp.arange(5)";
        await page.evaluate((s) => navigator.clipboard.writeText(s), source);
        await focusByPointer();
        await page.keyboard.press("Control+V");
        await page.waitForTimeout(300);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(400);
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

        // Blank lines close blocks in Python; a paste that drops them changes the program.
        await page.evaluate(() => {
          window.__c.mock.pushes.length = 0;
        });
        await page.evaluate(
          (s) => navigator.clipboard.writeText(s),
          "def f():\n    return 1\n\nf()",
        );
        await focusByPointer();
        await page.keyboard.press("Control+V");
        await page.waitForTimeout(300);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(500);
        const block = await page.evaluate(() => [...window.__c.mock.pushes]);
        checks.push({
          name: "the blank line inside the block survives the paste, byte for byte",
          pass:
            JSON.stringify(block.filter((entry) => entry !== "")) ===
            JSON.stringify(["def f():\n    return 1\n\nf()"]),
          detail: JSON.stringify(block),
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

const title = pasteCovered
  ? `paste and the caret (${browserName})`
  : `the caret (${browserName}; Playwright clipboard unavailable)`;
process.exit(report(title, result));
