// Store validation and template filling for the access recipes. The implementation is shared with
// every other host of a live tree (the JupyterLite data panel, documentation sites) and lives in
// `@freva-org/dataset-tree/recipes`; this module keeps the portal's import path stable.

export {
  bindStore,
  pythonStringBody,
  renderRecipe,
  type StoreBinding,
} from "@freva-org/dataset-tree/recipes";
