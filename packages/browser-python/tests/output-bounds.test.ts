/**
 * What the worker is allowed to send the page, and how much of it. Two separate failures. Volume:
 * `for i in range(200_000): print(i)` is 200,000 `postMessage` calls, one per `write()`, each
 * with its own structured clone, event dispatch and consumer render. Total size: with nothing
 * bounding a single execution, a runaway loop or two hundred figures grows the page's memory
 * until the tab dies, which to the person who ran it looks like Python crashing. The rule: text
 * is batched but never reordered, both text and displays are bounded per execution, exceeding a
 * bound costs exactly one honest notice, and the interpreter is still usable afterwards.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { OutputBridge, TEXT_FLUSH_CHARS, TEXT_FLUSH_MS } from "../src/worker/output.js";
import {
  MAX_EXECUTION_DISPLAY_CHARS,
  MAX_EXECUTION_TEXT_CHARS,
  type WorkerMessage,
} from "../src/protocol.js";

function bridge() {
  const messages: WorkerMessage[] = [];
  const out = new OutputBridge((message) => void messages.push(message));
  const kinds = () => messages.map((m) => m.kind);
  const text = (kind: "stdout" | "stderr") =>
    messages
      .filter((m) => m.kind === kind)
      .map((m) => (m as { text: string }).text)
      .join("");
  return { out, messages, kinds, text };
}

/** A base64 display payload of a given encoded length. */
const png = (chars: number) => ({
  mime: "image/png",
  encoding: "base64",
  data: "A".repeat(chars),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("batching", () => {
  it("coalesces consecutive writes instead of one message per print", () => {
    const { out, messages, text } = bridge();
    out.beginExecution("e1");
    for (let i = 0; i < 500; i += 1) out.stdout(`line ${i}\n`);
    out.endExecution();
    expect(messages.length).toBeLessThan(20);
    expect(text("stdout")).toContain("line 0\nline 1\n");
    expect(text("stdout").endsWith("line 499\n")).toBe(true);
  });

  it("flushes pending text BEFORE a result, so the result never overtakes its own output", () => {
    const { out, kinds } = bridge();
    out.beginExecution("e1");
    out.stdout("computing\n");
    out.result("42");
    expect(kinds()).toEqual(["stdout", "result"]);
  });

  it("flushes pending text before a display", () => {
    const { out, kinds } = bridge();
    out.beginExecution("e1");
    out.stdout("plotting\n");
    out.display(png(64));
    expect(kinds()).toEqual(["stdout", "display"]);
  });

  it("flushes pending stdout before stderr - the two streams keep their relative order", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.stdout("first\n");
    out.stderr("warning\n");
    out.stdout("second\n");
    out.endExecution();
    expect(messages.map((m) => [m.kind, (m as { text: string }).text])).toEqual([
      ["stdout", "first\n"],
      ["stderr", "warning\n"],
      ["stdout", "second\n"],
    ]);
  });

  it("flushes on its own once the buffer is large, so a long loop is not silent", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    const chunk = "x".repeat(1024);
    for (let i = 0; i < TEXT_FLUSH_CHARS / 1024 + 2; i += 1) out.stdout(chunk);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("flushes on elapsed time, so a slow loop's output still arrives while it runs", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.stdout("tick\n");
    expect(messages).toHaveLength(0);
    vi.setSystemTime(TEXT_FLUSH_MS + 1);
    out.stdout("tock\n");
    expect(messages).toHaveLength(1);
    expect((messages[0] as { text: string }).text).toBe("tick\ntock\n");
  });

  it("attributes a batch to the execution that produced it", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.stdout("a");
    out.endExecution();
    out.stdout("from a __del__");
    out.beginExecution("e2");
    out.stdout("b");
    out.endExecution();
    expect(
      messages.map((m) => [(m as { executionId: string }).executionId, "background" in m]),
    ).toEqual([
      ["e1", false],
      ["e1", true],
      ["e2", false],
    ]);
  });
});

