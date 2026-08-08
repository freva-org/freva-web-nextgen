/**
 * The terminal typed into for real: mounted through `mountDataBrowser` and asserted against
 * databrowser facets and selection, so it is an integration test, not a terminal-package test.
 *
 * The jsdom suite drives `.te-input`, the textarea fallback, because jsdom has no
 * `contenteditable="plaintext-only"`; a real browser gets `.te-cmd`, so the two suites exercise
 * different editors. Assigning `cmd.textContent` is also not typing: it fires no `input` event, so
 * no completion, no ghost, no commit. Everything here goes through `page.keyboard` and asserts the
 * authoritative buffer - `handle.getState()` / the committed selection - not whatever is painted.
 */
import { IMPORT_MAP, fakeApi, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%} #app{height:100vh}</style></head><body><div id="app"></div>
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

/** Everything a check needs to know about the currently active editor surface. */
const SURFACE = (tabId) => {
  const term = document.querySelector(".freva-term");
  const view = term.querySelector(`.term-view[data-cmd="${tabId}"]`);
  const editor = view.querySelector(".te-editor");
  const mode = editor.dataset.mode;
  const node = mode === "rich" ? editor.querySelector(".te-cmd") : editor.querySelector("textarea");
  const r = node.getBoundingClientRect();
  const cs = getComputedStyle(node);
  const hit = document.elementFromPoint(
    Math.round(r.left + Math.min(r.width / 2, 30)),
    Math.round(r.top + r.height / 2),
  );
  return {
    mode,
    tag: node.tagName,
    // "In the document" is not "usable". Visible means it has a box; hit-testable means a click
    // lands on it; focusable means focus actually moves there.
    w: Math.round(r.width),
    h: Math.round(r.height),
    display: cs.display,
    visibility: cs.visibility,
    offsetParentNull: node.offsetParent === null && cs.position !== "fixed",
    hitIsInput: !!hit && (hit === node || node.contains(hit)),
    hitTag: hit ? hit.className || hit.tagName : null,
  };
};

/** The command buffer as the EDITOR sees it - never as the screen renders it. */
const BUFFER = (tabId) => {
  const term = document.querySelector(".freva-term");
  const view = term.querySelector(`.term-view[data-cmd="${tabId}"]`);
  const editor = view.querySelector(".te-editor");
  const rich = editor.dataset.mode === "rich";
  const node = rich ? editor.querySelector(".te-cmd") : editor.querySelector("textarea");
  const ghostNodes = [...editor.querySelectorAll(".te-ghost")];
  return {
    value: rich ? (node.textContent ?? "") : node.value,
    // A ghost that is a DESCENDANT of the editable node is the defect, by definition.
    ghostInsideEditable: ghostNodes.some((g) => rich && node.contains(g)),
    ghostText: ghostNodes.map((g) => g.textContent).join(""),
    caret: rich ? null : node.selectionStart,
  };
};

