/**
 * Overview reordering across the primary / additional boundary, and the map's drawing gesture.
 *
 * Both need a real engine for the same reason: the pointer path finds the card under the cursor
 * with `elementFromPoint`, and jsdom has no layout, so there is nothing under any cursor. The
 * keyboard path can be exercised in jsdom (and is, in `tests/overview-order.test.ts`); the DRAG can
 * only be exercised here.
 *
 *  1. A card moved across the boundary moves ON SCREEN, not just in `overviewOrder` - state and
 *     DOM must not disagree, which is what happens if the two groups are ordered independently.
 *  2. Dragging a bounding box in Draw mode leaves no native text selection on the Leaflet +/-
 *     controls, and those controls still zoom and still take focus.
 */
import { IMPORT_MAP, fakeApi, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%} #app{height:100vh;width:1280px}</style></head>
<body><div id="app"></div>
${fakeApi({
  rows: Array.from({ length: 8 }, (_, i) => ({ file: `/archive/tas_${i}.nc`, fs_type: "posix" })),
  facets: { project: ["cmip6", 12], model: ["m1", 8], variable: ["tas", 6] },
  // Only `project` is primary → `model` and `variable` live behind "Show additional facets".
  primary: ["project"],
})}
<script type="module">
  const { mountDataBrowser } = await import("@freva-org/databrowser");
  window.__h = mountDataBrowser(document.getElementById("app"), { syncUrl: false });
  await new Promise(r => setTimeout(r, 600));
  window.__ready = true;
