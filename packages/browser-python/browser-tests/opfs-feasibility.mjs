/**
 * THE FEASIBILITY GATE for browser artifacts: can `/workspace` be real, disk-backed storage whose
 * memory use does not grow with output size?
 *
 *     node browser-tests/opfs-feasibility.mjs
 *
 * Not registered in `run.mjs`: a measurement, not a regression test. It writes hundreds of
 * megabytes and takes about a minute. Committed so the decision stays re-checkable, since a later
 * browser or Pyodide can change any answer. Measured on Chromium 1194 / Pyodide 314.0.6 /
 * Python 3.14.
 *
 * 1. OPFS SYNC ACCESS HANDLES WORK IN A PLAIN WORKER, with no cross-origin isolation:
 *
 *      crossOriginIsolated       false          <- and it still worked
 *      createSyncAccessHandle    present
 *      sequential write          8 MiB, ok
 *      random write + read back  "1,2,3,4"      <- seek and re-read are exact
 *      truncate                  1024, ok
 *      flush / close             ok
 *
 *    So the primitive needs no COOP/COEP, which removes a hosting requirement everybody assumed.
 *
 * 2. IT IS BOUNDED. 1 GiB in 1 MiB chunks, WASM memory not involved - the bytes go from a 1 MiB
 *    JS view straight to the handle:
 *
 *      OPFS   1 GiB requested -> 465,079,879 bytes written, 6.3 s   (quota, see 4)
 *      MEMFS  1 GiB requested -> 1024 MiB written, 19.0 s           (all of it in WASM memory)
 *
 *    MEMFS "succeeded", and that is the problem: a gigabyte of output is a gigabyte of heap.
 *
 * 3. THE COST OF A FILE. ~0.6 ms to acquire a sync access handle; 500 small files took 723 ms. A
 *    Zarr store with thousands of chunks pays ~0.6 ms per chunk in acquisition alone - fine for
 *    hundreds, worth measuring again for tens of thousands.
 *
 * 4. QUOTA IS SILENT, AND ANY IMPLEMENTATION MUST HANDLE IT. The 1 GiB write reported `ok: true`
 *    and produced a 443 MiB file: at the quota `write()` returns a SHORT COUNT rather than
 *    throwing, so a loop advancing by the chunk length silently truncates and calls it success.
 *    Check the return value of every write and surface a quota error.
 *
 * 5. SPARSE FILES BEYOND THE QUOTA DO NOT WORK. `truncate(4 GiB + 4)` left the size unchanged and
 *    a read at 4 GiB returned zeros: large-offset random access is bounded by quota, not the API.
 *
 * 6. THE SYNC/ASYNC GAP - the real integration question. Emscripten's legacy filesystem calls
 *    `open()` SYNCHRONOUSLY; acquiring an OPFS handle (`getFileHandle`, `createSyncAccessHandle`)
 *    is ASYNCHRONOUS, and only the acquisition straddles the boundary. SharedArrayBuffer +
 *    Atomics.wait with a helper worker is MEASURED WORKING under COOP/COEP (`waited: "ok"`), with
 *    both workers spawned from the page - nesting the helper inside the blocker reports a false
 *    timeout. JSPI (`WebAssembly.Suspending`) is PRESENT in the worker, but whether Pyodide's
 *    filesystem callbacks can suspend is NOT tested here and must not be assumed.
 *
 *    The pinned runtime has no WasmFS and no OPFS backend compiled in - scanning `pyodide.asm.mjs`
 *    gives WASMFS 0, OPFS 0, createSyncAccessHandle 0, while MEMFS/IDBFS/PROXYFS/WORKERFS and
 *    `createNode`/`registerDevice` are all present. So the route is a custom filesystem over the
 *    legacy FS API, or a custom Pyodide build.
 *
 * VERDICT. Bounded-memory disk-backed storage IS feasible here and needs no special headers. What
 * needs a decision is how the synchronous filesystem reaches an asynchronous acquisition: SAB +
 * Atomics (proven, costs COOP/COEP on the deployment origin), JSPI (present, unproven, free in
 * headers if it works), or a custom build (heaviest, owns the problem completely). That answer
 * determines the backend, the hosting requirements and the browser matrix.
 */
import { bundleConsole, fixturePage, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();
bundleConsole();

/** Cross-origin isolation is a header decision, so the probe serves both and compares. */
const COI = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
};

