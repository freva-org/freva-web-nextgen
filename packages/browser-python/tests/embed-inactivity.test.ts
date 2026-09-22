/**
 * Peer silence and a slow destination are different things, and one timer would measure both. An
 * inactivity clock left armed while `sink.write()` runs makes a destination slower than
 * `inactivityMs` look like a CHILD that has gone quiet, so the host aborts and releases a
 * destination whose own write has not returned. The bound still matters: closing a `MessagePort`
 * does not notify the peer, so a frame killed mid-transfer sends nothing.
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

/** A host talking to a child the test drives by hand. */
async function scripted(size = 10) {
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
  let resolveDownloadPort!: (port: MessagePort) => void;
  const downloadPort = new Promise<MessagePort>((resolve) => {
    resolveDownloadPort = resolve;
  });
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
              name: "ten.bin",
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
      port.start?.();
      resolveDownloadPort(port);
    }
  });
  await settle(10);
  return { host, downloadPort, portal, playground };
}

describe("a slow destination is not child silence", () => {
  it("survives a 100 ms write under a 30 ms inactivity bound", async () => {
    // THE REPRODUCTION. A healthy child sends one chunk and waits for its ack. The destination
    // takes 100 ms - longer than the bound - and a clock that stayed armed would fail the transfer
    // with "the playground sent no response".
    const fixture = await scripted(10);
    const order: string[] = [];
    const sink: HostSink = {
      async write(chunk) {
        order.push(`write:start:${chunk.byteLength}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
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

    const promise = fixture.host.download("ten.bin", () => sink, { inactivityMs: 30 });
    promise.catch(() => undefined);
    const port = await fixture.downloadPort;
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(10) });

    // The child then behaves perfectly: it waits for the ack before finishing.
    await new Promise<void>((resolve) => {
      port.onmessage = (event) => {
        if ((event.data as { kind?: string })?.kind === "ack") {
          port.postMessage({ kind: "done", bytesWritten: 10 });
          resolve();
        }
      };
    });

    await expect(promise).resolves.toEqual({ bytesWritten: 10 });
    expect(order).toEqual(["write:start:10", "write:end", "close", "release"]);
  });

  it("…and nothing is aborted or released before that write returns", async () => {
    const fixture = await scripted(10);
    const seen: string[] = [];
    let writeReturned = false;
    const sink: HostSink = {
      async write() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        writeReturned = true;
      },
      async close() {
        seen.push(`close:writeReturned=${writeReturned}`);
      },
      async abort() {
        seen.push(`abort:writeReturned=${writeReturned}`);
      },
      release() {
        seen.push(`release:writeReturned=${writeReturned}`);
      },
    };
    const promise = fixture.host.download("ten.bin", () => sink, { inactivityMs: 30 });
    promise.catch(() => undefined);
    const port = await fixture.downloadPort;
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(10) });
    port.onmessage = (event) => {
      if ((event.data as { kind?: string })?.kind === "ack") {
        port.postMessage({ kind: "done", bytesWritten: 10 });
      }
    };
    await promise;
    expect(seen.every((s) => s.endsWith("=true"))).toBe(true);
  });
});

describe("the silent-peer bound is still real", () => {
  it("fires when the child says nothing at all", async () => {
    const fixture = await scripted(10);
    const sink: HostSink = { async write() {}, async close() {}, async abort() {} };
    await expect(
      fixture.host.download("ten.bin", () => sink, { inactivityMs: 60 }),
    ).rejects.toThrow(/no response|does not notify/i);
  });

  it("fires when the child goes quiet AFTER a chunk was written", async () => {
    const fixture = await scripted(20);
    const sink: HostSink = {
      async write() {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      async close() {},
      async abort() {},
    };
    const promise = fixture.host.download("ten.bin", () => sink, { inactivityMs: 80 });
    promise.catch(() => undefined);
    const port = await fixture.downloadPort;
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(10) });
    // …and then nothing: no second chunk, no done, no error.
    await expect(promise).rejects.toThrow(/no response|does not notify/i);
  });
});

describe("cancellation during a write has a defined ordering", () => {
  it("waits for the write to return before aborting and releasing", async () => {
    const fixture = await scripted(10);
    const order: string[] = [];
    const controller = new AbortController();
    const sink: HostSink = {
      async write() {
        order.push("write:start");
        await new Promise((resolve) => setTimeout(resolve, 80));
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
    const promise = fixture.host.download("ten.bin", () => sink, {
      signal: controller.signal,
      inactivityMs: 5_000,
    });
    promise.catch(() => undefined);
    const port = await fixture.downloadPort;
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(10) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["write:start"]);
    controller.abort(new Error("cancelled mid-write"));
    await expect(promise).rejects.toBeTruthy();
    // A SINK IS NEVER RELEASED WHILE ONE OF ITS WRITES IS ACTIVE. `release()` is a caller's "give
    // the lock back", and giving back a lock a write is still using is how a `WritableStream` ends
    // up with two owners.
    expect(order).toEqual(["write:start", "write:end", "abort", "release"]);
  });
});