</script></body></html>`;

const result = await inChromium(async (browser) => {
  const server = await serve(page);
  const checks = [];
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    // 1. Reordering across the primary / additional boundary
    const reorder = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-db");
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      root.querySelector('.ctrl[aria-label="Overview"]').click();
      await sleep(400);

      const addBtn = root.querySelector(".ov-addbtn");
      if (!addBtn) return { error: "no additional-facets section" };
      addBtn.click();
      await sleep(300);

      const keys = () =>
        [...root.querySelectorAll(".facet-grid .fcard[data-key]")].map((c) => c.dataset.key);
      const grip = (k) => root.querySelector(`.fcard[data-key="${k}"] .drag-grip`);
      const state = () => window.__h.getState().overviewOrder;

      const defaultOrder = keys();

      // KEYBOARD across the boundary
      grip("__bbox").focus();
      grip("__bbox").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
      await sleep(250);
      const kbDom = keys();
      const kbState = state();
      const kbFocus = document.activeElement === grip("__bbox");

      // POINTER across the boundary
      // Drag Time from wherever it is onto the LAST card, which is an additional facet.
      const pointer = (el, type, x, y) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            pointerId: 1,
            button: 0,
            buttons: 1,
            isPrimary: true,
          }),
        );
      const before = keys();
      const target = before[before.length - 1];
      const g = grip("__time");
      const gb = g.getBoundingClientRect();
      const tb = root.querySelector(`.fcard[data-key="${target}"]`).getBoundingClientRect();
      pointer(g, "pointerdown", gb.left + gb.width / 2, gb.top + gb.height / 2);
      // Land on the RIGHT half of the target, which is what asks for "after this card".
      pointer(window, "pointermove", tb.left + tb.width * 0.8, tb.top + tb.height / 2);
      await sleep(60);
      pointer(window, "pointermove", tb.left + tb.width * 0.8, tb.top + tb.height / 2);
      await sleep(60);
      pointer(window, "pointerup", tb.left + tb.width * 0.8, tb.top + tb.height / 2);
      await sleep(300);
      const ptDom = keys();
      const ptState = state();

      // And it survives a remount
      window.__h.destroy();
      const app = document.getElementById("app");
      app.innerHTML = "";
      const { mountDataBrowser } = await import("@freva-org/databrowser");
      window.__h = mountDataBrowser(app, { syncUrl: false });
      await sleep(600);
      const root2 = document.querySelector(".freva-db");
      root2.querySelector('.ctrl[aria-label="Overview"]').click();
      await sleep(400);
      const remounted = [...root2.querySelectorAll(".facet-grid .fcard[data-key]")].map(
        (c) => c.dataset.key,
      );

      return { defaultOrder, kbDom, kbState, kbFocus, before, ptDom, ptState, remounted };
    });

    checks.push({
      name: "overview: the default order is primary facets, Time, BBox, then additional facets",
      pass:
        !reorder.error &&
        JSON.stringify(reorder.defaultOrder) ===
          JSON.stringify(["project", "__time", "__bbox", "model", "variable"]),
      detail: JSON.stringify(reorder.defaultOrder ?? reorder),
    });
    checks.push({
      name: "overview: a KEYBOARD move past an additional facet moves the card on screen, not only in state",
      pass:
        !reorder.error &&
        JSON.stringify(reorder.kbDom) ===
          JSON.stringify(["project", "__time", "model", "__bbox", "variable"]) &&
        JSON.stringify(reorder.kbState) === JSON.stringify(reorder.kbDom) &&
        reorder.kbFocus === true,
      detail: JSON.stringify({
        dom: reorder.kbDom,
        state: reorder.kbState,
        focus: reorder.kbFocus,
      }),
    });
    checks.push({
      name: "overview: a POINTER drag past an additional facet lands where it was dropped",
      pass:
        !reorder.error &&
        Array.isArray(reorder.ptDom) &&
        reorder.ptDom[reorder.ptDom.length - 1] === "__time" &&
        JSON.stringify(reorder.ptState) === JSON.stringify(reorder.ptDom),
      detail: JSON.stringify({
        before: reorder.before,
        dom: reorder.ptDom,
        state: reorder.ptState,
      }),
    });
    checks.push({
      name: "overview: the cross-section order survives a remount",
      pass: !reorder.error && JSON.stringify(reorder.remounted) === JSON.stringify(reorder.ptDom),
      detail: JSON.stringify({ after: reorder.ptDom, remounted: reorder.remounted }),
    });

    // 2. Draw mode does not let the gesture select the map's controls
    //
    // HONESTY NOTE. Leaflet is loaded at runtime from a CDN and is not vendored, so in a sandbox
    // with no network the interactive map never mounts and there is no `.lmap` to measure. What is
    // measured instead is the SHIPPED RULE against the exact markup Leaflet produces, inside the
    // real component root so the real stylesheet, cascade and stacking context all apply: a
    // `.lmap.drawing` containing a `.leaflet-container` and a `.leaflet-control-zoom` bar. The
    // second half of the behaviour - `preventDefault()` on a primary-button mousedown that starts
    // on the drawing surface - lives in `leafletMap.ts` and cannot be exercised without Leaflet
    // itself; it is guarded by the same `onControl()` early return as the rest.
    const map = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-db");
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const host = root.querySelector('.fcard[data-key="__bbox"] .fcard-special-body') ?? root;
      const lmap = document.createElement("div");
      lmap.className = "lmap drawing";
      lmap.style.cssText = "width:320px;height:200px;position:relative";
      lmap.innerHTML = `
        <div class="leaflet-container" style="position:absolute;inset:0">
          <span class="leaflet-tile-label">some map text that could be selected</span>
          <div class="leaflet-control-container">
            <div class="leaflet-top leaflet-left" style="position:absolute;left:8px;top:8px">
              <div class="leaflet-control-zoom leaflet-bar leaflet-control">
                <a class="leaflet-control-zoom-in" href="#" role="button" aria-label="Zoom in"
                   style="display:block;width:26px;height:26px;background:#fff">+</a>
                <a class="leaflet-control-zoom-out" href="#" role="button" aria-label="Zoom out"
                   style="display:block;width:26px;height:26px;background:#fff">-</a>
              </div>
            </div>
          </div>
          <div class="leaflet-control-attribution"><a href="https://example.org">Attribution</a></div>
        </div>`;
      host.prepend(lmap);
      await sleep(80);

      const container = lmap.querySelector(".leaflet-container");
      const zoomIn = lmap.querySelector(".leaflet-control-zoom-in");
      const label = lmap.querySelector(".leaflet-tile-label");
      // Read it NOW: a computed-style object is live, and it reports empty once the node is
      // detached at the end of this function.
      const drawSelect = getComputedStyle(zoomIn).userSelect;

      const mouse = (el, type, x, y) =>
        el.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: type === "mouseup" ? 0 : 1,
          }),
        );

      // Drag from the far corner of the drawing surface straight across the +/- controls, which is
      // the gesture that would highlight them.
      const cb = container.getBoundingClientRect();
      const zb = zoomIn.getBoundingClientRect();
      getSelection().removeAllRanges();
      mouse(container, "mousedown", cb.right - 10, cb.bottom - 10);
      for (let i = 1; i <= 8; i++) {
        const x = cb.right - 10 + ((zb.left + 4 - (cb.right - 10)) * i) / 8;
        const y = cb.bottom - 10 + ((zb.top + 4 - (cb.bottom - 10)) * i) / 8;
        mouse(document, "mousemove", x, y);
      }
      mouse(document, "mouseup", zb.left + 4, zb.top + 4);
      await sleep(120);
      const selectionAfterDrag = getSelection().toString();

      // A deliberate programmatic selection of the control's text cannot take either, which is the
      // property `user-select: none` actually guarantees.
      const range = document.createRange();
      range.selectNodeContents(zoomIn);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      const selectionOfControl = getSelection().toString();

      // …and the controls are still real controls.
      const hit = document.elementFromPoint(zb.left + zb.width / 2, zb.top + zb.height / 2);
      const hitIsZoom = !!hit && !!hit.closest(".leaflet-control-zoom-in");
      let clicked = false;
      zoomIn.addEventListener("click", () => (clicked = true));
      zoomIn.click();
      zoomIn.focus();
      const focusable = document.activeElement === zoomIn;
      const attributionHref =
        lmap.querySelector(".leaflet-control-attribution a")?.getAttribute("href") ?? null;

      // Pan mode: ordinary selection behaviour returns.
      lmap.classList.remove("drawing");
      await sleep(60);
      const panSelect = getComputedStyle(zoomIn).userSelect;
      getSelection().removeAllRanges();
      const r2 = document.createRange();
      r2.selectNodeContents(label);
      getSelection().addRange(r2);
      const panSelectable = getSelection().toString().length > 0;

      getSelection().removeAllRanges();
      lmap.remove();
      return {
        drawSelect,
        selectionAfterDrag,
        selectionOfControl,
        hitIsZoom,
        clicked,
        focusable,
        attributionHref,
        panSelect,
        panSelectable,
      };
    });

    checks.push({
      name: "map (Draw mode): a rectangle drag across the +/- controls leaves the selection EMPTY",
      pass:
        map.drawSelect === "none" && map.selectionAfterDrag === "" && map.selectionOfControl === "",
      detail: JSON.stringify({
        userSelect: map.drawSelect,
        afterDrag: map.selectionAfterDrag,
        ofControl: map.selectionOfControl,
      }),
    });
    checks.push({
      name: "map (Draw mode): the +/- controls still hit-test, click and take focus; attribution intact",
      pass:
        map.hitIsZoom === true &&
        map.clicked === true &&
        map.focusable === true &&
        map.attributionHref === "https://example.org",
      detail: JSON.stringify(map),
    });
    checks.push({
      name: "map (Pan mode): ordinary text selection works again",
      pass: map.panSelect !== "none" && map.panSelectable === true,
      detail: JSON.stringify({ panSelect: map.panSelect, selectable: map.panSelectable }),
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("overview: cross-section reorder; map: drawing does not select", result));
