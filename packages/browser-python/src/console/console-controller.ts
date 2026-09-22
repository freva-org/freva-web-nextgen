// console-controller.ts - everything between the engine and the surface. The element owns DOM and
// attributes; this owns behaviour: prompt state, the queued command, history navigation,
// completion, output batching and pruning. It talks to the engine ONLY through its public API,
// never importing from `../worker/`, and every REPL decision comes from the engine's own answer.

import type { ArtifactsEvent, BrowserPython, OutputEvent, StatusEvent } from "../types.js";
import {
  DEFAULT_HIGHLIGHT_OPTIONS,
  DEFAULT_HISTORY_OPTIONS,
  DEFAULT_OUTPUT_OPTIONS,
  type ConsoleHighlightOptions,
  type ConsoleHistoryOptions,
  type ConsoleOutputOptions,
  type ConsoleSurfaceAdapter,
} from "./console-types.js";
import { HistoryStore } from "./history-store.js";

export interface ControllerHooks {
  /** Report the engine's state and a phase for the toolbar's status line. */
  onStatus(state: string, detail?: string): void;
  /** A history suggestion to show as ghost text, or null to clear it. */
  onSuggestion(suffix: string | null): void;
  /** Completion candidates to show, or null to close the menu. */
  onCompletion(candidates: readonly string[], active: number): void;
  /** Reverse-search state for the accessible label, or null when not searching. */
  onSearch(state: { query: string; match: string | null } | null): void;
  /** The active command changed - used to re-render live highlighting. */
  onCommandChanged?(value: string): void;
  /** The workspace's file list changed. Optional: a host may not render files at all. */
  onArtifacts?(event: ArtifactsEvent): void;
}

/**
 * How much buffered output forces a synchronous flush: small enough that a hidden tab cannot
 * accumulate much, large enough that a printing loop still coalesces into a few nodes.
 */
const PENDING_FLUSH_CHARACTERS = 64 * 1024;

/**
 * The execution id for output belonging to no execution. A distinct value rather than the empty
 * string, so a UI grouping by execution has something to label. See `StreamEvent.background`.
 */
export const BACKGROUND_EXECUTION_ID = "background";

/**
 * What a line looks like in the COPYABLE transcript when the console said it rather than Python.
 * Its own voice - `── HTTP ──`, `Restarting Python…`, `[3 older entries removed to bound memory]`
 * - is a `SyntaxError` waiting in a pasted program, so it is commented. Blank lines stay blank.
 */
function mirrorText(kind: string, text: string): string {
  if (kind !== "status" && kind !== "fatal") return text;
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? line : `# ${line}`))
    .join("\n");
}

/** Distinguishes controllers on one page, so the engine can tell whose continuation is open. */
let controllerCount = 0;

/**
 * Schedule and cancel the buffered-output flush, as a matched pair: `clearOutput()` must CANCEL
 * one, or output buffered just before Clear lands in the transcript the visitor emptied. Under
 * Node there is no animation frame, so both fall back to timers and the cancel must match.
 */
function scheduleFlush(run: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(() => run()) as unknown as number;
  }
  return setTimeout(run, 16) as unknown as number;
}

