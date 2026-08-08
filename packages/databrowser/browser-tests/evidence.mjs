/**
 * Before / after evidence, measured in the same browser, in one run.
 *
 * A screenshot proves a defect exists; it does not prove which line causes it. So for each of the
 * three visual behaviours this file measures the page TWICE: once with the defective declarations
 * injected on top - those exact rules, nothing else - and once as shipped. Both numbers come from
 * the same page, the same layout engine and the same measurement code, so the difference between
 * them is attributable to those declarations and to nothing else.
 *
 * This is evidence, not a gate: it prints a table and always exits 0. The assertions that must hold
 * live in layout.mjs, export-menu.mjs and picker-compact.mjs.
 */
import { IMPORT_MAP, fakeApi, inChromium, requireDist, serve } from "./harness.mjs";

requireDist();

const rows = Array.from({ length: 40 }, (_, i) => ({
  file: `/archive/cmip6/project/model/tas_day_gn_${i}.nc`,
  fs_type: "posix",
}));

const dbPage = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%}#app{height:100vh;width:1280px}</style></head>
<body><div id="app"></div>
${fakeApi({ rows, facets: { project: ["cmip6", 120] }, total: 120 })}
<script type="module">
  const { mountDataBrowser } = await import("@freva-org/databrowser");
  window.__h = mountDataBrowser(document.getElementById("app"), { syncUrl: false });
  await new Promise(r => setTimeout(r, 500));
  document.querySelector('.seg [aria-label="List view"]')?.click();
  await new Promise(r => setTimeout(r, 200));
  window.__ready = true;
</script></body></html>`;

const pickerPage = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%}
  /* A SHORT embedded container - the case where a footer that is not bounded escapes. */
  #host{width:360px;height:300px;border:1px solid #ccc}</style></head>
<body><div id="host"></div>
${fakeApi({ rows, facets: { project: ["cmip6", 120] }, total: 120 })}
<script type="module">
  const { mountDataPicker } = await import("@freva-org/databrowser/picker");
  window.__h = mountDataPicker(document.getElementById("host"), { commitLabel: "Add to experiment" });
  await new Promise(r => setTimeout(r, 500));
  window.__ready = true;
</script></body></html>`;

/** The declarations that, injected over the shipped stylesheet, reproduce each defect. */
const PRE_FIX = {
  sticky: `.freva-db .results-scroll { padding-top: 12px !important; }
           .freva-db .results-scroll > .overview-mode,
           .freva-db .results-scroll > .list-head[hidden] + .rows { margin-top: 0 !important; }`,
  cluster: `.freva-db .ctrl-cluster { margin-left: 0 !important; }`,
  // The sticky header must drop the rounded top corners it has at rest, or a row sliding
  // underneath shows through the two curved wedges.
  corners: `.freva-db .results-scroll .list-head {
              border-top-left-radius: var(--r) !important;
              border-top-right-radius: var(--r) !important; }`,
  exportMenu: `.freva-db .xm-text { display: block !important; }
               .freva-db .xm-label { font-size: 11px !important; font-weight: 400 !important; }
               .freva-db .xm-desc  { display: inline !important; }`,
  // The body row must be `minmax(0, 1fr)` rather than `auto`, and the root and the panels must
  // bound themselves - otherwise the file list sizes to its content and pushes the footer out.
  pickerFoot: `.freva-picker { overflow: visible !important; height: auto !important;
                 grid-template-rows: auto auto auto auto auto !important; }
               .freva-picker .fp-body, .freva-picker .fp-files, .freva-picker .fp-scroll {
                 min-height: auto !important; max-height: none !important; overflow: visible !important; }`,
};

/** Swap the injected rules; `""` restores the shipped stylesheet exactly. */
const setPreOn = (browser) => async (css) => {
  await browser.evaluate((c) => {
    let s = document.getElementById("__pre");
    if (!s) {
      s = document.createElement("style");
      s.id = "__pre";
      document.head.appendChild(s);
    }
    s.textContent = c;
  }, css);
  await new Promise((r) => setTimeout(r, 150));
};

const rowsFmt = (label, before, after) => ({ measurement: label, before, after });

/** Collected outside the run: `inChromium` returns a pass/fail envelope, not the payload. */
const findings = [];

