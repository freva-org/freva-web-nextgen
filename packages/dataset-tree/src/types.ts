// types.ts - the normalized data model and the public option surface. Every adapter (snapshot, S3,
// or a consumer's own) speaks only this model, so the view never learns a node's origin and one
// component serves a build-time catalog and a live object store alike.

/**
 * What a node *is*, deciding its icon and whether it can be opened. `collection` is a top-level
 * grouping (project, bucket, programme), `directory` an interior one, `dataset` a leaf carrying
 * detail rather than children, `file` an ordinary object shown for completeness, never expandable.
 * A `dataset` MAY still declare `hasChildren` if a source models it as browsable.
 */
export type DatasetTreeNodeKind = "collection" | "directory" | "dataset" | "file";

/**
 * Whether the data behind a node can be reached, when - and only when - the source says so. The
 * component never probes and shows no "checking..." state; a node with no `availability` is plain.
 */
export type DatasetTreeAvailability =
  | "available"
  | "planned"
  | "restricted"
  | "unavailable"
  // Listed, and proved to hold nothing yet. `unavailable` is a claim about reachability, `empty` a
  // claim about contents that only a listing which SUCCEEDED and came back with nothing can make;
  // a source that could not tell leaves `availability` undefined.
  | "empty";

/** One way to reach the data behind a node. */
export interface DatasetTreeAccess {
  /** Short human label for the route, e.g. "HTTPS", "S3", "OPeNDAP". */
  label: string;
  // An absolute URL. Rendered as a link ONLY when the scheme is one a browser can safely follow
  // (`https:`, and `http:` for local and intranet deployments); anything else is shown as a
  // copyable literal.
  href?: string;
  // A copyable literal when there is nothing to link to (an `s3://` URI, a mount path).
  value?: string;
  // One line of prose about this route.
  description?: string;
}

/**
 * A code sample a consumer supplies for a node, through `DatasetTreeOptions.accessExamples`; the
 * package ships none. `id` and `language` are REQUIRED and load-bearing for "Try in Python":
 * `language` separates a snippet that may be executed from one that must not be, and `id` is the
 * only stable name an execution layer resolves a snippet by, so neither may be derived from render
 * order.
 */
export interface DatasetAccessExample {
  /**
   * Stable identity for this example, unique within the node. Travels in `TryPythonEvent` and is
   * what an execution layer looks up in its own registry, so it must not depend on render order.
   */
  id: string;
  /** Tab label, e.g. "Python", "CLI", "s3fs". */
  label: string;
  /**
   * The snippet. Rendered as text, never parsed, never executed BY THIS PACKAGE: the component has
   * no interpreter and never gains one. See `DatasetTreePython`.
   */
  code: string;
  /**
   * The snippet's language, e.g. `"python"`, `"shell"`, `"yaml"`. Shown in the code card's caption,
   * and consulted when deciding whether this example is eligible for "Try in Python".
   */
  language: string;
  // One line of prose shown above the snippet.
  description?: string;
  // Whether this example is a complete program that may be executed as-is. Opt-in, so a snippet
  // tagged `python` that is really a fragment, a shell transcript or a fill-in-the-blanks template
  // can never acquire a run button by accident.
  executable?: boolean;
  // The lowercase hex SHA-256 of the exact source this example was registered under, its identity
  // in the build's registered-example manifest. The component checks only that it is present and
  // well-formed; matching it to the source is the execution layer's job.
  digest?: string;
}

/**
 * What the component hands a host when the user presses "Try in Python" - not the Python source.
 * The event is built to cross an origin boundary to a sandboxed interpreter, and a message carrying
 * source would turn its receiver into a remote code execution surface.
 */
export interface TryPythonEvent {
  /** `DatasetAccessExample.id` of the example the user pressed. */
  exampleId: string;
  /** The example's registered digest, unchanged. */
  digest: string;
  // The node the example belongs to, when the component knows it.
  datasetId?: string;
}

/**
 * The optional "Try in Python" integration. Supplying this is the ONLY way a run control appears:
 * the component neither loads an interpreter nor knows one exists, it renders a button and reports
 * a press, and how, where and whether the code runs belongs to the host.
 */
