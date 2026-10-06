// One notebook per ClimateClaw thread: the code a conversation runs at DKRZ goes into a notebook
// named after the chat, bound to its thread in the notebook's metadata, and reopened (or made
// again) when it was closed - never "the notebook in front", never an Untitled one.
//
// The thread -> path index is kept in this browser's localStorage: thread ids and paths only, the
// same browser storage the notebooks themselves live in. Every tab reads it afresh and changes
// one entry at a time (never writing back a stale copy of the rest), and a new notebook is made
// only after the binding was looked up again under the creation lock. A path is used only when
// the file there still names the thread. A new notebook never replaces a file: its name is taken
// only when the store confirms it is free (404), under the lock every tab shares (see
// new-file.ts); a failed read stops, it never counts as "free".
//
// A closed notebook's file is never rewritten (a snapshot saved later could replace the user's
// edits): after a fork the index remembers the thread's earlier ids, and the notebook is bound to
// the new id in its live document when it opens. A path the user gives an open notebook is
// remembered at once.

import type { JupyterFrontEnd } from "@jupyterlab/application";
import { PathExt } from "@jupyterlab/coreutils";
import type { INotebookTracker, NotebookPanel } from "@jupyterlab/notebook";

import { FileCreator, isNotFound, type LockRunner, webLocks } from "./new-file.js";

/** Notebook metadata: `{ "climateclaw_chat": { "thread": "..." } }`. */
export const CHAT_METADATA_KEY = "climateclaw_chat";
const INDEX_KEY = "climateclaw:thread-notebooks";
const INDEX_LIMIT = 200;

interface Entry {
  path: string;
  /** The file name this module gave it; a name the user chose is never changed. */
  given: string;
  /**
   * The thread's earlier ids (the server forked it): a file closed without saving still names
   * one of them, and is still this thread's notebook.
   */
  before?: string[];
}

/** A file name from a chat title: no path separators, no leading dots, not too long. */
export function notebookBaseName(title: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|#%]+/g, " ")
    // Control characters too.
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 60)
    .trim();
  return clean || "ClimateClaw";
}

export function threadOfNotebook(metadata: unknown): string | null {
  const thread = (metadata as Record<string, { thread?: unknown }> | null)?.[CHAT_METADATA_KEY]
    ?.thread;
  return typeof thread === "string" && thread ? thread : null;
}

/** The index as stored now; null when storage cannot be read at all. */
function readIndex(): Map<string, Entry> | null {
  let text: string | null;
  try {
    text = window.localStorage.getItem(INDEX_KEY);
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text ?? "{}") as Record<string, Entry>;
    return new Map(
      Object.entries(raw)
        .filter(([, e]) => typeof e?.path === "string" && typeof e?.given === "string")
        .map(([thread, e]) => [
          thread,
          {
            path: e.path,
            given: e.given,
            ...(Array.isArray(e.before)
              ? { before: e.before.filter((t): t is string => typeof t === "string") }
              : {}),
          },
        ]),
    );
  } catch {
    return new Map();
  }
}

/** What the file at a known path is to a thread. */
type Binding = "bound" | "other" | "gone";

export class ThreadNotebooks {
  /** This page's copy: what is used only where storage cannot be read. */
  #memory = new Map<string, Entry>();
  /** The title each thread's notebook was last asked to take: the latest rename wins. */
  readonly #titles = new Map<string, string>();
  readonly #pending = new Map<string, Promise<NotebookPanel>>();
  readonly #files: FileCreator<unknown>;

