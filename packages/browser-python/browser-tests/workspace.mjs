/**
 * Real Python file output, end to end through the public API.
 *
 *     node browser-tests/workspace.mjs
 *
 * Failure paths live in `workspace-errors.mjs`. Here a visitor writes files the way they actually
 * write them - `to_netcdf`, `to_parquet`, `savefig`, `zipfile`, `np.save` - then previews,
 * downloads and deletes them through `engine.artifacts()`, `readArtifact()`, `deleteArtifact()`
 * and the `onArtifacts` events, because those are what a UI has. The formats are not decoration:
 * netCDF4 seeks backwards to rewrite a header, Parquet rewrites its footer, matplotlib writes
 * through a Python buffer, zipfile seeks to patch its central directory. A filesystem that only
 * supports `write()` from position zero passes a CSV test and nothing else.
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

requireRuntimeFor("the workspace, with real file formats", "workspace.mjs");

/**
 * One snippet per format, run separately, so the first library that cannot be loaded on this
 * runtime does not hide every format after it - as one block, a pyarrow/pandas incompatibility
 * reported itself as "no NetCDF artifact". Each entry fails on its own terms and names itself.
 */
const PREAMBLE = `
import json, os
import numpy as np
import pandas as pd

frame = pd.DataFrame({"time": range(24), "tas": np.linspace(280.0, 295.0, 24)})
`;

const WRITERS = {
  "timeseries.csv": ['frame.to_csv("timeseries.csv", index=False)', "text/csv"],
  "timeseries.parquet": [
    // `DataFrame.to_parquet`, which is what the README advertises and what anybody writing a
    // dataframe actually types; calling `pyarrow.parquet.write_table` directly would dodge the one
    // call the documentation promises. The explicit `import pyarrow` is not decoration either:
    // pandas finds its Parquet engine through an optional-dependency import and nothing here
    // auto-loads a wheel on a failed import, so without it pandas reports the absence of a
    // DIFFERENT engine - "Import fastparquet failed" - which names neither pyarrow nor the reason.
    'frame.to_parquet("timeseries.parquet")',
    "application/vnd.apache.parquet",
  ],
  "grid.npy": [
    'np.save("grid.npy", np.arange(64, dtype="float32").reshape(8, 8))',
    "application/x-npy",
  ],
  "surface_air_temperature.nc": [
    [
      "import netCDF4",
      "import xarray as xr",
      "ds = xr.Dataset(",
      '    {"tas": (("time", "lat"), np.random.default_rng(0).normal(285, 3, (12, 8)).astype("float32"))},',
      '    coords={"time": pd.date_range("2026-01-01", periods=12, freq="MS"), "lat": np.arange(8.0)},',
      ")",
      'ds.attrs["title"] = "browser workspace test"',
      'ds.to_netcdf("surface_air_temperature.nc")',
    ].join("\n"),
    "application/x-netcdf",
  ],
  "trend.png": [
    [
      "import matplotlib",
      'matplotlib.use("Agg")',
      "import matplotlib.pyplot as plt",
      "fig, ax = plt.subplots(figsize=(3, 2), dpi=80)",
      'ax.plot(frame["time"], frame["tas"])',
      'fig.savefig("trend.png")',
      "plt.close(fig)",
    ].join("\n"),
    "image/png",
  ],
  "swatch.jpg": [
    [
      "from PIL import Image",
      'Image.fromarray(np.random.default_rng(1).integers(0, 255, (16, 16, 3), dtype="uint8")).save("swatch.jpg", quality=80)',
    ].join("\n"),
    "image/jpeg",
  ],
  "blink.gif": [
    [
      "from PIL import Image",
      'Image.fromarray(np.zeros((8, 8), dtype="uint8")).save("blink.gif")',
    ].join("\n"),
    "image/gif",
  ],
  // A real RIFF/WAVE file, so an <audio> preview could actually play it.
  "tone.wav": [
    [
      "import wave",
      'with wave.open("tone.wav", "wb") as wav:',
      "    wav.setnchannels(1)",
      "    wav.setsampwidth(2)",
      "    wav.setframerate(8000)",
      '    wav.writeframes((np.sin(np.arange(4000) * 0.2) * 12000).astype("<i2").tobytes())',
    ].join("\n"),
    "audio/wav",
  ],
  // The smallest video container that is still a real one: a WebM/Matroska EBML header. Nothing
  // here decodes it - what is being asserted is that arbitrary binary survives and is typed.
  "clip.webm": [
    [
      'with open("clip.webm", "wb") as fh:',
      '    fh.write(bytes([0x1A, 0x45, 0xDF, 0xA3]) + b"\\x01" * 512)',
    ].join("\n"),
    "video/webm",
  ],
  // zipfile seeks back to patch its central directory - a filesystem that cannot seek fails here.
  "bundle.zip": [
    [
      "import zipfile",
      'with zipfile.ZipFile("bundle.zip", "w", zipfile.ZIP_DEFLATED) as zf:',
      '    zf.write("timeseries.csv")',
      '    zf.writestr("note.txt", "written in the browser")',
    ].join("\n"),
    "application/zip",
  ],
  // Something with no format at all.
  "opaque.bin": [
    ['with open("opaque.bin", "wb") as fh:', "    fh.write(bytes(range(256)) * 4)"].join("\n"),
    "application/octet-stream",
  ],
};

