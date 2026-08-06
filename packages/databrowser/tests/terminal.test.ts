// The terminal: floating launcher, interactive python session, and tab close/reopen.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clipboardWrites,
  installFetch,
  makeHost,
  overviewResponse,
  searchResponse,
  wait,
  tick,
  window as win,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";

function q<T extends Element = Element>(r: ParentNode, s: string): T | null {
  return r.querySelector<T>(s);
}
function qa<T extends Element = Element>(r: ParentNode, s: string): T[] {
  return Array.from(r.querySelectorAll<T>(s));
}

async function mountTerm(): Promise<{
  root: HTMLElement;
  handle: ReturnType<typeof mountDataBrowser>;
}> {
  installFetch((call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [] }) };
    if (call.url.includes("search"))
      return {
        body: searchResponse({
          total: 42,
          rows: [{ file: "/d/a.nc" }],
          facets: { project: ["cmip6", 42] },
          primary: ["project"],
        }),
      };
    return { body: {} };
  });
  const host = makeHost();
  const handle = mountDataBrowser(host, {});
  await wait(30);
  const root = q<HTMLElement>(host, ".freva-db") as HTMLElement;
  (q<HTMLButtonElement>(root, '[aria-label="Command terminal"]') as HTMLButtonElement).click(); // launcher (top bar)
  await tick();
  return { root, handle };
}

test("terminal launcher lives in the top bar and opens a floating window", async () => {
  const { root, handle } = await mountTerm();
  assert.ok(
    q<HTMLElement>(root, '.top .iconbtn[aria-label="Command terminal"]'),
    "launcher is in the top bar",
  );
  assert.ok(q<HTMLElement>(root, ".cmd.show"), "terminal window shown");
  assert.ok(q(root, ".term-resize"), "has a resize handle");
  handle.destroy();
});

test("python tab is a multi-line session: editing kwargs drives the query (bare call form)", async () => {
  const { root, handle } = await mountTerm();
  const pyTab = q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement;
  pyTab.click();
  await tick();
  const view = () => q<HTMLElement>(root, ".py-view")?.textContent ?? "";
  assert.match(view(), /from freva_client import databrowser/);
  assert.match(view(), /databrowser\(/);
  assert.doesNotMatch(view(), /db = databrowser/, "no redundant binding");
  assert.ok(q(root, ".py-ml .py-gutter"), "has the ... continuation gutter");
  // edit kwargs (one per line) -> drives the live query
  const pyInput = q<HTMLTextAreaElement>(root, ".py-input") as HTMLTextAreaElement;
  pyInput.focus();
  pyInput.value = 'project="cmip6"';
  pyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  pyInput.dispatchEvent(new win.Event("blur", { bubbles: true }));
  await wait(30);
  assert.deepEqual(handle.getState().selected, { project: ["cmip6"] }, "kwargs drive the query");
  handle.destroy();
});

test("tabs close and reopen via + (at most one bash and one python)", async () => {
  const { root, handle } = await mountTerm();
  const pyTab = () => q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement;
  assert.equal(pyTab().style.display, "", "python tab open by default");
  // close python via its ×
  (pyTab().querySelector(".tab-x") as HTMLElement).click();
  await tick();
  assert.equal(pyTab().style.display, "none", "python tab closed");
  assert.equal(
    q<HTMLElement>(root, ".term-add")?.style.display,
    "",
    "reopen (+) shown when a tab is closed",
  );
  // reopen via +
  (q<HTMLButtonElement>(root, ".term-add") as HTMLButtonElement).click();
  await tick();
  assert.equal(pyTab().style.display, "", "python tab reopened");
  assert.equal(q<HTMLElement>(root, ".term-add")?.style.display, "none", "+ hidden when both open");
  handle.destroy();
});

test("terminal: a plain click on the header does NOT reposition the window (no jump)", async () => {
  const { root, handle } = await mountTerm();
  const cmd = q<HTMLElement>(root, ".cmd") as HTMLElement;
  const bar = q<HTMLElement>(root, ".term-bar") as HTMLElement;
  const before = cmd.style.left;
  bar.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, clientX: 400, clientY: 100 }));
  win.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true, clientX: 400, clientY: 100 }));
  assert.equal(cmd.style.left, before, "click did not pin/move the window");
  assert.notEqual(cmd.style.transform, "none", "centering transform intact after a mere click");
  handle.destroy();
});

