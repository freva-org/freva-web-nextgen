// components/sidebar.ts - facet accordions (primary order), Time/BBox special panels,
// and the "Show additional facets" expander. Browsing here fetches no per-file metadata.
//
// No module-level Disposables: the region bucket is created once per render and passed down, and
// the accordion open/expander state lives in AppState (per-mount). Long value lists render
// incrementally via appendChunked, so a facet with hundreds of values costs ~60 nodes until it is
// actually scrolled.

import type { AppContext } from "../context.js";
import { appendChunked, el, replaceChildren, svgIcon, type Disposables } from "../dom.js";
import { ICONS } from "../icons.js";
import { describeValue, displayFacetValues, isGatedValue, isSelected } from "../state.js";
import type { Facet } from "../types.js";

const VALUE_CHUNK = 60;
/** Below this many values a search box is just clutter. */
const SEARCH_THRESHOLD = 8;

function seed(ctx: AppContext): void {
  if (ctx.state.sidebarSeeded || ctx.state.facets.length === 0) return;
  for (const f of ctx.state.facets) {
    if ((ctx.state.selected[f.key] ?? []).length) ctx.state.sidebarOpen.add(f.key);
  }
  ctx.state.sidebarSeeded = true;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

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
  const cb = el("span", { class: "cb" }, sel ? [svgIcon(ICONS.check, { size: 11 })] : []);
  const row = el(
    "button",
    {
      class: `fval${sel ? " sel" : ""}${gated ? " locked" : ""}`,
      type: "button",
      role: "checkbox",
      "aria-checked": sel ? "true" : "false",
      "aria-disabled": gated ? "true" : "false",
      "aria-label": gated ? `${facet.label}: ${value} (locked scope)` : `${facet.label}: ${value}`,
      title: gated
        ? `${value} - this instance is scoped to this value`
        : desc
          ? `${value} - ${desc}`
          : value,
    },
    [cb, el("span", { class: "nm", text: value }), el("span", { class: "n", text: fmt(count) })],
  );
  if (!gated) reg.listen(row, "click", () => ctx.toggleFacet(facet.key, value)); // the gate can't be toggled off
  return row;
}

function facetNode(ctx: AppContext, reg: Disposables, facet: Facet): HTMLElement {
  const selected = ctx.state.selected[facet.key] ?? [];
  const nsel = selected.length;
  const open = ctx.state.sidebarOpen.has(facet.key);
  const wrap = el("div", { class: `facet${open ? " open" : ""}`, "data-key": facet.key });

  const head = el("button", {
    class: `facet-head${nsel ? " active" : ""}`,
    type: "button",
    "aria-expanded": open ? "true" : "false",
  });
  const headText = el("span", { class: "fh-text" }, [
    el("span", { class: "fh-label", text: facet.label }),
  ]);
  // The selected values read as a SUBTITLE under the section name, so you can see what's active
  // without expanding anything (the e-commerce filter pattern).
  if (nsel) headText.append(el("span", { class: "fh-sel", text: selected.join(", ") }));
  head.append(headText);
  if (nsel) {
    // The selected-count badge doubles as a "clear this facet" control: on hover it becomes a red
    // × (CSS), and clicking it clears every selected value for this facet. stopPropagation keeps
    // the click from toggling the accordion the head button owns.
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
  } else {
    const badge = facet.hasMore ? `${facet.values.length}+` : String(facet.values.length);
    head.append(el("span", { class: "badge", text: badge }));
  }
  head.append(el("span", { class: "chev" }, [svgIcon(ICONS.chevron, { size: 12 })]));

  const body = el("div", { class: "facet-body" });
  const list = el("div", { class: "fval-list" }); // the scroll container (capped height)
  // Per-facet search: a facet can carry thousands of unique values - typing filters them here
  // rather than forcing the user to scroll (or to guess at the global search bar).
  const search = el("input", {
    class: "fval-search",
    type: "search",
    placeholder: `Search ${facet.label.toLowerCase()}…`,
    "aria-label": `Search ${facet.label} values`,
    autocomplete: "off",
  }) as HTMLInputElement;
  const empty = el("div", { class: "fmore", text: "No matching values." });
  empty.style.display = "none";

  const paint = (q: string): void => {
    const needle = q.trim().toLowerCase();
    const source = displayFacetValues(ctx.state, facet); // gated key -> scope values only
    const matches = needle ? source.filter((v) => v.value.toLowerCase().includes(needle)) : source;
    replaceChildren(list);
    empty.style.display = matches.length ? "none" : "";
    appendChunked(
      reg,
      list,
      matches.length,
      (i) => valueRow(ctx, reg, facet, matches[i].value, matches[i].count),
      VALUE_CHUNK,
    );
  };

  let filled = false;
  const fillBody = (): void => {
    if (filled) return;
    filled = true;
    // Show the per-facet search once there are enough values for it to earn its space. Beyond that
    // the list simply scrolls through the loaded values, like an overview card.
    if (facet.values.length > SEARCH_THRESHOLD) {
      reg.listen(search, "input", () => paint(search.value));
      reg.listen(search, "keydown", (e) => {
        if ((e as KeyboardEvent).key === "Escape") {
          search.value = "";
          paint("");
        }
      });
      body.append(search);
    }
    body.append(list, empty);
    // (No "more values" hint - the list scrolls to reveal the rest, matching the overview.)
    paint("");
  };
  // A collapsed accordion body costs ZERO value nodes - it is filled on first open.
  if (open) fillBody();

  reg.listen(head, "click", () => {
    const nowOpen = !wrap.classList.contains("open");
    wrap.classList.toggle("open", nowOpen);
    head.setAttribute("aria-expanded", nowOpen ? "true" : "false");
    if (nowOpen) {
      ctx.state.sidebarOpen.add(facet.key);
      fillBody();
    } else {
      ctx.state.sidebarOpen.delete(facet.key);
    }
  });
  wrap.append(head, body);
  return wrap;
}

