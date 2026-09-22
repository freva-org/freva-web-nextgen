/* eslint-disable */
/**
 * PROBE ONLY. A pooled-OPFS Emscripten filesystem, built to answer a feasibility question and
 * nothing else. Not the shipped design, not wired into the package's worker, not registered.
 *
 * Emscripten's `open()` is synchronous and OPFS handle acquisition is async, so acquire the handles
 * BEFORE they are needed: a pool opened at startup on files named `slot-0`, `slot-1`, …, one handed
 * to a Python file synchronously. The FILENAME lives in this JS node tree and the BYTES in a slot,
 * so dynamic filenames cost nothing. The pool bounds RETAINED logical files, not names - deleting a
 * file returns its slot.
 */

let pyodide = null;
let FS = null;
let pool = null;

/**
 * The runtime's own errno table. NEVER hard-coded numbers: Emscripten's codes are its own, not
 * Linux's, so ENOSPC is 51 here, EMFILE is 33 and EINVAL is 28. Getting one wrong makes every
 * exhaustion test assert the wrong thing while appearing to pass.
 */
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

/** A pre-acquired OPFS sync access handle, and whether a file currently owns it. */
class SlotPool {
  constructor() {
    this.slots = [];
    this.dir = null;
  }

  async open(count) {
    const root = await navigator.storage.getDirectory();
    this.dir = await root.getDirectoryHandle("probe-workspace", { create: true });
    for (let i = 0; i < count; i += 1) {
      const fh = await this.dir.getFileHandle(`slot-${i}`, { create: true });
      const handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      this.slots.push({ index: i, fileHandle: fh, handle, taken: false });
    }
  }

  /** Synchronous, which is the entire point. */
  take(FS) {
    const slot = this.slots.find((s) => !s.taken);
    if (!slot) {
      // The exhaustion case, surfaced rather than hidden - and as an `FS.ErrnoError`, not a bare
      // `Error`, because only the former becomes a Python `OSError`. EMFILE, not ENOSPC: the disk
      // is not full, this backend has run out of descriptors.
      throw new FS.ErrnoError(E.EMFILE);
    }
    slot.taken = true;
    slot.handle.truncate(0);
    return slot;
  }

  release(slot) {
    if (!slot) return;
    slot.handle.truncate(0);
    slot.taken = false;
  }

  free() {
    return this.slots.filter((s) => !s.taken).length;
  }

  /** Close one slot's handle so `getFile()` can read it - the lock is exclusive. */
  async readable(slot) {
    slot.handle.flush();
    slot.handle.close();
    const file = await slot.fileHandle.getFile();
    return file;
  }

  /** Re-acquire after a download, so Python can keep using the file. */
  async reacquire(slot) {
    slot.handle = await slot.fileHandle.createSyncAccessHandle();
  }

  closeAll() {
    for (const s of this.slots) {
      try {
        s.handle.close();
      } catch {}
    }
  }
}

