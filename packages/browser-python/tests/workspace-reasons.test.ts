/**
 * Which workspace-absence reason is RIGHT depends on what the browser has - never on its name.
 *
 * Playwright WebKit has no OPFS at all, so a worker whose sync access handles a test seam removed
 * still reports `no-opfs`: the first missing prerequisite. Firefox has OPFS, so the same seam
 * yields `no-sync-access-handles`. An independent probe worker decides which; both branches are held
 * here, and so is the refusal of any reason the probe does not support.
 */
import { describe, expect, it } from "vitest";
import {
  detailMatchesReason,
  expectedReasonWithoutSyncHandles,
  workspaceAbsenceConsistent,
} from "../browser-tests/workspace-reasons.mjs";

// The exact sentences `Workspace.open` reports (src/worker/opfs-workspace.ts).
const NO_OPFS =
  "This browser does not provide an origin private filesystem, so Python file output cannot be " +
  "written to disk. Files still work, but they live in memory.";
const NO_SYNC =
  "This browser has no synchronous file access handles, which are what let Python write to disk " +
  "without buffering the whole file in memory.";

/** What the probe worker reports in each engine, before any seam. */
const FIREFOX = { opfs: true, syncAccessHandles: true, opfsUsable: true };
const WEBKIT = { opfs: false, syncAccessHandles: false, opfsUsable: false };

describe("the seam that removes sync access handles", () => {
  it("must yield no-sync-access-handles where OPFS exists (Firefox, Chromium)", () => {
    expect(expectedReasonWithoutSyncHandles(FIREFOX)).toBe("no-sync-access-handles");
  });

  it("must yield no-opfs where there is no OPFS at all (Playwright WebKit)", () => {
    expect(expectedReasonWithoutSyncHandles(WEBKIT)).toBe("no-opfs");
  });

  it("and each reason must carry its own sentence, not the other one's", () => {
    expect(detailMatchesReason({ reason: "no-opfs", detail: NO_OPFS })).toBe(true);
    expect(detailMatchesReason({ reason: "no-sync-access-handles", detail: NO_SYNC })).toBe(true);
    expect(detailMatchesReason({ reason: "no-opfs", detail: NO_SYNC })).toBe(false);
    expect(detailMatchesReason({ reason: "no-sync-access-handles", detail: NO_OPFS })).toBe(false);
  });

  it("the worker source still says exactly what these patterns expect", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../src/worker/opfs-workspace.ts", import.meta.url),
      "utf8",
    ).replace(/"\s*\+\s*"/g, "");
    expect(source).toContain(NO_OPFS);
    expect(source).toContain(NO_SYNC);
  });
});

describe("an unavailable workspace must match what an independent probe found", () => {
  it("accepts WebKit's no-opfs where the probe has no getDirectory()", () => {
    expect(
      workspaceAbsenceConsistent({ available: false, reason: "no-opfs", detail: NO_OPFS }, WEBKIT),
    ).toEqual({ ok: true });
  });

  it("refuses no-sync-access-handles where OPFS itself is missing", () => {
    expect(
      workspaceAbsenceConsistent(
        { available: false, reason: "no-sync-access-handles", detail: NO_SYNC },
        WEBKIT,
      ),
    ).toMatchObject({ ok: false, why: expect.stringMatching(/OPFS itself is missing/) });
  });

  it("refuses no-opfs where the probe HAS OPFS", () => {
    expect(
      workspaceAbsenceConsistent({ available: false, reason: "no-opfs", detail: NO_OPFS }, FIREFOX),
    ).toMatchObject({ ok: false });
  });

  it("accepts no-sync-access-handles only where OPFS exists without them", () => {
    const opfsWithoutSync = { opfs: true, syncAccessHandles: false, opfsUsable: false };
    expect(
      workspaceAbsenceConsistent(
        { available: false, reason: "no-sync-access-handles", detail: NO_SYNC },
        opfsWithoutSync,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses open-failed where an independent worker used OPFS - that is the package failing", () => {
    expect(
      workspaceAbsenceConsistent(
        {
          available: false,
          reason: "open-failed",
          detail: "the storage was refused for some reason",
        },
        FIREFOX,
      ),
    ).toMatchObject({ ok: false, why: expect.stringMatching(/independent worker used OPFS/) });
  });

  it("refuses an arbitrary reason, a mismatched sentence, and an AVAILABLE workspace", () => {
    expect(
      workspaceAbsenceConsistent({ available: false, reason: "whatever", detail: NO_OPFS }, WEBKIT),
    ).toMatchObject({ ok: false, why: expect.stringMatching(/unknown reason/) });
    expect(
      workspaceAbsenceConsistent({ available: false, reason: "no-opfs", detail: NO_SYNC }, WEBKIT),
    ).toMatchObject({ ok: false, why: expect.stringMatching(/detail/) });
    expect(workspaceAbsenceConsistent({ available: true }, WEBKIT)).toMatchObject({ ok: false });
  });
});