export interface DatasetTreePython {
  // Default `true` when this object is present. `false` is for a host that keeps its wiring but has
  // the feature off in configuration - the control disappears without rebuilding options.
  enabled?: boolean;
  /** Called with the press. Never called with code. */
  onTry: (event: TryPythonEvent) => void;
}

/**
 * A compact, right-aligned fact about a node, shown on its row: only what a source explicitly asks
 * for appears, never every property the generic model happens to carry. `style` chooses between a
 * bordered pill (a label + value pair, e.g. `HP 7`) and plain micro-text (a bare quantity, e.g. a
 * size); a metric is a fact, not a status, so there is no colour vocabulary.
 */
export interface DatasetTreeMetric {
  // Optional leading label, rendered lighter than the value.
  label?: string;
  /** The value. Rendered as text. */
  value: string;
  // Default `pill`.
  style?: "pill" | "plain";
}

/** One value inside a detail field. `value` is emphasised after `text` when both are present. */
export interface DatasetTreeDetailValue {
  text: string;
  value?: string;
}

/**
 * One row of the expanded detail panel, named and ordered by the source: only what a source asked
 * for, never every property the node carries beside whatever metadata the source attached.
 */
export interface DatasetTreeDetailField {
  label: string;
  values: readonly DatasetTreeDetailValue[];
}

/** A link to a project or document page, shown beside a collection's description. */
export interface DatasetTreeLink {
  /** Absolute URL. Rendered only when the scheme is one a browser can safely follow. */
  href: string;
  // Accessible name. Defaults to a generic "project page" phrasing.
  label?: string;
}

/**
 * One node of the tree. `id` must be stable and unique within one catalog and must NOT be derived
 * from array position: the same input must produce the same identifiers on every build, so an
 * expanded path can be restored and a snapshot diffed between builds. The snapshot parser enforces
 * uniqueness; the S3 adapter derives `s3://bucket/key`, unique by construction.
 */