test("terminal: dragging the header clears the centering transform (moves cleanly)", async () => {
  const { root, handle } = await mountTerm();
  const cmd = q<HTMLElement>(root, ".cmd") as HTMLElement;
  const bar = q<HTMLElement>(root, ".term-bar") as HTMLElement;
  bar.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, clientX: 400, clientY: 100 }));
  win.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, clientX: 460, clientY: 140 }));
  win.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true, clientX: 460, clientY: 140 }));
  assert.equal(
    cmd.style.transform,
    "none",
    "transform cleared inline on real drag (no half-width shift)",
  );
  assert.ok(cmd.style.left.endsWith("px"), "window pinned to explicit left");
  handle.destroy();
});

// OS-aware shell + switcher + host
async function mountTermCfg(
  cfg: Parameters<typeof mountDataBrowser>[1],
): Promise<{ root: HTMLElement; handle: ReturnType<typeof mountDataBrowser> }> {
  installFetch((call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [] }) };
    if (call.url.includes("search"))
      return {
        body: searchResponse({
          total: 5,
          rows: [{ file: "/d/a.nc" }],
          facets: { project: ["cmip6", 5] },
          primary: ["project"],
        }),
      };
    return { body: {} };
  });
  const host = makeHost();
  const handle = mountDataBrowser(host, cfg);
  await wait(30);
  const root = q<HTMLElement>(host, ".freva-db") as HTMLElement;
  (q<HTMLButtonElement>(root, '[aria-label="Command terminal"]') as HTMLButtonElement).click();
  await tick();
  return { root, handle };
}

test("config.terminal.os=windows -> PowerShell default (prompt PS>, continuation `)", async () => {
  try {
    window.localStorage?.removeItem("freva.db.shell");
  } catch {
    /* ignore */
  }
  const { root, handle } = await mountTermCfg({ terminal: { os: "windows" } });
  assert.equal(
    q<HTMLElement>(root, '.cmd-tab[data-cmd="cli"] .tab-label')?.textContent,
    "PowerShell",
  );
  assert.equal(q<HTMLElement>(root, ".cli-line .prompt")?.textContent, "PS>");
  assert.equal(
    q<HTMLElement>(root, ".cli-line .cont"),
    null,
    "no continuation glyph: the input continues the same line",
  );
  handle.destroy();
});

test("--host is never shown, even when configured (the client resolves its own host)", async () => {
  try {
    window.localStorage?.removeItem("freva.db.shell");
  } catch {
    /* ignore */
  }
  const { root, handle } = await mountTermCfg({
    terminal: { host: "https://freva.dkrz.de/api", os: "linux" },
  });
  assert.doesNotMatch(
    q<HTMLElement>(root, ".cli-line")?.textContent ?? "",
    /--host/,
    "bash line has no --host",
  );
  assert.equal(q<HTMLElement>(root, ".cli-line .term-host"), null, "no host token rendered");
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  const py = q<HTMLElement>(root, ".py-view")?.textContent ?? "";
  assert.doesNotMatch(py, /host=/, "python call has no host kwarg");
  assert.doesNotMatch(py, /db = /, "python call has no redundant `db =` binding");
  assert.doesNotMatch(
    py,
    /len\(db\)|list\(db\)/,
    "no len/list echo - the results panel shows the outcome",
  );
  handle.destroy();
});

test("window controls follow the OS (data-os on the terminal)", async () => {
  try {
    window.localStorage?.removeItem("freva.db.shell");
  } catch {
    /* ignore */
  }
  for (const [os, expected] of [
    ["windows", "windows"],
    ["linux", "linux"],
    ["mac", "mac"],
  ] as const) {
    const { root, handle } = await mountTermCfg({ terminal: { os } });
    assert.equal(
      q<HTMLElement>(root, ".cmd")?.getAttribute("data-os"),
      expected,
      `data-os=${expected}`,
    );
    handle.destroy();
  }
});

test("closing the LAST tab closes the whole terminal; reopening restores both tabs", async () => {
  const { root, handle } = await mountTerm();
  const cmd = () => q<HTMLElement>(root, ".cmd") as HTMLElement;
  assert.ok(cmd().classList.contains("show"), "terminal open");
  // close python, then bash (the last one)
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"] .tab-x') as HTMLElement).click();
  await tick();
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="cli"] .tab-x') as HTMLElement).click();
  await tick();
  assert.ok(!cmd().classList.contains("show"), "closing the last tab closed the whole terminal");
  // reopen via the launcher -> both tabs are back
  (q<HTMLButtonElement>(root, '[aria-label="Command terminal"]') as HTMLButtonElement).click();
  await tick();
  assert.ok(cmd().classList.contains("show"), "terminal reopened");
  assert.equal(
    (q<HTMLElement>(root, '.cmd-tab[data-cmd="cli"]') as HTMLElement).style.display,
    "",
    "bash tab restored",
  );
  assert.equal(
    (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).style.display,
    "",
    "python tab restored",
  );
  handle.destroy();
});

