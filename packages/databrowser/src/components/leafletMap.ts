// components/leafletMap.ts - the interactive bbox map.
//
// Used in two places, and NEVER on the initial paint:
//   • bbox editor (left panel)  - draw a rectangle by dragging, zoom/pan to place it precisely
//   • details panel (right)     - the same map, read-only, to inspect a file's extent up close
//
// The vector SVG (geo.ts) remains the instant default in both places. This upgrades it ONLY when
// the user asks for it, so nobody who never opens a map pays for Leaflet or a single tile.

import type { AppContext } from "../context.js";
import { el, type Disposables } from "../dom.js";
import { normalizeBboxLon } from "../state.js";
import type { BBoxSelection } from "../types.js";
import { loadLeaflet } from "../map.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type L = any;

/** A selection thinner than this in EITHER axis is a slip of the mouse, not a box. */
const MIN_SPAN_DEG = 0.1;

export interface MapHandle {
  destroy(): void;
}

export interface MapOptions {
  editable: boolean;
  bbox: BBoxSelection | null;
  /** Only called in editable mode, when the user finishes a drag. */
  onChange?: (b: { minLon: number; maxLon: number; minLat: number; maxLat: number }) => void;
}

/**
 * Resolve once `target` has a non-zero box (or give up). Uses ResizeObserver where available and
 * falls back to a couple of animation frames - enough for a panel that is mid-transition.
 */
function waitForSize(target: HTMLElement, dis: Disposables, timeoutMs = 3000): Promise<boolean> {
  const has = (): boolean => target.offsetWidth > 0 && target.offsetHeight > 0;
  if (has()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      ro?.disconnect();
      window.clearTimeout(timer);
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(has()), timeoutMs);
    const ro =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (has()) finish(true);
          })
        : null;
    ro?.observe(target);
    if (!ro) {
      // no ResizeObserver (old engines / jsdom): try again next frame, then give up gracefully
      const raf = (window.requestAnimationFrame ??
        ((f: FrameRequestCallback) => window.setTimeout(f, 16))) as typeof requestAnimationFrame;
      raf(() => raf(() => finish(has())));
    }
    dis.add(() => finish(false));
  });
}

/**
 * Mount an interactive map into `host`. Resolves to null when Leaflet is unavailable, which the
 * caller treats as "keep the SVG" - an air-gapped or offline deployment degrades silently.
 */
