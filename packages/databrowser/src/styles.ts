// styles.ts - the stylesheet as a string, injected into a <style> element on mount.
// GENERATED from styles.css by scripts/gen-styles.mjs - do not edit by hand; edit styles.css
// and run `npm run gen:styles`. The component bundles no CSS file, so the tokens + component styles live here as one constant.

export const STYLES = `/* styles.css - tokens + component styles for both themes.
   Ported from the prototype (the binding pixel source). The generic \`.overview\` class is
   renamed to \`.overview-mode\` to avoid a class collision that blanks the page.

   The TERMINAL's styles are NOT here: they moved to @freva-org/freva-client-terminal, which injects
   its own scoped stylesheet into the terminal window's root. Rules matching \`.freva-term\` do not
   belong in this file. */

.freva-db {
  --r: 10px;
  --r-sm: 7px;
  /* Advertise the app's scheme to native controls (scrollbars, form pickers) AND to embedded
     cross-origin iframes: an iframe inherits the embedder's used color-scheme, so the GridLook 3D
     viewer picks THIS up as its prefers-color-scheme and follows the databrowser theme (it otherwise
     falls back to the OS scheme). Overridden to dark under [data-theme="night"] below. */
  color-scheme: light;
  /* The mount target must have a definite height (the demo uses 100vh); .freva-db fills it so
     .fdb-app's grid can keep header/footer fixed and give each panel its own bounded scroll. */
  position: relative;
  height: 100%;
  min-height: 0;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --ui: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --bg: #eef1f6;
  --surface: #fff;
  --surface-2: #f4f6fa;
  --surface-3: #e9edf4;
  --text: #0e1726;
  --dim: #475569;
  /* Raised from #8a97ac (~2.96:1 on white). --faint is used for MEANINGFUL small text - counts,
     file paths, table headers, flavour captions - so it has to clear 4.5:1 on every day surface,
     not just look quiet. #5f6b7c measures 5.41:1 on --surface and 4.61:1 on --surface-3, the
     lightest and darkest day backgrounds it lands on. */
  --faint: #5f6b7c;
  --border: #dce2ec;
  --border-2: #c7d0dd;
  --accent: #2a63e8;
  --accent-2: #1e50c8;
  --accent-soft: color-mix(in srgb, var(--accent) 10%, transparent);
  --good: #1e9e6a;
  --warn: #c7841e;
  --danger: #d8543c;
  --ocean: #d9e6f2;
  --land: #c5d2e0;
  --shadow: 0 1px 2px rgba(16, 28, 52, 0.06), 0 4px 16px rgba(16, 28, 52, 0.07);
  font-family: var(--ui);
  color: var(--text);
}
.freva-db[data-theme="night"] {
  color-scheme: dark;
  --bg: #0a1120;
  --surface: #0f1a2e;
  --surface-2: #142339;
  --surface-3: #1a2c46;
  --text: #e7edf7;
  --dim: #9dabc4;
  /* Night equivalent: #5e6e88 measured 3.06-3.36:1 across the night surfaces. #8595b0 measures
     4.64:1 against --surface-3 (#1a2c46), the LIGHTEST night surface and therefore the worst case.
     The --text / --dim / --faint hierarchy and the dark-blue identity are unchanged. */
  --faint: #8595b0;
  --border: #213352;
  --border-2: #2c4267;
  --accent: #4f8df7;
  --accent-2: #6aa0ff;
  --accent-soft: color-mix(in srgb, var(--accent) 16%, transparent);
  --good: #34c98a;
  --warn: #e6b14e;
  --danger: #f0795f;
  --ocean: #0e2138;
  --land: #1c3554;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 6px 20px rgba(0, 0, 0, 0.4);
}
.freva-db,
.freva-db * {
  box-sizing: border-box;
}
.freva-db :focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

/* The app is a 3-row grid (header / body / footer); header + footer never
   scroll. The body is a 3-column grid (facets / center / details); each panel owns its scroll
   and its height never depends on another panel's content. */
.fdb-app {
  height: 100%;
  min-height: 680px;
  display: grid;
  grid-template-rows: auto 1fr auto;
  /* An implicit grid column sizes to the WIDEST row's min-content, so at phone widths the top bar
     stretched the whole app past the viewport and took the body - top row included - with it.
     An explicit 0 minimum lets the column shrink; the rows clip or wrap their own content. */
  grid-template-columns: minmax(0, 1fr);
  background: var(--bg);
  color: var(--text);
  transition:
    background-color 0.35s,
    color 0.35s;
}

.top {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 56px;
  flex-shrink: 0;
  min-width: 0; /* …and the bar itself must be allowed to shrink rather than set the app's width */
  padding: 0 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  transition:
    background-color 0.35s,
    border-color 0.35s;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 15px;
  white-space: nowrap;
}
.brand .mark {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #fff));
  font-size: 13px;
}
.brand .brand-logo {
  width: 45px;
  height: 45px;
  object-fit: contain;
  display: block;
  flex-shrink: 0;
  margin: -4px 0;
}
.lens {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  font-family: inherit;
}
.lens:hover {
  border-color: var(--border-2);
}
.lens .k {
  color: var(--faint);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.lens .v {
  font-weight: 600;
}
.search {
  flex: 1;
  min-width: 0; /* a flex item's default \`min-width: auto\` would floor the bar at the input's width */
  position: relative;
}
.search input {
  width: 100%;
  height: 40px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
  font-family: inherit;
  padding: 0 14px 0 40px;
  outline: none;
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    background-color 0.35s;
}
.search input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.search .ic {
  position: absolute;
  left: 13px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--faint);
  display: grid;
  place-items: center;
}
.icon-btn {
  height: 36px;
  min-width: 36px;
  padding: 0 9px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--dim);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-family: inherit;
  transition:
    background-color 0.15s,
    color 0.15s,
    border-color 0.15s;
  white-space: nowrap;
}
.icon-btn:hover {
  color: var(--text);
  border-color: var(--border-2);
}
.icon-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: transparent;
}
.theme {
  width: 60px;
  height: 34px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
  transition:
    background-color 0.35s,
    border-color 0.35s;
}
.theme .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: var(--surface);
  box-shadow: var(--shadow);
  display: grid;
  place-items: center;
  color: var(--accent);
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}
.freva-db[data-theme="night"] .theme .knob {
  transform: translateX(26px);
}

.body {
  display: grid;
  /* minmax(0, …) rather than a bare 1fr: a \`1fr\` track floors at its content's min-content width,
     so at phone widths the centre column grew past the viewport and took the top row - Clear all
     and the Browse/Overview cluster included - off screen with it. The explicit 0 minimum lets the
     column actually shrink; \`.center\` already sets \`min-width: 0\` and clips its own overflow. */
  grid-template-columns: auto minmax(0, 1fr) auto;
  min-height: 0;
  position: relative;
}
/* Explicit placement: hiding .side (metaview) must NOT let .center/.details-panel auto-place into the
   wrong track (that mis-sized the center in metadata-focused view). */
.side {
  grid-column: 1;
}
.center {
  grid-column: 2;
}
.details-panel {
  grid-column: 3;
}

/* SIDEBAR */
.side {
  width: 268px;
  flex-shrink: 0;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition:
    width 0.22s ease,
    background-color 0.35s,
    border-color 0.35s;
}
.fdb-app.metaview .side {
  display: none;
}
/* Collapsible: the sidebar collapses to a slim rail with a reopen affordance; persisted. */
.fdb-app.side-collapsed .side {
  width: 44px;
}
.fdb-app.side-collapsed .side .side-scroll,
.fdb-app.side-collapsed .side .side-head .side-title {
  display: none;
}
.fdb-app.side-collapsed .side .side-filterhead {
  display: none;
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 6px 8px 2px;
}
.side-head .side-title {
  padding: 2px 4px;
}
.side-collapse {
  width: 28px;
  height: 28px;
  margin-left: auto;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--dim);
  cursor: pointer;
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  transition:
    color 0.12s,
    border-color 0.12s;
}
.side-collapse:hover {
  color: var(--text);
  border-color: var(--border-2);
}
.side-collapse .chev {
  transition: transform 0.22s;
  display: inline-grid;
  place-items: center;
  transform: rotate(180deg);
}
.fdb-app.side-collapsed .side-collapse {
  margin: 0 auto;
}
.fdb-app.side-collapsed .side-collapse .chev {
  transform: rotate(0deg);
}
.side-scroll {
  overflow-y: auto;
  padding: 10px 10px 16px;
  flex: 1;
}
.side-title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--faint);
  padding: 8px 8px 4px;
  display: flex;
  align-items: center;
}
.facet {
  border-radius: var(--r-sm);
}
.facet-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 8px 0 10px;
  border-radius: var(--r-sm);
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text);
  transition:
    background-color 0.12s,
    color 0.12s;
  width: 100%;
  border: none;
  background: none;
  font-family: inherit;
  text-align: left;
}
.facet-head:hover {
  background: var(--surface-2);
}
.facet-head .chev {
  color: var(--faint);
  width: 12px;
  display: inline-grid;
  place-items: center;
  transition: transform 0.2s;
}
.facet.open > .facet-head .chev {
  transform: rotate(90deg);
}
.facet-head .fh-label {
  font-weight: 600;
  letter-spacing: 0.005em;
}
.facet-head .badge {
  margin-left: auto;
  font-size: 10px;
  color: var(--faint);
  font-family: var(--mono);
  font-weight: 500;
}
/* The \`+N\` / \`-N\` clear buttons are styled with the rest of the inclusion/exclusion language at
   the end of this sheet - one filled, one dashed, and neither of them a bare accent pill. */
.facet-head .fh-count {
  margin-left: 0;
  font-family: var(--mono);
}
.facet-head.active .fh-label {
  color: var(--accent);
}
.facet-head.active .chev {
  color: var(--accent);
}
.facet-head.active::before {
  content: "";
  position: absolute;
  left: 1px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
}
.facet-body {
  display: none;
  padding: 1px 0 6px 16px;
}
.facet.open > .facet-body {
  display: block;
}
.fval {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 27px;
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--dim);
  cursor: pointer;
  transition:
    background-color 0.12s,
    color 0.12s;
  width: 100%;
  border: none;
  background: none;
  font-family: inherit;
  text-align: left;
}
.fval:hover {
  background: var(--surface-2);
  color: var(--text);
}
.fval.sel {
  color: var(--accent);
  font-weight: 600;
}
.fval[aria-disabled="true"] {
  opacity: 0.5;
  cursor: not-allowed;
}
.fval.locked {
  opacity: 1;
  cursor: default;
} /* base scope: active, not disabled-looking */
.fval.locked:hover {
  background: transparent;
}
.fval .nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fval .n {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--faint);
  flex-shrink: 0;
  padding-left: 6px;
}
.fval .cb {
  width: 13px;
  height: 13px;
  border-radius: 3px;
  border: 1.5px solid var(--border-2);
  flex-shrink: 0;
  display: grid;
  place-items: center;
  color: transparent;
}
.fval.sel .cb {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.fmore {
  font-size: 11px;
  color: var(--faint);
  padding: 4px 8px 2px;
  font-style: italic;
}
.special {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 5px 8px;
  border-radius: var(--r-sm);
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  transition: background-color 0.12s;
  width: 100%;
  border: none;
  background: none;
  font-family: inherit;
  text-align: left;
}
.special:hover {
  background: var(--surface-2);
}
.special.set {
  background: var(--accent-soft);
  color: var(--accent);
}
.special .val {
  margin-left: auto;
  font-size: 10px;
  color: var(--faint);
  font-family: var(--mono);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.special.set .val {
  color: var(--accent);
}
.special .lead {
  display: inline-grid;
  place-items: center;
}
.addbtn {
  width: 100%;
  margin: 8px 0 4px;
  height: 38px;
  border-radius: var(--r-sm);
  border: 1px dashed var(--border-2);
  background: transparent;
  color: var(--dim);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.addbtn:hover {
  background: var(--surface-2);
  color: var(--text);
}

/* CENTER - toprow + res-bar are fixed chrome; only the results column scrolls. */
.center {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
.center-fixed {
  flex-shrink: 0;
  padding: 14px 18px 0;
}
.results-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* NO top padding. \`.list-head\` sticks at \`top: 0\` of the PADDING box, so any top padding leaves a
     band between the scrollport edge and the pinned header - and once the header is pinned, the
     content occupying that band is the rows. That is the strip of file text that painted above the
     column header. The spacing belongs on the content that wants it, below - not here. */
  padding: 0 18px 92px;
}

/* Breathing room applied to the content rather than to the scrollport, so it scrolls away with
   that content instead of holding a gap open above the pinned header. */
.results-scroll > .overview-mode,
.results-scroll > .list-head[hidden] + .rows {
  margin-top: 8px;
}
.toprow {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  align-items: center;
  flex: 1;
  min-width: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  font-family: inherit;
}
.chip .x {
  opacity: 0.7;
  display: inline-grid;
  place-items: center;
}
.chip.geo {
  background: color-mix(in srgb, var(--good) 14%, transparent);
  color: var(--good);
}
.clear-btn {
  flex-shrink: 0;
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
  background: transparent;
  color: var(--danger);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  display: none;
}
.clear-btn.show {
  display: inline-flex;
  align-items: center;
}
.ctrl-cluster {
  flex-shrink: 0;
  /* The mode switch belongs on the RIGHT. Relying on \`.chips\` to fill the row only worked while
     there were chips: with none (or the row hidden) the cluster fell back to the left and the
     control jumped as soon as the first filter was applied. \`margin-left: auto\` states the
     intention instead of depending on a sibling's content. */
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px;
  box-shadow: var(--shadow);
}
.ctrl {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition:
    background-color 0.15s,
    color 0.15s;
}
.ctrl:hover {
  background: var(--surface-2);
  color: var(--text);
}
.ctrl.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.ctrl-sep {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 2px;
}

.overview-mode {
  display: none;
  margin-bottom: 16px;
}
.fdb-app.metaview .overview-mode {
  display: block;
}
.overview-cap {
  font-size: 12px;
  color: var(--faint);
  margin: 0 0 10px;
}
.stale-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--warn) 16%, transparent);
  color: var(--warn);
  font-size: 10.5px;
  font-weight: 700;
}
.facet-grid {
  --block-h: 256px;
  --block-gap: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(244px, 100%), 1fr));
  gap: var(--block-gap);
  /* Rows are sized by their CONTENT and each card states its own block height (below). A fixed
     \`grid-auto-rows\` could never let a minimized row close up; \`min-content\` alone let an expanded
     card grow past its box (which is what killed the value scrollbar). This does both. */
  grid-auto-rows: min-content;
  align-items: start;
}
/* "stacked": every block a full-width row. A single column forces full width regardless of each
   card's saved span, and \`1 / -1\` overrides the inline \`span N\` so no implicit tracks (= no page
   overflow) can ever be created. */
.facet-grid.stacked {
  grid-template-columns: 1fr;
}
.facet-grid.stacked .fcard,
.facet-grid.stacked .ov-addrow {
  grid-column: 1 / -1 !important;
}
.fcard {
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow);
  height: var(--block-h);
}
/* one block down - and no further */
.fcard[data-rows="2"] {
  height: calc(var(--block-h) * 2 + var(--block-gap));
}
.fcard.tall {
  grid-row: span 2;
}
.fcard.wide {
  grid-column: span 2;
}
.fcard-empty {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--faint);
  font-style: italic;
}
/* Value lists lay out as a GRID that fits as many ~200px columns as the width allows and then
   grows DOWNWARD (vertical scroll), row-major. This replaces CSS multi-column, whose fixed-height
   column packing forced a horizontal scroll when a card was stretched. Applies uniformly: a narrow
   card gets one column, a wide/stacked/full-width card gets several - always scrolling vertically. */
.fcard-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-weight: 700;
  font-size: 13px;
}
/* The header toggles collapse/expand; make that obvious (its own controls keep their cursors). */
.fcard-h.clickable {
  cursor: pointer;
}
.fcard-h.clickable:hover {
  background: var(--surface-2);
}
.fcard-h .badge {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--faint);
}
.fcard-h .fh-count {
  margin-left: 6px;
  font-family: var(--mono);
}
/* NOTE: the hover treatment is a real element swap in a neutral colour; see the end of this sheet.
   A red \`::after\` cross drawn OVER the badge with the number merely turned transparent puts both
   on screen at once, and takes the host's danger colour - which in a red-branded deployment is
   the accent. */
.fcard-h.active {
  color: var(--accent);
}
.fcard-h .exp {
  margin-left: 4px;
  color: var(--faint);
  cursor: pointer;
  border: none;
  background: none;
  padding: 2px;
  display: inline-grid;
  place-items: center;
}
.fcard-h .exp:hover {
  color: var(--accent);
}
.fcard-h .exp.on {
  color: var(--accent);
}
.fcard .within {
  margin: 8px 10px 4px;
  height: 30px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  border-radius: 6px;
  padding: 0 9px;
  font-size: 12px;
  outline: none;
  font-family: inherit;
}
.fcard .within:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.fcard-vals {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(190px, 100%), 1fr));
  column-gap: 10px;
  align-content: start;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 2px 6px 8px;
  flex: 1 1 auto;
  min-height: 0;
}
.fcard-vals .fmore,
.fcard-vals .fcard-empty {
  grid-column: 1 / -1;
} /* notes span the whole width */
.fcard-vals .fval {
  font-size: 12px;
}
.fcard .editline {
  padding: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.fcard .editline .v {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--accent);
  flex: 1;
  word-break: break-all;
}
.fcard .editline .v.off {
  color: var(--faint);
}

.res-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--r);
  background: var(--surface-2);
  border: 1px solid var(--border);
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.bar-div {
  width: 1px;
  height: 22px;
  background: var(--border);
  margin: 0 2px;
}
/* Select-all (in the results bar, both list + grid). Reuses the .cb checkbox box. */
.selall {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 9px;
  border: none;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
  font-size: 12.5px;
  border-radius: 8px;
  white-space: nowrap;
}
.selall:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text);
}
.selall:disabled {
  opacity: 0.4;
  cursor: default;
}
.selall .cb {
  color: transparent;
}
.selall .cb.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.selall .cb.mixed {
  background: var(--accent);
  border-color: var(--accent);
  position: relative;
}
.selall .cb.mixed::after {
  content: "";
  position: absolute;
  inset: 0;
  margin: auto;
  width: 9px;
  height: 2px;
  background: #fff;
  border-radius: 1px;
}
/* the file-panel controls fade/translate in place. The slot is RESERVED (this
   stays in flow with its width even when hidden) so nothing else in the bar moves; Export and the
   count never shift. pointer-events:none keeps the invisible controls unclickable. */
.panelctl {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  opacity: 0;
  transform: translateY(-3px);
  pointer-events: none;
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.panelctl.in {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.res-bar.merged {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  box-shadow: 0 2px 10px color-mix(in srgb, var(--accent) 12%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .panelctl {
    transition: none;
  }
}

.iconbtn {
  position: relative;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color 0.15s,
    color 0.15s;
}
.iconbtn:hover {
  background: var(--surface-3);
  color: var(--text);
}
.iconbtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.iconbtn .caret {
  position: absolute;
  right: 3px;
  bottom: 4px;
  color: var(--faint);
  display: inline-grid;
  place-items: center;
}
.scope-tag {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--faint);
  border: 1px solid var(--border-2);
  padding: 2px 7px;
  border-radius: 999px;
}
.res-count {
  font-size: 14px;
  font-weight: 700;
}
.res-count .sub {
  font-weight: 500;
  color: var(--faint);
  font-size: 12px;
  margin-left: 6px;
}
.spacer {
  flex: 1;
}
.seg {
  display: flex;
  border: 1px solid var(--border-2);
  border-radius: var(--r-sm);
  overflow: hidden;
}
.seg button {
  height: 34px;
  padding: 0 12px;
  min-width: 36px;
  display: grid;
  place-items: center;
  border: none;
  cursor: pointer;
  background: var(--surface);
  color: var(--dim);
  transition:
    background-color 0.15s,
    color 0.15s;
  font-family: inherit;
  font-size: 12px;
}
.seg button.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.btn {
  height: 34px;
  padding: 0 13px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-2);
  background: var(--surface);
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  transition:
    background-color 0.15s,
    border-color 0.15s;
}
.btn:hover {
  background: var(--surface-2);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.btn.primary:hover {
  background: var(--accent-2);
}
.ac {
  position: absolute;
  z-index: 70;
  background: #0e1626;
  border: 1px solid #28406a;
  border-radius: 8px;
  box-shadow: var(--shadow);
  min-width: 160px;
  max-height: 240px;
  overflow: auto;
  padding: 4px;
  display: none;
}
.ac.show {
  display: block;
}
.ac-item {
  padding: 6px 9px;
  border-radius: 5px;
  font-family: var(--mono);
  font-size: 12px;
  color: #d7e2f4;
  cursor: pointer;
  display: flex;
  gap: 8px;
  align-items: center;
}
.ac-item:hover,
.ac-item.hl {
  background: rgba(79, 141, 247, 0.2);
}
.ac-item .cnt {
  margin-left: auto;
  color: #6f7f9c;
  font-size: 10px;
}

/* results */
.rows {
  border: 1px solid var(--border);
  border-radius: var(--r);
  overflow: hidden;
  background: var(--surface);
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
}
.row {
  min-height: 48px;
  padding-top: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background-color 0.12s;
}
.row:last-child {
  border-bottom: none;
}
.row:hover {
  background: var(--surface-2);
}
.row.focus {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}
.row.picked {
  background: color-mix(in srgb, var(--accent-soft) 62%, transparent);
}
.row.focus.picked {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}
.cb {
  width: 17px;
  height: 17px;
  border-radius: 4px;
  border: 1.5px solid var(--border-2);
  flex-shrink: 0;
  display: grid;
  place-items: center;
  background: var(--surface);
  color: transparent;
  transition: background-color 0.12s;
  padding: 0;
  cursor: pointer;
}
.row.picked .cb,
.gcard.picked .cb {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.uricell {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
}
.row .ext {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}
.row .meta {
  flex: 1;
  min-width: 0;
}
/* ONE complete path per row (see results.ts \`pathEl\`). A single line with an ellipsis: the whole
   value lives in \`title\` and \`aria-label\`, so clipping loses nothing but pixels. \`direction: rtl\`
   keeps the END of a long path - the part that identifies the file - visible when it is clipped,
   while \`unicode-bidi: plaintext\` stops the text itself being reordered. */
.row .path {
  font-size: 13px;
  font-weight: 600;
  font-family: var(--mono);
  overflow: hidden;
  direction: rtl;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  unicode-bidi: plaintext;
}
.fs {
  font-size: 11px;
  font-weight: 500;
  font-family: var(--mono);
  color: var(--dim);
  flex-shrink: 0;
  white-space: nowrap;
}
/* List-view column header (uri | fs type). Sits directly on top of the .rows box. */
.list-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--dim);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r) var(--r) 0 0;
}
.list-head[hidden] {
  display: none;
}
.list-head .lh-uri {
  flex: 1;
  padding-left: 42px;
}
.list-head .lh-fs {
  flex-shrink: 0;
  padding-right: 34px;
}
.list-head:not([hidden]) + .rows {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr));
  gap: 10px;
}
.gcard {
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--surface);
  padding: 12px;
  cursor: pointer;
  transition:
    border-color 0.12s,
    box-shadow 0.12s,
    transform 0.1s;
}
.gcard:hover {
  box-shadow: var(--shadow);
  border-color: var(--border-2);
  transform: translateY(-1px);
}
.gcard.focus {
  border-color: transparent;
  box-shadow:
    inset 0 0 0 1px var(--accent),
    0 0 0 3px var(--accent-soft);
}
.gcard.picked {
  background: color-mix(in srgb, var(--accent-soft) 55%, transparent);
}
.gcard .top2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
}
/* A card may WRAP the path across lines - it is still one complete value, never two. */
.gcard .path {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--mono);
  line-height: 1.35;
  word-break: break-all;
}
.gcard .bits {
  font-size: 10.5px;
  color: var(--faint);
  margin-top: 6px;
  font-family: var(--mono);
}
.kebab {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
}
.kebab:hover {
  background: var(--surface-3);
  color: var(--text);
}

.load-next {
  width: 100%;
  justify-content: center;
}
.more-note {
  text-align: center;
  padding: 12px;
  color: var(--faint);
  font-size: 12.5px;
}

/* states */
.skeleton-rows {
  border: 1px solid var(--border);
  border-radius: var(--r);
  overflow: hidden;
  background: var(--surface);
}
.sk-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  border-bottom: 1px solid var(--border);
}
.sk-row:last-child {
  border-bottom: none;
}
.sk {
  background: linear-gradient(
    90deg,
    var(--surface-2) 25%,
    var(--surface-3) 50%,
    var(--surface-2) 75%
  );
  background-size: 400% 100%;
  animation: sk 1.3s ease infinite;
  border-radius: 6px;
}
@keyframes sk {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}
.fdb-app[data-reduced-motion="true"] .sk {
  animation: none;
}
.state-msg {
  text-align: center;
  padding: 44px 22px;
  color: var(--dim);
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--surface);
}
.state-msg .big {
  color: var(--faint);
  margin-bottom: 12px;
  display: grid;
  place-items: center;
}
.state-msg p {
  font-size: 13.5px;
  line-height: 1.5;
  margin: 0 0 12px;
}
.state-msg.err {
  color: var(--danger);
}

.pickbar {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  width: min(680px, calc(100% - 36px));
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  padding: 10px 14px;
  display: none;
  align-items: center;
  gap: 12px;
  z-index: 20;
}
.pickbar.show {
  display: flex;
}
.pickbar .cnt {
  font-size: 13px;
  font-weight: 600;
}
.pickbar .cnt b {
  color: var(--accent);
  font-family: var(--mono);
}
.pickbar .x {
  cursor: pointer;
  color: var(--faint);
  border: none;
  background: none;
  display: inline-grid;
  place-items: center;
}

/* RIGHT DETAILS PANEL */
.details-panel {
  width: 340px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition:
    width 0.25s,
    border-color 0.25s,
    background-color 0.35s;
}
.details-panel.collapsed {
  width: 0;
  border-left: none;
}
.info-scroll {
  overflow-y: auto;
  flex: 1;
}
.info-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.info-head .t {
  font-weight: 700;
  font-size: 14px;
}
.info-head .x {
  margin-left: auto;
  cursor: pointer;
  color: var(--faint);
  border: none;
  background: none;
  display: inline-grid;
  place-items: center;
}
.empty {
  padding: 40px 22px;
  text-align: center;
  color: var(--dim);
}
.empty .big {
  font-size: 30px;
  color: var(--faint);
  margin-bottom: 12px;
  display: grid;
  place-items: center;
}
.empty p {
  font-size: 13px;
  line-height: 1.5;
  margin: 0;
}
.empty code {
  font-family: var(--mono);
  color: var(--accent);
}
.info-name {
  padding: 16px 16px 2px;
  font-weight: 700;
  font-size: 13.5px;
  font-family: var(--mono);
  word-break: break-all;
}
.info-sub {
  padding: 0 16px 14px;
  font-size: 11.5px;
  color: var(--faint);
  word-break: break-all;
}
.info-sec {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
  padding: 10px 16px 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.meta {
  padding: 0 16px;
}
.meta-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.meta-row:last-child {
  border-bottom: none;
}
.meta-row .k {
  color: var(--dim);
}
.meta-row .v {
  font-family: var(--mono);
  color: var(--text);
  text-align: right;
  font-weight: 500;
  word-break: break-all;
}
.miniwrap {
  padding: 4px 16px 6px;
}
.minimap {
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  position: relative;
}
.coords {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--dim);
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
}
.na {
  font-size: 12px;
  color: var(--faint);
  padding: 2px 16px 8px;
  font-style: italic;
}
.info-actions {
  padding: 14px 16px 18px;
}
.cat-seg {
  margin: 6px 0 10px;
}
.info-actions .btn {
  width: 100%;
  justify-content: center;
  margin-bottom: 8px;
}
.scope-note {
  font-size: 11px;
  color: var(--faint);
  margin: 0 0 8px;
}
.querying {
  padding: 22px 16px;
  font-size: 12.5px;
  color: var(--faint);
  font-family: var(--mono);
}
.querying .bar {
  height: 3px;
  background: var(--surface-3);
  border-radius: 2px;
  margin-top: 10px;
  overflow: hidden;
  position: relative;
}
.querying .bar::after {
  content: "";
  position: absolute;
  left: -40%;
  top: 0;
  height: 100%;
  width: 40%;
  background: var(--accent);
  border-radius: 2px;
  animation: slide 1s infinite;
}
@keyframes slide {
  to {
    left: 100%;
  }
}
.partial-flag {
  margin: 6px 16px;
  padding: 6px 9px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
}

.diff-summary {
  padding: 0 16px 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.varchip {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--accent);
}
.dscroll {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin: 0 16px 4px;
}
.dmatrix {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
  font-family: var(--mono);
}
.dmatrix th,
.dmatrix td {
  text-align: left;
  padding: 6px 9px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.dmatrix tr:last-child td {
  border-bottom: none;
}
.dmatrix thead th {
  color: var(--faint);
  font-weight: 700;
  text-transform: uppercase;
  font-size: 9.5px;
  letter-spacing: 0.05em;
  background: var(--surface-2);
}
.dmatrix td.rownum {
  color: var(--faint);
}
.dchip {
  padding: 1px 7px;
  border-radius: 5px;
  font-weight: 600;
}
/* Enlarge control + full-screen comparison overlay (scrolls X and Y for wide/tall tables). */
.diff-tools {
  display: flex;
  justify-content: flex-end;
  margin: 0 16px 6px;
}
.diff-enlarge {
  padding: 4px 10px;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dmm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(8, 14, 26, 0.58);
}
.dmm-modal {
  display: flex;
  flex-direction: column;
  width: min(1200px, 96vw);
  max-height: 92vh;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}
.dmm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--accent);
  color: #fff;
}
.dmm-title {
  font-weight: 600;
  font-size: 14px;
}
.dmm-head .x {
  background: transparent;
  border: none;
  color: #fff;
  cursor: pointer;
  border-radius: 6px;
  padding: 4px;
  display: inline-grid;
  place-items: center;
}
.dmm-head .x:hover {
  background: rgba(255, 255, 255, 0.18);
}
.dmm-body {
  overflow: auto;
  padding: 12px;
}
.dmm-body .dmatrix {
  font-size: 12.5px;
}
.dmm-body .dmatrix th,
.dmm-body .dmatrix td {
  padding: 8px 12px;
}
.shared {
  margin: 12px 16px 4px;
  border-top: 1px solid var(--border);
  padding-top: 2px;
}
.shared-head {
  cursor: pointer;
  padding-left: 0 !important;
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  width: 100%;
  font-family: inherit;
}
.shared-head .chev2 {
  color: var(--faint);
  transition: transform 0.2s;
  margin-left: 2px;
  display: inline-grid;
  place-items: center;
}
.shared:not(.open) .shared-head .chev2 {
  transform: rotate(-90deg);
}
.shared-body {
  display: none;
}
.shared.open .shared-body {
  display: block;
}
.shared-body .miniwrap,
.shared-body .meta {
  padding-left: 0;
  padding-right: 0;
}

.status {
  height: 36px;
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  align-items: center;
  padding: 0 18px;
  font-size: 12px;
  color: var(--dim);
  gap: 14px;
  transition:
    background-color 0.35s,
    border-color 0.35s;
}
.status .mono {
  font-family: var(--mono);
}

/* popovers */
.pop {
  position: absolute;
  z-index: 50;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  padding: 6px;
  display: none;
}
.pop.show {
  display: block;
}
.pop-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--r-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  border: none;
  background: none;
  width: 100%;
  font-family: inherit;
  text-align: left;
}
.pop-item:hover {
  background: var(--surface-2);
}
.pop-item .pic {
  width: 18px;
  display: inline-grid;
  place-items: center;
  color: var(--accent);
}
.pop-item .desc {
  font-size: 11px;
  color: var(--faint);
}
/* The export menu (components/exportMenu.ts)
   ONE layout for both the whole-result Export and the pickbar's selected-files Download.

   The previous markup reused \`.desc\` - the package's faint 11px CAPTION style - for the PRIMARY
   label, and paired it with a \`.sub\` span that had no rule at all. Two inline spans with no line
   break and no hierarchy is why the menu read as
   "Intake catalogueintake-esm JSON for the whole result set". */
.xm-head {
  padding: 6px 10px 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--faint);
  text-transform: uppercase;
  /* The scope is stated ONCE, here, instead of being repeated in all three descriptions. */
}
.xm {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Never wider than the component it lives in: at a 320px mount the menu still fits. */
  max-width: min(340px, calc(100vw - 24px));
}
.xm-item {
  display: grid;
  /* fixed icon column | text | optional format marker */
  grid-template-columns: 22px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  width: 100%;
  min-height: 44px; /* a comfortable touch target */
  padding: 7px 10px;
  border: none;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.xm-item:hover {
  background: var(--surface-2);
}
.xm-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.xm-ic {
  display: inline-grid;
  place-items: center;
  color: var(--accent);
}
.xm-text {
  display: grid; /* label and description on their OWN lines - the actual bug */
  gap: 1px;
  min-width: 0;
}
.xm-label {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.xm-desc {
  font-size: 11px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.xm-fmt {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--faint);
  font-family: var(--mono);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.pop-sep {
  height: 1px;
  background: var(--border);
  margin: 5px 2px;
}
.pop-item.check.on .tick {
  margin-left: auto;
  color: var(--accent);
  font-weight: 700;
  display: inline-grid;
  place-items: center;
}

/* editors */
.editor {
  width: 300px;
  padding: 12px;
}
.editor h5 {
  margin: 0 0 10px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 7px;
}
.editor h5 .sub {
  font-weight: 500;
  color: var(--faint);
  font-size: 11px;
}
.editor .modes {
  display: flex;
  gap: 6px;
  margin: 10px 0;
}
.editor .modes button {
  flex: 1;
  height: 30px;
  border: 1px solid var(--border-2);
  background: var(--surface);
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--dim);
  cursor: pointer;
  font-family: inherit;
  font-weight: 600;
}
.editor .modes button.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.editor .modes button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.editor .mode-help {
  font-size: 11px;
  color: var(--faint);
  line-height: 1.45;
  min-height: 30px;
  margin-bottom: 8px;
}
.editor .daterow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.editor .daterow label {
  font-size: 11px;
  color: var(--faint);
  width: 34px;
}
.editor .daterow input {
  flex: 1;
  height: 32px;
  border: 1px solid var(--border-2);
  background: var(--surface-2);
  color: var(--text);
  border-radius: 6px;
  padding: 0 8px;
  font-family: var(--mono);
  font-size: 12px;
  outline: none;
}
.editor .daterow input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.editor .daterow input.bad {
  border-color: var(--danger);
}
.editor .actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.editor .actions .btn {
  flex: 1;
  justify-content: center;
}
.editor .preview {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--accent);
  background: var(--surface-2);
  border-radius: 6px;
  padding: 7px 9px;
  margin-top: 8px;
  word-break: break-all;
}
.editor .err-line {
  font-size: 11px;
  color: var(--danger);
  margin-top: 6px;
  min-height: 14px;
}
.draw-hint {
  font-size: 11px;
  color: var(--faint);
  text-align: center;
  margin-top: 6px;
}
.bbox-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 8px;
}
.bbox-fields .f {
  display: flex;
  align-items: center;
  gap: 5px;
}
.bbox-fields .f label {
  font-size: 10px;
  color: var(--faint);
  width: 42px;
}
.bbox-fields input {
  width: 100%;
  height: 28px;
  border: 1px solid var(--border-2);
  background: var(--surface-2);
  color: var(--text);
  border-radius: 5px;
  padding: 0 6px;
  font-family: var(--mono);
  font-size: 11px;
  outline: none;
}
.bbox-fields input:focus {
  border-color: var(--accent);
}
.bbox-fields input.bad {
  border-color: var(--danger);
}
.map-overlay {
  position: absolute;
  inset: 0;
  cursor: crosshair;
}

/* dev notes drawer */
.notes-drawer {
  position: fixed;
  right: 0;
  bottom: 0;
  top: 56px;
  width: 372px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow);
  transform: translateX(100%);
  transition: transform 0.3s;
  z-index: 60;
  display: flex;
  flex-direction: column;
}
.notes-drawer.show {
  transform: translateX(0);
}
.notes-drawer h4 {
  margin: 0;
  padding: 16px;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
  display: flex;
  align-items: center;
}
.notes-drawer h4 .x {
  margin-left: auto;
  cursor: pointer;
  border: none;
  background: none;
  color: var(--faint);
}
.notes-list {
  overflow-y: auto;
  padding: 8px 16px 20px;
}
.nl {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.nl .h {
  display: flex;
  align-items: center;
  gap: 9px;
  font-weight: 700;
  font-size: 13px;
  margin-bottom: 5px;
}
.nl .h .num {
  width: 19px;
  height: 19px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 800;
  flex-shrink: 0;
}
.nl p {
  margin: 0;
  font-size: 12.5px;
  color: var(--dim);
  line-height: 1.55;
}

.freva-db ::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.freva-db ::-webkit-scrollbar-thumb {
  background: var(--border-2);
  border-radius: 999px;
  border: 3px solid transparent;
  background-clip: padding-box;
}
@media (max-width: 1100px) {
  .details-panel {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 30;
    box-shadow: var(--shadow);
  }
}
@media (max-width: 680px) {
  .top {
    gap: 8px;
    padding: 0 10px;
  }
  .lens .k {
    display: none;
  } /* drop the "FLAVOUR" label; keep the value */
  .side {
    width: 208px;
  } /* results sidebar shrinks so content keeps room */
  .center-fixed {
    padding: 12px 12px 0;
  }
  .results-scroll {
    padding: 0 12px 92px;
  }
  .details-panel {
    width: min(360px, calc(100vw - 24px));
  } /* the details overlay fits a phone (still 0 when collapsed) */
  /* The panel controls (Select all / View / Details) reserve an invisible slot so Export doesn't shift
     when they fade in. On a phone that reserved slot wraps to a tall blank strip inside the result bar
     (the "weird big" section in Overview). Drop the reservation here - the controls still show when
     active (file panel scrolled into view). */
  .res-bar {
    padding: 8px 10px;
    gap: 8px;
  }
  .panelctl:not(.in) {
    display: none;
  }
}
@media (max-width: 460px) {
  .brand span {
    display: none;
  } /* just the mark on very small screens */
  .top {
    gap: 6px;
    padding: 0 8px;
  }
  .center-fixed {
    padding: 10px 10px 0;
  }
  .results-scroll {
    padding: 0 10px 92px;
  }
}
@media (max-width: 560px) {
  .fdb-app:not(.side-collapsed) .side {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 25;
    box-shadow: var(--shadow);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sk {
    animation: none;
  }
  .querying .bar::after {
    animation: none;
  }
}

/* Theme flip: the controller sets data-notransition around the data-theme swap so the
   variable re-resolve is ONE style pass instead of thousands of simultaneous per-node
   background/color animations (the measured cause of the toggle stutter). */
.freva-db[data-notransition],
.freva-db[data-notransition] * {
  transition: none !important;
}

/* Incremental long lists: the IO sentinel is invisible; the no-IO fallback button
   (also the deterministic path in tests) looks like the quiet inline affordances. */
.chunk-sentinel {
  height: 1px;
}
.chunk-more {
  display: block;
  width: 100%;
  padding: 7px 10px;
  margin: 2px 0;
  border: 1px dashed var(--border-2);
  border-radius: var(--r-sm);
  background: none;
  color: var(--dim);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.chunk-more:hover {
  background: var(--surface-2);
  color: var(--text);
}

/* Details partial-failure retry (extends the base .partial-flag rule above) */
.partial-flag {
  display: flex;
  align-items: center;
  gap: 8px;
}
.btn.sm {
  padding: 3px 9px;
  font-size: 11.5px;
}

/* Format thumbnails: the leading tile for zarr/nc/grib rows/cards. Other extensions
   keep the generic .ext text tile. The brand mark sits on a white chip so the fixed-palette logos
   (netCDF/GRIB/Intake are dark) read on light AND dark result cards. */
.ftile {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  line-height: 0;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 7px;
}
.gcard .ftile {
  width: 30px;
  height: 30px;
}
/* Small white chip for brand logos shown inline in menus/buttons (Export ▾, Details downloads). */
.brand-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 2px;
  line-height: 0;
}

/* Manual load-next with a proportion bar (no scroll auto-load: cheaper on Solr, no
   jank at thousands of rendered rows). */
.more-loader {
  margin: 14px 0 0;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--surface);
}
.more-info {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 12.5px;
  color: var(--dim);
}
.more-pct {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--faint);
}
.more-bar {
  height: 4px;
  background: var(--surface-3);
  border-radius: 2px;
  overflow: hidden;
  margin: 8px 0 10px;
}
.more-bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.25s ease;
}
.more-loader .load-next {
  margin: 0;
}

/* One loading language: the shared inline spinner primitive. */
.spin {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-2);
  border-top-color: var(--accent);
  border-radius: 999px;
  display: inline-block;
  vertical-align: -2px;
  animation: fdb-spin 0.7s linear infinite;
}
@keyframes fdb-spin {
  to {
    transform: rotate(360deg);
  }
}
.fdb-app[data-reduced-motion="true"] .spin {
  animation: none;
}

/* Flavour (naming) change: a clean spinner veil over the sidebar while labels/counts re-fetch. */
.side {
  position: relative;
}
.side-flavour-veil {
  position: absolute;
  inset: 0;
  display: none;
  place-items: center;
  z-index: 5;
  background: color-mix(in srgb, var(--surface) 45%, transparent);
}
.side-flavour-veil .spin {
  width: 22px;
  height: 22px;
  border-width: 2.5px;
}
.fdb-app.flavour-loading .side-flavour-veil {
  display: grid;
}
.fdb-app.side-collapsed .side-flavour-veil {
  display: none;
}

/* Chip/mode/diff tags replace the removed \`·\` separators with quiet grouping. */
.chip-tag {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.72;
  margin-left: 2px;
}
.mode-tag {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--faint);
  margin-left: 8px;
  font-family: var(--mono);
}
.varchip .vc-n {
  color: var(--accent);
  font-weight: 700;
  margin-left: 6px;
}

/* Config: brand description in the results scope line */
.scope-desc {
  font-size: 11.5px;
  color: var(--faint);
  margin-left: 2px;
}

/* Value-first main search dropdown */
.vsearch-pop {
  display: none;
  z-index: 60;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--r);
  box-shadow: var(--shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.4));
  max-height: 340px;
  overflow-y: auto;
  padding: 5px;
}
.vsearch-pop.show {
  display: block;
}
.vs-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border-radius: 7px;
  cursor: pointer;
}
.vs-item.hl,
.vs-item:hover {
  background: var(--accent-soft);
}
.vs-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 7px;
  border-radius: 999px;
  flex-shrink: 0;
}
.vs-val {
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  flex-shrink: 0;
}
.vs-desc {
  font-size: 11.5px;
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vs-cnt {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--faint);
  flex-shrink: 0;
}
.vs-empty {
  padding: 10px 12px;
  font-size: 12.5px;
  color: var(--faint);
}

/* Footer console + toasts */
.status {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 14px;
  user-select: none;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
  background: var(--faint);
}
.status-dot.info {
  background: var(--accent);
}
.status-dot.success {
  background: var(--good);
}
.status-dot.warn {
  background: var(--warn);
}
.status-dot.error {
  background: var(--danger);
}
/* The footer message itself is coloured by severity (green routine/ok, yellow warning, red
   error), so activity reads at a glance without an event-log panel. */
.status-msg.info,
.status-msg.success {
  color: var(--good);
}
.status-msg.warn {
  color: var(--warn);
}
.status-msg.error {
  color: var(--danger);
}
.status .spacer {
  flex: 1;
}
.log-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--dim);
  font-size: 11px;
  cursor: pointer;
}
.log-toggle:hover,
.log-toggle.on {
  color: var(--text);
  border-color: var(--border-2);
}
.log-count {
  font-family: var(--mono);
  font-size: 10.5px;
}

.console-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 36px;
  z-index: 55;
  display: none;
  max-height: 42%;
  background: var(--surface);
  border-top: 1px solid var(--border-2);
  box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.35);
  flex-direction: column;
}
.console-panel.show {
  display: flex;
}
.console-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.console-title {
  font-weight: 700;
  font-size: 12.5px;
}
.console-cap {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--faint);
}
.console-clear {
  margin-left: auto;
  height: 24px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border-2);
  background: var(--surface-2);
  color: var(--dim);
  font-size: 11.5px;
  cursor: pointer;
}
.console-clear:hover {
  color: var(--text);
}
.console-list {
  overflow-y: auto;
  padding: 4px 0;
}
.log-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 3px 14px;
  font-size: 12px;
}
.log-row:hover {
  background: var(--surface-2);
}
.log-time {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--faint);
  flex-shrink: 0;
}
.log-sev {
  font-family: var(--mono);
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
  width: 54px;
}
.log-sev.info {
  color: var(--accent);
}
.log-sev.success {
  color: var(--good);
}
.log-sev.warn {
  color: var(--warn);
}
.log-sev.error {
  color: var(--danger);
}
.log-msg {
  color: var(--dim);
}
.log-row.error .log-msg {
  color: var(--text);
}
.log-empty {
  padding: 14px;
  color: var(--faint);
  font-size: 12.5px;
}

/* Toasts live TOP-RIGHT (out of the way of the results/terminal, which own the lower half) and
   slide in from the right rather than popping up from the bottom. */
.toast-host {
  position: absolute;
  right: 16px;
  top: 60px;
  z-index: 140;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
/* Immediate, styled tooltip (replaces the slow native \`title\` popup - see components/tooltip.ts).
   Fixed-position so it is never clipped by a scroll container; flips/clamps to stay on screen. */
.fdb-tip {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 1500;
  pointer-events: none;
  max-width: 280px;
  padding: 5px 9px;
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.45;
  font-weight: 500;
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  white-space: normal;
  opacity: 0;
  transition: opacity 0.1s ease;
}
.fdb-tip.show {
  opacity: 1;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 320px;
  max-width: calc(100vw - 32px);
  padding: 11px 12px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--border-2);
  box-shadow:
    0 10px 30px rgba(0, 0, 0, 0.18),
    0 1px 0 rgba(255, 255, 255, 0.03) inset;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.45;
  pointer-events: auto;
  cursor: pointer;
  opacity: 0;
  transform: translateX(12px);
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.toast.in {
  opacity: 1;
  transform: translateX(0);
}
/* a status dot instead of a left bar - reads faster and keeps the card shape clean */
.toast::before {
  content: "";
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--accent);
}
.toast.success::before {
  background: var(--good);
}
.toast.warn::before {
  background: var(--warn);
}
.toast.error::before {
  background: var(--danger);
}
.toast.info::before {
  background: var(--accent);
}
.toast-msg {
  flex: 1;
}
.fdb-app[data-reduced-motion="true"] ~ .toast-host .toast,
.freva-db[data-reduced-motion="true"] .toast {
  transition: none;
}

/* Metadata-focused block controls: sort, collapse, additional */
.fcard-h .drag-grip {
  cursor: grab;
  color: var(--dim);
  font-size: 13px;
  margin-right: 2px;
  user-select: none;
  padding: 0 2px;
  opacity: 0.9;
  appearance: none;
  background: none;
  border: 0;
  font-family: inherit;
  line-height: 1;
}
.fcard-h .drag-grip:hover {
  color: var(--text);
  opacity: 1;
}
.fcard-h .drag-grip-fixed {
  cursor: default;
  opacity: 0.4;
}
.fcard-h .drag-grip-fixed:hover {
  color: var(--dim);
  opacity: 0.4;
}
.fcard-h button.drag-grip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-radius: 3px;
  color: var(--text);
}
.fcard.dragging {
  opacity: 0.55;
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.fcard.resizing {
  outline: 1px dashed var(--accent);
  outline-offset: -1px;
}
body.fdb-dragging {
  cursor: grabbing;
  user-select: none;
}
body.fdb-dragging * {
  user-select: none !important;
}
.fcard.collapsed .fcard-vals,
.fcard.collapsed .within {
  display: none;
}
.fcard-h .fh-label {
  font-weight: 600;
}
.ov-addrow {
  grid-column: 1 / -1;
}
.ov-addbtn {
  width: 100%;
  height: 40px;
  border-radius: var(--r-sm);
  border: 1px dashed var(--border-2);
  background: transparent;
  color: var(--dim);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.ov-addbtn:hover {
  color: var(--text);
  border-color: var(--accent);
}

/* Overview card drag-resize handle */
.fcard {
  position: relative;
}
.fcard-resize {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 14px;
  height: 14px;
  cursor: ew-resize;
  opacity: 0;
  z-index: 2;
  appearance: none;
  border: 0;
  padding: 0;
  background: linear-gradient(
    135deg,
    transparent 55%,
    var(--border-2) 55%,
    var(--border-2) 66%,
    transparent 66%,
    transparent 78%,
    var(--border-2) 78%,
    var(--border-2) 88%,
    transparent 88%
  );
  transition: opacity 0.12s;
}
.fcard:hover .fcard-resize {
  opacity: 1;
}
.fcard-resize:focus-visible {
  opacity: 1;
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.fcard.collapsed .fcard-resize {
  display: none;
}

/* Spinners: search-in-flight + export-in-progress */
.res-spin {
  display: none;
  align-items: center;
  margin-left: 2px;
}
.res-spin.show {
  display: inline-flex;
}
.iconbtn.busy {
  position: relative;
  color: transparent;
}
.iconbtn.busy svg {
  visibility: hidden;
}
.iconbtn.busy::after {
  content: "";
  position: absolute;
  inset: 0;
  margin: auto;
  width: 15px;
  height: 15px;
  border: 2px solid var(--border-2);
  border-top-color: var(--accent);
  border-radius: 999px;
  animation: fdb-spin 0.7s linear infinite;
}
.freva-db[data-reduced-motion="true"] .iconbtn.busy::after {
  animation: none;
}

/* read-only time/bbox prefix (always first) */
/* Read-only (time/bbox/flavour) tokens are deliberately NOT blue/amber - those colours mean
   "you typed this, you can edit it". They're also NOT boxed: a bordered chip read as an
   autocomplete row. They're plain, dimmed and italic - quietly present, clearly not editable. */
.tf-tok {
  white-space: nowrap;
  font-style: italic;
  opacity: 0.72;
}
.tf-k,
.tf-eq,
.tf-v {
  color: #7f8da3;
}

/* app-level Help panel (top bar) */
.help-pop {
  display: none;
  position: fixed;
  right: 18px;
  top: 62px;
  z-index: 130;
  width: min(400px, calc(100vw - 36px));
  padding: 16px;
  border-radius: var(--r);
  border: 1px solid var(--border-2);
  background: var(--surface);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.34);
}
.help-pop.show {
  display: block;
}
.help-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--text);
}
.help-head .t {
  font-weight: 700;
  font-size: 14px;
  flex: 1;
}
.help-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: none;
  color: var(--dim);
  border-radius: 6px;
  cursor: pointer;
}
.help-x:hover {
  background: var(--surface-2);
  color: var(--text);
}
.help-pop p {
  margin: 7px 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--dim);
}
.help-h2 {
  margin-top: 12px;
  font-weight: 700;
  font-size: 12.5px;
  color: var(--text);
}
.help-code {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: 7px;
  background: var(--surface-2);
  border: 1px solid var(--border-2);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  overflow-x: auto;
}
.help-dim {
  color: var(--dim);
  font-size: 11.5px;
}
.help-link {
  display: inline-block;
  margin-top: 8px;
  color: var(--accent);
  font-size: 12.5px;
  text-decoration: none;
}
.help-link:hover {
  text-decoration: underline;
}
.spacer {
  flex: 1 1 0;
  min-width: 0;
} /* above the editable kwargs */

/* Sidebar - one "Filter" header, sections named by what they are, each with its
   own search + capped scroll area. */

.side-filterhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 2px 10px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border-2);
}
.sf-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text);
}
.sf-badge {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  font-family: var(--mono);
  border: none;
  cursor: pointer;
  position: relative;
  transition: background-color 0.12s;
}
/* The global Filter total's hover treatment lives at the end of this sheet: a real element swap in
   a NEUTRAL colour. A red \`::after\` cross over a merely-transparent number puts two crosses on
   screen, and takes its red from \`--danger\`, which in a red-branded deployment is the accent. */

/* sections: a hairline rule between them, chevron on the RIGHT (the e-commerce convention) */
.facet {
  border-bottom: 1px solid var(--border-2);
  border-radius: 0;
}
.facet-head {
  height: auto;
  min-height: 44px;
  padding: 10px 10px;
  gap: 10px;
  border-radius: 6px;
}
.facet-head:focus-visible {
  outline-offset: -2px;
} /* inset, so it never lands on the text */
.special:focus-visible {
  outline-offset: -2px;
}
.facet-head:hover {
  background: none;
}
.facet-head:hover .fh-label {
  color: var(--accent);
}
.fh-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
/* the selected values, readable WITHOUT expanding the section */
.fh-sel {
  font-size: 11px;
  color: var(--dim);
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.facet.open .fh-sel {
  display: none;
} /* redundant once the values are visible below */
.facet-head .chev {
  margin-left: 0;
  transition: transform 0.2s;
}
.facet.open .facet-head .chev {
  transform: rotate(90deg);
} /* right -> down, not left */
.facet-head .badge,
.facet-head .fh-count {
  margin-left: 0;
}

/* per-facet search + a capped, scrollable value list (a facet may hold thousands of values) */
.fval-search {
  width: 100%;
  margin: 2px 0 8px;
  padding: 7px 9px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-2);
  background: var(--surface-2);
  color: var(--text);
  font-size: 12px;
}
.fval-search:focus {
  outline: none;
  border-color: var(--accent);
}
.fval-list {
  max-height: 240px;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-right: 2px;
}
.fval-list::-webkit-scrollbar {
  width: 8px;
}
.fval-list::-webkit-scrollbar-thumb {
  background: var(--border-2);
  border-radius: 4px;
}

/* interactive map: an on-demand upgrade over the instant SVG */
.map-slot {
  position: relative;
}
.map-zoom {
  position: absolute;
  right: 8px;
  top: 8px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-2);
  background: var(--surface);
  color: var(--dim);
  font-size: 11px;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
}
.map-zoom:hover {
  color: var(--text);
  border-color: var(--accent);
}
.map-zoom:disabled {
  cursor: default;
  opacity: 0.7;
}
/* once Leaflet is mounted the SVG underneath is redundant */
.minimap.has-leaflet > svg {
  display: none;
}
.lmap {
  width: 100%;
  height: 220px;
  border-radius: var(--r-sm);
  overflow: hidden;
}
.miniwrap .lmap {
  height: 180px;
}
.leaflet-container {
  background: var(--surface-2);
  font: inherit;
}

/* Metadata view (overview) */
.fcard.collapsed {
  height: auto !important;
  align-self: start;
  min-height: 0;
}
.fcard.collapsed .fcard-vals,
.fcard.collapsed .within,
.fcard.collapsed .fcard-special-body {
  display: none;
}
/* a minimized card must not keep its 2-block height */
.fcard.collapsed[data-rows="2"] {
  height: auto !important;
}

/* (a wider card gets more columns automatically from the auto-fill grid on .fcard-vals) */

/* resize grip: now a 2-D handle (sideways AND up), so say so */
.fcard-resize {
  cursor: nwse-resize;
}

/* the sort control shows its mode, not just an icon */
.sortbtn {
  width: auto;
  gap: 4px;
  padding: 0 6px;
}
.sortlbl {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.02em;
}

/* time / bbox cards wear the same chrome as the facet cards, and their editor is always visible */
.fcard.fcard-sp .badge.on {
  background: var(--accent);
  color: #fff;
}
.fcard-special-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 8px 8px;
}
/* Centred only while the content FITS. \`justify-content: center\` on a scroll container pushes
   overflow off both ends, and the start-side overflow is unreachable - which is how the From row
   ended up hidden beneath the card header. \`safe center\` falls back to start-alignment the moment
   the content is taller than the body. */
.fcard-special-body.time-body {
  display: flex;
  flex-direction: column;
  justify-content: safe center;
}
/* The inline editor is stretched to height:100% (so the bbox map can fill its card), which left
   nothing for the body's justify-content to centre. Centre the time picker's rows WITHIN that
   full-height editor instead. Only time - the bbox editor wants its map to fill. */
.fcard-special-body.time-body .editor.inline {
  justify-content: safe center;
}
/* the embedded editors size to the CARD instead of overflowing it */
.fcard-special-body .editor {
  border: none;
  box-shadow: none;
  padding: 0;
  background: none;
  width: auto;
}
.fcard-special-body .editor h5 {
  display: none;
} /* the card header already says what this is */
.fcard-special-body .minimap {
  width: 100%;
}
.fcard-special-body .minimap > svg {
  width: 100%;
  height: auto;
  display: block;
}

/* Leaflet attribution: required for OSM, but it was dominating a small card. Keep it, shrink it. */
.leaflet-control-attribution {
  font-size: 9px !important;
  padding: 0 4px !important;
  line-height: 1.4;
  background: rgba(255, 255, 255, 0.72) !important;
}
.leaflet-control-attribution a {
  color: var(--dim) !important;
  text-decoration: none;
}
.leaflet-control-zoom {
  margin: 6px !important;
}
.leaflet-control-zoom a {
  width: 22px !important;
  height: 22px !important;
  line-height: 22px !important;
  font-size: 14px !important;
}

/* overview: minimized rows must close up, not leave a hole */
.fcard.collapsed {
  height: auto !important;
  align-self: start;
  min-height: 0;
}

/* inline (in-card) editors: everything visible, nothing clipped */
.fcard-special-body {
  padding: 0 10px 10px;
}
.editor.inline {
  width: auto;
  padding: 0;
  border: none;
  box-shadow: none;
  background: none;
  gap: 6px;
}
.editor.inline h5 {
  display: none;
} /* the card header already names it */
.editor.inline .preview {
  display: none;
} /* the terminal shows the query; a card has no room */
.editor.inline .mode-help {
  font-size: 10.5px;
  line-height: 1.35;
}
.editor.inline .daterow {
  gap: 6px;
}
.editor.inline .daterow input {
  min-width: 0; /* a grid item's default \`min-width: auto\` would let the field push the row wider */
}
.editor.inline .modes {
  gap: 4px;
}
.editor.inline .modes .btn {
  padding: 3px 8px;
  font-size: 11px;
}
.editor.inline .bbox-fields {
  gap: 5px;
}
.editor.inline .bbox-fields input {
  min-width: 0;
}
.editor.inline .draw-hint {
  font-size: 10.5px;
}
/* the map scales to the card instead of overflowing it */

/* time / bbox blocks: same family, and legible inside one block */
.fcard.fcard-sp .fcard-special-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}
.editor.inline {
  display: flex;
  flex-direction: column;
  gap: 7px;
  height: 100%;
  min-height: 0;
}

/* the map takes the room that's left, so it fills the block instead of being a squashed strip */
.editor.inline .map-slot {
  flex: 1 1 auto;
  min-height: 130px;
  display: flex;
}
.editor.inline .minimap {
  flex: 1;
  display: flex;
  min-height: 130px;
}
.editor.inline .lmap {
  flex: 1 1 auto;
  height: auto;
  min-height: 130px;
}
.editor.inline .minimap > svg {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* bounds/dates: a tight 2-up grid rather than four stacked rows that overflow the card */
.editor.inline .bbox-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.editor.inline .bbox-fields .f {
  display: flex;
  align-items: center;
  gap: 4px;
}
.editor.inline .bbox-fields label {
  font-size: 10px;
  color: var(--faint);
  min-width: 34px;
}
.editor.inline .bbox-fields input {
  width: 100%;
  padding: 4px 6px;
  font-size: 11px;
}
/* THREE children, THREE columns: label, text field, calendar button.
   Declaring only \`34px 1fr\` puts the calendar button on an implicit second grid row, making each
   date row two lines tall. Two of those plus the mode buttons overflow the card body, and because
   the body centres its content the overflow goes off BOTH ends, clipping the From row under the
   card header. The third column is what holds it, not a taller card. */
.editor.inline .daterow {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
}
.editor.inline .daterow label {
  font-size: 10px;
  color: var(--faint);
}
.editor.inline .daterow input {
  padding: 5px 7px;
  font-size: 11.5px;
}
/* the mode help is one line in a card - the full text lives in the popover editor */
.editor.inline .mode-help {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 10px;
  color: var(--faint);
}
.editor.inline .draw-hint {
  display: none;
} /* the map itself says "drag" well enough in a card */

/* Leaflet: a container with a REAL height (never a % inside a flex chain), and the Draw/Pan
       toggle. A 0-height container is what makes Leaflet mis-tile and mis-map its coordinates. */
.lmap {
  position: relative;
  min-height: 130px;
  background: var(--surface-2);
  isolation: isolate; /* contain Leaflet's high pane z-indexes so the map never paints over the terminal (z-index 80) */
}
.lmap.drawing,
.lmap.drawing .leaflet-grab {
  cursor: crosshair;
}
/* While a rectangle is being dragged the pointer sweeps across the +/- controls and the attribution,
   and the browser treats that as a text selection - the controls light up with the selection
   highlight mid-gesture. Suppressing selection for the duration of Draw mode, on this map only,
   removes the highlight without touching hit-testing: the controls are still clickable, still
   focusable, still keyboard-activatable, and Pan mode selects text normally again. */
.lmap.drawing,
.lmap.drawing * {
  user-select: none;
  -webkit-user-select: none;
}
.lmap-mode {
  position: absolute;
  right: 8px;
  top: 8px;
  z-index: 500; /* above Leaflet panes */
  padding: 4px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-2);
  background: var(--surface);
  color: var(--dim);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
}
.lmap-mode.on {
  border-color: var(--accent);
  color: var(--accent);
}
.lmap-mode:hover {
  color: var(--text);
}

/* Leaflet hygiene 
   Leaflet sizes and positions its tiles in JS assuming ITS OWN css. Application-wide resets that
   reach inside \`.leaflet-container\` are the classic cause of a mosaic-looking map, so we explicitly
   keep our resets out of it. */
.freva-db .leaflet-container,
.freva-db .leaflet-container * {
  box-sizing: content-box;
}
.freva-db .leaflet-container img {
  max-width: none !important;
  max-height: none !important;
}
.freva-db .leaflet-pane,
.freva-db .leaflet-tile,
.freva-db .leaflet-marker-icon {
  position: absolute;
}
.freva-db .leaflet-tile {
  padding: 0;
  border: 0;
}

/* Controls: two labelled TASK modes on top; view/details/export in the result bar.
   (Four icon-only buttons in a row answered three different questions at once.) */
.ctrl-cluster .ctrl {
  width: auto;
  height: 30px;
  padding: 0 11px;
  gap: 6px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
}
.ctrl-lbl {
  font-size: 12.5px;
  font-weight: 650;
  letter-spacing: 0.005em;
}

/* status text, not a control - a pill shape here reads as clickable */
.scope-lbl {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
}
.view-lbl {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--faint);
}

/* labelled buttons in the result bar */
.tbtn {
  width: auto;
  height: 30px;
  padding: 0 10px;
  gap: 6px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  border: 1px solid transparent;
}
.tbtn:hover {
  background: var(--surface-2);
  color: var(--accent);
}
/* Export locked past the 100k ceiling: greyed out, not-allowed cursor, no hover lift. The click
   handler already refuses to export; this makes it LOOK unavailable. Hover still shows the tooltip. */
.tbtn.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
  color: var(--dim);
}
.tbtn.is-disabled:hover {
  background: transparent;
  color: var(--dim);
}
.tbtn[hidden] {
  display: none;
}
.tbtn.on {
  color: var(--accent);
  background: var(--surface-2);
  border-color: var(--border);
}
.tbtn-lbl {
  font-size: 12px;
  font-weight: 600;
}
@media (max-width: 760px) {
  .tbtn-lbl,
  .view-lbl,
  .scope-lbl {
    display: none;
  }
}

/* overview: share-of-result-set bar per value
   The bar is the value's share of the WHOLE result set (count / totalCount), so a bar means the
   same thing in every card and cards can be compared with each other. A per-card scale made every
   card's top value look "full", which is why \`historical\` (17%) and \`cmip6\` (56%) looked alike.

   Drawn as a tinted fill BEHIND the row via ::before - no extra DOM node, and it reads as a bar
   chart rather than an underline. \`--pct\` is set per row in overview.ts. */
.fcard .fval {
  position: relative;
  isolation: isolate;
  border-radius: 6px;
}
.fcard .fval.has-bar::before {
  content: "";
  position: absolute;
  z-index: -1;
  left: 0;
  top: 2px;
  bottom: 2px;
  width: var(--pct, 0%);
  min-width: 2px;
  border-radius: 5px;
  /* derived from the accent so re-theming (any --accent) recolours every bar in one place */
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 18%, transparent),
    color-mix(in srgb, var(--accent) 6%, transparent)
  );
  transition: width 0.18s ease;
}
.fcard .fval.has-bar:hover::before {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 26%, transparent),
    color-mix(in srgb, var(--accent) 9%, transparent)
  );
}
.fcard .fval.sel.has-bar::before {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 36%, transparent),
    color-mix(in srgb, var(--accent) 13%, transparent)
  );
}
/* Dark mode: the same accent needs more alpha to read on the dark surface. Still derived from
   --accent, so a custom accent recolours the dark bars too. */
.freva-db[data-theme="night"] .fcard .fval.has-bar::before {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 36%, transparent),
    color-mix(in srgb, var(--accent) 15%, transparent)
  );
}
.freva-db[data-theme="night"] .fcard .fval.has-bar:hover::before {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 50%, transparent),
    color-mix(in srgb, var(--accent) 21%, transparent)
  );
}
.freva-db[data-theme="night"] .fcard .fval.sel.has-bar::before {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 64%, transparent),
    color-mix(in srgb, var(--accent) 27%, transparent)
  );
}
/* the count must stay readable where the bar runs under it */
.fcard .fval .n {
  position: relative;
  z-index: 1;
}

/* data-inspector: themed to the databrowser (blue), auto-following light/night
   The <data-inspector> (lazy CDN component) renders inside .freva-db, so our design tokens are in
   scope. We map them onto the component's public knobs (--di-*), so the modal follows the app theme
   instead of prefers-color-scheme. On top of that:
     • a solid blue header - there is no --di-header-bg knob, so we colour .di-header directly and
       flip its text to white (this mirrors what other embedders like grid-doctor do);
     • the Load button is inverted (white-on-blue) so it doesn't vanish into the header;
     • the xarray repr caps itself at max-width:700px, which reads as "left-aligned" in the wide
       modal - we lift the cap so metadata fills the width, like grid-doctor's docs.
   These header/xr overrides target the package's internal classes and are therefore version-coupled;
   they degrade gracefully (a class rename just falls back to the component's own defaults). */
.freva-db data-inspector {
  --di-bg: var(--surface);
  --di-fg: var(--text);
  --di-muted: var(--dim);
  --di-border: var(--border);
  --di-surface: var(--surface-2);
  --di-accent: var(--accent);
  /* The xarray repr colours default to a fixed LIGHT palette (--jp-* and white fallbacks), so
     the metadata table ignored the app theme. Map them onto our tokens so the table follows light/night. */
  --xr-font-color0: var(--text);
  --xr-font-color2: var(--dim);
  --xr-font-color3: var(--dim);
  --xr-border-color: var(--border);
  --xr-disabled-color: var(--dim);
  --xr-background-color: var(--surface);
  --xr-background-color-row-even: var(--surface);
  --xr-background-color-row-odd: var(--surface-2);
  /* The chunk-cube diagram (shown on an expanded variable) defaults to Freva's brown
     (#9b7a52). Shade it from our accent so it reads as the dominant blue, in both themes. */
  --xr-chunk-face: var(--accent);
  --xr-chunk-top: color-mix(in srgb, var(--accent) 68%, #fff);
  --xr-chunk-side: color-mix(in srgb, var(--accent) 80%, #000);
  --xr-chunk-edge: color-mix(in srgb, var(--accent) 38%, #fff);
}
/* For a direct zarr store the resolved URL IS the file path, so the component's "Zarr:" row
   just duplicates the path bar above it. Our inspector only ever loads zarr stores, so suppress it.
   (If server-side non-zarr->zarr conversion is ever wired, revisit - then the URLs genuinely differ.) */
.freva-db data-inspector .di-zarr-row {
  display: none !important;
}
.freva-db data-inspector .di-header {
  background: var(--accent);
  border-bottom: none;
}
.freva-db data-inspector .di-header .di-title,
.freva-db data-inspector .di-header .di-title-ico,
.freva-db data-inspector .di-header .di-pathbar-label,
.freva-db data-inspector .di-header .di-muted,
.freva-db data-inspector .di-header .di-close {
  color: #fff;
}
.freva-db data-inspector .di-header .di-close:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}
.freva-db data-inspector .di-header .di-btn-primary {
  background: #fff;
  border-color: #fff;
  color: var(--accent);
}
.freva-db data-inspector .di-header .di-btn-primary:hover:not(:disabled) {
  filter: none;
  background: rgba(255, 255, 255, 0.88);
}
.freva-db data-inspector .di-header .di-btn-split {
  border-left-color: rgba(0, 0, 0, 0.12);
}
/* Let the metadata fill the modal instead of the built-in 700px cap. */
.freva-db data-inspector .xr-wrap {
  max-width: none;
}
/* Production hardening. Each block names the defect it removes. */

/* Screen-reader-only utilities
   Used by the in-field search status and, when \`features.footer:false\`, by the status region.
   \`display:none\` / \`visibility:hidden\` would take the node OUT of the accessibility tree and
   silence the live region - which is the whole reason this class exists. */
.freva-db .sr-only,
.freva-db .sr-status {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* Footer as an independent option
   The grid drops to two rows, so the strip consumes NO height (rather than being painted and then
   hidden, which still reserves its track). */
.freva-db .fdb-app.no-footer {
  grid-template-rows: auto 1fr;
}

/* Overlays are COMPONENT-scoped, not viewport-scoped
   All three overlay owners now append to \`.freva-db\` and are positioned absolutely in its
   coordinate space by anchor.ts. \`position: fixed\` here would re-introduce exactly the embedded-host
   bug that fix exists to remove (a transformed/contained ancestor changes what \`fixed\` resolves
   against, and an \`overflow:hidden\` mount clips whatever lands outside it). */
.freva-db .fdb-tip {
  position: absolute;
  /* A very long unbroken label - a deep path, an ensemble id - must not push the bubble past a
     viewport edge, and must not render as one unwrappable line. */
  max-inline-size: min(280px, calc(100vw - 16px));
  overflow-wrap: anywhere;
  word-break: normal;
}

/* Chips: one long value cannot own the row
   Without a bounded, ellipsised label an unbroken value stretched its chip past the available
   width, pushing Clear all and the Browse/Overview cluster off a phone screen. The full value stays
   available as the tooltip and the accessible name. */
.freva-db .chip {
  min-width: 0;
  max-width: 100%;
}
.freva-db .chip-label {
  min-width: 0;
  max-inline-size: min(22ch, 60vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The NEGATIVE chip is neutral - dotted, hatched, struck on the value only. \`--danger\` red says
   nothing in a red-branded deployment, in greyscale or in forced colours. Its rules live at the end of this sheet with the rest of the language. */
/* An IMMUTABLE base-scope indicator. Not a button: there is nothing to click, and "Clear all"
   deliberately does not touch it. */
.freva-db .chip.scope {
  background: var(--surface-3);
  color: var(--dim);
  border: 1px solid var(--border);
  cursor: default;
  font-weight: 600;
}

/* The top row wraps DETERMINISTICALLY at phone widths
   Chips take a full-width row of their own; Clear all and the Browse/Overview cluster share the
   next one. Nothing is absolutely positioned, so they cannot overlap however long the labels get.
   An empty chip row collapses instead of leaving a blank strip. */
.freva-db .chips.empty {
  display: none;
}
@media (max-width: 430px) {
  .freva-db .toprow {
    flex-wrap: wrap;
    align-items: center;
    row-gap: 8px;
  }
  .freva-db .toprow > .chips {
    flex: 1 0 100%; /* own row */
    order: 1;
  }
  .freva-db .toprow > .clear-btn {
    order: 2;
  }
  .freva-db .toprow > .ctrl-cluster {
    order: 3;
    margin-left: auto; /* the following row, right-aligned - never overlapping the chips */
  }
  .freva-db .chip-label {
    max-inline-size: min(18ch, 52vw);
  }
}

/* The list header stays visible
   It sticks INSIDE \`.results-scroll\` (it deliberately stays out of \`.rows\`, whose children are
   counted by the incremental append). Overview/terminal content above it scrolls away first,
   because sticking only begins once the header reaches the top of the scroller. */
.freva-db .results-scroll .list-head {
  position: sticky;
  top: 0;
  z-index: 6; /* above rows, below the pickbar/popovers/toasts */
  /* Opaque: rows scrolling underneath a translucent header is unreadable. A z-index alone would
     only put the strip BEHIND the header. What holds is that there is no band for rows to occupy
     (see \`.results-scroll\`'s padding); this keeps whatever does pass under it hidden. */
  background: var(--surface-2);
  box-shadow: 0 1px 0 var(--border);
  /* SQUARE top corners. The header's background is opaque, but a rounded corner is not part of the
     background - it is a hole, and a row passing underneath shows through the two little curved
     wedges at the top left and top right. There is no honest way to round the corner of something
     other content slides beneath, so the corner goes rather than the opacity. \`.rows\` already
     squares its own top corners when the header is present, so the two still read as one table. */
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

/* The comparison matrix has a bounded height
   Growing with the number of differing fields would push the rest of the Details panel out of
   reach. A SHORT comparison still uses only the height it needs (max-height, not height). */
.freva-db .dscroll {
  max-height: clamp(180px, 38vh, 360px);
  overflow: auto; /* both axes */
}
.freva-db .dmatrix thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-2); /* opaque, or the scrolled rows show through the header */
}

/* Include / exclude, side by side
   TWO sibling controls. Nesting a button inside the button-like value row would be invalid HTML and
   unreliable for AT and touch. */
.freva-db .fval-row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.freva-db .fval-row > .fval {
  flex: 1;
  min-width: 0;
}
.freva-db .fval-ex {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  border: 1px solid transparent;
  background: none;
  color: var(--faint);
  font-family: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  /* Compact on pointer devices: revealed on hover/focus-within, so the row stays calm. */
  opacity: 0;
  transition: opacity 0.12s;
}
.freva-db .fval-row:hover .fval-ex,
.freva-db .fval-row:focus-within .fval-ex,
.freva-db .fval-ex:focus-visible,
.freva-db .fval-ex.on {
  opacity: 1;
}
.freva-db .fval-ex:hover {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}
.freva-db .fval-ex.on {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}
/* An EXCLUDED value in a FACET LIST: struck through, \`!=\`-marked and latched with a dashed control.
   The strike belongs here - a value list is a set of things you are choosing between, and the line
   is what shows at a glance which ones are out. The top-level CHIPS are the opposite case: there
   the value IS the label you have to read, so those are left unstruck. */
.freva-db .fval.excl .nm {
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}
.freva-db .fval.excl {
  color: var(--danger);
}
/* On a touch layout there is no hover, so the control must be permanently discoverable. */
@media (hover: none), (pointer: coarse) {
  .freva-db .fval-ex {
    opacity: 1;
  }
}

/* Selection cap */
.freva-db .cb.capped {
  opacity: 0.4;
  cursor: not-allowed;
}
.freva-db .pickbar .cnt.at-cap b {
  color: var(--warn);
}

/* Remote source-file list */
.freva-db .dl-pop {
  width: min(460px, calc(100% - 24px));
}
.freva-db .dl-head {
  font-weight: 700;
  font-size: 13px;
  padding: 4px 8px 2px;
}
.freva-db .dl-note {
  font-size: 11.5px;
  color: var(--dim);
  padding: 0 8px 8px;
  line-height: 1.5;
}
.freva-db .dl-list {
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.freva-db .dl-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 7px;
  color: var(--text);
  text-decoration: none;
  font-size: 12.5px;
  min-width: 0;
}
.freva-db .dl-item:hover {
  background: var(--surface-2);
}
.freva-db .dl-name {
  font-weight: 600;
  flex-shrink: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.freva-db .dl-path {
  color: var(--faint);
  font-family: var(--mono);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl; /* keep the informative TAIL of a long path visible */
  text-align: left;
}

/* Native date picker beside the text field
   The text input remains the source of truth (it is the only one that can express YYYY, YYYY-MM
   and open bounds); the native input exists solely to raise the platform calendar. */
.freva-db .date-pickwrap {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}
.freva-db .date-pick {
  width: 30px;
  height: 30px;
  display: inline-grid;
  place-items: center;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--dim);
  cursor: pointer;
}
.freva-db .date-pick:hover {
  border-color: var(--border-2);
  color: var(--text);
}
/* Present for showPicker()/focus(), but never a second visible field or a tab stop. */
.freva-db .date-native {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  pointer-events: none;
  border: 0;
  padding: 0;
}

/* Flavour control: a real control, not a caption
   Layout only - the switching logic was already correct. */
.freva-db .lens {
  height: 43px;
  min-width: 160px;
  padding: 0 12px;
  gap: 10px;
  background: var(--surface); /* opaque - it sits over the top bar, not in it */
  border-color: var(--border-2);
  box-shadow: 0 1px 2px rgba(16, 28, 52, 0.06);
}
.freva-db .lens .v {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.freva-db .lens svg {
  flex-shrink: 0;
  margin-left: auto; /* the caret stays pinned at the far edge as the value flexes */
}
/* The menu is never narrower than the control it drops from. */
.freva-db .lens-pop {
  min-width: 170px;
}
.freva-db .lens-pop .pop-item {
  padding: 9px 11px;
}
.freva-db .lens-pop .pop-item.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
@media (max-width: 680px) {
  /* Dropping the FLAVOUR caption is fine; a usable value width and touch target are not optional. */
  .freva-db .lens {
    min-width: 108px;
    height: 42px;
  }
}

/* Search is the primary control */
.freva-db .search input {
  height: 45px;
  font-size: 14.5px;
  background: var(--surface); /* opaque, so it reads as raised rather than as part of the bar */
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  padding-right: 38px; /* the reserved spinner slot */
}
.freva-db .search .ic {
  color: var(--accent);
}
.freva-db .search input::placeholder {
  /* Explicit colour AND opacity:1 - the UA default is a low-opacity render of the text colour,
     which lands well under 4.5:1 and differs between engines. */
  color: var(--faint);
  opacity: 1;
}
.freva-db .search input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
/* The slot is ALWAYS reserved; only visibility changes, so showing the spinner shifts nothing. */
.freva-db .search-spin {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  visibility: hidden;
  color: var(--accent);
}
.freva-db .search-spin.show {
  visibility: visible;
}
@media (prefers-reduced-motion: reduce) {
  /* Still visibly BUSY, just not spinning: a static ring rather than nothing at all. */
  .freva-db .search-spin .spin {
    animation: none;
    border-top-color: currentColor;
    opacity: 0.85;
  }
}

/* Small-text legibility
   Meaningful 9.5-10px labels move to 11px where the space exists. Hierarchy comes from weight,
   spacing and grouping - not from making text too faint to read. */
.freva-db .dmatrix thead th,
.freva-db .list-head,
.freva-db .dl-path,
.freva-db .fval .n {
  font-size: 11px;
}
.freva-db .scope-note,
.freva-db .more-info {
  font-size: 11.5px;
}
.freva-db input::placeholder,
.freva-db textarea::placeholder {
  color: var(--faint);
  opacity: 1;
}
/* Disabled text still has to be READ to be understood. 0.5 alpha on --dim does not clear 4.5:1. */
.freva-db .btn:disabled,
.freva-db [aria-disabled="true"] {
  opacity: 0.72;
}

/* 1,000-row interaction cost
   \`content-visibility\` lets the engine skip layout and paint for rows that are off screen.
   \`contain-intrinsic-size\` supplies a placeholder box so the scrollbar stays honest and the
   scroll position does not jump. Checked in Chromium against focus, keyboard navigation, the
   sticky list header and scrolling. Engines that ignore these properties simply render every row,
   exactly as before - the fallback is doing nothing. */
.freva-db .rows > .row {
  content-visibility: auto;
  contain-intrinsic-size: auto 48px;
}
.freva-db .grid > .gcard {
  content-visibility: auto;
  contain-intrinsic-size: auto 132px;
}
/* At or above the documented threshold (MANY_RESULTS_THRESHOLD = 500 loaded rows) the side panels
   stop ANIMATING their width. A width transition on a panel re-lays-out the centre column on every
   animation frame; with 1,000 rows in it, that is the measured cost of opening Details or
   collapsing the sidebar. The panels still change state instantly - only the tween is dropped. */
.freva-db.many-results .side,
.freva-db.many-results .details-panel {
  transition: none;
}
@media (max-width: 1100px) {
  /* Where the details panel is already an OVERLAY it does not reflow the grid, so its motion is
     compositor-only and can stay. */
  .freva-db.many-results .details-panel {
    transition: transform 0.18s ease;
  }
}

/* The top bar fits a phone
   At 320px the brand, the flavour control, the search field and four icon buttons cannot all keep
   their comfortable sizes. Rather than let the bar set a min-content width that pushes the entire
   app off screen, the negotiable parts give way in a defined order: the brand mark stays, the
   flavour control shrinks to a usable-but-tight touch target, and the search field keeps the rest. */
@media (max-width: 430px) {
  .freva-db .top {
    gap: 6px;
    padding: 0 8px;
  }
  .freva-db .lens {
    min-width: 84px;
    padding: 0 8px;
    gap: 4px;
  }
  .freva-db .search input {
    padding-left: 34px;
    padding-right: 32px;
  }
  .freva-db .search .ic {
    left: 10px;
  }
}

/* INCLUSION vs EXCLUSION - told apart by CHARACTER and SHAPE, not by colour

   The host's accent is configurable and may itself be red, so "accent = kept, red = removed" is not
   a distinction at all in some deployments - and it is none whatsoever in greyscale, in
   \`forced-colors\`, or to a colour-blind reader. Every surface carries the meaning twice:

     +N   kept      a FILLED badge, and the control that clears ONLY the kept values
     -N   removed   a DASHED outlined badge, and the control that clears ONLY the removed ones
     !=   an excluded VALUE, struck through, on a dotted hatched chip

   Colour still reinforces all of it; it is simply never the only carrier. */

/* The per-facet +N / -N clear buttons */
.freva-db .fh-count {
  position: relative;
  display: inline-grid;
  place-items: center;
  /* Sized by the COUNT either way, so swapping in the cross cannot make the header jump.
     \`--fb-ch\` is the count's character length, set when the button is built. */
  min-width: calc(var(--fb-ch, 2) * 1ch + 16px);
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 10.5px;
  font-weight: 800;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  flex: none;
  transition: background-color 0.12s;
}
.freva-db .fh-count.fb-inc {
  background: var(--accent);
  color: #fff;
}
.freva-db .fh-count.fb-exc {
  background: transparent;
  /* \`currentColor\`, not the danger colour: in forced-colors the dash survives and the hue need not.
     The dashes ARE the signal. */
  border: 1px dashed currentColor;
  color: var(--text);
  font-weight: 700;
}
/* The count and the cross occupy the SAME grid cell and exactly one is rendered. Fading a cross in
   on top of a number leaves both readable at once, which is what "no overlap" rules out. */
.freva-db .fh-count > .fb-n,
.freva-db .fh-count > .fb-x {
  grid-area: 1 / 1;
}
.freva-db .fh-count > .fb-x {
  display: none;
  font-size: 13px;
  font-weight: 800;
  line-height: 1;
  /* NEUTRAL - the button's own text colour, never \`--danger\` and never the accent, both of which
     can be the same red in a themed deployment. */
  color: currentColor;
}
.freva-db .fh-count:hover > .fb-n,
.freva-db .fh-count:focus-visible > .fb-n {
  display: none;
}
.freva-db .fh-count:hover > .fb-x,
.freva-db .fh-count:focus-visible > .fb-x {
  display: block;
}
/* Hover changes what is WRITTEN, not what shape the badge is: solid stays solid, dashed dashed. */
.freva-db .fh-count.fb-inc:hover,
.freva-db .fh-count.fb-inc:focus-visible {
  background: color-mix(in srgb, var(--accent) 78%, var(--text));
  outline: none;
}
.freva-db .fh-count.fb-exc:hover,
.freva-db .fh-count.fb-exc:focus-visible {
  background: color-mix(in srgb, currentColor 10%, transparent);
  outline: none;
}

/* The facet header is a ROW of siblings, never nested buttons */
.freva-db .facet-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.freva-db .facet-head > .fh-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.freva-db .facet-head > .fh-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 6px;
}

/* The GLOBAL Filter total: ONE number, swapped for ONE cross */
.freva-db .sf-badge {
  position: relative;
  display: inline-grid;
  place-items: center;
  min-width: calc(var(--fb-ch, 1) * 1ch + 14px);
  height: 20px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.freva-db .sf-badge > .sf-n,
.freva-db .sf-badge > .sf-x {
  grid-area: 1 / 1;
}
.freva-db .sf-badge > .sf-x {
  display: none;
  font-size: 14px;
  line-height: 1;
  color: currentColor;
}
.freva-db .sf-badge:hover > .sf-n,
.freva-db .sf-badge:focus-visible > .sf-n {
  display: none;
}
.freva-db .sf-badge:hover > .sf-x,
.freva-db .sf-badge:focus-visible > .sf-x {
  display: block;
}

/* An excluded VALUE, in the lists */
.freva-db .fval-row.excl .nm,
.freva-db .fval.excl .nm,
.freva-db .fval.excl .fv-t {
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}
.freva-db .fval-row.excl .nm::before,
.freva-db .fval.excl .nm::before,
.freva-db .fval.excl .fv-t::before {
  content: "\\2260\\00a0";
  text-decoration: none;
  display: inline-block;
  font-weight: 700;
}
.freva-db .fval-row.excl .fval-ex,
.freva-db .fval-row .fval-ex[aria-pressed="true"] {
  border: 1px dashed currentColor;
  border-radius: 5px;
}

/* Negative top-level chips: neutral, dotted, hatched */
/* No \`--danger\`, no red, no accent. The chip reads as "removed" from its dotted outline, its \`NOT\`
   tag, its \`!=\` operator and a subtle static hatch - all theme-neutral, so the same treatment works
   in a dark theme, a light one and a red-branded deployment alike. */
.freva-db .chip.neg {
  border: 1px dotted var(--border-2);
  color: var(--text);
  background-color: var(--surface-2);
  /* Built from the TEXT colour at low alpha, so it follows the theme rather than carrying one of
     its own, and it is static - a moving pattern behind a label is unreadable. */
  background-image: repeating-linear-gradient(
    -45deg,
    color-mix(in srgb, var(--text) 9%, transparent) 0 1px,
    transparent 1px 6px
  );
}
.freva-db .chip.neg .chip-label {
  display: inline-flex;
  align-items: baseline;
  min-width: 0;
  overflow: hidden;
}
.freva-db .chip.neg .chip-k,
.freva-db .chip.neg .chip-op,
.freva-db .chip.neg .chip-tag,
.freva-db .chip.neg .x {
  color: var(--text);
  text-decoration: none;
}
/* The value is NOT struck through: the dotted outline, the hatch, \`NOT\` and \`!=\` carry the meaning,
   and an unstruck value stays legible - which matters most for the long ones. */
.freva-db .chip.neg .chip-v {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.freva-db .chip.neg .chip-tag {
  background: none;
  border: 1px dotted currentColor;
  border-radius: 3px;
  padding: 0 3px;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.04em;
  opacity: 0.85;
}
.freva-db .chip.neg .x {
  opacity: 0.9;
}

@media (forced-colors: active) {
  /* No hatch survives forced colours, and none is needed: the dotted border, \`NOT\` and \`!=\` carry
     it on their own. */
  .freva-db .chip.neg {
    background-image: none;
    border-style: dotted;
  }
  .freva-db .fh-count.fb-inc {
    border: 1px solid CanvasText;
  }
  .freva-db .fh-count.fb-exc {
    border: 1px dashed CanvasText;
  }
  .freva-db .fval-row.excl .fval-ex {
    border-style: dashed;
  }
}
`;
