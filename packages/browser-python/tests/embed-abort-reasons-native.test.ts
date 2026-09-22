/**
 * `abort(reason)` takes ANY JavaScript value, and `null` is one of them.
 *
 * Cancellation STATE is separate from the truthiness of the reason, which settles `0`, `false`
 * and `""`. `??` is the one operator that still treats `null` specially: `signal.reason ?? new
 * Error("the download was cancelled")` silently replaces a caller's `null` with a manufactured
 * Error, so a portal cancelling with `abort(null)` gets back an error it never wrote. Once
 * `signal.aborted` is true, `signal.reason` IS the reason - a no-argument `abort()` already
 * supplies the platform's `AbortError`. These use a REAL `AbortController`, because the value
 * that needs preserving is the one the platform stores.
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

/**
 * Every falsy reason `??` and `if (reason)` each get wrong, plus a truthy control. `null` is the
 * one this round is about; the rest are kept so a future `??` cannot quietly reintroduce half the
 * problem.
 */
const REASONS: Array<[string, unknown]> = [
  ["null", null],
  ["0", 0],
  ["false", false],
  ['""', ""],
  ["NaN", Number.NaN],
  ["0n", 0n],
  ["an Error (the control)", new Error("cancelled on purpose")],
];

/** True when `actual` is `expected`, with NaN compared as itself. */
const isSame = (actual: unknown, expected: unknown): boolean =>
  Object.is(actual, expected) || (Number.isNaN(expected as number) && Number.isNaN(actual));

async function hosted(size = 32) {
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
      downloads += 1;
      const port = event.ports[0];
      port.start?.();
      ports.push(port);
    }
  });
  await settle(10);
  return { host, ports, requests: () => downloads };
}

/** A destination that records every terminal call made on it. */
function recordingSink() {
  const calls: string[] = [];
  const reasons: unknown[] = [];
  const sink: HostSink = {
    async write() {
      calls.push("write");
    },
    async close() {
      calls.push("close");
    },
    async abort(reason) {
      calls.push("abort");
      reasons.push(reason);
    },
    release() {
      calls.push("release");
    },
  };
  return { sink, calls, reasons };
}

describe("a native AbortController's reason reaches the caller untouched", () => {
  for (const [label, reason] of REASONS) {
    it(`already aborted with ${label} before download() is even called`, async () => {
      const fixture = await hosted();
      const controller = new AbortController();
      controller.abort(reason);
      const { sink, calls } = recordingSink();

      const transfer = fixture.host.download("one.bin", () => sink, {
        signal: controller.signal,
        cleanupMs: 500,
      });
      let caught: unknown;
      let threw = false;
      try {
        await transfer;
      } catch (error) {
        threw = true;
        caught = error;
      }

      expect(threw, "an aborted signal cancels regardless of its reason's truthiness").toBe(true);
      expect(isSame(caught, reason), `rejected with ${label} itself`).toBe(true);
      // Nothing was started, so there is no destination to settle.
      expect(fixture.requests()).toBe(0);
      expect(calls).toEqual([]);
    });

    it(`aborted with ${label} synchronously inside openSink()`, async () => {
      const fixture = await hosted();
      const controller = new AbortController();
      const { sink, calls, reasons } = recordingSink();

      const transfer = fixture.host.download(
        "one.bin",
        () => {
          controller.abort(reason);
          return sink;
        },
        { signal: controller.signal, cleanupMs: 500 },
      );
      let caught: unknown;
      let threw = false;
      try {
        await transfer;
      } catch (error) {
        threw = true;
        caught = error;
      }
      await settle(20);

      expect(threw).toBe(true);
      expect(isSame(caught, reason), `rejected with ${label} itself`).toBe(true);
      expect(fixture.requests(), "no artifact is requested after cancellation").toBe(0);
      expect(calls, "the sink it returned is aborted and released, once each").toEqual([
        "abort",
        "release",
      ]);
      expect(isSame(reasons[0], reason), `abort() saw ${label} itself`).toBe(true);
    });

    it(`aborted with ${label} while the picker promise is still pending`, async () => {
      const fixture = await hosted();
      const controller = new AbortController();
      const { sink, calls, reasons } = recordingSink();
      let answerPicker: (s: HostSink) => void = () => undefined;

      const transfer = fixture.host.download(
        "one.bin",
        () =>
          new Promise<HostSink>((resolve) => {
            answerPicker = resolve;
          }),
        { signal: controller.signal, cleanupMs: 500 },
      );
      transfer.catch(() => undefined);
      await settle(5);
      controller.abort(reason);

      let caught: unknown;
      let threw = false;
      try {
        await transfer;
      } catch (error) {
        threw = true;
        caught = error;
      }
      // The platform cannot close a dialog a visitor has open, so the picker answers LATE.
      answerPicker(sink);
      await settle(30);

      expect(threw).toBe(true);
      expect(isSame(caught, reason), `rejected with ${label} itself`).toBe(true);
      expect(fixture.requests()).toBe(0);
      expect(calls, "a late sink is still disposed of, once").toEqual(["abort", "release"]);
      expect(isSame(reasons[0], reason), `the late disposal saw ${label} itself`).toBe(true);
    });

    it(`aborted with ${label} during the transfer itself`, async () => {
      const fixture = await hosted();
      const controller = new AbortController();
      const { sink, calls, reasons } = recordingSink();

      const transfer = fixture.host.download("one.bin", () => sink, {
        signal: controller.signal,
        inactivityMs: 5_000,
        cleanupMs: 500,
      });
      transfer.catch(() => undefined);
      await settle(10);
      expect(fixture.requests(), "the transfer really started").toBe(1);

      controller.abort(reason);
      let caught: unknown;
      let threw = false;
      try {
        await transfer;
      } catch (error) {
        threw = true;
        caught = error;
      }
      await settle(20);

      expect(threw).toBe(true);
      expect(isSame(caught, reason), `rejected with ${label} itself`).toBe(true);
      expect(calls).toEqual(["abort", "release"]);
      expect(isSame(reasons[0], reason), `abort() saw ${label} itself`).toBe(true);
    });
  }

  it("a no-argument abort() keeps the platform's own AbortError - no fallback needed", async () => {
    // The control that shows the removed fallbacks were never load-bearing. `abort()` with no
    // argument is defined to store an `AbortError` DOMException, so there has never been a case
    // where `signal.aborted` was true and `signal.reason` was absent.
    const fixture = await hosted();
    const controller = new AbortController();
    const { sink } = recordingSink();

    const transfer = fixture.host.download("one.bin", () => sink, {
      signal: controller.signal,
      inactivityMs: 5_000,
      cleanupMs: 500,
    });
    transfer.catch(() => undefined);
    await settle(10);
    controller.abort();

    let caught: unknown;
    try {
      await transfer;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(controller.signal.reason);
    expect((caught as Error).name).toBe("AbortError");
  });
});
