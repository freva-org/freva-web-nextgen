/**
 * Startup, restart and disposal, at every interleaving that only happens to somebody else. One
 * generation must own a boot from beginning to end, and every failure below is the same shape: a
 * superseded boot attempt still acting as though it were current - tearing down its replacement's
 * Worker, setting a state that is no longer its to set, or leaving a pending entry and a timer
 * that nothing will settle. Driven with fakes, because a real interpreter cannot produce these.
 */
import { describe, expect, it, vi } from "vitest";

import { createBrowserPython } from "../src/browser-python.js";
import { FAKE_WORKSPACE, FakeWorker, healthyWorker } from "./fake-worker.js";

const readyInfo = () => ({
  profile: "minimal" as const,
  pythonVersion: "3.14.2",
  pyodideVersion: "314.0.6",
  packages: {},
  startupMs: 1,
  workspace: FAKE_WORKSPACE,
  addons: [],
  unavailableAddons: [],
  credentialsPersisted: false,
  jspi: false,
});

describe("a failed start does not poison the engine", () => {
  it("calls the factory again after a synchronous factory failure", async () => {
    // A `workerFactory` that throws - a CSP that forbids the Worker URL, a bundler that emitted
    // no asset - is a condition a host can fix and retry, so memoising the failed attempt would
    // make every later `start()` return the same rejection without trying again.
    let attempts = 0;
    const engine = createBrowserPython({
      workerFactory: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("no Worker for you");
        return healthyWorker() as unknown as Worker;
      },
    });

    await expect(engine.start()).rejects.toMatchObject({ code: "unsupported" });
    expect(attempts).toBe(1);
    await expect(engine.start()).resolves.toMatchObject({ profile: "minimal" });
    expect(attempts).toBe(2);
    expect(engine.state).toBe("ready");
  });

  it("leaves no pending entries or timers behind when a start times out", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker(); // never answers anything
      const engine = createBrowserPython({
        workerFactory: () => worker as unknown as Worker,
        startTimeoutMs: 50,
      });
      const starting = engine.start();
      await vi.advanceTimersByTimeAsync(60);
      await expect(starting).rejects.toMatchObject({ code: "timeout" });
      expect(engine.state).toBe("error");
      // Nothing left to fire: a stray timer would resolve or reject something long afterwards.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not create a Worker when a status listener disposes during loading", async () => {
    // A listener is called synchronously from `#setState("loading")`, which happens BEFORE the
    // Worker is built. A host that disposes there - a component unmounting the moment it starts -
    // must not get a Worker created anyway, leaving a `disposed` engine holding a live interpreter.
    let built = 0;
    const engine = createBrowserPython({
      workerFactory: () => {
        built += 1;
        return healthyWorker() as unknown as Worker;
      },
    });
    engine.onStatus((event) => {
      if (event.state === "loading") engine.dispose();
    });

    await expect(engine.start()).rejects.toMatchObject({ code: "disposed" });
    expect(built).toBe(0);
    expect(engine.state).toBe("disposed");
  });

  it("does not let a superseded boot tear down its replacement's Worker", async () => {
    // The first boot fails AFTER a restart has already built a second Worker. Terminating "the"
    // worker at that point terminates the live one, and the engine ends up in `error` with a
    // perfectly good interpreter thrown away.
    const workers: FakeWorker[] = [];
    const engine = createBrowserPython({
      workerFactory: () => {
        const worker = workers.length === 0 ? new FakeWorker() : healthyWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    const first = engine.start();
    const second = engine.restart();
    // The dead first Worker finally reports a failure, long after it was replaced.
    workers[0]?.emit({ kind: "fatal", id: workers[0].lastId("init"), message: "too late" });

    await expect(first).rejects.toThrow();
    await expect(second).resolves.toMatchObject({ profile: "minimal" });
    expect(engine.state).toBe("ready");
    expect(workers[1]?.terminated).toBe(0);
  });

  it("rejects the start when postMessage throws after the request was registered", async () => {
    const worker = healthyWorker();
    worker.postMessage = () => {
      throw new DOMException("could not be cloned", "DataCloneError");
    };
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });

    await expect(engine.start()).rejects.toMatchObject({ code: "worker-failed" });
    expect(engine.state).toBe("error");
    // And a retry is still possible: the failure was the message, not the engine.
    const healthy = healthyWorker();
    const retry = createBrowserPython({ workerFactory: () => healthy as unknown as Worker });
    await expect(retry.start()).resolves.toBeTruthy();
  });

  it("does not resolve a start that a dispose overtook", async () => {
    const worker = healthyWorker({ initOnly: true });
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    const starting = engine.start();
    worker.emit({ kind: "ready", id: worker.lastId("init"), info: readyInfo() });
    engine.dispose();

    await expect(starting).rejects.toMatchObject({ code: "disposed" });
    expect(engine.state).toBe("disposed");
    expect(engine.workspace).toBeNull();
  });
});

describe("continuation ownership is decided once", () => {
  /** Answers `push` with `incomplete` for a line ending in a colon, like the real console. */
  function replWorker(): FakeWorker {
    const worker = healthyWorker();
    const base = worker.autoRespond!;
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

  it("lets exactly one of two concurrent owners open a continuation", async () => {
    // Checking before the request is posted and transitioning after the reply comes back leaves
    // a window in which two callers both see `null` and both pass. The loser's line then goes into
    // Python's line buffer underneath the winner's half-written statement.
    const worker = replWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();

    const [a, b] = await Promise.allSettled([
      engine.push("if True:", { owner: "A" }),
      engine.push("print('B')", { owner: "B" }),
    ]);

    const outcomes = [a, b];
    const accepted = outcomes.filter((result) => result.status === "fulfilled");
    const refused = outcomes.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: "protocol" });

    // And the refused line never reached the interpreter's buffer.
    const pushed = worker.sent.filter((message) => message.kind === "push");
    expect(pushed).toHaveLength(1);
  });

  it("lets run() proceed during a continuation without disturbing it", async () => {
    // `run()` is file-mode and has its own compilation unit; it does not touch the interactive
    // line buffer, so it is allowed during a continuation - and must not release it, or the
    // owner's `...` prompt would be lying about what the interpreter is holding.
    const worker = replWorker();
    const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await engine.start();

    await engine.push("if True:", { owner: "A" });
    await expect(engine.run("x = 1")).resolves.toBeTruthy();

    // Still owned by A: B is still refused, and A can still finish.
    await expect(engine.push("1", { owner: "B" })).rejects.toMatchObject({ code: "protocol" });
    await expect(engine.push("    pass", { owner: "A" })).resolves.toMatchObject({
      syntax: "complete",
    });
  });
});
