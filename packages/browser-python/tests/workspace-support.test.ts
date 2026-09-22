/**
 * The workspace's answers about a browser it cannot use, and its errno discipline.
 *
 * All of this is decided before any storage is touched, which is what makes it testable in Node:
 * feature detection, the errno table, MIME classification, and the diff that turns "the workspace
 * changed" into "these files appeared". An unsupported browser produces a REPORT rather than a
 * failure - an engine that refused to start because one storage API is missing would be a worse
 * product than one that starts, keeps files in memory, and says so.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactWatcher } from "../src/worker/artifacts.js";
import {
  REQUIRED_ERRNOS,
  errnoCodes,
  probeWorkspaceSupport,
  Workspace,
} from "../src/worker/opfs-workspace.js";
import type { ArtifactInfo } from "../src/types.js";

type Globals = typeof globalThis & {
  navigator?: unknown;
  FileSystemFileHandle?: unknown;
};

const globals = globalThis as Globals;

function withGlobals(values: { navigator?: unknown; FileSystemFileHandle?: unknown }): () => void {
  const had = {
    navigator: "navigator" in globals,
    FileSystemFileHandle: "FileSystemFileHandle" in globals,
  };
  const previous = {
    navigator: globals.navigator,
    FileSystemFileHandle: globals.FileSystemFileHandle,
  };
  Object.defineProperty(globals, "navigator", { value: values.navigator, configurable: true });
  Object.defineProperty(globals, "FileSystemFileHandle", {
    value: values.FileSystemFileHandle,
    configurable: true,
  });
  return () => {
    for (const key of ["navigator", "FileSystemFileHandle"] as const) {
      if (had[key]) {
        Object.defineProperty(globals, key, { value: previous[key], configurable: true });
      } else {
        delete globals[key];
      }
    }
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("feature detection", () => {
  it("reports no-opfs when the origin has no private filesystem", () => {
    restore = withGlobals({ navigator: {}, FileSystemFileHandle: undefined });
    expect(probeWorkspaceSupport()).toBe("no-opfs");
  });

  it("reports no-sync-access-handles when OPFS exists but cannot be used synchronously", () => {
    // The shape a browser with OPFS and no sync access handles actually has - which is the one
    // that matters, because everything in this filesystem is built on `open()` being synchronous.
    restore = withGlobals({
      navigator: { storage: { getDirectory: () => Promise.resolve({}) } },
      FileSystemFileHandle: class {},
    });
    expect(probeWorkspaceSupport()).toBe("no-sync-access-handles");
  });

  it("reports nothing when both are present", () => {
    restore = withGlobals({
      navigator: { storage: { getDirectory: () => Promise.resolve({}) } },
      FileSystemFileHandle: class {
        createSyncAccessHandle(): void {}
      },
    });
    expect(probeWorkspaceSupport()).toBeNull();
  });

  it("opens into a status object rather than throwing, and never claims to be available", async () => {
    restore = withGlobals({ navigator: {}, FileSystemFileHandle: undefined });
    const opened = await Workspace.open({ FS: {}, runPython: () => undefined }, { maxFiles: 4 });
    expect("workspace" in opened).toBe(false);
    const status = (opened as { status: { available: boolean; reason?: string; detail?: string } })
      .status;
    expect(status.available).toBe(false);
    expect(status.reason).toBe("no-opfs");
    // The sentence a UI shows. It has to say what a visitor loses, not name an API.
    expect(status.detail).toContain("cannot be written to disk");
    expect(status.detail).toContain("in memory");
  });
});

describe("errno discipline", () => {
  /** A table with everything the filesystem raises, so a test can then remove exactly one. */
  const complete = (): Record<string, number> =>
    Object.fromEntries(REQUIRED_ERRNOS.map((name, index) => [name, index + 1]));

  it("reads the runtime's table rather than carrying a copy of the numbers", () => {
    const table = complete();
    expect(errnoCodes({ ERRNO_CODES: table })).toBe(table);
    expect(errnoCodes({ _module: { ERRNO_CODES: table } })).toBe(table);
  });

  it("refuses to guess when the build does not expose one", () => {
    // Louder than it looks. The first version of this filesystem raised `FS.ErrnoError(28)` under
    // a `// ENOSPC` comment, and 28 is EINVAL - so a full disk was reported to Python as an
    // invalid argument and every test that only checked "an OSError happened" passed. A
    // hard-coded default table here would reintroduce exactly that, silently.
    expect(() => errnoCodes({})).toThrow(/does not expose ERRNO_CODES/);
  });

  it("checks EVERY errno it raises, not a sample of two", () => {
    // Testing only `ENOSPC` and `EMFILE` lets the other eleven be `undefined`, and
    // `new FS.ErrnoError(undefined)` produces an OSError carrying no errno at all: a caller
    // branching on `exc.errno` sees `None`, and the failure it was written to handle is
    // indistinguishable from any other.
    for (const name of REQUIRED_ERRNOS) {
      const table = complete();
      delete table[name];
      expect(() => errnoCodes({ ERRNO_CODES: table })).toThrow(new RegExp(`missing ${name}`));
    }
  });
});

