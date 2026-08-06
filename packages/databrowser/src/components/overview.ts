// components/overview.ts - the metadata-focused facet grid. A full-width responsive grid of cards.
// Each card supports: per-block value SORT (count/alpha), individual COLLAPSE, a size cycle
// (1->2->3 columns), and drag-by-header REORDER. Primary facets show by default; "Show additional
// facets" reveals the rest. Counts come from the last search/recount (overviewStale marks a failed
// recount). All text via textContent.
//
// Value lists render incrementally via appendChunked; the per-card "filter within" and sort
// re-render the derived list (chunked again) with a fresh child bucket so listeners never accumulate.

import type { AppContext } from "../context.js";
import { appendChunked, el, replaceChildren, svgIcon, type Disposables } from "../dom.js";
import { ICONS } from "../icons.js";
import {
  describeValue,
  displayFacetValues,
  isGatedValue,
  isSelected,
  overviewFacets,
} from "../state.js";
import { buildTimeEditor } from "./timeEditor.js";
import { buildBboxEditor } from "./bboxEditor.js";
import { saveOverviewPrefs } from "../theme.js";
import type { Facet, FacetValue } from "../types.js";

const VALUE_CHUNK = 60;

/** Persist the metadata-view block choices, alongside the theme/layout preferences. */
function persist(ctx: AppContext): void {
  saveOverviewPrefs({
    sort: ctx.state.overviewSort,
    collapsed: [...ctx.state.overviewCollapsed],
    span: ctx.state.overviewSpan,
    h: ctx.state.overviewH, // rows per card (1 or 2)
    order: ctx.state.overviewOrder,
    addOpen: ctx.state.overviewAddOpen,
    stacked: ctx.state.overviewStacked,
    stackSeen: ctx.state.overviewStackSeen,
    snapshot: ctx.state.overviewSnapshot,
  });
}

/** The whole block header acts as a collapse/expand toggle (a big, obvious target), in EVERY
 *  state: stacked, normal, resized. Clicks on the header's own controls (drag grip, clear badge,
 *  sort, reset, the chevron) keep doing their own thing; only a click on the header body toggles. */
function wireHeadToggle(ctx: AppContext, reg: Disposables, head: HTMLElement, key: string): void {
  head.classList.add("clickable");
  reg.listen(head, "click", (e) => {
    if ((e.target as HTMLElement).closest('button, .drag-grip, [role="button"]')) return;
    // Don't toggle when the user was actually selecting header text (a click that ends a
    // text selection still fires here). Collapsing out from under a selection is jarring.
    const sel = head.ownerDocument.getSelection?.();
    if (sel && !sel.isCollapsed && head.contains(sel.anchorNode)) return;
    if (ctx.state.overviewCollapsed.has(key)) ctx.state.overviewCollapsed.delete(key);
    else ctx.state.overviewCollapsed.add(key);
    persist(ctx);
    ctx.renderOverview();
  });
}
// Horizontal: a card can be widened, block by block, to the FULL width of the grid.
// The real cap is the number of columns the page currently shows, read from the grid at drag time.
const MAX_SPAN = 24;
const clampSpan = (n: number): number => Math.min(MAX_SPAN, Math.max(1, n));
// Real browsers resolve gridTemplateColumns to a space-separated list of pixel tracks, so counting
// them gives the live column count. A DOM that does no layout (jsdom) returns the declaration
// verbatim instead, so the count there follows the CSS source text rather than the grid.
// tokens gives the live column count. jsdom returns the SPECIFIED value instead, so the .facet-grid
// `grid-template-columns` must stay at three space-separated tokens (repeat(...) minmax(...) …) - e.g.
// keep any min()/clamp() commas SPACE-FREE - or this count (and resize snapping) drifts under test.
const gridCols = (host: HTMLElement): number =>
  Math.max(1, getComputedStyle(host).gridTemplateColumns.split(" ").filter(Boolean).length);
// Resizing snaps to BLOCKS, never to arbitrary pixels: width snaps to whole grid columns, height
// to whole grid rows - and at most ONE extra row down, so the grid can never be dragged into one
// tall ragged column.
const MAX_ROWS = 2;
const clampRows = (n: number): number => Math.min(MAX_ROWS, Math.max(1, n));
const spanOf = (card: HTMLElement): number =>
  clampSpan(parseInt(card.style.gridColumn.replace("span ", ""), 10) || 1);