test("bash: inline ghost autocomplete suggests inline and Tab accepts (no dropdown)", async () => {
  const { root, handle } = await mountTerm();
  // seed known facet keys by settling a search with facets
  await wait(20);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.focus();
  input.value = "proj";
  input.setSelectionRange(4, 4);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(5);
  const ghost = q<HTMLElement>(root, ".te-hl .te-ghost");
  assert.ok(ghost, "an inline ghost suggestion is shown");
  assert.equal(ghost?.textContent, "ect", 'ghost completes "proj" -> "project"');
  assert.equal(q(root, ".te-menu.show"), null, "no menu shown by default");
  // Tab accepts the ghost -> the token becomes "project="
  input.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
  );
  assert.match(input.value, /^project=/, "Tab accepted the completion");
  handle.destroy();
});

test("bash: ↓ opens a browsable list of options (ghost stays for the fast path)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.focus();
  input.value = "proj";
  input.setSelectionRange(4, 4);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(5);
  assert.equal(q(root, ".te-menu.show"), null, "menu not shown until requested");
  input.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await wait(5);
  const menu = q<HTMLElement>(root, ".te-menu.show");
  assert.ok(menu, "ArrowDown opens the in-terminal options menu");
  assert.ok(
    menu && menu.querySelectorAll(".tm-item").length > 0,
    "the menu renders selectable items inside the terminal",
  );
  handle.destroy();
});

test("python: inline ghost autocomplete works in the multi-line editor (Tab accepts)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  const pyInput = q<HTMLTextAreaElement>(root, ".py-input") as HTMLTextAreaElement;
  pyInput.focus();
  pyInput.value = "proj";
  pyInput.setSelectionRange(4, 4);
  pyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(5);
  const ghost = q<HTMLElement>(root, ".py-hl .py-ghost");
  assert.ok(ghost, "python shows an inline ghost suggestion");
  assert.equal(ghost?.textContent, "ect", 'ghost completes "proj" -> "project"');
  pyInput.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
  );
  assert.match(pyInput.value, /^project/, "Tab accepted the python completion");
  handle.destroy();
});

test("python: ↓ opens the in-terminal options menu (last line)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  const pyInput = q<HTMLTextAreaElement>(root, ".py-input") as HTMLTextAreaElement;
  pyInput.focus();
  pyInput.value = "proj";
  pyInput.setSelectionRange(4, 4);
  pyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(5);
  pyInput.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await wait(5);
  const menu = q<HTMLElement>(root, ".py-menu.show");
  assert.ok(menu, "ArrowDown opens the python options menu");
  assert.ok(menu && menu.querySelectorAll(".tm-item").length > 0, "the python menu renders items");
  handle.destroy();
});

test("flavour is reflected in the python call, not just bash", async () => {
  const { root, handle } = await mountTermCfg({ flavour: "cmip6" });
  await wait(20);
  assert.match(
    q<HTMLElement>(root, ".cli-line")?.textContent ?? "",
    /--flavour/,
    "bash shows --flavour",
  );
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  assert.match(
    q<HTMLElement>(root, ".py-fixed")?.textContent ?? "",
    /flavour="cmip6"/,
    "python shows flavour=",
  );
  handle.destroy();
});

test("picking a KEY from the python menu completes it to `key=`", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  const pyInput = q<HTMLTextAreaElement>(root, ".py-input") as HTMLTextAreaElement;
  pyInput.focus();
  pyInput.value = "proj";
  pyInput.setSelectionRange(4, 4);
  pyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  pyInput.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await wait(5);
  const row = q<HTMLElement>(root, ".py-menu .tm-item");
  assert.ok(row, "menu lists keys");
  row!.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  assert.match(
    pyInput.value,
    /^project=$/,
    "the key is completed with a trailing = ready for the value",
  );
  handle.destroy();
});

test("an empty candidate list says so rather than showing nothing", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.focus();
  input.value = "zzz-not-a-key";
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await wait(5);
  const empty = q<HTMLElement>(root, ".te-menu.show .tm-empty");
  assert.ok(empty, "an explicit empty-state row is shown");
  assert.match(empty!.textContent ?? "", /no matching/i);
  handle.destroy();
});

test("terminal colour choice persists across mounts", async () => {
  const first = await mountTerm();
  await wait(20);
  (q<HTMLElement>(first.root, ".term-kebab") as HTMLElement).click();
  const sw = q<HTMLElement>(first.root, '.bg-sw[data-bg="forest"]') as HTMLElement;
  sw.click();
  assert.equal(
    (q<HTMLElement>(first.root, ".cmd") ?? first.root).style.getPropertyValue("--term-bg"),
    "#10201a",
  );
  first.handle.destroy();
  // a fresh mount reads the saved preset back
  const second = await mountTerm();
  await wait(20);
  const cmd = q<HTMLElement>(second.root, ".cmd") as HTMLElement;
  assert.equal(cmd.style.getPropertyValue("--term-bg"), "#10201a", "colour survived the remount");
  assert.ok(q(second.root, '.bg-sw.on[data-bg="forest"]'), "the saved swatch is marked selected");
  second.handle.destroy();
  try {
    window.localStorage?.removeItem("freva.db.term.bg");
  } catch {
    /* ignore */
  }
});

