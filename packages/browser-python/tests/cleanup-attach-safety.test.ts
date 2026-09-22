/**
 * Attaching diagnostics must never cost the failure they are diagnostics FOR.
 *
 * `cleanupErrors` is attached to the thrown value inside a `finally`, and a `finally` that throws
 * replaces whatever was in flight. A destination that throws `Object.freeze(new Error("disk write
 * failed"))` and then fails to release would report neither: the assignment throws `TypeError:
 * Cannot add property cleanupErrors, object is not extensible`, and that is what the caller
 * catches. Frozen errors are not exotic; sealed objects, getter-only properties, `Proxy` traps
 * that refuse `set` and primitive rejections all reach the same line. The rule: attach if it is
 * possible, and if it is not, throw the original value EXACTLY as it was.
 */
import { describe, expect, it } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { healthyWorker } from "./fake-worker.js";

/** A destination whose write fails with `fault` and whose release then fails too. */
function hostileSink(fault: unknown, releaseFault: unknown) {
  const order: string[] = [];
  const sink = {
    async write() {
      order.push("write");
      throw fault;
    },
    async close() {
      order.push("close");
    },
    async abort() {
      order.push("abort");
    },
    release() {
      order.push("release");
      throw releaseFault;
    },
  };
  return { sink, order };
}

async function failWith(fault: unknown, releaseFault: unknown) {
  const python = createBrowserPython({
    workerFactory: () => healthyWorker() as unknown as Worker,
  });
  await python.start();
  const { sink, order } = hostileSink(fault, releaseFault);
  let caught: unknown;
  let threw = false;
  try {
    await python.streamArtifact("big.bin", sink, { chunkBytes: 64 * 1024 });
  } catch (error) {
    threw = true;
    caught = error;
  }
  return { caught, threw, order };
}

describe("a primary failure survives whatever the diagnostics cannot do", () => {
  it("keeps a FROZEN error exactly, rather than the TypeError from attaching to it", async () => {
    const storageFault = Object.freeze(new Error("disk write failed"));
    const releaseFault = new Error("and the writer would not let go");

    const { caught, threw, order } = await failWith(storageFault, releaseFault);

    expect(threw).toBe(true);
    // IDENTITY. Not a wrapper, not a copy, not a TypeError about extensibility.
    expect(caught).toBe(storageFault);
    expect((caught as Error).message).toBe("disk write failed");
    expect(caught).not.toBeInstanceOf(TypeError);
    // Cleanup still ran, in order, and the release still happened.
    expect(order).toEqual(["write", "abort", "release"]);
  });

  it("keeps a SEALED error exactly", async () => {
    const storageFault = Object.seal(new Error("quota exceeded"));
    const { caught, threw } = await failWith(storageFault, new Error("release failed"));
    expect(threw).toBe(true);
    expect(caught).toBe(storageFault);
  });

  it("keeps an error whose `cleanupErrors` is a getter with no setter", async () => {
    const storageFault = new Error("the device disappeared");
    Object.defineProperty(storageFault, "cleanupErrors", {
      get: () => undefined,
      configurable: false,
    });
    const { caught, threw } = await failWith(storageFault, new Error("release failed"));
    expect(threw).toBe(true);
    expect(caught).toBe(storageFault);
  });

  it("keeps an error whose `cleanupErrors` is non-writable data", async () => {
    const storageFault = new Error("read-only diagnostics");
    Object.defineProperty(storageFault, "cleanupErrors", {
      value: "not an array",
      writable: false,
      configurable: false,
    });
    const { caught, threw } = await failWith(storageFault, new Error("release failed"));
    expect(threw).toBe(true);
    expect(caught).toBe(storageFault);
    expect((caught as { cleanupErrors: unknown }).cleanupErrors).toBe("not an array");
  });

  it("keeps a Proxy whose `set` trap throws", async () => {
    const target = new Error("behind a proxy");
    const storageFault = new Proxy(target, {
      set() {
        throw new Error("this proxy refuses every write");
      },
      defineProperty() {
        throw new Error("and every defineProperty");
      },
    });
    const { caught, threw } = await failWith(storageFault, new Error("release failed"));
    expect(threw).toBe(true);
    expect(caught).toBe(storageFault);
  });

  it("keeps a primitive rejection exactly, including the falsy ones", async () => {
    for (const primitive of [0, false, "", null, undefined, Symbol("nope"), 0n, NaN]) {
      const { caught, threw } = await failWith(primitive, new Error("release failed"));
      expect(threw, `${String(primitive)} must still fail the transfer`).toBe(true);
      if (typeof primitive === "number" && Number.isNaN(primitive)) expect(caught).toBeNaN();
      else expect(caught).toBe(primitive);
    }
  });

  it("still attaches diagnostics when the error CAN carry them", async () => {
    // The control: nothing about the safety net may weaken the ordinary case.
    const storageFault = new Error("an ordinary, extensible failure");
    const releaseFault = new Error("and the writer would not let go");
    const { caught, threw } = await failWith(storageFault, releaseFault);
    expect(threw).toBe(true);
    expect(caught).toBe(storageFault);
    expect((caught as Error & { cleanupErrors?: unknown[] }).cleanupErrors).toEqual([releaseFault]);
  });
});
