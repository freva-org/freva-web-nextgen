/**
 * output.ts - the worker's side of the output stream. One job: emit events in the order Python
 * produced them, tagged with the execution that produced them, without the number or size of them
 * killing the tab.
 *
 * ORDER. `postMessage` preserves it, so the only way to lose it is asynchrony - hence no microtask,
 * timer or promise in the batching path. VOLUME. Python's console calls `write()` per line, so `for
 * i in range(200_000): print(i)` is 200,000 `postMessage` calls; batched, a few dozen. SIZE is
 * bounded per execution, and exceeding a bound costs exactly one notice saying how much was
 * dropped.
 */

import {
  MAX_EXECUTION_DISPLAY_CHARS,
  MAX_EXECUTION_TEXT_CHARS,
  validateDisplay,
  type WorkerMessage,
} from "../protocol.js";
import type { BrowserPythonState } from "../types.js";

/**
 * Send one message, optionally handing over the memory behind it: a chunk's `ArrayBuffer` is moved
 * rather than copied, which is what makes a streamed download bounded.
 */
export type Post = (message: WorkerMessage, transfer?: Transferable[]) => void;

/**
 * Flush a text batch once it reaches this size. Small enough that a consumer renders a readable
 * amount at a time; large enough that a loop printing short lines collapses by three orders of
 * magnitude.
 */
export const TEXT_FLUSH_CHARS = 32 * 1024;

/**
 * Flush a text batch that has been sitting for this long, enforced TWO ways because the two cases
 * have opposite problems. A synchronous Python loop blocks the worker's event loop, so a
 * `setTimeout` scheduled during `for i in range(...): print(i)` cannot run until the loop is over;
 * comparing clocks on each write is the only thing that works there. Python that prints and then
 * AWAITS is the opposite: nothing writes again, so the batch sits for as long as the coroutine runs
 * - every interactive prompt, including a device-authentication code the visitor has to type.
 * During an await a timer works, so the batch carries one, cancelled by every other flush path.
 */
export const TEXT_FLUSH_MS = 50;

/** How long after the limit is crossed the notice is emitted, if the execution has not ended. */
const NOTICE_DELAY_MS = 1000;

export class OutputBridge {
  #post: Post;
  #executionId = "";
  #inExecution = false;
  #annotators: ((text: string) => string)[] = [];

  // The pending text batch. `#pendingKind` is null exactly when `#pending` is empty.
  #pending = "";
  #pendingKind: "stdout" | "stderr" | null = null;
  #pendingSince = 0;
  /** The pending batch's own flush timer. Exactly one exists while a batch does. */
  #timer: ReturnType<typeof setTimeout> | null = null;

  // Per-execution accounting, all reset by `beginExecution`.
  #textChars = 0;
  #omitted = 0;
  #overflowAt: number | null = null;
  #announcedText = false;
  #displayChars = 0;
  #announcedDisplay = false;

  constructor(post: Post) {
    this.#post = post;
  }

  /**
   * Which execution subsequent output belongs to, and a fresh budget for it. The budget reset
   * matters as much as the id: one runaway loop must not leave the console permanently mute.
   */
  beginExecution(executionId: string): void {
    this.flush(); // Whatever is pending belongs to the PREVIOUS execution, not this one.
    this.#announceText();
    this.#executionId = executionId;
    this.#inExecution = true;
    this.#textChars = 0;
    this.#omitted = 0;
    this.#overflowAt = null;
    this.#announcedText = false;
    this.#displayChars = 0;
    this.#announcedDisplay = false;
  }

  /**
   * Mark the end of an execution, so what comes after it is not attributed to it: Python writes to
   * stdout from a `__del__`, an `atexit` hook or a callback, which a console grouping by execution
   * would file under a block that finished minutes ago.
   */
  endExecution(): void {
    this.flush();
    this.#announceText();
    this.#inExecution = false;
  }

  /**
   * Emit the pending text batch, if any. Public because the worker calls it before every message it
   * posts itself, so nothing this class does not know about can jump the queue.
   */
  flush(): void {
    // The timer is cleared FIRST and unconditionally, so every path out of a batch - a size flush,
    // a result, a status, an execution boundary, a stream change - leaves no timer that could fire
    // against a batch that no longer exists or, worse, against the next execution's.
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#pendingKind === null) return;
    const kind = this.#pendingKind;
    const text = this.#pending;
    this.#pending = "";
    this.#pendingKind = null;
    this.#post({ kind, ...this.#attribution(), text });
  }

  /**
   * Add a filter that may append to stderr before it leaves the worker. `OSError` has room for an
   * errno and the standard strerror and nothing else, so the workspace's file bound reaches the
   * user as a bare `[Errno 33] Too many open files`. Annotators must be pure and must not throw.
   */
  annotate(filter: (text: string) => string): void {
    this.#annotators.push(filter);
  }

