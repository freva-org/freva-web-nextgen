// Copy controls.
//
// One behaviour here is a deliberate departure from the reference: a copy that fails says so. The
// original replaced the button's label with "Copied" on both branches of the promise, which trains
// people to trust a message that is sometimes false - and clipboard writes really do fail, in an
// unfocused tab, under a restrictive permissions policy, and over plain HTTP.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountDatasetTree } from "../src/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import {
  breakClipboard,
  click,
  clipboardWrites,
  makeHost,
  q,
  resetDom,
  rowNames,
  tick,
  until,
} from "./helpers.js";

function row(host: ParentNode, id: string): HTMLButtonElement | null {
  return q<HTMLButtonElement>(
    host,
    `[data-dataset-tree-id="${id}"] > .dataset-tree__rowline > .dataset-tree__row`,
  );
}

function mount(host: HTMLElement, extra: Record<string, unknown> = {}) {
  const catalog = parseDatasetTreeCatalogV1({
    schemaVersion: 1,
    roots: [
      {
        id: "d1",
        kind: "dataset",
        name: "tas.zarr",
        path: "s3://archive/reanalysis/tas.zarr",
      },
    ],
  });
  return mountDatasetTree(host, { source: createSnapshotSource(catalog), ...extra });
}

/**
 * The copy control's accessible name.
 *
 * It lives INSIDE the address box now and is an icon, so there is no text to read: what a reader -
 * or a screen reader - is told is the label, and that is what these tests assert. The claims are
 * unchanged; only where the words live is.
 */
const copyLabel = (host: HTMLElement): string | null =>
  q(host, '[data-dt-key="path:d1"]')?.getAttribute("aria-label") ?? null;

