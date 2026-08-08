// Production hardening: responsive chips, the embedded-host overlay fixture, the
// 1,000-row interaction cost, aggregate arithmetic under partial metadata failure, oversized
// selected exports, optional brand/footer, and the optional date picker.

import "./helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  downloadHrefs,
  fetchCalls,
  installFetch,
  makeHost,
  overviewResponse,
  searchResponse,
  tick,
  wait,
  window as win,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";
import { MANY_RESULTS_THRESHOLD, MAX_SELECTED_FILES } from "../src/types.js";
import type { DataBrowserConfig, DataBrowserHandle } from "../src/types.js";
import { STYLES } from "../src/styles.js";

const q = <T extends Element>(r: ParentNode, s: string): T | null => r.querySelector<T>(s);
const qa = <T extends Element>(r: ParentNode, s: string): T[] => [...r.querySelectorAll<T>(s)];

function router(rows: Array<{ file: string }>, facets?: Record<string, Array<string | number>>) {
  return (call: { url: string }): Record<string, unknown> => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/file?") && /[?&]file=/.test(call.url)) {
      return { body: { search_results: [{ file: "/x" }], facets: { project: ["p", 1] } } };
    }
    return { body: searchResponse({ total: rows.length, rows, facets, primary: ["project"] }) };
  };
}

async function mount(
  r: (c: { url: string }) => Record<string, unknown>,
  cfg: DataBrowserConfig = {},
): Promise<{ handle: DataBrowserHandle; root: HTMLElement }> {
  installFetch(r as never);
  const host = makeHost();
  const handle = mountDataBrowser(host, cfg);
  await wait(40);
  return { handle, root: host.querySelector(".freva-db") as HTMLElement };
}

// mobile chips and the top row

