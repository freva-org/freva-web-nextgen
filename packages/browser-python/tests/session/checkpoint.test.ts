// The checkpoint store: manifest-last commits, verified restores, quarantine, limits, sweeping.
import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_ROOT,
  openCheckpointStore,
  type CheckpointStore,
} from "../../src/session/index.js";
import { FakeLocks, MemoryDirectory } from "./fakes.js";

const SETUP = { profile: "minimal", addons: [], runStarter: false, frontend: "console" } as const;

async function store(
  options: { root?: MemoryDirectory; locks?: FakeLocks | null; quota?: number } = {},
) {
  const root = options.root ?? new MemoryDirectory();
  const opened = await openCheckpointStore({
    root,
    locks: options.locks === undefined ? new FakeLocks() : options.locks,
    estimate:
      options.quota === undefined
        ? null
        : () => Promise.resolve({ quota: options.quota!, usage: 0 }),
    limits: { maxFiles: 4, maxBytes: 4096, reserveBytes: 100 },
  });
  return { root, store: opened as CheckpointStore };
}

async function save(s: CheckpointStore, id: string, files: Record<string, Uint8Array>) {
  const writer = await s.begin(
    id,
    Object.entries(files).map(([name, bytes]) => ({ name, size: bytes.length })),
  );
  for (const [name, bytes] of Object.entries(files)) {
    const sink = writer.file(name).getWriter();
    await sink.write(bytes);
    await sink.close();
  }
  return writer.commit({ setup: SETUP, policy: "p" });
}

async function drain(
  stream: ReadableStream<Uint8Array>,
): Promise<{ bytes: number[]; error?: string }> {
  const reader = stream.getReader();
  const bytes: number[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes };
      bytes.push(...value);
    }
  } catch (error) {
    return { bytes, error: String(error) };
  }
}