  status(state: BrowserPythonState, detail?: string): void {
    this.flush();
    this.#post({ kind: "status", state, ...(detail !== undefined ? { detail } : {}) });
  }

  stdout(text: string): void {
    this.#write("stdout", text);
  }

  stderr(text: string): void {
    if (text === "") return;
    let annotated = text;
    for (const filter of this.#annotators) annotated = filter(annotated);
    this.#write("stderr", annotated);
  }

  result(text: string): void {
    this.flush();
    this.#post({ kind: "result", executionId: this.#executionId, text });
  }

  /**
   * Buffer one write, spending it against this execution's text budget. Switching stream flushes
   * first: stdout and stderr are two messages and their RELATIVE order is information.
   */
  #write(kind: "stdout" | "stderr", text: string): void {
    if (text === "") return;
    if (this.#pendingKind !== null && this.#pendingKind !== kind) this.flush();

    const remaining = MAX_EXECUTION_TEXT_CHARS - this.#textChars;
    const kept = remaining <= 0 ? "" : text.length <= remaining ? text : text.slice(0, remaining);
    if (kept.length < text.length) {
      this.#omitted += text.length - kept.length;
      // `null`, not `0`: a clock legitimately reads zero, and a sentinel that a real reading can
      // collide with is a bug that only appears on the first millisecond of an epoch.
      if (this.#overflowAt === null) this.#overflowAt = Date.now();
    }

    if (kept !== "") {
      this.#textChars += kept.length;
      if (this.#pendingKind === null) {
        this.#pendingKind = kind;
        this.#pendingSince = Date.now();
        // Scheduled once, when a batch STARTS - not per write, which for a loop printing a hundred
        // thousand lines would be a hundred thousand timers created and cleared for one flush.
        this.#timer = setTimeout(() => {
          this.#timer = null;
          this.flush();
        }, TEXT_FLUSH_MS);
      }
      this.#pending += kept;
      if (
        this.#pending.length >= TEXT_FLUSH_CHARS ||
        Date.now() - this.#pendingSince >= TEXT_FLUSH_MS
      ) {
        this.flush();
      }
    }

    // A loop that overflows and keeps going may never end, and an execution that goes quiet with no
    // explanation is the failure this mechanism exists to avoid. Once the drop is a second old it
    // is announced where it happened.
    if (this.#overflowAt !== null && Date.now() - this.#overflowAt >= NOTICE_DELAY_MS) {
      this.#announceText();
    }
  }

  /** One notice per execution, naming the limit and the exact amount dropped so far. */
  #announceText(): void {
    if (this.#announcedText || this.#omitted === 0) return;
    this.#announcedText = true;
    this.#notice(
      `[browser-python] output limit reached after ${mib(MAX_EXECUTION_TEXT_CHARS)}; ` +
        `${mib(this.#omitted)} omitted and further output from this execution is not shown. ` +
        `Print less, or write it to a file in /workspace and download it.\n`,
    );
  }

  /**
   * Send one package-authored line immediately, outside the text budget: the notice explaining a
   * dropped payload must not itself be dropped, and it is bounded by construction.
   */
  #notice(text: string): void {
    this.flush();
    this.#post({ kind: "stderr", ...this.#attribution(), text });
  }

  /**
   * Which execution this output belongs to, or an honest admission that it belongs to none. The
   * flag is what stops a UI filing it INSIDE that block.
   */
  #attribution(): { executionId: string; background?: true } {
    return this.#inExecution
      ? { executionId: this.#executionId }
      : { executionId: this.#executionId, background: true };
  }

  /**
   * Emit one rich-output payload, or report why it was refused. Validated HERE and again on the
   * main thread: `_freva_bridge.capture_display` can be reassigned from the prompt, so "the display
   * bridge produced it" is no reason to trust its MIME type.
   */
  display(candidate: unknown): void {
    const checked = validateDisplay(candidate);
    if (!checked.ok) {
      this.#notice(`[browser-python] dropped a display payload: ${checked.error}\n`);
      return;
    }
    if (this.#displayChars + checked.value.data.length > MAX_EXECUTION_DISPLAY_CHARS) {
      if (!this.#announcedDisplay) {
        this.#announcedDisplay = true;
        this.#notice(
          `[browser-python] display output limit reached: this execution has already produced ` +
            `${mib(MAX_EXECUTION_DISPLAY_CHARS)} of figures, so the rest are not shown. Draw fewer ` +
            `figures per cell, or save them to /workspace and download them.\n`,
        );
      }
      return;
    }
    this.#displayChars += checked.value.data.length;
    this.flush();
    this.#post({ kind: "display", executionId: this.#executionId, ...checked.value });
  }
}

/** Sizes in the units the person reading the console thinks in. */
function mib(chars: number): string {
  return chars >= 1024 * 1024
    ? `${(chars / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(chars / 1024))} KiB`;
}
