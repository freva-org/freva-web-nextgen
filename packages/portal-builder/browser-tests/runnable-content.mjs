// Runnable documentation, with a REAL interpreter, on real origins.
//
// `runnable-content.test.ts` reads the artifact; this reads the browser. An id, a digest and a
// button in a file prove that a build registered something, and prove nothing at all about
// whether pressing it runs the snippet the reader was looking at.
//
// The interpreter is deliberately not mocked. The runtime is the pinned distribution in
// `packages/browser-python/.runtime`, served over TLS from its own origin and named by
// `runtimeIndexUrl` - the option a deployment that mirrors Pyodide uses. A checkout without that
// directory SKIPS rather than pretending.
//
// Usage:  node browser-tests/runnable-content.mjs
//         FREVA_ONLY="<substring>" node browser-tests/runnable-content.mjs

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
const RUN = mkdtempSync(join(tmpdir(), `runnable-${Date.now()}-`));
const ONLY = process.env.FREVA_ONLY;

const HOSTS = {
  portal: "docs.example.org",
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

if (!existsSync(join(RUNTIME, "pyodide.js"))) skip(`no local Pyodide runtime at ${RUNTIME}`);
if (!existsSync(join(ADDONS, "MANIFEST.json"))) {
  skip(
    `no prepared add-on directory at ${ADDONS}. Make one with ` +
      "`node bin/freva-browser-python.mjs prepare-addons --out .addons` in packages/browser-python.",
  );
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  skip(`playwright is not installed: ${error.message}`);
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Mark</title><rect width="16" height="16" fill="#123456"/></svg>`;

/**
 * A WHOLE BLOCK with blank lines in it, which is the case a line-by-line REPL gets wrong. Typed
 * into a prompt one line at a time, the blank line ends the `for` suite and `total` is either 0
 * or a NameError. `sum 6` is what tells file semantics from prompt semantics.
 */
const BLOCK = [
  "total = 0",
  "",
  "for i in range(4):",
  "    total += i",
  "",
  "print('sum', total)",
  "",
].join("\n");
const SECOND = ["print('carried', total * 2)", ""].join("\n");

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
    "content/guide.md",
    "---\ntitle: Guide\n---\n\n# Guide\n\nRead this, then run it.\n\n" +
      '```python try-in-python title="totals.py"\n' +
      BLOCK +
      "```\n\nAnd a second one, which shares the same interpreter.\n\n" +
      "```python try-in-python\n" +
      SECOND +
      "```\n\nA block nobody may run:\n\n```bash\nls\n```\n",
  );
  if (options.dask) {
    // THE PORTAL'S HALF OF THE CLAIM, and only that half: that an add-on named in a PAGE's
    // configuration reached the interpreter that page opened, and that it arrived configured - the
    // scheduler is the add-on's promise, not a default. The xarray + Zarr + Dask numerics belong to
    // `@freva-org/browser-python`'s own `browser-tests/addons.mjs`, against the committed store and
    // this same pinned runtime. They are not repeated here because the first `import dask.array`
    // plus the first dask-backed compute takes four to seven minutes on this machine: a gate that
    // slow measures the host, and a flaky gate teaches a team to ignore red CI.
    put(
      "content/dask.md",
      "---\ntitle: Dask\n---\n\n# Dask\n\n" +
        "```python try-in-python\n" +
        "import dask\n" +
        "print('scheduler', dask.config.get('scheduler'))\n" +
        "print('version', dask.__version__)\n" +
        "```\n",
    );
  }

  put(
    "landings/home.yaml",
    "schemaVersion: 1\ntitle: Runnable docs\nblocks:\n  - type: hero\n    heading: Docs\n",
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: runnable-${name}
  title: Runnable docs
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
  profile: ${options.profile ?? "minimal"}
${options.addons ? `  addons:\n${options.addons.map((a) => `    - ${a}\n`).join("")}` : ""}  autostart: never
  maxSessions: 2
${options.playgroundOrigin ? `  playgroundOrigin: ${options.playgroundOrigin}\n` : ""}  runtimeIndexUrl: ${options.runtimeIndexUrl}
${options.addonBaseUrl ? `  addonBaseUrl: ${options.addonBaseUrl}\n` : ""}  terminal:
    style: freva-client-terminal
    osControls: linux
    alwaysOnTop: true
    rememberAppearance: false
`,
  );
  const out = join(RUN, `${name}-built`);
  execFileSync(
    process.execPath,
    // prettier-ignore
    [join(PKG, "bin", "freva-portal-builder.mjs"), "build", "--source-root", src,
     "--config", join(src, "portal.yaml"), "--out", out, "--quiet"],
    { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
  );
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
      `  FAIL ${name}\n       ${String(error.message).split("\n").slice(0, 6).join("\n       ")}`,
    );
  }
}

let browser;

try {
  const tls = certificate(join(RUN, "tls"), Object.values(HOSTS));
  for (const dir of ["portal", "child", "framed", "tampered"]) {
    mkdirSync(join(RUN, dir), { recursive: true });
  }
  const runtimeS = await serveTls(tls, HOSTS.runtime, {
    dir: RUNTIME,
    headers: { "access-control-allow-origin": "*" },
  });
  const portalS = await serveTls(tls, HOSTS.portal, { dir: join(RUN, "portal"), headers: {} });
  const childS = await serveTls(tls, HOSTS.child, { dir: join(RUN, "child"), headers: {} });
  // ALLOCATED BEFORE ITS ARTIFACT IS BUILT, like every other origin here. The framed build
  // compiles its own canonical origin into the child's `frame-ancestors`; built against a
  // different port than the one it is served from, the browser refuses to frame the child and
  // every framed check fails at its own timeout with nothing to read.
  const framedS = await serveTls(tls, HOSTS.portal, { dir: join(RUN, "framed"), headers: {} });

  // The add-on directory and the Zarr fixture are served from the PORTAL's own origin, which is
  // where a deployment that copies them beside its artifact puts them - so `connect-src 'self'`
  // is what permits them, with nothing widened for the test's convenience.
  const addonTarget = join(RUN, "portal", "python-addons");
  cpSync(ADDONS, addonTarget, { recursive: true });
  cpSync(
    join(REPO, "packages", "browser-python", "tests", "fixtures", "zarr-v3"),
    join(RUN, "portal", "fixtures", "zarr-v3"),
    { recursive: true },
  );

  const built = buildSite("local", {
    canonical: portalS.base,
    runtimeIndexUrl: runtimeS.base,
    profile: "xarray-zarr",
    addons: ["dask"],
    addonBaseUrl: `${portalS.base}python-addons/`,
    dask: true,
    zarrUrl: `${portalS.base}fixtures/zarr-v3/`,
  });
  cpSync(built, join(RUN, "portal"), { recursive: true });
  portalS.state.headers = { "content-security-policy": portalPolicy(built) };

  // A COPY OF THE SAME ARTIFACT with one snippet edited after the build, served from its own
  // port. Not an intercepted response: Playwright's own fetch does not use the browser's
  // host-resolver rules, so a route handler that re-fetches one of these origins fails at DNS. A
  // second server over the same certificate changes the bytes on disk after the build, which is
  // exactly the situation the digest exists to notice.
  cpSync(built, join(RUN, "tampered"), { recursive: true });
  const tamperedGuide = join(RUN, "tampered", "docs", "guide", "index.html");
  writeFileSync(
    tamperedGuide,
    readFileSync(tamperedGuide, "utf8").replace("total = 0", "total = 99"),
  );
  const tamperedS = await serveTls(tls, HOSTS.portal, { dir: join(RUN, "tampered"), headers: {} });
  tamperedS.state.headers = { "content-security-policy": portalPolicy(built) };

  const framedBuilt = buildSite("framed", {
    canonical: framedS.base,
    runtimeIndexUrl: runtimeS.base,
    playgroundOrigin: childS.origin,
  });
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
  cpSync(framedBuilt, join(RUN, "framed"), { recursive: true });
  framedS.state.headers = { "content-security-policy": portalPolicy(framedBuilt) };

  console.log(`portal ${portalS.origin} · child ${childS.origin} · runtime ${runtimeS.origin}`);
  console.log(`run dir ${RUN}`);

  browser = await chromium.launch({
    args: chromiumArgs(Object.values(HOSTS)),
    executablePath: process.env.FREVA_PORTAL_CHROMIUM ?? "/opt/pw-browsers/chromium",
  });

  /**
   * A page, in a browser of its own. Each check here brings up a COLD Pyodide interpreter - a
   * WASM heap of several hundred megabytes - and Chromium does not hand that back when a context
   * closes; measured, a check that passes alone becomes unreliable as the fourth interpreter in
   * one browser process, in a way that looks exactly like a product that hangs. So the expensive
   * checks get their own process, which costs a launch and buys a result that means something.
   */
  async function withFreshBrowser(url, fn) {
    const own = await chromium.launch({
      args: chromiumArgs(Object.values(HOSTS)),
      executablePath: process.env.FREVA_PORTAL_CHROMIUM ?? "/opt/pw-browsers/chromium",
    });
    const previous = browser;
    browser = own;
    try {
      await withPage(url, fn);
    } finally {
      browser = previous;
      await own.close();
    }
  }

  async function withPage(url, fn) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) =>
        (window.__csp ??= []).push(e.effectiveDirective),
      );
    });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector(".portal-code-figure", { timeout: 20_000 });
      await fn(page, { problems, violations: () => page.evaluate(() => window.__csp ?? []) });
    } finally {
      await context.close();
    }
  }

  const transcript = (page) =>
    page.evaluate(() => {
      const root = document.querySelector("freva-python-console")?.shadowRoot;
      return [...(root?.querySelectorAll(".terminal-output") ?? [])]
        .map((n) => n.textContent)
        .join("\n");
    });

  // the dask add-on
  //
  // FIRST, and in a browser of its own: this is the heaviest interpreter in the file - the
  // profile's seventeen wheels plus three from the add-on directory - so it gets a cold browser
  // and the first slot, and the generous waits below are sized for it. Position and a fresh
  // browser are there because a heavy interpreter deserves them, not because they fix anything.

  await check("the Dask add-on reaches a documentation page's interpreter", () =>
    withFreshBrowser(`${portalS.base}docs/dask/`, async (page, ctx) => {
      await page.click(".portal-code-run");
      await page.waitForSelector(".freva-term.show", { timeout: 30_000 });
      await page
        .waitForFunction(
          // WAIT FOR THE ANSWER, NOT FOR THE QUESTION. Waiting for `"version"` would resolve the
          // moment the console draws the command back, because the echoed source contains
          // `print('version', dask.__version__)` - before the interpreter has run a line of it,
          // leaving the assertions below to race the round trip. `scheduler synchronous` cannot
          // appear in the echo, because the echo does not contain the VALUE.
          () =>
            (
              document.querySelector("freva-python-console")?.shadowRoot?.textContent ?? ""
            ).includes("scheduler synchronous"),
          null,
          // GENEROUS, because what is asserted is behaviour and not speed. A cold interpreter
          // here is a Pyodide download, seventeen wheels, three more from the add-on directory
          // and a REPL, which on a loaded machine takes several minutes. A wait tight enough to
          // fail under load reports the host as a product defect.
          { timeout: 600_000 },
        )
        .catch(() => undefined);
      const text = await transcript(page);
      if (process.env.FREVA_DUMP) console.log("\n--- transcript ---\n" + text.slice(-3000));
      // VALUES, and the ones the fixture was generated from - not "it produced floats". The
      // whole contract in one run: an add-on the PAGE configured reached the interpreter the page
      // opened, xarray found a Dask chunk manager, the store was read over HTTP from the portal's
      // own origin under the artifact's own policy, and a bounded `.compute()` returned the right
      // numbers. It is slow - a first Zarr read through a WebAssembly stack switch is - which is
      // why the wait is generous rather than optimistic.
      assert.ok(text.includes("scheduler synchronous"), text.slice(-600));
      assert.ok(/version 20\d\d\./.test(text), text.slice(-600));
      assert.deepEqual(await ctx.violations(), [], "the page's own policy refused something");
    }),
  );

  // BEFORE the two checks that break things on purpose. "Copy still works when the interpreter
  // cannot start" aborts every request to the runtime origin, and "a page whose source was
  // edited" serves a byte-edited artifact. Both are contained in their own browser context, and
  // this check is nevertheless unreliable after them - reliably passing alone, reliably timing
  // out in sequence - so it sits where it does not depend on a cause nobody has found.
  await check("focus returns to the button that opened the window", () =>
    withPage(`${portalS.base}docs/guide/`, async (page) => {
      await page.focus(".portal-code-figure:first-of-type .portal-code-run");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".freva-term.show", { timeout: 30_000 });
      await page.click(".freva-term .tl.close");
      await page.waitForTimeout(300);
      const focused = await page.evaluate(() => document.activeElement?.className ?? "");
      assert.ok(focused.includes("portal-code-run"), `focus went to '${focused}'`);
    }),
  );

  await check("a page whose source was edited after the build refuses to run it", () =>
    withPage(`${tamperedS.base}docs/guide/`, async (page) => {
      // The tampered copy control no longer hashes to the digest the build recorded, so the
      // control it belongs to is never enabled - while Copy, which needs no verification, is.
      const state = await page.evaluate(() => ({
        copy: document.querySelectorAll(".portal-code-copy:not([hidden])").length,
        run: document.querySelectorAll(".portal-code-run:not([hidden])").length,
      }));
      assert.equal(state.copy, 3, JSON.stringify(state));
      assert.equal(state.run, 1, `a tampered snippet was still runnable: ${JSON.stringify(state)}`);
    }),
  );

  await check("Copy still works when the interpreter cannot start", () =>
    withPage(`${portalS.base}docs/guide/`, async (page) => {
      await page.route("**/runtime.example.org/**", (route) => route.abort());
      await page.click(".portal-code-figure:first-of-type .portal-code-run");
      await page.waitForTimeout(2_000);
      const copied = await page.evaluate(async () => {
        const button = document.querySelector(".portal-code-copy");
        button.click();
        await new Promise((done) => setTimeout(done, 200));
        return button.getAttribute("data-state");
      });
      assert.ok(copied === "copied" || copied === "failed", `copy did nothing: ${copied}`);
    }),
  );

  // same origin

  await check("a runnable snippet draws Copy and Try, and only the marked one does", () =>
    withPage(`${portalS.base}docs/guide/`, async (page) => {
      const figures = await page.evaluate(() =>
        [...document.querySelectorAll(".portal-code-figure")].map((figure) => ({
          language: figure.getAttribute("data-portal-code"),
          copy: Boolean(figure.querySelector(".portal-code-copy:not([hidden])")),
          run: Boolean(figure.querySelector(".portal-code-run:not([hidden])")),
          order: [...figure.querySelectorAll("button")].map((b) => b.className),
        })),
      );
      assert.equal(figures.length, 3, JSON.stringify(figures));
      assert.deepEqual(
        figures.map((f) => [f.language, f.copy, f.run]),
        [
          ["python", true, true],
          ["python", true, true],
          ["bash", true, false],
        ],
        JSON.stringify(figures),
      );
      // Copy first, Try second, in the document's own order.
      assert.deepEqual(figures[0].order, ["portal-code-copy", "portal-code-run"]);
    }),
  );

  await check("pressing Try runs the WHOLE block, blank lines and all", () =>
    withPage(`${portalS.base}docs/guide/`, async (page, ctx) => {
      await page.click(".portal-code-figure:first-of-type .portal-code-run");
      await page.waitForSelector(".freva-term.show", { timeout: 30_000 });
      await page.waitForFunction(
        () =>
          (document.querySelector("freva-python-console")?.shadowRoot?.textContent ?? "").includes(
            "sum 6",
          ),
        null,
        { timeout: 300_000 },
      );
      const text = await transcript(page);
      assert.ok(text.includes("sum 6"), text.slice(-400));
      // THE TITLE IS NOT IN THE TRANSCRIPT. A transcript is something visitors COPY, and a
      // `── totals.py ──` line is not Python: selecting a worked example, pasting it back and
      // running it would fail on a line the console had written into their program. The title is
      // already on the page, on the figure the button belongs to. What the check is about is that
      // the WHOLE block ran, blank lines and all, which `sum 6` proves - line-by-line submission
      // closes the `for` on the blank line and raises IndentationError instead.
      assert.ok(!text.includes("totals.py"), text.slice(-400));
      assert.ok(!text.includes("\u2500\u2500"), text.slice(-400));
      assert.deepEqual(await ctx.violations(), [], "the page's own policy refused something");
      assert.deepEqual(ctx.problems, []);
    }),
  );

  await check("two snippets on one page share one interpreter", () =>
    withPage(`${portalS.base}docs/guide/`, async (page) => {
      const runs = await page.$$(".portal-code-run");
      await runs[0].click();
      await page.waitForFunction(
        () =>
          (document.querySelector("freva-python-console")?.shadowRoot?.textContent ?? "").includes(
            "sum 6",
          ),
        null,
        { timeout: 300_000 },
      );
      // Dispatched on the element rather than at its coordinates: the terminal window is open
      // over the page by now, and what is under test is one interpreter for two snippets, not
      // whether a window a visitor would have moved happens to sit on top of a button.
      await runs[1].evaluate((button) => button.click());
      if (process.env.FREVA_DUMP) {
        await page.waitForTimeout(20_000);
        console.log("\n--- transcript ---\n" + (await transcript(page)).slice(-2000));
      }
      await page.waitForFunction(
        () =>
          (document.querySelector("freva-python-console")?.shadowRoot?.textContent ?? "").includes(
            "carried 12",
          ),
        null,
        { timeout: 60_000 },
      );
      // One window, one console: the second snippet saw the first one's variable.
      assert.equal(await page.locator("freva-python-console").count(), 1);
    }),
  );

  // separate origin

  await check("a press in the portal runs in the child's real interpreter", () =>
    withPage(`${framedS.base}docs/guide/`, async (page) => {
      await page.click(".portal-code-figure:first-of-type .portal-code-run");
      await page.waitForSelector(".freva-term.show", { timeout: 30_000 });
      const frame = await (
        await page.waitForSelector("iframe", { timeout: 30_000 })
      ).contentFrame();
      await frame.waitForFunction(
        () =>
          (document.querySelector("freva-python-console")?.shadowRoot?.textContent ?? "").includes(
            "sum 6",
          ),
        null,
        { timeout: 300_000 },
      );
      // The parent never had one: the interpreter is the child's.
      assert.equal(await page.locator("freva-python-console").count(), 0);
    }),
  );

  await check("the child's manifest owns the sources, and the parent ships none", () => {
    const manifest = readFileSync(join(RUN, "child", "index.html"), "utf8");
    assert.ok(manifest.includes("playground-examples"), "no manifest in the child");
    assert.ok(manifest.includes("print('sum', total)"), "the child does not carry the source");
    const parent = readFileSync(join(RUN, "framed", "docs", "guide", "index.html"), "utf8");
    assert.ok(parent.includes("data-portal-example="), "the parent lost its identities");
    // The parent's copy control has the source because the author wrote it there; what it must not
    // have is a second, executable copy addressed to the child.
    assert.ok(!parent.includes("playground-examples"), "the parent carries the child's manifest");
    return Promise.resolve();
  });
} catch (error) {
  console.error(error);
  results.push({ name: "the suite ran at all", ok: false });
} finally {
  await browser?.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} runnable-content checks passed`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
