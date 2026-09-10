// terminal.ts - the freva-client TAB LAYER, drawn inside the shared terminal window. The window
// itself - frame, traffic lights, drag/resize/minimize/maximize, the ⋮ settings menu, the
// appearance model and the copy control - lives in `window.ts`, shared with other hosts. This file
// adds the tab strip, the editor, the completion menu, the highlighting surface and the
// keyboard-escape contract.
//
// It owns NO application state: what a token means, which values complete, what a commit does and
// what "copy" copies all arrive through the host's TerminalTab models, so another freva-client
// command can register a tab without importing a data browser.

import { Disposables, el, makeDebounce, replaceChildren, svgIcon } from "./dom.js";
import { Editor, segmentNode } from "./editor.js";
import { createTerminalWindow, TERM_THEMES } from "./window.js";
import type {
  TerminalCompletion,
  TerminalCompletionItem,
  TerminalHandle,
  TerminalOptions,
  TerminalSegment,
  TerminalTab,
} from "./types.js";

export { TERM_THEMES };

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

  // The window is built FIRST and empty, then filled, so every hook below tolerates an empty
  // `views`: `show()` fires `onShow` while the window is still empty during construction.
  const win = createTerminalWindow(mount, {
    os: opts.os,
    storage: opts.storage,
    tooltipAttribute: opts.tooltipAttribute,
    bounds: opts.bounds,
    foot: true,
    // Tab chips and the reopen button live in the bar and must not drag the window.
    dragExclude: ".cmd-tab, .term-add",
    copyText: () => views.get(active)?.tab.copyText() ?? "",
    menuItems: opts.menuItems,
    onClose: opts.onClose,
    onCopyFailed: opts.onCopyFailed,
    onShow: () => {
      render();
      if (!fallbackOn()) views.get(active)?.editor.focus();
    },
    onHide: () => hideMenu(),
    onMinimize: (minimized) => {
      if (minimized) hideMenu();
    },
    onResize: () => {
      syncFallback();
      for (const v of views.values()) v.editor.fit();
    },
    onBodyActivate: () => {
      if (!fallbackOn()) views.get(active)?.editor.focus();
    },
  });

  const doc = mount.ownerDocument;
  const root = win.el;
  const bar = win.bar;
  const body = win.body;
  const foot = win.foot as HTMLElement;

  const addBtn = el("button", {
    class: "term-add",
    type: "button",
    title: "Reopen closed tab",
    "aria-label": "Reopen closed tab",
    text: "+",
  });
  const hint = el("span", { class: "te-hint" }, hintNodes(false));
  foot.append(hint);

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

  // completion menu - rendered INSIDE the window, never a popover that would stack behind it
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
   * Size and place the open menu. The window docks bottom-right, so a list below the caret often
   * overflows the body: cap it to the space that exists, flip it above the prompt when short.
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
    // `te-menu` is the GENERIC editor-menu class (like te-input / te-hl); `${prefix}-menu` is the
    // per-tab alias the freva stylesheet and the integration tests address.
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
        // Read LIVE, not snapshotted: a host whose placeholder is an example from its own data
        // (the data browser suggests a real facet=value pair) has nothing to offer at mount, so a
        // snapshot would freeze the empty-state string for the life of the tab.
        get placeholder(): string {
          return tab.placeholder ?? "";
        },
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
          // Compute the ghost from the buffer AFTER the commit, then paint: either order reversed
          // suggests against, or draws, the previous keystroke.
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
    // `${prefix}-ml` is the per-tab hook (`.py-ml`) the freva stylesheet and the integration tests
    // address for the multi-line prompt row.
    const editRow = gutter
      ? el("div", { class: `term-editrow ${prefix}-ml` }, [gutter, state.editor.root])
      : state.editor.root;
    state.view.append(head, el("div", { class: "term-edit" }, [editRow]), menu, warn, footLines);
    return state;
  }

  for (const tab of opts.tabs) {
    const v = buildTab(tab);
    views.set(tab.id, v);
    bar.insertBefore(v.chip, win.barSpacer);
    body.append(v.view);
  }
  bar.insertBefore(addBtn, win.barSpacer);

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
    // message.
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
      win.hide();
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
      // The HOST changed state from outside the terminal (a chip, Clear all, the map); that wins
      // even while the editor is focused, or a half-typed draft re-commits filters just cleared.
      // MERGE, not overwrite: the committed part is rebuilt from state, uncommitted tokens kept.
      v.revision = rev;
      const focused = v.editor.isFocused();
      // Retaining is only for text the user still OWNS. `retain()` answers "which tokens are not
      // committed", and a filter the host removes stops being committed too - so retaining from a
      // clean, unfocused buffer would put the removed filter (`model_not_=model-000`) back on the
      // wire on the next keystroke. Only two things need protecting: a token the user is still
      // typing (FOCUSED), and a draft the terminal refused and annotated (`dirty` - an unknown
      // token stays visible with its warning until the user fixes it). Otherwise the host wins.
      const keep = focused || v.dirty ? (v.tab.retain?.(v.editor.value) ?? "") : "";
      const joiner = v.tab.multiline ? "\n" : " ";
      v.editor.value = [v.tab.text(), keep].filter(Boolean).join(joiner);
      if (focused) v.editor.setCaret(v.editor.value.length); // carry on typing where the text ends
      // The merged buffer is only CLEAN when nothing had to be retained: clearing `dirty` here
      // would let the next render (the search this action triggers, settling a moment later)
      // rebuild from state and throw the retained draft away.
      v.dirty = keep !== "";
    } else if (!v.editor.isFocused() && !v.dirty) {
      // Only rebuild a CLEAN, unfocused buffer: a dirty draft survives with its warning.
      v.editor.value = v.tab.text();
    }
    repaint(v);
  }
  function render(): void {
    syncFallback();
    for (const v of views.values()) renderTab(v);
    win.fitBar();
  }

  // Chips and the reopen button were appended after the window, so their `title` needs re-homing.
  win.applyTooltips();
  syncTabsUI();
  render();

  return {
    el: root,
    render,
    toggle(force?: boolean): void {
      win.toggle(force);
    },
    isShown: () => win.isShown(),
    focusEditor(): void {
      views.get(active)?.editor.focus();
    },
    activeTab: () => active,
    setActiveTab: (id: string) => activate(id),
    destroy(): void {
      hideMenu();
      dis.flush();
      win.destroy();
    },
  };
}

export { makeDebounce };
