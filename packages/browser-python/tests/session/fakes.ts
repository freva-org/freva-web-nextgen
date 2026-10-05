// In-memory stand-ins for the origin private file system, Web Locks and an engine, enough for the
// session module. The browser suite (`browser-tests/sessions.mjs`) runs the same paths for real.
import type { DirectoryHandleLike, FileHandleLike } from "../../src/session/checkpoint.js";
import type { ArtifactInfo, BrowserPython, StatusEvent } from "../../src/types.js";

export class MemoryFile implements FileHandleLike {
  readonly kind = "file" as const;
  bytes = new Uint8Array(0);
  getFile(): Promise<Blob> {
    return Promise.resolve(new Blob([this.bytes]));
  }
  createWritable() {
    const parts: Uint8Array[] = [];
    let closed = false;
    return Promise.resolve({
      write: (data: Uint8Array) => {
        if (closed) throw new Error("closed");
        parts.push(new Uint8Array(data));
        return Promise.resolve();
      },
      // Committed only on close, as the platform's swap file does.
      close: () => {
        closed = true;
        const total = parts.reduce((n, p) => n + p.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const part of parts) {
          out.set(part, at);
          at += part.length;
        }
        this.bytes = out;
        return Promise.resolve();
      },
      abort: () => {
        closed = true;
        return Promise.resolve();
      },
    });
  }
}

export class MemoryDirectory implements DirectoryHandleLike {
  readonly kind = "directory" as const;
  entries = new Map<string, MemoryDirectory | MemoryFile>();
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    const found = this.entries.get(name);
    if (found instanceof MemoryDirectory) return Promise.resolve(found);
    if (found || !options?.create)
      return Promise.reject(new DOMException("missing", "NotFoundError"));
    const dir = new MemoryDirectory();
    this.entries.set(name, dir);
    return Promise.resolve(dir);
  }
  getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    const found = this.entries.get(name);
    if (found instanceof MemoryFile) return Promise.resolve(found);
    if (found || !options?.create)
      return Promise.reject(new DOMException("missing", "NotFoundError"));
    const file = new MemoryFile();
    this.entries.set(name, file);
    return Promise.resolve(file);
  }
  removeEntry(name: string): Promise<void> {
    if (!this.entries.delete(name))
      return Promise.reject(new DOMException("missing", "NotFoundError"));
    return Promise.resolve();
  }
  async *keys(): AsyncIterable<string> {
    for (const key of [...this.entries.keys()]) yield key;
  }
  /** Test helper: a path inside this tree. */
  async at(...path: string[]): Promise<MemoryFile> {
    const parent = path.length > 1 ? await this.getDirectoryHandle(path[0]!) : null;
    if (parent) return parent.at(...path.slice(1));
    return this.getFileHandle(path[0]!);
  }
}

/** A lock manager whose check-and-take is synchronous, like the platform's. */
export class FakeLocks {
  held = new Set<string>();
  async request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => unknown,
  ) {
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      throw new Error("waiting is not modelled");
    }
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
  query() {
    return Promise.resolve({ held: [...this.held].map((name) => ({ name })), pending: [] });
  }
}

/** An engine with a workspace in a Map. */
export class FakeEngine {
  files = new Map<string, Uint8Array>();
  open = new Set<string>();
  state: string = "idle";
  busy = false;
  disposed = false;
  quiesced = false;
  starts = 0;
  log: string[] = [];
  listeners = new Set<(event: StatusEvent) => void>();
  failStart: Error | null = null;

  constructor(readonly label: string) {}

  emit(state: string) {
    this.state = state;
    for (const listener of this.listeners) listener({ type: "status", state } as StatusEvent);
  }
  onStatus(listener: (event: StatusEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async start() {
    this.starts += 1;
    this.log.push("start");
    if (this.failStart) throw this.failStart;
    this.emit("ready");
    return {} as never;
  }
  async restart() {
    this.log.push("restart");
    this.files.clear();
    this.emit("ready");
    return {} as never;
  }
  async quiesce() {
    if (this.busy) throw Object.assign(new Error("Python is running"), { code: "busy" });
    const open = [...this.open];
    if (open.length > 0) throw Object.assign(new Error(`${open[0]} is open`), { code: "busy" });
    this.quiesced = true;
    return () => {
      this.quiesced = false;
    };
  }
  async artifacts(): Promise<ArtifactInfo[]> {
    return [...this.files].map(([name, bytes], index) => ({
      name,
      size: bytes.length,
      modifiedMs: 0,
      generation: index,
      state: this.open.has(name) ? "open" : "ready",
      mime: "application/octet-stream",
    })) as ArtifactInfo[];
  }
  async streamArtifact(name: string, destination: WritableStream<Uint8Array>) {
    const bytes = this.files.get(name)!;
    const writer = destination.getWriter();
    for (let at = 0; at < bytes.length; at += 1000) await writer.write(bytes.slice(at, at + 1000));
    await writer.close();
    return { bytesWritten: bytes.length, name, mime: "application/octet-stream" };
  }
  async writeWorkspaceFile(
    name: string,
    source: ReadableStream<Uint8Array>,
    options: { size: number },
  ) {
    this.log.push(`write ${name}`);
    const parts: Uint8Array[] = [];
    const reader = source.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const out = new Uint8Array(options.size);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    if (at !== options.size) throw new Error("short");
    this.files.set(name, out);
    return { name, size: options.size };
  }
  async observeResources() {
    return {
      workerGeneration: this.label,
      sampledAt: Date.now(),
      wasmCapacityBytes: 64 * 1024 * 1024,
      pendingExecutions: 0,
      activeTransfers: 0,
      sampleStale: false,
    };
  }
  async disposeAsync() {
    this.log.push("dispose");
    this.disposed = true;
    this.emit("disposed");
  }
  /** As an engine, for the controller's types. */
  asEngine(): BrowserPython {
    return this as unknown as BrowserPython;
  }
}
