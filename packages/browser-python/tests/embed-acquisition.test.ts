/**
 * The window between "download() was called" and "a sink exists", which nobody owned.
 *
 * `openSink()` is the CALLER'S code and the slowest thing in a download: usually a native save
 * dialog a visitor can leave open for as long as they like. Without a transaction the host has
 * registered nothing, is listening to no cancellation and has bound the operation to no session,
 * so an abort, a `stop()` or an iframe navigation during the picker is not observed. A
 * transaction is registered BEFORE `openSink()`, which is invoked synchronously in the original
 * call turn so the native activation is still alive. The dialog itself cannot be cancelled - what
 * is cancelled is this side's interest in the result.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { attachPlaygroundBridge } from "../src/embed/playground.js";
import { createPlaygroundHost, type HostSink } from "../src/embed/host.js";
import { healthyWorker, type FakeWorker } from "./fake-worker.js";
import { connectedWindows, settle, FakeWindow } from "./embed-fixtures.js";

const PORTAL = "https://portal.test";
const PLAY = "https://play.test";

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

/** A frame whose document can be replaced, as a real navigation replaces one. */
function fakeFrame(playground: FakeWindow) {
  const listeners = new Set<() => void>();
  let target: FakeWindow = playground;
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
    replaceDocument: (next: FakeWindow) => {
      target = next;
      for (const listener of [...listeners]) listener();
    },
    navigate: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

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
  const host = createPlaygroundHost({
    frame: frame.element,
    playgroundOrigin: PLAY,
    scope: portal as unknown as Window,
  });
  cleanups.push(() => void host.stop());
  cleanups.push(() => bridge.stop());
  await settle(10);
  return { worker, python, portal, playground, frame, bridge, host };
}

/** A sink whose disposal is countable, so "exactly once" is a measurement. */
function lateSink() {
  const calls: string[] = [];
  const sink: HostSink = {
    async write() {
      calls.push("write");
    },
    async close() {
      calls.push("close");
    },
    async abort() {
      calls.push("abort");
    },
    release() {
      calls.push("release");
    },
  };
  return { sink, calls };
}

/** A picker that hangs until the test lets it answer - a visitor with a dialog open. */
function pendingPicker() {
  let settle_: ((sink: HostSink) => void) | null = null;
  let reject_: ((error: unknown) => void) | null = null;
  let opened = 0;
  const open = () => {
    opened += 1;
    return new Promise<HostSink>((resolve, reject) => {
      settle_ = resolve;
      reject_ = reject;
    });
  };
  return {
    open,
    get opened() {
      return opened;
    },
    resolveWith: (sink: HostSink) => settle_?.(sink),
    rejectWith: (error: unknown) => reject_?.(error),
  };
}

/** Artifact requests that reached a playground document. */
const requests = (playground: FakeWindow) =>
  playground.received.map((m) => m.data as { kind?: string }).filter((d) => d.kind === "download")
    .length;

const openLeases = (worker: FakeWorker) => (worker as unknown as { openLeases: number }).openLeases;

