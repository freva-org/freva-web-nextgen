/**
 * The real thing: a public, CORS-enabled, consolidated Zarr **v2** store on Google Cloud
 * Storage - often described as v3 in passing, and it is not.
 *
 * OPTIONAL, and off unless BROWSER_PYTHON_NETWORK=1. It proves what the local fixtures cannot -
 * that a store nobody here wrote, served by infrastructure nobody here controls, opens through
 * the ordinary xarray call - and is the wrong thing to gate a pull request on, a bad morning at
 * Google turning every unrelated change red. METADATA ONLY: `.zmetadata` is a few kilobytes,
 * while `wind.plot()` on this store pulls a source chunk measured in tens of megabytes.
 */
import {
  ENGINE,
  NO_JSPI_REMOTE_MESSAGE,
  fixturePage,
  unavailableUnlessRequired,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";

requireDist();

const URL_UNDER_TEST =
  "https://storage.googleapis.com/cmip6/CMIP6/ScenarioMIP/AWI/AWI-CM-1-1-MR/" +
  "ssp585/r1i1p1f1/day/sfcWind/gn/v20190529/";

requireRuntimeFor("public CMIP6 store (network)", "cmip6.mjs");

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "xarray-zarr" }));
  const checks = [];
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    const ready = await page.evaluate(() => window.__py.start());

    const opened = await page.evaluate(async (url) => {
      return window.__py.run(
        `import xarray as xr\n` +
          `ds = xr.open_zarr(${JSON.stringify(url)}, consolidated=True, chunks=None)\n`,
      );
    }, URL_UNDER_TEST);

    if (ready.jspi !== true) {
      // A synchronous remote read needs JSPI, which the worker reported absent.
      checks.push({
        name: "without JSPI the store is refused with the concise JSPI message",
        pass: typeof opened.error === "string" && opened.error.includes(NO_JSPI_REMOTE_MESSAGE),
        detail: JSON.stringify(opened.error),
      });
      return {
        checks,
        unavailable: unavailableUnlessRequired(
          checks,
          "jspi",
          `this ${ENGINE} build's worker has no WebAssembly.Suspending (JSPI)`,
        ),
      };
    }
    checks.push({
      name: "a real public CMIP6 store opens through the ordinary xarray call",
      pass: !opened.error,
      detail: opened.error ? String(opened.error).split("\n").pop() : URL_UNDER_TEST,
    });
    if (opened.error) return checks;

    const vars = await page.evaluate(() => window.__py.push("list(ds.data_vars)"));
    checks.push({
      name: "…and its data variables are readable from metadata alone",
      pass: String(vars.result).includes("sfcWind"),
      detail: String(vars.result),
    });

    const shape = await page.evaluate(() => window.__py.push("ds.sfcWind.shape"));
    checks.push({
      name: "…with a real shape, without downloading a single chunk",
      pass: /^\(\d+, \d+, \d+\)$/.test(String(shape.result)),
      detail: String(shape.result),
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("public CMIP6 store (network)", result));
