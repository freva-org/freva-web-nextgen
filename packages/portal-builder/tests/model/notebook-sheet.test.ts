import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures } from "../helpers/fixture.js";
import { writeConsumerSite } from "../helpers/consumer.js";
import { resolveModel } from "../../src/model/resolve.js";
import { hostPolicy } from "../../src/artifact/manifests.js";
import { notebookRequestFor, notebookUrl } from "@freva-org/browser-python/ui/notebook";
import { projectRuntime, generateEntryModule } from "../../src/artifact/runtime-projection.js";

afterAll(cleanupFixtures);

const ORIGIN = "https://py.example.org";

function site(notebook: string, options: { origin?: string; secondBlock?: boolean } = {}) {
  return writeConsumerSite({
    python: true,
    ...(options.origin ? { playgroundOrigin: options.origin } : {}),
    ...(options.secondBlock ? { secondBlock: true } : {}),
    playground: {
      profile: "xarray-zarr",
      ...(options.origin ? { playgroundOrigin: options.origin } : { extraYaml: "" }),
      extraYaml:
        (options.origin ? "" : "  consoleInPage: true\n") +
        `  notebook:\n    enabled: true\n${notebook}`,
    },
    runnableDocs: true,
  });
}

const resolve = (root: string) =>
  resolveModel({
    sourceRoot: root,
    configPath: join(root, "portal.yaml"),
    release: false,
    skipNotebook: true,
  });

const trees = (model: NonNullable<Awaited<ReturnType<typeof resolve>>["model"]>) =>
  model.landings
    .flatMap((landing) => landing.blocks)
    .flatMap((b) => (b.datasetTree ? [b.datasetTree] : []));

describe("the dataset tree's notebook buttons", () => {
  it("open the same-origin notebook in a sheet, with a dataset only on the data panel's tree", async () => {
    const resolved = await resolve(
      site("    deployment: same-origin\n    dataPanel:\n      tree: home-2\n", {
        secondBlock: true,
      }),
    );
    expect(resolved.diagnostics.errors).toEqual([]);
    const [panelTree, other] = trees(resolved.model!);
    expect(panelTree!.notebook).toEqual({
      href: "/notebook/lab/index.html",
      frame: true,
      datasets: true,
      panel: true,
    });
    expect(other!.notebook).toEqual({
      href: "/notebook/lab/index.html",
      frame: true,
      datasets: false,
      panel: true,
    });
    const policy = hostPolicy({
      model: resolved.model!,
      evidence: [],
      files: [],
      inlineScriptHashes: [],
      inlineStyleHashes: [],
      mathUsed: false,
      rstUsed: false,
    } as never) as { csp: { portal: Record<string, string> } };
    expect(policy.csp.portal["frame-src"]).toContain("'self'");
  });

  it("ask for the data panel only when the notebook has one", async () => {
    const resolved = await resolve(
      site(
        "    deployment: same-origin\n    assistant:\n      climateclaw:\n" +
          "        host: https://freva.example.org\n        defaultModel: gpt-test\n",
      ),
    );
    expect(resolved.diagnostics.errors).toEqual([]);
    const [tree] = trees(resolved.model!);
    expect(tree!.notebook).toEqual({
      href: "/notebook/lab/index.html",
      frame: true,
      datasets: false,
      panel: false,
    });
  });

  it("open a notebook on its own origin in a new tab, never framed", async () => {
    const resolved = await resolve(site("", { origin: ORIGIN }));
    expect(resolved.diagnostics.errors).toEqual([]);
    const [tree] = trees(resolved.model!);
    expect(tree!.notebook).toEqual({
      href: `${ORIGIN}/notebook/tree/index.html`,
      frame: false,
      datasets: false,
      panel: false,
    });
  });

  it("are absent without a notebook", async () => {
    const root = writeConsumerSite({
      python: true,
      playground: { profile: "minimal" },
      runnableDocs: true,
    });
    const resolved = await resolve(root);
    expect(trees(resolved.model!).every((tree) => tree.notebook === undefined)).toBe(true);
  });

  it("address the notebook in the page's theme, with the dataset when one is asked for", () => {
    const base = "https://p.example/showroom/";
    expect(notebookUrl("/showroom/notebook/lab/index.html", base, { theme: "dark" })).toBe(
      "https://p.example/showroom/notebook/lab/index.html?theme=dark",
    );
    expect(
      notebookUrl("/showroom/notebook/lab/index.html", base, {
        theme: "light",
        dataset: "s3://eerie/b/x.zarr/",
      }),
    ).toBe(
      "https://p.example/showroom/notebook/lab/index.html?theme=light&dataset=s3%3A%2F%2Feerie%2Fb%2Fx.zarr%2F",
    );
  });

  it("address an example notebook when a page asks for one", () => {
    expect(
      notebookUrl("/notebook/lab/index.html", "https://p.example/", {
        example: "examples/01_map.ipynb",
      }),
    ).toBe("https://p.example/notebook/lab/index.html?example=examples%2F01_map.ipynb");
  });
});

