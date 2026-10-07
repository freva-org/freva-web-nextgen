#!/usr/bin/env node
/**
 * Build the operator's notebook site: a pinned JupyterLite 0.8.5 build, Notebook interface only,
 * with the Freva Python kernel and nothing else. Run by `portal-builder prepare-notebook`; usable on
 * its own. Nothing here is hosted by us: the toolchain comes from PyPI (hash-pinned, isolated
 * environment), the extension from this package, and the output is the operator's to serve.
 *
 * What the output guarantees, and `verifyNotebookSite` re-checks:
 *   - no inline <script> (other than JSON data) and no <style>: both are moved to files, so the
 *     notebook document runs under `script-src 'self'` with no hash and no `unsafe-inline`;
 *   - no service worker, no Lab interface, no stock kernels, no external extension discovery;
 *   - an inventory of every file with its SHA-256.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");

export const LITE_CORE_VERSION = "0.8.5";
export const INVENTORY = "NOTEBOOK-INVENTORY.json";
export const INVENTORY_SCHEMA = 1;
export const KERNEL_SETTINGS_KEY = "@freva-org/jupyterlite-freva-kernel:kernel";
/** Plugins switched off in the built site, and why. */
export const DISABLED_EXTENSIONS = [
  // Replaced by this package's eval-free registry (Ajv compiles schemas with `new Function`).
  "@jupyterlab/apputils-extension:settings",
  // No service worker is shipped.
  "@jupyterlite/application-extension:service-worker-manager",
  // Renders application/javascript outputs by evaluating them.
  "@jupyterlab/javascript-extension",
  // Vega compiles expressions with `new Function`; no kernel here emits Vega.
  "@jupyterlab/vega5-extension",
];
/** Apps kept: the Notebook interface (notebooks + its file browser). */
export const APPS = ["notebooks", "tree"];
/** With `lab`: a trimmed JupyterLab interface beside the Notebook interface. */
export const LAB_APPS = ["lab", "notebooks", "tree"];
/** A fixed timestamp for reproducible output. */
export const SOURCE_DATE_EPOCH = 1_759_276_800; // 2025-10-01T00:00:00Z

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * This preparation's revision: the digest of this file. A site records it, and a site prepared by
 * another revision is prepared again (a reused one would miss what this revision does).
 */
export const PREPARE_DIGEST = sha256(readFileSync(fileURLToPath(import.meta.url)));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** The pinned requirements: `[{ name, version, sha256 }]`, parsed from lite-requirements.txt. */
export function pinnedRequirements(file = join(HERE, "lite-requirements.txt")) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => {
      const match = /^([A-Za-z0-9_.-]+)==([^\s]+)\s+--hash=sha256:([0-9a-f]{64})\s*$/.exec(line);
      if (!match) throw new Error(`lite-requirements.txt: not pinned with a hash: ${line}`);
      return { name: match[1], version: match[2], sha256: match[3] };
    });
}

function python(executable) {
  let version;
  try {
    version = execFileSync(
      executable,
      ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
      {
        encoding: "utf8",
      },
    ).trim();
  } catch (error) {
    throw new Error(
      `prepare-notebook needs Python 3.10 or later to run the JupyterLite build, and ` +
        `${executable} could not be run (${error.message.split("\n")[0]}). Set --python or ` +
        `FREVA_PYTHON.`,
    );
  }
  const [major, minor] = version.split(".").map(Number);
  if (major !== 3 || minor < 10) {
    throw new Error(`prepare-notebook needs Python 3.10 or later; ${executable} is ${version}.`);
  }
  return version;
}

