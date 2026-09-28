// An editable runnable snippet: the block's own `<pre>` becomes a small Python editor.
//
// LOADED ONLY WHEN A VISITOR REACHES FOR IT: `code-run.ts` imports it on the first click or focus
// on an editable block, so a page nobody edits fetches none of it.
//
// A textarea over a highlighted copy of the same text in one grid cell: the textarea holds source,
// caret and selection with transparent glyphs; the layer is Prism's token tree drawn as DOM nodes
// (never an HTML string) in the shell's `--syn-*` colours, one block per line so the caret's line
// can be marked and `code-run.ts`'s gutter kept to the line count. The stylesheet owns sizes and
// colours; nothing here writes a style.
//
// Keys: Tab / Shift+Tab indent and outdent four spaces; Escape then Tab leaves (no keyboard trap,
// WCAG 2.1.2); Enter keeps indentation, one level more after a colon; Ctrl/Cmd+Enter runs. Text
// goes in through `insertText`, so Ctrl+Z undoes an indent like typing.

import Prism from "prismjs/components/prism-core.js";
import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-python.js";

const INDENT = "    ";

/** Prism's token types, onto the shell's six syntax roles. */
const ROLE: Readonly<Record<string, string>> = {
  comment: "tok-comment",
  "triple-quoted-string": "tok-string",
  string: "tok-string",
  "string-interpolation": "tok-string",
  interpolation: "tok-string",
  keyword: "tok-keyword",
  boolean: "tok-keyword",
  number: "tok-number",
  builtin: "tok-name",
  function: "tok-name",
  "class-name": "tok-name",
  decorator: "tok-name",
  operator: "tok-punct",
  punctuation: "tok-punct",
};

type Token = string | { type: string; content: Token | Token[] };

/** The token tree as flat runs of text, each with the innermost role that applies to it. */
function flatten(content: Token | Token[], role: string, out: [string, string][]): void {
  if (Array.isArray(content)) for (const part of content) flatten(part, role, out);
  else if (typeof content === "string") out.push([content, role]);
  else flatten(content.content, ROLE[content.type] ?? role, out);
}

/**
 * One `.portal-code-line` block per source line, each ending in its own newline, so the layer's
 * text is still exactly the source. A token that spans lines (a triple-quoted string) is split.
 */
function drawLines(view: HTMLElement, runs: [string, string][]): HTMLElement[] {
  const lines = [document.createElement("span")];
  for (const [text, role] of runs) {
    text.split("\n").forEach((piece, index) => {
      if (index > 0) {
        lines[lines.length - 1]!.append("\n");
        lines.push(document.createElement("span"));
      }
      if (!piece) return;
      const target = lines[lines.length - 1]!;
      if (!role) {
        target.append(piece);
        return;
      }
      const span = document.createElement("span");
      span.className = role;
      span.textContent = piece;
      target.append(span);
    });
  }
  // An empty last line still takes a line's height, or the caret on it sits below the block.
  const last = lines[lines.length - 1]!;
  if (!last.firstChild) last.append(" ");
  for (const line of lines) line.className = "portal-code-line";
  view.replaceChildren(...lines);
  return lines;
}

const numbers = (count: number): string =>
  Array.from({ length: count }, (_, i) => i + 1).join("\n");

export interface EditorOptions {
  /** The block's `<pre>`, whose content the editor replaces. */
  pre: HTMLElement;
  /** The author's source: what Reset restores. */
  original: string;
  /** The snippet's name, for the editor's accessible label. */
  name: string;
  /** Where the caret goes: an offset into the source, or the end. */
  caret?: number;
  onChange(value: string): void;
  onRun(): void;
}

export interface SnippetEditor {
  value(): string;
  /** Put the author's code back. */
  reset(): void;
  focus(): void;
}

