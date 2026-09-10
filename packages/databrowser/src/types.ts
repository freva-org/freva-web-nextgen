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

/**
 * THE headless search/query boundary: the smallest slice of state that DETERMINES the effective
 * REST query. Nothing here is DOM, view, or lifecycle - it is exactly what `facetQueryString()`,
 * `queryPairs()` and `buildUrlQuery()` read.
 *
 * It exists so a second consumer (the compact `/picker` entry) can build the SAME query from its
 * own, much smaller state without importing the full application. `AppState` extends it, so the
 * full browser and the picker are provably running one implementation of the facet algebra,
 * `_not_` semantics, flavour translation, base-scope gating and time/bbox representation - not two
 * that happen to agree today. See `src/search/query.ts` and `tests/search-boundary.test.ts`.
 */
export interface QueryScope {
  flavour: FlavourName;
  uniqKey: UniqKey;
  selected: Record<string, string[]>;
  /** Always-applied, invisible scope (freva-canonical keys). Merged into every server query but never
   *  shown as chips, sidebar facets, or in the URL, and never cleared by "Clear all". Set from config
   *  (baseFilters) - the "hosted filtered instance" gate, e.g. { project: ['waterpark'] }. */
  baseFilters: Record<string, string[]>;
  time: TimeSelection | null;
  bbox: BBoxSelection | null;
  /** Per-flavour translation between freva's canonical facet keys and that flavour's names, built
   *  from GET /flavours. `forward` is freva->flavour, `backward` is flavour->freva. Lets us re-key the
   *  active selection when the lens changes (model⇄source_id) using freva as the pivot. */
  flavourMaps: Record<
    string,
    { forward: Record<string, string>; backward: Record<string, string> }
  >;
}

export interface AppState extends QueryScope {
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
  /** The whole top-bar brand block (mark + title). Finer control: brand.showMark / brand.showTitle. */
  brand?: boolean;
  /**
   * The status footer strip. Default true. When false the footer consumes NO height, but status
   * and toasts keep working: the status message moves to an off-screen `aria-live` region so
   * screen-reader feedback is preserved, and toasts still appear.
   */
  footer?: boolean;
}

