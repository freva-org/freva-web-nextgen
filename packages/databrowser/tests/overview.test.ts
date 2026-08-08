// Metadata-focused block controls: sort, collapse, additional facets, and card sizing.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFetch, makeHost, overviewResponse, searchResponse, wait } from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";

function q<T extends Element = Element>(r: ParentNode, s: string): T | null {
  return r.querySelector<T>(s);
}
function qa<T extends Element = Element>(r: ParentNode, s: string): T[] {
  return Array.from(r.querySelectorAll<T>(s));
}

async function mountOverview(): Promise<{
  root: HTMLElement;
  destroy: () => void;
  handle: ReturnType<typeof mountDataBrowser>;
}> {
  installFetch((call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [], model: [] }) };
    if (call.url.includes("search")) {
      return {
        body: searchResponse({
          total: 6,
          rows: [{ file: "/d/a.nc" }],
          facets: { project: ["b", 1, "a", 5], model: ["m1", 3] },
          primary: ["project"], // model is "additional"
        }),
      };
    }
    return { body: {} };
  });
  const host = makeHost();
  const handle = mountDataBrowser(host, {});
  await wait(30);
  const root = q<HTMLElement>(host, ".freva-db") as HTMLElement;
  (q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]') as HTMLButtonElement).click();
  await wait(10);
  return { root, destroy: () => handle.destroy(), handle };
}

test("overview: per-block sort toggles between count and alphabetical", async () => {
  const { root, destroy } = await mountOverview();
  const card = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  const firstVal = () => q<HTMLElement>(card, ".fval .nm")?.textContent;
  assert.equal(firstVal(), "a", "default sort is by count desc (a=5 first)");
  const sortBtn = qa<HTMLButtonElement>(card, ".fcard-h .exp")[0];
  sortBtn.click();
  await wait(5);
  const card2 = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  assert.equal(q<HTMLElement>(card2, ".fval .nm")?.textContent, "a", "alpha sort: a before b");
  destroy();
});

test("overview: a block can be collapsed individually", async () => {
  const { root, destroy } = await mountOverview();
  const card = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  assert.ok(q(card, ".fcard-vals"), "values shown initially");
  const exps = qa<HTMLButtonElement>(card, ".fcard-h .exp");
  const collapseBtn = exps[exps.length - 1];
  collapseBtn.click();
  await wait(5);
  const card2 = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  assert.ok(card2.classList.contains("collapsed"), "block collapsed");
  destroy();
});

test("overview: Show additional facets reveals non-primary blocks", async () => {
  const { root, destroy } = await mountOverview();
  assert.equal(q(root, '.fcard[data-key="model"]'), null, "additional facet hidden by default");
  const addBtn = q<HTMLButtonElement>(root, ".ov-addbtn") as HTMLButtonElement;
  assert.match(addBtn.textContent ?? "", /Show additional facets/);
  addBtn.click();
  await wait(5);
  assert.ok(q(root, '.fcard[data-key="model"]'), "additional facet revealed");
  destroy();
});

test("overview: time/bbox cards are part of the family - same chrome, editor always visible", async () => {
  const { root, destroy } = await mountOverview();
  for (const key of ["__time", "__bbox"]) {
    const card = q<HTMLElement>(root, `.fcard[data-key="${key}"]`) as HTMLElement;
    assert.ok(card, `${key} card present`);
    // the SAME chrome as a facet card
    assert.ok(q(card, ".fcard-h .drag-grip"), "has the drag grip like every other card");
    assert.ok(q(card, ".fcard-h .fh-label"), "has the same label slot");
    assert.ok(q(card, ".fcard-h .badge"), "has a state badge where facet cards show their count");
    assert.ok(q(card, ".fcard-resize"), "is resizable like every other card");
    // …and the editor is visible WITHOUT having to resize the card first
    assert.ok(q(card, ".fcard-special-body .editor"), "the editor is inline by default");
  }
  assert.ok(
    q<HTMLElement>(root, '.fcard[data-key="__time"] .editor .daterow'),
    "time picker is right there",
  );
  assert.ok(
    q<HTMLElement>(root, '.fcard[data-key="__bbox"] .editor .minimap'),
    "the map is right there",
  );
  destroy();
});

