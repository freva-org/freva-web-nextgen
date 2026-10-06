// The notebook suites' harness: build the pinned site once, serve it on three origins (the
// notebook, the Python runtime, and a data store), every document under the notebook's real
// CSP, and drive the Notebook interface through its own UI.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { notebookCsp } from "../bin/notebook-csp.mjs";
import { INVENTORY, prepareNotebookSite, verifyNotebookSite } from "../bin/prepare-notebook.mjs";

export const HERE = fileURLToPath(new URL(".", import.meta.url));
export const PKG = resolve(HERE, "..");
export const ENGINE_PKG = resolve(PKG, "..", "browser-python");
export const RUNTIME_DIR = process.env.BROWSER_PYTHON_RUNTIME_DIR ?? join(ENGINE_PKG, ".runtime");
export const ZARR_FIXTURES = join(ENGINE_PKG, "tests", "fixtures");
export const ADDONS_DIR = process.env.BROWSER_PYTHON_ADDONS_DIR ?? join(ENGINE_PKG, ".addons");
export const TEST_WORKERS = join(ENGINE_PKG, "browser-tests", "test-worker");
export const SITE_DIR = join(PKG, ".test-site");
export const ENGINES = ["chromium", "firefox", "webkit"];
export const ENGINE = process.env.BROWSER_ENGINE ?? "chromium";
export const STRICT = process.env.BROWSER_STRICT === "1";
export const EXIT_NOT_RUN = 3;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ipynb": "application/json",
  ".webmanifest": "application/manifest+json",
  ".zip": "application/zip",
  ".whl": "application/octet-stream",
};

/**
 * A static origin. `mounts` maps a path prefix to a directory; `override(path)` may return a file
 * to serve instead (a tampered wheel, a JSPI-less worker), or a Buffer.
 */
export function origin(mounts, { headers = () => ({}), override = () => null, cors = false } = {}) {
  const log = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const extra = cors ? { "access-control-allow-origin": "*" } : {};
    const replaced = override(path);
    if (Buffer.isBuffer(replaced)) {
      log.push(`200 ${path} (override)`);
      res.writeHead(200, {
        "content-type": TYPES[extname(path)] ?? "application/octet-stream",
        ...extra,
        ...headers(path),
      });
      res.end(replaced);
      return;
    }
    for (const [prefix, dir] of Object.entries(mounts)) {
      if (!path.startsWith(prefix)) continue;
      let file = replaced ?? normalize(join(dir, path.slice(prefix.length)));
      if (!replaced && !file.startsWith(normalize(dir))) break;
      try {
        if (statSync(file).isDirectory()) file = join(file, "index.html");
        const size = statSync(file).size;
        res.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "content-length": size,
          "cache-control": "no-store",
          ...extra,
          ...headers(path),
        });
        createReadStream(file).pipe(res);
        log.push(`200 ${path}`);
        return;
      } catch {
        break;
      }
    }
    log.push(`404 ${path}`);
    res.writeHead(404, { "content-type": "text/plain", ...extra });
    res.end("not found");
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({
        url: `http://127.0.0.1:${server.address().port}`,
        log,
        close: () => new Promise((r) => server.close(r)),
      }),
    ),
  );
}

export const FIXTURE_NOTEBOOKS = ["fixture.ipynb", "interrupt.ipynb", "scratch.ipynb"];

/** The runtime URL baked into the test site's settings: a placeholder origin, rewritten below. */
const RUNTIME_PLACEHOLDER = "http://runtime.invalid/";

/**
 * Build (or reuse) the test site. Rebuilt when the prebuilt extension or the fixtures change.
 * Needs Python 3.10+ and the network the first time, for the pinned toolchain.
 */
export async function testSite({ setups, name = "default", lab, seeds = [] } = {}) {
  const ext = readFileSync(join(PKG, "labextension", "package.json"));
  const fixtures = FIXTURE_NOTEBOOKS.map((n) => readFileSync(join(HERE, "fixtures", n)));
  const hash = createHash("sha256")
    .update(ext)
    .update(JSON.stringify(setups ?? null))
    .update(name)
    .update(Buffer.concat(fixtures));
  // A Lab site is rebuilt when any of its extensions, its pins or its options change.
  if (lab) {
    hash.update(JSON.stringify({ ...lab, extensions: undefined, files: undefined }));
    for (const dir of lab.extensions ?? []) hash.update(readFileSync(join(dir, "package.json")));
    if (lab.requirements) hash.update(readFileSync(lab.requirements));
    for (const file of lab.files ?? [])
      hash.update(file.path).update(file.text ?? file.bytes ?? "");
  }
  for (const seed of seeds) hash.update(seed.name).update(seed.text ?? readFileSync(seed.path));
  const key = hash.digest("hex").slice(0, 16);
  const dir = `${SITE_DIR}-${key}`;
  if (!existsSync(join(dir, INVENTORY)) || verifyNotebookSite(dir).length > 0) {
    await prepareNotebookSite({
      out: dir,
      settings: {
        runtimeIndexUrl: RUNTIME_PLACEHOLDER,
        setups: setups ?? [
          { id: "xarray-zarr", label: "xarray-zarr", profile: "xarray-zarr", addons: [] },
        ],
        interruptGraceMs: 2000,
      },
      seeds: [
        ...FIXTURE_NOTEBOOKS.map((name) => ({ name, path: join(HERE, "fixtures", name) })),
        ...seeds,
      ],
      ...(lab ? { lab } : {}),
      log: () => {},
    });
  }
  return dir;
}

