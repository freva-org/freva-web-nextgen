// tree.ts - the component. Three decisions shape this file.
// 1. The DOM is not the model. Expansion, load status, per-node errors and open panels live in one
//    `Map`; the view is a pure function of it. State on the elements cannot say what is loaded
//    once a filter hides half of them, nor restore focus across a re-render.
// 2. Nested lists, not an ARIA tree - the brief allows either and forbids a half-built one. Real
//    `<button>`s in real `<li>`s give Tab order, Enter/Space and accessible names from the
//    platform, and let a row carry its own controls: copy, inspect.
// 3. Only the body re-renders, so the toolbar's filter field keeps its caret and its focus.

import { button, el, icon } from "./dom.js";
import { formatBytes, formatTimestamp } from "./format.js";
import {
  CHECK,
  CHEVRON,
  CLOSE,
  COPY,
  CUBE,
  EXTERNAL,
  FILE,
  FOLDER,
  INFO,
  PLAY,
  SEARCH,
} from "./icons.js";
import { fill, resolveLabels } from "./labels.js";
import { registeredDigest, tryPythonEligible } from "./python.js";
import { displayableLiteral, safeHref } from "./url.js";
import {
  RANK,
  compareTieBreak,
  normalizeQuery,
  prepareSearchEntries,
  rankOf,
  searchableOfNode,
  type PreparedSearchEntry,
  type SearchRank,
  type SearchableText,
} from "./search/match.js";
import { errorCodeOf, isDatasetTreeError, isRetryable } from "./errors.js";
import type {
  DatasetAccessExample,
  DatasetTreeAvailability,
  DatasetTreeHandle,
  DatasetTreeLabels,
  DatasetTreeMetric,
  DatasetTreeNode,
  DatasetTreeOptions,
} from "./types.js";

/** Per-node view state. The node itself is stored beside it, never mutated. */
interface NodeState {
  node: DatasetTreeNode;
  parentId: string | null;
  depth: number;
  expanded: boolean;
  detailsOpen: boolean;
  /** Whether this branch's information card is open. At most one is, anywhere in the tree. */
  infoOpen: boolean;
  /** Index into the consumer's `accessExamples` result for this node. */
  exampleTab: number;
  accessOpen: boolean;
  load: "idle" | "loading" | "loaded" | "error";
  error: string | null;
  /** Whether the failure that produced `error` is one the same request could get past. */
  retryable: boolean;
  /** The source wrote the message itself, so it is printed rather than framed. */
  classified: boolean;
  /** A retry is in flight, so a second press is not a second attempt. */
  retrying: boolean;
  childIds: string[] | null;
  controller: AbortController | null;
}

type CopyState = "copied" | "failed";

/**
 * One row of the result list: a node the tree holds, or one synthesised from an index entry. The
 * synthesised kind declares `hasChildren: false` - a result is a destination, not a branch, and
 * expanding one would mean inventing a parent chain for it.
 */
interface SearchResult {
  readonly id: string;
  readonly node: DatasetTreeNode;
  /** True when the tree already holds this node, in which case its data is preferred. */
  readonly loaded: boolean;
  /** Root-first breadcrumb, from the index's ancestors or from the loaded parent chain. */
  readonly trail: string | null;
  readonly rank: SearchRank;
  readonly text: SearchableText;
}

/** Instance counter, so two trees on one page cannot mint the same DOM id. */
let instances = 0;

const DEFAULT_FILTER_DEBOUNCE_MS = 120;
/**
 * How many search results are drawn before the rest become a count. A one-character query matches
 * most of a large index, and one DOM row per match is a browser stall on a keystroke.
 */
const DEFAULT_SEARCH_RESULT_LIMIT = 200;
/** A detail field longer than this is truncated to a `+N` chip rather than filling the panel. */
const MAX_CHIPS = 12;
/** How many compact facts a row will carry before the rest are dropped. */
const MAX_ROW_METRICS = 4;
/**
 * How deep and wide a "complete" source is walked at mount: it is trusted to resolve locally, not
 * to be finite, and a cycle or a runaway generator would hang the page before it painted. Both
 * ceilings sit far above a landing-page catalogue.
 */
const MAX_MATERIALIZE_DEPTH = 32;
const MAX_MATERIALIZE_NODES = 20_000;

/** Whether a node can be opened at all. `hasChildren` wins; otherwise the kind decides. */
function expandable(node: DatasetTreeNode): boolean {
  // A PLANNED node opens nothing, whatever else it says - checked before `hasChildren` because the
  // two can disagree: `planned` is a promise about the future, and no request could return its
  // contents today. A source that also set `hasChildren: true` would give it a chevron that expands
  // to a listing error, including while a background probe is still running.
  if (node.availability === "planned") return false;
  if (typeof node.hasChildren === "boolean") return node.hasChildren;
  return node.kind === "collection" || node.kind === "directory";
}

/**
 * The text a row shows. A grouping takes the friendliest name, but a dataset or file is named by
 * what it is called in the archive, always: renaming `t2m_hourly.zarr` to `Near-surface air
 * temperature` makes the tree a picture of somebody's opinion, and a row no longer matches a path.
 * The friendly title is still searched and shown in the panel.
 */
function displayName(node: DatasetTreeNode): string {
  if (node.kind === "dataset" || node.kind === "file") return node.name;
  return node.title && node.title.length > 0 ? node.title : node.name;
}

/**
 * Mount a dataset tree into `host`: appends one element and returns a handle that takes it away.
 * Nothing is written to `document`, `window` or any global, so two calls are independent.
 */
