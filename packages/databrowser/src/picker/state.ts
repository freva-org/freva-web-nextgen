// picker/state.ts - the bridge between the picker's PUBLIC state and the shared `QueryScope`, plus
// the two sanitisers every entry point into that state has to pass through.
//
// This is the whole reason the picker can be small: it owns a tiny serialisable object, and every
// question about what that object MEANS - which values are included, which excluded, what the wire
// query is, how a key translates across flavours, which keys the base scope owns - is answered by
// `state.ts`, the same module the full browser uses.
//
// Three rules are enforced HERE rather than at each call site, because there are three ways into
// this state (mount `initialState`, `setState`, and the UI) and a rule enforced in only two of them
// is not a rule:
//   1. the base scope wins over anything a host supplies (`sanitizeAgainstScope`);
//   2. a disabled feature cannot be activated through state (`allowAllFiltered`);
//   3. explicit assets and "all filtered" are alternatives, never a combination.

import type { QueryScope } from "../types.js";
import { baseFacetKey, baseFilterKeys, normalizeBaseFilters, validTimeBound } from "../state.js";
import { asUniqKey } from "../search/client.js";
import { MAX_PICKER_ASSETS, cloneAssetReference, type AssetReference } from "./reference.js";
import { PICKER_STATE_VERSION, type PickerState } from "./types.js";

export function emptyPickerState(flavour = "freva"): PickerState {
  return {
    version: PICKER_STATE_VERSION,
    flavour,
    uniqKey: "file",
    selected: {},
    time: null,
    bbox: null,
    search: "",
    assets: [],
    useAllFiltered: false,
  };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const nonEmpty = (v: unknown): v is string => isStr(v) && v.length > 0;

/**
 * Coerce a host-supplied asset into a safe snapshot. Anything that is not a usable locator is
 * dropped: a restored selection has to be committable on its own, so an asset that could not
 * produce a valid `DataReference` must not be allowed to sit in the state pretending it could.
 */
export function normalizeAsset(input: unknown): AssetReference | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const a = input as Record<string, unknown>;
  if (!nonEmpty(a.uri)) return null;
  const out: AssetReference = { id: nonEmpty(a.id) ? a.id : a.uri, uri: a.uri };
  if (nonEmpty(a.fsType)) out.fsType = a.fsType;
  if (nonEmpty(a.format)) out.format = a.format;
  if (typeof a.stac === "object" && a.stac !== null && !Array.isArray(a.stac)) {
    const s = a.stac as Record<string, unknown>;
    const stac: NonNullable<AssetReference["stac"]> = {};
    if (nonEmpty(s.collection)) stac.collection = s.collection;
    if (nonEmpty(s.item)) stac.item = s.item;
    if (nonEmpty(s.href)) stac.href = s.href;
    if (Object.keys(stac).length) out.stac = stac;
  }
  return out;
}

export interface NormalizeOptions {
  /** False when `features.allFiltered` is off: query mode then cannot be entered at all. */
  allowAllFiltered?: boolean;
}

/**
 * Coerce host-supplied state into something safe. Anything unrecognised is DROPPED rather than
 * throwing: restoring a session is a convenience, and a host that persisted a slightly older shape
 * should get a working picker, not an exception during mount.
 */
