/**
 * Curated add-ons, through the product's own code path, in a real browser. Nothing here clears
 * xarray's caches by hand: every check goes through `prepareAddons` at the position it occupies in
 * `handleInit`, which is the claim. The add-on directory is prepared by `freva-browser-python
 * prepare-addons` and served from the fixture origin; nothing reaches PyPI or Natural Earth, and
 * one check asserts that.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENGINE,
  NO_JSPI_REMOTE_MESSAGE,
  capabilityAbsent,
  fixturePage,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";
import { cleanupChecks, createPhases, phaseFailureCheck, withDeadline } from "./deadline.mjs";

requireDist();
requireRuntimeFor("curated add-ons", "addons.mjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");

/**
 * A prepared add-on directory, made by the shipped command rather than by this file. `ADDON_DIR`
 * short-circuits it for a machine that has one; CI prepares it once. Preparing it here is also the
 * test of `prepare-addons` itself.
 */
const ADDONS = process.env.FREVA_ADDON_DIR ?? join(PKG, ".addons");
if (!existsSync(join(ADDONS, "MANIFEST.json"))) {
  execFileSync(
    process.execPath,
    [join(PKG, "bin", "freva-browser-python.mjs"), "prepare-addons", "--out", ADDONS],
    {
      stdio: "inherit",
    },
  );
}

const DASK_WHEEL = "dask/dask-2026.8.0-py3-none-any.whl";
const COASTLINE =
  "cartopy-natural-earth-110m/shapefiles/natural_earth/physical/ne_110m_coastline.shp";

/** A copy of the prepared directory with one file changed, to prove the digest check is real. */
function tampered(change) {
  const dir = mkdtempSync(join(tmpdir(), "freva-addons-"));
  execFileSync("cp", ["-R", `${ADDONS}/.`, dir]);
  change(dir);
  return dir;
}

const external = (page, server) => {
  const seen = [];
  // A POSITIVE CONTROL for the negative claim. Everything under /runtime/ and /addons/ is fetched
  // by the WORKER, never the page; if none of it is observed, this engine's automation does not
  // report worker requests and "nothing was fetched from outside" would be true of nothing.
  seen.fromWorker = 0;
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith(server.url)) {
      const path = new URL(url).pathname;
      if (path.startsWith("/runtime/") || path.startsWith("/addons/")) seen.fromWorker += 1;
      return;
    }
    if (!url.startsWith("data:") && !url.startsWith("blob:")) seen.push(url);
  });
  return seen;
};

/** Whether `outside` could have seen the worker's requests at all - see `external`. */
const blindTo = (outside) => outside.fromWorker === 0;
const BLIND_REASON =
  `automation limitation: Playwright reported none of the worker's own requests in ${ENGINE}, ` +
  "so an external fetch from the worker could not have been observed either";