describe("text bounds", () => {
  const overflow = () => "y".repeat(MAX_EXECUTION_TEXT_CHARS + 4096);

  it("stops after the per-execution limit and says exactly how much was omitted, once", () => {
    const { out, messages, text } = bridge();
    out.beginExecution("e1");
    out.stdout(overflow());
    out.stdout(overflow());
    out.stdout(overflow());
    out.endExecution();
    expect(text("stdout").length).toBeLessThanOrEqual(MAX_EXECUTION_TEXT_CHARS);
    const notices = messages.filter((m) => (m as { text?: string }).text?.includes("output limit"));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe("stderr");
    expect((notices[0] as { text: string }).text).toMatch(/omitted/);
  });

  it("keeps the beginning of the output, which is where the traceback is", () => {
    const { out, text } = bridge();
    out.beginExecution("e1");
    out.stdout("THE FIRST LINE\n");
    out.stdout(overflow());
    out.endExecution();
    expect(text("stdout").startsWith("THE FIRST LINE\n")).toBe(true);
  });

  it("the next execution starts with a full budget - one runaway loop does not mute the console", () => {
    const { out, text } = bridge();
    out.beginExecution("e1");
    out.stdout(overflow());
    out.endExecution();
    out.beginExecution("e2");
    out.stdout("still here\n");
    out.endExecution();
    expect(text("stdout").endsWith("still here\n")).toBe(true);
  });

  it("announces the limit while the execution is still running, not only when it ends", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.stdout(overflow());
    vi.setSystemTime(2000);
    out.stdout("more that will be dropped");
    const notice = messages.find((m) => (m as { text?: string }).text?.includes("output limit"));
    expect(notice).toBeDefined();
  });

  it("bounds background output too, and does not wait for an execution that never ends", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.endExecution();
    out.stdout(overflow());
    vi.setSystemTime(2000);
    out.stdout("dropped");
    const notice = messages.find((m) => (m as { text?: string }).text?.includes("output limit"));
    expect(notice).toBeDefined();
    expect("background" in notice!).toBe(true);
  });
});

describe("display bounds", () => {
  it("bounds the TOTAL display bytes one execution may push, not just one payload", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    const each = 4 * 1024 * 1024;
    const enough = Math.ceil(MAX_EXECUTION_DISPLAY_CHARS / each) + 2;
    for (let i = 0; i < enough; i += 1) out.display(png(each));
    const displays = messages.filter((m) => m.kind === "display");
    expect(displays.length).toBeLessThan(enough);
    expect(displays.length * each).toBeLessThanOrEqual(MAX_EXECUTION_DISPLAY_CHARS);
  });

  it("explains a refused display once per execution and leaves the interpreter usable", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    const each = 4 * 1024 * 1024;
    for (let i = 0; i < Math.ceil(MAX_EXECUTION_DISPLAY_CHARS / each) + 5; i += 1) {
      out.display(png(each));
    }
    const notices = messages.filter((m) =>
      (m as { text?: string }).text?.includes("display output limit"),
    );
    expect(notices).toHaveLength(1);
    out.result("ok");
    expect(messages.at(-1)!.kind).toBe("result");
  });

  it("gives the next execution a fresh display budget", () => {
    const { out, messages } = bridge();
    const each = 4 * 1024 * 1024;
    out.beginExecution("e1");
    for (let i = 0; i < Math.ceil(MAX_EXECUTION_DISPLAY_CHARS / each) + 2; i += 1) {
      out.display(png(each));
    }
    out.endExecution();
    const before = messages.filter((m) => m.kind === "display").length;
    out.beginExecution("e2");
    out.display(png(1024));
    expect(messages.filter((m) => m.kind === "display")).toHaveLength(before + 1);
  });

  it("still refuses one oversized payload with a single stderr line", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.display(png(64 * 1024 * 1024));
    expect(messages.filter((m) => m.kind === "display")).toHaveLength(0);
    const stderr = messages.filter((m) => m.kind === "stderr");
    expect(stderr).toHaveLength(1);
    expect((stderr[0] as { text: string }).text).toContain("MiB limit");
  });
});
