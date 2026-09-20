// Is `.runtime/` the thing the manifest says it is - byte for byte?
//
// "Does a file with this name exist" is the question a restored CI cache always answers yes to. A
// cache archived mid-assembly, a partial restore, an interrupted download, a file system that ran
// out of space: every one leaves names in place and bytes missing, and the failure then arrives
// inside a WebAssembly instantiation or a wheel import, as an opaque "Failed to fetch" somewhere
// in a browser suite.
//
// So every asset is hashed, the core runtime included and not only the wheels: `pyodide.asm.wasm`
// is the largest file in the directory and the one whose corruption is least legible. Separated
// from `check-runtime.mjs` so the rules can be unit-tested against a directory built to be wrong.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ESSENTIAL } from "../bin/runtime-verify.mjs";

/**
 * The files a runtime cannot start without, whatever wheels it does or does not carry.
 * `--minimal` produces a runtime with no wheels at all, which is a legitimate thing to have; it
 * does not produce one without an interpreter.
 */
export const CORE_ASSETS = Object.freeze(ESSENTIAL.map((names) => names[0]));

/** Full SHA-256, hex. Not truncated: a digest is cheap and a collision argument is not. */
export function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every package `names` needs, following the lock file's own dependency graph. */
export function closure(lock, names) {
  const out = new Set();
  const queue = [...names];
  const unknown = [];
  while (queue.length) {
    const name = queue.pop();
    const key = String(name).toLowerCase();
    if (out.has(key)) continue;
    const entry = lock.packages?.[key];
    if (!entry) {
      unknown.push(name);
      continue;
    }
    out.add(key);
    for (const dep of entry.depends ?? []) queue.push(dep);
  }
  return { resolved: [...out], unknown };
}

/**
 * Everything wrong with a runtime directory, as a list of sentences. A list rather than the first
 * failure: "numpy is missing" and "the manifest is from another package list" have different
 * fixes, and being told them one build at a time is how a five-minute repair becomes an afternoon.
 */
export function verifyRuntime({ dir, manifest, lock, expectedManifestId, packages }) {
  const problems = [];
  const read = (name) => {
    const path = join(dir, name);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  };

  if (!manifest) {
    return [
      "`.runtime/browser-python-runtime.json` does not exist. A runtime assembled by an older " +
        "version of prepare-runtime.mjs has no manifest and cannot be verified; delete " +
        ".runtime/ and assemble it again.",
    ];
  }
  if (expectedManifestId && manifest.manifestId !== expectedManifestId) {
    problems.push(
      `.runtime/ was assembled from a different package list (recorded ` +
        `${manifest.manifestId ?? "nothing"}, expected ${expectedManifestId}). In CI this means ` +
        `the cache key and the manifest have come apart.`,
    );
  }
  if (manifest.complete === false) {
    problems.push(
      "`.runtime/` is incomplete: some wheels could not be fetched when it was assembled. " +
        "Suites that need them exit 3 and are reported as NOT RUN, which is not a pass.",
    );
  }
  if (manifest.digest !== "sha256") {
    problems.push(
      "this runtime records no full-length digests, so its contents cannot be verified. It was " +
        "assembled before integrity checking existed - re-run scripts/prepare-runtime.mjs.",
    );
  }

  // every recorded asset
  const files = manifest.files ?? {};
  if (Object.keys(files).length === 0) {
    problems.push("the manifest records no files at all, so there is nothing to verify.");
  }
  for (const [name, expected] of Object.entries(files)) {
    const bytes = read(name);
    if (bytes === null) {
      problems.push(`${name} is named by the manifest and is not in .runtime/.`);
      continue;
    }
    // Zero length is called out separately from a digest mismatch because it is a different
    // accident with a different fix: an interrupted write or an out-of-space file system, rather
    // than a file from another build.
    if (bytes.length === 0) {
      problems.push(`${name} is present but EMPTY - the file was never fully written.`);
      continue;
    }
    const actual = digestOf(bytes);
    if (typeof expected === "string" && expected.length === 64 && actual !== expected) {
      problems.push(
        `${name} does not match its recorded digest (${expected.slice(0, 12)}… != ` +
          `${actual.slice(0, 12)}…): the file in .runtime/ is not the one that was assembled.`,
      );
    }
  }

  // the core, whether recorded or not
  for (const name of CORE_ASSETS) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      problems.push(`${name} is missing: this is not a Pyodide runtime.`);
      continue;
    }
    if (statSync(path).size === 0) problems.push(`${name} is empty.`);
  }

  // the dependency closure, not just the names
  if (lock && packages) {
    const { resolved, unknown } = closure(lock, packages);
    for (const name of unknown) {
      problems.push(`${name} is named by the manifest but is not in this runtime's lock file.`);
    }
    const absent = resolved
      .map((key) => lock.packages[key].file_name)
      // Empty counts as absent: a zero-byte wheel is a failed write wearing the right name, and a
      // dependency nobody named directly is exactly the file nothing else would notice.
      .filter((file) => !existsSync(join(dir, file)) || statSync(join(dir, file)).size === 0);
    if (absent.length > 0) {
      problems.push(
        `${absent.length} wheel(s) in the dependency closure are missing or empty: ` +
          `${absent.join(", ")}. A package whose own dependency is absent fails at import, not ` +
          `at load.`,
      );
    }
  }

  return problems;
}
