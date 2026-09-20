/**
 * Device-flow authentication in the browser profile, against a local OIDC provider.
 *
 * The provider is THIS FILE. A device flow's interesting halves are the answers a real provider
 * gives rarely and on its own schedule - authorization_pending, access_denied, expired_token, a
 * refused refresh - so scripting them here is the only way to test them, and it keeps CI
 * independent of Eve and of anyone typing a code. Not of PyPI: starting the profile installs the
 * derived Freva wheel with dependency resolution, so micropip fetches its ordinary dependencies
 * from PyPI before any of this runs. The live test against a real deployment is a separate,
 * opt-in suite.
 */
import {
  bundleConsole,
  ensureFrevaWheelhouse,
  fixturePage,
  FREVA_WHEELHOUSE,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";

requireDist();
bundleConsole();

requireRuntimeFor("freva-client authentication", "freva-auth.mjs");

const WHEELHOUSE = "/freva-wheels/";
// Built before any browser starts: a page loading against an empty directory would report a
// startup error that reads like a broken profile rather than a missing wheel.
try {
  await ensureFrevaWheelhouse();
} catch (error) {
  // THROUGH `report()`, like every other exit. An unhandled rejection here would leave `run.mjs`
  // with a non-zero exit and no result line, which reads as the suite crashing rather than as the
  // one thing that went wrong: the wheel could not be built.
  process.exit(
    report("freva-client authentication", {
      status: "fail",
      checks: [
        {
          name: "the derived Freva wheel can be built",
          pass: false,
          detail: String(error?.message ?? error),
        },
      ],
    }),
  );
}
/** The static root the page installs the derived wheel from. */
const WHEELS = { [WHEELHOUSE]: FREVA_WHEELHOUSE };
const ACCESS = "test-access-token-value";
const REFRESH = "test-refresh-token-value";

/** Scripted provider state, reset between scenarios by the test. */
const provider = {
  /** How many more polls answer `authorization_pending` before the token is issued. */
  pending: 0,
  /** When set, every poll answers with this OAuth error instead of a token. */
  error: null,
  /** Answers to a refresh request: "ok" or an OAuth error string. */
  refresh: "ok",
  polls: 0,
  issued: 0,
};

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
  // Seconds, absolute. Well into the future so `choose_token_strategy` says "use_token".
  expires: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: REFRESH,
  refresh_expires: Math.floor(Date.now() / 1000) + 7200,
  scope: "openid profile",
  ...extra,
});

