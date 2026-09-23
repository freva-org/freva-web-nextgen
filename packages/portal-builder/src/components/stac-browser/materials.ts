// Prepared STAC Browser materials.
//
// A portal build never clones upstream and never runs an inner `npm ci`. The upstream source,
// its dependency tree, the embedding patch series and the licences are prepared by one
// network-enabled stage that a deployment runs only when it has enabled the component; this
// build only *reads* that tree and records its digests, so the artifact identifies which STAC
// it shipped. The tree being framework-produced is a reason to check it rather than not to: it
// is named by whoever ran the preparation, and a named input trusted without being verified is
// just an unexamined one. Every file the portal ships out of this directory is proven to be:
//
//   * *declared*  - listed in a manifest that passed a closed schema;
//   * *contained* - a regular file whose real path is inside the real materials root, so no
//     symlink and no traversal can point the copy at /etc or at the consumer's source tree;
//   * *identical* - matching its recorded digest and size; and
//   * *complete*  - the declared set is exactly the set present, so a file slipped into the
//     tree is an error rather than a passenger.
//
// When STAC is disabled nothing is loaded, nothing is copied, and no materials need exist.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { Diagnostic } from "../../diagnostics.js";
import { validateAgainst } from "../../config/schema.js";
import { compareCodePoints } from "../../util/order.js";
import { sha256 } from "../../util/package.js";

export interface StacMaterialsManifest {
  schemaVersion: 1;
  kind: "stac-browser-materials";
  upstream: { repository: string; tag: string; commit: string; sourceDigest?: string };
  patches: { name: string; digest: string }[];
  /** Materials-relative path of the ES module entry the adapter imports. */
  entry: string;
  /** Materials-relative stylesheets the embedded application needs. */
  styles?: string[];
  /** The element id the prepared patch set mounts into. */
  mountId?: string;
  files: { path: string; digest: string; bytes: number }[];
  treeDigest: string;
  producer?: string;
}

/**
 * What the preparation stage recorded about itself. Read, never verified against, and never
 * copied: the manifest is the trust anchor - what every file is checked against - and this is
 * the stage's account of how that tree came to exist, which recipe, which licence, which
 * lockfile, which cache key. An artifact that says which STAC it shipped should also be able to
 * say which recipe produced it. Every field is optional because an older prepared tree will not
 * have this file, and a materials directory without it is still a valid one.
 */
export interface StacProvenance {
  recipeVersion?: string;
  recipeDigest?: string;
  cacheKey?: string;
  upstream?: { licenseSpdx?: string; licenseDigest?: string; lockfileDigest?: string };
  toolchain?: { node?: string };
}

export interface PreparedStacMaterials {
  /** The path as configured, kept for messages. */
  root: string;
  /** The resolved real path every containment proof is made against. */
  realRoot: string;
  manifest: StacMaterialsManifest;
  provenance?: StacProvenance;
}

export interface LoadedStacMaterials {
  materials?: PreparedStacMaterials;
  diagnostics: Diagnostic[];
}

/** The manifest is described by the tree, not a member of it. */
export const MANIFEST_NAME = "materials.json";

/**
 * The preparation stage's own record: which recipe, which commit, which patch digests, which
 * toolchain, which cache key. Like the manifest, it describes the tree rather than belonging to
 * it, so it is neither declared nor copied - a tree that listed its own description would have
 * to hash a file whose content depends on that hash. It is read for provenance and nothing else.
 */
export const PROVENANCE_NAME = "PROVENANCE.json";

/** Files that describe the materials rather than being part of them. */
const DESCRIBES_TREE = new Set([MANIFEST_NAME, PROVENANCE_NAME]);

/**
 * Where the prepared materials come from - which is nowhere, unless somebody says.
 *
 * The path is an argument, never a search path. The builder image carries no prepared
 * materials, and the candidates a search would try are exactly the ones that can be stale: a
 * directory left over from a previous preparation, at a well-known location, is
 * indistinguishable from the one this build was meant to consume. Such a tree verifies - it is
 * internally consistent - and the artifact ships a different STAC than the one this deployment
 * prepared. So the preparation stage produces a directory and names it, and the deployment
 * routine hands that exact directory to the build. `FREVA_PORTAL_STAC_MATERIALS` is the
 * environment form of the same explicit statement, for CI that would rather set a variable than
 * thread a flag, and it is still one deliberate answer rather than a search.
 */
export function materialsPath(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const fromEnvironment = process.env.FREVA_PORTAL_STAC_MATERIALS;
  return fromEnvironment && fromEnvironment.length > 0 ? fromEnvironment : undefined;
}

function error(message: string, hint?: string): Diagnostic {
  const d: Diagnostic = { code: "FP1604", severity: "error", message };
  if (hint) d.hint = hint;
  return d;
}

/**
 * The digest of the declared tree: path, NUL, digest, newline, in code-point order. NUL
 * separates because it is the one byte a path cannot contain, so no pair of distinct trees can
 * produce the same byte stream.
 */
