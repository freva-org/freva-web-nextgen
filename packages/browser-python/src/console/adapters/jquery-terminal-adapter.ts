/**
 * jquery-terminal-adapter.ts - the only file in the package that knows jQuery Terminal exists.
 *
 * Everything above it talks to `ConsoleSurfaceAdapter`, so a second adapter can replace this file
 * without a consumer changing a line - worth having, since this surface is 93 KiB gzipped with
 * its jQuery and Pyodide's own console has an open discussion about moving away from it. It is
 * the only maintained option that already has what a Python REPL needs and a PTY emulator does
 * not: a command LINE with history, a continuation prompt, completion hooks, bracketed paste.
 * Against it: a documented history of mangling Python (pyodide#5245), a `[[ ]]` formatting syntax
 * that collides with Python list literals, and jQuery plugins usually mean globals. All three
 * were measured in a real browser first - typed input is delivered byte-for-byte, it measures its
 * character cell inside a shadow root, and its CommonJS export is a FACTORY,
 * `(root, jQuery) => jQuery`, so `window.$` and `window.jQuery` stay `undefined`.
 */

import jQuery from "jquery";
import installTerminal from "jquery.terminal";

import type {
  ConsoleDisplayOutput,
  ConsoleSurfaceAdapter,
  ConsoleTextOutput,
} from "../console-types.js";
import { highlightedElement, tokenClassesPerCharacter } from "../highlight.js";
import { hasLink, linkifyInto } from "../linkify.js";
import { renderDisplay } from "../display-renderers.js";
import { SAFE_OPTIONS } from "./surface-options.js";

/** The terminal plugin factory, cast to what it actually does. jquery.terminal types its
 * CommonJS default export as returning `void`, because the factory form is not what its own
 * typings were written for; its UMD wrapper installs the plugin onto the instance it is given and
 * returns that instance, as the probe verifies. The one place the mismatch is absorbed. */
const install = installTerminal as unknown as (root: unknown, jq: typeof jQuery) => typeof jQuery;

let installed: typeof jQuery | null = null;

/**
 * The private jQuery with the terminal plugin on it, installed on FIRST USE rather than on import,
 * which is what makes `@freva-org/browser-python/console` importable on a server. The install call
 * measures a character cell, which reads `document`, so at module scope it throws `Cannot set
 * properties of undefined` the moment a Node process imports the entry point - precisely what a
 * Next.js or Astro server render does. Memoised, so ten consoles share one installation.
 */
function terminalJQuery(): typeof jQuery {
  installed ??= install(globalThis, jQuery);
  return installed;
}

/** Compare rendered text against source, treating a no-break space as a space. `data-text` holds
 * what the library PAINTED, and it paints every space as U+00A0 so a run of them cannot collapse;
 * comparing literally abandons the highlighting pass on essentially every real line. */
function sameCharacters(a: string, b: string): boolean {
  return a.replace(/\u00a0/g, " ") === b.replace(/\u00a0/g, " ");
}

/** Neutralise jQuery Terminal's own formatting syntax in text it will render.
 * `[[b;#fff;]hello]` is a formatting instruction, so Python that prints one - a repr of a nested
 * list, a regex, a docstring - would have part of itself eaten and the rest recoloured. Applied to
 * EVERY string that comes from Python. */
