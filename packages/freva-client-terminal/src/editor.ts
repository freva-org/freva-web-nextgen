// editor.ts - the editable command line.
//
// The prefix and the command are ordinary inline content in ONE `white-space: pre-wrap` flow: no
// indent, no absolute layer, no width threshold, so the command starts right after the last prefix
// token and a wrapped line continues at the container's left edge, as a terminal does. An indent
// shifts only the FIRST line, so a wrapped prefix would leave typed text overlapping the prompt.
//
// Two modes:
//   • rich  - a controlled `contenteditable="plaintext-only"` span; the highlight IS the editable
//             surface, so there is no overlay to keep in sync. Single-line buffers.
//   • plain - the fallback: a <textarea> with a <pre> highlight overlay and the prefix in a block
//             above. Multi-line buffers, narrow viewports, forced fallback, no plaintext-only.
//
// THREE RULES THAT ARE NOT NEGOTIABLE:
//   1. THE MODE IS APPLIED, NOT ASSUMED. `setMode` writes the DOM state on every call, including
//      the first; returning early leaves `data-mode` unset and `.te-plain` at its `display: none`
//      default. Python is ALWAYS plain, so its textarea would not be visible, focusable or
//      clickable.
//   2. THE GHOST IS NEVER INSIDE THE EDITABLE NODE. It is a sibling of `.te-cmd` in the same inline
//      flow, so it looks identical while `Editor.value` - the buffer commits, copies, parsing and
//      drafts read - cannot hold a suggestion the user never accepted; inside it, a keystroke
//      silently absorbs the suggestion.
//   3. AN ACTIVE COMPOSITION IS LEFT ALONE. Highlighting rebuilds the editable DOM, destroying the
//      IME's anchor; composition suppresses the input hook and the repaint until `compositionend`.

import { el, replaceChildren, type Disposables } from "./dom.js";
import type { TerminalSegment } from "./types.js";

export type EditorMode = "rich" | "plain";

export interface EditorHooks {
  onInput(): void;
  onCaretMove(): void;
  onFocus(): void;
  onBlur(): void;
  onKeyDown(e: KeyboardEvent): void;
}

export interface EditorConfig {
  multiline: boolean;
  placeholder: string;
  ariaLabel: string;
  /**
   * Class-name prefix for this editor's surfaces (`te` -> `.te-wrap`, `.te-hl`, `.te-input`).
   * PER-TAB: two tabs sharing one class would make `.te-hl .te-caret` match two carets at once, and
   * host stylesheets style the shell and python editors separately.
   */
  cssPrefix: string;
}

/** Does this engine support `contenteditable="plaintext-only"`? jsdom and older engines do not. */
export function supportsPlaintextOnly(doc: Document): boolean {
  try {
    const probe = doc.createElement("span");
    probe.setAttribute("contenteditable", "plaintext-only");
    return probe.contentEditable === "plaintext-only";
  } catch {
    return false;
  }
}

/**
 * SegmentKind -> class names. Each kind carries the generic `te-*` class AND the short name the
 * freva stylesheet uses (`.k`, `.v`, `.eq`, …), scoped under `.freva-term` so it cannot collide.
 */
const SEGMENT_CLASS: Record<string, string> = {
  prompt: "te-prompt prompt",
  fixed: "te-fixed fixed",
  accent: "te-accent term-flav",
  muted: "te-muted term-scope",
  key: "te-key k",
  eq: "te-eq eq",
  value: "te-value v",
  bad: "te-bad bad",
};

function segmentClass(kind: TerminalSegment["kind"]): string | null {
  if (!kind || kind === "plain") return null;
  return SEGMENT_CLASS[kind] ?? `te-${kind}`;
}

function segmentSpan(seg: TerminalSegment): Node {
  const cls = segmentClass(seg.kind);
  if (!cls) return document.createTextNode(seg.text);
  return el("span", { class: cls, text: seg.text });
}

