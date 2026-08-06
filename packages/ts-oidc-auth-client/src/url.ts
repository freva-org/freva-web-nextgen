/**
 * URL / origin policy helpers.
 *
 * Everything here fails closed. The rules exist because in broker mode the
 * Bearer this library attaches IS the refresh credential, so "where may this
 * go" is a security decision, not a convenience.
 *
 * Core rule: never decide anything from the *syntax* of a config string.
 * `"/\\attacker.example/auth"` passes a naive `startsWith("/") &&
 * !startsWith("//")` relative-URL test, and then the browser normalizes the
 * backslash to a slash and resolves it to `https://attacker.example/auth`.
 * Every check below runs against the RESOLVED absolute URL.
 */

import { AuthError } from "./token.js";
export { strictBoolean, strictEnum } from "./validate.js";

/** Loopback is the one place plaintext http is legitimate (local dev). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

/** A transport safe to carry a refresh-capable credential. */
export function isSecureTransport(url: URL): boolean {
  return url.protocol === "https:" || isLoopbackHost(url.hostname);
}

export function currentOrigin(): string | null {
  return typeof location !== "undefined" && location.origin !== "null" ? location.origin : null;
}

/**
 * The base a relative fetch input actually resolves against.
 *
 * Fetch resolves relative request URLs against the document's *API base URL*,
 * which a `<base href>` element controls - NOT against `location.href`.
 * Validating against `location.href` while the browser sends somewhere else is
 * exactly the confusion an injected `<base>` exploits, so validation must use
 * the same base the browser will.
 */
function documentBase(): string | undefined {
  if (typeof document !== "undefined" && document.baseURI) return document.baseURI;
  return typeof location !== "undefined" ? location.href : undefined;
}

/** Config values resolve against the ORIGIN, never a mutable document base. */
function configBase(): string | undefined {
  return typeof location !== "undefined" ? location.origin + "/" : undefined;
}

/**
 * Resolve a fetch input to an absolute URL using the page as the base.
 * Returns null when it cannot be resolved or is syntactically hostile -
 * callers treat that as "cannot police this, refuse".
 */
export function resolveRequestUrl(input: RequestInfo | URL): URL | null {
  // Read `href`/`url` ONCE, right now. A caller-owned `URL` object is mutable:
  // validating it and then handing the same object to fetch lets the origin
  // change in between (during token loading), so everything downstream must
  // work from this immutable snapshot.
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (typeof raw !== "string") return null;
  // A backslash is normalized to "/" by the URL parser, which is exactly how
  // "/\evil.example" becomes protocol-relative. Refuse to guess.
  if (raw.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(raw)) return null;
  try {
    return new URL(raw, documentBase());
  } catch {
    return null;
  }
}

/**
 * An immutable destination snapshot: the absolute href that will actually be
 * sent, taken before any `await`. Callers MUST send `href`, never the original
 * input, so a `<base>` element or a mutated `URL` cannot redirect it later.
 */
export interface Destination {
  readonly url: URL;
  readonly href: string;
}

export function snapshotDestination(input: RequestInfo | URL): Destination | null {
  const url = resolveRequestUrl(input);
  if (!url) return null;
  return Object.freeze({ url, href: url.href });
}

export interface ConfigUrlOptions {
  /** Same-origin path form ("/api/auth/v2") is acceptable for this value. */
  allowRelative?: boolean;
  allowQuery?: boolean;
  allowFragment?: boolean;
  /** Honour security.allowInsecureTransport for this value. */
  allowInsecure?: boolean;
}

/**
 * Validate a config URL and return it RESOLVED to absolute form.
 *
 * Returns null only in a non-browser context where a relative value cannot be
 * resolved; syntactic checks still ran. Throws on anything unsafe.
 */
