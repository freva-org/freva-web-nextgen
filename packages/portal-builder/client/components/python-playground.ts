/**
 * The portal's Python playground: one window, up to two interpreters, and no Python of its own.
 *
 * `@freva-org/dataset-tree` reports a "Try in Python" press as `{ exampleId, digest, datasetId }` -
 * a NAME, never a program. This layer turns that name into a running snippet: it owns the window,
 * the session, the queue and the lifetime. It is written against the generic packages, so any
 * portal-builder site gets it by writing `python: { enabled: true }`.
 *
 * Everything heavy is behind a dynamic `import()`: the terminal window, the console element, and
 * through it jQuery, jQuery Terminal and Prism. A page that never presses downloads none of it, and
 * a page with the playground DISABLED does not contain this module at all - the generated entry
 * imports it only when a landing block asked for one, which `tests/artifact/` checks against the
 * built output.
 *
 * It never sends Python anywhere. A press is resolved against the registry this page was built
 * with; an id nobody registered, or a digest from another build, is refused and said so. The same
 * holds across an origin boundary: `@freva-org/browser-python/embed`'s bridge carries
 * `{ exampleId, digest, targetSession }` and has nowhere in it to put source.
 */

import { mountLayer, type Layer } from "../layers.js";
import { adoptPlaygroundStyles } from "./python-playground-styles.js";
import type { ChunkLoader } from "./python-chunks.js";
// TYPE-ONLY, both of them. An `import type` is erased entirely, so naming the window's and the
// bridge's shapes here costs the bundle nothing: every VALUE from these packages arrives through
// the dynamic `import()`s below.
import type { TerminalMenuSection, TerminalWindowHandle } from "@freva-org/freva-client-terminal";
// TYPE-ONLY, and it has to stay that way. A VALUE import from this package - even a single
// number - is a static edge to `@freva-org/browser-python`, and the bundler may place that number
// in any chunk; in the console's chunk it drags the whole interpreter back into the framed
// parent's graph. The parent only needs to know a transcript was cut, which the message says.
import type { BridgeOp, EmbeddedArtifact, PlaygroundHost } from "@freva-org/browser-python/embed";
// The shapes both halves agree on. The bridge holds them because both halves import the bridge.
import type {
  ExampleBinder,
  ExampleSource,
  PlaygroundState,
  PythonPlaygroundConfig,
  TryPythonRequest,
} from "../python-bridge.js";
import { pythonBlocks } from "../python-bridge.js";

export type { ExampleSource, PlaygroundState, PythonPlaygroundConfig, TryPythonRequest };

export interface PythonPlayground {
  /** Handle a press. Resolves the name, opens the window if needed, and runs it. */
  run(request: TryPythonRequest): void;
  /**
   * Show the prompt with no example, and start an interpreter. `focus` moves the keyboard focus
   * into the window and defaults to NOT doing so, because a window that appeared because
   * `autostart: immediately` is configured was not asked for by anyone. The launcher and a run
   * control both pass `true`, because both are a request.
   */
  open(options?: { focus?: boolean }): void;
  /**
   * Bring the interpreter up WITHOUT showing anything - what `autostart: after-interactive` means.
   * The download and the startup happen while the page is idle, so the first press is instant.
   */
  warm(): Promise<void>;
  /** The current state, for a launcher or a status line. */
  state(): PlaygroundState;
  /** Subscribe to it. The listener is called immediately with the current value. */
  onState(listener: (state: PlaygroundState) => void): void;
  destroy(): void;
}

const STORAGE_PREFIX = "portal-python-terminal";

/** The part of `BrowserPythonReadyInfo` the package help reads. Structural: nothing is imported. */
interface ReadyReport {
  profile: string;
  pythonVersion: string;
  pyodideVersion: string;
  packages: Readonly<Record<string, string>>;
  addons: readonly { id: string; title: string; versions: Record<string, string> }[];
  unavailableAddons: readonly {
    id: string;
    title: string;
    reason: string;
    remedy: string;
    retryMayHelp: boolean;
  }[];
  workspace: { available: boolean; maxFiles?: number; detail?: string };
}

/**
 * A session: one interpreter, its console, and the tab that selects it. A LOCAL session is a
 * `<freva-python-console>` on the portal's own origin; a FRAMED session is an iframe on the
 * configured playground origin, driven through the two-origin bridge. A public deployment should
 * want the second - visitor Python otherwise runs with the portal's origin authority - and the
 * difference is confined to this interface so nothing above it has to branch.
 */
interface Session {
  readonly id: string;
  label: string;
  /** The element that fills the window body when this session is active. */
  readonly root: HTMLElement;
  /**
   * Bring the interpreter up, and run `initialSource` into it. Idempotent, and it resolves only
   * when BOTH have happened - which is what makes the ordering rule true rather than likely:
   * everything that runs Python awaits this first, so a queued example cannot reach the
   * interpreter before the portal's own opening lines have.
   */
  start(): Promise<void>;
  /** Whether `start()` has completed. For the launcher's status line. */
  started(): boolean;
  /** Run a registered example. Local sessions run it; framed ones ask their frame to. */
  runExample(request: TryPythonRequest, example: ExampleSource): Promise<void>;
  /** Plain-text transcript, or `null` when this session's transcript is not reachable. */
  transcript(): string | null;
  clearTranscript(): void;
  clearHistory(): void;
  restart(): Promise<void>;
  /**
   * Files this session's workspace holds, when the portal can know about them. Empty for a LOCAL
   * session: the console draws its own file panel, and a second list in the window's menu would be
   * two places to look with nothing saying which is authoritative. A framed session has no panel
   * the portal can show, so this is where its files appear.
   */
  artifacts(): { name: string; size: number; state: string }[];
  /**
   * What the running interpreter REPORTED, or null when none runs or it cannot be seen. An
   * observation, not a restatement of the configuration: which packages actually loaded, which
   * add-ons were prepared, whether the workspace is disk-backed. Null for a framed session, whose
   * embed bridge announces readiness without a payload; the help panel omits what it cannot see.
   */
  ready(): ReadyReport | null;
  /**
   * Save one of them, from the visitor's own click on a parent-origin control. MUST be called
   * synchronously from that click: the native save picker needs the activation, and an activation
   * does not survive an `await`. The bytes then stream through the bridge with one acknowledgement
   * per chunk, so the whole file is never in the portal's memory - hence no `Blob`.
   */
  download(name: string): Promise<void>;
  focus(): void;
  dispose(): void;
}

