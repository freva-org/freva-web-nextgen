// styles.ts - the stylesheet as a string, injected into a <style> element on mount.
// GENERATED from styles.css by scripts/gen-styles.mjs - do not edit by hand; edit styles.css
// and run `npm run gen:styles`. The component bundles no CSS file, so the tokens + component
// styles live here as one constant.

export const STYLES = `/* styles.css - @freva-org/freva-client-terminal.
   Moved verbatim from the databrowser's stylesheet (so the visual identity is unchanged) and
   re-scoped under \`.freva-term\`, which IS the window root. The package injects this into its own
   subtree, so a host that never loads the databrowser still gets a complete terminal.

   Host tokens (--shadow, --mono, --ui, --border-2) are inherited when the terminal is mounted
   inside a themed app; the fallbacks below make standalone use work on a bare page. */

.freva-term {
  --font: var(--mono, "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace);
  --shadow: var(--host-shadow, 0 1px 2px rgba(0, 0, 0, 0.5), 0 6px 20px rgba(0, 0, 0, 0.4));
  --border-2: var(--host-border-2, #2c4267);
  font-family: var(--font);
}
.freva-term *,
.freva-term *::before,
.freva-term *::after {
  box-sizing: border-box;
}

/* terminal - keeps its own dark tokens so it stays dark in day theme */
/* Terminal colours are user-chosen and PERSISTED; each preset ships its own
   foreground so text can never end up unreadable. Defaults to black. */
.freva-term {
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
.freva-term .term-bar {
  border-radius: 10px 10px 0 0;
}
/* light presets (e.g. Paper): the token palette has to flip too, or the text is unreadable */
.freva-term[data-term-light="true"] {
  --term-prompt: #1f7a33;
  --term-key: #2d5fb8;
  --term-val: #a05a12;
  --term-dim: #6a7383;
  --term-ghost: #a3acbb;
  --term-hint: #1d7d6c;
  --term-ph: #99a2b0;
  border-color: rgba(0, 0, 0, 0.18);
}
.freva-term[data-term-light="true"] .term-bar {
  background: color-mix(in srgb, var(--term-bg) 88%, #000 6%);
  border-bottom-color: rgba(0, 0, 0, 0.12);
}
.freva-term[data-term-light="true"] .term-menu {
  background: color-mix(in srgb, var(--term-bg) 94%, #000 5%);
  border-color: rgba(0, 0, 0, 0.18);
}
.freva-term[data-term-light="true"] .tm-item {
  color: #22262b;
}
.freva-term[data-term-light="true"] .te-menu,
.freva-term[data-term-light="true"] .py-menu {
  border-color: rgba(0, 0, 0, 0.16);
  background: rgba(0, 0, 0, 0.03);
}
.freva-term[data-term-light="true"] .cmd-tab {
  color: #5b6472;
}
.freva-term[data-term-light="true"] .cmd-tab:not(.on):hover {
  background: rgba(0, 0, 0, 0.05);
}
.freva-term[data-term-light="true"] .term-kebab,
.freva-term[data-term-light="true"] .copy-btn {
  color: #5b6472;
}
.freva-term[data-term-light="true"] .term-kebab:hover,
.freva-term[data-term-light="true"] .copy-btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: #22262b;
}
.freva-term .term-body {
  border-radius: 0 0 10px 10px;
  overflow-y: auto;
  overflow-x: hidden;
}
.freva-term.zoomed {
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
.freva-term.minimized {
  height: auto !important;
  /* \`.freva-term.show\` sets \`min-height: 220px\` for an OPEN window. \`height: auto\` cannot shrink
     past a minimum, so the dock stayed ~220px tall with \`.term-body\` hidden inside it - the large
     empty dark rectangle. The minimum has to be reset, not just the height. */
  min-height: 0 !important;
  width: 300px !important;
  right: var(--dock-right, 20px) !important;
  bottom: 0 !important;
  left: auto !important;
  top: auto !important;
  transform: none !important;
  border-radius: 10px 10px 0 0;
  cursor: pointer;
}
.freva-term.minimized .term-body {
  display: none;
  min-height: 0;
  height: 0;
}
.freva-term .term-bar {
  cursor: move;
  user-select: none;
}
.freva-term.minimized .term-bar {
  cursor: pointer;
}
/* maximized windows don't move (Gmail) - say so with the cursor */
.freva-term.zoomed .term-bar {
  cursor: default;
}
.freva-term .tl,
.freva-term .cmd-tab,
.freva-term .copy-btn,
.freva-term .term-add,
.freva-term .term-info-btn,
.freva-term .term-bg-btn {
  cursor: pointer;
}
.freva-term .term-resize {
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
.freva-term.minimized .term-resize,
.freva-term.zoomed .term-resize {
  display: none;
}
.freva-term .term-add {
  font-size: 13px;
  font-weight: 700;
  color: #7b8aa6;
  background: none;
  border: none;
  padding: 2px 7px;
  border-radius: 6px;
  cursor: pointer;
}
.freva-term .term-add:hover {
  color: #8fb6ff;
  background: rgba(79, 141, 247, 0.15);
}
.freva-term .cmd-tab .tab-x {
  margin-left: 6px;
  opacity: 0.6;
  cursor: pointer;
}
.freva-term .cmd-tab .tab-x:hover {
  opacity: 1;
}
.freva-term .term-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background: #0e1626;
  border-bottom: 1px solid #1b2942;
}
.freva-term .traffic {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  margin-right: 4px;
}
.freva-term .tl {
  width: 12px;
  height: 12px;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  padding: 0;
  display: inline-grid;
  place-items: center;
}
.freva-term .tl.close {
  background: #ff5f56;
}
.freva-term .tl.min {
  background: #febc2e;
}
.freva-term .tl.zoom {
  background: #28c840;
}
.freva-term .tl span {
  font-size: 9px;
  line-height: 1;
  font-weight: 700;
  color: rgba(0, 0, 0, 0.55);
  opacity: 0;
  transition: opacity 0.1s;
}
.freva-term .traffic:hover .tl span {
  opacity: 1;
}

/* OS-specific window controls */
/* Windows: labelled buttons on the RIGHT, order min · max · close, red close hover. */
.freva-term[data-os="windows"] .traffic {
  order: 99;
  gap: 0;
  margin: 0 0 0 4px;
}
.freva-term[data-os="windows"] .tl {
  width: 34px;
  height: 26px;
  border-radius: 0;
  background: transparent !important;
  color: #aab8d4;
}
.freva-term[data-os="windows"] .tl span {
  opacity: 1;
  color: currentColor;
  font-size: 12px;
}
.freva-term[data-os="windows"] .tl.min {
  order: 1;
}
.freva-term[data-os="windows"] .tl.zoom {
  order: 2;
}
.freva-term[data-os="windows"] .tl.close {
  order: 3;
}
.freva-term[data-os="windows"] .tl:hover {
  background: #1b2942 !important;
  color: #fff;
}
.freva-term[data-os="windows"] .tl.close:hover {
  background: #e81123 !important;
  color: #fff;
}
.freva-term[data-os="windows"] .tl.min span::before {
  content: "\\2013";
} /* – */
.freva-term[data-os="windows"] .tl.zoom span::before {
  content: "\\25A1";
} /* □ */
.freva-term[data-os="windows"] .tl.close span::before {
  content: "\\2715";
} /* ✕ */
.freva-term[data-os="windows"] .tl span {
  font-size: 0;
}
.freva-term[data-os="windows"] .tl span::before {
  font-size: 12px;
}

/* Linux (GNOME-ish): rounded symbolic buttons on the RIGHT. */
.freva-term[data-os="linux"] .traffic {
  order: 99;
  gap: 7px;
  margin: 0 0 0 4px;
}
.freva-term[data-os="linux"] .tl {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: #26364f !important;
  color: #d3ddf0;
}
.freva-term[data-os="linux"] .tl.min {
  order: 1;
}
.freva-term[data-os="linux"] .tl.zoom {
  order: 2;
}
.freva-term[data-os="linux"] .tl.close {
  order: 3;
}
.freva-term[data-os="linux"] .tl:hover {
  background: #33496b !important;
}
.freva-term[data-os="linux"] .tl.close {
  background: #3a2730 !important;
  color: #ffb4a8;
}
.freva-term[data-os="linux"] .tl.close:hover {
  background: #c0392b !important;
  color: #fff;
}
.freva-term[data-os="linux"] .tl span {
  opacity: 1;
  color: currentColor;
  font-size: 0;
}
.freva-term[data-os="linux"] .tl.min span::before {
  content: "\\2013";
}
.freva-term[data-os="linux"] .tl.zoom span::before {
  content: "\\25A1";
}
.freva-term[data-os="linux"] .tl.close span::before {
  content: "\\2715";
}
.freva-term[data-os="linux"] .tl span::before {
  font-size: 11px;
}
.freva-term .cmd-tab {
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
.freva-term .cmd-tab.on {
  background: rgba(79, 141, 247, 0.18);
  color: #8fb6ff;
}
.freva-term .copy-ic {
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
.freva-term .copy-ic:hover {
  color: #fff;
  border-color: #34507c;
}
.freva-term .copy-ic.done {
  color: #28c840;
  border-color: #28c840;
}
.freva-term .term-body {
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
.freva-term.zoomed .term-body {
  max-height: none;
}
.freva-term .term-body::-webkit-scrollbar {
  width: 10px;
}
.freva-term .term-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.16);
  border-radius: 6px;
}
.freva-term.minimized .term-body {
  display: none;
}
.freva-term.zoomed .term-body {
  min-height: 220px;
}
.freva-term .prompt {
  color: var(--term-prompt);
  font-weight: 700;
}
.freva-term .fixed {
  color: var(--term-fg);
  font-weight: 600;
  opacity: 0.92;
}
.freva-term .fixed.cont {
  color: #44566f;
  font-weight: 400;
}
.freva-term .k {
  color: var(--term-key);
}
.freva-term .v {
  color: var(--term-val);
}
.freva-term .eq {
  color: var(--term-dim);
}
.freva-term .term-flav {
  color: #c79bf0;
}
.freva-term .term-scope {
  color: #6f7f9c;
  opacity: 0.85;
} /* the base scope: shown so a copied command reproduces results, but visibly not typed */
.freva-term .bad {
  color: #f0795f;
  text-decoration: underline wavy #f0795f;
  text-underline-offset: 3px;
}
.freva-term .cli-line {
  white-space: pre-wrap;
  word-break: break-word;
}
.freva-term .term-edit {
  margin-top: 2px;
}
.freva-term .te-wrap {
  position: relative;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.85;
}
.freva-term .te-hl,
.freva-term .te-input {
  margin: 0;
  font: inherit;
  line-height: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 2px 0;
  border: none;
}
.freva-term .te-hl {
  position: absolute;
  inset: 0;
  color: #d7e2f4;
  pointer-events: none;
}
.freva-term .te-input {
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
.freva-term .te-input::placeholder {
  color: #44566f;
}
.freva-term.fallback .te-hl {
  display: none;
}
.freva-term.fallback .te-input {
  color: var(--term-fg);
  caret-color: var(--term-fg);
}
.freva-term .te-warn {
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
.freva-term .te-warn.show {
  display: block;
}
.freva-term .py-view {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.9;
  padding: 4px 2px;
}
/* The generic multi-line edit row.
   NO \`gap\`. The gutter is exactly as wide as the read-only prompt column (4 monospace columns for
   python) and the editable layers carry the matching indent; a flex gap on top of that pushed the
   typed kwargs a further 8px right of the \`>>> \` lines they have to line up under. These rules sit
   ABOVE the per-tab ones deliberately, so a tab that states its own gutter metrics wins. */
.freva-term .term-editrow {
  display: flex;
  align-items: flex-start;
  min-width: 0;
}
.freva-term .term-editrow > .te-editor {
  flex: 1;
  min-width: 0;
}
.freva-term .term-gutter {
  flex-shrink: 0;
  white-space: pre;
  color: var(--term-dim);
  font-family: var(--font);
  font-size: 12.5px;
  line-height: 1.65;
  user-select: none;
}

.freva-term .py-line {
  display: flex;
  align-items: baseline;
}
/* The prompt (\`>>> \` / \`... \`) and the editable line's gutter MUST be the same width, or the typed
   kwargs won't line up under the read-only ones. Both are exactly 4 monospace columns. */
.freva-term .py-prompt,
.freva-term .py-gutter {
  display: inline-block;
  flex: 0 0 4ch;
  width: 4ch;
  padding-right: 0;
}
.freva-term .py-prompt {
  color: var(--term-prompt);
  font-weight: 700;
}
.freva-term .py-line.cont .py-prompt {
  color: #44566f;
  font-weight: 400;
}
.freva-term .py-code {
  color: var(--term-key);
}
.freva-term .py-ml {
  display: flex;
  align-items: flex-start;
}
.freva-term .py-gutter {
  white-space: pre;
  color: #44566f;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.9;
  user-select: none;
}
/* …and the editable text is indented by the same 4 spaces the read-only \`    key=\` lines carry. */
.freva-term .py-wrap {
  position: relative;
  flex: 1;
  min-width: 40px;
}
/* BOTH text layers carry the same 4-space indent as the read-only \`    key=\` lines. Padding the
   WRAPPER doesn't work: .py-hl is absolutely positioned, so it ignores the wrapper's padding and
   the overlay drifted out of alignment with the textarea beneath it. */
.freva-term .py-hl,
.freva-term .py-input {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.9;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  padding: 0 0 0 4ch;
}
.freva-term .py-hl {
  position: absolute;
  inset: 0;
  color: var(--term-val);
  pointer-events: none;
}
/* caret-color TRANSPARENT: we draw our own blinking block. Leaving the native caret on gave TWO
   cursors on the python line. */
.freva-term .py-input {
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
.freva-term .py-input::placeholder {
  color: #44566f;
}
.freva-term .py-ghost {
  color: #4d5d78;
}
.freva-term .py-out {
  color: #aeb9cf;
  margin: 0 0 2px;
  white-space: pre-wrap;
  word-break: break-word;
}
.freva-term .py-list {
  font-family: var(--mono);
  font-size: 12.5px;
}

/* Terminal host span */
.freva-term .term-host {
  color: #6f9cf0;
  word-break: break-all;
}

/* Windows: blue title bar */
.freva-term[data-os="windows"] .term-bar {
  background: linear-gradient(#1257c4, #0e46a0);
  border-bottom-color: #0a3a86;
}
.freva-term[data-os="windows"] .cmd-tab {
  color: #cfe0ff;
}
.freva-term[data-os="windows"] .cmd-tab.on {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}
.freva-term[data-os="windows"] .term-add,
.freva-term[data-os="windows"] .copy-ic {
  color: #dceaff;
}
.freva-term[data-os="windows"] .tl {
  color: #eaf1ff;
}
.freva-term[data-os="windows"] .tl:hover {
  background: rgba(255, 255, 255, 0.16) !important;
  color: #fff;
}
.freva-term[data-os="windows"] .tl.close:hover {
  background: #e81123 !important;
  color: #fff;
}

/* Inline ghost autocomplete */
.freva-term .te-ghost {
  color: #4d5d78;
}
.freva-term .te-hint {
  font-size: 10.5px;
  color: #4d5d78;
  margin-top: 3px;
  font-family: var(--mono);
}
.freva-term.fallback .te-hint {
  display: none;
}

/* In-terminal completion menu (shell-style, replaces the floating popover) */
.freva-term .te-menu,
.freva-term .py-menu {
  display: none;
  margin: 6px 0 2px;
  border: 1px solid #26364f;
  border-radius: 6px;
  max-height: 168px;
  overflow-y: auto;
  background: rgba(255, 255, 255, 0.03);
}
.freva-term .te-menu.show,
.freva-term .py-menu.show {
  display: block;
}
.freva-term .tm-item {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 3px 10px;
  font-family: var(--mono);
  font-size: 12px;
  color: #c7d4ea;
  cursor: pointer;
}
.freva-term .tm-item.hl {
  background: rgba(79, 141, 247, 0.22);
  color: #fff;
}
.freva-term .tm-item:hover {
  background: rgba(79, 141, 247, 0.12);
}
.freva-term .tm-val {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.freva-term .tm-cnt {
  color: #6f7f9c;
  flex-shrink: 0;
}

/* Terminal: real tabs, blinking cursor, read-only prefix, panels */

/* title bar + tabs */
.freva-term .term-bar {
  background: color-mix(in srgb, var(--term-bg) 82%, #fff 6%);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.freva-term .cmd-tab {
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
.freva-term .cmd-tab .tab-ic {
  display: inline-flex;
  opacity: 0.75;
}
.freva-term .cmd-tab[data-cmd="cli"] .tab-ic {
  color: #7ee0a8;
} /* bash */
.freva-term .cmd-tab[data-cmd="py"] .tab-ic {
  color: #f0c04d;
} /* python */
.freva-term .cmd-tab.on {
  background: var(--term-bg);
  color: var(--term-fg);
  border-color: rgba(255, 255, 255, 0.14);
  border-bottom: 1px solid var(--term-bg);
}
.freva-term .cmd-tab.on .tab-ic {
  opacity: 1;
}
.freva-term .cmd-tab:not(.on):hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--term-fg);
}

/* [copy] / info / colour controls */
.freva-term .copy-btn {
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
.freva-term .copy-btn .cb-caret {
  color: #7ee0a8;
  opacity: 0.8;
}
.freva-term .copy-btn:hover {
  color: var(--term-fg);
  background: rgba(255, 255, 255, 0.07);
}
.freva-term .copy-btn:hover .cb-caret {
  opacity: 1;
}
.freva-term .copy-btn.done,
.freva-term .copy-btn.done .cb-caret {
  color: #7ee0a8;
  opacity: 1;
}
.freva-term .term-kebab {
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
.freva-term .term-kebab:hover {
  color: var(--term-fg);
  background: rgba(255, 255, 255, 0.08);
}

/* blinking block cursor (a real terminal, not a text field) */
.freva-term .te-caret {
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
  .freva-term .te-caret {
    animation: none;
  }
}

/* it blinks whether or not the terminal has focus - it's the "start typing here" cue. When the
   input IS focused it's fully solid; unfocused it's a hollow box, the usual terminal convention. */
.freva-term .te-wrap:not(:focus-within) .te-caret,
.freva-term .py-wrap:not(:focus-within) .te-caret {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--term-fg);
}
.freva-term .py-fixedline .py-code,
.freva-term .py-ro {
  color: #7f8da3;
  font-style: italic;
  opacity: 0.82;
}

/* overflow (\\22ee) menu: terminal settings; the install guide lives in app-level Help */
.freva-term .term-menu {
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
.freva-term .term-menu.show {
  display: block;
}
.freva-term .tmn-h {
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #7b8aa6;
  font-family: var(--font);
  margin: 2px 2px 7px;
}
.freva-term .tmn-item {
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
.freva-term .tmn-item:hover {
  background: rgba(255, 255, 255, 0.09);
}

/* colour palette (persisted) */
.freva-term .term-bg-panel {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  padding: 0 2px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  margin-bottom: 4px;
}
.freva-term .bg-sw {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
}
.freva-term .bg-sw.on {
  outline: 2px solid #8fb6ff;
  outline-offset: 1px;
}

/* completion menu: the empty state says so, instead of showing nothing -- */
.freva-term .tm-empty {
  color: #6f7f9c;
  font-style: italic;
  cursor: default;
}
.freva-term .tm-empty:hover {
  background: none;
}

/* bash: the prefix and the command share ONE inline text flow.
   The geometry to avoid - an absolutely-positioned, non-wrapping prefix layer, a
   custom indent property written onto the input, a 62%-of-width threshold and a "prefix on its own
   line" escape hatch - WAS the wrapping defect, not a workaround for it: an indent shifts only the
   first line, so the moment the prefix itself wrapped, the painted prompt and the typed text
   disagreed. The replacement is \`.te-flow\` further down - plain inline siblings in one pre-wrap
   container. Those old rules are deliberately absent, and a test asserts they stay absent. */

/* no focus ring inside the terminal: the BLINKING CURSOR is the focus cue */
.freva-term .te-input:focus-visible,
.freva-term .py-input:focus-visible {
  outline: none;
}
.freva-term .te-wrap,
.freva-term .py-wrap {
  border: none;
  box-shadow: none;
}

/* Terminal: hint vs suggestion, and a bar that survives a narrow window */

/* 2) the GHOST is the only thing Tab will accept, so nothing else may look like it
   The placeholder must not be the same dim grey as the ghost, or \`project=cmip6 variable=tas\`
   read as a real suggestion waiting for Tab. The ghost keeps the "type-ahead" grey; the
   placeholder and the hint are italic and clearly *instructional* (a different hue entirely). */
.freva-term .te-ghost,
.freva-term .py-ghost {
  color: var(--term-ghost);
  font-style: normal;
}
.freva-term .te-input::placeholder,
.freva-term .py-input::placeholder {
  color: var(--term-ph);
  font-style: italic;
  opacity: 0.8;
}
.freva-term .te-hint {
  margin-top: 6px;
  font-family: var(--font);
  font-size: 11px;
  font-style: italic;
  color: var(--term-hint);
  opacity: 0.85;
  letter-spacing: 0.01em;
}
.freva-term .te-hint kbd,
.freva-term .tm-empty {
  font-family: var(--mono);
  font-style: normal;
}
/* keycaps: the hint keys look like real keys - subtle fill, a border with a thicker bottom edge for
   depth, and a hairline shadow. Tuned per terminal theme (dark tokens by default). */
.freva-term .te-hint kbd {
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
.freva-term[data-term-light="true"] .te-hint kbd {
  background: rgba(0, 0, 0, 0.06);
  border-color: rgba(0, 0, 0, 0.22);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.12);
}
/* Terminal footer: a status strip pinned under the body that carries the keyboard hint.
   The window has overflow:visible (so the ⋮ menu isn't clipped), so the footer rounds its OWN bottom
   corners to match the window. Hidden when docked (only the bar shows) or in the textarea fallback. */
.freva-term .term-foot {
  padding: 5px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 0 0 10px 10px;
  background: color-mix(in srgb, var(--term-bg) 96%, #000 5%);
  display: flex;
  align-items: center;
  min-height: 26px;
  flex-shrink: 0;
}
.freva-term .term-foot .te-hint {
  margin: 0;
  opacity: 0.9;
}
.freva-term[data-term-light="true"] .term-foot {
  border-top-color: rgba(0, 0, 0, 0.1);
  background: color-mix(in srgb, var(--term-bg) 92%, #000 4%);
}
.freva-term.minimized .term-foot,
.freva-term.fallback .term-foot {
  display: none;
}
/* the "how to type this" rows in the menu are guidance, not completions */
.freva-term .tm-empty {
  color: var(--term-hint);
  font-style: italic;
  cursor: default;
}
.freva-term .tm-empty:hover {
  background: none;
}

/* 5) narrow window: the window controls must never be pushed out of the bar */
.freva-term.show {
  min-width: 340px;
}
.freva-term .term-bar {
  flex-wrap: nowrap;
}
.freva-term .traffic,
.freva-term .term-add,
.freva-term .copy-btn,
.freva-term .term-kebab {
  flex: 0 0 auto;
}
.freva-term .cmd-tab {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
}
.freva-term .cmd-tab .tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* below this WINDOW width (set by a ResizeObserver on the terminal itself - a viewport media
   query can't see the window's own size) the tab labels give way before the controls do */
.freva-term.narrow .cmd-tab .tab-label {
  display: none;
}
.freva-term.narrow .copy-btn .cb-word {
  display: none;
}

/* 7) opacity slider in the ⋮ menu */
.freva-term .tmn-alpha {
  padding: 2px 2px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  margin-bottom: 4px;
}
.freva-term .term-alpha {
  width: 100%;
  accent-color: #8fb6ff;
  cursor: pointer;
}

/* completion menu placement
   The window sits in the bottom-right corner, so a list under the caret is often below the fold of
   the scrolling body. When there is no room beneath, the menu FLIPS to sit directly above the
   prompt - the same thing a shell does when completing at the bottom of a screen. Explicit flex
   \`order\` values (rather than DOM order) let the menu move without moving anything else. */
.freva-term .term-view {
  display: flex;
  flex-direction: column;
}
.freva-term .term-view > .term-head {
  order: 10;
}
.freva-term .term-view > .term-edit {
  order: 20;
}
.freva-term .term-view > .tm-menu {
  order: 30;
}
.freva-term .term-view > .te-warn {
  order: 40;
}
.freva-term .term-view > .term-foot-lines {
  order: 50;
}
.freva-term .term-view.menu-above > .tm-menu {
  order: 15; /* between the read-only header and the prompt line */
  margin: 0 0 6px;
}

/* NOTE: there is deliberately no blanket dimming of \`.term-head .te-prompt\` here. It would dim
   every prompt in the header and footer, sweeping up python's real \`>>>\` lines along with the
   \`...\` continuations. Continuations are dimmed by their own kind (\`.te-contprompt\`, above). */

/* LAYOUT OVERRIDES for the extracted package's markup.

   These come last on purpose: everything above is the moved, unchanged visual
   identity, and this block re-states only the geometry that actually changed. */

/* Container-relative window.
   \`position: fixed\` sized against \`100vw/58vh\` assumes the window owns the
   top-level page. Inside an embedded host - a mount relocated into a clipped,
   \`overflow: hidden\`, transformed container - that puts the window outside its
   own component and lets it be dragged out of reach. It is instead
   positioned and clamped against its MOUNT, which the host supplies. */
.freva-term.show {
  display: flex;
  flex-direction: column;
  position: absolute;
  z-index: 80;
  right: 20px;
  bottom: 20px;
  width: min(760px, calc(100% - 40px));
  height: min(58%, 440px);
  min-height: 220px;
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.55),
    0 0 0 1px rgba(255, 255, 255, 0.06);
}

/* The shared inline flow (THE WRAPPING FIX).
   The immutable prefix and the editable command are ordinary inline content in
   ONE \`pre-wrap\` flow. No \`text-indent\`, no absolute prefix layer, no width
   threshold, and no "prefix on its own line" mode - all four were the defect. The command
   therefore starts immediately after the last prefix token at every width, and a
   wrapped line continues at the container's normal left edge, like a shell. */
.freva-term .te-flow {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
  font-family: var(--font);
  font-size: 12.5px;
  line-height: 1.65;
  padding: 2px 0;
}
.freva-term .cli-prefix {
  /* explicitly NOT positioned and NOT nowrap - it wraps with the command */
  position: static;
  display: inline;
  white-space: inherit;
  padding: 0;
  pointer-events: none;
  user-select: none;
}
.freva-term .te-cmd {
  display: inline;
  outline: none;
  white-space: inherit;
  min-width: 1px;
  color: var(--term-fg);
  /* TRANSPARENT, like the plain fallback's textarea. This is a terminal: the cursor is the blinking
     BLOCK drawn beside it, and leaving the browser's thin native caret on gave two cursors - the
     same defect the python line had before the extraction, and the reason \`.py-input\` has carried
     \`caret-color: transparent\` all along. */
  caret-color: transparent;
}
.freva-term .te-cmd.is-empty::after {
  content: attr(data-placeholder);
  color: var(--term-ph);
  pointer-events: none;
}
/* The block cursor in the rich flow.
   It cannot be an inline node the way the plain overlay's is - inserting one at the caret would mean
   splitting the EDITABLE text, and nothing but the buffer may live in there. So it is an absolutely
   positioned sibling placed on the caret's own client rect, measured in \`paint()\`. That is what
   makes it follow the caret at the start, in the middle, at the end and onto a wrapped line: the
   rect of a collapsed range is already on the correct visual line. */
.freva-term .te-flow {
  position: relative;
}
.freva-term .te-flow > .te-caret {
  position: absolute;
  left: 0;
  top: 0;
  vertical-align: baseline;
}
/* Hidden only while a RANGE is selected - a selection draws its own highlight, and a block cursor
   inside it would be a second, contradictory cue. */
.freva-term .te-flow > .te-caret.hide {
  display: none;
}
/* Unfocused: the hollow parked box, the original terminal convention and the "start typing here"
   cue. \`.te-flow\` is the focus scope for the rich surface, exactly as \`.te-wrap\` is for the plain
   one. */
.freva-term .te-flow:not(:focus-within) > .te-caret {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--term-fg);
}
/* When a suggestion is showing and the cursor sits at the end of the buffer, the ghost starts where
   the cursor is drawn. Reserve the cursor's width so the suggestion appears AFTER the block rather
   than underneath it - which is where the pre-extraction inline caret pushed it. */
.freva-term .te-flow > .te-ghost.after-cursor {
  padding-left: 7px;
}
/* Presentation-only siblings of the editable node: they must not take a click, a caret or a
   selection, or the user could put the cursor "inside" a suggestion that is not in the buffer. */
.freva-term .te-flow > .te-ghost,
.freva-term .te-flow > .te-caret {
  pointer-events: none;
  user-select: none;
}

/* The explicit plain-textarea fallback */
.freva-term .te-plain {
  display: none;
}
/* \`.te-editor\` is on EVERY editor root; the per-tab \`\${prefix}-wrap\` class is not (python's root is
   \`.py-wrap\`). Keying the reveal off \`.te-wrap\` therefore left python's textarea permanently
   hidden even once \`data-mode\` was being written. */
.freva-term .te-editor[data-mode="plain"] .te-plain {
  display: block;
}
.freva-term .te-editor[data-mode="plain"] .te-flow {
  display: none;
}
.freva-term .te-editor[data-mode="rich"] .te-plain {
  display: none;
}
.freva-term .te-plainwrap {
  position: relative;
}
.freva-term .cli-prefix-block {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  position: static;
  padding: 2px 0 0;
}
.freva-term .te-plain .te-hl,
.freva-term .te-plain .te-input {
  text-indent: 0;
}

/* Tabs / views */
.freva-term .term-view {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.freva-term .term-head,
.freva-term .term-foot-lines {
  font-family: var(--font);
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--term-dim);
}
.freva-term .term-line {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.freva-term .term-edit {
  min-width: 0;
}
.freva-term .tm-menu {
  display: none;
}
.freva-term .tm-menu.show {
  display: block;
}

/* Segment colours.
   The package emits kind-prefixed classes (\`te-key\`, \`te-value\`, …) instead of
   the databrowser's bare \`.k\`/\`.v\`/\`.eq\`, because an unprefixed class in a
   shared subtree is a collision waiting to happen. Same palette. */
.freva-term .te-prompt {
  color: var(--term-prompt);
  font-weight: 700;
}
/* NO generic \`.te-fixed\` colour. One - say \`var(--term-dim)\` - would sit after \`.fixed\` in this
   sheet and quietly repaint BOTH tabs' immutable text the same grey. The two tabs do not share
   a colour: bash's \`freva-client databrowser data-search\` and its fixed flags
   are foreground-weight, and python's \`from freva_client import databrowser\` / \`databrowser(\` / \`)\`
   are the KEY colour, because in python they are code rather than a command line. \`.fixed\` (further
   up) carries bash's treatment; python states its own below. */
.freva-term .term-view[data-cmd="py"] .te-fixed {
  color: var(--term-key);
  font-weight: 400;
  opacity: 1;
}
/* The \`...\` gutter of a read-only continuation line is quiet; a real \`>>>\` prompt is not. They used
   to be told apart by markup (\`.py-line.cont .py-prompt\`); the extraction paints both from
   segments, so the host says which is which and this styles the answer. */
.freva-term .te-contprompt {
  color: #44566f;
  font-weight: 400;
}
.freva-term .te-key {
  color: var(--term-key);
}
.freva-term .te-value {
  color: var(--term-val);
}
.freva-term .te-eq {
  color: var(--term-dim);
}
.freva-term .te-accent {
  color: var(--term-hint);
}
.freva-term .te-muted {
  color: var(--term-dim);
  font-style: italic;
  opacity: 0.82;
}
.freva-term .te-bad {
  color: #ff6b6b;
  text-decoration: underline wavy currentColor 1px;
  text-underline-offset: 3px;
}
.freva-term .te-ghost {
  color: var(--term-ghost);
  pointer-events: none;
}

/* Settings menu: it must survive being MINIMIZED.
   A minimized window is pinned to the bottom of its container, so a menu anchored
   under the title bar opened straight off the bottom edge and became unreachable.
   \`.above\` flips it over the bar; both placements are clamped to the container by
   the inline max-height the controller sets. */
.freva-term .term-menu {
  max-height: none;
  overflow-y: auto;
}
.freva-term .term-menu.above {
  top: auto;
  bottom: calc(100% + 6px);
}
.freva-term.minimized .term-menu.show {
  display: block;
}
/* The minimized dock hides most of the window, and these three have to opt back IN because the
   settings menu is still reachable from it. \`display: revert\` was the wrong way to do that for the
   colour panel: revert takes the class back to its UA default (\`block\`), which throws away the
   flex row - so the swatches lost their 7px gaps and stacked against each other. Each of these now
   opts back in to the display it actually uses. */
.freva-term.minimized .term-bg-panel {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.freva-term.minimized .bg-sw {
  flex: 0 0 24px; /* a fixed track, so a wrapped row keeps the same rhythm as an unwrapped one */
}
.freva-term.minimized .tmn-alpha,
.freva-term.minimized .tmn-item {
  display: revert;
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  .freva-term .te-caret {
    animation: none;
  }
}
`;
