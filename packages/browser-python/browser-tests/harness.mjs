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
import { checkStamp } from "../scripts/build-stamp.mjs";
import { withDeadline } from "./deadline.mjs";
import { workspaceAbsenceConsistent } from "./workspace-reasons.mjs";

/** How long any one teardown step - dispose, context close, browser close - may take. */
export const TEARDOWN_MS = 15_000;

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
 * Worker entry points that REMOVE a capability before the real worker module evaluates, so the
 * fallback a browser without it takes is exercised in every engine - including one that has the
 * capability. They go through the public `workerURL` option; nothing in the package knows about
 * them. See `test-worker/`.
 */
export const TEST_WORKERS = join(HERE, "test-worker");

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
/** A suite failed for a narrowly classified browser-runtime reason and may be retried once in a
 * fresh process. Ordinary assertion failures remain exit 1 and are never retried. */
export const EXIT_RETRYABLE = 75;
/**
 * The feature a suite exists to exercise needs a capability THIS ENGINE's worker does not have -
 * detected at run time, never inferred from the browser's name. Not a pass: `run.mjs` lists it
 * separately with the reason, and the checks the suite could still make about the documented
 * fallback must all have passed for this code to be returned at all.
 */
export const EXIT_NOT_APPLICABLE = 4;

/** The Playwright engines a suite may be asked to run in. */
export const ENGINES = Object.freeze(["chromium", "firefox", "webkit"]);

/**
 * THE ENGINE THIS PROCESS RUNS IN, chosen once by `run.mjs` (or by whoever invokes a suite
 * directly) through `BROWSER_ENGINE`. Every launch in the harness defaults to it, so a suite that
 * never names a browser runs in the one the runner selected instead of quietly in Chromium - the
 * gap that let `BROWSER_ENGINES=firefox,webkit` exercise seven mock-console suites and nothing else.
 */
export const ENGINE = (() => {
  const requested = process.env.BROWSER_ENGINE ?? "chromium";
  if (!ENGINES.includes(requested)) {
    console.error(
      `BROWSER_ENGINE must be one of ${ENGINES.join(", ")}; received ${JSON.stringify(requested)}.`,
    );
    process.exit(EXIT_NOT_BUILT);
  }
  return requested;
})();

/**
 * The package must be BUILT, and built from THESE sources: the suites measure the shipped
 * artifact, and a `dist/` left over from an earlier checkout tests yesterday's worker with today's
 * suites. Freshness is a content digest (`scripts/build-stamp.mjs`), never a modification time.
 */