test("overview: minimize actually shrinks the card rather than keeping row height", async () => {
  // block prefs persist to localStorage, so start from a known-clean slate
  try {
    window.localStorage?.removeItem("freva.db.overview");
  } catch {
    /* ignore */
  }
  const { root, destroy } = await mountOverview();
  const card = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  assert.ok(q(card, ".fcard-vals"), "values visible while expanded");
  const min = qa<HTMLButtonElement>(card, ".fcard-h .exp").find((b) =>
    /minimize/i.test(b.getAttribute("aria-label") ?? ""),
  );
  assert.ok(min, "a Minimize control exists");
  min!.click();
  await wait(10);
  const after = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  assert.ok(after.classList.contains("collapsed"), "the card is collapsed");
  assert.ok(
    !q(after, ".fcard-vals"),
    "and its values are gone (not merely hidden behind a full-height box)",
  );
  destroy();
  try {
    window.localStorage?.removeItem("freva.db.overview");
  } catch {
    /* ignore */
  }
});

test("overview: a resized card can be reset to its default size", async () => {
  // block prefs persist to localStorage, so start from a known-clean slate
  try {
    window.localStorage?.removeItem("freva.db.overview");
  } catch {
    /* ignore */
  }
  const { root, destroy } = await mountOverview();
  const card = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  assert.equal(
    qa<HTMLButtonElement>(card, ".fcard-h .exp").filter((b) =>
      /reset/i.test(b.getAttribute("aria-label") ?? ""),
    ).length,
    0,
    "no Reset offered while the card is at its default size",
  );

  const w = root.ownerDocument.defaultView as unknown as {
    MouseEvent: typeof MouseEvent;
    PointerEvent?: typeof MouseEvent;
  };
  const handle = q<HTMLElement>(card, ".fcard-resize") as HTMLElement;
  handle.dispatchEvent(
    new (w.PointerEvent ?? w.MouseEvent)("pointerdown", {
      bubbles: true,
      clientX: 100,
      clientY: 100,
    }),
  );
  window.dispatchEvent(
    new (w.PointerEvent ?? w.MouseEvent)("pointermove", {
      bubbles: true,
      clientX: 340,
      clientY: 260,
    }),
  ); // wider AND taller
  window.dispatchEvent(
    new (w.PointerEvent ?? w.MouseEvent)("pointerup", {
      bubbles: true,
      clientX: 340,
      clientY: 260,
    }),
  );
  await wait(10);

  const grown = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  const reset = qa<HTMLButtonElement>(grown, ".fcard-h .exp").find((b) =>
    /reset/i.test(b.getAttribute("aria-label") ?? ""),
  );
  assert.ok(reset, "once off-default, a Reset size control appears");
  reset!.click();
  await wait(10);
  const back = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  assert.equal(back.style.gridColumn, "span 1", "span is back to default");
  assert.equal(back.style.height, "", "and so is the height");
  destroy();
});

