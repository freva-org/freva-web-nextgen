/**
 * The two ways a dataset tree gets its nodes, and the shape the island asks for either by.
 *
 * A TYPE FILE AND TWO SIBLINGS RATHER THAN ONE FUNCTION WITH AN `if`, because a module that
 * MENTIONS `@freva-org/dataset-tree/s3` puts the object-store client in that build's graph whether
 * the branch runs or not. A portal serving a build-time catalogue must be able to prove it ships
 * no S3 client at all, and "we only call it in live mode" is an intention, not a proof. So the
 * choice is the BUILD's: the generated entry names one loader, or the other, or both when a page
 * has one of each, and what it does not name is not in the bundle.
 */

import type { DatasetTreeSource } from "@freva-org/dataset-tree";
import type { InspectorLoader } from "./tree-inspector-loader.js";

/** A live source's configuration, exactly as the build wrote it onto the block. */
export interface TreeS3Config {
  endpoint: string;
  origin: string;
  style: "path" | "virtual-host";
  roots: {
    id?: string;
    name: string;
    bucket: string;
    prefix?: string;
    title?: string;
    description?: string;
  }[];
  maxKeys?: number;
  maxPages?: number;
  requestTimeoutMs?: number;
  retries?: number;
  datasetSuffixes?: string[];
}

/** Builds the snapshot source from the catalogue already embedded in the page. */
export type SnapshotLoader = (catalog: unknown) => Promise<{
  source: DatasetTreeSource;
  /** The parsed catalogue, which the island needs for its own example lookup. */
  catalog: unknown;
}>;

/** Builds the live source. Asynchronous because the adapter arrives through a dynamic import. */
export type S3Loader = (
  config: TreeS3Config,
  onTruncated: (info: { bucket: string; prefix: string; pages: number }) => void,
) => Promise<DatasetTreeSource>;

/** What the entry hands the island: whichever loaders this portal's blocks actually need. */
export interface TreeLoaders {
  snapshot?: SnapshotLoader;
  s3?: S3Loader;
  /**
   * How this build opens a store in an inspector, when it has one. Absent means the portal wired
   * none, and `Inspect` says so instead of opening the store's raw HTTPS URL in a tab - which is
   * an XML listing document, not something a reader asked for.
   */
  inspector?: InspectorLoader;
}
