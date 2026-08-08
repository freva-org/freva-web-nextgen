// components/results.ts - list & grid results with loading/empty/error+retry states and the
// "Load next 100" pagination rule. Browsing fetches NO per-file metadata: rows render purely
// from the cheap {file, fs_type} search rows. The per-file kebab and pick UX live here; all
// dynamic text goes through el()'s text/textContent.
//
// - No module-level Disposables: buckets are created per render and passed explicitly, so
//   multiple mounted instances (or a future async render) can never share listener state.
// - Two buckets: 'results-rows' lives as long as the CURRENT row DOM (flushed only on a full
//   rebuild), 'results-more' is flushed on every render. This is what lets "load next 100"
//   APPEND the new rows instead of rebuilding hundreds of existing ones.
// - Focus/pick changes do NOT re-render: updateRowStates() patches classes/aria in place.

import type { AppContext } from "../context.js";
import { el, replaceChildren, svgIcon, type Disposables } from "../dom.js";
import { brandIcon } from "../brand.js";
import { ICONS } from "../icons.js";
import { formatTile } from "./formatTile.js";
import { downloadFilename, downloadableUrl } from "../downloads.js";
import type { FileRow } from "../types.js";
import { MANY_RESULTS_THRESHOLD, MAX_SELECTED_FILES } from "../types.js";

/** True once no further file may be added to the selection. */
function atSelectionCap(ctx: AppContext): boolean {
  return ctx.state.pickedKeys.size >= MAX_SELECTED_FILES;
}

/** Per-mount render bookkeeping (WeakMap - never module-shared across instances). */
interface RenderMemo {
  /** number of rows currently in the DOM when mode==='rows'; -1 for state screens. */
  renderedCount: number;
  view: "list" | "grid" | null;
  rowsBucket: Disposables | null;
  /**
   * fileKey -> its rendered node. Populated on rebuild AND on append, cleared on rebuild/teardown.
   * This is what lets a focus/pick patch touch three nodes instead of running
   * `querySelectorAll('[data-key]')` over every loaded row on every single click.
   */
  nodes: Map<string, HTMLElement>;
  /** the key that currently carries `.focus`, so it can be un-patched without a scan. */
  focusedKey: string | null;
  /** whether the list is currently in the at-cap presentation (drives a one-time full pass). */
  atCap: boolean;
  /** the row epoch (state.rowsEpoch) the DOM currently reflects. The append fast-path is valid ONLY
   *  while the epoch is unchanged - a reset (new query/filter) bumps it and forces a full rebuild.
   *  Comparing epochs keeps "load next" O(1) instead of re-scanning the rendered prefix. */
  epoch: number;
}
const memos = new WeakMap<AppContext, RenderMemo>();
function memo(ctx: AppContext): RenderMemo {
  let m = memos.get(ctx);
  if (!m) {
    m = {
      renderedCount: -1,
      view: null,
      rowsBucket: null,
      epoch: -1,
      nodes: new Map<string, HTMLElement>(),
      focusedKey: null,
      atCap: false,
    };
    memos.set(ctx, m);
  }
  return m;
}

/**
 * ONE node carrying the COMPLETE path, exactly as the archive reports it.
 *
 * Splitting it into a bold basename plus a second directory line reads as two values, invites the
 * eye to treat the filename as the identity, and - because the two lines are rendered
 * independently - leaves the whole path in the DOM as two fragments a reader (or a copy) has to
 * reassemble. A file's identity IS its full URI, so it is rendered as one
 * value: never split, never reconstructed by concatenation.
 *
 * The visual truncation is CSS's job, so the accessible name has to carry what the eye cannot see.
 */
function pathEl(file: string, cls: string): HTMLElement {
  // `title` goes through el(), which routes it to the styled tooltip (data-tip) rather than the
  // browser's slow native popup - the package-wide rule. el() only mirrors it to `aria-label` when
  // the node is otherwise unlabelled, and this one has visible text, so the accessible name is set
  // explicitly: CSS clips the value, and a clipped accessible name is a lost one.
  const node = el("div", { class: cls, text: file, title: file });
  node.setAttribute("aria-label", file);
  return node;
}

