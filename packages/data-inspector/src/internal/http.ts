/**
 * Shared HTTP helpers used by ZarrPoller, detectZarrStore, and the
 * client-side Zarr metadata parser. Keeping them here avoids duplicating the
 * cookie/auth and URL-normalization logic across modules.
 */

/** Cookie name (with trailing "=") that holds the Freva bearer token. */
export const DEFAULT_COOKIE_NAME = "freva_auth_token=";

/**
 * Default auth-header provider: reads a Bearer token from the
 * `freva_auth_token` cookie and returns it as an `Authorization` header.
 * Returns an empty object when the cookie is absent or malformed (or when
 * there is no `document`, e.g. in a non-browser context).
 */
export function defaultGetAuthHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const cookies = document.cookie.split(";");
  const authCookie = cookies.find((c) => c.trim().startsWith(DEFAULT_COOKIE_NAME));
  if (!authCookie) return {};
  try {
    let value = authCookie.substring(authCookie.indexOf("=") + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return value ? { Authorization: `Bearer ${value}` } : {};
  } catch {
    return {};
  }
}

/**
 * Normalize a user-provided URL/path. If it looks percent-encoded
 * (e.g. `https%3A//…`, or double-encoded `https%253A//…`) we decode it so
 * downstream `fetch` calls treat it as an absolute URL rather than a
 * relative path against the current origin.
 */
export function normalizeUrl(input: string): string {
  if (typeof input !== "string") return input;
  let s = input.trim();
  // Single-encoded colon is "%3A"; double-encoded becomes "%253A".
  while (/^https?%(25)*3a/i.test(s)) {
    try {
      const decoded = decodeURIComponent(s);
      if (decoded === s) break;
      s = decoded;
    } catch {
      break;
    }
  }
  return s;
}
