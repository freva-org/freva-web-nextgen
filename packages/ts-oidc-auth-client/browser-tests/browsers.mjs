/**
 * Which browser engines to install and run - decided once, in one place.
 *
 * Two audiences with different needs:
 *
 *  - **Local development.** This project omits WebKit from local macOS runs
 *    because of observed Playwright/macOS compatibility failures launching it:
 *    an engine a developer cannot start produces no signal. That is this
 *    project's choice for its own local workflow, not a general claim about
 *    Playwright on macOS. Chromium and Firefox there, with one line saying so.
 *  - **The release gate.** `test:browser:strict` is release EVIDENCE and always
 *    means all three engines actually executed. It is never narrowed - not by
 *    platform, not by an environment variable. On macOS it refuses to run at
 *    all rather than report a two-engine pass, because "the gate passed" has to
 *    keep meaning the same thing everywhere.
 *
 * Pure functions over an explicit `platform` argument: no `uname`, no shell,
 * and every branch is testable on any host.
 */

export const ALL_BROWSERS = Object.freeze(["chromium", "firefox", "webkit"]);

/** Engines this project omits from LOCAL runs, per development platform. */
const UNRELIABLE_FOR_DEVELOPMENT = Object.freeze({
  darwin: Object.freeze(["webkit"]),
});

/**
 * The one-liner that runs the full gate on a macOS host.
 *
 *  - `npm run build` is NOT optional: the suites import `../dist`, so a clean
 *    checkout without it fails with "dist/ not found" before any browser opens.
 *  - `--init` reaps the zombie processes browsers leave behind; `--ipc=host`
 *    gives Chromium a large enough /dev/shm to avoid spurious crashes. Both are
 *    Docker's own recommendations for running browsers in containers.
 *  - The anonymous volumes on `node_modules` and `dist` keep the container's
 *    Linux-native dependencies and root-owned build output inside the
 *    container, instead of overwriting the macOS checkout's own.
 */
export const DOCKER_STRICT_COMMAND =
  "docker run --rm -it --init --ipc=host \\\n" +
  '    -v "$PWD":/w -v /w/node_modules -v /w/dist -w /w \\\n' +
  "    mcr.microsoft.com/playwright:v1.62.1-noble \\\n" +
  "    bash -lc 'npm ci && npm run build && npm run test:browser:strict'";

export const MACOS_WEBKIT_NOTE =
  "WebKit is omitted from local macOS runs: this project has observed " +
  "Playwright/macOS compatibility failures launching it, so it produces no " +
  "usable signal here. The full three-engine release matrix runs on Linux CI " +
  "or the Playwright Docker image (see browser-tests/README.md).";

export const MACOS_STRICT_MESSAGE =
  "test:browser:strict requires Chromium, Firefox AND WebKit, and this project " +
  "omits local macOS WebKit because of observed Playwright/macOS compatibility " +
  "failures. Refusing to run: a two-engine pass is not the release gate. Run it " +
  "on Linux CI, or locally with the Playwright Docker image:\n" +
  `  ${DOCKER_STRICT_COMMAND}\n` +
  "For local checks use `npm run test:browser` (Chromium + Firefox).";

/** Thrown when the strict gate cannot honestly run on this platform. */
export class StrictUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "StrictUnavailableError";
    this.code = "STRICT_UNAVAILABLE";
  }
}

/**
 * Parse a `BROWSERS=a,b` override. Returns null when unset, and throws on an
 * engine name Playwright does not have - a typo silently running nothing is
 * how a green board comes to mean nothing.
 */
export function parseBrowserOverride(raw) {
  if (raw === undefined || raw === null) return null;
  const names = String(raw)
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  const unknown = names.filter((n) => !ALL_BROWSERS.includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `BROWSERS contains unknown engine(s): ${unknown.join(", ")}. ` +
        `Valid names are ${ALL_BROWSERS.join(", ")}.`,
    );
  }
  return [...new Set(names)];
}

/**
 * The engines to RUN.
 *
 * @param {{platform: string, strict?: boolean, override?: string}} options
 * @returns {{browsers: string[], notes: string[], source: string}}
 */
export function selectBrowsers({ platform, strict = false, override } = {}) {
  const requested = parseBrowserOverride(override);

  if (strict) {
    if (UNRELIABLE_FOR_DEVELOPMENT[platform]?.length) {
      throw new StrictUnavailableError(MACOS_STRICT_MESSAGE);
    }
    // The release matrix is fixed. An override here could only narrow it, and
    // a narrowed gate that still reports "strict" is the failure mode this
    // whole file exists to prevent.
    return {
      browsers: [...ALL_BROWSERS],
      notes: requested
        ? ["BROWSERS is ignored in strict mode: the release gate is always all three engines."]
        : [],
      source: "strict",
    };
  }

  if (requested) {
    return { browsers: requested, notes: [], source: "override" };
  }

  const omitted = UNRELIABLE_FOR_DEVELOPMENT[platform] ?? [];
  if (omitted.length > 0) {
    return {
      browsers: ALL_BROWSERS.filter((b) => !omitted.includes(b)),
      notes: [MACOS_WEBKIT_NOTE],
      source: "platform-default",
    };
  }
  return { browsers: [...ALL_BROWSERS], notes: [], source: "platform-default" };
}

/**
 * The engines to INSTALL. Deliberately the same matrix as the default local
 * run: installing an engine the local commands will not use wastes a large
 * download, and running one that was never installed reports a failure the
 * developer cannot act on.
 *
 * Note this only ever ADDS to Playwright's shared cache. Nothing here removes
 * a browser - that cache belongs to every project on the machine, not to this
 * package.
 */
export function selectInstallBrowsers({ platform, override } = {}) {
  return selectBrowsers({ platform, strict: false, override });
}
