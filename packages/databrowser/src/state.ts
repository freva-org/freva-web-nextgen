// state.ts - the single in-memory AppState, pure selectors, the wire->view boundary,
// and the query/command string builders. No DOM here.

import type {
  ApiRow,
  AppState,
  BBoxSelection,
  Facet,
  FileRow,
  FlavourName,
  QueryScope,
  ResolvedConfig,
  SearchResult,
  SelectMode,
  SolrFlatFacets,
  TimeSelection,
  UniqKey,
} from "./types.js";

export const BUILTIN_FLAVOURS: FlavourName[] = ["freva", "cmip5", "cmip6", "cordex", "user"];

/** Primary facet order used only as a fallback before a response supplies primary_facets. */
export const PRIMARY_FACET_FALLBACK = [
  "project",
  "product",
  "institute",
  "model",
  "experiment",
  "time_frequency",
  "realm",
  "variable",
  "ensemble",
  "time_aggregation",
];

/** Additional (non-primary) facet keys, used for autocomplete before a search loads facets. */
export const ADDITIONAL_FACET_FALLBACK = [
  "cmor_table",
  "dataset",
  "driving_model",
  "format",
  "grid_label",
  "level_type",
  "rcm_name",
  "rcm_version",
  "fs_type",
  "grid_id",
  "user",
];

/** Heuristic: when the sample hits this size, assume the real value list is larger. */
const FACET_VALUE_SAMPLE = 100;

/** Facets always known to have huge value lists - used only as a display fallback. */
const KNOWN_LARGE = new Set(["variable", "ensemble"]);

export function createInitialState(cfg: ResolvedConfig): AppState {
  return {
    flavour: cfg.flavour,
    uniqKey: "file",
    selected: {},
    baseFilters: {},
    time: null,
    bbox: null,

    rows: [],
    totalCount: 0,
    facets: [],
    primaryFacets: [],
    overviewShape: [],
    facetMapping: {},
    attributeKeys: [],
    flavours: [...BUILTIN_FLAVOURS],
    flavourMaps: structuredClone(BUILTIN_FLAVOUR_MAPS),
    start: 0,
    search: "idle",
    lastRequestId: 0,
    facetsVersion: 0,
    rowsVersion: 0,
    rowsEpoch: 0,

    layout: "results",
    theme: "night",
    view: "list",

    pickedKeys: new Set<string>(),
    focusKey: null,
    detailSource: "focus",
    detailsOpen: false,
    details: "idle",
    detailsCache: new Map<string, FileRow>(),

    terminalDraft: "",
    externalEdits: 0,
    terminalFocused: false,
    terminalTab: "cli",

    overviewFilters: {},
    overviewSort: {},
    overviewCollapsed: new Set<string>(),
    overviewAddOpen: false,
    overviewSpan: {},
    overviewStacked: false,
    overviewStackSeen: [],
    overviewSnapshot: null,
    overviewH: {},
    overviewOrder: [],
    overviewStale: false,

    sidebarOpen: new Set<string>(),
    sidebarAddOpen: false,
    sidebarSeeded: false,
    sidebarCollapsed: false,

    status: "",

    metadata: {},
    metadataVersion: 0,
  };
}

// Selectors / mutators (pure where practical)

/** Snapshot the current facets' keys+labels when there are any, so the overview can keep rendering
 *  those blocks (empty) on a later no-match query instead of collapsing the layout. */
export function rememberOverviewShape(state: AppState): void {
  const withValues = state.facets.filter((f) => f.values.length);
  if (!withValues.length) return;
  // MERGE the newly-observed facets into the remembered shape (add/update labels), never replace the
  // whole snapshot - a partial response (Project has values this time, Model doesn't) must not drop
  // Model from the shape, or a later all-empty response could no longer restore it. (setFlavour still
  // clears the shape, so it never leaks across a lens switch.)
  const byKey = new Map(state.overviewShape.map((s) => [s.key, s]));
  for (const f of withValues) byKey.set(f.key, { key: f.key, label: f.label });
  state.overviewShape = [...byKey.values()];
}

/** The facets to lay out in the overview: current ones, PLUS any remembered block that matched
 *  nothing this time (rendered empty), so the grid stays stable. Preserves remembered order. */
export function overviewFacets(state: AppState): Facet[] {
  const byKey = new Map(state.facets.map((f) => [f.key, f]));
  const out: Facet[] = [];
  const seen = new Set<string>();
  for (const s of state.overviewShape) {
    const cur = byKey.get(s.key);
    out.push(cur ?? { key: s.key, label: s.label, values: [], hasMore: false });
    seen.add(s.key);
  }
  for (const f of state.facets) if (!seen.has(f.key)) out.push(f); // any new facet not yet remembered
  return out;
}

// Negative (excluded) facet selections
//
// freva-rest's UNAMBIGUOUS negation form is a KEY suffix: `project_not_=cmip6` (see
// freva-rest/src/freva_rest/databrowser_api/core.py - `_validate_query_params()` strips `_not_`
// before validating the key, and `_join_facet_queries()` turns a `_not_` key into an exclusion).
// We adopt that as the browser's canonical representation, so the existing
// `Record<string, string[]>` selection shape is unchanged and serialises straight through the
// query string, the URL, the CLI tokens and the python kwargs.
//
// The REST API ALSO accepts legacy VALUE prefixes (`not `, `!`, `-`). We deliberately do NOT parse
// those here: a genuine positive value that begins with one of them (the real `ensemble` value
// "not set") is indistinguishable from a negation, so inferring it would silently turn a real
// filter into its opposite. See splitNegation() below.

/** The canonical negation suffix on a facet KEY. */
export const NEG_SUFFIX = "_not_";

/**
 * Split a canonical facet key into its underlying (positive) facet key and whether it negates.
 * `_not_` is recognised ONLY as a suffix, and only when something precedes it - `_not_` on its own
 * is an ordinary (if odd) key, not a negation of the empty key.
 */
export function parseFacetKey(key: string): { baseKey: string; negated: boolean } {
  if (key.length > NEG_SUFFIX.length && key.toLowerCase().endsWith(NEG_SUFFIX)) {
    return { baseKey: key.slice(0, key.length - NEG_SUFFIX.length), negated: true };
  }
  return { baseKey: key, negated: false };
}

/** The negative key for a base facet (`project` -> `project_not_`). Idempotent. */
export function negativeKey(baseKey: string): string {
  return parseFacetKey(baseKey).negated ? baseKey : `${baseKey}${NEG_SUFFIX}`;
}

/** The underlying positive facet key for any canonical key. */
export function baseFacetKey(key: string): string {
  return parseFacetKey(key).baseKey;
}

/** The canonical key for (base facet, mode). */
export function keyForMode(baseKey: string, negated: boolean): string {
  return negated ? negativeKey(baseKey) : baseFacetKey(baseKey);
}

/** Values the user has INCLUDED for a base facet. */
export function includedValues(state: QueryScope, baseKey: string): string[] {
  return state.selected[baseFacetKey(baseKey)] ?? [];
}

/** Values the user has EXCLUDED for a base facet. */
export function excludedValues(state: QueryScope, baseKey: string): string[] {
  return state.selected[negativeKey(baseKey)] ?? [];
}

