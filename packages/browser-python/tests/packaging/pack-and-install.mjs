/**
 * Pack the package, install it somewhere else, and import it from there. The `dist/` in this
 * working tree is not what a consumer gets: `files`, `exports`, the worker's emitted path and the
 * `.d.ts` layout are all decided by the tarball, and each can be wrong in a way no test against
 * the source tree can see - the classic being a worker resolved through a path that exists here
 * and nowhere else.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const NAME = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).name;

const scratch = mkdtempSync(join(tmpdir(), "browser-python-pack-"));
let failures = 0;
const check = (name, pass, detail = "") => {
  console.log(`  ${pass ? "pass" : "FAIL"}  ${name}${detail ? `  - ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("=== packed package ===");
try {
  // --ignore-scripts: prepack runs check-bytes, which packs. See scripts/check-bytes.mjs.
  const out = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
    {
      cwd: PKG,
      encoding: "utf8",
    },
  );
  const [meta] = JSON.parse(out);
  const tarball = join(scratch, meta.filename);
  check(
    "npm pack produces a tarball",
    existsSync(tarball),
    `${meta.size} B, ${meta.entryCount} files`,
  );

  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "consumer", type: "module", private: true }),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock", tarball], {
    cwd: scratch,
    stdio: "pipe",
  });

  const installed = join(scratch, "node_modules", ...NAME.split("/"));
  check("it installs", existsSync(installed), installed.slice(scratch.length + 1));

  // The worker file at the exact path the default factory builds. A source-tree test cannot reach
  // this: the engine resolves `new URL("./worker/browser-python.worker.js", import.meta.url)`
  // against wherever `dist/index.js` ended up, so a missing or renamed emit is a consumer whose
  // `start()` never returns.
  check(
    "the worker is at the path the default factory resolves",
    existsSync(join(installed, "dist", "worker", "browser-python.worker.js")),
  );
  check("types are emitted", existsSync(join(installed, "dist", "index.d.ts")));

  // The public entry really exports what the README says it does, from the INSTALLED copy.
  const probe = join(scratch, "probe.mjs");
  writeFileSync(
    probe,
    `import * as api from "${NAME}";\n` +
      `console.log(JSON.stringify({\n` +
      `  createBrowserPython: typeof api.createBrowserPython,\n` +
      `  indexURL: api.DEFAULT_PYODIDE_INDEX_URL,\n` +
      `  validateDisplay: typeof api.validateDisplay,\n` +
      `  error: typeof api.BrowserPythonError,\n` +
      `}));\n`,
  );
  const exported = JSON.parse(
    execFileSync(process.execPath, [probe], { cwd: scratch, encoding: "utf8" }),
  );
  check("the entry point exports createBrowserPython", exported.createBrowserPython === "function");
  check("…and BrowserPythonError", exported.error === "function");
  check("…and the display validator", exported.validateDisplay === "function");
  check(
    "…and a PINNED runtime URL, not a moving one",
    /\/pyodide\/v[\d.]+\/full\/$/.test(exported.indexURL) && !exported.indexURL.includes("latest"),
    exported.indexURL,
  );

  // The CONSOLE entry points, from the installed tarball. Two things only a real install proves.
  // The stylesheet: `dist/console/styles.css` is copied by a build step rather than emitted by
  // `tsc`, so it is exactly the kind of file that survives in the working tree and vanishes from
  // the package. And that importing `/console` under Node works at all - it is documented as safe
  // during server-side rendering, yet a jQuery plugin that measures a character cell and a class
  // that extends `HTMLElement` both run when the module is evaluated unless something stops them.
  // The other half - that the ROOT pulls in no jQuery - is `scripts/measure-console.mjs`.
  check(
    "the console stylesheet is in the package, not just in the working tree",
    existsSync(join(installed, "dist", "console", "styles.css")),
  );
  check("console types are emitted", existsSync(join(installed, "dist", "console", "index.d.ts")));

  const consoleProbe = join(scratch, "console-probe.mjs");
  writeFileSync(
    consoleProbe,
    `const consoleApi = await import("${NAME}/console");\n` +
      `console.log(JSON.stringify({\n` +
      `  define: typeof consoleApi.defineBrowserPythonConsole,\n` +
      `  element: typeof consoleApi.BrowserPythonConsole,\n` +
      `  history: typeof consoleApi.HistoryStore,\n` +
      `  register: typeof consoleApi.registerDisplayRenderer,\n` +
      `  tag: consoleApi.DEFAULT_TAG_NAME,\n` +
      `  banner: typeof consoleApi.DEFAULT_BANNER,\n` +
      `}));\n`,
  );
  const consoleExports = JSON.parse(
    execFileSync(process.execPath, [consoleProbe], { cwd: scratch, encoding: "utf8" }),
  );
  check(
    "`/console` exports the element and defineBrowserPythonConsole",
    consoleExports.define === "function" && consoleExports.element === "function",
  );
  check(
    "…the history store and the display-renderer registry too",
    consoleExports.history === "function" && consoleExports.register === "function",
  );
  check(
    "…and the default tag name the README documents",
    consoleExports.tag === "freva-python-console",
    consoleExports.tag,
  );
  check(
    "importing `/console` in Node does not throw - it registers nothing and touches no window",
    consoleExports.banner === "string",
  );

  // `/console/auto` is the browser-only half: it calls `customElements.define`. Importing it under
  // Node must fail loudly rather than silently, and on the MISSING BROWSER API rather than on a
  // bad path - a package that ships a broken specifier fails the same way.
  const autoProbe = join(scratch, "auto-probe.mjs");
  writeFileSync(
    autoProbe,
    `try {\n` +
      `  await import("${NAME}/console/auto");\n` +
      `  console.log(JSON.stringify({ imported: true }));\n` +
      `} catch (e) {\n` +
      `  console.log(JSON.stringify({ imported: false, code: e.code ?? null, message: String(e.message).slice(0, 120) }));\n` +
      `}\n`,
  );
  const auto = JSON.parse(
    execFileSync(process.execPath, [autoProbe], { cwd: scratch, encoding: "utf8" }),
  );
  check(
    "`/console/auto` resolves - if it fails it is for want of a browser, never a bad specifier",
    auto.code !== "ERR_MODULE_NOT_FOUND" && auto.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED",
    JSON.stringify(auto),
  );

  // THE PACKED TYPES, COMPILED - not merely emitted. "Types are emitted" says a `.d.ts` exists,
  // not that a consumer can write the code the README shows: a `streamArtifact` declared with an
  // inline return shape leaves no name to annotate a result with and no `cleanupErrors` on it, so
  // reading the field a successful transfer really does carry is `TS2339`. That is invisible to a
  // test run inside this repository against source, so a real consumer module is written against
  // the INSTALLED package and compiled with `tsc --noEmit --strict`.
  const consumer = join(scratch, "consumer.ts");
  writeFileSync(
    consumer,
    `import type { ArtifactStreamResult, ArtifactSink, BrowserPython } from "${NAME}";\n` +
      `import { BrowserPythonError } from "${NAME}";\n` +
      `export async function save(py: BrowserPython, sink: ArtifactSink): Promise<string> {\n` +
      `  try {\n` +
      `    const result: ArtifactStreamResult = await py.streamArtifact("export.bin", sink);\n` +
      `    const faults: unknown[] = result.cleanupErrors ?? [];\n` +
      `    return \`\${result.name} \${result.mime} \${result.bytesWritten} \${faults.length}\`;\n` +
      `  } catch (error) {\n` +
      `    if (error instanceof BrowserPythonError) {\n` +
      `      const faults: unknown[] = error.cleanupErrors ?? [];\n` +
      `      return \`\${error.code} \${faults.length}\`;\n` +
      `    }\n` +
      `    throw error;\n` +
      `  }\n` +
      `}\n`,
  );
  // `/embed` too. It is a separate export with its own `.d.ts`, and a consumer writing the portal
  // half needs `HostSink` and `EmbeddedArtifact` to be nameable - the same defect that made
  // `ArtifactStreamResult` a TS2339, one entry point over.
  const embedConsumer = join(scratch, "embed-consumer.ts");
  writeFileSync(
    embedConsumer,
    `import type { DownloadableArtifact, EmbeddedArtifact, HostSink, PlaygroundHost } from "${NAME}/embed";\n` +
      `import { EMBED_PROTOCOL_VERSION, createPlaygroundHost, saveFilePickerSink } from "${NAME}/embed";\n` +
      `export async function wire(frame: HTMLIFrameElement, origin: string): Promise<PlaygroundHost> {\n` +
      `  const host = createPlaygroundHost({ frame, playgroundOrigin: origin });\n` +
      `  const listed: EmbeddedArtifact[] = host.artifacts;\n` +
      `  const save = (a: DownloadableArtifact): Promise<HostSink> => saveFilePickerSink(a);\n` +
      `  const controller = new AbortController();\n` +
      `  if (listed[0]) {\n` +
      `    await host.download(listed[0].name, save, { signal: controller.signal });\n` +
      `  }\n` +
      `  await host.stop();\n` +
      `  void EMBED_PROTOCOL_VERSION;\n` +
      `  return host;\n` +
      `}\n`,
  );
  const embedProbe = join(scratch, "embed-probe.mjs");
  writeFileSync(
    embedProbe,
    `const embed = await import("${NAME}/embed");\n` +
      `console.log(JSON.stringify({\n` +
      `  version: embed.EMBED_PROTOCOL_VERSION,\n` +
      `  channel: embed.EMBED_CHANNEL,\n` +
      `  host: typeof embed.createPlaygroundHost,\n` +
      `  playground: typeof embed.attachPlaygroundBridge,\n` +
      `  accepted: typeof embed.accepted,\n` +
      `}));\n`,
  );
  const embedExports = JSON.parse(
    execFileSync(process.execPath, [embedProbe], { cwd: scratch, encoding: "utf8" }),
  );
  check(
    "`/embed` exports both halves of the bridge and its protocol constants",
    embedExports.host === "function" &&
      embedExports.playground === "function" &&
      embedExports.accepted === "function" &&
      embedExports.version === 3 &&
      embedExports.channel === "freva-python-embed",
    JSON.stringify(embedExports),
  );

  // `/embed/examples` is its own subpath: a host that resolves registered examples same-origin
  // should not have to import the two-origin bridge to get the registry that does it.
  const examplesProbe = join(scratch, "probe-examples.mjs");
  writeFileSync(
    examplesProbe,
    `import * as examples from "@freva-org/browser-python/embed/examples";\n` +
      `const registry = examples.createExampleRegistry([\n` +
      `  { id: "a", title: "t", source: "x = 1", sha256: "${"a".repeat(64)}" },\n` +
      `]);\n` +
      `console.log(JSON.stringify({\n` +
      `  size: registry.size,\n` +
      `  hit: registry.resolve("a", "${"a".repeat(64)}").ok,\n` +
      `  miss: registry.resolve("a", "${"b".repeat(64)}").ok,\n` +
      `  verify: typeof examples.verifyExampleManifest,\n` +
      `}));\n`,
  );
  const exampleExports = JSON.parse(
    execFileSync(process.execPath, [examplesProbe], { cwd: scratch, encoding: "utf8" }),
  );
  check(
    "`/embed/examples` resolves a registered example by name AND digest",
    exampleExports.size === 1 &&
      exampleExports.hit === true &&
      exampleExports.miss === false &&
      exampleExports.verify === "function",
    JSON.stringify(exampleExports),
  );

  const tsc = join(PKG, "..", "..", "node_modules", "typescript", "bin", "tsc");
  let typeError = "";
  try {
    execFileSync(
      process.execPath,
      [
        tsc,
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "bundler",
        "--lib",
        "ES2022,DOM,DOM.Iterable",
        "--skipLibCheck",
        consumer,
        embedConsumer,
      ],
      { cwd: scratch, stdio: "pipe", encoding: "utf8" },
    );
  } catch (error) {
    typeError = String(error.stdout ?? error.message ?? error)
      .trim()
      .split("\n")
      .slice(0, 3)
      .join(" | ");
  }
  check(
    "a strict TypeScript consumer compiles against the packed types",
    typeError === "",
    typeError,
  );

  // The Python helpers travelled as strings rather than as files that `tsc` would have dropped.
  const worker = readFileSync(
    join(installed, "dist", "worker", "python-sources.generated.js"),
    "utf8",
  );
  check(
    "the Python helpers are embedded, not left behind as .py files",
    worker.includes("BrowserHTTPFileSystem") && worker.includes("MPLBACKEND"),
  );
} catch (error) {
  check("packaging", false, String(error.message ?? error).split("\n")[0]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  failures === 0 ? "\nAll packaging checks pass." : `\n${failures} packaging checks FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
