// The Python playground with a REAL interpreter, on REAL origins.
//
// `python-playground.mjs` stubs the console deliberately: it tests the coordinator - windows,
// tabs, autostart ordering, layering - and a stub is the only way to test that rather than
// Pyodide. But a stub can agree with a coordinator that is wrong about what a console does, so
// this suite starts a real interpreter and runs a registered example end to end twice: once on
// the portal's own origin, and once with the GENERATED separate-origin artifact deployed at a
// second origin exactly as its own `deploy.json` says to deploy it.
//
// The three HTTPS origins have to be real. `site.canonicalUrl` is https-only, so the generated
// child's `frame-ancestors` names an https origin; a parent served at `http://127.0.0.1:<port>`
// is not that origin, the browser refuses to frame the child, and every framed check then fails
// at its timeout with no explanation. So: one self-signed certificate for three names,
// `--host-resolver-rules` pointing them at loopback, artifacts BUILT for those exact origins, and
// the agreement asserted before a browser is launched. `--no-proxy-server` too, because this
// environment exports `https_proxy` and the proxy's reset on those names arrives as
// `ERR_CONNECTION_RESET`, which looks exactly like a broken TLS server.
//
// The runtime is local and SERVED rather than intercepted: Pyodide is the pinned distribution in
// `packages/browser-python/.runtime` - the same bytes that package's own suites run - published
// over TLS and named by `dataset-tree.python.runtimeIndexUrl`, the option a deployment that
// mirrors the runtime uses. Interception does not work, because the interpreter loads inside a
// WORKER and a page-level route does not see a worker's own fetches. A checkout without that
// directory SKIPS rather than pretending. The fixture is shaped like a consumer, but it is not
// any deployment's configuration and nothing in it is acceptance for one.
//
// Usage:  node browser-tests/python-real-interpreter.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "..", "..");
const RUNTIME =
  process.env.FREVA_PYODIDE_RUNTIME ?? join(REPO, "packages", "browser-python", ".runtime");
const STRICT = process.env.BROWSER_STRICT === "1";
/** A fresh directory per run, so no check can ever read a previous run's artifact. */
const RUN = mkdtempSync(join(tmpdir(), `py-real-${Date.now()}-`));

/** Three names on one certificate. Only their PORTS are decided at run time. */
const HOSTS = {
  parent: "portal.example.org",
  local: "portal-local.example.org",
  child: "play.example.org",
  runtime: "runtime.example.org",
};

