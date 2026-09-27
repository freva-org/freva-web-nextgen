#!/usr/bin/env node
// Zero-dependency dev server for the Keycloak auth example.
//
//   GET /, /auth/callback        -> index.html (one page handles both)
//   GET /main.js                 -> the integration glue
//   GET /pkg/<package>/...       -> packages/<package>/dist/... (built workspace packages)
//   *   /api/freva-nextgen/...   -> reverse-proxied to freva-rest (FREVA_REST, default :7777)
//
// Proxying keeps page and API on one origin, like the nginx of a real deployment: no CORS, and the
// bearer only goes to its own origin.
//
//   node serve.mjs            # PORT=5173 FREVA_REST=http://localhost:7777

import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGES = resolve(HERE, "../../..");
const PORT = Number(process.env.PORT ?? 5173);
const REST = new URL(process.env.FREVA_REST ?? "http://localhost:7777");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
};

function proxy(req, res) {
  const up = request(
    {
      host: REST.hostname,
      port: REST.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: REST.host },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", () => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: `freva-rest not reachable at ${REST.origin}` }));
  });
  req.pipe(up);
}

async function file(res, path) {
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://x");
  if (pathname.startsWith("/api/freva-nextgen/")) return proxy(req, res);
  if (pathname === "/" || pathname === "/auth/callback") {
    // The callback URL carries `code`/`state`: never let it leak via Referer.
    res.setHeader("referrer-policy", "no-referrer");
    return file(res, join(HERE, "index.html"));
  }
  if (pathname === "/main.js") return file(res, join(HERE, "main.js"));
  if (pathname === "/favicon.ico") return res.writeHead(204).end();
  const m = /^\/pkg\/([\w-]+)\/(.+)$/.exec(pathname);
  if (m) {
    const root = join(PACKAGES, m[1], "dist");
    const target = normalize(join(root, m[2]));
    if (target.startsWith(root + sep)) return file(res, target);
  }
  res.writeHead(404).end("not found");
}).listen(PORT, () => {
  console.log(
    `databrowser + keycloak example on http://localhost:${PORT}  (API -> ${REST.origin})`,
  );
});
