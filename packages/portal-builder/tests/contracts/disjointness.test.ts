// The complete transitive input graph, before any write. The destructive case is a *late*
// input: a landing file, a prose fragment, a policy or a subsite tree the resolver discovers
// only after deciding the output tree looked safe. Checking the declared roots alone lets that
// pass, and the atomic publish then replaces the directory the input was in.
//
// Each case also asserts that nothing was created on failure: a check that reports the problem
// after making the directory has prevented nothing.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  LOGO_SVG,
  mkdir,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";

afterAll(cleanupFixtures);

/** Files that existed before the attempt, so a mutation is visible. */
function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return ["<absent>"];
  return readdirSync(dir, { recursive: true, withFileTypes: false }) as unknown as string[];
}

async function expectRefused(
  root: string,
  outDir: string,
  expectation: { code?: string } = {},
): Promise<void> {
  const before = snapshot(outDir);
  const result = await resolveFixture(root, {
    outDir,
    temporaryDirs: [`${outDir}.tmp`, `${outDir}.generated`],
  });
  expect(codes(result.diagnostics)).toContain(expectation.code ?? "FP1003");
  expect(result.model).toBeUndefined();
  // Nothing was created, moved or removed.
  expect(snapshot(outDir)).toEqual(before);
  expect(existsSync(`${outDir}.tmp`)).toBe(false);
  expect(existsSync(`${outDir}.backup`)).toBe(false);
  expect(existsSync(`${outDir}.generated`)).toBe(false);
}

describe("late inputs are part of the graph", () => {
  it("refuses an output tree that contains a landing document", async () => {
    const root = tempRoot();
    mkdir(root, "site-output");
    write(
      root,
      "site-output/landings/home.yaml",
      "schemaVersion: 1\ntitle: Home\nblocks:\n  - type: hero\n    heading: Hi\n",
    );
    write(root, "assets/logo.svg", LOGO_SVG);
    write(root, "assets/favicon.svg", LOGO_SVG);
    write(
      root,
      "portal.yaml",
      `schemaVersion: 1
site:
  id: late-landing
  title: Late Landing
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
landings:
  home:
    path: /
    source: ./site-output/landings/home.yaml
`,
    );
    await expectRefused(root, join(root, "site-output"));
  });

  it("refuses an output tree that contains a landing prose fragment", async () => {
    const root = tempRoot();
    mkdir(root, "out");
    write(root, "out/intro.md", "Intro text.\n");
    writeSite(root, {
      landing: `schemaVersion: 1
title: Home
blocks:
  - type: prose
    source: ../out/intro.md
`,
    });
    await expectRefused(root, join(root, "out"));
  });

  it("refuses an output tree that contains the site identity assets", async () => {
    const root = tempRoot();
    mkdir(root, "artifact");
    write(root, "artifact/logo.svg", LOGO_SVG);
    write(root, "artifact/favicon.svg", LOGO_SVG);
    write(
      root,
      "landings/home.yaml",
      "schemaVersion: 1\ntitle: Home\nblocks:\n  - type: hero\n    heading: Hi\n",
    );
    write(
      root,
      "portal.yaml",
      `schemaVersion: 1
site:
  id: late-identity
  title: Late Identity
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./artifact/logo.svg
    favicon: ./artifact/favicon.svg
landings:
  home:
    path: /
    source: ./landings/home.yaml
`,
    );
    await expectRefused(root, join(root, "artifact"));
  });

  it("refuses an output tree that contains a trusted subsite or its policy", async () => {
    const root = tempRoot();
    write(root, "out/docs/index.html", "<!doctype html><html><body>x</body></html>");
    write(
      root,
      "out/policy.json",
      '{"schemaVersion":1,"profile":"static-docs-v1","entryPoints":["index.html"],"runtime":{"connectOrigins":[],"frameOrigins":[],"workers":"none"}}',
    );
    writeSite(root, {
      extra: `trustedSubsites:
  - profile: static-docs-v1
    source: ./out/docs
    mount: /reference/
    trust: active
    policy: ./out/policy.json
`,
    });
    await expectRefused(root, join(root, "out"));
  });

  it("refuses an output tree that contains a component's chrome image", async () => {
    const root = tempRoot();
    write(root, "out/catalog.svg", LOGO_SVG);
    writeSite(root, {
      extra: `services:
  publicCatalog:
    kind: stac
    catalogUrl: https://catalog.example.org/stac/
components:
  catalog:
    kind: stac-browser
    enabled: false
    options:
      chrome:
        image: ./out/catalog.svg
`,
    });
    await expectRefused(root, join(root, "out"));
  });

  it("refuses a temporary tree that overlaps an input, in either direction", async () => {
    const root = tempRoot();
    write(root, "content/guide.md", "---\ntitle: Guide\n---\n");
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
`,
    });
    // The output is elsewhere, but the temporary tree is inside a content root.
    const out = join(tempRoot(), "site");
    const result = await resolveFixture(root, {
      outDir: out,
      temporaryDirs: [join(root, "content", "scratch")],
    });
    expect(codes(result.diagnostics)).toContain("FP1003");
    expect(existsSync(join(root, "content", "scratch"))).toBe(false);
  });

  it("accepts an output tree that is genuinely disjoint", async () => {
    const root = tempRoot();
    write(root, "content/guide.md", "---\ntitle: Guide\n---\n");
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
`,
    });
    const out = join(tempRoot(), "site");
    const result = await resolveFixture(root, {
      outDir: out,
      temporaryDirs: [`${out}.tmp`],
    });
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.model).toBeDefined();
  });
});
