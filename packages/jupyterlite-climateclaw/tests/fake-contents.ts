// An in-memory contents store with JupyterLab's error shape, failures and delays on demand.
import { vi } from "vitest";

export function statusError(status: number): Error & { response: { status: number } } {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

export interface StoredFile {
  type: string;
  content: unknown;
}

export class FakeContents {
  readonly files = new Map<string, StoredFile>();
  readonly dirs = new Set<string>([""]);
  /** Paths whose reads fail with this status (e.g. 503). */
  readonly failing = new Map<string, number>();
  /** Saves held until released (`hold(path)` returns the release). */
  readonly #held = new Map<string, Promise<void>>();
  /** The next save only, held until released. */
  readonly #heldOnce = new Map<string, Promise<void>>();
  readonly saved: string[] = [];
  untitled = 0;

  hold(path: string): () => void {
    let release: () => void = () => undefined;
    this.#held.set(path, new Promise<void>((resolve) => (release = resolve)));
    return () => {
      this.#held.delete(path);
      release();
    };
  }

  /** The next save of `path` waits until released; later ones do not. */
  holdOnce(path: string): () => void {
    let release: () => void = () => undefined;
    this.#heldOnce.set(path, new Promise<void>((resolve) => (release = resolve)));
    return release;
  }

  get = vi.fn(async (path: string, options: { content?: boolean } = {}) =>
    this.#read(path, options),
  );

  async #read(path: string, options: { content?: boolean }) {
    await Promise.resolve();
    const status = this.failing.get(path);
    if (status) throw statusError(status);
    if (this.dirs.has(path)) {
      const children = [...this.files.keys()]
        .filter((p) => (path ? p.startsWith(`${path}/`) : !p.includes("/")))
        .map((p) => ({ path: p, name: p.split("/").pop()! }));
      return { path, type: "directory", content: options.content ? children : null };
    }
    const file = this.files.get(path);
    if (!file) throw statusError(404);
    return {
      path,
      name: path.split("/").pop()!,
      type: file.type,
      content: options.content
        ? typeof file.content === "string"
          ? file.content
          : structuredClone(file.content)
        : null,
    };
  }

  save = vi.fn(async (path: string, model: { type?: string; content?: unknown }) => {
    const once = this.#heldOnce.get(path);
    if (once) {
      this.#heldOnce.delete(path);
      await once;
    }
    await (this.#held.get(path) ?? Promise.resolve());
    this.files.set(path, { type: model.type ?? "file", content: structuredClone(model.content) });
    this.saved.push(path);
    return { path };
  });

  newUntitled = vi.fn(async (options: { type?: string; ext?: string } = {}) => {
    this.untitled += 1;
    if (options.type === "directory") {
      const path = `Untitled Folder ${this.untitled}`;
      this.dirs.add(path);
      return { path };
    }
    const path = `untitled${this.untitled}${options.ext ?? ""}`;
    this.files.set(path, { type: "file", content: "" });
    return { path };
  });

  rename = vi.fn(async (from: string, to: string) => {
    if (this.files.has(to) || this.dirs.has(to)) throw statusError(409);
    if (this.dirs.delete(from)) {
      this.dirs.add(to);
      return { path: to };
    }
    const file = this.files.get(from);
    if (!file) throw statusError(404);
    this.files.delete(from);
    this.files.set(to, file);
    return { path: to };
  });

  delete = vi.fn(async (path: string) => {
    if (!this.files.delete(path)) throw statusError(404);
  });
}

/** One lock shared by "tabs": what the Web Locks API gives an origin. */
export function sharedLock() {
  const tails = new Map<string, Promise<unknown>>();
  return <R>(name: string, fn: () => Promise<R>): Promise<R> => {
    const before = tails.get(name) ?? Promise.resolve();
    const run = before.then(fn, fn);
    tails.set(
      name,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  };
}
