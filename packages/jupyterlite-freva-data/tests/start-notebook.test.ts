// @vitest-environment jsdom
// The visitor's own copy of a published notebook (the start notebook, an example): made once,
// theirs after that; known by what it says it is a copy of, never by its name; and never saved
// over a file, with or without the lock the origin's tabs share.
import { describe, expect, it } from "vitest";

import { FileCreator, type LockRunner } from "../src/new-file.js";
import {
  asCopy,
  copyOf,
  findCopy,
  localCopyMemory,
  openOwnCopy,
  openStartNotebook,
  type StartNotebookHost,
} from "../src/start-notebook.js";

const SEED = "examples/era5_july_2021.ipynb";
const NB = { cells: [{ cell_type: "code", outputs: [{ output_type: "display_data" }] }] };

/** One lock for all tabs, as Web Locks gives an origin. */
function sharedLock(): LockRunner {
  let chain: Promise<unknown> = Promise.resolve();
  return (_name, fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };
}

/** Folders and notebooks over a flat map of paths, as the contents listing gives them. */
function copyStore(files: Record<string, unknown>, failRead = new Set<string>()) {
  const notFound = Object.assign(new Error("404"), { status: 404 });
  return {
    list: async (dir: string) => {
      const prefix = dir ? `${dir}/` : "";
      const seen = new Map<string, { name: string; path: string; type: string }>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split("/");
        const child = `${prefix}${name}`;
        seen.set(child, { name: name!, path: child, type: rest.length ? "directory" : "notebook" });
      }
      return [...seen.values()];
    },
    read: async (path: string) => {
      if (failRead.has(path)) throw new Error("storage unavailable");
      if (!(path in files)) throw notFound;
      return files[path];
    },
    isNotFound: (error: unknown) => error === notFound,
  };
}

/** A contents store several tabs share, and a tab on it. */
function store(files: Record<string, unknown>) {
  const saved: string[] = [];
  const contents = {
    lookup: async (path: string) => (path in files ? ("present" as const) : ("absent" as const)),
    save: async (path: string, content: unknown) => {
      saved.push(path);
      files[path] = content;
    },
  };
  const tab = (
    lock: LockRunner | null,
    options: {
      others?: boolean;
      readSeed?: (seed: string) => Promise<unknown>;
      failRead?: Set<string>;
      memory?: ReturnType<typeof localCopyMemory>;
    } = {},
  ) => {
    const creator = new FileCreator<unknown>(contents, lock);
    const opened: Array<[string, boolean]> = [];
    const host: StartNotebookHost = {
      readSeed: options.readSeed ?? (async (seed) => files[seed]),
      // The extension's own search, over this store's folders.
      findCopy: (seed) => findCopy(seed, copyStore(files, options.failRead), options.memory),
      exclusive: (fn) => creator.exclusive(fn),
      allocate: (base, content, locked) => creator.allocate(base, ".ipynb", content, locked),
      open: async (path, activate) => void opened.push([path, activate]),
      otherDocumentOpen: () => options.others ?? false,
    };
    return { host, opened };
  };
  return { files, saved, contents, tab };
}

