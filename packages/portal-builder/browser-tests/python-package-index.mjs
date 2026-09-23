// The generated policy against the profile that needs a package index, in a real browser.
//
// `resolvePackagePolicy` adds `https://pypi.org` and `https://files.pythonhosted.org` to a
// curated portal's `connect-src` when, and only when, the chosen profile reaches an index during
// startup - which `freva-client` does, because its one derived wheel is installed WITH dependency
// resolution and micropip resolves the ordinary dependencies from PyPI while the page is coming
// up. `tests/artifact/package-policy.test.ts` checks that the built bytes SAY so. Nothing there
// checks that a browser AGREES, and that is the failure this suite is about: a portal whose
// policy names no index builds cleanly, deploys cleanly, loads cleanly, and then dies at
// micropip's metadata lookup with an error about a package rather than about a header.
//
// So the artifact is served under THE POLICY THE BUILD ITSELF GENERATED - `host-policy.json` ->
// `csp.portal`, the same file that test reads, as one real header - and the claim is a pair:
//
//   - as generated, the playground reaches a live interpreter, imports a dependency that can only
//     have come from the index, and nothing is refused;
//   - with those two origins REMOVED from that same header, the same artifact cannot start, and
//     says so at the install.
//
// One half alone proves nothing. A green positive with the header never applied looks identical
// to a green positive with a correct header, and a red negative can be a broken fixture.
//
// The runtime and the Freva wheelhouse are served locally, over TLS, from the copies
// `@freva-org/browser-python` prepares - the same bytes its own suites run - because a suite that
// downloads a runtime from a CDN fails when the CDN is slow. The package index is the real one:
// "does the generated header permit what this profile actually does" is the question, and a stub
// would answer it with itself.
//
// Usage:  node browser-tests/python-package-index.mjs
//   FREVA_PYODIDE_RUNTIME=<dir>   a prepared Pyodide distribution (default
//                                 packages/browser-python/.runtime)
//   FREVA_FREVA_WHEELS=<dir>      a prepared Freva wheelhouse (default
//                                 packages/browser-python/.freva-wheels); built here when absent
//   BROWSER_STRICT=1              turn a skip into a failure
//   FREVA_ONLY=<substring>        run one check

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
const BROWSER_PYTHON = join(REPO, "packages", "browser-python");
const RUNTIME = process.env.FREVA_PYODIDE_RUNTIME ?? join(BROWSER_PYTHON, ".runtime");
const WHEELS = process.env.FREVA_FREVA_WHEELS ?? join(BROWSER_PYTHON, ".freva-wheels");
const STRICT = process.env.BROWSER_STRICT === "1";
const ONLY = process.env.FREVA_ONLY;
const RUN = mkdtempSync(join(tmpdir(), `py-index-${Date.now()}-`));

/** The two hosts micropip uses. Written here rather than imported, so a change to that list in
 * `@freva-org/browser-python` shows up as a failing expectation instead of as agreement with
 * itself. */
const INDEX_ORIGINS = ["https://pypi.org", "https://files.pythonhosted.org"];

const HOSTS = {
  portal: "portal.example.org",
  runtime: "runtime.example.org",
  wheels: "wheels.example.org",
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
      "`node bin/freva-browser-python.mjs prepare-runtime --full --out .runtime` in " +
      "packages/browser-python, or set FREVA_PYODIDE_RUNTIME.",
  );
}

// The derived Freva wheel, built from PyPI when it is not already there. This suite needs the
// public index anyway, so building it costs nothing a run here has not already accepted - and a
// wheelhouse that is absent would otherwise surface as a startup error that reads like a product
// defect rather than like a missing prerequisite.
if (!existsSync(join(WHEELS, "MANIFEST.json"))) {
  try {
    const { prepareFrevaWheelhouse } = await import(
      join(BROWSER_PYTHON, "bin", "freva-wheelhouse.mjs")
    );
    let failure = "";
    await prepareFrevaWheelhouse(
      { out: WHEELS },
      {
        fail: (message) => {
          failure = message;
        },
        log: () => {},
      },
    );
    if (failure) throw new Error(failure);
  } catch (error) {
    skip(`the derived Freva wheel could not be built: ${String(error.message).split("\n")[0]}`);
  }
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  skip(`playwright is not installed: ${error.message}`);
}

