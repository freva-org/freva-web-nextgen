// One Run at DKRZ job, from its thread to its outputs, without JupyterLab: the plugin gives it the
// notebook's thread binding, where outputs go and how a repair is offered. A job holds its thread
// until the server has ended its stream; a run or a stop counts as done only when the server says
// so (StreamEnd) - otherwise (a dropped connection, a read that failed) the session is given up,
// so the next job never meets a thread that may still be running. A cell counts as run only when
// its last run reported its result. At most `MAX_ATTEMPTS` runs are taken: at the next, reading
// stops, the server is asked to stop (and the cell says whether it confirmed), and the session is
// given up - DKRZ may still finish that run, but nothing from it is used, and the next job starts
// on a new thread.

import type { ClimateClawApi } from "./api.js";
import { fetchFigure as fetchFigureDefault } from "./figures.js";
import type { Job, RunAndFixJobs } from "./runfix-jobs.js";
import { verifiedFix } from "./runfix-jobs.js";
import {
  RunAndFixCollector,
  importedModules,
  missingFromError,
  moduleCheckCode,
  runAndFixInput,
  runVerdict,
  savedFigureOutput,
  type NbOutput,
} from "./runfix.js";
import { NdjsonDecoder, VariantMapper } from "./stream.js";
import { delay, retryConflict, SETTLE_MS, type ThreadGate } from "./thread-gate.js";

export interface RunnerHost<N extends object, C extends object> {
  api(): ClimateClawApi | null;
  gate: ThreadGate;
  jobs: RunAndFixJobs<N, C>;
  /** What one remote thread belongs to (a notebook's document). */
  sessionOf(notebook: N): object;
  /** The notebook's thread, if it has one for this session. */
  threadOf(notebook: N): string | null;
  /** Remembers a thread only for the session generation it was made in. */
  commitThread(notebook: N, thread: string, generation: number): void;
  /** Gives up a thread whose state is unknown: the next run starts a new one. */
  abandon(notebook: N, thread: string): void;
  /** Outputs for a job's cell (only while it is the newest job there). */
  write(job: Job<N, C>, outputs: NbOutput[]): void;
  /**
   * A repair to show (and offer, when verified): the fixed code, and the outputs of its run (which
   * go with it, below the cell or in its place).
   */
  offer(job: Job<N, C>, fixed: string, verified: boolean, note: string, outputs: NbOutput[]): void;
  /** DKRZ does not have modules the cell imports: say so, and how to run it in the notebook. */
  missing?(job: Job<N, C>, modules: string[]): void;
  /** No run of a fix succeeded after `runs` runs: say so (with ClimateClaw's reason, if any). */
  gaveUp?(job: Job<N, C>, reason: string, runs: number): void;
  /** The job's state changed. */
  changed(): void;
  previewOrigin?: string;
  fetchFigure?: typeof fetchFigureDefault;
  settleMs?: number;
  /** How long a stop past the run limit may go unanswered (default `STOP_CONFIRM_MS`). */
  stopConfirmMs?: number;
  retry?: { attempts?: number; delayMs?: number };
}

const stopped = () => new DOMException("stopped", "AbortError");

export class RunAtDkrzRunner<N extends object, C extends object> {
  constructor(private readonly host: RunnerHost<N, C>) {}

  /** Runs a job to its end; how it ended is in its state and its cell. */
  async run(job: Job<N, C>, chatbot: string): Promise<void> {
    const { host } = this;
    const { notebook, controller } = job;
    const generation = host.jobs.generations.get(host.sessionOf(notebook));
    try {
      let threadId = host.threadOf(notebook);
      if (!threadId) {
        threadId = await host.api()!.newThread(controller.signal);
        if (controller.signal.aborted) throw stopped();
        // Not if "New DKRZ thread" (or a restart) came while it was being made.
        host.commitThread(notebook, threadId, generation);
      }
      const thread = threadId;
      job.threadId = thread;
      await host.jobs.onThread(thread, () => this.#runOn(job, thread, chatbot, generation));
    } catch (error) {
      this.#ended(job, error);
    }
  }

  /** How a job's run ended, in its cell: stopped, or failed with the reason. */
  #ended(job: Job<N, C>, error: unknown): void {
    const { host } = this;
    if (job.controller.signal.aborted || job.state === "stopped") {
      host.jobs.end(job, "stopped");
      host.write(job, [{ output_type: "stream", name: "stderr", text: "Stopped.\n" }]);
      return;
    }
    host.jobs.end(job, "failed");
    const message = error instanceof Error ? error.message : String(error);
    host.write(job, [
      { output_type: "error", ename: "ClimateClawError", evalue: message, traceback: [message] },
    ]);
  }