export async function mountLeafletMap(
  ctx: AppContext,
  dis: Disposables,
  host: HTMLElement,
  opts: MapOptions,
): Promise<MapHandle | null> {
  let leaflet: L;
  try {
    leaflet = await loadLeaflet(ctx.cfg.map, dis);
  } catch {
    return null; // offline / CSP / self-hosted URL wrong -> the SVG stays; nothing breaks
  }
  if (dis.isDisposed || !host.isConnected) return null;

  const canvas = el("div", { class: "lmap" });
  host.append(canvas);

  // Leaflet MUST NOT be initialised into a zero-size box. If it is, it lays its tiles out for a
  // 0x0 viewport and its pixel↔latlng maths is wrong from then on: the tiles come out misaligned
  // (the "broken" map) and drag-to-select picks the wrong coordinates or does nothing at all.
  //
  // That is easy to hit here: the card/panel this mounts into is a flex/grid child that may not
  // have resolved its height yet, or is still animating open. So we WAIT for a real size before
  // creating the map, and re-measure on every subsequent resize.

  const sized = await waitForSize(canvas, dis);
  if (!sized || dis.isDisposed || !canvas.isConnected) {
    canvas.remove();
    return null;
  }

  const map = leaflet.map(canvas, {
    worldCopyJump: false,
    zoomControl: true,
    // Leaflet's own "Leaflet" flag is a courtesy, not a licence condition (BSD-2) - dropped.
    // OpenStreetMap's credit IS required by the tile usage policy / ODbL, so it stays (small).
    attributionControl: true,
    // In editable mode a drag DRAWS, so map panning starts off. Panning is still reachable: the
    // Draw/Pan toggle below switches between the two gestures.
    dragging: !opts.editable,
    boxZoom: false,
  });
  map.attributionControl.setPrefix(false); // no "Leaflet | " prefix
  leaflet
    .tileLayer(ctx.cfg.map.tileUrl, {
      attribution: ctx.cfg.map.attribution,
      maxZoom: 12, // deep zoom is pointless for a bbox and costs tiles
      noWrap: true,
    })
    .addTo(map);

  let rect: L = null;
  const draw = (b: BBoxSelection | null): void => {
    if (rect) {
      rect.remove();
      rect = null;
    }
    if (!b) return;
    const n = normalizeBboxLon(b);
    // an antimeridian-crossing box is two rectangles, exactly as on the SVG map
    const boxes: Array<[[number, number], [number, number]]> = n.wraps
      ? [
          [
            [n.minLat, n.minLon],
            [n.maxLat, 180],
          ],
          [
            [n.minLat, -180],
            [n.maxLat, n.maxLon],
          ],
        ]
      : [
          [
            [n.minLat, n.minLon],
            [n.maxLat, n.maxLon],
          ],
        ];
    rect = leaflet
      .layerGroup(
        boxes.map((bb) =>
          leaflet.rectangle(bb, { color: "#4f7cff", weight: 1.5, fillOpacity: 0.18 }),
        ),
      )
      .addTo(map);
  };

  if (opts.bbox) {
    const n = normalizeBboxLon(opts.bbox);
    draw(opts.bbox);
    // Fit to the box, but never zoom in so far that the box stops being legible as a box. A tiny
    // (or degenerate) extent is padded out first, so the user always sees WHERE it is rather than
    // a full-screen close-up of the terrain inside it.
    const padLat = Math.max(0, (2 - (n.maxLat - n.minLat)) / 2);
    const padLon = Math.max(0, (2 - (n.maxLon - n.minLon)) / 2);
    map.fitBounds(
      [
        [n.minLat - padLat, n.minLon - padLon],
        [n.maxLat + padLat, n.maxLon + padLon],
      ],
      { padding: [14, 14], maxZoom: 5 },
    );
  } else {
    map.setView([20, 0], 1);
  }

  if (opts.editable && opts.onChange) {
    // Draw / Pan toggle
    let drawing = true; // the editor exists to draw, so that's the default
    const toggle = el("button", {
      class: "lmap-mode",
      type: "button",
      "aria-pressed": "true",
      title: "Draw a box (click to switch to panning)",
      "aria-label": "Draw a box",
      text: "▭ Draw",
    });
    const syncMode = (): void => {
      toggle.setAttribute("aria-pressed", drawing ? "true" : "false");
      toggle.classList.toggle("on", drawing);
      toggle.textContent = drawing ? "▭ Draw" : "✋ Pan";
      toggle.setAttribute(
        "data-tip",
        drawing ? "Drawing a box (click to pan instead)" : "Panning (click to draw a box)",
      );
      canvas.classList.toggle("drawing", drawing);
      if (drawing) map.dragging.disable();
      else map.dragging.enable();
    };
    dis.listen(toggle, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      drawing = !drawing;
      syncMode();
    });
    // keep the button out of Leaflet's own event handling
    leaflet.DomEvent.disableClickPropagation(toggle);
    canvas.append(toggle);
    syncMode();

    // Drag = draw a rectangle (when in Draw mode).
    let start: { lat: number; lng: number } | null = null;
    /** true when the gesture began on a control (+/−, attribution) rather than the map itself. */
    const onControl = (e: L): boolean => {
      const t = e.originalEvent?.target as HTMLElement | undefined;
      return !!t?.closest?.(".leaflet-control, .leaflet-bar, .leaflet-control-attribution");
    };
    const onDown = (e: L): void => {
      if (!drawing || onControl(e)) return; // controls (+/−, the toggle) never start a selection
      // Suppress the native selection the primary button would otherwise begin: a rectangle drag
      // sweeps over the +/- controls and the attribution, and the browser highlights them as if the
      // user were selecting their text. This runs only for a gesture that starts on the DRAWING
      // SURFACE with the primary button, so a click on a control - which returned above - keeps its
      // default behaviour, including focus and activation.
      const oe = e.originalEvent as MouseEvent | undefined;
      if (oe && oe.button === 0) oe.preventDefault();
      start = e.latlng;
    };
    const onMove = (e: L): void => {
      if (!start) return;
      draw({
        minLon: Math.min(start.lng, e.latlng.lng),
        maxLon: Math.max(start.lng, e.latlng.lng),
        minLat: Math.min(start.lat, e.latlng.lat),
        maxLat: Math.max(start.lat, e.latlng.lat),
        mode: "flexible",
      });
    };
    const onUp = (e: L): void => {
      if (!start) return;
      const a = start;
      start = null;
      const b = {
        minLon: Math.min(a.lng, e.latlng.lng),
        maxLon: Math.max(a.lng, e.latlng.lng),
        minLat: Math.min(a.lat, e.latlng.lat),
        maxLat: Math.max(a.lat, e.latlng.lat),
      };
      // A box that is flat in EITHER axis is not a selection - it's a click or a straight swipe.
      // Both spans must clear MIN_SPAN_DEG: a wide, zero-height box is an invisible rectangle, a
      // nonsense query, and a map that zooms to street level onto the "line".
      if (
        Math.abs(b.maxLon - b.minLon) < MIN_SPAN_DEG ||
        Math.abs(b.maxLat - b.minLat) < MIN_SPAN_DEG
      ) {
        draw(opts.bbox); // put the previous box back and ignore the gesture
        return;
      }
      opts.onChange?.(b);
    };
    map.on("mousedown", onDown);
    map.on("mousemove", onMove);
    map.on("mouseup", onUp);
    dis.add(() => {
      map.off("mousedown", onDown);
      map.off("mousemove", onMove);
      map.off("mouseup", onUp);
    });
  }

  // Leaflet measures on mount; the panel it lives in may still be animating open. Every deferred
  // touch is guarded: a re-render can detach the container first, and Leaflet throws on a detached
  // node (e.g. zooming and then refreshing).
  let dead = false;
  const safeInvalidate = (): void => {
    if (dead || !canvas.isConnected) return;
    try {
      map.invalidateSize();
    } catch {
      /* container went away mid-flight */
    }
  };
  dis.setTimeout(safeInvalidate, 0);
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => safeInvalidate());
    ro.observe(canvas);
    dis.add(() => ro.disconnect());
  }
  // …and whenever the map comes back INTO VIEW. The details panel is re-laid-out when a row is
  // focused (and the focused/split layouts have different widths), which otherwise leaves the map
  // measured for the old box.
  if (typeof IntersectionObserver === "function") {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) safeInvalidate();
    });
    io.observe(canvas);
    dis.add(() => io.disconnect());
  }
  dis.listen(window, "resize", safeInvalidate);

  const handle: MapHandle = {
    destroy(): void {
      if (dead) return;
      dead = true;
      try {
        map.remove();
      } catch {
        /* already torn down */
      }
      canvas.remove();
    },
  };
  dis.add(() => handle.destroy());
  return handle;
}