describe("checkpoint store", () => {
  it("two stores opening at once both work: neither removes the other's probe", async () => {
    const root = new MemoryDirectory();
    const opened = await Promise.all(
      [0, 1].map(() => openCheckpointStore({ root, locks: new FakeLocks(), estimate: null })),
    );
    expect(opened.map((s) => s !== null)).toEqual([true, true]);
  });

  it("is null where writable streams are missing", async () => {
    const root = new MemoryDirectory();
    const dir = await root.getDirectoryHandle(CHECKPOINT_ROOT, { create: true });
    const original = dir.getFileHandle.bind(dir);
    dir.getFileHandle = async (name, options) => {
      const file = await original(name, options);
      return Object.assign(Object.create(file), { createWritable: undefined });
    };
    expect(await openCheckpointStore({ root, locks: null })).toBeNull();
  });

  it("round-trips files byte for byte, and the manifest is written last", async () => {
    const { root, store: s } = await store();
    const a = new Uint8Array(3000).map((_, i) => i & 0xff);
    const manifest = await save(s, "s1", {
      "out/a.bin": a,
      "b.txt": new TextEncoder().encode("hi"),
    });
    expect(manifest.files.map((f) => f.name)).toEqual(["out/a.bin", "b.txt"]);
    expect(manifest.totalBytes).toBe(3002);
    const read = await s.read("s1");
    expect(read).toEqual(manifest);
    const back = await drain(s.open(read, read.files[0]!));
    expect(back.error).toBeUndefined();
    expect(Uint8Array.from(back.bytes)).toEqual(a);
    expect((await root.getDirectoryHandle(CHECKPOINT_ROOT)).entries.get("s1")).toBeDefined();
  });

  it("an incomplete checkpoint is never restored and is listed as quarantined", async () => {
    const { store: s } = await store();
    const writer = await s.begin("s2", [{ name: "a", size: 2 }]);
    const sink = writer.file("a").getWriter();
    await sink.write(new Uint8Array([1, 2]));
    await sink.close();
    await expect(s.read("s2")).rejects.toMatchObject({ code: "corrupt" });
    expect((await s.list()).quarantined.map((q) => q.id)).toEqual(["s2"]);
  });

  it("a tampered file errors the stream before its last byte is handed over", async () => {
    const { root, store: s } = await store();
    const manifest = await save(s, "s3", { "a.bin": new Uint8Array(2500).fill(7) });
    const stored = await root.at(CHECKPOINT_ROOT, "s3", "f0");
    stored.bytes[2499] = 8;
    const back = await drain(s.open(manifest, manifest.files[0]!));
    expect(back.error).toMatch(/does not match its digest/);
    expect(back.bytes.length).toBeLessThan(2500);
  });

  it("a file of the wrong length is refused before streaming", async () => {
    const { root, store: s } = await store();
    const manifest = await save(s, "s4", { "a.bin": new Uint8Array(10) });
    (await root.at(CHECKPOINT_ROOT, "s4", "f0")).bytes = new Uint8Array(11);
    expect((await drain(s.open(manifest, manifest.files[0]!))).error).toMatch(/11 bytes, not 10/);
  });

  it("an edited manifest fails its seal; a quarantined checkpoint is refused", async () => {
    const { root, store: s } = await store();
    await save(s, "s5", { "a.bin": new Uint8Array(4) });
    const file = await root.at(CHECKPOINT_ROOT, "s5", "manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(file.bytes));
    manifest.files[0].name = "../escape";
    file.bytes = new TextEncoder().encode(JSON.stringify(manifest));
    await expect(s.read("s5")).rejects.toThrow(/not a workspace file name/);
    manifest.files[0].name = "other.bin";
    file.bytes = new TextEncoder().encode(JSON.stringify(manifest));
    await expect(s.read("s5")).rejects.toThrow(/fails its seal/);
    await s.quarantine("s5", "digest mismatch");
    await expect(s.read("s5")).rejects.toMatchObject({ code: "quarantined" });
  });

  it("enforces its limits and the browser's quota before writing anything", async () => {
    const { root, store: s } = await store({ quota: 1000 });
    await expect(
      s.begin(
        "x",
        Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, size: 1 })),
      ),
    ).rejects.toMatchObject({ code: "limit" });
    await expect(s.begin("x", [{ name: "big", size: 5000 }])).rejects.toMatchObject({
      code: "limit",
    });
    await expect(s.begin("x", [{ name: "a", size: 950 }])).rejects.toMatchObject({ code: "quota" });
    expect((await root.getDirectoryHandle(CHECKPOINT_ROOT)).entries.has("x")).toBe(false);
  });

  it("a file that changes size while being saved fails the write", async () => {
    const { store: s } = await store();
    const writer = await s.begin("s6", [{ name: "a", size: 4 }]);
    const sink = writer.file("a").getWriter();
    await sink.write(new Uint8Array(3));
    await expect(sink.close()).rejects.toThrow(/changed size/);
    await expect(writer.commit({ setup: SETUP, policy: "p" })).rejects.toThrow(/not saved: a/);
    await writer.abort();
  });

  it("sweeps checkpoints no session owns, and keeps owned ones", async () => {
    const locks = new FakeLocks();
    const { root, store: first } = await store({ locks });
    await save(first, "kept", { a: new Uint8Array(1) });
    const dir = await root.getDirectoryHandle(CHECKPOINT_ROOT);
    await dir.getDirectoryHandle("orphan", { create: true });
    await store({ root, locks });
    expect([...dir.entries.keys()].sort()).toEqual(["kept"]);
    await first.discard("kept");
    expect(locks.held.size).toBe(0);
  });

  it("the sweep never deletes a checkpoint whose ownership was taken after any snapshot", async () => {
    const locks = new FakeLocks();
    // A lock manager whose query answers with an earlier, stale picture: nobody holds anything.
    const stale = Object.assign(Object.create(locks) as FakeLocks, {
      query: () => Promise.resolve({ held: [], pending: [] }),
    });
    const { root } = await store({ locks: stale });
    const dir = await root.getDirectoryHandle(CHECKPOINT_ROOT);
    await dir.getDirectoryHandle("late", { create: true });
    await dir.getDirectoryHandle("orphan", { create: true });
    // Another frame took "late" and is saving into it.
    locks.held.add("browser-python-checkpoint:late");
    await store({ root, locks: stale });
    expect([...dir.entries.keys()].sort()).toEqual(["late"]);
    locks.held.delete("browser-python-checkpoint:late");
  });

  it("a checkpoint another document owns cannot be overwritten; this document's stores share", async () => {
    const locks = new FakeLocks();
    const root = new MemoryDirectory();
    const one = (await store({ root, locks })).store;
    const two = (await store({ root, locks })).store;
    await save(one, "same", { a: new Uint8Array(1) });
    await two.discard("same");
    expect(locks.held.size).toBe(0);
    locks.held.add("browser-python-checkpoint:elsewhere");
    await expect(two.begin("elsewhere", [])).rejects.toThrow(/belongs to another session/);
  });
});
