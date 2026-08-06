// components/bboxEditor.ts - the Bounding-box popover. Drag a rectangle on the dependency-free
// SVG equirectangular map (geo.ts), or type validated numbers (lon ∈ [-180,180],
// lat ∈ [-90,90], min ≤ max). Antimeridian-crossing boxes are out of scope. The live
// preview matches what is sent: bbox=minLon,maxLon,minLat,maxLat&bbox_select=<mode>.
//
// `flexible` (Intersects) is the only mode whose semantics are confirmed against the backend.
// TODO(verify V4): index a fixture with extent 0,5,0,5; query box -10,10,-10,10; bbox_select=strict.
//   included -> strict = file ⊆ box (code/Solr correct; docs wrong)
//   excluded -> strict = file ⊇ box (docs correct; code mislabeled)
//   Write the directional help text from the OBSERVED result; report the discrepancy upstream.

import type { AppContext } from "../context.js";
import type { Disposables } from "../dom.js";
import { el, svgIcon } from "../dom.js";
import { paintRect, worldSVG, x2lon, y2lat } from "../geo.js";
import { mountLeafletMap } from "./leafletMap.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;
import { ICONS } from "../icons.js";
import type { SelectMode } from "../types.js";

const W = 276;
const H = 150;

interface Box {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

const HELP: Record<SelectMode, string> = {
  flexible: "Any overlap between your box and the file (intersects).",
  strict: "Containment match - sent to the backend as bbox_select=strict.",
  file: "File-relative containment - sent as bbox_select=file.",
};

function valid(box: Box): boolean {
  return (
    Number.isFinite(box.minLon) &&
    Number.isFinite(box.maxLon) &&
    Number.isFinite(box.minLat) &&
    Number.isFinite(box.maxLat) &&
    box.minLon >= -180 &&
    box.maxLon <= 180 &&
    box.minLat >= -90 &&
    box.maxLat <= 90 &&
    // A box needs AREA. `minLat === maxLat` (or the same in longitude) is a line, not a region:
    // it draws as nothing, matches nothing useful, and makes the map zoom to a point.
    box.minLon < box.maxLon &&
    box.minLat < box.maxLat
  );
}

/**
 * @param autoMap  Load Leaflet immediately. TRUE only for the "draw a region" popover, where the
 *                 user explicitly came to draw. The overview card leaves it FALSE so the metadata
 *                 grid never drags Leaflet onto the initial paint - it
 *                 shows the instant SVG plus a Zoom affordance, exactly like the details panel.
 */
export function buildBboxEditor(
  ctx: AppContext,
  reg: Disposables,
  done: () => void,
  opts: { autoMap?: boolean; inline?: boolean } = {},
): { editor: HTMLElement; dispose: () => void } {
  const autoMap = opts.autoMap ?? false;
  const inline = opts.inline ?? false;
  const start = ctx.state.bbox;
  let box: Box | null = start
    ? { minLon: start.minLon, maxLon: start.maxLon, minLat: start.minLat, maxLat: start.maxLat }
    : null;
  let mode: SelectMode = start?.mode ?? "flexible";

  const svg = worldSVG(W, H);
  const overlay = el("div", { class: "map-overlay" });
  const map = el("div", { class: "minimap" }, [svg, overlay]);

  const num = (label: string, key: keyof Box): { wrap: HTMLElement; input: HTMLInputElement } => {
    const input = el("input", {
      type: "text",
      inputmode: "decimal",
      "aria-label": label,
      value: box ? String(box[key]) : "",
    });
    const wrap = el("div", { class: "f" }, [el("label", { text: label }), input]);
    return { wrap, input };
  };
  const f0 = num("minLon", "minLon");
  const f1 = num("maxLon", "maxLon");
  const f2 = num("minLat", "minLat");
  const f3 = num("maxLat", "maxLat");

  function syncFields(): void {
    if (!box) return;
    f0.input.value = box.minLon.toFixed(1);
    f1.input.value = box.maxLon.toFixed(1);
    f2.input.value = box.minLat.toFixed(1);
    f3.input.value = box.maxLat.toFixed(1);
  }

  function refresh(): void {
    paintRect(svg, box ? { ...box, mode } : null, W, H);
    const ok = box !== null && valid(box);
    for (const f of [f0, f1, f2, f3]) f.input.classList.toggle("bad", box !== null && !ok);
  }

  // numeric inputs -> box
  const readFields = (): void => {
    const b: Box = {
      minLon: parseFloat(f0.input.value),
      maxLon: parseFloat(f1.input.value),
      minLat: parseFloat(f2.input.value),
      maxLat: parseFloat(f3.input.value),
    };
    box = b;
    refresh();
  };
  for (const f of [f0, f1, f2, f3]) reg.listen(f.input, "input", readFields);

  // drag-to-draw on the map overlay. Coordinates map against the overlay's ACTUAL rendered size:
  // in the overview card the SVG is stretched to 100% width, so the fixed W×H design constants
  // would mis-map every gesture. We read the live rect and scale back into design space.
  let dragStart: { x: number; y: number } | null = null;
  let dragged = false;
  const pt = (e: MouseEvent): { x: number; y: number } => {
    const r = overlay.getBoundingClientRect();
    const sx = r.width ? W / r.width : 1;
    const sy = r.height ? H / r.height : 1;
    return {
      x: Math.max(0, Math.min(W, (e.clientX - r.left) * sx)),
      y: Math.max(0, Math.min(H, (e.clientY - r.top) * sy)),
    };
  };
  reg.listen(overlay, "mousedown", (e) => {
    dragStart = pt(e as MouseEvent);
    dragged = false;
  });
  const offMove = reg.listen(window, "mousemove", (e) => {
    if (!dragStart) return;
    dragged = true;
    const p = pt(e as MouseEvent);
    box = {
      minLon: x2lon(Math.min(dragStart.x, p.x), W),
      maxLon: x2lon(Math.max(dragStart.x, p.x), W),
      maxLat: y2lat(Math.min(dragStart.y, p.y), H),
      minLat: y2lat(Math.max(dragStart.y, p.y), H),
    };
    syncFields();
    refresh();
  });
  const offUp = reg.listen(window, "mouseup", () => {
    // A drawn box must actually commit. syncFields() only sets input .value (no 'change' event
    // fires), so the drag has to apply the box itself or nothing would be searched.
    if (dragStart && dragged) applyLive();
    dragStart = null;
    dragged = false;
  });

  const modeButtons: HTMLButtonElement[] = (["flexible", "strict", "file"] as SelectMode[]).map(
    (m) => {
      // Reference parity: all three modes are always selectable and simply passed through as
      // bbox_select
      const btn = el("button", {
        type: "button",
        class: m === mode ? "on" : "",
        title: HELP[m],
        text: m,
      });
      reg.listen(btn, "click", () => {
        mode = m;
        for (const b of modeButtons) b.classList.toggle("on", b === btn);
        refresh();
        applyLive();
      });
      return btn;
    },
  );

  const clear = el("button", { class: "btn", type: "button", text: "Clear" });
  reg.listen(clear, "click", () => {
    done();
    ctx.setBbox(null);
  });

  // Leaflet is an on-demand UPGRADE: the SVG above is instant and costs nothing, and only a user
  // who actually wants to zoom pays for the library + tiles.
  // The editor exists to DRAW a region, so it goes straight to the real map. The SVG covers the
  // instant before Leaflet resolves and is then REMOVED, so only one map is ever visible.
  // (The details panel keeps the SVG + an on-demand upgrade: it renders on every row click.)
  const applyLive = (): void => {
    if (box && valid(box)) ctx.setBbox({ ...box, mode });
  };
  const upgradeMap = (): Promise<void> =>
    mountLeafletMap(ctx, reg, map, {
      editable: true,
      bbox: box ? { ...box, mode } : null,
      onChange: (b) => {
        box = {
          minLon: round2(b.minLon),
          maxLon: round2(b.maxLon),
          minLat: round2(b.minLat),
          maxLat: round2(b.maxLat),
        };
        syncFields();
        refresh();
        applyLive();
      },
    }).then((h) => {
      if (!h) {
        // offline / CSP -> the SVG picker stays, fully functional
        zoomBtn.disabled = false;
        zoomBtn.textContent = "Zoom unavailable";
        return;
      }
      svg.remove(); // exactly one map is visible at a time
      overlay.remove(); // …and the SVG's own drag layer with it
      map.classList.add("has-leaflet");
      zoomBtn.remove();
    });

  const zoomBtn = el(
    "button",
    {
      class: "map-zoom",
      type: "button",
      title: "Zoomable map",
      "aria-label": "Switch to the zoomable map",
    },
    [svgIcon(ICONS.search, { size: 13 }), el("span", { text: "Zoom" })],
  );
  reg.listen(zoomBtn, "click", () => {
    zoomBtn.disabled = true;
    zoomBtn.textContent = "Loading map…";
    void upgradeMap();
  });
  if (autoMap) {
    zoomBtn.remove();
    void upgradeMap(); // the user opened the editor to DRAW - go straight to the real map
  }

  for (const f of [f0, f1, f2, f3]) reg.listen(f.input, "change", () => applyLive());

  const editor = el("div", { class: `editor${inline ? " inline" : ""}` }, [
    el("h5", {}, [
      svgIcon(ICONS.box, { size: 16 }),
      el("span", { text: "Bounding box" }),
      el("span", { class: "sub", text: "bbox_select - drag to draw" }),
    ]),
    el("div", { class: "map-slot" }, [map, zoomBtn]),
    el("div", { class: "draw-hint", text: "Drag a rectangle, or type bounds below." }),
    el("div", { class: "bbox-fields" }, [f0.wrap, f1.wrap, f2.wrap, f3.wrap]),
    el("div", { class: "modes" }, modeButtons),
    ...(inline ? [] : [el("div", { class: "actions" }, [clear])]),
  ]);

  if (box) {
    syncFields();
    paintRect(svg, { ...box, mode }, W, H);
  }
  refresh();
  return {
    editor,
    dispose: () => {
      offMove();
      offUp();
    },
  };
}

export function openBboxEditor(ctx: AppContext, anchor: HTMLElement): void {
  const reg = ctx.region("popover");
  const { editor, dispose } = buildBboxEditor(ctx, reg, () => ctx.popover.close(), {
    autoMap: true,
  }); // draw -> real map
  ctx.popover.open(anchor, editor, {
    placement: "right",
    className: "editor-pop",
    onClose: dispose,
    // Applying a drawn box fires a search that rebuilds the sidebar, detaching this anchor. Re-find the
    // rebuilt "Bounding box" row so the editor stays open instead of vanishing mid-draw.
    reanchor: () =>
      ctx.roots.facetList.querySelector<HTMLElement>('.special[aria-label="Edit bounding box"]'),
  });
}
