// search-index.ts - the public `@freva-org/dataset-tree/search-index` entry: the optional index
// format's validator and diagnostics, and nothing else. Separate for the same reason `./snapshot`
// is - a consumer with no index, or one that validates in its own build, should not carry a parser
// for a format it never reads at runtime; `tests/import-graph.test.ts` fails the build if the core
// entry ever reaches this. The types live in the core model, because
// `DatasetTreeOptions.searchIndex` names them and types cost nothing at runtime.

export {
  DatasetTreeSearchIndexError,
  parseDatasetTreeSearchIndexV1,
  type DatasetTreeSearchIndexDiagnostic,
} from "./search/parse.js";

export type {
  DatasetTreeSearchAncestor,
  DatasetTreeSearchIndex,
  DatasetTreeSearchIndexEntry,
} from "./types.js";
