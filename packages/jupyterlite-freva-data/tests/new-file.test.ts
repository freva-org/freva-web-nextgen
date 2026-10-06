// Notebook creation: never over an existing file, never two creations on one name.
import { describe, expect, it } from "vitest";

import { FileCreator, isNotFound, type LockRunner } from "../src/new-file.js";

/** A contents store whose lookups and saves take a moment, like a real one. */
function store(existing: string[] = []) {
  const files = new Map<string, string>(existing.map((p) => [p, "old"]));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  return {
    files,
    lookup: async (path: string) => {
      await tick();
      return files.has(path) ? ("present" as const) : ("absent" as const);
    },
    save: async (path: string, content: string) => {
      await tick();
      files.set(path, content);
    },
  };
}

/** One lock shared by several "tabs", as the Web Locks API is across an origin's tabs. */
function sharedLock(): LockRunner {
  let tail: Promise<unknown> = Promise.resolve();
  return (_name, fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

const notFound = () => Object.assign(new Error("Not Found"), { response: { status: 404 } });

describe("FileCreator", () => {
  it("two tabs on one store, same dataset name: two files", async () => {
    const files = store();
    const lock = sharedLock();
    // Two creators: one per tab, each with its own page state, one store and one lock.
    const [a, b] = await Promise.all([
      new FileCreator<string>(files, lock).create("tas", ".ipynb", "tab A"),
      new FileCreator<string>(files, lock).create("tas", ".ipynb", "tab B"),
    ]);
    expect(new Set([a, b])).toEqual(new Set(["tas.ipynb", "tas-1.ipynb"]));
    expect(files.files.get(a)).toBe("tab A");
    expect(files.files.get(b)).toBe("tab B");
  });

  it("skips names already taken", async () => {
    const files = store(["tas.ipynb"]);
    const creator = new FileCreator<string>(files, sharedLock());
    expect(await creator.create("tas", ".ipynb", "1")).toBe("tas-1.ipynb");
    expect(await creator.create("tas", ".ipynb", "2")).toBe("tas-2.ipynb");
    expect(files.files.get("tas.ipynb")).toBe("old");
  });

  it("a lookup that fails for another reason (503) stops the creation: nothing is saved", async () => {
    const files = store(["tas.ipynb"]);
    const creator = new FileCreator<string>(
      {
        lookup: async () => {
          throw Object.assign(new Error("Service Unavailable"), { response: { status: 503 } });
        },
        save: files.save,
      },
      sharedLock(),
    );
    await expect(creator.create("tas", ".ipynb", "new")).rejects.toThrow("Service Unavailable");
    expect([...files.files]).toEqual([["tas.ipynb", "old"]]);
  });

  it("a failed save leaves the name free, and the lock usable", async () => {
    const files = store();
    let fail = true;
    const creator = new FileCreator<string>(
      {
        lookup: files.lookup,
        save: async (path, content) => {
          if (fail) {
            fail = false;
            throw new Error("quota");
          }
          await files.save(path, content);
        },
      },
      sharedLock(),
    );
    await expect(creator.create("tas", ".ipynb", "x")).rejects.toThrow("quota");
    expect(await creator.create("tas", ".ipynb", "x")).toBe("tas.ipynb");
  });

  it("without a shared lock, names are random, so tabs cannot meet on one", async () => {
    const files = store();
    const [a, b] = await Promise.all([
      new FileCreator<string>(files, null).create("tas", ".ipynb", "A"),
      new FileCreator<string>(files, null).create("tas", ".ipynb", "B"),
    ]);
    expect(a).toMatch(/^tas-[0-9a-z]{6}\.ipynb$/);
    expect(a).not.toBe(b);
    expect(files.files.size).toBe(2);
  });

  it("knows a not-found from other errors", () => {
    expect(isNotFound(notFound())).toBe(true);
    expect(isNotFound(Object.assign(new Error(), { response: { status: 503 } }))).toBe(false);
    expect(isNotFound(new Error("network"))).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});