const result = await inChromium(async (browser) => {
  const server = await serve(page);
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail: JSON.stringify(detail) });
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    const openTab = async (id) => {
      await browser.evaluate(async (tab) => {
        const term = document.querySelector(".freva-term");
        const chip = term.querySelector(`.cmd-tab[data-cmd="${tab}"]`);
        chip?.click();
        await new Promise((r) => setTimeout(r, 250));
      }, id);
    };
    const clearBuffer = async (id) =>
      browser.evaluate(async (tab) => {
        const term = document.querySelector(".freva-term");
        const editor = term.querySelector(`.term-view[data-cmd="${tab}"] .te-editor`);
        const rich = editor.dataset.mode === "rich";
        const node = rich ? editor.querySelector(".te-cmd") : editor.querySelector("textarea");
        node.focus();
        if (rich) {
          const sel = getSelection();
          const range = document.createRange();
          range.selectNodeContents(node);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          node.select();
        }
        await new Promise((r) => setTimeout(r, 30));
      }, id);
    const focusInput = async (id) =>
      browser.evaluate(async (tab) => {
        const term = document.querySelector(".freva-term");
        const editor = term.querySelector(`.term-view[data-cmd="${tab}"] .te-editor`);
        const rich = editor.dataset.mode === "rich";
        (rich ? editor.querySelector(".te-cmd") : editor.querySelector("textarea")).focus();
        await new Promise((r) => setTimeout(r, 60));
      }, id);

    // 1. Both editors are USABLE, not merely present
    const shell = await browser.evaluate(SURFACE, "cli");
    push(
      "shell: the active surface is visible, hit-testable and has a real box",
      shell.w > 0 &&
        shell.h > 0 &&
        shell.display !== "none" &&
        shell.visibility !== "hidden" &&
        !shell.offsetParentNull &&
        shell.hitIsInput,
      shell,
    );

    await openTab("py");
    const py = await browser.evaluate(SURFACE, "py");
    push(
      "python: its textarea is VISIBLE, hit-testable and focusable - not just in the document",
      py.mode === "plain" &&
        py.tag === "TEXTAREA" &&
        py.w > 0 &&
        py.h > 0 &&
        py.display !== "none" &&
        py.visibility !== "hidden" &&
        !py.offsetParentNull &&
        py.hitIsInput,
      py,
    );
    const pyFocus = await browser.evaluate(async () => {
      const term = document.querySelector(".freva-term");
      const ta = term.querySelector('.term-view[data-cmd="py"] textarea');
      const r = ta.getBoundingClientRect();
      ta.focus();
      await new Promise((x) => setTimeout(x, 60));
      return { focused: document.activeElement === ta, box: { w: r.width, h: r.height } };
    });
    push("python: focus really lands in the textarea", pyFocus.focused === true, pyFocus);

    // …and the FALLBACK shell (the narrow / forced-plain path) is equally usable. This is the
    // surface the jsdom suite drives, so it must be reachable and real in a browser too.
    await browser.evaluate(async () => {
      document.querySelector(".freva-db").dataset.terminalFallback = "true";
      window.dispatchEvent(new Event("resize"));
      await new Promise((r) => setTimeout(r, 300));
    });
    await openTab("cli");
    const fb = await browser.evaluate(SURFACE, "cli");
    push(
      "shell in fallback: the textarea is visible, hit-testable and focusable",
      fb.mode === "plain" &&
        fb.tag === "TEXTAREA" &&
        fb.w > 0 &&
        fb.h > 0 &&
        !fb.offsetParentNull &&
        fb.hitIsInput,
      fb,
    );
    await browser.evaluate(async () => {
      delete document.querySelector(".freva-db").dataset.terminalFallback;
      window.dispatchEvent(new Event("resize"));
      await new Promise((r) => setTimeout(r, 300));
    });

    // 2. Typing a shell command, character by character
    await openTab("cli");
    await clearBuffer("cli");
    await browser.keyboard.press("Backspace");
    const word = "variable=tas";
    const trace = [];
    for (const ch of word) {
      await browser.keyboard.type(ch, { delay: 12 });
      const b = await browser.evaluate(BUFFER, "cli");
      trace.push(b.value);
    }
    const expected = word.split("").map((_, i) => word.slice(0, i + 1));
    push(
      "shell: the buffer matches the typed text after EVERY character",
      JSON.stringify(trace) === JSON.stringify(expected),
      { got: trace, want: expected },
    );

    // 3. THE GHOST IS NOT PART OF THE COMMAND
    await clearBuffer("cli");
    await browser.keyboard.type("proj", { delay: 20 });
    await browser.evaluate(() => new Promise((r) => setTimeout(r, 220)));
    const ghosted = await browser.evaluate(BUFFER, "cli");
    push(
      "shell: a suggestion appears, and it is NOT inside the editable node nor in the buffer",
      ghosted.value === "proj" && ghosted.ghostText.length > 0 && !ghosted.ghostInsideEditable,
      ghosted,
    );

    // …and the next ordinary keystroke must not absorb it.
    await browser.keyboard.type("e", { delay: 20 });
    await browser.evaluate(() => new Promise((r) => setTimeout(r, 220)));
    const afterMore = await browser.evaluate(BUFFER, "cli");
    push(
      "shell: typing on WITHOUT accepting leaves the suggestion out of the command",
      afterMore.value === "proje" && !afterMore.ghostInsideEditable,
      afterMore,
    );

    // Blur must not commit a ghost either - a retained draft is the buffer, not the screen.
    const afterBlur = await browser.evaluate(async () => {
      const term = document.querySelector(".freva-term");
      const editor = term.querySelector('.term-view[data-cmd="cli"] .te-editor');
      const node =
        editor.dataset.mode === "rich"
          ? editor.querySelector(".te-cmd")
          : editor.querySelector("textarea");
      node.blur();
      await new Promise((r) => setTimeout(r, 250));
      return (editor.dataset.mode === "rich" ? node.textContent : node.value) ?? "";
    });
    push(
      "shell: an unaccepted suggestion survives neither blur nor repaint",
      afterBlur === "proje",
      {
        afterBlur,
      },
    );

    // 4. Accepting the suggestion, with Tab and with ArrowRight
    for (const [key, label] of [
      ["Tab", "Tab"],
      ["ArrowRight", "ArrowRight"],
    ]) {
      await focusInput("cli");
      await clearBuffer("cli");
      await browser.keyboard.type("proj", { delay: 20 });
      await browser.evaluate(() => new Promise((r) => setTimeout(r, 250)));
      const before = await browser.evaluate(BUFFER, "cli");
      await browser.keyboard.press(key);
      await browser.evaluate(() => new Promise((r) => setTimeout(r, 250)));
      const after = await browser.evaluate(BUFFER, "cli");
      // Accepting a KEY writes `key=` - ready for its value. The point of the check is that the
      // accepted text is the suggestion, in full, and that nothing else rode in with it.
      push(
        `shell: ${label} accepts the suggestion and writes exactly it into the buffer`,
        before.value === "proj" &&
          before.ghostText === "ect" &&
          after.value === "project=" &&
          !after.ghostInsideEditable,
        { key: label, before, after },
      );
    }

    // 5. Caret, mid-line editing, selection replacement, paste, deletion, composition
    await focusInput("cli");
    await clearBuffer("cli");
    await browser.keyboard.type("project=cmip6", { delay: 10 });
    // Walk the caret back over "cmip6" and insert in the middle.
    for (let i = 0; i < 5; i++) await browser.keyboard.press("ArrowLeft");
    await browser.keyboard.type("X", { delay: 10 });
    const midEdit = await browser.evaluate(BUFFER, "cli");
    push(
      "shell: ArrowLeft moves the caret and typing inserts THERE, not at the end",
      midEdit.value === "project=Xcmip6",
      midEdit,
    );

    // Backspace at the caret removes the character just typed, not the last one in the buffer.
    await browser.keyboard.press("Backspace");
    const afterBs = await browser.evaluate(BUFFER, "cli");
    push("shell: Backspace deletes at the caret", afterBs.value === "project=cmip6", afterBs);

    // Selection replacement: select the whole buffer and type over it.
    await clearBuffer("cli");
    await browser.keyboard.type("variable=pr", { delay: 10 });
    const replaced = await browser.evaluate(BUFFER, "cli");
    push(
      "shell: selecting everything and typing REPLACES it",
      replaced.value === "variable=pr",
      replaced,
    );

    // A selection must also survive the highlight repaint that every keystroke triggers.
    const selHeld = await browser.evaluate(async () => {
      const term = document.querySelector(".freva-term");
      const editor = term.querySelector('.term-view[data-cmd="cli"] .te-editor');
      const rich = editor.dataset.mode === "rich";
      const node = rich ? editor.querySelector(".te-cmd") : editor.querySelector("textarea");
      node.focus();
      if (rich) {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const t = walker.nextNode();
        const range = document.createRange();
        range.setStart(t, 0);
        range.setEnd(t, Math.min(8, t.data.length));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        node.setSelectionRange(0, 8);
      }
      // Force a repaint the way a caret move does.
      node.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      if (rich) {
        const s = getSelection();
        return { text: s.toString(), collapsed: s.isCollapsed };
      }
      return {
        text: node.value.slice(node.selectionStart, node.selectionEnd),
        collapsed: node.selectionStart === node.selectionEnd,
      };
    });
    push(
      "shell: a non-collapsed selection survives the highlight repaint",
      selHeld.collapsed === false && selHeld.text === "variable",
      selHeld,
    );

    // Paste: a clipboard payload lands as plain text at the caret, newlines flattened on a
    // single-line buffer, and no markup ever enters the editable node.
    await clearBuffer("cli");
    const pasted = await browser.evaluate(async () => {
      const term = document.querySelector(".freva-term");
      const editor = term.querySelector('.term-view[data-cmd="cli"] .te-editor');
      const rich = editor.dataset.mode === "rich";
      const node = rich ? editor.querySelector(".te-cmd") : editor.querySelector("textarea");
      node.focus();
      if (rich) {
        const dt = new DataTransfer();
        dt.setData("text/plain", "project=cmip6\nvariable=tas");
        dt.setData("text/html", "<b>project=cmip6</b>");
        node.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      } else {
        node.value = "project=cmip6 variable=tas";
        node.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 250));
      return {
        value: (rich ? node.textContent : node.value) ?? "",
        hasMarkup: rich ? node.querySelector("b") !== null : false,
      };
    });
    push(
      "shell: a paste inserts PLAIN text, flattens newlines, and smuggles no markup",
      pasted.value === "project=cmip6 variable=tas" && pasted.hasMarkup === false,
      pasted,
    );

    // Composition. Two things have to hold, and neither is visible from the painted text alone:
    // the editable DOM must not be rebuilt under a live IME (a rebuild is what drops or duplicates
    // the characters being composed), and half-composed text must not be COMMITTED - `project=cmip`
    // is a valid-looking filter that the user has not finished typing.
    await clearBuffer("cli");
    await browser.keyboard.press("Backspace");
    const comp = await browser.evaluate(async () => {
      const term = document.querySelector(".freva-term");
      const editor = term.querySelector('.term-view[data-cmd="cli"] .te-editor');
      const rich = editor.dataset.mode === "rich";
      const node = rich ? editor.querySelector(".te-cmd") : editor.querySelector("textarea");
      node.focus();
      const write = (t) => {
        if (rich) node.textContent = t;
        else node.value = t;
      };
      const read = () => (rich ? (node.textContent ?? "") : node.value);
      const frame = (data) => {
        node.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data }));
        node.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
      };
      window.__handle.setState?.({ selected: {} });
      await new Promise((r) => setTimeout(r, 200));

      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      write("project=cmip");
      // A marker on the live text node: if anything repaints, `replaceChildren` throws this node
      // away and the marker goes with it. That is the rebuild the IME cannot survive.
      const first = rich ? node.firstChild : null;
      if (first) first.__composeMark = 1;
      frame("project=cmip");
      await new Promise((r) => setTimeout(r, 120));
      frame("project=cmip");
      await new Promise((r) => setTimeout(r, 120));

      const during = read();
      const nodeSurvived = rich ? (node.firstChild?.__composeMark ?? 0) === 1 : true;
      const committedDuring = { ...window.__handle.getState().selected };

      write("project=cmip6");
      node.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "project=cmip6" }),
      );
      node.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
      const after = read();
      // Blur completes the in-progress token: a keystroke never commits the token under the
      // caret, so this is where the settled text lands.
      node.blur();
      await new Promise((r) => setTimeout(r, 400));
      return {
        during,
        nodeSurvived,
        committedDuring,
        after,
        committedAfter: { ...window.__handle.getState().selected },
      };
    });
    push(
      "shell: an IME composition is not rebuilt and not committed until it ends",
      comp.during === "project=cmip" &&
        comp.nodeSurvived === true &&
        Object.keys(comp.committedDuring).length === 0 &&
        comp.after === "project=cmip6" &&
        (comp.committedAfter.project ?? []).includes("cmip6"),
      comp,
    );

    // 6. Python: multiline kwargs, a non-final line, and the ghost AT that caret
    await openTab("py");
    await clearBuffer("py");
    await browser.keyboard.press("Backspace");
    // Line 1 is left HALF-TYPED on purpose: it is the line the caret comes back to in the next
    // check, and a suggestion only exists while a word is incomplete.
    await browser.keyboard.type("proj", { delay: 8 });
    await browser.keyboard.press("Enter");
    await browser.keyboard.type("variable=tas,", { delay: 8 });
    const pyBuf = await browser.evaluate(BUFFER, "py");
    push(
      "python: Enter makes a real second line and both lines are in the buffer",
      pyBuf.value === "proj\nvariable=tas," && pyBuf.value.split("\n").length === 2,
      pyBuf,
    );

    // Move the caret back into the FIRST line, mid-word, and check the ghost is drawn there -
    // not several lines below, after the whole buffer.
    const pyGhost = await browser.evaluate(async () => {
      const term = document.querySelector(".freva-term");
      const view = term.querySelector('.term-view[data-cmd="py"]');
      const ta = view.querySelector("textarea");
      ta.focus();
      ta.setSelectionRange(4, 4); // end of the half-typed "proj" on line 1
      ta.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const hl = view.querySelector("pre");
      const ghost = hl.querySelector(".te-ghost");
      const caret = hl.querySelector(".te-caret");
      const textBeforeGhost = ghost
        ? (() => {
            const range = document.createRange();
            range.selectNodeContents(hl);
            range.setEnd(ghost, 0);
            return range.toString();
          })()
        : null;
      return {
        value: ta.value,
        caret: ta.selectionStart,
        hasGhost: !!ghost,
        ghostText: ghost ? ghost.textContent : null,
        // The ghost's own position in the overlay's text flow: it must be AT the caret (4), not at
        // the end of the whole multi-line buffer.
        ghostOffset: textBeforeGhost === null ? -1 : textBeforeGhost.length,
        caretBeforeGhost: !!ghost && !!caret && (caret.compareDocumentPosition(ghost) & 4) === 4,
        bufferLength: ta.value.length,
      };
    });
    push(
      "python: the suggestion is drawn AT THE CARET on a non-final line, not after the buffer",
      pyGhost.hasGhost &&
        pyGhost.ghostOffset === pyGhost.caret &&
        pyGhost.ghostOffset !== pyGhost.bufferLength &&
        pyGhost.caretBeforeGhost,
      pyGhost,
    );

    // Committing a COMPLETE python buffer reaches the host state.
    await browser.evaluate(async () => {
      const ta = document.querySelector('.freva-term .term-view[data-cmd="py"] textarea');
      ta.focus();
      ta.select();
      await new Promise((r) => setTimeout(r, 40));
    });
    await browser.keyboard.type("project=cmip6,", { delay: 8 });
    await browser.keyboard.press("Enter");
    await browser.keyboard.type("variable=tas,", { delay: 8 });
    const pyCommit = await browser.evaluate(async () => {
      const term = document.querySelector(".freva-term");
      const ta = term.querySelector('.term-view[data-cmd="py"] textarea');
      const text = ta.value;
      ta.blur();
      await new Promise((r) => setTimeout(r, 400));
      const s = window.__handle.getState();
      return { text, selected: s.selected };
    });
    push(
      "python: the committed kwargs reach the host's selection",
      (pyCommit.selected?.project ?? []).includes("cmip6") &&
        (pyCommit.selected?.variable ?? []).includes("tas"),
      pyCommit,
    );

    // 7. THE BLOCK CURSOR - a terminal's cursor, in the rich editor a browser actually mounts
    //
    // Both surfaces draw a blinking block and hide the native caret: `caret-color` must be
    // transparent, and the painted block must sit AT the caret while focused rather than parked
    // after the command and shown only while unfocused. jsdom cannot see any of this: it has no
    // layout, so a selector count there proves a node exists and nothing about where it is.
    await openTab("cli");
    await focusInput("cli");
    await clearBuffer("cli");
    await browser.keyboard.press("Backspace");
    await browser.keyboard.type("project=cmip6 variable=tas", { delay: 6 });
    await browser.evaluate(() => new Promise((r) => setTimeout(r, 200)));

    /** Measure the cursor with the caret at `at`, or unfocused when `at` is null. */
    const CURSOR = async (at) => {
      const term = document.querySelector(".freva-term");
      const editor = term.querySelector('.term-view[data-cmd="cli"] .te-editor');
      const flow = editor.querySelector(".te-flow");
      const cmd = flow.querySelector(".te-cmd");
      const put = (n) => {
        const walk = document.createTreeWalker(cmd, NodeFilter.SHOW_TEXT);
        let left = n;
        let node = null;
        while (walk.nextNode()) {
          const t = walk.currentNode;
          if (left <= t.data.length) {
            node = t;
            break;
          }
          left -= t.data.length;
        }
        const r = document.createRange();
        if (node) r.setStart(node, Math.min(left, node.data.length));
        else {
          r.selectNodeContents(cmd);
          r.collapse(false);
        }
        r.collapse(true);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      };
      if (at === null) cmd.blur();
      else {
        cmd.focus();
        put(at);
        cmd.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 220));

      const carets = [...editor.querySelectorAll(".te-caret")].filter((c) => {
        const cs = getComputedStyle(c);
        const b = c.getBoundingClientRect();
        return cs.display !== "none" && cs.visibility !== "hidden" && b.width > 0 && b.height > 0;
      });
      const c = carets[0];
      const cb = c ? c.getBoundingClientRect() : null;
      // Where the browser itself thinks the caret is, measured independently of our block.
      let want = null;
      if (at !== null) {
        const s = getSelection();
        if (s.rangeCount) {
          const r = s.getRangeAt(0).getBoundingClientRect();
          want = { left: r.left, top: r.top, height: r.height };
        }
      }
      const cs = c ? getComputedStyle(c) : null;
      return {
        caretColor: getComputedStyle(cmd).caretColor,
        visibleCursors: carets.length,
        box: cb ? { left: cb.left, top: cb.top, w: cb.width, h: cb.height } : null,
        want,
        blockish: cb ? cb.width >= 4 : false,
        animated: cs ? cs.animationName : null,
        // Focused = solid fill; unfocused = the hollow parked box.
        filled: cs ? cs.backgroundColor !== "rgba(0, 0, 0, 0)" : null,
        boxShadow: cs ? cs.boxShadow : null,
      };
    };

    const nativeHidden = await browser.evaluate(CURSOR, 0);
    push(
      "bash cursor: the browser's native caret is hidden and exactly ONE block is drawn",
      nativeHidden.caretColor === "rgba(0, 0, 0, 0)" &&
        nativeHidden.visibleCursors === 1 &&
        nativeHidden.blockish,
      nativeHidden,
    );

    const positions = { start: 0, middle: 8, end: 25 };
    const measured = {};
    for (const [label, at] of Object.entries(positions)) {
      measured[label] = await browser.evaluate(CURSOR, at);
    }
    push(
      "bash cursor: it sits ON the caret at the start, the middle and the end of the command",
      Object.values(measured).every(
        (m) =>
          m.visibleCursors === 1 &&
          m.want &&
          Math.abs(m.box.left - m.want.left) <= 2 &&
          Math.abs(m.box.top - m.want.top) <= 2,
      ) &&
        measured.start.box.left < measured.middle.box.left &&
        measured.middle.box.left < measured.end.box.left,
      measured,
    );
    push(
      "bash cursor: it is a filled, blinking block while focused",
      measured.middle.filled === true && measured.middle.animated === "te-blink",
      { filled: measured.middle.filled, animation: measured.middle.animated },
    );

    // …and it follows the caret onto a WRAPPED line. Narrow the edit region until the command
    // occupies more than one visual line, then compare the cursor on line 1 and line 2.
    const wrapped = await browser.evaluate(async () => {
      const term = document.querySelector(".freva-term");
      term.querySelector(".term-edit").style.width = "150px";
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const editor = term.querySelector('.term-view[data-cmd="cli"] .te-editor');
      const cmd = editor.querySelector(".te-cmd");
      const rects = cmd.getClientRects();
      const put = (n) => {
        const walk = document.createTreeWalker(cmd, NodeFilter.SHOW_TEXT);
        let left = n;
        let node = null;
        while (walk.nextNode()) {
          const t = walk.currentNode;
          if (left <= t.data.length) {
            node = t;
            break;
          }
          left -= t.data.length;
        }
        const r = document.createRange();
        r.setStart(node, Math.min(left, node.data.length));
        r.collapse(true);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
        cmd.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
      };
      const read = async (n) => {
        cmd.focus();
        put(n);
        await new Promise((r) => setTimeout(r, 220));
        const c = editor.querySelector(".te-caret").getBoundingClientRect();
        const s = getSelection().getRangeAt(0).getBoundingClientRect();
        return { c: { left: c.left, top: c.top }, want: { left: s.left, top: s.top } };
      };
      const first = await read(1);
      const last = await read(24);
      term.querySelector(".term-edit").style.width = "";
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { lines: rects.length, first, last };
    });
    push(
      "bash cursor: after the command wraps, the block follows the caret onto the later line",
      wrapped.lines >= 2 &&
        wrapped.last.c.top > wrapped.first.c.top + 2 &&
        Math.abs(wrapped.first.c.left - wrapped.first.want.left) <= 2 &&
        Math.abs(wrapped.first.c.top - wrapped.first.want.top) <= 2 &&
        Math.abs(wrapped.last.c.left - wrapped.last.want.left) <= 2 &&
        Math.abs(wrapped.last.c.top - wrapped.last.want.top) <= 2,
      wrapped,
    );

    const parked = await browser.evaluate(CURSOR, null);
    push(
      "bash cursor: unfocused it becomes the HOLLOW parked box, still exactly one",
      parked.visibleCursors === 1 &&
        parked.filled === false &&
        /inset/.test(parked.boxShadow ?? ""),
      parked,
    );

    // The cursor and the suggestion are two different things, and the suggestion has to be
    // readable rather than painted underneath the block.
    const withGhost = await browser.evaluate(async () => {
      const term = document.querySelector(".freva-term");
      const editor = term.querySelector('.term-view[data-cmd="cli"] .te-editor');
      const cmd = editor.querySelector(".te-cmd");
      cmd.focus();
      const range = document.createRange();
      range.selectNodeContents(cmd);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(range);
      await new Promise((r) => setTimeout(r, 40));
      return { ready: true };
    });
    void withGhost;
    await browser.keyboard.press("Backspace");
    await browser.keyboard.type("proj", { delay: 20 });
    await browser.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    const ghostAndCursor = await browser.evaluate(() => {
      const term = document.querySelector(".freva-term");
      const editor = term.querySelector('.term-view[data-cmd="cli"] .te-editor');
      const cmd = editor.querySelector(".te-cmd");
      const ghost = editor.querySelector(".te-ghost");
      const caret = editor.querySelector(".te-caret");
      const gb = ghost.getBoundingClientRect();
      const cb = caret.getBoundingClientRect();
      return {
        value: cmd.textContent ?? "",
        ghostText: ghost.textContent ?? "",
        ghostInsideEditable: cmd.contains(ghost),
        cursorInsideEditable: cmd.contains(caret),
        // Same test as everywhere else: a node inside the hidden plain surface computes its own
        // `display`, so "visible" has to mean "has a box".
        cursors: [...editor.querySelectorAll(".te-caret")].filter((c) => {
          const b = c.getBoundingClientRect();
          return getComputedStyle(c).display !== "none" && b.width > 0 && b.height > 0;
        }).length,
        // The suggestion's ink starts at or after the block's right edge.
        ghostAfterCursor: gb.left + gb.width > cb.right && gb.right > cb.right,
        ghostStartsAtOrAfter: Math.round(gb.left) >= Math.round(cb.left) - 1,
      };
    });
    push(
      "bash cursor: the block and the suggestion are separate, and the suggestion reads AFTER it",
      ghostAndCursor.value === "proj" &&
        ghostAndCursor.ghostText === "ect" &&
        !ghostAndCursor.ghostInsideEditable &&
        !ghostAndCursor.cursorInsideEditable &&
        ghostAndCursor.cursors === 1 &&
        ghostAndCursor.ghostAfterCursor &&
        ghostAndCursor.ghostStartsAtOrAfter,
      ghostAndCursor,
    );

    // Reduced motion: a steady block, not a missing one.
    const reduced = await browser.evaluate(async () => {
      const editor = document.querySelector('.freva-term .term-view[data-cmd="cli"] .te-editor');
      const caret = editor.querySelector(".te-caret");
      const before = getComputedStyle(caret);
      return { name: before.animationName };
    });
    await browser.emulateMedia({ reducedMotion: "reduce" });
    const reducedOn = await browser.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 120));
      const editor = document.querySelector('.freva-term .term-view[data-cmd="cli"] .te-editor');
      const caret = editor.querySelector(".te-caret");
      const cs = getComputedStyle(caret);
      const b = caret.getBoundingClientRect();
      return { name: cs.animationName, w: b.width, h: b.height, display: cs.display };
    });
    await browser.emulateMedia({ reducedMotion: "no-preference" });
    push(
      "bash cursor: reduced motion stops the blink but keeps the block",
      reduced.name === "te-blink" &&
        reducedOn.name === "none" &&
        reducedOn.w > 0 &&
        reducedOn.h > 0 &&
        reducedOn.display !== "none",
      { normal: reduced, reduced: reducedOn },
    );

    // 8. External state changes resynchronise the editor
    const cleared = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-db");
      const clear = [...root.querySelectorAll("button")].find((b) =>
        /clear all/i.test(b.textContent ?? ""),
      );
      clear?.click();
      await new Promise((r) => setTimeout(r, 500));
      const term = document.querySelector(".freva-term");
      const ta = term.querySelector('.term-view[data-cmd="py"] textarea');
      const cliEditor = term.querySelector('.term-view[data-cmd="cli"] .te-editor');
      const cliNode =
        cliEditor.dataset.mode === "rich"
          ? cliEditor.querySelector(".te-cmd")
          : cliEditor.querySelector("textarea");
      return {
        hadClearAll: !!clear,
        selected: window.__handle.getState().selected,
        py: ta.value,
        cli: (cliEditor.dataset.mode === "rich" ? cliNode.textContent : cliNode.value) ?? "",
      };
    });
    push(
      "external change: Clear all empties the host selection AND both editors follow",
      cleared.hadClearAll &&
        Object.keys(cleared.selected ?? {}).length === 0 &&
        !/cmip6|tas/.test(cleared.py) &&
        !/cmip6|tas/.test(cleared.cli),
      cleared,
    );

    // 9. Minimizing really collapses the window
    //
    // `.freva-term.show` sets `min-height: 220px`. The minimized rule has to clear that minimum,
    // not merely set `height: auto`: leaving it in place keeps the dock ~220px tall with
    // `.term-body` hidden inside it - a large empty dark rectangle. A height is not a collapse.
    const dock = await browser.evaluate(async () => {
      const term = document.querySelector(".freva-term");
      const before = term.getBoundingClientRect();
      const min = term.querySelector('[aria-label="Minimize"]');
      min.click();
      await new Promise((r) => setTimeout(r, 400));

      const t = document.querySelector(".freva-term");
      const bar = t.querySelector(".term-bar");
      const body = t.querySelector(".term-body");
      const rb = t.getBoundingClientRect();
      const bb = bar.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      const bodyCs = getComputedStyle(body);
      const host = t.offsetParent ?? document.documentElement;
      const hostBox = host.getBoundingClientRect();

      const collapsed = {
        rootH: Math.round(rb.height * 100) / 100,
        barH: Math.round(bb.height * 100) / 100,
        bodyH: Math.round(bodyBox.height * 100) / 100,
        bodyDisplay: bodyCs.display,
        minHeight: getComputedStyle(t).minHeight,
        pinnedToBottom: Math.abs(rb.bottom - hostBox.bottom) <= 1,
      };

      // Opening the settings menu must not inflate the dock.
      const gear = t.querySelector('[aria-label="Terminal settings"]');
      gear.click();
      await new Promise((r) => setTimeout(r, 350));
      const menu = t.querySelector(".term-menu");
      const mb = menu.getBoundingClientRect();
      const afterMenu = t.getBoundingClientRect();
      const controls = [...menu.querySelectorAll("input, button, select")];
      const hits = controls.map((c) => {
        const r = c.getBoundingClientRect();
        const at = document.elementFromPoint(
          Math.round(r.left + r.width / 2),
          Math.round(r.top + r.height / 2),
        );
        return !!at && (at === c || c.contains(at) || menu.contains(at));
      });
      const withMenu = {
        rootH: Math.round(afterMenu.height * 100) / 100,
        menuAbove: mb.bottom <= bb.top + 2,
        menuInsideHost: mb.left >= hostBox.left - 1 && mb.right <= hostBox.right + 1,
        menuInViewport: mb.top >= 0 && mb.bottom <= innerHeight + 1,
        controls: controls.length,
        allHittable: hits.length > 0 && hits.every(Boolean),
      };

      // Drag the dock sideways: it must move horizontally and stay pinned to the bottom.
      gear.click();
      await new Promise((r) => setTimeout(r, 200));
      const startX = t.getBoundingClientRect().left;
      const barMid = bar.getBoundingClientRect();
      // The dock drags with MOUSE events (mousedown on the bar, mousemove on the window), and it
      // only starts moving past the drag threshold - a click on the bar is "restore", not "drag".
      const mouse = (target, type, x) =>
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: Math.round(barMid.top + barMid.height / 2),
            button: 0,
            buttons: type === "mouseup" ? 0 : 1,
          }),
        );
      mouse(bar, "mousedown", Math.round(barMid.left + 40));
      mouse(window, "mousemove", Math.round(barMid.left + 20));
      mouse(window, "mousemove", Math.round(barMid.left - 80));
      mouse(window, "mouseup", Math.round(barMid.left - 80));
      await new Promise((r) => setTimeout(r, 250));
      const moved = t.getBoundingClientRect();
      const dragged = {
        movedLeft: moved.left < startX - 20,
        stillPinned: Math.abs(moved.bottom - hostBox.bottom) <= 1,
        stillCollapsed: Math.abs(moved.height - bb.height) <= 2,
      };

      // Reopen: the body comes back at the size it had. A drag ends in a click, and that one click
      // is deliberately swallowed so the dock does not restore itself the moment it is moved - so
      // the restoring click is the NEXT one.
      t.querySelector(".term-bar").click();
      await new Promise((r) => setTimeout(r, 200));
      if (t.classList.contains("minimized")) {
        t.querySelector(".term-bar").click();
        await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 350));
      const t2 = document.querySelector(".freva-term");
      const rb2 = t2.getBoundingClientRect();
      const body2 = t2.querySelector(".term-body");
      const restored = {
        minimized: t2.classList.contains("minimized"),
        bodyH: Math.round(body2.getBoundingClientRect().height),
        rootH: Math.round(rb2.height),
        wasH: Math.round(before.height),
      };
      return { collapsed, withMenu, dragged, restored };
    });

    push(
      "minimized: the root collapses to the TITLE BAR's height, and the body has no box",
      Math.abs(dock.collapsed.rootH - dock.collapsed.barH) <= 2 &&
        dock.collapsed.bodyH === 0 &&
        dock.collapsed.bodyDisplay === "none" &&
        parseFloat(dock.collapsed.minHeight) === 0 &&
        dock.collapsed.pinnedToBottom,
      dock.collapsed,
    );
    push(
      "minimized: opening the settings menu does not change the dock's height",
      Math.abs(dock.withMenu.rootH - dock.collapsed.rootH) <= 1 &&
        dock.withMenu.menuAbove &&
        dock.withMenu.menuInsideHost &&
        dock.withMenu.menuInViewport &&
        dock.withMenu.allHittable,
      dock.withMenu,
    );
    push(
      "minimized: the dock still drags sideways, stays pinned to the bottom and stays collapsed",
      dock.dragged.movedLeft && dock.dragged.stillPinned && dock.dragged.stillCollapsed,
      dock.dragged,
    );
    // The dock collapses to the bar whatever the window controls look like: macOS dots, Windows
    // buttons and Linux symbolic controls are different sizes, and `min-height` must not be what
    // decides the height in any of them.
    const perOs = await browser.evaluate(async () => {
      const out = {};
      const term = document.querySelector(".freva-term");
      const bar = term.querySelector(".term-bar");
      const body = term.querySelector(".term-body");
      const wasOs = term.dataset.os;
      const wasMin = term.classList.contains("minimized");
      if (!wasMin) {
        term.querySelector('[aria-label="Minimize"]').click();
        await new Promise((r) => setTimeout(r, 350));
      }
      for (const os of ["mac", "windows", "linux"]) {
        term.dataset.os = os;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rb = term.getBoundingClientRect();
        const bb = bar.getBoundingClientRect();
        out[os] = {
          rootH: Math.round(rb.height * 100) / 100,
          barH: Math.round(bb.height * 100) / 100,
          bodyH: Math.round(body.getBoundingClientRect().height),
          controls: term.querySelectorAll(".term-bar .tl").length,
        };
      }
      term.dataset.os = wasOs;
      if (!wasMin) {
        term.querySelector(".term-bar").click();
        await new Promise((r) => setTimeout(r, 300));
      }
      return out;
    });
    push(
      "minimized: the dock is bar-height under macOS, Windows and Linux control layouts",
      ["mac", "windows", "linux"].every(
        (os) =>
          Math.abs(perOs[os].rootH - perOs[os].barH) <= 2 &&
          perOs[os].bodyH === 0 &&
          perOs[os].controls >= 3,
      ),
      perOs,
    );

    push(
      "reopening restores a real body at the size the window had",
      dock.restored.minimized === false &&
        dock.restored.bodyH > 0 &&
        Math.abs(dock.restored.rootH - dock.restored.wasH) <= 2,
      dock.restored,
    );

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("terminal: real typing, ghosts, composition, python and the dock", result));
