// opfs-workspace.ts - a real, disk-backed `/workspace` for Python file output.
//
// Pyodide's default filesystem is MEMFS, so a 1 GiB export is a 1 GiB WASM heap and the tab dies.
// OPFS sync access handles write straight to disk with no heap growth and need no cross-origin
// isolation headers (`browser-tests/opfs-feasibility.mjs`). The hard problem: Emscripten's `open()`
// is synchronous, acquiring an OPFS handle is not, and nothing can await inside a filesystem
// callback - JSPI is unreachable from there on the pinned runtime (`browser-tests/jspi-probe.mjs`).
// So a pool of handles is opened at startup on files named `slot-0`, `slot-1`, ..., and taken
// synchronously. It bounds RETAINED files, not names and not files ever created - deleting a file
// returns its slot - and exceeding it is EMFILE, never truncation.
//
// STAGING, NOT STREAMING: a file becomes a downloadable artifact only once every descriptor is
// closed and nothing went wrong, so a short write, failed truncate or flush, a quota exception or
// a worker that dies mid-write leaves a FAILED artifact. The whole result must fit the quota.
//
// SESSION SCOPE: a sync access handle is an exclusive lock, so two tabs cannot share a pool. Each
// worker gets its own OPFS directory keyed by a random session id, holds a lock file open for its
// lifetime, and deletes the directories of sessions whose lock it can acquire. Artifacts do not
// survive a restart or a reload.

import { mimeForName, safeBlobType } from "../artifact-mime.js";
import { MAX_WORKSPACE_FILES } from "../types.js";
import type { ArtifactInfo, WorkspaceStatus, WorkspaceUnavailableReason } from "../types.js";

// internals

/** The subset of Emscripten's FS this filesystem talks to. */
interface EmscriptenFS {
  ErrnoError: new (errno: number) => Error;
  isDir(mode: number): boolean;
  createNode(parent: FSNode | null, name: string, mode: number, dev: number): FSNode;
  mkdirTree(path: string): void;
  mount(type: unknown, options: unknown, mountpoint: string): void;
  lookupPath(path: string): { node: FSNode };
  unlink(path: string): void;
  /** Emscripten's own name-lookup table, separate from the directory tree: `FS.lookupPath`
   * consults it, so a node removed only from a parent's `contents` map stays resolvable.
   * `FS.unlink` calls `destroyNode`; `FS.rename` does NOT for the destination it overwrites. */
  hashRemoveNode(node: FSNode): void;
  destroyNode(node: FSNode): void;
}

interface FSNode {
  id: number;
  name: string;
  mode: number;
  rdev: number;
  parent: FSNode;
  timestamp: number;
  node_ops?: unknown;
  stream_ops?: unknown;
  /** Directories only. */
  contents?: Record<string, FSNode>;
  /** Files only - see `SlotPool`. */
  slot?: Slot | null;
  openCount?: number;
  failure?: string | null;
  unlinked?: boolean;
  /** Bumped on every mutation and never reused: the artifact fingerprint. Size-and-timestamp
   * misses a rewrite landing on the same length inside one millisecond, so a download in flight
   * would read the new bytes as the old. A counter cannot collide. */
  generation?: number;
  /** The size this filesystem last WROTE, as opposed to the size OPFS reports. `getSize()` can
   * fail, and a failed `getSize()` must not read as a zero-byte file in `ready` state. */
  knownSize?: number;
  /** Open transfer leases. A leased file is frozen: see `Workspace.openLease`. */
  leases?: Set<string>;
}

// A directory's entries live in a NULL-PROTOTYPE object, and this is not defensive style. With an
// ordinary `{}`, `open("constructor")` hands a FUNCTION to code expecting a node, `toString` and
// `valueOf` shadow real files, and `__proto__` cannot be stored at all - ordinary POSIX filenames,
// crashing inside the syscall layer rather than returning an errno. The frozen shared fallback is
// part of that; `(node.contents ?? {})[name]` would reintroduce the whole problem.
const newContents = (): Record<string, FSNode> => Object.create(null) as Record<string, FSNode>;
const NO_CONTENTS: Record<string, FSNode> = Object.freeze(
  Object.create(null) as Record<string, FSNode>,
);

interface Slot {
  index: number;
  fileHandle: FileSystemFileHandle;
  handle: FileSystemSyncAccessHandle;
  taken: boolean;
  /** A slot whose storage misbehaved, permanently withdrawn from rotation: one that cannot be
   * truncated would hand the next file whatever the previous one left behind. Retiring costs
   * capacity, which is reported. */
  broken?: string;
}

interface ErrnoTable {
  [code: string]: number;
}

/** One open transfer: a frozen artifact and where the reader has got to. */
interface Lease {
  node: FSNode;
  name: string;
  size: number;
  generation: number;
  transferred: number;
}

/** The directory under the origin's private filesystem that every session lives in. */
const ROOT_DIR = "browser-python-workspace";

/** Where the workspace is mounted, and the interpreter's working directory. */
export const WORKSPACE_PATH = "/workspace";

/**
 * How many files may exist at one time, by default. Acquisition is roughly 0.6 ms per handle, so
 * tens of milliseconds at startup. A bound on retained files, not throughput.
 */
export const DEFAULT_MAX_FILES = 64;

/** Read in this size while copying a finished artifact out. Bounds the peak JS heap. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** The hard ceiling on `readArtifact()`, the Blob path: a Blob is the whole artifact in
 * browser-managed storage before any of it reaches a destination, so it belongs to previews, and
 * eight mebibytes covers a plot, a CSV head, a small NetCDF. Larger goes through
 * `streamArtifact()`, which never holds more than a couple of chunks. */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** EVERY errno this filesystem raises, checked at startup - not a sample. An unchecked name is
 * `undefined`, and `new FS.ErrnoError(undefined)` produces an `OSError` with no errno at all, so
 * a caller branching on `exc.errno` sees `None`. A runtime that renames one says so here. */
export const REQUIRED_ERRNOS = [
  "EACCES",
  "EBADF",
  "EBUSY",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISDIR",
  "EMFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
] as const;

/** The runtime's own errno table, never a literal. Emscripten's numbers are its own and not
 * Linux's - ENOSPC is 51 here, EMFILE 33, EINVAL 28 - so a hard-coded constant leaves every quota
 * test asserting only that "an OSError happened". */
