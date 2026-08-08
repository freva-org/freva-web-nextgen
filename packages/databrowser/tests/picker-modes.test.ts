// "All filtered results" has to LOOK like what it is.
//
// The semantics are safe on their own: a bounded `kind: "query"` reference, nothing materialised,
// no auto-commit. The presentation has to match them. A checkbox that silently swaps modes, clears
// the explicit selection and produces no visible consequence until Add is pressed reads as
// "nothing happened", which is the worst possible reading of a control that just discarded a
// selection.
//
// The two modes are mutually exclusive, so they are a radio group; each shows its own subject; the
// action states its own scope. None of that changes what is committed - these tests hold the
// semantics still while asserting the feedback.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeHost, searchResponse, tick, wait, window as win } from "./helpers.js";
import { mountDataPicker } from "../src/picker/mount.js";
import { isDataReference } from "../src/picker/reference.js";
import type { DataReference } from "../src/picker/reference.js";
import type { DataPickerConfig, DataPickerHandle } from "../src/picker/types.js";
import type { SearchClient } from "../src/search/engine.js";
import type { SearchResult } from "../src/types.js";

const rows = (n: number): Array<{ file: string; fs_type: string }> =>
  Array.from({ length: n }, (_, i) => ({ file: `/archive/tas_${i}.nc`, fs_type: "posix" }));

/** 120 results reported, 25 rows delivered - a realistic page, not the whole set. */
const client = (total = 120, page = 25): SearchClient => ({
  async search() {
    return searchResponse({
      total,
      rows: rows(page),
      facets: { project: ["cmip6", total] },
      primary: ["project"],
    }) as unknown as SearchResult;
  },
});

async function mount(
  config: DataPickerConfig = {},
): Promise<{ handle: DataPickerHandle; root: HTMLElement; host: HTMLElement }> {
  const host = makeHost();
  const handle = mountDataPicker(host, { debounceMs: 1, client: client(), ...config });
  await wait(30);
  const root = host.querySelector(".freva-picker") as HTMLElement;
  assert.ok(root, "the picker did not mount");
  return { handle, root, host };
}

function q<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const n = root.querySelector<T>(sel);
  assert.ok(n, `missing ${sel}`);
  return n;
}

const modeFiles = (root: ParentNode): HTMLButtonElement =>
  q<HTMLButtonElement>(root, '.fp-mode[data-mode="files"]');
const modeQuery = (root: ParentNode): HTMLButtonElement =>
  q<HTMLButtonElement>(root, '.fp-mode[data-mode="query"]');
const addBtn = (root: ParentNode): HTMLButtonElement => q<HTMLButtonElement>(root, ".fp-add");

