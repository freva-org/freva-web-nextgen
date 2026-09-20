// Is a prepared Pyodide runtime still the one that was verified?
//
// SHIPPED, in `bin/`, and shared, so the production command and the repository's own checks run
// one set of rules and CI cannot end up running the weaker of two. The question is not "was the
// download verified" - `prepare-runtime` checks the release tarball's SHA-256 before unpacking -
// but "is what is on disk NOW still that". A stamp file and a list of filenames cannot answer it:
// a cache archived mid-write, a partial `actions/cache` restore and an interrupted unpack all
// leave the names in place. So every core asset is hashed against a digest recorded at
// preparation time, and every package against the digest in the distribution's own lock file.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The pinned releases this package ships, including their core assets' digests. */
const RELEASES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "runtime-releases.json"), "utf8"),
);

/** A SHA-256 as it must be written: 64 lowercase hex characters and nothing else. */
const isDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/**
 * A plain file name in THIS directory - no separators, no traversal, no absolute path. The stamp
 * and the lock file are data read off disk, and a name like `../../etc/something` would send the
 * verifier reading, and reporting on, files outside the directory it was asked about.
 */
const isPlainName = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("/") &&
  !value.includes("\\") &&
  value !== "." &&
  value !== ".." &&
  !/^[a-zA-Z]:/.test(value);

/** The stamp a prepared runtime carries. Written last, so its presence means "finished". */
export const RUNTIME_STAMP = ".freva-runtime.json";

/**
 * Files without which the directory is not a Pyodide distribution at all. A nested array means
 * "any one of these": the Emscripten glue was `pyodide.asm.js` for years and is `pyodide.asm.mjs`
 * now, and this has to work across the pinned versions a deployment may sit on.
 */
export const ESSENTIAL = [
  ["pyodide.mjs"],
  ["pyodide.asm.wasm"],
  ["pyodide.asm.mjs", "pyodide.asm.js"],
  ["python_stdlib.zip"],
  ["pyodide-lock.json"],
];

/**
 * The exact core inventory of a PINNED release: `{ filename: sha256 }`, or `null` when this
 * package records nothing about the version - only then do the historical alternatives in
 * `ESSENTIAL` apply. When an entry exists it is the authority: these filenames, these digests, no
 * substitutions. A malformed entry is NOT downgraded to `null` but reported by
 * `manifestProblems`, because a silent fallback is how a broken manifest becomes a passing build.
 */
export function coreOf(version, releases = RELEASES) {
  const core = recordedRelease(version, releases)?.core;
  if (!core || typeof core !== "object" || Array.isArray(core)) return null;
  return Object.keys(core).length > 0 ? core : null;
}

/**
 * The release table's entry for a version, or `null` when this package records nothing about it.
 * SEPARATE FROM `coreOf`, which answers `null` both for "not recorded" and "recorded but
 * unusable" - and `null` unlocks the weaker rules, so an emptied or half-edited entry would
 * demote a pinned version to trust-on-first-use. Three states, told apart: NOT RECORDED (the
 * documented explicit-digest/TOFU path), RECORDED AND VALID (exact filenames and digests), and
 * RECORDED AND BROKEN (refused, with no fallback at all).
 */
export function recordedRelease(version, releases = RELEASES) {
  if (!version || !releases || typeof releases !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(releases, version)) return null;
  const entry = releases[version];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
}

/** Whatever is wrong with the shipped manifest entry itself, as sentences. */
function manifestProblems(version, core) {
  const problems = [];
  // COMPLETENESS OF THE MANIFEST, not only of the directory. An inventory that names three of the
  // five core files is weaker than the historical alternatives, not stricter, because the files
  // it forgets go unchecked entirely. Each essential kind must be represented exactly once.
  for (const names of ESSENTIAL) {
    const named = names.filter((name) => Object.prototype.hasOwnProperty.call(core, name));
    if (named.length === 0) {
      problems.push(
        `runtime-releases.json records Pyodide ${version} without ${names.join(" or ")}, so ` +
          `nothing would check that file. A partial inventory is weaker than no inventory.`,
      );
    } else if (named.length > 1) {
      problems.push(
        `runtime-releases.json records Pyodide ${version} with both ${named.join(" and ")}. A ` +
          `release ships one of them; recording both means one of the two is not this release.`,
      );
    }
  }
  for (const [name, digest] of Object.entries(core)) {
    if (!isPlainName(name)) {
      problems.push(
        `runtime-releases.json records ${JSON.stringify(name)} as a core file of Pyodide ` +
          `${version}, which is not a plain file name in a runtime directory.`,
      );
    } else if (!isDigest(digest)) {
      problems.push(
        `runtime-releases.json gives ${name} a sha256 that is not one: ` +
          `${JSON.stringify(digest).slice(0, 40)}.`,
      );
    }
  }
  return problems;
}

