// components/tooltip.ts - immediate, styled tooltips.
//
// The browser's native `title` popup is slow (~1s delay) and unstyled. el() routes every `title` to
// `data-tip`, and this installs ONE delegated listener on the app root that shows a single reused,
// fixed-position bubble next to the hovered/focused target. Fixed positioning means it is never
// clipped by a scroll container's overflow, and it flips/clamps to stay on screen. No per-element
// nodes, no library. Tooltip text reaches the DOM via textContent.

import type { Disposables } from "../dom.js";
import { el } from "../dom.js";

const SHOW_DELAY = 80; // ms - brief, so it feels immediate without flashing on a quick pass-through
const GAP = 8;

export function installTooltips(root: HTMLElement, dis: Disposables): void {
  const tip = el("div", { class: "fdb-tip", role: "tooltip" });
  root.appendChild(tip);
  let target: HTMLElement | null = null;
  let showT = 0;

  const place = (t: HTMLElement): void => {
    const text = t.getAttribute("data-tip") ?? "";
    if (!text || !t.isConnected) return; // never anchor to a node a re-render removed
    tip.textContent = text;
    tip.classList.add("show"); // measure with it laid out
    mo?.observe(root, { childList: true, subtree: true }); // hide if this anchor is later detached
    const r = t.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    // prefer below the target; flip above if it would run off the bottom
    let top = r.bottom + GAP;
    let above = false;
    if (top + tr.height > window.innerHeight - 4) {
      top = r.top - GAP - tr.height;
      above = true;
    }
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.classList.toggle("above", above);
  };

  const hide = (): void => {
    window.clearTimeout(showT);
    target = null;
    tip.classList.remove("show");
    mo?.disconnect(); // stop watching once nothing is shown
  };
  // While a tip is visible, watch for the anchor being removed by a re-render (no pointer/focus event
  // fires then). Only connected while showing; the callback is a cheap isConnected check, so there's
  // no cost when no tip is up.
  const mo =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          if (target && !target.isConnected) hide();
        })
      : null;

  const targetOf = (e: Event): HTMLElement | null => {
    const start = e.target as HTMLElement | null;
    const hit = start?.closest?.("[data-tip]") as HTMLElement | null;
    return hit && root.contains(hit) && hit.getAttribute("data-tip") ? hit : null;
  };

  dis.listen(root, "pointerover", (e) => {
    const t = targetOf(e);
    if (!t || t === target) return;
    target = t;
    window.clearTimeout(showT);
    showT = window.setTimeout(() => {
      if (target === t && t.isConnected) place(t);
    }, SHOW_DELAY);
  });
  dis.listen(root, "pointerout", (e) => {
    const t = targetOf(e);
    if (!t || t !== target) return;
    // Moving BETWEEN children of one tooltipped control (e.g. its icon -> its label) fires
    // pointerout on the shared control; ignore it while the pointer is still inside that control,
    // otherwise the tip blinks at every internal boundary.
    const to = (e as PointerEvent).relatedTarget as Node | null;
    if (to && t.contains(to)) return;
    hide();
  });
  // keyboard users get it immediately on focus
  dis.listen(root, "focusin", (e) => {
    const t = targetOf(e);
    if (t) {
      target = t;
      place(t);
    }
  });
  dis.listen(root, "focusout", hide);
  // any press or scroll dismisses (a held position would go stale)
  dis.listen(root, "pointerdown", hide, true);
  dis.listen(window, "scroll", hide, true);
  dis.add(() => {
    window.clearTimeout(showT);
    mo?.disconnect();
    tip.remove();
  });
}