export function mountDatasetTree(
  host: HTMLElement,
  options: DatasetTreeOptions,
): DatasetTreeHandle {
  if (!host || typeof host.appendChild !== "function") {
    throw new TypeError("mountDatasetTree: `host` must be an element");
  }
  if (!options || typeof options.source !== "object" || options.source === null) {
    throw new TypeError("mountDatasetTree: `options.source` is required");
  }

  const uid = `dtree-${++instances}`;
  const labels: DatasetTreeLabels = resolveLabels(options.labels);
  const source = options.source;
  /**
   * Whether the source can answer for the whole archive without another request. It decides three
   * things: `Expand all` is offered, meaningless over a store that lists on demand; the filter is
   * total rather than partial; and the caveat stays off the page. The source's claim, not a guess.
   */
  const complete = source.complete === true;

  /**
   * The optional search index, and the rule deciding its use: a `complete: true` source ignores it,
   * silently. Such a source is walked into memory at mount, so the loaded tree is no less complete,
   * and fresher; refusing to mount would punish a consumer who passes one options object to both.
   */
  const searchIndex = !complete && options.searchIndex ? options.searchIndex : null;
  /** Normalised ONCE, here, not on every keystroke. See `search/match.ts`. */
  const indexEntries: readonly PreparedSearchEntry[] | null = searchIndex
    ? prepareSearchEntries(searchIndex.entries)
    : null;
  const searchable = indexEntries !== null;
  const resultLimit = Math.max(
    1,
    Math.trunc(options.searchResultLimit ?? DEFAULT_SEARCH_RESULT_LIMIT),
  );

  const autoExpand = new Set(options.initialExpandedIds ?? []);
  const autoExpanded = new Set<string>();
  const debounceMs = Math.max(0, options.filterDebounceMs ?? DEFAULT_FILTER_DEBOUNCE_MS);

  // state
  const nodes = new Map<string, NodeState>();
  const copyFeedback = new Map<string, CopyState>();
  const domIds = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const inspectControllers = new Set<AbortController>();

  let rootIds: string[] | null = null;
  let rootLoad: NodeState["load"] = "idle";
  let rootError: string | null = null;
  let rootController: AbortController | null = null;
  let filterQuery = "";
  let filterTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The result list and the states behind it, kept apart from `nodes`. A result may name an object
   * in an unopened branch; writing it into `nodes` would claim its ancestors had been listed,
   * corrupt the expansion state the reader returns to, and make clearing the query a restoration.
   */
  let searchResults: SearchResult[] | null = null;
  let searchTotal = 0;
  const resultStates = new Map<string, NodeState>();
  let pendingFocus: string | null = null;
  let destroyed = false;
  /**
   * The node the visitor last chose: its row is highlighted and the footer spells out the path to
   * it as clickable segments. Declared at mount scope because the footer is built during mount and
   * reads it - a `let` further down is in its temporal dead zone there, which surfaced as `Cannot
   * access 'J' before initialization` in the bundle. Not per-node state: selection survives a
   * filter, a collapse and a reload, and clears only when the id stops existing.
   */
  let selectedId: string | null = null;
  /**
   * Whether the reader asked for the whole path, overriding the fitter until they move. Reset by
   * each selection change: it answers what was hidden here, and a new path is a new question.
   */
  let pathExpanded = false;
  /** Re-fits the footer path when the panel's width changes. Disconnected on destroy. */
  let pathFit: ResizeObserver | null = null;
  /** Bumped by reload and destroy; a resolved request from an older generation is discarded. */
  let generation = 0;

  const later = (fn: () => void, ms: number): void => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!destroyed) fn();
    }, ms);
    timers.add(id);
  };

  const domId = (nodeId: string, suffix: string): string => {
    let n = domIds.get(nodeId);
    if (n === undefined) {
      n = domIds.size + 1;
      domIds.set(nodeId, n);
    }
    return `${uid}-${suffix}-${n}`;
  };

  // shell
  const root = el("div", { class: "dataset-tree", attrs: { "data-dataset-tree": "" } });

  // The field is named for what it does: with an index a search over an archive, without one a
  // filter over what is in memory. Calling both "search" implies a reach it does not have.
  const fieldLabel = searchable ? labels.searchIndexed : labels.filter;
  const filterInput = el("input", {
    class: "dataset-tree__filter-input",
    attrs: {
      type: "search",
      placeholder: fieldLabel,
      "aria-label": fieldLabel,
      // A description pointing at an off-page caveat untrue of this source is worse than none. With
      // an index the same element carries a different statement, still worth pointing at.
      ...(complete ? {} : { "aria-describedby": `${uid}-hint` }),
      autocomplete: "off",
      spellcheck: "false",
    },
  });

  // The toolbar, in the order a reader scans it: magnifier, the field, the host's controls via
  // `toolbarExtras`, and then the one whole-tree control. Collapse is last in the row, because it
  // undoes a session of opening branches, where a reader looks for it; over a complete snapshot
  // `Expand all` precedes it, cheap over a walked catalogue but a recursive request per branch over
  // a lazy source. Neither carries `Reload`: reopening a row re-reads that branch in one request,
  // while a whole-tree reload discards everything opened.
  const bar = el("div", {
    class: "dataset-tree__bar",
    children: [
      el("div", {
        class: "dataset-tree__filter",
        children: [icon(SEARCH, "dataset-tree__filter-icon"), filterInput],
      }),
      ...(options.toolbarExtras ?? []),
      ...(complete
        ? [
            button({
              class: "dataset-tree__btn",
              text: labels.expandAll,
              action: "expand-all",
              key: "expand-all",
            }),
            button({
              class: "dataset-tree__btn",
              text: labels.collapseTree,
              action: "collapse-all",
              key: "collapse-all",
            }),
          ]
        : [
            button({
              class: "dataset-tree__btn",
              text: labels.collapseAll,
              action: "collapse-all",
              key: "collapse-all",
            }),
          ]),
    ],
  });

  // The filter's caveat is always on the input's `aria-describedby`, and visible only while there
  // is something in the box to be about.
  /**
   * What the caveat says, which the index decides. Without an index: only what is loaded is
   * searched. With a `complete: true` index: the whole indexed archive. With a `complete: false`
   * one: it may not cover everything, a weaker claim that must not read like a stronger one.
   * Freshness is appended when the index states it.
   */
  function hintText(): string {
    if (!searchIndex) return labels.filterHint;
    const base = searchIndex.complete ? labels.searchHintComplete : labels.searchHintPartial;
    const generatedAt = formatTimestamp(searchIndex.generatedAt);
    if (!generatedAt) return base;
    return `${base} ${fill(labels.searchHintGenerated, { generatedAt })}`;
  }

  const hint = el("p", {
    class: "dataset-tree__hint",
    text: hintText(),
    attrs: { id: `${uid}-hint`, hidden: true },
  });

  const body = el("div", { class: "dataset-tree__body" });

  /**
   * One polite live region for the whole component: per-node `role="alert"` nodes are right alone
   * and unbearable together, since four branches queue four interruptions.
   */
  const live = el("div", {
    class: "dataset-tree__sr",
    attrs: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
  });

  // Over a complete snapshot the caveat is simply false, so it is not in the document at all.
  if (complete) root.append(bar, body, live);
  else root.append(bar, hint, body, live);
  // The footer is not conditional on `status`: it carries the selected path, which every mount has
  // whether or not the consumer supplied a status line.
  let foot = renderFoot();
  root.appendChild(foot);
  host.appendChild(root);
  // Fitted once the panel is in the document - a nav that is not laid out has a `clientWidth` of
  // zero, so every path overflows it - and again on every width change. `ResizeObserver`, not a
  // window `resize` listener: a host can change the container's width without the window moving.
  fitPath();
  if (typeof ResizeObserver === "function") {
    pathFit = new ResizeObserver(() => fitPath());
    pathFit.observe(root);
  }

  /** Swap the footer in place, so a selection change does not re-render the tree. */
  function refreshFoot(): void {
    const next = renderFoot();
    foot.replaceWith(next);
    foot = next;
    fitPath();
  }

  /**
   * The footer: where you are, and what this catalogue is. The path comes first because it changes
   * as you browse, while the status pill is fixed. Segments are buttons, not links - they move the
   * selection inside this widget - and the last is the chosen node, still pressable.
   */
  function renderPath(): HTMLElement {
    const trail = selectionTrail();
    if (trail.length === 0) {
      return el("p", {
        class: "dataset-tree__path dataset-tree__path--empty",
        text: labels.selectionEmpty,
      });
    }
    const children: Node[] = [];
    trail.forEach((step, index) => {
      if (index > 0) {
        children.push(
          el("span", {
            class: "dataset-tree__path-sep",
            attrs: { "aria-hidden": "true" },
            text: "/",
          }),
        );
      }
      children.push(
        button({
          class: "dataset-tree__path-step",
          action: "path",
          children: [el("span", { text: step.label })],
          attrs: {
            "data-dt-id": step.id,
            "data-dt-step": String(index),
            "aria-current": index === trail.length - 1 ? "true" : null,
          },
        }),
      );
      // The overflow control goes after the first segment and before its separator, which is what
      // makes the collapsed row read as a path: `fitPath` hides segments from the root end and the
      // separator before each one, leaving `CMIP6` `…` `/` `P1M` `/` `level_0.zarr`. At the end of
      // the row it would instead read as an omission at the deep end. It is in the document at
      // every width, shown only when the path does not fit, and pressing it puts the path back.
      if (index === 0) {
        children.push(
          button({
            class: "dataset-tree__path-more",
            action: "path-more",
            key: "path-more",
            text: "\u2026",
            attrs: {
              hidden: true,
              "aria-label": labels.pathShowAll,
              title: labels.pathShowAll,
            },
          }),
        );
      }
    });
    return el("nav", {
      class: `dataset-tree__path${pathExpanded ? " is-expanded" : ""}`,
      attrs: { "aria-label": labels.selectionLabel },
      children,
    });
  }

  /**
   * Make a deep path fit the footer by taking segments out of its middle, rather than letting it
   * scroll sideways and clip the deep end the reader just chose. The first and deepest segments are
   * kept and the middle collapses into `…`, one segment at a time from just after the first, so
   * exactly as much goes as the width requires. `scrollWidth > clientWidth` asks the engine, so the
   * fit holds at any font size, zoom or host width, and a `ResizeObserver` re-asks on every width
   * change. Hidden segments are `hidden`, so they leave the accessibility tree with the pixels.
   */
  function fitPath(): void {
    if (destroyed) return;
    const nav = foot.querySelector<HTMLElement>(".dataset-tree__path");
    if (!nav || typeof nav.querySelectorAll !== "function") return;
    const more = nav.querySelector<HTMLElement>(".dataset-tree__path-more");
    const steps = Array.from(nav.querySelectorAll<HTMLElement>(".dataset-tree__path-step"));
    const seps = Array.from(nav.querySelectorAll<HTMLElement>(".dataset-tree__path-sep"));
    if (!more || steps.length === 0) return;

    // Start from everything shown, so a widened panel gives segments back.
    for (const step of steps) step.hidden = false;
    for (const sep of seps) sep.hidden = false;
    more.hidden = true;
    if (pathExpanded) return;

    const overflows = (): boolean => nav.scrollWidth > nav.clientWidth + 1;
    if (!overflows()) return;

    // `…` replaces the first separator, so the row reads `root … / branch / leaf`. It is shown
    // before anything is hidden: it takes room of its own, so the fit would fail by its own width.
    more.hidden = false;
    // The first segment stays; so does the last. Everything between them is collapsible, nearest
    // the root first, because that is the end a reader reconstructs most easily from context.
    for (let index = 1; index < steps.length - 1 && overflows(); index += 1) {
      steps[index].hidden = true;
      const sep = seps[index - 1];
      if (sep) sep.hidden = true;
    }
    // A leaf whose own name is wider than the footer: the first segment goes too, and `…` stands
    // for everything above it. Keeping the leaf and admitting the rest is missing is the honest
    // trade at a width where something has to give; a sideways scroll would clip what was chosen.
    if (overflows() && steps.length > 1) steps[0].hidden = true;
  }

  function renderStatus(): HTMLElement {
    const status = options.status;
    const children: Node[] = [];
    if (status) {
      children.push(
        el("span", {
          class: `dataset-tree__mode dataset-tree__mode--${status.tone}`,
          children: [
            el("span", { class: "dataset-tree__dot" }),
            el("span", { text: status.label }),
          ],
        }),
      );
      if (status.detail) {
        children.push(el("span", { class: "dataset-tree__foot-detail", text: status.detail }));
      }
      if (status.code) {
        children.push(el("code", { class: "dataset-tree__foot-code", text: status.code }));
      }
    }
    return el("div", { class: "dataset-tree__foot-status", children });
  }

  /** The whole footer, rebuilt whenever the selection moves. */
  function renderFoot(): HTMLElement {
    const children: Node[] = [renderPath()];
    if (options.status) children.push(renderStatus());
    return el("div", { class: "dataset-tree__foot", children });
  }

  function announce(message: string): void {
    live.textContent = message;
  }

  // selection
  /** The chosen node and its ancestors, root-first. Empty when nothing is chosen. */
  function selectionTrail(): Array<{ id: string; label: string }> {
    if (selectedId === null) return [];
    const trail: Array<{ id: string; label: string }> = [];
    let cursor: string | null = selectedId;
    let guard = 0;
    while (cursor !== null && guard < MAX_MATERIALIZE_DEPTH) {
      const state = nodes.get(cursor);
      if (!state) break;
      trail.push({ id: cursor, label: displayName(state.node) });
      cursor = state.parentId;
      guard += 1;
    }
    return trail.reverse();
  }

  /**
   * Choose a node. Returns whether anything changed, so a caller can skip a re-render. Selecting an
   * ancestor also opens the path to it: a segment that scrolled the tree to a collapsed branch
   * would be a link to something you cannot see.
   */
  function select(id: string): boolean {
    if (!nodes.has(id)) return false;
    if (selectedId === id) return false;
    selectedId = id;
    pathExpanded = false;
    return true;
  }

  /** Scroll a row into view without yanking the page around it. */
  function revealRow(id: string): void {
    const row = body.querySelector<HTMLElement>(`[data-dt-row="${cssEscape(id)}"]`);
    row?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // loading
  /**
   * What a reader is told about a failure. A classified failure's `message` is written for them and
   * printed as-is; anything else falls back to the exception text, which is why the classification
   * exists. `detail` is not consulted: a bucket and prefix are for whoever debugs the deployment.
   */
  function errorText(reason: unknown): string {
    if (isDatasetTreeError(reason)) return reason.message;
    if (reason instanceof Error && reason.message) return reason.message;
    if (typeof reason === "string" && reason.length > 0) return reason;
    return "unknown error";
  }

  /**
   * Whether a failure is one the reader could plausibly get past by asking again. A refusal and a
   * missing bucket are not - the same request will be refused again, and a `Retry` beside them
   * promises what it cannot deliver. A timeout, a network error and a 5xx are.
   */
  function retryableFailure(reason: unknown): boolean {
    return errorCodeOf(reason) !== "cancelled" && isRetryable(reason);
  }

  function ingest(
    list: readonly DatasetTreeNode[],
    parentId: string | null,
    depth: number,
  ): string[] {
    const ids: string[] = [];
    for (const node of list) {
      if (!node || typeof node.id !== "string" || node.id.length === 0) continue;
      // A source that repeats an id within one response would otherwise overwrite its own sibling;
      // the first occurrence wins and the duplicate is dropped rather than corrupting the parent.
      if (ids.includes(node.id)) continue;
      nodes.set(node.id, {
        node,
        parentId,
        depth,
        expanded: false,
        detailsOpen: false,
        infoOpen: false,
        exampleTab: 0,
        accessOpen: false,
        load: "idle",
        error: null,
        retryable: true,
        retrying: false,
        classified: false,
        childIds: null,
        controller: null,
      });
      ids.push(node.id);
    }
    return ids;
  }

  /** Expand any freshly-arrived node the consumer asked to be open, once each. */
  function applyAutoExpand(ids: readonly string[]): void {
    if (autoExpand.size === 0) return;
    for (const id of ids) {
      if (!autoExpand.has(id) || autoExpanded.has(id)) continue;
      const state = nodes.get(id);
      if (!state || !expandable(state.node)) continue;
      autoExpanded.add(id);
      state.expanded = true;
      // A complete source has been walked already; asking again is a second traversal, same answer.
      if (!complete) void loadChildren(id);
    }
  }

  /**
   * Walk a complete source's whole archive into memory once, undrawn, because `Expand all` opens
   * every branch and a filter searches every name, and doing it lazily would make the first
   * keystroke the slowest. Deliberately not `loadChildren`, which announces, re-renders and spins
   * per node; nothing here is drawn and the caller renders once. A source that fails mid-walk
   * leaves that branch `idle`, so false completeness degrades into laziness.
   */
  async function materializeAll(controller: AbortController, mine: number): Promise<void> {
    let frontier = [...nodes.keys()];
    let depth = 0;
    let seen = nodes.size;
    while (frontier.length > 0 && depth < MAX_MATERIALIZE_DEPTH && seen < MAX_MATERIALIZE_NODES) {
      const next: string[] = [];
      for (const id of frontier) {
        if (destroyed || mine !== generation || controller.signal.aborted) return;
        const state = nodes.get(id);
        if (!state || state.load !== "idle" || !expandable(state.node)) continue;
        let list: readonly DatasetTreeNode[];
        try {
          list = (await source.loadChildren(state.node, { signal: controller.signal })) ?? [];
        } catch {
          continue;
        }
        if (destroyed || mine !== generation || controller.signal.aborted) return;
        const current = nodes.get(id);
        if (!current) continue;
        current.childIds = ingest(list, id, current.depth + 1);
        current.load = "loaded";
        seen += current.childIds.length;
        next.push(...current.childIds);
      }
      frontier = next;
      depth += 1;
    }
  }

  function loadRoots(): Promise<void> {
    rootController?.abort();
    const controller = new AbortController();
    rootController = controller;
    const mine = generation;
    rootLoad = "loading";
    rootError = null;
    announce(labels.announceRootsLoading);
    render();

    return Promise.resolve()
      .then(() => source.loadRoots({ signal: controller.signal }))
      .then(
        (list) => {
          if (destroyed || mine !== generation || controller.signal.aborted) return;
          rootIds = ingest(list ?? [], null, 0);
          rootLoad = "loaded";
          rootError = null;
          announce(fill(labels.announceRootsLoaded, { count: rootIds.length }));
          if (!complete) {
            render();
            applyAutoExpand(rootIds);
            void probeRoots(controller, mine);
            return;
          }
          render();
          void materializeAll(controller, mine).then(() => {
            if (destroyed || mine !== generation || controller.signal.aborted) return;
            applyAutoExpand([...nodes.keys()]);
            render();
          });
        },
        (reason: unknown) => {
          if (destroyed || mine !== generation || controller.signal.aborted) return;
          rootLoad = "error";
          rootError = errorText(reason);
          announce(fill(labels.announceFailed, { name: labels.loadingRoots, error: rootError }));
          render();
        },
      );
  }

  /**
   * How many availability probes may be in flight at once. Four rather than all of them: eleven
   * roots would open eleven connections in the first frame, against a gateway about to be asked for
   * a real listing and over a connection budget the page shares with its own assets.
   */
  const PROBE_CONCURRENCY = 4;

  /**
   * Ask the source, in the background, which declared roots have anything behind them yet. Every
   * root is already on screen when this starts and a probe changes a badge and nothing else: a
   * first paint that waited on round-trips would look broken, over a footnote. Skipped for any node
   * the source already classified, and a `planned` root is never probed - its bucket may not exist
   * yet. The run is tied to the root generation's controller, so a destroy, a `reload()` or a
   * second `loadRoots` abandons it and a late probe is dropped.
   */
  async function probeRoots(controller: AbortController, mine: number): Promise<void> {
    if (!source.probeAvailability) return;
    const probe = source.probeAvailability.bind(source);
    const queue = (rootIds ?? []).filter((id) => {
      const state = nodes.get(id);
      return Boolean(state) && state!.node.availability === undefined;
    });
    if (queue.length === 0) return;

    let next = 0;
    let changed = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (destroyed || mine !== generation || controller.signal.aborted) return;
        const index = next;
        next += 1;
        const id = queue[index];
        if (id === undefined) return;
        const state = nodes.get(id);
        if (!state) continue;
        let answer: DatasetTreeAvailability | undefined;
        try {
          answer = await probe(state.node, { signal: controller.signal });
        } catch {
          // A thrown probe is "cannot tell", exactly like a resolved `undefined`. Swallowed here
          // and nowhere else: this is the one request the reader did not ask for, so its failure
          // reaches neither a badge, nor the branch, nor the live region.
          answer = undefined;
        }
        if (destroyed || mine !== generation || controller.signal.aborted) return;
        if (answer === undefined) continue;
        const current = nodes.get(id);
        // Re-read: the node may have been replaced by a reload while this request was in flight.
        if (!current || current.node.availability !== undefined) continue;
        current.node = { ...current.node, availability: answer };
        changed = true;
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, () => worker()),
    );
    if (destroyed || mine !== generation || controller.signal.aborted) return;
    if (changed) render();
  }

  function loadChildren(id: string): Promise<void> {
    const state = nodes.get(id);
    if (!state) return Promise.resolve();
    if (state.load === "loaded" || state.load === "loading") return Promise.resolve();

    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const mine = generation;
    state.load = "loading";
    state.error = null;
    announce(fill(labels.announceChildrenLoading, { name: displayName(state.node) }));
    render();

    return Promise.resolve()
      .then(() => source.loadChildren(state.node, { signal: controller.signal }))
      .then(
        (list) => {
          if (destroyed || mine !== generation || controller.signal.aborted) return;
          // The node may have been dropped by a reload that raced this response.
          const current = nodes.get(id);
          if (!current || current.controller !== controller) return;
          current.childIds = ingest(list ?? [], id, current.depth + 1);
          current.load = "loaded";
          current.controller = null;
          const count = current.childIds.length;
          announce(
            count === 0
              ? fill(labels.announceChildrenEmpty, { name: displayName(current.node) })
              : fill(labels.announceChildrenLoaded, {
                  count,
                  name: displayName(current.node),
                }),
          );
          render();
          applyAutoExpand(current.childIds);
        },
        (reason: unknown) => {
          if (destroyed || mine !== generation || controller.signal.aborted) return;
          const current = nodes.get(id);
          if (!current || current.controller !== controller) return;
          // Deliberately not marked loaded: a failed branch must stay retryable, and "loaded but
          // empty" is how a transient 503 becomes a permanently empty directory.
          current.controller = null;
          current.retrying = false;
          // A listing the reader abandoned is not a failure: collapsing a branch aborts its
          // request, and the rejection arrives here exactly like a 500 would. The branch goes back
          // to idle, so reopening it starts a fresh request rather than showing a stale error.
          if (errorCodeOf(reason) === "cancelled") {
            current.load = "idle";
            current.error = null;
            render();
            return;
          }
          // Deliberately not marked loaded: a failed branch must stay retryable, and "loaded but
          // empty" is how a transient 503 becomes a permanently empty directory.
          current.load = "error";
          current.error = errorText(reason);
          current.retryable = retryableFailure(reason);
          current.classified = isDatasetTreeError(reason);
          announce(
            fill(labels.announceFailed, {
              name: displayName(current.node),
              error: current.error,
            }),
          );
          render();
        },
      );
  }

  function abortSubtree(id: string): void {
    const state = nodes.get(id);
    if (!state) return;
    state.controller?.abort();
    state.controller = null;
    if (state.load === "loading") state.load = "idle";
    for (const childId of state.childIds ?? []) abortSubtree(childId);
  }

  // filtering
  function computeVisible(): { visible: Set<string>; matched: Set<string> } | null {
    if (filterQuery.length === 0) return null;
    const matched = new Set<string>();
    for (const [id, state] of nodes) {
      // Name, title and path. The path is the one people actually paste in - somebody looking for
      // `reanalysis/t2m` is looking at a location, not at a display name - and leaving it out made
      // the field's own placeholder ("datasets and paths") a lie.
      const haystack =
        `${state.node.name}\n${state.node.title ?? ""}\n${state.node.path ?? ""}`.toLowerCase();
      if (haystack.includes(filterQuery)) matched.add(id);
    }
    const visible = new Set<string>(matched);
    for (const id of matched) {
      let parent = nodes.get(id)?.parentId ?? null;
      while (parent !== null && !visible.has(parent)) {
        visible.add(parent);
        parent = nodes.get(parent)?.parentId ?? null;
      }
    }
    return { visible, matched };
  }

  // search
  /**
   * The state behind a result row. A loaded node's state is reused, so a panel opened from a result
   * is still open after the query is cleared, and no node has two disagreeing states. An index-only
   * result keeps its state between searches.
   */
  function resultState(result: SearchResult): NodeState {
    const existing = nodes.get(result.id);
    if (existing) return existing;
    let state = resultStates.get(result.id);
    if (state === undefined) {
      state = {
        node: result.node,
        parentId: null,
        depth: 0,
        expanded: false,
        detailsOpen: false,
        infoOpen: false,
        exampleTab: 0,
        accessOpen: false,
        load: "idle",
        error: null,
        retryable: true,
        retrying: false,
        classified: false,
        childIds: null,
        controller: null,
      };
      resultStates.set(result.id, state);
    } else {
      // The index can be replaced by a remount, and a stale node object would render stale text.
      state.node = result.node;
    }
    return state;
  }

  /** The breadcrumb for a loaded node: its ancestors, root-first, as they are actually held. */
  function loadedTrail(id: string): string | null {
    const parts: string[] = [];
    let parent = nodes.get(id)?.parentId ?? null;
    let guard = 0;
    while (parent !== null && guard < MAX_MATERIALIZE_DEPTH) {
      const state = nodes.get(parent);
      if (!state) break;
      parts.push(displayName(state.node));
      parent = state.parentId;
      guard += 1;
    }
    if (parts.length === 0) return null;
    return displayableLiteral(parts.reverse().join(" / "));
  }

  /** The breadcrumb for an index entry: its declared ancestors, root-first, as text. */
  function indexTrail(entry: PreparedSearchEntry["entry"]): string | null {
    const ancestors = entry.ancestors;
    if (!ancestors || ancestors.length === 0) return null;
    const parts: string[] = [];
    for (const ancestor of ancestors) {
      const text =
        typeof ancestor.title === "string" && ancestor.title.length > 0
          ? ancestor.title
          : ancestor.name;
      if (typeof text === "string" && text.length > 0) parts.push(text);
    }
    if (parts.length === 0) return null;
    return displayableLiteral(parts.join(" / "));
  }

  /**
   * A node made from an index entry: only the fields the index carries, plus `hasChildren: false`.
   * Nothing is invented - an entry with no size renders no size - because a row showing a plausible
   * fact the index did not state is worse than one showing less.
   */
  function nodeFromEntry(entry: PreparedSearchEntry["entry"]): DatasetTreeNode {
    const node: Record<string, unknown> = {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      hasChildren: false,
    };
    if (entry.title !== undefined) node.title = entry.title;
    if (entry.path !== undefined) node.path = entry.path;
    if (entry.size !== undefined) node.size = entry.size;
    if (entry.modifiedAt !== undefined) node.modifiedAt = entry.modifiedAt;
    return node as unknown as DatasetTreeNode;
  }

  /**
   * Search the index and the loaded tree, and merge. No source call happens here: both are in
   * memory, so a search is a scan of two arrays - walking S3 because somebody typed a letter is
   * what this avoids. The tree is searched too: an index is a build artefact and the tree is live,
   * so a branch listed after it must still be findable; where both have an id the loaded node wins.
   */
  function computeSearch(): SearchResult[] {
    const byId = new Map<string, SearchResult>();

    if (indexEntries) {
      for (const prepared of indexEntries) {
        const rank = rankOf(prepared.text, filterQuery);
        if (rank === RANK.none) continue;
        byId.set(prepared.entry.id, {
          id: prepared.entry.id,
          node: nodeFromEntry(prepared.entry),
          loaded: false,
          trail: indexTrail(prepared.entry),
          rank,
          text: prepared.text,
        });
      }
    }

    for (const [id, state] of nodes) {
      const text = searchableOfNode(state.node);
      const rank = rankOf(text, filterQuery);
      if (rank === RANK.none) continue;
      const indexed = byId.get(id);
      byId.set(id, {
        id,
        node: state.node,
        loaded: true,
        // The loaded chain when there is one; otherwise whatever context the index supplied, which
        // for a root-level node is nothing either way.
        trail: loadedTrail(id) ?? indexed?.trail ?? null,
        // The better of the two ranks: the same thing found twice is not found less well.
        rank: indexed !== undefined && indexed.rank < rank ? indexed.rank : rank,
        text,
      });
    }

    const results = [...byId.values()];
    results.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : compareTieBreak(a, b)));
    return results;
  }

  function applyFilter(next: string): void {
    const normalized = normalizeQuery(next);
    if (normalized === filterQuery) return;
    filterQuery = normalized;
    hint.hidden = complete || filterQuery.length === 0;

    // The results are computed here, once per settled query, and not inside `render()`, which runs
    // for every state change the component makes - a details toggle, a copy feedback timer, a
    // branch finishing loading. The query is the only thing that changes the answer.
    if (searchable && filterQuery.length > 0) {
      const all = computeSearch();
      searchTotal = all.length;
      searchResults = all.slice(0, resultLimit);
    } else {
      searchResults = null;
      searchTotal = 0;
    }

    render();
    if (filterQuery.length === 0) {
      announce(labels.announceFilterCleared);
      return;
    }
    if (searchResults) {
      announce(fill(labels.announceSearched, { count: searchTotal, query: filterQuery }));
      return;
    }
    const view = computeVisible();
    announce(
      fill(labels.announceFiltered, {
        count: view ? view.matched.size : 0,
        query: filterQuery,
      }),
    );
  }

  // rendering
  /**
   * Duck-typed rather than `instanceof HTMLElement`, which compares against this realm's
   * constructor: an element handed over from an iframe is a good element that fails that check.
   */
  function focusKeyOf(node: unknown): string | null {
    const candidate = node as { closest?: (selector: string) => unknown } | null;
    if (!candidate || typeof candidate.closest !== "function") return null;
    const owner = candidate.closest("[data-dt-key]") as { dataset?: DOMStringMap } | null;
    return owner?.dataset?.dtKey ?? null;
  }

  /**
   * Draw, without moving what the reader is looking at. Opening a branch otherwise jumps twice:
   * `replaceChildren` empties the scroller for an instant and the platform clamps a scroll offset
   * the content is briefly too short for, never undoing it; and `focus()` scrolls the pressed row
   * into view from that clamped offset. So the offset is saved and put back around the swap, focus
   * is restored with `preventScroll`, and the pressed row is pinned by its viewport-top distance,
   * covering a render that changes a height above it.
   */
  function render(): void {
    if (destroyed) return;
    const active = root.contains(root.ownerDocument.activeElement)
      ? root.ownerDocument.activeElement
      : null;
    const restore = pendingFocus ?? focusKeyOf(active);
    pendingFocus = null;

    const scrollTop = body.scrollTop;
    const scrollLeft = body.scrollLeft;
    const anchorBefore = restore ? anchorTop(restore) : null;

    body.replaceChildren(...renderBody());
    body.setAttribute("aria-busy", rootLoad === "loading" ? "true" : "false");
    // The footer follows the tree: a render can drop the chosen node (a reload, a source change),
    // and a path pointing at something no longer here is worse than no path.
    if (selectedId !== null && !nodes.has(selectedId)) selectedId = null;
    refreshFoot();

    body.scrollTop = scrollTop;
    body.scrollLeft = scrollLeft;

    if (restore) {
      if (anchorBefore !== null) {
        const anchorAfter = anchorTop(restore);
        if (anchorAfter !== null && anchorAfter !== anchorBefore) {
          body.scrollTop = scrollTop + (anchorAfter - anchorBefore);
        }
      }
      const target = body.querySelector<HTMLElement>(`[data-dt-key="${cssEscape(restore)}"]`);
      // An engine that ignores `preventScroll` scrolls - the bug this line prevents, not a crash.
      if (target) target.focus({ preventScroll: true });
    }
    placeInfoCard();
    watchDismiss();
  }

  /**
   * While a card is open, a press outside it or an Escape closes it. Listened for on the document,
   * because "outside" is everything this component does not own, and in the capture phase so a
   * press some other widget stops still dismisses. Both listeners exist only while a card does.
   */
  let dismissing = false;
  function watchDismiss(): void {
    const wanted = [...nodes.values()].some((state) => state.infoOpen);
    if (wanted === dismissing) return;
    const doc = root.ownerDocument;
    dismissing = wanted;
    if (wanted) {
      doc.addEventListener("pointerdown", onOutside, true);
      doc.addEventListener("keydown", onDismissKey, true);
      return;
    }
    doc.removeEventListener("pointerdown", onOutside, true);
    doc.removeEventListener("keydown", onDismissKey, true);
  }

  function onOutside(event: Event): void {
    const target = event.target as { closest?: (selector: string) => unknown } | null;
    if (typeof target?.closest !== "function") return;
    // The control is not "outside": its own handler toggles, so closing here too would reopen it.
    if (target.closest(".dataset-tree__infocard") || target.closest(".dataset-tree__info-btn")) {
      return;
    }
    if (closeInfoCards()) render();
  }

  function onDismissKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    const open = [...nodes.entries()].find(([, state]) => state.infoOpen);
    if (!open) return;
    event.stopPropagation();
    closeInfoCards();
    pendingFocus = `info:${open[0]}`;
    render();
  }

  /**
   * Where a control currently sits, in viewport coordinates, or `null` if it is not on the page.
   * Viewport rather than document coordinates: the scroller that moved may be this component's own
   * body or the window, and two viewport positions differ by the same number either way.
   */
  function anchorTop(key: string): number | null {
    const element = body.querySelector<HTMLElement>(`[data-dt-key="${cssEscape(key)}"]`);
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    return element.getBoundingClientRect().top;
  }

  /** Minimal attribute-selector escaping; keys are ours, but node ids inside them are not. */
  function cssEscape(value: string): string {
    return value.replace(/["\\]/g, "\\$&");
  }

  function renderBody(): Node[] {
    if (rootLoad === "loading" && rootIds === null) {
      return [message("loading", labels.loadingRoots, true)];
    }
    if (rootLoad === "error") {
      return [
        message("error", fill(labels.rootsError, { error: rootError ?? "" }), false, [
          button({
            class: "dataset-tree__btn",
            text: labels.retry,
            action: "retry-roots",
            key: "retry-roots",
          }),
        ]),
      ];
    }
    if (!rootIds || rootIds.length === 0) {
      return [message("empty", labels.rootsEmpty, false)];
    }

    // A search over an index replaces the tree for as long as there is a query, and touches
    // nothing behind it - which is why clearing the field is a re-render and not a restoration.
    if (searchResults) return renderResults(searchResults);

    const view = computeVisible();
    const shown = view ? rootIds.filter((id) => view.visible.has(id)) : rootIds;
    if (shown.length === 0) {
      return [message("empty", fill(labels.filterNoMatches, { query: filterQuery }), false)];
    }

    const list = el("ul", { class: "dataset-tree__list" });
    for (const id of shown) list.appendChild(renderNode(id, view));
    return [list];
  }

  /**
   * The result list: a count, then one row per result, then nothing else. Rows are drawn with the
   * tree's own row renderer, so a result gets the icon, highlighted match, controls and detail
   * panel the identical node gets in the tree - the same renderer, not a second kept in step.
   */
  function renderResults(results: readonly SearchResult[]): Node[] {
    if (results.length === 0) {
      return [message("empty", fill(labels.filterNoMatches, { query: filterQuery }), false)];
    }

    // Every result is a match, so every name is highlighted, reusing the tree's `view`.
    const view = {
      visible: new Set(results.map((r) => r.id)),
      matched: new Set(results.map((r) => r.id)),
    };

    const header = el("p", {
      class: "dataset-tree__results",
      text:
        searchTotal > results.length
          ? fill(labels.searchResultsTruncated, {
              shown: results.length,
              count: searchTotal,
            })
          : fill(labels.searchResults, { count: searchTotal }),
    });

    const list = el("ul", { class: "dataset-tree__list dataset-tree__list--results" });
    for (const result of results) list.appendChild(renderResult(result, view));
    return [header, list];
  }

  function renderResult(
    result: SearchResult,
    view: { visible: Set<string>; matched: Set<string> },
  ): HTMLElement {
    const state = resultState(result);
    const node = state.node;
    const examples = options.accessExamples ? options.accessExamples(node) : [];
    const detailed = hasDetails(node, examples);
    const item = el("li", {
      class: `dataset-tree__node dataset-tree__node--${node.kind} dataset-tree__node--result`,
      attrs: {
        "data-dataset-tree-id": node.id,
        "data-dt-result": result.loaded ? "loaded" : "indexed",
      },
    });

    // `canExpand` is false for every result, including one whose loaded twin is a branch: the
    // result list is a list of destinations, and opening a branch inside it would need a tree.
    item.appendChild(renderRowLine(state, false, detailed, view, false));

    const trail = result.trail;
    if (trail) {
      item.appendChild(
        el("p", {
          class: "dataset-tree__trail",
          text: fill(labels.searchResultLocation, { path: trail }),
        }),
      );
    }

    if (state.detailsOpen && detailed) item.appendChild(renderDetails(state, examples));
    return item;
  }

  function message(
    kind: "loading" | "empty" | "error",
    text: string,
    spinner: boolean,
    extra: readonly Node[] = [],
  ): HTMLElement {
    return el("div", {
      class: `dataset-tree__msg dataset-tree__msg--${kind}`,
      children: [
        spinner ? el("span", { class: "dataset-tree__spin" }) : null,
        el("span", { class: "dataset-tree__msg-text", text }),
        ...extra,
      ],
    });
  }

  function renderNode(
    id: string,
    view: { visible: Set<string>; matched: Set<string> } | null,
  ): HTMLElement {
    const state = nodes.get(id);
    if (!state) return el("li");
    const node = state.node;
    const canExpand = expandable(node);
    const examples = options.accessExamples ? options.accessExamples(node) : [];
    const detailed = canExpand ? hasBranchDetails(node, examples) : hasDetails(node, examples);
    // `aria-level`, on a list item, and deliberately not `role="treeitem"`: this component is
    // nested lists of native buttons, a half-built tree is worse for assistive technology than
    // either whole thing, and `tree-a11y.test.ts` holds the line. `aria-level` is supported on
    // `listitem` too, so a screen reader is told the depth the indentation shows. One-based.
    const item = el("li", {
      class: `dataset-tree__node dataset-tree__node--${node.kind}`,
      attrs: { "data-dataset-tree-id": node.id, "aria-level": String(state.depth + 1) },
    });

    // Under a filter a branch opens because it contains a match, not because the user opened it,
    // and a matched directory whose children all fail the filter shows nothing rather than "Empty".
    const showChildren =
      canExpand &&
      (view === null
        ? state.expanded
        : state.childIds === null
          ? state.expanded
          : state.childIds.some((childId) => view.visible.has(childId)));

    item.appendChild(renderRowLine(state, canExpand, detailed, view, showChildren));

    if (state.detailsOpen && detailed) {
      item.appendChild(renderDetails(state, examples));
    }
    if (showChildren) {
      item.appendChild(renderChildren(state, view));
    }
    return item;
  }

  /**
   * A row and everything beside it on the same line. The row is a button inside a flex line, which
   * is what lets the rest exist: a project link has to be a real `<a>` and a details toggle a real
   * `<button>`, neither of which can nest inside the row button. The row's compact metadata lives
   * out here too, a semantic fix not a layout one: everything inside a button joins its accessible
   * name, so a badge and a byte count would be announced as part of the row's name.
   */
  function renderRowLine(
    state: NodeState,
    canExpand: boolean,
    detailed: boolean,
    view: { visible: Set<string>; matched: Set<string> } | null,
    showChildren: boolean,
  ): HTMLElement {
    const node = state.node;
    const line = el("div", { class: "dataset-tree__rowline" });
    line.appendChild(renderRow(state, canExpand, detailed, view, showChildren));

    // The information control sits next to the name, not at the row's right edge, so it reads as
    // part of the name - which is what it is, where this folder is. It and its card share a
    // positioned wrapper, so the card is anchored without measurement: `left: 0` means "under the
    // button". It is last of the things attached to the name, so it follows a project link if any.
    const link = renderDocLink(node);
    if (link) line.appendChild(link);

    if (canExpand && detailed) {
      const name = displayName(node);
      const wrap = el("span", { class: "dataset-tree__infowrap" });
      wrap.appendChild(
        button({
          class: `dataset-tree__info-btn${state.infoOpen ? " is-open" : ""}`,
          action: "info",
          key: `info:${node.id}`,
          children: [icon(INFO, "dataset-tree__info")],
          attrs: {
            "data-dt-id": node.id,
            "aria-expanded": String(state.infoOpen),
            "aria-controls": state.infoOpen ? domId(node.id, "info") : null,
            "aria-label": fill(state.infoOpen ? labels.hideDetails : labels.showDetails, { name }),
          },
        }),
      );
      if (state.infoOpen) wrap.appendChild(renderInfoCard(state));
      line.appendChild(wrap);
    }

    line.appendChild(el("span", { class: "dataset-tree__spacer" }));

    for (const metric of rowMetrics(node)) line.appendChild(metric);

    const badge = availabilityBadge(node);
    if (badge) line.appendChild(badge);

    return line;
  }

  /**
   * What a branch knows about itself, as a small card rather than a panel: a panel below the row
   * would push every row under it down the screen, while a card anchored to the control leaves the
   * tree where it is. It closes on its own cross, a press outside it, Escape, or the control that
   * opened it. `role="dialog"` with `aria-modal` absent: nothing behind it is inert, and a modal
   * that does not trap focus is worse than no claim.
   */
  function renderInfoCard(state: NodeState): HTMLElement {
    const node = state.node;
    const card = el("div", {
      class: "dataset-tree__infocard",
      attrs: {
        id: domId(node.id, "info"),
        role: "dialog",
        "aria-label": fill(labels.showDetails, { name: displayName(node) }),
      },
    });

    card.appendChild(
      el("div", {
        class: "dataset-tree__infohead",
        children: [
          el("span", { class: "dataset-tree__dname", text: displayName(node) }),
          button({
            class: "dataset-tree__infoclose",
            action: "info-close",
            key: `info-close:${node.id}`,
            children: [icon(CLOSE, "dataset-tree__closeicon")],
            attrs: {
              "data-dt-id": node.id,
              "aria-label": labels.closeDetails,
              title: labels.closeDetails,
            },
          }),
        ],
      }),
    );

    const path = displayableLiteral(node.path);
    if (path) {
      card.appendChild(
        el("div", {
          class: "dataset-tree__path",
          attrs: { role: "group", "aria-label": labels.fieldPath },
          children: [el("code", { text: path }), pathCopyButton(node)],
        }),
      );
    }

    const fields: Node[] = [];
    for (const field of node.details ?? []) {
      const values = detailValues(field.values);
      if (values.length > 0) fields.push(fieldRow(field.label, values));
    }
    const access = accessRow(node);
    if (access) fields.push(access);
    if (fields.length > 0) {
      card.appendChild(el("div", { class: "dataset-tree__meta", children: fields }));
    }
    return card;
  }

  /**
   * Put the open card where it fits, which is the one thing CSS cannot decide alone. Below the
   * control by default, flipping above when there is no room - the body is a scroll container, so a
   * card opened on the last row would be clipped. Read once per render, after the DOM is in place.
   */
  function placeInfoCard(): void {
    const card = body.querySelector<HTMLElement>(".dataset-tree__infocard");
    if (!card) return;
    card.classList.remove("is-above");
    const limit = body.getBoundingClientRect().bottom;
    const box = card.getBoundingClientRect();
    if (box.bottom > limit && box.height < body.getBoundingClientRect().height) {
      card.classList.add("is-above");
    }
  }

  /** Close whichever card is open, if any. Returns true when something was closed. */
  function closeInfoCards(): boolean {
    let closed = false;
    for (const state of nodes.values()) {
      if (!state.infoOpen) continue;
      state.infoOpen = false;
      closed = true;
    }
    return closed;
  }

  /**
   * The project or document page a collection points at. `safeHref` is the gate every other URL in
   * this package passes: a catalogue is untrusted input, and a `javascript:` in an `href` is where
   * it becomes executable without anybody writing `innerHTML`.
   */
  function renderDocLink(node: DatasetTreeNode): HTMLElement | null {
    const href = safeHref(node.link?.href);
    if (!href) return null;
    const name = node.link?.label ?? fill(labels.openLink, { name: displayName(node) });
    return el("a", {
      class: "dataset-tree__doclink",
      attrs: {
        href,
        rel: "noopener noreferrer",
        target: "_blank",
        "aria-label": name,
        title: name,
      },
      children: [icon(EXTERNAL, "dataset-tree__doclink-icon")],
    });
  }

  /**
   * The row's right edge: only what a reader scans by. The model carries a media type and a
   * timestamp per node; printing both buys two columns of similar text at the expense of the one
   * that differs. What appears is the source's own `metrics`, plus a size.
   */
  function rowMetrics(node: DatasetTreeNode): HTMLElement[] {
    const out: HTMLElement[] = [];
    const metrics = Array.isArray(node.metrics) ? node.metrics : [];
    for (const metric of metrics.slice(0, MAX_ROW_METRICS)) {
      const element = renderMetric(metric);
      if (element) out.push(element);
    }
    const size = formatBytes(node.size);
    if (size) out.push(el("span", { class: "dataset-tree__size", text: size }));
    return out;
  }

  function renderMetric(metric: DatasetTreeMetric): HTMLElement | null {
    if (!metric || typeof metric.value !== "string" || metric.value.length === 0) return null;
    if (metric.style === "plain") {
      return el("span", {
        class: "dataset-tree__size",
        text: metric.label ? `${metric.label} ${metric.value}` : metric.value,
      });
    }
    return el("span", {
      class: "dataset-tree__lvl",
      children: [
        metric.label ? el("span", { class: "dataset-tree__lvl-key", text: metric.label }) : null,
        el("span", { text: metric.value }),
      ],
    });
  }

  function renderRow(
    state: NodeState,
    canExpand: boolean,
    detailed: boolean,
    view: { visible: Set<string>; matched: Set<string> } | null,
    showChildren: boolean,
  ): HTMLElement {
    const node = state.node;
    const name = displayName(node);
    const interactive = canExpand || detailed || Boolean(options.onNavigate);
    const parts: Node[] = [];

    // A chevron on anything that opens, including a dataset, whose row opens a panel rather than a
    // branch: without that, a store row that opens a detail panel would look identical to an inert
    // file. The affordance is about whether pressing the row changes the page.
    parts.push(
      canExpand || detailed
        ? icon(CHEVRON, "dataset-tree__chev")
        : el("span", { class: "dataset-tree__chev dataset-tree__chev--leaf" }),
    );
    parts.push(icon(iconFor(node), `dataset-tree__icon dataset-tree__icon--${node.kind}`, "fill"));

    parts.push(
      el("span", {
        class: `dataset-tree__name${node.kind === "dataset" || node.kind === "file" ? " dataset-tree__name--mono" : ""}`,
        children: highlight(name, view?.matched.has(node.id) ? filterQuery : ""),
      }),
    );

    if (node.kind === "collection" && node.description) {
      parts.push(el("span", { class: "dataset-tree__sub", text: node.description }));
    }

    if (!interactive) {
      return el("div", {
        class: "dataset-tree__row dataset-tree__row--inert",
        attrs: { "data-dt-row": node.id },
        children: parts,
      });
    }

    const action = canExpand ? "toggle" : "activate";
    const expandedNow = canExpand ? state.expanded : state.detailsOpen;
    const row = button({
      class: "dataset-tree__row",
      action,
      key: `${action}:${node.id}`,
      children: parts,
      attrs: {
        "aria-expanded": String(expandedNow),
        // A dangling `aria-controls` is a promise to assistive technology it cannot keep.
        "aria-controls": canExpand
          ? showChildren
            ? domId(node.id, "children")
            : null
          : detailed && state.detailsOpen
            ? domId(node.id, "details")
            : null,
        "data-dt-id": node.id,
        "data-dt-row": node.id,
        // `aria-current="true"` rather than `"page"`: the chosen node is the current item within
        // this widget, not the page the browser is on, which the document's navigation decides.
        "aria-current": selectedId === node.id ? "true" : null,
        "aria-label": fill(
          expandedNow
            ? canExpand
              ? labels.collapse
              : labels.hideDetails
            : canExpand
              ? labels.expand
              : labels.showDetails,
          { name },
        ),
      },
    });
    return row;
  }

  /**
   * A name, with the part that matched the filter marked - the difference between "this row is a
   * result" and "this is why". Built as three text nodes, never as markup: the query comes from a
   * text field and the name from a catalogue, and neither is parsed.
   */
  function highlight(text: string, query: string): Node[] {
    if (query.length === 0) return [document.createTextNode(text)];
    const at = text.toLowerCase().indexOf(query);
    if (at < 0) return [document.createTextNode(text)];
    const out: Node[] = [];
    if (at > 0) out.push(document.createTextNode(text.slice(0, at)));
    out.push(
      el("mark", {
        class: "dataset-tree__mark",
        text: text.slice(at, at + query.length),
      }),
    );
    const rest = text.slice(at + query.length);
    if (rest.length > 0) out.push(document.createTextNode(rest));
    return out;
  }

  function iconFor(node: DatasetTreeNode): readonly string[] {
    if (node.kind === "dataset") return CUBE;
    if (node.kind === "file") return FILE;
    return FOLDER;
  }

  /**
   * The one pill a row may carry, and only when the source said something. Not a colour-coded
   * taxonomy derived from the model's enum - a vocabulary the component invented, shouting on a row
   * of quiet text - but the source's own short factual note, drawn in the row's colour and case;
   * the enum only supplies a lowercase fallback word.
   */
  function availabilityBadge(node: DatasetTreeNode): HTMLElement | null {
    const availability = node.availability;
    const note = node.availabilityNote;
    if (!note && (!availability || availability === "available")) return null;
    const text =
      note ??
      (availability === "planned"
        ? labels.plannedBadge
        : availability === "restricted"
          ? labels.restrictedBadge
          : availability === "empty"
            ? labels.emptyBadge
            : labels.unavailableBadge);
    // One pill, no state variant: a planned / restricted / unavailable / empty taxonomy is a status
    // vocabulary the component invented. The planned marker and the empty-store marker are the same
    // quiet pill because both say the same thing - there is nothing here to open yet.
    return el("span", {
      class: "dataset-tree__badge",
      children: [el("span", { class: "dataset-tree__badge-dot" }), el("span", { text })],
    });
  }

  function renderChildren(
    state: NodeState,
    view: { visible: Set<string>; matched: Set<string> } | null,
  ): HTMLElement {
    const wrap = el("div", {
      class: "dataset-tree__children",
      attrs: { id: domId(state.node.id, "children") },
    });

    if (state.load === "loading") {
      wrap.appendChild(message("loading", labels.loadingChildren, true));
      return wrap;
    }
    if (state.load === "error") {
      // In the branch, and only in the branch: one bucket refusing anonymous listing must not take
      // the tree down with it, so the message goes where the children would have been and every
      // other branch stays usable. `Retry` appears only when repeating the request could succeed.
      wrap.appendChild(
        message(
          "error",
          // A classified failure is printed as written; anything else is wrapped. "Could not list -
          // Access denied - this bucket does not permit anonymous browser listing." is two
          // sentences fighting over one job: a source that classified has already said what
          // happened and what to do, and the wrapper is for raw exception text.
          state.classified
            ? (state.error ?? "")
            : fill(labels.childrenError, { error: state.error ?? "" }),
          false,
          state.retryable
            ? [
                button({
                  class: "dataset-tree__btn",
                  text: labels.retry,
                  action: "retry",
                  key: `retry:${state.node.id}`,
                  attrs: {
                    "data-dt-id": state.node.id,
                    // A second press while the first is in flight is not a second attempt; the
                    // handler is guarded too, and this is what the reader can see.
                    disabled: state.retrying ? true : null,
                  },
                }),
              ]
            : [],
        ),
      );
      return wrap;
    }

    const childIds = state.childIds ?? [];
    const shown = view ? childIds.filter((id) => view.visible.has(id)) : childIds;
    if (shown.length === 0) {
      wrap.appendChild(message("empty", labels.childrenEmpty, false));
      return wrap;
    }
    const list = el("ul", { class: "dataset-tree__list" });
    for (const id of shown) list.appendChild(renderNode(id, view));
    wrap.appendChild(list);
    return wrap;
  }

  // details
  /**
   * Whether opening this node shows anything. Not on the list: a size, a media type or a timestamp,
   * which would open a panel restating the row. A panel is worth a toggle when it holds a path, an
   * access route, or published facts.
   */
  function hasDetails(node: DatasetTreeNode, examples: readonly DatasetAccessExample[]): boolean {
    // A planned node has nothing to show about itself, and a panel would be a promise. It reached
    // here through `node.path` alone - every node has one - so it acquired a chevron, an
    // `aria-expanded` and a panel holding a location that holds nothing, behaving exactly as a
    // browsable collection does. Nothing to copy, inspect or disclose: a badge, and that is all.
    if (node.availability === "planned") return false;
    return Boolean(
      node.path ||
      examples.length > 0 ||
      (node.details && node.details.length > 0) ||
      (node.access && node.access.length > 0) ||
      (options.onInspect && node.inspect),
    );
  }

  /**
   * Whether an expandable node gets a details toggle - almost always no. A leaf's row is its own
   * toggle, so this covers only collections and directories, whose path is already on screen, so
   * the panel would restate the row. It appears when the source published something a reader cannot
   * see: detail fields, an access route, a code sample.
   */
  function hasBranchDetails(
    node: DatasetTreeNode,
    examples: readonly DatasetAccessExample[],
  ): boolean {
    return Boolean(
      examples.length > 0 ||
      (node.details && node.details.length > 0) ||
      (node.access && node.access.length > 0) ||
      (options.onInspect && node.inspect),
    );
  }

  /**
   * The expanded panel under a dataset row, in a fixed order where each part earns its place: what
   * this is, the two things you can do with it, where it lives, how to read it, and the facts the
   * source published. Not a dump of the node, whose length would follow the source's metadata.
   */
  function renderDetails(state: NodeState, examples: readonly DatasetAccessExample[]): HTMLElement {
    const node = state.node;
    const panel = el("div", {
      class: "dataset-tree__details",
      attrs: { id: domId(node.id, "details") },
    });

    const actions: Node[] = [el("span", { class: "dataset-tree__dname", text: node.name })];
    const path = displayableLiteral(node.path);
    // Two conditions, both required: the consumer has to have somewhere to open the node, and the
    // node has to have something inspectable. Either alone produces a control that looks operable
    // and is not - so no alert, no placeholder dialog, no button that does nothing: no button.
    if (options.onInspect && node.inspect) {
      actions.push(
        button({
          class: "dataset-tree__btn dataset-tree__btn--primary",
          text: labels.inspect,
          action: "inspect",
          key: `inspect:${node.id}`,
          attrs: { "data-dt-id": node.id },
        }),
      );
    }
    // Run sits beside Inspect, the two things a reader does with a store. In the snippet's title
    // bar it would be one disclosure deeper than Inspect, so the two halves of the same decision
    // would never be on screen together. It runs the example the panel is showing (`exampleTab`,
    // the first one until somebody chooses another), and that example's id travels on the button.
    const runnableExample = currentExample(state, examples);
    if (runnableExample && tryPythonEligible(runnableExample, options.python)) {
      actions.push(
        button({
          class: "dataset-tree__btn dataset-tree__btn--primary dataset-tree__btn--run",
          action: "try-python",
          key: `try:${node.id}`,
          attrs: {
            "data-dt-id": node.id,
            "data-dt-example": runnableExample.id,
            "aria-label": fill(labels.tryPythonFor, { name: runnableExample.label }),
          },
          children: [
            icon(PLAY, "dataset-tree__run-icon", "fill"),
            el("span", { text: labels.tryPython }),
          ],
        }),
      );
    }
    panel.appendChild(el("div", { class: "dataset-tree__actions", children: actions }));

    if (path) {
      // The copy control is inside the address, not beside the name. In the action row it made a
      // reader match a verb to a value further down the panel, and competed with the two controls
      // that do something to the store. Copying an address is an affordance of that address, as in
      // every console and object browser, and the tick attaches the feedback to what was copied.
      panel.appendChild(
        el("div", {
          class: "dataset-tree__path",
          attrs: { role: "group", "aria-label": labels.fieldPath },
          children: [el("code", { text: path }), pathCopyButton(node)],
        }),
      );
    }

    if (examples.length > 0) panel.appendChild(renderExamples(state, examples));

    const fields: Node[] = [];
    for (const field of node.details ?? []) {
      const values = detailValues(field.values);
      if (values.length > 0) fields.push(fieldRow(field.label, values));
    }
    const access = accessRow(node);
    if (access) fields.push(access);
    if (fields.length > 0) {
      panel.appendChild(el("div", { class: "dataset-tree__meta", children: fields }));
    }

    return panel;
  }

  /** The chips of one detail field. `value` is emphasised after `text`, as in `time 350 640`. */
  function detailValues(values: readonly { text: string; value?: string }[]): Node[] {
    const out: Node[] = [];
    for (const entry of values.slice(0, MAX_CHIPS)) {
      if (!entry || typeof entry.text !== "string" || entry.text.length === 0) continue;
      out.push(
        el("span", {
          class: "dataset-tree__chip",
          children: [
            el("span", { text: entry.text.slice(0, 200) }),
            typeof entry.value === "string" && entry.value.length > 0
              ? el("b", { text: ` ${entry.value.slice(0, 200)}` })
              : null,
          ],
        }),
      );
    }
    if (values.length > MAX_CHIPS) {
      out.push(el("span", { class: "dataset-tree__chip", text: `+${values.length - MAX_CHIPS}` }));
    }
    return out;
  }

  /** The example the panel is showing, which is the one a run control may offer to run. */
  function currentExample(
    state: NodeState,
    examples: readonly DatasetAccessExample[],
  ): DatasetAccessExample | undefined {
    if (examples.length === 0) return undefined;
    return examples[Math.min(Math.max(state.exampleTab, 0), examples.length - 1)];
  }

  /**
   * The copy control that lives inside the address box. An icon rather than a word: it sits in a
   * monospace box whose content is the point, and a three-word button would read as part of the
   * address. The accessible name carries the whole sentence; success swaps the glyph for a tick,
   * and failure, with no room in a 24px square, goes to the live region.
   */
  function pathCopyButton(node: DatasetTreeNode): HTMLButtonElement {
    const key = `path:${node.id}`;
    const feedback = copyFeedback.get(key);
    const label =
      feedback === "copied"
        ? labels.copied
        : feedback === "failed"
          ? labels.copyFailed
          : labels.copyPath;
    return button({
      class: `dataset-tree__path-copy${feedback === "copied" ? " is-done" : ""}${
        feedback === "failed" ? " is-failed" : ""
      }`,
      action: "copy-path",
      key,
      children: [icon(feedback === "copied" ? CHECK : COPY, "dataset-tree__copy-icon")],
      attrs: {
        "data-dt-id": node.id,
        "data-dt-copy-key": key,
        "aria-label": label,
        title: label,
      },
    });
  }

  function copyButton(
    key: string,
    label: string,
    action: string,
    attrs: Record<string, string>,
  ): HTMLButtonElement {
    const feedback = copyFeedback.get(key);
    const text =
      feedback === "copied" ? labels.copied : feedback === "failed" ? labels.copyFailed : label;
    return button({
      class: `dataset-tree__btn${feedback === "copied" ? " is-done" : ""}${
        feedback === "failed" ? " is-failed" : ""
      }`,
      text,
      action,
      key,
      attrs: { ...attrs, "data-dt-copy-key": key },
    });
  }

  function fieldRow(key: string, values: readonly Node[]): HTMLElement {
    return el("div", {
      class: "dataset-tree__metarow",
      children: [el("span", { class: "dataset-tree__metakey", text: key }), ...values],
    });
  }

  function textChip(text: string): HTMLElement {
    return el("span", { class: "dataset-tree__chip", text });
  }

  function accessRow(node: DatasetTreeNode): HTMLElement | null {
    const access = node.access;
    if (!access || access.length === 0) return null;
    const items: Node[] = [];
    for (const entry of access) {
      if (!entry || typeof entry.label !== "string") continue;
      const href = safeHref(entry.href);
      if (href) {
        items.push(
          el("a", {
            class: "dataset-tree__link",
            text: entry.label,
            attrs: {
              href,
              rel: "noopener noreferrer",
              target: "_blank",
              "aria-label": fill(labels.openLink, { name: entry.label }),
            },
            children: [icon(EXTERNAL, "dataset-tree__link-icon")],
          }),
        );
        continue;
      }
      const literal = displayableLiteral(entry.value ?? entry.href);
      items.push(
        literal
          ? el("span", {
              class: "dataset-tree__chip",
              children: [el("span", { text: entry.label }), el("b", { text: ` ${literal}` })],
            })
          : textChip(entry.label),
      );
    }
    return items.length > 0 ? fieldRow(labels.fieldAccess, items) : null;
  }

  function renderExamples(
    state: NodeState,
    examples: readonly DatasetAccessExample[],
  ): HTMLElement {
    const node = state.node;
    const open = state.accessOpen;
    const bodyId = domId(node.id, "access");

    const disclose = button({
      class: `dataset-tree__disclose${open ? " is-open" : ""}`,
      action: "disclose",
      key: `disclose:${node.id}`,
      attrs: { "aria-expanded": String(open), "aria-controls": bodyId, "data-dt-id": node.id },
      children: [
        icon(INFO, "dataset-tree__info"),
        el("span", { text: labels.accessHeading }),
        icon(CHEVRON, "dataset-tree__chev"),
      ],
    });

    const wrap = el("div", { class: "dataset-tree__access", children: [disclose] });
    const panel = el("div", { class: "dataset-tree__access-body", attrs: { id: bodyId } });
    if (!open) {
      panel.hidden = true;
      wrap.appendChild(panel);
      return wrap;
    }

    const index = Math.min(Math.max(state.exampleTab, 0), examples.length - 1);
    const current = examples[index];

    const tabs = el("div", { class: "dataset-tree__tabs", attrs: { role: "tablist" } });
    examples.forEach((example, i) => {
      tabs.appendChild(
        button({
          class: `dataset-tree__tab${i === index ? " is-active" : ""}`,
          text: example.label,
          action: "tab",
          key: `tab:${node.id}:${i}`,
          attrs: {
            role: "tab",
            "aria-selected": String(i === index),
            "data-dt-id": node.id,
            "data-dt-index": String(i),
          },
        }),
      );
    });

    // One tab is not a choice: a single-entry tablist says "pick one" to a reader who has nothing
    // to pick, and costs a row of the panel to say it. The strip appears when there is more than
    // one way to open the store; the code card's language caption already names what is in it.
    if (examples.length > 1) {
      panel.appendChild(el("div", { class: "dataset-tree__tabbar", children: [tabs] }));
    }

    if (current.description) {
      panel.appendChild(el("p", { class: "dataset-tree__prose", text: current.description }));
    }

    // Copy lives in the snippet's own title bar, where every reader has met it, and acts on the
    // text underneath it and nothing else. Run sits beside `Inspect` in the panel's action row
    // instead, because the two are alternatives - inspector or interpreter - and what runs is still
    // the example this card shows. The language label sits left, by the window dots: a caption.
    panel.appendChild(
      el("div", {
        class: "dataset-tree__codecard",
        children: [
          el("div", {
            class: "dataset-tree__codehead",
            children: [
              el("span", {
                class: "dataset-tree__dots",
                children: [el("i"), el("i"), el("i")],
              }),
              el("span", {
                class: "dataset-tree__lang",
                text: current.language ?? current.label,
              }),
              el("span", { class: "dataset-tree__spacer" }),
              copyButton(`example:${node.id}`, labels.copyExample, "copy-example", {
                "data-dt-id": node.id,
              }),
            ],
          }),
          el("pre", {
            class: "dataset-tree__code",
            children: [el("code", { text: current.code })],
          }),
        ],
      }),
    );

    wrap.appendChild(panel);
    return wrap;
  }

  // copy
  function flashCopy(key: string, outcome: CopyState): void {
    copyFeedback.set(key, outcome);
    pendingFocus = key;
    render();
    later(() => {
      if (copyFeedback.get(key) !== outcome) return;
      copyFeedback.delete(key);
      render();
    }, 1400);
  }

  /**
   * Copy, and say which of the two things happened. The clipboard API rejects on a page without
   * focus or without permission, and reporting both outcomes as "Copied" teaches the user to trust
   * a lie.
   */
  function copy(key: string, text: string): void {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      flashCopy(key, "failed");
      return;
    }
    void clipboard.writeText(text).then(
      () => {
        if (!destroyed) flashCopy(key, "copied");
      },
      () => {
        if (!destroyed) flashCopy(key, "failed");
      },
    );
  }

  /**
   * Apply a whole-tree state change and draw it once, without per-node animation. The class is
   * removed on the next frame rather than after a timeout: one frame is exactly long enough for the
   * browser to have painted the new state with transitions off.
   */
  function bulk(change: () => void): void {
    change();
    root.classList.add("is-bulk");
    render();
    const clear = (): void => {
      if (!destroyed) root.classList.remove("is-bulk");
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(clear);
    else later(clear, 0);
  }

  // events
  function onClick(event: MouseEvent): void {
    // Same reasoning as `focusKeyOf`: no `instanceof` against a realm-bound global.
    const target = event.target as { closest?: (selector: string) => HTMLElement | null } | null;
    if (!target || typeof target.closest !== "function") return;
    const control = target.closest("[data-dt-action]");
    if (!control || !root.contains(control)) return;
    const action = control.dataset.dtAction;
    const id = control.dataset.dtId ?? "";
    // Loaded first, always: a result row for a node the tree also holds acts on the tree's own
    // state, so the panel opened from a result is the same panel once the query is cleared.
    // `resultStates` only answers for ids the tree does not have, so no entry becomes a phantom.
    const state = id
      ? (nodes.get(id) ?? (searchResults ? resultStates.get(id) : undefined))
      : undefined;

    switch (action) {
      case "expand-all": {
        // Every expandable node at once, over a source already walked: a state change and a single
        // render, not a cascade of requests. `bulk()` suppresses the chevron transition, since two
        // hundred branches each rotating for 150ms is two hundred simultaneous animations on a list
        // that has just changed height - meaningful one at a time, noise all at once.
        bulk(() => {
          for (const state of nodes.values()) {
            if (expandable(state.node)) state.expanded = true;
          }
        });
        announce(labels.announceExpandedAll);
        return;
      }
      case "collapse-all": {
        bulk(() => {
          for (const node of nodes.values()) node.expanded = false;
          filterInput.value = "";
          filterQuery = "";
          searchResults = null;
          searchTotal = 0;
          hint.hidden = true;
        });
        announce(labels.announceCollapsedAll);
        return;
      }
      case "reload": {
        void reload();
        return;
      }
      case "retry-roots": {
        rootLoad = "idle";
        // The retry control is what was pressed and what the next render replaces, so it is what
        // focus returns to; naming anything outside this row would drop focus on the document.
        pendingFocus = "retry-roots";
        void loadRoots();
        return;
      }
      case "toggle": {
        if (!state) return;
        // Opening or closing a branch is also choosing it: it is the row the visitor just acted on.
        select(id);
        state.expanded = !state.expanded;
        if (!state.expanded) {
          // A collapsed branch must not keep a request alive; the user said they are not
          // interested, and a late response would re-render a branch nobody is looking at.
          abortSubtree(id);
          render();
          return;
        }
        if (state.load === "idle" || state.load === "error") {
          state.load = state.load === "error" ? "idle" : state.load;
          state.error = null;
          void loadChildren(id);
        } else {
          render();
        }
        return;
      }
      case "retry": {
        if (!state) return;
        // One retry at a time, and only this branch's request. A second press while the first is in
        // flight is the same intention; acting on it would abort the running request and start it
        // again, which makes the button look broken on a slow endpoint and doubles the load.
        // Nothing else is touched: siblings keep their listings and open branches stay open.
        if (state.retrying || state.load === "loading") return;
        state.retrying = true;
        state.load = "idle";
        state.error = null;
        pendingFocus = `toggle:${id}`;
        void loadChildren(id).finally(() => {
          const current = nodes.get(id);
          if (current) current.retrying = false;
        });
        return;
      }
      case "activate": {
        if (!state) return;
        state.detailsOpen = !state.detailsOpen;
        select(id);
        render();
        options.onNavigate?.(state.node);
        return;
      }
      // A path segment moves the selection and reveals the row, opening whatever is closed on the
      // way. It never navigates: this is a position inside the widget, not a destination.
      case "path": {
        if (!nodes.get(id)) return;
        let cursor = nodes.get(id)?.parentId ?? null;
        let guard = 0;
        while (cursor !== null && guard < MAX_MATERIALIZE_DEPTH) {
          const ancestor = nodes.get(cursor);
          if (!ancestor) break;
          ancestor.expanded = true;
          cursor = ancestor.parentId;
          guard += 1;
        }
        select(id);
        render();
        revealRow(id);
        return;
      }
      // Put the whole path back, and leave it back until the reader chooses something else. The
      // footer is rebuilt rather than the segments unhidden: `pathExpanded` is what the fitter
      // reads, so a resize re-run never argues with a click that happened earlier.
      case "path-more": {
        pathExpanded = true;
        refreshFoot();
        return;
      }
      case "details": {
        if (!state) return;
        select(id);
        state.detailsOpen = !state.detailsOpen;
        render();
        return;
      }
      // One card at a time, which makes this a popover rather than a set of panels: a second press
      // anywhere in the tree closes the first, so a reader never hunts for the one they left open.
      case "info": {
        if (!state) return;
        const wasOpen = state.infoOpen;
        closeInfoCards();
        state.infoOpen = !wasOpen;
        select(id);
        render();
        return;
      }
      case "info-close": {
        if (!state) return;
        state.infoOpen = false;
        // Back to the control that opened it, which is where the reader's attention already is.
        pendingFocus = `info:${id}`;
        render();
        return;
      }
      case "disclose": {
        if (!state) return;
        state.accessOpen = !state.accessOpen;
        render();
        return;
      }
      case "tab": {
        if (!state) return;
        state.exampleTab = Number(control.dataset.dtIndex ?? "0");
        render();
        return;
      }
      case "copy-path": {
        if (!state) return;
        const path = displayableLiteral(state.node.path);
        if (path) copy(`path:${id}`, path);
        return;
      }
      case "copy-example": {
        if (!state || !options.accessExamples) return;
        const examples = options.accessExamples(state.node);
        const current = examples[Math.min(Math.max(state.exampleTab, 0), examples.length - 1)];
        if (current) copy(`example:${id}`, current.code);
        return;
      }
      // "Try in Python": re-derive the example, re-check eligibility, report a name. The test runs
      // again because the DOM is not the authority on what runs. Nothing is re-rendered: the press
      // must not move the page.
      case "try-python": {
        if (!state || !options.accessExamples || !options.python) return;
        const examples = options.accessExamples(state.node);
        const current = examples[Math.min(Math.max(state.exampleTab, 0), examples.length - 1)];
        if (!tryPythonEligible(current, options.python)) return;
        const digest = registeredDigest(current);
        if (!digest) return;
        // A name and a digest. Not the code - see `TryPythonEvent`.
        options.python.onTry({ exampleId: current.id, digest, datasetId: state.node.id });
        return;
      }
      case "inspect": {
        if (!state || !options.onInspect || !state.node.inspect) return;
        const controller = new AbortController();
        inspectControllers.add(controller);
        void Promise.resolve()
          .then(() => options.onInspect?.(state.node, { signal: controller.signal }))
          .catch(() => undefined)
          .then(() => inspectControllers.delete(controller));
        return;
      }
      default:
        return;
    }
  }

  function onFilterInput(): void {
    if (filterTimer !== null) clearTimeout(filterTimer);
    const value = filterInput.value;
    filterTimer = setTimeout(() => {
      filterTimer = null;
      if (!destroyed) applyFilter(value);
    }, debounceMs);
  }

  function onFilterKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || filterInput.value.length === 0) return;
    event.preventDefault();
    filterInput.value = "";
    if (filterTimer !== null) {
      clearTimeout(filterTimer);
      filterTimer = null;
    }
    applyFilter("");
  }

  root.addEventListener("click", onClick);
  filterInput.addEventListener("input", onFilterInput);
  filterInput.addEventListener("keydown", onFilterKeydown);

  // handle
  function reload(): Promise<void> {
    if (destroyed) return Promise.resolve();
    generation += 1;
    rootController?.abort();
    for (const state of nodes.values()) state.controller?.abort();
    nodes.clear();
    domIds.clear();
    copyFeedback.clear();
    autoExpanded.clear();
    // A reload replaces every loaded node, so a result list computed against the old ones is stale
    // in the part that came from the tree. The index is the consumer's and unchanged, so the query
    // is re-run against the new tree on the next keystroke; only the stale answer is dropped.
    resultStates.clear();
    searchResults = null;
    searchTotal = 0;
    rootIds = null;
    rootLoad = "idle";
    rootError = null;
    return loadRoots();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    generation += 1;
    rootController?.abort();
    for (const state of nodes.values()) state.controller?.abort();
    for (const controller of inspectControllers) controller.abort();
    inspectControllers.clear();
    if (filterTimer !== null) clearTimeout(filterTimer);
    filterTimer = null;
    resultStates.clear();
    searchResults = null;
    searchTotal = 0;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    root.removeEventListener("click", onClick);
    // Removes the card's document listeners when the component goes away with a card still open.
    if (dismissing) {
      root.ownerDocument.removeEventListener("pointerdown", onOutside, true);
      root.ownerDocument.removeEventListener("keydown", onDismissKey, true);
      dismissing = false;
    }
    filterInput.removeEventListener("input", onFilterInput);
    filterInput.removeEventListener("keydown", onFilterKeydown);
    nodes.clear();
    copyFeedback.clear();
    domIds.clear();
    if (pathFit) {
      pathFit.disconnect();
      pathFit = null;
    }
    // The host's own controls are taken out of the toolbar before the toolbar goes, so `destroy()`
    // does not silently delete an element the consumer created and may still be holding. What
    // happens to them next is the consumer's business.
    for (const extra of options.toolbarExtras ?? []) extra.remove();
    root.remove();
  }

  void loadRoots();

  return { reload, destroy };
}
