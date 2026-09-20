/**
 * One queue for everything that changes the interpreter's state, and every queued thing bound to
 * the Worker it was submitted against. Two defects, the same defect from two sides.
 *
 * ORDER. `push()` goes through a serialising chain so two consoles cannot interleave in Python's
 * single line buffer; a `run()` that goes through nothing arrives out of order, because `push`
 * spends a microtask hop that `run` does not. `push("x = 1")` then `run("print(x)")` gives
 * `NameError`.
 *
 * SESSION. A queued submission that captures nothing about the interpreter it was written for is
 * posted, after a restart, to the REPLACEMENT Worker - a command typed against one interpreter and
 * executed against another, with side effects.
 */
import { describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { FakeWorker, healthyWorker } from "./fake-worker.js";
import type { WorkerRequest } from "../src/protocol.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function engineWith(worker: FakeWorker, options = {}) {
  return createBrowserPython({
    workerFactory: () => worker as unknown as Worker,
    ...options,
  });
}

/** The kinds of state-mutating submission, in the order the Worker received them. */
const submissions = (worker: FakeWorker) =>
  worker.sent
    .filter((m) => m.kind === "push" || m.kind === "run" || m.kind === "clear-buffer")
    .map((m) =>
      m.kind === "push" ? `push:${m.line}` : m.kind === "run" ? `run:${m.code}` : "clear",
    );

describe("submission order", () => {
  it("sends push before run when push was called first", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();

    const pushed = python.push("x = 1");
    const ran = python.run("print(x)");
    await Promise.all([pushed, ran]);

    expect(submissions(worker)).toEqual(["push:x = 1", "run:print(x)"]);
  });

  it("keeps a longer interleaving in call order", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();

    const all = [
      python.run("import numpy"),
      python.push("a = 1"),
      python.run("b = a + 1"),
      python.push("c = b + 1"),
    ];
    await Promise.all(all);

    expect(submissions(worker)).toEqual([
      "run:import numpy",
      "push:a = 1",
      "run:b = a + 1",
      "push:c = b + 1",
    ]);
  });

  it("orders clearBuffer with the submissions around it", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();

    const all = [python.push("def f():"), python.clearBuffer(), python.run("g = 1")];
    await Promise.allSettled(all);

    expect(submissions(worker)).toEqual(["push:def f():", "clear", "run:g = 1"]);
  });

  it("does not send a queued submission before the one in front of it has replied", async () => {
    const worker = new FakeWorker();
    const python = engineWith(worker);
    // Answer `init` only: every push and run then hangs until the test releases it.
    worker.autoRespond = (request: WorkerRequest) =>
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
              workspace: {
                available: true,
                path: "/workspace",
                maxFiles: 64,
                sessionId: "s",
              },
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null;
    await python.start();

    void python.push("first");
    void python.run("second");
    await tick();

    expect(submissions(worker)).toEqual(["push:first"]);
  });
});

