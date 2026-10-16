// recipes.ts - the public `@freva-org/dataset-tree/recipes` entry: how a live archive's dataset is
// opened from Python, as one shared implementation.
//
// A live (S3) tree discovers its stores in the visitor's browser, so there is no build-time
// catalogue to attach a snippet to. Instead a store is offered through recipes: templates with one
// hole, filled with a store identifier that was first validated against the configured endpoint
// and declared roots. Several hosts need exactly the same rules - a portal page, a JupyterLite data
// panel, a documentation site - and the rules are a security boundary (what reaches a Python string
// literal), so they live here once rather than in each host.
//
// Nothing here touches the DOM, fetches, or knows any framework. A host decides what a recipe's
// digest is registered as and how a "Try in Python" press reaches an interpreter; this module only
// says what the code is.

import type { DatasetAccessExample, DatasetTreeNode } from "./types.js";

/** One way to open a store, and what it needs to run. */
export interface TreeRecipe {
  /** Stable identifier. The access example a host shows is `recipe:<id>`. */
  id: string;
  /** Tab label. */
  label: string;
  /** Prose above the snippet, when the snippet does not already say it. */
  description?: string;
  /**
   * The source, with `{{STORE}}` (and optionally `{{ENDPOINT}}`) where validated values go. Every
   * hole sits inside a Python string literal. A host registers a digest over these exact bytes.
   */
  template: string;
  /** Which form of the store's address `{{STORE}}` takes. */
  parameter: "https-url" | "s3-path";
  /** Python packages the snippet imports. Empty means it runs on a bare interpreter. */
  requires: readonly string[];
}

/** The one hole every recipe has. */
export const STORE_PLACEHOLDER = "{{STORE}}";

/**
 * The recipes shipped with the package: one, xarray over HTTPS, the route a browser interpreter
 * can run (it registers a read-only filesystem for http(s)). `chunks={}` is absent on purpose (it
 * needs Dask), and the block ends in `print(ds)` because a bare trailing expression prints nothing
 * under the file semantics a registered example runs with.
 *
 * The template bytes are a contract: hosts hash them to register the recipe, so changing a single
 * character changes every registered digest. `@freva-org/portal-builder` publishes the same data
 * as `schema/tree-recipes.json`, and a test there keeps the two identical.
 */
export const TREE_RECIPES: readonly TreeRecipe[] = Object.freeze([
  Object.freeze({
    id: "http",
    label: "HTTP",
    template:
      'import xarray as xr\n\nds = xr.open_dataset(\n    "{{STORE}}",\n    engine="zarr",\n)\nprint(ds)\n',
    parameter: "https-url" as const,
    requires: Object.freeze(["xarray", "zarr", "fsspec"]),
  }),
]);

/** The access-example id a recipe is shown and registered under. */
export function recipeExampleId(recipeId: string): string {
  return `recipe:${recipeId}`;
}

/** Which recipes an interpreter that has `packages` can execute. */
export function runnableRecipes(
  packages: readonly string[],
  recipes: readonly TreeRecipe[] = TREE_RECIPES,
): string[] {
  const have = new Set(packages);
  return recipes.filter((r) => r.requires.every((name) => have.has(name))).map((r) => r.id);
}

/**
 * The characters a store value may contain: an allowlist, deliberately narrower than S3 permits.
 * What matters is not that every legal key passes - a key with a quote in it is vanishingly rare
 * and simply offers no recipe - but that nothing which passes can end the Python string literal it
 * is substituted into. No quote, no backslash, no newline, no control character.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/;

/** What a store identifier is validated against: the configured gateway and declared roots. */
export interface RecipeStoreConfig {
  endpoint: string;
  style: "path" | "virtual-host";
  roots: readonly { bucket: string; prefix?: string }[];
}

export interface StoreBinding {
  /** `s3://bucket/key/` - the identifier the source produced. */
  s3Path: string;
  /** The same location over HTTPS, through the configured gateway. */
  httpsUrl: string;
}

/**
 * Validate a store identifier against the configuration, and produce both forms of its address.
 *
 * Refuses rather than escapes: a value that is not a plain `s3://` identifier under one of the
 * declared roots is rejected (`null`), and the caller offers no recipe. The checks in order: the
 * scheme; a bucket that is one of the declared ones; a key that starts with that root's declared
 * prefix; a character set that cannot escape a string literal; no upward walk.
 *
 * The endpoint is the configured one, never anything from the value, so a store identifier cannot
 * redirect a reader's interpreter at another host.
 */
