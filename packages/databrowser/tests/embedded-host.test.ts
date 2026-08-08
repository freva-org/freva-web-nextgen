// The embedded-host fixture.
//
// Waterpark relocates the mount into `.md-content`, gives it `height: calc(100vh - header)` and
// `overflow: hidden`, and uses an instant-navigation document. That combination breaks
// `position: fixed` overlays in two independent ways: a transformed/contained ancestor changes what
// `fixed` resolves against, and a clipping container hides anything that lands outside it. The
// fixture below reproduces the shape of that host - page scroll, a transformed ancestor, a bounded
// `overflow: hidden` mount, and a nested result scroller - and asserts the overlays stay attached
// to what they point at.
//
// This is handled in the DATA BROWSER. Nothing here edits or depends on the host's own CSS.

import "./helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  installFetch,
  overviewResponse,
  searchResponse,
  tick,
  wait,
  window as win,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";
import { anchorVisible, localRect, positionAnchored, visibleBox } from "../src/anchor.js";
import type { DataBrowserHandle } from "../src/types.js";

const q = <T extends Element>(r: ParentNode, s: string): T | null => r.querySelector<T>(s);
const qa = <T extends Element>(r: ParentNode, s: string): T[] => [...r.querySelectorAll<T>(s)];

/** Viewport of the simulated host page. */
const VIEW = { w: 1200, h: 800 };
/** The mount sits below a 64px host header and is clipped to the rest of the page. */
const MOUNT = { left: 40, top: 64, w: 900, h: 600 };

/**
 * Build the embedded shape and give every element a rect, because jsdom lays nothing out. Rects are
 * derived from a per-element override, else from the mount box, so the geometry is deterministic.
 */
