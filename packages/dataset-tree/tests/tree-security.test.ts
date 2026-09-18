// Hostile catalogs.
//
// Every string in a catalog is attacker-controlled as far as this component is concerned - a
// snapshot is generated from an object store whose keys anyone with write access chose, and a live
// listing is literally whatever the gateway returns. The rule the whole package is built on is that
// none of it is ever parsed as markup and none of it ever becomes a link without being checked.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountDatasetTree } from "../src/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import { safeHref } from "../src/url.js";
import { click, makeHost, q, qa, resetDom, rowNames, tick, until } from "./helpers.js";
import { hostileCatalog } from "./fixtures/catalog.js";

function row(host: ParentNode, id: string): HTMLButtonElement | null {
  return q<HTMLButtonElement>(
    host,
    `[data-dataset-tree-id="${id}"] > .dataset-tree__rowline > .dataset-tree__row`,
  );
}

async function mountHostile(host: HTMLElement) {
  const catalog = parseDatasetTreeCatalogV1(hostileCatalog());
  const handle = mountDatasetTree(host, { source: createSnapshotSource(catalog) });
  await until(() => rowNames(host).length > 0, "roots");
  return handle;
}

test("markup in a name is text, not markup", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = await mountHostile(host);

  assert.equal(host.querySelector("img"), null, "a catalog name became an element");
  assert.equal(host.querySelector("script"), null, "a catalog value became a script");
  assert.deepEqual(rowNames(host), ["</span><script>alert('title')</script>"]);
  handle.destroy();
});

test("markup in a detail field, a metric and a link label is text too", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = await mountHostile(host);
  // `evil:1` is expandable AND carries detail, so what it knows is behind its own control - a
  // small card anchored to that control, not a panel under the row.
  click(q(host, '[data-dt-key="info:evil:1"]'));
  await until(() => Boolean(q(host, ".dataset-tree__infocard")), "info card");

  assert.equal(host.querySelector("script"), null);
  assert.equal(host.querySelector("b > script"), null);
  const text = host.textContent ?? "";
  assert.match(text, /<script>field<\/script>/, "the hostile label was dropped instead of escaped");
  assert.match(text, /<script>t<\/script>/, "the hostile value was dropped instead of escaped");
  // On the row itself: the metric's label and value.
  assert.match(text, /<script>k<\/script>/, "the hostile metric label was dropped");
  // The only elements in the panel are ones this package created. A `<b>` is ours (it emphasises a
  // detail value); nothing from the catalog ever becomes an element of any kind.
  assert.equal(host.querySelectorAll("script, img, iframe, object, embed, style, link").length, 0);
  const keys = qa(host, ".dataset-tree__metakey").map((n) => n.textContent);
  assert.ok(
    keys.includes("<script>field</script>"),
    `the hostile label is missing: ${keys.join(" | ")}`,
  );
  handle.destroy();
});

test("only an http(s) access route becomes a link; the rest are inert text", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = await mountHostile(host);
  // `evil:1` is expandable AND carries detail, so what it knows is behind its own control - a
  // small card anchored to that control, not a panel under the row.
  click(q(host, '[data-dt-key="info:evil:1"]'));
  await until(() => Boolean(q(host, ".dataset-tree__infocard")), "info card");

  const links = qa<HTMLAnchorElement>(host, "a");
  assert.equal(
    links.length,
    1,
    `expected exactly one link, got ${links.map((a) => a.href).join(", ")}`,
  );
  assert.equal(links[0].getAttribute("href"), "https://example.test/safe");
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
  assert.equal(links[0].getAttribute("target"), "_blank");

  // The refused routes are still shown - hiding them would hide real data - but as plain text.
  const text = host.textContent ?? "";
  for (const label of ["<script>l</script>", "data", "vb"]) {
    assert.ok(text.includes(label), `${label} disappeared entirely`);
  }
  handle.destroy();
});

test("a `javascript:` path is never linked, and the copy control still copies it verbatim", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = await mountHostile(host);
  // `evil:1` is expandable AND carries detail, so what it knows is behind its own control - a
  // small card anchored to that control, not a panel under the row.
  click(q(host, '[data-dt-key="info:evil:1"]'));
  await until(() => Boolean(q(host, ".dataset-tree__infocard")), "info card");

  const path = q(host, ".dataset-tree__path");
  assert.equal(path?.textContent, "javascript:alert('path')");
  assert.equal(path?.querySelector("a"), null, "a path became a link");
  handle.destroy();
});

test("safeHref refuses every scheme a page can be attacked through", () => {
  const refused = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)  ",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>1</script>",
    "vbscript:msgbox(1)",
    "blob:https://example.test/abc",
    "file:///etc/passwd",
    "s3://bucket/key",
    "//example.test/protocol-relative",
    "/relative",
    "",
    "   ",
    `https://example.test/${"x".repeat(4000)}`,
  ];
  for (const value of refused) {
    assert.equal(safeHref(value), null, `accepted ${JSON.stringify(value)}`);
  }
  assert.equal(safeHref("https://example.test/a?b=1#c"), "https://example.test/a?b=1#c");
  assert.equal(safeHref("http://localhost:8080/x"), "http://localhost:8080/x");
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(safeHref(value), null);
  }
});

