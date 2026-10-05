// The session lifecycle against an in-memory engine and store.
import { describe, expect, it } from "vitest";

import {
  SessionController,
  createSlotBroker,
  openCheckpointStore,
  type CheckpointStore,
  type SessionSetup,
  type SlotBroker,
} from "../../src/session/index.js";
import { CHECKPOINT_ROOT } from "../../src/session/checkpoint.js";
import { FakeEngine, FakeLocks, MemoryDirectory } from "./fakes.js";

const SETUP: SessionSetup = {
  profile: "xarray-zarr",
  addons: ["dask"],
  runStarter: true,
  frontend: "console",
};

async function harness(
  options: { slots?: SlotBroker; store?: CheckpointStore | null; id?: string } = {},
) {
  const root = new MemoryDirectory();
  const store =
    options.store !== undefined
      ? options.store
      : await openCheckpointStore({ root, locks: new FakeLocks(), estimate: null });
  const engines: FakeEngine[] = [];
  const attached: string[] = [];
  const order: string[] = [];
  const controller = new SessionController({
    id: options.id ?? "s1",
    setup: SETUP,
    policy: "fp",
    slots: options.slots ?? createSlotBroker({ capacity: 2 }),
    createEngine: (setup) => {
      expect(setup).toEqual(SETUP);
      const engine = new FakeEngine(`g${engines.length + 1}`);
      engine.log = order;
      engines.push(engine);
      return engine.asEngine();
    },
    store: () => Promise.resolve(store),
    starter: async () => {
      order.push("starter");
    },
    attach: (engine) => {
      attached.push((engine as unknown as FakeEngine).label);
      order.push("attach");
    },
    detach: (engine) => attached.push(`-${(engine as unknown as FakeEngine).label}`),
    retainedBytes: () => 42,
  });
  const states: string[] = [];
  controller.onChange((snapshot) => states.push(snapshot.state));
  return { controller, engines, attached, order, states, root, store };
}

