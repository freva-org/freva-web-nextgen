// What a browser WITHOUT a capability gets - in every engine, deterministically.
//
// Whether the installed Chromium, Firefox or WebKit has WebAssembly JSPI or OPFS synchronous access
// handles is a fact about that build, and a suite that only tested whichever one it happened to
// launch would cover the fallback in some runs and not others. So the capability is REMOVED from
// the worker before the real worker module loads (`test-worker/`), through the public `workerURL`
// option, and the fallback is exercised everywhere. The same run also checks the other half where
// the engine has the capability natively, and says when it does not.
//
//  1. No JSPI: the interpreter starts; ordinary Python, output and files work with NOTHING about
//     stack switching in the transcript; a synchronous wait on a fetch - the primitive a remote
//     Zarr read is built on - fails with one concise, actionable error and no second warning;
//     unrelated errors keep their real tracebacks.
//  2. JSPI present (native): the same synchronous wait succeeds and nothing is printed about it.
//  3. Sync access handles removed: `workspace.available` is false with the reason an independent
//     probe says is right HERE - `no-sync-access-handles` where OPFS exists, `no-opfs` where it
//     does not (Playwright WebKit) - Python still writes files, and the console says why.
import {
  ENGINE,
  NO_JSPI_REMOTE_MESSAGE,
  bundleConsole,
  capabilityAbsent,
  fixturePage,
  inBrowser,
  probeWorkerCapabilities,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
  terminateEngines,
} from "./harness.mjs";
import { cleanupChecks, createPhases, phaseFailureCheck } from "./deadline.mjs";
import { detailMatchesReason, expectedReasonWithoutSyncHandles } from "./workspace-reasons.mjs";

requireDist();
requireRuntimeFor("capability fallbacks", "capability-fallbacks.mjs");
bundleConsole();

/** Phase deadlines, enforced in Node: a start that overruns has its engine terminated. */
const START_TIMEOUT_MS = 120_000;
const COMMANDS_TIMEOUT_MS = 90_000;
/** A same-origin fixture the synchronous wait fetches: small, and always there. */
const FIXTURE = "/fixtures/zarr-v2/.zmetadata";

/** Start the fixture page's engine and hand back what it reported. */
async function startEngine(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20_000 });
  return await page.evaluate(async () => {
    try {
      return { ready: await window.__py.start() };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  });
}

/** Everything one `push` or `run` produced, split by stream. */
async function execute(page, kind, source) {
  return await page.evaluate(
    async ({ kind, source }) => {
      window.__py.drain();
      const outcome =
        kind === "push" ? await window.__py.push(source) : await window.__py.run(source);
      // Output is batched in the worker and flushed before the reply, so it is all here.
      const events = window.__py.drain();
      const text = (type) =>
        events
          .filter((e) => e.type === type)
          .map((e) => e.text)
          .join("");
      return {
        result: outcome.result ?? null,
        error: outcome.error ?? null,
        stdout: text("stdout"),
        stderr: text("stderr"),
        stderrEvents: events.filter((e) => e.type === "stderr").length,
      };
    },
    { kind, source },
  );
}

const MENTIONS_STACK_SWITCHING = /stack switching|JSPI|callPromising/i;

