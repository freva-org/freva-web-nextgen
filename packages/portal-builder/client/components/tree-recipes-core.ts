// Store validation and template filling for the access recipes, with no browser or JSON import,
// so tests and the page share it. `tree-recipes.ts` re-exports it beside the recipes themselves.

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

/** Fill a recipe's single hole, having already validated what goes in it. */
export function renderRecipe(
  recipe: { template: string; parameter: "https-url" | "s3-path" },
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
