// types.ts - the package's public contract. Everything here is GENERIC: text, segments, completion
// items and callbacks, never facets, flavours, freva-rest or application state - so a second
// freva-client command can register a tab without importing a browser's state.

/** How a run of text is coloured. Purely presentational - the host picks the kind. */
export type SegmentKind =
  | "plain"
  | "prompt"
  /** A read-only continuation prompt (python's `...`) - quieter than a real prompt. */
  | "contprompt"
  | "fixed"
  | "accent"
  | "muted"
  | "key"
  | "eq"
  | "value"
  | "bad";

/** One inline run of text. `text` reaches the DOM through textContent - never innerHTML. */
export interface TerminalSegment {
  text: string;
  kind?: SegmentKind;
}

/** One row in the completion menu. */
export interface TerminalCompletionItem {
  value: string;
  /** Right-aligned count, when the host has one. */
  count?: number | null;
}

/** What to offer at the caret. The terminal renders the list / ghost, calling `apply` on accept. */
export interface TerminalCompletion {
  /** Candidates for the browsable list (opened with ↓ or by Tab with nothing to ghost). */
  items: TerminalCompletionItem[];
  /** Shown INSTEAD of a list when values must be typed (e.g. a bounding box). Never acceptable. */
  message?: string;
  /** Inline ghost text drawn after the caret; already stripped of what the user has typed. */
  ghost?: string;
  /** The FULL candidate the ghost completes to - what `apply` receives on acceptance. */
  ghostValue?: string;
  /** Produce the replacement buffer for an accepted value. */
  apply(value: string): { text: string; caret: number };
}

/** One tab: an independent editable buffer with its own prefix, highlighting and completions. */
export interface TerminalTab {
  /** Stable id (used for the active-tab model and callbacks). */
  id: string;
  /** Visible tab label. */
  label: string;
  /**
   * Class-name prefix for this tab's surfaces (`.${cssPrefix}-input`, `-hl`, `-wrap`, `-menu`,
   * `-view`, `-fixed`, `-gutter`, `-ml`). Defaults to `id`; set when the host stylesheet differs.
   */
  cssPrefix?: string;
  /** CONSTANT svg markup for the tab icon. Never data-derived - it is assigned with innerHTML. */
  icon?: string;
  /** A multi-line buffer (newlines are meaningful) rather than one logical shell line. */
  multiline?: boolean;
  placeholder?: string;
  /** Accessible name for the editable region. */
  ariaLabel?: string;
  /**
   * The IMMUTABLE prefix. Shares ONE inline text flow with the editable command, so the command
   * starts immediately after the last prefix token at every wrap width.
   */
  prefix(): TerminalSegment[];
  /** Read-only lines rendered above the editable line. */
  headerLines?(): TerminalSegment[][];
  /** Read-only lines rendered below the editable line. */
  footerLines?(): TerminalSegment[][];
  /** The buffer text derived from the host's own state (used to re-sync a clean, unfocused tab). */
  text(): string;
  /** Colourise the buffer; an optional warning is shown under the prompt. */
  highlight(text: string): { segments: TerminalSegment[]; warning?: string };
  /** Completion at `caret`, or null when there is nothing to offer. */
  complete(text: string, caret: number): TerminalCompletion | null;
  /**
   * Commit the buffer. `final` is true for Enter / blur, when the caret's in-progress token counts.
   * `dirty: true` keeps the raw buffer, not a re-sync from `text()`, so a rejected draft survives.
   */
  commit(text: string, caret: number, final: boolean): { dirty: boolean; warning?: string };
  /** What the copy button copies for this tab. */
  copyText(): string;
  /**
   * A counter the host bumps when ITS OWN state changed outside the terminal (a chip removed, a
   * "clear all"). The buffer is then rebuilt from `text()` even while focused or dirty, so a stale
   * draft cannot re-commit filters the user just cleared; `retain` names what survives the rebuild.
   */
  revision?(): number;
  /** Given the live buffer, the part that must survive an external rebuild. */
  retain?(text: string): string;
}

/** Persistence for the appearance settings. Host-owned, so the package stores nothing itself. */
export interface TerminalStorage {
  getTheme(): string | null;
  setTheme(id: string): void;
  getAlpha(): number | null;
  setAlpha(alpha: number): void;
  /** The text-size multiplier. Optional: a storage without it compiles and forgets the size. */
  getTextScale?(): number | null;
  setTextScale?(scale: number): void;
}

