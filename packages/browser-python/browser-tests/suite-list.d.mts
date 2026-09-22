/**
 * Types for the suite listing, so the release-gate test can be type-checked. A declaration file
 * rather than a rewrite in TypeScript, for the same reason as `suite-requirements.d.mts`: the
 * browser suites are plain ESM run directly by node, with no build step between writing one and
 * running it.
 */
export declare const SUITES: string[];
export declare const NETWORK_SUITES: string[];
export declare const PACKAGE_INDEX_SUITES: string[];
export declare const CROSS_BROWSER: readonly string[];
export interface SuiteClass {
  category: "console" | "portable" | "capability" | "chromium";
  capabilities?: readonly string[];
  reason?: string;
}
export declare const SUITE_CLASSES: Readonly<Record<string, SuiteClass>>;
export declare const CATEGORIES: readonly string[];
export declare const CAPABILITIES: Readonly<Record<string, string>>;
/** Suites that test nothing engine-specific, each with the reason. */
export declare const ENGINE_INDEPENDENT: Readonly<Record<string, string>>;
export declare function planFor(
  engine: string,
  suites: readonly string[],
  options?: { skipEngineIndependent?: boolean },
): {
  run: string[];
  withheld: { suite: string; reason: string }[];
  coveredElsewhere: { suite: string; reason: string }[];
};
export declare const DEFAULT_GATE_REQUIRES: readonly string[];
