/**
 * Overlays inside an embedded host, measured for real.
 *
 * The host shape is the one that breaks them: a scrolled page, a transformed AND filtered ancestor,
 * and a bounded `overflow: hidden` mount offset from the viewport - plus the component's own nested
 * result scroller. `position: fixed` resolves against a transformed ancestor rather than the
 * viewport, and anything outside the clipping box is simply not painted, so a menu that looks
 * correct on a bare page detaches from its trigger here.
 *
 * Also covers the minimized terminal's settings menu, which is pinned to the bottom of its
 * container and therefore has to open UPWARD with its colour and opacity controls still reachable.
 */
import { IMPORT_MAP, fakeApi, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>
  html,body{margin:0}
  body{height:2400px}                                   /* the page scrolls */
  .site-header{height:64px;background:#123;color:#fff}
  .shell{transform:translateZ(0);filter:saturate(1)}    /* transformed AND filtered ancestor */
  .md-content{height:calc(100vh - 64px);overflow:hidden;margin:0 40px}  /* clipped, offset mount */
  #app{height:100%}
</style></head><body>
<div class="site-header">host header</div>
<div class="shell"><div class="md-content"><div id="app"></div></div></div>
${fakeApi({
  rows: Array.from({ length: 40 }, (_, i) => ({ file: `/archive/tas_${i}.nc`, fs_type: "posix" })),
  facets: { project: ["cmip6", 20, "cordex", 20], variable: ["tas", 40] },
})}
<script type="module">
  const { mountDataBrowser } = await import("@freva-org/databrowser");
  window.__handle = mountDataBrowser(document.getElementById("app"), { syncUrl: false });
  await new Promise(r => setTimeout(r, 500));
  window.scrollTo(0, 300);                               // non-zero page scroll
  document.querySelector('.seg [aria-label="List view"]')?.click();
  await new Promise(r => setTimeout(r, 150));
  window.__ready = true;
</script></body></html>`;

const result = await inChromium(async (browser) => {
  const server = await serve(page);
  const checks = [];
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    /** Open an overlay, describe it, then scroll `scrollWhat` and report whether it survived. */
    const overlay = (openSel, scrollWhat) =>
      browser.evaluate(
        async ({ openSel, scrollWhat }) => {
          const root = document.querySelector(".freva-db");
          root.querySelector(openSel).click();
          await new Promise((r) => setTimeout(r, 80));
          const pop = root.querySelector(".pop.show");
          if (!pop) return { opened: false };
          const p = pop.getBoundingClientRect();
          const r = root.getBoundingClientRect();
          const out = {
            opened: true,
            parentIsRoot: pop.parentElement === root,
            position: getComputedStyle(pop).position,
            insideComponent:
              p.left >= r.left - 1 &&
              p.right <= r.right + 1 &&
              p.top >= r.top - 1 &&
              p.bottom <= r.bottom + 1,
            // Anchored to its trigger, not stuck at the viewport origin.
            nonZero: p.width > 0 && p.height > 0,
          };
          if (scrollWhat === "page") window.scrollBy(0, 220);
          else root.querySelector(scrollWhat).scrollTop += 220;
          await new Promise((r2) => setTimeout(r2, 120));
          out.closedOnScroll = !root.querySelector(".pop.show");
          return out;
        },
        { openSel, scrollWhat },
      );

    const cases = [
      ["row kebab", "#fdb-results .row .kebab", ".results-scroll"],
      ["Export menu", '[aria-label="Export catalogue"]', "page"],
      ["Flavour menu", ".lens", "page"],
    ];
    for (const [name, sel, scrollWhat] of cases) {
      const o = await overlay(sel, scrollWhat);
      checks.push({
        name: `${name}: opens inside the component, absolutely positioned`,
        pass:
          o.opened && o.parentIsRoot && o.position === "absolute" && o.insideComponent && o.nonZero,
        detail: JSON.stringify(o),
      });
      checks.push({
        name: `${name}: a ${scrollWhat === "page" ? "page" : "nested"} scroll leaves nothing floating`,
        pass: o.closedOnScroll === true,
        detail: `closedOnScroll=${o.closedOnScroll}`,
      });
    }

    // The terminal window is a component-scoped overlay too.
    const term = await browser.evaluate(async () => {
      document.querySelector('[aria-label="Command terminal"]').click();
      await new Promise((r) => setTimeout(r, 200));
      const root = document.querySelector(".freva-db");
      const cmd = root.querySelector(".freva-term");
      const c = cmd.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      return {
        parentIsRoot: cmd.parentElement === root,
        position: getComputedStyle(cmd).position,
        inside:
          c.left >= r.left - 1 &&
          c.right <= r.right + 1 &&
          c.top >= r.top - 1 &&
          c.bottom <= r.bottom + 1,
        box: { left: Math.round(c.left), top: Math.round(c.top), right: Math.round(c.right) },
        rootBox: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right) },
      };
    });
    checks.push({
      name: "terminal window: positioned in the component, not the viewport",
      pass: term.parentIsRoot && term.position === "absolute" && term.inside,
      detail: JSON.stringify(term),
    });

    // Minimized: the settings menu must flip ABOVE the docked bar and stay usable.
    const dock = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-db");
      const cmd = root.querySelector(".freva-term");
      cmd.querySelector(".tl.min").click();
      await new Promise((r) => setTimeout(r, 120));
      cmd.querySelector(".term-kebab").click();
      await new Promise((r) => setTimeout(r, 120));
      const menu = cmd.querySelector(".term-menu");
      const m = menu.getBoundingClientRect();
      const bar = cmd.querySelector(".term-bar").getBoundingClientRect();
      const r = root.getBoundingClientRect();
      const sw = menu.querySelector(".bg-sw").getBoundingClientRect();
      const alpha = menu.querySelector(".term-alpha").getBoundingClientRect();
      const visible = (b) =>
        b.width > 0 && b.height > 0 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1;
      // Would a click actually land on the swatch? elementFromPoint answers that, not a rect.
      const hit = document.elementFromPoint(sw.left + sw.width / 2, sw.top + sw.height / 2);
      return {
        minimized: cmd.classList.contains("minimized"),
        openedUpward: m.bottom <= bar.top + 1,
        menuInside: visible(m),
        swatchVisible: visible(sw),
        opacityVisible: visible(alpha),
        swatchClickable: !!hit && !!hit.closest(".bg-sw"),
      };
    });
    checks.push({
      name: "minimized terminal: the settings menu opens upward, inside the component",
      pass: dock.minimized && dock.openedUpward && dock.menuInside,
      detail: JSON.stringify(dock),
    });
    checks.push({
      name: "minimized terminal: colour swatches and opacity stay visible AND clickable",
      pass: dock.swatchVisible && dock.opacityVisible && dock.swatchClickable,
      detail: JSON.stringify(dock),
    });
    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("embedded host: overlays, terminal, docked settings menu", result));
