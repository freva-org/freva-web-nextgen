// Shared harness for the real-browser suites.
//
// Everything here is served from LOCALHOST, including the Python runtime: the `pyodide`
// devDependency is the same distribution the CDN serves, so `indexURL` points at a local copy - a
// byte-identical, lockfile-pinned runtime, no 20 MB CDN download per CI job, and it exercises the
// self-hosting configuration path that would otherwise never be run.
//
// The wheels are the one gap: Pyodide's npm package ships the interpreter, the stdlib and the lock
// file, but not the ~350 built wheels, which live only in the release tarball.
// `prepare-runtime.mjs` fetches the handful a profile needs, and suites that need them report the
// runtime as incomplete rather than passing quietly.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SUITE_REQUIREMENTS } from "./suite-requirements.mjs";

export const HERE = fileURLToPath(new URL(".", import.meta.url));
export const PKG = resolve(HERE, "..");
export const DIST = join(PKG, "dist");
/**
 * Where the assembled Pyodide runtime lives - overridable, so its ABSENCE can be tested.
 * `.runtime/` may or may not exist in a given checkout, so without this a test of "what does a
 * suite do when its wheels are missing?" depends on the developer's workspace. Suites do not set
 * it; only the gate tests do.
 */
export const RUNTIME_DIR = process.env.BROWSER_PYTHON_RUNTIME_DIR
  ? resolve(process.env.BROWSER_PYTHON_RUNTIME_DIR)
  : join(PKG, ".runtime");
export const FIXTURES = join(PKG, "tests", "fixtures");
export const TEST_BUNDLE = join(PKG, ".testbundle");

/**
 * Where the derived Freva wheel is built for the suites that need it. Git-ignored, and NOT under
 * `tests/fixtures`: a production wheel - downloaded or derived - is not a fixture and is never
 * committed. `ensureFrevaWheelhouse()` fills it from PyPI on first use.
 */
export const FREVA_WHEELHOUSE = process.env.BROWSER_PYTHON_FREVA_WHEELS
  ? resolve(process.env.BROWSER_PYTHON_FREVA_WHEELS)
  : join(PKG, ".freva-wheels");

/**
 * Build the derived Freva wheel, once, from the pinned upstream wheel on PyPI.
 *
 * NEEDS A NETWORK, which is why only the Freva suites call it and why they are already declared
 * as needing `micropip`. `prepareFrevaWheelhouse` verifies a directory that is already there
 * against the shipped plan and returns without fetching anything, so a warm CI cache costs one
 * digest check. A failure is thrown rather than swallowed: a suite that ran against an absent
 * wheelhouse would report a startup error and read like a product defect.
 */
export async function ensureFrevaWheelhouse() {
  const { prepareFrevaWheelhouse } = await import("../bin/freva-wheelhouse.mjs");
  let failure = "";
  await prepareFrevaWheelhouse(
    { out: FREVA_WHEELHOUSE },
    {
      fail: (message) => {
        failure = message;
      },
      log: () => {},
    },
  );
  if (failure) throw new Error(`the derived Freva wheel could not be built:\n${failure}`);
  return FREVA_WHEELHOUSE;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".whl": "application/octet-stream",
  ".map": "application/json",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".bin": "application/octet-stream",
};

/**
 * Exit codes, named once, because their MEANINGS are the contract `run.mjs` and CI read. 0 is a
 * pass and only `report()` may produce it. 3 says "this suite's prerequisites are not present",
 * which `run.mjs` prints as NOT RUN and never counts as coverage. 2 says the package was not
 * built, a mistake in how the suite was invoked. Anything else is a failure.
 */
export const EXIT_NOT_BUILT = 2;
export const EXIT_NOT_RUN = 3;

/** The package must be BUILT: these suites measure the shipped artifact, not the sources. */
export function requireDist() {
  if (!existsSync(join(DIST, "index.js"))) {
    console.error("dist/ not found - run `npm run build` first.");
    process.exit(EXIT_NOT_BUILT);
  }
  if (!existsSync(join(DIST, "worker", "browser-python.worker.js"))) {
    console.error("dist/worker/browser-python.worker.js not found - the worker was not emitted.");
    process.exit(EXIT_NOT_BUILT);
  }
}

