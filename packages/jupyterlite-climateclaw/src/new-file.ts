// Creating a file under a free name, never over an existing one - the Freva data panel's
// allocator (jupyterlite-freva-data's `new-file.ts`), with the same rules and the same lock, so
// the panel's new notebooks and ClimateClaw's never meet on one name either. Looking a name up
// and saving are two steps, so the pair runs under a lock every tab of this origin shares (the
// Web Locks API). A name is taken only when the store CONFIRMS it is absent (404); any other
// failure stops the creation. Without Web Locks, names carry a random suffix instead.
//
// Not imported from the data panel: ClimateClaw installs and runs without it.

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

/** The lock the data panel's allocator holds too. */
export const NEW_FILE_LOCK = "freva-data:new-file";

function suffix(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes]
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 6);
}

/** Candidate names: the first, then numbered ones. */
export type Names = (index: number) => string;

export class FileCreator<T> {
  constructor(
    private readonly store: FileStore<T>,
    private readonly lock: LockRunner | null = webLocks(),
  ) {}

  /**
   * Saves `content` under the first free name of `names` (0, 1, ...); returns the path used.
   * Without a shared lock: `random(...)` names, so two tabs cannot meet on one. Under the lock,
   * `existing` runs first - a path it finds (a file another tab made meanwhile) is returned
   * instead, and nothing is made - and `made` runs once the new file is saved, so another tab's
   * `existing` already finds it.
   */
  async create(
    names: Names,
    random: (tag: string) => string,
    content: T,
    hooks: { existing?: () => Promise<string | null>; made?: (path: string) => void } = {},
    limit = 1000,
  ): Promise<string> {
    const run = async (paths: () => string[]) => {
      const found = (await hooks.existing?.()) ?? null;
      if (found !== null) return found;
      const path = await this.#first(paths(), content);
      hooks.made?.(path);
      return path;
    };
    if (!this.lock) return run(() => [0, 1, 2].map(() => random(suffix())));
    return this.lock(NEW_FILE_LOCK, () =>
      run(() => Array.from({ length: limit }, (_, i) => names(i))),
    );
  }

  /** Runs `fn` under the same lock (a rename onto a free name, a metadata update). */
  exclusive<R>(fn: () => Promise<R>): Promise<R> {
    return this.lock ? this.lock(NEW_FILE_LOCK, fn) : fn();
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