test("you can actually TYPE in the python tab (the collapsed line opens on focus)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  const pyMl = q<HTMLElement>(root, ".py-ml") as HTMLElement;
  assert.notEqual(pyMl.style.display, "none", "switching to the py tab opens the prompt line");
  const pyInput = q<HTMLTextAreaElement>(root, ".py-input") as HTMLTextAreaElement;
  pyInput.value = 'project="cmip6"';
  pyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  pyInput.dispatchEvent(new win.Event("blur", { bubbles: true }));
  await wait(30);
  assert.deepEqual(handle.getState().selected, { project: ["cmip6"] }, "typed kwargs still commit");
  handle.destroy();
});

test("bash: the input continues the command line (prefix painted inline, first line indented)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const row = q<HTMLElement>(root, ".cli-row") as HTMLElement;
  assert.ok(row, "there is a single command row");
  const prefix = row.querySelector(".cli-prefix");
  assert.ok(prefix, "prompt/command/read-only tokens are painted as one inline prefix");
  assert.ok(prefix!.querySelector(".cli-line"), "the prompt+command live in the prefix");
  assert.ok(row.querySelector(".term-edit"), "the input shares the row (not a column beside it)");
  // An UNMEASURABLE prefix (hidden view / zero-width layout, as in jsdom) must NOT be written as a
  // ~0 indent - that would make the typed text overlap the painted prompt the next time bash is
  // shown. No measurement -> keep the last good value rather than clobbering it.
  assert.equal(
    row.style.getPropertyValue("--te-indent"),
    "",
    "no bogus indent from a 0-width measure",
  );
  handle.destroy();
});

test("time/bbox are shown ONCE (no duplicate summary under the prompt)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  assert.equal(
    (q<HTMLElement>(root, ".te-extra")?.textContent ?? "").trim(),
    "",
    "the aux line does not repeat the same time/bbox values",
  );
  handle.destroy();
});

test("flavour names never leak into the facet-key autocomplete", async () => {
  installFetch((call: { url: string }) => {
    if (call.url.includes("/overview")) {
      // the real shape: attributes are keyed BY FLAVOUR, each holding that flavour's facet keys
      return {
        body: {
          flavours: ["freva", "cmip6"],
          attributes: { freva: ["project", "variable"], cmip6: ["mip_era"] },
        },
      };
    }
    if (call.url.includes("search"))
      return {
        body: searchResponse({ total: 1, rows: [{ file: "/a.nc" }], facets: {}, primary: [] }),
      };
    return { body: {} };
  });
  const host = makeHost();
  const handle = mountDataBrowser(host, {});
  await wait(40);
  const keys = handle.getState().attributeKeys;
  assert.ok(!keys.includes("cmip6"), "the FLAVOUR name is not a facet key");
  assert.ok(!keys.includes("freva"), "the FLAVOUR name is not a facet key");
  assert.deepEqual(
    keys,
    ["project", "variable"],
    "keys come from the current flavour\u2019s attribute list",
  );
  handle.destroy();
});

test("the cursor blinks in BOTH tabs without needing focus (it shows where to start)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  assert.ok(q(root, ".te-hl .te-caret"), "bash shows a cursor even before you click");
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  assert.ok(q(root, ".py-hl .te-caret"), "python shows a cursor too");
  assert.notEqual(
    (q<HTMLElement>(root, ".py-ml") as HTMLElement).style.display,
    "none",
    "the py prompt line is always present",
  );
  handle.destroy();
});

test("the window cannot be dragged past any edge of the page", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const cmd = q<HTMLElement>(root, ".cmd") as HTMLElement;
  const bar = q<HTMLElement>(root, ".term-bar") as HTMLElement;
  const down = (x: number, y: number) =>
    bar.dispatchEvent(
      new win.MouseEvent("mousedown", { clientX: x, clientY: y, bubbles: true, cancelable: true }),
    );
  const move = (x: number, y: number) =>
    window.dispatchEvent(
      new win.MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }),
    );
  const up = () => window.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
  // shove it hard past the bottom-right
  down(100, 10);
  move(99999, 99999);
  up();
  assert.ok(parseFloat(cmd.style.left) <= window.innerWidth, "clamped at the right edge");
  assert.ok(parseFloat(cmd.style.top) <= window.innerHeight, "clamped at the bottom edge");
  // …and past the top-left
  down(100, 10);
  move(-99999, -99999);
  up();
  assert.equal(parseFloat(cmd.style.left), 0, "clamped at the left edge");
  assert.equal(parseFloat(cmd.style.top), 0, "clamped at the top edge");
  handle.destroy();
});

