/**
 * The compact picker inside the host shape that breaks overlays, measured for real.
 *
 * Same hostile geometry as embedded-host.mjs - a scrolled page, a transformed AND filtered
 * ancestor, a clipped `overflow: hidden` mount - plus the picker's own nested result scroller.
 * `position: fixed` resolves against a transformed ancestor rather than the viewport, and anything
 * outside the clipping box is simply not painted, so an autocomplete that looks correct on a bare
 * page detaches from its field here.
 *
 * Also proves, in a real engine, the two claims jsdom cannot check: that two instances coexist
 * without interfering, and that a real drag carries the same reference the button commits.
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

const page = `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>
  html,body{margin:0}
  body{height:2200px}                                   /* the page scrolls */
  .site-header{height:64px;background:#123;color:#fff}
  .shell{transform:translateZ(0);filter:saturate(1)}    /* transformed AND filtered ancestor */
  .md-content{height:560px;overflow:hidden;margin:0 40px}  /* clipped, offset mount */
  /* A definite height all the way down - see the picker README: an indefinite host height
     leaves the list unable to scroll. minmax(0,1fr) is what makes the row shrinkable. */
  .pane{height:100%;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:minmax(0,1fr);gap:12px}
  #one,#two{min-width:0;min-height:0}
</style></head><body>
<div class="site-header">host header</div>
<div class="shell"><div class="md-content"><div class="pane">
  <div id="one"></div><div id="two"></div>
</div></div></div>
${fakeApi({
  rows: Array.from({ length: 60 }, (_, i) => ({
    file: `https://store.example/archive/project/model/tas_day_${i}.nc`,
    fs_type: "s3",
  })),
  facets: { project: ["cmip6", 40, "cordex", 12], variable: ["tas", 30, "pr", 22] },
})}
<script type="module">
  const { mountDataPicker } = await import("@freva-org/databrowser/picker");
  window.__a = mountDataPicker(document.getElementById("one"), {
    commitLabel: "Add to experiment", debounceMs: 5,
    onCommit: (ref) => { (window.__commits ??= []).push(ref); },
  });
  window.__b = mountDataPicker(document.getElementById("two"), { debounceMs: 5 });
  await new Promise(r => setTimeout(r, 400));
  window.scrollTo(0, 260);                               // non-zero page scroll
  window.__ready = true;
</script></body></html>`;

const result = await inChromium(async (browser) => {
  const server = await serve(page);
  const checks = [];
  try {
    await browser.goto(server.url);
    await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    // 1. Two instances, side by side, independent
    const two = await browser.evaluate(async () => {
      const roots = [...document.querySelectorAll(".freva-picker")];
      const rowsIn = (r) => r.querySelectorAll(".fp-row").length;
      const first = roots[0];
      // Filter ONLY the first picker.
      [...first.querySelectorAll(".fp-v")]
        .find((b) => /cordex/.test(b.getAttribute("aria-label")))
        .click();
      await new Promise((r) => setTimeout(r, 250));
      return {
        count: roots.length,
        aChips: first.querySelectorAll(".fp-chip").length,
        bChips: roots[1].querySelectorAll(".fp-chip").length,
        aRows: rowsIn(first),
        bRows: rowsIn(roots[1]),
        aLabel: first.querySelector(".fp-add").textContent,
        bLabel: roots[1].querySelector(".fp-add").textContent,
        // Each picker owns its own overlay, inside its own root.
        popsInA: first.querySelectorAll(".fp-ac").length,
        popsInB: roots[1].querySelectorAll(".fp-ac").length,
      };
    });
    checks.push({
      name: "two instances coexist: filtering one leaves the other untouched",
      pass: two.count === 2 && two.aChips === 1 && two.bChips === 0 && two.bRows > 0,
      detail: JSON.stringify(two),
    });
    checks.push({
      name: "each instance owns its own overlay and its own host label",
      pass:
        two.popsInA === 1 &&
        two.popsInB === 1 &&
        two.aLabel === "Add to experiment" &&
        two.bLabel === "Add selection",
      detail: JSON.stringify(two),
    });

    // 2. The autocomplete stays attached inside the hostile host
    const ac = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-picker");
      const input = root.querySelector(".fp-input");
      input.focus();
      input.value = "ta";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const pop = root.querySelector(".fp-ac");
      const p = pop.getBoundingClientRect();
      const i = input.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      // Would a click actually land on the first option? elementFromPoint answers that.
      const item = pop.querySelector(".fp-ac-item").getBoundingClientRect();
      const hit = document.elementFromPoint(item.left + 8, item.top + item.height / 2);
      return {
        shown: pop.classList.contains("show"),
        parentIsRoot: pop.parentElement === root,
        position: getComputedStyle(pop).position,
        // Anchored to its field, not stranded at the container origin.
        belowField: p.top >= i.bottom - 1 && p.top < i.bottom + 20,
        alignedLeft: Math.abs(p.left - i.left) <= 2,
        insideRoot: p.left >= r.left - 1 && p.right <= r.right + 1 && p.bottom <= r.bottom + 1,
        clickable: !!hit && !!hit.closest(".fp-ac-item"),
        options: pop.querySelectorAll(".fp-ac-item").length,
      };
    });
    checks.push({
      name: "autocomplete: absolute, in the picker root, anchored to its field",
      pass:
        ac.shown &&
        ac.parentIsRoot &&
        ac.position === "absolute" &&
        ac.belowField &&
        ac.alignedLeft,
      detail: JSON.stringify(ac),
    });
    checks.push({
      name: "autocomplete: clipped host and page scroll leave it visible AND clickable",
      pass: ac.insideRoot && ac.clickable && ac.options > 0,
      detail: JSON.stringify(ac),
    });

    // 3. Layout holds together in a narrow pane
    const layout = await browser.evaluate(() => {
      const root = document.querySelector(".freva-picker");
      const box = (sel) => {
        const el = root.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width };
      };
      const rootBox = root.getBoundingClientRect();
      const uris = [...root.querySelectorAll(".fp-uri")].map((el) => ({
        right: el.getBoundingClientRect().right,
        clipped: el.scrollWidth > el.clientWidth + 1,
      }));
      return {
        root: { left: rootBox.left, right: rootBox.right },
        foot: box(".fp-foot"),
        add: box(".fp-add"),
        // The footer's status region: the mode radio group when "all filtered" is offered (the
        // default), the plain count when the feature is switched off. Either way it is the thing
        // the action must not sit on top of.
        count: box(".fp-modes, .fp-count"),
        files: box(".fp-files"),
        side: box(".fp-side"),
        uris,
      };
    });
    checks.push({
      name: "long URIs are clipped inside the pane, not pushed past its edge",
      pass:
        layout.uris.length > 0 &&
        layout.uris.every((u) => u.right <= layout.root.right + 0.5) &&
        layout.uris.some((u) => u.clipped),
      detail: JSON.stringify({
        overflowing: layout.uris.filter((u) => u.right > layout.root.right + 0.5).length,
        clipped: layout.uris.filter((u) => u.clipped).length,
      }),
    });
    checks.push({
      name: "the primary action and the footer's status region never overlap",
      pass: !!layout.add && !!layout.count && !overlaps(layout.add, layout.count),
      detail: JSON.stringify({ add: layout.add, count: layout.count }),
    });
    checks.push({
      name: "filters and the file panel are side by side, not stacked on top of each other",
      pass: !!layout.side && !!layout.files && !overlaps(layout.side, layout.files),
      detail: JSON.stringify({ side: layout.side, files: layout.files }),
    });

    // 4. The nested result scroller recycles rows
    const scrolled = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-picker");
      const sc = root.querySelector(".fp-scroll");
      const before = root.querySelectorAll(".fp-row").length;
      const firstBefore = root.querySelector(".fp-row .fp-uri").textContent;
      sc.scrollTop = 600;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const after = root.querySelectorAll(".fp-row").length;
      const firstAfter = root.querySelector(".fp-row .fp-uri").textContent;
      return { before, after, firstBefore, firstAfter, scrolled: sc.scrollTop > 0 };
    });
    checks.push({
      name: "a nested scroll recycles rows instead of accumulating them",
      pass:
        scrolled.scrolled &&
        scrolled.after > 0 &&
        scrolled.after <= scrolled.before + 2 &&
        scrolled.firstBefore !== scrolled.firstAfter,
      detail: JSON.stringify(scrolled),
    });

    // 5. A REAL drag carries the same payload the button commits - and commits ONCE
    const drag = await browser.evaluate(async () => {
      const root = document.querySelector(".freva-picker");
      const sc = root.querySelector(".fp-scroll");
      sc.scrollTop = 0;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rows = [...root.querySelectorAll(".fp-row")];
      rows[0].click();
      rows[1].click();
      await new Promise((r) => setTimeout(r, 60));

      window.__commits = [];
      const added = []; // what a HOST would end up with

      const dt = new DataTransfer();
      rows[0].dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
      const MIME = "application/vnd.freva.data-reference+json";
      const dragged = dt.getData(MIME);
      const uriList = dt.getData("text/uri-list");
      if (dragged) added.push(JSON.parse(dragged)); // the host's drop handler

      // The browser fires dragend after the gesture. The picker must NOT also commit here, or one
      // accepted drop becomes two host-side additions.
      rows[0].dispatchEvent(
        new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
      await new Promise((r) => setTimeout(r, 40));
      const commitsAfterDrag = window.__commits.length;

      // …and the Add button does the identical operation, through onCommit.
      root.querySelector(".fp-add").click();
      await new Promise((r) => setTimeout(r, 30));
      const committed = JSON.stringify(window.__commits[0] ?? null);

      return {
        picked: rows.filter((r) => r.classList.contains("picked")).length,
        commitsAfterDrag,
        hostAdditionsForOneDrop: added.length,
        same: dragged === committed,
        kind: JSON.parse(dragged || "{}").kind,
        uriListLines: uriList ? uriList.split("\r\n").length : 0,
        addEnabled: !root.querySelector(".fp-add").disabled,
        stillPicked: rows[0].classList.contains("picked"),
      };
    });
    checks.push({
      name: "one accepted drag produces exactly ONE host-side addition (dragend does not commit)",
      pass: drag.commitsAfterDrag === 0 && drag.hostAdditionsForOneDrop === 1,
      detail: JSON.stringify(drag),
    });
    checks.push({
      name: "the drag payload is byte-identical to what the Add button commits",
      pass: drag.picked === 2 && drag.same && drag.kind === "selection",
      detail: JSON.stringify(drag),
    });
    checks.push({
      name: "remote assets also populate text/uri-list, and the button stays operable",
      pass: drag.uriListLines === 2 && drag.addEnabled && drag.stillPicked,
      detail: JSON.stringify(drag),
    });

    // 6. The listbox keyboard pattern, in a real engine
    const keyboard = await browser.evaluate(async () => {
      const root = document.querySelectorAll(".freva-picker")[1];
      const sc = root.querySelector(".fp-scroll");
      const press = (key) =>
        sc.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      const activeText = () => {
        const id = sc.getAttribute("aria-activedescendant");
        return id ? (root.querySelector("#" + id + " .fp-uri")?.textContent ?? "") : "";
      };
      sc.focus();
      const listboxFocused = document.activeElement === sc;
      press("ArrowDown");
      const first = activeText();
      press("ArrowDown");
      const second = activeText();
      press("End");
      const atEnd = activeText();
      // The end of a 60-row list is well outside the initial window, so this only works if the
      // active option was scrolled into view AND materialised before aria-activedescendant moved.
      const endIsInDom = !!root.querySelector("#" + sc.getAttribute("aria-activedescendant"));
      press("Home");
      const backHome = activeText();
      press("Enter");
      await new Promise((r) => setTimeout(r, 40));
      return {
        listboxFocused,
        // Focus NEVER moves off the listbox, so recycling a row cannot strand it.
        stillFocused: document.activeElement === sc,
        first,
        second,
        atEnd,
        endIsInDom,
        backHome,
        activeAfterSelect: activeText(),
        selected: root.querySelectorAll('.fp-row[aria-selected="true"]').length,
        addEnabled: !root.querySelector(".fp-add").disabled,
        addLabel: root.querySelector(".fp-add").getAttribute("aria-label"),
      };
    });
    checks.push({
      name: "keyboard: Arrow Up/Down and Home/End move the active option, End materialising it",
      pass:
        keyboard.listboxFocused &&
        keyboard.first !== "" &&
        keyboard.second !== keyboard.first &&
        keyboard.atEnd !== keyboard.first &&
        keyboard.endIsInDom &&
        keyboard.backHome === keyboard.first,
      detail: JSON.stringify(keyboard),
    });
    checks.push({
      name: "keyboard: Enter selects, focus stays on the listbox, and the action becomes operable",
      pass:
        keyboard.stillFocused &&
        keyboard.selected === 1 &&
        keyboard.activeAfterSelect === keyboard.first &&
        keyboard.addEnabled &&
        /1 file$/.test(keyboard.addLabel ?? ""),
      detail: JSON.stringify(keyboard),
    });

    // 7. The active-descendant lifecycle under real recycling
    const roving = await browser.evaluate(async () => {
      const root = document.querySelectorAll(".freva-picker")[0];
      const sc = root.querySelector(".fp-scroll");
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const press = (key) =>
        sc.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      const id = () => sc.getAttribute("aria-activedescendant");
      const namesLive = () => id() === null || !!root.querySelector("#" + id());

      sc.scrollTop = 0;
      await frame();
      sc.focus();
      press("ArrowDown"); // activate option zero
      const activated = id();
      const afterActivate = namesLive();

      // Scroll far enough that option zero is genuinely recycled out of the DOM.
      sc.scrollTop = sc.scrollHeight;
      await frame();
      await new Promise((r) => setTimeout(r, 50));
      const optionZeroGone = !root.querySelector("#" + activated);
      const afterScroll = namesLive();
      const idAfterScroll = id();

      // A new query replaces the whole result set; the id must not survive that either.
      root.querySelector(".fp-scroll").scrollTop = 0;
      await frame();
      press("ArrowDown");
      const beforeRequery = id();
      [...root.querySelectorAll(".fp-v")]
        .find((b) => /cmip6/.test(b.getAttribute("aria-label")))
        ?.click();
      await new Promise((r) => setTimeout(r, 250));
      return {
        activated,
        afterActivate,
        optionZeroGone,
        afterScroll,
        idAfterScroll,
        beforeRequery,
        afterRequery: id(),
        namesLiveAtEnd: namesLive(),
        posinset: root.querySelector(".fp-row")?.getAttribute("aria-posinset"),
        setsize: root.querySelector(".fp-row")?.getAttribute("aria-setsize"),
      };
    });
    checks.push({
      name: "activation → scroll: recycling the active row never leaves a dangling descendant id",
      pass:
        !!roving.activated &&
        roving.afterActivate &&
        roving.optionZeroGone &&
        roving.afterScroll &&
        roving.idAfterScroll === null,
      detail: JSON.stringify(roving),
    });
    checks.push({
      name: "activation → new result set: the descendant id is cleared with the options",
      pass: !!roving.beforeRequery && roving.afterRequery === null && roving.namesLiveAtEnd,
      detail: JSON.stringify(roving),
    });
    checks.push({
      name: "materialised options carry aria-posinset / aria-setsize for the full result set",
      pass: roving.posinset === "1" && Number(roving.setsize) >= 12,
      detail: JSON.stringify({ posinset: roving.posinset, setsize: roving.setsize }),
    });

    // 8. The options are actually in the accessibility tree
    const a11y = await browser.evaluate(() => {
      const root = document.querySelector(".freva-picker");
      const sc = root.querySelector(".fp-scroll");
      const options = [...root.querySelectorAll('[role="option"].fp-row')];
      let hiddenBy = null;
      for (const opt of options) {
        for (let n = opt; n && n !== sc; n = n.parentElement) {
          if (n.getAttribute("aria-hidden") === "true") hiddenBy = n.className;
        }
      }
      return {
        role: sc.getAttribute("role"),
        multi: sc.getAttribute("aria-multiselectable"),
        options: options.length,
        hiddenBy,
        spacerRole: root.querySelector(".fp-vspace")?.getAttribute("role"),
        rowsRole: root.querySelector(".fp-vrows")?.getAttribute("role"),
        spacerHidden: root.querySelector(".fp-vspace")?.getAttribute("aria-hidden"),
      };
    });
    checks.push({
      name: "virtualised options are exposed: no aria-hidden ancestor, wrappers are presentational",
      pass:
        a11y.role === "listbox" &&
        a11y.multi === "true" &&
        a11y.options > 0 &&
        a11y.hiddenBy === null &&
        a11y.spacerRole === "presentation" &&
        a11y.rowsRole === "presentation" &&
        a11y.spacerHidden === null,
      detail: JSON.stringify(a11y),
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("picker: embedded host, two instances, drag == button, keyboard", result));