/** How many user selections (include + exclude) a base facet carries - what the badges count. */
export function facetSelectionCount(state: QueryScope, baseKey: string): number {
  return includedValues(state, baseKey).length + excludedValues(state, baseKey).length;
}

/** Clear BOTH modes for one base facet (the facet-header "clear this facet" affordance). */
export function clearFacetModes(state: QueryScope, baseKey: string): void {
  delete state.selected[baseFacetKey(baseKey)];
  delete state.selected[negativeKey(baseKey)];
}

/**
 * Clear ONE mode of one base facet, leaving the other alone.
 *
 * The `+N` and `-N` badges are separate controls precisely so "stop excluding these three" does not
 * also throw away the two values the user chose to keep. `clearFacetModes` remains the both-modes
 * operation for the places that mean both.
 */
export function clearFacetMode(state: QueryScope, baseKey: string, negative: boolean): void {
  delete state.selected[negative ? negativeKey(baseKey) : baseFacetKey(baseKey)];
}

/**
 * Translate a canonical key between flavours, suffix-aware: the BASE key is translated
 * (`project` <-> `mip_era`) and the `_not_` suffix is reapplied afterwards. Translating the literal
 * `project_not_` would find no mapping and silently pass a mis-keyed exclusion to the backend.
 */
export function translateFacetKey(
  state: QueryScope,
  key: string,
  from: string,
  to: string,
): string {
  const { baseKey, negated } = parseFacetKey(key);
  return keyForMode(translateKey(state, baseKey, from, to), negated);
}

/** True when the user has INCLUDED (key, value). Gated base-scope values also read as selected. */
export function isSelected(state: QueryScope, key: string, value: string): boolean {
  const base = baseFacetKey(key);
  return (state.selected[base] ?? []).includes(value) || isGatedValue(state, base, value);
}

/** True when the user has EXCLUDED (key, value). */
export function isExcluded(state: QueryScope, key: string, value: string): boolean {
  return excludedValues(state, key).includes(value);
}

/**
 * Set/unset one (facet, value) in one mode. The two modes are MUTUALLY EXCLUSIVE: choosing one
 * removes the pair from the other first, so a single search is committed and the pair can never be
 * both required and forbidden.
 */
export function toggleFacetMode(
  state: QueryScope,
  baseKey: string,
  value: string,
  negated: boolean,
): void {
  const other = keyForMode(baseKey, !negated);
  const otherArr = state.selected[other];
  if (otherArr) {
    const j = otherArr.indexOf(value);
    if (j >= 0) {
      otherArr.splice(j, 1);
      if (otherArr.length === 0) delete state.selected[other];
    }
  }
  toggleSelected(state, keyForMode(baseKey, negated), value);
}

/** True when (key,value) is part of the POSITIVE base scope for the current flavour - a LOCKED
 *  selection that shows as active in the sidebar/overview but is never a removable chip and can't
 *  be toggled. A NEGATIVE base filter gates nothing here: its value is absent from the returned
 *  facets entirely, so there is no row to lock (see baseScopeExclusions). */
export function isGatedValue(state: QueryScope, key: string, value: string): boolean {
  const lk = baseFacetKey(key).toLowerCase();
  for (const bk of Object.keys(state.baseFilters)) {
    const { baseKey, negated } = parseFacetKey(bk);
    if (negated) continue;
    if (
      translateKey(state, baseKey, "freva", state.flavour).toLowerCase() === lk &&
      state.baseFilters[bk].includes(value)
    ) {
      return true;
    }
  }
  return false;
}

/** True when `key` (in the CURRENT flavour's naming) is owned by the base scope. Such a key is
 *  inescapable: the UI must not let it be toggled, chipped, completed, or queried outside the gate. */
export function isGatedKey(state: QueryScope, key: string): boolean {
  // Suffix-aware: `project_not_` is a user selection on the gated BASE key `project`, so it must be
  // refused for the same reason a positive `project=` is - it would contradict the locked scope.
  return baseFilterKeys(state).has(baseFacetKey(key).toLowerCase());
}

/** Values to DISPLAY for a facet. A gated key shows ONLY its scope values (never any out-of-scope
 *  value a mis-scoped/buggy server might return), so the locked facet can't present an escape hatch. */
export function displayFacetValues(
  state: QueryScope,
  facet: Facet,
): Array<{ value: string; count: number }> {
  if (!isGatedKey(state, facet.key)) return facet.values;
  return facet.values.filter((v) => isGatedValue(state, facet.key, v.value));
}

/** The base scope's (key, value) pairs in the CURRENT flavour's naming, INCLUDING any negative
 *  (`<key>_not_`) scope. Used to annotate the printed CLI command / python call so a copied
 *  `freva-client …` reproduces the SAME scoped results the widget shows. */
export function baseScopePairs(state: QueryScope): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, vs] of Object.entries(state.baseFilters)) {
    const fk = translateFacetKey(state, k, "freva", state.flavour); // suffix-aware
    for (const v of vs) out.push([fk, v]);
  }
  return out;
}

/**
 * The NEGATIVE half of the base scope, as (base facet key in the current flavour, value) pairs.
 * A base-excluded value never appears in the returned facet list, so there is no row to lock -
 * the UI renders these as an immutable "Scope: project ≠ cmip6" indicator instead, which Clear All
 * does not touch.
 */
export function baseScopeExclusions(state: QueryScope): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, vs] of Object.entries(state.baseFilters)) {
    const { baseKey, negated } = parseFacetKey(k);
    if (!negated) continue;
    const fk = translateKey(state, baseKey, "freva", state.flavour);
    for (const v of vs) out.push([fk, v]);
  }
  return out;
}

export function toggleSelected(state: QueryScope, key: string, value: string): void {
  const arr = state.selected[key] ?? (state.selected[key] = []);
  const i = arr.indexOf(value);
  if (i >= 0) {
    arr.splice(i, 1);
    if (arr.length === 0) delete state.selected[key];
  } else {
    arr.push(value);
  }
}

export function clearAll(state: QueryScope): void {
  state.selected = {};
  state.time = null;
  state.bbox = null;
}

/** Clear every selected value for ONE facet - INCLUDED and EXCLUDED alike (the header-badge
 *  "clear this facet" affordance, which counts both). */
export function clearSelectedFacet(state: QueryScope, key: string): void {
  clearFacetModes(state, key);
}

export function hasAnySelection(state: QueryScope): boolean {
  return Object.keys(state.selected).length > 0 || !!state.time || !!state.bbox;
}

export function humaniseKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Display label for a facet key. Needs only the mapping, so the picker can call it too. */
export function labelFor(state: { facetMapping: Record<string, string> }, key: string): string {
  return state.facetMapping[key] ?? humaniseKey(key);
}

/** Build the per-flavour forward (freva->flavour) / backward (flavour->freva) tables from GET /flavours.
 *  Malformed entries are skipped rather than throwing - flavour context is optional. */
