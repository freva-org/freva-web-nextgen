// index.ts - the public `@freva-org/dataset-tree` entry: the component and the shared model. No
// adapter is re-exported here. A host chooses `./snapshot` or `./s3` explicitly, so the entry every
// consumer imports stays free of both a network client and a catalog validator, and a bundler can
// prove which of them a page actually paid for. Nothing in this graph reads or writes a global,
// registers a custom element, or mounts on import: `mountDatasetTree` is the only way anything
// appears on a page.

export { mountDatasetTree } from "./tree.js";

export { DEFAULT_LABELS } from "./labels.js";
export { formatBytes, formatTimestamp } from "./format.js";

// The "Try in Python" rule is exported so a host can ask which examples grow a run button without
// re-implementing five conditions and drifting from them. It is pure, and it imports nothing.
export { isPythonLanguage, tryPythonEligible } from "./python.js";

// The error contract, exported because both halves need it: a source constructs one, the component
// reads one, and a consumer writing its own says "access denied" in the built-in adapters' words.
export { datasetTreeError, errorCodeOf, isDatasetTreeError, isRetryable } from "./errors.js";

export type {
  DatasetAccessExample,
  DatasetTreeAccess,
  DatasetTreeAvailability,
  DatasetTreeHandle,
  DatasetTreeLabels,
  DatasetTreeLoadContext,
  DatasetTreeNode,
  DatasetTreeSourceError,
  DatasetTreeSourceErrorCode,
  DatasetTreeNodeKind,
  DatasetTreeOptions,
  DatasetTreePython,
  DatasetTreeSource,
  DatasetTreeStatus,
  TryPythonEvent,
} from "./types.js";
