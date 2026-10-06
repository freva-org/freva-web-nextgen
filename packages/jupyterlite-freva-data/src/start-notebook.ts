// The visitor's own copy of a published notebook (the start notebook, an example): made from the
// seed the first time, theirs after that, edits and outputs included.
//
// A copy is known by the seed it names in its metadata (`freva_data.copy_of`), never by its name
// or folder, so it is found again after the visitor renames or moves it, and an unrelated
// `era5.ipynb` of the visitor's is never opened for the ERA5 example or written to. A search that
// could not read everything stops: no second copy is made beside one it could not look at. A new
// copy takes a free name the way `new-file.ts` does (`era5.ipynb`, else `era5-1.ipynb`, ...).

import { PathExt } from "@jupyterlab/coreutils";

export interface OwnCopyHost {
  /** The published seed's notebook content. */
  readSeed(seed: string): Promise<unknown>;
  /** The visitor's copy of `seed`: a notebook whose `freva_data.copy_of` is `seed`, or null. */
  findCopy(seed: string): Promise<string | null>;
  /**
   * Runs `fn` alone among the origin's tabs (with Web Locks), and tells it whether it is: only
   * then may it take the first free plain name.
   */
  exclusive<R>(fn: (locked: boolean) => Promise<R>): Promise<R>;
  /** Saves `content` under a free name for `base` (never over a file); returns the path. */
  allocate(base: string, content: unknown, locked: boolean): Promise<string>;
  /** Opens `path` as a notebook, in front or behind. */
  open(path: string, activate: boolean): Promise<unknown>;
}

export interface StartNotebookHost extends OwnCopyHost {
  /** Whether a document other than `path` is open in the main area (restored from last time). */
  otherDocumentOpen(path: string): boolean;
}

/** The metadata key a copy names its seed under. */
export const COPY_KEY = "freva_data";

/** The seed a notebook says it is a copy of, or null. */
export function copyOf(notebook: unknown): string | null {
  const meta = (notebook as { metadata?: Record<string, unknown> } | null)?.metadata;
  const value = (meta?.[COPY_KEY] as { copy_of?: unknown } | undefined)?.copy_of;
  return typeof value === "string" ? value : null;
}

/** The seed's content as the visitor's copy: the same notebook, saying what it is a copy of. */
export function asCopy(seed: string, notebook: unknown): unknown {
  const nb = (notebook ?? {}) as { metadata?: Record<string, unknown> };
  const own = (nb.metadata?.[COPY_KEY] ?? {}) as Record<string, unknown>;
  return { ...nb, metadata: { ...nb.metadata, [COPY_KEY]: { ...own, copy_of: seed } } };
}

export interface ListedFile {
  name: string;
  path: string;
  type: string;
  last_modified?: string;
}

/** The visitor's files, as far as finding a copy needs them. */
export interface CopyStore {
  /** A directory's entries. Throws when it cannot be listed. */
  list(dir: string): Promise<readonly ListedFile[]>;
  /** A notebook's content. Throws when it cannot be read (not found included). */
  read(path: string): Promise<unknown>;
  /** The error says only that the file is not there. */
  isNotFound(error: unknown): boolean;
}

/** Where each seed's copy was last found (a hint: always checked against the file). */
export interface CopyMemory {
  get(seed: string): string | null;
  set(seed: string, path: string): void;
}

/** This browser's memory of where each copy was last found (localStorage; seed and path only). */
export function localCopyMemory(key = "freva-data:copies"): CopyMemory {
  const read = (): Record<string, string> => {
    try {
      const value = JSON.parse(globalThis.localStorage?.getItem(key) ?? "{}") as unknown;
      return value && typeof value === "object" ? (value as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  return {
    get: (seed) => {
      const path = read()[seed];
      return typeof path === "string" ? path : null;
    },
    set: (seed, path) => {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify({ ...read(), [seed]: path }));
      } catch {
        // No storage: the next search looks through the notebooks again.
      }
    },
  };
}

/** More notebooks than this, and the search is not trusted to be complete: it stops. */
export const COPY_SEARCH_LIMIT = 5_000;
const COPY_SEARCH_DEPTH = 12;

/**
 * Every copy among the visitor's notebooks, wherever they are and whatever they are called now:
 * seed -> path, the newest copy of each. A listing or a read that fails (other than a file gone
 * meanwhile) throws: a copy that could not be looked at is not taken to be absent.
 */
export async function scanCopies(store: CopyStore): Promise<Map<string, string>> {
  const notebooks: ListedFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const item of await store.list(dir)) {
      if (item.name.startsWith(".")) continue;
      if (item.type === "directory" && depth < COPY_SEARCH_DEPTH) await walk(item.path, depth + 1);
      else if (item.type === "notebook") notebooks.push(item);
      if (notebooks.length > COPY_SEARCH_LIMIT) {
        throw new Error(
          `there are more than ${COPY_SEARCH_LIMIT} notebooks to look through for your copy`,
        );
      }
    }
  };
  await walk("", 0);
  const newest = (a: ListedFile, b: ListedFile) =>
    String(b.last_modified ?? "").localeCompare(String(a.last_modified ?? ""));
  notebooks.sort(newest);
  const copies = new Map<string, string>();
  for (const item of notebooks) {
    let seed: string | null;
    try {
      seed = copyOf(await store.read(item.path));
    } catch (error) {
      if (store.isNotFound(error)) continue;
      throw error;
    }
    if (seed && seed !== item.path && !copies.has(seed)) copies.set(seed, item.path);
  }
  return copies;
}

/**
 * The visitor's copy of `seed`: where it was last found, if the file there still says so; else
 * found among all their notebooks (renamed or moved into a folder, it is still theirs). Storage
 * errors throw.
 */
export async function findCopy(
  seed: string,
  store: CopyStore,
  memory?: CopyMemory,
): Promise<string | null> {
  const known = memory?.get(seed) ?? null;
  if (known) {
    try {
      if (copyOf(await store.read(known)) === seed) return known;
    } catch (error) {
      if (!store.isNotFound(error)) throw error;
    }
  }
  const found = (await scanCopies(store)).get(seed) ?? null;
  if (found) memory?.set(seed, found);
  return found;
}

/**
 * Opens the visitor's copy of `seed`, making it from the seed first if they have none. In front,
 * unless a document of theirs was restored (that stays in front). The path opened.
 */
export async function openStartNotebook(seed: string, host: StartNotebookHost): Promise<string> {
  return openOwnCopy(seed, host, (path) => !host.otherDocumentOpen(path));
}

/** Opens the visitor's own copy of a published notebook, made the first time. */
export async function openOwnCopy(
  seed: string,
  host: OwnCopyHost,
  activate: (path: string) => boolean = () => true,
): Promise<string> {
  let path = await host.findCopy(seed);
  if (!path) {
    // Read outside the lock (a slow read holds no other tab); look again inside it, so a copy
    // another tab made meanwhile is the one opened and no second copy is made.
    const content = asCopy(seed, await host.readSeed(seed));
    path = await host.exclusive(
      async (locked) =>
        (await host.findCopy(seed)) ??
        host.allocate(PathExt.basename(seed, ".ipynb"), content, locked),
    );
  }
  await host.open(path, activate(path));
  return path;
}
