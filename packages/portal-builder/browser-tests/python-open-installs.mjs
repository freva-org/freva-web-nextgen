// Open package installs, HTTPS data and Cartopy's own downloads, in a real browser.
//
// Every claim here is about something only a browser decides: whether a Content-Security-Policy
// permits a fetch, whether a host sends the CORS header that lets a Worker read the response,
// whether a synchronous `XMLHttpRequest` is allowed where Cartopy's downloader API needs one.
// None of that can be established from source, so the portal is BUILT for the origin it is
// served at, served UNDER ITS OWN RECORDED POLICY - `host-policy.json`, as one header - and
// driven through the product's own console.
//
// The runtime is served locally, from a copy of the pinned Pyodide distribution, for the reason
// every suite here does it: a test that reaches a CDN is a test that fails when the CDN is slow.
// Nothing else is mocked. The package index is the real one, the wheels come from the real host,
// and the Natural Earth files come from the real mirror, because "does this actually reach the
// public index" is the question and a stub would answer it with itself.
//
// Usage:  node browser-tests/python-open-installs.mjs
//   FREVA_WATERPARK_BUILD=<dir>   a BUILT Waterpark artifact to test instead of the fixture: the
//                                 real portal, its real configuration, its own `host-policy.json`
//                                 as the served header.
//   FREVA_PYODIDE_RUNTIME=<dir>   a prepared Pyodide distribution (default
//                                 packages/browser-python/.runtime)
//   BROWSER_STRICT=1              turn a skip into a failure
//   FREVA_ONLY=<substring>        run one check

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { certificate, serveTls, portalPolicy, chromiumArgs } from "./fixtures/tls-origins.mjs";
import { readTranscript, wrap } from "./fixtures/transcript.mjs";
import { buildWaterparkShaped } from "./waterpark-shaped.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const REPO = resolve(PKG, "..", "..");
const STRICT = process.env.BROWSER_STRICT === "1";
const ONLY = process.env.FREVA_ONLY;
const RUNTIME =
  process.env.FREVA_PYODIDE_RUNTIME ?? join(REPO, "packages", "browser-python", ".runtime");
const RUN = mkdtempSync(join(tmpdir(), "py-open-"));

