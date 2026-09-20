#!/usr/bin/env node
// The package's CLI. One command so far: `prepare-runtime`.
//
// This is NOT `scripts/prepare-runtime.mjs`, which is for this repository's own tests and demo:
// it copies the runtime out of `node_modules`, fetches wheels one at a time, falls back to PyPI
// for pure-Python ones, and REWRITES the `sha256` in `pyodide-lock.json` to match whatever it
// got - right for a workstation whose CDN is half-blocked, and wrong for anything a visitor will
// load, because it turns a pinned, verifiable distribution into whatever the network served.
//
// So this command does the opposite: one official artifact, one digest checked before anything is
// unpacked, no substitutions, no rewrites, and a hard failure if what comes out is not complete.
// The output is a directory of static files - the value to pass as `pyodide.indexURL`.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { prepareFrevaWheelhouse } from "./freva-wheelhouse.mjs";
import {
  RUNTIME_STAMP,
  coreAssets,
  coreOf,
  digestOfFile,
  verifyPreparedRuntime,
} from "./runtime-verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELEASES = JSON.parse(readFileSync(join(HERE, "runtime-releases.json"), "utf8"));

/** Where the official artifacts live. Pinned by tag; there is deliberately no "latest" form. */
const ASSET = (version) =>
  `https://github.com/pyodide/pyodide/releases/download/${version}/pyodide-${version}.tar.bz2`;

/**
 * Written into the output directory LAST, so its presence means preparation finished. Not
 * evidence on its own: a stamp says which version was prepared and what each core file hashed to,
 * and the digests are re-checked against the disk on every warm run. See `runtime-verify.mjs`.
 */
const STAMP = RUNTIME_STAMP;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=");
    const next = argv[i + 1];
    if (inline !== undefined) out[name] = inline;
    else if (next !== undefined && !next.startsWith("--")) {
      out[name] = next;
      i += 1;
    } else out[name] = true;
  }
  return out;
}

const USAGE = `
freva-browser-python prepare-runtime --version <x.y.z> --out <dir> [--full]

  Downloads the official pinned Pyodide release, verifies its SHA-256, and unpacks it
  into <dir>. Pass <dir> to the page as pyodide.indexURL. Static files only.

  --version <x.y.z>   Required. An exact version. "latest" is refused.
  --out <dir>         Required. Created if missing.
  --full              Assert the distribution is COMPLETE: every package named in
                      pyodide-lock.json is present on disk. Use this when visitors may
                      install any package the release ships.
  --sha256 <hex>      Digest for a version this package does not yet have recorded.
  --print-digest      Download, print the digest, and stop. Use this once to obtain a
                      value to record, then re-run with --sha256.
  --cache-key         Print a deterministic cache key (for actions/cache) and stop.
  --force             Re-download even if <dir> already holds a matching runtime.

freva-browser-python prepare-freva-wheelhouse --out <dir>

  Downloads the pinned Freva wheels, each verified against a recorded SHA-256, and builds
  the browser build of freva-client (intake_esm moved to an extra rather than dropped).
  Serve <dir> as static files and pass it as wheelhouseURL for the "freva-client" profile.
  Static files only: no service, and nothing about a deployment baked in.

  --out <dir>         Required. Prepared atomically; a verified existing one is reused.
  --force             Rebuild even if <dir> already verifies.

freva-browser-python prepare-addons --out <dir> [--addons <a,b>]

  Downloads the pinned artefacts of the curated add-ons - Dask's three pure-Python wheels,
  and the Natural Earth 110m coastline and border data Cartopy would otherwise fetch while
  drawing - each verified against a recorded SHA-256. Serve <dir> as static files and pass
  it as addonBaseURL. Static files only.

  The digests a running interpreter enforces are compiled into the package, not read from
  this directory, so a stale or substituted file fails the start rather than being used.

  --out <dir>         Required. Prepared atomically; a verified existing one is reused.
  --addons <a,b>      Comma-separated ids. Default: all of them.
  --force             Re-download even if <dir> already verifies.
`;