  /** One job on its thread, which it holds until its stream has ended. */
  async #runOn(job: Job<N, C>, threadId: string, chatbot: string, generation: number) {
    const { host } = this;
    const { baseSource: source, controller } = job;
    const api = host.api()!;
    if (controller.signal.aborted) throw stopped();
    // What it imports is checked at DKRZ first (see runAndFixInput).
    const modules = importedModules(source);
    job.check = modules.length ? moduleCheckCode(modules) : null;
    // Busy until the server has ended an earlier stream on it (a stop, a broken connection).
    await host.gate.wait(threadId, controller.signal);
    job.state = "running";
    host.changed();
    const response = await retryConflict(
      () =>
        api.streamResponse(
          {
            thread_id: threadId,
            input: runAndFixInput(source, job.note, modules),
            ...(chatbot ? { chatbot } : {}),
          },
          controller.signal,
        ),
      { ...host.retry, signal: controller.signal },
    );
    let release: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => (release = resolve));
    host.gate.hold(threadId, ended);
    let finished = false;
    try {
      finished = await this.#read(job, response, generation, ended);
    } finally {
      // Ended without the server saying so - a dropped connection, a read that failed, an
      // unconfirmed stop: it may still be running there. Its session is given up (the next run
      // starts a new one, never meeting a busy thread), and the server is asked to stop.
      if (!finished && job.threadId) {
        host.abandon(job.notebook, job.threadId);
        host.gate.hold(
          job.threadId,
          api.stop(job.threadId).then(() => delay(host.settleMs ?? SETTLE_MS)),
        );
      }
      release();
    }
  }

  /** Reads one run's stream into its cell; true when the server ended it. */
  async #read(
    job: Job<N, C>,
    response: Response,
    generation: number,
    ended: Promise<void>,
  ): Promise<boolean> {
    const { host } = this;
    const { notebook, baseSource: source, controller } = job;
    const readFigure = host.fetchFigure ?? fetchFigureDefault;
    const collector = new RunAndFixCollector(job.check ?? null, source);
    let limited = false;
    const mapper = new VariantMapper({ hideCode: true });
    const lines = new NdjsonDecoder();
    const decoder = new TextDecoder();
    const reader = response.body!.getReader();
    const consume = (values: ReturnType<NdjsonDecoder["push"]>) => {
      for (const line of values) {
        if (!("value" in line)) continue;
        const value = line.value as { variant?: unknown; content?: unknown };
        if (value?.variant === "Assistant" && typeof value.content === "string") {
          collector.addText(value.content);
        }
        const before = collector.outputs.length;
        collector.add(mapper.map(line.value));
        host.write(job, collector.outputs.slice(before));
        // A run past the limit: nothing more is read (see the loop).
        if (collector.overLimit) limited = true;
        // The server forked the thread: a stop, the notebook and the next run follow at once.
        if (host.jobs.follow(job, collector.threadId)) {
          host.commitThread(notebook, job.threadId!, generation);
          host.gate.hold(job.threadId!, ended);
        }
      }
    };
    /** Figures the code saved (not streamed): fetched, then shown in the cell, in order. */
    const showFigures = async () => {
      while (collector.figures.length) {
        const figure = collector.figures.shift()!;
        const base64 = await readFigure(figure, { signal: controller.signal });
        const before = collector.outputs.length;
        collector.addFigure(figure.run, savedFigureOutput(figure, base64, host.previewOrigin));
        host.write(job, collector.outputs.slice(before));
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(lines.push(decoder.decode(value, { stream: true })));
      if (limited) break;
      await showFigures();
      if (mapper.finished) break;
    }
    if (limited) {
      // Past the limit: the stream is left, and the server asked to stop; the cell says whether
      // it confirmed. The session is given up either way (the caller sees an unfinished stream).
      void reader.cancel().catch(() => undefined);
      // Bounded, and ended by the job's own abort: the notebook's next job never waits on an
      // unanswered stop.
      const stopped = job.threadId
        ? await host.api()!.stopConfirmed(job.threadId, {
            signal: controller.signal,
            ...(host.stopConfirmMs !== undefined ? { timeoutMs: host.stopConfirmMs } : {}),
          })
        : false;
      host.write(job, [
        {
          output_type: "stream",
          name: "stderr",
          text: stopped
            ? "DKRZ took the request to stop that run. The next run starts a new DKRZ session.\n"
            : "DKRZ did not take the request to stop that run (no answer, or an error): it may still be running there. The next run starts a new DKRZ session.\n",
        },
      ]);
      this.#decide(job, collector, false);
      return false;
    }
    consume(lines.push(decoder.decode()));
    consume(lines.flush());
    const before = collector.outputs.length;
    collector.add(mapper.flush());
    host.write(job, collector.outputs.slice(before));
    await showFigures();
    if (host.jobs.follow(job, collector.threadId)) {
      host.commitThread(notebook, job.threadId!, generation);
    }
    if (controller.signal.aborted) throw stopped();
    // Set by Stop while the stream ran.
    const stop = host.jobs.stopEnded(job, mapper.finished);
    if (stop === "stopped") {
      // The server ended the stream it was asked to stop: confirmed, and the thread is free.
      host.write(job, [{ output_type: "stream", name: "stderr", text: "Stopped.\n" }]);
      return true;
    }
    if (stop === "unconfirmed") {
      // The connection ended, the server never said the run did: it may still run at DKRZ. Its
      // session is given up (the next run starts a new one, see `#runOn`), and the thread is held
      // while the server is asked to stop again.
      host.write(job, [
        {
          output_type: "stream",
          name: "stderr",
          text: "Stopped here. DKRZ did not confirm the stop, so the next run starts a new DKRZ session.\n",
        },
      ]);
      return false;
    }
    if (!mapper.finished) {
      // A dropped connection, the run unconfirmed: it may still run at DKRZ. Not a success; its
      // session is given up (see `#runOn`), so the next run never meets a busy thread (409).
      host.jobs.end(job, "failed");
      const message =
        "The connection ended before DKRZ said the run was done. It may still be running there; the next run starts a new DKRZ session.";
      host.write(job, [
        { output_type: "error", ename: "ClimateClawError", evalue: message, traceback: [message] },
      ]);
      return false;
    }
    this.#decide(job, collector, true);
    return mapper.finished;
  }

  /**
   * How the job ended, from the runs taken: missing modules, a verified fix, a cell that ran, or
   * not. `completed`: the server ended the stream (a fix is verified only then).
   */
  #decide(job: Job<N, C>, collector: RunAndFixCollector, completed: boolean): void {
    const { host } = this;
    const source = job.baseSource;
    const outcome = verifiedFix(source, collector.runs, completed, collector.failed);
    const last = collector.runs.at(-1);
    const lastFailed = !!last?.output && (last.output.outcome === "error" || !!last.output.error);
    const verdict = runVerdict(collector.note);
    // Missing at DKRZ: from the module check, ClimateClaw's own line, or the error itself.
    const fromError = lastFailed && last?.output ? missingFromError(last.output.error) : null;
    const missing = outcome?.verified
      ? []
      : collector.missing?.length
        ? collector.missing
        : verdict.missing?.length
          ? verdict.missing
          : fromError
            ? [fromError]
            : [];
    // Nothing ran (only the import check, or text): nothing is known about the cell.
    const ran = collector.runs.some((run) => run.output !== null);
    if (!ran && !missing.length && !collector.failed) {
      host.jobs.end(job, "failed");
      const message = collector.runs.length
        ? "ClimateClaw ended before DKRZ reported the cell's run, so it is not known whether the cell works there."
        : "ClimateClaw ended without running the cell at DKRZ, so it is not known whether the cell works there.";
      host.write(job, [
        { output_type: "error", ename: "ClimateClawError", evalue: message, traceback: [message] },
      ]);
      return;
    }
    // The last run must have reported its result: a repair whose result never came is not one.
    const lastReported = !!last?.output;
    const failed =
      collector.failed || missing.length > 0 || !lastReported || (lastFailed && !outcome?.verified);
    host.jobs.end(job, failed ? "failed" : "finished");
    if (missing.length) host.missing?.(job, missing);
    else if (outcome?.verified) {
      host.offer(job, outcome.fixed, true, collector.summary, last?.outputs ?? []);
    } else if (!lastReported) {
      const message = `ClimateClaw's last run (run ${collector.runs.length}) reported no result, so the cell is not known to work at DKRZ.`;
      host.write(job, [
        { output_type: "error", ename: "ClimateClawError", evalue: message, traceback: [message] },
      ]);
      if (outcome) host.offer(job, outcome.fixed, false, collector.summary, []);
    } else if (lastFailed && collector.runs.length > 1) {
      host.gaveUp?.(job, verdict.gaveUp ?? "", collector.runs.length);
    } else if (outcome) {
      host.offer(job, outcome.fixed, false, collector.summary, last?.outputs ?? []);
    }
  }
}
