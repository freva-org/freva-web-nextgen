// Time and BBox are ordinary overview cards.
//
// Nothing in `overview.ts` may treat a `__`-prefixed key as an exception: not pointer reordering,
// not keyboard reordering, not the persisted order, and no decorative unfocusable grip standing in
// for a dead gesture. Excluding them leaves two blocks the user cannot put where they want, pinned
// to wherever the render happens to place them.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { installFetch, makeHost, overviewResponse, searchResponse, tick, wait } from "./helpers.js";
import { window as win } from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";
import { mergeOrder } from "../src/components/overview.js";
import type { DataBrowserHandle } from "../src/types.js";

const FACETS = { project: ["x", 3], model: ["y", 2], variable: ["z", 1] };

/**
 * `primary` names the facets the overview shows by default; anything else lands behind "Show
 * additional facets". Passing a SHORTER list is how these tests get a real additional section.
 */
function route(primary: string[] = ["project", "model", "variable"]): () => void {
  return installFetch(({ url }) => {
    if (url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (url.includes("/flavours")) return { body: { flavours: [] } };
    return {
      body: searchResponse({
        total: 1,
        rows: [{ file: "/a.nc" }],
        facets: FACETS,
        primary,
      }),
    };
  });
}

async function openOverview(): Promise<{
  handle: DataBrowserHandle;
  root: HTMLElement;
  host: HTMLElement;
}> {
  const host = makeHost();
  const handle = mountDataBrowser(host, { syncUrl: false });
  await wait(60);
  const root = host.querySelector(".freva-db") as HTMLElement;
  root.querySelector<HTMLButtonElement>('[aria-label="Overview"]')?.click();
  await tick();
  return { handle, root, host };
}

const keys = (root: ParentNode): string[] =>
  [...root.querySelectorAll<HTMLElement>(".facet-grid .fcard[data-key]")].map(
    (c) => c.dataset.key ?? "",
  );

const grip = (root: ParentNode, key: string): HTMLElement =>
  root.querySelector<HTMLElement>(`.fcard[data-key="${key}"] .drag-grip`) as HTMLElement;

/** jsdom has no PointerEvent, so the coordinates the handlers read are defined onto a plain Event. */
const pointer = (el: EventTarget, type: string, x: number, y: number): void => {
  const ev = new win.Event(type, { bubbles: true, cancelable: true }) as Event & {
    clientX?: number;
    clientY?: number;
    pointerId?: number;
    button?: number;
  };
  Object.defineProperties(ev, {
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: 1 },
    button: { value: 0 },
  });
  el.dispatchEvent(ev);
};

