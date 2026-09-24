// More than one Python-enabled dataset-tree block on one page. The coordinator merges every such
// block into ONE page playground, which is right: a window is a place the visitor put somewhere,
// and a second appearing because a landing carries two trees would be two of the same place.
// What the merge must not get wrong is the identities and the configuration.
//
// IDENTITIES. Node ids are unique within one CATALOGUE - the parser enforces that - and a page
// may carry two catalogues, so a name of `<node id>::<example id>` is minted twice by two blocks
// over archives that both call a node `cmip6/tas`. The merge is a `Map.set()`, so the later
// block's source and digest win, and a press in the earlier block either runs the wrong snippet
// or is refused for carrying a digest the page no longer knows.
//
// CONFIGURATION. Taking the first block's profile, origin, session limit and terminal settings
// for the whole page gives a second block asking for a different interpreter the first one's,
// with nothing said.

import { describe, expect, it, afterAll } from "vitest";
import { join } from "node:path";
import { cleanupFixtures, codes, resolveFixture, tempRoot } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { writeConsumerSite, catalogue } from "../helpers/consumer.js";
import { registerCatalogExamples } from "../../src/model/dataset-tree.js";
import { parseDatasetTreeCatalogV1 } from "@freva-org/dataset-tree/snapshot";

afterAll(cleanupFixtures);

describe("registered identities", () => {
  it("are injective across blocks that share a node id", () => {
    const cat = parseDatasetTreeCatalogV1(catalogue("cmip6", 1, 1));
    const first = registerCatalogExamples(cat, "home-2");
    const second = registerCatalogExamples(cat, "home-3");
    expect(first.length).toBeGreaterThan(0);
    // The same catalogue in two blocks is two different sets of names.
    expect(first.map((e) => e.id)).not.toEqual(second.map((e) => e.id));
    for (const id of first.map((e) => e.id)) {
      expect(second.map((e) => e.id)).not.toContain(id);
    }
  });

  it("cannot be forged by putting the delimiter inside an id", () => {
    // The adversarial case for any composed name: if the delimiter can appear inside a segment,
    // two different (block, node, example) triples compose to one string, and the point of the
    // identity is that they cannot.
    const awkward = {
      schemaVersion: 1,
      roots: [
        {
          id: "a/b",
          kind: "dataset",
          name: "x",
          examples: [
            { id: "c", label: "P", language: "python", code: "print(1)\n", executable: true },
          ],
        },
        {
          id: "a",
          kind: "dataset",
          name: "y",
          examples: [
            { id: "b/c", label: "P", language: "python", code: "print(2)\n", executable: true },
          ],
        },
      ],
    };
    const registered = registerCatalogExamples(parseDatasetTreeCatalogV1(awkward), "home-1");
    const ids = registered.map((e) => e.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // …and the two snippets stay attached to the right names.
    const byId = new Map(registered.map((e) => [e.id, e.sha256]));
    expect(new Set(byId.values()).size).toBe(2);
  });
});

describe("two Python-enabled blocks on one page", () => {
  it("build when their playground configuration agrees", async () => {
    const root = writeConsumerSite({
      python: true,
      secondBlock: true,
      pages: 1,
    });
    const out = join(tempRoot("portal-two-blocks-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);
  }, 300_000);

  it("keep every example distinct, even over identical catalogues", async () => {
    const root = writeConsumerSite({ python: true, secondBlock: true, pages: 1 });
    const out = join(tempRoot("portal-two-blocks-ids-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);
    const blocks = (result.model?.landings ?? [])
      .flatMap((l) => l.blocks)
      .filter((b) => b.datasetTree?.python);
    expect(blocks).toHaveLength(2);
    const ids = blocks.flatMap((b) => b.datasetTree!.python!.examples.map((e) => e.id));
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  }, 300_000);

  it("refuse to build when the blocks ask for different interpreters", async () => {
    const root = writeConsumerSite({
      python: true,
      secondBlock: true,
      pages: 1,
      secondBlockPython: `    python:
      enabled: true
      profile: xarray-zarr
      autostart: never
      maxSessions: 2
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics.errors)).toContain("FP1215");
    expect(result.diagnostics.errors.map((d) => d.message).join(" ")).toMatch(/profile/);
  }, 120_000);

  it("refuse to build when the blocks ask for different origins", async () => {
    const root = writeConsumerSite({
      python: true,
      secondBlock: true,
      pages: 1,
      secondBlockPython: `    python:
      enabled: true
      profile: minimal
      autostart: never
      maxSessions: 2
      playgroundOrigin: https://play.example.org
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics.errors)).toContain("FP1215");
    expect(result.diagnostics.errors.map((d) => d.message).join(" ")).toMatch(/playgroundOrigin/);
  }, 120_000);

  it("refuse to build when the blocks disagree about session limits or the window", async () => {
    const root = writeConsumerSite({
      python: true,
      secondBlock: true,
      pages: 1,
      secondBlockPython: `    python:
      enabled: true
      profile: minimal
      autostart: never
      maxSessions: 1
      terminal:
        alwaysOnTop: false
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics.errors)).toContain("FP1215");
  }, 120_000);

  it("let a block stay Copy-only beside one with a playground", async () => {
    // Disagreeing is one thing; not asking at all is another, and must stay allowed.
    const root = writeConsumerSite({
      python: true,
      secondBlock: true,
      pages: 1,
      secondBlockPython: "",
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics.errors)).toEqual([]);
  }, 120_000);
});