describe("noticing that Python wrote a file", () => {
  let generation = 0;
  const artifact = (
    name: string,
    size: number,
    state: ArtifactInfo["state"] = "ready",
    gen = ++generation,
  ) =>
    ({
      name,
      size,
      modifiedMs: 1_000,
      generation: gen,
      state,
      mime: "text/plain",
    }) satisfies ArtifactInfo;

  function watcherOver(snapshots: ArtifactInfo[][]) {
    let index = 0;
    const posts = vi.fn();
    const workspace = {
      list: () => snapshots[Math.min(index++, snapshots.length - 1)] ?? [],
    };
    return {
      posts,
      watcher: new ArtifactWatcher(
        workspace as unknown as Workspace,
        posts as unknown as (message: unknown) => void,
      ),
    };
  }

  it("splits a change into added, updated and removed", () => {
    const b = artifact("b.txt", 5);
    const { watcher, posts } = watcherOver([
      [artifact("a.txt", 10, "ready", 1)],
      [artifact("a.txt", 20, "ready", 2), b],
      [b],
    ]);
    watcher.settle("exec-1");
    watcher.settle("exec-2");
    watcher.settle("exec-3");
    expect(posts.mock.calls.map(([m]) => [m.added, m.updated, m.removed])).toEqual([
      [["a.txt"], [], []],
      [["b.txt"], ["a.txt"], []],
      [[], [], ["a.txt"]],
    ]);
  });

  it("notices a file that changed STATE without changing size", () => {
    // The staging-to-ready transition, which is the one a UI most needs: closing the last
    // descriptor changes neither the size, nor the timestamp, nor the generation.
    const { watcher, posts } = watcherOver([
      [artifact("a.nc", 100, "open", 7)],
      [artifact("a.nc", 100, "ready", 7)],
    ]);
    watcher.settle("exec-1");
    watcher.settle("exec-2");
    expect(posts.mock.calls[1]?.[0].updated).toEqual(["a.nc"]);
  });

  it("notices a rewrite that keeps the same length and the same millisecond", () => {
    // The case size-and-timestamp fingerprints could not see, and the reason they were replaced:
    // `os.replace()` of a fixed-width record produces identical size, identical `modifiedMs` and
    // completely different bytes, so a UI told nothing changed keeps offering the old contents.
    const { watcher, posts } = watcherOver([
      [artifact("record.bin", 512, "ready", 3)],
      [artifact("record.bin", 512, "ready", 4)],
    ]);
    watcher.settle("exec-1");
    watcher.settle("exec-2");
    expect(posts.mock.calls[1]?.[0].updated).toEqual(["record.bin"]);
  });

  it("says nothing when nothing changed, unless a request is waiting for an answer", () => {
    const same = artifact("a.txt", 10);
    const { watcher, posts } = watcherOver([[same], [same], [same]]);
    watcher.settle("exec-1");
    expect(posts).toHaveBeenCalledTimes(1);
    // A session of arithmetic at the prompt must not emit an empty message per line…
    watcher.settle("exec-2");
    expect(posts).toHaveBeenCalledTimes(1);
    // …but an `artifact-list` request has an id and must always be settled.
    watcher.settle(undefined, "req-7");
    expect(posts).toHaveBeenCalledTimes(2);
    expect(posts.mock.calls[1]?.[0]).toMatchObject({ id: "req-7", added: [], removed: [] });
  });
});
