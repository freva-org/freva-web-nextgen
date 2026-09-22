// pyodide-runtime.ts - bringing an interpreter up, and nothing else. Kept apart from the REPL
// because the two fail differently and a caller needs to tell them apart: a runtime that cannot
// be reached is a deployment problem with a URL in the message, while a console that misbehaves
// is this package's bug.

import { PYTHON_SOURCES } from "./python-sources.generated.js";
import type { BrowserPythonProfile, UnsupportedReason } from "../types.js";
import { describeFailure, lastMeaningfulLine } from "./startup-failure.js";

/**
 * A minimal structural view of the bits of Pyodide this package uses, hand-written rather than
 * imported: depending on the `pyodide` package would put a 14 MB runtime in the dependency tree
 * of a package whose premise is that the runtime is fetched separately and browser-cached.
 */
export interface PyodideApi {
  version: string;
  globals: { get(name: string): unknown; set(name: string, value: unknown): void };
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  /**
   * Returns what it MANAGED to load, which is why this is typed rather than `unknown`:
   * `loadPackage` does not reject when a wheel cannot be fetched but resolves with the packages
   * that did arrive, so a caller who ignores the result proceeds as though a profile installed
   * when none of it did. See `loadProfilePackages`.
   */
  loadPackage(
    names: string | string[],
    options?: { messageCallback?: (m: string) => void; errorCallback?: (m: string) => void },
  ): Promise<ReadonlyArray<{ name: string }>>;
  loadPackagesFromImports(code: string): Promise<unknown>;
  /**
   * What is loaded ALREADY, keyed by package name. Needed because `loadPackage` returns only what
   * it newly fetched: ask for a package already in the interpreter and it answers "No new
   * packages to load" with an empty list, which an arrival check reads as a failure - that is how
   * the add-on suite reported `fsspec` missing on a profile whose whole point is fsspec.
   */
  loadedPackages?: Record<string, string>;
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string | Uint8Array): void;
    mount(type: unknown, options: unknown, mountpoint: string): void;
    syncfs(populate: boolean, callback: (error: unknown) => void): void;
    filesystems: { IDBFS: unknown };
  };
  setStdout(options: { batched?: (text: string) => void }): void;
  setStderr(options: { batched?: (text: string) => void }): void;
  pyimport(name: string): unknown;
}

type LoadPyodide = (options: {
  indexURL: string;
  packageBaseUrl?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}) => Promise<PyodideApi>;

/** Where the Python helpers are written in Pyodide's virtual filesystem. */
export const PYTHON_DIR = "/freva";

/** The scientific profile's package set - and nothing beyond it. */
export const PROFILE_PACKAGES: Readonly<Record<BrowserPythonProfile, readonly string[]>> = {
  minimal: [],
  // `micropip` is in the profile, and `matplotlib` deliberately is not: they look like the same
  // decision and are opposites. Matplotlib is several megabytes most sessions never touch and
  // Pyodide fetches it on the first `import matplotlib`, so only a visitor who plots pays for it;
  // the display bridge is installed at startup regardless, and a browser test asserts matplotlib
  // is absent from a fresh interpreter. micropip is small and is the ONLY way a visitor can add a
  // package to a session with no backend, so loading it lazily would break the documented
  // command on a slow first call or on a deployment whose index cannot be reached.
  "xarray-zarr": ["xarray", "zarr", "fsspec", "numcodecs", "micropip"],
  // The Freva profile EXTENDS xarray-zarr, and every name here comes from the runtime's own lock -
  // none of it is fetched from PyPI. The Freva wheels are not Pyodide packages and are installed
  // from same-origin assets, after these, by `installFrevaClient`. `pygments` is explicit and is
  // not decoration: `rich/traceback.py` does `from pygments.lexers import
  // guess_lexer_for_filename`, so a runtime with rich but no pygments fails at
  // `import freva_client` with a ModuleNotFoundError naming neither.
  "freva-client": [
    "xarray",
    "zarr",
    "fsspec",
    "numcodecs",
    "micropip",
    // freva-client's own import-time dependencies, all from the Pyodide lock
    "requests",
    "pyyaml",
    "pandas",
    "rich",
    "pygments",
    "tomli",
    "setuptools",
    "click",
    "typing-extensions",
    // py-oidc-auth-client's
    "httpx",
    "platformdirs",
  ],
};

