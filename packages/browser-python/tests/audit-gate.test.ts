import { describe, expect, it } from "vitest";
import { advisories, evaluate } from "../../../scripts/audit-gate.mjs";

const via = (id: string, severity: string, title = id) => ({
  source: 1,
  url: `https://github.com/advisories/${id}`,
  severity,
  title,
});
const report = {
  vulnerabilities: {
    lodash: { via: [via("GHSA-aaaa-bbbb-cccc", "high"), via("GHSA-dddd-eeee-ffff", "moderate")] },
    "lodash-consumer": { via: ["lodash"] },
    tinypool: { via: [via("GHSA-gggg-hhhh-iiii", "critical")] },
    other: { via: [via("GHSA-aaaa-bbbb-cccc", "high")] },
  },
};
const TODAY = "2026-10-29";

describe("the npm audit gate", () => {
  it("collects high and critical advisories once each, with every package they reach", () => {
    expect(advisories(report)).toEqual([
      {
        id: "GHSA-aaaa-bbbb-cccc",
        severity: "high",
        title: "GHSA-aaaa-bbbb-cccc",
        packages: ["lodash", "other"],
      },
      {
        id: "GHSA-gggg-hhhh-iiii",
        severity: "critical",
        title: "GHSA-gggg-hhhh-iiii",
        packages: ["tinypool"],
      },
    ]);
  });

  it("blocks every high or critical advisory with an empty allow-list", () => {
    const { blocking, problems } = evaluate(report, [], TODAY);
    expect(blocking.map((a) => a.id)).toEqual(["GHSA-aaaa-bbbb-cccc", "GHSA-gggg-hhhh-iiii"]);
    expect(problems).toEqual([]);
  });

  it("accepts an allow-listed advisory until it expires", () => {
    const allowlist = [
      { advisory: "GHSA-aaaa-bbbb-cccc", reason: "dev only", expires: "2026-11-30" },
    ];
    const { blocking, accepted } = evaluate(report, allowlist, TODAY);
    expect(accepted.map((a) => a.id)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
    expect(blocking.map((a) => a.id)).toEqual(["GHSA-gggg-hhhh-iiii"]);
  });

  it("fails on an expired entry and blocks its advisory again", () => {
    const allowlist = [
      { advisory: "GHSA-aaaa-bbbb-cccc", reason: "dev only", expires: "2026-10-28" },
    ];
    const { blocking, problems } = evaluate(report, allowlist, TODAY);
    expect(problems.join("\n")).toMatch(/expired on 2026-10-28/);
    expect(blocking.map((a) => a.id)).toContain("GHSA-aaaa-bbbb-cccc");
  });

  it("refuses an entry without a reason or a valid expiry", () => {
    for (const entry of [
      { advisory: "GHSA-aaaa-bbbb-cccc", expires: "2026-11-30" },
      { advisory: "GHSA-aaaa-bbbb-cccc", reason: "x" },
      { advisory: "GHSA-aaaa-bbbb-cccc", reason: "x", expires: "next year" },
    ]) {
      expect(evaluate(report, [entry], TODAY).problems).toHaveLength(1);
    }
  });
});
