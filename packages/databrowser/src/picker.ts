// picker.ts - the PUBLIC `@freva-org/databrowser/picker` entry.
//
// A lightweight subpath of the same package, NOT a separate repository and NOT an independently
// versioned artefact: the picker and the browser share the query boundary, so shipping them on
// different release trains would let that boundary drift version by version, which is precisely
// what the shared module exists to prevent.
//
// This module is deliberately a thin barrel. It imports the picker and the contract, and NOTHING
// from the full application entry: no terminal package or adapter, no overview, no inspector, no
// logo, no application shell, no full databrowser stylesheet. `tests/picker-import-graph.test.ts`
// walks the BUILT module graph from `dist/picker.js` and fails if any of those ever reappear.

export { mountDataPicker } from "./picker/mount.js";

export {
  FREVA_DATA_REFERENCE_MIME,
  DATA_REFERENCE_SCHEMA_VERSION,
  DATA_REFERENCE_JSON_SCHEMA,
  MAX_PICKER_ASSETS,
  isDataReference,
  parseDataReference,
  describeReference,
  uriListFor,
  isUriListSafe,
  uriListValue,
  URI_LIST_PROTOCOLS,
  cloneAssetReference,
  findCredentialField,
} from "./picker/reference.js";

export type {
  DataReference,
  AssetDataReference,
  SelectionDataReference,
  QueryDataReference,
  DataSource,
  AssetReference,
  StacLocator,
  EffectiveSearchQuery,
} from "./picker/reference.js";

export { PICKER_STATE_VERSION } from "./picker/types.js";
export type {
  DataPickerConfig,
  DataPickerHandle,
  // Every type reachable from the config surface is exported: `resolveFlavourMaps` returns
  // FlavourMapping[], and a host writing that callback in TypeScript needs to be able to name it.
  FlavourMapping,
  PickerFeatureFlags,
  PickerState,
} from "./picker/types.js";

// The shared, DOM-free search boundary. Exported here (rather than only from the root) so a host
// that already has its own UI can reuse the exact query construction the picker uses.
export { effectiveSearchQuery, buildSearchUrl, emptyScope } from "./search/query.js";
export type { QueryScope, QueryTarget } from "./search/query.js";
export { createSearchEngine, DEFAULT_SEARCH_DEBOUNCE_MS } from "./search/engine.js";
export type { SearchClient, SearchRequest, SearchEngine } from "./search/engine.js";
export { createRestSearchClient } from "./search/client.js";
export type { RestSearchClientOptions } from "./search/client.js";
export { rankValueMatches } from "./search/rank.js";
export type { ValueMatch } from "./search/rank.js";

export { mountDataPicker as default } from "./picker/mount.js";