export function buildFlavourMaps(
  list: ReadonlyArray<{ flavour_name?: unknown; mapping?: unknown }>,
): Record<string, { forward: Record<string, string>; backward: Record<string, string> }> {
  const out: Record<string, { forward: Record<string, string>; backward: Record<string, string> }> =
    {};
  for (const entry of list) {
    const name = typeof entry.flavour_name === "string" ? entry.flavour_name : null;
    const mapping = entry.mapping;
    if (!name || !mapping || typeof mapping !== "object") continue;
    const forward: Record<string, string> = {};
    const backward: Record<string, string> = {};
    for (const [freva, flav] of Object.entries(mapping as Record<string, unknown>)) {
      if (typeof flav !== "string") continue;
      forward[freva] = flav;
      backward[flav] = freva; // last-wins if two freva keys collide onto one flavour key (shouldn't happen)
    }
    out[name] = { forward, backward };
  }
  return out;
}

/** A facet key expressed in `from`'s flavour -> the same concept in `to`'s flavour, pivoting through
 *  freva's canonical name. Unmapped keys (flavour-specific, or maps not loaded yet) pass through. */
export function translateKey(state: QueryScope, key: string, from: string, to: string): string {
  if (from === to) return key;
  const freva = state.flavourMaps[from]?.backward[key] ?? key; // flavour->freva
  return state.flavourMaps[to]?.forward[freva] ?? freva; // freva->flavour
}

/** Re-key an entire selection (values untouched) from one flavour's names to another's. */
export function translateSelection(
  state: QueryScope,
  selected: Record<string, string[]>,
  from: string,
  to: string,
): Record<string, string[]> {
  if (from === to) return selected;
  const out: Record<string, string[]> = {};
  // Suffix-aware: translate `project` and reapply `_not_`, never the literal `project_not_`.
  for (const [k, v] of Object.entries(selected)) out[translateFacetKey(state, k, from, to)] = v;
  return out;
}

// The builtin flavour lookups are STATIC in freva-rest (translator.py). Baking them in as a fallback
// removes the lens-switch-vs-/flavours race entirely: re-keying works from the first paint, and a
// failed /flavours fetch degrades to correct builtin behaviour instead of passing keys through wrong.
// GET /flavours still overrides/extends these at runtime (e.g. custom flavours).
const FREVA_KEYS = [
  "project",
  "product",
  "institute",
  "model",
  "experiment",
  "time_frequency",
  "realm",
  "variable",
  "ensemble",
  "time_aggregation",
  "cmor_table",
  "dataset",
  "driving_model",
  "format",
  "grid_id",
  "grid_label",
  "level_type",
  "rcm_name",
  "rcm_version",
  "fs_type",
];
const FLAVOUR_OVERRIDES: Record<string, Record<string, string>> = {
  cmip5: { ensemble: "member_id", institute: "institution_id", model: "model_id" },
  cmip6: {
    experiment: "experiment_id",
    ensemble: "member_id",
    institute: "institution_id",
    model: "source_id",
    project: "mip_era",
    product: "activity_id",
    variable: "variable_id",
    time_frequency: "frequency",
    cmor_table: "table_id",
  },
  cordex: { institute: "institution", product: "domain" },
};
export const BUILTIN_FLAVOUR_MAPS: Record<
  string,
  { forward: Record<string, string>; backward: Record<string, string> }
> = buildFlavourMaps(
  ["freva", "cmip5", "cmip6", "cordex"].map((name) => {
    const over = FLAVOUR_OVERRIDES[name] ?? {};
    const mapping: Record<string, string> = {};
    for (const k of FREVA_KEYS) mapping[k] = over[k] ?? k;
    return { flavour_name: name, mapping };
  }),
);

/**
 * The human description for a facet VALUE from metadata.js (config-or-script), or null when
 * none is known. Facet keys can be flavour-labelled, but metadata.js is keyed by the NATIVE
 * facet key (project, variable, …), so we look up by the raw key. Degrades silently to null.
 */
export function describeValue(state: AppState, key: string, value: string): string | null {
  // With server-side translation on, `key` is in the current flavour's naming (source_id, mip_era…),
  // but metadata.js is keyed by the NATIVE freva key (model, project…). Map back before the lookup.
  const nativeKey = state.flavourMaps[state.flavour]?.backward[key] ?? key;
  const block = state.metadata[nativeKey] ?? state.metadata[key];
  const desc = block ? block[value] : undefined;
  return typeof desc === "string" && desc.length > 0 ? desc : null;
}

/**
 * The set of facet keys currently known to be valid - the union of loaded facet keys, the
 * overview attribute keys, and the primary-facet keys, lowercased to match parseFacetTokens.
 * Used to keep the terminal from committing unknown keys into the live query. Empty
 * means metadata has not loaded yet, in which case the caller should not guess.
 */
export function knownFacetKeys(state: AppState): Set<string> {
  const s = new Set<string>();
  for (const f of state.facets) s.add(f.key.toLowerCase());
  for (const k of state.attributeKeys) s.add(k.toLowerCase());
  for (const k of state.primaryFacets) s.add(k.toLowerCase());
  return s;
}

/**
 * A facet whose value list is a trustworthy COMPLETE domain we can validate values against.
 * Returns null (⇒ no value validation) when:
 *  - the facet is unknown or its list is a truncated sample (hasMore) or empty; OR
 *  - the key is CURRENTLY SELECTED. A search filtered on key K collapses K's own facet list
 *    to the matching value(s), so that list is NOT K's global domain - validating an OR
 *    addition (e.g. adding project=cmip5 while project=cmip6 is active) against it would
 *    wrongly reject a legitimate broadening. Additions to an already-filtered key are
 *    therefore left to the backend. Key match is case-insensitive.
 */
export function closedValueSet(state: AppState, key: string): Set<string> | null {
  // Suffix-aware: the domain of `project_not_` is the domain of `project`. Either MODE having
  // values collapses that list (an exclusion removes the excluded value from the facet response
  // entirely), so both are checked before trusting it.
  const lk = baseFacetKey(key).toLowerCase();
  if ((state.selected[lk] ?? []).length > 0) return null; // self-filtered ⇒ list is collapsed
  if ((state.selected[negativeKey(lk)] ?? []).length > 0) return null; // excluded values are gone
  const facet = state.facets.find((f) => f.key.toLowerCase() === lk);
  if (!facet || facet.hasMore || facet.values.length === 0) return null;
  return new Set(facet.values.map((v) => v.value));
}

export interface CommitFilterResult {
  /** key -> values that passed both the known-key and closed-value-set guards. */
  accepted: Record<string, string[]>;
  /** tokens that were rejected, as `key=value` strings (for status / keep-in-input UX). */
  rejected: string[];
}

/**
 * THE single commit guard: given parsed `key=value` tokens, keep only
 * - keys in knownFacetKeys (when metadata has loaded; with no metadata nothing commits), and
 * - values that pass the closed-value-set check for their key (open sets accept anything).
 * Both the terminal and the top search bar MUST route through this before touching
 * state.selected, so nothing invalid can reach the backend from either entry point.
 */
