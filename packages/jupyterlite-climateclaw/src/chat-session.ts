// One ClimateClaw chat as the controller keeps it, by its immutable local id (`model.name`):
// the views come and go (a move, a tab closed), the session stays with the chat. It owns what must
// not be per view - opening it (one at a time, so one model), the operations that replace its
// conversation (one at a time; a newer one makes an older one stale), and its backup: written by
// the session alone, one write at a time, each taking its snapshot when its turn comes, none once
// the chat is deleted; a deletion waits for those already queued before it removes the backup.

import type { Contents } from "@jupyterlab/services";

import { isNotFound } from "./new-file.js";

type ContentsManager = Contents.IManager;

/** jupyterlite-ai's chat model, as far as a session touches it. */
export interface SessionModel {
  readonly name: string;
  readonly isDisposed?: boolean;
}

export class ChatSession {
  model: SessionModel | null = null;
  /** The model being made for this chat (one at a time). */
  creating: Promise<SessionModel> | null = null;
  /** Set once, synchronously, when deletion starts: nothing writes the chat after it. */
  deleted = false;
  deletion: Promise<void> | null = null;
  /** Moves on with every operation that replaces the conversation, and every message sent. */
  epoch = 0;
  /** Saved as it changes (ClimateClaw's own autosave: jupyterlite-ai's stays off). */
  autosave = true;
  /**
   * Whether `autosave` is a choice (the user's, or the one its backup recorded) rather than the
   * default: a backup's choice is adopted only until then.
   */
  autosaveKnown = false;
  /**
   * Whether its model loaded its backup (or there was none): one that did not - the file could
   * not be read - is never saved over it.
   */
  loaded: Promise<boolean> = Promise.resolve(true);
  saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Its model is being replaced (another version shown): the old one writes nothing more. */
  replacing = false;
  /** Its thread is being deleted: nothing may move it to another version meanwhile. */
  deleting = false;
  /** The title the user gave: an automatic one (ClimateClaw's or jupyterlite-ai's) never wins. */
  manualTitle: string | null = null;
  /** The ClimateClaw thread the chat showed last (kept when its model is gone). */
  thread: string | null = null;
  /** Moves on with every title the user gives: an automatic title asked for before is stale. */
  titleRevision = 0;
  /** The newest message from the user, as last seen. */
  lastHuman: string | null = null;
  /** An edited question that carries its branch's marker until its reply has ended. */
  branchMessage: string | null = null;
  /** A title given before the chat had a thread: sent once it has one. */
  pendingTopic: string | null = null;
  readonly #writes = new Set<Promise<unknown>>();
  #opening: Promise<unknown> = Promise.resolve();
  #writing: Promise<unknown> = Promise.resolve();

  constructor(readonly name: string) {}

  /** Starts an operation that replaces the conversation; see `isCurrent`. */
  begin(): number {
    this.epoch += 1;
    return this.epoch;
  }

  /** Nothing newer happened since `begin()` returned `op`, and the chat is not deleted. */
  isCurrent(op: number): boolean {
    return !this.deleted && this.epoch === op;
  }

  /** Runs `fn` after every earlier `serialize`d call for this chat. */
  serialize<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.#opening.then(fn, fn);
    this.#opening = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Runs a backup write after every earlier one, so the last asked is the last on disk. `fn` runs
   * only if the chat is not deleted by then (else it gives `skipped`).
   */
  write<R>(fn: () => Promise<R>, skipped: () => R | Promise<R>): Promise<R> {
    const run = this.#writing.then(
      () => (this.deleted ? skipped() : fn()),
      () => (this.deleted ? skipped() : fn()),
    );
    this.#writing = run.then(
      () => undefined,
      () => undefined,
    );
    return this.track(run);
  }

  /** Keeps a write until it settles, so a deletion can wait for it. */
  track<T>(write: Promise<T>): Promise<T> {
    this.#writes.add(write);
    void write.then(
      () => this.#writes.delete(write),
      () => this.#writes.delete(write),
    );
    return write;
  }

  /** Waits for every write started so far (and any started while waiting). */
  async drain(): Promise<void> {
    while (this.#writes.size) await Promise.allSettled([...this.#writes]);
  }

  /** Whether `path` is this chat's backup (`<directory>/<name>.chat`). */
  isBackup(path: string): boolean {
    const file = `${this.name}.chat`;
    return path === file || path.endsWith(`/${file}`);
  }
}

