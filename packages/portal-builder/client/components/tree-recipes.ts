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

/**
 * The characters a store value may contain: an ALLOWLIST, deliberately narrower than S3 permits.
 * What matters is not that every legal key passes - a key with a quote in it is vanishingly rare
 * and simply offers no recipe - but that nothing which passes can end the Python string literal it
 * is substituted into. No quote, no backslash, no newline, no control character.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/;

export interface StoreBinding {
  /** `s3://bucket/key/` - the identifier the source produced. */
  s3Path: string;
  /** The same location over HTTPS, through the configured gateway. */
  httpsUrl: string;
}

/**
 * Validate a store identifier against the configuration, and produce both forms of its address.
 *
 * REFUSES rather than escapes: a value that is not a plain `s3://` identifier under one of the
 * declared roots is rejected, and the caller offers no recipe. The checks in order: the scheme; a
 * bucket that is one of the declared ones; a key that starts with that root's declared prefix; a
 * character set that cannot escape a string literal.
 *
 * The endpoint is the CONFIGURED one, never anything from the value, so a store identifier cannot
 * redirect a reader's interpreter at another host.
 */
export function bindStore(
  s3Path: unknown,
  config: {
    endpoint: string;
    style: "path" | "virtual-host";
    roots: readonly { bucket: string; prefix?: string }[];
  },
): StoreBinding | null {
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

/** Fill a recipe's single hole, having already validated what goes in it. */
export function renderRecipe(recipe: TreeRecipe, binding: StoreBinding, endpoint: string): string {
  const value =
    recipe.parameter === "https-url"
      ? binding.httpsUrl
      : `/${binding.s3Path.slice("s3://".length)}`;
  return recipe.template.replace("{{STORE}}", value).replace("{{ENDPOINT}}", endpoint);
}
