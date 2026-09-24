/**
 * Startup, failure and retry, on the real custom element. What an embedding portal depends on: a
 * host autostarts the console and calls `execute()` in the same breath, and if the runtime
 * download fails it wants to catch the error and offer a retry that actually retries. So a block
 * executed during startup must keep every line - an example that imports a module and then uses
 * it must not run the use without the import - and a failed `start()` must reject, leave the
 * console unstarted, and print the failure once.
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
    try {
      await page.goto(server.url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

      // a block submitted while Python is still loading
      const duringStartup = await page.evaluate(async () => {
        // Deliberately NOT awaited before execute: this is the autostart arrangement, where the
        // host starts the console and immediately feeds it a program.
        const starting = window.__el.start();
        await window.__el.execute("import numpy as np\nnp.arange(5)");
        await starting;
        return [...window.__c.mock.pushes];
      });
      // One submission, whole. Expecting the two lines separately is the shape that loses a
      // blank line inside an indented suite. What matters: the program submitted during startup
      // arrives complete, in order, with the import still in front of its use.
      checks.push({
        name: "a block submitted during startup reaches the interpreter whole, in order",
        pass:
          JSON.stringify(duringStartup) === JSON.stringify(["import numpy as np\nnp.arange(5)"]),
        detail: JSON.stringify(duringStartup),
      });

      const echoed = await page.evaluate(() =>
        window.__c
          .lines()
          .filter((l) => l.kind === "command")
          .map((l) => l.text),
      );
      checks.push({
        name: "each queued line is echoed once, not twice",
        pass: echoed.length === 2,
        detail: JSON.stringify(echoed),
      });

      // a start that fails
      await page.goto(server.url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      const failure = await page.evaluate(async () => {
        let calls = 0;
        window.__c.mock.start = async () => {
          calls += 1;
          throw new Error("runtime download failed");
        };
        let rejected = false;
        try {
          await window.__el.start();
        } catch {
          rejected = true;
        }
        // A retry has to actually reach the engine again.
        let retried = false;
        try {
          await window.__el.start();
        } catch {
          retried = true;
        }
        return {
          rejected,
          retried,
          engineStartCalls: calls,
          fatalLines: window.__c.lines().filter((l) => /runtime download failed/.test(l.text))
            .length,
        };
      });
      checks.push({
        name: "a failed start() rejects instead of resolving as though it worked",
        pass: failure.rejected === true,
        detail: JSON.stringify(failure),
      });
      checks.push({
        name: "start() can be retried after a failure, and reaches the engine again",
        pass: failure.retried === true && failure.engineStartCalls === 2,
        detail: JSON.stringify(failure),
      });
      checks.push({
        name: "the failure is reported once per attempt, not twice",
        pass: failure.fatalLines <= failure.engineStartCalls,
        detail: JSON.stringify(failure),
      });

      // a failure detail that is not one line long
      //
      // The engine's status detail is whatever it failed with, and for a failed start that is a
      // Python traceback. Verbatim in the toolbar's status span it measured 13 lines and 87px,
      // growing the toolbar from 40px to 134px and wrapping around its own buttons.
      const multiline = await page.evaluate(() => {
        const toolbar = window.__el.shadowRoot.querySelector(".bp-toolbar");
        const healthy = Math.round(toolbar.getBoundingClientRect().height);
        window.__c.mock._emitStatus(
          "error",
          'Traceback (most recent call last):\n  File "/freva/_freva_bridge.py", line 193, in ' +
            "install_browser_http\n    browser_http.install()\n    ~~~~~~~~~~~~~~~~~~~~^^\n" +
            '  File "/freva/browser_http.py", line 270, in install\n    import fsspec\n' +
            "ModuleNotFoundError: No module named 'fsspec'\nThe module 'fsspec' is included in " +
            "the Pyodide distribution, but it is not installed.\nYou can install it by calling:\n" +
            '  await micropip.install("fsspec") in Python',
        );
        const status = window.__el.shadowRoot.querySelector(".bp-status");
        return {
          healthy,
          failed: Math.round(toolbar.getBoundingClientRect().height),
          statusLines: (status?.textContent ?? "").split("\n").length,
          statusText: status?.textContent ?? "",
          // The full text stays reachable; only the LINE is short.
          hasFullTextOnTitle: (status?.getAttribute("title") ?? "").includes("micropip"),
        };
      });

      checks.push({
        name: "a multi-line failure detail does not grow the toolbar",
        pass: multiline.healthy > 0 && multiline.failed === multiline.healthy,
        detail: JSON.stringify({ healthy: multiline.healthy, failed: multiline.failed }),
      });
      checks.push({
        name: "…the status line stays one line, ending in the exception rather than the header",
        pass:
          multiline.statusLines === 1 &&
          multiline.statusText.includes("ModuleNotFoundError") &&
          !multiline.statusText.includes("Traceback (most recent call last)"),
        detail: JSON.stringify(multiline.statusText.slice(0, 160)),
      });
      checks.push({
        name: "…and the whole detail is still there, on the title",
        pass: multiline.hasFullTextOnTitle,
        detail: JSON.stringify(multiline.hasFullTextOnTitle),
      });

      // A fresh page for what follows. The section above deliberately leaves the mock's `start`
      // throwing, and the checks below are about a console that STARTED - a toolbar with a live
      // status line, a session with a transcript in it.
      await page.goto(server.url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      await page.evaluate(() => window.__el.start());

      // the toolbar a host has replaced
      //
      // A console inside somebody else's window chrome arrives with three buttons that chrome
      // likely already offers, and hiding the whole strip takes the status line with it - the one
      // place "Loading Python…" and a failed start are ever said.
      const toolbarModes = await page.evaluate(() => {
        const root = window.__el.shadowRoot;
        const read = () => {
          const bar = root.querySelector(".bp-toolbar");
          const actions = [...bar.querySelectorAll("button")];
          return {
            barHidden: bar.hidden,
            barHeight: Math.round(bar.getBoundingClientRect().height),
            statusVisible: Boolean(
              root.querySelector(".bp-status")?.getBoundingClientRect().height,
            ),
            actionsShown: actions.filter((b) => b.getBoundingClientRect().height > 0).length,
          };
        };
        const full = read();
        window.__el.toolbarMode = "status";
        const status = read();
        window.__el.toolbarMode = "none";
        const none = read();
        window.__el.toolbarMode = "full";
        return { full, status, none, back: read() };
      });
      checks.push({
        name: "the default toolbar shows the status line and all three actions",
        pass: toolbarModes.full.actionsShown === 3 && toolbarModes.full.statusVisible,
        detail: JSON.stringify(toolbarModes.full),
      });
      checks.push({
        name: 'toolbar="status" drops the duplicated actions and KEEPS the status line',
        pass:
          toolbarModes.status.actionsShown === 0 &&
          toolbarModes.status.statusVisible &&
          !toolbarModes.status.barHidden,
        detail: JSON.stringify(toolbarModes.status),
      });
      checks.push({
        name: 'toolbar="none" removes the strip entirely, and "full" brings it back',
        pass:
          toolbarModes.none.barHidden &&
          toolbarModes.none.barHeight === 0 &&
          toolbarModes.back.actionsShown === 3,
        detail: JSON.stringify({ none: toolbarModes.none, back: toolbarModes.back }),
      });

      // a registered example, run into a live session
      //
      // The promise a "Try in Python" button makes: appended to the session the visitor already
      // has, run ONCE as a file whatever its length, resetting nothing - not the namespace, not
      // the transcript, not the line they were halfway through typing.
      // Something half-typed at the prompt, typed the way a visitor would leave it there.
      await page.evaluate(() => window.__c.focusInput());
      await page.keyboard.type("total = sum(", { delay: 2 });

      const example = await page.evaluate(async () => {
        const root = window.__el.shadowRoot;
        // The surface paints every space as a NO-BREAK SPACE; normalised so the assertion reads.
        const command = () =>
          root.querySelector(".cmd-cursor-line")?.textContent?.replace(/\u00a0/g, " ") ?? "";
        const before = window.__c.mock.pushes.length;
        const commandBefore = command();
        const transcriptBefore = window.__el.transcript();
        await window.__el.runExample({
          title: "Open the store",
          source: 'import xarray as xr\n\nds = "s3://archive/tas.zarr"\nprint(ds)\n',
        });
        await window.__el.runExample({ title: "One line", source: "print(1 + 1)" });
        const transcript = window.__el.transcript();
        return {
          submitted: window.__c.mock.pushes.slice(before),
          commandBefore,
          command: command(),
          keptEarlierTranscript: transcript.startsWith(transcriptBefore),
          // The example's TITLE must not be in the transcript - see the check below.
          hasTitle: transcript.includes("Open the store"),
          hasRule: transcript.includes("\u2500\u2500"),
          hasSource: transcript.includes("import xarray as xr"),
          transcriptHasMarkup: /<[a-z]/i.test(transcript),
        };
      });
      checks.push({
        name: "an example is submitted whole, once, and a one-liner the same way",
        pass:
          JSON.stringify(example.submitted) ===
          JSON.stringify([
            'import xarray as xr\n\nds = "s3://archive/tas.zarr"\nprint(ds)\n',
            "print(1 + 1)",
          ]),
        detail: JSON.stringify(example.submitted),
      });
      checks.push({
        name: "the half-typed command at the prompt is untouched",
        pass:
          example.commandBefore.includes("total = sum(") &&
          example.command === example.commandBefore,
        detail: JSON.stringify({ before: example.commandBefore, after: example.command }),
      });
      // THE SOURCE IS APPENDED AND THE TITLE IS NOT, in a real browser. A transcript is
      // something visitors COPY, and a `── Open the store ──` title line is not Python: pasting a
      // worked example back and running it fails on a line the console wrote into their program.
      // The title is already on the page, beside the button that was pressed.
      checks.push({
        name: "the source is appended to the existing transcript, with no title and no rule",
        pass:
          example.keptEarlierTranscript &&
          example.hasSource &&
          !example.hasTitle &&
          !example.hasRule,
        detail: JSON.stringify(example),
      });
      checks.push({
        name: "the transcript reads back as plain text, with no markup in it",
        pass: example.transcriptHasMarkup === false,
        detail: JSON.stringify(example.transcriptHasMarkup),
      });

      return checks;
    } finally {
      await server.close();
    }
  },
  { browserName },
);

process.exit(report(`console lifecycle: startup, failure, retry (${browserName})`, result));
