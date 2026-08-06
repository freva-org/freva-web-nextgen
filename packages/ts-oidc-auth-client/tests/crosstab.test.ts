import { afterEach, describe, expect, it } from "vitest";
import {
  createCrossTab,
  deriveChannelName,
  parseCrossTabMessage,
  pendingLocalLockChains,
  withCrossTabLock,
} from "../src/crosstab.js";
import type { CrossTabMessage } from "../src/types.js";
import { installFakeBroadcastChannel, makeJwt } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withCrossTabLock (in-page mutex fallback — no navigator.locks)", () => {
  it("serializes concurrent critical sections", async () => {
    const order: string[] = [];
    const a = withCrossTabLock("t:lock", true, async () => {
      order.push("a-start");
      await sleep(20);
      order.push("a-end");
      return "a";
    });
    const b = withCrossTabLock("t:lock", true, async () => {
      order.push("b-start");
      return "b";
    });
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("releases the chain map entry after the last holder (no leak)", async () => {
    await Promise.all([
      withCrossTabLock("t:cleanup", true, async () => {
        await sleep(5);
      }),
      withCrossTabLock("t:cleanup", true, async () => undefined),
    ]);
    await sleep(0);
    expect(pendingLocalLockChains()).toBe(0);
  });

  it("a rejecting holder does not poison the chain", async () => {
    await expect(
      withCrossTabLock("t:poison", true, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withCrossTabLock("t:poison", true, async () => 42)).toBe(42);
  });
});

describe("createCrossTab", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
    localStorage.clear();
  });

  it("delivers messages to peers but never back to the sender", async () => {
    uninstall = installFakeBroadcastChannel();
    const gotA: CrossTabMessage[] = [];
    const gotB: CrossTabMessage[] = [];
    const a = createCrossTab("poa:test", (m) => gotA.push(m));
    const b = createCrossTab("poa:test", (m) => gotB.push(m));
    a.post({ type: "token-updated", sessionVersion: "abcd1234", exp: 1 });
    await sleep(0);
    expect(gotB).toHaveLength(1);
    expect(gotB[0]).toMatchObject({ type: "token-updated", tabId: a.tabId });
    expect(gotA).toHaveLength(0);
    a.close();
    b.close();
  });

  it("with BroadcastChannel present, localStorage is NOT written (no duplicate delivery)", () => {
    uninstall = installFakeBroadcastChannel();
    const handle = createCrossTab("poa:dual", () => {});
    handle.post({ type: "token-updated", sessionVersion: "ff00ff00", exp: 7 });
    expect(localStorage.getItem("poa:dual:sync")).toBeNull();
    handle.close();
  });

  it("the localStorage fallback key carries metadata only — never a JWT", () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.BroadcastChannel;
    g.BroadcastChannel = undefined; // exercise the TRUE fallback path
    const handle = createCrossTab("poa:meta", () => {});
    handle.post({ type: "token-updated", sessionVersion: "ff00ff00", exp: 7 });
    g.BroadcastChannel = prev;
    const raw = localStorage.getItem("poa:meta:sync");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ["at", "exp", "nonce", "sessionVersion", "tabId", "type"].sort(),
    );
    for (const v of Object.values(parsed)) {
      if (typeof v === "string") {
        expect(v.split(".").length).toBeLessThan(3);
      }
    }
    handle.close();
  });

  it("refuses to broadcast anything shaped like a JWT (defense in depth)", () => {
    uninstall = installFakeBroadcastChannel();
    const handle = createCrossTab("poa:guard", () => {});
    const jwt = makeJwt({ sub: "x", exp: 1, pad: "p".repeat(80) });
    expect(() =>
      handle.post({
        type: "logout",
        reason: jwt,
      } as unknown as Parameters<typeof handle.post>[0]),
    ).toThrow(/token/);
    handle.close();
  });

  it("derives distinct channel names per base URL and namespace", () => {
    const a = deriveChannelName({ authBaseUrl: "/x", storageKey: "memory" });
    const b = deriveChannelName({ authBaseUrl: "/y", storageKey: "memory" });
    const c = deriveChannelName({
      authBaseUrl: "/x",
      storageKey: "memory",
      namespace: "admin",
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^poa:[0-9a-f]{8}$/);
  });
});

describe("inbound message validation", () => {
  const now = Date.now();

  it("accepts well-formed messages", () => {
    expect(
      parseCrossTabMessage(
        {
          type: "logout",
          tabId: "t1",
          reason: "user-logout",
          operationId: "abcdef0123456789",
          startedAt: now,
          at: now,
        },
        now,
      ),
    ).toMatchObject({ type: "logout", tabId: "t1" });
    expect(
      parseCrossTabMessage(
        { type: "token-updated", tabId: "t1", sessionVersion: "ab12", exp: 5, at: now },
        now,
      ),
    ).toMatchObject({ type: "token-updated", sessionVersion: "ab12" });
  });

  it("rejects malformed, unknown and stale messages", () => {
    const base = {
      type: "logout",
      tabId: "t1",
      reason: "user-logout" as const,
      operationId: "abcdef0123456789",
      startedAt: now,
      at: now,
    };
    expect(parseCrossTabMessage(null, now)).toBeNull();
    expect(parseCrossTabMessage("logout", now)).toBeNull();
    expect(parseCrossTabMessage({ ...base, type: "drop-tables" }, now)).toBeNull();
    expect(parseCrossTabMessage({ ...base, tabId: 42 }, now)).toBeNull();
    expect(parseCrossTabMessage({ ...base, at: "soon" }, now)).toBeNull();
    expect(parseCrossTabMessage({ ...base, reason: { evil: true } }, now)).toBeNull();
    // Replay of a message captured hours ago.
    expect(parseCrossTabMessage({ ...base, at: now - 3_600_000 }, now)).toBeNull();
    // token-updated needs a plausible, non-JWT-shaped session fingerprint.
    const upd = { type: "token-updated", tabId: "t1", exp: 1, at: now };
    expect(parseCrossTabMessage(upd, now)).toBeNull();
    expect(parseCrossTabMessage({ ...upd, sessionVersion: "a.b.c" }, now)).toBeNull();
    expect(parseCrossTabMessage({ ...upd, sessionVersion: "x".repeat(200) }, now)).toBeNull();
  });

  it("a forged message on the channel is ignored, not delivered", async () => {
    const uninstall = installFakeBroadcastChannel();
    const got: CrossTabMessage[] = [];
    const receiver = createCrossTab("poa:forge", (m) => got.push(m));
    const attacker = createCrossTab("poa:forge", () => {});
    // Bypass post()'s own shaping to simulate a hostile same-origin script.
    const raw = new (
      globalThis as unknown as {
        BroadcastChannel: new (n: string) => BroadcastChannel;
      }
    ).BroadcastChannel("poa:forge");
    raw.postMessage({
      type: "logout",
      tabId: "evil",
      reason: "user-logout",
      operationId: "abcdef0123456789",
      startedAt: Date.now(),
    }); // no `at`
    await sleep(0);
    expect(got).toHaveLength(0);
    raw.postMessage({
      type: "logout",
      tabId: "evil",
      reason: "user-logout",
      operationId: "abcdef0123456789",
      startedAt: Date.now(),
      at: Date.now(),
    });
    await sleep(0);
    expect(got).toHaveLength(1);
    receiver.close();
    attacker.close();
    uninstall();
  });
});
