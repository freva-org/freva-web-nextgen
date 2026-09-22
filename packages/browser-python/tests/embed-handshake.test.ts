/**
 * The handshake, and the one thing it has to survive: the frame navigating.
 *
 * A navigated iframe keeps the SAME `contentWindow` - the `WindowProxy` is stable across
 * navigations by design - but the document behind it is new and its session id is new. Binding
 * every message to the session learned first filters the new document's `hello` out and leaves
 * the bridge dead until the whole portal page is reloaded, which is what a visitor does when
 * something looks stuck. Accepting every hello is not the answer either, since any message that
 * can reach the parent would then replace the session at will: renewal is bound to a CHALLENGE
 * the parent owns and regenerates - the parent hails with a nonce, the child answers that exact
 * nonce with its session, and nothing else establishes a session.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { attachPlaygroundBridge } from "../src/embed/playground.js";
import { createPlaygroundHost } from "../src/embed/host.js";
import { EMBED_CHANNEL, EMBED_PROTOCOL_VERSION } from "../src/embed/protocol.js";
import { healthyWorker } from "./fake-worker.js";
import { connectedWindows, settle, FakeWindow } from "./embed-fixtures.js";

const PORTAL = "https://portal.test";
const PLAY = "https://play.test";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

/** A frame element whose `contentWindow` survives "navigation", exactly as a real one does. */
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
    /** What the browser does when the framed document is replaced. */
    navigate: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

async function engine() {
  const worker = healthyWorker();
  const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
  await python.start();
  return { worker, python };
}

async function attach(
  playground: FakeWindow,
  python: Awaited<ReturnType<typeof engine>>["python"],
) {
  const bridge = attachPlaygroundBridge({
    engine: python,
    hostOrigin: PORTAL,
    scope: playground as unknown as Window,
  });
  cleanups.push(() => bridge.stop());
  return bridge;
}

function host(frame: HTMLIFrameElement, portal: FakeWindow, over: Record<string, unknown> = {}) {
  const ready: string[] = [];
  /** Every list the host accepted, in order - not just the one it happens to hold at the end. */
  const seen: string[][] = [];
  const h = createPlaygroundHost({
    frame,
    playgroundOrigin: PLAY,
    scope: portal as unknown as Window,
    onReady: (id) => ready.push(id),
    onArtifacts: (list) => seen.push(list.map((a) => a.name)),
    ...over,
  });
  cleanups.push(() => h.stop());
  return { host: h, ready, seen };
}

describe("the handshake completes whichever side is ready first", () => {
  it("host first, then the child attaches", async () => {
    const { python } = await engine();
    const { portal, playground } = connectedWindows(PORTAL, PLAY);
    const frame = fakeFrame(playground);
    const { host: h, ready } = host(frame.element, portal);
    await settle();
    const bridge = await attach(playground, python);
    await settle(8);
    expect(h.sessionId).toBe(bridge.sessionId);
    expect(ready).toEqual([bridge.sessionId]);
  });

  it("child first, then the host is created - the missed hello recovers", async () => {
    const { python } = await engine();
    const { portal, playground } = connectedWindows(PORTAL, PLAY);
    const bridge = await attach(playground, python);
    await settle(8); // the `hello` goes nowhere: nothing is listening on the portal yet
    const frame = fakeFrame(playground);
    const { host: h, ready } = host(frame.element, portal);
    await settle(8);
    expect(h.sessionId).toBe(bridge.sessionId);
    expect(ready).toEqual([bridge.sessionId]);
  });
});