test("exactly ONE cursor per tab (the native caret is hidden; we draw our own)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const styleText = q<HTMLElement>(root, "style")?.textContent ?? "";
  // both inputs must hide the native caret, or it shows up alongside the drawn block cursor
  assert.match(
    styleText,
    /\.te-input\s*\{[^}]*caret-color:\s*transparent/,
    "bash hides the native caret",
  );
  assert.match(
    styleText,
    /\.py-input\s*\{[^}]*caret-color:\s*transparent/,
    "python hides the native caret",
  );
  assert.equal(qa(root, ".te-hl .te-caret").length, 1, "bash draws exactly one cursor");
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  assert.equal(qa(root, ".py-hl .te-caret").length, 1, "python draws exactly one cursor");
  handle.destroy();
});

test("typing bbox= in bash sets the REAL bbox (no fake facet chip) and can be removed", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.focus();
  input.value = "bbox=-10,10,35,60 bbox_select=strict ";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(340);
  const st = handle.getState();
  assert.deepEqual(
    st.bbox,
    { minLon: -10, maxLon: 10, minLat: 35, maxLat: 60, mode: "strict" },
    "the real bbox is set",
  );
  assert.equal(st.selected.bbox, undefined, "bbox is NOT a facet (no fake chip)");
  assert.equal(st.selected.bbox_select, undefined, "nor is bbox_select");
  // removing the token clears it
  input.value = "";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(new win.Event("blur", { bubbles: true }));
  await wait(340);
  assert.equal(handle.getState().bbox, null, "deleting the token removes the bbox");
  handle.destroy();
});

test("bbox/time offer a how-to hint (not an empty list); *_select lists its modes", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.focus();
  input.value = "bbox=";
  input.setSelectionRange(5, 5);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await wait(5);
  const hint = q<HTMLElement>(root, ".te-menu.show .tm-empty");
  assert.ok(hint, "a guidance row is shown for a key whose value must be typed");
  assert.match(hint!.textContent ?? "", /minLon,maxLon,minLat,maxLat/, "it says HOW to type it");
  assert.match(hint!.textContent ?? "", /defaults to flexible/, "and that bbox_select defaults");
  // bbox_select is a closed set -> a real list
  input.value = "bbox_select=";
  input.setSelectionRange(12, 12);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await wait(5);
  const rows = qa<HTMLElement>(root, ".te-menu.show .tm-item:not(.tm-empty)").map(
    (r) => r.textContent,
  );
  assert.equal(rows.length, 3, "flexible / strict / file");
  handle.destroy();
});

test("ArrowDown keeps moving even when a slow value list refreshes underneath it", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.focus();
  input.value = "bbox_select=";
  input.setSelectionRange(12, 12);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await wait(5);
  input.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await wait(5);
  const before = q<HTMLElement>(root, ".te-menu .tm-item.hl")?.textContent;
  assert.equal(before, "strict", "moved to the 2nd row");
  // a refresh of the same list (what an enrich response triggers) must not snap back to row 1
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(5);
  assert.equal(
    q<HTMLElement>(root, ".te-menu .tm-item.hl")?.textContent,
    "strict",
    "the highlighted row survives a list refresh",
  );
  handle.destroy();
});

test("the drawn cursor moves WITH the caret (clicking mid-line puts it there)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  const hl = q<HTMLElement>(root, ".te-hl") as HTMLElement;
  /** the overlay text that precedes the drawn cursor */
  const textBeforeCaret = (): string => {
    const caret = hl.querySelector(".te-caret");
    assert.ok(caret, "exactly one cursor is drawn");
    let acc = "";
    const walk = (n: Node): boolean => {
      for (const c of Array.from(n.childNodes)) {
        if (c === caret) return true;
        if (c.nodeType === 1 && walk(c)) return true;
        if (c.nodeType === 3) acc += c.textContent ?? "";
      }
      return false;
    };
    walk(hl);
    return acc;
  };

  input.focus();
  input.value = "project=cmip6";
  input.setSelectionRange(13, 13);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(5);
  assert.equal(
    textBeforeCaret(),
    "project=cmip6",
    "cursor at the end when the caret is at the end",
  );

  // click into the middle -> the block must follow the caret, not stay pinned to the end
  input.setSelectionRange(7, 7); // just after "project"
  input.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await wait(5);
  assert.equal(textBeforeCaret(), "project", "the cursor is drawn exactly where the caret is");
  assert.equal(qa(root, ".te-hl .te-caret").length, 1, "still exactly one cursor");
  handle.destroy();
});