export function errnoCodes(pyodide: unknown): ErrnoTable {
  const candidate = pyodide as {
    ERRNO_CODES?: ErrnoTable;
    _module?: { ERRNO_CODES?: ErrnoTable };
    _api?: { _module?: { ERRNO_CODES?: ErrnoTable } };
  };
  const table =
    candidate.ERRNO_CODES ?? candidate._module?.ERRNO_CODES ?? candidate._api?._module?.ERRNO_CODES;
  if (!table) {
    throw new Error(
      "This Pyodide build does not expose ERRNO_CODES. The browser workspace refuses to guess " +
        "errno values, because the wrong number turns a full disk into an invalid argument.",
    );
  }
  const missing = REQUIRED_ERRNOS.filter((name) => !Number.isInteger(table[name]));
  if (missing.length > 0) {
    throw new Error(
      `This Pyodide build's ERRNO_CODES is missing ${missing.join(", ")}. The browser workspace ` +
        `raises every one of them, and an undefined errno produces an OSError a caller cannot ` +
        `branch on, so it refuses to start rather than reporting the wrong failure later.`,
    );
  }
  return table;
}

/** Can this browser back a workspace at all? Answered before anything is created. */
export function probeWorkspaceSupport(): WorkspaceUnavailableReason | null {
  const storage = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator
    ?.storage;
  if (typeof storage?.getDirectory !== "function") return "no-opfs";
  const handleCtor = (globalThis as { FileSystemFileHandle?: { prototype?: unknown } })
    .FileSystemFileHandle;
  const proto = handleCtor?.prototype as { createSyncAccessHandle?: unknown } | undefined;
  if (typeof proto?.createSyncAccessHandle !== "function") return "no-sync-access-handles";
  return null;
}

/**
 * A truncate is not done when it returns; it is done when the file is the size you asked for.
 * `truncate()` is specified to throw on failure, and this project's feasibility probe recorded a
 * real browser returning normally from `truncate(4 GiB + 4)` with the size unchanged - a slot
 * handed on still holding the previous file's bytes. So `getSize()` confirms, which is the only
 * thing that tells "did not throw" from "succeeded".
 */
export class TruncateFailed extends Error {
  readonly requested: number;
  readonly actual: number | null;
  constructor(requested: number, actual: number | null) {
    super(
      actual === null
        ? `truncate(${requested}) returned but the resulting size could not be read`
        : `truncate(${requested}) returned but the file is ${actual} bytes`,
    );
    this.name = "TruncateFailed";
    this.requested = requested;
    this.actual = actual;
  }
}

/** Truncate, then confirm. Throws `TruncateFailed` when the file is not exactly `size`. */
export function truncateExactly(handle: FileSystemSyncAccessHandle, size: number): void {
  handle.truncate(size);
  let actual: number | null = null;
  try {
    actual = handle.getSize();
  } catch {
    // A handle that cannot report its size cannot be trusted to have changed it either.
    throw new TruncateFailed(size, null);
  }
  if (actual !== size) throw new TruncateFailed(size, actual);
}

/** Turn an OPFS failure into the right errno. Storage problems arrive as DOMExceptions and the
 * name is the only machine-readable part; collapsing them all to EIO would tell Python that a full
 * disk and a revoked permission are the same event. */
function errnoForDomException(E: ErrnoTable, error: unknown): number {
  const name = (error as { name?: unknown } | null)?.name;
  switch (name) {
    case "QuotaExceededError":
      return E.ENOSPC as number;
    case "NotFoundError":
      return E.ENOENT as number;
    case "NoModificationAllowedError":
      // Another handle holds the exclusive lock: for this filesystem, a second tab or a download
      // that has not released the file yet.
      return E.EBUSY as number;
    case "NotAllowedError":
      return E.EACCES as number;
    case "InvalidStateError":
      // The handle was closed underneath us - a slot released while a stream still referenced it.
      return E.EBADF as number;
    case "TypeMismatchError":
      return E.ENOTDIR as number;
    case "AbortError":
      return E.EINTR as number;
    default:
      return E.EIO as number;
  }
}

// the slot pool

class SlotPool {
  readonly slots: Slot[] = [];
  #dir: FileSystemDirectoryHandle;

  constructor(dir: FileSystemDirectoryHandle) {
    this.#dir = dir;
  }

  async open(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const fileHandle = await this.#dir.getFileHandle(`slot-${i}`, { create: true });
      const handle = await fileHandle.createSyncAccessHandle();
      // The handle is acquired but NOT yet tracked, and `truncate` can throw.
      // `createSyncAccessHandle` takes an exclusive lock, so a handle dropped here stays locked for
      // the life of the Worker on a directory this session is about to abandon - which the next
      // session's sweep then cannot reclaim either. One owner per handle, starting here.
      try {
        // Confirmed, not assumed: a slot that cannot be emptied would hand its previous contents
        // to the first file created in this session.
        truncateExactly(handle, 0);
      } catch (error) {
        try {
          handle.close();
        } catch {
          // it was already unusable; this is only tidying
        }
        throw error;
      }
      this.slots.push({ index: i, fileHandle, handle, taken: false });
    }
  }

  /** Synchronous, which is the entire point of the pool. */
  take(FS: EmscriptenFS, E: ErrnoTable): Slot {
    const slot = this.slots.find((s) => !s.taken && !s.broken);
    if (!slot) {
      // EMFILE, and not ENOSPC: the disk is not full, this backend is out of pre-acquired
      // descriptors, so the reader can tell "delete something" from "too big for the browser" and
      // the annotator below names the limit. `FS.ErrnoError`, not a bare Error: only the former
      // becomes a Python `OSError` that Python code can catch.
      throw new FS.ErrnoError(E.EMFILE as number);
    }
    slot.taken = true;
    try {
      truncateExactly(slot.handle, 0);
    } catch (error) {
      // Translated, not allowed to escape: a raw DOMException out of a filesystem callback is
      // reported by Pyodide as "Pyodide already fatally failed and can no longer be used" - the
      // interpreter dead for the session over a full disk. RETIRED, not returned: a slot that
      // cannot be cleaned would hand the next file whatever is in it, so `capacity()` drops and
      // `status().degraded` says so.
      slot.broken = describe(error);
      slot.taken = false;
      try {
        slot.handle.close();
      } catch {
        // already unusable
      }
      throw new FS.ErrnoError(errnoForDomException(E, error));
    }
    return slot;
  }

  /** Return a slot to the pool, or RETIRE it if it cannot be cleaned. Leaving an untruncatable
   * slot marked `taken` reads like caution and is a leak: neither reusable nor accounted for.
   * Retiring keeps the safety - the next file must never inherit these bytes - and drops
   * `capacity()`. */
  release(slot: Slot | null | undefined): void {
    if (!slot || !slot.taken) return;
    try {
      truncateExactly(slot.handle, 0);
    } catch (error) {
      slot.broken = describe(error);
      slot.taken = false;
      try {
        slot.handle.close();
      } catch {
        // it was already unusable; this is only tidying
      }
      return;
    }
    slot.taken = false;
  }

  free(): number {
    return this.slots.reduce((n, s) => n + (s.taken || s.broken ? 0 : 1), 0);
  }

  /** How many files this pool can hold at once NOW - which is not always what it was asked for. */
  capacity(): number {
    return this.slots.reduce((n, s) => n + (s.broken ? 0 : 1), 0);
  }

  retired(): readonly string[] {
    return this.slots.flatMap((s) => (s.broken ? [`slot-${s.index}: ${s.broken}`] : []));
  }

  closeAll(): void {
    for (const slot of this.slots) {
      try {
        slot.handle.close();
      } catch {
        // already closed, or the origin's storage went away with the tab
      }
    }
  }
}