export function filterCommittable(
  state: AppState,
  parsed: Record<string, string[]>,
): CommitFilterResult {
  const accepted: Record<string, string[]> = {};
  const rejected: string[] = [];
  const known = knownFacetKeys(state);
  const gated = baseFilterKeys(state); // the scope owns these - terminal input must not touch them
  const rej = (key: string, v: string): void => {
    rejected.push(`${key}=${shellQuote(v)}`);
  };
  for (const key of Object.keys(parsed)) {
    // Validate/look up the UNDERLYING positive facet key: `project_not_` is committable exactly
    // when `project` is. The canonical (suffixed) key is what lands in state.selected.
    const base = baseFacetKey(key).toLowerCase();
    if (gated.has(base) || known.size === 0 || !known.has(base)) {
      for (const v of parsed[key]) rej(key, v);
      continue;
    }
    const closed = closedValueSet(state, key);
    for (const v of parsed[key]) {
      if (closed && !closed.has(v)) {
        rej(key, v);
        continue;
      }
      (accepted[key] ?? (accepted[key] = [])).push(v);
    }
  }
  // A (facet, value) can never be both required and forbidden. If a draft asks for both, the
  // INCLUDE wins and the exclusion is reported as rejected, so the contradiction is visible in the
  // terminal rather than silently resolved on the wire.
  for (const key of Object.keys(accepted)) {
    const { baseKey, negated } = parseFacetKey(key);
    if (!negated) continue;
    const positives = accepted[baseKey];
    if (!positives?.length) continue;
    const kept = accepted[key].filter((v) => {
      if (!positives.includes(v)) return true;
      rej(key, v);
      return false;
    });
    if (kept.length) accepted[key] = kept;
    else delete accepted[key];
  }
  return { accepted, rejected };
}

/** Order-insensitive equality of two selection maps - the change-detection primitive. */
export function selectionsEqual(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (!bv || av.length !== bv.length) return false;
    // OR-values are a set: compare membership, not position (a=["x","y"] equals b=["y","x"]).
    const bset = new Set(bv);
    for (const v of av) if (!bset.has(v)) return false;
  }
  return true;
}

// Wire -> view normalisation (the ONLY place this conversion happens)

export function fromApiRow(r: ApiRow, uniqKey: UniqKey): FileRow {
  const key = uniqKey === "uri" ? String(r.uri ?? r.file) : r.file;
  return { key, file: r.file, fsType: r.fs_type, raw: r };
}

/** Parse a Solr-flat facet array ([value, count, value, count, …]) into typed pairs. */
export function parseSolrFacetArray(arr: Array<string | number>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (let i = 0; i + 1 < arr.length; i += 2) {
    out.push([String(arr[i]), Number(arr[i + 1])]);
  }
  return out;
}

/**
 * Build the ordered Facet[] from a SearchResult. primary_facets order is API-driven:
 * primaries first in the order the response gives, then any remaining keys.
 */
export function buildFacets(res: SearchResult): Facet[] {
  const flat: SolrFlatFacets = res.facets ?? {};
  const mapping = res.facet_mapping ?? {};
  const primary = res.primary_facets ?? [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const k of primary) {
    if (k in flat && !seen.has(k)) {
      keys.push(k);
      seen.add(k);
    }
  }
  for (const k of Object.keys(flat)) {
    if (!seen.has(k)) {
      keys.push(k);
      seen.add(k);
    }
  }
  return keys.map((key) => {
    const pairs = parseSolrFacetArray(flat[key] ?? []);
    const values = pairs.map(([value, count]) => ({ value, count }));
    const hasMore = values.length >= FACET_VALUE_SAMPLE || KNOWN_LARGE.has(key);
    return { key, label: mapping[key] ?? humaniseKey(key), values, hasMore };
  });
}

/** Per-file metadata lives in the ?file= response's `facets` block. */
export function metaFromFacetsBlock(
  flat: SolrFlatFacets,
): Record<string, string | string[] | number> {
  const meta: Record<string, string | string[] | number> = {};
  for (const [key, arr] of Object.entries(flat)) {
    const pairs = parseSolrFacetArray(arr);
    if (pairs.length === 0) continue; // empty [] = not applicable for this file
    const vals = pairs.map((p) => p[0]);
    meta[key] = vals.length === 1 ? vals[0] : vals;
  }
  return meta;
}

/**
 * Derive a time range from the filename when parseable (…_<YYYYMM>-<YYYYMM>.nc etc.),
 * else null. Never fabricates coordinates (TODO(verify V10): backend-supplied extent).
 */
