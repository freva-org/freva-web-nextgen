import type { LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { ClimateClawApi } from "../src/api.js";
import { ClimateClawModel, composeInput, type ModelContext } from "../src/model.js";
import { ThreadTable, branchMarker, threadMarker } from "../src/threads.js";

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/** A fake ClimateClaw: records calls, streams the given lines, one chunk per line part. */
function fakeServer(options: {
  stream?: string[];
  status?: number;
  newThread?: string;
  hold?: boolean;
}) {
  const calls: Call[] = [];
  let release: (() => void) | null = null;
  const fetch = async (input: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({
      url: input,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      headers,
    });
    if (input.endsWith("/newthread")) return Response.json(options.newThread ?? "thread-new");
    if (input.endsWith("/stop")) return Response.json({ detail: "Conversation stopped." });
    if (input.endsWith("/streamresponse")) {
      if (options.status) return Response.json({ detail: "nope" }, { status: options.status });
      const chunks = [...(options.stream ?? [])];
      const signal = init.signal;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) return controller.error(new DOMException("aborted", "AbortError"));
          const next = chunks.shift();
          if (next === undefined) {
            if (options.hold) {
              await new Promise<void>((resolve) => {
                release = resolve;
                signal?.addEventListener("abort", () => resolve());
              });
              return controller.error(new DOMException("aborted", "AbortError"));
            }
            return controller.close();
          }
          controller.enqueue(new TextEncoder().encode(next));
        },
      });
      return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetch, release: () => release?.() };
}

const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});
const assistant = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
});
const system = { role: "system" as const, content: "You are Jupyternaut, ..." };

function model(
  server: ReturnType<typeof fakeServer>,
  opts: {
    signedIn?: boolean;
    hideCode?: boolean;
    scopeNote?: string;
    threads?: ThreadTable;
  } & Omit<Partial<ModelContext>, "scopeNote" | "hideCode" | "threads"> = {},
) {
  const api = new ClimateClawApi("https://freva.example/api/chatbot", server.fetch);
  return new ClimateClawModel("gpt-test", {
    retry: { attempts: 3, delayMs: 1 },
    ...opts,
    api: () => api,
    signInProblem: () => (opts.signedIn === false ? "Sign in with Freva" : null),
    hideCode: () => opts.hideCode ?? false,
    scopeNote: () => opts.scopeNote ?? "",
    threads: opts.threads ?? new ThreadTable(),
  });
}

async function collect(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}
const text = (parts: LanguageModelV4StreamPart[]) =>
  parts
    .filter((p) => p.type === "text-delta")
    .map((p) => (p as { delta: string }).delta)
    .join("");

const END = '{"variant":"StreamEnd","content":"Stream ended."}\n';