test("switching back from python does not collapse the bash writing area", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  // go to python (bash hidden -> a naive fit() would measure scrollHeight 0 and pin height:0)
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  const pyInput = q<HTMLTextAreaElement>(root, ".py-input") as HTMLTextAreaElement;
  pyInput.value = 'project="cmip6"';
  pyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(320); // the commit re-renders the (hidden) bash input
  assert.notEqual(input.style.height, "0px", "the hidden textarea was never pinned to zero height");
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="cli"]') as HTMLElement).click();
  await tick();
  assert.notEqual(input.style.height, "0px", "and it is not collapsed when bash comes back");
  handle.destroy();
});

test("pressing copy / settings must not drag the terminal window", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const cmd = q<HTMLElement>(root, ".cmd") as HTMLElement;
  const move = (x: number, y: number) =>
    window.dispatchEvent(
      new win.MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }),
    );
  const up = () => window.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
  for (const sel of [".copy-btn", ".term-kebab", ".cmd-tab", ".tl.min"]) {
    cmd.style.left = "";
    cmd.style.top = "";
    const el = q<HTMLElement>(root, sel) as HTMLElement;
    el.dispatchEvent(
      new win.MouseEvent("mousedown", {
        clientX: 100,
        clientY: 20,
        bubbles: true,
        cancelable: true,
      }),
    );
    move(190, 120);
    up();
    assert.equal(cmd.style.left, "", `mousedown on ${sel} must not reposition the window`);
    assert.equal(cmd.style.top, "", `mousedown on ${sel} must not reposition the window`);
  }
  handle.destroy();
});

test("copied python is clean: closes the paren, no blank lines", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  (q<HTMLButtonElement>(root, ".copy-btn") as HTMLButtonElement).click();
  await tick();
  const copied: string = clipboardWrites[clipboardWrites.length - 1];
  assert.match(copied, /databrowser\(\)$/, "an empty query copies as databrowser()");
  assert.ok(
    !copied.split("\n").some((l: string) => l.trim() === ""),
    "no blank lines inside the call",
  );
  handle.destroy();
});

test("the light terminal preset flips the whole token palette (not just the text)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const cmd = q<HTMLElement>(root, ".cmd") as HTMLElement;
  assert.equal(cmd.getAttribute("data-term-light"), "false", "dark presets are not flagged light");
  (q<HTMLElement>(root, ".term-kebab") as HTMLElement).click();
  (q<HTMLElement>(root, '.bg-sw[data-bg="paper"]') as HTMLElement).click();
  assert.equal(cmd.getAttribute("data-term-light"), "true", "the paper preset flags itself light");
  assert.equal(cmd.style.getPropertyValue("--term-fg"), "#22262b", "and carries a dark foreground");
  handle.destroy();
  try {
    window.localStorage?.removeItem("freva.db.term.bg");
  } catch {
    /* ignore */
  }
});

test("terminal opacity is adjustable and persists", async () => {
  const first = await mountTerm();
  await wait(20);
  const slider = q<HTMLInputElement>(first.root, ".term-alpha") as HTMLInputElement;
  slider.value = "0.7";
  slider.dispatchEvent(new win.Event("input", { bubbles: true }));
  assert.equal(
    (q<HTMLElement>(first.root, ".cmd") as HTMLElement).style.getPropertyValue("--term-alpha"),
    "0.7",
  );
  first.handle.destroy();
  const second = await mountTerm();
  await wait(20);
  assert.equal(
    (q<HTMLElement>(second.root, ".cmd") as HTMLElement).style.getPropertyValue("--term-alpha"),
    "0.7",
    "the opacity choice survives a remount",
  );
  second.handle.destroy();
  try {
    window.localStorage?.removeItem("freva.db.term.alpha");
  } catch {
    /* ignore */
  }
});

test("Clear all wins over a half-typed terminal draft (the cleared facets stay gone)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.focus();
  input.value = "project=cmip6 ";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(340);
  assert.deepEqual(handle.getState().selected, { project: ["cmip6"] }, "facet committed");

  // start typing a time token, leave it incomplete, then hit Clear all in the UI
  input.value = "project=cmip6 time=";
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(340);
  const clear = qa<HTMLButtonElement>(root, "button").find((b) =>
    /clear all/i.test(b.textContent ?? ""),
  );
  assert.ok(clear, "Clear all button exists");
  clear!.click();
  await wait(60);

  assert.deepEqual(handle.getState().selected, {}, "the UI cleared the facets");
  assert.ok(
    !input.value.includes("project=cmip6"),
    "the terminal no longer shows the cleared facet",
  );
  assert.ok(
    input.value.includes("time="),
    "but the in-progress token the user was typing survives",
  );

  // continuing to type must NOT resurrect the cleared facets
  input.value = 'time="2000 TO 2010" ';
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(340);
  const st = handle.getState();
  assert.equal(st.selected.project, undefined, "the cleared facet did not come back");
  assert.deepEqual(
    st.time,
    { from: "2000", to: "2010", mode: "flexible" },
    "and the new token committed",
  );
  handle.destroy();
});

