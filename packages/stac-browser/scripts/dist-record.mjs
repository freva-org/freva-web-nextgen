/**
 * The closed build record for the compiled STAC Browser.
 *
 * `dist/` is produced by a network-enabled job and consumed by a separate one that turns it into
 * prepared materials; between those moments the tree is just files on a disk. Three fields in
 * `BUILDINFO.json` plus the presence of `index.html` cannot make it trustworthy - a changed file
 * leaves those fields alone, and a stale tree from an older pin satisfies them if the pin moved
 * back and forth - so the record is closed and the tree hashed. Everything the downstream job
 * needs (upstream, patches, entry, styles) is recorded here, and the materials manifest derives
 * from *this* record rather than re-reading the current metadata files, which would be a second
 * source of truth that can disagree.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const BUILD_RECORD_NAME = "BUILDINFO.json";
export const BUILD_RECORD_VERSION = 1;

/** Code points, not UTF-16 code units and never a locale collation. */
export function compareCodePoints(a, b) {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * Every regular file under `root`, relative and POSIX, excluding the record itself - which cannot
 * contain a digest of a tree that contains it.
 */
export function listDistFiles(root, prefix = "") {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`The compiled tree contains the symbolic link '${rel}'.`);
    }
    if (entry.isDirectory()) {
      out.push(...listDistFiles(root, rel));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`The compiled tree contains '${rel}', which is not a regular file.`);
    }
    if (rel === BUILD_RECORD_NAME) continue;
    out.push(rel);
  }
  return out.sort(compareCodePoints);
}

/** Path, NUL, content digest, newline, in code-point order. */
export function distTreeDigest(root) {
  const hash = createHash("sha256");
  for (const rel of listDistFiles(root)) {
    hash
      .update(rel)
      .update("\0")
      .update(sha256(readFileSync(join(root, rel))))
      .update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** The ordered patch series with its digests, read from the patch directory. */
export function patchSeries(pkgRoot) {
  const dir = resolve(pkgRoot, "patches");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".patch"))
    .sort(compareCodePoints)
    .map((name) => ({ name, digest: sha256(readFileSync(join(dir, name))) }));
}

/** The embed descriptor the patched build emits, normalized. */
export function readEmbed(distDir) {
  const file = join(distDir, "EMBED.json");
  if (!existsSync(file)) return undefined;
  const embed = JSON.parse(readFileSync(file, "utf-8"));
  return {
    entry: String(embed.entry).replace(/^\.?\//, ""),
    styles: (embed.styles ?? []).map((style) => String(style).replace(/^\.?\//, "")),
    mountId: embed.mountId ? String(embed.mountId) : "stac-browser-mount",
  };
}

/**
 * Build the record for a tree that has just been compiled. The verifier below re-derives the same
 * thing and compares, so the two cannot drift apart without failing.
 */
export function buildRecord({ pkgRoot, distDir, pin }) {
  const embed = readEmbed(distDir);
  if (!embed) {
    throw new Error("The compiled tree has no EMBED.json; the patch series did not apply.");
  }
  return {
    schemaVersion: BUILD_RECORD_VERSION,
    upstream: pin.name,
    tag: pin.tag,
    commit: pin.commit,
    license: pin.license,
    buildMode: pin.buildMode,
    config: pin.config,
    patches: patchSeries(pkgRoot),
    embed,
    licenseFiles: ["LICENSES/stac-browser-ISC.txt", "THIRD_PARTY_NOTICES.md"],
    treeDigest: distTreeDigest(distDir),
  };
}

/**
 * Prove a compiled tree is the one its record describes, and the record the one the current pin
 * and patch series call for. Returns every reason it is not, not the first: a stale tree fails
 * several at once, and seeing all of them tells an operator whether to re-fetch or to re-patch.
 */
export function verifyDistRecord({ pkgRoot, distDir, pin }) {
  const reasons = [];
  const recordPath = join(distDir, BUILD_RECORD_NAME);
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    return { ok: false, reasons: [`'${distDir}' is not a directory`], record: undefined };
  }
  if (!existsSync(recordPath)) {
    return { ok: false, reasons: [`'${BUILD_RECORD_NAME}' is missing`], record: undefined };
  }

  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf-8"));
  } catch (error) {
    return { ok: false, reasons: [`${BUILD_RECORD_NAME} is not valid JSON: ${error.message}`] };
  }

  if (record.schemaVersion !== BUILD_RECORD_VERSION) {
    reasons.push(
      `the build record is version ${String(record.schemaVersion)}, not ${BUILD_RECORD_VERSION}`,
    );
    // An older record has none of the fields below; stop rather than report fifteen consequences
    // of one cause.
    return { ok: false, reasons, record };
  }

  for (const [field, expected] of [
    ["tag", pin.tag],
    ["commit", pin.commit],
    ["buildMode", pin.buildMode],
    ["license", pin.license],
  ]) {
    if (record[field] !== expected) {
      reasons.push(`${field} is '${String(record[field])}', but the pin says '${expected}'`);
    }
  }

  const expectedPatches = patchSeries(pkgRoot);
  const recorded = Array.isArray(record.patches) ? record.patches : [];
  if (recorded.length !== expectedPatches.length) {
    reasons.push(
      `the record has ${recorded.length} patch(es); the series has ${expectedPatches.length}`,
    );
  } else {
    for (let i = 0; i < expectedPatches.length; i += 1) {
      if (recorded[i]?.name !== expectedPatches[i].name) {
        reasons.push(
          `patch ${i + 1} is '${String(recorded[i]?.name)}', expected '${expectedPatches[i].name}'`,
        );
      } else if (recorded[i]?.digest !== expectedPatches[i].digest) {
        reasons.push(`patch '${expectedPatches[i].name}' has been edited since the build`);
      }
    }
  }

  const embed = record.embed;
  if (!embed || typeof embed.entry !== "string") {
    reasons.push("the record has no embed descriptor");
  } else {
    if (!existsSync(join(distDir, ...embed.entry.split("/")))) {
      reasons.push(`the recorded entry '${embed.entry}' is not in the tree`);
    }
    for (const style of embed.styles ?? []) {
      if (!existsSync(join(distDir, ...style.split("/")))) {
        reasons.push(`the recorded stylesheet '${style}' is not in the tree`);
      }
    }
    const current = readEmbed(distDir);
    if (current && current.entry !== embed.entry) {
      reasons.push(`EMBED.json names '${current.entry}' but the record names '${embed.entry}'`);
    }
  }

  for (const file of record.licenseFiles ?? []) {
    if (!existsSync(join(distDir, ...file.split("/")))) {
      reasons.push(`the licence file '${file}' is not in the tree`);
    }
  }

  // Last, because it is the expensive check and because a mismatch here is the finding the others
  // cannot make: the tree changed after it was built.
  let actual;
  try {
    actual = distTreeDigest(distDir);
  } catch (error) {
    reasons.push(error.message);
  }
  if (actual !== undefined && actual !== record.treeDigest) {
    reasons.push(
      `the compiled tree hashes to ${actual}, but the record says ${String(record.treeDigest)}`,
    );
  }

  return { ok: reasons.length === 0, reasons, record };
}