function checkbox(ctx: AppContext, reg: Disposables, row: FileRow): HTMLElement {
  const picked = ctx.state.pickedKeys.has(row.key);
  const capped = atSelectionCap(ctx) && !picked;
  const cb = el(
    "span",
    {
      class: `cb${capped ? " capped" : ""}`,
      role: "checkbox",
      tabindex: "0",
      "aria-checked": picked ? "true" : "false",
      // At the cap, UNSELECTED boxes announce as disabled WITH the reason. Already-selected boxes
      // stay fully enabled - a selection you cannot undo is a trap.
      "aria-disabled": capped ? "true" : "false",
      "aria-label": capped
        ? `Select ${row.file} - unavailable: the ${MAX_SELECTED_FILES}-file selection limit is reached`
        : `Select ${row.file}`,
    },
    picked ? [svgIcon(ICONS.check, { size: 11 })] : [],
  );
  const act = (e: Event): void => {
    e.stopPropagation();
    ctx.togglePick(row.key);
  };
  reg.listen(cb, "click", act);
  reg.listen(cb, "keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === " " || k === "Enter") {
      e.preventDefault();
      act(e);
    }
  });
  return cb;
}

function kebab(ctx: AppContext, reg: Disposables, row: FileRow): HTMLButtonElement {
  const btn = el(
    "button",
    {
      class: "kebab",
      type: "button",
      "aria-label": "File actions",
      "aria-haspopup": "menu",
      title: "File actions",
    },
    [svgIcon(ICONS.kebab, { size: 18 })],
  );
  reg.listen(btn, "click", (e) => {
    e.stopPropagation();
    openFileMenu(ctx, reg, btn, row);
  });
  return btn;
}

function menuItem(
  ctx: AppContext,
  reg: Disposables,
  icon: Node,
  label: string,
  run: () => void,
): HTMLElement {
  const item = el("div", { class: "pop-item", role: "menuitem", tabindex: "0" }, [
    el("span", { class: "pic" }, [icon]),
    el("div", { text: label }),
  ]);
  const go = (): void => {
    run();
    ctx.popover.close();
  };
  reg.listen(item, "click", go);
  reg.listen(item, "keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter" || k === " ") {
      e.preventDefault();
      go();
    }
  });
  return item;
}

function openFileMenu(ctx: AppContext, reg: Disposables, anchor: HTMLElement, row: FileRow): void {
  // The menu's listeners live in a bucket flushed when the popover CLOSES, not in the
  // long-lived results-rows bucket. Otherwise every open/close between row rebuilds would
  // accumulate detached-node listeners (8 per menu) until the next full rebuild.
  const menuReg = reg.child();
  const nodes: HTMLElement[] = [
    menuItem(ctx, menuReg, svgIcon(ICONS.info, { size: 16 }), "Details", () => {
      ctx.toggleDetails(true);
      ctx.focusFile(row.key);
    }),
    menuItem(ctx, menuReg, svgIcon(ICONS.inspect, { size: 16 }), "Inspect (ncdump)", () => {
      void ctx.openInspect(row.file);
    }),
    el("div", { class: "pop-sep" }),
    menuItem(ctx, menuReg, brandIcon("intake", { size: 16 }), "Download Intake (.json)", () =>
      exportSingle(ctx, "intake", row),
    ),
    menuItem(ctx, menuReg, brandIcon("stac", { size: 16 }), "Download STAC (.zip)", () =>
      exportSingle(ctx, "stac", row),
    ),
    menuItem(ctx, menuReg, svgIcon(ICONS.uris, { size: 16 }), "Download URI manifest (.txt)", () =>
      exportSingle(ctx, "uris", row),
    ),
  ];
  // A remote NetCDF/GRIB/HDF file can be fetched directly. This is a REAL anchor, not a click
  // handler: the browser (and the origin server) stream it straight to disk, so the file never
  // passes through JavaScript memory - which is the only way a multi-GB file works at all.
  const href = downloadableUrl(row);
  if (href) {
    nodes.push(el("div", { class: "pop-sep" }));
    nodes.push(
      el(
        "a",
        {
          class: "pop-item",
          role: "menuitem",
          href,
          download: downloadFilename(href),
          // A cross-origin server is free to ignore `download` and serve the file inline. Opening in
          // a new tab means that outcome cannot navigate the app away and lose the user's session.
          target: "_blank",
          rel: "noopener noreferrer",
        },
        [
          el("span", { class: "pic" }, [svgIcon(ICONS.download, { size: 16 })]),
          el("div", { text: "Download source file" }),
        ],
      ),
    );
  }
  ctx.popover.open(anchor, nodes, { placement: "below", onClose: () => menuReg.flush() });
}

