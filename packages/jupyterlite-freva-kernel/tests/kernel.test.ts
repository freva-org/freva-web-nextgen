// The kernel's Jupyter messaging, against a scripted engine: ordering, correlation, replies,
// stop-on-error, interrupt and the hard restart. The real engine is exercised by
// browser-tests/notebook.mjs; here every interleaving can be produced on demand.
import { describe, expect, it, vi } from "vitest";

import type {
  BrowserPython,
  BrowserPythonReadyInfo,
  CellOptions,
  CellResult,
  OutputEvent,
} from "@freva-org/browser-python";
import type { KernelMessage } from "@jupyterlab/services";

import { createSlotBroker, type SlotBroker } from "@freva-org/browser-python/session";

import { FrevaKernel, STATE_LOST } from "../src/kernel.js";

const INFO = {
  profile: "xarray-zarr",
  pythonVersion: "3.14.2",
  pyodideVersion: "314.0.6",
} as BrowserPythonReadyInfo;

type Script = (
  source: string,
  options: CellOptions,
  emit: (event: OutputEvent) => void,
) => Promise<CellResult>;

class FakeEngine {
  listeners = new Set<(event: OutputEvent) => void>();
  started = 0;
  restarted = 0;
  interrupted = 0;
  cancelled = 0;
  disposed = false;
  count = 0;
  ids = 0;
  pending: { reject: (e: Error) => void } | null = null;
  script: Script = async (source, options, emit) => {
    const executionId = `exec-${(this.ids += 1)}`;
    const count = options.silent ? null : (this.count += 1);
    emit({
      type: "execute_input",
      executionId,
      executionCount: count,
      ...(options.token ? { token: options.token } : {}),
    });
    emit({ type: "stdout", executionId, text: `ran ${source}\n` });
    if (source.startsWith("raise")) {
      emit({
        type: "error",
        executionId,
        text: "Traceback\nValueError: x",
        ename: "ValueError",
        evalue: "x",
        traceback: ["Traceback", "ValueError: x"],
      });
      return {
        executionId,
        status: "error",
        executionCount: count,
        ename: "ValueError",
        evalue: "x",
        traceback: ["Traceback", "ValueError: x"],
      };
    }
    if (!options.silent) {
      emit({
        type: "execute_result",
        executionId,
        data: { "text/plain": "1" },
        metadata: {},
        executionCount: count,
      });
    }
    return { executionId, status: "ok", executionCount: count };
  };
  ran: string[] = [];
  start = async () => {
    this.started += 1;
    return INFO;
  };
  run = async (code: string) => {
    this.ran.push(code);
    return code.startsWith("raise")
      ? { executionId: "r", error: "ValueError: starter" }
      : { executionId: "r" };
  };
  restart = async () => {
    this.restarted += 1;
    this.count = 0;
    this.pending?.reject(new Error("The interpreter was restarted."));
    return INFO;
  };
  onOutput = (listener: (event: OutputEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  executeCell = (source: string, options: CellOptions = {}) =>
    this.script(source, options, (event) => this.listeners.forEach((l) => l(event)));
  interrupt = async () => {
    this.interrupted += 1;
    return true;
  };
  cancelQueuedCells = () => {
    this.cancelled += 1;
    return 0;
  };
  complete = vi.fn(async (source: string, cursor: number) => ({
    start: source.slice(0, cursor).lastIndexOf("é"),
    matches: ["émoji_😀_value"],
  }));
  dispose = () => {
    this.disposed = true;
    this.pending?.reject(new Error("This engine was disposed."));
  };
  /** The workspace: committed files by name. */
  files = new Map<string, Uint8Array>();
  /** Set to make `quiesce` refuse (a file open in Python, a download running). */
  busyFiles = false;
  quiesced = 0;
  quiesce = async () => {
    if (this.busyFiles) throw new Error("a file is open in Python");
    this.quiesced += 1;
    return () => void (this.quiesced -= 1);
  };
  artifacts = async () =>
    [...this.files].map(([name, bytes]) => ({
      name,
      size: bytes.length,
      modifiedMs: 0,
      state: "ready" as const,
      generation: 1,
      mime: "application/octet-stream",
    }));
  streamArtifact = async (name: string, destination: WritableStream<Uint8Array>) => {
    const writer = destination.getWriter();
    await writer.write(this.files.get(name)!);
    await writer.close();
    return { name, size: this.files.get(name)!.length };
  };
  writeWorkspaceFile = async (name: string, source: Blob, options: { size?: number } = {}) => {
    const bytes = new Uint8Array(await source.arrayBuffer());
    expect(bytes.length).toBe(options.size);
    this.files.set(name, bytes);
    return { name, size: bytes.length };
  };
}

let seq = 0;
function request<T extends KernelMessage.MessageType>(
  msgType: T,
  content: object,
  date = new Date().toISOString(),
): KernelMessage.IMessage {
  return {
    channel: "shell",
    header: {
      msg_id: `m${(seq += 1)}`,
      msg_type: msgType,
      session: "s1",
      username: "u",
      date,
      version: "5.3",
    },
    parent_header: {},
    metadata: {},
    content,
    buffers: [],
  } as unknown as KernelMessage.IMessage;
}

function kernel(
  options: {
    slots?: SlotBroker;
    grace?: number;
    confirm?: () => Promise<boolean>;
    starter?: string;
  } = {},
) {
  const engine = new FakeEngine();
  const sent: KernelMessage.IMessage[] = [];
  const k = new FrevaKernel({
    id: "k1",
    name: "freva-python",
    location: "",
    sendMessage: (msg) => sent.push(msg),
    createEngine: () => engine as unknown as BrowserPython,
    slots: options.slots ?? createSlotBroker({ capacity: 2 }),
    ...(options.starter ? { starter: options.starter } : {}),
    interruptGraceMs: options.grace ?? 50,
    ...(options.confirm ? { confirmHardRestart: options.confirm } : {}),
    implementationVersion: "test",
  });
  return { k, engine, sent };
}

/** Hands a message over as Lite does, then waits until the kernel has answered it. */
const handle = (k: FrevaKernel, msg: KernelMessage.IMessage) => {
  void k.handleMessage(msg as never);
  return k.settled();
};

/** Starts the kernel's interpreter (it starts with the first cell), then forgets what was sent. */
async function warm(k: FrevaKernel, sent: KernelMessage.IMessage[]) {
  await handle(k, request("execute_request", { code: "pass", silent: true, store_history: false }));
  sent.length = 0;
}

const types = (sent: KernelMessage.IMessage[]) => sent.map((m) => m.header.msg_type);
const content = (m: KernelMessage.IMessage | undefined) => m?.content as Record<string, unknown>;

describe("FrevaKernel", () => {
  it("answers kernel_info without starting Python, then with the versions the engine reported", async () => {
    const { k, sent, engine } = kernel();
    await handle(k, request("kernel_info_request", {}));
    expect(engine.started).toBe(0);
    const before = content(sent.find((m) => m.header.msg_type === "kernel_info_reply"));
    expect(String(before.banner)).toMatch(/starts when the first cell runs/);
    await warm(k, sent);
    await handle(k, request("kernel_info_request", {}));
    const reply = content(sent.find((m) => m.header.msg_type === "kernel_info_reply"));
    expect(reply.protocol_version).toBe("5.3");
    expect((reply.language_info as { version: string }).version).toBe("3.14.2");
    expect(reply.debugger).toBe(false);
    expect(String(reply.banner)).toMatch(/Pyodide 314\.0\.6/);
    expect(types(sent)).toEqual(["status", "kernel_info_reply", "status"]);
  });

  it("maps one cell to busy, execute_input, stream, execute_result, reply, idle, all under its request", async () => {
    const { k, sent } = kernel();
    const msg = request("execute_request", { code: "1", silent: false, store_history: true });
    await handle(k, msg);
    expect(types(sent)).toEqual([
      "status",
      "execute_input",
      "stream",
      "execute_result",
      "execute_reply",
      "status",
    ]);
    expect(
      sent.every((m) => (m.parent_header as KernelMessage.IHeader).msg_id === msg.header.msg_id),
    ).toBe(true);
    expect(content(sent[1]).execution_count).toBe(1);
    expect(content(sent[4])).toMatchObject({ status: "ok", execution_count: 1 });
    expect(content(sent[0]).execution_state).toBe("busy");
    expect(content(sent[5]).execution_state).toBe("idle");
  });

  it("never attributes output to the latest request: each output carries its own parent", async () => {
    const { k, engine, sent } = kernel();
    let releaseFirst!: () => void;
    const first = engine.script;
    engine.script = async (source, options, emit) => {
      if (source === "slow") {
        const executionId = "exec-slow";
        emit({
          type: "execute_input",
          executionId,
          executionCount: 1,
          ...(options.token ? { token: options.token } : {}),
        });
        await new Promise<void>((r) => (releaseFirst = r));
        emit({ type: "stdout", executionId, text: "late\n" });
        return { executionId, status: "ok", executionCount: 1 };
      }
      return first(source, options, emit);
    };
    const a = request("execute_request", { code: "slow", silent: false, store_history: true });
    const b = request("complete_request", { code: "x", cursor_pos: 1 });
    await warm(k, sent);
    const running = handle(k, a);
    await Promise.resolve();
    await Promise.resolve();
    void handle(k, b);
    releaseFirst();
    await running;
    const late = sent.find((m) => m.header.msg_type === "stream");
    expect((late?.parent_header as KernelMessage.IHeader).msg_id).toBe(a.header.msg_id);
  });

  it("publishes an error once, replies with it, and aborts the requests queued behind it", async () => {
    const { k, sent, engine } = kernel();
    await k.ready;
    const executed: string[] = [];
    let fail!: () => void;
    const base = engine.script;
    engine.script = async (source, options, emit) => {
      executed.push(source);
      // The failing cell waits until a follower is queued behind it.
      if (source === "raise") await new Promise<void>((resolve) => (fail = resolve));
      return base(source, options, emit);
    };
    const run = (code: string, date?: string) =>
      request("execute_request", { code, silent: false, store_history: true }, date);
    // Queued before the failure but dated after it: queue order decides, not the clock.
    const later = new Date(Date.now() + 60_000).toISOString();
    void k.handleMessage(run("raise") as never);
    void k.handleMessage(run("queued", later) as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fail();
    await k.settled();
    expect(types(sent).filter((t) => t === "error")).toHaveLength(1);
    const replies = sent.filter((m) => m.header.msg_type === "execute_reply").map(content);
    expect(replies[0]).toMatchObject({ status: "error", ename: "ValueError", evalue: "x" });
    expect(replies[1]).toMatchObject({ status: "aborted", execution_count: null });
    expect(executed).toEqual(["raise"]);
    sent.length = 0;
    // Sent after the failure but dated before it: it runs.
    await handle(k, run("after", new Date(Date.now() - 60_000).toISOString()));
    expect(content(sent.find((m) => m.header.msg_type === "execute_reply"))).toMatchObject({
      status: "ok",
    });
    expect(executed).toEqual(["raise", "after"]);
  });

  it("an execution that fails (not a Python error) also aborts the cells queued behind it", async () => {
    const { k, sent, engine } = kernel();
    await k.ready;
    const executed: string[] = [];
    let crash!: (error: Error) => void;
    const base = engine.script;
    engine.script = async (source, options, emit) => {
      executed.push(source);
      if (source === "crash") {
        return new Promise<CellResult>((_, reject) => (crash = reject));
      }
      return base(source, options, emit);
    };
    const run = (code: string) =>
      request("execute_request", { code, silent: false, store_history: true, stop_on_error: true });
    void k.handleMessage(run("crash") as never);
    void k.handleMessage(run("next") as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    crash(new Error("The worker failed."));
    await k.settled();
    const replies = sent.filter((m) => m.header.msg_type === "execute_reply").map(content);
    expect(replies.map((r) => r.status)).toEqual(["error", "aborted"]);
    expect(executed).toEqual(["crash"]);
  });

  it("an interrupt aborts the cells queued behind the running one", async () => {
    const { k, sent, engine } = kernel();
    await k.ready;
    const executed: string[] = [];
    let release!: () => void;
    const base = engine.script;
    engine.script = async (source, options, emit) => {
      executed.push(source);
      if (source === "slow") await new Promise<void>((resolve) => (release = resolve));
      return base(source, options, emit);
    };
    void k.handleMessage(
      request("execute_request", { code: "slow", silent: false, store_history: true }) as never,
    );
    void k.handleMessage(
      request("execute_request", { code: "next", silent: false, store_history: true }) as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const interrupted = k.interrupt();
    release();
    await interrupted;
    await k.settled();
    const replies = sent.filter((m) => m.header.msg_type === "execute_reply").map(content);
    expect(replies.map((r) => r.status)).toEqual(["ok", "aborted"]);
    expect(executed).toEqual(["slow"]);
  });

  it("a silent cell broadcasts no output at all: no input, stream, display, result or error", async () => {
    const { k, sent, engine } = kernel();
    await handle(k, request("execute_request", { code: "1", silent: true, store_history: false }));
    expect(types(sent)).toEqual(["status", "execute_reply", "status"]);

    sent.length = 0;
    const base = engine.script;
    engine.script = async (source, options, emit) => {
      const result = await base(source, options, emit);
      emit({
        type: "display_data",
        executionId: result.executionId,
        data: { "text/plain": "shown" },
        metadata: {},
      } as OutputEvent);
      return result;
    };
    await handle(
      k,
      request("execute_request", { code: "raise x", silent: true, store_history: false }),
    );
    expect(types(sent)).toEqual(["status", "execute_reply", "status"]);
    expect(content(sent.find((m) => m.header.msg_type === "execute_reply"))).toMatchObject({
      status: "error",
      ename: "ValueError",
    });
  });

  it("converts completion offsets between code points and UTF-16", async () => {
    const { k, engine, sent } = kernel();
    const code = "x = 1; émoji_😀_va";
    const codePoints = [...code].length;
    // Before any cell: no completion, and no interpreter started for one.
    await handle(k, request("complete_request", { code, cursor_pos: codePoints }));
    expect(engine.started).toBe(0);
    expect(content(sent.find((m) => m.header.msg_type === "complete_reply")).matches).toEqual([]);
    await warm(k, sent);
    await handle(k, request("complete_request", { code, cursor_pos: codePoints }));
    expect(engine.complete).toHaveBeenCalledWith(code, code.length);
    const reply = content(sent.find((m) => m.header.msg_type === "complete_reply"));
    expect(reply.cursor_end).toBe(codePoints);
    expect(reply.cursor_start).toBe([..."x = 1; "].length);
    expect(reply.matches).toEqual(["émoji_😀_value"]);
  });

  it("answers inspect, history, is_complete and comm_info, and closes any comm opened", async () => {
    const { k, sent } = kernel();
    await handle(k, request("inspect_request", { code: "x", cursor_pos: 1, detail_level: 0 }));
    await handle(k, request("history_request", {}));
    await handle(k, request("is_complete_request", { code: "x" }));
    await handle(k, request("comm_info_request", {}));
    await handle(
      k,
      request("comm_open", { comm_id: "c1", target_name: "jupyter.widget", data: {} }),
    );
    const by = (t: string) => content(sent.find((m) => m.header.msg_type === t));
    expect(by("inspect_reply")).toMatchObject({ status: "ok", found: false });
    expect(by("history_reply")).toMatchObject({ status: "ok", history: [] });
    // A whole statement: the console runs it on Enter (see is-complete.ts).
    expect(by("is_complete_reply")).toMatchObject({ status: "complete" });
    expect(by("comm_info_reply")).toMatchObject({ status: "ok", comms: {} });
    expect(by("comm_close")).toMatchObject({ comm_id: "c1" });
  });

  it("an open notebook holds no interpreter: Python starts when its first cell runs", async () => {
    const slots = createSlotBroker({ capacity: 2 });
    const kernels = [kernel({ slots }), kernel({ slots }), kernel({ slots })];
    await Promise.all(kernels.map(({ k }) => k.ready));
    expect(kernels.map(({ engine }) => engine.started)).toEqual([0, 0, 0]);
    expect(await slots.held()).toBe(0);
  });

  it("a third kernel stops the least recently used idle interpreter; its next cell says so", async () => {
    const slots = createSlotBroker({ capacity: 2 });
    const a = kernel({ slots });
    const b = kernel({ slots });
    const c = kernel({ slots });
    const run = (k: FrevaKernel, code = "1") =>
      handle(k, request("execute_request", { code, silent: false, store_history: true }));
    await run(a.k);
    await new Promise((r) => setTimeout(r, 5));
    await run(b.k);
    await run(c.k);
    // a was used longest ago: its interpreter stopped, b's kept.
    expect(a.engine.disposed).toBe(true);
    expect(b.engine.disposed).toBe(false);
    expect(content(c.sent.find((m) => m.header.msg_type === "execute_reply")).status).toBe("ok");
    expect(await slots.held()).toBe(2);
    // a's next cell: a notice, then a fresh interpreter (b, now the oldest, stops for it).
    a.sent.length = 0;
    await run(a.k);
    const notice = a.sent.find((m) => m.header.msg_type === "stream");
    expect(String(content(notice).text)).toMatch(/stopped while it was idle/);
    expect(content(a.sent.find((m) => m.header.msg_type === "execute_reply")).status).toBe("ok");
    expect(b.engine.disposed).toBe(true);
  });

  it("an interpreter put to sleep keeps its workspace files: they are back before its next cell", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const engines: FakeEngine[] = [];
    const make = () => {
      const sent: KernelMessage.IMessage[] = [];
      const k = new FrevaKernel({
        id: `k${engines.length}`,
        name: "freva-python",
        location: "",
        sendMessage: (msg) => sent.push(msg),
        createEngine: () => {
          const engine = new FakeEngine();
          engines.push(engine);
          return engine as unknown as BrowserPython;
        },
        slots,
        starter: "import xarray",
        interruptGraceMs: 50,
        implementationVersion: "test",
      });
      return { k, sent };
    };
    const run = (k: FrevaKernel) =>
      handle(k, request("execute_request", { code: "1", silent: false, store_history: true }));
    const a = make();
    await run(a.k);
    const first = a.k.engine as unknown as FakeEngine;
    first.files.set("out/result.nc", new Uint8Array([1, 2, 3]));
    const b = make();
    await run(b.k);
    expect(first.disposed).toBe(true);
    // a's next cell: its files are back in the fresh interpreter before its starter and the cell.
    a.sent.length = 0;
    await run(a.k);
    const fresh = a.k.engine as unknown as FakeEngine;
    expect(fresh).not.toBe(first);
    expect([...fresh.files.get("out/result.nc")!]).toEqual([1, 2, 3]);
    expect(fresh.ran).toEqual(["import xarray"]);
    const notice = a.sent.find((m) => m.header.msg_type === "stream");
    expect(String(content(notice).text)).toMatch(/files in \/workspace were kept/);
  });

  it("a wake whose starter fails keeps the files kept: the next start restores them", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const engines: FakeEngine[] = [];
    let failStarter = false;
    const make = (id: string) => {
      const sent: KernelMessage.IMessage[] = [];
      const k = new FrevaKernel({
        id,
        name: "freva-python",
        location: "",
        sendMessage: (msg) => sent.push(msg),
        createEngine: () => {
          const engine = new FakeEngine();
          const run = engine.run.bind(engine);
          engine.run = async (code: string) =>
            failStarter && code === "import xarray"
              ? { executionId: "r", error: "ValueError: starter" }
              : run(code);
          engines.push(engine);
          return engine as unknown as BrowserPython;
        },
        slots,
        starter: "import xarray",
        interruptGraceMs: 50,
        implementationVersion: "test",
      });
      return { k, sent };
    };
    const run = (k: FrevaKernel) =>
      handle(k, request("execute_request", { code: "1", silent: false, store_history: true }));
    const reply = (sent: KernelMessage.IMessage[]) =>
      content(sent.find((m) => m.header.msg_type === "execute_reply")).status;
    const a = make("a");
    await run(a.k);
    (a.k.engine as unknown as FakeEngine).files.set("important.nc", new Uint8Array([7, 7]));
    // b takes the only slot: a sleeps, its file kept.
    const b = make("b");
    await run(b.k);
    b.k.dispose();
    // a wakes: the file is restored, then the starter fails; that interpreter goes.
    failStarter = true;
    a.sent.length = 0;
    await run(a.k);
    expect(reply(a.sent)).toBe("error");
    // The retry: a fresh interpreter, with the file restored again.
    failStarter = false;
    a.sent.length = 0;
    await run(a.k);
    expect(reply(a.sent)).toBe("ok");
    const now = a.k.engine as unknown as FakeEngine;
    expect([...(now.files.get("important.nc") ?? [])]).toEqual([7, 7]);
  });

  it("a start whose starter fails ends that interpreter before giving its slot back", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const engines: FakeEngine[] = [];
    const sent: KernelMessage.IMessage[] = [];
    const k = new FrevaKernel({
      id: "k1",
      name: "freva-python",
      location: "",
      sendMessage: (msg) => sent.push(msg),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine as unknown as BrowserPython;
      },
      slots,
      starter: "raise_in_starter()",
      interruptGraceMs: 50,
      implementationVersion: "test",
    });
    engines[0]!.run = async (code: string) => {
      engines[0]!.ran.push(code);
      return { executionId: "r", error: "ValueError: starter" };
    };
    await handle(k, request("execute_request", { code: "1", silent: false, store_history: true }));
    expect(content(sent.find((m) => m.header.msg_type === "execute_reply")).status).toBe("error");
    // The started interpreter is gone, a fresh (unstarted) engine stands by, the slot is free.
    expect(engines[0]!.started).toBe(1);
    expect(engines[0]!.disposed).toBe(true);
    expect(engines).toHaveLength(2);
    expect(engines[1]!.started).toBe(0);
    expect(await slots.held()).toBe(0);
    // The next cell starts afresh.
    sent.length = 0;
    await handle(k, request("execute_request", { code: "2", silent: false, store_history: true }));
    expect(engines[1]!.started).toBe(1);
  });

  it("a hard restart while Python is still loading keeps the restarted interpreter", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const engines: FakeEngine[] = [];
    const sent: KernelMessage.IMessage[] = [];
    const k = new FrevaKernel({
      id: "k1",
      name: "freva-python",
      location: "",
      sendMessage: (msg) => sent.push(msg),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine as unknown as BrowserPython;
      },
      slots,
      starter: "import xarray",
      interruptGraceMs: 50,
      implementationVersion: "test",
    });
    const engine = engines[0]!;
    // The first start is still loading; the restart rejects it, as the real engine does.
    engine.start = () => {
      engine.started += 1;
      return new Promise<BrowserPythonReadyInfo>((_resolve, reject) => {
        engine.pending = { reject };
      });
    };
    const first = handle(
      k,
      request("execute_request", { code: "1", silent: false, store_history: true }),
    );
    await vi.waitFor(() => expect(engine.started).toBe(1));
    await k.hardRestart();
    await first;
    // The overtaken start's failure did not end the restarted interpreter, nor free its slot.
    expect(engines).toHaveLength(1);
    expect(engine.disposed).toBe(false);
    expect(engine.ran).toEqual(["import xarray"]);
    expect(await slots.held()).toBe(1);
    sent.length = 0;
    await handle(k, request("execute_request", { code: "2", silent: false, store_history: true }));
    expect(content(sent.find((m) => m.header.msg_type === "execute_reply")).status).toBe("ok");
    expect(engine.started).toBe(1);
    expect(engine.restarted).toBe(1);
  });

