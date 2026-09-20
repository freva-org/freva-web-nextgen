/* eslint-disable */
// The PRODUCTION workspace, driven directly, with faults injected. Imports
// `dist/worker/opfs-workspace.js` - the shipped module, not a copy - and wraps every OPFS sync
// access handle before it is acquired, so failures a browser will not produce on demand can be:
// a short write, a `QuotaExceededError`, a flush that fails after every write succeeded. Those
// paths decide whether a truncated file is offered as a finished artifact. The seam is
// `FileSystemFileHandle.prototype.createSyncAccessHandle`, patched here and nowhere in the
// package: the production code has no test hooks in it.

let pyodide = null;
let FS = null;
let mod = null;

/** The currently armed fault, or null. Consulted by the wrapper on every call. */
let fault = null;

/** How many truncates have been allowed through while a counted fault is armed. */
let truncates = 0;

function domError(name) {
  return new DOMException(`injected ${name}`, name);
}

/**
 * Records every handle handed out and every one closed, so a leak is countable. A sync access
 * handle holds an exclusive lock while it is open, so one dropped without being closed keeps a
 * file locked for the life of the Worker and stops the next session reclaiming its directory.
 */
let handleLedger = null;

function trackHandles(opened, closed) {
  handleLedger = opened && closed ? { opened, closed } : null;
}

/** Wrap one handle so the armed fault applies to it. */
function wrapHandle(handle) {
  let writes = 0;
  let reads = 0;
  const id = Symbol("handle");
  handleLedger?.opened.push(id);
  return {
    read: (view, options) => {
      reads += 1;
      if (fault?.kind === "short-read" && reads > (fault.after ?? 0)) {
        // Exactly what a sync access handle is allowed to do: return fewer bytes than asked for.
        const half = Math.max(1, Math.floor(view.byteLength / 2));
        return handle.read(view.subarray(0, half), options);
      }
      if (fault?.kind === "no-read" && reads > (fault.after ?? 0)) return 0;
      return handle.read(view, options);
    },
    getSize: () => {
      // A SLOT THAT WAS NEVER CLEARED. `stale-slot` models the one state the pool cannot recover
      // from: `truncate()` returns, the bytes are still there, and the handle says so. Faking the
      // size makes it reachable at STARTUP, where every slot file is genuinely new and empty, and
      // where a real session would meet it as a slot carrying a previous session's artifact.
      if (fault?.kind === "stale-slot") return fault.size ?? 1;
      return handle.getSize();
    },
    close: () => {
      if (handleLedger && !handleLedger.closed.includes(id)) handleLedger.closed.push(id);
      return handle.close();
    },
    truncate: (size) => {
      if (fault?.kind === "throw-truncate") {
        // `after` lets a test arm the fault for a LATER slot, which is what makes a partial pool
        // startup - some handles acquired, then a failure - reachable.
        if (fault.after === undefined) throw domError(fault.name);
        if (truncates >= fault.after) throw domError(fault.name);
        truncates += 1;
      }
      // TRUNCATE THAT RETURNS WITHOUT DOING ANYTHING. Not invented for the test: this project's
      // own feasibility probe recorded a real browser returning normally from
      // `truncate(4 GiB + 4)` and leaving the size unchanged. Treating "did not throw" as
      // "succeeded" hands a slot to a new file still holding the previous one's bytes, with
      // `knownSize` reporting the size that was asked for.
      if (fault?.kind === "stale-slot") {
        truncates += 1;
        return undefined;
      }
      if (fault?.kind === "silent-truncate" && truncates >= (fault.after ?? 0)) {
        truncates += 1;
        return undefined;
      }
      if (fault?.kind === "partial-truncate" && truncates >= (fault.after ?? 0)) {
        truncates += 1;
        // Reaches a size, just not the one it was given.
        return handle.truncate(Math.max(0, Math.floor(size / 2)));
      }
      truncates += 1;
      return handle.truncate(size);
    },
    flush: () => {
      if (fault?.kind === "throw-flush") throw domError(fault.name);
      return handle.flush();
    },
    write: (view, options) => {
      writes += 1;
      if (fault?.kind === "throw-write" && writes > (fault.after ?? 0)) throw domError(fault.name);
      if (fault?.kind === "short-write" && writes > (fault.after ?? 0)) {
        // Exactly what an exhausted quota looks like: bytes ARE written, just not all of them.
        const short = Math.max(0, view.byteLength - 1);
        handle.write(view.subarray(0, short), options);
        return short;
      }
      return handle.write(view, options);
    },
  };
}

