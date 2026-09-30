// A live dataset-tree block's search index, at build time: which blocks may have one, what a
// broken or oversized index does, and what the build publishes. The browser half - that a search
// finds index entries without an S3 request and that the tree never waits for the file - is in
// `browser-tests/dataset-tree-search-index.mjs`.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import {
  MAX_SEARCH_INDEX_BYTES,
  loadDatasetTreeSearchIndex,
} from "../../src/model/dataset-tree.js";
import { DiagnosticBag } from "../../src/diagnostics.js";
import { buildFixture } from "../helpers/site.js";
import { verifyArtifact } from "../../src/verify/verify.js";
import { generateEntryModule, projectRuntime } from "../../src/artifact/runtime-projection.js";

afterAll(cleanupFixtures);

const ENDPOINT = "https://s3.example.org";

const INDEX = {
  schemaVersion: 1,
  generatedAt: "2026-09-30T04:00:00Z",
  source: ENDPOINT,
  complete: true,
  entries: [
    {
      id: "s3://cmip6/healpix/cmip6/tas_day.zarr/",
      kind: "dataset",
      name: "tas_day.zarr",
      path: "s3://cmip6/healpix/cmip6/tas_day.zarr/",
      ancestors: [{ id: "s3://cmip6/healpix/cmip6/", name: "cmip6" }],
    },
  ],
};

const live = (extra = "") => `  - type: dataset-tree
    heading: Currently available datasets
${extra}    s3:
      endpoint: ${ENDPOINT}
      style: path
      roots:
        - name: cmip6
          bucket: cmip6
          prefix: healpix/cmip6/
`;

/** A site with one dataset-tree block and an index file beside the landing. */
function site(block: string, index: unknown = INDEX, raw?: string): string {
  const root = tempRoot("portal-dt-index-");
  writeSite(root, {
    landing: `schemaVersion: 1\ntitle: Test Site\nblocks:\n  - type: hero\n    heading: Hello\n${block}`,
  });
  write(root, "data/dataset-index.json", raw ?? JSON.stringify(index));
  write(
    root,
    "data/archive.json",
    JSON.stringify({ schemaVersion: 1, roots: [{ id: "a", kind: "collection", name: "A" }] }),
  );
  return root;
}

const treeOf = (result: Awaited<ReturnType<typeof resolveFixture>>) =>
  result.model!.landings[0]!.blocks.find((b) => b.type === "dataset-tree")!.datasetTree!;

describe("the schema and the one-source rule", () => {
  it("accepts `searchIndex` on a live block and publishes it as one hashed file", async () => {
    const result = await resolveFixture(
      site(live("    searchIndex: ../data/dataset-index.json\n    searchResultLimit: 50\n")),
    );
    expect(result.diagnostics.errors).toEqual([]);
    const tree = treeOf(result);
    expect(tree.searchIndex).toMatchObject({ entries: 1, complete: true });
    expect(tree.searchIndex!.file).toMatch(/^_portal\/dataset-tree-index\.[A-Za-z0-9_-]{8}\.json$/);
    expect(tree.searchIndex!.url).toBe(`/${tree.searchIndex!.file}`);
    expect(tree.searchResultLimit).toBe(50);
    // Published, re-serialised from the parsed document.
    const bytes = result.contents.get(tree.searchIndex!.file);
    expect(bytes).toBeDefined();
    expect(JSON.parse(bytes!.toString("utf8"))).toEqual(INDEX);
  });

  it("refuses `searchIndex` beside a catalogue, and says why", async () => {
    const result = await resolveFixture(
      site(
        `  - type: dataset-tree\n    catalog: ../data/archive.json\n    searchIndex: ../data/dataset-index.json\n`,
      ),
    );
    const found = result.diagnostics.items.find((d) => d.pointer === "/blocks/1/searchIndex");
    expect(found?.code).toBe("FP1104");
    expect(found?.hint).toMatch(/snapshot is complete/);
    expect(result.model).toBeUndefined();
  });

  it("refuses `searchResultLimit` without an index", async () => {
    const result = await resolveFixture(site(live("    searchResultLimit: 50\n")));
    const found = result.diagnostics.items.find((d) => d.pointer === "/blocks/1/searchResultLimit");
    expect(found?.code).toBe("FP1104");
  });

  it.each([
    ["a URL instead of a path", "    searchIndex: https://example.org/index.json\n"],
    ["a number", "    searchIndex: 7\n"],
    ["a limit of zero", "    searchIndex: ../data/dataset-index.json\n    searchResultLimit: 0\n"],
    [
      "a limit past the bound",
      "    searchIndex: ../data/dataset-index.json\n    searchResultLimit: 5000\n",
    ],
  ])("the schema refuses %s", async (_, extra) => {
    const result = await resolveFixture(site(live(extra)));
    expect(result.model).toBeUndefined();
    expect(result.diagnostics.errors.length).toBeGreaterThan(0);
  });

  it("keeps the index inside the source root", async () => {
    const result = await resolveFixture(site(live("    searchIndex: ../../outside.json\n")));
    expect(result.model).toBeUndefined();
    expect(result.diagnostics.items.some((d) => d.pointer === "/blocks/1/searchIndex")).toBe(true);
  });

  it("changes nothing for a live block without one", async () => {
    const result = await resolveFixture(site(live()));
    expect(result.diagnostics.errors).toEqual([]);
    expect(treeOf(result).searchIndex).toBeUndefined();
    expect([...result.contents.keys()].some((f) => f.includes("dataset-tree-index."))).toBe(false);
  });
});