// the workspace

export interface WorkspaceOptions {
  maxFiles?: number;
  /** Injected by tests. Defaults to `crypto.randomUUID()`. */
  sessionId?: string;
}

/**
 * Coerce a caller's file limit into something the pool can honour. Rejects rather than rounds:
 * `NaN`, `Infinity`, `2.5` and `-1` are a caller's mistake, and turning them into 64 would hide it.
 */
export function resolveMaxFiles(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MAX_FILES;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new RangeError(
      `workspaceMaxFiles must be a whole number of at least 1, not ${String(requested)}.`,
    );
  }
  if (requested > MAX_WORKSPACE_FILES) {
    throw new RangeError(
      `workspaceMaxFiles is capped at ${MAX_WORKSPACE_FILES}; ${requested} storage handles would ` +
        `have to be reserved before the interpreter could start.`,
    );
  }
  return requested;
}

export class Workspace {
  readonly sessionId: string;
  readonly maxFiles: number;

  #pyodide: { FS: unknown; runPython(code: string): unknown };
  #FS: EmscriptenFS;
  #E: ErrnoTable;
  #pool: SlotPool;
  #lock: FileSystemSyncAccessHandle | null;
  #root: FSNode | null = null;
  #closed = false;
  /** Monotonic, per workspace. Never reused, so a fingerprint cannot collide. */
  #generation = 0;
  /** Open transfer leases, by id. See `openLease`. */
  #leases = new Map<string, Lease>();
  #nextLease = 0;

  private constructor(init: {
    pyodide: { FS: unknown; runPython(code: string): unknown };
    FS: EmscriptenFS;
    E: ErrnoTable;
    pool: SlotPool;
    lock: FileSystemSyncAccessHandle | null;
    sessionId: string;
    maxFiles: number;
  }) {
    this.#pyodide = init.pyodide;
    this.#FS = init.FS;
    this.#E = init.E;
    this.#pool = init.pool;
    this.#lock = init.lock;
    this.sessionId = init.sessionId;
    this.maxFiles = init.maxFiles;
  }

  /** Open a workspace, or say why it could not be opened. Never throws for an unsupported
   * browser: an engine that refuses to start over one missing feature is worse than one that
   * starts and reports the limitation. */
  static async open(
    pyodide: { FS: unknown; runPython(code: string): unknown },
    options: WorkspaceOptions = {},
  ): Promise<{ workspace: Workspace } | { status: WorkspaceStatus }> {
    let maxFiles: number;
    try {
      maxFiles = resolveMaxFiles(options.maxFiles);
    } catch (error) {
      // A bad option is the host's bug, and it is reported as an unavailable workspace with the
      // reason rather than as a failed interpreter: Python still runs.
      return {
        status: {
          available: false,
          reason: "open-failed",
          detail: describe(error),
          path: WORKSPACE_PATH,
          maxFiles: 0,
          sessionId: options.sessionId ?? "",
        },
      };
    }
    const sessionId = options.sessionId ?? randomSessionId();
    const unsupported = probeWorkspaceSupport();
    if (unsupported) {
      return {
        status: {
          available: false,
          reason: unsupported,
          detail:
            unsupported === "no-opfs"
              ? "This browser does not provide an origin private filesystem, so Python file output " +
                "cannot be written to disk. Files still work, but they live in memory."
              : "This browser has no synchronous file access handles, which are what let Python " +
                "write to disk without buffering the whole file in memory.",
          path: WORKSPACE_PATH,
          maxFiles,
          sessionId,
        },
      };
    }

    // Everything acquired below is tracked, so a failure PART WAY THROUGH can be undone. Untracked,
    // a browser that fails on the fortieth slot leaves thirty-nine locked files plus an open lock
    // handle on a directory it abandons - and the next session's sweep cannot reclaim that either.
    let lock: FileSystemSyncAccessHandle | null = null;
    let pool: SlotPool | null = null;
    let sessions: FileSystemDirectoryHandle | null = null;
    // Which step failed, so the message names something a person can act on rather than only
    // quoting a DOMException that could have come from any of four different calls.
    let stage = "the workspace directory";
    try {
      const E = errnoCodes(pyodide);
      const opfsRoot = await navigator.storage.getDirectory();
      sessions = await opfsRoot.getDirectoryHandle(ROOT_DIR, { create: true });
      // Before claiming any storage of our own: reclaim what dead sessions left behind.
      await removeStaleSessions(sessions, sessionId);

      const dir = await sessions.getDirectoryHandle(sessionId, { create: true });
      // The liveness marker. A sync access handle is an exclusive lock, so a later session that
      // MANAGES to open this file has proved its creator is gone - see `removeStaleSessions`. Held
      // open for the worker's lifetime and never written to.
      const lockFile = await dir.getFileHandle("lock", { create: true });
      stage = "the session lock";
      lock = await lockFile.createSyncAccessHandle();

      pool = new SlotPool(dir);
      stage = "the file slots";
      await pool.open(maxFiles);

      return {
        workspace: new Workspace({
          pyodide,
          FS: (pyodide as { FS: EmscriptenFS }).FS,
          E,
          pool,
          lock,
          sessionId,
          maxFiles,
        }),
      };
    } catch (error) {
      pool?.closeAll();
      try {
        lock?.close();
      } catch {
        // nothing further to do about a handle that will not close
      }
      try {
        await sessions?.removeEntry(sessionId, { recursive: true });
      } catch {
        // Still locked by something, or never created. The next session's stale sweep gets it -
        // and CAN get it, now that this session's own handles are closed.
      }
      return {
        status: {
          available: false,
          reason: "open-failed",
          detail:
            `The browser refused to open ${stage}: ${describe(error)}. ` +
            "Python file output will stay in memory, so large files may exhaust the tab.",
          path: WORKSPACE_PATH,
          maxFiles,
          sessionId,
        },
      };
    }
  }

