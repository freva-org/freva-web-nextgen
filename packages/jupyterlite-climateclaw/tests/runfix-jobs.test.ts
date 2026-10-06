// Run & fix jobs: ownership by notebook and cell, reserving, stopping, conflicts, verification.
import { describe, expect, it } from "vitest";

import { RunAndFixJobs, applyCheck, boundThread, verifiedFix } from "../src/runfix-jobs.js";
import { RunAndFixCollector } from "../src/runfix.js";
import type { CodeOutput } from "../src/stream.js";

/** Two notebooks whose cells have the same id (`cell-0`), as generated notebooks do. */
const notebookA = { name: "A" };
const notebookB = { name: "B" };
const cellA = { id: "cell-0" };
const cellB = { id: "cell-0" };

const ok = (stdout = ""): CodeOutput => ({
  outcome: "ok",
  stdout,
  stderr: "",
  result: "",
  display: [],
  error: "",
  files: [],
});

describe("RunAndFixJobs", () => {
  it("reserves synchronously: a second click on the same cell gets nothing", () => {
    const jobs = new RunAndFixJobs<object, object>();
    const first = jobs.reserve({ notebook: notebookA, cell: cellA }, "x = 1");
    expect(first?.state).toBe("starting");
    expect(jobs.reserve({ notebook: notebookA, cell: cellA }, "x = 1")).toBeNull();
    // Same cell id in another notebook is another cell.
    expect(jobs.reserve({ notebook: notebookB, cell: cellB }, "y = 1")).not.toBeNull();
    expect(jobs.active).toHaveLength(2);
  });

  it("stops a job that is still starting, and frees its cell at once", () => {
    const jobs = new RunAndFixJobs<object, object>();
    const job = jobs.reserve({ notebook: notebookA, cell: cellA }, "x")!;
    expect(jobs.stop(job)).toEqual({ kind: "done" }); // no thread yet: nothing remote
    expect(job.controller.signal.aborted).toBe(true);
    expect(job.state).toBe("stopped");
    const next = jobs.reserve({ notebook: notebookA, cell: cellA }, "x")!;
    expect(next).not.toBeNull();
    // The old job's cleanup never removes the newer one, and it may no longer write or propose.
    jobs.end(job, "finished");
    expect(jobs.activeFor(cellA)).toBe(next);
    expect(jobs.isCurrent(job)).toBe(false);
    expect(jobs.propose(job, "fixed")).toBeNull();
  });

  it("keeps repairs to their own notebook and cell", () => {
    const jobs = new RunAndFixJobs<object, object>();
    const inB = jobs.reserve({ notebook: notebookB, cell: cellB }, "prnt(1)")!;
    jobs.end(inB, "finished");
    const repair = jobs.propose(inB, "print(1)")!;
    expect(jobs.repairFor(notebookA, cellA)).toBeNull();
    expect(jobs.repairFor(notebookB, cellB)).toBe(repair);
    expect(repair.notebook).toBe(notebookB);
    expect(repair.cell).toBe(cellB);
    // A new run on that cell withdraws the older proposal.
    jobs.reserve({ notebook: notebookB, cell: cellB }, "prnt(1)");
    expect(jobs.repair(repair.jobId)).toBeNull();
  });
});

describe("one execution at a time per notebook", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("queues a second cell's job behind the first, on the same notebook only", async () => {
    const jobs = new RunAndFixJobs<object, object>();
    const order: string[] = [];
    let release!: () => void;
    const first = jobs.reserve({ notebook: notebookA, cell: cellA }, "a")!;
    const second = jobs.reserve({ notebook: notebookA, cell: { id: "cell-1" } }, "b")!;
    const elsewhere = jobs.reserve({ notebook: notebookB, cell: cellB }, "c")!;
    const one = jobs.schedule(first, async () => {
      order.push("a:start");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("a:end");
    });
    const two = jobs.schedule(second, async () => void order.push("b:start"));
    const three = jobs.schedule(elsewhere, async () => void order.push("c:start"));
    expect(second.state).toBe("queued");
    expect(elsewhere.state).toBe("starting");
    await flush();
    // Another notebook's thread runs at once; this notebook's second job waits.
    expect(order).toEqual(["a:start", "c:start"]);
    release();
    await Promise.all([one, two, three]);
    expect(order).toEqual(["a:start", "c:start", "a:end", "b:start"]);
  });

  it("a queued job stopped while waiting never starts, and does not hold the queue", async () => {
    const jobs = new RunAndFixJobs<object, object>();
    const started: string[] = [];
    let release!: () => void;
    const first = jobs.reserve({ notebook: notebookA, cell: cellA }, "a")!;
    const second = jobs.reserve({ notebook: notebookA, cell: { id: "cell-1" } }, "b")!;
    const third = jobs.reserve({ notebook: notebookA, cell: { id: "cell-2" } }, "c")!;
    const runs = [
      jobs.schedule(first, () => new Promise<void>((resolve) => (release = resolve))),
      jobs.schedule(second, async () => void started.push("b")),
      jobs.schedule(third, async () => void started.push("c")),
    ];
    expect(jobs.stop(second)).toEqual({ kind: "done" });
    expect(second.state).toBe("stopped");
    expect(jobs.activeFor(second.cell)).toBeNull();
    await flush();
    release();
    await Promise.all(runs);
    expect(started).toEqual(["c"]);
  });

  it("a failed job does not block the next one", async () => {
    const jobs = new RunAndFixJobs<object, object>();
    const first = jobs.reserve({ notebook: notebookA, cell: cellA }, "a")!;
    const second = jobs.reserve({ notebook: notebookA, cell: { id: "cell-1" } }, "b")!;
    const failed = jobs.schedule(first, async () => {
      throw new Error("HTTP 500");
    });
    let ran = false;
    const next = jobs.schedule(second, async () => void (ran = true));
    await expect(failed).rejects.toThrow("HTTP 500");
    await next;
    expect(ran).toBe(true);
  });
});

