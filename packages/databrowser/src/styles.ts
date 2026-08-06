// styles.ts - the stylesheet as a string, injected into a <style> element on mount.
// GENERATED from styles.css by scripts/gen-styles.mjs - do not edit by hand; edit styles.css
// and run `npm run gen:styles`. The component bundles no CSS file, so the tokens + component
// styles live here as one constant.

export const STYLES = `/* styles.css - tokens + component styles for both themes (+ the terminal's own dark tokens).
   Ported from the prototype (the binding pixel source). The generic \`.overview\` class is
   renamed to \`.overview-mode\` to avoid a class collision that blanks the page. */

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
  --faint: #8a97ac;
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
  --faint: #5e6e88;
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
  grid-template-columns: auto 1fr auto;
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
/* P1 collapsible: the sidebar collapses to a slim rail with a reopen affordance; persisted. */
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
.facet-head .fh-count {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  display: inline-grid;
  place-items: center;
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

/* CENTER */
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
  padding: 8px 18px 92px;
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
/* #1 - "stacked": every block a full-width row. A single column forces full width regardless of each
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
/* #1 - value lists lay out as a GRID that fits as many ~200px columns as the width allows and then
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
/* #2 - the header toggles collapse/expand; make that obvious (its own controls keep their cursors). */
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
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  display: inline-grid;
  place-items: center;
  font-family: var(--mono);
}
/* the selected-count badge is a "clear this facet" control. On hover/focus the count
   is replaced by a red × (a ::after overlay - the number just goes transparent), and clicking it
   clears every selected value for that facet. Shared by the sidebar and the overview card header. */
.fh-count {
  position: relative;
  cursor: pointer;
  transition: background-color 0.12s;
}
.fh-count:hover,
.fh-count:focus-visible {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: transparent;
  outline: none;
}
.fh-count:hover::after,
.fh-count:focus-visible::after {
  content: "\\00d7";
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--danger);
  font-weight: 800;
  font-size: 13px;
  font-family: var(--font);
}
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
/* #3 - Select-all (in the results bar, both list + grid). Reuses the .cb checkbox box. */
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

/* terminal - keeps its own dark tokens so it stays dark in day theme */
/* Terminal colours are user-chosen and PERSISTED; each preset ships its own
   foreground so text can never end up unreadable. Defaults to black. */
.cmd {
  --term-bg: #0b0f16;
  --term-fg: #d8e2f2;
  --term-alpha: 0.94;
  /* token colours; the light presets override these (see [data-term-light]) */
  --term-prompt: #28c840;
  --term-key: #8fb6ff;
  --term-val: #f0b86b;
  --term-dim: #6f7f9c;
  --term-ghost: #4d5d78;
  --term-hint: #7fd7c4;
  --term-ph: #5b6a86;
  display: none;
  border-radius: 10px;
  overflow: visible;
  /* a hint of the page behind the window - tunable in the ⋮ menu, persisted */
  background: color-mix(in srgb, var(--term-bg) calc(var(--term-alpha) * 100%), transparent);
  backdrop-filter: blur(10px) saturate(120%);
  -webkit-backdrop-filter: blur(10px) saturate(120%);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: var(--shadow);
  color: var(--term-fg);
}
/* corners still clip their own content, but the window doesn't clip its popovers (the ⋮ menu) */
.cmd .term-bar {
  border-radius: 10px 10px 0 0;
}
/* light presets (e.g. Paper): the token palette has to flip too, or the text is unreadable */
.cmd[data-term-light="true"] {
  --term-prompt: #1f7a33;
  --term-key: #2d5fb8;
  --term-val: #a05a12;
  --term-dim: #6a7383;
  --term-ghost: #a3acbb;
  --term-hint: #1d7d6c;
  --term-ph: #99a2b0;
  border-color: rgba(0, 0, 0, 0.18);
}
.cmd[data-term-light="true"] .term-bar {
  background: color-mix(in srgb, var(--term-bg) 88%, #000 6%);
  border-bottom-color: rgba(0, 0, 0, 0.12);
}
.cmd[data-term-light="true"] .term-menu {
  background: color-mix(in srgb, var(--term-bg) 94%, #000 5%);
  border-color: rgba(0, 0, 0, 0.18);
}
.cmd[data-term-light="true"] .tm-item {
  color: #22262b;
}
.cmd[data-term-light="true"] .te-menu,
.cmd[data-term-light="true"] .py-menu {
  border-color: rgba(0, 0, 0, 0.16);
  background: rgba(0, 0, 0, 0.03);
}
.cmd[data-term-light="true"] .cmd-tab {
  color: #5b6472;
}
.cmd[data-term-light="true"] .cmd-tab:not(.on):hover {
  background: rgba(0, 0, 0, 0.05);
}
.cmd[data-term-light="true"] .term-kebab,
.cmd[data-term-light="true"] .copy-btn {
  color: #5b6472;
}
.cmd[data-term-light="true"] .term-kebab:hover,
.cmd[data-term-light="true"] .copy-btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: #22262b;
}
.cmd .term-body {
  border-radius: 0 0 10px 10px;
  overflow-y: auto;
  overflow-x: hidden;
}
/* floating window: opens in the BOTTOM-RIGHT corner, drags by the bar, resizes by the
   corner. The visible border + ring keep the edge readable on a black-on-black night theme. */
.cmd.show {
  display: flex;
  flex-direction: column;
  position: fixed;
  z-index: 80;
  right: 20px;
  bottom: 20px;
  width: min(760px, calc(100vw - 40px));
  height: min(58vh, 440px);
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.55),
    0 0 0 1px rgba(255, 255, 255, 0.06);
}
.cmd.zoomed {
  left: 20px !important;
  top: 20px !important;
  right: 20px !important;
  bottom: 20px !important;
  width: auto !important;
  height: auto !important;
  transform: none !important;
}
/* Gmail-style dock: minimized collapses to just the title bar, pinned to the bottom. The
   horizontal position is a variable so the dock can be dragged left/right (never up/down). */
.cmd.minimized {
  height: auto !important;
  width: 300px !important;
  right: var(--dock-right, 20px) !important;
  bottom: 0 !important;
  left: auto !important;
  top: auto !important;
  transform: none !important;
  border-radius: 10px 10px 0 0;
  cursor: pointer;
}
.cmd.minimized .term-body {
  display: none;
}
.cmd .term-bar {
  cursor: move;
  user-select: none;
}
.cmd.minimized .term-bar {
  cursor: pointer;
}
/* maximized windows don't move (Gmail) - say so with the cursor */
.cmd.zoomed .term-bar {
  cursor: default;
}
.cmd .tl,
.cmd .cmd-tab,
.cmd .copy-btn,
.cmd .term-add,
.cmd .term-info-btn,
.cmd .term-bg-btn {
  cursor: pointer;
}
.term-resize {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  z-index: 2;
  background: linear-gradient(
    135deg,
    transparent 50%,
    var(--border-2) 50%,
    var(--border-2) 60%,
    transparent 60%,
    transparent 72%,
    var(--border-2) 72%,
    var(--border-2) 82%,
    transparent 82%
  );
}
.cmd.minimized .term-resize,
.cmd.zoomed .term-resize {
  display: none;
}
.term-add {
  font-size: 13px;
  font-weight: 700;
  color: #7b8aa6;
  background: none;
  border: none;
  padding: 2px 7px;
  border-radius: 6px;
  cursor: pointer;
}
.term-add:hover {
  color: #8fb6ff;
  background: rgba(79, 141, 247, 0.15);
}
.cmd-tab .tab-x {
  margin-left: 6px;
  opacity: 0.6;
  cursor: pointer;
}
.cmd-tab .tab-x:hover {
  opacity: 1;
}
.term-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background: #0e1626;
  border-bottom: 1px solid #1b2942;
}
.traffic {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  margin-right: 4px;
}
.tl {
  width: 12px;
  height: 12px;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  padding: 0;
  display: inline-grid;
  place-items: center;
}
.tl.close {
  background: #ff5f56;
}
.tl.min {
  background: #febc2e;
}
.tl.zoom {
  background: #28c840;
}
.tl span {
  font-size: 9px;
  line-height: 1;
  font-weight: 700;
  color: rgba(0, 0, 0, 0.55);
  opacity: 0;
  transition: opacity 0.1s;
}
.traffic:hover .tl span {
  opacity: 1;
}

/* OS-specific window controls */
/* Windows: labelled buttons on the RIGHT, order min · max · close, red close hover. */
.cmd[data-os="windows"] .traffic {
  order: 99;
  gap: 0;
  margin: 0 0 0 4px;
}
.cmd[data-os="windows"] .tl {
  width: 34px;
  height: 26px;
  border-radius: 0;
  background: transparent !important;
  color: #aab8d4;
}
.cmd[data-os="windows"] .tl span {
  opacity: 1;
  color: currentColor;
  font-size: 12px;
}
.cmd[data-os="windows"] .tl.min {
  order: 1;
}
.cmd[data-os="windows"] .tl.zoom {
  order: 2;
}
.cmd[data-os="windows"] .tl.close {
  order: 3;
}
.cmd[data-os="windows"] .tl:hover {
  background: #1b2942 !important;
  color: #fff;
}
.cmd[data-os="windows"] .tl.close:hover {
  background: #e81123 !important;
  color: #fff;
}
.cmd[data-os="windows"] .tl.min span::before {
  content: "\\2013";
} /* – */
.cmd[data-os="windows"] .tl.zoom span::before {
  content: "\\25A1";
} /* □ */
.cmd[data-os="windows"] .tl.close span::before {
  content: "\\2715";
} /* ✕ */
.cmd[data-os="windows"] .tl span {
  font-size: 0;
}
.cmd[data-os="windows"] .tl span::before {
  font-size: 12px;
}

/* Linux (GNOME-ish): rounded symbolic buttons on the RIGHT. */
.cmd[data-os="linux"] .traffic {
  order: 99;
  gap: 7px;
  margin: 0 0 0 4px;
}
.cmd[data-os="linux"] .tl {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: #26364f !important;
  color: #d3ddf0;
}
.cmd[data-os="linux"] .tl.min {
  order: 1;
}
.cmd[data-os="linux"] .tl.zoom {
  order: 2;
}
.cmd[data-os="linux"] .tl.close {
  order: 3;
}
.cmd[data-os="linux"] .tl:hover {
  background: #33496b !important;
}
.cmd[data-os="linux"] .tl.close {
  background: #3a2730 !important;
  color: #ffb4a8;
}
.cmd[data-os="linux"] .tl.close:hover {
  background: #c0392b !important;
  color: #fff;
}
.cmd[data-os="linux"] .tl span {
  opacity: 1;
  color: currentColor;
  font-size: 0;
}
.cmd[data-os="linux"] .tl.min span::before {
  content: "\\2013";
}
.cmd[data-os="linux"] .tl.zoom span::before {
  content: "\\25A1";
}
.cmd[data-os="linux"] .tl.close span::before {
  content: "\\2715";
}
.cmd[data-os="linux"] .tl span::before {
  font-size: 11px;
}
.cmd-tab {
  font-size: 12px;
  font-weight: 600;
  color: #7b8aa6;
  padding: 4px 9px;
  border-radius: 6px;
  cursor: pointer;
  border: none;
  background: none;
  font-family: inherit;
}
.cmd-tab.on {
  background: rgba(79, 141, 247, 0.18);
  color: #8fb6ff;
}
.copy-ic {
  width: 30px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid #243349;
  background: #121d31;
  color: #aebbd4;
  cursor: pointer;
  display: inline-grid;
  place-items: center;
}
.copy-ic:hover {
  color: #fff;
  border-color: #34507c;
}
.copy-ic.done {
  color: #28c840;
  border-color: #28c840;
}
.term-body {
  padding: 14px;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.85;
  color: var(--term-fg);
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  /* fills the window height (flex) and scrolls inside - so enlarging the window grows the body and
     keeps the footer pinned to the bottom, instead of leaving dead space below a capped body. */
  overflow-y: auto;
  overflow-x: hidden;
}
.cmd.zoomed .term-body {
  max-height: none;
}
.term-body::-webkit-scrollbar {
  width: 10px;
}
.term-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.16);
  border-radius: 6px;
}
.cmd.minimized .term-body {
  display: none;
}
.cmd.zoomed .term-body {
  min-height: 220px;
}
.cmd .prompt {
  color: var(--term-prompt);
  font-weight: 700;
}
.cmd .fixed {
  color: var(--term-fg);
  font-weight: 600;
  opacity: 0.92;
}
.cmd .fixed.cont {
  color: #44566f;
  font-weight: 400;
}
.cmd .k {
  color: var(--term-key);
}
.cmd .v {
  color: var(--term-val);
}
.cmd .eq {
  color: var(--term-dim);
}
.cmd .term-flav {
  color: #c79bf0;
}
.cmd .term-scope {
  color: #6f7f9c;
  opacity: 0.85;
} /* the base scope: shown so a copied command reproduces results, but visibly not typed */
.cmd .bad {
  color: #f0795f;
  text-decoration: underline wavy #f0795f;
  text-underline-offset: 3px;
}
.cli-line {
  white-space: pre-wrap;
  word-break: break-word;
}
.term-edit {
  margin-top: 2px;
}
.te-wrap {
  position: relative;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.85;
}
.te-hl,
.te-input {
  margin: 0;
  font: inherit;
  line-height: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 2px 0;
  border: none;
}
.te-hl {
  position: absolute;
  inset: 0;
  color: #d7e2f4;
  pointer-events: none;
}
.te-input {
  position: relative;
  display: block;
  width: 100%;
  background: transparent;
  color: transparent;
  caret-color: transparent;
  outline: none;
  resize: none;
  overflow: hidden;
}
.te-input::placeholder {
  color: #44566f;
}
.cmd.fallback .te-hl {
  display: none;
}
.cmd.fallback .te-input {
  color: var(--term-fg);
  caret-color: var(--term-fg);
}
.te-extra {
  color: #6f7f9c;
  font-size: 11.5px;
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}
.te-warn {
  display: none;
  margin-top: 8px;
  font-family: var(--ui);
  font-size: 11.5px;
  color: #f0b86b;
  background: rgba(240, 121, 95, 0.12);
  border: 1px solid rgba(240, 121, 95, 0.4);
  border-radius: 6px;
  padding: 5px 9px;
}
.te-warn.show {
  display: block;
}
.py-view {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.9;
  padding: 4px 2px;
}
.py-line {
  display: flex;
  align-items: baseline;
}
/* The prompt (\`>>> \` / \`... \`) and the editable line's gutter MUST be the same width, or the typed
   kwargs won't line up under the read-only ones. Both are exactly 4 monospace columns. */
.py-prompt,
.py-gutter {
  display: inline-block;
  flex: 0 0 4ch;
  width: 4ch;
  padding-right: 0;
}
.py-prompt {
  color: var(--term-prompt);
  font-weight: 700;
}
.py-line.cont .py-prompt {
  color: #44566f;
  font-weight: 400;
}
.py-code {
  color: var(--term-key);
}
.py-ml {
  display: flex;
  align-items: flex-start;
}
.py-gutter {
  white-space: pre;
  color: #44566f;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.9;
  user-select: none;
}
/* …and the editable text is indented by the same 4 spaces the read-only \`    key=\` lines carry. */
.py-wrap {
  position: relative;
  flex: 1;
  min-width: 40px;
}
/* BOTH text layers carry the same 4-space indent as the read-only \`    key=\` lines. Padding the
   WRAPPER doesn't work: .py-hl is absolutely positioned, so it ignores the wrapper's padding and
   the overlay drifted out of alignment with the textarea beneath it. */
.py-hl,
.py-input {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.9;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  padding: 0 0 0 4ch;
}
.py-hl {
  position: absolute;
  inset: 0;
  color: var(--term-val);
  pointer-events: none;
}
/* caret-color TRANSPARENT: we draw our own blinking block. Leaving the native caret on gave TWO
   cursors on the python line. */
.py-input {
  position: relative;
  display: block;
  width: 100%;
  background: transparent;
  color: transparent;
  caret-color: transparent;
  border: none;
  outline: none;
  resize: none;
  overflow: hidden;
}
.py-input::placeholder {
  color: #44566f;
}
.py-ghost {
  color: #4d5d78;
}
.py-out {
  color: #aeb9cf;
  margin: 0 0 2px;
  white-space: pre-wrap;
  word-break: break-word;
}
.py-list {
  font-family: var(--mono);
  font-size: 12.5px;
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
.row .name {
  font-size: 13px;
  font-weight: 600;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row .dir {
  font-size: 11px;
  color: var(--faint);
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}
.fs {
  font-size: 11px;
  font-weight: 500;
  font-family: var(--mono);
  color: var(--dim);
  flex-shrink: 0;
  white-space: nowrap;
}
/* #3 - list-view column header (uri | fs type). Sits directly on top of the .rows box. */
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
.gcard .name {
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
.gcard .dir {
  font-size: 10.5px;
  color: var(--faint);
  margin-top: 4px;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
/* #4 - Enlarge control + full-screen comparison overlay (scrolls X and Y for wide/tall tables). */
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
/* narrow / mobile */
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
    padding: 8px 12px 92px;
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
    padding: 8px 10px 92px;
  }
}
/* On phones the 268px sidebar would swallow the content column. Collapsed, it stays a slim IN-FLOW
   rail (it pushes the file panel - no superimposition over the cards). Expanded, it floats over the
   file panel (like the details panel) so opening filters doesn't crush the narrow results. */
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

/* P8 - format thumbnails: the leading tile for zarr/nc/grib rows/cards. Other extensions
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

/* P4 - manual load-next with a proportion bar (no scroll auto-load: cheaper on Solr, no
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

/* P5 - one loading language: the shared inline spinner primitive. */
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

/* P5 - flavour (naming) change: a clean spinner veil over the sidebar while labels/counts re-fetch. */
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

/* P2 - chip/mode/diff tags replace the removed \`·\` separators with quiet grouping. */
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
/* #4 - the footer message itself is coloured by severity (green routine/ok, yellow warning, red
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

/* Metadata-focused block controls (P6 + sort/collapse/additional) */
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

/* Overview card drag-resize handle (P6) */
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

/* Terminal host span */
.cmd .term-host {
  color: #6f9cf0;
  word-break: break-all;
}

/* Windows: blue title bar */
.cmd[data-os="windows"] .term-bar {
  background: linear-gradient(#1257c4, #0e46a0);
  border-bottom-color: #0a3a86;
}
.cmd[data-os="windows"] .cmd-tab {
  color: #cfe0ff;
}
.cmd[data-os="windows"] .cmd-tab.on {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}
.cmd[data-os="windows"] .term-add,
.cmd[data-os="windows"] .copy-ic {
  color: #dceaff;
}
.cmd[data-os="windows"] .tl {
  color: #eaf1ff;
}
.cmd[data-os="windows"] .tl:hover {
  background: rgba(255, 255, 255, 0.16) !important;
  color: #fff;
}
.cmd[data-os="windows"] .tl.close:hover {
  background: #e81123 !important;
  color: #fff;
}

/* Inline ghost autocomplete */
.te-ghost {
  color: #4d5d78;
}
.te-hint {
  font-size: 10.5px;
  color: #4d5d78;
  margin-top: 3px;
  font-family: var(--mono);
}
.cmd.fallback .te-hint {
  display: none;
}

/* In-terminal completion menu (shell-style, replaces the floating popover) */
.te-menu,
.py-menu {
  display: none;
  margin: 6px 0 2px;
  border: 1px solid #26364f;
  border-radius: 6px;
  max-height: 168px;
  overflow-y: auto;
  background: rgba(255, 255, 255, 0.03);
}
.te-menu.show,
.py-menu.show {
  display: block;
}
.tm-item {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 3px 10px;
  font-family: var(--mono);
  font-size: 12px;
  color: #c7d4ea;
  cursor: pointer;
}
.tm-item.hl {
  background: rgba(79, 141, 247, 0.22);
  color: #fff;
}
.tm-item:hover {
  background: rgba(79, 141, 247, 0.12);
}
.tm-val {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tm-cnt {
  color: #6f7f9c;
  flex-shrink: 0;
}

/* Terminal: real tabs, blinking cursor, read-only prefix, panels */

/* title bar + tabs */
.term-bar {
  background: color-mix(in srgb, var(--term-bg) 82%, #fff 6%);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.cmd-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px 6px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 7px 7px 0 0;
  margin-bottom: -1px;
  color: #93a3bd;
  font-size: 12px;
  line-height: 1.4;
}
.cmd-tab .tab-ic {
  display: inline-flex;
  opacity: 0.75;
}
.cmd-tab[data-cmd="cli"] .tab-ic {
  color: #7ee0a8;
} /* bash */
.cmd-tab[data-cmd="py"] .tab-ic {
  color: #f0c04d;
} /* python */
.cmd-tab.on {
  background: var(--term-bg);
  color: var(--term-fg);
  border-color: rgba(255, 255, 255, 0.14);
  border-bottom: 1px solid var(--term-bg);
}
.cmd-tab.on .tab-ic {
  opacity: 1;
}
.cmd-tab:not(.on):hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--term-fg);
}

/* [copy] / info / colour controls */
.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: #93a3bd;
  background: none;
  border: none;
  padding: 3px 7px;
  border-radius: 6px;
}
.copy-btn .cb-caret {
  color: #7ee0a8;
  opacity: 0.8;
}
.copy-btn:hover {
  color: var(--term-fg);
  background: rgba(255, 255, 255, 0.07);
}
.copy-btn:hover .cb-caret {
  opacity: 1;
}
.copy-btn.done,
.copy-btn.done .cb-caret {
  color: #7ee0a8;
  opacity: 1;
}
.term-kebab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  color: #93a3bd;
  background: none;
  border: none;
  border-radius: 6px;
}
.term-kebab:hover {
  color: var(--term-fg);
  background: rgba(255, 255, 255, 0.08);
}

/* blinking block cursor (a real terminal, not a text field) */
.te-caret {
  display: inline-block;
  width: 7px;
  height: 1.05em;
  vertical-align: text-bottom;
  background: var(--term-fg);
  animation: te-blink 1.05s step-end infinite;
}
@keyframes te-blink {
  0%,
  45% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .te-caret {
    animation: none;
  }
}
/* it blinks whether or not the terminal has focus - it's the "start typing here" cue. When the
   input IS focused it's fully solid; unfocused it's a hollow box, the usual terminal convention. */
.cmd .te-wrap:not(:focus-within) .te-caret,
.cmd .py-wrap:not(:focus-within) .te-caret {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--term-fg);
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
.py-fixedline .py-code,
.py-ro {
  color: #7f8da3;
  font-style: italic;
  opacity: 0.82;
}

/* overflow (\\22ee) menu: terminal settings; the install guide lives in app-level Help */
.term-menu {
  display: none;
  position: absolute;
  right: 8px;
  top: 42px;
  z-index: 120;
  min-width: 214px;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: color-mix(in srgb, var(--term-bg) 88%, #fff 8%);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5);
}
.term-menu.show {
  display: block;
}
.tmn-h {
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #7b8aa6;
  font-family: var(--font);
  margin: 2px 2px 7px;
}
.tmn-item {
  display: block;
  width: 100%;
  text-align: left;
  margin-top: 4px;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--term-fg);
  font-family: var(--font);
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
}
.tmn-item:hover {
  background: rgba(255, 255, 255, 0.09);
}

/* colour palette (persisted) */
.term-bg-panel {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  padding: 0 2px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  margin-bottom: 4px;
}
.bg-sw {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
}
.bg-sw.on {
  outline: 2px solid #8fb6ff;
  outline-offset: 1px;
}

/* completion menu: the empty state says so, instead of showing nothing -- */
.tm-empty {
  color: #6f7f9c;
  font-style: italic;
  cursor: default;
}
.tm-empty:hover {
  background: none;
}

/* bash: the input CONTINUES the command line
   The prefix (prompt · command · --flavour · read-only time/bbox) is painted at the start of the
   line; the input sits on top at full width with its FIRST line indented past the prefix, so
   wrapped text falls back to the left margin like a real shell - instead of the input becoming a
   narrow column on the right (which is what a flex row gave us). */
.cli-row {
  position: relative;
  --te-indent: 0px;
}
.cli-prefix {
  position: absolute;
  left: 0;
  top: 0;
  padding: 2px 0;
  white-space: nowrap;
  line-height: inherit;
  pointer-events: none;
} /* same padding as .te-hl/.te-input -> same baseline */
.cli-row .term-edit {
  margin-top: 0;
}
.cli-row .cli-line {
  display: inline;
}
.cli-row .te-hl,
.cli-row .te-input {
  text-indent: var(--te-indent);
}
/* narrow window / very long prefix -> give the input its own line rather than a sliver */
.cli-row.prefix-block .cli-prefix {
  position: static;
  white-space: pre-wrap;
  display: block;
}
.cli-row.prefix-block .te-hl,
.cli-row.prefix-block .te-input {
  text-indent: 0;
}

/* no focus ring inside the terminal: the BLINKING CURSOR is the focus cue */
.cmd .te-input:focus-visible,
.cmd .py-input:focus-visible {
  outline: none;
}
.cmd .te-wrap,
.cmd .py-wrap {
  border: none;
  box-shadow: none;
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

/* Terminal: hint vs suggestion, and a bar that survives a narrow window */

/* 2) the GHOST is the only thing Tab will accept, so nothing else may look like it
   The placeholder must not be the same dim grey as the ghost, or \`project=cmip6 variable=tas\`
   read as a real suggestion waiting for Tab. The ghost keeps the "type-ahead" grey; the
   placeholder and the hint are italic and clearly *instructional* (a different hue entirely). */
.te-ghost,
.py-ghost {
  color: var(--term-ghost);
  font-style: normal;
}
.te-input::placeholder,
.py-input::placeholder {
  color: var(--term-ph);
  font-style: italic;
  opacity: 0.8;
}
.te-hint {
  margin-top: 6px;
  font-family: var(--font);
  font-size: 11px;
  font-style: italic;
  color: var(--term-hint);
  opacity: 0.85;
  letter-spacing: 0.01em;
}
.te-hint kbd,
.tm-empty {
  font-family: var(--mono);
  font-style: normal;
}
/* keycaps: the hint keys look like real keys - subtle fill, a border with a thicker bottom edge for
   depth, and a hairline shadow. Tuned per terminal theme (dark tokens by default). */
.te-hint kbd {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  margin: 0 1px;
  min-width: 16px;
  justify-content: center;
  border-radius: 4px;
  font-size: 10px;
  line-height: 1.7;
  color: var(--term-fg);
  background: rgba(255, 255, 255, 0.09);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-bottom-width: 2px;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);
}
.cmd[data-term-light="true"] .te-hint kbd {
  background: rgba(0, 0, 0, 0.06);
  border-color: rgba(0, 0, 0, 0.22);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.12);
}
/* Terminal footer: a status strip pinned under the body that carries the keyboard hint.
   The window has overflow:visible (so the ⋮ menu isn't clipped), so the footer rounds its OWN bottom
   corners to match the window. Hidden when docked (only the bar shows) or in the textarea fallback. */
.term-foot {
  padding: 5px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 0 0 10px 10px;
  background: color-mix(in srgb, var(--term-bg) 96%, #000 5%);
  display: flex;
  align-items: center;
  min-height: 26px;
  flex-shrink: 0;
}
.term-foot .te-hint {
  margin: 0;
  opacity: 0.9;
}
.cmd[data-term-light="true"] .term-foot {
  border-top-color: rgba(0, 0, 0, 0.1);
  background: color-mix(in srgb, var(--term-bg) 92%, #000 4%);
}
.cmd.minimized .term-foot,
.cmd.fallback .term-foot {
  display: none;
}
/* the "how to type this" rows in the menu are guidance, not completions */
.tm-empty {
  color: var(--term-hint);
  font-style: italic;
  cursor: default;
}
.tm-empty:hover {
  background: none;
}

/* 5) narrow window: the window controls must never be pushed out of the bar */
.cmd.show {
  min-width: 340px;
}
.term-bar {
  flex-wrap: nowrap;
}
.traffic,
.term-add,
.copy-btn,
.term-kebab {
  flex: 0 0 auto;
}
.spacer {
  flex: 1 1 0;
  min-width: 0;
}
.cmd-tab {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
}
.cmd-tab .tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* below this WINDOW width (set by a ResizeObserver on the terminal itself - a viewport media
   query can't see the window's own size) the tab labels give way before the controls do */
.cmd.narrow .cmd-tab .tab-label {
  display: none;
}
.cmd.narrow .copy-btn .cb-word {
  display: none;
}

/* 7) opacity slider in the ⋮ menu */
.tmn-alpha {
  padding: 2px 2px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  margin-bottom: 4px;
}
.term-alpha {
  width: 100%;
  accent-color: #8fb6ff;
  cursor: pointer;
}

/* completion menu placement
   The terminal sits in the bottom-right corner, so a list under the caret is often below the
   fold of the scrolling body. When there's no room beneath, the menu FLIPS to sit directly above
   the prompt - the same thing a shell does when completing at the bottom of a screen. Explicit
   flex \`order\` values (rather than DOM order) let the menu move without moving anything else. */
.cli-view,
.py-view {
  display: flex;
  flex-direction: column;
}

.cli-view > .cli-row {
  order: 10;
}
.cli-view > .te-menu {
  order: 20;
}
.cli-view > .te-extra {
  order: 30;
}
.cli-view > .te-warn {
  order: 50;
}
.cli-view.menu-above > .te-menu {
  order: 5;
  margin: 0 0 6px;
} /* above the prompt line */

.py-view > .py-line {
  order: 10;
}
.py-view > .py-fixed {
  order: 30;
}
.py-view > .py-ml {
  order: 40;
}
.py-view > .py-menu {
  order: 50;
}
.py-view > .py-close {
  order: 60;
}
.py-view.menu-above > .py-menu {
  order: 35;
  margin: 0 0 6px;
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
/* the count badge clears all filters. On hover/focus the number is replaced by
   a red × (a ::after overlay; the number goes transparent) on a red-tinted rectangle - the same
   affordance as a single facet's badge, so "clear everything" reads the same as "clear one". */
.sf-badge:hover,
.sf-badge:focus-visible {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: transparent;
  outline: none;
}
.sf-badge:hover::after,
.sf-badge:focus-visible::after {
  content: "\\00d7";
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--danger);
  font-weight: 800;
  font-size: 14px;
  font-family: var(--font);
}

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

/* (a wider card gets more columns automatically from the auto-fill grid on .fcard-vals - #1) */

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
.fcard-special-body.time-body {
  display: flex;
  flex-direction: column;
  justify-content: center;
}
/* #8 - the inline editor is stretched to height:100% (so the bbox map can fill its card), which left
   nothing for the body's justify-content to centre. Centre the time picker's rows WITHIN that
   full-height editor instead. Only time - the bbox editor wants its map to fill. */
.fcard-special-body.time-body .editor.inline {
  justify-content: center;
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
  min-width: 0;
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
.editor.inline .daterow {
  display: grid;
  grid-template-columns: 34px 1fr;
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
/* #2 - export locked past the 100k ceiling: greyed out, not-allowed cursor, no hover lift. The click
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
  /* #1 - the xarray repr colours default to a fixed LIGHT palette (--jp-* and white fallbacks), so
     the metadata table ignored the app theme. Map them onto our tokens so the table follows light/night. */
  --xr-font-color0: var(--text);
  --xr-font-color2: var(--dim);
  --xr-font-color3: var(--dim);
  --xr-border-color: var(--border);
  --xr-disabled-color: var(--dim);
  --xr-background-color: var(--surface);
  --xr-background-color-row-even: var(--surface);
  --xr-background-color-row-odd: var(--surface-2);
  /* #1 - the chunk-cube diagram (shown on an expanded variable) defaults to Freva's brown
     (#9b7a52). Shade it from our accent so it reads as the dominant blue, in both themes. */
  --xr-chunk-face: var(--accent);
  --xr-chunk-top: color-mix(in srgb, var(--accent) 68%, #fff);
  --xr-chunk-side: color-mix(in srgb, var(--accent) 80%, #000);
  --xr-chunk-edge: color-mix(in srgb, var(--accent) 38%, #fff);
}
/* #2 - for a direct zarr store the resolved URL IS the file path, so the component's "Zarr:" row
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
/* #2 - let the metadata fill the modal instead of the built-in 700px cap. */
.freva-db data-inspector .xr-wrap {
  max-width: none;
}
`;
