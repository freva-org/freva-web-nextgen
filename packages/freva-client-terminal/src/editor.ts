// editor.ts - the editable command line.
//
// THE WRAPPING FIX LIVES HERE.
//
// The previous geometry painted the immutable prefix in an absolutely-positioned, `white-space:
// nowrap` layer and pushed the editable text past it with `text-indent`, plus a 62%-of-width
// threshold that dropped the whole prefix onto its own line. That is not how a shell wraps: an
// indent only shifts the FIRST line, so as soon as the prefix itself wrapped, the two layers
// disagreed and the typed text either overlapped the prompt or was exiled to the next line.
//
// Now the prefix and the command are ordinary inline content inside ONE `white-space: pre-wrap`
// flow. There is no indent, no absolute layer, no threshold and no `prefix-block` mode: the command
// starts immediately after the last prefix token at every width, and a wrapped line continues at the
// container's normal left edge - exactly what a terminal does.
//
// Two modes:
//   • rich  - a controlled `contenteditable="plaintext-only"` span. Highlighting is the editable
//             surface itself, so there is no overlay to keep in sync and no second text layer to
//             mis-measure. Used for single-line buffers where the engine supports plaintext-only.
//   • plain - the explicit fallback: a real <textarea> with a <pre> highlight overlay and the prefix
//             as a block above it. Used for multi-line buffers, narrow viewports, forced fallback,
//             and any engine without plaintext-only (which includes jsdom).
//
// THREE RULES THAT ARE NOT NEGOTIABLE:
//
//   1. THE MODE IS APPLIED, NOT ASSUMED. `setMode` writes the DOM state every time it is called,
//      including the first. Returning early when the requested mode equals the field's initial
//      value leaves `data-mode` unset, and `.te-plain` - `display: none` until that attribute says
//      otherwise - stays hidden. Python is ALWAYS plain, so Python's textarea would sit in the
//      document unable to be seen, focused or clicked.
//   2. THE GHOST IS NEVER INSIDE THE EDITABLE NODE. It is a sibling of `.te-cmd` in the same inline
//      flow, so it looks identical and `Editor.value` - which is the authoritative buffer for
//      commits, copies, parsing and retained drafts - cannot contain a suggestion the user never
//      accepted. Appended INSIDE `.te-cmd`, with `value` reading that node's `textContent`, the
//      next ordinary keystroke silently absorbs the suggestion.
//   3. AN ACTIVE COMPOSITION IS LEFT ALONE. Highlighting rebuilds the editable DOM; doing that
//      mid-composition destroys the IME's anchor and drops or duplicates characters. Composition
//      suppresses both the input hook and the repaint, and one input is emitted on
//      `compositionend`.

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
   * PER-TAB rather than generic: two tabs sharing one class would make `.te-hl .te-caret` match two
   * carets at once, and host stylesheets have always styled the shell and python editors separately.
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
 * SegmentKind -> class names. Each kind carries the package's generic `te-*` class AND the short
 * historical name the freva stylesheet has always used (`.k`, `.v`, `.eq`, `.bad`, …). Keeping both
 * is what let the terminal move into its own package without restyling it: the moved rules keep
 * matching, and they are scoped under `.freva-term`, so the short names cannot collide with a host.
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
 * The whole selection as character offsets, or null when it is not in this host.
 *
 * Repainting rebuilds the editable DOM, so a NON-COLLAPSED selection has to survive it too - not
 * just the caret. Restoring only the caret collapsed the user's selection every time the highlight
 * refreshed, which turned "select a word, then type over it" into "select a word, watch it
 * deselect".
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
    /* a detached/hidden host cannot take a selection - harmless */
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

    // `cli-line` is kept alongside `cli-prefix` so host stylesheets and integration tests that
    // already address the painted prompt keep working across the extraction.
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
    // Presentation only, and OUTSIDE the editable node - see rule 2. Both are inert to the pointer
    // and to the selection, so a click near them still lands in `.te-cmd`.
    this.ghostLayer = el("span", { class: this.ghostClass, "aria-hidden": "true" });
    this.richCaret = el("span", { class: "te-caret", "aria-hidden": "true" });
    // The whole point: ONE inline flow, `pre-wrap`, no indent and no absolute layer. The ghost and
    // the parked caret are inline siblings, so they wrap with the command and read as one line.
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
      // An IME is mid-word: the buffer is not a command yet, and touching it would break the
      // composition. One input is emitted from `compositionend` instead.
      if (this.composing) return;
      if (!this.cfg.multiline) this.stripNewlines();
      hooks.onInput();
    };
    dis.listen(this.ta, "input", emitInput);
    dis.listen(this.cmd, "input", emitInput);
    for (const node of [this.ta, this.cmd] as HTMLElement[]) {
      dis.listen(node, "compositionstart", () => {
        this.composing = true;
        // The suggestion belongs to the buffer as it was BEFORE the composition; leaving it on
        // screen next to half-formed IME text is noise, and it must not be able to merge in.
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
    // plaintext-only already refuses markup, but a paste is the one place a hostile clipboard could
    // try to smuggle nodes in. Force the plain-text branch explicitly rather than trusting the flag.
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
   * Switch surfaces. IDEMPOTENT BUT NEVER A NO-OP: the DOM state is written on every call,
   * including the first one from the constructor.
   *
   * Returning early when `want === this.mode` would leave `data-mode` unwritten for a field
   * initialised to the mode the constructor asks for: `.te-plain` keeps its stylesheet default of
   * `display: none`, and the textarea sits in the document invisible, unfocusable and un-clickable.
   * Python is always plain, so Python would have no usable input at all. Only the value transfer is
   * conditional - moving text between two surfaces already in sync is pointless; the DOM write is
   * not.
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

  /** The editable node's text. It cannot contain a ghost, because a ghost is never a child of it. */
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
    // Paint BOTH hosts. Only one is displayed, but a mode switch (a resize crossing the fallback
    // threshold) must not reveal an empty prompt, and it keeps `.cli-line` meaningful either way.
    paintSegments(this.richPrefix, segments);
    paintSegments(this.plainPrefix, segments);
    // A tab with no prefix (python writes its prompt in its own gutter) must not get an empty block
    // holding a line's worth of padding above the textarea.
    this.plainPrefix.hidden = segments.length === 0;
    // In rich mode the separator between the prefix and the command is an ordinary space INSIDE the
    // flow, so it is a normal soft-wrap opportunity: the command continues on the prefix's last
    // visual line when there is room, and falls to the next line only when there genuinely isn't.
    if (segments.length) this.richPrefix.append(document.createTextNode(" "));
  }

  /**
   * THE AUTHORITATIVE BUFFER. Everything downstream - commits, the parsed selection, the copied
   * command, the retained draft - reads this. In rich mode it is the editable node's own text, and
   * the ghost is a sibling, so an unaccepted suggestion cannot appear here by construction rather
   * than by a filtering step someone can forget.
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
   * Draw the highlighted buffer.
   *
   * In rich mode the editable surface IS the highlight, so the rebuild has to preserve the user's
   * SELECTION (both ends, not just the caret) by text offset. In plain mode the <pre> overlay
   * mirrors the textarea character-for-character, exactly as it did before the extraction.
   *
   * A repaint during an IME composition is skipped entirely: rebuilding the editable DOM under a
   * live composition drops or duplicates the characters being composed. The next paint after
   * `compositionend` draws the settled text.
   */
  paint(segments: TerminalSegment[], ghost: string): void {
    if (this.composing) return; // rule 3
    const focused = this.isFocused();
    if (this.mode === "rich") {
      const sel = focused ? selectionIn(this.cmd) : null;
      paintSegments(this.cmd, segments);
      if (sel) setSelectionIn(this.cmd, sel.start, sel.end);
      // The suggestion and the parked caret live OUTSIDE `.te-cmd`. Bash shows its ghost after the
      // whole buffer, which is where the pre-extraction overlay put it.
      this.ghostLayer.textContent = ghost && focused ? ghost : "";
      this.cmd.classList.toggle("is-empty", this.cmdText() === "");
      this.cmd.dataset.placeholder = this.cfg.placeholder;
      this.placeRichCaret();
      return;
    }
    // The drawn caret sits where the REAL one is, so clicking mid-line moves the block with it.
    // It is drawn even when the editor is UNFOCUSED (parked at the end), because it is what shows
    // an untouched terminal where typing would begin - exactly one per tab, either way.
    const caretNode = el("span", { class: "te-caret" });
    const at = focused ? this.caret : this.value.length;
    replaceChildren(this.hl);
    const mk = (t: string, kind: TerminalSegment["kind"]): Node => {
      const cls = segmentClass(kind);
      return cls ? el("span", { class: cls, text: t }) : document.createTextNode(t);
    };
    // A MULTILINE buffer shows its suggestion AT THE CARET, because the caret can be on any line and
    // a ghost parked after the whole buffer would appear several lines below the word it completes.
    // A single-line buffer keeps the historical behaviour: the ghost follows the whole command.
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
   * Draw the block cursor at the caret, in the rich flow.
   *
   * A terminal's cursor is a block sitting ON the caret, not the browser's thin bar - the plain
   * fallback has always drawn one, and the python line has carried `caret-color: transparent` for
   * exactly this reason. The rich surface lost it in the extraction: the native caret was left
   * visible and the painted block was parked after the command and only shown while unfocused.
   *
   * It cannot be an inline node here. Placing one at the caret would mean splitting the EDITABLE
   * text, and nothing but the buffer may live inside `.te-cmd`. So it is measured instead: a
   * collapsed `Range` at the caret offset reports its own client rect, already resolved onto the
   * correct visual line, which is what makes the block follow the caret through a soft wrap.
   *
   * While a RANGE is selected there is no cursor - the selection is its own cue.
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
    let rect: DOMRect | null = range.getBoundingClientRect();
    // An empty buffer, or a collapsed range the engine will not measure: fall back to the command
    // span's own box, which `min-width: 1px` guarantees is present.
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const b = this.cmd.getBoundingClientRect();
      rect = b.height > 0 ? b : null;
    }
    if (!rect) return;
    this.richCaret.style.left = `${Math.round((rect.left - flowBox.left) * 100) / 100}px`;
    this.richCaret.style.top = `${Math.round((rect.top - flowBox.top) * 100) / 100}px`;
    if (rect.height > 0) this.richCaret.style.height = `${Math.round(rect.height * 100) / 100}px`;
    // The suggestion begins exactly where the block is drawn when the caret is at the end, so it
    // needs the block's width of clearance to stay readable.
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

  /**
   * Insert text at the caret, REPLACING whatever is selected - which is what a paste does. Using
   * the caret alone left the selected text in place and dropped the pasted text beside it, so
   * "select the command, paste a new one" produced both.
   */
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
