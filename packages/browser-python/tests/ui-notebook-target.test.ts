// "Open as notebook" opens the seed of the registered example run last - and after an edited
// snippet (the visitor's own source, which no seed holds), the notebook's file list.
import { describe, expect, it } from "vitest";

import { NotebookTarget, notebookSeedPath } from "../src/ui/notebook-paths.js";

describe("Open as notebook", () => {
  it("opens the last registered example, never an earlier one after an edited run", () => {
    const target = new NotebookTarget();
    const origin = "https://py.example.org";
    expect(target.url(origin)).toBe(`${origin}/notebook/tree/index.html`);
    target.ranExample("a".repeat(64));
    expect(target.url(origin)).toContain(encodeURIComponent(notebookSeedPath("a".repeat(64))));
    target.ranOther();
    expect(target.hasExample).toBe(false);
    expect(target.url(origin)).toBe(`${origin}/notebook/tree/index.html`);
  });

  it("opens the notebook a site named for the example, when it named one", () => {
    const target = new NotebookTarget();
    const origin = "https://docs.example.org/waterpark";
    target.ranExample("b".repeat(64), "examples/02_global_mean.ipynb");
    expect(target.url(origin)).toBe(
      `${origin}/notebook/notebooks/index.html?path=${encodeURIComponent("examples/02_global_mean.ipynb")}`,
    );
  });

  it("after a recipe ran on a store, opens a notebook on that store - no seed holds it", () => {
    const target = new NotebookTarget();
    const origin = "https://docs.example.org";
    target.ranDataset("s3://reanalysis/healpix/era5/P1M/level_4.zarr/");
    expect(target.hasExample).toBe(true);
    expect(target.url(origin)).toBe(
      `${origin}/notebook/lab/index.html?dataset=${encodeURIComponent("s3://reanalysis/healpix/era5/P1M/level_4.zarr/")}`,
    );
    target.ranExample("c".repeat(64), "examples/01_first_map.ipynb");
    expect(target.url(origin)).toContain("examples%2F01_first_map.ipynb");
  });

  it("routes only a recipe bound to a store - never a snapshot tree's example - to that store", () => {
    const origin = "https://docs.example.org";
    const store = "s3://reanalysis/healpix/era5/P1M/level_4.zarr/";
    const digest = "d".repeat(64);

    // A snapshot tree's example carries a datasetId too, but it is a registered example: its seed.
    const snapshot = new NotebookTarget();
    snapshot.ran({ digest, bound: false });
    expect(snapshot.url(origin)).toContain(encodeURIComponent(notebookSeedPath(digest)));

    // A recipe the binder filled for a store: the store, where the notebook has its data panel...
    const recipe = new NotebookTarget();
    recipe.ran({ digest, bound: true, dataset: store });
    expect(recipe.url(origin)).toBe(
      `${origin}/notebook/lab/index.html?dataset=${encodeURIComponent(store)}`,
    );

    // ...and the file list where the binder named none - another tree's store, or no data panel -
    // rather than a Lab that cannot find it or a seed that does not exist.
    const noPanel = new NotebookTarget();
    noPanel.ran({ digest, bound: true });
    expect(noPanel.url(origin)).toBe(`${origin}/notebook/tree/index.html`);
  });
});
