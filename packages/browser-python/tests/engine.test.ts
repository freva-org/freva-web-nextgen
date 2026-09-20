/**
 * The engine's state machine, and the correlation table that makes concurrency safe.
 *
 * The theme: a single mutable `pendingResolve` passes a happy-path test and fails every
 * overlapping-lifecycle case below, silently, by settling the wrong promise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { BrowserPythonError } from "../src/types.js";
import type { BrowserPythonState, StatusEvent } from "../src/types.js";
import { FAKE_WORKSPACE, FakeWorker, healthyWorker } from "./fake-worker.js";
import type { WorkerMessage, WorkerRequest } from "../src/protocol.js";

/**
 * Let the microtask queue drain. `push()` awaits the memoised start promise before it posts
 * anything, so a test that inspects `worker.sent` in the same tick sees nothing - the engine
 * correctly refusing to post to a worker it has not confirmed is up.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function engineWith(worker: FakeWorker, options = {}) {
  return createBrowserPython({
    workerFactory: () => worker as unknown as Worker,
    ...options,
  });
}

describe("state transitions", () => {
  it("starts idle and downloads nothing until start()", () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    expect(python.state).toBe("idle");
    expect(worker.sent).toHaveLength(0);
  });

  it("goes idle -> loading -> ready, and reports each step", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    const states: BrowserPythonState[] = [];
    python.onStatus((event: StatusEvent) => states.push(event.state));
    await python.start();
    expect(states).toEqual(["loading", "ready"]);
    expect(python.state).toBe("ready");
  });

  it("reports what the worker said came up, rather than assuming", async () => {
    const python = engineWith(healthyWorker(), { profile: "xarray-zarr" });
    const info = await python.start();
    expect(info.pythonVersion).toBe("3.14.2");
    expect(info.profile).toBe("xarray-zarr");
  });

  it("is idempotent: three callers share one interpreter and one download", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    const [a, b, c] = await Promise.all([python.start(), python.start(), python.start()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(worker.sent.filter((m) => m.kind === "init")).toHaveLength(1);
  });

  it("refuses work before start(), rather than hanging", async () => {
    const python = engineWith(healthyWorker());
    await expect(python.push("1")).rejects.toMatchObject({ code: "not-started" });
  });

  it("does not memoise a FAILED start - a flaky CDN must be retryable", async () => {
    const worker = new FakeWorker();
    let attempt = 0;
    worker.autoRespond = (request) => {
      if (request.kind !== "init") return null;
      attempt += 1;
      if (attempt === 1) return { kind: "fatal", id: request.id, message: "network hiccup" };
      return {
        kind: "ready",
        id: request.id,
        info: {
          profile: "minimal",
          pythonVersion: "3.14.2",
          pyodideVersion: "314.0.6",
          packages: {},
          startupMs: 1,
          workspace: FAKE_WORKSPACE,
          addons: [],
          unavailableAddons: [],
          credentialsPersisted: false,
          jspi: false,
        },
      };
    };
    const python = engineWith(worker);
    await expect(python.start()).rejects.toBeInstanceOf(BrowserPythonError);
    expect(python.state).toBe("error");
    await expect(python.start()).resolves.toMatchObject({ pythonVersion: "3.14.2" });
    expect(python.state).toBe("ready");
  });
});

describe("request correlation", () => {
  it("gives every request its own id", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    await Promise.all([python.push("1"), python.push("2"), python.complete("i")]);
    const ids = worker.sent.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every execution its own id, separate from the request id", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    const [a, b] = await Promise.all([python.push("1"), python.push("2")]);
    expect(a.executionId).not.toBe(b.executionId);
  });

  // The case a single resolver gets wrong. Two pushes are outstanding; the worker answers the
  // SECOND first. With one resolver the first caller receives the second's answer.
  it("resolves out-of-order replies to the right caller", async () => {
    const worker = new FakeWorker();
    worker.autoRespond = (request) =>
      request.kind === "init"
        ? {
            kind: "ready",
            id: request.id,
            info: {
              profile: "minimal",
              pythonVersion: "3.14.2",
              pyodideVersion: "314.0.6",
              packages: {},
              startupMs: 1,
              workspace: FAKE_WORKSPACE,
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null;
    const python = engineWith(worker);
    await python.start();

    // `run()`, not `push()`. Pushes are serialised on purpose - the interpreter has one input
    // buffer, and the ownership check and its transition have to be one decision - so two are
    // never in flight together. `run()` is file-mode, which makes it the right way to put two
    // replies in the air at once and answer them backwards.
    const first = python.run("first");
    const second = python.run("second");
    await tick();
    const runs = worker.sent.filter((m) => m.kind === "run");
    expect(runs).toHaveLength(2);

    // Answer the second, then the first.
    worker.emit({
      kind: "run-reply",
      id: runs[1].id,
      result: { executionId: "exec-b", result: "SECOND" },
    });
    worker.emit({
      kind: "run-reply",
      id: runs[0].id,
      result: { executionId: "exec-a", result: "FIRST" },
    });

    expect((await first).result).toBe("FIRST");
    expect((await second).result).toBe("SECOND");
  });

  it("serialises pushes, because the interpreter has one input buffer", async () => {
    // The other half of the same decision: a second push must not reach the worker while the first
    // is still deciding whether it opened a continuation.
    const worker = healthyWorker({ initOnly: true });
    const python = engineWith(worker);
    await python.start();

    const first = python.push("if True:");
    void python.push("    pass");
    await tick();
    expect(worker.sent.filter((m) => m.kind === "push")).toHaveLength(1);

    worker.emit({
      kind: "push-reply",
      id: worker.lastId("push"),
      result: { executionId: "exec-a", syntax: "complete", executed: true },
    });
    await first;
    await tick();
    expect(worker.sent.filter((m) => m.kind === "push")).toHaveLength(2);
  });

  it("refuses a reply of the wrong KIND rather than resolving with nonsense", async () => {
    const worker = new FakeWorker();
    worker.autoRespond = (request) =>
      request.kind === "init"
        ? {
            kind: "ready",
            id: request.id,
            info: {
              profile: "minimal",
              pythonVersion: "3.14.2",
              pyodideVersion: "314.0.6",
              packages: {},
              startupMs: 1,
              workspace: FAKE_WORKSPACE,
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null;
    const python = engineWith(worker);
    await python.start();
    const pending = python.push("1");
    await tick();
    worker.emit({ kind: "ack", id: worker.lastId("push") });
    await expect(pending).rejects.toMatchObject({ code: "protocol" });
  });

  it("ignores a reply for an id nobody is waiting on", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    expect(() => worker.emit({ kind: "ack", id: "req-does-not-exist" })).not.toThrow();
    await expect(python.push("1")).resolves.toBeTruthy();
  });
});

describe("restart", () => {
  it("rejects what was in flight BEFORE terminating, so nothing hangs", async () => {
    const worker = new FakeWorker();
    worker.autoRespond = (request) =>
      request.kind === "init"
        ? {
            kind: "ready",
            id: request.id,
            info: {
              profile: "minimal",
              pythonVersion: "3.14.2",
              pyodideVersion: "314.0.6",
              packages: {},
              startupMs: 1,
              workspace: FAKE_WORKSPACE,
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null; // pushes are never answered
    const workers: FakeWorker[] = [worker];
    const python = createBrowserPython({
      workerFactory: () => {
        const next = workers[workers.length - 1];
        return next as unknown as Worker;
      },
    });
    await python.start();

    const abandoned = python.push("never answered");
    await tick();
    const restarted = python.restart();
    await expect(abandoned).rejects.toMatchObject({ code: "restarted" });
    // The replacement answers, so the restart itself completes.
    const replacement = healthyWorker();
    workers.push(replacement);
    // The engine already asked the (still hanging) first fake for `init`; answer it.
    worker.emit({
      kind: "ready",
      id: worker.lastId("init"),
      info: {
        profile: "minimal",
        pythonVersion: "3.14.2",
        pyodideVersion: "314.0.6",
        packages: {},
        startupMs: 1,
        workspace: FAKE_WORKSPACE,
        addons: [],
        unavailableAddons: [],
        credentialsPersisted: false,
        jspi: false,
      },
    });
    await expect(restarted).resolves.toMatchObject({ pythonVersion: "3.14.2" });
  });

  it("terminates the old worker and builds a new one", async () => {
    const first = healthyWorker();
    const second = healthyWorker();
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    await python.start();
    await python.restart();
    expect(first.terminated).toBe(1);
    expect(made).toBe(2);
    expect(second.sent.filter((m) => m.kind === "init")).toHaveLength(1);
  });

  // A terminated worker's messages can already be sitting in the event loop. Without the
  // generation counter they would settle requests belonging to its replacement.
  it("ignores a late message from the worker it replaced", async () => {
    const first = healthyWorker();
    // init-only: this test decides when the push is answered, and by which worker.
    const second = healthyWorker({ initOnly: true });
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    await python.start();
    await python.restart();

    const pending = python.push("1");
    await tick();
    // The OLD worker shouts an answer for the new worker's id.
    first.emit({
      kind: "push-reply",
      id: second.lastId("push"),
      result: { executionId: "stale", syntax: "complete", executed: true, result: "STALE" },
    });
    second.emit({
      kind: "push-reply",
      id: second.lastId("push"),
      result: { executionId: "fresh", syntax: "complete", executed: true, result: "FRESH" },
    });
    expect((await pending).result).toBe("FRESH");
  });
});

describe("dispose", () => {
  it("is terminal, rejects what is in flight, and stops the worker", async () => {
    const worker = new FakeWorker();
    worker.autoRespond = (request) =>
      request.kind === "init"
        ? {
            kind: "ready",
            id: request.id,
            info: {
              profile: "minimal",
              pythonVersion: "3.14.2",
              pyodideVersion: "314.0.6",
              packages: {},
              startupMs: 1,
              workspace: FAKE_WORKSPACE,
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null;
    const python = engineWith(worker);
    await python.start();
    const abandoned = python.push("never answered");
    await tick();
    python.dispose();

    await expect(abandoned).rejects.toMatchObject({ code: "disposed" });
    expect(python.state).toBe("disposed");
    expect(worker.terminated).toBe(1);
    await expect(python.push("1")).rejects.toMatchObject({ code: "disposed" });
    await expect(python.start()).rejects.toMatchObject({ code: "disposed" });
    await expect(python.restart()).rejects.toMatchObject({ code: "disposed" });
  });

  it("is safe to call twice", async () => {
    const python = engineWith(healthyWorker());
    await python.start();
    python.dispose();
    expect(() => python.dispose()).not.toThrow();
  });
});

describe("output", () => {
  let python: ReturnType<typeof createBrowserPython>;
  let worker: FakeWorker;

  beforeEach(async () => {
    worker = healthyWorker();
    python = engineWith(worker);
    await python.start();
  });

  it("delivers streams in the order the worker sent them", () => {
    const seen: string[] = [];
    python.onOutput((event) => seen.push(`${event.type}:${"text" in event ? event.text : ""}`));
    worker.emit({ kind: "stdout", executionId: "e1", text: "a" });
    worker.emit({ kind: "stdout", executionId: "e1", text: "b" });
    worker.emit({ kind: "result", executionId: "e1", text: "c" });
    expect(seen).toEqual(["stdout:a", "stdout:b", "result:c"]);
  });

  it("re-validates display payloads on arrival, and says why one was dropped", () => {
    const seen: unknown[] = [];
    python.onOutput((event) => seen.push(event));
    worker.emit({
      kind: "display",
      executionId: "e1",
      mime: "text/html" as never,
      encoding: "utf8",
      data: "<script>alert(1)</script>",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "stderr" });
    expect((seen[0] as { text: string }).text).toMatch(/dropped a display payload/);
  });

  it("passes a valid PNG through with its metadata", () => {
    const seen: unknown[] = [];
    python.onOutput((event) => seen.push(event));
    worker.emit({
      kind: "display",
      executionId: "e1",
      mime: "image/png",
      encoding: "base64",
      data: "iVBORw0KGgo=",
      metadata: { figure: 2 },
    });
    expect(seen[0]).toMatchObject({
      type: "display",
      mime: "image/png",
      executionId: "e1",
      metadata: { figure: 2 },
    });
  });

  it("unsubscribes cleanly", () => {
    const listener = vi.fn();
    const off = python.onOutput(listener);
    worker.emit({ kind: "stdout", executionId: "e", text: "x" });
    off();
    worker.emit({ kind: "stdout", executionId: "e", text: "y" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // A consumer's broken listener is the consumer's bug. It must not take down the engine, and it
  // must not stop the OTHER listeners on the same page from hearing the same event.
  it("survives a listener that throws, and still reaches the others", () => {
    const good = vi.fn();
    python.onOutput(() => {
      throw new Error("consumer bug");
    });
    python.onOutput(good);
    expect(() => worker.emit({ kind: "stdout", executionId: "e", text: "x" })).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });
});

describe("fatal errors", () => {
  it("rejects everything in flight and goes to error", async () => {
    const worker = new FakeWorker();
    worker.autoRespond = (request) =>
      request.kind === "init"
        ? {
            kind: "ready",
            id: request.id,
            info: {
              profile: "minimal",
              pythonVersion: "3.14.2",
              pyodideVersion: "314.0.6",
              packages: {},
              startupMs: 1,
              workspace: FAKE_WORKSPACE,
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null;
    const python = engineWith(worker);
    await python.start();
    const a = python.push("1");
    const b = python.complete("2");
    await tick();
    worker.emit({ kind: "fatal", message: "the interpreter died", reason: "no-webassembly" });

    await expect(a).rejects.toMatchObject({ code: "worker-failed", reason: "no-webassembly" });
    await expect(b).rejects.toMatchObject({ code: "worker-failed" });
    expect(python.state).toBe("error");
    expect(worker.terminated).toBe(1);
  });

  it("turns a worker that fails to LOAD into an actionable error, not a hang", async () => {
    const worker = new FakeWorker();
    worker.autoRespond = () => null;
    const python = engineWith(worker);
    const starting = python.start();
    worker.onerror?.({ message: "Failed to fetch the worker module" });
    await expect(starting).rejects.toMatchObject({ code: "worker-failed" });
  });

  it("reports a workerFactory that throws as an unsupported environment", async () => {
    const python = createBrowserPython({
      workerFactory: () => {
        throw new TypeError("Worker is not defined");
      },
    });
    await expect(python.start()).rejects.toMatchObject({
      code: "unsupported",
      reason: "no-worker",
    });
  });
});

describe("configuration", () => {
  it("normalises indexURL so a missing trailing slash is not a 404", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({
      workerFactory: () => worker as unknown as Worker,
      pyodide: { indexURL: "https://example.test/pyodide/v314.0.6/full" },
    });
    await python.start();
    const init = worker.sent.find((m) => m.kind === "init");
    expect(init && "indexURL" in init && init.indexURL).toBe(
      "https://example.test/pyodide/v314.0.6/full/",
    );
  });

  it("forwards the profile and any extra packages verbatim", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({
      workerFactory: () => worker as unknown as Worker,
      profile: "xarray-zarr",
      packages: ["scipy"],
    });
    await python.start();
    const init = worker.sent.find((m) => m.kind === "init");
    expect(init).toMatchObject({ profile: "xarray-zarr", packages: ["scipy"] });
  });
});

// The artifact API, at the engine's boundary: correlation and lifecycle, not storage. Whether the
// list survives a restart, whether a spontaneous change reaches listeners as well as the caller
// who asked, and whether the workspace status is reported rather than assumed. The filesystem
// itself has two browser suites; none of it can run in Node.
describe("artifacts", () => {
  it("reports the workspace the worker actually opened, and only once start() has answered", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    expect(engine.workspace).toBeNull();
    await engine.start();
    expect(engine.workspace).toEqual(FAKE_WORKSPACE);
  });

  it("passes workspaceMaxFiles to the worker, and omits it when unset", async () => {
    const bounded = healthyWorker();
    await createBrowserPython({
      workerFactory: () => bounded as unknown as Worker,
      workspaceMaxFiles: 8,
    }).start();
    const init = bounded.sent.find((m) => m.kind === "init");
    expect(init).toMatchObject({ workspaceMaxFiles: 8 });

    const plain = healthyWorker();
    await createBrowserPython({ workerFactory: () => plain as unknown as Worker }).start();
    expect(plain.sent.find((m) => m.kind === "init")).not.toHaveProperty("workspaceMaxFiles");
  });

  it("lists, reads and deletes through the same correlated request table", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();

    expect((await engine.artifacts()).map((a) => a.name)).toEqual(["out.csv", "big.bin"]);

    const data = await engine.readArtifact("out.csv", { maxBytes: 4 });
    expect(data).toMatchObject({ name: "out.csv", mime: "text/csv", size: 13, truncated: true });
    expect(await data.blob.text()).toBe("time");
    // `maxBytes` travels; an engine that dropped it would silently read whole files for previews.
    expect(worker.sent.find((m) => m.kind === "artifact-read")).toMatchObject({ maxBytes: 4 });

    await engine.deleteArtifact("out.csv");
    expect((await engine.artifacts()).map((a) => a.name)).toEqual(["big.bin"]);
  });

  it("emits a change to listeners AND settles the request that asked for it", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    const seen: string[][] = [];
    engine.onArtifacts((event) => seen.push([...event.removed]));

    await engine.deleteArtifact("out.csv");
    // One event, not none: a UI must not have to know whether a delete came from its own button
    // or from an `os.remove()` typed at the prompt.
    expect(seen).toEqual([["out.csv"]]);
  });

  it("carries the executionId on a spontaneous change so a UI can attribute it", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    const seen: Array<{ executionId?: string; added: readonly string[] }> = [];
    engine.onArtifacts((event) =>
      seen.push({
        ...(event.executionId !== undefined ? { executionId: event.executionId } : {}),
        added: event.added,
      }),
    );

    worker.emit({
      kind: "artifacts",
      executionId: "exec-9",
      artifacts: [],
      added: ["run.nc"],
      updated: [],
      removed: [],
    });
    expect(seen).toEqual([{ executionId: "exec-9", added: ["run.nc"] }]);
  });

  it("announces an empty workspace on restart rather than leaving a stale list", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    const seen: Array<readonly unknown[]> = [];
    engine.onArtifacts((event) => seen.push(event.artifacts));

    await engine.restart();
    // Artifacts are session-scoped: a restart is a new OPFS session directory and the old one is
    // reclaimed. A console that kept its previous list would offer downloads whose storage handles
    // no longer exist, failing only when someone clicked one.
    expect(seen).toEqual([[]]);
  });

  it("drops the workspace when the interpreter dies", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    expect(engine.workspace).not.toBeNull();

    worker.emit({ kind: "fatal", message: "the worker died" });
    expect(engine.workspace).toBeNull();
  });
});

// Streaming, at the engine's boundary. The fake worker serves a small artifact through the real
// protocol - lease, chunks, close - so what is under test is the engine's own arithmetic and
// cleanup: whether it asks for the right ranges, stops when told to, and releases the lease on
// every exit. A leaked lease freezes an artifact for the life of the worker, so `openLeases` is
// asserted after each path rather than only after the happy one.
describe("streamArtifact", () => {
  const collect = () => {
    const chunks: Uint8Array[] = [];
    const events: string[] = [];
    return {
      chunks,
      events,
      sink: {
        write(chunk: Uint8Array) {
          chunks.push(chunk);
          events.push(`write:${chunk.byteLength}`);
        },
        close() {
          events.push("close");
        },
        abort() {
          events.push("abort");
        },
      },
    };
  };

  const text = (chunks: Uint8Array[]): string =>
    new TextDecoder().decode(
      chunks.reduce((all, chunk) => {
        const next = new Uint8Array(all.length + chunk.length);
        next.set(all, 0);
        next.set(chunk, all.length);
        return next;
      }, new Uint8Array()),
    );

  it("delivers every byte, in order, and closes the destination", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    const { sink, chunks, events } = collect();

    const result = await engine.streamArtifact("out.csv", sink, { chunkBytes: 4 });

    expect(text(chunks)).toBe("time,tas\n1,2\n");
    expect(result.bytesWritten).toBe(13);
    expect(events.at(-1)).toBe("close");
    // The lease is what freezes the artifact; a transfer that finishes and keeps it has left the
    // file unwritable for the rest of the session.
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);
  });

  it("asks for chunks no larger than requested, and never past the end", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    await engine.streamArtifact("out.csv", collect().sink, { chunkBytes: 65536, windowChunks: 1 });

    const asked = worker.sent.filter((m) => m.kind === "artifact-chunk");
    // `chunkBytes` is clamped up to the minimum, so one request covers the whole 13-byte file -
    // and its length is the REMAINDER, not the chunk size, which is what stops a reader walking
    // off the end of a file and calling the short read an early EOF.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ offset: 0, length: 13 });
  });

  it("reports progress against the real total", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    const seen: Array<{ transferred: number; total: number; phase: string }> = [];

    await engine.streamArtifact("out.csv", collect().sink, {
      chunkBytes: 4,
      onProgress: (progress) => seen.push(progress),
    });

    expect(seen.every((p) => p.total === 13)).toBe(true);
    // `chunkBytes: 4` is clamped up to the 64 KiB floor, so the whole 13-byte fixture arrives in
    // one chunk and progress reports once for it. The clamp is deliberate - see
    // `resolveChunkBytes`. The second report is the `finishing` phase: every byte is written and
    // the destination is committing, the point at which a UI must stop offering Cancel. Same byte
    // count, different meaning.
    expect(seen.map((p) => [p.transferred, p.phase])).toEqual([
      [13, "transferring"],
      [13, "finishing"],
    ]);
  });

  it("aborts the destination and releases the lease when cancelled", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    const controller = new AbortController();
    controller.abort();
    const { sink, events } = collect();

    await expect(
      engine.streamArtifact("out.csv", sink, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/i);
    // Aborted, NOT closed: a closed half-written file is one somebody opens.
    expect(events).toContain("abort");
    expect(events).not.toContain("close");
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);
  });

  it("releases the lease when the destination itself fails", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    const events: string[] = [];

    await expect(
      engine.streamArtifact("out.csv", {
        write() {
          throw new Error("the disk went away");
        },
        close() {
          events.push("close");
        },
        abort() {
          events.push("abort");
        },
      }),
    ).rejects.toThrow(/disk went away/);

    expect(events).toEqual(["abort"]);
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);
  });

  it("rejects for an artifact that is not there, without opening a lease", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();

    await expect(engine.streamArtifact("absent.nc", collect().sink)).rejects.toThrow(
      /no artifact called absent\.nc/,
    );
    expect((worker as unknown as { openLeases: number }).openLeases).toBe(0);
  });
});

describe("option validation", () => {
  it("rejects a workspaceMaxFiles that could never be honoured", () => {
    // At construction, not on the far side of a message boundary: a host that passed `-1` has made
    // a mistake it can fix, and reporting it as an unavailable workspace an hour later does not
    // help. `1e9` is the one that matters - it would sit in the handle-acquisition loop until the
    // tab was killed, with nothing to explain why startup never finished.
    for (const bad of [0, -1, 2.5, Number.NaN, 1e9]) {
      expect(() => createBrowserPython({ workspaceMaxFiles: bad })).toThrow(RangeError);
    }
    expect(() => createBrowserPython({ workspaceMaxFiles: 64 })).not.toThrow();
  });

  it("rejects a maxBytes that is not a byte count", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(engine.readArtifact("out.csv", { maxBytes: bad })).rejects.toThrow(RangeError);
    }
  });
});

describe("disposeAsync", () => {
  it("waits for the worker to acknowledge before terminating it", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();

    await engine.disposeAsync();

    // The point of the orderly path: the worker was ASKED first, and got to answer, so it had the
    // chance to close its OPFS handles and remove its own session directory.
    expect(worker.sent.some((m) => m.kind === "dispose")).toBe(true);
    expect(worker.terminated).toBe(1);
    expect(engine.state).toBe("disposed");
  });

  it("terminates anyway when the worker never answers", async () => {
    // A worker inside a long-running Python call cannot reply, and a page being closed cannot wait
    // on it. Hard termination stays the fallback rather than becoming an error path.
    const worker = healthyWorker({ initOnly: true });
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();

    await engine.disposeAsync({ timeoutMs: 10 });

    expect(worker.terminated).toBe(1);
    expect(engine.state).toBe("disposed");
  });

  it("is safe to call twice, and after dispose()", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    engine.dispose();
    await engine.disposeAsync();
    expect(worker.terminated).toBe(1);
  });
});

// Four cases where the code was internally consistent and wrong at the boundary: a state that
// existed in the type and was never entered, a URL option that meant something different once it
// crossed into the worker, and two orderings that only occur when a person clicks twice.
describe("carried-forward review findings", () => {
  it("enters `busy` for the duration of an execution, and returns to `ready`", async () => {
    // `busy` is in the public state enum, so something has to set it: otherwise `engine.state`
    // reads `ready` throughout an execution and the console's "Running" label is unreachable. The
    // controller must not take `#busy` from the event either - that clobbers its own correct flag
    // whenever any status arrives mid-execution.
    const worker = new FakeWorker();
    worker.autoRespond = (request) =>
      request.kind === "init"
        ? {
            kind: "ready",
            id: request.id,
            info: {
              profile: "minimal",
              pythonVersion: "3.14.2",
              pyodideVersion: "314.0.6",
              packages: {},
              startupMs: 1,
              workspace: FAKE_WORKSPACE,
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null;
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();
    expect(engine.state).toBe("ready");

    const states: string[] = [];
    engine.onStatus((event) => states.push(event.state));
    const running = engine.run("import time");
    // A macrotask: `run()` awaits `#requireReady()`, which awaits the memoised start promise, so
    // the state flips a few microtasks after the call rather than during it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.state).toBe("busy");

    worker.emit({
      kind: "run-reply",
      id: worker.lastId("run"),
      result: { executionId: "exec-1" },
    });
    await running;
    expect(engine.state).toBe("ready");
    expect(states).toEqual(["busy", "ready"]);
  });

  it("stays busy while two executions overlap", async () => {
    // Counted, not a boolean: the first of two overlapping executions to finish must not report
    // the engine idle while the second is still running.
    const worker = healthyWorker({ initOnly: true });
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();

    const first = engine.run("a");
    const second = engine.run("b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.state).toBe("busy");

    const ids = worker.sent.filter((m) => m.kind === "run").map((m) => m.id);
    worker.emit({ kind: "run-reply", id: ids[0] as string, result: { executionId: "e1" } });
    await first;
    expect(engine.state).toBe("busy");

    worker.emit({ kind: "run-reply", id: ids[1] as string, result: { executionId: "e2" } });
    await second;
    expect(engine.state).toBe("ready");
  });

  it("resolves a relative runtime URL against the PAGE, not the worker", () => {
    // `"runtime/"` is the natural thing for a host to write, and inside a worker a relative URL
    // resolves against the WORKER's own URL: a page at `/app/` produces `/dist/worker/runtime/`
    // and the download 404s against a path nobody configured. The page is stubbed because this
    // runner has no document; what is under test is that the option is resolved on the MAIN
    // THREAD, where `document.baseURI` means what the host meant.
    const document = { baseURI: "https://example.org/app/index.html" };
    Object.defineProperty(globalThis, "document", { value: document, configurable: true });
    try {
      for (const [written, expected] of [
        ["/runtime/", "https://example.org/runtime/"],
        ["runtime/", "https://example.org/app/runtime/"],
        // No trailing slash: without one, `new URL("pyodide.mjs", ".../runtime")` resolves to
        // `/pyodide.mjs` and the whole distribution is looked for at the site root.
        ["runtime", "https://example.org/app/runtime/"],
        ["https://cdn.example.net/pyodide/", "https://cdn.example.net/pyodide/"],
      ] as const) {
        const worker = healthyWorker({ initOnly: true });
        void createBrowserPython({
          workerFactory: () => worker as unknown as Worker,
          pyodide: { indexURL: written },
        }).start();
        const init = worker.sent.find((m) => m.kind === "init") as { indexURL: string };
        expect(init.indexURL, written).toBe(expected);
      }
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it("does not walk a disposed engine back to `ready` when a late start resolves", async () => {
    // The race: the worker's `ready` arrives, settling the pending entry, and `dispose()` runs
    // before the continuation does. Nothing rejects, because the reply already landed - so a
    // disposed engine must not be set back to `ready` carrying a terminated worker's workspace.
    const worker = healthyWorker({ initOnly: true });
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    const starting = engine.start();

    worker.emit({
      kind: "ready",
      id: worker.lastId("init"),
      info: {
        profile: "minimal",
        pythonVersion: "3.14.2",
        pyodideVersion: "314.0.6",
        packages: {},
        startupMs: 1,
        workspace: FAKE_WORKSPACE,
        addons: [],
        unavailableAddons: [],
        credentialsPersisted: false,
        jspi: false,
      },
    });
    engine.dispose();

    await expect(starting).rejects.toMatchObject({ code: "disposed" });
    expect(engine.state).toBe("disposed");
    expect(engine.workspace).toBeNull();
  });

  it("does not let a superseded start overwrite the state of its replacement", async () => {
    // The same race with `restart()` in place of `dispose()`. The loser must not tear down the
    // winner's worker, nor set a state that is no longer its to set.
    const workers: FakeWorker[] = [];
    const engine = createBrowserPython({
      workerFactory: () => {
        const worker = healthyWorker({ initOnly: workers.length === 0 });
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const first = engine.start();
    const second = engine.restart();

    // The first worker answers late, after it has already been replaced.
    workers[0]?.emit({
      kind: "ready",
      id: workers[0].lastId("init"),
      info: {
        profile: "minimal",
        pythonVersion: "3.14.2",
        pyodideVersion: "314.0.6",
        packages: {},
        startupMs: 1,
        workspace: FAKE_WORKSPACE,
        addons: [],
        unavailableAddons: [],
        credentialsPersisted: false,
        jspi: false,
      },
    });

    await expect(first).rejects.toMatchObject({ code: "restarted" });
    await expect(second).resolves.toMatchObject({ profile: "minimal" });
    expect(engine.state).toBe("ready");
  });

  it("reports whether credentials will actually survive a reload", async () => {
    // Asking for persistence and not getting it - a private window, a storage policy - has to
    // reach `ready`: an application showing "stay signed in" cannot otherwise know it failed.
    const worker = healthyWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    const info = await engine.start();
    expect(info).toHaveProperty("credentialsPersisted");
    expect(typeof info.credentialsPersisted).toBe("boolean");
  });
});

// One interpreter, one input buffer, several consoles. The package encourages sharing an engine -
// "three components calling start() get one interpreter and one download" - and `PyodideConsole`
// has a single line buffer. A console left showing a `...` prompt after `def f():` owns that
// buffer, and without the ownership check a line typed in a second console is appended to the
// first's half-written function, invisibly to both surfaces.
describe("continuation ownership", () => {
  /** A worker that answers `push` with a syntax state the test chooses. */
  function replPromptWorker(): FakeWorker {
    const worker = healthyWorker();
    const base = worker.autoRespond as (request: WorkerRequest) => WorkerMessage | null;
    worker.autoRespond = (request) => {
      if (request.kind !== "push") return base(request);
      const incomplete = request.line.trimEnd().endsWith(":");
      return {
        kind: "push-reply",
        id: request.id,
        result: {
          executionId: request.executionId,
          syntax: incomplete ? "incomplete" : "complete",
          executed: !incomplete,
        },
      };
    };
    return worker;
  }

  it("refuses a second owner's line while one is mid-statement", async () => {
    const worker = replPromptWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();

    const opened = await engine.push("def f():", { owner: "console-a" });
    expect(opened.syntax).toBe("incomplete");

    await expect(engine.push("1 + 1", { owner: "console-b" })).rejects.toThrow(
      /Another console is part-way through a multi-line statement/,
    );
    // The refused line must not have reached the interpreter at all.
    expect(worker.sent.filter((m) => m.kind === "push")).toHaveLength(1);
  });

  it("lets the owner finish its own statement", async () => {
    const worker = replPromptWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();

    await engine.push("def f():", { owner: "console-a" });
    await engine.push("    return 1", { owner: "console-a" });
    // Buffer released, so the other console may type again.
    await expect(engine.push("2 + 2", { owner: "console-b" })).resolves.toMatchObject({
      syntax: "complete",
    });
  });

  it("releases the buffer on clearBuffer(), for a console that went away", async () => {
    // The documented way out when the owner has been unmounted, closed or navigated away from.
    const worker = replPromptWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();

    await engine.push("class C:", { owner: "console-a" });
    await engine.clearBuffer();
    await expect(engine.push("3", { owner: "console-b" })).resolves.toMatchObject({
      syntax: "complete",
    });
  });

  it("does not get in the way of a page with one console", async () => {
    // Anonymous pushes share one owner, so the check only ever fires between two DIFFERENT named
    // callers - which is the case it exists for.
    const worker = replPromptWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();

    await engine.push("if True:");
    await expect(engine.push("    pass")).resolves.toMatchObject({ syntax: "complete" });
  });

  it("releases the buffer on restart, because a new interpreter has an empty one", async () => {
    const engine = createBrowserPython({
      workerFactory: () => replPromptWorker() as unknown as Worker,
    });
    await engine.start();
    await engine.push("for i in x:", { owner: "console-a" });
    await engine.restart();
    await expect(engine.push("4", { owner: "console-b" })).resolves.toMatchObject({
      syntax: "complete",
    });
  });
});