test("a chip's label is bounded and ellipsised, with the full value still reachable", async () => {
  const long = "a".repeat(200);
  const { handle, root } = await mount(
    router([{ file: "/a.nc" }], { project: [long, 2, "cordex", 1] }),
  );
  // apply the long value through the sidebar
  qa<HTMLElement>(root, ".facet-head")
    .find((h) => /project/i.test(h.textContent ?? ""))
    ?.click();
  await tick();
  qa<HTMLElement>(root, ".side-scroll .fval")
    .find((n) => (n.textContent ?? "").includes(long))
    ?.click();
  await wait(320);
  const chip = q<HTMLElement>(root, ".chips .chip");
  assert.ok(chip, "the long value became a chip");
  const label = q<HTMLElement>(chip!, ".chip-label");
  assert.ok(label, "the text lives in a .chip-label wrapper, not bare in the chip");
  assert.ok((label!.textContent ?? "").includes(long), "the label carries the FULL value");
  assert.match(
    label!.getAttribute("data-tip") ?? label!.getAttribute("title") ?? "",
    /aaaa/,
    "…and it is reachable as a tooltip when the text is clipped",
  );
  assert.match(
    chip!.getAttribute("aria-label") ?? "",
    /Remove/,
    "the chip still says what it removes",
  );
  // The bound and the ellipsis are CSS; assert the rules exist rather than faking layout in jsdom.
  assert.match(STYLES, /\.chip-label\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(STYLES, /\.chip-label\s*\{[^}]*max-inline-size/);
  assert.match(STYLES, /\.chip\s*\{[^}]*min-width:\s*0/);
  handle.destroy();
});

test("the top row wraps deterministically at 320 / 375 / 390 px, with nothing overlapping", () => {
  // jsdom performs no layout, so the CONTRACT is asserted on the rules themselves: at phone widths
  // the chips take a full-width row, the other two items follow on the next one, and no item is
  // taken out of flow. A media query that only fires below 320px would be useless, so the
  // breakpoint is checked to cover all three sizes.
  const block = STYLES.slice(STYLES.indexOf("@media (max-width: 430px)"));
  const scoped = block.slice(0, block.indexOf("\n}\n\n") + 3);
  for (const width of [320, 375, 390]) {
    assert.ok(width <= 430, `${width}px is inside the phone breakpoint`);
  }
  assert.match(scoped, /\.toprow\s*\{[^}]*flex-wrap:\s*wrap/, "the row is allowed to wrap");
  assert.match(
    scoped,
    /\.chips\s*\{[^}]*flex:\s*1 0 100%/,
    "chips occupy their own full-width row",
  );
  assert.match(
    scoped,
    /\.ctrl-cluster\s*\{[^}]*margin-left:\s*auto/,
    "the cluster follows, right-aligned",
  );
  assert.doesNotMatch(scoped, /position:\s*absolute/, "nothing is taken out of flow");
  // An empty chip row must collapse rather than leave a blank strip.
  assert.match(STYLES, /\.chips\.empty\s*\{\s*display:\s*none/);
});

test("an empty chip row is marked empty; adding a filter un-marks it", async () => {
  const { handle, root } = await mount(router([{ file: "/a.nc" }], { project: ["cmip6", 2] }));
  assert.ok(q(root, ".chips.empty"), "no filters -> the row collapses");
  qa<HTMLElement>(root, ".facet-head")
    .find((h) => /project/i.test(h.textContent ?? ""))
    ?.click();
  await tick();
  qa<HTMLElement>(root, ".side-scroll .fval")[0]?.click();
  await wait(320);
  assert.equal(q(root, ".chips.empty"), null, "a filter brings the row back");
  handle.destroy();
});

// the 1,000-row interaction cost

test("with 1,000 rows a single focus/pick does not touch every row node", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ file: `/f_${i}.nc` }));
  const { handle, root } = await mount(router(rows));
  q<HTMLButtonElement>(root, '.seg [aria-label="List view"]')?.click();
  await tick();
  const nodes = qa<HTMLElement>(root, "#fdb-results .row");
  assert.equal(nodes.length, 1000, "the full loaded set is rendered - pagination is unchanged");

  // Instrument every row so any classList/attribute write is counted.
  let touched = 0;
  const marks = nodes.map((n) => {
    const original = n.classList.toggle.bind(n.classList);
    (n.classList as unknown as { toggle: unknown }).toggle = (...args: unknown[]) => {
      touched++;
      return original(...(args as [string, boolean?]));
    };
    return original;
  });

  nodes[500].click(); // focus one row
  await tick();
  assert.ok(
    touched <= 6,
    `a focus change patches only the rows involved (touched ${touched} of 1000)`,
  );

  touched = 0;
  (nodes[500].querySelector(".cb") as HTMLElement).click(); // pick it
  await tick();
  assert.ok(touched <= 6, `a pick patches only the changed row (touched ${touched} of 1000)`);

  // A BULK action is the one case allowed a full pass - and it must stay bounded by the cap.
  touched = 0;
  (q<HTMLElement>(root, ".selall") as HTMLElement).click();
  await tick();
  assert.equal(
    handle.getState().pickedKeys.size,
    MAX_SELECTED_FILES,
    "bulk selection stays capped",
  );
  assert.ok(touched >= 1000, "…and IS the case that legitimately sweeps the list");
  marks.forEach((original, i) => {
    (nodes[i].classList as unknown as { toggle: unknown }).toggle = original;
  });
  handle.destroy();
});

