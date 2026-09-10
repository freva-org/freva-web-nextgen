// metadata-public.ts - the PUBLIC `@freva-org/databrowser/metadata` entry.
//
// The shared climate metadata, for a host that renders facet values in its own UI - today the
// portal's landing search box, which offers the same values the Data Browser will show and must
// therefore describe them identically or read as a different tool.
//
// Deliberately a data-only barrel: no DOM, no mount, no application state. The built-in set itself
// is still reached through the dynamic import inside `loadBuiltinMetadata`, so a page that imports
// this pays for the 2,498 descriptions only when it calls for them.

export { loadBuiltinMetadata, mergeMetadata, sanitizeConfigMetadata } from "./metadata.js";
export { describeMetadataValue } from "./describe.js";
export { BUILTIN_FLAVOUR_MAPS, BUILTIN_FLAVOURS } from "./state.js";
export type { MetadataMap, FacetDescriptions } from "./types.js";
