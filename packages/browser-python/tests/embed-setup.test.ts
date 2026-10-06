// The `setup` capability message: exactly `{profile, addons, runStarter, frontend}` plus a policy
// fingerprint, in both directions, inside envelope version 3; and a bridge that follows a session
// to a new engine after it wakes.
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserPython } from "../src/browser-python.js";
import { createPlaygroundHost } from "../src/embed/host.js";
import { attachPlaygroundBridge } from "../src/embed/playground.js";
import {
  EMBED_CHANNEL,
  EMBED_PROTOCOL_VERSION,
  parseSetupCapability,
} from "../src/embed/protocol.js";
import { connectedWindows, settle, type FakeWindow } from "./embed-fixtures.js";
import { healthyWorker } from "./fake-worker.js";

const PORTAL = "https://portal.test";
const PLAY = "https://play.test";
const POLICY = "a".repeat(64);
const SETUP = {
  profile: "xarray-zarr",
  addons: ["dask"],
  runStarter: true,
  frontend: "console",
} as const;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function frameOf(playground: FakeWindow) {
  return {
    get contentWindow() {
      return playground as unknown as Window;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLIFrameElement;
}

async function wired() {
  const engine = async () => {
    const python = createBrowserPython({
      workerFactory: () => healthyWorker() as unknown as Worker,
    });
    await python.start();
    return python;
  };
  const python = await engine();
  const { portal, playground } = connectedWindows(PORTAL, PLAY);
  const proposals: unknown[] = [];
  const reports: unknown[] = [];
  const bridge = attachPlaygroundBridge({
    engine: python,
    hostOrigin: PORTAL,
    scope: playground as unknown as Window,
    onSetupProposal: (p) => proposals.push(p),
  });
  const host = createPlaygroundHost({
    frame: frameOf(playground),
    playgroundOrigin: PLAY,
    scope: portal as unknown as Window,
    onSetup: (r) => reports.push(r),
  });
  cleanups.push(
    () => void host.stop(),
    () => bridge.stop(),
  );
  await settle(10);
  return { host, bridge, portal, playground, proposals, reports, engine };
}

describe("setup capability", () => {
  it("parses exactly the documented fields", () => {
    const message = { kind: "setup", capabilityVersion: 1, setup: SETUP, policy: POLICY };
    expect(parseSetupCapability(message)).toEqual({
      capabilityVersion: 1,
      setup: SETUP,
      policy: POLICY,
    });
    for (const forged of [
      { ...message, capabilityVersion: 2 },
      { ...message, source: "import os" },
      { ...message, policy: "not-a-digest" },
      { ...message, setup: { ...SETUP, source: "x" } },
      { ...message, setup: { ...SETUP, addons: "dask" } },
      { ...message, setup: { ...SETUP, frontend: "terminal" } },
      { ...message, setup: { ...SETUP, runStarter: "yes" } },
    ]) {
      expect(parseSetupCapability(forged)).toBeNull();
    }
  });

  it("a child reports its locked setup; the parent proposes one; both inside envelope version 3", async () => {
    const { host, bridge, portal, playground, proposals, reports } = await wired();
    expect(bridge.announceSetup({ ...SETUP, addons: [...SETUP.addons] }, POLICY)).toBe(true);
    host.proposeSetup({ ...SETUP, addons: [...SETUP.addons] }, POLICY);
    await settle(4);
    expect(reports).toEqual([{ setup: SETUP, policy: POLICY }]);
    expect(proposals).toEqual([{ setup: SETUP, policy: POLICY }]);
    const sent = portal.received
      .map((r) => r.data as Record<string, unknown>)
      .find((d) => d.kind === "setup");
    expect(sent).toMatchObject({ channel: EMBED_CHANNEL, version: EMBED_PROTOCOL_VERSION });
    expect(Object.keys(sent!).sort()).toEqual(
      [
        "capabilityVersion",
        "challenge",
        "channel",
        "kind",
        "policy",
        "sessionId",
        "setup",
        "version",
      ].sort(),
    );
    expect(playground.received.some((r) => (r.data as { kind?: string }).kind === "setup")).toBe(
      true,
    );
  });

  it("a forged setup message is dropped on both sides", async () => {
    const { host, playground, portal, proposals, reports } = await wired();
    const envelope = {
      channel: EMBED_CHANNEL,
      version: EMBED_PROTOCOL_VERSION,
      sessionId: host.sessionId,
    };
    const challenge = (
      playground.received.find((r) => (r.data as { kind?: string }).kind === "hail")?.data as {
        challenge: string;
      }
    ).challenge;
    playground.inject({
      ...envelope,
      challenge,
      kind: "setup",
      capabilityVersion: 1,
      setup: { ...SETUP, extra: 1 },
      policy: POLICY,
    });
    portal.inject({
      ...envelope,
      challenge,
      kind: "setup",
      capabilityVersion: 1,
      setup: SETUP,
      policy: POLICY,
      code: "x",
    });
    await settle(2);
    expect(proposals).toEqual([]);
    expect(reports).toEqual([]);
    expect(() =>
      host.proposeSetup({ ...SETUP, addons: [], frontend: "x" as never }, POLICY),
    ).toThrow(/not a valid setup/);
  });

  it("a bridge follows the session to a new engine", async () => {
    const { bridge, portal, engine } = await wired();
    portal.received.length = 0;
    const next = await engine();
    bridge.useEngine(next);
    await settle(6);
    expect(portal.received.some((r) => (r.data as { kind?: string }).kind === "artifacts")).toBe(
      true,
    );
  });
});
