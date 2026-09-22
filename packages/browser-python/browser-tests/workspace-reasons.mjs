/**
 * WHY a workspace is unavailable, checked against what the browser actually has.
 *
 * `ready.workspace.reason` names the FIRST missing prerequisite: `no-opfs` when there is no origin
 * private filesystem at all, `no-sync-access-handles` when there is one but a worker cannot hold a
 * synchronous handle, `open-failed` when both exist and opening still failed. WebKit in Playwright
 * has no OPFS, so it reports `no-opfs` - even for a worker whose sync handles a test seam removed,
 * because the prerequisite before them is already absent. These helpers decide, from an
 * INDEPENDENT probe worker in the same context, which reason is the right one, and never accept an
 * arbitrary one. Pure: no browser, so the unit tests hold both branches.
 */

export const WORKSPACE_CAPABILITY_REASONS = Object.freeze(["no-opfs", "no-sync-access-handles"]);

/** What each reason's `detail` sentence must say - see `Workspace.open` in opfs-workspace.ts. */
export const WORKSPACE_REASON_DETAIL = Object.freeze({
  "no-opfs": /origin private filesystem/,
  "no-sync-access-handles": /synchronous file access handles/,
});

/**
 * The reason a worker whose `createSyncAccessHandle` was REMOVED must report, given what an
 * unmodified probe worker found: `no-sync-access-handles` where OPFS exists (Firefox, Chromium),
 * `no-opfs` where it does not (Playwright WebKit).
 */
export function expectedReasonWithoutSyncHandles(nativeProbe) {
  return nativeProbe?.opfs === true ? "no-sync-access-handles" : "no-opfs";
}

/** Whether `status.detail` is the sentence that belongs to `status.reason`. */
export function detailMatchesReason(status) {
  const pattern = WORKSPACE_REASON_DETAIL[status?.reason];
  if (!pattern) return typeof status?.detail === "string" && status.detail.length > 20;
  return typeof status?.detail === "string" && pattern.test(status.detail);
}

/**
 * Is an UNAVAILABLE workspace the browser's answer, as an independent probe in the same context
 * sees it? `{ ok: true }` or `{ ok: false, why }`. The reason must be the first missing
 * prerequisite the probe found, and its detail must describe that reason.
 */
export function workspaceAbsenceConsistent(status, probe) {
  if (status?.available !== false)
    return { ok: false, why: "the workspace was reported available" };
  switch (status.reason) {
    case "no-opfs":
      if (probe?.opfs !== false) {
        return { ok: false, why: "no-opfs was reported, but a worker here has getDirectory()" };
      }
      break;
    case "no-sync-access-handles":
      if (probe?.opfs !== true) {
        return {
          ok: false,
          why: "no-sync-access-handles was reported where OPFS itself is missing (no-opfs)",
        };
      }
      if (probe?.syncAccessHandles !== false) {
        return {
          ok: false,
          why: "no-sync-access-handles was reported, but a worker here has createSyncAccessHandle",
        };
      }
      break;
    case "open-failed":
      if (probe?.opfsUsable !== false) {
        return { ok: false, why: "open-failed was reported where an independent worker used OPFS" };
      }
      break;
    default:
      return { ok: false, why: `an unknown reason ${JSON.stringify(status.reason)}` };
  }
  if (!detailMatchesReason(status)) {
    return { ok: false, why: `the detail does not describe ${status.reason}` };
  }
  return { ok: true };
}