function installHandleWrapper() {
  const real = FileSystemFileHandle.prototype.createSyncAccessHandle;
  FileSystemFileHandle.prototype.createSyncAccessHandle = async function (...args) {
    return wrapHandle(await real.apply(this, args));
  };
}

/** Run Python and return `{ok}` or `{errno, type, message}` - never a raw traceback. */
function attempt(source) {
  const json = pyodide.runPython(`
import json, traceback
def _attempt():
    try:
${source
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
    except OSError as exc:
        return json.dumps({"ok": False, "errno": exc.errno, "type": type(exc).__name__,
                           "message": str(exc), "strerror": exc.strerror or ""})
    except Exception as exc:
        return json.dumps({"ok": False, "errno": None, "type": type(exc).__name__,
                           "message": str(exc)})
    return json.dumps({"ok": True})
_attempt()
`);
  return JSON.parse(json);
}

async function withWorkspace(maxFiles, body) {
  const opened = await mod.Workspace.open(pyodide, { maxFiles });
  if (!("workspace" in opened)) throw new Error(`workspace unavailable: ${opened.status.detail}`);
  const ws = opened.workspace;
  ws.mount();
  try {
    return await body(ws);
  } finally {
    fault = null;
    try {
      pyodide.runPython("import os\nos.chdir('/')\n");
      FS.unmount("/workspace");
    } catch {}
    await ws.close();
  }
}