/** Every section, in order, each step a named phase with a real deadline - see the body below. */
async function sections(page, checks, notApplicable, phases) {
  // ------------------------------------------------------------------- 1. JSPI removed
  {
    const server = await serve(fixturePage({ workerURL: "/test-worker/no-jspi.mjs" }));
    try {
      const started = await phases.run("no-JSPI startup", START_TIMEOUT_MS, () =>
        startEngine(page, server.url),
      );
      const startup = await page.evaluate(() => window.__py.drain());
      checks.push({
        name: "without JSPI the interpreter starts, and reports jspi: false",
        pass: started.ready?.jspi === false,
        detail: JSON.stringify(started.error ?? { jspi: started.ready?.jspi }),
      });
      if (!started.ready) return;
      await phases.run("no-JSPI commands", COMMANDS_TIMEOUT_MS, async () => {
        const startupStderr = startup.filter((e) => e.type === "stderr").map((e) => e.text);
        checks.push({
          name: "…and says nothing about stack switching at startup",
          pass: !startupStderr.some((t) => MENTIONS_STACK_SWITCHING.test(t)),
          detail: JSON.stringify(startupStderr),
        });

        const sum = await execute(page, "push", "1 + 1");
        checks.push({
          name: "`1 + 1` answers 2 with nothing on stderr (no display-capture warning)",
          pass: sum.result === "2" && sum.error === null && sum.stderr === "",
          detail: JSON.stringify(sum),
        });
        const printed = await execute(page, "push", "print('hello from a browser without JSPI')");
        checks.push({
          name: "print() reaches stdout with nothing on stderr",
          pass: printed.stdout === "hello from a browser without JSPI\n" && printed.stderr === "",
          detail: JSON.stringify(printed),
        });
        const block = await execute(
          page,
          "run",
          [
            "import json, os",
            "with open('local.json', 'w') as f:",
            "    json.dump({'n': 3}, f)",
            "with open('local.json') as f:",
            "    print(json.load(f)['n'] * 2, os.path.getsize('local.json') > 0)",
          ].join("\n"),
        );
        checks.push({
          name: "a block with local file I/O runs, with nothing on stderr",
          pass: block.stdout === "6 True\n" && block.error === null && block.stderr === "",
          detail: JSON.stringify(block),
        });

        // The primitive a synchronous remote read is built on: zarr's sync layer in Pyodide ends in
        // `run_sync` over a fetch. Here it is called directly, against a same-origin fixture.
        const syncWait =
          "from pyodide.ffi import run_sync\n" +
          "from pyodide.http import pyfetch\n" +
          `run_sync(pyfetch(${JSON.stringify(FIXTURE)}))`;
        const typed = await execute(page, "run", syncWait);
        const concise = (r) =>
          typeof r.error === "string" &&
          r.error.includes(NO_JSPI_REMOTE_MESSAGE) &&
          r.error.includes("https://webkit.org/blog/18325/webkit-features-for-safari-27-0/") &&
          !r.error.includes("Traceback") &&
          r.error.split("\n").length <= 4;
        checks.push({
          name: "a synchronous wait on a fetch fails with the one concise JSPI message",
          pass: concise(typed),
          detail: JSON.stringify(typed.error),
        });
        checks.push({
          name: "…printed once, with no second display-capture warning after it",
          pass:
            typed.stderrEvents === 1 &&
            typed.stderr.split(NO_JSPI_REMOTE_MESSAGE).length === 2 &&
            !/display capture/i.test(typed.stderr),
          detail: JSON.stringify(typed.stderr),
        });
        const pushedLine = await execute(
          page,
          "push",
          `run_sync(pyfetch(${JSON.stringify(FIXTURE)}))`,
        );
        checks.push({
          name: "the same message for a typed line",
          pass: concise(pushedLine) && pushedLine.stderrEvents === 1,
          detail: JSON.stringify(pushedLine),
        });
        const caught = await execute(
          page,
          "run",
          "try:\n" +
            `    run_sync(pyfetch(${JSON.stringify(FIXTURE)}))\n` +
            "except RuntimeError as exc:\n" +
            "    print('caught', type(exc).__name__)\n",
        );
        checks.push({
          name: "the exception itself is untouched: Python code can still catch the RuntimeError",
          pass: caught.stdout === "caught RuntimeError\n" && caught.stderr === "",
          detail: JSON.stringify(caught),
        });
        const unrelated = await execute(page, "push", "1 / 0");
        checks.push({
          name: "an unrelated error keeps its real traceback",
          pass:
            typeof unrelated.error === "string" &&
            unrelated.error.includes("ZeroDivisionError") &&
            !unrelated.error.includes(NO_JSPI_REMOTE_MESSAGE),
          detail: JSON.stringify(unrelated.error),
        });
        const after = await execute(page, "push", "sum(range(4))");
        checks.push({
          name: "and the interpreter carries on normally afterwards",
          pass: after.result === "6" && after.stderr === "",
          detail: JSON.stringify(after),
        });
      });
    } finally {
      await terminateEngines(page);
      await server.close();
    }
  }

  // ------------------------------------------------------------------- 2. JSPI, natively
  {
    const server = await serve(fixturePage());
    try {
      const started = await phases.run("native JSPI startup", START_TIMEOUT_MS, () =>
        startEngine(page, server.url),
      );
      await phases.run("native JSPI commands", COMMANDS_TIMEOUT_MS, async () => {
        const engineHas = await page.evaluate(() => typeof WebAssembly.Suspending === "function");
        checks.push({
          name: "the native worker reports the engine's actual JSPI capability",
          pass: started.ready?.jspi === engineHas,
          detail: JSON.stringify({
            reported: started.ready?.jspi,
            engine: engineHas,
            error: started.error,
          }),
        });
        if (started.ready?.jspi === true) {
          const waited = await execute(
            page,
            "run",
            "from pyodide.ffi import run_sync\n" +
              "from pyodide.http import pyfetch\n" +
              `print(run_sync(pyfetch(${JSON.stringify(FIXTURE)})).status)`,
          );
          checks.push({
            name: "with JSPI the synchronous wait on a fetch succeeds, and nothing is warned",
            pass: waited.stdout === "200\n" && waited.error === null && waited.stderr === "",
            detail: JSON.stringify(waited),
          });
        } else if (started.ready) {
          capabilityAbsent(
            checks,
            notApplicable,
            "jspi",
            "the JSPI-present half",
            `this ${ENGINE} build's worker has no WebAssembly.Suspending`,
          );
        }
      });
    } finally {
      await terminateEngines(page);
      await server.close();
    }
  }

  // ------------------------------------------------------------------- 3. sync handles removed
  //
  // The seam removes `createSyncAccessHandle`. What the worker must then REPORT depends on what the
  // browser had before the seam: where OPFS exists (Firefox, Chromium) the missing piece is the
  // sync handle - `no-sync-access-handles`; where there is no OPFS at all (Playwright WebKit) the
  // first missing prerequisite is OPFS itself - `no-opfs`. An unmodified probe worker in the same
  // context decides which, so neither branch is faked and no other reason is accepted.
  let reported = null;
  {
    const server = await serve(
      fixturePage({ workerURL: "/test-worker/no-sync-access-handles.mjs" }),
    );
    try {
      const started = await phases.run("sync handles removed: startup", START_TIMEOUT_MS, () =>
        startEngine(page, server.url),
      );
      await phases.run("sync handles removed: files and refusal", COMMANDS_TIMEOUT_MS, async () => {
        const native = await probeWorkerCapabilities(page);
        const expected = expectedReasonWithoutSyncHandles(native);
        const workspace = started.ready?.workspace;
        reported = workspace ?? null;
        checks.push({
          name: "with sync access handles removed the interpreter still starts",
          pass: Boolean(started.ready),
          detail: started.error ?? "",
        });
        checks.push({
          name:
            `…and reports workspace.available: false, reason ${expected} ` +
            `(${native.opfs ? "OPFS exists here, so the sync handle is what is missing" : "this engine has no OPFS at all, the first prerequisite"})`,
          pass:
            workspace?.available === false &&
            workspace?.reason === expected &&
            detailMatchesReason(workspace),
          detail: JSON.stringify({ workspace, native }),
        });
        const memfs = await execute(
          page,
          "run",
          "with open('kept.txt', 'w') as f:\n    f.write('in memory')\nprint(open('kept.txt').read())",
        );
        checks.push({
          name: "Python still writes and reads files (in memory)",
          pass: memfs.stdout === "in memory\n" && memfs.error === null,
          detail: JSON.stringify(memfs),
        });
        const listing = await page.evaluate(async () => {
          try {
            return { artifacts: await window.__py.artifacts() };
          } catch (error) {
            return { error: String(error?.message ?? error) };
          }
        });
        checks.push({
          name: "asking for downloads is refused with the reason the engine reported, not an empty list",
          pass: typeof listing.error === "string" && listing.error === workspace?.detail,
          detail: JSON.stringify({ listing, reported: workspace?.detail }),
        });
      });
    } finally {
      await terminateEngines(page);
      await server.close();
    }
  }

  // The console, over the same worker: the file panel shows the reader the fallback the ENGINE
  // reported - whichever of the two it is - rather than a sentence this test expected.
  {
    const consolePage = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<freva-python-console id="c" worker-url="/test-worker/no-sync-access-handles.mjs"></freva-python-console>
<script type="module">
  import { defineBrowserPythonConsole } from "/bundle/console.js";
  defineBrowserPythonConsole();
  const element = document.getElementById("c");
  element.setAttribute("index-url", new URL("/runtime/", location.href).href);
  window.__c = { element };
  window.__ready = true;
</script></body></html>`;
    const server = await serve(consolePage);
    try {
      await phases.run("console with sync handles removed", START_TIMEOUT_MS + 30_000, async () => {
        await page.goto(server.url);
        await page.waitForFunction(() => window.__ready === true, null, { timeout: 20_000 });
        const started = await page.evaluate(async () => {
          try {
            await window.__c.element.start();
            return { ok: true };
          } catch (error) {
            return { error: String(error?.message ?? error) };
          }
        });
        const workspace = await page.evaluate(() => window.__c.element.engine?.workspace ?? null);
        await page
          .waitForFunction(
            (detail) =>
              Boolean(detail) &&
              (window.__c.element.shadowRoot?.textContent ?? "").includes(detail),
            workspace?.detail ?? null,
            { timeout: 30_000 },
          )
          .catch(() => {});
        const panel = await page.evaluate((detail) => {
          const root = window.__c.element.shadowRoot;
          const text = root?.textContent ?? "";
          return {
            showsReportedReason: Boolean(detail) && text.includes(detail),
            mentionsJspi: /stack switching|JSPI/i.test(text),
          };
        }, workspace?.detail ?? null);
        checks.push({
          name: "the console starts and tells the reader the reason the engine reported",
          pass:
            started.ok === true &&
            workspace?.available === false &&
            workspace?.reason === reported?.reason &&
            detailMatchesReason(workspace) &&
            panel.showsReportedReason &&
            !panel.mentionsJspi,
          detail: JSON.stringify({ started, workspace, panel }),
        });
      });
    } finally {
      await terminateEngines(page);
      await server.close();
    }
  }
}

const result = await inBrowser(async (page) => {
  const checks = [];
  const notApplicable = [];
  // Test-only supervision, on this process's stdout - never in the Python transcript. Every step
  // is `phases.run(...)`, which REJECTS at its deadline; only then is the engine terminated
  // (bounded dispose, then the context), and that cleanup is reported on its own.
  const phases = createPhases("capability-fallbacks", {
    onDeadline: () => terminateEngines(page),
  });
  try {
    await sections(page, checks, notApplicable, phases);
  } catch (error) {
    checks.push(phaseFailureCheck(error));
  }
  checks.push(...(await cleanupChecks(phases)));
  return { checks, notApplicable };
});

process.exit(report("capability fallbacks: no JSPI, no sync access handles", result));