  it("a hard restart whose starter fails ends that interpreter, and its slot", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const a = kernel({ slots, starter: "import xarray" });
    await warm(a.k, a.sent);
    expect(await slots.held()).toBe(1);
    a.engine.run = async () => ({ executionId: "r", error: "ValueError: starter" });
    await a.k.hardRestart();
    expect(a.engine.disposed).toBe(true);
    expect(await slots.held()).toBe(0);
  });

  it("saving to /workspace starts Python first: before the first cell, and after a sleep", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const make = () => {
      const engines: FakeEngine[] = [];
      const k = new FrevaKernel({
        id: `k${(seq += 1)}`,
        name: "freva-python",
        location: "",
        sendMessage: () => undefined,
        createEngine: () => {
          const engine = new FakeEngine();
          engines.push(engine);
          return engine as unknown as BrowserPython;
        },
        slots,
        interruptGraceMs: 50,
        implementationVersion: "test",
      });
      return { k, engines };
    };
    const blob = (text: string) => new Blob([text]);
    const save = (k: FrevaKernel, name: string) => {
      const data = blob("{}");
      return k.writeWorkspaceFile(name, data, { size: data.size });
    };
    // Never started: the save starts it, with a slot.
    const a = make();
    await save(a.k, "first.ipynb");
    expect(a.engines[0]!.started).toBe(1);
    expect(a.engines[0]!.files.has("first.ipynb")).toBe(true);
    expect(await slots.held()).toBe(1);
    // Put to sleep for another kernel: the save wakes it, its kept files back first.
    const b = make();
    await save(b.k, "b.ipynb");
    expect(a.engines[0]!.disposed).toBe(true);
    b.k.dispose();
    await save(a.k, "second.ipynb");
    const woken = a.k.engine as unknown as FakeEngine;
    expect(woken).toBe(a.engines[1]);
    expect([...woken.files.keys()].sort()).toEqual(["first.ipynb", "second.ipynb"]);
  });

  it("an interpreter whose files cannot be kept is not put to sleep", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const a = kernel({ slots });
    await warm(a.k, a.sent);
    a.engine.busyFiles = true;
    const b = kernel({ slots });
    await handle(
      b.k,
      request("execute_request", { code: "1", silent: false, store_history: true }),
    );
    expect(a.engine.disposed).toBe(false);
    expect(content(b.sent.find((m) => m.header.msg_type === "execute_reply")).status).toBe("error");
  });

  it("a kernel starting or restarting (its starter running) is never put to sleep", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const a = kernel({ slots, starter: "slow_starter()" });
    let finish: () => void = () => undefined;
    a.engine.run = (code: string) => {
      a.engine.ran.push(code);
      return new Promise((resolve) => (finish = () => resolve({ executionId: "r" })));
    };
    // Its first cell: the interpreter starts, the starter runs (and waits).
    void a.k.handleMessage(
      request("execute_request", { code: "1", silent: false, store_history: true }) as never,
    );
    await vi.waitFor(() => expect(a.engine.ran).toEqual(["slow_starter()"]));
    const b = kernel({ slots });
    await handle(
      b.k,
      request("execute_request", { code: "1", silent: false, store_history: true }),
    );
    expect(a.engine.disposed).toBe(false);
    expect(content(b.sent.find((m) => m.header.msg_type === "execute_reply")).status).toBe("error");
    finish();
    await a.k.settled();
    // A hard restart runs the starter again: not idle meanwhile either.
    const restarting = a.k.hardRestart();
    await vi.waitFor(() => expect(a.engine.ran).toHaveLength(2));
    b.sent.length = 0;
    await handle(
      b.k,
      request("execute_request", { code: "2", silent: false, store_history: true }),
    );
    expect(a.engine.disposed).toBe(false);
    expect(content(b.sent.find((m) => m.header.msg_type === "execute_reply")).status).toBe("error");
    finish();
    await restarting;
  });

  it("refuses a start, per request and without hanging, only while the others run code", async () => {
    const slots = createSlotBroker({ capacity: 2 });
    const busy = [kernel({ slots }), kernel({ slots })];
    for (const { engine } of busy) {
      engine.script = (_s, options, emit) =>
        new Promise<CellResult>(() => {
          emit({
            type: "execute_input",
            executionId: "e",
            executionCount: 1,
            ...(options.token ? { token: options.token } : {}),
          });
        });
    }
    for (const { k } of busy) {
      void k.handleMessage(
        request("execute_request", { code: "loop", silent: false, store_history: true }) as never,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
    const third = kernel({ slots });
    await handle(
      third.k,
      request("execute_request", { code: "1", silent: false, store_history: true }),
    );
    const reply = content(third.sent.find((m) => m.header.msg_type === "execute_reply"));
    expect(reply.status).toBe("error");
    expect(String(reply.evalue)).toMatch(/other notebooks on this page are running code/);
    expect(third.engine.started).toBe(0);
    expect(busy.every(({ engine }) => !engine.disposed)).toBe(true);
  });

  it("a hard restart runs the starter again before the next cell", async () => {
    const { k, engine, sent } = kernel({ starter: "import xarray" });
    await warm(k, sent);
    expect(engine.ran).toEqual(["import xarray"]);
    await k.hardRestart();
    expect(engine.restarted).toBe(1);
    expect(engine.ran).toEqual(["import xarray", "import xarray"]);
  });

  it("runs the deployment's starter after start, and reports its failure per request", async () => {
    const ok = kernel({ starter: "import xarray" });
    await warm(ok.k, ok.sent);
    expect(ok.engine.ran).toEqual(["import xarray"]);
    const failing = kernel({ starter: "raise ValueError" });
    await handle(
      failing.k,
      request("execute_request", { code: "1", silent: false, store_history: true }),
    );
    const reply = content(failing.sent.find((m) => m.header.msg_type === "execute_reply"));
    expect(String(reply.evalue)).toMatch(/starter code failed/);
  });

  it("releases its slot and disposes its engine on dispose, answering a running cell first", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const { k, engine, sent } = kernel({ slots });
    engine.script = (_s, options, emit) =>
      new Promise<CellResult>((_resolve, reject) => {
        emit({
          type: "execute_input",
          executionId: "e",
          executionCount: 1,
          ...(options.token ? { token: options.token } : {}),
        });
        engine.pending = { reject };
      });
    const running = handle(
      k,
      request("execute_request", { code: "x", silent: false, store_history: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    k.dispose();
    await running;
    expect(engine.disposed).toBe(true);
    expect(await slots.held()).toBe(0);
    const replies = sent.filter((m) => m.header.msg_type === "execute_reply");
    expect(replies).toHaveLength(1);
    expect(content(replies[0]).ename).toBe("PythonRestarted");
  });

  it("interrupt cancels queued cells and reaches the engine", async () => {
    const { k, engine } = kernel();
    let finish!: (r: CellResult) => void;
    engine.script = (_s, options, emit) =>
      new Promise<CellResult>((resolve) => {
        emit({
          type: "execute_input",
          executionId: "e",
          executionCount: 1,
          ...(options.token ? { token: options.token } : {}),
        });
        finish = resolve;
      });
    const running = handle(
      k,
      request("execute_request", { code: "x", silent: false, store_history: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const interrupted = k.interrupt();
    await new Promise((r) => setTimeout(r, 0));
    finish({
      executionId: "e",
      status: "error",
      executionCount: 1,
      ename: "KeyboardInterrupt",
      evalue: "",
    });
    await interrupted;
    await running;
    expect(engine.cancelled).toBe(1);
    expect(engine.interrupted).toBe(1);
    expect(engine.restarted).toBe(0);
  });

  it("a cell that ignores the interrupt is hard-restarted on confirmation, and says state was lost", async () => {
    const confirm = vi.fn(async () => true);
    const { k, engine, sent } = kernel({ grace: 20, confirm });
    engine.script = (_s, options, emit) =>
      new Promise<CellResult>((_resolve, reject) => {
        emit({
          type: "execute_input",
          executionId: "e",
          executionCount: 1,
          ...(options.token ? { token: options.token } : {}),
        });
        engine.pending = { reject };
      });
    const running = handle(
      k,
      request("execute_request", { code: "while True: pass", silent: false, store_history: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    await k.interrupt();
    await running;
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(engine.restarted).toBe(1);
    const error = content(sent.find((m) => m.header.msg_type === "error"));
    expect(error.evalue).toBe(STATE_LOST);
    expect(sent.filter((m) => m.header.msg_type === "execute_reply")).toHaveLength(1);
  });

  it("keeps waiting when the restart is declined", async () => {
    const { k, engine } = kernel({ grace: 10, confirm: async () => false });
    let finish!: (r: CellResult) => void;
    engine.script = (_s, options, emit) =>
      new Promise<CellResult>((resolve) => {
        emit({
          type: "execute_input",
          executionId: "e",
          executionCount: 1,
          ...(options.token ? { token: options.token } : {}),
        });
        finish = resolve;
      });
    const running = handle(
      k,
      request("execute_request", { code: "x", silent: false, store_history: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    await k.interrupt();
    expect(engine.restarted).toBe(0);
    finish({ executionId: "e", status: "ok", executionCount: 1 });
    await running;
  });

  it("tags output that arrives after its request finished, without moving it", async () => {
    const { k, engine, sent } = kernel();
    await handle(k, request("execute_request", { code: "1", silent: false, store_history: true }));
    const first = sent.find((m) => m.header.msg_type === "execute_input")
      ?.parent_header as KernelMessage.IHeader;
    sent.length = 0;
    engine.listeners.forEach((l) =>
      l({ type: "stdout", executionId: "exec-1", text: "late\n", background: true }),
    );
    const stream = sent.find((m) => m.header.msg_type === "stream");
    expect((stream?.parent_header as KernelMessage.IHeader).msg_id).toBe(first.msg_id);
    expect((stream?.metadata as { freva?: { background?: boolean } }).freva?.background).toBe(true);
  });
});
