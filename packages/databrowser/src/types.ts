// types.ts - wire shapes (exactly what the API returns) and the view model.
// FileRow.meta carries string | string[] | number, and primary_facets is API-driven
// (rendered in response order, never hardcoded).

import type { MapConfig } from "./map.js";
import type { OSKind, ShellId } from "./shell.js";

export type FlavourName = string;

/** flexible is the only mode enabled by default; strict/file are flag-gated. */
export type SelectMode = "flexible" | "strict" | "file";

export type UniqKey = "file" | "uri";

// Wire shapes - what the backend actually returns.

/** A search row is intentionally minimal: { file|uri, fs_type } only (fl is hardcoded server-side). */
export interface ApiRow {
  file: string;
  fs_type: string;
  uri?: string;
  [extra: string]: string | number | string[] | undefined;
}

/** Solr-flat facet block: [value, count, value, count, …]. */
export type SolrFlatFacets = Record<string, Array<string | number>>;

/** Response of extended-search / (rows-less) metadata-search. */
export interface SearchResult {
  total_count: number;
  facets: SolrFlatFacets;
  primary_facets: string[];
  facet_mapping: Record<string, string>;
  search_results: ApiRow[];
}

/**
 * The deployment ships `/static/js/metadata.js`, a script that assigns
 * a per-facet dictionary to a window global for each facet key -
 * `window.project`, `window.variable`, … - each mapping a facet VALUE to a human
 * description string. In-view we model that as facetKey -> (value -> description).
 * A `metadata` object may also be passed in mount config; config wins per (key,value).
 */
export type FacetDescriptions = Record<string, string>;
export type MetadataMap = Record<string, FacetDescriptions>;

/** overview returns flavours + attributes ONLY - never facet_mapping. */
export interface OverviewResult {
  flavours: FlavourName[];
  attributes: Record<string, string[]> | string[];
}

/** Detail of a 413 the catalogue endpoints return when the stream is too big. */
export const STREAM_TOO_BIG_DETAIL = "Result stream too big.";

// View model

export interface FacetValue {
  value: string;
  count: number;
}

export interface Facet {
  key: string;
  /** display label from facet_mapping (flavour-dependent); falls back to a humanised key. */
  label: string;
  values: FacetValue[];
  /** the value list is a truncated sample (caller should point to the search bar). */
  hasMore: boolean;
}

export interface TimeSelection {
  from: string;
  to: string;
  mode: SelectMode;
}

export interface BBoxSelection {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  mode: SelectMode;
}

export interface FileRow {
  /** client-side identity = file (or uri when uniq_key='uri'). */
  key: string;
  file: string;
  fsType: string;
  raw: ApiRow;
  /** lazily filled from the ?file= facets block; values may be arrays or numbers. */
  meta?: Record<string, string | string[] | number>;
  /** per-file extent if/when the backend exposes it (deferred). */
  bbox?: BBoxSelection;
  /** per-file time range, derived from the filename until the backend exposes it. */
  timeRange?: string;
  /** True when timeRange was derived from the filename rather than returned by the API. */
  timeRangeInferred?: boolean;
}

export type LoadState = "idle" | "loading" | "loaded" | "empty" | "error";

export interface AppState {
  // selection / query
  flavour: FlavourName;
  uniqKey: UniqKey;
  selected: Record<string, string[]>;
  /** Always-applied, invisible scope (freva-canonical keys). Merged into every server query but never
   *  shown as chips, sidebar facets, or in the URL, and never cleared by "Clear all". Set from config
   *  (baseFilters) - the "hosted filtered instance" gate, e.g. { project: ['waterpark'] }. */
  baseFilters: Record<string, string[]>;
  time: TimeSelection | null;
  bbox: BBoxSelection | null;

