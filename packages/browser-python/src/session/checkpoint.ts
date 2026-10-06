// Checkpoints for sleeping sessions: a session's committed workspace files, streamed into a store
// of their own in the origin private file system, with a manifest written LAST. The manifest is
// the commit: a directory without one is incomplete and is never restored.
//
// Restoring verifies every file's size and SHA-256 as it streams, and fails before the last byte
// is handed over, so a damaged file never lands in a workspace. A checkpoint that fails
// verification is quarantined: kept, marked, and refused.
//
// Each checkpoint is owned through a Web Lock while its session exists, so a later page can tell
// an abandoned checkpoint (removed when a store opens) from one a sleeping session still needs.

import { canonicalJson, type SessionSetup } from "./policy.js";
import { Sha256 } from "./sha256.js";
import { workspaceNameProblem } from "../workspace-names.js";

export const CHECKPOINT_ROOT = "browser-python-checkpoints";
export const CHECKPOINT_FORMAT = 1;
const MANIFEST = "manifest.json";
const QUARANTINE = "QUARANTINE";
const LOCK_PREFIX = "browser-python-checkpoint:";

export interface CheckpointLimits {
  maxFiles: number;
  maxBytes: number;
  /** Free space to leave in the origin's quota beyond the checkpoint itself. */
  reserveBytes: number;
}

export const DEFAULT_CHECKPOINT_LIMITS: CheckpointLimits = {
  maxFiles: 1024,
  maxBytes: 1024 * 1024 * 1024,
  reserveBytes: 16 * 1024 * 1024,
};

export interface CheckpointFile {
  /** The workspace name. */
  name: string;
  size: number;
  sha256: string;
  /** The stored file inside the checkpoint directory. */
  data: string;
}

export interface CheckpointManifest {
  format: typeof CHECKPOINT_FORMAT;
  id: string;
  createdAt: number;
  setup: SessionSetup;
  /** The policy fingerprint the setup was validated under. */
  policy: string;
  files: CheckpointFile[];
  totalBytes: number;
  /** SHA-256 of the canonical manifest without this field. */
  seal: string;
}

export type CheckpointErrorCode =
  | "unsupported"
  | "limit"
  | "quota"
  | "corrupt"
  | "quarantined"
  | "io";

export class CheckpointError extends Error {
  constructor(
    readonly code: CheckpointErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CheckpointError";
  }
}

// The subset of the File System Access API used here, so tests can supply a store in memory.
export interface WritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
export interface FileHandleLike {
  readonly kind: "file";
  getFile(): Promise<Blob>;
  createWritable?(): Promise<WritableLike>;
}
export interface DirectoryHandleLike {
  readonly kind: "directory";
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys?(): AsyncIterable<string>;
}
interface LocksLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
  query?(): Promise<{ held?: { name?: string }[]; pending?: { name?: string }[] }>;
}

export interface CheckpointStoreOptions {
  /** Defaults to the origin private file system's root. */
  root?: DirectoryHandleLike;
  limits?: Partial<CheckpointLimits>;
  /** Defaults to `navigator.locks`; `null` disables ownership (and the sweep). */
  locks?: LocksLike | null;
  /** Defaults to `navigator.storage.estimate`. */
  estimate?: (() => Promise<{ quota?: number; usage?: number }>) | null;
}

export interface CheckpointWriter {
  readonly id: string;
  /** A sink for one planned file. The engine's `streamArtifact` writes into it. */
  file(name: string): WritableStream<Uint8Array>;
  /** Write the manifest. Every planned file must have been closed. */
  commit(meta: { setup: SessionSetup; policy: string }): Promise<CheckpointManifest>;
  /** Remove everything written so far. Idempotent. */
  abort(): Promise<void>;
}

export interface CheckpointStore {
  readonly limits: CheckpointLimits;
  begin(id: string, plan: readonly { name: string; size: number }[]): Promise<CheckpointWriter>;
  /**
   * The verified manifest. Throws `corrupt` or `quarantined`; `io` when storage failed to read
   * (it may work again: never a reason to quarantine).
   */
  read(id: string): Promise<CheckpointManifest>;
  /** One file's bytes, verified while streaming: a mismatch errors the stream before it ends. */
  open(manifest: CheckpointManifest, file: CheckpointFile): ReadableStream<Uint8Array>;
  quarantine(id: string, reason: string): Promise<void>;
  /** Delete a checkpoint and give up its ownership. */
  discard(id: string): Promise<void>;
  list(): Promise<{ ready: string[]; quarantined: { id: string; reason: string }[] }>;
}

