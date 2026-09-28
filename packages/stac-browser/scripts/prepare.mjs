#!/usr/bin/env node
/**
 * THE supported STAC Browser preparation command.
 *
 *     npm run stac:prepare -- --out <dir>
 *
 * The one network-enabled, isolated stage: it fetches the pinned upstream revision, verifies it
 * against the recipe, applies the reviewed patch series, installs upstream's own dependency tree
 * from upstream's own lockfile, builds, and emits a verified materials directory. Nothing else
 * here fetches or compiles upstream - `npm ci`, a workspace build and every non-STAC test
 * complete with no upstream checkout and none of upstream's ~800 dependencies, a deployment that
 * does not enable the `stac-browser` component never runs this, and the published packages and
 * the base builder image do not contain its output. It never runs at server startup: "prepared
 * when requested" means deployment build time.
 *
 * Options:
 *   --out <dir>       where to write the materials (default: packages/stac-browser/materials)
 *   --upstream <dir>  an existing checkout or local mirror instead of a fetch; the commit is still
 *                     verified, so a mirror cannot substitute a different revision
 *   $FREVA_STAC_CHECKOUT_DIR  where to keep the fetched checkout (default: <recipe>/.upstream)
 *   --cache-key       print the cache key for these inputs and exit, changing nothing
 *   --force           rebuild even if the compiled tree already verifies
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertLicense,
  assertLockfile,
  assertPatchDigests,
  assertPinnedCheckout,
  assertToolchain,
  cacheKey,
  checkoutVerdict,
  claimCheckout,
  digestOfFile,
  git,
  patchedSourceDigest,
  patchSeries,
  PKG_ROOT,
  readRecipe,
  toolchainFingerprint,
} from "./recipe.mjs";
import { assertPublishable, publishStaged } from "./publish.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const recipe = readRecipe();

if (flag("cache-key")) {
  const { key, parts } = cacheKey(recipe);
  process.stdout.write(`${key}\n`);
  if (flag("verbose")) process.stdout.write(`${parts.join("\n")}\n`);
  process.exit(0);
}

const OUT = resolve(value("out") ?? resolve(PKG_ROOT, "materials"));
const MIRROR = value("upstream") ?? process.env.FREVA_STAC_UPSTREAM_DIR;
// The VERIFIED SOURCE: read from, never written to after this point - not the shared `.upstream`
// cache, not a caller's mirror. Patching and installing happen in the workspace below.
// `FREVA_STAC_CHECKOUT_DIR` moves the fetched checkout elsewhere. Inside
// `@freva-org/portal-builder` the recipe sits under `node_modules`, possibly read-only, so
// `prepare-stac` points it beside the output.
const SOURCE = MIRROR
  ? resolve(MIRROR)
  : resolve(process.env.FREVA_STAC_CHECKOUT_DIR ?? resolve(PKG_ROOT, ".upstream"));

// The disposable workspace this run patches, installs and builds in. Building directly in
// `SOURCE` would patch a supplied mirror and install `node_modules` into it, and two concurrent
// preparations sharing `.upstream` - or the package's `dist/` - would each verify files the other
// had written. It is removed in a `finally`, so a failed run leaves the source and the
// destination as it found them.
const WORKSPACE = mkdtempSync(join(tmpdir(), "stac-prepare-"));
const UPSTREAM = resolve(WORKSPACE, "src");
const WORK_DIST = resolve(WORKSPACE, "dist");
// Discarded however this run ends. A throw exits the process, so an exit handler covers both the
// success and the failure path without wrapping the whole script.
process.on("exit", () => rmSync(WORKSPACE, { recursive: true, force: true }));

/** Refuse an impossible destination before doing any work, not after the build. */
assertPublishable(OUT, { packageRoot: PKG_ROOT });

// ...and a checkout directory this run may not touch: one at the wrong revision is discarded, so a
// supplied path is refused, before anything in it changes, unless this recipe fetched it.
const CHECKOUT = MIRROR
  ? "mirror"
  : checkoutVerdict(SOURCE, { ownDefault: SOURCE === resolve(PKG_ROOT, ".upstream") });
if (CHECKOUT === "refuse") {
  throw new Error(
    `${SOURCE} is not a checkout this recipe fetched, so it is neither reused nor deleted. ` +
      "Point the checkout directory (FREVA_STAC_CHECKOUT_DIR, or prepare-stac --checkout-dir) at " +
      "a new or empty directory, or pass an existing upstream checkout as --upstream: it is then " +
      "verified and only read.",
  );
}

const say = (line) => process.stdout.write(`[stac-prepare] ${line}\n`);
const step = (n, line) => say(`${n}. ${line}`);

