// Notebook cells and the session operations, against a scripted worker: queue order, cancelled
// queued cells, start-before-output, bundles re-validated on arrival, workspace imports in bounded
// chunks, rate-limited and stale-aware resource samples, and quiescing for a checkpoint.
import { describe, expect, it } from "vitest";

import { createBrowserPython } from "../src/browser-python.js";
import type { WorkerMessage, WorkerRequest } from "../src/protocol.js";
import { BrowserPythonError, type OutputEvent } from "../src/types.js";
import { healthyWorker, type FakeWorker } from "./fake-worker.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait (bounded) until `ready()`: cells post after a lazily loaded module resolves. */
async function until(ready: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !ready(); i += 1) await tick();
  if (!ready()) throw new Error("condition never became true");
}

async function started(worker: FakeWorker = healthyWorker({ initOnly: true })) {
  const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
  const events: OutputEvent[] = [];
  python.onOutput((e) => events.push(e));
  await python.start();
  return { python, worker, events };
}

function cellRequests(worker: FakeWorker) {
  return worker.sent.filter(
    (m): m is Extract<WorkerRequest, { kind: "execute-cell" }> => m.kind === "execute-cell",
  );
}

describe("executeCell", () => {
  it("sends one cell at a time, in call order, holding the queue until the reply", async () => {
    const { python, worker } = await started();
    const a = python.executeCell("a = 1", { token: "t-a" });
    const b = python.executeCell("b = 2", { token: "t-b" });
    await until(() => cellRequests(worker).length === 1);
    for (let i = 0; i < 10; i += 1) await tick();
    expect(cellRequests(worker).map((r) => r.source)).toEqual(["a = 1"]);
    const first = cellRequests(worker)[0]!;
    worker.emit({
      kind: "cell-reply",
      id: first.id,
      result: { executionId: first.executionId, token: "t-a", status: "ok", executionCount: 1 },
    });
    await expect(a).resolves.toMatchObject({ status: "ok", executionCount: 1, token: "t-a" });
    await until(() => cellRequests(worker).length === 2);
    expect(cellRequests(worker).map((r) => r.source)).toEqual(["a = 1", "b = 2"]);
    const second = cellRequests(worker)[1]!;
    expect(second).toMatchObject({ token: "t-b", silent: false, storeHistory: true });
    worker.emit({
      kind: "cell-reply",
      id: second.id,
      result: { executionId: second.executionId, status: "ok", executionCount: 2 },
    });
    await expect(b).resolves.toMatchObject({ executionCount: 2 });
  });

  it("cancels queued cells, which never reach the worker and get no count", async () => {
    const { python, worker } = await started();
    const running = python.executeCell("x");
    const queued = [python.executeCell("y", { token: "q1" }), python.executeCell("z")];
    await until(() => cellRequests(worker).length === 1);
    expect(python.cancelQueuedCells()).toBe(3 - 1);
    const first = cellRequests(worker)[0]!;
    worker.emit({
      kind: "cell-reply",
      id: first.id,
      result: {
        executionId: first.executionId,
        status: "error",
        executionCount: 1,
        ename: "KeyboardInterrupt",
      },
    });
    await running;
    const results = await Promise.all(queued);
    expect(results.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect(results.every((r) => r.executionCount === null)).toBe(true);
    expect(results[0]?.token).toBe("q1");
    expect(cellRequests(worker)).toHaveLength(1);
  });

  it("a silent cell asks for no history", async () => {
    const { python, worker } = await started();
    void python.executeCell("1", { silent: true });
    await until(() => cellRequests(worker).length === 1);
    expect(cellRequests(worker)[0]).toMatchObject({ silent: true, storeHistory: false });
  });

  it("forwards the start event, stream, bundle and structured error in the worker's order", async () => {
    const { python, worker, events } = await started();
    void python.executeCell("x");
    await until(() => cellRequests(worker).length === 1);
    const id = cellRequests(worker)[0]!.executionId;
    const send = (m: WorkerMessage) => worker.emit(m);
    send({ kind: "execute-input", executionId: id, executionCount: 7, token: "t" });
    send({ kind: "stdout", executionId: id, text: "hi\n" });
    send({
      kind: "bundle",
      type: "execute_result",
      executionId: id,
      executionCount: 7,
      data: { "text/plain": "df", "text/html": "<table></table>" },
      metadata: { "text/html": { width: 3, height: -1 } },
    });
    send({ kind: "clear-output", executionId: id, wait: true });
    send({
      kind: "cell-error",
      executionId: id,
      text: "T\nE: x",
      ename: "E",
      evalue: "x",
      traceback: ["T", "E: x"],
    });
    expect(events.map((e) => e.type)).toEqual([
      "execute_input",
      "stdout",
      "execute_result",
      "clear_output",
      "error",
    ]);
    expect(events[0]).toMatchObject({ executionCount: 7, token: "t" });
    expect(events[2]).toMatchObject({
      data: { "text/html": "<table></table>" },
      metadata: { "text/html": { width: 3 } },
      executionCount: 7,
    });
    expect(events[4]).toMatchObject({ ename: "E", evalue: "x", traceback: ["T", "E: x"] });
  });

  it("refuses a forged bundle at the engine boundary and says so where it would have appeared", async () => {
    const { python, worker, events } = await started();
    void python.executeCell("x");
    await until(() => cellRequests(worker).length === 1);
    const id = cellRequests(worker)[0]!.executionId;
    for (const data of [
      { "text/plain": "x", "application/javascript": "alert(1)" },
      { "text/html": "<b>no plain text</b>" },
      { "text/plain": "x", "image/png": "not base64!" },
      ["text/plain"],
    ]) {
      worker.emit({
        kind: "bundle",
        type: "display_data",
        executionId: id,
        data,
        metadata: {},
      } as never);
    }
    expect(events.every((e) => e.type === "stderr")).toBe(true);
    expect(events).toHaveLength(4);
    expect((events[0] as { text: string }).text).toMatch(
      /dropped a display payload: unsupported mime/,
    );
  });
});

describe("writeWorkspaceFile", () => {
  /** A worker that accepts imports and records the chunks. */
  function importingWorker() {
    const worker = healthyWorker({ initOnly: true });
    const chunks: Array<{ offset: number; bytes: number }> = [];
    const closes: boolean[] = [];
    const base = worker.autoRespond;
    worker.autoRespond = (request) => {
      if (request.kind === "import-open")
        return { kind: "import-handle", id: request.id, handle: "import-1" };
      if (request.kind === "import-chunk") {
        chunks.push({ offset: request.offset, bytes: request.bytes.byteLength });
        return { kind: "ack", id: request.id };
      }
      if (request.kind === "import-close") {
        closes.push(request.commit);
        return { kind: "ack", id: request.id };
      }
      return base?.(request) ?? null;
    };
    return { worker, chunks, closes };
  }

  it("sends bounded, contiguous chunks and commits", async () => {
    const { worker, chunks, closes } = importingWorker();
    const { python } = await started(worker);
    const data = new Uint8Array(2.5 * 1024 * 1024).fill(7);
    const result = await python.writeWorkspaceFile("out/a.bin", data);
    expect(result).toEqual({ name: "out/a.bin", size: data.length });
    expect(chunks.map((c) => c.offset)).toEqual([0, 1048576, 2097152]);
    expect(Math.max(...chunks.map((c) => c.bytes))).toBe(1048576);
    expect(closes).toEqual([true]);
  });

  it("abandons the import when the stream is shorter than declared, and rejects", async () => {
    const { worker, closes } = importingWorker();
    const { python } = await started(worker);
    const stream = new Blob([new Uint8Array(10)]).stream();
    await expect(python.writeWorkspaceFile("short.bin", stream, { size: 20 })).rejects.toThrow(
      /ended at 10 of the 20/,
    );
    await tick();
    expect(closes).toEqual([false]);
  });

  it("takes its place in the queue when called: a cell submitted after it runs after it", async () => {
    const { worker } = importingWorker();
    const { python } = await started(worker);
    const write = python.writeWorkspaceFile("in/a.bin", new Uint8Array(16));
    const cell = python.executeCell("print(1)", { token: "after" });
    await write;
    await until(() => cellRequests(worker).length === 1);
    const kinds = worker.sent.map((m) => m.kind);
    expect(kinds.indexOf("import-close")).toBeGreaterThan(-1);
    expect(kinds.indexOf("import-close")).toBeLessThan(kinds.indexOf("execute-cell"));
    const request = cellRequests(worker)[0]!;
    worker.emit({
      kind: "cell-reply",
      id: request.id,
      result: { executionId: request.executionId, status: "ok", executionCount: 1 },
    });
    await cell;
  });

  it("is bound to the interpreter it was called on: a restart before its turn fails it", async () => {
    const { worker } = importingWorker();
    const { python } = await started(worker);
    const write = python.writeWorkspaceFile("in/a.bin", new Uint8Array(16));
    const restarted = python.restart();
    await expect(write).rejects.toThrow(/replaced/);
    await restarted;
    expect(worker.sent.some((m) => m.kind === "import-open")).toBe(false);
  });

  it("a stalled stream is cancelled by its abort, and the queue moves on", async () => {
    const { worker, closes } = importingWorker();
    const { python } = await started(worker);
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const controller = new AbortController();
    const write = python.writeWorkspaceFile("in/stuck.bin", stalled, {
      size: 10,
      signal: controller.signal,
    });
    await until(() => worker.sent.some((m) => m.kind === "import-open"));
    for (let i = 0; i < 5; i += 1) await tick();
    controller.abort();
    await expect(write).rejects.toThrow();
    await tick();
    expect(closes).toEqual([false]);
    const cell = python.executeCell("print(2)");
    await until(() => cellRequests(worker).length === 1);
    const request = cellRequests(worker)[0]!;
    worker.emit({
      kind: "cell-reply",
      id: request.id,
      result: { executionId: request.executionId, status: "ok", executionCount: 1 },
    });
    await expect(cell).resolves.toMatchObject({ status: "ok" });
  });

  it("a stalled stream does not outlive a restart: new cells run in the new interpreter", async () => {
    const { worker } = importingWorker();
    const { python } = await started(worker);
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const write = python.writeWorkspaceFile("in/stuck.bin", stalled, { size: 10 });
    await until(() => worker.sent.some((m) => m.kind === "import-open"));
    await python.restart();
    await expect(write).rejects.toThrow();
    const cell = python.executeCell("print(3)");
    await until(() => cellRequests(worker).length === 1);
    const request = cellRequests(worker)[0]!;
    worker.emit({
      kind: "cell-reply",
      id: request.id,
      result: { executionId: request.executionId, status: "ok", executionCount: 1 },
    });
    await expect(cell).resolves.toMatchObject({ status: "ok" });
  });

  it("needs a size for a stream", async () => {
    const { python } = await started(importingWorker().worker);
    await expect(python.writeWorkspaceFile("x", new Blob([]).stream())).rejects.toThrow(/size/);
  });
});

describe("observeResources", () => {
  it("reports what the worker measured, rate-limited, and absent fields stay absent", async () => {
    const worker = healthyWorker({ initOnly: true });
    let samples = 0;
    const base = worker.autoRespond;
    worker.autoRespond = (request) => {
      if (request.kind === "resources") {
        samples += 1;
        return {
          kind: "resources-reply",
          id: request.id,
          sample: { wasmCapacityBytes: 64 * 1024 * 1024 },
        };
      }
      return base?.(request) ?? null;
    };
    const { python } = await started(worker);
    const first = await python.observeResources();
    expect(first).toMatchObject({
      wasmCapacityBytes: 64 * 1024 * 1024,
      sampleStale: false,
      pendingExecutions: 0,
      activeTransfers: 0,
    });
    expect(first.workspaceBytes).toBeUndefined();
    expect(first.fetchedDecodedBytes).toBeUndefined();
    expect(first.workerGeneration).toMatch(/^ws-/);
    expect(typeof first.timeToUsableMs).toBe("number");
    const again = await python.observeResources();
    expect(again).toBe(first);
    expect(samples).toBe(1);
  });

  it("marks the sample stale when a busy worker does not answer, keeping the last values", async () => {
    const worker = healthyWorker({ initOnly: true });
    let answer = true;
    const base = worker.autoRespond;
    worker.autoRespond = (request) => {
      if (request.kind === "resources") {
        return answer
          ? { kind: "resources-reply", id: request.id, sample: { wasmCapacityBytes: 1024 } }
          : null;
      }
      return base?.(request) ?? null;
    };
    const { python } = await started(worker);
    await python.observeResources();
    answer = false;
    await new Promise((r) => setTimeout(r, 1100));
    const stale = await python.observeResources();
    expect(stale.sampleStale).toBe(true);
    expect(stale.wasmCapacityBytes).toBe(1024);
  }, 10_000);
});

describe("quiesce", () => {
  it("refuses while code runs, then holds the engine until released", async () => {
    const worker = healthyWorker({ initOnly: true });
    const base = worker.autoRespond;
    worker.autoRespond = (request) => {
      if (request.kind === "artifact-list") {
        return {
          kind: "artifacts",
          id: request.id,
          artifacts: [],
          added: [],
          updated: [],
          removed: [],
        };
      }
      return base?.(request) ?? null;
    };
    const { python } = await started(worker);
    const running = python.executeCell("x");
    await until(() => cellRequests(worker).length === 1);
    await expect(python.quiesce()).rejects.toMatchObject({ code: "busy" });
    const cell = cellRequests(worker)[0]!;
    worker.emit({
      kind: "cell-reply",
      id: cell.id,
      result: { executionId: cell.executionId, status: "ok", executionCount: 1 },
    });
    await running;
    const release = await python.quiesce();
    await expect(python.run("1")).rejects.toBeInstanceOf(BrowserPythonError);
    await expect(python.executeCell("1")).rejects.toMatchObject({ code: "quiesced" });
    release();
    release();
    void python.executeCell("2");
    await until(() => cellRequests(worker).length === 2);
  });

  it("refuses while a file is open in Python", async () => {
    const worker = healthyWorker({ initOnly: true });
    const base = worker.autoRespond;
    worker.autoRespond = (request) => {
      if (request.kind === "artifact-list") {
        return {
          kind: "artifacts",
          id: request.id,
          artifacts: [
            {
              name: "a.nc",
              size: 1,
              modifiedMs: 0,
              generation: 1,
              state: "open",
              mime: "application/x-netcdf",
            },
          ],
          added: [],
          updated: [],
          removed: [],
        };
      }
      return base?.(request) ?? null;
    };
    const { python } = await started(worker);
    await expect(python.quiesce()).rejects.toThrow(/a\.nc is open/);
  });
});
