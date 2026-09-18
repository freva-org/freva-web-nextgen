// url.ts - the one place a value from a catalog is allowed to become an `href`. Everything else
// this component renders is text, so this module is the whole link attack surface. It is an
// allow-list on purpose: a scheme has to be named here to survive, so a new one is a decision
// somebody makes rather than something a catalog can introduce.

/**
 * Schemes a browser may be pointed at from a dataset catalog. `javascript:`, `data:`, `blob:`,
 * `vbscript:` and `file:` are absent for the obvious reason; `s3:`, `gs:` and friends for a duller
 * one - a browser cannot follow them, so they render as copyable text rather than as a control that
 * looks live and does nothing.
 */
const SAFE_SCHEMES = new Set(["https:", "http:"]);

/**
 * Returns the URL as a string if it is safe to put in an `href`, and `null` otherwise. Parsing uses
 * the platform parser rather than a regular expression, so the scheme checked is the one the
 * browser acts on; control characters and whitespace, how `java\nscript:` gets past naive checks,
 * are rejected before parsing rather than trimmed into something that then passes.
 */
export function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > 2048) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!SAFE_SCHEMES.has(url.protocol)) return null;
  return url.toString();
}

/**
 * Whether a string is worth showing as a copyable literal. Permissive on purpose - an `s3://` URI,
 * a POSIX path and a DAP endpoint are all legitimate - and not a URL check, since this value never
 * becomes an `href`; only control characters, which would corrupt a copy, and absurd lengths are
 * refused.
 */
export function displayableLiteral(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > 4096) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}