test("a large loaded set drops the side-panel width tweens instead of re-laying-out per frame", async () => {
  const rows = Array.from({ length: MANY_RESULTS_THRESHOLD }, (_, i) => ({ file: `/f_${i}.nc` }));
  const { handle, root } = await mount(router(rows));
  assert.ok(
    root.classList.contains("many-results"),
    `${MANY_RESULTS_THRESHOLD} loaded rows is the documented threshold`,
  );
  assert.match(
    STYLES,
    /\.many-results\s+\.side,[\s\S]{0,80}\.details-panel\s*\{\s*transition:\s*none/,
    "the sidebar and details panel stop animating their width",
  );
  // …and the row-level skip-work properties are present with a real intrinsic size.
  assert.match(STYLES, /\.rows\s*>\s*\.row\s*\{[^}]*content-visibility:\s*auto/);
  assert.match(STYLES, /\.rows\s*>\s*\.row\s*\{[^}]*contain-intrinsic-size:/);
  handle.destroy();
});

test("a small result set does NOT get the many-results treatment", async () => {
  const { handle, root } = await mount(router([{ file: "/a.nc" }]));
  assert.ok(!root.classList.contains("many-results"));
  handle.destroy();
});

// aggregate arithmetic and oversized exports

test("metadata failures do not turn a multi-file action into a single-file one", async () => {
  const rows = [{ file: "/d/a.nc" }, { file: "/d/b.nc" }, { file: "/d/c.nc" }];
  // Only /d/a.nc returns metadata; the other two fail.
  const r = (call: { url: string }): Record<string, unknown> => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/file?") && /[?&]file=/.test(call.url)) {
      return /a\.nc/.test(call.url)
        ? { body: { search_results: [{ file: "/d/a.nc" }], facets: { project: ["p", 1] } } }
        : { status: 500, body: { detail: "boom" } };
    }
    return { body: searchResponse({ total: 3, rows }) };
  };
  const { handle, root } = await mount(r, { authEnabled: true, enableHeavyOps: true });
  q<HTMLButtonElement>(root, '.seg [aria-label="List view"]')?.click();
  await tick();
  for (const cb of qa<HTMLElement>(root, "#fdb-results .cb")) {
    cb.click();
    await tick();
  }
  q<HTMLButtonElement>(root, '[aria-label="Details panel"]')!.click();
  await wait(120);
  assert.equal(handle.getState().pickedKeys.size, 3);
  const actions = q<HTMLElement>(root, ".info-actions");
  assert.ok(actions, "the actions block rendered");
  const labels = qa<HTMLElement>(actions!, ".btn").map((b) => b.textContent ?? "");
  assert.ok(
    !labels.some((l) => l.includes("Inspect data")),
    "3 files are selected, so this is NOT the single-file Inspect action - even though only 1 loaded",
  );
  assert.ok(
    labels.some((l) => l.includes("Aggregate")),
    "it stays the multi-file action",
  );
  assert.match(
    q<HTMLElement>(actions!, ".scope-note")?.textContent ?? "",
    /3 picks/,
    "the scope note counts the SELECTION, not the rows whose metadata loaded",
  );
  handle.destroy();
});

test("with 25 selected, Aggregate asks for 15 to be deselected", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ file: `/f_${i}.nc` }));
  const { handle, root } = await mount(router(rows), {
    authEnabled: true,
    enableHeavyOps: true,
  });
  (q<HTMLElement>(root, ".selall") as HTMLElement).click();
  await tick();
  assert.equal(handle.getState().pickedKeys.size, 25);
  const agg = qa<HTMLButtonElement>(root, ".pickbar .btn").find((b) =>
    (b.textContent ?? "").includes("Aggregate"),
  )!;
  const why = agg.getAttribute("data-tip") ?? agg.getAttribute("title") ?? "";
  assert.match(why, /up to 10 files/, "the aggregate cap is named");
  assert.match(why, /deselect 15/i, "25 selected - 10 allowed = 15 to deselect");
  handle.destroy();
});

test("an oversized selected export is refused before it is sent, and 414 is handled", async () => {
  // Deep paths: 25 of these exceed the conservative URL ceiling even at the selection cap.
  const deep = "/archive/" + "segment/".repeat(40);
  const rows = Array.from({ length: 30 }, (_, i) => ({ file: `${deep}file_${i}.nc` }));
  const { handle, root } = await mount(router(rows));
  (q<HTMLElement>(root, ".selall") as HTMLElement).click();
  await tick();
  const before = fetchCalls.length;
  qa<HTMLButtonElement>(root, ".pickbar .btn")
    .find((b) => (b.textContent ?? "").includes("Download"))!
    .click();
  await tick();
  qa<HTMLElement>(root, ".export-pop .xm-item")[0].click();
  await wait(60);
  assert.equal(fetchCalls.length, before, "nothing was sent - the URL was measured first");
  assert.equal(downloadHrefs.length, 0, "…and no download was triggered");
  assert.match(
    q<HTMLElement>(root, ".status .mono")?.textContent ?? "",
    /select fewer files/i,
    "the message names the actual remedy",
  );
  handle.destroy();
});

