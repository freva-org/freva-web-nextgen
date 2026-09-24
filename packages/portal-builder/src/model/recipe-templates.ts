/**
 * The access recipes themselves: pure data, imported by both halves.
 *
 * A live archive's stores are discovered in the visitor's browser, so there is no build-time
 * catalogue to attach a snippet to - and composing the Python in the page is exactly what the
 * registered-example mechanism prevents: what travels to a runner must be a name and a digest,
 * never source. The recipes are therefore templates with one hole, registered and hashed by the
 * build; the page contributes the store's own identifier, a node id the source produced - data,
 * not code - validated against the configured endpoint and declared roots first.
 *
 * What is shown is not what is runnable: a recipe is drawn for every store as documentation, but
 * a `Try in Python` control appears only when the configured profile carries the packages the
 * recipe imports, since a button that prints `ModuleNotFoundError` is worse than no button.
 * `requires` keeps the two apart.
 *
 * The bytes live once, in `schema/tree-recipes.json`: the build hashes the templates and the page
 * renders them, and two copies of a string whose digest is a security boundary is not a
 * duplication anyone should keep in step. This module is the build's reader; the page's is
 * `client/components/tree-recipes.ts`, and `dataset-tree.ts`'s evidence plan owns both.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_DIR } from "../util/package.js";

/** One way to open a store, and what it needs to run. */
export interface TreeRecipe {
  /** Tab label. */
  id: string;
  label: string;
  /**
   * Prose above the snippet, when the snippet does not already say it. Absent from the HTTP
   * recipe on purpose: "open the store directly over HTTPS" above `xr.open_dataset("https://...")`
   * is the code in English, costing a line in a panel already nested inside a details row.
   */
  description?: string;
  /**
   * The source, with `{{STORE}}` where the validated store value goes. The placeholder sits
   * inside a Python string literal in every recipe, and the value reaching it is restricted to a
   * character set with no quote, backslash or control character, so the substitution cannot end
   * the literal it lands in. See `bindStore`.
   */
  template: string;
  /** Which form of the store's address the hole takes. */
  parameter: "https-url" | "s3-path";
  /** Pyodide packages the snippet imports. Empty means it runs on a bare interpreter. */
  requires: readonly string[];
}

/**
 * The one way to open a Zarr store on an S3-compatible gateway, anonymously.
 *
 * The recipes are read from `schema/tree-recipes.json`, not written here, for packaging reasons:
 * the build hashes each template and decides which are runnable, while
 * `client/components/tree-recipes.ts` renders one into a panel, and those two sit on opposite
 * sides of a published boundary - everything under `src/` reaches a consumer only as compiled
 * `dist/`, while `client/` ships as TypeScript for the consumer's own bundler. A module in one
 * imported from the other is either not shipped or not resolvable, so the data lives in a
 * published directory, both halves read the same bytes, and the digest is over those bytes.
 *
 * `xarray` over HTTPS is the only recipe shipped, because it is the one a browser can run - the
 * interpreter registers a filesystem for it. An `s3fs` route needs botocore and a credential
 * chain, is in no browser profile and could carry no run control; a deployment that wants one
 * adds it as its own example.
 *
 * `chunks={}` is deliberately absent from the HTTP recipe and the block ends in `print(ds)`; both
 * are recorded in `schema/tree-recipes.json` and explained in this package's docs. `chunks={}`
 * needs `dask`, which is not a Pyodide package, and a bare trailing expression prints nothing
 * under the file semantics a registered example runs with.
 */
interface RecipeFile {
  schemaVersion: number;
  recipes: TreeRecipe[];
}

export const TREE_RECIPES: readonly TreeRecipe[] = (
  JSON.parse(readFileSync(join(SCHEMA_DIR, "tree-recipes.json"), "utf8")) as RecipeFile
).recipes;

/** Which recipes a profile can actually execute. */
export function runnableRecipes(profilePackages: readonly string[]): readonly string[] {
  const have = new Set(profilePackages);
  return TREE_RECIPES.filter((recipe) => recipe.requires.every((name) => have.has(name))).map(
    (recipe) => recipe.id,
  );
}