const CASES = {
  // the errno table, exactly
  async errnoTable() {
    const E = mod.errnoCodes(pyodide);
    return { ENOSPC: E.ENOSPC, EMFILE: E.EMFILE, EINVAL: E.EINVAL, ENOENT: E.ENOENT };
  },

  // pool exhaustion is EMFILE, and explained
  async poolExhaustion() {
    return withWorkspace(2, async (ws) => {
      const first = attempt('open("a.bin", "wb").close()\nopen("b.bin", "wb").close()');
      const third = attempt('open("c.bin", "wb").close()');
      // Deleting one must return its slot: the bound is on RETAINED files, not on files created.
      const afterDelete = attempt('import os\nos.remove("a.bin")\nopen("c.bin", "wb").close()');
      const explained = ws.annotate(`OSError: [Errno ${mod.errnoCodes(pyodide).EMFILE}] x\n`);
      return {
        first,
        third,
        afterDelete,
        free: ws.freeSlots(),
        explains: explained.includes("at most 2 files at once"),
        mentionsZarr: explained.toLowerCase().includes("zarr"),
        annotation: explained.split("\n")[1] ?? "",
      };
    });
  },

  // the bound is retained files, not files ever created
  async retainedNotCreated() {
    return withWorkspace(1, async (ws) => {
      const many = attempt(`import os
for i in range(300):
    with open(f"tmp_{i}.bin", "wb") as fh:
        fh.write(b"x" * 16)
    os.remove(f"tmp_{i}.bin")`);
      return { many, free: ws.freeSlots(), listed: ws.list().length };
    });
  },

  // a short write is ENOSPC and a QUARANTINED artifact
  async shortWrite() {
    return withWorkspace(4, async (ws) => {
      const ok = attempt('with open("good.bin", "wb") as fh:\n    fh.write(b"complete")');
      fault = { kind: "short-write", after: 0 };
      const bad = attempt('with open("partial.bin", "wb") as fh:\n    fh.write(b"0123456789")');
      fault = null;
      const listed = ws.list();
      const failed = listed.find((a) => a.name === "partial.bin") ?? null;
      let refusal = null;
      try {
        await ws.read("partial.bin");
      } catch (error) {
        refusal = String(error.message);
      }
      // The good one is still downloadable, and the failed one still releases its slot on delete.
      const goodRead = await ws.read("good.bin");
      ws.delete("partial.bin");
      return {
        ok,
        bad,
        failed,
        refusal,
        goodBytes: goodRead.blob.size,
        stillListed: ws.list().map((a) => a.name),
        freeAfterDelete: ws.freeSlots(),
      };
    });
  },

  // DOMExceptions become the right errno, not a crash
  async domExceptions() {
    return withWorkspace(6, async (ws) => {
      const out = {};
      for (const [key, name] of [
        ["quota", "QuotaExceededError"],
        ["denied", "NotAllowedError"],
        ["locked", "NoModificationAllowedError"],
        ["unknown", "UnknownError"],
      ]) {
        fault = { kind: "throw-write", name };
        out[key] = attempt(`with open("${key}.bin", "wb") as fh:\n    fh.write(b"x" * 8)`);
        fault = null;
      }
      // A flush that fails after every write returned its full length is still a failed artifact:
      // bytes Python believes are durable are not.
      fault = { kind: "throw-flush", name: "QuotaExceededError" };
      out.flush = attempt('with open("flush.bin", "wb") as fh:\n    fh.write(b"y" * 8)');
      fault = null;
      fault = { kind: "throw-truncate", name: "QuotaExceededError" };
      out.truncate = attempt(`with open("trunc.bin", "wb") as fh:
    fh.write(b"z" * 32)
    fh.flush()
    fh.truncate(8)`);
      fault = null;
      out.states = ws.list().map((a) => ({ name: a.name, state: a.state }));
      return out;
    });
  },

  // os.replace onto an existing file must not leak the destination
  async replaceReleasesSlot() {
    return withWorkspace(2, async (ws) => {
      const setup = attempt(`with open("src.bin", "wb") as fh:
    fh.write(b"NEW")
with open("dst.bin", "wb") as fh:
    fh.write(b"OLD")`);
      const full = ws.freeSlots();
      const replaced = attempt('import os\nos.replace("src.bin", "dst.bin")');
      const freeAfter = ws.freeSlots();
      // The proof: with a two-slot pool that was full, a third file can be created because the
      // replaced destination gave its slot back. Without that, this raises EMFILE.
      const reuse = attempt('with open("third.bin", "wb") as fh:\n    fh.write(b"3")');
      const content = attempt(`with open("dst.bin", "rb") as fh:
    assert fh.read() == b"NEW", fh.read()`);
      return {
        setup,
        replaced,
        reuse,
        content,
        freeWhenFull: full,
        freeAfterReplace: freeAfter,
        listing: ws.list().map((a) => a.name),
      };
    });
  },

  // rename's directory/file mismatches
  async renameMismatches() {
    return withWorkspace(6, async () => {
      const setup = attempt(`import os
os.makedirs("adir", exist_ok=True)
os.makedirs("bdir", exist_ok=True)
with open("bdir/inner.txt", "w") as fh:
    fh.write("x")
with open("afile.txt", "w") as fh:
    fh.write("y")`);
      return {
        setup,
        fileOntoDir: attempt('import os\nos.replace("afile.txt", "adir")'),
        dirOntoFile: attempt('import os\nos.replace("adir", "afile.txt")'),
        dirOntoNonEmptyDir: attempt('import os\nos.replace("adir", "bdir")'),
      };
    });
  },

  // unlink while open: POSIX orphan, slot returned at close
  async unlinkWhileOpen() {
    return withWorkspace(1, async (ws) => {
      const orphan = attempt(`import os
fh = open("doomed.bin", "wb")
fh.write(b"before")
os.remove("doomed.bin")
fh.write(b"after")
assert not os.path.exists("doomed.bin")
fh.close()`);
      const afterClose = ws.freeSlots();
      // The single slot must be usable again immediately.
      const reuse = attempt('with open("next.bin", "wb") as fh:\n    fh.write(b"ok")');
      return { orphan, afterClose, reuse, listing: ws.list().map((a) => a.name) };
    });
  },

  // an open file is never a ready artifact
  async stagingWhileOpen() {
    return withWorkspace(4, async (ws) => {
      attempt('globals()["_h"] = open("staging.bin", "wb")\n_h.write(b"half")');
      const whileOpen = ws.list().find((a) => a.name === "staging.bin") ?? null;
      let refusal = null;
      try {
        await ws.read("staging.bin");
      } catch (error) {
        refusal = String(error.message);
      }
      let deleteRefusal = null;
      try {
        ws.delete("staging.bin");
      } catch (error) {
        deleteRefusal = String(error.message);
      }
      attempt("_h.close()");
      const afterClose = ws.list().find((a) => a.name === "staging.bin") ?? null;
      const read = await ws.read("staging.bin");
      return { whileOpen, refusal, deleteRefusal, afterClose, bytes: read.blob.size };
    });
  },

  // a slot whose cleanup fails is retired, not reused
  async brokenSlotRetires() {
    // Four slots: one for the file written before the fault, two consumed by the two failures, and
    // one healthy slot left to prove the workspace survives losing capacity.
    return withWorkspace(4, async (ws) => {
      const before = ws.status();
      const setup = attempt(`with open("one.bin", "wb") as fh:
    fh.write(b"1")`);

      // The truncate that `take()` does when a slot is handed to a new file.
      fault = { kind: "throw-truncate", name: "QuotaExceededError" };
      const first = attempt(`with open("two.bin", "wb") as fh:
    fh.write(b"2")`);
      const second = attempt(`with open("three.bin", "wb") as fh:
    fh.write(b"3")`);
      fault = null;
      // A third attempt with the fault cleared must now use a DIFFERENT slot and succeed.
      const afterFault = attempt(`with open("four.bin", "wb") as fh:
    fh.write(b"4")`);

      const after = ws.status();
      return {
        setup,
        first,
        second,
        afterFault,
        maxBefore: before.maxFiles,
        maxAfter: after.maxFiles,
        degraded: after.degraded ?? null,
        listing: ws.list().map((a) => a.name),
      };
    });
  },

  /** Every handle acquired during a partial pool startup must be closed again. */
  async partialPoolStartup() {
    // Not `withWorkspace`: the point is a startup that FAILS, which never yields a workspace.
    const opened = [];
    const closed = [];
    trackHandles(opened, closed);
    fault = { kind: "throw-truncate", name: "InvalidStateError", after: 2 };
    let status = null;
    try {
      const attempt = await mod.Workspace.open(pyodide, { maxFiles: 6 });
      status = "workspace" in attempt ? "opened" : attempt.status.reason;
      if ("workspace" in attempt) await attempt.workspace.close();
    } catch (error) {
      status = `threw: ${String(error.message).slice(0, 80)}`;
    }
    fault = null;
    trackHandles(null, null);
    return { status, opened: opened.length, closed: closed.length };
  },

  // a creation that fails must leave NOTHING behind
  async exhaustionLeavesNoNode() {
    return withWorkspace(1, async (ws) => {
      // `FS.createNode` registers the node in Emscripten's name table before this filesystem gets
      // a chance to fail, so a `pool.take()` that raises EMFILE afterwards leaves a node with no
      // slot behind it: `exists()` says true, `listdir()` disagrees, and touching it later crashes
      // the interpreter with "NaN cannot be converted to a BigInt" from deep inside a syscall.
      const script = `
from pathlib import Path
import json

Path("a").write_bytes(b"a")

errno = None
try:
    Path("b").write_bytes(b"b")
except OSError as exc:
    errno = exc.errno

phantom_exists = Path("b").exists()
still_alive = 1 + 1 == 2
listing_after = sorted(p.name for p in Path(".").iterdir())

Path("a").unlink()
Path("b").write_bytes(b"b")
recovered = Path("b").read_bytes() == b"b"

json.dumps({
    "errno": errno,
    "phantom_exists": phantom_exists,
    "still_alive": still_alive,
    "listing_after": listing_after,
    "recovered": recovered,
    "listing_end": sorted(p.name for p in Path(".").iterdir()),
})
`;
      let out;
      try {
        out = JSON.parse(pyodide.runPython(script));
      } catch (error) {
        out = { crashed: String(error?.message ?? error).slice(0, 200) };
      }
      return { ...out, free: ws.freeSlots(), listed: ws.list().map((a) => a.name) };
    });
  },

  // duplicated descriptors keep a file open
  async duplicatedDescriptors() {
    return withWorkspace(4, async (ws) => {
      const setup = attempt(`import os
globals()["_fh"] = open("result.bin", "wb")
_fh.write(b"HEAD")
globals()["_dup"] = os.dup(_fh.fileno())
_fh.close()`);
      const afterOriginalClose = ws.list().find((a) => a.name === "result.bin") ?? null;

      // A lease must not begin: the duplicate can still write, and a download that started here
      // would be reading a file that is still being written.
      let leaseRefusal = null;
      try {
        ws.openLease("result.bin");
        leaseRefusal = "allowed";
      } catch (error) {
        leaseRefusal = String(error.message);
      }

      const throughDuplicate = attempt(`import os
os.write(_dup, b"TAIL")
os.close(_dup)`);
      const afterDuplicateClose = ws.list().find((a) => a.name === "result.bin") ?? null;
      const contents = attempt(`with open("result.bin", "rb") as fh:
    data = fh.read()
assert data == b"HEADTAIL", data`);

      // dup2 onto a chosen descriptor number.
      const dup2 = attempt(`import os
fh = open("two.bin", "wb")
fh.write(b"X")
spare = os.open("/dev/null", os.O_WRONLY)
os.dup2(fh.fileno(), spare)
fh.close()
os.write(spare, b"Y")
os.close(spare)
with open("two.bin", "rb") as check:
    assert check.read() == b"XY", check.read()`);

      // Unlinking while a duplicate is open: POSIX keeps the bytes until the last close.
      const unlinkWhileDuplicated = attempt(`import os
fh = open("doomed.bin", "wb")
dup = os.dup(fh.fileno())
fh.close()
os.remove("doomed.bin")
os.write(dup, b"still writable")
os.close(dup)
assert not os.path.exists("doomed.bin")`);

      return {
        setup,
        afterOriginalClose,
        leaseRefusal,
        throughDuplicate,
        afterDuplicateClose,
        contents,
        dup2,
        unlinkWhileDuplicated,
        free: ws.freeSlots(),
        listing: ws.list().map((a) => a.name),
      };
    });
  },

  // replace, unlink, recreate leaves no stale node
  async replaceUnlinkRecreate() {
    return withWorkspace(4, async (ws) => {
      // `FS.rename` removes the SOURCE from the name table and puts it back; it never touches the
      // destination, because MEMFS's own `rename` does that itself. A filesystem that does not
      // leaves the replaced node in the lookup table: `listdir()` comes back empty while
      // `exists("b")` stays true, and recreating the name fails with EBADF.
      const script = `
import os, json

with open("a", "wb") as fh:
    fh.write(b"A")
with open("b", "wb") as fh:
    fh.write(b"B")

os.replace("a", "b")
after_replace = sorted(os.listdir("."))
content_after_replace = open("b", "rb").read().decode()

os.unlink("b")
listing = sorted(os.listdir("."))
phantom = os.path.exists("b")

recreated = None
try:
    with open("b", "wb") as fh:
        fh.write(b"C")
    recreated = open("b", "rb").read().decode()
except OSError as exc:
    recreated = "OSError %d" % exc.errno

json.dumps({
    "after_replace": after_replace,
    "content_after_replace": content_after_replace,
    "listing": listing,
    "phantom": phantom,
    "recreated": recreated,
})
`;
      let out;
      try {
        out = JSON.parse(pyodide.runPython(script));
      } catch (error) {
        out = { crashed: String(error?.message ?? error).slice(0, 200) };
      }
      return { ...out, free: ws.freeSlots(), listed: ws.list().map((a) => a.name) };
    });
  },

  // a truncate that returns without doing anything
  async silentTruncateOnCreate() {
    // A slot is cleaned on the way OUT of the pool, so a truncate that silently does nothing hands
    // the next file the previous one's bytes. Checking only that the call did not throw is not
    // enough - a real browser has been observed returning normally from a truncate it did not
    // perform. What must never happen is the new file reading as though those bytes were its own.
    return withWorkspace(4, async (ws) => {
      pyodide.runPython(`
with open("first.bin", "wb") as fh:
    fh.write(b"AAAAAAAAAAAAAAAAAAAA")
`);
      const before = ws.freeSlots();
      // Armed BEFORE the unlink, which is when the slot is cleaned on its way back to the pool.
      // From here the truncate returns without doing anything and the slot still holds 20 "A"s.
      fault = { kind: "silent-truncate", after: 0 };
      pyodide.runPython(`
import os
os.unlink("first.bin")
`);
      const withdrawn = before - ws.freeSlots() === 0 && ws.freeSlots() < 4;
      const second = attempt(`
with open("second.bin", "wb") as fh:
    fh.write(b"B")
`);
      const listed = ws.list().find((a) => a.name === "second.bin") ?? null;
      let read = null;
      try {
        read = [...(pyodide.runPython(`open("second.bin","rb").read()`).toJs?.() ?? [])];
      } catch (error) {
        read = `raised: ${String(error?.message ?? error).slice(0, 80)}`;
      }
      fault = null;
      return {
        second,
        listed,
        read,
        free: ws.freeSlots(),
        withdrawn,
        degraded: ws.status().degraded ?? null,
      };
    });
  },

  async silentTruncateOnSetattr() {
    // `os.truncate` / `fh.truncate()` go through `setattr`, which recorded the requested size as
    // the file's size without ever checking that the file had reached it.
    return withWorkspace(4, async (ws) => {
      pyodide.runPython(`
with open("grow.bin", "wb") as fh:
    fh.write(b"0123456789")
`);
      fault = { kind: "silent-truncate", after: 0 };
      const truncated = attempt(`
with open("grow.bin", "r+b") as fh:
    fh.truncate(4)
`);
      fault = null;
      const info = ws.list().find((a) => a.name === "grow.bin") ?? null;
      const actual = pyodide.runPython(`len(open("grow.bin","rb").read())`);
      return { truncated, reported: info?.size ?? null, actual, state: info?.state ?? null };
    });
  },

  async partialTruncateOnSetattr() {
    return withWorkspace(4, async (ws) => {
      pyodide.runPython(`
with open("half.bin", "wb") as fh:
    fh.write(b"0123456789")
`);
      fault = { kind: "partial-truncate", after: 0 };
      const truncated = attempt(`
with open("half.bin", "r+b") as fh:
    fh.truncate(8)
`);
      fault = null;
      const info = ws.list().find((a) => a.name === "half.bin") ?? null;
      return { truncated, reported: info?.size ?? null, state: info?.state ?? null };
    });
  },

  async silentTruncateAtStartup() {
    // The pool's own `open()`: every slot is cleared before it is handed out. A slot that reports
    // a size after being cleared is not one this workspace can use, and starting up with one is
    // how the first file created would inherit a previous session's bytes.
    let outcome = "started";
    try {
      fault = { kind: "stale-slot", size: 20 };
      await withWorkspace(2, async (ws) => {
        outcome = `started with ${ws.status().maxFiles} files`;
      });
    } catch (error) {
      outcome = `refused: ${String(error?.message ?? error).slice(0, 120)}`;
    } finally {
      fault = null;
    }
    return { outcome };
  },

  // replacing an empty DIRECTORY over another
  async replaceEmptyDirectory() {
    return withWorkspace(4, async (ws) => {
      // The same name-table defect as `replaceUnlinkRecreate`, on the branch nobody took. A file
      // destination is removed from Emscripten's lookup table before being replaced; a DIRECTORY
      // destination is not if that branch only checks emptiness, so `os.replace("a", "b")` between
      // two empty directories leaves `b`'s old node resolvable - `rmdir("b")` then leaves a
      // phantom that `exists()` still sees and `mkdir()` cannot recreate.
      const script = `
import os, json

os.mkdir("a")
os.mkdir("b")
os.replace("a", "b")
after_replace = sorted(os.listdir("."))

os.rmdir("b")
listing = sorted(os.listdir("."))
phantom = os.path.exists("b")

recreated = None
try:
    os.mkdir("b")
    recreated = os.path.isdir("b")
except OSError as exc:
    recreated = "OSError %d" % exc.errno

json.dumps({
    "after_replace": after_replace,
    "listing": listing,
    "phantom": phantom,
    "recreated": recreated,
})
`;
      let out;
      try {
        out = JSON.parse(pyodide.runPython(script));
      } catch (error) {
        out = { crashed: String(error?.message ?? error).slice(0, 200) };
      }
      return { ...out, listed: ws.list().map((a) => a.name) };
    });
  },

  // the errors a replacement must still raise
  async replaceTypeErrors() {
    return withWorkspace(4, async (ws) => {
      const script = `
import os, json

os.mkdir("dir")
with open("file", "wb") as fh:
    fh.write(b"x")
os.mkdir("full")
with open("full/inside", "wb") as fh:
    fh.write(b"y")
os.mkdir("spare")

def attempt(fn):
    try:
        fn()
        return "no raise"
    except OSError as exc:
        return exc.errno
    except Exception as exc:
        return type(exc).__name__

json.dumps({
    "dir_over_file": attempt(lambda: os.replace("dir", "file")),
    "file_over_dir": attempt(lambda: os.replace("file", "dir")),
    "over_nonempty": attempt(lambda: os.replace("spare", "full")),
    "still_there": sorted(os.listdir(".")),
})
`;
      let out;
      try {
        out = JSON.parse(pyodide.runPython(script));
      } catch (error) {
        out = { crashed: String(error?.message ?? error).slice(0, 200) };
      }
      return { ...out, free: ws.freeSlots() };
    });
  },

  // names that collide with Object.prototype
  async prototypeNames() {
    return withWorkspace(8, async (ws) => {
      // A directory's contents in an ordinary object make every name on `Object.prototype`
      // already "present" in every directory: `open("constructor")` looks up a FUNCTION and treats
      // it as a node, and `__proto__` cannot be stored at all because assigning to it sets the
      // prototype. These are legitimate POSIX filenames, and a dataset with a variable called
      // `constructor` is not a stunt.
      const script = `
import os, json

names = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]
created = {}
read_back = {}
for name in names:
    with open(name, "wb") as fh:
        fh.write(name.encode())
    created[name] = os.path.exists(name)
    read_back[name] = open(name, "rb").read().decode()

listing = sorted(os.listdir("."))

# Checked in PYTHON: a JavaScript object cannot hold "__proto__" as an ordinary key, so a check
# written on the other side of json would be testing the bridge rather than the filesystem.
all_read_back = all(read_back[n] == n for n in names)
all_created = all(created.values())

# A name that was never created must still be absent, whatever Object.prototype says.
absent = os.path.exists("isPrototypeOf")

os.replace("constructor", "toString")
after_replace = open("toString", "rb").read().decode()
os.unlink("toString")
gone = os.path.exists("toString")

json.dumps({
    "all_created": all_created,
    "all_read_back": all_read_back,
    "listing": listing,
    "absent": absent,
    "after_replace": after_replace,
    "gone": gone,
})
`;
      let out;
      try {
        out = JSON.parse(pyodide.runPython(script));
      } catch (error) {
        out = { crashed: String(error?.message ?? error).slice(0, 300) };
      }
      return {
        ...out,
        listed: ws
          .list()
          .map((a) => a.name)
          .sort(),
      };
    });
  },

  // replacing a destination that is still open
  async replaceOverOpenDestination() {
    return withWorkspace(4, async (ws) => {
      const script = `
import os, json

with open("src", "wb") as fh:
    fh.write(b"NEW")
with open("dst", "wb") as fh:
    fh.write(b"OLD")

reader = open("dst", "rb")
os.replace("src", "dst")

# POSIX: the open descriptor still sees the file it was opened on.
old_bytes = reader.read().decode()
reader.close()

new_bytes = open("dst", "rb").read().decode()
json.dumps({"old_bytes": old_bytes, "new_bytes": new_bytes, "listing": sorted(os.listdir("."))})
`;
      let out;
      try {
        out = JSON.parse(pyodide.runPython(script));
      } catch (error) {
        out = { crashed: String(error?.message ?? error).slice(0, 200) };
      }
      return { ...out, free: ws.freeSlots() };
    });
  },

  // a read that comes up short, on both paths
  async shortReads() {
    return withWorkspace(4, async (ws) => {
      const setup = attempt(`with open("payload.bin", "wb") as fh:
    fh.write(bytes(range(256)) * 40)`);

      // Python's own read path. A short read returned straight to Emscripten is taken as
      // end-of-file for a regular file, so the file silently truncates and every later size check
      // calls the result complete.
      fault = { kind: "short-read", after: 0 };
      const pythonRead = attempt(`with open("payload.bin", "rb") as fh:
    data = fh.read()
assert len(data) == 10240, len(data)
assert data == bytes(range(256)) * 40, "contents differ"`);
      fault = null;

      // The transfer path. Same rule, different loop.
      fault = { kind: "short-read", after: 0 };
      let streamed = null;
      try {
        const lease = ws.openLease("payload.bin");
        const chunk = ws.readChunk(lease.lease, 0, 10240);
        streamed = { length: chunk.byteLength, first: chunk[0], last: chunk[chunk.byteLength - 1] };
        ws.closeLease(lease.lease);
      } catch (error) {
        streamed = { error: String(error.message) };
      }
      fault = null;

      // A read that returns NOTHING before the end of the file is a storage failure, and padding
      // the rest with zeros would produce a plausible-looking corrupt download.
      fault = { kind: "no-read", after: 0 };
      let refused = null;
      try {
        const lease = ws.openLease("payload.bin");
        ws.readChunk(lease.lease, 0, 1024);
        refused = "allowed";
      } catch (error) {
        refused = String(error.message);
      }
      fault = null;

      return { setup, pythonRead, streamed, refused };
    });
  },

  // two descriptors on one file
  async multipleDescriptors() {
    return withWorkspace(4, async (ws) => {
      const both = attempt(`a = open("shared.bin", "wb")
a.write(b"HEADER--")
a.flush()
b = open("shared.bin", "rb")
head = b.read(6)
assert head == b"HEADER", head
a.write(b"TAIL")
a.close()
b.close()`);
      const info = ws.list().find((x) => x.name === "shared.bin") ?? null;
      return { both, info };
    });
  },
};

self.onmessage = async (event) => {
  const { indexURL, distURL } = event.data;
  const results = {};
  try {
    installHandleWrapper();
    mod = await import(distURL);
    const { loadPyodide } = await import(`${indexURL}pyodide.mjs`);
    pyodide = await loadPyodide({ indexURL });
    FS = pyodide.FS;

    for (const [name, run] of Object.entries(CASES)) {
      try {
        results[name] = await run();
      } catch (error) {
        results[name] = { error: String(error?.stack ?? error).slice(0, 600) };
      }
    }
    self.postMessage({ ok: true, results });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error?.stack ?? error).slice(0, 900), results });
  }
};
