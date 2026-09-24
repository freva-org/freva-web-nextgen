// The local preview server. It reproduces the routing and header behavior `host-policy.json`
// describes - directory indexes, the slash redirect with the query intact, the real 404, the
// download and callback headers - so looking at the artifact locally is useful. It is not
// proof of anything: not the canonical URL, not TLS, not a CDN, and it cannot observe an
// access log. Only `host-check` verifies a deployment.

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, normalize } from "node:path";
import { CACHE_HEADERS } from "../artifact/manifests.js";

interface ManifestFile {
  path: string;
  mimeType: string;
  cacheClass: keyof typeof CACHE_HEADERS;
  contentDisposition?: string;
}

interface HostPolicyDocument {
  csp?: {
    portal?: Record<string, string>;
    subsites?: { mount: string; directives: Record<string, string> }[];
  };
}

function cspHeader(directives: Record<string, string>): string {
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join("; ");
}

export interface PreviewOptions {
  dir: string;
  port: number;
  host?: string;
}

export function createPreviewServer(options: PreviewOptions): Server {
  const manifestPath = join(options.dir, "portal-manifest.json");
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as {
        files: ManifestFile[];
        site: { basePath: string };
      })
    : { files: [], site: { basePath: "/" } };
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  const basePath = manifest.site.basePath;

  // The artifact carries its own policy, so the preview serves it. A preview that omitted the
  // CSP would hide exactly the failures the policy exists to catch.
  const policyPath = join(options.dir, "host-policy.json");
  const policy: HostPolicyDocument = existsSync(policyPath)
    ? (JSON.parse(readFileSync(policyPath, "utf8")) as HostPolicyDocument)
    : {};
  const portalCsp = policy.csp?.portal ? cspHeader(policy.csp.portal) : undefined;
  const subsiteCsp = (policy.csp?.subsites ?? []).map((entry) => ({
    mount: entry.mount,
    header: cspHeader(entry.directives),
  }));

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let pathname = decodeURIComponent(url.pathname);

    if (basePath !== "/" && !pathname.startsWith(basePath)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        `This artifact is mounted at ${basePath}. Serving it at / is a deployment error, not a supported relocation.\n`,
      );
      return;
    }
    pathname = basePath === "/" ? pathname : pathname.slice(basePath.length - 1);

    const relative = normalize(pathname)
      .replace(/^(\.\.[/\\])+/, "")
      .replace(/^\//, "");
    const candidate = join(options.dir, relative);

    // Directory form without a trailing slash: redirect, keeping the query.
    if (!pathname.endsWith("/") && existsSync(candidate) && statSync(candidate).isDirectory()) {
      const location = `${basePath.replace(/\/$/, "")}${pathname}/${url.search}`;
      response.writeHead(308, { location });
      response.end();
      return;
    }

    const file = pathname.endsWith("/") ? join(candidate, "index.html") : candidate;
    if (!existsSync(file) || !statSync(file).isFile()) {
      const notFound = join(options.dir, "404.html");
      if (existsSync(notFound)) {
        response.writeHead(404, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": CACHE_HEADERS.revalidate,
        });
        createReadStream(notFound).pipe(response);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }

    const artifactPath =
      relative.endsWith("/") || pathname.endsWith("/")
        ? `${relative}index.html`.replace(/^\/+/, "")
        : relative;
    const entry = byPath.get(artifactPath);
    const headers: Record<string, string> = {
      "content-type": entry?.mimeType ?? "application/octet-stream",
      "cache-control": CACHE_HEADERS[entry?.cacheClass ?? "revalidate"],
      "x-content-type-options": "nosniff",
    };
    if (entry?.contentDisposition) headers["content-disposition"] = entry.contentDisposition;
    const subsite = subsiteCsp.find((s) =>
      `${basePath.replace(/\/$/, "")}${pathname}`.startsWith(s.mount),
    );
    if (subsite) headers["content-security-policy"] = subsite.header;
    else if (portalCsp) headers["content-security-policy"] = portalCsp;
    if (entry?.cacheClass === "no-store") {
      headers["referrer-policy"] = "no-referrer";
    }
    response.writeHead(200, headers);
    createReadStream(file).pipe(response);
  });
}
