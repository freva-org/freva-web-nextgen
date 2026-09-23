// The `dataset-tree` landing block ships a whole component - a package, its stylesheet and a
// portal adapter - on the strength of one line of YAML, so most of this file answers the two
// questions that follow. Does a portal that did not ask for it contain none of it, checked
// against built output rather than asserted? And does the one that did ask get a page complete on
// its own, with no request, no service and no object-store client anywhere near it?
//
// The rest is the contract a consumer can see: a closed schema, diagnostics that name the node
// that is wrong, and a catalogue that survives being embedded in HTML whatever is in its strings.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { escapeJsonForScript, MAX_CATALOG_BYTES } from "../../src/model/dataset-tree.js";
import { projectRuntime, generateEntryModule } from "../../src/artifact/runtime-projection.js";

afterAll(cleanupFixtures);

const PKG = join(REPO_ROOT, "packages", "portal-builder");

/**
 * Traces only this block can leave. String literals and DOM attribute names, never function or
 * class names: the bundler renames those, so a test looking for `mountDatasetTree` passes on a
 * build that shipped the whole component under a mangled name. Each is asserted present in a build
 * that does enable the block - a fingerprint in no output proves nothing about output lacking it.
 */
const FINGERPRINTS = [
  "Filter datasets and paths",
  "dataset-tree__row",
  "data-dt-key",
  "portal-dataset-tree",
];

/** A small, valid catalogue. Two roots, four levels, one of every node kind. */
const CATALOG = JSON.stringify(
  {
    schemaVersion: 1,
    roots: [
      {
        id: "cmip6",
        kind: "collection",
        name: "CMIP6",
        description: "Coupled Model Intercomparison Project, phase 6",
        children: [
          {
            id: "cmip6/atmos",
            kind: "directory",
            name: "atmos",
            children: [
              {
                id: "cmip6/atmos/tas",
                kind: "dataset",
                name: "tas",
                title: "Near-surface air temperature",
                path: "s3://freva/cmip6/atmos/tas/",
                size: 48210944,
                availability: "available",
              },
            ],
          },
        ],
      },
      {
        id: "obs",
        kind: "collection",
        name: "Observations",
        children: [{ id: "obs/readme", kind: "file", name: "README.txt", size: 1024 }],
      },
    ],
  },
  null,
  2,
);

/** The landing that carries the block, in the hero row where it replaces the search box. */
function landingWith(blockYaml: string): string {
  return `schemaVersion: 1
title: Test Site
blocks:
  - type: hero
    heading: Hello
${blockYaml}`;
}

const BLOCK = `  - type: dataset-tree
    catalog: ../data/archive.json
    heading: Browse the archive
    summary: Expand a collection.
    expand:
      - cmip6
`;

interface Fixture {
  root: string;
}