describe("the visitor's own copy", () => {
  it("first visit: the seed is copied, outputs and all, says what it is a copy of, and opens", async () => {
    const s = store({ [SEED]: NB });
    const t = s.tab(sharedLock());
    expect(await openStartNotebook(SEED, t.host)).toBe("era5_july_2021.ipynb");
    expect(s.saved).toEqual(["era5_july_2021.ipynb"]);
    expect(s.files["era5_july_2021.ipynb"]).toEqual(asCopy(SEED, NB));
    expect(copyOf(s.files["era5_july_2021.ipynb"])).toBe(SEED);
    expect(t.opened).toEqual([["era5_july_2021.ipynb", true]]);
  });

  it("later visits: their copy opens, never overwritten by the seed", async () => {
    const theirs = { ...(asCopy(SEED, NB) as object), edited: true };
    const s = store({ [SEED]: NB, "era5_july_2021.ipynb": theirs });
    await openStartNotebook(SEED, s.tab(sharedLock()).host);
    expect(s.saved).toEqual([]);
    expect(s.files["era5_july_2021.ipynb"]).toBe(theirs);
  });

  it("an unrelated notebook of the same name is not the example's copy, and is left alone", async () => {
    const unrelated = { cells: [], mine: true };
    const s = store({ [SEED]: NB, "era5_july_2021.ipynb": unrelated });
    const t = s.tab(sharedLock());
    expect(await openOwnCopy(SEED, t.host)).toBe("era5_july_2021-1.ipynb");
    expect(s.files["era5_july_2021.ipynb"]).toBe(unrelated);
    expect(copyOf(s.files["era5_july_2021-1.ipynb"])).toBe(SEED);
    // And the next time, that copy.
    expect(await openOwnCopy(SEED, t.host)).toBe("era5_july_2021-1.ipynb");
    expect(s.saved).toEqual(["era5_july_2021-1.ipynb"]);
  });

  it("a document of theirs restored from last time stays in front", async () => {
    const s = store({ [SEED]: NB });
    const t = s.tab(sharedLock(), { others: true });
    await openStartNotebook(SEED, t.host);
    expect(t.opened).toEqual([["era5_july_2021.ipynb", false]]);
  });

  it("a lookup that fails (not a 404) copies nothing", async () => {
    const s = store({ [SEED]: NB });
    s.contents.lookup = async () => {
      throw new Error("storage unavailable");
    };
    await expect(openStartNotebook(SEED, s.tab(sharedLock()).host)).rejects.toThrow(
      "storage unavailable",
    );
    expect(s.saved).toEqual([]);
  });

  it("two tabs at once, with the lock: one copy, and the edits saved to it stay", async () => {
    const s = store({ [SEED]: NB });
    const lock = sharedLock();
    let release!: (value: unknown) => void;
    const slowSeed = new Promise((resolve) => (release = resolve));
    // Tab A finds no copy and waits for the seed...
    const a = openStartNotebook(SEED, s.tab(lock, { readSeed: () => slowSeed }).host);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // ...tab B makes the copy, and the visitor saves edits to it...
    await openStartNotebook(SEED, s.tab(lock).host);
    const edited = { ...(asCopy(SEED, NB) as object), edited: true };
    s.files["era5_july_2021.ipynb"] = edited;
    // ...then A's seed arrives: A finds that copy and opens it.
    release(NB);
    expect(await a).toBe("era5_july_2021.ipynb");
    expect(s.files["era5_july_2021.ipynb"]).toBe(edited);
    expect(s.saved).toEqual(["era5_july_2021.ipynb"]);
  });

  it("two tabs at once, without Web Locks: no save ever lands on a file another tab made", async () => {
    const s = store({ [SEED]: NB });
    // Both look before either saves: the window the lock would have closed.
    let releaseA!: (value: unknown) => void;
    let releaseB!: (value: unknown) => void;
    const seedA = new Promise((resolve) => (releaseA = resolve));
    const seedB = new Promise((resolve) => (releaseB = resolve));
    const a = openOwnCopy(SEED, s.tab(null, { readSeed: () => seedA }).host);
    const b = openOwnCopy(SEED, s.tab(null, { readSeed: () => seedB }).host);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseB(NB);
    const pathB = await b;
    // The visitor edits B's copy; then A's delayed save comes.
    const edited = { ...(asCopy(SEED, NB) as object), edited: true };
    s.files[pathB] = edited;
    releaseA(NB);
    const pathA = await a;
    expect(s.files[pathB]).toBe(edited);
    // Every save went to a name nobody had: none twice.
    expect(new Set(s.saved).size).toBe(s.saved.length);
    expect(pathA === pathB || s.saved.includes(pathA)).toBe(true);
  });

  it("without Web Locks, two tabs saving at the same moment still pick two different names", async () => {
    const s = store({ [SEED]: NB });
    // Every look-up answers before any save lands: both tabs see the same empty store.
    const save = s.contents.save;
    s.contents.save = async (path, content) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await save(path, content);
    };
    const [a, b] = await Promise.all([
      openOwnCopy(SEED, s.tab(null).host),
      openOwnCopy(SEED, s.tab(null).host),
    ]);
    expect(a).not.toBe(b);
    expect(new Set(s.saved).size).toBe(2);
    expect(s.saved).toHaveLength(2);
  });

  it("a copy the visitor renamed, or moved into a folder, is still theirs", async () => {
    const theirs = { ...(asCopy(SEED, NB) as object), edited: true };
    const s = store({ [SEED]: NB, "my-analysis.ipynb": theirs });
    const t = s.tab(sharedLock());
    expect(await openOwnCopy(SEED, t.host)).toBe("my-analysis.ipynb");
    // Moved into a folder.
    s.files["work/july/my-analysis.ipynb"] = theirs;
    delete s.files["my-analysis.ipynb"];
    expect(await openOwnCopy(SEED, t.host)).toBe("work/july/my-analysis.ipynb");
    expect(s.saved).toEqual([]);
  });

  it("where it was last found is checked first, and only trusted if the file still says so", async () => {
    window.localStorage.clear();
    const memory = localCopyMemory("test:copies");
    const theirs = asCopy(SEED, NB);
    const s = store({ [SEED]: NB, "a/kept.ipynb": theirs });
    expect(await openOwnCopy(SEED, s.tab(sharedLock(), { memory }).host)).toBe("a/kept.ipynb");
    expect(memory.get(SEED)).toBe("a/kept.ipynb");
    // Another notebook now at that path is not the copy: the search finds the real one.
    s.files["a/kept.ipynb"] = { cells: [] };
    s.files["b/moved.ipynb"] = theirs;
    expect(await openOwnCopy(SEED, s.tab(sharedLock(), { memory }).host)).toBe("b/moved.ipynb");
  });

  it("a copy that cannot be read stops the opening: no second copy beside it", async () => {
    const theirs = { ...(asCopy(SEED, NB) as object), edited: true };
    const s = store({ [SEED]: NB, "era5_july_2021.ipynb": theirs });
    const t = s.tab(sharedLock(), { failRead: new Set(["era5_july_2021.ipynb"]) });
    await expect(openOwnCopy(SEED, t.host)).rejects.toThrow("storage unavailable");
    expect(s.saved).toEqual([]);
    expect(t.opened).toEqual([]);
  });

  it("an example opens as the visitor's copy too: made once, then theirs", async () => {
    const s = store({ "examples/04_zonal_mean.ipynb": NB });
    const t = s.tab(sharedLock());
    await openOwnCopy("examples/04_zonal_mean.ipynb", t.host);
    await openOwnCopy("examples/04_zonal_mean.ipynb", t.host);
    expect(s.saved).toEqual(["04_zonal_mean.ipynb"]);
    expect(t.opened).toEqual([
      ["04_zonal_mean.ipynb", true],
      ["04_zonal_mean.ipynb", true],
    ]);
  });
});
