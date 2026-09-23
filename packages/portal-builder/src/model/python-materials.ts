/**
 * The Python playground's static assets, as a declared build input rather than a later copy.
 *
 * The wheels and add-on artefacts are static files a deployment must serve. Declaring them as
 * inputs is what gets them copied before the manifests are computed and covered by
 * `checksums.sha256`; a portal that added them after the builder finished could not pass
 * `verify`, because the artifact's verifier refuses a file it has no checksum for:
 *
 *     error FP1603 freva-wheels/freva_client-…whl: … is in the artifact but not in checksums.sha256.
 *
 * This is the shape the STAC Browser already uses: one network-enabled command prepares a
 * directory, the build is handed that directory explicitly, and a build that was not given one
 * says so instead of going looking.
 *
 * This module holds the plan (what a given `portal.yaml` needs), the cache key (when a prepared
 * directory is still the right one), and the verification of a prepared directory against the
 * pins - all derived from the resolved playground, with no network I/O. Preparation itself is
 * `src/cli/prepare-playground.ts`; the copy into the artifact is `src/artifact/index.ts`. The
 * split is what lets `validate` and `build` stay offline.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ADDON_PINS,
  plannedAddons,
  plannedWheelhouse,
  verifyAddons,
  verifyWheelhouse,
  type AddonArtifactPlan,
} from "@freva-org/browser-python/prepare";
import type { PlaygroundSettings } from "./types.js";

/** The directory names a prepared materials tree uses, and the artifact serves them under. */
export const WHEELHOUSE_DIR = "freva-wheels";
export const ADDONS_DIR = "python-addons";

/** The record a prepared directory carries, so a later build can tell what it is. */
export const MATERIALS_MANIFEST = "PYTHON-MATERIALS.json";

/**
 * What one portal's playground needs, in files. `needsWheelhouse` is a property of the profile,
 * not of a URL: `freva-client` installs the Freva wheel at startup and the others do not, so a
 * portal on `minimal` that configured a wheelhouse still needs no wheels prepared.
 */
export interface PythonMaterialsPlan {
  profile: string;
  needsWheelhouse: boolean;
  /** Required and optional together: both are prepared, they differ only in what failure means. */
  addons: string[];
  optionalAddons: string[];
  /** Every artefact, artifact-relative, with the digest that was pinned for it. */
  files: { path: string; sha256: string; bytes: number }[];
  /** Total bytes, so a caller can say what preparation will cost before it starts. */
  totalBytes: number;
  /**
   * Whether the runtime itself must be mirrored, or stays on the pinned CDN. `mirror` only when
   * the deployment configured `runtimeIndexUrl`; otherwise the pinned CDN serves Pyodide and only
   * the custom directories are prepared - two quite different amounts of disk.
   */
  runtime: "pinned-cdn" | "mirror";
}

/** Every file the wheelhouse contributes, artifact-relative and pinned. */
function wheelhouseFiles(): { path: string; sha256: string; bytes: number }[] {
  // `bytes: 0` for wheels: the wheelhouse pin records digests and not sizes, and the derived
  // Freva wheel is built rather than downloaded, so it has no size to record. The plan reports
  // the digest it can prove; the total is measured from the prepared directory instead.
  return plannedWheelhouse().map((wheel) => ({
    path: `${WHEELHOUSE_DIR}/${wheel.file}`,
    sha256: wheel.sha256,
    bytes: 0,
  }));
}

/** Every file the requested add-ons contribute, artifact-relative and pinned. */
function addonFiles(ids: readonly string[]): { path: string; sha256: string; bytes: number }[] {
  if (ids.length === 0) return [];
  return plannedAddons([...ids]).map((artefact: AddonArtifactPlan) => ({
    path: `${ADDONS_DIR}/${artefact.path}`,
    sha256: artefact.sha256,
    bytes: artefact.bytes,
  }));
}