/**
 * Serve a site: notebook origin, runtime origin and data origin. The notebook origin's
 * jupyter-lite.json is served with the runtime placeholder replaced by the real runtime origin.
 */
export async function serveSite(
  site,
  {
    workerOverride,
    runtimeOverride,
    replacements = {},
    connectSources = [],
    frameSources = [],
    override,
  } = {},
) {
  // Add-ons are served "beside the runtime", where the engine looks for them by default.
  const runtime = await origin(
    { "/python-addons/": ADDONS_DIR, "/": RUNTIME_DIR },
    { cors: true, override: runtimeOverride ?? (() => null) },
  );
  const data = await origin({ "/": ZARR_FIXTURES }, { cors: true });
  const urls = { runtime: runtime.url, data: data.url, notebook: "" };
  const csp = notebookCsp({
    runtimeIndexUrl: `${runtime.url}/`,
    connectSources: [data.url, ...connectSources],
    frameSources,
  });
  const notebook = await origin(
    { "/": site },
    {
      // The policy on EVERY response a document or worker can come from, as a deployment sends it.
      headers: (path) =>
        /\.(html|m?js)$|\/$/.test(path) ? { "content-security-policy": csp } : {},
      override: (path) => {
        if (override) {
          const replaced = override(path, urls);
          if (replaced) return replaced;
        }
        if (/\/jupyter-lite\.(json|ipynb)$/.test(path) && existsSync(join(site, path))) {
          let text = readFileSync(join(site, path), "utf8").replaceAll(
            RUNTIME_PLACEHOLDER,
            `${runtime.url}/`,
          );
          const pairs = typeof replacements === "function" ? replacements(urls) : replacements;
          for (const [from, to] of Object.entries(pairs)) text = text.replaceAll(from, to);
          return Buffer.from(text);
        }
        if (workerOverride) {
          const replaced = workerOverride(path);
          if (replaced) return replaced;
        }
        return null;
      },
    },
  );
  urls.notebook = notebook.url;
  return {
    notebook,
    runtime,
    data,
    csp,
    close: async () => {
      await notebook.close();
      await runtime.close();
      await data.close();
    },
  };
}

export async function launch() {
  const playwright = await import("playwright");
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  return playwright[ENGINE].launch({
    ...(override && ENGINE === "chromium" ? { executablePath: override } : {}),
    args: ENGINE === "chromium" ? ["--no-sandbox"] : [],
  });
}

/** A page that records CSP violations, page errors and every requested origin. */
export async function instrumentedPage(context) {
  const page = await context.newPage();
  const record = { violations: [], errors: [], origins: new Set(), console: [] };
  context.on("request", (r) => record.origins.add(new URL(r.url()).origin));
  page.on("pageerror", (e) => record.errors.push(String(e?.message ?? e)));
  page.on("console", (m) => {
    const text = m.text();
    record.console.push(`${m.type()}: ${text.slice(0, 300)}`);
    if (/Content Security Policy|Refused to/i.test(text))
      record.violations.push(text.slice(0, 300));
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return { page, record };
}

export async function violations(page, record) {
  const inPage = await page.evaluate(() => window.__cspViolations ?? []).catch(() => []);
  return [...inPage, ...record.violations];
}

// the Notebook interface

export async function openNotebook(page, base, path) {
  await page.goto(`${base}/notebooks/index.html?path=${encodeURIComponent(path)}`);
  await page.waitForSelector(".jp-Notebook .jp-Cell", { state: "attached", timeout: 60_000 });
  await kernelIdle(page, 120_000);
}

/** Wait until the kernel reports idle (after starting, or after the last request). */
export async function kernelIdle(page, timeout = 120_000) {
  await page.waitForFunction(
    () => {
      const status = document.querySelector(".jp-Notebook-ExecutionIndicator[data-status]");
      const running = [...document.querySelectorAll(".jp-InputPrompt")].some((p) =>
        p.textContent.includes("*"),
      );
      return status?.getAttribute("data-status") === "idle" && !running;
    },
    null,
    { timeout },
  );
}

export async function menu(page, top, item) {
  await page.click(`.lm-MenuBar-itemLabel:text-is("${top}")`);
  await page.click(`.lm-Menu-itemLabel:text-is("${item}")`);
}

/** Every code/markdown cell: its prompt (execution count) and its outputs' HTML and text. */
export async function cells(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".jp-Notebook .jp-Cell")].map((cell) => ({
      kind: cell.classList.contains("jp-CodeCell") ? "code" : "markdown",
      prompt: cell.querySelector(".jp-InputPrompt")?.textContent?.trim() ?? "",
      html:
        cell.querySelector(".jp-OutputArea")?.innerHTML ??
        cell.querySelector(".jp-RenderedMarkdown")?.innerHTML ??
        "",
      text: cell.querySelector(".jp-OutputArea")?.textContent ?? "",
    })),
  );
}

/** Replace the active cell's source without keystroke side effects (auto-indent, auto-close). */
export async function setCell(page, index, source) {
  const editor = page.locator(".jp-Notebook .jp-Cell").nth(index).locator(".cm-content");
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(source);
}

export function report(title, checks) {
  let failed = 0;
  console.log(`\n${title} [${ENGINE}]`);
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(
      `  ${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : `\n        ${c.detail}`}`,
    );
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  return failed === 0 ? 0 : 1;
}
