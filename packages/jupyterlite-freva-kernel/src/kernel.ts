// The "Freva Python" kernel: Jupyter's messaging on one `BrowserPython` engine.
//
// Ownership: one engine at a time per kernel, created by the kernel and disposed with it. A
// restart from the notebook disposes this kernel and Lite creates the next; a hard restart after
// an interrupt that did not land restarts the same engine.
//
// Python starts when code first runs, not when the notebook opens: an open notebook holds no
// interpreter. A live one holds one of the page's slots; when another notebook needs a slot and
// none is free, the least recently used idle kernel stops its interpreter - its workspace files
// kept first, and put back before anything runs in the next one (it says so when its next cell
// runs). A kernel starting, restarting or running its starter is not idle. Only kernels running
// code - or whose files cannot be kept - make a start wait.
//
// Ordering: every request keeps its OWN parent header. Output is bound to a request through the
// engine's `execute_input` event, which carries the request's msg_id as its token and precedes
// all of that cell's output - never through "whatever request came last".

import type {
  BrowserPython,
  BrowserPythonReadyInfo,
  CellResult,
  OutputEvent,
} from "@freva-org/browser-python";
import type { SlotBroker } from "@freva-org/browser-python/session";
import type { KernelMessage } from "@jupyterlab/services";
import type { IKernel } from "@jupyterlite/services";
import { Signal } from "@lumino/signaling";

import { isComplete } from "./is-complete.js";
import { codePointsToUtf16, utf16ToCodePoints } from "./offsets.js";

type Message = KernelMessage.IMessage;
type Header = KernelMessage.IHeader;
type Channel = KernelMessage.Channel;

export interface FrevaKernelOptions extends IKernel.IOptions {
  /** Builds an engine: at construction, and again after the interpreter was put to sleep. */
  createEngine: () => BrowserPython;
  /** The page's live-interpreter slots: a kernel holds one while its interpreter lives. */
  slots: SlotBroker;
  /** The deployment's starter code, run after the interpreter is ready, when this setup says so. */
  starter?: string;
  /** How long an interrupted cell may take before `confirmHardRestart` is asked. */
  interruptGraceMs: number;
  /** Ask the visitor whether to restart Python; resolve true to restart. */
  confirmHardRestart?: () => Promise<boolean>;
  /** For kernel_info. */
  implementationVersion: string;
}

/** What one execute_request needs for its output and reply. */
interface Running {
  header: Header;
  session: string;
  code: string;
  silent: boolean;
  executionId: string | null;
  done: Promise<void>;
  /** Set when a hard restart or dispose already answered this request. */
  answered: boolean;
}

/** Jupyter's protocol version this kernel speaks. */
export const PROTOCOL_VERSION = "5.3";

export const STATE_LOST =
  "Python was restarted to stop this cell. Python state was lost: variables, imports, " +
  "installed packages and files in /workspace. The notebook itself is unchanged.";

/** Said in the first cell run after this kernel's idle interpreter was stopped for another. */
export const PUT_TO_SLEEP =
  "Python in this notebook was stopped while it was idle, so that another notebook could run " +
  "(at most {n} run at once). Its variables and imports were lost; its files in /workspace were " +
  "kept. It is starting again.\n";

/** What a sleeping kernel keeps of its workspace (in memory): beyond it, it stays awake. */
export const KEEP_LIMITS = { files: 1024, bytes: 256 * 1024 * 1024 };

/** A workspace file kept while the interpreter sleeps. */
interface KeptFile {
  name: string;
  size: number;
  data: Blob;
}

/**
 * The workspace's committed files, read out of an interpreter about to stop. Rejects - and the
 * interpreter carries on - while Python holds a file open or a download runs (`quiesce`), or
 * when they are more than `KEEP_LIMITS`.
 */
