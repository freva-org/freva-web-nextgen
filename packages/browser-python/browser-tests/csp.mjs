/**
 * The engine and the console under the exact Content-Security-Policy the package publishes.
 *
 *     node browser-tests/csp.mjs
 *
 * The policy is exported as data - `contentSecurityPolicy()` - and this suite serves the fixture
 * page under that exact header, collects every `securitypolicyviolation` the page fires, and
 * fails if the engine needs anything the manifest does not grant. It also asserts the negative:
 * `default-src *` would pass every functional check here, so the directives are checked too.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ENGINE,
  bundleConsole,
  capabilityAbsent,
  inBrowser,
  probeWorkerCapabilities,
  report,
  requireDist,
  serve,
  terminateEngines,
} from "./harness.mjs";
import {
  PhaseDeadline,
  cleanupChecks,
  createPhases,
  phaseFailureCheck,
  withDeadline,
} from "./deadline.mjs";
import { workspaceAbsenceConsistent } from "./workspace-reasons.mjs";

/** Each Python fetch is bounded inside Python, and its phase outside it with room to spare. */
const PYTHON_FETCH_BOUND_S = 20;
const FETCH_PHASE_MS = 60_000;

requireDist();
bundleConsole();

const { contentSecurityPolicy, CSP_DIRECTIVES } = await import("../dist/csp.js");

// Everything the page runs is an EXTERNAL script, served from this origin - not a detail of the
// test but the shape a deployment under this policy has to have. An inline `<script>` needs
// `'unsafe-inline'` or a per-response hash, and a fixture that took either would be testing a
// weaker policy than the one being published.
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
 * The driver, with the console component as well as the engine. The component is the part most
 * likely to need a directive nobody thought about - it attaches a stylesheet, renders figures
 * from data: URLs and previews from blob: URLs - so testing the engine alone proves the easy
 * half.
 */
