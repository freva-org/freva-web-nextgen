// Ratings and versions name server positions carried by the replies, never chat positions.
import { describe, expect, it } from "vitest";

import { ThreadPages } from "../src/conversations-model.js";
import {
  BranchStore,
  FeedbackStore,
  copyableText,
  feedbackIndex,
  messageTime,
  ratingOf,
  storedTurn,
} from "../src/reply-actions.js";
import { scopeNoteMarkdown } from "../src/model.js";
import { threadMarker, turnMarker } from "../src/threads.js";

const variants = () => [
  { variant: "User", content: "q0" },
  { variant: "Assistant", content: "a0" },
  { variant: "User", content: "q1" },
  { variant: "Code", content: "{}" },
  { variant: "CodeOutput", content: "1" },
  { variant: "Assistant", content: "a1", feedback: "down" },
];

describe("feedback positions", () => {
  it("rates a reply at its last Assistant or Code variant, counted as the server counts", () => {
    expect(feedbackIndex(variants(), 0)).toBe(0);
    expect(feedbackIndex(variants(), 1)).toBe(2);
    expect(feedbackIndex(variants(), 2)).toBeNull();
    expect(ratingOf(variants(), 1)).toBe("down");
    expect(ratingOf(variants(), 0)).toBeNull();
  });

  it("finds a message's stored turn in the reply's marker, not by counting chat messages", () => {
    const bot = { username: "cc", bot: true };
    const you: { username: string; bot?: boolean } = { username: "user" };
    const messages = [
      // A question that failed before it reached the server: not counted anywhere.
      { id: "x", body: "lost", sender: you },
      { id: "u", body: "q0", sender: you },
      { id: "a", body: `${threadMarker("T")}\na0\n${turnMarker("T", 0)}`, sender: bot },
      { id: "u2", body: "unanswered", sender: you },
    ];
    expect(storedTurn(messages, "a")).toEqual({ thread: "T", index: 0 });
    expect(storedTurn(messages, "u")).toEqual({ thread: "T", index: 0 });
    expect(storedTurn(messages, "x")).toBeNull();
    expect(storedTurn(messages, "u2")).toBeNull();
  });

  it("saves a rating at the reply's index, takes it back, and shows it at once", async () => {
    const stored = variants();
    const sent: unknown[] = [];
    const api = {
      thread: async () => stored,
      feedback: async (...args: unknown[]) => void sent.push(args),
    };
    const store = new FeedbackStore(() => api as never);
    await store.rate("T", 0, "up");
    expect(sent).toEqual([["T", 0, "up"]]);
    expect(store.rating("T", 0)).toBe("up");
    await store.rate("T", 1, null);
    expect(sent.at(-1)).toEqual(["T", 2, "remove"]);
    expect(store.rating("T", 1)).toBeNull();
    await expect(store.rate("T", 5, "up")).rejects.toThrow("not stored");
  });
});

describe("versions of an edited message", () => {
  it("groups the branches made at one question, in order, kept across reloads", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
    };
    const store = new BranchStore(storage);
    store.add("T1", 2, "B1");
    store.add("B1", 2, "B2");
    store.add("T1", 0, "C1");
    const again = new BranchStore(storage);
    expect(again.versions("B1", 2)).toEqual({ threads: ["T1", "B1", "B2"], index: 1 });
    expect(again.versions("T1", 0)).toEqual({ threads: ["T1", "C1"], index: 0 });
    expect(again.versions("T1", 1)).toBeNull();
  });
});

describe("history", () => {
  it("a reload keeps the list on screen until the new one is complete", async () => {
    let release!: () => void;
    let calls = 0;
    const pages = new ThreadPages(async () => {
      calls += 1;
      if (calls > 1) await new Promise<void>((resolve) => (release = resolve));
      return { threads: [{ threadId: `t${calls}`, topic: "x", date: "" }], total: 1 };
    });
    await pages.more();
    const reload = pages.reload();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pages.threads.map((t) => t.threadId)).toEqual(["t1"]);
    expect(pages.loaded).toBe(true);
    release();
    await reload;
    expect(pages.threads.map((t) => t.threadId)).toEqual(["t2"]);
  });

  it("renames and deletions show at once", async () => {
    const pages = new ThreadPages(async () => ({
      threads: [
        { threadId: "a", topic: "A", date: "" },
        { threadId: "b", topic: "B", date: "" },
      ],
      total: 2,
    }));
    await pages.more();
    pages.rename("a", "Renamed");
    pages.remove("b");
    expect(pages.threads).toEqual([{ threadId: "a", topic: "Renamed", date: "" }]);
    expect(pages.total).toBe(1);
  });
});

describe("copy and time", () => {
  it("copies markdown without markers or chips, and code as it is", () => {
    const body = [
      "Here is the map.",
      '<span class="jp-ClimateClaw-ran jp-ClimateClaw-cell-x" title="t"><span class="jp-ClimateClaw-ran-at">DKRZ</span> <span class="jp-ClimateClaw-ran-cell">Cell 1</span></span> <span class="jp-ClimateClaw-outcome jp-mod-ok" title="o">✓ ran · output</span> <a class="jp-ClimateClaw-outcome jp-mod-figure" href="https://x/y.png">◩ figure</a>',
      "Ran <b>fine</b>.",
      "",
      "",
      "",
      "```python",
      "print(1 < 2) # <b>kept</b>",
      "```",
      "<!-- climateclaw:turn=t1/0 -->",
    ].join("\n");
    expect(copyableText(body)).toBe(
      "Here is the map.\n\nRan fine.\n\n```python\nprint(1 < 2) # <b>kept</b>\n```",
    );
  });

  it("leaves out the scope note of a first reply", () => {
    expect(copyableText(`${scopeNoteMarkdown("Use HEALPix.\nPrefer Zarr.")}The answer.`)).toBe(
      "The answer.",
    );
    const marked = `<!-- climateclaw:thread=t1 -->\n${scopeNoteMarkdown("Use HEALPix.")}The answer.`;
    expect(copyableText(marked)).toBe("The answer.");
  });

  it("dates a message by the clock today, then Yesterday, then the date", () => {
    const now = new Date(2026, 9, 4, 18, 0);
    const at = (d: Date) => d.getTime() / 1000;
    expect(messageTime(at(new Date(2026, 9, 4, 9, 5)), now, "en-GB")).toMatch(/^0?9:05$/);
    expect(messageTime(at(new Date(2026, 9, 3, 9, 5)), now, "en-GB")).toMatch(/^Yesterday 0?9:05$/);
    expect(messageTime(at(new Date(2026, 8, 30, 9, 5)), now, "en-GB")).toMatch(
      /^30 Sept?, 0?9:05$/,
    );
  });
});