test("a 414 from the server is reported as a length problem, not a mystery status", async () => {
  const rows = [{ file: "/a.nc" }, { file: "/b.nc" }];
  const r = (call: { url: string }): Record<string, unknown> => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/intake-catalogue/")) return { status: 414, body: {} };
    return { body: searchResponse({ total: 2, rows }) };
  };
  const { handle, root } = await mount(r);
  (q<HTMLElement>(root, ".selall") as HTMLElement).click();
  await tick();
  qa<HTMLButtonElement>(root, ".pickbar .btn")
    .find((b) => (b.textContent ?? "").includes("Download"))!
    .click();
  await tick();
  qa<HTMLElement>(root, ".export-pop .xm-item")[0].click();
  await wait(80);
  assert.match(
    q<HTMLElement>(root, ".status .mono")?.textContent ?? "",
    /too long/i,
    "HTTP 414 is explained in terms the user can act on",
  );
  handle.destroy();
});

test("selected remote files open as a list of individual links, never an auto-download burst", async () => {
  const rows = [
    { file: "https://e.org/a.nc" },
    { file: "/archive/local.nc" },
    { file: "https://e.org/b.grib2" },
  ];
  const { handle, root } = await mount(router(rows));
  q<HTMLButtonElement>(root, '.seg [aria-label="List view"]')?.click();
  await tick();
  for (const cb of qa<HTMLElement>(root, "#fdb-results .cb")) {
    cb.click();
    await tick();
  }
  qa<HTMLButtonElement>(root, ".pickbar .btn")
    .find((b) => (b.textContent ?? "").includes("Download"))!
    .click();
  await tick();
  const entry = qa<HTMLElement>(root, ".export-pop .xm-item").find((i) =>
    /Remote source files/.test(i.textContent ?? ""),
  );
  assert.ok(entry, "the selection menu offers the eligible remote files");
  assert.match(entry!.textContent ?? "", /\(2\)/, "…counted");
  assert.match(entry!.textContent ?? "", /1 selected file/, "…and says what was skipped");
  entry!.click();
  await tick();
  const links = qa<HTMLAnchorElement>(root, ".dl-pop .dl-item");
  assert.equal(links.length, 2, "one anchor per eligible file, in selection order");
  assert.equal(links[0].getAttribute("href"), "https://e.org/a.nc");
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
  assert.equal(links[0].getAttribute("target"), "_blank");
  assert.equal(links[0].getAttribute("download"), "a.nc");
  assert.equal(
    downloadHrefs.length,
    0,
    "nothing downloaded on its own - the user clicks one file at a time",
  );
  handle.destroy();
});

// brand and footer

const brandCases: Array<[string, DataBrowserConfig, boolean, boolean]> = [
  ["defaults", {}, true, true],
  ["mark only", { brand: { showTitle: false } }, true, false],
  ["title only", { brand: { showMark: false } }, false, true],
  ["neither", { brand: { showMark: false, showTitle: false } }, false, false],
];
for (const [name, cfg, wantMark, wantTitle] of brandCases) {
  test(`brand: ${name}`, async () => {
    const { handle, root } = await mount(router([{ file: "/a.nc" }]), cfg);
    const brand = q<HTMLElement>(root, ".top .brand");
    if (!wantMark && !wantTitle) {
      assert.equal(brand, null, "with both off the wrapper is omitted, so it consumes no space");
    } else {
      assert.ok(brand, "the brand block is present");
      assert.equal(
        !!brand!.querySelector(".brand-logo, .mark"),
        wantMark,
        `mark ${wantMark ? "shown" : "hidden"}`,
      );
      assert.equal(
        (brand!.textContent ?? "").includes("Freva"),
        wantTitle,
        `title ${wantTitle ? "shown" : "hidden"}`,
      );
    }
    handle.destroy();
  });
}

test("features.brand=false still removes the whole block regardless of the new options", async () => {
  const { handle, root } = await mount(router([{ file: "/a.nc" }]), {
    features: { brand: false },
    brand: { showMark: true, showTitle: true },
  });
  assert.equal(q(root, ".top .brand"), null);
  handle.destroy();
});

