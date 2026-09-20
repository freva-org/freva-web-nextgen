/**
 * ONE completion owner for a download, from the call to the last cleanup step.
 *
 * Registering the transaction twice - a deferred `done` promise before `openSink()`, then the
 * entry REPLACED with `run.catch(...)` once the transfer exists - leaves the first promise
 * resolved only on the one path that never reaches the second, a picker that throws
 * synchronously. Every other download, the successful ones included, leaves it pending for ever.
 *
 * What hangs off it is not bookkeeping. The abort listener is removed by `done.then(...)`, so a
 * promise that never resolves is a listener that is never removed: three downloads sharing one
 * `AbortSignal` accumulate three listeners on it. And `stop()` awaits those promises, so a
 * `stop()` from inside `openSink()` - the picker's own code re-entering the host - never returns.
 *
 * These tests watch OBSERVABLE lifecycle: listener counts on a signal, whether promises settle,
 * what the child was asked for, how often a sink was disposed. None of them reads the registry.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { attachPlaygroundBridge } from "../src/embed/playground.js";
import { createPlaygroundHost, type HostSink, type PlaygroundHost } from "../src/embed/host.js";
import { healthyWorker } from "./fake-worker.js";
import type { FakeWindow } from "./embed-fixtures.js";
import { connectedWindows, settle } from "./embed-fixtures.js";

const PORTAL = "https://portal.test";
const PLAY = "https://play.test";

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

/**
 * An `AbortSignal` that counts the listeners currently attached to it. A real signal keeps its
 * listeners privately, so a leak on one is invisible from the outside; wrapping
 * `addEventListener`/`removeEventListener` makes the count observable without reaching into the
 * host at all.
 */
function trackedSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  let attached = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    configurable: true,
    value: (...args: Parameters<typeof add>) => {
      attached += 1;
      return add(...args);
    },
  });
  Object.defineProperty(signal, "removeEventListener", {
    configurable: true,
    value: (...args: Parameters<typeof remove>) => {
      attached -= 1;
      return remove(...args);
    },
  });
  return {
    signal,
    abort: (reason?: unknown) => controller.abort(reason),
    get attached() {
      return attached;
    },
  };
}

