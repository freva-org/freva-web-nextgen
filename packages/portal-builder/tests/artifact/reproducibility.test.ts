// The release reproducibility contract. Two builds being equal is necessary and not sufficient:
// a build that *cannot* be reproducible has to say so. An emitting release build with no
// recorded timestamp must fail rather than fall back to epoch 0 and stamp the artifact 1970.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  REPO_ROOT,
  resolveFixture,
  tempRoot,
  writeSite,
} from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite } from "../helpers/site.js";
import { buildCanonicalArchive, recordedEpoch } from "../../src/artifact/archive.js";
import { buildSite } from "../../src/artifact/index.js";
import { canonicalizeRoot } from "../../src/config/paths.js";

afterAll(cleanupFixtures);

const BIN = join(REPO_ROOT, "packages", "portal-builder", "bin", "freva-portal-builder.mjs");

describe("the release timestamp", () => {
  it("fails an emitting release build that has no epoch", async () => {
    const root = tempRoot();
    writeSite(root);
    const out = join(tempRoot("portal-epoch-"), "site");
    const result = await buildSite({
      sourceRoot: canonicalizeRoot(root),
      configPath: join(root, "portal.yaml"),
      outDir: out,
      release: true,
      quiet: true,
      // No sourceDateEpoch. This must fail rather than substitute zero.
    });
    expect(codes(result.diagnostics)).toContain("FP1801");
    expect(result.outDir).toBeUndefined();
    expect(existsSync(out)).toBe(false);
  }, 120_000);

  it("does not require an epoch to validate, because validation emits nothing", async () => {
    const root = tempRoot();
    writeSite(root);
    const result = await resolveFixture(root, { release: true });
    expect(codes(result.diagnostics)).not.toContain("FP1801");
    expect(result.model).toBeDefined();
  });

  it("does not require an epoch for a non-release preview build", async () => {
    const root = tempRoot();
    writeSite(root);
    const out = join(tempRoot("portal-dev-epoch-"), "site");
    const result = await buildSite({
      sourceRoot: canonicalizeRoot(root),
      configPath: join(root, "portal.yaml"),
      outDir: out,
      release: false,
      dev: true,
      quiet: true,
    });
    expect(codes(result.diagnostics)).not.toContain("FP1801");
    expect(result.outDir).toBe(out);
  }, 120_000);

  it("refuses an ISO timestamp in SOURCE_DATE_EPOCH instead of reading it as zero", () => {
    const root = writeMatrixSite({ databrowser: false, stac: false, auth: false });
    const out = join(tempRoot("portal-iso-epoch-"), "site");
    let message = "";
    try {
      execFileSync(
        process.execPath,
        [
          BIN,
          "build",
          "--source-root",
          root,
          "--config",
          join(root, "portal.yaml"),
          "--out",
          out,
          "--quiet",
        ],
        {
          encoding: "utf8",
          stdio: "pipe",
          env: { ...process.env, SOURCE_DATE_EPOCH: "2026-08-18T12:00:00Z" },
        },
      );
    } catch (error) {
      message = String((error as { stderr?: string }).stderr ?? "");
    }
    expect(message).toContain("integer number of seconds");
    expect(message).toContain("git show -s --format=%ct");
    expect(existsSync(out)).toBe(false);
  }, 60_000);
});

