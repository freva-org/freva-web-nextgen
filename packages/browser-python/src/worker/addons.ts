/**
 * Curated add-ons: what they are, and what preparing one actually does. An add-on is a CLOSED
 * capability, not a package name - nothing accepts a URL, a distribution name or an install script
 * from a caller. The ids are a union this package compiled, every artefact is pinned in
 * `bin/freva-addons.json`, and each digest travels inside the bundle rather than beside the files,
 * because a manifest served next to the wheels is written by whoever can replace the wheels.
 * Preparation runs ONCE, inside `handleInit`, after the profile's packages and before the REPL
 * exists, and a failure is fatal to `start()`.
 */

import type {
  BrowserPythonAddon,
  BrowserPythonProfile,
  ReadyAddonInfo,
  UnavailableAddonInfo,
} from "../types.js";
import {
  describeFailure,
  describeFailures,
  lastMeaningfulLine,
  retryMayHelp,
  type StartupFailure,
} from "./startup-failure.js";
import { ADDONS, isAddon, supportsOptional } from "../addons.js";
import { ADDON_PINS } from "./addon-pins.generated.js";
import type { AddonPin } from "./addon-types.js";
import { RuntimeError, type PyodideApi } from "./pyodide-runtime.js";

export { ADDONS, isAddon, supportsOptional };

/** Where an add-on's staged files live in the interpreter's filesystem. */
export const ADDON_ROOT = "/freva-addons";

/** The one place an add-on's served directory and its staged directory agree on a name. */
export const addonDir = (id: string): string => `${ADDON_ROOT}/${id}`;

export function addonPin(id: BrowserPythonAddon): AddonPin {
  const pin = ADDON_PINS[id];
  if (!pin) throw new RuntimeError(`Unknown add-on '${id}'.`, "packages-unreachable");
  return pin;
}

/**
 * Default location for add-on artefacts: `python-addons/` beside the runtime. The same shape as the
 * Freva wheelhouse's default, so a deployment that copies both together configures nothing.
 */
export function defaultAddonBase(indexURL: string): string {
  return new URL("../python-addons/", indexURL).href;
}

/**
 * One structured failure, carried as an exception so the fetch helpers can stay expression-shaped.
 * Caught inside `prepareAddons`, which renders it as a `RuntimeError` or an `UnavailableAddonInfo`.
 */
class AddonFailure extends Error {
  readonly failure: StartupFailure;
  constructor(failure: StartupFailure) {
    super(describeFailure(failure));
    this.name = "AddonFailure";
    this.failure = failure;
  }
}

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Fetch one pinned artefact and refuse anything that is not byte-for-byte what was pinned. The
 * digest is computed over the bytes that will be USED, not over a second download.
 */
async function fetchPinned(
  url: string,
  sha256: string,
  describe: Omit<StartupFailure, "kind" | "url" | "status" | "digests">,
): Promise<Uint8Array> {
  const fail = (extra: Partial<StartupFailure>): never => {
    throw new AddonFailure({ ...describe, url, ...extra } as StartupFailure);
  };
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new AddonFailure({
      ...describe,
      url,
      kind: "unsupported",
      underlying:
        "this context has no Web Crypto, so an artefact cannot be verified - serve the portal " +
        "over HTTPS, or from localhost. An unverified wheel is not installed.",
    } as StartupFailure);
  }
  let response: Response;
  try {
    response = await fetch(url, { credentials: "omit" });
  } catch (cause) {
    return fail({
      kind: "unreachable",
      ...(lastMeaningfulLine(cause) ? { underlying: lastMeaningfulLine(cause)! } : {}),
    });
  }
  if (!response.ok) return fail({ kind: "unavailable", status: response.status });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = hex(await subtle.digest("SHA-256", bytes));
  if (digest !== sha256) {
    return fail({ kind: "mismatch", digests: { expected: sha256, received: digest } });
  }
  return bytes;
}

function writeFile(pyodide: PyodideApi, path: string, bytes: Uint8Array): void {
  const at = path.lastIndexOf("/");
  if (at > 0) pyodide.FS.mkdirTree(path.slice(0, at));
  pyodide.FS.writeFile(path, bytes);
}

/**
 * What each add-on has to say to Python once its artefacts are in place. Deliberately tiny, and NOT
 * an import of the library it is about - except for Dask, where setting the scheduler before any
 * user code runs is the whole contract.
 */
