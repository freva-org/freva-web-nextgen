// Custom elements - importing registers them via customElements.define()
export { DataInspectorElement } from "./elements/data-inspector";
export { AggregationConfigElement } from "./elements/aggregation-config";
export { ZarrLoadingStepsElement } from "./elements/zarr-loading-steps";

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
