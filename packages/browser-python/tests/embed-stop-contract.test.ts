/**
 * `stop()` documents a boundary, so the boundary is asserted rather than trusted.
 *
 * It cannot "settle everything in flight": `showSaveFilePicker()` returns a promise the platform
 * gives no way to cancel and there is no API to close a dialog a visitor has open, so a `stop()`
 * that waited for one would hang a page teardown indefinitely. The documented contract is
 * narrower, and these are its four claims: registered transfers are awaited, acquired sinks are
 * disposed of, `stop()` returns without waiting for a picker, and a sink arriving afterwards is
 * still disposed of - bounded, once, never written to.
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

async function hosted() {
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
  let downloads = 0;
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
              name: "one.bin",
              size: 32,
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
      downloads += 1;
      event.ports[0]?.start?.();
    }
  });
  await settle(10);
  return { host, requests: () => downloads };
}

function recordingSink(calls: string[]) {
  return {
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
  } satisfies HostSink;
}

describe("what stop() settles", () => {
  it("cancels and awaits a transfer registered but still waiting on the picker", async () => {
    const fixture = await hosted();
    const calls: string[] = [];
    // A picker that never answers: registered before it opens, which is the point.
    const transfer = fixture.host.download("one.bin", () => new Promise<HostSink>(() => {}), {
      cleanupMs: 500,
    });
    transfer.catch(() => undefined);
    await settle(5);

    await fixture.host.stop();
    await expect(transfer).rejects.toBeTruthy();
    expect(fixture.requests(), "no artifact was ever requested").toBe(0);
    expect(calls).toEqual([]);
  });

  it("disposes of a sink it has already acquired, and awaits that disposal", async () => {
    const fixture = await hosted();
    const calls: string[] = [];
    const transfer = fixture.host.download("one.bin", () => recordingSink(calls), {
      inactivityMs: 5_000,
      cleanupMs: 500,
    });
    transfer.catch(() => undefined);
    await settle(10);
    expect(fixture.requests()).toBe(1);

    await fixture.host.stop();
    // Awaited, not merely requested: by the time stop() returns the destination is settled.
    expect(calls).toEqual(["abort", "release"]);
    await expect(transfer).rejects.toBeTruthy();
  });

  it("RETURNS while a picker is still open, rather than hanging on it", async () => {
    const fixture = await hosted();
    let answerPicker: (s: HostSink) => void = () => undefined;
    const transfer = fixture.host.download(
      "one.bin",
      () =>
        new Promise<HostSink>((resolve) => {
          answerPicker = resolve;
        }),
      { cleanupMs: 500 },
    );
    transfer.catch(() => undefined);
    await settle(5);

    let returned = false;
    const stopping = fixture.host.stop().then(() => {
      returned = true;
    });
    // A generous window: if `stop()` were waiting for the dialog it would still be pending here,
    // and the picker below is what a visitor answering it looks like.
    await settle(60);
    expect(returned, "stop() must not wait for a dialog nothing can close").toBe(true);
    await stopping;

    // The picker answers afterwards, as a real one can.
    const calls: string[] = [];
    answerPicker(recordingSink(calls));
    await settle(30);
    expect(calls, "a late sink is still aborted and released, exactly once").toEqual([
      "abort",
      "release",
    ]);
    expect(calls, "and never written to").not.toContain("write");
    expect(fixture.requests(), "and no artifact is requested for it").toBe(0);
  });

  it("is idempotent, and a second stop() waits for the same unwinding", async () => {
    const fixture = await hosted();
    const calls: string[] = [];
    const transfer = fixture.host.download("one.bin", () => recordingSink(calls), {
      inactivityMs: 5_000,
      cleanupMs: 500,
    });
    transfer.catch(() => undefined);
    await settle(10);

    await Promise.all([fixture.host.stop(), fixture.host.stop()]);
    await fixture.host.stop();
    expect(calls, "one abort, one release, however many times stop() is called").toEqual([
      "abort",
      "release",
    ]);
  });
});
