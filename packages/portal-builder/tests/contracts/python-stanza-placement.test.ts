// Where a `python` stanza may be written, and which configuration a page ends up with.
//
// The rule, in one place (docs/configuration.md, "Which playground configuration wins"):
//
//   1. `pythonPlayground` in portal.yaml is the portal's playground.
//   2. A `dataset-tree` block's `python` stanza inherits it and overrides only the keys it writes.
//   3. Runnable prose (a `try-in-python` block on a documentation page or in a landing prose
//      fragment) always uses (1). A prose block has no `python` key of its own.
//   4. Everything that runs Python on one page - and across pages - must agree (`FP1215`). There
//      is no precedence: a disagreement is an error naming the key.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, write } from "../helpers/fixture.js";
import { writeConsumerSite } from "../helpers/consumer.js";

afterAll(cleanupFixtures);

const landing = (treePython: string, prose: string): string => `schemaVersion: 1
title: Waterpark-shaped
blocks:
  - type: hero
    heading: Data
  - type: dataset-tree
    catalog: ../data/archive.json
${treePython}  - type: prose
    source: ../prose/intro.md
${prose}`;

function site(treePython: string, prose: string, runnable: boolean): string {
  const root = writeConsumerSite({ playground: { profile: "minimal", autostart: "never" } });
  write(
    root,
    "prose/intro.md",
    runnable
      ? "Try it.\n\n```python try-in-python\nprint('hello')\n```\n"
      : "Only words here, nothing to run.\n",
  );
  write(root, "landings/home.yaml", landing(treePython, prose));
  return root;
}

const INHERIT = "    python:\n      enabled: true\n";

describe("a python stanza on a prose block", () => {
  it("is one error at the block, with a hint naming where the playground is configured", async () => {
    const root = site(
      INHERIT,
      `    python:
      enabled: true
      profile: xarray-zarr
      autostart: after-interactive
      terminal:
        osControls: mac
`,
      false,
    );
    const { model, diagnostics } = await resolveFixture(root);
    expect(model).toBeUndefined();
    // The landing is refused, so its navigation target is unknown too (FP1201); that is a
    // consequence rather than a second finding. The schema finding is exactly one diagnostic, at
    // the prose block - not one "Value must be …" per block type the author did not mean.
    const errors = diagnostics.errors.filter((d) => d.code === "FP1104");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("FP1104");
    expect(errors[0]!.pointer).toBe("/blocks/2");
    expect(errors[0]!.message).toMatch(/Unknown property 'python'/);
    expect(errors[0]!.hint).toMatch(/dataset-tree/);
    expect(errors[0]!.hint).toMatch(/pythonPlayground/);
  });

  it("an unknown block type is reported once, as an unknown type", async () => {
    const root = site(INHERIT, "", false);
    write(
      root,
      "landings/home.yaml",
      "schemaVersion: 1\ntitle: X\nblocks:\n  - type: gallery\n    heading: Y\n",
    );
    const { diagnostics } = await resolveFixture(root);
    const errors = diagnostics.errors.filter((d) => d.code === "FP1104");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.pointer).toBe("/blocks/0/type");
    expect(errors[0]!.message).toMatch(/one of: "hero"/);
  });
});

describe("which playground configuration a page gets", () => {
  it("a tree that only enables Python inherits the portal's stanza, beside runnable prose", async () => {
    const root = site(INHERIT, "", true);
    const { model, diagnostics } = await resolveFixture(root);
    expect(codes(diagnostics.errors)).toEqual([]);
    const home = model!.routes.find((route) => route.path === "/")!;
    expect(home.python?.profile).toBe("minimal");
    expect(home.python?.autostart).toBe("never");
  });

  it("a tree that overrides a key disagrees with runnable prose on the same page (FP1215)", async () => {
    const root = site(
      "    python:\n      enabled: true\n      profile: xarray-zarr\n      autostart: after-interactive\n",
      "",
      true,
    );
    const { diagnostics } = await resolveFixture(root);
    expect(codes(diagnostics.errors)).toContain("FP1215");
    const text = diagnostics.errors.map((d) => d.message).join(" ");
    expect(text).toMatch(/'profile'/);
    expect(text).toMatch(/'autostart'/);
  });
});
