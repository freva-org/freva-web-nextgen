// window.ts - the terminal WINDOW, with nothing inside it.
//
// The chrome: frame, traffic lights, title bar, copy control, ⋮ settings menu, drag, resize,
// minimize-to-dock, maximize, and the colour/opacity/text-size appearance model. This is the ONLY
// window and `terminal.ts` is a content layer on top of it, so no second frame can drift from it.
// It owns nothing inside `body`: no editor, no tabs, no transcript, no idea what "copy" means -
// the host answers that with `copyText()`, and everything domain-specific arrives through options
// and leaves through callbacks.
//
// Geometry is CONTAINER-RELATIVE: positioned and clamped inside the mount target (or an explicit
// `bounds()` element), never against `window.innerWidth/innerHeight`, so an embedded host whose
// mount is clipped, offset or transformed keeps its window inside its own component.

import { Disposables, el, svgIcon } from "./dom.js";
import { ICONS } from "./icons.js";
import { STYLES } from "./styles.js";
import type {
  TerminalConfirmRequest,
  TerminalMenuItem,
  TerminalMenuSection,
  TerminalStorage,
  TerminalWindowHandle,
  TerminalWindowOptions,
} from "./types.js";

/** Built-in background presets. Each ships its own foreground, so text can never be unreadable. */
export const TERM_THEMES: Array<{
  id: string;
  label: string;
  bg: string;
  fg: string;
  light?: boolean;
}> = [
  { id: "black", label: "Black", bg: "#0b0f16", fg: "#d8e2f2" },
  { id: "ink", label: "Ink", bg: "#131a26", fg: "#d8e2f2" },
  { id: "graphite", label: "Graphite", bg: "#22262b", fg: "#e4e7ea" },
  { id: "midnight", label: "Midnight", bg: "#0d1b2a", fg: "#cfe3f7" },
  { id: "forest", label: "Forest", bg: "#10201a", fg: "#cfe9d9" },
  { id: "plum", label: "Plum", bg: "#1d1526", fg: "#e6d7f2" },
  { id: "paper", label: "Paper", bg: "#f4f1ea", fg: "#22262b", light: true },
];

export const MIN_W = 360;
export const MIN_H = 220;
const DRAG_THRESHOLD = 4;

/** Appearance defaults, and the bounds every stored value is clamped into on the way back in. */
export const DEFAULT_THEME = "black";
export const DEFAULT_ALPHA = 0.85;
/** Never so transparent the text stops working. */
export const MIN_ALPHA = 0.55;
export const DEFAULT_SCALE = 1;
export const MIN_SCALE = 0.8;
export const MAX_SCALE = 1.6;

/**
 * Documents that already carry this package's stylesheet, so N windows cost one sheet. A `WeakMap`
 * because a host may discard documents - an iframe, a print view - and a strong reference here
 * would keep them alive for the life of the page.
 */
const adopted = new WeakMap<Document, true>();

/**
 * Put the stylesheet where the page can use it, preferring the route a policy does not block.
 *
 * A `<style>` element is INLINE STYLE, and a host with `style-src 'self'` refuses it, leaving the
 * window a stack of unstyled buttons. A constructable stylesheet is not a style element and CSP
 * does not govern it, so it is tried first; `<style>` remains for engines without
 * `adoptedStyleSheets`. Adopted into the DOCUMENT, not a shadow root: this window is deliberately
 * not in one - a host has to style it - and the sheet is already scoped to `.freva-term`.
 */
function adoptStyles(doc: Document, root: HTMLElement): void {
  try {
    if (typeof CSSStyleSheet === "function" && Array.isArray(doc.adoptedStyleSheets)) {
      if (!adopted.has(doc)) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(STYLES);
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
        adopted.set(doc, true);
      }
      return;
    }
  } catch {
    // an engine that has the API and refuses the sheet falls through to the element
  }
  const styleEl = el("style", { type: "text/css" });
  styleEl.textContent = STYLES;
  root.append(styleEl);
}

/** Clipboard fallback for plain-HTTP contexts. Reports whether the text really got there. */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Is there a selection a press would destroy? Checked on the document and on every shadow tree up
 * from the pressed node: a selection inside a shadow root is not always reported by the document's
 * own `getSelection()`, and this window's content is often a custom element with such a tree.
 */
function selectionIsEmpty(node: Element | null): boolean {
  const held = (sel: Selection | null | undefined): boolean =>
    Boolean(sel && sel.isCollapsed === false && sel.toString().trim() !== "");
  if (held(node?.ownerDocument?.defaultView?.getSelection?.())) return false;
  for (let el: Element | null = node; el; el = el.parentElement) {
    const root = el.shadowRoot as (ShadowRoot & { getSelection?: () => Selection | null }) | null;
    if (held(root?.getSelection?.())) return false;
  }
  return true;
}

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Number.isFinite(value) ? value : lo));

