// `static-docs-v1` trusted subsites.

import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  mkdir,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";

afterAll(cleanupFixtures);

const POLICY = `{
  "schemaVersion": 1,
  "profile": "static-docs-v1",
  "entryPoints": ["index.html"],
  "runtime": { "connectOrigins": [], "frameOrigins": [], "workers": "none" }
}
`;

const SUBSITE = `trustedSubsites:
  - profile: static-docs-v1
    source: ./reference-docs
    mount: /reference/
    trust: active
    policy: ./policies/reference.json
`;

function withSubsite(root: string, files: Record<string, string>, policy = POLICY): void {
  write(root, "policies/reference.json", policy);
  for (const [path, body] of Object.entries(files)) write(root, path, body);
  writeSite(root, { extra: SUBSITE });
}

describe("trusted documentation subsites", () => {
  it("accepts a declared, contained, policy-conforming tree", async () => {
    const root = tempRoot();
    withSubsite(root, {
      "reference-docs/index.html": `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Docs</h1><script src="app.js"></script><script>window.x = 1;</script></body></html>`,
      "reference-docs/style.css": "body { margin: 0 }",
      "reference-docs/app.js": "console.log('docs');",
    });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    const subsite = result.model!.trustedSubsiteMounts[0]!;
    expect(subsite.mount).toBe("/reference/");
    expect(subsite.treeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(subsite.policyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(subsite.inlineScriptHashes).toHaveLength(1);
    expect([...subsite.staticResources].sort()).toEqual(["app.js", "style.css"]);
  });

  it("refuses a missing declared entry point", async () => {
    const root = tempRoot();
    withSubsite(root, {
      "reference-docs/other.html": "<!doctype html><html><body>x</body></html>",
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1404");
  });

  it("refuses an external static resource while permitting a hyperlink", async () => {
    const root = tempRoot();
    withSubsite(root, {
      "reference-docs/index.html": `<!doctype html><html><body><a href="https://example.org/">out</a><script src="https://cdn.example.org/x.js"></script></body></html>`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1405");
    expect(result.diagnostics.errors.filter((d) => d.code === "FP1405")).toHaveLength(1);
  });

  it("refuses a literal inline event handler and a javascript: URL", async () => {
    const root = tempRoot();
    withSubsite(root, {
      "reference-docs/index.html": `<!doctype html><html><body><button onclick="x()">go</button><a href="javascript:void(0)">no</a></body></html>`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics).filter((c) => c === "FP1406").length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("refuses a policy with a wildcard origin", async () => {
    const root = tempRoot();
    withSubsite(
      root,
      { "reference-docs/index.html": "<!doctype html><html><body>x</body></html>" },
      `{
  "schemaVersion": 1,
  "profile": "static-docs-v1",
  "entryPoints": ["index.html"],
  "runtime": { "connectOrigins": ["https://*.example.org"], "frameOrigins": [], "workers": "none" }
}
`,
    );
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1104");
  });

  it.each([
    ["a raw CSP", `"csp": "default-src *"`],
    ["a script origin", `"scriptOrigins": ["https://cdn.example.org"]`],
    ["unsafe-inline", `"unsafeInline": true`],
  ])("refuses a policy carrying %s", async (_name, snippet) => {
    const root = tempRoot();
    withSubsite(
      root,
      { "reference-docs/index.html": "<!doctype html><html><body>x</body></html>" },
      `{
  "schemaVersion": 1,
  "profile": "static-docs-v1",
  "entryPoints": ["index.html"],
  ${snippet},
  "runtime": { "connectOrigins": [], "frameOrigins": [], "workers": "none" }
}
`,
    );
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1104");
  });

  it("refuses a consumer-defined capability profile", async () => {
    const root = tempRoot();
    write(root, "policies/reference.json", POLICY);
    write(root, "reference-docs/index.html", "<!doctype html><html><body>x</body></html>");
    writeSite(root, { extra: SUBSITE.replace("static-docs-v1", "my-own-profile") });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1104");
  });

  it("refuses an empty subsite rather than running a command to create it", async () => {
    const root = tempRoot();
    write(root, "policies/reference.json", POLICY);
    mkdir(root, "reference-docs");
    writeSite(root, { extra: SUBSITE });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1403");
  });

  it("does not publish the policy document itself", async () => {
    const root = tempRoot();
    withSubsite(root, {
      "reference-docs/index.html": "<!doctype html><html><body>x</body></html>",
    });
    const result = await resolveFixture(root);
    expect([...result.contents.keys()].some((f) => f.includes("reference.json"))).toBe(false);
    expect(result.model!.inputs.some((i) => i.role === "subsite-policy")).toBe(true);
  });
});
