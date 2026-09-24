/**
 * Shell progressive enhancement.
 *
 * Everything here already works without it: the navigation is a list of links, the announcements
 * are rendered, the footer index is in the document, and the skip link is a plain anchor. What
 * this adds is the behaviour the design has and static HTML cannot express - the theme toggle, the
 * menus, measured navigation overflow, the header's scrolled state, and the footer that opens into
 * the site index at the bottom of a page. The measuring and the split live in `nav-overflow.ts`.
 */

import { isCompact, NavOverflowController, type MeasuredItem } from "./nav-overflow.js";

const DISMISSED_KEY = "portal:dismissed-announcements";
const THEME_KEY = "freva.portal.theme";

type ThemeMode = "light" | "dark";

function dismissed(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function remember(ids: Set<string>): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // A browser that refuses storage simply shows the announcement again.
  }
}

function currentTheme(): ThemeMode {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/**
 * Apply a theme mode. `data-theme` drives the stylesheet, `colorScheme` drives the browser's own
 * form controls and scrollbars, and the embedded applications watch the same attribute - so one
 * write moves the whole page, chrome and widgets together.
 */
function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute("data-theme", mode);
  document.documentElement.style.colorScheme = mode;
  try {
    window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    // A visitor who blocks storage still gets the theme for this page view.
  }
  const button = document.querySelector<HTMLButtonElement>(".portal-theme-toggle");
  if (button) {
    // The control is a switch, not a glyph that gets rewritten: which icon shows and where the
    // knob sits are decided by `:root[data-theme]` in the stylesheet, so the control is already
    // correct on the first paint rather than flickering into place.
    button.dataset.mode = mode;
    button.setAttribute("aria-checked", mode === "dark" ? "true" : "false");
    button.setAttribute(
      "aria-label",
      mode === "dark" ? "Switch to light theme" : "Switch to dark theme",
    );
  }
  window.dispatchEvent(new CustomEvent("portal:theme", { detail: { mode } }));
}

/** One dropdown pattern: opening any menu closes the others. */
function initMenus(): void {
  const menus = [...document.querySelectorAll<HTMLElement>(".portal-menu")].filter((menu) =>
    menu.querySelector("button"),
  );
  const close = (menu: HTMLElement): void => {
    const button = menu.querySelector<HTMLButtonElement>("button");
    const panel = menu.querySelector<HTMLElement>(".portal-panel");
    if (!button || !panel) return;
    button.setAttribute("aria-expanded", "false");
    panel.hidden = true;
  };
  const closeAll = (except?: HTMLElement): void => {
    for (const menu of menus) if (menu !== except) close(menu);
  };

  for (const menu of menus) {
    const button = menu.querySelector<HTMLButtonElement>("button");
    const panel = menu.querySelector<HTMLElement>(".portal-panel");
    if (!button || !panel) continue;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = button.getAttribute("aria-expanded") === "true";
      closeAll(menu);
      button.setAttribute("aria-expanded", open ? "false" : "true");
      panel.hidden = open;
    });
  }

  // Capture, so an inner handler that stops propagation cannot leave a menu open.
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Node | null;
      if (target && menus.some((menu) => menu.contains(target))) return;
      closeAll();
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const menu of menus) {
      const button = menu.querySelector<HTMLButtonElement>("button");
      if (button?.getAttribute("aria-expanded") !== "true") continue;
      close(menu);
      button.focus();
    }
  });
}

/**
 * Measured navigation overflow. Natural widths are read once, while every tab is visible: a hidden
 * element measures zero, and feeding zeros back into the split would make the bar collapse a
 * little further on every recompute.
 */