export interface BrandConfig {
  title?: string;
  /** short mark shown in the brand badge (glyph or ≤2 chars). */
  mark?: string;
  /** optional one-line description shown under the results scope. Set `''` to omit it. */
  description?: string;
  /** Render the brand MARK (logo/glyph). Default true. */
  showMark?: boolean;
  /** Render the brand TITLE text. Default true. */
  showTitle?: boolean;
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

/**
 * How the metadata overview is laid out before the visitor has rearranged it.
 *
 * Presentation only, and only a DEFAULT: every value here is what the panel looks like on a first
 * visit, and a visitor who drags a block or opens the additional section has their own choice
 * persisted over it. Nothing here changes which facets exist or what a query sends.
 */
export interface OverviewConfig {
  /**
   * Block keys in the order they should appear, e.g. `["project", "__time", "variable"]`.
   *
   * Time and BBox are ordered in the same flow as the facets and are named `__time` and `__bbox`,
   * because a deployment that wants the map first should be able to say so without a second option
   * for the two blocks that are not facets.
   *
   * Keys not listed keep their natural position AFTER the listed ones, so naming three keys is a
   * statement about those three and not an accidental hiding of everything else. Unset: the order
   * the API returns.
   */
  order?: string[];
  /**
   * The keys that are MAIN blocks. Everything else moves under "Show additional facets".
   *
   * Unset, this is the API's own `primary_facets`, which is the behaviour every deployment has
   * today. Set to `[]` to make every facet a main block and remove the additional section.
   */
  mainFacets?: string[];
}

export interface DataBrowserConfig {
  apiBase?: string;
  flavour?: FlavourName;
  devNotes?: boolean;
  /** ESM URL for the lazy @freva-org/data-inspector web component (CDN by default; override to a
   *  self-hosted copy). Loaded on first Inspect only - never in the main bundle. */
  inspectorUrl?: string;
  /**
   * Where the component's *global* surfaces go: the File Inspector and the
   * terminal window.
   *
   * The widget's own overlays - tooltips, popovers, the facet dropdown - belong
   * to the widget and stay inside it, positioned against `.freva-db`. Two do
   * not. The Inspector is a modal over the whole application, and the terminal
   * is a window that floats over it; both are meaningless clipped to the
   * component's box. When a host embeds the widget inside a scrolling, contained
   * region - which the portal does - it passes an element outside that region
   * here and those two mount there instead.
   *
   * Unset, they mount on the component root exactly as before, so a standalone
   * page needs to know nothing about this.
   */
  overlayRoot?: HTMLElement;
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
   *  TWO FORMS are supported:
   *
   *  • POSITIVE - `{ project: 'waterpark' }`. The scope OWNS `project`: its values render locked in
   *    the sidebar/overview, and no user include or exclude on `project` is sent, so the scope
   *    cannot be widened or contradicted.
   *  • NEGATIVE - `{ project_not_: 'cmip6' }` (or `['cmip6','cordex']`). Always sent, so the excluded
   *    values are never reachable, but the scope does NOT own `project`: the user can still narrow
   *    with `project=cordex`, which is a subset of the scope. A base-excluded value is absent from
   *    the returned facets entirely, so there is no row to lock - the UI shows an immutable
   *    `Scope: project ≠ cmip6` indicator that "Clear all" does not remove.
   *
   *  Keys are freva-canonical in BOTH forms and are translated suffix-aware when the flavour changes
   *  (`project_not_` -> `mip_era_not_`, never a literal lookup of `project_not_`).
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
   * URL of a deployment-supplied `metadata.js`, for backward compatibility only.
   *
   * The shared climate descriptions ship inside this package, so this has NO DEFAULT: leave it
   * unset and nothing is fetched and nothing is probed. Set it and that
   * script is loaded and merged ON TOP of the built-in set and UNDER the `metadata` config object.
   * Default: null.
   */
  metadataScriptUrl?: string | null;
  /**
   * Which of the two views a visitor lands on before they have chosen one.
   *
   * A DEFAULT, not a lock: the switch stays in the toolbar and a visitor's own choice is persisted
   * and wins on every later visit. Unset is `"browse"`, which is where every deployment lands
   * today. A deployment whose archive is better introduced by its shape than by its files sets
   * `"overview"` and changes nothing else.
   */
  defaultLayout?: "browse" | "overview";
  /** Default layout of the metadata overview. See {@link OverviewConfig}. */
  overview?: OverviewConfig;
  /**
   * Whether a visitor may remove a value that came from {@link DataBrowserConfig.baseFilters}.
   *
   * Default `false`, which is the behaviour every deployment has today: a scoped value renders
   * locked, cannot be toggled, and survives "Clear all", so the instance behaves as if the scope
   * were the whole archive.
   *
   * `true` makes the scope a STARTING POINT instead of a boundary - the value is applied on load
   * and shown as an ordinary selected facet the visitor can take off to see the wider archive. It
   * is the right setting for a landing page that opens on a project and a wrong one for anything
   * resembling tenancy, so it is opt-in and says so. Either way this was never an authorization
   * boundary; see `baseFilters`.
   */
  scopeRemovable?: boolean;
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
  /** The host's overlay root, if it gave one. See `DataBrowserConfig`. */
  overlayRoot?: HTMLElement;
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
  defaultLayout: "results" | "overview";
  overview: { order: readonly string[]; mainFacets: readonly string[] | null };
  scopeRemovable: boolean;
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

/**
 * Hard cap on how many files may be SELECTED at once. Selection drives per-file metadata fetches,
 * the comparison matrix and `file=`-scoped export URLs, so an unbounded selection turns a click
 * into thousands of requests and a GET URL long enough to earn a 414.
 */
export const MAX_SELECTED_FILES = 25;

/**
 * Cap for the heavy AGGREGATE action only. Lower than the selection cap on purpose: you may select
 * 25 files to compare them, but only 10 can be aggregated into one dataset.
 */
export const MAX_AGGREGATE_FILES = 10;

export const SEARCH_PAGE_SIZE = 100;

/** Loaded-row count at which the interaction-cost mitigations (see `.many-results`) switch on. */
export const MANY_RESULTS_THRESHOLD = 500;

/**
 * Conservative ceiling for a GET URL we build ourselves (`file=` repeated per selected file).
 * Browsers and proxies disagree wildly above ~8k; servers commonly answer 414 well before their
 * documented limit. We refuse before sending rather than surfacing an opaque failure.
 */
export const MAX_EXPORT_URL_LENGTH = 6000;
