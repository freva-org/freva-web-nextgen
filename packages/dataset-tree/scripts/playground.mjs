// scripts/playground.mjs - a static file server for the playground, and nothing else.
//
// No bundler, no dev-server dependency, no watch mode: the playground imports `dist/` directly as
// ES modules, so `npm run build && npm run playground` is the whole loop. The server is scoped to
// the package directory and serves two directories out of it, because a demo that can read the
// whole filesystem is a demo nobody should run.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVED = ["playground", "dist"].map((d) => join(ROOT, d));
const PORT = Number(process.env.PORT ?? 4178);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

if (!existsSync(join(ROOT, "dist", "index.js"))) {
  process.stderr.write("dist/ is missing - run `npm run build -w @freva-org/dataset-tree` first\n");
  process.exit(1);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  // A redirect rather than serving index.html at "/": the page's own URLs are relative to
  // /playground/, and serving it one directory up silently breaks every one of them.
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === "/" || url.pathname === "/playground") {
    response.writeHead(302, { location: "/playground/index.html" }).end();
    return;
  }
  const requested = url.pathname;
  const target = join(ROOT, normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, ""));

  // Two checks, not one: the path must land inside a served directory AND exist as a file.
  const contained = SERVED.some((dir) => target === dir || target.startsWith(dir + sep));
  if (!contained || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }

  const extension = target.slice(target.lastIndexOf("."));
  response.writeHead(200, {
    "content-type": TYPES[extension] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(target).pipe(response);
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`dataset-tree playground: http://127.0.0.1:${PORT}/\n`);
  process.stdout.write("Ctrl-C to stop.\n");
});