export interface DatasetTreeNode {
  id: string;
  kind: DatasetTreeNodeKind;
  /** The name as it appears in the store: a path segment, an object key's last part. */
  name: string;
  // A friendlier display name. Falls back to `name`.
  title?: string;
  // Full location, shown and copyable. Rendered as text; never resolved or fetched.
  path?: string;
  description?: string;
  // Whether this node can be opened. Omitted means "decide from `kind`": collections and
  // directories are expandable, datasets and files are not. Set it when the source knows better -
  // an empty directory that should still open to show "Empty", or a dataset with browsable parts.
  hasChildren?: boolean;
  // Bytes. Rendered in binary units.
  size?: number;
  mediaType?: string;
  // ISO-8601. Rendered as `YYYY-MM-DD HH:MM UTC`; an unparseable value is shown verbatim.
  modifiedAt?: string;
  availability?: DatasetTreeAvailability;
  // Overrides the default badge text for `availability`, e.g. "available 2027".
  availabilityNote?: string;
  access?: readonly DatasetTreeAccess[];
  // A project or document page, shown beside a collection's description.
  link?: DatasetTreeLink;
  // Compact facts for the row's right edge. At most four are drawn; the rest are dropped rather
  // than allowed to push the name out of the row.
  metrics?: readonly DatasetTreeMetric[];
  // The rows of the expanded detail panel, chosen and ordered by the source.
  details?: readonly DatasetTreeDetailField[];
  // An absolute `http(s):` URL an inspector can open for this node - in a deployment, `https:`. The
  // inspect control needs both this and `onInspect`; either alone draws nothing, which keeps a dead
  // button off the page.
  inspect?: string;
  // Free-form source metadata. Carried for consumers and inspectors; NEVER rendered. Turning
  // arbitrary keys into visible chips is how a generic model dictates a consumer's visual
  // language - `details` is the field that puts something on screen.
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * One ancestor of a search-index entry: enough to draw a breadcrumb, and nothing more. NOT a tree
 * node - an index entry names things the component may never have loaded, and inserting one into
 * the browsing tree would pretend its branch had been fetched.
 */
export interface DatasetTreeSearchAncestor {
  id: string;
  name: string;
  title?: string;
  path?: string;
}

/**
 * One searchable thing in a pre-generated index: a narrow projection of {@link DatasetTreeNode} -
 * the three strings search matches on, the two facts a result row shows, and the breadcrumb.
 * Everything else is absent because an index is read into memory whole and searched on every
 * keystroke, so every field it carries is paid for by every consumer on every search.
 */
export interface DatasetTreeSearchIndexEntry {
  /** Stable and unique within the index. The same identity space as {@link DatasetTreeNode.id}. */
  id: string;
  kind: DatasetTreeNodeKind;
  name: string;
  title?: string;
  path?: string;
  // Bytes. Rendered in binary units on the result row.
  size?: number;
  // ISO-8601. Rendered as `YYYY-MM-DD HH:MM UTC`.
  modifiedAt?: string;
  // Root-first. Drawn as the result's breadcrumb.
  ancestors?: readonly DatasetTreeSearchAncestor[];
}

/**
 * A flat, pre-generated search index: OPTIONAL, and never the tree's data source. Browsing data
 * comes from a {@link DatasetTreeSource}; this is a second, independent thing that only search
 * reads, so a search over a lazily-listed object store can cover objects nobody has opened without
 * recursively listing a bucket on a keystroke. The package never generates, fetches or refreshes
 * one: a consumer loads the JSON however it likes, validates it with
 * `parseDatasetTreeSearchIndexV1` from `@freva-org/dataset-tree/search-index`, and passes the
 * parsed value in.
 */
export interface DatasetTreeSearchIndex {
  readonly schemaVersion: 1;
  /**
   * When the generator ran, ISO-8601. Optional, and never invented: an index is a snapshot of
   * something that moves, and a reader judging a result needs its age.
   */
  readonly generatedAt?: string;
  /** The location the index describes, e.g. an object-store endpoint. Text only, never fetched. */
  readonly source?: string;
  /**
   * Whether the index claims to cover the WHOLE archive. Required and explicit, because it decides
   * what the component tells the reader: `true` announces the search as covering everything
   * indexed, `false` keeps a caveat. A generator that cannot honestly claim completeness says
   * `false`.
   */
  readonly complete: boolean;
  readonly entries: readonly DatasetTreeSearchIndexEntry[];
}

/** The cancellation context handed to every source call. */
export interface DatasetTreeLoadContext {
  readonly signal: AbortSignal;
}

/**
 * Where nodes come from: two methods, both cancellable. A source may be synchronous underneath -
 * the snapshot adapter is - as long as it honours the signal, because the view aborts on collapse,
 * reload and destroy and discards whatever a stale call resolves to.
 */
export interface DatasetTreeSource {
  /**
   * Whether this source can answer for the WHOLE archive without another request. A build-time
   * snapshot can; a live object store cannot. It decides whether `Expand all` is offerable, whether
   * the filter is total or partial, and whether the component warns it is searching only part of
   * the tree. `true` promises `loadChildren` resolves locally for every node the source will ever
   * return, and the component walks the whole thing once, at mount, on that promise. Omitted means
   * `false`.
   */
  readonly complete?: boolean;
  loadRoots(context: DatasetTreeLoadContext): Promise<readonly DatasetTreeNode[]>;
  loadChildren(
    node: DatasetTreeNode,
    context: DatasetTreeLoadContext,
  ): Promise<readonly DatasetTreeNode[]>;
  // Cheap, optional, and asked AFTER the roots are on screen: is there anything behind this yet?
  // The component draws every declared root immediately, then asks this in the background of the
  // ones whose availability the source did not state, bounded on purpose: a few at a time,
  // abandoned when the tree is destroyed, never on the path that renders the tree.
  //
  // Resolving `undefined` means "I cannot tell", and a source must use it for every failure - a
  // refusal, a timeout, an unparseable response are no evidence that a store is empty. Only a
  // complete, valid listing holding neither objects nor prefixes may answer `empty`.
  // `context.signal` is aborted when the tree is destroyed or the answer is no longer wanted.
  probeAvailability?(
    node: DatasetTreeNode,
    context: DatasetTreeLoadContext,
  ): Promise<DatasetTreeAvailability | undefined>;
}

/**
 * What went wrong, in terms a reader can act on. A source throws one of these instead of a bare
 * `Error` when it knows more than "it failed". The component prints `message` verbatim inside the
 * failed branch, offers `Retry` only when `retryable` says the same request could plausibly succeed
 * next time, and shows nothing for `cancelled` - a listing the reader abandoned is not an error.
 * `detail` is diagnostics - the bucket and prefix being listed, an HTTP status - carried, never
 * rendered.
 */
export type DatasetTreeSourceErrorCode =
  | "access-denied"
  | "not-found"
  | "gone"
  | "timeout"
  | "network"
  | "rate-limited"
  | "server"
  | "invalid-response"
  | "cancelled"
  | "unknown";

export interface DatasetTreeSourceError extends Error {
  /**
   * The brand as well as the classification. Duck-typed rather than `instanceof`, because the
   * source and the component can end up in two bundles with two copies of the class, and an
   * `instanceof` that silently fails degrades every precise message to "unknown error".
   */
  readonly datasetTreeErrorCode: DatasetTreeSourceErrorCode;
  /** Whether repeating the SAME request could plausibly succeed. Decides the Retry control. */
  readonly retryable: boolean;
  /** Diagnostics for a developer. Never rendered. */
  readonly detail?: Readonly<Record<string, string | number | undefined>>;
}

/**
 * The footer status line: a tinted pill and a line of prose. Generic on purpose - only the consumer
 * that chose the source knows whether it is a build-time snapshot or a live bucket, so the consumer
 * says what to print and the component renders it.
 */
export interface DatasetTreeStatus {
  /** Chooses the pill's tint. `live` also gets the pulsing dot. */
  tone: "live" | "snapshot" | "neutral";
  /** Pill text, e.g. "LIVE", "SNAPSHOT". */
  label: string;
  // Prose beside the pill.
  detail?: string;
  // Rendered monospace after `detail`, e.g. an endpoint. Text only - never linkified.
  code?: string;
}

/**
 * Every string the component can print. `{name}`, `{error}`, `{count}` and `{query}` are
 * substituted where they appear; supplying a partial set replaces only those keys.
 */
export interface DatasetTreeLabels {
  /** The filter field's accessible name AND placeholder. Default: `Filter loaded items`. */
  filter: string;
  /** The always-visible caveat under the field. */
  filterHint: string;
  filterNoMatches: string;
  filterClear: string;
  collapseAll: string;
  /** The complete-source toolbar's opener. */
  expandAll: string;
  /** The complete-source toolbar's closer - shorter than `collapseAll`, beside `Expand all`. */
  collapseTree: string;
  reload: string;
  loadingRoots: string;
  loadingChildren: string;
  rootsEmpty: string;
  childrenEmpty: string;
  rootsError: string;
  childrenError: string;
  retry: string;
  expand: string;
  collapse: string;
  showDetails: string;
  hideDetails: string;
  /** The close control on the small card a branch's information control opens. */
  closeDetails: string;
  copyPath: string;
  copyExample: string;
  copied: string;
  copyFailed: string;
  inspect: string;
  openLink: string;
  accessHeading: string;
  /** The run control's visible text. */
  tryPython: string;
  /** Its accessible name, so a page full of identical buttons is still navigable. `{name}`. */
  tryPythonFor: string;
  fieldPath: string;
  fieldSize: string;
  fieldMediaType: string;
  fieldModified: string;
  fieldDescription: string;
  fieldAccess: string;
  plannedBadge: string;
  restrictedBadge: string;
  unavailableBadge: string;
  /** Shown for `availability: "empty"`. A statement of fact, not a warning. */
  emptyBadge: string;
  /** The footer's path readout, when nothing has been chosen yet. */
  selectionEmpty: string;
  /** The footer path's accessible name. */
  selectionLabel: string;
  /** The overflow control that puts a middle-collapsed path back in full. */
  pathShowAll: string;
  /** Live-region announcements. */
  announceRootsLoading: string;
  announceRootsLoaded: string;
  announceChildrenLoading: string;
  announceChildrenLoaded: string;
  announceChildrenEmpty: string;
  announceFailed: string;
  announceCollapsedAll: string;
  announceExpandedAll: string;
  announceFiltered: string;
  announceFilterCleared: string;

