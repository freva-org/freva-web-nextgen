// Remote threads stay busy until the server has ended their stream: a stop, a broken connection
// and a fork must not let the next request (chat or Run at DKRZ) meet a busy thread, and what a
// reply wrote must follow it to a forked thread. Typing into a notebook cell never lands in the
// middle of the user's edit.

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { ActivityStore } from "../src/activity.js";
import { ClimateClawApi, ClimateClawError } from "../src/api.js";
import { ClimateClawModel, type CodeSink } from "../src/model.js";
import { guardedWriter } from "../src/notebook-sink.js";
import { RunAndFixJobs } from "../src/runfix-jobs.js";
import { RunAtDkrzRunner } from "../src/runfix-runner.js";
import { ThreadGate, retryConflict } from "../src/thread-gate.js";
import { ThreadTable, threadMarker } from "../src/threads.js";
import { Typist } from "../src/typist.js";

const END = '{"variant":"StreamEnd","content":"Stream ended."}\n';
const line = (variant: string, content: unknown) => `${JSON.stringify({ variant, content })}\n`;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A ClimateClaw that behaves like the real one where it matters: a thread answers one stream at
 * a time (another request meanwhile is refused with 409), a stop ends the stream on the server's
 * next check, and a dropped connection leaves the server answering for a while.
 */
function server(
  options: { stopDelayMs?: number; afterDropMs?: number; stopUnanswered?: boolean } = {},
) {
  const busy = new Map<string, { stop(): void }>();
  const requests: Array<{ thread: string; at: number; status: number }> = [];
  const stops: string[] = [];
  let threads = 0;
  let script: (thread: string) => string[] = () => [line("Assistant", "Hi"), END];
  let drop = false;
  const fetch = async (input: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (input.endsWith("/newthread")) return Response.json(`T${(threads += 1)}`);
    if (input.endsWith("/getthread")) return Response.json([]);
    if (input.endsWith("/stop")) {
      stops.push(body.thread_id);
      busy.get(body.thread_id)?.stop();
      // Never answered, until the client gives up on it.
      if (options.stopUnanswered) {
        return new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError"))),
        );
      }
      return Response.json({ detail: "stopping" });
    }
    if (!input.endsWith("/streamresponse")) return new Response("", { status: 404 });
    const thread = body.thread_id as string;
    if (busy.has(thread)) {
      requests.push({ thread, at: Date.now(), status: 409 });
      return Response.json({ detail: "busy" }, { status: 409 });
    }
    requests.push({ thread, at: Date.now(), status: 200 });
    const chunks = script(thread);
    const dropping = drop;
    let stopped = false;
    let dropped = false;
    let wake: () => void = () => undefined;
    busy.set(thread, {
      stop: () => {
        // Seen on the server's next check.
        setTimeout(() => {
          stopped = true;
          wake();
          // A dropped stream ends on the server at its next check too.
          if (dropped) busy.delete(thread);
        }, options.stopDelayMs ?? 30);
      },
    });
    const free = (after = 0) => setTimeout(() => busy.delete(thread), after);
    const signal = init.signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (stopped) {
            busy.delete(thread);
            controller.enqueue(new TextEncoder().encode(END));
            controller.close();
            return;
          }
          const next = chunks.shift();
          if (next !== undefined) {
            // Idle as it sends the end, as the server is.
            if (next === END) busy.delete(thread);
            controller.enqueue(new TextEncoder().encode(next));
            if (next === END) controller.close();
            return;
          }
          if (dropping) {
            // The connection breaks; the server goes on a while.
            dropped = true;
            controller.error(new TypeError("network error"));
            free(options.afterDropMs ?? 60);
            return;
          }
          // Waits, as a long reply does, until stopped or the client goes away.
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal?.addEventListener("abort", () => resolve());
          });
          if (signal?.aborted) {
            controller.error(new DOMException("aborted", "AbortError"));
            free(options.afterDropMs ?? 60);
            return;
          }
          busy.delete(thread);
          controller.enqueue(new TextEncoder().encode(END));
          controller.close();
        },
      }),
    );
  };
  return {
    fetch,
    requests,
    stops,
    busy,
    script: (fn: (thread: string) => string[]) => (script = fn),
    dropNext: () => (drop = true),
  };
}

