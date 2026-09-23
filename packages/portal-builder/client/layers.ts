/**
 * The portal's layer manager: who is on top, and why.
 *
 * The portal has an overlay root - a fixed, full-viewport, pointer-transparent div at
 * `z-index: 70`, above the header and below the skip link. Appending into it works for one
 * floating surface and stops working the moment there are two, because "on top" then depends on
 * insertion order, which depends on which island mounted first. So: a small allocator. A surface
 * asks for a band, gets a `z-index` inside it, and can raise itself to the front of its own band.
 *
 * WHAT IT CANNOT DO. This governs the ORDER OF PORTAL-OWNED CONTENT and nothing else. A browser's
 * own surfaces - a file picker, a permission prompt, the fullscreen UI, a `<dialog>` opened with
 * `showModal()`, anything else the platform puts in the top layer - are drawn above every
 * `z-index` there is, and no arrangement of numbers here changes that.
 */

/** The overlay root the shell renders. Absent on a page the shell did not render. */
const ROOT_ID = "portal-overlay-root";

/**
 * The second root, for the `always-on-top` band only.
 *
 * The shell's overlay root is `position: fixed` with `z-index: 70`, which makes it a STACKING
 * CONTEXT: every z-index handed out inside it orders its children against each other and nothing
 * else, while against the rest of the page the whole root is 70. A window in a band numbered above
 * a portal dialog is still painted underneath one that lives outside the root, which is where
 * portal dialogs live. Raising the shell's root instead would carry the ordinary floating band up
 * with it, so a window a visitor dragged aside would cover the dialog asking them a question.
 *
 * Hence a sibling root holding only the always-on-top band, at that band's own z-index, as a
 * direct child of `<body>` where its number means what it says. It carries the shell's overlay
 * class, so it inherits the same geometry, `pointer-events` discipline and `:empty` rule; the
 * inline styles repeat that geometry for a page whose shell CSS is older.
 */
const TOP_ROOT_ID = "portal-overlay-root-top";

/**
 * The bands, and the gap between them. `sheet` is a surface that has taken over the page - see
 * below. `floating` is a surface the visitor can move and dismiss, a terminal window or a picker,
 * and sits above it because a window the visitor put somewhere is a tool a sheet must not bury.
 * `dialog` is modal portal content and sits above both, because a window must not cover the
 * dialog asking a question. `toast` is transient.
 *
 * Each band is 1000 apart, which is how many surfaces one band can hold before colliding with the
 * next: more than a page will ever have, while still far below the values a host stylesheet uses.
 */
export type LayerBand = "sheet" | "floating" | "dialog" | "toast" | "always-on-top";

const BANDS: Record<LayerBand, number> = {
  // A surface that has taken over the page: the maximized dataset browser, and anything like it.
  // The LOWEST band, deliberately, and lower than `floating`: a sheet is CONTENT the visitor asked
  // to see larger, a floating window is a TOOL they put somewhere, and maximizing the tree must
  // not bury the terminal they were typing into. `browser-tests/dataset-tree-overlay.mjs` checks
  // that against the painted pixels. A sheet takes two consecutive slots, its backdrop then
  // itself: siblings in the overlay root, so the backdrop is under the sheet and over everything
  // else on the page, and neither is inside the page's own stacking contexts.
  sheet: 500,
  floating: 1000,
  dialog: 2000,
  toast: 3000,
  // Above every portal-owned surface that stacks - and NOT above the ones that do not.
  // `terminal.alwaysOnTop` asks for a window that stays over the portal's own dialogs and toasts,
  // which is exactly what this delivers. It cannot deliver priority over the browser's TOP LAYER:
  // a `<dialog>` opened with `showModal()`, an element with `popover`, fullscreen content, a file
  // picker, a permission prompt are painted above every `z-index` there is, including this one.
  //
  // Not hypothetical: the Data Browser's File Inspector and its comparison modal are real
  // `<dialog>` elements opened with `showModal()`, so a portal with a Data Browser has two
  // surfaces this band will not cover. Raising the number changes nothing, which is why it is
  // 4000 and not 2147483647.
  "always-on-top": 4000,
};

/** The next free slot in each band. */
const next: Record<LayerBand, number> = {
  sheet: 0,
  floating: 0,
  dialog: 0,
  toast: 0,
  "always-on-top": 0,
};

export interface Layer {
  /** The element the caller mounted. */
  readonly el: HTMLElement;
  /** Bring this surface to the front of its own band - never in front of a higher one. */
  raise(): void;
  /** Remove the element and forget the slot. Safe to call twice. */
  release(): void;
}

/**
 * The overlay root, or `null`. Never created here: the root is part of the shell's layout -
 * `position: fixed`, `pointer-events: none`, an `:empty` rule - and a manager that invented one
 * would give a layer that is styled on a page the shell rendered and unstyled on one it did not.
 */
export function overlayRoot(): HTMLElement | null {
  return document.getElementById(ROOT_ID);
}

/**
 * The always-on-top root, created on first use - unlike `overlayRoot`, because no version of the
 * shell renders it. Appended last, so among equal z-index values document order puts it in front.
 */
function alwaysOnTopRoot(): HTMLElement {
  const existing = document.getElementById(TOP_ROOT_ID);
  if (existing) return existing;
  const root = document.createElement("div");
  root.id = TOP_ROOT_ID;
  root.className = "portal-overlay-root";
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.pointerEvents = "none";
  root.style.zIndex = String(BANDS["always-on-top"]);
  document.body.append(root);
  return root;
}

/**
 * Mount `el` into the overlay root, in `band`.
 *
 * Falls back to `document.body` when there is no overlay root, because a surface that cannot find
 * its layer should still appear rather than silently do nothing on a page whose shell is older.
 * The z-index is set either way, so ordering survives the fallback; the root's `pointer-events`
 * discipline does not, which is why it is a fallback.
 */
export function mountLayer(el: HTMLElement, band: LayerBand = "floating"): Layer {
  const host = band === "always-on-top" ? alwaysOnTopRoot() : (overlayRoot() ?? document.body);
  const assign = (): void => {
    next[band] += 1;
    el.style.zIndex = String(BANDS[band] + next[band]);
  };
  assign();
  host.append(el);

  let released = false;
  return {
    el,
    raise(): void {
      if (released) return;
      // Re-assigning rather than swapping: reading every sibling's computed z-index and taking
      // the maximum is a layout read on every click, and is wrong the moment something in the
      // band is not managed here.
      assign();
    },
    release(): void {
      if (released) return;
      released = true;
      el.remove();
    },
  };
}

/** For tests: forget every allocation, so one file's numbers do not depend on another's. */
export function resetLayers(): void {
  for (const band of Object.keys(next) as LayerBand[]) next[band] = 0;
  document.getElementById(TOP_ROOT_ID)?.remove();
}