function writeCatalogSite(catalog = CATALOG, block = BLOCK): Fixture {
  const root = tempRoot("portal-dt-");
  writeSite(root, { landing: landingWith(block) });
  write(root, "data/archive.json", catalog);
  return { root };
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

interface Built {
  out: string;
  files: string[];
  html: string;
  /** Everything the browser would execute or apply, as one string. */
  code: string;
  evidence: {
    components: {
      id: string;
      kind: string;
      enabled: boolean;
      modules: string[];
      chunks: string[];
    }[];
  };
}

async function build(root: string, prefix: string): Promise<Built> {
  const out = join(tempRoot(prefix), "site");
  const result = await buildFixture(root, out);
  expect(result.diagnostics.errors).toEqual([]);
  const files = tree(out);
  const code = files
    .filter((f) => f.endsWith(".js") || f.endsWith(".css"))
    .map((f) => readFileSync(join(out, ...f.split("/")), "utf8"))
    .join("\n");
  return {
    out,
    files,
    html: readFileSync(join(out, "index.html"), "utf8"),
    code,
    evidence: JSON.parse(
      readFileSync(join(out, "component-evidence.json"), "utf8"),
    ) as Built["evidence"],
  };
}

describe("the dataset-tree block's schema", () => {
  it("is a closed member of the landing block union", () => {
    const schema = JSON.parse(readFileSync(join(PKG, "schema", "landing.schema.json"), "utf8")) as {
      $defs: Record<
        string,
        {
          additionalProperties?: boolean;
          required?: string[];
          properties?: Record<string, unknown>;
          oneOf?: { required: string[]; properties: Record<string, unknown> }[];
        }
      >;
    };
    const block = schema.$defs.blockDatasetTree!;
    expect(block.additionalProperties).toBe(false);
    // `catalog` is not required at the top level: a block takes EITHER a build-time catalogue or
    // a live `s3` source, and `oneOf` says exactly one. Each branch names both keys because Ajv's
    // strict mode requires every `required` name to be declared in the same subschema, and so a
    // reader of the schema can see both alternatives.
    expect(block.required).toEqual(["type"]);
    expect(block.oneOf).toHaveLength(2);
    expect(block.oneOf?.[0]).toEqual({
      required: ["catalog"],
      properties: { catalog: true, s3: false },
    });
    expect(block.oneOf?.[1]).toEqual({
      required: ["s3"],
      properties: { s3: true, catalog: false },
    });
    expect(Object.keys(block.properties!).sort()).toEqual([
      "catalog",
      "expand",
      "heading",
      // The Python playground, which is the block's and is checked in its own suite.
      "python",
      // The live source, the other half of the discriminated pair.
      "s3",
      "statusLabel",
      "summary",
      "type",
    ]);
    // The union is a closed enum, not an open string.
    const union = schema.$defs.block as { properties: { type: { enum: string[] } } };
    expect(union.properties.type.enum).toContain("dataset-tree");
    expect(union.properties.type.enum).toContain("component-search");
  });

  it("rejects an unknown key in the block", async () => {
    const { root } = writeCatalogSite(
      CATALOG,
      `${BLOCK}    liveEndpoint: https://s3.example.org/\n`,
    );
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1104");
  });

  it("refuses a catalogue path that escapes the source root", async () => {
    const { root } = writeCatalogSite(
      CATALOG,
      `  - type: dataset-tree\n    catalog: ../../../etc/passwd\n`,
    );
    const result = await resolveFixture(root);
    // The containment anchor answers before anything is read, so the code is a path violation
    // rather than a parse or validation failure.
    expect(codes(result.diagnostics).some((c) => c === "FP1001" || c === "FP1006")).toBe(true);
  });
});

describe("the catalogue", () => {
  it("is validated against the published contract, with the failing node named", async () => {
    const broken = JSON.stringify({
      schemaVersion: 1,
      roots: [
        { id: "a", kind: "collection", name: "A" },
        { id: "b", kind: "nonsense", name: "B" },
      ],
    });
    const { root } = writeCatalogSite(broken);
    const result = await resolveFixture(root);
    const failures = result.diagnostics.items.filter((d) => d.code === "FP1104");
    expect(failures.length).toBeGreaterThan(0);
    // The pointer addresses the catalogue file, which is where the reader has to go.
    expect(
      failures.some((d) => d.file === "data/archive.json" && d.pointer === "/roots/1/kind"),
    ).toBe(true);
    expect(result.model).toBeUndefined();
  });

  it("refuses a duplicate identifier, which no JSON Schema can express", async () => {
    const dupes = JSON.stringify({
      schemaVersion: 1,
      roots: [
        { id: "same", kind: "collection", name: "A" },
        { id: "same", kind: "collection", name: "B" },
      ],
    });
    const { root } = writeCatalogSite(dupes);
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1104");
  });

  it("refuses invalid JSON without a stack trace", async () => {
    const { root } = writeCatalogSite("{ not json");
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1101");
  });

  it("fails the build when an expanded identifier is not in the catalogue", async () => {
    const { root } = writeCatalogSite(
      CATALOG,
      `  - type: dataset-tree\n    catalog: ../data/archive.json\n    expand:\n      - cmip7\n`,
    );
    const result = await resolveFixture(root);
    const failure = result.diagnostics.items.find((d) => d.code === "FP1201");
    expect(failure?.message).toContain("cmip7");
  });

  it("has a size ceiling, because every visitor to the landing pays for it", async () => {
    const filler = "x".repeat(400);
    const roots = Array.from({ length: 1200 }, (_, i) => ({
      id: `n${i}`,
      kind: "dataset",
      name: `dataset-${i}`,
      description: filler,
    }));
    const { root } = writeCatalogSite(JSON.stringify({ schemaVersion: 1, roots }));
    const result = await resolveFixture(root);
    const failure = result.diagnostics.items.find((d) => d.code === "FP1407");
    expect(failure?.message).toContain(String(MAX_CATALOG_BYTES));
  });

  it("is re-serialised from the parsed document, not copied from the file", async () => {
    // Same catalogue, wildly different formatting. The embedded bytes must be identical.
    const compact = JSON.stringify(JSON.parse(CATALOG));
    const sprawling = JSON.stringify(JSON.parse(CATALOG), null, 8);
    const a = await resolveFixture(writeCatalogSite(compact).root);
    const b = await resolveFixture(writeCatalogSite(sprawling).root);
    const jsonOf = (r: typeof a): string =>
      r.model!.landings[0]!.blocks.find((x) => x.type === "dataset-tree")!.datasetTree!
        .catalogScriptJson;
    expect(jsonOf(a)).toEqual(jsonOf(b));
  });
});

describe("embedding the catalogue in the page", () => {
  it("escapes anything that could end the script element early", () => {
    const hostile = JSON.stringify({ note: "</script><img src=x onerror=alert(1)>" });
    const escaped = escapeJsonForScript(hostile);
    expect(escaped).not.toContain("</script>");
    expect(escaped).not.toContain("<");
    // Still the same document: an escaped `<` is a `<`.
    expect(JSON.parse(escaped)).toEqual(JSON.parse(hostile));
  });

  it("escapes the two line separators that are legal in JSON and fatal in JavaScript", () => {
    const json = JSON.stringify({ a: "x\u2028y", b: "p\u2029q" });
    const escaped = escapeJsonForScript(json);
    expect(escaped).not.toContain("\u2028");
    expect(escaped).not.toContain("\u2029");
    expect(JSON.parse(escaped)).toEqual(JSON.parse(json));
  });

  it("puts the catalogue in the page as data and never as a request", async () => {
    const { root } = writeCatalogSite();
    const built = await build(root, "portal-dt-out-");
    expect(built.html).toContain('type="application/json"');
    expect(built.html).toContain("data-portal-dataset-tree-catalog");
    expect(built.html).toContain("Near-surface air temperature");
    // No catalogue file was emitted beside the page, so there is nothing to fetch even by accident.
    expect(built.files.filter((f) => f.endsWith(".json") && f.includes("archive"))).toEqual([]);
  }, 180_000);

  it("survives a catalogue that contains a closing script tag", async () => {
    const hostile = JSON.parse(CATALOG) as { roots: { description?: string }[] };
    hostile.roots[0]!.description = "</script><script>window.__pwned = 1;</script>";
    const { root } = writeCatalogSite(JSON.stringify(hostile));
    const built = await build(root, "portal-dt-hostile-");
    // The payload stays in the page - it is part of the catalogue, and dropping a consumer's data
    // would be worse than the bug being prevented. What must not exist is a second `<script>`
    // element: the `<` is escaped, so the browser sees one JSON data block containing a harmless
    // string rather than the end of one element and the start of an executable one.
    expect(built.html).not.toContain("<script>window.__pwned");
    expect(built.html).not.toContain("</script><script>");
    expect(built.html).toContain("\\u003c/script");
    expect(built.html.match(/<script/g) ?? []).toHaveLength(
      (built.html.match(/<\/script>/g) ?? []).length,
    );
  }, 180_000);
});

describe("what a portal that enables the block gets", () => {
  it("imports the component and its stylesheet, and nothing from the object store", async () => {
    const { root } = writeCatalogSite();
    const built = await build(root, "portal-dt-on-");
    for (const trace of FINGERPRINTS) expect(built.code).toContain(trace);

    const plan = built.evidence.components.find((c) => c.id === "dataset-tree")!;
    expect(plan.enabled).toBe(true);
    expect(plan.modules).toContain("builder:client/components/dataset-tree.ts");
    expect(plan.modules).toContain("builder:client/components/dataset-tree.css");
    expect(plan.modules.some((m) => m.endsWith("#dist/tree.js"))).toBe(true);
    expect(plan.modules.some((m) => m.endsWith("#dist/styles.css"))).toBe(true);
    expect(plan.modules.some((m) => m.endsWith("#dist/snapshot/parse.js"))).toBe(true);
    // The one that matters most. The package publishes a read-only S3 listing adapter from a
    // separate entry point, and a portal in snapshot mode must not carry it: an object-store
    // client on a page that never calls one makes the recorded CSP a lie. Checked against the
    // graph the build produced.
    expect(plan.modules.some((m) => m.includes("/s3"))).toBe(false);
    expect(built.code).not.toContain("list-type=2");
  }, 180_000);

  it("still works with JavaScript switched off, by saying so", async () => {
    const { root } = writeCatalogSite();
    const built = await build(root, "portal-dt-noscript-");
    expect(built.html).toContain("<noscript>");
    expect(built.html).toContain("needs JavaScript");
  }, 180_000);
});

describe("what a portal that does not enable it gets", () => {
  it("contains no Dataset Tree bytes at all", async () => {
    const root = tempRoot("portal-dt-off-");
    writeSite(root);
    const built = await build(root, "portal-dt-off-out-");
    for (const trace of FINGERPRINTS) expect(built.code).not.toContain(trace);
    expect(built.html).not.toContain("dataset-tree");

    // The only mention of the block anywhere in the artifact is the evidence document recording
    // its absence, which makes that absence a checked fact rather than a claim.
    const mentions = built.files.filter((file) =>
      readFileSync(join(built.out, ...file.split("/")), "utf8").includes("dataset-tree"),
    );
    expect(mentions).toEqual(["component-evidence.json"]);

    const plan = built.evidence.components.find((c) => c.id === "dataset-tree")!;
    expect(plan.enabled).toBe(false);
    expect(plan.modules).toEqual([]);
    expect(plan.chunks).toEqual([]);
  }, 180_000);

  it("does not import the island in the generated entry", async () => {
    const plain = tempRoot("portal-dt-entry-plain-");
    writeSite(plain);
    const resolved = await resolveFixture(plain);
    const entry = generateEntryModule(resolved.model!);
    expect(entry).not.toContain("dataset-tree");
    expect(projectRuntime(resolved.model!).datasetTree).toBeUndefined();
  });

  it("imports it exactly once when a landing declares it, naming the instance", async () => {
    const { root } = writeCatalogSite();
    const resolved = await resolveFixture(root);
    const projection = projectRuntime(resolved.model!);
    // The modes are part of the projection because they decide which loader the entry imports.
    expect(projection.datasetTree).toEqual({
      instances: ["home-1"],
      snapshot: true,
      s3: false,
    });
    const entry = generateEntryModule(resolved.model!);
    expect(entry.match(/components\/dataset-tree\.ts/g)).toHaveLength(1);
    // A literal dynamic import, gated on a block being on THIS page: the island and the package
    // stylesheet it carries stay out of the chunk every page loads.
    expect(entry).toContain('document.querySelector("[data-portal-dataset-tree]")');
    // The loaders are passed in, and only the ones this portal's blocks use are named at all.
    expect(entry).toContain(
      "m.mountDatasetTreeBlocks({ snapshot: loadSnapshotSource, inspector: loadInspector })",
    );
    expect(entry).toContain("components/tree-source-snapshot.ts");
    expect(entry).not.toContain("tree-source-s3");
    expect(entry).not.toContain("import { mountDatasetTreeBlocks }");
  });
});

describe("the block in the page", () => {
  // The block stands in the hero row's right-hand column, where a search box stands, and takes
  // the wide split rather than the even one: a dataset tree on this portal is the workspace the
  // visitor came to use, and an 0.8/1.2 split capped at 40rem makes it the smaller half of a page
  // that is mostly prose. Placing it below the hero instead leaves the hero with an empty
  // right-hand half and pushes the one thing a visitor came for below the fold. Measured in the
  // browser suite: at 1440x820 the tree's rows begin at y=562, a quarter of the panel visible
  // without scrolling, with the Expand control above them.
  it("stands in the hero aside, in a column wide enough for what it draws", async () => {
    const { root } = writeCatalogSite();
    const built = await build(root, "portal-dt-aside-");

    const asideStart = built.html.indexOf('class="portal-hero-aside"');
    expect(asideStart).toBeGreaterThanOrEqual(0);
    const aside = built.html.slice(asideStart, built.html.indexOf("</div>", asideStart));
    expect(aside).toContain('data-block="dataset-tree"');

    // Two columns, and the split named so the stylesheet can widen the one holding the tree.
    expect(built.html).toContain('data-columns="two"');
    expect(built.html).toContain('data-aside="wide"');

    // The tree follows the hero in the document, so a reader with no CSS meets them in order.
    const hero = built.html.indexOf('data-block="hero"');
    const tree = built.html.indexOf('data-block="dataset-tree"');
    expect(hero).toBeGreaterThanOrEqual(0);
    expect(tree).toBeGreaterThan(hero);
  }, 180_000);

  it("carries one maximize control, named, and never a disabled one", async () => {
    // Not hover-revealed window chrome - maximise, minimise, close - with two of the three
    // locked: a permanently disabled button reads as broken rather than unavailable, and minimise
    // and close have no meaning for a block that is part of the page's composition.
    const { root } = writeCatalogSite();
    const built = await build(root, "portal-dt-expand-");
    expect(built.html.match(/data-portal-tree-expand/g)).toHaveLength(1);
    // A real button with a pressed state, not a link dressed as one.
    expect(built.html).toContain('aria-expanded="false"');
    const bar = built.html.slice(
      built.html.indexOf('class="portal-dataset-tree-bar"'),
      built.html.indexOf('class="portal-dataset-tree"'),
    );
    expect(bar).not.toContain("disabled");
    // Icon-only at rest still has a name, because a glyph is not one.
    expect(bar).toMatch(/aria-label="Maximize[^"]*"/);
  }, 180_000);

  it("never uses a word the tree's own toolbar already owns", async () => {
    // A control toggling `Expand` / `Collapse` puts two controls saying "Collapse" on one screen
    // doing entirely different things: the component's toolbar collapses branches, this one
    // leaves full screen. A visitor has only the label to tell them apart. The labels are
    // compared against the package's own defaults rather than a copy written here, so renaming a
    // toolbar button re-runs the comparison instead of quietly making it vacuous.
    const { DEFAULT_LABELS } = await import("@freva-org/dataset-tree");
    const toolbar = [
      DEFAULT_LABELS.expandAll,
      DEFAULT_LABELS.collapseAll,
      DEFAULT_LABELS.collapseTree,
    ].map((label) => label.toLowerCase());

    const source = readFileSync(
      join(PKG, "astro", "src", "components", "DatasetTreeBlock.astro"),
      "utf8",
    );
    const markup = source.slice(source.indexOf('class="portal-tree-expand"'));
    const rest = /<span class="portal-tree-expand-text">([^<]+)<\/span>/.exec(markup)?.[1];
    expect(rest, "the control has no visible label at all").toBeTruthy();
    expect(toolbar).not.toContain((rest ?? "").toLowerCase());

    // And the label it swaps to when maximized, which lives in the island.
    const island = readFileSync(join(PKG, "client", "components", "dataset-tree.ts"), "utf8");
    const swapped = /const label = on \? "([^"]+)" : "([^"]+)"/.exec(island);
    expect(swapped, "the maximized label is not where this test looks for it").toBeTruthy();
    for (const label of [swapped?.[1] ?? "", swapped?.[2] ?? ""]) {
      expect(toolbar, `"${label}" collides with the tree's own toolbar`).not.toContain(
        label.toLowerCase(),
      );
    }
  });

  it("widens only the row that actually holds a tree", () => {
    const css = readFileSync(
      join(PKG, "astro", "src", "styles", "freva-shell.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    // The even split is the default; the wide one is opt-in from the markup.
    expect(css).toMatch(/\[data-columns="two"\]\s*\{[^}]*1\.05fr/);
    expect(css).toMatch(/\[data-columns="two"\]\[data-aside="wide"\]\s*\{[^}]*1\.2fr/);
  });

  it("wraps the tree in nothing: no second card around the component's own panel", () => {
    // The rule this protects is about DECORATION, not layout. The component draws a complete
    // bordered panel, and nesting it inside a second bordered panel gives two frames with two
    // radii and costs the tree the width it needs. The block does carry the page's own content
    // width and gutter - `max-width` and `padding`, which every other block carries and which
    // draw nothing. What must stay absent is the card: a border, a radius, a shadow.
    const source = readFileSync(join(PKG, "client", "components", "dataset-tree.css"), "utf8");
    const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
    const block = css.slice(
      css.indexOf(".portal-dataset-tree-block {"),
      css.indexOf("}", css.indexOf(".portal-dataset-tree-block {")),
    );
    for (const property of ["border", "border-radius", "box-shadow", "background"]) {
      expect(block).not.toContain(property);
    }
  });

  it("carries a stable instance id that is not derived from render order", async () => {
    const { root } = writeCatalogSite();
    const resolved = await resolveFixture(root);
    const block = resolved.model!.landings[0]!.blocks.find((b) => b.type === "dataset-tree")!;
    // `<landing id>-<block index in the source document>`.
    expect(block.datasetTree!.instanceId).toBe("home-1");
    expect(block.datasetTree!.nodeCount).toBe(5);
    expect(block.datasetTree!.rootCount).toBe(2);
    expect(block.datasetTree!.expandedIds).toEqual(["cmip6"]);
  });

  it("records the catalogue as a build input, so the artifact says what it was made from", async () => {
    const { root } = writeCatalogSite();
    const built = await build(root, "portal-dt-input-");
    const manifest = JSON.parse(readFileSync(join(built.out, "input-manifest.json"), "utf8")) as {
      sources: { ref: { path: string }; role: string }[];
    };
    const entry = manifest.sources.find((s) => s.ref.path === "data/archive.json");
    expect(entry).toBeDefined();
    expect(entry!.role).toBe("config");
  }, 180_000);
});

describe("the recorded Content Security Policy", () => {
  // Snapshot mode needs no permission, and the policy has to say so. Hashing every inline
  // `<script>` into `script-src`, data blocks included, widens the policy for something the
  // browser never executes and re-widens it whenever the CATALOGUE changes. A policy that tracks
  // a portal's content rather than its code is worse than no policy, because the first time it
  // breaks a page somebody switches it off.
  it("is byte-identical with and without the block", async () => {
    const off = tempRoot("portal-dt-csp-off-");
    writeSite(off);
    const withoutBlock = await build(off, "portal-dt-csp-off-out-");
    const { root } = writeCatalogSite();
    const withBlock = await build(root, "portal-dt-csp-on-out-");
    const policyOf = (dir: string): unknown =>
      (JSON.parse(readFileSync(join(dir, "host-policy.json"), "utf8")) as { csp: unknown }).csp;
    expect(policyOf(withBlock.out)).toEqual(policyOf(withoutBlock.out));
  }, 240_000);

  it("does not hash a JSON data block into script-src", async () => {
    const { root } = writeCatalogSite();
    const built = await build(root, "portal-dt-csp-hash-");
    const policy = JSON.parse(readFileSync(join(built.out, "host-policy.json"), "utf8")) as {
      csp: Record<string, Record<string, string>>;
    };
    const scriptSrc = policy.csp.portal!["script-src"]!;
    // Exactly one hash: the shell's own theme script, which really is executed. The catalogue is
    // data, so it contributes nothing, and `connect-src` stays `'self'` because nothing fetches.
    expect((scriptSrc.match(/'sha256-/g) ?? []).length).toBe(1);
    expect(policy.csp.portal!["connect-src"]).toBe("'self'");
    expect(built.html).toContain('type="application/json"');
    expect(scriptSrc).not.toContain("unsafe-inline");
  }, 180_000);
});

describe("reproducibility", () => {
  it("produces byte-identical artifacts from the same catalogue", async () => {
    const { root } = writeCatalogSite();
    const first = await build(root, "portal-dt-repro-a-");
    const second = await build(root, "portal-dt-repro-b-");
    const digestOf = (dir: string): string => readFileSync(join(dir, "checksums.sha256"), "utf8");
    expect(digestOf(first.out)).toEqual(digestOf(second.out));
    expect(first.html).toEqual(second.html);
  }, 240_000);
});

describe("the Cosmos surface", () => {
  const source = readFileSync(join(PKG, "client", "components", "dataset-tree.css"), "utf8");
  // Comments are stripped before anything is asserted about absence: the stylesheet's own prose
  // names the scene opacity it must not touch, and a search its explanation satisfies would pass
  // on a stylesheet that dimmed the scene in the next rule down.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");

  it("is bought locally, and never by dimming the scene", () => {
    // One surface, on the component's own panel: the wrapper has none to tint, and two nested
    // translucent cards multiply their alphas into a muddier centre than either intended.
    expect(css).toContain(
      '.portal-shell[data-backdrop="cosmos"] .portal-dataset-tree .dataset-tree',
    );
    expect(css).not.toContain('.portal-shell[data-backdrop="cosmos"] .portal-dataset-tree-block {');
    expect(css).toContain("var(--portal-cosmos-card-alpha");
    // The scene's opacity belongs to the theme and is 1. A block reaching for it to make itself
    // readable takes the picture away from every other surface on the page at the same time.
    expect(css).not.toContain("--portal-cosmos-scene-opacity");
    expect(css).not.toContain("filter: blur");
  });

  it("overrides only the package's supported variables", () => {
    // `--dataset-tree-*` is the documented surface; an internal class is not.
    expect(css).not.toMatch(/\.dataset-tree__[a-z-]+\s*\{/);
  });

  it("ships only with the block, so a Cosmos portal without one is unaffected", async () => {
    const root = tempRoot("portal-dt-cosmos-off-");
    writeSite(root, { theme: "cosmos" });
    const built = await build(root, "portal-dt-cosmos-off-out-");
    expect(built.code).not.toContain("portal-dataset-tree-block");
    expect(built.code).toContain("portal-cosmos");
  }, 240_000);
});