/** An isolated environment holding exactly the pinned toolchain, cached by the pins' digest. */
export function liteEnvironment({ executable = "python3", cacheDir, log = console.log } = {}) {
  const req = join(HERE, "lite-requirements.txt");
  const key = sha256(readFileSync(req)).slice(0, 16);
  const root =
    cacheDir ?? process.env.FREVA_NOTEBOOK_CACHE ?? join(homedir(), ".cache", "freva-jupyterlite");
  const env = join(root, `lite-${key}`);
  const bin = join(env, process.platform === "win32" ? "Scripts" : "bin");
  const stamp = join(env, ".complete");
  if (!existsSync(stamp)) {
    python(executable);
    rmSync(env, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    log(`notebook: creating the build environment (${env})`);
    execFileSync(executable, ["-m", "venv", env], { stdio: "inherit" });
    execFileSync(
      join(bin, "python"),
      [
        "-m",
        "pip",
        "install",
        "--isolated",
        "--disable-pip-version-check",
        "--quiet",
        "--require-hashes",
        "--no-deps",
        "--only-binary=:all:",
        "-r",
        req,
      ],
      { stdio: "inherit" },
    );
    writeFileSync(stamp, `${key}\n`);
  }
  // What is installed must be exactly the pins, every time: a cache can be tampered with.
  const frozen = execFileSync(join(bin, "python"), ["-m", "pip", "freeze", "--isolated", "--all"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.toLowerCase().replace(/_/g, "-"))
    .filter((line) => !/^(pip|setuptools|wheel)==/.test(line));
  const wanted = pinnedRequirements(req).map(
    (r) => `${r.name.toLowerCase().replace(/_/g, "-")}==${r.version}`,
  );
  const extra = frozen.filter((line) => !wanted.includes(line));
  const missing = wanted.filter((line) => !frozen.includes(line));
  if (extra.length || missing.length) {
    throw new Error(
      `The JupyterLite build environment ${env} does not match the pins ` +
        `(extra: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}). ` +
        `Delete it and run prepare-notebook again.`,
    );
  }
  return { env, bin, key };
}

/**
 * Download pinned, hash-checked wheels (`name==version --hash=sha256:...` lines) into a cache and
 * return their paths. Nothing is installed: JupyterLite reads a wheel's prebuilt extension
 * directly. pip verifies every hash (`--require-hashes`); the files are re-hashed here as well.
 */
export function pinnedWheels({ requirements, bin, cacheDir, log = console.log }) {
  const pins = pinnedRequirements(requirements);
  const key = sha256(readFileSync(requirements)).slice(0, 16);
  const root =
    cacheDir ?? process.env.FREVA_NOTEBOOK_CACHE ?? join(homedir(), ".cache", "freva-jupyterlite");
  const dir = join(root, `wheels-${key}`);
  const stamp = join(dir, ".complete");
  if (!existsSync(stamp)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    log(`notebook: downloading ${pins.length} pinned extension wheels (${dir})`);
    execFileSync(
      join(bin, "python"),
      [
        "-m",
        "pip",
        "download",
        "--isolated",
        "--disable-pip-version-check",
        "--quiet",
        "--require-hashes",
        "--no-deps",
        "--only-binary=:all:",
        "--dest",
        dir,
        "-r",
        requirements,
      ],
      { stdio: "inherit" },
    );
    writeFileSync(stamp, `${key}\n`);
  }
  const wheels = readdirSync(dir).filter((f) => f.endsWith(".whl"));
  const byDigest = new Map(wheels.map((f) => [sha256(readFileSync(join(dir, f))), join(dir, f)]));
  return pins.map((pin) => {
    const path = byDigest.get(pin.sha256);
    if (!path) {
      throw new Error(
        `The wheel for ${pin.name}==${pin.version} in ${dir} does not match its pinned hash. ` +
          `Delete the directory and prepare again.`,
      );
    }
    return { ...pin, path };
  });
}

/** The federated extensions a wheel ships (their package.json names and versions). */
export function wheelExtensions(wheel, bin) {
  const out = execFileSync(
    join(bin, "python"),
    [
      "-c",
      [
        "import json, sys, zipfile",
        "z = zipfile.ZipFile(sys.argv[1])",
        "names = [n for n in z.namelist() if '/share/jupyter/labextensions/' in n and n.endswith('/package.json') and n.count('/') in (6, 7)]",
        "res = []",
        "for n in names:",
        "    d = json.loads(z.read(n))",
        "    if d.get('jupyterlab'): res.append({'name': d['name'], 'version': d.get('version', '')})",
        "print(json.dumps(res))",
      ].join("\n"),
      wheel,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

/** A file the site build adds: a path inside the site, and its bytes. */
function addedFilePath(path) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(path) ||
    path.includes("..")
  ) {
    throw new Error(`Not a plain site path: ${JSON.stringify(path)}`);
  }
  if (path === INVENTORY || path === "jupyter-lite.json") throw new Error(`${path} is reserved`);
  return path;
}

/** The Notebook interface's plugin that swaps the tab icon with the kernel's status. */
export const TAB_ICON_PLUGIN = "@jupyter-notebook/notebook-extension:tab-icon";

/**
 * The site's own tab icon: written at the site root, and linked from every page (before
 * JupyterLite's own scripts), so no page shows JupyterLite's. JupyterLite's boot script appends
 * one more icon link from `faviconUrl` (last, so the browser uses it): every jupyter-lite.json
 * names the site's icon there too, relative to that file as JupyterLite resolves it.
 */
export function linkFavicon(siteDir, favicon) {
  writeFileSync(join(siteDir, favicon.path), favicon.bytes);
  const type = String(favicon.type).replace(/[^\w./+-]/g, "");
  const up = (file) =>
    "../".repeat(relative(siteDir, dirname(file)).split(sep).filter(Boolean).length);
  const root = join(siteDir, "jupyter-lite.json");
  for (const file of walk(siteDir).filter((p) => basename(p) === "jupyter-lite.json")) {
    const config = JSON.parse(readFileSync(file, "utf8"));
    const data = config["jupyter-config-data"];
    // The root's always (the default for every app); an app's own only where it sets one.
    if (!data || (file !== root && !("faviconUrl" in data))) continue;
    data.faviconUrl = `./${up(file)}${favicon.path}`;
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }
  for (const page of walk(siteDir).filter((p) => p.endsWith(".html"))) {
    const href = `${up(page)}${favicon.path}`;
    let html = readFileSync(page, "utf8");
    html = html.replace(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*>\s*/gi, "");
    const link = `<link rel="icon" type="${type}" href="${href}" class="idle favicon">`;
    if (!/<\/head>/i.test(html)) continue;
    html = html.replace(/<\/head>/i, `${link}\n</head>`);
    writeFileSync(page, html);
  }
}

/**
 * The policy without the directives a `<meta>` tag cannot deliver (`frame-ancestors`,
 * `report-uri`, `report-to`, `sandbox`), and the ones dropped.
 */
export function metaPolicyOf(policy) {
  const dropped = [];
  const kept = String(policy)
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => {
      const name = d.split(/\s+/)[0].toLowerCase();
      if (["frame-ancestors", "report-uri", "report-to", "sandbox"].includes(name)) {
        dropped.push(name);
        return false;
      }
      return true;
    });
  return { policy: kept.join("; "), dropped };
}

const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * The page as a browser's HTML parser builds it, with each node's source offsets. A browser drops
 * a byte order mark before parsing; `shift` maps the offsets back onto `html`.
 */
const parsePage = (html) => {
  const shift = html.startsWith("\uFEFF") ? 1 : 0;
  const document = parse(html.slice(shift), {
    sourceCodeLocationInfo: true,
    scriptingEnabled: true,
  });
  return { document, shift };
};

const elements = (node) =>
  (node.childNodes ?? []).filter((child) => child.namespaceURI === HTML_NS);

const attribute = (element, name) => element.attrs.find((a) => a.name === name)?.value;

// Values are already decoded (`&#45;`), and duplicate attributes dropped, as a browser does.
const isCspMeta = (element) =>
  element.nodeName === "meta" &&
  (attribute(element, "http-equiv") ?? "").trim().toLowerCase() === "content-security-policy";

/** Every CSP meta element in the parsed page (template contents and `<noscript>` are inert). */
function cspMetaElements(document) {
  const found = [];
  const visit = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.namespaceURI === HTML_NS && isCspMeta(child)) found.push(child);
      visit(child);
    }
  };
  visit(document);
  return found;
}