export function escapeFormatting(text: string): string {
  return text.replace(/\[\[/g, "&#91;&#91;");
}

type TerminalInstance = {
  set_prompt(prompt: string): void;
  set_command(value: string): void;
  get_command(): string;
  insert(value: string): void;
  echo(value: string, options?: Record<string, unknown>): void;
  clear(): void;
  // The library's own signature: `focus(true)` forces the enabled state on rather than returning
  // early when it believes it is already focused.
  focus(toggle?: boolean): void;
  pause(): void;
  resume(): void;
  destroy(): void;
  disable(): void;
  enable(): void;
  cmd(): { position(index?: number): number; getCursorPosition?(): number };
  find(selector: string): { get(index: number): HTMLElement | undefined };
};

export interface JQueryTerminalAdapterOptions {
  /** Called with the submitted line. The adapter never interprets it. */
  onCommand(line: string): void;
  /** Called on every input change, for history suggestion and live highlighting. */
  onChange?(value: string, cursor: number): void;
  /** Key handling the controller owns (Tab, Ctrl+R, history). Return true to swallow the event. */
  onKeydown?(event: KeyboardEvent): boolean;
  /** Highlight submitted commands echoed into the transcript. */
  highlight: boolean;
  /** Highlight the command line as it is typed. Separate, because it costs a pass per keystroke. */
  highlightLive: boolean;
  /**
   * Whether the transcript is following its own bottom, and whether output has arrived since it
   * stopped. The console draws its `Jump to latest` affordance from this and from nothing else.
   */
  onFollowChange?(state: { following: boolean; unread: boolean }): void;
  document: Document;
}

/** How close to the bottom still counts as being at the bottom, in CSS pixels. Not zero:
 * sub-pixel layout, a fractional device pixel ratio and the library's own filler element leave
 * `scrollHeight - scrollTop - clientHeight` a pixel or two shy of zero at the true bottom. */
const FOLLOW_EPSILON = 24;

export class JQueryTerminalAdapter implements ConsoleSurfaceAdapter {
  #terminal: TerminalInstance | null = null;
  #mount: HTMLElement | null = null;
  /** The inline ghost node, reused rather than rebuilt so a redraw cannot orphan two of them. */
  #ghost: HTMLElement | null = null;
  // THE SCROLLER, and there is exactly one: the host element (`.bp-transcript`). The stylesheet
  // gives the library's own `.terminal-scroller` no height, so the transcript is the only box that
  // overflows, which is what makes "is the reader at the bottom" a question with one answer. Two
  // candidate scrollers and no code owning either is where prompt-off-screen flakiness comes from.
  #scrollHost: HTMLElement | null = null;
  /** Whether output should pull the view down. Turned off by a deliberate scroll away from bottom. */
  #following = true;
  /** Output has arrived since the reader scrolled away, so an affordance is worth offering. */
  #unread = false;
  #followFrames: number[] = [];
  #resizeObserver: ResizeObserver | null = null;
  /** Set while the adapter itself is scrolling, so its own scroll event is not read as the user's. */
  #selfScrolling = false;
  /** Watches for the library re-rendering the command line, so the colour can be put back. */
  #lineObserver: MutationObserver | null = null;
  #highlightQueued = false;
  readonly #options: JQueryTerminalAdapterOptions;
  readonly #objectUrls = new Set<string>();
  /** Where the capture-phase wheel listener is bound, so `destroy()` can take it off again. */
  #wheelHost: HTMLElement | null = null;
  readonly #onWheel = (event: Event): void => {
    event.stopPropagation();
  };

  readonly #onScroll = (): void => {
    if (this.#selfScrolling) return;
    const was = this.#following;
    this.#following = this.#atBottom();
    if (this.#following) this.#unread = false;
    if (was !== this.#following) this.#emitFollowState();
  };

  /** Distance from the bottom, within a tolerance that survives sub-pixel layout. */
  #atBottom(): boolean {
    const host = this.#scrollHost;
    if (!host) return true;
    return host.scrollHeight - host.scrollTop - host.clientHeight <= FOLLOW_EPSILON;
  }

  #emitFollowState(): void {
    this.#options.onFollowChange?.({
      following: this.#following,
      unread: this.#unread && !this.#following,
    });
  }

  /**
   * Pin the view to the bottom, ACROSS the frames in which the transcript settles. Between the
   * append and the final height there is: the library appending its container, this adapter
   * filling it, the syntax highlighter running, the prompt redrawn on `resume()`, and web fonts
   * settling - so a single early `scrollTo` lands on a shorter document and clips a traceback with
   * the new prompt below the fold. This frame, the next, and once more after, coalescing.
   */
  #scheduleFollow(): void {
    if (!this.#following) {
      this.#unread = true;
      this.#emitFollowState();
      this.#holdPlace(true);
      return;
    }
    this.#holdPlace(false);
    const host = this.#scrollHost;
    if (!host) return;
    this.#cancelFollow();
    const view = host.ownerDocument.defaultView;
    const pin = (): void => {
      const target = this.#scrollHost;
      if (!target || !this.#following) return;
      this.#selfScrolling = true;
      target.scrollTop = target.scrollHeight;
      // Cleared on a later task: the scroll event this assignment causes is asynchronous, and
      // reading it as the reader's own would turn following off the moment it was turned on.
      view?.setTimeout(() => {
        this.#selfScrolling = false;
      }, 0);
    };
    pin();
    if (!view) return;
    this.#followFrames.push(
      view.requestAnimationFrame(() => {
        pin();
        this.#followFrames.push(view.requestAnimationFrame(() => pin()));
      }),
    );
  }

  /**
   * Drop the pending pins: `cancelAnimationFrame` AND NOTHING ELSE. Frame handles and timer
   * handles do not share an ID space, so `clearTimeout` on a frame handle cancels whatever the
   * PAGE's timer of that number happens to be - in an acceptance run, the harness's own polling
   * timer, so a green suite timed out with no error. Scheduled through the document's own window.
   */
  #cancelFollow(): void {
    const view = this.#scrollHost?.ownerDocument.defaultView;
    if (view) for (const frame of this.#followFrames) view.cancelAnimationFrame(frame);
    this.#followFrames = [];
  }

  constructor(options: JQueryTerminalAdapterOptions) {
    this.#options = options;
  }

  mount(host: HTMLElement): void {
    const mount = this.#options.document.createElement("div");
    mount.className = "bp-terminal";
    mount.setAttribute("part", "transcript");
    host.append(mount);
    this.#mount = mount;

    // The wheel is taken here, in the capture phase, for the same reason the keys are below. The
    // library binds its own wheel handler and calls `preventDefault()` to scroll
    // `.terminal-scroller`, which inside this host is sized to its content and can never scroll,
    // so the wheel never reaches `.bp-transcript`, which can: measured with 120 lines of output,
    // scrollHeight 2741 against clientHeight 450, `scrollTop` still 0 after a 400px wheel.
    host.addEventListener("wheel", this.#onWheel, { capture: true });
    this.#wheelHost = host;

    // FOLLOW STATE, read from the scroller rather than guessed from what just happened. A scroll
    // event fires for the reader's wheel, a drag of the bar, a keyboard PageUp, and this adapter's
    // own pinning; only the first three are the reader changing their mind, so the adapter's own
    // scrolls are flagged and skipped. No "was that a user gesture" heuristic anywhere in here.
    this.#scrollHost = host;
    host.addEventListener("scroll", this.#onScroll, { passive: true });
    // The window changing size is not output, and it still moves the prompt. Maximizing, restoring,
    // a drag-resize and a text-size change all reflow the transcript under a reader who has not
    // touched it; if they were at the bottom they must still be at the bottom afterwards.
    const view = host.ownerDocument.defaultView;
    if (view && typeof view.ResizeObserver === "function") {
      this.#resizeObserver = new view.ResizeObserver(() => {
        if (this.#following) this.#scheduleFollow();
        else this.#emitFollowState();
      });
      this.#resizeObserver.observe(host);
    }

    const interpreter = (line: string): void => {
      // Straight through. The adapter's entire job on this path is to NOT be clever.
      this.#options.onCommand(line);
    };

    this.#terminal = terminalJQuery()(mount).terminal(interpreter, {
      ...SAFE_OPTIONS,
      onAfterCommand: () => this.#emitChange(),
      keypress: () => {
        // The plugin has no "changed" event, so the change is reported on the next frame - after
        // the key has actually been applied to the buffer.
        requestAnimationFrame(() => this.#emitChange());
        return undefined;
      },
    } as never) as unknown as TerminalInstance;

    // Keys are taken HERE, in the capture phase, and NOT through the library's `keydown` option.
    // jQuery Terminal normalises the event before calling that option by mutating it in place:
    // `e.key = ie_key_fix(e)` upper-cases the name, so `Tab` arrives as `TAB` and a typed `z` as
    // `Z`, and every comparison against a real DOM key name silently never matches - Tab
    // completion, Escape, the arrows, reverse search - without throwing. The library's own handler
    // is on `document.documentElement` in the bubble phase, so capture on the mount runs FIRST.
    mount.addEventListener(
      "keydown",
      (event: KeyboardEvent) => {
        if (!this.#options.onKeydown?.(event)) return;
        event.preventDefault();
        event.stopPropagation();
        // The buffer may have moved underneath: history, a completion, an inserted indent.
        requestAnimationFrame(() => this.#emitChange());
      },
      true,
    );

    // A MULTI-LINE paste is taken whole, here, before the library can take it apart. Left alone,
    // jQuery Terminal submits the pasted text one line at a time as if each had been typed and
    // entered - the REPL protocol, including the rule that a blank line ends the current suite - so
    // a valid program with a blank line inside a `for` body arrives as a closed loop plus an
    // orphaned indented statement, or sits on a `... ` prompt forever. It cannot be fixed
    // downstream, because by then the text is already split. A single-line paste is left alone:
    // the library handles the caret and selection correctly.
    mount.addEventListener(
      "paste",
      (event: ClipboardEvent) => {
        const pasted = event.clipboardData?.getData("text") ?? "";
        if (!pasted.includes("\n")) return;
        event.preventDefault();
        event.stopPropagation();
        // Whatever was already typed belongs in front of it: someone who types `x = ` and pastes
        // a block meant one program, not two.
        const pending = this.getCommand();
        this.setCommand("");
        this.#options.onCommand(pending ? `${pending}${pasted}` : pasted);
        requestAnimationFrame(() => this.#emitChange());
      },
      true,
    );

    // Paste and cut do not raise keypress, and both change the buffer.
    for (const type of ["paste", "cut", "input"] as const) {
      mount.addEventListener(type, () => requestAnimationFrame(() => this.#emitChange()));
    }

    // Re-apply the live colour AFTER the library has finished redrawing: the command line is
    // rebuilt from scratch on every keystroke - character elements replaced, not updated - and the
    // rebuild lands after the frame in which the keystroke was handled. `childList` only, so the
    // observer reacts to the LIBRARY replacing the line and never to this class adding a class.
    if (typeof MutationObserver !== "undefined") {
      this.#lineObserver = new MutationObserver(() => {
        if (this.#highlightQueued) return;
        this.#highlightQueued = true;
        queueMicrotask(() => {
          this.#highlightQueued = false;
          this.#highlightInput();
        });
      });
      this.#lineObserver.observe(mount, { childList: true, subtree: true });
    }

    // The command line lives INSIDE the transcript, and the transcript is a `role="log"` region.
    // Without this, every keystroke rewrites a descendant of a live region and a screen reader
    // announces the half-typed command back over the user typing it. The log should announce what
    // the console SAID, not what the user is still saying.
    mount.querySelector(".cmd")?.setAttribute("aria-live", "off");
  }

  #emitChange(): void {
    if (!this.#terminal) return;
    this.#highlightInput();
    this.#options.onChange?.(this.getCommand(), this.getCursor());
  }

  /**
   * Colour the ACTIVE command line, in place. The surface rebuilds this element on every
   * keystroke, one wrapper per character (`<span data-text="x">`), so this is not a re-render: it
   * adds a class to elements the library just created, leaving the caret, the selection and the
   * character grid where they are. Deliberately not the library's formatter pipeline, which would
   * push the command through the `[[ ]]` syntax `escapeFormatting` keeps Python away from; and
   * not `innerHTML` or any writing of text, so the interpreter's value cannot be affected. One
   * disagreement between the characters on screen and the tokeniser leaves the line plain.
   */
  #highlightInput(): void {
    const mount = this.#mount;
    if (!mount) return;
    const cells = [...mount.querySelectorAll<HTMLElement>(".cmd [data-text]")].filter(
      (cell) =>
        // The prompt is rendered with the same per-character markup and is NOT part of the source.
        // Including it puts `>>> ` in front of the first token and throws the whole pass out.
        !cell.closest(".cmd-prompt") &&
        // The caret has a cell of its own that stands for no character of the command.
        !cell.closest(".cmd-cursor"),
    );

    const clear = () => {
      for (const cell of cells) {
        for (const name of [...cell.classList]) {
          if (name.startsWith("bp-tok-")) cell.classList.remove(name);
        }
      }
    };

    if (!this.#options.highlightLive) {
      clear();
      return;
    }

    const source = this.getCommand();
    const classes = tokenClassesPerCharacter(source);
    if (!classes) {
      clear();
      return;
    }

    // The alignment check. `data-text` holds ONE character per cell for ordinary text, but the
    // library uses the same attribute for wider things (an emoji, a combining sequence), and a
    // newline in a multi-line statement produces no cell at all. So the cells are matched against
    // the source by walking both, and one disagreement abandons the pass. Spaces compare loosely:
    // a NO-BREAK SPACE is how the library keeps a collapsed space from moving the caret.
    let index = 0;
    const assignments: Array<[HTMLElement, string | null]> = [];
    for (const cell of cells) {
      // `textContent`, NOT `data-text`. The library builds that attribute by concatenation without
      // escaping, so a double quote in the command renders as `data-text="" "=""` - an empty
      // attribute and a junk one beside it. Every f-string and every docstring hits that, so
      // trusting the attribute means those lines silently never highlight.
      const text = cell.textContent ?? "";
      if (text === "") continue;
      while (index < source.length && (source[index] === "\n" || source[index] === "\r"))
        index += 1;
      if (!sameCharacters(source.slice(index, index + text.length), text)) {
        clear();
        return;
      }
      assignments.push([cell, classes[index] ?? null]);
      index += text.length;
    }

    clear();
    for (const [cell, className] of assignments) {
      if (className) cell.classList.add(className);
    }
  }

  setPrompt(prompt: ">>> " | "... "): void {
    this.#terminal?.set_prompt(prompt);
  }

  setBusy(busy: boolean): void {
    if (!this.#terminal) return;
    // `pause`/`resume` rather than `disable`: pause keeps the terminal focused and stops it
    // accepting a second command, which is what "busy" means here. Disabling would blur it, and a
    // console that loses focus after every statement is unusable from the keyboard.
    if (busy) this.#terminal.pause();
    else this.#terminal.resume();
    // `resume()` redraws the prompt, which changes the transcript's height after the last line of
    // output was appended. Following here is what puts the NEW prompt on screen rather than the
    // last line of a traceback.
    this.#scheduleFollow();
  }

  /** One execution is over: every batch is in, the prompt is current, the input is live again.
   * Called once per completed statement, in the controller's `finally`, so it runs after a
   * traceback exactly as after a clean result. Last of the coordinated passes, and the one that
   * puts the caret back where a person can type, which `resume()` alone does not reliably do. */
  settle(options: { focus: boolean }): void {
    if (!this.#terminal) return;
    this.#scheduleFollow();
    if (options.focus) this.focus();
  }

  /** The reader asked to come back to the bottom. Also what submitting a new command does. */
  followLatest(): void {
    this.#following = true;
    this.#unread = false;
    this.#emitFollowState();
    this.#scheduleFollow();
  }

  /**
   * The suggestion, drawn WHERE IT IS BEING TYPED - grey text after the cursor and nothing else,
   * as fish and zsh-autosuggestions do it, because a bar under the transcript is the right
   * information in a place nobody is looking. jQuery Terminal rebuilds the command line on every
   * keystroke (`wrapper.find('div:not(.cmd-cursor-line)').remove()` plus a rewrite of the cursor
   * line), so nothing put there lasts; it does not have to, because this is called again from the
   * same `onChange`. It MUST NOT carry `data-text`: the library counts `[data-text]` nodes to
   * convert a DOM position to a character offset, so a ghost wearing it counts as typed characters
   * and every caret calculation after it is wrong. `aria-hidden`, or it is announced as the line.
   */
  setGhost(text: string): boolean {
    const line = this.#mount?.querySelector(".cmd .cmd-cursor-line");
    if (!line) {
      this.#ghost?.remove();
      this.#ghost = null;
      return false;
    }
    if (!text) {
      this.#ghost?.remove();
      this.#ghost = null;
      return true;
    }
    const doc = this.#options.document;
    if (!this.#ghost) {
      this.#ghost = doc.createElement("span");
      this.#ghost.className = "bp-ghost";
      this.#ghost.setAttribute("aria-hidden", "true");
    }
    if (this.#ghost.textContent !== text) this.#ghost.textContent = text;
    // Re-appended even when it is already inside: the redraw rewrites the cursor line's children,
    // and the ghost has to end up AFTER the block cursor rather than wherever it was left.
    if (this.#ghost.parentNode !== line || line.lastChild !== this.#ghost) line.append(this.#ghost);
    return true;
  }

  /** The completion menu, under the command line rather than at the foot of the console, because
   * a shell draws its candidates where the word is and a fixed strip below the transcript is
   * several centimetres from the caret on a tall window. Inserted as the command line's next
   * sibling, so it is inside the scroller; the library never removes it, because `clear()` empties
   * `.terminal-output` and the command line's own redraw works inside `.cmd`. */
  anchorBelowCommand(element: HTMLElement): boolean {
    const cmd = this.#mount?.querySelector(".cmd");
    const parent = cmd?.parentNode;
    if (!cmd || !parent) return false;
    if (element.previousSibling === cmd) return true;
    parent.insertBefore(element, cmd.nextSibling);
    return true;
  }

  /**
   * A reader who is NOT following stays where they are, whatever the browser thinks.
   *
   * THE DEFECT, measured: a reader parked at the top of a long transcript was at 9001 after the
   * next background execution, with the log of every `scrollTop` assignment and every `scrollTo`
   * between the two EMPTY. The browser did it - the command line's input is a focused element
   * inside this scroller, and a browser keeps a focused caret in view. `overflow-anchor: none`
   * does not help, and restoring the position after the append loses the race. What works is
   * taking the focused element out of this scroller's overflow, SCOPED to the moment the reader
   * is parked away from the bottom - unconditionally, a click on the transcript jumps the page.
   */
  #holdPlace(parked: boolean): void {
    const mount = this.#mount;
    if (!mount) return;
    if (parked) mount.setAttribute("data-bp-parked", "");
    else mount.removeAttribute("data-bp-parked");
  }

  /** Output arrived: pin if the reader is following, and mark it unread if they are not. */
  #afterOutput(): void {
    this.#scheduleFollow();
  }

  setCommand(value: string): void {
    this.#terminal?.set_command(value);
    this.#emitChange();
  }

  getCommand(): string {
    return this.#terminal?.get_command() ?? "";
  }

  getCursor(): number {
    try {
      const cmd = this.#terminal?.cmd();
      const position = cmd?.position();
      return typeof position === "number" ? position : this.getCommand().length;
    } catch {
      return this.getCommand().length;
    }
  }

  setCursor(position: number): void {
    try {
      this.#terminal?.cmd().position(position);
    } catch {
      // the plugin rejects an out-of-range index; the caret simply stays put
    }
  }

  insert(value: string): void {
    this.#terminal?.insert(value);
    this.#emitChange();
  }

  /** Unwrap what `finalize` hands over: a jQuery-WRAPPED container, not a DOM element - easy to
   * miss, because the wrapper answers to enough of the element API to look right until the first
   * `replaceChildren`. Both forms are accepted, in case a future version passes the element. */
  #unwrap(container: unknown): HTMLElement | null {
    if (container instanceof HTMLElement) return container;
    const wrapped = container as { get?(index: number): HTMLElement | undefined; 0?: HTMLElement };
    const element = wrapped?.get?.(0) ?? wrapped?.[0];
    return element instanceof HTMLElement ? element : null;
  }

  /** Append one run of text. Everything reaches the DOM through `finalize`, which hands over the
   * container element the library just created. The echoed STRING is empty - the text never goes
   * through the library's formatter, which makes `escapeFormatting` belt-and-braces. */
  appendText(output: ConsoleTextOutput): void {
    const terminal = this.#terminal;
    if (!terminal) return;
    this.#afterOutput();
    const doc = this.#options.document;
    terminal.echo("", {
      raw: false,
      finalize: (rawContainer: unknown) => {
        const container = this.#unwrap(rawContainer);
        if (!container) return;
        const line = doc.createElement("div");
        line.className = `bp-line bp-${output.kind}`;
        line.setAttribute("part", output.kind === "command" ? "command" : output.kind);
        if (output.executionId) line.dataset.executionId = output.executionId;

        if (output.kind === "command") {
          const prompt = doc.createElement("span");
          prompt.className = "bp-prompt";
          prompt.setAttribute("part", "prompt");
          // Marks a command as a command WITHOUT relying on colour, for the colour-blind and for
          // a screen reader. The prompt the controller SENT, not a guess: sniffing the echoed line
          // renders every line `>>> `, so a multi-line block comes back as a series of top-level
          // statements - a transcript that cannot be pasted back into Python.
          prompt.textContent = output.prompt ?? ">>> ";
          line.append(prompt);
        }

        const body = doc.createElement("span");
        body.className = "bp-line-body";
        if (output.highlight && this.#options.highlight) {
          body.append(highlightedElement(output.text, doc));
        } else if (output.kind !== "command" && hasLink(output.text)) {
          // A URL in OUTPUT is clickable; a URL in an echoed command is not. An echoed command
          // is a line of Python, and a URL in one is inside a string literal or a comment, so
          // making it a control would put a clickable element in the middle of the visitor's own
          // source. Output is where a program ASKS for a link to be opened.
          linkifyInto(body, output.text, doc);
        } else {
          body.textContent = output.text;
        }
        line.append(body);
        container.replaceChildren(line);
      },
    });
  }

  appendDisplay(output: ConsoleDisplayOutput): void {
    const terminal = this.#terminal;
    if (!terminal) return;
    this.#afterOutput();
    const doc = this.#options.document;
    const element = renderDisplay(output, {
      document: doc,
      track: (url) => this.#objectUrls.add(url),
    });
    if (!element) {
      this.appendText({
        kind: "stderr",
        text: `[console] no renderer for ${output.mime}\n`,
        ...(output.executionId !== undefined ? { executionId: output.executionId } : {}),
      });
      return;
    }
    terminal.echo("", {
      raw: false,
      finalize: (rawContainer: unknown) => {
        const container = this.#unwrap(rawContainer);
        if (!container) return;
        const wrapper = doc.createElement("div");
        wrapper.className = "bp-line bp-display";
        if (output.executionId) wrapper.dataset.executionId = output.executionId;
        wrapper.append(element);
        container.replaceChildren(wrapper);
      },
    });
  }

  clear(): void {
    // An empty transcript is at its own bottom, and a `Jump to latest` offered over nothing is a
    // control that scrolls to where the reader already is.
    this.#following = true;
    this.#unread = false;
    this.#emitFollowState();
    this.#terminal?.clear();
    this.#revokeAll();
  }

  /** Drop the oldest rendered lines until the transcript fits, and report how many went. The
   * surface owns the DOM, so it owns the trimming: `keepEntries` counts `.bp-line` blocks - one
   * per rendered entry, the unit `maxEntries` is documented in - and `keepCharacters` counts their
   * text. Removing from the front is the point; clearing everything loses the newest too. */
  trim(limits: { keepEntries: number; keepCharacters: number }): number {
    const terminal = this.#terminal;
    if (!terminal) return 0;
    const root = this.#mount?.querySelector(".terminal-output");
    if (!root) return 0;
    const lines = [...root.querySelectorAll(".bp-line")];
    let characters = lines.reduce((total, line) => total + (line.textContent?.length ?? 0), 0);
    let removed = 0;
    for (const line of lines) {
      if (lines.length - removed <= limits.keepEntries && characters <= limits.keepCharacters) {
        break;
      }
      characters -= line.textContent?.length ?? 0;
      // The library wraps each echoed line in its own container; removing the wrapper keeps the
      // terminal's own bookkeeping consistent, where removing only the inner div would not.
      (line.closest("div[data-index]") ?? line).remove();
      removed += 1;
    }
    if (removed > 0) this.#revokeAll();
    return removed;
  }

  focus(): void {
    const terminal = this.#terminal;
    if (!terminal) return;
    // `terminal.focus()` alone is not enough, and the reason is shadow DOM. The library keeps its
    // own boolean for whether it is focused, maintained by blur handlers bound at the document;
    // inside a shadow root those see the HOST element rather than the textarea, so a click
    // elsewhere never teaches the library it lost focus, its flag stays true, and the next
    // `focus()` is a no-op leaving real focus on <body>. So: enable explicitly, then focus the
    // element that receives typing - the clipboard textarea on desktop, `.cmd-editable` on touch.
    //
    // FOCUSING MUST NOT MOVE THE READER, and `terminal.focus(true)` reaches `enable()`, which
    // scrolls its own bottom into view - right after a click on the prompt, wrong every other
    // time (measured: parked at scrollTop 0, moved to 9022 by the next background execution). So
    // the position is taken before and put back after, only when the reader is NOT following, in
    // three passes as `#scheduleFollow` has; `#selfScrolling` keeps the restore from being read
    // as the reader scrolling.
    const host = this.#scrollHost;
    const parked = host && !this.#following ? host.scrollTop : null;
    terminal.focus(true);
    const input = this.#mount?.querySelector(".cmd-clipboard, .cmd-editable");
    if (input instanceof HTMLElement) input.focus({ preventScroll: true });
    if (host && parked !== null) this.#holdScroll(host, parked);
  }

  /** Put the transcript back where the reader left it, across the frames in which focus settles.
   * Every pass re-checks `#following`: a reader who returns to the bottom while this is pending
   * has asked to follow again, and holding them where they were would take that back. */
  #holdScroll(host: HTMLElement, top: number): void {
    const view = host.ownerDocument.defaultView;
    const put = (): void => {
      if (this.#following || host.scrollTop === top) return;
      this.#selfScrolling = true;
      host.scrollTop = top;
      // Cleared on a later task, for the same reason `#scheduleFollow` clears it on one: the scroll
      // event this assignment causes is asynchronous.
      view?.setTimeout(() => {
        this.#selfScrolling = false;
      }, 0);
    };
    put();
    if (!view) return;
    this.#followFrames.push(
      view.requestAnimationFrame(() => {
        put();
        this.#followFrames.push(view.requestAnimationFrame(() => put()));
      }),
    );
  }

  /** The element the transcript scrolls in, for the autoscroll and pruning logic above. */
  scroller(): HTMLElement | null {
    return this.#mount;
  }

  #revokeAll(): void {
    for (const url of this.#objectUrls) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
  }

  destroy(): void {
    this.#ghost?.remove();
    this.#ghost = null;
    this.#wheelHost?.removeEventListener("wheel", this.#onWheel, { capture: true });
    this.#wheelHost = null;
    this.#cancelFollow();
    this.#scrollHost?.removeEventListener("scroll", this.#onScroll);
    this.#scrollHost = null;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#lineObserver?.disconnect();
    this.#lineObserver = null;
    this.#revokeAll();
    try {
      this.#terminal?.destroy();
    } catch {
      // The plugin throws if the node was already detached by a framework. Nothing left to free.
    }
    this.#terminal = null;
    this.#mount?.remove();
    this.#mount = null;
  }
}