export function validateConfigUrl(
  value: string,
  label: string,
  options: ConfigUrlOptions = {},
): URL | null {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AuthError(`${label} is required and must be a non-empty string.`);
  }
  if (value !== value.trim()) {
    throw new AuthError(`${label} must not have leading or trailing whitespace.`);
  }
  // Control characters and backslashes are the raw material of URL-parsing
  // confusion; there is no legitimate use in a configured endpoint.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw new AuthError(`${label} must not contain control characters.`);
  }
  if (value.includes("\\")) {
    throw new AuthError(
      `${label} must not contain a backslash: ${JSON.stringify(value)}. ` +
        "Browsers normalize it to '/', so a value like '/\\\\host' silently " +
        "becomes a protocol-relative reference to another origin.",
    );
  }
  if (value.startsWith("//")) {
    throw new AuthError(
      `${label} must not be protocol-relative (${JSON.stringify(value)}); ` +
        "it resolves to a different origin than you expect.",
    );
  }

  const isRelative = value.startsWith("/");
  if (isRelative && !options.allowRelative) {
    throw new AuthError(`${label} must be an absolute URL, got ${JSON.stringify(value)}.`);
  }

  let u: URL;
  try {
    u = isRelative ? new URL(value, configBase() ?? "https://ssr.invalid") : new URL(value);
  } catch {
    throw new AuthError(`${label} is not a valid URL: ${JSON.stringify(value)}`);
  }
  // A relative value under SSR has no real base; only syntax can be checked.
  const resolvable = !isRelative || configBase() !== undefined;

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new AuthError(`${label} must use http(s), got ${u.protocol} in ${JSON.stringify(value)}`);
  }
  if (u.username || u.password) {
    throw new AuthError(`${label} must not embed credentials (user:pass@host): ${u.origin}`);
  }
  if (!options.allowQuery && u.search) {
    throw new AuthError(`${label} must not carry a query string: ${JSON.stringify(value)}`);
  }
  if (!options.allowFragment && u.hash) {
    // OAuth redirect URIs must not carry a fragment (RFC 6749 §3.1.2): the
    // authorization response appends its own, and a configured one is either
    // dropped or collides.
    throw new AuthError(`${label} must not carry a fragment: ${JSON.stringify(value)}`);
  }
  if (resolvable && !isSecureTransport(u) && !options.allowInsecure) {
    throw new AuthError(
      `${label}: refusing plaintext http URL ${u.origin}. The broker JWT is a ` +
        "refresh credential, not a one-hour access token. Use https, a " +
        "loopback host, or set security.allowInsecureTransport.",
    );
  }
  return resolvable ? u : null;
}

export function validatePositiveNumber(
  value: unknown,
  label: string,
  { allowZero = true }: { allowZero?: boolean } = {},
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AuthError(`${label} must be a finite number, got ${String(value)}`);
  }
  if (value < 0 || (!allowZero && value === 0)) {
    throw new AuthError(
      `${label} must be ${allowZero ? "zero or greater" : "greater than zero"}, got ${value}`,
    );
  }
}

/** Thrown when a credential would be sent somewhere unlisted. */
export class OriginNotAllowedError extends AuthError {
  readonly origin: string;
  constructor(origin: string, allowed: string[], what = "the Authorization header") {
    super(
      `Refusing to send ${what} to ${origin}: it is not an allowed resource ` +
        `origin. In broker mode the Bearer token is also the refresh ` +
        `credential, so one URL-injection bug would hand over the whole ` +
        `session. Allowed: ${allowed.join(", ") || "(none)"}. Add the origin to ` +
        `security.allowedResourceOrigins if it is genuinely yours.`,
    );
    this.name = "OriginNotAllowedError";
    this.origin = origin;
  }
}

/** Thrown when a redirect target is not on the exact-match allowlist. */
export class RedirectNotAllowedError extends AuthError {
  constructor(value: string, allowed: string[], label: string) {
    super(
      `${label} ${JSON.stringify(value)} is not on the allowlist. OAuth ` +
        `redirect targets must match exactly; an open one lets an attacker ` +
        `harvest the authorization code. Allowed: ${allowed.join(", ") || "(none)"}. ` +
        `Extend security.allowedRedirectUris / security.allowedPostLogoutRedirectUris.`,
    );
    this.name = "RedirectNotAllowedError";
  }
}

/**
 * The set of origins allowed to receive a credential.
 *
 * Defaults, with no config: the page's own origin and the origin of
 * `authBaseUrl`. Those two are implied by the deployment existing at all;
 * anything else has to be named.
 */
export function buildAllowedOrigins(
  authBaseUrlResolved: URL | null,
  configured: string[] | undefined,
  allowInsecure: boolean,
): string[] {
  const set = new Set<string>();
  const own = currentOrigin();
  if (own) set.add(own);
  if (authBaseUrlResolved) set.add(authBaseUrlResolved.origin);
  for (const entry of configured ?? []) {
    const u = validateConfigUrl(entry, "security.allowedResourceOrigins entry", {
      allowInsecure,
    });
    if (u) set.add(u.origin);
  }
  return [...set];
}

/** Exact-match key for redirect allowlists, after normalization. */
export function normalizeForExactMatch(u: URL): string {
  // origin + path + query; fragments are rejected outright.
  return `${u.origin}${u.pathname}${u.search}`;
}

/**
 * Query parameters an authorization response is allowed to ADD to the
 * registered redirect URI. Anything else must have been configured.
 */