export interface TerminalMenuItem {
  label: string;
  /** Rendered as a link when set (opened in a new tab, `rel="noopener noreferrer"`). */
  href?: string;
  onSelect?: () => void;
  /** Drawn in the warning colour: for a row that throws state away. */
  danger?: boolean;
  /** Present but not selectable - a row whose action does not apply right now. */
  disabled?: boolean;
  /**
   * One line of hover help, on the host's own tooltip attribute. For a row whose LABEL names the
   * control rather than describing it: "Restart session…" does not say what it does.
   */
  title?: string;
  /**
   * THE WINDOW'S OWN APPEARANCE CONTROLS, placed by the host, as a row that opens to the side.
   * The colour swatches, opacity slider and text size are widgets, not rows, so a host cannot
   * express them in this list; an item with this flag becomes their trigger, drawn by the window
   * with the item's own `label` wherever the host put it. A flag rather than a section kind
   * because it IS one row.
   *
   * `href`, `onSelect` and `danger` are ignored on such an item; `disabled` is honoured. With no
   * such item the appearance group is drawn first, as an open inline disclosure.
   */
  appearance?: boolean;
}

/**
 * A labelled run of menu rows, grouping a host's actions ("Session", "Transcript"). The window's
 * appearance controls are widgets, not rows, and live on `TerminalMenuItem.appearance` instead.
 */
export interface TerminalMenuSection {
  /** Heading above the rows. Omit for an unlabelled run. */
  title?: string;
  items: TerminalMenuItem[];
}

/**
 * Everything the WINDOW accepts - the frame with nothing inside it. A content layer
 * (`createTerminal`, or a host embedding a console) supplies the body and answers what the frame
 * cannot: what "copy" copies, and what a click on empty body space focuses.
 */
export interface TerminalWindowOptions {
  /**
   * Window-control style, surfaced verbatim as `data-os` on the root: the stylesheet draws macOS
   * dots, Windows buttons or Linux symbolic controls. Free-form; unknown values get the default.
   */
  os?: string;
  storage?: TerminalStorage;
  /**
   * Which attribute carries hover help. Defaults to the native `title`. A host with its own
   * tooltip system passes ITS attribute (the data browser uses `data-tip`) so the help renders in
   * the host's style instead of raising a second, unstyled native popup beside it.
   */
  tooltipAttribute?: string;
  /**
   * The element the window is positioned and clamped WITHIN. Defaults to the mount target. All
   * geometry is container-relative, so a host that relocates or clips the mount still contains it.
   */
  bounds?: () => HTMLElement | null;
  /**
   * Which side the window's own close/minimise/maximise cluster sits on. Default `start` (left).
   * `os` decides how those controls LOOK and in what order; this decides where they are. Following
   * the reader's OS for POSITION would put one product's close button on different edges for two
   * people looking at it together; `end` is there for a host that wants the desktop convention.
   */
  controlsSide?: "start" | "end";
  /** Draw the footer strip. Omit for a window whose content owns the whole body. */
  foot?: boolean;
  /**
   * A selector for the host's OWN title-bar controls, so pressing one does not start a drag.
   * The window already excludes its traffic lights, copy button and ⋮ menu.
   */
  dragExclude?: string;
  /** What the copy control copies. Omit and the control is not drawn at all. */
  copyText?: () => string;
  /** The copy control's resting word (default `copy`) and its hover help. */
  copyLabel?: string;
  copyTitle?: string;
  /** Accessible name for the close control, when "Close" is not the right word (e.g. "Hide"). */
  closeLabel?: string;
  /** Rows appended to the ⋮ menu, below the appearance group. */
  menuItems?: TerminalMenuItem[];
  /** The same, grouped under headings. Rendered before `menuItems`. */
  menuSections?: TerminalMenuSection[];
  onClose?: () => void;
  /** The clipboard is genuinely unavailable, so the host can surface its own message. */
  onCopyFailed?: (message: string) => void;
  onShow?: () => void;
  onHide?: () => void;
  onMinimize?: (minimized: boolean) => void;
  onMaximize?: (maximized: boolean) => void;
  /** The window's box changed - a drag-resize, a viewport resize, a text-size change. */
  onResize?: () => void;
  /** A press on empty body space. In a terminal this means "focus the prompt". */
  onBodyActivate?: () => void;
}

/**
 * A question the window asks before an action the visitor cannot undo. Deliberately narrow - a
 * title, a body, two buttons, not a general dialog API: predictable enough to answer at a glance.
 */