/** Render segments into a host as inline runs. Text always arrives via textContent. */
export function paintSegments(host: HTMLElement, segments: TerminalSegment[]): void {
  replaceChildren(host);
  for (const s of segments) {
    if (!s.text) continue;
    host.append(segmentSpan(s));
  }
}

/** Character offset of a (container, offset) boundary inside a host, or -1 when it isn't there. */
function offsetIn(host: HTMLElement, container: Node, offset: number): number {
  if (!host.contains(container)) return -1;
  const doc = host.ownerDocument;
  const pre = doc.createRange();
  pre.selectNodeContents(host);
  pre.setEnd(container, offset);
  return pre.toString().length;
}

/** Caret offset (in characters) inside a contenteditable host, or -1 when it isn't there. */
function caretOffsetIn(host: HTMLElement): number {
  const doc = host.ownerDocument;
  const sel = doc.getSelection?.();
  if (!sel || sel.rangeCount === 0) return -1;
  const r = sel.getRangeAt(0);
  return offsetIn(host, r.startContainer, r.startOffset);
}

/**
 * The whole selection as character offsets, or null when it is not in this host. A repaint rebuilds
 * the editable DOM, so a NON-COLLAPSED selection must survive it too, not just the caret.
 */
function selectionIn(host: HTMLElement): { start: number; end: number } | null {
  const sel = host.ownerDocument.getSelection?.();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  const start = offsetIn(host, r.startContainer, r.startOffset);
  const end = offsetIn(host, r.endContainer, r.endOffset);
  if (start < 0 || end < 0) return null;
  return { start, end };
}

/** Locate a character offset as a (text node, offset) pair inside a host. */
function locate(host: HTMLElement, offset: number): { node: Text | null; at: number } {
  const walker = host.ownerDocument.createTreeWalker(host, 4 /* NodeFilter.SHOW_TEXT */);
  let remaining = Math.max(0, offset);
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (remaining <= t.data.length) return { node: t, at: remaining };
    remaining -= t.data.length;
  }
  return { node: null, at: 0 };
}

/** Restore a selection by character offsets inside a contenteditable host. */
function setSelectionIn(host: HTMLElement, start: number, end: number): void {
  const doc = host.ownerDocument;
  const sel = doc.getSelection?.();
  if (!sel) return;
  const a = locate(host, start);
  const b = locate(host, end);
  const range = doc.createRange();
  if (a.node) range.setStart(a.node, Math.min(a.at, a.node.data.length));
  else {
    range.selectNodeContents(host);
    range.collapse(false);
  }
  if (b.node) range.setEnd(b.node, Math.min(b.at, b.node.data.length));
  else range.collapse(false);
  try {
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    // a detached/hidden host cannot take a selection - harmless
  }
}

/** Put the caret at a character offset inside a contenteditable host. */
function setCaretOffsetIn(host: HTMLElement, offset: number): void {
  setSelectionIn(host, offset, offset);
}

export class Editor {
  /** The whole editable region (prefix + command). */
  readonly root: HTMLElement;
  /** The shared inline flow: prefix and command are siblings inside it, nothing else. */
  private readonly flow: HTMLElement;
  private readonly richPrefix: HTMLElement;
  private readonly cmd: HTMLElement;
  private readonly plain: HTMLElement;
  private readonly plainPrefix: HTMLElement;
  private readonly hl: HTMLElement;
  private readonly ta: HTMLTextAreaElement;
  /** The ghost layer: a SIBLING of the editable node, never a child of it. See rule 2 above. */
  private readonly ghostLayer: HTMLElement;
  /** The parked caret marker for rich mode - also a sibling, so it cannot take a click. */
  private readonly richCaret: HTMLElement;
  private mode: EditorMode = "plain";
  /** True between `compositionstart` and `compositionend` on either surface. */
  private composing = false;
  private prefixSegments: TerminalSegment[] = [];
  private readonly cfg: EditorConfig;
  private readonly richCapable: boolean;
  /** Generic `te-ghost` plus the per-tab alias, so both the shared and the python rules apply. */
  private readonly ghostClass: string;

