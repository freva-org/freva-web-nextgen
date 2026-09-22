/**
 * Once the destination is being closed, the download is finishing - not cancellable.
 *
 * The engine's artifact-stream contract draws this line: after every byte is written and the
 * three counts agree, what remains is a commit. `close()` is the storage layer's own transaction
 * and a cancellation arriving while it runs cannot un-write the bytes, so it must not rewrite the
 * outcome either. Two ways that goes wrong: a `close()` that FAILS reported as the earlier
 * cancellation - first-failure-wins is right for the transfer and wrong here, because the caller
 * is told their download was cancelled when their disk refused the commit - and the failure path
 * then calling `abort()` on a destination whose `close()` has already run, which is two terminal
 * operations on one destination and exactly what `HostSink` says will not happen.
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

/** A child that sends the whole artifact in one chunk, then ends the transfer honestly. */
async function cooperative(size: number) {
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
              name: "whole.bin",
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
        // One chunk was sent, so the only ack is the last one: end the transfer.
        if (kind === "ack") port.postMessage({ kind: "done", bytesWritten: size });
      };
      port.start?.();
      port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(size) });
    }
  });
  await settle(10);
  return { host, cancels };
}

/** A destination whose `close()` is held open by the test. */
function heldSink(order: string[], outcome: "resolve" | "reject", failure?: unknown) {
  let releaseClose: () => void = () => undefined;
  const closing = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const sink: HostSink = {
    async write(chunk) {
      order.push(`write:${chunk.byteLength}`);
    },
    async close() {
      order.push("close:start");
      await closing;
      order.push("close:end");
      if (outcome === "reject") throw failure;
    },
    async abort() {
      order.push("abort");
    },
    release() {
      order.push("release");
    },
  };
  return { sink, releaseClose: () => releaseClose() };
}

describe("the finishing phase is not cancellable", () => {
  it("returns success when the abort lands during a close() that then succeeds", async () => {
    const fixture = await cooperative(32);
    const order: string[] = [];
    const { sink, releaseClose } = heldSink(order, "resolve");
    const controller = new AbortController();

    const transfer = fixture.host.download("whole.bin", () => sink, {
      signal: controller.signal,
      inactivityMs: 5_000,
      cleanupMs: 5_000,
    });
    transfer.catch(() => undefined);
    await settle(20);
    expect(order, "the close must already be running").toContain("close:start");

    controller.abort(new Error("cancelled while the file was being committed"));
    await settle(10);
    releaseClose();

    await expect(transfer).resolves.toEqual({ bytesWritten: 32 });
    await settle(10);
    expect(order).toEqual(["write:32", "close:start", "close:end", "release"]);
    expect(
      order.filter((o) => o === "abort"),
      "a closed destination is never aborted",
    ).toEqual([]);
    expect(order.filter((o) => o === "release")).toHaveLength(1);
  });

  it("reports the close failure itself, not the cancellation that arrived during it", async () => {
    const fixture = await cooperative(32);
    const order: string[] = [];
    const storageError = new Error("the disk refused the commit");
    const { sink, releaseClose } = heldSink(order, "reject", storageError);
    const controller = new AbortController();

    const transfer = fixture.host.download("whole.bin", () => sink, {
      signal: controller.signal,
      inactivityMs: 5_000,
      cleanupMs: 5_000,
    });
    transfer.catch(() => undefined);
    await settle(20);
    expect(order).toContain("close:start");

    controller.abort(new Error("cancelled while the file was being committed"));
    await settle(10);
    releaseClose();

    // IDENTITY, not a message match: the caller gets the storage layer's own error object.
    await expect(transfer).rejects.toBe(storageError);
    await settle(10);
    expect(
      order.filter((o) => o === "abort"),
      "close and abort are both terminal",
    ).toEqual([]);
    expect(
      order.filter((o) => o === "close:start"),
      "closed once",
    ).toHaveLength(1);
    expect(
      order.filter((o) => o === "release"),
      "released exactly once",
    ).toHaveLength(1);
  });

  it("never follows a failed close() with an abort(), even with no cancellation in play", async () => {
    // The plain storage failure, with nothing racing it. `close()` is terminal whether it
    // succeeded or not, so the destination has already been settled and telling it to abort as
    // well is the double-settle `HostSink` rules out.
    const fixture = await cooperative(32);
    const order: string[] = [];
    const storageError = new Error("no space left on device");
    const { sink, releaseClose } = heldSink(order, "reject", storageError);

    const transfer = fixture.host.download("whole.bin", () => sink, {
      inactivityMs: 5_000,
      cleanupMs: 5_000,
    });
    transfer.catch(() => undefined);
    await settle(20);
    releaseClose();

    await expect(transfer).rejects.toBe(storageError);
    await settle(10);
    expect(order).toEqual(["write:32", "close:start", "close:end", "release"]);
  });

  it("reports the cleanup bound when close() never returns, and still releases once", async () => {
    const fixture = await cooperative(32);
    const order: string[] = [];
    // `releaseClose` is deliberately never called: this destination's close simply never returns.
    const { sink } = heldSink(order, "resolve");

    const transfer = fixture.host.download("whole.bin", () => sink, {
      inactivityMs: 5_000,
      cleanupMs: 40,
    });
    await expect(transfer).rejects.toThrow(/close\(\) did not return within 40ms/);
    await settle(20);
    expect(order).toEqual(["write:32", "close:start", "release"]);
  });

  it("lets host.stop() wait for a close in flight rather than deadlocking on it", async () => {
    const fixture = await cooperative(32);
    const order: string[] = [];
    const { sink, releaseClose } = heldSink(order, "resolve");

    const transfer = fixture.host.download("whole.bin", () => sink, {
      inactivityMs: 5_000,
      cleanupMs: 5_000,
    });
    transfer.catch(() => undefined);
    await settle(20);
    expect(order).toContain("close:start");

    let stopped = false;
    const stopping = fixture.host.stop().then(() => {
      stopped = true;
    });
    await settle(20);
    expect(stopped, "stop() must wait for the commit, not return over it").toBe(false);

    releaseClose();
    await expect(transfer).resolves.toEqual({ bytesWritten: 32 });
    await stopping;
    expect(stopped).toBe(true);
    expect(order).toEqual(["write:32", "close:start", "close:end", "release"]);
  });

  it("does not tell the child to cancel a download it has already finished sending", async () => {
    const fixture = await cooperative(32);
    const order: string[] = [];
    const { sink, releaseClose } = heldSink(order, "resolve");
    const controller = new AbortController();
    const transfer = fixture.host.download("whole.bin", () => sink, {
      signal: controller.signal,
      inactivityMs: 5_000,
      cleanupMs: 5_000,
    });
    transfer.catch(() => undefined);
    await settle(20);
    controller.abort(new Error("too late"));
    releaseClose();
    await expect(transfer).resolves.toEqual({ bytesWritten: 32 });
    await settle(10);
    expect(fixture.cancels).toEqual([]);
  });
});