describe("ClimateClawModel", () => {
  it("is an AI SDK v4 language model", () => {
    const m = model(fakeServer({}));
    expect(m.specificationVersion).toBe("v4");
    expect(m.provider).toBe("climateclaw");
    expect(m.modelId).toBe("gpt-test");
  });

  it("starts a thread, sends only the newest user message, marks the reply with the thread", async () => {
    const server = fakeServer({
      newThread: "T1",
      stream: [
        '{"variant":"ServerHint","content":{"thread_id":"T1"}}\n{"variant":"Assistant","content":"Hi"}\n',
        END,
      ],
    });
    const prompt: LanguageModelV4Prompt = [system, user("first question")];
    const { stream } = await model(server).doStream({ prompt });
    const parts = await collect(stream);
    const post = server.calls.find((c) => c.url.endsWith("/streamresponse"))!;
    expect(post.method).toBe("POST");
    expect(post.body).toEqual({ thread_id: "T1", input: "first question", chatbot: "gpt-test" });
    expect(post.headers["x-freva-rest-url"]).toBeUndefined();
    expect(text(parts)).toContain(threadMarker("T1"));
    expect(text(parts)).toContain("Hi");
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } });
  });

  it("continues the thread named in the history, without a new thread", async () => {
    const server = fakeServer({ stream: ['{"variant":"Assistant","content":"again"}\n', END] });
    const prompt: LanguageModelV4Prompt = [
      system,
      user("first"),
      assistant(`${threadMarker("T9")}\nanswer`),
      user("second"),
    ];
    const { stream } = await model(server).doStream({ prompt });
    await collect(stream);
    expect(server.calls.some((c) => c.url.endsWith("/newthread"))).toBe(false);
    expect(server.calls.find((c) => c.url.endsWith("/streamresponse"))!.body).toMatchObject({
      thread_id: "T9",
      input: "second",
    });
  });

  it("starts a new thread for a new or cleared chat (no marker in the history)", async () => {
    const threads = new ThreadTable();
    const server = fakeServer({ newThread: "T2", stream: [END] });
    await collect((await model(server, { threads }).doStream({ prompt: [user("q")] })).stream);
    const again = fakeServer({ newThread: "T3", stream: [END] });
    await collect((await model(again, { threads }).doStream({ prompt: [user("q")] })).stream);
    expect(again.calls.find((c) => c.url.endsWith("/streamresponse"))!.body).toMatchObject({
      thread_id: "T3",
    });
  });

  it("prepends the scope note to a new thread's first message only, and shows it", async () => {
    const note = "Answer about the nextGEMS data of this portal.";
    const first = fakeServer({ newThread: "T4", stream: [END] });
    const parts = await collect(
      (await model(first, { scopeNote: note }).doStream({ prompt: [user("hello")] })).stream,
    );
    expect(first.calls.find((c) => c.url.endsWith("/streamresponse"))!.body!.input).toBe(
      `${note}\n\nhello`,
    );
    expect(text(parts)).toContain("**Scope note**");
    expect(text(parts)).toContain(note);

    const second = fakeServer({ stream: [END] });
    const parts2 = await collect(
      (
        await model(second, { scopeNote: note }).doStream({
          prompt: [user("hello"), assistant(`${threadMarker("T4")}\nok`), user("more")],
        })
      ).stream,
    );
    expect(second.calls.find((c) => c.url.endsWith("/streamresponse"))!.body!.input).toBe("more");
    expect(text(parts2)).not.toContain("Scope note");
    expect(composeInput("x", false, note)).toBe("x");
  });

  it("remembers the thread when a stopped reply left no marker in the history", async () => {
    const threads = new ThreadTable();
    const server = fakeServer({ newThread: "T5", stream: [END] });
    await collect((await model(server, { threads }).doStream({ prompt: [user("a")] })).stream);
    // The agent keeps the user message of a stopped reply but no assistant text.
    const next = fakeServer({ stream: [END] });
    await collect(
      (await model(next, { threads }).doStream({ prompt: [user("a"), user("b")] })).stream,
    );
    expect(next.calls.find((c) => c.url.endsWith("/streamresponse"))!.body).toMatchObject({
      thread_id: "T5",
      input: "b",
    });
  });

  it("two chats that begin with the same words never share a thread", async () => {
    // One model per chat, as jupyterlite-ai creates them; the server changes per request.
    let server = fakeServer({});
    const api = new ClimateClawApi("https://freva.example/api/chatbot", (...args) =>
      server.fetch(...args),
    );
    const chat = () =>
      new ClimateClawModel("gpt-test", {
        api: () => api,
        signInProblem: () => null,
        hideCode: () => false,
        scopeNote: () => "",
      });
    const a = chat();
    const b = chat();
    const send = async (
      m: ClimateClawModel,
      prompt: Parameters<typeof m.doStream>[0]["prompt"],
      next: string,
    ) => {
      server = fakeServer({ newThread: next, stream: [END] });
      await collect((await m.doStream({ prompt })).stream);
      return server.calls.find((c) => c.url.endsWith("/streamresponse"))!.body!.thread_id;
    };
    // Both stopped before a marker was kept: only "Hello" is in either history.
    expect(await send(a, [user("Hello")], "TA")).toBe("TA");
    expect(await send(b, [user("Hello")], "TB")).toBe("TB");
    expect(await send(a, [user("Hello"), user("more")], "unused")).toBe("TA");
    expect(await send(b, [user("Hello"), user("more")], "unused")).toBe("TB");
  });

  it("follows a forked thread id from a ServerHint", async () => {
    const server = fakeServer({
      stream: ['{"variant":"ServerHint","content":{"thread_id":"FORK"}}\n', END],
    });
    const parts = await collect(
      (
        await model(server).doStream({
          prompt: [user("a"), assistant(threadMarker("OLD")), user("b")],
        })
      ).stream,
    );
    expect(text(parts)).toContain(threadMarker("FORK"));
  });

  it("sends POST /stop with the thread id on abort", async () => {
    const server = fakeServer({
      newThread: "T6",
      stream: ['{"variant":"Assistant","content":"partial"}\n'],
      hold: true,
    });
    const controller = new AbortController();
    const { stream } = await model(server).doStream({
      prompt: [user("long")],
      abortSignal: controller.signal,
    });
    const reader = stream.getReader();
    await reader.read(); // stream-start
    controller.abort();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    const stop = server.calls.find((c) => c.url.endsWith("/stop"));
    expect(stop).toBeDefined();
    expect(stop!.method).toBe("POST");
    expect(stop!.body).toEqual({ thread_id: "T6" });
  });

  it("turns server errors into error parts", async () => {
    const server = fakeServer({
      stream: ['{"variant":"ServerError","content":"kernel died"}\n', END],
    });
    const parts = await collect((await model(server).doStream({ prompt: [user("x")] })).stream);
    const error = parts.find((p) => p.type === "error") as { error: Error } | undefined;
    expect(error?.error.message).toContain("kernel died");
  });

  it("fails with the reason when signed out or the request is refused", async () => {
    await expect(
      model(fakeServer({}), { signedIn: false }).doStream({ prompt: [user("x")] }),
    ).rejects.toThrow("Sign in with Freva");
    // A thread that stays busy: retried, then the reason.
    const busy = fakeServer({ status: 409 });
    await expect(model(busy).doStream({ prompt: [user("x")] })).rejects.toThrow("HTTP 409");
    expect(busy.calls.filter((c) => c.url.endsWith("/streamresponse"))).toHaveLength(3);
  });

  it("answers title requests locally, without a request", async () => {
    const server = fakeServer({});
    const result = await model(server).doGenerate({
      prompt: [
        { role: "system", content: "Generate a concise title" },
        user(
          "user: Plot the global mean temperature from ERA5 for the year 2020 please now\nassistant: ok",
        ),
      ],
    });
    expect(server.calls).toEqual([]);
    expect(result.content).toEqual([
      { type: "text", text: "Plot the global mean temperature from ERA5 for the year" },
    ]);
  });

  it("an edited question goes to the branch it names; the marker is never sent", async () => {
    const server = fakeServer({ stream: ['{"variant":"Assistant","content":"branched"}\n', END] });
    const prompt: LanguageModelV4Prompt = [system, user(`q, better\n${branchMarker("B7")}`)];
    const parts = await collect((await model(server).doStream({ prompt })).stream);
    expect(server.calls.some((c) => c.url.endsWith("/newthread"))).toBe(false);
    expect(server.calls.find((c) => c.url.endsWith("/streamresponse"))!.body).toMatchObject({
      thread_id: "B7",
      input: "q, better",
    });
    // A branch with no reply yet: its reply marks the chat with it.
    expect(text(parts)).toContain(threadMarker("B7"));
  });

  it("the same words in another chat start a thread of their own", async () => {
    const server = fakeServer({ newThread: "T5", stream: [END] });
    await collect((await model(server).doStream({ prompt: [user("q, better")] })).stream);
    expect(server.calls.find((c) => c.url.endsWith("/streamresponse"))!.body).toMatchObject({
      thread_id: "T5",
    });
  });

  it("stopped as its thread is made: nothing is sent", async () => {
    const stop = new AbortController();
    const server = fakeServer({ newThread: "T6", stream: [END] });
    const api = new ClimateClawApi("https://freva.example/api/chatbot", async (input, init) => {
      const response = await server.fetch(input, init);
      // The stop lands just as the thread arrives.
      if (input.endsWith("/newthread")) stop.abort();
      return response;
    });
    const m = new ClimateClawModel("gpt-test", {
      api: () => api,
      signInProblem: () => null,
      hideCode: () => false,
      scopeNote: () => "",
      threads: new ThreadTable(),
    });
    await expect(
      m.doStream({ prompt: [user("q")], abortSignal: stop.signal }),
    ).rejects.toBeTruthy();
    expect(server.calls.some((c) => c.url.endsWith("/streamresponse"))).toBe(false);
  });
});