  // Search over an optional index: none of these appear unless a `searchIndex` was supplied to a
  // lazy source.
  /** Replaces `filter` as the field's name and placeholder once an index is searchable. */
  searchIndexed: string;
  /** Replaces `filterHint` when the index claims `complete: true`. */
  searchHintComplete: string;
  /** Replaces `filterHint` when the index claims `complete: false`. */
  searchHintPartial: string;
  /** Appended to the hint when the index states a generation time. `{generatedAt}`. */
  searchHintGenerated: string;
  /** The heading over the result list. `{count}`. */
  searchResults: string;
  /** Shown instead when the cap bit. `{shown}`, `{count}`. */
  searchResultsTruncated: string;
  /** The breadcrumb's accessible prefix, e.g. "in reanalysis / era5". `{path}`. */
  searchResultLocation: string;
  /** Live-region text after a search settles. `{count}`, `{query}`. */
  announceSearched: string;
}

/** Everything `mountDatasetTree` accepts. `source` is the only required member. */
export interface DatasetTreeOptions {
  source: DatasetTreeSource;

  // Called when the user presses the per-node inspect control, which exists only when this is
  // supplied, so a consumer with nothing to show never renders a dead button. It is also the escape
  // hatch for a modal: the package owns no viewport-level surface.
  onInspect?: (node: DatasetTreeNode, context: DatasetTreeLoadContext) => void | Promise<void>;