/** The three routes py-oidc-auth-client uses, under Freva's api prefix. */
function handle(req, res, url) {
  const path = url.pathname;
  if (!path.startsWith("/api/freva-nextgen/auth/v2/")) return false;

  if (path.endsWith("/device")) {
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
      const form = new URLSearchParams(body);
      // FREVA'S TOKEN ROUTE IS NOT OAUTH'S: there is no `grant_type`. The form carries
      // `device-code=…` while a device flow is polled and `refresh-token=…` when an expired
      // access token is renewed - the field name IS the grant. Branching on `grant_type` never
      // runs, so a refresh is answered as though it were a device poll.
      if (form.has("refresh-token")) {
        if (provider.refresh === "ok") {
          provider.issued += 1;
          json(res, 200, token({ access_token: `${ACCESS}-refreshed` }));
        } else {
          json(res, 400, { error: provider.refresh });
        }
        return;
      }
      provider.polls += 1;
      if (provider.error) {
        json(res, 400, { error: provider.error });
        return;
      }
      if (provider.pending > 0) {
        provider.pending -= 1;
        json(res, 400, { error: "authorization_pending" });
        return;
      }
      provider.issued += 1;
      json(res, 200, token());
    });
    return true;
  }

  // Anything else under /auth/v2/ - including the /auth-ports probe this profile must never make.
  return json(res, 404, { error: "not_found", path });
}

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "freva-client", wheelhouseURL: WHEELHOUSE }), {
    handle,
    roots: WHEELS,
  });
  const checks = [];
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__py !== undefined);
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 300000 });

    const host = server.url.replace(/\/$/, "");
    const run = (code) =>
      page.evaluate(async (src) => {
        window.__py.drain();
        const r = await window.__py.run(src);
        await new Promise((z) => setTimeout(z, 250));
        return {
          error: r.error ?? null,
          stdout: window.__py.text("stdout").trim(),
          stderr: window.__py.text("stderr").trim(),
        };
      }, code);

    // ------ the shape of the public API
    const shape = await run(
      [
        "import inspect, json",
        "import freva_client",
        "import freva_client.auth, freva_client.query",
        "from freva_client.utils import databrowser_utils",
        "print(json.dumps({",
        "    'freva_client': inspect.iscoroutinefunction(freva_client.authenticate),",
        "    'auth_module': inspect.iscoroutinefunction(freva_client.auth.authenticate),",
        "    'query_is_bridge': getattr(freva_client.query.authenticate, '_freva_browser_patch', None),",
        "    'utils_is_bridge': getattr(databrowser_utils.authenticate, '_freva_browser_patch', None),",
        "}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "freva_client.authenticate and freva_client.auth.authenticate are both awaitable",
      pass:
        shape.stdout.includes('"freva_client": true') &&
        shape.stdout.includes('"auth_module": true'),
      detail: shape.stdout || String(shape.error).split("\n").pop(),
    });
    checks.push({
      name: "…and the two synchronous call sites got the cached-token bridge, each in its own module",
      pass:
        shape.stdout.includes('"query_is_bridge": "TOKEN_BRIDGE"') &&
        shape.stdout.includes('"utils_is_bridge": "TOKEN_BRIDGE"'),
      detail: shape.stdout,
    });

    // ------ before authenticating: two different contracts
    //
    // `auth_token` is documented to return None when there is no usable token and only calls
    // through when `token_strategy` says one exists, so it must stay None here rather than
    // raising - upstream's contract, which the bridge does not get to change. The path that DOES
    // require a token is `_authenticate()`, and that is where the instruction has to appear.
    const before = await run(
      [
        "import json",
        "from freva_client import databrowser",
        `db = databrowser(host="${host}")`,
        "out = {}",
        "out['auth_token_is_none'] = db.auth_token is None",
        "try:",
        "    db._authenticate()",
        "    out['raised'] = False",
        "except Exception as exc:",
        "    out['raised'] = True",
        "    out['message'] = str(exc)",
        "print(json.dumps(out))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "auth_token stays None before authentication, as upstream documents",
      pass: before.stdout.includes('"auth_token_is_none": true'),
      detail: before.stdout || String(before.error).split("\n").pop(),
    });
    checks.push({
      name: "…and the path that needs a token says what to run, without hanging",
      pass:
        before.stdout.includes("No valid browser authentication token") &&
        before.stdout.includes("await freva_client.authenticate"),
      detail: before.stdout || String(before.error).split("\n").pop(),
    });

    // ------ the device flow: success
    const success = await run(
      [
        "import json",
        "import freva_client",
        `tok = await freva_client.authenticate(host="${host}", timeout=60)`,
        "print(json.dumps({",
        "    'has_access': bool(tok.get('access_token')),",
        "    'has_headers': 'Authorization' in (tok.get('headers') or {}),",
        "}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "the device flow completes and returns a token with an Authorization header",
      pass:
        success.stdout.includes('"has_access": true') &&
        success.stdout.includes('"has_headers": true'),
      detail: success.stdout || String(success.error).split("\n").pop(),
    });
    checks.push({
      name: "…and the verification URL and user code were printed for the user to act on",
      pass: success.stdout.includes("WXYZ-1234") || success.stderr.includes("WXYZ-1234"),
      detail: JSON.stringify((success.stdout + success.stderr).slice(0, 200)),
    });

    // ------ the cached token now reaches the sync paths
    const bridged = await run(
      [
        "import json",
        "from freva_client import databrowser",
        `db = databrowser(host="${host}")`,
        "tok = db.auth_token",
        "print(json.dumps({",
        "    'auth_token_is_not_none': tok is not None,",
        "    'headers': 'Authorization' in (tok.get('headers') or {}) if tok else False,",
        "}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "databrowser.auth_token returns the cached token, with no network and no coroutine",
      pass:
        bridged.stdout.includes('"auth_token_is_not_none": true') &&
        bridged.stdout.includes('"headers": true'),
      detail: bridged.stdout || String(bridged.error).split("\n").pop(),
    });

    const headers = await run(
      [
        "import json",
        "from freva_client.utils.databrowser_utils import Config",
        `c = Config(host="${host}")`,
        "h = c.auth_headers",
        "print(json.dumps({'has_auth_header': bool(h and 'Authorization' in h)}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "Config.auth_headers goes through the same bridge",
      pass: headers.stdout.includes('"has_auth_header": true'),
      detail: headers.stdout || String(headers.error).split("\n").pop(),
    });

    // ------ pending, then success
    await page.evaluate(() => {});
    const pendingScenario = await (async () => {
      provider.pending = 2;
      provider.polls = 0;
      return run(
        [
          "import json",
          "import freva_client",
          `tok = await freva_client.authenticate(host="${host}", force=True, timeout=60)`,
          "print(json.dumps({'ok': bool(tok.get('access_token'))}))",
          "",
        ].join("\n"),
      );
    })();
    checks.push({
      name: "polling through authorization_pending eventually succeeds",
      pass: pendingScenario.stdout.includes('"ok": true') && provider.polls >= 3,
      detail: JSON.stringify({
        stdout: pendingScenario.stdout.slice(0, 120),
        polls: provider.polls,
      }),
    });

    // ------ access denied
    provider.error = "access_denied";
    const denied = await run(
      [
        "import json",
        "import freva_client",
        "try:",
        `    await freva_client.authenticate(host="${host}", force=True, timeout=30)`,
        "    print(json.dumps({'raised': False}))",
        "except Exception as exc:",
        "    print(json.dumps({'raised': True, 'type': type(exc).__name__}))",
        "",
      ].join("\n"),
    );
    provider.error = null;
    checks.push({
      name: "access_denied raises rather than hanging or returning a partial token",
      pass: denied.stdout.includes('"raised": true'),
      detail: denied.stdout || String(denied.error).split("\n").pop(),
    });

    // ------ expired code
    provider.error = "expired_token";
    const expired = await run(
      [
        "import json",
        "import freva_client",
        "try:",
        `    await freva_client.authenticate(host="${host}", force=True, timeout=30)`,
        "    print(json.dumps({'raised': False}))",
        "except Exception as exc:",
        "    print(json.dumps({'raised': True, 'type': type(exc).__name__}))",
        "",
      ].join("\n"),
    );
    provider.error = null;
    checks.push({
      name: "an expired device code raises",
      pass: expired.stdout.includes('"raised": true'),
      detail: expired.stdout || String(expired.error).split("\n").pop(),
    });

    // ------ no token values leak out
    const transcript = await page.evaluate(() => ({
      text: window.__py.events.map((e) => String(e.text ?? "")).join(""),
    }));
    checks.push({
      name: "no access or refresh token value appears in the emitted output",
      pass: !transcript.text.includes(ACCESS) && !transcript.text.includes(REFRESH),
      detail: `${transcript.text.length} chars of output scanned`,
    });

    const hosts = await run(
      [
        "import json, freva_client_compat",
        "print(json.dumps({'hosts': freva_client_compat.cached_token_hosts()}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "the compat module reports cached HOSTS, never token values",
      pass: hosts.stdout.includes("/api/freva-nextgen") && !hosts.stdout.includes(ACCESS),
      detail: hosts.stdout || String(hosts.error).split("\n").pop(),
    });

    // ------ persistence is OFF by default
    const offByDefault = await run(
      [
        "import json, freva_client_compat",
        "print(json.dumps({'persist': freva_client_compat.persistence_available()}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "credential persistence is off unless the host asked for it",
      pass: offByDefault.stdout.includes('"persist": false'),
      detail: offByDefault.stdout || String(offByDefault.error).split("\n").pop(),
    });

    return checks;
  } finally {
    await server.close();
  }
});

