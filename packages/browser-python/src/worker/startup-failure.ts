/**
 * What went wrong at startup, in parts a caller can act on.
 *
 * A sentence is enough for a visitor to read and not enough to fix a deployment with. The four
 * things that decide what to DO are: WHICH resource class failed - runtime, profile package,
 * Freva wheelhouse, add-on - since each has its own configuration key and preparation command;
 * WHERE it was fetched from and what the server said; WHICH public option selects that location,
 * by its portal name AND its API name; and whether pressing Restart can help. That last one
 * misleads most: a 403 or 404 on a pinned artefact is a statement about a deployment, not a
 * moment, because the URL comes from configuration and a digest.
 *
 * The failure OBJECT is what travels and the sentence is rendered from it, so a host can draw a
 * panel, group two failures or decide whether to offer Restart.
 */

import type { BrowserPythonAddon } from "../types.js";

/**
 * Which kind of thing could not be obtained. Separated because the remedy differs, not the fetch:
 * `runtime` is Pyodide itself, `profile-package` a wheel from the runtime's own lock,
 * `wheelhouse` the Freva client, `addon` a curated capability. A caller deciding which
 * configuration key to name needs this.
 */
export type FailedResource = "runtime" | "profile-package" | "wheelhouse" | "addon";

/** The public names for one resource class: what a portal writes, and what the API calls it. */
interface ResourceNames {
  /** The `pythonPlayground` key in a portal's YAML. */
  portalKey: string;
  /** The option name on `createBrowserPython`. */
  apiKey: string;
  /** The command that produces these files. */
  prepare: string;
}

const NAMES: Readonly<Record<FailedResource, ResourceNames>> = {
  runtime: {
    portalKey: "pythonPlayground.runtimeIndexUrl",
    apiKey: "pyodide.indexURL",
    prepare: "freva-browser-python prepare-runtime",
  },
  "profile-package": {
    portalKey: "pythonPlayground.runtimeIndexUrl",
    apiKey: "pyodide.indexURL",
    prepare: "freva-browser-python prepare-runtime --full",
  },
  wheelhouse: {
    portalKey: "pythonPlayground.wheelhouseUrl",
    apiKey: "wheelhouseURL",
    prepare: "freva-browser-python prepare-freva-wheelhouse",
  },
  addon: {
    portalKey: "pythonPlayground.addonBaseUrl",
    apiKey: "addonBaseURL",
    prepare: "freva-browser-python prepare-addons",
  },
};

/** Everything known about one thing that could not be obtained or verified. */
export interface StartupFailure {
  resource: FailedResource;
  /** The add-on this is about, when `resource` is `addon`. */
  addon?: BrowserPythonAddon;
  /** Whether the add-on was declared optional - see `optionalAddons`. */
  optional?: boolean;
  /** A short noun phrase for the artefact: `"dask 2026.8.0"`, `"ne_110m_coastline.shp"`. */
  artefact?: string;
  /** The exact URL that was requested, when there was one. */
  url?: string;
  /** The HTTP status, when the server answered at all. */
  status?: number;
  /**
   * What kind of failure this is, which decides whether retrying is sensible. `unavailable` is a
   * server that answered with a status (403/404/500), deterministic for a fixed URL; `unreachable`
   * is a network or CORS failure, possibly transient; `mismatch` is a digest that did not match,
   * and no retry changes bytes; `install` arrived intact and could not be installed.
   */
  kind: "unavailable" | "unreachable" | "mismatch" | "install" | "unsupported";
  /** The digests, when `kind` is `mismatch`. */
  digests?: { expected: string; received: string };
  /** The last useful line of an underlying error, already extracted. Never empty when present. */
  underlying?: string;
}

/**
 * The last line of an error message that actually says something. `message.split("\n").pop()` is
 * wrong in the ordinary case: Python tracebacks arriving through Pyodide end with a newline, so
 * `pop()` returns the empty string and the caller prints `Underlying error:` with nothing after
 * the colon. Trailing blanks are skipped, the result trimmed, and an empty input gives `undefined`.
 */
export function lastMeaningfulLine(value: unknown): string | undefined {
  const text =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : String(value ?? "");
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line !== "") return line;
  }
  return undefined;
}

/** Whether attempting the identical configuration again could plausibly produce a different result. */
export function retryMayHelp(failure: StartupFailure): boolean {
  // Only a transport failure. A status, a digest mismatch and a refused profile are all functions
  // of the configuration and the deployment, and both are the same on the next attempt.
  return failure.kind === "unreachable";
}

/**
 * The whole story, as prose, from the parts. Ordered the way somebody reads it: what is
 * unavailable, where it was looked for and what came back, which option chooses that place, how
 * the files are made, and - only when it is true - whether trying again is worth anything.
 */
export function describeFailure(failure: StartupFailure): string {
  const names = NAMES[failure.resource];
  const subject =
    failure.resource === "addon"
      ? `The '${failure.addon}' add-on${failure.optional ? " (optional)" : ""}`
      : failure.resource === "wheelhouse"
        ? "The Freva client's wheels"
        : failure.resource === "runtime"
          ? "The Python runtime"
          : "A package this profile needs";
  const what = failure.artefact ? `${subject}: ${failure.artefact}` : subject;

  const lines: string[] = [];
  switch (failure.kind) {
    case "unavailable":
      lines.push(`${what} is not available at ${failure.url} (HTTP ${failure.status}).`);
      break;
    case "unreachable":
      lines.push(`${what} could not be fetched from ${failure.url}.`);
      break;
    case "mismatch":
      lines.push(`${what} is not the artefact this build pinned.`);
      if (failure.digests) {
        lines.push(`  expected sha256 ${failure.digests.expected}`);
        lines.push(`  received sha256 ${failure.digests.received}`);
      }
      lines.push(`Nothing from ${failure.url} has been installed.`);
      break;
    case "install":
      lines.push(`${what} was fetched and verified, and could not be installed.`);
      break;
    case "unsupported":
      lines.push(what);
      break;
  }

  if (failure.underlying) lines.push(`Underlying error: ${failure.underlying}`);

  if (failure.kind !== "unsupported") {
    lines.push(
      `These are static files this deployment serves; ${names.portalKey} ` +
        `(${names.apiKey} in the API) selects where from, and they are created with ` +
        `\`${names.prepare}\`.`,
    );
    if (failure.url) lines.push(`Expected to be served at: ${failure.url}`);
    lines.push(
      retryMayHelp(failure)
        ? "This looks like a network or CORS failure rather than a missing file, so a restart may help."
        : "Restarting requests the same URL and gets the same answer; this needs the deployment fixed, not another attempt.",
    );
  }
  return lines.join("\n");
}

/**
 * One message for several failures, without repeating the advice once per failure. Preparation
 * attempts every independent asset group rather than stopping at the first, so a deployment that
 * forgot to upload two directories learns about both in one go.
 */
export function describeFailures(failures: readonly StartupFailure[]): string {
  if (failures.length === 0) return "";
  if (failures.length === 1) return describeFailure(failures[0]!);
  const parts = failures.map((failure, index) => `${index + 1}. ${describeFailure(failure)}`);
  return [
    `${failures.length} things this interpreter needs could not be prepared:`,
    "",
    ...parts,
  ].join("\n");
}