/**
 * Re-home every `title` onto the host's tooltip attribute. Exported because a content layer appends
 * controls AFTER the window is built, and a native `title` inside a host that renders its own
 * tooltips produces two popups for one control. Idempotent: a node with no `title` is left alone.
 */
export function applyTooltipAttribute(root: HTMLElement, attr: string): void {
  if (attr === "title") return;
  for (const node of root.querySelectorAll<HTMLElement>("[title]")) {
    const value = node.getAttribute("title") ?? "";
    node.removeAttribute("title");
    node.setAttribute(attr, value);
    // `title` doubles as the accessible name for an icon-only control; the host attribute does not.
    if (!node.getAttribute("aria-label") && !(node.textContent ?? "").trim()) {
      node.setAttribute("aria-label", value);
    }
  }
}

export function createTerminalWindow(
  mount: HTMLElement,
  opts: TerminalWindowOptions = {},
): TerminalWindowHandle {
  const dis = new Disposables();
  const storage: TerminalStorage | undefined = opts.storage;

  // `data-os` drives the window-control style (macOS dots / Windows buttons / Linux symbolic).
  const root = el("div", { class: "freva-term cmd", "data-os": opts.os ?? "mac" });
  adoptStyles(mount.ownerDocument ?? document, root);

  const tl = (cls: string, label: string, glyph: string): HTMLButtonElement =>
    el("button", { class: `tl ${cls}`, type: "button", title: label, "aria-label": label }, [
      el("span", { text: glyph }),
    ]);
  const closeBtn = tl("close", opts.closeLabel ?? "Close", "✕");
  const minBtn = tl("min", "Minimize", "–");
  const zoomBtn = tl("zoom", "Maximize", "+");

  const copyBtn = el(
    "button",
    {
      class: "copy-btn",
      type: "button",
      title: opts.copyTitle ?? "Copy command",
      "aria-label": opts.copyTitle ?? "Copy command",
    },
    [
      el("span", { class: "cb-caret", text: "❯" }),
      el("span", { class: "cb-word", text: opts.copyLabel ?? "copy" }),
    ],
  );
  const kebabBtn = el(
    "button",
    {
      class: "term-kebab",
      type: "button",
      title: "Terminal settings",
      "aria-label": "Terminal settings",
      "aria-haspopup": "true",
      "aria-expanded": "false",
    },
    [svgIcon(ICONS.kebab, 14)],
  );

  // THE BAR IS THREE SLOTS, and that is the whole of its layout.
  //
  //   [ start: window controls, then the host's identity ] [ spacer ] [ end: copy, host, kebab ]
  //
  // Two named groups, not one flat row: `data-os="windows"` and `data-os="linux"` move `.traffic`
  // to the end with `order: 99`, and a spacer with no order of its own stays BEFORE the copy
  // button, pushing the right-hand controls against the host's title. A gap between two named
  // groups holds for every `data-os`, and `addBarControl` puts a control in the right group.
  const traffic = el("span", { class: "traffic" }, [closeBtn, minBtn, zoomBtn]);
  const spacer = el("div", { class: "spacer" });
  const barStart = el("div", { class: "term-bar-group term-bar-start" });
  const barEnd = el("div", { class: "term-bar-group term-bar-end" });
  const bar = el("div", { class: "term-bar" }, [barStart, spacer, barEnd]);
  const body = el("div", { class: "term-body" });
  const foot = opts.foot === true ? el("div", { class: "term-foot" }) : null;

  // settings menu

  const bgPanel = el("div", {
    class: "term-bg-panel",
    role: "listbox",
    "aria-label": "Terminal colour",
  });
  const alphaEl = el("input", {
    class: "term-alpha",
    type: "range",
    min: String(MIN_ALPHA),
    max: "1",
    step: "0.01",
    "aria-label": "Terminal opacity",
    title: "Terminal opacity",
  }) as HTMLInputElement;
  const scaleEl = el("input", {
    class: "term-scale",
    type: "range",
    min: String(MIN_SCALE),
    max: String(MAX_SCALE),
    step: "0.05",
    "aria-label": "Terminal text size",
    title: "Terminal text size",
  }) as HTMLInputElement;
  const resetBtn = el("button", {
    class: "tmn-item tmn-reset",
    type: "button",
    role: "menuitem",
    text: "Reset appearance",
  });

  // Appearance is a NESTED group, open by default: the menu also carries session actions, and a
  // flat list mixing a colour picker with "End session" reads as one undifferentiated column. The
  // disclosure labels and bounds the group - a collapsed colour picker is one nobody finds.
  const appearancePanel = el("div", { class: "tmn-subpanel", id: "term-appearance" }, [
    el("div", { class: "tmn-h", text: "Colour" }),
    bgPanel,
    el("div", { class: "tmn-h", text: "Opacity" }),
    el("div", { class: "tmn-alpha" }, [alphaEl]),
    el("div", { class: "tmn-h", text: "Text size" }),
    el("div", { class: "tmn-alpha tmn-scale" }, [scaleEl]),
    resetBtn,
  ]);
  const appearanceBtn = el(
    "button",
    {
      class: "tmn-sub",
      type: "button",
      "aria-expanded": "true",
      "aria-controls": "term-appearance",
    },
    [
      el("span", { class: "tmn-sub-label", text: "Terminal settings" }),
      el("span", { class: "tmn-sub-chev", "aria-hidden": "true", text: "›" }),
    ],
  );
  const appearanceGroup = el("div", { class: "tmn-group open" }, [appearanceBtn, appearancePanel]);
  const appearanceLabel = appearanceBtn.querySelector<HTMLElement>(".tmn-sub-label");
  const hostSections = el("div", { class: "tmn-sections" });
  const settings = el("div", { class: "term-menu", role: "menu" }, [hostSections]);

  dis.listen(appearanceBtn, "click", () => {
    const open = appearanceGroup.classList.toggle("open");
    appearanceBtn.setAttribute("aria-expanded", open ? "true" : "false");
    const side = appearanceGroup.classList.contains("tmn-group--side");
    // AND THE MENU STOPS CLIPPING while it is out. `.term-menu` is `overflow-y: auto` with an
    // inline `max-height`, so a menu taller than the window scrolls instead of running off the
    // bottom, and a scroll container clips BOTH axes - `overflow-x: visible` beside an `auto`
    // computes to `auto` - cutting off a panel that hangs off the menu's left edge; no z-index
    // fixes that. Un-clipped only while the panel is open, which costs nothing: the flyout is what
    // makes the menu short enough not to need the scroll.
    settings.classList.toggle("has-flyout", open && side);
    // A flyout is positioned when it opens, not when it is built: the window is draggable, so the
    // menu may be anywhere by then. After `has-flyout`, to measure in the layout it is drawn in.
    if (open && side) placeFlyoutSoon();
  });

  /**
   * WHERE THE APPEARANCE PANEL FITS, on both axes.
   *
   * The vertical matters as much as the side: the panel is around 250px tall and pinned to the top
   * of the row that opens it, so on a window whose menu reaches the lower part of the screen -
   * where a terminal usually is - it opens off the bottom of the viewport. Measured against the
   * VIEWPORT, not the window: the window is `position: fixed` in its own overlay and its menu
   * already escapes its box, so what clips this panel is the edge of the screen.
   *
   *   - horizontally: to the left of the menu, where there is normally room because the menu hangs
   *     off the right end of the title bar; to the right when the left would not fit.
   *   - vertically: aligned with its row, pushed up by however much it overhangs the bottom, then
   *     clamped so it can never start above the top edge.
   *   - taller than the screen: scrollable rather than clipped, since at that size no offset fits.
   *
   * Both results are custom properties read by the stylesheet: no colours, no sizes, no display -
   * only where a box that already exists is allowed to be.
   */
  const FLYOUT_GAP = 8;
  function placeFlyout(): void {
    const panel = appearancePanel.getBoundingClientRect();
    const row = appearanceBtn.getBoundingClientRect();
    const menu = settings.getBoundingClientRect();
    const viewport = window.innerHeight || 0;

    const panelWidth = panel.width || 220;
    appearanceGroup.classList.toggle("tmn-group--right", menu.left - panelWidth < FLYOUT_GAP);

    // The height the panel WANTS, not the height it has: once capped and scrollable its measured
    // height is the cap, which creeps upward on every open. `scrollHeight` is the content's own.
    const wanted = Math.max(
      appearancePanel.offsetHeight,
      appearancePanel.scrollHeight,
      panel.height,
    );
    const room = viewport - FLYOUT_GAP * 2;
    const capped = wanted > room;
    appearanceGroup.style.setProperty(
      "--tmn-flyout-max",
      capped ? `${Math.max(120, room)}px` : "none",
    );

    const height = capped ? room : wanted;
    // Where its top would like to be, in viewport coordinates: level with its own row.
    const ideal = row.top - FLYOUT_GAP;
    const lowest = viewport - FLYOUT_GAP - height;
    const top = Math.max(FLYOUT_GAP, Math.min(ideal, lowest));
    appearanceGroup.style.setProperty("--tmn-flyout-top", `${Math.round(top - row.top)}px`);
  }

  /**
   * Place it, then place it again once the browser has finished with it. A box measured in the tick
   * the panel is revealed can be short of its final height - the swatch grid is not laid out yet -
   * and a panel measured 20px short is placed 20px too low. The second pass costs one unseen frame
   * and is the one whose numbers are right.
   */
  function placeFlyoutSoon(): void {
    placeFlyout();
    dis.setTimeout(() => {
      if (
        appearanceGroup.classList.contains("open") &&
        appearanceGroup.classList.contains("tmn-group--side")
      ) {
        placeFlyout();
      }
    }, 0);
  }

  /**
   * Rebuild the host's half of the menu. Called once at construction and on every update.
   *
   * WHERE THE APPEARANCE GROUP GOES is decided from the host's own list: an item marked
   * `appearance` becomes the group's trigger, in the host's order, opening to the side; with no
   * such item the group sits at the top of the menu, open, as an inline disclosure. It is the SAME
   * node either way - swatches, sliders and listeners - so it moves between the two homes rather
   * than being rebuilt, and `textContent = ""` below detaches it intact.
   */
  function renderSections(sections: readonly TerminalMenuSection[]): void {
    hostSections.textContent = "";
    appearanceGroup.remove();
    let placed = false;
    for (const section of sections) {
      if (section.items.length === 0) continue;
      const block = el("div", { class: "tmn-block" });
      if (section.title) block.append(el("div", { class: "tmn-h", text: section.title }));
      for (const item of section.items) {
        if (item.appearance === true) {
          placed = true;
          if (appearanceLabel) appearanceLabel.textContent = item.label;
          appearanceGroup.classList.add("tmn-group--side");
          appearanceGroup.classList.remove("open", "tmn-group--right");
          appearanceBtn.setAttribute("aria-expanded", "false");
          appearanceBtn.disabled = item.disabled === true;
          block.append(appearanceGroup);
          continue;
        }
        block.append(entryNode(item));
      }
      hostSections.append(block);
    }
    if (!placed) {
      appearanceGroup.classList.remove("tmn-group--side", "tmn-group--right");
      appearanceGroup.classList.add("open");
      appearanceBtn.disabled = false;
      appearanceBtn.setAttribute("aria-expanded", "true");
      settings.prepend(appearanceGroup);
    }
    // The rows are rebuilt on every state change, so `title` is re-homed here as well as at
    // construction: the first `setMenuSections` after mount would otherwise hand out a native one.
    applyTooltipAttribute(hostSections, opts.tooltipAttribute ?? "title");
  }

  function entryNode(item: TerminalMenuItem): HTMLElement {
    const cls = `tmn-item${item.danger ? " tmn-danger" : ""}`;
    // `title` first, then `applyTooltips()` re-homes it onto the host's own attribute - the route
    // every other control here takes, so a host with its own tooltips gets no second native popup.
    if (item.href) {
      return el("a", {
        class: cls,
        href: item.href,
        target: "_blank",
        rel: "noopener noreferrer",
        role: "menuitem",
        text: item.label,
        ...(item.title ? { title: item.title } : {}),
      });
    }
    const node = el("button", {
      class: cls,
      type: "button",
      role: "menuitem",
      text: item.label,
      disabled: item.disabled === true,
      ...(item.title ? { title: item.title } : {}),
    });
    dis.listen(node, "click", () => {
      // Remembered BEFORE the menu closes, because closing it loses the answer: a confirmation
      // raised from a menu row hands focus back to that row, not to the ⋮ button and not to the
      // document body, and by then `document.activeElement` no longer names it.
      lastMenuInvoker = node;
      closeSettings();
      item.onSelect?.();
    });
    return node;
  }

  const resizeGrip = el("div", { class: "term-resize", "aria-hidden": "true" });
  // WHICH SIDE THE WINDOW CONTROLS SIT ON: appearance follows the OS, position does not - the
  // default is the left for every OS style. `data-os` decides how close/minimise/maximise LOOK and
  // in what order - macOS dots, Windows labelled buttons, GNOME symbolic circles - because those
  // are the shapes a visitor recognises. Where the cluster SITS is a different question: this is a
  // panel inside somebody's page, not a window on their desktop, so following their OS edge gives
  // the same portal a different title bar for two readers side by side and leaves the bar with two
  // competing right-hand groups. A consumer that wants the desktop convention asks for it by name.
  (opts.controlsSide === "end" ? barEnd : barStart).append(traffic);
  if (opts.copyText) barEnd.append(copyBtn);
  barEnd.append(kebabBtn);
  root.append(bar, body, ...(foot ? [foot] : []), settings, resizeGrip);
  mount.append(root);

  renderSections([
    ...(opts.menuSections ?? []),
    ...(opts.menuItems && opts.menuItems.length > 0 ? [{ items: opts.menuItems }] : []),
  ]);

  // geometry

  const boundsEl = (): HTMLElement => opts.bounds?.() ?? mount;
  /** The container's box, in viewport coordinates. */
  const boundsBox = (): DOMRect => boundsEl().getBoundingClientRect();
  let placement: { left: string; top: string; width: string; height: string } | null = null;

  function stash(): void {
    placement = {
      left: root.style.left,
      top: root.style.top,
      width: root.style.width,
      height: root.style.height,
    };
  }
  function toCorner(): void {
    root.style.left = "";
    root.style.top = "";
    root.style.right = "";
    root.style.bottom = "";
    root.style.transform = "";
    root.style.width = "";
    root.style.height = "";
  }
  function restore(): void {
    if (!placement) return;
    root.style.left = placement.left;
    root.style.top = placement.top;
    root.style.width = placement.width;
    root.style.height = placement.height;
    if (placement.left) {
      root.style.right = "auto";
      root.style.bottom = "auto";
      root.style.transform = "none";
    }
    placement = null;
  }

  const isMinimized = (): boolean => root.classList.contains("minimized");
  const isMaximized = (): boolean => root.classList.contains("zoomed");

  // Minimized and maximized are mutually exclusive, and each setter reports the state it CLEARS: a
  // host mirroring the window into its own model has to hear both transitions, or it ends up
  // drawing a "restore down" control for a window that is no longer maximized.
  function setMinimized(next: boolean): void {
    if (next === isMinimized()) return;
    const cleared = next && isMaximized();
    root.classList.toggle("minimized", next);
    root.classList.remove("zoomed");
    closeSettings();
    if (next) {
      stash();
      toCorner();
    } else {
      restore();
    }
    if (cleared) opts.onMaximize?.(false);
    opts.onMinimize?.(next);
  }
  function setMaximized(next: boolean): void {
    if (next === isMaximized()) return;
    const cleared = next && isMinimized();
    root.classList.toggle("zoomed", next);
    root.classList.remove("minimized");
    closeSettings();
    if (next) {
      stash();
      toCorner();
    } else {
      restore();
    }
    if (cleared) opts.onMinimize?.(false);
    opts.onMaximize?.(next);
  }

  dis.listen(closeBtn, "click", () => hide());
  dis.listen(minBtn, "click", () => setMinimized(!isMinimized()));
  dis.listen(zoomBtn, "click", () => setMaximized(!isMaximized()));

  let drag: { dx: number; dy: number; started: boolean } | null = null;
  let rez: { x: number; y: number; w: number; h: number } | null = null;
  let mdock: { startX: number; startRight: number; moved: boolean } | null = null;
  let dockMoved = false;

  /** Bar regions that never start a drag: the window's own controls, plus the host's. */
  const NO_DRAG = ".tl, .copy-btn, .term-kebab, .term-menu";
  const noDrag = (target: HTMLElement): boolean =>
    Boolean(target.closest(NO_DRAG)) ||
    (opts.dragExclude ? Boolean(target.closest(opts.dragExclude)) : false);

  dis.listen(bar, "click", (e) => {
    if (!isMinimized()) return;
    if (noDrag(e.target as HTMLElement)) return;
    if (dockMoved) {
      dockMoved = false;
      return; // that press was a drag, not a click - stay docked
    }
    setMinimized(false);
  });
  dis.listen(bar, "mousedown", (e) => {
    const me = e as MouseEvent;
    if (noDrag(me.target as HTMLElement)) return;
    // A maximized window doesn't move (Gmail): dragging one yanks it out of its !important layout.
    if (isMaximized()) return;
    const box = boundsBox();
    const r = root.getBoundingClientRect();
    if (isMinimized()) {
      // The dock slides HORIZONTALLY only, staying pinned to the container's bottom edge.
      mdock = { startX: me.clientX, startRight: box.right - r.right, moved: false };
      dockMoved = false;
      me.preventDefault();
      return;
    }
    drag = { dx: me.clientX - r.left, dy: me.clientY - r.top, started: false };
    me.preventDefault();
  });
  dis.listen(resizeGrip, "mousedown", (e) => {
    const me = e as MouseEvent;
    const r = root.getBoundingClientRect();
    rez = { x: me.clientX, y: me.clientY, w: r.width, h: r.height };
    me.preventDefault();
    me.stopPropagation();
  });
  dis.listen(window, "mousemove", (e) => {
    const me = e as MouseEvent;
    const box = boundsBox();
    if (drag) {
      if (!drag.started) {
        const r = root.getBoundingClientRect();
        root.classList.remove("zoomed");
        root.style.transform = "none";
        root.style.right = "auto";
        root.style.bottom = "auto";
        root.style.left = `${r.left - box.left}px`;
        root.style.top = `${r.top - box.top}px`;
        drag.started = true;
      }
      // All four container edges are hard walls; clamping against `window.innerWidth` instead would
      // let the window be dragged out of a mount that is smaller than, or offset from, the page.
      const r = root.getBoundingClientRect();
      const maxLeft = Math.max(0, box.width - r.width);
      const maxTop = Math.max(0, box.height - r.height);
      const x = Math.min(maxLeft, Math.max(0, me.clientX - drag.dx - box.left));
      const y = Math.min(maxTop, Math.max(0, me.clientY - drag.dy - box.top));
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
    } else if (mdock) {
      const dx = me.clientX - mdock.startX;
      if (!mdock.moved && Math.abs(dx) > DRAG_THRESHOLD - 1) {
        mdock.moved = true;
        dockMoved = true;
      }
      if (mdock.moved) {
        const width = root.getBoundingClientRect().width || 300;
        const maxRight = Math.max(0, box.width - width);
        const right = Math.min(maxRight, Math.max(0, mdock.startRight - dx));
        root.style.setProperty("--dock-right", `${right}px`);
      }
    } else if (rez) {
      const r = root.getBoundingClientRect();
      const maxW = Math.max(MIN_W, box.right - r.left - 8);
      const maxH = Math.max(MIN_H, box.bottom - r.top - 8);
      root.style.width = `${Math.min(maxW, Math.max(MIN_W, rez.w + (me.clientX - rez.x)))}px`;
      root.style.height = `${Math.min(maxH, Math.max(MIN_H, rez.h + (me.clientY - rez.y)))}px`;
      opts.onResize?.();
    }
  });
  dis.listen(window, "mouseup", () => {
    drag = null;
    rez = null;
    mdock = null;
  });

  /** Narrow WINDOW (not viewport): drop the tab labels before the controls get pushed out. */
  function fitBar(): void {
    const w = root.getBoundingClientRect().width;
    if (w > 0) root.classList.toggle("narrow", w < 460);
  }
  dis.listen(window, "resize", () => {
    if (!isShown()) return;
    fitBar();
    opts.onResize?.();
  });
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => {
      fitBar();
      opts.onResize?.();
    });
    ro.observe(root);
    dis.add(() => ro.disconnect());
  }

  // settings placement

  function closeSettings(): void {
    settings.classList.remove("show", "has-flyout");
    kebabBtn.setAttribute("aria-expanded", "false");
    // A flyout left open would be the first thing on screen the next time the menu is raised.
    if (appearanceGroup.classList.contains("tmn-group--side")) {
      appearanceGroup.classList.remove("open");
      appearanceBtn.setAttribute("aria-expanded", "false");
    }
  }

  // confirmation

  /**
   * The window's own confirmation, and why it is not `window.confirm()`, which blocks the whole
   * page, renders as "127.0.0.1 says…" in browser chrome, cannot be styled or reached by the
   * window's focus handling, paints in the browser's top layer, and in a sandboxed frame silently
   * returns false. This is a `role="alertdialog"` inside the window, in its own colours, above the
   * body - NOT a `<dialog showModal()>`, which also lands in the top layer, above the window it
   * belongs to and above any host surface the window is deliberately ordered beneath.
   */
  let confirmSeq = 0;
  let openConfirm: {
    resolve: (value: boolean) => void;
    root: HTMLElement;
    returnFocus: HTMLElement | null;
  } | null = null;
  let lastMenuInvoker: HTMLElement | null = null;

  function confirm(request: TerminalConfirmRequest): Promise<boolean> {
    // ONE AT A TIME: a second request is refused rather than queued. Two confirmations for one
    // action is how a double-press starts two sessions - the visitor answers the one they can see
    // and the one behind it still runs the action. `false` is the safe answer: nothing happens.
    if (openConfirm) return Promise.resolve(false);
    closeSettings();

    const returnFocus =
      request.returnFocus ??
      lastMenuInvoker ??
      (root.contains(root.ownerDocument.activeElement)
        ? (root.ownerDocument.activeElement as HTMLElement)
        : kebabBtn);
    lastMenuInvoker = null;

    const titleId = `term-confirm-title-${confirmSeq}`;
    const bodyId = `term-confirm-body-${confirmSeq}`;
    confirmSeq += 1;

    const cancelBtn = el("button", {
      class: "term-confirm-btn",
      type: "button",
      text: request.cancelLabel ?? "Cancel",
    });
    const okBtn = el("button", {
      class: `term-confirm-btn term-confirm-ok${request.danger ? " term-confirm-danger" : ""}`,
      type: "button",
      text: request.confirmLabel ?? "Confirm",
    });
    const panel = el(
      "div",
      {
        class: "term-confirm",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
        "aria-describedby": bodyId,
      },
      [
        el("h2", { class: "term-confirm-title", id: titleId, text: request.title }),
        el("p", { class: "term-confirm-body", id: bodyId, text: request.body }),
        el("div", { class: "term-confirm-actions" }, [cancelBtn, okBtn]),
      ],
    );
    const scrim = el("div", { class: "term-confirm-scrim" }, [panel]);

    const settle = (value: boolean): void => {
      if (!openConfirm || openConfirm.root !== scrim) return;
      const { resolve, returnFocus: back } = openConfirm;
      openConfirm = null;
      scrim.remove();
      // Back to where the person was, and only if the window still has them: a window that was
      // closed while the question was open must not pull the focus back out of the page.
      if (back?.isConnected) back.focus();
      resolve(value);
    };

    // A TRAP, not a suggestion: Tab and Shift+Tab cycle between the two buttons and nothing else,
    // so a keyboard visitor cannot type into the terminal behind an unanswered question. Escape
    // cancels, which is what Escape means everywhere else in this window.
    scrim.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        settle(false);
        return;
      }
      if (key !== "Tab") return;
      const order = [cancelBtn, okBtn];
      const at = order.indexOf(root.ownerDocument.activeElement as HTMLButtonElement);
      const next = (event as KeyboardEvent).shiftKey ? at - 1 : at + 1;
      event.preventDefault();
      order[((next % order.length) + order.length) % order.length]?.focus();
    });
    // A press on the scrim is not an answer. It closes nothing: an alertdialog asks a question that
    // has to be answered, and dismissing it by clicking beside it is how people cancel by accident.
    scrim.addEventListener("mousedown", (event) => {
      if (event.target === scrim) event.preventDefault();
    });
    cancelBtn.addEventListener("click", () => settle(false));
    okBtn.addEventListener("click", () => settle(true));

    root.append(scrim);
    const promise = new Promise<boolean>((resolve) => {
      openConfirm = { resolve, root: scrim, returnFocus };
    });
    // CANCEL takes the focus, always. The destructive answer is never one blind Enter away.
    cancelBtn.focus();
    return promise;
  }
  /**
   * A MINIMIZED window is pinned to the container's bottom edge, so a menu anchored under its title
   * bar opens off the bottom, unreachable. Flip it ABOVE the bar, clamped to the container either
   * way, so the swatches, sliders and host items stay usable while docked.
   */
  function placeSettings(): void {
    const minimized = isMinimized();
    settings.classList.toggle("above", minimized);
    const box = boundsBox();
    const r = root.getBoundingClientRect();
    const barH = bar.getBoundingClientRect().height || 40;
    if (minimized) {
      settings.style.bottom = `calc(100% + 6px)`;
      settings.style.top = "auto";
      settings.style.maxHeight = `${Math.max(120, Math.floor(r.top - box.top - 12))}px`;
    } else {
      settings.style.top = `${Math.round(barH + 2)}px`;
      settings.style.bottom = "auto";
      settings.style.maxHeight = `${Math.max(120, Math.floor(box.bottom - r.top - barH - 16))}px`;
    }
  }
  dis.listen(kebabBtn, "click", (e) => {
    e.stopPropagation();
    const open = settings.classList.toggle("show");
    kebabBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) placeSettings();
  });
  dis.listen(document, "mousedown", (e) => {
    if (!settings.classList.contains("show")) return;
    if ((e.target as HTMLElement).closest(".term-menu, .term-kebab")) return;
    closeSettings();
  });

  // appearance

  function applyTheme(id: string, persist = true): void {
    const t = TERM_THEMES.find((x) => x.id === id) ?? TERM_THEMES[0];
    root.style.setProperty("--term-bg", t.bg);
    root.style.setProperty("--term-fg", t.fg);
    // A light background needs the WHOLE token palette flipped, not just the text colour.
    root.setAttribute("data-term-light", t.light ? "true" : "false");
    for (const sw of root.querySelectorAll<HTMLElement>(".bg-sw")) {
      const on = sw.dataset.bg === t.id;
      sw.classList.toggle("on", on);
      sw.setAttribute("aria-selected", on ? "true" : "false");
    }
    if (persist) storage?.setTheme(t.id);
  }
  for (const t of TERM_THEMES) {
    bgPanel.append(
      el("button", {
        class: "bg-sw",
        type: "button",
        role: "option",
        "data-bg": t.id,
        title: t.label,
        "aria-label": t.label,
        style: `background:${t.bg}`,
      }),
    );
  }
  dis.listen(bgPanel, "click", (e) => {
    const sw = (e.target as HTMLElement).closest(".bg-sw") as HTMLElement | null;
    if (sw?.dataset.bg) applyTheme(sw.dataset.bg);
  });

  function applyAlpha(a: number, persist = true): void {
    const v = clamp(a, MIN_ALPHA, 1);
    root.style.setProperty("--term-alpha", String(v));
    alphaEl.value = String(v);
    if (persist) storage?.setAlpha(v);
  }
  dis.listen(alphaEl, "input", () => applyAlpha(Number(alphaEl.value)));

  /**
   * Text size, as a MULTIPLIER rather than a pixel value. The stylesheet's content sizes are
   * `calc(Npx * var(--term-scale))`, so one number moves the prompt, the transcript, the gutters
   * and the completion list together, leaving the chrome at the size the frame was drawn for: a
   * title bar that grew with its text would stop fitting its own controls.
   */
  function applyScale(s: number, persist = true): void {
    const v = clamp(s, MIN_SCALE, MAX_SCALE);
    root.style.setProperty("--term-scale", String(v));
    scaleEl.value = String(v);
    if (persist) storage?.setTextScale?.(v);
  }
  // `onResize` is fired by the CALLERS, never by `applyScale` itself: the initial application runs
  // while the window is still empty - the content layer's closures do not exist yet - so a resize
  // notification from inside the constructor would reach a half-initialised host.
  const setScale = (v: number): void => {
    applyScale(v);
    opts.onResize?.();
  };
  dis.listen(scaleEl, "input", () => setScale(Number(scaleEl.value)));

  function resetAppearance(): void {
    applyTheme(DEFAULT_THEME);
    applyAlpha(DEFAULT_ALPHA);
    setScale(DEFAULT_SCALE);
  }
  dis.listen(resetBtn, "click", () => {
    closeSettings();
    resetAppearance();
  });

  applyTheme(storage?.getTheme() ?? DEFAULT_THEME, false);
  applyAlpha(storage?.getAlpha() ?? DEFAULT_ALPHA, false);
  applyScale(storage?.getTextScale?.() ?? DEFAULT_SCALE, false);

  // copy

  dis.listen(copyBtn, "click", () => {
    const text = opts.copyText?.() ?? "";
    const word = copyBtn.querySelector<HTMLElement>(".cb-word");
    const caret = copyBtn.querySelector<HTMLElement>(".cb-caret");
    const label = opts.copyLabel ?? "copy";
    const done = (): void => {
      copyBtn.classList.add("done");
      if (caret) caret.textContent = "✓";
      if (word) word.textContent = "copied";
      dis.setTimeout(() => {
        copyBtn.classList.remove("done");
        if (caret) caret.textContent = "❯";
        if (word) word.textContent = label;
      }, 1200);
    };
    const fail = (): void => opts.onCopyFailed?.("Copy failed - select and copy manually.");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => {
        if (legacyCopy(text)) done();
        else fail();
      });
    } else if (legacyCopy(text)) done();
    else fail();
  });

  // A press in the body that landed on nothing interactive belongs to the content layer: in a
  // terminal that means "focus the prompt", which this file cannot know how to do. Reported on
  // `click`, not `mousedown`, and only when no selection is standing: a `preventDefault()` on
  // mousedown cancels the browser's own selection gesture, so dragging a line out of the transcript
  // would select nothing, and the window cannot tell where inside a shadow-DOM content element a
  // press landed - retargeting reports the host. The one press still cancelled lands on the body
  // element itself: bare space with no text to select, where the default would only unfocus it.
  dis.listen(body, "mousedown", (e) => {
    if (e.target === body) e.preventDefault();
  });
  dis.listen(body, "click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".tm-item, .term-menu, a, button, textarea, input, [contenteditable]")) return;
    if (!selectionIsEmpty(t)) return;
    opts.onBodyActivate?.();
  });

  // visibility

  function isShown(): boolean {
    return root.classList.contains("show");
  }
  function hide(): void {
    root.classList.remove("show");
    closeSettings();
    opts.onHide?.();
    opts.onClose?.();
  }
  function show(): void {
    root.classList.add("show");
    root.classList.remove("minimized");
    opts.onShow?.();
    fitBar();
  }

  const tooltipAttr = opts.tooltipAttribute ?? "title";
  applyTooltipAttribute(root, tooltipAttr);

  return {
    el: root,
    bar,
    barSpacer: spacer,
    barStart,
    barEnd,
    addBarControl(node: HTMLElement, side: "start" | "end" = "start"): void {
      // The ⋮ menu is ALWAYS last in the end group: it is the overflow for everything beside it,
      // and an overflow menu that is not at the end of the row it overflows is a menu nobody finds.
      if (side === "end") barEnd.insertBefore(node, kebabBtn);
      else barStart.append(node);
      fitBar();
    },
    body,
    foot,
    settings,
    show,
    hide,
    toggle(force?: boolean): void {
      const next = force ?? !isShown();
      if (next) show();
      else hide();
    },
    isShown,
    isMinimized,
    setMinimized,
    isMaximized,
    setMaximized,
    closeSettings,
    setMenuSections: renderSections,
    confirm,
    applyTheme,
    applyAlpha,
    applyTextScale: setScale,
    resetAppearance,
    fitBar,
    applyTooltips(): void {
      applyTooltipAttribute(root, tooltipAttr);
    },
    destroy(): void {
      dis.flush();
      root.remove();
    },
  };
}