export function mountEditor(options: EditorOptions): SnippetEditor {
  const { pre, original } = options;
  const grid = document.createElement("span");
  grid.className = "portal-code-editor-grid";
  // A span, not `<code>`: prose styles inline code (a smaller size, a chip's padding), and the
  // layer must have exactly the textarea's metrics or the caret drifts off the text it edits.
  const view = document.createElement("span");
  view.className = "portal-code-editor-view";
  view.setAttribute("aria-hidden", "true");
  const input = document.createElement("textarea");
  input.className = "portal-code-editor-input";
  input.value = original;
  input.rows = 1;
  input.cols = 1;
  input.wrap = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute(
    "aria-label",
    `Edit ${options.name}. Ctrl+Enter runs it; Escape, then Tab, leaves the editor.`,
  );
  grid.append(view, input);

  const gutter = pre.querySelector<HTMLElement>(".portal-code-gutter");
  let lines: HTMLElement[] = [];
  let current = -1;
  /** Mark the caret's line, only while the editor has the focus. */
  const markLine = (): void => {
    const at =
      document.activeElement === input
        ? input.value.slice(0, input.selectionStart).split("\n").length - 1
        : -1;
    if (at === current) return;
    lines[current]?.classList.remove("is-current");
    lines[at]?.classList.add("is-current");
    current = at;
  };
  const render = (): void => {
    const grammar = Prism.languages.python;
    const runs: [string, string][] = [];
    if (grammar) flatten(Prism.tokenize(input.value, grammar) as Token[], "", runs);
    else runs.push([input.value, ""]);
    lines = drawLines(view, runs);
    current = -1;
    const count = input.value.split("\n").length;
    if (gutter && gutter.textContent?.split("\n").length !== count) {
      gutter.textContent = numbers(count);
    }
    markLine();
  };

  const insert = (text: string): void => {
    // The browser's own insertion keeps the undo stack; `setRangeText` is the fallback where the
    // command is gone, and fires no `input` of its own.
    if (!document.execCommand("insertText", false, text)) {
      input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new Event("input"));
    }
  };

  const indent = (outdent: boolean): void => {
    const { selectionStart: start, selectionEnd: end, value } = input;
    if (!outdent && !value.slice(start, end).includes("\n")) {
      insert(INDENT);
      return;
    }
    // Whole lines: from the start of the first selected line to the end of the last one - not the
    // next line when the selection stops at its very beginning.
    const from = value.lastIndexOf("\n", start - 1) + 1;
    const stop = end > start && value[end - 1] === "\n" ? end - 1 : end;
    const lineEnd = value.indexOf("\n", stop);
    const to = lineEnd === -1 ? value.length : lineEnd;
    const lines = value.slice(from, to).split("\n");
    const changed = lines
      .map((line) =>
        outdent ? line.replace(new RegExp(`^ {1,${INDENT.length}}|^\\t`), "") : INDENT + line,
      )
      .join("\n");
    input.setSelectionRange(from, to);
    insert(changed);
    input.setSelectionRange(from, from + changed.length);
  };

  let tabReleased = false;
  input.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      options.onRun();
      return;
    }
    if (event.key === "Escape") {
      tabReleased = true;
      return;
    }
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (tabReleased) return;
      event.preventDefault();
      indent(event.shiftKey);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      const { selectionStart: start, value } = input;
      const line = value.slice(value.lastIndexOf("\n", start - 1) + 1, start);
      const lead = /^[ \t]*/.exec(line)![0];
      event.preventDefault();
      insert(`\n${lead}${/:\s*$/.test(line) ? INDENT : ""}`);
      return;
    }
    if (event.key !== "Shift") tabReleased = false;
  });
  input.addEventListener("blur", () => {
    tabReleased = false;
    markLine();
  });
  for (const type of ["focus", "keyup", "pointerup", "select"]) {
    input.addEventListener(type, markLine);
  }
  // The textarea is exactly as large as its text, so it never needs to scroll itself; if the
  // browser scrolls it anyway to reveal the caret, its text leaves the layer's. The block scrolls.
  input.addEventListener("scroll", () => {
    input.scrollLeft = 0;
    input.scrollTop = 0;
  });
  input.addEventListener("input", () => {
    render();
    options.onChange(input.value);
  });

  pre.classList.add("portal-code-editor");
  // The editor is the tab stop now; a scrollable `<pre>` was one of its own.
  pre.removeAttribute("tabindex");
  pre.replaceChildren(...(gutter ? [gutter] : []), grid);
  render();
  const caret = Math.max(0, Math.min(options.caret ?? original.length, original.length));
  input.setSelectionRange(caret, caret);

  return {
    value: () => input.value,
    reset(): void {
      input.value = original;
      render();
      options.onChange(original);
    },
    focus: () => input.focus(),
  };
}
