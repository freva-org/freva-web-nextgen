/** Types for `build-stamp.mjs`, for the unit test that holds it. */
export declare const STAMP_FILE: string;
export declare const BUILD_INPUTS: readonly string[];
export declare function sourceDigest(pkgDir?: string, inputs?: readonly string[]): string;
export declare function writeStamp(
  pkgDir?: string,
  inputs?: readonly string[],
): { digest: string; builtAt: string };
export declare function checkStamp(
  pkgDir?: string,
  inputs?: readonly string[],
): { ok: true } | { ok: false; reason: string };