export function timeRangeFromFilename(file: string): string | null {
  const base = file.split("/").pop() ?? file;
  const m = base.match(/_(\d{4,8})-(\d{4,8})(?:\.\w+)?$/);
  if (!m) return null;
  const fmt = (s: string): string | null => {
    // Only real calendar precisions: YYYY, YYYYMM, YYYYMMDD. Anything else - 5/7 digits, month 00 or
    // >12, day 00 or >31 (e.g. a version suffix like _20241301) - is NOT a date, so return null and
    // show an honest gap rather than a fabricated range.
    if (s.length !== 4 && s.length !== 6 && s.length !== 8) return null;
    const year = s.slice(0, 4);
    if (s.length === 4) return year;
    const mo = Number(s.slice(4, 6));
    if (mo < 1 || mo > 12) return null;
    if (s.length === 6) return `${year}-${s.slice(4, 6)}`;
    const day = Number(s.slice(6, 8));
    if (day < 1 || day > 31) return null;
    return `${year}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  };
  const a = fmt(m[1]);
  const b = fmt(m[2]);
  if (!a || !b) return null;
  // Reject impossible calendar dates (2024-02-31, 2024-04-31) and reversed ranges (2100->2000): an
  // inferred range that couldn't exist on a calendar is fabricated metadata, not an honest hint.
  if (!validTimeBound(a) || !validTimeBound(b)) return null;
  if (timeBoundKey(a) > timeBoundKey(b)) return null;
  return `${a} → ${b}`;
}

// Query + command builders

const enc = encodeURIComponent;

/**
 * KNOWN BACKEND LIMITATION - the legacy value-prefix negation.
 *
 * freva-rest also accepts negation written into the VALUE (`project="not cmip6"`, `!cmip6`,
 * `-cmip6`). The web client deliberately does NOT parse that form, in either direction:
 *
 *  • Reading it would corrupt genuine values. The real `ensemble` value "not set" would become
 *    `ensemble_not_=set`, silently inverting a filter the user asked for.
 *  • Writing it would be ambiguous for exactly the same reason.
 *
 * So negation here is ALWAYS the explicit `<key>_not_` key form, and a value that happens to begin
 * with `not `, `!` or `-` is preserved verbatim and sent as an ordinary positive value. That value
 * is still ambiguous ON THE WIRE - freva-rest will read it as a negation - and no client-side
 * workaround can fix that. Resolving it requires an escaping contract in the REST API (e.g. a
 * documented `\` escape, or making `_not_` keys the only negation form). Until then this is a
 * genuine backend limitation, recorded here rather than papered over with a guess.
 */
export const LEGACY_VALUE_NEGATION_PREFIXES = ["not ", "!", "-"] as const;

/** Ordered key=value pairs for the query string. Multi-value -> repeated key (OR). Values verbatim. */
export function facetPairs(state: QueryScope): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const key of Object.keys(state.selected)) {
    for (const value of state.selected[key]) pairs.push([key, value]);
  }
  return pairs;
}

/** Time params: UNBRACKETED `time=<start> TO <end>` + time_select. */
function timePairs(time: TimeSelection | null): Array<[string, string]> {
  if (!time || (!time.from && !time.to)) return [];
  const from = time.from || "1";
  const to = time.to || "9999";
  return [
    ["time", `${from} TO ${to}`],
    ["time_select", time.mode],
  ];
}

/** BBox params: bbox=minLon,maxLon,minLat,maxLat + bbox_select. */
function bboxPairs(bbox: BBoxSelection | null): Array<[string, string]> {
  if (!bbox) return [];
  const v = `${bbox.minLon},${bbox.maxLon},${bbox.minLat},${bbox.maxLat}`;
  return [
    ["bbox", v],
    ["bbox_select", bbox.mode],
  ];
}

/** All query pairs (facets + time + bbox), in stable order. */
export function queryPairs(state: QueryScope): Array<[string, string]> {
  return [...facetPairs(state), ...timePairs(state.time), ...bboxPairs(state.bbox)];
}

/** Normalize the baseFilters config (string | string[] values) into Record<string,string[]>. */
export function normalizeBaseFilters(
  input?: Record<string, string | string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!input) return out;
  for (const [k, v] of Object.entries(input)) {
    const vals = (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter((x) => x.length > 0);
    if (vals.length) out[k] = vals;
  }
  return out;
}

/**
 * Base-scope facet keys the scope OWNS, in the CURRENT flavour's naming. Their facet still renders,
 * but its values show as LOCKED (non-toggleable) and the key never becomes a chip, URL param, or
 * terminal token.
 *
 * ONLY POSITIVE base filters own a key. A negative base filter (`project_not_: cmip6`) narrows the
 * scope without claiming the facet: the user must still be able to narrow further with a positive
 * `project=cordex`, which is a subset of the scope and therefore cannot escape it.
 */
export function baseFilterKeys(state: QueryScope): Set<string> {
  const s = new Set<string>();
  for (const k of Object.keys(state.baseFilters)) {
    const { baseKey, negated } = parseFacetKey(k);
    if (negated) continue;
    s.add(translateKey(state, baseKey, "freva", state.flavour).toLowerCase());
  }
  return s;
}

/** Facet pairs actually sent to the server: the invisible base scope (freva->current flavour) UNIONed
 *  with the user's selection. The URL and chips use `facetPairs`/`selected` only, so the gate never
 *  shows; only the wire query carries it. */
function wireFacetPairs(state: QueryScope): Array<[string, string]> {
  const gated = baseFilterKeys(state); // flavour-named BASE keys the scope owns
  const merged: Record<string, string[]> = {};
  for (const [k, vs] of Object.entries(state.baseFilters)) {
    const fk = translateFacetKey(state, k, "freva", state.flavour); // base keys are freva-canonical
    // Deduplicate: two freva-canonical base keys can translate onto the SAME flavour key, and a
    // user's URL selection may repeat a value the scope already sends. A repeated pair is harmless
    // to Solr but makes the wire query - and every command copied from it - misleading.
    const cur = (merged[fk] ??= []);
    for (const v of vs) if (!cur.includes(v)) cur.push(v);
  }
  for (const [k, vs] of Object.entries(state.selected)) {
    // A gated BASE key is INESCAPABLE: neither `project=` nor `project_not_=` from the user may
    // widen or contradict it (`project_not_=waterpark` would empty a waterpark-scoped instance).
    if (gated.has(baseFacetKey(k).toLowerCase())) continue;
    const cur = (merged[k] ??= []);
    for (const v of vs) if (!cur.includes(v)) cur.push(v);
  }
  const pairs: Array<[string, string]> = [];
  for (const key of Object.keys(merged)) for (const v of merged[key]) pairs.push([key, v]);
  return pairs;
}

/** Encoded query string (no leading separator); keys AND values encodeURIComponent'd. */
export function facetQueryString(state: QueryScope): string {
  return [...wireFacetPairs(state), ...timePairs(state.time), ...bboxPairs(state.bbox)]
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join("&");
}

/** Serialize the shareable state (flavour + facets + time + bbox) into a URL query string. The
 *  facet keys are already in the CURRENT flavour's names (translate=true), so the link reproduces
 *  the exact view. `freva` is the default and is left implicit to keep those URLs clean. */
export function buildUrlQuery(state: QueryScope): string {
  const p = new URLSearchParams();
  if (state.flavour && state.flavour !== "freva") p.set("flavour", state.flavour);
  for (const [k, v] of queryPairs(state)) p.append(k, v);
  return p.toString();
}

/** Inverse of buildUrlQuery: read a shareable link back into state pieces. Reuses the same control
 *  parser the terminal uses, so time/bbox grammar stays identical. Facet keys are taken verbatim -
 *  they're already in the (URL-declared) flavour's naming. */
export function parseUrlQuery(search: string): {
  flavour: string | null;
  selected: Record<string, string[]>;
  time: TimeSelection | null;
  bbox: BBoxSelection | null;
} {
  const p = new URLSearchParams(search);
  let flavour: string | null = null;
  const record: Record<string, string[]> = {};
  for (const [k, v] of p.entries()) {
    if (k === "flavour") {
      flavour = v;
      continue;
    }
    // Never let a host/API transport parameter masquerade as a facet - these control the request or
    // the export cap and must only ever come from the component, never the address bar.
    if (URL_RESERVED_KEYS.has(k)) continue;
    (record[k] ??= []).push(v);
  }
  const { time, bbox, rest } = parseControlTokens(record);
  return { flavour, selected: rest, time, bbox };
}
/** Transport/safety parameters the component owns; they must never be imported from the URL. */
export const URL_RESERVED_KEYS = new Set([
  "translate",
  "max-results",
  "start",
  "fields",
  "facets",
  "multi-version",
  "multi_version",
  "uniq_key",
]);

/**
 * Query string with every pair for `excludeKey` removed - used to scope autocomplete
 * enrichment so the value list for the key being completed isn't collapsed by that key's
 * own committed values - the enrich call must not destroy its own candidate list.
 */
export function facetQueryStringExcluding(state: QueryScope, excludeKey: string): string {
  // Uses the base-aware WIRE pairs, not selection-only, so completions are scoped to baseFilters just
  // like the main search. The excluded key is the one being completed - but a GATED key's base pair is
  // never dropped, so completing a gated key can't fire an unscoped metadata query that leaks values
  // from outside the hosted scope (fail-closed).
  const gated = baseFilterKeys(state);
  // Base-aware: completing `project_not_` must also drop the committed `project` pairs (and vice
  // versa), because either mode collapses the SAME candidate list.
  const excludeBase = baseFacetKey(excludeKey).toLowerCase();
  return [...wireFacetPairs(state), ...timePairs(state.time), ...bboxPairs(state.bbox)]
    .filter(([k]) => {
      const base = baseFacetKey(k).toLowerCase();
      return base !== excludeBase || gated.has(base);
    })
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join("&");
}

/**
 * Double-quote a value that contains whitespace OR a literal quote so the TERMINAL EDITOR's
 * tokenizer round-trips it. Inside the quoted form, `\` and `"` are escaped - exactly the
 * escapes tokenizeRich cooks back. NOTE: this is the editor grammar, not a shell-safe
 * quoter - double quotes do not suppress `$(…)`, backticks or `$VAR`. For a command the user
 * copies INTO a shell, use posixQuote (below).
 */
export function shellQuote(v: string): string {
  return /[\s"]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

/**
 * POSIX-shell-safe single-quoting for the COPYABLE CLI command. Single quotes suppress every
 * form of shell expansion (`$(…)`, backticks, `$VAR`, globs, `;`/`&`/`|`), so a catalogue
 * value like `$(rm -rf ~)` pasted into a terminal is inert. An embedded single quote is closed,
 * escaped and reopened via the standard `'\''` idiom. Bare tokens with no shell-significant
 * characters are left unquoted for readability.
 */
export function posixQuote(v: string): string {
  if (v === "") return "''";
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(v)) return v; // safe bare token
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/** Just the facet tokens (no time/bbox) - the terminal textarea owns only these. */
export function facetOnlyTokens(state: AppState): string {
  return facetPairs(state)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
}

/**
 * One segment of a command line: either a whitespace run or a token. `raw` is the verbatim
 * slice of the input (quotes and escapes intact - what the highlighter must render);
 * `value` is the cooked token (quotes removed, `\"` -> `"`, `\\` -> `\` inside quotes).
 * `start`/`end` are the raw offsets, so the terminal can locate the token under the caret.
 */
export interface TokenSegment {
  kind: "ws" | "tok";
  raw: string;
  value: string;
  start: number;
  end: number;
}

/**
 * Quote-aware segmentation of a command line. Double-quoted runs keep whitespace inside one
 * token; inside quotes `\"` is a literal quote and `\\` a literal backslash (exactly what
 * shellQuote emits); any other backslash is literal (so Windows-ish paths survive). Newlines
 * count as whitespace. tokenize(), parseFacetTokens() and the terminal highlighter all consume
 * THIS segmentation, so they can never disagree.
 */
export function tokenizeRich(text: string): TokenSegment[] {
  const segs: TokenSegment[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const start = i;
    if (/\s/.test(text[i])) {
      while (i < n && /\s/.test(text[i])) i++;
      segs.push({
        kind: "ws",
        raw: text.slice(start, i),
        value: text.slice(start, i),
        start,
        end: i,
      });
      continue;
    }
    let value = "";
    let inQuote = false;
    while (i < n) {
      const c = text[i];
      if (!inQuote && /\s/.test(c)) break;
      if (c === '"') {
        inQuote = !inQuote;
        i++;
        continue;
      }
      if (inQuote && c === "\\" && i + 1 < n && (text[i + 1] === '"' || text[i + 1] === "\\")) {
        value += text[i + 1];
        i += 2;
        continue;
      }
      value += c;
      i++;
    }
    segs.push({ kind: "tok", raw: text.slice(start, i), value, start, end: i });
  }
  return segs;
}

/**
 * Whitespace-split a command line into cooked tokens, respecting double-quoted runs so a
 * value containing spaces stays one token. Built on tokenizeRich (single grammar).
 */
export function tokenize(text: string): string[] {
  return tokenizeRich(text)
    .filter((s) => s.kind === "tok")
    .map((s) => s.value);
}

/**
 * Parse `key=value` tokens into a selection map. Repeated keys OR-join (multi-value);
 * duplicate identical tokens collapse. Tokens without a value (`key=`) or without `=` are
 * ignored here (they are flagged separately during highlighting). Negation is not parsed here.
 */
export function parseFacetTokens(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const tok of tokenize(text)) {
    const eq = tok.indexOf("=");
    if (eq < 1) continue;
    const key = tok.slice(0, eq).toLowerCase();
    const value = tok.slice(eq + 1);
    if (!value) continue;
    const arr = out[key] ?? (out[key] = []);
    if (!arr.includes(value)) arr.push(value);
  }
  return out;
}

function pyValue(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Facets grouped as key -> values[] in selection order. */
function facetPairsGrouped(state: AppState): Array<[string, string[]]> {
  return Object.keys(state.selected).map((k) => [k, state.selected[k]] as [string, string[]]);
}

const UNQUOTE = /^(['"])([\s\S]*)\1$/;
function unquote(s: string): string {
  const t = s.trim();
  const m = t.match(UNQUOTE);
  if (!m) return t;
  // unescape \" \' and \\ inside the quoted body (mirror of pyValue's escaping)
  return m[2].replace(/\\(["'\\])/g, "$1");
}

/**
 * Split on any separator char in `seps` at bracket-depth 0 AND outside quotes, so lists
 * (`["a","b"]`) and quoted values with commas (`"a,b"`) stay intact. Honors `\"` escapes.
 */
function splitTopLevel(s: string, seps: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && i + 1 < s.length) {
        cur += ch + s[i + 1];
        i++;
        continue;
      }
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if (seps.includes(ch) && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** One kwarg line `key="value"` / `key=["a", "b"]` (Python call form). */
function pyKwarg(key: string, vs: string[]): string {
  return `${key}=${vs.length > 1 ? `[${vs.map(pyValue).join(", ")}]` : pyValue(vs[0])}`;
}

/**
 * The editable FACET kwargs, one per line - what the Python tab lets the user edit, re-synced from
 * state. host/time/bbox are NOT here (host is a fixed line; time/bbox come from the sidebar).
 */
export function pyKwargLines(state: AppState): string {
  return facetPairsGrouped(state)
    .map(([k, vs]) => `${pyKwarg(k, vs)},`)
    .join("\n");
}

/**
 * Tolerant parse of the editable kwargs (one per line, or comma-separated) into space-separated
 * `key=value` facet tokens for the shared commit guard. Accepts `key="value"`, `key=value`,
 * `key: value`, `key=["a", "b"]`. host, time and bbox keys are dropped (fixed / sidebar-owned);
 * the guard drops anything else that isn't a real facet.
 */
export function parsePyConfig(text: string): string {
  let t = text.trim();
  t = t
    .replace(/^\bdatabrowser\s*\(/, "")
    .replace(/^\{/, "")
    .replace(/[})]\s*$/, ""); // tolerate wrappers
  const tokens: string[] = [];
  for (const part of splitTopLevel(t, ",\n")) {
    const m = part.match(/^\s*(.+?)\s*[:=]\s*([\s\S]+?)\s*,?\s*$/);
    if (!m) continue;
    const key = unquote(m[1]);
    // time/bbox/*_select are FIRST-CLASS tokens and must survive: dropping them here would make a
    // focus+blur of the python tab silently clear them (parseControlTokens sees no token -> null).
    // Only host (not shown) and flavour (read-only; it's the lens) are excluded.
    if (!key || /^(host|flavour)$/i.test(key)) continue;
    const rawVal = m[2].trim();
    const vals = rawVal.startsWith("[")
      ? splitTopLevel(rawVal.replace(/^\[/, "").replace(/\]$/, ""), ",")
          .map(unquote)
          .filter(Boolean)
      : [unquote(rawVal)];
    for (const v of vals) if (v) tokens.push(`${key}=${shellQuote(v)}`); // re-quote: spaces/commas survive tokenize
  }
  return tokens.join(" ");
}

/**
 * Read-only kwarg lines that always come FIRST: flavour, base scope, then time, then bbox.
 * They open the copyable multi-line Python call form:
 *   from freva_client import databrowser
 *   db = databrowser(
 *       project="cordex",
 *       host="…",
 *   )
 */
export function pyFixedLines(state: AppState): string[] {
  // The flavour (the lens) is read-only, chosen in the header. The base scope is likewise read-only -
  // include it so the copied call reproduces the scoped results, not the whole archive. time/bbox are
  // editable kwargs in the textarea, like every other token.
  const lines: string[] = [];
  if (state.flavour !== "freva") lines.push(pyKwarg("flavour", [state.flavour]));
  const byKey = new Map<string, string[]>();
  for (const [k, v] of baseScopePairs(state)) {
    const cur = byKey.get(k) ?? [];
    cur.push(v);
    byKey.set(k, cur);
  }
  for (const [k, vs] of byKey) lines.push(pyKwarg(k, vs));
  return lines;
}

export function pythonCommand(state: AppState): string {
  // The copied call is EXACTLY what the tab shows: the read-only flavour line, then the same
  // editable kwargs (time/bbox/facets). Sharing pyEditableLines() is what stops the copied command
  // and the editor from drifting apart.
  const fixed = pyFixedLines(state).map((l) => `    ${l},`);
  const editable = pyEditableLines(state)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => `    ${l}`);
  const body = [...fixed, ...editable];
  // No kwargs -> a clean `databrowser()`; emitting the multi-line form with an empty body would
  // leave blank lines inside the call and an unclosed-looking paren.
  if (!body.length) return "from freva_client import databrowser\ndatabrowser()";
  return `from freva_client import databrowser\ndatabrowser(\n${body.join("\n")}\n)`;
}

/**
 * Round a bbox to 2 decimals (~1 km). Applied at the SOURCE (when a bbox is set), so the live
 * query, the terminal command and the copied command can never disagree - a map drag otherwise
 * produces 8-decimal noise that reads as broken in the command line.
 */
export function roundBbox(b: BBoxSelection | null): BBoxSelection | null {
  if (!b) return null;
  const r = (n: number): number => Math.round(n * 100) / 100;
  return {
    ...b,
    minLon: r(b.minLon),
    maxLon: r(b.maxLon),
    minLat: r(b.minLat),
    maxLat: r(b.maxLat),
  };
}

// time / bbox as FIRST-CLASS terminal tokens
//
// They are part of the token grammar - parsed, validated, removable - exactly like any other
// token. Without that, typing `bbox=10,1,1,1` falls through to the facet path and commits a FAKE
// facet (a bogus chip plus a meaningless query param).

export const CONTROL_KEYS = new Set(["time", "time_select", "bbox", "bbox_select"]);
export const SELECT_MODES: SelectMode[] = ["flexible", "strict", "file"];
export const DEFAULT_SELECT_MODE: SelectMode = "flexible";

export interface ControlParse {
  time: TimeSelection | null;
  bbox: BBoxSelection | null;
  rest: Record<string, string[]>; // everything that is NOT time/bbox -> the facet path
  errors: string[]; // human-readable, surfaced in the terminal's warning line
}

/** `bbox=minLon,maxLon,minLat,maxLat` (4 numbers). */
function parseBboxValue(v: string): { box: Omit<BBoxSelection, "mode"> | null; error?: string } {
  const parts = v.split(",").map((p) => p.trim());
  if (parts.length !== 4)
    return { box: null, error: "bbox needs 4 numbers: minLon,maxLon,minLat,maxLat" };
  const n = parts.map(Number);
  if (n.some((x) => !Number.isFinite(x)))
    return { box: null, error: "bbox values must be numbers" };
  const [minLon, maxLon, minLat, maxLat] = n;
  if (minLon > maxLon) return { box: null, error: "bbox: minLon must be ≤ maxLon" };
  if (minLat > maxLat) return { box: null, error: "bbox: minLat must be ≤ maxLat" };
  if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90)
    return { box: null, error: "bbox: latitude must be within ±90" };
  if (Math.abs(minLon) > 180 || Math.abs(maxLon) > 180)
    return { box: null, error: "bbox: longitude must be within ±180" };
  return { box: { minLon, maxLon, minLat, maxLat } };
}

// ONE time-bound validator shared by the terminal parser and the editor, so they can't disagree.
// A bound is empty/`*` (open), or a date-time (to second precision) whose fields are REAL: this
// rejects 2023-02-31, month 99 and hour 25, which a looser regex or a plain split would accept.
const TIME_BOUND_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?)?)?$/;
export function isOpenBound(x: string): boolean {
  const t = x.trim();
  return t === "" || t === "*";
}
// Build a UTC instant WITHOUT the Date.UTC / new Date(y,…) two-digit-year remap (which turns 0001
// into 1901). Climate extents legitimately start at 0001-01-01, so years 0–99 must round-trip.
function utcInstant(y: number, mon: number, day: number, hr = 0, min = 0, sec = 0): Date {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mon - 1, day);
  dt.setUTCHours(hr, min, sec, 0);
  return dt;
}
export function validTimeBound(x: string): boolean {
  const t = x.trim();
  if (isOpenBound(t)) return true;
  const m = TIME_BOUND_RE.exec(t);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m;
  const mon = mo ? +mo : 1,
    day = d ? +d : 1,
    hr = h ? +h : 0,
    min = mi ? +mi : 0,
    sec = s ? +s : 0;
  if (mon < 1 || mon > 12 || hr > 23 || min > 59 || sec > 59) return false;
  if (d) {
    // real calendar day: round-trip through a UTC date to catch 02-31, 04-31, etc.
    const dt = utcInstant(+y, mon, day);
    if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== mon - 1 || dt.getUTCDate() !== day)
      return false;
  }
  return true;
}
/** Sortable instant for a (already-valid) bound, for from ≤ to checks. NaN if unparseable. */
export function timeBoundKey(x: string): number {
  const m = TIME_BOUND_RE.exec(x.trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m;
  return utcInstant(+y, mo ? +mo : 1, d ? +d : 1, h ? +h : 0, mi ? +mi : 0, s ? +s : 0).getTime();
}

/** `time="2000 TO 2010"` (case-insensitive TO; open ends allowed). */
function parseTimeValue(v: string): { range: { from: string; to: string } | null; error?: string } {
  const m = v.split(/\s+TO\s+/i);
  if (m.length !== 2) return { range: null, error: 'time needs a range: time="2000 TO 2010"' };
  // `*` is the Solr-style open bound - accept it and store it as an open (empty) end, so it can
  // never be sent to the backend as a literal `*`.
  const open = (x: string): string => (x.trim() === "*" ? "" : x.trim());
  const from = open(m[0]);
  const to = open(m[1]);
  if (!from && !to) return { range: null, error: "time range is empty" };
  if (from && !validTimeBound(from)) return { range: null, error: `not a valid time: "${from}"` };
  if (to && !validTimeBound(to)) return { range: null, error: `not a valid time: "${to}"` };
  if (from && to && timeBoundKey(from) > timeBoundKey(to)) {
    return { range: null, error: "time range is reversed - the start is after the end" };
  }
  return { range: { from, to } };
}

/** The canonical open bounds - the same ones facetQueryString()/cliCommand() already send. */
function timeRangeText(t: TimeSelection): string {
  return `${t.from || "1"} TO ${t.to || "9999"}`;
}

function parseMode(v: string): SelectMode | null {
  const t = v.trim().toLowerCase();
  return (SELECT_MODES as string[]).includes(t) ? (t as SelectMode) : null;
}

/**
 * Split parsed tokens into time/bbox controls + the remaining facet tokens. A `*_select` without
 * its partner is ignored; a control with a partner but no explicit mode gets the default
 * (flexible), which the terminal states in its hint rather than silently guessing.
 */
export function parseControlTokens(parsed: Record<string, string[]>): ControlParse {
  const rest: Record<string, string[]> = {};
  const errors: string[] = [];
  let time: TimeSelection | null = null;
  let bbox: BBoxSelection | null = null;

  const last = (k: string): string | null => {
    const vs = parsed[k];
    return vs && vs.length ? vs[vs.length - 1] : null; // last one wins, like a shell flag
  };

  for (const key of Object.keys(parsed)) {
    if (!CONTROL_KEYS.has(key)) rest[key] = parsed[key];
  }

  const bboxRaw = last("bbox");
  if (bboxRaw !== null) {
    const { box, error } = parseBboxValue(bboxRaw);
    if (error) errors.push(error);
    if (box) {
      const modeRaw = last("bbox_select");
      const mode = modeRaw === null ? DEFAULT_SELECT_MODE : parseMode(modeRaw);
      if (modeRaw !== null && mode === null)
        errors.push(`bbox_select must be one of ${SELECT_MODES.join(", ")}`);
      bbox = { ...box, mode: mode ?? DEFAULT_SELECT_MODE };
    }
  }

  const timeRaw = last("time");
  if (timeRaw !== null) {
    const { range, error } = parseTimeValue(timeRaw);
    if (error) errors.push(error);
    if (range) {
      const modeRaw = last("time_select");
      const mode = modeRaw === null ? DEFAULT_SELECT_MODE : parseMode(modeRaw);
      if (modeRaw !== null && mode === null)
        errors.push(`time_select must be one of ${SELECT_MODES.join(", ")}`);
      time = { ...range, mode: mode ?? DEFAULT_SELECT_MODE };
    }
  }

  return { time, bbox, rest, errors };
}

/** The FULL editable token text the terminal owns: time/bbox controls first, then facets. */
export function terminalTokens(state: AppState): string {
  const toks: string[] = [];
  const t = state.time;
  if (t && (t.from || t.to)) {
    toks.push(`time=${shellQuote(timeRangeText(t))}`);
    toks.push(`time_select=${t.mode}`);
  }
  const b = state.bbox;
  if (b) {
    toks.push(`bbox=${b.minLon},${b.maxLon},${b.minLat},${b.maxLat}`);
    toks.push(`bbox_select=${b.mode}`);
  }
  for (const [k, v] of facetPairs(state)) toks.push(`${k}=${shellQuote(v)}`);
  return toks.join(" ");
}

/** The python kwarg lines the textarea owns - time/bbox first, then facets (all editable). */
export function pyEditableLines(state: AppState): string {
  const lines: string[] = [];
  const t = state.time;
  if (t && (t.from || t.to)) {
    lines.push(`${pyKwarg("time", [timeRangeText(t)])},`);
    lines.push(`${pyKwarg("time_select", [t.mode])},`);
  }
  const b = state.bbox;
  if (b) {
    lines.push(`${pyKwarg("bbox", [`${b.minLon},${b.maxLon},${b.minLat},${b.maxLat}`])},`);
    lines.push(`${pyKwarg("bbox_select", [b.mode])},`);
  }
  for (const [k, vs] of facetPairsGrouped(state)) lines.push(`${pyKwarg(k, vs)},`);
  return lines.join("\n");
}

// Per-file spatial/temporal extent, as returned by extended-search with
// `fields=time&fields=bbox`.
//
//   "time": "[0001-01-01T00:00:00 TO 9999-12-31T23:59:00]"
//   "bbox": ["ENVELOPE(0, 360, 90, -90)"]
//
// Both keys are OPTIONAL. When a row omits them (or they don't parse), the caller keeps whatever
// default it already had - we never fabricate an extent.

/** Solr `ENVELOPE(minLon, maxLon, maxLat, minLat)` -> our bbox. Returns null if unparseable. */
export function parseEnvelope(raw: unknown): Omit<BBoxSelection, "mode"> | null {
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (typeof text !== "string") return null;
  const m = text.match(/ENVELOPE\s*\(([^)]*)\)/i);
  if (!m) return null;
  const n = m[1].split(",").map((x) => Number(x.trim()));
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null;
  const [minLon, maxLon, maxLat, minLat] = n; // NOTE the Solr order: minX, maxX, maxY, minY
  // Indexes may publish 0…360 longitudes (a global store returns ENVELOPE(0, 360, 90, -90)).
  // Normalise here so every consumer sees the -180…180 convention the map and the API search use.
  const nb = normalizeBboxLon({ minLon, maxLon, minLat, maxLat });
  return { minLon: nb.minLon, maxLon: nb.maxLon, minLat: nb.minLat, maxLat: nb.maxLat };
}

/** `[<from> TO <to>]` -> a display string, or null when absent/unparseable. */
export function parseSolrTimeRange(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^\s*[[{]?\s*(.+?)\s+TO\s+(.+?)\s*[\]}]?\s*$/i);
  if (!m) return null;
  const tidy = (x: string): string =>
    x
      .replace(/T/, " ")
      .replace(/\s*(00:00:00|23:59:00|23:59:59)$/, "")
      .trim();
  const from = tidy(m[1]);
  const to = tidy(m[2]);
  if (!from || !to) return null;
  return `${from} → ${to}`;
}

/**
 * Normalise a bbox's longitudes to the −180…180 convention the map (and the API's own bbox
 * search) uses. Indexes commonly publish extents in the 0…360 convention instead - e.g. a GLOBAL
 * zarr store returns `ENVELOPE(0, 360, 90, -90)`, which, drawn literally on a −180…180 map, paints
 * only the right-hand half. Returns flags so callers can render honestly:
 *
 *   global - covers every longitude (drawn edge to edge, labelled "global")
 *   wraps  - crosses the antimeridian (needs TWO rectangles, not one)
 */
export interface NormalizedBBox {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  global: boolean;
  wraps: boolean;
}
export function normalizeBboxLon(b: Omit<BBoxSelection, "mode">): NormalizedBBox {
  const minLat = Math.min(b.minLat, b.maxLat);
  const maxLat = Math.max(b.minLat, b.maxLat);
  // full sweep in ANY convention (0->360, −180->180) -> global
  if (Math.abs(b.maxLon - b.minLon) >= 359.5) {
    return { minLon: -180, maxLon: 180, minLat, maxLat, global: true, wraps: false };
  }
  const to180 = (lon: number): number => {
    let x = ((((lon + 180) % 360) + 360) % 360) - 180; // wrap into [−180, 180)
    if (x === -180 && lon > 0) x = 180; // keep an explicit +180 edge on the right
    return x;
  };
  const minLon = to180(b.minLon);
  const maxLon = to180(b.maxLon);
  return { minLon, maxLon, minLat, maxLat, global: false, wraps: minLon > maxLon };
}
