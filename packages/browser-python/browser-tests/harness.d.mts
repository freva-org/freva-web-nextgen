/**
 * Types for the browser-suite harness, for the unit tests that reach into it; only the surface
 * `tests/` uses is declared. The harness is plain JavaScript on purpose, but
 * `tests/browser-gate.test.ts` asserts on `report()`'s exit codes and an untyped import fails
 * `tsc` under `noImplicitAny`.
 */
export interface SuiteCheck {
  name: string;
  pass: boolean;
  detail?: string;
  /** Only transient browser-runtime failures may request a fresh-process retry. */
  retryable?: boolean;
}
/** Something inside a passing suite that could not exist in this engine, and why. */
export interface NotApplicablePart {
  name: string;
  reason: string;
}
export interface SuiteResult {
  status?: "pass" | "fail" | "skipped" | "not-applicable";
  detail?: string;
  /** Required with `status: "not-applicable"`: the capability this engine's worker lacks. */
  reason?: string;
  retryable?: boolean;
  checks?: SuiteCheck[];
  notApplicable?: NotApplicablePart[];
}
/** Print a suite's checks and return the process exit code: 0 only for a real pass. */
export declare function report(title: string, result: SuiteResult): number;
export declare function isStrict(): boolean;
/** Exit codes whose MEANINGS are the contract `run.mjs` and CI read. See the harness source. */
export declare const EXIT_NOT_BUILT: number;
export declare const EXIT_NOT_RUN: number;
export declare const EXIT_RETRYABLE: number;
export declare const EXIT_NOT_APPLICABLE: number;
/** The engine this process runs suites in: `BROWSER_ENGINE`, Chromium when unset. */
export declare const ENGINE: "chromium" | "firefox" | "webkit";
export declare const ENGINES: readonly string[];
/** The one way a suite says its wheels are absent: prints the reason and exits `EXIT_NOT_RUN`. */
export declare function requireRuntimeFor(title: string, suite: string): void;

/** Where the derived Freva wheel is built for the suites that need it. Git-ignored. */
export declare const FREVA_WHEELHOUSE: string;
/** Build the derived Freva wheel from PyPI, once, and return the directory holding it. */
export declare function ensureFrevaWheelhouse(): Promise<string>;
