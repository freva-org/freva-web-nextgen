// What ClimateClaw is doing in each thread, for the composer's status line, and the notebook
// cells its current reply wrote, for the jump back to them. Kept per thread: a chat shows the
// state of its own thread.

import { Signal } from "@lumino/signaling";

import type { ActivityPhase } from "./stream.js";

/** "12s", "1m 05s". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export interface ThreadActivity {
  phase: ActivityPhase;
  label: string;
  /** When this phase started (ms since epoch). */
  since: number;
  /** When the reply started. */
  started: number;
}

/** A cell a reply wrote: its notebook and number, and how to bring it into view. */
export interface DkrzCell {
  notebook: string;
  /** 1-based, as when it was written. */
  number: number;
  jump(): void;
}

export class ActivityStore {
  /** Emits the thread whose state changed. */
  readonly changed = new Signal<ActivityStore, string>(this);
  readonly #activity = new Map<string, ThreadActivity>();
  readonly #cells = new Map<string, DkrzCell[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  activity(thread: string): ThreadActivity | null {
    return this.#activity.get(thread) ?? null;
  }

  cells(thread: string): readonly DkrzCell[] {
    return this.#cells.get(thread) ?? [];
  }

  /** A reply starts: thinking, and no cells yet. */
  start(thread: string): void {
    const now = this.now();
    this.#cells.delete(thread);
    this.#activity.set(thread, { phase: "thinking", label: "Thinking", since: now, started: now });
    this.changed.emit(thread);
  }

  set(thread: string, phase: ActivityPhase, label: string): void {
    const current = this.#activity.get(thread);
    if (phase === "done") return this.end(thread);
    if (current && current.phase === phase && current.label === label) return;
    const now = this.now();
    this.#activity.set(thread, { phase, label, since: now, started: current?.started ?? now });
    this.changed.emit(thread);
  }

  addCell(thread: string, cell: DkrzCell): void {
    this.#cells.set(thread, [...this.cells(thread), cell]);
    this.changed.emit(thread);
  }

  /** The server forked the thread: its activity and cells are the new thread's. */
  move(from: string, to: string): void {
    if (from === to) return;
    const activity = this.#activity.get(from);
    const cells = this.#cells.get(from);
    this.#activity.delete(from);
    this.#cells.delete(from);
    if (activity) this.#activity.set(to, activity);
    if (cells) this.#cells.set(to, [...(this.#cells.get(to) ?? []), ...cells]);
    this.changed.emit(from);
    this.changed.emit(to);
  }

  /** The reply is over (finished, stopped or failed); its cells stay for the jump. */
  end(thread: string): void {
    if (!this.#activity.delete(thread)) return;
    this.changed.emit(thread);
  }
}
