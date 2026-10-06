// Setup validation, the policy fingerprint, streaming SHA-256 and live slots.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MAX_LIVE_INTERPRETERS,
  Sha256,
  createSlotBroker,
  describeResources,
  describeSetup,
  policyFingerprint,
  validateSetup,
  type SessionPolicy,
} from "../../src/session/index.js";
import { FakeLocks } from "./fakes.js";

const POLICY: SessionPolicy = {
  profiles: {
    minimal: { allowedAddons: [] },
    "xarray-zarr": { allowedAddons: ["dask", "cartopy-natural-earth-110m"] },
  },
  starter: true,
  starterProfiles: ["xarray-zarr"],
  allowSkipStarter: false,
  notebook: false,
  defaults: { profile: "xarray-zarr", addons: [], runStarter: true, frontend: "console" },
};

const choice = (over: Record<string, unknown> = {}) => ({
  profile: "xarray-zarr",
  addons: ["dask"],
  runStarter: true,
  frontend: "console",
  ...over,
});

describe("validateSetup", () => {
  it("accepts an allowed setup and normalises the add-on order", () => {
    const check = validateSetup(POLICY, choice({ addons: ["dask", "cartopy-natural-earth-110m"] }));
    expect(check).toEqual({
      ok: true,
      setup: {
        profile: "xarray-zarr",
        addons: ["cartopy-natural-earth-110m", "dask"],
        runStarter: true,
        frontend: "console",
      },
    });
    if (check.ok) expect(Object.isFrozen(check.setup)).toBe(true);
  });

  it.each([
    [
      "an unknown profile",
      choice({ profile: "freva-client" }),
      /profile "freva-client" is not offered/,
    ],
    ["a prototype key as a profile", choice({ profile: "__proto__" }), /not offered/],
    [
      "an add-on not allowed with the profile",
      choice({ profile: "minimal", addons: ["dask"], runStarter: false }),
      /'dask' is not offered with 'minimal'/,
    ],
    ["a duplicate add-on", choice({ addons: ["dask", "dask"] }), /listed twice/],
    ["a package name", choice({ addons: ["numpy"] }), /'numpy' is not offered/],
    [
      "a starter where none runs",
      choice({ profile: "minimal", addons: [] }),
      /does not run on 'minimal'/,
    ],
    [
      "skipping a starter that cannot be skipped",
      choice({ runStarter: false }),
      /cannot be skipped/,
    ],
    [
      "the notebook where it is not offered",
      choice({ frontend: "notebook" }),
      /front end "notebook"/,
    ],
    ["an extra field", { ...choice(), source: "import os" }, /unknown field\(s\): source/],
    ["not an object", ["xarray-zarr"], /must be an object/],
  ])("refuses %s", (_name, candidate, problem) => {
    const check = validateSetup(POLICY, candidate);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.join("; ")).toMatch(problem);
  });

  it("lets the starter be skipped only where the policy says so", () => {
    expect(
      validateSetup({ ...POLICY, allowSkipStarter: true }, choice({ runStarter: false })).ok,
    ).toBe(true);
  });

  it("describes a setup in one line", () => {
    expect(
      describeSetup({
        profile: "xarray-zarr",
        addons: ["dask"],
        runStarter: false,
        frontend: "console",
      }),
    ).toBe("xarray-zarr + dask · no starter · console");
  });
});

describe("policyFingerprint", () => {
  it("ignores ordering and changes with any decision", () => {
    const reordered: SessionPolicy = {
      ...POLICY,
      profiles: {
        "xarray-zarr": { allowedAddons: ["cartopy-natural-earth-110m", "dask"] },
        minimal: { allowedAddons: [] },
      },
    };
    expect(policyFingerprint(reordered)).toBe(policyFingerprint(POLICY));
    expect(policyFingerprint({ ...POLICY, allowSkipStarter: true })).not.toBe(
      policyFingerprint(POLICY),
    );
    expect(policyFingerprint(POLICY)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Sha256", () => {
  it("matches node's digest for any split of the input", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 128, 1000, 70_000]) {
      const data = new Uint8Array(length).map((_, i) => (i * 31 + length) & 0xff);
      const expected = createHash("sha256").update(data).digest("hex");
      expect(new Sha256().update(data).digest()).toBe(expected);
      const split = new Sha256();
      for (let at = 0; at < length; at += 37) split.update(data.subarray(at, at + 37));
      expect(split.digest()).toBe(expected);
    }
  });
});

