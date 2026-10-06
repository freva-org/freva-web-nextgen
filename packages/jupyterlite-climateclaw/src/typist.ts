/**
 * Types text out: given the text so far (it grows as it streams), shows a share of what is
 * waiting on every tick, so a burst still reads as typing and a backlog never lags far. `write`
 * gets the text to show and, when only text was added, where the addition starts.
 */
export class Typist {
  #target = "";
  #shown = 0;
  #done = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #writer: ((text: string, appendedFrom: number | null) => void) | null = null;

  constructor(private readonly tickMs = 20) {}

  /** Where the text goes; typing starts once there is one. */
  attach(write: (text: string, appendedFrom: number | null) => void): void {
    this.#writer = write;
    this.#start();
  }

  /** The text so far; `done` when it is complete. */
  update(target: string, done = false): void {
    if (!target.startsWith(this.#target.slice(0, this.#shown))) {
      // Not a continuation (rare: a decoding settled differently): show it from the start.
      this.#shown = 0;
      this.#writer?.("", null);
    }
    this.#target = target;
    this.#done ||= done;
    this.#start();
  }

  /** Everything now (an output for this code arrived; the code must be whole above it). */
  flush(): void {
    if (this.#writer && this.#shown < this.#target.length) {
      const from = this.#shown;
      this.#shown = this.#target.length;
      this.#writer(this.#target, from);
    }
    this.#stop();
  }

  /** The whole text so far, typed or not. */
  get target(): string {
    return this.#target;
  }

  get typed(): string {
    return this.#target.slice(0, this.#shown);
  }

  get finished(): boolean {
    return this.#done && this.#shown >= this.#target.length;
  }

  dispose(): void {
    this.#stop();
    this.#writer = null;
  }

  #start(): void {
    if (this.#timer || !this.#writer || this.#shown >= this.#target.length) return;
    this.#timer = setInterval(() => this.#tick(), this.tickMs);
  }

  #stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #tick(): void {
    const remaining = this.#target.length - this.#shown;
    if (remaining <= 0 || !this.#writer) {
      this.#stop();
      return;
    }
    let step = Math.min(remaining, Math.max(3, Math.ceil(remaining / 10)));
    // Never split a surrogate pair.
    const last = this.#target.charCodeAt(this.#shown + step - 1);
    if (last >= 0xd800 && last <= 0xdbff && step < remaining) step += 1;
    const from = this.#shown;
    this.#shown += step;
    this.#writer(this.#target.slice(0, this.#shown), from);
  }
}
