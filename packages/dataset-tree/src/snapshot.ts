// snapshot.ts - the public `@freva-org/dataset-tree/snapshot` entry: catalog validation and the
// in-memory source, and nothing else. Importing this must never pull in the S3 adapter - a portal
// that ships a build-time catalog should not carry an object-store client it will never call - and
// `tests/import-graph.test.ts` fails the build if that stops being true.

export {
  DatasetTreeCatalogError,
  parseDatasetTreeCatalogV1,
  type DatasetTreeCatalog,
  type DatasetTreeCatalogDiagnostic,
  type DatasetTreeCatalogNode,
} from "./snapshot/parse.js";

export { createSnapshotSource } from "./snapshot/source.js";
