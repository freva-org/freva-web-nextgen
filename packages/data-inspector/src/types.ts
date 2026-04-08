/**
 * Status of the data-inspector operation.
 */
export const NcDumpDialogState = {
  ERROR: "error",
  READY: "ready",
  LOADING: "loading",
} as const;

export type NcDumpDialogStateValue = (typeof NcDumpDialogState)[keyof typeof NcDumpDialogState];

/**
 * Configuration for how multiple files should be aggregated
 * before metadata inspection.
 */
export interface AggregationConfigValues {
  aggregate: "auto" | "merge" | "concat";
  join: string | null;
  compat: string | null;
  data_vars: string | null;
  coords: string | null;
  dim: string;
  group_by: string;
  reload: boolean;
  access_pattern: "map" | "time_series";
  chunk_size: number;
  map_primary_chunksize: number;
  timeout: number;
}

/** Options for ZarrPoller (replaces UseZarrStatusOptions). */
export interface ZarrPollerOptions {
  /** Polling interval in ms. Default: 2000 */
  intervalMs?: number;
  /** Whether polling is active. Default: true */
  enabled?: boolean;
  /**
   * Override auth header injection.
   * Default: reads a Bearer token from the `freva_auth_token` cookie.
   */
  getAuthHeaders?: () => Record<string, string>;
  /**
   * Override the status endpoint URL.
   * Receives the already-encoded zarr URL.
   * Default: Freva's `/api/freva-nextgen/data-portal/zarr-utils/status`.
   */
  getStatusUrl?: (encodedZarrUrl: string) => string;
  /** Called whenever a new status code arrives. */
  onStatus?: (statusCode: number) => void;
  /** Called on network or parse error. */
  onError?: (error: string) => void;
}