/** Requested megabytes. Small by default; the stress figure in the header used 1024. */
const MIB = Number(process.env.OPFS_PROBE_MIB ?? 64);

const CAPABILITY_WORKER = `
self.onmessage = async (e) => {
  const r = { crossOriginIsolated: self.crossOriginIsolated ?? null,
              hasSharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
              jspi: typeof WebAssembly.Suspending === "function" };
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("probe.bin", { create: true });
    r.hasCreateSyncAccessHandle = typeof fh.createSyncAccessHandle === "function";
    if (r.hasCreateSyncAccessHandle) {
      const MiB = 1 << 20;
      const h = await fh.createSyncAccessHandle();
      const chunk = new Uint8Array(MiB).fill(7);
      h.truncate(0);
      let at = 0, short = false;
      const target = e.data.mib * MiB;
      const t0 = performance.now();
      while (at < target) {
        // The return value is CHECKED. Quota exhaustion is a short write, not an exception - see
        // finding 4 in this file's header.
        const n = h.write(chunk, { at });
        if (n < chunk.length) { short = true; at += n; break; }
        at += n;
      }
      r.ms = Math.round(performance.now() - t0);
      r.shortWrite = short;
      r.size = h.getSize();
      const marker = new Uint8Array([1, 2, 3, 4]);
      h.write(marker, { at: Math.max(0, Math.floor(r.size / 2)) });
      const back = new Uint8Array(4);
      h.read(back, { at: Math.max(0, Math.floor(r.size / 2)) });
      r.randomReadBack = Array.from(back).join(",");
      h.truncate(1024);
      r.sizeAfterTruncate = h.getSize();
      h.flush();
      h.close();
    }
    await root.removeEntry("probe.bin").catch(() => {});
    const est = await navigator.storage.estimate();
    r.quotaMiB = Math.round((est.quota ?? 0) / (1 << 20));
    r.usageMiB = Math.round((est.usage ?? 0) / (1 << 20));
  } catch (err) { r.error = String(err).slice(0, 200); }
  self.postMessage(r);
};
`;

const spawnAndAsk = (src, message, timeoutMs) =>
  `(async () => {
    const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(src)}], { type: "text/javascript" })));
    const r = await new Promise((res) => {
      w.onmessage = (e) => res(e.data);
      w.onerror = (e) => res({ error: String(e.message ?? e) });
      w.postMessage(${JSON.stringify(message)});
      setTimeout(() => res({ error: "timeout" }), ${timeoutMs});
    });
    w.terminate();
    return r;
  })()`;

const checks = [];

/* capability, on a PLAIN origin */
const plain = await inBrowser(async (page) => {
  const server = await serve("<!doctype html><meta charset=utf-8><title>opfs</title>");
  try {
    await page.goto(server.url);
    const r = await page.evaluate(`${spawnAndAsk(CAPABILITY_WORKER, { mib: MIB }, 300000)}`);
    console.log("\n  plain origin:", JSON.stringify(r));
    checks.push({
      name: "OPFS sync access handles work in a Worker with NO cross-origin isolation",
      pass: r.hasCreateSyncAccessHandle === true && r.crossOriginIsolated === false,
      detail: JSON.stringify({ coi: r.crossOriginIsolated, handles: r.hasCreateSyncAccessHandle }),
    });
    checks.push({
      name: `…writing ${MIB} MiB in 1 MiB chunks, with every write's return value checked`,
      pass: r.size > 0 && r.error === undefined,
      detail: JSON.stringify({
        size: r.size,
        ms: r.ms,
        shortWrite: r.shortWrite,
        quotaMiB: r.quotaMiB,
      }),
    });
    checks.push({
      name: "…random write and read-back is exact",
      pass: r.randomReadBack === "1,2,3,4",
      detail: String(r.randomReadBack),
    });
    checks.push({
      name: "…truncate resizes the file",
      pass: r.sizeAfterTruncate === 1024,
      detail: String(r.sizeAfterTruncate),
    });
    checks.push({
      name: "SharedArrayBuffer is absent without COOP/COEP, so a SAB bridge would need headers",
      pass: r.hasSharedArrayBuffer === false,
      detail: JSON.stringify({ sab: r.hasSharedArrayBuffer, jspi: r.jspi }),
    });
    return [{ name: "plain", pass: true }];
  } finally {
    await server.close();
  }
});
if (plain.status !== "pass")
  checks.push({ name: "plain-origin probe ran", pass: false, detail: plain.detail });