  constructor(dis: Disposables, cfg: EditorConfig, hooks: EditorHooks) {
    this.cfg = cfg;
    this.richCapable = !cfg.multiline && supportsPlaintextOnly(document);
    this.ghostClass = `te-ghost ${cfg.cssPrefix}-ghost`;

    // `cli-line` sits alongside `cli-prefix` so stylesheets and tests addressing the prompt match.
    this.richPrefix = el("span", { class: "cli-prefix cli-line", "aria-hidden": "true" });
    this.cmd = el("span", {
      class: "te-cmd",
      role: "textbox",
      "aria-multiline": cfg.multiline ? "true" : "false",
      "aria-label": cfg.ariaLabel,
      spellcheck: "false",
      autocapitalize: "off",
      tabindex: "0",
    });
    // Presentation only, OUTSIDE the editable node (rule 2), inert to pointer and selection.
    this.ghostLayer = el("span", { class: this.ghostClass, "aria-hidden": "true" });
    this.richCaret = el("span", { class: "te-caret", "aria-hidden": "true" });
    // The ghost and the parked caret are inline siblings, so they wrap with the command.
    this.flow = el("div", { class: "te-flow" }, [
      this.richPrefix,
      this.cmd,
      this.ghostLayer,
      this.richCaret,
    ]);

    this.plainPrefix = el("div", {
      class: "cli-prefix cli-prefix-block cli-line",
      "aria-hidden": "true",
    });
    this.hl = el("pre", { class: `${cfg.cssPrefix}-hl`, "aria-hidden": "true" });
    this.ta = el("textarea", {
      class: `${cfg.cssPrefix}-input`,
      rows: "1",
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
      "aria-label": cfg.ariaLabel,
      placeholder: cfg.placeholder,
    }) as HTMLTextAreaElement;
    this.plain = el("div", { class: "te-plain" }, [
      this.plainPrefix,
      el("div", { class: "te-plainwrap" }, [this.hl, this.ta]),
    ]);

    this.root = el("div", { class: `${cfg.cssPrefix}-wrap te-editor` }, [this.flow, this.plain]);

    const emitInput = (): void => {
      // Mid-composition the buffer is not a command yet; `compositionend` emits the one input.
      if (this.composing) return;
      if (!this.cfg.multiline) this.stripNewlines();
      hooks.onInput();
    };
    dis.listen(this.ta, "input", emitInput);
    dis.listen(this.cmd, "input", emitInput);
    for (const node of [this.ta, this.cmd] as HTMLElement[]) {
      dis.listen(node, "compositionstart", () => {
        this.composing = true;
        // The suggestion belongs to the pre-composition buffer and must not merge into IME text.
        this.clearGhost();
      });
      dis.listen(node, "compositionend", () => {
        this.composing = false;
        emitInput();
      });
      dis.listen(node, "keydown", (e) => hooks.onKeyDown(e as KeyboardEvent));
      dis.listen(node, "keyup", (e) => {
        const k = (e as KeyboardEvent).key;
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(k)) {
          hooks.onCaretMove();
        }
      });
      dis.listen(node, "click", () => hooks.onCaretMove());
      dis.listen(node, "focus", () => hooks.onFocus());
      dis.listen(node, "blur", () => hooks.onBlur());
    }
    // plaintext-only already refuses markup, but a paste is where a hostile clipboard would try to
    // smuggle nodes in, so force the plain-text branch rather than trusting the flag.
    dis.listen(this.cmd, "paste", (e) => {
      const ev = e as ClipboardEvent;
      const text = ev.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      ev.preventDefault();
      this.insertText(text);
      emitInput();
    });
    this.setMode("plain");
  }

  /** The active surface - what focus checks and keyboard handlers act on. */
  get inputEl(): HTMLElement {
    return this.mode === "rich" ? this.cmd : this.ta;
  }

  /** Whether the rich (shared inline flow) surface can be used at all in this engine. */
  get canBeRich(): boolean {
    return this.richCapable;
  }

  /**
   * Switch surfaces. IDEMPOTENT BUT NEVER A NO-OP (rule 1): the DOM state is written on every call,
   * including the first from the constructor, because returning early when `want === this.mode`
   * leaves `data-mode` unwritten and `.te-plain` at its `display: none` default. Only the value
   * transfer is conditional.
   */
  setMode(next: EditorMode): void {
    const want: EditorMode = next === "rich" && this.richCapable ? "rich" : "plain";
    if (want !== this.mode) {
      const value = this.mode === "rich" ? this.cmdText() : this.ta.value;
      this.mode = want;
      if (want === "rich") this.setCmdText(value);
      else this.ta.value = value;
    }
    this.root.dataset.mode = want;
    this.flow.style.display = want === "rich" ? "" : "none";
    this.plain.style.display = want === "plain" ? "" : "none";
    if (want === "rich") this.cmd.setAttribute("contenteditable", "plaintext-only");
    else this.cmd.removeAttribute("contenteditable");
    this.clearGhost();
    this.setPrefix(this.prefixSegments);
  }

  /** The editable node's text; a ghost is never a child of it, so it cannot contain one. */
  private cmdText(): string {
    return this.cmd.textContent ?? "";
  }

  private setCmdText(v: string): void {
    this.cmd.textContent = v;
  }

  /** Drop the presentation-only suggestion. Never touches the buffer. */
  private clearGhost(): void {
    this.ghostLayer.textContent = "";
  }

  /** True while an IME composition is in progress on either surface. */
  get isComposing(): boolean {
    return this.composing;
  }

  setPrefix(segments: TerminalSegment[]): void {
    this.prefixSegments = segments;
    // Paint BOTH hosts: only one shows, but a mode switch must not reveal an empty prompt.
    paintSegments(this.richPrefix, segments);
    paintSegments(this.plainPrefix, segments);
    // With no prefix (python prompts in its own gutter) an empty block still pads a line.
    this.plainPrefix.hidden = segments.length === 0;
    // The prefix/command separator is a space INSIDE the flow, so it is a soft-wrap opportunity.
    if (segments.length) this.richPrefix.append(document.createTextNode(" "));
  }

  /**
   * In rich mode it is the editable node's text and the ghost is a sibling, so an unaccepted
   * suggestion cannot appear here by construction.
   */
  get value(): string {
    return this.mode === "rich" ? this.cmdText() : this.ta.value;
  }

  set value(v: string) {
    if (this.mode === "rich") this.setCmdText(v);
    else this.ta.value = v;
  }

  /** Caret offset in characters. Falls back to the end of the buffer when unfocused/unknown. */
  get caret(): number {
    if (this.mode === "plain") return this.ta.selectionStart ?? this.ta.value.length;
    const at = caretOffsetIn(this.cmd);
    return at < 0 ? this.cmdText().length : at;
  }

  /** The current selection as character offsets into `value`. */
  get selection(): { start: number; end: number } {
    if (this.mode === "plain") {
      const n = this.ta.value.length;
      return { start: this.ta.selectionStart ?? n, end: this.ta.selectionEnd ?? n };
    }
    const s = selectionIn(this.cmd);
    const n = this.cmdText().length;
    return s ?? { start: n, end: n };
  }

  setSelection(start: number, end: number): void {
    if (this.mode === "plain") this.ta.setSelectionRange(start, end);
    else setSelectionIn(this.cmd, start, end);
  }

  setCaret(n: number): void {
    if (this.mode === "plain") this.ta.setSelectionRange(n, n);
    else setCaretOffsetIn(this.cmd, n);
  }

  isFocused(): boolean {
    const active = document.activeElement;
    return this.mode === "rich" ? active === this.cmd : active === this.ta;
  }

  focus(): void {
    this.inputEl.focus();
  }

  contains(node: Node | null): boolean {
    return !!node && this.root.contains(node);
  }

  /**
   * Draw the highlighted buffer. In rich mode the editable surface IS the highlight, so the rebuild
   * preserves the SELECTION (both ends, not just the caret) by text offset; in plain mode the <pre>
   * overlay mirrors the textarea character-for-character. A repaint during an IME composition is
   * skipped entirely (it would drop or duplicate composed characters); the paint after
   * `compositionend` draws the settled text.
   */
  paint(segments: TerminalSegment[], ghost: string): void {
    if (this.composing) return; // rule 3
    const focused = this.isFocused();
    if (this.mode === "rich") {
      const sel = focused ? selectionIn(this.cmd) : null;
      paintSegments(this.cmd, segments);
      if (sel) setSelectionIn(this.cmd, sel.start, sel.end);
      // Suggestion and parked caret live OUTSIDE `.te-cmd`; bash ghosts after the whole buffer.
      this.ghostLayer.textContent = ghost && focused ? ghost : "";
      this.cmd.classList.toggle("is-empty", this.cmdText() === "");
      this.cmd.dataset.placeholder = this.cfg.placeholder;
      this.placeRichCaret();
      return;
    }
    // As in the rich path: the placeholder can derive from data arriving after construction.
    if (this.ta.placeholder !== this.cfg.placeholder) this.ta.placeholder = this.cfg.placeholder;
    // The drawn caret sits where the REAL one is, so clicking mid-line moves the block with it,
    // and is drawn UNFOCUSED too (parked at the end) to show where typing begins - one per tab.
    const caretNode = el("span", { class: "te-caret" });
    const at = focused ? this.caret : this.value.length;
    replaceChildren(this.hl);
    const mk = (t: string, kind: TerminalSegment["kind"]): Node => {
      const cls = segmentClass(kind);
      return cls ? el("span", { class: cls, text: t }) : document.createTextNode(t);
    };
    // A MULTILINE buffer ghosts AT THE CARET, which can be on any line; a ghost after the whole
    // buffer would sit lines below the word it completes. Single-line ghosts after the command.
    const ghostNode = ghost && focused ? el("span", { class: this.ghostClass, text: ghost }) : null;
    const ghostAtCaret = this.cfg.multiline;
    let pos = 0;
    let placed = false;
    for (const s of segments) {
      if (!s.text) continue;
      const end = pos + s.text.length;
      if (!placed && at >= pos && at <= end) {
        const i = at - pos;
        this.hl.append(mk(s.text.slice(0, i), s.kind), caretNode);
        if (ghostNode && ghostAtCaret) this.hl.append(ghostNode);
        this.hl.append(mk(s.text.slice(i), s.kind));
        placed = true;
      } else {
        this.hl.append(mk(s.text, s.kind));
      }
      pos = end;
    }
    if (!placed) {
      // Empty buffer, or the caret sits past the last segment.
      this.hl.append(caretNode);
      if (ghostNode && ghostAtCaret) this.hl.append(ghostNode);
    }
    if (ghostNode && !ghostAtCaret) this.hl.append(ghostNode);
    this.fit();
  }

  /**
   * Draw the block cursor at the caret, in the rich flow. A terminal's cursor is a block sitting ON
   * the caret, not the thin native bar (hence `caret-color: transparent` on the python line). It
   * cannot be an inline node here: that would split the EDITABLE text,
   * and nothing but the buffer may live inside `.te-cmd`. So it is measured: a collapsed `Range` at
   * the caret offset reports a client rect already resolved onto the correct visual line, which is
   * what makes the block follow a soft wrap. A selected RANGE gets no cursor.
   */
  private placeRichCaret(): void {
    const flowBox = this.flow.getBoundingClientRect();
    if (flowBox.width === 0 && flowBox.height === 0) return; // not laid out (jsdom, or hidden)
    const focused = this.isFocused();
    const sel = focused ? selectionIn(this.cmd) : null;
    if (sel && sel.start !== sel.end) {
      this.richCaret.classList.add("hide");
      this.ghostLayer.classList.remove("after-cursor");
      return;
    }
    this.richCaret.classList.remove("hide");

    const text = this.cmdText();
    // Unfocused, the cursor parks at the end of the command - the "start typing here" cue.
    const at = focused ? Math.min(this.caret, text.length) : text.length;
    const doc = this.cmd.ownerDocument;
    const range = doc.createRange();
    const loc = locate(this.cmd, at);
    if (loc.node) {
      range.setStart(loc.node, Math.min(loc.at, loc.node.data.length));
      range.collapse(true);
    } else {
      range.selectNodeContents(this.cmd);
      range.collapse(false);
    }
    const measured = range.getBoundingClientRect();
    let rect: { left: number; top: number; height: number } | null =
      measured && !(measured.width === 0 && measured.height === 0) ? measured : null;
    // An empty buffer, or a collapsed range the engine will not measure. The fallback is ONE LINE
    // BOX, not `this.cmd.getBoundingClientRect()`: for a SOFT WRAPPED command that box is the UNION
    // of the line boxes, so it is as tall as every line at once and as far left as the leftmost of
    // them. `getClientRects()` returns the boxes individually - the first when the caret is at the
    // start of the buffer, the last otherwise, since the parked, unfocused cursor sits at the end.
    if (!rect) {
      const lines = this.cmd.getClientRects();
      const line = at <= 0 ? lines[0] : lines[lines.length - 1];
      if (line && line.height > 0) {
        rect = { left: at <= 0 ? line.left : line.right, top: line.top, height: line.height };
      } else {
        const b = this.cmd.getBoundingClientRect();
        rect = b.height > 0 ? { left: b.left, top: b.top, height: b.height } : null;
      }
    }
    if (!rect) return;
    // Never taller than a line, whichever branch measured it: a block cursor marks ONE cell on ONE
    // line, and clamping here holds that for any measurement path an engine may report.
    const lineBoxes = this.cmd.getClientRects();
    let tallestLine = 0;
    for (const box of lineBoxes) if (box.height > tallestLine) tallestLine = box.height;
    const height = tallestLine > 0 ? Math.min(rect.height, tallestLine) : rect.height;
    this.richCaret.style.left = `${Math.round((rect.left - flowBox.left) * 100) / 100}px`;
    this.richCaret.style.top = `${Math.round((rect.top - flowBox.top) * 100) / 100}px`;
    if (height > 0) this.richCaret.style.height = `${Math.round(height * 100) / 100}px`;
    // With the caret at the end the suggestion starts where the block is, so it needs clearance.
    this.ghostLayer.classList.toggle(
      "after-cursor",
      this.ghostLayer.textContent !== "" && at === text.length,
    );
  }

  /** Re-measure the block cursor - the caret's client rect moves whenever the flow re-wraps. */
  refreshCaret(): void {
    if (this.mode === "rich") this.placeRichCaret();
  }

  /** Grow the textarea to its content (plain mode only; rich mode grows naturally). */
  fit(): void {
    if (this.mode !== "plain") {
      this.refreshCaret(); // a resize re-wraps the flow, which moves the caret's rect
      return;
    }
    if (this.ta.offsetParent === null && this.ta.clientWidth === 0) return;
    this.ta.style.height = "auto";
    const h = this.ta.scrollHeight;
    if (h > 0) this.ta.style.height = `${h}px`;
  }

  /** Insert text at the caret, REPLACING whatever is selected - which is what a paste does. */
  private insertText(text: string): void {
    const v = this.value;
    const { start, end } = this.selection;
    const clean = this.cfg.multiline ? text : text.replace(/[\r\n]+/g, " ");
    this.value = v.slice(0, start) + clean + v.slice(end);
    this.setCaret(start + clean.length);
  }

  private stripNewlines(): void {
    const v = this.value;
    if (!/[\n\r]/.test(v)) return;
    const at = this.caret;
    this.value = v.replace(/[\n\r]+/g, " ");
    this.setCaret(Math.min(at, this.value.length));
  }
}

/** A single segment as a node, for the read-only header/footer lines the window renders. */
export function segmentNode(seg: TerminalSegment, doc: Document): Node {
  const cls = segmentClass(seg.kind);
  return cls ? el("span", { class: cls, text: seg.text }) : doc.createTextNode(seg.text);
}
