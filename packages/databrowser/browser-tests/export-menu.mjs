/**
 * The two export menus, measured.
 *
 * The failure mode is text reading "Intake catalogueintake-esm JSON for the whole result set" -
 * one small grey run with no hierarchy. Its cause is concrete and structural: a PRIMARY label
 * styled with `.desc`, which is the package's faint 11px caption style, next to a secondary `.sub`
 * span with no rule at all, so the two spans run inline. That is not a matter of taste; it is two
 * text nodes with no line break, which is something a browser can be asked about directly.
 *
 * So these checks measure exactly that: are the label and the description on SEPARATE LINES, is the
 * label more prominent than the description, is the scope stated once rather than three times, and
 * does the whole menu fit inside a 320px-wide component without overflowing. Both menus -
 * whole-result Export and selected-files Download - share one renderer, so both are exercised.
 */
import { IMPORT_MAP, fakeApi, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>
  html,body{margin:0;height:100%}
  /* The component is sized by its HOST; the narrow case is a component width, not a phone. */
  #app{height:100vh;width:1280px}
</style></head><body><div id="app"></div>
${fakeApi({
  rows: Array.from({ length: 12 }, (_, i) => ({
    file: i % 2 ? `https://store.example/archive/tas_${i}.nc` : `/archive/tas_${i}.nc`,
    fs_type: i % 2 ? "s3" : "posix",
  })),
  facets: { project: ["cmip6", 120] },
  total: 120,
})}
<script type="module">
  const { mountDataBrowser } = await import("@freva-org/databrowser");
  window.__h = mountDataBrowser(document.getElementById("app"), { syncUrl: false });
  await new Promise(r => setTimeout(r, 500));
  document.querySelector('.seg [aria-label="List view"]')?.click();
  await new Promise(r => setTimeout(r, 150));
  window.__ready = true;
</script></body></html>`;

/** Measure an open `.export-pop`: geometry, hierarchy and text. */
const MEASURE = () => {
  const root = document.querySelector(".freva-db");
  const pop = root.querySelector(".export-pop");
  if (!pop) return { open: false };
  const items = [...pop.querySelectorAll(".xm-item")];
  const rects = (n) => {
    const r = n.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
  };
  const rows = items.map((it) => {
    const label = it.querySelector(".xm-label");
    const desc = it.querySelector(".xm-desc");
    const fmt = it.querySelector(".xm-fmt");
    const lb = rects(label),
      db = rects(desc);
    return {
      label: label.textContent,
      desc: desc.textContent,
      fmt: fmt ? fmt.textContent : null,
      // The two must not run INLINE. Separate lines means the description's top is at or
      // below the label's bottom.
      stacked: db.t >= lb.b - 1,
      // …and the label has to be the prominent one.
      labelBigger:
        parseFloat(getComputedStyle(label).fontSize) > parseFloat(getComputedStyle(desc).fontSize),
      labelWeight: Number(getComputedStyle(label).fontWeight),
      // Icon column is fixed and to the LEFT of the text.
      iconLeftOfText: rects(it.querySelector(".xm-ic")).r <= lb.l + 1,
      box: rects(it),
      touchOk: rects(it).h >= 40,
      role: it.getAttribute("role"),
    };
  });
  const head = pop.querySelector(".xm-head");
  const rb = root.getBoundingClientRect(),
    pb = rects(pop);
  return {
    open: true,
    heading: head ? head.textContent : null,
    headingInteractive: head ? head.matches("button, a, [role='button']") : false,
    menuRole: pop.querySelector(".xm") ? pop.querySelector(".xm").getAttribute("role") : null,
    rows,
    // Fits inside the COMPONENT, and no row overflows its own container horizontally.
    insidePicker: pb.l >= rb.left - 1 && pb.r <= rb.right + 1,
    boxes: { root: { l: rb.left, r: rb.right }, pop: pb },
    noOverflow: rows.every((r) => r.box.r <= pb.r + 1),
    scrollOverflow: pop.scrollWidth > pop.clientWidth + 1,
  };
};

const result = await inChromium(async (browser) => {
  const server = await serve(page);
  const checks = [];
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    const closeAny = () =>
      browser.evaluate(async () => {
        // Escape, not `.remove()`: ripping the node out leaves the PopoverManager thinking one is
        // still open, so the next click on the trigger TOGGLES it shut instead of opening it.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
      });
    const openWholeResult = async () => {
      await closeAny();
      await browser.evaluate(async () => {
        document.querySelector('[aria-label^="Export catalogue"]').click();
        await new Promise((r) => setTimeout(r, 150));
      });
    };
    const openSelection = async () => {
      await closeAny();
      await browser.evaluate(async () => {
        const root = document.querySelector(".freva-db");
        // Pick two files so the pickbar - and with it the Download menu - exists.
        const boxes = [...root.querySelectorAll("#fdb-results .cb")];
        for (const c of boxes.slice(0, 2)) if (!c.closest(".row.picked")) c.click();
        await new Promise((r) => setTimeout(r, 250));
        const dl = [...root.querySelectorAll(".pickbar button")].find((b) =>
          (b.textContent ?? "").includes("Download"),
        );
        if (!dl)
          throw new Error(
            `no Download button; picked=${root.querySelectorAll(".row.picked").length}`,
          );
        dl.click();
        await new Promise((r) => setTimeout(r, 200));
      });
    };

    for (const [name, open, width] of [
      ["whole-result Export", openWholeResult, 1280],
      ["selected-files Download", openSelection, 1280],
    ]) {
      await browser.evaluate((w) => {
        document.getElementById("app").style.width = w + "px";
      }, width);
      await open();
      const m = await browser.evaluate(MEASURE);
      checks.push({
        name: `${name}: label and description are on SEPARATE lines, label more prominent`,
        pass:
          m.open &&
          m.rows.length >= 3 &&
          m.rows.every((r) => r.stacked && r.labelBigger && r.labelWeight >= 600),
        detail: JSON.stringify(
          m.rows?.map((r) => ({ l: r.label, stacked: r.stacked, big: r.labelBigger })),
        ),
      });
      checks.push({
        name: `${name}: the scope is stated ONCE, in a non-interactive heading`,
        pass:
          !!m.heading &&
          /Export (all 120 results|2 selected files)/.test(m.heading) &&
          !m.headingInteractive &&
          // …and NOT repeated in every row, which would make the rows unreadable.
          m.rows.every((r) => !/whole result set|for your selection/i.test(r.desc)),
        detail: JSON.stringify({ heading: m.heading, descs: m.rows?.map((r) => r.desc) }),
      });
      checks.push({
        name: `${name}: concise labels, format markers, menu semantics and touch targets`,
        pass:
          m.rows.slice(0, 3).every((r) => r.role === "menuitem" && r.iconLeftOfText && r.touchOk) &&
          m.menuRole === "menu" &&
          m.rows[0].label === "Intake catalogue" &&
          m.rows[0].desc === "intake-esm JSON" &&
          m.rows[0].fmt === "JSON" &&
          m.rows[1].label === "STAC catalogue" &&
          m.rows[1].fmt === "ZIP" &&
          m.rows[2].label === "URI manifest" &&
          m.rows[2].fmt === "TXT",
        detail: JSON.stringify(m.rows?.map((r) => [r.label, r.desc, r.fmt, r.role])),
      });

      // …and the same menu inside a 320px-wide COMPONENT.
      await closeAny();
      await browser.evaluate(() => {
        document.getElementById("app").style.width = "320px";
      });
      await new Promise((r) => setTimeout(r, 150));
      await open();
      const narrow = await browser.evaluate(MEASURE);
      checks.push({
        name: `${name} @320px component: fits inside, no concatenation, no horizontal overflow`,
        pass:
          narrow.open &&
          narrow.insidePicker &&
          narrow.noOverflow &&
          !narrow.scrollOverflow &&
          narrow.rows.every((r) => r.stacked),
        detail: JSON.stringify({
          inside: narrow.insidePicker,
          noOverflow: narrow.noOverflow,
          scroll: narrow.scrollOverflow,
          boxes: narrow.boxes,
        }),
      });
      await closeAny();
    }

    // Keyboard: the menu is navigable and the first item is focused on open.
    await browser.evaluate((w) => {
      document.getElementById("app").style.width = w + "px";
    }, 1280);
    await closeAny();
    const kb = await browser.evaluate(async () => {
      document.querySelector('[aria-label^="Export catalogue"]').click();
      await new Promise((r) => setTimeout(r, 150));
      const pop = document.querySelector(".freva-db .export-pop");
      const items = [...pop.querySelectorAll(".xm-item")];
      const first = document.activeElement === items[0];
      pop
        .querySelector(".xm")
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
        );
      const second = document.activeElement === items[1];
      pop
        .querySelector(".xm")
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
        );
      const end = document.activeElement === items[items.length - 1];
      return { first, second, end, count: items.length };
    });
    checks.push({
      name: "export menu: opens focused, Arrow/End move between items",
      pass: kb.first && kb.second && kb.end,
      detail: JSON.stringify(kb),
    });

    // The TRIGGERS announce the menu, and stop announcing it on every close route
    //
    // `aria-haspopup` is static; `aria-expanded` is the one that rots. A trigger left reading
    // "expanded" after the menu closed tells a screen-reader user a menu is on screen that isn't.
    // Every route is exercised, because they are separate code paths in the caller's mind even
    // though they funnel through one `close()`.
    const triggerRun = async (which) => {
      await closeAny();
      return browser.evaluate(async (kind) => {
        const root = document.querySelector(".freva-db");
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const esc = () =>
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        const trigger = () =>
          kind === "export"
            ? root.querySelector('[aria-label^="Export catalogue"]')
            : [...root.querySelectorAll(".pickbar button")].find((b) =>
                (b.textContent ?? "").includes("Download"),
              );

        if (kind === "download") {
          for (const c of [...root.querySelectorAll("#fdb-results .cb")].slice(0, 2)) {
            if (!c.closest(".row.picked")) c.click();
          }
          await sleep(250);
        }

        const t = trigger();
        if (!t) return { error: "no trigger" };
        const haspopup = t.getAttribute("aria-haspopup");
        const atRest = t.getAttribute("aria-expanded");

        const open = async () => {
          trigger().click();
          await sleep(180);
          return trigger().getAttribute("aria-expanded");
        };
        const readAfter = async (act) => {
          await act();
          await sleep(180);
          return trigger().getAttribute("aria-expanded");
        };

        const whenOpen = await open();
        // 1. Escape.
        const afterEscape = await readAfter(async () => esc());
        // 2. Selecting an item.
        await open();
        const afterPick = await readAfter(async () => {
          document.querySelector(".freva-db .export-pop .xm-item").click();
        });
        // 3. An outside click.
        await open();
        const afterOutside = await readAfter(async () => {
          document
            .querySelector(".freva-db")
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 5 }));
          document.body.click();
        });
        // 4. Scrolling the results away under it.
        await open();
        const afterScroll = await readAfter(async () => {
          const sc = root.querySelector(".results-scroll");
          sc.scrollTop = sc.scrollTop + 200;
          sc.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        // 5. Replacement by ANOTHER popover - the route that never calls the caller's own close.
        await open();
        const other = root.querySelector(".lensbtn, [aria-label^='Naming flavour'], .ctrl");
        const afterReplaced = await readAfter(async () => {
          other?.click();
        });
        esc();
        await sleep(120);
        const afterAll = trigger().getAttribute("aria-expanded");
        // Focus returns to the trigger when a keyboard user picks an item.
        await open();
        document.querySelector(".freva-db .export-pop .xm-item").focus();
        esc();
        await sleep(150);
        const focusRestored = document.activeElement === trigger();

        return {
          haspopup,
          atRest,
          whenOpen,
          afterEscape,
          afterPick,
          afterOutside,
          afterScroll,
          afterReplaced,
          afterAll,
          focusRestored,
        };
      }, which);
    };

    for (const [label, kind] of [
      ["whole-result Export", "export"],
      ["selected-files Download", "download"],
    ]) {
      const t = await triggerRun(kind);
      checks.push({
        name: `${label} trigger: aria-haspopup="menu", and aria-expanded tracks EVERY close route`,
        pass:
          !t.error &&
          t.haspopup === "menu" &&
          t.atRest === "false" &&
          t.whenOpen === "true" &&
          t.afterEscape === "false" &&
          t.afterPick === "false" &&
          t.afterOutside === "false" &&
          t.afterScroll === "false" &&
          t.afterReplaced === "false" &&
          t.afterAll === "false" &&
          t.focusRestored === true,
        detail: JSON.stringify(t),
      });
      await closeAny();
    }

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("export menus: whole-result and selected-files", result));