function exportSingle(ctx: AppContext, kind: "intake" | "stac" | "uris", row: FileRow): void {
  // one shared, streaming, progress-reporting export path - scoped to this file
  void ctx.exportCatalogue(kind, `file=${encodeURIComponent(row.file)}`);
}

function listRow(ctx: AppContext, reg: Disposables, row: FileRow): HTMLElement {
  const picked = ctx.state.pickedKeys.has(row.key);
  const focused = ctx.state.focusKey === row.key;
  const node = el(
    "div",
    {
      class: `row${picked ? " picked" : ""}${focused ? " focus" : ""}`,
      "data-key": row.key,
      "data-file": row.file,
      tabindex: "0",
    },
    [
      checkbox(ctx, reg, row),
      el("div", { class: "uricell" }, [
        formatTile(row.file),
        el("div", { class: "meta" }, [pathEl(row.file, "path")]),
      ]),
      el("span", { class: "fs", text: row.fsType }),
      kebab(ctx, reg, row),
    ],
  );
  reg.listen(node, "click", () => ctx.focusFile(row.key));
  reg.listen(node, "keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") ctx.focusFile(row.key);
  });
  return node;
}

function gridCard(ctx: AppContext, reg: Disposables, row: FileRow): HTMLElement {
  const picked = ctx.state.pickedKeys.has(row.key);
  const focused = ctx.state.focusKey === row.key;
  const node = el(
    "div",
    {
      class: `gcard${picked ? " picked" : ""}${focused ? " focus" : ""}`,
      "data-key": row.key,
      "data-file": row.file,
      tabindex: "0",
    },
    [
      el("div", { class: "top2" }, [
        checkbox(ctx, reg, row),
        formatTile(row.file),
        el("span", { class: "fs", style: "margin-left:auto", text: row.fsType }),
        kebab(ctx, reg, row),
      ]),
      // ONE value here too. A card may wrap it across lines - it is still one complete path.
      pathEl(row.file, "path gpath"),
    ],
  );
  reg.listen(node, "click", () => ctx.focusFile(row.key));
  reg.listen(node, "keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") ctx.focusFile(row.key);
  });
  return node;
}

function skeleton(): HTMLElement {
  const host = el("div", { class: "skeleton-rows", "aria-hidden": "true" });
  for (let i = 0; i < 6; i++) {
    host.append(
      el("div", { class: "sk-row" }, [
        el("div", { class: "sk", style: "width:30px;height:30px;border-radius:7px" }),
        el("div", { class: "sk", style: "flex:1;height:14px" }),
        el("div", { class: "sk", style: "width:48px;height:14px" }),
      ]),
    );
  }
  return host;
}

function emptyState(ctx: AppContext, reg: Disposables): HTMLElement {
  const clear = el("button", { class: "btn", type: "button", text: "Clear all" });
  reg.listen(clear, "click", () => ctx.clearAllFacets());
  return el("div", { class: "state-msg" }, [
    el("div", { class: "big" }, [svgIcon(ICONS.search, { size: 30 })]),
    el("p", { text: "No files match these facets." }),
    clear,
  ]);
}