describe("cancellation reaches a download whose picker is still open", () => {
  it("an AbortSignal settles it promptly, and no artifact is ever requested", async () => {
    const { host, playground } = await wired();
    const picker = pendingPicker();
    const controller = new AbortController();

    const transfer = host.download("out.csv", picker.open, { signal: controller.signal });
    transfer.catch(() => undefined);
    await settle(4);
    expect(picker.opened, "the picker must be opened on the caller's own turn").toBe(1);

    controller.abort(new Error("the visitor pressed Cancel"));
    await expect(transfer).rejects.toBeTruthy();
    expect(requests(playground), "nothing may be asked of the child").toBe(0);
  });

  it("…and a sink that arrives afterwards is aborted and released exactly once", async () => {
    const { host, playground } = await wired();
    const picker = pendingPicker();
    const controller = new AbortController();
    const { sink, calls } = lateSink();

    const transfer = host.download("out.csv", picker.open, { signal: controller.signal });
    transfer.catch(() => undefined);
    await settle(4);
    controller.abort(new Error("cancelled"));
    await expect(transfer).rejects.toBeTruthy();

    // The dialog cannot be closed by us; the visitor eventually picks a file.
    picker.resolveWith(sink);
    await settle(10);

    expect(calls.filter((c) => c === "abort")).toHaveLength(1);
    expect(calls.filter((c) => c === "release")).toHaveLength(1);
    expect(calls).not.toContain("write");
    expect(calls).not.toContain("close");
    expect(requests(playground)).toBe(0);
  });

  it("host.stop() does the same, and the download never resumes afterwards", async () => {
    const { host, playground } = await wired();
    const picker = pendingPicker();
    const { sink, calls } = lateSink();

    const transfer = host.download("out.csv", picker.open);
    transfer.catch(() => undefined);
    await settle(4);
    await host.stop();
    await expect(transfer).rejects.toBeTruthy();

    picker.resolveWith(sink);
    await settle(10);
    expect(calls.filter((c) => c === "abort")).toHaveLength(1);
    expect(calls.filter((c) => c === "release")).toHaveLength(1);
    expect(requests(playground)).toBe(0);
  });

  it("a navigation during the picker binds nothing to the REPLACEMENT session either", async () => {
    const { host, python, frame, playground, bridge } = await wired();
    const picker = pendingPicker();
    const { sink, calls } = lateSink();

    const transfer = host.download("out.csv", picker.open);
    transfer.catch(() => undefined);
    await settle(4);

    // The frame is reloaded: a new document, a new bridge, a new session.
    bridge.stop();
    const replacement = new FakeWindow();
    replacement.origin = PLAY;
    replacement.peer = playground.peer;
    replacement.parent = playground.parent;
    (playground.peer as FakeWindow).peer = replacement;
    const second = attachPlaygroundBridge({
      engine: python,
      hostOrigin: PORTAL,
      scope: replacement as unknown as Window,
    });
    cleanups.push(() => second.stop());
    frame.replaceDocument(replacement);
    await settle(10);

    await expect(transfer).rejects.toBeTruthy();
    picker.resolveWith(sink);
    await settle(10);

    expect(calls.filter((c) => c === "abort")).toHaveLength(1);
    expect(requests(playground), "the old document must not be asked").toBe(0);
    expect(requests(replacement), "and neither must the new one").toBe(0);
  });

  it("absorbs a picker that REJECTS after the download was already cancelled", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { host } = await wired();
      const picker = pendingPicker();
      const controller = new AbortController();
      const transfer = host.download("out.csv", picker.open, { signal: controller.signal });
      transfer.catch(() => undefined);
      await settle(4);
      controller.abort(new Error("cancelled"));
      await expect(transfer).rejects.toBeTruthy();

      picker.rejectWith(new Error("the visitor dismissed the dialog"));
      await settle(20);
      expect(seen.map(String)).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("a stopped host is terminal", () => {
  it("refuses download() and refresh() after stop(), rather than half-working", async () => {
    const { host } = await wired();
    await host.stop();
    await expect(host.download("out.csv", () => lateSink().sink)).rejects.toThrow(/stopped/i);
    expect(() => host.refresh()).toThrow(/stopped/i);
  });

  it("is idempotent: stopping twice is not an error and settles nothing twice", async () => {
    const { host } = await wired();
    await host.stop();
    await expect(host.stop()).resolves.toBeUndefined();
  });
});

describe("stop() waits for what is still unwinding", () => {
  it("does not return while an acquired transfer is still being torn down", async () => {
    const { host, frame, worker } = await wired();
    const order: string[] = [];
    let releaseAbort: () => void = () => undefined;
    const sink: HostSink = {
      async write() {
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
      async close() {},
      async abort() {
        order.push("abort:start");
        await new Promise<void>((resolve) => {
          releaseAbort = resolve;
        });
        order.push("abort:end");
      },
      release() {
        order.push("release");
      },
    };

    const transfer = host.download("big.bin", () => sink, { chunkBytes: 64 * 1024 });
    transfer.catch(() => undefined);
    await settle(6);
    frame.navigate();
    // Polled, not counted in microtasks: cleanup WAITS for the in-flight write to return before
    // it touches the destination, so `abort()` starts later than a microtask count would expect.
    // That ordering is the point of the assertion at the end of this test.
    for (let i = 0; i < 40 && !order.includes("abort:start"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(order).toContain("abort:start");

    const stopping = host.stop().then(() => order.push("stop:returned"));
    await settle(6);
    expect(order, "stop() returned while abort() was still running").not.toContain("stop:returned");

    releaseAbort();
    await stopping;
    expect(order).toEqual(["abort:start", "abort:end", "release", "stop:returned"]);
    await settle(10);
    expect(openLeases(worker)).toBe(0);
  });
});
