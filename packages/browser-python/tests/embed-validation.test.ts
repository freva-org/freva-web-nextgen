/**
 * Every payload that crosses the origin boundary is data from another origin, and is checked.
 *
 * A host that trusts `done.bytesWritten` over the count it kept itself closes an EMPTY
 * destination as a complete file when a child sends no chunks and then
 * `done: { bytesWritten: 10 }` - a truncated download wearing the name of a whole one. The
 * other half is concurrency: one ack per chunk is the backpressure, and nothing but the host
 * enforces that the child waited for it, so a second chunk arriving before the first write
 * returns starts a SECOND `sink.write()` on a `FileSystemWritableFileStream` that then
 * interleaves or throws.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createPlaygroundHost, type HostSink } from "../src/embed/host.js";
import { EMBED_CHANNEL, EMBED_PROTOCOL_VERSION } from "../src/embed/protocol.js";
import { connectedWindows, settle } from "./embed-fixtures.js";

/** Long enough for a 15 ms sink write to finish - microtask turns are not. */
const written = () => new Promise((resolve) => setTimeout(resolve, 60));

const PORTAL = "https://portal.test";
const PLAY = "https://play.test";
const SESSION = "session-under-test";

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

/**
 * A host talking to a scripted child: whatever the test wants to send, exactly as sent. No
 * engine and no real bridge, because the point is what the HOST does with a payload a
 * misbehaving or hostile child produced, which a well-behaved bridge cannot produce.
 */
async function scripted(artifactOver: Record<string, unknown> = {}) {
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
  playground.addEventListener("message", (event) => {
    const data = event.data as { kind?: string; challenge?: string; name?: string };
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
              size: 10,
              mime: "application/octet-stream",
              state: "ready",
              modifiedMs: 1,
              ...artifactOver,
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
      ports.push(port);
    }
  });
  await settle(10);
  return { host, portal, playground, ports };
}

function countingSink(over: Partial<HostSink> = {}) {
  const state = { written: 0, closed: 0, aborted: 0, concurrent: 0, maxConcurrent: 0 };
  const sink: HostSink = {
    async write(chunk: Uint8Array) {
      state.concurrent += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      await new Promise((resolve) => setTimeout(resolve, 15));
      state.written += chunk.byteLength;
      state.concurrent -= 1;
    },
    async close() {
      state.closed += 1;
    },
    async abort() {
      state.aborted += 1;
    },
    ...over,
  };
  return { sink, state };
}

async function begin(fixture: Awaited<ReturnType<typeof scripted>>, name = "ten.bin") {
  const { sink, state } = countingSink();
  const promise = fixture.host.download(name, () => sink, { inactivityMs: 400 });
  promise.catch(() => undefined);
  await settle(6);
  return { promise, state, port: fixture.ports.at(-1)! };
}

describe("the host counts the bytes itself", () => {
  it("refuses `done` after no chunks at all", async () => {
    const fixture = await scripted();
    const { promise, state, port } = await begin(fixture);
    port.postMessage({ kind: "done", bytesWritten: 10 });
    await expect(promise).rejects.toThrow(/0 bytes|wrote 0|incomplete|short|of 10/i);
    expect(state.written).toBe(0);
    expect(state.closed, "an empty destination must never be closed as complete").toBe(0);
    expect(state.aborted).toBe(1);
  });

  it("refuses five bytes followed by `done: 10`", async () => {
    const fixture = await scripted();
    const { promise, state, port } = await begin(fixture);
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(5) });
    await written();
    port.postMessage({ kind: "done", bytesWritten: 10 });
    await expect(promise).rejects.toBeTruthy();
    expect(state.written).toBe(5);
    expect(state.closed, "a truncated destination must never be closed as complete").toBe(0);
    expect(state.aborted).toBe(1);
  });

  it("refuses ten bytes followed by `done: 5` - the count must match on both sides", async () => {
    const fixture = await scripted();
    const { promise, state, port } = await begin(fixture);
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(10) });
    await written();
    port.postMessage({ kind: "done", bytesWritten: 5 });
    await expect(promise).rejects.toBeTruthy();
    expect(state.closed).toBe(0);
  });

  it("accepts the honest case, and closes exactly once", async () => {
    const fixture = await scripted();
    const { promise, state, port } = await begin(fixture);
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(10) });
    await written();
    port.postMessage({ kind: "done", bytesWritten: 10 });
    await expect(promise).resolves.toEqual({ bytesWritten: 10 });
    expect(state.written).toBe(10);
    expect(state.closed).toBe(1);
    expect(state.aborted).toBe(0);
  });
});

