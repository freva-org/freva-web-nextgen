/**
 * Types for the browser-matrix selector.
 *
 * Hand-written rather than switching the test project to `allowJs`: this is the
 * only `.mjs` module the TypeScript tests import, and turning on `allowJs`
 * would silently pull every other script into the type-check graph.
 */
export type BrowserName = "chromium" | "firefox" | "webkit";

export interface BrowserSelection {
  browsers: BrowserName[];
  /** Human-readable lines the caller should print; may be empty. */
  notes: string[];
  source: "strict" | "override" | "platform-default";
}

export interface SelectOptions {
  /** `process.platform` of the machine the commands will run on. */
  platform: string;
  /** True for `test:browser:strict` — the release gate. */
  strict?: boolean;
  /** Raw `BROWSERS` value, if set. */
  override?: string;
}

export declare const ALL_BROWSERS: readonly BrowserName[];
export declare const MACOS_WEBKIT_NOTE: string;
/** The Docker one-liner that runs the full gate from a macOS host. */
export declare const DOCKER_STRICT_COMMAND: string;
export declare const MACOS_STRICT_MESSAGE: string;

export declare class StrictUnavailableError extends Error {
  readonly code: "STRICT_UNAVAILABLE";
}

export declare function parseBrowserOverride(raw: string | undefined | null): BrowserName[] | null;

export declare function selectBrowsers(options: SelectOptions): BrowserSelection;

export declare function selectInstallBrowsers(
  options: Omit<SelectOptions, "strict">,
): BrowserSelection;
