/** Types for the runtime verifier, consumed by `tests/runtime-verify.test.ts`. See the .mjs. */
export declare const CORE_ASSETS: readonly string[];
export declare function digestOf(bytes: Uint8Array | Buffer | string): string;
export declare function closure(
  lock: unknown,
  names: readonly string[],
): { resolved: string[]; unknown: string[] };
export declare function verifyRuntime(options: {
  dir: string;
  manifest: unknown;
  lock?: unknown;
  expectedManifestId?: string;
  packages?: readonly string[];
}): string[];