export interface TerminalConfirmRequest {
  /** One line, in the imperative. Becomes the dialog's accessible name. */
  title: string;
  /** What happens if they say yes, including what is lost. Becomes its accessible description. */
  body: string;
  /** Defaults to `Cancel`. Always the initially focused control. */
  cancelLabel?: string;
  /** Defaults to `Confirm`. Names the action rather than agreeing - `Restart session`, not `OK`. */
  confirmLabel?: string;
  /** Render the confirming button as destructive. For actions that lose state. */
  danger?: boolean;
  /** Where the focus goes afterwards. Defaults to the menu row or control that raised it. */
  returnFocus?: HTMLElement | null;
}

/** What `createTerminalWindow` hands back. */
export interface TerminalWindowHandle {
  /** The window root (already appended to the mount). */
  readonly el: HTMLElement;
  /** The title bar. Three slots: `barStart`, `barSpacer`, `barEnd`. */
  readonly bar: HTMLElement;
  /** The flexible gap between the two groups. Inserting before it still lands in the left group. */
  readonly barSpacer: HTMLElement;
  /** The left group: the window controls (by default) and whatever the host puts beside them. */
  readonly barStart: HTMLElement;
  /** The right group: copy, the host's own controls, and the ⋮ menu last. */
  readonly barEnd: HTMLElement;
  /**
   * Put a host control in the title bar, on the side it belongs. Preferred over reaching into
   * `bar` directly: it is the only route that keeps the ⋮ menu last in the row.
   */
  addBarControl(node: HTMLElement, side?: "start" | "end"): void;
  /** The content slot. Everything a host draws goes in here. */
  readonly body: HTMLElement;
  /** The footer strip, when `foot` was asked for. */
  readonly foot: HTMLElement | null;
  /** The ⋮ menu, for a host that needs to measure or scope-query it. */
  readonly settings: HTMLElement;
  show(): void;
  hide(): void;
  toggle(force?: boolean): void;
  isShown(): boolean;
  isMinimized(): boolean;
  setMinimized(minimized: boolean): void;
  isMaximized(): boolean;
  setMaximized(maximized: boolean): void;
  closeSettings(): void;
  /** Replace the host's half of the ⋮ menu. */
  setMenuSections(sections: readonly TerminalMenuSection[]): void;
  /**
   * Ask a yes/no question inside the window and resolve with the answer, in place of
   * `window.confirm()`. Closes the ⋮ menu, focuses Cancel, traps Tab between the two buttons,
   * cancels on Escape, and hands focus back to the control that raised it. A second call while one
   * is open resolves `false` immediately rather than stacking, so a double press cannot act twice.
   */
  confirm(request: TerminalConfirmRequest): Promise<boolean>;
  applyTheme(id: string): void;
  applyAlpha(alpha: number): void;
  applyTextScale(scale: number): void;
  resetAppearance(): void;
  /** Re-evaluate the narrow-window class. */
  fitBar(): void;
  /** Re-home `title` onto the host's tooltip attribute, after the host appends its controls. */
  applyTooltips(): void;
  destroy(): void;
}

export interface TerminalOptions {
  tabs: TerminalTab[];
  activeTab?: string;
  /**
   * Window-control style, surfaced verbatim as `data-os` on the root: the stylesheet draws macOS
   * dots, Windows buttons or Linux symbolic controls. Free-form; unknown values get the default.
   */
  os?: string;
  /** Extra rows appended to the settings (⋮) menu. */
  menuItems?: TerminalMenuItem[];
  storage?: TerminalStorage;
  /**
   * Which attribute carries hover help. Defaults to the native `title`. A host with its own
   * tooltip system passes ITS attribute (the data browser uses `data-tip`) so the help renders in
   * the host's style instead of raising a second, unstyled native popup beside it.
   */
  tooltipAttribute?: string;
  /** Force the plain-textarea fallback. Consulted on every render, so a resize can switch modes. */
  fallback?: () => boolean;
  /**
   * The element the window is positioned and clamped WITHIN. Defaults to the mount target. All
   * geometry is container-relative, so a host that relocates or clips the mount still contains it.
   */
  bounds?: () => HTMLElement | null;
  onTabChange?: (id: string) => void;
  /** Editor focus entered/left, so a host can mirror it into its own state. */
  onFocusChange?: (focused: boolean) => void;
  onClose?: () => void;
  /** The clipboard is genuinely unavailable, so the host can surface its own message. */
  onCopyFailed?: (message: string) => void;
}

export interface TerminalHandle {
  /** The window root (already appended to the mount). */
  readonly el: HTMLElement;
  /** Re-read the host's state: prefixes, read-only lines and clean buffers. */
  render(): void;
  toggle(force?: boolean): void;
  isShown(): boolean;
  focusEditor(): void;
  activeTab(): string;
  setActiveTab(id: string): void;
  destroy(): void;
}