// A SECOND page, with persistence on, and a restart in the middle. Separate because the
// interesting property is what survives a NEW interpreter: the same page, `restart()`, and then a
// token store read from IndexedDB rather than from memory. Doing that in the run above would
// leave a credential in browser storage for every later scenario to trip over.
const persistence = await inBrowser(async (page) => {
  const server = await serve(
    fixturePage({ profile: "freva-client", wheelhouseURL: WHEELHOUSE, persistCredentials: true }),
    { handle, roots: WHEELS },
  );
  const checks = [];
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__py !== undefined);
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 300000 });

    const host = server.url.replace(/\/$/, "");
    const run = (code) =>
      page.evaluate(async (src) => {
        window.__py.drain();
        const r = await window.__py.run(src);
        await new Promise((z) => setTimeout(z, 250));
        return { error: r.error ?? null, stdout: window.__py.text("stdout").trim() };
      }, code);

    const mounted = await run(
      [
        "import json, os, freva_client_compat",
        "print(json.dumps({",
        "    'persist': freva_client_compat.persistence_available(),",
        "    'userbase': os.environ.get('PYTHONUSERBASE'),",
        "    'cache': os.environ.get('XDG_CACHE_HOME'),",
        "}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "with persistCredentials the store is mounted and the XDG paths point into it",
      pass:
        mounted.stdout.includes('"persist": true') &&
        mounted.stdout.includes("/home/pyodide/.freva-browser/user") &&
        mounted.stdout.includes("/home/pyodide/.freva-browser/cache"),
      detail: mounted.stdout || String(mounted.error).split("\n").pop(),
    });

    provider.pending = 0;
    provider.error = null;
    const authed = await run(
      [
        "import json, freva_client",
        `tok = await freva_client.authenticate(host="${host}", force=True, timeout=60)`,
        "print(json.dumps({'ok': bool(tok.get('access_token'))}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "authentication succeeds with persistence on",
      pass: authed.stdout.includes('"ok": true'),
      detail: authed.stdout || String(authed.error).split("\n").pop(),
    });

    // ------ a NEW interpreter, and the token is still there
    // Snapshotted, not compared against a constant: `provider.issued` counts across every
    // scenario in this file, so the question is whether the RESTART cost another login.
    const issuedBeforeRestart = provider.issued;
    await page.evaluate(() => window.__py.restart());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 300000 });

    const afterRestart = await run(
      [
        "import json",
        "from freva_client import databrowser",
        `db = databrowser(host="${host}")`,
        "tok = db.auth_token",
        "print(json.dumps({'reused': tok is not None}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "after a full interpreter restart the persisted token is reused, with no new login",
      pass: afterRestart.stdout.includes('"reused": true'),
      detail: afterRestart.stdout || String(afterRestart.error).split("\n").pop(),
    });
    checks.push({
      name: "…and reusing it issued no new token: the restart cost no login",
      pass: provider.issued === issuedBeforeRestart,
      detail: JSON.stringify({ before: issuedBeforeRestart, after: provider.issued }),
    });

    return checks;
  } finally {
    await server.close();
  }
});

