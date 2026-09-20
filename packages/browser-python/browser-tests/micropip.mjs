/**
 * Installing a package from the console, the only way to add one to a session with no backend.
 *
 * The documented command is `import micropip` / `await micropip.install(...)` and nothing else -
 * no `%pip` magic, no shell, no subprocess, no Linux pip, none of which exist in a Worker. This
 * suite pins that `micropip` is actually in the profile, so following the README cannot produce
 * `ModuleNotFoundError: No module named 'micropip'`. The wheel is served by the test's own
 * server from `tests/fixtures/wheels/`, so nothing depends on PyPI or on the network beyond
 * localhost; `--network` runs may additionally install something real.
 */
import {
  bundleConsole,
  fixturePage,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";

requireDist();
bundleConsole();

requireRuntimeFor("installing packages with micropip", "micropip.mjs");

const WHEEL = "/fixtures/wheels/freva_test_pkg-1.0.0-py3-none-any.whl";

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "xarray-zarr" }));
  const checks = [];
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__py !== undefined, null, { timeout: 20000 });
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 180000 });

    // ------ micropip is there when ready is reported
    const imported = await page.evaluate(() =>
      window.__py.run("import micropip\nprint(micropip.__name__)\n"),
    );
    checks.push({
      name: "micropip is importable the moment the console is ready, with no loadPackage",
      pass: !imported.error,
      detail: imported.error ? String(imported.error).split("\n").pop() : "imported",
    });

    // ------ install, import, and RUN it
    const installed = await page.evaluate(async (wheel) => {
      window.__py.drain();
      const r = await window.__py.run(
        [
          "import micropip",
          `await micropip.install("${new URL(wheel, location.href).href}")`,
          "import freva_test_pkg",
          "print(freva_test_pkg.greet('waterpark'))",
          "print(freva_test_pkg.add(19, 23))",
          "",
        ].join("\n"),
      );
      return { r, text: window.__py.text("stdout") };
    }, WHEEL);

    checks.push({
      name: "micropip installs a pure-Python wheel served from this origin",
      pass: !installed.r.error,
      detail: installed.r.error ? String(installed.r.error).split("\n").pop() : "installed",
    });
    checks.push({
      name: "…and the installed module imports and its code actually executes",
      pass:
        installed.text.includes("hello waterpark from an installed wheel") &&
        installed.text.includes("42"),
      detail: JSON.stringify(installed.text.slice(-160)),
    });

    // ------ a failed install leaves a usable engine
    const failed = await page.evaluate(async () => {
      const bad = await window.__py.run(
        [
          "import micropip",
          `await micropip.install("${new URL("/fixtures/wheels/nope-9.9.9-py3-none-any.whl", location.href).href}")`,
          "",
        ].join("\n"),
      );
      // Drained, so what follows is about THIS command and not the earlier prints.
      window.__py.drain();
      // The engine must still be the same interpreter, with the installed package still in it.
      const after = await window.__py.run("print(freva_test_pkg.add(1, 1))\n");
      // Output crosses the worker boundary as its own message; `run()` resolving does not
      // guarantee the last stdout event has reached the listener yet.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        badError: bad.error ?? null,
        afterError: after.error ?? null,
        text: window.__py.text("stdout"),
      };
    });

    checks.push({
      name: "an install that cannot be fetched raises, rather than failing silently",
      pass: Boolean(failed.badError),
      detail: failed.badError ? String(failed.badError).split("\n").pop() : "no error raised",
    });
    checks.push({
      name: "…and the interpreter is still usable afterwards, with its state intact",
      pass: !failed.afterError && failed.text.trimEnd().endsWith("2"),
      detail: JSON.stringify({ afterError: failed.afterError, tail: failed.text.trim() }),
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("installing packages with micropip", result));
