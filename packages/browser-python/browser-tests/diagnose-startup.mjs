/**
 * WHERE STARTUP TIME GOES, per engine. A diagnostic, not a suite: it asserts nothing, is not in
 * `suite-list.mjs`, and prints numbers to compare across engines.
 *
 *     BROWSER_ENGINE=firefox  node browser-tests/diagnose-startup.mjs
 *     BROWSER_ENGINE=chromium node browser-tests/diagnose-startup.mjs
 *     BROWSER_ENGINE=webkit   node browser-tests/diagnose-startup.mjs
 *
 * It separates the candidates for a slow start, so a fix is aimed at the one that is real:
 *
 *   - raw WebAssembly speed, in the PAGE and in a dedicated WORKER (where Python runs): a tight
 *     integer loop, and compiling the runtime's own pyodide.asm.wasm. If the worker is several
 *     times slower than the page, or than another engine, the engine is running WebAssembly in a
 *     slow tier there - which no change to this package can fix;
 *   - the network: when each runtime file was requested and how long the server took to send it;
 *   - each startup step, from the engine's own status events (runtime download, workspace,
 *     packages, console), timed from the page;
 *   - pure-Python speed once started.
 */
import { performance } from "node:perf_hooks";
import { ENGINE, fixturePage, inBrowser, requireDist, serve } from "./harness.mjs";

requireDist();

// (func (param $n i32) (result i32)): s = s * 31 + i for i in [0, n) - 38 bytes of body, checked
// against Node's own engine before use. Pure integer work: no memory, no imports, no calls.
const LOOP_WASM = [
  0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 3, 2, 1, 0, 7, 7, 1, 3, 0x72,
  0x75, 0x6e, 0, 0, 0x0a, 0x28, 1, 0x26, 1, 2, 0x7f, 2, 0x40, 3, 0x40, 0x20, 1, 0x20, 0, 0x4e, 0x0d,
  1, 0x20, 2, 0x41, 0x1f, 0x6c, 0x20, 1, 0x6a, 0x21, 2, 0x20, 1, 0x41, 1, 0x6a, 0x21, 1, 0x0c, 0,
  0x0b, 0x0b, 0x20, 2, 0x0b,
];
const ITERATIONS = 300_000_000;

/** Runs in the page, and - as source text - in a worker. Returns milliseconds. */
const BENCH_SOURCE = `
  async function bench(bytes, iterations) {
    const loopModule = await WebAssembly.compile(new Uint8Array(bytes));
    const { run } = (await WebAssembly.instantiate(loopModule)).exports;
    run(1000);
    let t = performance.now();
    run(iterations);
    const loopMs = performance.now() - t;
    const wasm = await (await fetch(new URL("/runtime/pyodide.asm.wasm", location.origin))).arrayBuffer();
    t = performance.now();
    await WebAssembly.compile(wasm);
    const compileMs = performance.now() - t;
    return { loopMs: Math.round(loopMs), compileRuntimeMs: Math.round(compileMs), wasmBytes: wasm.byteLength };
  }
`;

const timeline = [];
let pageStartedAt = 0;
const recordRequests = (req, res, url) => {
  if (!url.pathname.startsWith("/runtime/")) return false;
  const at = performance.now() - pageStartedAt;
  res.on("finish", () =>
    timeline.push({
      path: url.pathname.replace("/runtime/", ""),
      requestedAtMs: Math.round(at),
      sendMs: Math.round(performance.now() - pageStartedAt - at),
    }),
  );
  return false; // let the static route serve it
};

const print = (label, value) => {
  console.log(`  ${label.padEnd(44)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
};

const outcome = await inBrowser(async (page) => {
  console.log(`\n=== startup diagnosis [${ENGINE}] ===`);

  // ---- raw WebAssembly, page and worker, on a page with no engine running
  const bench = await serve("<!doctype html><title>bench</title>", { handle: recordRequests });
  try {
    await page.goto(bench.url);
    const inPage = await page.evaluate(
      async ([source, bytes, n]) => {
        const bench = new Function(`${source}; return bench;`)();
        return await bench(bytes, n);
      },
      [BENCH_SOURCE, LOOP_WASM, ITERATIONS],
    );
    print("page:   wasm integer loop (ms)", inPage.loopMs);
    print("page:   compile pyodide.asm.wasm (ms)", inPage.compileRuntimeMs);
    const inWorker = await page.evaluate(
      async ([source, bytes, n]) => {
        const code = `${source}
          onmessage = async (e) => {
            try { postMessage({ ok: await bench(e.data.bytes, e.data.n) }); }
            catch (error) { postMessage({ error: String(error) }); }
          };`;
        const worker = new Worker(
          URL.createObjectURL(new Blob([code], { type: "text/javascript" })),
        );
        const answer = await new Promise((resolve) => {
          worker.onmessage = (e) => resolve(e.data);
          worker.postMessage({ bytes, n });
        });
        worker.terminate();
        return answer;
      },
      [BENCH_SOURCE, LOOP_WASM, ITERATIONS],
    );
    if (inWorker.error) print("worker: benchmark failed", inWorker.error);
    else {
      print("worker: wasm integer loop (ms)", inWorker.ok.loopMs);
      print("worker: compile pyodide.asm.wasm (ms)", inWorker.ok.compileRuntimeMs);
    }
  } finally {
    await bench.close();
  }

  // ---- real startups, step by step
  for (const profile of ["minimal", "xarray-zarr"]) {
    timeline.length = 0;
    const server = await serve(fixturePage({ profile }), { handle: recordRequests });
    try {
      pageStartedAt = performance.now();
      await page.goto(server.url);
      await page.waitForFunction(() => window.__py !== undefined, null, { timeout: 20_000 });
      const steps = await page.evaluate(async () => {
        const marks = [];
        const t0 = performance.now();
        window.__py.engine.onStatus((e) =>
          marks.push([Math.round(performance.now() - t0), e.detail ?? e.state]),
        );
        try {
          await window.__py.start();
          marks.push([Math.round(performance.now() - t0), "start() resolved"]);
        } catch (error) {
          marks.push([
            Math.round(performance.now() - t0),
            `start() FAILED: ${error?.message ?? error}`,
          ]);
        }
        return { marks, ok: window.__py.state() === "ready" };
      });
      console.log(
        `\n  -- ${profile}: startup steps (ms from start(), then the step that began) --`,
      );
      for (const [at, what] of steps.marks) console.log(`     ${String(at).padStart(7)}  ${what}`);
      if (!steps.ok) continue;
      const python = await page.evaluate(async () => {
        const r = await window.__py.run(
          "import time\n_t = time.perf_counter()\n_s = sum(i * i for i in range(2_000_000))\n" +
            "print(round((time.perf_counter() - _t) * 1000))\n",
        );
        return { error: r.error ?? null, ms: window.__py.text("stdout").trim().split("\n").pop() };
      });
      print(`${profile}: pure-Python loop, 2e6 (ms)`, python.error ?? python.ms);
      const slowest = [...timeline].sort((a, b) => b.sendMs - a.sendMs).slice(0, 5);
      print(`${profile}: runtime files requested`, timeline.length);
      print(`${profile}: slowest server sends`, slowest);
      await page.evaluate(() => window.__py.dispose());
    } finally {
      await server.close();
    }
  }
  return [{ name: "diagnostic finished", pass: true }];
});

if (outcome.status !== "pass") {
  console.log(`\nthe diagnostic did not finish: ${JSON.stringify(outcome).slice(0, 600)}`);
}
console.log(`\n(${ENGINE}) paste everything above between the === lines.`);
process.exit(0);