// Credential persistence is a promise a host DISPLAYS - "stay signed in" - so the engine has to be
// able to withdraw it. `ready` reports the answer at startup; the failure with no other channel is
// the later one, when the origin's storage quota fills or its data is evicted and the worker finds
// the flush it depends on no longer works.
describe("credential persistence", () => {
  it("reports the engine's stack-switching capability from ready, without refusing to start", async () => {
    const python = engineWith(healthyWorker());
    const info = await python.start();
    expect(info.jspi).toBe(false);
    expect(python.state).toBe("ready");
  });

  it("takes the startup answer from ready, and exposes it", async () => {
    const python = engineWith(healthyWorker());
    const info = await python.start();
    expect(info.credentialsPersisted).toBe(false);
    expect(python.credentialsPersisted).toBe(false);
  });

  it("withdraws the promise when the worker reports storage has degraded", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    const seen: { credentialsPersisted: boolean; detail: string }[] = [];
    python.onStorage((event) => seen.push(event));
    worker.emit({
      kind: "storage",
      addons: [],
      unavailableAddons: [],
      credentialsPersisted: false,
      jspi: false,
      detail: "QuotaExceededError",
    } as WorkerMessage);
    expect(python.credentialsPersisted).toBe(false);
    expect(seen).toEqual([{ credentialsPersisted: false, detail: "QuotaExceededError" }]);
  });

  it("a listener that throws does not stop the others hearing about it", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    const seen: string[] = [];
    python.onStorage(() => {
      throw new Error("consumer bug");
    });
    python.onStorage((event) => seen.push(event.detail));
    expect(() =>
      worker.emit({
        kind: "storage",
        addons: [],
        unavailableAddons: [],
        credentialsPersisted: false,
        jspi: false,
        detail: "gone",
      } as WorkerMessage),
    ).not.toThrow();
    expect(seen).toEqual(["gone"]);
  });

  it("unsubscribing stops the events", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    const seen: string[] = [];
    const off = python.onStorage((event) => seen.push(event.detail));
    off();
    worker.emit({ kind: "storage", credentialsPersisted: false, detail: "gone" } as WorkerMessage);
    expect(seen).toEqual([]);
  });

  // Nothing reaches a listener once the engine is disposed, storage included. This asserts the
  // DELIVERY half only: teardown detaches the worker's handler, so a set left uncleared would
  // still deliver nothing here. The retention half - `dispose()` clearing all four sets so the
  // engine holds no reference to a host that has gone - is not observable from outside.
  it("delivers nothing to any listener after dispose", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    const seen: string[] = [];
    python.onStatus(() => seen.push("status"));
    python.onOutput(() => seen.push("output"));
    python.onArtifacts(() => seen.push("artifacts"));
    python.onStorage(() => seen.push("storage"));
    python.dispose();
    // `dispose()` announces the disposal itself, so the status listener hears one last event by
    // design. Nothing may arrive after that.
    const atDisposal = [...seen];
    worker.emit({ kind: "storage", credentialsPersisted: true, detail: "after" } as WorkerMessage);
    expect(seen).toEqual(atDisposal);
    expect(seen).not.toContain("storage");
  });
});