test("python: Tab on a key completes it to `key=` (same as picking it from the menu)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  const pyInput = q<HTMLTextAreaElement>(root, ".py-input") as HTMLTextAreaElement;
  pyInput.focus();
  pyInput.value = "proj";
  pyInput.setSelectionRange(4, 4);
  pyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(5);
  pyInput.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
  );
  assert.equal(pyInput.value, "project=", "Tab completes the key AND adds the =");
  handle.destroy();
});

test("python: several kwargs can share one line (completion tracks the last one)", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  const pyInput = q<HTMLTextAreaElement>(root, ".py-input") as HTMLTextAreaElement;
  pyInput.focus();
  // two kwargs on ONE line - the completion must apply to the SECOND one, not the whole line
  // (the fixture's only facet key is `project`, so we complete a second `project` kwarg)
  pyInput.value = 'time="2000 TO 2010", proj';
  pyInput.setSelectionRange(pyInput.value.length, pyInput.value.length);
  pyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(5);
  const ghost = q<HTMLElement>(root, ".py-hl .py-ghost");
  assert.ok(ghost, "the second kwarg on the line still autocompletes");
  assert.equal(ghost?.textContent, "ect", '"proj" -> "project" (the segment after the comma)');
  pyInput.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
  );
  assert.equal(pyInput.value, 'time="2000 TO 2010", project=', "completed in place, = appended");

  // and both kwargs on that one line commit
  pyInput.value = 'time="2000 TO 2010", project="cmip6"';
  pyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  pyInput.dispatchEvent(new win.Event("blur", { bubbles: true }));
  await wait(340);
  const st = handle.getState();
  assert.deepEqual(st.selected, { project: ["cmip6"] }, "the facet on the shared line committed");
  assert.deepEqual(
    st.time,
    { from: "2000", to: "2010", mode: "flexible" },
    "and so did the time token",
  );
  handle.destroy();
});

test("python: Tab on a VALUE writes real python - quotes + comma, exactly like the menu pick", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  (q<HTMLElement>(root, '.cmd-tab[data-cmd="py"]') as HTMLElement).click();
  await tick();
  const pyInput = q<HTMLTextAreaElement>(root, ".py-input") as HTMLTextAreaElement;

  // (a) Tab-accepting the ghost
  pyInput.focus();
  pyInput.value = 'project="cmi';
  pyInput.setSelectionRange(pyInput.value.length, pyInput.value.length);
  pyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  await wait(5);
  pyInput.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
  );
  const viaTab = pyInput.value;
  assert.equal(
    viaTab,
    'project="cmip6",',
    "Tab closes the quote and adds the comma (no doubled quote)",
  );

  // (b) picking the same value from the menu must produce the IDENTICAL text
  pyInput.value = 'project="cmi';
  pyInput.setSelectionRange(pyInput.value.length, pyInput.value.length);
  pyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  pyInput.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await wait(5);
  const row = q<HTMLElement>(root, ".py-menu .tm-item");
  assert.ok(row, "the menu lists the value");
  row!.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  assert.equal(pyInput.value, viaTab, "Tab and the menu produce exactly the same python");
  handle.destroy();
});

test("an open completion menu is sized to the space available and scrolled into view", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.focus();
  input.value = "project=";
  input.setSelectionRange(8, 8);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await wait(5);
  const menu = q<HTMLElement>(root, ".te-menu.show");
  assert.ok(menu, "the menu is open");
  // the flip class is only applied when the body is actually laid out (never in jsdom), but the
  // menu must always live INSIDE the terminal, so it can never be hidden behind the window
  assert.equal(
    menu!.closest(".term-body")?.classList.contains("term-body"),
    true,
    "the menu renders inside the terminal body, not as a floating popover",
  );
  handle.destroy();
});