function fakeFrame(playground: FakeWindow) {
  const listeners = new Set<() => void>();
  return {
    element: {
      contentWindow: playground as unknown as Window,
      addEventListener: (type: string, listener: () => void) => {
        if (type === "load") listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    } as unknown as HTMLIFrameElement,
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

/** A sink that counts every disposal, so "exactly once" is a measurement. */
function countedSink() {
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

/** How many artifact requests reached the playground document. */
const requests = (playground: FakeWindow) =>
  playground.received.map((m) => m.data as { kind?: string }).filter((d) => d.kind === "download")
    .length;

describe("a completed download leaves nothing attached to its signal", () => {
  it("three successes on one signal return the listener count to zero each time", async () => {
    const { host } = await wired();
    const tracked = trackedSignal();

    for (let i = 0; i < 3; i += 1) {
      const { sink, calls } = countedSink();
      const result = await host.download("out.csv", () => sink, { signal: tracked.signal });
      expect(result.bytesWritten).toBeGreaterThan(0);
      expect(calls.filter((c) => c === "close")).toHaveLength(1);
      expect(calls.filter((c) => c === "release")).toHaveLength(1);
      expect(calls).not.toContain("abort");
      await settle(4);
      expect(tracked.attached, `after download ${i + 1}`).toBe(0);
    }
  });

  it("a picker that rejects ASYNCHRONOUSLY detaches too, and stop() settles", async () => {
    const { host } = await wired();
    const tracked = trackedSignal();
    await expect(
      host.download(
        "out.csv",
        () => Promise.reject(new Error("the visitor dismissed the dialog")),
        { signal: tracked.signal },
      ),
    ).rejects.toThrow(/dismissed/);
    await settle(6);
    expect(tracked.attached).toBe(0);
    await expect(host.stop()).resolves.toBeUndefined();
  });

  it("a picker that throws SYNCHRONOUSLY detaches too", async () => {
    const { host } = await wired();
    const tracked = trackedSignal();
    await expect(
      host.download(
        "out.csv",
        () => {
          throw new Error("no dialog at all");
        },
        { signal: tracked.signal },
      ),
    ).rejects.toThrow(/no dialog/);
    await settle(6);
    expect(tracked.attached).toBe(0);
  });

  it("a cancelled download detaches once the transaction is over", async () => {
    const { host, playground } = await wired();
    const tracked = trackedSignal();
    let resolvePicker: ((sink: HostSink) => void) | null = null;
    const transfer = host.download(
      "out.csv",
      () => new Promise<HostSink>((resolve) => (resolvePicker = resolve)),
      { signal: tracked.signal },
    );
    transfer.catch(() => undefined);
    await settle(4);
    expect(tracked.attached).toBe(1);
    tracked.abort(new Error("cancelled"));
    await expect(transfer).rejects.toBeTruthy();
    await settle(6);
    expect(tracked.attached).toBe(0);

    const { sink, calls } = countedSink();
    (resolvePicker as unknown as (s: HostSink) => void)(sink);
    await settle(10);
    expect(calls.filter((c) => c === "abort")).toHaveLength(1);
    expect(calls.filter((c) => c === "release")).toHaveLength(1);
    expect(calls).not.toContain("write");
    expect(calls).not.toContain("close");
    expect(requests(playground)).toBe(0);
  });
});

describe("stop() settles however it is reached", () => {
  it("settles when called RE-ENTRANTLY from inside openSink()", async () => {
    // The picker is the caller's code and may do anything, including tearing the host down - a
    // portal that navigates away while its dialog is open does exactly this. `stop()` awaits
    // every transaction's completion promise, so a promise nothing resolves never returns.
    const { host } = await wired();
    let stopping: Promise<void> | null = null;
    const transfer = host.download("out.csv", () => {
      stopping = host.stop();
      return countedSink().sink;
    });
    transfer.catch(() => undefined);

    await expect(transfer).rejects.toBeTruthy();
    expect(stopping).toBeTruthy();
    await expect(stopping as unknown as Promise<void>).resolves.toBeUndefined();
  });

  it("settles while a picker is still pending, without waiting for the dialog", async () => {
    const { host } = await wired();
    let resolvePicker: ((sink: HostSink) => void) | null = null;
    const transfer = host.download(
      "out.csv",
      () => new Promise<HostSink>((resolve) => (resolvePicker = resolve)),
    );
    transfer.catch(() => undefined);
    await settle(4);

    // The native dialog is still open and cannot be closed by us; `stop()` must not wait for it.
    await expect(host.stop()).resolves.toBeUndefined();
    await expect(transfer).rejects.toBeTruthy();

    const { sink, calls } = countedSink();
    (resolvePicker as unknown as (s: HostSink) => void)(sink);
    await settle(10);
    expect(calls.filter((c) => c === "abort")).toHaveLength(1);
    expect(calls.filter((c) => c === "release")).toHaveLength(1);
  });
});

describe("nothing reaches the child after the transaction ended", () => {
  it.each([["cancellation", async (host: PlaygroundHost) => void (await host.stop())]])(
    "no artifact request after %s",
    async (_label, end) => {
      const { host, playground } = await wired();
      let resolvePicker: ((sink: HostSink) => void) | null = null;
      const transfer = host.download(
        "out.csv",
        () => new Promise<HostSink>((resolve) => (resolvePicker = resolve)),
      );
      transfer.catch(() => undefined);
      await settle(4);
      await end(host);
      await expect(transfer).rejects.toBeTruthy();
      const { sink } = countedSink();
      (resolvePicker as unknown as (s: HostSink) => void)(sink);
      await settle(10);
      expect(requests(playground)).toBe(0);
    },
  );

  it("no artifact request after a navigation replaced the session", async () => {
    const { host, frame, playground } = await wired();
    let resolvePicker: ((sink: HostSink) => void) | null = null;
    const transfer = host.download(
      "out.csv",
      () => new Promise<HostSink>((resolve) => (resolvePicker = resolve)),
    );
    transfer.catch(() => undefined);
    await settle(4);
    frame.navigate();
    await expect(transfer).rejects.toBeTruthy();
    const { sink, calls } = countedSink();
    (resolvePicker as unknown as (s: HostSink) => void)(sink);
    await settle(10);
    expect(requests(playground)).toBe(0);
    expect(calls.filter((c) => c === "abort")).toHaveLength(1);
  });
});

describe("a sink is disposed exactly once on every path", () => {
  it("a successful transfer closes and releases once, and never aborts", async () => {
    const { host } = await wired();
    const { sink, calls } = countedSink();
    await host.download("out.csv", () => sink);
    expect(calls.filter((c) => c === "close")).toHaveLength(1);
    expect(calls.filter((c) => c === "release")).toHaveLength(1);
    expect(calls.filter((c) => c === "abort")).toHaveLength(0);
  });

  it("a failed transfer aborts and releases once, and never closes", async () => {
    const { host } = await wired();
    const calls: string[] = [];
    const sink: HostSink = {
      async write() {
        calls.push("write");
        throw new Error("the disk went away");
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
    await expect(
      host.download("big.bin", () => sink, { chunkBytes: 64 * 1024 }),
    ).rejects.toBeTruthy();
    expect(calls.filter((c) => c === "abort")).toHaveLength(1);
    expect(calls.filter((c) => c === "release")).toHaveLength(1);
    expect(calls.filter((c) => c === "close")).toHaveLength(0);
  });
});

/**
 * The late sink's disposal is bounded like every other disposal. Awaiting `sink.abort()` directly
 * means a destination whose `abort()` never settles - and a picker's writable is arbitrary code,
 * so it can - never reaches `release()`, despite `cleanupMs` existing precisely to stop a
 * destination holding the portal. The late arrival is the path a cancelled download always takes.
 */
describe("a sink that arrives after cancellation is cleaned up under the same bound", () => {
  it("releases within cleanupMs even when abort() never settles", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { host, playground } = await wired();
      const controller = new AbortController();
      let resolvePicker: ((sink: HostSink) => void) | null = null;

      const calls: string[] = [];
      const never = new Promise<void>(() => {});
      const stubborn: HostSink = {
        async write() {
          calls.push("write");
        },
        async close() {
          calls.push("close");
        },
        async abort() {
          calls.push("abort");
          await never; // …and never returns.
        },
        release() {
          calls.push("release");
        },
      };

      const transfer = host.download(
        "out.csv",
        () => new Promise<HostSink>((resolve) => (resolvePicker = resolve)),
        { signal: controller.signal, cleanupMs: 10 },
      );
      transfer.catch(() => undefined);
      await settle(4);

      const reason = new Error("the visitor pressed Cancel");
      controller.abort(reason);
      await expect(transfer).rejects.toBe(reason);

      // The dialog answers long after nobody is waiting for it.
      (resolvePicker as unknown as (s: HostSink) => void)(stubborn);

      // Bounded: `cleanupMs` is 10 ms, so this is settled well inside 500.
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(
        calls.filter((c) => c === "abort"),
        "abort exactly once",
      ).toHaveLength(1);
      expect(
        calls.filter((c) => c === "release"),
        "release exactly once",
      ).toHaveLength(1);
      expect(calls).not.toContain("write");
      expect(calls).not.toContain("close");
      expect(requests(playground), "no artifact request for a cancelled download").toBe(0);
      expect(unhandled.map(String), "the unsettled abort must not escape").toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps the caller's original cancellation reason, not the cleanup's", async () => {
    const { host } = await wired();
    const controller = new AbortController();
    let resolvePicker: ((sink: HostSink) => void) | null = null;
    const reason = new Error("the visitor pressed Cancel");
    const transfer = host.download(
      "out.csv",
      () => new Promise<HostSink>((resolve) => (resolvePicker = resolve)),
      { signal: controller.signal, cleanupMs: 10 },
    );
    transfer.catch(() => undefined);
    await settle(4);
    controller.abort(reason);
    await expect(transfer).rejects.toBe(reason);

    (resolvePicker as unknown as (s: HostSink) => void)({
      async write() {},
      async close() {},
      async abort() {
        throw new Error("and the abort failed too");
      },
      release() {},
    });
    await settle(10);
    // The caller was answered before any of that happened, and with their own reason.
    await expect(transfer).rejects.toBe(reason);
  });
});
