// Manifest identity is checked structurally, not by pattern-matching text. These are written
// against the *shape* of the failure rather than the spelling of one bad prefix: a build-machine
// path is caught wherever it appears and under whatever root, and an unclassified field fails on
// its own.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite } from "../helpers/site.js";
import { verifyArtifact } from "../../src/verify/verify.js";
import { checkRole } from "../../src/verify/identity.js";
import { DiagnosticBag } from "../../src/diagnostics.js";
import { checkManifestIdentity } from "../../src/verify/identity.js";

afterAll(cleanupFixtures);

function report(name: string, value: unknown): string[] {
  const bag = new DiagnosticBag();
  checkManifestIdentity(name, value, bag);
  return bag.errors.map((d) => d.message);
}

describe("value roles", () => {
  it.each([
    ["sitePath", "/catalog/"],
    ["artifactPath", "catalog/index.html"],
    ["artifactPathPrefix", "assets/portal-stac"],
    ["sourcePath", "content/guide/index.md"],
    ["absoluteUrl", "https://portal.example.org/site/"],
    ["serviceUrl", "/api/freva-nextgen/stac/?visible=a,b"],
    ["origin", "https://api.example.org"],
    ["digest", `sha256:${"a".repeat(64)}`],
    ["purl", "pkg:npm/%40freva-org/portal-builder@0.0.0"],
    ["commit", "ae1956e8cb2067ce27938b3ae70c00515ac0ff33"],
    ["moduleRef", "builder:client/components/stac.ts"],
    ["moduleRef", "pkg:npm/%40freva-org/databrowser@2608.1.0#dist/index.js"],
    ["moduleRef", "unattributed:chunk.js"],
    ["mimeType", "text/html; charset=utf-8"],
    ["timestamp", "2026-08-18T00:00:00Z"],
  ] as const)("accepts a well-formed %s", (role, value) => {
    expect(checkRole(role, value)).toBeUndefined();
  });

  it.each([
    ["sitePath", "catalog/", "does not start with"],
    ["sitePath", "/catalog/../admin/", "'..' segment"],
    ["artifactPath", "/etc/passwd", "is absolute"],
    ["artifactPath", "C:/Windows/system32", "drive letter"],
    ["artifactPath", "a\\b", "backslash"],
    ["sourcePath", "../outside.md", "'..' segment"],
    ["absoluteUrl", "file:///home/build/out", "scheme"],
    ["absoluteUrl", "/site/", "not an absolute URL"],
    ["origin", "https://api.example.org/v1", "bare origin"],
    ["digest", "sha1:abc", "grammar"],
    ["purl", "/home/build/node_modules/x", "grammar"],
    ["moduleRef", "/workspace/src/client/app.ts", "module schemes"],
    ["moduleRef", "builder:/opt/freva/app.ts", "absolute path after its scheme"],
    ["commit", "ae1956e", "grammar"],
  ] as const)("rejects %s value %s", (role, value, fragment) => {
    expect(checkRole(role, value)).toContain(fragment);
  });
});

describe("walking a manifest", () => {
  it("fails a string field that has no declared role", () => {
    const messages = report("portal-manifest.json", { site: { id: "x", nickname: "dev-box" } });
    expect(messages.join("\n")).toContain("has no declared value role");
  });

  it.each([
    "/home/build/portal",
    "/Users/mo/portal",
    "/root/work/portal",
    "/tmp/portal-out",
    "/var/folders/9x/T/portal",
    "/workspace/portal",
    "/opt/actions-runner/_work/portal",
    "/builds/group/project",
    "/mnt/data/portal",
    "C:\\build\\portal",
    "file:///srv/portal",
  ])("catches the build-machine path %s wherever it appears", (path) => {
    // The role check and the host-path sweep are independent, so this asserts the sweep: the
    // value sits in a free-text field no grammar would otherwise reject.
    const messages = report("portal-manifest.json", { site: { title: `built in ${path}` } });
    expect(messages.join("\n")).toContain("contains a build-machine path");
  });

  it("accepts the manifests of a real build unchanged", async () => {
    const root = writeMatrixSite({
      databrowser: true,
      stac: false,
      auth: true,
      canonicalUrl: "https://portal.example.org/site/",
    });
    const out = join(tempRoot("portal-identity-out-"), "site");
    const built = await buildFixture(root, out);
    expect(built.diagnostics.errors).toEqual([]);
    expect(verifyArtifact(out).errors).toEqual([]);
  }, 120_000);

  it("fails verification when a manifest is edited to carry a caller path", async () => {
    const root = writeMatrixSite({
      databrowser: false,
      stac: false,
      auth: false,
      canonicalUrl: "https://portal.example.org/site/",
    });
    const out = join(tempRoot("portal-identity-tamper-"), "site");
    expect((await buildFixture(root, out)).diagnostics.errors).toEqual([]);

    const file = join(out, "component-evidence.json");
    const evidence = JSON.parse(readFileSync(file, "utf8")) as {
      graph: { modules: string[] };
    };
    evidence.graph.modules.push("/opt/hostedtoolcache/node/24.13.0/lib/app.js");
    writeFileSync(file, JSON.stringify(evidence, null, 2));

    const messages = verifyArtifact(out)
      .errors.map((d) => d.message)
      .join("\n");
    expect(messages).toContain("module schemes");
  }, 120_000);
});
