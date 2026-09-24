// One prepared tree, many deployments, at the same time. Preparation happens once, centrally,
// and a deployment build only READS the result, so several deployments must consume one prepared
// tree concurrently without interfering, and a consumer build must leave that tree exactly as it
// found it - unchanged down to the modification times, because the next build's cache key is
// computed from it.
//
// Reuse matters as much: if two deployments of the same pin produced different application
// bytes, "prepared once" would describe the workflow rather than the output, and the digest a
// deployment records for its STAC would mean nothing across sites.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite, STAC_MATERIALS } from "../helpers/site.js";

afterAll(cleanupFixtures);

/** Every file under a tree, with its digest and modification time. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stats = statSync(full);
      const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
      out.set(relative(root, full).split(sep).join("/"), `${digest}:${stats.mtimeMs}`);
    }
  };
  walk(root);
  return out;
}

/** The application's own files in an artifact, by artifact-relative path. */
function stacFiles(out: string): Map<string, string> {
  const root = join(out, "stac");
  const files = new Map<string, string>();
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files.set(
        relative(root, full).split(sep).join("/"),
        createHash("sha256").update(readFileSync(full)).digest("hex"),
      );
    }
  };
  walk(root);
  return files;
}

describe.skipIf(!STAC_MATERIALS)("two deployments consuming one prepared tree", () => {
  it("build concurrently, reuse the same bytes, and leave the tree untouched", async () => {
    const materials = STAC_MATERIALS!;
    const before = snapshot(materials);
    expect(before.size).toBeGreaterThan(0);

    const first = writeMatrixSite({
      databrowser: false,
      stac: true,
      auth: false,
      canonicalUrl: "https://one.example.org/",
    });
    const second = writeMatrixSite({
      databrowser: false,
      stac: true,
      auth: false,
      canonicalUrl: "https://two.example.org/deep/",
    });
    const firstOut = join(tempRoot("portal-stac-concurrent-a-"), "site");
    const secondOut = join(tempRoot("portal-stac-concurrent-b-"), "site");

    // Started together on purpose: a build that wrote into the prepared tree, or into a shared
    // scratch path derived from a well-known location, corrupts the other one here.
    const [a, b] = await Promise.all([
      buildFixture(first, firstOut),
      buildFixture(second, secondOut),
    ]);
    expect(a.diagnostics.errors).toEqual([]);
    expect(b.diagnostics.errors).toEqual([]);

    // The prepared tree is an input. Content and modification times both, because the next build's
    // cache key is computed from this directory.
    expect(snapshot(materials)).toEqual(before);

    // Same pin, same bytes: the application is prepared once and reused, not rebuilt per site.
    const published = stacFiles(firstOut);
    // Non-empty, so "the two agree" is about hundreds of files rather than two empty maps.
    expect(published.size).toBeGreaterThan(100);
    expect([...published.keys()].some((path) => /^assets\/index-.+\.js$/.test(path))).toBe(true);
    expect(stacFiles(secondOut)).toEqual(published);

    // And the deployments really are different: the derived route prefix follows each canonical
    // base, so this is two distinct artifacts sharing one application.
    const firstPage = readFileSync(join(firstOut, "catalog", "index.html"), "utf8");
    const secondPage = readFileSync(join(secondOut, "catalog", "index.html"), "utf8");
    expect(firstPage).not.toEqual(secondPage);
    const bundles = (out: string): string =>
      readdirSync(join(out, "_portal"))
        .filter((file) => file.endsWith(".js"))
        .map((file) => readFileSync(join(out, "_portal", file), "utf8"))
        .join("\n");
    expect(`${bundles(secondOut)}${secondPage}`).toContain("/deep/catalog/");
    expect(`${bundles(firstOut)}${firstPage}`).not.toContain("/deep/catalog/");

    // Each artifact records which prepared tree it consumed, and they agree.
    const digestOf = (out: string): string =>
      (
        JSON.parse(readFileSync(join(out, "input-manifest.json"), "utf8")) as {
          stac: { preparedDigest: string };
        }
      ).stac.preparedDigest;
    expect(digestOf(firstOut)).toBe(digestOf(secondOut));
    expect(digestOf(firstOut)).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 300_000);
});