test("Copy path copies the path exactly, and confirms it", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mount(host);
  await until(() => rowNames(host).includes("tas.zarr"), "roots");
  click(row(host, "d1"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");

  const copy = q<HTMLButtonElement>(host, '[data-dt-key="path:d1"]');
  // Inside the address box, where what was copied is: see `pathCopyButton`.
  assert.ok(
    q(host, ".dataset-tree__path .dataset-tree__path-copy"),
    "the control is not in the box",
  );
  assert.equal(copyLabel(host), "Copy path");
  click(copy);
  await until(() => clipboardWrites.length === 1, "clipboard write");
  assert.deepEqual(clipboardWrites, ["s3://archive/reanalysis/tas.zarr"]);
  await until(() => copyLabel(host) === "Copied", "confirmation");
  handle.destroy();
});

test("a failed copy says `Copy failed`, not `Copied`", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  breakClipboard(true);
  const handle = mount(host);
  await until(() => rowNames(host).includes("tas.zarr"), "roots");
  click(row(host, "d1"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");

  click(q(host, '[data-dt-key="path:d1"]'));
  await until(() => copyLabel(host) === "Copy failed", "failure label");
  assert.deepEqual(clipboardWrites, [], "a failed write still reached the clipboard");
  assert.ok(q(host, '[data-dt-key="path:d1"]')?.classList.contains("is-failed"));
  breakClipboard(false);
  handle.destroy();
});

test("the confirmation reverts, and the control keeps focus while it does", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mount(host);
  await until(() => rowNames(host).includes("tas.zarr"), "roots");
  click(row(host, "d1"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");

  q<HTMLButtonElement>(host, '[data-dt-key="path:d1"]')?.focus();
  click(q(host, '[data-dt-key="path:d1"]'));
  await until(() => copyLabel(host) === "Copied", "confirmation");
  // The label change is a re-render; focus must not be lost by it.
  assert.equal(document.activeElement?.getAttribute("data-dt-key"), "path:d1");

  await until(() => copyLabel(host) === "Copy path", "revert", 2000);
  handle.destroy();
});

test("Copy code copies the selected example, and follows the tab", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mount(host, {
    accessExamples: () => [
      { id: "py", label: "Python", language: "python", code: "import xarray\n" },
      { id: "cli", label: "CLI", language: "shell", code: "cli get tas\n" },
    ],
  });
  await until(() => rowNames(host).includes("tas.zarr"), "roots");
  click(row(host, "d1"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");

  // The examples live behind a disclosure, closed by default.
  assert.equal(q(host, ".dataset-tree__access-body")?.hasAttribute("hidden"), true);
  click(q(host, '[data-dt-key="disclose:d1"]'));
  await until(() => Boolean(q(host, ".dataset-tree__codecard")), "code card");

  assert.equal(q(host, ".dataset-tree__code")?.textContent, "import xarray\n");
  click(q(host, '[data-dt-key="example:d1"]'));
  await until(() => clipboardWrites.length === 1, "first copy");
  assert.deepEqual(clipboardWrites, ["import xarray\n"]);

  click(q(host, '[data-dt-key="tab:d1:1"]'));
  await until(() => q(host, ".dataset-tree__code")?.textContent === "cli get tas\n", "tab switch");
  click(q(host, '[data-dt-key="example:d1"]'));
  await until(() => clipboardWrites.length === 2, "second copy");
  assert.equal(clipboardWrites[1], "cli get tas\n");
  handle.destroy();
});

test("the package ships no examples of its own - the disclosure appears only when asked for", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mount(host);
  await until(() => rowNames(host).includes("tas.zarr"), "roots");
  click(row(host, "d1"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");

  assert.equal(q(host, ".dataset-tree__access"), null, "an access disclosure appeared unbidden");
  const text = host.textContent ?? "";
  for (const term of ["xarray", "s3fs", "boto", "import "]) {
    assert.ok(!text.includes(term), `the package hard-coded ${term}`);
  }
  handle.destroy();
});

test("a code sample is rendered as text, whatever it contains", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mount(host, {
    accessExamples: () => [
      { id: "x", label: "x", language: "text", code: "</code></pre><script>alert(1)</script>" },
    ],
  });
  await until(() => rowNames(host).includes("tas.zarr"), "roots");
  click(row(host, "d1"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");
  click(q(host, '[data-dt-key="disclose:d1"]'));
  await until(() => Boolean(q(host, ".dataset-tree__codecard")), "code card");

  assert.equal(host.querySelector("script"), null);
  assert.equal(
    q(host, ".dataset-tree__code")?.textContent,
    "</code></pre><script>alert(1)</script>",
  );
  handle.destroy();
});

test("with no clipboard API at all, the control reports failure rather than throwing", async (t) => {
  t.after(resetDom);
  const { removeClipboard, restoreClipboard } = await import("./helpers.js");
  t.after(restoreClipboard);
  const host = makeHost();
  removeClipboard();
  const handle = mount(host);
  await until(() => rowNames(host).includes("tas.zarr"), "roots");
  click(row(host, "d1"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");

  click(q(host, '[data-dt-key="path:d1"]'));
  await tick();
  assert.equal(copyLabel(host), "Copy failed");
  handle.destroy();
});

// ONE WAY TO OPEN A STORE IS NOT A CHOICE.
//
// With `s3fs` gone from the shipped recipes, most stores have exactly one snippet - and a tablist
// of one is a box drawn around a word: it asks a reader to pick from a set of one and costs a row
// of a panel that is already three levels deep. It appears when there is something to choose.
test("the tab strip appears only when there is more than one example", async (t) => {
  t.after(resetDom);
  const one = makeHost();
  const first = mount(one, {
    accessExamples: () => [
      { id: "py", label: "Python", language: "python", code: "import xarray\n" },
    ],
  });
  await until(() => rowNames(one).includes("tas.zarr"), "roots");
  click(row(one, "d1"));
  await until(() => Boolean(q(one, ".dataset-tree__details")), "details");
  click(q(one, '[data-dt-key="disclose:d1"]'));
  await until(() => Boolean(q(one, ".dataset-tree__codecard")), "code card");
  assert.equal(q(one, ".dataset-tree__tabbar"), null, "a tablist was drawn for a single example");
  assert.equal(q(one, ".dataset-tree__code")?.textContent, "import xarray\n");
  first.destroy();

  const two = makeHost();
  const second = mount(two, {
    accessExamples: () => [
      { id: "py", label: "Python", language: "python", code: "import xarray\n" },
      { id: "cli", label: "CLI", language: "shell", code: "cli get tas\n" },
    ],
  });
  await until(() => rowNames(two).includes("tas.zarr"), "roots");
  click(row(two, "d1"));
  await until(() => Boolean(q(two, ".dataset-tree__details")), "details");
  click(q(two, '[data-dt-key="disclose:d1"]'));
  await until(() => Boolean(q(two, ".dataset-tree__codecard")), "code card");
  assert.ok(q(two, ".dataset-tree__tabbar"), "no tablist for two alternatives");
  second.destroy();
});
