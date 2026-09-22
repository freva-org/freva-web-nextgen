/**
 * Assemble `.runtime/` - the Pyodide distribution the browser suites and the demo serve locally.
 * The interpreter comes from the `pyodide` devDependency, pinned by the lockfile; the WHEELS exist
 * only in the release tarball, so those are fetched once from the pinned CDN directory named in
 * `pyodide-lock.json` and cached in a gitignored directory. Nothing here reaches the published
 * package.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { manifestId, pyodideVersion, runtimePackages } from "./runtime-manifest.mjs";
import { CORE_ASSETS, digestOf } from "./runtime-verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const OUT = join(PKG, ".runtime");
const require = createRequire(import.meta.url);

/**
 * Every wheel this runtime must contain - DERIVED, not written down here. A hand-written list goes
 * stale: one missing netcdf4, pyarrow and pillow made the workspace suite exit 3, reported as NOT
 * RUN rather than failed, so CI announced a green run for a suite it never executed. The list comes
 * from `scripts/runtime-manifest.mjs`.
 */
const WANTED = process.argv.includes("--minimal") ? [] : runtimePackages();

/**
 * What was assembled, written beside the wheels. A cache keyed on `package.json` restores a
 * directory assembled before a newly added wheel existed, so this records the manifest id and every
 * file's digest instead.
 */
const MANIFEST = join(OUT, "browser-python-runtime.json");

function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {
    return null;
  }
}

function copyRuntime() {
  const entry = require.resolve("pyodide/pyodide.mjs");
  const src = dirname(entry);
  mkdirSync(OUT, { recursive: true });
  // The filter is on the path RELATIVE to `src`: the source directory is itself inside
  // node_modules, so an absolute-path test rejects every file including the root and silently
  // produces an empty runtime.
  cpSync(src, OUT, {
    recursive: true,
    dereference: true,
    filter: (from) => !from.slice(src.length).includes("node_modules"),
  });
  const version = JSON.parse(readFileSync(join(src, "package.json"), "utf8")).version;
  console.log(`runtime: pyodide ${version} copied to .runtime/`);
  return version;
}

/**
 * Resolve a package name to every wheel it needs, following the lock file's own dependency graph.
 * Following the graph rather than listing filenames keeps this correct when `zarr` gains a
 * dependency.
 */
function closure(lock, names) {
  const out = new Set();
  const queue = [...names];
  while (queue.length) {
    const name = queue.pop();
    const key = name.toLowerCase();
    if (out.has(key)) continue;
    const entry = lock.packages?.[key];
    if (!entry) {
      console.warn(`  (no package named ${name} in this runtime's lock file)`);
      continue;
    }
    out.add(key);
    for (const dep of entry.depends ?? []) queue.push(dep);
  }
  return [...out];
}

/**
 * Fetch one wheel, preferring the pinned Pyodide distribution and falling back to PyPI. A
 * PURE-Python wheel is byte-identical in both, so where the CDN is blocked the fsspec/xarray/zarr
 * half of the stack is still testable. The compiled wheels are Emscripten builds that exist ONLY in
 * the Pyodide release.
 */
async function download(entry, base) {
  const attempts = [new URL(entry.file_name, base).href];
  if (entry.file_name.endsWith("py3-none-any.whl")) {
    attempts.push(
      `https://pypi.org/pypi/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}/json`,
    );
  }
  for (const attempt of attempts) {
    try {
      if (attempt.startsWith("https://pypi.org/")) {
        const meta = await fetch(attempt);
        if (!meta.ok) continue;
        const data = await meta.json();
        const url = (data.urls ?? []).find((u) => u.filename === entry.file_name)?.url;
        if (!url) continue;
        const wheel = await fetch(url);
        if (!wheel.ok) continue;
        return { bytes: Buffer.from(await wheel.arrayBuffer()), source: "pypi" };
      }
      const response = await fetch(attempt);
      if (!response.ok) continue;
      return { bytes: Buffer.from(await response.arrayBuffer()), source: "pyodide" };
    } catch {
      // Try the next source. A blocked host is a normal condition here, not an error.
    }
  }
  return null;
}

