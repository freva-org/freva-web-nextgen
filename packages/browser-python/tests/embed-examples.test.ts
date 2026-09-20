/**
 * Registered examples: the manifest, and the one message that names one. The property being
 * defended is a single sentence - the bridge can carry a NAME and never a PROGRAM - and
 * everything here tries to break it. A request that carries source cannot be expressed by the
 * protocol at all, so the interesting failures are the near misses: an id nobody registered, a
 * digest from another build, a manifest that lies about its hashes, and a message aimed at a
 * different playground.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExampleRegistry,
  parseExampleManifest,
  parseRegisteredExample,
  sha256Hex,
  verifyExampleManifest,
  type RegisteredExample,
} from "../src/embed/examples.js";
import { attachPlaygroundBridge } from "../src/embed/playground.js";
import { EMBED_CHANNEL, EMBED_PROTOCOL_VERSION } from "../src/embed/protocol.js";
import { connectedWindows, settle, type FakeWindow } from "./embed-fixtures.js";
import { healthyWorker } from "./fake-worker.js";
import { createBrowserPython } from "../src/browser-python.js";

const PORTAL = "https://portal.test";
const PLAY = "https://play.test";
const SOURCE = "import xarray as xr\n\nprint(xr.__version__)\n";

async function manifest(): Promise<RegisteredExample[]> {
  return [
    { id: "open-store", title: "Open the store", source: SOURCE, sha256: await sha256Hex(SOURCE) },
  ];
}

describe("the manifest", () => {
  it("refuses an entry that is not a registered example", () => {
    for (const bad of [
      null,
      "open-store",
      {},
      { id: "", title: "t", source: "x", sha256: "a".repeat(64) },
      { id: "a", title: "", source: "x", sha256: "a".repeat(64) },
      { id: "a", title: "t", source: "", sha256: "a".repeat(64) },
      { id: "a", title: "t", source: "x", sha256: "not a digest" },
      { id: "a", title: "t", source: "x", sha256: 42 },
      { id: "a", title: "t", source: 1, sha256: "a".repeat(64) },
      { id: "a", title: "t", source: "x", sha256: "a".repeat(64), datasetId: 7 },
    ]) {
      expect(() => parseRegisteredExample(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("refuses two entries for one name, rather than letting the last one win", () => {
    const one = { id: "a", title: "t", source: "x = 1", sha256: "a".repeat(64) };
    const two = { id: "a", title: "t", source: "x = 2", sha256: "b".repeat(64) };
    expect(() => parseExampleManifest([one, two])).toThrow(/registers "a" twice/);
  });

  it("normalises a digest's case but not its content", () => {
    const parsed = parseRegisteredExample({
      id: "a",
      title: "t",
      source: "x",
      sha256: "A".repeat(64),
    });
    expect(parsed.sha256).toBe("a".repeat(64));
  });

  it("refuses a manifest whose digests are not the digests of its own sources", async () => {
    const good = await manifest();
    await expect(verifyExampleManifest(good)).resolves.toBeUndefined();

    const tampered = [{ ...good[0], source: `${SOURCE}os.system("rm -rf /")\n` }];
    await expect(verifyExampleManifest(tampered)).rejects.toThrow(/does not match its own digest/);
  });
});

describe("resolution", () => {
  it("needs BOTH the name and the digest this build registered it under", async () => {
    const registry = createExampleRegistry(await manifest());
    const digest = registry.resolve("open-store", (await manifest())[0].sha256);
    expect(digest.ok).toBe(true);

    expect(registry.resolve("open-store", "b".repeat(64))).toMatchObject({
      ok: false,
      reason: "digest",
    });
    expect(registry.resolve("nobody", (await manifest())[0].sha256)).toMatchObject({
      ok: false,
      reason: "unknown",
    });
    for (const bad of [undefined, null, 42, "", "short", "g".repeat(64)]) {
      expect(registry.resolve("open-store", bad), String(bad)).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
    expect(registry.resolve("", "a".repeat(64))).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("does not hand out the catalogue when it refuses", async () => {
    const registry = createExampleRegistry(await manifest());
    const refusal = registry.resolve("nobody", "a".repeat(64));
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    // The reason names what was asked for, never what exists.
    expect(refusal.message).toContain("nobody");
    expect(refusal.message).not.toContain("open-store");
  });
});

describe("the bridge", () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops) stop();
    stops.length = 0;
  });

  async function bridged(over: { examples?: boolean } = {}) {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    const { portal, playground } = connectedWindows(PORTAL, PLAY);
    const ran: RegisteredExample[] = [];
    const entries = await manifest();
    const bridge = attachPlaygroundBridge({
      engine: python,
      hostOrigin: PORTAL,
      scope: playground as unknown as Window,
      ...(over.examples === false
        ? {}
        : {
            examples: createExampleRegistry(entries),
            onRunExample: (example) => {
              ran.push(example);
            },
          }),
    });
    stops.push(() => bridge.stop());
    await settle();

    const challenge = "challenge-1";
    playground.inject({
      channel: EMBED_CHANNEL,
      version: EMBED_PROTOCOL_VERSION,
      challenge,
      sessionId: "",
      kind: "hail",
    });
    await settle(4);
    const ask = (over2: Record<string, unknown> = {}) =>
      playground.inject({
        channel: EMBED_CHANNEL,
        version: EMBED_PROTOCOL_VERSION,
        challenge,
        sessionId: bridge.sessionId,
        kind: "run-example",
        exampleId: "open-store",
        digest: entries[0].sha256,
        ...over2,
      });
    return { portal, playground, bridge, ran, ask, entries, python };
  }

  const replies = (portal: FakeWindow, kind: string) =>
    portal.received
      .map((m) => m.data as { kind?: string; exampleId?: string; reason?: string })
      .filter((d) => d.kind === kind);

  it("runs a registered example, and reports that the NAME was accepted", async () => {
    const { portal, ran, ask, entries } = await bridged();
    ask();
    await settle(4);
    expect(ran).toEqual([entries[0]]);
    expect(replies(portal, "example-accepted")).toMatchObject([{ exampleId: "open-store" }]);
    expect(replies(portal, "example-refused")).toEqual([]);
  });

  it("refuses a digest from another build, and says why", async () => {
    const { portal, ran, ask } = await bridged();
    ask({ digest: "c".repeat(64) });
    await settle(4);
    expect(ran).toEqual([]);
    expect(replies(portal, "example-refused")[0]?.reason).toMatch(/does not recognise/);
  });

  it("refuses a name nobody registered", async () => {
    const { portal, ran, ask } = await bridged();
    ask({ exampleId: "rm-rf" });
    await settle(4);
    expect(ran).toEqual([]);
    expect(replies(portal, "example-refused")[0]?.reason).toMatch(/no example is registered/);
  });

  it("refuses everything when the playground registered nothing at all", async () => {
    const { portal, ask } = await bridged({ examples: false });
    ask();
    await settle(4);
    expect(replies(portal, "example-refused")[0]?.reason).toMatch(/registers no examples/);
  });

  it("cannot be handed Python - a source field in the message is simply not read", async () => {
    const { ran, ask, entries } = await bridged();
    ask({ source: 'os.system("rm -rf /")', code: "print('pwned')" });
    await settle(4);
    // The extra fields changed nothing: what ran is what the manifest holds.
    expect(ran).toEqual([entries[0]]);
    expect(ran[0].source).toBe(SOURCE);
  });

  it("ignores a message addressed to a different playground, without answering it", async () => {
    const { portal, ran, ask } = await bridged();
    ask({ targetSession: "some-other-frame" });
    await settle(4);
    expect(ran).toEqual([]);
    // Silence, not a refusal: the frame that was not meant has nothing to report.
    expect(replies(portal, "example-refused")).toEqual([]);
    expect(replies(portal, "example-accepted")).toEqual([]);
  });

  it("accepts a message addressed to THIS playground by name", async () => {
    const { ran, ask, bridge, entries } = await bridged();
    ask({ targetSession: bridge.sessionId });
    await settle(4);
    expect(ran).toEqual([entries[0]]);
  });

  it("refuses a request that arrives outside the current conversation", async () => {
    const { portal, playground, bridge, ran, entries } = await bridged();
    playground.inject({
      channel: EMBED_CHANNEL,
      version: EMBED_PROTOCOL_VERSION,
      challenge: "a-challenge-the-parent-never-issued",
      sessionId: bridge.sessionId,
      kind: "run-example",
      exampleId: "open-store",
      digest: entries[0].sha256,
    });
    await settle(4);
    expect(ran).toEqual([]);
    expect(replies(portal, "example-accepted")).toEqual([]);
  });

  it("refuses a request from the wrong origin", async () => {
    const { playground, ran, bridge, entries } = await bridged();
    playground.inject(
      {
        channel: EMBED_CHANNEL,
        version: EMBED_PROTOCOL_VERSION,
        challenge: "challenge-1",
        sessionId: bridge.sessionId,
        kind: "run-example",
        exampleId: "open-store",
        digest: entries[0].sha256,
      },
      { origin: "https://evil-portal.test" },
    );
    await settle(4);
    expect(ran).toEqual([]);
  });

  it("reports a failure from the page's own runner rather than swallowing it", async () => {
    const worker = healthyWorker();
    const python = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
    await python.start();
    const { portal, playground } = connectedWindows(PORTAL, PLAY);
    const entries = await manifest();
    const bridge = attachPlaygroundBridge({
      engine: python,
      hostOrigin: PORTAL,
      scope: playground as unknown as Window,
      examples: createExampleRegistry(entries),
      onRunExample: () => {
        throw new Error("the interpreter went away");
      },
    });
    stops.push(() => bridge.stop());
    await settle();
    playground.inject({
      channel: EMBED_CHANNEL,
      version: EMBED_PROTOCOL_VERSION,
      challenge: "c",
      sessionId: "",
      kind: "hail",
    });
    await settle(4);
    playground.inject({
      channel: EMBED_CHANNEL,
      version: EMBED_PROTOCOL_VERSION,
      challenge: "c",
      sessionId: bridge.sessionId,
      kind: "run-example",
      exampleId: "open-store",
      digest: entries[0].sha256,
    });
    await settle(4);
    expect(replies(portal, "example-refused")[0]?.reason).toBe("the interpreter went away");
  });
});

describe("the host half", () => {
  it("refuses to send a malformed request at all", async () => {
    const { createPlaygroundHost } = await import("../src/embed/host.js");
    const { portal, playground } = connectedWindows(PORTAL, PLAY);
    const frame = {
      contentWindow: playground,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLIFrameElement;
    const host = createPlaygroundHost({
      frame,
      playgroundOrigin: PLAY,
      scope: portal as unknown as Window,
    });
    // Before a handshake there is no session, which is its own refusal.
    expect(() => host.runExample("open-store", "a".repeat(64))).toThrow(/handshake/);
    void host.stop();
  });
});