describe("the thread: held until stopped for real, shared by no copy, fenced by its session", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("a running job stopped is 'stopping' and keeps the thread until its stream ends", async () => {
    const jobs = new RunAndFixJobs<object, object>();
    const started: string[] = [];
    let streamEnds!: () => void;
    const first = jobs.reserve({ notebook: notebookA, cell: cellA }, "a")!;
    const second = jobs.reserve({ notebook: notebookA, cell: { id: "cell-1" } }, "b")!;
    const one = jobs.schedule(first, async () => {
      first.threadId = "T";
      first.state = "running";
      // The stream: it goes on until the server ends it.
      await new Promise<void>((resolve) => (streamEnds = resolve));
      jobs.end(first, "stopped");
    });
    const two = jobs.schedule(second, async () => void started.push("b"));
    await flush();
    expect(jobs.stop(first)).toEqual({ kind: "wait", threadId: "T" });
    expect(first.state).toBe("stopping");
    expect(first.controller.signal.aborted).toBe(false);
    // Not released: the queued cell does not start on a thread that is still busy.
    expect(jobs.activeFor(cellA)).toBe(first);
    await flush();
    expect(started).toEqual([]);
    expect(jobs.stop(first)).toBeNull(); // stopping already
    streamEnds();
    await Promise.all([one, two]);
    expect(started).toEqual(["b"]);
    expect(first.state).toBe("stopped");
  });

  it("only the server's end of stream confirms a stop; a bare end leaves the thread unconfirmed", () => {
    const jobs = new RunAndFixJobs<object, object>();
    const run = (cell: object) => {
      const job = jobs.reserve({ notebook: notebookA, cell }, "x")!;
      job.threadId = "T";
      job.state = "running";
      jobs.stop(job);
      return job;
    };
    // StreamEnd: stopped, the thread is free.
    const confirmed = run({ id: "c1" });
    expect(jobs.stopEnded(confirmed, true)).toBe("stopped");
    expect(confirmed.state).toBe("stopped");
    // The connection just ended: not confirmed - the caller gives the thread up.
    const truncated = run({ id: "c2" });
    expect(jobs.stopEnded(truncated, false)).toBe("unconfirmed");
    expect(truncated.state).toBe("stopped");
    expect(jobs.activeFor(truncated.cell)).toBeNull();
    // A job that was not stopping ends as it ran.
    const running = jobs.reserve({ notebook: notebookA, cell: { id: "c3" } }, "x")!;
    running.state = "running";
    expect(jobs.stopEnded(running, false)).toBeNull();
    expect(running.state).toBe("running");
  });

  it("a job stopped while its request may be on the thread asks for that thread to be abandoned", () => {
    const jobs = new RunAndFixJobs<object, object>();
    const job = jobs.reserve({ notebook: notebookA, cell: cellA }, "a")!;
    job.threadId = "T";
    expect(jobs.stop(job)).toEqual({ kind: "abandon", threadId: "T" });
    expect(job.controller.signal.aborted).toBe(true);
  });

  it("two notebooks on one remote thread never run on it at once", async () => {
    const jobs = new RunAndFixJobs<object, object>();
    const order: string[] = [];
    let release!: () => void;
    const a = jobs.onThread("T", async () => {
      order.push("A:start");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("A:end");
    });
    const b = jobs.onThread("T", async () => void order.push("B:start"));
    const other = jobs.onThread("U", async () => void order.push("U:start"));
    await flush();
    expect(order).toEqual(["A:start", "U:start"]);
    release();
    await Promise.all([a, b, other]);
    expect(order).toEqual(["A:start", "U:start", "A:end", "B:start"]);
  });

  it("two views of one notebook share its queue (one session)", async () => {
    const jobs = new RunAndFixJobs<object, object>();
    const document = {};
    const viewA = { view: 1 };
    const viewB = { view: 2 };
    const first = jobs.reserve({ notebook: viewA, cell: cellA, session: document }, "a")!;
    const second = jobs.reserve({ notebook: viewB, cell: cellB, session: document }, "b")!;
    let release!: () => void;
    const one = jobs.schedule(first, () => new Promise<void>((resolve) => (release = resolve)));
    const two = jobs.schedule(second, async () => undefined);
    expect(second.state).toBe("queued");
    await flush();
    release();
    await Promise.all([one, two]);
  });

  it("a copy (another path) does not take its original's thread", () => {
    const meta = { runAndFixThread: "T", runAndFixPath: "work/a.ipynb" };
    expect(boundThread(meta, "work/a.ipynb")).toBe("T");
    expect(boundThread(meta, "work/a-Copy1.ipynb")).toBeNull();
    // Metadata from before paths were recorded: a fresh thread, never a shared one.
    expect(boundThread({ runAndFixThread: "T" }, "work/a.ipynb")).toBeNull();
    expect(boundThread(undefined, "a.ipynb")).toBeNull();
  });

  it("a session reset while a thread is being made moves the generation on", () => {
    const jobs = new RunAndFixJobs<object, object>();
    const document = {};
    const before = jobs.generations.get(document);
    // The run started; "New DKRZ thread" is pressed while the thread is being created.
    jobs.generations.bump(document);
    // The run's commit compares generations and does not remember the old session's thread.
    expect(jobs.generations.get(document)).not.toBe(before);
    expect(jobs.generations.get({})).toBe(0);
  });
});