test("the two modes are a radio group, each showing its own subject", async () => {
  const { handle, root, host } = await mount();
  try {
    const group = q(root, ".fp-modes");
    assert.equal(group.getAttribute("role"), "radiogroup");
    assert.equal(modeFiles(root).getAttribute("role"), "radio");
    assert.equal(modeQuery(root).getAttribute("role"), "radio");

    // Explicit mode is the default and says what it holds.
    assert.equal(modeFiles(root).getAttribute("aria-checked"), "true");
    assert.equal(modeQuery(root).getAttribute("aria-checked"), "false");
    assert.match(modeFiles(root).textContent ?? "", /No files yet/);
    // Query mode says how many results it would take - the number the user is choosing between.
    assert.match(modeQuery(root).textContent ?? "", /All 120 results/);
    // Roving tabindex: one tab stop for the group.
    assert.equal(modeFiles(root).tabIndex, 0);
    assert.equal(modeQuery(root).tabIndex, -1);
    assert.equal(handle.getState().useAllFiltered, false);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("picking a row enters explicit mode and shows the count in the mode AND the action", async () => {
  const { handle, root, host } = await mount({ commitLabel: "Add to experiment" });
  try {
    assert.equal(addBtn(root).disabled, true);
    assert.equal(addBtn(root).textContent, "Add to experiment");

    q<HTMLElement>(root, ".fp-row").click();
    await tick();
    assert.equal(modeFiles(root).getAttribute("aria-checked"), "true");
    assert.match(modeFiles(root).textContent ?? "", /1 file$/);
    // The visible action carries its own scope: "Add to experiment · 1 file".
    assert.match(addBtn(root).textContent ?? "", /^Add to experiment/);
    assert.match(addBtn(root).textContent ?? "", /· 1 file$/);
    assert.equal(addBtn(root).disabled, false);
    // `commitLabel` remains the BASE label, not the whole string.
    assert.equal(q(root, ".fp-add-l").textContent, "Add to experiment");

    [...root.querySelectorAll<HTMLElement>(".fp-row")][1].click();
    await tick();
    assert.match(modeFiles(root).textContent ?? "", /2 files$/);
    assert.match(addBtn(root).textContent ?? "", /· 2 files$/);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("choosing All filtered results is visible, changes the reference, and commits nothing", async () => {
  const commits: DataReference[] = [];
  const { handle, root, host } = await mount({
    commitLabel: "Add to experiment",
    onCommit: (r) => commits.push(r),
  });
  try {
    // Start from an explicit selection, so the mode change has something to replace.
    q<HTMLElement>(root, ".fp-row").click();
    await tick();
    assert.equal(handle.getState().assets.length, 1);

    modeQuery(root).click();
    await tick();

    // VISIBLY active…
    assert.equal(modeQuery(root).getAttribute("aria-checked"), "true");
    assert.equal(modeFiles(root).getAttribute("aria-checked"), "false");
    assert.ok(modeQuery(root).classList.contains("on"));
    // …with an explanation of what it will actually do.
    const note = q(root, ".fp-note");
    assert.ok(note.classList.contains("show"));
    assert.match(
      note.textContent ?? "",
      /A query reference will be added; individual rows are not selected\./,
    );
    // …and the action states the new scope.
    assert.match(addBtn(root).textContent ?? "", /· all 120$/);

    // State and reference changed…
    assert.equal(handle.getState().useAllFiltered, true);
    assert.deepEqual(handle.getState().assets, []);
    const ref = handle.getReference();
    assert.equal(ref?.kind, "query");
    assert.equal(ref?.kind === "query" ? ref.estimatedCount : 0, 120);

    // …and NOTHING was committed by the mode change itself.
    assert.equal(commits.length, 0, "changing mode committed something");

    // Rows are NOT bulk-ticked: query mode is a query, not a 120-row selection.
    assert.equal(root.querySelectorAll(".fp-row.picked").length, 0);
    assert.equal(root.querySelectorAll('.fp-row[aria-selected="true"]').length, 0);

    // One press, exactly one commit, carrying the query.
    addBtn(root).click();
    assert.equal(commits.length, 1);
    assert.equal(commits[0].kind, "query");
    assert.equal(commits[0].kind === "query" ? commits[0].estimatedCount : 0, 120);
    assert.ok(isDataReference(commits[0]));
    // A bounded reference - 120 results, not 120 URIs.
    assert.ok(JSON.stringify(commits[0]).length < 600);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("selecting a row returns to explicit mode, and the arrow keys move between modes", async () => {
  const { handle, root, host } = await mount();
  try {
    modeQuery(root).click();
    await tick();
    assert.equal(handle.getState().useAllFiltered, true);

    q<HTMLElement>(root, ".fp-row").click();
    await tick();
    assert.equal(
      handle.getState().useAllFiltered,
      false,
      "picking a row did not re-enter files mode",
    );
    assert.equal(modeFiles(root).getAttribute("aria-checked"), "true");
    assert.equal(handle.getReference()?.kind, "asset");

    // Keyboard: the group behaves like a radio group.
    q(root, ".fp-modes").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await tick();
    assert.equal(handle.getState().useAllFiltered, true);
    q(root, ".fp-modes").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    await tick();
    assert.equal(handle.getState().useAllFiltered, false);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("with allFiltered disabled there is no mode choice at all", async () => {
  const { handle, root, host } = await mount({ features: { allFiltered: false } });
  try {
    assert.equal(root.querySelector(".fp-modes"), null);
    assert.ok(q(root, ".fp-count"), "the plain count is shown instead");
    assert.equal(handle.getState().useAllFiltered, false);
  } finally {
    handle.destroy();
    host.remove();
  }
});

test("Time and Area are compact disclosures, not six inputs pinned into the rail", async () => {
  const { handle, root, host } = await mount({ features: { time: true, bbox: true } });
  try {
    const discs = [...root.querySelectorAll<HTMLElement>(".fp-disc-h")];
    assert.equal(discs.length, 2, "expected a Time and an Area disclosure");
    assert.deepEqual(
      discs.map((d) => d.querySelector(".fp-disc-l")?.textContent),
      ["Time", "Area"],
    );
    // Closed: one line each, stating their state - and NO inputs occupying the rail.
    assert.deepEqual(
      discs.map((d) => d.querySelector(".fp-disc-s")?.textContent),
      ["any", "anywhere"],
    );
    assert.equal(root.querySelectorAll(".fp-controls input").length, 0);

    discs[0].click();
    await tick();
    const openHead = root.querySelector<HTMLElement>(".fp-disc.open .fp-disc-h");
    assert.equal(openHead?.getAttribute("aria-expanded"), "true");
    assert.equal(
      root.querySelectorAll(".fp-controls input").length,
      2,
      "Time exposes its two bounds",
    );

    // Setting a value is reflected in the closed summary and in the query contract, unchanged.
    const inputs = [...root.querySelectorAll<HTMLInputElement>(".fp-controls input")];
    inputs[0].value = "2000";
    inputs[0].dispatchEvent(new win.Event("change", { bubbles: true }));
    await wait(20);
    assert.equal(handle.getState().time?.from, "2000");
    assert.match(
      root.querySelector(".fp-disc-s")?.textContent ?? "",
      /2000 → \*/,
      "the closed summary does not state the set range",
    );
  } finally {
    handle.destroy();
    host.remove();
  }
});
