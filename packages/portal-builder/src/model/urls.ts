/**
 * Service URL semantics. The three service kinds do not share a URL rule, and pretending they do
 * is how a trailing slash silently changes which endpoint a browser calls. A Data Browser or auth
 * base URL is a *join base*: no trailing slash, no query. A STAC catalog URL is an *exact
 * resource*: trailing slash and query preserved verbatim. Every join in the builder and in the
 * generated islands goes through `joinEndpoint`, never string addition.
 */

import {
  collapseSeparators,
  parserPreservedPath,
  rawPathReason,
  splitAuthoredUrl,
} from "../config/raw-path.js";

export interface UrlCheck {
  ok: boolean;
  value: string;
  origin: string;
  error?: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

interface ParseOptions {
  allowQuery: boolean;
  /** Only the development command may accept plain HTTP, and only for loopback. */
  allowInsecureLoopback: boolean;
  /** Join bases normalize to no trailing slash; exact resources keep theirs. */
  trailingSlash: "strip" | "preserve";
}

function fail(value: string, error: string): UrlCheck {
  return { ok: false, value, origin: "", error };
}

export function normalizeServiceUrl(raw: string, opts: ParseOptions): UrlCheck {
  const value = raw.trim();
  if (value === "") return fail(raw, "The URL is empty.");
  if (value.includes("\\")) return fail(raw, "Backslashes are not accepted in a service URL.");
  if (value.startsWith("//")) return fail(raw, "Protocol-relative URLs are not accepted.");
  if (value.includes("#")) return fail(raw, "A fragment is not accepted in a service URL.");

  if (value.startsWith("/")) {
    // Root-relative: an origin-root URL that the site base path never prefixes.
    const [path, query] = splitQuery(value);
    if (query && !opts.allowQuery)
      return fail(raw, "A query string is not accepted for this service kind.");
    // The raw-path contract, applied to the authored text before anything collapses a segment.
    const reason = rawPathReason(path, { rejectQueryAndFragment: false });
    if (reason) return fail(raw, `The service URL path ${reason}.`);
    const normalizedPath = normalizePath(path, opts.trailingSlash);
    return { ok: true, value: query ? `${normalizedPath}?${query}` : normalizedPath, origin: "" };
  }

  // Absolute: the authored pathname is cut out textually and validated before `new URL()` sees
  // it, because the WHATWG parser removes dot segments - literal and encoded - erasing evidence.
  const authored = splitAuthoredUrl(value);
  if (!authored) return fail(raw, "The URL is neither root-relative nor absolute.");
  const authoredReason = rawPathReason(authored.path, { rejectQueryAndFragment: false });
  if (authoredReason) return fail(raw, `The service URL path ${authoredReason}.`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(raw, "The URL is neither root-relative nor absolute.");
  }
  if (!parserPreservedPath(authored.path, url.pathname)) {
    return fail(
      raw,
      `The service URL path '${authored.path}' is not what a URL parser resolves it to ('${url.pathname}').`,
    );
  }
  if (url.username || url.password) return fail(raw, "URL user information is not accepted.");
  if (url.protocol === "http:") {
    if (!opts.allowInsecureLoopback || !isLoopbackHost(url.hostname)) {
      return fail(
        raw,
        "Plain HTTP is accepted only by the development command, and only for loopback hosts.",
      );
    }
  } else if (url.protocol !== "https:") {
    return fail(
      raw,
      `Scheme '${url.protocol.replace(":", "")}' is not accepted for a service URL.`,
    );
  }
  const query = url.search.replace(/^\?/, "");
  if (query && !opts.allowQuery)
    return fail(raw, "A query string is not accepted for this service kind.");
  const path = normalizePath(url.pathname, opts.trailingSlash);
  const composed = `${url.origin}${path}${query ? `?${query}` : ""}`;
  return { ok: true, value: composed, origin: url.origin };
}

function splitQuery(value: string): [string, string | undefined] {
  const index = value.indexOf("?");
  return index === -1 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)];
}

