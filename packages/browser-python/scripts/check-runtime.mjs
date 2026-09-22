/**
 * Fail if `.runtime/` is not what the manifest asked for.
 *
 * node scripts/check-runtime.mjs
 *
 * A browser suite whose wheels are missing exits 3 and `run.mjs` prints it as NOT RUN, which in a
 * wall of green reads as a pass - so CI can assemble a runtime lacking netcdf4, pyarrow and pillow
 * and announce success. This turns that into a red build at the moment the runtime is assembled.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestId, runtimePackages } from "./runtime-manifest.mjs";
import { verifyRuntime } from "./runtime-verify.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(PKG, ".runtime");
const MANIFEST = join(OUT, "browser-python-runtime.json");

function fail(message) {
  console.error(`\nruntime check FAILED\n\n${message}\n`);
  process.exit(1);
}

if (!existsSync(MANIFEST)) {
  fail(
    `${MANIFEST} does not exist. Run:\n\n  node scripts/prepare-runtime.mjs\n\n` +
      `A runtime assembled by an older version of that script has no manifest and cannot be ` +
      `verified; delete .runtime/ and assemble it again.`,
  );
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const lock = JSON.parse(readFileSync(join(OUT, "pyodide-lock.json"), "utf8"));

// Verified rather than merely counted. `existsSync` is the question a restored CI cache always
// answers yes to; the rules live in `runtime-verify.mjs` so they can be unit-tested against a
// directory built to be wrong.
const problems = verifyRuntime({
  dir: OUT,
  manifest,
  lock,
  expectedManifestId: manifestId(),
  packages: runtimePackages(),
});

if (problems.length > 0) {
  fail(
    `${problems.length} problem(s) with .runtime/:\n  - ${problems.join("\n  - ")}\n\n` +
      `Re-run scripts/prepare-runtime.mjs with the CDN reachable.`,
  );
}

console.log(
  `runtime check: pyodide ${manifest.pyodide}, manifest ${manifest.manifestId}, ` +
    `${Object.keys(manifest.files ?? {}).length} assets verified`,
);
