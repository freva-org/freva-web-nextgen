// styles.ts - the stylesheet as a string, injected into a <style> element on mount.
// GENERATED from picker.css by scripts/gen-styles.mjs - do not edit by hand; edit picker.css
// and run `npm run gen:styles`. Scoped entirely under `.freva-picker`; the picker entry never loads the full databrowser sheet.

export const PICKER_STYLES = `/* picker.css - styles for the compact lab data picker.
   Everything is scoped under \`.freva-picker\`, so the picker can be dropped into a host page that
   has its own opinions without either side leaking into the other. The full databrowser stylesheet
   is NOT loaded by the picker entry - this file is its whole visual surface.

   The layout is CONTAINER-relative, never viewport-relative: the picker sizes to whatever box the
   host gives it, and every track uses minmax(0, …) so a long URI or a long facet value shrinks the
   track instead of forcing the container wider. */

.freva-picker {
  --fp-r: 8px;
  --fp-bg: #fff;
  --fp-surface: #f5f7fb;
  --fp-surface-2: #eaeef6;
  --fp-text: #0e1726;
  --fp-dim: #475569;
  --fp-faint: #5f6b7c;
  --fp-border: #dbe2ee;
  --fp-accent: #1f6feb;
  --fp-accent-soft: #e6efff;
  --fp-danger: #b42318;
  --fp-neg: #8a3ffc;
  --fp-neg-soft: #f2e9ff;
  --fp-ui: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color-scheme: light;
  position: relative; /* the positioning container for every overlay this picker owns */
  /* Makes the @container queries below resolve against the PICKER's width rather than the
     viewport's - the picker may be 320px wide inside a 1600px page, and a viewport media query
     would answer the wrong question entirely. */
  container-type: inline-size;
  display: grid;
  /* head | scope | chips | BODY (the flexible one) | footer. Getting this wrong is what let the
     file list grow until the Add button was pushed out of the container. */
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  height: 100%;
  min-height: 0;
  /* The picker bounds its OWN scrolling: the page must never have to scroll to reach the action. */
  overflow: hidden;
  box-sizing: border-box;
  padding: 10px;
  font-family: var(--fp-ui);
  font-size: 13px;
  color: var(--fp-text);
  background: var(--fp-bg);
  border: 1px solid var(--fp-border);
  border-radius: var(--fp-r);
}

.freva-picker[data-theme="night"] {
  --fp-bg: #0f141c;
  --fp-surface: #161d28;
  --fp-surface-2: #1e2734;
  --fp-text: #e6ecf5;
  --fp-dim: #a4b0c2;
  --fp-faint: #8593a6;
  --fp-border: #2a3444;
  --fp-accent: #58a6ff;
  --fp-accent-soft: #12233c;
  --fp-danger: #ff7b72;
  --fp-neg: #c99bff;
  --fp-neg-soft: #2a1f3d;
  color-scheme: dark;
}

.freva-picker *,
.freva-picker *::before,
.freva-picker *::after {
  box-sizing: border-box;
}

.freva-picker button {
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.freva-picker input,
.freva-picker select {
  font: inherit;
  color: inherit;
}

/* Header */

.freva-picker .fp-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.freva-picker .fp-search {
  position: relative;
  min-width: 0;
}

.freva-picker .fp-input {
  width: 100%;
  min-width: 0;
  height: 38px;
  padding: 0 34px 0 12px;
  background: var(--fp-surface);
  border: 1px solid var(--fp-border);
  border-radius: var(--fp-r);
  outline: none;
}

.freva-picker .fp-input:focus-visible {
  border-color: var(--fp-accent);
  box-shadow: 0 0 0 3px var(--fp-accent-soft);
}

/* The loading state is VISIBLE, not implied: a search that is still running looks different from
   one that returned nothing. */
.freva-picker .fp-spin {
  position: absolute;
  top: 50%;
  right: 11px;
  width: 14px;
  height: 14px;
  margin-top: -7px;
  border: 2px solid var(--fp-border);
  border-top-color: var(--fp-accent);
  border-radius: 50%;
  opacity: 0;
  transition: opacity 0.12s;
}

.freva-picker .fp-spin.on {
  opacity: 1;
  animation: fp-spin 0.7s linear infinite;
}

@keyframes fp-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .freva-picker .fp-spin.on {
    animation-duration: 2.4s;
  }
}

.freva-picker .fp-flavour {
  height: 38px;
  max-width: 140px;
  padding: 0 8px;
  background: var(--fp-surface);
  border: 1px solid var(--fp-border);
  border-radius: var(--fp-r);
}

/* Chips */

.freva-picker .fp-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.freva-picker .fp-chips.empty {
  display: none;
}

.freva-picker .fp-chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  max-width: 100%;
  min-width: 0;
  padding: 3px 8px;
  background: var(--fp-accent-soft);
  border: 1px solid var(--fp-border);
  border-radius: 999px;
  font-size: 12px;
}

.freva-picker .fp-chip.neg {
  background: var(--fp-neg-soft);
  border-color: var(--fp-neg);
}

.freva-picker .fp-chip-k {
  flex: none;
  color: var(--fp-faint);
}

.freva-picker .fp-chip-v {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.freva-picker .fp-chip-x {
  flex: none;
  color: var(--fp-faint);
}

.freva-picker .fp-clear {
  padding: 3px 10px;
  background: transparent;
  border: 1px dashed var(--fp-border);
  border-radius: 999px;
  color: var(--fp-dim);
  font-size: 12px;
}

/* Scope */

/* The host's constraint, not a filter the user applied: never interactive, and "Clear all" does
   not touch it. A NEGATIVE scope has no facet row to lock (its values are absent from the
   response entirely), so this strip is the only place it can be shown at all. */
.freva-picker .fp-scope {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-width: 0;
  font-size: 11px;
}

.freva-picker .fp-scope.empty {
  display: none;
}

.freva-picker .fp-scope-l {
  color: var(--fp-faint);
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.freva-picker .fp-scope-i {
  max-width: 100%;
  overflow: hidden;
  padding: 2px 8px;
  background: var(--fp-surface-2);
  border: 1px solid var(--fp-border);
  border-radius: 999px;
  color: var(--fp-dim);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.freva-picker .fp-scope-i.neg {
  border-color: var(--fp-neg);
  color: var(--fp-neg);
}

/* Body */

.freva-picker .fp-body {
  display: grid;
  grid-template-columns: minmax(0, 210px) minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
}

/* The picker sizes to its CONTAINER, not the viewport - a host may give it 320px inside a wide
   page, or a full-screen dialog. Container queries answer that; the width media query below is the
   fallback for engines without them. */
@container (max-width: 560px) {
  .freva-picker .fp-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .freva-picker .fp-side {
    max-height: 148px;
  }
  /* The action gets its own full-width row rather than squeezing the mode choice into a sliver. */
  .freva-picker .fp-foot {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "modes"
      "note"
      "add";
  }
}

@media (max-width: 560px) {
  .freva-picker .fp-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .freva-picker .fp-side {
    max-height: 148px;
  }
  .freva-picker .fp-foot {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "modes"
      "note"
      "add";
  }
}

.freva-picker .fp-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}

.freva-picker .fp-facet {
  min-width: 0;
  padding: 6px 8px 8px;
  background: var(--fp-surface);
  border: 1px solid var(--fp-border);
  border-radius: var(--fp-r);
}

.freva-picker .fp-fhead {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}

.freva-picker .fp-fname {
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--fp-faint);
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.freva-picker .fp-fbadge {
  padding: 0 5px;
  background: var(--fp-accent);
  border-radius: 999px;
  color: #fff;
  font-size: 10px;
  line-height: 15px;
}

.freva-picker .fp-fclear {
  padding: 0 4px;
  background: transparent;
  border: 0;
  color: var(--fp-faint);
  line-height: 1;
}

.freva-picker .fp-vrow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px;
  align-items: center;
}

.freva-picker .fp-v {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  align-items: baseline;
  min-width: 0;
  padding: 3px 6px;
  background: transparent;
  border: 0;
  border-radius: 5px;
  text-align: left;
}

.freva-picker .fp-v:hover {
  background: var(--fp-surface-2);
}

.freva-picker .fp-v.on {
  background: var(--fp-accent-soft);
  box-shadow: inset 2px 0 0 var(--fp-accent);
}

.freva-picker .fp-v-t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.freva-picker .fp-v-c {
  color: var(--fp-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.freva-picker .fp-x {
  padding: 2px 6px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--fp-faint);
  line-height: 1.1;
}

.freva-picker .fp-x:hover {
  border-color: var(--fp-neg);
  color: var(--fp-neg);
}

.freva-picker .fp-x.on {
  background: var(--fp-neg-soft);
  border-color: var(--fp-neg);
  color: var(--fp-neg);
}

.freva-picker .fp-vrow.excluded .fp-v-t {
  color: var(--fp-faint);
  text-decoration: line-through;
}

/* A positively gated facet is FIXED by the instance's scope. It renders as text with a lock, not
   as a disabled-looking button: there is no toggle, because no toggle could ever change the
   request, and an affordance that does nothing is worse than no affordance. */
.freva-picker .fp-facet.locked {
  background: var(--fp-surface-2);
}

.freva-picker .fp-v.locked {
  cursor: default;
  opacity: 0.85;
}

.freva-picker .fp-v.locked:hover {
  background: transparent;
}

.freva-picker .fp-fbadge.lock {
  background: var(--fp-surface-3, var(--fp-border));
  color: var(--fp-dim);
}

.freva-picker .fp-lock {
  flex: none;
  font-size: 10px;
  line-height: 1;
}

.freva-picker .fp-more {
  margin-top: 2px;
  padding: 2px 0;
  background: transparent;
  border: 0;
  color: var(--fp-accent);
  font-size: 11px;
}

/* Time and Area are DISCLOSURES, not six permanent inputs wedged into the filter rail: closed they
   are one line stating their own state, and they only take space while being edited. */
.freva-picker .fp-disc {
  min-width: 0;
  background: var(--fp-surface);
  border: 1px solid var(--fp-border);
  border-radius: var(--fp-r);
}

.freva-picker .fp-disc-h {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 6px;
  align-items: baseline;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  background: transparent;
  text-align: left;
}

.freva-picker .fp-disc-l {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--fp-faint);
  text-transform: uppercase;
}

.freva-picker .fp-disc-h.on .fp-disc-l {
  color: var(--fp-accent);
}

.freva-picker .fp-disc-s {
  overflow: hidden;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.freva-picker .fp-disc-c {
  color: var(--fp-faint);
  font-size: 10px;
}

.freva-picker .fp-ctl {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  min-width: 0;
  padding: 0 8px 8px;
}

.freva-picker .fp-ctl-bbox {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.freva-picker .fp-t,
.freva-picker .fp-b {
  flex: 1 1 60px;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  background: var(--fp-surface);
  border: 1px solid var(--fp-border);
  border-radius: 5px;
}

/* File list */

.freva-picker .fp-files {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  background: var(--fp-surface);
  border: 1px solid var(--fp-border);
  border-radius: var(--fp-r);
}

.freva-picker .fp-list-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 7px 10px;
  border-bottom: 1px solid var(--fp-border);
}

.freva-picker .fp-lh {
  font-weight: 600;
}

.freva-picker .fp-lh-sub {
  color: var(--fp-faint);
  font-size: 11px;
}

.freva-picker .fp-state {
  display: none;
  padding: 10px;
  color: var(--fp-dim);
}

.freva-picker .fp-state.show {
  display: block;
}

.freva-picker .fp-state.err {
  color: var(--fp-danger);
}

.freva-picker .fp-scroll {
  position: relative;
  min-height: 0;
  /* A LAST-RESORT bound. The host is asked to give the picker a definite height, in which case the
     \`minmax(0, 1fr)\` track above already bounds this and the cap is inert. When the host does not,
     the picker would otherwise grow to its full content height - and a list that cannot scroll is a
     list whose windowing does nothing. This keeps the worst case bounded instead of unbounded. */
  max-height: 100vh;
  overflow-y: auto;
}

.freva-picker .fp-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto auto;
  gap: 8px;
  align-items: center;
  padding: 0 10px;
  border-bottom: 1px solid var(--fp-border);
  cursor: pointer;
}

.freva-picker .fp-row:hover {
  background: var(--fp-surface-2);
}

.freva-picker .fp-row.picked {
  background: var(--fp-accent-soft);
}

/* The LISTBOX holds focus, not the rows: in a recycling list a per-row tabindex would put focus on
   a node the next scroll destroys. The active option is marked by aria-activedescendant and shown
   with this ring, so the keyboard position is visible without focus ever moving. */
.freva-picker .fp-scroll:focus-visible {
  outline: 2px solid var(--fp-accent);
  outline-offset: -2px;
}

.freva-picker .fp-row.active {
  box-shadow: inset 2px 0 0 var(--fp-accent);
}

.freva-picker .fp-scroll:focus-visible .fp-row.active {
  outline: 2px solid var(--fp-accent);
  outline-offset: -2px;
}

.freva-picker .fp-box {
  flex: none;
  width: 14px;
  height: 14px;
  background: var(--fp-bg);
  border: 1px solid var(--fp-faint);
  border-radius: 3px;
}

.freva-picker .fp-box.on {
  background: var(--fp-accent);
  border-color: var(--fp-accent);
  box-shadow: inset 0 0 0 2px var(--fp-bg);
}

.freva-picker .fp-uri {
  min-width: 0;
  overflow: hidden;
  direction: rtl; /* keep the FILENAME visible when a long path has to be clipped */
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  unicode-bidi: plaintext;
}

.freva-picker .fp-tag {
  flex: none;
  padding: 1px 6px;
  background: var(--fp-surface-2);
  border-radius: 999px;
  color: var(--fp-faint);
  font-size: 10px;
  text-transform: uppercase;
}

.freva-picker .fp-grip {
  flex: none;
  color: var(--fp-faint);
  cursor: grab;
}

/* Footer */

.freva-picker .fp-foot {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    "modes add"
    "note note";
  gap: 8px 10px;
  align-items: center;
  min-width: 0;
}

/* WHAT WILL BE ADDED - two mutually exclusive modes, each showing its own subject. A checkbox
   could not say that; it toggled something and left the consequence invisible until Add. */
.freva-picker .fp-modes {
  grid-area: modes;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 4px;
  min-width: 0;
  padding: 3px;
  background: var(--fp-surface);
  border: 1px solid var(--fp-border);
  border-radius: var(--fp-r);
}

.freva-picker .fp-mode {
  display: grid;
  gap: 1px;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  text-align: left;
}

.freva-picker .fp-mode:hover:not(:disabled) {
  background: var(--fp-surface-2);
}

.freva-picker .fp-mode.on {
  background: var(--fp-accent-soft);
  border-color: var(--fp-accent);
}

.freva-picker .fp-mode:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.freva-picker .fp-mode:focus-visible {
  outline: 2px solid var(--fp-accent);
  outline-offset: 1px;
}

.freva-picker .fp-mode-t {
  overflow: hidden;
  font-size: 11px;
  color: var(--fp-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.freva-picker .fp-mode-n {
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.freva-picker .fp-note {
  grid-area: note;
  display: none;
  margin: 0;
  min-width: 0;
  color: var(--fp-faint);
  font-size: 11px;
}

.freva-picker .fp-note.show {
  display: block;
}

.freva-picker .fp-note.warn {
  color: var(--fp-danger);
}

.freva-picker .fp-count {
  grid-area: modes;
  min-width: 0;
  overflow: hidden;
  color: var(--fp-faint);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.freva-picker .fp-count.warn {
  color: var(--fp-danger);
}

.freva-picker .fp-add {
  grid-area: add;
  display: inline-flex;
  gap: 6px;
  align-items: baseline;
  justify-content: center;
  min-width: 0;
  padding: 8px 16px;
  background: var(--fp-accent);
  border: 1px solid var(--fp-accent);
  border-radius: var(--fp-r);
  color: #fff;
  font-weight: 600;
}

.freva-picker .fp-add-l {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The action states its own SCOPE, so pressing it is never a guess. */
.freva-picker .fp-add-s {
  flex: none;
  font-weight: 500;
  opacity: 0.85;
}

.freva-picker .fp-add:disabled {
  background: var(--fp-surface-2);
  border-color: var(--fp-border);
  color: var(--fp-faint);
  cursor: not-allowed;
}

.freva-picker .fp-add:focus-visible {
  outline: 2px solid var(--fp-accent);
  outline-offset: 2px;
}

/* Autocomplete overlay */

/* \`position: absolute\` inside the picker root, placed by ../anchor.ts. Never \`fixed\`: a transformed
   or filtered ancestor makes \`fixed\` resolve against THAT ancestor, and a clipping container hides
   whatever lands outside it. */
.freva-picker .fp-ac {
  z-index: 40;
  display: none;
  overflow-y: auto;
  background: var(--fp-bg);
  border: 1px solid var(--fp-border);
  border-radius: var(--fp-r);
  box-shadow: 0 10px 28px rgb(15 23 42 / 18%);
}

.freva-picker .fp-ac.show {
  display: block;
}

.freva-picker .fp-ac-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  padding: 5px 10px;
  cursor: pointer;
}

.freva-picker .fp-ac-item.hl {
  background: var(--fp-accent-soft);
}

.freva-picker .fp-ac-k {
  flex: none;
  padding: 1px 6px;
  background: var(--fp-surface-2);
  border-radius: 999px;
  color: var(--fp-faint);
  font-size: 10px;
}

.freva-picker .fp-ac-v {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.freva-picker .fp-ac-c {
  color: var(--fp-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.freva-picker .fp-ac-x {
  padding: 0 6px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--fp-faint);
}

.freva-picker .fp-ac-x:hover {
  border-color: var(--fp-neg);
  color: var(--fp-neg);
}

.freva-picker .fp-ac-empty {
  padding: 8px 10px;
  color: var(--fp-faint);
}

/* Inclusion vs exclusion: shape, not colour
   The same structural language as the full browser, because the picker embeds in hosts whose accent
   is configurable (and may be red) and has to stay readable in greyscale and forced colours. The
   two badges are also the CLEAR controls, each scoped to its own mode: hover or focus REPLACES the
   count with one centred cross rather than drawing one on top of it. */
.freva-picker .fp-fbadge {
  position: relative;
  display: inline-grid;
  place-items: center;
  min-width: calc(var(--fb-ch, 2) * 1ch + 12px);
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  background: transparent;
}
.freva-picker .fp-fbadge > .fb-n,
.freva-picker .fp-fbadge > .fb-x {
  grid-area: 1 / 1;
}
.freva-picker .fp-fbadge > .fb-x {
  display: none;
  font-size: 12px;
  line-height: 1;
  color: currentColor; /* neutral - never the accent, never a danger red */
}
.freva-picker .fp-fbadge:hover > .fb-n,
.freva-picker .fp-fbadge:focus-visible > .fb-n {
  display: none;
}
.freva-picker .fp-fbadge:hover > .fb-x,
.freva-picker .fp-fbadge:focus-visible > .fb-x {
  display: block;
}
.freva-picker .fb-inc {
  background: var(--fp-accent);
  color: #fff;
  border: 1px solid transparent;
}
.freva-picker .fb-exc {
  background: transparent;
  border: 1px dashed currentColor;
  color: var(--fp-text);
  font-weight: 700;
}
.freva-picker .fp-fbadge.lock {
  cursor: default;
}
/* An excluded value in the FACET LIST: struck through, \`!=\`-marked, and its pressed control DASHED
   rather than only tinted. (The top-level chips are deliberately left unstruck - there the value is
   the label you have to read.) */
.freva-picker .fp-vrow.excluded .fp-v-t {
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}
.freva-picker .fp-vrow.excluded .fp-v-t::before {
  content: "\\2260\\00a0";
  text-decoration: none;
  display: inline-block;
  font-weight: 700;
}
.freva-picker .fp-x.on {
  border-style: dashed;
}
/* Negative chips: neutral text, dotted outline, a subtle static hatch, and a strike on the VALUE
   only - no danger colour and no dependency on the host accent. */
.freva-picker .fp-chip.neg {
  border: 1px dotted var(--fp-border);
  color: var(--fp-text);
  background-color: var(--fp-surface-2);
  background-image: repeating-linear-gradient(
    -45deg,
    color-mix(in srgb, var(--fp-text) 9%, transparent) 0 1px,
    transparent 1px 6px
  );
}
.freva-picker .fp-chip.neg .fp-chip-k,
.freva-picker .fp-chip.neg .fp-chip-x {
  color: var(--fp-text);
  text-decoration: none;
}
.freva-picker .fp-chip.neg .fp-chip-v {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (forced-colors: active) {
  .freva-picker .fb-inc {
    border: 1px solid CanvasText;
  }
  .freva-picker .fb-exc,
  .freva-picker .fp-x.on {
    border: 1px dashed CanvasText;
  }
  .freva-picker .fp-chip.neg {
    background-image: none;
    border-style: dotted;
  }
}
`;