// Handles can be operated with a pointer OR the keyboard. A reorderable card's grip is a real button
// (focusable, arrow-keys move it); a special card (__time/__bbox) can't reorder, so its grip stays
// decorative. The resize corner is always a button (facets AND specials resize).
function gripEl(label: string, reorderable: boolean): HTMLElement {
  // A special card (__time/__bbox) can't be reordered, so its grip is a purely decorative glyph with
  // NO "drag to reorder" affordance - advertising a gesture that can't work only invites a dead drag.
  if (!reorderable)
    return el("span", {
      class: "drag-grip drag-grip-fixed",
      "aria-hidden": "true",
      text: "\u283f",
    });
  return el("button", {
    class: "drag-grip",
    type: "button",
    title: "Drag, or focus and use ← → to reorder",
    "aria-label": `Reorder ${label} - use the arrow keys`,
    text: "\u283f",
  });
}
function resizeEl(label: string): HTMLElement {
  return el("button", {
    class: "fcard-resize",
    type: "button",
    title: "Drag, or focus and use arrow keys to resize",
    "aria-label": `Resize ${label} - ← → change width, ↑ ↓ change height`,
  });
}
// After a keyboard action the grid is rebuilt, destroying the focused handle. Remember what to
// re-focus (per mount) and restore it once the new grid is in the DOM.
const pendingFocus = new WeakMap<AppContext, { key: string; handle: "grip" | "resize" } | null>();
function focusHandleAfterRender(ctx: AppContext): void {
  const want = pendingFocus.get(ctx);
  if (!want) return;
  pendingFocus.set(ctx, null);
  const sel = want.handle === "grip" ? ".drag-grip" : ".fcard-resize";
  for (const c of Array.from(
    ctx.roots.overviewGrid.querySelectorAll<HTMLElement>(".fcard[data-key]"),
  )) {
    if (c.dataset.key === want.key) {
      c.querySelector<HTMLElement>(sel)?.focus();
      break;
    }
  }
}
function reorderByKeyboard(ctx: AppContext, host: HTMLElement, key: string, dir: -1 | 1): void {
  if (key.startsWith("__")) return; // specials aren't reorderable
  const keys = Array.from(host.querySelectorAll<HTMLElement>(".fcard[data-key]"))
    .map((c) => c.dataset.key ?? "")
    .filter((k) => k && !k.startsWith("__"));
  const i = keys.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= keys.length) return;
  [keys[i], keys[j]] = [keys[j], keys[i]];
  ctx.state.overviewOrder = keys;
  pendingFocus.set(ctx, { key, handle: "grip" });
  persist(ctx);
  ctx.renderOverview();
}
function resizeByKeyboard(ctx: AppContext, key: string, dSpan: number, dRows: number): void {
  const curSpan = ctx.state.overviewSpan[key] ?? 1;
  const curRows = ctx.state.overviewH[key] ?? 1;
  const span = clampSpan(curSpan + dSpan);
  const rows = clampRows(curRows + dRows);
  if (span === curSpan && rows === curRows) return; // clamped at the min/max - no change, don't persist
  ctx.state.overviewSpan[key] = span;
  ctx.state.overviewH[key] = rows;
  pendingFocus.set(ctx, { key, handle: "resize" });
  persist(ctx);
  ctx.renderOverview();
}

// While stacked, a facet that ARRIVES after Stack should collapse by default - but a facet the user
// deliberately expands must STAY expanded, including across reloads. `overviewStackSeen` records the
// facets this stacked session already knows about: anything NOT in it is a genuine new arrival and
// gets collapsed once; anything already in it is left to the (persisted) collapsed set. That's what
// separates "new facet -> collapse" from "user expanded this one -> keep it open".
function reconcileStacked(ctx: AppContext, facetKeys: string[]): void {
  if (!ctx.state.overviewStacked) return;
  const seen = new Set(ctx.state.overviewStackSeen);
  let changed = false;
  for (const k of [...facetKeys, "__time", "__bbox"]) {
    if (!seen.has(k)) {
      seen.add(k);
      ctx.state.overviewCollapsed.add(k);
      changed = true;
    }
  }
  if (changed) {
    ctx.state.overviewStackSeen = [...seen];
    persist(ctx);
  }
}

/**
 * ONE mouse-based controller for the metadata grid, wired once on the stable host. NO native
 * HTML5 drag - it hijacks the resize gesture and blocks the card's inputs:
 *   • drag the ⠿ grip  -> reorder blocks (live DOM move, order committed on mouseup)
 *   • drag the corner  -> resize the block's column span, snapped to the grid
 * Both start only from their own handle, so value rows, the filter box and buttons stay clickable.
 */