test("overview drag: no native HTML5 draggable; grip starts reorder, corner starts resize", async () => {
  const { root, destroy } = await mountOverview();
  const card = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  const w = root.ownerDocument.defaultView as unknown as {
    MouseEvent: typeof MouseEvent;
    PointerEvent?: typeof MouseEvent;
  };
  // the card must NOT be natively draggable (native drag hijacks resize and blocks inputs)
  assert.notEqual(card.getAttribute("draggable"), "true", "card is not native-draggable");
  assert.ok(q(card, ".drag-grip"), "has a reorder grip");
  assert.ok(q(card, ".fcard-resize"), "has a resize corner");

  // grip -> reorder gesture toggles the dragging affordance and clears it on mouseup
  const grip = q<HTMLElement>(card, ".drag-grip") as HTMLElement;
  grip.dispatchEvent(
    new (w.PointerEvent ?? w.MouseEvent)("pointerdown", {
      bubbles: true,
      clientX: 50,
      clientY: 50,
    }),
  );
  assert.ok(card.classList.contains("dragging"), "reorder started from the grip");
  assert.ok(
    root.ownerDocument.body.classList.contains("fdb-dragging"),
    "drag mode set (suppresses selection)",
  );
  window.dispatchEvent(
    new (w.PointerEvent ?? w.MouseEvent)("pointerup", { bubbles: true, clientX: 50, clientY: 50 }),
  );
  await wait(5);
  assert.ok(
    !root.ownerDocument.body.classList.contains("fdb-dragging"),
    "drag mode cleared on mouseup",
  );

  // corner -> resize still grows the span
  const card2 = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  const handle = q<HTMLElement>(card2, ".fcard-resize") as HTMLElement;
  handle.dispatchEvent(
    new (w.PointerEvent ?? w.MouseEvent)("pointerdown", {
      bubbles: true,
      clientX: 100,
      clientY: 100,
    }),
  );
  window.dispatchEvent(
    new (w.PointerEvent ?? w.MouseEvent)("pointermove", {
      bubbles: true,
      clientX: 400,
      clientY: 100,
    }),
  );
  window.dispatchEvent(
    new (w.PointerEvent ?? w.MouseEvent)("pointerup", {
      bubbles: true,
      clientX: 400,
      clientY: 100,
    }),
  );
  await wait(5);
  const card3 = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  // Assert the gesture GREW the span, not an exact width. The cap comes from
  // columnCount(), which counts resolved grid tracks - under jsdom nothing is
  // laid out, so that count follows the CSS source text and shifts whenever the
  // stylesheet is reformatted.
  const grown = Number(/span (\d+)/.exec(card3.style.gridColumn)?.[1] ?? "1");
  assert.ok(grown > 1, `resize grew the column span (got "${card3.style.gridColumn}")`);
  destroy();
});

test("overview: resizing snaps to BLOCKS - whole columns, and at most one extra row", async () => {
  try {
    window.localStorage?.removeItem("freva.db.overview");
  } catch {
    /* ignore */
  }
  const { root, destroy } = await mountOverview();
  const w = root.ownerDocument.defaultView as unknown as {
    MouseEvent: typeof MouseEvent;
    PointerEvent?: typeof MouseEvent;
  };
  const drag = (dx: number, dy: number): void => {
    const card = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
    const handle = q<HTMLElement>(card, ".fcard-resize") as HTMLElement;
    handle.dispatchEvent(
      new (w.PointerEvent ?? w.MouseEvent)("pointerdown", {
        bubbles: true,
        clientX: 100,
        clientY: 100,
      }),
    );
    window.dispatchEvent(
      new (w.PointerEvent ?? w.MouseEvent)("pointermove", {
        bubbles: true,
        clientX: 100 + dx,
        clientY: 100 + dy,
      }),
    );
    window.dispatchEvent(
      new (w.PointerEvent ?? w.MouseEvent)("pointerup", {
        bubbles: true,
        clientX: 100 + dx,
        clientY: 100 + dy,
      }),
    );
  };

  // drag far DOWN: height is expressed in whole grid rows, never arbitrary pixels…
  drag(0, 2000);
  await wait(10);
  let card = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  assert.equal(card.style.height, "", "no arbitrary pixel height - the card is sized in blocks");
  assert.equal(card.dataset.rows, "2", "…and is capped at ONE extra block down");

  // reset, then drag far RIGHT: whole columns only, capped by the grid's own column count
  const reset = qa<HTMLButtonElement>(card, ".fcard-h .exp").find((b) =>
    /reset/i.test(b.getAttribute("aria-label") ?? ""),
  );
  reset!.click();
  await wait(10);
  drag(4000, 0);
  await wait(10);
  card = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  assert.match(card.style.gridColumn, /^span \d+$/, "width is a whole number of columns");
  assert.equal(card.dataset.rows, "1", "and dragging sideways did not change its height");
  destroy();
  try {
    window.localStorage?.removeItem("freva.db.overview");
  } catch {
    /* ignore */
  }
});

