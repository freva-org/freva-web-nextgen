/* eslint-disable */
/**
 * PROBE ONLY. Can a legacy-filesystem `open()` SUSPEND while an OPFS handle is acquired
 * asynchronously - with no SharedArrayBuffer, no COOP/COEP and no custom runtime? The pooled
 * backend already works; its one bound is that a single execution cannot create more files than
 * there are free slots, which is what stops `to_zarr()`.
 *
 * A probe and not a design because a Promise that leaks into synchronous filesystem code does not
 * fail loudly: it becomes a truthy object where a byte count was expected. So it reports the shape
 * of what came back, not merely whether something was thrown.
 */

let pyodide = null;
let FS = null;
let pool = null;

/** The runtime's own errno table - see the note in `pool-fs-worker.js`. Never hard-coded. */
let E = null;

function errnoCodes(py) {
  const table = py.ERRNO_CODES ?? py._module?.ERRNO_CODES ?? py._api?._module?.ERRNO_CODES ?? null;
  if (!table || typeof table.ENOSPC !== "number") {
    throw new Error(
      "this Pyodide build does not expose ERRNO_CODES; refusing to guess errno values",
    );
  }
  return table;
}

// OPFS, acquired on demand
class Workspace {
  constructor() {
    this.dir = null;
    this.handles = new Map(); // slot name -> sync access handle
    this.acquisitions = 0;
  }

  async init(slotCount) {
    const root = await navigator.storage.getDirectory();
    this.dir = await root.getDirectoryHandle("jspi-probe", { create: true });
    this.pool = [];
    for (let i = 0; i < slotCount; i += 1) {
      const fh = await this.dir.getFileHandle(`slot-${i}`, { create: true });
      const handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      this.pool.push({ index: i, fileHandle: fh, handle, taken: false });
    }
  }

  /** The asynchronous acquisition a suspending open() would have to wait for. */
  async acquireAsync(name) {
    this.acquisitions += 1;
    const fh = await this.dir.getFileHandle(`file-${name}`, { create: true });
    const handle = await fh.createSyncAccessHandle();
    handle.truncate(0);
    return { fileHandle: fh, handle };
  }

  takeSync(FS) {
    const slot = this.pool.find((s) => !s.taken);
    if (!slot) {
      // An FS.ErrnoError, not a bare Error: only the former is translated into a Python OSError. A
      // plain Error escapes the syscall as an unhandled JS exception, surfacing as a page error -
      // the control run reported "pool exhausted" that way instead of the ENOSPC it means.
      throw new FS.ErrnoError(E.EMFILE);
    }
    slot.taken = true;
    slot.handle.truncate(0);
    return slot;
  }

  release(slot) {
    if (!slot || slot.index === undefined) return;
    slot.handle.truncate(0);
    slot.taken = false;
  }

  closeAll() {
    for (const s of this.pool ?? []) {
      try {
        s.handle.close();
      } catch {}
    }
    for (const h of this.handles.values()) {
      try {
        h.close();
      } catch {}
    }
  }
}

/**
 * The suspension attempt. Pyodide's JSPI is one suspending import (`syncifyHandler`) gated by a
 * `validSuspender` WASM global, which Python reaches through `pyodide.ffi.run_sync`; the question
 * is whether JS can reach it while WASM is on the stack. Every route is tried and each outcome
 * recorded, because "it threw" and "it returned a Promise" are different answers.
 */
function trySuspend(promise, module) {
  const attempts = [];
  attempts.push({
    route: "validSuspender AT THE FS CALLBACK",
    outcome:
      module && module.validSuspender ? `value=${String(module.validSuspender.value)}` : "absent",
  });
  const record = (route, fn) => {
    try {
      const value = fn();
      const isPromise =
        value !== null && typeof value === "object" && typeof value.then === "function";
      attempts.push({
        route,
        outcome: isPromise ? "RETURNED A PROMISE" : "returned a value",
        type: typeof value,
        isPromise,
      });
      return { ok: !isPromise, value, isPromise };
    } catch (err) {
      attempts.push({ route, outcome: "threw", error: String(err).split("\n")[0].slice(0, 160) });
      return { ok: false, error: err };
    }
  };

  // 1. A JS-callable syncify, if one is exported at all.
  if (module && typeof module.syncify === "function") {
    const r = record("Module.syncify()", () => module.syncify(promise));
    if (r.ok) return { resolved: r.value, attempts };
  } else {
    attempts.push({ route: "Module.syncify()", outcome: "absent" });
  }

  // 2. Pyodide's Python-facing run_sync, driven from JS.
  const r2 = record("pyodide.ffi.run_sync via runPython", () => {
    const runSync = pyodide.runPython("from pyodide.ffi import run_sync\nrun_sync");
    return runSync(promise);
  });
  if (r2.ok) return { resolved: r2.value, attempts };

  // 3. The suspender global, to see whether suspension is even permitted on this stack.
  try {
    const vs = module && module.validSuspender;
    attempts.push({
      route: "validSuspender global",
      outcome: vs ? `value=${String(vs.value)}` : "absent",
    });
  } catch (err) {
    attempts.push({
      route: "validSuspender global",
      outcome: "threw",
      error: String(err).slice(0, 120),
    });
  }

  return { resolved: undefined, attempts };
}