test("a maximized window cannot be dragged (Gmail rule): it neither shrinks nor jumps top-left", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const cmd = q<HTMLElement>(root, ".cmd") as HTMLElement;
  const bar = q<HTMLElement>(root, ".term-bar") as HTMLElement;
  (q<HTMLElement>(root, ".tl.zoom") as HTMLElement).click();
  assert.ok(cmd.classList.contains("zoomed"), "maximized");

  bar.dispatchEvent(
    new win.MouseEvent("mousedown", { clientX: 200, clientY: 20, bubbles: true, cancelable: true }),
  );
  window.dispatchEvent(
    new win.MouseEvent("mousemove", { clientX: 400, clientY: 300, bubbles: true }),
  );
  window.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
  assert.equal(cmd.style.left, "", "a maximized window is not repositioned by dragging");
  assert.ok(cmd.classList.contains("zoomed"), "and it stays maximized");

  // un-maximize -> dragging works again
  (q<HTMLElement>(root, ".tl.zoom") as HTMLElement).click();
  bar.dispatchEvent(
    new win.MouseEvent("mousedown", { clientX: 200, clientY: 20, bubbles: true, cancelable: true }),
  );
  window.dispatchEvent(
    new win.MouseEvent("mousemove", { clientX: 240, clientY: 60, bubbles: true }),
  );
  window.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
  assert.ok(cmd.style.left !== "", "a restored window drags normally again");
  handle.destroy();
});

test("Tab stays in the terminal (even with nothing to complete), and Esc/Shift+Tab release it", async () => {
  const { root, handle } = await mountTerm();
  await wait(20);
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.focus();

  // nothing to complete -> Tab must NOT teleport focus out of the terminal
  input.value = "zzz-nothing-here";
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  const tab = new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true, "Tab is consumed by the terminal, not the page");

  // Esc arms the exit, and says so
  const esc = new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  input.dispatchEvent(esc);
  assert.match(
    q<HTMLElement>(root, ".term-foot .te-hint")?.textContent ?? "",
    /now leaves/i,
    "the footer hint tells the user Tab will now leave (WCAG 2.1.2 requires advising the method)",
  );
  const tab2 = new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(tab2);
  assert.equal(tab2.defaultPrevented, false, "after Esc, Tab moves focus out");

  // Shift+Tab is always an escape route
  const back = new win.KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(back);
  assert.equal(back.defaultPrevented, false, "Shift+Tab always leaves");
  handle.destroy();
});

test("minimized dock drags horizontally only (stays pinned to the bottom); a drag never re-opens", async () => {
  const { root, handle } = await mountTerm();
  const cmd = q<HTMLElement>(root, ".cmd") as HTMLElement;
  const bar = q<HTMLElement>(cmd, ".term-bar") as HTMLElement;

  // minimize -> docks to the bottom, no custom horizontal offset yet (CSS default applies)
  (q<HTMLButtonElement>(cmd, ".tl.min") as HTMLButtonElement).click();
  await tick();
  assert.ok(cmd.classList.contains("minimized"), "terminal docked");
  assert.equal(cmd.style.getPropertyValue("--dock-right"), "", "no inline offset before dragging");

  // press the bar and drag with a LARGE vertical component too - only the horizontal offset moves.
  bar.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, clientX: 500, clientY: 700 }));
  win.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, clientX: 380, clientY: 100 }));
  win.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true, clientX: 380, clientY: 100 }));

  const right = cmd.style.getPropertyValue("--dock-right");
  assert.ok(right.endsWith("px") && parseFloat(right) >= 0, "a horizontal offset was applied");
  assert.equal(cmd.style.top, "", "vertical position untouched (no inline top)");
  assert.equal(cmd.style.bottom, "", "still pinned to the bottom via CSS (no inline bottom)");

  // the press that ended the drag must NOT also re-open the terminal
  bar.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await tick();
  assert.ok(cmd.classList.contains("minimized"), "dragging the dock does not re-open it");

  // a plain click (no drag) still re-opens it
  bar.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await tick();
  assert.ok(!cmd.classList.contains("minimized"), "a plain click re-opens the terminal");
  handle.destroy();
});

test("Terminal hint lives in a single footer, not duplicated in the scrolling body", async () => {
  const { root, handle } = await mountTerm();
  const cmd = q<HTMLElement>(root, ".cmd") as HTMLElement;
  const foot = q<HTMLElement>(cmd, ".term-foot");
  assert.ok(foot, "the terminal has a footer strip");
  assert.ok(foot!.querySelector(".te-hint"), "the hint is in the footer");
  assert.match(foot!.textContent ?? "", /Tab.*completes/, "footer carries the keyboard hint");
  // the keys are real keycaps (<kbd>), not plain text
  assert.ok(qa<HTMLElement>(foot!, "kbd").length >= 3, "the hint keys render as keycaps");
  // one shared copy - it must not be duplicated in both the bash and python views
  assert.equal(qa<HTMLElement>(cmd, ".te-hint").length, 1, "exactly one hint, shared");
  assert.equal(
    qa<HTMLElement>(cmd, ".term-body .te-hint").length,
    0,
    "none left in the scrolling body",
  );
  handle.destroy();
});
