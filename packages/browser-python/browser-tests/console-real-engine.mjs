// The console driven by the REAL interpreter. Everything else in the console suites uses a mock
// engine, which is right for behaviour about orderings and lifecycles; this is the one that
// proves the two halves fit - real keystrokes, a real `PyodideConsole`, real continuation
// semantics, and a real figure. Kept small on purpose: each check costs a Pyodide startup.
import {
  bundleConsole,
  inBrowser,
  isStrict,
  report,
  requireDist,
  runtimeHasPackages,
  serve,
} from "./harness.mjs";

requireDist();
bundleConsole();

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<freva-python-console id="c"></freva-python-console>
<script type="module">
  import { defineBrowserPythonConsole } from "/bundle/console.js";
  import { createBrowserPython } from "/dist/index.js";
  defineBrowserPythonConsole();
  const element = document.getElementById("c");
  // A real engine, served from the local runtime - see the harness header.
  element.engine = createBrowserPython({
    profile: "minimal",
    pyodide: { indexURL: new URL("/runtime/", location.href).href },
  });
  window.__c = {
    element,
    q: (s) => element.shadowRoot.querySelector(s),
    qa: (s) => [...element.shadowRoot.querySelectorAll(s)],
    text: () => element.shadowRoot.querySelector(".bp-transcript")?.textContent ?? "",
    focusInput: () => element.shadowRoot.querySelector(".terminal")?.click(),
  };
  window.__ready = true;