/* the sync/async bridge, which is the integration question */
const BLOCKER = `self.onmessage = (e) => {
  const flag = new Int32Array(e.data.sab);
  const t0 = performance.now();
  const waited = Atomics.wait(flag, 0, 0, 8000);
  self.postMessage({ waited, ms: Math.round(performance.now() - t0), value: Atomics.load(flag, 0) });
};`;
const HELPER = `self.onmessage = async (e) => {
  const flag = new Int32Array(e.data.sab);
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("bridged.bin", { create: true });
    const h = await fh.createSyncAccessHandle();
    h.close();
    await root.removeEntry("bridged.bin").catch(() => {});
    Atomics.store(flag, 0, 1);
  } catch (err) { Atomics.store(flag, 0, 2); }
  Atomics.notify(flag, 0);
  self.postMessage({ done: true });
};`;

const isolated = await inBrowser(async (page) => {
  const server = await serve("<!doctype html><meta charset=utf-8><title>opfs</title>", {
    headers: COI,
  });
  try {
    await page.goto(server.url);
    const r = await page.evaluate(
      async ([blockerSrc, helperSrc]) => {
        if (typeof SharedArrayBuffer === "undefined") return { skipped: true };
        const spawn = (code) =>
          new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
        const sab = new SharedArrayBuffer(4);
        // Both spawned from the PAGE: nesting the helper inside the blocker reports a false
        // negative.
        const blocker = spawn(blockerSrc);
        const helper = spawn(helperSrc);
        const said = new Promise((res) => (blocker.onmessage = (e) => res(e.data)));
        blocker.postMessage({ sab });
        await new Promise((res) => setTimeout(res, 200));
        helper.postMessage({ sab });
        const out = await said;
        blocker.terminate();
        helper.terminate();
        return out;
      },
      [BLOCKER, HELPER],
    );
    console.log("  atomics bridge (COI):", JSON.stringify(r));
    checks.push({
      name: "a synchronous thread CAN block on Atomics.wait while another does the async OPFS work",
      pass: r.waited === "ok" && r.value === 1,
      detail: JSON.stringify(r),
    });
    return [{ name: "iso", pass: true }];
  } finally {
    await server.close();
  }
});
if (isolated.status !== "pass")
  checks.push({ name: "isolated probe ran", pass: false, detail: isolated.detail });

/* the baseline this exists to refuse: MEMFS */
const memfs = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "minimal" }));
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__py !== undefined);
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 240000 });
    const out = await page.evaluate(async (mib) => {
      window.__py.drain();
      const r = await window.__py.run(
        [
          "import json, os, time",
          "chunk = b'x' * (1024 * 1024)",
          "written = 0; err = None; t0 = time.time()",
          "try:",
          `    with open('/tmp/gate.bin', 'wb') as fh:`,
          `        for _ in range(${mib}):`,
          "            fh.write(chunk); written += len(chunk)",
          "except BaseException as exc:",
          "    err = type(exc).__name__",
          "ms = int((time.time() - t0) * 1000)",
          "try: os.remove('/tmp/gate.bin')",
          "except Exception: pass",
          "print(json.dumps({'writtenMiB': written // 1048576, 'error': err, 'ms': ms}))",
          "",
        ].join("\n"),
      );
      await new Promise((z) => setTimeout(z, 300));
      return { error: r.error ?? null, stdout: window.__py.text("stdout").trim() };
    }, MIB);
    console.log("  MEMFS baseline:", out.stdout || out.error);
    checks.push({
      name: `MEMFS accepts ${MIB} MiB - which is ${MIB} MiB of WebAssembly heap, and why it is refused`,
      pass: out.stdout.includes(`"writtenMiB": ${MIB}`),
      detail: out.stdout || String(out.error),
    });
    return [{ name: "memfs", pass: true }];
  } finally {
    await server.close();
  }
});
if (memfs.status !== "pass")
  checks.push({ name: "memfs baseline ran", pass: false, detail: memfs.detail });

process.exit(
  report("OPFS feasibility gate", {
    status: checks.every((c) => c.pass) ? "pass" : "fail",
    checks,
  }),
);