test("features.footer=false removes the strip but KEEPS screen-reader status", async () => {
  const { handle, root } = await mount(router([{ file: "/a.nc" }]), {
    features: { footer: false },
  });
  assert.equal(q(root, ".fdb-app > .status"), null, "the footer consumes no grid row");
  assert.ok(q(root, ".fdb-app.no-footer"), "the grid drops to two rows");
  const sr = q<HTMLElement>(root, ".sr-status");
  assert.ok(sr, "an off-screen live region takes over");
  assert.ok(!sr!.closest(".fdb-app"), "…and it lives OUTSIDE the grid");
  assert.equal(sr!.getAttribute("aria-live"), "polite");
  assert.ok(sr!.querySelector(".mono"), "the status message node moved with it");
  assert.ok(sr!.querySelector(".status-dot"), "…and so did the severity dot");
  // `display:none` would remove it from the accessibility tree, silencing the live region.
  assert.match(STYLES, /\.sr-status\s*\{[^}]*clip-path/);
  assert.doesNotMatch(STYLES, /\.sr-status\s*\{[^}]*display:\s*none/);
  assert.ok(q(root, ".toast-host"), "visual toasts remain available");
  handle.destroy();
});

test("features.footer=true (the default) keeps the visible strip and no off-screen duplicate", async () => {
  const { handle, root } = await mount(router([{ file: "/a.nc" }]));
  assert.ok(q(root, ".fdb-app > .status"), "the footer is present by default");
  assert.equal(q(root, ".sr-status"), null, "…with no duplicate live region");
  handle.destroy();
});

// the search spinner

test("every loading state shows the in-field spinner, including a re-search over old rows", async () => {
  let slow = false;
  const r = (call: { url: string }): Record<string, unknown> => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    return {
      body: searchResponse({
        total: 1,
        rows: [{ file: "/a.nc" }],
        facets: { project: ["cmip6", 1] },
        primary: ["project"],
      }),
      ...(slow ? { delayMs: 200 } : {}),
    };
  };
  const { handle, root } = await mount(r);
  const spin = q<HTMLElement>(root, ".search-spin")!;
  const region = q<HTMLElement>(root, ".search")!;
  assert.ok(!spin.classList.contains("show"), "idle: no spinner");
  assert.equal(region.getAttribute("aria-busy"), "false");
  // Re-search while rows are already on screen - the case the count-only spinner missed.
  slow = true;
  qa<HTMLElement>(root, ".facet-head")
    .find((h) => /project/i.test(h.textContent ?? ""))
    ?.click();
  await tick();
  qa<HTMLElement>(root, ".side-scroll .fval")[0]?.click();
  await wait(300);
  assert.ok(spin.classList.contains("show"), "the in-field spinner shows for a re-search");
  assert.equal(region.getAttribute("aria-busy"), "true");
  assert.equal(
    q<HTMLElement>(root, ".search .sr-only")?.textContent,
    "Searching",
    "…with a screen-reader equivalent",
  );
  await wait(300);
  assert.ok(!spin.classList.contains("show"), "and it clears when the search settles");
  assert.equal(q<HTMLElement>(root, ".search .sr-only")?.textContent, "");
  handle.destroy();
});

