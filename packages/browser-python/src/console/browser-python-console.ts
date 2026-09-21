/**
 * browser-python-console.ts - the custom element.
 *
 * Owns the DOM, the attributes, the toolbar and the engine's LIFETIME; behaviour lives in
 * `console-controller.ts`, the surface behind `ConsoleSurfaceAdapter`. The only file that
 * touches `customElements`, and reached only through the `/console` entry point, so importing
 * the headless engine can never register an element or load jQuery. Shadow DOM keeps a host
 * page's `div { }` rule out and makes `::part()` the theming API.
 */

import { previewKind, previewRefusal } from "../artifact-mime.js";
import { createBrowserPython } from "../browser-python.js";
import type {
  ArtifactInfo,
  BrowserPythonAddon,
  ArtifactsEvent,
  BrowserPython,
  BrowserPythonProfile,
  BrowserPythonReadyInfo,
  OutputEvent,
} from "../types.js";
import {
  DEFAULT_BANNER,
  DEFAULT_HIGHLIGHT_OPTIONS,
  DEFAULT_HISTORY_OPTIONS,
  DEFAULT_OUTPUT_OPTIONS,
  type BrowserPythonConsoleElement,
  type ConsoleHighlightOptions,
  type ConsoleHistoryOptions,
  type ConsoleOutputOptions,
  type ConsoleTheme,
  type ConsoleToolbarMode,
} from "./console-types.js";
import { ConsoleController } from "./console-controller.js";
import { JQueryTerminalAdapter } from "./adapters/jquery-terminal-adapter.js";
import { CONSOLE_STYLES } from "./styles.generated.js";
import { appendHighlighted } from "./highlight.js";

/** The default tag. Namespaced, because an unprefixed `python-console` would be a landgrab. */
export const DEFAULT_TAG_NAME = "freva-python-console";

const STATUS_TEXT: Readonly<Record<string, string>> = {
  idle: "Not started",
  loading: "Loading browser Python…",
  ready: "Ready",
  busy: "Running",
  error: "Error",
  disposed: "Stopped",
};

/**
 * Said once, on the first load. No size is promised: the figure moves with the runtime, and a
 * number in a UI string goes stale silently.
 */
const FIRST_LOAD_NOTICE = "First visit downloads the runtime; later visits use the browser cache.";

/** How much of a failure fits on the status line before it stops being a line. */
const STATUS_DETAIL_LIMIT = 120;

/**
 * One line, always. A failed start's detail is a Python traceback - 13 lines and 87px verbatim,
 * in a toolbar that then grows to 134px and wraps around its own buttons. A traceback reads
 * bottom-up, so the LAST line is the one worth the space; the full text stays in the transcript
 * and on the element's `title`.
 */
function summarise(detail: string | undefined): string {
  if (!detail) return "";
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const first = lines[0] ?? "";
  // The exception line, not the first and not the last. The first is always "Traceback (most
  // recent call last):"; the last is not reliably the exception either, Pyodide appending its
  // own advice after it. So: the last line that names an exception, falling back to the first.
  const isException = /^[A-Za-z_][\w.]*(?:Error|Exception|Warning|Exit|Interrupt)\b\s*(?::|$)/;
  const exception = [...lines].reverse().find((line) => isException.test(line));
  const chosen = lines.length === 1 ? first : (exception ?? first);
  return chosen.length > STATUS_DETAIL_LIMIT
    ? `${chosen.slice(0, STATUS_DETAIL_LIMIT - 1).trimEnd()}…`
    : chosen;
}

/**
 * The base class, or a stand-in when there is no DOM. `class X extends HTMLElement` is evaluated
 * when the MODULE is, so on a server merely importing `@freva-org/browser-python/console` throws
 * `HTMLElement is not defined` naming no import, and this entry point is documented as safe to
 * import during server-side rendering. The stand-in is never constructed.
 */
/** How long a Delete button stays armed before disarming itself. */
const DELETE_CONFIRM_MS = 5000;
/** How much of a text artifact a preview reads. Enough to see the shape of a CSV, not a whole one. */
const PREVIEW_TEXT_BYTES = 64 * 1024;
/** Above this, media is offered for download rather than rendered inline. */
const PREVIEW_MEDIA_BYTES = 16 * 1024 * 1024;
/** A blob URL revoked in the same tick can cancel the download it was created for. */
const REVOKE_DELAY_MS = 60_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The file count, and the limit only when it is close enough to matter. A permanent "3 of 64"
 * trains people to ignore it, and then it is invisible on the run that exceeds it.
 */
