// types.ts - the package's public contract.
//
// Everything here is GENERIC. The terminal knows about text, segments, completion items and
// callbacks; it knows nothing about facets, flavours, freva-rest, or any application state. That is
// what lets a second freva-client command register a tab here without importing a browser's state.

/** How a run of text is coloured. Purely presentational - the host decides which kind a run is. */
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

/**
 * What the terminal should offer at the caret. The host owns all the semantics; the terminal only
 * renders the list / ghost and calls `apply` with the accepted value.
 */
export interface TerminalCompletion {
  /** Candidates for the browsable list (opened with ↓ or by Tab with nothing to ghost). */
  items: TerminalCompletionItem[];
  /**
   * Shown INSTEAD of a list when the values must be typed rather than chosen (e.g. a bounding
   * box). An informational row, never acceptable.
   */
  message?: string;
  /** Inline ghost text drawn after the caret; already stripped of what the user has typed. */
  ghost?: string;
  /** The FULL candidate the ghost completes to - what `apply` receives when the ghost is accepted. */
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
   * `-view`, `-fixed`, `-gutter`, `-ml`). Defaults to `id`. Set it when a host stylesheet already
   * addresses those surfaces under a different name.
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
   * The IMMUTABLE prefix. It shares ONE normal inline text flow with the editable command, so the
   * command starts immediately after the last prefix token at every wrap width.
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
   * Commit the buffer. `final` is true for Enter / blur, when the in-progress token under the caret
   * should count. Return `dirty: true` to keep the raw buffer on screen instead of re-syncing it
   * from `text()` - that is what lets a rejected or half-typed draft survive a re-render.
   */
  commit(text: string, caret: number, final: boolean): { dirty: boolean; warning?: string };
  /** What the copy button copies for this tab. */
  copyText(): string;
  /**
   * A counter the host bumps when ITS OWN state changed outside the terminal (a chip removed, a
   * "clear all"). On a change the buffer is rebuilt from `text()` even while focused or dirty -
   * otherwise a stale draft re-commits filters the user just cleared. Anything that should survive
   * that rebuild is returned by `retain`.
   */
  revision?(): number;
  /** Given the live buffer, the part that must survive an external rebuild. */
  retain?(text: string): string;
}

/** Persistence for the colour/opacity settings. Host-owned, so the package stores nothing itself. */
export interface TerminalStorage {
  getTheme(): string | null;
  setTheme(id: string): void;
  getAlpha(): number | null;
  setAlpha(alpha: number): void;
}

export interface TerminalMenuItem {
  label: string;
  /** Rendered as a link when set (opened in a new tab, `rel="noopener noreferrer"`). */
  href?: string;
  onSelect?: () => void;
}

export interface TerminalOptions {
  tabs: TerminalTab[];
  activeTab?: string;
  /**
   * Window-control style, surfaced verbatim as `data-os` on the root so the stylesheet can render
   * macOS dots, Windows buttons or Linux symbolic controls. Free-form: an unrecognised value simply
   * gets the default treatment.
   */
  os?: string;
  /** Extra rows appended to the settings (⋮) menu. */
  menuItems?: TerminalMenuItem[];
  storage?: TerminalStorage;
  /**
   * Which attribute carries hover help. Defaults to the native `title`, which is right for
   * standalone use. A host with its own tooltip system passes ITS attribute (the data browser uses
   * `data-tip`) so the terminal's help renders in the host's style instead of raising a second,
   * slower, unstyled native popup beside it.
   */
  tooltipAttribute?: string;
  /**
   * Force the plain-textarea fallback (narrow viewports, hostile environments). Consulted on every
   * render, so a resize can switch modes.
   */
  fallback?: () => boolean;
  /**
   * The element the window is positioned and clamped WITHIN. Defaults to the mount target. All
   * geometry is container-relative, so an embedded host that relocates/clips the mount still gets a
   * terminal that stays inside its component.
   */
  bounds?: () => HTMLElement | null;
  onTabChange?: (id: string) => void;
  /** Editor focus entered/left, so a host can mirror it into its own state. */
  onFocusChange?: (focused: boolean) => void;
  onClose?: () => void;
  /** Called when the clipboard is genuinely unavailable, so the host can surface its own message. */
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
