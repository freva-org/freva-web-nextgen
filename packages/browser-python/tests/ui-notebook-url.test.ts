import { describe, expect, it } from "vitest";

import { notebookRequestFor, notebookUrl } from "../src/ui/notebook/notebook-url.js";
import { portalBaseSource } from "../src/ui/portal-base.js";

describe("the notebook's address", () => {
  it("carries the theme, the dataset, the example and the panel it is asked for", () => {
    expect(notebookUrl("/notebook/lab/index.html", "https://p.example/")).toBe(
      "https://p.example/notebook/lab/index.html",
    );
    expect(
      notebookUrl("notebook/lab/index.html", "https://p.example/showroom/docs/", {
        theme: "dark",
        dataset: "s3://eerie/x.zarr/",
        example: "examples/01_map.ipynb",
        panel: "data",
      }),
    ).toBe(
      "https://p.example/showroom/docs/notebook/lab/index.html?theme=dark&dataset=s3%3A%2F%2Feerie%2Fx.zarr%2F&example=examples%2F01_map.ipynb&panel=data",
    );
  });

  it("recognises a link to it, with only the parameters the sheet takes", () => {
    const lab = "https://p.example/showroom/notebook/lab/index.html";
    expect(notebookRequestFor(lab, lab)).toEqual({});
    expect(notebookRequestFor(`${lab}?example=examples%2Fmap.ipynb`, lab)).toEqual({
      example: "examples/map.ipynb",
    });
    expect(
      notebookRequestFor(`${lab}?dataset=s3%3A%2F%2Feerie%2Fx.zarr%2F&panel=data&theme=dark`, lab),
    ).toEqual({ dataset: "s3://eerie/x.zarr/", panel: true });
    expect(notebookRequestFor("https://p.example/showroom/notebook/tree/index.html", lab)).toBe(
      null,
    );
    expect(notebookRequestFor("https://other.example/showroom/notebook/lab/index.html", lab)).toBe(
      null,
    );
    expect(notebookRequestFor(`${lab}?path=examples%2Fmap.ipynb`, lab)).toBeNull();
    expect(notebookRequestFor(`${lab}?panel=climateclaw`, lab)).toBeNull();
    expect(notebookRequestFor(`${lab}#cell-3`, lab)).toBeNull();
    expect(notebookRequestFor("not a url", lab)).toBeNull();
  });
});

describe("PORTAL_BASE_URL", () => {
  it("is the deployment's base, resolved against the page, as a Python assignment", () => {
    expect(portalBaseSource(undefined, "https://p.example/")).toBeUndefined();
    expect(portalBaseSource("../../", "https://p.example/showroom/notebook/lab/index.html")).toBe(
      'PORTAL_BASE_URL = "https://p.example/showroom/"',
    );
  });
});