describe("a navigation renews the session instead of killing the bridge", () => {
  it("adopts the new document's session after the frame navigates", async () => {
    const { python } = await engine();
    const { portal, playground } = connectedWindows(PORTAL, PLAY);
    const frame = fakeFrame(playground);
    const { host: h, ready } = host(frame.element, portal);
    const first = await attach(playground, python);
    await settle(8);
    expect(h.sessionId).toBe(first.sessionId);

    // The document is replaced. Same WindowProxy, new bridge, new session.
    first.stop();
    frame.navigate();
    const second = await attach(playground, python);
    await settle(8);

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(h.sessionId).toBe(second.sessionId);
    expect(ready).toEqual([first.sessionId, second.sessionId]);
  });

  it("drops the artifacts the previous document reported", async () => {
    const { python, worker } = await engine();
    const { portal, playground } = connectedWindows(PORTAL, PLAY);
    const frame = fakeFrame(playground);
    const { host: h } = host(frame.element, portal);
    const first = await attach(playground, python);
    await settle(8);
    worker.emit({
      kind: "artifacts",
      artifacts: [
        {
          name: "old.csv",
          size: 3,
          modifiedMs: 1,
          generation: 1,
          state: "ready",
          mime: "text/csv",
        },
      ],
      added: ["old.csv"],
      updated: [],
      removed: [],
    });
    await settle(8);
    expect(h.artifacts.map((a) => a.name)).toEqual(["old.csv"]);

    first.stop();
    frame.navigate();
    await settle(4);
    expect(h.artifacts, "a navigated frame's artifacts are not the new document's").toEqual([]);
  });

  it("keeps refusing the OLD session's messages after the renewal", async () => {
    const { python } = await engine();
    const { portal, playground } = connectedWindows(PORTAL, PLAY);
    const frame = fakeFrame(playground);
    const { host: h } = host(frame.element, portal);
    const first = await attach(playground, python);
    await settle(8);
    const staleSession = first.sessionId;
    const staleChallenge = (portal.received.find(() => true)?.data as { challenge?: string })
      ?.challenge;
    first.stop();
    frame.navigate();
    const second = await attach(playground, python);
    await settle(8);

    portal.inject({
      channel: EMBED_CHANNEL,
      version: EMBED_PROTOCOL_VERSION,
      challenge: staleChallenge,
      sessionId: staleSession,
      kind: "artifacts",
      artifacts: [{ name: "ghost.csv", size: 1, mime: "text/csv", state: "ready", modifiedMs: 1 }],
    });
    await settle(4);
    // The legitimate list (the fake worker's own files) is there; the forgery is not.
    expect(h.artifacts.map((a) => a.name)).not.toContain("ghost.csv");
    expect(h.sessionId).toBe(second.sessionId);
  });
});

describe("renewal is bound to the parent's challenge, not to asking nicely", () => {
  it("refuses a `ready` that answers a challenge nobody issued", async () => {
    const { python } = await engine();
    const { portal, playground } = connectedWindows(PORTAL, PLAY);
    const frame = fakeFrame(playground);
    const { host: h } = host(frame.element, portal);
    await attach(playground, python);
    await settle(8);
    const established = h.sessionId;

    portal.inject({
      channel: EMBED_CHANNEL,
      version: EMBED_PROTOCOL_VERSION,
      challenge: "a-challenge-nobody-issued",
      sessionId: "an-attacker-session",
      kind: "ready",
    });
    await settle(4);
    expect(h.sessionId).toBe(established);
  });

  it("refuses everything from the wrong origin, the wrong window and the wrong version", async () => {
    const { python } = await engine();
    const { portal, playground } = connectedWindows(PORTAL, PLAY);
    const frame = fakeFrame(playground);
    const { host: h, seen } = host(frame.element, portal);
    const bridge = await attach(playground, python);
    await settle(8);
    const challenge = (
      playground.received.map((m) => m.data as { kind?: string; challenge?: string }).at(-1) ?? {}
    ).challenge;
    const good = {
      channel: EMBED_CHANNEL,
      version: EMBED_PROTOCOL_VERSION,
      challenge,
      sessionId: bridge.sessionId,
      kind: "artifacts" as const,
      artifacts: [{ name: "x.csv", size: 1, mime: "text/csv", state: "ready", modifiedMs: 1 }],
    };
    portal.inject(good, { origin: "https://play.test.evil.test" });
    portal.inject(good, { source: new FakeWindow() });
    portal.inject({ ...good, version: EMBED_PROTOCOL_VERSION + 1 });
    portal.inject({ ...good, challenge: "not-the-current-challenge" });
    portal.inject({ ...good, sessionId: "not-this-frame" });
    await settle(4);
    expect(seen.flat()).not.toContain("x.csv");

    // …and the same message, unmodified, is accepted - so the refusals above mean something.
    portal.inject(good);
    await settle(4);
    expect(seen.at(-1)).toEqual(["x.csv"]);
    expect(h.sessionId).toBe(bridge.sessionId);
  });
});
