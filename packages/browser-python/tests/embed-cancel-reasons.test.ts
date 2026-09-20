/**
 * A cancellation reason is any JavaScript value, and `0`, `false` and `""` are values.
 *
 * `AbortController.abort(reason)` takes anything at all, so storing it in one nullable variable
 * and asking `if (failure)` whether the transaction was cancelled means a portal that aborts with
 * `0`, `false` or `""` cancels nothing: the artifact is still requested, the visitor's file is
 * written and closed, and a sink arriving afterwards is never disposed of. `0` is not strange to
 * pass - an enum, an exit code, a reason index or `abort(controller.signal.reason ?? "")` all
 * produce one. So the state is a boolean and the reason is data: every decision reads the
 * boolean, and only the REJECTION reads the reason, asserted with `toBe` rather than by message.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { attachPlaygroundBridge } from "../src/embed/playground.js";
import { createPlaygroundHost, type HostSink } from "../src/embed/host.js";
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

async function wired() {
  const worker = healthyWorker();
  const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
  await python.start();
  const { portal, playground } = connectedWindows(PORTAL, PLAY);
  const frame = {
    contentWindow: playground as unknown as Window,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLIFrameElement;
  const bridge = attachPlaygroundBridge({
    engine: python,
    hostOrigin: PORTAL,
    scope: playground as unknown as Window,
  });
  const host = createPlaygroundHost({
    frame,
    playgroundOrigin: PLAY,
    scope: portal as unknown as Window,
  });
  cleanups.push(() => void host.stop());
  cleanups.push(() => bridge.stop());
  await settle(10);
  return { worker, playground, host };
}

function countedSink(over: Partial<HostSink> = {}) {
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
    ...over,
  };
  return { sink, calls };
}

const requests = (playground: FakeWindow) =>
  playground.received.map((m) => m.data as { kind?: string }).filter((d) => d.kind === "download")
    .length;

/** Every reason a caller can plausibly pass, including the three that are falsy. */
const REASONS: Array<[string, unknown]> = [
  ["0", 0],
  ["false", false],
  ['""', ""],
  ["an Error (the control)", new Error("cancelled")],
];

describe("a falsy abort reason still cancels", () => {
  it.each(REASONS)("aborting with %s inside openSink() stops the download", async (_l, reason) => {
    const { host, playground } = await wired();
    const controller = new AbortController();
    const { sink, calls } = countedSink();

    const transfer = host.download(
      "out.csv",
      () => {
        // The picker's own code cancels - a portal whose dialog was dismissed does this.
        controller.abort(reason);
        return sink;
      },
      { signal: controller.signal, cleanupMs: 20 },
    );

    await expect(transfer).rejects.toBe(reason);
    await settle(10);

    expect(requests(playground), "nothing may be asked of the child").toBe(0);
    expect(calls).not.toContain("write");
    expect(calls).not.toContain("close");
    expect(
      calls.filter((c) => c === "abort"),
      "abort exactly once",
    ).toHaveLength(1);
    expect(
      calls.filter((c) => c === "release"),
      "release exactly once",
    ).toHaveLength(1);
  });

  it.each(REASONS)("aborting with %s while the picker is pending", async (_l, reason) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { host, playground } = await wired();
      const controller = new AbortController();
      let resolvePicker: ((sink: HostSink) => void) | null = null;

      const transfer = host.download(
        "out.csv",
        () => new Promise<HostSink>((resolve) => (resolvePicker = resolve)),
        { signal: controller.signal, cleanupMs: 20 },
      );
      transfer.catch(() => undefined);
      await settle(4);

      controller.abort(reason);
      await expect(transfer).rejects.toBe(reason);

      // The dialog answers long afterwards, as a native one can.
      const { sink, calls } = countedSink({
        async abort() {
          calls.push("abort");
          await new Promise(() => {}); // …and never returns: the bound has to carry it.
        },
      });
      (resolvePicker as unknown as (s: HostSink) => void)(sink);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(requests(playground)).toBe(0);
      expect(
        calls.filter((c) => c === "abort"),
        "bounded abort, once",
      ).toHaveLength(1);
      expect(
        calls.filter((c) => c === "release"),
        "release, once",
      ).toHaveLength(1);
      expect(calls).not.toContain("write");
      expect(calls).not.toContain("close");
      expect(unhandled.map(String)).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it.each(REASONS)("aborting with %s mid-transfer stops it too", async (_l, reason) => {
    const { host } = await wired();
    const controller = new AbortController();
    const { sink, calls } = countedSink({
      async write() {
        calls.push("write");
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    });
    const transfer = host.download("big.bin", () => sink, {
      signal: controller.signal,
      chunkBytes: 64 * 1024,
      inactivityMs: 5_000,
    });
    transfer.catch(() => undefined);
    await settle(6);
    controller.abort(reason);
    await expect(transfer).rejects.toBe(reason);
    expect(calls.filter((c) => c === "abort")).toHaveLength(1);
    expect(calls.filter((c) => c === "release")).toHaveLength(1);
    expect(calls).not.toContain("close");
  });
});