/** Remember the window's appearance in this browser, when the portal asked us to. */
function appearanceStorage(remember: boolean) {
  const read = (key: string): string | null => {
    if (!remember) return null;
    try {
      return localStorage.getItem(`${STORAGE_PREFIX}:${key}`);
    } catch {
      // a browser with site data blocked is not a browser with a broken terminal
      return null;
    }
  };
  const write = (key: string, value: string): void => {
    if (!remember) return;
    try {
      localStorage.setItem(`${STORAGE_PREFIX}:${key}`, value);
    } catch {
      // the setting is a convenience; failing to keep it is not worth an error
    }
  };
  const number = (key: string): number | null => {
    const raw = read(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return {
    getTheme: () => read("theme"),
    setTheme: (id: string) => write("theme", id),
    getAlpha: () => number("alpha"),
    setAlpha: (a: number) => write("alpha", String(a)),
    getTextScale: () => number("scale"),
    setTextScale: (s: number) => write("scale", String(s)),
  };
}

/** `auto` asks the platform; anything else is what the portal said. */
function osControls(configured: PythonPlaygroundConfig["terminal"]["osControls"]): string {
  if (configured !== "auto") return configured;
  const platform = navigator.platform || navigator.userAgent || "";
  if (/Mac|iPhone|iPad/i.test(platform)) return "mac";
  if (/Win/i.test(platform)) return "windows";
  return "linux";
}

export function createPythonPlayground(
  config: PythonPlaygroundConfig,
  sources: ReadonlyMap<string, ExampleSource>,
  /**
   * How this topology fetches its heavy code, chosen by the BUILD and passed in rather than
   * decided here: a branch in this module would put both topologies' dependencies in every
   * build's graph. See `./python-chunks.ts`.
   */
  loadChunks: ChunkLoader,
  /**
   * Per-example template binders, contributed by the providers that registered them. Empty for
   * every provider whose examples are already programs, which is all of them except a live
   * dataset tree. See `ExampleBinder`.
   */
  binders: ReadonlyMap<string, ExampleBinder> = new Map(),
): PythonPlayground {
  adoptPlaygroundStyles();
  /** Digests by composed example id, so a press can be checked against what the build hashed. */
  const digests = new Map(config.examples.map((e) => [e.id, e.sha256] as const));
  const maxSessions = Math.max(1, Math.min(2, config.maxSessions));

  let layer: Layer | null = null;
  let win: TerminalWindowHandle | null = null;
  let opening: Promise<void> | null = null;
  let destroyed = false;

  // What a launcher needs to know, and nothing more. The launcher lives in the light entry - it
  // has to exist before any of this is loaded, or a portal with no runnable examples would have no
  // way to reach the prompt it was promised - so it cannot read this module's variables.
  const listeners = new Set<(state: PlaygroundState) => void>();
  let statusLine = "";
  /** The engine's own state name, for the row's tone. `ready`, `loading`, `busy`, `error`, … */
  let statusState = "idle";

  function state(): PlaygroundState {
    return {
      shown: Boolean(win?.isShown()),
      minimized: Boolean(win?.isMinimized()),
      sessions: sessions.length,
      maxSessions,
      started: sessions.filter((session) => session.started()).length,
      status: statusLine,
    };
  }

  function publish(status?: string): void {
    if (status !== undefined) statusLine = status;
    renderStatusRow();
    const snapshot = state();
    for (const listener of listeners) listener(snapshot);
  }

  /**
   * The window's status row: what Python is doing, and how many interpreters are doing it. Present
   * only while it has something to say, so a ready single-session window is a title bar and a
   * terminal and nothing between them. The session count appears only once there are two.
   */
  function renderStatusRow(): void {
    if (!statusRow || !statusLabelEl) return;
    const parts: string[] = [];
    if (statusLine) parts.push(statusLine);
    if (sessions.length > 1) parts.push(`${sessions.length} sessions`);
    const text = parts.join(" · ");
    statusLabelEl.textContent = text;
    statusRow.hidden = text === "";
    statusRow.dataset.state = statusState;
  }

  const sessions: Session[] = [];
  let active = 0;
  const tabs: HTMLButtonElement[] = [];
  let tabStrip: HTMLElement | null = null;
  /**
   * The control that opens a session, beside the tabs. The ⋮ menu carries the same action four
   * rows down, a long reach for the second most common thing anybody does with a tabbed terminal.
   * The menu row stays: it is where a keyboard visitor navigating by menu looks, and where the
   * confirmation is explained.
   */
  let addTab: HTMLButtonElement | null = null;
  let notice: HTMLElement | null = null;
  /** The keyboard-shortcut / package-install panel, while one is open. */
  let sheet: HTMLElement | null = null;
  /** Removes the outside-click listener that dismisses the open sheet. Null when none is open. */
  let sheetDismiss: (() => void) | null = null;
  /**
   * The window's own compact status row, and the session area under it. The console's own toolbar
   * strip is off (`toolbar: "none"`) - a light bar inside a dark window is two chromes for one
   * window - so what it has to say arrives here as an event, rendered in the window's colours, in
   * a row that is only present while there is something to say.
   */
  let statusRow: HTMLElement | null = null;
  let statusLabelEl: HTMLElement | null = null;
  let sessionHost: HTMLElement | null = null;
  /**
   * Where the focus was when the window was revealed, so hiding can put it back. A window that
   * takes the focus and then drops it on the document body leaves a keyboard visitor at the top of
   * the page with no idea where they were - the most common way an overlay is unusable by keyboard.
   */
  let focusBefore: HTMLElement | null = null;
  /** Detaches the visual-viewport listeners, so a destroyed playground leaves none behind. */
  let viewportListeners: (() => void) | null = null;
  /** Watches the window's theme attribute so the consoles follow it. Disconnected on destroy. */
  let themeObserver: MutationObserver | null = null;
  /** Unique per playground, so two of them on one page cannot mint the same element ids. */
  const idBase = `portal-python-${Math.random().toString(36).slice(2, 8)}`;

  // resolution

  /**
   * Turn a press into something runnable, or into a reason. Checked HERE as well as in the tree,
   * and again in the interpreter's own bridge when there is one: the tree's check decides whether
   * to draw a button, this one decides whether to run anything. A button is drawn from data the
   * page holds, and a press may arrive from a stale render, a replayed event, or the DOM.
   */
  function resolve(request: TryPythonRequest): { example: ExampleSource } | { reason: string } {
    const id = request?.exampleId;
    if (typeof id !== "string" || id.length === 0) {
      return { reason: "the request named no example" };
    }
    const expected = digests.get(id);
    if (!expected) {
      return { reason: `no example is registered as “${id}” in this page` };
    }
    const given = typeof request.digest === "string" ? request.digest.trim().toLowerCase() : "";
    if (given !== expected) {
      return {
        reason:
          `the request for “${id}” carries a digest this page does not recognise, so ` +
          `something is out of step with the build`,
      };
    }
    const example = sources.get(id);
    if (!example) {
      return { reason: `“${id}” is registered but its source is not in this page` };
    }
    // A TEMPLATE gets its one hole filled by the PROVIDER that registered it. The check that
    // follows the substitution is a security boundary, deliberately in the runner as well as in
    // the provider: the provider decides what to draw, this decides what runs, so a page persuaded
    // to send a different parameter still cannot reach a store outside the configured archive.
    // Only WHICH binder is chosen elsewhere - see `ExampleBinder`. A binder refuses rather than
    // escaping: a parameter it does not recognise produces no program.
    const binder = binders.get(id);
    if (binder) {
      const bound = binder(request, example);
      if (!bound) {
        return {
          reason: `the parameter this run names is not one this page will accept, so nothing was run`,
        };
      }
      return { example: bound };
    }
    return { example };
  }

  // the window

  function announce(message: string, tone: "info" | "warn" = "info"): void {
    if (!notice) return;
    notice.textContent = message;
    notice.dataset.tone = tone;
    notice.hidden = message === "";
  }

  function syncTabs(): void {
    if (!tabStrip) return;
    // THE STRIP IS ALWAYS THERE, even with one session. It is not only a chooser - it carries the
    // control that opens a session, and a control that appears only after you have found another
    // way to do the thing it does is a control nobody will ever use. The single tab is honest: it
    // is a tab, it is selected, and pressing it does what pressing it should.
    tabStrip.hidden = false;
    const closable = sessions.length > 1;
    tabs.forEach((tab, index) => {
      const on = index === active;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
      // ROVING TABINDEX, which is what a tablist is supposed to have: one Tab press reaches the
      // strip, and the arrow keys move between tabs. Without it a visitor tabs through every
      // session before reaching the prompt.
      tab.tabIndex = on ? 0 : -1;
      const close = tab.querySelector<HTMLElement>(".portal-python-tab-close");
      // NO CLOSE ON THE LAST SESSION. Ending it would leave the window with no interpreter, no
      // prompt and no tab - a terminal that is not one. `Hide` is what closes the window.
      if (close) close.hidden = !closable;
    });
    sessions.forEach((session, index) => {
      session.root.hidden = index !== active;
    });
    if (addTab) {
      const full = sessions.length >= maxSessions;
      addTab.disabled = full;
      addTab.title = full
        ? `This page allows ${maxSessions} interpreter${maxSessions === 1 ? "" : "s"} at a time`
        : "New session";
      addTab.setAttribute("aria-label", addTab.title);
    }
  }

  /**
   * Which of the console's two checked palettes to use, from the window's own theme.
   * `data-term-light` is what the window sets when a swatch with a light background is chosen
   * (Paper is the one that ships), and the console's syntax colours are contrast-checked against
   * a light ground and against a dark one, so that attribute answers exactly this question. Set
   * on every console rather than inherited, because the element resolves it once into its shadow
   * root.
   */
  function syncConsoleTheme(): void {
    const light = win?.el.getAttribute("data-term-light") === "true";
    for (const element of sessionHost?.querySelectorAll("freva-python-console") ?? []) {
      element.setAttribute("theme", light ? "light" : "dark");
    }
  }

  /**
   * Arrow-key movement inside the tab strip, per the tabs pattern. Left/Right wrap, Home/End jump
   * to the ends, and the moved-to tab is both selected and focused - "follow focus", which is right
   * here because switching sessions is instant and has no cost.
   */
  function onTabKey(event: KeyboardEvent): void {
    const count = sessions.length;
    if (count < 2) return;
    const step =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "Home"
            ? -count
            : event.key === "End"
              ? count
              : 0;
    if (step === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (active + step + count) % count;
    select(next);
    tabs[next]?.focus();
  }

  function menuSections(): TerminalMenuSection[] {
    const session = sessions[active];
    // `null` means the transcript has not arrived, not that it is empty. A framed session's child
    // pushes its transcript across the bridge, so the only reason to disable Copy and Download is
    // that it has not been sent yet.
    const noTranscript = (session?.transcript() ?? null) === null;
    const files = session?.artifacts() ?? [];
    // MINIMIZED, THE SESSION ACTIONS ARE UNAVAILABLE, and they say so. Each of the three raises a
    // confirmation, drawn inside the window's own body - which a minimized window has collapsed to
    // its title bar, so the dialog renders into a two-pixel strip with its buttons off the bottom.
    // Disabled rather than silently restoring the window first: restoring answers a press with a
    // window jumping open, and a minimized window means the visitor has put this away. The reason
    // is on the row as hover help, and the remedy is `Restore the window` at the top of the menu.
    const stowed = win?.isMinimized() === true;
    // The reason belongs on the row it explains, as hover help; the remedy belongs at the top, as
    // something that can be pressed. Putting "(restore the window first)" in six of the eleven
    // labels instead widens the menu to the longest of them and offers nothing to press.
    const stowedReason =
      "This opens inside the window, and the window is minimized. Restore it first.";
    const restoreSection: TerminalMenuSection[] = stowed
      ? [
          {
            items: [
              {
                label: "Restore the window",
                title:
                  "Open the window back up. The session never stopped - its variables and its " +
                  "transcript are as you left them.",
                onSelect: () => win?.setMinimized(false),
              },
            ],
          },
        ]
      : [];
    return [
      ...restoreSection,
      {
        title: "Session",
        items: [
          {
            // AT THE CEILING the row says why, and offers no question. A confirmation for an
            // action that cannot succeed is a dialog whose "yes" produces an error message; a
            // disabled row with no explanation tells the visitor no without telling them why. So
            // the reason is in the label, where it is read when the row is looked at.
            label:
              !stowed && sessions.length >= maxSessions
                ? `New session… (limit of ${maxSessions} reached)`
                : "New session…",
            // WHAT THE ROW DOES, not what it is called. "New session…", "Restart session…" and
            // "End session…" are names, and the difference between them is what happens to an
            // interpreter a visitor may have spent minutes filling. The ellipsis promises only that
            // something will be asked; one line on hover says what.
            title: stowed
              ? stowedReason
              : "Open a second, independent interpreter. It does not share variables, imports or " +
                "files with the one you are in, and costs its own CPU and memory.",
            disabled: stowed || sessions.length >= maxSessions,
            onSelect: () => void addSession({ confirm: true }),
          },
          {
            label: "Restart session…",
            title: stowed
              ? stowedReason
              : "Throw away this interpreter and start a fresh one in the same tab. Variables, " +
                "imports and anything installed are lost; the transcript stays on screen.",
            danger: true,
            disabled: stowed,
            onSelect: () => {
              if (!session) return;
              void confirmDestructive({
                title: `Restart ${session.label}?`,
                body: "Its variables, imports and in-memory interpreter state will be lost.",
                confirmLabel: "Restart session",
                danger: true,
              }).then((ok) => {
                if (ok) void session.restart();
              });
            },
          },
          {
            label: "End session…",
            title: stowed
              ? stowedReason
              : "Shut this interpreter down and close its tab. Available only while a second " +
                "session is open, because a terminal with no interpreter is not one.",
            danger: true,
            disabled: stowed || sessions.length < 2,
            onSelect: () => {
              if (!session) return;
              const index = active;
              void confirmDestructive({
                title: `End ${session.label}?`,
                body:
                  "Its variables, imports and in-memory interpreter state will be lost, and its " +
                  "interpreter is shut down.",
                confirmLabel: "End session",
                danger: true,
              }).then((ok) => {
                if (ok) closeSession(index);
              });
            },
          },
        ],
      },
      {
        title: "Transcript",
        items: [
          {
            label: "Copy transcript",
            title:
              "The whole session as text, on the clipboard - prompts, output and all. The " +
              "console's own notes are written as Python comments, so it can be pasted back and " +
              "run.",
            disabled: noTranscript,
            onSelect: () => {
              const text = session?.transcript();
              if (text) void navigator.clipboard?.writeText(text);
            },
          },
          {
            label: "Clear transcript",
            title:
              "Empty the screen. The interpreter is untouched - every variable and import " +
              "survives. Also Ctrl + L, or `clear` at the prompt.",
            onSelect: () => session?.clearTranscript(),
          },
          {
            label: "Download transcript",
            title: "The same text, as a file.",
            disabled: noTranscript,
            onSelect: () => downloadTranscript(session),
          },
          {
            label: "Clear history",
            title:
              "Forget the lines this browser remembers for ↑ and Ctrl + R. The transcript on " +
              "screen stays.",
            onSelect: () => session?.clearHistory(),
          },
        ],
      },
      // The playground's own files, and only when there are some and only for a framed session. A
      // local session's console draws its own file panel in this same document; a second list here
      // would be two places to look with nothing saying which is authoritative. A framed one has no
      // panel the portal can show, which is why the metadata crosses the bridge at all.
      ...(files.length > 0
        ? [
            {
              title: "Files",
              items: files.map((file) => ({
                label: `Save ${file.name} (${formatBytes(file.size)})`,
                // `ready` is the only state a file can be saved in: `open` means Python still has
                // it, `transferring` means another download already holds its lease.
                disabled: file.state !== "ready",
                onSelect: () => {
                  // The picker opens inside this handler, from the visitor's own click on a
                  // parent-origin control. Written as a statement rather than awaited so that it
                  // is obvious nothing may go before it: an `await` before the picker loses the
                  // activation and the platform refuses the dialog.
                  void session?.download(file.name).catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    // A visitor who dismissed the picker did not fail at anything.
                    if (/abort/i.test(message)) return;
                    announce(`${file.name} could not be saved: ${message}`, "warn");
                  });
                },
              })),
            },
          ]
        : []),
      // THE WINDOW'S OWN APPEARANCE CONTROLS, second from last, opening to the side. This row is
      // the window's: the package fills it in and owns what happens when it is pressed.
      // `appearance` is the whole of the arrangement - the host decides the position and the label,
      // the window decides the widgets.
      {
        title: "Terminal",
        items: [
          {
            // MINIMIZED, THIS PANEL HAS NOWHERE TO DRAW, like the session rows above: the
            // appearance widgets and the two Help sheets are `position: absolute` against the
            // window root with `max-height: calc(100% - 1.5rem)`, and a minimized window is a
            // 300px title bar with `height: auto`. The transcript rows and the file list are NOT
            // disabled and must not be: none needs a window body, and all are things a visitor
            // may want from a console they have put away, which is why the ⋮ stays. The LABELS do
            // not change either; a menu renamed by the window's size is one to re-read.
            label: "Terminal settings",
            title: stowed ? stowedReason : "Colours, background opacity and text size.",
            disabled: stowed,
            appearance: true,
          },
        ],
      },
      {
        title: "Help",
        items: [
          {
            label: "Keyboard shortcuts",
            title: stowed ? stowedReason : "Every key this console answers to. Also Ctrl + /.",
            disabled: stowed,
            onSelect: () => showSheet("shortcuts"),
          },
          {
            label: "Python packages",
            title: stowed
              ? stowedReason
              : "What this interpreter has loaded, and what it is allowed to fetch.",
            disabled: stowed,
            onSelect: () => showSheet("packages"),
          },
        ],
      },
    ];
  }

  /**
   * A confirmation, drawn by the window it belongs to. Not `window.confirm()`, which renders as
   * `127.0.0.1 says…` in the browser's chrome, is unstyleable, blocks the whole page rather than
   * the window, and in a sandboxed frame silently returns `false` so the action never happens.
   * `win.confirm` is the window's own `role="alertdialog"` with the focus trapped in it and Cancel
   * focused; being coverable by a portal dialog is correct, since a question about this terminal
   * belongs to this terminal. `false` when there is no window, because doing the action anyway is
   * the one answer that is certainly wrong.
   */
  function confirmDestructive(request: {
    title: string;
    body: string;
    confirmLabel: string;
    danger?: boolean;
  }): Promise<boolean> {
    if (!win) return Promise.resolve(false);
    return win.confirm(request);
  }

  /** Bytes, for a menu row a visitor reads rather than a number a machine parses. */
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function downloadTranscript(session: Session | undefined): void {
    const text = session?.transcript();
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "python-transcript.txt";
    link.click();
    // Revoked on the next turn: revoking synchronously races the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // the help sheet

  /**
   * WHAT THE KEYS ARE, AND HOW TO GET A PACKAGE - in a panel, not in a status line. A reference is
   * a small table somebody reads once and closes, which six key combinations run together in the
   * window's one-line notice is not. The panel is inside the window, because a terminal's own help
   * belongs to that terminal, and it is `role="dialog"` with `aria-modal="false"`: it does not
   * trap the focus, since nothing behind it is unsafe to touch.
   */
  const SHEETS: Record<
    string,
    {
      title: string;
      rows: [string, string][];
      note?: string;
      link?: { href: string; label: string };
    }
  > = {
    shortcuts: {
      title: "Keyboard shortcuts",
      rows: [
        ["Enter", "run the line"],
        ["Shift + Enter", "continue a block on a new line"],
        ["Tab", "complete a name, and open the candidates"],
        // The arrows do two things, decided by whether the candidate list is open, and a panel
        // naming only one of them would be wrong half the time. One row, both meanings, in order.
        ["↑ / ↓", "move through the candidates — or, with no list open, through history"],
        // THE GHOST NEEDS SAYING ONCE, HERE. The suggestion is grey text after the caret and
        // carries no label of its own - that is what makes it unobtrusive, and why the way to
        // accept it belongs in the panel a visitor opens to find out rather than under the
        // transcript on every keystroke.
        ["→ / Ctrl + E", "accept the grey suggestion at the end of the line"],
        ["Ctrl + R", "search history"],
        ["Ctrl + L", "clear the transcript"],
        // `clear` is in a KEYBOARD panel because it is what a visitor reaches for instead of one.
        // Nobody looks up the shortcut for clearing a terminal; they type the word, and a console
        // that answers the most reflexive command in the medium with a NameError is wrong.
        ["clear", "the same, typed at the prompt"],
        // WHAT CTRL+C DOES, stated in full because the honest answer has two halves and a panel
        // that gives only one of them misleads either way. It cancels what the interpreter is
        // WAITING for - a request, a sleep, a login poll - through Python's own cancellation, so
        // the traceback is Python's. It cannot reach a loop that never waits, because a
        // cancellation is delivered at a suspension point and that loop has none; `Restart Python`
        // is what ends that, and the console says so if an interrupt goes unanswered.
        ["Ctrl + C", "stop what Python is waiting for, or abandon the line"],
        ["Delete", "end the session whose tab has focus"],
        ["Esc", "close this panel"],
      ],
    },
  };

  /**
   * The package panel, BUILT WHEN OPENED, from the resolved policy and the running interpreter.
   * Not a constant: the text comes from the same `packagePolicy` that wrote the page's
   * `connect-src`, so it cannot document a capability the policy forbids - where no package index
   * is named, `await micropip.install("name")` fails at metadata lookup with
   * `ValueError: Can't fetch metadata for …`. Everything else is an OBSERVATION about the
   * interpreter that came up, and where nothing can be observed - a framed session, or one that
   * has not started - it says less rather than guessing.
   */
  function packageSheet(): {
    title: string;
    rows: [string, string][];
    note?: string;
    link?: { href: string; label: string };
  } {
    const report = sessions[active]?.ready() ?? null;
    const rows: [string, string][] = [];

    rows.push(["profile", config.profile]);
    rows.push([
      "add-ons",
      config.addons.length > 0 ? config.addons.join(", ") : "none enabled for this portal",
    ]);
    if (report) {
      const versions = Object.entries(report.packages)
        .map(([name, version]) => `${name} ${version}`)
        .join(", ");
      if (versions) rows.push(["loaded", versions]);
      for (const addon of report.addons) {
        const installed = Object.entries(addon.versions)
          .map(([name, version]) => `${name} ${version}`)
          .join(", ");
        if (installed) rows.push([addon.id, installed]);
      }
      // WHAT WAS CONFIGURED AND DID NOT ARRIVE. An optional add-on that failed leaves a healthy
      // interpreter and an absent capability, two different sentences; without this row a visitor
      // meets the absence at the moment they use it. For Cartopy the DATA is unavailable, not the
      // package: `import cartopy` works, but the offline coastline and border files are missing,
      // so `ax.coastlines()` fetches them and fails. The wrong failure sends a reader astray.
      for (const missing of report.unavailableAddons ?? []) {
        rows.push([
          `${missing.id} (unavailable)`,
          `${missing.reason} ${missing.remedy}${
            missing.retryMayHelp ? " A restart may help." : " A restart requests the same file."
          }`,
        ]);
      }
      // THE WORKSPACE, as this interpreter reports it - not as a sentence written in advance.
      // Whether OPFS is available is the difference between "your file is on disk until this
      // session ends" and "your file is in this tab's memory", and only the interpreter knows.
      rows.push([
        "/workspace",
        report.workspace.available
          ? `disk-backed, up to ${report.workspace.maxFiles ?? "a bounded number of"} files, and only for this session`
          : `not disk-backed here${report.workspace.detail ? ` (${report.workspace.detail})` : ""} - files stay in this tab's memory`,
      ]);
    }
    // WHERE PACKAGES COME FROM, read out of the same object that wrote this page's `connect-src`.
    // This row is the reason `resolvePackagePolicy` exists: there is one list and the build wrote
    // both from it, so this sentence cannot name a source the policy does not permit. If a
    // deployment adds an origin, the sentence changes with the header.
    const policy = config.packagePolicy;
    const where = [
      `the pinned runtime at ${policy.sources.runtime}`,
      ...(policy.sources.wheelhouse ? [`wheels from ${policy.sources.wheelhouse}`] : []),
      ...(policy.sources.addons && policy.sources.addons !== policy.sources.wheelhouse
        ? [`add-ons from ${policy.sources.addons}`]
        : []),
    ].join(", and ");
    rows.push(["packages come from", where]);
    rows.push(["import micropip", "the installer this interpreter carries"]);
    rows.push(["micropip.list()", "what this session actually has"]);
    // THE INSTALL EXAMPLE, shown wherever it works - which is not the same question as whether
    // the deployment called itself open. A curated deployment on the `freva-client` profile has
    // PyPI in its `connect-src`, because that profile resolves its dependencies there, so the
    // command works and saying it does not would be the drift this panel exists to prevent.
    const open = config.packagePolicy.kind === "open";
    const index = config.packagePolicy.packageIndex;
    if (index) {
      rows.push([
        'await micropip.install("name")',
        "install a package from the public index, into this session",
      ]);
    }

    const note =
      (open
        ? "The profile and any add-ons above are a working STARTING environment, not a limit: " +
          "packages in the profile load when you import them, and you can install more yourself " +
          'with `await micropip.install("name")` or from an HTTPS wheel URL. Anything you add is ' +
          "a session experiment - pure-Python wheels usually work, packages with compiled " +
          "extensions usually do not, and a package that breaks the session is not a mistake you " +
          "have to undo by hand: `Restart session` gives you the starting environment back. "
        : index
          ? "This playground's profile installs its own dependencies from the public Python " +
            "index, so that index is reachable from this page - which means you can install " +
            'other packages from it too, with `await micropip.install("name")`. The profile ' +
            "and any add-ons above are what the site set up for you; anything you add is a " +
            "session experiment, and `Restart session` gives you the starting environment back. "
          : "This playground uses a curated Python environment. Packages included in the " +
            "selected profile load automatically when you import them. Additional packages such " +
            "as Freva or Dask are installed only when the portal operator has enabled their " +
            "verified add-on. Installing packages by name from a public index is not enabled by " +
            "this site. ") +
      (report
        ? "What is listed above is what this interpreter reported when it started. "
        : "Start the interpreter to see what it loaded. ") +
      // WHAT ACTUALLY ENDS AN INTERPRETER. The window's close action HIDES it: the session keeps
      // running, and showing it again finds the same variables. `Restart session` is what replaces
      // an interpreter; a reload replaces the whole document and takes it with it. Nothing here
      // claims more - a restart does not erase browser storage, and cannot unsend a request that
      // already reached somewhere.
      "Anything you install lives in this interpreter: `Restart session` replaces it, and " +
      "reloading the page replaces the whole document. Closing this window only hides it - the " +
      "session keeps running and its variables are still there when you open it again.";

    return {
      title: "Python packages",
      rows,
      note,
      // The link is kept, and the sentence before it is what makes keeping it honest: micropip's
      // documentation describes micropip in general, including an install command this deployment
      // may not permit.
      link: {
        href: "https://micropip.pyodide.org/",
        label: open
          ? "micropip documentation"
          : "micropip documentation (describes micropip in general; this site is stricter)",
      },
    };
  }

  function showSheet(topic: keyof typeof SHEETS | string): void {
    // Built fresh for `packages`, because what it says depends on the interpreter that is running.
    const spec = topic === "packages" ? packageSheet() : SHEETS[topic];
    if (!spec || !win) return;
    hideSheet();

    const panel = document.createElement("div");
    panel.className = "portal-python-sheet";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", spec.title);

    const head = document.createElement("div");
    head.className = "portal-python-sheet-head";
    const heading = document.createElement("h2");
    heading.className = "portal-python-sheet-title";
    heading.textContent = spec.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "portal-python-sheet-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "\u00d7";
    close.addEventListener("click", () => hideSheet());
    head.append(heading, close);

    const list = document.createElement("dl");
    list.className = "portal-python-sheet-keys";
    for (const [key, meaning] of spec.rows) {
      const term = document.createElement("dt");
      const code = document.createElement("code");
      code.textContent = key;
      term.append(code);
      const description = document.createElement("dd");
      description.textContent = meaning;
      list.append(term, description);
    }

    // The head stays put and the BODY scrolls, so the title and its close button cannot scroll
    // away with the rows. See `python-playground-styles.ts` for the rest of that layout.
    const body = document.createElement("div");
    body.className = "portal-python-sheet-body";
    body.append(list);
    if (spec.note) {
      const note = document.createElement("p");
      note.className = "portal-python-sheet-note";
      note.textContent = spec.note;
      body.append(note);
    }
    if (spec.link) {
      const link = document.createElement("a");
      link.className = "portal-python-sheet-link";
      link.href = spec.link.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = spec.link.label;
      body.append(link);
    }
    panel.append(head, body);

    sheet = panel;
    // On the window ROOT, not in its body. The body scrolls, and an absolutely positioned panel
    // inside a scrolling box is clipped by it and scrolls away with the transcript - the one thing
    // a reference must not do while somebody is typing what it describes.
    win.el.append(panel);
    close.focus();

    // A CLICK ANYWHERE ELSE CLOSES IT. `composedPath()` rather than `contains(event.target)`,
    // because the console is a custom element with a shadow root and a click inside it reports
    // the HOST as its target; the path is the only thing true through a shadow boundary.
    // `pointerdown` in the CAPTURE phase, so the dismissal happens before a menu item or a link
    // in the transcript acts on the click. And attached on the NEXT frame: the press that opens
    // the sheet is still travelling, and would otherwise dismiss it.
    const dismiss = (event: Event): void => {
      if (!sheet) return;
      if (event.composedPath().includes(sheet)) return;
      hideSheet();
    };
    const frame = requestAnimationFrame(() => {
      document.addEventListener("pointerdown", dismiss, true);
    });
    sheetDismiss = () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismiss, true);
    };
  }

  function hideSheet(): boolean {
    sheetDismiss?.();
    sheetDismiss = null;
    if (!sheet) return false;
    sheet.remove();
    sheet = null;
    return true;
  }

  // sessions

  let sessionCount = 0;

  async function addSession(options: { confirm: boolean }): Promise<Session | null> {
    if (destroyed) return null;
    if (sessions.length >= maxSessions) {
      announce(
        `This page allows ${maxSessions} interpreter${maxSessions === 1 ? "" : "s"} at a time.`,
        "warn",
      );
      return null;
    }
    // The warning before the SECOND session, which is the one that costs something: a second
    // Worker with its own WebAssembly heap and its own copy of every package it loads - hundreds
    // of megabytes for a scientific profile. Reasonable to want, unreasonable to acquire by
    // accident, so it is asked for rather than offered.
    if (options.confirm && sessions.length >= 1) {
      // Named after the session it will NOT share anything with, because "a second interpreter"
      // is an abstraction and "does not share variables with Session 1" is the consequence.
      // Nothing here promises that files or credentials survive into the new session: it is a new
      // Worker with its own heap and its own workspace.
      const first = sessions[0]?.label ?? "the first session";
      const ok = await confirmDestructive({
        title: "Start another Python session?",
        body:
          "It runs an independent WebAssembly interpreter, consumes additional CPU and memory, " +
          `and does not share variables with ${first}.`,
        confirmLabel: "Start session",
      });
      if (!ok) return null;
    }

    const { defineBrowserPythonConsole } = await loadChunks();
    // Only a LOCAL session needs the element defined; a framed one has no console in this document.
    defineBrowserPythonConsole?.();
    sessionCount += 1;
    const session = config.playgroundOrigin
      ? framedSession(sessionCount, config)
      : localSession(sessionCount, config);
    sessions.push(session);

    const index = sessions.length - 1;
    const tabId = `${idBase}-tab-${index}`;
    const panelId = `${idBase}-panel-${index}`;
    // The relationship, in both directions. A `role="tab"` with no `aria-controls` and a panel
    // with no `role="tabpanel"` is a strip of buttons that announces itself as a tablist and leads
    // nowhere: a screen reader user hears "tab, Session 2" and cannot move into what it selected.
    session.root.id = panelId;
    session.root.setAttribute("role", "tabpanel");
    session.root.setAttribute("aria-labelledby", tabId);
    // Focusable, so the panel itself is a stop on the way from the tab into the console.
    session.root.tabIndex = 0;

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "portal-python-tab";
    tab.id = tabId;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panelId);
    const tabLabel = document.createElement("span");
    tabLabel.className = "portal-python-tab-label";
    tabLabel.textContent = session.label;
    // THE CLOSE CONTROL IS INSIDE THE TAB, AND IT IS NOT INTERACTIVE TO ASSISTIVE TECHNOLOGY.
    // A tablist may contain only tabs, so this cannot be a sibling of the tab it belongs to; a
    // `<button>` inside a `<button>` is invalid markup browsers resolve by throwing one away; and
    // a `role="button"` inside one is `nested-interactive`, which axe reports as a serious
    // violation. So it is a pointer affordance and nothing else - `aria-hidden`, no role, no tab
    // stop - and the keyboard reaches the same action by DELETE on the focused tab (wired below)
    // and `End session…` in the ⋮ menu.
    const close = document.createElement("span");
    close.className = "portal-python-tab-close";
    close.setAttribute("aria-hidden", "true");
    close.title = `End ${session.label}`;
    close.textContent = "\u00d7";
    close.hidden = true;
    close.addEventListener("click", (event) => {
      // The tab underneath would otherwise select the session on the way past.
      event.stopPropagation();
      requestClose(tabs.indexOf(tab));
    });
    tab.append(tabLabel, close);
    tab.addEventListener("click", () => select(tabs.indexOf(tab)));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      event.preventDefault();
      requestClose(tabs.indexOf(tab));
    });
    tabs.push(tab);
    tabStrip?.append(tab);

    sessionHost?.append(session.root);
    active = sessions.length - 1;
    syncTabs();
    syncConsoleTheme();
    win?.setMenuSections(menuSections());
    publish();
    return session;
  }

  function select(index: number): void {
    if (index < 0 || index >= sessions.length) return;
    active = index;
    syncTabs();
    win?.setMenuSections(menuSections());
    sessions[active]?.focus();
  }

  /**
   * Ask before ending a session, from wherever the ask came from.
   *
   * The same question the menu row raises, because it is the same action, and losing an interpreter
   * to a mis-aimed click on a 14px glyph is exactly the accident a confirmation is for. A minimized
   * window cannot draw one, so it refuses here too - the close controls are unreachable there
   * anyway, but the Delete key on a tab is not.
   */
  function requestClose(index: number): void {
    const session = sessions[index];
    if (!session || sessions.length < 2 || win?.isMinimized()) return;
    void confirmDestructive({
      title: `End ${session.label}?`,
      body:
        "Its variables, imports and in-memory interpreter state will be lost, and its " +
        "interpreter is shut down.",
      confirmLabel: "End session",
      danger: true,
    }).then((ok) => {
      if (ok) closeSession(index);
    });
  }

  function closeSession(index: number): void {
    const session = sessions[index];
    if (!session || sessions.length < 2) return;
    session.dispose();
    session.root.remove();
    sessions.splice(index, 1);
    tabs[index]?.remove();
    tabs.splice(index, 1);
    active = Math.max(0, Math.min(active, sessions.length - 1));
    syncTabs();
    win?.setMenuSections(menuSections());
    publish();
  }

  // opening

  async function ensureWindow(): Promise<void> {
    if (win) return;
    if (opening) return opening;
    opening = (async () => {
      const { createTerminalWindow } = await loadChunks();
      if (destroyed) return;

      const shell = document.createElement("div");
      shell.className = "portal-python-window";
      // `alwaysOnTop` is a BAND, not a bigger number: `true` puts the window above every
      // portal-owned surface that participates in z-index stacking - dialogs, toasts, the
      // maximized dataset-tree sheet - and no value here can cover the browser's top layer. A
      // portal with a Data Browser has two such surfaces, its File Inspector and its comparison
      // modal, which are real `showModal()` dialogs. See `client/layers.ts`.
      layer = mountLayer(shell, config.terminal.alwaysOnTop ? "always-on-top" : "floating");

      const handle = createTerminalWindow(shell, {
        os: osControls(config.terminal.osControls),
        bounds: () => shell.parentElement,
        storage: appearanceStorage(config.terminal.rememberAppearance),
        dragExclude: ".portal-python-tab",
        closeLabel: "Hide",
        copyLabel: "transcript",
        copyTitle: "Copy transcript",
        copyText: () => sessions[active]?.transcript() ?? "",
        menuSections: menuSections(),
        onBodyActivate: () => sessions[active]?.focus(),
        onShow: () => {
          layer?.raise();
          publish();
        },
        onHide: () => {
          publish();
          restoreFocus();
        },
        onMinimize: () => {
          // The session rows change with this: a minimized window cannot draw a confirmation, so
          // the three actions that raise one become unavailable and say why. Rebuilding the menu
          // here is what makes the rows follow the state rather than the last build.
          win?.setMenuSections(menuSections());
          hideSheet();
          publish();
        },
        // A window that changed size is a window somebody is about to type in. Without this the
        // focus stays on the zoom control and a visitor who filled the screen with a console has
        // to click into it first. The press came from inside the window, so this is not taking
        // focus from the page. Both directions, because a window is still the thing the visitor
        // is working in after it shrinks. The frame is deferred so the layout the `zoomed` class
        // triggers has settled before the caret is placed - a console measures its own width.
        onMaximize: () => {
          publish();
          focusSession();
        },
      });
      win = handle;

      // BOTH go in the title bar's LEFT group, beside the window controls. `addBarControl` rather
      // than inserting before the bar spacer: that is correct only while the window's own controls
      // are first in the row, and `data-os` moves them, which leaves Copy and the ⋮ menu pressed
      // against the session name with the whole gap after them. Naming the SIDE cannot go wrong.
      tabStrip = document.createElement("div");
      tabStrip.className = "portal-python-tabs";
      tabStrip.setAttribute("role", "tablist");
      tabStrip.setAttribute("aria-label", "Python sessions");
      tabStrip.addEventListener("keydown", onTabKey);

      addTab = document.createElement("button");
      addTab.type = "button";
      addTab.className = "portal-python-tab-add";
      addTab.textContent = "+";
      addTab.addEventListener("click", () => {
        if (win?.isMinimized()) return;
        void addSession({ confirm: true });
      });

      // THE `+` IS OUTSIDE THE TABLIST, and that is not a detail. A `role="tablist"` may contain
      // tabs and nothing else. A button that opens a session is not a tab - it selects nothing and
      // controls no panel - so inside it would tell a screen reader there are three sessions when
      // there are two. The wrapper holds both and is what the title bar is given.
      const tabBar = document.createElement("div");
      tabBar.className = "portal-python-tabbar";
      tabBar.append(tabStrip, addTab);
      handle.addBarControl(tabBar, "start");

      // THE BODY IS A COLUMN OF THREE, and this is where that column is built:
      //
      //   [ status: intrinsic height, hidden when it has nothing to say ]
      //   [ sessions: everything that is left, and it scrolls inside itself ]
      //
      // The title bar above it is the third. Nothing here is a card, nothing has a height of its
      // own, and the session host carries `min-height: 0` so a long transcript scrolls inside the
      // console instead of pushing the column past the bottom of the window.
      statusRow = document.createElement("div");
      statusRow.className = "portal-python-status";
      statusRow.hidden = true;
      const statusText = document.createElement("span");
      statusText.className = "portal-python-status-text";
      // `polite`, not `assertive`. "Python is ready" arriving mid-sentence is news, not an alarm,
      // and interrupting somebody's screen reader to say it is the wrong trade.
      statusText.setAttribute("role", "status");
      statusText.setAttribute("aria-live", "polite");
      statusRow.append(statusText);
      statusLabelEl = statusText;

      notice = document.createElement("p");
      notice.className = "portal-python-notice";
      notice.setAttribute("role", "status");
      notice.hidden = true;

      sessionHost = document.createElement("div");
      sessionHost.className = "portal-python-body";

      handle.body.append(statusRow, notice, sessionHost);

      // THE VIRTUAL KEYBOARD, the one piece of mobile behaviour a floating window cannot ignore.
      // The window is clamped against this shell and the shell fills the overlay root -
      // `position: fixed; inset: 0`, the LAYOUT viewport - which on a phone does not shrink when
      // the keyboard opens, while the VISUAL viewport does. A window near the bottom of the screen
      // then sits under the keyboard, and the page behind it does not scroll the overlay.
      // Shrinking the shell to the visible area fixes the clamp for everything that follows, and
      // the nudge below fixes a window already out of view. `visualViewport` is absent on some
      // engines, and the whole block is skipped there rather than approximated.
      const vv = window.visualViewport;
      if (vv) {
        const fit = (): void => {
          const hidden = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
          shell.style.bottom = `${hidden}px`;
          if (!win?.isShown() || win.isMinimized()) return;
          const box = handle.el.getBoundingClientRect();
          const floor = vv.offsetTop + vv.height;
          if (box.bottom <= floor) return;
          // Up by the overlap, but never above the top of the visible area: a window whose title
          // bar is off-screen cannot be moved back by dragging it.
          const top = Math.max(0, box.top - (box.bottom - floor));
          handle.el.style.top = `${top}px`;
        };
        vv.addEventListener("resize", fit);
        vv.addEventListener("scroll", fit);
        viewportListeners = () => {
          vv.removeEventListener("resize", fit);
          vv.removeEventListener("scroll", fit);
        };
        fit();
      }

      // Escape closes the help panel before anything else looks at the key. Capture, and on the
      // window's own root: the console below treats Escape as its own (it dismisses completion),
      // so a bubbling listener would only see the presses the console did not want. Nothing else
      // is intercepted - the handler returns immediately unless a panel is open.
      handle.el.addEventListener(
        "keydown",
        (event: KeyboardEvent) => {
          if (event.key === "Escape" && sheet) {
            event.preventDefault();
            event.stopPropagation();
            hideSheet();
            return;
          }
          // The reference, on the key every editor uses for one.
          if ((event.ctrlKey || event.metaKey) && event.key === "/") {
            event.preventDefault();
            if (!hideSheet()) showSheet("shortcuts");
          }
        },
        true,
      );

      // The console follows the window's swatch, for the life of the window. An observer rather
      // than a callback, because the window has no "theme changed" event and inventing one would
      // put a second way of knowing the same fact into the package's API. The attribute IS the
      // fact.
      const themes = new MutationObserver(() => syncConsoleTheme());
      themes.observe(handle.el, { attributes: true, attributeFilter: ["data-term-light"] });
      themeObserver = themes;

      handle.applyTooltips();
      // A press on the window raises it within its band. CAPTURE phase, so a click that a control
      // stops from propagating still counts as "the visitor is using this window", which is the
      // only thing raising is about.
      shell.addEventListener("mousedown", () => layer?.raise(), true);
      await addSession({ confirm: false });
    })().finally(() => {
      opening = null;
    });
    return opening;
  }

  /**
   * Show the window without moving the page. Nothing here scrolls and nothing here focuses
   * anything outside the window: the visitor pressed a button somewhere in a long tree, and the
   * page must still be showing it afterwards. A minimized or hidden window is restored rather than
   * replaced, so its transcript, its namespace and whatever was half-typed all survive.
   */
  function reveal(takeFocus = false): void {
    if (!win) return;
    // Remembered on the way IN, and only when the window was not already up: a second press while
    // the window is open must not overwrite the place the visitor came from with the window's own
    // control.
    if (!win.isShown()) {
      const focused = document.activeElement;
      focusBefore =
        focused instanceof HTMLElement && focused !== document.body ? focused : focusBefore;
    }
    if (win.isMinimized()) win.setMinimized(false);
    if (!win.isShown()) win.show();
    layer?.raise();
    // `takeFocus` ALONE decides it. The flag carries the distinction that matters: false for a
    // window that appears because `autostart: immediately` is configured - which nobody asked for,
    // and where moving a keyboard visitor takes them somewhere they did not go - and true for a
    // press on a run control or the launcher, which IS the request. It must not be narrowed to
    // windows that were not already open: the ordinary case is pressing `Try in Python` with the
    // window open, and the example would then run into a console the caret is not in.
    if (takeFocus) {
      focusSession();
    }
  }

  /**
   * Put the caret where a visitor can type, in the order that actually works. THE PANEL FIRST,
   * then whatever the session puts the caret in: a session's own `focus()` reaches into a console
   * or a frame and neither is guaranteed to take it - a console that has not built its input yet,
   * a frame whose document is still loading - while the panel is in this document, focusable as a
   * `tabpanel`, and inside the window either way. Shared by revealing the window and resizing it,
   * because the session's `focus()` alone leaves the caret on the zoom control just pressed.
   */
  function focusSession(): void {
    // TWICE: NOW, AND AGAIN ON THE NEXT FRAME. A hidden window is `display: none` and `show()`
    // only adds the class, so a `focus()` in the same task can land on an element the browser has
    // not rendered yet and do nothing. The first open hides this, because a console that has just
    // started focuses itself when it becomes ready; on the second the interpreter is already up
    // and nothing re-focuses. Not a retry loop: one frame is all it takes for the class to be in
    // effect, and a caret already in the right place is set to the same place.
    const put = (): void => {
      sessions[active]?.root.focus();
      sessions[active]?.focus();
    };
    put();
    requestAnimationFrame(put);
  }

  /**
   * Put the focus back where it was before the window took it, when the window is hidden. Without
   * it a keyboard visitor is left on `document.body`, at the top of the page. The element is
   * checked for still being in the document, because a page can change while a window is open.
   *
   * `preventScroll` because focusing is also a request to show: the terminal is a floating window
   * somebody may have opened at the top of a long page and read their way to the bottom of, and
   * scrolling back to whichever `Try in Python` opened it reads as the page jumping. The focus
   * still moves, so the next Tab continues from that control and the browser brings it into view
   * then. An older engine that ignores the options object degrades to scrolling, not to no focus.
   */
  function restoreFocus(): void {
    const target = focusBefore;
    focusBefore = null;
    if (!target || !target.isConnected) return;
    try {
      target.focus({ preventScroll: true });
    } catch {
      // an element that refuses focus is not worth an error a visitor would see
    }
  }

  // the entry points

  /**
   * Show the prompt, and mean it. Opening a terminal is asking for an interpreter, so this starts
   * one; revealing a window alone leaves a console on screen with a prompt and nothing behind it.
   * The window is revealed FIRST and the start awaited after, so the visitor sees where their
   * request went while the runtime downloads rather than after it.
   */
  function open(options: { focus?: boolean } = {}): void {
    void ensureWindow()
      .then(() => {
        reveal(options.focus ?? false);
        return sessions[active]?.start();
      })
      .catch((error: unknown) => reportUnavailable(error));
  }

  function run(request: TryPythonRequest): void {
    const resolved = resolve(request);
    if ("reason" in resolved) {
      // Refused, and said out loud. A run control that silently does nothing is the hardest thing
      // to diagnose, and every reason this can produce means the page and its build disagree.
      void ensureWindow()
        .then(() => {
          reveal(true);
          announce(`That example was not run: ${resolved.reason}.`, "warn");
        })
        .catch((error: unknown) => reportUnavailable(error));
      return;
    }
    void ensureWindow()
      .then(async () => {
        // A press on a run control IS the request, so the focus follows it into the window - and
        // returns to that same control when the window is hidden.
        reveal(true);
        announce("");
        const session = sessions[active];
        if (!session) return;
        await session.runExample(request, resolved.example);
      })
      .catch((error: unknown) => reportUnavailable(error));
  }

  /**
   * The interpreter could not be loaded at all. Reported next to the control that was pressed
   * rather than in a console: the visitor pressed something, and "nothing happened" is not an
   * answer. The window may not exist - the failure may BE the window - so this falls back to the
   * page.
   */
  function reportUnavailable(error: unknown): void {
    const message =
      "The Python playground could not be loaded: " +
      (error instanceof Error ? error.message : String(error));
    if (notice) {
      announce(message, "warn");
      return;
    }
    // The REGISTERING BLOCK's own host, not a dataset tree: a docs-only page has no tree, and a
    // report that went nowhere would make a failed load look exactly like a press that did
    // nothing.
    const host = pythonBlocks()[0]?.host ?? null;
    if (!host) return;
    const note = document.createElement("p");
    note.className = "portal-note portal-python-failed";
    note.setAttribute("role", "status");
    note.textContent = message;
    host.append(note);
  }

  // `autostart` is decided in ONE place, and it is not this one. The light entry
  // (`python-ready.ts`) owns the timing, because it is the module that exists before anything is
  // loaded; this module owns `warm()` and `open()` and does what it is told.

  return {
    run,
    open,
    async warm(): Promise<void> {
      await ensureWindow();
      await sessions[active]?.start();
    },
    state,
    onState(listener: (state: PlaygroundState) => void): void {
      listeners.add(listener);
      listener(state());
    },
    destroy(): void {
      destroyed = true;
      viewportListeners?.();
      viewportListeners = null;
      themeObserver?.disconnect();
      themeObserver = null;
      hideSheet();
      for (const session of sessions) session.dispose();
      sessions.length = 0;
      win?.destroy();
      win = null;
      layer?.release();
      layer = null;
    },
  };

  // session shapes

  function localSession(index: number, cfg: PythonPlaygroundConfig): Session {
    const root = document.createElement("div");
    root.className = "portal-python-session";
    const element = document.createElement("freva-python-console") as HTMLElement & {
      profile: string;
      readyInfo: ReadyReport | null;
      wheelhouseURL?: string;
      addonBaseURL?: string;
      addons?: readonly string[];
      optionalAddons?: readonly string[];
      persistCredentials?: boolean;
      autoStart: boolean;
      toolbarMode: "full" | "status" | "none";
      hideFiles: boolean;
      start(): Promise<void>;
      execute(source: string): Promise<void>;
      runExample(example: ExampleSource): Promise<void>;
      transcript(): string;
      focus(): void;
      clear(): void;
      clearHistory(): void;
      restart(): Promise<void>;
      dispose(): void;
    };
    element.setAttribute("profile", cfg.profile);
    // A deployment that mirrors the runtime says so here; without it the console uses the pinned
    // CDN, which is the package's own default and the one the policy names.
    if (cfg.runtimeIndexUrl) element.setAttribute("index-url", cfg.runtimeIndexUrl);
    element.setAttribute("autostart", "false");
    // PROPERTIES, not attributes, and set before `start()` builds the engine. The element
    // reflects `profile`, `index-url`, `autostart` and `toolbar`; these four are not reflected - a
    // list and a boolean do not belong in a string attribute - so `setAttribute` would set nothing
    // and the interpreter would come up without its add-ons, wheels or credential setting.
    if (cfg.wheelhouseUrl) element.wheelhouseURL = cfg.wheelhouseUrl;
    if (cfg.addonBaseUrl) element.addonBaseURL = cfg.addonBaseUrl;
    if (cfg.addons.length > 0) element.addons = cfg.addons;
    if (cfg.optionalAddons.length > 0) element.optionalAddons = cfg.optionalAddons;
    if (cfg.persistCredentials) element.persistCredentials = true;
    // NO CONSOLE TOOLBAR AT ALL, because the window has somewhere to put what it says. Even
    // `toolbar: "status"` draws a light strip with its own border across the top of the console
    // inside a dark window - a second chrome, in a different palette, above the real one. The
    // console says all of it as an EVENT instead, and the window renders it in its own status row.
    // Clear, Clear history and Restart are in the ⋮ menu.
    element.setAttribute("toolbar", "none");
    // NO GREETING, because the window says both of its lines elsewhere: the console's key
    // bindings are a panel under Help, and its runtime-download note is the window's own status
    // row. What is left is what only the interpreter can say - which packages it loaded, which
    // Python it is. `banner: false` covers both lines because the notice follows the greeting's
    // switch; see the console's own note. Set BEFORE the element is connected, because the
    // greeting is written when the console builds its transcript.
    (element as unknown as { banner: string | false }).banner = false;
    // Bounds off, because this element is inside something that has already decided its height.
    // The console's own 20rem floor and 70vh ceiling are for a console a page laid out itself;
    // inside a maximized window they cap it at 70% of the viewport and leave the window's
    // background showing through below.
    element.style.setProperty("--bp-console-min-height", "0");
    element.style.setProperty("--bp-console-max-height", "none");
    // No card edge and no rounding: inside a window whose chrome already draws a border, a second
    // one is a panel floating in a frame rather than a terminal filling it.
    element.style.setProperty("--bp-console-border-width", "0");
    element.style.setProperty("--bp-console-radius", "0");
    // THE WINDOW'S TEXT-SIZE SLIDER REACHES THE CONSOLE. `--term-scale` is what the slider writes
    // on the window root, and every size in the window's chrome is `calc(Npx * var(--term-scale))`;
    // the console has its own sizing tokens and reads none of it, so without this line the slider
    // resizes the furniture and leaves the transcript as it was. Mapped HERE rather than inside
    // the console package, because a console reaching for `--term-scale` by name would only work
    // inside this one window. `--bp-console-scale` is the console's multiplier, and this is the
    // join.
    element.style.setProperty("--bp-console-scale", "var(--term-scale, 1)");
    // THE CONSOLE TAKES THE WINDOW'S COLOURS. The window's appearance swatches set `--term-bg`
    // and `--term-fg` on its root and flip `data-term-light`; the console has its own palette and
    // reads neither, so without these lines Paper or Forest recolours the chrome around a console
    // that stays the near-black it ships with.
    //
    // TRANSPARENT, not `--term-bg`: the window is translucent by design (`--term-alpha` is one of
    // the three appearance controls) and an opaque console filling the body would paint over
    // exactly the surface alpha applies to. The rest is derived from `--term-fg` so it follows any
    // theme, including one a host adds later. NOT the syntax palette - keywords, strings, numbers
    // and the prompt are contrast-checked pairs in the console's own light and dark sets, so they
    // follow `theme` instead, below.
    element.style.setProperty("--bp-console-background", "transparent");
    element.style.setProperty("--bp-console-foreground", "var(--term-fg, #d8d8d2)");
    element.style.setProperty("--bp-console-result", "var(--term-fg, #d8d8d2)");
    element.style.setProperty(
      "--bp-console-muted",
      "color-mix(in srgb, var(--term-fg, #d8d8d2) 62%, var(--term-bg, #12131a))",
    );
    element.style.setProperty(
      "--bp-console-border",
      "color-mix(in srgb, var(--term-fg, #d8d8d2) 22%, var(--term-bg, #12131a))",
    );
    element.addEventListener("browser-python-status", (event) => {
      const detail = (event as CustomEvent<{ state: string; label: string; summary?: string }>)
        .detail;
      if (!detail) return;
      statusState = detail.state;
      publish(detail.summary ? `${detail.label} — ${detail.summary}` : detail.label);
    });
    root.append(element);

    let starting: Promise<void> | null = null;
    let ready = false;

    /**
     * Bring the interpreter up and run the portal's opening lines into it. `initialSource` runs
     * INSIDE this promise, which is what makes "before any queued example" a guarantee rather
     * than a hope: every path that runs Python awaits `start()`. A failure clears the memo, so a
     * visitor whose network dropped during the runtime download can press again.
     */
    const start = (): Promise<void> => {
      if (!starting) {
        publish("Starting Python…");
        starting = element
          .start()
          .then(async () => {
            if (cfg.initialSource) await element.execute(cfg.initialSource);
            ready = true;
            publish("Python is ready");
          })
          .catch((error: unknown) => {
            starting = null;
            ready = false;
            publish(error instanceof Error ? error.message : String(error));
            throw error;
          });
      }
      return starting;
    };

    return {
      id: `local-${index}`,
      label: `Session ${index}`,
      root,
      start,
      started: () => ready,
      async runExample(_request, example) {
        await start();
        await element.runExample(example);
      },
      transcript: () => element.transcript(),
      // The console's own file panel is in this document and is the authoritative list; the menu
      // does not repeat it.
      artifacts: () => [],
      // What the interpreter said about itself, straight from the element. Null until it starts.
      ready: () => (element.readyInfo as ReadyReport | null) ?? null,
      download: () => Promise.resolve(),
      clearTranscript: () => element.clear(),
      clearHistory: () => element.clearHistory(),
      // A restart is a NEW interpreter, so it is a new `initialSource` too. The documented rule is
      // "once after every newly created interpreter becomes ready", and a restart creates one;
      // leaving the memo in place gives a fresh interpreter without the setup the portal promised.
      async restart() {
        ready = false;
        starting = null;
        publish("Restarting Python…");
        await element.restart();
        if (cfg.initialSource) await element.execute(cfg.initialSource);
        ready = true;
        starting = Promise.resolve();
        publish("Python is ready");
      },
      focus: () => element.focus(),
      dispose: () => element.dispose(),
    };
  }

  /**
   * A session that lives on the playground origin, driven through the two-origin bridge. The
   * frame's document is the DEPLOYMENT's, not this build's: it serves the interpreter, calls
   * `attachPlaygroundBridge` with its own registered-example registry, and answers a `run-example`
   * by name. No source crosses; the portal sends `{ exampleId, digest }` and hears back whether
   * the name resolved. Transcript operations report `null` rather than pretending, because a Copy
   * button that silently copied nothing is a lie the visitor discovers when they paste.
   */
  function framedSession(index: number, cfg: PythonPlaygroundConfig): Session {
    const root = document.createElement("div");
    root.className = "portal-python-session";
    const frame = document.createElement("iframe");
    frame.className = "portal-python-frame";
    frame.title = `Python session ${index}`;
    // No `allow-same-origin` relative to the PORTAL: the frame's own origin is what isolates it.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-downloads");
    frame.setAttribute("referrerpolicy", "no-referrer");
    root.append(frame);

    let bridge: PlaygroundHost | null = null;
    let sessionId: string | null = null;
    // The child's transcript, as it last reported it. KEPT rather than fetched, which is what
    // makes the window's Copy control work across an origin: writing to the clipboard needs the
    // visitor's activation and an activation does not survive an `await`, so a Copy that asked the
    // frame and then wrote would succeed in one browser and fail in another. The child pushes its
    // transcript on every change instead.
    let transcript: { text: string; truncated: boolean } | null = null;
    let files: EmbeddedArtifact[] = [];

    // A readiness promise bound to ONE child session. `PlaygroundHost.runExample()` throws before
    // its handshake completes, by design - it has no session to address - so the wait is for
    // `onReady` rather than for the import, which resolves while the child has not said hello.
    // Re-armed on every invalidation: a reload, a restart or a replaced document is a NEW session,
    // and anything queued against the previous one is rejected with a reason rather than delivered
    // into a conversation that no longer exists.
    let armed: {
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
      settled: boolean;
    };
    const arm = (): void => {
      let resolve: () => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const promise = new Promise<void>((res, rej) => {
        resolve = () => {
          armed.settled = true;
          res();
        };
        reject = (error) => {
          armed.settled = true;
          rej(error);
        };
      });
      // A promise nobody awaits still rejects, and an unhandled rejection is noise a portal should
      // not print at a visitor. The no-op keeps it handled until a real caller attaches.
      promise.catch(() => undefined);
      armed = { promise, resolve, reject, settled: false };
    };
    arm();

    /** How long the parent waits for a child that may simply not be there. */
    const HANDSHAKE_MS = 20_000;

    const ready = import("@freva-org/browser-python/embed").then((embed) => {
      bridge = embed.createPlaygroundHost({
        frame,
        playgroundOrigin: cfg.playgroundOrigin as string,
        onReady: (id) => {
          sessionId = id;
          publish("Python is ready");
          armed.resolve();
        },
        onInvalidated: (reason) => {
          sessionId = null;
          if (!armed.settled) armed.reject(new Error(`the playground ${reason}`));
          arm();
          publish(`The playground ${reason}.`);
        },
        onExampleRefused: (id, reason) =>
          announce(`The playground refused \u201c${id}\u201d: ${reason}.`, "warn"),
        onTranscript: (value) => {
          transcript = value;
        },
        onArtifacts: (list) => {
          files = list;
          // The menu is what shows them, so it is rebuilt when the list changes rather than only
          // when the visitor opens it.
          win?.setMenuSections(menuSections());
        },
      });
    });

    /**
     * One bounded operation, with its refusal said in the window rather than in a console. The
     * four exist because a parent cannot do any of them itself across an origin: it cannot read
     * the child's transcript, clear it, or start a new interpreter in its document. Each request
     * is a NAME with no arguments - nowhere to put a Python command - and the child decides what
     * the name means.
     */
    const perform = async (op: BridgeOp, whenItFails: string): Promise<void> => {
      try {
        await ready;
        await bridge?.perform(op, sessionId ?? undefined);
      } catch (error) {
        announce(
          `${whenItFails}: ${error instanceof Error ? error.message : String(error)}`,
          "warn",
        );
        throw error;
      }
    };

    /** Wait for THIS session's handshake, bounded, so a frame that never loads is not forever. */
    const waitForChild = async (): Promise<void> => {
      await ready;
      if (sessionId) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `the playground at ${cfg.playgroundOrigin} did not answer within ` +
                  `${HANDSHAKE_MS / 1000} seconds. Check that the origin is serving the ` +
                  `generated playground artifact.`,
              ),
            ),
          HANDSHAKE_MS,
        );
      });
      try {
        await Promise.race([armed.promise, bounded]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    return {
      id: `framed-${index}`,
      label: `Session ${index}`,
      root,
      // Starting a framed session is loading the frame and completing the handshake. The
      // INTERPRETER is the child's to start, and so is `initialSource`: the parent cannot send
      // Python, so the generated playground artifact carries the portal's opening lines and runs
      // them itself. See `emitPlaygroundArtifact` on the build side.
      async start() {
        publish("Connecting to the playground\u2026");
        if (!frame.src) frame.src = `${cfg.playgroundOrigin as string}/`;
        await waitForChild();
      },
      started: () => sessionId !== null,
      async runExample(request) {
        await this.start();
        // The name and the digest, and nothing else. There is nowhere in this call to put Python.
        bridge?.runExample(request.exampleId, request.digest, sessionId ?? undefined);
      },
      // The child's transcript, or `null` before it has sent one. `null` means "not reachable
      // yet", which is what the menu's disabled state reads - not "the transcript is empty". A
      // truncated transcript says so in the text rather than handing over a prefix silently.
      transcript: () =>
        transcript === null
          ? null
          : transcript.truncated
            ? `[earlier output was dropped: the playground's transcript limit was reached]\n${transcript.text}`
            : transcript.text,
      artifacts: () =>
        files.map((file) => ({ name: file.name, size: file.size, state: file.state })),
      // NOT REPORTED across the frame, and not guessed. The embed bridge announces readiness with
      // a session id and no payload, and repeating the portal's own configuration here would turn
      // "what the interpreter loaded" into "what was asked for" - the substitution the help panel
      // exists to avoid. The panel shows what the build resolved and says the rest is not visible.
      ready: () => null,
      async download(name) {
        // The picker is opened SYNCHRONOUSLY inside this call, from the visitor's own click on a
        // parent-origin control, and the bytes then stream through the bridge one acknowledged
        // chunk at a time. No `Blob`: a file worth a picker is too large to hold in the portal's
        // memory, and the backpressure reaches all the way back to the child's Worker.
        const { saveFilePickerSink } = await import("@freva-org/browser-python/embed");
        if (!bridge) throw new Error("the playground is not connected");
        await bridge.download(name, saveFilePickerSink);
      },
      clearTranscript: () => {
        void perform("clear-transcript", "The playground could not clear its transcript");
      },
      clearHistory: () => {
        void perform("clear-history", "The playground could not clear its history");
      },
      restart: async () => {
        // ASK FIRST, replace only if asking fails. The child answering `restart` brings up a new
        // interpreter in the SAME document, so the session survives and everything the parent
        // holds against it stays valid: the artifact list, a download in flight, the transcript.
        // Reloading the frame invalidates all of that, but stays as the fallback because it is
        // the one restart a parent can always perform by itself - a child that has stopped
        // answering is exactly when a visitor presses Restart.
        publish("Restarting Python\u2026");
        try {
          await perform("restart", "The playground could not restart");
          publish("Python is ready");
          return;
        } catch {
          // fall through to replacing the document
        }
        const url = new URL(`${cfg.playgroundOrigin as string}/`);
        url.searchParams.set("session", String(Date.now()));
        sessionId = null;
        transcript = null;
        files = [];
        frame.src = url.toString();
        await waitForChild();
      },
      focus: () => frame.focus(),
      dispose: () => {
        if (!armed.settled) armed.reject(new Error("the session was closed"));
        void bridge?.stop();
      },
    };
  }
}