const ID = /^[A-Za-z0-9_-]{1,96}$/;

/** Checkpoints this document owns, per lock manager: shared by every store opened here. */
const OWNED = new WeakMap<object, Map<string, () => void>>();
const UNLOCKED = {};

function checkId(id: string): void {
  if (!ID.test(id)) throw new CheckpointError("io", `'${id}' is not a checkpoint id`);
}

/**
 * A workspace-relative name a checkpoint may carry: exactly what a workspace import accepts, so a
 * checkpoint that can be written can be restored. `code` says whose fault a bad name is.
 */
function checkName(name: string, code: CheckpointErrorCode = "corrupt"): void {
  const problem = workspaceNameProblem(name);
  if (problem) {
    throw new CheckpointError(
      code,
      code === "corrupt"
        ? `'${name}' is not a workspace file name (${problem})`
        : `'${name}' could not be restored on wake (${problem}), so the session stays awake`,
    );
  }
}

function sealOf(manifest: Omit<CheckpointManifest, "seal">): string {
  return new Sha256().update(new TextEncoder().encode(canonicalJson(manifest))).digest();
}

/** Parse and verify a manifest's shape and seal. */
export function parseManifest(id: string, text: string): CheckpointManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CheckpointError("corrupt", "the checkpoint manifest is not JSON");
  }
  const m = raw as Partial<CheckpointManifest> | null;
  const fail = (why: string): never => {
    throw new CheckpointError("corrupt", `the checkpoint manifest ${why}`);
  };
  if (!m || typeof m !== "object") return fail("is not an object");
  if (m.format !== CHECKPOINT_FORMAT) fail("has an unknown format");
  if (m.id !== id) fail("belongs to another checkpoint");
  if (typeof m.policy !== "string" || typeof m.seal !== "string") fail("is incomplete");
  if (!m.setup || typeof m.setup !== "object") fail("has no setup");
  if (!Array.isArray(m.files)) fail("has no file list");
  let total = 0;
  const names = new Set<string>();
  const data = new Set<string>();
  for (const file of m.files!) {
    if (!file || typeof file !== "object") fail("lists a non-file");
    checkName(file.name);
    if (!Number.isSafeInteger(file.size) || file.size < 0) fail(`gives ${file.name} a bad size`);
    if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      fail(`gives ${file.name} a bad digest`);
    }
    if (typeof file.data !== "string" || !/^f[0-9]+$/.test(file.data))
      fail("names a bad data file");
    if (names.has(file.name) || data.has(file.data)) fail("lists a file twice");
    names.add(file.name);
    data.add(file.data);
    total += file.size;
  }
  if (m.totalBytes !== total) fail("disagrees with its own total");
  const { seal, ...body } = m as CheckpointManifest;
  if (sealOf(body) !== seal) fail("fails its seal");
  return m as CheckpointManifest;
}

/**
 * The file's text, or null when there is no such file. Any other failure is `io`: storage that
 * failed for a moment says nothing about the checkpoint, so it is never taken as corrupt.
 */
async function readText(dir: DirectoryHandleLike, name: string): Promise<string | null> {
  try {
    const handle = await dir.getFileHandle(name);
    return await (await handle.getFile()).text();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new CheckpointError("io", `could not read ${name}: ${messageOf(error)}`);
  }
}

