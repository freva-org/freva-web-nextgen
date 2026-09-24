// Provenance references, PR previews and environment artifacts.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, REPO_ROOT, tempRoot } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite } from "../helpers/site.js";
import { validateAgainst } from "../../src/config/schema.js";
import { sha256 } from "../../src/util/package.js";

afterAll(cleanupFixtures);

const IMAGE = {
  kind: "image",
  reference: "ghcr.io/freva-org/portal-builder:1.0.0",
  indexDigest: `sha256:${"1".repeat(64)}`,
  manifestDigest: `sha256:${"2".repeat(64)}`,
  configDigest: `sha256:${"3".repeat(64)}`,
  platform: { os: "linux", architecture: "amd64" },
};

describe("structured material references", () => {
  it("accepts a source, a package and an image reference", () => {
    expect(
      validateAgainst("materialReference", { kind: "source", path: "portal.yaml" }, "x").valid,
    ).toBe(true);
    expect(
      validateAgainst(
        "materialReference",
        {
          kind: "package",
          purl: "pkg:npm/%40freva-org/portal-builder@1.0.0",
          path: "dist/index.js",
        },
        "x",
      ).valid,
    ).toBe(true);
    expect(validateAgainst("materialReference", IMAGE, "x").valid).toBe(true);
  });

  it("refuses an absolute path as a source reference", () => {
    expect(
      validateAgainst("materialReference", { kind: "source", path: "/home/me/portal.yaml" }, "x")
        .valid,
    ).toBe(false);
  });

  it("distinguishes two platform resolutions of one index digest", () => {
    const arm = {
      ...IMAGE,
      manifestDigest: `sha256:${"4".repeat(64)}`,
      configDigest: `sha256:${"5".repeat(64)}`,
      platform: { os: "linux", architecture: "arm64", variant: "v8" },
    };
    expect(validateAgainst("materialReference", arm, "x").valid).toBe(true);
    expect(arm.indexDigest).toBe(IMAGE.indexDigest);
    expect(sha256(JSON.stringify(arm))).not.toBe(sha256(JSON.stringify(IMAGE)));
  });

  it("records the resolved image identity in the artifact", () => {
    const source = writeMatrixSite({ databrowser: false, stac: false, auth: false });
    const out = join(tempRoot("portal-oci-"), "site");
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, "packages", "portal-builder", "bin", "freva-portal-builder.mjs"),
        "build",
        "--source-root",
        source,
        "--config",
        join(source, "portal.yaml"),
        "--out",
        out,
        "--quiet",
        "--builder-image",
        JSON.stringify(IMAGE),
      ],
      { encoding: "utf8", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
    );
    const buildinfo = JSON.parse(readFileSync(join(out, "BUILDINFO.json"), "utf8")) as {
      builder: { image: typeof IMAGE };
    };
    expect(buildinfo.builder.image.manifestDigest).toBe(IMAGE.manifestDigest);
    expect(buildinfo.builder.image.configDigest).toBe(IMAGE.configDigest);
    expect(buildinfo.builder.image.platform).toEqual({ os: "linux", architecture: "amd64" });
  }, 120_000);

  it("refuses a builder image reference that omits its platform resolution", () => {
    const source = writeMatrixSite({ databrowser: false, stac: false, auth: false });
    const out = join(tempRoot("portal-oci-bad-"), "site");
    expect(() =>
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, "packages", "portal-builder", "bin", "freva-portal-builder.mjs"),
          "build",
          "--source-root",
          source,
          "--config",
          join(source, "portal.yaml"),
          "--out",
          out,
          "--quiet",
          "--builder-image",
          JSON.stringify({ reference: "x", indexDigest: IMAGE.indexDigest }),
        ],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow();
  }, 60_000);
});

describe("environment artifacts and previews", () => {
  it("gives two environments with different public inputs different artifacts", async () => {
    const production = writeMatrixSite({
      databrowser: true,
      stac: false,
      auth: false,
      canonicalUrl: "https://portal.example.org/",
    });
    const preview = writeMatrixSite({
      databrowser: true,
      stac: false,
      auth: false,
      canonicalUrl: "https://preview-42.example.org/",
    });
    const outA = join(tempRoot("portal-prod-"), "site");
    const outB = join(tempRoot("portal-preview-"), "site");
    expect((await buildFixture(production, outA)).diagnostics.errors).toEqual([]);
    expect((await buildFixture(preview, outB)).diagnostics.errors).toEqual([]);

    const digestOf = (dir: string): string => sha256(readFileSync(join(dir, "checksums.sha256")));
    expect(digestOf(outA)).not.toBe(digestOf(outB));

    // The preview is a complete, schema-valid build with its own assigned URL, not a
    // production artifact with a URL patched into it afterwards.
    const previewManifest = JSON.parse(
      readFileSync(join(outB, "portal-manifest.json"), "utf8"),
    ) as {
      site: { canonicalUrl: string };
      routes: { url: string }[];
    };
    expect(previewManifest.site.canonicalUrl).toBe("https://preview-42.example.org/");
    for (const route of previewManifest.routes) {
      expect(route.url.startsWith("https://preview-42.example.org/")).toBe(true);
    }
    const productionText = readFileSync(join(outA, "index.html"), "utf8");
    expect(productionText).not.toContain("preview-42");
  }, 240_000);

  it("keeps identical inputs at one digest, so promotion is a property rather than a rule", async () => {
    const source = writeMatrixSite({ databrowser: true, stac: false, auth: false });
    const first = join(tempRoot("portal-stage-a-"), "site");
    const second = join(tempRoot("portal-stage-b-"), "site");
    await buildFixture(source, first);
    await buildFixture(source, second);
    expect(sha256(readFileSync(join(first, "checksums.sha256")))).toBe(
      sha256(readFileSync(join(second, "checksums.sha256"))),
    );
  }, 240_000);
});
