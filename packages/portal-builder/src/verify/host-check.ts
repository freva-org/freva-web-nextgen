// Deployed-host conformance: the evidence `preview` is not. It asks the real deployment the
// questions `host-policy.json` says a conforming host must answer - directory indexes, the
// slash redirect with its query intact, a real 404, the download headers, the auth callback's
// cache and referrer policy, the Content-Security-Policy, enforced and not weakened - and
// reports what it actually got. It is networked and never part
// of artifact generation.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DiagnosticBag } from "../diagnostics.js";
import { redirectLocation } from "../model/redirects.js";

/**
 * The query the checks send, to see that a redirect keeps it. Named so it cannot collide with a
 * parameter a site uses: a redirect target that already carries `?probe=…` is a real case, and
 * a probe that shares its name cannot tell "kept" from "replaced".
 */
const PROBE_KEY = "freva-portal-host-check";
const PROBE = `${PROBE_KEY}=1`;

/** A query string as a sorted list of `key=value` pairs, repeats kept: order is not meaning. */
const pairs = (params: URLSearchParams): string[] =>
  [...params].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort();

interface HostPolicyDocument {
  mount: { canonicalUrl: string; basePath: string };
  routing: {
    directoryIndex: string;
    trailingSlashRedirect: string;
    preserveQueryOnRedirect: boolean;
  };
  errorPages: { notFound: string };
  headers: {
    match: { path?: string; prefix?: string; class?: string };
    set: Record<string, string>;
  }[];
  cache: { classes: Record<string, string> };
  authCallback?: { path: string; headers: Record<string, string> };
  redirects?: { from: string; to: string; status: number; preserveQuery: boolean }[];
  csp?: {
    portal?: Record<string, string>;
    subsites?: { mount: string; directives: Record<string, string> }[];
    paths?: { match: { prefix: string } | { path: string }; directives: Record<string, string> }[];
  };
}

/**
 * Directives that never widen what a page may load, so they are left out of the comparison:
 * they report, upgrade or add restrictions of their own.
 */
const IGNORED_DIRECTIVES = new Set([
  "report-uri",
  "report-to",
  "upgrade-insecure-requests",
  "block-all-mixed-content",
  "require-trusted-types-for",
  "trusted-types",
  "sandbox",
]);

/**
 * CSP Level 3's fallback lists: a directive a policy does not name is governed by the first of
 * these it does name. Directives listed with no fallback (`base-uri`, `form-action`,
 * `frame-ancestors`) are unrestricted when absent, which is why dropping one is a widening.
 */
const FALLBACKS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["default-src", []],
  ["script-src", ["default-src"]],
  ["script-src-elem", ["script-src", "default-src"]],
  ["script-src-attr", ["script-src", "default-src"]],
  ["style-src", ["default-src"]],
  ["style-src-elem", ["style-src", "default-src"]],
  ["style-src-attr", ["style-src", "default-src"]],
  ["img-src", ["default-src"]],
  ["font-src", ["default-src"]],
  ["media-src", ["default-src"]],
  ["object-src", ["default-src"]],
  ["connect-src", ["default-src"]],
  ["manifest-src", ["default-src"]],
  ["child-src", ["default-src"]],
  ["frame-src", ["child-src", "default-src"]],
  ["fenced-frame-src", ["frame-src", "child-src", "default-src"]],
  ["worker-src", ["child-src", "script-src", "default-src"]],
  ["base-uri", []],
  ["form-action", []],
  ["frame-ancestors", []],
]);

/**
 * One source expression in a comparable spelling. Keywords and schemes are case-insensitive;
 * the base64 part of a hash or nonce is not, so only its prefix is folded.
 */
function normaliseSource(source: string): string {
  const hashOrNonce = /^'(sha256|sha384|sha512|nonce)-(.*)'$/i.exec(source);
  if (hashOrNonce) return `'${hashOrNonce[1]!.toLowerCase()}-${hashOrNonce[2]}'`;
  if (source.startsWith("'")) return source.toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return source.toLowerCase();
  return source;
}

/**
 * One policy, `name source source; name ...`, as directive name -> set of sources. `'none'` is
 * the empty set: it matches nothing, so a list of only `'none'` blocks everything, and beside
 * other sources it adds nothing.
 */
export function parseCsp(policy: string): Map<string, Set<string>> {
  const directives = new Map<string, Set<string>>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (!name) continue;
    const key = name.toLowerCase();
    // The first occurrence of a directive is the one a browser enforces.
    if (directives.has(key)) continue;
    directives.set(key, new Set(sources.map(normaliseSource).filter((s) => s !== "'none'")));
  }
  return directives;
}