test("mergeOrder keeps hidden cards anchored behind the visible card they followed", () => {
  // "Show additional facets" is off most of the time, so a plain overwrite of the order would
  // silently forget where every hidden block sat - discovered only on re-opening the section.
  assert.deepEqual(mergeOrder(["a", "hidden1", "b", "hidden2", "c"], ["c", "a", "b"]), [
    "c",
    "a",
    "hidden1",
    "b",
    "hidden2",
  ]);
  // A hidden key that came FIRST stays first.
  assert.deepEqual(mergeOrder(["h", "a", "b"], ["b", "a"]), ["h", "b", "a"]);
  // Nothing remembered, or nothing hidden: the visible order is the whole answer.
  assert.deepEqual(mergeOrder([], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(mergeOrder(["a", "b"], ["b", "a"]), ["b", "a"]);
});

test("Time and BBox have real, focusable grips like every other card", async () => {
  const reset = route();
  const { handle, root, host } = await openOverview();
  try {
    for (const key of ["__time", "__bbox"]) {
      const g = grip(root, key);
      assert.ok(g, `${key} has no grip`);
      assert.equal(g.tagName, "BUTTON", `${key}'s grip is not a real control`);
      assert.match(g.getAttribute("aria-label") ?? "", /Reorder/);
      g.focus();
      assert.equal(win.document.activeElement, g, `${key}'s grip cannot take focus`);
    }
    assert.equal(root.querySelectorAll(".drag-grip-fixed").length, 0, "a decorative grip survived");
  } finally {
    handle.destroy();
    host.remove();
    reset();
  }
});

test("Arrow keys reorder Time and BBox, focus follows, and the order persists", async () => {
  const reset = route();
  win.localStorage.clear();
  let { handle, root, host } = await openOverview();
  try {
    const before = keys(root);
    assert.ok(before.includes("__time") && before.includes("__bbox"));
    // Default order with no saved preference: primary facets, then Time, then BBox.
    assert.deepEqual(before.slice(-2), ["__time", "__bbox"], "the default tail is Time then BBox");

    // Walk Time all the way to the front, one ArrowLeft at a time.
    const steps = before.indexOf("__time");
    for (let i = 0; i < steps; i++) {
      grip(root, "__time").dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
      await tick();
    }
    assert.equal(keys(root)[0], "__time", "Time did not reach the front");
    assert.equal(
      win.document.activeElement,
      grip(root, "__time"),
      "focus did not return to the moved grip",
    );
    // BBox moves too, and independently.
    grip(root, "__bbox").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    await tick();
    const moved = keys(root);
    assert.equal(moved[0], "__time");
    assert.equal(moved[moved.length - 1], "variable", "BBox did not move ahead of the last facet");
    assert.deepEqual(handle.getState().overviewOrder, moved, "state records the whole order");

    // …and it SURVIVES a remount, which is what "persisted" has to mean.
    handle.destroy();
    host.remove();
    const again = await openOverview();
    handle = again.handle;
    root = again.root;
    host = again.host;
    assert.deepEqual(keys(root), moved, "the order did not survive a reload");
  } finally {
    handle.destroy();
    host.remove();
    win.localStorage.clear();
    reset();
  }
});

test("reordering crosses the primary/additional boundary in the DOM, not only in state", async () => {
  // The two groups must not be ordered and rendered INDEPENDENTLY: a move across the boundary
  // would then be recorded in `overviewOrder` and undone by the render, leaving state that reads
  // `project, __time, model, __bbox, variable` while the screen reads
  // `project, __time, __bbox, model, variable`. State that the next paint contradicts is worse
  // than no state at all - the user presses the key, nothing moves, and the position is remembered.
  const reset = route(["project"]); // → model and variable are ADDITIONAL
  win.localStorage.clear();
  let { handle, root, host } = await openOverview();
  try {
    const addBtn = root.querySelector<HTMLButtonElement>(".ov-addbtn");
    assert.ok(addBtn, "there is no additional-facets section to test with");
    addBtn.click();
    await tick();

    // Default order: the primary facet, Time, BBox, then the additional facets.
    assert.deepEqual(keys(root), ["project", "__time", "__bbox", "model", "variable"]);

    // Move BBox one step to the right - PAST an additional facet.
    grip(root, "__bbox").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await tick();

    const moved = ["project", "__time", "model", "__bbox", "variable"];
    assert.deepEqual(keys(root), moved, "the card did not move on screen");
    assert.deepEqual(handle.getState().overviewOrder, moved, "state disagrees with the DOM");
    assert.equal(
      win.document.activeElement,
      grip(root, "__bbox"),
      "focus did not follow the moved card",
    );

    // An ADDITIONAL facet moves the other way across the same boundary just as freely.
    grip(root, "variable").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    await tick();
    grip(root, "variable").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    await tick();
    assert.deepEqual(keys(root), ["project", "__time", "variable", "model", "__bbox"]);

    // The POINTER path lands in the same place. jsdom has no layout, so `elementFromPoint` cannot
    // pick the card under the cursor; what it CAN exercise is the other half - the drop, which
    // reads the DOM order back out and folds it into the remembered one.
    const g = grip(root, "__bbox");
    pointer(g, "pointerdown", 10, 10);
    const grid = root.querySelector(".facet-grid") as HTMLElement;
    const dragged = root.querySelector('.fcard[data-key="__bbox"]') as HTMLElement;
    const target = root.querySelector('.fcard[data-key="variable"]') as HTMLElement;
    assert.ok(dragged.classList.contains("dragging"), "the grip did not begin a reorder");
    grid.insertBefore(dragged, target); // what the move handler does once it has a card under the cursor
    pointer(win, "pointerup", 300, 10);
    await tick();
    assert.deepEqual(keys(root), ["project", "__time", "__bbox", "variable", "model"]);
    assert.deepEqual(handle.getState().overviewOrder, [
      "project",
      "__time",
      "__bbox",
      "variable",
      "model",
    ]);

    // …and the whole arrangement survives a remount.
    const before = keys(root);
    handle.destroy();
    host.remove();
    const again = await openOverview();
    handle = again.handle;
    root = again.root;
    host = again.host;
    assert.deepEqual(keys(root), before, "the cross-section order did not survive a reload");
  } finally {
    handle.destroy();
    host.remove();
    win.localStorage.clear();
    reset();
  }
});

test("with the additional section CLOSED, a reorder still keeps hidden positions", async () => {
  const reset = route(["project"]);
  win.localStorage.clear();
  const { handle, root, host } = await openOverview();
  try {
    // Open, park BBox between the two additional facets, then close the section again.
    root.querySelector<HTMLButtonElement>(".ov-addbtn")?.click();
    await tick();
    grip(root, "__bbox").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await tick();
    assert.deepEqual(handle.getState().overviewOrder, [
      "project",
      "__time",
      "model",
      "__bbox",
      "variable",
    ]);
    root.querySelector<HTMLButtonElement>(".ov-addbtn")?.click();
    await tick();
    assert.deepEqual(
      keys(root),
      ["project", "__time", "__bbox"],
      "additional cards are still shown",
    );

    // Reorder what IS visible. The two hidden keys must keep the positions they had.
    grip(root, "__time").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    await tick();
    assert.deepEqual(keys(root), ["__time", "project", "__bbox"]);
    // `mergeOrder`'s contract is that a hidden key stays behind the VISIBLE key it followed - not
    // at a fixed index. `model` sat behind Time, so it travels with Time; `variable` sat behind
    // BBox and stays there. Neither is forgotten, which is the property that matters.
    assert.deepEqual(
      handle.getState().overviewOrder,
      ["__time", "model", "project", "__bbox", "variable"],
      "a hidden facet lost its remembered position",
    );

    // Reopening reveals them exactly where the remembered order says they are.
    root.querySelector<HTMLButtonElement>(".ov-addbtn")?.click();
    await tick();
    assert.deepEqual(keys(root), ["__time", "model", "project", "__bbox", "variable"]);
  } finally {
    handle.destroy();
    host.remove();
    win.localStorage.clear();
    reset();
  }
});

test("a pointer drag from a special card's header reorders it; its inputs do not", async () => {
  const reset = route();
  win.localStorage.clear();
  const { handle, root, host } = await openOverview();
  try {
    // The grip starts a drag immediately - the card gets the dragging class.
    const g = grip(root, "__time");
    pointer(g, "pointerdown", 10, 10);
    const timeCard = root.querySelector('.fcard[data-key="__time"]') as HTMLElement;
    assert.ok(timeCard.classList.contains("dragging"), "the grip did not begin a reorder");
    pointer(win, "pointerup", 10, 10);
    await tick();

    // A press on the card's own INPUT never arms one.
    const input = root.querySelector<HTMLElement>('.fcard[data-key="__time"] input');
    assert.ok(input, "the time card has no input to test with");
    pointer(input!, "pointerdown", 20, 20);
    pointer(win, "pointermove", 300, 20);
    pointer(win, "pointerup", 300, 20);
    await tick();
    assert.equal(
      root.querySelectorAll(".fcard.dragging").length,
      0,
      "a press on an input started a drag",
    );
  } finally {
    handle.destroy();
    host.remove();
    win.localStorage.clear();
    reset();
  }
});
