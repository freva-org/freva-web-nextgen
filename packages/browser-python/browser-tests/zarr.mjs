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
  fixturePage,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");

requireDist();

requireRuntimeFor("remote Zarr", "zarr.mjs");

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "xarray-zarr" }), {
    // The same fixtures under a bucket-shaped root, so the s3 check below exercises the path-style
    // mapping against a real path rather than a rewrite that happens to resolve.
    roots: { "/waterpark/": FIXTURES },
  });
  const checks = [];
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    const ready = await page.evaluate(() => window.__py.start());
    checks.push({
      name: "the scientific profile reports the versions it actually loaded",
      pass: Boolean(ready.packages.xarray && ready.packages.zarr && ready.packages.fsspec),
      detail: JSON.stringify(ready.packages),
    });

    const value = async (expression) => {
      const r = await page.evaluate((e) => window.__py.push(e), expression);
      if (r.error) throw new Error(r.error);
      return r.result;
    };
    const run = async (code) => {
      const r = await page.evaluate((c) => window.__py.run(c), code);
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

    for (const [format, dir] of [
      ["v2", "zarr-v2"],
      ["v3", "zarr-v3"],
    ]) {
      const opened = await page.evaluate(
        async ({ dir }) => {
          const url = new URL(`/fixtures/${dir}/`, location.href).href;
          const r = await window.__py.run(
            `import xarray as xr\n` +
              `ds_${dir.replace("-", "_")} = xr.open_zarr(${JSON.stringify(url)}, consolidated=True, chunks=None)\n`,
          );
          return r;
        },
        { dir },
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

    // THE WATERPARK CALL, through s3://. Same store, same arguments, reached by the mapping
    // instead of by an absolute URL - so a store a catalogue names as `s3://bucket/key` opens
    // without s3fs, which cannot run here at all.
    const s3Open = await page.evaluate(
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

    // Listing is refused rather than faked. A silent `[]` would read as "this prefix is empty".
    const listing = await page.evaluate(async () => {
      const url = new URL("/fixtures/zarr-v2/", location.href).href;
      return window.__py.run(
        `fs = fsspec.filesystem("https")\n` +
          `import asyncio\n` +
          `try:\n    await fs._ls(${JSON.stringify(url)})\n    _ls_outcome = "returned"\n` +
          `except NotImplementedError as exc:\n    _ls_outcome = "refused"\n`,
      );
    });
    checks.push({
      name: "listing is REFUSED over plain HTTP, not faked as empty",
      pass: !listing.error && (await value("_ls_outcome")) === "'refused'",
      detail: listing.error ? String(listing.error).split("\n").pop() : await value("_ls_outcome"),
    });

    // A missing key is FileNotFoundError, which is what a Zarr probe expects.
    const missing = await page.evaluate(async () => {
      const url = new URL("/fixtures/zarr-v2/definitely-not-here", location.href).href;
      return window.__py.run(
        `try:\n    await fs._cat_file(${JSON.stringify(url)})\n    _missing = "returned"\n` +
          `except FileNotFoundError:\n    _missing = "FileNotFoundError"\n`,
      );
    });
    checks.push({
      name: "a missing key raises FileNotFoundError, so Zarr's probes behave",
      pass: !missing.error && (await value("_missing")) === "'FileNotFoundError'",
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("remote Zarr", result));