async function fetchWheels(version) {
  if (WANTED.length === 0) {
    // Say what --minimal costs, at the moment it is chosen. It leaves a runtime that starts and
    // then cannot import anything scientific: the `xarray + zarr` profile fails to start, and on
    // `minimal` a bare `import xarray` fails while the toolbar still says Ready.
    console.log("wheels: skipped (--minimal)");
    console.log("");
    console.log("  This runtime has NO wheels. The interpreter will start, but:");
    console.log("    - the `xarray + zarr` profile will fail to start");
    console.log("    - `import numpy` / `xarray` / `matplotlib` will fail on `minimal`");
    console.log("  For those, re-run without --minimal (needs the Pyodide CDN), or drop");
    console.log("  `pyodide.indexURL` from the page so it loads from the CDN directly.");
    console.log("");
    return;
  }
  const lock = JSON.parse(readFileSync(join(OUT, "pyodide-lock.json"), "utf8"));
  const base =
    process.env.PYODIDE_WHEEL_BASE ?? `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;

  const needed = closure(lock, WANTED);
  const missing = [];
  const digests = {};
  const rehashed = [];
  let fetched = 0;
  let cached = 0;
  for (const name of needed) {
    const file = lock.packages[name].file_name;
    const target = join(OUT, file);
    if (existsSync(target)) {
      cached += 1;
      digests[file] = digestOf(readFileSync(target));
      continue;
    }
    const got = await download(lock.packages[name], base);
    if (!got) {
      missing.push(file);
      continue;
    }
    writeFileSync(target, got.bytes);
    digests[file] = digestOf(got.bytes);
    if (got.source === "pypi") {
      // Pyodide VERIFIES every wheel against the sha256 in its lock file, and a PyPI copy of the
      // same version is a different BUILD, so the load fails as an opaque "Failed to fetch". The
      // hash is rewritten to the bytes actually downloaded - honest for a LOCAL TEST runtime, and
      // announced below. CI reaches the CDN and never takes this path.
      lock.packages[name].sha256 = createHash("sha256").update(got.bytes).digest("hex");
      rehashed.push(file);
    }
    fetched += 1;
  }
  if (rehashed.length) {
    writeFileSync(join(OUT, "pyodide-lock.json"), JSON.stringify(lock));
  }
  // The interpreter itself is an asset too, and the one whose corruption is least legible: a
  // truncated `pyodide.asm.wasm` fails inside `WebAssembly.instantiate`, in a browser, hours after
  // the cache that truncated it was written.
  for (const asset of CORE_ASSETS) {
    const path = join(OUT, asset);
    if (existsSync(path)) digests[asset] = digestOf(readFileSync(path));
  }
  writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        pyodide: version,
        manifestId: manifestId(),
        // Says the digests below are full-length SHA-256, so a runtime assembled before integrity
        // checking existed is refused rather than trusted.
        digest: "sha256",
        packages: WANTED,
        resolved: needed.length,
        complete: missing.length === 0,
        files: digests,
      },
      null,
      2,
    ),
  );
  console.log(`wheels: ${fetched} fetched, ${cached} cached, ${needed.length} needed`);
  if (rehashed.length) {
    console.warn(
      `\n${rehashed.length} wheel(s) came from PyPI rather than the Pyodide distribution, and\n` +
        `their integrity hashes in .runtime/pyodide-lock.json were rewritten to match:\n  ` +
        `${rehashed.join("\n  ")}\n\n` +
        `Same package and version, different build. Fine for a local test runtime; NOT a mirror\n` +
        `of the pinned distribution. CI reaches the CDN and does not take this path.`,
    );
  }
  if (missing.length) {
    console.warn(
      `\n${missing.length} wheel(s) could not be fetched:\n  ${missing.join("\n  ")}\n\n` +
        `Suites that need them will report the runtime as INCOMPLETE rather than passing.\n` +
        `Set PYODIDE_WHEEL_BASE to a mirror of the pinned distribution if the CDN is blocked.`,
    );
  }
}

/**
 * Refuse to reuse a directory assembled from a DIFFERENT list: "the file already exists" is how
 * every wheel is skipped and a runtime missing three of them looks finished. On a mismatch the
 * wheels are re-resolved, the ones present hashed and kept.
 */
function reportStaleCache() {
  const previous = readManifest();
  if (!previous) return;
  const wanted = manifestId();
  if (previous.manifestId === wanted && previous.complete !== false) return;
  console.log(
    `runtime: the cached .runtime/ was assembled from a different list ` +
      `(${previous.manifestId ?? "unrecorded"} -> ${wanted}${previous.complete === false ? ", incomplete" : ""}); ` +
      `re-resolving wheels.`,
  );
}

const expected = pyodideVersion();
reportStaleCache();
const version = copyRuntime();
if (version !== expected) {
  console.warn(`runtime: copied pyodide ${version} but the dependency resolves to ${expected}`);
}
await fetchWheels(version);