// A THIRD page: the two interactive forms, and what happens when storage gives up.
//
// Both forms are product decisions, so both are pinned. A bare `await authenticate(...)` at the
// prompt displays whatever upstream's Token repr displays - not suppressed, redacted or
// rewritten, because a REPL that silently edits the value of the expression you just evaluated
// is worse than a token on screen you asked to see; assignment suppresses it as it suppresses
// any expression. What this package must never do is add a SECOND place the value appears.
//
// The degradation is the other half. `persistCredentials` is a promise a host renders as "stay
// signed in", and a browser can withdraw the storage it was made on at any point. Python
// swallows that failure, so the flush is broken here from inside the interpreter, against the
// real worker and the real IDBFS mount.
const degradation = await inBrowser(async (page) => {
  const server = await serve(
    fixturePage({ profile: "freva-client", wheelhouseURL: WHEELHOUSE, persistCredentials: true }),
    { handle, roots: WHEELS },
  );
  const checks = [];
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__py !== undefined);
    await page.evaluate(() => {
      window.__storage = [];
      window.__py.engine.onStorage((event) => window.__storage.push(event));
    });
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 300000 });

    const host = server.url.replace(/\/$/, "");
    provider.pending = 0;
    provider.error = null;

    await page.evaluate(() => window.__py.run("import freva_client, freva_client_compat, json"));

    // ------ the two interactive forms
    const forms = await page.evaluate(
      async ([h, access]) => {
        window.__py.drain();
        const bare = await window.__py.push(
          `await freva_client.authenticate(host="${h}", force=True, timeout=60)`,
        );
        const bareEvents = window.__py.drain();
        const assigned = await window.__py.push(
          `tok = await freva_client.authenticate(host="${h}", force=True, timeout=60)`,
        );
        const assignedEvents = window.__py.drain();
        const leaked = (events) =>
          events
            .filter((e) => e.type === "stdout" || e.type === "stderr" || e.type === "error")
            .map((e) => e.text ?? e.message ?? "")
            .some((text) => text.includes(access));
        return {
          bare: bare.result ?? "",
          assigned: assigned.result ?? "",
          bareStreamsLeak: leaked(bareEvents),
          assignedStreamsLeak: leaked(assignedEvents),
          statuses: JSON.stringify(window.__py.statuses),
        };
      },
      [host, ACCESS],
    );
    checks.push({
      name: "a bare `await authenticate(...)` displays the upstream token repr, unedited",
      pass: forms.bare.length > 0,
      // The value itself is not printed into CI output; only whether there was one.
      detail: `${forms.bare.length} characters of repr`,
    });
    checks.push({
      name: "…and assigning it suppresses the repr, as assignment does for any expression",
      pass: forms.assigned === "",
      detail: JSON.stringify(forms.assigned),
    });
    checks.push({
      name: "no token value reaches stdout, stderr or an error - the repr is the only place",
      pass: !forms.bareStreamsLeak && !forms.assignedStreamsLeak,
      detail: JSON.stringify({
        bare: forms.bareStreamsLeak,
        assigned: forms.assignedStreamsLeak,
      }),
    });
    checks.push({
      name: "…and no status message this package emits carries one either",
      pass: !forms.statuses.includes(ACCESS) && !forms.statuses.includes(REFRESH),
      detail: `${forms.statuses.length} characters of status scanned`,
    });

    // ------ storage withdraws its promise
    const persistedBefore = await page.evaluate(() => window.__py.engine.credentialsPersisted);
    checks.push({
      name: "persistence is claimed while it works",
      pass: persistedBefore === true,
      detail: String(persistedBefore),
    });

    const after = await page.evaluate(async (h) => {
      window.__py.drain();
      // Break the flush the way a full quota breaks it: `syncfs` calls back with an error. Done
      // from Python through `pyodide_js` so the real worker closure, the real IDBFS mount and the
      // real compatibility layer are all still in the path - only the browser's answer changes.
      await window.__py.run(
        [
          "import pyodide_js, js",
          "def _quota_exceeded(populate, callback):",
          "    callback(js.Error.new('QuotaExceededError: storage is full'))",
          "pyodide_js.FS.syncfs = _quota_exceeded",
          "",
        ].join("\n"),
      );
      const authed = await window.__py.run(
        [
          "import json, freva_client, freva_client_compat",
          `tok = await freva_client.authenticate(host="${h}", force=True, timeout=60)`,
          "print(json.dumps({",
          "    'authenticated': bool(tok.get('access_token')),",
          "    'persist': freva_client_compat.persistence_available(),",
          "}))",
          "",
        ].join("\n"),
      );
      await new Promise((z) => setTimeout(z, 250));
      const events = window.__py.drain();
      const alive = await window.__py.push("6 * 7");
      return {
        error: authed.error ?? null,
        stdout: events
          .filter((e) => e.type === "stdout")
          .map((e) => e.text)
          .join(""),
        notices: events
          .filter((e) => e.type === "stderr" && e.text.includes("persistent storage stopped"))
          .map((e) => e.text),
        storage: window.__storage,
        persisted: window.__py.engine.credentialsPersisted,
        alive: alive.result,
      };
    }, host);
    checks.push({
      name: "a failed flush does not fail the authentication that succeeded",
      pass: after.error === null && after.stdout.includes('"authenticated": true'),
      detail: after.stdout || String(after.error).split("\n").pop(),
    });
    checks.push({
      name: "…and Python stops claiming persistence, because the hook removed itself",
      pass: after.stdout.includes('"persist": false'),
      detail: after.stdout,
    });
    checks.push({
      name: "…and the engine withdraws the promise a host renders as 'stay signed in'",
      pass:
        after.persisted === false &&
        after.storage.length === 1 &&
        after.storage[0].credentialsPersisted === false,
      detail: JSON.stringify({ persisted: after.persisted, events: after.storage }),
    });
    checks.push({
      name: "…saying so exactly once, on stderr, without a token in the message",
      pass:
        after.notices.length === 1 &&
        !after.notices[0].includes(ACCESS) &&
        !after.notices[0].includes(REFRESH),
      detail: JSON.stringify(after.notices),
    });
    checks.push({
      name: "…and the interpreter is unaffected",
      pass: after.alive === "42",
      detail: JSON.stringify(after.alive),
    });

    return checks;
  } finally {
    await server.close();
  }
});

const merged = {
  status:
    result.status === "pass" && persistence.status === "pass" && degradation.status === "pass"
      ? "pass"
      : "fail",
  checks: [...(result.checks ?? []), ...(persistence.checks ?? []), ...(degradation.checks ?? [])],
  detail: result.detail ?? persistence.detail ?? degradation.detail,
};

process.exit(report("freva-client authentication", merged));
