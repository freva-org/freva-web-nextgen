// Notebook cells against the real interpreter: `executeCell`, alongside `run()`/`push()`.
//
// What only a real CPython can answer: the value of a last expression and what a trailing
// semicolon does to it, top-level await, the order stdout, stderr and an exception really arrive
// in, the MIME bundles real pandas/xarray/Matplotlib objects produce, a broken `_repr_html_`,
// execution counts across failures, cancellations and a restart, completion offsets past astral
// characters, and payloads forged from Python itself.
import {
  fixturePage,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";

requireDist();
requireRuntimeFor("cells", "cells.mjs");

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "xarray-zarr" }));
  const checks = [];
  const check = (name, pass, detail) =>
    checks.push({
      name,
      pass: Boolean(pass),
      ...(detail !== undefined ? { detail: String(detail).slice(0, 400) } : {}),
    });
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    await page.evaluate(() => window.__py.start());

    /** One cell: its result and every event it produced, with long payloads summarised. */
    const cell = (source, options = {}) =>
      page.evaluate(
        async ([s, o]) => {
          window.__py.drain();
          const result = await window.__py.engine.executeCell(s, o);
          const events = window.__py.drain().map((e) =>
            e.data && typeof e.data === "object"
              ? {
                  ...e,
                  data: Object.fromEntries(
                    Object.entries(e.data).map(([k, v]) => [
                      k,
                      v.length > 4000 ? `${v.slice(0, 4000)}…(${v.length})` : v,
                    ]),
                  ),
                }
              : e,
          );
          return { result, events };
        },
        [source, options],
      );
    const types = (r) => r.events.map((e) => e.type);

    // 1. The last expression, and what a semicolon or an assignment does to it.
    const last = await cell("x = 21\nx * 2");
    const value = last.events.find((e) => e.type === "execute_result");
    check(
      "the last expression is the cell's execute_result",
      value?.data["text/plain"] === "42",
      JSON.stringify(last.events),
    );
    check(
      "…numbered with the cell's count, announced before any output",
      last.result.executionCount === 1 &&
        types(last)[0] === "execute_input" &&
        last.events[0].executionCount === 1,
      JSON.stringify(last),
    );
    const semi = await cell("x * 2;");
    check(
      "a trailing semicolon suppresses the result",
      !types(semi).includes("execute_result"),
      types(semi),
    );
    const assign = await cell("y = x");
    check(
      "an assignment produces no result",
      !types(assign).includes("execute_result"),
      types(assign),
    );

    // 2. Top-level await, as in the console.
    const awaited = await cell("import asyncio\nawait asyncio.sleep(0.05)\n'awaited'");
    check(
      "top-level await works and the awaited value is the result",
      awaited.events.some(
        (e) => e.type === "execute_result" && e.data["text/plain"] === "'awaited'",
      ),
      JSON.stringify(awaited.events),
    );

    // 3. Ordering: output, then the exception, in the order Python produced them.
    const ordered = await cell(
      "import sys\nprint('a')\nprint('b', file=sys.stderr)\nprint('c')\n1/0",
    );
    const streamed = ordered.events
      .filter((e) => e.type !== "execute_input")
      .map((e) => (e.type === "error" ? `error:${e.ename}` : `${e.type}:${e.text?.trim()}`));
    check(
      "stdout, stderr and the error arrive in the order Python produced them",
      streamed.join(",") === "stdout:a,stderr:b,stdout:c,error:ZeroDivisionError",
      streamed,
    );
    const error = ordered.events.find((e) => e.type === "error");
    check(
      "the error is structured: ename, evalue, and a traceback from the cell's own frame",
      error?.evalue === "division by zero" &&
        error.traceback[0] === "Traceback (most recent call last):" &&
        /File "<cell-\d+>", line 5/.test(error.traceback.join("\n")) &&
        !/_freva_bridge|_pyodide/.test(error.traceback.join("\n")),
      JSON.stringify(error),
    );
    check(
      "…and the result says error, with the count it was given",
      ordered.result.status === "error" &&
        ordered.result.executionCount === 5 &&
        ordered.result.ename === "ZeroDivisionError",
      JSON.stringify(ordered.result),
    );
    const syntax = await cell("def f(:\n  pass");
    check(
      "a syntax error is reported without internal frames",
      syntax.result.ename === "SyntaxError" &&
        !/Traceback/.test(syntax.result.traceback.join("\n")),
      JSON.stringify(syntax.result),
    );

    // 4. MIME bundles from real objects.
    const df = await cell("import pandas as pd\npd.DataFrame({'a': [1, 2]})");
    const dfResult = df.events.find((e) => e.type === "execute_result");
    check(
      "a DataFrame is an HTML bundle with a plain-text fallback",
      /<table/.test(dfResult?.data["text/html"] ?? "") &&
        /a/.test(dfResult?.data["text/plain"] ?? ""),
      JSON.stringify(dfResult?.data),
    );
    const xr = await cell(
      "import xarray as xr, numpy as np\nxr.DataArray(np.arange(3), dims='x', name='t')",
    );
    check(
      "an xarray object is an HTML bundle",
      /xr-wrap/.test(xr.events.find((e) => e.type === "execute_result")?.data["text/html"] ?? ""),
      JSON.stringify(xr.events.map((e) => e.type)),
    );
    const custom = await cell(
      "class Both:\n" +
        "    def _repr_mimebundle_(self, include=None, exclude=None):\n" +
        "        return {'image/svg+xml': '<svg xmlns=\"http://www.w3.org/2000/svg\"/>', 'text/plain': 'both', 'application/json': {'a': 1}}, {'image/svg+xml': {'width': 5}}\n" +
        "    def _repr_html_(self):\n" +
        "        return '<b>html</b>'\n" +
        "Both()",
    );
    const both = custom.events.find((e) => e.type === "execute_result");
    check(
      "_repr_mimebundle_ first, then _repr_html_, unknown types dropped, sizes kept",
      both?.data["image/svg+xml"] &&
        both.data["text/html"] === "<b>html</b>" &&
        both.data["text/plain"] === "both" &&
        !("application/json" in both.data) &&
        both.metadata["image/svg+xml"]?.width === 5,
      JSON.stringify(both),
    );
    const broken = await cell(
      "class Broken:\n    def _repr_html_(self):\n        raise RuntimeError('repr bug')\n    def __repr__(self):\n        return 'Broken()'\nBroken()",
    );
    const brokenResult = broken.events.find((e) => e.type === "execute_result");
    check(
      "a broken repr gives a visible diagnostic and the fallback, and the cell still succeeds",
      broken.result.status === "ok" &&
        brokenResult?.data["text/plain"] === "Broken()" &&
        !("text/html" in (brokenResult?.data ?? {})) &&
        broken.events.some(
          (e) =>
            e.type === "stderr" && /_repr_html_\(\) raised RuntimeError: repr bug/.test(e.text),
        ),
      JSON.stringify(broken.events),
    );
    const png = await cell(
      "class P:\n    def _repr_png_(self):\n        import base64\n        return base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')\nP()",
    );
    check(
      "_repr_png_ bytes become a base64 PNG",
      /^iVBORw0KGgo/.test(
        png.events.find((e) => e.type === "execute_result")?.data["image/png"] ?? "",
      ),
      JSON.stringify(png.events),
    );
    const huge = await cell(
      "class Huge:\n    def _repr_html_(self):\n        return '<p>' + 'x' * (2 * 1024 * 1024)\nHuge()",
    );
    const hugeResult = huge.events.find((e) => e.type === "execute_result");
    check(
      "an HTML repr over its limit is refused before conversion, with the reason, and the plain text shown",
      hugeResult &&
        !("text/html" in hugeResult.data) &&
        huge.events.some(
          (e) =>
            e.type === "stderr" && /text\/html is 2\.0 MiB, over the 1\.0 MiB limit/.test(e.text),
        ),
      JSON.stringify(huge.events.map((e) => e.text ?? e.type)),
    );

    // 5. Figures: show() in place, and every open figure at the end of the cell.
    const figs = await cell(
      "import matplotlib.pyplot as plt\nplt.plot([1, 2])\nplt.show()\nprint('between')\nfig, ax = plt.subplots()\nax.plot([3, 1])",
    );
    const figTypes = figs.events
      .filter((e) => e.type !== "execute_input" && !(e.type === "stdout" && /Load/.test(e.text)))
      .map((e) =>
        e.type === "display_data"
          ? `png:${Boolean(e.data["image/png"])}`
          : e.type === "stdout"
            ? e.text.trim()
            : e.type,
      );
    check(
      "plt.show() draws in place and the open figure is drawn at the end of the cell",
      figTypes.join(",") === "png:true,between,execute_result,png:true",
      figTypes,
    );
    const reshow = await cell("ax.set_title('again')\nfig");
    check(
      "a figure built across cells is drawn again as the result",
      /^iVBORw0KGgo/.test(
        reshow.events.find((e) => e.type === "execute_result")?.data["image/png"] ?? "",
      ),
      JSON.stringify(reshow.events.map((e) => e.type)),
    );
    const closed = await cell("import matplotlib.pyplot as plt\nlen(plt.get_fignums())");
    check(
      "…and figures are closed once drawn, as IPython's inline backend does",
      closed.events.find((e) => e.type === "execute_result")?.data["text/plain"] === "0",
    );

    // 6. display(), clear_output() and raw bundles.
    const shown = await cell(
      "display('one', {'text/html': '<i>raw</i>', 'text/plain': 'raw'}, raw=False)\nclear_output(wait=True)\ndisplay({'text/html': '<i>r</i>'}, raw=True)",
    );
    check(
      "display() and clear_output() are built in, in order",
      types(shown).join(",") ===
        "execute_input,display_data,display_data,clear_output,display_data",
      types(shown),
    );

    // 7. Forged payloads, from Python itself.
    const forged = await cell(
      "import rich_display\n" +
        'rich_display._publisher(\'{"output": "display_data", "data": {"text/plain": "x", "application/javascript": "alert(1)"}}\')\n' +
        'rich_display._publisher(\'{"output": "display_data", "data": {"text/html": "<b>no plain</b>"}}\')\n' +
        "rich_display._publisher('not json')\n" +
        'rich_display._publisher(\'{"output": "display_data", "data": {"text/plain": "x", "image/png": "%%%"}}\')',
    );
    const refused = forged.events.filter(
      (e) => e.type === "stderr" && /dropped a display payload/.test(e.text),
    );
    check(
      "payloads forged from Python are refused at the worker, each with a reason",
      refused.length === 4 && !types(forged).includes("display_data"),
      JSON.stringify(forged.events),
    );

    // 8. Large output is pruned, and the cell is told.
    const flood = await cell("for i in range(400000):\n    print('xxxxxxxx', i)");
    check(
      "a flood of output is cut at the execution's budget, with one notice",
      flood.events.some((e) => e.type === "stderr" && /output limit reached/.test(e.text)),
      flood.events.length,
    );

    // 9. Counts: failures keep theirs, cancelled cells get none, a restart starts again at 1.
    const before = await cell("1");
    const [running, queuedA, queuedB] = await page.evaluate(async () => {
      const e = window.__py.engine;
      const a = e.executeCell("import asyncio\nawait asyncio.sleep(0.5)");
      const b = e.executeCell("2");
      const c = e.executeCell("3");
      await new Promise((r) => setTimeout(r, 50));
      e.cancelQueuedCells();
      return Promise.all([a, b, c]);
    });
    check(
      "cancelled queued cells get no count and never ran",
      queuedA.status === "cancelled" &&
        queuedA.executionCount === null &&
        queuedB.executionCount === null &&
        running.executionCount === before.result.executionCount + 1,
      JSON.stringify([running, queuedA, queuedB]),
    );
    const silent = await cell("41 + 1", { silent: true });
    check(
      "a silent cell publishes no result and takes no count",
      silent.result.executionCount === null && !types(silent).includes("execute_result"),
      JSON.stringify(silent),
    );
    await page.evaluate(() => window.__py.restart());
    const fresh = await cell("'fresh'");
    check(
      "a new interpreter counts from 1 again",
      fresh.result.executionCount === 1,
      JSON.stringify(fresh.result),
    );

    // 10. Completion offsets are UTF-16, past astral characters.
    await cell("value_after_emoji = 1");
    const completed = await page.evaluate(() => {
      const source = 's = "😀😀"; value_after_e';
      return window.__py
        .complete(source, source.length)
        .then((c) => ({ ...c, at: source.indexOf("value") }));
    });
    check(
      "completion's start is a UTF-16 offset past astral characters",
      completed.start === completed.at && completed.matches.includes("value_after_emoji"),
      JSON.stringify(completed),
    );

    // 11. Cells leave the console alone: push() echoes text; display() reaches it as a bundle.
    const pushed = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.push("import pandas as pd; df = pd.DataFrame({'a': [1]}); df");
      const d = await window.__py.push("display(df)");
      return { r, d, events: window.__py.drain().map((e) => e.type) };
    });
    check(
      "push() still echoes a value as result text",
      pushed.r.result?.includes("a") && pushed.events.includes("result"),
      JSON.stringify(pushed),
    );
    check(
      "…and display() in the console is a display_data bundle",
      pushed.events.includes("display_data"),
      pushed.events,
    );
    const ran = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.run("1 + 1");
      return { r, events: window.__py.drain().map((e) => e.type) };
    });
    check(
      "run() keeps its file semantics: no value from the last line",
      ran.r.result === undefined &&
        !ran.events.includes("result") &&
        !ran.events.includes("execute_result"),
      JSON.stringify(ran),
    );
  } finally {
    await server.close();
  }
  return checks;
});

process.exit(
  report("cells: executeCell, MIME bundles and counts against the real interpreter", result),
);
