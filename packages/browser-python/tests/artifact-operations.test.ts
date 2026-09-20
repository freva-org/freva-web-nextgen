/**
 * Every artifact operation belongs to one interpreter, and takes its turn. `streamArtifact()`
 * captures a session synchronously and takes a place in the submission queue; `artifacts()`,
 * `readArtifact()` and `deleteArtifact()` need the same seam, or they carry both halves of the
 * same defect. OWNERSHIP: a restart landing in `await this.#requireReady()` replaces the session
 * before the request is built, so `readArtifact("out.csv")` returns another workspace's file of
 * the same name and `deleteArtifact("out.csv")` deletes it there. ORDER: posting immediately while
 * `push()` and `run()` wait in the queue means `push("create_file()"); artifacts()` asks for the
 * listing before the file is created, and `run(...); deleteArtifact(...)` can delete before the
 * code that recreates the file has run.
 */
import { describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { FakeWorker, healthyWorker } from "./fake-worker.js";
import type { WorkerRequest } from "../src/protocol.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const READY = (id: string) => ({
  kind: "ready" as const,
  id,
  info: {
    profile: "minimal" as const,
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
});

/** Two workers, the second replacing the first on `restart()`. */
function pair(options: { firstAnswersOnlyInit?: boolean } = {}) {
  const first = options.firstAnswersOnlyInit ? new FakeWorker() : healthyWorker();
  const second = healthyWorker();
  let made = 0;
  if (options.firstAnswersOnlyInit) {
    first.autoRespond = (request: WorkerRequest) =>
      request.kind === "init" ? READY(request.id) : null;
  }
  const python = createBrowserPython({
    workerFactory: () => ((made += 1) === 1 ? first : second) as unknown as Worker,
  });
  return { first, second, python };
}

const artifactRequests = (worker: FakeWorker) =>
  worker.sent.filter((m) => m.kind.startsWith("artifact-")).map((m) => m.kind);

/** Every state-changing or artifact message, in the order the Worker received it. */
const messages = (worker: FakeWorker) =>
  worker.sent
    .filter((m) => m.kind !== "init")
    .map((m) =>
      m.kind === "push"
        ? `push:${m.line}`
        : m.kind === "run"
          ? `run:${m.code}`
          : m.kind === "artifact-delete"
            ? `delete:${m.name}`
            : m.kind === "artifact-read"
              ? `read:${m.name}`
              : m.kind,
    );

describe("an artifact operation belongs to the interpreter it was asked of", () => {
  const cases: Array<[string, (python: ReturnType<typeof pair>["python"]) => Promise<unknown>]> = [
    ["artifacts()", (python) => python.artifacts()],
    ["readArtifact()", (python) => python.readArtifact("out.csv")],
    ["deleteArtifact()", (python) => python.deleteArtifact("out.csv")],
  ];

  for (const [what, invoke] of cases) {
    it(`${what} rejects when a restart lands in its readiness await`, async () => {
      const { second, python } = pair();
      await python.start();

      const operation = invoke(python);
      // No tick: the restart lands inside the operation's own first await, which is the window.
      const restarted = python.restart();

      await expect(operation).rejects.toMatchObject({ code: "restarted" });
      await restarted;
      expect(artifactRequests(second)).toEqual([]);
    });

    it(`${what} rejects when queued behind work and the interpreter is replaced`, async () => {
      const { first, second, python } = pair({ firstAnswersOnlyInit: true });
      await python.start();

      void python.push("slow()").catch(() => undefined); // holds the queue, never answered
      const queued = invoke(python);
      await tick();
      await python.restart();

      await expect(queued).rejects.toMatchObject({ code: "restarted" });
      expect(artifactRequests(second)).toEqual([]);
      expect(artifactRequests(first)).toEqual([]);
    });

    it(`${what} still works normally after a restart`, async () => {
      const { second, python } = pair();
      await python.start();
      await python.restart();
      // `deleteArtifact` resolves with nothing, so the evidence is that it reached the new Worker
      // and settled rather than what it returned.
      await expect(invoke(python)).resolves.not.toThrow();
      expect(artifactRequests(second).length).toBeGreaterThan(0);
    });
  }
});

describe("artifact operations take their turn in the queue", () => {
  it("lists AFTER a push submitted before it", async () => {
    const { first, python } = pair();
    await python.start();

    const pushed = python.push("create_file()");
    const listed = python.artifacts();
    await Promise.all([pushed, listed]);

    expect(messages(first)).toEqual(["push:create_file()", "artifact-list"]);
  });

  it("reads AFTER a run submitted before it", async () => {
    const { first, python } = pair();
    await python.start();

    const ran = python.run("write_file()");
    const read = python.readArtifact("out.csv");
    await Promise.all([ran, read]);

    expect(messages(first)).toEqual(["run:write_file()", "read:out.csv"]);
  });

  it("deletes AFTER the run that recreates the file, not before it", async () => {
    const { first, python } = pair();
    await python.start();

    // The reported sequence: a queued `run()` that recreates the file, then a delete. Sent in
    // the other order, the delete removes the OLD file and the run then recreates it - so the
    // caller asked for a file to be gone and is left with one.
    const ran = python.run("recreate()");
    const deleted = python.deleteArtifact("out.csv");
    await Promise.all([ran, deleted]);

    expect(messages(first)).toEqual(["run:recreate()", "delete:out.csv"]);
  });

  it("does not hold the queue waiting for its own reply", async () => {
    const { first, python } = pair({ firstAnswersOnlyInit: true });
    await python.start();

    void python.artifacts().catch(() => undefined); // never answered
    void python.run("after = 1");
    await tick();
    // A listing is a read of state, like `complete()`: it has to ENTER the queue in order, and it
    // has no business holding the next line the user runs while the worker gets round to it.
    expect(messages(first)).toEqual(["artifact-list", "run:after = 1"]);
  });

  it("a delete holds the queue until it is acknowledged, because it changes what follows", async () => {
    const { first, python } = pair({ firstAnswersOnlyInit: true });
    await python.start();

    void python.deleteArtifact("out.csv").catch(() => undefined); // never answered
    void python.run("after = 1");
    await tick();
    // A later `run()` may reasonably assume the file is gone; that is only true once the worker
    // has said so.
    expect(messages(first)).toEqual(["delete:out.csv"]);
  });
});

describe("stream acquisition uses the same seam", () => {
  it("streamArtifact is ordered behind a push submitted before it", async () => {
    const { first, python } = pair();
    await python.start();

    const pushed = python.push("write_big()");
    const streamed = python.streamArtifact("big.bin", {
      async write() {},
      async close() {},
      async abort() {},
    });
    await Promise.all([pushed, streamed]);

    expect(messages(first).slice(0, 2)).toEqual(["push:write_big()", "artifact-open"]);
  });
});