async function download(url, destination, { onProgress } = {}) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`${url} responded ${response.status}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  let seen = 0;
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => {
    seen += chunk.length;
    onProgress?.(seen, total);
  });
  // Streamed to disk. A 350 MB release read into memory would work on a laptop and fall over in a
  // CI container, which is the one place this has to be reliable.
  await pipeline(body, createWriteStream(destination));
  return seen;
}

function sha256Of(file) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(hash.digest("hex")))
      .on("error", rejectPromise);
  });
}

/**
 * Verify a prepared directory, or fail with everything that is wrong with it. Delegates to the
 * shared verifier, which is also what this repository's own runtime check uses, so there is one
 * idea of "prepared" rather than a weaker one that runs in CI.
 */
function requireHealthy(dir, { version, full }) {
  const problems = verifyPreparedRuntime({ dir, version, full });
  if (problems.length > 0) {
    fail(
      `The runtime in ${dir} did not verify:\n  - ${problems.slice(0, 10).join("\n  - ")}` +
        `${problems.length > 10 ? `\n  - …and ${problems.length - 10} more` : ""}\n\n` +
        `Re-run with --force to prepare it again.`,
    );
  }
  const lock = JSON.parse(readFileSync(join(dir, "pyodide-lock.json"), "utf8"));
  const packages = Object.values(lock.packages ?? {});
  const absent = packages.filter((pkg) => pkg.file_name && !existsSync(join(dir, pkg.file_name)));
  return { packages: packages.length, absent: absent.length };
}

async function prepareRuntime(args) {
  const version = typeof args.version === "string" ? args.version.trim() : "";
  const out = typeof args.out === "string" ? resolve(args.out) : "";

  if (!version) fail(`--version is required.\n${USAGE}`);
  // "latest" is refused, not resolved: a moving version means the interpreter a deployment ships
  // is decided by whoever last published a release, and a portal that changed nothing can wake up
  // on a different Python. The engine pins its default index URL for the same reason.
  if (/^latest$/i.test(version) || /^\*$/.test(version)) {
    fail(
      `--version must be an exact version, not "${version}". A moving runtime is not a pinned one.`,
    );
  }
  if (!/^\d+\.\d+\.\d+([a-z]\d+)?$/.test(version)) {
    fail(`--version "${version}" does not look like a Pyodide version (e.g. 314.0.6).`);
  }

  const recorded = RELEASES[version]?.sha256;
  const expected = typeof args.sha256 === "string" ? args.sha256.trim().toLowerCase() : recorded;

  if (args["cache-key"]) {
    if (!expected) fail(`No digest recorded for ${version}; pass --sha256 to compute a cache key.`);
    console.log(`pyodide-${version}-${expected.slice(0, 16)}`);
    return;
  }
  if (!out) fail(`--out is required.\n${USAGE}`);

  if (!expected && !args["print-digest"]) {
    fail(
      `No SHA-256 is recorded for Pyodide ${version}, and none was given.\n\n` +
        `This command will not install an artifact it cannot verify. Either:\n` +
        `  - pass --sha256 <hex> for a digest you already trust, or\n` +
        `  - run once with --print-digest to fetch it and print the digest, then re-run\n` +
        `    with --sha256 and record it in bin/runtime-releases.json.\n\n` +
        `Recorded versions: ${Object.keys(RELEASES).join(", ") || "(none)"}`,
    );
  }

  // A warm cache, or a second run. The stamp records what was verified, so a directory left over
  // from a different version cannot be mistaken for this one.
  const stampPath = join(out, STAMP);
  if (!args.force && existsSync(stampPath)) {
    try {
      const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
      if (stamp.version === version && (!expected || stamp.sha256 === expected)) {
        // A cache hit is a hypothesis, and this is where it gets tested: the stamp says what was
        // prepared, the disk says what is there now. Every core file is re-hashed against the
        // digest recorded at preparation, and under `--full` every wheel against the lock file's
        // digest - otherwise a directory of placeholder bytes prints "already prepared".
        const counted = requireHealthy(out, { version, full: Boolean(args.full) });
        console.log(`Pyodide ${version} is already prepared in ${out}`);
        console.log(`  ${counted.packages} packages listed, ${counted.absent} absent`);
        console.log(`\nindexURL: ${out}`);
        return;
      }
    } catch {
      // a damaged stamp is simply not a cache hit
    }
  }

  // PREPARED BESIDE THE DESTINATION, NEVER INSIDE IT. Unpacking into `out` lets an interrupted
  // download, a truncated archive or a failed extraction replace a working runtime with a broken
  // one, leaving the previous stamp next to the wreckage for the next warm run to believe. The
  // destination is touched only once staging has been verified, by two renames on one filesystem.
  const staging = `${out}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, `pyodide-${version}.tar.bz2`);
  const url = ASSET(version);

  console.log(`Pyodide ${version}`);
  console.log(`  from ${url}`);
  let lastShown = 0;
  const bytes = await download(url, archive, {
    onProgress: (seen, total) => {
      const now = Date.now();
      if (now - lastShown < 1000) return;
      lastShown = now;
      const pct = total ? ` (${Math.round((seen / total) * 100)}%)` : "";
      process.stdout.write(`\r  downloaded ${(seen / 1e6).toFixed(0)} MB${pct}   `);
    },
  }).catch((error) => fail(`Download failed: ${error.message}`));
  process.stdout.write("\n");

  const digest = await sha256Of(archive);
  if (args["print-digest"]) {
    console.log(`  ${bytes} bytes`);
    console.log(`\nsha256: ${digest}`);
    console.log(
      `\nRecord it in bin/runtime-releases.json as:\n  "${version}": { "sha256": "${digest}" }`,
    );
    rmSync(archive, { force: true });
    return;
  }

  if (digest !== expected) {
    rmSync(staging, { recursive: true, force: true });
    fail(
      `SHA-256 mismatch for Pyodide ${version}.\n` +
        `  expected  ${expected}\n` +
        `  got       ${digest}\n\n` +
        `The artifact was not unpacked and has been deleted.`,
    );
  }
  console.log(`  sha256 verified (${digest.slice(0, 16)}…)`);

  // `--strip-components=1` because the archive holds everything under a `pyodide/` directory, and
  // the value handed to `indexURL` should be the directory that directly contains `pyodide.mjs`.
  const tar = spawnSync("tar", ["-xjf", archive, "-C", staging, "--strip-components=1"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (tar.error?.code === "ENOENT") {
    fail(
      `\`tar\` was not found. This command needs tar with bzip2 support (Linux, macOS, or GitHub Actions runners).`,
    );
  }
  if (tar.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    fail(`tar exited ${tar.status}. The archive may be truncated; re-run with --force.`);
  }
  rmSync(archive, { force: true });

  // Verified in STAGING, before the destination is touched at all, and without requiring a stamp,
  // because the stamp is what is about to be written.
  const problems = verifyPreparedRuntime({
    dir: staging,
    version,
    full: Boolean(args.full),
    requireStamp: false,
  });
  if (problems.length > 0) {
    rmSync(staging, { recursive: true, force: true });
    fail(
      `The unpacked runtime did not verify:\n  - ${problems.slice(0, 10).join("\n  - ")}` +
        `${problems.length > 10 ? `\n  - …and ${problems.length - 10} more` : ""}\n\n` +
        `Nothing was written to ${out}.`,
    );
  }
  const lockOf = JSON.parse(readFileSync(join(staging, "pyodide-lock.json"), "utf8"));
  const counted = {
    packages: Object.values(lockOf.packages ?? {}).length,
    absent: Object.values(lockOf.packages ?? {}).filter(
      (pkg) => pkg.file_name && !existsSync(join(staging, pkg.file_name)),
    ).length,
  };

  // The digests a later warm run will check against. Core assets only: a wheel is described by
  // the lock file, which the distribution ships and a browser checks against anyway, and a second
  // copy of two thousand digests would be a second thing to keep true.
  const digests = {};
  // For a pinned version the inventory is the manifest's, not the directory's. Verification above
  // has already established those exact files are present and correct, so this cannot differ in
  // practice - it is written this way so it cannot drift later either.
  const inventory = coreOf(version) ? Object.keys(coreOf(version)) : coreAssets(staging);
  for (const name of inventory) digests[name] = digestOfFile(join(staging, name));
  // Say which anchor a later warm run will have. For a version this package pins, the expected
  // core digests come from `runtime-releases.json` - derived from the release archive whose own
  // digest is enforced above - and the stamp is only a record. For a version verified against a
  // caller-supplied --sha256 there is no independent anchor, and the honest word is
  // trust-on-first-use.
  const anchored = Boolean(RELEASES[version]?.core);

  // LAST, so a directory carrying a stamp is a directory that finished.
  writeFileSync(
    join(staging, STAMP),
    `${JSON.stringify(
      {
        version,
        sha256: digest,
        full: Boolean(args.full),
        packages: counted.packages,
        digests,
        anchor: anchored ? "package-pinned" : "trust-on-first-use",
        preparedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  // The swap. The old directory is moved aside rather than deleted first, so a failure in the
  // middle leaves something to fall back to rather than nothing at all.
  const previous = `${out}.previous-${process.pid}`;
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(out)) renameSync(out, previous);
  try {
    renameSync(staging, out);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, out);
    rmSync(staging, { recursive: true, force: true });
    fail(`Could not move the prepared runtime into ${out}: ${error.message}`);
  }
  rmSync(previous, { recursive: true, force: true });

  const size = spawnSync("du", ["-sh", out], { encoding: "utf8" }).stdout?.split("\t")[0]?.trim();
  console.log(
    `  unpacked${size ? ` (${size})` : ""}: ${counted.packages} packages listed, ${counted.absent} absent`,
  );
  console.log(
    `\nServe this directory as static files and pass it as pyodide.indexURL:\n\n  ${out}\n`,
  );
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (!command || args.help) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}
if (command === "prepare-freva-wheelhouse") {
  await prepareFrevaWheelhouse(args, { fail });
} else if (command === "prepare-addons") {
  const { prepareAddons } = await import("./freva-addons.mjs");
  await prepareAddons(args, { fail });
} else if (command === "prepare-runtime") {
  await prepareRuntime(args);
} else {
  fail(`Unknown command "${command}".\n${USAGE}`);
}
