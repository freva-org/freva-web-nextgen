// The information control on a branch, and the card it opens.
//
// There is a case for a branch not having one at all: a panel whose content is the folder's own
// path is a restatement of the row above it, and one circled `i` per branch turns a column of names
// into a column of icons. Both objections are answered rather than ignored: the control is quiet
// until the row is under the pointer or a keyboard reaches it, and what it opens is a CARD anchored
// to it rather than a panel that pushes the rest of the tree down the screen.
//
// So the behaviour worth defending is the dismissal. A popover a reader cannot close the way they
// expect is worse than a panel: they expect the cross, a press outside it, and Escape.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountDatasetTree } from "../src/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import { click, makeHost, q, qa, resetDom, rowNames, until } from "./helpers.js";

/** Two branches that each publish something the row does not show, and a leaf under one of them. */
function mount(host: HTMLElement) {
  const catalog = parseDatasetTreeCatalogV1({
    schemaVersion: 1,
    roots: [
      {
        id: "a",
        kind: "collection",
        name: "Alpha",
        path: "s3://alpha/prefix/",
        details: [
          { label: "Bucket", values: [{ text: "alpha" }] },
          { label: "Prefix", values: [{ text: "prefix/" }] },
        ],
        children: [
          {
            id: "a/one",
            kind: "directory",
            name: "one",
            path: "s3://alpha/prefix/one/",
            details: [{ label: "Bucket", values: [{ text: "alpha" }] }],
            children: [{ id: "a/one/t.zarr", kind: "dataset", name: "t.zarr" }],
          },
        ],
      },
      {
        id: "b",
        kind: "collection",
        name: "Beta",
        path: "s3://beta/",
        details: [{ label: "Bucket", values: [{ text: "beta" }] }],
        children: [],
      },
    ],
  });
  return mountDatasetTree(host, { source: createSnapshotSource(catalog) });
}

const card = (host: ParentNode) => q(host, ".dataset-tree__infocard");

test("every branch has the control, including a root, and it opens a card beside the name", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mount(host);
  await until(() => rowNames(host).includes("Alpha"), "roots");

  // Roots included: a collection's bucket is the one a reader is least able to guess from the row.
  assert.ok(q(host, '[data-dt-key="info:a"]'), "a root has no information control");
  assert.ok(q(host, '[data-dt-key="info:b"]'), "the second root has no information control");
  assert.equal(card(host), null, "a card was open before anything was pressed");

  // NEXT TO THE NAME. The control and its card share a wrapper that follows the row button, so
  // "beside the name" is a fact about the DOM rather than about a stylesheet.
  const wrap = q(
    host,
    '[data-dataset-tree-id="a"] > .dataset-tree__rowline > .dataset-tree__infowrap',
  );
  assert.ok(wrap, "the control is not in a wrapper beside the row");
  assert.equal(
    wrap?.previousElementSibling?.classList.contains("dataset-tree__row"),
    true,
    "the control does not follow the row",
  );

  click(q(host, '[data-dt-key="info:a"]'));
  await until(() => Boolean(card(host)), "card");
  // Re-queried: a press re-renders, so the wrapper above is a node that no longer exists.
  const opened = q(
    host,
    '[data-dataset-tree-id="a"] > .dataset-tree__rowline > .dataset-tree__infowrap',
  );
  assert.equal(card(host)?.parentElement, opened, "the card is not anchored to its control");
  assert.equal(
    opened?.querySelector('[data-dt-key="info:a"]') !== null,
    true,
    "the control and its card are not in the same wrapper",
  );
  const text = card(host)?.textContent ?? "";
  assert.match(text, /s3:\/\/alpha\/prefix\//);
  assert.match(text, /Bucket/);
  assert.match(text, /alpha/);

  // And the row list did not grow a panel: the card is drawn over the tree, not inside its flow.
  assert.equal(
    qa(host, ".dataset-tree__details").length,
    0,
    "the branch opened a details panel as well",
  );
  handle.destroy();
});

test("the cross closes it, and focus goes back to the control", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mount(host);
  await until(() => rowNames(host).includes("Alpha"), "roots");

  click(q(host, '[data-dt-key="info:a"]'));
  await until(() => Boolean(card(host)), "card");
  click(q(host, '[data-dt-key="info-close:a"]'));
  await until(() => card(host) === null, "closed");
  assert.equal(
    document.activeElement?.getAttribute("data-dt-key"),
    "info:a",
    "focus was left where the card used to be",
  );
  handle.destroy();
});

test("a press outside closes it; a press inside it does not", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mount(host);
  await until(() => rowNames(host).includes("Alpha"), "roots");
  click(q(host, '[data-dt-key="info:a"]'));
  await until(() => Boolean(card(host)), "card");

  // Inside: the address box is part of the card, and reading it must not dismiss it.
  q(host, ".dataset-tree__infocard .dataset-tree__path")?.dispatchEvent(
    new window.PointerEvent("pointerdown", { bubbles: true }),
  );
  await until(() => Boolean(card(host)), "still open");

  document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
  await until(() => card(host) === null, "closed by an outside press");
  handle.destroy();
});

test("Escape closes it", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mount(host);
  await until(() => rowNames(host).includes("Alpha"), "roots");
  click(q(host, '[data-dt-key="info:a"]'));
  await until(() => Boolean(card(host)), "card");

  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => card(host) === null, "closed by Escape");
  assert.equal(document.activeElement?.getAttribute("data-dt-key"), "info:a");
  handle.destroy();
});

test("one card at a time, and the control toggles its own", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mount(host);
  await until(() => rowNames(host).includes("Alpha"), "roots");

  click(q(host, '[data-dt-key="info:a"]'));
  await until(() => Boolean(card(host)), "first card");
  click(q(host, '[data-dt-key="info:b"]'));
  await until(() => (card(host)?.textContent ?? "").includes("beta"), "second card");
  assert.equal(qa(host, ".dataset-tree__infocard").length, 1, "two cards were open at once");

  click(q(host, '[data-dt-key="info:b"]'));
  await until(() => card(host) === null, "toggled shut");
  handle.destroy();
});

test("the document listeners go with the component", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mount(host);
  await until(() => rowNames(host).includes("Alpha"), "roots");
  click(q(host, '[data-dt-key="info:a"]'));
  await until(() => Boolean(card(host)), "card");

  // A destroyed component that left a capture-phase listener on the document is a leak that only
  // shows up as a stray error on some later press, which is why this is asserted rather than
  // assumed: the events below must reach a dead component and do nothing.
  handle.destroy();
  document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(host.querySelector(".dataset-tree__infocard"), null);
});