// fixture

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>M</title><rect width="16" height="16" fill="#123"/></svg>`;

/**
 * The program the Try control runs.
 *
 * `py_oidc_auth_client` is the point: it is not in the Pyodide lock and it is not beside the
 * derived wheel, so the only way it can be importable is micropip having resolved it from the
 * index during startup. Importing it is therefore evidence about the HEADER, not only about the
 * interpreter being alive.
 *
 * `__DONE__` is assembled at run time. The console echoes a submitted program before running it,
 * so a wait keyed on a literal the source contains resolves the moment the echo is painted -
 * before a line has executed - and then races the output it was meant to wait for.
 */
const SNIPPET = [
  "import freva_client, py_oidc_auth_client",
  "print('oidc', getattr(py_oidc_auth_client, '__version__', 'n/a'))",
  "print('freva', getattr(freva_client, '__version__', 'n/a'))",
  "print('__D' + 'ONE__')",
  "",
].join("\n");

function buildSite({ canonical, runtimeIndexUrl, wheelhouseUrl }) {
  const src = join(RUN, "src");
  const put = (rel, body) => {
    const target = join(src, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put(
    "content/run.md",
    `---\ntitle: Run\n---\n\n# Run\n\n\`\`\`python try-in-python\n${SNIPPET}\`\`\`\n`,
  );
  put(
    "landings/home.yaml",
    "schemaVersion: 1\ntitle: Index\nblocks:\n  - type: hero\n    heading: Index\n",
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: py-package-index
  title: Package index
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
  profile: freva-client
  autostart: never
  maxSessions: 1
  runtimeIndexUrl: ${runtimeIndexUrl}
  wheelhouseUrl: ${wheelhouseUrl}
  terminal:
    style: freva-client-terminal
    osControls: linux
    alwaysOnTop: true
    rememberAppearance: false
`,
  );
  const out = join(RUN, "built");
  execFileSync(
    process.execPath,
    // prettier-ignore
    [join(PKG, "bin", "freva-portal-builder.mjs"), "build",
     "--source-root", src, "--config", join(src, "portal.yaml"), "--out", out, "--quiet"],
    { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
  );
  return out;
}

/** The playground configuration the page stamps for its own client code to read. */
function pageConfig(built, page) {
  const html = readFileSync(join(built, page), "utf8");
  const raw = /data-portal-python-playground="([^"]*)"/.exec(html)?.[1];
  assert.ok(raw, "the page carries no playground configuration");
  return JSON.parse(
    raw
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&#39;", "'"),
  );
}

/** One directive rewritten, everything else left exactly as the build wrote it. */
function withoutOrigins(policy, origins) {
  return policy
    .split("; ")
    .map((directive) =>
      directive.startsWith("connect-src ")
        ? directive
            .split(" ")
            .filter((token) => !origins.includes(token))
            .join(" ")
        : directive,
    )
    .join("; ");
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

/** Press Try, and answer with the transcript once the program ended or the start gave up. */
async function runSnippet(page, base, { timeout, until }) {
  await page.goto(`${base}docs/run/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector("button[data-portal-run]", { timeout: 30_000 });
  await page.click("button[data-portal-run]");
  await page.waitForSelector(".freva-term.show", { timeout: 60_000 });
  await page
    .waitForFunction(
      (source) => {
        const text = document.querySelector("freva-python-console")?.shadowRoot?.textContent ?? "";
        return new RegExp(source).test(text);
      },
      until,
      { timeout, polling: 1000 },
    )
    .catch(() => undefined);
  return page.evaluate(
    () => document.querySelector("freva-python-console")?.shadowRoot?.textContent ?? "",
  );
}

/** A cold start on this profile is minutes: the runtime, the wheel, then the resolution. */
const STARTUP_MS = 900_000;
/** The failure half never gets past the install, but it still loads the runtime first. */
const FAILURE_MS = 600_000;