function skip(message) {
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

if (!existsSync(join(RUNTIME, "pyodide.js"))) {
  skip(
    `no local Pyodide runtime at ${RUNTIME}. Prepare it with ` +
      "`node bin/freva-browser-python.mjs prepare-runtime --out .runtime` in packages/browser-python.",
  );
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  skip(`playwright is not installed: ${error.message}`);
}

// servers

/** One self-signed certificate covering every name this suite serves. */
function certificate() {
  const dir = join(RUN, "tls");
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "openssl.cnf");
  const names = Object.values(HOSTS)
    .map((h) => `DNS:${h}`)
    .join(",");
  writeFileSync(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${HOSTS.parent}\n` +
      `[v3]\nsubjectAltName=${names},IP:127.0.0.1\n`,
  );
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-config",
        config,
      ],
      { stdio: "ignore" },
    );
  } catch (error) {
    skip(`openssl could not make a certificate: ${error.message}`);
  }
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
}

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
  ".map": "application/json",
  ".ts": "text/plain; charset=utf-8",
};

const TLS = certificate();
const servers = [];

/**
 * A static server whose directory and headers may be filled in AFTER it is listening. That is the
 * whole reason it exists: an origin has to be allocated before the build, because the build
 * compiles the origin into the parent's iframe `src`, its `frame-src` and the child's
 * `frame-ancestors`. Reading the state on each request is what lets the port come first.
 */
async function serve(host, state) {
  const server = createServer(TLS, (request, response) => {
    const url = new URL(request.url ?? "/", "https://x");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const parts = rel.split("/").filter((p) => p && p !== "." && p !== "..");
    const file = join(state.dir, ...parts);
    if (!existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("404\n");
      return;
    }
    response.writeHead(200, {
      ...state.headers,
      "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
    });
    response.end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const entry = { server, state, host, port, origin: `https://${host}:${port}` };
  entry.base = `${entry.origin}/`;
  servers.push(entry);
  return entry;
}

// fixture

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Mark</title><rect width="16" height="16" fill="#123456"/></svg>`;

/**
 * A WHOLE BLOCK with blank lines in it, which is the case a REPL gets wrong. Typed line by line
 * into a Python prompt the blank line ends the `for` suite, and `total` is either 0 or a
 * NameError. `runExample` uses file semantics precisely so that a snippet a reader can copy is a
 * snippet the button can run; `sum 6` is what tells the two apart.
 */
const BLOCK = [
  "total = 0",
  "",
  "for i in range(4):",
  "    total += i",
  "",
  "print('sum', total)",
  "print('done')",
  "",
].join("\n");

const CATALOG = {
  schemaVersion: 1,
  generatedAt: "2026-01-06T10:00:00Z",
  source: "https://data.example.org",
  roots: [
    {
      id: "cmip6",
      kind: "collection",
      name: "cmip6",
      title: "CMIP6",
      children: [
        {
          id: "cmip6/tas",
          kind: "dataset",
          name: "tas.zarr",
          path: "https://data.example.org/tas.zarr",
          size: 4096,
          availability: "available",
          examples: [
            {
              id: "block",
              label: "Whole block",
              language: "python",
              description: "A block with blank lines in it.",
              code: BLOCK,
              executable: true,
            },
          ],
        },
      ],
    },
  ],
};

function buildSite(name, { canonical, playgroundOrigin, runtimeIndexUrl }) {
  const src = join(RUN, `${name}-src`);
  const put = (rel, body) => {
    const target = join(src, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put("data/archive.json", JSON.stringify(CATALOG, null, 2));
  put(
    "landings/home.yaml",
    `schemaVersion: 1
title: Real interpreter
blocks:
  - type: dataset-tree
    catalog: ../data/archive.json
    expand:
      - cmip6
    python:
      enabled: true
      profile: minimal
      autostart: never
      maxSessions: 2
${playgroundOrigin ? `      playgroundOrigin: ${playgroundOrigin}\n` : ""}      runtimeIndexUrl: ${runtimeIndexUrl}
      terminal:
        style: freva-client-terminal
        osControls: linux
        alwaysOnTop: true
        rememberAppearance: false
`,
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: py-real-${name}
  title: Real interpreter
  language: en
  canonicalUrl: ${canonical}
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: default
landings:
  home:
    path: /
    source: ./landings/home.yaml
`,
  );
  const out = join(RUN, `${name}-built`);
  execFileSync(
    process.execPath,
    [
      join(PKG, "bin", "freva-portal-builder.mjs"),
      "build",
      "--source-root",
      src,
      "--config",
      join(src, "portal.yaml"),
      "--out",
      out,
      "--quiet",
    ],
    { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
  );
  return out;
}

