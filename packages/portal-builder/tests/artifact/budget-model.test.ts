// The size measurement, against a portal shaped like a deployment rather than like a unit test.
// There are no size ceilings: these check STRUCTURE - what a page fetches on load, what stays lazy
// and which feature a lazy chunk is charged to - which a byte count cannot say. The site here has two components, a documentation tree with prose, code and
// mathematics, a themed preset and a catalogue with thirty datasets, because that is the shape
// that finds those.
//
// It is NOT any particular deployment's configuration: calling a local fixture by a deployment's
// name is how a suite starts reporting somebody else's acceptance.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { writeConsumerSite } from "../helpers/consumer.js";
import { measureArtifact } from "../../src/artifact/budgets.js";
import type { BuildResult } from "../../src/artifact/index.js";

afterAll(cleanupFixtures);

interface Measured {
  out: string;
  result: BuildResult;
  report: ReturnType<typeof measureArtifact>;
}

async function build(
  options: Parameters<typeof writeConsumerSite>[0],
  prefix: string,
): Promise<Measured> {
  const root = writeConsumerSite(options);
  const out = join(tempRoot(prefix), "site");
  const result = await buildFixture(root, out);
  const report = measureArtifact({
    files: (result.files ?? []).map((f) => ({ path: f.path, bytes: f.bytes })),
    artifactDir: out,
    components: result.evidence ?? [],
    moduleBytes: {},
    preparedRoots: [],
    chunkEdges: result.graph?.chunks ?? [],
  });
  return { out, result, report };
}

/** Raw and gzipped bytes for one emitted asset, which is what a reader pays either way. */
function weigh(out: string, path: string): { raw: number; gz: number } {
  const bytes = readFileSync(join(out, ...path.split("/")));
  return { raw: bytes.length, gz: gzipSync(bytes, { level: 9 }).length };
}

describe("a consumer-shaped portal", () => {
  it("validates without Python", async () => {
    const { result, report } = await build({}, "portal-consumer-base-");
    expect(result.diagnostics.errors).toEqual([]);
    expect(report.pages[0]).toBeTruthy();
  }, 300_000);

  it("still validates with `dataset-tree.python` enabled", async () => {
    const { result } = await build({ python: true }, "portal-consumer-python-");
    expect(result.diagnostics.errors).toEqual([]);
  }, 300_000);

  it("adds nothing to the base page when Python is off - no asset, no request", async () => {
    const { report, out } = await build({}, "portal-consumer-off-");
    const python = report.eager
      .concat(report.lazy.map((f) => f.path))
      .filter((p) => /console|browser-python|python-playground|freva-term/.test(p));
    expect(python).toEqual([]);
    // …and the page's own markup carries no trace of it either.
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).not.toContain("data-portal-dataset-tree-python");
  }, 300_000);

  it("keeps every Python asset off the initial request set with `autostart: never`", async () => {
    // The claim the whole model rests on: a visitor who never presses the button downloads none of
    // it. Measured from the emitted HTML, the artifact's own statement of what it fetches on load
    // - `<script src>`, `<link rel=stylesheet>` and `<link rel=modulepreload>` together.
    const { report } = await build({ python: true, autostart: "never" }, "portal-consumer-lazy-");
    const eagerPython = report.eager.filter((p) =>
      /console|browser-python|python-playground|embed/.test(p),
    );
    expect(eagerPython).toEqual([]);

    const lazyPython = report.lazy.filter((f) => f.feature === "python-playground");
    expect(lazyPython.length).toBeGreaterThan(0);
    // The interpreter's Worker is one of them: emitted beside the graph, and charged all the same.
    expect(lazyPython.some((f) => f.path.includes("browser-python.worker"))).toBe(true);
  }, 300_000);

  it("measures the optional chunks rather than exempting them", async () => {
    const { report } = await build({ python: true }, "portal-consumer-measured-");
    const feature = report.features["python-playground"];
    expect(feature).toBeTruthy();
    expect(feature?.javascript ?? 0).toBeGreaterThan(300_000);
  }, 300_000);

  it("reports what each autostart mode actually transfers on load", async () => {
    // `autostart` decides WHEN the interpreter is fetched, not whether. `never` and
    // `after-interactive` both leave the initial request set alone - the second warms it once the
    // page is idle, a later request and not an eager one - while `immediately` is a deliberate
    // cost on every visitor, including the ones who never press anything. Asserted here on the
    // emitted artifact's initial request set; what each mode does at runtime is asserted in
    // `browser-tests/python-playground.mjs`, where there is a browser to watch.
    const table: Record<string, { eagerJs: number; eagerCss: number; lazyJs: number }> = {};
    for (const autostart of ["never", "after-interactive", "immediately"] as const) {
      const { report } = await build({ python: true, autostart }, `portal-consumer-${autostart}-`);
      const heaviest = report.pages[0];
      table[autostart] = {
        eagerJs: heaviest?.javascript ?? 0,
        eagerCss: heaviest?.css ?? 0,
        lazyJs: report.lazyTotals.javascript,
      };
      const eagerPython = report.eager.filter((p) =>
        /console|browser-python|python-playground|embed/.test(p),
      );
      expect(eagerPython, `${autostart} put a Python asset in the initial request set`).toEqual([]);
    }
    // The three modes emit the same artifact; only the runtime timing differs.
    expect(table["after-interactive"]).toEqual(table.never);
    expect(table.immediately).toEqual(table.never);
  }, 600_000);

  it("prints a per-asset breakdown, raw and gzipped", async () => {
    // Reported rather than asserted: a reader deciding whether a feature is worth its weight
    // needs the actual numbers, and gzip is what crosses the wire.
    const { out, report } = await build({ python: true }, "portal-consumer-table-");
    const rows: string[] = [];
    const heaviest = report.pages[0];
    for (const asset of heaviest?.assets ?? []) {
      const { raw, gz } = weigh(out, asset);
      rows.push(`  EAGER ${String(raw).padStart(8)} ${String(gz).padStart(7)}gz  ${asset}`);
    }
    for (const entry of report.lazy) {
      const { raw, gz } = weigh(out, entry.path);
      rows.push(
        `  lazy  ${String(raw).padStart(8)} ${String(gz).padStart(7)}gz  ${entry.path}` +
          (entry.feature ? `  [${entry.feature}]` : ""),
      );
    }
    console.log(`\nper-asset breakdown (${heaviest?.page})\n${rows.join("\n")}`);
    expect(rows.length).toBeGreaterThan(0);
  }, 300_000);
});

