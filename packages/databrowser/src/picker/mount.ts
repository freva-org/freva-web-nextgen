// picker/mount.ts - the compact lab data picker.
//
// WHAT THIS IS: a small, embeddable "choose some data" panel for a lab application. Value-first
// search, compact facet filters with Include/Exclude, a lean file list, and one primary action that
// hands the host a versioned `DataReference`.
//
// WHAT THIS IS NOT: a second data browser. There is no terminal, no overview grid, no brand, no
// footer, no details panel, no comparison matrix, no inspector, no export menu and no landing-page
// navigation - and `tests/picker-import-graph.test.ts` asserts the BUILT entry does not even reach
// that code, so the omission is structural rather than a promise in a comment.
//
// Everything about WHAT gets searched comes from the shared boundary (`../search/*`), which is the
// same code the full browser runs: the live query state here IS a `QueryScope`, so the facet
// algebra, `_not_` semantics, flavour translation, base-scope gating and time/bbox representation
// are not reimplemented, merely used.
//
// It never touches `window.location`, and no credential ever reaches its state or a drag payload.
//
// FIVE INVARIANTS worth stating up front:
//
//   • A PICK IS A SNAPSHOT, not a row key. The selection survives filtering, paging, a lens change
//     and restoration, because nothing about it depends on the result list still containing the row.
//   • THE SCOPE IS INESCAPABLE IN THE UI, not just on the wire. A positively gated key is locked in
//     the facet list and refused from chips, autocomplete, `initialState` and `setState`, so an
//     inert selection - present in state, absent from the request - cannot be created at all.
//   • A LENS CHANGE IS ATOMIC. Entering a flavour whose key mapping is unknown does not happen at
//     all: the last valid flavour and selection are preserved, no request is issued, and when the
//     mapping arrives the translation, the scope sanitisation, the state notification, the repaint
//     and exactly ONE request happen together. A scoped custom flavour fails closed the same way.
//   • A QUERY REFERENCE DESCRIBES A REAL, CURRENT SEARCH. "All filtered results" is only offered
//     when the visible count belongs to the current query revision under a mappable flavour.
//   • DRAG DOES NOT COMMIT. `onCommit` is the Add button. A drag only writes the payload; the drop
//     target owns the drop. One accepted drop is one host-side addition.

import { Disposables, el, replaceChildren } from "../dom.js";
import { positionAnchored } from "../anchor.js";
import {
  BUILTIN_FLAVOURS,
  BUILTIN_FLAVOUR_MAPS,
  baseScopeExclusions,
  baseScopePairs,
  buildFacets,
  buildFlavourMaps,
  clearFacetModes,
  displayFacetValues,
  excludedValues,
  fromApiRow,
  includedValues,
  isExcluded,
  isGatedKey,
  isGatedValue,
  isSelected,
  labelFor,
  normalizeBaseFilters,
  parseFacetKey,
  toggleFacetMode,
  translateSelection,
} from "../state.js";
import { effectiveSearchQuery } from "../search/query.js";
import { createSearchEngine, type SearchClient } from "../search/engine.js";
import { createRestSearchClient } from "../search/client.js";
import { rankValueMatches, type ValueMatch } from "../search/rank.js";
import type { Facet, FileRow, LoadState, QueryScope, SearchResult } from "../types.js";
import { PICKER_STYLES } from "./styles.js";
import { createVirtualList } from "./virtual.js";
import {
  DATA_REFERENCE_SCHEMA_VERSION,
  FREVA_DATA_REFERENCE_MIME,
  MAX_PICKER_ASSETS,
  cloneAssetReference,
  describeReference,
  uriListFor,
  type AssetReference,
  type DataReference,
  type DataSource,
} from "./reference.js";
import { clonePickerState, normalizePickerState, sanitizeAgainstScope } from "./state.js";
import {
  PICKER_STATE_VERSION,
  type DataPickerConfig,
  type DataPickerHandle,
  type FlavourMapping,
  type PickerState,
} from "./types.js";

const DEFAULT_API_BASE = "/api/freva-nextgen/databrowser";
const PAGE_SIZE = 100;
const ROW_HEIGHT = 34;
/** Facet values shown per block before "Show all" - a picker is a shortlist, not a catalogue. */
const FACET_PREVIEW = 6;

const SCOPE_ERROR =
  "Scoped browsing is unavailable - this flavour's field mapping could not be loaded.";

let instanceSeq = 0;

interface PickerRow extends FileRow {
  uri: string;
  format?: string;
}

