import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No DOM environment: everything under test here is either pure protocol logic or a fake
    // Worker. A jsdom/happy-dom global would only hide the fact that this package must run in a
    // real Worker, which the browser suite is for.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      /*
       * What is NOT measured here, and where it is measured instead.
       *
       * These thresholds were unmet for as long as they had existed, which makes them decoration:
       * a gate nobody can pass is a gate everybody has learned to ignore. The cause was not
       * untested code but code that cannot be tested in Node. The custom element, the jQuery
       * Terminal adapter and the worker all need a DOM, a real Worker or a real interpreter, and
       * they are covered - thoroughly - by `browser-tests/`, in a browser, against the built
       * package. Loading them here to raise a number would test a happy-dom impression of a
       * browser rather than a browser.
       *
       * So they are excluded by NAME rather than by lowering the bar, each with the suite that
       * covers it, and the threshold applies to the code this runner can honestly reach.
       */
      exclude: [
        // Re-exports only: every symbol it names is measured where it is defined, and
        // tests/packaging/pack-and-install.mjs proves the entry point exports them from the
        // INSTALLED tarball, which is the property that actually matters here.
        "src/index.ts",
        /*
         * The Worker half. Every path in it needs a live Worker and a real Pyodide runtime, and
         * each file is covered by named browser suites rather than by a happy-dom impression:
         *
         *   worker/browser-python.worker.ts  repl.mjs, display.mjs, console-real-engine.mjs
         *   worker/opfs-workspace.ts         workspace.mjs, workspace-errors.mjs (with faults
         *                                    injected into the SHIPPED module), workspace-stream,
         *                                    workspace-lifecycle
         *   worker/pyodide-runtime.ts        repl.mjs, freva-client.mjs, micropip.mjs
         *   worker/output.ts                 display.mjs (batching, bounds, the await flush)
         *   worker/repl.ts, worker/artifacts.ts  repl.mjs, workspace.mjs
         */
        "src/worker/**",
        // Generated from `src/python/*.py` and `styles.css`; the sources are what is reviewed, and
        // `npm run typecheck` fails when the generated copy has drifted from them.
        "src/**/*.generated.ts",
        // The custom element: browser-tests/console.mjs, console-files.mjs, console-lifecycle.mjs,
        // console-real-engine.mjs, and the keyboard/pointer/paste/mobile suites.
        "src/console/browser-python-console.ts",
        // Registration side effects only, and browser-tests/console.mjs asserts them.
        "src/console/auto.ts",
        // jQuery Terminal in a shadow root: browser-tests/console-keyboard.mjs, -pointer,
        // -paste-and-caret, -mobile.
        "src/console/adapters/**",
        /*
         * NOTHING FROM `src/embed` IS EXCLUDED ANY MORE.
         *
         * Round 7 excluded both halves of the bridge on the grounds that they need real
         * cross-origin frames. Half of that was true and half was an excuse: what they actually
         * need is a `postMessage` target, an `addEventListener("message")` and a `MessagePort`,
         * and all three can be built deterministically (tests/embed-fixtures.ts) with none of a
         * browser's timing. The exclusion is what let a feedback loop that made fifty listing
         * requests, and a host that trusted a peer's byte count, ship without a unit test
         * noticing.
         *
         * What genuinely needs a browser stays in browser-tests/embedding-two-origin.mjs: that a
         * wrong origin is refused by the PLATFORM rather than by our own check, that a navigated
         * frame really does keep the same `WindowProxy`, and the transfer semantics of a real
         * `ArrayBuffer` under a real memory measurement.
         */
      ],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
