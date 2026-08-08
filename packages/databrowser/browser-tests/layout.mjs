/**
 * Layout questions that only a real engine can answer, measured on the built artifact.
 *
 *  1. Mobile chips at 320 / 375 / 390 px - long labels, Clear all visible, no overlapping boxes.
 *  2. The list header stays put while its results scroller moves.
 *  3. Overview reorder starts from a non-interactive card surface past the movement threshold,
 *     and NOT from a control, an input, or a plain click.
 *
 * Each check compares real bounding rectangles; jsdom reports every one of them as 0x0.
 */
import {
  IMPORT_MAP,
  fakeApi,
  inChromium,
  overlaps,
  report,
  requireDist,
  serve,
} from "./harness.mjs";

requireDist();

const LONG = "cmip6-highresmip-hadgem3-gc31-hm-highresSST-present-r1i1p1f1-gn-v20170831";

const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%} #app{height:100vh}</style></head><body><div id="app"></div>
${fakeApi({
  rows: Array.from({ length: 30 }, (_, i) => ({
    file: `/archive/project/model/experiment/tas_day_${i}.nc`,
    fs_type: "posix",
  })),
  facets: {
    project: [LONG, 12, "cordex", 8],
    variable: ["tas", 20, "pr", 10],
    model: ["m1", 15, "m2", 15],
  },
})}
<script type="module">
  const { mountDataBrowser } = await import("@freva-org/databrowser");
  window.__handle = mountDataBrowser(document.getElementById("app"), { syncUrl: false });
  await new Promise(r => setTimeout(r, 500));
  window.__ready = true;
