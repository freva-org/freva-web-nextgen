// terminal.ts - the reusable terminal window.
//
// It owns the CHROME and the INTERACTION: window frame, traffic lights, tabs, drag/resize/
// maximize/minimize, the completion menu, the highlighting surface, copy feedback, the settings
// (colour/opacity) menu, the keyboard-escape contract, and its own stylesheet.
//
// It owns NO application state. Everything domain-specific - what a token means, which values may
// be completed, what a commit does, what "copy" copies - arrives through the TerminalTab models the
// host supplies. That is what lets another freva-client command register a tab here without
// importing a data browser.
//
// Geometry is CONTAINER-RELATIVE. The window is positioned and clamped inside the mount target (or
// an explicit `bounds()` element), never against `window.innerWidth/innerHeight`, so an embedded
// host that relocates the mount into a clipped, transformed container still gets a window that
// stays inside its own component.

import { Disposables, el, makeDebounce, replaceChildren, svgIcon } from "./dom.js";
import { Editor, segmentNode } from "./editor.js";
import { ICONS } from "./icons.js";
import { STYLES } from "./styles.js";
import type {
  TerminalCompletion,
  TerminalCompletionItem,
  TerminalHandle,
  TerminalOptions,
  TerminalSegment,
  TerminalTab,
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

const MIN_W = 360;
const MIN_H = 220;
const DRAG_THRESHOLD = 4;

/** Clipboard fallback for plain-HTTP contexts. Reports whether the text really got there. */
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    return typeof document.execCommand === "function" && !!document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

function kbd(label: string): HTMLElement {
  return el("kbd", { text: label });
}
/** The keyboard-escape hint. Advertising the two exits is what WCAG 2.1.2 requires. */
function hintNodes(armed: boolean): Array<Node | string> {
  return armed
    ? [kbd("Tab ⇥"), " now leaves the terminal · type to keep completing"]
    : [
        kbd("Tab ⇥"),
        " completes · ",
        kbd("↓"),
        " lists all options · ",
        kbd("Esc"),
        " then ",
        kbd("Tab ⇥"),
        " to leave",
      ];
}

interface TabView {
  tab: TerminalTab;
  prefix: string;
  chip: HTMLElement;
  view: HTMLElement;
  head: HTMLElement;
  foot: HTMLElement;
  gutter: HTMLElement | null;
  menu: HTMLElement;
  warn: HTMLElement;
  editor: Editor;
  completion: TerminalCompletion | null;
  ghost: string;
  dirty: boolean;
  /** Warning owned by the last commit (control-token errors), kept across pure repaints. */
  commitWarn: string;
  revision: number;
}

export function createTerminal(mount: HTMLElement, opts: TerminalOptions): TerminalHandle {
  if (!opts.tabs.length) throw new Error("freva-client-terminal: at least one tab is required");
  const dis = new Disposables();
  const doc = mount.ownerDocument;

  // `data-os` drives the window-control style (macOS dots / Windows buttons / Linux symbolic).
  const root = el("div", { class: "freva-term cmd", "data-os": opts.os ?? "mac" });
  const styleEl = el("style", { type: "text/css" });
  styleEl.textContent = STYLES;
  root.append(styleEl);

  // chrome
  const tl = (cls: string, label: string, glyph: string): HTMLButtonElement =>
    el("button", { class: `tl ${cls}`, type: "button", title: label, "aria-label": label }, [
      el("span", { text: glyph }),
    ]);
  const closeBtn = tl("close", "Close", "✕");
  const minBtn = tl("min", "Minimize", "–");
  const zoomBtn = tl("zoom", "Maximize", "+");
  const addBtn = el("button", {
    class: "term-add",
    type: "button",
    title: "Reopen closed tab",
    "aria-label": "Reopen closed tab",
    text: "+",
  });
  const copyBtn = el(
    "button",
    { class: "copy-btn", type: "button", title: "Copy command", "aria-label": "Copy command" },
    [el("span", { class: "cb-caret", text: "❯" }), el("span", { class: "cb-word", text: "copy" })],
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
  const bar = el("div", { class: "term-bar" }, [
    el("span", { class: "traffic" }, [closeBtn, minBtn, zoomBtn]),
  ]);
  const body = el("div", { class: "term-body" });
  const hint = el("span", { class: "te-hint" }, hintNodes(false));
  const foot = el("div", { class: "term-foot" }, [hint]);
  const bgPanel = el("div", {
    class: "term-bg-panel",
    role: "listbox",
    "aria-label": "Terminal colour",
  });
  const alphaEl = el("input", {
    class: "term-alpha",
    type: "range",
    min: "0.55",
    max: "1",
    step: "0.01",
    "aria-label": "Terminal opacity",
    title: "Terminal opacity",
  }) as HTMLInputElement;
  const settings = el("div", { class: "term-menu", role: "menu" }, [
    el("div", { class: "tmn-h", text: "Colour" }),
    bgPanel,
    el("div", { class: "tmn-h", text: "Opacity" }),
    el("div", { class: "tmn-alpha" }, [alphaEl]),
  ]);
  for (const item of opts.menuItems ?? []) {
    if (item.href) {
      settings.append(
        el("a", {
          class: "tmn-item",
          href: item.href,
          target: "_blank",
          rel: "noopener noreferrer",
          role: "menuitem",
          text: item.label,
        }),
      );
    } else {
      const b = el("button", {
        class: "tmn-item",
        type: "button",
        role: "menuitem",
        text: item.label,
      });
      dis.listen(b, "click", () => {
        closeSettings();
        item.onSelect?.();
      });
      settings.append(b);
    }
  }
  const resizeGrip = el("div", { class: "term-resize", "aria-hidden": "true" });
  root.append(bar, body, foot, settings, resizeGrip);
  mount.append(root);

  // tabs
  const views = new Map<string, TabView>();
  const openTabs = new Set<string>(opts.tabs.map((t) => t.id));
  let active = opts.activeTab && openTabs.has(opts.activeTab) ? opts.activeTab : opts.tabs[0].id;
  let tabArmed = false;

  const fallbackOn = (): boolean => opts.fallback?.() === true;

  const setHint = (armed: boolean): void => {
    replaceChildren(hint, ...hintNodes(armed));
  };
  const armTabExit = (): void => {
    tabArmed = true;
    setHint(true);
  };
  const disarm = (): void => {
    tabArmed = false;
  };
  const tabLeaves = (ke: KeyboardEvent): boolean => {
    if (ke.shiftKey) return true; // unconditional escape route
    if (tabArmed) {
      tabArmed = false;
      return true;
    }
    return false;
  };

  // completion menu (rendered INSIDE the window, never a floating popover that would stack behind it)
  let menuItems: TerminalCompletionItem[] = [];
  let menuIndex = 0;
  let menuHost: HTMLElement | null = null;
  let menuAccept: ((v: string) => void) | null = null;
  const menuOpen = (): boolean => menuHost !== null && menuItems.length > 0;

  function renderMenu(): void {
    if (!menuHost) return;
    replaceChildren(menuHost);
    menuItems.forEach((it, i) => {
      menuHost!.append(
        el(
          "div",
          { class: `tm-item${i === menuIndex ? " hl" : ""}`, role: "option", "data-i": String(i) },
          [
            el("span", { class: "tm-val", text: it.value }),
            it.count === null || it.count === undefined
              ? null
              : el("span", { class: "tm-cnt", text: it.count.toLocaleString("en-US") }),
          ],
        ),
      );
    });
  }
  /**
   * Size and place the open menu inside the window. The window docks bottom-right, so a list drawn
   * below the caret is often past the body's bottom edge; cap it to the space that exists and flip
   * it above the prompt when there isn't enough - which is what a real shell does.
   */
  function placeMenu(host: HTMLElement): void {
    const view = host.parentElement;
    const bodyBox = body.getBoundingClientRect();
    if (!view || bodyBox.height === 0) return; // not laid out (hidden / jsdom) - keep the default
    const input = views.get(active)?.editor.inputEl;
    if (!input) return;
    const inputBox = input.getBoundingClientRect();
    const below = bodyBox.bottom - inputBox.bottom - 10;
    const above = inputBox.top - bodyBox.top - 10;
    const MIN = 96;
    const flip = below < MIN && above > below;
    view.classList.toggle("menu-above", flip);
    const room = Math.max(MIN, Math.floor(flip ? above : below));
    host.style.maxHeight = `${Math.min(220, room)}px`;
    host.scrollIntoView?.({ block: "nearest" });
  }
  function showMenu(
    host: HTMLElement,
    items: TerminalCompletionItem[],
    accept: (v: string) => void,
  ): void {
    if (!items.length) {
      hideMenu();
      return;
    }
    // Preserve the highlighted VALUE across refreshes: a slow host-side enrichment landing
    // mid-navigation must not snap the selection back to the first row.
    const prev = menuHost === host ? (menuItems[menuIndex]?.value ?? null) : null;
    menuItems = items;
    const at = prev === null ? -1 : items.findIndex((it) => it.value === prev);
    menuIndex = at >= 0 ? at : 0;
    menuAccept = accept;
    menuHost = host;
    renderMenu();
    host.classList.add("show");
    placeMenu(host);
  }
  /** No candidates -> say so, rather than silently doing nothing (which reads as broken). */
  function showEmptyMenu(host: HTMLElement, msg: string): void {
    menuItems = [];
    menuIndex = 0;
    menuAccept = null;
    menuHost = host;
    replaceChildren(host, el("div", { class: "tm-item tm-empty", text: msg }));
    host.classList.add("show");
    placeMenu(host);
  }
  function hideMenu(): void {
    if (menuHost) {
      menuHost.parentElement?.classList.remove("menu-above");
      menuHost.style.maxHeight = "";
      menuHost.classList.remove("show");
      replaceChildren(menuHost);
    }
    menuItems = [];
    menuIndex = 0;
    menuAccept = null;
    menuHost = null;
  }
  function moveMenu(d: number): void {
    if (!menuItems.length) return;
    menuIndex = (menuIndex + d + menuItems.length) % menuItems.length;
    renderMenu();
    (menuHost?.children[menuIndex] as HTMLElement | undefined)?.scrollIntoView?.({
      block: "nearest",
    });
  }
  function acceptMenu(): void {
    const it = menuItems[menuIndex];
    const cb = menuAccept;
    hideMenu();
    if (it && cb) cb(it.value);
  }

  // per-tab views
  function paintLines(host: HTMLElement, lines: TerminalSegment[][]): void {
    replaceChildren(host);
    host.style.display = lines.length ? "" : "none";
    for (const line of lines) {
      const row = el("div", { class: "term-line" });
      for (const seg of line) {
        if (!seg.text) continue;
        row.append(segmentNode(seg, doc));
      }
      host.append(row);
    }
  }

  function buildTab(tab: TerminalTab): TabView {
    const prefix = tab.cssPrefix ?? tab.id;
    const chip = el(
      "span",
      {
        class: "cmd-tab",
        "data-cmd": tab.id,
        role: "tab",
        tabindex: "0",
        "aria-selected": "false",
      },
      [
        tab.icon
          ? el("span", { class: "tab-ic", "aria-hidden": "true" }, [svgIcon(tab.icon, 13)])
          : null,
        el("span", { class: "tab-label", text: tab.label }),
        el("span", {
          class: "tab-x",
          role: "button",
          tabindex: "0",
          "aria-label": `Close ${tab.label} tab`,
          title: `Close ${tab.label}`,
          text: "×",
        }),
      ],
    );
    const head = el("div", { class: `term-head ${prefix}-fixed`, "aria-hidden": "true" });
    const footLines = el("div", {
      class: `term-foot-lines ${prefix}-close`,
      "aria-hidden": "true",
    });
    // `te-menu` is the GENERIC editor-menu class (like te-input / te-hl / te-caret); `${prefix}-menu`
    // is the per-tab alias the freva stylesheet and integration tests already address.
    const menu = el("div", { class: `tm-menu te-menu ${prefix}-menu`, role: "listbox" });
    const warn = el("div", { class: `te-warn ${prefix}-warn`, role: "alert" });
    const gutter = tab.multiline
      ? el("div", { class: `term-gutter ${prefix}-gutter`, "aria-hidden": "true" })
      : null;

    const state: TabView = {
      tab,
      prefix,
      chip,
      view: el("div", { class: `term-view ${prefix}-view`, "data-cmd": tab.id }),
      head,
      foot: footLines,
      gutter,
      menu,
      warn,
      editor: null as unknown as Editor,
      completion: null,
      ghost: "",
      dirty: false,
      commitWarn: "",
      revision: tab.revision?.() ?? 0,
    };

    state.editor = new Editor(
      dis,
      {
        multiline: tab.multiline === true,
        placeholder: tab.placeholder ?? "",
        ariaLabel: tab.ariaLabel ?? tab.label,
        cssPrefix: prefix,
      },
      {
        onInput: () => {
          if (tabArmed) {
            disarm();
            setHint(false);
          }
          applyFrom(state, false);
          // The ghost is computed from the buffer AFTER the commit, then painted - computing it
          // before would suggest against the previous keystroke, and painting before computing it
          // would draw the previous suggestion.
          refreshCompletion(state);
          repaint(state);
          if (menuOpen()) openList(state);
        },
        onCaretMove: () => {
          refreshCompletion(state);
          repaint(state);
        },
        onFocus: () => {
          opts.onFocusChange?.(true);
          repaint(state);
        },
        onBlur: () => {
          opts.onFocusChange?.(false);
          disarm();
          setHint(false);
          applyFrom(state, true); // blur completes the in-progress token
          repaint(state);
          dis.setTimeout(() => hideMenu(), 120);
        },
        onKeyDown: (ke) => onEditorKey(state, ke),
      },
    );
    // `${prefix}-ml` keeps the historical per-tab hook (`.py-ml`) that the freva stylesheet and the
    // integration tests address for the multi-line prompt row.
    const editRow = gutter
      ? el("div", { class: `term-editrow ${prefix}-ml` }, [gutter, state.editor.root])
      : state.editor.root;
    state.view.append(head, el("div", { class: "term-edit" }, [editRow]), menu, warn, footLines);
    return state;
  }

  for (const tab of opts.tabs) {
    const v = buildTab(tab);
    views.set(tab.id, v);
    bar.append(v.chip);
    body.append(v.view);
  }
  bar.append(addBtn, el("div", { class: "spacer" }), copyBtn, kebabBtn);

  // commit / paint
  function applyFrom(v: TabView, final: boolean): void {
    const result = v.tab.commit(v.editor.value, v.editor.caret, final);
    v.dirty = result.dirty;
    v.commitWarn = result.warning ?? "";
    repaint(v);
  }
  function setWarn(v: TabView, msg: string): void {
    if (msg) {
      v.warn.textContent = "⚠ " + msg;
      v.warn.classList.add("show");
    } else {
      v.warn.classList.remove("show");
      v.warn.textContent = "";
    }
  }
  function repaint(v: TabView): void {
    const text = v.editor.value;
    const { segments, warning } = v.tab.highlight(text);
    // A token-level warning (unknown key / invalid value) wins over the commit's control-token
    // message, matching the order the two were reported in before the extraction.
    setWarn(v, warning || v.commitWarn);
    v.editor.paint(segments, v.editor.isFocused() ? v.ghost : "");
    if (v.gutter) {
      const lines = Math.max(1, text.split("\n").length);
      v.gutter.textContent = Array.from({ length: lines }, () => "...").join("\n");
    }
  }
  function refreshCompletion(v: TabView): void {
    v.completion = null;
    v.ghost = "";
    if (fallbackOn() || !v.editor.isFocused()) return;
    const c = v.tab.complete(v.editor.value, v.editor.caret);
    if (!c) return;
    v.completion = c;
    v.ghost = c.ghost ?? "";
  }
  function acceptGhost(v: TabView): boolean {
    const c = v.completion;
    if (!c || !v.ghost || !c.ghostValue) return false;
    v.ghost = "";
    const next = c.apply(c.ghostValue);
    v.editor.value = next.text;
    v.editor.setCaret(next.caret);
    applyFrom(v, false);
    refreshCompletion(v);
    repaint(v);
    v.editor.focus();
    return true;
  }
  function openList(v: TabView): void {
    if (fallbackOn()) return hideMenu();
    const c = v.tab.complete(v.editor.value, v.editor.caret);
    v.completion = c;
    if (!c) return hideMenu();
    if (c.message) return showEmptyMenu(v.menu, c.message);
    if (!c.items.length) return showEmptyMenu(v.menu, "(no matching values)");
    showMenu(v.menu, c.items, (value) => {
      const next = c.apply(value);
      v.editor.value = next.text;
      v.editor.setCaret(next.caret);
      applyFrom(v, false);
      refreshCompletion(v);
      repaint(v);
      v.editor.focus();
    });
  }

  function onEditorKey(v: TabView, ke: KeyboardEvent): void {
    if (menuOpen()) {
      if (ke.key === "ArrowDown") {
        ke.preventDefault();
        moveMenu(1);
        return;
      }
      if (ke.key === "ArrowUp") {
        ke.preventDefault();
        moveMenu(-1);
        return;
      }
      if (ke.key === "Enter" || ke.key === "Tab") {
        ke.preventDefault();
        acceptMenu();
        return;
      }
      if (ke.key === "Escape") {
        ke.preventDefault();
        hideMenu();
        return;
      }
      return;
    }
    const text = v.editor.value;
    const caret = v.editor.caret;
    const atEnd = caret === text.length || text[caret] === "\n";
    if (ke.key === "ArrowDown" && (!v.tab.multiline || text.slice(caret).indexOf("\n") < 0)) {
      ke.preventDefault();
      openList(v);
      return;
    }
    // Tab belongs to the terminal (it completes, like a real shell) unless the user armed the exit
    // with Esc or used Shift+Tab. Both routes are advertised in the footer hint - WCAG 2.1.2.
    if (ke.key === "Tab") {
      if (tabLeaves(ke)) {
        setHint(false);
        return;
      }
      ke.preventDefault();
      if (v.ghost) acceptGhost(v);
      else openList(v);
      return;
    }
    if (v.ghost && (ke.key === "ArrowRight" || ke.key === "End") && atEnd) {
      ke.preventDefault();
      acceptGhost(v);
      return;
    }
    if (ke.key === "Escape") {
      ke.preventDefault();
      armTabExit();
      v.ghost = "";
      v.completion = null;
      repaint(v);
      return;
    }
    if (ke.key === "Enter" && !v.tab.multiline) {
      ke.preventDefault();
      applyFrom(v, true);
    }
  }

  for (const v of views.values()) {
    dis.listen(v.menu, "mousedown", (e) => {
      const row = (e.target as HTMLElement).closest(".tm-item") as HTMLElement | null;
      if (!row || row.classList.contains("tm-empty")) return;
      e.preventDefault();
      menuIndex = Number(row.dataset.i ?? "0");
      acceptMenu();
    });
  }

  // tab activation / close / reopen
  function syncTabsUI(): void {
    for (const [id, v] of views) {
      const open = openTabs.has(id);
      v.chip.style.display = open ? "" : "none";
      const on = active === id;
      v.chip.classList.toggle("on", on);
      v.chip.setAttribute("aria-selected", on ? "true" : "false");
      v.view.style.display = on ? "" : "none";
    }
    addBtn.style.display = openTabs.size < views.size ? "" : "none";
  }
  function activate(id: string): void {
    if (!openTabs.has(id)) return;
    active = id;
    syncTabsUI();
    hideMenu();
    const v = views.get(id);
    if (v) {
      renderTab(v);
      if (!fallbackOn()) v.editor.focus();
    }
    opts.onTabChange?.(id);
  }
  function closeTab(id: string): void {
    openTabs.delete(id);
    if (openTabs.size === 0) {
      for (const k of views.keys()) openTabs.add(k);
      active = opts.tabs[0].id;
      syncTabsUI();
      hide();
      return;
    }
    if (active === id) active = [...openTabs][0];
    syncTabsUI();
  }
  for (const [id, v] of views) {
    dis.listen(v.chip, "click", (e) => {
      if ((e.target as HTMLElement).closest(".tab-x")) {
        closeTab(id);
        return;
      }
      activate(id);
    });
    dis.listen(v.chip, "keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      if (k !== "Enter" && k !== " ") return;
      e.preventDefault();
      if ((e.target as HTMLElement).closest(".tab-x")) closeTab(id);
      else activate(id);
    });
  }
  dis.listen(addBtn, "click", () => {
    const missing = opts.tabs.find((t) => !openTabs.has(t.id));
    if (!missing) return;
    openTabs.add(missing.id);
    activate(missing.id);
  });

  // window geometry - CONTAINER-RELATIVE
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

  dis.listen(closeBtn, "click", () => hide());
  dis.listen(minBtn, "click", () => {
    const min = root.classList.toggle("minimized");
    root.classList.remove("zoomed");
    closeSettings();
    if (min) {
      stash();
      toCorner();
      hideMenu();
    } else {
      restore();
    }
  });
  dis.listen(zoomBtn, "click", () => {
    const zoom = root.classList.toggle("zoomed");
    root.classList.remove("minimized");
    closeSettings();
    if (zoom) {
      stash();
      toCorner();
    } else {
      restore();
    }
  });

  let drag: { dx: number; dy: number; started: boolean } | null = null;
  let rez: { x: number; y: number; w: number; h: number } | null = null;
  let mdock: { startX: number; startRight: number; moved: boolean } | null = null;
  let dockMoved = false;

  dis.listen(bar, "click", (e) => {
    if (!root.classList.contains("minimized")) return;
    if ((e.target as HTMLElement).closest(".tl, .cmd-tab, .term-add, .copy-btn, .term-kebab"))
      return;
    if (dockMoved) {
      dockMoved = false;
      return; // that press was a drag, not a click - stay docked
    }
    root.classList.remove("minimized");
    restore();
  });
  dis.listen(bar, "mousedown", (e) => {
    const me = e as MouseEvent;
    if (
      (me.target as HTMLElement).closest(
        ".tl, .cmd-tab, .copy-btn, .term-kebab, .term-add, .term-menu",
      )
    )
      return;
    // A maximized window doesn't move (Gmail): dragging one yanks it out of its !important layout.
    if (root.classList.contains("zoomed")) return;
    const box = boundsBox();
    const r = root.getBoundingClientRect();
    if (root.classList.contains("minimized")) {
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
      // All four container edges are hard walls, so the window can never be dragged out of its
      // own component - which is exactly what `window.innerWidth` clamping got wrong in an
      // embedded host whose mount is smaller than (or offset from) the page.
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
    syncFallback();
    fitBar();
    for (const v of views.values()) v.editor.fit();
  });
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => {
      fitBar();
      for (const v of views.values()) v.editor.fit();
    });
    ro.observe(root);
    dis.add(() => ro.disconnect());
  }

  // settings menu (⋮)
  function closeSettings(): void {
    settings.classList.remove("show");
    kebabBtn.setAttribute("aria-expanded", "false");
  }
  /**
   * A MINIMIZED window is pinned to the container's bottom edge, so a menu anchored under its title
   * bar opens straight off the bottom and is unreachable. Flip it ABOVE the bar, and clamp it to the
   * container either way, so the swatches, the opacity slider and the host's own items stay visible
   * and clickable while docked.
   */
  function placeSettings(): void {
    const minimized = root.classList.contains("minimized");
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

  // colour + opacity
  function applyTermTheme(id: string): void {
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
    opts.storage?.setTheme(t.id);
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
    if (sw?.dataset.bg) applyTermTheme(sw.dataset.bg);
  });
  function applyAlpha(a: number, persist = true): void {
    const v = Math.min(1, Math.max(0.55, a)); // never so transparent the text stops working
    root.style.setProperty("--term-alpha", String(v));
    alphaEl.value = String(v);
    if (persist) opts.storage?.setAlpha(v);
  }
  dis.listen(alphaEl, "input", () => applyAlpha(Number(alphaEl.value)));
  applyTermTheme(opts.storage?.getTheme() ?? "black");
  applyAlpha(opts.storage?.getAlpha() ?? 0.85, false);

  // copy
  dis.listen(copyBtn, "click", () => {
    const v = views.get(active);
    if (!v) return;
    const text = v.tab.copyText();
    const word = copyBtn.querySelector<HTMLElement>(".cb-word");
    const caret = copyBtn.querySelector<HTMLElement>(".cb-caret");
    const done = (): void => {
      copyBtn.classList.add("done");
      if (caret) caret.textContent = "✓";
      if (word) word.textContent = "copied";
      dis.setTimeout(() => {
        copyBtn.classList.remove("done");
        if (caret) caret.textContent = "❯";
        if (word) word.textContent = "copy";
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

  // click anywhere in the body focuses the prompt (it's a terminal, not a form)
  dis.listen(body, "mousedown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".tm-item, .term-menu, a, button, textarea, [contenteditable]")) return;
    e.preventDefault();
    if (!fallbackOn()) views.get(active)?.editor.focus();
  });

  // render
  function syncFallback(): void {
    const fb = fallbackOn();
    root.classList.toggle("fallback", fb);
    for (const v of views.values()) v.editor.setMode(fb ? "plain" : "rich");
  }
  function renderTab(v: TabView): void {
    v.editor.setPrefix(v.tab.prefix());
    paintLines(v.head, v.tab.headerLines?.() ?? []);
    paintLines(v.foot, v.tab.footerLines?.() ?? []);
    const rev = v.tab.revision?.() ?? 0;
    if (rev !== v.revision) {
      // The HOST changed the query from outside the terminal (a chip, Clear all, the map). That must
      // win even while the editor is focused - otherwise a half-typed draft survives a Clear all and
      // re-commits the very filters that were just cleared on the next keystroke. We MERGE rather
      // than overwrite: the committed part is rebuilt from state, the user's uncommitted tokens are
      // kept on the end.
      v.revision = rev;
      const focused = v.editor.isFocused();
      // …but retaining is only for text the user still OWNS. `retain()` answers "which tokens are
      // not currently committed", and after the host removes a filter its token stops being
      // committed too - so a clean, unfocused buffer kept the removed filter on screen and
      // re-committed it on the next keystroke. Removing a negative-facet chip put
      // `model_not_=model-000` straight back on the wire.
      //
      // Two things genuinely need protecting, and neither describes that case: a token the user is
      // still typing (the editor is FOCUSED), and a draft the terminal has already refused and
      // annotated (`dirty` - an unknown token has to stay visible with its warning until the user
      // fixes it). A clean, unfocused buffer has nothing in flight, so the host simply wins.
      const keep = focused || v.dirty ? (v.tab.retain?.(v.editor.value) ?? "") : "";
      const joiner = v.tab.multiline ? "\n" : " ";
      v.editor.value = [v.tab.text(), keep].filter(Boolean).join(joiner);
      if (focused) v.editor.setCaret(v.editor.value.length); // carry on typing where the text ends
      // The merged buffer is only CLEAN when nothing had to be retained. Clearing `dirty`
      // unconditionally here would let the very next render (the search this action triggered,
      // settling a moment later) rebuild the buffer from state and throw the retained draft away -
      // which is the whole thing the merge just went to the trouble of preserving.
      v.dirty = keep !== "";
    } else if (!v.editor.isFocused() && !v.dirty) {
      // Otherwise only rebuild a CLEAN, unfocused buffer - a dirty draft survives verbatim with its
      // warning until the user edits it themselves.
      v.editor.value = v.tab.text();
    }
    repaint(v);
  }
  function render(): void {
    syncFallback();
    for (const v of views.values()) renderTab(v);
    fitBar();
  }

  function isShown(): boolean {
    return root.classList.contains("show");
  }
  function hide(): void {
    root.classList.remove("show");
    hideMenu();
    closeSettings();
    opts.onClose?.();
  }
  function show(): void {
    root.classList.add("show");
    root.classList.remove("minimized");
    render();
    if (!fallbackOn()) views.get(active)?.editor.focus();
  }

  applyTooltipAttribute(root, opts.tooltipAttribute ?? "title");
  syncTabsUI();
  render();

  return {
    el: root,
    render,
    toggle(force?: boolean): void {
      const next = force ?? !isShown();
      if (next) show();
      else hide();
    },
    isShown,
    focusEditor(): void {
      views.get(active)?.editor.focus();
    },
    activeTab: () => active,
    setActiveTab: (id: string) => activate(id),
    destroy(): void {
      hideMenu();
      dis.flush();
      root.remove();
    },
  };
}

export { makeDebounce };

/**
 * Re-home every `title` onto the host's tooltip attribute. Run once, after the whole window is
 * built: leaving a native `title` inside a host that renders its own tooltips produces two popups
 * for the same control, one of them slow and unstyled.
 */
function applyTooltipAttribute(root: HTMLElement, attr: string): void {
  if (attr === "title") return;
  for (const node of root.querySelectorAll<HTMLElement>("[title]")) {
    const value = node.getAttribute("title") ?? "";
    node.removeAttribute("title");
    node.setAttribute(attr, value);
    // `title` doubles as the accessible name for an icon-only control; preserve that when the
    // host's attribute carries no such meaning.
    if (!node.getAttribute("aria-label") && !(node.textContent ?? "").trim()) {
      node.setAttribute("aria-label", value);
    }
  }
}
