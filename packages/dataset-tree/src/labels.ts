// labels.ts - every string the component can print, in one place, so a consumer can translate the
// whole thing without touching the view.

import type { DatasetTreeLabels } from "./types.js";

/**
 * The shipped English strings. `filter` says what the field searches: a name, a title or a path,
 * anywhere in the archive. `filterHint` is the caveat for when that is not true - a lazy source,
 * where only the branches somebody opened are in memory - and appears only then: a filter that
 * silently searches part of a tree is the most misleading thing a lazy tree can do, and printing
 * the warning over a complete snapshot, where it is false, is the second. The `search*` set goes
 * one step further: with a consumer-supplied index the field becomes a search over what was
 * indexed rather than a filter over what is loaded, so it is named differently and its caveat is
 * whichever of two honest statements the index's own `complete` flag earns.
 */
export const DEFAULT_LABELS: DatasetTreeLabels = {
  filter: "Filter datasets and paths\u2026",
  filterHint: "Only items already loaded are searched. Expand a branch to include it.",
  filterNoMatches: "Nothing matches {query}.",
  filterClear: "Clear filter",
  collapseAll: "Collapse all",
  expandAll: "Expand all",
  collapseTree: "Collapse",
  reload: "Reload",

  loadingRoots: "Loading datasets…",
  loadingChildren: "Listing…",
  rootsEmpty: "No datasets to show.",
  childrenEmpty: "Empty",
  rootsError: "Could not load datasets - {error}",
  childrenError: "Could not list - {error}",
  retry: "Retry",

  expand: "Expand {name}",
  collapse: "Collapse {name}",
  showDetails: "Show details for {name}",
  hideDetails: "Hide details for {name}",
  closeDetails: "Close",

  copyPath: "Copy path",
  copyExample: "Copy code",
  copied: "Copied",
  copyFailed: "Copy failed",
  inspect: "Inspect",
  openLink: "Open {name} in a new tab",
  accessHeading: "How to access",
  tryPython: "Try in Python",
  tryPythonFor: "Run the {name} example in Python",

  fieldPath: "Path",
  fieldSize: "Size",
  fieldMediaType: "Type",
  fieldModified: "Modified",
  fieldDescription: "About",
  fieldAccess: "Access",

  plannedBadge: "planned",
  restrictedBadge: "restricted",
  unavailableBadge: "unavailable",
  // The generic word; a deployment's own wording is a label override. A phrase like "nothing
  // published yet" reads better in some archives and worse in others, and choosing one here would
  // put a particular deployment's voice in a package eleven others import - which
  // `external-consumer.test.ts` enforces, barring the restored archive's vocabulary from `src/`.
  emptyBadge: "empty",

  selectionEmpty: "Select an item to see its path",
  selectionLabel: "Selected path",
  pathShowAll: "Show the whole path",

  announceRootsLoading: "Loading datasets.",
  announceRootsLoaded: "{count} datasets loaded.",
  announceChildrenLoading: "Loading contents of {name}.",
  announceChildrenLoaded: "{count} items loaded under {name}.",
  announceChildrenEmpty: "{name} is empty.",
  announceFailed: "Loading {name} failed. {error}",
  announceCollapsedAll: "All branches collapsed.",
  announceExpandedAll: "All branches expanded.",
  announceFiltered: "{count} items match {query}.",
  announceFilterCleared: "Filter cleared.",

  searchIndexed: "Search datasets and paths\u2026",
  searchHintComplete: "The whole indexed archive is searched.",
  searchHintPartial: "The index may not cover everything; results can be incomplete.",
  searchHintGenerated: "Index generated {generatedAt}.",
  searchResults: "{count} results",
  searchResultsTruncated: "Showing the first {shown} of {count} results.",
  searchResultLocation: "in {path}",
  announceSearched: "{count} results for {query}.",
};

/** Merge a partial override set over the defaults. */
export function resolveLabels(overrides?: Partial<DatasetTreeLabels>): DatasetTreeLabels {
  if (!overrides) return DEFAULT_LABELS;
  const out = { ...DEFAULT_LABELS };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") (out as Record<string, string>)[key] = value;
  }
  return out;
}

/**
 * `{name}`-style substitution. Values are inserted into a template that is only ever assigned with
 * `textContent`, so this is string formatting and not a template engine - there is nothing here to
 * inject into.
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