function run(cmd, args, cwd, env = {}) {
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

say(`recipe ${recipe.recipeVersion}: ${recipe.name} ${recipe.tag} (${recipe.commit})`);

step(1, "toolchain and patch series");
const toolchain = assertToolchain(recipe);
assertPatchDigests(recipe);
say(`node ${toolchain.node}; ${recipe.patches.series.length} patch(es), digests match`);

step(2, MIRROR ? `using the supplied checkout ${UPSTREAM}` : "fetching the pinned commit");
// An isolated directory, and a single-commit fetch rather than a clone - the smallest transfer
// that still lets the object name be read. A mirror, for air-gapped CI, gets the same checks.
if (!MIRROR) {
  // Only a checkout this recipe fetched gets here with contents (see CHECKOUT above).
  if (CHECKOUT === "reuse") {
    try {
      assertPinnedCheckout(SOURCE, recipe);
      say(`the checkout at ${SOURCE} is already at the pinned commit`);
    } catch {
      say(`the checkout at ${SOURCE} is at the wrong revision; discarding it and refetching`);
      rmSync(SOURCE, { recursive: true, force: true });
    }
  }
  if (!existsSync(resolve(SOURCE, ".git"))) {
    mkdirSync(SOURCE, { recursive: true });
    git(["init", "--quiet"], SOURCE);
    claimCheckout(SOURCE); // before the fetch, so a failed fetch leaves a checkout it may discard
    git(["remote", "add", "origin", recipe.repository], SOURCE);
    run("git", ["fetch", "--quiet", "--depth", "1", "origin", recipe.commit], SOURCE);
    git(["checkout", "--quiet", "FETCH_HEAD"], SOURCE);
  }
}
// The repository a checkout came from is part of what is being verified: a mirror that resolves
// the right object name from an unexpected remote is still an unexpected supply chain.
try {
  const origin = git(["remote", "get-url", "origin"], SOURCE);
  const normal = (url) => url.replace(/\.git$/, "").replace(/\/$/, "");
  if (normal(origin) !== normal(recipe.repository) && !MIRROR) {
    throw new Error(`The checkout's origin is ${origin}; the recipe records ${recipe.repository}.`);
  }
  if (MIRROR && normal(origin) !== normal(recipe.repository)) {
    say(`note: supplied mirror's origin is ${origin} (recipe: ${recipe.repository})`);
  }
} catch (error) {
  if (!MIRROR) throw error;
}
assertPinnedCheckout(SOURCE, recipe);
say(`checkout verified at ${recipe.commit}`);

// Nothing outside the series may already be modified in the source. The build resets the files
// the patches own, so a source left dirty by an earlier in-place build is recoverable; anything
// else would be copied into the workspace and compiled into the result. This holds a supplied
// mirror to the same verification in its working tree, not just in its object name.
const seriesOwned = new Set([
  "index.html",
  ...patchSeries(recipe).flatMap((patch) =>
    readFileSync(resolve(PKG_ROOT, recipe.patches.directory, patch.name), "utf-8")
      .split("\n")
      .filter((line) => line.startsWith("+++ b/"))
      .map((line) => line.slice("+++ b/".length).trim()),
  ),
]);
const foreign = git(["diff", "--name-only"], SOURCE)
  .split("\n")
  .filter(Boolean)
  .filter((file) => !seriesOwned.has(file));
if (foreign.length) {
  throw new Error(
    `The upstream checkout has modifications outside the patch series: ${foreign.join(", ")}. ` +
      "Preparation compiles what is in the checkout, so an unexplained edit would be built into " +
      "the materials. Discard them, or point --upstream at a clean mirror.",
  );
}

// Copy the verified source into this run's workspace. `.git` comes with it: the build applies the
// series with `git apply` and asserts the modified set with `git diff`, so the history is part of
// what makes the patching verifiable. `node_modules` does not - the workspace installs from the
// pinned lockfile, and copying somebody else's install is slow and lets a dependency outside the
// lockfile reach the build. Nothing is written back, which is what makes a mirror safe.
cpSync(SOURCE, UPSTREAM, {
  recursive: true,
  filter: (from) => !from.split(/[\\/]/).includes("node_modules"),
});
say(`working copy at ${UPSTREAM}`);

step(3, "lockfile and licence");
assertLockfile(SOURCE, recipe);
assertLicense(SOURCE, recipe);
say(`${recipe.lockfile} and ${recipe.licenseFile} match the recipe`);

step(4, "patch, install and build");
// Delegated to build.mjs, which owns the CSS containment pass and the closed build record. It
// re-runs the gates above rather than trusting this caller - it is also reachable directly.
run("node", [resolve(PKG_ROOT, "scripts", "build.mjs")], PKG_ROOT, {
  FREVA_STAC_UPSTREAM_DIR: UPSTREAM,
  FREVA_STAC_DIST_OUT: WORK_DIST,
  ...(flag("force") ? { FREVA_STAC_FORCE_BUILD: "1" } : {}),
});

// Re-read from the workspace, not taken from build.mjs's log: this is what provenance records.
const patchedSource = patchedSourceDigest(UPSTREAM, recipe);
const machine = toolchainFingerprint();

step(5, "assembling verified materials");
// Staged, not published: the containment assertions and the provenance record below belong to the
// staged tree, and only a tree that passes all of them is renamed into place.
const STAGED = execFileSync("node", [resolve(PKG_ROOT, "scripts", "prepare-materials.mjs")], {
  cwd: PKG_ROOT,
  encoding: "utf-8",
  env: {
    ...process.env,
    FREVA_STAC_UPSTREAM_DIR: UPSTREAM,
    FREVA_STAC_DIST_OUT: WORK_DIST,
    FREVA_STAC_MATERIALS_OUT: OUT,
    FREVA_STAC_STAGE_ONLY: "1",
  },
}).trim();
say(`staged at ${STAGED}`);

step(6, "provenance, cache key and containment");
const manifest = JSON.parse(readFileSync(resolve(STAGED, "materials.json"), "utf-8"));
const { key, parts } = cacheKey(recipe);

// Nothing from the upstream checkout may reach the artifact: no source, no Git metadata, no
// node_modules. Asserted against the produced tree rather than inferred from what was copied.
const leaked = manifest.files.filter(
  (f) => f.path === ".git" || f.path.startsWith(".git/") || f.path.includes("node_modules/"),
);
if (leaked.length) {
  throw new Error(
    `Prepared materials contain upstream repository or dependency files: ${leaked
      .map((f) => f.path)
      .join(", ")}`,
  );
}
for (const forbidden of recipe.output.forbiddenFiles) {
  if (manifest.files.some((f) => f.path === forbidden)) {
    throw new Error(
      `Prepared materials contain '${forbidden}', which the recipe forbids. The portal generates ` +
        "the route document and the runtime configuration itself; a second copy is a second, " +
        "unused entry point into the same application.",
    );
  }
}
if (manifest.files.length < recipe.output.minFiles) {
  throw new Error(
    `Prepared materials contain ${manifest.files.length} files; the recipe expects at least ` +
      `${recipe.output.minFiles}. A tree this small is a failed build, not a small application.`,
  );
}

const provenance = {
  schemaVersion: 1,
  kind: "stac-browser-provenance",
  preparedBy: "@freva-org/stac-browser prepare",
  recipeVersion: recipe.recipeVersion,
  recipeDigest: digestOfFile(resolve(PKG_ROOT, "upstream.json")),
  upstream: {
    repository: recipe.repository,
    tag: recipe.tag,
    commit: recipe.commit,
    lockfileDigest: recipe.lockfileDigest,
    licenseSpdx: recipe.license,
    licenseDigest: recipe.licenseDigest,
  },
  patches: patchSeries(recipe).map((p) => ({
    name: p.name,
    digest: p.digest,
    affects: p.affects,
    owner: p.owner,
  })),
  toolchain: machine,
  patchedSourceDigest: patchedSource,
  build: { mode: recipe.buildMode, env: recipe.build.env },
  cacheKey: key,
  cacheKeyParts: parts,
  materials: {
    treeDigest: manifest.treeDigest,
    fileCount: manifest.files.length,
    entry: manifest.entry,
    styles: manifest.styles,
  },
  adapterContract: {
    schemaVersion: recipe.adapterContract.schemaVersion,
    digest: digestOfFile(resolve(PKG_ROOT, recipe.adapterContract.file)),
  },
};
writeFileSync(resolve(STAGED, "PROVENANCE.json"), `${JSON.stringify(provenance, null, 2)}\n`);

// Everything above passed against the staged tree, so it becomes the published one, atomically.
publishStaged(STAGED, OUT, { packageRoot: PKG_ROOT });
say(`published to ${OUT}`);

// PROVENANCE.json lives in the materials directory but is not a material: re-listing the
// manifest's sibling would make the tree describe itself. The portal build reads it for the
// artifact's own provenance record and copies nothing.

if (manifest.treeDigest !== recipe.expected.materialsTreeDigest) {
  // build.mjs already gated the patched source, so a tree mismatch here is the bundler's output,
  // not a different patch result. The note shows both toolchains.
  const recorded = recipe.expected.recordedWith;
  say("");
  say(`NOTE: the prepared tree digest is ${manifest.treeDigest}`);
  say(`      the recipe expects           ${recipe.expected.materialsTreeDigest}`);
  say(
    `      patched source:              ${patchedSource} ` +
      (recipe.expected.patchedSourceDigest ? "(matches the recipe)" : "(the recipe records none)"),
  );
  say(
    `      this toolchain:              node ${machine.node}, npm ${machine.npm}, ` +
      `${machine.platform}/${machine.arch}`,
  );
  if (recorded) say(`      recorded on:                 ${recorded}`);
  say("      The patch result is identical, so the difference is in what upstream's bundler");
  say("      emitted on this machine. Compare the two materials.json file lists to see which");
  say("      assets differ; UPSTREAM.md, 'Reproducibility', lists what has been ruled out.");
}

say("");
say(`materials: ${OUT}`);
say(`entry:     ${manifest.entry}`);
say(`files:     ${manifest.files.length}`);
say(`tree:      ${manifest.treeDigest}`);
say(`cache key: ${key}`);
say("");
say("Pass this directory to the portal build:");
say(`  freva-portal-builder build --config <portal.yaml> --stac-materials ${OUT}`);
