/**
 * Types for the shared suite requirements, so the drift test can be type-checked. A declaration
 * file rather than a rewrite in TypeScript: the browser suites are plain ESM run directly by
 * node, with no build step between writing one and running it.
 */
export declare const SUITE_REQUIREMENTS: Readonly<Record<string, readonly string[]>>;
/** Wheels a suite uses for some checks but can run without. See the source for why. */
export declare const SUITE_OPTIONAL_PACKAGES: Readonly<Record<string, readonly string[]>>;
export declare function suitePackages(): string[];