  // results (last committed search)
  rows: FileRow[];
  totalCount: number;
  facets: Facet[];
  primaryFacets: string[];
  /** Facet keys+labels from the last query that returned data. Keeps the overview blocks in place
   *  (rendered empty) when a later query matches nothing, so the layout doesn't collapse. */
  overviewShape: Array<{ key: string; label: string }>;
  facetMapping: Record<string, string>;
  attributeKeys: string[];
  flavours: FlavourName[];
  /** Per-flavour translation between freva's canonical facet keys and that flavour's names, built
   *  from GET /flavours. `forward` is freva->flavour, `backward` is flavour->freva. Lets us re-key the
   *  active selection when the lens changes (model⇄source_id) using freva as the pivot. */
  flavourMaps: Record<
    string,
    { forward: Record<string, string>; backward: Record<string, string> }
  >;
  start: number;
  search: LoadState;
  searchError?: string;
  lastRequestId: number;
  /** bumped whenever state.facets is replaced - cheap identity for render change-detection. */
  facetsVersion: number;
  /** bumped whenever state.rows is replaced or appended - cheap identity for render change-detection. */
  rowsVersion: number;
  /** Bumps only when the row list is RESET (new query), not on append. Lets the results view treat
   *  "same epoch, more rows" as a pure append in O(1) instead of re-scanning the whole prefix. */
  rowsEpoch: number;

  // view / chrome
  layout: "results" | "overview";
  theme: "day" | "night";
  view: "list" | "grid";

  // heavy-op + details
  pickedKeys: Set<string>;
  focusKey: string | null;
  /** Which selection the Details panel describes - whichever the user acted on LAST wins: clicking a
   *  row -> 'focus' (that one file); (de)selecting or the pickbar Details button -> 'picks' (the bunch). */
  detailSource: "focus" | "picks";
  detailsOpen: boolean;
  details: LoadState;
  detailsError?: string;
  detailsCache: Map<string, FileRow>;

  // terminal
  terminalDraft: string;
  /**
   * Bumped by every query change made OUTSIDE the terminal (a facet chip, Clear all, the map, the
   * time panel). The terminal normally refuses to overwrite a focused input - but an explicit UI
   * action must win, or a stale half-typed draft (`time=`) survives a Clear all and re-commits the
   * old facets on the next keystroke.
   */
  externalEdits: number;
  terminalFocused: boolean;
  terminalTab: "cli" | "py";

  // overview grid
  overviewFilters: Record<string, string>;
  /** per-block value sort in the metadata view: 'count' (default) or 'alpha'. */
  overviewSort: Record<string, "count" | "alpha">;
  /** metadata-view facet blocks collapsed individually. */
  overviewCollapsed: Set<string>;
  /** show non-primary ("additional") facets in the metadata view too. */
  overviewAddOpen: boolean;
  /** grid column span per block (size-to-fit replacement for the ⇕/⇔ toggles). */
  overviewSpan: Record<string, number>;
  /** "stacked" overview: every block minimized to a full-width row (an accordion). */
  overviewStacked: boolean;
  overviewStackSeen: string[];
  /** The collapse/size layout captured when Stack was turned on, restored verbatim on Unstack so
   *  stacking is a reversible view, not a destructive reset. Null when not stacked. */
  overviewSnapshot: {
    collapsed: string[];
    span: Record<string, number>;
    h: Record<string, number>;
  } | null;
  /** Per-card HEIGHT in px (vertical resize; bounded to roughly one extra row). */
  overviewH: Record<string, number>;
  /** explicit block order in the metadata view (drag-to-reorder); keys not listed keep default order. */
  overviewOrder: string[];
  /** marker shown when a recount failed and we are keeping the previous counts. */
  overviewStale: boolean;

  // sidebar UI (per-mount, so it lives in state - module-level state is banned)
  sidebarOpen: Set<string>;
  sidebarAddOpen: boolean;
  sidebarSeeded: boolean;
  /** left facet sidebar collapsed to its rail (persisted like theme/layout/view). */
  sidebarCollapsed: boolean;

  // recount counts may differ from search counts; kept separate so the grid can degrade.
  status: string;