/** Which modules to report versions for once a profile is up. */
export const PROFILE_REPORTED: Readonly<Record<BrowserPythonProfile, readonly string[]>> = {
  minimal: [],
  "xarray-zarr": ["xarray", "zarr", "fsspec", "numcodecs", "numpy", "micropip"],
  "freva-client": [
    "xarray",
    "zarr",
    "fsspec",
    "numcodecs",
    "numpy",
    "micropip",
    "freva_client",
    "py_oidc_auth_client",
  ],
};

export class RuntimeError extends Error {
  readonly reason: UnsupportedReason;
  constructor(message: string, reason: UnsupportedReason, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeError";
    this.reason = reason;
  }
}

/**
 * Check the environment BEFORE downloading twenty megabytes: a browser that cannot run this should
 * be told so in a sentence, not by a failed WASM instantiation halfway through. Each reason has a
 * different answer for whoever is deploying, so they are not collapsed into one.
 */
export function checkEnvironment(): UnsupportedReason | null {
  if (typeof WebAssembly === "undefined") return "no-webassembly";
  // JSPI - stack switching - is what lets synchronous Python call an asynchronous browser API and
  // is the mechanism the Fetch filesystem depends on: `_cat_file` is `async`, but Zarr calls it
  // from synchronous code deep inside a decode. Pyodide can fall back to its own asyncify build,
  // so this is not fatal; `supportsJspi` reports it and the caller surfaces it when needed.
  return null;
}

/** True when the engine can suspend WASM to await JavaScript - see `checkEnvironment`. */
export function supportsJspi(): boolean {
  const suspending = (WebAssembly as unknown as { Suspending?: unknown }).Suspending;
  return typeof suspending === "function";
}

/**
 * Load `pyodide.mjs` from the pinned index and start an interpreter. The import is dynamic and by
 * URL, the only way to keep the runtime OUT of this package's bundle: a static import would make
 * every consumer's bundler try to inline 14 MB of WASM loader into their application chunk.
 */
export async function loadRuntime(options: {
  indexURL: string;
  packageBaseURL?: string;
  onStdout: (text: string) => void;
  onStderr: (text: string) => void;
}): Promise<PyodideApi> {
  const entry = new URL("pyodide.mjs", options.indexURL).href;
  let loadPyodide: LoadPyodide;
  try {
    const module = (await import(/* @vite-ignore */ /* webpackIgnore: true */ entry)) as {
      loadPyodide: LoadPyodide;
    };
    loadPyodide = module.loadPyodide;
  } catch (cause) {
    throw new RuntimeError(
      `Could not load the Python runtime from ${entry}. ` +
        `Check that the URL is reachable and CORS-enabled, or set pyodide.indexURL to a copy you host.`,
      "runtime-unreachable",
      cause,
    );
  }
  if (typeof loadPyodide !== "function") {
    throw new RuntimeError(
      `${entry} did not export loadPyodide; this does not look like a Pyodide distribution.`,
      "runtime-unreachable",
    );
  }

  return loadPyodide({
    indexURL: options.indexURL,
    ...(options.packageBaseURL !== undefined ? { packageBaseUrl: options.packageBaseURL } : {}),
    stdout: options.onStdout,
    stderr: options.onStderr,
  });
}

