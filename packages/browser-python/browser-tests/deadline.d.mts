/** Types for `deadline.mjs`, for the unit tests that hold it. */
export declare class DeadlineExceeded extends Error {
  what: string;
  ms: number;
}
export declare class PhaseDeadline extends DeadlineExceeded {
  phase: string;
}
export declare const CLEANUP_MS: number;
export declare function withDeadline<T>(
  promise: Promise<T> | T,
  ms: number,
  what: string,
): Promise<T>;
export interface Phases {
  run<T>(name: string, ms: number, work: () => Promise<T> | T): Promise<T>;
  cleanups(): Promise<void>;
  readonly cleanupFailures: { phase: string; message: string }[];
  readonly current: string | null;
  readonly expired: { name: string; ms: number } | null;
  readonly history: { name: string; outcome: string; elapsedMs: number }[];
}
export declare function createPhases(
  label: string,
  options?: {
    onDeadline?: (expired: { name: string; ms: number }) => unknown;
    log?: (line: string) => void;
    now?: () => number;
    cleanupMs?: number;
  },
): Phases;
export declare function phaseFailureCheck(error: unknown): {
  name: string;
  pass: false;
  detail: string;
};
export declare function cleanupChecks(
  phases: Phases,
): Promise<{ name: string; pass: false; detail: string }[]>;