// COMPLETION IS AN OBSERVATION, and an observation of a moving target has to be taken in order. A
// `complete()` posted straight out while `push()` waits reaches the Worker as `complete, push`: the
// Worker's queue stops that corrupting the interpreter, but the completion is computed against a
// namespace that does not have `variable` in it yet. It changes no state, so it need not HOLD the
// queue - only enter it.
describe("completion is ordered with the work it observes", () => {
  it("is posted after a push submitted before it", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();

    const pushed = python.push("variable = 1");
    const completed = python.complete("vari");
    await Promise.all([pushed, completed]);

    expect(
      worker.sent.filter((m) => m.kind === "push" || m.kind === "complete").map((m) => m.kind),
    ).toEqual(["push", "complete"]);
  });

  it("does not hold the queue while it waits for its own reply", async () => {
    const worker = new FakeWorker();
    const python = engineWith(worker);
    worker.autoRespond = (request: WorkerRequest) =>
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
              workspace: { available: true, path: "/workspace", maxFiles: 64, sessionId: "s" },
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null;
    await python.start();

    void python.complete("vari"); // never answered
    void python.run("after = 1");
    await tick();
    // A completion is a read. Holding the queue until the interpreter answered it would let an
    // autocomplete popup delay the next line the user runs, which is the wrong trade.
    expect(submissions(worker)).toEqual(["run:after = 1"]);
  });

  it("rejects a queued completion whose interpreter was replaced", async () => {
    const first = new FakeWorker();
    const second = healthyWorker();
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    first.autoRespond = (request: WorkerRequest) =>
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
              workspace: { available: true, path: "/workspace", maxFiles: 64, sessionId: "s" },
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null;
    await python.start();

    void python.push("slow()").catch(() => undefined); // holds the queue, never answered
    const queued = python.complete("vari");
    await tick();
    await python.restart();

    await expect(queued).rejects.toMatchObject({ code: "restarted" });
    expect(second.sent.filter((m) => m.kind === "complete")).toEqual([]);
  });

  it("sends nothing that could change the interactive buffer", async () => {
    const worker = healthyWorker();
    const python = engineWith(worker);
    await python.start();
    await python.push("def f():");
    await python.complete("ret");
    await python.push("    return 1");
    // A completion adds no `push` and no `clear-buffer` - the two messages that touch Python's
    // single line buffer. That a half-written statement SURVIVES one is asserted in
    // `browser-tests/repl.mjs`.
    expect(submissions(worker)).toEqual(["push:def f():", "push:    return 1"]);
  });
});

describe("a submission belongs to the interpreter it was written for", () => {
  it("rejects a queued push after a restart instead of running it in the new interpreter", async () => {
    const first = new FakeWorker();
    const second = healthyWorker();
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    first.autoRespond = (request: WorkerRequest) =>
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
              workspace: { available: true, path: "/workspace", maxFiles: 64, sessionId: "s" },
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null;
    await python.start();

    // One in flight (never answered), one queued behind it.
    const inFlight = python.push("slow_command()");
    const queued = python.push("old_side_effect()");
    await tick();

    await python.restart();

    await expect(inFlight).rejects.toMatchObject({ code: "restarted" });
    await expect(queued).rejects.toMatchObject({ code: "restarted" });
    // THE assertion: the replacement interpreter never heard of the old queue.
    expect(submissions(second)).toEqual([]);
  });

  it("rejects a queued run after a restart too", async () => {
    const first = new FakeWorker();
    const second = healthyWorker();
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    first.autoRespond = (request: WorkerRequest) =>
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
              workspace: { available: true, path: "/workspace", maxFiles: 64, sessionId: "s" },
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null;
    await python.start();

    const inFlight = python.run("slow()");
    const queued = python.run("old_side_effect()");
    await tick();
    await python.restart();

    await expect(inFlight).rejects.toMatchObject({ code: "restarted" });
    await expect(queued).rejects.toMatchObject({ code: "restarted" });
    expect(submissions(second)).toEqual([]);
  });

  it("a dispose settles the queue rather than leaving it pending", async () => {
    const worker = new FakeWorker();
    const python = engineWith(worker);
    worker.autoRespond = (request: WorkerRequest) =>
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
              workspace: { available: true, path: "/workspace", maxFiles: 64, sessionId: "s" },
              addons: [],
              unavailableAddons: [],
              credentialsPersisted: false,
              jspi: false,
            },
          }
        : null;
    await python.start();

    const inFlight = python.push("slow()");
    const queued = python.push("also()");
    await tick();
    python.dispose();

    await expect(inFlight).rejects.toMatchObject({ code: expect.any(String) });
    await expect(queued).rejects.toMatchObject({ code: expect.any(String) });
  });

  it("the queue keeps working after a restart for submissions made afterwards", async () => {
    const first = healthyWorker();
    const second = healthyWorker();
    let made = 0;
    const python = createBrowserPython({
      workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
    });
    await python.start();
    await python.push("before = 1");
    await python.restart();

    await python.push("after = 1");
    await python.run("print(after)");
    expect(submissions(second)).toEqual(["push:after = 1", "run:print(after)"]);
  });
});