// `loadProfilePackages` fails when the packages did not load, because `pyodide.loadPackage`
// resolves on a failed download: it returns only the packages it got, so an `await` succeeds in
// exactly the case the caller most needs to know about, and the failure otherwise surfaces one
// step later as `ModuleNotFoundError: No module named 'fsspec'` from the browser filesystem
// registration. The check is on the RETURNED set, not on importability: a package name is not
// always a module name.
//
// `collapsePackageErrors` collapses Pyodide's package-loading errors into one readable line.
// `PyodideConsole` calls `loadPackagesFromImports` from inside Python, so its errors arrive on
// stderr in Pyodide's own shape - one "The following error occurred while loading <pkg>:" per
// package, its reason immediately after, and NO separator - which is seven lines of wrapped text
// carrying two words. Rewritten to "Could not download numpy, xarray, pandas: Failed to fetch";
// anything that does not match the shape is passed through untouched.
/**
 * Pyodide's package-loading NOTES, dropped or kept according to whether they say anything.
 *
 * Four messages arrive on the runtime's stdout, none written by anyone's Python: `Loading a, b, c`,
 * `Loaded a, b, c`, `<pkg> already loaded from <channel>` and `No new packages to load`, none with
 * a trailing newline, so in a transcript they run into each other. The last two report that
 * NOTHING HAPPENED and are dropped unconditionally. `Loading …` / `Loaded …` say a multi-megabyte
 * wheel is being fetched and the console is not hung, so they are kept once the session is running
 * - where a bare `import matplotlib` otherwise stares back in silence for several seconds - and
 * dropped during STARTUP, where the status line already says "Loading Python…". The match is
 * anchored and the whole message has to be one of these four, so a program printing "Loading data"
 * keeps its line.
 */
const PACKAGE_NOTE = {
  /** `Loading a, b, c` and `Loaded a, b, c` - progress, worth a line once a session is running. */
  progress: /^Load(?:ing|ed) [\w.-]+(?:, [\w.-]+)*$/,
  /** `<name> already loaded from <channel>[. To override …]` - a report that nothing happened. */
  redundant: /^[\w.-]+ already loaded from .+$/,
  /** Pyodide's own words for "there was nothing to do". */
  nothing: "No new packages to load",
} as const;

export function filterPackageNotes(text: string, phase: "starting" | "running"): string {
  const message = text.trim();
  if (!message) return text;
  if (message === PACKAGE_NOTE.nothing) return "";
  if (PACKAGE_NOTE.redundant.test(message)) return "";
  if (phase === "starting" && PACKAGE_NOTE.progress.test(message)) return "";
  // A kept progress note gets the newline Pyodide did not give it; without one, `Loading
  // matplotlib` and the next thing the interpreter writes share a line.
  if (PACKAGE_NOTE.progress.test(message)) return `${message}\n`;
  return text;
}

export function collapsePackageErrors(text: string): string {
  const pattern = /the following error occurred while loading ([^:]+):/gi;
  const first = pattern.exec(text);
  if (!first) return text;

  const prefix = text.slice(0, first.index);
  const names: string[] = [];
  const reasons = new Set<string>();
  let cursor = -1;
  let match: RegExpExecArray | null = first;
  while (match !== null) {
    if (cursor >= 0) {
      const reason = text.slice(cursor, match.index).trim();
      if (reason) reasons.add(reason);
    }
    names.push((match[1] ?? "").trim());
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }
  const tail = text.slice(cursor).trim();
  if (tail) reasons.add(tail);

  const why = reasons.size > 0 ? `: ${[...reasons].join("; ")}` : "";
  return `${prefix}Could not download ${names.join(", ")}${why}\n`;
}

/**
 * Pyodide's own reason, once, in one sentence. It emits the lead-in and the cause as separate
 * callback invocations and repeats the pair per package with no separator, so: strip every
 * lead-in, keep the distinct remainder, and take the first of it.
 */
function summariseProblem(problems: readonly string[]): string {
  const seen = new Set<string>();
  for (const fragment of problems.join("\n").split("\n")) {
    const text = fragment
      .replace(/the following error occurred while loading [^:]*:/gi, " ")
      .trim();
    if (text && !seen.has(text)) seen.add(text);
  }
  const first = [...seen][0];
  if (!first) return "";
  const capped = first.length > 100 ? `${first.slice(0, 99).trimEnd()}…` : first;
  return ` ${capped.endsWith(".") ? capped : `${capped}.`}`;
}