function describeCapacity(count: number, maxFiles: number | undefined): string {
  const files = `${count} file${count === 1 ? "" : "s"}`;
  if (maxFiles === undefined || count < maxFiles * 0.75) return files;
  return `${files} of ${maxFiles} - this browser workspace is nearly full`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Blob path's ceiling, mirrored from the engine. A copy rather than an import, because
 * reaching into the worker's module for one constant would pull the whole OPFS filesystem into
 * the console bundle. `tests/artifact-limits.test.ts` fails if the two disagree.
 */
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

function transferLabel(progress: {
  transferred: number;
  total: number;
  phase?: "transferring" | "finishing";
}): string {
  if (progress.phase === "finishing") return "finishing…";
  const percent =
    progress.total > 0 ? Math.floor((progress.transferred / progress.total) * 100) : 0;
  return `downloading - ${percent}% of ${formatBytes(progress.total)}`;
}

/**
 * Quote a filename for use inside an attribute selector: `CSS.escape` where it exists, otherwise
 * by hand, because these filenames are chosen by Python and a `"` in one would end the selector
 * early and match the wrong row.
 */
function cssEscape(value: string): string {
  const escaper = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  if (typeof escaper === "function") return escaper(value);
  return value.replace(/["\\]/g, "\\$&");
}

/** The profiles the engine accepts, in one place, so the element cannot fall behind it. */
const PROFILES: readonly BrowserPythonProfile[] = ["minimal", "xarray-zarr", "freva-client"];

function isProfile(value: string | null): value is BrowserPythonProfile {
  return value !== null && (PROFILES as readonly string[]).includes(value);
}

const ElementBase: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

/**
 * A suggestion as ONE line, because that is what ghost text can be. History keeps a pasted block
 * as a single entry so `↑` recalls the program rather than its last line, and drawn literally a
 * multi-line suffix puts its own newlines into the command line. Accepting still takes the WHOLE
 * entry, and the `…` is what promises that.
 */
function oneLine(text: string): string {
  const stop = text.indexOf("\n");
  if (stop === -1) return text;
  return `${text.slice(0, stop).trimEnd()} …`;
}

export class BrowserPythonConsole extends ElementBase implements BrowserPythonConsoleElement {
  static readonly observedAttributes = [
    "profile",
    "theme",
    "autostart",
    "hide-toolbar",
    "toolbar",
    "hide-files",
    "index-url",
    "worker-url",
  ];

  /** One parsed stylesheet, shared by every console on the page. See `#adoptStyles`. */
  static #sheet: CSSStyleSheet | null = null;

  #root: ShadowRoot;
  #container!: HTMLElement;
  #toolbar!: HTMLElement;
  /** The toolbar's action buttons, so `toolbar="status"` can drop them and keep the status line. */
  readonly #toolbarButtons: HTMLButtonElement[] = [];
  #statusLine!: HTMLElement;
  #suggestion!: HTMLElement;
  #completionMenu!: HTMLElement;
  #searchLine!: HTMLElement;
  #liveRegion!: HTMLElement;
  #terminalHost!: HTMLElement;
  /** The `Jump to latest` control, shown only while the reader has scrolled away from the bottom. */
  #jumpButton: HTMLButtonElement | null = null;
  #filesPanel!: HTMLElement;
  #filesNote!: HTMLElement;
  #filesList!: HTMLElement;

  #adapter: JQueryTerminalAdapter | null = null;
  #controller: ConsoleController | null = null;

  #engine: BrowserPython | null = null;
  /**
   * Whether THIS element created the engine - the whole of the ownership rule. An injected
   * engine is never disposed here, since three components may share one interpreter. An
   * internally created one is disposed on `dispose()` but NOT on disconnect, a framework moving
   * an element in the DOM disconnecting and reconnecting it.
   */
  #ownsEngine = false;
  #started = false;
  /** The single in-flight startup, shared by every caller of `start()`. */
  #startPromise: Promise<void> | null = null;
  #mounted = false;

  #historyOptions: ConsoleHistoryOptions = { ...DEFAULT_HISTORY_OPTIONS };
  #outputOptions: ConsoleOutputOptions = { ...DEFAULT_OUTPUT_OPTIONS };
  #highlightOptions: ConsoleHighlightOptions = { ...DEFAULT_HIGHLIGHT_OPTIONS };
  #banner: string | false = DEFAULT_BANNER;
  #announcedFirstLoad = false;
  #wheelhouseURL: string | undefined;
  #startupSource: string | undefined;
  #addons: readonly BrowserPythonAddon[] | undefined;
  #optionalAddons: readonly BrowserPythonAddon[] | undefined;
  /**
   * What the interpreter reported when it came up, or null when none is running. A host drawing
   * its own chrome has no other way to say what the visitor got - profile, add-ons, package
   * versions, whether the workspace is disk-backed - and each is an OBSERVATION rather than the
   * configuration the host asked for. Cleared on restart and on dispose.
   */
  #readyInfo: BrowserPythonReadyInfo | null = null;
  #addonBaseURL: string | undefined;
  #indexURL: string | undefined;
  #workerURL: string | undefined;
  #persistCredentials: boolean | undefined;

  /** The workspace's contents as last reported. Rendered; never the source of truth. */
  #artifacts: readonly ArtifactInfo[] = [];
  /**
   * At most one open preview, by artifact name. A preview holds a blob URL, so six of them is six
   * copies of an export pinned in memory until the tab closes.
   */
  #openPreview: string | null = null;
  #previewUrl: string | null = null;
  /** The artifact whose Delete button is armed, and the timer that disarms it. */
  #pendingDelete: string | null = null;
  #pendingDeleteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Downloads in flight, by artifact name, each cancellable from its row. */
  #transfers = new Map<string, AbortController>();
  /** How far each of them has got, for the row's own label. */
  #progress = new Map<
    string,
    { transferred: number; total: number; phase?: "transferring" | "finishing" }
  >();

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
  }

  // ------ properties

  get engine(): BrowserPython | undefined {
    return this.#engine ?? undefined;
  }

  set engine(engine: BrowserPython | undefined) {
    if (engine === this.#engine) return;
    const previous = this.#ownsEngine ? this.#engine : null;
    const wasStarted = this.#started;
    // UNSUBSCRIBE FIRST, then dispose. An engine emits a status as it dies and this element is
    // the one killing it, so disposing while still subscribed prints the old engine's obituary
    // ("Python stopped", "This engine was disposed") into the NEW engine's transcript.
    this.#controller?.detach();
    this.#engine = engine ?? null;
    this.#ownsEngine = false;
    // The "has this console been started" flag belongs to the new engine, not the one just
    // replaced. Without this reset, injecting an engine into an already-started console leaves
    // the status line reporting the OLD engine's last state and no typing wakes it.
    this.#started = false;
    if (this.#engine && this.#controller) this.#controller.attach(this.#engine);
    // A console that was already running follows the engine it is handed. `start()` is
    // idempotent, so an already-started engine is adopted and one that is not is brought up -
    // which is what `<freva-python-console autostart>` plus a module-script assignment looks
    // like.
    if (this.#engine && (wasStarted || this.autoStart) && this.isConnected) void this.start();
    // Last, and only now that nothing is listening: an engine this element created is its to
    // release, because once replaced it can never be reached again.
    previous?.dispose();
  }

  get autoStart(): boolean {
    return this.hasAttribute("autostart");
  }

  set autoStart(value: boolean) {
    this.toggleAttribute("autostart", value);
  }

  get profile(): BrowserPythonProfile {
    // Every profile the engine has, not two of them. A hand-written pair of cases silently boots
    // `profile="freva-client"` as minimal, with none of the Freva wheels. Derived from the type,
    // so a fourth profile cannot be added to the engine and forgotten here.
    const value = this.getAttribute("profile");
    return isProfile(value) ? value : "minimal";
  }

  set profile(value: BrowserPythonProfile) {
    this.setAttribute("profile", value);
  }

  /**
   * Where the Pyodide runtime is served from, for an engine this element creates - a self-hosted
   * runtime is the ordinary deployment. Ignored when a host injects its own engine. Also readable
   * as `index-url`.
   */
  get indexURL(): string | undefined {
    return this.#indexURL ?? this.getAttribute("index-url") ?? undefined;
  }

  set indexURL(value: string | undefined) {
    this.#indexURL = value;
  }

  // `wheelhouseURL` is where the `freva-client` profile's wheels are served from, for an engine
  // this element creates; ignored when a host injects its own engine.

  /**
   * Where the worker module is served from, for an engine this element creates. The engine
   * resolves it from its own module URL by default, which is wrong whenever the console layer is
   * bundled separately - the URL is then relative to the console bundle and the worker 404s.
   * Also settable as `worker-url`.
   */
  get workerURL(): string | undefined {
    return this.#workerURL ?? this.getAttribute("worker-url") ?? undefined;
  }

  set workerURL(value: string | undefined) {
    this.#workerURL = value;
  }

  get wheelhouseURL(): string | undefined {
    return this.#wheelhouseURL;
  }

  set wheelhouseURL(value: string | undefined) {
    this.#wheelhouseURL = value;
  }

  /**
   * Python to run before this console is usable - extra wheels, a `sys.path` entry, a warmed
   * import. A PROPERTY, not an attribute: a program does not belong in HTML, and set before
   * `start()`, since the engine reads it when it boots.
   *
   * NOT `execute()`. This does not reach the transcript or the history, and a failure rejects
   * `start()` instead of leaving a console that looks ready. See `BrowserPythonOptions.startupSource`.
   */
  get startupSource(): string | undefined {
    return this.#startupSource;
  }

  set startupSource(value: string | undefined) {
    this.#startupSource = value;
  }

  /**
   * Curated add-ons to prepare, as PROPERTIES rather than attributes: a list smuggled through a
   * string attribute is a parser plus a way to spell it wrong. Set them before `start()`, since
   * the engine is built once from what is here then.
   */
  get addons(): readonly BrowserPythonAddon[] | undefined {
    return this.#addons;
  }

  set addons(value: readonly BrowserPythonAddon[] | undefined) {
    this.#addons = value;
  }

  /**
   * The subset of `addons` whose absence must not stop the interpreter. Same shape and timing as
   * `addons`, and it changes only what a FAILURE means: the artefacts are still fetched,
   * digest-checked and refused if wrong. See the engine option of the same name.
   */
  get optionalAddons(): readonly BrowserPythonAddon[] | undefined {
    return this.#optionalAddons;
  }

  set optionalAddons(value: readonly BrowserPythonAddon[] | undefined) {
    this.#optionalAddons = value;
  }

  /** Where the add-ons' pinned artefacts are served from - see the engine option of the same name. */
  get addonBaseURL(): string | undefined {
    return this.#addonBaseURL;
  }

  /** What the running interpreter reported at start, or `null` when none is running. */
  get readyInfo(): BrowserPythonReadyInfo | null {
    return this.#readyInfo;
  }

  set addonBaseURL(value: string | undefined) {
    this.#addonBaseURL = value;
  }

  /** Keep credentials across reloads. Off unless set - see the engine option of the same name. */
  get persistCredentials(): boolean | undefined {
    return this.#persistCredentials;
  }

  set persistCredentials(value: boolean | undefined) {
    this.#persistCredentials = value;
  }

  get theme(): ConsoleTheme {
    const value = this.getAttribute("theme");
    return value === "dark" || value === "light" ? value : "auto";
  }

  set theme(value: ConsoleTheme) {
    this.setAttribute("theme", value);
  }

  get hideToolbar(): boolean {
    return this.toolbarMode === "none";
  }

  set hideToolbar(value: boolean) {
    this.toolbarMode = value ? "none" : "full";
  }

  /**
   * How much of the toolbar to draw: `full`, `status`, or `none`.
   *
   * `status` is for a host that has put this console inside its OWN window chrome: it already
   * offers Clear, Clear history and Restart in its own menu, but not the console's status line
   * ("Loading Python…", "Ready", the reason a start failed), which hiding the whole toolbar also
   * takes away. `hide-toolbar` means `none`; this attribute wins when both are present.
   */
  get toolbarMode(): ConsoleToolbarMode {
    const value = this.getAttribute("toolbar");
    if (value === "full" || value === "status" || value === "none") return value;
    return this.hasAttribute("hide-toolbar") ? "none" : "full";
  }

  set toolbarMode(value: ConsoleToolbarMode) {
    this.setAttribute("toolbar", value);
  }

  /**
   * Hide the file panel. On by default, because a console whose Python writes a NetCDF file and
   * offers no way to get it produced nothing. A host with its own file browser turns this off.
   */
  get hideFiles(): boolean {
    return this.hasAttribute("hide-files");
  }

  set hideFiles(value: boolean) {
    this.toggleAttribute("hide-files", value);
  }

  get historyOptions(): ConsoleHistoryOptions {
    return { ...this.#historyOptions };
  }

  set historyOptions(value: ConsoleHistoryOptions) {
    this.#historyOptions = { ...DEFAULT_HISTORY_OPTIONS, ...value };
    this.#controller?.setHistoryOptions(this.#historyOptions);
  }

  get outputOptions(): ConsoleOutputOptions {
    return { ...this.#outputOptions };
  }

  set outputOptions(value: ConsoleOutputOptions) {
    this.#outputOptions = { ...DEFAULT_OUTPUT_OPTIONS, ...value };
    this.#controller?.setOutputOptions(this.#outputOptions);
  }

  get highlightOptions(): ConsoleHighlightOptions {
    return { ...this.#highlightOptions };
  }

  set highlightOptions(value: ConsoleHighlightOptions) {
    this.#highlightOptions = { ...DEFAULT_HIGHLIGHT_OPTIONS, ...value };
    this.#controller?.setHighlightOptions(this.#highlightOptions);
  }

  /** Plain text, or false. A string only - see the security notes on why there is no HTML banner. */
  get banner(): string | false {
    return this.#banner;
  }

  set banner(value: string | false) {
    this.#banner = value;
  }

  // ------ lifecycle

  connectedCallback(): void {
    if (!this.#mounted) this.#build();
    this.#applyTheme();
    // RE-SUBSCRIBE. `disconnectedCallback` drops the engine subscriptions and a framework moving
    // this element triggers both callbacks, so without this the console comes back looking alive
    // and deaf. `attach` detaches first, so a connect with no preceding disconnect cannot
    // double-subscribe.
    if (this.#engine && this.#controller) this.#controller.attach(this.#engine);
    if (this.autoStart && !this.#started) void this.start();
  }

  /**
   * Disconnected. Subscriptions go; the engine does NOT. A framework moving this element in the
   * DOM calls this and then `connectedCallback` again, and terminating a Worker with every
   * variable the visitor built up in it, because a list re-ordered, would be unforgivable.
   * Disposal is explicit, through `dispose()`.
   */
  disconnectedCallback(): void {
    this.#controller?.detach();
  }

  attributeChangedCallback(name: string): void {
    if (name === "theme") this.#applyTheme();
    if ((name === "hide-toolbar" || name === "toolbar") && this.#toolbar) this.#applyToolbar();
    if (name === "hide-files" && this.#filesPanel) this.#renderArtifacts();
    if (name === "profile" && this.#started) {
      // Said, rather than silently ignored, and what is said depends on who owns the engine.
      // `profile` decides which packages load, so changing it means a NEW interpreter: an engine
      // this element created is rebuilt by `restart()`, while for an injected one "call
      // restart()" would be advice that does nothing.
      this.#renderStatus(
        this.#engine?.state ?? "idle",
        this.#ownsEngine
          ? `The profile attribute changed to "${this.getAttribute("profile")}". Call restart() ` +
              `to bring up an interpreter with it; the running one is unchanged.`
          : `The profile attribute changed to "${this.getAttribute("profile")}", but this console ` +
              `is using an engine supplied by the host, whose profile only the host can change.`,
      );
    }
  }

  // ------ construction

  #build(): void {
    this.#mounted = true;
    const doc = this.ownerDocument;

    this.#adoptStyles(doc);

    this.#container = doc.createElement("div");
    this.#container.className = "bp-container";
    this.#container.setAttribute("part", "container");
    this.#root.append(this.#container);

    this.#buildToolbar(doc);

    this.#terminalHost = doc.createElement("div");
    this.#terminalHost.className = "bp-transcript";
    // A log region, not an alert: output arrives continuously and a screen reader must not
    // interrupt the user for every line. `aria-live` is polite, and stdout is NOT announced
    // character by character - only status changes are, through `#liveRegion`.
    this.#terminalHost.setAttribute("role", "log");
    this.#terminalHost.setAttribute("aria-label", "Python console transcript");

    // Give the terminal focus when someone clicks it. The surface library focuses itself through
    // delegated document-level handlers, which a shadow root defeats: it retargets every event
    // that leaves it to the HOST element, so the library's selectors never match and it never
    // marks itself enabled - a console that looks normal, takes a click and drops every
    // keystroke, and that a suite calling `focus()` directly never catches.
    //
    // On `click`, not `mousedown`, and only when the selection is empty, so a drag-selection
    // survives and copying keeps working; `preventDefault` is deliberately not called. CAPTURE
    // phase, because the library calls `stopPropagation` on clicks inside the terminal.
    // DEFERRED, because its own click handling ends by putting focus where it thinks it belongs.
    this.#terminalHost.addEventListener(
      "click",
      () => {
        setTimeout(() => this.#focusFromPointer(), 0);
      },
      true,
    );

    // Let a drag-selection survive the release, the other half of being able to copy. The
    // library decides on `mouseup` whether the press was a click or the end of a selection by
    // asking `window.getSelection()`, which has no useful answer from outside a shadow root:
    // Chrome reports the document's selection collapsed while the real one lives in the shadow
    // tree, so the library concludes "nothing selected", focuses its hidden clipboard textarea
    // and scrolls to the bottom. It cannot be told about the shadow selection and must not be
    // patched, so the release is kept from it: CAPTURE on the host, only while a selection
    // stands, so click-to-focus still works.
    this.#terminalHost.addEventListener(
      "mouseup",
      (event) => {
        if (this.#selectionHeld()) event.stopPropagation();
      },
      true,
    );

    // `Jump to latest` is a control rather than an autoscroll: output arriving while somebody
    // reads further up must not drag them away, but no sign that anything happened is what makes
    // a console look frozen. Inside the transcript, absolutely positioned against it, so it
    // travels with the scroller instead of floating over the window's chrome.
    this.#jumpButton = doc.createElement("button");
    this.#jumpButton.type = "button";
    this.#jumpButton.className = "bp-jump";
    this.#jumpButton.setAttribute("part", "jump");
    this.#jumpButton.textContent = "Jump to latest";
    this.#jumpButton.hidden = true;
    this.#jumpButton.addEventListener("click", () => {
      this.#adapter?.followLatest();
      this.#adapter?.focus();
    });
    this.#terminalHost.append(this.#jumpButton);
    this.#container.append(this.#terminalHost);
    this.#buildFilesPanel(doc);

    this.#suggestion = doc.createElement("div");
    this.#suggestion.className = "bp-suggestion";
    this.#suggestion.setAttribute("part", "suggestion");
    this.#suggestion.hidden = true;
    this.#container.append(this.#suggestion);

    this.#completionMenu = doc.createElement("ul");
    this.#completionMenu.className = "bp-completion";
    this.#completionMenu.setAttribute("part", "completion-menu");
    this.#completionMenu.setAttribute("role", "listbox");
    this.#completionMenu.setAttribute("aria-label", "Python completions");
    this.#completionMenu.hidden = true;
    this.#container.append(this.#completionMenu);

    this.#searchLine = doc.createElement("div");
    this.#searchLine.className = "bp-search";
    this.#searchLine.setAttribute("part", "history-search");
    this.#searchLine.setAttribute("role", "status");
    this.#searchLine.hidden = true;
    this.#container.append(this.#searchLine);

    // Off-screen, polite, and used ONLY for state changes. Announcing stdout here would read a
    // thousand-line loop aloud.
    this.#liveRegion = doc.createElement("div");
    this.#liveRegion.className = "bp-sr-only";
    this.#liveRegion.setAttribute("aria-live", "polite");
    this.#liveRegion.setAttribute("role", "status");
    this.#container.append(this.#liveRegion);

    this.#adapter = new JQueryTerminalAdapter({
      document: doc,
      highlight: this.#highlightOptions.enabled !== false,
      highlightLive:
        this.#highlightOptions.enabled !== false && this.#highlightOptions.live !== false,
      // A pasted buffer arrives here as ONE string with its newlines intact, and `PyodideConsole`
      // compiles in `single` mode - `submit()` would answer two statements with "SyntaxError:
      // multiple statements found while compiling a single statement". Multi-line input is a
      // block.
      onCommand: (line) => {
        const operation = line.includes("\n")
          ? this.#controller?.submitBlock(line, { origin: "paste" })
          : this.#controller?.submit(line);
        void operation?.catch((error: unknown) => this.#reportFailure(error));
      },
      onChange: () => {
        // TYPING BRINGS THE VIEW TO WHAT IS BEING TYPED. The browser goes part way, keeping a
        // focused caret in view, but it reveals the 16px clipboard textarea: against a 120-line
        // transcript parked at the top, the first keystroke leaves the prompt's box at 303..325
        // inside a viewport ending at 319, scrolled to and still clipped. Same decision
        // `submit()` makes, one step earlier: an INTERACTIVE act follows the latest.
        this.#adapter?.followLatest();
        this.#controller?.refreshSuggestion();
      },
      onKeydown: (event) => this.#onKeydown(event),
      onFollowChange: (state) => this.#renderFollow(state),
    });
    this.#adapter.mount(this.#terminalHost);

    this.#controller = new ConsoleController(
      this.#adapter,
      {
        onStatus: (state, detail) => this.#renderStatus(state, detail),
        onSuggestion: (suffix) => this.#renderSuggestion(suffix),
        onCompletion: (candidates, active) => this.#renderCompletion(candidates, active),
        onSearch: (state) => this.#renderSearch(state),
        onArtifacts: (event) => this.#onArtifacts(event),
      },
      {
        history: this.#historyOptions,
        output: this.#outputOptions,
        highlight: this.#highlightOptions,
      },
    );

    if (this.#banner !== false) {
      // A plain-text greeting rendered as a status line. There is no HTML banner and never will
      // be: a host-supplied string that reached `innerHTML` inside a shadow root would be a
      // scripting sink one careless template literal away.
      this.#adapter.appendText({ kind: "status", text: `${this.#banner}\n` });
    }
    if (this.#engine) this.#controller.attach(this.#engine);
    this.#renderStatus(this.#engine?.state ?? "idle");
  }

  /**
   * Attach the console's stylesheet without needing `style-src 'unsafe-inline'`. A constructable
   * stylesheet is not a style ELEMENT and CSP does not govern it, so a deployment can run this
   * under `style-src 'self'`; the `<style>` fallback is for an engine without
   * `adoptedStyleSheets`, whose host needs `'unsafe-inline'` - hence
   * `contentSecurityPolicy({ allowInlineStyles: true })` as an option. Adopting also shares one
   * parsed sheet across every console on the page.
   */
  #adoptStyles(doc: Document): void {
    const root = this.#root as ShadowRoot & { adoptedStyleSheets?: CSSStyleSheet[] };
    const view = doc.defaultView as (Window & { CSSStyleSheet?: typeof CSSStyleSheet }) | null;
    const Sheet = view?.CSSStyleSheet;
    if (Sheet && Array.isArray(root.adoptedStyleSheets) && "replaceSync" in Sheet.prototype) {
      try {
        BrowserPythonConsole.#sheet ??= (() => {
          const sheet = new Sheet();
          sheet.replaceSync(CONSOLE_STYLES);
          return sheet;
        })();
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, BrowserPythonConsole.#sheet];
        return;
      } catch {
        // A browser that has the API and refuses the sheet - fall through to the element.
      }
    }
    const style = doc.createElement("style");
    style.textContent = CONSOLE_STYLES;
    this.#root.append(style);
  }

  /** Apply `toolbarMode` to what is drawn. Called on build and on every attribute change. */
  #applyToolbar(): void {
    const mode = this.toolbarMode;
    this.#toolbar.hidden = mode === "none";
    for (const button of this.#toolbarButtons) button.hidden = mode !== "full";
  }

  #buildToolbar(doc: Document): void {
    this.#toolbar = doc.createElement("div");
    this.#toolbar.className = "bp-toolbar";
    this.#toolbar.setAttribute("part", "toolbar");

    this.#statusLine = doc.createElement("span");
    this.#statusLine.className = "bp-status";
    this.#statusLine.setAttribute("part", "status");
    this.#toolbar.append(this.#statusLine);

    const spacer = doc.createElement("span");
    spacer.className = "bp-spacer";
    this.#toolbar.append(spacer);

    const button = (label: string, part: string, onClick: () => void): HTMLButtonElement => {
      const element = doc.createElement("button");
      element.type = "button";
      element.className = "bp-button";
      element.setAttribute("part", part);
      // Text, not an icon. A toolbar of glyphs has no accessible name unless one is bolted on, and
      // a bolted-on name goes stale the first time somebody changes the glyph.
      element.textContent = label;
      element.addEventListener("click", onClick);
      this.#toolbar.append(element);
      this.#toolbarButtons.push(element);
      return element;
    };

    button("Clear", "clear-button", () => this.clear());
    // "Stop and restart", not "Stop". Ctrl+C cancels at a suspension point and cannot touch a
    // synchronous loop, so this button - which terminates the Worker - is the only thing that
    // reliably stops running Python. "Stop" would imply the interpreter survives, while every
    // variable is in fact discarded.
    button("Stop and restart", "restart-button", () => void this.restart());
    button("Clear history", "clear-history-button", () => this.clearHistory());
    this.#applyToolbar();
    this.#container.append(this.#toolbar);
  }

  // ------ the file panel

  /**
   * Where Python's file output becomes something a person can take away. Built once and updated
   * in place, with `createElement` and `textContent` only - no `innerHTML` anywhere near it,
   * because every string here is a filename chosen by the visitor's own Python.
   */
  #buildFilesPanel(doc: Document): void {
    this.#filesPanel = doc.createElement("section");
    this.#filesPanel.className = "bp-files";
    this.#filesPanel.setAttribute("part", "files");
    this.#filesPanel.setAttribute("aria-label", "Files written by Python");
    this.#filesPanel.hidden = true;

    const head = doc.createElement("div");
    head.className = "bp-files-head";
    const title = doc.createElement("span");
    title.className = "bp-files-title";
    title.textContent = "Files";
    this.#filesNote = doc.createElement("span");
    this.#filesNote.className = "bp-files-note";
    head.append(title, this.#filesNote);

    this.#filesList = doc.createElement("ul");
    this.#filesList.className = "bp-files-list";

    this.#filesPanel.append(head, this.#filesList);
    this.#container.append(this.#filesPanel);
  }

  #onArtifacts(event: ArtifactsEvent): void {
    this.#artifacts = event.artifacts;
    if (this.#openPreview && !event.artifacts.some((a) => a.name === this.#openPreview)) {
      this.#closePreview();
    }
    this.#renderArtifacts();
  }

  #renderArtifacts(): void {
    if (!this.#filesPanel) return;
    const workspace = this.#engine?.workspace ?? null;
    const unavailable = workspace !== null && !workspace.available;

    // Hidden when there is nothing to say. A permanently empty "Files" box is furniture.
    this.#filesPanel.hidden = this.hideFiles || (this.#artifacts.length === 0 && !unavailable);
    if (this.#filesPanel.hidden) return;

    this.#filesNote.textContent = unavailable
      ? (workspace?.detail ??
        "This browser cannot store Python file output on disk, so large files may fail.")
      : describeCapacity(this.#artifacts.length, workspace?.maxFiles);

    const doc = this.ownerDocument;
    this.#filesList.replaceChildren();
    for (const artifact of this.#artifacts) {
      this.#filesList.append(this.#renderArtifactRow(doc, artifact));
    }
  }

  #renderArtifactRow(doc: Document, artifact: ArtifactInfo): HTMLElement {
    const row = doc.createElement("li");
    row.className = "bp-file";
    row.dataset.state = artifact.state;
    // The selector `#renderProgress` uses to reach one row without rebuilding the list.
    row.dataset.artifact = artifact.name;

    const name = doc.createElement("span");
    name.className = "bp-file-name";
    name.textContent = artifact.name;
    row.append(name);

    const transferring = this.#transfers.get(artifact.name);
    const progress = this.#progress.get(artifact.name);

    const meta = doc.createElement("span");
    meta.className = "bp-file-meta";
    meta.textContent = transferring
      ? progress
        ? transferLabel(progress)
        : "starting download…"
      : artifact.state === "failed"
        ? `incomplete - ${artifact.failure ?? "the write failed"}`
        : artifact.state === "open"
          ? `${formatBytes(artifact.size)} - still being written`
          : artifact.state === "transferring"
            ? `${formatBytes(artifact.size)} - downloading`
            : formatBytes(artifact.size);
    row.append(meta);

    const actions = doc.createElement("span");
    actions.className = "bp-file-actions";
    const ready = artifact.state === "ready" && !transferring;

    const button = (label: string, part: string, onClick: () => void): HTMLButtonElement => {
      const element = doc.createElement("button");
      element.type = "button";
      element.className = "bp-button bp-file-button";
      element.setAttribute("part", part);
      element.textContent = label;
      element.addEventListener("click", onClick);
      actions.append(element);
      return element;
    };

    const preview = button(
      this.#openPreview === artifact.name ? "Hide" : "Preview",
      "file-preview-button",
      () => void this.#togglePreview(artifact),
    );
    preview.disabled = !ready;
    if (transferring) {
      // Cancel, in the place Download was: the artifact is FROZEN while a transfer runs, so a
      // download nobody can stop is a file the interpreter has lost until the tab closes. …until
      // the destination starts committing, from where every byte is written and the engine
      // ignores cancellation, so a live Cancel would lie about what pressing it does.
      const cancel = button("Cancel", "file-cancel-button", () => transferring.abort());
      if (progress?.phase === "finishing") {
        cancel.disabled = true;
        cancel.textContent = "Finishing…";
      }
    } else {
      const download = button("Download", "file-download-button", () =>
        this.#downloadArtifact(artifact),
      );
      download.disabled = !ready;
    }
    // Two-step, and no `confirm()`. A modal dialog inside a console steals focus from the prompt
    // and is blocked outright in some embeddings; an undoable delete is not possible when the
    // file is the only copy. So the button arms itself, says so, and disarms after a few seconds.
    const armed = this.#pendingDelete === artifact.name;
    const remove = button(armed ? "Confirm delete" : "Delete", "file-delete-button", () => {
      if (armed) void this.#deleteArtifact(artifact.name);
      else this.#armDelete(artifact.name);
    });
    // A file being written, or being read by a download, cannot be deleted: the worker refuses
    // either way, and a button that only produces an error message is not a button.
    remove.disabled =
      artifact.state === "open" || artifact.state === "transferring" || Boolean(transferring);
    if (armed) remove.classList.add("bp-file-button-armed");

    row.append(actions);

    if (this.#openPreview === artifact.name) {
      const holder = doc.createElement("div");
      holder.className = "bp-file-preview";
      holder.setAttribute("part", "file-preview");
      holder.dataset.for = artifact.name;
      row.append(holder);
      void this.#fillPreview(holder, artifact);
    }
    return row;
  }

  #armDelete(name: string): void {
    if (this.#pendingDeleteTimer) clearTimeout(this.#pendingDeleteTimer);
    this.#pendingDelete = name;
    this.#pendingDeleteTimer = setTimeout(() => {
      this.#pendingDelete = null;
      this.#renderArtifacts();
    }, DELETE_CONFIRM_MS);
    this.#renderArtifacts();
  }

  async #deleteArtifact(name: string): Promise<void> {
    if (this.#pendingDeleteTimer) clearTimeout(this.#pendingDeleteTimer);
    this.#pendingDelete = null;
    if (this.#openPreview === name) this.#closePreview();
    try {
      await this.#engine?.deleteArtifact(name);
    } catch (error) {
      this.#reportFailure(error);
      this.#renderArtifacts();
    }
  }

  async #togglePreview(artifact: ArtifactInfo): Promise<void> {
    if (this.#openPreview === artifact.name) this.#closePreview();
    else {
      this.#closePreview();
      this.#openPreview = artifact.name;
    }
    this.#renderArtifacts();
  }

  #closePreview(): void {
    if (this.#previewUrl) URL.revokeObjectURL(this.#previewUrl);
    this.#previewUrl = null;
    this.#openPreview = null;
  }

  /**
   * Fill one preview, having read at most a slice of the artifact. Text is capped at
   * `PREVIEW_TEXT_BYTES` and shown as text - never parsed, never injected as markup. Media is
   * rendered from a blob URL of the WHOLE file, only below the size where doing so is itself the
   * problem; above that the panel says so and leaves Download as the answer.
   */
  async #fillPreview(holder: HTMLElement, artifact: ArtifactInfo): Promise<void> {
    const doc = this.ownerDocument;
    const engine = this.#engine;
    if (!engine) return;
    const kind = previewKind(artifact.mime);
    if (kind === "none") {
      // Says WHY for the active types. "No preview" reads like a missing feature; for HTML and SVG
      // it is a decision, and the difference is whether a visitor files a bug or clicks Download.
      holder.textContent = previewRefusal(artifact.mime);
      return;
    }
    if (kind !== "text" && artifact.size > PREVIEW_MEDIA_BYTES) {
      holder.textContent = `Too large to preview here (${formatBytes(artifact.size)}). Download it instead.`;
      return;
    }
    holder.textContent = "Reading…";
    try {
      const data = await engine.readArtifact(
        artifact.name,
        kind === "text" ? { maxBytes: PREVIEW_TEXT_BYTES } : {},
      );
      // The row may have been re-rendered, or the preview closed, while this was in flight.
      if (this.#openPreview !== artifact.name || !holder.isConnected) return;
      if (kind === "text") {
        const text = await data.blob.text();
        const block = doc.createElement("pre");
        block.className = "bp-file-preview-text";
        block.textContent = data.truncated
          ? `${text}\n… (first ${formatBytes(data.blob.size)})`
          : text;
        holder.replaceChildren(block);
        return;
      }
      const url = URL.createObjectURL(data.blob);
      if (this.#previewUrl) URL.revokeObjectURL(this.#previewUrl);
      this.#previewUrl = url;
      const media = doc.createElement(kind);
      media.className = "bp-file-preview-media";
      if (kind !== "img") (media as HTMLMediaElement).controls = true;
      (media as HTMLImageElement).src = url;
      if (kind === "img") (media as HTMLImageElement).alt = artifact.name;
      holder.replaceChildren(media);
    } catch (error) {
      holder.textContent = errorText(error);
    }
  }

  /**
   * Get the artifact onto the user's disk without it ever existing in memory whole. Two paths,
   * chosen on capability rather than on size alone.
   *
   * With the File System Access API: `showSaveFilePicker()` is called SYNCHRONOUSLY at the top
   * of the click handler, before any `await`, because it needs transient user activation and an
   * `await` before it - even one resolving in a microtask - spends that activation, so the
   * picker throws `NotAllowedError` and the download silently never happens. The artifact then
   * streams chunk by chunk into the writable, with backpressure. Without the API: an anchor and
   * a blob URL, ONLY below `MAX_BLOB_BYTES`, that path building the whole artifact in memory.
   */
  #downloadArtifact(artifact: ArtifactInfo): void {
    const engine = this.#engine;
    if (!engine) return;
    const suggestedName = artifact.name.split("/").pop() ?? artifact.name;

    const picker = (
      globalThis as {
        showSaveFilePicker?: (options: {
          suggestedName?: string;
          types?: Array<{ description: string; accept: Record<string, string[]> }>;
        }) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;

    if (typeof picker !== "function") {
      if (artifact.size > MAX_BLOB_BYTES) {
        this.#reportFailure(
          new Error(
            `${suggestedName} is ${formatBytes(artifact.size)}, and this browser has no file ` +
              `picker to stream it into. Downloading it would mean holding the whole file in ` +
              `memory first, which this will not do. Use a browser with the File System Access ` +
              `API, or write a smaller file.`,
          ),
        );
        return;
      }
      void this.#downloadViaBlob(artifact, suggestedName);
      return;
    }

    // Called before any await, deliberately - and inside a try, which is not belt and braces.
    // `showSaveFilePicker` throws SYNCHRONOUSLY on a `SecurityError` (activation spent, or the
    // frame may not show a picker) and on a `TypeError` where the method exists but refuses the
    // call. Uncaught, both escape this click handler and show the visitor nothing.
    let chosen: Promise<FileSystemFileHandle>;
    try {
      chosen = picker({ suggestedName });
    } catch (error) {
      // A picker dismissed before it opened is still the user changing their mind.
      if ((error as { name?: string } | null)?.name !== "AbortError") this.#reportFailure(error);
      return;
    }
    void this.#streamToPickedFile(artifact, chosen);
  }

  async #streamToPickedFile(
    artifact: ArtifactInfo,
    chosen: Promise<FileSystemFileHandle>,
  ): Promise<void> {
    const engine = this.#engine;
    if (!engine) return;
    let handle: FileSystemFileHandle;
    try {
      handle = await chosen;
    } catch (error) {
      // A cancelled picker is an AbortError, not a failure worth reporting.
      if ((error as { name?: string } | null)?.name !== "AbortError") this.#reportFailure(error);
      return;
    }

    const controller = new AbortController();
    this.#transfers.set(artifact.name, controller);
    this.#renderArtifacts();
    try {
      // OWNERSHIP TRANSFERS WITH THE HANDLE. From the moment `writable` is passed to
      // `streamArtifact()`, the engine guarantees exactly one of `close()` or `abort()` on every
      // path, including the ones that fail before a byte is read. A close or abort here would be
      // a second terminal call, throwing a `TypeError` about an already-closed stream over a
      // clear failure. The contract starts at the call, so nothing sits before it.
      const writable = await handle.createWritable();
      await engine.streamArtifact(artifact.name, writable, {
        signal: controller.signal,
        onProgress: (progress) => this.#renderProgress(artifact.name, progress),
      });
    } catch (error) {
      if ((error as { name?: string } | null)?.name !== "ArtifactTransferAborted") {
        this.#reportFailure(error);
      }
    } finally {
      this.#transfers.delete(artifact.name);
      this.#progress.delete(artifact.name);
      this.#renderArtifacts();
    }
  }

  /** The small-file path: a blob URL and an anchor, capped and never used above the cap. */
  async #downloadViaBlob(artifact: ArtifactInfo, suggestedName: string): Promise<void> {
    const engine = this.#engine;
    if (!engine) return;
    try {
      const data = await engine.readArtifact(artifact.name);
      const url = URL.createObjectURL(data.blob);
      const anchor = this.ownerDocument.createElement("a");
      anchor.href = url;
      // The LAST segment: a browser will not write a path, and `out/run1.nc` would otherwise be
      // silently saved as something else entirely.
      anchor.download = suggestedName;
      anchor.rel = "noopener";
      this.#root.append(anchor);
      anchor.click();
      anchor.remove();
      // Revoked on a later turn: revoking synchronously can cancel the download that just started.
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    } catch (error) {
      this.#reportFailure(error);
    }
  }

  /**
   * Update one row's progress without rebuilding the list. A full re-render per chunk replaces
   * the row's DOM hundreds of times during a large download, losing focus and making Cancel
   * unclickable at exactly the moment somebody wants it.
   */
  #renderProgress(
    name: string,
    progress: { transferred: number; total: number; phase?: "transferring" | "finishing" },
  ): void {
    const wasFinishing = this.#progress.get(name)?.phase === "finishing";
    this.#progress.set(name, progress);
    // Entering the finishing phase changes the ROW, not just its label: every byte is written and
    // the destination is committing, so Cancel can no longer happen and offering one would be a
    // button that does nothing. A full re-render swaps it for a disabled control.
    if (progress.phase === "finishing" && !wasFinishing) {
      this.#renderArtifacts();
      return;
    }
    const row = this.#filesList?.querySelector(
      `[data-artifact="${cssEscape(name)}"] .bp-file-meta`,
    );
    if (row) row.textContent = transferLabel(progress);
  }

  /**
   * Reflect the transcript's follow state. The control appears only when BOTH are true: the
   * reader is not at the bottom, and something has arrived since they left it.
   */
  #renderFollow(state: { following: boolean; unread: boolean }): void {
    if (!this.#jumpButton) return;
    this.#jumpButton.hidden = state.following || !state.unread;
  }

  #applyTheme(): void {
    const theme = this.theme;
    this.#container?.setAttribute("data-theme", theme);
    // `color-scheme` so native scrollbars and form controls inside the shadow root follow, rather
    // than staying light against a dark surface.
    this.style.colorScheme = theme === "auto" ? "light dark" : theme;
  }

  // ------ rendering

  #renderStatus(state: string, detail?: string): void {
    const label = STATUS_TEXT[state] ?? state;
    const summary = summarise(detail);
    // SAID TWICE, on purpose: once on the console's own line and once as an event, because a
    // host that wrapped this console in its own chrome has nowhere else to read the status from,
    // and scraping the shadow DOM would make the status line part of this package's contract.
    // `composed` crosses the shadow boundary, `bubbles` lets a listener sit on the window.
    // Dispatched BEFORE the early return, a console whose toolbar was never built being exactly
    // the one whose host needs this.
    this.dispatchEvent(
      new CustomEvent("browser-python-status", {
        bubbles: true,
        composed: true,
        detail: { state, label, summary, detail },
      }),
    );
    if (!this.#statusLine) return;
    this.#statusLine.textContent = summary ? `${label} - ${summary}` : label;
    // The whole thing is still reachable on hover; only the LINE is short.
    if (detail) this.#statusLine.title = detail;
    else this.#statusLine.removeAttribute("title");
    this.#statusLine.dataset.state = state;
    this.#liveRegion.textContent = label;

    // The download notice is part of GREETING and follows the banner's switch. A host that turned
    // the greeting off has somewhere better to say both things, and printing one of the two
    // anyway leaves it with half a greeting it cannot remove.
    if (state === "loading" && !this.#announcedFirstLoad && this.#banner !== false) {
      this.#announcedFirstLoad = true;
      // Inline, in the transcript, not an overlay: covering the previous output to announce a
      // download hides the thing the visitor was reading.
      this.#adapter?.appendText({ kind: "status", text: `${FIRST_LOAD_NOTICE}\n` });
    }
    if (state === "error") {
      this.#adapter?.appendText({
        kind: "fatal",
        text: `Python stopped. Use “Stop and restart” to start a new interpreter.${
          detail ? `\n${detail}` : ""
        }\n`,
      });
    }
  }

  /**
   * A history suggestion: grey text after the caret, and nothing else on screen. The grey IS the
   * affordance; a strip under the transcript puts the information where nobody is looking and
   * costs a permanent line of the window, and `→` and `Ctrl + E` are in the shortcut panel. The
   * bar is still built as the fallback for a surface that cannot put a node in its command line.
   */
  #renderSuggestion(suffix: string | null): void {
    const shown = suffix === null ? "" : oneLine(suffix);
    const inline = this.#adapter?.setGhost?.(shown) ?? false;
    if (!this.#suggestion) return;
    if (inline || !suffix) {
      this.#suggestion.hidden = true;
      this.#suggestion.replaceChildren();
      return;
    }
    this.#suggestion.hidden = false;
    const label = this.ownerDocument.createElement("span");
    label.className = "bp-suggestion-label";
    label.textContent = "history: ";
    const ghost = this.ownerDocument.createElement("span");
    ghost.className = "bp-suggestion-text";
    // Muted, and NOT syntax-highlighted, so a suggestion can never be mistaken for source the
    // user has actually typed.
    ghost.textContent = shown;
    const hint = this.ownerDocument.createElement("span");
    hint.className = "bp-suggestion-hint";
    hint.textContent = " → to accept";
    this.#suggestion.replaceChildren(label, ghost, hint);
  }

  /**
   * The completion candidates, drawn under the command line the way a shell draws them: inside
   * the transcript's scroller, because a fixed strip at the foot of a tall console is far from
   * the caret. The SELECTED row is scrolled into view, since cycling past the eighth candidate
   * otherwise moves a highlight nobody can see, and the count is shown when the list is cut off.
   */
  #renderCompletion(candidates: readonly string[], active: number): void {
    if (!this.#completionMenu) return;
    if (candidates.length === 0) {
      this.#completionMenu.hidden = true;
      this.#completionMenu.replaceChildren();
      return;
    }
    const doc = this.ownerDocument;
    let selected: HTMLElement | null = null;
    const items = candidates.map((candidate, index) => {
      const item = doc.createElement("li");
      item.className = "bp-completion-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === active ? "true" : "false");
      // THE CANDIDATE IS ONE CHILD, not one per token. The row is `display: flex;
      // justify-content: space-between` and `appendHighlighted` emits a span PER TOKEN, so `abs(`
      // would draw as `abs` at the left margin and `(` at the right. Wrapping makes it one child;
      // the counter is the other.
      const label = doc.createElement("span");
      label.className = "bp-completion-label";
      // Highlighted, because a completion candidate is Python.
      appendHighlighted(label, candidate, doc);
      item.append(label);
      if (index === active) {
        selected = item;
        if (candidates.length > 1) {
          const counter = doc.createElement("span");
          counter.className = "bp-completion-count";
          counter.textContent = `${index + 1} of ${candidates.length}`;
          item.append(counter);
        }
      }
      return item;
    });
    this.#completionMenu.replaceChildren(...items);
    this.#completionMenu.hidden = false;
    this.#adapter?.anchorBelowCommand?.(this.#completionMenu);
    // `nearest`, so a menu already fully in view is not scrolled at all - the transcript must not
    // jump because a highlight moved by one row.
    (selected as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }

  #renderSearch(state: { query: string; match: string | null } | null): void {
    if (!this.#searchLine) return;
    if (!state) {
      this.#searchLine.hidden = true;
      this.#searchLine.textContent = "";
      return;
    }
    this.#searchLine.hidden = false;
    // One string, so a screen reader reads the query and its match together rather than announcing
    // two unrelated fragments.
    this.#searchLine.textContent = `(reverse-i-search)\`${state.query}': ${state.match ?? ""}`;
  }

  // ------ keyboard

  #onKeydown(event: KeyboardEvent): boolean {
    const controller = this.#controller;
    if (!controller) return false;
    const ctrl = event.ctrlKey || event.metaKey;

    // Escape closes the TRANSIENT surfaces first, and only those. It must not reach the host page
    // while a menu is open, and must not do anything at all once they are closed.
    if (event.key === "Escape") {
      if (controller.searching) {
        controller.cancelSearch();
        return true;
      }
      if (controller.completionOpen()) {
        controller.closeCompletion();
        return true;
      }
      return false;
    }

    if (controller.searching) {
      if (ctrl && event.key.toLowerCase() === "r") {
        controller.searchOlder();
        return true;
      }
      if (ctrl && event.key.toLowerCase() === "g") {
        controller.cancelSearch();
        return true;
      }
      if (event.key === "Enter") {
        controller.acceptSearch();
        return true;
      }
      if (event.key === "Backspace") {
        controller.searchBackspace();
        return true;
      }
      if (event.key.length === 1 && !ctrl) {
        controller.searchType(event.key);
        return true;
      }
      return false;
    }

    if (controller.completionOpen()) {
      if (event.key === "Tab") {
        controller.cycleCompletion(event.shiftKey ? -1 : 1);
        return true;
      }
      // THE ARROWS MOVE THE MENU WHILE THE MENU IS OPEN: Tab alone is the shell convention, but
      // somebody looking at a highlighted row reaches for the down arrow. This branch sits above
      // the history one below, so with no menu the arrows are history again.
      if (event.key === "ArrowDown") {
        controller.cycleCompletion(1);
        return true;
      }
      if (event.key === "ArrowUp") {
        controller.cycleCompletion(-1);
        return true;
      }
      if (event.key === "Enter") {
        // Insert, do not execute. Enter on a menu means "take this one".
        controller.acceptCompletion();
        return true;
      }
    }

    if (event.key === "Tab") {
      void controller.requestCompletion();
      return true;
    }

    if (event.key === "Enter" && event.shiftKey) {
      // A newline inside the buffer, not a submission.
      this.#adapter?.insert("\n");
      return true;
    }

    if (ctrl) {
      switch (event.key.toLowerCase()) {
        case "r":
          controller.startSearch();
          return true;
        case "l":
          this.clear();
          return true;
        case "c":
          // Ctrl+C, in both of its meanings, decided by the controller: abandon the line at an
          // idle prompt, or cancel the running execution. See `ConsoleController.interrupt`. It
          // reaches this handler during an execution because the listener is bound in the
          // CAPTURE phase on the mount and `setBusy` PAUSES the terminal rather than disabling
          // it, so it keeps focus and keeps receiving keys.
          void controller.interrupt();
          return true;
        case "p":
          return controller.historyPrevious();
        case "n":
          return controller.historyNext();
        case "e":
          if (controller.acceptSuggestion()) return true;
          return false; // otherwise let the surface move the caret to end-of-line
        default:
          return false;
      }
    }

    if (event.key === "ArrowUp") return controller.historyPrevious();
    if (event.key === "ArrowDown") return controller.historyNext();
    if (event.key === "ArrowRight") {
      const surface = this.#adapter;
      // Only at the very end, where Right has nothing else to do.
      if (surface && surface.getCursor() === surface.getCommand().length) {
        return controller.acceptSuggestion();
      }
      return false;
    }
    return false;
  }

  // ------ public methods

  async start(): Promise<void> {
    if (!this.#mounted) this.#build();
    // The in-flight promise, not a boolean. A boolean says "someone called start()", which is not
    // "Python is ready": a second caller would return immediately while the runtime was still
    // downloading. Returning the SAME promise makes every caller wait for the one real startup.
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#startOnce().finally(() => {
      // Cleared either way: a failure has to be retryable, and a success is idempotent through
      // the engine itself.
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  async #startOnce(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    if (!this.#engine) {
      // Every option the profile needs, not only its name: `wheelhouseURL` and
      // `persistCredentials` are what the `freva-client` profile is configured with, and without
      // them an element that created its own engine cannot install the Freva wheels.
      this.#engine = this.#createEngine();
      this.#ownsEngine = true;
      this.#controller?.attach(this.#engine);
    }
    try {
      const info = await this.#engine.start();
      this.#readyInfo = info;
      // The version line, in Python's own idiom, from what the interpreter REPORTED - `python3`
      // opens with `Python 3.14.2 (main, ...) on linux`, and which Python and which Pyodide is
      // the first thing anyone checks. Not in the banner, which is rendered at build time before
      // an interpreter exists. Printed on every successful start, so a restart re-announces it.
      this.#adapter?.appendText({
        kind: "status",
        text: `Python ${info.pythonVersion} (Pyodide ${info.pyodideVersion}) on WebAssembly\n`,
      });
      this.#adapter?.focus();
      // The file panel's starting state. A restart empties the workspace and the panel has to say
      // so rather than keep offering the previous session's downloads; and an engine already
      // running when this element attached has files the spontaneous change events never mention.
      this.#artifacts = [];
      this.#renderArtifacts();
      void this.#controller?.refreshArtifacts();
    } catch (error) {
      // A failed start is not a started console. Swallowing the error would resolve `start()` as
      // though it had succeeded, leave `#started` true so every retry is a silent no-op, and
      // print the failure twice, the engine's status listener having already rendered it.
      this.#started = false;
      // Nothing came up, so there is nothing to report about. See `#readyInfo`.
      this.#readyInfo = null;
      throw error;
    }
  }

  /**
   * Run a source block. Starts the console first and waits for it, so a host calling `execute()`
   * on a console that has not started gets the block run rather than held indefinitely.
   */
  async execute(source: string): Promise<void> {
    if (!this.#mounted) this.#build();
    await this.start();
    await this.#controller?.submitBlock(source, { origin: "programmatic" });
  }

  /**
   * Run a REGISTERED example: a labelled divider, the source, and one execution as a file.
   *
   * Separate from `execute()`, which is "behave as though this were typed or pasted" and keeps a
   * single line's value echo; this is "run the program registered under this name", file
   * semantics whatever its length. NOTHING IS RESET: namespace, transcript, history and a
   * half-typed command are all as they were, and the example is appended rather than substituted
   * - a "Try it" that cleared the console would throw away the variables it is tried with.
   */
  async runExample(example: { title: string; source: string }): Promise<void> {
    if (!this.#mounted) this.#build();
    await this.start();
    await this.#controller?.runExample(example);
  }

  /**
   * The visible transcript, as plain text, bounded by the same `outputOptions` limits the
   * transcript itself is. Rich display output appears as a one-line note naming its MIME type
   * rather than as base64 or as somebody's HTML.
   */
  transcript(): string {
    return this.#controller?.transcript() ?? "";
  }

  /** Surface a rejected background operation instead of losing it to an unhandled rejection. */
  #reportFailure(error: unknown): void {
    this.#renderStatus("error", error instanceof Error ? error.message : String(error));
  }

  // Focus the command line after a pointer click, unless the click finished a selection. Split
  // out of the listener so the selection test happens after the click has settled, rather than
  // when the browser may not have finalised it.

  /** Is either selection owner reporting selected text inside this console? */
  #selectionHeld(): boolean {
    const getShadowSelection = (
      this.#root as ShadowRoot & { getSelection?: () => Selection | null }
    ).getSelection;
    // Chrome keeps a shadow-tree selection on the root while the document reports it collapsed.
    // WebKit can expose the same root method but return an empty selection while the useful one is
    // owned by the document. Feature detection therefore cannot choose between the APIs: accept a
    // non-empty answer from either, or focusing the command line will collapse WebKit's drag.
    const selections = [
      getShadowSelection?.call(this.#root) ?? null,
      this.ownerDocument.getSelection(),
    ];
    return selections.some(
      (selection) =>
        selection !== null && !selection.isCollapsed && selection.toString().trim() !== "",
    );
  }

  #focusFromPointer(): void {
    // Someone who just dragged out a line of output wants to copy it, not type over it.
    if (this.#selectionHeld()) return;
    this.#adapter?.focus();
  }

  override focus(): void {
    this.#adapter?.focus();
  }

  /** Clears the TRANSCRIPT. Python variables are untouched - see the README. */
  clear(): void {
    this.#controller?.clearOutput();
  }

  /** Clears command history. Does not touch Python state or the visible transcript. */
  clearHistory(): void {
    this.#controller?.history.clear();
  }

  /**
   * Bring up a fresh interpreter. For an engine this element OWNS it is rebuilt from the current
   * attributes rather than restarted in place, because `BrowserPython.restart()` reuses the
   * options it was constructed with, so a `profile` changed afterwards would have no effect. An
   * injected engine is restarted as-is: its configuration is the host's.
   */
  async restart(): Promise<void> {
    if (!this.#ownsEngine) {
      await this.#controller?.restart();
      return;
    }
    // Rebuilt from the attributes, not restarted in place - see the contract above. The element
    // owns this engine, so replacing it is the element's to do.
    const previous = this.#engine;
    this.#controller?.detach();
    this.#engine = this.#createEngine();
    if (this.#controller) this.#controller.attach(this.#engine);
    previous?.dispose();
    this.#started = false;
    this.#startPromise = null;
    // The old interpreter's report describes an interpreter that no longer exists.
    this.#readyInfo = null;
    await this.start();
  }

  /** One place that turns the current attributes into engine options. See `restart`. */
  #createEngine(): BrowserPython {
    const indexURL = this.indexURL;
    const workerURL = this.workerURL;
    return createBrowserPython({
      profile: this.profile,
      ...(indexURL !== undefined ? { pyodide: { indexURL } } : {}),
      ...(workerURL !== undefined ? { workerURL } : {}),
      ...(this.#wheelhouseURL !== undefined ? { wheelhouseURL: this.#wheelhouseURL } : {}),
      ...(this.#startupSource !== undefined ? { startupSource: this.#startupSource } : {}),
      ...(this.#addons !== undefined ? { addons: this.#addons } : {}),
      ...(this.#optionalAddons !== undefined ? { optionalAddons: this.#optionalAddons } : {}),
      ...(this.#addonBaseURL !== undefined ? { addonBaseURL: this.#addonBaseURL } : {}),
      ...(this.#persistCredentials !== undefined
        ? { persistCredentials: this.#persistCredentials }
        : {}),
    });
  }

  /**
   * Tear down. The only place an internally created engine is disposed; an injected one is left
   * alone, because the host that made it decides when it ends.
   */
  dispose(): void {
    this.#closePreview();
    // Every transfer holds a lease in the worker. Dropping the element without cancelling would
    // leave them open until the worker itself went away.
    for (const controller of this.#transfers.values()) controller.abort();
    this.#transfers.clear();
    this.#progress.clear();
    if (this.#pendingDeleteTimer) clearTimeout(this.#pendingDeleteTimer);
    this.#pendingDeleteTimer = null;
    this.#controller?.dispose();
    this.#controller = null;
    this.#adapter?.destroy();
    this.#adapter = null;
    if (this.#ownsEngine) this.#engine?.dispose();
    this.#engine = null;
    this.#readyInfo = null;
    this.#ownsEngine = false;
    this.#started = false;
    this.#mounted = false;
    this.#root.replaceChildren();
  }
}

/** Type-only helper so the unused import is meaningful to a reader. */
export type ConsoleOutputEvent = OutputEvent;

/**
 * Register the element. IDEMPOTENT in both directions: the same class twice under one name is a
 * no-op, and a name already taken by a DIFFERENT class is reported rather than thrown, because
 * two bundles each importing `/console/auto` is normal in a portal.
 */
export function defineBrowserPythonConsole(tagName: string = DEFAULT_TAG_NAME): void {
  if (typeof customElements === "undefined") return; // SSR, or a non-browser runtime
  const existing = customElements.get(tagName);
  if (existing === BrowserPythonConsole) return;
  if (existing) {
    // Someone else owns this name. Overwriting is impossible and throwing would take down a page
    // for a duplicate import, so this reports and returns.
    console.warn(
      `[browser-python] <${tagName}> is already defined by another class; skipping registration.`,
    );
    return;
  }
  customElements.define(tagName, BrowserPythonConsole);
}