/**
 * The ONE way a suite says "my wheels are not here", so no suite can invent a laxer one.
 * Hand-written copies drift, and each is a place where the exit code could quietly become 0 - the
 * same fail-open shape `report()` exists to prevent, in the half of the flow it never sees.
 *
 * Deliberately NOT weakened under `BROWSER_STRICT=1`: a missing wheel is a missing prerequisite,
 * not a browser failure, and pretending otherwise would make `workspace.mjs` report an absent
 * scientific stack as a broken workspace. Strict mode governs only whether a suite that DID run
 * may call an empty result a pass.
 *
 * @param {string} title the suite's own heading, so the reason appears under it
 * @param {string} suite the suite's file name, the key into `SUITE_REQUIREMENTS`
 */
export function requireRuntimeFor(title, suite) {
  const required = SUITE_REQUIREMENTS[suite];
  if (required === undefined) {
    console.error(
      `${suite} asked for its runtime requirements, but suite-requirements.mjs does not list it. ` +
        "Add it there - the assembler derives its download list from that file.",
    );
    process.exit(EXIT_NOT_BUILT);
  }
  if (required.length === 0 || runtimeHasPackages(required)) return;
  console.log(`\n=== ${title} ===`);
  console.log(`  RUNTIME INCOMPLETE  .runtime/ is missing one of: ${required.join(", ")}.`);
  console.log(
    "  Run `node bin/freva-browser-python.mjs prepare-runtime --full --out .runtime` " +
      "with the pinned version from bin/runtime-releases.json.",
  );
  process.exit(EXIT_NOT_RUN);
}

/**
 * Bundle the console entry point for a fixture page. The published `dist/` is unbundled TypeScript
 * output, so it still contains bare specifiers - `import jQuery from "jquery"` - which a browser
 * cannot resolve. Every real consumer runs this through a bundler; the fixture does too, with
 * esbuild.
 */
export function bundleConsole() {
  const entry = join(TEST_BUNDLE, "entry.js");
  const out = join(TEST_BUNDLE, "console.js");
  mkdirSync(TEST_BUNDLE, { recursive: true });
  writeFileSync(
    entry,
    'export { defineBrowserPythonConsole, BrowserPythonConsole } from "../dist/console/index.js";\n',
  );
  const esbuild = join(PKG, "..", "..", "node_modules", ".bin", "esbuild");
  execFileSync(
    esbuild,
    [entry, "--bundle", "--format=esm", `--outfile=${out}`, "--log-level=error"],
    {
      cwd: PKG,
      stdio: "pipe",
    },
  );
  return "/bundle/console.js";
}

/** True when the local runtime carries the wheels a profile needs. */
export function runtimeHasPackages(names) {
  const lock = join(RUNTIME_DIR, "pyodide-lock.json");
  if (!existsSync(lock)) return false;
  let data;
  try {
    data = JSON.parse(readFileSync(lock, "utf8"));
  } catch {
    return false;
  }
  return names.every((name) => {
    const entry = data.packages?.[name];
    return Boolean(entry) && existsSync(join(RUNTIME_DIR, entry.file_name));
  });
}

/**
 * Serve, from one origin:
 *   /            the fixture page
 *   /dist/…      the built package, worker included
 *   /runtime/…   the pinned Pyodide distribution
 *   /fixtures/…  the committed Zarr stores
 *   /freva-wheels/…  the derived Freva wheel, when a suite passed it in `roots`
 *
 * One origin matters: a Worker created from a cross-origin URL is blocked, and the Zarr fixtures
 * have to be same-origin-or-CORS for the browser's own Fetch - the constraint a real deployment
 * is under, so the test server enforces it rather than papering over it with `*`.
 */
