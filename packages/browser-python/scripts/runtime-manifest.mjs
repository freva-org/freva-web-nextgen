/**
 * The ONE list of wheels this package's runtime must contain, and its fingerprint. Derived rather
 * than written down: the profiles come from `PROFILE_PACKAGES` in the worker's own source and the
 * extras from `browser-tests/suite-requirements.mjs`, because a hand-maintained copy goes stale -
 * one lacking netcdf4, pyarrow and pillow made the suite that needs them exit 3 in CI and be
 * reported as NOT RUN. The profiles are read out of the TypeScript SOURCE rather than imported
 * from `dist/`, so this works before a build and cannot be fooled by a stale one.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { suitePackages } from "../browser-tests/suite-requirements.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const RUNTIME_SOURCE = join(PKG, "src", "worker", "pyodide-runtime.ts");

/** Every package name any profile loads, read from the worker's own source. Parsing rather than
 * importing is a deliberate trade: importing needs a build step and reads whatever `dist/` holds,
 * while parsing reads the file a developer just edited. The parse is narrow - the
 * `PROFILE_PACKAGES` object literal, then every double-quoted string inside it - and
 * `profilePackages()` throws if it finds nothing, so a rename cannot silently empty the list. */
export function profilePackages() {
  const source = readFileSync(RUNTIME_SOURCE, "utf8");
  const start = source.indexOf("export const PROFILE_PACKAGES");
  if (start < 0) {
    throw new Error(
      `${RUNTIME_SOURCE} no longer declares PROFILE_PACKAGES, so the runtime manifest cannot be ` +
        `derived. Update scripts/runtime-manifest.mjs rather than reintroducing a hand-written list.`,
    );
  }
  // The declaration ends at the first `};` at the start of a line - the object literal's close.
  const end = source.indexOf("\n};", start);
  const body = source
    .slice(start, end < 0 ? source.length : end)
    // Comments first. This file explains its choices at length, and several of those quote
    // package names that are deliberately NOT loaded - matplotlib's whole paragraph is about why
    // it is absent - so a parse that reads comments assembles the opposite of the profile.
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  // Only what is inside an array literal: the object's KEYS are profile names ("xarray-zarr"),
  // not packages, and they sit outside every bracket.
  const arrays = [...body.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1] ?? "");
  const names = arrays.flatMap((array) =>
    [...array.matchAll(/"([a-z0-9][a-z0-9._-]*)"/gi)].map((m) => m[1]),
  );
  const packages = [...new Set(names)].filter((name) => name !== undefined);
  if (packages.length === 0) {
    throw new Error(`No package names found in PROFILE_PACKAGES; the parse in ${HERE} is stale.`);
  }
  return packages.sort();
}

/**
 * The authoritative wheel set: profiles plus everything the suites declare. Dependencies are NOT
 * expanded here - `prepare-runtime.mjs` walks the lock file's own graph for that, which is what
 * keeps the set correct across a Pyodide upgrade.
 */
export function runtimePackages() {
  return [...new Set([...profilePackages(), ...suitePackages()])].sort();
}

/** The pinned interpreter's version, from the npm dependency rather than from anywhere else. */
export function pyodideVersion() {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("pyodide/pyodide.mjs");
  return JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")).version;
}

/** A short, stable id for "this runtime, assembled from this list" - what a cache should be
 * keyed on. Keying on `package.json` alone is wrong in the direction that matters: adding a wheel
 * without touching the Pyodide version leaves CI restoring a cache assembled before the wheel
 * existed, and the suite that needs it goes on being skipped. */
export function manifestId() {
  const payload = JSON.stringify({ pyodide: pyodideVersion(), packages: runtimePackages() });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// `node scripts/runtime-manifest.mjs` prints the id, for a CI cache key.
if (process.argv[1] && process.argv[1].endsWith("runtime-manifest.mjs")) {
  const flag = process.argv[2];
  if (flag === "--packages") console.log(runtimePackages().join("\n"));
  else console.log(manifestId());
}
