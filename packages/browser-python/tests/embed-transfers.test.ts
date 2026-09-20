/**
 * A bridge transfer has ONE owner, from the moment a sink is acquired until it is settled.
 * Acquiring the sink and then constructing a `MessageChannel`, wiring it and posting the download
 * request outside any `try` leaves every one of those failures - a frame that navigated away
 * while the picker was open makes `post()` throw - with the caller's destination open, unaborted
 * and unreleased. The other half: a remote `MessagePort` closing settles nothing locally, so a
 * child that stops, navigates or dies leaves the parent awaiting a message that never comes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { attachPlaygroundBridge } from "../src/embed/playground.js";
import { createPlaygroundHost, type HostSink } from "../src/embed/host.js";
import { healthyWorker, type FakeWorker } from "./fake-worker.js";
import type { FakeWindow } from "./embed-fixtures.js";
import { connectedWindows, settle } from "./embed-fixtures.js";

const PORTAL = "https://portal.test";
const PLAY = "https://play.test";

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

/** A frame element whose `contentWindow` can be taken away, as a detached one's is. */
function fakeFrame(playground: FakeWindow) {
  const listeners = new Set<() => void>();
  let target: FakeWindow | null = playground;
  return {
    element: {
      get contentWindow() {
        return target as unknown as Window | null;
      },
      addEventListener: (type: string, listener: () => void) => {
        if (type === "load") listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    } as unknown as HTMLIFrameElement,
    navigate: () => {
      for (const listener of [...listeners]) listener();
    },
    detach: () => {
      target = null;
    },
  };
}

/** A portal, a playground, an engine and a live handshake. */
async function wired() {
  const worker = healthyWorker();
  const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
  await python.start();
  const { portal, playground } = connectedWindows(PORTAL, PLAY);
  const frame = fakeFrame(playground);
  const bridge = attachPlaygroundBridge({
    engine: python,
    hostOrigin: PORTAL,
    scope: playground as unknown as Window,
  });
  const invalidations: string[] = [];
  const host = createPlaygroundHost({
    frame: frame.element,
    playgroundOrigin: PLAY,
    scope: portal as unknown as Window,
    onInvalidated: (why) => invalidations.push(why),
  });
  cleanups.push(() => void host.stop());
  cleanups.push(() => bridge.stop());
  await settle(10);
  return { worker, python, portal, playground, frame, bridge, host, invalidations };
}

/** A sink that records exactly what happened to it, once each. */
function recordingSink(
  faults: Partial<Record<"write" | "close" | "abort", Error>> & { writeDelayMs?: number } = {},
) {
  const calls: string[] = [];
  const sink: HostSink & { calls: string[] } = {
    calls,
    async write(chunk: Uint8Array) {
      calls.push(`write:${chunk.byteLength}`);
      // A slow destination, so a cancellation has somewhere to land: a 192 KiB artifact over an
      // in-process MessageChannel finishes before any test could interrupt it.
      if (faults.writeDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, faults.writeDelayMs));
      }
      if (faults.write) throw faults.write;
    },
    async close() {
      calls.push("close");
      if (faults.close) throw faults.close;
    },
    async abort() {
      calls.push("abort");
      if (faults.abort) throw faults.abort;
    },
    release() {
      calls.push("release");
    },
  };
  return sink;
}

const openLeases = (worker: FakeWorker) => (worker as unknown as { openLeases: number }).openLeases;

describe("everything after the sink is acquired has one owner", () => {
  it("aborts and releases the sink when the frame vanishes while openSink() is returning", async () => {
    const { frame, host, worker } = await wired();
    const sink = recordingSink();

    await expect(
      host.download("out.csv", async () => {
        // The picker was open; the visitor navigated away from the portal's frame meanwhile.
        frame.detach();
        return sink;
      }),
    ).rejects.toBeTruthy();

    expect(sink.calls).toContain("abort");
    expect(sink.calls).toContain("release");
    expect(sink.calls).not.toContain("close");
    expect(openLeases(worker)).toBe(0);
  });

  it("aborts and releases when posting the request throws after the sink opened", async () => {
    const { playground, host, worker } = await wired();
    const sink = recordingSink();

    await expect(
      host.download("out.csv", () => {
        playground.detached = "the frame is gone";
        return sink;
      }),
    ).rejects.toBeTruthy();

    expect(sink.calls.filter((c) => c === "abort")).toHaveLength(1);
    expect(sink.calls.filter((c) => c === "release")).toHaveLength(1);
    expect(openLeases(worker)).toBe(0);
  });
});