const result = await inBrowser(async (page) => {
  const checks = [];
  const notApplicable = [];
  const servers = [];
  const open = async (options, roots) => {
    const server = await serve(fixturePage(options), { roots });
    servers.push(server);
    return server;
  };
  const ready = async (server, timeout = 300000) => {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    const started = await page.evaluate(async () => {
      try {
        return { info: await window.__py.start(), error: null };
      } catch (error) {
        return { info: null, error: String(error && error.message ? error.message : error) };
      }
    });
    if (started.info)
      await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout });
    return started;
  };
  const run = (code) => page.evaluate((c) => window.__py.run(c), code);
  const phases = createPhases("addons", { onDeadline: () => page.context().close() });
  const phase = (name, ms, work) => phases.run(name, ms, work);
  const finish = async () => {
    checks.push(...(await cleanupChecks(phases)));
    return { checks, notApplicable };
  };
  const value = async (expression) => {
    const r = await page.evaluate((e) => window.__py.push(e), expression);
    if (r.error) throw new Error(r.error);
    return r.result;
  };

  try {
    // 1. Dask, end to end
    await phase("Dask add-on, end to end", 360_000, async () => {
      const server = await open(
        { profile: "xarray-zarr", addons: ["dask"], addonBaseURL: "/addons/" },
        { "/addons/": ADDONS },
      );
      const outside = external(page, server);
      const started = await ready(server);
      checks.push({
        name: "the Dask add-on starts, and the ready payload says what it installed",
        pass:
          Boolean(started.info) &&
          started.info.addons.length === 1 &&
          started.info.addons[0].id === "dask" &&
          typeof started.info.addons[0].versions.dask === "string" &&
          started.info.addons[0].versions.dask.length > 0,
        detail: JSON.stringify(started.error ?? started.info?.addons),
      });
      if (started.info) {
        checks.push({
          name: "the scheduler is synchronous before any user code runs",
          pass: (await value("__import__('dask').config.get('scheduler')")) === "'synchronous'",
          detail: await value("__import__('dask').config.get('scheduler')"),
        });
        // NO CACHE CLEARING. This is the whole ordering claim: xarray binds `DaskManager.available`
        // at import and caches `module_available` and `list_chunkmanagers`, so an add-on installed
        // any later would make this line raise "chunk manager 'dask' is not available".
        //
        // The dataset is a REMOTE Zarr fixture, read synchronously: that needs JSPI, which the
        // worker reported on. Without it the refusal is checked and the Dask-over-Zarr half is not
        // applicable; `dask.array` below needs no network and runs either way.
        const jspi = started.info.jspi === true;
        const opened = await page.evaluate(async () => {
          const url = new URL("/fixtures/zarr-v3/", location.href).href;
          return window.__py.run(
            `import xarray as xr\nds = xr.open_dataset(${JSON.stringify(url)}, engine="zarr", chunks={})\n`,
          );
        });
        if (jspi) {
          checks.push({
            name: 'xr.open_dataset(..., engine="zarr", chunks={}) is dask-backed with no cache surgery',
            pass:
              !opened.error && (await value("type(ds.sfcWind.data).__module__")).includes("dask"),
            detail: opened.error
              ? String(opened.error).split("\n").slice(-3).join(" | ")
              : await value("ds.sfcWind.chunks"),
          });
        } else {
          checks.push({
            name: "without JSPI the remote Zarr open is refused with the concise JSPI message",
            pass: typeof opened.error === "string" && opened.error.includes(NO_JSPI_REMOTE_MESSAGE),
            detail: JSON.stringify(opened.error),
          });
          capabilityAbsent(
            checks,
            notApplicable,
            "jspi",
            "Dask over a remote Zarr fixture (open, rechunk, compute, exact values)",
            `this ${ENGINE} build's worker has no WebAssembly.Suspending (JSPI)`,
          );
        }
        if (!opened.error) {
          const computed = await run(
            [
              "rechunked = ds.chunk({'time': 1})",
              "result = rechunked.isel(time=slice(0, 2)).compute()",
              "plain = xr.open_dataset(ds.encoding['source'], engine='zarr', chunks=None) if 'source' in ds.encoding else None",
              "",
            ].join("\n"),
          );
          checks.push({
            name: "Dataset.chunk(...) changes the chunk structure and .compute() returns numpy",
            pass:
              !computed.error &&
              (await value("rechunked.sfcWind.chunks")) === "((1, 1, 1, 1), (5,), (6,))" &&
              (await value("type(result.sfcWind.data).__module__")) === "'numpy'" &&
              (await value("result.sfcWind.shape")) === "(2, 5, 6)",
            detail: computed.error
              ? String(computed.error).split("\n").slice(-3).join(" | ")
              : `${await value("ds.sfcWind.chunks")} -> ${await value("rechunked.sfcWind.chunks")}`,
          });
          checks.push({
            name: "the computed values are exactly the fixture's, not merely plausible floats",
            pass:
              (await value("round(float(result.sfcWind[0, 0, 0].values), 5)")) === "10.27689" &&
              (await value("round(float(result.sfcWind[1, 4, 5].values), 5)")) ===
                (await value(
                  "round(float(xr.open_dataset(ds.encoding.get('source', ''), engine='zarr', chunks=None).sfcWind[1, 4, 5].values), 5)",
                )) &&
              (await value("round(float(ds.sfcWind.sum().compute().values), 3)")) === "954.911",
            detail: JSON.stringify({
              first: await value("round(float(result.sfcWind[0, 0, 0].values), 5)"),
              wholeSum: await value("round(float(ds.sfcWind.sum().compute().values), 3)"),
            }),
          });
        }
        // Local arrays: no network, no JSPI.
        const array = await run(
          "import dask.array as da\ntotal = float((da.ones((10, 10), chunks=(5, 5)) * 2).sum().compute())\n",
        );
        checks.push({
          name: "dask.array computes a bounded result on the same scheduler",
          pass: !array.error && (await value("total")) === "200.0",
          detail: array.error
            ? String(array.error).split("\n").slice(-2).join(" | ")
            : await value("total"),
        });
        if (blindTo(outside)) {
          capabilityAbsent(
            checks,
            notApplicable,
            "worker-request-observation",
            "no external fetch during the Dask start",
            BLIND_REASON,
          );
        } else {
          checks.push({
            name: "nothing was fetched from PyPI, or from anywhere but the fixture origin",
            pass: outside.length === 0,
            detail: JSON.stringify(outside.slice(0, 6)),
          });
        }

        // restart is the same environment
        await page.evaluate(() => window.__py.restart());
        await page.waitForFunction(() => window.__py.state() === "ready", null, {
          timeout: 300000,
        });
        checks.push({
          name: "a restart reapplies the add-on: a clean interpreter with the same scheduler",
          pass:
            (await value("__import__('dask').config.get('scheduler')")) === "'synchronous'" &&
            (await value("'ds' in dir()")) === "False",
          detail: `${await value("__import__('dask').config.get('scheduler')")} ds=${await value("'ds' in dir()")}`,
        });
        checks.push({
          name: "pyodide_http is not imported, let alone patched in, with add-ons active",
          pass: (await value("'pyodide_http' in __import__('sys').modules")) === "False",
        });
      }
    });

    // 2. Cartopy, offline
    await phase("Cartopy add-on, offline", 360_000, async () => {
      const server = await open(
        { profile: "minimal", addons: ["cartopy-natural-earth-110m"], addonBaseURL: "/addons/" },
        { "/addons/": ADDONS },
      );
      const outside = external(page, server);
      const started = await ready(server);
      checks.push({
        name: "the Natural Earth add-on starts on the minimal profile",
        pass: Boolean(started.info) && started.info.addons[0]?.id === "cartopy-natural-earth-110m",
        detail: JSON.stringify(started.error ?? started.info?.addons),
      });
      if (started.info) {
        checks.push({
          name: "preparing it imported neither Cartopy nor Matplotlib",
          pass:
            (await value(
              "[m for m in ('cartopy', 'matplotlib') if m in __import__('sys').modules]",
            )) === "[]",
          detail: await value(
            "[m for m in ('cartopy', 'matplotlib') if m in __import__('sys').modules]",
          ),
        });
        await page.evaluate(() => window.__py.drain());
        const drew = await run(
          [
            "import cartopy.crs as ccrs",
            "import cartopy.feature as feature",
            "import matplotlib.pyplot as plt",
            "",
            "fig = plt.figure(figsize=(10, 5))",
            "ax = plt.axes(projection=ccrs.Robinson())",
            "",
            "ax.coastlines(linewidth=0.4)",
            "ax.add_feature(",
            "    feature.BORDERS,",
            "    linewidth=0.3,",
            "    edgecolor='0.3',",
            ")",
            "",
            "plt.show()",
            "",
          ].join("\n"),
        );
        const shot = await page.evaluate(() => {
          const events = window.__py.events;
          const display = events.filter((e) => e.type === "display");
          return {
            mimes: display.map((e) => e.mime),
            head: display.map((e) => (typeof e.data === "string" ? e.data.slice(0, 12) : "")),
            bytes: display.map((e) => (typeof e.data === "string" ? e.data.length : 0)),
            text: events
              .filter((e) => typeof e.text === "string")
              .map((e) => e.text)
              .join(""),
          };
        });
        checks.push({
          name: "coastlines and country borders render to an image/png payload",
          pass:
            !drew.error &&
            shot.mimes.includes("image/png") &&
            shot.head.some((h) => h.startsWith("iVBORw0KGgo")),
          detail: drew.error
            ? String(drew.error).split("\n").slice(-4).join(" | ")
            : JSON.stringify({ mimes: shot.mimes, bytes: shot.bytes }),
        });
        checks.push({
          name: "no DownloadWarning, no TLS failure and no unrendered figure",
          pass: !/DownloadWarning|TLS not supported|could not be rendered/i.test(shot.text),
          detail: JSON.stringify(shot.text.slice(-300)),
        });
        if (blindTo(outside)) {
          capabilityAbsent(
            checks,
            notApplicable,
            "worker-request-observation",
            "no request to Natural Earth while rendering",
            BLIND_REASON,
          );
        }
        checks.push({
          name: blindTo(outside)
            ? "Cartopy was pointed at the staged data"
            : "Cartopy was pointed at the staged data, and Natural Earth was never asked",
          pass:
            (await value("str(__import__('cartopy').config['pre_existing_data_dir'])")) ===
              "'/freva-addons/cartopy-natural-earth-110m'" &&
            (blindTo(outside) || outside.length === 0),
          detail: JSON.stringify({
            dir: await value("str(__import__('cartopy').config['pre_existing_data_dir'])"),
            outside: outside.slice(0, 6),
          }),
        });
      }
    });

    // 3. Refusals, before Ready
    await phase("refusal: tampered wheel", 180_000, async () => {
      const dir = tampered((at) => {
        const file = join(at, ...DASK_WHEEL.split("/"));
        const bytes = readFileSync(file);
        bytes[bytes.length - 1] ^= 0xff;
        writeFileSync(file, bytes);
      });
      const server = await open(
        { profile: "xarray-zarr", addons: ["dask"], addonBaseURL: "/addons/" },
        { "/addons/": dir },
      );
      const started = await ready(server);
      checks.push({
        name: "a tampered wheel fails the start, before Ready, naming both digests",
        pass:
          !started.info &&
          /not the artefact this build pinned/i.test(started.error ?? "") &&
          /expected sha256/i.test(started.error ?? ""),
        detail: JSON.stringify((started.error ?? "").split("\n").slice(0, 3)),
      });
    });
    await phase("refusal: corrupt Natural Earth file", 180_000, async () => {
      const dir = tampered((at) => {
        writeFileSync(join(at, ...COASTLINE.split("/")), "not a shapefile");
      });
      const server = await open(
        { profile: "minimal", addons: ["cartopy-natural-earth-110m"], addonBaseURL: "/addons/" },
        { "/addons/": dir },
      );
      const started = await ready(server);
      checks.push({
        name: "a corrupt Natural Earth file fails the start rather than falling back to a download",
        pass: !started.info && /not the artefact this build pinned/i.test(started.error ?? ""),
        detail: JSON.stringify((started.error ?? "").split("\n").slice(0, 2)),
      });
    });
    await phase("refusal: missing add-on directory", 180_000, async () => {
      const server = await open(
        { profile: "xarray-zarr", addons: ["dask"], addonBaseURL: "/nowhere/" },
        { "/addons/": ADDONS },
      );
      const started = await ready(server);
      // THE URL, THE STATUS, AND WHAT TO DO. A sentence plus a URL is true and not enough to fix a
      // deployment with, so what is asserted is the whole structured answer - including that
      // pressing Restart requests the same file and gets the same answer.
      const message = started.error ?? "";
      checks.push({
        name: "a missing add-on directory fails the start with the URL, the status and the remedy",
        pass:
          !started.info &&
          /\/nowhere\/dask\//.test(message) &&
          /HTTP 404/.test(message) &&
          /pythonPlayground\.addonBaseUrl/.test(message) &&
          /addonBaseURL in the API/.test(message) &&
          /prepare-addons/.test(message) &&
          /Restarting requests the same URL and gets the same answer/.test(message),
        detail: JSON.stringify(message.split("\n").slice(0, 2)),
      });
    });
    await phase("refusal: add-on the profile cannot carry", 180_000, async () => {
      const server = await open(
        { profile: "minimal", addons: ["dask"], addonBaseURL: "/addons/" },
        { "/addons/": ADDONS },
      );
      const started = await ready(server);
      checks.push({
        name: "an add-on the profile cannot carry is refused by name, not by ModuleNotFoundError",
        pass: !started.info && /does not work with the 'minimal' profile/.test(started.error ?? ""),
        detail: JSON.stringify((started.error ?? "").split("\n").slice(0, 2)),
      });
    });

    // 4. Absence
    await phase("absence: no add-ons configured", 240_000, async () => {
      const server = await open({ profile: "xarray-zarr" }, { "/addons/": ADDONS });
      const outside = external(page, server);
      const started = await ready(server);
      const asked = server.requests.filter((path) => path.startsWith("/addons/"));
      if (blindTo(outside)) {
        capabilityAbsent(
          checks,
          notApplicable,
          "worker-request-observation",
          "no external fetch with no add-ons",
          BLIND_REASON,
        );
      }
      checks.push({
        name: "with no add-ons configured nothing is fetched from the add-on directory",
        pass:
          Boolean(started.info) &&
          started.info.addons.length === 0 &&
          asked.length === 0 &&
          (blindTo(outside) || outside.length === 0),
        detail: JSON.stringify({ addons: started.info?.addons, asked: asked.slice(0, 4) }),
      });
      checks.push({
        name: "and Dask is genuinely absent rather than quietly present",
        pass:
          (await value(
            "__import__('importlib.util', fromlist=['x']).find_spec('dask') is None",
          )) === "True",
        detail: await value(
          "__import__('importlib.util', fromlist=['x']).find_spec('dask') is None",
        ),
      });
    });

    return await finish();
  } catch (error) {
    checks.push(phaseFailureCheck(error));
    return await finish();
  } finally {
    for (const server of servers) {
      await withDeadline(server.close(), 10_000, "closing a fixture server").catch(() => {});
    }
  }
});

process.exit(report("curated add-ons", result));