function errorState(ctx: AppContext, reg: Disposables): HTMLElement {
  const retry = el("button", { class: "btn", type: "button" }, [
    svgIcon(ICONS.retry, { size: 15 }),
    el("span", { text: "Retry" }),
  ]);
  reg.listen(retry, "click", () => ctx.retrySearch());
  return el("div", { class: "state-msg err" }, [
    el("p", { text: ctx.state.searchError ?? "Search failed." }),
    retry,
  ]);
}

function renderMore(ctx: AppContext, reg: Disposables): void {
  const more = ctx.roots.moreWrap;
  replaceChildren(more);
  // Pagination affordance: explicit manual "Load next 100" with a proportion bar - no
  // scroll-triggered auto-load (that hammers Solr and janks at thousands of rendered rows).
  const shown = ctx.state.rows.length;
  if (!(ctx.state.totalCount > shown && shown > 0)) return;
  const total = ctx.state.totalCount;
  const loading = ctx.state.search === "loading";
  const pct = Math.min(100, Math.max(1, Math.round((shown / total) * 100)));

  const btn = el(
    "button",
    {
      class: "btn load-next",
      type: "button",
      disabled: loading ? "true" : null,
      "aria-label": "Load next 100 results",
    },
    loading
      ? [el("span", { class: "spin", "aria-hidden": "true" }), el("span", { text: "Loading…" })]
      : [el("span", { text: "Load next 100" })],
  );
  reg.listen(btn, "click", () => ctx.loadNextPage());

  const info = el("div", { class: "more-info" }, [
    el("span", {
      text: `Showing ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`,
    }),
    el("span", { class: "more-pct", text: `${pct}%` }),
  ]);
  const bar = el("div", { class: "more-bar" }, [
    el("div", { class: "more-bar-fill", style: `width:${pct}%` }),
  ]);
  more.append(el("div", { class: "more-loader" }, [info, bar, btn]));
}

export function renderResults(ctx: AppContext): void {
  const m = memo(ctx);
  const host = ctx.roots.results;
  const moreReg = ctx.region("results-more");
  ctx.roots.listHead.hidden = true; // shown only for the list view with rows (set below)
  syncSelectAll(ctx);

  const fullRebuild = (): Disposables => {
    m.rowsBucket = ctx.region("results-rows");
    return m.rowsBucket;
  };

  if (ctx.state.search === "loading" && ctx.state.rows.length === 0) {
    fullRebuild();
    m.renderedCount = -1;
    m.view = null;
    host.className = "";
    m.nodes.clear();
    replaceChildren(host, skeleton());
    replaceChildren(ctx.roots.moreWrap);
    return;
  }
  if (ctx.state.search === "error") {
    const reg = fullRebuild();
    m.renderedCount = -1;
    m.view = null;
    host.className = "";
    m.nodes.clear();
    replaceChildren(host, errorState(ctx, reg));
    replaceChildren(ctx.roots.moreWrap);
    return;
  }
  if (
    ctx.state.search === "empty" ||
    (ctx.state.search === "loaded" && ctx.state.rows.length === 0)
  ) {
    const reg = fullRebuild();
    m.renderedCount = -1;
    m.view = null;
    host.className = "";
    m.nodes.clear();
    replaceChildren(host, emptyState(ctx, reg));
    replaceChildren(ctx.roots.moreWrap);
    return;
  }

  const rows = ctx.state.rows;
  const view = ctx.state.view;
  const make = view === "list" ? listRow : gridCard;
  ctx.roots.listHead.hidden = view !== "list"; // rows exist here (loading/empty/error returned above)

  // Incremental append: "load next 100" grows the SAME epoch's list - a pure append, no prefix
  // re-scan. Any reset (new query, filter, flavour) bumps state.rowsEpoch and forces a full
  // rebuild (which also detaches any popover anchored to an old row, closing it). The DOM
  // count must still match, guarding against an out-of-band mutation.
  const canAppend =
    m.view === view &&
    m.rowsBucket !== null &&
    m.epoch === ctx.state.rowsEpoch &&
    m.renderedCount >= 0 &&
    rows.length >= m.renderedCount &&
    host.childElementCount === m.renderedCount;

  if (canAppend) {
    const reg = m.rowsBucket as Disposables;
    if (rows.length > m.renderedCount) {
      const frag = document.createDocumentFragment();
      for (let i = m.renderedCount; i < rows.length; i++) {
        const node = make(ctx, reg, rows[i]);
        m.nodes.set(rows[i].key, node); // keep the index in step with an APPEND, not just a rebuild
        frag.append(node);
      }
      host.append(frag);
      m.renderedCount = rows.length;
    }
    applyManyResults(ctx);
    renderMore(ctx, moreReg);
    return;
  }

  const reg = fullRebuild();
  host.className = view === "list" ? "rows" : "grid";
  // Build into a fragment rather than spreading rows.map(...) as varargs into replaceChildren - a
  // 100k-element spread is a needless allocation + call-stack risk. One fragment, one reflow.
  host.textContent = "";
  m.nodes.clear();
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const node = make(ctx, reg, r);
    m.nodes.set(r.key, node);
    frag.append(node);
  }
  host.append(frag);
  m.renderedCount = rows.length;
  m.view = view;
  m.epoch = ctx.state.rowsEpoch;
  m.focusedKey = ctx.state.focusKey;
  m.atCap = atSelectionCap(ctx);
  applyManyResults(ctx);
  renderMore(ctx, moreReg);
}

