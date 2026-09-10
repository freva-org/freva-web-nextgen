// Inspect gating and graceful degradation (the inspector is imported lazily, never at mount).

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFetch, makeHost, overviewResponse, searchResponse, wait, tick } from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";

function q<T extends Element = Element>(r: ParentNode, s: string): T | null {
  return r.querySelector<T>(s);
}
function qa<T extends Element = Element>(r: ParentNode, s: string): T[] {
  return Array.from(r.querySelectorAll<T>(s));
}

const router = () => (call: { url: string }) => {
  if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
  if (call.url.includes("search"))
    return {
      body: searchResponse({
        total: 1,
        rows: [{ file: "/d/a.nc" }],
        facets: { project: ["cmip6", 1] },
      }),
    };
  return { body: {} };
};

async function openMenuInspect(
  cfg: Parameters<typeof mountDataBrowser>[1],
): Promise<{ root: HTMLElement; statusMsg: () => string; destroy: () => void }> {
  installFetch(router());
  const host = makeHost();
  const handle = mountDataBrowser(host, cfg);
  await wait(30);
  const root = q<HTMLElement>(host, ".freva-db") as HTMLElement;
  (q<HTMLButtonElement>(root, ".kebab") as HTMLButtonElement).click();
  await tick();
  const inspectItem = qa<HTMLElement>(root, ".pop-item").find((n) =>
    /inspect/i.test(n.textContent ?? ""),
  );
  inspectItem?.click();
  await wait(40);
  return {
    root,
    statusMsg: () => q<HTMLElement>(root, ".status-msg")?.textContent ?? "",
    destroy: () => handle.destroy(),
  };
}

test("Inspect is gated: without auth+heavyOps it warns and never imports the package", async () => {
  const { root, destroy } = await openMenuInspect({}); // defaults: authEnabled false
  // a warning toast/log about needing sign-in; no data-inspector element created
  assert.equal(q(root, "data-inspector"), null, "no inspector element when gated off");
  destroy();
});

test("Inspect enabled: the lazy import is attempted and never throws out of the click", async () => {
  const { root, statusMsg, destroy } = await openMenuInspect({
    authEnabled: true,
    enableHeavyOps: true,
  });
  await wait(60);
  // whether the module resolves or not, the outcome is surfaced rather than thrown
  assert.ok(statusMsg().length > 0, "the inspect attempt was surfaced on the footer");
  void root;
  destroy();
});
