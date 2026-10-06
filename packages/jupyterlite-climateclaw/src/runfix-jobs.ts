// Run & fix jobs and the repairs they propose, without JupyterLab: a job is reserved the moment
// it is asked for (before any request), owns its notebook, its cell model, the source it was
// started from and its own generation, and moves through explicit states. A notebook's jobs share
// one remote thread - one interpreter - so they run one at a time, in order (a job waiting for its
// turn is "queued"), and any two jobs on the same remote thread do too, whichever notebook asked.
// Stopping a running job is "stopping" until the server has ended its stream: the thread is held
// until then, so the next job never meets a thread that is still busy. A notebook's session
// generation fences its thread: a thread created for a session that was reset since is not
// remembered. A repair is offered only for a verified run, and is applied only to the cell it was
// made for, and only if that cell still holds the source the repair was made from.

import { fixDiffers, normalizeCode } from "./runfix.js";
import type { CodeOutput } from "./stream.js";

export type JobState =
  | "queued"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "finished";

const LIVE: readonly JobState[] = ["queued", "starting", "running", "stopping"];

/** Work run one at a time per key, in order; a failure does not hold the line. */
export class Lanes<K> {
  readonly #tails = new Map<K, Promise<void>>();

  busy(key: K): boolean {
    return this.#tails.has(key);
  }

  run<R>(key: K, fn: () => Promise<R>): Promise<R> {
    const before = this.#tails.get(key) ?? Promise.resolve();
    const result = before.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }
}

/** A counter per key: a session's identity, which a reset moves on. */
export class Generations<K extends object> {
  readonly #values = new WeakMap<K, number>();

  get(key: K): number {
    return this.#values.get(key) ?? 0;
  }

  bump(key: K): number {
    const next = this.get(key) + 1;
    this.#values.set(key, next);
    return next;
  }
}

/**
 * A notebook's remembered thread, only if it was made for this path: a copy carries its original's
 * metadata, and must not share its thread (one interpreter, two queues).
 */
export function boundThread(meta: unknown, path: string): string | null {
  const m = meta as { runAndFixThread?: unknown; runAndFixPath?: unknown } | null | undefined;
  if (typeof m?.runAndFixThread !== "string") return null;
  return m.runAndFixPath === path ? m.runAndFixThread : null;
}

/** What stopping a job asks of the caller. */
export type StopRequest =
  /** It never started, or nothing remote was running: done. */
  | { kind: "done" }
  /** Its request may have reached the thread: abandon that thread, and tell the server. */
  | { kind: "abandon"; threadId: string }
  /** It runs on the thread: ask the server to stop, and wait for its stream to end. */
  | { kind: "wait"; threadId: string };

/** The cell a job belongs to: its notebook and its model, by identity (cell ids repeat). */
export interface JobTarget<N extends object, C extends object> {
  notebook: N;
  cell: C;
  /**
   * What one remote thread belongs to: the notebook's document, shared by every view of it.
   * Defaults to `notebook`.
   */
  session?: object;
}

export interface Job<N extends object, C extends object> extends JobTarget<N, C> {
  /** Unique per job; names the job in commands and notifications. */
  readonly id: string;
  /** The cell's source when the job was asked for: what a repair replaces. */
  readonly baseSource: string;
  readonly controller: AbortController;
  /** A note the user sent with the code ("Run with a note…"). */
  note?: string;
  /** The module check run before the cell, if its imports are checked. */
  check?: string | null;
  threadId: string | null;
  state: JobState;
}

export interface Repair<N extends object, C extends object> extends JobTarget<N, C> {
  readonly jobId: string;
  readonly baseSource: string;
  readonly fixed: string;
  /** The outputs of the fixed code's run at DKRZ. */
  readonly outputs: readonly unknown[];
}

let generation = 0;

export class RunAndFixJobs<N extends object, C extends object> {
  readonly #active = new Map<C, Job<N, C>>();
  /** The newest job per cell, finished or not: only it may still write into the cell. */
  readonly #latest = new WeakMap<C, Job<N, C>>();
  readonly #repairs = new Map<string, Repair<N, C>>();
  /** One job at a time per notebook session, and per remote thread. */
  readonly #sessions = new Lanes<object>();
  readonly #threads = new Lanes<string>();
  /** Each session's generation: a reset (New DKRZ thread, a kernel restart) moves it on. */
  readonly generations = new Generations<object>();