/**
 * Flag a large loaded set on the app root. At or above MANY_RESULTS_THRESHOLD the CSS drops the
 * left-sidebar and details-panel WIDTH transitions, so toggling either lays the centre column out
 * ONCE instead of re-flowing every loaded row on every animation frame.
 */
function applyManyResults(ctx: AppContext): void {
  ctx.roots.app.classList.toggle("many-results", ctx.state.rows.length >= MANY_RESULTS_THRESHOLD);
}

/**
 * Patch focus/pick presentation IN PLACE.
 *
 * `changedKeys` names the rows whose PICKED state changed. Given it, this touches only those rows
 * plus the two involved in a focus move - not every rendered row. Omit it for a genuine bulk change
 * (Select all, Clear selection), which is the only case that warrants a full pass; entering or
 * leaving the selection-cap state also forces one, because the cap is a property of every
 * unselected row.
 */
export function updateRowStates(ctx: AppContext, changedKeys?: Iterable<string>): void {
  const m = memo(ctx);
  const capNow = atSelectionCap(ctx);
  // The cap state is a presentational property of EVERY unselected row, so entering or leaving it
  // is the one transition that genuinely needs a full pass. It happens at most twice per selection
  // session, rather than on every click.
  const capChanged = capNow !== m.atCap;
  m.atCap = capNow;

  if (changedKeys === undefined || capChanged) {
    for (const [key, node] of m.nodes) patchRow(ctx, key, node, capNow);
    m.focusedKey = ctx.state.focusKey;
    syncSelectAll(ctx);
    return;
  }

  // The targeted path: only the row that lost focus, the row that gained it, and whichever row's
  // picked state actually changed. Everything else in the list is already correct.
  const touched = new Set<string>(changedKeys);
  if (m.focusedKey && m.focusedKey !== ctx.state.focusKey) touched.add(m.focusedKey);
  if (ctx.state.focusKey) touched.add(ctx.state.focusKey);
  for (const key of touched) {
    const node = m.nodes.get(key);
    if (node) patchRow(ctx, key, node, capNow);
  }
  m.focusedKey = ctx.state.focusKey;
  syncSelectAll(ctx);
}

