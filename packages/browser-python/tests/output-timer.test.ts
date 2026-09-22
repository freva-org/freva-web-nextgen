/**
 * Output has to appear while Python is still waiting, not only when it writes again.
 *
 * The batch is flushed on size, on a stream change, on any other message, and on a clock
 * comparison made DURING A WRITE. That last one is the hole - if nothing writes again, nothing
 * compares clocks - and it is the shape of every interactive prompt:
 *
 *     print("Open the verification URL and enter the code")
 *     await asyncio.sleep(0.3)          # ...and the print is still in the buffer
 *
 * The device-authentication flow is unusable that way. So there is a real timer, with the rules a
 * timer needs: one at a time, cancelled on every other flush path, and never able to fire into an
 * execution it does not belong to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutputBridge, TEXT_FLUSH_CHARS, TEXT_FLUSH_MS } from "../src/worker/output.js";
import type { WorkerMessage } from "../src/protocol.js";

function bridge() {
  const messages: WorkerMessage[] = [];
  const out = new OutputBridge((message) => void messages.push(message));
  return { out, messages };
}

const timers = () => vi.getTimerCount();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("a batch flushes on its own", () => {
  it("flushes text nobody follows up, after the flush interval", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.stdout("Open the verification URL and enter WXYZ-1234\n");
    expect(messages).toHaveLength(0);

    vi.advanceTimersByTime(TEXT_FLUSH_MS + 1);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { text: string }).text).toContain("WXYZ-1234");
    expect((messages[0] as { executionId: string }).executionId).toBe("e1");
  });

  it("does not flush early", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.stdout("waiting\n");
    vi.advanceTimersByTime(TEXT_FLUSH_MS - 1);
    expect(messages).toHaveLength(0);
  });

  it("schedules ONE timer for a batch, not one per write", () => {
    const { out } = bridge();
    out.beginExecution("e1");
    for (let i = 0; i < 50; i += 1) out.stdout(`line ${i}\n`);
    expect(timers()).toBe(1);
  });

  it("leaves no timer behind once the batch is gone", () => {
    const { out } = bridge();
    out.beginExecution("e1");
    out.stdout("a\n");
    expect(timers()).toBe(1);
    vi.advanceTimersByTime(TEXT_FLUSH_MS + 1);
    expect(timers()).toBe(0);
  });

  it("cancels the timer when something else flushes first", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.stdout("a\n");
    out.result("42"); // flushes the batch on its way out
    expect(timers()).toBe(0);
    vi.advanceTimersByTime(TEXT_FLUSH_MS * 4);
    expect(messages.filter((m) => m.kind === "stdout")).toHaveLength(1);
  });

  it("cancels the timer at the end of an execution", () => {
    const { out } = bridge();
    out.beginExecution("e1");
    out.stdout("a\n");
    out.endExecution();
    expect(timers()).toBe(0);
  });

  it("a stream change cancels the old timer and starts one for the new batch", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.stdout("out\n");
    out.stderr("err\n");
    expect(timers()).toBe(1);
    vi.advanceTimersByTime(TEXT_FLUSH_MS + 1);
    expect(messages.map((m) => m.kind)).toEqual(["stdout", "stderr"]);
    expect(timers()).toBe(0);
  });

  it("an old execution's timer cannot flush into a later one", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.stdout("belongs to e1\n");
    out.beginExecution("e2"); // flushes e1's batch and cancels its timer
    out.stdout("belongs to e2\n");
    vi.advanceTimersByTime(TEXT_FLUSH_MS + 1);
    expect(
      messages.map((m) => [
        (m as { executionId: string }).executionId,
        (m as { text: string }).text,
      ]),
    ).toEqual([
      ["e1", "belongs to e1\n"],
      ["e2", "belongs to e2\n"],
    ]);
  });

  it("still flushes synchronously on size, without waiting for any timer", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.stdout("x".repeat(TEXT_FLUSH_CHARS + 1));
    expect(messages).toHaveLength(1);
    expect(timers()).toBe(0);
  });

  it("a tight print loop still batches rather than emitting per line", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    for (let i = 0; i < 500; i += 1) out.stdout(`line ${i}\n`);
    out.endExecution();
    expect(messages.length).toBeLessThan(20);
  });

  it("background output flushes on its own too, with no execution to end it", () => {
    const { out, messages } = bridge();
    out.beginExecution("e1");
    out.endExecution();
    out.stdout("from a __del__\n");
    vi.advanceTimersByTime(TEXT_FLUSH_MS + 1);
    expect(messages).toHaveLength(1);
    expect("background" in messages[0]!).toBe(true);
  });
});