let browser;
const servers = [];
try {
  const tls = certificate(join(RUN, "tls"), Object.values(HOSTS));
  mkdirSync(join(RUN, "site"), { recursive: true });

  // Every origin allocated BEFORE the build, because the build compiles them into the artifact
  // and into the policy it records.
  const runtimeS = await serveTls(tls, HOSTS.runtime, {
    dir: RUNTIME,
    headers: { "access-control-allow-origin": "*" },
  });
  const wheelsS = await serveTls(tls, HOSTS.wheels, {
    dir: WHEELS,
    headers: { "access-control-allow-origin": "*" },
  });
  const portalS = await serveTls(tls, HOSTS.portal, { dir: join(RUN, "site"), headers: {} });
  servers.push(runtimeS, wheelsS, portalS);

  const built = buildSite({
    canonical: portalS.base,
    runtimeIndexUrl: runtimeS.base,
    wheelhouseUrl: wheelsS.base,
  });
  cpSync(built, join(RUN, "site"), { recursive: true });

  // THE BUILD'S OWN POLICY, as one header. Not a policy this suite composed: the whole claim is
  // about what the build generated, so anything hand-written here would be testing the test.
  const POLICY = portalPolicy(built);
  portalS.state.headers = { "content-security-policy": POLICY };
  const ABLATED = withoutOrigins(POLICY, INDEX_ORIGINS);
  console.log(`portal ${portalS.origin} · runtime ${runtimeS.origin} · wheels ${wheelsS.origin}`);
  console.log(`policy connect-src: ${/connect-src [^;]*/.exec(POLICY)?.[0] ?? "(none)"}`);

  const executable = process.env.FREVA_PORTAL_CHROMIUM ?? "/opt/pw-browsers/chromium";
  browser = await chromium.launch({
    args: chromiumArgs(Object.values(HOSTS)),
    ...(existsSync(executable) ? { executablePath: executable } : {}),
  });

  /** One page with the diagnostics every claim below is read from, attached before it navigates. */
  async function withPage(fn) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const violations = [];
    const requests = [];
    const failed = [];
    page.on("console", (m) => {
      if (m.text().startsWith("CSPVIOLATION"))
        violations.push(m.text().slice("CSPVIOLATION ".length));
    });
    page.on("request", (r) => requests.push(r.url()));
    page.on("requestfailed", (r) =>
      failed.push(`${r.url().slice(0, 110)} ${r.failure()?.errorText ?? ""}`),
    );
    // Recorded in the document that refused, which is the only one that fires the event.
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) =>
        console.log(`CSPVIOLATION ${e.effectiveDirective} ${String(e.blockedURI).slice(0, 60)}`),
      );
    });
    try {
      return await fn(page, { violations, requests, failed });
    } finally {
      await context.close();
    }
  }

  const isIndex = (url) => INDEX_ORIGINS.some((origin) => url.startsWith(`${origin}/`));

  // 1. the artifact, before a browser is asked to prove anything

  await check("the build recorded a policy that names the package index, for this profile", () => {
    const connect = /connect-src ([^;]*)/.exec(POLICY)?.[1] ?? "";
    for (const origin of INDEX_ORIGINS) {
      assert.ok(connect.split(" ").includes(origin), `connect-src omits ${origin}: ${connect}`);
    }
    // The origins the deployment configured are there too, or the page could not fetch its own
    // runtime and wheels and the interpreter check below would fail for an unrelated reason.
    assert.ok(connect.includes(runtimeS.origin), `connect-src omits the runtime: ${connect}`);
    assert.ok(connect.includes(wheelsS.origin), `connect-src omits the wheelhouse: ${connect}`);
  });

  await check("…and the page advertises exactly what that header permits", () => {
    const config = pageConfig(built, "docs/run/index.html");
    // `packageIndex` is the build's own statement that the profile COSTS an index, which is a
    // different claim from the deployment having asked for one - `kind` stays curated.
    assert.equal(config.packagePolicy.packageIndex, true, "the page does not record the index");
    assert.equal(config.packagePolicy.kind, "curated");
    for (const origin of INDEX_ORIGINS) {
      assert.ok(
        config.packagePolicy.origins.includes(origin),
        `the page omits ${origin}: ${config.packagePolicy.origins.join(", ")}`,
      );
    }
    const connect = /connect-src ([^;]*)/.exec(POLICY)?.[1] ?? "";
    for (const origin of config.packagePolicy.origins) {
      assert.ok(connect.includes(origin), `${origin} is advertised and absent from connect-src`);
    }
  });

  await check("the ablation removes that grant and nothing else", () => {
    assert.notEqual(ABLATED, POLICY, "removing the index origins changed nothing");
    assert.equal(
      withoutOrigins(ABLATED, INDEX_ORIGINS),
      ABLATED,
      "the ablation is not idempotent, so it removed more than the two origins",
    );
    const before = POLICY.split("; ").map((d) => d.split(" ")[0]);
    const after = ABLATED.split("; ").map((d) => d.split(" ")[0]);
    assert.deepEqual(after, before, "the ablation dropped or added a directive");
  });

  // 2. the header the build generated, in force, with a real interpreter behind it

  await check(
    "the playground reaches a live interpreter under the policy the build generated",
    () =>
      withPage(async (page, seen) => {
        const text = await runSnippet(page, portalS.base, {
          timeout: STARTUP_MS,
          until: "__DONE__|could not be installed|is not available|HTTP \\d{3}",
        });
        assert.ok(text.includes("__DONE__"), `the program did not finish:\n${text.slice(-900)}`);
        // A dependency that is in neither the Pyodide lock nor the wheelhouse: it can only be
        // here because micropip resolved it from the index this header names.
        assert.match(
          text,
          /oidc \d/,
          `the resolved dependency is not importable:\n${text.slice(-600)}`,
        );
        assert.doesNotMatch(text, /Traceback/, text.slice(-600));
        assert.deepEqual(
          seen.violations,
          [],
          `the generated policy refused: ${seen.violations.join(", ")}`,
        );

        // The grant was USED, not merely present: a startup that never contacted the index would
        // make this whole suite a statement about a header nothing depends on.
        const index = seen.requests.filter(isIndex);
        assert.ok(index.length > 0, "nothing was fetched from the package index at all");
        // And nowhere else. Four origins are expected - this portal, the runtime, the wheelhouse
        // and the index - and a fifth would be permission this policy did not intend to grant.
        const stray = seen.requests.filter(
          (url) =>
            !url.startsWith(portalS.origin) &&
            !url.startsWith(runtimeS.origin) &&
            !url.startsWith(wheelsS.origin) &&
            !url.startsWith("data:") &&
            !url.startsWith("blob:") &&
            !isIndex(url),
        );
        assert.deepEqual(
          stray.slice(0, 5),
          [],
          `unexpected origins: ${stray.slice(0, 5).join(", ")}`,
        );
      }),
  );

  // 3. and the same artifact, with those two origins taken out of that same header

  await check("the same artifact cannot start when the header does not name the index", () =>
    withPage(async (page, seen) => {
      portalS.state.headers = { "content-security-policy": ABLATED };
      try {
        const text = await runSnippet(page, portalS.base, {
          timeout: FAILURE_MS,
          until: "__DONE__|could not be installed|Underlying error|is not available|HTTP \\d{3}",
        });
        assert.ok(
          !text.includes("__DONE__"),
          `the interpreter started without the grant:\n${text.slice(-900)}`,
        );

        // AND FOR THE RIGHT REASON. A start that failed because the wheelhouse was unreachable,
        // or because the runtime never loaded, would satisfy the line above and say nothing about
        // the package index. Three independent signals, any one of which names it: what the
        // console printed, the browser's own record of a refused request, and a violation report
        // naming one of the two origins.
        const blocked = seen.failed.filter((entry) => isIndex(entry));
        const reported = seen.violations.filter((entry) => /pypi|pythonhosted/.test(entry));
        const named = /Can't fetch metadata|pypi\.org|pythonhosted|could not be installed/i.test(
          text,
        );
        assert.ok(
          named || blocked.length > 0 || reported.length > 0,
          `the failure never names the index:\n${text.slice(-900)}\n${seen.failed.slice(0, 4).join("\n")}`,
        );

        // LATE, not a page that never started. `connect-src` still names the runtime and the
        // wheelhouse, so the refusal has to arrive after both were fetched - otherwise the
        // failure is about this fixture rather than about the one grant that was removed.
        assert.ok(
          seen.requests.some((url) => url.startsWith(runtimeS.origin)),
          "the runtime was never fetched, so the start failed before the install",
        );
        assert.ok(
          seen.requests.some((url) => url.startsWith(wheelsS.origin) && url.endsWith(".whl")),
          "the derived wheel was never fetched, so the start failed before the install",
        );
      } finally {
        portalS.state.headers = { "content-security-policy": POLICY };
      }
    }),
  );
} finally {
  await browser?.close();
  for (const entry of servers) entry.server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} package-index checks passed`);
// Zero checks is not a pass either: a run that asserted nothing has demonstrated nothing, and a
// mistyped FREVA_ONLY would otherwise exit 0 having executed no test at all.
process.exit(failed.length > 0 || results.length === 0 ? 1 : 0);
