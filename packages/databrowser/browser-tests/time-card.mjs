/**
 * The Time range card, measured at the width it actually gets.
 *
 * THE GEOMETRY. `.daterow` has three children - a label, the text field, and the calendar-button
 * wrapper - so `.editor.inline .daterow` needs three grid columns. Declare only two (`34px 1fr`)
 * and the third child lands on an implicit SECOND grid row, making every date row two lines tall.
 * Two of those, plus the mode buttons, overflow the card body; and because the body centres its
 * content, the overflow goes off both ends at once, clipping the From row underneath the card
 * header.
 *
 * Nothing about that is visible without layout: in jsdom every one of these rectangles is 0x0 and
 * an implicit grid row costs nothing. So the columns are counted the only way they can be counted -
 * by asking where the three children were actually painted.
 *
 * What holds it is the third column and `safe center`, not a taller card, so these checks are about
 * geometry at the DEFAULT one-block card size, in both themes.
 */
import { IMPORT_MAP, fakeApi, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%} #app{height:100vh;width:1280px}</style></head>
<body><div id="app"></div>
${fakeApi({
  rows: [{ file: "/archive/tas.nc", fs_type: "posix" }],
  facets: { project: ["cmip6", 12], model: ["m1", 6], variable: ["tas", 4] },
})}
<script type="module">
  const { mountDataBrowser } = await import("@freva-org/databrowser");
  window.__h = mountDataBrowser(document.getElementById("app"), { syncUrl: false });
  await new Promise(r => setTimeout(r, 600));
  window.__ready = true;
