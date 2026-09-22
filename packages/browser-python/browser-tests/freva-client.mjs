/**
 * The freva-client profile: the reproduction, kept.
 *
 *     node browser-tests/freva-client.mjs
 *
 * MEASURED on Pyodide 314.0.6 / Python 3.14, in a real Worker, with the derived freva-client
 * 2607.1.0 browser wheel and py-oidc-auth-client 2603.0.1. The environment first, because
 * three of the four failures follow from it:
 *
 *     sys.platform            "emscripten"
 *     os.name                 "posix"
 *     HOME                    "/home/pyodide"
 *     site.USER_BASE          None
 *     sysconfig schemes       nt, nt_venv, posix_home, posix_prefix, posix_venv, venv
 *     "posix_user" present    False
 *
 * 1. PORTABLE DIRECTORIES.  `Config(host=...)` and `databrowser(host=...)` raise
 *    `KeyError: 'posix_user'`, because `Config.get_dirs(user=True)` reaches for a sysconfig scheme
 *    this platform does not have. Both other Freva-side failures are behind it.
 *
 * 2. SYNCHRONOUS /auth-ports.  `freva_client/utils/__init__.py:69`, in `AuthConfig.__init__`,
 *    calls `requests.get(f"{host}/auth/v2/auth-ports")` inside `except Exception: pass`. It does
 *    not raise and `requests` does work here (4), so it succeeds: a blocking round-trip on every
 *    Databrowser construction, for redirect ports the device flow has no use for.
 *
 * 3. asyncio.run.  `py_oidc_auth_client/__init__.py:203` wraps `authenticate_async` in
 *    `asyncio.run(...)`, which cannot run inside Pyodide's already-running loop. `freva_client`'s
 *    own `auth.py` has no `asyncio` in it at all - it delegates - so a probe reading
 *    `inspect.getsource(freva_client.authenticate)` for `asyncio.run` concludes the opposite.
 *
 * 4. NATIVE requests WORKS. A `requests.get()` inside the Worker returned 200 and a correct body
 *    length, which is why `pyodide_http.patch_all()` must NOT be added.
 *
 * 5. TWO BOUND `authenticate` SYMBOLS, from different modules:
 *
 *        freva_client/utils/databrowser_utils.py:29   from ..auth import authenticate
 *        freva_client/query.py:25                     from py_oidc_auth_client import authenticate
 *
 *    `Config.auth_headers` (databrowser_utils.py:182) uses the first; `databrowser._authenticate`
 *    (query.py:744) uses the SECOND, so rebinding `freva_client.auth.authenticate` alone leaves
 *    `_authenticate` calling the OIDC wrapper that raises. Both need rebinding, in their own
 *    modules.
 *
 * 6. POLARS. The runtime ships polars 1.33.1; intake-esm requires `>=1.24,<1.33`. A version
 *    conflict, not a missing build, so excluding intake-esm from the browser wheel is the answer.
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
// This suite declares `micropip` and had no guard for it, so an incomplete runtime made it FAIL
// rather than report NOT RUN - a missing wheel wearing the costume of a broken Freva profile.
requireRuntimeFor("freva-client profile", "freva-client.mjs");
bundleConsole();

/** The derived wheel, served as a same-origin static asset exactly as a deployment serves it. */
const WHEELHOUSE = "/freva-wheels/";
// Built before the browser starts, because a page that began loading against an empty directory
// would report a startup error that reads like a product defect.
try {
  await ensureFrevaWheelhouse();
} catch (error) {
  // THROUGH `report()`, like every other exit. An unhandled rejection here would leave `run.mjs`
  // with a non-zero exit and no result line, which reads as the suite crashing rather than as the
  // one thing that went wrong: the wheel could not be built.
  process.exit(
    report("freva-client profile", {
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

/**
 * The two hosts micropip legitimately reaches while the profile starts: the index it asks for a
 * release, and the file host that index points at.
 */
const PYPI = ["https://pypi.org/", "https://files.pythonhosted.org/"];

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "freva-client", wheelhouseURL: WHEELHOUSE }), {
    roots: { [WHEELHOUSE]: FREVA_WHEELHOUSE },
  });
  // EVERY request the page makes, recorded - including the ones that leave this origin. The
  // derived Freva wheel is installed WITH dependency resolution, so micropip resolves
  // freva-client's ordinary requirements itself and fetches them from PyPI while the page is
  // starting. Those two hosts are declared, above and in `freva-wheelhouse.json`; a request to a
  // THIRD origin is not, and that is what this recording is for.
  const offOrigin = [];
  // Recording covers STARTUP only. The checks below deliberately point Freva at real and unreachable
  // hosts to see how it reports them, and those requests are the test's, not the profile's.
  let recording = true;
  page.on("request", (request) => {
    const url = request.url();
    if (!recording) return;
    if (!url.startsWith(server.url) && !url.startsWith("data:") && !url.startsWith("blob:")) {
      offOrigin.push(url);
    }
  });
  const checks = [];
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__py !== undefined);
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 300000 });
    recording = false;

    const origin = server.url.replace(/\/$/, "");
    const run = (code) =>
      page.evaluate(async (src) => {
        window.__py.drain();
        const r = await window.__py.run(src);
        await new Promise((z) => setTimeout(z, 250));
        return { error: r.error ?? null, stdout: window.__py.text("stdout").trim() };
      }, code);

    // 1. no installation commands, at all
    const fresh = await run(
      [
        "import json, freva_client, py_oidc_auth_client",
        "print(json.dumps({",
        "    'freva': freva_client.__version__ if hasattr(freva_client, '__version__') else 'n/a',",
        "    'oidc': getattr(py_oidc_auth_client, '__version__', 'n/a'),",
        "    'ok': True,",
        "}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "freva_client imports on a fresh interpreter, with no install command",
      pass: fresh.stdout.includes('"ok": true'),
      detail: fresh.stdout || String(fresh.error).split("\n").pop(),
    });
    // The resolver chose this one, rather than a mirror in this repository choosing it: the pin
    // lives in the derived wheel's own metadata, so a resolution that ignored it would show here.
    checks.push({
      name: "…and the py-oidc-auth-client micropip resolved is exactly the pinned 2603.0.1",
      pass: fresh.stdout.includes('"oidc": "2603.0.1"'),
      detail: fresh.stdout || String(fresh.error).split("\n").pop(),
    });

    // 2. the compat adapter is live
    const patches = await run(
      [
        "import json, freva_client_compat",
        "print(json.dumps({'patches': freva_client_compat.installed_patches()}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "the compatibility adapter was applied before the first freva_client import",
      pass:
        patches.stdout.includes("CONFIG_GET_DIRS") && patches.stdout.includes("AUTH_CONFIG_PORTS"),
      detail: patches.stdout || String(patches.error).split("\n").pop(),
    });

    const idempotent = await run(
      [
        "import json, freva_client_compat",
        "before = list(freva_client_compat.installed_patches())",
        "freva_client_compat.install()",
        "freva_client_compat.install()",
        "print(json.dumps({'same': before == freva_client_compat.installed_patches()}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "…and calling install() again changes nothing",
      pass: idempotent.stdout.includes('"same": true'),
      detail: idempotent.stdout || String(idempotent.error).split("\n").pop(),
    });

    // 3. the two blocked entry points
    const dirs = await run(
      [
        "import json",
        "from freva_client.utils.databrowser_utils import Config",
        "try:",
        "    c = Config(host='https://eve.dkrz.de')",
        "    print(json.dumps({'ok': True, 'api_url': c.api_url}))",
        "except Exception as exc:",
        "    print(json.dumps({'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)[:120]}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "Config(host=...) constructs, without a posix_user scheme",
      pass: dirs.stdout.includes('"ok": true'),
      detail: dirs.stdout || String(dirs.error).split("\n").pop(),
    });
    checks.push({
      name: "…and normalises the host to Freva's API url",
      pass: dirs.stdout.includes("/api/freva-nextgen"),
      detail: dirs.stdout,
    });

    const db = await run(
      [
        "import json",
        "from freva_client import databrowser",
        "try:",
        "    db = databrowser(host='https://eve.dkrz.de')",
        "    print(json.dumps({'ok': True, 'flavour': getattr(db, '_flavour', 'n/a')}))",
        "except Exception as exc:",
        "    print(json.dumps({'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)[:200]}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "databrowser(host=...) constructs, with no flavour argument",
      pass: db.stdout.includes('"ok": true'),
      detail: db.stdout || String(db.error).split("\n").pop(),
    });

    // Against a host that CANNOT be reached, on purpose. `Config.flavour` asks the server which
    // flavours it has and falls back to "freva" when the request fails - but upstream enumerates
    // the failures it expects, and a browser's failed fetch
    // (`pyodide.ffi.JsException: TypeError: Failed to fetch`) is not among them, so the fallback
    // never fires and construction raises. The check above names a real host, which may fail with
    // an exception the tuple does catch; this one guarantees the failure by pointing at a port
    // nothing is listening on, and asserts the OUTCOME rather than the error type.
    const unreachable = await run(
      [
        "import json",
        "from freva_client import databrowser",
        "try:",
        "    db = databrowser(host='http://127.0.0.1:9/')",
        "    print(json.dumps({'ok': True, 'flavour': db._flavour}))",
        "except Exception as exc:",
        "    print(json.dumps({'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)[:160]}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "…and still constructs when the host cannot be reached at all",
      pass: unreachable.stdout.includes('"ok": true'),
      detail: unreachable.stdout || String(unreachable.error).split("\n").pop(),
    });
    checks.push({
      name: "…falling back to the 'freva' flavour, as upstream intends",
      pass: unreachable.stdout.includes('"flavour": "freva"'),
      detail: unreachable.stdout,
    });

    // And QUIETLY. A failed fetch writes to stderr even when the exception is caught and handled,
    // and the console paints stderr red with a gutter rule - so a construction that SUCCEEDED
    // shows a red traceback line above the object it has just built.
    const quiet = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.run(
        "from freva_client import databrowser\ndb = databrowser(host='http://127.0.0.1:9/')\n",
      );
      await new Promise((z) => setTimeout(z, 300));
      return window.__py.text("stderr");
    });
    checks.push({
      name: "…and writes nothing to stderr while doing it",
      pass: quiet.trim() === "",
      detail: JSON.stringify(quiet.slice(0, 160)),
    });

    // 4. no port probe: construction touches no network
    const noProbe = await run(
      [
        "import json",
        "from freva_client.utils import AuthConfig",
        "calls = []",
        "import requests",
        "_get = requests.get",
        "def spy(url, *a, **k):",
        "    calls.append(url)",
        "    return _get(url, *a, **k)",
        "requests.get = spy",
        "try:",
        "    AuthConfig('https://eve.dkrz.de')",
        "finally:",
        "    requests.get = _get",
        "print(json.dumps({'requests': calls}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "constructing AuthConfig issues no /auth-ports request",
      pass: noProbe.stdout.includes('"requests": []'),
      detail: noProbe.stdout || String(noProbe.error).split("\n").pop(),
    });

    // 5. intake_catalogue says why, precisely
    const intake = await run(
      [
        "import json",
        "from freva_client import databrowser",
        "db = databrowser(host='https://eve.dkrz.de')",
        "try:",
        "    db.intake_catalogue()",
        "    print(json.dumps({'raised': False}))",
        "except NotImplementedError as exc:",
        "    print(json.dumps({'raised': True, 'message': str(exc)}))",
        "except Exception as exc:",
        "    print(json.dumps({'raised': True, 'wrong_type': type(exc).__name__, 'message': str(exc)[:200]}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "intake_catalogue() explains that the browser profile excludes intake-esm",
      pass:
        intake.stdout.includes("not included in the browser profile") &&
        intake.stdout.includes("intake-esm's dependency set is incompatible"),
      detail: intake.stdout || String(intake.error).split("\n").pop(),
    });

    const noFakes = await run(
      [
        "import json, sys, importlib.util",
        "print(json.dumps({",
        "    'intake_esm_loaded': 'intake_esm' in sys.modules,",
        "    'intake_esm_findable': importlib.util.find_spec('intake_esm') is not None,",
        "}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "…and no fake intake_esm module was installed to make that happen",
      pass:
        noFakes.stdout.includes('"intake_esm_loaded": false') &&
        noFakes.stdout.includes('"intake_esm_findable": false'),
      detail: noFakes.stdout || String(noFakes.error).split("\n").pop(),
    });
    const intakeRequests = offOrigin.filter((url) => /intake[-_]esm/i.test(url));
    checks.push({
      name: "…and the resolver never even asked for it: no intake-esm request left this page",
      pass: intakeRequests.length === 0,
      detail: intakeRequests.slice(0, 5).join(" | ") || "no intake-esm request",
    });

    // 6. requests still native, no pyodide-http
    const req = await run(
      [
        "import json, requests, sys",
        `r = requests.get("${origin}${WHEELHOUSE}MANIFEST.json", timeout=30)`,
        "print(json.dumps({'status': r.status_code, 'pyodide_http': 'pyodide_http' in sys.modules}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "native requests works from the Worker, with no pyodide-http loaded",
      pass: req.stdout.includes('"status": 200') && req.stdout.includes('"pyodide_http": false'),
      detail: req.stdout || String(req.error).split("\n").pop(),
    });

    // the browser filesystem, on THIS profile too
    const filesystem = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.run(
        [
          "import fsspec",
          "fs = fsspec.filesystem('https')",
          "print('class:', type(fs).__name__)",
          "",
        ].join("\n"),
      );
      return { r, out: window.__py.text("stdout") };
    });
    checks.push({
      // The condition that registers it must not name a single profile: scoped to `xarray-zarr`,
      // `xr.open_zarr("https://…")` fails here with an fsspec unknown-protocol error - on the
      // profile whose entire purpose is reading data out of a Freva deployment.
      name: "the browser HTTP filesystem is registered on the freva-client profile as well",
      pass: !filesystem.r.error && /class: Browser/.test(filesystem.out),
      detail: filesystem.r.error
        ? String(filesystem.r.error).split("\n").pop()
        : filesystem.out.trim().split("\n").slice(-2).join(" | "),
    });

    const fromPyPI = offOrigin.filter((url) => PYPI.some((host) => url.startsWith(host)));
    const elsewhere = offOrigin.filter((url) => !PYPI.some((host) => url.startsWith(host)));
    checks.push({
      name: "starting the profile contacts NOTHING but this origin and PyPI - no CDN, no third host",
      pass: elsewhere.length === 0,
      detail: elsewhere.slice(0, 5).join(" | ") || `${fromPyPI.length} PyPI requests, nothing else`,
    });
    checks.push({
      name: "…and the dependencies really were resolved from PyPI, not mirrored beside the wheel",
      pass: fromPyPI.length > 0,
      detail: fromPyPI.slice(0, 5).join(" | ") || "no PyPI request at all",
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("freva-client profile", result));