function cancelFlush(handle: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

/**
 * How long an interrupt is given to land before the console explains why it has not. Long enough
 * that a cancellation arriving at the next turn of Python's event loop never trips it, short
 * enough that someone who pressed Ctrl+C on a wedged loop is not left guessing. Once per press.
 */
const INTERRUPT_GRACE_MS = 1500;

const PROMPT_PRIMARY = ">>> ";
const PROMPT_CONTINUATION = "... ";

/** How a line arrived, which decides how it queues if the engine is not ready yet. */
interface SubmitOptions {
  /** Set when the line was echoed as it was queued, so it is not printed a second time. */
  alreadyEchoed?: boolean;
  /** A person typing (the default) replaces a held line; a submitted block appends. */
  interactive?: boolean;
}

/**
 * One thing waiting for the interpreter: a typed line, or a whole pasted block. `block` is not
 * decoration - it is replayed through `run()` when the queue drains, where a queue of bare lines
 * would come back as a series of top-level statements.
 */
interface QueuedInput {
  text: string;
  interactive: boolean;
  block: boolean;
  /** A registered example's title, so the divider is printed with the entry rather than after. */
  label?: string;
}

/** Where a block came from. Recorded for hosts and tests; it does not change what runs. */
export interface SubmitBlockOptions {
  origin?: "paste" | "programmatic" | "keyboard";
}

export class ConsoleController {
  readonly #surface: ConsoleSurfaceAdapter;
  readonly #hooks: ControllerHooks;
  #engine: BrowserPython | null = null;
  #history: HistoryStore;
  #outputOptions: Required<ConsoleOutputOptions>;
  #highlightOptions: Required<ConsoleHighlightOptions>;

  #unsubscribes: Array<() => void> = [];
  #ready = false;
  #busy = false;
  #disposed = false;
  /** Pending "still running" notes, so a dispose does not leave a timer writing into a dead DOM. */
  readonly #interruptNotes = new Set<ReturnType<typeof setTimeout>>();

  /** The lines of a multi-line statement in progress, so history stores it as ONE entry. */
  #pendingLines: string[] = [];
  /** This controller's identity to the engine, for continuation ownership. */
  readonly #owner = `console-${(controllerCount += 1)}`;

  /**
   * One command typed before the interpreter was ready. ONE, not a queue: somebody who types three
   * commands during a twenty-second download is waiting for the newest. Overwritten rather than
   * appended, and never executed twice.
   */
  #queued: QueuedInput[] = [];
  /** Guards the drain, so a status event arriving mid-drain cannot start a second one. */
  #draining = false;
  /**
   * Settled when the queue empties, so `execute()` can mean "this block has run". Both halves are
   * kept: a waiter that can only resolve hangs forever when the console is disposed, restarted or
   * its queue cleared.
   */
  #drained: { resolve: () => void; reject: (error: Error) => void }[] = [];
  /**
   * True while a whole block is being submitted, so nothing interleaves with it. A block is one
   * Python session: a `def` opened by its second line has to still be open when its third arrives,
   * so anything typed meanwhile is queued and runs after.
   */
  #blockRunning = false;

  /** Bumped on every completion request. A response with a stale id is dropped. */
  #completionToken = 0;
  #completionCandidates: string[] = [];
  #completionActive = -1;
  /** Where in the buffer the completed token starts, from the engine's own answer. */
  #completionStart = 0;

  /** Reverse-search state, and the draft it will restore on cancel. */
  #search: { query: string; skip: number; draft: string } | null = null;

  /** Buffered stdout, flushed on a frame. See `#flush`. */
  #pending: Array<{ kind: "stdout" | "stderr"; text: string; executionId?: string }> = [];
  #flushHandle: number | null = null;
  /** Characters waiting in `#pending`. The bound that makes a hidden tab safe - see `#onOutput`. */
  #pendingCharacters = 0;

  /** Executions rendered, for pruning. */
  #executionCount = 0;
  #characterCount = 0;

  /**
   * A plain-text mirror of what was rendered, so the transcript can be read back without every
   * `ConsoleSurfaceAdapter` implementing "read the transcript" identically. Bounded by the same
   * limits as the surface. PLAIN TEXT only - rich display output is a one-line note naming its
   * MIME type, because a host hands this to a clipboard or a `.txt` file.
   */
  #transcript: string[] = [];

  constructor(
    surface: ConsoleSurfaceAdapter,
    hooks: ControllerHooks,
    options: {
      history?: ConsoleHistoryOptions;
      output?: ConsoleOutputOptions;
      highlight?: ConsoleHighlightOptions;
    } = {},
  ) {
    this.#surface = surface;
    this.#hooks = hooks;
    this.#history = new HistoryStore(options.history ?? {});
    this.#outputOptions = { ...DEFAULT_OUTPUT_OPTIONS, ...options.output };
    this.#highlightOptions = { ...DEFAULT_HIGHLIGHT_OPTIONS, ...options.highlight };
  }

  get history(): HistoryStore {
    return this.#history;
  }

  get ready(): boolean {
    return this.#ready;
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** True while a multi-line statement is open, which is what `... ` is reporting. */
  get continuing(): boolean {
    return this.#pendingLines.length > 0;
  }

  setHistoryOptions(options: ConsoleHistoryOptions): void {
    this.#history = new HistoryStore({ ...DEFAULT_HISTORY_OPTIONS, ...options });
  }

  setOutputOptions(options: ConsoleOutputOptions): void {
    this.#outputOptions = { ...DEFAULT_OUTPUT_OPTIONS, ...options };
  }

  setHighlightOptions(options: ConsoleHighlightOptions): void {
    this.#highlightOptions = { ...DEFAULT_HIGHLIGHT_OPTIONS, ...options };
  }

  /**
   * Subscribe to an engine. Every unsubscriber is kept, because a framework may disconnect and
   * reconnect the element while an injected engine outlives it, and a controller that subscribed
   * twice would render every line twice - which looks like an engine bug and is not.
   */
  attach(engine: BrowserPython): void {
    this.detach();
    this.#engine = engine;
    this.#unsubscribes.push(engine.onStatus((event) => this.#onStatus(event)));
    this.#unsubscribes.push(engine.onOutput((event) => this.#onOutput(event)));
    if (this.#hooks.onArtifacts) {
      const notify = this.#hooks.onArtifacts.bind(this.#hooks);
      this.#unsubscribes.push(engine.onArtifacts(notify));
    }
    this.#ready = engine.state === "ready";
    this.#hooks.onStatus(engine.state);
  }

  /**
   * Ask the engine for the workspace's current contents: the spontaneous `artifacts` events only
   * describe CHANGES, so a console attaching to a running engine shows an empty file list until
   * the next write. Failure is swallowed - a browser with no workspace rejects on every mount.
   */
  async refreshArtifacts(): Promise<void> {
    const engine = this.#engine;
    if (!engine || !this.#hooks.onArtifacts) return;
    try {
      const artifacts = await engine.artifacts();
      this.#hooks.onArtifacts({
        type: "artifacts",
        artifacts,
        added: [],
        updated: [],
        removed: [],
      });
    } catch {
      // no workspace in this browser, or the engine went away mid-call
    }
  }

  /** Drop subscriptions WITHOUT touching the engine. Ownership is the element's business. */
  detach(): void {
    for (const off of this.#unsubscribes) off();
    this.#unsubscribes = [];
    this.#engine = null;
    this.#ready = false;
  }

  #onStatus(event: StatusEvent): void {
    // `ready` includes `busy`: an execution in flight is still an interpreter that can be queued
    // against, so `state === "ready"` alone sends a line typed mid-execution to the startup queue.
    // `#busy` is this controller's own bookkeeping, set around its own `push`/`run` calls, and is
    // NOT taken from the event, which would clear it mid-execution.
    this.#ready = event.state === "ready" || event.state === "busy";
    this.#hooks.onStatus(event.state, event.detail);
    if (event.state === "error") {
      // A queue that will never drain must not be awaited forever: `execute()` resolves when its
      // block has run, so a failed startup would leave the promise unsettled with nothing in the
      // transcript to explain it. The queue is discarded too - replaying it against the NEXT
      // interpreter would run code the visitor typed for one that no longer exists.
      this.#queued = [];
      this.#settleDrain(
        new Error(
          event.detail
            ? `The interpreter stopped before this could run: ${event.detail}`
            : "The interpreter stopped before this could run.",
        ),
      );
      return;
    }
    if (this.#ready && this.#queued.length > 0) void this.#drainQueue();
  }

  /**
   * Run what was typed or submitted during startup, in order, one at a time. Sequential and
   * awaited, because these lines are a REPL session: a `def` opened by one has to still be open
   * when the next arrives. Each leaves the queue before it runs and is marked already echoed.
   */
  async #drainQueue(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queued.length > 0 && !this.#disposed && this.#ready) {
        const entry = this.#queued.shift() as QueuedInput;
        if (entry.block) await this.#runBlock(entry.text, true);
        else await this.submit(entry.text, { alreadyEchoed: true, interactive: entry.interactive });
      }
    } finally {
      this.#draining = false;
      // Only when the queue is actually empty. Stopping half way - disposed, or no longer ready -
      // is not "the block ran", and saying so would be a lie the caller acts on.
      if (this.#queued.length === 0) this.#settleDrain();
      else if (this.#disposed) this.#settleDrain(new Error("the console was disposed"));
    }
  }

  /** Resolve or reject everyone waiting for the queue, and forget them. */
  #settleDrain(error?: Error): void {
    const waiters = this.#drained;
    this.#drained = [];
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  #onOutput(event: OutputEvent): void {
    switch (event.type) {
      case "stdout":
      case "stderr":
        // Buffered. Python printing in a loop produces one event per write, and a DOM node per
        // event would be thousands of nodes for one statement.
        this.#pending.push({
          kind: event.type,
          text: event.text,
          // Background output is grouped under its own identity rather than under whichever
          // execution ran last. A `__del__` firing on a later collection belongs to no statement,
          // and filing it inside a block that finished minutes ago is a guess presented as fact.
          ...(event.background === true
            ? { executionId: BACKGROUND_EXECUTION_ID }
            : event.executionId !== undefined
              ? { executionId: event.executionId }
              : {}),
        });
        this.#pendingCharacters += event.text.length;
        // BOUNDED, and this is what makes a hidden tab safe: the buffer is flushed on an animation
        // frame, which does not fire in a background tab, so without a cap a hidden tab
        // accumulates every fragment before `maxCharacters` can apply. `#countExecution` prunes.
        if (this.#pendingCharacters >= PENDING_FLUSH_CHARACTERS) this.#flush();
        else this.#scheduleFlush();
        return;
      case "result":
        // Flushed FIRST: a result that overtook the stdout printed before it would reorder the
        // transcript, which is the one thing a console must never do.
        this.#flush();
        this.#emit({ kind: "result", text: event.text, executionId: event.executionId });
        return;
      case "display":
        this.#flush();
        this.#surface.appendDisplay({
          mime: event.mime,
          encoding: event.encoding,
          data: event.data,
          executionId: event.executionId,
          ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
        });
        this.#record(`[${event.mime} output]\n`);
        this.#countExecution();
        return;
    }
  }

  #scheduleFlush(): void {
    if (this.#flushHandle !== null) return;
    this.#flushHandle = scheduleFlush(() => {
      this.#flushHandle = null;
      this.#flush();
    });
  }

  /** Coalesce buffered stream fragments into one node per (kind, execution) run, in order. */
  #flush(): void {
    if (this.#pending.length === 0) return;
    const pending = this.#pending;
    this.#pending = [];
    this.#pendingCharacters = 0;
    let run: { kind: "stdout" | "stderr"; text: string; executionId?: string } | null = null;
    for (const entry of pending) {
      if (run && run.kind === entry.kind && run.executionId === entry.executionId) {
        run.text += entry.text;
        continue;
      }
      if (run) this.#emit(run);
      run = { ...entry };
    }
    if (run) this.#emit(run);
  }

  #emit(output: {
    kind: "stdout" | "stderr" | "result" | "status" | "fatal" | "command";
    text: string;
    executionId?: string;
    prompt?: ">>> " | "... ";
  }): void {
    this.#surface.appendText({
      kind: output.kind,
      text: output.text,
      ...(output.executionId !== undefined ? { executionId: output.executionId } : {}),
      ...(output.prompt !== undefined ? { prompt: output.prompt } : {}),
      highlight: output.kind === "command" && this.#highlightOptions.submittedCommands,
    });
    this.#characterCount += output.text.length;
    this.#record(
      output.prompt !== undefined
        ? `${output.prompt}${output.text}`
        : mirrorText(output.kind, output.text),
    );
    this.#countExecution();
  }

  /**
   * Append to the text mirror. One entry per rendered block, matching `#executionCount`.
   *
   * EVERY ENTRY ENDS A LINE: the mirror is joined with no separator and an echoed command carries
   * no newline of its own, so a copied transcript would run together as
   * `>>> import numpy>>> x = 1>>> print(x)1`. A block already ending in a newline is untouched.
   */
  #record(text: string): void {
    this.#transcript.push(text.endsWith("\n") ? text : `${text}\n`);
  }

  /**
   * Count one ENTRY - a rendered block, not an emitted fragment. `maxEntries` is documented in
   * that unit: one `print` in a loop is one execution and hundreds of stdout events, so counting
   * fragments would prune in the middle of a single command at `maxEntries: 500`.
   */
  #countExecution(): void {
    this.#executionCount += 1;
    this.#enforceOutputLimits();
  }

  #enforceOutputLimits(): void {
    const { maxEntries, maxCharacters } = this.#outputOptions;
    if (this.#executionCount <= maxEntries && this.#characterCount <= maxCharacters) return;
    // OLDEST FIRST, and not "everything": `trim` drops from the top until the surface is within
    // the limit, so exceeding it by one entry does not throw away the newest output. `maxEntries:
    // 0` retains nothing - a real configuration for a host that renders output itself.
    const keep = Math.max(0, maxEntries);
    const dropped = this.#surface.trim({ keepEntries: keep, keepCharacters: maxCharacters });
    // The text mirror is trimmed to the SAME BOUNDS, not by the same count. Following `dropped`
    // drifts: the surface also receives entries this method appends itself, so the two lists do
    // not stay index-for-index. Re-applying the limits is idempotent.
    this.#trimTranscript(keep, maxCharacters);
    this.#executionCount = Math.min(this.#executionCount, keep);
    this.#characterCount = Math.min(this.#characterCount, maxCharacters);
    if (dropped > 0 && keep > 0) {
      const note = `[${dropped} older ${dropped === 1 ? "entry" : "entries"} removed to bound memory]\n`;
      this.#surface.appendText({ kind: "status", text: note });
      // The note is part of what the visitor sees, so it is part of what they can copy.
      this.#record(note);
    }
  }

  /** Drop from the OLDEST end of the text mirror until it is inside both limits. */
  #trimTranscript(keepEntries: number, keepCharacters: number): void {
    let characters = 0;
    for (const entry of this.#transcript) characters += entry.length;
    while (
      this.#transcript.length > 0 &&
      (this.#transcript.length > keepEntries || characters > keepCharacters)
    ) {
      characters -= (this.#transcript.shift() as string).length;
    }
  }

  /**
   * Submit one line, exactly as typed. Nothing is trimmed, normalised or parsed: leading
   * indentation is Python syntax, trailing whitespace can be inside a string, and a blank line
   * closes a block.
   */
  async submit(
    line: string,
    { alreadyEchoed = false, interactive = true }: SubmitOptions = {},
  ): Promise<void> {
    if (this.#disposed) return;
    // SUBMITTING A COMMAND RETURNS TO THE BOTTOM: someone who scrolled back and then types has
    // said where they want to be. Stated here rather than left to the browser scrolling the caret
    // into view, which also drags a parked reader down on output they did NOT cause. An
    // INTERACTIVE submission follows the latest; a programmatic one does not.
    if (interactive) this.#surface.followLatest();
    if (this.#handleClearCommand(line, alreadyEchoed)) return;
    const engine = this.#engine;
    if (!engine || !this.#ready || this.#blockRunning) {
      // A QUEUE, not a single slot: a host that autostarts the console and calls `execute()` in
      // the same breath submits a whole program line by line, and one slot means each line
      // overwrites the last - `execute("import numpy as np\nnp.arange(5)")` running against an
      // interpreter that never imported numpy. Typing replaces; a submitted block appends.
      this.#enqueue(line, interactive);
      return;
    }

    await this.#runLine(line, alreadyEchoed);
  }

  /**
   * Push one line into the interpreter and settle the prompt around it. Split out of `submit()` so
   * a block can run its lines without going back through the guard, which defers anything arriving
   * while a block is running - a block would end up waiting for itself.
   */
  async #runLine(line: string, alreadyEchoed: boolean): Promise<void> {
    const engine = this.#engine;
    if (!engine || this.#disposed) return;

    // Echoed when it was queued; echoing again here would print it twice for one execution.
    if (!alreadyEchoed) this.#echoCommand(line);
    this.#resetTransient();

    this.#busy = true;
    this.#surface.setBusy(true);
    try {
      // Named, so the engine can tell two consoles apart when one is mid-statement. See
      // `BrowserPython.push`: the interpreter has one input buffer and whoever is showing a `...`
      // prompt owns it.
      const result = await engine.push(line, { owner: this.#owner });
      if (result.syntax === "incomplete") {
        this.#pendingLines.push(line);
        this.#surface.setPrompt(PROMPT_CONTINUATION);
        return;
      }
      // Complete or a syntax error: either way the statement is over and the buffer closes.
      const whole = [...this.#pendingLines, line].join("\n");
      this.#pendingLines = [];
      this.#surface.setPrompt(PROMPT_PRIMARY);
      this.#history.add(whole);
    } finally {
      // ORDER MATTERS. `flush` first, so every stdout and stderr batch of this execution -
      // including a traceback, which arrives on stderr in pieces - is in the transcript.
      // `setBusy(false)` next, which redraws the prompt. `settle` last: until `resume()` has run
      // there is no new prompt. `focus` only if the console still has it, so a reader who walked
      // away does not get their caret moved out from under them.
      this.#flush();
      this.#busy = false;
      const hadFocus = this.#surfaceHasFocus();
      this.#surface.setBusy(false);
      this.#surface.settle({ focus: hadFocus });
    }
  }

  /**
   * Whether the keyboard focus is inside the console right now. Asked through the DOM rather than
   * tracked, because focus leaves for reasons this class never hears about - a click, another
   * window, a screen reader. A shadow-root console reports its host as `activeElement`.
   */
  #surfaceHasFocus(): boolean {
    const root = this.#surface.scroller?.() ?? null;
    const doc = root?.ownerDocument ?? (typeof document === "undefined" ? null : document);
    if (!doc || !root) return false;
    let active: Element | null = doc.activeElement;
    while (active) {
      if (active.contains(root) || root.contains(active)) return true;
      const shadow = active.shadowRoot;
      active = shadow ? shadow.activeElement : null;
    }
    return false;
  }

  /**
   * Hold a line until the interpreter is ready, and echo it once, now. Typing replaces; a
   * submitted block appends - see `submit()` for why.
   */
  #enqueue(text: string, interactive: boolean, block = false, label?: string): void {
    if (interactive) {
      const held = this.#queued.findIndex((entry) => entry.interactive);
      if (held !== -1) this.#queued.splice(held, 1);
    }
    this.#queued.push({ text, interactive, block, ...(label !== undefined ? { label } : {}) });
    if (label !== undefined) this.#emitDivider(label);
    if (block) this.#echoBlock(text);
    else this.#echoCommand(text);
    this.#emit({ kind: "status", text: "…queued until the interpreter is ready\n" });
  }

  /**
   * Where an example begins: a blank line, and nothing else. No banner over the block - a
   * transcript is something visitors COPY, and a line the console wrote into their program is a
   * `SyntaxError` when pasted back. Emitted when the example is ACCEPTED, before it runs and
   * before it is queued, because that is when the visitor needs to see the transcript move.
   */
  #emitDivider(_title: string): void {
    this.#emit({ kind: "status", text: "\n" });
  }

  /**
   * Echo a block the way it will read back: `>>> ` on the first line, `... ` on the rest.
   * Presentational only - the interpreter is handed the source itself. The prompts are what keep a
   * pasted transcript pasteable back into Python.
   */
  #echoBlock(source: string): void {
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      this.#emit({
        kind: "command",
        text: line,
        prompt: index === 0 ? PROMPT_PRIMARY : PROMPT_CONTINUATION,
      });
    });
  }

  /**
   * Run a whole block ONCE, as a file.
   *
   * `push()` line by line applies the REPL's rule that a blank line ENDS the current suite - right
   * for typing, catastrophic for a paste, where a blank line inside an indented body is ordinary
   * Python:
   *
   *     values = []
   *     for i in range(2):
   *         values.append(i)
   *
   *         values.append(i + 10)
   *     print(values)
   *
   * Line by line the blank line closes the `for` and the still-indented next line arrives at top
   * level as `IndentationError: unexpected indent`. `run()` compiles in file mode, where a blank
   * line is whitespace and indentation survives byte for byte. The cost: file mode does not echo a
   * trailing bare expression, so a pasted `a + 1` prints nothing. Typed lines keep `push()` and
   * the echo; see `submitBlock`.
   */
  async #runBlock(source: string, alreadyEchoed: boolean): Promise<void> {
    const engine = this.#engine;
    if (!engine || this.#disposed) return;

    if (!alreadyEchoed) this.#echoBlock(source);
    this.#resetTransient();
    this.#busy = true;
    this.#surface.setBusy(true);
    try {
      await engine.run(source);
      // One history entry for one block: ↑ recalls the program, not its last line.
      this.#history.add(source);
    } finally {
      this.#flush();
      this.#busy = false;
      this.#surface.setBusy(false);
      this.#surface.setPrompt(PROMPT_PRIMARY);
    }
  }

  #echoCommand(line: string): void {
    this.#emit({
      kind: "command",
      text: line,
      prompt: this.continuing ? PROMPT_CONTINUATION : PROMPT_PRIMARY,
    });
  }

  /**
   * Run a whole source block: a paste, a Shift+Enter buffer, or a host's `execute()` - one path
   * for all three. A paste reaching `submit()` as one string with newlines meets
   * `PyodideConsole`'s `single` compile mode and answers "SyntaxError: multiple statements found
   * while compiling a single statement"; `execute()` splits its input, so only pasting showed it.
   */
  async submitBlock(source: string, options: SubmitBlockOptions = {}): Promise<void> {
    // A paste and a keystroke are both the reader submitting; a programmatic run is not. See
    // `submit()` for why this is stated rather than left to the browser.
    if (options.origin !== "programmatic") this.#surface.followLatest();
    if (this.#disposed) return;
    // CRLF from a Windows clipboard is not Python's business. Nothing else is touched: blank lines
    // and leading whitespace are syntax, and this is the only place they could be lost.
    const normalised = source.replace(/\r\n?/g, "\n");

    // Where the line is drawn. A block with a newline in it is a PROGRAM and is compiled as a file
    // - see `#runBlock` for what the REPL protocol does to a blank line inside a suite. A block
    // with no newline is indistinguishable from a typed line and is treated as one, which keeps
    // the value echo: pasting `1 + 1` prints `2`, where file semantics print nothing.
    if (!normalised.includes("\n")) {
      await this.submit(normalised, { interactive: false });
      return;
    }

    // Not ready: the block goes on the queue in ONE synchronous step, as one entry. Enqueuing it
    // line by line would yield between lines, and anything typed in those gaps would land in the
    // middle of the block - splicing a stray statement into somebody's `def`.
    if (!this.#ready || this.#blockRunning) {
      this.#enqueue(normalised, false, true);
      await this.#waitForDrain();
      return;
    }

    // Ready: hold the lock, so a keystroke arriving mid-block is deferred rather than interleaved.
    this.#blockRunning = true;
    this.#surface.setBusy(true);
    try {
      if (this.#disposed) return;
      await this.#runBlock(normalised, false);
    } finally {
      this.#blockRunning = false;
      this.#surface.setBusy(this.#busy);
      // Anything typed during the block is waiting; run it now, in the order it arrived.
      if (this.#queued.length > 0) void this.#drainQueue();
    }
    void options;
  }

  /**
   * Run a REGISTERED example: a divider, the source, and one execution as a file. Deliberately NOT
   * `submitBlock`, which picks REPL or file semantics by counting newlines so a paste behaves like
   * typing (`1 + 1` echoes `2`); an example is a registered program and runs the way
   * `python file.py` runs it whatever its length. Nothing else changes: same namespace,
   * transcript appended to, history kept, half-typed command left at the prompt.
   */
  async runExample(example: { title: string; source: string }): Promise<void> {
    if (this.#disposed) return;
    // CRLF from a manifest written on Windows is not Python's business. Nothing else is touched.
    const source = example.source.replace(/\r\n?/g, "\n");

    // Busy, or not yet ready: the example is queued as ONE entry, in the order it arrived, because
    // interleaving would splice a program into somebody else's statement. A TRY PRESS FOLLOWS THE
    // LATEST: `#holdPlace` keeps a parked reader from being dragged down by output they did not
    // ask for, but a `Try in Python` press exists to see something run, so the move happens FIRST.
    this.#surface.followLatest();

    if (!this.#ready || this.#blockRunning || this.#busy) {
      this.#enqueue(source, false, true, example.title);
      await this.#waitForDrain();
      return;
    }

    this.#blockRunning = true;
    this.#surface.setBusy(true);
    try {
      if (this.#disposed) return;
      this.#emitDivider(example.title);
      // `#runBlock` echoes the source itself, then runs it once. File semantics, always.
      await this.#runBlock(source, false);
    } finally {
      this.#blockRunning = false;
      this.#surface.setBusy(this.#busy);
      if (this.#queued.length > 0) void this.#drainQueue();
    }
  }

  /** The old name for {@link submitBlock}, kept because it is the documented public API. */
  async execute(source: string): Promise<void> {
    await this.submitBlock(source, { origin: "programmatic" });
  }

  /** A promise settled when the queue empties - or rejected if it never will. */
  #waitForDrain(): Promise<void> {
    if (this.#queued.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.#drained.push({ resolve, reject }));
  }

  /**
   * `clear` at the prompt, which is not Python and is deliberately here anyway: every terminal
   * clears with it, and `NameError: name 'clear' is not defined` answers the most reflexive
   * command in the medium with a stack trace. Ctrl+L does the same; the word is what people reach
   * for first.
   *
   * NARROW ON PURPOSE, because this shadows a name Python is entitled to: the line has to be
   * EXACTLY `clear` or `clear()` (`clear = 5`, `clear(x)`, `del clear` and `print(clear)` pass
   * straight through) and there must be no open statement, so the only case shadowed is one
   * Python would have answered with `NameError`. Nothing reaches the interpreter, so variables
   * survive as under Ctrl+L, and a visitor who bound `clear` can still call `globals()["clear"]()`.
   */
  #handleClearCommand(line: string, alreadyEchoed: boolean): boolean {
    if (this.continuing) return false;
    const trimmed = line.trim();
    if (trimmed !== "clear" && trimmed !== "clear()") return false;
    if (!alreadyEchoed) this.#echoCommand(line);
    this.#history.add(trimmed);
    this.#history.resetNavigation();
    this.clearOutput();
    this.#surface.setCommand("");
    this.#surface.setPrompt(PROMPT_PRIMARY);
    this.#resetTransient();
    return true;
  }

  /** Clear the transcript. Does NOT touch Python state - see the README's clear-versus-restart. */
  clearOutput(): void {
    // The BUFFER first: stream output is flushed on an animation frame, so anything printed in the
    // moments before Clear was pressed is still in `#pending` and would be written into the
    // transcript the visitor had just emptied. Someone clearing a colleague's session has a reason.
    this.#pending = [];
    this.#pendingCharacters = 0;
    if (this.#flushHandle !== null) {
      cancelFlush(this.#flushHandle);
      this.#flushHandle = null;
    }
    this.#surface.clear();
    this.#transcript = [];
    this.#executionCount = 0;
    this.#characterCount = 0;
  }

  /**
   * The transcript as plain text, exactly as rendered. Safe by construction rather than by
   * sanitising: every entry was appended as text where it was rendered, so nothing here was ever
   * markup. Bounded by `outputOptions`.
   */
  transcript(): string {
    return this.#transcript.join("");
  }

  /**
   * Ctrl+C, whatever the console is doing. One key, two situations: something is running and the
   * interpreter is asked to abandon it, so the `KeyboardInterrupt` that follows is written by
   * PYTHON over the visitor's own frames (see `_freva_bridge.interrupt`); or nothing is running
   * and the line in hand is abandoned at the prompt, which is `clearBuffer` below. A cancellation
   * is DELIVERED at a suspension point, so a synchronous loop never receives one - nothing is
   * printed on its behalf, and `#noteIfStillRunning` speaks up a moment later.
   */
  async interrupt(): Promise<void> {
    if (this.#disposed) return;
    const engine = this.#engine;
    const running = this.#busy || this.#blockRunning;
    if (!engine || !this.#ready || !running) {
      await this.clearBuffer();
      return;
    }
    // `^C` where the caret is, which is what a terminal shows: without it the traceback appears
    // under a line nobody asked to stop, and a press too late for the execution leaves no record.
    this.#emit({ kind: "status", text: "^C\n" });
    // ARMED BEFORE THE ROUND TRIP, not after. A synchronous loop never lets the Worker read the
    // interrupt message, so `engine.interrupt()` never settles and a note armed after the await
    // would never exist - the visitor would see `^C` and nothing else, forever. The timer checks
    // whether anything is still running when it fires, so arming it early costs nothing.
    const note = this.#noteIfStillRunning();
    let requested = false;
    try {
      requested = await engine.interrupt();
    } catch {
      // A restart or a dispose landed in the round trip. Whatever was running went with it, which
      // is the outcome the key was asking for.
      this.#cancelNote(note);
      return;
    }
    // It finished on its own between the press and the message. Nothing to say, and nothing left
    // for the note to warn about.
    if (!requested) this.#cancelNote(note);
  }

  /** Drop a note that is no longer owed, so a later press is not answered by an older timer. */
  #cancelNote(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    this.#interruptNotes.delete(timer);
  }

  /**
   * If the execution is still going a moment after an interrupt, say so and name what does work.
   * On a timer rather than on a reply: the interrupt is delivered at a suspension point, so "did
   * it work" is answered by whether the execution ends; one that never lands is a synchronous loop.
   */
  #noteIfStillRunning(): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.#interruptNotes.delete(timer);
      if (this.#disposed) return;
      if (!this.#busy && !this.#blockRunning) return;
      this.#emit({
        kind: "status",
        text:
          "Still running. Python takes an interrupt where it waits, and this is not waiting - " +
          "use Restart Python to stop it.\n",
      });
    }, INTERRUPT_GRACE_MS);
    this.#interruptNotes.add(timer);
    return timer;
  }

  /**
   * Ctrl+C: abandon the statement in hand and answer the way Python answers. CPython at an idle
   * prompt prints `KeyboardInterrupt` on a line of its own and gives back a fresh `>>> `, so the
   * line is echoed as it stood and `KeyboardInterrupt` follows it; an empty line with nothing
   * pending gets it too. THE IDLE HALF of Ctrl+C - stopping something RUNNING is `interrupt()`
   * above, which lets Python write its own, so this must only run with nothing to stop.
   */
  async clearBuffer(): Promise<void> {
    // THE PROMPT IS ECHOED EVEN WHEN THE LINE IS EMPTY, which is what CPython does:
    //
    //   >>>
    //   KeyboardInterrupt
    //   >>>
    //
    // Echoing only a non-empty line prints a bare `KeyboardInterrupt`, and five presses print five
    // in a column - which reads as five interrupts rather than five abandoned empty lines.
    this.#echoCommand(this.#surface.getCommand());
    this.#emit({ kind: "stderr", text: "KeyboardInterrupt\n" });
    this.#pendingLines = [];
    this.#surface.setCommand("");
    this.#surface.setPrompt(PROMPT_PRIMARY);
    // Back to the end of history, the way readline does it. Ctrl+C means "forget this line and
    // start again"; leaving the history cursor where it was makes the NEXT Up continue walking
    // backwards from wherever the abandoned line came from.
    this.#history.resetNavigation();
    this.#resetTransient();
    if (this.#engine && this.#ready) await this.#engine.clearBuffer();
  }

  // history

  historyPrevious(): boolean {
    const step = this.#history.previous(this.#surface.getCommand());
    if (!step) return false;
    this.#surface.setCommand(step.value);
    this.#surface.setCursor(step.value.length);
    this.#hooks.onSuggestion(null);
    return true;
  }

  historyNext(): boolean {
    const step = this.#history.next();
    if (!step) return false;
    this.#surface.setCommand(step.value);
    this.#surface.setCursor(step.value.length);
    this.#hooks.onSuggestion(null);
    return true;
  }

  /** The ghost suffix for what is currently typed. Never modifies the buffer. */
  refreshSuggestion(): void {
    if (this.#search) return; // reverse search owns the line while it is open
    this.#hooks.onSuggestion(this.#history.suggest(this.#surface.getCommand()));
  }

  /**
   * Accept the visible ghost suggestion. INSERTED, never executed: a suggestion that ran on
   * acceptance would turn one stray Right Arrow into a command the user never chose to run, which
   * on a console with `rm`-shaped Python in its history is not a small thing.
   */
  acceptSuggestion(): boolean {
    const current = this.#surface.getCommand();
    const suffix = this.#history.suggest(current);
    if (!suffix) return false;
    this.#surface.setCommand(current + suffix);
    this.#surface.setCursor(current.length + suffix.length);
    this.#hooks.onSuggestion(null);
    return true;
  }

  startSearch(): void {
    if (!this.#history.options.reverseSearch) return;
    this.#search = { query: "", skip: 0, draft: this.#surface.getCommand() };
    this.#hooks.onSearch({ query: "", match: null });
  }

  get searching(): boolean {
    return this.#search !== null;
  }

  searchType(character: string): void {
    if (!this.#search) return;
    this.#search.query += character;
    this.#search.skip = 0;
    this.#applySearch();
  }

  searchBackspace(): void {
    if (!this.#search) return;
    this.#search.query = this.#search.query.slice(0, -1);
    this.#search.skip = 0;
    this.#applySearch();
  }

  /** Repeated Ctrl+R: step to an older match. */
  searchOlder(): void {
    if (!this.#search) return;
    const next = this.#history.search(this.#search.query, this.#search.skip + 1);
    if (next) this.#search.skip += 1;
    this.#applySearch();
  }

  #applySearch(): void {
    if (!this.#search) return;
    const found = this.#history.search(this.#search.query, this.#search.skip);
    this.#surface.setCommand(found?.value ?? this.#search.draft);
    this.#hooks.onSearch({ query: this.#search.query, match: found?.value ?? null });
  }

  /** Enter during reverse search: keep the entry on the line, do NOT run it. */
  acceptSearch(): void {
    if (!this.#search) return;
    this.#search = null;
    this.#hooks.onSearch(null);
    this.#surface.setCursor(this.#surface.getCommand().length);
  }

  /** Ctrl+G or Escape: restore the draft the search started from. */
  cancelSearch(): void {
    if (!this.#search) return;
    const draft = this.#search.draft;
    this.#search = null;
    this.#hooks.onSearch(null);
    this.#surface.setCommand(draft);
    this.#surface.setCursor(draft.length);
  }

  // completion

  /**
   * Ask the engine what completes at the caret. The token is the guard that matters: a request is
   * fired by a keystroke and answered across a worker boundary, so a stale-token response is
   * dropped rather than overwriting newer input with a completion of text already deleted.
   */
  async requestCompletion(): Promise<void> {
    const engine = this.#engine;
    if (!engine || !this.#ready) return;
    const source = this.#surface.getCommand();
    const cursor = this.#surface.getCursor();

    // Indentation, not completion. Tab at the start of a continuation line means "indent" to
    // anyone who has used a Python REPL, and offering a module list there is noise.
    const head = source.slice(0, cursor);
    if (head.trim() === "") {
      this.#surface.insert("    ");
      return;
    }

    const token = ++this.#completionToken;
    // THE CURSOR GOES THROUGH UNCONVERTED: it comes from the surface in UTF-16 code units - the
    // unit `source.length`, `String.slice()` and `selectionStart` use - and `complete()` takes
    // that unit. Converting to Python characters would move the caret five units left in a line
    // with five emoji; the Worker slices with `slice()` and converts once on the way back.
    const result = await engine.complete(source, cursor);
    if (token !== this.#completionToken) return; // superseded - see the note above
    if (this.#surface.getCommand() !== source) return; // the buffer moved under the request

    const candidates = [...result.matches];
    // Already UTF-16: the same unit as `cursor`, `source.length` and the surface's own offsets.
    this.#completionStart = result.start;
    if (candidates.length === 0) {
      this.#hooks.onCompletion([], -1);
      return;
    }
    if (candidates.length === 1) {
      this.#applyCompletion(candidates[0]!, source, cursor);
      this.#hooks.onCompletion([], -1);
      return;
    }
    this.#completionCandidates = candidates;
    this.#completionActive = 0;
    this.#hooks.onCompletion(candidates, 0);
  }

  #applyCompletion(candidate: string, source: string, cursor: number): void {
    // Range replacement from the ENGINE's own `start`, not from a guess at what a token is: the
    // console does not know Python's word-break rules, and `ds.ise` -> `ds.isel` versus
    // `ds.` -> `ds.isel` differ only in where that boundary lies.
    const next = source.slice(0, this.#completionStart) + candidate + source.slice(cursor);
    this.#surface.setCommand(next);
    this.#surface.setCursor(this.#completionStart + candidate.length);
    this.#completionCandidates = [];
    this.#completionActive = -1;
    this.#hooks.onCommandChanged?.(next);
  }

  completionOpen(): boolean {
    return this.#completionCandidates.length > 0;
  }

  cycleCompletion(delta: number): void {
    if (!this.completionOpen()) return;
    const size = this.#completionCandidates.length;
    this.#completionActive = (this.#completionActive + delta + size) % size;
    this.#hooks.onCompletion(this.#completionCandidates, this.#completionActive);
  }

  /** Enter on the completion menu: insert, and do not execute. */
  acceptCompletion(): boolean {
    if (!this.completionOpen()) return false;
    const candidate = this.#completionCandidates[this.#completionActive];
    if (candidate === undefined) return false;
    this.#applyCompletion(candidate, this.#surface.getCommand(), this.#surface.getCursor());
    this.#hooks.onCompletion([], -1);
    return true;
  }

  closeCompletion(): void {
    this.#completionCandidates = [];
    this.#completionActive = -1;
    // Invalidate anything in flight, so a response that arrives after Escape does not reopen it.
    this.#completionToken += 1;
    this.#hooks.onCompletion([], -1);
  }

  #resetTransient(): void {
    this.closeCompletion();
    this.#hooks.onSuggestion(null);
    if (this.#search) this.cancelSearch();
  }

  /** Restart: a clean interpreter, a clean buffer, and a `>>> ` prompt. */
  async restart(): Promise<void> {
    const engine = this.#engine;
    if (!engine) return;
    this.#pendingLines = [];
    if (this.#queued.length > 0) {
      this.#queued = [];
      this.#settleDrain(new Error("the console restarted before the queued block ran"));
    }
    this.#resetTransient();
    this.#surface.setPrompt(PROMPT_PRIMARY);
    this.#surface.setCommand("");
    this.#emit({ kind: "status", text: "Restarting Python…\n" });
    await engine.restart();
    this.#emit({ kind: "status", text: "Ready\n" });
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#interruptNotes) clearTimeout(timer);
    this.#interruptNotes.clear();
    // Anyone awaiting a block that will now never run is told, rather than left hanging.
    this.#settleDrain(new Error("the console was disposed before the block ran"));
    if (this.#flushHandle !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.#flushHandle);
    }
    this.#flushHandle = null;
    this.#pending = [];
    this.detach();
  }
}
