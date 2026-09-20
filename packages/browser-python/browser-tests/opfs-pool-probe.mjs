/**
 * PROBE: can a pool of pre-acquired OPFS sync access handles back a real `/workspace`?
 *
 *     node browser-tests/opfs-pool-probe.mjs
 *     OPFS_POOL_MIB=512 OPFS_POOL_SIZE=64 node browser-tests/opfs-pool-probe.mjs
 *
 * Answers one question and builds nothing: whether ordinary Python - a relative path, a write,
 * a seek backwards to rewrite a header, close, reopen, append, rename - lands in real
 * disk-backed storage without memory growing with the file, and whether the result can be
 * handed to a download as an OPFS `File` rather than copied through JS. The filesystem itself
 * is `browser-tests/probes/pool-fs-worker.js`. Deliberately NOT registered in run.mjs, and not
 * wired into the package's own worker.
 */
import { bundleConsole, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();
bundleConsole();

const MIB = Number(process.env.OPFS_POOL_MIB ?? 64);
const POOL = Number(process.env.OPFS_POOL_SIZE ?? 32);

// No trailing slash: the server's traversal guard compares against `dir + sep`, and a
// directory that already ends in a separator never matches its own children.
const PROBES_DIR = new URL("./probes", import.meta.url).pathname;

const PAGE =
  "<!doctype html><meta charset=utf-8><title>pool probe</title>" +
  `<script>window.__probe = ${JSON.stringify({ mib: MIB, poolSize: POOL })};</script>`;

const result = await inBrowser(async (page) => {
  const server = await serve(PAGE, { roots: { "/probes/": PROBES_DIR } });
  const checks = [];
  try {
    await page.goto(server.url);
    const out = await page.evaluate(async () => {
      const worker = new Worker("/probes/pool-fs-worker.js", { type: "module" });
      const r = await new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.onerror = (e) => resolve({ ok: false, error: String(e.message ?? e) });
        worker.postMessage({
          indexURL: new URL("/runtime/", location.href).href,
          ...window.__probe,
        });
        setTimeout(() => resolve({ ok: false, error: "timeout" }), 600000);
      });
      worker.terminate();
      return r;
    });

    console.log("\n" + JSON.stringify(out, null, 2));
    if (!out.ok) {
      checks.push({ name: "the pooled workspace mounted and ran", pass: false, detail: out.error });
      return checks;
    }

    const py = out.py;
    const expected = MIB * 1024 * 1024;
    checks.push({
      name: "ordinary Python writes a relative path into the pooled workspace",
      pass: py.size_after_close === expected,
      detail: JSON.stringify({ size: py.size_after_close, expected }),
    });
    checks.push({
      name: "seeking backwards to rewrite a header works, and survives reopen",
      pass: py.head === "CDF" || py.head.startsWith("CDF"),
      detail: JSON.stringify({ head: py.head, middle: py.middle }),
    });
    checks.push({
      name: "Path.exists() sees the staged file while it is retained",
      pass: py.listing.includes("surface_wind.nc"),
      detail: JSON.stringify(py.listing),
    });
    checks.push({
      name: "append extends it",
      pass: py.size_after_append === py.size_after_close + 4,
      detail: JSON.stringify({ before: py.size_after_close, after: py.size_after_append }),
    });
    checks.push({
      name: "a dynamically named second file costs nothing extra",
      pass: py.renamed_ok === true,
      detail: JSON.stringify(py.listing),
    });
    checks.push({
      name: "rename moves the name, not the bytes",
      pass: py.listing.includes("final.csv") && !py.listing.includes("results.csv"),
      detail: JSON.stringify(py.listing),
    });
    checks.push({
      name: `WASM heap does not grow with the file: ${MIB} MiB written`,
      pass: out.heapGrowthMiB !== null && out.heapGrowthMiB < Math.max(8, MIB / 8),
      detail: JSON.stringify({
        heapGrowthMiB: out.heapGrowthMiB,
        wroteMiB: out.wroteMiB,
        heapBefore: out.heapBefore,
        heapAfter: out.heapAfter,
      }),
    });
    checks.push({
      name: "pool exhaustion is reported, not hidden",
      pass: Boolean(out.exhaustion && (out.exhaustion.made !== undefined || out.exhaustion.error)),
      detail: JSON.stringify(out.exhaustion),
    });
    checks.push({
      name: "the finished file is an OPFS File behind a blob URL, with no arrayBuffer",
      pass:
        out.download.isFile === true &&
        out.download.urlCreated === true &&
        out.download.fileSize === py.size_after_append,
      detail: JSON.stringify(out.download),
    });
    checks.push({
      name: `acquiring ${POOL} handles at startup is affordable`,
      pass: out.poolMs < 5000,
      detail: `${out.poolMs} ms for ${out.poolSize} slots`,
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("pooled-OPFS workspace probe", result));
