// `consoleInPage`: with `playgroundOrigin` and the notebook, the console, the runnable snippets and
// the dataset trees' recipes run in the portal's own pages (editable, with run controls); the
// second origin serves the notebook alone.

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { hostPolicy } from "../../src/artifact/manifests.js";
import { projectRuntime } from "../../src/artifact/runtime-projection.js";
import { resolveModel } from "../../src/model/resolve.js";
import { cleanupFixtures } from "../helpers/fixture.js";
import { writeConsumerSite } from "../helpers/consumer.js";

afterAll(cleanupFixtures);

const ORIGIN = "https://py.example.org";

function site(extraYaml: string) {
  return writeConsumerSite({
    python: true,
    profile: "xarray-zarr",
    s3: true,
    playground: {
      profile: "xarray-zarr",
      playgroundOrigin: ORIGIN,
      editableSnippets: true,
      extraYaml,
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

const NOTEBOOK = "  notebook:\n    enabled: true\n";

describe("consoleInPage", () => {
  it("keeps the console in the pages and the notebook on its origin", async () => {
    const resolved = await resolve(site(`  consoleInPage: true\n${NOTEBOOK}`));
    expect(resolved.diagnostics.errors).toEqual([]);
    const codes = resolved.diagnostics.items.map((d) => d.code);
    // Editable snippets and recipes work: nothing is refused for a separate origin.
    expect(codes).not.toContain("FP1227");
    expect(
      resolved.diagnostics.items.filter(
        (d) => d.code === "FP1217" && d.message.includes("separate origin"),
      ),
    ).toEqual([]);
    const model = resolved.model!;
    expect(resolved.portalPlayground).toMatchObject({ notebook: true, notebookOrigin: ORIGIN });
    expect(resolved.portalPlayground?.playgroundOrigin).toBeUndefined();

    const route = model.routes.find((r) => r.python)!;
    expect(route.python?.playgroundOrigin).toBeUndefined();
    expect(route.python?.notebookOrigin).toBe(ORIGIN);
    expect(JSON.stringify(model)).toContain("data-portal-editable");

    const tree = model.landings.flatMap((l) => l.blocks).find((b) => b.datasetTree?.python)!
      .datasetTree!.python!;
    expect(tree.playgroundOrigin).toBeUndefined();
    expect(tree.recipes?.length).toBeGreaterThan(0);

    // The second origin is still built, for the notebook (and its seed notebooks).
    expect(model.playground?.origin).toBe(ORIGIN);
    expect(model.playground?.examples.length).toBeGreaterThan(0);
    // The pages load the interpreter themselves, under the portal's policy.
    expect(projectRuntime(model).pythonPlayground?.framed).toBe(false);
    const policy = hostPolicy({ model, evidence: {} as never, files: [], rstUsed: false }) as {
      csp: { portal: Record<string, string> };
    };
    expect(policy.csp.portal["script-src"]).toContain("'wasm-unsafe-eval'");
    expect(policy.csp.portal["worker-src"]).toContain("'self'");
  }, 120_000);

  it("without it, the same portal frames the console as before", async () => {
    const resolved = await resolve(site(NOTEBOOK));
    const model = resolved.model!;
    expect(resolved.diagnostics.items.map((d) => d.code)).toContain("FP1227");
    expect(model.routes.find((r) => r.python)?.python?.playgroundOrigin).toBe(ORIGIN);
    expect(projectRuntime(model).pythonPlayground?.framed).toBe(true);
    const tree = model.landings.flatMap((l) => l.blocks).find((b) => b.datasetTree?.python)!
      .datasetTree!.python!;
    expect(tree.recipes).toEqual([]);
  }, 120_000);

  it("without the notebook it changes nothing - the console stays framed - and says so (FP1238)", async () => {
    const resolved = await resolve(site("  consoleInPage: true\n"));
    const found = resolved.diagnostics.items.filter((d) => d.code === "FP1238");
    expect(found).toHaveLength(1);
    expect(found[0]?.pointer).toBe("/pythonPlayground/consoleInPage");
    // Visitor Python still runs on its own origin, never the portal's.
    expect(resolved.portalPlayground?.playgroundOrigin).toBe(ORIGIN);
    const model = resolved.model!;
    expect(model.routes.find((r) => r.python)?.python?.playgroundOrigin).toBe(ORIGIN);
    expect(projectRuntime(model).pythonPlayground?.framed).toBe(true);
  }, 120_000);
});
