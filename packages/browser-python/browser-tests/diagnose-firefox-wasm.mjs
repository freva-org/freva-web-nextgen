/**
 * WHY PLAYWRIGHT'S FIREFOX RUNS WEBASSEMBLY ~5x SLOWER. A diagnostic, not a suite.
 *
 *     node browser-tests/diagnose-firefox-wasm.mjs
 *
 * `diagnose-startup.mjs` showed Firefox ~5x slower than Chromium and WebKit on EVERYTHING that is
 * WebAssembly - a bare integer loop, compiling pyodide.asm.wasm, a pure-Python loop long after
 * startup - in the page and in a worker alike, with the network negligible. Uniformly slow code is
 * the signature of WebAssembly running in Firefox's BASELINE tier and never reaching the
 * optimizing (Ion) tier. This launches Firefox under a few preference sets and measures, for each:
 *
 *   - the same integer loop, called several times after a pause, so a background tier-up that
 *     only applies to NEW calls has every chance to take effect;
 *   - a real minimal interpreter start, and a pure-Python loop.
 *
 * If forcing the optimizing tier brings Firefox level with the other engines, the cost is how the
 * automated browser is configured, not this package.
 */
import { performance } from "node:perf_hooks";
import { fixturePage, requireDist, serve } from "./harness.mjs";

requireDist();

const LOOP_WASM = [
  0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 3, 2, 1, 0, 7, 7, 1, 3, 0x72,
  0x75, 0x6e, 0, 0, 0x0a, 0x28, 1, 0x26, 1, 2, 0x7f, 2, 0x40, 3, 0x40, 0x20, 1, 0x20, 0, 0x4e, 0x0d,
  1, 0x20, 2, 0x41, 0x1f, 0x6c, 0x20, 1, 0x6a, 0x21, 2, 0x20, 1, 0x41, 1, 0x6a, 0x21, 1, 0x0c, 0,
  0x0b, 0x0b, 0x20, 2, 0x0b,
];

const VARIANTS = [
  ["as the harness launches it today", {}],
  ["optimizing tier explicitly on", { "javascript.options.wasm_optimizingjit": true }],
  [
    "optimizing tier ONLY (baseline off)",
    {
      "javascript.options.wasm_baselinejit": false,
      "javascript.options.wasm_optimizingjit": true,
    },
  ],
];

const { firefox } = await import("playwright");
const server = await serve(fixturePage({ profile: "minimal" }));
console.log("\n=== Firefox WebAssembly tiers under Playwright ===");
try {
  for (const [label, prefs] of VARIANTS) {
    const browser = await firefox.launch({ firefoxUserPrefs: prefs });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(server.url);
      // A variant can leave the engine with NO WebAssembly compiler at all - which is itself the
      // answer (see the note printed at the end) - so a failure is reported, not thrown.
      const loop = await page
        .evaluate(async (bytes) => {
          const module = await WebAssembly.compile(new Uint8Array(bytes));
          const { run } = (await WebAssembly.instantiate(module)).exports;
          run(1000);
          await new Promise((r) => setTimeout(r, 2000)); // room for a background tier-up
          const calls = [];
          for (let i = 0; i < 3; i += 1) {
            const t = performance.now();
            run(100_000_000);
            calls.push(Math.round(performance.now() - t));
          }
          return { calls, ua: navigator.userAgent.replace(/^.*(Firefox\/\S+).*$/, "$1") };
        }, LOOP_WASM)
        .catch((error) => ({ error: String(error?.message ?? error).split("\n")[0] }));
      if (loop.error) {
        console.log(`\n  ${label}  ${JSON.stringify(prefs)}`);
        console.log(`    WebAssembly unusable: ${loop.error}`);
        continue;
      }
      await page.waitForFunction(() => window.__py !== undefined, null, { timeout: 20_000 });
      const t = performance.now();
      const started = await page
        .evaluate(() => window.__py.start())
        .then(() => Math.round(performance.now() - t))
        .catch((error) => `failed: ${String(error?.message ?? error).split("\n")[0]}`);
      const python =
        typeof started === "number"
          ? await page.evaluate(async () => {
              await window.__py.run(
                "import time\n_t = time.perf_counter()\n_s = sum(i * i for i in range(2_000_000))\n" +
                  "print(round((time.perf_counter() - _t) * 1000))\n",
              );
              return window.__py.text("stdout").trim().split("\n").pop();
            })
          : "n/a";
      console.log(`\n  ${label}  ${JSON.stringify(prefs)}`);
      console.log(`    ${loop.ua}`);
      console.log(`    wasm loop, 3 calls of 1e8 after a 2 s pause (ms): ${loop.calls.join(", ")}`);
      console.log(`    minimal interpreter start (ms):                    ${started}`);
      console.log(`    pure-Python loop, 2e6 (ms):                        ${python}`);
      await page.evaluate(() => window.__py.dispose()).catch(() => {});
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
console.log(
  "\nFor reference, Chromium and WebKit: loop ~120 ms per 1e8, start ~2.4 s, Python ~400 ms.\n" +
    "'no WebAssembly compiler available' with the baseline tier off means the optimizing tier is\n" +
    "not available to this automated Firefox at all: everything runs in the baseline tier.",
);
process.exit(0);
