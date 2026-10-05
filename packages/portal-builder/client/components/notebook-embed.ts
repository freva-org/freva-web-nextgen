// The `notebook` landing block's Maximize: the dataset browser's behaviour - the window takes the
// screen between the header and the footer over a dim, Escape, a click outside and the browser's
// Back restore it, focus returns to the control - without moving anything.
//
// WHY NOT THE TREE'S SHEET. `tree-maximize.ts` moves the block into the overlay root, which is
// right for a tree and wrong for a frame: an iframe that is moved loads its page again, and the
// visitor's open notebook, its kernel and the chat beside it would be gone. Here the window is
// pinned in place (`position: fixed` from the stylesheet) and the frame stays where it loaded.

/** The header's bottom edge, measured: its height is a clamp on the viewport. */
function headerInset(doc: Document): number {
  const header = doc.querySelector<HTMLElement>(".portal-header");
  if (!header) return 0;
  return Math.max(0, Math.round(header.getBoundingClientRect().bottom));
}

/**
 * How far the footer, and the badge over it, reach up from the bottom edge: both paint above the
 * window, so the window ends where they begin.
 */
function footerInset(doc: Document, height: number): number {
  let top = height;
  const footer = doc.querySelector<HTMLElement>(".portal-footer");
  if (footer && getComputedStyle(footer).position === "fixed") {
    top = Math.min(top, footer.getBoundingClientRect().top);
  }
  const badge = doc.querySelector<HTMLElement>("#portal-overlay-root .fb");
  for (const el of badge ? [badge, ...badge.querySelectorAll<HTMLElement>("*")] : []) {
    const box = el.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && box.top > height / 2) top = Math.min(top, box.top);
  }
  return Math.max(0, Math.round(height - top));
}

/** The page's theme, as the shell set it. */
function pageTheme(doc: Document): "dark" | "light" {
  return doc.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** The notebook's origin, or null for a frame without a usable address. */
function frameOrigin(frame: HTMLIFrameElement): string | null {
  try {
    return new URL(frame.src, frame.ownerDocument.baseURI).origin;
  } catch {
    return null;
  }
}

/**
 * The notebook follows the page's theme: told when it says it is ready (its theme plugin starts
 * after the frame's load event) and on every change. A new tab opens in the same theme.
 */
function syncTheme(block: HTMLElement): void {
  const doc = block.ownerDocument;
  const win = doc.defaultView;
  const frame = block.querySelector<HTMLIFrameElement>("iframe");
  if (!win || !frame) return;
  const origin = frameOrigin(frame);
  const tell = () => {
    if (!origin) return;
    frame.contentWindow?.postMessage({ type: "freva-portal-theme", mode: pageTheme(doc) }, origin);
  };
  const link = block.querySelector<HTMLAnchorElement>("[data-portal-notebook-open]");
  const retarget = () => {
    if (!link) return;
    try {
      const url = new URL(link.href);
      url.searchParams.set("theme", pageTheme(doc));
      link.href = url.href;
    } catch {
      // A link changed by hand stays as it is.
    }
  };
  win.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown } | null;
    if (event.source === frame.contentWindow && event.origin === origin) {
      if (data?.type === "freva-lab-ready") tell();
    }
  });
  frame.addEventListener("load", tell);
  win.addEventListener("portal:theme", () => {
    tell();
    retarget();
  });
  retarget();
}

export interface NotebookEmbedHandle {
  isOpen(): boolean;
  open(): void;
  close(): void;
}

/** Wire one block. Returns null for a block without its parts (a page changed by hand). */
export function wireNotebookEmbed(block: HTMLElement): NotebookEmbedHandle | null {
  const doc = block.ownerDocument;
  const win = doc.defaultView;
  const button = block.querySelector<HTMLButtonElement>("[data-portal-notebook-expand]");
  const text = block.querySelector<HTMLElement>("[data-portal-notebook-expand-text]");
  const backdrop = block.querySelector<HTMLElement>("[data-portal-notebook-backdrop]");
  const frameWindow = block.querySelector<HTMLElement>("[data-portal-notebook-window]");
  if (!win || !button || !backdrop || !frameWindow) return null;

  let open = false;
  let restoreFocus: HTMLElement | null = null;
  /** The history length after our entry: a Back is ours to take only while it is still the last. */
  let pushedAt = -1;

  const fit = (): void => {
    frameWindow.style.setProperty("--portal-notebook-top", `${headerInset(doc)}px`);
    frameWindow.style.setProperty(
      "--portal-notebook-bottom",
      `${footerInset(doc, win.innerHeight)}px`,
    );
  };

  const set = (on: boolean): void => {
    open = on;
    backdrop.hidden = !on;
    if (on) {
      block.dataset.expanded = "true";
      doc.documentElement.dataset.notebookExpanded = "true";
      fit();
      win.addEventListener("resize", fit);
    } else {
      delete block.dataset.expanded;
      doc.documentElement.removeAttribute("data-notebook-expanded");
      win.removeEventListener("resize", fit);
    }
    const label = on ? "Exit full screen" : "Maximize";
    if (text) text.textContent = label;
    button.setAttribute("aria-expanded", String(on));
    button.setAttribute("aria-label", on ? label : "Maximize the notebook");
  };

  const openSheet = (): void => {
    if (open) return;
    const focused = doc.activeElement;
    restoreFocus = focused instanceof HTMLElement && focused !== doc.body ? focused : button;
    set(true);
    win.history.pushState({ portalNotebookExpanded: true }, "");
    pushedAt = win.history.length;
  };

  const close = (fromPop: boolean): void => {
    if (!open) return;
    set(false);
    if (!fromPop && win.history.state?.portalNotebookExpanded) {
      // The frame may have added entries of its own since (the joint session history); going
      // Back then would move the notebook, not close the window. Leave the entry, inert.
      if (win.history.length === pushedAt) win.history.back();
      else win.history.replaceState(null, "");
    }
    pushedAt = -1;
    restoreFocus?.focus({ preventScroll: true });
    restoreFocus = null;
  };

  syncTheme(block);
  button.hidden = false;
  button.addEventListener("click", () => (open ? close(false) : openSheet()));
  backdrop.addEventListener("click", () => close(false));
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close(false);
  });
  win.addEventListener("popstate", () => close(true));

  return { isOpen: () => open, open: openSheet, close: () => close(false) };
}

/** Every notebook block on the page. */
export function mountNotebookEmbeds(doc: Document = document): NotebookEmbedHandle[] {
  return [...doc.querySelectorAll<HTMLElement>("[data-portal-notebook]")]
    .map((block) => wireNotebookEmbed(block))
    .filter((handle): handle is NotebookEmbedHandle => handle !== null);
}