export function normalizePickerState(
  input: Partial<PickerState> | undefined,
  fallbackFlavour: string,
  opts: NormalizeOptions = {},
): PickerState {
  const allowAllFiltered = opts.allowAllFiltered ?? true;
  const out = emptyPickerState(fallbackFlavour);
  if (!input || typeof input !== "object") return out;
  if (nonEmpty(input.flavour)) out.flavour = input.flavour;
  out.uniqKey = asUniqKey(input.uniqKey);
  if (input.selected && typeof input.selected === "object") {
    for (const [k, v] of Object.entries(input.selected)) {
      if (!k || !Array.isArray(v)) continue;
      const vals = v.filter(nonEmpty);
      if (vals.length) out.selected[k] = [...new Set(vals)];
    }
  }
  const t = input.time;
  if (t && isStr(t.from) && isStr(t.to) && (t.from || t.to)) {
    // Reuse the browser's own bound validator - an invalid restored bound must not become a query.
    if ((!t.from || validTimeBound(t.from)) && (!t.to || validTimeBound(t.to))) {
      out.time = {
        from: t.from,
        to: t.to,
        mode: t.mode === "strict" || t.mode === "file" ? t.mode : "flexible",
      };
    }
  }
  const b = input.bbox;
  if (b && [b.minLon, b.maxLon, b.minLat, b.maxLat].every((n) => Number.isFinite(n))) {
    out.bbox = {
      minLon: b.minLon,
      maxLon: b.maxLon,
      minLat: b.minLat,
      maxLat: b.maxLat,
      mode: b.mode === "strict" || b.mode === "file" ? b.mode : "flexible",
    };
  }
  if (isStr(input.search)) out.search = input.search;

  // Assets: sanitise, DEDUPLICATE by id, then cap. Order is preserved, so "the first 25 the user
  // chose" is what survives rather than an arbitrary subset.
  if (Array.isArray(input.assets)) {
    const seen = new Set<string>();
    for (const raw of input.assets) {
      const a = normalizeAsset(raw);
      if (!a || seen.has(a.id)) continue;
      seen.add(a.id);
      out.assets.push(a);
      if (out.assets.length >= MAX_PICKER_ASSETS) break;
    }
  }

  // A hidden control must not be able to drive a hidden action, and the two selection modes are
  // alternatives: an explicit selection wins over a restored "all filtered" flag.
  out.useAllFiltered = allowAllFiltered && input.useAllFiltered === true && out.assets.length === 0;
  return out;
}

/**
 * Drop any user selection the base scope OWNS.
 *
 * Only a POSITIVE base filter owns its key (that asymmetry lives in `baseFilterKeys`, shared with
 * the full browser). Without this, a host could restore `{ project: ["other"] }` into a
 * `{ project: "waterpark" }` instance and get an inert chip: visible in the state, invisible on the
 * wire, and impossible for the user to reconcile. Suffix-aware, so `project_not_` is refused for
 * the same reason `project` is.
 */
export function sanitizeAgainstScope(scope: QueryScope, selected: Record<string, string[]>): void {
  const owned = baseFilterKeys(scope);
  if (owned.size === 0) return;
  for (const key of Object.keys(selected)) {
    if (owned.has(baseFacetKey(key).toLowerCase())) delete selected[key];
  }
}

/** A deep, JSON-safe copy - what `getState()` hands out and `onStateChange` reports. */
export function clonePickerState(s: PickerState): PickerState {
  return {
    version: PICKER_STATE_VERSION,
    flavour: s.flavour,
    uniqKey: s.uniqKey,
    selected: Object.fromEntries(Object.entries(s.selected).map(([k, v]) => [k, [...v]])),
    time: s.time ? { ...s.time } : null,
    bbox: s.bbox ? { ...s.bbox } : null,
    search: s.search,
    assets: s.assets.map(cloneAssetReference),
    useAllFiltered: s.useAllFiltered,
  };
}

/**
 * THE conversion into the shared boundary. Everything downstream of here - the wire query, the
 * base-scope gate, `_not_` handling, flavour translation - is the full browser's code.
 */
export function toQueryScope(
  s: PickerState,
  baseFilters: Record<string, string | string[]> | undefined,
  flavourMaps: QueryScope["flavourMaps"],
): QueryScope {
  return {
    flavour: s.flavour,
    uniqKey: s.uniqKey,
    selected: s.selected,
    baseFilters: normalizeBaseFilters(baseFilters),
    time: s.time,
    bbox: s.bbox,
    flavourMaps,
  };
}
