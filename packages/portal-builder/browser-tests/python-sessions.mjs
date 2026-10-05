// Per-session setups, telemetry and manual sleep in the portal's window, with a REAL interpreter.
//
// Two builds of one fixture with `sessionChoices`: on the portal's own origin (the window's own
// chooser, slots and sleep, with `maxLiveSessions: 1` so a second live session needs the first to
// sleep), and with the generated playground deployed on a second origin (the chooser in the child,
// the `setup` capability message across the bridge). Real HTTPS origins and the pinned runtime,
// as in `python-real-interpreter.mjs`, whose reasons for both apply here unchanged.
//
// Usage:  node browser-tests/python-sessions.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "..", "..");
const RUNTIME =
  process.env.FREVA_PYODIDE_RUNTIME ?? join(REPO, "packages", "browser-python", ".runtime");
const STRICT = process.env.BROWSER_STRICT === "1";
const RUN = mkdtempSync(join(tmpdir(), `py-sessions-${Date.now()}-`));
const HOSTS = {
  nbParent: "portal-nb.example.org",
  nbChild: "play-nb.example.org",
  local: "portal-local.example.org",
  parent: "portal.example.org",
  child: "play.example.org",
  runtime: "runtime.example.org",
};
const STARTUP_MS = 300_000;

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
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
};
const TLS = certificate();
const servers = [];
async function serve(host, state) {
  const server = createServer(TLS, (request, response) => {
    const url = new URL(request.url ?? "/", "https://x");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = join(state.dir, ...rel.split("/").filter((p) => p && p !== "." && p !== ".."));
    if (!existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("404\n");
      return;
    }
    const scoped = Object.entries(state.pathHeaders ?? {}).find(([prefix]) =>
      url.pathname.startsWith(prefix),
    );
    response.writeHead(200, {
      ...(scoped ? scoped[1] : state.headers),
      "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
    });
    response.end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const entry = { server, state, origin: `https://${host}:${port}` };
  entry.base = `${entry.origin}/`;
  servers.push(entry);
  return entry;
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Mark</title><rect width="16" height="16" fill="#123456"/></svg>`;
function buildSite(
  name,
  { canonical, playgroundOrigin, runtimeIndexUrl, notebook = false, blocks = "" },
) {
  const src = join(RUN, `${name}-src`);
  const put = (rel, body) => {
    const target = join(src, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put("content/index.md", "# Sessions\n\n```python try-in-python\nprint('done')\n```\n");
  put(
    "landings/home.yaml",
    `schemaVersion: 1\ntitle: Sessions\nblocks:\n  - type: hero\n    heading: Docs\n${blocks}`,
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: py-sessions-${name}
  title: Sessions
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
landings:
  home:
    path: /
    source: ./landings/home.yaml
pythonPlayground:
  enabled: true
  profile: minimal
  autostart: never
  maxSessions: 2
  initialSource: |
    STARTED = "yes"
${playgroundOrigin ? `  playgroundOrigin: ${playgroundOrigin}\n` : ""}  runtimeIndexUrl: ${runtimeIndexUrl}
  sessionChoices:
    profiles:
      minimal: {}
      xarray-zarr: {}
    starterProfiles: [minimal]
  resources:
    maxLiveSessions: 1
${notebook ? "  notebook:\n    enabled: true\n" : ""}  terminal:
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
  if (notebook) {
    const started = Date.now();
    execFileSync(process.execPath, [cli, "prepare-notebook", ...config, "--out", notebookDir], {
      stdio: "inherit",
      env,
    });
    timings.prepareNotebookMs = Date.now() - started;
  }
  execFileSync(
    process.execPath,
    [
      cli,
      "build",
      ...config,
      "--out",
      out,
      "--quiet",
      ...(notebook ? ["--notebook", notebookDir] : []),
    ],
    { stdio: "inherit", env },
  );
  return out;
}

function portalPolicy(built) {
  const policy = JSON.parse(readFileSync(join(built, "host-policy.json"), "utf8"));
  const directives = policy.csp?.portal ?? policy.csp?.default ?? {};
  return Object.entries(directives)
    .map(([n, v]) => `${n} ${Array.isArray(v) ? v.join(" ") : v}`)
    .join("; ");
}

const results = [];
/** Measured, and printed at the end. */
const timings = {};
/** Bytes a cold notebook tab downloaded, by origin. */
const coldBytes = {};
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

let browser;
try {
  for (const dir of ["local", "parent", "child", "nb-parent", "nb-child"]) {
    mkdirSync(join(RUN, dir), { recursive: true });
  }
  const runtimeS = await serve(HOSTS.runtime, {
    dir: RUNTIME,
    headers: { "access-control-allow-origin": "*" },
  });
  const localS = await serve(HOSTS.local, { dir: join(RUN, "local"), headers: {} });
  const parentS = await serve(HOSTS.parent, { dir: join(RUN, "parent"), headers: {} });
  const childS = await serve(HOSTS.child, { dir: join(RUN, "child"), headers: {} });
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
  parentS.state.headers = { "content-security-policy": portalPolicy(framedBuilt) };
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
  childS.state.headers = deployment.headers;

  // A third pair of origins for the notebook: a framed portal whose playground origin also
  // serves the notebook under /notebook/, with that path's own headers.
  const nbParentS = await serve(HOSTS.nbParent, { dir: join(RUN, "nb-parent"), headers: {} });
  const nbChildS = await serve(HOSTS.nbChild, { dir: join(RUN, "nb-child"), headers: {} });
  const nbBuilt = buildSite("notebook", {
    canonical: nbParentS.base,
    playgroundOrigin: nbChildS.origin,
    runtimeIndexUrl: runtimeS.base,
    notebook: true,
    // The notebook framed in the landing (the Notebook interface: this portal has no Lab).
    blocks: "  - type: notebook\n    heading: Your notebooks\n    view: files\n",
  });
  cpSync(nbBuilt, join(RUN, "nb-parent"), { recursive: true });
  nbParentS.state.headers = { "content-security-policy": portalPolicy(nbBuilt) };
  const nbDeployment = JSON.parse(
    readFileSync(join(nbBuilt, "playground-origin", "deploy.json"), "utf8"),
  );
  for (const file of nbDeployment.files) {
    const rel =
      file === nbDeployment.entry
        ? "index.html"
        : file.startsWith("playground-origin/notebook/")
          ? file.slice("playground-origin/".length)
          : file;
    const to = join(RUN, "nb-child", ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(nbBuilt, ...file.split("/")), to);
  }
  nbChildS.state.headers = nbDeployment.headers;
  nbChildS.state.pathHeaders = nbDeployment.pathHeaders;
  writeFileSync(
    join(RUN, "child", "csp-recorder.js"),
    "window.__childCsp = [];\ndocument.addEventListener('securitypolicyviolation', (e) => window.__childCsp.push(e.effectiveDirective));\n",
  );
  const childIndex = join(RUN, "child", "index.html");
  writeFileSync(
    childIndex,
    readFileSync(childIndex, "utf8").replace(
      "<body>",
      '<body><script type="module" src="/csp-recorder.js"></script>',
    ),
  );

  browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--ignore-certificate-errors",
      "--no-proxy-server",
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

  async function withPage(base, fn) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const problems = [];
    const violations = [];
    const foreign = [];
    const allowed = new Set([
      localS.origin,
      parentS.origin,
      childS.origin,
      runtimeS.origin,
      nbParentS.origin,
      nbChildS.origin,
    ]);
    page.on("request", (r) => {
      const url = r.url();
      if (/^(data|blob):/.test(url)) return;
      if (!allowed.has(new URL(url).origin)) foreign.push(url);
    });
    page.on("console", (m) => {
      const text = m.text();
      if (text.startsWith("CSPVIOLATION")) violations.push(text.slice(13));
      else if (m.type() === "error" && !/Failed to load resource.*404/.test(text))
        problems.push(text.slice(0, 200));
    });
    page.on("pageerror", (e) => problems.push(String(e.stack ?? e).slice(0, 600)));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) =>
        console.log(`CSPVIOLATION ${e.effectiveDirective}`),
      );
      window.__msgs = [];
      window.addEventListener("message", (e) => {
        if (e.data?.channel === "freva-python-embed") window.__msgs.push(e.data.kind);
      });
      // The window's own confirmations, accepted the way a visitor would.
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const panel = node.matches?.(".term-confirm")
              ? node
              : node.querySelector?.(".term-confirm");
            panel?.querySelectorAll(".term-confirm-btn")[1]?.click();
          }
        }
      });
      const start = () => observer.observe(document.body, { childList: true, subtree: true });
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start);
    });
    context.on("page", (popup) => {
      popup.on("request", (r) => {
        const url = r.url();
        if (!/^(data|blob):/.test(url) && !allowed.has(new URL(url).origin)) foreign.push(url);
      });
      popup.on("console", (m) => {
        if (m.text().startsWith("CSPVIOLATION")) violations.push(`popup ${m.text().slice(13)}`);
      });
      // What a cold notebook downloads, by origin: the context is new, so nothing is cached.
      popup.on("requestfinished", (r) => {
        void r
          .sizes()
          .then((sizes) => {
            const key = new URL(r.url()).origin === runtimeS.origin ? "runtime" : "notebook";
            coldBytes[key] = (coldBytes[key] ?? 0) + sizes.responseBodySize;
          })
          .catch(() => undefined);
      });
    });
    try {
      await page.goto(`${base}docs/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector(".portal-code-figure", { timeout: 30_000 });
      await fn(page, { problems, violations, foreign, context });
    } finally {
      await context.close();
    }
  }

  async function tryExample(page) {
    await page.click(".portal-code-figure .portal-code-run");
  }
  const status = (page) =>
    page.evaluate(() => document.querySelector(".portal-python-status-text")?.textContent ?? "");
  async function menu(page, label) {
    await page.click(".freva-term .term-kebab");
    await page.waitForSelector(".term-menu.show", { timeout: 5_000 });
    const item = page.locator(".tmn-sections .tmn-item", { hasText: label }).first();
    if (await item.isDisabled()) {
      await page.keyboard.press("Escape");
      return false;
    }
    await item.click();
    return true;
  }
  /** The active session's console, by the tab panel that is showing. */
  const run = (page, code) =>
    page.evaluate(async (source) => {
      const el = [...document.querySelectorAll(".portal-python-session")]
        .find((s) => !s.hidden)
        ?.querySelector("freva-python-console");
      await el.execute(source);
      return el.transcript();
    }, code);

  await check(
    "local: the window measures the session, chooses setups, holds one live slot, and sleeps",
    () =>
      withPage(localS.base, async (page, { problems, violations, foreign }) => {
        await tryExample(page);
        await page.waitForSelector(".freva-term.show", { timeout: 30_000 });
        await page.waitForFunction(
          () => document.querySelector("freva-python-console")?.transcript().includes("done"),
          null,
          { timeout: STARTUP_MS, polling: 1000 },
        );
        await page.waitForFunction(
          () =>
            /WASM [0-9.]+ MiB/.test(
              document.querySelector(".portal-python-status-text")?.textContent ?? "",
            ),
          null,
          { timeout: 20_000 },
        );
        const measured = await status(page);
        assert.match(measured, /minimal · WASM .* · 1\/1 live/, measured);

        let transcript = await run(
          page,
          "x = 41\nopen('/workspace/kept.txt', 'w').write('kept')\nprint(STARTED)",
        );
        assert.match(transcript, /yes/, "the starter did not run in the default setup");

        // The chooser: same-as-current names the setup; a custom one is reviewed; Start says why it
        // cannot, because the one live slot is taken - and two presses still make no session.
        assert.ok(await menu(page, "New session"));
        await page.waitForSelector(".portal-python-chooser", { timeout: 10_000 });
        const same = await page.locator(".portal-python-chooser-option").first().textContent();
        assert.match(same ?? "", /Same as current.*minimal · starter · console/s, same ?? "");
        await page.locator(".portal-python-chooser-option", { hasText: "Custom setup" }).click();
        await page.locator('.portal-python-chooser input[value="xarray-zarr"]').check();
        await page.locator(".portal-python-chooser button", { hasText: "Review" }).click();
        const review = await page.locator(".portal-python-chooser dl").textContent();
        assert.match(review ?? "", /Profilexarray-zarr/, review ?? "");
        const start = page.locator(".portal-python-chooser button", { hasText: "Start session" });
        await start.evaluate((button) => {
          button.click();
          button.click();
        });
        await page.waitForSelector('.portal-python-chooser [role="alert"]:not([hidden])', {
          timeout: 10_000,
        });
        const refusal = await page.locator('.portal-python-chooser [role="alert"]').textContent();
        assert.match(refusal ?? "", /Every live Python slot/, refusal ?? "");
        assert.equal(
          await page.locator(".portal-python-tab").count(),
          1,
          "a session was created without a slot",
        );
        await page.locator(".portal-python-sheet-close").click();

        // Sleep keeps the transcript and the file, and frees the slot.
        assert.ok(await menu(page, "Sleep session"));
        await page.waitForFunction(
          () =>
            /asleep · 1 file kept/.test(
              document.querySelector(".portal-python-status-text")?.textContent ?? "",
            ),
          null,
          { timeout: 60_000 },
        );
        const kept = await page.evaluate(() =>
          document.querySelector("freva-python-console").transcript(),
        );
        assert.match(kept, /yes/, "the transcript was lost");

        // Now the second setup starts.
        assert.ok(await menu(page, "New session"));
        await page.locator(".portal-python-chooser-option", { hasText: "Custom setup" }).click();
        await page.locator('.portal-python-chooser input[value="xarray-zarr"]').check();
        await page.locator(".portal-python-chooser button", { hasText: "Review" }).click();
        await page.locator(".portal-python-chooser button", { hasText: "Start session" }).click();
        await page.waitForFunction(
          () => document.querySelectorAll(".portal-python-tab").length === 2,
          null,
          { timeout: 30_000 },
        );
        await page.waitForFunction(
          () =>
            /xarray-zarr, no starter · WASM/.test(
              document.querySelector(".portal-python-status-text")?.textContent ?? "",
            ),
          null,
          { timeout: STARTUP_MS, polling: 1000 },
        );
        transcript = await run(
          page,
          "import sys\nprint('xarray' in sys.modules, 'STARTED' in globals())",
        );
        assert.match(transcript, /True False/, "the second session does not have its own setup");

        // Back to the first: waking needs the slot, so the second sleeps first.
        assert.ok(await menu(page, "Sleep session"));
        await page.waitForFunction(
          () =>
            /asleep/.test(document.querySelector(".portal-python-status-text")?.textContent ?? ""),
          null,
          { timeout: 60_000 },
        );
        await page.locator(".portal-python-tab").first().click();
        assert.ok(await menu(page, "Wake session"));
        await page.waitForFunction(
          () =>
            /minimal · WASM/.test(
              document.querySelector(".portal-python-status-text")?.textContent ?? "",
            ),
          null,
          { timeout: STARTUP_MS, polling: 1000 },
        );
        transcript = await run(
          page,
          "print(open('/workspace/kept.txt').read(), 'x' in globals(), STARTED)",
        );
        assert.match(transcript, /kept False yes/, transcript.slice(-400));

        assert.deepEqual(violations, [], violations.join(", "));
        assert.deepEqual(foreign, [], foreign.join(", "));
        assert.deepEqual(problems, [], problems.join(" | "));
      }),
  );

  await check("framed: the child chooses, reports its setup, and measures itself", () =>
    withPage(parentS.base, async (page, { violations, foreign }) => {
      await tryExample(page);
      await page.waitForSelector(".portal-python-frame", { timeout: 30_000 });
      const first = await (await page.$(".portal-python-frame")).contentFrame();
      await first.waitForFunction(
        () => document.querySelector("freva-python-console")?.transcript().includes("done"),
        null,
        { timeout: STARTUP_MS, polling: 1000 },
      );
      await first.waitForFunction(
        () =>
          /minimal · WASM/.test(
            document.querySelector("#playground-session span")?.textContent ?? "",
          ),
        null,
        { timeout: 20_000 },
      );
      await page.waitForFunction(() => (window.__msgs ?? []).includes("setup"), null, {
        timeout: 20_000,
      });
      assert.match(await status(page), /minimal/);

      // A new session opens on the child's own chooser, proposed "same as current".
      assert.ok(await menu(page, "New session"));
      await page.waitForFunction(
        () => document.querySelectorAll(".portal-python-frame").length === 2,
        null,
        { timeout: 20_000 },
      );
      const second = await (await page.$$(".portal-python-frame"))[1].contentFrame();
      await second.waitForSelector(".portal-python-chooser-option", { timeout: 60_000 });
      await second.waitForFunction(
        () =>
          /Same as current/.test(
            document.querySelector(".portal-python-chooser-option")?.textContent ?? "",
          ),
        null,
        { timeout: 20_000 },
      );
      await second.locator(".portal-python-chooser-option").first().click();
      await second.locator(".portal-python-chooser button", { hasText: "Start session" }).click();
      // One live slot, held by the first frame, which is idle: it is put to sleep (its files
      // kept) and the second starts - what counts is what runs, not what is open.
      await first.waitForFunction(
        () => /asleep/.test(document.querySelector("#playground-session span")?.textContent ?? ""),
        null,
        { timeout: 60_000 },
      );
      await page.locator(".portal-python-tab").nth(1).click();
      await second.waitForFunction(
        () =>
          /minimal · WASM/.test(
            document.querySelector("#playground-session span")?.textContent ?? "",
          ),
        null,
        { timeout: STARTUP_MS, polling: 1000 },
      );

      const childViolations = [
        ...(await first.evaluate(() => window.__childCsp ?? [])),
        ...(await second.evaluate(() => window.__childCsp ?? [])),
      ];
      assert.deepEqual(childViolations, [], childViolations.join(", "));
      assert.deepEqual(violations, [], violations.join(", "));
      assert.deepEqual(foreign, [], foreign.join(", "));
    }),
  );
  await check(
    "notebook: 'Open as notebook' opens the example in a kernel of this portal's setups",
    () =>
      withPage(nbParentS.base, async (page, { violations, foreign, context }) => {
        assert.ok(
          nbDeployment.pathHeaders?.["/notebook/"]?.["Content-Security-Policy"],
          "deploy.json carries no notebook policy",
        );
        await tryExample(page);
        await page.waitForSelector(".portal-python-frame", { timeout: 30_000 });
        const frame = await (await page.$(".portal-python-frame")).contentFrame();
        await frame.waitForFunction(
          () => document.querySelector("freva-python-console")?.transcript().includes("done"),
          null,
          { timeout: STARTUP_MS, polling: 1000 },
        );
        const popupPromise = context.waitForEvent("page", { timeout: 30_000 });
        assert.ok(await menu(page, "Open as notebook"));
        const notebook = await popupPromise;
        await notebook.addInitScript(() => {
          document.addEventListener("securitypolicyviolation", (e) =>
            console.log(`CSPVIOLATION ${e.effectiveDirective}`),
          );
        });
        await notebook.waitForLoadState("domcontentloaded");
        assert.match(
          notebook.url(),
          /\/notebook\/notebooks\/index\.html\?path=examples%2Fexample-[0-9a-f]{12}\.ipynb/,
        );
        const started = Date.now();
        await notebook.waitForSelector(".jp-Notebook .jp-Cell", { timeout: 120_000 });
        await notebook.locator(".jp-Notebook .jp-CodeCell").first().click();
        await notebook.keyboard.press("Shift+Enter");
        await notebook.waitForFunction(
          () =>
            [...document.querySelectorAll(".jp-OutputArea-output")].some((o) =>
              /done/.test(o.textContent ?? ""),
            ),
          null,
          { timeout: STARTUP_MS, polling: 1000 },
        );
        timings.notebookFirstCellMs = Date.now() - started;
        timings.notebookColdBytes = { ...coldBytes };
        const kernel = await notebook.evaluate(
          () =>
            document.querySelector(".jp-Notebook-KernelStatus, .jp-KernelName")?.textContent ?? "",
        );
        timings.notebookKernelLabel = kernel;
        assert.deepEqual(violations, [], violations.join(", "));
        assert.deepEqual(foreign, [], foreign.join(", "));
      }),
  );
  await check("notebook: a landing frames it, maximized in place, and opens in a new tab", () =>
    withPage(nbParentS.base, async (page, { problems, violations, foreign }) => {
      await page.goto(nbParentS.base, { waitUntil: "domcontentloaded" });
      const block = page.locator("[data-portal-notebook]");
      const src = `${nbChildS.origin}/notebook/tree/index.html`;
      assert.equal(await block.locator("iframe").getAttribute("src"), src);
      assert.equal(await block.locator("[data-portal-notebook-open]").getAttribute("href"), src);
      assert.equal(
        await block.locator("[data-portal-notebook-open]").getAttribute("target"),
        "_blank",
      );
      const sandbox = (await block.locator("iframe").getAttribute("sandbox")) ?? "";
      assert.ok(!sandbox.includes("allow-top-navigation"), sandbox);
      // Loaded under both policies: the portal's frame-src and the notebook's frame-ancestors.
      await block.scrollIntoViewIfNeeded();
      const frame = await (await block.locator("iframe").elementHandle()).contentFrame();
      await frame.waitForSelector(".jp-DirListing", { timeout: 120_000 });
      // The frame's document must be the one it loaded first, through every state below.
      await frame.evaluate(() => (window.__mark = "loaded once"));
      const button = block.locator("[data-portal-notebook-expand]");
      await button.waitFor({ state: "visible", timeout: 10_000 });
      // The page settles first: the frame's own start-up may focus something of its own.
      await page.waitForTimeout(2000);
      const before = await page.evaluate(() => [history.length, scrollY]);
      await button.click();
      const open = await page.evaluate(() => {
        const win = document.querySelector("[data-portal-notebook-window]");
        const box = win.getBoundingClientRect();
        const header = document.querySelector(".portal-header")?.getBoundingClientRect();
        return {
          expanded: document.querySelector("[data-portal-notebook]").dataset.expanded,
          position: getComputedStyle(win).position,
          belowHeader: !header || box.top >= header.bottom,
          wide: box.width > innerWidth * 0.8,
          backdrop: !document.querySelector("[data-portal-notebook-backdrop]").hidden,
          locked: getComputedStyle(document.body).overflow === "hidden",
          label: document.querySelector("[data-portal-notebook-expand]").getAttribute("aria-label"),
        };
      });
      assert.deepEqual(open, {
        expanded: "true",
        position: "fixed",
        belowHeader: true,
        wide: true,
        backdrop: true,
        locked: true,
        label: "Exit full screen",
      });
      // Each way out also takes back the history entry the button added (as a visitor would wait).
      const entryGone = () =>
        page.waitForFunction(() => !history.state?.portalNotebookExpanded, null, {
          timeout: 10_000,
        });
      await page.keyboard.press("Escape");
      assert.equal(await block.getAttribute("data-expanded"), null, "Escape restores it");
      await entryGone();
      // Pressed in the page: a driver's click would first scroll the control clear of the header.
      const press = () => button.evaluate((el) => el.click());
      await press();
      await page.goBack();
      await page.waitForFunction(
        () => !document.querySelector("[data-portal-notebook]").dataset.expanded,
      );
      await press();
      await page.mouse.click(5, 450);
      assert.equal(await block.getAttribute("data-expanded"), null, "a click outside restores it");
      await entryGone();
      const after = await page.evaluate(() => [history.length, scrollY]);
      assert.equal(after[1], before[1], `the page moved: ${before[1]} -> ${after[1]}`);
      assert.equal(await frame.evaluate(() => window.__mark), "loaded once", "the frame reloaded");
      assert.deepEqual(problems, [], problems.join("\n"));
      assert.deepEqual(violations, [], violations.join(", "));
      assert.deepEqual(foreign, [], foreign.join(", "));
    }),
  );
} finally {
  await browser?.close().catch(() => undefined);
  for (const { server } of servers) server.close();
}

console.log(`timings: ${JSON.stringify(timings)}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks pass`);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