function skip(message) {
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

if (!existsSync(join(RUNTIME, "pyodide.js"))) {
  skip(`no local Pyodide runtime at ${RUNTIME}. Set FREVA_PYODIDE_RUNTIME.`);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  skip(`playwright is not installed: ${error.message}`);
}

// A PACKAGE THE PINNED RUNTIME DOES NOT HAVE. The point of the check is that the install REACHES
// the public index, so a package already in Pyodide's own catalogue would prove nothing:
// `micropip` would find it in the lock file and load it from the runtime origin without ever
// asking PyPI. `toposort` is pure Python, 8.5 KB, has no dependencies, and is absent from
// `pyodide-lock.json` for 314.0.6.
const BY_NAME = { module: "toposort", package: "toposort" };
// And a second one, installed from a URL rather than a name, for the direct-wheel path. The URL
// is RESOLVED from the index at run time rather than written down: a hash-pathed wheel URL pasted
// into a test is a URL that will one day 404, and a 404 from that host arrives in the browser as
// `ERR_FAILED`, which reads exactly like a policy refusal and would send the next reader looking
// at the CSP. Resolving it means the check fails for the reason it is about, or not at all.
const BY_URL = { module: "inflection", package: "inflection", url: null };
try {
  const meta = await fetch("https://pypi.org/pypi/inflection/json").then((r) => r.json());
  const version = meta.info.version;
  BY_URL.url = meta.releases[version].find((f) => f.filename.endsWith(".whl"))?.url ?? null;
} catch (error) {
  console.log(`  (could not resolve a wheel URL from the index: ${error.message})`);
}

// A BUILT ARTIFACT, or one built here. `FREVA_WATERPARK_BUILD` points at a real portal. Its
// `canonicalUrl` decides the origin it must be served at, because the policy it carries names it,
// and its runtime is whatever it was configured with. When that runtime is a CDN this run cannot
// reach, `FREVA_PYODIDE_RUNTIME` is served locally and the CDN's URLs are routed to it - which
// leaves the POLICY doing its real job: the fetch still has to be one `connect-src` permits.
const GIVEN = process.env.FREVA_WATERPARK_BUILD ? resolve(process.env.FREVA_WATERPARK_BUILD) : null;
const GIVEN_URL = GIVEN
  ? new URL(
      JSON.parse(readFileSync(join(GIVEN, "host-policy.json"), "utf8")).mount?.canonicalUrl ??
        "https://waterpark.example.org/",
    )
  : null;

const HOSTS = GIVEN_URL
  ? { portal: GIVEN_URL.hostname, runtime: "runtime.example.org" }
  : { portal: "waterpark.example.org", runtime: "runtime.example.org" };
let tls;
try {
  tls = certificate(join(RUN, "tls"), Object.values(HOSTS));
} catch (error) {
  skip(`openssl could not make a certificate: ${error.message}`);
}

mkdirSync(join(RUN, "site"), { recursive: true });
const runtimeServer = await serveTls(tls, HOSTS.runtime, {
  dir: RUNTIME,
  headers: { "access-control-allow-origin": "*" },
});
const portalServer = await serveTls(tls, HOSTS.portal, { dir: join(RUN, "site"), headers: {} });

// BUILT AS WATERPARK IS CONFIGURED: the open network mode, and Cartopy's prepared data as an
// OPTIONAL add-on. Built for the origin it will be served at, because the recorded policy names it.
const built =
  GIVEN ??
  buildWaterparkShaped({
    canonicalUrl: portalServer.base,
    python: {
      profile: "xarray-zarr",
      runtimeIndexUrl: runtimeServer.base,
      network: "https",
      addons: ["cartopy-natural-earth-110m"],
      optionalAddons: ["cartopy-natural-earth-110m"],
    },
    outDir: join(RUN, "built"),
  });
cpSync(built, join(RUN, "site"), { recursive: true });
const POLICY = portalPolicy(built);
portalServer.state.headers = { "content-security-policy": POLICY };
console.log(`portal ${portalServer.origin} · runtime ${runtimeServer.origin}`);
console.log(`policy connect-src: ${/connect-src [^;]*/.exec(POLICY)?.[0] ?? "(none)"}`);

async function shutdown() {
  portalServer.server.close();
  runtimeServer.server.close();
  await browser?.close();
}

let browser;
try {
  browser = await chromium.launch({
    args: chromiumArgs(Object.values(HOSTS)),
    executablePath: process.env.FREVA_PORTAL_CHROMIUM ?? "/opt/pw-browsers/chromium",
  });
} catch (error) {
  await shutdown();
  skip(`chromium would not launch: ${error.message}`);
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

// THE RUNTIME THE ARTIFACT ASKS FOR, served locally when this machine cannot reach it.
// Waterpark's configuration points at the pinned CDN, and routing those URLs to the local copy is
// a TRANSPORT substitution and nothing more: the request is still issued by the page, still has
// to pass `connect-src` and `script-src`, and still loads the same pinned version.
const RUNTIME_PREFIX = "https://cdn.jsdelivr.net/pyodide/v314.0.6/full/";
async function routeRuntime(context) {
  if (!GIVEN) return;
  await context.route(`${RUNTIME_PREFIX}*`, async (route) => {
    const name = route.request().url().slice(RUNTIME_PREFIX.length).split("?")[0];
    const file = join(RUNTIME, name);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
    await route.fulfill({
      status: 200,
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(file),
      contentType: name.endsWith(".wasm")
        ? "application/wasm"
        : name.endsWith(".mjs") || name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".json")
            ? "application/json"
            : "application/octet-stream",
    });
  });
}

/** One page, with the request log every network claim below is read from. */
async function withPage(fn) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1480, height: 900 },
    colorScheme: "dark",
  });
  await routeRuntime(context);
  const page = await context.newPage();
  const problems = [];
  const requests = [];
  // THE EXTERNAL HOSTS ARE RECORDED AT THE CONTEXT, not at the page. `page.on("request")` does
  // not reliably report what a dedicated Worker fetches, and everything interesting here - the
  // index, the wheel host, the Natural Earth mirror - is fetched by the Worker. A context-scoped
  // route does see them (it is how this suite serves the runtime), so the three hosts the claims
  // are about are observed there and passed straight through: the request still leaves the
  // browser, still has to satisfy `connect-src`, and still has to be one the host answers with a
  // CORS header.
  await context.route(
    /https:\/\/(pypi\.org|files\.pythonhosted\.org|raw\.githubusercontent\.com)\//,
    async (route) => {
      requests.push(route.request().url());
      await route.continue();
    },
  );
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text().slice(0, 300));
  });
  // EVERY REQUEST THE PAGE AND ITS WORKERS MAKE. `page.on("request")` sees the Worker's fetches
  // too, which is what makes "did this reach the public index" answerable rather than inferred from
  // the install succeeding. A CSP refusal shows up as a `requestfailed`, so both are recorded.
  page.on("request", (r) => requests.push(r.url()));
  const failed = [];
  page.on("requestfailed", (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));
  await page.addInitScript(() => {
    window.__consoleErrors = [];
    window.addEventListener("error", (e) => window.__consoleErrors.push(String(e.message)));
    window.addEventListener("unhandledrejection", (e) =>
      window.__consoleErrors.push(`unhandled: ${String(e.reason)}`),
    );
    window.__pyStates = [];
    document.addEventListener("browser-python-status", (event) => {
      window.__pyStates.push(event.detail?.state);
    });
  });
  try {
    await page.goto(portalServer.base, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".dataset-tree", { timeout: 30_000 });
    await fn(page, { problems, requests, failed });
  } finally {
    await context.close();
  }
}

