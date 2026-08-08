/**
 * The picker is supposed to be COMPACT, and "all filtered results" is supposed to be legible.
 *
 * Two different claims, measured together because they fail together in the same place - the
 * footer. The semantics are not in doubt: query mode produces a bounded `kind: "query"` reference,
 * materialises nothing, and commits nothing until the action is pressed. What needs measuring is
 * that the user can SEE that, and that the layout reliably keeps the action on screen.
 *
 * So: the 120-result scenario is walked end to end (activate, prove no bulk selection, prove the
 * reference changed, prove nothing committed, press once, get exactly one query reference), and the
 * layout is measured at three component widths plus a short embedded container - because
 * responsiveness here follows the PICKER'S container, not the viewport.
 */
import { IMPORT_MAP, inChromium, overlaps, report, requireDist, serve } from "./harness.mjs";

requireDist();

const TOTAL = 120;

/** 120 results reported, 40 rows delivered - a page, not the whole set. */
const api = `<script>
  const ROWS = Array.from({ length: 40 }, (_, i) => ({
    file: "/archive/project/model/experiment/tas_day_" + String(i).padStart(3, "0") + ".nc",
    fs_type: "posix",
  }));
  window.fetch = async (url) => new Response(JSON.stringify(
    String(url).includes("/overview") ? { flavours: ["freva"], attributes: { freva: ["project"] } }
    : String(url).includes("/flavours") ? { flavours: [] }
    : { total_count: ${TOTAL},
        facets: { project: ["cmip6", ${TOTAL}, "cordex", 40], variable: ["tas", 90, "pr", 30] },
        primary_facets: ["project", "variable"], facet_mapping: {}, search_results: ROWS }
  ), { headers: { "content-type": "application/json" } });
</script>`;

/**
 * Three component widths and one deliberately SHORT embedded container. The 320/560/desktop panes
 * are laid out side by side inside a scrolled, clipped host so nothing here can accidentally be
 * measured against a bare full-page mount.
 */
