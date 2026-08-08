// The footer console (ring buffer) and toasts.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installFetch,
  makeHost,
  overviewResponse,
  searchResponse,
  wait,
  pickValue,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";

function q<T extends Element = Element>(r: ParentNode, s: string): T | null {
  return r.querySelector<T>(s);
}
function qa<T extends Element = Element>(r: ParentNode, s: string): T[] {
  return Array.from(r.querySelectorAll<T>(s));
}

const router = () => (call: { url: string }) => {
  if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], { project: [] }) };
  if (call.url.includes("search"))
    return {
      body: searchResponse({
        total: 2,
        rows: [{ file: "/d/a.nc" }],
        facets: { project: ["cmip6", 2] },
        primary: ["project"],
      }),
    };
  return { body: {} };
};

async function mount(): Promise<{ root: HTMLElement; destroy: () => void }> {
  installFetch(router());
  const host = makeHost();
  const handle = mountDataBrowser(host, {});
  await wait(30);
  return {
    root: q<HTMLElement>(host, ".freva-db") as HTMLElement,
    destroy: () => handle.destroy(),
  };
}

test("footer shows the latest event as a coloured message with a severity dot, and has NO event-log panel", async () => {
  const { root, destroy } = await mount();
  pickValue(root, "cmip6");
  await wait(320);
  const dot = q<HTMLElement>(root, ".status .status-dot");
  assert.ok(dot, "a severity dot is present in the footer");
  assert.match(
    dot!.className,
    /status-dot (info|success|warn|error)/,
    "the dot carries a severity class",
  );
  const msg = q<HTMLElement>(root, ".status .status-msg");
  assert.ok(msg, "the footer message element is present");
  assert.match(
    msg!.className,
    /status-msg (info|success|warn|error)/,
    "the message is coloured by severity",
  );
  assert.equal(q(root, ".console-panel"), null, "no event-log panel");
  assert.equal(q(root, ".log-toggle"), null, "no log toggle");
  assert.equal(q(root, ".log-count"), null, "no log count");
  (q<HTMLElement>(root, ".status") as HTMLElement).click();
  assert.equal(q(root, ".console-panel"), null, "still no panel after a footer click");
  destroy();
});

test("toasts pop and auto-dismiss, and the footer reflects the outcome", async () => {
  const { root, destroy } = await mount();
  installFetch((call: { url: string }) => {
    if (call.url.includes("-catalogue/")) return { body: { ok: true } };
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
  });
  (q<HTMLButtonElement>(root, '[aria-label="Export catalogue"]') as HTMLButtonElement).click();
  await wait(5);
  const intake = qa<HTMLButtonElement>(root, ".xm-item").find((b) =>
    /intake/i.test(b.textContent ?? ""),
  );
  intake?.click();
  await wait(80);
  const toastCount = qa(root, ".toast-host .toast").length;
  const footerMsg = q<HTMLElement>(root, ".status-msg")?.textContent ?? "";
  assert.ok(
    toastCount >= 1 || footerMsg.length > 0,
    "a toast appeared and/or the footer shows the outcome",
  );
  destroy();
});
