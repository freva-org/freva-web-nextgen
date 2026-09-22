/**
 * Publishing a prepared tree: confined, and atomic.
 *
 * `--out` is an arbitrary caller-supplied path, so the destination is never deleted outright
 * (`--out ~/work` would take `~/work` with it) and is refused unless it is empty or is itself a
 * previous prepared tree. Assembling in place would leave it torn for the whole run - files land
 * one at a time, the manifest at the end, provenance later still, after assertions that can throw
 * - so a run stages into a sibling directory it created itself and publishes by rename. A crash
 * leaves either the previous complete tree or the new one, never a mixture, and a reusable cache
 * never sees a half-written result.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve, sep } from "node:path";

/**
 * Refuse a destination that no preparation should ever write to. A short list of absolutes rather
 * than a heuristic: the check has to be obviously right, and a false refusal costs a clearer
 * `--out`.
 */
export function assertPublishable(destination, { packageRoot }) {
  const target = resolve(destination);
  const parent = dirname(target);

  if (target === parent) {
    throw new Error(`Refusing to prepare materials into the filesystem root (${target}).`);
  }
  if (target === resolve(packageRoot)) {
    throw new Error(`Refusing to prepare materials into the package root (${target}).`);
  }
  // A parent of the package would take the package with it on replacement.
  if (resolve(packageRoot).startsWith(`${target}${sep}`)) {
    throw new Error(
      `Refusing to prepare materials into ${target}: the package root is inside it, so publishing ` +
        "would replace the source tree.",
    );
  }
  for (const reserved of ["dist", ".upstream", "scripts", "patches", "node_modules"]) {
    if (target === resolve(packageRoot, reserved)) {
      throw new Error(`Refusing to prepare materials into the package's '${reserved}' directory.`);
    }
  }
  if (!existsSync(target)) return { replaces: "nothing" };

  const stats = statSync(target);
  if (!stats.isDirectory()) {
    throw new Error(`Refusing to prepare materials over ${target}, which is not a directory.`);
  }
  const entries = readdirSync(target);
  if (entries.length === 0) return { replaces: "an empty directory" };

  // A non-empty destination is only replaceable when it is a previous prepared tree, decided by
  // reading its own manifest and not by the path looking plausible: a directory that happens to be
  // called `materials` is not evidence of anything.
  const manifestPath = resolve(target, "materials.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Refusing to replace ${target}: it is not empty and has no materials.json, so it is not a ` +
        "previously prepared tree. Choose an empty or new directory.",
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    throw new Error(`Refusing to replace ${target}: its materials.json is unreadable (${error}).`);
  }
  if (manifest?.kind !== "stac-browser-materials") {
    throw new Error(
      `Refusing to replace ${target}: its materials.json is '${manifest?.kind}', not ` +
        "'stac-browser-materials'.",
    );
  }
  return { replaces: "a previously prepared tree" };
}

/**
 * Move a completed staging directory into place. The old tree is renamed aside first, because a
 * rename onto a non-empty directory fails; if the second rename fails the old one is put back, so
 * a failure leaves the destination as it was rather than gone.
 */
export function publishStaged(staging, destination, { packageRoot } = {}) {
  const target = resolve(destination);
  if (packageRoot) assertPublishable(target, { packageRoot });
  mkdirSync(dirname(target), { recursive: true });

  const displaced = existsSync(target)
    ? `${target}.previous-${process.pid}-${randomBytes(4).toString("hex")}`
    : null;
  if (displaced) renameSync(target, displaced);
  try {
    renameSync(staging, target);
  } catch (error) {
    if (displaced) renameSync(displaced, target);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  if (displaced) rmSync(displaced, { recursive: true, force: true });
  return target;
}
