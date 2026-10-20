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
 * The bytes live once, in `@freva-org/dataset-tree/recipes`: the build hashes the templates and the
 * page renders them, and two copies of a string whose digest is a security boundary is not a
 * duplication anyone should keep in step. This module is the build's reader; the page's is
 * `client/components/tree-recipes.ts`.
 */

import {
  TREE_RECIPES as SHARED_RECIPES,
  runnableRecipes as sharedRunnableRecipes,
  type TreeRecipe,
} from "@freva-org/dataset-tree/recipes";

export type { TreeRecipe };

/**
 * The one way to open a Zarr store on an S3-compatible gateway, anonymously: the shared
 * `TREE_RECIPES` of `@freva-org/dataset-tree/recipes` (see there for the template's shape). The
 * build hashes those bytes, the page renders the same ones, and `schema/tree-recipes.json`
 * publishes them for tools that read files; a test keeps it identical.
 */
export const TREE_RECIPES: readonly TreeRecipe[] = SHARED_RECIPES;

/** Which recipes a profile can actually execute. */
export function runnableRecipes(profilePackages: readonly string[]): readonly string[] {
  return sharedRunnableRecipes(profilePackages, TREE_RECIPES);
}
