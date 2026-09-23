// The recipe the panel shows, run against a real store, in a real interpreter.
//
// The rule the restored panel has to keep is uncomfortable to test: every Python tab presented in
// the browser must be EXECUTABLE by the configured profile, and no tab may carry a run control
// for code whose dependencies are absent. A component test can prove a button exists; a stubbed
// console can prove it sends the right id. Neither can prove that `xr.open_dataset(url,
// engine="zarr")` opens anything, because that depends on Pyodide's wheels, the store's format,
// the gateway's CORS headers and two Content Security Policies - the portal's and, when the
// playground is framed, the child origin's. So this suite starts a real interpreter, gives it the
// source the page displayed, and reads what `xarray` printed.
//
// The store is real: `fixtures/zarr-store.mjs` writes a Zarr v3 group (consolidated metadata,
// uncompressed chunks, a known arithmetic ramp) and the S3 gateway serves its bytes at the exact
// key the tree discovered, so the transcript can be checked for the dataset's own dimensions and
// for a value that can only have come from decoding a chunk. Both topologies are run, because
// their policies differ: same-origin under the portal's own CSP, framed under the generated child
// artifact's `default-src 'none'`, which names only what the build put in it, so a store fetch is
// refused unless the build carried the gateway's origin into the child's `connect-src` -
// invisible from outside the frame, and what this file exists to catch.
//
// Usage:  node browser-tests/waterpark-store-python.mjs

import assert from "node:assert/strict";
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
import { buildWaterparkShaped } from "./waterpark-shaped.mjs";
import { startS3Gateway } from "./fixtures/s3-gateway.mjs";
import { zarrStore } from "./fixtures/zarr-store.mjs";
import { certificate, chromiumArgs, portalPolicy, serveTls } from "./fixtures/tls-origins.mjs";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "..", "..");
const RUNTIME =
  process.env.FREVA_PYODIDE_RUNTIME ?? join(REPO, "packages", "browser-python", ".runtime");
const STRICT = process.env.BROWSER_STRICT === "1";
const RUN = mkdtempSync(join(tmpdir(), `wp-store-${Date.now()}-`));

const HOSTS = {
  parent: "waterpark.example.org",
  local: "waterpark-local.example.org",
  child: "play.example.org",
  runtime: "runtime.example.org",
  store: "store.example.org",
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
  skip(`no local Pyodide runtime at ${RUNTIME}.`);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  skip(`playwright is not installed: ${error.message}`);
}

let TLS;
try {
  TLS = certificate(join(RUN, "tls"), Object.values(HOSTS));
} catch (error) {
  skip(`openssl could not make a certificate: ${error.message}`);
}

/** The store the report walked, as the adapter names it. */
const STORE = "s3://cmip6/healpix/cmip6/historical-r10i1p1f2/cnrm-cm6-1/P1M/level_0.zarr/";
const STORE_KEY = STORE.slice("s3://".length);
const PATH = [
  "s3://cmip6/healpix/cmip6/",
  "s3://cmip6/healpix/cmip6/historical-r10i1p1f2/",
  "s3://cmip6/healpix/cmip6/historical-r10i1p1f2/cnrm-cm6-1/",
  "s3://cmip6/healpix/cmip6/historical-r10i1p1f2/cnrm-cm6-1/P1M/",
];

/** The Zarr store's bytes, published under the key the listing already advertises. */
const objects = new Map();
for (const [key, bytes] of zarrStore()) objects.set(`${STORE_KEY}${key}`, bytes);

const results = [];
const ONLY = process.env.FREVA_ONLY;
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

