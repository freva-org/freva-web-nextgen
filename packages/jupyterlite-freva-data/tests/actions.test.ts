import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ExampleIndex,
  askFor,
  bindStore,
  notebookBaseName,
  notebookFor,
  renderRecipe,
  sha256Hex,
} from "../src/actions.js";
import { parsePanelData, type PanelData } from "../src/panel-data.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const GOOD = 'import xarray as xr\nds = xr.open_zarr("https://s3.example.org/bucket/t2m.zarr")\nds';
const TEMPLATE = 'import xarray as xr\nds = xr.open_zarr("{{STORE}}")\nds';

const node = {
  id: "t2m",
  kind: "dataset" as const,
  name: "t2m.zarr",
  title: "Near-surface air temperature",
  inspect: "https://s3.example.org/bucket/t2m.zarr",
  description: "Hourly 2 m temperature",
  metrics: [{ label: "grid", value: "0.25°" }],
};

function snapshot(examples: object[], registered: PanelData["examples"]): PanelData {
  return parsePanelData({
    schemaVersion: 1,
    instanceId: "data-0",
    mode: "snapshot",
    catalog: {
      schemaVersion: 1,
      roots: [{ id: "root", kind: "collection", name: "root", children: [{ ...node, examples }] }],
    },
    expand: [],
    statusLabel: "SNAPSHOT",
    examples: registered,
    recipes: [],
  });
}

describe("eligibility", () => {
  const python = { id: "py", label: "xarray", language: "python", code: GOOD, executable: true };

  it("admits only executable Python whose bytes match the registered digest", async () => {
    const data = snapshot(
      [
        python,
        { id: "shell", label: "shell", language: "shell", code: "ls", executable: true },
        { id: "notexec", label: "partial", language: "python", code: "ds.t2m", executable: false },
        {
          id: "placeholder",
          label: "template",
          language: "python",
          code: 'xr.open_zarr("<YOUR_STORE>")',
          executable: true,
        },
        {
          id: "tampered",
          label: "tampered",
          language: "python",
          code: "print('changed')",
          executable: true,
        },
        {
          id: "unregistered",
          label: "unregistered",
          language: "python",
          code: "print(1)",
          executable: true,
        },
      ],
      [
        { datasetId: "t2m", exampleId: "py", sha256: sha(GOOD) },
        { datasetId: "t2m", exampleId: "shell", sha256: sha("ls") },
        { datasetId: "t2m", exampleId: "notexec", sha256: sha("ds.t2m") },
        { datasetId: "t2m", exampleId: "placeholder", sha256: sha('xr.open_zarr("<YOUR_STORE>")') },
        { datasetId: "t2m", exampleId: "tampered", sha256: sha("print('original')") },
      ],
    );
    const index = new ExampleIndex(data);
    expect(index.accessExamples(node).map((e) => e.id)).toHaveLength(6);
    const eligible = await index.eligibleSnippets(node);
    expect(eligible.map((s) => s.label)).toEqual(["xarray"]);
    expect(index.pythonExamples(node).map((e) => e.label)).toEqual([
      "xarray",
      "partial",
      "template",
      "tampered",
      "unregistered",
    ]);
  });

  it("verifies a live recipe by its template and binds only stores under the declared roots", async () => {
    const data = parsePanelData({
      schemaVersion: 1,
      instanceId: "live-0",
      mode: "s3",
      s3: {
        endpoint: "https://s3.example.org",
        origin: "https://s3.example.org",
        style: "path",
        roots: [{ name: "Archive", bucket: "bucket", prefix: "data/" }],
      },
      expand: [],
      statusLabel: "LIVE",
      examples: [],
      recipes: [
        {
          id: "xarray",
          label: "xarray",
          template: TEMPLATE,
          parameter: "https-url",
          sha256: sha(TEMPLATE),
          runnable: true,
        },
        {
          id: "nope",
          label: "missing pkg",
          template: TEMPLATE,
          parameter: "https-url",
          sha256: sha(TEMPLATE),
          runnable: false,
        },
        {
          id: "bad",
          label: "bad digest",
          template: TEMPLATE,
          parameter: "https-url",
          sha256: sha("x"),
          runnable: true,
        },
      ],
    });
    const index = new ExampleIndex(data);
    const store = {
      id: "s3://bucket/data/t.zarr/",
      kind: "dataset" as const,
      name: "t.zarr",
      path: "s3://bucket/data/t.zarr/",
    };
    const eligible = await index.eligibleSnippets(store);
    expect(eligible).toEqual([
      {
        label: "xarray",
        code: 'import xarray as xr\nds = xr.open_zarr("https://s3.example.org/bucket/data/t.zarr/")\nds',
      },
    ]);
    expect(index.url(store)).toBe("https://s3.example.org/bucket/data/t.zarr/");
    expect(await index.eligibleSnippets({ ...store, path: "s3://other/data/t.zarr/" })).toEqual([]);
    expect(bindStore('s3://bucket/data/x".zarr', data.s3!)).toBeNull();
    expect(bindStore("s3://bucket/data/../secret/", data.s3!)).toBeNull();
  });

  it("fills a hole literally, whatever the store name holds (`$&`, `$'`, quotes)", () => {
    const s3 = {
      endpoint: "https://s3.example.org",
      style: "path" as const,
      roots: [{ name: "Archive", bucket: "bucket", prefix: "data/" }],
    };
    const binding = bindStore("s3://bucket/data/a$&b$'c$$d.zarr/", s3)!;
    expect(binding).not.toBeNull();
    const recipe = { template: TEMPLATE, parameter: "https-url" } as never;
    expect(renderRecipe(recipe, binding, s3.endpoint)).toBe(
      'import xarray as xr\nds = xr.open_zarr("https://s3.example.org/bucket/data/a$&b$\\\'c$$d.zarr/")\nds',
    );
  });

  it("hashes like the build", async () => {
    expect(await sha256Hex("€ x")).toBe(sha("€ x"));
  });
});