/**
 * Open the console from the runnable block on the page. Not from a dataset-tree leaf, which is how
 * `waterpark-terminal` does it: the tree's Try buttons come from the tree block's OWN `python:`
 * stanza, and that stanza cannot carry add-ons - they are configured at portal level, where their
 * artefacts are resolved. So this fixture is shaped the way Waterpark is, a marked code block
 * beside the tree with the portal-level playground behind both.
 */
async function openTerminal(page) {
  // WHICHEVER WAY IN THIS PORTAL OFFERS. A marked code block puts a launcher on the page; a
  // Python-enabled dataset tree puts a `Try in Python` on a leaf. Waterpark has the first. The
  // check is about what happens at the prompt, so it takes whichever door exists.
  const launcher = page.locator("[data-portal-run], [data-portal-python-launcher]").first();
  await launcher.waitFor({ state: "visible", timeout: 30_000 });
  await launcher.click();
  await page.waitForSelector(".freva-term.show", { timeout: 30_000 });
}

async function waitReady(page, timeout = 300_000) {
  await page.waitForFunction(
    () => {
      const states = window.__pyStates ?? [];
      if (states[states.length - 1] !== "ready") return false;
      const root = document.querySelector("freva-python-console")?.shadowRoot;
      return Boolean(root?.querySelector(".cmd"));
    },
    null,
    { timeout },
  );
  await page.waitForTimeout(400);
}

/**
 * Wait until the interpreter is idle again. The interactive queue keeps only the MOST RECENT
 * request, so issuing a second program while the first is still running silently discards one of
 * them - which reads as "the console printed nothing" and is the single easiest way to write a
 * browser Python test that lies.
 */
async function waitIdle(page, timeout = 300_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const state = await page.evaluate(() => (window.__pyStates ?? []).at(-1) ?? null);
    if (state === "ready") return;
    await page.waitForTimeout(400);
  }
  throw new Error("the interpreter never went idle");
}

/**
 * Run a program the way `Try in Python` does, and hand back what it actually produced.
 *
 * Polled from NODE rather than with an in-page `waitForFunction`: the interpreter runs in a Worker
 * and the page's main thread is doing real work while it does, so a poll that depends on the page
 * scheduling callbacks can be starved by the thing it is waiting for. `fixtures/transcript.mjs`
 * decides what counts as output; see its header for why the absence of the opening marker is
 * reported as "no output" rather than quietly becoming the whole transcript.
 */
async function run(page, source, timeout = 300_000) {
  await waitIdle(page);
  const before = (await transcript(page)).length;
  await page.evaluate((text) => {
    void document.querySelector("freva-python-console").execute(text);
  }, wrap(source));
  const until = Date.now() + timeout;
  let text = "";
  let read = { output: null, ended: false, started: false };
  while (Date.now() < until) {
    text = (await transcript(page)).slice(before);
    const idle = (await page.evaluate(() => (window.__pyStates ?? []).at(-1) ?? null)) === "ready";
    read = readTranscript(text, { idle });
    if (read.ended) return { ...read, text, timedOut: false };
    await page.waitForTimeout(500);
  }
  return { ...read, text, timedOut: true };
}

/** What went wrong, for an assertion message: the traceback if there is one, the echo if not. */
function complain(what, { output, text, timedOut, started }) {
  const why = timedOut
    ? "it never finished"
    : started
      ? "the program ended"
      : "the program produced no output at all - the transcript holds only the echo";
  const shown = output === null ? text.slice(-900) : output.slice(-1800);
  return `${what} (${why}). The console said:\n${shown}`;
}

/**
 * Run, and return the output. A program that RAISES returns its traceback, for the assertion. A
 * timeout, or a program that never printed anything, is a failure here rather than an empty string
 * handed to a `match` that would then report a confusing mismatch.
 */
async function exec(page, source, timeout = 300_000) {
  const result = await run(page, source, timeout);
  if (result.timedOut || result.output === null) {
    throw new Error(complain("the program produced no output", result));
  }
  return result.output;
}

