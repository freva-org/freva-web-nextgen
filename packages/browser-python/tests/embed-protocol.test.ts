/**
 * The pure half of the embedding protocol: what a peer must prove before anything it says is
 * used. `accepted()` is the whole security boundary of the parent/child bridge reduced to one
 * function, which is why it lives apart from the two halves that use it - it needs no window,
 * no frame and no browser, so every way of getting past it can be tried here. `host.ts` and
 * `playground.ts` need real cross-origin frames and real `MessagePort`s, and are covered by
 * browser-tests/embedding-two-origin.mjs.
 */
import { describe, expect, it } from "vitest";
import {
  EMBED_CHANNEL,
  EMBED_PROTOCOL_VERSION,
  accepted,
  newSessionId,
} from "../src/embed/protocol.js";

const PEER = {} as Window;
const ORIGIN = "https://play.example";
const SESSION = "session-1";

const message = (over: Record<string, unknown> = {}) =>
  ({
    origin: ORIGIN,
    source: PEER,
    data: {
      channel: EMBED_CHANNEL,
      version: EMBED_PROTOCOL_VERSION,
      sessionId: SESSION,
      kind: "artifacts",
      ...over,
    },
  }) as unknown as MessageEvent;

const expectation = { origin: ORIGIN, source: PEER, sessionId: SESSION };

describe("accepted() is the boundary, and every way past it is closed", () => {
  it("accepts the peer it was told to expect", () => {
    expect(accepted(message(), expectation)).toBe(true);
  });

  it("refuses another origin, however similar", () => {
    for (const origin of [
      "https://play.example.evil.test",
      "https://evil-play.example",
      "http://play.example",
      "https://play.example:8443",
      "null",
    ]) {
      const event = { ...message(), origin } as MessageEvent;
      expect(accepted(event, expectation), origin).toBe(false);
    }
  });

  it("refuses another window on the RIGHT origin", () => {
    // Origin alone is not identity: any frame on the peer origin has that origin, including one
    // an attacker persuaded the peer to open.
    const other = { ...message(), source: {} as Window } as MessageEvent;
    expect(accepted(other, expectation)).toBe(false);
  });

  it("refuses another protocol version, on every message and not only at the handshake", () => {
    expect(accepted(message({ version: EMBED_PROTOCOL_VERSION + 1 }), expectation)).toBe(false);
    expect(accepted(message({ version: "1" }), expectation)).toBe(false);
    expect(accepted(message({ version: undefined }), expectation)).toBe(false);
  });

  it("ignores traffic that is not this channel rather than parsing it", () => {
    expect(accepted(message({ channel: "something-else" }), expectation)).toBe(false);
    expect(accepted(message({ channel: undefined }), expectation)).toBe(false);
  });

  it("refuses a session that is not this frame's, so a reload cannot be replayed into", () => {
    expect(accepted(message({ sessionId: "an-older-frame" }), expectation)).toBe(false);
  });

  it("accepts any session when none is expected yet - the handshake, and only the handshake", () => {
    expect(accepted(message({ kind: "hello" }), { origin: ORIGIN, source: PEER })).toBe(true);
  });

  it("survives data that is not an object at all", () => {
    for (const data of [null, undefined, "hello", 42, []]) {
      const event = { origin: ORIGIN, source: PEER, data } as unknown as MessageEvent;
      expect(accepted(event, expectation), JSON.stringify(data)).toBe(false);
    }
  });
});

describe("newSessionId", () => {
  it("is different every time, so two frames are never confused", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
    expect(ids.size).toBe(50);
  });

  it("falls back to getRandomValues, and to nothing else", () => {
    const original = globalThis.crypto;
    const swap = (value: unknown) =>
      Object.defineProperty(globalThis, "crypto", { value, configurable: true });
    try {
      swap({
        getRandomValues: (array: Uint8Array) => {
          for (let i = 0; i < array.length; i += 1) array[i] = i;
          return array;
        },
      });
      expect(newSessionId()).toMatch(/^[0-9a-f]{32}$/);

      // AND NO `Math.random()`: a predictable value standing in for the thing that decides
      // whether a message is accepted. `Math.random` is not seeded for unpredictability and its
      // state is recoverable from a few outputs. A context with neither API is a context
      // something is wrong with, and saying so beats inventing an identity a peer can guess.
      swap({});
      expect(() => newSessionId()).toThrow(/randomUUID|getRandomValues/);
    } finally {
      swap(original);
    }
  });
});
