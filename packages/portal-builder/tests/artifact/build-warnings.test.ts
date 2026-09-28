// A normal build prints no bundler warnings: one printed on every build is one nobody reads, so a
// new one must fail here. The four a consumer build with a Data Browser and the playground can
// produce, and why none does:
//
//   * INEFFECTIVE_DYNAMIC_IMPORT - the playground's lazy terminal import cannot split while the
//     entry imports the Data Browser island (which imports the terminal) statically.
//   * "Some chunks are larger than 500 kB" - that same eager chunk (~570 KB).
//   * `advancedChunks option is deprecated` - the config uses `codeSplitting`.
//   * [EVAL] in jquery.terminal.js - a direct `eval` the portal disables and its CSP refuses;
//     filtered by code and file, nothing broader.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, resolveFixture, tempRoot } from "../helpers/fixture.js";
import { writeConsumerSite } from "../helpers/consumer.js";
import { PACKAGE_ROOT } from "../../src/util/package.js";
import { isKnownInertEval } from "../../src/artifact/index.js";
import { generateEntryModule } from "../../src/artifact/runtime-projection.js";

afterAll(cleanupFixtures);

describe("the one filtered log", () => {
  it("is an EVAL in jQuery Terminal's own source, and nothing else", () => {
    const id = "/repo/node_modules/jquery.terminal/js/jquery.terminal.js";
    expect(isKnownInertEval({ code: "EVAL", id })).toBe(true);
    expect(isKnownInertEval({ code: "EVAL", id: id.replace(/\//g, "\\") })).toBe(true);
    // Another module's eval is a finding, not noise.
    expect(isKnownInertEval({ code: "EVAL", id: "/repo/node_modules/other/index.js" })).toBe(false);
    expect(isKnownInertEval({ code: "EVAL", id: "/repo/client/components/foo.ts" })).toBe(false);
    // Another warning about jQuery Terminal is still printed.
    expect(isKnownInertEval({ code: "CIRCULAR_DEPENDENCY", id })).toBe(false);
  });
});

describe("the Data Browser island", () => {
  it("is a literal dynamic import behind its mount element, not part of the eager entry", async () => {
    const root = writeConsumerSite({ python: true });
    const { model } = await resolveFixture(root);
    const entry = generateEntryModule(model!);
    expect(entry).not.toMatch(/^import .*components\/databrowser\.ts/m);
    expect(entry).toMatch(/import\(".*components\/databrowser\.ts"\)/);
    expect(entry).toContain("document.getElementById(RUNTIME.databrowser.mountId)");
  });
});

describe("a consumer build with the Data Browser, a tree and the playground", () => {
  it("prints no bundler warnings", () => {
    const root = writeConsumerSite({ python: true, s3: true, profile: "xarray-zarr" });
    const out = join(tempRoot("portal-warnings-"), "site");
    const run = spawnSync(
      process.execPath,
      [
        join(PACKAGE_ROOT, "bin", "freva-portal-builder.mjs"),
        "build",
        "--source-root",
        root,
        "--config",
        join(root, "portal.yaml"),
        "--out",
        out,
      ],
      { encoding: "utf8", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
    );
    const text = `${run.stdout}\n${run.stderr}`;
    expect(run.status, text).toBe(0);
    for (const noise of [
      "INEFFECTIVE_DYNAMIC_IMPORT",
      "advancedChunks",
      "larger than 500 kB",
      "[EVAL]",
      "direct `eval`",
    ]) {
      expect(text, `the build printed '${noise}'`).not.toContain(noise);
    }
    // Nothing at warning level from the bundler at all.
    expect(text).not.toMatch(/\[WARN\]|\bWARN\b/);
  }, 600_000);
});
