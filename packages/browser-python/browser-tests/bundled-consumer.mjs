/**
 * A consumer that INSTALLS the tarball and BUNDLES it, then starts an interpreter.
 *
 *     node browser-tests/bundled-consumer.mjs
 *
 * Everything else in this directory imports `dist/` from the working tree over plain HTTP, which
 * is a real deployment shape and not the one most consumers have. Waterpark is an Astro site;
 * Astro is Vite; Vite is Rollup - and the whole engine hangs off one line:
 *
 *     new Worker(new URL("./worker/browser-python.worker.js", import.meta.url), { type: "module" })
 *
 * documented as "the one every modern bundler recognises", which is a claim about somebody else's
 * software. If a bundler does not rewrite it, the URL points at a path that was never emitted,
 * the Worker 404s, and `start()` never resolves - no error, a spinner forever. So: pack, install
 * into a scratch project, build with Vite, serve ONLY the build output and the runtime, and run
 * Python in it, with nothing from this working tree reachable from the page.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();

const PKG = fileURLToPath(new URL("..", import.meta.url));
const NAME = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).name;
const VITE = join(PKG, "..", "..", "node_modules", ".bin", "vite");

if (!existsSync(VITE)) {
  console.log("\n=== bundled consumer ===");
  console.log("  SKIPPED  vite is not installed in this workspace.");
  process.exit(3);
}

const APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>consumer</title></head>
<body><freva-python-console id="c"></freva-python-console>
<script type="module" src="/main.js"></script></body></html>`;

// A consumer that uses BOTH entry points, because they fail differently. The engine is where the
// Worker URL lives; the console is where the stylesheet and the custom element live, and a bundler
// that drops a CSS import produces a component that renders as unstyled text rather than failing.
const APP_JS = `
import { createBrowserPython } from "${NAME}";
import { defineBrowserPythonConsole } from "${NAME}/console";

defineBrowserPythonConsole();
const element = document.getElementById("c");
const python = createBrowserPython({
  profile: "minimal",
  pyodide: { indexURL: new URL("/runtime/", location.href).href },
});
element.engine = python;

// A SECOND engine on the freva-client profile, loading the wheelhouse this test prepared with the
// package's own CLI. Nothing from the repository is reachable from this page - not dist/, not
// tests/fixtures - so if the published package cannot produce the static assets its README
// documents, this is where that shows.
const freva = createBrowserPython({
  profile: "freva-client",
  pyodide: { indexURL: new URL("/runtime/", location.href).href },
  wheelhouseURL: new URL("/freva-wheels/", location.href).href,
});

window.__app = {
  state: () => python.state,
  start: () => python.start(),
  run: (code) => python.run(code),
  styled: () => (element.shadowRoot?.adoptedStyleSheets ?? []).length,
  freva: {
    state: () => freva.state,
    start: () => freva.start(),
    run: (code) => freva.run(code),
    dispose: () => freva.dispose(),
  },
};
window.__appReady = true;
`;

const scratch = mkdtempSync(join(tmpdir(), "browser-python-bundled-"));
let built = null;
let wheelhouse = null;
const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });

try {
  // --ignore-scripts: prepack runs check-bytes, which packs. See scripts/check-bytes.mjs.
  const [meta] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], {
      cwd: PKG,
      encoding: "utf8",
    }),
  );
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "consumer", type: "module", private: true }),
  );
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--no-package-lock", join(scratch, meta.filename)],
    { cwd: scratch, stdio: "pipe" },
  );
  // The static assets, produced by the INSTALLED package's own CLI. The npm package publishes
  // bin, dist, README and LICENSE, so a consumer following the README needs a supported way to
  // make the directory the README tells them to serve. The command below runs out of
  // `node_modules/.bin`, in a scratch project, with no access to this repository at all.
  const cliPath = join(scratch, "node_modules", ".bin", "freva-browser-python");
  try {
    execFileSync(cliPath, ["prepare-freva-wheelhouse", "--out", join(scratch, "freva-wheels")], {
      cwd: scratch,
      stdio: "pipe",
    });
  } catch (error) {
    // The command downloads pinned wheels from PyPI, so a machine without that access cannot run
    // this suite. Reported as INCOMPLETE - a distinct outcome that BROWSER_STRICT=1 turns into a
    // failure - rather than as a skip that reads as a pass in a wall of green.
    console.log("\n=== bundled consumer ===");
    console.log(
      `  RUNTIME INCOMPLETE  prepare-freva-wheelhouse could not fetch its pinned wheels: ` +
        `${String(error.stderr ?? error.message).slice(0, 200)}`,
    );
    rmSync(scratch, { recursive: true, force: true });
    process.exit(3);
  }
  wheelhouse = join(scratch, "freva-wheels");

  writeFileSync(join(scratch, "index.html"), APP_HTML);
  writeFileSync(join(scratch, "main.js"), APP_JS);
  // `base: "./"` is what a subdirectory deployment uses, and the harsher test: an absolute base
  // would let a wrong worker path still resolve from the server root.
  writeFileSync(
    join(scratch, "vite.config.js"),
    `export default { base: "./", build: { target: "es2022" }, logLevel: "error" };\n`,
  );

  execFileSync(VITE, ["build"], { cwd: scratch, stdio: "pipe" });
  built = join(scratch, "dist");
  ok("a Vite build of an installed consumer succeeds", existsSync(join(built, "index.html")));
} catch (error) {
  const detail = String(error.stderr ?? error.message ?? error).slice(0, 400);
  ok("a Vite build of an installed consumer succeeds", false, detail);
}

const result = built
  ? await inBrowser(async (page) => {
      // ONLY the build output and the runtime. No `/dist/`, no node_modules, nothing from this
      // working tree - so anything the bundle failed to emit is a 404 rather than an accident
      // that happens to work here and not for a consumer.
      const server = await serve(readFileSync(join(built, "index.html"), "utf8"), {
        roots: { "/freva-wheels/": wheelhouse, "/": built },
      });
      try {
        const failures = [];
        page.on("requestfailed", (request) => failures.push(request.url()));
        page.on("response", (response) => {
          if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
        });

        await page.goto(server.url);
        await page.waitForFunction(() => window.__appReady === true, null, { timeout: 20000 });
        ok("the bundled consumer's modules load", true, "ready");

        await page.evaluate(() => window.__app.start());
        let started = true;
        try {
          await page.waitForFunction(() => window.__app.state() === "ready", null, {
            timeout: 240000,
          });
        } catch {
          started = false;
        }
        ok(
          "the Worker URL survived bundling: an interpreter starts from the build output",
          started,
          started
            ? await page.evaluate(() => window.__app.state())
            : failures.slice(0, 4).join(" | "),
        );

        if (started) {
          const ran = await page.evaluate(async () => {
            const r = await window.__app.run("print(6 * 7)");
            return { error: r.error ?? null };
          });
          ok("…and Python runs in it", ran.error === null, ran.error ?? "ran");
          ok(
            "the console component's stylesheet survived bundling too",
            (await page.evaluate(() => window.__app.styled())) === 1,
            await page.evaluate(() => window.__app.styled()),
          );
        }

        // the freva profile, from the CLI's assets
        if (started) {
          await page.evaluate(() => window.__app.freva.start());
          let frevaStarted = true;
          try {
            await page.waitForFunction(() => window.__app.freva.state() === "ready", null, {
              timeout: 300000,
            });
          } catch {
            frevaStarted = false;
          }
          ok(
            "the freva-client profile starts from a wheelhouse the CLI prepared",
            frevaStarted,
            frevaStarted
              ? "ready"
              : failures.slice(0, 4).join(" | ") ||
                  (await page.evaluate(() => window.__app.freva.state())),
          );
          if (frevaStarted) {
            const imported = await page.evaluate(async () => {
              const r = await window.__app.freva.run(
                "import freva_client\nprint('freva_client', freva_client.__version__)\n",
              );
              return { error: r.error ?? null };
            });
            ok(
              "…and `import freva_client` works in it",
              imported.error === null,
              imported.error ?? "imported",
            );
            await page.evaluate(() => window.__app.freva.dispose());
          }
        }

        ok(
          "nothing the bundle referenced was missing from the build output",
          failures.length === 0,
          failures.slice(0, 4).join(" | "),
        );
        return checks;
      } finally {
        await server.close();
      }
    })
  : { status: "fail", checks };

rmSync(scratch, { recursive: true, force: true });
process.exit(report("bundled consumer", result.checks ? result : { status: "fail", checks }));
