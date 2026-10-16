/**
 * `@freva-org/dataset-tree/ui` - the page around a tree: maximizing the dataset browser as an
 * explicit overlay transaction. Its stylesheet, `@freva-org/dataset-tree/ui.css`, styles the block
 * a host renders around the tree (heading, summary, the maximize and notebook controls, the sheet).
 *
 * No bigger `z-index` can do this: the block sits inside the landing's stacking contexts, so a
 * fixed sheet orders only against its siblings, while a `body::after` dim is in the root context
 * and paints over it, the header and the footer's badge. Instead, on maximize a placeholder takes
 * the block's place and the block's own node moves into the overlay root, where backdrop and sheet
 * are siblings; on exit it goes back to the placeholder.
 *
 * Moving is not remounting: `append` relocates the node without running anything again, so
 * listeners, expanded branches and the chosen node survive. Only the scroll offset is lost, so it
 * is carried here. Not a `<dialog>`: `showModal()` puts it in the top layer, above the Python
 * terminal, which has to stay reachable over the tree.
 */

/**
 * One surface the host's layer manager placed. The tree has no overlay of its own to stack
 * against, so the host supplies the allocator - `@freva-org/freva-client-terminal/layers`'
 * `mountLayer` in a Freva site, so a maximized tree stays under a Python window and over the page.
 */
export interface Layer {
  release(): void;
}
export type MountLayer = (el: HTMLElement, band: "sheet") => Layer;

/** Without a layer manager: appended to the body, in document order. */
const appendToBody: MountLayer = (el) => {
  el.ownerDocument.body.append(el);
  return { release: () => el.remove() };
};

/** Everything one open sheet is holding, so closing it is one call and not five. */
interface Open {
  placeholder: HTMLElement;
  shell: HTMLElement;
  backdropLayer: Layer;
  sheetLayer: Layer;
  scrollers: { el: HTMLElement; top: number; left: number }[];
  restoreFocus: HTMLElement | null;
}

/**
 * Where the sheet's top edge goes: just below the header, which stays behind the backdrop, dimmed
 * and inert, so there is an outside to click - the way out a visitor reaches for before a button.
 * The header is the portal shell's, or on a page another generator drew (a MkDocs Material site)
 * the top-level `<header>`. Measured, because its height is a clamp on the viewport.
 */
function headerInset(doc: Document): number {
  const header = doc.querySelector<HTMLElement>(
    ".portal-header, header[role='banner'], .portal-shell > header, body > header",
  );
  if (!header) return 0;
  const box = header.getBoundingClientRect();
  // A header scrolled out of view contributes nothing, and a negative inset would pull the sheet
  // up under the viewport edge.
  return Math.max(0, Math.round(box.bottom));
}

/** Every scrollable element inside a subtree, with where it is scrolled to. */
function scrollState(root: HTMLElement): Open["scrollers"] {
  const out: Open["scrollers"] = [];
  const seen = [root, ...root.querySelectorAll<HTMLElement>("*")];
  for (const el of seen) {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
      out.push({ el, top: el.scrollTop, left: el.scrollLeft });
    }
  }
  return out;
}

/**
 * Put every scroller back where it was. A re-attached element keeps `scrollTop = 0` until it is
 * scrollable again, which depends on a `max-height` that changed in the same tick
 * (`--dataset-tree-max-height` is `none` in the sheet, 32rem outside it), so reading
 * `scrollHeight` forces layout first; a second pass on the next frame covers a font or an image
 * that settles later.
 */
function restoreScroll(scrollers: Open["scrollers"]): void {
  const apply = (): void => {
    for (const entry of scrollers) {
      if (!entry.el.isConnected) continue;
      void entry.el.scrollHeight;
      entry.el.scrollTop = entry.top;
      entry.el.scrollLeft = entry.left;
    }
  };
  apply();
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
}

export interface MaximizeHandle {
  isOpen(): boolean;
  open(): void;
  close(): void;
  destroy(): void;
}

/**
 * Give one dataset-tree block a maximized state. `onChange` is how the caller keeps its own control
 * in step: the label, `aria-expanded` and the history entry are the caller's business.
 */
export function createTreeMaximize(
  panel: HTMLElement,
  options: { onChange?: (open: boolean) => void; mountLayer?: MountLayer } = {},
): MaximizeHandle {
  const mountLayer = options.mountLayer ?? appendToBody;
  const doc = panel.ownerDocument;
  let open: Open | null = null;
  let fitting: (() => void) | null = null;

  function close(): void {
    if (!open) return;
    const state = open;
    open = null;
    if (fitting) {
      doc.defaultView?.removeEventListener("resize", fitting);
      fitting = null;
    }
    const scrollers = scrollState(panel);
    delete panel.dataset.expanded;
    // Back to the placeholder, not the parent: `replaceWith` puts the node at the index it left
    // from, so an ordered landing stays ordered.
    state.placeholder.replaceWith(panel);
    restoreScroll(scrollers);
    state.sheetLayer.release();
    state.backdropLayer.release();
    doc.documentElement.removeAttribute("data-tree-expanded");
    state.restoreFocus?.focus();
    options.onChange?.(false);
  }

  function openSheet(): void {
    if (open) return;
    const scrollers = scrollState(panel);
    const focused = doc.activeElement;
    const restoreFocus = focused instanceof HTMLElement ? focused : null;

    const placeholder = doc.createElement("div");
    placeholder.className = "portal-dataset-tree-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    panel.replaceWith(placeholder);

    const backdrop = doc.createElement("div");
    backdrop.className = "portal-sheet-backdrop";
    // The backdrop is the click target for "get me out of here", so it is a real element rather
    // than a pseudo-element, which can be seen and cannot be clicked.
    backdrop.addEventListener("click", () => close());

    const shell = doc.createElement("div");
    shell.className = "portal-sheet";
    shell.append(panel);
    panel.dataset.expanded = "true";

    // Two slots in one band, allocated in order: the backdrop first, the sheet on top of it.
    const backdropLayer = mountLayer(backdrop, "sheet");
    const sheetLayer = mountLayer(shell, "sheet");
    doc.documentElement.dataset.treeExpanded = "true";

    // The top inset, kept correct while the sheet is open: the header's height is a clamp on the
    // viewport, so a rotation or a resize moves it and a sheet measured once drifts into it.
    const fit = (): void => {
      shell.style.setProperty("--portal-sheet-top", `${headerInset(doc)}px`);
    };
    fit();
    fitting = fit;
    // On the panel's own window, and only while the sheet is open.
    doc.defaultView?.addEventListener("resize", fit);

    open = { placeholder, shell, backdropLayer, sheetLayer, scrollers, restoreFocus };
    restoreScroll(scrollers);
    options.onChange?.(true);
  }

  return {
    isOpen: () => open !== null,
    open: openSheet,
    close,
    destroy(): void {
      close();
    },
  };
}