/** Full SHA-256, hex. Not truncated: a digest is cheap and a collision argument is not. */
export function digestOfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The core assets present in a directory, by their actual names. */
export function coreAssets(dir) {
  const found = [];
  for (const names of ESSENTIAL) {
    const name = names.find((candidate) => existsSync(join(dir, candidate)));
    if (name) found.push(name);
  }
  return found;
}

/**
 * Everything wrong with a prepared runtime, as a list of sentences rather than the first failure:
 * "the WASM is not what was verified" and "this stamp is for another version" have different
 * fixes, and being told them one build at a time is how a five-minute repair becomes an
 * afternoon.
 */
export function verifyPreparedRuntime({
  dir,
  version,
  full = false,
  requireStamp = true,
  releases = RELEASES,
}) {
  const problems = [];
  const read = (name) => {
    const path = join(dir, name);
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path) : null;
  };

  // A PINNED release is described by the manifest this package ships, and by nothing in the
  // directory being checked. `ESSENTIAL` offers alternatives because for an unrecorded version
  // there is no way to know which Emscripten glue name is right; for a pinned one there is, in
  // the release archive's own contents, whose digest is pinned. So a pinned version gets an exact
  // inventory, and the alternatives remain for a version where trust starts on first use.
  const recorded = recordedRelease(version, releases);
  const pinnedCore = coreOf(version, releases);
  // RECORDED, BUT NOT USABLE. Refused, with no fallback of any kind: falling back would let an
  // emptied or corrupted manifest entry buy the weaker rules for the version it was written to
  // protect, which is worse than having no entry because the deployment believes it is pinned.
  // There is nothing left to verify against, and pretending otherwise is the failure mode.
  if (recorded && !pinnedCore) {
    const shape = Array.isArray(recorded.core)
      ? "an array"
      : recorded.core === null
        ? "null"
        : recorded.core === undefined
          ? "absent"
          : typeof recorded.core === "object"
            ? "an empty object"
            : `a ${typeof recorded.core}`;
    problems.push(
      `runtime-releases.json records Pyodide ${version} but its core inventory is ${shape}, so ` +
        `there is nothing to verify this directory against. A recorded version is NOT demoted to ` +
        `trust-on-first-use: fix the manifest, or remove the entry and prepare with an explicit ` +
        `--sha256.`,
    );
    return problems;
  }
  if (pinnedCore) problems.push(...manifestProblems(version, pinnedCore));

  if (pinnedCore) {
    for (const name of Object.keys(pinnedCore)) {
      if (!isPlainName(name)) continue; // already reported by `manifestProblems`
      if (!existsSync(join(dir, name))) {
        problems.push(
          `${name} is missing, and Pyodide ${version} ships it. For a version this package pins ` +
            `the release manifest decides what must be here; no other file stands in for it.`,
        );
      }
    }
    for (const names of ESSENTIAL) {
      for (const name of names) {
        if (pinnedCore[name] || !existsSync(join(dir, name))) continue;
        const shipped = names.find((candidate) => pinnedCore[candidate]);
        problems.push(
          `${name} is present, but Pyodide ${version} ships ` +
            `${shipped ? shipped : "no file of that kind"}. A historical name left in the ` +
            `directory means this is not an unpack of the pinned release.`,
        );
      }
    }
  } else {
    for (const names of ESSENTIAL) {
      if (!names.some((name) => existsSync(join(dir, name)))) {
        problems.push(
          `${names.join(" or ")} is missing: this is not a usable Pyodide distribution.`,
        );
      }
    }
  }

  let stamp = null;
  const stampBody = read(RUNTIME_STAMP);
  if (stampBody === null) {
    if (requireStamp) {
      problems.push(
        `${RUNTIME_STAMP} is missing, so this directory was never finished by prepare-runtime ` +
          `(the stamp is written last, on purpose).`,
      );
    }
  } else {
    try {
      stamp = JSON.parse(stampBody.toString("utf8"));
    } catch {
      problems.push(
        `${RUNTIME_STAMP} is not valid JSON, so nothing about this directory is known.`,
      );
    }
  }

  if (stamp && version && stamp.version !== version) {
    problems.push(
      `this directory holds Pyodide ${stamp.version}, not ${version}. A stamp from another ` +
        `version is not a cache hit.`,
    );
  }
  if (stamp && version && releases[version]?.sha256 && stamp.sha256 !== releases[version].sha256) {
    problems.push(
      `the stamp records archive ${String(stamp.sha256).slice(0, 12)}… for Pyodide ${version}, ` +
        `but this package pins ${releases[version].sha256.slice(0, 12)}…. It was prepared from a ` +
        `different artifact.`,
    );
  }
  if (stamp && full && stamp.full !== true) {
    // `--full` asks whether every package the release ships is present. A directory prepared
    // WITHOUT it was never checked for that, and reusing it under `--full` would answer a
    // question nobody asked at the time.
    problems.push(
      "this runtime was prepared without --full, so its completeness was never established. " +
        "Re-run prepare-runtime --full --force.",
    );
  }

  // The core assets, by recorded digest. COMPLETENESS FIRST, then contents: verifying "every file
  // the stamp lists" is only a verification if the stamp is complete, and a directory with every
  // correct filename, corrupt bytes in `pyodide.asm.wasm` and a stamp naming only `pyodide.mjs`
  // would pass `--full`. The stamp is written by the same process that writes the files, so the
  // to-do list cannot also be the proof. For a PINNED version the stamp is not the record at all:
  // the expected digests come from `runtime-releases.json`, derived from the release archive whose
  // own digest is pinned, so the bytes are checked whether a stamp is present or not.
  const present = pinnedCore
    ? Object.keys(pinnedCore).filter(
        (name) =>
          isPlainName(name) && existsSync(join(dir, name)) && statSync(join(dir, name)).isFile(),
      )
    : coreAssets(dir);

  if (pinnedCore) {
    for (const name of present) {
      const expected = pinnedCore[name];
      if (!isDigest(expected)) continue; // `manifestProblems` already said so
      const path = join(dir, name);
      if (statSync(path).size === 0) {
        problems.push(`${name} is present but EMPTY - the file was never fully written.`);
        continue;
      }
      const actual = digestOfFile(path);
      if (actual !== expected) {
        problems.push(
          `${name} does not match the digest this package pins for Pyodide ${version} ` +
            `(${expected.slice(0, 12)}… != ${actual.slice(0, 12)}…): the file on disk is not the ` +
            `one that was verified.`,
        );
      }
    }
  }

  if (stamp) {
    const digests =
      stamp.digests && typeof stamp.digests === "object" && !Array.isArray(stamp.digests)
        ? stamp.digests
        : null;
    if (!digests || Object.keys(digests).length === 0) {
      problems.push(
        `this runtime records no per-file digests, so its contents cannot be verified. It was ` +
          `prepared before integrity checking existed - re-run prepare-runtime with --force.`,
      );
    } else {
      for (const name of present) {
        const recorded = digests[name];
        if (recorded === undefined) {
          problems.push(
            `${name} is part of this distribution and the stamp does not record a digest for it, ` +
              `so nothing checked its contents. A stamp that lists only some of the files it was ` +
              `written beside is an interrupted preparation, not a verification.`,
          );
          continue;
        }
        if (!isDigest(recorded)) {
          problems.push(
            `the stamp's entry for ${name} is not a SHA-256 (64 hexadecimal characters): ` +
              `${JSON.stringify(recorded).slice(0, 40)}.`,
          );
          continue;
        }
        if (pinnedCore) {
          // The bytes were checked against the manifest above; what is left is whether the
          // stamp AGREES - one that does not was edited, and a cache-local file is no anchor.
          if (isDigest(pinnedCore[name]) && pinnedCore[name] !== recorded) {
            problems.push(
              `the stamp claims ${name} hashes to ${recorded.slice(0, 12)}…, but Pyodide ` +
                `${version} ships ${pinnedCore[name].slice(0, 12)}…. The stamp lives in this ` +
                `directory and cannot vouch for it; the pinned value comes from the release ` +
                `archive.`,
            );
          }
          continue;
        }
        const path = join(dir, name);
        if (statSync(path).size === 0) {
          problems.push(`${name} is present but EMPTY - the file was never fully written.`);
          continue;
        }
        const actual = digestOfFile(path);
        if (actual !== recorded) {
          problems.push(
            `${name} does not match the digest recorded when it was prepared ` +
              `(${recorded.slice(0, 12)}… != ${actual.slice(0, 12)}…): the file on disk is not the ` +
              `one that was verified.`,
          );
        }
      }

      for (const name of Object.keys(digests)) {
        if (!isPlainName(name)) {
          problems.push(
            `the stamp records ${JSON.stringify(name)}, which is not a plain file name in this ` +
              `directory. A traversal or absolute path in a stamp is not something to follow.`,
          );
          continue;
        }
        if (!present.includes(name)) {
          problems.push(
            `the stamp records a digest for ${name}, which is not one of this distribution's ` +
              `essential files. Whatever wrote it was not this command.`,
          );
        }
      }
    }
  }

  // the packages, by the lock file's own digest
  const lockBody = read("pyodide-lock.json");
  if (lockBody !== null) {
    let lock = null;
    try {
      lock = JSON.parse(lockBody.toString("utf8"));
    } catch {
      problems.push("pyodide-lock.json is not valid JSON, so the distribution describes nothing.");
    }
    if (lock) {
      const packages = Object.values(lock.packages ?? {});
      if (full && packages.length === 0) {
        // `--full` means "every package this release ships is here". An empty lock satisfies
        // that by arithmetic - zero absent out of zero - and reports "0 packages listed, 0
        // absent", which is what a directory of placeholder bytes produces.
        problems.push(
          "pyodide-lock.json lists no packages at all. --full cannot be satisfied by an empty " +
            "manifest: zero of zero is not a complete distribution.",
        );
      }
      if (full) {
        for (const pkg of packages) {
          // A malformed entry is not something to skip over: `--full` is a claim about EVERY
          // package the release ships, and an entry with no filename or a digest that is not a
          // digest is the same problem as a missing file, arriving one layer earlier.
          if (!pkg || typeof pkg !== "object") {
            problems.push("pyodide-lock.json contains an entry that is not an object.");
            continue;
          }
          if (!isPlainName(pkg.file_name)) {
            problems.push(
              `pyodide-lock.json names ${JSON.stringify(pkg.file_name ?? null)} as a package ` +
                `file, which is not a plain file name in this directory.`,
            );
            continue;
          }
          if (!isDigest(pkg.sha256)) {
            problems.push(
              `pyodide-lock.json gives ${pkg.file_name} a sha256 that is not one: ` +
                `${JSON.stringify(pkg.sha256 ?? null).slice(0, 40)}.`,
            );
            continue;
          }
          const path = join(dir, pkg.file_name);
          if (!existsSync(path)) {
            problems.push(`${pkg.file_name} is named by pyodide-lock.json and is not on disk.`);
            continue;
          }
          if (statSync(path).size === 0) {
            problems.push(`${pkg.file_name} is present but EMPTY.`);
            continue;
          }
          // The lock file's own digest: the distribution's description of itself, which is what a
          // browser checks a wheel against when it loads one.
          const actual = digestOfFile(path);
          if (actual !== pkg.sha256) {
            problems.push(
              `${pkg.file_name} does not match its sha256 in pyodide-lock.json ` +
                `(${pkg.sha256.slice(0, 12)}… != ${actual.slice(0, 12)}…).`,
            );
          }
        }
      }
    }
  }

  return problems;
}