describe("the base page's own stylesheet weight", () => {
  it("is measured with no Python asset in it when Python is disabled", async () => {
    const { result, report } = await build({}, "portal-consumer-basecss-");
    expect(result.diagnostics.errors).toEqual([]);
    const heaviest = report.pages[0];
    expect(heaviest).toBeTruthy();
    const css = heaviest?.css ?? 0;

    // No Python asset is in the measurement at all, so this is the base page and nothing else.
    expect(report.eager.filter((p) => /console|browser-python|python-playground/.test(p))).toEqual(
      [],
    );
    console.log(`\nbase-page CSS: ${css} bytes`);
  }, 300_000);

  it("links no dataset-tree stylesheet from a page that has no tree", async () => {
    // The specific 22 KiB. A 404 document and a documentation page have no tree on them, but
    // there is one client entry for the whole site and Astro links the CSS of everything that
    // entry can reach.
    const { out } = await build({}, "portal-consumer-treecss-");
    for (const page of ["404.html", join("docs", "page-0", "index.html")]) {
      const html = readFileSync(join(out, page), "utf8");
      const links = [...html.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1] ?? "");
      for (const href of links) {
        const css = readFileSync(join(out, ...href.replace(/^\//, "").split("/")), "utf8");
        expect(
          css,
          `${page} links ${href}, which carries the tree package's stylesheet`,
        ).not.toContain(".dataset-tree__row");
      }
    }
  }, 300_000);

  it("charges the tree package's stylesheet to the pages that have a tree", async () => {
    // The bytes sit inside the island's own chunk - lazy, fetched by a page with a block on it -
    // so they are still measured rather than exempted.
    const { report } = await build({}, "portal-consumer-treelazy-");
    const treeChunks = report.lazy.filter((f) => /dataset-tree/.test(f.path));
    expect(treeChunks.length).toBeGreaterThan(0);
  }, 300_000);
});

describe("what 'eager' means", () => {
  it("counts the chunks the page's script statically imports, not only the ones it names", async () => {
    // Worth 380 KB. A page names ONE script whose `import` statements are fetched before a line of
    // it runs, so measuring the named file alone calls the rest of an eager graph lazy: a bundler
    // helper in the console chunk would make every page statically import jQuery, jQuery
    // Terminal, Prism and the console, reported as lazy. The rule is checked on a stated graph,
    // because the real consumer entry currently has no static imports and would test nothing.
    const dir = tempRoot("portal-eager-synthetic-");
    writeFileSync(
      join(dir, "index.html"),
      '<script type="module" src="/_portal/entry.js"></script>',
    );
    const synthetic = measureArtifact({
      files: [
        { path: "_portal/entry.js", bytes: 100 },
        { path: "_portal/helpers.js", bytes: 20 },
        { path: "_portal/console.js", bytes: 380_000 },
      ],
      artifactDir: dir,
      components: [],
      moduleBytes: {},
      preparedRoots: [],
      chunkEdges: [
        { file: "_portal/entry.js", imports: ["_portal/helpers.js"], dynamicImports: [] },
        { file: "_portal/helpers.js", imports: [], dynamicImports: ["_portal/console.js"] },
      ],
    });
    expect(synthetic.pages[0]?.javascript).toBe(120);
    expect(synthetic.eager).toEqual(["_portal/entry.js", "_portal/helpers.js"]);
    expect(synthetic.lazy.map((f) => f.path)).toEqual(["_portal/console.js"]);

    // …and on a real consumer build, none of what is eager is the interpreter, the console or
    // the Data Browser. Those are the properties the splits are for.
    const { report, result } = await build({ python: true }, "portal-consumer-eager-");
    const heaviest = report.pages[0];
    const named = (heaviest?.assets ?? []).filter((a) => a.endsWith(".js"));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((a) => /console|browser-python|python-playground/.test(a))).toEqual([]);
    const dataBrowser = (result.evidence ?? [])
      .filter((c) => c.kind === "databrowser")
      .flatMap((c) => c.chunks);
    const shared = new Set(
      (result.evidence ?? []).filter((c) => c.kind !== "databrowser").flatMap((c) => c.chunks),
    );
    // A chunk only the Data Browser claims is its island or its libraries; none is eager.
    expect(named.filter((a) => dataBrowser.includes(a) && !shared.has(a))).toEqual([]);
  }, 600_000);
});

// The combination a Waterpark deployment runs. Every fixture above browses a build-time
// CATALOGUE, and a catalogue does not reach the S3 adapter, the access recipes or the in-page data
// inspector. This fixture is shaped like that deployment: Data Browser, live dataset tree, the inspector the
// tree pulls in, and the Python playground on the profile that makes a recipe runnable.
describe("a Waterpark-shaped portal: Data Browser, a live tree, the inspector and Python", () => {
  // The configuration under test. The Data Browser is not a flag: `writeConsumerSite` always
  // enables it.
  const WATERPARK = { s3: true, python: true, profile: "xarray-zarr" } as const;

  /**
   * The inspector's emitted chunks, found by what is in them rather than by a hashed filename.
   * Restricted to LAZY chunks the Data Browser's own evidence does not claim: the Data Browser
   * ships its own inspector loader, which mentions the same custom element and fetches it from a
   * CDN at run time, in its own lazy chunk - its cost, not the tree's. What remains is the bundled
   * package and the loader module
   * that names it, and nothing else.
   */
  function inspectorChunks(
    out: string,
    report: ReturnType<typeof measureArtifact>,
    result: BuildResult,
  ): { path: string; bytes: number; feature: string | null }[] {
    const dataBrowser = new Set(
      (result.evidence ?? []).filter((c) => c.kind === "databrowser").flatMap((c) => c.chunks),
    );
    return report.lazy.filter(
      (file) =>
        file.path.endsWith(".js") &&
        !dataBrowser.has(file.path) &&
        readFileSync(join(out, ...file.path.split("/")), "utf8").includes("data-inspector"),
    );
  }

  it("builds the complete consumer configuration without errors", async () => {
    const { result } = await build(WATERPARK, "portal-waterpark-");
    expect(result.diagnostics.errors).toEqual([]);
  }, 240_000);

  it("keeps the inspector lazy: no page asks for it, so the base page does not pay for it", async () => {
    const { out, report, result } = await build(WATERPARK, "portal-waterpark-lazy-");
    const chunks = inspectorChunks(out, report, result);
    // The bundled package and the loader that names it.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The package itself, not just the loader: ~43 KB when this was measured.
    expect(Math.max(...chunks.map((c) => c.bytes))).toBeGreaterThan(40_000);

    // "Does not increase base-page JavaScript" as a checkable property rather than a comparison.
    // The inspector cannot be switched off independently - it is what Inspect opens, and every
    // store has one - so there is no second build to diff against. What CAN be checked is the
    // reason the base page is unaffected: the emitted HTML decides eager from lazy, and no page's
    // asset set names any of these files. Hoisting the inspector into a page's tags fails here.
    for (const chunk of chunks) {
      expect(report.eager).not.toContain(chunk.path);
      for (const page of report.pages) expect(page.assets).not.toContain(chunk.path);
    }
  }, 240_000);

  it("charges the inspector to the dataset tree rather than to nobody", async () => {
    const { out, report, result } = await build(WATERPARK, "portal-waterpark-attribution-");
    const chunks = inspectorChunks(out, report, result);
    // The point of the accounting. Without the tree's evidence plan owning the inspector and its
    // loader, these bytes are lazy, real and against nobody's name, and the tree's cost reads as
    // its island alone.
    for (const chunk of chunks) expect(chunk.feature).toBe("dataset-tree");

    const tree = report.features["dataset-tree"];
    expect(tree).toBeTruthy();
    const inspector = chunks.reduce((n, c) => n + c.bytes, 0);
    expect(tree?.javascript ?? 0).toBeGreaterThanOrEqual(inspector);
    // The island is in there too, so the feature is the tree's whole cost, not the inspector's.
    expect(tree?.javascript ?? 0).toBeGreaterThan(inspector + 40_000);
  }, 240_000);

  it("charges the console, the coordinator, the bridge and the Worker to the playground", async () => {
    const { result, report } = await build(WATERPARK, "portal-waterpark-python-");
    expect(result.diagnostics.errors).toEqual([]);
    const python = report.features["python-playground"];
    expect(python).toBeTruthy();
    // The Worker is emitted beside the graph, so this is only this large when it is counted too.
    expect(python?.javascript ?? 0).toBeGreaterThan(500_000);
  }, 240_000);
});