const isCharset = (element) =>
  element?.nodeName === "meta" && attribute(element, "charset") !== undefined;

/** The first node, in document order, that the source spells out. */
const firstInSource = (nodes) => {
  for (const node of nodes) {
    if (node.sourceCodeLocation) return node;
    const inner = firstInSource(node.childNodes ?? []);
    if (inner) return inner;
  }
  return undefined;
};

const headOf = (document) => {
  const html = elements(document).find((e) => e.nodeName === "html");
  return html && elements(html).find((e) => e.nodeName === "head");
};

/**
 * Every Content-Security-Policy `<meta>` element in a page, as a browser's parser finds it
 * (character references, quoting, raw text and comments included). Returns each one's span.
 */
export function cspMetaTags(html) {
  const { document, shift } = parsePage(html);
  return cspMetaElements(document).map(({ sourceCodeLocation: at }) => ({
    start: at.startOffset + shift,
    end: at.endOffset + shift,
  }));
}

const metaTag = (policy) =>
  `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;

/**
 * Why the page's policy is not exactly `policy`, or null: one CSP meta element in all, the first
 * in `<head>` (after a leading `<meta charset>`, which must stay in the first 1024 bytes and
 * loads nothing), so it governs everything the page loads.
 */
export function pageMetaPolicyProblem(html, policy) {
  const { document } = parsePage(html);
  const all = cspMetaElements(document);
  const head = elements(headOf(document) ?? {});
  const first = isCharset(head[0]) ? head[1] : head[0];
  if (!first || !isCspMeta(first) || attribute(first, "content") !== policy) {
    return "does not start with the site's meta policy";
  }
  return all.length === 1 ? null : "carries another meta policy beside the site's";
}

/**
 * The page with `policy` as its only CSP meta element, first in `<head>`. Every other policy goes
 * (a browser enforces them all); nothing else in the page changes.
 */
export function setMetaPolicy(html, policy) {
  if (pageMetaPolicyProblem(html, policy) === null) return html;
  const { document, shift } = parsePage(html);
  const edits = cspMetaElements(document).map(({ sourceCodeLocation: at }) => ({
    start: at.startOffset + shift,
    end: at.endOffset + shift,
    text: "",
  }));
  const head = headOf(document);
  const children = elements(head);
  let at;
  if (isCharset(children[0]) && !isCspMeta(children[0])) {
    at = children[0].sourceCodeLocation.endOffset + shift;
  } else if (head.sourceCodeLocation?.startTag) {
    at = head.sourceCodeLocation.startTag.endOffset + shift;
  } else {
    // No `<head>` tag: before the first thing the parser put in the head, or that ended it.
    const next = firstInSource(head.parentNode.childNodes);
    at = next ? next.sourceCodeLocation.startOffset + shift : html.length;
  }
  edits.push({ start: at, end: at, text: `\n${metaTag(policy)}\n` });
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = html;
  for (const { start, end, text } of edits) out = out.slice(0, start) + text + out.slice(end);
  const problem = pageMetaPolicyProblem(out, policy);
  if (problem) throw new Error(`The meta policy could not be placed: the page ${problem}`);
  return out;
}

/**
 * The policy as each page's first `<head>` element, before anything it governs loads: for a host
 * that sends no headers (GitHub Pages). `policy` is already meta-safe (`metaPolicyOf`).
 */
export function writeMetaPolicy(siteDir, policy) {
  for (const page of walk(siteDir).filter((p) => p.endsWith(".html"))) {
    try {
      writeFileSync(page, setMetaPolicy(readFileSync(page, "utf8"), policy));
    } catch (error) {
      throw new Error(`${relative(siteDir, page)}: ${error.message}`);
    }
  }
}

/** Pages whose policy is not exactly the recorded meta policy (`pageMetaPolicyProblem`). */
export function metaPolicyProblems(siteDir, policy) {
  const problems = [];
  for (const page of walk(siteDir).filter((p) => p.endsWith(".html"))) {
    const problem = pageMetaPolicyProblem(readFileSync(page, "utf8"), policy);
    if (problem) problems.push(`${relative(siteDir, page)} ${problem}`);
  }
  return problems;
}

/** Where the site's configs do not name its own tab icon (see `linkFavicon`). */
export function faviconProblems(siteDir, path) {
  const problems = [];
  const root = join(siteDir, "jupyter-lite.json");
  for (const file of walk(siteDir).filter((p) => basename(p) === "jupyter-lite.json")) {
    let data;
    try {
      data = JSON.parse(readFileSync(file, "utf8"))["jupyter-config-data"];
    } catch {
      continue;
    }
    if (!data || (file !== root && !("faviconUrl" in data))) continue;
    const depth = relative(siteDir, dirname(file)).split(sep).filter(Boolean).length;
    if (data.faviconUrl !== `./${"../".repeat(depth)}${path}`) {
      problems.push(`${relative(siteDir, file)} does not name the site's tab icon (faviconUrl)`);
    }
  }
  return problems;
}