  /**
   * facetKey -> (value -> human description), merged from the mount-config `metadata`
   * object and (optionally) the deployment `metadata.js` script, config winning per
   * (key, value). Empty until resolved; every lookup degrades silently when absent.
   */
  metadata: MetadataMap;
  /** bumped whenever `metadata` is replaced - cheap identity for render change-detection. */
  metadataVersion: number;
}

// Public surface

/**
 * Documented, embedder-adjustable palette tokens (set as CSS custom properties on the root, so a
 * host can recolour the package without forking styles). Values are any valid CSS colour. Any
 * token omitted keeps the built-in default. Applies on top of the day/night theme.
 */
export type ThemeToken =
  | "bg"
  | "surface"
  | "surface-2"
  | "surface-3"
  | "text"
  | "dim"
  | "faint"
  | "border"
  | "border-2"
  | "accent"
  | "accent-2"
  | "accent-soft"
  | "good"
  | "warn"
  | "danger"
  | "ocean"
  | "land";
export type ThemeOverrides = Partial<Record<ThemeToken, string>>;

/** Per-theme palette overrides (or a flat set applied to both). */
export interface ThemeConfig {
  day?: ThemeOverrides;
  night?: ThemeOverrides;
  /** applied to BOTH themes (day/night win over this when they also set a token). */
  both?: ThemeOverrides;
  /** UI font-family stack (sets --ui), e.g. '"Inter", system-ui, sans-serif'. Applies to both themes. */
  font?: string;
  /** Initial light/dark mode, overriding the persisted value - so an embedding app can open the widget
   *  in its OWN current mode. Combine with features.themeToggle:false + handle.setTheme() to fully own it. */
  mode?: "day" | "night";
  /** Called whenever the mode changes (internal toggle or handle.setTheme), for two-way sync with a host. */
  onModeChange?: (mode: "day" | "night") => void;
}

/** Feature gates - every chrome element is opt-out at mount. All default true. */
export interface FeatureFlags {
  themeToggle?: boolean;
  terminal?: boolean;
  overview?: boolean;
  export?: boolean;
  details?: boolean;
  search?: boolean;
  lensSwitcher?: boolean;
  /** Inspect (ncdump via @freva-org/data-inspector). Also requires authEnabled + enableHeavyOps. */
  inspect?: boolean;
  brand?: boolean;
}

export interface BrandConfig {
  title?: string;
  /** short mark shown in the brand badge (glyph or ≤2 chars). */
  mark?: string;
  /** optional one-line description shown under the results scope. */
  description?: string;
}

/**
 * Terminal shell/OS/host options. The command targets `--host <api>` so it runs on the user's
 * LOCAL machine; shell dialect follows the browser OS by default. Layered: `shell` (if set) wins,
 * else the detected OS default, else the user's persisted choice; `os` forces detection (for
 * embedders/testing - the host wires env->config, e.g. a `?os=` query param).
 */
export interface TerminalConfig {
  host?: string;
  shell?: ShellId;
  os?: OSKind;
}