describe("a broken index is a diagnostic with a pointer", () => {
  const withIndex = (index: unknown, raw?: string) =>
    resolveFixture(site(live("    searchIndex: ../data/dataset-index.json\n"), index, raw));

  it("reports JSON that does not parse against the block", async () => {
    const result = await withIndex(null, "{ not json");
    const found = result.diagnostics.items.find((d) => d.code === "FP1101");
    expect(found?.pointer).toBe("/blocks/1/searchIndex");
    expect(found?.message).toContain("data/dataset-index.json");
  });

  it("reports what the package's validator rejects, pointing into the index file", async () => {
    const noComplete: Record<string, unknown> = { ...INDEX };
    delete noComplete.complete;
    const result = await withIndex(noComplete);
    const found = result.diagnostics.items.filter((d) => d.code === "FP1104");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.file).toBe("data/dataset-index.json");
    expect(found.some((d) => d.pointer === "/complete")).toBe(true);
  });

  it("reports duplicate entry ids", async () => {
    const entry = INDEX.entries[0]!;
    const result = await withIndex({ ...INDEX, entries: [entry, { ...entry }] });
    const found = result.diagnostics.items.filter((d) => d.code === "FP1104");
    expect(found.some((d) => d.pointer?.startsWith("/entries/1"))).toBe(true);
    expect(found.map((d) => d.message).join(" ")).toMatch(/duplicate|more than once|already/i);
  });

  it("summarises after twenty problems", async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      id: `x${i}`,
      kind: "nope",
      name: "n",
    }));
    const result = await withIndex({ ...INDEX, entries });
    const found = result.diagnostics.items.filter((d) => d.code === "FP1104");
    expect(found.length).toBe(21);
    expect(found.at(-1)?.message).toMatch(/further problems/);
  });

  it("refuses a file over the size cap before parsing it", () => {
    const root = tempRoot("portal-dt-index-big-");
    const path = write(root, "big.json", " ".repeat(MAX_SEARCH_INDEX_BYTES + 1));
    const bag = new DiagnosticBag();
    const loaded = loadDatasetTreeSearchIndex({
      absolute: path,
      relative: "big.json",
      declaredIn: "landings/home.yaml",
      pointer: "/blocks/1",
      basePath: "/",
      bag,
    });
    expect(loaded).toBeUndefined();
    expect(codes(bag.items)).toEqual(["FP1407"]);
    expect(bag.items[0]?.pointer).toBe("/blocks/1/searchIndex");
  });
});

describe("what the page gets", () => {
  it("names the index loader in the entry only when a block has an index", async () => {
    const withIt = (
      await resolveFixture(site(live("    searchIndex: ../data/dataset-index.json\n")))
    ).model!;
    const without = (await resolveFixture(site(live()))).model!;
    expect(projectRuntime(withIt).datasetTree).toMatchObject({ s3: true, searchIndex: true });
    expect(projectRuntime(without).datasetTree).toMatchObject({ s3: true, searchIndex: false });
    expect(generateEntryModule(withIt)).toContain("tree-search-index");
    expect(generateEntryModule(without)).not.toContain("tree-search-index");
  });
});

describe("the artifact", () => {
  it("publishes the index beside the pages: manifest, checksum, same origin", async () => {
    const out = join(tempRoot("portal-dt-index-build-"), "site");
    const result = await buildFixture(
      site(live("    searchIndex: ../data/dataset-index.json\n")),
      out,
    );
    expect(result.diagnostics.errors).toEqual([]);

    const index = readdirSync(join(out, "_portal")).filter((f) =>
      /^dataset-tree-index\.[\w-]{8}\.json$/.test(f),
    );
    expect(index).toHaveLength(1);
    const file = `_portal/${index[0]}`;
    expect(JSON.parse(readFileSync(join(out, file), "utf8"))).toEqual(INDEX);
    const manifest = JSON.parse(readFileSync(join(out, "portal-manifest.json"), "utf8"));
    expect(manifest.files.find((f: { path: string }) => f.path === file)).toMatchObject({
      mimeType: "application/json",
      cacheClass: "immutable",
    });
    expect(readFileSync(join(out, "checksums.sha256"), "utf8")).toContain(file);
    const inputs = JSON.parse(readFileSync(join(out, "input-manifest.json"), "utf8"));
    expect(JSON.stringify(inputs)).toContain("data/dataset-index.json");
    expect(verifyArtifact(out).errors).toEqual([]);

    // The page names the file; the island fetches it from this origin, which the policy already
    // allows. `connect-src` is the gateway and 'self', exactly as without an index.
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain(
      `data-portal-dataset-tree-search-index="/${file}"`,
    );
    const policy = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8"));
    expect(policy.csp.portal["connect-src"]).toBe(`'self' ${ENDPOINT}`);

    const evidence = result.evidence?.find((c) => c.id === "dataset-tree");
    expect(evidence?.modules).toContain("builder:client/components/tree-search-index.ts");
  }, 300_000);
});