describe("silence from the peer is bounded", () => {
  it("gives up when the child never sends a first chunk", async () => {
    const { host, bridge } = await wired();
    // The child is there but will not serve: its own listener is gone, so the request lands
    // nowhere and no message will ever come back through the port.
    bridge.stop();
    const sink = recordingSink();
    await expect(host.download("out.csv", () => sink, { inactivityMs: 60 })).rejects.toThrow(
      /no response|inactiv|timed out/i,
    );
    expect(sink.calls).toContain("abort");
    expect(sink.calls).toContain("release");
  });

  it("settles when the child stops mid-transfer - with the reason, not a timeout", async () => {
    const { host, bridge } = await wired();
    const sink = recordingSink({ writeDelayMs: 40 });
    const transfer = host.download("big.bin", () => sink, {
      inactivityMs: 150,
      chunkBytes: 64 * 1024,
    });
    await settle(6);
    bridge.stop(); // mid-transfer: the child aborts its own stream and says so
    await expect(transfer).rejects.toBeTruthy();
    expect(sink.calls.filter((c) => c === "abort")).toHaveLength(1);
  });

  it("…and falls back to the inactivity bound when the child says nothing at all", async () => {
    // A child that stops POLITELY posts an error, which is a better answer than a timeout. This
    // is the impolite case the bound exists for: a frame killed, navigated or crashed mid-transfer
    // sends nothing, and closing its port would not notify this side anyway. The bridge is
    // replaced by a stub that takes the port, sends one chunk and then goes silent.
    const { host, bridge, playground, portal } = await wired();
    const session = host.sessionId;
    bridge.stop();
    playground.addEventListener("message", (event) => {
      const data = event.data as { kind?: string; challenge?: string };
      if (data?.kind === "hail") {
        portal.postMessage(
          {
            channel: "freva-python-embed",
            version: 2,
            challenge: data.challenge,
            sessionId: session,
            kind: "ready",
          },
          PORTAL,
        );
        return;
      }
      if (data?.kind !== "download") return;
      const port = event.ports[0];
      port.start?.();
      // Deliberately SHORT of the artifact, so the transfer is genuinely mid-flight. An
      // over-long chunk is refused by the size check, which is a different (also correct) answer.
      port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(4) });
      // …and then nothing, ever again.
    });

    const sink = recordingSink();
    await expect(host.download("out.csv", () => sink, { inactivityMs: 80 })).rejects.toThrow(
      /no response|does not notify/i,
    );
    expect(sink.calls).toContain("write:4");
    expect(sink.calls).toContain("abort");
  });
});

