// The same-origin notebook (`notebook.deployment: same-origin`), with a REAL interpreter and a
// REAL prepared JupyterLite site, in five deployments of one fixture:
//
//   root, base      the builder's own preview on ONE port - the portal, the notebook, its workers,
//                   the shared assets and the sign-in callback - at `/` and at `/showroom/`, built
//                   for a canonical host they are not served from (a Pages build previewed
//                   locally): everything the notebook needs must be origin-relative;
//   pages-login,    a host that sends no headers (GitHub Pages), with `metaPolicy: true`, with the
//   pages           portal's own sign-in enabled (one callback route for both) and without it;
//   mixed           the notebook on the portal beside a console on its own origin (no
//                   `consoleInPage`), over HTTPS on real origins.
//
// The pinned runtime comes from a local directory standing in for its CDN, as in the other
// interpreter suites.
//
// Usage:  node browser-tests/notebook-same-origin.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { pageMetaPolicyProblem } from "@freva-org/jupyterlite-freva-kernel/prepare";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "..", "..");
const RUNTIME =
  process.env.FREVA_PYODIDE_RUNTIME ?? join(REPO, "packages", "browser-python", ".runtime");
const STRICT = process.env.BROWSER_STRICT === "1";
const RUN = mkdtempSync(join(tmpdir(), `nb-same-origin-${Date.now()}-`));
const STARTUP_MS = 300_000;
const PYTHON = process.env.FREVA_PYTHON ?? "python3";
const HOSTS = { portal: "portal-mixed.example.org", console: "play-mixed.example.org" };

function skip(message) {
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}
if (!existsSync(join(RUNTIME, "pyodide.js"))) skip(`no local Pyodide runtime at ${RUNTIME}`);
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  skip(`playwright is not installed: ${error.message}`);
}
const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".whl": "application/octet-stream",
};
const mime = (file) => MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";

/** The runtime's stand-in CDN: test infrastructure, not part of the deployment. */
async function serveRuntime() {
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname).slice(1);
    const file = join(RUNTIME, ...name.split("/").filter((p) => p && p !== ".."));
    if (!name || !existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": mime(file), "access-control-allow-origin": "*" });
    response.end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, base: `http://127.0.0.1:${server.address().port}/` };
}

/**
 * A host that sends no response headers beyond the type (GitHub Pages): the artifact mounted at
 * its base path, directory indexes, and `Access-Control-Allow-Origin: *` as Pages sends it.
 */
function staticHandler(state) {
  return (request, response) => {
    let path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    if (!path.startsWith(state.basePath)) {
      response.writeHead(404);
      response.end();
      return;
    }
    path = path.slice(state.basePath.length);
    let file = join(state.dir, ...path.split("/").filter((p) => p && p !== "." && p !== ".."));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": mime(file),
      "access-control-allow-origin": "*",
      ...(state.headers ?? {}),
    });
    response.end(readFileSync(file));
  };
}