function wireDrag(ctx: AppContext, host: HTMLElement): void {
  let mode: "reorder" | "resize" | null = null;
  let card: HTMLElement | null = null;
  let rez: {
    startX: number;
    startY: number;
    startSpan: number;
    startRows: number;
    pitch: number;
    rowPitch: number;
    maxSpan: number;
  } | null = null;

  ctx.dis.listen(host, "mousedown", (e) => {
    const me = e as MouseEvent;
    const target = me.target as HTMLElement;
    const c = target.closest(".fcard") as HTMLElement | null;
    if (!c) return;
    if (target.closest(".fcard-resize")) {
      const span = spanOf(c);
      const r = c.getBoundingClientRect();
      mode = "resize";
      card = c;
      // how many columns does the grid actually have? a card can grow to the end of its row and no
      // further ("until the last block on the row that has space").
      const cols = gridCols(host);
      const rows = clampRows(Number(c.dataset.rows) || 1);
      rez = {
        startX: me.clientX,
        startY: me.clientY,
        startSpan: span,
        startRows: rows,
        pitch: Math.max(120, r.width / span),
        rowPitch: Math.max(120, r.height / rows),
        maxSpan: cols,
      };
      c.classList.add("resizing");
      document.body.classList.add("fdb-dragging");
      me.preventDefault();
    } else if (target.closest(".drag-grip") && !(c.dataset.key ?? "").startsWith("__")) {
      mode = "reorder";
      card = c;
      c.classList.add("dragging");
      document.body.classList.add("fdb-dragging");
      me.preventDefault();
    }
  });

  ctx.dis.listen(window, "mousemove", (e) => {
    if (!card) return;
    const me = e as MouseEvent;
    if (mode === "resize" && rez) {
      // snap to whole COLUMNS, capped by the columns the grid actually has
      const dx = Math.round((me.clientX - rez.startX) / rez.pitch);
      const nextSpan = Math.min(rez.maxSpan, clampSpan(rez.startSpan + dx));
      card.style.gridColumn = `span ${nextSpan}`;
      card.classList.toggle("wide", nextSpan > 1); // multi-column value list once there's room
      // snap to whole BLOCKS - one extra block down at most
      const dy = Math.round((me.clientY - rez.startY) / rez.rowPitch);
      card.dataset.rows = String(clampRows(rez.startRows + dy));
    } else if (mode === "reorder") {
      const under = card.ownerDocument.elementFromPoint(
        me.clientX,
        me.clientY,
      ) as HTMLElement | null;
      const over = under?.closest(".fcard") as HTMLElement | null;
      if (over && over !== card && over.parentElement === host) {
        const r = over.getBoundingClientRect();
        const after = me.clientX > r.left + r.width / 2;
        host.insertBefore(card, after ? over.nextSibling : over);
      }
    }
  });

  const end = (): void => {
    if (!card) return;
    if (mode === "resize") {
      const key = card.dataset.key;
      if (key) {
        ctx.state.overviewSpan[key] = spanOf(card);
        ctx.state.overviewH[key] = clampRows(Number(card.dataset.rows) || 1);
      }
      card.classList.remove("resizing");
    } else if (mode === "reorder") {
      card.classList.remove("dragging");
      ctx.state.overviewOrder = Array.from(host.querySelectorAll<HTMLElement>(".fcard[data-key]"))
        .map((c) => c.dataset.key ?? "")
        .filter((k) => k && !k.startsWith("__"));
    }
    document.body.classList.remove("fdb-dragging");
    mode = null;
    card = null;
    rez = null;
    persist(ctx);
    ctx.renderOverview();
  };
  ctx.dis.listen(window, "mouseup", end);
  // Keyboard equivalents of the two gestures (accessibility): a focused grip reorders with ← ->; a
  // focused resize corner changes width (← ->) and height (↑ ↓). One delegated listener on the host.
  ctx.dis.listen(host, "keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.altKey || ke.ctrlKey || ke.metaKey) return;
    const t = ke.target as HTMLElement;
    const card = t.closest<HTMLElement>(".fcard[data-key]");
    if (!card) return;
    const key = card.dataset.key ?? "";
    if (t.closest(".drag-grip")) {
      const dir =
        ke.key === "ArrowLeft" || ke.key === "ArrowUp"
          ? -1
          : ke.key === "ArrowRight" || ke.key === "ArrowDown"
            ? 1
            : 0;
      if (!dir) return;
      ke.preventDefault();
      reorderByKeyboard(ctx, host, key, dir as -1 | 1);
    } else if (t.closest(".fcard-resize")) {
      const dSpan = ke.key === "ArrowRight" ? 1 : ke.key === "ArrowLeft" ? -1 : 0;
      const dRows = ke.key === "ArrowUp" ? 1 : ke.key === "ArrowDown" ? -1 : 0;
      if (!dSpan && !dRows) return;
      ke.preventDefault();
      resizeByKeyboard(ctx, key, dSpan, dRows);
    }
  });
  // If the widget is destroyed mid-drag, the window 'mouseup' that clears the global cursor
  // lock never fires. Undo it on teardown, but ONLY when THIS instance owns the active drag, so one
  // mount's destroy can't wipe another mount's in-flight gesture.
  ctx.dis.add(() => {
    if (!card) return;
    card.classList.remove("resizing", "dragging");
    document.body.classList.remove("fdb-dragging");
    mode = null;
    card = null;
    rez = null;
  });
}
const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * The bar is the value's SHARE OF THE WHOLE RESULT SET (count / totalCount) - not its size relative
 * to the biggest value in its own card.
 *
 * That distinction matters: a per-card scale would make every card's top value a full bar, so
 * `historical` (17% of all results) and `cmip6` (56%) would both look "full" and the cards could
 * not be compared with one another. A share of the total is the same measure everywhere, so bars
 * mean the same thing in every card.
 *
 * Costs nothing: the count is already in the search response, and the bar is drawn with a CSS
 * pseudo-element (no extra DOM node at all).
 */
