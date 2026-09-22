/**
 * Remote Zarr through the browser's own Fetch, via the ordinary xarray API. The claim under test
 * is narrow and is the whole product: a user types
 * `xr.open_zarr(url, consolidated=True, chunks=None)` and it works, with no Zarrita, no
 * Zarr-Python internals and no JavaScript Zarr library in sight. Both stores are opened by the
 * SAME call, because a user should not have to know whether it is a v2 or a v3 store. The
 * fixtures are local and committed; the real CMIP6 store is a separate optional suite
 * (cmip6.mjs), because a required test depending on a third party's uptime teaches a team to
 * ignore red CI.
 */
import {
  ENGINE,
  NO_JSPI_REMOTE_MESSAGE,
  capabilitiesOf,
  fixturePage,
  unavailableUnlessRequired,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
  terminateEngines,
} from "./harness.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");

requireDist();

requireRuntimeFor("remote Zarr", "zarr.mjs");

const timeoutFromEnv = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of milliseconds.`);
  }
  return value;
};

// Test-only watchdogs. They never enter the built package or the user's Python transcript.
// Startup has its own 180-second engine timeout, so its outer diagnostic deadline is slightly
// longer. Every operation after that is against a tiny same-origin fixture and should settle well
// before the shorter deadline.
const START_TIMEOUT_MS = timeoutFromEnv("ZARR_START_TIMEOUT_MS", 210_000);
const PHASE_TIMEOUT_MS = timeoutFromEnv("ZARR_PHASE_TIMEOUT_MS", 60_000);

class ZarrPhaseTimeout extends Error {
  constructor(phase, timeoutMs) {
    super(`Zarr phase ${JSON.stringify(phase)} did not settle within ${timeoutMs}ms.`);
    this.name = "ZarrPhaseTimeout";
    this.phase = phase;
  }
}

const short = (source) => String(source).replace(/\s+/g, " ").trim().slice(0, 90);

/** Anything the old per-startup and per-command stack-switching warnings would have said. */
const MENTIONS_STACK_SWITCHING = /stack switching|JSPI|callPromising/i;

/** The concise error a remote read without JSPI must produce, and nothing noisier. */
const isConciseNoJspi = (error) =>
  typeof error === "string" &&
  error.includes(NO_JSPI_REMOTE_MESSAGE) &&
  error.includes("https://webkit.org/blog/18325/webkit-features-for-safari-27-0/") &&
  !error.includes("Traceback") &&
  error.split("\n").length <= 4;

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "xarray-zarr" }), {
    // The same fixtures under a bucket-shaped root, so the s3 check below exercises the path-style
    // mapping against a real path rather than a rewrite that happens to resolve.
    roots: { "/waterpark/": FIXTURES },
  });
  const checks = [];
  let unavailable;
  let currentPhase = "create fixture";
  const phase = async (name, work, timeoutMs = PHASE_TIMEOUT_MS) => {
    currentPhase = name;
    const started = Date.now();
    console.log(`[zarr] starting: ${name}`);
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ZarrPhaseTimeout(name, timeoutMs)), timeoutMs);
        }),
      ]);
      console.log(`[zarr] finished: ${name} (${Date.now() - started}ms)`);
      return value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    await phase("open fixture page", () => page.goto(server.url), 30_000);
    await phase(
      "wait for fixture module",
      () => page.waitForFunction(() => window.__ready === true, null, { timeout: 30_000 }),
      35_000,
    );
    const ready = await phase(
      "start xarray-zarr profile",
      () => page.evaluate(() => window.__py.start()),
      START_TIMEOUT_MS,
    );
    checks.push({
      name: "the scientific profile reports the versions it actually loaded",
      pass: Boolean(ready.packages.xarray && ready.packages.zarr && ready.packages.fsspec),
      detail: JSON.stringify(ready.packages),
    });
    // What the WORKER found, in the engine actually running this: never the browser's name.
    const capabilities = capabilitiesOf(ready);
    const startupStderr = await page.evaluate(() =>
      window.__py.events.filter((e) => e.type === "stderr").map((e) => e.text),
    );
    checks.push({
      name: "startup says nothing about stack switching, whichever way the engine answers",
      pass: !startupStderr.some((t) => MENTIONS_STACK_SWITCHING.test(t)),
      detail: JSON.stringify({ jspi: capabilities.jspi, startupStderr }),
    });

    const value = async (expression) => {
      const r = await phase(`evaluate: ${short(expression)}`, () =>
        page.evaluate((e) => window.__py.push(e), expression),
      );
      if (r.error) throw new Error(r.error);
      return r.result;
    };
    const run = async (code) => {
      const r = await phase(`run: ${short(code)}`, () =>
        page.evaluate((c) => window.__py.run(c), code),
      );
      if (r.error) throw new Error(r.error);
      return r;
    };

    // The filesystem must have taken over from fsspec's aiohttp-based one, or every read below
    // fails inside an import rather than at the boundary.
    await run("import fsspec\nimport xarray as xr\n");
    checks.push({
      name: "the browser filesystem is registered for BOTH http and https",
      pass:
        (await value("fsspec.get_filesystem_class('https').__name__")) ===
          "'BrowserHTTPFileSystem'" &&
        (await value("fsspec.get_filesystem_class('http').__name__")) === "'BrowserHTTPFileSystem'",
    });

    // The single most important line in the adapter: fsspec's default would leave `//host/key`.
    checks.push({
      name: "_strip_protocol keeps the whole URL, scheme included",
      pass:
        (await value("fsspec.get_filesystem_class('https')._strip_protocol('https://h/a/b')")) ===
        "'https://h/a/b'",
    });

    if (!capabilities.jspi) {
      // THE FEATURE CANNOT EXIST HERE, and that is reported as what it is - not a pass. What is
      // still checked is what a reader of this engine gets instead: one concise error at the
      // moment a remote store is opened, and an interpreter that carries on.
      unavailable = unavailableUnlessRequired(
        checks,
        "jspi",
        `this ${ENGINE} build's worker has no WebAssembly.Suspending (JSPI), which synchronous ` +
          "remote Zarr reads need",
      );
      const refused = await phase("open Zarr v2 fixture without JSPI", () =>
        page.evaluate(async () => {
          window.__py.drain();
          const url = new URL("/fixtures/zarr-v2/", location.href).href;
          const r = await window.__py.run(
            `import xarray as xr\nxr.open_zarr(${JSON.stringify(url)}, consolidated=True, chunks=None)\n`,
          );
          const stderr = window.__py.drain().filter((e) => e.type === "stderr");
          return { error: r.error ?? null, stderr: stderr.map((e) => e.text) };
        }),
      );
      checks.push({
        name: "without JSPI, opening a remote store fails with the one concise JSPI message",
        pass: isConciseNoJspi(refused.error),
        detail: JSON.stringify(refused.error),
      });
      checks.push({
        name: "…once, with no display-capture warning after it",
        pass:
          refused.stderr.length === 1 && !refused.stderr.some((t) => /display capture/i.test(t)),
        detail: JSON.stringify(refused.stderr),
      });
    }

    for (const [format, dir] of capabilities.jspi
      ? [
          ["v2", "zarr-v2"],
          ["v3", "zarr-v3"],
        ]
      : []) {
      const opened = await phase(`open Zarr ${format} fixture`, () =>
        page.evaluate(
          async ({ dir }) => {
            const url = new URL(`/fixtures/${dir}/`, location.href).href;
            const r = await window.__py.run(
              `import xarray as xr\n` +
                `ds_${dir.replace("-", "_")} = xr.open_zarr(${JSON.stringify(url)}, consolidated=True, chunks=None)\n`,
            );
            return r;
          },
          { dir },
        ),
      );
      const name = dir.replace("-", "_");
      checks.push({
        name: `Zarr ${format}: xr.open_zarr(url, consolidated=True, chunks=None) opens it`,
        pass: !opened.error,
        detail: opened.error ? String(opened.error).split("\n").pop() : "opened",
      });
      if (opened.error) continue;

      checks.push({
        name: `Zarr ${format}: the data variables are there`,
        pass: (await value(`list(ds_${name}.data_vars)`)) === "['sfcWind']",
        detail: await value(`list(ds_${name}.data_vars)`),
      });
      checks.push({
        name: `Zarr ${format}: dimensions and coordinates survived the round trip`,
        pass: (await value(`ds_${name}.sfcWind.shape`)) === "(4, 5, 6)",
        detail: await value(`dict(ds_${name}.sizes)`),
      });
      // The EXACT numbers the fixture was generated from. `mean() > 0` passes for a wrong chunk, a
      // mis-decompressed chunk, a chunk from a different variable and a chunk read at the wrong
      // offset - it proves the pipeline returned floats, not the right floats. These four are
      // `np.random.default_rng(20260904).normal(8.0, 1.5, (4,5,6))` as float32; see
      // `scripts/make-zarr-fixtures.py`.
      checks.push({
        name: `Zarr ${format}: the decoded values are exactly the fixture's`,
        pass:
          (await value(`round(float(ds_${name}.sfcWind[0, 0, 0].values), 5)`)) === "10.27689" &&
          (await value(`round(float(ds_${name}.sfcWind[3, 4, 5].values), 5)`)) === "7.71434" &&
          (await value(`round(float(ds_${name}.sfcWind.sum().values), 3)`)) === "954.911",
        detail: await value(
          `[round(float(ds_${name}.sfcWind[0, 0, 0].values), 5), ` +
            `round(float(ds_${name}.sfcWind[3, 4, 5].values), 5), ` +
            `round(float(ds_${name}.sfcWind.sum().values), 3)]`,
        ),
      });
      checks.push({
        name: `Zarr ${format}: the coordinates decode exactly too`,
        pass:
          (await value(`[float(v) for v in ds_${name}.lat.values]`)) ===
          "[-60.0, -30.0, 0.0, 30.0, 60.0]",
        detail: await value(`[float(v) for v in ds_${name}.lat.values]`),
      });
      checks.push({
        name: `Zarr ${format}: attributes came through`,
        pass: (await value(`ds_${name}.sfcWind.attrs["units"]`)) === "'m s-1'",
      });
    }

    // What the store actually did. In an unsharded store every chunk IS its own object, so one
    // whole-object GET per chunk is the correct access pattern and there are no range requests to
    // look for; the range machinery is exercised by `browser-tests/http-adapter.mjs` and
    // `fsspec-adapter.mjs`, against recorded headers. So this asserts the property that matters
    // here: each key fetched once, nothing outside the store touched, every response a 200.
    if (capabilities.jspi) {
      const fixtureCalls = server.exchanges.filter((e) => e.path.startsWith("/fixtures/"));
      const chunkCalls = fixtureCalls.filter((e) => /\/(sfcWind|time|lat|lon)\//.test(e.path));
      checks.push({
        name: "each chunk is fetched as its own whole object, with a GET answered 200",
        pass:
          chunkCalls.length > 4 &&
          fixtureCalls.every((e) => e.method === "GET" && e.status === 200) &&
          fixtureCalls.every((e) => e.range === null),
        // Nothing is asserted about caching: this adapter makes no such promise, and xarray reads
        // lazily, so the same chunk is legitimately fetched again for a second access.
        detail: JSON.stringify({
          chunks: chunkCalls.length,
          total: fixtureCalls.length,
          statuses: [...new Set(fixtureCalls.map((e) => e.status))],
          ranged: fixtureCalls.filter((e) => e.range !== null).length,
        }),
      });
    }

    // THE WATERPARK CALL, through s3://. Same store, same arguments, reached by the mapping
    // instead of by an absolute URL - so a store a catalogue names as `s3://bucket/key` opens
    // without s3fs, which cannot run here at all.
    if (capabilities.jspi) {
      const s3Open = await phase("open the Zarr v2 fixture through s3 mapping", () =>
        page.evaluate(
          async ({ origin }) => {
            return window.__py.run(
              `import xarray as xr\n` +
                `ds_s3 = xr.open_zarr(\n` +
                `    "s3://waterpark/zarr-v2",\n` +
                `    consolidated=True,\n` +
                `    chunks=None,\n` +
                `    storage_options={"anon": True, "endpoint_url": ${JSON.stringify(origin)}},\n` +
                `)\n`,
            );
          },
          { origin: server.url.replace(/\/$/, "") },
        ),
      );
      checks.push({
        name: "s3://bucket/key opens with anon=True and an endpoint_url, no s3fs",
        pass: !s3Open.error,
        detail: s3Open.error ? String(s3Open.error).split("\n").pop() : "opened",
      });
      if (!s3Open.error) {
        checks.push({
          name: "…and it is the same dataset the https:// URL gives",
          pass: (await value("list(ds_s3.data_vars)")) === "['sfcWind']",
          detail: await value("list(ds_s3.data_vars)"),
        });
        checks.push({
          name: "…with the same values, read through the mapped keys",
          pass:
            (await value("float(ds_s3.sfcWind.isel(time=0, lat=0, lon=0).values)")) ===
            (await value("float(ds_zarr_v2.sfcWind.isel(time=0, lat=0, lon=0).values)")),
          detail: await value("float(ds_s3.sfcWind.isel(time=0, lat=0, lon=0).values)"),
        });
      }
    }

    // Listing is refused rather than faked. A silent `[]` would read as "this prefix is empty".
    // Awaited reads - no JSPI involved - so these run in every engine.
    const listing = await phase("refuse HTTP listing", () =>
      page.evaluate(async () => {
        const url = new URL("/fixtures/zarr-v2/", location.href).href;
        return window.__py.run(
          `fs = fsspec.filesystem("https")\n` +
            `import asyncio\n` +
            `try:\n    await fs._ls(${JSON.stringify(url)})\n    _ls_outcome = "returned"\n` +
            `except NotImplementedError as exc:\n    _ls_outcome = "refused"\n`,
        );
      }),
    );
    checks.push({
      name: "listing is REFUSED over plain HTTP, not faked as empty",
      pass: !listing.error && (await value("_ls_outcome")) === "'refused'",
      detail: listing.error ? String(listing.error).split("\n").pop() : await value("_ls_outcome"),
    });

    // A missing key is FileNotFoundError, which is what a Zarr probe expects.
    const missing = await phase("probe a missing Zarr key", () =>
      page.evaluate(async () => {
        const url = new URL("/fixtures/zarr-v2/definitely-not-here", location.href).href;
        return window.__py.run(
          `try:\n    await fs._cat_file(${JSON.stringify(url)})\n    _missing = "returned"\n` +
            `except FileNotFoundError:\n    _missing = "FileNotFoundError"\n`,
        );
      }),
    );
    checks.push({
      name: "a missing key raises FileNotFoundError, so Zarr's probes behave",
      pass: !missing.error && (await value("_missing")) === "'FileNotFoundError'",
    });

    const everyStderr = await page.evaluate(() =>
      window.__py.events.filter((e) => e.type === "stderr").map((e) => e.text),
    );
    if (capabilities.jspi) {
      checks.push({
        name: "with JSPI, no command printed anything about stack switching",
        pass: !everyStderr.some((t) => MENTIONS_STACK_SWITCHING.test(t)),
        detail: JSON.stringify(everyStderr.slice(-3)),
      });
    }

    // ------------------------------------------------------------------ JSPI removed, always
    // The no-JSPI behaviour in EVERY engine, whatever this build has: the capability is removed
    // from a worker before it loads (`test-worker/no-jspi.mjs`), through the public `workerURL`.
    await page.evaluate(() => window.__py?.engine.dispose()).catch(() => undefined);
    const withoutJspi = await serve(
      fixturePage({ profile: "xarray-zarr", workerURL: "/test-worker/no-jspi.mjs" }),
    );
    try {
      await phase("open the no-JSPI fixture page", () => page.goto(withoutJspi.url), 30_000);
      await phase(
        "wait for the no-JSPI fixture module",
        () => page.waitForFunction(() => window.__ready === true, null, { timeout: 30_000 }),
        35_000,
      );
      const seamReady = await phase(
        "start xarray-zarr without JSPI",
        () => page.evaluate(() => window.__py.start()),
        START_TIMEOUT_MS,
      );
      const seamStartup = await page.evaluate(() =>
        window.__py
          .drain()
          .filter((e) => e.type === "stderr")
          .map((e) => e.text),
      );
      checks.push({
        name: "without JSPI: xarray-zarr starts, reports jspi: false and warns about nothing",
        pass:
          seamReady.jspi === false && !seamStartup.some((t) => MENTIONS_STACK_SWITCHING.test(t)),
        detail: JSON.stringify({ jspi: seamReady.jspi, stderr: seamStartup }),
      });
      const local = await phase("local xarray without JSPI", () =>
        page.evaluate(async () => {
          window.__py.drain();
          const r = await window.__py.run(
            "import numpy as np\nimport xarray as xr\n" +
              "ds = xr.Dataset({'a': ('x', np.arange(4.0))})\n" +
              "print(float(ds.a.mean()), ds.a.sizes['x'])\n",
          );
          const events = window.__py.drain();
          return {
            error: r.error ?? null,
            stdout: events
              .filter((e) => e.type === "stdout")
              .map((e) => e.text)
              .join(""),
            stderr: events.filter((e) => e.type === "stderr").map((e) => e.text),
          };
        }),
      );
      checks.push({
        name: "without JSPI: NumPy and xarray on local data work, with nothing on stderr",
        pass: local.error === null && local.stdout === "1.5 4\n" && local.stderr.length === 0,
        detail: JSON.stringify(local),
      });
      const remote = await phase("open a remote store without JSPI", () =>
        page.evaluate(async () => {
          window.__py.drain();
          const url = new URL("/fixtures/zarr-v3/", location.href).href;
          const r = await window.__py.push(
            `xr.open_zarr(${JSON.stringify(url)}, consolidated=True, chunks=None)`,
          );
          const events = window.__py.drain();
          return {
            error: r.error ?? null,
            stderr: events.filter((e) => e.type === "stderr").map((e) => e.text),
          };
        }),
      );
      checks.push({
        name: "without JSPI: a typed xr.open_zarr(<remote>) gives the concise JSPI message",
        pass: isConciseNoJspi(remote.error),
        detail: JSON.stringify(remote.error),
      });
      checks.push({
        name: "…printed once, with no display-capture warning appended",
        pass: remote.stderr.length === 1 && !remote.stderr.some((t) => /display capture/i.test(t)),
        detail: JSON.stringify(remote.stderr),
      });
      const after = await phase("carry on after the refusal", () =>
        page.evaluate(() => window.__py.push("float(ds.a.sum())")),
      );
      checks.push({
        name: "without JSPI: the session carries on after the refusal",
        pass: after.result === "6.0" && !after.error,
        detail: JSON.stringify(after),
      });
    } finally {
      await withoutJspi.close();
    }

    return { checks, unavailable };
  } catch (error) {
    const engine = await Promise.race([
      page
        .evaluate(() => ({
          state: window.__py?.state?.() ?? null,
          statuses: window.__py?.statuses?.slice(-5) ?? [],
        }))
        .catch((snapshotError) => ({
          snapshotError: String(snapshotError?.message ?? snapshotError),
        })),
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ snapshotError: "engine snapshot did not settle within 2s" }),
          2000,
        ),
      ),
    ]);
    checks.push({
      name: `the Zarr phase completed: ${currentPhase}`,
      pass: false,
      detail: JSON.stringify({
        error: String(error?.message ?? error).split("\n")[0],
        engine,
        lastRequests: server.requests.slice(-12),
        lastExchanges: server.exchanges.slice(-12),
      }),
    });
    if (error instanceof ZarrPhaseTimeout) {
      // End the operation whose Promise lost the race. This is test cleanup, not a user-facing
      // execution timeout: terminating the worker is the only reliable way to stop arbitrary
      // Python. Bounded, and escalating to closing the context if the page does not answer, so
      // the losing evaluate() cannot live on; the engine's normal teardown remains idempotent.
      await terminateEngines(page);
    }
    return { checks, unavailable };
  } finally {
    await server.close();
  }
});

process.exit(report("remote Zarr", result));
