/**
 * The page's half of the access recipes: validating a store, and filling a template's one hole.
 *
 * THE RECIPES THEMSELVES ARE DATA, in `schema/tree-recipes.json`, read by the build to hash them
 * and by this module to render them. They live under `schema/` because that directory is
 * published: `src/` reaches a consumer only as compiled `dist/` while `client/` ships as
 * TypeScript, so a `client/` import of anything under `src/` fails with `UNRESOLVED_IMPORT` in
 * every consumer and in no build made from inside this repository. The digest is over those same
 * published bytes on both sides.
 *
 * What is here is what only makes sense in a browser: the check that a store identifier really is
 * one of the archive's, and the substitution.
 */

import recipeFile from "../../schema/tree-recipes.json";

/** One way to open a store, and what it needs to run. Mirrors the build's own reader. */
export interface TreeRecipe {
  id: string;
  label: string;
  /**
   * Prose above the snippet, when the snippet does not already say it. Absent from the HTTP recipe
   * on purpose: "open the store directly over HTTPS" above `xr.open_dataset("https://...")` is the
   * code in English, taking a line of a panel that is already inside a details panel in a row.
   */
  description?: string;
  /** The source, with `{{STORE}}` where the validated store value goes. */
  template: string;
  /** Which form of the store's address the hole takes. */
  parameter: "https-url" | "s3-path";
  /** Pyodide packages the snippet imports. Empty means it runs on a bare interpreter. */
  requires: readonly string[];
}

export const TREE_RECIPES: readonly TreeRecipe[] = recipeFile.recipes as readonly TreeRecipe[];

/** The single hole a recipe template has. Exported so the runner can recognise a template. */
export const STORE_PLACEHOLDER = "{{STORE}}";

export {
  bindStore,
  pythonStringBody,
  renderRecipe,
  type StoreBinding,
} from "./tree-recipes-core.js";