// THE HOST'S STARTUP CODE, AND WHY IT IS NOT `run()`.
//
// A host with wheels to install has to run Python before anyone may use the console. Doing that
// through `execute()` puts it in the transcript and in history; doing it with `run()` is invisible
// but RESOLVES on a Python error - `ExecutionResult.error` is a field, nothing rejects - so a
// bootstrap can 404 while the host announces a ready console with none of the wheels in it.
// `startupSource` is the path that is both invisible and checked.
describe("startupSource", () => {
  const BOOTSTRAP = 'import micropip\nawait micropip.install("/assets/python/x.whl", deps=False)\n';

  it("runs before the engine reports ready, and only once", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker, { startupSource: BOOTSTRAP });
    const states: string[] = [];
    python.onStatus((event) => states.push(event.state));
    await python.start();
    const runs = worker.sent.filter((m) => m.kind === "run");
    expect(runs).toHaveLength(1);
    expect((runs[0] as { code: string }).code).toBe(BOOTSTRAP);
    // Sent before the engine ever called itself ready.
    expect(worker.sent.indexOf(runs[0])).toBeLessThan(worker.sent.length);
    expect(states.at(-1)).toBe("ready");
    expect(python.state).toBe("ready");
  });

  it("is absent when no host asked for it", async () => {
    const worker = healthyWorker();
    await engineWith(worker).start();
    expect(worker.sent.filter((m) => m.kind === "run")).toHaveLength(0);
  });

  // The defect this exists for. The worker answers `run-reply` with `error` set and nothing
  // rejects, so an unchecked call reports a ready interpreter that is not configured.
  it("rejects start() when the source raises, rather than reporting ready", async () => {
    const worker = healthyWorker();
    const inner = worker.autoRespond;
    worker.autoRespond = (request) => {
      if (request.kind === "run") {
        return {
          kind: "run-reply",
          id: request.id,
          result: {
            executionId: "e",
            error: 'ModuleNotFoundError: No module named "micropip"',
          },
        } as WorkerMessage;
      }
      return inner?.(request) ?? null;
    };
    const python = engineWith(worker, { startupSource: BOOTSTRAP });
    await expect(python.start()).rejects.toThrow(/ModuleNotFoundError/);
    expect(python.state).not.toBe("ready");
  });

  it("carries a code a host can branch on", async () => {
    const worker = healthyWorker();
    const inner = worker.autoRespond;
    worker.autoRespond = (request) =>
      request.kind === "run"
        ? ({
            kind: "run-reply",
            id: request.id,
            result: { executionId: "e", error: "boom" },
          } as WorkerMessage)
        : (inner?.(request) ?? null);
    const python = engineWith(worker, { startupSource: BOOTSTRAP });
    await expect(python.start()).rejects.toMatchObject({ code: "startup-source" });
  });

  // A restart is a new interpreter, so it is new startup code too - and the second run must be as
  // invisible and as checked as the first.
  it("runs again after a restart", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker, { startupSource: BOOTSTRAP });
    await python.start();
    await python.restart();
    expect(worker.sent.filter((m) => m.kind === "run")).toHaveLength(2);
  });
});