// the filesystem
function makeFS(FS, ws, mode, diag) {
  const JSPIFS = {
    mount() {
      return JSPIFS.createNode(null, "/", 16384 | 511, 0);
    },
    createNode(parent, name, mode_, dev) {
      const node = FS.createNode(parent, name, mode_, dev);
      if (FS.isDir(node.mode)) {
        node.node_ops = JSPIFS.dir_node_ops;
        node.stream_ops = JSPIFS.dir_stream_ops;
        node.contents = {};
      } else {
        node.node_ops = JSPIFS.file_node_ops;
        node.stream_ops = JSPIFS.stream_ops;
        if (mode === "jspi") {
          // THE ATTEMPT: acquire asynchronously, from inside a synchronous FS callback.
          const outcome = trySuspend(ws.acquireAsync(node.id), pyodide._module);
          diag.attempts.push({ file: name, attempts: outcome.attempts });
          if (!outcome.resolved || typeof outcome.resolved.handle?.write !== "function") {
            const err = new FS.ErrnoError(E.EIO);
            err.jspiFailed = true;
            throw err;
          }
          node.slot = outcome.resolved;
        } else {
          node.slot = ws.takeSync(FS);
        }
      }
      node.timestamp = Date.now();
      if (parent) {
        parent.contents[name] = node;
        parent.timestamp = node.timestamp;
      }
      return node;
    },
    getattr(node) {
      const size = FS.isDir(node.mode) ? 4096 : node.slot ? node.slot.handle.getSize() : 0;
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
    setattr(node, attr) {
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
      if (attr.size !== undefined && node.slot) node.slot.handle.truncate(attr.size);
    },
  };

  JSPIFS.dir_node_ops = {
    getattr: JSPIFS.getattr,
    setattr: JSPIFS.setattr,
    lookup(parent, name) {
      const found = parent.contents[name];
      if (!found) throw new FS.ErrnoError(E.ENOENT);
      return found;
    },
    mknod(parent, name, mode_, dev) {
      return JSPIFS.createNode(parent, name, mode_, dev);
    },
    rename(oldNode, newDir, newName) {
      delete oldNode.parent.contents[oldNode.name];
      oldNode.name = newName;
      newDir.contents[newName] = oldNode;
      oldNode.parent = newDir;
      newDir.timestamp = Date.now();
    },
    unlink(parent, name) {
      const node = parent.contents[name];
      if (node && node.slot) {
        if (node.slot.index !== undefined) ws.release(node.slot);
        else
          try {
            node.slot.handle.close();
          } catch {}
      }
      delete parent.contents[name];
      parent.timestamp = Date.now();
    },
    rmdir(parent, name) {
      const node = parent.contents[name];
      for (const _ in node.contents) throw new FS.ErrnoError(E.ENOTEMPTY);
      delete parent.contents[name];
    },
    readdir(node) {
      return [".", "..", ...Object.keys(node.contents)];
    },
    symlink() {
      throw new FS.ErrnoError(E.EPERM);
    },
  };

  JSPIFS.file_node_ops = { getattr: JSPIFS.getattr, setattr: JSPIFS.setattr };

  JSPIFS.dir_stream_ops = {
    llseek(stream, offset, whence) {
      let p = offset;
      if (whence === 1) p += stream.position;
      else if (whence === 2) throw new FS.ErrnoError(E.EINVAL);
      if (p < 0) throw new FS.ErrnoError(E.EINVAL);
      return p;
    },
  };

  JSPIFS.stream_ops = {
    read(stream, buffer, offset, length, position) {
      const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      return stream.node.slot.handle.read(view, { at: position });
    },
    write(stream, buffer, offset, length, position) {
      const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      const written = stream.node.slot.handle.write(view, { at: position });
      // THE SHORT-WRITE RULE, preserved from the feasibility gate. OPFS reports an exhausted quota
      // by writing FEWER BYTES, not by throwing, so returning the short count leaves Python
      // believing the write succeeded. ENOSPC, always.
      if (written < length) {
        diag.shortWrites += 1;
        throw new FS.ErrnoError(E.ENOSPC);
      }
      stream.node.timestamp = Date.now();
      return written;
    },
    llseek(stream, offset, whence) {
      let p = offset;
      if (whence === 1) p += stream.position;
      else if (whence === 2) p += stream.node.slot.handle.getSize();
      if (p < 0) throw new FS.ErrnoError(E.EINVAL);
      return p;
    },
    close() {},
    flush(stream) {
      if (stream.node && stream.node.slot) stream.node.slot.handle.flush();
    },
  };

  return JSPIFS;
}

const report = (o) => self.postMessage(o);

self.onmessage = async (event) => {
  const { indexURL, mode, slots, fileCount } = event.data;
  const diag = { attempts: [], shortWrites: 0 };
  try {
    const { loadPyodide } = await import(`${indexURL}pyodide.mjs`);
    pyodide = await loadPyodide({ indexURL });
    FS = pyodide.FS;
    E = errnoCodes(pyodide);
    const mod = pyodide._module;

    // first: what does this runtime actually expose?
    const capability = {
      newJspiSupported: mod?.newJspiSupported ?? null,
      oldJspiSupported: mod?.oldJspiSupported ?? null,
      hasWebAssemblyPromising: typeof WebAssembly.promising === "function",
      hasWebAssemblySuspending: typeof WebAssembly.Suspending === "function",
      hasValidSuspender: Boolean(mod && mod.validSuspender),
      moduleSyncifyType: typeof mod?.syncify,
      // Every Module key that even looks like a suspension entry point, because "absent" should
      // mean "looked for it", not "guessed at one name".
      moduleSuspendKeys: mod
        ? Object.keys(mod)
            .filter((k) => /syncify|suspend|jspi|promising/i.test(k))
            .slice(0, 30)
        : [],
      apiSuspendKeys:
        mod && mod.API
          ? Object.keys(mod.API)
              .filter((k) => /syncify|suspend|jspi|promising/i.test(k))
              .slice(0, 30)
          : [],
      crossOriginIsolated: self.crossOriginIsolated ?? null,
      hasSAB: typeof SharedArrayBuffer !== "undefined",
    };
    // Does Python-side run_sync work at all on this build?
    try {
      const v = await pyodide.runPythonAsync(`
from pyodide.ffi import run_sync
import js
run_sync(js.Promise.resolve(41)) + 1
`);
      capability.pythonRunSync = v;
    } catch (err) {
      capability.pythonRunSyncError = String(err).split("\n").pop().slice(0, 200);
    }

    ws = pool = new Workspace();
    await pool.init(slots);

    const JSPIFS = makeFS(FS, pool, mode, diag);
    FS.mkdirTree("/workspace");
    FS.mount(JSPIFS, {}, "/workspace");
    pyodide.runPython("import os\nos.chdir('/workspace')");

    const heap = () => {
      const m = pyodide._module;
      if (m && m.HEAPU8) return m.HEAPU8.length;
      if (m && m.wasmMemory) return m.wasmMemory.buffer.byteLength;
      return null;
    };
    const heapBefore = heap();

    // then: ONE execution, many dynamically named files, more than the pool holds
    let manyFiles = null;
    try {
      const code = `
import json, os, hashlib

made, digests = [], {}
for i in range(${fileCount}):
    name = f"dyn_{i:04d}.bin"
    payload = (f"payload-{i}-" * 8).encode()
    with open(name, "wb") as fh:
        fh.write(payload)
    with open(name, "rb") as fh:
        digests[name] = hashlib.sha256(fh.read()).hexdigest()[:16]
    made.append(name)

listing = sorted(os.listdir("."))
os.rename(made[0], "renamed.bin")
os.remove(made[1])
after = sorted(os.listdir("."))

json.dumps({
    "made": len(made),
    "listed": len(listing),
    "renamed_present": "renamed.bin" in after,
    "removed_absent": made[1] not in after,
    "sample_digest": digests[made[2]],
    "sample_expected": hashlib.sha256((f"payload-2-" * 8).encode()).hexdigest()[:16],
})
`;
      // `runPythonAsync`, NOT `runPython`. Pyodide sets `validSuspender` only for stacks entered
      // through its promising wrapper, so a synchronous entry can never suspend whatever the
      // filesystem does - measuring `validSuspender: false` that way says nothing about JSPI.
      manyFiles = JSON.parse(await pyodide.runPythonAsync(code));
    } catch (err) {
      manyFiles = { error: String(err).split("\n").slice(-3).join(" | ").slice(0, 400) };
    }

    const heapAfter = heap();

    report({
      ok: true,
      mode,
      slots,
      capability,
      manyFiles,
      acquisitions: pool.acquisitions,
      shortWrites: diag.shortWrites,
      suspendAttempts: diag.attempts.slice(0, 2),
      heapBefore,
      heapAfter,
    });
  } catch (err) {
    report({
      ok: false,
      mode,
      error: String(err && err.stack ? err.stack : err).slice(0, 900),
      suspendAttempts: diag.attempts.slice(0, 2),
    });
  } finally {
    try {
      pool && pool.closeAll();
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("jspi-probe", { recursive: true }).catch(() => {});
    } catch {}
  }
};

let ws = null;
