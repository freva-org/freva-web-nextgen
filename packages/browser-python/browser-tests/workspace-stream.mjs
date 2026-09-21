/**
 * Getting a large artifact out, without it ever existing twice.
 *
 *     node browser-tests/workspace-stream.mjs
 *     STREAM_MIB=512 node browser-tests/workspace-stream.mjs
 *
 * Reading the artifact in 4 MiB chunks and concatenating them into one `Blob` keeps the WASM
 * heap flat - the thing a naive test measures - and still turns a 2 GiB export into 2 GiB of
 * browser-managed storage before a byte reaches disk. So what is asserted is:
 *
 *   - the bytes that arrive are EXACTLY the bytes Python wrote, compared by digest;
 *   - no more than a couple of chunks are alive at any moment, whatever the file's size;
 *   - a cancelled transfer aborts its destination rather than closing it;
 *   - a destination that fails takes the transfer down with it and leaves nothing frozen;
 *   - the artifact cannot be deleted, renamed or written while it is being read;
 *   - and the lease is released on every one of those paths.
 *
 * The digest is a rolling SHA-256 computed identically in Python and in the sink.
 */
import { bundleConsole, fixturePage, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();
bundleConsole();

/** Big enough to need many chunks and to be absurd as a Blob; small enough to run in CI. */
const MIB = Number(process.env.STREAM_MIB ?? 96);

/**
 * Write a file of known content, and hash it THE SAME WAY the sink does. A rolling hash rather
 * than one digest over the whole file, because the sink cannot hold the whole file - that is the
 * point of it.
 */
const WRITE_AND_HASH = `
import hashlib, json

MiB = 1024 * 1024
CHUNK = 4 * MiB
target = ${MIB}

payload = bytes((i * 7 + 11) % 256 for i in range(MiB))

with open("export.bin", "wb") as fh:
    for _ in range(target):
        fh.write(payload)

rolling = b"\\x00" * 32
with open("export.bin", "rb") as fh:
    while True:
        block = fh.read(CHUNK)
        if not block:
            break
        rolling = hashlib.sha256(rolling + block).digest()

print(json.dumps({"size": target * MiB, "sha256": rolling.hex()}))
`;

// Performance Manager instrumentation is a Blink runtime feature that Chrome for Testing does not
// enable by default. The suite refuses to turn a missing measurement into a pass, so enable it.
const inMemoryMeasuredBrowser = (body) =>
  inBrowser(body, {
    chromiumArgs: ["--enable-blink-features=PerformanceManagerInstrumentation"],
  });

const result = await inMemoryMeasuredBrowser(async (page) => {
  // Cross-origin isolated ON PURPOSE: `performance.measureUserAgentSpecificMemory()` refuses to
  // answer without it, and that call is the only honest way to see ArrayBuffer memory from inside
  // a browser. The engine needs nothing from these headers - everything it loads is same-origin -
  // so this changes what can be MEASURED, not what is tested.
  const server = await serve(fixturePage({ profile: "minimal", workspaceMaxFiles: 8 }), {
    headers: {
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    },
    // The worker script too: a dedicated Worker created by an isolated document must carry a
    // compatible COEP header of its own, or it is refused before it runs a line.
    assetHeaders: { "cross-origin-embedder-policy": "require-corp" },
  });
  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__py !== undefined, null, { timeout: 20000 });
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 240000 });

    const written = await page.evaluate(async (code) => {
      window.__py.drain();
      const r = await window.__py.run(code);
      return { r, out: window.__py.text("stdout").trim().split("\n").pop() };
    }, WRITE_AND_HASH);
    if (written.r.error) {
      ok(`writing ${MIB} MiB succeeded`, false, String(written.r.error).split("\n").pop());
      return checks;
    }
    const source = JSON.parse(written.out);
    ok(
      `Python wrote ${MIB} MiB to the workspace and hashed it`,
      source.size === MIB * 1024 * 1024 && /^[0-9a-f]{64}$/.test(source.sha256),
      JSON.stringify(source),
    );

    // ------ the whole file, streamed
    const streamed = await page.evaluate(
      (options) => window.__py.streamArtifact("export.bin", options),
      {
        chunkBytes: 4 * 1024 * 1024,
        windowChunks: 2,
        // Stop in the middle and ask the browser how much memory is in use. See the harness.
        measureAtBytes: Math.floor((MIB * 1024 * 1024) / 2),
      },
    );

    // The measurement that would catch a whole-file Blob. `peakLive` below is the sink's own
    // bookkeeping and a Blob implementation reports the same small number while 2 GiB sits in
    // browser-managed storage. This is the browser's own answer, taken with half the file
    // delivered, across the whole agent cluster including the worker.
    if (streamed.memoryDuring != null && streamed.memoryBefore != null) {
      const growth = streamed.memoryDuring - streamed.memoryBefore;
      ok(
        `memory in use with half of ${MIB} MiB delivered is within a few chunks of the baseline`,
        growth < 32 * 1024 * 1024,
        JSON.stringify({
          fileMiB: MIB,
          measuredAtMiB: +(streamed.measuredAtBytes / 1048576).toFixed(1),
          beforeMiB: +(streamed.memoryBefore / 1048576).toFixed(1),
          duringMiB: +(streamed.memoryDuring / 1048576).toFixed(1),
          afterMiB:
            streamed.memoryAfter == null ? null : +(streamed.memoryAfter / 1048576).toFixed(1),
          growthMiB: +(growth / 1048576).toFixed(1),
        }),
      );
    } else {
      ok(
        "the browser reported its own memory use during the transfer",
        false,
        "performance.measureUserAgentSpecificMemory() was unavailable - the page must be " +
          "cross-origin isolated, and the engine must support it (Chromium does).",
      );
    }
    ok(
      "the streamed bytes are EXACTLY what Python wrote, by digest",
      streamed.sha256 === source.sha256 && streamed.bytes === source.size,
      JSON.stringify({
        bytes: streamed.bytes,
        expected: source.size,
        match: streamed.sha256 === source.sha256,
      }),
    );
    ok(
      "…delivered in many chunks, none larger than the window, and the sink was CLOSED",
      streamed.chunks === Math.ceil(source.size / (4 * 1024 * 1024)) &&
        streamed.maxChunk === 4 * 1024 * 1024 &&
        streamed.closed === 1 &&
        streamed.aborted === undefined,
      JSON.stringify({
        chunks: streamed.chunks,
        maxChunk: streamed.maxChunk,
        closed: streamed.closed,
      }),
    );
    ok(
      `…while never holding more than one chunk at a time, on a ${MIB} MiB file`,
      streamed.peakLive <= 4 * 1024 * 1024,
      `peak bytes alive in the sink: ${streamed.peakLive}`,
    );
    ok(
      "…and the last progress report is the finishing phase, where cancelling no longer applies",
      streamed.lastProgress?.phase === "finishing" &&
        streamed.progress[0]?.phase === "transferring",
      JSON.stringify({ first: streamed.progress[0], last: streamed.lastProgress }),
    );
    ok(
      "…and progress was reported against the real total, monotonically",
      streamed.lastProgress?.transferred === source.size &&
        streamed.lastProgress?.total === source.size &&
        // Monotonic across the TRANSFERRING reports; the finishing one repeats the final count on
        // purpose, because it marks a phase change rather than more bytes.
        streamed.progress
          .filter((p) => p.phase !== "finishing")
          .every((p, i, all) => i === 0 || p.transferred > all[i - 1].transferred),
      JSON.stringify({ first: streamed.progress[0], last: streamed.lastProgress }),
    );

    // THE NEGATIVE CONTROL. A memory measurement nobody has made fail is not evidence, and
    // `JSHeapUsedSize` - the instrument a reviewer reaches for first - does not count
    // ArrayBuffer backing stores at all, so a test built on it passes whether the transfer holds
    // one chunk or all of them. The same transfer runs again with a sink that keeps every chunk,
    // and the measurement has to SEE that.
    if (streamed.memoryDuring != null) {
      const retaining = await page.evaluate(
        (options) => window.__py.streamArtifact("export.bin", options),
        {
          chunkBytes: 4 * 1024 * 1024,
          windowChunks: 2,
          measureAtBytes: Math.floor((MIB * 1024 * 1024) / 2),
          retainChunks: true,
        },
      );
      const retainedGrowth = retaining.memoryDuring - retaining.memoryBefore;
      const honestGrowth = streamed.memoryDuring - streamed.memoryBefore;
      ok(
        "…and the measurement is capable of failing: a sink that keeps every chunk shows it",
        retainedGrowth > honestGrowth + 16 * 1024 * 1024,
        JSON.stringify({
          honestGrowthMiB: +(honestGrowth / 1048576).toFixed(1),
          retainingGrowthMiB: +(retainedGrowth / 1048576).toFixed(1),
          retainedChunks: retaining.retainedChunks,
        }),
      );
    }

    // OWNERSHIP: once a destination is passed in, the engine closes or aborts it. The console
    // calls `createWritable()` and hands the result over, so an engine that could fail before
    // adopting it would leave the caller holding an open handle on the user's disk. Asked for a
    // file that does not exist, the destination must come back aborted exactly once and never
    // closed: a closed destination is a finished file, and this file has no bytes.
    const orphan = await page.evaluate(() => window.__py.streamArtifact("no-such-file.bin", {}));
    ok(
      "a transfer that fails before the first byte still aborts the destination it was given",
      orphan.aborted === 1 && orphan.closed === undefined && orphan.error !== undefined,
      JSON.stringify({ aborted: orphan.aborted, closed: orphan.closed, error: orphan.error }),
    );

    // ------ a Blob of this size is REFUSED, not attempted
    const refused = await page.evaluate(async () => {
      try {
        await window.__py.engine.readArtifact("export.bin");
        return { refused: false };
      } catch (error) {
        return { refused: true, message: String(error.message) };
      }
    });
    ok(
      "readArtifact() refuses to build a Blob of it, and names the alternative",
      refused.refused && /streamArtifact/.test(refused.message) && /8\.0 MiB/.test(refused.message),
      refused.message,
    );

    // ------ cancellation
    const cancelled = await page.evaluate(
      (options) => window.__py.streamArtifact("export.bin", options),
      { chunkBytes: 1024 * 1024, cancelAfterBytes: 3 * 1024 * 1024 },
    );
    ok(
      "cancelling stops the transfer, ABORTS the destination and never closes it",
      cancelled.error?.name === "ArtifactTransferAborted" &&
        cancelled.aborted === 1 &&
        cancelled.closed === undefined &&
        cancelled.bytes < source.size,
      JSON.stringify({
        error: cancelled.error,
        aborted: cancelled.aborted,
        bytes: cancelled.bytes,
      }),
    );

    // ------ a destination that fails part way
    const failed = await page.evaluate(
      (options) => window.__py.streamArtifact("export.bin", options),
      { chunkBytes: 1024 * 1024, failAfterBytes: 2 * 1024 * 1024 },
    );
    ok(
      "a destination that throws mid-write fails the transfer and aborts, with its own reason",
      /refused to take any more/.test(failed.error?.message ?? "") &&
        failed.aborted === 1 &&
        failed.closed === undefined,
      JSON.stringify(failed.error),
    );

    // ------ the lease is released on every one of those paths
    const afterFailures = await page.evaluate(async () => {
      const r = await window.__py.run(
        "with open('export.bin', 'ab') as fh:\n    fh.write(b'ok')\n",
      );
      return { r, artifacts: await window.__py.artifacts() };
    });
    ok(
      "…and every lease was released: Python can write the file again afterwards",
      !afterFailures.r.error &&
        afterFailures.artifacts.find((a) => a.name === "export.bin")?.state === "ready",
      afterFailures.r.error
        ? String(afterFailures.r.error).split("\n").pop()
        : JSON.stringify(afterFailures.artifacts.find((a) => a.name === "export.bin")),
    );

    // ------ the artifact is FROZEN while it is being transferred
    const frozen = await page.evaluate(async () => {
      const lease = await window.__py.engine.readArtifact("export.bin", { maxBytes: 8 });
      // A lease taken by hand, so the freeze can be observed while it is held. The engine's own
      // API always releases; this uses the protocol directly to hold one open.
      return { previewBytes: lease.blob.size };
    });
    ok(
      "a preview takes and releases its own lease, so it does not freeze anything",
      frozen.previewBytes === 8,
      JSON.stringify(frozen),
    );

    const duringTransfer = await page.evaluate(async () => {
      // Start a transfer, hold it at the first chunk, and try to mutate the artifact from Python
      // while it is held. This is the case the lease exists for: without it a rename halfway
      // through a download delivers half of one file and half of another.
      let release;
      const held = new Promise((resolve) => (release = resolve));
      const observed = {};
      const sink = {
        async write() {
          observed.writes = (observed.writes ?? 0) + 1;
          if (observed.writes === 1) await held;
        },
        async close() {
          observed.closed = true;
        },
        async abort() {
          observed.aborted = true;
        },
      };
      const transfer = window.__py.engine.streamArtifact("export.bin", sink, {
        chunkBytes: 1024 * 1024,
        windowChunks: 1,
      });
      // Let the first chunk arrive and block.
      await new Promise((r) => setTimeout(r, 300));

      observed.write = await window.__py.run(
        "with open('export.bin', 'ab') as fh:\n    fh.write(b'x')\n",
      );
      observed.remove = await window.__py.run("import os\nos.remove('export.bin')\n");
      observed.rename = await window.__py.run("import os\nos.rename('export.bin', 'moved.bin')\n");
      try {
        await window.__py.deleteArtifact("export.bin");
        observed.uiDelete = "allowed";
      } catch (error) {
        observed.uiDelete = String(error.message);
      }
      observed.listed = (await window.__py.artifacts()).find((a) => a.name === "export.bin");

      release();
      observed.result = await transfer.catch((error) => ({ error: String(error.message) }));
      return observed;
    });
    ok(
      "Python cannot append to, delete or rename an artifact while it is being downloaded",
      /Errno 10/.test(duringTransfer.write?.error ?? "") &&
        /Errno 10/.test(duringTransfer.remove?.error ?? "") &&
        /Errno 10/.test(duringTransfer.rename?.error ?? ""),
      JSON.stringify({
        write: (duringTransfer.write?.error ?? "").split("\n").pop(),
        remove: (duringTransfer.remove?.error ?? "").split("\n").pop(),
        rename: (duringTransfer.rename?.error ?? "").split("\n").pop(),
      }),
    );
    ok(
      "…the UI's own Delete is refused too, with a sentence rather than an errno",
      /being downloaded right now/.test(duringTransfer.uiDelete ?? ""),
      duringTransfer.uiDelete,
    );
    ok(
      "…the artifact reports itself as `transferring` while it is held",
      duringTransfer.listed?.state === "transferring",
      JSON.stringify(duringTransfer.listed),
    );
    ok(
      "…and releasing the sink lets the transfer finish normally",
      duringTransfer.result?.bytesWritten === source.size + 2 && duringTransfer.closed === true,
      JSON.stringify(duringTransfer.result),
    );

    const afterAll = await page.evaluate(async () => {
      const r = await window.__py.run("import os\nos.remove('export.bin')\n");
      return { r, artifacts: await window.__py.artifacts() };
    });
    ok(
      "…after which the freeze is gone and the file can be deleted again",
      !afterAll.r.error && afterAll.artifacts.every((a) => a.name !== "export.bin"),
      afterAll.r.error ? String(afterAll.r.error).split("\n").pop() : "removed",
    );

    return checks;
  } catch (error) {
    ok("the suite ran to the end", false, String(error?.message ?? error).split("\n")[0]);
    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report(`streaming a ${MIB} MiB artifact out`, result));