</script></body></html>`;

/** Measure the Time card: rows, columns, overlaps, overflow. */
const MEASURE = async () => {
  const root = document.querySelector(".freva-db");
  const card = root.querySelector('.fcard[data-key="__time"]');
  if (!card) return { error: "no time card" };
  // `elementFromPoint` is VIEWPORT-relative: a card below the fold reports `null` for every point
  // inside it, which would look exactly like an unclickable button. Bring it on screen first.
  card.scrollIntoView({ block: "center" });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const head = card.querySelector(".fcard-head") ?? card.firstElementChild;
  const body = card.querySelector(".fcard-special-body");
  const rows = [...card.querySelectorAll(".daterow")];
  const cardBox = card.getBoundingClientRect();
  const headBox = head.getBoundingClientRect();
  const bodyBox = body.getBoundingClientRect();

  const box = (n) => {
    const r = n.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
  };

  const rowInfo = rows.map((row) => {
    const kids = [...row.children];
    const bs = kids.map(box);
    // ONE ROW means every child shares a horizontal band: each child's vertical span overlaps the
    // first child's. A wrapped calendar button sits entirely below the label - which is exactly the
    // defect, and exactly what this catches.
    const oneLine = bs.every((b) => b.t < bs[0].b - 1 && b.b > bs[0].t + 1);
    // THREE COLUMNS means the three children are laid out left-to-right without overlapping.
    const threeColumns = bs.length === 3 && bs[0].r <= bs[1].l + 1 && bs[1].r <= bs[2].l + 1;
    const rowBox = box(row);
    return {
      label: kids[0]?.textContent ?? "",
      children: kids.length,
      oneLine,
      threeColumns,
      // A two-line row is roughly twice as tall as the field inside it.
      rowH: Math.round(rowBox.h),
      inputH: Math.round(bs[1]?.h ?? 0),
      // The field must not spill out of the card.
      inputInside: bs[1] ? bs[1].r <= cardBox.right + 1 : false,
      belowHeader: rowBox.t >= headBox.bottom - 1,
      boxes: bs,
    };
  });

  // Every calendar button hit-testable at its own centre.
  const picks = [...card.querySelectorAll(".date-pick")].map((b) => {
    const r = b.getBoundingClientRect();
    const at = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(r.top + r.height / 2),
    );
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      hit: !!at && (at === b || b.contains(at)),
      hitWas: at ? `${at.tagName}.${at.getAttribute("class") ?? ""}` : null,
      insideCard: r.right <= cardBox.right + 1 && r.left >= cardBox.left - 1,
      belowHeader: r.top >= headBox.bottom - 1,
    };
  });

  // Nothing inside the body may be painted above the header's bottom edge.
  const clipped = [...body.querySelectorAll(".daterow, .modes, .mode-help")].filter(
    (n) => n.getBoundingClientRect().top < headBox.bottom - 1,
  ).length;

  const modes = [...card.querySelectorAll(".modes button")];
  const modeBoxes = modes.map(box);

  return {
    error: null,
    cardW: Math.round(cardBox.width),
    cardH: Math.round(cardBox.height),
    rows: rowInfo,
    picks,
    clipped,
    modeCount: modes.length,
    modesVisible: modeBoxes.every(
      (b) => b.t >= bodyBox.top - 1 && b.b <= bodyBox.bottom + 1 && b.h > 0,
    ),
    // The default card needs no scrolling to show all of it.
    bodyScrolls: body.scrollHeight > body.clientHeight + 1,
    bodyScrollTop: body.scrollTop,
    hOverflow: body.scrollWidth > body.clientWidth + 1,
    justify: getComputedStyle(body).justifyContent,
  };
};

const result = await inChromium(async (browser) => {
  const server = await serve(page);
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail: JSON.stringify(detail) });
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    // Overview, default card size (one block wide, one block tall).
    await browser.evaluate(async () => {
      const root = document.querySelector(".freva-db");
      root.querySelector('.ctrl[aria-label="Overview"]').click();
      await new Promise((r) => setTimeout(r, 500));
      // Force the MINIMUM card width the overview grid can hand out, so nothing here passes only
      // because the viewport happened to be wide.
      // One column at the narrowest realistic card width, so nothing here passes only because the
      // viewport happened to be wide.
      const grid = root.querySelector(".facet-grid");
      grid.style.gridTemplateColumns = "1fr";
      grid.style.width = "250px";
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });

    for (const theme of ["day", "night"]) {
      await browser.evaluate(async (t) => {
        const root = document.querySelector(".freva-db");
        root.dataset.theme = t;
        root.setAttribute("data-theme", t);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }, theme);
      const m = await browser.evaluate(MEASURE);
      if (m.error) {
        push(`time card (${theme}): ${m.error}`, false, m);
        continue;
      }
      push(
        `time card (${theme} @${m.cardW}px): both date rows are ONE line with THREE columns`,
        m.rows.length === 2 &&
          m.rows.every((r) => r.children === 3 && r.oneLine && r.threeColumns) &&
          // A wrapped row is about twice the field's height; a single row is about one.
          m.rows.every((r) => r.rowH <= r.inputH * 1.6),
        m.rows.map((r) => ({
          label: r.label,
          children: r.children,
          oneLine: r.oneLine,
          threeColumns: r.threeColumns,
          rowH: r.rowH,
          inputH: r.inputH,
        })),
      );
      push(
        `time card (${theme}): the From row starts BELOW the header and nothing is clipped under it`,
        m.rows.every((r) => r.belowHeader) &&
          m.clipped === 0 &&
          m.picks.every((p) => p.belowHeader),
        { belowHeader: m.rows.map((r) => r.belowHeader), clipped: m.clipped, justify: m.justify },
      );
      push(
        `time card (${theme}): both calendar buttons are hit-testable inside the card`,
        m.picks.length === 2 && m.picks.every((p) => p.hit && p.insideCard && p.w > 0 && p.h > 0),
        m.picks,
      );
      push(
        `time card (${theme}): all three modes show, no scrolling and no horizontal overflow`,
        m.modeCount === 3 &&
          m.modesVisible &&
          !m.bodyScrolls &&
          m.bodyScrollTop === 0 &&
          !m.hOverflow &&
          m.rows.every((r) => r.inputInside),
        {
          modes: m.modeCount,
          modesVisible: m.modesVisible,
          scrolls: m.bodyScrolls,
          hOverflow: m.hOverflow,
          cardH: m.cardH,
        },
      );
    }

    // The editor still WORKS: partial dates, open bounds, live application, and the native picker
    // is still reachable from the calendar button.
    const behaviour = await browser.evaluate(async () => {
      // Applying live RE-RENDERS the card, so the inputs must be re-queried every time rather than
      // captured once - a stale node takes the value and nothing sees it.
      const fields = () => [
        ...document
          .querySelector('.freva-db .fcard[data-key="__time"]')
          .querySelectorAll(".daterow input:not([type=date])"),
      ];
      const set = async (i, v) => {
        const f = fields()[i];
        f.value = v;
        f.dispatchEvent(new Event("input", { bubbles: true }));
        f.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 350));
      };
      await set(0, "2000"); // a PARTIAL date
      const partial = window.__h.getState().time;
      await set(1, ""); // an OPEN upper bound
      const open = window.__h.getState().time;
      const badField = fields()[0];
      badField.value = "not-a-date";
      badField.dispatchEvent(new Event("input", { bubbles: true }));
      const bad = badField.classList.contains("bad");
      await set(0, "2000");
      // The mode buttons: `flexible` is the only one enabled by default (strict/file are
      // flag-gated), so what matters here is that all three render, exactly one is current, and
      // pressing the enabled one still applies live.
      const liveCard = document.querySelector('.freva-db .fcard[data-key="__time"]');
      const modes = [...liveCard.querySelectorAll(".modes button")];
      const current = modes.filter(
        (b) => b.classList.contains("on") || b.getAttribute("aria-pressed") === "true",
      ).length;
      const enabled = modes.filter((b) => !b.disabled);
      enabled[0]?.click();
      await new Promise((r) => setTimeout(r, 350));
      const modeApplied = window.__h.getState().time;
      const native = liveCard.querySelector(".date-native");
      return {
        partial,
        open,
        bad,
        modes: modes.length,
        current,
        modeApplied,
        hasNativePicker: !!native && native.type === "date",
      };
    });
    push(
      "time card: partial dates, an open bound, invalid input and live mode changes all still work",
      behaviour.partial?.from === "2000" &&
        behaviour.open?.to === "" &&
        behaviour.bad === true &&
        behaviour.modes === 3 &&
        behaviour.current === 1 &&
        behaviour.modeApplied?.from === "2000" &&
        !!behaviour.modeApplied?.mode &&
        behaviour.hasNativePicker,
      behaviour,
    );

    // Resizing the card to two blocks keeps the rows single-line - the layout must not depend on
    // the card's height.
    const resized = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-db");
      const card = root.querySelector('.fcard[data-key="__time"]');
      card.dataset.rows = "2";
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rows = [...card.querySelectorAll(".daterow")].map((row) => {
        const bs = [...row.children].map((k) => k.getBoundingClientRect());
        return bs.every((b) => b.top < bs[0].bottom - 1 && b.bottom > bs[0].top + 1);
      });
      const grip = card.querySelector(".fcard-resize");
      card.dataset.rows = "1";
      return { rows, hasGrip: !!grip };
    });
    push(
      "time card: a two-block card keeps single-line rows, and the resize grip is still there",
      resized.rows.length === 2 && resized.rows.every(Boolean) && resized.hasGrip,
      resized,
    );

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("time card: three-column date rows at the default card width", result));