const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>
  html,body{margin:0}
  body{height:1600px;font:13px system-ui}
  .site{height:56px;background:#123;color:#fff}
  .clip{height:560px;overflow:hidden;margin:0 24px;transform:translateZ(0)}
  .lanes{height:100%;display:grid;grid-template-columns:320px 560px minmax(0,1fr);
         grid-template-rows:minmax(0,1fr);gap:16px}
  .lane{min-width:0;min-height:0}
  /* A short embedded container: the whole picker has to live in 300px of height. */
  .short{height:300px;margin:16px 24px;overflow:hidden}
  /* DEMO CHROME - not part of the picker. Labelled so it can never be mistaken for picker UI. */
  .demo-out{margin:16px 24px;padding:8px;border:1px dashed #999;font:11px ui-monospace}
</style></head><body>
<div class="site">host header</div>
<div class="clip"><div class="lanes">
  <div class="lane" id="w320"></div><div class="lane" id="w560"></div><div class="lane" id="wide"></div>
</div></div>
<div class="short" id="short"></div>
<div class="demo-out"><b>Demo harness output (not the picker)</b><pre id="out"></pre></div>
${api}
<script type="module">
  const { mountDataPicker } = await import("@freva-org/databrowser/picker");
  window.__commits = [];
  const common = { debounceMs: 5, commitLabel: "Add to experiment",
                   onCommit: (r) => { window.__commits.push(r); document.getElementById("out").textContent = JSON.stringify(r).slice(0, 120); } };
  window.__p = {};
  for (const id of ["w320", "w560", "wide", "short"]) {
    window.__p[id] = mountDataPicker(document.getElementById(id), common);
  }
  // The DEFAULT picker: Time and BBox are OFF unless a host asks for them.
  await new Promise(r => setTimeout(r, 500));
  window.scrollTo(0, 120);
  window.__ready = true;
</script></body></html>`;

const result = await inChromium(async (browser) => {
  const server = await serve(page);
  const checks = [];
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    // 1. The default picker is actually minimal
    const defaults = await browser.evaluate(() => {
      const root = document.querySelector("#wide .freva-picker");
      return {
        timeOrBbox: root.querySelectorAll(".fp-disc").length,
        rawInputs: root.querySelectorAll(".fp-controls input").length,
        hasSearch: !!root.querySelector(".fp-input"),
        hasFacets: root.querySelectorAll(".fp-facet").length,
        hasList: root.querySelectorAll(".fp-row").length,
        hasAction: !!root.querySelector(".fp-add"),
        // …and none of the full browser's chrome.
        forbidden: root.querySelectorAll(".freva-term, .fcard, .brand, .pickbar, .list-head")
          .length,
      };
    });
    checks.push({
      name: "the DEFAULT picker shows search, facets, files and the action - and no time/bbox",
      pass:
        defaults.timeOrBbox === 0 &&
        defaults.rawInputs === 0 &&
        defaults.hasSearch &&
        defaults.hasFacets > 0 &&
        defaults.hasList > 0 &&
        defaults.hasAction &&
        defaults.forbidden === 0,
      detail: JSON.stringify(defaults),
    });

    // 2. Layout at three component widths + a short container
    const layout = await browser.evaluate(() => {
      const out = {};
      for (const id of ["w320", "w560", "wide", "short"]) {
        const host = document.getElementById(id);
        const root = host.querySelector(".freva-picker");
        const b = (sel) => {
          const n = root.querySelector(sel);
          if (!n) return null;
          const r = n.getBoundingClientRect();
          return {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            w: r.width,
            h: r.height,
          };
        };
        const hb = host.getBoundingClientRect();
        const rb = root.getBoundingClientRect();
        const add = b(".fp-add");
        const foot = b(".fp-foot");
        const scroll = root.querySelector(".fp-scroll");
        // Is the ACTION actually hittable where it claims to be?
        const hit = add
          ? document.elementFromPoint(add.left + add.w / 2, add.top + add.h / 2)
          : null;
        out[id] = {
          hostW: hb.width,
          hostH: hb.height,
          rootBottom: rb.bottom,
          hostBottom: hb.bottom,
          add,
          foot,
          modes: b(".fp-modes"),
          files: b(".fp-files"),
          // No horizontal overflow anywhere inside the picker.
          hOverflow: root.scrollWidth > root.clientWidth + 1,
          listScrolls: scroll.scrollHeight > scroll.clientHeight + 1,
          rowW: b(".fp-row") ? b(".fp-row").w : 0,
          addHittable:
            !!hit &&
            (hit === root.querySelector(".fp-add") || root.querySelector(".fp-add").contains(hit)),
        };
      }
      return out;
    });

    for (const id of ["w320", "w560", "wide", "short"]) {
      const m = layout[id];
      checks.push({
        name: `@${Math.round(m.hostW)}x${Math.round(m.hostH)} container: the footer and the whole Add button are inside it`,
        pass:
          !!m.add &&
          !!m.foot &&
          m.foot.bottom <= m.hostBottom + 1 &&
          m.add.bottom <= m.hostBottom + 1 &&
          m.rootBottom <= m.hostBottom + 1 &&
          m.addHittable,
        detail: JSON.stringify({
          addBottom: m.add?.bottom,
          hostBottom: m.hostBottom,
          rootBottom: m.rootBottom,
          hittable: m.addHittable,
        }),
      });
      checks.push({
        name: `@${Math.round(m.hostW)}px: no horizontal overflow, the list owns the scrolling, rows stay usable`,
        pass: !m.hOverflow && m.listScrolls && m.rowW >= 140,
        detail: JSON.stringify({
          hOverflow: m.hOverflow,
          listScrolls: m.listScrolls,
          rowW: m.rowW,
        }),
      });
      if (m.modes && m.add) {
        checks.push({
          name: `@${Math.round(m.hostW)}px: the mode choice and the action never overlap`,
          pass: !overlaps(m.modes, m.add),
          detail: JSON.stringify({ modes: m.modes, add: m.add }),
        });
      }
    }

    // 3. The 120-result "all filtered" walk
    const walk = await browser.evaluate(async () => {
      const root = document.querySelector("#wide .freva-picker");
      const p = window.__p.wide;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const q = (s) => root.querySelector(s);

      const head = q(".fp-lh").textContent;
      const before = {
        commits: window.__commits.length,
        picked: root.querySelectorAll(".fp-row.picked").length,
        aria: root.querySelectorAll('.fp-row[aria-selected="true"]').length,
        ref: p.getReference(),
        mode: p.getState().useAllFiltered,
        queryLabel: q('.fp-mode[data-mode="query"]').textContent,
        addText: q(".fp-add").textContent,
        addDisabled: q(".fp-add").disabled,
      };

      q('.fp-mode[data-mode="query"]').click();
      await wait(60);

      const after = {
        commits: window.__commits.length,
        rows: root.querySelectorAll(".fp-row").length,
        picked: root.querySelectorAll(".fp-row.picked").length,
        aria: root.querySelectorAll('.fp-row[aria-selected="true"]').length,
        checked: q('.fp-mode[data-mode="query"]').getAttribute("aria-checked"),
        note: q(".fp-note").textContent,
        noteShown: q(".fp-note").classList.contains("show"),
        addText: q(".fp-add").textContent,
        state: p.getState(),
        ref: p.getReference(),
      };

      q(".fp-add").click();
      await wait(60);
      const committed = window.__commits;
      return { head, before, after, commits: committed.length, ref: committed[0] ?? null };
    });

    checks.push({
      name: `the list reports ${TOTAL} results while showing a page of them`,
      pass: /120 files/.test(walk.head) && walk.after.rows > 0 && walk.after.rows < TOTAL,
      detail: JSON.stringify({ head: walk.head, rows: walk.after.rows }),
    });
    checks.push({
      name: "activating All filtered results selects NO rows",
      pass: walk.after.picked === 0 && walk.after.aria === 0 && walk.before.picked === 0,
      detail: JSON.stringify({ picked: walk.after.picked, aria: walk.after.aria }),
    });
    checks.push({
      name: "…and is visibly active, with an explanation and a scoped action label",
      pass:
        walk.after.checked === "true" &&
        walk.after.noteShown &&
        /A query reference will be added; individual rows are not selected\./.test(
          walk.after.note,
        ) &&
        /Add to experiment/.test(walk.after.addText) &&
        /· all 120$/.test(walk.after.addText),
      detail: JSON.stringify({ note: walk.after.note, add: walk.after.addText }),
    });
    checks.push({
      name: "state and getReference() moved to query mode - and nothing was committed yet",
      pass:
        walk.before.ref === null &&
        walk.after.state.useAllFiltered === true &&
        walk.after.state.assets.length === 0 &&
        walk.after.ref &&
        walk.after.ref.kind === "query" &&
        walk.after.ref.estimatedCount === TOTAL &&
        walk.after.commits === 0,
      detail: JSON.stringify({
        beforeRef: walk.before.ref,
        kind: walk.after.ref?.kind,
        count: walk.after.ref?.estimatedCount,
        commitsBeforePress: walk.after.commits,
      }),
    });
    checks.push({
      name: `one press produces exactly ONE bounded query reference (estimatedCount ${TOTAL})`,
      pass:
        walk.commits === 1 &&
        walk.ref?.kind === "query" &&
        walk.ref?.estimatedCount === TOTAL &&
        JSON.stringify(walk.ref).length < 700,
      detail: JSON.stringify({ commits: walk.commits, ref: walk.ref }),
    });

    // 4. Overlays stay attached inside the clipped, transformed, scrolled host
    const overlay = await browser.evaluate(async () => {
      const root = document.querySelector("#w320 .freva-picker");
      const input = root.querySelector(".fp-input");
      input.focus();
      input.value = "ta";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const pop = root.querySelector(".fp-ac");
      const p = pop.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      const i = input.getBoundingClientRect();
      return {
        shown: pop.classList.contains("show"),
        parentIsRoot: pop.parentElement === root,
        belowField: p.top >= i.bottom - 1,
        inside: p.left >= r.left - 1 && p.right <= r.right + 1,
      };
    });
    checks.push({
      name: "@320px inside a clipped, transformed host: the autocomplete stays attached and inside",
      pass: overlay.shown && overlay.parentIsRoot && overlay.belowField && overlay.inside,
      detail: JSON.stringify(overlay),
    });

    // 5. Time/Area, when a host enables them, are compact disclosures
    const discs = await browser.evaluate(async () => {
      const { mountDataPicker } = await import("@freva-org/databrowser/picker");
      const host = document.createElement("div");
      host.style.cssText = "height:360px;width:340px";
      document.body.append(host);
      const p = mountDataPicker(host, { debounceMs: 5, features: { time: true, bbox: true } });
      await new Promise((r) => setTimeout(r, 400));
      const root = host.querySelector(".freva-picker");
      const closedInputs = root.querySelectorAll(".fp-controls input").length;
      const side = root.querySelector(".fp-side").getBoundingClientRect();
      const heads = [...root.querySelectorAll(".fp-disc-h")];
      heads[0].click();
      await new Promise((r) => setTimeout(r, 60));
      const openInputs = root.querySelectorAll(".fp-controls input").length;
      const rowW = root.querySelector(".fp-row")?.getBoundingClientRect().width ?? 0;
      const res = {
        discs: heads.length,
        closedInputs,
        openInputs,
        sideH: side.height,
        rowW,
        hOverflow: root.scrollWidth > root.clientWidth + 1,
      };
      p.destroy();
      host.remove();
      return res;
    });
    checks.push({
      name: "Time and Area are collapsed disclosures, not six inputs pinned into the rail",
      pass:
        discs.discs === 2 &&
        discs.closedInputs === 0 &&
        discs.openInputs === 2 &&
        !discs.hOverflow &&
        discs.rowW >= 140,
      detail: JSON.stringify(discs),
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("picker: compact layout and the all-filtered mode", result));