function isNotFound(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "NotFoundError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeText(dir: DirectoryHandleLike, name: string, text: string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable!();
  try {
    await writable.write(new TextEncoder().encode(text));
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

/**
 * Open the checkpoint store, or `null` when this browser cannot keep one: no origin private file
 * system, or no writable streams on it (which the main thread needs).
 */
export async function openCheckpointStore(
  options: CheckpointStoreOptions = {},
): Promise<CheckpointStore | null> {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  let root = options.root;
  if (!root) {
    if (typeof nav?.storage?.getDirectory !== "function") return null;
    try {
      root = (await nav.storage.getDirectory()) as unknown as DirectoryHandleLike;
    } catch {
      return null;
    }
  }
  let base: DirectoryHandleLike;
  try {
    base = await root.getDirectoryHandle(CHECKPOINT_ROOT, { create: true });
    // A name of its own: two stores opening at once never remove each other's probe.
    const name = `.probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const probe = await base.getFileHandle(name, { create: true });
    if (typeof probe.createWritable !== "function") return null;
    const writable = await probe.createWritable();
    await writable.close();
    await base.removeEntry(name);
  } catch {
    return null;
  }

  const limits = { ...DEFAULT_CHECKPOINT_LIMITS, ...options.limits };
  const locks =
    options.locks !== undefined
      ? options.locks
      : ((nav as { locks?: LocksLike } | undefined)?.locks ?? null);
  const estimate =
    options.estimate !== undefined
      ? options.estimate
      : typeof nav?.storage?.estimate === "function"
        ? () => nav.storage.estimate()
        : null;
  const key = locks ?? UNLOCKED;
  const owned = OWNED.get(key) ?? new Map<string, () => void>();
  OWNED.set(key, owned);

  const own = (id: string): Promise<boolean> => {
    if (!locks) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      locks
        .request(`${LOCK_PREFIX}${id}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          return new Promise<void>((release) => {
            owned.set(id, release);
            resolve(true);
          });
        })
        .catch(reject);
    });
  };
  const disown = (id: string): void => {
    owned.get(id)?.();
    owned.delete(id);
  };

  const ids = async (): Promise<string[]> => {
    if (!base.keys) return [];
    const out: string[] = [];
    for await (const name of base.keys()) if (ID.test(name)) out.push(name);
    return out.sort();
  };

  // Abandoned checkpoints: their pages are gone, and so are the sessions that could wake them.
  // Each is removed only while holding its own lock, so a session that takes ownership in the
  // meantime (and saves) keeps its files: a snapshot of who held what would already be stale.
  if (locks) {
    try {
      for (const id of await ids()) {
        await locks
          .request(`${LOCK_PREFIX}${id}`, { ifAvailable: true }, async (lock) => {
            if (!lock) return;
            await base.removeEntry(id, { recursive: true }).catch(() => undefined);
          })
          .catch(() => undefined);
      }
    } catch {
      // A sweep that cannot run leaves the files for the next one.
    }
  }

  const store: CheckpointStore = {
    limits,
    async begin(id, plan) {
      checkId(id);
      if (plan.length > limits.maxFiles) {
        throw new CheckpointError(
          "limit",
          `${plan.length} files is more than a checkpoint keeps (${limits.maxFiles})`,
        );
      }
      let total = 0;
      for (const entry of plan) {
        checkName(entry.name, "limit");
        total += entry.size;
      }
      if (total > limits.maxBytes) {
        throw new CheckpointError(
          "limit",
          `${mib(total)} of files is more than a checkpoint keeps (${mib(limits.maxBytes)})`,
        );
      }
      if (estimate) {
        const { quota, usage } = await estimate().catch(
          () => ({}) as { quota?: number; usage?: number },
        );
        if (
          quota !== undefined &&
          usage !== undefined &&
          quota - usage < total + limits.reserveBytes
        ) {
          throw new CheckpointError(
            "quota",
            `this browser has ${mib(Math.max(0, quota - usage))} of storage left for this site, ` +
              `and the files need ${mib(total)}`,
          );
        }
      }
      if (!owned.has(id) && !(await own(id))) {
        throw new CheckpointError("io", `checkpoint ${id} belongs to another session`);
      }
      await base.removeEntry(id, { recursive: true }).catch(() => undefined);
      const dir = await base.getDirectoryHandle(id, { create: true });
      const planned = new Map(plan.map((entry, index) => [entry.name, { ...entry, index }]));
      const written = new Map<string, CheckpointFile>();
      let aborted = false;

      const writer: CheckpointWriter = {
        id,
        file(name) {
          const entry = planned.get(name);
          if (!entry) throw new CheckpointError("io", `${name} is not in the checkpoint plan`);
          const data = `f${entry.index}`;
          let writable: WritableLike | null = null;
          const hash = new Sha256();
          let bytes = 0;
          return new WritableStream<Uint8Array>({
            async start() {
              const handle = await dir.getFileHandle(data, { create: true });
              writable = await handle.createWritable!();
            },
            async write(chunk) {
              bytes += chunk.byteLength;
              if (bytes > entry.size) {
                throw new CheckpointError("io", `${name} grew while it was being saved`);
              }
              hash.update(chunk);
              await writable!.write(chunk);
            },
            async close() {
              if (bytes !== entry.size) {
                await writable!.abort().catch(() => undefined);
                throw new CheckpointError("io", `${name} changed size while it was being saved`);
              }
              await writable!.close();
              written.set(name, { name, size: bytes, sha256: hash.digest(), data });
            },
            async abort(reason) {
              await writable?.abort(reason).catch(() => undefined);
            },
          });
        },
        async commit(meta) {
          if (aborted) throw new CheckpointError("io", "the checkpoint was abandoned");
          const missing = plan.filter((entry) => !written.has(entry.name)).map((e) => e.name);
          if (missing.length > 0) {
            throw new CheckpointError("io", `not saved: ${missing.slice(0, 3).join(", ")}`);
          }
          const files = plan.map((entry) => written.get(entry.name)!);
          const body = {
            format: CHECKPOINT_FORMAT,
            id,
            createdAt: Date.now(),
            setup: meta.setup,
            policy: meta.policy,
            files,
            totalBytes: files.reduce((sum, file) => sum + file.size, 0),
          } as const;
          const manifest: CheckpointManifest = { ...body, seal: sealOf(body) };
          await writeText(dir, MANIFEST, JSON.stringify(manifest));
          return manifest;
        },
        async abort() {
          if (aborted) return;
          aborted = true;
          await base.removeEntry(id, { recursive: true }).catch(() => undefined);
          disown(id);
        },
      };
      return writer;
    },

    async read(id) {
      checkId(id);
      let dir: DirectoryHandleLike;
      try {
        dir = await base.getDirectoryHandle(id);
      } catch (error) {
        if (!isNotFound(error)) {
          throw new CheckpointError("io", `could not open checkpoint ${id}: ${messageOf(error)}`);
        }
        throw new CheckpointError("corrupt", `checkpoint ${id} does not exist`);
      }
      const reason = await readText(dir, QUARANTINE);
      if (reason !== null)
        throw new CheckpointError("quarantined", `checkpoint ${id} is quarantined: ${reason}`);
      const text = await readText(dir, MANIFEST);
      if (text === null)
        throw new CheckpointError("corrupt", `checkpoint ${id} was never completed`);
      return parseManifest(id, text);
    },

    open(manifest, file) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const hash = new Sha256();
      let bytes = 0;
      return new ReadableStream<Uint8Array>({
        async start() {
          const dir = await base.getDirectoryHandle(manifest.id);
          const blob = await (await dir.getFileHandle(file.data)).getFile();
          if (blob.size !== file.size) {
            throw new CheckpointError(
              "corrupt",
              `${file.name} is ${blob.size} bytes, not ${file.size}`,
            );
          }
          reader = blob.stream().getReader() as ReadableStreamDefaultReader<Uint8Array>;
        },
        async pull(controller) {
          const { done, value } = await reader!.read();
          if (done) {
            if (bytes !== file.size || hash.digest() !== file.sha256) {
              controller.error(
                new CheckpointError("corrupt", `${file.name} does not match its digest`),
              );
            } else controller.close();
            return;
          }
          bytes += value.byteLength;
          hash.update(value);
          // Hold the final chunk back until the digest is known, so a mismatch errors the
          // stream before every byte has been handed over.
          if (bytes === file.size) {
            const tail = await reader!.read();
            if (!tail.done || hash.digest() !== file.sha256) {
              controller.error(
                new CheckpointError("corrupt", `${file.name} does not match its digest`),
              );
              return;
            }
            controller.enqueue(value);
            controller.close();
            return;
          }
          controller.enqueue(value);
        },
        async cancel(reason) {
          await reader?.cancel(reason);
        },
      });
    },

    async quarantine(id, reason) {
      checkId(id);
      const dir = await base.getDirectoryHandle(id, { create: true });
      await writeText(dir, QUARANTINE, reason.slice(0, 1000));
    },

    async discard(id) {
      checkId(id);
      await base.removeEntry(id, { recursive: true }).catch(() => undefined);
      disown(id);
    },

    async list() {
      const ready: string[] = [];
      const quarantined: { id: string; reason: string }[] = [];
      for (const id of await ids()) {
        try {
          await store.read(id);
          ready.push(id);
        } catch (error) {
          quarantined.push({ id, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return { ready, quarantined };
    },
  };
  return store;
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
