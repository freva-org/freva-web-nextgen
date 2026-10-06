// ClimateClaw's HTTP API, as this extension uses it. Every request goes through the injected
// `fetch`, which is the Freva auth client's: it attaches the bearer to the Freva host only. The
// browser never sends `x-freva-rest-url`; the deployment's proxy sets it.

import { isThreadId } from "./stream.js";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class ClimateClawError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ClimateClawError";
  }
}

export interface StoredThreadSummary {
  threadId: string;
  topic: string;
  date: string;
}

async function failure(response: Response, what: string): Promise<ClimateClawError> {
  let detail = "";
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body?.detail === "string") detail = body.detail;
  } catch {
    detail = "";
  }
  const hint =
    response.status === 401
      ? "Your Freva sign-in was not accepted; sign in again."
      : response.status === 409
        ? "This conversation is still answering; wait for it or stop it."
        : detail || response.statusText || "request failed";
  return new ClimateClawError(`${what} failed (HTTP ${response.status}): ${hint}`, response.status);
}

/** How long Run at DKRZ waits for the server to take a stop before saying it did not. */
export const STOP_CONFIRM_MS = 8_000;
export class ClimateClawApi {
  constructor(
    private readonly base: string,
    private readonly fetch: Fetch,
  ) {}

  private url(path: string): string {
    return `${this.base}/${path}`;
  }

  private async json<T>(path: string, init: RequestInit, what: string): Promise<T> {
    const response = await this.fetch(this.url(path), init);
    if (!response.ok) throw await failure(response, what);
    return (await response.json()) as T;
  }

  /** Model names; the first is the server's default. */
  async availableChatbots(signal?: AbortSignal): Promise<string[]> {
    const list = await this.json<unknown>(
      "availablechatbots",
      { method: "GET", ...(signal ? { signal } : {}) },
      "Listing models",
    );
    return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : [];
  }

  /** ClimateClaw requires a thread id on every stream request. */
  async newThread(signal?: AbortSignal): Promise<string> {
    const id = await this.json<unknown>(
      "newthread",
      { method: "GET", ...(signal ? { signal } : {}) },
      "Starting a thread",
    );
    if (!isThreadId(id)) throw new ClimateClawError("ClimateClaw returned no thread id.", 502);
    return id;
  }

  /** POST /streamresponse; resolves to the ndjson response once headers arrive. */
  async streamResponse(
    body: { thread_id: string; input: string; chatbot?: string },
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetch(this.url("streamresponse"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await failure(response, "ClimateClaw");
    if (!response.body) throw new ClimateClawError("ClimateClaw sent no response body.", 502);
    return response;
  }

  /** Ask the server to stop a thread's stream. Best effort: a finished thread answers 404. */
  async stop(threadId: string): Promise<void> {
    try {
      await this.fetch(this.url("stop"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: threadId }),
      });
    } catch {
      // Nothing to do: the local stream is already cancelled.
    }
  }

  /**
   * Asks the server to stop a thread's stream, and says whether it took the request: true for an
   * answer it accepted (or 404, a thread that is not running), false for an error or no answer -
   * none within `timeoutMs`, or `signal` aborted first. It always settles.
   */
  async stopConfirmed(
    threadId: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<boolean> {
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), options.timeoutMs ?? STOP_CONFIRM_MS);
    const onAbort = () => giveUp.abort();
    options.signal?.addEventListener("abort", onAbort);
    if (options.signal?.aborted) giveUp.abort();
    const unanswered = new Promise<false>((resolve) => {
      if (giveUp.signal.aborted) resolve(false);
      giveUp.signal.addEventListener("abort", () => resolve(false));
    });
    const asked = this.fetch(this.url("stop"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: threadId }),
      signal: giveUp.signal,
    }).then(
      (response) => response.ok || response.status === 404,
      () => false,
    );
    try {
      return await Promise.race([asked, unanswered]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async userThreads(
    page: number,
    pageSize: number,
  ): Promise<{ threads: StoredThreadSummary[]; total: number }> {
    const result = await this.json<unknown>(
      "getuserthreads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ num_threads: pageSize, page }),
      },
      "Loading history",
    );
    const [rows, total] = Array.isArray(result) ? result : [[], 0];
    const threads = (Array.isArray(rows) ? rows : [])
      .map((row) => row as Record<string, unknown>)
      .filter((row) => isThreadId(row?.thread_id))
      .map((row) => ({
        threadId: row.thread_id as string,
        topic: typeof row.topic === "string" && row.topic.trim() ? row.topic.trim() : "Untitled",
        date: typeof row.date === "string" ? row.date : "",
      }));
    return { threads, total: typeof total === "number" ? total : threads.length };
  }

  private post(path: string, body: object, what: string): Promise<unknown> {
    return this.json<unknown>(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      what,
    );
  }

  /** Rate a reply: `index` counts the thread's Assistant and Code variants from 0. */
  async feedback(threadId: string, index: number, value: "up" | "down" | "remove"): Promise<void> {
    await this.post(
      "userfeedback",
      { thread_id: threadId, feedback_index: index, feedback: value },
      "Saving feedback",
    );
  }

  /** A new thread with the history before the `userIndex`-th user message (from 0). */
  async editThread(threadId: string, userIndex: number): Promise<string> {
    const result = (await this.post(
      "editthread",
      { source_thread_id: threadId, user_index: userIndex },
      "Editing the message",
    )) as { new_thread_id?: unknown } | null;
    const id = result?.new_thread_id;
    if (!isThreadId(id)) throw new ClimateClawError("ClimateClaw returned no thread id.", 502);
    return id;
  }

  async setTopic(threadId: string, topic: string): Promise<void> {
    await this.post("setthreadtopic", { thread_id: threadId, topic }, "Renaming the conversation");
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.post("deletethread", { thread_id: threadId }, "Deleting the conversation");
  }

  async thread(threadId: string): Promise<unknown[]> {
    const content = await this.json<unknown>(
      "getthread",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: threadId }),
      },
      "Opening the thread",
    );
    return Array.isArray(content) ? content : [];
  }
}