async function keepWorkspace(engine: BrowserPython): Promise<KeptFile[]> {
  const resume = await engine.quiesce();
  try {
    const files = (await engine.artifacts()).filter((file) => file.state === "ready");
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length > KEEP_LIMITS.files || bytes > KEEP_LIMITS.bytes) {
      throw new Error("its workspace files are too large to keep while it sleeps");
    }
    const kept: KeptFile[] = [];
    for (const file of files) {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      await engine.streamArtifact(
        file.name,
        new WritableStream<Uint8Array>({
          write: (chunk) => void chunks.push(new Uint8Array(chunk)),
        }),
      );
      kept.push({ name: file.name, size: file.size, data: new Blob(chunks) });
    }
    return kept;
  } catch (error) {
    resume();
    throw error;
  }
}

let counter = 0;
function uuid(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `freva-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FrevaKernel implements IKernel {
  readonly id: string;
  readonly name: string;
  readonly location: string;
  readonly #send: IKernel.SendMessage;
  #engine: BrowserPython;
  readonly #options: FrevaKernelOptions;
  /** The interpreter's start, once code asked for it; null while none is wanted. */
  #ready: Promise<BrowserPythonReadyInfo> | null = null;
  /** Its idle interpreter was stopped for another kernel: the next cell says so. */
  #slept = false;
  /** Starts and restarts (with the starter) in flight: never idle meanwhile. */
  #initializing = 0;
  /** The latest start or restart: only its failure may end the interpreter. */
  #attempt = 0;
  /** Files being written into /workspace from outside Python: never idle meanwhile. */
  #writing = 0;
  /** Its interpreter is being put to sleep: requests wait, then start a fresh one. */
  #sleeping: Promise<void> | null = null;
  /** The workspace files of its stopped interpreter, put back into the next one. */
  #kept: KeptFile[] | null = null;
  /** When it last ran code, for the least-recently-used choice of which idle kernel stops. */
  #lastUsed = Date.now();
  readonly #disposed = new Signal<this, void>(this);
  #isDisposed = false;
  #release: (() => void) | null = null;
  #info: BrowserPythonReadyInfo | null = null;
  #lastCount = 0;
  /** Requests whose execute_input has not arrived yet, by msg_id (the engine's token). */
  #byToken = new Map<string, Running>();
  /** Requests that have started, by the engine's execution id. */
  #byExecution = new Map<string, Running>();
  #running: Running | null = null;
  /** Recently finished requests, so late (background) output can still name its request. */
  #finished = new Map<string, Running>();
  /**
   * Shell messages taken from Lite, in arrival order. Lite holds its own queue only until
   * `handleMessage` returns, so every waiting request is here: stop_on_error, an interrupt and a
   * hard restart abort exactly the execute requests queued at that moment, never by clock.
   */
  readonly #queue: Message[] = [];
  /** Queued execute requests to answer `aborted` when their turn comes. */
  readonly #aborted = new WeakSet<Message>();
  #draining: Promise<void> | null = null;
  #unsubscribe: () => void;

  constructor(options: FrevaKernelOptions) {
    this.id = options.id;
    this.name = options.name;
    this.location = options.location;
    this.#send = options.sendMessage;
    this.#options = options;
    this.#engine = options.createEngine();
    this.#unsubscribe = this.#engine.onOutput((event) => this.#onOutput(event));
  }

  /** The interpreter, started on first use (and again after it was put to sleep). */
  #started(): Promise<BrowserPythonReadyInfo> {
    if (this.#sleeping) return this.#sleeping.then(() => this.#started());
    if (!this.#ready) {
      this.#ready = this.#boot();
      // A failed start is reported by the request that asked; the next one tries again.
      this.#ready.catch(() => {
        if (!this.#release) this.#ready = null;
      });
    }
    return this.#ready;
  }

  async #boot(): Promise<BrowserPythonReadyInfo> {
    const { slots } = this.#options;
    const slot = await slots.reserve(this.id, {
      idle: () => this.#isIdle(),
      lastUsed: () => this.#lastUsed,
      sleep: () => this.#sleep(),
    });
    if (!slot) {
      throw new Error(
        `${slots.capacity} other notebooks on this page are running code, and at most ` +
          `${slots.capacity} may run Python at once. Wait for one to finish (or stop it), then ` +
          `run this cell again. (An idle notebook counts too while it is starting, or when its ` +
          `files are too large to keep while it sleeps.)`,
      );
    }
    if (this.#isDisposed) {
      slot.release();
      throw new Error("the kernel was shut down");
    }
    this.#release = () => slot.release();
    // A failure retires the interpreter (see `#initialize`).
    return this.#initialize(() => this.#engine.start(), true);
  }

  /**
   * Ends the interpreter, in one step and in this order: a fresh engine (not started) takes its
   * place, the old one is disposed, then its slot is given back - so no live Python is ever
   * without a reservation, and the next cell starts a new one. Its kept files stay kept.
   */
  #retire(): void {
    const old = this.#engine;
    this.#unsubscribe();
    if (!this.#isDisposed) {
      this.#engine = this.#options.createEngine();
      this.#unsubscribe = this.#engine.onOutput((event) => this.#onOutput(event));
    }
    this.#ready = null;
    this.#info = null;
    old.dispose();
    this.#release?.();
    this.#release = null;
  }

  /** No cell running or queued; no start, restart, starter, workspace write or sleep under way. */
  #isIdle(): boolean {
    return (
      !this.#isDisposed &&
      this.#running === null &&
      this.#initializing === 0 &&
      this.#writing === 0 &&
      this.#sleeping === null &&
      !this.#queue.some((msg) => msg.header.msg_type === "execute_request")
    );
  }

  /**
   * Stops the idle interpreter to free its slot for another kernel, its workspace files kept
   * first (an interpreter whose files cannot be kept stays awake: this rejects). The kernel
   * stays: its next cell starts a fresh interpreter, with those files, and says what was lost.
   */
  async #sleep(): Promise<void> {
    if (!this.#isIdle() || !this.#release) throw new Error("busy");
    let done: () => void = () => undefined;
    this.#sleeping = new Promise<void>((resolve) => (done = resolve));
    try {
      this.#kept = await keepWorkspace(this.#engine);
    } catch (error) {
      this.#sleeping = null;
      done();
      throw error;
    }
    this.#slept = true;
    this.#retire();
    this.#sleeping = null;
    done();
  }

  /**
   * Bring up an interpreter - the first one, or the fresh one of a hard restart - and run the
   * deployment's starter in it before anything else: the one routine both use, so a restarted
   * kernel has the same environment as a new one. Requests await it (`ready`).
   */
  async #initialize(
    start: () => Promise<BrowserPythonReadyInfo>,
    restore = false,
  ): Promise<BrowserPythonReadyInfo> {
    this.#initializing += 1;
    const attempt = (this.#attempt += 1);
    try {
      const info = await start();
      // The files of an interpreter put to sleep come back before anything runs.
      const kept = restore ? this.#kept : null;
      if (kept) {
        for (const file of kept) {
          await this.#engine.writeWorkspaceFile(file.name, file.data, { size: file.size });
        }
      }
      const { starter } = this.#options;
      if (starter) {
        const ran = await this.#engine.run(starter);
        if (ran.error) throw new Error(`The deployment's starter code failed:\n${ran.error}`);
      }
      // Committed: only now is the checkpoint let go. A failed restore or starter retires this
      // interpreter (its copy of the files with it) and the next start restores them again.
      if (kept && this.#kept === kept) this.#kept = null;
      this.#info = info;
      return info;
    } catch (error) {
      // A start, a restore or a starter that failed: that interpreter goes, with its slot. A
      // start a hard restart overtook fails too (the restart rejects it): the restarted
      // interpreter is not its to end.
      if (!this.#isDisposed && attempt === this.#attempt) this.#retire();
      throw error;
    } finally {
      this.#initializing -= 1;
    }
  }

  /**
   * Lite awaits this before every message. Never rejects (a failed start is reported per request),
   * and starts nothing: Python starts when code first runs.
   */
  get ready(): Promise<void> {
    return (this.#ready ?? Promise.resolve()).then(
      () => undefined,
      () => undefined,
    );
  }

  get isDisposed(): boolean {
    return this.#isDisposed;
  }

  get disposed(): Signal<this, void> {
    return this.#disposed;
  }

  /**
   * Writes a file into Python's /workspace from outside Python (Save a copy to /workspace),
   * starting the interpreter first as a cell would - the first time, or after it was put to sleep
   * (its kept files come back first). Not put to sleep while it writes.
   */
  async writeWorkspaceFile(
    ...args: Parameters<BrowserPython["writeWorkspaceFile"]>
  ): ReturnType<BrowserPython["writeWorkspaceFile"]> {
    if (this.#isDisposed) throw new Error("the kernel was shut down");
    this.#writing += 1;
    try {
      await this.#started();
      this.#lastUsed = Date.now();
      return await this.#engine.writeWorkspaceFile(...args);
    } finally {
      this.#writing -= 1;
    }
  }

  /** The engine, for tests and the plugin's interrupt hook. */
  get engine(): BrowserPython {
    return this.#engine;
  }

  dispose(): void {
    if (this.#isDisposed) return;
    const running = this.#running;
    // Answer the running cell BEFORE the sockets go: after `disposed` nothing is delivered.
    if (running && !running.answered) this.#answerLost(running, "disposed");
    this.#isDisposed = true;
    this.#kept = null;
    this.#queue.length = 0;
    this.#retire();
    this.#disposed.emit();
  }

  // messages

  /** Takes the message into the kernel's queue and returns at once (see `#queue`). */
  async handleMessage(msg: Message): Promise<void> {
    if (this.#isDisposed) return;
    // Lite delivers input_reply outside its queue; stdin is never requested, so nothing to do.
    if (msg.header.msg_type === "input_reply") return;
    this.#queue.push(msg);
    this.#draining ??= this.#drain();
  }

  /** Resolves once every message taken so far has been answered. */
  settled(): Promise<void> {
    return this.#draining ?? Promise.resolve();
  }

  async #drain(): Promise<void> {
    try {
      for (let msg = this.#queue.shift(); msg; msg = this.#queue.shift()) {
        if (this.#isDisposed) break;
        try {
          await this.#process(msg);
        } catch (error) {
          console.error("freva-python: a request failed", error);
        }
      }
    } finally {
      this.#draining = null;
    }
  }

  /** Marks every execute request queued now as aborted; later arrivals are not affected. */
  #abortQueued(): void {
    for (const msg of this.#queue) {
      if (msg.header.msg_type === "execute_request") this.#aborted.add(msg);
    }
  }

  async #process(msg: Message): Promise<void> {
    const header = msg.header;
    this.#status("busy", header);
    try {
      switch (header.msg_type) {
        case "kernel_info_request":
          await this.#kernelInfo(msg);
          break;
        case "execute_request":
          await this.#execute(msg as KernelMessage.IExecuteRequestMsg);
          break;
        case "complete_request":
          await this.#complete(msg as KernelMessage.ICompleteRequestMsg);
          break;
        case "inspect_request":
          this.#reply(msg, "inspect_reply", { status: "ok", found: false, data: {}, metadata: {} });
          break;
        case "is_complete_request":
          this.#reply(
            msg,
            "is_complete_reply",
            isComplete(String((msg.content as { code?: unknown }).code ?? "")),
          );
          break;
        case "history_request":
          this.#reply(msg, "history_reply", { status: "ok", history: [] });
          break;
        case "comm_info_request":
          this.#reply(msg, "comm_info_reply", { status: "ok", comms: {} });
          break;
        case "comm_open": {
          // No comm targets exist (no ipywidgets). Closing at once is how a kernel says so.
          const commId = (msg.content as { comm_id?: string }).comm_id ?? "";
          this.#iopub("comm_close", { comm_id: commId, data: {} }, header);
          break;
        }
        default:
          // input_reply (stdin is never requested), comm_msg, comm_close: nothing to do.
          break;
      }
    } finally {
      this.#status("idle", header);
    }
  }

  async #kernelInfo(msg: Message): Promise<void> {
    let info: BrowserPythonReadyInfo | null = null;
    let failure = "";
    try {
      // Asked when a notebook opens: answered without starting Python.
      info = this.#info ?? (this.#ready ? await this.#ready : null);
    } catch (error) {
      failure = errorText(error);
    }
    this.#reply(msg, "kernel_info_reply", {
      status: "ok",
      protocol_version: PROTOCOL_VERSION,
      implementation: "freva-python",
      implementation_version: this.#options.implementationVersion,
      language_info: {
        name: "python",
        version: info?.pythonVersion ?? "",
        mimetype: "text/x-python",
        file_extension: ".py",
        codemirror_mode: { name: "python", version: 3 },
        pygments_lexer: "ipython3",
        nbconvert_exporter: "python",
      },
      banner: info
        ? `Freva Python ${info.pythonVersion} (Pyodide ${info.pyodideVersion}, ${info.profile})`
        : failure
          ? `Freva Python could not start: ${failure}`
          : "Freva Python (Python starts when the first cell runs)",
      help_links: [],
      debugger: false,
    });
  }

  async #execute(msg: KernelMessage.IExecuteRequestMsg): Promise<void> {
    const content = msg.content;
    const header = msg.header;
    const silent = content.silent === true;
    if (this.#aborted.has(msg)) {
      // Queued behind a stop_on_error failure, an interrupt or a restart: no count, no output.
      this.#reply(msg, "execute_reply", { status: "aborted", execution_count: null }, {});
      return;
    }
    let done!: () => void;
    const running: Running = {
      header,
      session: header.session,
      code: content.code,
      silent,
      executionId: null,
      done: new Promise<void>((resolve) => (done = resolve)),
      answered: false,
    };
    this.#running = running;
    this.#byToken.set(header.msg_id, running);
    let result: CellResult | null = null;
    let failure: string | null = null;
    try {
      // A sleep under way finishes first, so this cell hears of it.
      await this.#sleeping;
      if (this.#slept && !silent) {
        this.#iopub(
          "stream",
          {
            name: "stderr",
            text: PUT_TO_SLEEP.replace("{n}", String(this.#options.slots.capacity)),
          },
          header,
        );
      }
      try {
        await this.#started();
      } catch (error) {
        throw new Error(`Python could not start: ${errorText(error)}`);
      }
      this.#slept = false;
      result = await this.#engine.executeCell(content.code, {
        token: header.msg_id,
        silent,
        storeHistory: content.store_history !== false,
      });
    } catch (error) {
      failure = errorText(error);
    } finally {
      this.#byToken.delete(header.msg_id);
      if (running.executionId) {
        this.#byExecution.delete(running.executionId);
        this.#finished.set(running.executionId, running);
        if (this.#finished.size > 32) {
          this.#finished.delete(this.#finished.keys().next().value as string);
        }
      }
      if (this.#running === running) this.#running = null;
      this.#lastUsed = Date.now();
      done();
    }
    if (running.answered) return;
    if (failure !== null || !result) {
      // A failed execution stops the queue as a Python error does (stop_on_error).
      if (content.stop_on_error !== false) this.#abortQueued();
      this.#answerLost(running, failure ?? "No result.", msg);
      return;
    }
    if (result.executionCount !== null) this.#lastCount = result.executionCount;
    const count = result.executionCount ?? this.#lastCount;
    if (result.status === "cancelled") {
      this.#reply(msg, "execute_reply", { status: "aborted", execution_count: null }, {});
      return;
    }
    if (result.status === "error") {
      if (content.stop_on_error !== false) this.#abortQueued();
      // The IOPub `error` (or the notice bundle) was already published from the event stream.
      //
      // `cause: "interrupt"` is for JupyterLite's kernel client, which on any OTHER error reply
      // cancels its queue of pending requests without answering them - the notebook then shows
      // the kernel busy forever. This kernel aborts those requests itself, with proper `aborted`
      // replies (see `#queue`), so it asks Lite to deliver them.
      this.#reply(
        msg,
        "execute_reply",
        {
          status: "error",
          execution_count: count,
          ename: result.ename ?? "Error",
          evalue: result.evalue ?? "",
          traceback: [...(result.traceback ?? [])],
        },
        { cause: "interrupt", ...(result.notice ? { freva_notice: result.notice } : {}) },
      );
      return;
    }
    this.#reply(msg, "execute_reply", {
      status: "ok",
      execution_count: count,
      payload: [],
      user_expressions: {},
    });
  }

  /**
   * A cell that will never get its own reply from the engine - Python was restarted under it, the
   * kernel shut down, or the engine failed. Says so once, as a structured error, and replies.
   */
  #answerLost(running: Running, message: string, msg?: Message): void {
    running.answered = true;
    const lost = message.includes("restarted") || message.includes("disposed");
    const ename = lost ? "PythonRestarted" : "KernelError";
    const evalue = lost ? STATE_LOST : message;
    if (!running.silent) {
      this.#iopub("error", { ename, evalue, traceback: [`${ename}: ${evalue}`] }, running.header);
    }
    const reply = {
      status: "error" as const,
      execution_count: this.#lastCount,
      ename,
      evalue,
      traceback: [`${ename}: ${evalue}`],
    };
    if (msg) this.#reply(msg, "execute_reply", reply, { cause: "interrupt" });
    else
      this.#shell("execute_reply", reply, running.header, running.session, { cause: "interrupt" });
    if (!msg) this.#status("idle", running.header);
  }

  async #complete(msg: KernelMessage.ICompleteRequestMsg): Promise<void> {
    const { code, cursor_pos: cursor } = msg.content;
    let matches: string[] = [];
    let start = cursor;
    try {
      // Completion uses a running interpreter; it never starts one.
      if (!this.#ready || !this.#info) throw new Error("not started");
      await this.#ready;
      const at = codePointsToUtf16(code, cursor);
      const found = await this.#engine.complete(code, at);
      matches = [...found.matches];
      start = utf16ToCodePoints(code, found.start);
    } catch {
      matches = [];
    }
    this.#reply(msg, "complete_reply", {
      status: "ok",
      matches,
      cursor_start: start,
      cursor_end: cursor,
      metadata: {},
    });
  }

  // output

  #onOutput(event: OutputEvent): void {
    if (event.type === "execute_input") {
      const running = event.token !== undefined ? this.#byToken.get(event.token) : undefined;
      if (!running) return;
      running.executionId = event.executionId;
      this.#byExecution.set(event.executionId, running);
      if (event.executionCount !== null) this.#lastCount = event.executionCount;
      if (!running.silent) {
        this.#iopub(
          "execute_input",
          { code: running.code, execution_count: event.executionCount ?? this.#lastCount },
          running.header,
        );
      }
      return;
    }
    const live = this.#byExecution.get(event.executionId);
    const background = ("background" in event && event.background === true) || !live;
    // Output of a request that already finished: published under the request the engine
    // attributed it to, and TAGGED, never moved into whatever cell runs now.
    const running = live ?? this.#finished.get(event.executionId);
    if (!running) return;
    // A silent request broadcasts nothing on IOPub (Jupyter messaging: `silent`), output included.
    if (running.silent) return;
    const metadata = background
      ? { freva: { background: true, executionId: event.executionId } }
      : {};
    const parent = running.header;
    switch (event.type) {
      case "stdout":
      case "stderr":
        this.#iopub("stream", { name: event.type, text: event.text }, parent, metadata);
        return;
      case "display_data":
        this.#iopub(
          "display_data",
          { data: { ...event.data }, metadata: { ...event.metadata }, transient: {} },
          parent,
          metadata,
        );
        return;
      case "execute_result":
        this.#iopub(
          "execute_result",
          {
            execution_count: event.executionCount ?? this.#lastCount,
            data: { ...event.data },
            metadata: { ...event.metadata },
          },
          parent,
          metadata,
        );
        return;
      case "clear_output":
        this.#iopub("clear_output", { wait: event.wait }, parent, metadata);
        return;
      case "error":
        this.#iopub(
          "error",
          {
            ename: event.ename ?? "Error",
            evalue: event.evalue ?? "",
            traceback: [...(event.traceback ?? event.text.split("\n"))],
          },
          parent,
          metadata,
        );
        return;
      case "display":
        this.#iopub(
          "display_data",
          { data: { [event.mime]: event.data }, metadata: {}, transient: {} },
          parent,
          metadata,
        );
        return;
      default:
        return;
    }
  }

  // interrupt and restart

  /**
   * Stop what is running: cancel every queued cell, then interrupt the engine. A cell that does
   * not stop within the grace period - a synchronous loop never reaches a suspension point - is
   * offered a hard restart, which loses Python's state and says so.
   */
  async interrupt(): Promise<void> {
    if (this.#isDisposed) return;
    this.#abortQueued();
    this.#engine.cancelQueuedCells();
    const running = this.#running;
    if (!running) return;
    // Not awaited: a worker spinning in a synchronous loop never answers, and the grace period
    // starts now either way. A worker that cannot even take the request is exactly the case the
    // restart is for.
    this.#engine.interrupt().catch(() => undefined);
    const stopped = await Promise.race([
      running.done.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), this.#options.interruptGraceMs),
      ),
    ]);
    if (stopped || this.#running !== running) return;
    const confirm = this.#options.confirmHardRestart;
    if (!confirm || !(await confirm())) return;
    if (this.#running === running && !this.#isDisposed) await this.hardRestart();
  }

  /** Terminate the worker and start a fresh interpreter in this kernel. */
  async hardRestart(): Promise<void> {
    const running = this.#running;
    if (running && !running.answered) this.#answerLost(running, "restarted");
    this.#abortQueued();
    this.#lastCount = 0;
    // Never started: nothing to restart, the next cell starts it.
    if (!this.#ready) return;
    // Requests that arrive from now on wait for the fresh interpreter AND its starter.
    this.#ready = this.#initialize(() => this.#engine.restart());
    // A failure is reported by the next request, which awaits `#ready`.
    await this.#ready.catch(() => undefined);
  }

  // transport

  #message(
    channel: Channel,
    msgType: string,
    content: object,
    parent: Header | Record<string, never>,
    session: string,
    metadata: object = {},
  ): Message {
    return {
      channel,
      header: {
        msg_id: uuid(),
        msg_type: msgType,
        session,
        username: "freva",
        date: new Date().toISOString(),
        version: PROTOCOL_VERSION,
      },
      parent_header: parent,
      metadata,
      content,
      buffers: [],
    } as unknown as Message;
  }

  #reply(msg: Message, msgType: string, content: object, metadata: object = {}): void {
    this.#shell(msgType, content, msg.header, msg.header.session, metadata);
  }

  #shell(msgType: string, content: object, parent: Header, session: string, metadata = {}): void {
    this.#send(this.#message("shell", msgType, content, parent, session, metadata));
  }

  #iopub(msgType: string, content: object, parent: Header, metadata: object = {}): void {
    this.#send(this.#message("iopub", msgType, content, parent, parent.session, metadata));
  }

  #status(state: "busy" | "idle", parent: Header): void {
    this.#iopub("status", { execution_state: state }, parent);
  }
}
