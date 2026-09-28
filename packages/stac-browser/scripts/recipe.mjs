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
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
 * Written into the `.git` of every checkout this recipe fetches. A checkout at the wrong revision
 * is discarded and refetched, and the directory can be supplied (`FREVA_STAC_CHECKOUT_DIR`,
 * `prepare-stac --checkout-dir`), so without the marker a mistyped path could delete a repository.
 */
export const CHECKOUT_MARKER = "freva-stac-recipe-checkout";

/** Mark a checkout as this recipe's own, right after `git init`. */
export function claimCheckout(dir) {
  writeFileSync(
    resolve(dir, ".git", CHECKOUT_MARKER),
    "Fetched by the Freva STAC Browser recipe; it may discard and refetch this checkout.\n",
  );
}

/**
 * What a run may do with its checkout directory (a `--upstream` mirror is only ever read):
 * - `"fetch"`: absent or empty - fetch the pinned commit into it;
 * - `"reuse"`: a checkout this recipe fetched - verify it, refetch it at the wrong revision.
 *   `ownDefault` extends this to the package's own `.upstream`, which may lack the marker;
 * - `"refuse"`: anything else, which is neither written to nor deleted.
 */
export function checkoutVerdict(dir, { ownDefault = false } = {}) {
  if (!existsSync(dir)) return "fetch";
  if (!statSync(dir).isDirectory()) return "refuse";
  if (readdirSync(dir).length === 0) return "fetch";
  if (existsSync(resolve(dir, ".git", CHECKOUT_MARKER))) return "reuse";
  if (ownDefault && existsSync(resolve(dir, ".git"))) return "reuse";
  return "refuse";
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
    `procedure=${procedureDigest()}`,
    `build=${recipe.buildMode}`,
    `node=${process.versions.node.split(".")[0]}`,
    `npm=${npmMajor()}`,
  ];
  return { key: sha256(parts.join("\n")), parts };
}

/**
 * The scripts that turn the pinned inputs into materials. They decide which source is checked,
 * which environment the bundler sees and what the tree records, so they are in the cache key: a
 * cache made by another procedure must not count as prepared. `pin.mjs` only edits the recipe.
 */
export const PROCEDURE_SCRIPTS = [
  "build.mjs",
  "dist-record.mjs",
  "prepare-materials.mjs",
  "prepare.mjs",
  "publish.mjs",
  "recipe.mjs",
  "upstream.mjs",
];

export function procedureDigest() {
  const hash = createHash("sha256");
  for (const name of PROCEDURE_SCRIPTS) {
    hash
      .update(name)
      .update("\0")
      .update(digestOfFile(resolve(PKG_ROOT, "scripts", name)));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function npmMajor() {
  try {
    return execFileSync("npm", ["--version"], { encoding: "utf-8" }).trim().split(".")[0];
  } catch {
    return "unknown";
  }
}

/**
 * The digest of the PATCH RESULT: every file in `patchedTree.files`, by content, after the series
 * and the runtime-config toggle. It depends only on the pinned commit and the patches, so with a
 * matching patch result a tree-digest mismatch is the toolchain; a different one is a defect.
 * Paths sort by code point, never by locale, as everywhere in the repository.
 */
export function patchedSourceDigest(dir, recipe) {
  const files = [...recipe.patchedTree.files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const rel of files) {
    const path = resolve(dir, rel);
    if (!existsSync(path)) {
      throw new Error(
        `The patched tree records '${rel}', but it is not in the checkout at ${dir}.`,
      );
    }
    hash.update(rel).update("\0").update(digestOfFile(path)).update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Stop unless the patch result is the one the recipe records. Unlike the tree digest this is a
 * GATE: no toolchain changes what `git apply` writes from a verified patch to a verified commit, so
 * a difference means the checkout, the patches or line-ending handling differ, and the build would
 * compile unreviewed source. A recipe without the field is not checked.
 */
export function assertPatchedSource(dir, recipe) {
  const actual = patchedSourceDigest(dir, recipe);
  const expected = recipe.expected?.patchedSourceDigest;
  if (expected && actual !== expected) {
    throw new Error(
      `The patched upstream source is ${actual}; the recipe records ${expected}.\n` +
        "  The commit, the lockfile and every patch digest verified, so the patch RESULT differs:\n" +
        "  usually git's line-ending conversion (core.autocrlf / .gitattributes) or a checkout\n" +
        "  that was modified after verification. This is not a toolchain difference and the build\n" +
        "  stops rather than compile source that was not reviewed.\n" +
        "  If a patch was changed on purpose (its digest was updated in the same commit), clear\n" +
        "  expected.patchedSourceDigest in upstream.json, prepare, and record the result with\n" +
        "  `node packages/stac-browser/scripts/pin.mjs --materials <dir>`.",
    );
  }
  return actual;
}

/**
 * What the bundler ran on, for provenance and the mismatch note. Not a gate: the tree digest
 * reproduces across Node 22/24 and npm 10/11, so a version explains a difference, never refuses it.
 */
export function toolchainFingerprint() {
  let npm = "unknown";
  try {
    npm = execFileSync("npm", ["--version"], { encoding: "utf-8" }).trim();
  } catch {
    // recorded as unknown rather than failing a provenance write
  }
  return { node: process.versions.node, npm, platform: process.platform, arch: process.arch };
}

/**
 * The environment upstream's build runs in: the caller's, minus what upstream's `vite.config.js`
 * reads as configuration (and `NODE_ENV`), plus the recipe's own. Upstream compiles every `SB_*`
 * variable into the bundle (`CONFIG_FROM_ENV`) and reads `SB_CONFIG`, `DYNAMIC_CONFIG` and
 * `STAC_BROWSER_E2E`: inherited, they would change the bytes and the visitors' configuration unseen
 * by the recipe and the cache key. `PATH`, `HOME`, npm cache and proxy settings pass through.
 */
export function upstreamBuildEnv(base, recipeEnv) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("SB_")) continue;
    if (key === "DYNAMIC_CONFIG" || key === "STAC_BROWSER_E2E" || key === "NODE_ENV") continue;
    env[key] = value;
  }
  return { ...env, ...recipeEnv };
}
