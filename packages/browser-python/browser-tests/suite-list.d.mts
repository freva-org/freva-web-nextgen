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