const SKIPPED = "ClimateClaw: the chat is deleted; its backup is not written.";
const UNREAD = "ClimateClaw: the chat's backup could not be read, so it is not replaced.";

/**
 * The contents manager as a chat's backup sees it. Reads pass through. ClimateClaw's own writes
 * are tracked; once the chat is deleted they are skipped (and the backup reads as present, so
 * nothing tries to create it). A lookup that failed for any reason but "not found" blocks creating
 * files until a lookup succeeds again: a failed read is never taken for an absent file.
 *
 * `upstream`: the contents jupyterlite-ai's own model saves through. The session is the only
 * writer of the backup: its Save is the session's (see chats.ts), so what still arrives here is
 * its debounced autosave - with a snapshot taken before its lookup, for a model that may have
 * been replaced since. It writes nothing: the save is answered as done, and a file it made to
 * create the backup with is removed.
 */
export function guardedContents(
  real: ContentsManager,
  session: ChatSession,
  upstream = false,
): ContentsManager {
  /** Paths whose last lookup failed (not a 404). */
  const unread = new Set<string>();
  const fake = (path: string) =>
    ({ path, name: path.split("/").pop() ?? path, type: "file" }) as Contents.IModel;
  const overrides: Partial<ContentsManager> = {
    get: (path: string, options?: Contents.IFetchOptions) => {
      if (session.deleted && session.isBackup(path) && !options?.content) {
        return Promise.resolve(fake(path));
      }
      return real.get(path, options).then(
        (model) => {
          unread.delete(path);
          return model;
        },
        (error: unknown) => {
          if (isNotFound(error)) unread.delete(path);
          else unread.add(path);
          throw error;
        },
      );
    },
    save: (path: string, options?: Partial<Contents.IModel>) => {
      if (!session.isBackup(path)) return real.save(path, options);
      if (session.deleted || upstream) return Promise.resolve(fake(path));
      return session.write(
        () => real.save(path, options),
        () => fake(path),
      );
    },
    newUntitled: (options?: Contents.ICreateOptions) => {
      if (session.deleted) return Promise.reject(new Error(SKIPPED));
      if (unread.size) return Promise.reject(new Error(UNREAD));
      return session.track(real.newUntitled(options));
    },
    rename: (from: string, to: string) => {
      if (session.deleted && session.isBackup(to)) return Promise.reject(new Error(SKIPPED));
      if (unread.has(to) || (session.isBackup(to) && unread.size)) {
        return Promise.reject(new Error(UNREAD));
      }
      if (!session.isBackup(to)) return session.track(real.rename(from, to));
      // jupyterlite-ai creating the backup (a new Untitled file renamed to it): only its spare
      // file goes. Otherwise creating it is a backup write, in order with the others; made
      // meanwhile, that file is the backup: the spare one goes, and the save that follows writes
      // into it.
      if (upstream) {
        return session.track(
          real.delete(from).then(
            () => fake(to),
            () => fake(to),
          ),
        );
      }
      return session.write(
        async () => {
          try {
            await real.get(to, { content: false });
          } catch (error) {
            if (isNotFound(error)) return real.rename(from, to);
            throw error;
          }
          await real.delete(from).catch(() => undefined);
          return real.get(to, { content: false });
        },
        () => Promise.reject(new Error(SKIPPED)),
      );
    },
  };
  return new Proxy(real, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof ContentsManager];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