function valueRow(
  ctx: AppContext,
  reg: Disposables,
  facet: Facet,
  value: string,
  count: number,
): HTMLButtonElement {
  const sel = isSelected(ctx.state, facet.key, value);
  const gated = isGatedValue(ctx.state, facet.key, value); // part of the locked base scope
  const desc = describeValue(ctx.state, facet.key, value);
  const row = el(
    "button",
    {
      class: `fval${sel ? " sel" : ""}${gated ? " locked" : ""}`,
      type: "button",
      role: "checkbox",
      "aria-checked": sel ? "true" : "false",
      "aria-disabled": gated ? "true" : "false",
      "aria-label": gated ? `${facet.label}: ${value} (locked scope)` : `${facet.label}: ${value}`,
      "data-val": value.toLowerCase(),
      title: gated
        ? `${value} - this instance is scoped to this value`
        : shareTitle(ctx, value, count, desc),
    },
    [
      el("span", { class: "cb" }, sel ? [svgIcon(ICONS.check, { size: 11 })] : []),
      el("span", { class: "nm", text: value }),
      el("span", { class: "n", text: fmt(count) }),
    ],
  );
  const pct = sharePct(ctx, count);
  if (pct !== null) {
    row.classList.add("has-bar");
    row.style.setProperty("--pct", `${pct}%`); // drawn by ::before - no extra element
  }
  if (!gated) reg.listen(row, "click", () => ctx.toggleFacet(facet.key, value)); // the gate can't be toggled
  return row;
}

/**
 * A value's share of the whole result set, 0–100. Returns null when there is no total to divide by.
 * Clamped at 100: a multi-valued facet (a file has many variables) can report counts that sum to
 * more than the result set, and a bar past the end of its track would just be wrong.
 */
function sharePct(ctx: AppContext, count: number): number | null {
  const total = ctx.state.totalCount;
  if (!total || total <= 0) return null;
  return Math.min(100, (count / total) * 100);
}

function shareTitle(ctx: AppContext, value: string, count: number, desc: string | null): string {
  const pct = sharePct(ctx, count);
  const share =
    pct === null
      ? ""
      : ` - ${count.toLocaleString("en-US")} (${pct < 0.1 ? "<0.1" : pct.toFixed(1)}% of results)`;
  return desc ? `${value} - ${desc}${share}` : `${value}${share}`;
}

/** Sorted copy of a facet's values per the block's sort choice (default: count desc). */
function sortedValues(ctx: AppContext, facet: Facet): FacetValue[] {
  const mode = ctx.state.overviewSort[facet.key] ?? "count";
  const vs = displayFacetValues(ctx.state, facet).slice(); // gated key -> scope values only
  if (mode === "alpha") vs.sort((a, b) => a.value.localeCompare(b.value));
  else vs.sort((a, b) => b.count - a.count);
  return vs;
}

