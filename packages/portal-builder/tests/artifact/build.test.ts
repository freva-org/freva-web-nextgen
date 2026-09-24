// The artifact contract. Reproducibility and hermeticity are asserted the only way that means
// anything: two clean builds compared byte for byte, and a build run in a process where the
// network genuinely does not work.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtures, REPO_ROOT, tempRoot } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite, STAC_MATERIALS } from "../helpers/site.js";
import { verifyArtifact } from "../../src/verify/verify.js";
import { sha256 } from "../../src/util/package.js";

afterAll(cleanupFixtures);

function fileDigests(root: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, fileDigests(root, rel));
    else if (entry.isFile()) out[rel] = sha256(readFileSync(join(root, ...rel.split("/"))));
  }
  return out;
}

describe("a built artifact", () => {
  let out: string;
  let source: string;

  beforeAll(async () => {
    source = writeMatrixSite({
      databrowser: true,
      stac: false,
      auth: true,
      canonicalUrl: "https://portal.example.org/site/",
    });
    out = join(tempRoot("portal-artifact-"), "site");
    const result = await buildFixture(source, out);
    expect(result.diagnostics.errors).toEqual([]);
  }, 120_000);

  it("mounts the document root at the canonical URL's pathname, once", () => {
    expect(existsSync(join(out, "index.html"))).toBe(true);
    expect(existsSync(join(out, "site"))).toBe(false);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain('href="/site/data/"');
    expect(html).not.toContain("/site/site/");
    expect(html).toContain('<link rel="canonical" href="https://portal.example.org/site/">');
  });

  it("emits every required manifest", () => {
    for (const name of [
      "portal-manifest.json",
      "input-manifest.json",
      "component-evidence.json",
      "host-policy.json",
      "BUILDINFO.json",
      "checksums.sha256",
      "404.html",
    ]) {
      expect(existsSync(join(out, name))).toBe(true);
    }
  });

  it("hashes every actual input, including a dirty untracked one", () => {
    const manifest = JSON.parse(readFileSync(join(out, "input-manifest.json"), "utf8")) as {
      sources: { ref: { kind: string; path: string }; role: string; digest: string }[];
      profile: { name: string; digest: string };
      schemas: Record<string, { digest: string }>;
      reproducibility: { sourceDateEpoch: number };
    };
    const paths = manifest.sources.map((s) => s.ref.path);
    expect(paths).toContain("portal.yaml");
    expect(paths).toContain("landings/home.yaml");
    expect(paths).toContain("content/guide.md");
    expect(paths).toContain("assets/logo.svg");
    for (const source of manifest.sources) {
      expect(source.ref.kind).toBe("source");
      expect(source.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(manifest.profile.name).toBe("portal-content-v1");
    expect(manifest.profile.digest).toMatch(/^sha256:/);
    expect(manifest.reproducibility.sourceDateEpoch).toBe(1_760_000_000);
  });

  it("records the complete input-manifest digest in BUILDINFO", () => {
    const buildinfo = JSON.parse(readFileSync(join(out, "BUILDINFO.json"), "utf8")) as {
      inputManifestDigest: string;
    };
    expect(buildinfo.inputManifestDigest).toBe(
      sha256(readFileSync(join(out, "input-manifest.json"))),
    );
  });

  it("contains no caller-specific absolute or temporary path in any manifest", () => {
    for (const name of [
      "portal-manifest.json",
      "input-manifest.json",
      "component-evidence.json",
      "host-policy.json",
      "BUILDINFO.json",
    ]) {
      const text = readFileSync(join(out, name), "utf8");
      expect(text).not.toMatch(/"\/(home|Users|tmp|var\/folders|root)\//);
      expect(text).not.toContain(REPO_ROOT);
    }
  });

  it("gives every artifact file a MIME type and a cache class", () => {
    const manifest = JSON.parse(readFileSync(join(out, "portal-manifest.json"), "utf8")) as {
      files: { path: string; mimeType: string; cacheClass: string }[];
    };
    for (const file of manifest.files) {
      expect(file.mimeType).toBeTruthy();
      expect(["immutable", "revalidate", "download", "subsite", "no-store"]).toContain(
        file.cacheClass,
      );
    }
    // Stable, unhashed project names never receive immutable caching.
    const identity = manifest.files.find((f) => f.path.startsWith("identity/"));
    expect(identity?.cacheClass).toBe("revalidate");
  });

  it("covers every file except itself in checksums.sha256", () => {
    const digests = fileDigests(out);
    const lines = readFileSync(join(out, "checksums.sha256"), "utf8").trim().split("\n");
    const recorded = new Map(
      lines.map((l) => [l.split("  ").slice(1).join("  "), l.split("  ")[0]!]),
    );
    expect(recorded.has("checksums.sha256")).toBe(false);
    for (const [path, digest] of Object.entries(digests)) {
      if (path === "checksums.sha256") continue;
      expect(recorded.get(path)).toBe(digest.replace("sha256:", ""));
    }
    // Normalized lexical order.
    const paths = lines.map((l) => l.split("  ").slice(1).join("  "));
    expect(paths).toEqual([...paths].sort());
  });

  it("passes its own verification", () => {
    const bag = verifyArtifact(out);
    expect(bag.errors).toEqual([]);
  });

  it("fails verification when a byte changes", () => {
    const target = join(out, "index.html");
    const original = readFileSync(target);
    writeFileSync(target, `${original.toString("utf8")}<!-- tampered -->`);
    const bag = verifyArtifact(out);
    expect(bag.errors.map((d) => d.code)).toContain("FP1603");
    writeFileSync(target, original);
    expect(verifyArtifact(out).errors).toEqual([]);
  });
});

describe("reproducibility", () => {
  it("produces byte-identical output from two clean builds", async () => {
    const source = writeMatrixSite({ databrowser: true, stac: false, auth: true });
    const first = join(tempRoot("portal-repro-a-"), "site");
    const second = join(tempRoot("portal-repro-b-"), "site");
    expect((await buildFixture(source, first)).diagnostics.errors).toEqual([]);
    expect((await buildFixture(source, second)).diagnostics.errors).toEqual([]);
    expect(fileDigests(second)).toEqual(fileDigests(first));
  }, 240_000);
});

describe("hermetic builds", () => {
  // A build needs no network, including one that embeds STAC. The materials are handed to it on
  // the command line, which is the whole contract: preparation is a separate, network-enabled
  // stage, and the build consuming its output reaches for nothing. With no prepared materials
  // there is nothing to embed and nothing to prove, so the test skips.
  it.skipIf(!STAC_MATERIALS)(
    "completes with the network genuinely denied",
    () => {
      const source = writeMatrixSite({ databrowser: true, stac: true, auth: true });
      const out = join(tempRoot("portal-offline-"), "site");
      const deny = join(
        REPO_ROOT,
        "packages",
        "portal-builder",
        "tests",
        "helpers",
        "deny-network.cjs",
      );
      const bin = join(REPO_ROOT, "packages", "portal-builder", "bin", "freva-portal-builder.mjs");

      const output = execFileSync(
        process.execPath,
        [
          bin,
          "build",
          "--source-root",
          source,
          "--config",
          join(source, "portal.yaml"),
          "--out",
          out,
          "--stac-materials",
          STAC_MATERIALS!,
          "--quiet",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_OPTIONS: `--require ${deny}`,
            SOURCE_DATE_EPOCH: "1760000000",
          },
        },
      );

      expect(output).toContain("built:");
      expect(existsSync(join(out, "index.html"))).toBe(true);
      expect(existsSync(join(out, "stac"))).toBe(true);
      expect(verifyArtifact(out).errors).toEqual([]);
    },
    240_000,
  );
});