const ACTIVATION: Readonly<Record<string, (dir: string) => string>> = {
  dask: () =>
    [
      "import os",
      // Read by dask.config at import, so the answer is already right for anything that imports
      // dask later - including code that never calls `dask.config.set` itself.
      "os.environ['DASK_SCHEDULER'] = 'synchronous'",
      "import dask",
      // ONE Worker, ONE synchronous scheduler. Not a cluster, not a thread pool, not a promise of
      // parallelism: there is a single interpreter here, and the honest scheduler is the one that
      // runs the graph on it.
      "dask.config.set(scheduler='synchronous')",
      "",
    ].join("\n"),
  "cartopy-natural-earth-110m": (dir) =>
    [
      "import os",
      // `cartopy/__init__.py` reads CARTOPY_DATA_DIR into `config['pre_existing_data_dir']` at
      // import time, so this both points Cartopy at the staged files and avoids importing Cartopy
      // (and through it Matplotlib and SciPy) merely because an add-on was configured.
      `os.environ['CARTOPY_DATA_DIR'] = ${JSON.stringify(dir)}`,
      "",
    ].join("\n"),
};

export interface PrepareAddonsOptions {
  addons: readonly BrowserPythonAddon[];
  /** Add-ons whose absence is tolerable. Must be a subset of `addons`; see `supportsOptional`. */
  optional?: readonly BrowserPythonAddon[];
  profile: BrowserPythonProfile;
  addonBaseURL: string;
  onStatus?: (message: string) => void;
  onWarning?: (message: string) => void;
  loadPackages: (names: readonly string[], where: string) => Promise<void>;
}

export interface PreparedAddons {
  prepared: ReadyAddonInfo[];
  unavailable: UnavailableAddonInfo[];
}

/** The one-line remedy for an add-on that did not arrive. Shown to a reader, so it says what to do. */
function remedyFor(id: BrowserPythonAddon): string {
  return (
    `Prepare the files with \`freva-browser-python prepare-addons --addons ${id}\` and serve them ` +
    `from the directory pythonPlayground.addonBaseUrl (addonBaseURL in the API) names.`
  );
}

/**
 * Install and stage every configured add-on, or fail the start - except the ones allowed to be
 * absent. The order is the registry's own, so two portals that name the same add-ons differently
 * get the same interpreter.
 *
 * Every artefact is fetched AND digest-checked before any of them is written, which is what makes
 * an optional add-on possible. An add-on that fails does not stop the ones after it - the registry
 * order puts `cartopy-natural-earth-110m` before `dask` - and a failed start reports everything it
 * found in one message.
 */
