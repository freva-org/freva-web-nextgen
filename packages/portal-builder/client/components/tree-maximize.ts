/**
 * Maximizing the dataset browser: an explicit overlay transaction.
 *
 * WHY NOT A BIGGER `z-index`. The block sits inside the landing's own stacking contexts, so a
 * `position: fixed; z-index: 75` on it orders it against its siblings and nothing else, while a
 * dim drawn by `body::after` at 74 is allocated in the ROOT context - and paints over the sheet it
 * is meant to sit behind, along with the header and the footer's Freva badge. No number fixes
 * that: a sheet cannot outrank a context it is inside.
 *
 * WHAT THIS DOES INSTEAD. It changes who owns the overlay. On maximize a placeholder takes the
 * block's place in the document and the block's OWN NODE is moved into the portal's overlay root,
 * where the backdrop and the sheet are siblings and their order is a fact. On exit the same node
 * goes back to the placeholder.
 *
 * MOVING IS NOT REMOUNTING. `append` relocates a node without cloning it or running anything
 * again, so every listener the tree attached is still attached, every expanded branch is still
 * expanded and the chosen node is still chosen. The one part of the state moving does NOT carry is
 * the scroll offset - a detached element's `scrollTop` is not preserved - so it is carried here.
 *
 * WHY NOT `<dialog>`. `showModal()` puts the dialog in the browser's TOP LAYER, above every
 * `z-index` there is, so it would paint over the Python terminal - and the terminal has to stay
 * reachable above the tree.
 */

import { mountLayer, type Layer } from "../layers.js";

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
 * Where the sheet's top edge goes: CLEANLY BELOW THE HEADER, which stays where it is behind the
 * backdrop, dimmed and inert. Covering the header completely would leave a sheet with no outside
 * to click, and clicking outside is the way out a visitor reaches for before a button.
 *
 * Measured rather than assumed: the header's height is a clamp on the viewport, so a hard-coded
 * offset overlaps the header on one screen and floats away from it on another.
 */
function headerInset(doc: Document): number {
  const header = doc.querySelector<HTMLElement>(
    ".portal-header, header[role='banner'], .portal-shell > header",
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
 * Put every scroller back where it was.
 *
 * THE REFLOW IS NOT DECORATION. A re-attached element has `scrollTop = 0` and stays there until it
 * is scrollABLE again, which depends on a `max-height` that changed in the same tick -
 * `--dataset-tree-max-height` is `none` inside the sheet and 32rem outside it. Assigning before
 * the browser has laid the element out again assigns to an element with nothing to scroll and the
 * offset is silently lost. Reading `scrollHeight` forces that layout; the second pass on the next
 * frame covers a font or an image that settles later.
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
  options: { onChange?: (open: boolean) => void } = {},
): MaximizeHandle {
  const doc = panel.ownerDocument;
  let open: Open | null = null;
  let fitting: (() => void) | null = null;

  function close(): void {
    if (!open) return;
    const state = open;
    open = null;
    if (fitting) {
      window.removeEventListener("resize", fitting);
      fitting = null;
    }
    const scrollers = scrollState(panel);
    delete panel.dataset.expanded;
    // BACK TO THE PLACEHOLDER, not to the parent. `replaceWith` puts the node at the exact index
    // it left from, so a landing whose blocks are ordered is still ordered; appending to the
    // parent would silently move the tree to the end of the section.
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
    window.addEventListener("resize", fit);

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
