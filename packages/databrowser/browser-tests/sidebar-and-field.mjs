/**
 * The browse rail's controls, the search field's box, and the comparison modal's theming.
 *
 * All four need a real engine. `position: sticky` does not exist in jsdom, so whether the Filter
 * head actually stays put while the rail scrolls can only be answered by scrolling one. Neither
 * does CSS animation, which is what carries the field's live edge. And the modal check guards a
 * silent failure mode: the comparison has to stay inside `.freva-db`, because outside it every
 * `var(--…)` in the table stops resolving - an invalid `var()` invalidates the whole declaration,
 * so `border-bottom: 1px solid var(--border)` becomes no border at all and the table renders as a
 * flat field with no row rules. Nothing throws, so only an assertion that reads a COMPUTED colour
 * back can catch it.
 */
import { IMPORT_MAP, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

const FACETS = {
  project: ["waterpark", 240, "cmip6", 180, "cordex", 90, "era5", 30],
  model: ["mpi-esm", 210, "icon", 160, "ec-earth", 95, "access", 12],
  variable: ["tas", 300, "pr", 140, "psl", 60, "uas", 25],
  experiment: ["historical", 260, "ssp585", 150],
  realm: ["atmos", 400, "ocean", 120],
  fs_type: ["posix", 600, "swift", 40],
};

const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>
 html,body{margin:0;height:100%;font-family:system-ui,sans-serif}
 /* A host header and footer that a modal must clear, at a z-index no widget would guess. */
 header{position:sticky;top:0;z-index:5000;background:#123;color:#fff;padding:10px}
 footer{position:fixed;left:0;right:0;bottom:0;z-index:5000;background:#123;color:#fff;padding:10px}
 /* The trap the real portal sets, and the reason a z-index alone was never going to be enough:
    a transformed, contained region. \`position: fixed\` inside one of these is positioned AND
    clipped against the REGION, not the viewport - so a tall modal slides under the page chrome
    however large its z-index is. Only the top layer gets out. */
 #host{transform:translateZ(0);contain:paint;overflow:hidden;height:78vh}
 #app{height:100%}
</style></head>
<body><header>host header</header><div id="host"><div id="app"></div></div><footer>host footer</footer>
<script>
  /* This suite's own backend rather than the shared fakeApi helper, because the comparison needs the
     rows to DIFFER: a per-file (?file=) response carries that file's own time and bbox, which is
     what gives the diff varying columns and therefore an Enlarge control to open. */
  const FACETS = ${JSON.stringify(FACETS)};
  const ROWS = Array.from({ length: 20 }, (_, i) => ({ file: "/archive/tas_" + i + ".nc", fs_type: "posix" }));
  const json = (b) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/overview")) return json({ flavours: ["freva"], attributes: { freva: Object.keys(FACETS) } });
    const m = u.match(/file=([^&]+)/);
    if (m) {
      const f = decodeURIComponent(m[1]);
      const i = Math.max(0, ROWS.findIndex((r) => r.file === f));
      const y = 1980 + i, lat = 30 + (i % 4) * 5;
      return json({ total_count: 1, facets: { model: [i % 2 ? "icon" : "mpi-esm", 1] },
        primary_facets: Object.keys(FACETS), facet_mapping: {},
        search_results: [{ file: f, time: "[" + y + "-01-01T00:00:00 TO " + y + "-12-31T23:59:59]",
          bbox: "ENVELOPE(-10, 40, " + (lat + 20) + ", " + lat + ")" }] });
    }
    return json({ total_count: 640, facets: FACETS, primary_facets: Object.keys(FACETS),
      facet_mapping: {}, search_results: ROWS });
  };
</script>
<script type="module">
  const { mountDataBrowser } = await import("@freva-org/databrowser");
  window.__h = mountDataBrowser(document.getElementById("app"), { syncUrl: false });
  await new Promise(r => setTimeout(r, 700));
  window.__ready = true;
</script></body></html>`;

const result = await inChromium(
  async (browser) => {
    const server = await serve(page);
    const checks = [];
    try {
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

      // 1. The search field's container IS the input's box.
      //
      // It stopped being one when a `position: relative` was applied to `.search .ic` for a
      // z-index: the icon left the absolute flow, became a full-width block above the input, and
      // the container grew past the field it is supposed to trace - taking the icon out of the
      // field and any border decoration with it. Comparing the two boxes catches every version of
      // that, which reading the icon's `position` alone would not.
      const field = await browser.evaluate(() => {
        const r = (n) =>
          n
            ? [
                ...["x", "y", "width", "height"].map(
                  (k) => +n.getBoundingClientRect()[k].toFixed(1),
                ),
              ]
            : null;
        const box = document.querySelector(".freva-db .search");
        const input = box?.querySelector("input");
        const icon = box?.querySelector(".ic");
        return {
          box: r(box),
          input: r(input),
          icon: r(icon),
          iconPos: icon ? getComputedStyle(icon).position : null,
          placeholder: input?.placeholder ?? null,
        };
      });
      const sameBox =
        field.box && field.input && field.box.every((v, i) => Math.abs(v - field.input[i]) < 0.5);
      checks.push({
        name: "the search container is exactly the input's box",
        pass: !!sameBox,
        detail: `container ${JSON.stringify(field.box)} vs input ${JSON.stringify(field.input)}`,
      });
      const iconInside =
        field.icon &&
        field.input &&
        field.icon[1] > field.input[1] &&
        field.icon[1] + field.icon[3] < field.input[1] + field.input[3];
      checks.push({
        name: "…so the magnifier sits INSIDE the field, still absolutely placed",
        pass: !!iconInside && field.iconPos === "absolute",
        detail: `position ${field.iconPos}, icon ${JSON.stringify(field.icon)}`,
      });
      checks.push({
        name: "the placeholder is one sentence with a rotating example, not a bare value",
        pass: /^Search values – e\.g\. /.test(field.placeholder ?? ""),
        detail: JSON.stringify(field.placeholder),
      });

      // 2. The live edge.
      //
      //    Deliberately NOT an element. There is no object in this treatment - that is the whole
      //    point of it, and the reason the thing it replaced was unbearable: a small high-contrast
      //    shape crossing the border is something the eye locks onto and TRACKS. So there is no
      //    position to sample here. What can be asserted is that the light is real and moving on
      //    its own (opacity AND background-position both change), that the two cycles do not divide
      //    into each other - a rhythm that repeats exactly is one a reader learns and starts to
      //    anticipate, which is how a slow loop becomes a tic - and that using the field stops it.
      const edge = await browser.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const box = document.querySelector(".freva-db .search");
        const read = () => {
          const c = getComputedStyle(box, "::before");
          return {
            o: parseFloat(c.opacity),
            p: c.backgroundPosition,
            run: c.animationName,
            dur: c.animationDuration,
            masked: c.maskComposite || c.webkitMaskComposite,
          };
        };
        const a = read();
        await sleep(1300);
        const b = read();
        await sleep(1300);
        const c = read();
        box.querySelector("input").focus();
        await sleep(250);
        const focused = read();
        box.querySelector("input").blur();
        await sleep(50);
        return {
          a,
          c,
          focused,
          breathing: a.o !== b.o || b.o !== c.o,
          drifting: a.p !== b.p || b.p !== c.p,
        };
      });
      const durs = (edge.a.dur ?? "").split(",").map((d) => parseFloat(d));
      const ratio = durs.length === 2 ? durs[0] / durs[1] : 0;
      checks.push({
        name: "the edge is a moving wash of light, not a moving object",
        pass: edge.breathing && edge.drifting && /exclude|xor/.test(edge.a.masked ?? ""),
        detail: `opacity ${edge.a.o} -> ${edge.c.o}, position ${edge.a.p} -> ${edge.c.p}`,
      });
      checks.push({
        name: "…whose two cycles never fall into a beat you could anticipate",
        pass:
          durs.length === 2 &&
          durs.every((d) => d > 5) &&
          Math.abs(ratio - Math.round(ratio)) > 0.05,
        detail: `durations ${edge.a.dur} (ratio ${ratio.toFixed(2)})`,
      });
      checks.push({
        name: "…and it settles the moment somebody is typing in the field",
        // Not "paused" - a paused animation still pins the property to a keyframe, which left the
        // focus ring at whatever brightness the breath was passing through when you clicked.
        pass: edge.focused.run === "none" && edge.focused.o === 1,
        detail: `animation ${edge.focused.run}, opacity ${edge.focused.o}`,
      });

      // 3. The rail: a per-facet sort that appears with the panel, and a Filter head that stays.
      const rail = await browser.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.querySelector(".freva-db");
        // Nothing to sort yet, so nothing built: a rail of closed facets costs headers only.
        const sortBeforeOpen = root.querySelectorAll(".facet .fh-sort").length;
        for (const h of root.querySelectorAll(".facet-head")) h.click();
        await sleep(600);
        const openSort = getComputedStyle(root.querySelector(".facet.open .fh-sort")).display;
        // Closing keeps the node (re-opening must stay a class toggle) but hides it.
        const first = root.querySelector(".facet");
        first.querySelector(".facet-head").click();
        await sleep(200);
        const closedSort = getComputedStyle(first.querySelector(".fh-sort")).display;
        first.querySelector(".facet-head").click();
        await sleep(200);
        const vals = (k) =>
          [...root.querySelectorAll(`.facet[data-key="${k}"] .fval .nm`)].map((n) =>
            n.textContent.trim(),
          );
        const before = vals("model");
        const btn = root.querySelector('.facet[data-key="model"] .fh-sort');
        const beforeLabel = btn.textContent.trim();
        btn.click();
        await sleep(250);
        const after = vals("model");
        const afterLabel = root
          .querySelector('.facet[data-key="model"] .fh-sort')
          .textContent.trim();
        const stillOpen = !!root.querySelector('.facet[data-key="model"].open');
        // Selecting something brings out both clear-all affordances.
        root.querySelector(".fval").click();
        await sleep(500);
        const clear = root.querySelector(".sf-clear");
        const badge = root.querySelector(".sf-badge");
        const scroller = root.querySelector(".side-scroll");
        const head = root.querySelector(".side-filterhead");
        const railTop = scroller.getBoundingClientRect().top;
        scroller.scrollTop = 400;
        await sleep(120);
        const headBox = head.getBoundingClientRect();
        return {
          sortBeforeOpen,
          closedSort,
          openSort,
          before,
          after,
          beforeLabel,
          afterLabel,
          stillOpen,
          hasClear: !!clear,
          clearText: clear?.textContent.trim() ?? null,
          hasBadge: !!badge,
          railTop: +railTop.toFixed(1),
          headTop: +headBox.top.toFixed(1),
          headBottom: +headBox.bottom.toFixed(1),
          scrolled: scroller.scrollTop,
          firstFacetTop: +root.querySelector(".facet").getBoundingClientRect().top.toFixed(1),
          headBg: getComputedStyle(head).backgroundColor,
        };
      });
      checks.push({
        name: "the sort control appears with the panel, not before it",
        pass: rail.sortBeforeOpen === 0 && rail.openSort !== "none" && rail.closedSort === "none",
        detail: `built before any open: ${rail.sortBeforeOpen}; open ${rail.openSort}; closed again ${rail.closedSort}`,
      });
      const sortedAlpha = rail.after.join() === [...rail.after].sort().join();
      checks.push({
        name: "…and it actually reorders that list, in place, panel still open",
        pass:
          rail.before.join() !== rail.after.join() &&
          sortedAlpha &&
          rail.stillOpen &&
          rail.beforeLabel !== rail.afterLabel,
        detail: `${JSON.stringify(rail.before)} -> ${JSON.stringify(rail.after)} (${rail.beforeLabel} -> ${rail.afterLabel})`,
      });
      checks.push({
        name: "clear-all is offered in words as well as by the badge's hover cross",
        pass: rail.hasClear && rail.hasBadge && /clear all/i.test(rail.clearText ?? ""),
        detail: `${rail.clearText} + badge ${rail.hasBadge}`,
      });
      checks.push({
        name: "the Filter head stays pinned to the top of the rail while it scrolls",
        pass: Math.abs(rail.headTop - rail.railTop) < 1.5 && rail.scrolled > 0,
        detail: `rail ${rail.railTop}, head ${rail.headTop}, scrolled ${rail.scrolled}px`,
      });
      checks.push({
        name: "…and it is opaque, so the list passes under it rather than through it",
        pass:
          rail.firstFacetTop < rail.headBottom &&
          !/rgba\(0, 0, 0, 0\)|transparent/.test(rail.headBg),
        detail: `head bottom ${rail.headBottom}, first facet ${rail.firstFacetTop}, bg ${rail.headBg}`,
      });

      // 4. The comparison modal: above the host's chrome AND inside the themed subtree.
      const modal = await browser.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.querySelector(".freva-db");
        root.querySelector(".selall").click();
        await sleep(200);
        root.querySelector('[aria-label="Details panel"]').click();
        await sleep(1600);
        const enlarge = root.querySelector(".diff-enlarge");
        if (!enlarge) return { error: "no Enlarge control" };
        enlarge.click();
        await sleep(300);
        const backdrop = document.querySelector(".dmm-backdrop");
        const td = document.querySelector(".dmm-body .dmatrix tbody td");
        const cs = td ? getComputedStyle(td) : null;
        const hdr = document.querySelector("header").getBoundingClientRect();
        const ftr = document.querySelector("footer").getBoundingClientRect();
        const overHeader = document.elementFromPoint(
          Math.round(hdr.left + 40),
          Math.round(hdr.top + 6),
        );
        const overFooter = document.elementFromPoint(
          Math.round(ftr.left + 40),
          Math.round(ftr.top + 6),
        );
        const bb = backdrop?.getBoundingClientRect();
        return {
          themed: !!backdrop?.closest(".freva-db"),
          tag: backdrop?.tagName ?? null,
          topLayer: backdrop?.matches(":modal") ?? false,
          rowRule: cs
            ? `${cs.borderBottomWidth} ${cs.borderBottomStyle} ${cs.borderBottomColor}`
            : null,
          // Sized against the VIEWPORT, not the 78vh transformed region it lives inside.
          fillsViewport: bb
            ? Math.abs(bb.height - window.innerHeight) < 2 && Math.abs(bb.top) < 2
            : false,
          hostHeight: Math.round(document.getElementById("host").getBoundingClientRect().height),
          backdropHeight: bb ? Math.round(bb.height) : null,
          viewport: window.innerHeight,
          aboveHeader: !document.querySelector("header").contains(overHeader),
          aboveFooter: !document.querySelector("footer").contains(overFooter),
        };
      });
      const ruled =
        modal.rowRule &&
        !/^0px|none/.test(modal.rowRule) &&
        !/rgba\(0, 0, 0, 0\)/.test(modal.rowRule);
      checks.push({
        name: "the comparison keeps the widget's theme, so its row rules resolve",
        pass: !!modal.themed && !!ruled,
        detail: `themed ${modal.themed}, row rule ${modal.rowRule}`,
      });
      checks.push({
        name: "…and escapes a transformed, contained host region via the top layer",
        pass: modal.tag === "DIALOG" && modal.topLayer === true && modal.fillsViewport === true,
        detail: `<${modal.tag}> :modal=${modal.topLayer}, ${modal.backdropHeight}px tall in a ${modal.hostHeight}px region, viewport ${modal.viewport}`,
      });
      checks.push({
        name: "…so it layers above the host's own header and footer",
        pass: !!modal.aboveHeader && !!modal.aboveFooter,
        detail: JSON.stringify({ h: modal.aboveHeader, f: modal.aboveFooter }),
      });

      return checks;
    } finally {
      await server.close();
    }
  },
  { viewport: { width: 1280, height: 760 } },
);

process.exit(report("browse rail, search field and the comparison modal", result));
