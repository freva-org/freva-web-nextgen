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
import { bundleConsole, inBrowser, report, requireDist, serve } from "./harness.mjs";

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

/** A tiny origin that answers one JSON route, so a fetch from Python has something real to reach. */
const dataService = (req, res, url) => {
  if (url.pathname !== "/data.json") return false;
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
  const allowed = await serve("", { handle: dataService });
  const blocked = await serve("", { handle: dataService });
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

    // ------ nothing was blocked
    const violations = await page.evaluate(() => window.__csp.violations());
    ok(
      "no directive blocked anything the engine or the console needed",
      violations.length === 0,
      JSON.stringify(violations.slice(0, 6)),
    );

    // ------ the WORKER's own policy, where Python's fetches actually happen
    const fromPython = await page.evaluate(
      async ([allowedUrl, blockedUrl]) => {
        const probe = async (url) => {
          const r = await window.__csp.run(
            [
              "import json",
              "from pyodide.http import pyfetch",
              "try:",
              `    _r = await pyfetch("${url}")`,
              "    print(json.dumps({'ok': _r.status == 200}))",
              "except Exception as _e:",
              "    print(json.dumps({'ok': False, 'error': type(_e).__name__}))",
              "",
            ].join("\n"),
          );
          return { error: r.error ?? null };
        };
        window.__csp.engine.onOutput?.(() => {});
        const out = [];
        const off = window.__csp.engine.onOutput((event) => {
          if (event.type === "stdout") out.push(event.text);
        });
        await probe(`${allowedUrl}/data.json`);
        const granted = out.join("");
        out.length = 0;
        await probe(`${blockedUrl}/data.json`);
        const refused = out.join("");
        off();
        return { granted, refused };
      },
      [allowedOrigin, blockedOrigin],
    );
    ok(
      "Python may fetch an origin the WORKER's policy grants",
      fromPython.granted.includes('"ok": true'),
      fromPython.granted.trim(),
    );
    ok(
      "…and may not fetch one it does not, even though the origin is up and answering",
      fromPython.refused.includes('"ok": false'),
      fromPython.refused.trim(),
    );
    ok(
      "the worker response carries a policy of its own, because a Worker does not inherit the page's",
      workerPolicy.includes("connect-src 'self' " + allowedOrigin),
      workerPolicy.match(/connect-src[^;]*/)?.[0] ?? "",
    );

    // ------ and the policy is doing something: prove a denial
    const denied = await page.evaluate(async () => {
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
    });
    ok(
      "the header is genuinely in force: a cross-origin fetch is refused",
      denied.blocked === true,
      JSON.stringify(denied),
    );

    return checks;
  } catch (error) {
    ok("the suite ran to the end", false, String(error?.message ?? error).split("\n")[0]);
    return checks;
  } finally {
    await server.close();
    await allowed.close();
    await blocked.close();
  }
});

process.exit(report("Content-Security-Policy", result));