function initNavigation(): void {
  const nav = document.querySelector<HTMLElement>(".portal-nav");
  const list = nav?.querySelector<HTMLElement>(".portal-nav-list");
  const more = nav?.querySelector<HTMLElement>(".portal-more");
  const moreButton = more?.querySelector<HTMLButtonElement>("button");
  const morePanel = more?.querySelector<HTMLElement>(".portal-panel");
  const compact = nav?.querySelector<HTMLElement>(".portal-compact");
  const compactButton = compact?.querySelector<HTMLButtonElement>("button");
  if (!nav || !list || !more || !moreButton || !morePanel || !compact || !compactButton) return;

  const items = [...list.querySelectorAll<HTMLElement>(".portal-nav-li")];
  if (items.length === 0) return;

  const widths = new Map<string, number>();
  items.forEach((navItem, index) => {
    navItem.dataset.navIndex = String(index);
    widths.set(String(index), Math.ceil(navItem.getBoundingClientRect().width));
  });
  // Measured live rather than once: the button's label carries the overflow count, so its own
  // width changes as the split changes. Measuring it while hidden reports zero, which is how a nav
  // that overflows by one entry ends up overlapping the header controls.
  const measureMore = (): number => {
    const wasHidden = moreButton.hidden;
    if (wasHidden) moreButton.hidden = false;
    const width = Math.ceil(moreButton.getBoundingClientRect().width) || 92;
    if (wasHidden) moreButton.hidden = true;
    return width;
  };
  const gap = Number.parseFloat(getComputedStyle(list).columnGap || "0") || 8;

  const measure = (): MeasuredItem[] =>
    items.map((_navItem, index) => ({ id: String(index), width: widths.get(String(index)) ?? 0 }));

  const applyCompact = (): boolean => {
    const narrow = isCompact(window);
    compactButton.hidden = !narrow;
    list.hidden = narrow;
    more.hidden = narrow;
    if (narrow) {
      moreButton.setAttribute("aria-expanded", "false");
      morePanel.hidden = true;
    }
    return narrow;
  };

  const controller = new NavOverflowController({
    container: nav,
    measure,
    moreWidth: measureMore,
    gap,
    window,
    apply: (split) => {
      if (applyCompact()) return;
      const overflow = new Set(split.overflow);
      for (const item of items) {
        item.hidden = overflow.has(item.dataset.navIndex ?? "");
      }
      moreButton.hidden = overflow.size === 0;
      // "More" alone does not say how much is hidden, and a visitor deciding whether to open it
      // needs that number.
      moreButton.textContent = `More (${overflow.size})`;
      moreButton.setAttribute("aria-label", `More navigation entries (${overflow.size} hidden)`);
      if (overflow.size === 0) {
        moreButton.setAttribute("aria-expanded", "false");
        morePanel.hidden = true;
      }
      morePanel.replaceChildren();
      for (const item of items) {
        if (!overflow.has(item.dataset.navIndex ?? "")) continue;
        const source = item.querySelector<HTMLAnchorElement>("a");
        if (!source) continue;
        const clone = source.cloneNode(true) as HTMLAnchorElement;
        clone.className = "portal-panel-item";
        clone.setAttribute("role", "menuitem");
        morePanel.appendChild(clone);
      }
    },
  });
  controller.start();
  window.addEventListener("resize", () => controller.schedule(), { passive: true });
}

/**
 * The phone navigation panel: a full-screen drill-down, opened by the compact button.
 *
 * Two levels, both already in the markup - the sections, and one page list per section - shown by
 * `data-level` rather than rebuilt on each transition, so going back is instant and each level
 * keeps its scroll position. It takes over scrolling (the page behind must not move under the
 * panel) and Escape, but NOT history: this is a menu, not a route, and a browser Back that closes
 * a menu instead of leaving the page is the behaviour every phone user has been burned by.
 */