export async function prepareAddons(
  pyodide: PyodideApi,
  options: PrepareAddonsOptions,
): Promise<PreparedAddons> {
  const wanted = ADDONS.filter((id) => options.addons.includes(id));
  if (wanted.length === 0) return { prepared: [], unavailable: [] };
  const optional = new Set(options.optional ?? []);

  // An add-on that cannot be optional must not be TREATED as optional, and the refusal is fatal
  // rather than a downgrade to required: a deployment that asked for best-effort Dask has decided
  // what its pages may promise.
  for (const id of optional) {
    if (!wanted.includes(id)) continue;
    if (!supportsOptional(id)) {
      throw new RuntimeError(
        `The '${id}' add-on cannot be optional.\n` +
          `It installs wheels into the interpreter, so a failure part-way through would leave a ` +
          `session holding some of its dependencies and not the capability. There is no supported ` +
          `way to undo that in a live interpreter, so this add-on is required or absent, never ` +
          `best-effort. Remove it from optionalAddons, or stop configuring it.`,
        "packages-unreachable",
      );
    }
  }

  const base = options.addonBaseURL.endsWith("/")
    ? options.addonBaseURL
    : `${options.addonBaseURL}/`;
  const report: ReadyAddonInfo[] = [];
  const unavailable: UnavailableAddonInfo[] = [];
  const fatal: StartupFailure[] = [];

  for (const id of wanted) {
    const pin = addonPin(id);
    const isOptional = optional.has(id);
    const context = {
      resource: "addon" as const,
      addon: id,
      ...(isOptional ? { optional: true } : {}),
    };

    if (!pin.profiles.includes(options.profile)) {
      // A profile mismatch is a CONFIGURATION error and stays fatal even for an optional add-on: it
      // is not a deployment that failed to upload something, it is a portal asking for a capability
      // that cannot exist on the interpreter it chose, and it is knowable at build time.
      throw new RuntimeError(
        `The '${id}' add-on does not work with the '${options.profile}' profile.\n` +
          `It is available on: ${pin.profiles.join(", ")}.`,
        "packages-unreachable",
      );
    }
    options.onStatus?.(`preparing ${id}`);

    try {
      // First, fetch and verify EVERYTHING. No interpreter state is touched here.
      const wheels: { file: string; bytes: Uint8Array }[] = [];
      for (const wheel of pin.wheels) {
        wheels.push({
          file: wheel.file,
          bytes: await fetchPinned(`${base}${id}/${wheel.file}`, wheel.sha256, {
            ...context,
            artefact: `${wheel.name} ${wheel.version}`,
          }),
        });
      }
      const data: { path: string; bytes: Uint8Array }[] = [];
      for (const file of pin.data) {
        data.push({
          path: file.path,
          bytes: await fetchPinned(`${base}${id}/${file.path}`, file.sha256, {
            ...context,
            artefact: file.path,
          }),
        });
      }

      // Then mutate: everything below is known to be the pinned bytes. The runtime packages
      // come first because the wheels depend on them, and they come from the pinned runtime's own
      // lock rather than a mirror: re-hosting them would be a second copy to keep honest.
      if (pin.runtimePackages.length > 0) {
        await options.loadPackages(pin.runtimePackages, `the '${id}' add-on`);
      }
      for (const wheel of wheels) {
        const path = `${addonDir(id)}/wheels/${wheel.file}`;
        writeFile(pyodide, path, wheel.bytes);
        try {
          // `emfs:` - the verified bytes, from the filesystem, and never a second download. Handing
          // micropip the http URL would fetch the wheel again, so the bytes checked and the bytes
          // installed would be two different responses. `deps=False` because resolution in a
          // browser means contacting PyPI, and the closure is pinned here so that never happens.
          await pyodide.runPythonAsync(
            `import micropip\nawait micropip.install("emfs:${path}", deps=False)\n`,
          );
        } catch (cause) {
          const underlying = lastMeaningfulLine(cause);
          throw new AddonFailure({
            ...context,
            artefact: wheel.file,
            kind: "install",
            ...(underlying ? { underlying } : {}),
          });
        }
      }
      for (const file of data) writeFile(pyodide, `${addonDir(id)}/${file.path}`, file.bytes);

      const activate = ACTIVATION[id];
      if (activate) {
        try {
          await pyodide.runPythonAsync(activate(addonDir(id)));
        } catch (cause) {
          const underlying = lastMeaningfulLine(cause);
          throw new AddonFailure({
            ...context,
            kind: "install",
            artefact: "its activation",
            ...(underlying ? { underlying } : {}),
          });
        }
      }
      report.push({ id, title: pin.title, versions: {} });
    } catch (error) {
      if (!(error instanceof AddonFailure)) throw error;
      if (!isOptional) {
        fatal.push(error.failure);
        continue;
      }
      // OPTIONAL, AND NOTHING WAS INSTALLED. `supportsOptional` guaranteed above that this add-on
      // has no wheels and no runtime packages, so the only failures reachable here happen before a
      // single byte was written, or in an activation that sets an environment variable.
      unavailable.push({
        id,
        title: pin.title,
        reason: firstLine(describeFailure(error.failure)),
        remedy: remedyFor(id),
        retryMayHelp: retryMayHelp(error.failure),
      });
      // ONE warning, here, at the moment it is decided - not a traceback, and not once per restart.
      // The ready payload carries the same information in a form a UI can render, which is where a
      // reader should meet it.
      options.onWarning?.(
        `${pin.title} is unavailable: ${firstLine(describeFailure(error.failure))} ` +
          `Python started without it.`,
      );
    }
  }

  if (fatal.length > 0) {
    throw new RuntimeError(describeFailures(fatal), "packages-unreachable");
  }
  return { prepared: report, unavailable };
}

/** The first line of a rendered failure: enough to say what happened, short enough for a row. */
function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

/** Fill in the versions an add-on promised to report, once the REPL can resolve them. */
export function describeAddons(
  prepared: readonly ReadyAddonInfo[],
  resolve: (names: readonly string[]) => Record<string, string>,
): ReadyAddonInfo[] {
  return prepared.map((entry) => ({
    ...entry,
    versions: resolve(addonPin(entry.id).reports),
  }));
}