function normalizePath(path: string, mode: "strip" | "preserve"): string {
  const collapsed = path.replace(/\/{2,}/g, "/");
  if (mode === "preserve") return collapsed === "" ? "/" : collapsed;
  const stripped = collapsed.replace(/\/+$/, "");
  return stripped;
}

export function normalizeDatabrowserBase(raw: string, dev = false): UrlCheck {
  return normalizeServiceUrl(raw, {
    allowQuery: false,
    allowInsecureLoopback: dev,
    trailingSlash: "strip",
  });
}

export function normalizeAuthBase(raw: string, dev = false): UrlCheck {
  return normalizeServiceUrl(raw, {
    allowQuery: false,
    allowInsecureLoopback: dev,
    trailingSlash: "strip",
  });
}

export function normalizeStacCatalogUrl(raw: string, dev = false): UrlCheck {
  return normalizeServiceUrl(raw, {
    allowQuery: true,
    allowInsecureLoopback: dev,
    trailingSlash: "preserve",
  });
}

/**
 * The one endpoint join: `base` never ends with a slash, `path` never starts with one, so the
 * browser never resolves the result against a base whose trailing slash somebody forgot.
 */
export function joinEndpoint(base: string, path: string): string {
  const left = base.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  return right === "" ? left : `${left}/${right}`;
}

export interface CanonicalSiteUrl {
  ok: boolean;
  canonicalUrl: string;
  origin: string;
  basePath: string;
  error?: string;
}

/**
 * `site.canonicalUrl` is the single site-base authority: its pathname *is* the base path, and no
 * second field can disagree with it.
 */
export function parseCanonicalUrl(raw: string): CanonicalSiteUrl {
  const reject = (error: string): CanonicalSiteUrl => ({
    ok: false,
    canonicalUrl: raw,
    origin: "",
    basePath: "/",
    error,
  });

  // Before the parser: `new URL("https://x.org/site/../admin/")` and
  // `new URL("https://x.org/site/%2e%2e/admin/")` both yield `/admin/`, so a check that runs
  // afterwards inspects a string the evidence has already been removed from.
  const authored = splitAuthoredUrl(raw);
  if (!authored) return reject("Not an absolute URL.");
  const authoredReason = rawPathReason(authored.path);
  if (authoredReason) return reject(`site.canonicalUrl path ${authoredReason}.`);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      canonicalUrl: raw,
      origin: "",
      basePath: "/",
      error: "Not an absolute URL.",
    };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      canonicalUrl: raw,
      origin: "",
      basePath: "/",
      error: "site.canonicalUrl must be HTTPS.",
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      canonicalUrl: raw,
      origin: "",
      basePath: "/",
      error: "URL user information is not accepted.",
    };
  }
  if (url.search || url.hash) {
    return {
      ok: false,
      canonicalUrl: raw,
      origin: "",
      basePath: "/",
      error: "site.canonicalUrl must have no query and no fragment.",
    };
  }
  if (!url.pathname.endsWith("/")) {
    return {
      ok: false,
      canonicalUrl: raw,
      origin: "",
      basePath: "/",
      error: "site.canonicalUrl must end with a trailing slash.",
    };
  }
  if (!parserPreservedPath(authored.path, url.pathname)) {
    return reject(
      `site.canonicalUrl path '${authored.path}' is not what a URL parser resolves it to ('${url.pathname}').`,
    );
  }
  const basePath = collapseSeparators(url.pathname);
  return { ok: true, canonicalUrl: `${url.origin}${basePath}`, origin: url.origin, basePath };
}

/** Site-logical path to public URL. `/data/` under `https://x.org/portal/`. */
export function siteUrl(canonicalUrl: string, sitePath: string): string {
  return `${canonicalUrl.replace(/\/$/, "")}${sitePath}`;
}

/** Site-logical path to the href a generated page uses (base path included, once). */
export function siteHref(basePath: string, sitePath: string): string {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return `${base}${sitePath}`;
}

/** Site-logical path to artifact-relative output file. */
export function siteFile(sitePath: string): string {
  const trimmed = sitePath.replace(/^\//, "");
  return `${trimmed}index.html`;
}