const SEED = JSON.stringify({
  cells: [{ cell_type: "markdown", metadata: {}, source: ["# A map\n"] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

function withSeeds(seeds: string) {
  const root = site(`    deployment: same-origin\n    dataPanel:\n      tree: home-2\n${seeds}`);
  mkdirSync(join(root, "notebooks"), { recursive: true });
  writeFileSync(join(root, "notebooks", "map.ipynb"), SEED);
  writeFileSync(join(root, "notebooks", "mean.ipynb"), SEED);
  return root;
}

describe("a documentation page's example notebook", () => {
  it("is offered on the page a seed notebook names, as the Lab asked to open it", async () => {
    const resolved = await resolve(
      withSeeds(
        "      seedNotebooks:\n" +
          "        - path: ./notebooks/map.ipynb\n" +
          "          page: /docs/page-1/\n" +
          "        - ./notebooks/mean.ipynb\n",
      ),
    );
    expect(resolved.diagnostics.errors).toEqual([]);
    const routes = resolved.model!.routes.filter((route) => route.notebook);
    expect(routes.map((route) => [route.path, route.notebook])).toEqual([
      [
        "/docs/page-1/",
        { href: "/notebook/lab/index.html?example=examples%2Fmap.ipynb", external: false },
      ],
    ]);
    expect(resolved.portalPlayground!.notebookDataPanel!.seedNotebooks).toEqual([
      "./notebooks/map.ipynb",
      "./notebooks/mean.ipynb",
    ]);
  });

  it("must name a page the portal has, and one page only once", async () => {
    const missing = await resolve(
      withSeeds(
        "      seedNotebooks:\n" +
          "        - path: ./notebooks/map.ipynb\n" +
          "          page: /docs/nowhere/\n",
      ),
    );
    expect(missing.diagnostics.errors.map((d) => [d.code, d.pointer])).toEqual([
      ["FP1237", "/pythonPlayground/notebook/dataPanel/seedNotebooks/0/page"],
    ]);
    const twice = await resolve(
      withSeeds(
        "      seedNotebooks:\n" +
          "        - path: ./notebooks/map.ipynb\n" +
          "          page: /docs/page-1/\n" +
          "        - path: ./notebooks/mean.ipynb\n" +
          "          page: /docs/page-1/\n",
      ),
    );
    expect(twice.diagnostics.errors.map((d) => [d.code, d.pointer])).toEqual([
      ["FP1237", "/pythonPlayground/notebook/dataPanel/seedNotebooks/1/page"],
    ]);
  });

  it("must have a name the notebook lists among its examples", async () => {
    for (const name of ["mean+std.ipynb", "küsten.ipynb", "a..b.ipynb"]) {
      const root = withSeeds(
        "      seedNotebooks:\n" +
          `        - path: ./notebooks/${name}\n` +
          "          page: /docs/page-1/\n",
      );
      writeFileSync(join(root, "notebooks", name), SEED);
      const resolved = await resolve(root);
      expect(resolved.diagnostics.errors.map((d) => [d.code, d.pointer])).toEqual([
        ["FP1237", "/pythonPlayground/notebook/dataPanel/seedNotebooks/0"],
      ]);
    }
    const plain = withSeeds(
      "      seedNotebooks:\n" +
        "        - path: ./notebooks/mean std-v1.0.ipynb\n" +
        "          page: /docs/page-1/\n",
    );
    writeFileSync(join(plain, "notebooks", "mean std-v1.0.ipynb"), SEED);
    expect((await resolve(plain)).diagnostics.errors).toEqual([]);
  });
});

describe("links to the notebook", () => {
  it("open in a sheet on the page only when the notebook is on the portal's origin", async () => {
    const same = await resolve(
      site("    deployment: same-origin\n    dataPanel:\n      tree: home-2\n"),
    );
    expect(projectRuntime(same.model!).notebookLinks).toEqual({ href: "/notebook/lab/index.html" });
    expect(generateEntryModule(same.model!)).toContain(
      "initNotebookLinks(RUNTIME.notebookLinks.href)",
    );
    const other = await resolve(site("", { origin: ORIGIN }));
    expect(projectRuntime(other.model!).notebookLinks).toBeUndefined();
    expect(generateEntryModule(other.model!)).not.toContain("notebook-links");
  });

  it("may be a header tab, which stays in the tab for a same-origin notebook", async () => {
    const tab = "    - label: Notebook\n      notebook: lab\n";
    const withTab = (root: string) => {
      const config = join(root, "portal.yaml");
      writeFileSync(
        config,
        readFileSync(config, "utf8").replace("      label: Data\n", `      label: Data\n${tab}`),
      );
      return root;
    };
    const same = await resolve(
      withTab(site("    deployment: same-origin\n    dataPanel:\n      tree: home-2\n")),
    );
    expect(same.diagnostics.errors).toEqual([]);
    expect(same.model!.navigation.header.find((link) => link.label === "Notebook")).toMatchObject({
      href: "/notebook/lab/index.html",
      external: false,
    });
    const other = await resolve(withTab(site("", { origin: ORIGIN })));
    expect(other.diagnostics.errors.map((d) => d.code)).toEqual(["FP1201"]);
  });

  it("are recognised by their address, with the example a page asked for", () => {
    const lab = "https://p.example/showroom/notebook/lab/index.html";
    expect(notebookRequestFor(lab, lab)).toEqual({});
    expect(notebookRequestFor(`${lab}?example=examples%2Fmap.ipynb`, lab)).toEqual({
      example: "examples/map.ipynb",
    });
    expect(
      notebookRequestFor("https://p.example/showroom/notebook/tree/index.html", lab),
    ).toBeNull();
    expect(
      notebookRequestFor("https://other.example/showroom/notebook/lab/index.html", lab),
    ).toBeNull();
    expect(notebookRequestFor("https://p.example/showroom/docs/", lab)).toBeNull();
    expect(
      notebookRequestFor(`${lab}?dataset=s3%3A%2F%2Feerie%2Fx.zarr%2F&panel=data&theme=dark`, lab),
    ).toEqual({ dataset: "s3://eerie/x.zarr/", panel: true });
    expect(notebookRequestFor(`${lab}?path=examples%2Fmap.ipynb`, lab)).toBeNull();
    expect(notebookRequestFor(`${lab}?example=examples%2Fmap.ipynb&reset`, lab)).toBeNull();
    expect(notebookRequestFor(`${lab}#cell-3`, lab)).toBeNull();
    expect(notebookRequestFor(`${lab}?panel=climateclaw`, lab)).toBeNull();
  });

  it("to the file browser keep a new tab when the sheet holds the Lab", async () => {
    const tab = "    - label: Files\n      notebook: files\n";
    const root = site("    deployment: same-origin\n    dataPanel:\n      tree: home-2\n");
    const config = join(root, "portal.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace("      label: Data\n", `      label: Data\n${tab}`),
    );
    const resolved = await resolve(root);
    expect(resolved.diagnostics.errors).toEqual([]);
    expect(resolved.model!.navigation.header.find((link) => link.label === "Files")).toMatchObject({
      href: "/notebook/tree/index.html",
      external: true,
    });
  });
});