</script></body></html>`;

const result = await inBrowser(async (browser) => {
  const server = await serve(page);
  const checks = [];
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    await browser.evaluate(() => window.__c.element.start());
    await browser.waitForFunction(() => window.__c.element.engine.state === "ready", null, {
      timeout: 60000,
    });
    checks.push({ name: "the console starts a real interpreter", pass: true });

    /** Type a line and press Enter, exactly as a person does. */
    const type = async (line) => {
      await browser.evaluate(() => window.__c.focusInput());
      await browser.keyboard.type(line, { delay: 1 });
      await browser.keyboard.press("Enter");
      await browser.waitForTimeout(180);
    };

    await browser.evaluate(() => window.__c.element.clear());
    await type("1 + 1");
    checks.push({
      name: "1 + 1 shows 2 in the transcript",
      pass: (await browser.evaluate(() => window.__c.text())).includes("2"),
      detail: (await browser.evaluate(() => window.__c.text())).trim().slice(-40),
    });

    await browser.evaluate(() => window.__c.element.clear());
    await type("value = 40");
    await type("value + 2");
    checks.push({
      name: "state persists between commands (40 + 2 = 42)",
      pass: (await browser.evaluate(() => window.__c.text())).includes("42"),
    });

    // A real multi-line definition, with the continuation prompt coming from Python's own parser.
    await browser.evaluate(() => window.__c.element.clear());
    await type("def double(value):");
    const promptAfterDef = await browser.evaluate(
      () => window.__c.q(".cmd-prompt")?.textContent ?? "",
    );
    await type("    return value * 2");
    await type("");
    await type("double(21)");
    const transcript = await browser.evaluate(() => window.__c.text());
    checks.push({
      name: "a def shows `... ` and the function works afterwards",
      pass: promptAfterDef.includes("...") && transcript.includes("42"),
      detail: `prompt after def: ${JSON.stringify(promptAfterDef)}`,
    });

    // Real completion, from rlcompleter over the live namespace.
    const completion = await browser.evaluate(async () => {
      await window.__c.element.execute("import json");
      const result = await window.__c.element.engine.complete("json.dum", 8);
      return result.matches;
    });
    checks.push({
      name: "real Python completion reaches the console's engine",
      pass: completion.some((m) => m.startsWith("json.dum")),
      detail: JSON.stringify(completion.slice(0, 3)),
    });

    // THE WHOLE PATH, with real keystrokes: surface -> controller -> Worker -> rlcompleter. The
    // engine call above is one side of the boundary; this is the other - the caret offset the
    // controller reads off the surface, in UTF-16 code units, and the `start` it applies back to
    // the buffer. Five emoji put those five units apart from Python's character count, so a
    // missing conversion sends the request five units left of the caret, rlcompleter answers with
    // every global in the namespace, and applying that offset eats one of the emoji.
    await browser.evaluate(() => window.__c.element.clear());
    await browser.evaluate(() => window.__c.focusInput());
    await browser.keyboard.type('"\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}"; print', {
      delay: 1,
    });
    await browser.keyboard.press("Tab");
    await browser.waitForTimeout(1500);
    const completed = await browser.evaluate(() => {
      // Without the inline ghost, which is a suggestion nobody accepted and is not the buffer.
      const wrapper = window.__c.q(".cmd .cmd-wrapper") ?? window.__c.q(".cmd");
      const ghost = wrapper?.querySelector(".bp-ghost")?.textContent ?? "";
      const whole = wrapper?.textContent ?? "";
      const input = ghost ? whole.slice(0, whole.length - ghost.length) : whole;
      return {
        buffer: input,
        // The menu is the symptom made visible: a single match applies straight into the buffer
        // and opens nothing, while completing an empty token offers every global rlcompleter can
        // see - `False`, `None`, `abs`, dozens of them.
        menuCount: window.__c.qa(".bp-completion-item").length,
        menu: window.__c
          .qa(".bp-completion-item")
          .map((n) => n.textContent)
          .slice(0, 4),
        emoji: [...input].filter((c) => c === "\u{1F600}").length,
        lone: [...input].filter((c) => {
          const p = c.codePointAt(0);
          return p >= 0xd800 && p <= 0xdfff;
        }).length,
      };
    });
    checks.push({
      name: "Tab at the caret after five emoji completes `print(` and keeps all five",
      pass:
        completed.buffer.includes("print(") &&
        completed.emoji === 5 &&
        completed.lone === 0 &&
        completed.menuCount === 0,
      detail: JSON.stringify(completed),
    });
    // Leave the line buffer clean for the checks that follow.
    await browser.evaluate(() => window.__c.element.clear());
    await browser.keyboard.press("Escape");
    for (let i = 0; i < 40; i += 1) await browser.keyboard.press("Backspace");

    // Ctrl+C, on a real await. The Python side is exercised against the real `pyodide.console`
    // outside a browser; what needs a browser is the PLUMBING - that the `interrupt` message
    // reaches the worker WHILE its request queue is blocked behind the very execution it is
    // trying to end, that the key reaches the console while the terminal is paused for a running
    // command, and that the interpreter is still usable afterwards. `asyncio.sleep` on purpose
    // and not a login flow: the design works for anything the interpreter is waiting on.
    await browser.evaluate(() => window.__c.element.clear());
    await browser.evaluate(() => window.__c.element.execute("import asyncio"));
    await browser.waitForTimeout(400);
    await browser.evaluate(() => window.__c.focusInput());
    await browser.keyboard.type("await asyncio.sleep(30)", { delay: 1 });
    await browser.keyboard.press("Enter");
    // Long enough that the execution is definitely in flight and the queue is definitely blocked.
    await browser.waitForTimeout(700);
    const beforeInterrupt = Date.now();
    await browser.keyboard.press("Control+c");
    let interrupted = false;
    for (let i = 0; i < 40 && !interrupted; i += 1) {
      await browser.waitForTimeout(100);
      interrupted = await browser.evaluate(() => window.__c.text().includes("KeyboardInterrupt"));
    }
    const elapsed = Date.now() - beforeInterrupt;
    const interruptText = await browser.evaluate(() => window.__c.text());
    checks.push({
      name: "Ctrl+C cancels an in-flight await and Python writes its own KeyboardInterrupt",
      // Well under the 30 seconds the sleep would have taken: this is the cancellation landing,
      // not the statement finishing.
      pass: interrupted && elapsed < 6000,
      detail: `${elapsed}ms; ${JSON.stringify(interruptText.trim().split("\n").slice(-3))}`,
    });
    checks.push({
      name: "the interrupt's traceback names the line that was typed, not the console's plumbing",
      pass:
        interruptText.includes("<console>") &&
        !interruptText.includes("_freva_bridge") &&
        !interruptText.includes("CancelledError"),
      detail: JSON.stringify(interruptText.trim().split("\n").slice(-6)),
    });

    // AND THE INTERPRETER IS FINE. A cancellation that leaves the console unable to run the next
    // line has not interrupted anything, it has broken something.
    await browser.evaluate(() => window.__c.element.clear());
    await type("7 * 6");
    checks.push({
      name: "the interpreter still answers after an interrupt",
      pass: (await browser.evaluate(() => window.__c.text())).includes("42"),
      detail: (await browser.evaluate(() => window.__c.text())).trim().slice(-40),
    });

    // A nested await, several frames down, because a cancellation delivered at the OUTERMOST await
    // would leave the visitor's own function running and report otherwise.
    await browser.evaluate(() => window.__c.element.clear());
    await browser.evaluate(() =>
      window.__c.element.execute(
        "import asyncio\nasync def inner():\n    await asyncio.sleep(30)\nasync def outer():\n    await inner()\n",
      ),
    );
    await browser.waitForTimeout(400);
    await browser.evaluate(() => window.__c.focusInput());
    await browser.keyboard.type("await outer()", { delay: 1 });
    await browser.keyboard.press("Enter");
    await browser.waitForTimeout(700);
    await browser.keyboard.press("Control+c");
    let nested = false;
    for (let i = 0; i < 40 && !nested; i += 1) {
      await browser.waitForTimeout(100);
      nested = await browser.evaluate(() => window.__c.text().includes("KeyboardInterrupt"));
    }
    const nestedText = await browser.evaluate(() => window.__c.text());
    checks.push({
      name: "the cancellation reaches an await several frames inside the visitor's own code",
      pass: nested && nestedText.includes("in inner") && nestedText.includes("in outer"),
      detail: JSON.stringify(nestedText.trim().split("\n").slice(-7)),
    });

    // A URL is clickable: the case it exists for is a device-flow login printing an address and
    // waiting for it to be opened.
    await browser.evaluate(() => window.__c.element.clear());
    await type("print('open https://example.org/device?code=ABC-123 to continue.')");
    const link = await browser.evaluate(() => {
      const anchor = window.__c.q(".bp-line-body a.bp-link");
      return {
        href: anchor?.getAttribute("href") ?? null,
        text: anchor?.textContent ?? null,
        rel: anchor?.getAttribute("rel") ?? null,
        target: anchor?.getAttribute("target") ?? null,
      };
    });
    checks.push({
      name: "a URL Python printed is an anchor, without the sentence's full stop",
      pass:
        link.href === "https://example.org/device?code=ABC-123" &&
        link.text === "https://example.org/device?code=ABC-123" &&
        link.target === "_blank" &&
        (link.rel ?? "").includes("noopener"),
      detail: JSON.stringify(link),
    });

    // Real stdout, and a real traceback, in order.
    await browser.evaluate(() => window.__c.element.clear());
    await type("print('hello'); 1/0");
    const errored = await browser.evaluate(() => window.__c.text());
    checks.push({
      name: "real stdout and a real traceback render, in order",
      pass:
        errored.includes("hello") &&
        errored.includes("ZeroDivisionError") &&
        errored.indexOf("hello") < errored.indexOf("ZeroDivisionError"),
      detail: errored.trim().split("\n").pop(),
    });

    // The figure. Needs the matplotlib wheel; reported as not run rather than passed without it.
    if (runtimeHasPackages(["matplotlib", "numpy"])) {
      await browser.evaluate(() => window.__c.element.clear());
      await browser.evaluate(() =>
        window.__c.element.execute(
          "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3], [1, 4, 9])\nplt.show()\n",
        ),
      );
      await browser.waitForTimeout(2000);
      const figure = await browser.evaluate(() => {
        const image = window.__c.q(".bp-figure img");
        return {
          present: Boolean(image),
          blob: image?.getAttribute("src")?.startsWith("blob:") ?? false,
          alt: image?.getAttribute("alt") ?? null,
          width: image?.naturalWidth ?? 0,
          windowError: window.__c.text().includes("window is not defined"),
        };
      });
      checks.push({
        name: "plt.show() renders an inline figure, with no `window is not defined`",
        pass: figure.present && figure.blob && figure.width > 0 && !figure.windowError,
        detail: JSON.stringify(figure),
      });
    } else if (isStrict()) {
      // Neither a pass nor, on a workstation, a failure. A green tick for work that did not
      // happen is the one thing a suite must never report, but failing outright is wrong too: the
      // rest of this suite needs no wheels. So it counts as a failure only under the gate, where
      // "was never attempted" and "passed" must not look alike, and is otherwise a line that
      // claims nothing.
      checks.push({
        name: "inline Matplotlib figure",
        pass: false,
        detail:
          "NOT RUN under BROWSER_STRICT=1 - .runtime/ has no matplotlib wheel. Assemble it with " +
          "`node bin/freva-browser-python.mjs prepare-runtime --version 314.0.6 --full --out .runtime`.",
      });
    } else {
      console.log("  ....  inline Matplotlib figure NOT RUN - no matplotlib wheel (not a pass)");
    }

    // A package that cannot be downloaded, on a real engine. Deterministic without depending on
    // which wheels are on disk: the runtime is served from `/runtime/` as usual and only
    // `packageBaseURL` points somewhere that 404s, so the interpreter really starts and the
    // wheels really fail - the arrangement a deployment hits when its CDN is blocked.
    // `loadPackage` resolves when a wheel fails, so without an arrival check the startup carries
    // on to the first thing that imports a missing package and blames that:
    // `ModuleNotFoundError: No module named 'fsspec'`, a 13-line 87px status line inside a 134px
    // toolbar, and two fatal lines. Three defects, one cause.
    //
    // A pasted program with a blank line inside a suite: the case the line-by-line transport
    // could not carry. A blank line ENDS the current suite in the REPL protocol, right for
    // someone typing and wrong for a paste, because a blank line inside an indented body is
    // ordinary Python - fed to `push()` a line at a time it closes the `for`, and the next,
    // still-indented line arrives at top level as `IndentationError: unexpected indent`. A REAL
    // clipboard paste, not `execute()`, because the API path has always split its input.
    await browser.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: server.url,
    });
    const PROGRAM = [
      "values = []",
      "for i in range(2):",
      "    values.append(i)",
      "",
      "    values.append(i + 10)",
      "print(values)",
      "",
    ].join("\n");

    await browser.evaluate(async (program) => {
      await navigator.clipboard.writeText(program);
    }, PROGRAM);
    await browser.evaluate(() => window.__c.focusInput());
    await browser.waitForTimeout(150);
    await browser.keyboard.press("ControlOrMeta+V");
    // Polled, not slept on: the block is compiled and run in the worker, and how long that takes
    // depends on what else the interpreter has already loaded.
    await browser
      .waitForFunction(() => window.__c.text().includes("[0, 10, 1, 11]"), null, { timeout: 20000 })
      .catch(() => {});

    const pastedTranscript = await browser.evaluate(() => window.__c.text());

    checks.push({
      name: "a pasted program with a blank line inside a loop runs as written",
      pass: pastedTranscript.includes("[0, 10, 1, 11]"),
      detail: JSON.stringify(pastedTranscript.slice(-220)),
    });
    checks.push({
      name: "…with no IndentationError from the blank line closing the suite",
      pass: !pastedTranscript.includes("IndentationError"),
      detail: pastedTranscript.includes("IndentationError")
        ? JSON.stringify(pastedTranscript.slice(-220))
        : "none",
    });

    const healthyToolbar = await browser.evaluate(() =>
      Math.round(
        window.__c.element.shadowRoot.querySelector(".bp-toolbar").getBoundingClientRect().height,
      ),
    );

    const denied = await browser.evaluate(async () => {
      const { createBrowserPython } = await import("/dist/index.js");
      const element = document.createElement("freva-python-console");
      document.body.append(element);
      element.engine = createBrowserPython({
        profile: "minimal",
        packages: ["numpy"],
        pyodide: {
          indexURL: new URL("/runtime/", location.href).href,
          // Nothing is served here. The runtime still loads; only the wheels cannot.
          packageBaseURL: new URL("/no-wheels-here/", location.href).href,
        },
      });
      let message = null;
      try {
        await element.start();
      } catch (error) {
        message = String(error?.message ?? error);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      const root = element.shadowRoot;
      const status = root.querySelector(".bp-status");
      const toolbar = root.querySelector(".bp-toolbar");
      const out = {
        message,
        fatalLines: root.querySelectorAll(".bp-fatal").length,
        statusLines: (status?.textContent ?? "").split("\n").length,
        toolbarHeight: Math.round(toolbar?.getBoundingClientRect().height ?? 0),
        statusText: (status?.textContent ?? "").slice(0, 200),
      };
      element.remove();
      return out;
    });

    checks.push({
      name: "a wheel that cannot be downloaded is reported as a download failure, naming it",
      pass:
        typeof denied.message === "string" &&
        denied.message.includes("numpy") &&
        /could be downloaded/i.test(denied.message) &&
        denied.message.includes("no-wheels-here"),
      detail: JSON.stringify(denied.message),
    });
    checks.push({
      name: "…and NOT as the ModuleNotFoundError of whatever imported it next",
      pass:
        typeof denied.message === "string" && !/ModuleNotFoundError|micropip/.test(denied.message),
      detail: JSON.stringify(denied.message),
    });
    checks.push({
      name: "…reported exactly once, not twice",
      pass: denied.fatalLines === 1,
      detail: JSON.stringify({ fatalLines: denied.fatalLines }),
    });
    // Against the HEALTHY toolbar on the same page, not against a number: a pixel threshold is a
    // guess about button padding that a font change invalidates. The invariant is that failing
    // does not resize the chrome - a console reporting an error has to look like the same
    // console. The unhealthy toolbar measured 134px against a healthy 73px.
    checks.push({
      name: "…and a failure does not resize the toolbar: the status stays one line",
      pass:
        denied.statusLines === 1 &&
        healthyToolbar > 0 &&
        Math.abs(denied.toolbarHeight - healthyToolbar) <= 2,
      detail: JSON.stringify({
        statusLines: denied.statusLines,
        toolbarHeight: denied.toolbarHeight,
        healthyToolbar,
        statusText: denied.statusText,
      }),
    });

    // changing the profile actually changes it
    const profileChange = await browser.evaluate(async () => {
      const element = document.createElement("freva-python-console");
      element.setAttribute("profile", "minimal");
      element.setAttribute("index-url", new URL("/runtime/", location.href).href);
      // The console layer is bundled separately here, so the engine's default worker URL - resolved
      // from its own module - points into the bundle rather than at `dist/`.
      element.setAttribute(
        "worker-url",
        new URL("/dist/worker/browser-python.worker.js", location.href).href,
      );
      document.body.append(element);
      // This element OWNS its engine, which is the case under test: an injected engine's profile
      // belongs to the host and this element cannot change it.
      await element.start();

      const before = await element.engine.run("import sys\nprint('numpy' in sys.modules)\n");
      element.setAttribute("profile", "xarray-zarr");
      const attribute = element.profile;
      await element.restart();
      const after = await element.engine.run(
        "import sys\nprint('xarray' in sys.modules or __import__('importlib.util', fromlist=['x']).find_spec('xarray') is not None)\n",
      );
      const fs = await element.engine.run(
        "import fsspec\nprint(type(fsspec.filesystem('https')).__name__)\n",
      );
      element.dispose();
      element.remove();
      return {
        attribute,
        beforeError: before.error ?? null,
        afterError: after.error ?? null,
        fsError: fs.error ?? null,
      };
    });
    checks.push({
      // `BrowserPython.restart()` brings up a Worker with the options the engine was CONSTRUCTED
      // with, so an element that owns its engine rebuilds it instead - checked by what the
      // interpreter actually loaded rather than by reading the attribute back.
      name: "changing profile and restarting brings up an interpreter with the new profile",
      pass:
        profileChange.attribute === "xarray-zarr" &&
        profileChange.afterError === null &&
        profileChange.fsError === null,
      detail: JSON.stringify(profileChange),
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("console + real engine", result));
