/**
 * What the terminal DRAWS stays in register with what the editor holds.
 */
import process from "node:process";
import { IMPORT_MAP, fakeApi, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%} #app{height:100vh}
::selection { background: rgba(0, 121, 107, 0.3); color: #e9eef3; }</style></head><body><div id="app"></div>
${fakeApi({
  rows: [{ file: "/archive/tas.nc", fs_type: "posix" }],
  facets: { project: ["cmip6", 12, "cordex", 4], variable: ["tas", 9, "pr", 3] },
})}
<script type="module">
  const { mountDataBrowser } = await import("@freva-org/databrowser");
  window.__handle = mountDataBrowser(document.getElementById("app"), { syncUrl: false });
  await new Promise(r => setTimeout(r, 600));
  document.querySelector('[aria-label="Command terminal"]').click();
  await new Promise(r => setTimeout(r, 350));
  window.__ready = true;
</script></body></html>`;

/** Put the caret at `at` in the python textarea, and let the highlight repaint. */
const CARET = async (at) => {
  const ta = document.querySelector('.freva-term .term-view[data-cmd="py"] textarea');
  ta.focus();
  ta.setSelectionRange(at, at);
  ta.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
};

/** Where column 0 of each line of the highlight is drawn: one x per line. */
const COLUMN_ZERO = () => {
  const hl = document.querySelector('.freva-term .term-view[data-cmd="py"] pre');
  const walker = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
  const xs = [];
  let atLineStart = true;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "\n") {
        atLineStart = true;
        continue;
      }
      if (atLineStart) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        xs.push(Math.round(range.getBoundingClientRect().left * 100) / 100);
        atLineStart = false;
      }
    }
  }
  return xs;
};

/**
 * Where the DRAWN cursor is, against where the caret really is. Python (a textarea under a
 * highlight): the highlight's text before its cursor, against the buffer before the caret. Shell
 * (the editable line itself): the block's left edge, against the caret's own client rect.
 */
const DRAWN = (tab) => {
  const view = document.querySelector(`.freva-term .term-view[data-cmd="${tab}"]`);
  const editor = view.querySelector(".te-editor");
  if (editor.dataset.mode === "plain") {
    const ta = editor.querySelector("textarea");
    const hl = editor.querySelector("pre");
    const caret = hl.querySelector(".te-caret");
    const range = document.createRange();
    range.selectNodeContents(hl);
    range.setEndBefore(caret);
    return {
      drawn: range.toString().length,
      real: ta.selectionStart,
      agree: range.toString() === ta.value.slice(0, ta.selectionStart),
    };
  }
  const cmd = editor.querySelector(".te-cmd");
  const block = editor.querySelector(".te-flow > .te-caret");
  const sel = getSelection();
  const at = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect().left : NaN;
  const drawn = block.getBoundingClientRect().left;
  return {
    drawn: Math.round(drawn * 100) / 100,
    real: Math.round(at * 100) / 100,
    agree: Math.abs(drawn - at) < 1 && cmd.contains(sel.anchorNode),
  };
};

const result = await inChromium(async (browser) => {
  const server = await serve(page);
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail: JSON.stringify(detail) });
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    await browser.click('.freva-term .cmd-tab[data-cmd="py"]');
    await browser.waitForTimeout(250);
    await browser.click('.freva-term .term-view[data-cmd="py"] textarea');
    await browser.keyboard.type('variable=["tas","pr"],', { delay: 5 });
    await browser.keyboard.press("Escape");
    await browser.keyboard.press("Enter");
    await browser.keyboard.type("time_frequency='mon',", { delay: 5 });
    await browser.keyboard.press("Escape");

    // Selected glyphs stay transparent, whatever colour the host gives a selection.
    const selection = await browser.evaluate(() => {
      const ta = document.querySelector('.freva-term .term-view[data-cmd="py"] textarea');
      ta.setSelectionRange(0, ta.value.length);
      return {
        host: getComputedStyle(document.body, "::selection").color,
        textarea: getComputedStyle(ta, "::selection").color,
        background: getComputedStyle(ta, "::selection").backgroundColor,
      };
    });
    push(
      "a host's selection colour does not reveal the textarea's own text",
      selection.textarea === "rgba(0, 0, 0, 0)" && selection.host === "rgb(233, 238, 243)",
      selection,
    );
    push(
      "…and the host's selection background still shows",
      selection.background === "rgba(0, 121, 107, 0.3)",
      selection,
    );

    const second = await browser.evaluate(
      () =>
        document
          .querySelector('.freva-term .term-view[data-cmd="py"] textarea')
          .value.indexOf("\n") + 1,
    );
    await browser.evaluate(CARET, second);
    const withCursor = await browser.evaluate(COLUMN_ZERO);
    const end = await browser.evaluate(
      () => document.querySelector('.freva-term .term-view[data-cmd="py"] textarea').value.length,
    );
    await browser.evaluate(CARET, end);
    const withoutCursor = await browser.evaluate(COLUMN_ZERO);
    push(
      "the block cursor overlays its cell instead of pushing the line right",
      withCursor.length === 2 &&
        withCursor[0] === withCursor[1] &&
        withCursor[1] === withoutCursor[1],
      { withCursor, withoutCursor },
    );

    // A click lands where it is drawn: on the cursor's line, the glyph under the pointer.
    await browser.evaluate(CARET, second);
    const target = await browser.evaluate((at) => {
      const hl = document.querySelector('.freva-term .term-view[data-cmd="py"] pre');
      const caret = hl.querySelector(".te-caret");
      // The fourth glyph after the cursor: "e" of "time_frequency".
      const node = caret.nextSibling.firstChild ?? caret.nextSibling;
      const range = document.createRange();
      range.setStart(node, 3);
      range.setEnd(node, 4);
      const box = range.getBoundingClientRect();
      return { x: box.left + 1, y: box.top + box.height / 2, expected: at + 3 };
    }, second);
    await browser.mouse.click(target.x, target.y);
    const landed = await browser.evaluate(
      () => document.querySelector('.freva-term .term-view[data-cmd="py"] textarea').selectionStart,
    );
    push("a click on the cursor's line lands on the glyph under it", landed === target.expected, {
      ...target,
      landed,
    });

    // A suggestion right after the cursor still starts after the block, not under it.
    await browser.evaluate(CARET, end);
    await browser.keyboard.press("Enter");
    await browser.keyboard.type("proj", { delay: 8 });
    await browser.waitForTimeout(250);
    const ghost = await browser.evaluate(() => {
      const hl = document.querySelector('.freva-term .term-view[data-cmd="py"] pre');
      const caret = hl.querySelector(".te-caret");
      const g = hl.querySelector(".te-ghost");
      if (!caret || !g) return { caret: !!caret, ghost: !!g };
      const range = document.createRange();
      range.setStart(g.firstChild, 0);
      range.setEnd(g.firstChild, 1);
      return {
        caretRight: caret.getBoundingClientRect().right,
        ghostText: range.getBoundingClientRect().left,
        adjacent: caret.nextElementSibling === g,
      };
    });
    push(
      "a suggestion after the cursor begins after the block, not under it",
      ghost.adjacent === true && ghost.ghostText >= ghost.caretRight - 0.5,
      ghost,
    );

    const WORD = process.platform === "darwin" ? "Alt" : "Control";
    const hold = async (tab, keys, times) => {
      const start = (await browser.evaluate(DRAWN, tab)).real;
      for (const key of keys.slice(0, -1)) await browser.keyboard.down(key);
      const arrow = keys.at(-1);
      const seen = [];
      for (let i = 0; i < times; i += 1) {
        await browser.keyboard.down(arrow); // a repeat: keydown again, no keyup
        await browser.waitForTimeout(40);
        seen.push(await browser.evaluate(DRAWN, tab));
      }
      await browser.keyboard.up(arrow);
      for (const key of keys.slice(0, -1).reverse()) await browser.keyboard.up(key);
      // Every repeat drawn where the caret is, and the caret moved BEFORE the key came up.
      return { ok: seen.every((x) => x.agree) && seen[0].real !== start, start, seen };
    };
    await browser.keyboard.press("Escape");
    await browser.evaluate(CARET, end);
    for (const keys of [["ArrowLeft"], [WORD, "ArrowLeft"], ["ArrowUp"]]) {
      const held = await hold("py", keys, 3);
      push(
        `python: holding ${keys.join("+")} moves the drawn cursor on every repeat`,
        held.ok,
        held,
      );
      await browser.evaluate(CARET, end);
    }

    await browser.click('.freva-term .cmd-tab[data-cmd="cli"]');
    await browser.waitForTimeout(250);
    await browser.evaluate(() => {
      const editor = document.querySelector('.freva-term .term-view[data-cmd="cli"] .te-editor');
      (editor.dataset.mode === "rich"
        ? editor.querySelector(".te-cmd")
        : editor.querySelector("textarea")
      ).focus();
    });
    await browser.keyboard.type(" --flavour cmip6 variable=tas", { delay: 5 });
    await browser.keyboard.press("Escape");
    await browser.keyboard.press("End");
    for (const keys of [["ArrowLeft"], [WORD, "ArrowLeft"]]) {
      const held = await hold("cli", keys, 3);
      push(
        `shell: holding ${keys.join("+")} moves the drawn cursor on every repeat`,
        held.ok,
        held,
      );
      await browser.keyboard.press("End");
    }
  } finally {
    await server.close();
  }
  return checks;
});

process.exit(
  report("terminal: the drawn cursor and text stay in register with the real ones", result),
);