/**
 * What is left of the block's header row once its control has moved into the panel.
 *
 * A heading and a summary, or nothing at all - and when it is nothing, the row goes with it. The
 * bar carries a `min-height` so a control that grows on hover cannot reflow the line, and on an
 * empty div that is 34px of blank page above the panel. `hidden` rather than a class, so the row is
 * out of the accessibility tree as well as off the screen. The attribute is what the stylesheet
 * reads where there IS a heading: the row no longer holds a control, so it reserves no height.
 */
export function settleBlockBar(panel: HTMLElement | null | undefined): void {
  const bar = panel?.querySelector<HTMLElement>(".portal-dataset-tree-bar");
  if (!bar) return;
  bar.dataset.portalTreeBar = "text";
  const head = bar.querySelector<HTMLElement>(".portal-dataset-tree-head");
  if (head && head.children.length === 0) bar.hidden = true;
}

/**
 * The maximize control: the block becomes the screen, and Escape brings it back. The tree is not
 * remounted (`createTreeMaximize` moves the block's own node), so opened branches, the chosen node
 * and the scroll position survive.
 *
 * The label is `Maximize` / `Exit full screen`, never "Collapse", which the tree's own toolbar uses
 * for its branches. Three ways out - the button, Escape and the browser's Back, through a history
 * entry - because a full-screen surface with one way out is a trap.
 */
export function wireMaximizeControls(
  root: ParentNode,
  options: { mountLayer?: MountLayer } = {},
): void {
  const buttons = root.querySelectorAll<HTMLButtonElement>("[data-portal-tree-expand]");
  for (const button of buttons) {
    const panel = button.closest<HTMLElement>("[data-portal-tree-panel]");
    if (!panel || button.dataset.portalTreeWired === "yes") continue;
    // The button's own document and window: the host calls this, so nothing is installed at import.
    const doc = button.ownerDocument;
    const view = doc.defaultView;
    button.dataset.portalTreeWired = "yes";
    const text = button.querySelector<HTMLElement>(".portal-tree-expand-text");

    // In the page the control stands in the toolbar beside `Collapse all`; full screen it is the
    // way out and moves to the corner, as in any full-screen viewer. `slot` remembers a parent and
    // a next sibling rather than an index, since the toolbar's contents are the component's, and
    // `insertBefore(node, null)` appends when the control was last in the row.
    let slot: { parent: Node; before: Node | null } | null = null;
    const header = panel.querySelector<HTMLElement>(".portal-dataset-tree-bar");

    const sheet = createTreeMaximize(panel, {
      ...(options.mountLayer ? { mountLayer: options.mountLayer } : {}),
      onChange: (on) => {
        button.setAttribute("aria-expanded", String(on));
        const label = on ? "Exit full screen" : "Maximize";
        if (text) text.textContent = label;
        // The accessible name follows the visible one; a glyph-only control whose name went stale
        // is worse than one that never had a label.
        button.setAttribute("aria-label", on ? label : "Maximize the dataset browser");

        if (on && header) {
          slot = { parent: button.parentNode!, before: button.nextSibling };
          // The header row is hidden on a block that configured neither a heading nor a summary,
          // where it would be an empty band above the panel. In the sheet it has a job again, so it
          // comes back, and it goes away again on the way out.
          if (header.hidden) {
            header.hidden = false;
            header.dataset.portalTreeBarRevealed = "yes";
          }
          header.append(button);
        } else if (!on && slot) {
          // Moving a focused element blurs it, so focus is put back after the move:
          // `createTreeMaximize` restores focus before reporting the change, but this control has
          // just left the sheet's header, and focus would land on `<body>`.
          const hadFocus = doc.activeElement === button;
          slot.parent.insertBefore(button, slot.before);
          if (hadFocus) button.focus();
          slot = null;
          if (header?.dataset.portalTreeBarRevealed === "yes") {
            header.hidden = true;
            delete header.dataset.portalTreeBarRevealed;
          }
        }
      },
    });

    const collapse = (fromPop: boolean): void => {
      if (!sheet.isOpen()) return;
      sheet.close();
      // Only unwind history when we are not already being unwound by it.
      if (!fromPop && view?.history.state?.portalTreeExpanded) view.history.back();
    };

    button.addEventListener("click", () => {
      if (sheet.isOpen()) {
        collapse(false);
        return;
      }
      sheet.open();
      view?.history.pushState({ portalTreeExpanded: true }, "");
    });

    doc.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") collapse(false);
    });
    // A click outside the sheet lands on the backdrop (see `createTreeMaximize`), so nothing here
    // tests containment.
    view?.addEventListener("popstate", () => collapse(true));
  }
}
