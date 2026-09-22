// Freva credentials across a REAL browser process restart, through the real path end to end.
//
// The neighbouring suites each prove less. `freva-auth.mjs` authenticates for real and then calls
// `restart()`, which replaces the INTERPRETER while the page, the Worker's origin and the browser
// process all survive. `persistence-restart.mjs` does kill a whole browser, but the value it
// stores is a string it puts into IndexedDB itself, so it is evidence about Chromium rather than
// about this package - it never touches `TokenStore`, IDBFS, the Freva wheel or the device flow.
//
// This is the real path with nothing simulated except the identity provider: the freva-client
// profile, the derived Freva wheel served locally, `persistCredentials: true`, a genuine
// `await freva_client.authenticate(...)` device flow against a local OIDC provider, the token
// written by upstream's own `TokenStore` into the IDBFS mount and flushed - and then the entire
// browser process ends and a new one starts against the same on-disk profile and the same origin.
//
// A GRACEFUL CLOSE, and it is called that: `context.close()` shuts the browser down normally, so
// the interpreter is not killed mid-write and IDBFS has already been flushed by the
// authentication. This suite does NOT demonstrate a crash, an OOM kill or a lost tab.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import {
  ENGINE,
  ensureFrevaWheelhouse,
  fixturePage,
  FREVA_WHEELHOUSE,
  isStrict,
  launchPersistent,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";

requireDist();

requireRuntimeFor(
  "Freva credentials across a real browser restart",
  "freva-persistence-restart.mjs",
);

const WHEELHOUSE = "/freva-wheels/";
const ACCESS = "test-access-token-value";
const REFRESH = "test-refresh-token-value";

/** Everything the provider was asked for, so "no second login" is a record and not a belief. */
const provider = { grants: [], bodies: [], devices: 0, issued: 0, expiresIn: 3600 };

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
  return true;
};

const token = (extra = {}) => ({
  access_token: ACCESS,
  token_type: "Bearer",
  expires: Math.floor(Date.now() / 1000) + provider.expiresIn,
  refresh_token: REFRESH,
  refresh_expires: Math.floor(Date.now() / 1000) + 7200,
  scope: "openid profile",
  ...extra,
});

function handle(req, res, url) {
  const path = url.pathname;
  if (!path.startsWith("/api/freva-nextgen/auth/v2/")) return false;

  if (path.endsWith("/device")) {
    provider.devices += 1;
    return json(res, 200, {
      device_code: "device-code-1",
      user_code: "WXYZ-1234",
      verification_uri: `${url.origin}/verify`,
      verification_uri_complete: `${url.origin}/verify?code=WXYZ-1234`,
      expires_in: 600,
      interval: 1,
    });
  }

  if (path.endsWith("/token")) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      // FREVA'S TOKEN ROUTE IS NOT OAUTH'S. There is no `grant_type`: the form carries
      // `device-code=…` while a device flow is being polled and `refresh-token=…` when an expired
      // access token is being renewed - hyphens, and the field name IS the grant. Reading
      // `grant_type` returns nothing for both, so a refresh is answered as a device poll and the
      // assertion that a refresh happened is satisfied by no refresh happening at all.
      const form = new URLSearchParams(body);
      const grant = form.has("refresh-token")
        ? "refresh_token"
        : form.has("device-code")
          ? "device_code"
          : "unknown";
      provider.grants.push(grant);
      provider.bodies.push(String(body).slice(0, 120));
      provider.issued += 1;
      json(
        res,
        200,
        grant === "refresh_token" ? token({ access_token: `${ACCESS}-refreshed` }) : token(),
      );
    });
    return true;
  }
  return json(res, 404, { error: "not_found", path });
}

const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });

let server;
let profileDir;
let status = "pass";
let detail = "";