function initNavPanel(): void {
  const panel = document.querySelector<HTMLElement>(".portal-navpanel");
  const trigger = document.querySelector<HTMLButtonElement>(".portal-compact-button");
  if (!panel || !trigger) return;

  const back = panel.querySelector<HTMLButtonElement>("[data-portal-navpanel-back]");
  const closeButton = panel.querySelector<HTMLButtonElement>("[data-portal-navpanel-close]");
  const title = panel.querySelector<HTMLElement>("[data-portal-navpanel-title]");
  const root = panel.querySelector<HTMLElement>("[data-portal-navpanel-root]");
  const levels = [...panel.querySelectorAll<HTMLElement>("[data-portal-navpanel-section]")];
  if (!back || !closeButton || !title || !root) return;

  const rootTitle = title.textContent ?? "";
  let lastFocus: HTMLElement | null = null;

  const showRoot = (): void => {
    panel.dataset.level = "root";
    root.hidden = false;
    for (const level of levels) level.hidden = true;
    back.hidden = true;
    title.textContent = rootTitle;
  };

  const showSection = (index: string): void => {
    const level = levels.find((node) => node.dataset.portalNavpanelSection === index);
    if (!level) return;
    panel.dataset.level = "section";
    root.hidden = true;
    for (const node of levels) node.hidden = node !== level;
    back.hidden = false;
    const label = panel
      .querySelector<HTMLElement>(`[data-portal-navpanel-drill="${index}"]`)
      ?.closest(".portal-navpanel-row")
      ?.querySelector<HTMLElement>(".portal-navpanel-link");
    title.textContent = label?.textContent?.trim() ?? rootTitle;
    level.scrollTop = 0;
  };

  const open = (): void => {
    lastFocus = document.activeElement as HTMLElement | null;
    panel.hidden = false;
    // The element has to be laid out before the transition can run from its start state, or it
    // arrives already open and the slide never happens.
    requestAnimationFrame(() => panel.setAttribute("data-open", "true"));
    trigger.setAttribute("aria-expanded", "true");
    document.documentElement.dataset.navpanelOpen = "true";
    showRoot();
    closeButton.focus();
  };

  const close = (): void => {
    panel.removeAttribute("data-open");
    trigger.setAttribute("aria-expanded", "false");
    delete document.documentElement.dataset.navpanelOpen;
    // Hidden only once the slide has finished, so the panel does not vanish mid-transition. The
    // timeout backs up `transitionend`, which never fires when `prefers-reduced-motion` has
    // disabled the transition.
    const finish = (): void => {
      if (panel.getAttribute("data-open") === null) panel.hidden = true;
    };
    panel.addEventListener("transitionend", finish, { once: true });
    window.setTimeout(finish, 320);
    lastFocus?.focus();
  };

  trigger.addEventListener("click", () => {
    if (panel.hidden) open();
    else close();
  });
  closeButton.addEventListener("click", close);
  back.addEventListener("click", showRoot);
  for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-portal-navpanel-drill]")) {
    button.addEventListener("click", () => showSection(button.dataset.portalNavpanelDrill ?? ""));
  }
  // Escape is bound to the DOCUMENT, not to the panel: the panel is a `div` and takes no focus of
  // its own, so a key pressed while focus sits on a link inside it never reaches a listener bound
  // to the panel. It steps back a level first and closes at the top, the same shape as Back.
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape" || panel.hidden) return;
    event.stopPropagation();
    if (panel.dataset.level === "section") showRoot();
    else close();
  });
  // A tap on any destination closes it: the panel covers the page, so leaving it open over the
  // page you just navigated to would hide the thing you asked for.
  panel.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest("a");
    if (link) close();
  });
  // A viewport that grows past the phone breakpoint takes the trigger away with it, so closing
  // here stops a panel being left open, and unreachable, over a header with no dismiss button.
  window.addEventListener(
    "resize",
    () => {
      if (!panel.hidden && trigger.hidden) close();
    },
    { passive: true },
  );
}

/** The header shrinks once the page has scrolled past its own height. */
function initHeaderScroll(): void {
  const header = document.querySelector<HTMLElement>(".portal-header");
  if (!header) return;
  const update = (): void => {
    header.dataset.scrolled = window.scrollY > 24 ? "true" : "false";
  };
  window.addEventListener("scroll", update, { passive: true });
  update();
}

