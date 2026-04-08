// Custom elements — importing registers them via customElements.define()
export { DataInspectorElement } from "./elements/data-inspector";
export { AggregationConfigElement } from "./elements/aggregation-config";
export { ZarrLoadingStepsElement } from "./elements/zarr-loading-steps";

// Framework-agnostic poller (replaces useZarrStatus hook)
export { ZarrPoller } from "./ZarrPoller";
export type { ZarrPollerOptions } from "./ZarrPoller";

// Shared constants and types
export { NcDumpDialogState } from "./types";
export type {
  NcDumpDialogStateValue,
  AggregationConfigValues,
  ZarrPollerOptions as ZarrPollerOpts,
} from "./types";