/** Bring ONE row's classes/aria/glyph in line with state. No DOM queries beyond this node. */
function patchRow(ctx: AppContext, key: string, node: HTMLElement, capNow: boolean): void {
  const picked = ctx.state.pickedKeys.has(key);
  const focused = ctx.state.focusKey === key;
  node.classList.toggle("picked", picked);
  node.classList.toggle("focus", focused);
  const cb = node.querySelector<HTMLElement>(".cb");
  if (!cb) return;
  cb.setAttribute("aria-checked", picked ? "true" : "false");
  const capped = capNow && !picked;
  cb.classList.toggle("capped", capped);
  cb.setAttribute("aria-disabled", capped ? "true" : "false");
  const file = node.dataset.file ?? key; // recorded at build time - never an O(n) lookup here
  cb.setAttribute(
    "aria-label",
    capped
      ? `Select ${file} - unavailable: the ${MAX_SELECTED_FILES}-file selection limit is reached`
      : `Select ${file}`,
  );
  const hasCheck = cb.childElementCount > 0;
  if (picked && !hasCheck) cb.append(svgIcon(ICONS.check, { size: 11 }));
  else if (!picked && hasCheck) cb.textContent = "";
}

/**
 * What the bulk control will DO next, and what it should therefore say.
 *
 * Shared by the control's rendering and by its click handler, so they cannot disagree: with 40 rows
 * loaded and the 25-file cap reached, a button reading "Select all" that clears the selection when
 * activated is a control whose label contradicts its action - worse than no label.
 */
export interface SelectAllPlan {
  /** The rows a "select" action would pick - the first MAX_SELECTED_FILES in result order. */
  target: string[];
  /** More rows are loaded than may be selected, so "all" is not on offer. */
  capped: boolean;
  /** How many listed rows a select action would leave out. */
  omitted: number;
  /** True when the next activation CLEARS rather than selects. */
  willClear: boolean;
  label: string;
  ariaLabel: string;
}

export function selectAllPlan(ctx: AppContext): SelectAllPlan {
  const keys = ctx.state.rows.map((r) => r.key);
  const capped = keys.length > MAX_SELECTED_FILES;
  const target = capped ? keys.slice(0, MAX_SELECTED_FILES) : keys;
  const willClear = target.length > 0 && target.every((k) => ctx.state.pickedKeys.has(k));
  const omitted = keys.length - target.length;
  const count = ctx.state.pickedKeys.size;
  const label = willClear
    ? `Clear ${count} selected`
    : capped
      ? `Select first ${MAX_SELECTED_FILES}`
      : "Select all";
  const ariaLabel = willClear
    ? `Clear the ${count} selected file${count === 1 ? "" : "s"}`
    : capped
      ? `Select the first ${MAX_SELECTED_FILES} of ${keys.length} listed files`
      : "Select all listed files";
  return { target, capped, omitted, willClear, label, ariaLabel };
}

/** Reflect the bulk control: its checkbox state, its visible label and its accessible name all
 *  describe the SAME next action. Disabled when there are no rows. */
export function syncSelectAll(ctx: AppContext): void {
  const btn = ctx.roots.selectAllBtn;
  if (!btn) return;
  const cb = btn.querySelector<HTMLElement>(".cb");
  const lbl = btn.querySelector<HTMLElement>(".ctrl-lbl");
  const total = ctx.state.rows.length;
  let picked = 0;
  for (const r of ctx.state.rows) if (ctx.state.pickedKeys.has(r.key)) picked++;
  const plan = selectAllPlan(ctx);
  // "Checked" means the next activation clears - which is exactly `willClear`, capped or not.
  const all = total > 0 && plan.willClear;
  const some = picked > 0 && !all;
  (btn as HTMLButtonElement).disabled = total === 0;
  if (cb) {
    cb.classList.toggle("on", all);
    cb.classList.toggle("mixed", some);
    cb.textContent = "";
    if (all) cb.append(svgIcon(ICONS.check, { size: 11 }));
  }
  if (lbl) lbl.textContent = plan.label;
  btn.setAttribute("aria-label", plan.ariaLabel);
  btn.setAttribute("aria-checked", all ? "true" : some ? "mixed" : "false");
}