function certificate() {
  const dir = join(RUN, "tls");
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "openssl.cnf");
  writeFileSync(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${HOSTS.portal}\n` +
      `[v3]\nsubjectAltName=${Object.values(HOSTS)
        .map((h) => `DNS:${h}`)
        .join(",")},IP:127.0.0.1\n`,
  );
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2"].concat([
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-config",
      config,
    ]),
    { stdio: "ignore" },
  );
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
}

/** A tiny pure-Python wheel, served under the base path like the showroom's healpix-geo. */
function probeWheel(dir) {
  const name = "portalprobe-0.1-py3-none-any.whl";
  execFileSync(PYTHON, [
    "-I",
    "-c",
    [
      "import sys, zipfile",
      "files = {",
      "  'portalprobe/__init__.py': 'VALUE = \"served under the base path\"\\n',",
      "  'portalprobe-0.1.dist-info/METADATA': 'Metadata-Version: 2.1\\nName: portalprobe\\nVersion: 0.1\\n',",
      "  'portalprobe-0.1.dist-info/WHEEL': 'Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',",
      "}",
      "files['portalprobe-0.1.dist-info/RECORD'] = ''.join(f'{p},,\\n' for p in files) + 'portalprobe-0.1.dist-info/RECORD,,\\n'",
      "with zipfile.ZipFile(sys.argv[1], 'w') as z:",
      "  for p, t in files.items(): z.writestr(zipfile.ZipInfo(p, (2020, 1, 1, 0, 0, 0)), t)",
    ].join("\n"),
    join(dir, name),
  ]);
  writeFileSync(join(dir, "wheels.json"), JSON.stringify([name]));
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Mark</title><rect width="16" height="16" fill="#123456"/></svg>`;

function buildSite(name, { canonical, runtimeIndexUrl, login, meta, consoleOrigin }) {
  const src = join(RUN, `${name}-src`);
  const put = (rel, body) => {
    const target = join(src, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put(
    "content/index.md",
    "# Same origin\n\n```python try-in-python\nimport portalprobe\nprint('done', portalprobe.VALUE)\n```\n",
  );
  mkdirSync(join(src, "wheels"), { recursive: true });
  probeWheel(join(src, "wheels"));
  put("fragments/run.md", "```python try-in-python\nprint('landing', 6 * 7)\n```\n");
  put(
    "landings/home.yaml",
    "schemaVersion: 1\ntitle: Same origin\nblocks:\n  - type: hero\n    heading: Docs\n" +
      "  - type: notebook\n    heading: Your notebook\n" +
      "  - type: dataset-tree\n    catalog: ../data/archive.json\n    heading: Browse\n" +
      "  - type: prose\n    source: ../fragments/run.md\n",
  );
  put(
    "data/archive.json",
    JSON.stringify({
      schemaVersion: 1,
      roots: [
        {
          id: "archive",
          kind: "collection",
          name: "Archive",
          children: [
            {
              id: "archive/probe",
              kind: "dataset",
              name: "probe.zarr",
              path: "archive/probe.zarr",
            },
          ],
        },
      ],
    }),
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: nb-same-origin-${name}
  title: Same origin
  language: en
  canonicalUrl: ${canonical}
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: default
rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
  downloads:
    - root: ./wheels
      mount: /python-wheels/
      files:
        include: ["*.whl", "wheels.json"]
landings:
  home:
    path: /
    source: ./landings/home.yaml
${
  login
    ? `services:
  authBroker:
    kind: auth
    baseUrl: https://auth.example.org/v2
components:
  login:
    kind: auth
    enabled: true
    service: authBroker
`
    : ""
}pythonPlayground:
  enabled: true
  profile: minimal
  autostart: never
  maxSessions: 2
${consoleOrigin ? `  playgroundOrigin: ${consoleOrigin}\n` : "  consoleInPage: true\n"}  runtimeIndexUrl: ${runtimeIndexUrl}
  initialSource: |
    import micropip
    from pyodide.http import pyfetch
    _names = await (await pyfetch(PORTAL_BASE_URL + "python-wheels/wheels.json")).json()
    await micropip.install([PORTAL_BASE_URL + "python-wheels/" + _n for _n in _names], deps=False)
    STARTED = "yes"
    del micropip, pyfetch, _names
  notebook:
    enabled: true
    deployment: same-origin
${meta ? "    metaPolicy: true\n" : ""}    assistant:
      climateclaw:
        host: https://freva.example.org
        defaultModel: gpt-test
    dataPanel:
      tree: home-2
  terminal:
    style: freva-client-terminal
    osControls: linux
    alwaysOnTop: true
    rememberAppearance: false
`,
  );
  const out = join(RUN, `${name}-built`);
  const cli = join(PKG, "bin", "freva-portal-builder.mjs");
  const config = ["--source-root", src, "--config", join(src, "portal.yaml")];
  const env = { ...process.env, SOURCE_DATE_EPOCH: "1760000000" };
  const notebookDir = join(RUN, `${name}-notebook`);
  execFileSync(process.execPath, [cli, "prepare-notebook", ...config, "--out", notebookDir], {
    stdio: ["ignore", "ignore", "inherit"],
    env,
  });
  const printed = execFileSync(
    process.execPath,
    [cli, "build", ...config, "--out", out, "--quiet", "--notebook", notebookDir],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env },
  );
  execFileSync(process.execPath, [cli, "verify", "--dir", out], { stdio: "ignore" });
  return { out, printed };
}

function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(
      `  FAIL ${name}\n       ${String(error.message).split("\n").slice(0, 6).join("\n       ")}`,
    );
  }
}

/** The page's meta policy, when the parser finds it its only one, first in `<head>`. */
const metaPolicyOf = (html) => {
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
  return policy && pageMetaPolicyProblem(html, policy) === null ? policy : undefined;
};

const ACTIVE = ".jp-NotebookPanel:not(.lm-mod-hidden)";
/** Wait for the visible notebook's kernel to be idle with nothing running. */
async function idle(page) {
  await page.waitForFunction(
    (active) => {
      const panel = document.querySelector(active);
      const status = panel?.querySelector(".jp-Notebook-ExecutionIndicator[data-status]");
      const running = [...(panel?.querySelectorAll(".jp-InputPrompt") ?? [])].some((p) =>
        p.textContent.includes("*"),
      );
      return status?.getAttribute("data-status") === "idle" && !running;
    },
    ACTIVE,
    { timeout: STARTUP_MS, polling: 500 },
  );
}
async function runCell(page, code) {
  const cells = page.locator(`${ACTIVE} .jp-Notebook .jp-CodeCell`);
  const index = (await cells.count()) - 1;
  const editor = cells.nth(index).locator(".cm-content");
  // A fresh notebook's editor can take the click before it takes keys: type until the cell holds
  // the code (an empty cell would run without a count, and without its output).
  const first = code.split("\n")[0];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await editor.click();
    await page.keyboard.insertText(code);
    if ((await editor.textContent())?.includes(first)) break;
    await page.waitForTimeout(500);
  }
  assert.ok((await editor.textContent())?.includes(first), "the code did not reach its cell");
  await page.keyboard.press("Shift+Enter");
  // Done when THIS cell has its execution count: the kernel may report idle before the request
  // has even reached it.
  await page.waitForFunction(
    ([active, at]) => {
      const cell = document.querySelectorAll(`${active} .jp-Notebook .jp-CodeCell`).item(at);
      return /\[\d+\]/.test(cell?.querySelector(".jp-InputPrompt")?.textContent ?? "");
    },
    [ACTIVE, index],
    { timeout: STARTUP_MS, polling: 500 },
  );
  await idle(page);
}
const outputs = (page, html = false) =>
  page.evaluate(
    ([active, html]) =>
      [...document.querySelectorAll(`${active} .jp-OutputArea`)]
        .map((o) => (html ? o.innerHTML : o.textContent))
        .join("\n"),
    [ACTIVE, html],
  );

let browser;
const servers = [];
const listen = (server) =>
  new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));
try {
  const runtime = await serveRuntime();
  servers.push(runtime.server);
  const TLS = certificate();
  browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-proxy-server",
      "--ignore-certificate-errors",
      `--host-resolver-rules=${Object.values(HOSTS)
        .map((h) => `MAP ${h} 127.0.0.1`)
        .join(",")}`,
    ],
    ...(process.env.FREVA_PORTAL_CHROMIUM || process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? {
          executablePath: process.env.FREVA_PORTAL_CHROMIUM || process.env.PLAYWRIGHT_CHROMIUM_PATH,
        }
      : {}),
  });

  const CONFIGS = [
    { name: "root", basePath: "/", host: "preview" },
    { name: "base", basePath: "/showroom/", host: "preview" },
    { name: "pages-login", basePath: "/showroom/", host: "static", meta: true, login: true },
    { name: "pages", basePath: "/", host: "static", meta: true },
    { name: "mixed", basePath: "/", host: "mixed" },
  ];
  for (const cfg of CONFIGS) {
    const { basePath } = cfg;
    const label = cfg.name;
    let origin;
    let built;
    let printed;
    let consoleOrigin;
    if (cfg.host === "mixed") {
      // HTTPS on two real origins: the console's frame answers the portal's canonical origin only.
      const portalState = { handler: () => undefined };
      const consoleState = { dir: join(RUN, "mixed-console"), basePath: "/", headers: {} };
      const portalServer = createHttpsServer(TLS, (q, r) => portalState.handler(q, r));
      const consoleServer = createHttpsServer(TLS, staticHandler(consoleState));
      servers.push(portalServer, consoleServer);
      origin = `https://${HOSTS.portal}:${await listen(portalServer)}`;
      consoleOrigin = `https://${HOSTS.console}:${await listen(consoleServer)}`;
      ({ out: built, printed } = buildSite(label, {
        canonical: `${origin}/`,
        runtimeIndexUrl: runtime.base,
        consoleOrigin,
      }));
      // The portal through the builder's own preview, plus Pages' CORS header (the console's
      // starter reads the portal's wheels).
      const preview = createPreviewServer({ dir: built, port: 0 });
      const handle = preview.listeners("request")[0];
      portalState.handler = (q, r) => {
        r.setHeader("access-control-allow-origin", "*");
        handle(q, r);
      };
      const deployment = JSON.parse(
        readFileSync(join(built, "playground-origin", "deploy.json"), "utf8"),
      );
      for (const file of deployment.files) {
        const to =
          file === deployment.entry
            ? join(consoleState.dir, "index.html")
            : join(consoleState.dir, ...file.split("/"));
        mkdirSync(dirname(to), { recursive: true });
        cpSync(join(built, ...file.split("/")), to);
      }
      consoleState.headers = Object.fromEntries(
        Object.entries(deployment.headers).map(([k, v]) => [k.toLowerCase(), v]),
      );
      await check(`${label}: the console's deployment carries nothing of the notebook`, () => {
        assert.equal(deployment.callback, undefined);
        assert.equal(deployment.pathHeaders, undefined);
        assert.deepEqual(
          deployment.files.filter((f) => /notebook|auth\/callback/.test(f)),
          [],
        );
        assert.ok(!existsSync(join(built, "playground-origin", "notebook")));
        assert.ok(!existsSync(join(built, "playground-origin", "auth")));
        assert.match(
          deployment.headers["Content-Security-Policy"],
          new RegExp(`connect-src [^;]*${origin.replace(/[.]/g, "\\.")}`),
        );
        // The URL to register is the portal's, where the notebook signs in.
        assert.match(
          printed,
          new RegExp(`notebook +login +${origin.replace(/[.]/g, "\\.")}/auth/callback/`),
        );
        assert.doesNotMatch(printed, new RegExp(`${consoleOrigin.replace(/[.]/g, "\\.")}/auth/`));
      });
    } else {
      ({ out: built } = buildSite(label, {
        canonical: `https://portal.example.org${basePath}`,
        runtimeIndexUrl: runtime.base,
        login: cfg.login,
        meta: cfg.meta,
      }));
      const server =
        cfg.host === "preview"
          ? createPreviewServer({ dir: built, port: 0 })
          : createServer(staticHandler({ dir: built, basePath }));
      servers.push(server);
      origin = `http://localhost:${await listen(server)}`;
    }
    const base = `${origin}${basePath}`;
    const policy = JSON.parse(readFileSync(join(built, "host-policy.json"), "utf8"));

    await check(`${label}: one artifact holds the notebook and its sign-in callback`, () => {
      assert.ok(existsSync(join(built, "notebook", "lab", "index.html")));
      assert.ok(existsSync(join(built, "auth", "callback", "index.html")));
      assert.equal(existsSync(join(built, "playground-origin")), cfg.host === "mixed");
      assert.ok(
        readFileSync(join(built, "checksums.sha256"), "utf8").includes("  notebook/lab/index.html"),
      );
    });

    if (basePath !== "/") {
      await check(`${label}: no URL in the build leaks to the domain root`, () => {
        const leaks = [];
        for (const file of walk(built)) {
          if (!/\.(html|js|mjs|json|css)$/.test(file)) continue;
          // JSON schemas describe the setting in prose ("/auth/callback/" as an example), and the
          // artifact's own manifests record routes site-relatively.
          if (/\/schemas\//.test(file) || /^[^/]+\.json$/.test(file)) continue;
          const text = readFileSync(join(built, ...file.split("/")), "utf8");
          for (const m of text.matchAll(
            /(?:(?:src|href|action)=|["'`(])\/(_portal|notebook|auth\/callback|python-wheels|python-addons|freva-wheels|_badge|identity)\//g,
          )) {
            // A source comment naming the path is prose, not a URL the page loads.
            const line = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index).trim();
            if (/^(\/\/|\*|\/\*)/.test(line)) continue;
            // The portal's sign-in configuration names its callback site-relatively, and its
            // client joins it to the base path (`callbackUrl`).
            if (file.startsWith("_portal/") && m[1] === "auth/callback") continue;
            leaks.push(`${file}: ${m[0]}`);
          }
        }
        assert.deepEqual(leaks.slice(0, 5), []);
      });
    }

    if (cfg.host === "preview") {
      await check(
        `${label}: the preview serves each path with its own policy, on one port`,
        async () => {
          const get = (path) => fetch(`${origin}${path}`, { redirect: "manual" });
          const portal = await get(basePath);
          assert.equal(portal.status, 200);
          assert.match(
            portal.headers.get("content-security-policy") ?? "",
            /frame-ancestors 'none'/,
          );
          const lab = await get(`${basePath}notebook/lab/index.html`);
          assert.equal(lab.status, 200);
          const labCsp = lab.headers.get("content-security-policy") ?? "";
          assert.match(labCsp, /frame-ancestors 'self'/);
          assert.match(labCsp, /script-src 'self' 'wasm-unsafe-eval'/);
          assert.doesNotMatch(labCsp, /'unsafe-eval'/);
          const own = policy.csp.paths.find((p) => p.match.prefix === `${basePath}notebook/`);
          assert.ok(own, "host-policy.json names the notebook's own policy");
          const worker = walk(built).find(
            (f) => f.startsWith("notebook/") && /worker.*\.js$/.test(f),
          );
          if (worker) {
            const w = await get(`${basePath}${worker}`);
            assert.equal(
              w.headers.get("content-security-policy"),
              labCsp,
              "the kernel Worker's policy",
            );
          }
          const callback = await get(`${basePath}auth/callback/?code=x&state=y`);
          assert.equal(callback.status, 200);
          assert.equal(callback.headers.get("cache-control"), "no-store");
          assert.match(
            callback.headers.get("content-security-policy") ?? "",
            /^default-src 'none'/,
          );
          assert.equal((await get(`${basePath}python-wheels/wheels.json`)).status, 200);
          if (basePath !== "/") assert.equal((await get("/notebook/lab/index.html")).status, 404);
        },
      );
    }

    if (cfg.meta) {
      await check(
        `${label}: with no headers, each document carries its own policy as a meta tag`,
        async () => {
          const lab = await fetch(`${base}notebook/lab/index.html`);
          assert.equal(
            lab.headers.get("content-security-policy"),
            null,
            "the host sends no policy",
          );
          const labMeta = metaPolicyOf(await lab.text());
          const labHeader = policy.csp.paths.find((p) => p.match.prefix === `${basePath}notebook/`);
          assert.ok(labMeta, "the notebook page has no meta policy");
          assert.doesNotMatch(labMeta, /frame-ancestors/);
          assert.match(
            labMeta,
            new RegExp(
              `connect-src ${labHeader.directives["connect-src"].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
            ),
          );
          const callbackMeta = metaPolicyOf(await (await fetch(`${base}auth/callback/`)).text());
          assert.ok(callbackMeta, "the callback page has no meta policy");
          assert.doesNotMatch(callbackMeta, /frame-ancestors/);
          if (cfg.login) {
            // The portal's own route: the portal's whole policy, which its same-tab sign-in needs.
            assert.match(callbackMeta, /connect-src [^;]*https:\/\/auth\.example\.org/);
          } else {
            assert.match(callbackMeta, /^default-src 'none'; script-src 'self'/);
          }
        },
      );
    }

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
    });
    const problems = [];
    const foreign = new Set();
    context.on("request", (r) => {
      const u = new URL(r.url());
      if (
        !/^(data|blob):/.test(r.url()) &&
        u.origin !== origin &&
        u.origin !== consoleOrigin &&
        !r.url().startsWith(runtime.base)
      )
        foreign.add(u.origin);
    });
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) =>
        console.log(
          `CSPVIOLATION ${location.pathname} ${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}`,
        ),
      );
    });
    const watch = (page) => {
      page.on("console", (m) => {
        const text = m.text();
        // jupyterlite-ai's zod probes for eval once and falls back: the one tolerated refusal.
        if (
          text.startsWith("CSPVIOLATION") &&
          !/script-src(-elem)? eval .*@jupyternaut\/persona/.test(text)
        )
          problems.push(text);
      });
      page.on("pageerror", (e) =>
        problems.push(
          `pageerror ${page.url()}: ${String(e.message).slice(0, 300)}\n${String(e.stack ?? "")
            .split("\n")
            .slice(1, 6)
            .join("\n")}`,
        ),
      );
    };
    context.on("page", watch);

    try {
      const page = await context.newPage();
      await check(
        `${label}: the landing frames the notebook from its own origin, and it starts`,
        async () => {
          await page.goto(base, { waitUntil: "domcontentloaded" });
          const frameEl = page.locator(".portal-notebook-frame");
          await frameEl.scrollIntoViewIfNeeded();
          assert.equal(await frameEl.getAttribute("src"), `${basePath}notebook/lab/index.html`);
          const frame = await (await frameEl.elementHandle()).contentFrame();
          await frame.waitForSelector(".jp-LabShell", { timeout: 120_000 });
          const open = await page.locator("[data-portal-notebook-open]").getAttribute("href");
          assert.equal(new URL(open, base).pathname, `${basePath}notebook/lab/index.html`);
        },
      );

      const lab = await context.newPage();
      await check(`${label}: notebook/lab/ opens directly, and again after a reload`, async () => {
        await lab.goto(`${base}notebook/lab/`);
        await lab.waitForSelector(".jp-LabShell", { timeout: 120_000 });
        await lab.reload();
        await lab.waitForSelector(".jp-LabShell", { timeout: 120_000 });
        const workers = await lab.evaluate(async () =>
          navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0,
        );
        assert.equal(workers, 0, "no service worker is registered");
      });

      await check(
        `${label}: the kernel's starter loads a wheel from under the base path`,
        async () => {
          await lab
            .locator(".jp-Launcher:visible .jp-LauncherCard", { hasText: "Freva Python" })
            .first()
            .click();
          await lab.waitForSelector(`${ACTIVE} .jp-Notebook .jp-Cell .cm-content`, {
            timeout: 60_000,
          });
          await runCell(
            lab,
            "import portalprobe\nprint(PORTAL_BASE_URL, STARTED, portalprobe.VALUE)",
          );
          assert.match(
            await outputs(lab),
            new RegExp(`${base.replace(/[./]/g, "\\$&")} yes served under the base path`),
          );
        },
      );

      await check(
        `${label}: hostile HTML and SVG outputs are still sanitised, and nothing they carry runs`,
        async () => {
          await runCell(
            lab,
            'display({"text/plain": "hostile", "text/html": "<img src=x onerror=\\"window.top.__pwned=3\\"><script>window.top.__pwned=4</script><b id=\\"safe\\">safe</b>"}, raw=True)\n' +
              'display({"text/plain": "svg", "image/svg+xml": "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"20\\" height=\\"20\\" onload=\\"window.top.__pwned=1\\"><script>window.top.__pwned=2</script><rect width=\\"10\\" height=\\"10\\"/></svg>"}, raw=True)',
          );
          await lab.waitForTimeout(1000);
          const html = await outputs(lab, true);
          assert.match(html, /safe/);
          assert.doesNotMatch(html, /onerror|<script|onload/i);
          assert.equal(await lab.evaluate(() => window.__pwned), undefined);
          assert.equal(await page.evaluate(() => window.__pwned), undefined);
        },
      );

      await check(
        cfg.host === "mixed"
          ? `${label}: the console on its own origin installs the portal's wheel, and 'Open as notebook' opens the portal's notebook`
          : `${label}: 'Open as notebook' in the page's console opens it on the same origin`,
        async () => {
          const docs = await context.newPage();
          await docs.goto(`${base}docs/`, { waitUntil: "domcontentloaded" });
          await docs.waitForSelector(".portal-code-figure", { timeout: 30_000 });
          await docs.click(".portal-code-figure .portal-code-run");
          const done = () =>
            document.querySelector("freva-python-console")?.transcript?.().includes("done served");
          let consoleFrame = docs.mainFrame();
          if (cfg.host === "mixed") {
            await docs.waitForSelector(".portal-python-frame", { timeout: 30_000 });
            consoleFrame = await (await docs.$(".portal-python-frame")).contentFrame();
            assert.equal(new URL(consoleFrame.url()).origin, consoleOrigin);
          }
          await consoleFrame.waitForFunction(done, null, { timeout: STARTUP_MS, polling: 1000 });
          // The starter shows as written; PORTAL_BASE_URL was defined without showing.
          const transcript = await consoleFrame.evaluate(() =>
            document.querySelector("freva-python-console").transcript(),
          );
          assert.match(
            transcript,
            /import micropip\n[\s\S]*pyfetch\(PORTAL_BASE_URL \+ "python-wheels/,
          );
          assert.doesNotMatch(transcript, /_portal|PORTAL_BASE_URL =/);
          const popup = context.waitForEvent("page", { timeout: 30_000 });
          await docs.click(".freva-term .term-kebab");
          await docs.waitForSelector(".term-menu.show", { timeout: 5_000 });
          await docs
            .locator(".tmn-sections .tmn-item", { hasText: "Open as notebook" })
            .first()
            .click();
          const notebook = await popup;
          await notebook.waitForLoadState("domcontentloaded");
          assert.match(
            notebook.url(),
            new RegExp(
              `^${base.replace(/[./]/g, "\\$&")}notebook/notebooks/index\\.html\\?path=examples%2Fexample-[0-9a-f]{12}\\.ipynb`,
            ),
          );
          await notebook.waitForSelector(".jp-Notebook .jp-Cell", { timeout: 120_000 });
        },
      );

      await check(
        `${label}: the tree's Notebook button opens the notebook in a sheet on the page, Escape closes it`,
        async () => {
          await page.goto(base, { waitUntil: "domcontentloaded" });
          const button = page.locator("[data-portal-tree-notebook]");
          await button.scrollIntoViewIfNeeded();
          await button.click();
          const sheet = page.locator("[data-portal-notebook-sheet] .portal-notebook-window");
          await sheet.waitFor({ state: "visible", timeout: 10_000 });
          const frameEl = sheet.locator("iframe");
          const src = new URL(await frameEl.getAttribute("src"));
          assert.equal(src.origin, new URL(base).origin);
          assert.equal(src.pathname, `${basePath}notebook/lab/index.html`);
          assert.equal(src.search, "?panel=data");
          const frame = await (await frameEl.elementHandle()).contentFrame();
          await frame.waitForSelector(".jp-LabShell", { timeout: 120_000 });
          await frame.waitForSelector("#freva-data-panel:not(.lm-mod-hidden)", { timeout: 60_000 });
          const accept = frame.locator(".jp-Dialog .jp-mod-accept");
          for (let quiet = 0; quiet < 2; ) {
            await frame.waitForTimeout(1000);
            if ((await accept.count()) === 0) quiet += 1;
            else {
              quiet = 0;
              await accept.first().click();
            }
          }
          for (let i = 0; i < 12; i += 1) await page.keyboard.press("Tab");
          assert.ok(
            await page.evaluate(
              () => !!document.activeElement?.closest("[data-portal-notebook-sheet]"),
            ),
            "Tab stays in the sheet",
          );
          assert.equal(
            await page
              .locator("header, main")
              .first()
              .evaluate((e) => e.closest("[inert]") !== null),
            true,
          );
          await frame.locator("#freva-data-panel").click();
          await frame.locator(".lm-MenuBar-item", { hasText: "Help" }).click();
          await frame.locator(".lm-Menu-item", { hasText: "About" }).first().click();
          await frame.locator(".jp-Dialog").waitFor({ timeout: 10_000 });
          await frame.waitForFunction(
            () => document.querySelector(".jp-Dialog")?.contains(document.activeElement),
            null,
            { timeout: 10_000 },
          );
          await page.keyboard.press("Escape");
          await frame.locator(".jp-Dialog").waitFor({ state: "detached", timeout: 5_000 });
          assert.ok(await sheet.isVisible(), "Escape dismissed only the notebook's dialog");
          await frame.locator("#freva-data-panel").click();
          await page.keyboard.press("Escape");
          await sheet.waitFor({ state: "hidden", timeout: 5_000 });
          assert.equal(
            await page
              .locator("header, main")
              .first()
              .evaluate((e) => e.closest("[inert]") !== null),
            false,
          );
          assert.equal(page.url(), base);
        },
      );

      await check(
        `${label}: the sheet keeps its notebook through theme switches made while it was closed`,
        async () => {
          const toggle = page.locator(".portal-theme-toggle");
          await toggle.click();
          await page.waitForTimeout(1500);
          await toggle.click();
          await page.waitForTimeout(1500);
          await toggle.click();
          await page.waitForTimeout(1500);
          await page.locator("[data-portal-tree-notebook]").click();
          const sheet = page.locator("[data-portal-notebook-sheet] .portal-notebook-window");
          await sheet.waitFor({ state: "visible", timeout: 10_000 });
          const frame = await (await sheet.locator("iframe").elementHandle()).contentFrame();
          await frame.waitForTimeout(2000);
          const layout = await frame.evaluate(() => {
            const width = (selector) =>
              document.querySelector(selector)?.getBoundingClientRect().width ?? 0;
            return {
              shell: width("#main"),
              dock: width("#jp-main-dock-panel"),
              data: width("#freva-data-panel"),
            };
          });
          assert.ok(
            layout.dock > layout.shell * 0.3,
            `the notebook area is visible: ${JSON.stringify(layout)}`,
          );
          assert.ok(
            layout.data > 0 && layout.data < layout.shell * 0.6,
            `the data panel keeps its width: ${JSON.stringify(layout)}`,
          );
          await page.locator("[data-portal-notebook-close]").click();
          await sheet.waitFor({ state: "hidden", timeout: 5_000 });
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.locator("[data-portal-tree-notebook]").click();
          await sheet.waitFor({ state: "visible", timeout: 10_000 });
          const again = await (await sheet.locator("iframe").elementHandle()).contentFrame();
          await again.waitForSelector("#freva-data-panel:not(.lm-mod-hidden)", {
            timeout: 120_000,
          });
          const accept = again.locator(".jp-Dialog .jp-mod-accept");
          for (let quiet = 0; quiet < 2; ) {
            await again.waitForTimeout(1000);
            if ((await accept.count()) === 0) quiet += 1;
            else {
              quiet = 0;
              await accept.first().click();
            }
          }
          const reloaded = await again.evaluate(() => {
            const width = (selector) =>
              document.querySelector(selector)?.getBoundingClientRect().width ?? 0;
            return { shell: width("#main"), data: width("#freva-data-panel") };
          });
          assert.ok(
            reloaded.data < reloaded.shell * 0.6,
            `after a reload the data panel keeps its width: ${JSON.stringify(reloaded)}`,
          );
          await page.locator("[data-portal-notebook-close]").click();
          await sheet.waitFor({ state: "hidden", timeout: 5_000 });
        },
      );

      await check(
        `${label}: a dataset's Open in notebook opens its notebook in the same sheet`,
        async () => {
          await page.locator('[data-dataset-tree-id="archive"] .dataset-tree__row').first().click();
          await page
            .locator('[data-dataset-tree-id="archive/probe"] .dataset-tree__row')
            .first()
            .click();
          await page.locator('[data-dt-key="notebook:archive/probe"]').click();
          const sheet = page.locator("[data-portal-notebook-sheet] .portal-notebook-window");
          await sheet.waitFor({ state: "visible", timeout: 10_000 });
          assert.equal(await page.locator("[data-portal-notebook-sheet]").count(), 1);
          const frame = await (await sheet.locator("iframe").elementHandle()).contentFrame();
          await frame.waitForFunction(
            () =>
              [...document.querySelectorAll(".jp-NotebookPanel:not(.lm-mod-hidden) .jp-Cell")].some(
                (cell) => cell.textContent?.includes("probe.zarr"),
              ),
            null,
            { timeout: 120_000, polling: 500 },
          );
          assert.match(
            await frame.locator(".jp-FrevaData-selectedName").innerText(),
            /probe\.zarr/,
          );
          const tab = new URL(
            await page
              .locator("[data-portal-notebook-sheet] [data-portal-notebook-open]")
              .getAttribute("href"),
          );
          assert.match(tab.searchParams.get("dataset") ?? "", /probe/);
          assert.equal(tab.searchParams.get("panel"), "data");
          await frame.locator(".jp-NotebookPanel:not(.lm-mod-hidden) .jp-Cell").first().click();
          await page.keyboard.press("Enter");
          await frame
            .locator(".jp-NotebookPanel:not(.lm-mod-hidden) .jp-Notebook.jp-mod-editMode")
            .waitFor({ timeout: 5_000 });
          await page.keyboard.press("Escape");
          await page.waitForTimeout(500);
          assert.ok(await sheet.isVisible(), "the first Escape only leaves the cell's editor");
          await page.keyboard.press("Escape");
          await sheet.waitFor({ state: "hidden", timeout: 5_000 });
          await page.locator('[data-dt-key="notebook:archive/probe"]').click();
          await sheet.waitFor({ state: "visible", timeout: 10_000 });
          await page.locator("[data-portal-notebook-close]").click();
          await sheet.waitFor({ state: "hidden", timeout: 5_000 });
        },
      );

      await check(
        `${label}: a Python window stays usable over the sheet, and closing it leaves the sheet open`,
        async () => {
          for (const other of context.pages()) if (other !== page) await other.close();
          await page.locator(".portal-code-figure .portal-code-run").first().click();
          const term = page.locator(".freva-term.show");
          await term.waitFor({ timeout: 30_000 });
          let consoleFrame = page.mainFrame();
          if (cfg.host === "mixed") {
            await page.waitForSelector(".portal-python-frame", { timeout: 30_000 });
            consoleFrame = await (await page.$(".portal-python-frame")).contentFrame();
          }
          const said = (text) =>
            consoleFrame.waitForFunction(
              (wanted) =>
                document.querySelector("freva-python-console")?.transcript?.().includes(wanted),
              text,
              { timeout: STARTUP_MS, polling: 500 },
            );
          await said("landing 42");
          await page.locator("[data-portal-tree-notebook]").evaluate((button) => button.click());
          const sheet = page.locator("[data-portal-notebook-sheet] .portal-notebook-window");
          await sheet.waitFor({ state: "visible", timeout: 10_000 });
          const bar = page.locator(".freva-term.show .term-bar");
          const before = await bar.boundingBox();
          const seen = await page.evaluate(
            ({ x, y }) => {
              const hit = document.elementFromPoint(x, y);
              return {
                owner: hit?.closest(".freva-term, [data-portal-notebook-sheet]")?.className ?? "?",
                inert: !!hit?.closest("[inert]"),
              };
            },
            {
              x: Math.round(before.x + before.width / 2),
              y: Math.round(before.y + before.height / 2),
            },
          );
          assert.match(
            seen.owner,
            /freva-term/,
            `the sheet covers the Python window: ${seen.owner}`,
          );
          assert.equal(seen.inert, false, "the Python window is inert while the sheet is open");
          await page.locator(".freva-term.show .term-body").click();
          await consoleFrame.waitForFunction(
            () => document.activeElement?.closest("freva-python-console") !== null,
            null,
            { timeout: 5_000 },
          );
          await page.waitForTimeout(500);
          await page.keyboard.type("print('typed', 6 * 7)");
          await page.keyboard.press("Enter");
          await said("typed 42");
          await page.keyboard.press("Escape");
          await page.waitForTimeout(300);
          assert.ok(await sheet.isVisible(), "Escape in the Python window closed the sheet");
          await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
          await page.mouse.down();
          await page.mouse.move(
            before.x + before.width / 2 - 80,
            before.y + before.height / 2 + 60,
            {
              steps: 8,
            },
          );
          await page.mouse.up();
          const after = await bar.boundingBox();
          assert.ok(
            Math.abs(after.x - before.x) > 40 || Math.abs(after.y - before.y) > 30,
            `the Python window did not move: ${JSON.stringify({ before, after })}`,
          );
          await page.locator(".freva-term.show .tl.close").click();
          await term.waitFor({ state: "hidden", timeout: 5_000 });
          assert.ok(await sheet.isVisible(), "closing the Python window closed the sheet");
          await page.locator("[data-portal-notebook-close]").click();
          await sheet.waitFor({ state: "hidden", timeout: 5_000 });
        },
      );

      await check(
        `${label}: from the maximized tree the notebook opens over it, and Escape returns to the tree`,
        async () => {
          await page.locator("[data-portal-tree-expand]").click();
          const tree = page.locator(".portal-sheet");
          await tree.waitFor({ state: "visible", timeout: 10_000 });
          await page.locator(".portal-sheet [data-portal-tree-notebook]").click();
          const sheet = page.locator("[data-portal-notebook-sheet] .portal-notebook-window");
          await sheet.waitFor({ state: "visible", timeout: 10_000 });
          const box = await sheet.boundingBox();
          const owner = await page.evaluate(
            ({ x, y }) =>
              document
                .elementFromPoint(x, y)
                ?.closest("[data-portal-notebook-sheet], .portal-sheet")?.className ?? "?",
            { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + 12) },
          );
          assert.match(owner, /portal-notebook-sheet/, `the maximized tree covers the notebook`);
          await page.keyboard.press("Escape");
          await sheet.waitFor({ state: "hidden", timeout: 5_000 });
          assert.ok(await tree.isVisible(), "Escape closed the maximized tree with the notebook");
          await page.keyboard.press("Escape");
          await tree.waitFor({ state: "hidden", timeout: 5_000 });
        },
      );

      await check(
        `${label}: a direct visit to the sign-in callback runs its script to the end${cfg.meta ? ", under its meta policy" : ""}`,
        async () => {
          const cb = await context.newPage();
          await cb.goto(`${base}auth/callback/`, { waitUntil: "load" });
          // The static page says "working"; only the callback's script, having found no sign-in
          // under way, says "idle".
          await cb.waitForSelector('[data-auth-callback-state="idle"]', { timeout: 30_000 });
        },
      );

      await check(
        `${label}: no policy refusals, no script errors, no request beyond these origins`,
        () => {
          assert.deepEqual(problems, []);
          assert.deepEqual([...foreign], []);
        },
      );
    } finally {
      await context.close();
    }
  }
} catch (error) {
  console.log(
    `  FAIL setup\n       ${String(error.stack ?? error)
      .split("\n")
      .slice(0, 8)
      .join("\n       ")}`,
  );
  results.push({ name: "setup", ok: false });
} finally {
  await browser?.close();
  for (const server of servers) server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks pass`);
process.exit(failed === 0 ? 0 : 1);