/** A filesystem whose file contents live in pooled OPFS handles. Modelled on MEMFS. */
function makePoolFS(FS, pool) {
  const POOLFS = {
    ops_table: null,
    mount() {
      return POOLFS.createNode(null, "/", 16384 | 511, 0);
    },
    createNode(parent, name, mode, dev) {
      const node = FS.createNode(parent, name, mode, dev);
      if (FS.isDir(node.mode)) {
        node.node_ops = POOLFS.dir_node_ops;
        // Directories need stream ops too, and exactly one: `llseek`. Python's import machinery
        // lists the working directory and `_fill_cache` seeks the directory stream - with no llseek
        // that is `OSError: [Errno 70] Invalid seek: '/workspace'` before any user code runs.
        node.stream_ops = POOLFS.dir_stream_ops;
        node.contents = {};
      } else {
        node.node_ops = POOLFS.file_node_ops;
        node.stream_ops = POOLFS.stream_ops;
        node.slot = pool.take(FS); // synchronous; raises EMFILE when the pool is empty
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

  POOLFS.dir_node_ops = {
    getattr: POOLFS.getattr,
    setattr: POOLFS.setattr,
    lookup(parent, name) {
      const found = parent.contents[name];
      // `new FS.ErrnoError(44)`, not `FS.genericErrors[44]`: this build has no `genericErrors`
      // table, so reaching for it throws a TypeError from inside a syscall - an unreadable stack
      // rather than ENOENT, and every `os.path.exists()` becomes a crash.
      if (!found) throw new FS.ErrnoError(E.ENOENT);
      return found;
    },
    mknod(parent, name, mode, dev) {
      return POOLFS.createNode(parent, name, mode, dev);
    },
    rename(oldNode, newDir, newName) {
      // The rename libraries do at the end of a write, and what `os.replace()` is. Only the NAME
      // moves; the slot, and every byte in it, stays exactly where it is. No copy.
      const existing = newDir.contents[newName];
      if (existing && existing !== oldNode) {
        // Otherwise the destination node is simply overwritten in the contents map, its slot is
        // never released, and the pool leaks one descriptor per `os.replace()`.
        if (FS.isDir(existing.mode)) {
          if (!FS.isDir(oldNode.mode)) throw new FS.ErrnoError(E.EISDIR);
          if (Object.keys(existing.contents).length) throw new FS.ErrnoError(E.ENOTEMPTY);
        } else if (FS.isDir(oldNode.mode)) {
          throw new FS.ErrnoError(E.ENOTDIR);
        } else {
          pool.release(existing.slot);
          existing.slot = null;
        }
      }
      delete oldNode.parent.contents[oldNode.name];
      oldNode.parent.timestamp = Date.now();
      oldNode.name = newName;
      newDir.contents[newName] = oldNode;
      newDir.timestamp = oldNode.parent.timestamp;
      oldNode.parent = newDir;
    },
    unlink(parent, name) {
      const node = parent.contents[name];
      pool.release(node && node.slot);
      delete parent.contents[name];
      parent.timestamp = Date.now();
    },
    rmdir(parent, name) {
      const node = parent.contents[name];
      for (const _ in node.contents) throw new FS.ErrnoError(E.ENOTEMPTY);
      delete parent.contents[name];
      parent.timestamp = Date.now();
    },
    readdir(node) {
      return [".", "..", ...Object.keys(node.contents)];
    },
    symlink() {
      throw new FS.ErrnoError(E.EPERM);
    },
  };

  POOLFS.file_node_ops = { getattr: POOLFS.getattr, setattr: POOLFS.setattr };

  POOLFS.dir_stream_ops = {
    llseek(stream, offset, whence) {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2) throw new FS.ErrnoError(E.EINVAL);
      if (position < 0) throw new FS.ErrnoError(E.EINVAL);
      return position;
    },
  };

  POOLFS.stream_ops = {
    read(stream, buffer, offset, length, position) {
      const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      return stream.node.slot.handle.read(view, { at: position });
    },
    write(stream, buffer, offset, length, position) {
      const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      // The return value is CHECKED. A short write means the quota is gone, and OPFS reports that
      // by writing fewer bytes rather than by throwing - see the feasibility gate.
      const written = stream.node.slot.handle.write(view, { at: position });
      if (written < length) {
        // A REAL quota failure, and the one place ENOSPC belongs. The short write has already put
        // `written` bytes on disk, so the file is partial - which is why the shipped implementation
        // treats every write as staging and never reports such a file as ready.
        throw new FS.ErrnoError(E.ENOSPC);
      }
      stream.node.timestamp = Date.now();
      return written;
    },
    llseek(stream, offset, whence) {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2) position += stream.node.slot.handle.getSize();
      if (position < 0) throw new FS.ErrnoError(E.EINVAL);
      return position;
    },
    close() {},
    flush(stream) {
      if (stream.node && stream.node.slot) stream.node.slot.handle.flush();
    },
  };

  return POOLFS;
}

const report = (o) => self.postMessage(o);

self.onmessage = async (event) => {
  const { indexURL, poolSize, mib } = event.data;
  try {
    const { loadPyodide } = await import(`${indexURL}pyodide.mjs`);
    pyodide = await loadPyodide({ indexURL });
    FS = pyodide.FS;
    E = errnoCodes(pyodide);

    pool = new SlotPool();
    const t0 = performance.now();
    await pool.open(poolSize);
    const poolMs = Math.round(performance.now() - t0);

    const POOLFS = makePoolFS(FS, pool);
    FS.mkdirTree("/workspace");
    FS.mount(POOLFS, {}, "/workspace");
    pyodide.runPython("import os\nos.chdir('/workspace')");

    /** Emscripten's heap, which is where MEMFS would have put every byte. */
    const heap = () => {
      const m = pyodide._module ?? pyodide._api?._module ?? null;
      if (m && m.HEAPU8) return m.HEAPU8.length;
      if (m && m.wasmMemory) return m.wasmMemory.buffer.byteLength;
      return null;
    };
    const heapBefore = heap();
    self.__result = {};

    // the real test: ordinary Python, relative path, seek, close, reopen
    const py = `
import json, os, hashlib

MiB = 1024 * 1024
chunk = b"A" * MiB
target = ${mib}

with open("surface_wind.nc", "wb") as fh:
    for _ in range(target):
        fh.write(chunk)
    # a header rewrite, which is what netCDF/HDF5 do on close
    fh.seek(0)
    fh.write(b"CDF\\x01")
    fh.seek(0, os.SEEK_END)
    tail = fh.tell()

assert os.path.exists("surface_wind.nc"), "Path.exists() must see the staged file"
size_after_close = os.path.getsize("surface_wind.nc")

# reopen and read back, including the bytes rewritten by the seek
with open("surface_wind.nc", "rb") as fh:
    head = fh.read(4)
    fh.seek(MiB)
    middle = fh.read(4)

# append
with open("surface_wind.nc", "ab") as fh:
    fh.write(b"TAIL")
size_after_append = os.path.getsize("surface_wind.nc")

# a second, differently named file - dynamic names must cost nothing
with open("results.csv", "w") as fh:
    fh.write("a,b\\n1,2\\n")

# rename, which is the temp-file-then-rename pattern
os.rename("results.csv", "final.csv")
renamed_ok = os.path.exists("final.csv") and not os.path.exists("results.csv")

listing = sorted(os.listdir("."))

json.dumps({
    "size_after_close": size_after_close,
    "size_after_append": size_after_append,
    "head": head.decode("latin1"),
    "middle": middle.decode("latin1"),
    "renamed_ok": renamed_ok,
    "listing": listing,
    "cwd": os.getcwd(),
})
`;
    const pyOut = JSON.parse(pyodide.runPython(py));
    const heapAfter = heap();

    // pool exhaustion, surfaced as an error Python can see
    let exhaustion = null;
    try {
      pyodide.runPython(`
import os
made = 0
try:
    for i in range(10000):
        with open(f"f{i}.bin", "wb") as fh:
            fh.write(b"x")
        made += 1
except OSError as exc:
    pass
`);
      exhaustion = { made: pyodide.runPython("made"), free: pool.free() };
    } catch (err) {
      exhaustion = { error: String(err).split("\n")[0].slice(0, 160), free: pool.free() };
    }

    // download: an OPFS File, no arrayBuffer, no FS.readFile
    const node = FS.lookupPath("/workspace/surface_wind.nc").node;
    const file = await pool.readable(node.slot);
    const download = {
      fileSize: file.size,
      isFile: file instanceof File,
      // A blob URL from the File. Nothing is copied into JS memory to make this.
      urlCreated: (() => {
        const u = URL.createObjectURL(file);
        const ok = typeof u === "string" && u.startsWith("blob:");
        URL.revokeObjectURL(u);
        return ok;
      })(),
    };
    await pool.reacquire(node.slot);

    report({
      ok: true,
      poolMs,
      poolSize,
      heapBefore,
      heapAfter,
      heapGrowthMiB: heapBefore && heapAfter ? Math.round((heapAfter - heapBefore) / MiBc()) : null,
      wroteMiB: mib,
      py: pyOut,
      exhaustion,
      download,
    });
  } catch (err) {
    report({ ok: false, error: String(err && err.stack ? err.stack : err).slice(0, 900) });
  } finally {
    try {
      pool && pool.closeAll();
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("probe-workspace", { recursive: true }).catch(() => {});
    } catch {}
  }
};

function MiBc() {
  return 1024 * 1024;
}
