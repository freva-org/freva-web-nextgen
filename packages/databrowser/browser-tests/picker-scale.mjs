/**
 * The picker's cost at scale, counted in a real engine.
 *
 * The claim under test is the one a lab integrator actually cares about: opening the picker on a
 * broad query must not turn 1,000 matches into 1,000 live DOM nodes with 1,000 listeners inside
 * their application. jsdom can approximate the node count (it has no layout, so the windowed list
 * falls back to a fixed window there), but only a real engine exercises the measured path - the one
 * that decides the window from `clientHeight` and recycles on scroll.
 *
 * Also checks the thing a naive "virtual list" usually gets wrong: scrolling to the very end must
 * still show the LAST row, and scrolling back must not have leaked the rows in between.
 */
import { IMPORT_MAP, fakeApi, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

const N = 1000;

const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%} #app{height:100vh;width:900px}</style>
</head><body><div id="app"></div>
${fakeApi({
  rows: Array.from({ length: N }, (_, i) => ({
    file: `/archive/project/model/experiment/tas_day_${String(i).padStart(4, "0")}.nc`,
    fs_type: "posix",
  })),
  facets: { project: ["cmip6", N], variable: ["tas", N] },
  total: N,
})}
<script type="module">
  const { mountDataPicker } = await import("@freva-org/databrowser/picker");
  window.__p = mountDataPicker(document.getElementById("app"), { debounceMs: 5 });
  await new Promise(r => setTimeout(r, 500));
  window.__ready = true;
</script></body></html>`;

const result = await inChromium(async (browser) => {
  const server = await serve(page);
  const checks = [];
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    const m = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-picker");
      const sc = root.querySelector(".fp-scroll");
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const count = () => root.querySelectorAll(".fp-row").length;
      const firstText = () => root.querySelector(".fp-row .fp-uri")?.textContent ?? "";
      const lastText = () => {
        const rows = root.querySelectorAll(".fp-row .fp-uri");
        return rows.length ? rows[rows.length - 1].textContent : "";
      };

      const head = root.querySelector(".fp-lh").textContent;
      const initial = count();
      const heights = { viewport: sc.clientHeight, scroll: sc.scrollHeight };
      const topFirst = firstText();

      sc.scrollTop = sc.scrollHeight; // all the way down
      await frame();
      const atEnd = { count: count(), first: firstText(), last: lastText() };

      sc.scrollTop = 0; // and back
      await frame();
      const backAtTop = { count: count(), first: firstText() };

      // Total node count under the scroller, not just rows: a leak would show up here even if the
      // rows themselves were recycled.
      const nodes = sc.querySelectorAll("*").length;
      return { head, initial, heights, topFirst, atEnd, backAtTop, nodes };
    });

    checks.push({
      name: `all ${N} results are reported, and the scroller is sized for them`,
      pass: /1,000 files/.test(m.head) && m.heights.scroll > m.heights.viewport * 5,
      detail: JSON.stringify({ head: m.head, ...m.heights }),
    });
    checks.push({
      name: `${N} results materialise a bounded window, not ${N} rows`,
      pass: m.initial > 0 && m.initial <= 60,
      detail: `${m.initial} live rows for ${N} results (viewport ${m.heights.viewport}px)`,
    });
    checks.push({
      name: "the window is derived from the MEASURED viewport, not a fixed guess",
      // A real engine reports a real height, so the window has to be proportional to it.
      pass:
        m.initial >= Math.floor(m.heights.viewport / 34) &&
        m.initial <= Math.ceil(m.heights.viewport / 34) + 16,
      detail: `${m.initial} rows for a ${m.heights.viewport}px viewport at 34px each`,
    });
    checks.push({
      name: "scrolling to the end shows the LAST row and recycles rather than accumulates",
      pass:
        m.atEnd.count > 0 &&
        m.atEnd.count <= m.initial + 2 &&
        /_0999\.nc$/.test(m.atEnd.last) &&
        m.atEnd.first !== m.topFirst,
      detail: JSON.stringify(m.atEnd),
    });
    checks.push({
      name: "scrolling back leaves the same bounded window, with the first row restored",
      pass: m.backAtTop.count <= m.initial + 2 && m.backAtTop.first === m.topFirst,
      detail: JSON.stringify({ ...m.backAtTop, expectedFirst: m.topFirst }),
    });
    checks.push({
      name: `the whole scroller holds a bounded number of nodes (${m.nodes})`,
      pass: m.nodes < N,
      detail: `${m.nodes} elements under .fp-scroll for ${N} results`,
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report(`picker at scale: ${N} results, windowed list`, result));
