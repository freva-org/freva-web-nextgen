import { describe, expect, it } from "vitest";
import type { DatasetTreeNode, DatasetTreeSource } from "@freva-org/dataset-tree";

import {
  OPEN_DATASET_MESSAGE,
  datasetFromMessage,
  datasetRequest,
  findPath,
  panelFromMessage,
  panelRequest,
  withoutDatasetRequest,
} from "../src/open-request.js";

const LAB = "https://portal.example/showroom/notebook/lab/index.html";

const node = (id: string, kind: DatasetTreeNode["kind"], name = id): DatasetTreeNode =>
  ({ id, kind, name, path: id }) as DatasetTreeNode;

function s3Like(): { source: DatasetTreeSource; requests: string[] } {
  const tree: Record<string, DatasetTreeNode[]> = {
    "s3://eerie/": [node("s3://eerie/a/", "directory"), node("s3://eerie/b/", "directory")],
    "s3://eerie/b/": [node("s3://eerie/b/x.zarr/", "dataset")],
  };
  const requests: string[] = [];
  return {
    requests,
    source: {
      loadRoots: async () => [node("s3://cmip6/", "collection"), node("s3://eerie/", "collection")],
      loadChildren: async (parent) => {
        requests.push(parent.id);
        return tree[parent.id] ?? [];
      },
    },
  };
}

describe("a request to open a dataset", () => {
  it("is read from ?dataset= and removed from the address, other parameters kept", () => {
    const href = `${LAB}?theme=dark&dataset=${encodeURIComponent("s3://eerie/b/x.zarr/")}`;
    expect(datasetRequest(href)).toBe("s3://eerie/b/x.zarr/");
    expect(withoutDatasetRequest(href)).toBe(`${LAB}?theme=dark&panel=data`);
    expect(withoutDatasetRequest(`${LAB}?panel=data&dataset=x`)).toBe(`${LAB}?panel=data`);
    expect(panelRequest(`${LAB}?panel=data`)).toBe(true);
    expect(panelRequest(`${LAB}?panel=files`)).toBe(false);
    expect(panelFromMessage({ type: "freva-data:show-panel" })).toBe(true);
    expect(panelFromMessage({ type: "freva-data:open-dataset" })).toBe(false);
    expect(datasetRequest(LAB)).toBeNull();
    expect(datasetRequest(`${LAB}?dataset=`)).toBeNull();
    expect(datasetRequest(`${LAB}?dataset=${"x".repeat(3000)}`)).toBeNull();
  });

  it("is read from the framing page's message, and nothing else", () => {
    expect(datasetFromMessage({ type: OPEN_DATASET_MESSAGE, dataset: "s3://eerie/" })).toBe(
      "s3://eerie/",
    );
    expect(datasetFromMessage({ type: "other", dataset: "s3://eerie/" })).toBeNull();
    expect(datasetFromMessage({ type: OPEN_DATASET_MESSAGE, dataset: 3 })).toBeNull();
    expect(datasetFromMessage(null)).toBeNull();
  });
});

describe("finding the requested node in the panel's own tree", () => {
  it("walks only the branches leading to it", async () => {
    const { source, requests } = s3Like();
    const found = await findPath(source, "s3://eerie/b/x.zarr/");
    expect(found?.map((node) => node.id)).toEqual([
      "s3://eerie/",
      "s3://eerie/b/",
      "s3://eerie/b/x.zarr/",
    ]);
    expect(requests).toEqual(["s3://eerie/", "s3://eerie/b/"]);
  });

  it("finds nothing for an id the tree does not have, without listing anything else", async () => {
    const { source, requests } = s3Like();
    expect(await findPath(source, "s3://eerie/b/y.zarr/")).toBeNull();
    expect(await findPath(source, "https://evil.example/x.zarr")).toBeNull();
    expect(requests).toEqual(["s3://eerie/", "s3://eerie/b/"]);
  });

  it("follows storage paths when the roots have ids of their own, preferring the closest", async () => {
    const tree: Record<string, DatasetTreeNode[]> = {
      reanalysis: [
        {
          id: "s3://archive/reanalysis/era5.zarr/",
          kind: "dataset",
          name: "era5.zarr",
          path: "s3://archive/reanalysis/era5.zarr/",
        } as DatasetTreeNode,
      ],
      archive: [
        {
          id: "s3://archive/other/",
          kind: "directory",
          name: "other",
          path: "s3://archive/other/",
        } as DatasetTreeNode,
      ],
    };
    const requests: string[] = [];
    const source: DatasetTreeSource = {
      loadRoots: async () => [
        {
          id: "archive",
          kind: "collection",
          name: "archive",
          path: "s3://archive/",
        } as DatasetTreeNode,
        {
          id: "reanalysis",
          kind: "collection",
          name: "reanalysis",
          path: "s3://archive/reanalysis/",
        } as DatasetTreeNode,
      ],
      loadChildren: async (parent) => {
        requests.push(parent.id);
        return tree[parent.id] ?? [];
      },
    };
    const found = await findPath(source, "s3://archive/reanalysis/era5.zarr/");
    expect(found?.map((node) => node.id)).toEqual([
      "reanalysis",
      "s3://archive/reanalysis/era5.zarr/",
    ]);
    expect(requests).toEqual(["reanalysis"]);
  });

  it("searches a complete snapshot whatever its ids look like", async () => {
    const children: Record<string, DatasetTreeNode[]> = {
      c1: [node("d7", "dataset", "tas.zarr")],
    };
    const source: DatasetTreeSource = {
      complete: true,
      loadRoots: async () => [node("c1", "collection")],
      loadChildren: async (parent) => children[parent.id] ?? [],
    };
    expect((await findPath(source, "d7"))?.map((node) => node.id)).toEqual(["c1", "d7"]);
    expect(await findPath(source, "d8")).toBeNull();
  });
});