/**
 * The site index unrolls as the visitor scrolls into the band reserved for it. The page reserves
 * the index's own height below its content, so the last stretch of the scroll is exactly the
 * distance over which the index opens: it rises out of the bar at the same rate the page moves,
 * and by the bottom it is fully open with nothing hidden behind it. A boolean that flipped at the
 * bottom would make it appear all at once, over the last lines of content. An application view is
 * viewport-locked and has no bottom, so it never opens.
 */
function initFooter(): void {
  const footer = document.querySelector<HTMLElement>(".portal-footer");
  const shell = document.querySelector<HTMLElement>(".portal-shell");
  if (!footer || !shell) return;
  const expanded = footer.querySelector<HTMLElement>(".portal-footer-expanded");
  if (!expanded) return;

  const mode = shell.dataset.view === "application" ? "application" : "landing";
  footer.dataset.mode = mode;

  const hasIndex = footer.dataset.hasIndex === "true";
  if (mode !== "landing" || !hasIndex) {
    expanded.hidden = true;
    footer.dataset.expanded = "false";
    return;
  }

  /**
   * The index's natural height, measured once and published as a length. The stylesheet needs a
   * number to take a fraction of and cannot read one from the content, so the panel is laid out
   * unclipped for a single frame, off-screen, and measured. `--footer-index-h` is then both the
   * height it opens to and the reserve the document keeps below its last line.
   */
  const measure = (): number => {
    expanded.hidden = false;
    expanded.dataset.measuring = "";
    const height = Math.ceil(expanded.getBoundingClientRect().height);
    delete expanded.dataset.measuring;
    return height;
  };

  let indexHeight = 0;
  let ticking = false;

  const publish = (): void => {
    document.documentElement.style.setProperty("--footer-index-h", `${indexHeight}px`);
  };

  /**
   * Scrolling is the only way in. Opening on a click as well would make the credit line a control,
   * so that every click in the footer - on the mark, on the institution name, on nothing at all -
   * unrolls a panel the visitor did not ask for. The reserved band at the end of the page is the
   * affordance, and it cannot fire by accident.
   */
  const apply = (): void => {
    ticking = false;
    if (indexHeight <= 0) return;
    const doc = document.documentElement;
    const remaining = doc.scrollHeight - window.innerHeight - window.scrollY;
    // 0 at the top of the reserved band, 1 once the visitor has scrolled through all of it.
    // Clamped, because rubber-band scrolling overshoots.
    const open = Math.max(0, Math.min(1, 1 - remaining / indexHeight));
    footer.style.setProperty("--footer-open", open.toFixed(4));
    footer.dataset.expanded = open > 0.02 ? "true" : "false";
  };

  const schedule = (): void => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(apply);
  };

  const remeasure = (): void => {
    indexHeight = measure();
    publish();
    apply();
  };

  remeasure();
  // The panel's height depends on how its columns wrap, so it is measured again whenever the
  // viewport changes shape.
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => remeasure());
    observer.observe(document.documentElement);
  } else {
    window.addEventListener("resize", remeasure, { passive: true });
  }
  window.addEventListener("scroll", schedule, { passive: true });

  // The bar is a credit line, not a control: no tabindex, no role, no aria-controls, nothing for
  // a screen reader to announce as pressable.
  expanded.id = "portal-site-index";
}

function initAnnouncements(): void {
  const already = dismissed();
  for (const item of document.querySelectorAll<HTMLElement>("[data-portal-announcement]")) {
    const id = item.dataset.portalAnnouncement;
    if (!id) continue;
    if (already.has(id)) {
      item.hidden = true;
      continue;
    }
    const button = item.querySelector<HTMLButtonElement>("[data-portal-dismiss]");
    if (!button) continue;
    button.hidden = false;
    button.addEventListener("click", () => {
      item.hidden = true;
      already.add(id);
      remember(already);
    });
  }
}

