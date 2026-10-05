// A lazily built session controller that is closed while it is still loading.
import { describe, expect, it } from "vitest";

import { DisposedError, lazyController } from "../../client/lazy-controller.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("lazyController", () => {
  it("disposed while loading: constructs nothing and releases the reservation once", async () => {
    const loading = deferred();
    let constructed = 0;
    let released = 0;
    const lazy = lazyController({
      load: () => loading.promise,
      construct: () => (constructed += 1),
      close: () => undefined,
      release: () => (released += 1),
    });
    const pending = lazy.get();
    lazy.dispose();
    lazy.dispose();
    loading.resolve();
    await expect(pending).rejects.toBeInstanceOf(DisposedError);
    await expect(lazy.get()).rejects.toBeInstanceOf(DisposedError);
    expect(constructed).toBe(0);
    expect(released).toBe(1);
  });

  it("disposed after construction: closes the controller instead", async () => {
    const closed: string[] = [];
    let released = 0;
    const lazy = lazyController({
      load: () => Promise.resolve(),
      construct: () => "controller",
      close: (c) => closed.push(c),
      release: () => (released += 1),
    });
    expect(await lazy.get()).toBe("controller");
    lazy.dispose();
    expect(closed).toEqual(["controller"]);
    expect(released).toBe(0);
    expect(lazy.current()).toBeNull();
  });
});