describe("applyCheck", () => {
  it("applies only onto the source the repair was made from", () => {
    const repair = { baseSource: "prnt(1)" };
    expect(applyCheck(repair, { inNotebook: true, source: "prnt(1)" })).toBe("apply");
    expect(applyCheck(repair, { inNotebook: true, source: "print(2)  # mine" })).toBe("conflict");
    expect(applyCheck(repair, { inNotebook: false, source: null })).toBe("gone");
  });
});

describe("verifiedFix", () => {
  const source = "prnt(1)";
  it("offers a fix only when the changed code completed without an error", () => {
    const good = [
      {
        id: "a",
        code: source,
        output: { ...ok(), outcome: "error" as const, error: "NameError: prnt" },
      },
      { id: "b", code: "print(1)", output: ok("1\n") },
    ];
    expect(verifiedFix(source, good, true, false)).toEqual({ fixed: "print(1)", verified: true });
  });
  it("a proposal that itself failed is an attempt, never verified", () => {
    const failed = [
      {
        id: "b",
        code: "print(x)",
        output: { ...ok(), outcome: "error" as const, error: "NameError: x" },
      },
    ];
    expect(verifiedFix(source, failed, true, false)).toEqual({
      fixed: "print(x)",
      verified: false,
    });
  });
  it("an unfinished stream, a missing output or a stream error is not verified", () => {
    const run = [{ id: "b", code: "print(1)", output: ok() }];
    expect(verifiedFix(source, run, false, false)?.verified).toBe(false);
    expect(verifiedFix(source, run, true, true)?.verified).toBe(false);
    expect(
      verifiedFix(source, [{ id: "b", code: "print(1)", output: null }], true, false)?.verified,
    ).toBe(false);
  });
  it("unstructured output never verifies a repair, even without an error in it", () => {
    const legacy = {
      ...ok("Traceback (most recent call last):\nNameError: name 'x' is not defined\n"),
      outcome: "unknown" as const,
    };
    expect(
      verifiedFix(source, [{ id: "b", code: "print(x)", output: legacy }], true, false),
    ).toEqual({
      fixed: "print(x)",
      verified: false,
    });
  });
  it("nothing to offer when the last code run is the cell's own", () => {
    expect(verifiedFix(source, [{ id: "a", code: source, output: ok() }], true, false)).toBeNull();
  });
  it("the collector pairs each output with its code", () => {
    const collector = new RunAndFixCollector();
    collector.add([
      { type: "code", id: "a", code: source },
      {
        type: "output",
        id: "a",
        output: { ...ok(), outcome: "error" as const, error: "NameError" },
      },
      { type: "code", id: "b", code: "print(1)" },
      { type: "output", id: "b", output: ok("1\n") },
      { type: "end", reason: "" },
    ]);
    expect(collector.runs.map((r) => [r.code, r.output?.error ?? null])).toEqual([
      [source, "NameError"],
      ["print(1)", ""],
    ]);
    expect(verifiedFix(source, collector.runs, collector.ended, collector.failed)?.verified).toBe(
      true,
    );
  });
});
