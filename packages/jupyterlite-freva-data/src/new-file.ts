// Creating a file under a free name, never over an existing one. Looking a name up and saving
// are two steps, so the pair runs under a lock every tab of this origin shares (the Web Locks
// API): tabs on the same contents store never pick the same name. Within the lock a name is
// taken only when the store CONFIRMS it is absent (404); any other failure stops the creation.
// Without Web Locks, names carry a random suffix instead, so two tabs cannot meet on one.

export interface FileStore<T> {
  /** "absent" only for a confirmed not-found; any other failure throws. */
  lookup(path: string): Promise<"present" | "absent">;
  save(path: string, content: T): Promise<void>;
}

/** Runs `fn` while holding the lock `name`, exclusive across the origin's tabs. */
export type LockRunner = <R>(name: string, fn: () => Promise<R>) => Promise<R>;

/** The Web Locks API, or null where there is none. */
export function webLocks(): LockRunner | null {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks?.request) return null;
  return <R>(name: string, fn: () => Promise<R>) =>
    locks.request(name, () => fn()) as unknown as Promise<R>;
}

/** A contents error that says the file is not there (and nothing else). */
export function isNotFound(error: unknown): boolean {
  return (error as { response?: { status?: number } } | null)?.response?.status === 404;
}

const LOCK = "freva-data:new-file";

function suffix(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes]
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 6);
}

export class FileCreator<T> {
  constructor(
    private readonly store: FileStore<T>,
    private readonly lock: LockRunner | null = webLocks(),
  ) {}

  /** Runs `fn` alone among the origin's tabs where there is a shared lock; says whether it is. */
  exclusive<R>(fn: (locked: boolean) => Promise<R>): Promise<R> {
    return this.lock ? this.lock(LOCK, () => fn(true)) : fn(false);
  }

  /**
   * Saves `content` as `base{ext}`, else `base-1{ext}`, …; returns the path used. Without a
   * shared lock: `base-<random>{ext}`.
   */
  create(base: string, ext: string, content: T, limit = 1000): Promise<string> {
    return this.exclusive((locked) => this.allocate(base, ext, content, locked, limit));
  }

  /**
   * `create`'s naming, for a caller already inside `exclusive`: the first free plain name only
   * when `locked` (no other tab can take it meanwhile), otherwise a random suffix, so two tabs
   * never save to one name - and never over a file another tab has made and edited since.
   */
  allocate(base: string, ext: string, content: T, locked: boolean, limit = 1000): Promise<string> {
    return this.#first(
      locked
        ? Array.from({ length: limit }, (_, i) => `${base}${i ? `-${i}` : ""}${ext}`)
        : [0, 1, 2].map(() => `${base}-${suffix()}${ext}`),
      content,
    );
  }

  async #first(paths: string[], content: T): Promise<string> {
    for (const path of paths) {
      if ((await this.store.lookup(path)) === "present") continue;
      await this.store.save(path, content);
      return path;
    }
    throw new Error("No free file name.");
  }
}