function iconBtn(
  icon: string,
  label: string,
  on: boolean,
  run: (e: Event) => void,
  reg: Disposables,
): HTMLButtonElement {
  const b = el(
    "button",
    {
      class: `exp${on ? " on" : ""}`,
      type: "button",
      "aria-pressed": on ? "true" : "false",
      "aria-label": label,
      title: label,
    },
    [svgIcon(icon, { size: 14 })],
  );
  reg.listen(b, "click", (e) => {
    e.stopPropagation();
    run(e);
  });
  return b;
}

/**
 * Sort control. An icon alone can't say which way the list is ordered, so the button
 * shows the icon AND its current mode ("A–Z" / "9–1") - the two orderings that make sense for
 * facet values (alphabetical, and by count descending).
 */
function sortBtn(
  ctx: AppContext,
  reg: Disposables,
  key: string,
  mode: "count" | "alpha",
): HTMLButtonElement {
  const isAlpha = mode === "alpha";
  const b = el(
    "button",
    {
      class: "exp sortbtn",
      type: "button",
      "aria-label": isAlpha
        ? "Sorted A–Z - switch to sorting by count"
        : "Sorted by count - switch to A–Z",
      title: isAlpha ? "Sorted A–Z (click: by count)" : "Sorted by count (click: A–Z)",
    },
    [
      svgIcon(isAlpha ? ICONS.sortAlpha : ICONS.sortCount, { size: 14 }),
      el("span", { class: "sortlbl", text: isAlpha ? "A–Z" : "Count" }),
    ],
  );
  reg.listen(b, "click", (e) => {
    e.stopPropagation();
    ctx.state.overviewSort[key] = isAlpha ? "count" : "alpha";
    persist(ctx);
    ctx.renderOverview();
  });
  return b;
}

function facetCard(ctx: AppContext, reg: Disposables, facet: Facet): HTMLElement {
  const s = ctx.state;
  const nsel = (s.selected[facet.key] ?? []).length;
  const collapsed = s.overviewCollapsed.has(facet.key);
  const span = Math.min(MAX_SPAN, Math.max(1, s.overviewSpan[facet.key] ?? 1));
  const sortMode = s.overviewSort[facet.key] ?? "count";

  const rows = clampRows(s.overviewH[facet.key] ?? 1);
  const card = el("div", {
    class: `fcard${collapsed ? " collapsed" : ""}${span > 1 ? " wide" : ""}`,
    "data-key": facet.key,
  });
  card.style.gridColumn = `span ${span}`;
  card.dataset.rows = String(collapsed ? 1 : rows); // CSS turns this into 1 or 2 block heights

  const head = el("div", { class: `fcard-h${nsel ? " active" : ""}` }, [
    gripEl(facet.label, true),
    el("span", { class: "fh-label", text: facet.label }),
  ]);
  if (nsel) {
    // Same "clear this facet" affordance as the sidebar: hover -> red × (CSS), click clears the
    // facet. stopPropagation guards any header-level handler (drag/collapse).
    const clearBadge = el("span", {
      class: "fh-count",
      role: "button",
      tabindex: "0",
      title: `Clear ${facet.label} filter`,
      "aria-label": `Clear ${facet.label} filter - ${nsel} selected`,
      text: String(nsel),
    });
    reg.listen(clearBadge, "click", (e) => {
      e.stopPropagation();
      ctx.clearFacet(facet.key);
    });
    reg.listen(clearBadge, "keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === "Enter" || k === " ") {
        e.preventDefault();
        e.stopPropagation();
        ctx.clearFacet(facet.key);
      }
    });
    head.append(clearBadge);
  }
  head.append(
    el("span", {
      class: "badge",
      text: facet.hasMore ? `${facet.values.length}+` : String(facet.values.length),
    }),
  );

  head.append(sortBtn(ctx, reg, facet.key, sortMode));
  // RESET SIZE: free 2-D resizing makes a "maximize" toggle redundant, but without
  // this there is no way BACK to the default. Only offered when the card is actually off-default.
  if (span !== 1 || rows !== 1) {
    head.append(
      iconBtn(
        ICONS.reset,
        "Reset size",
        false,
        () => {
          delete s.overviewSpan[facet.key];
          delete s.overviewH[facet.key];
          persist(ctx);
          ctx.renderOverview();
        },
        reg,
      ),
    );
  }
  const collapseBtn = iconBtn(
    collapsed ? ICONS.chevron : ICONS.minimize,
    collapsed ? "Expand" : "Minimize",
    collapsed,
    () => {
      if (collapsed) s.overviewCollapsed.delete(facet.key);
      else s.overviewCollapsed.add(facet.key);
      persist(ctx);
      ctx.renderOverview();
    },
    reg,
  );
  collapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true"); // expose the collapse state to AT
  head.append(collapseBtn);
  wireHeadToggle(ctx, reg, head, facet.key);

  card.append(head);
  if (collapsed) {
    card.append(resizeEl(facet.label));
    return card;
  }

  const within = el("input", {
    class: "within",
    type: "text",
    placeholder: `filter ${facet.label.toLowerCase()}…`,
    value: s.overviewFilters[facet.key] ?? "",
    "aria-label": `Filter ${facet.label}`,
  });
  const vals = el("div", { class: "fcard-vals" });

  // A known facet that matches nothing in the current query keeps its block, shown as an honest
  // zero-state. No filter box (there's nothing to filter), no crash - the layout stays put.
  if (facet.values.length === 0) {
    card.append(el("div", { class: "fcard-empty", text: "No values in this selection." }));
    card.append(resizeEl(facet.label));
    return card;
  }
  let valsBucket: Disposables | null = null;
  const renderVals = (): void => {
    valsBucket?.flush();
    valsBucket = reg.child();
    const q = (s.overviewFilters[facet.key] ?? "").toLowerCase();
    const base = sortedValues(ctx, facet);
    const list = q ? base.filter((v) => v.value.toLowerCase().includes(q)) : base;
    replaceChildren(vals);
    const bucket = valsBucket;
    appendChunked(
      bucket,
      vals,
      list.length,
      (i) => valueRow(ctx, bucket, facet, list[i].value, list[i].count),
      VALUE_CHUNK,
    );
    if (q && list.length === 0)
      vals.append(el("div", { class: "fmore", text: "No values match." }));
    if (!q && facet.hasMore) {
      /* the "N+" count in the header already signals there are more */
    }
  };
  reg.listen(within, "input", () => {
    s.overviewFilters[facet.key] = within.value;
    renderVals();
  });
  card.append(within, vals);
  card.append(resizeEl(facet.label));
  renderVals();
  return card;
}