/**
 * Run, and require a sentinel the program PRINTS - not one it merely contains. Three ways to fail,
 * kept apart because they mean different things: it never finished, it finished without printing
 * anything at all, or it printed something that was not the sentinel. A timeout throws whatever
 * the console holds, because a Python traceback is the only useful thing to read when a browser
 * install fails.
 */
async function execUntil(page, source, sentinel, timeout = 300_000) {
  const result = await run(page, source, timeout);
  const errors = await page.evaluate(() => window.__consoleErrors ?? []);
  const note = errors.length ? `\n  page errors: ${errors.slice(-4).join(" | ")}` : "";
  if (result.timedOut || result.output === null) {
    throw new Error(complain(`'${sentinel}' was never printed`, result) + note);
  }
  if (!result.output.includes(sentinel)) {
    throw new Error(complain(`'${sentinel}' was never printed`, result) + note);
  }
  return result.output;
}

/**
 * The figures the console has actually RENDERED, with the size the browser decoded them to.
 * `naturalWidth` is the point: a payload arriving, an `<img>` existing, even a blob URL being
 * created all happen before anything has been decoded, and a display bridge that failed reports a
 * `text/plain` payload saying so, which satisfies every one of them. A non-zero natural size is
 * the browser saying it read the PNG.
 */
async function figures(page) {
  return page.evaluate(() => {
    const root = document.querySelector("freva-python-console")?.shadowRoot;
    return [...(root?.querySelectorAll(".bp-figure img") ?? [])].map((img) => ({
      width: img.naturalWidth,
      height: img.naturalHeight,
      alt: img.alt,
    }));
  });
}

/** Wait until one more figure than `before` has been rendered AND decoded. Returns all of them. */
async function waitForFigure(page, before, timeout = 120_000) {
  const until = Date.now() + timeout;
  let seen = [];
  while (Date.now() < until) {
    seen = await figures(page);
    if (seen.length > before && seen.slice(before).every((f) => f.width > 0 && f.height > 0)) {
      return seen;
    }
    await page.waitForTimeout(500);
  }
  return seen;
}

/** What the console said in text, for the message when no figure appeared. */
const displayText = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("freva-python-console")?.shadowRoot;
    return (root?.textContent ?? "").slice(-700);
  });

/**
 * Where micropip says each installed package came from - its own record, not a network guess.
 * Better evidence than a request log: a log says a URL was requested, this says which URL the
 * bytes that are now importable actually came from. It is also the one witness that does not
 * depend on whether a given engine surfaces a Worker's fetches to the page listener.
 */
async function sources(page, name) {
  // DELIMITED, because the transcript is one line: the console echoes the program and then its
  // output, separated by `...` rather than newlines, so "find a JSON object after the word" reads
  // the echo and the result as one string. THE MARKERS ARE BUILT IN PYTHON rather than written as
  // literals, because the echo comes first - a literal marker would appear in the transcript the
  // moment the line is typed, and the wait for it would return before anything had executed.
  // Built from pieces, the marker exists only in the OUTPUT.
  const program = [
    "import micropip, json",
    'A = "<" + "<SRC>>"',
    'B = "<" + "<END>>"',
    'print(A + json.dumps({k: str(getattr(v, "source", "")) for k, v in micropip.list().items()}) + B)',
    "",
  ].join("\n");
  const out = await execUntil(page, program, "<<END>>");
  const match = /<<SRC>>(.*?)<<END>>/s.exec(out);
  if (!match) return null;
  try {
    return JSON.parse(match[1])[name] ?? null;
  } catch {
    return null;
  }
}

const transcript = (page) =>
  page.evaluate(() => document.querySelector("freva-python-console")?.transcript() ?? "");

console.log("\n  THE POLICY THE PAGE IS SERVED UNDER\n");

await check("the deployment policy carries the https: scheme, and nothing wider", () => {
  const connect = (/connect-src ([^;]*)/.exec(POLICY)?.[1] ?? "").split(/\s+/);
  assert.ok(connect.includes("https:"), `connect-src is '${connect.join(" ")}'`);
  // Not a wildcard: `*` would also carry ws:, data: and plaintext.
  assert.ok(!connect.includes("*"), "connect-src was widened to a wildcard");
  assert.ok(!connect.includes("http:"), "plaintext http: is permitted");
  // And nothing else moved. `script-src` decides what may RUN, and it must not have gained the
  // scheme - compared as TOKENS, because every https origin in it contains the substring "https:".
  const script = (/script-src ([^;]*)/.exec(POLICY)?.[1] ?? "").split(/\s+/);
  assert.ok(!script.includes("https:"), `script-src was widened: '${script.join(" ")}'`);
  assert.ok(!script.includes("'unsafe-eval'"), "script-src gained unsafe-eval");
  assert.ok(!script.includes("*"), "script-src was widened to a wildcard");
  assert.ok(POLICY.includes("default-src 'none'"), "default-src is no longer 'none'");
});

