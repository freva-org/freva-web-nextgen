// The budget model, against a portal shaped like a deployment rather than like a unit test.
//
// Every other budget fixture in the suite is minimal, and a minimal fixture sits comfortably under
// a budget a real consumer exceeds - a dataset-tree stylesheet and the Python playground's chunks
// have each done it. The site here has two components, a documentation tree with prose, code and
// mathematics, a themed preset and a catalogue with thirty datasets, because that is the shape
// that finds those.
//
// It is NOT any particular deployment's configuration: calling a local fixture by a deployment's
// name is how a suite starts reporting somebody else's acceptance.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { writeConsumerSite } from "../helpers/consumer.js";
import { loadBudgets, measureArtifact } from "../../src/artifact/budgets.js";
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
  it("validates without Python, inside the base-page budget", async () => {
    const { result, report } = await build({}, "portal-consumer-base-");
    expect(result.diagnostics.errors).toEqual([]);
    const budgets = loadBudgets();
    const heaviest = report.pages[0];
    expect(heaviest).toBeTruthy();
    expect(heaviest?.javascript ?? 0).toBeLessThanOrEqual(budgets.basePage.javascript);
    expect(heaviest?.css ?? 0).toBeLessThanOrEqual(budgets.basePage.css);
  }, 300_000);

  it("still validates with `dataset-tree.python` enabled", async () => {
    // One number over every emitted file would fail the build here by a quarter of a megabyte of
    // code no visitor fetches unless they press a button.
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
    const budgets = loadBudgets();
    const feature = report.features["python-playground"];
    expect(feature).toBeTruthy();
    expect(feature?.javascript ?? 0).toBeGreaterThan(300_000);
    expect(feature?.javascript ?? 0).toBeLessThanOrEqual(
      budgets.lazy.features["python-playground"]?.javascript ?? 0,
    );
    expect(report.lazyTotals.javascript).toBeLessThanOrEqual(budgets.lazy.javascript);
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
    // Reported rather than asserted. A budget says "not more than"; a reader deciding whether a
    // feature is worth its weight needs the actual numbers, and gzip is what crosses the wire.
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

// A base page can exceed the CSS budget with Python DISABLED - a real consumer measured 123,890
// against 122,880 - and the optional-feature split does not address that, because none of those
// bytes are the playground's. The growth is in unconditional stylesheets: +14,873 in the shell's
// own and +7,356 in the dataset-tree block wrapper, 22,229 together.
//
// Asserted here as the shape of that failure rather than a deployment's exact number, which this
// suite cannot know: base-page CSS measured with no Python near it, inside the reviewed ceiling,
// and - the part that keeps this honest - with real headroom rather than a ceiling moved to just
// above whatever the build happened to emit.
const RETIRED_CSS_CEILING = 122_880;

describe("the base page's own stylesheet weight", () => {
  it("is inside the reviewed base-page CSS budget with Python disabled", async () => {
    const { result, report } = await build({}, "portal-consumer-basecss-");
    expect(result.diagnostics.errors).toEqual([]);
    const budgets = loadBudgets();
    const heaviest = report.pages[0];
    expect(heaviest).toBeTruthy();
    const css = heaviest?.css ?? 0;

    // No Python asset is in the measurement at all, so this is the base page and nothing else.
    expect(report.eager.filter((p) => /console|browser-python|python-playground/.test(p))).toEqual(
      [],
    );
    expect(css).toBeLessThanOrEqual(budgets.basePage.css);

    // The reduction has to do the work, not the revised ceiling. The tree package's stylesheet is
    // not linked from the head, and it alone is larger than the headroom the revision added, so
    // its return fails here rather than in a deployment.
    expect(
      css,
      `base CSS ${css} no longer clears the retired ${RETIRED_CSS_CEILING} ceiling: the eager ` +
        `stylesheets have grown back. Reduce them rather than raising the budget again.`,
    ).toBeLessThanOrEqual(RETIRED_CSS_CEILING);

    console.log(
      `\nbase-page CSS: ${css} measured, ${budgets.basePage.css} allowed ` +
        `(retired ceiling ${RETIRED_CSS_CEILING})`,
    );
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
    // so they are still measured rather than exempted, which is the point of the model.
    const { report } = await build({}, "portal-consumer-treelazy-");
    const treeChunks = report.lazy.filter((f) => /dataset-tree/.test(f.path));
    expect(treeChunks.length).toBeGreaterThan(0);
    expect(report.lazyTotals.javascript).toBeLessThanOrEqual(loadBudgets().lazy.javascript);
  }, 300_000);
});

describe("what 'eager' means", () => {
  it("counts the chunks the page's script statically imports, not only the ones it names", async () => {
    // Worth 380 KB. A page names ONE script, and that script begins with `import` statements the
    // browser fetches before a line of it runs, so measuring the named file alone measures the
    // first file of an eager graph and calls the rest lazy. A bundler helper module landing in
    // the interpreter's console chunk makes every page statically import jQuery, jQuery Terminal,
    // Prism and the whole console, all reported as a lazy chunk nobody asked for.
    const { report } = await build({ python: true }, "portal-consumer-eager-");
    const heaviest = report.pages[0];
    const named = new Set((heaviest?.assets ?? []).filter((a) => a.endsWith(".js")).map((a) => a));
    expect(named.size).toBeGreaterThan(0);

    // Something is eager that the HTML does not name: the entry's own static imports.
    const html = readFileSync(
      join((await build({ python: true }, "portal-consumer-eager2-")).out, "index.html"),
      "utf8",
    );
    const inHtml = new Set(
      [...html.matchAll(/(?:src|href)\s*=\s*"[^"]*?(_portal\/[^"]+\.js)"/g)].map((m) => m[1] ?? ""),
    );
    expect([...named].some((a) => !inHtml.has(a))).toBe(true);

    // …and none of what is eager is the interpreter. That is the property the split is for.
    expect([...named].filter((a) => /console|browser-python|python-playground/.test(a))).toEqual(
      [],
    );
  }, 600_000);
});

// The combination a Waterpark deployment runs, which is the one that crosses the ceiling. Every
// fixture above browses a build-time CATALOGUE, and a catalogue does not reach the S3 adapter,
// the access recipes or the in-page data inspector - so those measure a portal nobody deploys and
// pass, while a consumer with the Data Browser and a LIVE tree fails `FP1407` at 936,720 bytes.
// This fixture is shaped like that deployment: Data Browser, live dataset tree, the inspector the
// tree pulls in, and the Python playground on the profile that makes a recipe runnable.
describe("a Waterpark-shaped portal: Data Browser, a live tree, the inspector and Python", () => {
  // The configuration under test. The Data Browser is not a flag: `writeConsumerSite` always
  // enables it, which is what makes this the combination that crosses the ceiling rather than a
  // tree on its own.
  const WATERPARK = { s3: true, python: true, profile: "xarray-zarr" } as const;

  /**
   * The inspector's emitted chunks, found by what is in them rather than by a hashed filename.
   * Restricted to LAZY chunks: the Data Browser ships an inspector loader of its own that mentions
   * the same custom element and fetches it from a CDN at run time, and that code is in the eager
   * shell. Searching only what no page asks for finds the bundled package and the loader module
   * that names it, and nothing else.
   */
  function inspectorChunks(
    out: string,
    report: ReturnType<typeof measureArtifact>,
  ): { path: string; bytes: number; feature: string | null }[] {
    return report.lazy.filter(
      (file) =>
        file.path.endsWith(".js") &&
        readFileSync(join(out, ...file.path.split("/")), "utf8").includes("data-inspector"),
    );
  }

  it("passes every reviewed ceiling in the complete consumer configuration", async () => {
    const { result, report } = await build(WATERPARK, "portal-waterpark-");
    // The BUILD's own verdict, not a re-implementation of it: `buildFixture` runs the real
    // `checkBudgets` over the real evidence and chunk graph, so an empty error list is the gate
    // passing rather than this test agreeing with itself.
    expect(result.diagnostics.errors).toEqual([]);

    const budgets = loadBudgets();
    expect(report.lazyTotals.javascript).toBeLessThanOrEqual(budgets.lazy.javascript);
    // Two-sided, like every other budget assertion here: a ceiling a fixture uses a third of
    // describes nothing, and would let the next feature through unnoticed.
    expect(report.lazyTotals.javascript).toBeGreaterThan(budgets.lazy.javascript * 0.5);
    expect(report.pages[0]?.javascript ?? 0).toBeLessThanOrEqual(budgets.basePage.javascript);
    expect(report.pages[0]?.css ?? 0).toBeLessThanOrEqual(budgets.basePage.css);
  }, 240_000);

  it("keeps the inspector lazy: no page asks for it, so the base page does not pay for it", async () => {
    const { out, report } = await build(WATERPARK, "portal-waterpark-lazy-");
    const chunks = inspectorChunks(out, report);
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
    const { out, report } = await build(WATERPARK, "portal-waterpark-attribution-");
    const chunks = inspectorChunks(out, report);
    // The point of the accounting. Without the tree's evidence plan owning the inspector and its
    // loader, these bytes are lazy, real and against nobody's name: the tree's cost reads as its
    // island alone and the inspector surfaces only when an aggregate ceiling fails in a
    // consumer's build. Unattributed lazy bytes are the exemption this model exists to refuse,
    // and "it is only 43 KB" is how the console's 269 KB of libraries get in.
    for (const chunk of chunks) expect(chunk.feature).toBe("dataset-tree");

    const tree = report.features["dataset-tree"];
    expect(tree).toBeTruthy();
    const inspector = chunks.reduce((n, c) => n + c.bytes, 0);
    expect(tree?.javascript ?? 0).toBeGreaterThanOrEqual(inspector);
    // The island is in there too, so the feature is the tree's whole cost, not the inspector's.
    expect(tree?.javascript ?? 0).toBeGreaterThan(inspector + 40_000);
  }, 240_000);

  it("still enforces the Python playground's own ceiling", async () => {
    const { result, report } = await build(WATERPARK, "portal-waterpark-python-");
    expect(result.diagnostics.errors).toEqual([]);

    const budgets = loadBudgets();
    // The per-feature ceiling is stated separately so growth in one optional feature cannot be
    // paid for out of another's headroom - which is what raising the AGGREGATE ceiling for the
    // inspector would do. Asserted as a literal, because a test that read the number it checks
    // would pass whatever that number became. See schema/budgets.json for the measurement behind
    // 688,128 and the shape it was measured in. A Waterpark-shaped build is not that shape: its
    // Data Browser claims the console's shared chunks first, and it stays well under.
    expect(budgets.lazy.features["python-playground"]?.javascript).toBe(688128);
    const python = report.features["python-playground"];
    expect(python).toBeTruthy();
    // The console, the coordinator, the bridge AND the Worker the bundler emits beside the graph.
    expect(python?.javascript ?? 0).toBeGreaterThan(500_000);
    expect(python?.javascript ?? 0).toBeLessThanOrEqual(
      budgets.lazy.features["python-playground"]!.javascript,
    );
  }, 240_000);

  it("leaves the base-page ceilings exactly where they were", () => {
    // The lazy accommodation is for ONE lazy feature: a raised lazy ceiling arriving with a
    // raised base-page ceiling is a different and much worse change.
    const budgets = loadBudgets();
    expect(budgets.basePage.javascript).toBe(786432);
    expect(budgets.basePage.css).toBe(131072);
    expect(budgets.lazy.css).toBe(16384);
  });
});