test("the spinner reserves its slot, so showing it shifts nothing", () => {
  assert.match(STYLES, /\.search-spin\s*\{[^}]*visibility:\s*hidden/);
  assert.match(STYLES, /\.search-spin\.show\s*\{\s*visibility:\s*visible/);
  assert.doesNotMatch(
    STYLES,
    /\.search-spin\s*\{[^}]*display:\s*none/,
    "display:none would reflow the field when the spinner appears",
  );
  // Reduced motion still shows a BUSY mark, just not an animated one.
  const rm = STYLES.slice(STYLES.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(rm, /\.search-spin \.spin\s*\{[^}]*animation:\s*none/);
});

// optional native date picking

test("the calendar button copies a chosen date into the text field and applies it", async () => {
  // The sidebar renders its Time/BBox panels only once a search has loaded facets.
  const { handle, root } = await mount(router([{ file: "/a.nc" }], { project: ["cmip6", 1] }));
  q<HTMLButtonElement>(root, '.special[aria-label="Edit time range"]')!.click();
  await tick();
  const editor = q<HTMLElement>(root, ".editor")!;
  const from = qa<HTMLInputElement>(editor, ".daterow input.date-text")[0];
  const to = qa<HTMLInputElement>(editor, ".daterow input.date-text")[1];
  const pickers = qa<HTMLInputElement>(editor, ".daterow input.date-native");
  assert.equal(pickers.length, 2, "one native picker per bound");
  assert.equal(pickers[0].getAttribute("tabindex"), "-1", "it is not a second tab stop");
  const buttons = qa<HTMLButtonElement>(editor, ".date-pick");
  assert.match(
    buttons[0].getAttribute("aria-label") ?? "",
    /from date/i,
    "specific accessible name",
  );
  assert.match(buttons[1].getAttribute("aria-label") ?? "", /to date/i);

  // showPicker is absent in jsdom, so this also exercises the documented fallback path.
  buttons[0].click();
  pickers[0].value = "2001-02-03";
  pickers[0].dispatchEvent(new win.Event("change", { bubbles: true }));
  to.value = "2010";
  to.dispatchEvent(new win.Event("change", { bubbles: true }));
  await wait(320);
  assert.equal(from.value, "2001-02-03", "the ISO date landed in the TEXT field");
  assert.deepEqual(handle.getState().time, {
    from: "2001-02-03",
    to: "2010",
    mode: "flexible",
  });
  handle.destroy();
});

test("partial, open and manual values survive the picker untouched", async () => {
  // The sidebar renders its Time/BBox panels only once a search has loaded facets.
  const { handle, root } = await mount(router([{ file: "/a.nc" }], { project: ["cmip6", 1] }));
  q<HTMLButtonElement>(root, '.special[aria-label="Edit time range"]')!.click();
  await tick();
  const editor = q<HTMLElement>(root, ".editor")!;
  const [from, to] = qa<HTMLInputElement>(editor, ".daterow input.date-text");
  const pickers = qa<HTMLInputElement>(editor, ".daterow input.date-native");

  for (const partial of ["2000", "2000-05", "2000-05-06 12:30"]) {
    from.value = partial;
    from.dispatchEvent(new win.Event("change", { bubbles: true }));
    assert.equal(
      pickers[0].value,
      "",
      `"${partial}" cannot be represented by a native date input, so it is left alone`,
    );
    assert.equal(from.value, partial, "…and the text field is not rewritten");
  }
  // A COMPLETE date does synchronise into the picker.
  from.value = "1999-12-31";
  from.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.equal(pickers[0].value, "1999-12-31");
  // An open upper bound still works end to end.
  from.value = "2000";
  to.value = "";
  from.dispatchEvent(new win.Event("change", { bubbles: true }));
  await wait(320);
  assert.deepEqual(handle.getState().time, { from: "2000", to: "", mode: "flexible" });
  // Clearing the picker does NOT wipe what the user typed.
  pickers[0].value = "";
  pickers[0].dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.equal(from.value, "2000", "an empty picker change is ignored");
  // An invalid manual date is refused by the SAME validation a typed date goes through.
  from.value = "2023-02-31";
  from.dispatchEvent(new win.Event("change", { bubbles: true }));
  await wait(320);
  assert.notEqual(handle.getState().time?.from, "2023-02-31", "an impossible date never commits");
  handle.destroy();
});

test("Clear removes the range even after the picker was used", async () => {
  // The sidebar renders its Time/BBox panels only once a search has loaded facets.
  const { handle, root } = await mount(router([{ file: "/a.nc" }], { project: ["cmip6", 1] }));
  q<HTMLButtonElement>(root, '.special[aria-label="Edit time range"]')!.click();
  await tick();
  const editor = q<HTMLElement>(root, ".editor")!;
  const pickers = qa<HTMLInputElement>(editor, ".daterow input.date-native");
  pickers[0].value = "2001-02-03";
  pickers[0].dispatchEvent(new win.Event("change", { bubbles: true }));
  await wait(320);
  assert.ok(handle.getState().time, "a range is set");
  qa<HTMLButtonElement>(root, ".editor .actions .btn")
    .find((b) => (b.textContent ?? "").includes("Clear"))!
    .click();
  await wait(320);
  assert.equal(handle.getState().time, null, "Clear still clears");
  handle.destroy();
});