export async function loadProfilePackages(
  pyodide: PyodideApi,
  packages: readonly string[],
  where: string,
  /** Who asked, when it was not the profile - an add-on's name belongs in its own failure. */
  subject = "The interpreter started, but",
): Promise<void> {
  if (packages.length === 0) return;
  const problems: string[] = [];
  const loaded = await pyodide.loadPackage([...packages], {
    errorCallback: (message: string) => problems.push(message),
  });

  const arrived = new Set(
    (Array.isArray(loaded) ? loaded : []).map((entry) => String(entry?.name ?? "").toLowerCase()),
  );
  // Already present counts as arrived. See `PyodideApi.loadedPackages`.
  for (const name of Object.keys(pyodide.loadedPackages ?? {})) arrived.add(name.toLowerCase());
  const missing = packages.filter((name) => !arrived.has(name.toLowerCase()));
  if (missing.length === 0) return;

  // Pyodide's own reason, first line only: it concatenates one sentence per package with no
  // separator, so quoting all of it buries the sentence that matters under a paragraph that says
  // the same thing seventeen times.
  const because = summariseProblem(problems);
  // Two sentences, because one template cannot say both. "but ${n} of its packages could be
  // downloaded" is correct English only when n is "none" - with a single wheel missing it would
  // announce that one package COULD be downloaded and then list it as the problem.
  const summary =
    missing.length === packages.length
      ? "none of its packages could be downloaded"
      : `${missing.length} of its ${packages.length} packages could not be downloaded`;
  throw new RuntimeError(
    `${subject} ${summary}: ${missing.join(", ")}.${because}\n` +
      `They are fetched from ${where}. Either that location is not serving the wheels, or it ` +
      `cannot be reached from this page.`,
    "packages-unreachable",
  );
}

/**
 * The derived Freva wheel, served from the deployment's own `wheelhouseURL` and installed after
 * the lock packages, before the REPL.
 *
 * ONE WHEEL, WITH DEPENDENCY RESOLUTION. `micropip` reads its requirements and fetches them from
 * PyPI. The alternative - mirroring every dependency beside this one and installing each with
 * `deps=False` - is a second resolver maintained by hand, and the day a transitive requirement
 * moves it is a startup failure rather than a download. The derived wheel is what makes that
 * safe: `Requires-Dist: intake_esm` is under an extra, so the resolver never reaches the package
 * whose polars pin this runtime cannot satisfy, and `py-oidc-auth-client` and `appdirs` carry
 * `==` specifiers for the versions this package tests against.
 *
 * The deployment therefore needs PyPI reachable from the page, and a `connect-src` that names
 * `https://pypi.org` and `https://files.pythonhosted.org` - see the README's CSP section. Only
 * the Freva profile needs them; nothing else here contacts a package index.
 */
export const FREVA_CLIENT_WHEEL = "freva_client-2607.1.0+browser.1-py3-none-any.whl";

export async function installFrevaClient(pyodide: PyodideApi, wheelhouse: string): Promise<void> {
  const base = wheelhouse.endsWith("/") ? wheelhouse : `${wheelhouse}/`;
  const source = [
    "import micropip",
    `await micropip.install(${JSON.stringify(`${base}${FREVA_CLIENT_WHEEL}`)})`,
    "",
  ].join("\n");
  try {
    await pyodide.runPythonAsync(source);
  } catch (cause) {
    // RENDERED FROM PARTS, so this says what an add-on failure says: which resource class, where
    // from, which configuration key selects it, which command makes the files, and whether trying
    // again could help. `lastMeaningfulLine` is used because Pyodide's messages end in a newline,
    // so a plain `split("\n").pop()` yields an empty `Underlying error:`.
    const underlying = lastMeaningfulLine(cause);
    throw new RuntimeError(
      describeFailure({
        resource: "wheelhouse",
        kind: "install",
        url: base,
        ...(underlying ? { underlying } : {}),
      }),
      "packages-unreachable",
      cause,
    );
  }
}

/** Where credentials and configuration live when persistence is on. */
export const PERSIST_DIR = "/home/pyodide/.freva-browser";

