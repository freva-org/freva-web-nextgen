/**
 * Remove OPFS synchronous access handles from THIS worker, before the workspace probes for them.
 *
 * `createSyncAccessHandle` is what a disk-backed /workspace needs, and browsers that lack it still
 * start the interpreter with files in memory. Deleting it from the prototype reproduces that
 * browser in every engine. A test seam only, reached through the public `workerURL` option.
 */
if (typeof FileSystemFileHandle !== "undefined") {
  try {
    delete FileSystemFileHandle.prototype.createSyncAccessHandle;
  } catch {
    // reported below
  }
  if ("createSyncAccessHandle" in FileSystemFileHandle.prototype) {
    throw new Error("test seam: could not remove createSyncAccessHandle from this worker");
  }
}