/** Overwrite, append, seek, truncate - separately, so a failure names which one. */
const MUTATIONS = `
import json, os

with open("mutate.txt", "w") as fh:
    fh.write("original-content")
first = open("mutate.txt").read()

with open("mutate.txt", "w") as fh:          # overwrite: the file must SHRINK
    fh.write("short")
overwritten = open("mutate.txt").read()

with open("mutate.txt", "a") as fh:          # append
    fh.write("+more")
appended = open("mutate.txt").read()

with open("mutate.txt", "r+b") as fh:        # seek backwards and rewrite in place
    fh.seek(0)
    fh.write(b"SHORT")
    fh.seek(0, os.SEEK_END)
    at_end = fh.tell()
seeked = open("mutate.txt").read()

with open("mutate.txt", "r+b") as fh:        # truncate
    fh.truncate(5)
truncated = open("mutate.txt").read()

print(json.dumps({
    "first": first,
    "overwritten": overwritten,
    "appended": appended,
    "seeked": seeked,
    "at_end": at_end,
    "truncated": truncated,
    "size": os.path.getsize("mutate.txt"),
}))
`;

const result = await inBrowser(async (page) => {
  // `pyarrow` is requested at STARTUP rather than imported when it is needed: pandas registers its
  // Arrow extension types when PANDAS is imported, and only if pyarrow is already loadable. Load it
  // afterwards and `to_parquet` fails with `ArrowKeyError: No type extension with name
  // arrow.py_extension_type found`, naming neither pandas, nor pyarrow, nor the ordering. Measured
  // with pandas 3.0.2 and pyarrow 22.0.0; the README says the same where a reader will meet it.
  const server = await serve(
    fixturePage({ profile: "xarray-zarr", packages: ["pyarrow"], workspaceMaxFiles: 24 }),
  );
  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__py !== undefined, null, { timeout: 20000 });
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 240000 });

    // the workspace is real, and says so
    const status = await page.evaluate(() => window.__py.workspace());
    ok(
      "start() reports a disk-backed workspace, mounted at /workspace",
      status?.available === true && status.path === "/workspace" && status.maxFiles === 24,
      JSON.stringify(status),
    );
    const cwd = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.run("import os\nprint(os.getcwd())\n");
      return window.__py.text("stdout").trim();
    });
    ok("…and it is the interpreter's working directory", cwd === "/workspace", cwd);

    // the formats
    const written = await page.evaluate(
      async ({ preamble, writers }) => {
        window.__py.drainArtifactEvents();
        const out = {};
        await window.__py.run(preamble);
        for (const [name, [code]] of Object.entries(writers)) {
          out[name] = await window.__py.run(code);
        }
        return {
          out,
          artifacts: await window.__py.artifacts(),
          events: window.__py.artifactEvents,
        };
      },
      { preamble: PREAMBLE, writers: WRITERS },
    );

    const byName = new Map((written.artifacts ?? []).map((a) => [a.name, a]));
    for (const [name, [, mime]] of Object.entries(WRITERS)) {
      const info = byName.get(name);
      const failure = written.out[name]?.error;
      ok(
        `${name} is a ready artifact, sized and typed`,
        !failure && info?.state === "ready" && info.size > 0 && info.mime === mime,
        failure
          ? String(failure).split("\n").filter(Boolean).pop()
          : JSON.stringify(info ?? { missing: name }),
      );
    }

    ok(
      "the artifacts were announced without anyone asking - ordinary output is DETECTED",
      written.events.some((e) => e.added.includes("surface_air_temperature.nc")) &&
        written.events.some((e) => typeof e.executionId === "string"),
      JSON.stringify(
        written.events.map((e) => ({ added: e.added, exec: e.executionId })).slice(0, 4),
      ),
    );

    // the bytes survive the round trip
    const netcdf = await page.evaluate(() =>
      window.__py.readArtifact("surface_air_temperature.nc"),
    );
    ok(
      "the NetCDF download is a Blob behind a blob: URL, and starts with a netCDF/HDF5 signature",
      netcdf.isBlob &&
        netcdf.isBlobUrl &&
        netcdf.blobBytes === netcdf.size &&
        (netcdf.head.startsWith("CDF") ||
          netcdf.headBytes.slice(0, 4).join(",") === "137,72,68,70"),
      JSON.stringify({ size: netcdf.size, headBytes: netcdf.headBytes }),
    );

    const png = await page.evaluate(() => window.__py.readArtifact("trend.png"));
    ok(
      "the PNG download carries a real PNG signature",
      png.headBytes.slice(0, 4).join(",") === "137,80,78,71",
      JSON.stringify({ size: png.size, headBytes: png.headBytes }),
    );

    const zip = await page.evaluate(() => window.__py.readArtifact("bundle.zip"));
    ok(
      "the ZIP download starts with PK - so the central directory seek worked",
      zip.head.startsWith("PK"),
      JSON.stringify({ size: zip.size, head: JSON.stringify(zip.head.slice(0, 4)) }),
    );

    const csv = await page.evaluate(() => window.__py.readArtifactText("timeseries.csv"));
    ok(
      "a CSV comes back as exactly the text pandas wrote",
      csv.startsWith("time,tas\n0,280.0\n") && csv.trimEnd().split("\n").length === 25,
      JSON.stringify(csv.slice(0, 40)),
    );

    // Python can read its own files back
    const roundTrip = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.run(
        [
          "import xarray as xr, numpy as np, zipfile",
          "import pyarrow.parquet as pq",
          "back = xr.open_dataset('surface_air_temperature.nc')",
          "print('title:', back.attrs['title'], 'shape:', back['tas'].shape)",
          "back.close()",
          "print('parquet:', pq.read_table('timeseries.parquet').shape)",
          "print('npy:', np.load('grid.npy').sum())",
          "print('zip:', zipfile.ZipFile('bundle.zip').read('note.txt').decode())",
          "",
        ].join("\n"),
      );
      return { r, out: window.__py.text("stdout") };
    });
    ok(
      "…and Python reads every one of them back, through the same filesystem",
      !roundTrip.r.error &&
        roundTrip.out.includes("title: browser workspace test") &&
        roundTrip.out.includes("shape: (12, 8)") &&
        roundTrip.out.includes("parquet: (24, 2)") &&
        roundTrip.out.includes("npy: 2016.0") &&
        roundTrip.out.includes("zip: written in the browser"),
      roundTrip.r.error ? String(roundTrip.r.error).split("\n").pop() : roundTrip.out.trim(),
    );

    // overwrite, append, seek, truncate
    const mutated = await page.evaluate(async (code) => {
      window.__py.drain();
      const r = await window.__py.run(code);
      return { r, out: window.__py.text("stdout").trim().split("\n").pop() };
    }, MUTATIONS);
    // Read from stdout rather than from `result`: an expression statement's value comes back as
    // Python's `repr()`, and `repr` of a JSON string is single-quoted, which is not JSON.
    const m = mutated.r.error ? null : JSON.parse(mutated.out);
    ok(
      "overwriting a file SHRINKS it - no leftover tail from the longer content",
      m?.overwritten === "short",
      JSON.stringify(m),
    );
    ok("appending extends it", m?.appended === "short+more", m?.appended);
    ok(
      "seeking backwards rewrites in place, and SEEK_END still finds the real end",
      m?.seeked === "SHORT+more" && m?.at_end === 10,
      JSON.stringify({ seeked: m?.seeked, at_end: m?.at_end }),
    );
    ok(
      "truncate cuts it, and the reported size agrees",
      m?.truncated === "SHORT" && m?.size === 5,
      JSON.stringify({ truncated: m?.truncated, size: m?.size }),
    );

    // preview and repeated download
    const preview = await page.evaluate(() =>
      window.__py.readArtifact("opaque.bin", { maxBytes: 64 }),
    );
    ok(
      "a preview is capped, and still reports the artifact's REAL size",
      preview.blobBytes === 64 && preview.size === 1024 && preview.truncated === true,
      JSON.stringify(preview),
    );

    const twice = await page.evaluate(async () => {
      const a = await window.__py.readArtifact("bundle.zip");
      const b = await window.__py.readArtifact("bundle.zip");
      return { a: a.sha256, b: b.sha256, size: a.size };
    });
    ok(
      "downloading the same artifact twice gives identical bytes - reading does not consume it",
      twice.a === twice.b && twice.size > 0,
      JSON.stringify(twice),
    );
    const afterDownload = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.run(
        "import zipfile\nprint(len(zipfile.ZipFile('bundle.zip').namelist()))\n",
      );
      return { r, out: window.__py.text("stdout").trim().split("\n").pop() };
    });
    ok(
      "…and Python can still use the file afterwards: the download did not steal its handle",
      !afterDownload.r.error && afterDownload.out === "2",
      afterDownload.r.error ? String(afterDownload.r.error).split("\n").pop() : afterDownload.out,
    );

    // delete, and slot reuse
    const deleted = await page.evaluate(async () => {
      window.__py.drain();
      window.__py.drainArtifactEvents();
      await window.__py.deleteArtifact("opaque.bin");
      const events = window.__py.drainArtifactEvents();
      const seen = await window.__py.run("import os\nprint(os.path.exists('opaque.bin'))\n");
      return { events, seen, out: window.__py.text("stdout").trim().split("\n").pop() };
    });
    ok(
      "deleting an artifact removes it, announces the removal, and Python agrees it is gone",
      deleted.events.some((e) => e.removed.includes("opaque.bin")) && deleted.out === "False",
      JSON.stringify({ removed: deleted.events.map((e) => e.removed), python: deleted.out }),
    );

    const reused = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.run(
        `import os
for i in range(40):
    with open(f"scratch_{i}.bin", "wb") as fh:
        fh.write(b"x" * 32)
    os.remove(f"scratch_{i}.bin")
print("survived")
`,
      );
      return { r, out: window.__py.text("stdout").trim().split("\n").pop() };
    });
    ok(
      "40 files written and removed through a 24-file workspace: the bound is on RETAINED files",
      !reused.r.error && reused.out === "survived",
      reused.r.error ? String(reused.r.error).split("\n").pop() : reused.out,
    );

    // something genuinely large, on disk
    const big = await page.evaluate(async () => {
      const r = await window.__py.run(
        `with open("large.bin", "wb") as fh:
    for _ in range(48):
        fh.write(b"L" * 1024 * 1024)
`,
      );
      const artifacts = await window.__py.artifacts();
      return { r, info: artifacts.find((a) => a.name === "large.bin") ?? null };
    });
    ok(
      "48 MiB is written to disk and reported at its full size",
      !big.r.error && big.info?.size === 48 * 1024 * 1024 && big.info.state === "ready",
      big.r.error ? String(big.r.error).split("\n").pop() : JSON.stringify(big.info),
    );

    // the file limit
    const limit = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.run(
        `for i in range(200):
    open(f"many_{i}.bin", "wb").close()
`,
      );
      return { r, stderr: window.__py.text("stderr") };
    });
    ok(
      "exceeding the file limit raises, and the traceback is followed by an explanation",
      Boolean(limit.r.error) &&
        limit.r.error.includes("[Errno 33]") &&
        limit.stderr.includes("holds at most 24 files at once"),
      (limit.r.error ?? "").split("\n").pop(),
    );

    // restart is a clean slate
    const restarted = await page.evaluate(async () => {
      const before = window.__py.workspace();
      window.__py.drainArtifactEvents();
      await window.__py.restart();
      const after = window.__py.workspace();
      const empty = await window.__py.artifacts();
      const r = await window.__py.run(
        "with open('fresh.txt', 'w') as fh:\n    fh.write('after restart')\n",
      );
      return {
        beforeSession: before?.sessionId,
        afterSession: after?.sessionId,
        available: after?.available,
        empty,
        artifacts: await window.__py.artifacts(),
        r,
        text: await window.__py.readArtifactText("fresh.txt"),
      };
    });
    ok(
      "a restart gets a NEW workspace session, empty, and working",
      restarted.available === true &&
        restarted.beforeSession !== restarted.afterSession &&
        restarted.empty.length === 0 &&
        restarted.artifacts.map((a) => a.name).join(",") === "fresh.txt" &&
        restarted.text === "after restart",
      JSON.stringify({
        before: restarted.beforeSession,
        after: restarted.afterSession,
        empty: restarted.empty.length,
        names: restarted.artifacts.map((a) => a.name),
      }),
    );

    // two tabs, one origin, exclusive locks
    const second = await page.context().newPage();
    try {
      await second.goto(server.url);
      await second.waitForFunction(() => window.__py !== undefined, null, { timeout: 20000 });
      await second.evaluate(() => window.__py.start());
      await second.waitForFunction(() => window.__py.state() === "ready", null, {
        timeout: 240000,
      });
      const two = await second.evaluate(async () => {
        const r = await window.__py.run(
          "with open('other-tab.txt', 'w') as fh:\n    fh.write('second tab')\n",
        );
        return { status: window.__py.workspace(), r, artifacts: await window.__py.artifacts() };
      });
      ok(
        "a second tab on the same origin gets its own workspace and writes into it",
        two.status?.available === true &&
          two.status.sessionId !== restarted.afterSession &&
          !two.r.error &&
          two.artifacts.map((a) => a.name).includes("other-tab.txt"),
        JSON.stringify({ session: two.status?.sessionId, names: two.artifacts.map((a) => a.name) }),
      );
      const firstStillWorks = await page.evaluate(async () => {
        const r = await window.__py.run(
          "with open('still-here.txt', 'w') as fh:\n    fh.write('first tab')\n",
        );
        return { r, artifacts: await window.__py.artifacts() };
      });
      ok(
        "…and the first tab is untouched by it - neither session sees the other's files",
        !firstStillWorks.r.error &&
          firstStillWorks.artifacts
            .map((a) => a.name)
            .sort()
            .join(",") === "fresh.txt,still-here.txt",
        JSON.stringify(firstStillWorks.artifacts.map((a) => a.name)),
      );
    } finally {
      await second.close();
    }

    return checks;
  } catch (error) {
    // Keep what was proved before the throw. A suite that reports "0/0 checks" because its
    // fourteenth step threw has hidden the thirteen answers it already had.
    ok("the suite ran to the end", false, String(error?.message ?? error).split("\n")[0]);
    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("the workspace, with real file formats", result));