function embeddedHost(): {
  mount: HTMLElement;
  setRect: (el: Element, r: Partial<DOMRect>) => void;
} {
  const doc = win.document;
  const page = doc.createElement("div");
  page.className = "host-page";
  // A transformed ancestor: this alone is enough to make `position: fixed` resolve against it.
  page.style.transform = "translateZ(0)";
  const content = doc.createElement("div");
  content.className = "md-content";
  content.style.height = `${MOUNT.h}px`;
  content.style.overflow = "hidden"; // the clipping container
  const mount = doc.createElement("div");
  content.appendChild(mount);
  page.appendChild(content);
  doc.body.appendChild(page);

  const rects = new WeakMap<Element, DOMRect>();
  const make = (r: Partial<DOMRect>): DOMRect => {
    const left = r.left ?? 0;
    const top = r.top ?? 0;
    const width = r.width ?? 0;
    const height = r.height ?? 0;
    return {
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  const setRect = (el: Element, r: Partial<DOMRect>): void => {
    rects.set(el, make(r));
  };
  // Every element reports SOMETHING; unknown ones inherit the mount box so `hasLayout` is true.
  const proto = win.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  const fallback = make({ left: MOUNT.left, top: MOUNT.top, width: MOUNT.w, height: MOUNT.h });
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    return rects.get(this) ?? fallback;
  };
  Object.defineProperty(win, "innerWidth", { value: VIEW.w, configurable: true });
  Object.defineProperty(win, "innerHeight", { value: VIEW.h, configurable: true });
  setRect(page, { left: 0, top: -120, width: VIEW.w, height: 1400 }); // the page is scrolled down
  setRect(content, { left: MOUNT.left, top: MOUNT.top, width: MOUNT.w, height: MOUNT.h });
  setRect(mount, { left: MOUNT.left, top: MOUNT.top, width: MOUNT.w, height: MOUNT.h });
  return { mount, setRect };
}

const rows = Array.from({ length: 12 }, (_, i) => ({ file: `/d/f_${i}.nc` }));
const router = (call: { url: string }): Record<string, unknown> => {
  if (call.url.includes("/overview")) return { body: overviewResponse(["freva", "cmip6"], {}) };
  return {
    body: searchResponse({
      total: rows.length,
      rows,
      facets: { project: ["cmip6", 4, "cordex", 2] },
      primary: ["project"],
    }),
  };
};

async function mountEmbedded(): Promise<{
  handle: DataBrowserHandle;
  root: HTMLElement;
  setRect: (el: Element, r: Partial<DOMRect>) => void;
}> {
  installFetch(router as never);
  const { mount, setRect } = embeddedHost();
  const handle = mountDataBrowser(mount, { syncUrl: false });
  await wait(40);
  const root = mount.querySelector(".freva-db") as HTMLElement;
  setRect(root, { left: MOUNT.left, top: MOUNT.top, width: MOUNT.w, height: MOUNT.h });
  const scroller = root.querySelector(".results-scroll") as HTMLElement;
  setRect(scroller, { left: MOUNT.left, top: MOUNT.top + 120, width: MOUNT.w, height: 400 });
  root
    .querySelector('.seg [aria-label="List view"]')
    ?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await tick();
  return { handle, root, setRect };
}

test("visibleBox and localRect work in the component's own coordinate space", async () => {
  const { handle, root, setRect } = await mountEmbedded();
  const box = visibleBox(root);
  assert.equal(box.left, 0, "root-local coordinates start at the root's own origin");
  assert.equal(box.top, 0);
  assert.equal(box.width, MOUNT.w, "the whole mount is on screen here");
  assert.equal(box.height, MOUNT.h);

  // A row 200px down the mount is at local y=200 - NOT at its viewport y.
  const row = qa<HTMLElement>(root, "#fdb-results .row")[0];
  setRect(row, { left: MOUNT.left + 10, top: MOUNT.top + 200, width: 800, height: 48 });
  const local = localRect(root, row);
  assert.equal(local.top, 200, "the anchor rect is converted, not used raw");
  assert.equal(local.left, 10);
  handle.destroy();
});

test("a row kebab menu opens INSIDE the component, absolutely positioned, clamped to it", async () => {
  const { handle, root, setRect } = await mountEmbedded();
  const row = qa<HTMLElement>(root, "#fdb-results .row")[0];
  const kebab = row.querySelector(".kebab") as HTMLElement;
  setRect(kebab, { left: MOUNT.left + 850, top: MOUNT.top + 200, width: 28, height: 28 });
  kebab.click();
  await tick();
  const pop = q<HTMLElement>(root, ".pop.show");
  assert.ok(pop, "the menu opened");
  assert.equal(pop!.parentElement, root, "it lives on the component root, not on <body>");
  assert.equal(pop!.style.position, "absolute", "…and is positioned in the root's own space");
  // Its coordinates are root-LOCAL: a viewport-space top would be ~264, not ~228.
  const top = parseFloat(pop!.style.top);
  const left = parseFloat(pop!.style.left);
  assert.ok(top > 0 && top < MOUNT.h, `top ${top} is inside the component, not a viewport value`);
  assert.ok(left >= 8 && left <= MOUNT.w - 8, `left ${left} is clamped into the component`);
  // …and it can never be bigger than the visible part of the component.
  assert.ok(parseFloat(pop!.style.maxHeight) <= MOUNT.h, "height is capped to the visible box");
  assert.ok(parseFloat(pop!.style.maxWidth) <= MOUNT.w, "width is capped to the visible box");
  handle.destroy();
});

test("scrolling the NESTED result scroller closes the row menu - no floating leftover", async () => {
  const { handle, root, setRect } = await mountEmbedded();
  const row = qa<HTMLElement>(root, "#fdb-results .row")[0];
  const kebab = row.querySelector(".kebab") as HTMLElement;
  setRect(kebab, { left: MOUNT.left + 850, top: MOUNT.top + 200, width: 28, height: 28 });
  kebab.click();
  await tick();
  assert.ok(q(root, ".pop.show"), "menu open");
  // An inner scroller's scroll does not bubble - only a capture-phase listener sees it.
  const scroller = root.querySelector(".results-scroll") as HTMLElement;
  scroller.dispatchEvent(new win.Event("scroll", { bubbles: false }));
  await tick();
  assert.equal(q(root, ".pop.show"), null, "the transient menu closed rather than detaching");
  handle.destroy();
});

test("scrolling the PAGE closes the Export dropdown too", async () => {
  const { handle, root, setRect } = await mountEmbedded();
  const exportBtn = q<HTMLElement>(root, '[aria-label="Export catalogue"]')!;
  setRect(exportBtn, { left: MOUNT.left + 800, top: MOUNT.top + 100, width: 90, height: 30 });
  exportBtn.click();
  await tick();
  assert.ok(q(root, ".pop.show"), "the export menu opened");
  win.dispatchEvent(new win.Event("scroll"));
  await tick();
  assert.equal(q(root, ".pop.show"), null, "a page scroll dismisses it");
  handle.destroy();
});

test("scrolling INSIDE a popover does not close it", async () => {
  const { handle, root, setRect } = await mountEmbedded();
  const lens = q<HTMLElement>(root, ".lens")!;
  setRect(lens, { left: MOUNT.left + 200, top: MOUNT.top + 10, width: 160, height: 43 });
  lens.click();
  await tick();
  const pop = q<HTMLElement>(root, ".pop.show");
  assert.ok(pop, "the flavour menu opened");
  pop!.dispatchEvent(new win.Event("scroll", { bubbles: false }));
  await tick();
  assert.ok(q(root, ".pop.show"), "reading a long menu must not dismiss it");
  handle.destroy();
});

test("an editor popover REPOSITIONS on scroll instead of closing", async () => {
  const { handle, root, setRect } = await mountEmbedded();
  const timeBtn = q<HTMLElement>(root, '.special[aria-label="Edit time range"]')!;
  setRect(timeBtn, { left: MOUNT.left + 20, top: MOUNT.top + 300, width: 220, height: 34 });
  timeBtn.click();
  await tick();
  assert.ok(q(root, ".pop.show"), "the time editor opened");
  // The editor supplies a `reanchor`, so unlike a transient menu it survives a scroll instead of
  // being dismissed mid-edit. (That it FOLLOWS the anchor is asserted on the pure helper below,
  // where the geometry can be controlled exactly - jsdom lays nothing out.)
  win.dispatchEvent(new win.Event("scroll"));
  await tick();
  assert.ok(q(root, ".pop.show"), "an editor is not a transient menu - it stays open");
  // …while a transient menu opened from the same component still closes on the same event.
  handle.destroy();
});

test("positionAnchored follows its anchor and never leaves the visible box", () => {
  const doc = win.document;
  const root = doc.createElement("div");
  const overlay = doc.createElement("div");
  const anchor = doc.createElement("div");
  root.append(overlay, anchor);
  doc.body.append(root);
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    }) as DOMRect;
  const boxes = new Map<Element, DOMRect>();
  const proto = win.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    return boxes.get(this) ?? rect(0, 0, 0, 0);
  };
  try {
    Object.defineProperty(win, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(win, "innerHeight", { value: 800, configurable: true });
    boxes.set(root, rect(40, 64, 900, 600)); // the embedded, clipped mount
    boxes.set(overlay, rect(0, 0, 200, 120));

    boxes.set(anchor, rect(140, 264, 60, 30)); // 100,200 in root-local terms
    positionAnchored(root, overlay, anchor, { placement: "below" });
    assert.equal(overlay.style.left, "100px", "left is ROOT-LOCAL, not the viewport's 140");
    assert.equal(overlay.style.top, "236px", "…and so is top (200 + 30 + a 6px gap)");

    boxes.set(anchor, rect(140, 164, 60, 30)); // the anchor moved up by 100
    positionAnchored(root, overlay, anchor, { placement: "below" });
    assert.equal(overlay.style.top, "136px", "repositioning follows the anchor");

    // Right edge: the overlay is pulled back inside rather than overhanging the clipped mount.
    boxes.set(anchor, rect(40 + 880, 264, 60, 30));
    positionAnchored(root, overlay, anchor, { placement: "below" });
    assert.equal(overlay.style.left, "692px", "clamped to the visible box (900 - 8 - 200)");

    // Bottom edge: it flips ABOVE the anchor instead of running off.
    boxes.set(anchor, rect(140, 64 + 560, 60, 30));
    positionAnchored(root, overlay, anchor, { placement: "below" });
    assert.equal(overlay.style.top, "434px", "flipped above (560 - 120 - 6)");

    // It can never be larger than the visible intersection, in EITHER axis.
    assert.equal(overlay.style.maxWidth, "884px");
    assert.equal(overlay.style.maxHeight, "584px");

    // A root scrolled half out of the viewport shrinks the visible box accordingly.
    boxes.set(root, rect(40, -300, 900, 600));
    const box = visibleBox(root);
    assert.equal(box.top, 300, "the part above the viewport is not available");
    assert.equal(box.height, 300);
  } finally {
    proto.getBoundingClientRect = original;
    root.remove();
  }
});

