// popover.ts - one active floating popover at a time, anchored to a trigger element.
// Uses fixed positioning + getBoundingClientRect so it stays correct regardless of which
// inner scroll container the anchor lives in. Outside-click, Esc, scroll and resize teardown
// all route through the Disposables registry so destroy() leaves nothing behind.

import type { Disposables } from "./dom.js";
import { el } from "./dom.js";

export interface PopoverOptions {
  /** below = drop under the anchor (menus); right = sit to the right (editors). */
  placement?: "below" | "right";
  className?: string;
  onClose?: () => void;
  /** focus the first focusable child after opening. */
  autoFocus?: boolean;
  /** When the anchor is torn down by a re-render, re-find the fresh node instead of closing. Returns
   *  the replacement anchor (or null -> close). Lets an editor whose own action re-renders the sidebar
   *  (e.g. drawing a bbox triggers a search) stay open, re-anchored to the rebuilt row. */
  reanchor?: () => HTMLElement | null;
}

export class PopoverManager {
  private readonly root: HTMLElement;
  private current: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private onCloseCb: (() => void) | null = null;
  private reanchorCb: (() => HTMLElement | null) | null = null;

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
      this.position(this.current, this.anchor, this.placement);
    };
    this.placement = "below";
    dis.listen(window, "resize", reposition);
    dis.listen(window, "scroll", reposition, true);
  }

  private placement: "below" | "right" = "below";

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
      if (this.tryReanchor()) this.position(this.current, this.anchor!, this.placement);
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
    pop.style.position = "fixed";
    for (const c of Array.isArray(content) ? content : [content]) pop.append(c);
    this.root.append(pop);
    this.current = pop;
    this.anchor = anchor;
    this.onCloseCb = opts.onClose ?? null;
    this.reanchorCb = opts.reanchor ?? null;
    this.placement = opts.placement ?? "below";
    this.position(pop, anchor, this.placement);
    if (opts.autoFocus) {
      const focusable = pop.querySelector<HTMLElement>(
        "input, button, [tabindex], select, textarea",
      );
      focusable?.focus();
    }
    return pop;
  }

  private position(pop: HTMLElement, anchor: HTMLElement, placement: "below" | "right"): void {
    const margin = 8;
    // Never let a popover be taller than the viewport - otherwise a tall one (the bbox map + inputs)
    // runs off the bottom with no way back. Cap it and let its own content scroll.
    const maxH = window.innerHeight - margin * 2;
    pop.style.maxHeight = `${maxH}px`;
    pop.style.overflowY = "auto";
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = Math.min(pop.offsetHeight, maxH);
    let top: number;
    let left: number;
    if (placement === "right") {
      top = r.top;
      left = r.right + margin;
      if (left + pw > window.innerWidth - margin) left = r.left - pw - margin;
    } else {
      top = r.bottom + 6;
      left = r.left;
    }
    if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
    if (left < margin) left = margin;
    // Vertical: prefer the natural spot; if it would overflow the bottom, flip above (for 'below') or
    // slide up (for 'right'); then clamp so the WHOLE popover is on-screen (top and bottom both).
    if (top + ph > window.innerHeight - margin) {
      top = placement === "right" ? window.innerHeight - ph - margin : r.top - ph - 6;
    }
    if (top < margin) top = margin;
    if (top + ph > window.innerHeight - margin)
      top = Math.max(margin, window.innerHeight - ph - margin);
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
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