export function mountDataPicker(
  target: HTMLElement,
  config: DataPickerConfig = {},
): DataPickerHandle {
  const apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const uid = `fp${++instanceSeq}`;
  const features = {
    flavour: config.features?.flavour ?? false,
    time: config.features?.time ?? false,
    bbox: config.features?.bbox ?? false,
    allFiltered: config.features?.allFiltered ?? true,
    drag: config.features?.drag ?? true,
  };
  const dis = new Disposables();
  const restClient = config.client
    ? null
    : createRestSearchClient({
        apiBase,
        ...(config.getAuthToken ? { getAuthToken: config.getAuthToken } : {}),
      });
  const client: SearchClient = config.client ?? (restClient as SearchClient);

  // State
  // The live query state IS the shared boundary type; the picker's own public state is derived
  // from it on demand. That is what stops the two from drifting.
  const normalize = (input: Partial<PickerState> | undefined, fallback: string): PickerState =>
    normalizePickerState(input, fallback, { allowAllFiltered: features.allFiltered });

  const init = normalize(config.initialState, config.flavour ?? "freva");
  const sc: QueryScope = {
    flavour: init.flavour,
    uniqKey: init.uniqKey,
    selected: init.selected,
    baseFilters: normalizeBaseFilters(config.baseFilters),
    time: init.time,
    bbox: init.bbox,
    flavourMaps: structuredClone(BUILTIN_FLAVOUR_MAPS),
  };
  // A restored selection must never contradict the scope. This runs BEFORE the first render, so an
  // inert chip is not merely removed after the fact - it never exists.
  sanitizeAgainstScope(sc, sc.selected);

  let searchText = init.search;
  /** DURABLE snapshots, in pick order. Never resolved against the loaded page. */
  let assets: AssetReference[] = [...init.assets];
  let useAllFiltered = init.useAllFiltered;

  let facets: Facet[] = [];
  let facetMapping: Record<string, string> = {};
  let rows: PickerRow[] = [];
  let totalCount = 0;
  let status: LoadState = "idle";
  let errorText = "";
  let expanded = new Set<string>();
  let flavours: string[] = [];
  let note = "";
  /** -1 = no active option; otherwise an index into `rows` (the listbox's roving position). */
  let activeIndex = -1;
  /**
   * A lens the user asked for that cannot be entered yet, because translating into it needs a
   * flavour map that has not arrived. `sc.flavour` and `sc.selected` keep their LAST VALID values
   * meanwhile, so a failed resolution loses nothing.
   */
  let pendingFlavour: string | null = null;
  /** True when the pending lens arrived WITH its own `selected`, so nothing needs re-keying. */
  let pendingSuppliedSelection = false;

  const labels = { facetMapping };
  const source = (): DataSource => ({ apiBase, flavour: sc.flavour, uniqKey: sc.uniqKey });
  const assetIds = (): Set<string> => new Set(assets.map((a) => a.id));
  const snapshot = (): PickerState => ({
    version: PICKER_STATE_VERSION,
    flavour: sc.flavour,
    uniqKey: sc.uniqKey,
    selected: sc.selected,
    time: sc.time,
    bbox: sc.bbox,
    search: searchText,
    assets,
    useAllFiltered,
  });

  // Scope gating
  // One predicate, used by the facet list, the chips, the autocomplete and every mutation path.
  // `isGatedKey` is the full browser's own rule: only a POSITIVE base filter owns a key.
  const gated = (key: string): boolean => isGatedKey(sc, key);

  // Fail-closed scoping
  // A scoped request can only be keyed correctly once the current flavour's freva↔flavour map is
  // known. Builtins always have a baked map; a custom flavour needs `/flavours` (or the
  // `resolveFlavourMaps` hook). With no baseFilters there is nothing to re-key, so it is always ok.
  const flavourMapKnown = (f: string): boolean =>
    BUILTIN_FLAVOURS.includes(f) || !!sc.flavourMaps[f];
  const canScopedSearch = (): boolean =>
    Object.keys(sc.baseFilters).length === 0 || flavourMapKnown(sc.flavour);
  /**
   * Can we ENTER `to` right now? Translating a selection into `to` needs `to`'s forward map, and
   * re-keying the scope needs it too. With neither a selection nor a scope there is nothing to
   * re-key, so any lens is enterable immediately.
   */
  const canEnterFlavour = (to: string): boolean =>
    flavourMapKnown(to) ||
    (Object.keys(sc.selected).length === 0 && Object.keys(sc.baseFilters).length === 0);
  let mapsSettled = false; // the mapping source has resolved or failed - the map set is now final
  let heldSearch = false; // a scoped search is waiting for the current flavour's map

  // DOM
  const root = el("div", { class: "freva-picker", "data-theme": config.theme ?? "day" });
  const style = el("style", { type: "text/css" });
  style.textContent = PICKER_STYLES;
  root.append(style);

  const searchInput = el("input", {
    class: "fp-input",
    type: "search",
    placeholder: "Search values - variable, model, experiment…",
    "aria-label": "Search facet values",
    autocomplete: "off",
    role: "combobox",
    "aria-expanded": "false",
    "aria-autocomplete": "list",
    "aria-controls": `${uid}-ac`,
  });
  searchInput.value = searchText;
  const spinner = el("span", { class: "fp-spin", "aria-hidden": "true" });
  const searchWrap = el("div", { class: "fp-search" }, [searchInput, spinner]);
  const flavourSel = el("select", { class: "fp-flavour", "aria-label": "Metadata lens" });
  const head = el("div", { class: "fp-head" }, [searchWrap, features.flavour ? flavourSel : null]);

  const scopeRow = el("div", { class: "fp-scope" });
  const chipsRow = el("div", { class: "fp-chips" });
  const facetsCol = el("div", { class: "fp-facets", role: "group", "aria-label": "Filters" });
  const controlsCol = el("div", { class: "fp-controls" });

  const listHead = el("div", { class: "fp-list-head" });
  // The listbox itself owns focus; options are addressed with aria-activedescendant. That is the
  // canonical pattern for a RECYCLING list: per-row tabindex would put focus on a node the next
  // scroll destroys.
  const scroller = el("div", {
    class: "fp-scroll",
    role: "listbox",
    tabindex: "0",
    "aria-multiselectable": "true",
    "aria-label": "Matching files",
  });
  const listState = el("div", { class: "fp-state", role: "status", "aria-live": "polite" });
  const filesCol = el("div", { class: "fp-files" }, [listHead, listState, scroller]);

  // WHAT WILL BE ADDED is a choice between two mutually exclusive modes, so it is a radio group
  // rather than a checkbox. A checkbox silently swaps modes, clears the explicit selection and
  // changes nothing visible until Add is pressed - it reads as "nothing happened".
  const modeFiles = el("button", {
    class: "fp-mode",
    type: "button",
    role: "radio",
    "data-mode": "files",
  });
  const modeQuery = el("button", {
    class: "fp-mode",
    type: "button",
    role: "radio",
    "data-mode": "query",
  });
  const modes = el("div", { class: "fp-modes", role: "radiogroup", "aria-label": "What to add" }, [
    modeFiles,
    modeQuery,
  ]);
  const modeNote = el("p", { class: "fp-note", role: "status", "aria-live": "polite" });
  const countText = el("span", { class: "fp-count", role: "status", "aria-live": "polite" });
  const addBtn = el("button", { class: "fp-add", type: "button" });
  const foot = el("div", { class: "fp-foot" }, [
    features.allFiltered ? modes : countText,
    addBtn,
    modeNote,
  ]);

  const body = el("div", { class: "fp-body" }, [
    el("div", { class: "fp-side" }, [controlsCol, facetsCol]),
    filesCol,
  ]);
  root.append(head, scopeRow, chipsRow, body, foot);
  target.append(root);
  dis.add(() => root.remove());

  // Overlays default to the picker's OWN root, which is `position: relative`. That is what keeps
  // the autocomplete attached to its field inside a transformed / clipped / nested-scrolling host -
  // the same rule the full browser learned the hard way (see ../anchor.ts).
  const overlayRoot = config.overlayRoot ?? root;
  const acPop = el("div", {
    class: "fp-ac",
    id: `${uid}-ac`,
    role: "listbox",
    "aria-label": "Facet value matches",
  });
  acPop.style.position = "absolute";
  overlayRoot.append(acPop);
  dis.add(() => acPop.remove());

  // Search lifecycle
  const buildRequest = (): { flavour: string; uniqKey: QueryScope["uniqKey"]; query: string } => {
    const q = effectiveSearchQuery(sc);
    return { flavour: q.flavour, uniqKey: q.uniqKey, query: q.queryString };
  };

  const engine = createSearchEngine({
    client,
    ...(config.debounceMs !== undefined ? { debounceMs: config.debounceMs } : {}),
    maxResults: PAGE_SIZE,
    onStart: (append) => {
      if (!append) status = "loading";
      paintBusy();
    },
    onResult: (res, ctx) => applyResult(res, ctx.append),
    onError: (e, ctx) => {
      if (ctx.append) return; // a failed "load more" keeps the page already shown
      status = "error";
      errorText = e instanceof Error ? e.message : "Search failed.";
      paint();
    },
  });
  dis.add(() => engine.destroy());

  function applyResult(res: SearchResult, append: boolean): void {
    const next = (res.search_results ?? []).map((r): PickerRow => {
      const base = fromApiRow(r, sc.uniqKey);
      const fmt = r.format;
      return {
        ...base,
        uri: sc.uniqKey === "uri" ? String(r.uri ?? r.file) : r.file,
        ...(typeof fmt === "string" && fmt ? { format: fmt } : {}),
      };
    });
    rows = append ? [...rows, ...next] : next;
    totalCount = typeof res.total_count === "number" ? res.total_count : rows.length;
    facets = buildFacets(res);
    facetMapping = res.facet_mapping ?? {};
    labels.facetMapping = facetMapping;
    status = rows.length === 0 ? "empty" : "loaded";
    errorText = "";
    if (!append) {
      scroller.scrollTop = 0;
      clearActive(); // a new result set invalidates the roving position AND its descendant id
    }
    paint();
  }

  /**
   * Any change to the QUESTION: abort in-flight work, debounce a fresh search, tell the host.
   *
   * FAIL-CLOSED: a scoped custom flavour whose mapping is not yet known issues NOTHING. Sending the
   * freva-canonical key to a flavour that renames it produces a request that is silently wrong -
   * unscoped, or scoped by a key the index does not have - and no retry ever corrects it because
   * nothing knows it was wrong.
   */
  function commit(): void {
    notifyState();
    // A pending lens transition means the visible flavour is not the one the user asked for; any
    // request now would be for the wrong lens AND would have to be superseded a moment later.
    if (pendingFlavour !== null || !canScopedSearch()) {
      engine.cancel(); // nothing in flight may settle into a differently-scoped view
      if (mapsSettled) {
        status = "error";
        errorText = SCOPE_ERROR;
        heldSearch = false;
        pendingFlavour = null; // nothing more is coming - stay on the last valid lens
        pendingSuppliedSelection = false;
      } else {
        status = "loading";
        heldSearch = true;
      }
      paint();
      return;
    }
    heldSearch = false;
    engine.commit(buildRequest);
    paint();
  }

  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  function notifyState(): void {
    if (!config.onStateChange) return;
    if (notifyTimer !== null) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      config.onStateChange?.(clonePickerState(snapshot()));
    }, 0);
  }
  dis.add(() => {
    if (notifyTimer !== null) clearTimeout(notifyTimer);
  });

  // References

  /**
   * Do the visible results describe the CURRENT question? Everything about "all filtered results"
   * hangs off this: the count, the checkbox and the query reference are only meaningful when the
   * delivered result belongs to the engine's current revision and actually succeeded.
   */
  const resultsCurrent = (): boolean =>
    engine.resultRevision === engine.revision &&
    (status === "loaded" || status === "empty") &&
    pendingFlavour === null &&
    canScopedSearch();

  const assetFor = (row: PickerRow): AssetReference => ({
    id: row.key,
    uri: row.uri,
    ...(row.fsType ? { fsType: row.fsType } : {}),
    ...(row.format ? { format: row.format } : {}),
  });

  /**
   * The reference the primary action would produce. Built from the DURABLE snapshots, so it never
   * depends on which page is loaded and can never return a partial selection: what the user chose
   * is what comes out.
   */
  function currentReference(): DataReference | null {
    if (useAllFiltered) {
      // "Everything that matches" is a QUERY, never a list. A filtered set of 40,000 files must not
      // be materialised into a drag payload; the host re-runs the query on its own terms.
      //
      // It is offered ONLY for a real, current search. A stale count under a lens whose mapping
      // failed would hand the host a query it cannot run, carrying a number from a different
      // question - which is exactly what a "9 files" estimate on an unmappable custom flavour was.
      if (!resultsCurrent()) return null;
      if (!Number.isInteger(totalCount) || totalCount <= 0) return null;
      return {
        schemaVersion: DATA_REFERENCE_SCHEMA_VERSION,
        kind: "query",
        source: source(),
        query: effectiveSearchQuery(sc),
        estimatedCount: totalCount,
      };
    }
    if (assets.length === 0) return null;
    // Explicit assets do NOT depend on the current search - they are files the user already chose,
    // and they stay committable while a search is in flight, failed, or waiting on a mapping.
    if (assets.length === 1) {
      return {
        schemaVersion: DATA_REFERENCE_SCHEMA_VERSION,
        kind: "asset",
        source: source(),
        asset: cloneAssetReference(assets[0]),
      };
    }
    return {
      schemaVersion: DATA_REFERENCE_SCHEMA_VERSION,
      kind: "selection",
      source: source(),
      assets: assets.map(cloneAssetReference),
    };
  }

  /**
   * The reference a DRAG from `row` delivers. A row inside the current selection drags the whole
   * selection - byte-identical to what the primary action commits, because it is the same call - so
   * the two paths cannot disagree. A row outside the selection drags just itself.
   */
  function referenceForRow(row: PickerRow): DataReference {
    if (!useAllFiltered && assetIds().has(row.key)) return currentReference() as DataReference;
    return {
      schemaVersion: DATA_REFERENCE_SCHEMA_VERSION,
      kind: "asset",
      source: source(),
      asset: assetFor(row),
    };
  }

  function writeTransfer(dt: DataTransfer, ref: DataReference): void {
    dt.setData(FREVA_DATA_REFERENCE_MIME, JSON.stringify(ref));
    // Only a REMOTE asset gets `text/uri-list`; a POSIX archive path is not a URL and must not be
    // handed to a drop target as one.
    const uris = uriListFor(ref);
    if (uris) dt.setData("text/uri-list", uris);
    dt.setData("text/plain", describeReference(ref));
    dt.effectAllowed = "copy";
  }

  // Selection
  function togglePick(row: PickerRow): void {
    const i = assets.findIndex((a) => a.id === row.key);
    if (i >= 0) assets.splice(i, 1);
    else if (assets.length < MAX_PICKER_ASSETS) assets.push(assetFor(row));
    else {
      note = `At most ${MAX_PICKER_ASSETS} files can be selected - use "all filtered results".`;
      paintFoot();
      return;
    }
    if (assets.length) useAllFiltered = false; // picking a row IS choosing "explicit files" mode
    notifyState();
    // Patch the live rows IN PLACE rather than repainting the list. Rebuilding would replace the
    // node under the pointer and reset the window; selection changes nothing about WHICH rows are
    // visible, so there is nothing to rebuild.
    syncRowStates();
    paintFoot();
  }

  /** Reflect the selection onto whatever rows are materialised. O(visible), not O(results). */
  function syncRowStates(): void {
    const ids = assetIds();
    for (const node of scroller.querySelectorAll<HTMLElement>(".fp-row")) {
      const on = !!node.dataset.key && ids.has(node.dataset.key);
      node.classList.toggle("picked", on);
      node.setAttribute("aria-selected", on ? "true" : "false");
      node.querySelector(".fp-box")?.classList.toggle("on", on);
    }
  }

  // List
  const rowId = (index: number): string => `${uid}-opt-${index}`;

  function renderRow(row: PickerRow, index: number): HTMLElement {
    const on = assetIds().has(row.key);
    const uriEl = el("span", { class: "fp-uri", text: row.uri });
    uriEl.setAttribute("title", row.uri);
    const node = el(
      "div",
      {
        class: `fp-row${on ? " picked" : ""}${index === activeIndex ? " active" : ""}`,
        id: rowId(index),
        role: "option",
        "aria-selected": on ? "true" : "false",
        "data-key": row.key,
        "data-index": String(index),
        // A windowed list shows a slice; assistive technology has to be told where the slice sits.
        "aria-posinset": String(index + 1),
        "aria-setsize": String(Math.max(totalCount, rows.length)),
        draggable: features.drag ? "true" : "false",
      },
      [
        el("span", { class: `fp-box${on ? " on" : ""}`, "aria-hidden": "true" }),
        uriEl,
        row.format ? el("span", { class: "fp-tag", text: row.format }) : null,
        el("span", { class: "fp-tag fp-fs", text: row.fsType || "-" }),
        features.drag ? el("span", { class: "fp-grip", "aria-hidden": "true", text: "⠿" }) : null,
      ],
    );
    node.style.height = `${ROW_HEIGHT}px`;
    return node;
  }

  const list = createVirtualList<PickerRow>({ scroller, rowHeight: ROW_HEIGHT, renderRow });
  dis.add(() => list.destroy());

  /**
   * Drop the roving position entirely. `aria-activedescendant` naming an element that is not in the
   * tree is worse than naming nothing: a screen reader is told to follow a pointer into a hole.
   */
  function clearActive(): void {
    activeIndex = -1;
    scroller.removeAttribute("aria-activedescendant");
    for (const node of scroller.querySelectorAll<HTMLElement>(".fp-row.active")) {
      node.classList.remove("active");
    }
  }

  /** Move the roving active option, keeping `aria-activedescendant` pointed at a real element. */
  function setActive(index: number): void {
    if (!rows.length) return;
    const next = Math.max(0, Math.min(rows.length - 1, index));
    activeIndex = next;
    // Only repaint when the target is NOT already materialised. Repainting unconditionally would
    // replace every row on each arrow press and on every click - which also detaches the node the
    // caller is still holding.
    const find = (): HTMLElement | null =>
      scroller.querySelector<HTMLElement>(`.fp-row[data-index="${next}"]`);
    let activeNode = find();
    if (!activeNode) {
      list.scrollToIndex(next); // materialises the row synchronously
      activeNode = find();
    }
    for (const node of scroller.querySelectorAll<HTMLElement>(".fp-row")) {
      node.classList.toggle("active", node.dataset.index === String(next));
    }
    // `aria-activedescendant` MUST name an element that is really in the tree; in a recycling list
    // that is only true after the window containing it has been painted, which scrollToIndex did.
    if (activeNode) scroller.setAttribute("aria-activedescendant", activeNode.id);
    else clearActive(); // could not be materialised at all - point at nothing rather than at a ghost
  }

  // ONE delegated listener set for the whole list - the rows carry none, so recycling a thousand of
  // them costs nothing to attach or detach.
  const rowFor = (e: Event): PickerRow | null => {
    const node = (e.target as HTMLElement | null)?.closest<HTMLElement>(".fp-row");
    const key = node?.dataset.key;
    return key ? (rows.find((r) => r.key === key) ?? null) : null;
  };
  dis.listen(scroller, "click", (e) => {
    const node = (e.target as HTMLElement | null)?.closest<HTMLElement>(".fp-row");
    const row = rowFor(e);
    if (!row) return;
    if (node?.dataset.index) setActive(Number(node.dataset.index));
    togglePick(row);
  });
  // The full listbox keyboard contract: Arrow Up/Down, Home/End, Enter/Space. Focus stays on the
  // listbox throughout, so it cannot be lost when a row is recycled or its state changes.
  dis.listen(scroller, "keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (!rows.length) return;
    switch (ke.key) {
      case "ArrowDown":
        ke.preventDefault();
        setActive(activeIndex < 0 ? 0 : activeIndex + 1);
        return;
      case "ArrowUp":
        ke.preventDefault();
        setActive(activeIndex < 0 ? rows.length - 1 : activeIndex - 1);
        return;
      case "Home":
        ke.preventDefault();
        setActive(0);
        return;
      case "End":
        ke.preventDefault();
        setActive(rows.length - 1);
        return;
      case "Enter":
      case " ": {
        ke.preventDefault();
        if (activeIndex < 0) setActive(0);
        const row = rows[activeIndex];
        if (row) togglePick(row);
        return;
      }
      default:
    }
  });
  dis.listen(scroller, "dragstart", (e) => {
    const de = e as DragEvent;
    const row = rowFor(e);
    if (row && de.dataTransfer) writeTransfer(de.dataTransfer, referenceForRow(row));
  });
  // There is deliberately NO `dragend` handler. A drag writes the payload; the DROP TARGET owns the
  // drop. Committing here as well means a host that (reasonably) wires its drop handler and
  // `onCommit` to the same function adds the data twice for one gesture.
  dis.listen(
    scroller,
    "scroll",
    () => {
      // Scrolling recycles rows. If the active option was one of them its element is gone, so the
      // roving position is dropped rather than left pointing at a detached id.
      const id = scroller.getAttribute("aria-activedescendant");
      if (id && !scroller.querySelector(`#${id}`)) clearActive();
      if (rows.length >= totalCount || engine.pending) return;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 240) {
        engine.loadMore(buildRequest, rows.length);
      }
    },
    { passive: true },
  );

  // Painting
  let chipBucket = dis.child();
  let facetBucket = dis.child();
  let ctlBucket = dis.child();

  function paintBusy(): void {
    const busy = status === "loading" || engine.pending;
    spinner.classList.toggle("on", busy);
    searchWrap.classList.toggle("busy", busy);
    searchInput.setAttribute("aria-busy", busy ? "true" : "false");
  }

  /** The immutable scope indicator. Never interactive; "Clear all" does not touch it. */
  function paintScope(): void {
    const items: HTMLElement[] = [];
    const seen = new Set<string>();
    for (const [k, v] of baseScopePairs(sc)) {
      const { baseKey, negated } = parseFacetKey(k);
      if (negated) continue; // rendered below, with an explicit ≠
      const text = `${labelFor(labels, baseKey)} = ${v}`;
      if (seen.has(text)) continue;
      seen.add(text);
      items.push(el("span", { class: "fp-scope-i", text }));
    }
    for (const [k, v] of baseScopeExclusions(sc)) {
      const text = `${labelFor(labels, k)} ≠ ${v}`;
      if (seen.has(text)) continue;
      seen.add(text);
      items.push(el("span", { class: "fp-scope-i neg", text }));
    }
    if (items.length) {
      replaceChildren(scopeRow, el("span", { class: "fp-scope-l", text: "Scope:" }), ...items);
    } else {
      replaceChildren(scopeRow);
    }
    scopeRow.classList.toggle("empty", items.length === 0);
  }

  function paintChips(): void {
    const out: HTMLElement[] = [];
    for (const key of Object.keys(sc.selected)) {
      // A gated key can never produce a chip. Sanitisation should already have removed it; this is
      // the second wall, so a future path into `sc.selected` cannot paint an inert control.
      if (gated(key)) continue;
      const { baseKey, negated } = parseFacetKey(key);
      const label = labelFor(labels, baseKey);
      for (const v of sc.selected[key]) {
        const btn = el(
          "button",
          {
            class: `fp-chip${negated ? " neg" : ""}`,
            type: "button",
            "aria-label": `Remove ${negated ? "exclusion" : "filter"}: ${label} ${negated ? "is not" : "is"} ${v}`,
          },
          [
            el("span", { class: "fp-chip-k", text: negated ? `${label} ≠` : label }),
            el("span", { class: "fp-chip-v", text: v }),
            el("span", { class: "fp-chip-x", "aria-hidden": "true", text: "×" }),
          ],
        );
        chipBucket.listen(btn, "click", () => {
          toggleFacetMode(sc, baseKey, v, negated); // same value, same mode -> removes it
          commit();
        });
        out.push(btn);
      }
    }
    if (out.length) {
      const clear = el("button", { class: "fp-clear", type: "button", text: "Clear all" });
      chipBucket.listen(clear, "click", () => {
        // Clears the USER'S question only. `sc.baseFilters` is untouched, so the scope survives -
        // it is the host's constraint, not a filter the user applied.
        for (const k of Object.keys(sc.selected)) delete sc.selected[k];
        sc.time = null;
        sc.bbox = null;
        searchText = "";
        searchInput.value = "";
        commit();
      });
      out.push(clear);
    }
    replaceChildren(chipsRow, ...out);
    chipsRow.classList.toggle("empty", out.length === 0);
  }

  function paintFacets(): void {
    const blocks: HTMLElement[] = [];
    for (const facet of facets) {
      const locked = gated(facet.key);
      // A gated facet shows ONLY its in-scope values - never an out-of-scope value a mis-scoped or
      // buggy server might return, which would read as an escape hatch that silently does nothing.
      const values = displayFacetValues(sc, facet);
      const active = locked
        ? 0
        : includedValues(sc, facet.key).length + excludedValues(sc, facet.key).length;
      if (!values.length && !active) continue;
      const open = expanded.has(facet.key);
      const shown = open ? values : values.slice(0, FACET_PREVIEW);
      const items = shown.map((v) => {
        if (locked) {
          // Locked: text, not controls. There is no toggle to press and no exclude button to find,
          // because neither could ever change the request.
          return el("div", { class: "fp-vrow locked" }, [
            el("div", { class: "fp-v locked", "aria-disabled": "true" }, [
              el("span", { class: "fp-v-t", text: v.value }),
              el("span", { class: "fp-v-c", text: v.count.toLocaleString("en-US") }),
            ]),
            el("span", {
              class: "fp-lock",
              text: "🔒",
              role: "img",
              "aria-label": `${facet.label} is fixed by this instance's scope`,
            }),
          ]);
        }
        const on = isSelected(sc, facet.key, v.value);
        const off = isExcluded(sc, facet.key, v.value);
        const inc = el(
          "button",
          {
            class: `fp-v${on ? " on" : ""}`,
            type: "button",
            "aria-pressed": on ? "true" : "false",
            "aria-label": `${on ? "Remove filter" : "Include"} ${facet.label} ${v.value}`,
          },
          [
            el("span", { class: "fp-v-t", text: v.value }),
            el("span", { class: "fp-v-c", text: v.count.toLocaleString("en-US") }),
          ],
        );
        const exc = el("button", {
          class: `fp-x${off ? " on" : ""}`,
          type: "button",
          text: "≠",
          "aria-pressed": off ? "true" : "false",
          "aria-label": `${off ? "Stop excluding" : "Exclude"} ${facet.label} ${v.value}`,
        });
        // Include and Exclude are MUTUALLY EXCLUSIVE for a (facet, value): toggleFacetMode drops the
        // pair from the other mode first, so one commit can never send both.
        facetBucket.listen(inc, "click", () => {
          toggleFacetMode(sc, facet.key, v.value, false);
          commit();
        });
        facetBucket.listen(exc, "click", () => {
          toggleFacetMode(sc, facet.key, v.value, true);
          commit();
        });
        return el("div", { class: `fp-vrow${off ? " excluded" : ""}` }, [inc, exc]);
      });
      // No separate "clear this facet" cross any more: the `+N` / `-N` badges ARE the clear
      // controls, and each is scoped to its own mode. `clearFacetModes` stays in use for the
      // places that genuinely mean both.
      void clearFacetModes;
      let more: HTMLElement | null = null;
      if (values.length > FACET_PREVIEW) {
        more = el("button", {
          class: "fp-more",
          type: "button",
          text: open ? "Show fewer" : `Show all ${values.length}`,
        });
        facetBucket.listen(more, "click", () => {
          if (expanded.has(facet.key)) expanded.delete(facet.key);
          else expanded.add(facet.key);
          paint();
        });
      }
      blocks.push(
        el("div", { class: `fp-facet${locked ? " locked" : ""}` }, [
          el("div", { class: "fp-fhead" }, [
            el("span", { class: "fp-fname", text: facet.label }),
            locked ? el("span", { class: "fp-fbadge lock", text: "scope" }) : null,
            // Same structural language as the full browser, and the same INDEPENDENCE: `+N`
            // clears only what is kept, `-N` only what is removed. The picker cannot import the
            // browser's components, so the two buttons are built here from the same counters.
            ...([
              { negative: false, count: includedValues(sc, facet.key).length },
              { negative: true, count: excludedValues(sc, facet.key).length },
            ]
              .filter((spec) => spec.count > 0)
              .map((spec) => {
                const word = spec.negative ? "excluded" : "included";
                const label = `Clear ${spec.count} ${word} ${facet.label} value${spec.count === 1 ? "" : "s"}`;
                const b = el(
                  "button",
                  {
                    class: `fp-fbadge fb ${spec.negative ? "fb-exc" : "fb-inc"}`,
                    type: "button",
                    "data-mode": spec.negative ? "exclude" : "include",
                    title: label,
                    "aria-label": label,
                  },
                  [
                    el("span", {
                      class: "fb-n",
                      text: `${spec.negative ? "\u2212" : "+"}${spec.count}`,
                    }),
                    el("span", { class: "fb-x", "aria-hidden": "true", text: "\u00d7" }),
                  ],
                );
                b.style.setProperty("--fb-ch", String(String(spec.count).length + 1));
                facetBucket.listen(b, "click", () => {
                  delete sc.selected[spec.negative ? `${facet.key}_not_` : facet.key];
                  commit();
                });
                return b;
              }) as HTMLElement[]),
          ]),
          ...items,
          more,
        ]),
      );
    }
    replaceChildren(facetsCol, ...blocks);
  }

  /** A compact disclosure: a one-line summary button, expanded only while the user is editing. */
  function disclosure(
    id: string,
    label: string,
    summary: string,
    active: boolean,
    body: HTMLElement,
  ): HTMLElement {
    const open = expanded.has(id);
    const btn = el(
      "button",
      {
        class: `fp-disc-h${active ? " on" : ""}`,
        type: "button",
        "aria-expanded": open ? "true" : "false",
      },
      [
        el("span", { class: "fp-disc-l", text: label }),
        el("span", { class: "fp-disc-s", text: summary }),
        el("span", { class: "fp-disc-c", "aria-hidden": "true", text: open ? "▾" : "▸" }),
      ],
    );
    ctlBucket.listen(btn, "click", () => {
      if (open) expanded.delete(id);
      else expanded.add(id);
      repaintControls();
    });
    return el("div", { class: `fp-disc${open ? " open" : ""}` }, [btn, open ? body : null]);
  }

  function paintControls(): void {
    const nodes: HTMLElement[] = [];
    if (features.time) {
      const from = el("input", { class: "fp-t", type: "text", "aria-label": "Time from" });
      const to = el("input", { class: "fp-t", type: "text", "aria-label": "Time to" });
      from.placeholder = "from";
      to.placeholder = "to";
      from.value = sc.time?.from ?? "";
      to.value = sc.time?.to ?? "";
      const apply = (): void => {
        const f = from.value.trim();
        const t = to.value.trim();
        sc.time = f || t ? { from: f, to: t, mode: sc.time?.mode ?? "flexible" } : null;
        commit();
      };
      ctlBucket.listen(from, "change", apply);
      ctlBucket.listen(to, "change", apply);
      const t = sc.time;
      nodes.push(
        disclosure(
          "__time",
          "Time",
          t ? `${t.from || "*"} → ${t.to || "*"}` : "any",
          !!t,
          el("div", { class: "fp-ctl" }, [from, to]),
        ),
      );
    }
    if (features.bbox) {
      const keys = ["minLon", "maxLon", "minLat", "maxLat"] as const;
      const inputs = keys.map((k) => {
        const i = el("input", { class: "fp-b", type: "number", "aria-label": k });
        i.placeholder = k;
        i.value = sc.bbox ? String(sc.bbox[k]) : "";
        return i;
      });
      const apply = (): void => {
        const n = inputs.map((i) => Number(i.value));
        const all = inputs.every((i) => i.value.trim() !== "") && n.every(Number.isFinite);
        sc.bbox = all
          ? {
              minLon: n[0],
              maxLon: n[1],
              minLat: n[2],
              maxLat: n[3],
              mode: sc.bbox?.mode ?? "flexible",
            }
          : null;
        commit();
      };
      for (const i of inputs) ctlBucket.listen(i, "change", apply);
      const b2 = sc.bbox;
      nodes.push(
        disclosure(
          "__bbox",
          "Area",
          b2 ? `${b2.minLon}, ${b2.maxLon}, ${b2.minLat}, ${b2.maxLat}` : "anywhere",
          !!b2,
          el("div", { class: "fp-ctl fp-ctl-bbox" }, inputs),
        ),
      );
    }
    replaceChildren(controlsCol, ...nodes);
  }

  /**
   * The ONE path that rebuilds the Time/Area controls.
   *
   * `paintControls()` allocates fresh inputs and fresh disclosure buttons and registers listeners
   * for all of them on `ctlBucket`. Calling it without first flushing that bucket therefore leaks a
   * full set of listeners per call: the nodes are replaced, but their disposers stay in the bucket,
   * so twenty opens and closes of the disclosure toggle would leave forty dead registrations
   * behind. Everything that rebuilds these controls goes through here, so the
   * flush cannot be forgotten at one call site and remembered at another.
   */
  function repaintControls(): void {
    ctlBucket.flush();
    ctlBucket = dis.child();
    paintControls();
  }

  function paintList(): void {
    replaceChildren(
      listHead,
      el("span", {
        class: "fp-lh",
        text:
          status === "loaded" || status === "empty"
            ? `${totalCount.toLocaleString("en-US")} file${totalCount === 1 ? "" : "s"}`
            : "Files",
      }),
      rows.length && rows.length < totalCount
        ? el("span", { class: "fp-lh-sub", text: `${rows.length} loaded` })
        : null,
    );
    const msg =
      status === "error"
        ? errorText
        : // A held search is announced even when rows are on screen: those rows answer the LAST
          // valid question, and letting a lens change look complete while it is still pending is
          // exactly the silence this transition handling exists to remove.
          heldSearch
          ? "Preparing scoped browsing…"
          : status === "loading" && rows.length === 0
            ? "Searching…"
            : status === "empty"
              ? "No files match these filters."
              : status === "idle"
                ? "Start typing to search, or pick a filter."
                : "";
    listState.textContent = msg;
    listState.classList.toggle("show", !!msg);
    listState.classList.toggle("err", status === "error");
    list.setItems(status === "error" ? [] : rows);
    // Empty and error states render no options at all, and a shrunk result set can leave the
    // roving index past the end. Either way the descendant id must go.
    if (rows.length === 0 || status === "error" || activeIndex >= rows.length) clearActive();
  }

  const nfmt = (n: number): string => n.toLocaleString("en-US");

  function paintFoot(): void {
    const ref = currentReference();
    // The count belongs to a specific question. The moment the question changes - or the lens
    // becomes unmappable, or the search fails - it stops being an answer, so it is suppressed
    // rather than shown next to a control it no longer describes.
    const countIsCurrent = resultsCurrent() && Number.isInteger(totalCount) && totalCount > 0;

    if (features.allFiltered) {
      // Each mode SHOWS ITS OWN SUBJECT, so switching is visibly a change of what will be added
      // rather than an unexplained toggle.
      const filesText =
        assets.length === 0
          ? "No files yet"
          : `${assets.length} file${assets.length === 1 ? "" : "s"}`;
      replaceChildren(
        modeFiles,
        el("span", { class: "fp-mode-t", text: "Selected files" }),
        el("span", { class: "fp-mode-n", text: filesText }),
      );
      replaceChildren(
        modeQuery,
        el("span", { class: "fp-mode-t", text: "All filtered results" }),
        el("span", {
          class: "fp-mode-n",
          text: countIsCurrent ? `All ${nfmt(totalCount)} results` : "Waiting for results…",
        }),
      );
      modeFiles.classList.toggle("on", !useAllFiltered);
      modeQuery.classList.toggle("on", useAllFiltered);
      modeFiles.setAttribute("aria-checked", useAllFiltered ? "false" : "true");
      modeQuery.setAttribute("aria-checked", useAllFiltered ? "true" : "false");
      // Disabled whenever the count is not an answer to the CURRENT question - while waiting, after
      // a mapping failure, after a search failure, and whenever the visible results belong to an
      // older revision. It stays `aria-checked` if that is the mode we are in: that is honest, and
      // "Selected files" is always available to leave by.
      modeQuery.disabled = !countIsCurrent;
      // Roving tabindex: one stop for the whole group, as a radio group should have - but the stop
      // has to be a control the user can actually reach and operate. Query mode can be BOTH checked
      // and disabled (we entered it, then a replacement search went stale), and giving the group's
      // only tab stop to a disabled button strands keyboard users outside the footer entirely. When
      // query mode is unavailable the stop moves to "Selected files", which is never disabled.
      const stop = useAllFiltered && !modeQuery.disabled ? modeQuery : modeFiles;
      modeFiles.tabIndex = stop === modeFiles ? 0 : -1;
      modeQuery.tabIndex = stop === modeQuery ? 0 : -1;
      // …and if focus was ON query mode at the moment it became unavailable, it is now sitting on a
      // disabled control. Move it to the reachable one rather than letting it fall to <body>.
      if (modeQuery.disabled && root.ownerDocument.activeElement === modeQuery) modeFiles.focus();
      modeFiles.setAttribute("aria-label", `Add selected files - ${filesText}`);
      modeQuery.setAttribute(
        "aria-label",
        countIsCurrent
          ? `Add all ${nfmt(totalCount)} filtered results`
          : "Add all filtered results",
      );
      // The note explains what query mode ACTUALLY does, which is the thing the checkbox never said.
      modeNote.textContent = note
        ? note
        : useAllFiltered
          ? "A query reference will be added; individual rows are not selected."
          : "";
    } else {
      countText.textContent = note
        ? note
        : assets.length === 0
          ? "Nothing selected"
          : `${assets.length} of ${MAX_PICKER_ASSETS} selected`;
      modeNote.textContent = "";
    }
    countText.classList.toggle("warn", !!note);
    modeNote.classList.toggle("warn", !!note);
    modeNote.classList.toggle("show", !!modeNote.textContent);

    // The action states its own SCOPE, so pressing it is never a guess about what is about to
    // happen. `commitLabel` stays the base label.
    const label = config.commitLabel ?? "Add selection";
    const scope =
      ref === null
        ? null
        : ref.kind === "query"
          ? `all ${nfmt(totalCount)}`
          : `${assets.length} file${assets.length === 1 ? "" : "s"}`;
    replaceChildren(
      addBtn,
      el("span", { class: "fp-add-l", text: label }),
      scope ? el("span", { class: "fp-add-s", text: `· ${scope}` }) : null,
    );
    // Enabled EXACTLY when there is something to commit - the button and `getReference()` cannot
    // disagree, because the button asks `getReference()`.
    addBtn.disabled = ref === null;
    addBtn.setAttribute(
      "aria-label",
      ref === null
        ? `${label}: nothing selected yet`
        : ref.kind === "query"
          ? `${label}: all ${nfmt(totalCount)} filtered results`
          : `${label}: ${assets.length} file${assets.length === 1 ? "" : "s"}`,
    );
    note = ""; // one-shot
  }

  function paint(): void {
    chipBucket.flush();
    chipBucket = dis.child();
    facetBucket.flush();
    facetBucket = dis.child();
    paintBusy();
    paintScope();
    paintChips();
    paintFacets();
    repaintControls();
    paintList();
    paintFoot();
  }

  // Autocomplete
  let matches: ValueMatch[] = [];
  let hl = 0;
  let acOpen = false;
  let acBucket: Disposables | null = null;

  const acItemId = (i: number): string => `${uid}-ac-opt-${i}`;

  const hideAc = (): void => {
    acOpen = false;
    acPop.classList.remove("show");
    searchInput.setAttribute("aria-expanded", "false");
    // The combobox must not keep naming an option that no longer exists.
    searchInput.removeAttribute("aria-activedescendant");
    replaceChildren(acPop);
    acBucket?.flush();
    acBucket = null;
  };

  const chooseMatch = (i: number, negated = false): void => {
    const m = matches[i];
    if (!m || gated(m.key)) return; // belt and braces: gated keys never reach `matches`
    searchInput.value = "";
    searchText = "";
    hideAc();
    toggleFacetMode(sc, m.key, m.value, negated);
    commit();
  };

  const paintHl = (): void => {
    let active: HTMLElement | null = null;
    acPop.querySelectorAll<HTMLElement>(".fp-ac-item").forEach((n, i) => {
      const on = i === hl;
      n.classList.toggle("hl", on);
      n.setAttribute("aria-selected", on ? "true" : "false");
      if (on) active = n;
    });
    // Keep the COMBOBOX's own activedescendant in step with the highlighted match: the input holds
    // focus throughout, so this is the only thing that tells a screen reader which option is live.
    if (active) searchInput.setAttribute("aria-activedescendant", (active as HTMLElement).id);
    else searchInput.removeAttribute("aria-activedescendant");
  };

  const positionAc = (): void => {
    const w = searchInput.getBoundingClientRect().width;
    positionAnchored(overlayRoot, acPop, searchInput, {
      placement: "below",
      gap: 4,
      minWidth: Math.max(w, 240),
      maxWidth: Math.max(w, 460),
    });
  };

  const renderAc = (): void => {
    // The SHARED ranker - the picker orders "tas" exactly as the full browser does. A gated facet
    // is filtered out entirely: completing a value the scope owns would create an inert filter.
    matches = rankValueMatches(
      facets.filter((f) => !gated(f.key)),
      searchInput.value,
      {
        label: (f) => labelFor(labels, f.key),
        isApplied: (k, v) => isSelected(sc, k, v) || isGatedValue(sc, k, v),
        limit: 25,
      },
    );
    acBucket?.flush();
    acBucket = dis.child();
    const reg = acBucket;
    if (!matches.length) {
      if (searchInput.value.trim()) {
        replaceChildren(
          acPop,
          el("div", { class: "fp-ac-empty", text: "No matching facet values." }),
        );
        acPop.classList.add("show");
        acOpen = true;
        searchInput.setAttribute("aria-expanded", "true");
        searchInput.removeAttribute("aria-activedescendant"); // nothing to point at
        positionAc();
      } else hideAc();
      return;
    }
    hl = 0;
    const items = matches.map((m, i) => {
      const exc = el("button", {
        class: "fp-ac-x",
        type: "button",
        text: "≠",
        tabindex: "-1",
        "aria-label": `Exclude ${m.label} ${m.value}`,
      });
      const item = el(
        "div",
        {
          class: `fp-ac-item${i === 0 ? " hl" : ""}`,
          id: acItemId(i),
          role: "option",
          "aria-selected": i === 0 ? "true" : "false",
          "aria-posinset": String(i + 1),
          "aria-setsize": String(matches.length),
        },
        [
          el("span", { class: "fp-ac-k", text: m.label }),
          el("span", { class: "fp-ac-v", text: m.value }),
          el("span", { class: "fp-ac-c", text: m.count.toLocaleString("en-US") }),
          exc,
        ],
      );
      reg.listen(exc, "mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        chooseMatch(i, true);
      });
      reg.listen(item, "mousedown", (e) => {
        e.preventDefault();
        chooseMatch(i);
      });
      return item;
    });
    replaceChildren(acPop, ...items);
    acPop.classList.add("show");
    acOpen = true;
    searchInput.setAttribute("aria-expanded", "true");
    paintHl(); // sets aria-activedescendant on the combobox for the initial highlight
    positionAc();
  };

  dis.listen(searchInput, "input", () => {
    searchText = searchInput.value;
    renderAc();
    notifyState();
  });
  dis.listen(searchInput, "focus", () => {
    if (searchInput.value.trim()) renderAc();
  });
  dis.listen(searchInput, "blur", () => dis.setTimeout(hideAc, 120));
  dis.listen(searchInput, "keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (!acOpen) {
      if (ke.key === "ArrowDown" && searchInput.value.trim()) {
        ke.preventDefault();
        renderAc();
      }
      return;
    }
    if (ke.key === "ArrowDown") {
      ke.preventDefault();
      hl = Math.min(matches.length - 1, hl + 1);
      paintHl();
    } else if (ke.key === "ArrowUp") {
      ke.preventDefault();
      hl = Math.max(0, hl - 1);
      paintHl();
    } else if (ke.key === "Home") {
      ke.preventDefault();
      hl = 0;
      paintHl();
    } else if (ke.key === "End") {
      ke.preventDefault();
      hl = matches.length - 1;
      paintHl();
    } else if (ke.key === "Enter") {
      ke.preventDefault();
      chooseMatch(hl, ke.shiftKey); // Shift+Enter excludes - the keyboard twin of the ≠ button
    } else if (ke.key === "Escape") {
      ke.preventDefault();
      hideAc();
    }
  });
  dis.listen(window, "resize", () => {
    if (acOpen) positionAc();
  });

  // Footer + lens
  /**
   * Switch mode. Updates state and `getReference()` - and calls NOTHING else: a mode change is not
   * a commit, so `onCommit` stays untouched until the user presses the action.
   */
  function setMode(query: boolean): void {
    const next = features.allFiltered && query;
    if (next === useAllFiltered) return;
    useAllFiltered = next;
    if (useAllFiltered) assets = []; // the two are alternatives, never a combination
    notifyState();
    syncRowStates(); // …and query mode does NOT tick every row: the list stays untouched
    paintFoot();
  }
  dis.listen(modeFiles, "click", () => {
    setMode(false);
    modeFiles.focus();
  });
  dis.listen(modeQuery, "click", () => {
    setMode(true);
    modeQuery.focus();
  });
  dis.listen(modes, "keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ke.key)) return;
    ke.preventDefault();
    const toQuery = ke.key === "ArrowRight" || ke.key === "ArrowDown";
    // Arrowing INTO a mode that cannot be entered would move the selection to a control the user
    // then cannot act on. When query mode is unavailable the arrow is simply inert - the group
    // stays where it is, on the mode that works.
    if (toQuery && modeQuery.disabled) return;
    setMode(toQuery);
    (toQuery ? modeQuery : modeFiles).focus();
  });
  // The Add button is the ONLY thing that calls `onCommit`. A drag writes the payload and the drop
  // target owns the drop - WCAG 2.2 "Dragging Movements" is satisfied by this button, which does
  // the identical operation and is keyboard-operable.
  dis.listen(addBtn, "click", () => {
    const ref = currentReference();
    if (ref) config.onCommit?.(ref);
  });
  /**
   * Enter `to`, translating the current selection into it. ATOMIC: either everything happens - the
   * re-key, the scope sanitisation, the state notification, the repaint and exactly one request -
   * or nothing does and the last valid lens is kept while the mapping is awaited.
   *
   * `translateSelection` is the full browser's own suffix-aware translator, so `project_not_=cmip5`
   * becomes `mip_era_not_=cmip5` rather than a discarded filter or a mis-keyed one. Explicit asset
   * picks are concrete files and have nothing to do with the lens, so they are never touched.
   */
  function requestFlavour(to: string): void {
    if (to === pendingFlavour) return;
    if (to === sc.flavour && pendingFlavour === null) return;
    pendingSuppliedSelection = false; // an interactive switch always re-keys what is on screen
    if (!canEnterFlavour(to)) {
      if (mapsSettled) {
        // Nothing more is coming. Stay where we are and say so - do NOT half-enter the new lens.
        pendingFlavour = null;
        status = "error";
        errorText = SCOPE_ERROR;
        paintFlavours();
        paint();
        return;
      }
      pendingFlavour = to;
      engine.cancel(); // no request may be in flight for a lens we are leaving
      heldSearch = true;
      status = "loading";
      paintFlavours(); // the control shows what the user asked for; the list says it is preparing
      paint();
      return;
    }
    applyFlavourTransition(to);
  }

  /** The transition itself, only ever called once the target lens is known to be enterable. */
  function applyFlavourTransition(to: string): void {
    if (!pendingSuppliedSelection) {
      const translated = translateSelection(sc, sc.selected, sc.flavour, to);
      for (const k of Object.keys(sc.selected)) delete sc.selected[k];
      for (const [k, v] of Object.entries(translated)) sc.selected[k] = v;
    }
    pendingSuppliedSelection = false;
    sc.flavour = to;
    sanitizeAgainstScope(sc, sc.selected); // the gated key is named differently under the new lens
    pendingFlavour = null;
    expanded = new Set();
    clearActive();
    paintFlavours();
    commit();
  }

  dis.listen(flavourSel, "change", () => requestFlavour(flavourSel.value));

  function paintFlavours(): void {
    if (!features.flavour) return;
    // The control shows what the user ASKED for while a transition is pending, and snaps back to
    // the last valid lens if that transition cannot be completed.
    const shown = pendingFlavour ?? sc.flavour;
    const options = flavours.length ? flavours : [...new Set([sc.flavour, shown])];
    replaceChildren(
      flavourSel,
      ...options.map((f) => {
        const o = el("option", { value: f, text: f });
        if (f === shown) o.selected = true;
        return o;
      }),
    );
  }

  // Bootstrap
  paint();
  paintFlavours();
  // Fail-closed from the very first request: a scoped custom flavour issues NOTHING until its
  // mapping is known. `commit()` owns that decision, so there is one implementation of it.
  if (canScopedSearch()) {
    engine.runNow(buildRequest);
  } else {
    heldSearch = true;
    status = "loading";
    paint();
  }

  /**
   * Apply resolved flavour mappings, then settle whatever was waiting on them.
   *
   * The re-sanitisation is NOT conditional. Before the map arrived, `baseFilterKeys` could not
   * translate the scope's freva-canonical key into this flavour's naming, so a restored selection
   * on the (differently named) gated key looked legitimate and survived. It only becomes visible as
   * gated now - and state that is absent from the wire but present in `getState()` is exactly the
   * inert-filter class of bug the scope work exists to remove.
   */
  function applyFlavourMaps(list: FlavourMapping[] | null): void {
    if (dis.isDisposed) return;
    if (list) sc.flavourMaps = { ...sc.flavourMaps, ...buildFlavourMaps(list) };
    mapsSettled = true;

    const before = JSON.stringify(sc.selected);
    sanitizeAgainstScope(sc, sc.selected);
    const sanitised = JSON.stringify(sc.selected) !== before;

    // 1. A lens the user asked for and could not enter yet.
    if (pendingFlavour !== null) {
      const to = pendingFlavour;
      if (canEnterFlavour(to)) {
        heldSearch = false;
        applyFlavourTransition(to); // notifies, repaints and issues exactly one request
      } else {
        pendingFlavour = null;
        pendingSuppliedSelection = false;
        heldSearch = false;
        status = "error";
        errorText = SCOPE_ERROR;
        paintFlavours();
        paint();
      }
      return;
    }

    // 2. A first search held back because the scope could not be keyed.
    if (heldSearch) {
      heldSearch = false;
      if (canScopedSearch()) {
        if (sanitised) notifyState();
        paint(); // the newly-gated facet has to render locked before its results arrive
        engine.runNow(buildRequest); // exactly one search, now correctly keyed
      } else {
        status = "error";
        errorText = SCOPE_ERROR;
        paint();
      }
      return;
    }

    // 3. Nothing was waiting - but sanitisation may still have changed the answer.
    if (sanitised) {
      notifyState();
      commit();
    } else {
      paint(); // a newly-known mapping can change which facet renders locked
    }
  }

  {
    const boot = dis.abortController();

    // The two fetches are STARTED TOGETHER and awaited independently. The lens list is optional
    // chrome; the mappings gate every scoped request. Awaiting the optional one first would let
    // `/overview` latency (or a hang) delay a search that only ever needed `/flavours`.
    const overviewDone = (async () => {
      if (!restClient || !features.flavour) return;
      try {
        const ov = await restClient.overview(boot.signal);
        if (dis.isDisposed) return;
        flavours = Array.isArray(ov.flavours) ? ov.flavours : [];
        paintFlavours();
      } catch {
        /* its absence must not break the picker */
      }
    })();

    const mapsDone = (async () => {
      // An explicit host hook wins, otherwise the default REST client's own endpoint, otherwise
      // nothing - an injected client with no hook has only the builtin maps.
      try {
        if (config.resolveFlavourMaps) {
          applyFlavourMaps(await config.resolveFlavourMaps());
        } else if (restClient) {
          const fl = await restClient.flavours(boot.signal);
          applyFlavourMaps(
            (fl.flavours ?? []).filter(
              (f): f is FlavourMapping => typeof f.flavour_name === "string" && !!f.mapping,
            ),
          );
        } else {
          applyFlavourMaps(null);
        }
      } catch {
        applyFlavourMaps(null); // settled-and-failed: a held scoped search now fails visibly
      }
    })();

    void Promise.all([overviewDone, mapsDone]);
  }

  // Handle
  return {
    getState: () => clonePickerState(snapshot()),
    setState(next) {
      // WHOSE NAMING is `selected` in? The contract says: the flavour it ships WITH.
      //  • `{ flavour, selected }` - the host has already expressed the keys in that lens, so they
      //    are taken verbatim.
      //  • `{ flavour }` alone - the existing selection is in the OLD lens and must be translated,
      //    exactly as the on-screen control does.
      //  • `{ selected }` alone - same lens, nothing to translate.
      const wantsFlavour = "flavour" in next && typeof next.flavour === "string" && !!next.flavour;
      const suppliesSelected = "selected" in next;
      const target = wantsFlavour ? (next.flavour as string) : sc.flavour;
      const translateNeeded = wantsFlavour && !suppliesSelected && target !== sc.flavour;

      const merged = normalize({ ...clonePickerState(snapshot()), ...next }, sc.flavour);

      // Everything that is NOT the lens applies immediately; a lens that cannot be entered yet must
      // not take the rest of the update hostage.
      sc.uniqKey = merged.uniqKey;
      sc.time = merged.time;
      sc.bbox = merged.bbox;
      searchText = merged.search;
      searchInput.value = merged.search;
      assets = [...merged.assets];
      useAllFiltered = merged.useAllFiltered;
      expanded = new Set();
      clearActive();

      if (!translateNeeded) {
        for (const k of Object.keys(sc.selected)) delete sc.selected[k];
        for (const [k, v] of Object.entries(merged.selected)) sc.selected[k] = v;
      }
      if (target !== sc.flavour) {
        if (translateNeeded) {
          // requestFlavour re-keys the CURRENT selection and commits, or holds atomically.
          requestFlavour(target);
          return;
        }
        // Keys already in the target lens: enter it without translating, still atomically.
        if (canEnterFlavour(target)) {
          sc.flavour = target;
          pendingFlavour = null;
        } else if (!mapsSettled) {
          pendingSuppliedSelection = true; // do not translate when the map lands
          pendingFlavour = target;
          engine.cancel();
          heldSearch = true;
          status = "loading";
        } else {
          status = "error";
          errorText = SCOPE_ERROR;
          paintFlavours();
          paint();
          return;
        }
      }
      sanitizeAgainstScope(sc, sc.selected); // the scope wins over anything a host supplies
      paintFlavours();
      commit();
    },
    getReference: () => currentReference(),
    setTheme(mode) {
      root.setAttribute("data-theme", mode === "night" ? "night" : "day");
    },
    destroy() {
      hideAc();
      dis.flush();
    },
  };
}
