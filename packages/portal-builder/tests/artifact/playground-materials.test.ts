// The second origin serves the Python materials this build carries: its interpreters - a framed
// console, the notebook's kernel - ask for add-ons and wheels at a root-relative path, on THAT
// origin. Missing from its file list, every add-on is a 404 there.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { describePlaygroundDeployment } from "../../src/artifact/playground-deploy.js";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";

afterAll(cleanupFixtures);

describe("the second origin's files", () => {
  it("include the add-ons and wheels the build serves", () => {
    const dir = tempRoot("materials");
    mkdirSync(join(dir, "playground-origin"), { recursive: true });
    writeFileSync(join(dir, "playground-origin", "index.html"), "<!doctype html><title>x</title>");
    const emitted = [
      "playground-origin/index.html",
      "python-addons/dask/locket-1.0.0-py2.py3-none-any.whl",
      "python-addons/cartopy-natural-earth-110m/shapefiles/natural_earth/physical/ne_110m_coastline.shp",
      "freva-wheels/freva_client-1.0-py3-none-any.whl",
      "docs/index.html",
    ];
    const deployment = describePlaygroundDeployment(
      {
        origin: "https://py.example.org",
        hostOrigin: "https://portal.example.org",
        profile: "xarray-zarr",
        protocolVersion: 1,
        runtimeIndexUrl: "https://cdn.jsdelivr.net/pyodide/v0.28.0/full/",
        examples: [],
      } as never,
      dir,
      { chunks: [] } as never,
      emitted,
    )!;
    expect(deployment.files).toContain("python-addons/dask/locket-1.0.0-py2.py3-none-any.whl");
    expect(deployment.files).toContain(
      "python-addons/cartopy-natural-earth-110m/shapefiles/natural_earth/physical/ne_110m_coastline.shp",
    );
    expect(deployment.files).toContain("freva-wheels/freva_client-1.0-py3-none-any.whl");
    // Portal pages still do not cross.
    expect(deployment.files).not.toContain("docs/index.html");
  });
});