/** Directives where a hash or nonce turns `'unsafe-inline'` off (CSP3, "Does a source list allow all inline behavior"). */
const INLINE_DIRECTIVES = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
]);

/**
 * Whether a source list really allows any inline code. `'unsafe-inline'` counts only while the
 * list has no hash and no nonce, and, for scripts, no `'strict-dynamic'`: a browser ignores it
 * otherwise. So removing the last hash can switch inline code ON, which is a widening even
 * though the list got shorter.
 */
function allowsAnyInline(name: string, sources: Set<string>): boolean {
  if (!INLINE_DIRECTIVES.has(name) || !sources.has("'unsafe-inline'")) return false;
  for (const source of sources) {
    if (/^'(sha256|sha384|sha512|nonce)-/.test(source)) return false;
    if (source === "'strict-dynamic'" && !name.startsWith("style")) return false;
  }
  return true;
}

/** What a policy allows for one directive, after fallbacks: a set of sources, or anything. */
function effective(policy: Map<string, Set<string>>, name: string): Set<string> | "anything" {
  for (const candidate of [name, ...(FALLBACKS.get(name) ?? [])]) {
    const sources = policy.get(candidate);
    if (sources) return sources;
  }
  return "anything";
}

/**
 * How a served policy compares with the artifact's, directive by directive, after fallbacks:
 * what it widens, and what it narrows.
 *
 * Sources are compared as expressions: one the artifact does not list counts as wider, even
 * where it might match fewer URLs (`https://host/path` beside `https://host`). Proving that
 * needs URL matching, and a false alarm on a host's own extra source is the safe mistake.
 */
export function compareCsp(
  expected: Record<string, string>,
  served: Map<string, Set<string>>,
): { widened: string[]; narrowed: string[] } {
  const recorded = parseCsp(
    Object.entries(expected)
      .map(([name, value]) => `${name} ${value}`)
      .join(";"),
  );
  const widened: string[] = [];
  const narrowed: string[] = [];
  // Every directive either policy names. One only the host names counts when it is a known
  // directive: a browser ignores the rest, and so does this comparison.
  const names = new Set([
    ...recorded.keys(),
    ...[...served.keys()].filter((name) => FALLBACKS.has(name)),
  ]);
  for (const name of names) {
    if (IGNORED_DIRECTIVES.has(name)) continue;
    const allowed = effective(recorded, name);
    const sources = effective(served, name);
    if (sources === "anything") {
      if (allowed !== "anything") widened.push(`does not restrict '${name}'`);
      continue;
    }
    if (allowed === "anything") {
      narrowed.push(`restricts '${name}', which the artifact leaves open`);
      continue;
    }
    const extra = [...sources].filter((source) => !allowed.has(source));
    if (extra.length > 0) widened.push(`'${name}' also allows ${extra.join(" ")}`);
    if (allowsAnyInline(name, sources) && !allowsAnyInline(name, allowed)) {
      widened.push(
        `'${name}' allows any inline code: no hash or nonce is left to disable its 'unsafe-inline'`,
      );
    }
    const missing = [...allowed].filter((source) => !sources.has(source));
    if (missing.length > 0) {
      narrowed.push(
        sources.size === 0 ? `'${name}' blocks everything` : `'${name}' omits ${missing.join(" ")}`,
      );
    }
  }
  return { widened, narrowed };
}

/** The policy a response at `fullPath` must carry: its path's own, else its subsite's, else the portal's. */
function expectedCsp(
  csp: HostPolicyDocument["csp"],
  fullPath: string,
): Record<string, string> | undefined {
  const own = (csp?.paths ?? []).find((entry) =>
    "prefix" in entry.match
      ? fullPath.startsWith(entry.match.prefix)
      : fullPath === entry.match.path,
  );
  if (own) return own.directives;
  const subsite = (csp?.subsites ?? []).find((entry) => fullPath.startsWith(entry.mount));
  if (subsite) return subsite.directives;
  return csp?.portal;
}

interface PortalManifestLite {
  routes: { path: string; url: string; kind: string }[];
  files: { path: string; cacheClass: string; contentDisposition?: string }[];
}

export interface HostCheckOptions {
  dir: string;
  url: string;
  fetchImpl?: typeof fetch;
  /** Follow no redirects: the redirect itself is the thing being checked. */
  timeoutMs?: number;
}

export async function hostCheck(options: HostCheckOptions): Promise<DiagnosticBag> {
  const bag = new DiagnosticBag();
  const doFetch = options.fetchImpl ?? fetch;
  const policy = JSON.parse(
    readFileSync(join(options.dir, "host-policy.json"), "utf8"),
  ) as HostPolicyDocument;
  const manifest = JSON.parse(
    readFileSync(join(options.dir, "portal-manifest.json"), "utf8"),
  ) as PortalManifestLite;

  const base = options.url.endsWith("/") ? options.url : `${options.url}/`;
  /**
   * Probes are built from the checked base, not from the canonical URLs recorded in the
   * manifest. Serving an artifact somewhere else is a deployment error and is reported as one
   * below, but the check still has to describe what the target actually did.
   */
  const at = (sitePath: string): string => `${base}${sitePath.replace(/^\//, "")}`;
  if (base !== policy.mount.canonicalUrl) {
    bag.warn(
      "FP1603",
      `The checked URL '${base}' is not the artifact's canonical URL '${policy.mount.canonicalUrl}'. ` +
        `An artifact is built for exactly one public URL; serving it elsewhere is a deployment error, not a relocation.`,
    );
  }

  const get = async (
    url: string,
    redirect: "manual" | "follow" = "manual",
  ): Promise<Response | undefined> => {
    try {
      return await doFetch(url, {
        redirect,
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      bag.error(
        "FP1603",
        `Request to '${url}' failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };

  // 1. The root document is served at the canonical URL.
  const root = await get(base, "follow");
  if (root) {
    if (!root.ok) bag.error("FP1603", `GET ${base} returned ${root.status}, expected 200.`);
    const type = root.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) {
      bag.error("FP1603", `GET ${base} returned content-type '${type}', expected HTML.`);
    }

    // 1b. It carries the artifact's Content-Security-Policy: enforced, and not weakened. The
    // builder writes a restrictive policy, but only the host can send it; a deployment that
    // drops, softens or merely reports it passes every other check here.
    const expected = expectedCsp(policy.csp, policy.mount.basePath);
    if (expected) {
      const enforced = root.headers.get("content-security-policy");
      const reportOnly = root.headers.get("content-security-policy-report-only");
      if (!enforced) {
        bag.error(
          "FP1603",
          reportOnly
            ? `GET ${base} sends its Content-Security-Policy only as Content-Security-Policy-Report-Only, which enforces nothing.`
            : `GET ${base} sends no Content-Security-Policy; host-policy.json records the policy the host must send.`,
        );
      } else {
        // Several policies arrive comma-joined, and a browser enforces all of them, so the
        // result is at least as strict as any one: one that is not weakened is enough.
        const results = enforced
          .split(",")
          .map((policyText) => compareCsp(expected, parseCsp(policyText)));
        const best = results.find((result) => result.widened.length === 0);
        if (!best) {
          bag.error(
            "FP1603",
            `GET ${base} sends a weaker Content-Security-Policy than host-policy.json records: ${(results[0]?.widened ?? []).join("; ")}.`,
          );
        } else if (best.narrowed.length > 0) {
          bag.warn(
            "FP1603",
            `GET ${base} sends a stricter Content-Security-Policy than host-policy.json records (${best.narrowed.join("; ")}); the portal may not work.`,
          );
        }
      }
    }
  }

  // 2. Directory URLs and deep links are real files, without an SPA fallback.
  for (const route of manifest.routes.filter((r) => r.kind !== "error").slice(0, 25)) {
    const url = at(route.path);
    const response = await get(url, "follow");
    if (!response) continue;
    if (!response.ok) {
      bag.error(
        "FP1603",
        `Deep link ${url} returned ${response.status}; a static host must serve it directly.`,
      );
    }
  }

  // 3. The non-slash form redirects and keeps the query string.
  const sample = manifest.routes.find((r) =>
    r.kind === "content" || r.kind === "landing" ? r.path !== "/" : false,
  );
  if (sample) {
    const withoutSlash = `${at(sample.path).replace(/\/$/, "")}?${PROBE}`;
    const response = await get(withoutSlash);
    if (response) {
      if (response.status !== 301 && response.status !== 308) {
        bag.error(
          "FP1603",
          `GET ${withoutSlash} returned ${response.status}; the host must redirect the non-slash directory form.`,
        );
      } else {
        const location = response.headers.get("location") ?? "";
        if (!location.includes(PROBE)) {
          bag.error("FP1603", `The slash redirect for ${withoutSlash} dropped the query string.`);
        }
      }
    }
  }

  // 4. An unknown route returns the generated 404, not the portal shell.
  const missing = await get(`${base}definitely-not-a-route-${Date.now().toString(36)}/`, "follow");
  if (missing) {
    if (missing.status !== 404) {
      bag.error(
        "FP1603",
        `An unknown route returned ${missing.status}; a conforming host returns 404.`,
      );
    }
  }

  // 5. Downloads carry attachment and nosniff.
  const download = manifest.files.find((f) => f.cacheClass === "download");
  if (download) {
    const response = await get(`${base}${download.path}`, "follow");
    if (response) {
      const disposition = response.headers.get("content-disposition") ?? "";
      if (!disposition.toLowerCase().includes("attachment")) {
        bag.error(
          "FP1603",
          `'${download.path}' is served without Content-Disposition: attachment.`,
        );
      }
      if ((response.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
        bag.error(
          "FP1603",
          `'${download.path}' is served without X-Content-Type-Options: nosniff.`,
        );
      }
    }
  }

  // 6. The auth callback's privacy headers.
  if (policy.authCallback) {
    const callbackUrl = at(policy.authCallback.path.slice(policy.mount.basePath.length - 1));
    const response = await get(callbackUrl, "follow");
    if (response) {
      const cache = (response.headers.get("cache-control") ?? "").toLowerCase();
      if (!cache.includes("no-store")) {
        bag.error("FP1603", `The auth callback is served without Cache-Control: no-store.`);
      }
      const referrer = (response.headers.get("referrer-policy") ?? "").toLowerCase();
      if (referrer !== "no-referrer") {
        bag.error("FP1603", `The auth callback is served without Referrer-Policy: no-referrer.`);
      }
      bag.info(
        "FP1603",
        "Query-string redaction in the callback's access log cannot be observed over HTTP; confirm it in the host configuration.",
      );
    }
  }

  // 7. Immutable caching only for content-hashed names.
  const hashed = manifest.files.find((f) => f.cacheClass === "immutable");
  if (hashed) {
    const response = await get(`${base}${hashed.path}`, "follow");
    const cache = (response?.headers.get("cache-control") ?? "").toLowerCase();
    if (response && !cache.includes("immutable")) {
      bag.warn(
        "FP1603",
        `'${hashed.path}' is content-hashed but is not served with immutable caching.`,
      );
    }
  }
  const stable = manifest.files.find(
    (f) => f.cacheClass === "revalidate" && f.path.endsWith(".html"),
  );
  if (stable) {
    const response = await get(`${base}${stable.path.replace(/index\.html$/, "")}`, "follow");
    const cache = (response?.headers.get("cache-control") ?? "").toLowerCase();
    if (response && cache.includes("immutable")) {
      bag.error("FP1603", `'${stable.path}' must never be served with immutable caching.`);
    }
  }

  // 8. Declared redirects: a real HTTP redirect, with the declared status, to the declared
  // target, keeping the query. A host that serves the artifact's fallback page instead answers
  // with a 200, which works for a reader and fails the contract: a crawler sees a page, not a move.
  for (const redirect of (policy.redirects ?? []).slice(0, 50)) {
    const probe = `${at(redirect.from.slice(policy.mount.basePath.length - 1))}?${PROBE}`;
    const response = await get(probe);
    if (!response) continue;
    if (response.status !== redirect.status) {
      bag.error(
        "FP1603",
        response.status === 200
          ? `GET ${probe} returned 200 (the fallback page); host-policy.json asks for a ${redirect.status} redirect to '${redirect.to}'.`
          : `GET ${probe} returned ${response.status}; host-policy.json asks for a ${redirect.status} redirect to '${redirect.to}'.`,
      );
      continue;
    }
    const location = response.headers.get("location") ?? "";
    let resolved: URL | undefined;
    try {
      resolved = new URL(location, probe);
    } catch {
      resolved = undefined;
    }
    // What a conforming host sends: the target with the probe's query merged into its own.
    const expected = new URL(
      redirect.preserveQuery ? redirectLocation(redirect.to, `?${PROBE}`) : redirect.to,
      base,
    );
    if (!resolved || resolved.origin + resolved.pathname !== expected.origin + expected.pathname) {
      bag.error(
        "FP1603",
        `GET ${probe} redirects to '${location}'; host-policy.json says '${redirect.to}'.`,
      );
      continue;
    }
    // The whole query, compared as a whole: the target's own parameters - including one that
    // happens to share a name with anything the request carried - and the request's, each once.
    const want = pairs(expected.searchParams);
    const got = pairs(resolved.searchParams);
    if (redirect.preserveQuery && !resolved.searchParams.getAll(PROBE_KEY).includes("1")) {
      bag.error("FP1603", `The redirect from '${redirect.from}' dropped the query string.`);
    } else if (want.join("&") !== got.join("&")) {
      bag.error(
        "FP1603",
        `GET ${probe} redirects to '${location}', whose query is not ` +
          (redirect.preserveQuery ? "the target's merged with the request's" : "the target's") +
          ` (expected '${expected.search}').`,
      );
    }
    if (expected.hash && resolved.hash !== expected.hash) {
      bag.error(
        "FP1603",
        `GET ${probe} redirects to '${location}', which loses the target's fragment '${expected.hash}'.`,
      );
    }
  }

  return bag;
}
