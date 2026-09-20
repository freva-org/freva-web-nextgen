// The console EMBEDDED, under the exact two headers the README tells a Waterpark deployment to
// set. `csp.mjs` proves the policy is survivable and that the worker's own `connect-src` bites; it
// does not prove the shape a portal deploys - the console in an `<iframe>` inside somebody else's
// shell, which is what `frame-ancestors 'self'` is for and the one directive whose effect is
// invisible until something tries to frame the page.
//
// So this serves three documents from ONE origin, as a deployment does:
//
//   shell.html   the portal's own page, which frames the console
//   /            the console page, `contentSecurityPolicy({ console: true, frameAncestors: ["'self'"] })`
//   worker.js    the worker script, `contentSecurityPolicy({ network: "https" })`
//
// and then asks what only the embedded arrangement can answer: does it render, does the
// interpreter start, does an artifact round-trip, is anything blocked, and is the framing grant
// real - checked by framing a page that does NOT have it and watching the browser refuse, without
// which "it framed" would be evidence of nothing.
//
// NOT a test against a Waterpark deployment: none is reachable from this repository, and the
// headers are the intended ones taken from `contentSecurityPolicy()` rather than read off a live
// response. Behaviour under the real portal's own additional headers, service workers and CDN
// remains UNVERIFIED.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleConsole, inBrowser, report, requireDist, serve } from "./harness.mjs";
import { contentSecurityPolicy } from "../dist/csp.js";

requireDist();
bundleConsole();

