// The data side of this package, importable where there is no DOM.
//
// No custom element is defined and none is even declared: the element classes extend
// `HTMLElement` at module scope, which throws in plain Node, so they live in
// `./elements` along with the registration. The package root re-exports both.

// Framework-agnostic poller for backend Zarr-conversion status
export { ZarrPoller } from "./ZarrPoller";
export type { ZarrPollerOptions } from "./ZarrPoller";

// Zarr-store probe - skip server conversion when the URL is already a store
export { detectZarrStore } from "./detectZarrStore";
export type { ZarrStoreInfo, DetectZarrStoreOptions } from "./detectZarrStore";

// Client-side Zarr metadata parser + xarray HTML renderer - no server round-trip
export {
  openDatasetMeta,
  buildXarrayRepr,
  injectXarrayCss,
  loadZarrMetadataHtml,
} from "./zarr-metadata";
export type {
  ZarrVariable,
  ZarrDataset,
  ZarrMetadataResult,
  ZarrMetadataOptions,
  InjectCssOptions,
  LoadMetadataOptions,
} from "./zarr-metadata";

// Shared constants and types
export { NcDumpDialogState } from "./types";
export type {
  NcDumpDialogStateValue,
  AggregationConfigValues,
  ZarrPollerOptions as ZarrPollerOpts,
} from "./types";