/** jupyter-lite.json for the site. Every value is the operator's, never a visitor's. */
export function liteConfig({
  settings,
  appName = "Freva Notebook",
  disabledExtensions = DISABLED_EXTENSIONS,
}) {
  return {
    "jupyter-lite-schema-version": 0,
    "jupyter-config-data": {
      appName,
      defaultKernelName: "freva-python",
      contentsAllJsonFile: "all.json",
      disabledExtensions: [...disabledExtensions],
      exposeAppInBrowser: false,
      litePluginSettings: { [KERNEL_SETTINGS_KEY]: settings },
    },
  };
}

/**
 * Move inline bootstrap scripts and style blocks into files beside each page, so the page needs
 * neither `unsafe-inline` nor a hash for them. Returns the files written.
 */
export function externalizeInline(siteDir) {
  const written = [];
  for (const page of walk(siteDir).filter((p) => p.endsWith(".html"))) {
    let html = readFileSync(page, "utf8");
    const before = html;
    html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/g, (whole, attrs, body) => {
      if (/application\/json/.test(attrs) || /\bsrc=/.test(attrs)) return whole;
      const module = /type="module"/.test(attrs);
      const name = `lite-boot-${sha256(body).slice(0, 12)}.${module ? "mjs" : "js"}`;
      writeFileSync(join(dirname(page), name), `${body.trim()}\n`);
      written.push(join(dirname(page), name));
      return `<script${module ? ' type="module"' : ""} src="./${name}"></script>`;
    });
    html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (_whole, _attrs, body) => {
      const name = `lite-boot-${sha256(body).slice(0, 12)}.css`;
      writeFileSync(join(dirname(page), name), `${body.trim()}\n`);
      written.push(join(dirname(page), name));
      return `<link rel="stylesheet" href="./${name}">`;
    });
    // Only reached without JavaScript; removed so no style attribute is left anywhere.
    html = html.replace(/(<noscript>\s*<div)\s+style="[^"]*"/g, "$1");
    if (html !== before) writeFileSync(page, html);
  }
  return written;
}

