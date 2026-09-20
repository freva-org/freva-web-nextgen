/**
 * The history store: recall, prefix navigation, suggestion, reverse search, persistence. All pure
 * logic over an array and one storage object, so none of it needs a browser - which is why
 * `history-store.ts` has no DOM in it: the behaviour with the most edge cases should be the
 * cheapest to test.
 */
import { describe, expect, it } from "vitest";
import {
  HistoryStore,
  historyStorageKey,
  type HistoryStorage,
} from "../../src/console/history-store.js";

/** An in-memory Storage, with an optional failure mode for the unavailable-storage case. */
function fakeStorage(options: { throwOnWrite?: boolean } = {}): HistoryStorage & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (options.throwOnWrite) throw new Error("QuotaExceededError");
      data.set(key, value);
    },
    removeItem: (key) => void data.delete(key),
  };
}

const fill = (store: HistoryStore, ...entries: string[]) => entries.forEach((e) => store.add(e));

describe("recording", () => {
  it("keeps what was submitted, oldest first", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "a = 1", "b = 2");
    expect(store.entries).toEqual(["a = 1", "b = 2"]);
  });

  it("never stores a blank submission - a blank line closes a block, it is not a command", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "", "   ", "\n", "x");
    expect(store.entries).toEqual(["x"]);
  });

  // The whole point of storing a multi-line submission as ONE entry: recalled as four, Up hands
  // back `    return value * 2` on its own, which is not a command anybody can run.
  it("stores a multi-line submission as one entry", () => {
    const store = new HistoryStore({}, fakeStorage());
    const block = "def double(v):\n    return v * 2\n";
    store.add(block);
    expect(store.entries).toEqual([block]);
    expect(store.previous("")?.value).toBe(block);
  });

  it("collapses CONSECUTIVE duplicates only - a repeat after other work is a real event", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "ls()", "ls()", "other", "ls()");
    expect(store.entries).toEqual(["ls()", "other", "ls()"]);
  });

  it("respects maxEntries, dropping the oldest", () => {
    const store = new HistoryStore({ maxEntries: 3 }, fakeStorage());
    fill(store, "1", "2", "3", "4", "5");
    expect(store.entries).toEqual(["3", "4", "5"]);
  });

  it("records nothing at all when disabled", () => {
    const store = new HistoryStore({ enabled: false }, fakeStorage());
    fill(store, "a", "b");
    expect(store.entries).toEqual([]);
    expect(store.previous("")).toBeNull();
  });
});

describe("navigation", () => {
  it("walks backwards through history and forwards again", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "one", "two", "three");
    expect(store.previous("")?.value).toBe("three");
    expect(store.previous("")?.value).toBe("two");
    expect(store.previous("")?.value).toBe("one");
    expect(store.previous("")).toBeNull(); // nothing older
    expect(store.next()?.value).toBe("two");
    expect(store.next()?.value).toBe("three");
  });

  it("filters by the typed prefix", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "ds = xr.open_zarr(A)", "print(1)", "ds = xr.open_zarr(B)");
    expect(store.previous("ds = xr.")?.value).toBe("ds = xr.open_zarr(B)");
    expect(store.previous("ds = xr.")?.value).toBe("ds = xr.open_zarr(A)");
    expect(store.previous("ds = xr.")).toBeNull(); // `print(1)` is not a match
  });

  // The draft is what the user had typed before they started walking. Losing it - which treating
  // "back past the newest" as "empty" does - silently deletes work.
  it("restores the user's own draft when walking past the newest match", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "ds = a", "ds = b");
    store.previous("ds = ");
    store.previous("ds = ");
    expect(store.next()?.value).toBe("ds = b");
    expect(store.next()).toEqual({ value: "ds = ", isDraft: true });
  });

  it("does not move when nothing matches the prefix", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "alpha", "beta");
    expect(store.previous("zzz")).toBeNull();
  });

  it("ignores the prefix entirely when prefixNavigation is off", () => {
    const store = new HistoryStore({ prefixNavigation: false }, fakeStorage());
    fill(store, "alpha", "beta");
    expect(store.previous("zzz")?.value).toBe("beta");
  });

  it("forgets its position after a new submission", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "a", "b");
    store.previous("");
    store.add("c");
    expect(store.previous("")?.value).toBe("c");
  });
});

