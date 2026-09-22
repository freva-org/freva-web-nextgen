/**
 * The recipe, and the checks that make it mean something.
 *
 * `upstream.json` is the one authoritative description of how the embeddable STAC Browser is
 * constructed, and this module is the only place that reads it, so preparation, the upgrade
 * workflow and the tests cannot drift apart on what the pin says. Nothing here fetches or builds:
 * it answers questions about a checkout - right commit, the lockfile the recipe was written
 * against, the LICENSE we recorded - and computes the cache key. The doing lives in `prepare.mjs`.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RECIPE_FILE = resolve(PKG_ROOT, "upstream.json");

export const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const digestOfFile = (path) => sha256(readFileSync(path));

export function readRecipe() {
  const recipe = JSON.parse(readFileSync(RECIPE_FILE, "utf-8"));
  if (recipe.kind !== "stac-browser-recipe" || recipe.schemaVersion !== 1) {
    throw new Error(
      `${RECIPE_FILE} is not a version 1 stac-browser-recipe. Refusing to prepare from an ` +
        "unrecognised recipe: every later check reads fields this one may not have.",
    );
  }
  return recipe;
}

/** The ordered patch series, as absolute paths, in the order the recipe states. */
export function patchSeries(recipe) {
  const dir = resolve(PKG_ROOT, recipe.patches.directory);
  return recipe.patches.series.map((entry) => ({ ...entry, path: resolve(dir, entry.name) }));
}

/**
 * Fail unless every patch file is byte-for-byte the one the recipe describes. A patch is source
 * that ships in the published package while the application it patches does not, so an edited
 * patch could alter what a deployment builds without altering anything the deployment can see.
 */
export function assertPatchDigests(recipe) {
  const problems = [];
  for (const patch of patchSeries(recipe)) {
    if (!existsSync(patch.path)) {
      problems.push(`${patch.name} is missing from ${recipe.patches.directory}/`);
      continue;
    }
    const actual = digestOfFile(patch.path);
    if (actual !== patch.digest) {
      problems.push(`${patch.name} is ${actual}, the recipe records ${patch.digest}`);
    }
  }
  if (problems.length) {
    throw new Error(
      `The patch series does not match the recipe:\n  ${problems.join("\n  ")}\n` +
        "A patch and its recorded digest are changed together, in one reviewed commit. If the " +
        "patch is correct, update upstream.json; if the digest is correct, restore the patch.",
    );
  }
}

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * Fail unless the checkout is exactly the pinned commit, in the expected repository. The tag is
 * checked too, but only for a better message: a moved tag is reported as a moved tag rather than
 * as an anonymous digest mismatch.
 */
export function assertPinnedCheckout(dir, recipe) {
  if (!existsSync(resolve(dir, ".git"))) {
    throw new Error(
      `${dir} is not a git checkout, so its revision cannot be verified. Prepared materials are ` +
        "only ever built from a checkout whose object name has been read.",
    );
  }
  const head = git(["rev-parse", "HEAD"], dir);
  if (head !== recipe.commit) {
    let moved = "";
    try {
      const tagged = git(["rev-parse", `refs/tags/${recipe.tag}^{commit}`], dir);
      if (tagged !== recipe.commit) {
        moved =
          `\n  The tag ${recipe.tag} in this checkout points at ${tagged}, not at the pinned ` +
          "commit. A moved tag is exactly what pinning by object name exists to survive.";
      }
    } catch {
      // the tag need not be present in a single-commit fetch
    }
    throw new Error(
      `Upstream checkout is at ${head}; the recipe pins ${recipe.commit} (${recipe.tag}).${moved}\n` +
        "  Refusing to build an unpinned revision. See UPSTREAM.md, 'Upgrading'.",
    );
  }
  return head;
}

/** The upstream lockfile has to be the one the recipe was written against. */
export function assertLockfile(dir, recipe) {
  const lock = resolve(dir, recipe.lockfile);
  if (!existsSync(lock)) {
    throw new Error(`${recipe.lockfile} is missing from the upstream checkout at ${dir}.`);
  }
  const actual = digestOfFile(lock);
  if (actual !== recipe.lockfileDigest) {
    throw new Error(
      `The upstream ${recipe.lockfile} is ${actual}; the recipe records ${recipe.lockfileDigest}.\n` +
        "  The dependency tree decides what ends up in the compiled bundle, so a different " +
        "lockfile is a different artifact even at the same commit. Move the pin deliberately.",
    );
  }
  return actual;
}

/** The licence text has to be the one that was reviewed, not merely a file called LICENSE. */
export function assertLicense(dir, recipe) {
  const file = resolve(dir, recipe.licenseFile);
  if (!existsSync(file)) {
    throw new Error(
      `${recipe.licenseFile} is missing from the upstream checkout. An enabled deployment serves ` +
        "this application to visitors and must ship its licence.",
    );
  }
  const actual = digestOfFile(file);
  if (actual !== recipe.licenseDigest) {
    throw new Error(
      `The upstream ${recipe.licenseFile} is ${actual}; the recipe records ${recipe.licenseDigest}.\n` +
        "  Upstream may have relicensed. Stop and refer this to project legal/provenance review " +
        "before preparing materials that would be redistributed under the recorded terms.",
    );
  }
  return actual;
}

/** A major-version mismatch changes what the bundler emits; refuse rather than mislabel it. */
export function assertToolchain(recipe) {
  const node = Number(process.versions.node.split(".")[0]);
  const [, low, high] = /^>=(\d+) <(\d+)$/.exec(recipe.toolchain.nodeRange) ?? [];
  if (low && (node < Number(low) || node >= Number(high))) {
    throw new Error(
      `Node ${process.versions.node} is outside the recipe's supported range ` +
        `${recipe.toolchain.nodeRange}. The recorded output digests were produced on Node ` +
        `${recipe.toolchain.node}; a different major version produces a different bundle under ` +
        "the same name.",
    );
  }
  return { node: process.versions.node };
}

/**
 * The cache key: everything that can change the bytes, and nothing that cannot. A private CI cache
 * may reuse a result under this key; it may never reuse one whose manifest or tree digest does not
 * match, which is why the key is recorded *beside* the digests rather than instead of them.
 */
export function cacheKey(recipe) {
  const parts = [
    `commit=${recipe.commit}`,
    `lockfile=${recipe.lockfileDigest}`,
    ...patchSeries(recipe).map((p, i) => `patch${i}=${p.name}:${p.digest}`),
    `recipe=${recipe.recipeVersion}`,
    `build=${recipe.buildMode}`,
    `node=${process.versions.node.split(".")[0]}`,
    `npm=${npmMajor()}`,
  ];
  return { key: sha256(parts.join("\n")), parts };
}

function npmMajor() {
  try {
    return execFileSync("npm", ["--version"], { encoding: "utf-8" }).trim().split(".")[0];
  } catch {
    return "unknown";
  }
}