/** Copy seed notebooks into `files/` and write the contents index Lite reads. */
function writeSeeds(siteDir, from, names) {
  const stamp = new Date(SOURCE_DATE_EPOCH * 1000).toISOString();
  const entry = (path, size, type = "notebook") => ({
    content: null,
    created: stamp,
    format: null,
    hash: null,
    hash_algorithm: null,
    last_modified: stamp,
    mimetype: null,
    name: path.split("/").pop(),
    path,
    size,
    type,
    writable: true,
  });
  // One level of folders at most: `examples/x.ipynb`. Each folder gets its own index.
  const folders = new Map([["", []]]);
  for (const name of [...names].sort()) {
    const dir = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
    mkdirSync(join(siteDir, "files", dir), { recursive: true });
    cpSync(join(from, name), join(siteDir, "files", name));
    if (!folders.has(dir)) {
      folders.set(dir, []);
      folders.get("").push(entry(dir, null, "directory"));
    }
    folders.get(dir).push(entry(name, readFileSync(join(from, name)).length));
  }
  for (const [dir, content] of folders) {
    const target = join(siteDir, "api", "contents", dir);
    mkdirSync(target, { recursive: true });
    const index = { ...entry(dir, null, "directory"), content, format: "json" };
    writeFileSync(join(target, "all.json"), `${JSON.stringify(index, null, 2)}\n`);
  }
}

/**
 * The plugin ids (or whole packages) named in `ids` that do not occur in the built application:
 * a disabled id that is not there disables nothing, which is a typo or a JupyterLite upgrade.
 */
export function missingPluginIds(siteDir, ids) {
  const bundles = walk(siteDir).filter(
    (f) =>
      f.endsWith(".js") &&
      (f.includes(`${sep}build${sep}`) || f.includes(`${sep}extensions${sep}`)),
  );
  // No application bundle (a stand-in site in a unit test): nothing to check against.
  if (!bundles.some((f) => f.includes(`${sep}build${sep}`))) return [];
  const haystack = bundles.map((f) => readFileSync(f, "utf8")).join("\n");
  return ids.filter(
    (id) =>
      !haystack.includes(`"${id}"`) &&
      !haystack.includes(`'${id}'`) &&
      !haystack.includes(`"${id}:`),
  );
}

/**
 * What a built site must satisfy. Returns problems; empty means it may be deployed. `expect`
 * names what was asked for: the apps, the federated extensions and the disabled plugins.
 */