export function treeDigestOf(files: { path: string; digest: string }[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => compareCodePoints(a.path, b.path))) {
    hash.update(file.path).update("\0").update(file.digest).update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Every real file under `root`, materials-relative, excluding the manifest. Directory entries
 * that are neither a directory nor a regular file - a symlink, a socket, a device - are
 * reported rather than skipped: skipping them would let a symlink farm sit in a tree that
 * verification then calls closed.
 */
function walk(root: string, prefix: string, found: string[], problems: string[]): void {
  const here = prefix ? join(root, prefix) : root;
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      problems.push(`'${rel}' is a symbolic link`);
      continue;
    }
    if (entry.isDirectory()) {
      walk(root, rel, found, problems);
      continue;
    }
    if (!entry.isFile()) {
      problems.push(`'${rel}' is not a regular file`);
      continue;
    }
    if (!DESCRIBES_TREE.has(rel)) found.push(rel);
  }
}

/** Case, percent and Unicode folding, so a collision cannot hide behind spelling. */
function collisionKey(path: string): string {
  return decodeURIComponent(path).normalize("NFC").toLowerCase();
}

export function loadStacMaterials(explicit?: string): LoadedStacMaterials {
  const root = materialsPath(explicit);
  if (!root) {
    return {
      diagnostics: [
        error(
          "The STAC Browser component is enabled, but this build was not given prepared upstream " +
            "materials.",
          "Prepared materials are produced by one network-enabled stage and passed explicitly to " +
            "this one:\n" +
            "  npm run prepare:upstream -w @freva-org/stac-browser -- --out <dir>\n" +
            "  freva-portal-builder build --config <portal.yaml> --stac-materials <dir>\n" +
            "A portal build never fetches, patches or compiles upstream, and it will not go " +
            "looking for a materials directory it was not told about.",
        ),
      ],
    };
  }
  {
    const manifestPath = join(root, MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
      return {
        diagnostics: [
          error(
            `No prepared STAC materials at '${root}': ${MANIFEST_NAME} is missing.`,
            "The path is taken literally. Point it at the directory 'npm run prepare -w " +
              "@freva-org/stac-browser' wrote, which contains materials.json.",
          ),
        ],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (cause) {
      return {
        diagnostics: [
          error(
            `'${manifestPath}' is not valid JSON: ${(cause as Error).message}`,
            "The prepared materials are produced by 'npm run prepare:upstream -w @freva-org/stac-browser'. A hand-edited manifest is not a supported input.",
          ),
        ],
      };
    }

    // A closed schema first, so every later check can read fields rather than re-establish
    // that they are the right shape.
    const validation = validateAgainst("stacMaterials", parsed, manifestPath);
    if (!validation.valid) {
      return {
        diagnostics: validation.diagnostics.map((d) => ({
          ...d,
          code: "FP1604",
          hint:
            d.hint ??
            "The prepared STAC materials manifest does not match the closed contract. Re-prepare them with 'npm run prepare:upstream -w @freva-org/stac-browser'.",
        })),
      };
    }

    const manifest = parsed as StacMaterialsManifest;

    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch (cause) {
      return {
        diagnostics: [
          error(
            `The STAC materials root '${root}' cannot be resolved: ${(cause as Error).message}`,
          ),
        ],
      };
    }
    if (!lstatSync(realRoot).isDirectory()) {
      return { diagnostics: [error(`The STAC materials root '${root}' is not a directory.`)] };
    }

    // The provenance record is read leniently on purpose: it is not a trust anchor - nothing
    // is copied from it and no check depends on it - so a missing or unreadable one must not
    // stop a build whose materials verify. It only enriches what the artifact can say.
    let provenance: StacProvenance | undefined;
    try {
      const parsedProvenance = JSON.parse(readFileSync(join(root, PROVENANCE_NAME), "utf8"));
      if (parsedProvenance && typeof parsedProvenance === "object") {
        provenance = parsedProvenance as StacProvenance;
      }
    } catch {
      // An older prepared tree has none.
    }
    return {
      materials: { root, realRoot, manifest, ...(provenance ? { provenance } : {}) },
      diagnostics: [],
    };
  }
}

/**
 * Prove the prepared tree is the one the manifest describes. Every check here is a precondition
 * for copying bytes into a published artifact, so all of them run and all findings are
 * reported: a build that fails on the first bad file teaches the operator one problem per
 * attempt.
 */
export function verifyMaterials(materials: PreparedStacMaterials): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { manifest, realRoot, root } = materials;

  // 1. The declared list itself: canonical order, NFC, no duplicate and no collision under
  //    case, percent-encoding or Unicode folding.
  const declared = manifest.files.map((f) => f.path);
  const ordered = [...declared].sort(compareCodePoints);
  if (declared.some((p, i) => p !== ordered[i])) {
    diagnostics.push(
      error(
        "The prepared STAC materials are not listed in canonical code-point order.",
        "The order is part of the tree digest; an unordered list cannot be compared.",
      ),
    );
  }
  const seen = new Map<string, string>();
  for (const path of declared) {
    if (path.normalize("NFC") !== path) {
      diagnostics.push(error(`Prepared STAC material '${path}' is not in Unicode NFC.`));
    }
    let key: string;
    try {
      key = collisionKey(path);
    } catch {
      diagnostics.push(error(`Prepared STAC material '${path}' is not decodable as a path.`));
      continue;
    }
    const previous = seen.get(key);
    if (previous !== undefined) {
      diagnostics.push(
        error(
          previous === path
            ? `Prepared STAC material '${path}' is listed more than once.`
            : `Prepared STAC materials '${previous}' and '${path}' collide under case, percent and Unicode folding.`,
          "A tree that is ambiguous on a case-insensitive or normalizing filesystem cannot be shipped as one artifact.",
        ),
      );
      continue;
    }
    seen.set(key, path);
  }

  // 2. Each declared file: contained, regular, and byte-identical.
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  for (const file of manifest.files) {
    const abs = join(realRoot, ...file.path.split("/"));
    let link;
    try {
      link = lstatSync(abs);
    } catch {
      diagnostics.push(error(`Prepared STAC material '${file.path}' is missing.`));
      continue;
    }
    if (link.isSymbolicLink()) {
      diagnostics.push(
        error(
          `Prepared STAC material '${file.path}' is a symbolic link.`,
          "Materials are copied by value. A link would publish whatever it points at on the build machine.",
        ),
      );
      continue;
    }
    if (!link.isFile()) {
      diagnostics.push(error(`Prepared STAC material '${file.path}' is not a regular file.`));
      continue;
    }
    // Containment is proven after resolution, so a symlinked *parent* directory is caught as
    // well as a symlinked file.
    let real: string;
    try {
      real = realpathSync(abs);
    } catch (cause) {
      diagnostics.push(
        error(
          `Prepared STAC material '${file.path}' cannot be resolved: ${(cause as Error).message}`,
        ),
      );
      continue;
    }
    if (!real.startsWith(rootPrefix)) {
      diagnostics.push(
        error(
          `Prepared STAC material '${file.path}' resolves outside the materials root.`,
          `It resolves to '${real}', which is not inside '${realRoot}'.`,
        ),
      );
      continue;
    }
    const resolvedRelative = relative(realRoot, real).split(sep).join("/");
    if (resolvedRelative !== file.path) {
      diagnostics.push(
        error(
          `Prepared STAC material '${file.path}' resolves to '${resolvedRelative}', a different path inside the materials root.`,
        ),
      );
      continue;
    }
    const bytes = readFileSync(real);
    if (sha256(bytes) !== file.digest) {
      diagnostics.push(
        error(`Prepared STAC material '${file.path}' does not match its recorded digest.`),
      );
    }
    if (bytes.byteLength !== file.bytes) {
      diagnostics.push(
        error(`Prepared STAC material '${file.path}' does not match its recorded size.`),
      );
    }
  }

  // 3. The entry and every stylesheet are declared, not merely present.
  const declaredSet = new Set(declared);
  if (!declaredSet.has(manifest.entry)) {
    diagnostics.push(
      error(
        `The prepared STAC materials declare the entry '${manifest.entry}', which is not a listed file.`,
      ),
    );
  }
  for (const style of manifest.styles ?? []) {
    if (!declaredSet.has(style)) {
      diagnostics.push(
        error(
          `The prepared STAC materials declare the stylesheet '${style}', which is not a listed file.`,
        ),
      );
    }
  }

  // 4. The tree is closed: nothing present that is not declared.
  const present: string[] = [];
  const problems: string[] = [];
  try {
    walk(realRoot, "", present, problems);
  } catch (cause) {
    diagnostics.push(
      error(`The STAC materials root '${root}' cannot be read: ${(cause as Error).message}`),
    );
    return diagnostics;
  }
  for (const problem of problems) {
    diagnostics.push(
      error(
        `The prepared STAC materials contain an entry that is not a regular file: ${problem}.`,
        "The prepared tree is copied verbatim into the artifact, so it may contain files and directories only.",
      ),
    );
  }
  for (const path of present.sort(compareCodePoints)) {
    if (!declaredSet.has(path)) {
      diagnostics.push(
        error(
          `The prepared STAC materials contain '${path}', which the manifest does not declare.`,
          "An undeclared file has no recorded digest, so shipping it would put unidentified bytes in the artifact.",
        ),
      );
    }
  }

  // 5. The tree digest, recomputed rather than believed.
  const recomputed = treeDigestOf(manifest.files);
  if (recomputed !== manifest.treeDigest) {
    diagnostics.push(
      error(
        `The prepared STAC materials record the tree digest ${manifest.treeDigest}, but the listed files hash to ${recomputed}.`,
      ),
    );
  }

  return diagnostics;
}