  /**
   * Reserves a job for this cell, synchronously, or returns null when the cell already has one
   * starting or running (a second click). The caller then awaits its requests with
   * `job.controller.signal`, which `stop()` aborts from the very first one.
   */
  reserve(target: JobTarget<N, C>, baseSource: string): Job<N, C> | null {
    if (this.#active.has(target.cell)) return null;
    generation += 1;
    const job: Job<N, C> = {
      ...target,
      id: `runfix-${generation}`,
      baseSource,
      controller: new AbortController(),
      threadId: null,
      state: "starting",
    };
    this.#active.set(target.cell, job);
    this.#latest.set(target.cell, job);
    // A new run on a cell withdraws what an older one proposed for it.
    for (const [id, repair] of this.#repairs)
      if (repair.cell === target.cell) this.#repairs.delete(id);
    return job;
  }

  /** The session a job's thread belongs to. */
  sessionOf(job: JobTarget<N, C>): object {
    return job.session ?? job.notebook;
  }

  /**
   * Runs `fn` for this job once every job scheduled before it on the same notebook session is
   * done. The job is "queued" while it waits; one stopped meanwhile never starts.
   */
  schedule(job: Job<N, C>, fn: () => Promise<void>): Promise<void> {
    const session = this.sessionOf(job);
    if (this.#sessions.busy(session)) job.state = "queued";
    return this.#sessions.run(session, async () => {
      if (job.state !== "queued" && job.state !== "starting") return;
      job.state = "starting";
      await fn();
    });
  }

  /**
   * Runs `fn` while holding this remote thread: two notebooks that came to share one (a copy made
   * before its thread was renewed) still never run on it at the same time.
   */
  onThread<R>(threadId: string, fn: () => Promise<R>): Promise<R> {
    return this.#threads.run(threadId, fn);
  }

  /** Jobs queued, starting, running or stopping. */
  get active(): Job<N, C>[] {
    return [...this.#active.values()];
  }

  activeFor(cell: C): Job<N, C> | null {
    return this.#active.get(cell) ?? null;
  }

  /** Whether this job is still the newest for its cell (so may write outputs into it). */
  isCurrent(job: Job<N, C>): boolean {
    return this.#latest.get(job.cell) === job;
  }

  /**
   * Stops one job. Queued or still starting, it ends at once (its request aborted) and frees its
   * cell; if its request may have reached the thread, that thread is to be abandoned. Running, it
   * is "stopping": the caller asks the server to stop and the job ends when the stream does.
   */
  stop(job: Job<N, C>): StopRequest | null {
    if (job.state === "queued" || job.state === "starting") {
      job.state = "stopped";
      job.controller.abort();
      if (this.#active.get(job.cell) === job) this.#active.delete(job.cell);
      return job.threadId ? { kind: "abandon", threadId: job.threadId } : { kind: "done" };
    }
    if (job.state === "running" && job.threadId) {
      job.state = "stopping";
      return { kind: "wait", threadId: job.threadId };
    }
    return null;
  }

  /**
   * The server moved a running job to another thread (a fork): from now on its stop, and the
   * notebook's next run, go there. True when it moved.
   */
  follow(job: Job<N, C>, threadId: string | null): boolean {
    if (!threadId || threadId === job.threadId) return false;
    job.threadId = threadId;
    return true;
  }

  /**
   * A stopping job's stream has ended. Only the server's own end of the stream (StreamEnd)
   * confirms the stop: "stopped", the thread is free. A connection that just ended says nothing
   * about the run at DKRZ: "unconfirmed" - the job ends here, and the caller gives up its thread
   * (the next run takes a new one) instead of releasing work onto a thread that may still run.
   * Null when the job was not stopping.
   */
  stopEnded(job: Job<N, C>, streamEnded: boolean): "stopped" | "unconfirmed" | null {
    if (job.state !== "stopping") return null;
    this.end(job, "stopped");
    return streamEnded ? "stopped" : "unconfirmed";
  }

  /** Ends a job: only this job's entry is removed, never a newer one for the same cell. */
  end(
    job: Job<N, C>,
    state: Exclude<JobState, "queued" | "starting" | "running" | "stopping">,
  ): void {
    if (LIVE.includes(job.state)) job.state = state;
    if (this.#active.get(job.cell) === job) this.#active.delete(job.cell);
  }

  /** A verified repair from this job; none from a job a newer one replaced. */
  propose(job: Job<N, C>, fixed: string, outputs: readonly unknown[] = []): Repair<N, C> | null {
    if (!this.isCurrent(job)) return null;
    const repair: Repair<N, C> = {
      jobId: job.id,
      notebook: job.notebook,
      cell: job.cell,
      baseSource: job.baseSource,
      fixed,
      outputs,
    };
    this.#repairs.set(job.id, repair);
    return repair;
  }

  repair(jobId: string): Repair<N, C> | null {
    return this.#repairs.get(jobId) ?? null;
  }

  repairFor(notebook: N, cell: C): Repair<N, C> | null {
    for (const repair of this.#repairs.values()) {
      if (repair.notebook === notebook && repair.cell === cell) return repair;
    }
    return null;
  }

  withdraw(jobId: string): void {
    this.#repairs.delete(jobId);
  }
}

/**
 * Whether a repair can be applied now: its cell must still be in its notebook and still hold the
 * source the repair was made from. `conflict` means the cell was edited since; applying then
 * needs the user's explicit "apply anyway".
 */
export function applyCheck(
  repair: { baseSource: string },
  current: { inNotebook: boolean; source: string | null },
): "apply" | "conflict" | "gone" {
  if (!current.inNotebook || current.source === null) return "gone";
  return current.source === repair.baseSource ? "apply" : "conflict";
}

/** One execution ClimateClaw reported: the code it ran and, once it came, that code's output. */
export interface ExecutedRun {
  id: string;
  code: string;
  output: CodeOutput | null;
}

/**
 * A repair is verified only when the stream completed, the LAST code ClimateClaw ran is not the
 * cell's own code, that code's own result arrived and established success (a structured result
 * without an error; unstructured text says nothing either way) - and no stream error came after
 * it. Anything less is an attempt, shown but never offered for applying.
 */
export function verifiedFix(
  source: string,
  runs: readonly ExecutedRun[],
  completed: boolean,
  streamFailed: boolean,
): { fixed: string; verified: boolean } | null {
  const last = runs[runs.length - 1];
  if (!last || !fixDiffers(source, last.code)) return null;
  const verified =
    completed &&
    !streamFailed &&
    last.output !== null &&
    last.output.outcome === "ok" &&
    !last.output.error &&
    normalizeCode(last.code) !== "";
  return { fixed: last.code, verified };
}