test("a control character in a name cannot corrupt the row", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = await mountHostile(host);
  click(row(host, "evil:1"));
  await until(() => rowNames(host).length > 1, "children");
  // Rendered as text with the escape intact; nothing interprets it.
  assert.ok(rowNames(host).some((n) => n.includes("[31mansi")));
  handle.destroy();
});

test("nested metadata never reaches the panel at all", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = await mountHostile(host);
  // `evil:1` is expandable AND carries detail, so what it knows is behind its own control - a
  // small card anchored to that control, not a panel under the row.
  click(q(host, '[data-dt-key="info:evil:1"]'));
  await until(() => Boolean(q(host, ".dataset-tree__infocard")), "info card");
  const text = host.textContent ?? "";
  assert.ok(!text.includes("deepest"), "a nested metadata value reached the page");
  assert.ok(!text.includes("[object Object]"), "an object was stringified into the page");
  handle.destroy();
});

test("an enormous detail field is capped, and says how much it hid", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const many = Array.from({ length: 40 }, (_, i) => ({ text: `var${i}` }));
  const catalog = parseDatasetTreeCatalogV1({
    schemaVersion: 1,
    roots: [{ id: "a", kind: "dataset", name: "a", details: [{ label: "VARS", values: many }] }],
  });
  const handle = mountDatasetTree(host, { source: createSnapshotSource(catalog) });
  await until(() => rowNames(host).length === 1, "roots");
  click(row(host, "a"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");

  const chips = qa(host, ".dataset-tree__meta .dataset-tree__chip").map((c) => c.textContent);
  assert.equal(chips.length, 13, `expected 12 values plus an overflow chip, got ${chips.length}`);
  assert.equal(chips[12], "+28");
  handle.destroy();
});

test("an absurdly long string is truncated before it reaches the DOM", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const catalog = parseDatasetTreeCatalogV1({
    schemaVersion: 1,
    roots: [
      {
        id: "a",
        kind: "dataset",
        name: "a",
        details: [{ label: "NOTE", values: [{ text: "x".repeat(5000) }] }],
      },
    ],
  });
  const handle = mountDatasetTree(host, { source: createSnapshotSource(catalog) });
  await until(() => rowNames(host).length === 1, "roots");
  click(row(host, "a"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");
  const chip = q(host, ".dataset-tree__meta .dataset-tree__chip");
  assert.equal(chip?.textContent?.length, 200);
  handle.destroy();
});

test("arbitrary metadata never becomes UI, however it is shaped", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  // `metadata` is a deliberately open object: it carries whatever a source knows, for consumers and
  // inspectors. Rendering it would turn a source's verbosity into a portal's layout, and give
  // anyone who can write a catalogue a way to put a very large string inside a very small panel.
  const catalog = parseDatasetTreeCatalogV1({
    schemaVersion: 1,
    roots: [
      {
        id: "a",
        kind: "dataset",
        name: "a",
        path: "s3://b/a",
        metadata: {
          secretish: "SHOULD-NOT-RENDER",
          dims: { time: 10 },
          vars: ["one", "two"],
          deep: { a: { b: "c" } },
        },
      },
    ],
  });
  const handle = mountDatasetTree(host, { source: createSnapshotSource(catalog) });
  await until(() => rowNames(host).length === 1, "roots");
  click(row(host, "a"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");

  const text = host.textContent ?? "";
  for (const term of [
    "SHOULD-NOT-RENDER",
    "secretish",
    "dims",
    "vars",
    "deep",
    "[object Object]",
  ]) {
    assert.ok(!text.includes(term), `metadata reached the page: ${term}`);
  }
  // The panel still opened, for the path and its copy control - it is just not a metadata dump.
  assert.ok(q(host, ".dataset-tree__path"), "the panel lost the path it does exist for");
  handle.destroy();
});

test("no inline event handler or style attribute is ever emitted", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = await mountHostile(host);
  // `evil:1` is expandable AND carries detail, so what it knows is behind its own control - a
  // small card anchored to that control, not a panel under the row.
  click(q(host, '[data-dt-key="info:evil:1"]'));
  await until(() => Boolean(q(host, ".dataset-tree__infocard")), "info card");

  for (const element of qa(host, "*")) {
    for (const attribute of Array.from(element.attributes)) {
      assert.ok(!attribute.name.startsWith("on"), `${element.tagName} carries ${attribute.name}`);
      assert.notEqual(attribute.name, "style", `${element.tagName} carries an inline style`);
    }
  }
  await tick();
  handle.destroy();
});
