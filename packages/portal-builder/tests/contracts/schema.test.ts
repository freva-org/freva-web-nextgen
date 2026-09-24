// The closed configuration contract: what the schema *refuses*. An unknown key that quietly
// validated would be an extension point nobody designed, and a YAML anchor that quietly
// expanded would let one reviewed document produce a different one.

import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";

afterAll(cleanupFixtures);

describe("portal.yaml schema", () => {
  it("accepts a minimal valid site", async () => {
    const root = tempRoot();
    writeSite(root);
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.model?.site.id).toBe("test-site");
    expect(result.model?.routes.map((r) => r.path)).toContain("/");
  });

  it("rejects an unknown property at a portal-owned object level", async () => {
    const root = tempRoot();
    writeSite(root, { extra: "unknownTopLevel: true\n" });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1104");
    expect(result.diagnostics.errors[0]?.message).toMatch(/Unknown property 'unknownTopLevel'/);
    expect(result.diagnostics.errors[0]?.pointer).toBe("/");
  });

  it("rejects a wrong scalar type with a pointer and a line", async () => {
    const root = tempRoot();
    writeSite(root);
    write(
      root,
      "portal.yaml",
      `schemaVersion: 1
site:
  id: test-site
  title: 42
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
`,
    );
    const result = await resolveFixture(root);
    const error = result.diagnostics.errors.find((d) => d.pointer === "/site/title");
    expect(error).toBeDefined();
    expect(error?.position?.line).toBe(4);
  });

  it("rejects an unsupported schemaVersion", async () => {
    const root = tempRoot();
    writeSite(root);
    write(root, "portal.yaml", `schemaVersion: 2\nsite:\n  id: x\n`);
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1104");
  });

  it("reports a duplicate YAML key rather than taking the last one", async () => {
    const root = tempRoot();
    writeSite(root);
    write(
      root,
      "portal.yaml",
      `schemaVersion: 1
site:
  id: one
  id: two
`,
    );
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1103");
  });

  it.each([
    ["anchors and aliases", "base: &a\n  x: 1\nother: *a\n"],
    ["merge keys", "base:\n  x: 1\nother:\n  <<: {y: 2}\n"],
    ["custom tags", "value: !!python/object x\n"],
  ])("rejects %s", async (_name, snippet) => {
    const root = tempRoot();
    writeSite(root);
    write(root, "portal.yaml", `schemaVersion: 1\n${snippet}`);
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics).some((c) => c === "FP1102" || c === "FP1101")).toBe(true);
  });

  it("uses YAML 1.2 core scalar semantics, so 'yes' stays a string", async () => {
    const root = tempRoot();
    writeSite(root, { extra: "" });
    write(
      root,
      "portal.yaml",
      `schemaVersion: 1
site:
  id: test-site
  title: yes
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
`,
    );
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.model?.site.title).toBe("yes");
  });

  it("rejects environment-variable interpolation as an ordinary unknown value", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `services:
  dataApi:
    kind: databrowser
    baseUrl: \${DATA_API}
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1205");
  });

  it("rejects a theme preset that is not registered", async () => {
    const root = tempRoot();
    writeSite(root, { theme: "not-a-preset" });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics).some((c) => c === "FP1104" || c === "FP1201")).toBe(true);
  });
});