const WATCHER_JS = `
  window.__violations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__violations.push({
      directive: event.effectiveDirective || event.violatedDirective,
      blocked: String(event.blockedURI).slice(0, 80),
    });
  });
`;

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
    start: () => python.start(),
    run: (code) => python.run(code),
    image: null,
    artifacts: () => python.artifacts(),
    readArtifact: async (name) => {
      const data = await python.readArtifact(name);
      return await data.blob.text();
    },
    // A REAL blob: URL, in a real <img>, awaited to load or error. Blob.text() reads bytes that
    // never left JavaScript and constructing a blob URL is a string operation, so neither asks
    // the browser to FETCH a blob: URL and neither tests img-src blob:. This puts the URL
    // somewhere the CSP actually governs and waits for the browser to say which way it went.
    renderPng: async (name) => {
      const data = await python.readArtifact(name);
      const url = URL.createObjectURL(data.blob);
      try {
        return await new Promise((resolve) => {
          const img = new Image();
          img.onload = () =>
            resolve({ loaded: true, width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => resolve({ loaded: false });
          img.src = url;
          document.body.appendChild(img);
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    /** The small-file download path: a real anchor click, and a real browser download event. */
    downloadArtifact: async (name) => {
      const data = await python.readArtifact(name);
      const url = URL.createObjectURL(data.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { size: data.size, mime: data.mime };
    },
    violations: () => window.__violations,
    framed: () => window.parent !== window,
    styled: () => {
      const root = element.shadowRoot;
      const container = root.querySelector(".bp-container");
      return {
        adopted: (root.adoptedStyleSheets ?? []).length,
        background: container ? getComputedStyle(container).backgroundColor : null,
      };
    },
  };
  window.__ready = true;
`;

const CONSOLE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>console</title>
<script src="/watcher.js"></script>
</head><body>
<freva-python-console id="c"></freva-python-console>
<script type="module" src="/driver.js"></script>
</body></html>`;

/** The portal's own page. It frames the console and nothing else. */
const SHELL_PAGE = (id, src) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>portal</title></head><body>
<h1>a portal shell</h1>
<iframe id="${id}" src="${src}" width="800" height="400"></iframe>
</body></html>`;

const WORKER_PATH = "/dist/worker/browser-python.worker.js";
const WORKER_SOURCE = readFileSync(
  fileURLToPath(new URL("../dist/worker/browser-python.worker.js", import.meta.url)),
  "utf8",
);

/** Exactly the two headers the README's "Waterpark, concretely" section prints. */
const PAGE_POLICY = contentSecurityPolicy({ console: true, frameAncestors: ["'self'"] });
const WORKER_POLICY = contentSecurityPolicy({ network: "https" });
/** The default, with `frame-ancestors 'none'` - served alongside to prove the grant is doing work. */
const UNFRAMEABLE_POLICY = contentSecurityPolicy({ console: true });

const result = await inBrowser(async (page) => {
  const server = await serve(CONSOLE_PAGE, {
    headers: { "content-security-policy": PAGE_POLICY },
    handle: (req, res, url) => {
      if (url.pathname === WORKER_PATH) {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-security-policy": WORKER_POLICY,
        });
        res.end(WORKER_SOURCE);
        return true;
      }
      if (url.pathname === "/shell.html" || url.pathname === "/shell-strict.html") {
        const strict = url.pathname === "/shell-strict.html";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(SHELL_PAGE(strict ? "strict" : "console", strict ? "/unframeable.html" : "/"));
        return true;
      }
      if (url.pathname === "/unframeable.html") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": UNFRAMEABLE_POLICY,
        });
        res.end("<!doctype html><title>strict</title><p id=here>framed</p>");
        return true;
      }
      const body =
        url.pathname === "/watcher.js"
          ? WATCHER_JS
          : url.pathname === "/driver.js"
            ? DRIVER_JS
            : null;
      if (body === null) return false;
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-security-policy": PAGE_POLICY,
      });
      res.end(body);
      return true;
    },
  });
  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });

  try {
    // the headers, before anything runs on them
    ok(
      "the page policy is the documented one: framing by self, styles by attribute, no wildcard",
      PAGE_POLICY.includes("frame-ancestors 'self'") &&
        PAGE_POLICY.includes("style-src-attr 'unsafe-inline'") &&
        PAGE_POLICY.includes("script-src 'self' 'wasm-unsafe-eval'") &&
        !PAGE_POLICY.includes("*"),
      PAGE_POLICY,
    );
    ok(
      "the worker policy adds the https SCHEME to connect-src, and never a wildcard",
      WORKER_POLICY.includes("connect-src 'self' https:") &&
        !WORKER_POLICY.includes("*") &&
        WORKER_POLICY.includes("frame-ancestors 'none'"),
      WORKER_POLICY,
    );

    // the embedded arrangement
    await page.goto(`${server.url}shell.html`, { waitUntil: "load" });
    const frame = page.frame({ url: (u) => u.href === server.url || u.href === `${server.url}` });
    const consoleFrame =
      frame ?? page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(server.url));
    ok(
      "the console page loads inside the portal's iframe",
      Boolean(consoleFrame),
      page.frames().length + " frames",
    );
    if (!consoleFrame) throw new Error("the console frame never appeared");

    await consoleFrame.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
    ok(
      "…and it really is framed, not merely open",
      await consoleFrame.evaluate(() => window.__csp.framed()),
      "window.parent !== window",
    );

    const started = await consoleFrame.evaluate(async () => {
      await window.__csp.start();
      return true;
    });
    ok("a module Worker and a WebAssembly interpreter start while embedded", started, "ready");

    const ran = await consoleFrame.evaluate(async () => {
      const r = await window.__csp.run(
        "with open('embedded.csv','w') as fh:\n    fh.write('a,b\\n1,2\\n')\n",
      );
      return {
        error: r.error?.message ?? null,
        names: (await window.__csp.artifacts()).map((a) => a.name),
      };
    });
    ok(
      "…Python runs and the OPFS workspace works from inside the frame",
      ran.error === null && ran.names.join(",") === "embedded.csv",
      JSON.stringify(ran),
    );
    ok(
      "…and an artifact's bytes read back exactly",
      (await consoleFrame.evaluate(() => window.__csp.readArtifact("embedded.csv"))) ===
        "a,b\n1,2\n",
      "round-tripped",
    );

    // A blob: URL the browser actually has to fetch: a 1x1 PNG written by Python, read back as a
    // Blob, turned into a blob: URL and assigned to an `<img>` that is waited on.
    // `img-src 'self' data: blob:` is what permits this; without the grant the load fails and
    // `securitypolicyviolation` fires, and both are checked.
    const rendered = await consoleFrame.evaluate(async () => {
      await window.__csp.run(
        "import base64\n" +
          "png = base64.b64decode(\n" +
          "    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='\n" +
          ")\n" +
          "with open('dot.png', 'wb') as fh:\n" +
          "    fh.write(png)\n",
      );
      return await window.__csp.renderPng("dot.png");
    });
    ok(
      "a blob: URL the browser must FETCH renders in an <img> under this policy",
      rendered.loaded === true && rendered.width === 1 && rendered.height === 1,
      JSON.stringify(rendered),
    );
    ok(
      "…and rendering it violated nothing",
      (await consoleFrame.evaluate(() => window.__csp.violations())).length === 0,
      JSON.stringify(await consoleFrame.evaluate(() => window.__csp.violations())),
    );

    // The small-file download, as a real `download` event from the browser, with the saved file
    // compared BYTE FOR BYTE against what Python wrote. An anchor that was clicked and a URL that
    // was created prove nothing about whether anything was ever saved.
    const downloadDir = mkdtempSync(join(tmpdir(), "waterpark-download-"));
    let saved = null;
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30_000 }),
        consoleFrame.evaluate(() => window.__csp.downloadArtifact("embedded.csv")),
      ]);
      const target = join(downloadDir, "saved.csv");
      await download.saveAs(target);
      saved = {
        name: download.suggestedFilename(),
        bytes: readFileSync(target, "utf8"),
      };
    } catch (error) {
      saved = { error: String(error?.message ?? error).split("\n")[0] };
    }
    ok(
      "a small artifact downloads through a real browser download, with the exact bytes",
      saved?.bytes === "a,b\n1,2\n" && saved?.name === "embedded.csv",
      JSON.stringify(saved),
    );
    rmSync(downloadDir, { recursive: true, force: true });

    const styled = await consoleFrame.evaluate(() => window.__csp.styled());
    ok(
      "the console's stylesheet applied under the embedded policy",
      styled.adopted >= 1 && styled.background !== null && styled.background !== "rgba(0, 0, 0, 0)",
      JSON.stringify(styled),
    );

    const violations = await consoleFrame.evaluate(() => window.__csp.violations());
    ok(
      "nothing was blocked: no securitypolicyviolation in the embedded document",
      violations.length === 0,
      JSON.stringify(violations),
    );

    // The grant is real, proved by the page without it: same origin, same shell, same iframe, and
    // only `frame-ancestors 'none'` differs. If this one framed too, `frame-ancestors 'self'`
    // above would be decoration and the whole embedding result would mean nothing.
    await page.goto(`${server.url}shell-strict.html`, { waitUntil: "load" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const strictFramed = await page.evaluate(() => {
      const frame = document.getElementById("strict");
      try {
        return Boolean(frame.contentDocument?.getElementById("here"));
      } catch {
        return false; // cross-document access refused, which is also "did not load"
      }
    });
    ok(
      "a page WITHOUT the framing grant is refused in the same iframe, so the grant is doing work",
      strictFramed === false,
      `frame-ancestors 'none' page reachable: ${strictFramed}`,
    );

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("Waterpark-style embedding under the intended production headers", result));
