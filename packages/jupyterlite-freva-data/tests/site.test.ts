// The build-time helper a site uses to carry the data panel: data file, digests, settings.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { TREE_RECIPES } from "@freva-org/dataset-tree/recipes";

import { parsePanelData } from "../src/panel-data.js";
import { DATA_PANEL_PLUGIN, buildPanelData, dataPanelSite } from "../src/site.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const s3 = {
  endpoint: "https://s3.example.org",
  origin: "https://s3.example.org",
  style: "path" as const,
  roots: [
    { name: "Reanalysis", bucket: "reanalysis" },
    { name: "Planned", bucket: "planned", planned: "coming soon" },
  ],
};

describe("buildPanelData", () => {
  it("registers the shared recipes with the digest of their template, runnable by packages", () => {
    const data = buildPanelData({ instanceId: "home", s3, packages: ["xarray", "zarr", "fsspec"] });
    expect(data.mode).toBe("s3");
    expect(data.statusLabel).toBe("LIVE");
    expect(data.recipes).toEqual([
      expect.objectContaining({
        id: "http",
        sha256: sha(TREE_RECIPES[0].template),
        runnable: true,
      }),
    ]);
    expect(parsePanelData(JSON.parse(JSON.stringify(data)))).toEqual(data);
    expect(buildPanelData({ instanceId: "h", s3, packages: [] }).recipes[0].runnable).toBe(false);
  });

  it("registers a catalogue's executable Python examples only", () => {
    const catalog = {
      roots: [
        {
          id: "a",
          examples: [
            { id: "py", language: "Python", code: "print(1)", executable: true },
            { id: "sh", language: "shell", code: "ls", executable: true },
            { id: "frag", language: "python", code: "x" },
          ],
          children: [
            { id: "b", examples: [{ id: "py", language: "py", code: "2", executable: true }] },
          ],
        },
      ],
    };
    const data = buildPanelData({ instanceId: "s", catalog, packages: [] });
    expect(data.examples).toEqual([
      { datasetId: "a", exampleId: "py", sha256: sha("print(1)") },
      { datasetId: "b", exampleId: "py", sha256: sha("2") },
    ]);
    expect(data.recipes).toEqual([]);
  });

  it("refuses both or neither source", () => {
    expect(() => buildPanelData({ instanceId: "x", s3, catalog: {}, packages: [] })).toThrow();
    expect(() => buildPanelData({ instanceId: "x", packages: [] })).toThrow();
  });
});

describe("dataPanelSite", () => {
  it("content-addresses the data file and names it in the settings", () => {
    const data = buildPanelData({ instanceId: "home", s3, packages: ["xarray", "zarr", "fsspec"] });
    const seed = {
      name: "examples/01_first_map.ipynb",
      text: JSON.stringify({ cells: [{ cell_type: "markdown", source: ["# A map\n"] }] }),
    };
    const site = dataPanelSite({ data, siteName: "Hub", seedNotebooks: [seed] });
    const text = `${JSON.stringify(data)}\n`;
    expect(site.files).toEqual([{ path: `freva-data/panel.${sha(text).slice(0, 12)}.json`, text }]);
    const settings = site.overrides[DATA_PANEL_PLUGIN];
    expect(settings).toMatchObject({
      siteName: "Hub",
      title: "Hub data",
      dataUrl: site.dataPath,
      dataSha256: sha(text),
      kernelName: "freva-python",
      defaultAction: "open-in-notebook",
      seedNotebooks: [{ path: "examples/01_first_map.ipynb", title: "A map" }],
      gridlook: false,
      launcher: { newNotebook: true, browse: true, examples: true, ask: false },
    });
  });

  it("refuses seed paths the panel would drop, and a start notebook that is not a seed", () => {
    const data = buildPanelData({ instanceId: "home", s3, packages: [] });
    expect(() =>
      dataPanelSite({ data, siteName: "x", seedNotebooks: [{ name: "../x.ipynb", text: "{}" }] }),
    ).toThrow();
    expect(() => dataPanelSite({ data, siteName: "x", startNotebook: "a.ipynb" })).toThrow();
  });
});
