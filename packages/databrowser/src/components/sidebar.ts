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
import { NEQ, badgeSpecs, facetBreakdown, modeBadge } from "./facetBadge.js";
import {
  describeValue,
  displayFacetValues,
  excludedValues,
  facetSelectionCount,
  isExcluded,
  isGatedValue,
  isSelected,
} from "../state.js";
import type { Facet } from "../types.js";

const VALUE_CHUNK = 60;
/** Below this many values a search box is just clutter. */
const SEARCH_THRESHOLD = 8;

function seed(ctx: AppContext): void {
  if (ctx.state.sidebarSeeded || ctx.state.facets.length === 0) return;
  for (const f of ctx.state.facets) {
    if (facetSelectionCount(ctx.state, f.key)) ctx.state.sidebarOpen.add(f.key);
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
): HTMLElement {
  const sel = isSelected(ctx.state, facet.key, value);
  const excl = isExcluded(ctx.state, facet.key, value);
  const gated = isGatedValue(ctx.state, facet.key, value); // part of the locked base scope
  const desc = describeValue(ctx.state, facet.key, value);
  const cb = el("span", { class: "cb" }, sel ? [svgIcon(ICONS.check, { size: 11 })] : []);
  const row = el(
    "button",
    {
      class: `fval${sel ? " sel" : ""}${excl ? " excl" : ""}${gated ? " locked" : ""}`,
      type: "button",
      role: "checkbox",
      "aria-checked": sel ? "true" : "false",
      "aria-disabled": gated ? "true" : "false",
      // Specific accessible names: "Include project cmip6", not a bare value the user has to
      // guess the effect of - especially now that two controls sit on one row.
      "aria-label": gated
        ? `${facet.label}: ${value} (locked scope)`
        : `Include ${facet.label} ${value}`,
      title: gated
        ? `${value} - this instance is scoped to this value`
        : desc
          ? `${value} - ${desc}`
          : value,
    },
    [cb, el("span", { class: "nm", text: value }), el("span", { class: "n", text: fmt(count) })],
  );
  if (!gated) reg.listen(row, "click", () => ctx.toggleFacet(facet.key, value)); // the gate can't be toggled off
  if (gated) return el("div", { class: "fval-row" }, [row]);

  // TWO SIBLING controls, never a button nested inside a button-like row: nesting is invalid HTML,
  // and it makes the inner control unreachable for some AT and impossible to hit reliably by touch.
  const ex = el("button", {
    class: `fval-ex${excl ? " on" : ""}`,
    type: "button",
    "aria-pressed": excl ? "true" : "false",
    "aria-label": `Exclude ${facet.label} ${value}`,
    title: excl ? `Stop excluding ${value}` : `Exclude ${value} from the results`,
    text: "≠", // ≠ - a glyph, so the state never rests on colour alone
  });
  reg.listen(ex, "click", (e) => {
    e.stopPropagation();
    ctx.excludeFacet(facet.key, value);
  });
  return el("div", { class: `fval-row${excl ? " excl" : ""}` }, [row, ex]);
}

function facetNode(ctx: AppContext, reg: Disposables, facet: Facet): HTMLElement {
  const selected = ctx.state.selected[facet.key] ?? [];
  const excluded = excludedValues(ctx.state, facet.key);
  // The badge and the Clear affordance count BOTH modes - a facet with only exclusions is just as
  // filtered as one with only inclusions, and must be just as visibly clearable.
  const nsel = facetSelectionCount(ctx.state, facet.key);
  const open = ctx.state.sidebarOpen.has(facet.key);
  const wrap = el("div", { class: `facet${open ? " open" : ""}`, "data-key": facet.key });

  // The header is a ROW, not a button: it holds the disclosure control AND the `+N` / `-N` clear
  // buttons as siblings. Nesting them inside the disclosure button is invalid HTML and leaves the
  // inner controls unreachable for some assistive technology.
  const head = el("div", { class: `facet-head${nsel ? " active" : ""}` });
  const toggle = el("button", {
    class: "fh-toggle",
    type: "button",
    "aria-expanded": open ? "true" : "false",
  });
  const headText = el("span", { class: "fh-text" }, [
    el("span", { class: "fh-label", text: facet.label }),
  ]);
  // The selected values read as a SUBTITLE under the section name, so you can see what's active
  // without expanding anything (the e-commerce filter pattern).
  if (nsel) {
    const parts = [...selected, ...excluded.map((v) => `${NEQ} ${v}`)];
    headText.append(el("span", { class: "fh-sel", text: parts.join(", ") }));
  }
  toggle.append(headText);
  head.append(toggle);
  if (nsel) {
    // Two INDEPENDENT controls: `+N` clears only what is kept, `-N` only what is removed. Clearing
    // one leaves the other exactly as it was, in one state update and one search.
    const br = facetBreakdown(ctx.state, facet.key);
    for (const spec of badgeSpecs(br)) {
      head.append(
        modeBadge(
          spec,
          facet.label,
          () => ctx.clearFacetMode(facet.key, spec.negative),
          (n, t, f) => reg.listen(n, t, f),
        ),
      );
    }
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
    toggle.setAttribute("aria-expanded", nowOpen ? "true" : "false");
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
  // Every selected value counts, positive or negative - state.selected already holds both, keyed
  // by `project` and `project_not_` respectively.
  // The GLOBAL header is deliberately unchanged: one number, `FILTER N`. The include/exclude split
  // belongs to the per-facet controls, where it is actionable - here it would only be a second thing
  // to read on the way to a button that clears everything anyway.
  const active =
    Object.values(ctx.state.selected).reduce((n, vs) => n + vs.length, 0) +
    (ctx.state.time ? 1 : 0) +
    (ctx.state.bbox ? 1 : 0);
  const headBits: HTMLElement[] = [el("span", { class: "sf-title", text: "Filter" })];
  if (active) {
    // The count badge IS the clear-all control: on hover or focus the number is REPLACED by one
    // centred x - replaced, not covered, so nothing shows through underneath - and clicking clears
    // every filter. Its size, styling, keyboard behaviour and accessible name are unchanged.
    const badge = el(
      "button",
      {
        class: "sf-badge",
        type: "button",
        title: "Clear all filters",
        "aria-label": `Clear all ${active} filter${active === 1 ? "" : "s"}`,
      },
      [
        el("span", { class: "sf-n", text: String(active) }),
        el("span", { class: "sf-x", "aria-hidden": "true", text: "×" }),
      ],
    );
    badge.style.setProperty("--fb-ch", String(String(active).length));
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
