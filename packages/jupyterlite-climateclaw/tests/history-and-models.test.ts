/** Conversations per account, new chats' names, the default model and day groups. */
// Berlin, where the clocks change on 25/26 October and 29/30 March 2026 (set before any Date).
process.env.TZ = "Europe/Berlin";

import { describe, expect, it } from "vitest";

import type { StoredThreadSummary } from "../src/api.js";
import { AccountThreads, groupThreads, threadTime } from "../src/conversations-model.js";
import { isNotFound, newChatName, randomId } from "../src/history.js";
import { reconcileModels } from "../src/models.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const thread = (id: string): StoredThreadSummary => ({
  threadId: id,
  topic: `Topic ${id}`,
  date: "2026-10-04T08:00:00Z",
});

describe("AccountThreads", () => {
  it("a load for account A that lands after B signed in is dropped; B gets its own request", async () => {
    const requests: Array<{ account: string; reply: ReturnType<typeof deferred<unknown>> }> = [];
    let account = "A";
    const threads = new AccountThreads(async () => {
      const reply = deferred<unknown>();
      requests.push({ account, reply });
      return reply.promise as Promise<{ threads: StoredThreadSummary[]; total: number }>;
    });
    const a = threads.load(true);
    // Sign-out, then B signs in, while A's request is out.
    account = "B";
    threads.reset();
    const b = threads.load(true);
    expect(requests.map((r) => r.account)).toEqual(["A", "B"]);
    requests[0]!.reply.resolve({ threads: [thread("a1")], total: 1 });
    await a;
    expect(threads.pages.threads).toEqual([]);
    requests[1]!.reply.resolve({ threads: [thread("b1")], total: 1 });
    await b;
    expect(threads.pages.threads.map((t) => t.threadId)).toEqual(["b1"]);
  });

  it("a reload asked for during a load runs after it, with what changed meanwhile", async () => {
    const server = [thread("t1")];
    const replies: Array<ReturnType<typeof deferred<void>>> = [];
    const threads = new AccountThreads(async () => {
      const gate = deferred<void>();
      replies.push(gate);
      const snapshot = [...server];
      await gate.promise;
      return { threads: snapshot, total: snapshot.length };
    });
    void threads.load(true);
    // A new conversation is created while the first load is out: it must not be lost.
    server.unshift(thread("t2"));
    void threads.load(true);
    expect(replies.length).toBe(1);
    replies[0]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(replies.length).toBe(2);
    replies[1]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(threads.pages.threads.map((t) => t.threadId)).toEqual(["t2", "t1"]);
    expect(threads.loading).toBe(false);
  });

  it("keeps a failure's reason until the next load", async () => {
    let fail = true;
    const threads = new AccountThreads(async () => {
      if (fail) throw new Error("503 Service Unavailable");
      return { threads: [thread("t1")], total: 1 };
    });
    await threads.load(true);
    expect(threads.error).toMatch(/503/);
    fail = false;
    await threads.load(true);
    expect(threads.error).toBeNull();
    expect(threads.pages.threads.length).toBe(1);
  });
});

describe("new chats", () => {
  it("get a name of their own: the time, and a random part", () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{6}$/);
    expect(newChatName("14:32", "k3x9ab")).toBe("ClimateClaw 14:32 k3x9ab");
  });
  it("only a confirmed not-found counts as no backup", () => {
    expect(isNotFound({ response: { status: 404 } })).toBe(true);
    expect(isNotFound({ response: { status: 503 } })).toBe(false);
    expect(isNotFound(new Error("network"))).toBe(false);
  });
});

describe("the default model", () => {
  it("a first entry takes a served model when the configured one is retired", () => {
    const next = reconcileModels([], ["gpt-5", "gpt-5-mini"], "gpt-4-retired", "ClimateClaw");
    expect(next?.find((p) => p.id === "climateclaw")?.model).toBe("gpt-5");
    expect(next?.map((p) => p.model)).toEqual(["gpt-5", "gpt-5-mini"]);
  });
  it("a first entry keeps the configured model when it is served, or the list is unknown", () => {
    expect(reconcileModels([], ["gpt-5", "gpt-test"], "gpt-test", "ClimateClaw")?.[0]?.model).toBe(
      "gpt-test",
    );
    expect(reconcileModels([], [], "gpt-test", "ClimateClaw")?.[0]?.model).toBe("gpt-test");
  });
});

describe("Yesterday across a clock change", () => {
  it("25 October is yesterday on 26 October in Berlin (a 25-hour day)", () => {
    // The clock change is really there in this process.
    expect(new Date(2026, 9, 25).getTimezoneOffset()).not.toBe(
      new Date(2026, 9, 26).getTimezoneOffset(),
    );
    const now = new Date(2026, 9, 26, 9, 0);
    const late = new Date(2026, 9, 25, 0, 30).toISOString();
    expect(groupThreads([{ threadId: "x", topic: "x", date: late }], now)[0]!.label).toBe(
      "Yesterday",
    );
    expect(threadTime(late, now, "en-GB")).toMatch(/^Yesterday, /);
    const before = new Date(2026, 9, 24, 23, 30).toISOString();
    expect(groupThreads([{ threadId: "y", topic: "y", date: before }], now)[0]!.label).toBe(
      "Earlier",
    );
  });
  it("and on 30 March after the spring change (a 23-hour day)", () => {
    const now = new Date(2026, 2, 30, 0, 10);
    const early = new Date(2026, 2, 29, 0, 5).toISOString();
    expect(groupThreads([{ threadId: "x", topic: "x", date: early }], now)[0]!.label).toBe(
      "Yesterday",
    );
  });
});