describe("the canonical archive", () => {
  it("is byte-identical for two isolated builds of the same inputs", async () => {
    const source = writeMatrixSite({ databrowser: true, stac: false, auth: true });
    const first = join(tempRoot("portal-archive-a-"), "site");
    const second = join(tempRoot("portal-archive-b-"), "site");
    expect((await buildFixture(source, first)).diagnostics.errors).toEqual([]);
    expect((await buildFixture(source, second)).diagnostics.errors).toEqual([]);

    const a = buildCanonicalArchive({ dir: first, sourceDateEpoch: recordedEpoch(first) });
    const b = buildCanonicalArchive({ dir: second, sourceDateEpoch: recordedEpoch(second) });
    expect(a.digest).toBe(b.digest);
    expect(a.bytes).toBe(b.bytes);
    expect(a.entries).toBe(b.entries);
  }, 240_000);

  it("is byte-identical when the two output paths have different lengths", async () => {
    // Output paths of DIFFERENT lengths, on purpose. The bundler counts a `//#region <path>`
    // banner in each module's rendered length, so a longer output path produces larger recorded
    // sizes and a different component-evidence.json - which two equal-length paths would hide.
    const source = writeMatrixSite({ databrowser: true, stac: false, auth: true });
    const short = join(tempRoot("portal-len-a-"), "s");
    const long = join(tempRoot("portal-len-b-"), "a-considerably-longer-output-directory-name");
    expect((await buildFixture(source, short)).diagnostics.errors).toEqual([]);
    expect((await buildFixture(source, long)).diagnostics.errors).toEqual([]);

    const evidence = (dir: string): unknown =>
      JSON.parse(readFileSync(join(dir, "component-evidence.json"), "utf8"));
    expect(evidence(short)).toEqual(evidence(long));

    const a = buildCanonicalArchive({ dir: short, sourceDateEpoch: recordedEpoch(short) });
    const b = buildCanonicalArchive({ dir: long, sourceDateEpoch: recordedEpoch(long) });
    expect(a.digest).toBe(b.digest);
  }, 240_000);

  it("takes every timestamp from the recorded epoch and none from the filesystem", async () => {
    const source = writeMatrixSite({ databrowser: false, stac: false, auth: false });
    const out = join(tempRoot("portal-archive-time-"), "site");
    await buildFixture(source, out);
    const path = join(tempRoot("portal-archive-out-"), "site.tar");
    buildCanonicalArchive({ dir: out, sourceDateEpoch: 1_000_000_000, out: path });
    const listing = execFileSync("tar", ["-tvf", path], { encoding: "utf8" });
    // 1_000_000_000 is 2001-09-09 in UTC; nothing may carry today's date.
    expect(listing).toContain("2001-09-0");
    expect(listing).not.toContain(String(new Date().getFullYear()));
    // Fixed ownership and modes, not the builder's account.
    expect(listing).toContain("root/root");
    expect(listing).toMatch(/-rw-r--r--/);
  }, 120_000);

  it("writes a gzip wrapper with no wall-clock timestamp", async () => {
    const source = writeMatrixSite({ databrowser: false, stac: false, auth: false });
    const out = join(tempRoot("portal-archive-gz-"), "site");
    await buildFixture(source, out);
    const path = join(tempRoot("portal-archive-gz-out-"), "site.tar.gz");
    buildCanonicalArchive({ dir: out, sourceDateEpoch: 1_760_000_000, out: path, compress: true });
    const bytes = readFileSync(path);
    expect(bytes.readUInt32LE(4)).toBe(0);
  }, 120_000);

  it("extracts to exactly the artifact it was made from", async () => {
    const source = writeMatrixSite({ databrowser: false, stac: false, auth: false });
    const out = join(tempRoot("portal-archive-rt-"), "site");
    await buildFixture(source, out);
    const path = join(tempRoot("portal-archive-rt-out-"), "site.tar");
    buildCanonicalArchive({ dir: out, sourceDateEpoch: recordedEpoch(out), out: path });
    const extracted = tempRoot("portal-archive-rt-extract-");
    execFileSync("tar", ["-xf", path, "-C", extracted]);
    execFileSync("diff", ["-r", out, extracted]);
  }, 120_000);

  it("changes when any artifact byte changes", async () => {
    const source = writeMatrixSite({ databrowser: false, stac: false, auth: false });
    const out = join(tempRoot("portal-archive-diff-"), "site");
    await buildFixture(source, out);
    const before = buildCanonicalArchive({ dir: out, sourceDateEpoch: 1_760_000_000 }).digest;
    const target = join(out, "index.html");
    const original = readFileSync(target);
    writeFileSync(target, `${original.toString("utf8")}<!-- x -->`);
    const after = buildCanonicalArchive({ dir: out, sourceDateEpoch: 1_760_000_000 }).digest;
    expect(after).not.toBe(before);
    writeFileSync(target, original);
  }, 120_000);
});
