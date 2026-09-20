/**
 * "Stay signed in" is a promise, and this is the code that either keeps it or admits it cannot.
 *
 * IDBFS holds writes in memory until `syncfs`, so the flush is the whole mechanism: a token
 * written and never flushed does not survive the reload it was persisted for. A flush that fails
 * while the interpreter is STARTING would escape `mountPersistentStorage` and take the whole init
 * with it, so a browser near its storage quota could not start an interpreter at all, over an
 * optional feature. A flush that starts failing LATER, once the quota fills or the origin's
 * storage is evicted, does nothing visible: Python swallows the error so a successful
 * authentication is not failed by it, and `ready` has already reported
 * `credentialsPersisted: true`. A degradation nobody can observe is a lie, so this pins down:
 * never fail startup, never claim persistence that is gone, say so exactly once, and leave
 * nothing behind for Python to find and keep calling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PERSIST_DIR, mountPersistentStorage } from "../src/worker/pyodide-runtime.js";

type SyncOutcome = "ok" | "fail";

/** A Pyodide stand-in whose `syncfs` outcome is scripted per call. */
function fakePyodide(outcomes: SyncOutcome[] = []) {
  const calls: { populate: boolean }[] = [];
  const python: string[] = [];
  const fs = {
    mkdirTree: vi.fn(),
    mount: vi.fn(),
    filesystems: { IDBFS: {} },
    syncfs(populate: boolean, callback: (error: unknown) => void) {
      calls.push({ populate });
      const outcome = outcomes.shift() ?? "ok";
      // Asynchronous, like the real one: the callback is where a quota error arrives.
      queueMicrotask(() => callback(outcome === "ok" ? null : new Error("QuotaExceededError")));
    },
  };
  return {
    calls,
    python,
    api: {
      FS: fs,
      runPython: (source: string) => void python.push(source),
    } as never,
  };
}

const hook = () =>
  (globalThis as unknown as Record<string, unknown>)._freva_browser_syncfs as
    | (() => Promise<unknown>)
    | undefined;

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)._freva_browser_syncfs;
});

describe("mounting", () => {
  it("mounts, populates and reports success", async () => {
    const { api, calls, python } = fakePyodide();
    await expect(mountPersistentStorage(api)).resolves.toBe(true);
    // populate first: reading the token store before the populate lands finds nothing.
    expect(calls[0]).toEqual({ populate: true });
    expect(python.join("\n")).toContain(PERSIST_DIR);
    expect(hook()).toBeTypeOf("function");
  });

  it("reports failure rather than throwing when the mount itself is refused", async () => {
    const { api } = fakePyodide();
    (api as unknown as { FS: { mount: () => void } }).FS.mount = () => {
      throw new Error("IndexedDB is disabled");
    };
    await expect(mountPersistentStorage(api)).resolves.toBe(false);
    expect(hook()).toBeUndefined();
  });

  it("does not fail startup when the FIRST flush fails - that is a degradation, not a fatal", async () => {
    // populate succeeds, the initial flush does not: a browser at its quota.
    const { api } = fakePyodide(["ok", "fail"]);
    await expect(mountPersistentStorage(api)).resolves.toBe(false);
  });

  it("…and leaves no flush hook behind, so Python does not claim persistence it lost", async () => {
    const { api } = fakePyodide(["ok", "fail"]);
    await mountPersistentStorage(api);
    expect(hook()).toBeUndefined();
  });
});

describe("degrading later", () => {
  it("tells the caller once when a flush starts failing mid-session", async () => {
    const degraded = vi.fn();
    const { api } = fakePyodide(["ok", "ok", "fail", "fail"]);
    await mountPersistentStorage(api, degraded);
    expect(degraded).not.toHaveBeenCalled();

    await hook()!();
    expect(degraded).toHaveBeenCalledTimes(1);
    expect(String(degraded.mock.calls[0]![0])).toMatch(/Quota/i);
  });

  it("removes itself, so the next authentication does not flush into a broken store", async () => {
    const { api } = fakePyodide(["ok", "ok", "fail"]);
    await mountPersistentStorage(api, () => {});
    await hook()!();
    expect(hook()).toBeUndefined();
  });

  it("never rejects into Python - a failed flush must not fail a successful login", async () => {
    const { api } = fakePyodide(["ok", "ok", "fail"]);
    await mountPersistentStorage(api, () => {});
    await expect(hook()!()).resolves.toBe(false);
  });

  it("a flush that works reports nothing and stays installed", async () => {
    const degraded = vi.fn();
    const { api } = fakePyodide();
    await mountPersistentStorage(api, degraded);
    await expect(hook()!()).resolves.toBe(true);
    expect(degraded).not.toHaveBeenCalled();
    expect(hook()).toBeTypeOf("function");
  });
});
