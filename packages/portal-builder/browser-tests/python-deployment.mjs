// The deployment smoke test: a built portal, its own materials, and a real interpreter.
//
// Separate from the other suites on purpose. `runnable-content.mjs` asks whether a marked snippet
// runs; this asks whether a DEPLOYMENT works - whether the files a portal must serve are in the
// artifact it produced, whether the page fetches them from where the build said it would, and
// what happens when they are missing, refused or substituted. It starts the heaviest profile
// there is, so it is its own file with its own prerequisites rather than more checks bolted onto
// a fast suite.
//
// Both halves need covering: wheels added to the artifact after the builder finished make
// `verify` refuse the result, and a page pointing at whatever URL a script last wrote into
// `portal.yaml` is nobody's contract. Untested, both surface in a browser as a 403.
//
// Chromium only: this is functional deployment validation, not rendering or performance.
//
// Usage:  node browser-tests/python-deployment.mjs
//         FREVA_ONLY="<substring>" node browser-tests/python-deployment.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { certificate, chromiumArgs, portalPolicy, serveTls } from "./fixtures/tls-origins.mjs";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "..", "..");
const RUNTIME =
  process.env.FREVA_PYODIDE_RUNTIME ?? join(REPO, "packages", "browser-python", ".runtime");
const ADDONS = process.env.FREVA_ADDON_DIR ?? join(REPO, "packages", "browser-python", ".addons");
const STRICT = process.env.BROWSER_STRICT === "1";
const ONLY = process.env.FREVA_ONLY;
const RUN = mkdtempSync(join(tmpdir(), `pydeploy-${Date.now()}-`));

const HOSTS = {
  portal: "portal.example.org",
  runtime: "runtime.example.org",
  assets: "cdn.example.org",
};