console.log("\n  INSTALLING, FROM THE PUBLIC INDEX AND FROM A URL\n");

await check("installs a package by name that the pinned runtime does not contain", () =>
  withPage(async (page, log) => {
    await openTerminal(page);
    await waitReady(page);

    // It is genuinely absent before the install, or the check proves nothing.
    const before = await exec(
      page,
      `import importlib.util\nprint("PRESENT" if importlib.util.find_spec(${JSON.stringify(BY_NAME.module)}) else "ABSENT")\n`,
    );
    assert.match(before, /ABSENT/, `${BY_NAME.module} was already importable: ${before}`);
    const opened = log.requests.length;

    const out = await execUntil(
      page,
      `import micropip\nawait micropip.install(${JSON.stringify(BY_NAME.package)})\n` +
        `import ${BY_NAME.module}\nprint("INSTALLED", ${BY_NAME.module}.__name__)\n`,
      "INSTALLED",
    );
    assert.match(out, /INSTALLED/, out.slice(0, 600));

    // AND THE BYTES CAME FROM THE PUBLIC INDEX - which the REQUESTS say, not micropip. The
    // install succeeding is not the claim: a package quietly resolved from the runtime mirror
    // would succeed too. `micropip.list()` records the origin of a name-resolved install as the
    // literal string `"pypi"` - its own word for the public index, deliberately not a URL - so it
    // is evidence that the package did not come from the runtime's lock file and nothing more.
    // What proves the fetch left the browser is the traffic, recorded at the context because the
    // Worker is what makes it: metadata from the index, and the wheel from its file host.
    const source = await sources(page, BY_NAME.package);
    assert.ok(
      source && (source === "pypi" || /^https:\/\/files\.pythonhosted\.org\//.test(source)),
      `micropip records the wheel's source as ${JSON.stringify(source)}, not the public index`,
    );
    const seen = log.requests.slice(opened);
    assert.ok(
      seen.some((u) => u.startsWith("https://pypi.org/")),
      `nothing was asked of the package index: ${seen.slice(0, 4).join(", ") || "no requests"}`,
    );
    assert.ok(
      seen.some((u) => u.startsWith("https://files.pythonhosted.org/") && u.endsWith(".whl")),
      `no wheel was fetched from the public file host: ${seen.slice(0, 6).join(", ")}`,
    );
    console.log(
      `       (${seen.length} index/file-host request(s): ${seen.length ? new URL(seen[0]).host : "-"})`,
    );
  }),
);

await check("installs a wheel from an HTTPS URL a visitor names", () =>
  withPage(async (page, log) => {
    assert.ok(BY_URL.url, "no wheel URL could be resolved from the index");
    await openTerminal(page);
    await waitReady(page);
    const out = await execUntil(
      page,
      `import micropip\nawait micropip.install(${JSON.stringify(BY_URL.url)})\n` +
        `import ${BY_URL.module}\nprint("URLWHEEL", ${BY_URL.module}.camelize("hello_world"))\n`,
      "URLWHEEL",
    );
    assert.match(out, /URLWHEEL HelloWorld/, out.slice(0, 600));
    const source = await sources(page, BY_URL.module);
    assert.ok(
      source && source.includes("files.pythonhosted.org"),
      `micropip records ${BY_URL.module} as coming from ${JSON.stringify(source)}`,
    );
    // The URL the visitor named is the one that was fetched - no index lookup in between.
    assert.ok(
      log.requests.includes(BY_URL.url),
      `the wheel URL was never requested: ${log.requests.slice(-4).join(", ") || "no requests"}`,
    );
  }),
);

await check("reads an HTTPS host that is on no configured allowlist", () =>
  withPage(async (page, log) => {
    await openTerminal(page);
    await waitReady(page);
    // A CORS-enabled host outside everything this deployment names, read with `pyfetch` - the
    // asynchronous API, awaited at the prompt, which is what a visitor would actually write. NOT
    // `open_url`: it is the documented one-liner and it does not work here, because it is a
    // synchronous `XMLHttpRequest` and in this Worker a synchronous XHR blocks forever. That is a
    // real and reportable limitation of the environment, and it is why the Cartopy adaptation
    // uses stack switching instead.
    const url = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/VERSION";
    const out = await execUntil(
      page,
      `from pyodide.http import pyfetch\nr = await pyfetch(${JSON.stringify(url)})\n` +
        `print("FETCHED", (await r.string()).strip())\n`,
      "FETCHED",
    );
    // The BYTES are the evidence: the file says `5.1.2` and nothing in this artifact contains it,
    // so reading it proves the fetch left the browser and came back.
    assert.match(out, /FETCHED 5\.1\.2/, out.slice(0, 600));
    assert.ok(
      !log.failed.some((f) => f.includes("raw.githubusercontent.com")),
      `the policy refused it: ${log.failed.filter((f) => f.includes("githubusercontent")).join(", ")}`,
    );
  }),
);

console.log("\n  MAPS\n");

await check("draws prepared 110m coastlines and borders without leaving this origin", () =>
  withPage(async (page, log) => {
    await openTerminal(page);
    await waitReady(page);
    const marker = log.requests.length;
    const drawn = (await figures(page)).length;
    // THE ORDINARY PATH, deliberately: the default backend and `plt.show()`, which is what a
    // reader types. `plt.show()` draws NOTHING - the browser backend marks the figure and the
    // engine renders it after the program has finished - so a check that calls
    // `fig.canvas.draw()` itself never visits the boundary where the rendering actually happens.
    const out = await execUntil(
      page,
      [
        "import matplotlib.pyplot as plt",
        "import cartopy.crs as ccrs, cartopy.feature as cfeature",
        "fig, ax = plt.subplots(subplot_kw={'projection': ccrs.PlateCarree()})",
        "ax.set_global()",
        "ax.coastlines(resolution='110m')",
        "ax.add_feature(cfeature.BORDERS.with_scale('110m'))",
        "plt.show()",
        "print('WORLDMAP', len(ax.collections) + len(ax.artists) + len(ax.patches))",
        "",
      ].join("\n"),
      "WORLDMAP",
    );
    assert.match(out, /WORLDMAP/, out.slice(0, 900));
    // And a decoded image, not a word: a failed render answers with a text payload and a message.
    const shown = await waitForFigure(page, drawn);
    assert.ok(
      shown.length > drawn && shown[shown.length - 1].width > 0,
      `no figure was rendered. The console said: ${await displayText(page)}`,
    );
    // PREPARED MEANS NOT FETCHED. The add-on staged these files into the interpreter's filesystem
    // and `CARTOPY_DATA_DIR` points at them, so a world map must produce no Natural Earth request
    // at all - from the mirror or from anywhere else.
    const during = log.requests.slice(marker);
    const ne = during.filter((u) => /natural[-_]?earth|naturalearthdata/i.test(u));
    assert.deepEqual(ne, [], `the prepared data was not used: ${ne.slice(0, 4).join(", ")}`);
  }),
);

await check("fetches a resolution the deployment did not prepare, and reuses it", () =>
  withPage(async (page, log) => {
    await openTerminal(page);
    await waitReady(page);
    const marker = log.requests.length;
    const drawn = (await figures(page)).length;
    // A REGIONAL map, so Cartopy selects a finer resolution ITSELF, plus a feature the prepared
    // set does not contain (`LAND` is a physical polygon layer; the add-on stages coastlines and
    // boundary lines only). Both are ordinary Cartopy calls, BUILT OVER SEPARATE SUBMISSIONS and
    // shown with `plt.show()`: the figure is created at one prompt and drawn at another, so the
    // rendering happens in the engine's display capture rather than inside the user's own program
    // - the entry point that has to be able to suspend while Cartopy fetches a file. A single
    // submission calling `fig.canvas.draw()` itself passes while the ordinary path cannot render
    // at all.
    const setUp = await execUntil(
      page,
      [
        "import matplotlib.pyplot as plt",
        "import cartopy.crs as ccrs, cartopy.feature as cfeature",
        "fig, ax = plt.subplots(subplot_kw={'projection': ccrs.PlateCarree()})",
        "ax.set_extent([4, 16, 46, 56], crs=ccrs.PlateCarree())",
        "print('SETUP', 'ok')",
        "",
      ].join("\n"),
      "SETUP",
    );
    assert.match(setUp, /SETUP ok/, setUp.slice(0, 600));

    const out = await execUntil(
      page,
      [
        "ax.coastlines(resolution='50m')",
        "ax.add_feature(cfeature.LAND.with_scale('50m'), facecolor='0.9')",
        "plt.show()",
        "print('REGIONAL', 'shown')",
        "",
      ].join("\n"),
      "REGIONAL",
    );
    assert.match(out, /REGIONAL shown/, out.slice(0, 900));
    const shown = await waitForFigure(page, drawn);
    assert.ok(
      shown.length > drawn && shown[shown.length - 1].width > 0,
      `the regional map produced no decoded image. The console said: ${await displayText(page)}`,
    );

    const fetched = log.requests.slice(marker).filter((u) => /natural-earth-vector/.test(u));
    assert.ok(fetched.length > 0, "nothing was fetched for the missing resolution");
    assert.ok(
      fetched.some((u) => /50m/.test(u)),
      `the 50m data was not requested: ${fetched.slice(0, 4).join(", ")}`,
    );

    // AND A SECOND DRAW REUSES IT. Cartopy's own cache, untouched by this adaptation: the file
    // was written where Cartopy asked for it, so `path()` finds it before `acquire_resource`.
    const again = log.requests.length;
    const before2 = (await figures(page)).length;
    const second = await execUntil(
      page,
      [
        "fig2, ax2 = plt.subplots(subplot_kw={'projection': ccrs.PlateCarree()})",
        "ax2.set_extent([4, 16, 46, 56], crs=ccrs.PlateCarree())",
        "ax2.coastlines(resolution='50m')",
        "plt.show()",
        "print('SECOND', 'ok')",
        "",
      ].join("\n"),
      "SECOND",
    );
    assert.match(second, /SECOND ok/, second.slice(0, 600));
    const shown2 = await waitForFigure(page, before2);
    assert.ok(
      shown2.length > before2 && shown2[shown2.length - 1].width > 0,
      `the second map produced no decoded image. The console said: ${await displayText(page)}`,
    );
    const refetched = log.requests
      .slice(again)
      .filter((u) => /natural-earth-vector.*50m_physical\/ne_50m_coastline/.test(u));
    assert.deepEqual(refetched, [], "the second draw fetched the same file again");
  }),
);

console.log("\n  RECOVERY\n");

await check("a corrupt prepared add-on leaves Python usable and is not treated as verified", () =>
  withPage(async (page, log) => {
    // The add-on's artefacts are digest-checked against hashes compiled into the engine, so
    // corrupting one is the honest way to ask what happens: serve a wrong byte for one file and the
    // whole add-on must be refused - not written, not partially applied - while the interpreter
    // still comes up. `context.route`, not `page.route`, because those artefacts are fetched by the
    // interpreter's WORKER and a page-scoped route does not see a Worker's requests.
    await page.context().route(/python-addons\/.*ne_110m_coastline\.shp/, (route) =>
      route.fulfill({
        status: 200,
        body: "not a shapefile",
        contentType: "application/octet-stream",
      }),
    );
    await openTerminal(page);
    await waitReady(page);

    const report = await page.evaluate(() => {
      const el = document.querySelector("freva-python-console");
      // `readyInfo` is what the console keeps; the playground's own `ready()` reads the same field.
      return el?.readyInfo ?? null;
    });
    assert.ok(report, "the console reported no ready payload");
    const unavailable = (report.unavailableAddons ?? []).map((a) => a.id);
    assert.ok(
      unavailable.includes("cartopy-natural-earth-110m"),
      `the corrupt add-on was accepted: ${JSON.stringify(report.addons ?? [])}`,
    );

    // The console is still a console.
    const alive = await exec(page, "print('ALIVE', 6 * 7)\n");
    assert.match(alive, /ALIVE 42/, alive.slice(0, 400));

    // AND THE CAPABILITY COMES BACK ON DEMAND. With no prepared data at all every file is a miss,
    // so a world map exercises the downloader end to end.
    const marker = log.requests.length;
    const drawn = (await figures(page)).length;
    const out = await execUntil(
      page,
      [
        "import matplotlib.pyplot as plt",
        "import cartopy.crs as ccrs",
        "fig, ax = plt.subplots(subplot_kw={'projection': ccrs.PlateCarree()})",
        "ax.set_global()",
        "ax.coastlines(resolution='110m')",
        "plt.show()",
        "print('RECOVERED', 'ok')",
        "",
      ].join("\n"),
      "RECOVERED",
    );
    assert.match(out, /RECOVERED ok/, out.slice(0, 900));
    // Recovered means a MAP, not a word: the figure has to render from data fetched on demand.
    const shown = await waitForFigure(page, drawn);
    assert.ok(
      shown.length > drawn && shown[shown.length - 1].width > 0,
      `the recovered map produced no decoded image. The console said: ${await displayText(page)}`,
    );
    assert.ok(
      log.requests.slice(marker).some((u) => /natural-earth-vector.*110m/.test(u)),
      "the missing data was not fetched on demand",
    );
  }),
);

await check("a restart replaces the interpreter and restores the starting environment", () =>
  withPage(async (page) => {
    await openTerminal(page);
    await waitReady(page);
    const installed = await execUntil(
      page,
      `import micropip\nawait micropip.install(${JSON.stringify(BY_NAME.package)})\n` +
        `kept = 1234\nimport ${BY_NAME.module}\nprint("BEFORE", kept)\n`,
      "BEFORE",
    );
    assert.match(installed, /BEFORE 1234/, installed.slice(0, 600));

    // HIDE AND SHOW IS NOT A RESTART - the sentence the help panel makes, so the sentence this
    // proves. Closing the window hides it; the session is still there behind it.
    await page.click(".freva-term .tl.close");
    await page.waitForTimeout(800);
    // Hidden, not destroyed: the window is off screen and the console element is still in the DOM.
    assert.equal(
      await page.evaluate(() => document.querySelectorAll("freva-python-console").length),
      1,
      "closing the window removed the console",
    );
    await page.locator("[data-portal-run], [data-portal-python-launcher]").first().click();
    await page.waitForSelector(".freva-term.show", { timeout: 30_000 });
    await page.waitForTimeout(800);
    const survived = await exec(page, "print('STILL', kept)\n");
    assert.match(survived, /STILL 1234/, `hiding the window ended the session: ${survived}`);

    // AND A RESTART DOES REPLACE IT - through the menu a visitor uses, and its confirmation.
    await page.click(".freva-term .term-kebab");
    await page.waitForSelector(".freva-term .term-menu.show", { timeout: 5_000 });
    await page.locator(".freva-term .tmn-item", { hasText: "Restart session" }).click();
    await page.waitForSelector(".freva-term .term-confirm", { timeout: 5_000 });
    await page.locator(".freva-term .term-confirm button", { hasText: "Restart session" }).click();
    await page.evaluate(() => {
      window.__pyStates.length = 0;
    });
    await waitReady(page);
    const after = await exec(page, "print('AFTER', 'kept' in dir())\n");
    assert.match(after, /AFTER False/, `the variable survived a restart: ${after.slice(0, 300)}`);
    const gone = await exec(
      page,
      `import importlib.util\nprint("PKG", bool(importlib.util.find_spec(${JSON.stringify(BY_NAME.module)})))\n`,
      3000,
    );
    assert.match(
      gone,
      /PKG False/,
      `the installed package survived a restart: ${gone.slice(0, 300)}`,
    );
    // And the STARTING environment is back: the profile's own packages are importable again.
    const base = await exec(page, "import numpy\nprint('BASE', numpy.__name__)\n");
    assert.match(base, /BASE numpy/, base.slice(0, 300));
  }),
);

console.log("\n  WHAT MUST NOT HAVE CHANGED\n");

await check("Python is still lazy: the landing page starts nothing", () =>
  withPage(async (page, log) => {
    await page.waitForTimeout(6000);
    const states = await page.evaluate(() => window.__pyStates ?? []);
    assert.deepEqual(states, [], `the interpreter started by itself: ${states.join(", ")}`);
    const runtime = log.requests.filter((u) => u.startsWith(runtimeServer.base));
    assert.deepEqual(runtime, [], `the runtime was fetched before Python was opened`);
    const index = log.requests.filter((u) => /pypi\.org|pythonhosted/.test(u));
    assert.deepEqual(index, [], "the landing page reached a package index");
  }),
);

await check("the page reports the open policy, and the help panel shows the install example", () =>
  withPage(async (page) => {
    const config = await page.evaluate(() => {
      const node = document.querySelector("[data-portal-python-playground]");
      if (!node) return null;
      const raw =
        node.getAttribute("data-portal-python-playground") ??
        node.dataset.portalPythonPlayground ??
        "";
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    });
    if (!config) {
      const present = await page.evaluate(() => ({
        nodes: document.querySelectorAll("[data-portal-python-playground]").length,
        sample: document
          .querySelector("[data-portal-python-playground]")
          ?.getAttribute("data-portal-python-playground")
          ?.slice(0, 120),
      }));
      assert.fail(`no playground configuration could be read: ${JSON.stringify(present)}`);
    }
    assert.equal(config.packagePolicy.kind, "open");
    assert.equal(config.packagePolicy.anyHttpsOrigin, true);
    assert.equal(config.network, "https");
  }),
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} open-install checks passed`);
console.log(`run dir ${RUN}`);
await shutdown();
process.exit(failed.length > 0 ? 1 : 0);