export const OIDC_RESPONSE_PARAMS = new Set([
  "code",
  "state",
  "session_state",
  "iss",
  "error",
  "error_description",
  "error_uri",
  // Unsupported response modes we must still recognise, scrub and reject
  // rather than leave sitting in history.
  "id_token",
  "access_token",
  "token_type",
  "expires_in",
  "response",
]);

/** Sorted multiset of values for one query key. */
function valuesFor(u: URL, key: string): string[] {
  return u.searchParams.getAll(key).slice().sort();
}

/**
 * Does `actual` land on the registered callback `configured`?
 *
 * Origin and path must be identical, EVERY static query parameter configured
 * on the redirect URI must be present with exactly the same (multiset of)
 * values, and any additional parameter must be a recognized OIDC response
 * parameter. Comparing only origin+path would let `?tenant=a` be answered by
 * `?tenant=EVIL`, routing a real authorization code into the wrong
 * tenant/environment context.
 */
export function callbackMatches(configured: URL, actual: URL): boolean {
  if (configured.origin !== actual.origin) return false;
  if (configured.pathname !== actual.pathname) return false;

  const staticKeys = new Set(configured.searchParams.keys());
  for (const key of staticKeys) {
    const want = valuesFor(configured, key);
    const got = valuesFor(actual, key);
    if (want.length !== got.length) return false;
    for (let i = 0; i < want.length; i++) {
      if (want[i] !== got[i]) return false;
    }
  }
  // ROUTING ONLY. Once the route and its required static parameters match, the
  // URL is ours. Unknown extra query keys, code-only responses, duplicates,
  // mixed success/error and bad issuers are all *validation* failures - and
  // treating them as "not a callback" makes the app's router skip
  // handleCallback(), leaving `code` and `state` in the address bar forever.
  return true;
}

/** Longest return path we will store or replay. */
const MAX_RETURN_PATH = 2048;

/**
 * Validate and CANONICALIZE an app-relative return path.
 *
 * Prefix tests alone are not enough: `startsWith("/") && !startsWith("//") &&
 * !startsWith("/\\")` accepts `"/\t/evil.example/x"`, and the URL parser then
 * strips the tab so the value becomes protocol-relative and resolves to another
 * origin. Anything not provably same-origin after resolution is rejected, and
 * only the canonical `pathname + search + hash` is ever stored or returned.
 */
export function canonicalReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_RETURN_PATH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) return null;
  if (/[\s\\]/.test(value)) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  const origin = currentOrigin();
  if (!origin) return null;
  let u: URL;
  try {
    u = new URL(value, origin + "/");
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  const canonical = `${u.pathname}${u.search}${u.hash}`;
  return canonical.startsWith("/") && !canonical.startsWith("//") ? canonical : null;
}

/**
 * decodeURIComponent throws URIError on malformed percent-encoding. A fragment
 * of `#access_token=SECRET&%ZZ` must not throw out of isCallbackUrl(): the
 * router would skip the callback and the token would stay in the address bar
 * and in history. Decoding here is TOTAL - undecodable input falls back to the
 * raw text, which still matches protocol parameter names.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Protocol parameters present in a URL fragment.
 *
 * Implicit and hybrid responses put `access_token` / `id_token` in the
 * fragment. RFC 9700 treats the whole authorization response URL as
 * leakage-sensitive, so these must be recognised, scrubbed and rejected rather
 * than ignored - an ignored fragment stays in the address bar and in history.
 */
export function fragmentResponseParams(u: URL): Set<string> {
  const found = new Set<string>();
  const raw = u.hash.startsWith("#") ? u.hash.slice(1) : u.hash;
  if (!raw) return found;
  // A fragment carrying protocol parameters is form-encoded; an ordinary SPA
  // hash ("#/route" or "#section") is not and yields nothing.
  for (const part of raw.split("&")) {
    const key = safeDecode(part.split("=")[0] ?? "").trim();
    if (key && OIDC_RESPONSE_PARAMS.has(key)) found.add(key);
  }
  return found;
}

/** Remove protocol parameters from a fragment, preserving anything else. */
export function scrubFragment(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return "";
  const kept: string[] = [];
  let sawProtocol = false;
  for (const part of raw.split("&")) {
    const key = safeDecode(part.split("=")[0] ?? "").trim();
    if (key && OIDC_RESPONSE_PARAMS.has(key)) {
      sawProtocol = true;
      continue;
    }
    kept.push(part);
  }
  if (!sawProtocol) return hash; // an ordinary SPA hash, untouched
  return kept.length ? `#${kept.join("&")}` : "";
}