try {
  // The derived wheel, built before any browser starts and INSIDE this try, so a wheel that could
  // not be built is reported through `report()` like every other failure here - and is not
  // mistaken for a credential that failed to survive the restart.
  await ensureFrevaWheelhouse();
  server = await serve(
    fixturePage({ profile: "freva-client", wheelhouseURL: WHEELHOUSE, persistCredentials: true }),
    { handle, roots: { [WHEELHOUSE]: FREVA_WHEELHOUSE } },
  );
  const host = server.url.replace(/\/$/, "");
  profileDir = mkdtempSync(join(tmpdir(), "freva-profile-"));

  /** One whole browser lifetime against the same on-disk profile and the same origin. */
  const launch = async (body) => {
    // The selected engine: what a persistent profile keeps across a restart is the browser's
    // own behaviour, and each engine is asked for it rather than Chromium standing in for all.
    const context = await launchPersistent(profileDir);
    try {
      const page = await context.newPage();
      await page.goto(server.url, { waitUntil: "load" });
      await page.waitForFunction(() => window.__py !== undefined);
      const run = (code) =>
        page.evaluate(async (src) => {
          window.__py.drain();
          const r = await window.__py.run(src);
          await new Promise((z) => setTimeout(z, 250));
          return { error: r.error ?? null, stdout: window.__py.text("stdout").trim() };
        }, code);
      return await body(page, run);
    } finally {
      // A GRACEFUL close: the browser is asked to shut down, not killed. See the header.
      await context.close();
    }
  };

  // the first browser
  const first = await launch(async (page, run) => {
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 600_000 });
    const mounted = await run(
      [
        "import json, os, freva_client_compat",
        "print(json.dumps({",
        "    'persist': freva_client_compat.persistence_available(),",
        "    'userbase': os.environ.get('PYTHONUSERBASE'),",
        "}))",
        "",
      ].join("\n"),
    );
    const authed = await run(
      [
        "import json, freva_client",
        `tok = await freva_client.authenticate(host="${host}", force=True, timeout=60)`,
        "print(json.dumps({'ok': bool(tok.get('access_token'))}))",
        "",
      ].join("\n"),
    );
    // The token on disk, found by walking the IDBFS mount rather than by hard-coding a path: the
    // file name is upstream's business and this suite must not become a copy of it. What matters
    // is that a file under the mount contains the token just issued, which proves upstream's own
    // `TokenStore` did the writing.
    const stored = await run(
      [
        "import json, os",
        "found = []",
        "for root, _dirs, files in os.walk('/home/pyodide/.freva-browser'):",
        "    for name in files:",
        "        path = os.path.join(root, name)",
        "        try:",
        "            body = open(path, 'r', encoding='utf-8', errors='ignore').read()",
        "        except OSError:",
        "            continue",
        `        if "${ACCESS}" in body:`,
        "            found.append(path)",
        "print(json.dumps({'files': found}))",
        "",
      ].join("\n"),
    );
    const idb = await page.evaluate(async () => {
      const dbs = (await indexedDB.databases?.()) ?? [];
      return dbs.map((d) => d.name);
    });
    return { mounted: mounted.stdout, authed: authed.stdout, stored: stored.stdout, idb };
  });

  ok(
    "the freva-client profile starts with persistent storage mounted at the XDG paths",
    first.mounted.includes('"persist": true') &&
      first.mounted.includes("/home/pyodide/.freva-browser/user"),
    first.mounted,
  );
  ok(
    "a real device-flow authenticate() succeeds against the provider",
    first.authed.includes('"ok": true') && provider.devices === 1,
    JSON.stringify({ authed: first.authed, devices: provider.devices, grants: provider.grants }),
  );
  ok(
    "…and upstream's own TokenStore wrote the token into the IDBFS mount",
    /"files": \["/.test(first.stored),
    first.stored,
  );
  ok(
    "…which is backed by IndexedDB, so it can outlive the process",
    Array.isArray(first.idb) && first.idb.some((n) => String(n).includes("freva-browser")),
    JSON.stringify(first.idb),
  );

  // a NEW browser process, same profile
  const issuedBefore = provider.issued;
  const devicesBefore = provider.devices;

  const second = await launch(async (page, run) => {
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 600_000 });
    // ORDER MATTERS, and it is observable. IDBFS fills asynchronously, so a token store read
    // before the populate lands finds nothing and asks the visitor to log in again over a
    // credential sitting in IndexedDB. The worker announces both steps, and "opening persistent
    // storage" has to come before "installing the Freva client".
    const order = await page.evaluate(() =>
      window.__py.statuses.map((s) => s.detail ?? "").filter(Boolean),
    );
    const reused = await run(
      [
        "import json",
        "from freva_client import databrowser",
        `db = databrowser(host="${host}")`,
        "tok = db.auth_token",
        "print(json.dumps({'reused': tok is not None, 'refreshed': 'refreshed' in (tok or '')}))",
        "",
      ].join("\n"),
    );
    return { order, reused: reused.stdout };
  });

  const storageStep = second.order.findIndex((d) => /persistent storage/i.test(d));
  const frevaStep = second.order.findIndex((d) => /Freva client/i.test(d));
  ok(
    "the new browser opens persistent storage BEFORE it imports the Freva client",
    storageStep >= 0 && frevaStep >= 0 && storageStep < frevaStep,
    JSON.stringify({ storageStep, frevaStep, order: second.order }),
  );
  ok(
    "databrowser(host=…).auth_token finds the token written by the PREVIOUS browser process",
    second.reused.includes('"reused": true'),
    second.reused,
  );
  ok(
    "…with no second device login: the provider was never asked for another device code",
    provider.devices === devicesBefore,
    JSON.stringify({ before: devicesBefore, after: provider.devices }),
  );
  ok(
    "…and a valid token is REUSED rather than refreshed - no grant of any kind was issued",
    provider.issued === issuedBefore && !second.reused.includes('"refreshed": true'),
    JSON.stringify({ issued: provider.issued, before: issuedBefore, grants: provider.grants }),
  );

  // And the other case: an expired access token. Separate from reuse on purpose - reuse must cost
  // NO network at all, a refresh exactly one `refresh_token` grant and still no device flow, and
  // running them together would let either one's evidence stand in for the other's.
  const third = await launch(async (page, run) => {
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 600_000 });
    // Age the stored token from inside the interpreter, through the same files upstream wrote.
    const aged = await run(
      [
        "import json, os, time",
        "aged = []",
        "shape = None",
        "past = int(time.time()) - 60",
        "def age(node):",
        '    """Set every expiry that sits beside an access token, however deeply nested."""',
        "    hit = False",
        "    if isinstance(node, dict):",
        "        if 'access_token' in node:",
        "            for key in list(node):",
        "                # ONLY the access expiry. Ageing 'refresh_expires' too would expire the",
        "                # refresh token as well, and upstream would then correctly start a new",
        "                # device flow - testing the wrong branch and looking like a refresh bug.",
        "                if key in ('expires', 'expires_at'):",
        "                    node[key] = past",
        "                    hit = True",
        "        for value in node.values():",
        "            hit = age(value) or hit",
        "    elif isinstance(node, list):",
        "        for value in node:",
        "            hit = age(value) or hit",
        "    return hit",
        "for root, _dirs, files in os.walk('/home/pyodide/.freva-browser'):",
        "    for name in files:",
        "        path = os.path.join(root, name)",
        "        try:",
        "            raw = open(path, encoding='utf-8').read()",
        "            data = json.loads(raw)",
        "        except Exception as exc:",
        "            shape = shape or (path + ': ' + str(exc)[:60])",
        "            continue",
        "        if age(data):",
        "            open(path, 'w', encoding='utf-8').write(json.dumps(data))",
        "            aged.append(path)",
        "        else:",
        "            shape = shape or (path + ': ' + raw[:160])",
        "print(json.dumps({'aged': aged, 'shape': shape}))",
        "",
      ].join("\n"),
    );
    const refreshed = await run(
      [
        "import json, freva_client",
        `tok = await freva_client.authenticate(host="${host}", timeout=60)`,
        "print(json.dumps({'access': tok.get('access_token')}))",
        "",
      ].join("\n"),
    );
    return { aged: aged.stdout, refreshed: refreshed.stdout };
  });

  ok(
    "an expired access token is refreshed with the stored refresh token",
    third.refreshed.includes("-refreshed"),
    JSON.stringify({ aged: third.aged.slice(0, 200), refreshed: third.refreshed }),
  );
  ok(
    "…using a refresh_token grant, and still no second device login",
    provider.grants.at(-1) === "refresh_token" && provider.devices === devicesBefore,
    JSON.stringify({ grants: provider.grants, devices: provider.devices, bodies: provider.bodies }),
  );
} catch (error) {
  const unlaunchable = /launch|executable doesn't exist|Failed to launch/i.test(
    String(error?.message ?? error),
  );
  status = isStrict() || !unlaunchable ? "fail" : "skipped";
  detail = `${error?.message ?? error}`.split("\n")[0];
} finally {
  try {
    await server?.close();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  } catch (error) {
    status = "fail";
    detail = `${detail ? `${detail}; ` : ""}teardown failed: ${error?.message ?? error}`;
  }
}

process.exit(
  report(`Freva credentials across a real browser restart, graceful close (${ENGINE})`, {
    status,
    detail,
    checks,
  }),
);
