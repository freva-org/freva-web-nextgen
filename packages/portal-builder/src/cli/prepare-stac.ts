// `prepare-stac`: the STAC Browser preparation stage, from an npm install.
//
// The recipe (pin, patch series, preparation scripts, licence evidence) is Freva's and lives in
// `packages/stac-browser`; it ships in this package as `stac-recipe/`, copied at pack time by
// `scripts/vendor-stac-recipe.mjs`. This command runs exactly that recipe - same `prepare.mjs`,
// gates and cache key - and adds `prepare-playground`'s cache behaviour: a directory whose
// provenance carries the current key AND whose files verify against their manifest is kept;
// anything else is prepared again. `--cache-key` prints the key only, so CI can key a cache
// before the network stage.
//
// Unlike `validate` and `build`, it opens sockets (the pinned commit and upstream's dependencies)
// and needs `git` and `npm` on PATH.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PACKAGE_ROOT } from "../util/package.js";
import {
  loadStacMaterials,
  PROVENANCE_NAME,
  verifyMaterials,
} from "../components/stac-browser/materials.js";
import type { CliIo } from "./index.js";

export interface PrepareStacOptions {
  outDir: string;
  /** Prepare again even when the output is current and verifies. */
  force?: boolean;
  /** Print the cache key for these inputs and exit. */
  cacheKeyOnly?: boolean;
  /** An existing checkout or mirror of upstream, instead of a fetch. Still verified. */
  upstream?: string;
  /** Where the fetched upstream checkout is kept between runs. */
  checkoutDir?: string;
}

/**
 * Where the recipe is: in a repository checkout, the workspace itself - the source of truth, which a
 * `stac-recipe/` left behind by an earlier `npm pack` could only be a stale copy of; in an
 * installed package, the copy it ships. Never a search beyond those two.
 */
export function locateStacRecipe(root: string = PACKAGE_ROOT): string | undefined {
  for (const candidate of [resolve(root, "..", "stac-browser"), join(root, "stac-recipe")]) {
    if (
      existsSync(join(candidate, "upstream.json")) &&
      existsSync(join(candidate, "scripts", "prepare.mjs"))
    ) {
      return candidate;
    }
  }
  return undefined;
}

/** The recipe's own cache key, computed by the recipe's own code. */
export function stacCacheKey(recipe: string): string {
  const run = spawnSync(process.execPath, [join(recipe, "scripts", "prepare.mjs"), "--cache-key"], {
    encoding: "utf8",
  });
  if (run.status !== 0) {
    throw new Error(`the recipe could not compute its cache key: ${run.stderr || run.stdout}`);
  }
  return run.stdout.trim();
}

/**
 * Why a directory is not reusable under `key`, or `[]` when it is. Bytes, not presence: the files
 * are hashed against their manifest, and the provenance must name the key these inputs produce.
 * With `expectedPatchedSource` (the recipe's recorded patch result), provenance without the same
 * value did not pass the patched-source gate, and the directory is prepared again.
 */
export function stacMaterialsProblems(
  dir: string,
  key: string,
  expectedPatchedSource?: string,
): string[] {
  if (!existsSync(join(dir, "materials.json"))) return ["no materials.json"];
  let provenance: { cacheKey?: string; patchedSourceDigest?: string };
  try {
    provenance = JSON.parse(readFileSync(join(dir, PROVENANCE_NAME), "utf8")) as typeof provenance;
  } catch {
    return [`no readable ${PROVENANCE_NAME}`];
  }
  const problems: string[] = [];
  const recorded = provenance.cacheKey;
  if (recorded !== key) {
    problems.push(`prepared under cache key ${recorded ?? "(none)"}, the inputs now give ${key}`);
  }
  if (expectedPatchedSource && provenance.patchedSourceDigest !== expectedPatchedSource) {
    problems.push(
      `records patched source ${provenance.patchedSourceDigest ?? "(none)"}, the recipe expects ` +
        expectedPatchedSource,
    );
  }
  const loaded = loadStacMaterials(dir);
  if (!loaded.materials) {
    problems.push(...loaded.diagnostics.map((d) => d.message));
  } else {
    problems.push(...verifyMaterials(loaded.materials).map((d) => d.message));
  }
  return problems;
}

export async function prepareStac(options: PrepareStacOptions, io: CliIo): Promise<number> {
  const recipe = locateStacRecipe();
  if (!recipe) {
    io.err(
      "This installation of @freva-org/portal-builder carries no STAC Browser recipe " +
        "(stac-recipe/ is missing). Reinstall the package, or run 'npm run stac:prepare' from a " +
        "checkout of freva-web-nextgen.\n",
    );
    return 1;
  }
  const pin = JSON.parse(readFileSync(join(recipe, "upstream.json"), "utf8")) as {
    recipeVersion: string;
    tag: string;
    commit: string;
    expected?: { patchedSourceDigest?: string };
  };
  const expectedPatchedSource = pin.expected?.patchedSourceDigest || undefined;

  let key: string;
  try {
    key = stacCacheKey(recipe);
  } catch (error) {
    io.err(`${(error as Error).message}\n`);
    return 1;
  }
  if (options.cacheKeyOnly) {
    io.out(`${key}\n`);
    return 0;
  }

  const out = resolve(options.outDir);
  io.out(`recipe         ${pin.recipeVersion} (${pin.tag}, ${pin.commit})\n`);
  io.out(`cache key      ${key}\n`);
  io.out(`out            ${out}\n`);

  if (!options.force && existsSync(out)) {
    const problems = stacMaterialsProblems(out, key, expectedPatchedSource);
    if (problems.length === 0) {
      io.out(`\nAlready prepared and verified at ${out}.\n`);
      printNext(io, options.outDir);
      return 0;
    }
    io.err(`the materials at ${out} are not reusable and will be prepared again:\n`);
    for (const problem of problems.slice(0, 6)) io.err(`  - ${problem}\n`);
    if (problems.length > 6) io.err(`  … and ${problems.length - 6} more\n`);
  }

  // The fetched checkout is kept beside the output rather than inside the recipe, which lives
  // under node_modules in an installed package and may be read-only there. It is a cache of a
  // verified commit and is re-verified on every run.
  const checkout = resolve(options.checkoutDir ?? join(dirname(out), ".stac-upstream"));
  const args = [join(recipe, "scripts", "prepare.mjs"), "--out", out];
  if (options.upstream) args.push("--upstream", resolve(options.upstream));
  if (options.force) args.push("--force");
  const run = spawnSync(process.execPath, args, {
    cwd: recipe,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, FREVA_STAC_CHECKOUT_DIR: checkout },
  });
  if (run.status !== 0) {
    io.err(
      `\nSTAC Browser preparation failed (exit ${run.status ?? run.signal}). Nothing was ` +
        "published: the destination is unchanged.\n",
    );
    return 1;
  }

  // The recipe verified its own staged tree; this checks the published one the way `build`
  // will, so a directory this command reports as prepared is one `build` accepts.
  const problems = stacMaterialsProblems(out, key, expectedPatchedSource);
  if (problems.length > 0) {
    io.err(`\nthe prepared materials do not verify:\n`);
    for (const problem of problems) io.err(`  - ${problem}\n`);
    return 1;
  }
  io.out(`\nprepared and verified ${out}\n`);
  printNext(io, options.outDir);
  return 0;
}

function printNext(io: CliIo, outDir: string): void {
  io.out("Pass it to the build:\n");
  io.out(`  freva-portal-builder build --config <portal.yaml> --stac-materials ${outDir}\n`);
}