export function requireDist() {
  if (!existsSync(join(DIST, "index.js"))) {
    console.error("dist/ not found - run `npm run build` first.");
    process.exit(EXIT_NOT_BUILT);
  }
  if (!existsSync(join(DIST, "worker", "browser-python.worker.js"))) {
    console.error("dist/worker/browser-python.worker.js not found - the worker was not emitted.");
    process.exit(EXIT_NOT_BUILT);
  }
  const fresh = checkStamp(PKG);
  if (!fresh.ok) {
    console.error(fresh.reason);
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
    "/test-worker/": TEST_WORKERS,
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
    close: () =>
      new Promise((resolve) => {
        // `server.close()` waits for existing connections. That is normally desirable and exactly
        // wrong after a browser-operation watchdog fired: the request being diagnosed may be the
        // connection that never ends. Stop accepting first, then end fixture connections so test
        // cleanup cannot reproduce the hang it just detected.
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
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
  workerURL,
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
    ${workerURL ? `workerURL: new URL(${JSON.stringify(workerURL)}, location.href),` : ""}
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
      const memoryTimeoutMs = options.memoryTimeoutMs ?? 60_000;
      let memoryProbeStopped = false;

      // A REAL memory reading, taken while the transfer is stopped in the middle of it.
      // performance.measureUserAgentSpecificMemory() is the only instrument in a browser that
      // accounts for ArrayBuffer backing stores - DevTools JSHeapUsedSize does not, and 64 MiB of
      // Uint8Array moves it by nothing. It needs cross-origin isolation, covers the whole agent
      // cluster including this page's workers, and waits for a garbage collection, so it is called
      // at one point: awaiting it inside write() stops the transfer with half the file delivered.
      const measureMemory = async (phase) => {
        if (memoryProbeStopped) return null;
        if (typeof performance.measureUserAgentSpecificMemory !== "function") {
          state.memoryUnavailable = "performance.measureUserAgentSpecificMemory is not a function";
          return null;
        }
        if (!self.crossOriginIsolated) {
          state.memoryUnavailable = "the page is not cross-origin isolated";
          return null;
        }
        let timer;
        try {
          const measurement = await Promise.race([
            performance.measureUserAgentSpecificMemory(),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                const error = new Error(
                  "MemoryMeasurementTimeout: " + phase + " exceeded " + memoryTimeoutMs + " ms",
                );
                error.name = "MemoryMeasurementTimeout";
                reject(error);
              }, memoryTimeoutMs);
            }),
          ]);
          return measurement.bytes;
        } catch (error) {
          // Escaped twice because this code lives in the fixture page's template literal.
          state.memoryUnavailable = String(error?.message ?? error).split("\\n")[0];
          if (error?.name === "MemoryMeasurementTimeout") {
            state.memoryTimedOut = true;
            state.memoryTimeoutPhase = phase;
            // Do not queue more measurements behind one the browser never settled. The original
            // promise is confined to this page and is discarded when the suite closes it.
            memoryProbeStopped = true;
          }
          return null;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      if (options.measureAtBytes !== undefined)
        state.memoryBefore = await measureMemory("before transfer");

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
            state.memoryDuring = await measureMemory("during transfer");
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
      if (options.measureAtBytes !== undefined)
        state.memoryAfter = await measureMemory("after transfer");
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

/**
 * Launch options for `browserName`, shared by `inBrowser` and `launchPersistent` so a persistent
 * profile is launched exactly as an ordinary one is. The Chromium-only parts are keyed on the
 * ENGINE being launched, because they are Chromium's own command line: they select nothing about
 * what is tested.
 */
function launchOptions(browserName, { fullBrowser = false } = {}) {
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  return {
    ...(override && browserName === "chromium" ? { executablePath: override } : {}),
    // Playwright's default headless Chromium is chrome-headless-shell. The two memory suites
    // need the full browser because the shell exposes measureUserAgentSpecificMemory() but
    // rejects the call. `channel: "chromium"` opts into the full Playwright Chromium binary.
    ...(fullBrowser && !override && browserName === "chromium" ? { channel: "chromium" } : {}),
    args: browserName === "chromium" ? ["--no-sandbox"] : [],
  };
}

/**
 * A persistent profile in the SELECTED engine, for the suites that restart a real browser over one
 * profile directory. Playwright supports `launchPersistentContext` in all three engines; what
 * each one then keeps across the restart is what those suites measure.
 */
export async function launchPersistent(profileDir, options = {}) {
  const { browserName = ENGINE, ...contextOptions } = options;
  const playwright = await import("playwright");
  return await playwright[browserName].launchPersistentContext(profileDir, {
    ...launchOptions(browserName),
    ...contextOptions,
  });
}

/**
 * Run `fn(page)` in the selected engine - `BROWSER_ENGINE`, Chromium when unset. A missing engine
 * is NOT RUN, or a failure under BROWSER_STRICT=1; never a pass.
 */
export async function inBrowser(fn, options = {}) {
  const { browserName = ENGINE, fullBrowser = false, viewport } = options;
  const playwright = await import("playwright");
  let browser;
  try {
    browser = await playwright[browserName].launch(launchOptions(browserName, { fullBrowser }));
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
  let outcome;
  try {
    const returned = await fn(page);
    const checks = Array.isArray(returned) ? returned : (returned?.checks ?? []);
    // DISPOSE BEFORE CLOSING THE TAB. Closing the page tears the Worker down whatever state it was
    // in, so a suite that walks away proves the engine works and never that it stops working
    // cleanly. `dispose()` terminates the Worker, rejects everything in flight and releases the
    // workspace's locks, and a fault there - a throw, a lock left held, a state that is not
    // `disposed` - is otherwise invisible. Run on every engine the fixture exposed, and TWICE.
    // BOUNDED: a wedged page must not hold the process. SKIPPED when a phase deadline already
    // closed the page, which the suite reported as the failure it is.
    const teardown = page.isClosed()
      ? null
      : await withDeadline(
          page.evaluate(async () => {
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
          }),
          TEARDOWN_MS,
          "dispose() at teardown",
        ).catch((error) => ({ error: String(error?.message ?? error).split("\n")[0] }));
    if (teardown && (teardown.error !== undefined || (teardown.engines ?? 0) > 0)) {
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
    // A suite body may return an ARRAY of checks, or an object carrying them along with what it
    // found not applicable here. Either way the verdict is computed below, never taken on trust.
    const notApplicable = Array.isArray(returned) ? [] : (returned?.notApplicable ?? []);
    const unavailable = Array.isArray(returned) ? undefined : returned?.unavailable;
    const passing = checks.length > 0 && checks.every((c) => c.pass);
    outcome = {
      status: !passing ? "fail" : unavailable ? "not-applicable" : "pass",
      ...(unavailable ? { reason: unavailable } : {}),
      ...(checks.length === 0 ? { detail: "the suite body returned no checks" } : {}),
      ...(checks.some((c) => c.retryable === true) ? { retryable: true } : {}),
      ...(notApplicable.length > 0 ? { notApplicable } : {}),
      checks,
    };
  } catch (e) {
    outcome = { status: "fail", detail: e.stack ?? e.message, checks: [] };
  } finally {
    // BOUNDED, both of them: a browser whose close never returns would otherwise hold this process
    // until the runner's watchdog, and the suite's result with it. A close that does not finish is
    // a named failure; the process then exits, and Playwright kills what it launched on exit.
    const close = async (what, operation) => {
      try {
        await withDeadline(operation(), TEARDOWN_MS, what);
      } catch (error) {
        const message = String(error?.message ?? error);
        // A process watchdog, renderer crash or phase deadline can remove the context before this
        // finally block. Closing something already gone is successful cleanup, not a second test
        // failure. Keep every other close error - including a deadline - visible.
        if (/Failed to find context|Target .* closed|browser has been closed/i.test(message))
          return;
        const failure = {
          name: `${what} finished within ${TEARDOWN_MS} ms`,
          pass: false,
          detail: message,
        };
        if (outcome) {
          outcome.checks.push(failure);
          outcome.status = "fail";
        }
      }
    };
    await close("context.close()", () => context.close());
    await close("browser.close()", () => browser.close());
  }
  return outcome;
}

/**
 * Stop every engine a fixture page exposes, BOUNDED: a bounded `dispose()` first, which rejects
 * whatever the engine had in flight - so a pending `page.evaluate()` settles instead of living on;
 * and if the page itself does not answer, its browser context is closed. What a phase deadline
 * calls, and what a section's cleanup calls. Never throws.
 */
export async function terminateEngines(page) {
  if (page.isClosed()) return;
  try {
    await withDeadline(
      page.evaluate(() => {
        for (const engine of [
          window.__py?.engine,
          window.__csp?.engine,
          window.__c?.element?.engine,
        ]) {
          if (engine && typeof engine.dispose === "function") engine.dispose();
        }
        return true;
      }),
      5_000,
      "disposing the page's engines",
    );
  } catch {
    await withDeadline(page.context().close(), TEARDOWN_MS, "closing the browser context").catch(
      () => undefined,
    );
  }
}

/** Run a Chromium-only measurement suite in full Chromium, not chrome-headless-shell. */
export async function inFullBrowser(fn, options = {}) {
  return await inBrowser(fn, { ...options, fullBrowser: true });
}

/**
 * Hand the runner a machine-readable account of this suite, when it asked for one. The exit code
 * stays the contract; this carries the REASONS a summary needs - what was not applicable here and
 * why - which an exit code cannot.
 */
function recordOutcome(outcome) {
  const file = process.env.BROWSER_RESULT_FILE;
  if (!file) return;
  try {
    writeFileSync(file, JSON.stringify(outcome));
  } catch (error) {
    console.log(`  (could not write the result file: ${String(error?.message ?? error)})`);
  }
}

export function report(title, result) {
  console.log(`\n=== ${title}${title.includes(ENGINE) ? "" : ` [${ENGINE}]`} ===`);
  const checks = result.checks ?? [];
  const notApplicable = result.notApplicable ?? [];
  if (result.status === "skipped") {
    // NOT RUN, never a pass. Under BROWSER_STRICT=1 `inBrowser` reports a missing engine as a
    // failure instead; without it the runner lists this line under "did not run".
    console.log(`  NOT RUN  ${result.detail ?? ""}`);
    recordOutcome({ outcome: "not-run", reason: result.detail ?? "skipped" });
    return EXIT_NOT_RUN;
  }
  for (const c of checks) {
    console.log(`  ${c.pass ? "pass" : "FAIL"}  ${c.name}${c.detail ? `  - ${c.detail}` : ""}`);
  }
  if (result.detail) console.log(`  FAIL  ${result.detail}`);
  for (const n of notApplicable) console.log(`  n/a   ${n.name}  - ${n.reason}`);
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
  //
  // NOT APPLICABLE is a fourth outcome, and it is not a pass either. It needs a stated reason, at
  // least one executed check (the one that established the capability is absent, at minimum), and
  // every check it did make passing: a suite that found the feature unavailable and then got the
  // documented fallback WRONG has failed, whatever it was unable to test.
  const applicable = result.status === "not-applicable";
  const problems = [];
  if (result.status !== "pass" && !applicable)
    problems.push(`the suite reported status ${result.status ?? "none"}`);
  if (applicable && !result.reason) problems.push("not applicable, but no reason was given");
  if (checks.length === 0) problems.push("no checks ran at all, which is not a pass");
  if (failed > 0) problems.push(`${failed} of ${checks.length} checks failed`);
  const summary = {
    checks: checks.length,
    failed,
    ...(notApplicable.length > 0 ? { notApplicable } : {}),
  };
  if (problems.length > 0) {
    console.log(`  NOT A PASS: ${problems.join("; ")}.`);
    const lastFailure = checks.find((c) => !c.pass);
    recordOutcome({
      outcome: "fail",
      reason: problems.join("; "),
      ...(lastFailure ? { firstFailure: lastFailure.name } : {}),
      ...summary,
    });
    if (result.retryable === true) {
      console.log("  RETRYABLE: the aggregate runner may repeat this suite in a fresh process.");
      return EXIT_RETRYABLE;
    }
    return 1;
  }
  if (applicable) {
    console.log(`  NOT APPLICABLE in ${ENGINE}: ${result.reason}`);
    recordOutcome({ outcome: "not-applicable", reason: result.reason, ...summary });
    return EXIT_NOT_APPLICABLE;
  }
  recordOutcome({ outcome: "pass", ...summary });
  return 0;
}

/**
 * The capabilities a started engine reports, read from its `ready` payload - which the WORKER
 * computed, in the browser actually running the test. A suite branches on these, never on
 * `ENGINE`: Playwright's WebKit is not a Safari release, and a Firefox build can differ from the
 * one on a visitor's desk.
 */
export function capabilitiesOf(ready) {
  return {
    jspi: ready?.jspi === true,
    workspace: ready?.workspace?.available === true,
    workspaceReason: ready?.workspace?.reason ?? null,
    workspaceDetail: ready?.workspace?.detail ?? null,
  };
}

/**
 * Capabilities THIS RUN requires, from `BROWSER_REQUIRED_CAPABILITIES` (comma-separated names from
 * `CAPABILITIES` in suite-list.mjs). The default gate sets it: it is the Chromium baseline, which
 * has always asserted these, so a Chromium that loses one must FAIL rather than turn quietly into
 * "not applicable". An engine-full run sets nothing and lets every capability be detected.
 */
export const REQUIRED_CAPABILITIES = new Set(
  (process.env.BROWSER_REQUIRED_CAPABILITIES ?? "").split(/[\s,]+/).filter(Boolean),
);

/**
 * Record that `capability` is absent for the part `name`: a not-applicable part, or - when this
 * run requires the capability - a failing check. Returns whether it was recorded as not applicable.
 */
export function capabilityAbsent(checks, notApplicable, capability, name, reason) {
  if (REQUIRED_CAPABILITIES.has(capability)) {
    checks.push({
      name: `${name}: ${capability} is required in this run, and is missing`,
      pass: false,
      detail: reason,
    });
    return false;
  }
  notApplicable.push({ name, reason });
  return true;
}

/**
 * The same for a whole suite: the reason to report it not applicable, or `undefined` after
 * recording a failing check when this run requires the capability.
 */
export function unavailableUnlessRequired(checks, capability, reason) {
  if (!REQUIRED_CAPABILITIES.has(capability)) return reason;
  checks.push({
    name: `${capability} is required in this run, and is missing`,
    pass: false,
    detail: reason,
  });
  return undefined;
}

export { WORKSPACE_CAPABILITY_REASONS } from "./workspace-reasons.mjs";

/**
 * What a `__py` fixture page must still do when its worker reported no disk-backed workspace, and
 * the reason to report. Used by the suites whose feature IS the workspace, so each one exercises
 * the documented fallback before calling itself not applicable:
 *
 *  - the interpreter started and `ready.workspace` says why. A missing API is a capability reason;
 *    `open-failed` counts only when an INDEPENDENT probe worker could not use OPFS in this context
 *    either - otherwise the package failed where the browser would have let it work, and that fails;
 *  - Python still writes and reads files, in memory;
 *  - asking for downloads is refused with that same sentence, not answered with an empty list.
 */
export async function workspaceFallbackChecks(page, status, probe) {
  const worker = probe ?? (await probeWorkerCapabilities(page));
  const checks = [];
  // The reason must be the first prerequisite an independent worker in this context lacks, with
  // the sentence that belongs to it: `no-opfs` in WebKit, `no-sync-access-handles` where OPFS
  // exists without sync handles, `open-failed` only where the probe could not use OPFS either.
  const consistent = workspaceAbsenceConsistent(status, worker);
  checks.push({
    name: "no disk-backed workspace here: start() succeeds and ready.workspace gives the real reason",
    pass: consistent.ok,
    detail: JSON.stringify({
      status,
      probe: worker,
      ...(consistent.ok ? {} : { why: consistent.why }),
    }),
  });
  checks.push({
    name: "…and an independent worker could not use OPFS here either, so the package is not at fault",
    pass: worker.opfsUsable === false,
    detail: JSON.stringify(worker),
  });
  const files = await page.evaluate(async () => {
    window.__py.drain();
    const r = await window.__py.run(
      "with open('fallback.txt', 'w') as f:\n    f.write('kept')\nprint(open('fallback.txt').read())\n",
    );
    return { error: r.error ?? null, stdout: window.__py.text("stdout") };
  });
  checks.push({
    name: "…Python still writes and reads files, in memory",
    pass: files.error === null && files.stdout === "kept\n",
    detail: JSON.stringify(files),
  });
  const listing = await page.evaluate(async () => {
    try {
      return { artifacts: await window.__py.artifacts() };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  });
  checks.push({
    name: "…and downloads are refused with that same reason, not an empty list",
    pass: typeof listing.error === "string" && listing.error === status?.detail,
    detail: JSON.stringify(listing),
  });
  const reason = unavailableUnlessRequired(
    checks,
    "sync-access-handles",
    `this ${ENGINE} context's worker cannot back /workspace with OPFS ` +
      `(${status?.reason ?? "unknown"}${worker.opfsError ? `; ${worker.opfsError}` : ""}): ` +
      `${status?.detail ?? "no detail"}`,
  );
  return { checks, reason };
}

/**
 * Ask a dedicated Worker on the current page what it has, for suites that must decide BEFORE an
 * engine starts - two tabs racing to start, a probe worker of their own. The same questions the
 * package's worker asks (`supportsJspi`, `probeWorkspaceSupport`), asked in the same kind of
 * context, because a capability can differ between a document and a worker.
 */
export async function probeWorkerCapabilities(page) {
  // `page` may be a Frame: the question is about THAT document's context. The probe is a real file
  // under /test-worker/, which every harness server serves - see test-worker/probe-capabilities.mjs.
  return await page.evaluate(async () => {
    const worker = new Worker(new URL("/test-worker/probe-capabilities.mjs", location.href), {
      type: "module",
    });
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(`probe worker failed: ${event.message}`));
        setTimeout(() => reject(new Error("probe worker did not answer within 10s")), 10_000);
      });
    } finally {
      worker.terminate();
    }
  });
}

/** The fixed sentence a remote read without JSPI must produce - see `_freva_bridge.py`. */
export const NO_JSPI_REMOTE_MESSAGE =
  "Remote dataset access requires WebAssembly JSPI (stack switching), which this browser does not provide";
