/**
 * console-types.ts - the console's public contract. Separate from the engine's `types.ts` and
 * importing only types from it: that separation is the package boundary in file form, so
 * `import "@freva-org/browser-python"` can never drag in jQuery.
 */

import { MAX_TRANSCRIPT_CHARS } from "../transcript-limit.js";
import type {
  BrowserPython,
  BrowserPythonAddon,
  BrowserPythonProfile,
  BrowserPythonReadyInfo,
} from "../types.js";

/** Where command history is kept. `none` disables persistence AND recall. */
export type HistoryPersistence = "local" | "session" | "memory" | "none";

export interface ConsoleHistoryOptions {
  enabled?: boolean;
  /** `local` survives the tab; `session` dies with it; `memory` never touches storage at all. A
   * shared or kiosk machine wants `session` or `memory`: history is code somebody typed, and that
   * can include a URL, a path, or a token pasted by mistake. The default is `local`. */
  persistence?: HistoryPersistence;
  /** Namespace. Two consoles on one page with different keys keep separate histories. */
  key?: string;
  maxEntries?: number;
  /** Ghost-text suggestion from the most recent entry starting with what is typed. */
  prefixAutocomplete?: boolean;
  /** Up/Down filter to entries matching the typed prefix, rather than plain chronology. */
  prefixNavigation?: boolean;
  reverseSearch?: boolean;
}

export interface ConsoleOutputOptions {
  /** Executions retained before the oldest are pruned. */
  maxEntries?: number;
  /** Characters retained across the transcript, as a second bound on one enormous execution. */
  maxCharacters?: number;
}

export interface ConsoleHighlightOptions {
  enabled?: boolean;
  /** Highlight the command as it is typed. Disable independently on very slow devices. */
  live?: boolean;
  /** Keep submitted commands highlighted in the transcript. */
  submittedCommands?: boolean;
  language?: "python";
}

export type ConsoleTheme = "auto" | "dark" | "light";

/** One run of console text, tagged with what it means rather than with a colour. */
export interface ConsoleTextOutput {
  kind: "command" | "stdout" | "stderr" | "result" | "status" | "fatal";
  text: string;
  executionId?: string;
  /**
   * For a command, the prompt it was entered at. Rendered as a literal prefix so a continuation
   * line is identifiable WITHOUT relying on colour or indentation.
   */
  prompt?: ">>> " | "... ";
  /**
   * Tokenise as Python before rendering. True only for commands: stdout, tracebacks and results
   * keep their semantic console colours, and highlighting a traceback as Python would colour a
   * filename as a string.
   */
  highlight?: boolean;
}

export interface ConsoleDisplayOutput {
  mime: string;
  encoding: "base64" | "utf8";
  data: string;
  executionId?: string;
  metadata?: { figure?: number; width?: number; height?: number };
}

/** The console surface, abstracted. The public element depends on THIS and never on jQuery
 * Terminal, so the library underneath can be replaced without a consumer noticing: it is 93 KiB
 * gzipped and Pyodide's own console is considering a move away from it. */
export interface ConsoleSurfaceAdapter {
  mount(host: HTMLElement): void;
  setPrompt(prompt: ">>> " | "... "): void;
  setBusy(busy: boolean): void;
  setCommand(value: string): void;
  getCommand(): string;
  /** Caret offset in the current command, for completion. */
  getCursor(): number;
  setCursor(position: number): void;
  insert(value: string): void;
  appendText(output: ConsoleTextOutput): void;
  appendDisplay(output: ConsoleDisplayOutput): void;
  clear(): void;
  /** Drop entries from the OLDEST end until the transcript is within both limits, and say how
   * many. Separate from `clear()`: clearing on an overrun of one entry throws away the newest
   * output - the output the visitor was reading - with the oldest. */
  trim(limits: { keepEntries: number; keepCharacters: number }): number;
  focus(): void;
  /** One execution is over: every output batch is in, the prompt is current, input is live
   * again. Separate from `setBusy(false)`, which is about whether the terminal accepts a
   * keystroke; this is about whether the reader can SEE the place they would type into. A surface
   * that scrolls on output alone lands a prompt-height short of the final size. */
  settle(options: { focus: boolean }): void;
  /** Return to following the bottom, and go there. What a `Jump to latest` control calls. */
  followLatest(): void;
  /**
   * Draw `text` as unaccepted ghost text at the caret, or clear it with `""`. Returns whether the
   * surface could; one that cannot put a node inside its own command line answers `false`, and
   * the console falls back to the suggestion beside the prompt. The text is never part of the
   * buffer - `getCommand()` must not return it and submitting must not run it, because a
   * suggestion a keystroke can absorb is how a console runs a line nobody typed.
   */
  setGhost?(text: string): boolean;
  /** Put `element` directly beneath the command line, in the transcript's own flow, for the
   * completion menu - where a shell puts it, scrolling with the transcript, rather than in a fixed
   * bar a long way from the caret. Returns whether the surface could. */
  anchorBelowCommand?(element: HTMLElement): boolean;
  /** The element the transcript scrolls in. Optional: not every surface has one. */
  scroller?(): HTMLElement | null;
  destroy(): void;
}

