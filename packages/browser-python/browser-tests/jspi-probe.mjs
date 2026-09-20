// PROBE: can a legacy-filesystem `open()` suspend on JSPI while an OPFS handle is acquired
// asynchronously - with no SharedArrayBuffer, no COOP/COEP and no custom runtime?
//
//     node browser-tests/jspi-probe.mjs
//
// WHY IT MATTERS. The pooled backend is already proven and bounded-memory, with exactly one
// limitation: a single execution cannot create more files than there are free slots, because
// slots are acquired asynchronously at startup. That is what stops `to_zarr()`, which writes
// thousands of chunk files inside one call. If `open()` can suspend, the pool is unnecessary.
//
// HOW IT IS JUDGED. Throwing is a clean failure. Returning a Promise into synchronous filesystem
// code is the dangerous one: it becomes a truthy object where a byte count belongs and produces a
// file that looks complete and is not. The probe records the SHAPE of what came back from every
// route it tries, and a leaked Promise is reported as failure just as loudly as a deadlock. The
// control run uses the proven pool with a deliberately tiny two-slot budget, so the failure mode
// being escaped is visible in the same output.
import { bundleConsole, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();
bundleConsole();

/**
 * Two slots, and far more files than that, so a pool CANNOT satisfy this run. This is THIS
 * probe's budget and nothing else's: `opfs-pool-probe.mjs` runs a 32-slot pool, so a report that
 * quotes both must say which number belongs to which run.
 */
const SLOTS = Number(process.env.JSPI_SLOTS ?? 2);
const FILES = Number(process.env.JSPI_FILES ?? 100);

const PROBES_DIR = new URL("./probes", import.meta.url).pathname;

const runWorker = (mode) => `(async () => {
  const worker = new Worker("/probes/jspi-fs-worker.js", { type: "module" });
  const r = await new Promise((resolve) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => resolve({ ok: false, error: String(e.message ?? e) });
    worker.postMessage({
      indexURL: new URL("/runtime/", location.href).href,
      mode: ${JSON.stringify(mode)},
      slots: ${SLOTS},
      fileCount: ${FILES},
    });
    setTimeout(() => resolve({ ok: false, error: "TIMEOUT - a deadlock looks exactly like this" }), 180000);
  });
  worker.terminate();
  return r;
})()`;

const result = await inBrowser(async (page) => {
  const server = await serve("<!doctype html><meta charset=utf-8><title>jspi probe</title>", {
    roots: { "/probes/": PROBES_DIR },
  });
  const checks = [];
  try {
    await page.goto(server.url);

    // the JSPI attempt
    const jspi = await page.evaluate(runWorker("jspi"));
    console.log("\n=== JSPI mode ===\n" + JSON.stringify(jspi, null, 2));

    const cap = jspi.capability ?? {};
    checks.push({
      name: "the runtime reports JSPI machinery at all",
      pass: cap.hasWebAssemblyPromising === true && cap.hasWebAssemblySuspending === true,
      detail: JSON.stringify({
        promising: cap.hasWebAssemblyPromising,
        suspending: cap.hasWebAssemblySuspending,
        newJspi: cap.newJspiSupported,
        validSuspender: cap.hasValidSuspender,
      }),
    });
    checks.push({
      name: "…and Python's own run_sync works on this build, with no COOP/COEP",
      pass: cap.pythonRunSync === 42,
      detail: JSON.stringify({
        runSync: cap.pythonRunSync ?? cap.pythonRunSyncError,
        coi: cap.crossOriginIsolated,
        sab: cap.hasSAB,
      }),
    });

    const attempts = (jspi.suspendAttempts ?? [])[0]?.attempts ?? [];
    const leaked = attempts.some((a) => a.isPromise === true);
    checks.push({
      name: "no route leaked a Promise into synchronous filesystem code",
      pass: !leaked,
      detail: JSON.stringify(attempts),
    });
    checks.push({
      name: `THE GATE: one execution created ${FILES} dynamically named files with only ${SLOTS} slots`,
      pass: Boolean(jspi.ok && jspi.manyFiles && jspi.manyFiles.made === FILES),
      detail: JSON.stringify(jspi.manyFiles ?? jspi.error),
    });
    if (jspi.ok && jspi.manyFiles && jspi.manyFiles.made === FILES) {
      checks.push({
        name: "…with exact contents, listing, rename and delete",
        pass:
          jspi.manyFiles.sample_digest === jspi.manyFiles.sample_expected &&
          jspi.manyFiles.renamed_present === true &&
          jspi.manyFiles.removed_absent === true,
        detail: JSON.stringify(jspi.manyFiles),
      });
      checks.push({
        name: "…and the WASM heap did not grow with them",
        pass: jspi.heapAfter - jspi.heapBefore < 16 * 1024 * 1024,
        detail: JSON.stringify({ before: jspi.heapBefore, after: jspi.heapAfter }),
      });
    }

    // the control: the proven pool, at the same tiny budget
    const pooled = await page.evaluate(runWorker("pool"));
    console.log(
      "\n=== POOL control (same 2 slots) ===\n" +
        JSON.stringify(pooled.manyFiles ?? pooled.error, null, 2),
    );
    checks.push({
      name: `control: the pooled backend CANNOT do this with ${SLOTS} slots, and says so`,
      pass: Boolean(
        pooled.ok === false ||
        (pooled.manyFiles && (pooled.manyFiles.error || pooled.manyFiles.made !== FILES)),
      ),
      detail: JSON.stringify(pooled.manyFiles ?? pooled.error).slice(0, 260),
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("JSPI suspending-open probe", result));