/**
 * Time / BBox cards.
 *
 * They wear the SAME chrome as every facet card (grip, label, state badge, reset, minimize) and
 * always show their editor inline, sized to fit the card rather than needing a drag - so the map
 * and the time picker are visible by default instead of hiding until the card is sized up.
 */
function specialCard(ctx: AppContext, reg: Disposables, kind: "time" | "bbox"): HTMLElement {
  const s = ctx.state;
  const isTime = kind === "time";
  const key = isTime ? "__time" : "__bbox";
  const spLabel = isTime ? "Time range" : "Bounding box";
  const set = isTime ? s.time : s.bbox;
  const collapsed = s.overviewCollapsed.has(key);
  const span = clampSpan(s.overviewSpan[key] ?? 1);
  const rows = clampRows(s.overviewH[key] ?? 1);

  const card = el("div", {
    class: `fcard fcard-sp${collapsed ? " collapsed" : ""}${span > 1 ? " wide" : ""}`,
    "data-key": key,
  });
  card.style.gridColumn = `span ${span}`;
  card.dataset.rows = String(collapsed ? 1 : rows);

  // the same header the facet cards have - that's what makes them read as one family
  const head = el("div", { class: `fcard-h${set ? " active" : ""}` }, [
    gripEl(spLabel, false),
    svgIcon(isTime ? ICONS.clock : ICONS.box, { size: 14 }),
    el("span", { class: "fh-label", text: spLabel }),
  ]);
  // a "state" badge in place of the value count: set / not set
  head.append(el("span", { class: `badge${set ? " on" : ""}`, text: set ? "set" : "any" }));
  if (span !== 1 || rows !== 1) {
    head.append(
      iconBtn(
        ICONS.reset,
        "Reset size",
        false,
        () => {
          delete s.overviewSpan[key];
          delete s.overviewH[key];
          persist(ctx);
          ctx.renderOverview();
        },
        reg,
      ),
    );
  }
  const spCollapse = iconBtn(
    collapsed ? ICONS.chevron : ICONS.minimize,
    collapsed ? "Expand" : "Minimize",
    collapsed,
    () => {
      if (collapsed) s.overviewCollapsed.delete(key);
      else s.overviewCollapsed.add(key);
      persist(ctx);
      ctx.renderOverview();
    },
    reg,
  );
  spCollapse.setAttribute("aria-expanded", collapsed ? "false" : "true"); // collapse state for AT
  head.append(spCollapse);
  wireHeadToggle(ctx, reg, head, key);
  card.append(head);

  if (collapsed) {
    card.append(resizeEl(spLabel));
    return card;
  }

  // The editor is always inline: gating it on span >= 2 would leave these cards looking empty.
  // The map/time picker scale to the card via CSS rather than being cut off.
  const body = el("div", { class: `fcard-special-body ${isTime ? "time-body" : "bbox-body"}` });
  if (isTime) {
    body.append(buildTimeEditor(ctx, reg.child(), () => ctx.renderOverview(), true));
  } else {
    // Known limitation: the editor, incl. any Leaflet map the user upgrades to via "Zoom", is owned
    // by reg.child(), a PER-RENDER region. The next full overview rebuild (a settled search, a
    // collapse, a sort, a resize) flushes it, so an explicit Zoom reverts to the SVG. Making Zoom
    // STICK needs the map instance owned by something longer-lived than the render region and its
    // DOM node re-attached across rebuilds (the map.ts pattern). The SVG picker is correct and
    // instant and Leaflet stays gesture-gated, so re-loading it on every rebuild is the worse trade.
    const { editor, dispose } = buildBboxEditor(ctx, reg.child(), () => ctx.renderOverview(), {
      inline: true,
    });
    reg.add(dispose);
    body.append(editor);
  }
  card.append(body);
  card.append(resizeEl(spLabel));
  return card;
}

