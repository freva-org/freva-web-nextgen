// Deployed-host conformance: the evidence `preview` is not. It asks the real deployment the
// questions `host-policy.json` says a conforming host must answer - directory indexes, the
// slash redirect with its query intact, a real 404, the download headers, the auth callback's
// cache and referrer policy - and reports what it actually got. It is networked and never part
// of artifact generation.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DiagnosticBag } from "../diagnostics.js";

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
    const withoutSlash = `${at(sample.path).replace(/\/$/, "")}?probe=1`;
    const response = await get(withoutSlash);
    if (response) {
      if (response.status !== 301 && response.status !== 308) {
        bag.error(
          "FP1603",
          `GET ${withoutSlash} returned ${response.status}; the host must redirect the non-slash directory form.`,
        );
      } else {
        const location = response.headers.get("location") ?? "";
        if (!location.includes("probe=1")) {
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

  return bag;
}
