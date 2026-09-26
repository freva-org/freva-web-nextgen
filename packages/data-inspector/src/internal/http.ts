/**
 * Shared HTTP helpers used by ZarrPoller, detectZarrStore, and the
 * client-side Zarr metadata parser. Keeping them here avoids duplicating the
 * cookie/auth and URL-normalization logic across modules.
 */

/** Cookie name (with trailing "=") that holds the Freva bearer token. */
export const DEFAULT_COOKIE_NAME = "freva_auth_token=";

/** Request headers an auth provider adds. */
export type AuthHeaders = Record<string, string>;

/**
 * Auth headers for one request, given its absolute URL so a credential goes only where it belongs:
 * freva's bearer is also its refresh credential and must never reach a third-party store (which
 * would reject it with 403 anyway). May be async, e.g. an OIDC `getToken()` that refreshes first.
 * A zero-argument provider works but cannot scope.
 */
export type GetAuthHeaders = (url: string) => AuthHeaders | PromiseLike<AuthHeaders>;

/** The base a relative fetch resolves against, or null outside a browser. */
function documentBase(): string | null {
  if (typeof document !== "undefined" && document.baseURI) return document.baseURI;
  if (typeof location !== "undefined" && location.href) return location.href;
  return null;
}

/** `url` made absolute against the document (unchanged when it cannot be resolved). */
export function absoluteUrl(url: string): string {
  try {
    const base = documentBase();
    return base ? new URL(url, base).href : new URL(url).href;
  } catch {
    return url;
  }
}

/** Origin of `url` (resolved against the document), or null when it has none. */
export function originOf(url: string): string | null {
  try {
    const base = documentBase();
    const u = base ? new URL(url, base) : new URL(url);
    return u.origin === "null" ? null : u.origin;
  } catch {
    return null;
  }
}

/** True when `url` resolves to the page's own origin. */
export function isSameOrigin(url: string): boolean {
  if (typeof location === "undefined") return false;
  return originOf(url) === location.origin;
}

/**
 * Bearer token from the legacy freva-web `freva_auth_token` cookie, for the page's own origin
 * only; unscoped when called without a URL. `{}` without a usable cookie or a `document`.
 */
export function defaultGetAuthHeaders(url?: string): AuthHeaders {
  if (typeof document === "undefined") return {};
  if (url !== undefined && !isSameOrigin(url)) return {};
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
 * Headers from `provider` (default {@link defaultGetAuthHeaders}) for one request to `url`. A
 * provider that throws or rejects yields `{}`: the request goes out anonymously.
 */
export async function resolveAuthHeaders(
  provider: GetAuthHeaders | undefined,
  url: string,
): Promise<AuthHeaders> {
  try {
    const headers = await (provider ?? defaultGetAuthHeaders)(absoluteUrl(url));
    return headers && typeof headers === "object" ? { ...headers } : {};
  } catch {
    return {};
  }
}

/** Options for {@link scopedBearerAuth}. */
export interface ScopedBearerAuthOptions {
  /** The current bearer, or null/undefined when signed out. May be async (refresh first). */
  getToken: () => string | null | undefined | PromiseLike<string | null | undefined>;
  /**
   * Origins (or URLs, whose origin is taken) that may receive the bearer. Default: the page's
   * own origin. Name freva-rest here when it is served from a different origin.
   */
  origins?: readonly string[];
}

/**
 * A {@link GetAuthHeaders} that sends `Authorization: Bearer <token>` to the listed origins only,
 * and calls `getToken` only for those. Everything else goes out anonymously.
 *
 * ```ts
 * getAuthHeaders: scopedBearerAuth({
 *   getToken: async () => (await auth.getToken())?.accessToken ?? null,
 * })
 * ```
 */
export function scopedBearerAuth(options: ScopedBearerAuthOptions): GetAuthHeaders {
  const listed = options.origins?.map((o) => originOf(o)).filter((o): o is string => !!o);
  return async (url: string): Promise<AuthHeaders> => {
    const target = originOf(url);
    if (!target) return {};
    const allowed = listed ?? (typeof location !== "undefined" ? [location.origin] : []);
    if (!allowed.includes(target)) return {};
    const token = await options.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };
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
