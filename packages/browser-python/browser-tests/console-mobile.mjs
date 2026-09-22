/**
 * The console on a phone, where the on-screen keyboard is the only keyboard.
 *
 * A separate suite rather than a smaller viewport, because it asserts different things. On a
 * touch device jQuery Terminal takes its `cmd-mobile` path: no clipboard textarea, focus from a
 * tap, and the physical keys carrying half of this console's affordances - Tab, Ctrl+R, the
 * arrows - simply absent. What matters is that tap, type, Enter, see the answer still works,
 * and that the console does not overflow a 390px screen into a sideways scroll.
 */
import { consolePage } from "./console-fixture.mjs";
import { bundleConsole, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();
bundleConsole();

const browserName = process.env.BROWSER_ENGINE ?? "chromium";

/** An iPhone-ish viewport with touch and a coarse pointer. */
const MOBILE = {
  viewport: { width: 390, height: 844 },
  mobile: {
    hasTouch: true,
    isMobile: browserName === "firefox" ? undefined : true,
    deviceScaleFactor: 3,
  },
};

const result = await inBrowser(
  async (page) => {
    const server = await serve(consolePage());
    const checks = [];
    try {
      await page.goto(server.url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      await page.evaluate(() => window.__el.start());
      await page.waitForFunction(() => window.__mock.state === "ready", null, { timeout: 20000 });

      // ------ layout

      // The element must not be wider than the viewport. `documentElement.scrollWidth` is the
      // honest measure: it catches a child overflowing its parent, which `offsetWidth` does not.
      const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        view: window.innerWidth,
        element: window.__el.getBoundingClientRect().width,
      }));
      checks.push({
        name: "the page does not scroll sideways on a 390px screen",
        pass: overflow.doc <= overflow.view + 1,
        detail: JSON.stringify(overflow),
      });

      // A long unbroken line is the usual cause. Python produces them constantly - a traceback
      // path, a repr of an array - so the transcript has to wrap rather than widen.

      // `{ type: "stdout" }`, which is what the engine actually emits. A shape the package never
      // produces is ignored by the controller, no line is rendered, and a width check then
      // compares a page with nothing new on it against the viewport - which passes whatever the
      // CSS does. So the render is asserted before the width is.
      await page.evaluate(() =>
        window.__mock.emit({
          type: "stdout",
          executionId: "e0",
          text: "x".repeat(400),
        }),
      );
      await page.waitForTimeout(80);
      const afterLongLine = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        view: window.innerWidth,
        rendered: (
          window.__el.shadowRoot.querySelector(".bp-transcript")?.textContent ?? ""
        ).includes("x".repeat(400)),
      }));
      checks.push({
        name: "the long line actually reached the transcript",
        pass: afterLongLine.rendered === true,
        detail: JSON.stringify(afterLongLine),
      });
      checks.push({
        name: "a 400-character output line wraps instead of widening the page",
        pass: afterLongLine.rendered === true && afterLongLine.doc <= afterLongLine.view + 1,
        detail: JSON.stringify(afterLongLine),
      });

      // ------ touch

      // On a touch device jQuery Terminal lays a full-size `contenteditable` over the terminal
      // instead of the off-screen clipboard textarea, and THAT is the element a tap must land on
      // for the software keyboard to come up. This package restates the library's positioning in
      // its own stylesheet, the library's CSS deliberately not being loaded into the shadow
      // root, so a rule that shrank it - as a generic visually-hidden helper would - is the bug
      // this checks for.
      const overlay = await page.evaluate(() => {
        const root = window.__el.shadowRoot;
        const editable = root.querySelector(".cmd-editable");
        if (!editable) return { present: false };
        const box = editable.getBoundingClientRect();
        const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const style = getComputedStyle(editable);
        return {
          present: true,
          mobilePath: Boolean(root.querySelector(".cmd-mobile")),
          width: Math.round(box.width),
          height: Math.round(box.height),
          pointerEvents: style.pointerEvents,
          // What the browser would actually hand a tap at that point.
          hit: root.elementFromPoint(centre.x, centre.y)?.className ?? null,
          centre,
        };
      });
      checks.push({
        name: "the touch input overlay is full size and is what a tap in the middle would hit",
        pass:
          overlay.present &&
          overlay.mobilePath &&
          overlay.width > 100 &&
          overlay.height > 40 &&
          overlay.pointerEvents !== "none" &&
          String(overlay.hit).includes("cmd-editable"),
        detail: JSON.stringify(overlay),
      });

      // Activation focuses it. A synthetic touch tap is deliberately NOT the assertion:
      // Chromium's emulated touch events do not drive the gesture pipeline that focuses a
      // contenteditable, so a tap-based check would fail on a console that works on a real
      // phone. What is verifiable here is that the overlay is hittable at the tap point (above)
      // and takes focus when activated (here).
      await page.mouse.click(overlay.centre.x, overlay.centre.y);
      await page.waitForTimeout(50);
      const focused = await page.evaluate(() => ({
        insideConsole: document.activeElement === window.__el,
        inner: window.__el.shadowRoot?.activeElement?.className ?? null,
      }));
      checks.push({
        name: "activating it moves focus into the console, which is what raises the keyboard",
        pass: focused.insideConsole && String(focused.inner).includes("cmd-editable"),
        detail: JSON.stringify(focused),
      });

      // ------ the loop

      // Typing and Enter, with no modifier keys involved anywhere. This is the whole interaction a
      // phone actually has, so it is the one that must not depend on anything else.
      await page.keyboard.type("value = 21 * 2");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(120);
      const pushed = await page.evaluate(() => window.__mock.pushes);
      checks.push({
        name: "typing and Enter reach the engine with no modifier keys involved",
        pass: pushed.includes("value = 21 * 2"),
        detail: JSON.stringify(pushed),
      });

      await page.evaluate(() =>
        window.__mock.emit({ type: "result", executionId: "e0", text: "42" }),
      );
      await page.waitForTimeout(80);
      checks.push({
        name: "the result is visible in the transcript",
        pass: (await page.evaluate(() => window.__c.text())).includes("42"),
      });

      // ------ toolbar

      // 24px is the WCAG 2.5.8 (AA) target-size minimum. The toolbar is the only pointer-driven
      // control this console has, and on a phone it is the ONLY way to restart - Ctrl+anything
      // does not exist here.
      const targets = await page.evaluate(() =>
        window.__c.qa(".bp-toolbar button").map((b) => {
          const r = b.getBoundingClientRect();
          return { label: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
        }),
      );
      checks.push({
        name: "every toolbar button meets the 24px minimum touch target",
        pass: targets.length > 0 && targets.every((t) => t.w >= 24 && t.h >= 24),
        detail: JSON.stringify(targets),
      });

      // Restart from a tap alone, because that is the only interrupt a phone has.
      await page.locator("#c").evaluate((el) => {
        el.shadowRoot.querySelector('[part="restart-button"]').click();
      });
      await page.waitForTimeout(150);
      checks.push({
        name: "Stop and restart works from a tap, the only interrupt a phone has",
        pass: (await page.evaluate(() => window.__mock.restarts)) === 1,
      });

      return checks;
    } finally {
      await server.close();
    }
  },
  { browserName, ...MOBILE },
);

process.exit(report(`console on a mobile viewport (${browserName})`, result));