/** Order the visible facets by the persisted drag order, unknown keys keeping their natural order. */
function ordered(ctx: AppContext, facets: Facet[]): Facet[] {
  const order = ctx.state.overviewOrder;
  if (order.length === 0) return facets;
  const rank = new Map(order.map((k, i) => [k, i]));
  return facets.slice().sort((a, b) => (rank.get(a.key) ?? 1e6) - (rank.get(b.key) ?? 1e6));
}

/** Toggle the "stacked" overview.
 *  • Stack (on): every block minimized to a full-width row (a compact accordion). The user expands
 *    them one at a time; width stays full via the `.stacked` grid, not via per-card spans.
 *  • Unstack (off): restore the pre-stack layout, clearing the collapse/size state the stack
 *    introduced so none of it sticks. */
export function toggleStack(ctx: AppContext): void {
  const s = ctx.state;
  const on = !s.overviewStacked;
  s.overviewStacked = on;
  if (on) {
    // Capture the current layout so Unstack can put it back exactly. Collapse EVERY block that
    // exists in state (not just the ones currently mounted), so additional/late-arriving facets
    // are stacked too rather than appearing full-width but expanded.
    s.overviewSnapshot = {
      collapsed: [...s.overviewCollapsed],
      span: { ...s.overviewSpan },
      h: { ...s.overviewH },
    };
    for (const f of s.facets) if (f.values.length) s.overviewCollapsed.add(f.key);
    s.overviewCollapsed.add("__time");
    s.overviewCollapsed.add("__bbox");
    // Everything present at Stack time is "known" - only facets that appear LATER auto-collapse.
    s.overviewStackSeen = [
      ...s.facets.filter((f) => f.values.length).map((f) => f.key),
      "__time",
      "__bbox",
    ];
  } else {
    // restore the pre-stack layout verbatim; only fall back to a plain expand-all (keeping sizes)
    // if we somehow have no snapshot (e.g. reloaded straight into a stacked layout).
    const snap = s.overviewSnapshot;
    if (snap) {
      s.overviewCollapsed = new Set(snap.collapsed);
      s.overviewSpan = { ...snap.span };
      s.overviewH = { ...snap.h };
    } else {
      s.overviewCollapsed.clear();
    }
    s.overviewSnapshot = null;
    s.overviewStackSeen = [];
  }
  persist(ctx);
  renderOverview(ctx);
}

