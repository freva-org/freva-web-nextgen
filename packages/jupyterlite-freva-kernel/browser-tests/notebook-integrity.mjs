// What the notebook does when its environment is not what it should be: a browser without JSPI
// (the notice card instead of a traceback), a tampered runtime wheel and a tampered add-on
// (both refused before anything is installed, and said so in the cell).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EXIT_NOT_RUN,
  RUNTIME_DIR,
  STRICT,
  TEST_WORKERS,
  cells,
  instrumentedPage,
  kernelIdle,
  launch,
  openNotebook,
  report,
  serveSite,
  setCell,
  testSite,
  violations,
} from "./lite-harness.mjs";

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

let browser;
try {
  browser = await launch();
} catch (error) {
  console.log(`NOT RUN: browser unavailable: ${String(error).split("\n")[0]}`);
  process.exit(STRICT ? 1 : EXIT_NOT_RUN);
}

/** Open scratch.ipynb on a served site, run one cell, return its output text and HTML. */
async function runOne(servers, source, timeout = 300_000) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const { page, record } = await instrumentedPage(context);
  try {
    await openNotebook(page, servers.notebook.url, "scratch.ipynb");
    await setCell(page, 0, source);
    await page.keyboard.press("Control+Enter");
    await kernelIdle(page, timeout);
    const [cell] = await cells(page);
    return { cell, page, record, violations: await violations(page, record), context };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function scenario(name, work) {
  try {
    await work();
  } catch (error) {
    check(
      `${name}: completed`,
      false,
      String(error?.message ?? error)
        .split("\n")
        .slice(0, 3)
        .join(" | "),
    );
  }
}

try {
  let site;
  try {
    site = await testSite();
  } catch (error) {
    console.log(`NOT RUN: the notebook site could not be built: ${error.message.split("\n")[0]}`);
    process.exit(STRICT ? 1 : EXIT_NOT_RUN);
  }

  await scenario("no JSPI", async () => {
    // The engine's own worker, with WebAssembly stack switching removed before it loads - in
    // every engine, the ones that have JSPI included.
    const workerOverride = (path) => {
      if (path.endsWith("/worker/browser-python.worker.js")) {
        return Buffer.from(
          'import "/__test/strip-jspi.mjs";\nimport "./browser-python.worker.real.js";\n',
        );
      }
      if (path.endsWith("/worker/browser-python.worker.real.js")) {
        return readFileSync(join(site, path.replace(/\.real\.js$/, ".js")));
      }
      if (path === "/__test/strip-jspi.mjs")
        return readFileSync(join(TEST_WORKERS, "strip-jspi.mjs"));
      return null;
    };
    const servers = await serveSite(site, { workerOverride });
    try {
      const run = await runOne(
        servers,
        `import xarray as xr\nxr.open_zarr("${servers.data.url}/zarr-v3", consolidated=True, chunks=None)`,
      );
      check(
        "without JSPI a remote read shows the notice card",
        /class="bp-notice/.test(run.cell.html),
        run.cell.html.slice(0, 300),
      );
      check(
        "…whose plain text says the code is fine, not a traceback",
        /can't open remote datasets/.test(run.cell.text) && !/Traceback/.test(run.cell.text),
        run.cell.text.slice(0, 300),
      );
      await setCell(run.page, 0, "sum(range(10))");
      await run.page.keyboard.press("Control+Enter");
      await kernelIdle(run.page);
      const [after] = await cells(run.page);
      check("…and the session carries on", /45/.test(after.text), after.text);
      check("…with no CSP violations", run.violations.length === 0, run.violations.join(" | "));
      await run.context.close();
    } finally {
      await servers.close();
    }
  });

  await scenario("tampered runtime", async () => {
    const runtimeOverride = (path) => {
      if (!/\/xarray-[^/]+\.whl$/.test(path)) return null;
      const bytes = Buffer.from(readFileSync(join(RUNTIME_DIR, path)));
      bytes[bytes.length - 1] ^= 0xff;
      return bytes;
    };
    const servers = await serveSite(site, { runtimeOverride });
    try {
      const run = await runOne(servers, "1 + 1", 300_000);
      check(
        "a tampered runtime wheel is refused before it is installed, and the cell says so",
        /could not start/i.test(run.cell.text) && /xarray/i.test(run.cell.text),
        run.cell.text.slice(0, 400),
      );
      await run.context.close();
    } finally {
      await servers.close();
    }
  });

  await scenario("tampered add-on", async () => {
    let dask;
    try {
      dask = await testSite({
        name: "dask",
        setups: [
          {
            id: "xarray-zarr",
            label: "xarray-zarr + dask",
            profile: "xarray-zarr",
            addons: ["dask"],
          },
        ],
      });
    } catch (error) {
      check("tampered add-on: site built", false, error.message.split("\n")[0]);
      return;
    }
    const runtimeOverride = (path) => {
      if (!/^\/python-addons\/dask\/.+\.whl$/.test(path)) return null;
      return Buffer.from("this is not the pinned wheel");
    };
    const servers = await serveSite(dask, { runtimeOverride });
    try {
      const run = await runOne(servers, "1 + 1", 300_000);
      check(
        "a tampered add-on is refused before it is installed, and the cell says so",
        /could not start/i.test(run.cell.text) && /dask/i.test(run.cell.text),
        run.cell.text.slice(0, 400),
      );
      await run.context.close();
    } finally {
      await servers.close();
    }
  });
} finally {
  await browser.close().catch(() => undefined);
}

process.exit(report("notebook-integrity: no JSPI, tampered runtime, tampered add-on", checks));