  constructor(
    private readonly app: JupyterFrontEnd,
    private readonly tracker: INotebookTracker,
    lock: LockRunner | null = webLocks(),
  ) {
    const contents = app.serviceManager.contents;
    this.#files = new FileCreator<unknown>(
      {
        lookup: (path) => lookup(contents, path),
        save: async (path, content) => {
          await contents.save(path, {
            type: "notebook",
            format: "json",
            content: content as never,
          });
        },
      },
      lock,
    );
    tracker.forEach((panel) => this.#watch(panel));
    tracker.widgetAdded?.connect((_, panel) => this.#watch(panel));
  }

  /** An opened notebook: bound to its thread's current id, its path followed while open. */
  #watch(panel: NotebookPanel): void {
    const context = panel.context;
    let path = context.path;
    const moved = (_: unknown, now: string) => {
      const was = path;
      this.#change((index) => {
        for (const [thread, entry] of [...index]) {
          if (entry.path === was) remember(index, thread, { ...entry, path: now });
        }
      });
      path = now;
    };
    context.pathChanged?.connect(moved);
    panel.disposed?.connect(() => context.pathChanged?.disconnect(moved));
    void context.ready
      .then(() => {
        const named = threadOfNotebook(panel.model?.metadata);
        const index = this.#read();
        if (!named || index.has(named)) return;
        // A file still naming an id its thread had before a fork: bound now, in the document.
        for (const [thread, entry] of index) {
          if (entry.path === context.path && entry.before?.includes(named)) {
            panel.model?.setMetadata(CHAT_METADATA_KEY, { thread });
            return;
          }
        }
      })
      .catch(() => undefined);
  }

  /** The open notebook bound to `thread`, now. */
  openFor(thread: string): NotebookPanel | null {
    return (
      this.tracker.find(
        (panel) => !panel.isDisposed && threadOfNotebook(panel.model?.metadata) === thread,
      ) ?? null
    );
  }

  /** The thread's notebook, open: the bound one, reopened, or a new one named `title`. */
  ensure(thread: string, title: string): Promise<NotebookPanel> {
    const open = this.openFor(thread);
    if (open) return Promise.resolve(open);
    let pending = this.#pending.get(thread);
    if (!pending) {
      pending = this.#reopenOrCreate(thread, title).finally(() => this.#pending.delete(thread));
      this.#pending.set(thread, pending);
    }
    return pending;
  }

  /** The thread's notebook, opened if it was closed; null when it has none (none is made). */
  async reopen(thread: string): Promise<NotebookPanel | null> {
    const open = this.openFor(thread);
    if (open) return open;
    const [current, known] = this.#entryFor(thread) ?? [thread, undefined];
    if (!known || (await this.#binding(known, current)) !== "bound") return null;
    return this.#open(known.path, current);
  }

  /**
   * The chat was renamed: so is its notebook, unless the user renamed that. Its entry is read
   * under the lock, so a rename that waited finds the file where the one before it left it, and
   * the title asked for last is the one taken.
   */
  async rename(thread: string, title: string): Promise<void> {
    this.#titles.set(thread, title);
    const contents = this.app.serviceManager.contents;
    try {
      await this.#files.exclusive(async () => {
        const wanted = this.#titles.get(thread);
        const entry = this.#read().get(thread);
        if (wanted === undefined || !entry || PathExt.basename(entry.path) !== entry.given) return;
        const dir = PathExt.dirname(entry.path);
        const base = notebookBaseName(wanted);
        // The new name only if it is confirmed free (or is already this file's).
        for (let i = 1; i < 1000; i += 1) {
          const name = i === 1 ? `${base}.ipynb` : `${base} ${i}.ipynb`;
          const path = PathExt.join(dir, name);
          if (path === entry.path) return;
          if ((await lookup(contents, path)) === "present") continue;
          // An open notebook follows: its document context hears the rename.
          await contents.rename(entry.path, path);
          this.#change((index) => {
            const now = index.get(thread);
            if (now?.path === entry.path) remember(index, thread, { ...now, path, given: name });
          });
          return;
        }
      });
    } catch (error) {
      console.warn("ClimateClaw: the chat's notebook was not renamed", error);
    } finally {
      if (this.#titles.get(thread) === title) this.#titles.delete(thread);
    }
  }

  /**
   * The server forked `from` into `to`: its notebook is the new thread's - the open one at once, a
   * closed one when it opens (its file is not rewritten; the index keeps `from` as its earlier id).
   */
  rebind(from: string, to: string): void {
    if (from === to) return;
    // A notebook still being made for `from` is rebound once it is there.
    void this.#pending.get(from)?.then(() => this.rebind(from, to));
    const open = this.openFor(from);
    open?.model?.setMetadata(CHAT_METADATA_KEY, { thread: to });
    this.#change((index) => {
      const entry = index.get(from);
      if (!entry) return;
      index.delete(from);
      remember(index, to, { ...entry, before: [...(entry.before ?? []), from].slice(-20) });
    });
  }

  /** The path of the thread's notebook, as last known. */
  pathOf(thread: string): string | null {
    return this.openFor(thread)?.context.path ?? this.#read().get(thread)?.path ?? null;
  }

  /** The open notebook holding a cell with this id, and the cell's index. */
  findCell(cellId: string): { panel: NotebookPanel; index: number } | null {
    let found: { panel: NotebookPanel; index: number } | null = null;
    this.tracker.forEach((panel) => {
      const cells = panel.content.model?.cells;
      if (found || !cells) return;
      for (let i = 0; i < cells.length; i += 1) {
        if (cells.get(i).id === cellId) {
          found = { panel, index: i };
          return;
        }
      }
    });
    return found;
  }

  /** Brings a cell into view and makes it active. */
  reveal(panel: NotebookPanel, index: number): void {
    this.app.shell.activateById(panel.id);
    panel.content.activeCellIndex = index;
    panel.content.mode = "command";
    void panel.content.scrollToItem?.(index, "center").catch(() => undefined);
  }

  async #reopenOrCreate(thread: string, title: string): Promise<NotebookPanel> {
    const known = this.#read().get(thread);
    if (known) {
      // A failed read throws here: the binding is kept, nothing is made in its place.
      const binding = await this.#binding(known, thread);
      if (binding === "bound") return this.#open(known.path, thread);
    }
    const base = notebookBaseName(title);
    const spec = this.app.serviceManager.kernelspecs?.specs;
    const kernel = spec?.default ? spec.kernelspecs[spec.default] : undefined;
    const content = {
      cells: [],
      metadata: {
        ...(kernel
          ? {
              kernelspec: {
                name: kernel.name,
                display_name: kernel.display_name,
                language: kernel.language,
              },
            }
          : {}),
        [CHAT_METADATA_KEY]: { thread },
      },
      nbformat: 4,
      nbformat_minor: 5,
    };
    // Looked up again under the creation lock: another tab may have made it meanwhile.
    const bound = async (): Promise<string | null> => {
      const entry = this.#read().get(thread);
      return entry && (await this.#binding(entry, thread)) === "bound" ? entry.path : null;
    };
    const path = await this.#files.create(
      (i) => (i === 0 ? `${base}.ipynb` : `${base} ${i + 1}.ipynb`),
      (tag) => `${base} ${tag}.ipynb`,
      content,
      {
        existing: bound,
        // Bound while the lock is held: a tab waiting for it finds this notebook.
        made: (made) =>
          this.#change((index) =>
            remember(index, thread, { path: made, given: PathExt.basename(made) }),
          ),
      },
    );
    return this.#open(path, thread);
  }

  /** The thread an id is now (itself, or the fork it became) and its entry. */
  #entryFor(thread: string): [string, Entry] | null {
    const index = this.#read();
    const direct = index.get(thread);
    if (direct) return [thread, direct];
    for (const [current, entry] of index) {
      if (entry.before?.includes(thread)) return [current, entry];
    }
    return null;
  }

  /**
   * Whether the file is still this thread's notebook: it names the thread, or an id it had
   * before; "gone" only when the store confirms there is no file. A failed read throws.
   */
  async #binding(entry: Entry, thread: string): Promise<Binding> {
    let model: { content?: { metadata?: unknown } };
    try {
      model = await this.app.serviceManager.contents.get(entry.path, {
        content: true,
        type: "notebook",
      });
    } catch (error) {
      if (isNotFound(error)) return "gone";
      throw error;
    }
    const named = threadOfNotebook(model.content?.metadata);
    return named === thread || (!!named && !!entry.before?.includes(named)) ? "bound" : "other";
  }

  /** Opens the notebook; one that still names an earlier id is bound to `thread` again. */
  async #open(path: string, thread?: string): Promise<NotebookPanel> {
    const kernelName = this.app.serviceManager.kernelspecs?.specs?.default;
    const panel = (await this.app.commands.execute("docmanager:open", {
      path,
      factory: "Notebook",
      ...(kernelName ? { kernel: { name: kernelName } } : {}),
    })) as NotebookPanel;
    await panel.context.ready;
    if (thread && threadOfNotebook(panel.model?.metadata) !== thread) {
      panel.model?.setMetadata(CHAT_METADATA_KEY, { thread });
    }
    return panel;
  }

  /** The index as stored now, every tab's changes in it (this page's own copy without storage). */
  #read(): Map<string, Entry> {
    return readIndex() ?? new Map(this.#memory);
  }

  /** Changes the index as stored now, at once: what other tabs wrote meanwhile stays. */
  #change(update: (index: Map<string, Entry>) => void): void {
    const index = this.#read();
    update(index);
    while (index.size > INDEX_LIMIT) {
      const oldest = index.keys().next().value;
      if (oldest === undefined) break;
      index.delete(oldest);
    }
    this.#memory = index;
    try {
      window.localStorage.setItem(INDEX_KEY, JSON.stringify(Object.fromEntries(index)));
    } catch {
      // Unavailable storage: the binding lasts for this page only.
    }
  }
}

/** Sets a thread's entry, as the newest. */
function remember(index: Map<string, Entry>, thread: string, entry: Entry): void {
  index.delete(thread);
  index.set(thread, entry);
}

/** "absent" only for a confirmed 404; any other failure throws. */
async function lookup(
  contents: JupyterFrontEnd["serviceManager"]["contents"],
  path: string,
): Promise<"present" | "absent"> {
  try {
    await contents.get(path, { content: false });
    return "present";
  } catch (error) {
    if (isNotFound(error)) return "absent";
    throw error;
  }
}