describe("SessionController", () => {
  it("a close during start gives back the slot and leaves no interpreter running", async () => {
    // While the slot is being reserved.
    const inner = createSlotBroker({ capacity: 1 });
    let letReserve: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (letReserve = resolve));
    const slots: SlotBroker = {
      capacity: inner.capacity,
      reserve: async (owner) => {
        await gate;
        return inner.reserve(owner);
      },
      held: () => inner.held(),
      onChange: (listener) => inner.onChange(listener),
    };
    const a = await harness({ slots, id: "a" });
    const starting = a.controller.start();
    await a.controller.close();
    letReserve();
    await expect(starting).rejects.toThrow(/closed while it started/);
    expect(a.engines).toHaveLength(0);
    expect(await inner.held()).toBe(0);
    expect(a.controller.state).toBe("closed");

    // While the interpreter is starting.
    const b = await harness({ slots: inner, id: "b" });
    const booting = b.controller.start();
    await Promise.resolve();
    await b.controller.close();
    await booting.catch(() => undefined);
    expect(b.engines.every((engine) => engine.disposed)).toBe(true);
    expect(await inner.held()).toBe(0);
    expect(b.controller.state).toBe("closed");
  });

  it("starts once for concurrent clicks, with the setup locked", async () => {
    const { controller, engines, states } = await harness();
    await Promise.all([controller.start(), controller.start(), controller.start()]);
    expect(engines).toHaveLength(1);
    expect(controller.state).toBe("ready");
    expect(states).toEqual(["configured", "starting", "ready"]);
    expect(Object.isFrozen(controller.setup)).toBe(true);
    expect(controller.snapshot().generation).toBe(1);
  });

  it("refuses a third live interpreter on the page while both others run code", async () => {
    const slots = createSlotBroker({ capacity: 2 });
    const [a, b, c] = await Promise.all([
      harness({ slots, id: "a" }),
      harness({ slots, id: "b" }),
      harness({ slots, id: "c" }),
    ]);
    await a.controller.start();
    await b.controller.start();
    a.engines[0]!.emit("busy");
    b.engines[0]!.emit("busy");
    await expect(c.controller.start()).rejects.toMatchObject({ code: "no-slot" });
    expect(c.engines).toHaveLength(0);
    expect(c.controller.snapshot()).toMatchObject({
      state: "configured",
      message: expect.stringMatching(/in use by code that is running/),
    });
    expect(a.controller.state).toBe("busy");
    expect(b.controller.state).toBe("busy");
    a.engines[0]!.emit("ready");
    await a.controller.sleep();
    await c.controller.start();
    expect(c.controller.state).toBe("ready");
  });

  it("sleeps and wakes: files byte-identical, restored before the starter, Python state lost", async () => {
    const { controller, engines, attached, order } = await harness();
    await controller.start();
    const first = engines[0]!;
    const data = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);
    first.files.set("out/data.bin", data);
    first.files.set("note.txt", new TextEncoder().encode("kept"));
    await controller.sleep();
    expect(controller.state).toBe("asleep");
    expect(first.disposed).toBe(true);
    expect(attached).toEqual(["g1", "-g1"]);
    expect(controller.snapshot().checkpoint).toEqual({ files: 2, bytes: 5004 });

    order.length = 0;
    await controller.wake();
    const second = engines[1]!;
    expect(controller.state).toBe("ready");
    expect(second.files.get("out/data.bin")).toEqual(data);
    expect(new TextDecoder().decode(second.files.get("note.txt"))).toBe("kept");
    expect(order).toEqual(["start", "write out/data.bin", "write note.txt", "attach", "starter"]);
    expect(controller.snapshot().generation).toBe(2);
    expect(controller.snapshot().checkpoint).toBeUndefined();
  });

  it("does not sleep while Python is busy or a file is open, and nothing changes", async () => {
    const { controller, engines } = await harness();
    await controller.start();
    engines[0]!.busy = true;
    await expect(controller.sleep()).rejects.toMatchObject({ code: "busy" });
    engines[0]!.busy = false;
    engines[0]!.files.set("a.nc", new Uint8Array(1));
    engines[0]!.open.add("a.nc");
    await expect(controller.sleep()).rejects.toThrow(/a\.nc is open/);
    expect(controller.state).toBe("ready");
    expect(engines[0]!.disposed).toBe(false);
  });

  it("does not sleep with a file it could not restore on wake, and stays awake", async () => {
    const { controller, engines } = await harness();
    await controller.start();
    // Valid for Python, deeper than a workspace import accepts.
    const deep = `${Array.from({ length: 17 }, (_, i) => `d${i}`).join("/")}`;
    engines[0]!.files.set(deep, new Uint8Array(1));
    await expect(controller.sleep()).rejects.toThrow(/could not be restored on wake/);
    expect(controller.state).toBe("ready");
    expect(engines[0]!.disposed).toBe(false);
  });

  it("refuses to sleep where files cannot be kept", async () => {
    const { controller, engines } = await harness({ store: null });
    await controller.start();
    await expect(controller.sleep()).rejects.toMatchObject({ code: "unsupported" });
    expect(engines[0]!.disposed).toBe(false);
  });

  it("a damaged checkpoint is quarantined, the slot is released, and the session reports it", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const { controller, engines, root, store } = await harness({ slots });
    await controller.start();
    engines[0]!.files.set("a.bin", new Uint8Array(3000).fill(1));
    await controller.sleep();
    const stored = await root.at(CHECKPOINT_ROOT, "s1", "f0");
    stored.bytes[10] = 2;
    await expect(controller.wake()).rejects.toThrow(/does not match its digest/);
    expect(controller.state).toBe("wake-error");
    expect(controller.snapshot().message).toMatch(/could not wake/);
    expect(engines[1]!.files.has("a.bin")).toBe(false);
    expect(engines[1]!.disposed).toBe(true);
    expect(await slots.held()).toBe(0);
    await expect(store!.read("s1")).rejects.toMatchObject({ code: "quarantined" });
  });

  it("a storage error while waking is not damage: nothing is quarantined, and Wake works again", async () => {
    const { controller, engines, root, store } = await harness();
    await controller.start();
    engines[0]!.files.set("a.bin", new Uint8Array(300).fill(1));
    await controller.sleep();
    // The manifest fails to read once, as storage can for a moment.
    const manifest = await root.at(CHECKPOINT_ROOT, "s1", "manifest.json");
    const getFile = manifest.getFile.bind(manifest);
    manifest.getFile = () => {
      manifest.getFile = getFile;
      return Promise.reject(new DOMException("in use", "NoModificationAllowedError"));
    };
    await expect(controller.wake()).rejects.toMatchObject({ code: "io" });
    expect(controller.state).toBe("wake-error");
    await expect(store!.read("s1")).resolves.toMatchObject({ id: "s1" });
    await controller.wake();
    expect(controller.state).toBe("ready");
    expect(engines.at(-1)!.files.get("a.bin")).toEqual(new Uint8Array(300).fill(1));
  });

  it("waking without a free slot stays asleep and says why", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const one = await harness({ slots, id: "one" });
    const two = await harness({ slots, id: "two" });
    await one.controller.start();
    await one.controller.sleep();
    await two.controller.start();
    two.engines[0]!.emit("busy");
    await expect(one.controller.wake()).rejects.toMatchObject({ code: "no-slot" });
    expect(one.controller.state).toBe("asleep");
    expect(one.controller.snapshot().message).toMatch(/slots on this page are in use/);
  });

  it("a session needing a slot puts the least recently used idle one to sleep, files kept", async () => {
    const slots = createSlotBroker({ capacity: 2 });
    const a = await harness({ slots, id: "a" });
    const b = await harness({ slots, id: "b" });
    const c = await harness({ slots, id: "c" });
    await a.controller.start();
    await b.controller.start();
    // b ran code more recently than a.
    await new Promise((r) => setTimeout(r, 5));
    b.engines[0]!.emit("busy");
    b.engines[0]!.emit("ready");
    a.engines[0]!.files.set("kept.txt", new Uint8Array([1, 2, 3]));
    await c.controller.start();
    expect(c.controller.state).toBe("ready");
    expect(a.controller.snapshot()).toMatchObject({
      state: "asleep",
      message: expect.stringMatching(/make room for another session/),
      checkpoint: { files: 1 },
    });
    expect(a.engines[0]!.disposed).toBe(true);
    expect(b.controller.state).toBe("ready");
    expect(await slots.held()).toBe(2);
    // Waking it in turn puts the least recently used of the others to sleep.
    await a.controller.wake();
    expect(a.controller.state).toBe("ready");
    expect(a.engines[1]!.files.get("kept.txt")).toEqual(new Uint8Array([1, 2, 3]));
    expect([b.controller.state, c.controller.state].sort()).toEqual(["asleep", "ready"]);
  });

  it("follows the engine's own busy and crash states while live", async () => {
    const { controller, engines } = await harness();
    await controller.start();
    engines[0]!.emit("busy");
    expect(controller.state).toBe("busy");
    engines[0]!.emit("ready");
    engines[0]!.emit("error");
    expect(controller.state).toBe("crashed");
    await controller.restart();
    expect(controller.state).toBe("ready");
  });

  it("a crashed worker gives its slot back; restarting it takes one again", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const a = await harness({ slots, id: "a" });
    const b = await harness({ slots, id: "b" });
    await a.controller.start();
    a.engines[0]!.emit("error");
    expect(a.controller.state).toBe("crashed");
    expect(await slots.held()).toBe(0);
    // No interpreter runs for A: B gets the slot.
    await b.controller.start();
    expect(b.controller.state).toBe("ready");
    // A's restart now needs a slot: B, idle, is put to sleep for it.
    await a.controller.restart();
    expect(a.controller.state).toBe("ready");
    expect(b.controller.state).toBe("asleep");
    expect(await slots.held()).toBe(1);
  });

  it("a restart that finds no slot leaves the session crashed, holding nothing", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const a = await harness({ slots, id: "a" });
    const b = await harness({ slots, id: "b" });
    await a.controller.start();
    a.engines[0]!.emit("error");
    await b.controller.start();
    b.engines[0]!.emit("busy");
    await expect(a.controller.restart()).rejects.toThrow(/slots on this page are in use/);
    expect(a.controller.state).toBe("crashed");
    expect(await slots.held()).toBe(1);
  });

  it("uses a slot a chooser reserved before the session existed, and releases it on close", async () => {
    const slots = createSlotBroker({ capacity: 1 });
    const slot = (await slots.reserve("chooser"))!;
    const one = new SessionController({
      id: "pre",
      setup: SETUP,
      policy: "fp",
      slots,
      slot,
      createEngine: () => new FakeEngine("p").asEngine(),
      store: () => Promise.resolve(null),
      attach() {},
      detach() {},
    });
    await one.start();
    expect(one.state).toBe("ready");
    expect(await slots.held()).toBe(1);
    await one.close();
    expect(await slots.held()).toBe(0);
    const unused = new SessionController({
      id: "unused",
      setup: SETUP,
      policy: "fp",
      slots,
      slot: (await slots.reserve("chooser"))!,
      createEngine: () => new FakeEngine("u").asEngine(),
      store: () => Promise.resolve(null),
      attach() {},
      detach() {},
    });
    await unused.close();
    expect(await slots.held()).toBe(0);
  });

  it("reports telemetry with the slot count and the front end's retained output", async () => {
    const { controller } = await harness();
    expect(await controller.resources()).toBeNull();
    await controller.start();
    expect(await controller.resources()).toMatchObject({
      live: 1,
      capacity: 2,
      outputRetainedBytes: 42,
      wasmCapacityBytes: 64 * 1024 * 1024,
    });
  });

  it("close disposes, releases and discards the checkpoint", async () => {
    const slots = createSlotBroker({ capacity: 2 });
    const { controller, root } = await harness({ slots });
    await controller.start();
    await controller.sleep();
    await controller.close();
    expect(controller.state).toBe("closed");
    expect((await root.getDirectoryHandle(CHECKPOINT_ROOT)).entries.size).toBe(0);
    expect(await slots.held()).toBe(0);
    await expect(controller.wake()).rejects.toMatchObject({ code: "state" });
  });
});