  status(): WorkspaceStatus {
    const capacity = this.#pool.capacity();
    const retired = this.#pool.retired();
    return {
      available: true,
      path: WORKSPACE_PATH,
      // What it can hold NOW. A slot whose storage misbehaved is retired rather than reused, so
      // reporting the number originally asked for would describe a workspace that no longer exists.
      maxFiles: capacity,
      sessionId: this.sessionId,
      ...(capacity < this.maxFiles
        ? {
            degraded:
              `${this.maxFiles - capacity} of ${this.maxFiles} file slots were withdrawn after ` +
              `storage errors, so this workspace now holds ${capacity} files at once: ` +
              retired.join("; "),
          }
        : {}),
    };
  }

  /** Mount at `/workspace` and make it the interpreter's working directory. */
  mount(): void {
    const FS = this.#FS;
    FS.mkdirTree(WORKSPACE_PATH);
    FS.mount(this.#buildFilesystem(), {}, WORKSPACE_PATH);
    this.#root = FS.lookupPath(WORKSPACE_PATH).node;
    this.#pyodide.runPython(`import os\nos.chdir(${JSON.stringify(WORKSPACE_PATH)})\n`);
  }

  /** Every file in the workspace, deepest paths included, sorted by name. */
  list(): ArtifactInfo[] {
    if (!this.#root) return [];
    const out: ArtifactInfo[] = [];
    this.#walk(this.#root, "", out);
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  #walk(dir: FSNode, prefix: string, out: ArtifactInfo[]): void {
    for (const [name, node] of Object.entries(dir.contents ?? NO_CONTENTS)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (this.#FS.isDir(node.mode)) {
        this.#walk(node, path, out);
        continue;
      }
      const size = this.#sizeOf(node);
      const state: ArtifactInfo["state"] = node.failure
        ? "failed"
        : (node.leases?.size ?? 0) > 0
          ? "transferring"
          : (node.openCount ?? 0) > 0
            ? "open"
            : "ready";
      out.push({
        name: path,
        size,
        modifiedMs: node.timestamp,
        generation: node.generation ?? 0,
        state,
        mime: mimeForName(name),
        ...(node.failure ? { failure: node.failure } : {}),
      });
    }
  }

  /** A file's size, and what happens when the browser will not say. A size that cannot be read is
   * a FAILURE of the artifact, not a size of zero: returning 0 makes it a zero-byte artifact in
   * `ready` state, offered for download. The last size written is reported alongside it. */
  #sizeOf(node: FSNode): number {
    const slot = node.slot;
    if (!slot) return node.knownSize ?? 0;
    try {
      const size = slot.handle.getSize();
      node.knownSize = size;
      return size;
    } catch (error) {
      if (!node.failure) {
        node.failure = `the browser could not report this file's size: ${describe(error)}.`;
        node.generation = ++this.#generation;
      }
      return node.knownSize ?? 0;
    }
  }

  // transfers

  /**
   * Freeze one artifact and hand back a lease to read it through. A download is not instantaneous
   * - a gigabyte through a file picker is seconds to minutes - and during it the file must be
   * unchanged, or the bytes that arrive are half of one artifact and half of another. So `open()`
   * for writing, `unlink`, `rename` and `delete()` refuse with EBUSY until every lease is closed;
   * reading from Python still works, and every chunk re-checks the lease's `generation`.
   */
  openLease(name: string): {
    lease: string;
    name: string;
    size: number;
    mime: string;
    generation: number;
  } {
    const node = this.#requireReadable(name);
    const size = this.#sizeOf(node);
    if (node.failure) {
      // `#sizeOf` may have just discovered this; re-check rather than report a broken file ready.
      throw new Error(this.#incompleteMessage(name, node.failure));
    }
    const lease = `lease-${++this.#nextLease}`;
    const generation = node.generation ?? 0;
    (node.leases ??= new Set()).add(lease);
    this.#leases.set(lease, { node, name, size, generation, transferred: 0 });
    return { lease, name, size, mime: mimeForName(name), generation };
  }

  /**
   * Read EXACTLY `length` bytes at `offset`, or as many as remain before the end. A sync access
   * handle's `read()` returns the number of bytes it managed, and treating a short return as the
   * whole answer silently loses the middle of a download - the caller advances by `length`, so
   * the result has the right size and the wrong contents. A zero-length read before the end of
   * the file is an error.
   */
  readChunk(lease: string, offset: number, length: number): Uint8Array {
    const held = this.#leases.get(lease);
    if (!held) throw new Error(`This transfer has already finished or was cancelled.`);
    const node = held.node;
    if ((node.generation ?? 0) !== held.generation) {
      throw new Error(
        `${held.name} changed while it was being downloaded, so the transfer was stopped rather ` +
          `than delivering a file that is partly the old version and partly the new one.`,
      );
    }
    if (node.failure) throw new Error(this.#incompleteMessage(held.name, node.failure));
    const slot = node.slot;
    if (!slot) throw new Error(`${held.name} no longer has storage behind it.`);
    if (offset < 0 || offset > held.size) {
      throw new Error(`Read at ${offset} is outside ${held.name} (${held.size} bytes).`);
    }

    const want = Math.max(0, Math.min(length, held.size - offset));
    const buffer = new Uint8Array(want);
    let got = 0;
    while (got < want) {
      let read: number;
      try {
        read = slot.handle.read(buffer.subarray(got), { at: offset + got });
      } catch (error) {
        throw new Error(`${held.name} could not be read: ${describe(error)}`);
      }
      if (read <= 0) {
        // Short of the size the file itself reports. Something is wrong with the storage, and
        // padding the rest with zeros would produce a plausible-looking corrupt download.
        throw new Error(
          `${held.name} returned no data at byte ${offset + got} although it reports ` +
            `${held.size} bytes. The transfer was stopped rather than completed with a gap.`,
        );
      }
      got += read;
    }
    held.transferred = Math.max(held.transferred, offset + got);
    return buffer;
  }

  /** Release a lease. Idempotent: cancelling twice is not an error. */
  closeLease(lease: string): void {
    const held = this.#leases.get(lease);
    if (!held) return;
    this.#leases.delete(lease);
    held.node.leases?.delete(lease);
  }

  /** Every open lease, for a shutdown that has to say what it is interrupting. */
  openLeases(): number {
    return this.#leases.size;
  }

  /** The size a lease was opened at. Frozen for its lifetime, which is what `eof` is measured on. */
  leaseSize(lease: string): number {
    return this.#requireLease(lease).size;
  }

  /** The artifact generation the lease was taken at, stamped on every chunk the caller checks. */
  leaseGeneration(lease: string): number {
    return this.#requireLease(lease).generation;
  }

  #requireLease(lease: string): Lease {
    const held = this.#leases.get(lease);
    if (!held) throw new Error("This transfer has already finished or was cancelled.");
    return held;
  }

  #requireReadable(name: string): FSNode {
    const node = this.#resolve(name);
    if (!node || this.#FS.isDir(node.mode)) {
      throw new Error(`There is no artifact called ${name} in the workspace.`);
    }
    if (node.failure) throw new Error(this.#incompleteMessage(name, node.failure));
    if ((node.openCount ?? 0) > 0) {
      throw new Error(
        `${name} is still open in Python. Close the file - leave the \`with\` block - before ` +
          `downloading it.`,
      );
    }
    if (!node.slot) throw new Error(`${name} has no storage behind it.`);
    return node;
  }

  #incompleteMessage(name: string, failure: string): string {
    return (
      `${name} is incomplete: ${failure} Its bytes are partial, so it is not offered for ` +
      `download. Delete it and run the export again.`
    );
  }

  /** A SMALL artifact, as a Blob, for a preview. Hard-capped, and the cap is the point: reading
   * and concatenating every chunk keeps the WASM heap flat and still turns a two-gigabyte export
   * into a two-gigabyte browser-managed Blob before a byte reaches the user's disk. Delivery is
   * `openLease`/`readChunk`; this is for a screenful of a CSV, or a plot for an `<img>`. */
  async read(
    name: string,
    options: { maxBytes?: number } = {},
  ): Promise<{ blob: Blob; size: number; mime: string; truncated: boolean }> {
    const node = this.#requireReadable(name);
    const total = this.#sizeOf(node);
    if (node.failure) throw new Error(this.#incompleteMessage(name, node.failure));

    const requested = options.maxBytes ?? total;
    if (!Number.isSafeInteger(requested) || requested < 0) {
      throw new Error(
        `maxBytes must be a non-negative whole number, not ${String(options.maxBytes)}.`,
      );
    }
    const limit = Math.min(requested, total);
    if (limit > MAX_BLOB_BYTES) {
      throw new Error(
        `${name} is ${formatBytes(total)} and readArtifact() will not build a Blob above ` +
          `${formatBytes(MAX_BLOB_BYTES)} - the whole file would sit in browser memory before any ` +
          `of it reached a destination. Pass maxBytes for a preview, or stream it with ` +
          `streamArtifact().`,
      );
    }

    // Through a lease, so a preview is subject to the same freeze and generation check as a
    // download. A preview that races a rewrite is a smaller version of the same bug.
    const { lease } = this.openLease(name);
    try {
      const parts: Blob[] = [];
      for (let at = 0; at < limit; at += READ_CHUNK_BYTES) {
        const chunk = this.readChunk(lease, at, Math.min(READ_CHUNK_BYTES, limit - at));
        parts.push(new Blob([chunk.slice().buffer]));
        await Promise.resolve();
      }
      const mime = mimeForName(name);
      // The Blob's own type is neutral for anything active, while `mime` still reports what the
      // name suggests. A blob URL is same-origin, so a `text/html` blob is one accidental
      // navigation from being a page on the host's origin authored by whatever Python wrote.
      return {
        blob: new Blob(parts, { type: safeBlobType(mime) }),
        size: total,
        mime,
        truncated: limit < total,
      };
    } finally {
      this.closeLease(lease);
    }
  }

  /** Remove one artifact and return its slot to the pool. */
  delete(name: string): void {
    const node = this.#resolve(name);
    if (!node) throw new Error(`There is no artifact called ${name} in the workspace.`);
    if (this.#FS.isDir(node.mode)) {
      throw new Error(`${name} is a directory, not an artifact.`);
    }
    if ((node.openCount ?? 0) > 0) {
      throw new Error(`${name} is still open in Python and cannot be deleted yet.`);
    }
    if ((node.leases?.size ?? 0) > 0) {
      throw new Error(
        `${name} is being downloaded right now. Cancel the download, or wait for it to finish, ` +
          `before deleting it.`,
      );
    }
    // Through `FS.unlink`, and NOT by deleting the entry from the parent's `contents` map.
    // Emscripten keeps its own hash table of live nodes and `lookupPath` consults it, so a node
    // dropped only from the directory tree stays resolvable: gone from the list and the UI while
    // `os.path.exists()` still says `True`. `FS.unlink` calls our `unlink`, which releases the slot.
    this.#FS.unlink(`${WORKSPACE_PATH}/${name}`);
  }

  /** How many more files may exist at once. */
  freeSlots(): number {
    return this.#pool.free();
  }

  /** Turn this backend's terse errno into a sentence, appended to a traceback. `OSError` carries
   * only the errno and strerror, so `[Errno 33] Too many open files: 'chunk-4001.bin'` is all
   * Python can say about a limit that is this package's and not the operating system's. Installed
   * as a stderr annotator so the explanation lands under the traceback that needs it. */
  annotate = (text: string): string => {
    const emfile = this.#E.EMFILE as number;
    const enospc = this.#E.ENOSPC as number;
    if (text.includes(`[Errno ${emfile}]`)) {
      return (
        `${text.trimEnd()}\n` +
        `[browser-python] The workspace holds at most ${this.maxFiles} files at once, and all of ` +
        `them are in use. This is a browser limit, not a disk limit: storage handles must be ` +
        `reserved before Python asks for them. Delete files you no longer need - each deletion ` +
        `frees a slot - or write fewer files at a time. Exports that create thousands of small ` +
        `files, such as a local Zarr store, are not supported in the browser.\n`
      );
    }
    if (text.includes(`[Errno ${enospc}]`)) {
      return (
        `${text.trimEnd()}\n` +
        `[browser-python] The browser's storage quota for this origin is exhausted. The file that ` +
        `was being written is incomplete and is marked failed rather than offered for download; ` +
        `delete it and any other artifacts you do not need, then try again.\n`
      );
    }
    return text;
  };

  /** Close every handle and remove this session's directory. Best effort, always. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#pool.closeAll();
    try {
      this.#lock?.close();
    } catch {
      // nothing to do about it
    }
    this.#lock = null;
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      const sessions = await opfsRoot.getDirectoryHandle(ROOT_DIR, { create: false });
      await sessions.removeEntry(this.sessionId, { recursive: true });
    } catch {
      // A session directory that cannot be removed now is removed by the next session's stale
      // sweep, which is why that sweep exists.
    }
  }

  // node tree

  #resolve(name: string): FSNode | null {
    const parts = name.split("/").filter((part) => part !== "" && part !== ".");
    let node = this.#root;
    for (const part of parts) {
      if (!node) return null;
      const next: FSNode | undefined = (node.contents ?? NO_CONTENTS)[part];
      if (!next) return null;
      node = next;
    }
    return node === this.#root ? null : node;
  }

  /** The filesystem itself, modelled on MEMFS: directories are ordinary JS objects and cost no
   * storage, files own a slot. */
  #buildFilesystem(): unknown {
    const FS = this.#FS;
    const E = this.#E;
    const pool = this.#pool;
    const sizeOf = (node: FSNode): number => this.#sizeOf(node);
    const bump = (node: FSNode): void => {
      node.generation = ++this.#generation;
    };
    /** Refuse to change a file that a download is reading. EBUSY, and Python sees `OSError:
     * [Errno 10] Resource busy`. Letting the write through and stopping the transfer on the
     * generation check would deliver a broken download AND destroy the thing being downloaded, so
     * the writer loses; it is also the ordinary meaning of EBUSY. */
    const refuseIfLeased = (node: FSNode): void => {
      if ((node.leases?.size ?? 0) > 0) throw new FS.ErrnoError(E.EBUSY as number);
    };

    /** Record a failure on the node AND raise it, so the two can never disagree. */
    const fail = (node: FSNode, why: string, errno: number): never => {
      node.failure = why;
      throw new FS.ErrnoError(errno);
    };

    /** Wrap an OPFS call so a DOMException becomes the right errno and marks the file failed. */
    const guard = <T>(node: FSNode, what: string, action: () => T): T => {
      try {
        return action();
      } catch (error) {
        if (error instanceof FS.ErrnoError) throw error;
        fail(node, `${what} failed: ${describe(error)}.`, errnoForDomException(E, error));
        throw error; // unreachable; `fail` always throws
      }
    };

    /** Release a file's slot, unless a descriptor still refers to it. */
    const detach = (node: FSNode): void => {
      node.unlinked = true;
      if ((node.openCount ?? 0) > 0) return; // POSIX: the bytes live until the last close
      pool.release(node.slot);
      node.slot = null;
    };

    /**
     * Wrap every filesystem callback so that NOTHING but an `FS.ErrnoError` can leave it.
     * Emscripten's syscall layer checks `e.name === "ErrnoError"` and rethrows anything else into
     * the WASM stack, where Pyodide declares itself fatally failed and refuses every subsequent
     * call for the life of the worker - so one unexpected DOMException would end the session
     * rather than fail an export.
     */
    const harden = <T extends Record<string, unknown>>(ops: T): T => {
      const wrapped: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(ops)) {
        if (typeof value !== "function") {
          wrapped[name] = value;
          continue;
        }
        const fn = value as (...args: unknown[]) => unknown;
        wrapped[name] = function hardened(this: unknown, ...args: unknown[]): unknown {
          try {
            return fn.apply(this, args);
          } catch (error) {
            if (error instanceof FS.ErrnoError) throw error;
            const node = args[0] as { node?: FSNode; failure?: string | null } | undefined;
            const target = (node?.node ?? node) as FSNode | undefined;
            if (target && target.failure === null) {
              target.failure = `the browser's storage failed during ${name}: ${describe(error)}.`;
            }
            throw new FS.ErrnoError(errnoForDomException(E, error));
          }
        };
      }
      return wrapped as T;
    };

    const FSTYPE = {
      mount(): FSNode {
        return FSTYPE.createNode(null, "/", 16384 | 511, 0);
      },

      createNode(parent: FSNode | null, name: string, mode: number, dev: number): FSNode {
        // THE SLOT FIRST, and only then the node. `FS.createNode` registers the node in
        // Emscripten's name table before returning, so a `pool.take()` raising EMFILE after it
        // leaves a node with no storage: a file `exists()` reports and `listdir()` does not, which
        // crashes the interpreter with "The number NaN cannot be converted to a BigInt" on the
        // next stat. `FS.isDir` reads the mode bits, so the decision precedes the node.
        const slot = parent !== null && !FS.isDir(mode) ? pool.take(FS, E) : null;
        let node: FSNode;
        try {
          node = FS.createNode(parent, name, mode, dev);
        } catch (error) {
          // The only remaining window, and it is closed: the node was never published, so giving
          // the slot back is the whole of the cleanup.
          pool.release(slot);
          throw error;
        }
        if (FS.isDir(node.mode)) {
          node.node_ops = FSTYPE.dir_node_ops;
          // Directories need stream ops, and exactly one: `llseek`. Python's import machinery
          // lists the working directory - it is on `sys.path` - and `_fill_cache` seeks the
          // directory stream; without `llseek` that is `OSError: [Errno 70] Invalid seek:
          // '/workspace'` before any user code runs. MEMFS gives directories the same single op.
          node.stream_ops = FSTYPE.dir_stream_ops;
          node.contents = newContents();
        } else {
          node.node_ops = FSTYPE.file_node_ops;
          node.stream_ops = FSTYPE.stream_ops;
          node.openCount = 0;
          node.failure = null;
          node.knownSize = 0;
          bump(node);
          if (!slot) {
            // A file node with no parent cannot happen through any path Emscripten uses, and if it
            // ever did, a node with no storage is exactly the state this change exists to prevent.
            throw new FS.ErrnoError(E.EIO as number);
          }
          node.slot = slot;
        }
        node.timestamp = Date.now();
        if (parent) {
          (parent.contents ??= newContents())[name] = node;
          parent.timestamp = node.timestamp;
        }
        return node;
      },

      getattr(node: FSNode): Record<string, unknown> {
        const size = FS.isDir(node.mode) ? 4096 : node.slot ? sizeOf(node) : 0;
        return {
          dev: 1,
          ino: node.id,
          mode: node.mode,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: node.rdev,
          size,
          atime: new Date(node.timestamp),
          mtime: new Date(node.timestamp),
          ctime: new Date(node.timestamp),
          blksize: 4096,
          blocks: Math.ceil(size / 4096),
        };
      },

      setattr(node: FSNode, attr: { mode?: number; timestamp?: number; size?: number }): void {
        if (attr.mode !== undefined) node.mode = attr.mode;
        if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
        if (attr.size !== undefined && node.slot) {
          const slot = node.slot;
          refuseIfLeased(node);
          // A failed truncate is a failed artifact: the file is neither its old length nor its
          // new one. CONFIRMED, not assumed - a real browser was recorded returning normally from a
          // truncate it did not perform - so `truncateExactly` throws on a mismatch and `guard`
          // makes that a marked failure, and `knownSize` below is only reached when it is real.
          guard(node, "truncate", () => truncateExactly(slot.handle, attr.size as number));
          node.knownSize = attr.size;
          node.timestamp = Date.now();
          bump(node);
        }
      },

      dir_node_ops: {} as Record<string, unknown>,
      file_node_ops: {} as Record<string, unknown>,
      dir_stream_ops: {} as Record<string, unknown>,
      stream_ops: {} as Record<string, unknown>,
    };

    FSTYPE.dir_node_ops = harden({
      getattr: FSTYPE.getattr,
      setattr: FSTYPE.setattr,

      lookup(parent: FSNode, name: string): FSNode {
        const found = (parent.contents ?? NO_CONTENTS)[name];
        // `new FS.ErrnoError(ENOENT)`, not `FS.genericErrors[...]`: this build has no
        // `genericErrors` table, so reaching for it throws a TypeError from inside a syscall -
        // an unreadable stack rather than ENOENT, turning every `os.path.exists()` into a crash.
        if (!found) throw new FS.ErrnoError(E.ENOENT as number);
        return found;
      },

      mknod(parent: FSNode, name: string, mode: number, dev: number): FSNode {
        return FSTYPE.createNode(parent, name, mode, dev);
      },

      /** `os.rename` and `os.replace`, including onto an existing name. Only the NAME moves,
       * which makes temp-file-then-rename free. The destination needs care: overwriting the entry
       * in the contents map drops the old node with its slot still marked taken, leaking one pool
       * file per `os.replace()` until EMFILE with nothing in the workspace. */
      rename(oldNode: FSNode, newDir: FSNode, newName: string): void {
        refuseIfLeased(oldNode);
        const existing = (newDir.contents ?? NO_CONTENTS)[newName];
        if (existing && existing !== oldNode) refuseIfLeased(existing);
        if (existing && existing !== oldNode) {
          if (FS.isDir(existing.mode)) {
            if (!FS.isDir(oldNode.mode)) throw new FS.ErrnoError(E.EISDIR as number);
            if (Object.keys(existing.contents ?? NO_CONTENTS).length > 0) {
              throw new FS.ErrnoError(E.ENOTEMPTY as number);
            }
            // The same removal the file branch does, on the branch that did not do it. An
            // overwritten DIRECTORY is as gone as an overwritten file, and `FS.rename` removes and
            // re-adds the SOURCE only, exactly as MEMFS's own `rename` does. Otherwise `os.replace`
            // then `os.rmdir` leaves a phantom: `exists()` true, `mkdir()` ENOTDIR. No slot to
            // release - a directory never took one.
            FS.hashRemoveNode(existing);
            existing.unlinked = true;
          } else if (FS.isDir(oldNode.mode)) {
            throw new FS.ErrnoError(E.ENOTDIR as number);
          } else {
            // BOTH halves. `detach` is this filesystem's own bookkeeping - the slot, deferred
            // to the last descriptor so an already-open reader keeps its bytes - and the name
            // table is Emscripten's, which `FS.rename` does not touch for the destination.
            // Otherwise `listdir()` comes back empty while `exists()` says true.
            FS.hashRemoveNode(existing);
            detach(existing);
          }
        }
        const oldParent = oldNode.parent;
        delete (oldParent.contents ?? NO_CONTENTS)[oldNode.name];
        oldParent.timestamp = Date.now();
        oldNode.name = newName;
        (newDir.contents ??= newContents())[newName] = oldNode;
        newDir.timestamp = oldParent.timestamp;
        oldNode.parent = newDir;
        bump(oldNode);
      },

      unlink(parent: FSNode, name: string): void {
        const node = (parent.contents ?? NO_CONTENTS)[name];
        if (!node) throw new FS.ErrnoError(E.ENOENT as number);
        refuseIfLeased(node);
        // POSIX allows unlinking a file that is still open, and the descriptors keep working, so
        // the slot is only returned once the last one closes.
        detach(node);
        delete (parent.contents ?? NO_CONTENTS)[name];
        parent.timestamp = Date.now();
      },

      rmdir(parent: FSNode, name: string): void {
        const node = (parent.contents ?? NO_CONTENTS)[name];
        if (!node) throw new FS.ErrnoError(E.ENOENT as number);
        if (Object.keys(node.contents ?? NO_CONTENTS).length > 0) {
          throw new FS.ErrnoError(E.ENOTEMPTY as number);
        }
        delete (parent.contents ?? NO_CONTENTS)[name];
        parent.timestamp = Date.now();
      },

      readdir(node: FSNode): string[] {
        return [".", "..", ...Object.keys(node.contents ?? NO_CONTENTS)];
      },

      symlink(): never {
        // No symlinks: a name in this tree maps to a slot, and a second name for one slot would
        // make the pool's accounting wrong in a way no error could describe afterwards.
        throw new FS.ErrnoError(E.EPERM as number);
      },
    });

    FSTYPE.file_node_ops = harden({ getattr: FSTYPE.getattr, setattr: FSTYPE.setattr });

    FSTYPE.dir_stream_ops = harden({
      llseek(stream: { position: number }, offset: number, whence: number): number {
        let position = offset;
        if (whence === 1) position += stream.position;
        else if (whence === 2) throw new FS.ErrnoError(E.EINVAL as number);
        if (position < 0) throw new FS.ErrnoError(E.EINVAL as number);
        return position;
      },
    });

    FSTYPE.stream_ops = harden({
      open(stream: { node: FSNode; flags?: number }): void {
        // A leased file may still be READ from Python; only writing is refused. The flag test is
        // the low two bits of the POSIX open mode: 0 is O_RDONLY, 1 is O_WRONLY, 2 is O_RDWR.
        // Refusing every open would stop the interpreter looking at the file it just wrote.
        if (((stream.flags ?? 0) & 3) !== 0) refuseIfLeased(stream.node);
        stream.node.openCount = (stream.node.openCount ?? 0) + 1;
      },

      // `os.dup()` and `os.dup2()`. The callback is `stream_ops.dup(newStream)`, read out of the
      // pinned runtime: `FS.dupStream` does `createStream(orig, fd)` then `stream_ops?.dup?.()`,
      // and `open` is NOT called for the copy - so without this the descriptor count drops on the
      // original's close and the artifact is reported ready while a duplicate can still write.
      // `FS.close` calls `close` once per stream, duplicates included, so this balances.
      dup(stream: { node: FSNode }): void {
        stream.node.openCount = (stream.node.openCount ?? 0) + 1;
      },

      close(stream: { node: FSNode }): void {
        const node = stream.node;
        node.openCount = Math.max(0, (node.openCount ?? 1) - 1);
        if (node.openCount > 0) return;
        if (node.unlinked) {
          pool.release(node.slot);
          node.slot = null;
          return;
        }
        // The flush that makes an artifact ready, and it has to be HERE: `stream_ops.flush` is
        // the obvious place and CPython never reaches it, because closing a Python file writes its
        // buffer and closes the descriptor without calling `FS.flush`. A failure fails the
        // artifact: "every write returned its full length" is not "the bytes are on disk".
        const slot = node.slot;
        if (!slot) return;
        guard(node, "flush", () => slot.handle.flush());
      },

      read(
        stream: { node: FSNode },
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ): number {
        const node = stream.node;
        const slot = node.slot;
        if (!slot) throw new FS.ErrnoError(E.EBADF as number);
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
        // LOOPED, because a short read is not an answer. `read()` returns what it managed, and
        // handing that back means Python sees a short read - which for a regular file it takes as
        // end-of-file, silently truncating a 2 GiB NetCDF while every later size check calls it
        // complete. Fewer bytes is only correct at the actual end of the file.
        const end = Math.min(sizeOf(node), position + length);
        let got = 0;
        while (position + got < end) {
          const read = guard(node, "read", () =>
            slot.handle.read(view.subarray(got), { at: position + got }),
          );
          if (read <= 0) {
            fail(
              node,
              `the browser returned no data at byte ${position + got} of a file it reports as ` +
                `${sizeOf(node)} bytes.`,
              E.EIO as number,
            );
          }
          got += read;
        }
        return got;
      },

      write(
        stream: { node: FSNode },
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ): number {
        const node = stream.node;
        const slot = node.slot;
        if (!slot) throw new FS.ErrnoError(E.EBADF as number);
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
        const written = guard(node, "write", () => slot.handle.write(view, { at: position }));
        // THE SHORT-WRITE RULE, and the reason every write here is staging. OPFS reports an
        // exhausted quota by writing FEWER BYTES than it was given rather than throwing - measured
        // in the feasibility gate - so returning the short count leaves Python believing the write
        // succeeded and produces a truncated file every size check calls complete. ENOSPC, always;
        // the `written` bytes ARE on disk, so what there is is a file marked failed.
        if (written < length) {
          node.knownSize = Math.max(node.knownSize ?? 0, position + written);
          bump(node);
          fail(
            node,
            `the browser's storage quota was exhausted after ${position + written} bytes.`,
            E.ENOSPC as number,
          );
        }
        node.knownSize = Math.max(node.knownSize ?? 0, position + written);
        node.timestamp = Date.now();
        bump(node);
        return written;
      },

      llseek(stream: { node: FSNode; position: number }, offset: number, whence: number): number {
        let position = offset;
        if (whence === 1) position += stream.position;
        else if (whence === 2) {
          if (!stream.node.slot) throw new FS.ErrnoError(E.EBADF as number);
          position += sizeOf(stream.node);
        }
        if (position < 0) throw new FS.ErrnoError(E.EINVAL as number);
        return position;
      },

      flush(stream: { node: FSNode }): void {
        const node = stream.node;
        const slot = node.slot;
        if (!slot) return;
        // A failed flush means bytes that Python believes are durable are not, so the artifact is
        // failed even though every individual write returned its full length.
        guard(node, "flush", () => slot.handle.flush());
      },
    });

    return FSTYPE;
  }
}