describe("notebook and question", () => {
  it("builds a Freva Python notebook with a header naming the dataset", () => {
    const nb = notebookFor(node, [{ label: "xarray", code: `${GOOD}\n\n` }], {
      url: node.inspect,
      siteName: "nextGEMS",
      kernelName: "freva-python",
      kernelDisplayName: "Freva Python",
    }) as {
      cells: Array<{ cell_type: string; source: string }>;
      metadata: { kernelspec: { name: string } };
    };
    expect(nb.metadata.kernelspec.name).toBe("freva-python");
    expect(nb.cells[0]!.cell_type).toBe("markdown");
    expect(nb.cells[0]!.source).toContain("# t2m.zarr");
    expect(nb.cells[0]!.source).toContain("Near-surface air temperature");
    expect(nb.cells[1]).toMatchObject({ cell_type: "code", source: GOOD });
    expect(notebookBaseName(node)).toBe("t2m");
  });

  it("asks ClimateClaw with the URL and a metadata summary", () => {
    const { prompt, context } = askFor(node, node.inspect, "nextGEMS");
    expect(prompt).toContain("nextGEMS");
    expect(context).toContain("Dataset: t2m.zarr");
    expect(context).toContain("URL: https://s3.example.org/bucket/t2m.zarr");
    expect(context).toContain("grid: 0.25°");
  });
});

describe("panel data", () => {
  it("refuses unknown versions and malformed sources, drops bad digests", () => {
    expect(() => parsePanelData({ schemaVersion: 2 })).toThrow("version");
    expect(() =>
      parsePanelData({ schemaVersion: 1, mode: "s3", s3: { endpoint: "ftp://x", roots: [] } }),
    ).toThrow("http(s)");
    const data = parsePanelData({
      schemaVersion: 1,
      mode: "snapshot",
      catalog: {},
      examples: [{ datasetId: "a", exampleId: "b", sha256: "XYZ" }],
      searchIndex: "../../etc/passwd",
    });
    expect(data.examples).toEqual([]);
    expect(data.searchIndex).toBeUndefined();
  });
});