const outcome = await inChromium(async (browser) => {
  // Databrowser: sticky header, control cluster, export menu
  {
    const server = await serve(dbPage);
    try {
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

      const setPre = setPreOn(browser);

      // Sticky header: the gap above it, and whether row text lives in that gap
      const STICKY = async () => {
        const root = document.querySelector(".freva-db");
        const sc = root.querySelector(".results-scroll");
        const head = root.querySelector(".list-head");
        sc.scrollTop = 260;
        await new Promise((r) => setTimeout(r, 120));
        const sb = sc.getBoundingClientRect();
        const hb = head.getBoundingClientRect();
        const gap = Math.round((hb.top - sb.top) * 100) / 100;
        // Walk every pixel row of the band above the pinned header and ask the browser what is
        // painted there. Anything belonging to a file row is the symptom.
        let bandRowPixels = 0;
        for (let y = Math.ceil(sb.top) + 1; y < Math.floor(hb.top); y++) {
          const at = document.elementFromPoint(Math.round(sb.left + sb.width / 2), y);
          if (at && at.closest(".row")) bandRowPixels++;
        }
        const mid = document.elementFromPoint(
          Math.round(hb.left + hb.width / 2),
          Math.round(hb.top + hb.height / 2),
        );
        return { gap, bandRowPixels, headerHitIsHeader: !!(mid && mid.closest(".list-head")) };
      };

      await setPre(PRE_FIX.sticky);
      const stickyBefore = await browser.evaluate(STICKY);
      await setPre("");
      const stickyAfter = await browser.evaluate(STICKY);
      findings.push({
        area: "sticky URI / FS TYPE header",
        measurements: [
          rowsFmt("gap between scrollport top and header (px)", stickyBefore.gap, stickyAfter.gap),
          rowsFmt(
            "pixel rows of that gap painted by file rows",
            stickyBefore.bandRowPixels,
            stickyAfter.bandRowPixels,
          ),
          rowsFmt(
            "elementFromPoint inside the header resolves to the header",
            stickyBefore.headerHitIsHeader,
            stickyAfter.headerHitIsHeader,
          ),
        ],
      });

      // The header's two upper corners
      const CORNERS = async () => {
        const root = document.querySelector(".freva-db");
        const sc = root.querySelector(".results-scroll");
        const head = root.querySelector(".list-head");
        sc.scrollTop = 260;
        await new Promise((r) => setTimeout(r, 150));
        const b = head.getBoundingClientRect();
        let left = 0;
        let right = 0;
        for (let dx = 0; dx < 8; dx++) {
          for (let dy = 0; dy < 8; dy++) {
            const l = document.elementFromPoint(b.left + dx + 0.5, b.top + dy + 0.5);
            const r = document.elementFromPoint(b.right - dx - 0.5, b.top + dy + 0.5);
            if (l && l.closest(".row")) left++;
            if (r && r.closest(".row")) right++;
          }
        }
        return { radius: getComputedStyle(head).borderTopLeftRadius, left, right };
      };
      await setPre(PRE_FIX.corners);
      const cornersBefore = await browser.evaluate(CORNERS);
      await setPre("");
      const cornersAfter = await browser.evaluate(CORNERS);
      findings.push({
        area: "sticky header, upper corners (8x8 patch in each, scrolled)",
        measurements: [
          rowsFmt("border-top-*-radius", cornersBefore.radius, cornersAfter.radius),
          rowsFmt("top-left pixels resolving to a file row", cornersBefore.left, cornersAfter.left),
          rowsFmt(
            "top-right pixels resolving to a file row",
            cornersBefore.right,
            cornersAfter.right,
          ),
        ],
      });

      // Control cluster: distance from the right edge with NO chips
      const CLUSTER = () => {
        const root = document.querySelector(".freva-db");
        const top = root.querySelector(".toprow");
        const cl = root.querySelector(".ctrl-cluster");
        const chips = root.querySelectorAll(".chips .chip").length;
        return {
          chips,
          rightGap:
            Math.round(
              (top.getBoundingClientRect().right - cl.getBoundingClientRect().right) * 100,
            ) / 100,
        };
      };
      await setPre(PRE_FIX.cluster);
      const clusterBefore = await browser.evaluate(CLUSTER);
      await setPre("");
      const clusterAfter = await browser.evaluate(CLUSTER);
      findings.push({
        area: "Browse / Overview switch, no chips present",
        measurements: [
          rowsFmt(
            "distance from the top row's right edge (px)",
            clusterBefore.rightGap,
            clusterAfter.rightGap,
          ),
        ],
      });

      // Export menu: are label and description on separate lines?
      const EXPORT = async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
        document.querySelector('[aria-label^="Export catalogue"]').click();
        await new Promise((r) => setTimeout(r, 180));
        const pop = document.querySelector(".freva-db .export-pop");
        const it = pop.querySelector(".xm-item");
        const lb = it.querySelector(".xm-label").getBoundingClientRect();
        const db = it.querySelector(".xm-desc").getBoundingClientRect();
        const cs = getComputedStyle(it.querySelector(".xm-label"));
        const dcs = getComputedStyle(it.querySelector(".xm-desc"));
        const r = {
          stacked: db.top >= lb.bottom - 1,
          labelPx: parseFloat(cs.fontSize),
          descPx: parseFloat(dcs.fontSize),
          labelWeight: Number(cs.fontWeight),
          // textContent is identical either way - the difference is geometric, so measure it:
          // a negative value means the description is painted ON the label's line.
          descTopMinusLabelBottom: Math.round((db.top - lb.bottom) * 100) / 100,
          // …and how tall the whole two-part text block ends up.
          textBlockHeight: Math.round(it.querySelector(".xm-text").getBoundingClientRect().height),
        };
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((r2) => setTimeout(r2, 60));
        return r;
      };
      await setPre(PRE_FIX.exportMenu);
      const exBefore = await browser.evaluate(EXPORT);
      await setPre("");
      const exAfter = await browser.evaluate(EXPORT);
      findings.push({
        area: "export menu, first item",
        measurements: [
          rowsFmt("label and description on separate lines", exBefore.stacked, exAfter.stacked),
          rowsFmt(
            "label / description font size (px)",
            `${exBefore.labelPx} / ${exBefore.descPx}`,
            `${exAfter.labelPx} / ${exAfter.descPx}`,
          ),
          rowsFmt("label font weight", exBefore.labelWeight, exAfter.labelWeight),
          rowsFmt(
            "description top minus label bottom (px)",
            exBefore.descTopMinusLabelBottom,
            exAfter.descTopMinusLabelBottom,
          ),
          rowsFmt(
            "height of the item's text block (px)",
            exBefore.textBlockHeight,
            exAfter.textBlockHeight,
          ),
        ],
      });
    } finally {
      await server.close();
    }
  }

  // Picker: the footer inside a short container
  {
    const server = await serve(pickerPage);
    try {
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

      const FOOT = () => {
        const host = document.getElementById("host");
        const root = document.querySelector(".freva-picker");
        const add = root.querySelector(".fp-add");
        const hb = host.getBoundingClientRect();
        const ab = add.getBoundingClientRect();
        const hit = document.elementFromPoint(
          Math.round(ab.left + ab.width / 2),
          Math.round(ab.top + ab.height / 2),
        );
        return {
          overflowPastHost: Math.round((ab.bottom - hb.bottom) * 100) / 100,
          addFullyInside: ab.bottom <= hb.bottom + 1 && ab.top >= hb.top - 1,
          addHittable: !!(hit && hit.closest(".fp-add")),
          rootHeight: Math.round(root.getBoundingClientRect().height),
        };
      };
      const setPre = setPreOn(browser);

      await setPre(PRE_FIX.pickerFoot);
      const before = await browser.evaluate(FOOT);
      await setPre("");
      const after = await browser.evaluate(FOOT);
      findings.push({
        area: "compact picker in a 360x300 container",
        measurements: [
          rowsFmt(
            "Add button's overshoot past the container's bottom (px)",
            before.overflowPastHost,
            after.overflowPastHost,
          ),
          rowsFmt(
            "Add button fully inside the container",
            before.addFullyInside,
            after.addFullyInside,
          ),
          rowsFmt("Add button is hit-testable", before.addHittable, after.addHittable),
          rowsFmt("picker root height (px)", before.rootHeight, after.rootHeight),
        ],
      });
    } finally {
      await server.close();
    }
  }

  return [{ name: "evidence collected", pass: true, detail: `${findings.length} areas` }];
});
if (outcome.status !== "pass") {
  console.error(
    `evidence run did not complete: ${outcome.detail ?? JSON.stringify(outcome.checks)}`,
  );
  process.exit(1);
}

console.log("\n=== before / after, measured in Chromium ===\n");
for (const f of findings) {
  console.log(f.area);
  for (const m of f.measurements) {
    console.log(`  ${m.measurement}`);
    console.log(`      before: ${m.before}`);
    console.log(`      after:  ${m.after}`);
  }
  console.log("");
}