// helpers

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** `s-<created>-<random>`, where `created` is base-36 milliseconds. The timestamp is
 * load-bearing: `sessionAgeMs` reads it to decide whether a directory is a session still starting
 * up. In the NAME rather than a marker file, which leaves no window open. */
function randomSessionId(): string {
  const created = Date.now().toString(36);
  const uuid = (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID;
  const unique =
    typeof uuid === "function"
      ? uuid.call(globalThis.crypto)
      : Math.random().toString(36).slice(2, 10);
  return `s-${created}-${unique}`;
}

/** How long a session directory is presumed to be starting rather than dead. Nothing younger is
 * touched, whatever its lock says; a session that died inside the window is reclaimed by the next
 * sweep after it expires, costing a few slot files for half a minute. */
const STARTUP_GRACE_MS = 30_000;

/** How old a session directory is, from its NAME. A marker file would need a second asynchronous
 * step after the directory exists, and the gap is a window in which a sweeping tab sees no lock
 * and no marker, decides the session died during startup, and deletes a directory another tab is
 * filling. An unparseable name - from an older version - reads as ancient, so it is reclaimed. */
function sessionAgeMs(name: string): number {
  const stamp = /^s-([0-9a-z]+)-/.exec(name)?.[1];
  const created = stamp === undefined ? Number.NaN : Number.parseInt(stamp, 36);
  if (!Number.isFinite(created)) return Number.POSITIVE_INFINITY;
  return Date.now() - created;
}

/**
 * Delete the OPFS directories of sessions that are gone. The test is the lock: a sync access
 * handle is an exclusive lock, so MANAGING to open another session's `lock` file proves nothing
 * holds it, while a live session refuses with `NoModificationAllowedError` and is left alone -
 * which is what makes two tabs on one origin safe. The age check comes FIRST, because creating a
 * lock takes two calls - the file, then the handle - and between them the file exists and nothing
 * holds it, so a sweep at that instant would delete the directory a starting session is using. No
 * ordering closes that window; it shows up under a loaded machine in the full test run.
 */
async function removeStaleSessions(
  sessions: FileSystemDirectoryHandle,
  ownSessionId: string,
): Promise<void> {
  const names: string[] = [];
  try {
    for await (const name of (sessions as unknown as { keys(): AsyncIterable<string> }).keys()) {
      // Young directories are skipped without being opened: a session still coming up may not
      // have taken its lock yet, and no observation tells that apart from one that died a moment
      // ago.
      if (name !== ownSessionId && sessionAgeMs(name) >= STARTUP_GRACE_MS) names.push(name);
    }
  } catch {
    return; // no directory iteration in this browser: skip the sweep rather than fail startup
  }

  for (const name of names) {
    let claimed: FileSystemSyncAccessHandle | null = null;
    try {
      const dir = await sessions.getDirectoryHandle(name, { create: false });
      const lockFile = await dir.getFileHandle("lock", { create: false });
      claimed = await lockFile.createSyncAccessHandle();
    } catch (error) {
      // `NoModificationAllowedError` means a live session holds it - leave it strictly alone.
      // `NotFoundError` on a directory this old means a startup that died before taking its lock.
      if ((error as { name?: string } | null)?.name !== "NotFoundError") continue;
    }

    try {
      claimed?.close();
      await sessions.removeEntry(name, { recursive: true });
    } catch {
      // still in use, or already gone
    }
  }
}
