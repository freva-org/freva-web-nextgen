/** Types for `workspace-reasons.mjs`, for the unit tests that hold it. */
export interface WorkerProbe {
  opfs?: boolean;
  syncAccessHandles?: boolean;
  opfsUsable?: boolean;
}
export interface WorkspaceStatusLike {
  available?: boolean;
  reason?: string;
  detail?: string;
}
export declare const WORKSPACE_CAPABILITY_REASONS: readonly string[];
export declare const WORKSPACE_REASON_DETAIL: Readonly<Record<string, RegExp>>;
export declare function expectedReasonWithoutSyncHandles(nativeProbe: WorkerProbe | null): string;
export declare function detailMatchesReason(status: WorkspaceStatusLike | null): boolean;
export declare function workspaceAbsenceConsistent(
  status: WorkspaceStatusLike | null,
  probe: WorkerProbe | null,
): { ok: true } | { ok: false; why: string };
