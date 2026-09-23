/**
 * The SNAPSHOT loader: a catalogue that is already in the page, and no network of any kind.
 * `@freva-org/dataset-tree/snapshot` is a separate entry point from `/s3` precisely so a portal in
 * this mode cannot acquire an object-store client, and the generated entry imports this module
 * rather than its sibling so that is a fact about the bundle.
 */

import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "@freva-org/dataset-tree/snapshot";
import type { SnapshotLoader } from "./tree-sources.js";

export const loadSnapshotSource: SnapshotLoader = (raw) => {
  const catalog = parseDatasetTreeCatalogV1(raw);
  return Promise.resolve({ source: createSnapshotSource(catalog), catalog });
};
