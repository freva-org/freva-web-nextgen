// Dated announcements. A *build* decides whether an announcement exists, from a recorded
// instant, and a browser clock never does - so crossing a boundary requires a new artifact,
// which is inconvenient exactly once and correct every time.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";

afterAll(cleanupFixtures);

const DATED = `announcements:
  - id: window
    message: Maintenance window.
    level: warning
    startsAt: "2026-01-05T08:00:00Z"
    endsAt: "2026-01-09T18:00:00Z"
`;

describe("announcement selection", () => {
  it("requires --effective-at for a release build when a dated announcement exists", async () => {
    const root = tempRoot();
    writeSite(root, { extra: DATED });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1301");
  });

  it("includes an announcement at its inclusive start", async () => {
    const root = tempRoot();
    writeSite(root, { extra: DATED });
    const result = await resolveFixture(root, { effectiveAt: "2026-01-05T08:00:00Z" });
    expect(result.model?.announcements.map((a) => a.id)).toEqual(["window"]);
  });

  it("excludes an announcement at its exclusive end", async () => {
    const root = tempRoot();
    writeSite(root, { extra: DATED });
    const result = await resolveFixture(root, { effectiveAt: "2026-01-09T18:00:00Z" });
    expect(result.model?.announcements).toEqual([]);
  });

  it("excludes an announcement before it starts", async () => {
    const root = tempRoot();
    writeSite(root, { extra: DATED });
    const result = await resolveFixture(root, { effectiveAt: "2026-01-05T07:59:59Z" });
    expect(result.model?.announcements).toEqual([]);
  });

  it("rejects an inverted interval", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `announcements:
  - id: bad
    message: Nope.
    level: info
    startsAt: "2026-02-01T00:00:00Z"
    endsAt: "2026-01-01T00:00:00Z"
`,
    });
    const result = await resolveFixture(root, { effectiveAt: "2026-01-15T00:00:00Z" });
    expect(codes(result.diagnostics)).toContain("FP1302");
  });

  it("rejects duplicate announcement ids", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `announcements:
  - id: same
    message: One.
    level: info
  - id: same
    message: Two.
    level: info
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1303");
  });

  it("rejects an unused --effective-at, so the flag cannot become decoration", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `announcements:
  - id: always
    message: Always on.
    level: info
`,
    });
    const result = await resolveFixture(root, { effectiveAt: "2026-01-15T00:00:00Z" });
    expect(codes(result.diagnostics)).toContain("FP1304");
  });

  it("keeps SOURCE_DATE_EPOCH separate from the effective instant", async () => {
    const root = tempRoot();
    writeSite(root, { extra: DATED });
    const result = await resolveFixture(root, {
      effectiveAt: "2026-01-07T00:00:00Z",
      sourceDateEpoch: 1_700_000_000,
    });
    expect(result.model?.announcements.map((a) => a.id)).toEqual(["window"]);
    expect(result.model?.buildIdentity.sourceDateEpoch).toBe(1_700_000_000);
    expect(result.model?.buildIdentity.effectiveAt).toBe("2026-01-07T00:00:00Z");
  });

  it("lets dev use the wall clock and marks the preview non-release", async () => {
    const root = tempRoot();
    writeSite(root, { extra: DATED });
    const result = await resolveFixture(root, { dev: true, release: false });
    expect(codes(result.diagnostics)).not.toContain("FP1301");
    expect(result.model?.buildIdentity.release).toBe(false);
  });
});