/** The portal's own recorded policy, as one header value. */
function portalPolicy(built) {
  const policy = JSON.parse(readFileSync(join(built, "host-policy.json"), "utf8"));
  const directives = policy.csp?.portal ?? policy.csp?.default ?? {};
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${Array.isArray(value) ? value.join(" ") : value}`)
    .join("; ");
}

const results = [];
/** `FREVA_ONLY=<substring>` runs one check, which is how a failing one is looked at on its own. */
const ONLY = process.env.FREVA_ONLY;
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    const detail = String(error.message).split("\n").slice(0, 5).join("\n       ");
    console.log(`  FAIL ${name}\n       ${detail}`);
  }
}

let browser;
try {
  // 1. every origin allocated before anything is built
  mkdirSync(join(RUN, "child"), { recursive: true });
  mkdirSync(join(RUN, "parent"), { recursive: true });
  mkdirSync(join(RUN, "local"), { recursive: true });
  const runtimeS = await serve(HOSTS.runtime, {
    dir: RUNTIME,
    headers: { "access-control-allow-origin": "*" },
  });
  const childS = await serve(HOSTS.child, { dir: join(RUN, "child"), headers: {} });
  const parentS = await serve(HOSTS.parent, { dir: join(RUN, "parent"), headers: {} });
  const localS = await serve(HOSTS.local, { dir: join(RUN, "local"), headers: {} });

  // 3. artifacts built FOR those exact origins
  const localBuilt = buildSite("local", {
    canonical: localS.base,
    playgroundOrigin: null,
    runtimeIndexUrl: runtimeS.base,
  });
  const framedBuilt = buildSite("framed", {
    canonical: parentS.base,
    playgroundOrigin: childS.origin,
    runtimeIndexUrl: runtimeS.base,
  });
  cpSync(localBuilt, join(RUN, "local"), { recursive: true });
  cpSync(framedBuilt, join(RUN, "parent"), { recursive: true });
  localS.state.headers = { "content-security-policy": portalPolicy(localBuilt) };
  const parentCsp = portalPolicy(framedBuilt);
  parentS.state.headers = { "content-security-policy": parentCsp };

  // Deployed from the artifact's OWN list, file by file, with the entry document at the origin's
  // root. Nothing else of the portal is copied: that is the property the list exists to make
  // checkable, and copying the whole artifact would test nothing.
  const deployment = JSON.parse(
    readFileSync(join(framedBuilt, "playground-origin", "deploy.json"), "utf8"),
  );
  for (const file of deployment.files) {
    const to =
      file === deployment.entry
        ? join(RUN, "child", "index.html")
        : join(RUN, "child", ...file.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(framedBuilt, ...file.split("/")), to);
  }
  const childCsp = deployment.headers["Content-Security-Policy"];
  childS.state.headers = deployment.headers;

  // The child records its OWN refusals. A `securitypolicyviolation` fires in the document whose
  // policy refused, so a parent listening for them sees none of the frame's. Served from the
  // child's own origin as a module, so `script-src 'self'` still governs it and the instrument
  // does not weaken what it is measuring.
  writeFileSync(
    join(RUN, "child", "csp-recorder.js"),
    "window.__childCsp = [];\n" +
      "document.addEventListener('securitypolicyviolation', (e) => " +
      "window.__childCsp.push(e.effectiveDirective));\n",
  );
  const childIndex = join(RUN, "child", "index.html");
  writeFileSync(
    childIndex,
    readFileSync(childIndex, "utf8").replace(
      "<body>",
      '<body><script type="module" src="/csp-recorder.js"></script>',
    ),
  );

  console.log(
    `origins: parent ${parentS.origin} | child ${childS.origin} | runtime ${runtimeS.origin}`,
  );
  console.log(`run dir: ${RUN}`);

  browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--ignore-certificate-errors",
      // This environment exports `https_proxy`; without this Chromium CONNECTs through it and the
      // proxy resets, which arrives as ERR_CONNECTION_RESET and looks like a broken TLS server.
      "--no-proxy-server",
      `--host-resolver-rules=${Object.values(HOSTS)
        .map((h) => `MAP ${h} 127.0.0.1`)
        .join(",")}`,
    ],
    executablePath: process.env.FREVA_PORTAL_CHROMIUM ?? "/opt/pw-browsers/chromium",
  });

  /** One page with every diagnostic attached before it navigates. */
  async function withPage(base, fn) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const problems = [];
    const violations = [];
    page.on("console", (m) => {
      const text = m.text();
      if (text.startsWith("CSPVIOLATION")) violations.push(text.slice("CSPVIOLATION ".length));
      else if (m.type() === "error") problems.push(text.slice(0, 200));
    });
    page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
    page.on("requestfailed", (r) =>
      problems.push(`[reqfail] ${r.url().slice(0, 110)} ${r.failure()?.errorText}`),
    );
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) =>
        console.log(`CSPVIOLATION ${e.effectiveDirective}`),
      );
      window.__msgs = [];
      window.addEventListener("message", (e) => {
        const d = e.data;
        if (d && d.channel === "freva-python-embed") window.__msgs.push(d.kind);
      });
    });
    try {
      await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector(".dataset-tree", { timeout: 30_000 });
      await fn(page, { problems, violations });
    } finally {
      await context.close();
    }
  }

  /** Open the dataset, disclose its access panel, and return the Try control's selector. */
  async function openExample(page) {
    await page.waitForSelector('[data-dataset-tree-id="cmip6/tas"]', { timeout: 20_000 });
    await page.click('[data-dt-key="activate:cmip6/tas"]');
    await page.waitForSelector(".dataset-tree__details", { timeout: 20_000 });
    await page.click('[data-dt-key="disclose:cmip6/tas"]');
    await page.waitForSelector(".dataset-tree__codecard", { timeout: 20_000 });
    return '[data-dt-key="try:cmip6/tas"]';
  }

  /** The console in whatever document this is, once it has printed `done`. */
  const RAN = () => {
    const el = document.querySelector("freva-python-console");
    return Boolean(el && typeof el.transcript === "function" && el.transcript().includes("done"));
  };
  const TRANSCRIPT = () => document.querySelector("freva-python-console").transcript();
  /** Starting a real interpreter from a cold cache is minutes, not seconds. */
  const STARTUP_MS = 300_000;

  // 4. everything agrees, asserted before a browser is asked to prove anything
  await check("the artifacts, the deployment description and the live origins all agree", () => {
    assert.equal(deployment.origin, childS.origin, "deploy.json names a different child origin");
    assert.equal(deployment.hostOrigin, parentS.origin, "deploy.json names a different portal");
    assert.ok(
      childCsp.includes(`frame-ancestors ${parentS.origin}`),
      `frame-ancestors does not name the live parent: ${childCsp}`,
    );
    assert.ok(parentCsp.includes(`frame-src ${childS.origin}`), `frame-src: ${parentCsp}`);
    assert.ok(
      readFileSync(join(RUN, "parent", "index.html"), "utf8").includes(childS.origin),
      "the parent page does not carry the live child origin",
    );
    assert.ok(childCsp.includes(runtimeS.origin), "the child policy does not name the runtime");
    for (const file of deployment.files) {
      const at =
        file === deployment.entry
          ? join(RUN, "child", "index.html")
          : join(RUN, "child", ...file.split("/"));
      assert.ok(existsSync(at), `${file} was listed and not deployed`);
    }
  });

  // 5. preflight, through the browser's own resolver and certificate exception
  await check("every origin answers before a single test runs", async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      for (const url of [
        parentS.base,
        localS.base,
        childS.base,
        `${runtimeS.base}pyodide.mjs`,
        `${runtimeS.base}pyodide-lock.json`,
      ]) {
        const response = await page.goto(url, { waitUntil: "commit", timeout: 20_000 });
        assert.equal(response?.status(), 200, `${url} -> ${response?.status()}`);
      }
      // A wheel is FETCHED rather than navigated to: navigating to one is a download, which is not
      // a response. From the runtime origin itself, so no cross-origin policy is in the way.
      const wheel = readdirSync(RUNTIME).find((f) => f.endsWith(".whl"));
      assert.ok(wheel, "the prepared runtime carries no wheel");
      const status = await page.evaluate(
        (url) => fetch(url).then((r) => r.status),
        `${runtimeS.base}${wheel}`,
      );
      assert.equal(status, 200, `${wheel} -> ${status}`);
    } finally {
      await context.close();
    }
  });

  // same origin

  await check("a real interpreter runs a registered example, whole block and all", () =>
    withPage(localS.base, async (page, { problems, violations }) => {
      const tryIt = await openExample(page);
      await page.click(tryIt);
      await page.waitForSelector(".freva-term.show", { timeout: 30_000 });
      await page.waitForFunction(RAN, null, { timeout: STARTUP_MS, polling: 1000 });
      const transcript = await page.evaluate(TRANSCRIPT);
      // `sum 6` is the whole point. Typed line by line into a REPL the blank line after the
      // `for` suite ends it and `total` is 0 or a NameError; run as a FILE it is 0+1+2+3.
      assert.ok(transcript.includes("sum 6"), `the block did not run as a file:\n${transcript}`);
      assert.ok(transcript.includes("done"), "the lines after the blank line did not run");
      assert.deepEqual(violations, [], `the portal's own policy refused: ${violations.join(", ")}`);
      assert.deepEqual(problems, [], problems.join(" | "));
    }),
  );

  // two origins

  await check("the deployed child artifact carries the manifest, and only the child", async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await page.goto(childS.base, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector("freva-python-console", { timeout: 60_000 });
      const manifest = await page.evaluate(() =>
        JSON.parse(document.getElementById("playground-examples").textContent),
      );
      assert.ok(manifest.length > 0, "the deployed manifest is empty");
      assert.ok(manifest[0].source.includes("for i in range"), "the manifest carries no source");
      assert.match(manifest[0].sha256, /^[0-9a-f]{64}$/);
    } finally {
      await context.close();
    }
  });

  await check("a press in the portal runs it in the child's real interpreter", () =>
    withPage(parentS.base, async (page, { violations }) => {
      const tryIt = await openExample(page);
      await page.click(tryIt);
      await page.waitForSelector(".portal-python-frame", { timeout: 30_000 });
      await page.waitForFunction(() => (window.__msgs ?? []).includes("ready"), null, {
        timeout: 90_000,
        polling: 250,
      });
      const frame = await (await page.$(".portal-python-frame")).contentFrame();
      await frame.waitForFunction(RAN, null, { timeout: STARTUP_MS, polling: 1000 });
      const transcript = await frame.evaluate(TRANSCRIPT);
      assert.ok(transcript.includes("sum 6"), `the block did not run as a file:\n${transcript}`);
      assert.deepEqual(violations, [], `the parent's policy refused: ${violations.join(", ")}`);
      const childViolations = await frame.evaluate(() => window.__childCsp ?? []);
      assert.deepEqual(
        childViolations,
        [],
        `the child's policy refused: ${childViolations.join(", ")}`,
      );
    }),
  );

  await check("the first press during the frame's startup is queued, not lost", () =>
    withPage(parentS.base, async (page) => {
      const tryIt = await openExample(page);
      // TWO PRESSES, the second while the first is still bringing the frame up. The handshake
      // takes a moment and `PlaygroundHost.runExample()` throws before it completes, so a first
      // press on a new frame races it.
      await page.click(tryIt);
      // The second press is DISPATCHED rather than clicked: by now the window is on screen and
      // covering the tree - it is `alwaysOnTop`, which is the point of that band - and
      // Playwright's click would wait for a control it can hit. Hit-testing is not under test;
      // whether a second run request arriving before the child's handshake completes is queued
      // behind it rather than thrown away is.
      await page.waitForTimeout(50);
      await page.locator(tryIt).dispatchEvent("click");
      await page.waitForSelector(".portal-python-frame", { timeout: 30_000 });
      const frame = await (await page.$(".portal-python-frame")).contentFrame();
      await frame.waitForFunction(RAN, null, { timeout: STARTUP_MS, polling: 1000 });
      const notice = await page.evaluate(
        () => document.querySelector(".portal-python-notice:not([hidden])")?.textContent ?? "",
      );
      assert.equal(notice, "", `the window reported a refusal: ${notice}`);
    }),
  );

  await check("the portal holds the child's transcript, and can clear it", () =>
    withPage(parentS.base, async (page) => {
      const tryIt = await openExample(page);
      await page.click(tryIt);
      await page.waitForSelector(".portal-python-frame", { timeout: 30_000 });
      const frame = await (await page.$(".portal-python-frame")).contentFrame();
      await frame.waitForFunction(RAN, null, { timeout: STARTUP_MS, polling: 1000 });

      // The parent has it WITHOUT asking - which is what lets its Copy control be synchronous.
      await page.waitForFunction(
        () => {
          const menu = document.querySelector(".freva-term .term-kebab");
          return Boolean(menu);
        },
        null,
        { timeout: 20_000 },
      );
      await page.click(".freva-term .term-kebab");
      const copyRow = page
        .locator(".term-menu, .term-settings")
        .getByText("Copy transcript", { exact: true });
      await copyRow.waitFor({ timeout: 10_000 });
      const disabled = await copyRow.evaluate(
        (el) =>
          el.closest("[aria-disabled], button, .tm-item")?.getAttribute("aria-disabled") ?? "false",
      );
      assert.notEqual(disabled, "true", "Copy transcript is disabled for a framed session");

      await page.getByText("Clear transcript", { exact: true }).click();
      await frame.waitForFunction(
        () => document.querySelector("freva-python-console").transcript() === "",
        null,
        { timeout: 60_000, polling: 250 },
      );
    }),
  );

  // the policies, ablated

  /**
   * A directive is load-bearing when removing it breaks something. Ablation is done on the SERVED
   * header rather than in the product, because the header is what the browser enforces - the only
   * way to answer "is this grant necessary" rather than "does it work with the grant".
   */
  async function ablate(headerOverride, parentOverride) {
    childS.state.headers = { ...deployment.headers, "Content-Security-Policy": headerOverride };
    parentS.state.headers = { "content-security-policy": parentOverride };
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const violations = [];
    const failures = [];
    page.on("console", (m) => {
      if (m.text().startsWith("CSPVIOLATION"))
        violations.push(m.text().slice("CSPVIOLATION ".length));
    });
    page.on("requestfailed", (r) =>
      failures.push(`${r.url().split("/").pop()} ${r.failure()?.errorText}`),
    );
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) =>
        console.log(`CSPVIOLATION ${e.effectiveDirective}`),
      );
      window.__msgs = [];
      window.addEventListener("message", (e) => {
        const d = e.data;
        if (d && d.channel === "freva-python-embed") window.__msgs.push(d.kind);
      });
    });
    try {
      await page.goto(parentS.base, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector(".dataset-tree", { timeout: 30_000 });
      const tryIt = await openExample(page);
      await page.click(tryIt);
      await page.waitForSelector(".portal-python-frame", { timeout: 30_000 });
      await page.waitForFunction(() => (window.__msgs ?? []).includes("ready"), null, {
        timeout: 90_000,
        polling: 250,
      });
      // Far enough for the console to have built its surface, which is where the style attributes
      // are set, and for the interpreter's own module import to have been attempted.
      await page.waitForTimeout(6000);
      const frame = page.frames().find((f) => f.url().startsWith(childS.origin));
      const childViolations = frame ? await frame.evaluate(() => window.__childCsp ?? []) : [];
      return {
        violations: [...new Set(violations)],
        childViolations: [...new Set(childViolations)],
        failures,
      };
    } finally {
      await context.close();
      childS.state.headers = deployment.headers;
      parentS.state.headers = { "content-security-policy": parentCsp };
    }
  }

  const strip = (csp, directive) =>
    csp
      .split("; ")
      .filter((d) => !d.startsWith(`${directive} `))
      .join("; ");

  await check("as generated, neither policy refuses anything the playground does", async () => {
    const seen = await ablate(childCsp, parentCsp);
    assert.deepEqual(seen.violations, [], `parent: ${seen.violations.join(", ")}`);
    assert.deepEqual(seen.childViolations, [], `child: ${seen.childViolations.join(", ")}`);
  });

  await check("the child's style-src-attr grant is load-bearing, not decorative", async () => {
    const seen = await ablate(strip(childCsp, "style-src-attr"), parentCsp);
    assert.ok(
      seen.childViolations.includes("style-src-attr"),
      `removing it refused nothing: ${JSON.stringify(seen)}`,
    );
  });

  await check("the parent's style-src-attr grant is load-bearing too", async () => {
    const seen = await ablate(childCsp, strip(parentCsp, "style-src-attr"));
    assert.ok(
      seen.violations.includes("style-src-attr"),
      `removing it refused nothing: ${JSON.stringify(seen)}`,
    );
  });

  await check(
    "the runtime origin has to be in the child's script-src, not only connect-src",
    async () => {
      // `pyodide.mjs` is a module the interpreter IMPORTS, not only bytes it fetches. A policy
      // naming the mirror in `connect-src` alone leaves a playground that downloads its own
      // runtime and is then refused permission to run it.
      const seen = await ablate(childCsp.replace(` ${runtimeS.origin};`, ";"), parentCsp);
      assert.ok(
        seen.failures.some((f) => f.startsWith("pyodide.mjs") && f.includes("csp")),
        `the runtime loaded without the grant: ${JSON.stringify(seen.failures.slice(0, 4))}`,
      );
    },
  );
} finally {
  if (browser) await browser.close();
  for (const entry of servers) entry.server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} real-interpreter checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