function specialNode(ctx: AppContext, reg: Disposables, kind: "time" | "bbox"): HTMLElement {
  const isTime = kind === "time";
  const set = isTime ? !!ctx.state.time : !!ctx.state.bbox;
  const btn = el("button", {
    class: `special${set ? " set" : ""}`,
    type: "button",
    "aria-label": isTime ? "Edit time range" : "Edit bounding box",
  });
  btn.append(
    el("span", { class: "lead" }, [svgIcon(isTime ? ICONS.clock : ICONS.box, { size: 15 })]),
  );
  btn.append(el("span", { text: isTime ? "Time range" : "Bounding box" }));
  let val = isTime ? "time_select" : "draw on map";
  if (isTime && ctx.state.time) val = `${ctx.state.time.from}→${ctx.state.time.to}`;
  else if (!isTime && ctx.state.bbox) val = "on map";
  btn.append(el("span", { class: "val", text: val }));
  reg.listen(btn, "click", (e) => {
    e.stopPropagation();
    if (isTime) ctx.openTimeEditor(btn);
    else ctx.openBboxEditor(btn);
  });
  return btn;
}

export function renderSidebar(ctx: AppContext): void {
  const reg = ctx.region("sidebar");
  const host = ctx.roots.facetList;
  seed(ctx);
  const primarySet = new Set(ctx.state.primaryFacets);
  const primary = ctx.state.facets.filter((f) => primarySet.size === 0 || primarySet.has(f.key));
  const additional = ctx.state.facets.filter((f) => primarySet.size > 0 && !primarySet.has(f.key));

  // ONE header. The sections below are named by what they actually are (Project, Model, …), so a
  // generic "Facets" meta-label - Solr's word, not the user's - would add nothing.
  const active =
    Object.values(ctx.state.selected).reduce((n, vs) => n + vs.length, 0) +
    (ctx.state.time ? 1 : 0) +
    (ctx.state.bbox ? 1 : 0);
  const headBits: HTMLElement[] = [el("span", { class: "sf-title", text: "Filter" })];
  if (active) {
    // The count badge IS the clear-all control. Hovering it reveals a red × and clicking clears
    // every filter, so the sidebar carries no separate "Clear all" link; the main one lives under
    // the search bar.
    const badge = el("button", {
      class: "sf-badge",
      type: "button",
      title: "Clear all filters",
      "aria-label": `Clear all ${active} filter${active === 1 ? "" : "s"}`,
      text: String(active),
    });
    reg.listen(badge, "click", () => ctx.clearAllFacets());
    headBits.push(badge);
  }
  const nodes: (Node | string)[] = [el("div", { class: "side-filterhead" }, headBits)];

  if (ctx.state.facets.length === 0) {
    nodes.push(el("div", { class: "fmore", text: "Run a search to load facet values." }));
  } else {
    for (const f of primary) nodes.push(facetNode(ctx, reg, f));
    nodes.push(specialNode(ctx, reg, "time"));
    nodes.push(specialNode(ctx, reg, "bbox"));

    if (additional.length) {
      const expander = el("button", {
        class: "addbtn",
        type: "button",
        text: ctx.state.sidebarAddOpen ? "− Hide additional facets" : "＋ Show additional facets",
      });
      reg.listen(expander, "click", () => {
        ctx.state.sidebarAddOpen = !ctx.state.sidebarAddOpen;
        ctx.renderSidebar(); // signature includes sidebarAddOpen -> re-renders
      });
      nodes.push(expander);
      if (ctx.state.sidebarAddOpen) for (const f of additional) nodes.push(facetNode(ctx, reg, f));
    } else {
      nodes.push(el("div", { "aria-hidden": "true" }));
    }
  }
  replaceChildren(host, ...nodes);
}
