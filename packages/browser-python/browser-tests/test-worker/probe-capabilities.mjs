/**
 * What a dedicated Worker on this page can actually do - served same-origin, so it runs under the
 * strictest page policy the suites use (`worker-src 'self'`), where a blob: worker would not.
 *
 * Not only whether the methods EXIST: whether this browsing context lets a worker USE them. A
 * context can expose `getDirectory` and still refuse it (an ephemeral automation profile, a storage
 * policy), which is a different fact from a missing API - and from a package bug.
 */
const out = {
  jspi: typeof WebAssembly.Suspending === "function",
  opfs: typeof navigator.storage?.getDirectory === "function",
  syncAccessHandles:
    typeof FileSystemFileHandle !== "undefined" &&
    typeof FileSystemFileHandle.prototype.createSyncAccessHandle === "function",
  opfsUsable: false,
  opfsError: null,
};
if (out.opfs && out.syncAccessHandles) {
  try {
    const root = await navigator.storage.getDirectory();
    const name = `browser-python-probe-${Math.random().toString(36).slice(2)}`;
    const file = await root.getFileHandle(name, { create: true });
    const handle = await file.createSyncAccessHandle();
    handle.write(new Uint8Array([1]));
    handle.flush();
    handle.close();
    await root.removeEntry(name);
    out.opfsUsable = true;
  } catch (error) {
    out.opfsError = `${error?.name ? `${error.name}: ` : ""}${String(error?.message ?? error)}`;
  }
}
postMessage(out);