describe("cancellation reaches a transfer wherever it is", () => {
  it("an AbortSignal settles it, and leaves no lease behind", async () => {
    const { host, worker } = await wired();
    const controller = new AbortController();
    const sink = recordingSink({ writeDelayMs: 40 });
    const transfer = host.download("big.bin", () => sink, {
      signal: controller.signal,
      chunkBytes: 64 * 1024,
    });
    await settle(4);
    controller.abort(new Error("the visitor pressed Cancel"));
    await expect(transfer).rejects.toBeTruthy();
    await settle(10);
    expect(sink.calls).toContain("abort");
    expect(openLeases(worker)).toBe(0);
  });

  it("host.stop() settles every transfer in flight", async () => {
    const { host, worker } = await wired();
    const sink = recordingSink({ writeDelayMs: 40 });
    const transfer = host.download("big.bin", () => sink, { chunkBytes: 64 * 1024 });
    await settle(2);
    await host.stop();
    await expect(transfer).rejects.toBeTruthy();
    expect(sink.calls).toContain("abort");
    await settle(10);
    expect(openLeases(worker)).toBe(0);
  });

  it("a navigation settles them too, because they belong to a document that is gone", async () => {
    const { host, frame, worker, invalidations } = await wired();
    const sink = recordingSink({ writeDelayMs: 40 });
    const transfer = host.download("big.bin", () => sink, { chunkBytes: 64 * 1024 });
    await settle(2);
    frame.navigate();
    await expect(transfer).rejects.toBeTruthy();
    expect(invalidations.length).toBeGreaterThan(0);
    await settle(10);
    expect(openLeases(worker)).toBe(0);
  });

  it("the child's own stop() releases its lease rather than freezing the artifact", async () => {
    const { host, bridge, worker } = await wired();
    const sink = recordingSink({ writeDelayMs: 40 });
    const transfer = host.download("big.bin", () => sink, {
      chunkBytes: 64 * 1024,
      inactivityMs: 200,
    });
    await settle(4);
    bridge.stop();
    await expect(transfer).rejects.toBeTruthy();
    await settle(10);
    expect(openLeases(worker), "a stopped child must not leave an artifact frozen").toBe(0);
  });
});

describe("a failing destination is still cleaned up exactly once", () => {
  it("survives write, abort and release all failing", async () => {
    const { host, worker } = await wired();
    const writeFault = new Error("the disk went away");
    const sink = recordingSink({ write: writeFault, abort: new Error("and abort failed") });
    await expect(
      host.download("big.bin", () => sink, { chunkBytes: 64 * 1024 }),
    ).rejects.toBeTruthy();
    expect(sink.calls.filter((c) => c === "abort")).toHaveLength(1);
    expect(sink.calls.filter((c) => c === "release")).toHaveLength(1);
    await settle(10);
    expect(openLeases(worker)).toBe(0);
  });

  it("bounds a close() that never returns", async () => {
    const { host } = await wired();
    const calls: string[] = [];
    const never = new Promise<void>(() => {});
    const sink: HostSink = {
      async write() {},
      async close() {
        calls.push("close");
        await never;
      },
      async abort() {
        calls.push("abort");
      },
    };
    await expect(host.download("out.csv", () => sink, { cleanupMs: 60 })).rejects.toThrow(
      /close|timed out/i,
    );
    expect(calls).toContain("close");
  });

  it("bounds an abort() that never returns", async () => {
    const { host, playground } = await wired();
    const calls: string[] = [];
    const never = new Promise<void>(() => {});
    const sink: HostSink = {
      async write() {},
      async close() {
        calls.push("close");
      },
      async abort() {
        calls.push("abort");
        await never;
      },
    };
    await expect(
      host.download(
        "out.csv",
        () => {
          playground.detached = "gone";
          return sink;
        },
        { cleanupMs: 60 },
      ),
    ).rejects.toBeTruthy();
    expect(calls).toEqual(["abort"]);
  });
});

describe("no promise is left pending after bounded cleanup", () => {
  it("every rejection settles, and none escapes as an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { host, frame } = await wired();
      // Handlers attached AT CREATION, which is what a caller does - `button.onclick = () =>
      // host.download(...)` awaits immediately. A download that fails in its synchronous prologue
      // rejects on the first tick, and leaving that unhandled for several macrotasks would make
      // Node report an unhandled rejection about the TEST's timing rather than about the bridge.
      const settled = Promise.allSettled([
        host.download("big.bin", () => recordingSink({ writeDelayMs: 20 }), {
          chunkBytes: 64 * 1024,
        }),
        host.download("big.bin", () => recordingSink({ writeDelayMs: 20 }), {
          chunkBytes: 64 * 1024,
        }),
      ]);
      await settle(2);
      frame.navigate();
      const results = await settled;
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      await settle(20);
      expect(seen, seen.map((r) => (r as Error)?.stack ?? String(r)).join("\n---\n")).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

void vi;