test("an overlay closes when its anchor leaves the component's visible area", async () => {
  const { handle, root, setRect } = await mountEmbedded();
  const row = qa<HTMLElement>(root, "#fdb-results .row")[0];
  const kebab = row.querySelector(".kebab") as HTMLElement;
  setRect(kebab, { left: MOUNT.left + 850, top: MOUNT.top + 200, width: 28, height: 28 });
  kebab.click();
  await tick();
  assert.ok(anchorVisible(root, kebab), "the anchor starts on screen");
  // Scroll it out of the mount's clipped box - the host's `overflow: hidden` means it is GONE.
  setRect(kebab, { left: MOUNT.left + 850, top: MOUNT.top + MOUNT.h + 200, width: 28, height: 28 });
  assert.ok(!anchorVisible(root, kebab), "…and is then outside the visible intersection");
  win.dispatchEvent(new win.Event("resize"));
  await tick();
  assert.equal(q(root, ".pop.show"), null, "the overlay went with it");
  handle.destroy();
});

test("a long unbroken tooltip label is bounded and stays inside the component at either edge", async () => {
  const { handle, root, setRect } = await mountEmbedded();
  const tip = q<HTMLElement>(root, ".fdb-tip")!;
  const target = qa<HTMLElement>(root, "[data-tip]")[0];
  const veryLong = "/archive/" + "x".repeat(400) + "/tas.nc";
  target.setAttribute("data-tip", veryLong);
  for (const [name, left] of [
    ["left edge", MOUNT.left + 2],
    ["right edge", MOUNT.left + MOUNT.w - 30],
  ] as const) {
    setRect(target, { left, top: MOUNT.top + 300, width: 28, height: 28 });
    setRect(tip, { left: 0, top: 0, width: 280, height: 60 });
    target.dispatchEvent(new win.MouseEvent("pointerover", { bubbles: true }));
    await wait(120);
    assert.ok(tip.classList.contains("show"), `tip shows at the ${name}`);
    const l = parseFloat(tip.style.left);
    assert.ok(l >= 0, `${name}: never off the component's left edge (${l})`);
    assert.ok(l + 280 <= MOUNT.w + 6, `${name}: never past its right edge (${l})`);
    target.dispatchEvent(new win.MouseEvent("pointerout", { bubbles: true }));
    await tick();
  }
  handle.destroy();
});