test("overview: the inline time/bbox editors show everything (no clipped Apply row)", async () => {
  const { root, destroy } = await mountOverview();
  const time = q<HTMLElement>(root, '.fcard[data-key="__time"]') as HTMLElement;
  const bbox = q<HTMLElement>(root, '.fcard[data-key="__bbox"]') as HTMLElement;
  for (const card of [time, bbox]) {
    assert.ok(q(card, ".editor.inline"), "the card uses the inline editor");
    assert.equal(
      q(card, ".editor .actions"),
      null,
      "no Apply/Cancel row - it never fitted in a card, so edits apply live instead",
    );
  }
  assert.ok(
    q(time, ".editor .daterow input.date-text"),
    "the time fields are visible without resizing",
  );
  assert.equal(qa(time, ".editor .modes button").length, 3, "and so are the three mode chips");
  assert.ok(q(bbox, ".editor .bbox-fields"), "the bbox bounds are visible without resizing");
  destroy();
});

test("overview: an inline time edit applies live (there is no Apply button to press)", async () => {
  const { root, destroy, handle } = await mountOverview();
  const time = q<HTMLElement>(root, '.fcard[data-key="__time"]') as HTMLElement;
  const from = qa<HTMLInputElement>(time, ".editor .daterow input.date-text")[0];
  const to = qa<HTMLInputElement>(time, ".editor .daterow input.date-text")[1];
  from.value = "2000";
  to.value = "2010";
  from.dispatchEvent(
    new (root.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event("input", {
      bubbles: true,
    }),
  );
  to.dispatchEvent(
    new (root.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event("change", {
      bubbles: true,
    }),
  );
  await wait(30);
  assert.deepEqual(
    handle.getState().time,
    { from: "2000", to: "2010", mode: "flexible" },
    "the edit reached the query with no Apply click",
  );
  destroy();
});

test("overview: an expanded card stays one block tall, so its long value list scrolls", async () => {
  try {
    window.localStorage?.removeItem("freva.db.overview");
  } catch {
    /* ignore */
  }
  const { root, destroy } = await mountOverview();
  const card = q<HTMLElement>(root, '.fcard[data-key="project"]') as HTMLElement;
  // the card is sized in BLOCKS (via data-rows -> CSS height), never by its content: that's what
  // keeps the value list bounded and scrollable instead of spilling out of the card
  assert.equal(card.dataset.rows, "1", "a default card is exactly one block tall");
  assert.equal(card.style.height, "", "height comes from the block, not from the content");
  const vals = q<HTMLElement>(card, ".fcard-vals");
  assert.ok(vals, "the value list is the scrolling region inside the bounded card");
  destroy();
});

test("overview: time and bbox sit among the facet blocks, not exiled below them", async () => {
  const { root, destroy } = await mountOverview();
  const keys = qa<HTMLElement>(root, ".facet-grid > *").map((n) => n.dataset.key ?? n.className);
  const iTime = keys.indexOf("__time");
  const iBbox = keys.indexOf("__bbox");
  const iAddRow = keys.findIndex((k) => k.includes("ov-addrow"));
  assert.ok(iTime > -1 && iBbox > -1, "both special blocks are in the same grid as the facets");
  if (iAddRow > -1) {
    assert.ok(
      iTime < iAddRow && iBbox < iAddRow,
      'they come BEFORE the full-width "additional facets" row, not after it in a lonely strip',
    );
  }
  // and they are ordinary blocks: same sizing contract as any facet card
  for (const key of ["__time", "__bbox"]) {
    const card = q<HTMLElement>(root, `.fcard[data-key="${key}"]`) as HTMLElement;
    assert.equal(card.dataset.rows, "1", `${key} is a one-block card like the rest`);
  }
  destroy();
});