/** A renderer for one MIME type. Must build DOM nodes; must never be handed a string to parse. */
export type DisplayRenderer = (
  output: ConsoleDisplayOutput,
  context: { document: Document; track(url: string): void },
) => HTMLElement | null;

/** How much of the console's own toolbar to draw. `full` is the default; `status` keeps the
 * status line and drops the action buttons, for a host whose own window chrome already offers
 * Clear, Clear history and Restart; `none` removes the strip entirely. */
export type ConsoleToolbarMode = "full" | "status" | "none";

export interface BrowserPythonConsoleElement extends HTMLElement {
  /** An engine supplied by the host. When set, the element SUBSCRIBES but does not own: it will
   * not dispose the engine on disconnect, because the host may have three components sharing one
   * interpreter. Reads back `undefined` before one exists, which is why the type is a union - an
   * accessor cannot be optional, and the setter handles an assigned `undefined`. */
  engine: BrowserPython | undefined;
  autoStart: boolean;
  profile: BrowserPythonProfile;
  historyOptions: ConsoleHistoryOptions;
  outputOptions: ConsoleOutputOptions;
  highlightOptions: ConsoleHighlightOptions;
  theme: ConsoleTheme;
  /** A plain-text greeting, or `false` for none. Never HTML - see the security notes. */
  banner: string | false;
  /** `true` is exactly `toolbarMode === "none"`. */
  hideToolbar: boolean;
  toolbarMode: ConsoleToolbarMode;

  /**
   * What the RUNNING interpreter reported at start, or `null` when none is running. Read-only,
   * and an observation rather than a restatement: which profile came up, which add-ons were
   * prepared and at which versions, which packages loaded, whether the workspace is disk-backed
   * here - otherwise a host's diagnostics panel prints its own configuration back and calls it a
   * description of the session. `null` before `start()` resolves, after a failed start, between a
   * `restart()` and the new interpreter's readiness, and after `dispose()`.
   */
  readonly readyInfo: BrowserPythonReadyInfo | null;
  /** Curated add-ons to prepare. Set before `start()`; the engine is built once. */
  addons: readonly BrowserPythonAddon[] | undefined;
  /** The subset of `addons` whose absence must not stop the interpreter. */
  optionalAddons: readonly BrowserPythonAddon[] | undefined;

  start(): Promise<void>;
  /** Run a source block the way pasting it would: file semantics unless it is a single line. */
  execute(source: string): Promise<void>;
  /**
   * Run a registered example: a labelled divider, the source, and ONE execution as a file. Always
   * file semantics, whatever the length, and nothing about the session is reset.
   */
  runExample(example: { title: string; source: string }): Promise<void>;
  /** The visible transcript as plain text, bounded by `outputOptions`. */
  transcript(): string;
  focus(): void;
  clear(): void;
  clearHistory(): void;
  restart(): Promise<void>;
  dispose(): void;
}

export const DEFAULT_HISTORY_OPTIONS: Required<ConsoleHistoryOptions> = {
  enabled: true,
  persistence: "local",
  key: "browser-python",
  maxEntries: 500,
  prefixAutocomplete: true,
  prefixNavigation: true,
  reverseSearch: true,
};

export const DEFAULT_OUTPUT_OPTIONS: Required<ConsoleOutputOptions> = {
  maxEntries: 500,
  maxCharacters: MAX_TRANSCRIPT_CHARS,
};

export const DEFAULT_HIGHLIGHT_OPTIONS: Required<ConsoleHighlightOptions> = {
  enabled: true,
  live: true,
  submittedCommands: true,
  language: "python",
};

/** The greeting. Plain text, deliberately not branded, and deliberately short: a real `python3`
 * says two lines and gets out of the way, and six lines of explanation before the first prompt is
 * more than most sessions produce. The version line is NOT here - it is printed on ready, from
 * what the interpreter reports, because a version in a constant goes stale silently. */
export const DEFAULT_BANNER = "Enter runs · Tab completes · ↑ history · Ctrl+R search";