export function renderOverview(ctx: AppContext): void {
  const reg = ctx.region("overview");
  const cap = ctx.roots.overviewWrap.querySelector(".overview-cap");
  if (cap) {
    const stale = cap.querySelector(".stale-pill");
    if (ctx.state.overviewStale && !stale) {
      cap.append(
        el("span", {
          class: "stale-pill",
          title:
            "The last attempt to refresh the facet counts failed, so these numbers may be from an earlier query. They update on the next successful search.",
          text: "counts may be stale",
        }),
      );
    } else if (!ctx.state.overviewStale && stale) {
      stale.remove();
    }
  }

  const host = ctx.roots.overviewGrid;
  host.classList.toggle("stacked", ctx.state.overviewStacked); // single-column accordion
  if (!host.dataset.rzwired) {
    host.dataset.rzwired = "1";
    wireDrag(ctx, host);
  }
  const primarySet = new Set(ctx.state.primaryFacets);
  const shown = overviewFacets(ctx.state); // keep known blocks even when they match nothing now
  reconcileStacked(
    ctx,
    shown.map((f) => f.key),
  );
  const primary = primarySet.size ? shown.filter((f) => primarySet.has(f.key)) : shown;
  const additional = primarySet.size ? shown.filter((f) => !primarySet.has(f.key)) : [];

  const cards: HTMLElement[] = [];
  for (const f of ordered(ctx, primary)) cards.push(facetCard(ctx, reg, f));
  // Time and BBox sit RIGHT AFTER the primary facets, in the same flow - they are just two more
  // blocks. Appending them after the full-width "additional facets" row is what exiles them to a
  // lonely strip at the bottom.
  cards.push(specialCard(ctx, reg, "time"));
  cards.push(specialCard(ctx, reg, "bbox"));

  // "Show additional facets": reveal non-primary blocks here too.
  if (additional.length) {
    if (ctx.state.overviewAddOpen) {
      for (const f of ordered(ctx, additional)) cards.push(facetCard(ctx, reg, f));
    }
    const addBtn = el(
      "button",
      {
        class: "ov-addbtn",
        type: "button",
        "aria-expanded": ctx.state.overviewAddOpen ? "true" : "false",
      },
      [
        el("span", {
          text: ctx.state.overviewAddOpen
            ? "Hide additional facets"
            : `Show additional facets (${additional.length})`,
        }),
      ],
    );
    reg.listen(addBtn, "click", () => {
      ctx.state.overviewAddOpen = !ctx.state.overviewAddOpen;
      persist(ctx);
      ctx.renderOverview();
    });
    // the button spans the whole grid on its own row
    const addRow = el("div", { class: "ov-addrow" }, [addBtn]);
    cards.push(addRow);
  }

  replaceChildren(host, ...cards);
  focusHandleAfterRender(ctx); // keyboard reorder/resize rebuilds the grid - return focus to the handle
}

/**
 * Patch the selection highlight in place after a facet toggle. Counts don't change until the
 * search settles, so a toggle must not tear down and rebuild the ENTIRE grid (and, if the user
 * upgraded it, the live Leaflet map). The full re-render still runs once, later, when new counts
 * land (facetsVersion). Mirrors results.ts's updateRowStates.
 */
export function syncOverviewSelection(ctx: AppContext): void {
  const host = ctx.roots.overviewGrid;
  for (const card of host.querySelectorAll<HTMLElement>(".fcard[data-key]")) {
    const key = card.dataset.key;
    if (!key || key.startsWith("__")) continue;
    for (const row of card.querySelectorAll<HTMLElement>(".fval")) {
      const val = row.querySelector(".nm")?.textContent ?? "";
      const sel = isSelected(ctx.state, key, val);
      row.classList.toggle("sel", sel);
      row.setAttribute("aria-checked", sel ? "true" : "false");
      const cb = row.querySelector(".cb");
      if (cb) {
        const hasIcon = cb.childElementCount > 0;
        if (sel && !hasIcon) cb.append(svgIcon(ICONS.check, { size: 11 }));
        else if (!sel && hasIcon) cb.textContent = "";
      }
    }
    // header active-state + the selected-count "clear this facet" badge follow the selection too
    const head = card.querySelector<HTMLElement>(".fcard-h");
    if (!head) continue;
    const nsel = (ctx.state.selected[key] ?? []).length;
    head.classList.toggle("active", nsel > 0);
    let badge = head.querySelector<HTMLElement>(".fh-count");
    if (nsel > 0) {
      const label = head.querySelector(".fh-label")?.textContent ?? key;
      if (!badge) {
        badge = el("span", {
          class: "fh-count",
          role: "button",
          tabindex: "0",
          title: `Clear ${label} filter`,
        });
        // transient node: it is discarded on the next full render, so raw listeners are fine here.
        badge.addEventListener("click", (e) => {
          e.stopPropagation();
          ctx.clearFacet(key);
        });
        badge.addEventListener("keydown", (e) => {
          const k = (e as KeyboardEvent).key;
          if (k === "Enter" || k === " ") {
            e.preventDefault();
            e.stopPropagation();
            ctx.clearFacet(key);
          }
        });
        head.querySelector(".fh-label")?.after(badge);
      }
      badge.textContent = String(nsel);
      badge.setAttribute("aria-label", `Clear ${label} filter - ${nsel} selected`);
    } else if (badge) {
      badge.remove();
    }
  }
}
