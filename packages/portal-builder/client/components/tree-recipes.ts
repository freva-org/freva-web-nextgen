/**
 * The page's half of the access recipes: validating a store, and filling a template's one hole.
 *
 * The recipes and the rules are shared with every host of a live tree and live in
 * `@freva-org/dataset-tree/recipes`. The build (`src/model/recipe-templates.ts`) hashes the same
 * template bytes, and `schema/tree-recipes.json` publishes them for tools that read data rather
 * than code; a test keeps the three identical.
 */

export {
  STORE_PLACEHOLDER,
  TREE_RECIPES,
  bindStore,
  pythonStringBody,
  renderRecipe,
  type StoreBinding,
  type TreeRecipe,
} from "@freva-org/dataset-tree/recipes";