describe("one write at a time, whatever the child does", () => {
  it("never starts a second sink.write() before the first has returned", async () => {
    const fixture = await scripted();
    const { promise, state, port } = await begin(fixture);
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(5) });
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(5) });
    await expect(promise).rejects.toThrow(/ack|before|concurrent|overlap|acknowledg/i);
    expect(state.maxConcurrent, "two writes ran at once on one destination").toBe(1);
  });

  it("refuses a `done` that arrives while a write is still in progress", async () => {
    const fixture = await scripted();
    const { promise, state, port } = await begin(fixture);
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(10) });
    port.postMessage({ kind: "done", bytesWritten: 10 });
    await expect(promise).rejects.toBeTruthy();
    expect(state.closed).toBe(0);
  });
});

describe("payloads are validated, not trusted", () => {
  const cases: Array<[string, unknown]> = [
    ["a chunk that is not an ArrayBuffer", { kind: "chunk", bytes: "not bytes" }],
    [
      "a chunk that is a typed array rather than a buffer",
      { kind: "chunk", bytes: new Uint8Array(4) },
    ],
    ["a chunk with no bytes at all", { kind: "chunk" }],
    ["a done with a negative count", { kind: "done", bytesWritten: -1 }],
    ["a done with NaN", { kind: "done", bytesWritten: Number.NaN }],
    ["a done with an unsafe integer", { kind: "done", bytesWritten: Number.MAX_SAFE_INTEGER + 2 }],
    ["a done with no count", { kind: "done" }],
    ["a message of an unknown kind", { kind: "surprise" }],
    ["a message that is not an object", "hello"],
    ["a null message", null],
  ];
  it.each(cases)("rejects %s", async (_label, payload) => {
    const fixture = await scripted();
    const { promise, state, port } = await begin(fixture);
    port.postMessage(payload);
    await expect(promise).rejects.toBeTruthy();
    expect(state.closed).toBe(0);
  });

  it("rejects a chunk larger than the artifact it claims to be part of", async () => {
    const fixture = await scripted();
    const { promise, state, port } = await begin(fixture);
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(11) });
    await expect(promise).rejects.toThrow(/more than|larger|exceed|size|10/i);
    expect(state.closed).toBe(0);
  });

  it("ignores anything that arrives after a terminal result", async () => {
    const fixture = await scripted();
    const { promise, state, port } = await begin(fixture);
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(10) });
    await written();
    port.postMessage({ kind: "done", bytesWritten: 10 });
    await expect(promise).resolves.toEqual({ bytesWritten: 10 });
    port.postMessage({ kind: "chunk", bytes: new ArrayBuffer(5) });
    port.postMessage({ kind: "done", bytesWritten: 99 });
    await settle(6);
    expect(state.written, "a message after the end must change nothing").toBe(10);
    expect(state.closed).toBe(1);
  });
});

describe("artifact metadata is validated before anything is opened", () => {
  it("refuses to open a picker for an artifact that is not ready", async () => {
    const fixture = await scripted({ state: "open" });
    let opened = 0;
    await expect(
      fixture.host.download("ten.bin", () => {
        opened += 1;
        return countingSink().sink;
      }),
    ).rejects.toThrow(/ready|still open|cannot be downloaded/i);
    expect(opened, "the picker must not open for a file Python is still writing").toBe(0);
  });

  it("drops an artifact whose size is not a safe integer", async () => {
    const fixture = await scripted({ size: Number.MAX_SAFE_INTEGER + 2 });
    expect(fixture.host.artifacts.map((a) => a.name)).not.toContain("ten.bin");
  });

  it("drops an artifact whose mime is not a string", async () => {
    const fixture = await scripted({ mime: 42 });
    expect(fixture.host.artifacts.map((a) => a.name)).not.toContain("ten.bin");
  });

  it("offers the BASENAME as the suggested filename, keeping the full name intact", async () => {
    // A workspace name may contain separators; handing one to `showSaveFilePicker` as
    // `suggestedName` is at best rejected and at worst a path the visitor did not choose.
    const fixture = await scripted({ name: "nested/dir/report.csv", size: 4 });
    const seen: Array<{ name: string; suggestedName: string }> = [];
    const promise = fixture.host.download(
      "nested/dir/report.csv",
      (artifact) => {
        seen.push({ name: artifact.name, suggestedName: artifact.suggestedName });
        return countingSink().sink;
      },
      { inactivityMs: 120 },
    );
    promise.catch(() => undefined);
    await promise.catch(() => undefined);
    expect(seen).toEqual([{ name: "nested/dir/report.csv", suggestedName: "report.csv" }]);
  });

  it("hands out a COPY of the artifact list, not the peer's own array", async () => {
    const fixture = await scripted();
    const first = fixture.host.artifacts;
    (first as unknown as unknown[]).push({ name: "injected" });
    expect(fixture.host.artifacts.map((a) => a.name)).toEqual(["ten.bin"]);
  });
});
