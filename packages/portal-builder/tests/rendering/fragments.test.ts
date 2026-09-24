// Direct fragments. A prose source referenced by a landing block is an input - hashed,
// rendered, link-checked - but owns no route. Using one source as both a page and a fragment is
// an error, because one of the two uses is not what the author meant.

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

const LANDING_WITH_PROSE = `schemaVersion: 1
title: Home
blocks:
  - type: prose
    source: ../content/_fragments/intro.md
`;

describe("direct fragments", () => {
  it("renders and hashes a fragment without publishing a route for it", async () => {
    const root = tempRoot();
    write(root, "content/_fragments/intro.md", "Intro text.\n");
    write(root, "content/guide.md", "---\ntitle: Guide\n---\n\nBody.\n");
    writeSite(root, {
      landing: LANDING_WITH_PROSE,
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
      files:
        include: ["**/*.md"]
        exclude: ["_fragments/**"]
`,
    });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.model!.routes.map((r) => r.path)).not.toContain("/docs/_fragments/intro/");
    expect(
      result.model!.inputs.some((i) => i.role === "fragment" && i.path.endsWith("intro.md")),
    ).toBe(true);
    const block = result.model!.landings[0]!.blocks[0]!;
    expect(block.prose?.html).toContain("Intro text.");
  });

  it("refuses a source used as both a discovered page and a direct fragment", async () => {
    const root = tempRoot();
    write(root, "content/_fragments/intro.md", "Intro text.\n");
    writeSite(root, {
      landing: LANDING_WITH_PROSE,
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
      files:
        include: ["**/*.md"]
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("PC1020");
  });

  it("excludes dotfiles and honours an explicit exclude", async () => {
    const root = tempRoot();
    write(root, "content/guide.md", "---\ntitle: Guide\n---\n");
    write(root, "content/README.md", "---\ntitle: Readme\n---\n");
    write(root, "content/.hidden.md", "---\ntitle: Hidden\n---\n");
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
      files:
        include: ["**/*.md"]
        exclude: ["**/README.md"]
`,
    });
    const result = await resolveFixture(root);
    const paths = result.model!.routes.map((r) => r.path);
    expect(paths).toContain("/docs/guide/");
    expect(paths).not.toContain("/docs/readme/");
    expect(paths.some((p) => p.includes("hidden"))).toBe(false);
  });
});
