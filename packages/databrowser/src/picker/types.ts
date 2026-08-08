// picker/types.ts - the picker's PUBLIC surface: its own versioned, serialisable state, its mount
// config and its handle.
//
// `PickerState` is deliberately NOT `AppState`. `AppState` carries `Set`s, `Map`s, render version
// counters, overview layout, terminal drafts and details caches - none of which a host can
// meaningfully store, and all of which would become a compatibility obligation the moment a host
// round-tripped one. What a host actually needs to restore is the QUESTION the user was asking and
// WHAT THEY HAD CHOSEN, so that is all this carries, in JSON-serialisable form with an explicit
// version.

import type { BBoxSelection, TimeSelection, UniqKey } from "../types.js";
import type { SearchClient } from "../search/engine.js";
import type { AssetReference, DataReference } from "./reference.js";

export const PICKER_STATE_VERSION = 1 as const;

/** The `/flavours` wire shape - what `resolveFlavourMaps` returns. */
export interface FlavourMapping {
  flavour_name: string;
  mapping: Record<string, string>;
}

/**
 * Everything needed to reproduce what the user was looking at AND what they had chosen. Plain JSON:
 * no Set, no Map, no function, no DOM node - `JSON.parse(JSON.stringify(state))` is a faithful copy.
 */
export interface PickerState {
  version: typeof PICKER_STATE_VERSION;
  /** The metadata lens. Facet keys in `selected` are expressed in THIS flavour's naming. */
  flavour: string;
  uniqKey: UniqKey;
  /**
   * Canonical facet selection, including exclusions as `<key>_not_` - identical in meaning and
   * encoding to the full browser's, because it is fed through the same query builder.
   */
  selected: Record<string, string[]>;
  time: TimeSelection | null;
  bbox: BBoxSelection | null;
  /** The text in the value-search field. Restored so a reopened picker looks untouched. */
  search: string;
  /**
   * The explicitly chosen files, as DURABLE snapshots rather than row keys.
   *
   * This is the load-bearing detail. Storing keys and resolving them against the currently loaded
   * page lets a pick silently evaporate the moment the user filters past it, pages, or restores
   * state before its row has loaded - leaving an enabled Add button, a "1 of 25
   * selected" label, and `getReference()` returning null. A snapshot is self-sufficient: nothing
   * about it needs the result list to still contain the row.
   *
   * Capped at `MAX_PICKER_ASSETS` (25); mutually exclusive with `useAllFiltered`.
   */
  assets: AssetReference[];
  /** True when the user chose "use all filtered results" instead of an explicit selection. */
  useAllFiltered: boolean;
}

/** Which optional controls the picker shows. Everything defaults OFF except the essentials. */
export interface PickerFeatureFlags {
  /** The flavour (lens) selector. Default false - most labs pin one lens. */
  flavour?: boolean;
  /** The time-range control. Default false. */
  time?: boolean;
  /** The bounding-box control. Default false. */
  bbox?: boolean;
  /**
   * The "use all N filtered results" affordance, which commits a `query` reference. Default true.
   * When false the mode is not merely hidden: it cannot be entered through `initialState` or
   * `setState` either, so a hidden control can never drive a hidden action.
   */
  allFiltered?: boolean;
  /** Row drag-and-drop. Default true. The Add button always exists regardless - see WCAG 2.2. */
  drag?: boolean;
}

export interface DataPickerConfig {
  apiBase?: string;
  flavour?: string;
  /**
   * Always-applied scope, exactly as in the full browser (freva-canonical keys, positive and
   * `_not_` forms). Client-side scoping, not an authorisation boundary.
   *
   * A POSITIVE scope OWNS its facet key: the picker renders those values locked, refuses to chip,
   * autocomplete, toggle, exclude or restore any selection on that key, and shows only in-scope
   * values for it. A NEGATIVE scope owns nothing: it is displayed as an immutable
   * `Scope: project ≠ cmip6` indicator and further narrowing on that key stays available.
   */
  baseFilters?: Record<string, string | string[]>;
  /** Label of the primary action, e.g. "Add to experiment". Default "Add selection". */
  commitLabel?: string;
  /** Restore a previous session. Anything unrecognised is ignored rather than throwing. */
  initialState?: Partial<PickerState>;
  /** Called (coalesced) whenever the serialisable state changes. */
  onStateChange?: (state: PickerState) => void;
  /**
   * Called when the user activates the PRIMARY ACTION. It is not called on drag: a drag writes the
   * reference to the `DataTransfer` and the drop target owns what happens next. One accepted drop
   * therefore produces exactly one host-side addition, even when the host wires its drop handler
   * and `onCommit` to the same function.
   */
  onCommit?: (ref: DataReference) => void;
  /** Inject a transport. Defaults to `createRestSearchClient({ apiBase })`. */
  client?: SearchClient;
  /**
   * Supply or resolve the per-flavour facet-key mappings (`GET /flavours`' payload shape).
   *
   * Only needed when a CUSTOM (non-builtin) flavour is combined with `baseFilters`: the scope's
   * keys are freva-canonical and have to be re-keyed into that flavour before any request can be
   * scoped correctly. The default REST client fetches this itself; an INJECTED `client` has no
   * such endpoint, so this hook is how a host provides it. May return the array directly or a
   * promise. Until it resolves, a scoped custom-flavour picker issues no search at all; if it
   * fails, the picker shows an error and still issues none.
   */
  resolveFlavourMaps?: () => FlavourMapping[] | Promise<FlavourMapping[]>;
  /** Optional bearer supplier for the DEFAULT client only. Never stored in picker state. */
  getAuthToken?: () => string | null | undefined;
  features?: PickerFeatureFlags;
  /** Initial light/dark mode. Default "day". */
  theme?: "day" | "night";
  /**
   * Where anchored overlays are appended. Defaults to the picker's own root, which is
   * `position: relative` - so overlays survive a transformed, clipped or nested-scrolling host.
   * Pass an element only if the host genuinely needs them elsewhere.
   */
  overlayRoot?: HTMLElement;
  /** Debounce for the search, in ms. Default 250 - the same as the full browser. */
  debounceMs?: number;
}

export interface DataPickerHandle {
  /** The current serialisable state - safe to store and pass back as `initialState`. */
  getState(): PickerState;
  /**
   * Restore state. Unknown or invalid fields are ignored; the result is sanitised against the base
   * scope and the feature flags, so `setState` cannot reach a configuration the UI forbids.
   */
  setState(state: Partial<PickerState>): void;
  /**
   * The reference the primary action would produce right now, or null when nothing is chosen.
   * Identical to what a drag writes to the `DataTransfer` - one code path, so they cannot diverge -
   * and the Add button is enabled exactly when this is non-null.
   */
  getReference(): DataReference | null;
  setTheme(mode: "day" | "night"): void;
  destroy(): void;
}