const DRIVER_JS = `
  import { defineBrowserPythonConsole } from "/bundle/console.js";
  import { createBrowserPython } from "/dist/index.js";
  defineBrowserPythonConsole();

  const element = document.getElementById("c");
  const python = createBrowserPython({
    profile: "minimal",
    pyodide: { indexURL: new URL("/runtime/", location.href).href },
    workspaceMaxFiles: 4,
  });
  element.engine = python;

  window.__csp = {
    engine: python,
    element,
    state: () => python.state,
    start: () => python.start(),
    run: (code) => python.run(code),
    artifacts: () => python.artifacts(),
    violations: () => window.__violations,
    /** Whether the stylesheet arrived at all - the component is unusable without it. */
    styled: () => {
      const root = element.shadowRoot;
      const adopted = (root.adoptedStyleSheets ?? []).length;
      const elements = root.querySelectorAll("style").length;
      const container = root.querySelector(".bp-container");
      return {
        adopted,
        elements,
        // A real computed style, so this cannot pass on a sheet that was attached and ignored.
        background: container ? getComputedStyle(container).backgroundColor : null,
      };
    },
  };
  window.__ready = true;
`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>csp</title>
<script src="/csp-watcher.js"></script>
</head><body>
<freva-python-console id="c"></freva-python-console>
<script type="module" src="/csp-driver.js"></script>
</body></html>`;

/** The worker script, read from dist so it can be served with a header of its own. */
const WORKER_PATH = "/dist/worker/browser-python.worker.js";
const WORKER_SOURCE = readFileSync(
  fileURLToPath(new URL("../dist/worker/browser-python.worker.js", import.meta.url)),
  "utf8",
);

/**
 * A tiny origin that answers one JSON route, so a fetch from Python has something real to reach,
 * and COUNTS what reached it: a refusal is proved by the request never arriving, whatever the
 * engine then does with the promise.
 */
const dataService = (hits) => (req, res, url) => {
  if (url.pathname !== "/data.json") return false;
  hits.count += 1;
  res.writeHead(200, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end('{"ok": true}');
  return true;
};

const result = await inBrowser(async (page) => {
  // TWO more origins, and the difference between them is the whole point. A dedicated Worker's
  // Content-Security-Policy comes from the WORKER SCRIPT'S OWN RESPONSE, not from the page that
  // created it, and every network request the visitor's Python makes happens inside that Worker.
  // So: one origin the worker's policy grants, one it does not, both answering. If the granted
  // one fails the policy is too tight; if the ungranted one SUCCEEDS the header is not in force.
  const allowedHits = { count: 0 };
  const blockedHits = { count: 0 };
  const allowed = await serve("", { handle: dataService(allowedHits) });
  const blocked = await serve("", { handle: dataService(blockedHits) });
  const allowedOrigin = allowed.url.replace(/\/$/, "");
  const blockedOrigin = blocked.url.replace(/\/$/, "");

  // The console's policy: the strict one plus `style-src-attr 'unsafe-inline'`, which the vendored
  // terminal library needs and which this suite proves is the ONLY addition it needs.
  const policy = contentSecurityPolicy({ console: true });
  // The worker's policy is a different document's policy, and a narrower one: no styles, no
  // images, no framing - a Worker has no DOM to put them in. What it does have is `connect-src`,
  // and that is the directive being proved here.
  const workerPolicy = contentSecurityPolicy({ dataOrigins: [allowedOrigin] });
  const server = await serve(PAGE, {
    headers: { "content-security-policy": policy },
    handle: (req, res, url) => {
      if (url.pathname === WORKER_PATH) {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-security-policy": workerPolicy,
        });
        res.end(WORKER_SOURCE);
        return true;
      }
      const body =
        url.pathname === "/csp-watcher.js"
          ? WATCHER_JS
          : url.pathname === "/csp-driver.js"
            ? DRIVER_JS
            : null;
      if (body === null) return false;
      // The same policy on the scripts themselves, so nothing about them is special-cased.
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-security-policy": policy,
      });
      res.end(body);
      return true;
    },
  });
  const checks = [];
  const notApplicable = [];
  // A phase that overruns is rejected at its deadline and the page's engines are disposed, so a
  // pending evaluate settles; nothing here waits on the runner's 15-minute watchdog.
  const phases = createPhases("csp", { onDeadline: () => terminateEngines(page) });
  const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });
  try {
    // ------ the policy itself, before any of it runs
    ok(
      "the published policy denies by default and never uses a wildcard",
      CSP_DIRECTIVES["default-src"].join(" ") === "'none'" &&
        !policy.includes("*") &&
        !/default-src[^;]*\*/.test(policy),
      policy,
    );
    ok(
      "…permits WebAssembly compilation but NOT JavaScript eval",
      policy.includes("'wasm-unsafe-eval'") && !policy.includes("'unsafe-eval'"),
      CSP_DIRECTIVES["script-src"].join(" "),
    );
    ok(
      "…and does not need 'unsafe-inline' for STYLESHEETS, even with the console",
      !CSP_DIRECTIVES["style-src"].includes("'unsafe-inline'") &&
        /style-src 'self'(;|$)/.test(policy),
      policy.match(/style-src[^;]*/g)?.join(" | ") ?? "",
    );
    ok(
      "the console's one extra grant is style ATTRIBUTES, and it is opt-in",
      policy.includes("style-src-attr 'unsafe-inline'") &&
        !contentSecurityPolicy().includes("style-src-attr"),
      `engine only: ${contentSecurityPolicy()
        .match(/style-src[^;]*/g)
        ?.join(" | ")}`,
    );

    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
    });
    await page.goto(server.url);
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

    // ------ the component renders under this policy
    const styled = await page.evaluate(() => window.__csp.styled());
    ok(
      "the console's stylesheet is ADOPTED rather than injected, so style-src 'self' suffices",
      styled.adopted === 1 && styled.elements === 0,
      JSON.stringify(styled),
    );
    ok(
      "…and it actually applied: the container has the console's own background",
      styled.background !== null && styled.background !== "rgba(0, 0, 0, 0)",
      String(styled.background),
    );

    // ------ the interpreter starts
    await page.evaluate(() => window.__csp.start());
    await page.waitForFunction(() => window.__csp.state() === "ready", null, { timeout: 240000 });
    ok("a module Worker and a WebAssembly interpreter start under this policy", true, "ready");

    const ran = await page.evaluate(async () => {
      const r = await window.__csp.run("print(6 * 7)\n");
      return { error: r.error ?? null };
    });
    ok("…and Python runs", ran.error === null, ran.error ?? "ran");

    // ------ the workspace, and a blob preview
    //
    // Only this part needs OPFS. What the WORKER reported decides: with a disk-backed workspace the
    // artifact is listed and read back through a blob: URL under this policy; without one (WebKit
    // has no OPFS) the documented fallback is checked instead - the reason agrees with an
    // independent probe, Python still writes files, downloads are refused with that same reason -
    // and the blob readback is reported NOT APPLICABLE. Every policy check around it still runs.
    const status = await page.evaluate(() => window.__csp.engine.workspace);
    if (status?.available === true) {
      const workspace = await page.evaluate(async () => {
        const r = await window.__csp.run(
          "with open('note.csv', 'w') as fh:\n    fh.write('a,b\\n1,2\\n')\n",
        );
        const artifacts = await window.__csp.artifacts();
        const data = await window.__csp.engine.readArtifact("note.csv");
        const url = URL.createObjectURL(data.blob);
        const text = await data.blob.text();
        URL.revokeObjectURL(url);
        return {
          error: r.error ?? null,
          names: artifacts.map((a) => a.name),
          blobUrl: url.slice(0, 5),
          text,
        };
      });
      ok(
        "the disk-backed workspace works, and an artifact reads back through a blob: URL",
        workspace.error === null &&
          workspace.names.join() === "note.csv" &&
          workspace.blobUrl === "blob:" &&
          workspace.text === "a,b\n1,2\n",
        JSON.stringify(workspace),
      );
    } else {
      const probed = await probeWorkerCapabilities(page);
      const consistent = workspaceAbsenceConsistent(status, probed);
      ok(
        "no disk-backed workspace here, for the reason an independent worker confirms",
        consistent.ok,
        JSON.stringify({ status, probed, ...(consistent.ok ? {} : { why: consistent.why }) }),
      );
      const fallback = await page.evaluate(async () => {
        const r = await window.__csp.run(
          "with open('note.csv', 'w') as fh:\n    fh.write('kept')\nprint(open('note.csv').read())\n",
        );
        let refused = null;
        try {
          await window.__csp.artifacts();
        } catch (error) {
          refused = String(error?.message ?? error);
        }
        return { error: r.error ?? null, refused };
      });
      ok(
        "…Python still writes files in memory, and downloads are refused with that reason",
        fallback.error === null && fallback.refused === status?.detail,
        JSON.stringify(fallback),
      );
      capabilityAbsent(
        checks,
        notApplicable,
        "sync-access-handles",
        "listing and blob: readback of a disk-backed artifact under this policy",
        `this ${ENGINE} context's worker has no disk-backed workspace (${status?.reason ?? "unknown"})`,
      );
    }

    // ------ nothing was blocked
    const violations = await page.evaluate(() => window.__csp.violations());
    ok(
      "no directive blocked anything the engine or the console needed",
      violations.length === 0,
      JSON.stringify(violations.slice(0, 6)),
    );

    // ------ the WORKER's own policy, where Python's fetches actually happen
    //
    // One phase per origin, each with its own deadline, and each fetch bounded INSIDE Python too:
    // a fetch that never settles is reported as exactly that ("settled": false) rather than holding
    // the suite until the runner's watchdog - and it is not a refusal. A policy that refuses a
    // request rejects the fetch; only a fetch that SETTLED with an error counts as refused.
    const fetchFromPython = (url) =>
      page.evaluate(
        async ([target, boundSeconds]) => {
          const out = [];
          const off = window.__csp.engine.onOutput((event) => {
            if (event.type === "stdout") out.push(event.text);
          });
          try {
            const r = await window.__csp.run(
              [
                "import asyncio, json",
                "from pyodide.http import pyfetch",
                "async def _probe():",
                "    try:",
                `        _r = await asyncio.wait_for(pyfetch("${target}"), ${boundSeconds})`,
                "        return {'settled': True, 'ok': _r.status == 200}",
                "    except asyncio.TimeoutError:",
                `        return {'settled': False, 'ok': False, 'error': 'no answer within ${boundSeconds} s'}`,
                "    except Exception as _e:",
                "        return {'settled': True, 'ok': False, 'error': type(_e).__name__}",
                "print(json.dumps(await _probe()))",
                "",
              ].join("\n"),
            );
            const text = out.join("").trim();
            let parsed = null;
            try {
              parsed = JSON.parse(text.split("\n").pop());
            } catch {
              parsed = null;
            }
            // The run's own error and the probe's outcome are kept apart: the outcome has an
            // `error` of its own (the refusal's exception name), which is not a failed run.
            return { runError: r.error ?? null, outcome: parsed, text };
          } finally {
            off();
          }
        },
        [url, PYTHON_FETCH_BOUND_S],
      );
    const granted = await phases.run("worker fetch: granted origin", FETCH_PHASE_MS, () =>
      fetchFromPython(`${allowedOrigin}/data.json`),
    );
    ok(
      "Python may fetch an origin the WORKER's policy grants",
      granted.runError === null &&
        granted.outcome?.settled === true &&
        granted.outcome?.ok === true &&
        allowedHits.count === 1,
      JSON.stringify({ ...granted, requestsReceived: allowedHits.count }),
    );
    // REFUSED means the request never left the worker: the refused origin, which is up and would
    // answer, received nothing, and Python got no response. Engines differ in what the promise does
    // next - Chromium and Firefox reject it at once, WebKit leaves it pending - so whether it
    // settled is recorded in the detail but is not what the policy is proved by.
    const refused = await phases.run("worker fetch: refused origin", FETCH_PHASE_MS, () =>
      fetchFromPython(`${blockedOrigin}/data.json`),
    );
    ok(
      "…and may not fetch one it does not, even though the origin is up and answering",
      refused.runError === null &&
        refused.outcome !== null &&
        refused.outcome.ok === false &&
        blockedHits.count === 0,
      JSON.stringify({ ...refused, requestsReceived: blockedHits.count }),
    );
    ok(
      "the worker response carries a policy of its own, because a Worker does not inherit the page's",
      workerPolicy.includes("connect-src 'self' " + allowedOrigin),
      workerPolicy.match(/connect-src[^;]*/)?.[0] ?? "",
    );

    // ------ and the policy is doing something: prove a denial
    const denied = await phases.run("page fetch: refused by the page policy", 30_000, () =>
      page.evaluate(async () => {
        window.__violations.length = 0;
        try {
          // `connect-src 'self'` - a cross-origin fetch must be refused. If this SUCCEEDS the header
          // is not being applied at all, and every check above proved nothing.
          await fetch("https://example.invalid/probe");
          return { blocked: false };
        } catch {
          await new Promise((r) => setTimeout(r, 50));
          return { blocked: true, violations: window.__violations.length };
        }
      }),
    );
    ok(
      "the header is genuinely in force: a cross-origin fetch is refused",
      denied.blocked === true,
      JSON.stringify(denied),
    );

    checks.push(...(await cleanupChecks(phases)));
    return { checks, notApplicable };
  } catch (error) {
    // A deadline names its phase; anything else is reported as the suite not reaching its end.
    checks.push(
      error instanceof PhaseDeadline
        ? phaseFailureCheck(error)
        : {
            name: "the suite ran to the end",
            pass: false,
            detail: String(error?.message ?? error).split("\n")[0],
          },
    );
    checks.push(...(await cleanupChecks(phases)));
    return { checks, notApplicable };
  } finally {
    // Bounded: a server holding a connection from a wedged page must not hold the process.
    for (const [what, server_] of [
      ["the page server", server],
      ["the granted origin", allowed],
      ["the refused origin", blocked],
    ]) {
      await withDeadline(server_.close(), 10_000, `closing ${what}`).catch(() => {});
    }
  }
});

process.exit(report("Content-Security-Policy", result));