export function auditSite(
  siteDir,
  expect = {
    apps: APPS,
    extensions: ["@freva-org/jupyterlite-freva-kernel"],
    disabledExtensions: DISABLED_EXTENSIONS,
  },
) {
  const problems = [];
  const files = walk(siteDir);
  for (const page of files.filter((p) => p.endsWith(".html"))) {
    const html = readFileSync(page, "utf8");
    const rel = relative(siteDir, page);
    for (const [, attrs] of html.matchAll(/<script([^>]*)>/g)) {
      if (!/\bsrc=/.test(attrs) && !/application\/json/.test(attrs)) {
        problems.push(`${rel}: inline <script> remains`);
      }
    }
    if (/<style[\s>]/.test(html)) problems.push(`${rel}: <style> block remains`);
    if (/\son[a-z]+\s*=/i.test(html.replace(/<script[\s\S]*?<\/script>/g, ""))) {
      problems.push(`${rel}: inline event handler`);
    }
    for (const [, url] of html.matchAll(/\b(?:src|href)="(https?:\/\/[^"]+)"/g)) {
      problems.push(`${rel}: loads ${url}`);
    }
  }
  for (const f of files.filter((f) => basename(f) === "service-worker.js")) {
    problems.push(`a service worker is present: ${relative(siteDir, f)}`);
  }
  for (const app of ["lab", "repl", "consoles", "edit"]) {
    if (!expect.apps.includes(app) && existsSync(join(siteDir, app))) {
      problems.push(`the ${app} interface is present`);
    }
  }
  if (expect.apps.includes("lab") && !existsSync(join(siteDir, "lab", "index.html"))) {
    problems.push("the lab interface is missing");
  }
  for (const css of files.filter((f) => f.endsWith(".css"))) {
    for (const [, url] of readFileSync(css, "utf8").matchAll(
      /url\(\s*["']?(https?:\/\/[^"')]+)/g,
    )) {
      problems.push(`${relative(siteDir, css)}: loads ${url}`);
    }
  }
  const config = JSON.parse(readFileSync(join(siteDir, "jupyter-lite.json"), "utf8"));
  const data = config["jupyter-config-data"] ?? {};
  const extensions = (data.federated_extensions ?? []).map((e) => e.name).sort();
  const wanted = [...expect.extensions].sort();
  if (extensions.join() !== wanted.join()) {
    problems.push(
      `unexpected federated extensions: ${extensions.join(", ") || "none"} (expected ${wanted.join(", ")})`,
    );
  }
  for (const id of expect.disabledExtensions) {
    if (!(data.disabledExtensions ?? []).includes(id)) problems.push(`${id} is not disabled`);
  }
  for (const id of missingPluginIds(siteDir, expect.disabledExtensions)) {
    problems.push(`${id} is disabled but is not a plugin of this JupyterLite build`);
  }
  return problems;
}

/** Every file with its digest, sorted, excluding the inventory itself. */
export function siteFiles(siteDir) {
  return walk(siteDir)
    .map((path) => relative(siteDir, path).split(sep).join("/"))
    .filter((path) => path !== INVENTORY)
    .sort()
    .map((path) => {
      const bytes = readFileSync(join(siteDir, path));
      return { path, sha256: sha256(bytes), bytes: bytes.length };
    });
}

/**
 * Prepare the site into `out` (atomically: staged beside it, renamed into place).
 *
 * @param {object} options
 * @param {string} options.out
 * @param {object} options.settings  the kernel settings (see the package README)
 * @param {Array<{name: string, path?: string, text?: string}>} [options.seeds]  seed notebooks:
 *   `name` is `x.ipynb` or `folder/x.ipynb`; the content is `text`, or read from `path`
 * @param {string} [options.appName]  the app's name (the browser tab's title)
 * @param {{path: string, bytes: Uint8Array, type: string}} [options.favicon]  the site's own tab
 *   icon (`path` at the site root, e.g. `favicon.svg`): every page links it, and the Notebook
 *   interface's kernel-status icon swap is disabled so it stays
 * @param {string} [options.metaPolicy]  a Content-Security-Policy written into every page as its
 *   first `<head>` element, for a host that sends no headers; without the directives a meta tag
 *   cannot deliver (`metaPolicyOf`)
 * @param {object} [options.lab]  also build a trimmed JupyterLab interface: `extensions` (prebuilt
 *   extension directories), `requirements` (a pins file of wheels carrying prebuilt extensions,
 *   downloaded hash-checked), `overrides` (settings overrides), `disabledExtensions` (plugin ids,
 *   each checked against the build) and `files` (`{ path, text | bytes }` added to the site)
 */
export async function prepareNotebookSite({
  out,
  settings,
  seeds = [],
  appName = "Freva Notebook",
  favicon,
  pythonExecutable = process.env.FREVA_PYTHON ?? "python3",
  cacheDir,
  labextension = join(PKG, "labextension"),
  lab,
  metaPolicy,
  log = console.log,
}) {
  if (metaPolicy !== undefined && metaPolicyOf(metaPolicy).dropped.length > 0) {
    throw new Error(
      `The meta policy carries directives a <meta> tag cannot deliver: ${metaPolicyOf(metaPolicy).dropped.join(", ")}`,
    );
  }
  if (!existsSync(join(labextension, "package.json"))) {
    throw new Error(
      `The prebuilt extension is missing at ${labextension}. Install the published package, or ` +
        `run \`npm run build && npm run build:labextension\` in packages/jupyterlite-freva-kernel.`,
    );
  }
  const { parseNotebook } = await import("../lib/ipynb.js");
  const { bin } = liteEnvironment({ executable: pythonExecutable, cacheDir, log });
  const apps = lab ? LAB_APPS : APPS;
  const disabled = [
    ...DISABLED_EXTENSIONS,
    ...(favicon ? [TAB_ICON_PLUGIN] : []),
    ...(lab?.disabledExtensions ?? []),
  ].filter((id, i, all) => all.indexOf(id) === i);
  if (favicon && !/^favicon\.(svg|png|ico)$/.test(favicon.path)) {
    throw new Error(
      `The favicon is named favicon.svg, favicon.png or favicon.ico, not ${favicon.path}`,
    );
  }
  const extensionDirs = [labextension, ...(lab?.extensions ?? [])];
  const extensions = extensionDirs.map((dir) => {
    if (!existsSync(join(dir, "package.json"))) {
      throw new Error(`No prebuilt extension at ${dir} (package.json is missing).`);
    }
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return { name: pkg.name, version: pkg.version, source: "package" };
  });
  const wheels = lab?.requirements
    ? pinnedWheels({ requirements: lab.requirements, bin, cacheDir, log })
    : [];
  for (const wheel of wheels) {
    for (const ext of wheelExtensions(wheel.path, bin)) {
      extensions.push({ ...ext, source: `${wheel.name}==${wheel.version}` });
    }
  }
  const added = (lab?.files ?? []).map((file) => ({
    path: addedFilePath(file.path),
    bytes: file.bytes ?? Buffer.from(file.text ?? "", "utf8"),
  }));
  const work = mkdtempSync(join(tmpdir(), "freva-lite-"));
  const stage = `${out}.staging-${process.pid}`;
  try {
    const lite = join(work, "lite");
    const contents = join(work, "contents");
    mkdirSync(lite, { recursive: true });
    mkdirSync(contents, { recursive: true });
    writeFileSync(
      join(lite, "jupyter-lite.json"),
      `${JSON.stringify(liteConfig({ settings, appName, disabledExtensions: disabled }), null, 2)}\n`,
    );
    if (lab?.overrides) {
      writeFileSync(join(lite, "overrides.json"), `${JSON.stringify(lab.overrides, null, 2)}\n`);
    }
    // Every federated extension, named explicitly: the environment's own are ignored.
    writeFileSync(
      join(lite, "jupyter_lite_config.json"),
      `${JSON.stringify(
        {
          LiteBuildConfig: {
            federated_extensions: [...extensionDirs, ...wheels.map((w) => w.path)],
          },
        },
        null,
        2,
      )}\n`,
    );
    const seeded = [];
    for (const seed of seeds) {
      if (
        !/^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,60}\/)?[A-Za-z0-9][A-Za-z0-9 ._-]{0,120}\.ipynb$/.test(
          seed.name,
        )
      ) {
        throw new Error(
          `Seed notebook name ${JSON.stringify(seed.name)} is not a plain *.ipynb name.`,
        );
      }
      const text = seed.text ?? readFileSync(seed.path, "utf8");
      try {
        parseNotebook(text);
      } catch (error) {
        throw new Error(`Seed notebook ${seed.path} is not a valid notebook: ${error.message}`);
      }
      mkdirSync(dirname(join(contents, seed.name)), { recursive: true });
      writeFileSync(join(contents, seed.name), text);
      seeded.push(seed.name);
    }
    // Isolation: no user or system Jupyter paths, no user site-packages.
    const isolated = join(work, "jupyter");
    const env = {
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      HOME: work,
      JUPYTER_DATA_DIR: join(isolated, "data"),
      JUPYTER_CONFIG_DIR: join(isolated, "config"),
      JUPYTER_PATH: join(isolated, "path"),
      JUPYTER_CONFIG_PATH: join(isolated, "config-path"),
      JUPYTER_PLATFORM_DIRS: "1",
      PYTHONNOUSERSITE: "1",
      SOURCE_DATE_EPOCH: String(SOURCE_DATE_EPOCH),
    };
    const args = [
      "lite",
      "build",
      "--lite-dir",
      lite,
      "--output-dir",
      stage,
      ...apps.flatMap((app) => ["--apps", app]),
      "--ignore-sys-prefix",
      "--no-unused-shared-packages",
      "--no-sourcemaps",
      "--no-libarchive",
      "--source-date-epoch",
      String(SOURCE_DATE_EPOCH),
    ];
    log(`notebook: jupyter ${args.slice(0, 2).join(" ")} (JupyterLite ${LITE_CORE_VERSION})`);
    rmSync(stage, { recursive: true, force: true });
    execFileSync(join(bin, "jupyter"), args, { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });

    // Seed notebooks, indexed here rather than by jupyter_server (a large optional dependency
    // the pinned toolchain deliberately does not have). Read-only on the server: an edit is saved
    // to the visitor's browser storage, which is how a seed is "copied into a session".
    writeSeeds(stage, contents, seeded);
    // Prune what the Notebook interface does not use, then make the pages CSP-clean.
    for (const path of [
      "service-worker.js",
      "build/service-worker.js",
      "doc",
      "rspack.config.js",
      "rspack.config.analyze.js",
      "rspack.config.watch.js",
    ]) {
      rmSync(join(stage, path), { recursive: true, force: true });
    }
    externalizeInline(stage);
    // The Notebook interface swaps its tab icon from /static/favicons/; give it something to find.
    const liteIcon = join(stage, "notebooks", "favicon.ico");
    if (existsSync(liteIcon)) {
      mkdirSync(join(stage, "static", "favicons"), { recursive: true });
      for (const name of ["favicon.ico", "favicon-busy-1.ico", "favicon-notebook.ico"]) {
        cpSync(liteIcon, join(stage, "static", "favicons", name));
      }
      cpSync(liteIcon, join(stage, "favicon.ico"));
    }
    for (const file of added) {
      mkdirSync(dirname(join(stage, file.path)), { recursive: true });
      writeFileSync(join(stage, file.path), file.bytes);
    }
    if (favicon) linkFavicon(stage, favicon);
    // Last, so it is each page's first head element whatever else was added.
    if (metaPolicy) writeMetaPolicy(stage, metaPolicy);
    const expect = {
      apps,
      extensions: extensions.map((e) => e.name),
      disabledExtensions: disabled,
    };
    const problems = auditSite(stage, expect);
    if (problems.length > 0) {
      throw new Error(`The built notebook site failed its audit:\n  ${problems.join("\n  ")}`);
    }
    const extension = JSON.parse(readFileSync(join(labextension, "package.json"), "utf8"));
    const inventory = {
      schemaVersion: INVENTORY_SCHEMA,
      jupyterliteCore: LITE_CORE_VERSION,
      apps,
      kernel: { name: extension.name, version: extension.version },
      extensions,
      disabledExtensions: disabled,
      requirements: pinnedRequirements(),
      ...(wheels.length
        ? {
            extensionWheels: wheels.map(({ name, version, sha256 }) => ({ name, version, sha256 })),
          }
        : {}),
      ...(lab?.overrides ? { overridesSha256: sha256(JSON.stringify(lab.overrides)) } : {}),
      ...(added.length ? { added: added.map((f) => f.path).sort() } : {}),
      appName,
      ...(favicon ? { favicon: { path: favicon.path, sha256: sha256(favicon.bytes) } } : {}),
      ...(metaPolicy ? { metaPolicy } : {}),
      preparedBy: PREPARE_DIGEST,
      seeds: seeded,
      settingsSha256: sha256(JSON.stringify(settings)),
      entry: "notebooks/index.html",
      ...(lab ? { labEntry: "lab/index.html" } : {}),
      files: siteFiles(stage),
    };
    writeFileSync(join(stage, INVENTORY), `${JSON.stringify(inventory, null, 2)}\n`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(dirname(out), { recursive: true });
    renameSync(stage, out);
    log(`notebook: ${inventory.files.length} files in ${out}`);
    return inventory;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (error.stderr) {
      const detail = String(error.stderr).trim().split("\n").slice(-8).join("\n");
      throw new Error(`jupyter lite build failed:\n${detail}`);
    }
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Re-check a prepared site against its own inventory. Returns problems; empty means it verifies. */
export function verifyNotebookSite(siteDir) {
  const file = join(siteDir, INVENTORY);
  if (!existsSync(file)) return [`${INVENTORY} is missing from ${siteDir}`];
  let inventory;
  try {
    inventory = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return [`${INVENTORY} is not JSON: ${error.message}`];
  }
  if (inventory.schemaVersion !== INVENTORY_SCHEMA)
    return [`${INVENTORY} has an unknown schema version`];
  const problems = [];
  const recorded = new Map(inventory.files.map((f) => [f.path, f]));
  const present = siteFiles(siteDir);
  for (const f of present) {
    const want = recorded.get(f.path);
    if (!want) problems.push(`${f.path} is not in the inventory`);
    else if (want.sha256 !== f.sha256) problems.push(`${f.path} does not match its digest`);
    recorded.delete(f.path);
  }
  for (const path of recorded.keys()) problems.push(`${path} is missing`);
  if (inventory.favicon) problems.push(...faviconProblems(siteDir, inventory.favicon.path));
  if (inventory.metaPolicy) problems.push(...metaPolicyProblems(siteDir, inventory.metaPolicy));
  const expect = {
    apps: inventory.apps ?? APPS,
    extensions: inventory.extensions
      ? inventory.extensions.map((e) => e.name)
      : ["@freva-org/jupyterlite-freva-kernel"],
    disabledExtensions: inventory.disabledExtensions ?? DISABLED_EXTENSIONS,
  };
  return [...problems, ...auditSite(siteDir, expect)];
}

// CLI: prepare-notebook --out <dir> --settings <json file> [--seed name=path ...] [--python exe]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const take = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  if (argv[0] === "verify") {
    const problems = verifyNotebookSite(argv[1] ?? ".");
    for (const p of problems) console.error(`  ${p}`);
    console.log(problems.length === 0 ? "notebook site verifies" : `${problems.length} problems`);
    process.exit(problems.length === 0 ? 0 : 1);
  }
  const out = take("--out");
  const settingsFile = take("--settings");
  if (!out || !settingsFile) {
    console.error(
      "usage: prepare-notebook --out <dir> --settings <file.json> [--seed name=path] [--python exe]",
    );
    console.error("       prepare-notebook verify <dir>");
    process.exit(2);
  }
  const seeds = [];
  argv.forEach((arg, i) => {
    if (arg === "--seed") {
      const [name, ...rest] = argv[i + 1].split("=");
      seeds.push({ name, path: rest.join("=") });
    }
  });
  prepareNotebookSite({
    out,
    settings: JSON.parse(readFileSync(settingsFile, "utf8")),
    seeds,
    ...(take("--python") ? { pythonExecutable: take("--python") } : {}),
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