function skip(message) {
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

if (!existsSync(join(RUNTIME, "pyodide.js"))) skip(`no local Pyodide runtime at ${RUNTIME}`);
if (!existsSync(join(ADDONS, "MANIFEST.json"))) {
  skip(`no prepared add-on directory at ${ADDONS} (prepare-addons makes one)`);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  skip(`playwright is not installed: ${error.message}`);
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>M</title><rect width="16" height="16" fill="#123"/></svg>`;
const cli = (...args) =>
  execFileSync(process.execPath, [join(PKG, "bin", "freva-portal-builder.mjs"), ...args], {
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" },
  });

/**
 * A portal with one runnable snippet, built the way a deployment builds one. `materials` decides
 * which of the two supported shapes this portal uses: prepared materials that the artifact serves
 * itself, or an explicit external URL. Both are exercised, because both are supported and they
 * fail in different places.
 */
function buildSite(name, options) {
  const src = join(RUN, `${name}-src`);
  const put = (rel, body) => {
    const target = join(src, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put(
    "content/run.md",
    `---\ntitle: Run\n---\n\n# Run\n\n\`\`\`python try-in-python\n${options.snippet}\`\`\`\n`,
  );
  put(
    "landings/home.yaml",
    "schemaVersion: 1\ntitle: Deploy\nblocks:\n  - type: hero\n    heading: Deploy\n",
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: pydeploy-${name}
  title: Deployment
  language: en
  canonicalUrl: ${options.canonical}
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
  profile: ${options.profile}
  addons:
${options.addons.map((a) => `    - ${a}\n`).join("")}${
      options.optionalAddons?.length
        ? `  optionalAddons:\n${options.optionalAddons.map((a) => `    - ${a}\n`).join("")}`
        : ""
    }  autostart: never
  maxSessions: 1
  runtimeIndexUrl: ${options.runtimeIndexUrl}
${options.addonBaseUrl ? `  addonBaseUrl: ${options.addonBaseUrl}\n` : ""}${
      options.wheelhouseUrl ? `  wheelhouseUrl: ${options.wheelhouseUrl}\n` : ""
    }  terminal:
    style: freva-client-terminal
    osControls: linux
    alwaysOnTop: true
    rememberAppearance: false
`,
  );
  const out = join(RUN, `${name}-built`);
  const args = [
    "build",
    "--source-root",
    src,
    "--config",
    join(src, "portal.yaml"),
    "--out",
    out,
    "--quiet",
  ];
  if (options.materials) args.push("--python-materials", options.materials);
  cli(...args);
  return out;
}

const results = [];
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(
      `  FAIL ${name}\n       ${String(error.message).split("\n").slice(0, 8).join("\n       ")}`,
    );
  }
}

/** Press Try, and answer what the interpreter did. */
async function runSnippet(page, base, { timeout = 900_000, until } = {}) {
  await page.goto(`${base}docs/run/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("button[data-portal-run]", { timeout: 30_000 });
  await page.click("button[data-portal-run]");
  await page.waitForSelector(".freva-term.show", { timeout: 60_000 });
  const transcript = () =>
    page.evaluate(
      () => document.querySelector("freva-python-console")?.shadowRoot?.textContent ?? "",
    );
  // Either the snippet finished, or the start failed in one of the ways this suite is about. The
  // failure patterns cannot occur in an echoed snippet - none of these fixtures contains them -
  // and the success marker is assembled at runtime for the same reason.
  const pattern =
    until ?? "__DONE__|not the artefact|is not available|HTTP \\d{3}|could not be fetched";
  await page
    .waitForFunction(
      (source) => {
        const text = document.querySelector("freva-python-console")?.shadowRoot?.textContent ?? "";
        return new RegExp(source).test(text);
      },
      pattern,
      { timeout },
    )
    .catch(() => undefined);
  return transcript();
}

let browser;
try {
  const tls = certificate(join(RUN, "tls"), Object.values(HOSTS));
  for (const dir of ["a", "b", "c", "d"]) mkdirSync(join(RUN, dir), { recursive: true });

  const runtimeS = await serveTls(tls, HOSTS.runtime, {
    dir: RUNTIME,
    headers: { "access-control-allow-origin": "*" },
  });

  // A separate asset origin whose responses this suite controls, for the three failure shapes.
  // They are deployment failures - a directory never uploaded, a file substituted - and none of
  // them can be arranged by laying out a directory correctly.
  let assetMode = "ok";
  const assetsDir = join(RUN, "assets");
  mkdirSync(assetsDir, { recursive: true });
  cpSync(ADDONS, join(assetsDir, "python-addons"), { recursive: true });
  const assetsS = await serveTls(tls, HOSTS.assets, {
    dir: assetsDir,
    headers: { "access-control-allow-origin": "*" },
    handle: (req, res, url) => {
      const coastline = url.pathname.endsWith("ne_110m_coastline.shp");
      if (assetMode === "missing" && coastline) {
        // WITH the CORS header, deliberately. Without it the browser reports an opaque network
        // failure rather than the status, and the interpreter would correctly say "this looks
        // like a network or CORS failure" - a true sentence about a different situation. What is
        // tested here is a server that HAS the path and answers 404 for it.
        res
          .writeHead(404, {
            "access-control-allow-origin": "*",
            "content-type": "text/plain",
          })
          .end("404\n");
        return true;
      }
      if (assetMode === "tampered" && coastline) {
        // A 200 with the WRONG BYTES - the case a status code cannot describe and a manifest
        // served beside the file cannot catch, because whoever replaced the file can replace the
        // manifest. The digest the interpreter checks against travelled inside its own bundle.
        const body = Buffer.concat([
          readFileSync(join(assetsDir, "python-addons", ...url.pathname.split("/").slice(2))),
          Buffer.from("substituted"),
        ]);
        res
          .writeHead(200, {
            "access-control-allow-origin": "*",
            "content-type": "application/octet-stream",
            "content-length": String(body.length),
          })
          .end(body);
        return true;
      }
      return false;
    },
  });

  const portalS = await serveTls(tls, HOSTS.portal, { dir: join(RUN, "a"), headers: {} });

  // portal A: the good one
  const materials = join(RUN, "materials");
  mkdirSync(join(materials, "python-addons"), { recursive: true });
  cpSync(ADDONS, join(materials, "python-addons"), { recursive: true });
  // Prepared the way `prepare-playground` prepares it, using the builder's own planner, so what
  // the build verifies is the real contract and not a relaxed variant made for a test.
  const { planPythonMaterials, pythonMaterialsCacheKey } = await import(
    join(PKG, "dist", "model", "python-materials.js")
  );
  const planA = planPythonMaterials({
    profile: "xarray-zarr",
    addons: ["cartopy-natural-earth-110m", "dask"],
    optionalAddons: [],
  });
  writeFileSync(
    join(materials, "PYTHON-MATERIALS.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        preparedBy: "browser-tests/python-deployment.mjs",
        preparedAt: new Date(0).toISOString(),
        cacheKey: pythonMaterialsCacheKey(planA),
        profile: planA.profile,
        addons: planA.addons,
        optionalAddons: planA.optionalAddons,
        runtime: planA.runtime,
        files: planA.files,
      },
      null,
      2,
    )}\n`,
  );

  const SNIPPET = [
    "import dask",
    "import xarray as xr",
    "print('scheduler', dask.config.get('scheduler'))",
    "print('dask', dask.__version__)",
    `ds = xr.open_dataset(${JSON.stringify(`${portalS.base}fixtures/zarr-v3/`)}, engine="zarr", chunks={})`,
    "print('backing', type(ds.sfcWind.data).__module__)",
    "print('value', float(ds.sfcWind.isel(time=0, lat=0, lon=0).compute()))",
    // ASSEMBLED AT RUNTIME, so the token cannot appear in the echoed command. The console prints
    // the source before it runs it, so a wait keyed on a literal the source itself contains
    // resolves the moment the echo is drawn - before a single line has executed - and then races
    // the output. Built by concatenation, only the OUTPUT can contain the marker.
    "print('__D' + 'ONE__')",
    "",
  ].join("\n");

  const builtA = buildSite("a", {
    canonical: portalS.base,
    profile: "xarray-zarr",
    addons: ["cartopy-natural-earth-110m", "dask"],
    runtimeIndexUrl: runtimeS.base,
    materials,
    snippet: SNIPPET,
  });
  cpSync(builtA, join(RUN, "a"), { recursive: true });
  cpSync(
    join(REPO, "packages", "browser-python", "tests", "fixtures", "zarr-v3"),
    join(RUN, "a", "fixtures", "zarr-v3"),
    { recursive: true },
  );
  portalS.state.headers = { "content-security-policy": portalPolicy(builtA) };

  browser = await chromium.launch({
    args: chromiumArgs(Object.values(HOSTS)),
    ...(existsSync("/opt/pw-browsers/chromium")
      ? { executablePath: "/opt/pw-browsers/chromium" }
      : {}),
  });

  await check("the built artifact passes verify with its Python materials inside it", () => {
    const output = cli("verify", "--dir", builtA);
    assert.doesNotMatch(output, /error/, output);
    const checksums = readFileSync(join(builtA, "checksums.sha256"), "utf8");
    for (const file of planA.files) {
      assert.ok(checksums.includes(`${file.sha256}  ${file.path}`), `${file.path} not checksummed`);
    }
  });

  await check("the page points at the artifact's own path, naming no host", () => {
    const html = readFileSync(join(builtA, "docs/run/index.html"), "utf8");
    const raw = /data-portal-python-playground="([^"]*)"/.exec(html)[1];
    const config = JSON.parse(
      raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&#39;", "'"),
    );
    assert.equal(config.addonBaseUrl, "/python-addons/");
    assert.deepEqual(config.addons, ["cartopy-natural-earth-110m", "dask"]);
  });

  // the one heavy interpreter start
  await check(
    "the playground reaches Ready and Dask works, from the artifact's own assets",
    async () => {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const external = [];
      page.on("request", (r) => {
        const url = r.url();
        if (
          !url.startsWith(portalS.origin) &&
          !url.startsWith(runtimeS.origin) &&
          !url.startsWith("data:") &&
          !url.startsWith("blob:")
        ) {
          external.push(url);
        }
      });
      portalS.state.requests = [];
      try {
        const text = await runSnippet(page, portalS.base);
        assert.ok(text.includes("__DONE__"), text.slice(-900));
        // The add-on's promise, not a default: one Worker, one synchronous scheduler.
        assert.ok(/scheduler synchronous/.test(text), text.slice(-600));
        assert.ok(/dask 20\d\d\./.test(text), text.slice(-600));
        // xarray found the chunk manager with no cache surgery, and the compute finished.
        assert.ok(/backing dask\.array/.test(text), text.slice(-600));
        assert.ok(/value 10\.27/.test(text), text.slice(-600));

        // The assets came from the artifact, and the server answered 200 for each of them.
        const served = portalS.state.requests.map((r) => r.path);
        for (const file of planA.files.filter((f) => f.path.startsWith("python-addons/"))) {
          assert.ok(served.includes(`/${file.path}`), `never requested /${file.path}`);
        }

        // NO PACKAGE INDEX, and no sibling of a CDN that has no such directory.
        assert.deepEqual(
          external.filter((u) => /pypi\.org|pythonhosted\.org/.test(u)),
          [],
          "a package index was contacted",
        );
        assert.deepEqual(
          external.filter((u) => /cdn\.jsdelivr\.net/.test(u)),
          [],
          "the pinned CDN was contacted even though the runtime is self-hosted",
        );
        assert.deepEqual(external, [], `unexpected external requests: ${external.join(", ")}`);
      } finally {
        await context.close();
      }
    },
  );

  // portal B: a required add-on that is missing
  const portalB = await serveTls(tls, HOSTS.portal, { dir: join(RUN, "b"), headers: {} });
  const builtB = buildSite("b", {
    canonical: portalB.base,
    profile: "minimal",
    addons: ["cartopy-natural-earth-110m"],
    runtimeIndexUrl: runtimeS.base,
    addonBaseUrl: `${assetsS.origin}/python-addons/`,
    snippet: "print('__D' + 'ONE__')\n",
  });
  cpSync(builtB, join(RUN, "b"), { recursive: true });
  portalB.state.headers = { "content-security-policy": portalPolicy(builtB) };

  await check(
    "a missing REQUIRED add-on prevents Ready, and says what to do about it",
    async () => {
      assetMode = "missing";
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      try {
        const text = await runSnippet(page, portalB.base, { timeout: 300_000 });
        assert.ok(!text.includes("__DONE__"), "the interpreter started anyway");
        // Structured, and each part is a thing a reader can act on.
        assert.match(text, /ne_110m_coastline\.shp/);
        assert.match(text, /HTTP 404/);
        assert.match(text, /pythonPlayground\.addonBaseUrl/);
        assert.match(text, /addonBaseURL in the API/);
        assert.match(text, /prepare-addons/);
        // And the one sentence that tells a reader retrying will not help.
        assert.match(text, /Restarting requests the same URL and gets the same answer/);
      } finally {
        assetMode = "ok";
        await context.close();
      }
    },
  );

  // portal C: the same add-on, declared optional
  const portalC = await serveTls(tls, HOSTS.portal, { dir: join(RUN, "c"), headers: {} });
  const builtC = buildSite("c", {
    canonical: portalC.base,
    profile: "minimal",
    addons: ["cartopy-natural-earth-110m"],
    optionalAddons: ["cartopy-natural-earth-110m"],
    runtimeIndexUrl: runtimeS.base,
    addonBaseUrl: `${assetsS.origin}/python-addons/`,
    snippet: "print('__D' + 'ONE__')\n",
  });
  cpSync(builtC, join(RUN, "c"), { recursive: true });
  portalC.state.headers = { "content-security-policy": portalPolicy(builtC) };

  await check(
    "a missing OPTIONAL add-on still reaches Ready, and is reported as unavailable",
    async () => {
      assetMode = "missing";
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      try {
        // The warning is printed during startup and matches the generic failure patterns, so this
        // one waits for the snippet's own output and nothing else.
        const text = await runSnippet(page, portalC.base, { timeout: 600_000, until: "__DONE__" });
        assert.ok(text.includes("__DONE__"), `Python did not run: ${text.slice(-600)}`);
        // One warning, and it names the capability rather than dumping a traceback.
        assert.match(text, /Cartopy coastlines and country borders, offline is unavailable/);
        assert.doesNotMatch(text, /Traceback/);
        const warnings = (text.match(/is unavailable/g) ?? []).length;
        assert.equal(warnings, 1, `warned ${warnings} times`);

        // And the ready payload says so in a form the help panel renders.
        const unavailable = await page.evaluate(
          () =>
            document.querySelector("freva-python-console")?.readyInfo?.unavailableAddons ??
            "missing",
        );
        assert.equal(unavailable.length, 1);
        assert.equal(unavailable[0].id, "cartopy-natural-earth-110m");
        assert.match(unavailable[0].remedy, /prepare-addons/);
        assert.equal(unavailable[0].retryMayHelp, false);

        // ATOMIC. Nothing points at data that is not there, so `import cartopy` is unaffected
        // and only the OFFLINE data is missing - which is what the report says, and is not the
        // same claim as "cartopy is unavailable".
        const env = await page.evaluate(async () => {
          const el = document.querySelector("freva-python-console");
          await el.execute(
            "import os; print('CARTOPY_DATA_DIR', os.environ.get('CARTOPY_DATA_DIR', '<unset>'))\n",
          );
          return el.shadowRoot?.textContent ?? "";
        });
        assert.match(env, /CARTOPY_DATA_DIR <unset>/);
      } finally {
        assetMode = "ok";
        await context.close();
      }
    },
  );

  await check("restarting does not accumulate the same warning", async () => {
    assetMode = "missing";
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await runSnippet(page, portalC.base, { timeout: 600_000, until: "__DONE__" });
      await page.evaluate(async () => {
        const el = document.querySelector("freva-python-console");
        el.clear();
        await el.restart();
      });
      await page.waitForFunction(
        () =>
          (document.querySelector("freva-python-console")?.shadowRoot?.textContent ?? "").includes(
            "is unavailable",
          ),
        null,
        { timeout: 300_000 },
      );
      const text = await page.evaluate(
        () => document.querySelector("freva-python-console")?.shadowRoot?.textContent ?? "",
      );
      // ONE per interpreter, not one per restart accumulating forever. The transcript was
      // cleared before the restart, so what is counted is what THIS interpreter said.
      const warnings = (text.match(/is unavailable/g) ?? []).length;
      assert.equal(warnings, 1, `the restarted interpreter warned ${warnings} times`);
      assert.doesNotMatch(text, /Traceback/);
    } finally {
      assetMode = "ok";
      await context.close();
    }
  });

  // portal D: substituted bytes
  await check(
    "substituted bytes are never installed, even with a 200 and a matching name",
    async () => {
      assetMode = "tampered";
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      try {
        const text = await runSnippet(page, portalB.base, { timeout: 300_000 });
        assert.ok(!text.includes("__DONE__"), "the interpreter started on substituted bytes");
        assert.match(text, /not the artefact this build pinned/);
        assert.match(text, /expected sha256/);
        assert.match(text, /received sha256/);
        assert.match(text, /Nothing from .* has been installed/);
      } finally {
        assetMode = "ok";
        await context.close();
      }
    },
  );

  console.log(`\n=== python deployment ===`);
} finally {
  await browser?.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} python deployment checks passed`);
process.exit(passed === results.length ? 0 : 1);