describe("slots", () => {
  it("never holds more than two, whatever is asked", async () => {
    const broker = createSlotBroker({ capacity: 5 });
    expect(broker.capacity).toBe(MAX_LIVE_INTERPRETERS);
    const all = await Promise.all([broker.reserve("a"), broker.reserve("b"), broker.reserve("c")]);
    expect(all.map((slot) => slot?.index ?? null)).toEqual([0, 1, null]);
    all[0]!.release();
    all[0]!.release();
    expect(await broker.held()).toBe(1);
    expect((await broker.reserve("d"))?.index).toBe(0);
  });

  it("when all are taken, the least recently used idle holder sleeps; running ones never", async () => {
    const broker = createSlotBroker({ capacity: 2 });
    const slept: string[] = [];
    const holder = (name: string, used: number, state: { idle: boolean; refuse?: boolean }) => {
      let slot: { release(): void } | null = null;
      const h = {
        idle: () => state.idle,
        lastUsed: () => used,
        sleep: async () => {
          if (state.refuse) throw new Error("cannot sleep now");
          slept.push(name);
          slot?.release();
        },
      };
      return { h, set: (s: { release(): void } | null) => (slot = s) };
    };
    const older = holder("older", 1, { idle: true });
    const newer = holder("newer", 2, { idle: true });
    older.set(await broker.reserve("older", older.h));
    newer.set(await broker.reserve("newer", newer.h));
    const third = await broker.reserve("third");
    expect(third).not.toBeNull();
    expect(slept).toEqual(["older"]);
    // A holder running code, or one that cannot sleep now, is left alone.
    const busy = holder("busy", 0, { idle: false });
    const stubborn = holder("stubborn", 0, { idle: true, refuse: true });
    third!.release();
    newer.set(null);
    const b2 = createSlotBroker({ capacity: 2 });
    busy.set(await b2.reserve("busy", busy.h));
    stubborn.set(await b2.reserve("stubborn", stubborn.h));
    expect(await b2.reserve("fourth")).toBeNull();
    expect(slept).toEqual(["older"]);
  });

  it("across documents of one page, the least recently used idle holder elsewhere sleeps", async () => {
    // One page, two frames: shared Web Locks and a shared channel.
    const locks = new FakeLocks();
    const listeners = new Set<(event: { data: unknown }) => void>();
    const bus = () => ({
      postMessage: (data: unknown) =>
        setTimeout(() => listeners.forEach((l) => l({ data: structuredClone(data) })), 0),
      addEventListener: (_: "message", l: (event: { data: unknown }) => void) =>
        void listeners.add(l),
    });
    const options = { capacity: 1, scope: "page", locks, channel: bus, offerWindowMs: 20 };
    const frameA = createSlotBroker(options);
    const frameB = createSlotBroker(options);
    let busy = true;
    let slot: { release(): void } | null = null;
    slot = await frameA.reserve("a", {
      idle: () => !busy,
      lastUsed: () => 1,
      sleep: async () => slot?.release(),
    });
    // Running code in frame A: frame B is refused.
    expect(await frameB.reserve("b")).toBeNull();
    // Idle: frame A's interpreter sleeps and frame B gets the slot.
    busy = false;
    expect(await frameB.reserve("b")).not.toBeNull();
    expect(await frameA.held()).toBe(1);
  });

  it("a late request to sleep names its reservation: the slot's next holder is not put to sleep", async () => {
    const locks = new FakeLocks();
    const listeners = new Set<(event: { data: unknown }) => void>();
    const posted: Array<Record<string, unknown>> = [];
    const bus = () => ({
      postMessage: (data: unknown) => {
        posted.push(structuredClone(data) as Record<string, unknown>);
        setTimeout(() => listeners.forEach((l) => l({ data: structuredClone(data) })), 0);
      },
      addEventListener: (_: "message", l: (event: { data: unknown }) => void) =>
        void listeners.add(l),
    });
    const broker = createSlotBroker({ capacity: 1, scope: "page", locks, channel: bus });
    const send = (data: Record<string, unknown>) =>
      listeners.forEach((l) => l({ data: structuredClone(data) }));
    const slept: string[] = [];
    const holder = (name: string, slot: { current: { release(): void } | null }) => ({
      idle: () => true,
      lastUsed: () => 1,
      sleep: async () => {
        slept.push(name);
        slot.current?.release();
      },
    });
    const first = { current: null as { release(): void } | null };
    first.current = await broker.reserve("first", holder("first", first));
    // Another document asks; the first holder is offered, by its reservation.
    send({ t: "ask", id: "q1", from: "elsewhere" });
    await new Promise((r) => setTimeout(r, 5));
    const offer = posted.find((m) => m.t === "offer")!;
    expect(offer).toMatchObject({ index: 0, reservation: expect.any(String) });
    // Before that document's request arrives, the first holder lets go and a second takes slot 0.
    first.current!.release();
    const second = { current: null as { index: number; release(): void } | null };
    second.current = await broker.reserve("second", holder("second", second));
    expect(second.current?.index).toBe(0);
    // The request for the first reservation comes now: nothing sleeps.
    send({
      t: "sleep",
      id: "s1",
      from: "elsewhere",
      to: offer.from,
      index: 0,
      reservation: offer.reservation,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(slept).toEqual([]);
    expect(posted.find((m) => m.t === "slept")).toMatchObject({ ok: false });
    // One naming the second reservation does.
    send({ t: "ask", id: "q2", from: "elsewhere" });
    await new Promise((r) => setTimeout(r, 5));
    const next = posted.filter((m) => m.t === "offer").at(-1)!;
    expect(next.reservation).not.toBe(offer.reservation);
    send({
      t: "sleep",
      id: "s2",
      from: "elsewhere",
      to: next.from,
      index: 0,
      reservation: next.reservation,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(slept).toEqual(["second"]);
  });

  it("a slot reserved before its holder existed can be reclaimed once claimed", async () => {
    const broker = createSlotBroker({ capacity: 1 });
    const early = (await broker.reserve("chooser"))!;
    expect(await broker.reserve("other")).toBeNull();
    early.claim?.({ idle: () => true, lastUsed: () => 0, sleep: async () => early.release() });
    expect(await broker.reserve("other")).not.toBeNull();
  });

  it("concurrent reservations across documents get distinct slots through Web Locks", async () => {
    const locks = new FakeLocks();
    const a = createSlotBroker({ capacity: 2, scope: "page-1", locks });
    const b = createSlotBroker({ capacity: 2, scope: "page-1", locks });
    const other = createSlotBroker({ capacity: 2, scope: "page-2", locks });
    const got = await Promise.all([a.reserve("x"), b.reserve("y"), a.reserve("z")]);
    expect(
      got
        .filter(Boolean)
        .map((slot) => slot!.index)
        .sort(),
    ).toEqual([0, 1]);
    expect(got.filter((slot) => slot === null)).toHaveLength(1);
    expect(await a.held()).toBe(2);
    expect(await other.reserve("w")).not.toBeNull();
    got.find(Boolean)!.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(await b.reserve("again")).not.toBeNull();
  });
});

describe("describeResources", () => {
  it("names only what was measured", () => {
    expect(
      describeResources({
        workerGeneration: "g",
        sampledAt: 0,
        wasmCapacityBytes: 300 * 1024 * 1024,
        workspaceBytes: 2048,
        pendingExecutions: 0,
        activeTransfers: 0,
        sampleStale: true,
        live: 1,
        capacity: 2,
      }),
    ).toBe("WASM 300.0 MiB · files 2.0 KiB · 1/2 live · busy, last sample");
  });
});
