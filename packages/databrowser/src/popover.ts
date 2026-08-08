// popover.ts - one active floating popover at a time, anchored to a trigger element.
//
// Positioning is COMPONENT-SCOPED, not viewport-scoped: the popover is a child of `.freva-db`, is
// `position: absolute`, and is placed and clamped by the shared helper in anchor.ts. See that file
// for why `position: fixed` is wrong inside an embedded host.
//
// Outside-click, Esc, scroll and resize teardown all route through the Disposables registry so
// destroy() leaves nothing behind.

import {
  anchorVisible,
  positionAnchored,
  type OverlayPlacement,
  type ScrollBehavior,
} from "./anchor.js";
import type { Disposables } from "./dom.js";
import { el } from "./dom.js";

export interface PopoverOptions {
  /** below = drop under the anchor (menus); right = sit to the right (editors). */
  placement?: OverlayPlacement;
  className?: string;
  onClose?: () => void;
  /** focus the first focusable child after opening. */
  autoFocus?: boolean;
  /** When the anchor is torn down by a re-render, re-find the fresh node instead of closing. Returns
   *  the replacement anchor (or null -> close). Lets an editor whose own action re-renders the sidebar
   *  (e.g. drawing a bbox triggers a search) stay open, re-anchored to the rebuilt row. */
  reanchor?: () => HTMLElement | null;
  /**
   * What an EXTERNAL scroll (the page, the results scroller, any ancestor) does.
   * Defaults to 'close' for menus; an editor that supplies `reanchor` defaults to 'reposition'.
   * Scrolling INSIDE the popover never closes it either way.
   */
  scrollBehavior?: ScrollBehavior;
}

export class PopoverManager {
  private readonly root: HTMLElement;
  private current: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private onCloseCb: (() => void) | null = null;
  private reanchorCb: (() => HTMLElement | null) | null = null;
  private scrollMode: ScrollBehavior = "close";

  constructor(root: HTMLElement, dis: Disposables) {
    this.root = root;
    dis.listen(document, "mousedown", (e) => {
      if (!this.current) return;
      const t = e.target as Node;
      if (this.current.contains(t)) return;
      if (this.anchor && this.anchor.contains(t)) return;
      this.close();
    });
    dis.listen(document, "keydown", (e) => {
      if (this.current && (e as KeyboardEvent).key === "Escape") {
        // Mark the Escape as handled WITHOUT silencing other document listeners: the host app's own
        // keydown handlers still run (they can honour defaultPrevented if they choose). The Help panel
        // listener - also on document - checks defaultPrevented and bows out, so one Escape closes only
        // the popover. (stopImmediatePropagation would have swallowed the host's listeners too.)
        e.preventDefault();
        const a = this.anchor;
        this.close();
        a?.focus();
      }
    });
    const reposition = (): void => {
      if (!this.current || !this.anchor) return;
      // an anchor replaced by a re-render leaves a visible-but-dead popover - try to re-find the
      // fresh node, and only close if there's genuinely nothing to anchor to.
      if (!this.anchor.isConnected && !this.tryReanchor()) {
        this.close();
        return;
      }
      // The anchor may still exist but have scrolled out of the component's visible area (a nested
      // result scroller). A menu pointing at something the user cannot see is just clutter.
      if (!anchorVisible(this.root, this.anchor) && !this.tryReanchor()) {
        this.close();
        return;
      }
      this.position(this.current, this.anchor, this.placement);
    };
    dis.listen(window, "resize", reposition);
    // Capture phase: this must see scrolls of INNER containers (the results scroller, the sidebar,
    // a host's own panel), which do not bubble.
    dis.listen(
      window,
      "scroll",
      (e) => {
        if (!this.current) return;
        // A scroll that happened INSIDE the popover is the user reading its own list - never a
        // reason to dismiss it. NB a scroll on `window` targets the Window, which is not a Node -
        // passing it to contains() throws, so the node check comes first.
        const target = e.target as Node | null;
        if (target && typeof target.nodeType === "number" && this.current.contains(target)) return;
        if (this.scrollMode === "close") {
          this.close();
          return;
        }
        reposition();
      },
      true,
    );
  }

  private placement: OverlayPlacement = "below";

  isOpen(): boolean {
    return this.current !== null;
  }

  /**
   * Close the popover if its anchor has been detached from the document - called (via a
   * microtask) after every region re-render, so a menu whose row was rebuilt underneath it
   * can never linger as a visible popover with flushed (dead) listeners.
   */
  closeIfAnchorDetached(): void {
    if (this.current && this.anchor && !this.anchor.isConnected) {
      if (this.tryReanchor()) this.position(this.current, this.anchor, this.placement);
      else this.close();
    }
  }

  /** The anchor was torn down by a re-render. If a reanchor callback finds a fresh, connected
   *  replacement, adopt it (popover stays open); otherwise report failure so the caller can close. */
  private tryReanchor(): boolean {
    const fresh = this.reanchorCb?.() ?? null;
    if (fresh && fresh.isConnected) {
      this.anchor = fresh;
      return true;
    }
    return false;
  }

  open(anchor: HTMLElement, content: Node | Node[], opts: PopoverOptions = {}): HTMLElement {
    // INVARIANT: at most one popover is open at a time - opening always closes the prior one
    // first. There are NO nested popovers. This is what makes the single shared `ctx.region('popover')`
    // listener bucket (lens menu, export menu, time/bbox editors) safe to flush on each open.
    this.close();
    const pop = el("div", {
      class: `pop show${opts.className ? " " + opts.className : ""}`,
      role: "dialog",
    });
    // ABSOLUTE, in the component root's coordinate space - see anchor.ts.
    pop.style.position = "absolute";
    for (const c of Array.isArray(content) ? content : [content]) pop.append(c);
    this.root.append(pop);
    this.current = pop;
    this.anchor = anchor;
    this.onCloseCb = opts.onClose ?? null;
    this.reanchorCb = opts.reanchor ?? null;
    this.placement = opts.placement ?? "below";
    // An editor that can re-anchor is one that survives its own re-render, so repositioning is the
    // sensible default for it; everything else is a transient menu.
    this.scrollMode = opts.scrollBehavior ?? (opts.reanchor ? "reposition" : "close");
    this.position(pop, anchor, this.placement);
    if (opts.autoFocus) {
      const focusable = pop.querySelector<HTMLElement>(
        "input, button, [href], [tabindex], select, textarea",
      );
      focusable?.focus();
    }
    return pop;
  }

  private position(pop: HTMLElement, anchor: HTMLElement, placement: OverlayPlacement): void {
    positionAnchored(this.root, pop, anchor, { placement });
  }

  close(): void {
    if (!this.current) return;
    // If focus is inside the popover (a keyboard user activated an item), return it to the trigger so
    // it doesn't fall to <body>. For a pointer outside-click, focus is already elsewhere - leave it.
    const focusInside = !!this.current.contains(this.root.ownerDocument.activeElement);
    const anchor = this.anchor;
    this.current.remove();
    this.current = null;
    this.anchor = null;
    this.reanchorCb = null;
    const cb = this.onCloseCb;
    this.onCloseCb = null;
    if (focusInside && anchor && anchor.isConnected) anchor.focus();
    cb?.();
  }
}