export async function serve(html, options = {}) {
  const roots = {
    "/dist/": DIST,
    "/runtime/": RUNTIME_DIR,
    "/fixtures/": FIXTURES,
    "/bundle/": TEST_BUNDLE,
    ...(options.roots ?? {}),
  };
  /**
   * Every request, with the parts that decide whether a range actually happened. Paths alone prove
   * nothing: a suite counting fixture requests passes identically whether the adapter fetched four
   * chunks or downloaded the whole store four times. Method, `Range`, status and `Content-Range`
   * are recorded, with the paths alongside for the suites that only need to count.
   */
  const exchanges = [];
  const requests = [];

  const record = (url, req, status, contentRange) => {
    exchanges.push({
      method: req.method,
      path: url.pathname,
      range: req.headers.range ?? null,
      status,
      contentRange: contentRange ?? null,
    });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push(url.pathname);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // `headers` lets a suite serve the page cross-origin isolated (COOP/COEP), which is the only
      // way to test what SharedArrayBuffer-dependent storage backends actually require.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...(options.headers ?? {}),
      });
      res.end(html);
      return;
    }

    // A hook, so a suite can BE the remote service. The OIDC device flow is a conversation -
    // device code, then poll, then a token - and a real provider would make CI depend on someone
    // else's uptime and a human typing a code. `handle(req, res, url)` lets a suite script it,
    // including authorization_pending, slow_down, access_denied and expired_token.
    if (options.handle?.(req, res, url)) return;

    for (const [prefix, dir] of Object.entries(roots)) {
      if (!url.pathname.startsWith(prefix)) continue;
      const rel = decodeURIComponent(url.pathname.slice(prefix.length));
      const file = join(dir, normalize(rel));
      // No traversal. A test server is still a server.
      if (!file.startsWith(dir + sep) && file !== dir) break;
      if (!existsSync(file) || !statSync(file).isFile()) break;
      const size = statSync(file).size;
      const range = req.headers.range;
      const type = TYPES[extname(file)] ?? "application/octet-stream";

      // Byte ranges are served for real, because the Zarr suites are what prove the adapter's
      // range arithmetic and a server that ignored Range would make them prove nothing.
      const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && !options.ignoreRanges) {
        const [, rawStart, rawEnd] = match;
        let start;
        let end;
        if (rawStart === "") {
          // A suffix range: the last N bytes.
          const suffix = Number(rawEnd);
          start = Math.max(0, size - suffix);
          end = size - 1;
        } else {
          start = Number(rawStart);
          end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
        }
        if (start > end || start >= size) {
          res.writeHead(416, { "content-range": `bytes */${size}` });
          res.end();
          return;
        }
        record(url, req, 206, `bytes ${start}-${end}/${size}`);
        res.writeHead(206, {
          "content-type": type,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${size}`,
          "accept-ranges": "bytes",
          ...(options.assetHeaders ?? {}),
        });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }

      record(url, req, 200, null);
      res.writeHead(200, {
        "content-type": type,
        "content-length": String(size),
        "accept-ranges": "bytes",
        // `assetHeaders` exists for cross-origin isolation, which is not a per-page decision: a
        // dedicated Worker created by a COEP:require-corp document must itself be served with a
        // compatible COEP header, or the browser refuses it and the refusal arrives as "The Python
        // worker failed to load", which names neither COEP nor the worker script.
        ...(options.assetHeaders ?? {}),
      });
      createReadStream(file).pipe(res);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    exchanges,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** The fixture page. It imports the BUILT package, exactly as a consumer would. */
export function fixturePage({
  profile = "minimal",
  packages = [],
  addons,
  optionalAddons,
  addonBaseURL,
  wheelhouseURL,
  persistCredentials,
  workspaceMaxFiles,
} = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>browser-python</title></head>
<body>
<script type="module">
  import { createBrowserPython } from "/dist/index.js";

  const events = [];
  const statuses = [];
  const python = createBrowserPython({
    profile: ${JSON.stringify(profile)},
    packages: ${JSON.stringify(packages)},
    // Self-hosted, and pinned by the lockfile. See the harness header.
    pyodide: { indexURL: new URL("/runtime/", location.href).href },
    ${addons ? `addons: ${JSON.stringify(addons)},` : ""}
    ${optionalAddons ? `optionalAddons: ${JSON.stringify(optionalAddons)},` : ""}
    ${addonBaseURL ? `addonBaseURL: new URL(${JSON.stringify(addonBaseURL)}, location.href).href,` : ""}
    ${wheelhouseURL ? `wheelhouseURL: new URL(${JSON.stringify(wheelhouseURL)}, location.href).href,` : ""}
    ${persistCredentials ? "persistCredentials: true," : ""}
    ${workspaceMaxFiles !== undefined ? `workspaceMaxFiles: ${JSON.stringify(workspaceMaxFiles)},` : ""}
  });
  const artifactEvents = [];
  python.onOutput((event) => events.push(event));
  python.onStatus((event) => statuses.push(event));
  python.onArtifacts((event) => artifactEvents.push(event));

  // The whole surface a suite drives, on one global. Nothing here is part of the package's API -
  // it is the test's remote control.
  window.__py = {
    engine: python,
    events,
    statuses,
    state: () => python.state,
    start: () => python.start(),
    push: (line) => python.push(line),
    run: (code) => python.run(code),
    complete: (source, cursor) => python.complete(source, cursor),
    clearBuffer: () => python.clearBuffer(),
    restart: () => python.restart(),
    dispose: () => python.dispose(),
    /** Everything emitted so far, as plain objects a suite can assert on. */
    drain: () => events.splice(0, events.length),
    /** Proxy accounting from inside the worker - see repl.ts. */
    text: (kind) => events.filter((e) => e.type === kind).map((e) => e.text).join(""),

    // the workspace
    workspace: () => python.workspace,
    artifacts: () => python.artifacts(),
    artifactEvents,
    drainArtifactEvents: () => artifactEvents.splice(0, artifactEvents.length),
    deleteArtifact: (name) => python.deleteArtifact(name),
    /**
     * Read an artifact and describe it WITHOUT sending the bytes to the test: a suite asserting on
     * a 64 MiB export must not serialise it through the CDP channel, and a digest proves more than
     * a length does. The blob URL is created and revoked here too, because that is what a download
     * does.
     */
    readArtifact: async (name, options) => {
      const data = await python.readArtifact(name, options ?? {});
      const buffer = await data.blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const url = URL.createObjectURL(data.blob);
      const isBlobUrl = typeof url === "string" && url.startsWith("blob:");
      URL.revokeObjectURL(url);
      return {
        name: data.name,
        mime: data.mime,
        size: data.size,
        truncated: data.truncated,
        blobBytes: data.blob.size,
        isBlob: data.blob instanceof Blob,
        isBlobUrl,
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
        head: new TextDecoder().decode(new Uint8Array(buffer.slice(0, 64))),
        // The first bytes as NUMBERS as well as text: a PNG begins 0x89 "PNG", and 0x89 is not
        // valid UTF-8, so a decoded string mangles the one byte a signature check cares about.
        headBytes: [...new Uint8Array(buffer.slice(0, 8))],
      };
    },
    /** Read an artifact as text - for the small ones a suite wants to compare exactly. */
    readArtifactText: async (name, options) => {
      const data = await python.readArtifact(name, options ?? {});
      return await data.blob.text();
    },

    /**
     * Stream an artifact into a sink that HASHES it and throws the bytes away. Nothing is retained:
     * a streamed download exists so a two-gigabyte file never exists anywhere as two gigabytes, and
     * a test that collected the chunks would measure the opposite. Reported back are the digest,
     * the peak bytes alive at once, and the largest single chunk.
     */
    streamArtifact: async (name, options = {}) => {
      const state = { bytes: 0, chunks: 0, maxChunk: 0, live: 0, peakLive: 0, progress: [] };
      // A rolling SHA-256 with no library: hash each chunk into a running value, then hash the
      // concatenation of those. Not a standard construction and does not need to be - it is a
      // deterministic function of the byte stream, and the SAME function is applied in Python.
      let rolling = new Uint8Array(32);
      // The negative control for the memory measurement, kept in a CLOSURE and never on state:
      // anything on state is serialised back to the test, and serialising the retained copy of the
      // file would be the very memory this is measuring.
      const retained = [];
      const controller = new AbortController();
      if (options.cancelAfterBytes !== undefined) state.cancelAt = options.cancelAfterBytes;

      // A REAL memory reading, taken while the transfer is stopped in the middle of it.
      // performance.measureUserAgentSpecificMemory() is the only instrument in a browser that
      // accounts for ArrayBuffer backing stores - DevTools JSHeapUsedSize does not, and 64 MiB of
      // Uint8Array moves it by nothing. It needs cross-origin isolation, covers the whole agent
      // cluster including this page's workers, and waits for a garbage collection, so it is called
      // at one point: awaiting it inside write() stops the transfer with half the file delivered.
      const measureMemory = async () => {
        if (typeof performance.measureUserAgentSpecificMemory !== "function") return null;
        if (!self.crossOriginIsolated) return null;
        try {
          return (await performance.measureUserAgentSpecificMemory()).bytes;
        } catch {
          return null;
        }
      };
      if (options.measureAtBytes !== undefined) state.memoryBefore = await measureMemory();

      const sink = {
        async write(chunk) {
          state.live = chunk.byteLength;
          state.peakLive = Math.max(state.peakLive, state.live);
          state.maxChunk = Math.max(state.maxChunk, chunk.byteLength);
          state.chunks += 1;
          state.bytes += chunk.byteLength;
          // Deliberate retention, so a suite can prove the measurement notices retention at all.
          if (options.retainChunks) retained.push(chunk.slice());
          const joined = new Uint8Array(rolling.length + chunk.byteLength);
          joined.set(rolling, 0);
          joined.set(chunk, rolling.length);
          rolling = new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
          if (options.failAfterBytes !== undefined && state.bytes >= options.failAfterBytes) {
            throw new Error("the destination refused to take any more");
          }
          if (state.cancelAt !== undefined && state.bytes >= state.cancelAt) controller.abort();
          if (
            options.measureAtBytes !== undefined &&
            state.memoryDuring === undefined &&
            state.bytes >= options.measureAtBytes
          ) {
            state.memoryDuring = await measureMemory();
            state.measuredAtBytes = state.bytes;
          }
          state.live = 0;
        },
        async close() {
          state.closed = (state.closed ?? 0) + 1;
        },
        async abort() {
          state.aborted = (state.aborted ?? 0) + 1;
        },
      };

      try {
        const result = await python.streamArtifact(name, sink, {
          ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
          ...(options.windowChunks !== undefined ? { windowChunks: options.windowChunks } : {}),
          signal: controller.signal,
          onProgress: (p) => {
            if (state.progress.length < 4) state.progress.push(p);
            state.lastProgress = p;
          },
        });
        state.result = result;
      } catch (error) {
        state.error = { name: error?.name ?? "Error", message: String(error?.message ?? error) };
      }
      if (options.measureAtBytes !== undefined) state.memoryAfter = await measureMemory();
      state.retainedChunks = retained.length;
      state.sha256 = [...rolling].map((b) => b.toString(16).padStart(2, "0")).join("");
      return state;
    },
  };
  window.__ready = true;
</script>
</body></html>`;
}

export function isStrict() {
  return process.env.BROWSER_STRICT === "1";
}

/** Run `fn(page)` in Chromium. A missing engine is a skip, or a failure under BROWSER_STRICT=1. */
export async function inBrowser(fn, options = {}) {
  const { browserName = "chromium", viewport } = options;
  const playwright = await import("playwright");
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  let browser;
  try {
    browser = await playwright[browserName].launch({
      ...(override && browserName === "chromium" ? { executablePath: override } : {}),
      args: browserName === "chromium" ? ["--no-sandbox"] : [],
    });
  } catch (e) {
    return {
      status: isStrict() ? "fail" : "skipped",
      detail: `${browserName} not installed (${String(e).split("\n")[0]})`,
      checks: [],
    };
  }
  // An EXPLICIT context, not `browser.newPage()`, which creates a context it owns and then refuses
  // `context.newPage()` on it. A second page is the only way to test what two tabs on one origin
  // do to each other, which for OPFS - where every file handle is an exclusive lock - has a real
  // answer. Two contexts are separate storage partitions and could not collide if the code were
  // wrong.
  const context = await browser.newContext({
    viewport: viewport ?? { width: 1000, height: 700 },
    // On by default: a suite that never downloads is unaffected, and one that does can wait for a
    // real `download` event rather than asserting that it clicked something.
    acceptDownloads: true,
    ...(options.mobile ?? {}),
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const checks = await fn(page);
    // DISPOSE BEFORE CLOSING THE TAB. Closing the page tears the Worker down whatever state it was
    // in, so a suite that walks away proves the engine works and never that it stops working
    // cleanly. `dispose()` terminates the Worker, rejects everything in flight and releases the
    // workspace's locks, and a fault there - a throw, a lock left held, a state that is not
    // `disposed` - is otherwise invisible. Run on every engine the fixture exposed, and TWICE.
    const teardown = await page
      .evaluate(async () => {
        const engines = [
          window.__py?.engine,
          window.__csp?.engine,
          window.__c?.element?.engine,
        ].filter((e) => e && typeof e.dispose === "function");
        const states = [];
        for (const engine of engines) {
          await engine.dispose();
          await engine.dispose(); // terminal and idempotent, or this is where it says so
          states.push(engine.state ?? null);
        }
        return { engines: engines.length, states };
      })
      .catch((error) => ({ error: String(error?.message ?? error).split("\n")[0] }));
    if (teardown?.error !== undefined || (teardown?.engines ?? 0) > 0) {
      checks.push({
        name: "dispose() at teardown is clean, terminal and idempotent",
        pass:
          teardown.error === undefined &&
          teardown.states.every((state) => state === "disposed" || state === null),
        detail: JSON.stringify(teardown),
      });
    }
    if (errors.length) checks.push({ name: "no page errors", pass: false, detail: errors[0] });
    // `checks.length > 0` for the same reason `report` insists on it: a body that returned before
    // asserting anything has proved nothing, and `[].every(...)` says otherwise.
    return {
      status: checks.length > 0 && checks.every((c) => c.pass) ? "pass" : "fail",
      ...(checks.length === 0 ? { detail: "the suite body returned no checks" } : {}),
      checks,
    };
  } catch (e) {
    return { status: "fail", detail: e.stack ?? e.message, checks: [] };
  } finally {
    await context.close();
    await browser.close();
  }
}

export function report(title, result) {
  console.log(`\n=== ${title} ===`);
  const checks = result.checks ?? [];
  if (result.status === "skipped") {
    console.log(`  SKIPPED  ${result.detail ?? ""}`);
    return 0;
  }
  for (const c of checks) {
    console.log(`  ${c.pass ? "pass" : "FAIL"}  ${c.name}${c.detail ? `  - ${c.detail}` : ""}`);
  }
  if (result.detail) console.log(`  FAIL  ${result.detail}`);
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`  ${checks.length - failed}/${checks.length} checks pass`);

  // THREE INDEPENDENT WAYS TO FAIL, and a pass has to survive all of them, because the exit code
  // is the only thing `run.mjs` and CI read.
  //
  //   - ZERO CHECKS IS NOT A PASS. A suite that catches a setup failure, sets `status: "fail"` and
  //     then recomputes the status from its checks hands back "pass", because `[].every(...)` is
  //     `true` - which is how `persistence-restart.mjs` printed FAIL, "0/0 checks pass", exit 0.
  //   - A FAILING CHECK fails the suite regardless of the status handed in.
  //   - An explicit `status` other than "pass" is honoured even when every check passed, because a
  //     teardown that threw after the last assertion is a failure no check will record.
  const problems = [];
  if (result.status !== "pass")
    problems.push(`the suite reported status ${result.status ?? "none"}`);
  if (checks.length === 0) problems.push("no checks ran at all, which is not a pass");
  if (failed > 0) problems.push(`${failed} of ${checks.length} checks failed`);
  if (problems.length > 0) {
    console.log(`  NOT A PASS: ${problems.join("; ")}.`);
    return 1;
  }
  return 0;
}