describe("suggestion", () => {
  it("returns the unmatched SUFFIX of the newest longer match", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "import numpy", "import xarray as xr");
    expect(store.suggest("import ")).toBe("xarray as xr");
  });

  it("never suggests an exact match - there would be nothing to accept", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "value");
    expect(store.suggest("value")).toBeNull();
  });

  it("suggests nothing for an empty line", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "something");
    expect(store.suggest("")).toBeNull();
  });

  it("is off when prefixAutocomplete is disabled", () => {
    const store = new HistoryStore({ prefixAutocomplete: false }, fakeStorage());
    fill(store, "import xarray");
    expect(store.suggest("import ")).toBeNull();
  });
});

describe("reverse search", () => {
  it("finds the newest substring match, then older ones", () => {
    const store = new HistoryStore({}, fakeStorage());
    fill(store, "open_zarr(A)", "print(1)", "open_zarr(B)");
    expect(store.search("zarr", 0)?.value).toBe("open_zarr(B)");
    expect(store.search("zarr", 1)?.value).toBe("open_zarr(A)");
    expect(store.search("zarr", 2)).toBeNull();
  });

  it("searches inside multi-line entries", () => {
    const store = new HistoryStore({}, fakeStorage());
    store.add("def double(v):\n    return v * 2\n");
    expect(store.search("return")?.value).toContain("return v * 2");
  });

  it("is off when reverseSearch is disabled", () => {
    const store = new HistoryStore({ reverseSearch: false }, fakeStorage());
    fill(store, "x");
    expect(store.search("x")).toBeNull();
  });
});

describe("persistence", () => {
  it("uses a namespaced, versioned key", () => {
    expect(historyStorageKey("waterpark")).toBe("@freva-org/browser-python:history:v1:waterpark");
  });

  it("round-trips through storage", () => {
    const storage = fakeStorage();
    fill(new HistoryStore({ key: "a" }, storage), "one", "two");
    expect(new HistoryStore({ key: "a" }, storage).entries).toEqual(["one", "two"]);
  });

  it("keeps separate namespaces apart", () => {
    const storage = fakeStorage();
    fill(new HistoryStore({ key: "freva" }, storage), "freva-command");
    fill(new HistoryStore({ key: "waterpark" }, storage), "waterpark-command");
    expect(new HistoryStore({ key: "freva" }, storage).entries).toEqual(["freva-command"]);
    expect(new HistoryStore({ key: "waterpark" }, storage).entries).toEqual(["waterpark-command"]);
  });

  it("clear() empties the store AND the storage", () => {
    const storage = fakeStorage();
    const store = new HistoryStore({ key: "k" }, storage);
    fill(store, "a");
    store.clear();
    expect(store.entries).toEqual([]);
    expect(storage.data.get(historyStorageKey("k"))).toBeUndefined();
  });

  // Storage exists and throws: a private window, a blocking cookie policy, a sandboxed iframe, a
  // full quota. A console that stopped working because it could not save a history entry would be
  // broken by a preference the user is entitled to have.
  it("keeps working in memory when storage throws on write", () => {
    const store = new HistoryStore({}, fakeStorage({ throwOnWrite: true }));
    fill(store, "a", "b");
    expect(store.entries).toEqual(["a", "b"]);
    expect(store.previous("")?.value).toBe("b");
  });

  it("survives corrupted stored data rather than crashing on the first Up", () => {
    const storage = fakeStorage();
    storage.data.set(historyStorageKey("k"), '["ok", 42, null, {"not":"a string"}]');
    expect(new HistoryStore({ key: "k" }, storage).entries).toEqual(["ok"]);
  });

  it("survives storage that is not JSON at all", () => {
    const storage = fakeStorage();
    storage.data.set(historyStorageKey("k"), "not json {");
    expect(new HistoryStore({ key: "k" }, storage).entries).toEqual([]);
  });

  it("memory mode keeps history for the session but writes nothing", () => {
    const store = new HistoryStore({ persistence: "memory" });
    store.add("secret = 'token'");
    expect(store.persisted).toBe(false);
    // Recall still works within the session; the point is that nothing reaches storage.
    expect(store.entries).toEqual(["secret = 'token'"]);
  });

  it("none mode keeps and recalls NOTHING", () => {
    // `"none"` is not `"memory"`. A null storage backend still remembers a command for the
    // session and still recalls it with Up; a host that chose `"none"` for a shared or kiosk
    // machine asked for the opposite, and had no way to discover it had not happened.
    const store = new HistoryStore({ persistence: "none" });
    store.add("secret = 'token'");
    store.add("password = 'hunter2'");
    expect(store.persisted).toBe(false);
    expect(store.entries).toEqual([]);
    expect(store.previous("")).toBeNull();
  });
});