export interface DataBrowserConfig {
  apiBase?: string;
  flavour?: FlavourName;
  devNotes?: boolean;
  /** ESM URL for the lazy @freva-org/data-inspector web component (CDN by default; override to a
   *  self-hosted copy). Loaded on first Inspect only - never in the main bundle. */
  inspectorUrl?: string;
  /** heavy ops (load / data-portal) are auth.required(); off -> disabled placeholders. */
  authEnabled?: boolean;
  /**
   * Defence-in-depth gate for the data-portal heavy ops (load / zarr convert / status / share).
   * A deployment may have auth without the data-portal service, so these stay disabled
   * placeholders unless this is explicitly enabled IN ADDITION to authEnabled. Default false.
   */
  enableHeavyOps?: boolean;
  /** Mirror the active query (flavour + facets + time + bbox) into the page URL so a link reproduces
   *  the exact view, and read it back on load (deep-link source of truth). Default true. Set false
   *  when embedding inside a host app that owns window.location. */
  syncUrl?: boolean;
  /** Always-applied scope for a "hosted filtered instance". Every value here (freva-canonical keys)
   *  constrains every query - search, counts, export, details, terminal, autocomplete. The gated key
   *  is shown in the sidebar/overview as a LOCKED value (active, non-toggleable, `.fval.locked`) so the
   *  scope is legible, but it is never a removable chip, never written to the URL, and untouched by
   *  "Clear all". Users browse and filter *within* the scope and cannot widen or escape it in the UI.
   *  e.g. `{ project: 'waterpark' }` makes the instance behave as if waterpark were the whole archive.
   *  Read a URL param in your bootstrap and pass it here (that key is then excluded from the removable
   *  deep-link import).
   *
   *  NOTE: this is CLIENT-SIDE scoping, not an authorization boundary. It shapes what THIS UI sends and
   *  shows; it does not stop anyone from calling the API directly. Enforce real tenant isolation on the
   *  server (or an auth proxy) - baseFilters is for a clean scoped UI, not access control. */
  baseFilters?: Record<string, string | string[]>;
  /** Strict/file bbox modes stay off until verified against the backend. */
  enableStrictBBoxModes?: boolean;
  /**
   * Interactive map (Leaflet). Loaded ON DEMAND only - never on the initial paint - so the SVG
   * world map stays the zero-cost default. Point these at self-hosted copies for an air-gapped
   * deployment; if they can't load, the SVG simply remains and nothing breaks.
   */
  map?: Partial<MapConfig>;
  /**
   * Facet value descriptions passed directly by the embedder (facetKey -> value -> text).
   * Takes priority, per (key, value), over anything loaded from the deployment script.
   */
  metadata?: MetadataMap;
  /**
   * URL of the deployment `metadata.js` script. It assigns per-facet window globals
   * mapping value -> description. Pass `null` to disable
   * script loading entirely (config-only). Default: '/static/js/metadata.js'.
   */
  metadataScriptUrl?: string | null;
  /** Feature gates for chrome (all default true). */
  features?: FeatureFlags;
  /** Embedder palette overrides applied as CSS custom properties on the root. */
  theme?: ThemeConfig;
  /** Brand title / mark / description. */
  brand?: BrandConfig;
  /** Terminal shell / OS / host options. */
  terminal?: TerminalConfig;
  /** supplies an OIDC bearer token when authEnabled. */
  getAuthToken?: () => string | null | undefined;
  /**
   * Optional CSRF token supplier. The backend is OIDC bearer-only and needs no CSRF for
   * same-origin GETs, so `X-CSRFToken` is sent ONLY when this returns a value - never by default.
   */
  getCsrfToken?: () => string | null | undefined;
}

export interface ResolvedConfig {
  map: MapConfig;
  inspectorUrl: string;
  apiBase: string;
  flavour: FlavourName;
  devNotes: boolean;
  authEnabled: boolean;
  enableHeavyOps: boolean;
  syncUrl: boolean;
  baseFilters?: Record<string, string | string[]>;
  enableStrictBBoxModes: boolean;
  metadata: MetadataMap;
  metadataScriptUrl: string | null;
  features: Required<FeatureFlags>;
  theme: ThemeConfig;
  brand: Required<BrandConfig>;
  terminal: { host: string | null; shell: ShellId | null; os: OSKind | null };
  getAuthToken: () => string | null | undefined;
  getCsrfToken: () => string | null | undefined;
}

export interface DataBrowserHandle {
  destroy(): void;
  getState(): Readonly<AppState>;
  /** Set light/dark mode from a host control. Mirrors the internal toggle and fires onModeChange. */
  setTheme(mode: "day" | "night"): void;
}

export const STREAM_CATALOGUE_MAXIMUM = 100_000;
export const MAX_FILE_SELECTION = 10;
export const SEARCH_PAGE_SIZE = 100;
