/**
 * The console component, in a real browser, against a mock engine. The heart of it is INPUT
 * INTEGRITY: jQuery Terminal has a documented history of mangling Python (pyodide#5245), parsing
 * commands as shell arguments unless told not to, and its `[[ ]]` formatting syntax collides with
 * Python list literals. Every case below is typed with real keystrokes and asserted byte-for-byte
 * against what the mock engine received, because the regression lives in the typing path.
 */
import { consolePage, TINY_PNG } from "./console-fixture.mjs";
import { bundleConsole, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();
bundleConsole();

const browserName = process.env.BROWSER_ENGINE ?? "chromium";

/** Typed with real keystrokes and asserted byte-for-byte. */
const INPUT_CASES = [
  "# don't modify this comment",
  'test = {"Test": \'test\'}["Test"]',
  'value = [["a", "b"], ["c", "d"]]',
  "value[0][1]",
  'print("[[ terminal::clear() ]]")',
  'print("<img src=x onerror=alert(1)>")',
  'path = "C:\\\\Users\\\\name"',
  's = "héllo - ünïcode ✓ 日本語"',
  'url = "https://example.org/a?b=1&c=2#frag"',
  "    indented = True",
  "x = 'single' + \"double\"",
  "regex = r'\\d+[[a-z]]'",
  'q = f"{value!r} and {other:>10}"',
  // The library's own built-in commands, matched against the submitted line BEFORE the
  // interpreter is called, and all valid Python. Disabled in `surface-options.ts`; typed here,
  // because an option set in the wrong place looks exactly like one set in the right place.
  // `clear` is not on this list - the console answers the bare word itself (see the README) - and
  // `clear = 5`, `clear(x)` and `del clear` hold that line.
  "exit",
  "clear = 5",
  "clear(x)",
  "del clear",
  "login",
];

const result = await inBrowser(
  async (page) => {
    const server = await serve(consolePage());
    const checks = [];
    try {
      await page.goto(server.url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

      // mount and boundary

      checks.push({
        name: "the element mounts into a shadow root",
        pass: await page.evaluate(() =>
          Boolean(window.__c.root() && window.__c.q(".bp-container")),
        ),
      });

      // THE package boundary. jQuery must be private to the console's module graph.
      const globals = await page.evaluate(() => ({
        $: typeof window.$,
        jQuery: typeof window.jQuery,
      }));
      checks.push({
        name: "jQuery does not leak onto window",
        pass: globals.$ === "undefined" && globals.jQuery === "undefined",
        detail: JSON.stringify(globals),
      });

      await page.evaluate(() => window.__c.element.start());
      await page.waitForFunction(() => window.__c.mock.state === "ready", null, { timeout: 10000 });
      checks.push({
        name: "an INJECTED engine is used rather than a second one being created",
        pass: await page.evaluate(() => window.__c.element.engine === window.__c.mock),
      });

      // input integrity

      const typed = [];
      for (const source of INPUT_CASES) {
        await page.evaluate(() => {
          window.__c.mock.pushes.length = 0;
          window.__c.focusInput();
        });
        await page.keyboard.type(source, { delay: 1 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(40);
        typed.push({
          source,
          received: await page.evaluate(() => window.__c.mock.pushes[0]),
        });
      }
      const corrupted = typed.filter((t) => t.received !== t.source);
      checks.push({
        name: `${INPUT_CASES.length} Python inputs reach the engine byte-for-byte`,
        pass: corrupted.length === 0,
        detail:
          corrupted.length === 0
            ? "quotes, braces, [[ ]], backslashes, unicode, URLs, f-strings, indentation"
            : `first corruption: ${JSON.stringify(corrupted[0])}`,
      });

      // prompts

      const prompts = await page.evaluate(async () => {
        window.__c.mock.pushImpl = async () => ({
          executionId: "e",
          syntax: "incomplete",
          executed: false,
        });
        await window.__c.element.execute("def double(v):");
        const afterOpen = window.__c.q(".cmd-prompt")?.textContent ?? "";
        window.__c.mock.pushImpl = async () => ({
          executionId: "e",
          syntax: "complete",
          executed: true,
        });
        await window.__c.element.execute("");
        const afterClose = window.__c.q(".cmd-prompt")?.textContent ?? "";
        return { afterOpen, afterClose };
      });
      checks.push({
        name: "an incomplete statement shows `... `, and a complete one returns to `>>> `",
        pass: prompts.afterOpen.includes("...") && prompts.afterClose.includes(">>>"),
        detail: JSON.stringify(prompts),
      });

      // output

      const output = await page.evaluate(async () => {
        window.__c.element.clear();
        const mock = window.__c.mock;
        mock.emit({ type: "stdout", executionId: "x1", text: "printed\n" });
        mock.emit({ type: "stderr", executionId: "x1", text: "warned\n" });
        mock.emit({ type: "result", executionId: "x1", text: "'value'" });
        await new Promise((r) => setTimeout(r, 80));
        return window.__c.lines();
      });
      checks.push({
        name: "stdout, stderr and result render in order and keep their execution id",
        pass:
          output.map((l) => l.kind).join(",") === "stdout,stderr,result" &&
          output.every((l) => l.executionId === "x1"),
        detail: JSON.stringify(output.map((l) => `${l.kind}:${l.text.trim()}`)),
      });

      // security

      const security = await page.evaluate(async () => {
        window.__c.element.clear();
        const mock = window.__c.mock;
        mock.emit({ type: "stdout", executionId: "s", text: "<img src=x onerror=alert(1)>\n" });
        mock.emit({ type: "stdout", executionId: "s", text: "[[ terminal::clear() ]]\n" });
        mock.emit({
          type: "stdout",
          executionId: "s",
          text: '<a href="javascript:alert(1)">click</a>\n',
        });
        await new Promise((r) => setTimeout(r, 80));
        const transcript = window.__c.q(".bp-transcript");
        return {
          text: transcript.textContent,
          images: transcript.querySelectorAll("img").length,
          anchors: [...transcript.querySelectorAll("a")].map((a) => a.getAttribute("href")),
          stillHasLines: transcript.querySelectorAll(".bp-line").length,
        };
      });
      checks.push({
        name: "HTML in Python output is displayed as TEXT, not parsed",
        pass:
          security.images === 0 &&
          security.text.includes("<img src=x onerror=alert(1)>") &&
          security.text.includes("<a href="),
        detail: `${security.images} images created`,
      });
      checks.push({
        name: "terminal formatting/method syntax in output cannot invoke anything",
        // Had `[[ terminal::clear() ]]` been interpreted, the transcript would have been WIPED
        // and the earlier text gone. One line rather than three is correct: consecutive stdout
        // from one execution is coalesced into a single node, which is the batching working.
        pass:
          security.text.includes("[[ terminal::clear() ]]") &&
          security.text.includes("<img src=x onerror=alert(1)>") &&
          security.stillHasLines >= 1,
        detail: `${security.stillHasLines} coalesced line(s), earlier output intact`,
      });
      checks.push({
        name: "javascript: URLs are never turned into links",
        pass: !security.anchors.some((href) => (href ?? "").startsWith("javascript:")),
        detail: JSON.stringify(security.anchors),
      });

      const rejected = await page.evaluate(async () => {
        window.__c.element.clear();
        window.__c.mock.emit({
          type: "display",
          executionId: "d",
          mime: "text/html",
          encoding: "utf8",
          data: "<script>window.__pwned = true</script>",
        });
        await new Promise((r) => setTimeout(r, 60));
        return {
          pwned: Boolean(window.__pwned),
          scripts: window.__c.q(".bp-transcript").querySelectorAll("script").length,
          text: window.__c.text(),
        };
      });
      checks.push({
        name: "an HTML display event is refused outright",
        pass: !rejected.pwned && rejected.scripts === 0 && rejected.text.includes("no renderer"),
        detail: rejected.text.trim().slice(0, 60),
      });

      // figures

      const figure = await page.evaluate(async (png) => {
        window.__c.element.clear();
        window.__c.mock.emit({
          type: "display",
          executionId: "f",
          mime: "image/png",
          encoding: "base64",
          data: png,
          metadata: { figure: 1 },
        });
        await new Promise((r) => setTimeout(r, 60));
        const image = window.__c.q(".bp-figure img");
        return {
          present: Boolean(image),
          blob: image?.getAttribute("src")?.startsWith("blob:") ?? false,
          alt: image?.getAttribute("alt") ?? null,
          download: window.__c.q(".bp-figure-download")?.getAttribute("download") ?? null,
        };
      }, TINY_PNG);
      checks.push({
        name: "a PNG display event becomes an <img> from a blob URL, with an alt text",
        pass: figure.present && figure.blob && figure.alt === "Matplotlib figure 1",
        detail: JSON.stringify(figure),
      });

      const revoked = await page.evaluate(async () => {
        const revokedUrls = [];
        const original = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = (url) => {
          revokedUrls.push(url);
          original(url);
        };
        window.__c.element.clear();
        await new Promise((r) => setTimeout(r, 40));
        URL.revokeObjectURL = original;
        return revokedUrls.length;
      });
      checks.push({
        name: "clearing the transcript revokes the figure's blob URL",
        pass: revoked > 0,
        detail: `${revoked} URLs revoked`,
      });

      // accessibility

      const a11y = await page.evaluate(() => {
        const root = window.__c.root();
        const transcript = root.querySelector(".bp-transcript");
        const buttons = [...root.querySelectorAll(".bp-button")].map((b) => b.textContent?.trim());
        const menu = root.querySelector(".bp-completion");
        return {
          logRole: transcript?.getAttribute("role"),
          logName: transcript?.getAttribute("aria-label"),
          liveRegion: Boolean(root.querySelector('[aria-live="polite"]')),
          buttons,
          menuRole: menu?.getAttribute("role"),
          menuName: menu?.getAttribute("aria-label"),
          parts: [...root.querySelectorAll("[part]")].map((e) => e.getAttribute("part")),
        };
      });
      checks.push({
        name: "the transcript is a named log region with a polite live region beside it",
        pass: a11y.logRole === "log" && Boolean(a11y.logName) && a11y.liveRegion,
        detail: `role=${a11y.logRole} name=${a11y.logName}`,
      });
      checks.push({
        name: "every toolbar button has a text name",
        pass: a11y.buttons.length >= 3 && a11y.buttons.every((b) => Boolean(b)),
        detail: JSON.stringify(a11y.buttons),
      });
      checks.push({
        name: "the completion menu uses listbox semantics",
        pass: a11y.menuRole === "listbox" && Boolean(a11y.menuName),
      });
      checks.push({
        name: "stable ::part() names are exposed for theming",
        pass: ["container", "toolbar", "status", "transcript"].every((p) => a11y.parts.includes(p)),
        detail: JSON.stringify([...new Set(a11y.parts)]),
      });

      // highlighting

      const highlighted = await page.evaluate(async () => {
        window.__c.element.clear();
        window.__c.mock.pushImpl = async () => ({
          executionId: "h",
          syntax: "complete",
          executed: true,
        });
        await window.__c.element.execute("# note\nds = xr.open_zarr(URL, consolidated=True)");
        const command = window.__c.qa(".bp-command .bp-line-body");
        return {
          classes: [
            ...new Set(
              command.flatMap((c) => [...c.querySelectorAll("span")].map((s) => s.className)),
            ),
          ],
          // The rendered text must still BE the source.
          text: command.map((c) => c.textContent),
        };
      });
      checks.push({
        name: "submitted commands are syntax-highlighted with this package's own token classes",
        pass:
          highlighted.classes.some((c) => c === "bp-tok-comment") &&
          highlighted.classes.some((c) => c === "bp-tok-keyword" || c === "bp-tok-builtin") &&
          // No Prism class names anywhere: `bp-python` is the wrapper, `bp-tok-*` the tokens.
          highlighted.classes.every((c) => c === "bp-python" || c.startsWith("bp-tok-")),
        detail: JSON.stringify(highlighted.classes),
      });
      checks.push({
        name: "…and the highlighted text is still exactly the source",
        pass:
          highlighted.text[0] === "# note" &&
          highlighted.text[1] === "ds = xr.open_zarr(URL, consolidated=True)",
        detail: JSON.stringify(highlighted.text),
      });

      // live highlighting

      // The ACTIVE line, not the transcript. The surface owns this element and rebuilds it on
      // every keystroke, so highlighting it is a different mechanism from highlighting a submitted
      // command, and the one that fails silently. Colour arrives, and the text is untouched.
      await page.evaluate(() => {
        window.__c.element.clear();
        window.__c.focusInput();
      });
      await page.keyboard.type("name = f\"{ds.attrs['title']!r}\" # trailing", { delay: 1 });
      await page.waitForTimeout(200);
      const liveState = await page.evaluate(() => {
        const cells = [...window.__c.qa(".cmd-cursor-line [data-text]")].filter(
          (c) => (c.textContent ?? "") !== "",
        );
        return {
          classes: [
            ...new Set(
              cells.flatMap((c) => [...c.classList].filter((n) => n.startsWith("bp-tok-"))),
            ),
          ],
          command: window.__c.q(".cmd-cursor-line")?.textContent ?? "",
        };
      });
      checks.push({
        name: "the ACTIVE command line is highlighted as it is typed, f-strings included",
        // An f-string is the case that fails silently: the library writes an unescaped
        // `data-text` attribute, so a double quote produces an empty one and the pass is abandoned.
        pass:
          liveState.classes.includes("bp-tok-string") &&
          liveState.classes.includes("bp-tok-comment"),
        detail: JSON.stringify(liveState.classes),
      });
      checks.push({
        name: "…and highlighting the live line does not alter one character of it",
        pass:
          liveState.command.replace(/\u00a0/g, " ").trim() ===
          "name = f\"{ds.attrs['title']!r}\" # trailing",
        detail: JSON.stringify(liveState.command.replace(/\u00a0/g, " ")),
      });
      // the clear command

      // `clear` typed at the prompt, and the line drawn around it. It is the one input that
      // does not reach the interpreter, so it has to be shown working AND shown to be narrow:
      // every other use of the name is somebody's Python, in `INPUT_CASES` above.
      await page.evaluate(() => window.__c.focusInput());
      await page.keyboard.press("Control+c");
      await page.waitForTimeout(40);
      const clearCommand = await page.evaluate(async () => {
        const element = window.__c.element;
        const mock = window.__c.mock;
        element.clear();
        mock.pushes.length = 0;
        window.__c.mock.emit({ type: "stdout", text: "something to clear\n", executionId: "x" });
        await new Promise((r) => setTimeout(r, 60));
        const before = window.__c.root().querySelectorAll(".bp-line").length;
        window.__c.focusInput();
        return { before };
      });
      await page.keyboard.type("clear", { delay: 1 });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(80);
      const cleared = await page.evaluate(() => ({
        lines: window.__c.root().querySelectorAll(".bp-line").length,
        pushed: window.__c.mock.pushes.length,
        prompt: window.__c.root().querySelector(".cmd-prompt")?.textContent?.trim() ?? "",
      }));
      checks.push({
        name: "`clear` empties the transcript and is not sent to the interpreter",
        pass: clearCommand.before > 0 && cleared.lines === 0 && cleared.pushed === 0,
        detail: JSON.stringify({ ...clearCommand, ...cleared }),
      });

      await page.evaluate(() => window.__c.element.clear());
      await page.keyboard.press("Control+c");

      // lifecycle

      const lifecycle = await page.evaluate(async () => {
        const element = window.__c.element;
        const mock = window.__c.mock;
        const before = mock.listenerCount;
        const parent = element.parentElement;
        element.remove();
        const afterRemove = mock.listenerCount;
        parent.append(element);
        await new Promise((r) => setTimeout(r, 20));
        const afterReadd = mock.listenerCount;
        return { before, afterRemove, afterReadd, disposed: mock.disposed };
      });
      checks.push({
        name: "disconnecting unsubscribes and does NOT dispose an injected engine",
        pass: lifecycle.afterRemove === 0 && lifecycle.disposed === false,
        detail: JSON.stringify(lifecycle),
      });

      const restart = await page.evaluate(async () => {
        window.__c.mock.pushImpl = async () => ({
          executionId: "e",
          syntax: "incomplete",
          executed: false,
        });
        await window.__c.element.execute("if True:");
        await window.__c.element.restart();
        return {
          restarts: window.__c.mock.restarts,
          prompt: window.__c.q(".cmd-prompt")?.textContent ?? "",
        };
      });
      checks.push({
        name: "restart clears the continuation buffer and returns the prompt to `>>> `",
        pass: restart.restarts === 1 && restart.prompt.includes(">>>"),
        detail: JSON.stringify(restart),
      });

      // the transcript is rendered as a terminal
      //
      // These three assert what the console LOOKS like. Vendoring jquery.terminal's stylesheet
      // into the shadow root hands the transcript to the vendor's selectors: measured on this
      // traceback, 19px tall (three lines collapsed onto one), painted #aaa instead of the error
      // token, the "! " marker replaced by a zero-width space - with every suite green, because
      // they all read `textContent`. So: geometry and computed colour.
      const traceback =
        'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\n' +
        "NameError: name 'ls' is not defined\n";

      const rendered = await page.evaluate((text) => {
        window.__c.mock.emit({ type: "stderr", text, executionId: "tb" });
        return new Promise((resolve) => {
          setTimeout(() => {
            // THE TRACEBACK'S OWN LINE, by the execution id it was emitted with.
            // `querySelector(".bp-stderr")` takes the FIRST stderr in the transcript, which is
            // only the traceback while nothing else has written to stderr - and Ctrl+C answers
            // `KeyboardInterrupt` the way Python does, which the check above presses.
            const el = window.__el.shadowRoot.querySelector('.bp-stderr[data-execution-id="tb"]');
            if (!el) return resolve({ missing: true });
            const cs = getComputedStyle(el);
            const lineHeight = parseFloat(cs.lineHeight);
            const probe = document.createElement("span");
            probe.style.color = cs.getPropertyValue("--bp-console-error");
            document.body.append(probe);
            const errorToken = getComputedStyle(probe).color;
            probe.remove();
            resolve({
              whiteSpace: cs.whiteSpace,
              height: el.getBoundingClientRect().height,
              lineHeight,
              lines: Math.round(el.getBoundingClientRect().height / lineHeight),
              color: cs.color,
              errorToken,
            });
          }, 250);
        });
      }, traceback);

      checks.push({
        name: "a three-line traceback occupies three lines, not one",
        pass: !rendered.missing && rendered.lines === 3,
        detail: JSON.stringify(rendered),
      });
      checks.push({
        name: "…because the line preserves newlines rather than collapsing them",
        pass: rendered.whiteSpace === "pre-wrap",
        detail: JSON.stringify(rendered),
      });
      checks.push({
        name: "…and it is painted in --bp-console-error, not the vendor's grey",
        pass: !rendered.missing && rendered.color === rendered.errorToken,
        detail: JSON.stringify(rendered),
      });

      // every profile the engine has
      const profiles = await page.evaluate(() => {
        const element = window.__c.element;
        const seen = {};
        for (const name of ["minimal", "xarray-zarr", "freva-client", "nonsense"]) {
          element.setAttribute("profile", name);
          seen[name] = element.profile;
        }
        element.setAttribute("profile", "minimal");
        return seen;
      });
      checks.push({
        // A getter written as `=== "xarray-zarr" ? "xarray-zarr" : "minimal"` makes
        // `<freva-python-console profile="freva-client">` silently boot a minimal interpreter with
        // none of the Freva wheels, and `element.profile = "freva-client"` reads back as
        // "minimal" - a round trip that loses its value with no error anywhere.
        name: "the profile attribute round-trips for every profile the engine supports",
        pass:
          profiles.minimal === "minimal" &&
          profiles["xarray-zarr"] === "xarray-zarr" &&
          profiles["freva-client"] === "freva-client",
        detail: JSON.stringify(profiles),
      });
      checks.push({
        name: "…and an unknown one falls back to minimal rather than being passed through",
        pass: profiles.nonsense === "minimal",
        detail: JSON.stringify({ nonsense: profiles.nonsense }),
      });

      return checks;
    } finally {
      await server.close();
    }
  },
  { browserName },
);

process.exit(report(`console component (${browserName})`, result));
