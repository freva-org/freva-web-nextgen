// The rich-output path, end to end, without Matplotlib.
//
// Everything between Python and a consumer's `onOutput` is exercised by having Python hand over
// synthetic payloads: the bridge call after each execution, the worker's validation,
// `postMessage`, the engine's second validation, the listener. Matplotlib itself is covered in
// `matplotlib.mjs`, which needs its wheel; this covers the pipeline that carries its output and
// needs nothing but an interpreter.
//
// The refusal cases matter most. `capture_display` is an ordinary attribute of an ordinary module
// in the user's own namespace, so anyone at the prompt can replace it with a function returning
// `text/html`: "the display bridge produced it" is not a reason to trust a payload.
import { fixturePage, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();

/** A real, minimal 1x1 PNG. Decoded and signature-checked below rather than taken on trust. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "minimal" }));
  const checks = [];

  /** Make Python's display bridge return exactly `payloads` for the next execution. */
  const stub = async (payloads) => {
    await page.evaluate(async (json) => {
      await window.__py.run(
        `import _freva_bridge, json\n` +
          `_payloads = json.loads(${JSON.stringify(json)})\n` +
          `_freva_bridge.capture_display = lambda: _payloads\n`,
      );
    }, JSON.stringify(payloads));
  };

  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    await page.evaluate(() => window.__py.start());

    // 1. A valid PNG survives the whole path with its metadata.
    await stub([
      {
        mime: "image/png",
        encoding: "base64",
        data: TINY_PNG,
        metadata: { figure: 1, width: 1, height: 1 },
      },
    ]);
    const png = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.push("1 + 1");
      return window.__py.drain();
    });
    const display = png.find((e) => e.type === "display");
    checks.push({
      name: "a PNG payload reaches the consumer as a display event",
      pass: display?.mime === "image/png" && display?.encoding === "base64",
      detail: display ? `${display.mime} / ${display.encoding}` : "no display event",
    });
    checks.push({
      name: "…with its metadata intact",
      pass: display?.metadata?.figure === 1 && display?.metadata?.width === 1,
      detail: JSON.stringify(display?.metadata),
    });
    checks.push({
      name: "…and correlated with the execution that produced it",
      pass: display?.executionId === png.find((e) => e.type === "result")?.executionId,
      detail: display?.executionId,
    });
    if (display) {
      const signature = await page.evaluate((data) => {
        const binary = atob(data);
        return [...binary.slice(0, 8)].map((c) => c.charCodeAt(0));
      }, display.data);
      checks.push({
        name: "…and the bytes really are a PNG, not something that says it is",
        pass: signature.join(",") === "137,80,78,71,13,10,26,10",
        detail: `[${signature.join(", ")}]`,
      });
    }

    // 2. text/plain, the other admitted type.
    await stub([{ mime: "text/plain", encoding: "utf8", data: "a repr of something" }]);
    const text = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.push("2");
      return window.__py.drain().find((e) => e.type === "display");
    });
    checks.push({
      name: "text/plain passes as utf8",
      pass: text?.mime === "text/plain" && text?.data === "a repr of something",
      detail: JSON.stringify(text?.data),
    });

    // 3. THE refusals. Each of these is a payload Python authored and the boundary must not carry.
    const refusals = [
      ["text/html", { mime: "text/html", encoding: "utf8", data: "<script>alert(1)</script>" }],
      [
        "image/svg+xml",
        { mime: "image/svg+xml", encoding: "utf8", data: "<svg onload='alert(1)'/>" },
      ],
      ["a PNG that claims to be text", { mime: "image/png", encoding: "utf8", data: "raw bytes" }],
      ["base64 that is not base64", { mime: "image/png", encoding: "base64", data: "not b64!" }],
      ["a bare string", "just a string"],
    ];
    for (const [name, payload] of refusals) {
      await stub([payload]);
      const events = await page.evaluate(async () => {
        window.__py.drain();
        await window.__py.push("3");
        return window.__py.drain();
      });
      const carried = events.some((e) => e.type === "display");
      const complained = events.some(
        (e) => e.type === "stderr" && e.text.includes("dropped a display payload"),
      );
      checks.push({
        name: `refused: ${name}`,
        pass: !carried && complained,
        detail: carried
          ? "IT WAS CARRIED"
          : complained
            ? "dropped, and said so"
            : "dropped silently",
      });
    }

    // 4. A bridge that raises must not take the execution with it.
    await page.evaluate(async () => {
      await window.__py.run(
        "import _freva_bridge\n" +
          "def _boom():\n    raise RuntimeError('bridge exploded')\n" +
          "_freva_bridge.capture_display = _boom\n",
      );
    });
    const survived = await page.evaluate(async () => {
      const r = await window.__py.push("4 + 4");
      return r;
    });
    checks.push({
      name: "an exploding display bridge does not fail the user's execution",
      pass: survived.result === "8" && !survived.error,
      detail: JSON.stringify(survived),
    });

    // Figure lifecycle, against a stand-in pyplot. Real Matplotlib lives in `matplotlib.mjs` and
    // needs its wheel; what is verified here is the RULE - `show()` marks, collection renders
    // only what was marked, and a figure nobody showed is still open afterwards, which is what
    // makes it possible to build a plot over several commands instead of one pasted block.
    const figures = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.run(`
import sys, types, json

class _FakeFigure:
    def __init__(self, number):
        self.number = number
        self.dpi = 1
    def savefig(self, buffer, **_kw):
        buffer.write(b"PNG")
    def get_size_inches(self):
        class _S:
            def __mul__(self, _other): return [1, 1]
        return _S()

class _FakePyplot(types.ModuleType):
    def __init__(self):
        super().__init__("matplotlib.pyplot")
        self._figs = {}
        self.closed = []
    def get_fignums(self): return sorted(self._figs)
    def figure(self, number):
        self._figs.setdefault(number, _FakeFigure(number))
        return self._figs[number]
    def close(self, figure):
        self.closed.append(figure.number)
        self._figs.pop(figure.number, None)
    def subplots(self):
        number = (max(self._figs) + 1) if self._figs else 1
        return (self.figure(number), object())

_plt = _FakePyplot()
sys.modules["matplotlib"] = types.ModuleType("matplotlib")
sys.modules["matplotlib.pyplot"] = _plt

import rich_display
rich_display._MARKED.clear()

# Building a figure by hand: created, not shown. Collection must leave it alone.
_plt.subplots()
_unshown = len(rich_display.capture_figures())
_still_open = _plt.get_fignums()

# Now show it.
_plt.show()
_shown = rich_display.capture_figures()
_open_at_end = _plt.get_fignums()

# Marked, then closed by hand before collection: skipped, not an error.
_plt.subplots()
_plt.subplots()
_plt.show()
_nums = _plt.get_fignums()
_plt.close(_plt.figure(_nums[-1]))
_after_partial = len(rich_display.capture_figures())

print(json.dumps({
    "unshownRendered": _unshown,
    "stillOpen": _still_open,
    "shownRendered": len(_shown),
    "shownMime": _shown[0]["mime"] if _shown else None,
    "openAtEnd": _open_at_end,
    "afterPartial": _after_partial,
}))
`);
      return window.__py.text("stdout").trim();
    });

    // The backend's show(), on a FRESH interpreter. Patching `plt.show` from the collection step
    // runs after the user's command, so `import matplotlib.pyplot as plt; plt.plot(...);
    // plt.show()` in ONE submission marks nothing and displays nothing. A backend module is
    // resolved at Matplotlib's first import, so there is no window in which the wrong `show` is
    // live. What is proved here is that OUR backend module marks through `rich_display` the
    // moment its `show()` is called; real Matplotlib is exercised in `matplotlib.mjs`.
    const backend = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.run(`
import sys, types, json

# Stand-ins for exactly what the backend module imports.
_agg = types.ModuleType("matplotlib.backends.backend_agg")
class _Canvas: pass
class _Manager:
    def __init__(self, num): self.num = num
_agg.FigureCanvasAgg = _Canvas
_agg.FigureManagerBase = _Manager

_helpers = types.ModuleType("matplotlib._pylab_helpers")
class _Gcf:
    managers = [_Manager(1), _Manager(7)]
    @classmethod
    def get_all_fig_managers(cls): return cls.managers
_helpers.Gcf = _Gcf

_mpl = types.ModuleType("matplotlib")
_backends = types.ModuleType("matplotlib.backends")
sys.modules["matplotlib"] = _mpl
sys.modules["matplotlib.backends"] = _backends
sys.modules["matplotlib.backends.backend_agg"] = _agg
sys.modules["matplotlib._pylab_helpers"] = _helpers

import rich_display
rich_display._MARKED.clear()

import freva_browser_backend as _b
_exports = sorted(n for n in ("FigureCanvas", "FigureManager", "show") if hasattr(_b, n))
_b.show()
print(json.dumps({"marked": sorted(rich_display._MARKED), "exports": _exports}))
`);
      return window.__py.text("stdout").trim();
    });
    const backendResult = backend ? JSON.parse(backend) : null;
    checks.push({
      name: "the backend's show() marks every open figure, through rich_display",
      pass: backendResult !== null && JSON.stringify(backendResult.marked) === "[1,7]",
      detail: JSON.stringify(backendResult),
    });
    checks.push({
      name: "…and the module exports the names Matplotlib looks for on a backend",
      pass:
        backendResult !== null &&
        JSON.stringify(backendResult.exports) === '["FigureCanvas","FigureManager","show"]',
      detail: JSON.stringify(backendResult),
    });

    // Bounds. Everything above proves the path carries what it should; these prove it stops
    // carrying when the volume becomes the problem, in the real worker, over a real
    // `postMessage`, with a real interpreter still expected to be usable afterwards. Nothing here
    // returns a payload to the test - these are tens of megabytes, and serialising them out
    // through the browser protocol to count them would be a bigger copy than the one measured.

    // 5. One figure too large for any consumer to want.
    const oversized = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.run(
        "import _freva_bridge\n" +
          "_freva_bridge.capture_display = lambda: [" +
          "{'mime': 'image/png', 'encoding': 'base64', 'data': 'A' * (25 * 1024 * 1024)}]\n",
      );
      window.__py.drain();
      const reply = await window.__py.push("5");
      const events = window.__py.drain();
      const after = await window.__py.push("6 + 6");
      return {
        displays: events.filter((e) => e.type === "display").length,
        stderr: events.filter((e) => e.type === "stderr").map((e) => e.text),
        error: reply.error ?? null,
        stillAlive: after.result,
      };
    });
    checks.push({
      name: "a 25 MiB figure is refused before anything decodes it",
      pass: oversized.displays === 0,
      detail: `${oversized.displays} display events`,
    });
    checks.push({
      name: "…with exactly one stderr line that names the limit",
      pass:
        oversized.stderr.length === 1 &&
        oversized.stderr[0].includes("MiB limit") &&
        oversized.stderr[0].includes("/workspace"),
      detail: JSON.stringify(oversized.stderr),
    });
    checks.push({
      name: "…and the interpreter is still usable afterwards",
      pass: oversized.error === null && oversized.stillAlive === "12",
      detail: JSON.stringify({ error: oversized.error, then: oversized.stillAlive }),
    });

    // 6. Seventeen legal figures in one cell, which together are not legal.
    const many = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.run(
        "import _freva_bridge\n" +
          "_freva_bridge.capture_display = lambda: [" +
          "{'mime': 'image/png', 'encoding': 'base64', 'data': 'A' * (4 * 1024 * 1024)}" +
          " for _ in range(17)]\n",
      );
      window.__py.drain();
      await window.__py.push("7");
      const first = window.__py.drain();
      await window.__py.push("8");
      const second = window.__py.drain();
      const summarise = (events) => ({
        displays: events.filter((e) => e.type === "display").length,
        bytes: events
          .filter((e) => e.type === "display")
          .reduce((total, e) => total + e.data.length, 0),
        notices: events.filter(
          (e) => e.type === "stderr" && e.text.includes("display output limit"),
        ).length,
      });
      return { first: summarise(first), second: summarise(second) };
    });
    checks.push({
      name: "a cell's TOTAL display output is bounded, not just each figure",
      pass: many.first.displays < 17 && many.first.bytes <= 64 * 1024 * 1024,
      detail: JSON.stringify(many.first),
    });
    checks.push({
      name: "…and says so once, not once per dropped figure",
      pass: many.first.notices === 1,
      detail: `${many.first.notices} notices`,
    });
    checks.push({
      name: "…and the next cell has its own budget - one bad cell does not mute the session",
      pass: many.second.displays > 0,
      detail: JSON.stringify(many.second),
    });

    // 7. Text: batched on the way out, and bounded once it stops being output and starts being a
    // denial of service against the tab that asked for it.
    await page.evaluate(async () => {
      await window.__py.run("import _freva_bridge\n_freva_bridge.capture_display = lambda: []\n");
    });
    const batching = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.run("for i in range(20000): print(i)");
      const events = window.__py.drain();
      const stdout = events.filter((e) => e.type === "stdout");
      return {
        messages: stdout.length,
        chars: stdout.reduce((total, e) => total + e.text.length, 0),
        head: stdout[0]?.text.slice(0, 4),
        tail: stdout
          .map((e) => e.text)
          .join("")
          .slice(-6),
      };
    });
    checks.push({
      name: "20,000 prints do not become 20,000 messages",
      pass: batching.messages > 0 && batching.messages < 200,
      detail: `${batching.messages} messages for ${batching.chars} characters`,
    });
    checks.push({
      name: "…and batching does not reorder or lose a single line",
      pass: batching.head === "0\n1\n" && batching.tail === "19999\n",
      detail: JSON.stringify({ head: batching.head, tail: batching.tail }),
    });

    const bounded = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.run("for _ in range(40): print('x' * 100000)");
      const events = window.__py.drain();
      const after = await window.__py.push("'still here'");
      return {
        chars: events
          .filter((e) => e.type === "stdout")
          .reduce((total, e) => total + e.text.length, 0),
        notices: events
          .filter((e) => e.type === "stderr" && e.text.includes("output limit reached"))
          .map((e) => e.text),
        stillAlive: after.result,
      };
    });
    checks.push({
      name: "4 MiB of print output is cut off at the documented limit",
      pass: bounded.chars > 0 && bounded.chars <= 2 * 1024 * 1024,
      detail: `${bounded.chars} characters retained`,
    });
    checks.push({
      name: "…with one notice that says how much was omitted",
      pass: bounded.notices.length === 1 && /omitted/.test(bounded.notices[0]),
      detail: JSON.stringify(bounded.notices),
    });
    checks.push({
      name: "…and the interpreter answers the next line normally",
      pass: bounded.stillAlive === "'still here'",
      detail: JSON.stringify(bounded.stillAlive),
    });

    const parsed = figures ? JSON.parse(figures) : null;
    if (!parsed) {
      checks.push({
        name: "the figure-lifecycle probe produced a result",
        pass: false,
        detail: JSON.stringify({ stdout: figures }),
      });
    }

    if (parsed) {
      checks.push({
        name: "a figure that was never shown is not rendered",
        pass: parsed.unshownRendered === 0,
        detail: JSON.stringify(parsed),
      });
      checks.push({
        name: "…and is still open afterwards, so the next command can keep drawing into it",
        pass: Array.isArray(parsed.stillOpen) && parsed.stillOpen.length === 1,
        detail: JSON.stringify(parsed),
      });
      checks.push({
        name: "plt.show() marks the figure, and it is rendered once and closed",
        pass:
          parsed.shownRendered === 1 &&
          parsed.shownMime === "image/png" &&
          parsed.openAtEnd.length === 0,
        detail: JSON.stringify(parsed),
      });
      checks.push({
        name: "a marked figure closed by hand before collection is skipped, not an error",
        pass: parsed.afterPartial === 1,
        detail: JSON.stringify(parsed),
      });
    }

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("rich output pipeline", result));
