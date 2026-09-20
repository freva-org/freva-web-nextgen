/**
 * Inline figures: Agg in a Worker, and a PNG that is actually a PNG. The obvious failure is
 * `ReferenceError: window is not defined` - Matplotlib's default Pyodide backend draws to a canvas
 * and reaches for the DOM, which a Worker does not have, and it fails at IMPORT, so `MPLBACKEND`
 * has to be set before anything can import the library (rich_display.py does it at module scope).
 * The less obvious one is that a "PNG" can arrive that is not one - a truncated buffer, a base64
 * string with a stray newline, an SVG mislabelled - so the bytes are decoded and the eight-byte
 * PNG signature checked rather than trusting the MIME type the payload claims for itself.
 */
import {
  fixturePage,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";

requireDist();

requireRuntimeFor("inline Matplotlib figures", "matplotlib.mjs");

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "minimal" }));
  const checks = [];
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    await page.evaluate(() => window.__py.start());

    // Synthetic data, deliberately. A real `wind.plot()` over a public CMIP6 store downloads
    // tens of megabytes of source chunk to draw one frame; that belongs in a manual demo.
    const plotted = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.run(
        [
          "import matplotlib",
          "import matplotlib.pyplot as plt",
          "backend = matplotlib.get_backend()",
          "fig, ax = plt.subplots(figsize=(3, 2))",
          "ax.plot([0, 1, 2, 3], [0, 1, 4, 9])",
          "ax.set_title('synthetic')",
          // Whose drawing is it? The backend module re-exports Agg's canvas, so this is what
          // proves the DOM-free renderer is in use - the backend NAME no longer says so by itself.
          "canvas = type(fig.canvas).__name__",
          "plt.show()",
          "",
        ].join("\n"),
      );
      const events = window.__py.drain();
      const backend = await window.__py.push("backend");
      const canvas = await window.__py.push("canvas");
      return { r, events, backend: backend.result, canvas: canvas.result };
    });

    checks.push({
      name: "importing Matplotlib in a Worker does not fail",
      pass: !plotted.r.error,
      detail: plotted.r.error ? String(plotted.r.error).split("\n").pop() : "imported",
    });
    // The backend is this package's module, and its drawing is Agg's. `MPLBACKEND` is
    // `module://freva_browser_backend` rather than plain "agg", because Matplotlib resolves its
    // backend at the first pyplot import and that is the only moment early enough for
    // `import matplotlib.pyplot as plt; plt.plot(...); plt.show()` to work as one submission. The
    // property that matters - that nothing touches a DOM - is asserted on the canvas class, and a
    // rejected `module://` URL fails at pyplot import and takes all plotting with it.
    checks.push({
      name: "Matplotlib accepts module://freva_browser_backend and resolves it",
      pass: plotted.backend === "'module://freva_browser_backend'",
      detail: String(plotted.backend),
    });
    checks.push({
      name: "…and draws through Agg's canvas, which needs no DOM",
      pass: String(plotted.canvas).includes("FigureCanvasAgg"),
      detail: String(plotted.canvas),
    });
    checks.push({
      name: "no 'window is not defined' anywhere in the output",
      pass: !plotted.events.some((e) => String(e.text ?? "").includes("window is not defined")),
    });

    const displays = plotted.events.filter((e) => e.type === "display");
    checks.push({
      name: "plt.show() produces exactly one display event",
      pass: displays.length === 1,
      detail: `${displays.length} display events, ${plotted.events.length} events in total`,
    });

    const figure = displays[0];
    checks.push({
      name: "…declared as base64 image/png",
      pass: figure?.mime === "image/png" && figure?.encoding === "base64",
      detail: figure ? `${figure.mime} / ${figure.encoding}` : "no display event",
    });

    if (figure) {
      const signature = await page.evaluate((data) => {
        const binary = atob(data);
        return [...binary.slice(0, 8)].map((c) => c.charCodeAt(0));
      }, figure.data);
      checks.push({
        name: "…and the decoded bytes really do start with the PNG signature",
        pass: signature.join(",") === PNG_SIGNATURE.join(","),
        detail: `[${signature.join(", ")}]`,
      });
      checks.push({
        name: "…carrying the figure number and its pixel size",
        pass:
          typeof figure.metadata?.figure === "number" &&
          typeof figure.metadata?.width === "number" &&
          figure.metadata.width > 0,
        detail: JSON.stringify(figure.metadata),
      });
    }

    // Figures are closed after rendering. An interactive session that plots in a loop would
    // otherwise accumulate every figure it ever drew until the tab is killed.
    const leftOpen = await page.evaluate(() => window.__py.push("len(plt.get_fignums())"));
    checks.push({
      name: "rendered figures are closed, so a plotting loop does not grow without bound",
      pass: leftOpen.result === "0",
      detail: `${leftOpen.result} figures still open`,
    });

    // Ordering: a print before the plot must arrive before the display event.
    const ordered = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.run(
        "print('before')\nfig2, ax2 = plt.subplots(figsize=(2, 2))\nax2.plot([1, 2])\nplt.show()\nprint('after')\n",
      );
      return window.__py.drain().map((e) => e.type);
    });
    checks.push({
      name: "display events are ordered with stdout, not appended after everything",
      pass: ordered.indexOf("stdout") < ordered.indexOf("display") && ordered.includes("display"),
      detail: JSON.stringify(ordered),
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("inline Matplotlib figures", result));