/**
 * Mount IndexedDB-backed storage, and tell Freva to keep its state inside it.
 *
 * OPT-IN, as a security decision: what gets persisted is a refresh token, and browser storage is
 * readable by any same-origin script - including a package a visitor installs at the prompt. Off,
 * an interpreter still authenticates; the session ends with the tab. `syncfs(populate=true)` runs
 * BEFORE anything imports freva_client, because IDBFS starts empty and fills asynchronously, and
 * a token store read before the populate lands finds nothing. Returns whether persistence is
 * actually available - a browser with IndexedDB disabled must not fail startup over it, and must
 * not CLAIM persistence either.
 */
export async function mountPersistentStorage(
  pyodide: PyodideApi,
  onDegraded?: (reason: unknown) => void,
): Promise<boolean> {
  const sync = (populate: boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      pyodide.FS.syncfs(populate, (error: unknown) => (error ? reject(error) : resolve()));
    });
  const removeHook = () => {
    delete (globalThis as unknown as Record<string, unknown>)._freva_browser_syncfs;
  };

  try {
    pyodide.FS.mkdirTree(PERSIST_DIR);
    pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, PERSIST_DIR);
    await sync(true);
  } catch {
    removeHook();
    return false;
  }

  // XDG variables plus PYTHONUSERBASE, which is what CONFIG_GET_DIRS falls back to, so the patch
  // and the mount agree on one location instead of each having an opinion.
  pyodide.runPython(
    [
      "import os",
      `os.environ["XDG_CACHE_HOME"] = ${JSON.stringify(`${PERSIST_DIR}/cache`)}`,
      `os.environ["XDG_CONFIG_HOME"] = ${JSON.stringify(`${PERSIST_DIR}/config`)}`,
      `os.environ["PYTHONUSERBASE"] = ${JSON.stringify(`${PERSIST_DIR}/user`)}`,
      "for _p in (os.environ['XDG_CACHE_HOME'], os.environ['XDG_CONFIG_HOME'], os.environ['PYTHONUSERBASE']):",
      "    os.makedirs(_p, exist_ok=True)",
      "",
    ].join("\n"),
  );

  // The flush, callable from Python. IDBFS keeps its writes in memory until syncfs, so a token
  // written and never flushed does not survive the reload it was persisted for;
  // `freva_client_compat` calls this after a successful authentication.
  //
  // It resolves a BOOLEAN and never rejects, because Python's caller swallows exceptions on
  // purpose - a storage flush that fails must not fail an authentication that succeeded - so a
  // rejection would only become an unhandled one. The first failure removes the hook and reports
  // it once, and `persistence_available()` then answers `False`. Installed on the WORKER's global
  // rather than `pyodide.globals`, the `__main__` namespace, which `freva_client_compat` is not.
  const flush = async (): Promise<boolean> => {
    try {
      await sync(false);
      return true;
    } catch (error) {
      removeHook();
      onDegraded?.(error);
      return false;
    }
  };
  (globalThis as unknown as Record<string, unknown>)._freva_browser_syncfs = flush;

  // The first flush decides whether persistence is real, and a failure here is NOT fatal: outside
  // the try above, a browser at its storage quota could not start an interpreter at all - an
  // optional feature taking down the thing it was optional to.
  if (!(await flush())) return false;
  return true;
}

/** Write the package's Python helpers into the interpreter's filesystem. */
export function installPythonHelpers(pyodide: PyodideApi): void {
  pyodide.FS.mkdirTree(PYTHON_DIR);
  for (const [name, source] of PYTHON_SOURCES) {
    pyodide.FS.writeFile(`${PYTHON_DIR}/${name}`, source);
  }
  // On `sys.path` HERE, by the function that writes the files. `Repl.start()` also inserts it but
  // is no longer the first consumer: the freva-client profile applies its compatibility adapter
  // BEFORE the REPL exists, because the adapter has to be in place before anything imports
  // freva_client. Whoever writes the modules owns making them importable.
  pyodide.runPython(
    `import sys\nif ${JSON.stringify(PYTHON_DIR)} not in sys.path: ` +
      `sys.path.insert(0, ${JSON.stringify(PYTHON_DIR)})`,
  );
}
