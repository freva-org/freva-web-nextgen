/**
 * Shell line wrapping, measured on the terminal mounted through `mountDataBrowser` with a
 * databrowser flavour and base scope, so it is an integration test, not a terminal-package test.
 *
 * The prefix (prompt, command, --flavour, base scope) and the editable command are inline siblings
 * in one `pre-wrap` flow. At every width the command must begin immediately after the last prefix
 * token, and each continuation must start at the container's left edge. A `text-indent` on the
 * input cannot do this: an indent shifts only the FIRST line, so once the prefix wraps the painted
 * prompt and the typed text disagree. The window narrows until the prefix occupies one, two, three
 * and four visual lines.
 */
import { IMPORT_MAP, fakeApi, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%} #app{height:100vh}</style></head><body><div id="app"></div>
${fakeApi({
  rows: [{ file: "/archive/tas.nc", fs_type: "posix" }],
  facets: { project: ["cmip6", 1] },
})}
<script type="module">
  const { mountDataBrowser } = await import("@freva-org/databrowser");
  // A flavour and a base scope make the read-only prefix long enough to wrap at realistic widths.
  window.__handle = mountDataBrowser(document.getElementById("app"), {
    syncUrl: false, flavour: "cmip6", baseFilters: { project: "waterpark" },
  });
  await new Promise(r => setTimeout(r, 500));
  document.querySelector('[aria-label="Command terminal"]').click();
  await new Promise(r => setTimeout(r, 250));
  window.__ready = true;
</script></body></html>`;

const result = await inChromium(async (browser) => {
  const server = await serve(page);
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    // TYPE the command, do not assign it. Assigning `textContent` produces no `input` event, so
    // nothing downstream runs - no commit, no completion, no repaint - and the geometry being
    // measured is not the geometry a user ever sees. The text is entered once through the real
    // keyboard and then only the WIDTH changes between measurements.
    const typeCommand = async (text) => {
      await browser.evaluate(async () => {
        const term = document.querySelector(".freva-term");
        const editor = term.querySelector('.term-view[data-cmd="cli"] .te-editor');
        const node =
          editor.dataset.mode === "rich"
            ? editor.querySelector(".te-cmd")
            : editor.querySelector("textarea");
        node.focus();
        if (editor.dataset.mode === "rich") {
          const r = document.createRange();
          r.selectNodeContents(node);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        } else {
          node.select();
        }
        await new Promise((x) => setTimeout(x, 40));
      });
      await browser.keyboard.press("Backspace");
      await browser.keyboard.type(text, { delay: 4 });
      await browser.evaluate(() => new Promise((r) => setTimeout(r, 150)));
    };

    const measure = async (width) =>
      browser.evaluate(async (w) => {
        const term = document.querySelector(".freva-term");
        term.style.right = "auto";
        term.style.left = "8px";
        term.style.width = Math.max(w + 40, 360) + "px"; // the window has its own minimum
        // Constrain the EDIT REGION itself: the window cannot shrink past its own min-width, but the
        // line flow inside it must keep its promise at every width the text is given.
        const edit = term.querySelector(".term-edit");
        edit.style.width = w + "px";
        // The rich (contenteditable) mode is what a real browser uses; make sure we are measuring it.
        const flow = term.querySelector(".te-flow");
        const cmd = flow.querySelector(".te-cmd");
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const prefix = flow.querySelector(".cli-prefix");
        const flowLeft = flow.getBoundingClientRect().left;
        const lines = (el) => {
          const byTop = new Map();
          for (const r of el.getClientRects()) {
            const key = Math.round(r.top);
            const cur = byTop.get(key);
            if (!cur || r.left < cur.left) byTop.set(key, { left: r.left, top: r.top });
          }
          return [...byTop.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
        };
        const pl = lines(prefix);
        const cl = lines(cmd);
        return {
          mode: term.querySelector('.term-view[data-cmd="cli"] .te-editor').dataset.mode,
          // What is actually in the buffer at the moment of measurement - so a check that measures
          // an empty line cannot pass by accident.
          typed: cmd.textContent ?? "",
          prefixLines: pl.length,
          commandLines: cl.length,
          onLastPrefixLine:
            cl.length > 0 && Math.round(cl[0].top) === Math.round(pl[pl.length - 1].top),
          startsAfterPrefix: cl.length > 0 && cl[0].left > flowLeft + 1,
          // When the command does NOT share the prefix's last line it must begin at column 0 -
          // an indent there is precisely the defect.
          startsAtLeftEdge: cl.length > 0 && Math.abs(cl[0].left - flowLeft) <= 1,
          continuationsAtLeftEdge: cl.slice(1).every((r) => Math.abs(r.left - flowLeft) <= 1),
        };
      }, width);

    await typeCommand("project=cmip6 variable=tas");

    // Sweep widths and keep the first that produces each prefix line count.
    const found = new Map();
    for (let w = 900; w >= 90; w -= 4) {
      const m = await measure(w);
      if (m.prefixLines >= 1 && m.prefixLines <= 4 && !found.has(m.prefixLines)) {
        found.set(m.prefixLines, { ...m, width: w });
      }
      if (found.size === 4) break;
    }

    const checks = [];
    const first = found.get(1) ?? found.values().next().value;
    checks.push({
      name: "the rich contenteditable flow is what a real browser mounts",
      pass: first?.mode === "rich",
      detail: `mode=${first?.mode}`,
    });
    checks.push({
      name: "the measured line was TYPED through the real input, not assigned",
      pass: [...found.values()].every((m) => m.typed === "project=cmip6 variable=tas"),
      detail: JSON.stringify([...found.values()].map((m) => m.typed)),
    });
    for (const n of [1, 2, 3, 4]) {
      const m = found.get(n);
      if (!m) {
        checks.push({
          name: `${n}-line prefix reachable`,
          pass: false,
          detail: "no width produced it",
        });
        continue;
      }
      // Exactly the rule wrapPlan() encodes: the command continues on the prefix's last line when
      // its first word fits there, and otherwise drops to the next line at column 0. What it must
      // NEVER do is start at an indent, or overlap the painted prompt.
      const continued = m.onLastPrefixLine && m.startsAfterPrefix;
      const droppedCleanly = !m.onLastPrefixLine && m.startsAtLeftEdge;
      checks.push({
        name: `${n}-line prefix (@${m.width}px): command ${continued ? "continues the prompt line" : "drops to column 0"}`,
        pass: continued || droppedCleanly,
        detail: `onLastPrefixLine=${m.onLastPrefixLine} startsAfterPrefix=${m.startsAfterPrefix} startsAtLeftEdge=${m.startsAtLeftEdge}`,
      });
      checks.push({
        name: `${n}-line prefix (@${m.width}px): continuations start at the left edge`,
        pass: m.continuationsAtLeftEdge,
        detail: `commandLines=${m.commandLines}`,
      });
    }
    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("terminal wrapping (mounted, 1-4 line prefixes)", result));