const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});
const assistant = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
});

function chatModel(fake: ReturnType<typeof server>, extra: Record<string, unknown> = {}) {
  const api = new ClimateClawApi("https://freva.example/api/chatbot", fake.fetch);
  return new ClimateClawModel("m", {
    api: () => api,
    signInProblem: () => null,
    hideCode: () => false,
    scopeNote: () => "",
    threads: new ThreadTable(),
    retry: { attempts: 2, delayMs: 5 },
    // Longer than the fake server's stop check, as 3.5 s is longer than ClimateClaw's 3 s.
    settleMs: 50,
    stopWaitMs: 2_000,
    ...extra,
  });
}

async function readSome(stream: ReadableStream<LanguageModelV4StreamPart>, parts: number) {
  const reader = stream.getReader();
  const got: LanguageModelV4StreamPart[] = [];
  while (got.length < parts) {
    const { done, value } = await reader.read();
    if (done) break;
    got.push(value);
  }
  return { reader, got };
}

async function drain(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

describe("a stopped reply", () => {
  it("holds its thread until the server ends it: the next message is not refused (409)", async () => {
    const fake = server({ stopDelayMs: 80 });
    // A long reply: still answering when it is stopped.
    fake.script(() => [line("Assistant", "Working on it")]);
    const gate = new ThreadGate();
    const first = new AbortController();
    const a = await chatModel(fake, { gate }).doStream({
      prompt: [user("one")],
      abortSignal: first.signal,
    });
    await readSome(a.stream, 3);
    // Stop: the chat is done at once ...
    first.abort();
    await tick(5);
    expect(fake.busy.has("T1")).toBe(true);
    // ... and the next message on the same thread waits for the server, then goes through.
    fake.script(() => [line("Assistant", "Hi"), END]);
    const prompt = [user("one"), assistant(`${threadMarker("T1")}\nHi`), user("two")];
    const b = await chatModel(fake, { gate }).doStream({ prompt });
    await drain(b.stream);
    expect(fake.requests.map((r) => [r.thread, r.status])).toEqual([
      ["T1", 200],
      ["T1", 200],
    ]);
  });
});

describe("a broken stream", () => {
  it("asks the server to stop and keeps the thread until then", async () => {
    const fake = server({ afterDropMs: 5_000 });
    const gate = new ThreadGate();
    fake.dropNext();
    fake.script(() => [line("Assistant", "partial")]);
    const a = await chatModel(fake, { gate }).doStream({ prompt: [user("one")] });
    const parts = await drain(a.stream);
    expect(parts.some((p) => p.type === "error")).toBe(true);
    expect(gate.busy("T1")).toBe(true);
    fake.script(() => [line("Assistant", "ok"), END]);
    const prompt = [user("one"), assistant(`${threadMarker("T1")}\npartial`), user("two")];
    await drain((await chatModel(fake, { gate }).doStream({ prompt })).stream);
    // Never sent onto the still-busy thread.
    expect(fake.requests.filter((r) => r.status === 409)).toEqual([]);
  });

  it("a stop request that is never answered holds the thread only a bounded while", async () => {
    const fake = server({ afterDropMs: 20, stopUnanswered: true });
    const gate = new ThreadGate();
    fake.dropNext();
    fake.script(() => [line("Assistant", "partial")]);
    const a = await chatModel(fake, { gate, stopConfirmMs: 40 }).doStream({
      prompt: [user("one")],
    });
    await drain(a.stream);
    expect(fake.stops).toEqual(["T1"]);
    expect(gate.busy("T1")).toBe(true);
    fake.script(() => [line("Assistant", "ok"), END]);
    const prompt = [user("one"), assistant(`${threadMarker("T1")}\npartial`), user("two")];
    const next = await chatModel(fake, { gate, stopConfirmMs: 40 }).doStream({ prompt });
    const parts = await drain(next.stream);
    expect(parts.some((p) => p.type === "text-delta" && p.delta.includes("ok"))).toBe(true);
    expect(fake.requests.map((r) => [r.thread, r.status])).toEqual([
      ["T1", 200],
      ["T1", 200],
    ]);
  });

  it("a 409 that still comes is retried, then reported", async () => {
    let calls = 0;
    await expect(
      retryConflict(
        async () => {
          calls += 1;
          throw new ClimateClawError("busy", 409);
        },
        { attempts: 3, delayMs: 1 },
      ),
    ).rejects.toThrow("busy");
    expect(calls).toBe(3);
  });
});

describe("a fork", () => {
  it("moves the reply's cells, its notebook and its stop to the new thread", async () => {
    const fake = server();
    const activity = new ActivityStore();
    const followed: string[] = [];
    const cell = { notebook: "chat.ipynb", number: 1, jump: () => undefined };
    fake.script(() => [
      line("ServerHint", { thread_id: "T1" }),
      line("Assistant", "before"),
      line("ServerHint", { thread_id: "T9" }),
      line("Assistant", "after"),
    ]);
    const sink: CodeSink = {
      partial: () => null,
      code: () => null,
      output: () => undefined,
      image: () => undefined,
      follow: (thread) => void followed.push(thread),
    };
    const stop = new AbortController();
    const gate = new ThreadGate();
    const { stream } = await chatModel(fake, {
      activity,
      gate,
      codeSink: (thread: string) => {
        // Its first cell, written once the reply has started.
        queueMicrotask(() => activity.addCell(thread, cell));
        return sink;
      },
    }).doStream({ prompt: [user("q")], abortSignal: stop.signal });
    await readSome(stream, 6);
    expect(followed).toEqual(["T9"]);
    expect(activity.cells("T9")).toEqual([cell]);
    expect(activity.cells("T1")).toEqual([]);
    // The stop goes to the thread the reply is on now, which stays held until it ended.
    stop.abort();
    await tick(5);
    expect(fake.stops).toEqual(["T9"]);
    expect(gate.busy("T9")).toBe(true);
  });

  it("a running Run at DKRZ job stops the thread it was moved to", () => {
    const jobs = new RunAndFixJobs<object, object>();
    const job = jobs.reserve({ notebook: {}, cell: {} }, "1/0")!;
    job.threadId = "T1";
    job.state = "running";
    expect(jobs.follow(job, "T2")).toBe(true);
    expect(jobs.follow(job, "T2")).toBe(false);
    expect(jobs.stop(job)).toEqual({ kind: "wait", threadId: "T2" });
  });
});

describe("the thread gate", () => {
  it("lets a request through only when every hold on its thread has settled", async () => {
    const gate = new ThreadGate();
    let release: () => void = () => undefined;
    gate.hold("T", new Promise<void>((r) => (release = r)));
    gate.hold("T", tick(10));
    let through = false;
    const waiting = gate.wait("T").then(() => (through = true));
    await tick(20);
    expect(through).toBe(false);
    release();
    await waiting;
    expect(gate.busy("T")).toBe(false);
  });
});

describe("typing code into a cell", () => {
  function cell(initial = "") {
    let source = initial;
    return {
      getSource: () => source,
      setSource: (v: string) => (source = v),
      updateSource: (start: number, end: number, v: string) =>
        (source = source.slice(0, start) + v + source.slice(end)),
      edit: (v: string) => (source = v),
    };
  }

  it("types the code while the cell is untouched", () => {
    const target = cell();
    const write = guardedWriter(target, () => undefined);
    write("imp", 0);
    write("import xarray", 3);
    expect(target.getSource()).toBe("import xarray");
  });

  it("stops at the user's first edit and keeps it (no insert at a stale offset)", async () => {
    const target = cell();
    let edited = 0;
    const typist = new Typist(1);
    typist.attach(guardedWriter(target, () => (edited += 1)));
    typist.update("import xarray as xr\nds = xr.open_dataset('a.nc')", true);
    await tick(5);
    const mid = target.getSource();
    target.edit(`# mine\n${mid}`);
    await tick(30);
    typist.flush();
    expect(target.getSource()).toBe(`# mine\n${mid}`);
    expect(edited).toBe(1);
  });
});

describe("a figure the code saved", () => {
  const output = line("CodeOutput", {
    stdout: "",
    error: "",
    created_files: [
      { path: "map.png", mime_type: "image/png", preview_url: "https://w.example/p/map.png" },
    ],
  });

  it("goes to its cell when code goes to the notebook (it is never streamed)", async () => {
    const fake = server();
    fake.script(() => [
      line("Code", '{"code": "plt.savefig(1)"}'),
      // One network chunk: the output and the text after it arrive together.
      output + line("Assistant", "Saved."),
      END,
    ]);
    const shown: Array<[string, string | null]> = [];
    const sink: CodeSink = {
      partial: () => null,
      code: () => ({ number: 1, notebook: "Chat.ipynb", cellId: "c1" }),
      output: () => undefined,
      image: () => undefined,
      savedFigure: (_id, figure, base64) => void shown.push([figure.name, base64]),
    };
    const parts = await drain(
      (
        await chatModel(fake, {
          codeSink: () => sink,
          fetchFigure: async () => "QUJD",
        }).doStream({ prompt: [user("plot")] })
      ).stream,
    );
    expect(shown).toEqual([["map.png", "QUJD"]]);
    const reply = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    // One card for the run, the figure in it, before the text that follows.
    const card = reply.indexOf('<div class="jp-ClimateClaw-run"');
    expect(card).toBeGreaterThanOrEqual(0);
    expect(reply.indexOf("data:image/png;base64,QUJD")).toBeGreaterThan(card);
    expect(reply.indexOf("data:image/png;base64,QUJD")).toBeLessThan(reply.indexOf("Saved."));
    expect(reply).toContain("jp-ClimateClaw-cell-c1");
    expect(reply.match(/<details class="jp-ClimateClaw-runCode"/g)).toHaveLength(1);
  });

  it("shows in the chat otherwise: embedded when read, else by its address", async () => {
    const fake = server();
    fake.script(() => [output, END]);
    const text = async (base64: string | null) =>
      (
        await drain(
          (
            await chatModel(fake, { fetchFigure: async () => base64 }).doStream({
              prompt: [user("plot")],
            })
          ).stream,
        )
      )
        .filter((p) => p.type === "text-delta")
        .map((p) => (p as { delta: string }).delta)
        .join("");
    expect(await text("QUJD")).toContain("![map.png](data:image/png;base64,QUJD)");
    expect(await text(null)).toContain("![map.png](https://w.example/p/map.png)");
  });
});

describe("Run at DKRZ, its connection cut before DKRZ confirmed", () => {
  /**
   * A thread runs until a stop takes effect, 300 ms after it is asked for; meanwhile the stopped
   * job's connection closes cleanly without a StreamEnd (a proxy, a network blip).
   */
  function dkrz() {
    const busy = new Set<string>();
    const requests: Array<{ thread: string; status: number }> = [];
    let threads = 0;
    let cut: () => void = () => undefined;
    const fetch = async (input: string, init: RequestInit = {}) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (input.endsWith("/newthread")) return Response.json(`T${(threads += 1)}`);
      if (input.endsWith("/stop")) {
        setTimeout(() => busy.delete(body.thread_id), 300);
        return Response.json({ detail: "stopping" });
      }
      const thread = body.thread_id as string;
      if (busy.has(thread)) {
        requests.push({ thread, status: 409 });
        return Response.json({ detail: "busy" }, { status: 409 });
      }
      requests.push({ thread, status: 200 });
      busy.add(thread);
      const first = requests.length === 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            if (!first) {
              busy.delete(thread);
              // The next job's cell runs (a run with its output: the evidence it ran).
              const ran =
                `${JSON.stringify({ variant: "Code", content: JSON.stringify({ code: body.input.split("```python\n").pop().split("\n```")[0] }), id: "c1" })}\n` +
                `${JSON.stringify({ variant: "CodeOutput", content: { stdout: "ran\n", error: "" }, id: "c1" })}\n`;
              controller.enqueue(enc.encode(ran + line("Assistant", "ran") + END));
              controller.close();
              return;
            }
            controller.enqueue(enc.encode(line("Assistant", "working")));
            // Closed later, without a StreamEnd: the server still runs.
            cut = () => controller.close();
          },
        }),
      );
    };
    return { fetch, requests, cut: () => cut() };
  }

  function runnerFor(fake: ReturnType<typeof dkrz>) {
    const api = new ClimateClawApi("https://freva.example/api/chatbot", fake.fetch);
    const jobs = new RunAndFixJobs<object, object>();
    const bound = new Map<object, string | null>();
    const written: string[] = [];
    const runner = new RunAtDkrzRunner<object, object>({
      api: () => api,
      gate: new ThreadGate(),
      jobs,
      sessionOf: (n) => n,
      threadOf: (n) => bound.get(n) ?? null,
      commitThread: (n, t) => void bound.set(n, t),
      abandon: (n, t) => {
        if (bound.get(n) === t) bound.set(n, null);
      },
      write: (_job, outputs) =>
        outputs.forEach((o) => {
          const out = o as { text?: string; evalue?: string };
          written.push(String(out.text ?? out.evalue ?? ""));
        }),
      offer: () => undefined,
      changed: () => undefined,
      settleMs: 10,
      retry: { attempts: 3, delayMs: 5 },
    });
    return { api, jobs, runner, written };
  }

  it("without a Stop it is no success: the next job takes a new thread (no 409)", async () => {
    const fake = dkrz();
    const { jobs, runner, written } = runnerFor(fake);
    const notebook = {};
    const first = jobs.reserve({ notebook, cell: { id: "a" } }, "slow()")!;
    const second = jobs.reserve({ notebook, cell: { id: "b" } }, "next()")!;
    const one = jobs.schedule(first, () => runner.run(first, "m"));
    const two = jobs.schedule(second, () => runner.run(second, "m"));
    await vi.waitFor(() => expect(first.state).toBe("running"));
    fake.cut();
    await Promise.all([one, two]);
    expect(first.state).toBe("failed");
    expect(written.some((t) => t.includes("connection ended before DKRZ"))).toBe(true);
    expect(second.state).toBe("finished");
    expect(second.threadId).toBe("T2");
    expect(fake.requests.filter((r) => r.status === 409)).toEqual([]);
  });

  it("the next job takes a new thread, and is never refused (409)", async () => {
    const fake = dkrz();
    const api = new ClimateClawApi("https://freva.example/api/chatbot", fake.fetch);
    const jobs = new RunAndFixJobs<object, object>();
    const notebook = {};
    const bound = new Map<object, string | null>();
    const written: string[] = [];
    const runner = new RunAtDkrzRunner<object, object>({
      api: () => api,
      gate: new ThreadGate(),
      jobs,
      sessionOf: (n) => n,
      threadOf: (n) => bound.get(n) ?? null,
      commitThread: (n, t) => void bound.set(n, t),
      abandon: (n, t) => {
        if (bound.get(n) === t) bound.set(n, null);
      },
      write: (_job, outputs) =>
        outputs.forEach((o) => written.push(String((o as { text?: string }).text ?? ""))),
      offer: () => undefined,
      changed: () => undefined,
      settleMs: 10,
      retry: { attempts: 3, delayMs: 5 },
    });
    const first = jobs.reserve({ notebook, cell: { id: "a" } }, "slow()")!;
    const second = jobs.reserve({ notebook, cell: { id: "b" } }, "next()")!;
    const one = jobs.schedule(first, () => runner.run(first, "m"));
    const two = jobs.schedule(second, () => runner.run(second, "m"));
    await vi.waitFor(() => expect(first.state).toBe("running"));
    // Stop, then the connection is cut before the server confirms.
    expect(jobs.stop(first)).toMatchObject({ kind: "wait", threadId: "T1" });
    void api.stop("T1");
    fake.cut();
    await Promise.all([one, two]);
    expect(first.state).toBe("stopped");
    expect(written.some((t) => t.includes("did not confirm"))).toBe(true);
    expect(second.state).toBe("finished");
    expect(second.threadId).toBe("T2");
    expect(fake.requests.filter((r) => r.status === 409)).toEqual([]);
  });
});