  // Called when the user activates a non-expandable node's primary action.
  onNavigate?: (node: DatasetTreeNode) => void;

  // Per-node code samples for the "How to access" disclosure.
  accessExamples?: (node: DatasetTreeNode) => readonly DatasetAccessExample[];

  // Turn on the "Try in Python" control beside eligible examples. Omitted means the control does
  // not exist - no button, no event, no code path. See `DatasetTreePython`.
  python?: DatasetTreePython;

  // Elements the consumer wants in the toolbar, before the component's own whole-tree controls. The
  // package knows nothing about them: they are appended as given, in order, into the same row as
  // `Collapse all`, and every event on them belongs to whoever created them. It is the door for a
  // host with ONE control that belongs to this panel (a maximize, a settings toggle) and no honest
  // place to put it. The elements are adopted, not cloned, so a consumer may keep a reference and
  // mutate it; they are removed from the toolbar when the component is destroyed, and what happens
  // to them afterwards is the consumer's business.
  toolbarExtras?: readonly HTMLElement[];

  // Ids expanded automatically as soon as they appear, at any depth.
  initialExpandedIds?: readonly string[];

  labels?: Partial<DatasetTreeLabels>;

  // The footer status line. Omitted means no footer.
  status?: DatasetTreeStatus;

  // Milliseconds between the last keystroke and re-filtering. Default 120. Filtering is local, so
  // this only exists to keep very large loaded trees from re-rendering on every character.
  filterDebounceMs?: number;

  // An optional pre-generated index, searched locally instead of the loaded nodes. Supplying one
  // changes what SEARCH covers and nothing else: browsing, expansion, loading and every request the
  // component makes are untouched, and omitting one leaves a lazy source searching what is loaded,
  // and saying so.
  //
  // Over a source that declares `complete: true` the index is IGNORED - that source has promised to
  // answer for the whole archive and has been walked into memory, so the loaded tree is at least as
  // complete as any index and is fresher - which is not an error, it simply adds nothing. The value
  // must already be parsed; this package never fetches it, see `parseDatasetTreeSearchIndexV1` in
  // `@freva-org/dataset-tree/search-index`.
  searchIndex?: DatasetTreeSearchIndex;

  // How many search results are drawn before the rest become a count. Default 200. A cap rather
  // than a scroll container because a one-character query over a large index matches most of it,
  // and one DOM row per match is a browser stall on a keystroke; what is above the cap is reported
  // as a number.
  searchResultLimit?: number;
}

/** What `mountDatasetTree` hands back. */
export interface DatasetTreeHandle {
  /**
   * Discard everything loaded and load the roots again, aborting pending requests first. Resolves
   * when the roots have settled, including as an error, which is reported in the UI not thrown.
   */
  reload(): Promise<void>;
  /**
   * Abort pending requests, drop listeners and timers, and remove the component's DOM from the
   * host. Safe to call twice. After this the handle's other methods do nothing.
   */
  destroy(): void;
}
