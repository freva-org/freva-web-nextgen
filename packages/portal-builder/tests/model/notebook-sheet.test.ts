import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures } from "../helpers/fixture.js";
import { writeConsumerSite } from "../helpers/consumer.js";
import { resolveModel } from "../../src/model/resolve.js";
import { hostPolicy } from "../../src/artifact/manifests.js";
import { notebookUrl } from "../../client/components/notebook-url.js";

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
});