const servers = [];
let gateway;
let browser;
try {
  mkdirSync(join(RUN, "parent"), { recursive: true });
  mkdirSync(join(RUN, "local"), { recursive: true });
  mkdirSync(join(RUN, "child"), { recursive: true });

  // Every origin exists before anything is built, because the build compiles them in.
  const runtimeS = await serveTls(TLS, HOSTS.runtime, {
    dir: RUNTIME,
    headers: { "access-control-allow-origin": "*" },
  });
  const childS = await serveTls(TLS, HOSTS.child, { dir: join(RUN, "child"), headers: {} });
  const parentS = await serveTls(TLS, HOSTS.parent, { dir: join(RUN, "parent"), headers: {} });
  const localS = await serveTls(TLS, HOSTS.local, { dir: join(RUN, "local"), headers: {} });
  servers.push(runtimeS, childS, parentS, localS);
  gateway = await startS3Gateway({ objects, tls: TLS, host: HOSTS.store });

  const python = {
    profile: "xarray-zarr",
    autostart: "never",
    maxSessions: 2,
    runtimeIndexUrl: runtimeS.base,
  };
  const localBuilt = buildWaterparkShaped({
    canonicalUrl: localS.base,
    s3: { endpoint: gateway.endpoint },
    buckets: ["cmip6"],
    python,
    outDir: join(RUN, "local-built"),
  });
  const framedBuilt = buildWaterparkShaped({
    canonicalUrl: parentS.base,
    s3: { endpoint: gateway.endpoint },
    buckets: ["cmip6"],
    python: { ...python, playgroundOrigin: childS.origin },
    outDir: join(RUN, "framed-built"),
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
  const childCsp = deployment.headers["Content-Security-Policy"];
  childS.state.headers = deployment.headers;
  writeFileSync(
    join(RUN, "child", "csp-recorder.js"),
    "window.__childCsp = [];\n" +
      "document.addEventListener('securitypolicyviolation', (e) => " +
      "window.__childCsp.push(e.effectiveDirective + ' ' + e.blockedURI));\n",
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
    `origins: portal ${parentS.origin} | child ${childS.origin} | store ${gateway.origin}`,
  );

  browser = await chromium.launch({
    args: chromiumArgs(Object.values(HOSTS)),
    executablePath: process.env.FREVA_PORTAL_CHROMIUM ?? "/opt/pw-browsers/chromium",
  });

  async function withPage(base, fn) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 860 },
    });
    const page = await context.newPage();
    const problems = [];
    const violations = [];
    page.on("console", (m) => {
      const text = m.text();
      if (text.startsWith("CSPVIOLATION")) violations.push(text.slice("CSPVIOLATION ".length));
      else if (m.type() === "error") problems.push(text.slice(0, 220));
    });
    page.on("pageerror", (e) => problems.push(String(e).slice(0, 220)));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) =>
        console.log(`CSPVIOLATION ${e.effectiveDirective} ${e.blockedURI}`),
      );
    });
    try {
      await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector(".dataset-tree", { timeout: 30_000 });
      await fn(page, { problems, violations });
    } finally {
      await context.close();
    }
  }

  /** Walk to the store and open its access panel. */
  async function openStore(page) {
    for (const id of PATH) {
      await page.click(`[data-dt-row="${id}"]`);
      await page.waitForSelector(`[data-dt-row="${id}"][aria-expanded="true"]`, {
        timeout: 20_000,
      });
      await page.waitForTimeout(400);
    }
    await page.click(`[data-dt-row="${STORE}"]`);
    await page.waitForSelector(".dataset-tree__details", { timeout: 20_000 });
    await page.click(`.dataset-tree__disclose[data-dt-id="${STORE}"]`);
    await page.waitForSelector(".dataset-tree__access-body", { timeout: 20_000 });
  }

  const RAN = () => {
    const el = document.querySelector("freva-python-console");
    if (!el || typeof el.transcript !== "function") return false;
    const text = el.transcript();
    return text.includes("xarray.Dataset") || text.includes("Error") || text.includes("error");
  };
  const TRANSCRIPT = () => document.querySelector("freva-python-console").transcript();
  const STARTUP_MS = 420_000;

  // what is offered

  await check("the recipe carries Try beside Inspect, and Copy beside the code", () =>
    withPage(localS.base, async (page) => {
      await openStore(page);
      // ONE RECIPE, AND THEREFORE NO TABLIST. `s3fs` needs botocore and a credential chain a
      // browser does not have, so it is in no profile, could never carry a run control, and would
      // leave a reader with a tab they cannot run beside a tab they can.
      const tabs = await page.$$eval(".dataset-tree__tab", (t) =>
        t.map((x) => x.textContent.trim()),
      );
      assert.deepEqual(tabs, [], `a tablist was drawn for one recipe: ${tabs.join(", ")}`);

      // RUN IS IN THE ACTION ROW, beside `Inspect`, because those are the two things a reader does
      // with a store; COPY stays in the snippet's own title bar, because it acts on that text.
      assert.equal(
        await page.locator(".dataset-tree__actions .dataset-tree__btn--run").count(),
        1,
        "the store has no Try control beside Inspect",
      );
      assert.deepEqual(
        await page.$$eval(".dataset-tree__actions button", (b) =>
          b.map((x) => x.getAttribute("data-dt-action")),
        ),
        ["inspect", "try-python"],
        "the action row is not Inspect then Try in Python",
      );
      assert.equal(
        await page.locator(".dataset-tree__access-body .dataset-tree__btn--run").count(),
        0,
        "a second run control is still in the code card",
      );
      assert.equal(
        await page.locator(".dataset-tree__access-body [data-dt-action='copy-example']").count(),
        1,
        "the recipe has no Copy control",
      );
    }),
  );

  await check("Copy puts the displayed source on the clipboard", () =>
    withPage(localS.base, async (page) => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await openStore(page);
      const shown = await page.$eval(".dataset-tree__access-body code", (c) => c.textContent);
      await page.click(".dataset-tree__access-body [data-dt-action='copy-example']");
      await page.waitForTimeout(300);
      const clipped = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(clipped.trim(), shown.trim(), "Copy did not copy the recipe on screen");
      // And it is the recipe, not the address above it.
      assert.match(clipped, /xr\.open_dataset/);
    }),
  );

  // it actually runs

  /** What the transcript has to contain for the store to have been READ rather than named. */
  function assertOpened(transcript) {
    assert.ok(
      transcript.includes("xarray.Dataset"),
      `no dataset was printed:\n${transcript.slice(-2000)}`,
    );
    // The store's own shape, which can only have come from its metadata.
    assert.match(
      transcript,
      /time:\s*4/,
      `the dataset has the wrong time dimension:\n${transcript}`,
    );
    assert.match(
      transcript,
      /cell:\s*48/,
      `the dataset has the wrong cell dimension:\n${transcript}`,
    );
    assert.ok(transcript.includes("tas"), "the data variable is missing");
    assert.ok(
      !/Traceback|ModuleNotFoundError|ImportError|ClientResponseError/.test(transcript),
      `the run raised:\n${transcript.slice(-2000)}`,
    );
  }

  await check("a real interpreter opens the live store, same-origin", () =>
    withPage(localS.base, async (page, { problems, violations }) => {
      await openStore(page);
      // The run control lives in the store's action row, beside `Inspect`.
      await page.click(".dataset-tree__actions .dataset-tree__btn--run");
      await page.waitForSelector(".freva-term.show", { timeout: 30_000 });
      try {
        await page.waitForFunction(RAN, null, { timeout: STARTUP_MS, polling: 1500 });
      } catch (error) {
        const seen = await page.evaluate(() => {
          const el = document.querySelector("freva-python-console");
          return el && typeof el.transcript === "function" ? el.transcript() : "(no console)";
        });
        throw new Error(`${error.message}\ntranscript so far:\n${seen.slice(-2500)}`);
      }
      const transcript = await page.evaluate(TRANSCRIPT);
      assertOpened(transcript);
      assert.deepEqual(violations, [], `the portal's own policy refused: ${violations.join(", ")}`);
      assert.deepEqual(
        problems.filter((p) => !p.includes("favicon")),
        [],
        problems.join(" | "),
      );
      // The interpreter, not the tree, is what fetched the chunks.
      assert.ok(
        gateway.requests.some((r) => r.includes("level_0.zarr/zarr.json")),
        "the store's metadata was never fetched",
      );
    }),
  );

  await check("a framed playground shows the recipe and offers no way to run it", () =>
    withPage(parentS.base, async (page) => {
      // THE INTERFACE GAP, asserted rather than described. A recipe is a registered TEMPLATE and
      // the store is a parameter. Across the embed boundary the parent may send
      // `{ exampleId, digest, targetSession }` and nothing else - deliberately, because that is
      // the protocol that keeps source from crossing - so there is nowhere to put the store.
      // Rather than widen the message or ship a button that opens a window to say the example was
      // refused, a framed build shows the recipe as documentation: readable, copyable, with no run
      // control anywhere on the panel. The build says so with FP1217.
      await openStore(page);
      assert.deepEqual(
        await page.$$eval(".dataset-tree__tab", (t) => t.map((x) => x.textContent.trim())),
        [],
        "a tablist was drawn for one recipe",
      );
      assert.equal(
        await page.locator(".dataset-tree__btn--run").count(),
        0,
        "a framed playground offered a run control it cannot honour",
      );
      assert.equal(
        await page.locator(".dataset-tree__access-body [data-dt-action='copy-example']").count(),
        1,
        "the recipe cannot even be copied",
      );
    }),
  );

  await check("the child's policy still names the store, for the day a parameter can cross", () => {
    // The grant stays whatever the recipes do. A framed playground cannot run one today; the
    // origin it would read from is this build's own and already in the parent's `connect-src`,
    // and a policy that had to be rediscovered later would be rediscovered by a five-minute
    // Python traceback.
    assert.ok(
      childCsp.includes(gateway.origin),
      `the child policy does not name the store origin:\n${childCsp}`,
    );
    assert.ok(
      !childCsp.includes("connect-src 'self' *"),
      "the child policy was widened rather than given one origin",
    );
  });

  // nothing crossed as code

  await check("what the build registered is the template, never a store's own program", () => {
    // THE SOURCE/DIGEST CONTRACT, checked where it is decided: in the artifacts on disk. The page
    // composes a recipe for DISPLAY, and that string is the one thing that must never become what
    // a runner executes. What is registered is the template with its hole still in it, hashed by
    // the build and looked up by name at run time, and the store arrives as a validated
    // parameter. So the local artifact ships the placeholder, and NEITHER artifact contains this
    // store's key, which was discovered in a browser and cannot have been known to any build. A
    // build that started baking rendered programs is what this notices.
    const walk = (dir) => {
      const out = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const at = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(at));
        else out.push(at);
      }
      return out;
    };
    const textOf = (dir) =>
      walk(dir)
        .filter((f) => /\.(js|mjs|html|json|css)$/.test(f))
        .map((f) => readFileSync(f, "utf8"));

    const local = textOf(localBuilt);
    assert.ok(
      local.some((text) => text.includes("{{STORE}}")),
      "the local artifact ships no template - a rendered program may have been registered",
    );
    for (const [label, texts] of [
      ["the portal", local],
      ["the playground child", textOf(join(RUN, "child"))],
    ]) {
      for (const text of texts) {
        assert.ok(
          !text.includes(STORE_KEY),
          `${label} names a store that was discovered in a browser`,
        );
        assert.ok(
          !/open_dataset\(\s*"https?:/.test(text),
          `${label} carries a recipe with an address already substituted into it`,
        );
      }
    }
  });
} finally {
  if (browser) await browser.close();
  for (const s of servers) s.server.close();
  if (gateway) await gateway.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} Waterpark store-Python checks passed`);
if (STRICT && passed !== results.length) process.exit(1);
