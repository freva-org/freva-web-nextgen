/**
 * Serve the demo, the built package and the local runtime from one origin - because a Worker
 * cannot be created from a cross-origin URL, the same constraint any real deployment is under.
 */
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = {
  "/dist/": join(PKG, "dist"),
  "/runtime/": join(PKG, ".runtime"),
  // The console entry, bundled the way a consumer's bundler would - the published `dist/` still
  // has bare specifiers in it. Run `node browser-tests/bundle-console.mjs` (or any browser suite).
  "/bundle/": join(PKG, ".testbundle"),
  // The Freva wheels, served exactly as a deployment serves them: static files, same origin, no
  // resolution in the browser. The default `wheelhouseURL` is `freva-wheels/` beside the runtime.
  "/freva-wheels/": join(PKG, "tests", "fixtures", "wheelhouse"),
};
const DEMO = join(PKG, "demo");

/**
 * Build what the demo needs, here, rather than expecting anyone to know. `/bundle/console.js`
 * lives in `.testbundle/`, a directory only a browser suite creates, so on a fresh clone
 * `npm run build && node scripts/serve-demo.mjs` would 404 that one file - and a custom element
 * that never registers renders as NOTHING, so the page comes up with headings, controls and two
 * invisible consoles. So the server builds it and refuses to start if it cannot.
 */
function prepare() {
  const dist = join(PKG, "dist", "console", "index.js");
  if (!existsSync(dist)) {
    console.error("The package is not built.\n  npm run build\n");
    process.exit(1);
  }
  const out = join(PKG, ".testbundle");
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "entry.js"),
    'export { defineBrowserPythonConsole, BrowserPythonConsole } from "../dist/console/index.js";\n',
  );
  const esbuild = join(PKG, "..", "..", "node_modules", ".bin", "esbuild");
  if (!existsSync(esbuild)) {
    console.error("esbuild is missing. Run `npm ci` at the repository root.\n");
    process.exit(1);
  }
  try {
    execFileSync(
      esbuild,
      [
        join(out, "entry.js"),
        "--bundle",
        "--format=esm",
        `--outfile=${join(out, "console.js")}`,
        "--log-level=error",
      ],
      { cwd: PKG, stdio: "inherit" },
    );
  } catch {
    console.error("\nBundling the console failed - see the esbuild output above.\n");
    process.exit(1);
  }
  console.log("console bundled to .testbundle/console.js");
}

prepare();
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".whl": "application/octet-stream",
  ".map": "application/json",
};

const send = (res, file) => {
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": String(statSync(file).size),
  });
  createReadStream(file).pipe(res);
};

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") return send(res, join(DEMO, "index.html"));

  for (const [prefix, dir] of Object.entries(ROOTS)) {
    if (!url.pathname.startsWith(prefix)) continue;
    const file = join(dir, normalize(url.pathname.slice(prefix.length)));
    if (!file.startsWith(dir + sep)) break;
    if (existsSync(file) && statSync(file).isFile()) return send(res, file);
  }
  const local = join(DEMO, normalize(url.pathname.slice(1)));
  if (local.startsWith(DEMO) && existsSync(local) && statSync(local).isFile()) {
    return send(res, local);
  }
  // A 404 under a build output prefix is not a typo, it is a missing build step - so say which
  // one rather than making someone diff the server against the file system.
  if (url.pathname.startsWith("/dist/")) {
    return res.writeHead(404).end(`${url.pathname} is missing. Run: npm run build`);
  }
  if (url.pathname.startsWith("/runtime/")) {
    return res
      .writeHead(404)
      .end(`${url.pathname} is missing. Run: node scripts/prepare-runtime.mjs`);
  }
  res.writeHead(404).end("not found");
}).listen(8123, () => {
  console.log("demo: http://127.0.0.1:8123/");
  console.log("       http://127.0.0.1:8123/terminal.html  (one console, no controls)");
  console.log("       http://127.0.0.1:8123/freva.html     (the freva-client profile)");
  if (!existsSync(join(PKG, ".runtime", "pyodide.mjs"))) {
    console.log("no local runtime - the page will download Pyodide from the CDN.");
    console.log("to serve it yourself: node scripts/prepare-runtime.mjs");
  } else if (!hasWheels()) {
    // A runtime with no wheels is the `--minimal` outcome, and it is invisible from the page:
    // Pyodide loads, the console says Ready, and the first `import xarray` fails with a download
    // error that looks like a bug in this package. Said here, where the person who chose it is
    // looking.
    console.log("local runtime has NO wheels (prepared with --minimal).");
    console.log("  the `xarray + zarr` profile will fail to start, and `import numpy` and");
    console.log("  friends will fail on `minimal`. For those: node scripts/prepare-runtime.mjs");
  }
});

/** Whether `.runtime/` holds any wheel at all. One `readdir`, at startup. */
function hasWheels() {
  try {
    return readdirSync(join(PKG, ".runtime")).some((name) => name.endsWith(".whl"));
  } catch {
    return false;
  }
}
