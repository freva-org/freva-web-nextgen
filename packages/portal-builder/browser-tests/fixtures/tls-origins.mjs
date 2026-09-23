// Real HTTPS origins on loopback, for suites that need a page the browser will treat as a site.
//
// A portal's `site.canonicalUrl` is https-only, so a generated artifact's `frame-ancestors`, its
// iframe `src` and its recorded policy all name https origins. A page served at
// `http://127.0.0.1:<port>` is not that origin: the browser refuses to frame the child, and every
// check downstream then fails at its own timeout with nothing to read. So the origins are real -
// one self-signed certificate covering several names, resolved to loopback with
// `--host-resolver-rules` - and they are ALLOCATED BEFORE THE BUILD, because the build compiles
// them into the artifact.

import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".whl": "application/octet-stream",
  ".zip": "application/zip",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".map": "application/json",
  ".ts": "text/plain; charset=utf-8",
};

/** One self-signed certificate covering every name a run serves. Throws if openssl is absent. */
export function certificate(dir, hosts) {
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "openssl.cnf");
  const names = hosts.map((h) => `DNS:${h}`).join(",");
  writeFileSync(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${hosts[0]}\n` +
      `[v3]\nsubjectAltName=${names},IP:127.0.0.1\n`,
  );
  execFileSync(
    "openssl",
    // prettier-ignore
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
     "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-config", config],
    { stdio: "ignore" },
  );
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
}

/**
 * A static server whose directory and headers may be filled in AFTER it is listening. That
 * deferral is the whole reason it exists: the origin has to be allocated before the build, and the
 * artifact's own recorded policy is only known after it. Reading `state` on every request is what
 * lets the port come first.
 */
export async function serveTls(tls, host, state) {
  const server = createServer(tls, (request, response) => {
    const url = new URL(request.url ?? "/", "https://x");
    // A hook, so a suite can BE a broken deployment. Refusing one file, or answering with
    // different bytes than the pinned ones, cannot be arranged by laying out a directory: the
    // interesting cases are a 403 from a server that has the path and will not serve it, and a 200
    // carrying substituted content. Every request is recorded either way - see `state.requests` -
    // because a claim about what a page did NOT fetch can only be checked against what it did.
    (state.requests ??= []).push({ path: url.pathname, method: request.method });
    if (state.handle?.(request, response, url)) return;
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const parts = rel.split("/").filter((p) => p && p !== "." && p !== "..");
    const file = join(state.dir, ...parts);
    if (!existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("404\n");
      return;
    }
    const bytes = readFileSync(file);
    const type = MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";
    // REAL BYTE RANGES, because a Zarr read is made of them. Answering every request with 200 and
    // the whole file is legal and very slow for the client that asked: reading one chunk of a
    // store then costs the whole object, per chunk, and a dataset a browser opens in seconds
    // against a range-capable origin takes minutes - long enough that a test written against it
    // looks like a product that hangs, when what is measured is this function.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
    if (range && !state.ignoreRanges) {
      const [, rawStart, rawEnd] = range;
      const start = rawStart === "" ? Math.max(0, bytes.length - Number(rawEnd)) : Number(rawStart);
      const end = rawStart === "" || rawEnd === "" ? bytes.length - 1 : Number(rawEnd);
      if (Number.isFinite(start) && start >= 0 && start < bytes.length) {
        const last = Math.min(end, bytes.length - 1);
        const slice = bytes.subarray(start, last + 1);
        response.writeHead(206, {
          ...state.headers,
          "content-type": type,
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${last}/${bytes.length}`,
          "content-length": String(slice.length),
        });
        response.end(slice);
        return;
      }
    }
    response.writeHead(200, {
      ...state.headers,
      "content-type": type,
      "accept-ranges": "bytes",
      "content-length": String(bytes.length),
    });
    response.end(bytes);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const origin = `https://${host}:${port}`;
  return { server, state, host, port, origin, base: `${origin}/` };
}

/** The artifact's OWN recorded policy, as one header value. */
export function portalPolicy(built) {
  const policy = JSON.parse(readFileSync(join(built, "host-policy.json"), "utf8"));
  const directives = policy.csp?.portal ?? policy.csp?.default ?? {};
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${Array.isArray(value) ? value.join(" ") : value}`)
    .join("; ");
}

/**
 * The Chromium arguments these origins need. `--no-proxy-server` is not optional: this environment
 * exports `https_proxy`, Chromium CONNECTs the loopback names through it, and the proxy's reset
 * arrives as `ERR_CONNECTION_RESET` - indistinguishable, from the test's side, from a broken TLS
 * server.
 */
export function chromiumArgs(hosts) {
  return [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--ignore-certificate-errors",
    "--no-proxy-server",
    `--host-resolver-rules=${hosts.map((h) => `MAP ${h} 127.0.0.1`).join(",")}`,
  ];
}
