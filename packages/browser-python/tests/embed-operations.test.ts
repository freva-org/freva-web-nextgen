/**
 * The bounded bridge operations settle on their own, and a replaced document's session must be
 * RENEWED before the bridge is used again.
 *
 * Firefox's two-origin run wedged in "bounded bridge operations" right after a phase that reloaded
 * the playground frame. Two things are held here, without a browser: `host.perform()` really does
 * settle within `operationMs` - when the child is silent, when the conversation has been replaced
 * underneath it, and when no handshake has happened yet - and the sequence the browser suite now
 * waits for (invalidated, then a NEW ready session the host itself holds) is what a navigation
 * actually produces.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { attachPlaygroundBridge } from "../src/embed/playground.js";
import { createPlaygroundHost } from "../src/embed/host.js";
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

function fakeFrame(playground: FakeWindow) {
  const listeners = new Set<() => void>();
  return {
    element: {
      get contentWindow() {
        return playground as unknown as Window;
      },
      addEventListener: (type: string, listener: () => void) => {
        if (type === "load") listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    } as unknown as HTMLIFrameElement,
    /** The frame's `load` - what a real reload fires on the SAME element. */
    navigate: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

async function wired(operationMs = 15_000) {
  const worker = healthyWorker();
  const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
  await python.start();
  const { portal, playground } = connectedWindows(PORTAL, PLAY);
  const frame = fakeFrame(playground);
  const attach = () =>
    attachPlaygroundBridge({
      engine: python,
      hostOrigin: PORTAL,
      scope: playground as unknown as Window,
      transcript: () => "hello from the playground\n",
    });
  let bridge = attach();
  const events: string[] = [];
  const ready: string[] = [];
  const host = createPlaygroundHost({
    frame: frame.element,
    playgroundOrigin: PLAY,
    scope: portal as unknown as Window,
    operationMs,
    onReady: (id) => {
      ready.push(id);
      events.push(`ready:${id}`);
    },
    onInvalidated: (why) => events.push(`invalidated:${why}`),
  });
  cleanups.push(() => void host.stop());
  cleanups.push(() => bridge.stop());
  await settle(10);
  return {
    host,
    frame,
    events,
    ready,
    bridge: () => bridge,
    /** A NEW document in the same frame: the old bridge is gone, a new one attaches. */
    replaceDocument: () => {
      bridge.stop();
      frame.navigate();
      bridge = attach();
    },
  };
}

describe("host.perform() settles within its operation timeout", () => {
  it("answers normally while the playground is there", async () => {
    const { host } = await wired();
    await expect(host.perform("transcript")).resolves.toBeUndefined();
  });

  it("REJECTS by itself when the playground never answers - it does not wait forever", async () => {
    const { host, bridge } = await wired(60);
    bridge().stop(); // the child is silent from here on
    const started = Date.now();
    await expect(host.perform("transcript")).rejects.toThrow(
      /did not answer .*transcript.* in time/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("settles an operation in flight when the frame's document is replaced under it", async () => {
    const { host, bridge, frame } = await wired(10_000);
    bridge().stop();
    const pending = host.perform("clear-history");
    frame.navigate();
    await expect(pending).rejects.toThrow(/navigated/);
  });

  it("refuses at once, before any handshake with the replacement, rather than queueing", async () => {
    const { host, bridge, frame } = await wired();
    bridge().stop();
    frame.navigate();
    await expect(host.perform("transcript")).rejects.toThrow(/has not completed its handshake/);
  });
});

describe("a replaced document has a NEW session before the bridge is used again", () => {
  it("invalidates the old session, then establishes a different one the host itself holds", async () => {
    const { host, events, ready, replaceDocument } = await wired();
    const before = host.sessionId;
    expect(before).toBe(ready.at(-1));

    replaceDocument();
    // Immediately after the navigation there is NO session - using the bridge now is the race.
    expect(host.sessionId).toBeNull();
    await settle(20);

    const after = host.sessionId;
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(after).toBe(ready.at(-1)); // what the fixture exposes agrees with the host
    const invalidatedAt = events.findIndex((e) => e.startsWith("invalidated:"));
    const renewedAt = events.lastIndexOf(`ready:${after}`);
    expect(invalidatedAt).toBeGreaterThan(-1);
    expect(renewedAt).toBeGreaterThan(invalidatedAt);

    // …and only now does the bridge work again.
    await expect(host.perform("transcript")).resolves.toBeUndefined();
  });
});
