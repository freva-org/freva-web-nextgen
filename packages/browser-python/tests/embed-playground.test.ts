/**
 * The child half of the bridge, driven directly. The loop it defends against has a short cycle:
 *
 *     onArtifacts -> announce() -> engine.artifacts() -> an `artifacts` reply
 *                 -> the engine emits it to every listener -> onArtifacts -> ...
 *
 * `engine.artifacts()` asks the Worker for the list, and the reply is BOTH settled for the caller
 * AND broadcast to every `onArtifacts` listener - deliberately, so a UI need not know whether a
 * change came from its own button or from `os.remove()`. A bridge that answered that broadcast by
 * asking again would turn an idle engine into an unbounded stream of `artifact-list` requests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { attachPlaygroundBridge } from "../src/embed/playground.js";
import { EMBED_CHANNEL, EMBED_PROTOCOL_VERSION } from "../src/embed/protocol.js";
import { healthyWorker, type FakeWorker } from "./fake-worker.js";
import { connectedWindows, settle, type FakeWindow } from "./embed-fixtures.js";

const PORTAL = "https://portal.test";
const PLAY = "https://play.test";

let stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

async function bridged() {
  const worker = healthyWorker();
  const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
  await python.start();
  const { portal, playground } = connectedWindows(PORTAL, PLAY);
  const bridge = attachPlaygroundBridge({
    engine: python,
    hostOrigin: PORTAL,
    scope: playground as unknown as Window,
  });
  stops.push(() => bridge.stop());
  await settle();
  return { worker, python, portal, playground, bridge };
}

/** How many times the engine asked the Worker to list the workspace. */
const listings = (worker: FakeWorker) =>
  worker.sent.filter((request) => request.kind === "artifact-list").length;

/** The artifact lists the portal has been told about. */
const announcements = (portal: FakeWindow) =>
  portal.received
    .map((m) => m.data as { kind?: string; artifacts?: unknown[] })
    .filter((d) => d.kind === "artifacts");

describe("the bridge does not ask the Worker in a circle", () => {
  it("asks the Worker for NOTHING when it attaches - the portal's `list` is the initial listing", async () => {
    const { worker, portal } = await bridged();
    await settle(8);
    expect(listings(worker), `${listings(worker)} artifact-list requests`).toBe(0);
    expect(announcements(portal).length).toBe(0);
    // It does say hello, so the portal knows it is there.
    expect(portal.received.map((m) => (m.data as { kind: string }).kind)).toContain("hello");
  });

  it("goes completely quiet when nothing happens, for a full second", async () => {
    const { worker, portal } = await bridged();
    await settle(8);
    const listedAfterAttach = listings(worker);
    const toldAfterAttach = announcements(portal).length;

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(listings(worker) - listedAfterAttach, "Worker requests while idle").toBe(0);
    expect(announcements(portal).length - toldAfterAttach, "parent updates while idle").toBe(0);
  });

  it("answers an explicit parent `list` with exactly one Worker request", async () => {
    const { worker, portal, playground, bridge } = await bridged();
    await settle(8);
    // A hail first, because a `list` outside the parent's current challenge is refused - asserted
    // on its own in embed-handshake.test.ts.
    const challenge = "challenge-for-this-test";
    playground.inject({
      channel: EMBED_CHANNEL,
      version: EMBED_PROTOCOL_VERSION,
      challenge,
      sessionId: "",
      kind: "hail",
    });
    await settle(4);
    const before = listings(worker);
    playground.inject({
      channel: EMBED_CHANNEL,
      version: EMBED_PROTOCOL_VERSION,
      challenge,
      sessionId: bridge.sessionId,
      kind: "list",
    });
    await settle(8);
    expect(listings(worker) - before).toBe(1);
    expect(announcements(portal).length).toBeGreaterThanOrEqual(1);
  });

  it("turns one real file change into exactly one parent update and no Worker request", async () => {
    const { worker, portal } = await bridged();
    await settle(8);
    const listedBefore = listings(worker);
    const toldBefore = announcements(portal).length;

    // Exactly what the Worker sends when an execution changed the workspace.
    worker.emit({
      kind: "artifacts",
      artifacts: [
        {
          name: "made.csv",
          size: 8,
          modifiedMs: 1_000,
          generation: 1,
          state: "ready",
          mime: "text/csv",
        },
      ],
      added: ["made.csv"],
      updated: [],
      removed: [],
    });
    await settle(8);

    expect(announcements(portal).length - toldBefore, "parent updates").toBe(1);
    expect(listings(worker) - listedBefore, "Worker requests for a change we were handed").toBe(0);
    expect(announcements(portal).at(-1)?.artifacts).toEqual([
      { name: "made.csv", size: 8, mime: "text/csv", state: "ready", modifiedMs: 1_000 },
    ]);
  });
});
