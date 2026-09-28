import "./helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  installFetch,
  makeHost,
  overviewResponse,
  searchResponse,
  wait,
  window as win,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";

test("no key combination reaches the search field, and none is advertised", async () => {
  installFetch(((call: { url: string }) =>
    call.url.includes("/overview")
      ? { body: overviewResponse(["freva"], {}) }
      : {
          body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }], primary: ["project"] }),
        }) as never);
  const host = makeHost();
  const handle = mountDataBrowser(host, {});
  await wait(40);
  const root = host.querySelector(".freva-db") as HTMLElement;
  const input = root.querySelector<HTMLInputElement>(".search input")!;
  assert.ok(input, "the search field is there");

  assert.equal(input.getAttribute("aria-keyshortcuts"), null);
  assert.doesNotMatch(input.getAttribute("aria-label") ?? "", /Control|Command|\+K/);
  assert.equal(root.querySelectorAll(".search-kbd, .search kbd").length, 0, "a shortcut hint");

  const doc = host.ownerDocument;
  (doc.activeElement as HTMLElement | null)?.blur?.();
  for (const init of [
    { key: "k", ctrlKey: true },
    { key: "K", ctrlKey: true, shiftKey: true },
    { key: "k", metaKey: true },
    { key: "/" },
  ]) {
    const event = new win.KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    doc.body.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, `${JSON.stringify(init)} was taken`);
    assert.notEqual(doc.activeElement, input, `${JSON.stringify(init)} moved focus to search`);
  }
  handle.destroy();
});