</script></body></html>`;

const result = await inChromium(async (browser) => {
  const server = await serve(page);
  const checks = [];
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    // 1. Mobile chips
    // Apply two long filters, so the row has to carry more than it can fit.
    const applyTwoLongFilters = () =>
      browser.evaluate(async () => {
        const root = document.querySelector(".freva-db");
        const open = (label) =>
          [...root.querySelectorAll(".facet-head")]
            .find((h) => new RegExp(label, "i").test(h.textContent))
            ?.click();
        open("project");
        await new Promise((r) => setTimeout(r, 30));
        root.querySelector(".side-scroll .fval").click();
        await new Promise((r) => setTimeout(r, 400));
        open("variable");
        await new Promise((r) => setTimeout(r, 30));
        [...root.querySelectorAll(".side-scroll .fval-row")]
          .find((n) => n.textContent.includes("tas"))
          ?.querySelector(".fval")
          .click();
        await new Promise((r) => setTimeout(r, 400));
      });
    await applyTwoLongFilters();

    for (const width of [320, 375, 390]) {
      // Mount AT the phone width rather than resizing a desktop layout into one: the sidebar's
      // initial collapsed state is decided at mount, and a resized-down desktop layout overflows
      // horizontally for reasons that have nothing to do with the chip row.
      await browser.setViewportSize({ width, height: 780 });
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      await applyTwoLongFilters();
      const m = await browser.evaluate(() => {
        const root = document.querySelector(".freva-db");
        const box = (sel) => {
          const el = root.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width };
        };
        const chips = box(".chips");
        const clear = box(".clear-btn");
        const cluster = box(".ctrl-cluster");
        const toprow = box(".toprow");
        const labels = [...root.querySelectorAll(".chip-label")].map((el) => {
          const r = el.getBoundingClientRect();
          return { w: r.width, right: r.right, clipped: el.scrollWidth > el.clientWidth + 1 };
        });
        return { chips, clear, cluster, toprow, labels, chipCount: labels.length };
      });
      const inner = { width };
      checks.push({
        name: `@${width}px: Clear all is visible and does not overlap the chips`,
        pass: !!m.clear && m.clear.w > 0 && !!m.chips && !overlaps(m.chips, m.clear),
        detail: JSON.stringify({ chips: m.chips, clear: m.clear }),
      });
      checks.push({
        name: `@${width}px: the Browse/Overview cluster overlaps neither`,
        pass:
          !!m.cluster && !overlaps(m.chips, m.cluster) && !overlaps(m.clear ?? m.chips, m.cluster),
        detail: JSON.stringify(m.cluster),
      });
      checks.push({
        name: `@${width}px: chips take their own full-width row above the controls`,
        pass: !!m.chips && !!m.cluster && m.chips.bottom <= m.cluster.top + 0.5,
        detail: `chips.bottom=${m.chips?.bottom} cluster.top=${m.cluster?.top}`,
      });
      checks.push({
        name: `@${width}px: no chip label overflows the viewport`,
        pass: m.labels.length > 0 && m.labels.every((l) => l.right <= width + 0.5),
        detail: JSON.stringify(m.labels.map((l) => Math.round(l.right))),
      });
      checks.push({
        name: `@${width}px: the long label is clipped rather than stretching its chip`,
        pass: m.labels.some((l) => l.clipped),
        detail: `${m.chipCount} chips, clipped=${m.labels.filter((l) => l.clipped).length}`,
      });
      void inner;
    }
    // Back to a desktop viewport, freshly mounted, for the remaining checks.
    await browser.setViewportSize({ width: 1280, height: 820 });
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    // 2. The mode cluster is right-aligned regardless of the chip row
    // The cluster belongs on the right whether or not `.chips` has content to push it there.
    const clusterAt = async (width) => {
      await browser.setViewportSize({ width, height: 820 });
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      const empty = await browser.evaluate(() => {
        const root = document.querySelector(".freva-db");
        const b = (s) => {
          const n = root.querySelector(s);
          if (!n) return null;
          const r = n.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width };
        };
        return {
          chips: root.querySelectorAll(".chips .chip").length,
          cluster: b(".ctrl-cluster"),
          row: b(".toprow"),
        };
      });
      await applyTwoLongFilters();
      const filled = await browser.evaluate(() => {
        const root = document.querySelector(".freva-db");
        const b = (s) => {
          const n = root.querySelector(s);
          if (!n) return null;
          const r = n.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width };
        };
        return {
          chips: root.querySelectorAll(".chips .chip").length,
          cluster: b(".ctrl-cluster"),
          row: b(".toprow"),
          clear: b(".clear-btn"),
          chipsBox: b(".chips"),
        };
      });
      return { empty, filled };
    };

    for (const width of [1280, 390, 375, 320]) {
      const m = await clusterAt(width);
      const flush = (c, row) => !!c && !!row && Math.abs(c.right - row.right) <= 1.5;
      checks.push({
        name: `@${width}px: the mode switch is right-aligned with NO chips`,
        pass: m.empty.chips === 0 && flush(m.empty.cluster, m.empty.row),
        detail: JSON.stringify(m.empty),
      });
      checks.push({
        name: `@${width}px: …and still right-aligned once chips appear`,
        pass: m.filled.chips > 0 && flush(m.filled.cluster, m.filled.row),
        detail: JSON.stringify(m.filled),
      });
      if (width < 430) {
        checks.push({
          name: `@${width}px: the cluster overlaps neither Clear all nor the chips`,
          pass:
            !!m.filled.cluster &&
            !overlaps(m.filled.cluster, m.filled.chipsBox) &&
            (!m.filled.clear || !overlaps(m.filled.cluster, m.filled.clear)),
          detail: JSON.stringify({
            cluster: m.filled.cluster,
            clear: m.filled.clear,
            chips: m.filled.chipsBox,
          }),
        });
      }
    }

    // Back to a desktop viewport, freshly mounted, for the remaining checks.
    await browser.setViewportSize({ width: 1280, height: 820 });
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    // 3. Sticky list header
    const sticky = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-db");
      root.querySelector('.seg [aria-label="List view"]')?.click();
      await new Promise((r) => setTimeout(r, 120));
      const scroller = root.querySelector(".results-scroll");
      const head = root.querySelector(".list-head");
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const scrollerTop = () => scroller.getBoundingClientRect().top;
      const gap = () => head.getBoundingClientRect().top - scrollerTop();

      const before = head.getBoundingClientRect().top;
      const firstRowBefore = root.querySelector("#fdb-results .row").getBoundingClientRect().top;
      const gapInitial = gap();

      scroller.scrollTop = 300;
      await frame();
      const after = head.getBoundingClientRect().top;
      const firstRowAfter = root.querySelector("#fdb-results .row").getBoundingClientRect().top;
      const gapScrolled = gap();

      // The real question is not "roughly at the top" but "is any ROW visible above the header?".
      // Sample the band between the scrollport edge and the header, and ask the engine what is
      // actually painted there - and what a click in the header itself would hit.
      const hb = head.getBoundingClientRect();
      const sb = scroller.getBoundingClientRect();
      const bandHits = [];
      for (let y = Math.ceil(sb.top) + 1; y < Math.floor(hb.top); y++) {
        const el = document.elementFromPoint(hb.left + hb.width / 2, y);
        if (el && el.closest("#fdb-results .row")) bandHits.push(y);
      }
      const inHeader = document.elementFromPoint(hb.left + hb.width / 2, hb.top + hb.height / 2);
      const style = getComputedStyle(head);

      // The CORNERS. A rounded corner is not a painted corner: it is a hole in the box, and a row
      // sliding underneath shows through the two curved wedges at the top left and top right.
      // Sweep an 8x8 patch inside each upper corner and ask what is actually there.
      const cornerScan = () => {
        const b = head.getBoundingClientRect();
        const out = { left: 0, right: 0, radius: getComputedStyle(head).borderTopLeftRadius };
        for (let dx = 0; dx < 8; dx++) {
          for (let dy = 0; dy < 8; dy++) {
            const l = document.elementFromPoint(b.left + dx + 0.5, b.top + dy + 0.5);
            const r = document.elementFromPoint(b.right - dx - 0.5, b.top + dy + 0.5);
            if (l && l.closest("#fdb-results .row")) out.left++;
            if (r && r.closest("#fdb-results .row")) out.right++;
          }
        }
        return out;
      };
      scroller.scrollTop = 0;
      await frame();
      const cornersInitial = cornerScan();
      scroller.scrollTop = 300;
      await frame();
      const cornersScrolled = cornerScan();

      // The header's two columns must still line up with the row cells they label.
      const lhUri = head.querySelector(".lh-uri").getBoundingClientRect();
      const lhFs = head.querySelector(".lh-fs").getBoundingClientRect();

      return {
        headMoved: Math.abs(after - before),
        rowsMoved: Math.abs(firstRowAfter - firstRowBefore),
        gapInitial,
        gapScrolled,
        bandRowPixels: bandHits.length,
        headerHitIsHeader: !!inHeader && (inHeader === head || head.contains(inHeader)),
        position: style.position,
        opaque: style.backgroundColor !== "rgba(0, 0, 0, 0)",
        cornersInitial,
        cornersScrolled,
        uriLeftOfFs: lhUri.left < lhFs.left && lhUri.right <= lhFs.right,
      };
    });
    checks.push({
      name: "list header: the rows scroll but the header does not",
      pass: sticky.rowsMoved > 100 && sticky.headMoved <= 1,
      detail: JSON.stringify(sticky),
    });
    checks.push({
      name: "list header: FLUSH with the scrollport top - initially and after scrolling",
      pass: Math.abs(sticky.gapInitial) <= 1 && Math.abs(sticky.gapScrolled) <= 1,
      detail: JSON.stringify({ initial: sticky.gapInitial, scrolled: sticky.gapScrolled }),
    });
    checks.push({
      name: "list header: NO row pixel is painted above it, and a click in it hits the header",
      pass: sticky.bandRowPixels === 0 && sticky.headerHitIsHeader,
      detail: JSON.stringify(sticky),
    });
    checks.push({
      name: "list header: sticky and fully opaque",
      pass: sticky.position === "sticky" && sticky.opaque,
      detail: JSON.stringify(sticky),
    });
    checks.push({
      name: "list header: no row shows through either UPPER CORNER, before or after scrolling",
      pass:
        sticky.cornersInitial.left === 0 &&
        sticky.cornersInitial.right === 0 &&
        sticky.cornersScrolled.left === 0 &&
        sticky.cornersScrolled.right === 0,
      detail: JSON.stringify({
        initial: sticky.cornersInitial,
        scrolled: sticky.cornersScrolled,
      }),
    });
    checks.push({
      name: "list header: URI and FS TYPE still line up after the corner fix",
      pass: sticky.uriLeftOfFs === true,
      detail: JSON.stringify({ uriLeftOfFs: sticky.uriLeftOfFs }),
    });

    // …and the same holds when the user arrives from Overview by scrolling down into the list.
    const fromOverview = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-db");
      root.querySelector('.ctrl[aria-label="Overview"]')?.click();
      await new Promise((r) => setTimeout(r, 250));
      const scroller = root.querySelector(".results-scroll");
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const head = root.querySelector(".list-head");
      if (!head || head.hidden) return { skipped: true };
      const hb = head.getBoundingClientRect();
      const sb = scroller.getBoundingClientRect();
      let rowPixels = 0;
      for (let y = Math.ceil(sb.top) + 1; y < Math.floor(hb.top); y++) {
        const el = document.elementFromPoint(hb.left + hb.width / 2, y);
        if (el && el.closest("#fdb-results .row")) rowPixels++;
      }
      return { skipped: false, gap: hb.top - sb.top, rowPixels };
    });
    checks.push({
      name: "list header: scrolling down from Overview into the file list keeps it clean",
      pass:
        fromOverview.skipped || (Math.abs(fromOverview.gap) <= 1 && fromOverview.rowPixels === 0),
      detail: JSON.stringify(fromOverview),
    });

    // 4. Overview drag from the card surface
    const drag = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-db");
      root.querySelector('.ctrl[aria-label="Overview"]').click();
      await new Promise((r) => setTimeout(r, 300));
      const order = () =>
        [...root.querySelectorAll(".fcard[data-key]")]
          .map((c) => c.dataset.key)
          .filter((k) => !k.startsWith("__"));
      const cards = [...root.querySelectorAll(".fcard[data-key]")].filter(
        (c) => !c.dataset.key.startsWith("__"),
      );
      if (cards.length < 2) return { error: `only ${cards.length} reorderable cards` };
      const first = cards[0];
      const second = cards[1];
      const before = order();

      const pointer = (el, type, x, y, extra = {}) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            pointerId: 1,
            button: 0,
            isPrimary: true,
            ...extra,
          }),
        );

      // (a) a plain click on the card BODY must not reorder, and must still collapse.
      const body = first.querySelector(".fcard-vals") ?? first;
      const b = body.getBoundingClientRect();
      pointer(body, "pointerdown", b.left + 10, b.top + 6);
      pointer(window, "pointerup", b.left + 10, b.top + 6);
      const afterClick = order();

      // (b) a press-and-move on the HEADER (non-interactive area) past the threshold reorders.
      const head = first.querySelector(".fcard-h");
      const h = head.getBoundingClientRect();
      const target = second.getBoundingClientRect();
      pointer(head, "pointerdown", h.left + 60, h.top + 10);
      pointer(window, "pointermove", h.left + 62, h.top + 10); // under the 5px threshold
      const afterTiny = order();
      pointer(window, "pointermove", target.left + target.width * 0.8, target.top + 10);
      pointer(window, "pointerup", target.left + target.width * 0.8, target.top + 10);
      await new Promise((r) => setTimeout(r, 200));
      const afterDrag = order();

      // (c) a press-and-move starting on an INPUT must never reorder.
      const cards2 = [...root.querySelectorAll(".fcard[data-key]")].filter(
        (c) => !c.dataset.key.startsWith("__"),
      );
      const input = cards2[0].querySelector("input.within");
      const beforeInput = order();
      let afterInput = beforeInput;
      if (input) {
        const ir = input.getBoundingClientRect();
        pointer(input, "pointerdown", ir.left + 5, ir.top + 5);
        pointer(window, "pointermove", ir.left + 300, ir.top + 5);
        pointer(window, "pointerup", ir.left + 300, ir.top + 5);
        await new Promise((r) => setTimeout(r, 150));
        afterInput = order();
      }
      return {
        before,
        afterClick,
        afterTiny,
        afterDrag,
        beforeInput,
        afterInput,
        hadInput: !!input,
      };
    });

    if (drag.error) {
      checks.push({ name: "overview drag", pass: false, detail: drag.error });
    } else {
      checks.push({
        name: "overview: a plain click on the card body does NOT reorder",
        pass: JSON.stringify(drag.before) === JSON.stringify(drag.afterClick),
        detail: `${drag.before} -> ${drag.afterClick}`,
      });
      checks.push({
        name: "overview: movement under the threshold does NOT reorder",
        pass: JSON.stringify(drag.afterClick) === JSON.stringify(drag.afterTiny),
        detail: `${drag.afterTiny}`,
      });
      checks.push({
        name: "overview: a drag from a non-interactive card surface DOES reorder",
        pass: JSON.stringify(drag.afterTiny) !== JSON.stringify(drag.afterDrag),
        detail: `${drag.afterTiny} -> ${drag.afterDrag}`,
      });
      checks.push({
        name: "overview: a drag starting on the filter INPUT never reorders",
        pass: drag.hadInput && JSON.stringify(drag.beforeInput) === JSON.stringify(drag.afterInput),
        detail: drag.hadInput ? `${drag.afterInput}` : "no input on the card",
      });
    }
    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("layout: mobile chips, sticky header, card-surface drag", result));