/** What this playground needs prepared. Pure: it reads pins, never the network and never a disk. */
export function planPythonMaterials(playground: PlaygroundSettings): PythonMaterialsPlan {
  const needsWheelhouse = playground.profile === "freva-client";
  const addons = [...playground.addons].sort();
  const files = [...(needsWheelhouse ? wheelhouseFiles() : []), ...addonFiles(addons)].sort(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return {
    profile: playground.profile,
    needsWheelhouse,
    addons,
    optionalAddons: [...playground.optionalAddons].sort(),
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    runtime: playground.runtimeIndexUrl ? "mirror" : "pinned-cdn",
  };
}

/**
 * The key that decides whether a prepared directory is still the right one. Deterministic, and
 * over everything that can change what preparation produces: the pin catalogue's schema version,
 * the profile, the add-on set, and every artefact's digest. A key over "which add-ons were asked
 * for" alone would keep serving a directory prepared before a pin moved, and one over the
 * directory's mere existence would keep serving whatever is there.
 *
 * The base URLs are not in it: where files are served from is a deployment decision that changes
 * no prepared byte, and folding it in would discard a good cache whenever a preview moved port.
 */
export function pythonMaterialsCacheKey(plan: PythonMaterialsPlan): string {
  const hash = createHash("sha256");
  hash.update(`schema:${ADDON_PINS.schemaVersion}\n`);
  hash.update(`profile:${plan.profile}\n`);
  hash.update(`wheelhouse:${plan.needsWheelhouse ? "yes" : "no"}\n`);
  hash.update(`addons:${plan.addons.join(",")}\n`);
  // `runtime` is deliberately not in the key. It records whether the Pyodide runtime stays on the
  // pinned CDN or is mirrored - which this command does not prepare either way, so it changes no
  // byte in this directory; folding it in would make a deployment that switched to a self-hosted
  // runtime re-download a wheelhouse and an add-on set that were already correct. The same
  // reasoning excludes the base URLs: where the files are served from is a deployment decision,
  // and a preview moving to a different port must not throw away a good cache.
  for (const file of plan.files) hash.update(`${file.path} ${file.sha256}\n`);
  return `sha256:${hash.digest("hex")}`;
}

/** What a prepared directory records about itself. A record for a human AND the cache key. */
export interface MaterialsRecord {
  schemaVersion: 1;
  preparedBy: string;
  preparedAt: string;
  cacheKey: string;
  profile: string;
  addons: string[];
  optionalAddons: string[];
  runtime: "pinned-cdn" | "mirror";
  files: { path: string; sha256: string; bytes: number }[];
}

/**
 * Whether a directory on disk really is the materials this plan needs. Judged on bytes, not on
 * the presence of a manifest: a manifest is written by whoever wrote the files, so it confirms a
 * stale directory as readily as a current one. Every file is hashed and compared against the pin,
 * and the two preparers' own verifiers run as well, since they know things a file list does not
 * (install order, the derived wheel's provenance).
 *
 * Returns the problems, empty when the directory is usable.
 */
export function verifyPythonMaterials(dir: string, plan: PythonMaterialsPlan): string[] {
  const problems: string[] = [];
  if (!existsSync(dir)) return [`${dir} does not exist.`];

  const manifestPath = join(dir, MATERIALS_MANIFEST);
  if (!existsSync(manifestPath)) {
    problems.push(`${MATERIALS_MANIFEST} is missing: this is not a prepared materials directory.`);
  } else {
    let record: MaterialsRecord | undefined;
    try {
      record = JSON.parse(readFileSync(manifestPath, "utf8")) as MaterialsRecord;
    } catch (error) {
      problems.push(`${MATERIALS_MANIFEST} is not readable JSON: ${(error as Error).message}`);
    }
    const want = pythonMaterialsCacheKey(plan);
    if (record && record.cacheKey !== want) {
      problems.push(
        `these materials were prepared for a different configuration.\n` +
          `  have ${record.cacheKey} (profile ${record.profile}, add-ons ${record.addons.join(", ") || "none"})\n` +
          `  want ${want} (profile ${plan.profile}, add-ons ${plan.addons.join(", ") || "none"})`,
      );
    }
  }

  for (const file of plan.files) {
    const full = join(dir, ...file.path.split("/"));
    if (!existsSync(full) || !statSync(full).isFile()) {
      problems.push(`${file.path} is missing.`);
      continue;
    }
    const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
    if (digest !== file.sha256) {
      problems.push(
        `${file.path} is not the artefact this build pinned.\n` +
          `  expected sha256 ${file.sha256}\n` +
          `  received sha256 ${digest}`,
      );
    }
  }

  // And the preparers' own checks, over their own directories: they are the authority on what a
  // prepared directory means, this module on which ones a portal needs.
  if (plan.needsWheelhouse && existsSync(join(dir, WHEELHOUSE_DIR))) {
    problems.push(
      ...verifyWheelhouse(join(dir, WHEELHOUSE_DIR)).map((p) => `${WHEELHOUSE_DIR}: ${p}`),
    );
  }
  if (plan.addons.length > 0 && existsSync(join(dir, ADDONS_DIR))) {
    problems.push(
      ...verifyAddons(join(dir, ADDONS_DIR), [...plan.addons]).map((p) => `${ADDONS_DIR}: ${p}`),
    );
  }
  return problems;
}