/**
 * "You are here" in the contents list.
 *
 * The list itself is written at build time, so this adds only what a static list cannot express:
 * which section is being read. The rule is positional rather than ratio-based - the current
 * section is the last heading above the reading line - because a heading with two lines under it
 * never wins a large enough intersection ratio and short sections get skipped entirely.
 */
function initToc(): void {
  const links = [...document.querySelectorAll<HTMLAnchorElement>(".portal-toc-link")];
  if (links.length === 0) return;
  const targets = links
    .map((link) => {
      const id = decodeURIComponent(link.hash.replace(/^#/, ""));
      const heading = id ? document.getElementById(id) : null;
      return heading ? { id, link, heading } : null;
    })
    .filter(
      (entry): entry is { id: string; link: HTMLAnchorElement; heading: HTMLElement } =>
        entry !== null,
    );
  if (targets.length === 0) return;

  let active: string | null = null;
  const mark = (id: string | null): void => {
    if (id === active) return;
    for (const entry of targets) {
      if (entry.id === active) entry.link.removeAttribute("aria-current");
      if (entry.id === id) entry.link.setAttribute("aria-current", "true");
    }
    active = id;
  };

  /**
   * Where a followed anchor comes to rest. `scroll-padding-top` is what the browser subtracts when
   * it jumps to a fragment, so it is where a heading sits once its entry has been clicked, and
   * therefore the only correct reading line. Measuring the header instead is eight pixels of
   * guesswork that leaves the list one section behind every click.
   */
  const readingLine = (): number => {
    const padding = Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop);
    const header = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--header-h"),
    );
    const base = Number.isFinite(padding) ? padding : Number.isFinite(header) ? header : 76;
    return base + 8;
  };

  const update = (): void => {
    const line = readingLine();
    let current: string | null = targets[0]!.id;
    for (const entry of targets) {
      if (entry.heading.getBoundingClientRect().top <= line) current = entry.id;
      else break;
    }
    // The last section is a special case: a document whose final heading is close to its end can
    // never scroll that heading up to the reading line, so without this the last entry never
    // lights up and clicking it appears to do nothing.
    const bottom = window.scrollY + window.innerHeight;
    const reserve = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--footer-index-h"),
    );
    const end = document.documentElement.scrollHeight - (Number.isFinite(reserve) ? reserve : 0);
    if (bottom >= end - 4) current = targets[targets.length - 1]!.id;
    mark(current);
  };

  for (const entry of targets) {
    entry.link.addEventListener("click", () => mark(entry.id));
  }
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update, { passive: true });
  update();
}

/**
 * The search button says the click landed. The landing search is a plain GET form that navigates
 * away, so between the click and the next document there is a gap only the browser can fill - on
 * a cold route, long enough to read as nothing having happened. Marking the form busy is all this
 * does; the stylesheet draws a spinner. Cleared on `pageshow` as well as on load, because the
 * back/forward cache can restore this page exactly as it was left - still spinning.
 */
function initSearchBusy(): void {
  const forms = document.querySelectorAll<HTMLFormElement>(".portal-search-form");
  if (forms.length === 0) return;
  const clear = (): void => {
    for (const form of forms) delete form.dataset.portalSearching;
  };
  for (const form of forms) {
    form.addEventListener("submit", () => {
      // The default is not prevented: the navigation is the search.
      form.dataset.portalSearching = "true";
    });
  }
  window.addEventListener("pageshow", clear);
  clear();
}

export function initShell(): void {
  applyTheme(currentTheme());
  const toggle = document.querySelector<HTMLButtonElement>(".portal-theme-toggle");
  toggle?.addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  });

  initMenus();
  initNavigation();
  initNavPanel();
  initHeaderScroll();
  initFooter();
  initToc();
  initAnnouncements();
  initSearchBusy();
}