export function bindStore(s3Path: unknown, config: RecipeStoreConfig): StoreBinding | null {
  if (typeof s3Path !== "string" || !s3Path.startsWith("s3://")) return null;
  const rest = s3Path.slice("s3://".length);
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const key = slash === -1 ? "" : rest.slice(slash + 1);
  if (bucket.length === 0) return null;

  const root = config.roots.find(
    (candidate) => candidate.bucket === bucket && key.startsWith(candidate.prefix ?? ""),
  );
  if (!root) return null;
  if (!SAFE_SEGMENT.test(bucket) || !SAFE_SEGMENT.test(key)) return null;
  // A key that walks upwards is an attempt to leave the root it was checked against.
  if (key.includes("..")) return null;

  let base: URL;
  try {
    base = new URL(config.endpoint);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  if (config.style === "virtual-host") {
    base.hostname = `${bucket}.${base.hostname}`;
    base.pathname = `${base.pathname.replace(/\/$/, "")}/${key}`;
  } else {
    base.pathname = `${base.pathname.replace(/\/$/, "")}/${bucket}/${key}`;
  }
  return { s3Path, httpsUrl: base.toString() };
}

/**
 * A value as the body of a Python string literal, which is where every hole sits: inserted
 * literally (a replacement callback, so `$&` and the like stay text), quotes, backslashes and
 * control characters escaped.
 */
export function pythonStringBody(value: string): string {
  let out = "";
  for (const c of value) {
    const code = c.charCodeAt(0);
    if (c === "\\" || c === '"' || c === "'") out += `\\${c}`;
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += c;
  }
  return out;
}

/** Fill a recipe's holes, having already validated what goes in them. */
export function renderRecipe(
  recipe: Pick<TreeRecipe, "template" | "parameter">,
  binding: StoreBinding,
  endpoint: string,
): string {
  const value =
    recipe.parameter === "https-url"
      ? binding.httpsUrl
      : `/${binding.s3Path.slice("s3://".length)}`;
  // One pass, so neither value is read for the other's hole.
  return recipe.template.replace(/\{\{(STORE|ENDPOINT)\}\}/g, (_, hole: string) =>
    pythonStringBody(hole === "STORE" ? value : endpoint),
  );
}

export interface RecipeExamplesOptions {
  /** The gateway and roots a store must belong to. */
  store: RecipeStoreConfig;
  /** The recipes to offer. Defaults to `TREE_RECIPES`. */
  recipes?: readonly TreeRecipe[];
  /**
   * Registered digests (lowercase hex SHA-256 of each template), by recipe id. A recipe with a
   * digest here and listed in `runnable` gets `executable: true` and that digest, which is what
   * makes the tree draw its "Try in Python" control. Anything else is shown as copyable text.
   */
  digests?: Readonly<Record<string, string>>;
  /** Recipe ids the host's interpreter can run (see `runnableRecipes`). */
  runnable?: readonly string[];
}

/**
 * The access examples a live tree shows for a node: one per recipe, for a `dataset` node whose
 * identifier binds to a declared root, and none otherwise. Pass as the tree's `accessExamples`.
 */
export function recipeAccessExamples(
  node: Pick<DatasetTreeNode, "kind" | "path">,
  options: RecipeExamplesOptions,
): DatasetAccessExample[] {
  if (node.kind !== "dataset") return [];
  const binding = bindStore(node.path, options.store);
  if (!binding) return [];
  const runnable = new Set(options.runnable ?? []);
  return (options.recipes ?? TREE_RECIPES).map((recipe) => {
    const digest = options.digests?.[recipe.id];
    const example: DatasetAccessExample = {
      id: recipeExampleId(recipe.id),
      label: recipe.label,
      language: "python",
      code: renderRecipe(recipe, binding, options.store.endpoint),
    };
    if (recipe.description) example.description = recipe.description;
    if (digest && runnable.has(recipe.id)) {
      example.digest = digest;
      example.executable = true;
    }
    return example;
  });
}

/**
 * Resolve a "Try in Python" press for a recipe back to the code to run, re-validating everything:
 * the example id names a known recipe, the digest is the one registered for it, and the dataset id
 * binds to a declared root. Returns `null` for anything else. That the registered digest really is
 * the hash of the template this copy of the package holds is the consumer's check, made before it
 * registers a recipe as runnable at all: it hashes `recipe.template` and compares it with the
 * digest its build recorded, in the page code that mounts the tree.
 */
export function resolveRecipeRun(
  request: { exampleId: string; digest: string; datasetId?: string },
  options: RecipeExamplesOptions,
): { recipe: TreeRecipe; binding: StoreBinding; source: string } | null {
  const recipe = (options.recipes ?? TREE_RECIPES).find(
    (r) => recipeExampleId(r.id) === request.exampleId,
  );
  if (!recipe) return null;
  const registered = options.digests?.[recipe.id];
  if (!registered || registered !== request.digest.trim().toLowerCase()) return null;
  if (!new Set(options.runnable ?? []).has(recipe.id)) return null;
  const binding = bindStore(request.datasetId, options.store);
  if (!binding) return null;
  return { recipe, binding, source: renderRecipe(recipe, binding, options.store.endpoint) };
}
