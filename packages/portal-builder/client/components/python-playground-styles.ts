/**
 * The playground's own layout, injected at RUNTIME rather than imported as a stylesheet.
 *
 * WHY IT IS NOT A `.css` FILE. Astro collects the CSS of everything reachable from a page's client
 * graph - including through a dynamic `import()` - and links it from that page's `<head>`, which
 * is how it avoids painting unstyled content. An `import "./python-playground.css"` inside the
 * lazily loaded coordinator therefore becomes a `<link>` on every page of the site, documentation
 * pages included, and no bundler setting changes that. Adopted through a constructable stylesheet,
 * which also survives a strict `style-src 'self'`: a `<style>` element is inline style and a
 * careful portal's policy refuses one, so the element is only the fallback for an engine without
 * `adoptedStyleSheets`.
 *
 * The window's own appearance belongs to `@freva-org/freva-client-terminal`, and the console's to
 * `@freva-org/browser-python`. What is left for the portal is where the window sits, how a session
 * fills its body, and the two controls the portal added to the chrome.
 */

const CSS = `
.portal-python-window {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
/*
 * \`pointer-events\` is handed back by the window itself rather than by this shell. The shell spans
 * the whole overlay layer so the terminal's container-relative geometry has a viewport-sized box
 * to clamp against; taking pointer events too would swallow every click on the page behind it.
 */
.portal-python-window > .freva-term {
  pointer-events: auto;
}

/* the window body: a column of three */

/*
 * The window body OWNS ITS HEIGHT and hands what is left to one child. The terminal window gives
 * its body \`flex: 1 1 auto; min-height: 0\`, and everything below has to keep that going or the
 * chain breaks and the innermost element sizes to its own content - a short console at the top of
 * a maximized window with the window's background underneath it. So: the body is a column, the
 * status row and the notice are intrinsic, and the session host takes the remainder with
 * \`min-height: 0\` so its contents scroll rather than stretch it.
 */
.portal-python-window > .freva-term .term-body {
  display: flex;
  flex-direction: column;
  /* The body frames the terminal and does not scroll: the transcript inside the console is what
     scrolls, and two nested scrollers is how a prompt ends up unreachable. */
  overflow: hidden;
  padding: 0;
}
.portal-python-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* the compact status row */

/*
 * Intrinsic height, the window's own palette, and absent when it has nothing to say. This is where
 * the console's status goes with its own toolbar switched off: one line - "Loading browser Python…
 * — downloading the Python runtime", "Python is ready", a failure - plus the session count once
 * there is more than one. Always present it would be an empty strip; growing, a second toolbar.
 */
.portal-python-status {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.75rem;
  font-size: 0.72rem;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.72);
  background: rgba(255, 255, 255, 0.05);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.portal-python-status[hidden] {
  display: none;
}
.portal-python-status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* A dot, so the state is not carried by colour alone for a reader who cannot see the difference. */
.portal-python-status::before {
  content: "";
  flex: 0 0 auto;
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 999px;
  background: currentcolor;
  opacity: 0.55;
}
.portal-python-status[data-state="ready"] {
  color: rgba(179, 236, 179, 0.92);
}
.portal-python-status[data-state="error"] {
  color: rgba(255, 190, 178, 0.95);
  background: rgba(255, 120, 100, 0.12);
}

/* the session, filling the window's body */

.portal-python-session {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
/*
 * \`display: flex\` beats the user agent's \`[hidden] { display: none }\`, so without this an
 * inactive session stays on screen underneath the active one. Every rule in this file that sets
 * \`display\` on something that can be hidden needs its own such rule.
 */
.portal-python-session[hidden] {
  display: none;
}
/*
 * \`max-height: none\` as well as \`min-height: 0\`, because the console carries a 70vh ceiling of
 * its own for the free-standing case. Left in place it caps the terminal at 70% of the viewport
 * inside a maximized window and leaves the rest as dead space.
 */
.portal-python-session > freva-python-console,
.portal-python-session > .portal-python-frame {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  width: 100%;
  border: 0;
}

/* the session tabs, in the window's own title bar */

/*
 * \`inline-flex\` beats the user agent's \`[hidden]\` rule, so the strip needs its own
 * \`[hidden] { display: none }\` below to be hideable at all.
 */
.portal-python-tabbar {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.portal-python-tabs {
  display: inline-flex;
  gap: 0.25rem;
}
.portal-python-tabs[hidden] {
  display: none;
}
.portal-python-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.72rem;
  padding: 0.1rem 0.35rem 0.1rem 0.5rem;
  border-radius: 0.3rem;
  cursor: pointer;
  white-space: nowrap;
}
.portal-python-tab.is-active {
  background: rgba(255, 255, 255, 0.16);
}
.portal-python-tab:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 1px;
}
/*
 * The close control, inside the tab it ends. Quiet at rest and only on the tab it belongs to: a
 * row of tabs each wearing a bright cross reads as a list of things to get rid of. It is a span
 * rather than a nested \`<button>\`, which would be invalid inside the tab's own button - see the
 * note where it is built.
 */
.portal-python-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.05em;
  height: 1.05em;
  border-radius: 0.2rem;
  opacity: 0.5;
  line-height: 1;
  cursor: pointer;
}
.portal-python-tab-close[hidden] {
  display: none;
}
.portal-python-tab-close:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.2);
}
/*
 * The control that opens a session, at the end of the strip - where a reader of any editor with
 * tabs looks for it. Square, so it reads as an affordance rather than as a tab named plus.
 */
.portal-python-tab-add {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.35rem;
  height: 1.35rem;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.85rem;
  line-height: 1;
  border-radius: 0.3rem;
  cursor: pointer;
}
.portal-python-tab-add:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
}
.portal-python-tab-add:disabled {
  opacity: 0.4;
  cursor: default;
}
.portal-python-tab-add:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 1px;
}

/* the help panel */

/*
 * WHAT THE KEYS ARE, AND HOW TO GET A PACKAGE, as a panel rather than as a status line. Inside the
 * window, over its body, because a terminal's own reference belongs to that terminal; not modal
 * and it does not trap focus, because nothing behind it is unsafe to touch.
 *
 * THEY SCALE WITH THE TEXT SIZE: every size here is \`calc(Npx * var(--term-scale, 1))\`, the same
 * rule the rest of this window's chrome follows, so the reference grows with the transcript.
 *
 * AND THE SCROLLBAR IS NOT OVER THE TEXT. The scroll is on \`.portal-python-sheet-body\` rather than
 * on the panel, so the title and its close button keep their place, and \`scrollbar-gutter: stable\`
 * reserves the track whether or not it is in use - which stops a classic scrollbar taking its
 * width out of the description column and being painted over the words.
 */
.portal-python-sheet {
  position: absolute;
  right: 0.75rem;
  bottom: 0.75rem;
  z-index: 5;
  display: flex;
  flex-direction: column;
  width: min(calc(23rem * var(--term-scale, 1)), calc(100% - 1.5rem));
  max-height: calc(100% - 1.5rem);
  padding: calc(9px * var(--term-scale, 1)) calc(12px * var(--term-scale, 1));
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--term-bg, #12131a) 94%, #fff 6%);
  color: var(--term-fg, inherit);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5);
  font-size: calc(12.5px * var(--term-scale, 1));
  line-height: 1.45;
}
/*
 * The only scrolling box. \`min-height: 0\` because a flex item's default \`min-height: auto\` refuses
 * to shrink below its content, which pushes the panel past \`max-height\` and scrolls the window
 * instead of the panel.
 */
.portal-python-sheet-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  padding-right: calc(2px * var(--term-scale, 1));
}
.portal-python-sheet-head {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: calc(7px * var(--term-scale, 1));
}
.portal-python-sheet-title {
  margin: 0;
  font-size: calc(13px * var(--term-scale, 1));
  font-weight: 600;
}
.portal-python-sheet-close {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: calc(16px * var(--term-scale, 1));
  line-height: 1;
  padding: 0.1rem 0.3rem;
  border-radius: 0.25rem;
  cursor: pointer;
  opacity: 0.7;
}
.portal-python-sheet-close:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.16);
}
.portal-python-sheet-close:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 1px;
}
/*
 * A two-column list, which is what a key and its meaning are. A definition list rather than a
 * table: no header row, no second axis, and pairs are what a screen reader announces it as.
 * \`minmax(0, …)\` on BOTH columns is what lets either give way: a grid track's default minimum is
 * its content's, so \`auto 1fr\` with a \`white-space: nowrap\` key and a long sentence beside it
 * cannot narrow below the sum of the two - the panel overflows sideways and the vertical
 * scrollbar lands on the descriptions. With both tracks able to reach zero the row wraps instead.
 */
.portal-python-sheet-keys {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: calc(4px * var(--term-scale, 1)) calc(10px * var(--term-scale, 1));
  margin: 0;
}
.portal-python-sheet-keys dt {
  margin: 0;
  min-width: 0;
}
.portal-python-sheet-keys dt code {
  display: inline-block;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: calc(11.5px * var(--term-scale, 1));
  padding: 0.05em 0.35em;
  border-radius: 0.25rem;
  background: rgba(255, 255, 255, 0.12);
  white-space: nowrap;
}
.portal-python-sheet-keys dd {
  margin: 0;
  min-width: 0;
  opacity: 0.85;
  overflow-wrap: anywhere;
}
.portal-python-sheet-note {
  margin: calc(10px * var(--term-scale, 1)) 0 0;
  opacity: 0.85;
  overflow-wrap: anywhere;
}
.portal-python-sheet-link {
  display: inline-block;
  margin-top: calc(7px * var(--term-scale, 1));
  color: inherit;
  overflow-wrap: anywhere;
}

/* the session panel */

/*
 * A \`role="tabpanel"\` is focusable, and a focused panel must show it. The outline is inset because
 * the panel fills the window's body to the edge, where the window's rounding half clips it.
 */
.portal-python-session:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: -2px;
}

/* the notice line */

/*
 * Where a refusal is said: inside the window rather than beside the tree, because the window is
 * what the visitor is now looking at. \`role="status"\`, so a screen reader hears it without the
 * focus being taken away from wherever they were.
 */
.portal-python-notice {
  margin: 0;
  padding: 0.4rem 0.6rem;
  font-size: 0.78rem;
  line-height: 1.4;
  color: inherit;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}
.portal-python-notice[data-tone="warn"] {
  background: rgba(255, 154, 139, 0.14);
}
.portal-python-notice[hidden] {
  display: none;
}

/* motion */

/*
 * Nothing in this file animates, and this rule is here so that stays true. The window's own
 * transitions belong to \`@freva-org/freva-client-terminal\`, which honours the same preference in
 * its own stylesheet.
 */
@media (prefers-reduced-motion: reduce) {
  .portal-python-window,
  .portal-python-window * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
`;

/** Documents this stylesheet has been adopted into, so N windows cost one sheet. */
const adopted = new WeakSet<Document>();

/** Put the stylesheet where the page can use it, preferring the route a policy does not block. */
export function adoptPlaygroundStyles(doc: Document = document): void {
  if (adopted.has(doc)) return;
  adopted.add(doc);
  try {
    if (typeof CSSStyleSheet === "function" && Array.isArray(doc.adoptedStyleSheets)) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      return;
    }
  } catch {
    // an engine that has the API and refuses the sheet falls through to the element
  }
  const style = doc.createElement("style");
  style.textContent = CSS;
  doc.head.append(style);
}
