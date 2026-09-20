/**
 * A chunk already in flight when cancellation starts must not become a write. The child can have
 * posted its next chunk before the parent's `cancel` reached it, and a `MessagePort` message is
 * delivered as a task, so a handler that only checks for a terminal result would call
 * `sink.write()` on a destination in the middle of being aborted - the one overlap the sink
 * contract says will not happen.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createPlaygroundHost, type HostSink } from "../src/embed/host.js";
import { EMBED_CHANNEL, EMBED_PROTOCOL_VERSION } from "../src/embed/protocol.js";
import { connectedWindows, settle } from "./embed-fixtures.js";

const PORTAL = "https://portal.test";
const PLAY = "https://play.test";
const SESSION = "session-under-test";

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

/** A host wired to a child the test drives message by message. */
async function scripted(size = 64) {
  const { portal, playground } = connectedWindows(PORTAL, PLAY);
  const frame = {
    contentWindow: playground as unknown as Window,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLIFrameElement;
  const host = createPlaygroundHost({
    frame,
    playgroundOrigin: PLAY,
    scope: portal as unknown as Window,
  });
  cleanups.push(() => host.stop());

  let challenge = "";
  const ports: MessagePort[] = [];
  const acks: string[] = [];
  /** The child's cancel notification is not an ack - it is the parent telling it to stop. */
  const cancels: string[] = [];
  playground.addEventListener("message", (event) => {
    const data = event.data as { kind?: string; challenge?: string };
    if (data?.kind === "hail") {
      challenge = data.challenge!;
      portal.postMessage(
        {
          channel: EMBED_CHANNEL,
          version: EMBED_PROTOCOL_VERSION,
          challenge,
          sessionId: SESSION,
          kind: "ready",
        },
        PORTAL,
      );
      return;
    }
    if (data?.kind === "list") {
      portal.postMessage(
        {
          channel: EMBED_CHANNEL,
          version: EMBED_PROTOCOL_VERSION,
          challenge,
          sessionId: SESSION,
          kind: "artifacts",
          artifacts: [
            {
              name: "big.bin",
              size,
              mime: "application/octet-stream",
              state: "ready",
              modifiedMs: 1,
            },
          ],
        },
        PORTAL,
      );
      return;
    }
    if (data?.kind === "download") {
      const port = event.ports[0];
      port.onmessage = (reply) => {
        const kind = (reply.data as { kind: string }).kind;
        if (kind === "cancel") cancels.push(kind);
        else acks.push(kind);
      };
      port.start?.();
      ports.push(port);
    }
  });
  await settle(10);
  return { host, ports, acks, cancels };
}

describe("a chunk queued before cancellation is discarded, not written", () => {
  it("never starts a write once cleanup has begun, and never acknowledges it", async () => {
    const fixture = await scripted(64);
    const order: string[] = [];
    let releaseAbort: () => void = () => undefined;
    const controller = new AbortController();

    const sink: HostSink = {
      async write(chunk) {
        order.push(`write:${chunk.byteLength}`);
      },
      async close() {
        order.push("close");
      },
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

    const transfer = fixture.host.download("big.bin", () => sink, {
      signal: controller.signal,
      inactivityMs: 5_000,
      cleanupMs: 5_000,
    });
    transfer.catch(() => undefined);
    await settle(8);
    const port = fixture.ports.at(-1)!;

    // THE RACE, made deterministic. The chunk is posted and the abort happens in the SAME
    // synchronous turn, so the message event is already queued and cannot be delivered before the
    // cancellation - exactly the arrangement a cooperative child produces.
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(16) });
    controller.abort(new Error("cancelled while a chunk was in flight"));

    // OBSERVED WHILE `abort()` IS STILL PENDING, which is the whole point. The transfer's rejection
    // is deliberately not awaited yet: cleanup is bounded, so awaiting it here would only prove
    // what happens after the bound expires, not what happens during the abort.
    await settle(30);
    expect(order, "a queued chunk must not become a write").not.toContain("write:16");
    expect(order[0], "abort must have started").toBe("abort:start");
    expect(fixture.acks, "a discarded chunk is not acknowledged").toEqual([]);
    expect(fixture.cancels, "the child is told to stop").toEqual(["cancel"]);

    releaseAbort();
    await expect(transfer).rejects.toThrow(/in flight/);
    await settle(20);
    expect(
      order.filter((o) => o === "release"),
      "released exactly once",
    ).toHaveLength(1);
    expect(order).toEqual(["abort:start", "abort:end", "release"]);
  });

  it("discards chunks that keep arriving during cleanup", async () => {
    const fixture = await scripted(64);
    const writes: number[] = [];
    let releaseAbort: () => void = () => undefined;
    const controller = new AbortController();
    const sink: HostSink = {
      async write(chunk) {
        writes.push(chunk.byteLength);
      },
      async close() {},
      async abort() {
        await new Promise<void>((resolve) => {
          releaseAbort = resolve;
        });
      },
      release() {},
    };
    const transfer = fixture.host.download("big.bin", () => sink, {
      signal: controller.signal,
      inactivityMs: 5_000,
      cleanupMs: 5_000,
    });
    transfer.catch(() => undefined);
    await settle(8);
    const port = fixture.ports.at(-1)!;

    controller.abort(new Error("cancelled"));
    // A child that has not processed the cancel yet keeps sending, all through the abort.
    for (let i = 0; i < 5; i += 1) port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(8) });
    await settle(30);
    for (let i = 0; i < 5; i += 1) port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(8) });
    await settle(30);

    expect(writes).toEqual([]);
    expect(fixture.acks).toEqual([]);
    releaseAbort();
    await expect(transfer).rejects.toBeTruthy();
    await settle(10);
  });

  it("still awaits a write that genuinely started BEFORE cancellation", async () => {
    // The control. A write already running when the cancel arrives is not a queued message but an
    // operation the destination is in the middle of, and the contract says cleanup waits for it,
    // bounded by `cleanupMs`. Discarding queued chunks must not turn into abandoning that.
    const fixture = await scripted(64);
    const order: string[] = [];
    const controller = new AbortController();
    const sink: HostSink = {
      async write() {
        order.push("write:start");
        await new Promise((resolve) => setTimeout(resolve, 60));
        order.push("write:end");
      },
      async close() {
        order.push("close");
      },
      async abort() {
        order.push("abort");
      },
      release() {
        order.push("release");
      },
    };
    const transfer = fixture.host.download("big.bin", () => sink, {
      signal: controller.signal,
      inactivityMs: 5_000,
      cleanupMs: 5_000,
    });
    transfer.catch(() => undefined);
    await settle(8);
    fixture.ports.at(-1)!.postMessage({ kind: "chunk", bytes: new ArrayBuffer(16) });

    // Let the write really begin, then cancel underneath it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["write:start"]);
    controller.abort(new Error("cancelled mid-write"));

    await expect(transfer).rejects.toBeTruthy();
    expect(order).toEqual(["write:start", "write:end", "abort", "release"]);
  });
});
