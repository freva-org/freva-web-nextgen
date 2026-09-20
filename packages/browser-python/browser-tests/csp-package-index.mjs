/**
 * The package-index grant, served as a real header.
 *
 *     node browser-tests/csp-package-index.mjs
 *
 * `contentSecurityPolicy({ packageIndex: true })` adds `https://pypi.org` and
 * `https://files.pythonhosted.org` to `connect-src` and nothing else, and the `freva-client`
 * profile is the reason it exists: that profile installs ONE derived wheel WITH dependency
 * resolution, so micropip resolves the ordinary dependencies against the index while the
 * interpreter is starting. A deployment that leaves the option off gets a page that builds,
 * deploys and loads perfectly, and then fails at micropip's metadata lookup - which is a header
 * problem wearing the costume of a broken profile.
 *
 * So the claim is a PAIR, and one half alone is worth nothing:
 *
 *   - under `packageIndex: true` the profile reaches ready, the index really was contacted, and
 *     nothing else was;
 *   - under the same policy WITHOUT it the start FAILS, at the install, naming the index -
 *     rather than passing because the header was never in force.
 *
 * WHY THIS IS NOT IN `csp.mjs`. That suite is a default gate and must stay one: it needs no
 * wheels and no network, so it runs on a train. This suite needs the derived Freva wheel
 * (`ensureFrevaWheelhouse()`, served from `roots`) and a public package index, which is why it
 * sits beside `freva-client.mjs` in `PACKAGE_INDEX_SUITES` instead. A PyPI outage must not be
 * indistinguishable from a regression in the published policy.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ensureFrevaWheelhouse,
  FREVA_WHEELHOUSE,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";

const TITLE = "Content-Security-Policy: the package index";

requireDist();
// micropip, same as every other suite that starts this profile: without it an incomplete runtime
// would report a POLICY failure rather than NOT RUN.
requireRuntimeFor(TITLE, "csp-package-index.mjs");

const { contentSecurityPolicy, PACKAGE_INDEX_ORIGINS } = await import("../dist/csp.js");

/** The derived wheel, served as a same-origin static asset exactly as a deployment serves it. */
const WHEELHOUSE = "/freva-wheels/";
// Built before the browser starts, for the reason `freva-client.mjs` gives: a page loading
// against an empty directory reports a startup error that reads like a product defect. Reported
// THROUGH `report()`, so a wheel that cannot be built is one legible line rather than a crash.
try {
  await ensureFrevaWheelhouse();
} catch (error) {
  process.exit(
    report(TITLE, {
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
 * The two policies under test. They differ in ONE grant, and a check below proves that rather
 * than assuming it: a negative half served under some other, broader ablation would fail for a
 * reason that has nothing to do with the package index.
 */
const GRANTED = contentSecurityPolicy({ packageIndex: true });
const REFUSED = contentSecurityPolicy();

// Everything the page runs is an EXTERNAL script, served from this origin, because `script-src
// 'self'` is the policy under test: an inline `<script>` would need `'unsafe-inline'` or a
// per-response hash, and a fixture taking either would be measuring a weaker header. That is
// also why `fixturePage()` cannot be used here - its driver is inline.
const WATCHER_JS = `
  window.__violations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__violations.push({
      directive: event.effectiveDirective || event.violatedDirective,
      blocked: String(event.blockedURI).slice(0, 80),
    });
  });
`;

/**
 * The engine on the `freva-client` profile, self-hosted runtime, wheelhouse beside it.
 *
 * `start()` records its OUTCOME instead of returning a promise the test awaits. A failed start is
 * the whole point of the second half, and an `evaluate` awaiting a rejection would surface as a
 * suite error rather than as a recorded reason - and an uncaught rejection in the page would be
 * counted as a page error by the harness.
 */
const DRIVER_JS = `
  import { createBrowserPython } from "/dist/index.js";

  const events = [];
  const statuses = [];
  const python = createBrowserPython({
    profile: "freva-client",
    pyodide: { indexURL: new URL("/runtime/", location.href).href },
    wheelhouseURL: new URL(${JSON.stringify(WHEELHOUSE)}, location.href).href,
  });
  python.onOutput((event) => events.push(event));
  python.onStatus((event) => statuses.push(event));

  window.__csp = {
    engine: python,
    state: () => python.state,
    // THE RESULT IS ITS OWN FIELD, and deliberately not named outcome: an accessor of that name
    // on this same object is never undefined, so a settled() written against it would answer
    // true before start() had done anything and every wait below would fall through instantly -
    // a suite that passes because it never waited. (This block is a template literal injected
    // into the page, so it carries no backticks.)
    result: undefined,
    start: () => {
      python.start().then(
        () => {
          window.__csp.result = { ok: true };
        },
        (error) => {
          window.__csp.result = { ok: false, error: String((error && error.message) || error) };
        },
      );
      return true;
    },
    settled: () => window.__csp.result !== undefined,
    outcome: () => window.__csp.result ?? null,
    run: (code) => python.run(code),
    drain: () => events.splice(0, events.length),
    text: (kind) => events.filter((e) => e.type === kind).map((e) => e.text).join(""),
    /** Every status detail the engine emitted, which is where a failed start says why. */
    details: () => statuses.map((s) => s.state + (s.detail ? ": " + s.detail : "")),
    violations: () => window.__violations,
  };
  window.__ready = true;
`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>csp-package-index</title>
<script src="/csp-watcher.js"></script>
</head><body>
<script type="module" src="/csp-driver.js"></script>
</body></html>`;

/** The worker script, read from dist so it can be served with a header of its own. */
const WORKER_PATH = "/dist/worker/browser-python.worker.js";
const WORKER_SOURCE = readFileSync(
  fileURLToPath(new URL("../dist/worker/browser-python.worker.js", import.meta.url)),
  "utf8",
);

/**
 * One origin, serving the page, the built package, the pinned runtime and the derived wheel -
 * every one of them under `policy`.
 *
 * THE WORKER'S RESPONSE CARRIES IT TOO, and that is not tidiness. A dedicated Worker's policy
 * comes from its own script response rather than from the page that created it, and every fetch
 * micropip makes happens inside that Worker: a worker served with no header at all would have no
 * policy, and the refusing half of this suite would then refuse nothing.
 */
function serveUnder(policy) {
  return serve(PAGE, {
    headers: { "content-security-policy": policy },
    roots: { [WHEELHOUSE]: FREVA_WHEELHOUSE },
    handle: (req, res, url) => {
      const body =
        url.pathname === WORKER_PATH
          ? WORKER_SOURCE
          : url.pathname === "/csp-watcher.js"
            ? WATCHER_JS
            : url.pathname === "/csp-driver.js"
              ? DRIVER_JS
              : null;
      if (body === null) return false;
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-security-policy": policy,
      });
      res.end(body);
      return true;
    },
  });
}

/** Whether a URL is the package index rather than this origin. */
const isIndex = (url) => PACKAGE_INDEX_ORIGINS.some((origin) => url.startsWith(`${origin}/`));

/** A cold start is minutes, not seconds, and a refused one still has to load the runtime first. */
const STARTUP_MS = 300000;

const result = await inBrowser(async (page) => {
  const granted = await serveUnder(GRANTED);
  const refused = await serveUnder(REFUSED);
  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });

  /**
   * What each page asked for, recorded from before its first navigation: the requests that LEFT
   * this origin, the paths it asked its own origin for, and anything that failed. The last two
   * are what tell a refusal apart from a page that never started.
   */
  const watch = (target, origin) => {
    const seen = { off: [], paths: [], failed: [] };
    target.on("request", (request) => {
      const url = request.url();
      if (url.startsWith(origin)) seen.paths.push(url.slice(origin.length).split("?")[0]);
      else if (!url.startsWith("data:") && !url.startsWith("blob:")) seen.off.push(url);
    });
    target.on("requestfailed", (request) => {
      seen.failed.push(`${request.url().slice(0, 100)} ${request.failure()?.errorText ?? ""}`);
    });
    return seen;
  };

  try {
    // ------ the two policies, as data, before a browser is asked anything
    const connect = (policy) => /connect-src[^;]*/.exec(policy)?.[0] ?? "";
    ok(
      "the grant names the package index, and adds nothing else to connect-src",
      connect(GRANTED) === `connect-src 'self' ${PACKAGE_INDEX_ORIGINS.join(" ")}`,
      connect(GRANTED),
    );
    // The ablation is EXACTLY this one grant. A negative half served under some other, broader
    // policy would fail for a reason that says nothing about the package index.
    ok(
      "…and the refusing policy differs from it in that grant and nothing else",
      GRANTED.replace(` ${PACKAGE_INDEX_ORIGINS.join(" ")}`, "") === REFUSED,
      connect(REFUSED),
    );

    // ------ granted: the profile starts
    const grantedOrigin = granted.url.replace(/\/$/, "");
    const seen = watch(page, grantedOrigin);
    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
    });
    await page.goto(granted.url);
    try {
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    } catch (error) {
      ok(
        "the page's own module scripts load under this policy",
        false,
        consoleErrors.slice(0, 4).join(" | ") || String(error.message),
      );
      return checks;
    }

    await page.evaluate(() => window.__csp.start());
    await page
      .waitForFunction(() => window.__csp.state() === "ready" || window.__csp.settled(), null, {
        timeout: STARTUP_MS,
      })
      .catch(() => undefined);
    const grantedState = await page.evaluate(() => ({
      state: window.__csp.state(),
      outcome: window.__csp.outcome(),
      details: window.__csp.details(),
    }));
    ok(
      "the freva-client profile reaches ready under a policy that names the package index",
      grantedState.state === "ready",
      JSON.stringify(grantedState).slice(0, 400),
    );

    // Ready is not enough on its own: an interpreter that came up without the dependencies
    // micropip was meant to resolve would still report ready and fail on the first import.
    const imported = await page.evaluate(async () => {
      window.__csp.drain();
      const r = await window.__csp.run(
        [
          "import json, freva_client, py_oidc_auth_client",
          "print(json.dumps({'oidc': getattr(py_oidc_auth_client, '__version__', 'n/a')}))",
          "",
        ].join("\n"),
      );
      await new Promise((z) => setTimeout(z, 250));
      return { error: r.error ?? null, stdout: window.__csp.text("stdout").trim() };
    });
    ok(
      "…with the dependencies micropip resolved really installed, not merely a live interpreter",
      imported.error === null && imported.stdout.includes('"oidc"'),
      imported.stdout || String(imported.error).split("\n").pop(),
    );

    // ------ granted: nothing was blocked, and the grant is what was used
    const violations = await page.evaluate(() => window.__csp.violations());
    ok(
      "no directive blocked anything the page needed",
      violations.length === 0,
      JSON.stringify(violations.slice(0, 6)),
    );
    const fromIndex = seen.off.filter(isIndex);
    const elsewhere = seen.off.filter((url) => !isIndex(url));
    ok(
      "the grant was USED: the startup really did resolve dependencies from the index",
      fromIndex.length > 0,
      fromIndex.slice(0, 4).join(" | ") || "no request to the index at all",
    );
    ok(
      "…and the two hosts it names are the only ones this origin left for",
      elsewhere.length === 0,
      elsewhere.slice(0, 5).join(" | ") || `${fromIndex.length} index requests, nothing else`,
    );

    // ------ granted: and the header is genuinely being applied
    const denied = await page.evaluate(async () => {
      window.__violations.length = 0;
      try {
        // Not in `connect-src`, which grants this origin, the index and nothing else. If this
        // SUCCEEDS the header is not in force and every check above proved nothing.
        await fetch("https://example.invalid/probe");
        return { blocked: false };
      } catch {
        await new Promise((r) => setTimeout(r, 50));
        return { blocked: true, violations: window.__violations.length };
      }
    });
    ok(
      "the header is in force: an origin the grant does not name is still refused",
      denied.blocked === true,
      JSON.stringify(denied),
    );

    // ------ refused: the same profile, the same wheel, one grant removed
    const refusedOrigin = refused.url.replace(/\/$/, "");
    const second = await page.context().newPage();
    const seenRefused = watch(second, refusedOrigin);
    try {
      await second.goto(refused.url);
      await second.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      await second.evaluate(() => window.__csp.start());
      await second
        .waitForFunction(() => window.__csp.settled() || window.__csp.state() === "ready", null, {
          timeout: STARTUP_MS,
        })
        .catch(() => undefined);
      const state = await second.evaluate(() => ({
        state: window.__csp.state(),
        outcome: window.__csp.outcome(),
        details: window.__csp.details(),
      }));
      ok(
        "the same profile does NOT start under the policy without the package index",
        state.state !== "ready" && state.outcome?.ok !== true,
        JSON.stringify(state).slice(0, 400),
      );

      // AND FOR THE RIGHT REASON. A start that failed because the wheelhouse was empty, or
      // because the runtime never loaded, would satisfy the check above and say nothing about
      // this grant. Three independent signals, any one of which names the index: the engine's
      // own failure text, the status details it emitted, and the browser's record of a request
      // to the index that did not complete.
      const text = [state.outcome?.error ?? "", ...state.details].join("\n");
      const named = /pypi|pythonhosted|metadata|micropip|could not be installed/i.test(text);
      const blockedRequest = seenRefused.failed.filter((entry) => isIndex(entry));
      ok(
        "…and it fails at the install, naming the index micropip could not reach",
        named || blockedRequest.length > 0,
        [text.slice(0, 300), blockedRequest.slice(0, 2).join(" | ")].filter(Boolean).join(" || ") ||
          "no reason recorded",
      );
      // LATE, not a page that never started. `connect-src 'self'` still grants this origin, so a
      // refusal here has to arrive after the runtime and the derived wheel have both been
      // fetched from it - otherwise the failure is about the fixture, not about the one grant.
      const gotRuntime = seenRefused.paths.some((path) => path.startsWith("/runtime/"));
      const gotWheel = seenRefused.paths.some(
        (path) => path.startsWith(WHEELHOUSE) && path.endsWith(".whl"),
      );
      ok(
        "…after fetching the runtime and the derived wheel from its own origin, which it may",
        gotRuntime && gotWheel,
        JSON.stringify({ gotRuntime, gotWheel, paths: seenRefused.paths.length }),
      );
    } finally {
      await second.close();
    }

    return checks;
  } catch (error) {
    ok("the suite ran to the end", false, String(error?.message ?? error).split("\n")[0]);
    return checks;
  } finally {
    await granted.close();
    await refused.close();
  }
});

process.exit(report(TITLE, result));
