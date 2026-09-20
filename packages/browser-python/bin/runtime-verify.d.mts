/** Types for the shipped runtime verifier. See the .mjs for what each rule is for. */
export declare const RUNTIME_STAMP: string;
export declare const ESSENTIAL: readonly (readonly string[])[];
export declare function digestOfFile(path: string): string;
export declare function coreAssets(dir: string): string[];
/** One release's pinned entry: the archive digest, and the exact core inventory it ships. */
export interface RuntimeRelease {
  sha256?: string;
  core?: Record<string, string>;
  [key: string]: unknown;
}
/** The release table's entry for a version, or `null` when nothing is recorded about it. */
export declare function recordedRelease(
  version: string | undefined,
  releases?: Record<string, RuntimeRelease>,
): RuntimeRelease | null;
/** The exact `{ filename: sha256 }` a PINNED release ships, or `null` for an unrecorded version. */
export declare function coreOf(
  version: string | undefined,
  releases?: Record<string, RuntimeRelease>,
): Record<string, string> | null;
export declare function verifyPreparedRuntime(options: {
  dir: string;
  version?: string;
  full?: boolean;
  requireStamp?: boolean;
  /** The pinned release table. Defaults to the one this package ships; injected by tests. */
  releases?: Record<string, RuntimeRelease>;
}): string[];
