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
import type { FileRow } from "../types.js";

/** Per-mount render bookkeeping (WeakMap - never module-shared across instances). */
interface RenderMemo {
  /** number of rows currently in the DOM when mode==='rows'; -1 for state screens. */
  renderedCount: number;
  view: "list" | "grid" | null;
  rowsBucket: Disposables | null;
  /** the row epoch (state.rowsEpoch) the DOM currently reflects. The append fast-path is valid ONLY
   *  while the epoch is unchanged - a reset (new query/filter) bumps it and forces a full rebuild.
   *  Comparing epochs keeps "load next" O(1) instead of re-scanning the rendered prefix. */
  epoch: number;
}
const memos = new WeakMap<AppContext, RenderMemo>();
function memo(ctx: AppContext): RenderMemo {
  let m = memos.get(ctx);
  if (!m) {
    m = { renderedCount: -1, view: null, rowsBucket: null, epoch: -1 };
    memos.set(ctx, m);
  }
  return m;
}

function splitPath(file: string): { name: string; dir: string } {
  const i = file.lastIndexOf("/");
  return i < 0 ? { name: file, dir: "" } : { name: file.slice(i + 1), dir: file.slice(0, i + 1) };
}

function checkbox(ctx: AppContext, reg: Disposables, row: FileRow): HTMLElement {
  const picked = ctx.state.pickedKeys.has(row.key);
  const cb = el(
    "span",
    {
      class: "cb",
      role: "checkbox",
      tabindex: "0",
      "aria-checked": picked ? "true" : "false",
      "aria-label": `Select ${row.file}`,
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
  ctx.popover.open(anchor, nodes, { placement: "below", onClose: () => menuReg.flush() });
}

function exportSingle(ctx: AppContext, kind: "intake" | "stac" | "uris", row: FileRow): void {
  // one shared, streaming, progress-reporting export path - scoped to this file
  void ctx.exportCatalogue(kind, `file=${encodeURIComponent(row.file)}`);
}

function listRow(ctx: AppContext, reg: Disposables, row: FileRow): HTMLElement {
  const picked = ctx.state.pickedKeys.has(row.key);
  const focused = ctx.state.focusKey === row.key;
  const { name, dir } = splitPath(row.file);
  const node = el(
    "div",
    {
      class: `row${picked ? " picked" : ""}${focused ? " focus" : ""}`,
      "data-key": row.key,
      tabindex: "0",
    },
    [
      checkbox(ctx, reg, row),
      el("div", { class: "uricell" }, [
        formatTile(row.file),
        el("div", { class: "meta" }, [
          el("div", { class: "name", text: name }),
          dir ? el("div", { class: "dir", text: dir }) : null,
        ]),
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
  const { name, dir } = splitPath(row.file);
  const node = el(
    "div",
    {
      class: `gcard${picked ? " picked" : ""}${focused ? " focus" : ""}`,
      "data-key": row.key,
      tabindex: "0",
    },
    [
      el("div", { class: "top2" }, [
        checkbox(ctx, reg, row),
        formatTile(row.file),
        el("span", { class: "fs", style: "margin-left:auto", text: row.fsType }),
        kebab(ctx, reg, row),
      ]),
      el("div", { class: "name", text: name }),
      // Show the directory here too, matching the list view. The full path stays in the DOM so it's
      // copyable/readable; CSS truncates it and the title carries the whole path.
      dir ? el("div", { class: "dir", title: row.file, text: dir }) : null,
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
    replaceChildren(host, skeleton());
    replaceChildren(ctx.roots.moreWrap);
    return;
  }
  if (ctx.state.search === "error") {
    const reg = fullRebuild();
    m.renderedCount = -1;
    m.view = null;
    host.className = "";
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
      for (let i = m.renderedCount; i < rows.length; i++) frag.append(make(ctx, reg, rows[i]));
      host.append(frag);
      m.renderedCount = rows.length;
    }
    renderMore(ctx, moreReg);
    return;
  }

  const reg = fullRebuild();
  host.className = view === "list" ? "rows" : "grid";
  // Build into a fragment rather than spreading rows.map(...) as varargs into replaceChildren - a
  // 100k-element spread is a needless allocation + call-stack risk. One fragment, one reflow.
  host.textContent = "";
  const frag = document.createDocumentFragment();
  for (const r of rows) frag.append(make(ctx, reg, r));
  host.append(frag);
  m.renderedCount = rows.length;
  m.view = view;
  m.epoch = ctx.state.rowsEpoch;
  renderMore(ctx, moreReg);
}

/**
 * Patch focus/pick presentation IN PLACE: clicking a row or toggling its checkbox
 * must not rebuild hundreds of row nodes. Updates .focus/.picked classes, aria-checked,
 * and the checkbox glyph on every rendered row. Selection is unlimited - no at-cap state.
 */
export function updateRowStates(ctx: AppContext): void {
  ctx.roots.results.querySelectorAll<HTMLElement>("[data-key]").forEach((node) => {
    const key = node.dataset.key ?? "";
    const picked = ctx.state.pickedKeys.has(key);
    const focused = ctx.state.focusKey === key;
    node.classList.toggle("picked", picked);
    node.classList.toggle("focus", focused);
    const cb = node.querySelector<HTMLElement>(".cb");
    if (!cb) return;
    cb.setAttribute("aria-checked", picked ? "true" : "false");
    const hasCheck = cb.childElementCount > 0;
    if (picked && !hasCheck) cb.append(svgIcon(ICONS.check, { size: 11 }));
    else if (!picked && hasCheck) cb.textContent = "";
  });
  syncSelectAll(ctx);
}

/** Reflect the Select-all control: checked when every LOADED row is picked, a dash when some are,
 *  empty when none. Also flips the label and disables it when there are no rows. */
export function syncSelectAll(ctx: AppContext): void {
  const btn = ctx.roots.selectAllBtn;
  if (!btn) return;
  const cb = btn.querySelector<HTMLElement>(".cb");
  const lbl = btn.querySelector<HTMLElement>(".ctrl-lbl");
  const total = ctx.state.rows.length;
  let picked = 0;
  for (const r of ctx.state.rows) if (ctx.state.pickedKeys.has(r.key)) picked++;
  const all = total > 0 && picked === total;
  const some = picked > 0 && !all;
  (btn as HTMLButtonElement).disabled = total === 0;
  if (cb) {
    cb.classList.toggle("on", all);
    cb.classList.toggle("mixed", some);
    cb.textContent = "";
    if (all) cb.append(svgIcon(ICONS.check, { size: 11 }));
  }
  if (lbl) lbl.textContent = all ? "Deselect all" : "Select all";
}
