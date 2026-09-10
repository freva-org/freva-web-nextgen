// The window, with nothing in it.
//
// The chrome is embedded by another package, so what is checked here is that contract: the body is
// empty and the host's, the copy control asks the host what to copy, appearance covers colour,
// opacity AND text size, the ⋮ menu carries sections a host owns, and minimize / maximize /
// restore / hide all work with no editor to focus.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createTerminalWindow } from "../src/window.js";
import { STYLES } from "../src/styles.js";
import type { TerminalStorage } from "../src/types.js";
import { clipboardWrites, makeHost, rect, stubLayout, tick } from "./helpers.js";

const q = <T extends Element = Element>(root: ParentNode, sel: string): T | null =>
  root.querySelector<T>(sel);
const qa = <T extends Element = Element>(root: ParentNode, sel: string): T[] =>
  Array.from(root.querySelectorAll<T>(sel));

function memoryStorage(): TerminalStorage & { saved: Record<string, unknown> } {
  const saved: Record<string, unknown> = {};
  return {
    saved,
    getTheme: () => (saved.theme as string) ?? null,
    setTheme: (id) => {
      saved.theme = id;
    },
    getAlpha: () => (saved.alpha as number) ?? null,
    setAlpha: (a) => {
      saved.alpha = a;
    },
    getTextScale: () => (saved.scale as number) ?? null,
    setTextScale: (s) => {
      saved.scale = s;
    },
  };
}

test("the window is the real chrome, and its body is empty and the host's", () => {
  const host = makeHost();
  const win = createTerminalWindow(host);

  // The same root, the same class vocabulary, the same stylesheet - not a look-alike.
  assert.ok(win.el.classList.contains("freva-term"));
  assert.ok(win.el.classList.contains("cmd"));
  // jsdom has no `adoptedStyleSheets`, so this asserts the `<style>` fallback. The constructable
  // route is covered by `portal-builder/browser-tests/python-playground.mjs` (`style-src 'self'`).
  assert.equal(q(win.el, "style")?.textContent, STYLES);
  for (const control of [".tl.close", ".tl.min", ".tl.zoom", ".term-kebab", ".term-resize"]) {
    assert.ok(q(win.el, control), `the window has no ${control}`);
  }

  assert.equal(win.body.className, "term-body");
  assert.equal(win.body.childNodes.length, 0, "the window put something in the host's slot");
  assert.equal(win.foot, null, "a footer nobody asked for");

  const content = document.createElement("div");
  content.className = "my-console";
  win.body.append(content);
  assert.ok(q(win.el, ".term-body > .my-console"), "host content did not land in the body");
  win.destroy();
});

test("`data-os` is surfaced verbatim, and the footer is opt-in", () => {
  const host = makeHost();
  const win = createTerminalWindow(host, { os: "windows", foot: true });
  assert.equal(win.el.getAttribute("data-os"), "windows");
  assert.ok(win.foot, "the footer was asked for and not drawn");
  assert.equal(win.foot?.className, "term-foot");
  win.destroy();
});

test("the copy control asks the host what to copy, and is absent when there is nothing", async () => {
  const bare = createTerminalWindow(makeHost());
  assert.equal(q(bare.el, ".copy-btn"), null, "a copy control with nothing to copy");
  bare.destroy();

  clipboardWrites.length = 0;
  const host = makeHost();
  let transcript = ">>> 1 + 1\n2\n";
  const win = createTerminalWindow(host, {
    copyText: () => transcript,
    copyLabel: "transcript",
    copyTitle: "Copy transcript",
  });
  const button = q<HTMLElement>(win.el, ".copy-btn") as HTMLElement;
  assert.equal(q(button, ".cb-word")?.textContent, "transcript");
  assert.equal(button.getAttribute("title"), "Copy transcript");

  button.click();
  await tick();
  assert.deepEqual(clipboardWrites, [">>> 1 + 1\n2\n"]);
  assert.ok(button.classList.contains("done"), "no confirmation");

  // It is read at press time, not captured once.
  transcript = ">>> 2 + 2\n4\n";
  button.click();
  await tick();
  assert.equal(clipboardWrites[1], ">>> 2 + 2\n4\n");
  win.destroy();
});

test("appearance covers colour, opacity and text size, and remembers all three", () => {
  const storage = memoryStorage();
  const first = createTerminalWindow(makeHost(), { storage });
  (q<HTMLElement>(first.el, ".term-kebab") as HTMLElement).click();

  assert.ok(q(first.el, ".tmn-group.open"), "the appearance group is nested but not hidden");
  assert.ok(qa(first.el, ".bg-sw").length > 0, "no colour swatches");

  (q<HTMLElement>(first.el, '.bg-sw[data-bg="forest"]') as HTMLElement).click();
  assert.equal(first.el.style.getPropertyValue("--term-bg"), "#10201a");

  const alpha = q<HTMLInputElement>(first.el, ".term-alpha") as HTMLInputElement;
  alpha.value = "0.7";
  alpha.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(first.el.style.getPropertyValue("--term-alpha"), "0.7");

  const scale = q<HTMLInputElement>(first.el, ".term-scale") as HTMLInputElement;
  scale.value = "1.3";
  scale.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(first.el.style.getPropertyValue("--term-scale"), "1.3");
  first.destroy();

  const second = createTerminalWindow(makeHost(), { storage });
  assert.equal(second.el.style.getPropertyValue("--term-bg"), "#10201a");
  assert.equal(second.el.style.getPropertyValue("--term-alpha"), "0.7");
  assert.equal(second.el.style.getPropertyValue("--term-scale"), "1.3");

  // Reset takes all three back at once, and persists that too.
  (q<HTMLElement>(second.el, ".tmn-reset") as HTMLElement).click();
  assert.equal(second.el.style.getPropertyValue("--term-scale"), "1");
  assert.equal(second.el.style.getPropertyValue("--term-alpha"), "0.85");
  assert.equal(second.el.style.getPropertyValue("--term-bg"), "#0b0f16");
  assert.equal(storage.saved.scale, 1);
  second.destroy();
});

test("opacity and text size are clamped, so no stored value can make the window unusable", () => {
  const storage = memoryStorage();
  storage.saved.alpha = 0;
  storage.saved.scale = 40;
  const win = createTerminalWindow(makeHost(), { storage });
  assert.equal(win.el.style.getPropertyValue("--term-alpha"), "0.55");
  assert.equal(win.el.style.getPropertyValue("--term-scale"), "1.6");
  win.destroy();
});

test("text size scales the CONTENT and leaves the chrome alone", () => {
  // The body must consult the multiplier; the title bar must not, or controls stop fitting.
  assert.match(STYLES, /--term-scale:\s*1;/);
  assert.match(STYLES, /\.term-body\s*\{[^}]*font-size:\s*calc\(12\.5px \* var\(--term-scale\)\)/s);
  const chrome = STYLES.slice(STYLES.indexOf(".freva-term .cmd-tab {"));
  const barRule = chrome.slice(0, chrome.indexOf("}"));
  assert.ok(!barRule.includes("--term-scale"), "the tab chips scale with the text");
});

test("the ⋮ menu carries host sections, in order, with the appearance group first", () => {
  const seen: string[] = [];
  const win = createTerminalWindow(makeHost(), {
    menuSections: [
      {
        title: "Transcript",
        items: [
          { label: "Clear transcript", onSelect: () => seen.push("clear") },
          { label: "Download transcript", onSelect: () => seen.push("download") },
        ],
      },
      {
        title: "Session",
        items: [
          { label: "Restart session…", onSelect: () => seen.push("restart"), danger: true },
          { label: "End session…", onSelect: () => seen.push("end"), danger: true },
        ],
      },
    ],
    menuItems: [{ label: "Keyboard shortcuts", onSelect: () => seen.push("keys") }],
  });
  (q<HTMLElement>(win.el, ".term-kebab") as HTMLElement).click();

  const menu = q<HTMLElement>(win.el, ".term-menu") as HTMLElement;
  assert.equal(menu.firstElementChild?.className, "tmn-group open", "appearance is not first");
  assert.deepEqual(
    qa(menu, ".tmn-h").map((h) => h.textContent),
    ["Colour", "Opacity", "Text size", "Transcript", "Session"],
  );
  assert.deepEqual(
    qa(menu, ".tmn-sections .tmn-item").map((i) => i.textContent),
    [
      "Clear transcript",
      "Download transcript",
      "Restart session…",
      "End session…",
      "Keyboard shortcuts",
    ],
  );
  assert.equal(qa(menu, ".tmn-danger").length, 2, "the destructive rows are not marked");

  (qa<HTMLElement>(menu, ".tmn-sections .tmn-item")[1] as HTMLElement).click();
  assert.deepEqual(seen, ["download"]);
  assert.equal(menu.classList.contains("show"), false, "the menu stayed open");

  // Sections can be replaced wholesale as the session's state changes.
  win.setMenuSections([
    { items: [{ label: "Start a session", onSelect: () => seen.push("start") }] },
  ]);
  assert.deepEqual(
    qa(menu, ".tmn-sections .tmn-item").map((i) => i.textContent),
    ["Start a session"],
  );
  win.destroy();
});

test("a host can place the appearance controls among its own rows, as a side panel", () => {
  const win = createTerminalWindow(makeHost(), {
    menuSections: [
      { title: "Session", items: [{ label: "New session\u2026", onSelect: () => undefined }] },
      { title: "Terminal", items: [{ label: "Terminal settings", appearance: true }] },
      { title: "Help", items: [{ label: "Keyboard shortcuts", onSelect: () => undefined }] },
    ],
  });
  (q<HTMLElement>(win.el, ".term-kebab") as HTMLElement).click();
  const menu = q<HTMLElement>(win.el, ".term-menu") as HTMLElement;

  // WHERE THE HOST PUT IT, not first. The appearance controls are widgets rather than rows, so a
  // host cannot express them in `menuSections`; an `appearance: true` item marks where they belong.
  const group = q<HTMLElement>(menu, ".tmn-group") as HTMLElement;
  assert.equal(group.closest(".tmn-block")?.querySelector(".tmn-h")?.textContent, "Terminal");
  assert.deepEqual(
    qa(menu, ".tmn-sections > .tmn-block > .tmn-h").map((h) => h.textContent),
    ["Session", "Terminal", "Help"],
  );
  // Its label is the host's word, and the widgets are still the window's.
  assert.equal(q(group, ".tmn-sub-label")?.textContent, "Terminal settings");
  assert.ok(q(group, ".term-bg-panel"), "the colour swatches did not travel with the group");
  assert.ok(q(group, ".tmn-reset"), "the reset row did not travel with the group");

  // A flyout, shut until asked for: an open one pushes the rows below it off an already tall menu.
  assert.ok(group.classList.contains("tmn-group--side"), "the group is not a side panel");
  assert.equal(group.classList.contains("open"), false, "the side panel starts open");
  const trigger = q<HTMLElement>(group, ".tmn-sub") as HTMLElement;
  trigger.click();
  assert.ok(group.classList.contains("open"), "pressing the row did not open the panel");
  assert.ok(
    menu.classList.contains("has-flyout"),
    "the menu still clips, so the panel is drawn inside a scroll container",
  );

  // Closing the menu takes the panel with it, so it is not the first thing seen next time.
  win.closeSettings();
  assert.equal(group.classList.contains("open"), false, "the panel survived the menu closing");
  assert.equal(menu.classList.contains("has-flyout"), false);

  // A host that claims nothing gets the default: first, inline, open - as the Data Browser does.
  win.setMenuSections([{ items: [{ label: "Only this", onSelect: () => undefined }] }]);
  assert.equal(menu.firstElementChild?.className, "tmn-group open", "appearance is not first");
  win.destroy();
});

test("minimize, maximize, restore and hide all work with nothing inside", () => {
  const events: string[] = [];
  const win = createTerminalWindow(makeHost(), {
    onShow: () => events.push("show"),
    onHide: () => events.push("hide"),
    onMinimize: (m) => events.push(`min:${m}`),
    onMaximize: (m) => events.push(`max:${m}`),
  });
  win.show();
  assert.equal(win.isShown(), true);

  (q<HTMLElement>(win.el, ".tl.min") as HTMLElement).click();
  assert.equal(win.isMinimized(), true);
  (q<HTMLElement>(win.el, ".tl.min") as HTMLElement).click();
  assert.equal(win.isMinimized(), false);

  (q<HTMLElement>(win.el, ".tl.zoom") as HTMLElement).click();
  assert.equal(win.isMaximized(), true);
  // Maximizing a minimized window un-minimizes it rather than being both at once.
  win.setMinimized(true);
  assert.equal(win.isMaximized(), false);

  (q<HTMLElement>(win.el, ".tl.close") as HTMLElement).click();
  assert.equal(win.isShown(), false);
  // Minimizing a maximized window reports BOTH transitions, in the order they happened.
  assert.deepEqual(events, [
    "show",
    "min:true",
    "min:false",
    "max:true",
    "max:false",
    "min:true",
    "hide",
  ]);
  win.destroy();
});

test("a press on the host's own bar controls does not drag the window", () => {
  const host = makeHost();
  const win = createTerminalWindow(host, { dragExclude: ".my-tab" });
  const tab = document.createElement("button");
  tab.className = "my-tab";
  win.bar.insertBefore(tab, win.barSpacer);

  const boxes = new Map<Element, DOMRect>();
  boxes.set(win.el, rect(100, 100, 400, 300));
  const restore = stubLayout(boxes, rect(0, 0, 900, 600));
  try {
    win.show();
    tab.dispatchEvent(
      new window.MouseEvent("mousedown", { bubbles: true, clientX: 150, clientY: 110 }),
    );
    window.dispatchEvent(
      new window.MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 260 }),
    );
    assert.equal(win.el.style.left, "", "pressing a host control dragged the window");

    // …but the bar itself still drags.
    win.bar.dispatchEvent(
      new window.MouseEvent("mousedown", { bubbles: true, clientX: 150, clientY: 110 }),
    );
    window.dispatchEvent(
      new window.MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 260 }),
    );
    assert.notEqual(win.el.style.left, "", "the title bar stopped dragging the window");
  } finally {
    restore();
    win.destroy();
  }
});

test("a press on empty body space is reported, and one on a control is not", () => {
  let activations = 0;
  const win = createTerminalWindow(makeHost(), { onBodyActivate: () => (activations += 1) });
  const button = document.createElement("button");
  win.body.append(button);

  win.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(activations, 1);
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(activations, 1, "a press on a control in the body was reported as empty space");
  win.destroy();
});

test("a press on content in the body leaves the selection gesture alone", () => {
  // Cancelling a mousedown kills the browser's selection gesture, so only a press on bare body
  // space - no text under it - is cancelled; a press on content stays draggable into a selection.
  const win = createTerminalWindow(makeHost(), {});
  const content = document.createElement("div");
  content.textContent = "Traceback (most recent call last):";
  win.body.append(content);

  const onContent = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  content.dispatchEvent(onContent);
  assert.equal(onContent.defaultPrevented, false, "a press on transcript text cancelled the drag");

  const onSpace = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  win.body.dispatchEvent(onSpace);
  assert.equal(onSpace.defaultPrevented, true, "a press on bare body space was not cancelled");
  win.destroy();
});

test("a click that ends a drag-selection does not report an activation", () => {
  let activations = 0;
  const win = createTerminalWindow(makeHost(), { onBodyActivate: () => (activations += 1) });
  const content = document.createElement("div");
  content.textContent = "ModuleNotFoundError: No module named 'xarray'";
  win.body.append(content);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(content);
  selection?.addRange(range);

  content.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(activations, 0, "focusing the prompt threw away the reader's selection");

  selection?.removeAllRanges();
  content.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(activations, 1, "a plain click no longer focuses the content");
  win.destroy();
});

test("destroy removes the window and unbinds everything", () => {
  const host = makeHost();
  let resizes = 0;
  const win = createTerminalWindow(host, { onResize: () => (resizes += 1) });
  win.show();
  win.destroy();
  assert.equal(host.contains(win.el), false, "the window is still in the host");
  const before = resizes;
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(resizes, before, "a destroyed window is still listening");
});

test("the stylesheet does not arrive as inline style when the platform offers better", () => {
  // A `<style>` element is INLINE STYLE, which a host with `style-src 'self'` refuses. jsdom has
  // no constructable stylesheets, so this SIMULATES one to check the preferred route is taken.
  const doc = document;
  const sheets: unknown[] = [];
  let replaced = "";
  const originalSheet = (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet;
  const originalAdopted = Object.getOwnPropertyDescriptor(doc, "adoptedStyleSheets");
  class FakeSheet {
    replaceSync(text: string): void {
      replaced = text;
    }
  }
  (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet = FakeSheet;
  Object.defineProperty(doc, "adoptedStyleSheets", {
    configurable: true,
    get: () => sheets,
    set: (next: unknown[]) => {
      sheets.length = 0;
      sheets.push(...next);
    },
  });
  try {
    const win = createTerminalWindow(makeHost());
    assert.equal(q(win.el, "style"), null, "a style element was appended anyway");
    assert.equal(sheets.length, 1, "no sheet was adopted");
    assert.equal(replaced, STYLES);

    const second = createTerminalWindow(makeHost());
    assert.equal(sheets.length, 1, "each window adopted its own copy of the stylesheet");
    win.destroy();
    second.destroy();
  } finally {
    if (originalAdopted) Object.defineProperty(doc, "adoptedStyleSheets", originalAdopted);
    else delete (doc as unknown as Record<string, unknown>).adoptedStyleSheets;
    (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet = originalSheet;
  }
});

// title-bar groups

test("the title bar is two groups with a gap between them, and the ⋮ menu is last", () => {
  const host = makeHost();
  const win = createTerminalWindow(host, { copyText: () => "x" });

  const names = (group: HTMLElement): string[] =>
    Array.from(group.children).map((n) => String(n.className).split(" ")[0]!);

  assert.deepEqual(names(win.barStart), ["traffic"]);
  assert.deepEqual(names(win.barEnd), ["copy-btn", "term-kebab"]);
  assert.deepEqual(
    Array.from(win.bar.children).map((n) => String(n.className).split(" ")[0]),
    ["term-bar-group", "spacer", "term-bar-group"],
  );

  // A host control put on the RIGHT lands before the menu, never after it - the reason
  // `addBarControl` exists rather than a bare `barEnd.append`: the ⋮ is the overflow for everything
  // beside it, and an overflow menu not at the end of the row it overflows is one nobody finds.
  const extra = document.createElement("button");
  extra.className = "host-control";
  win.addBarControl(extra, "end");
  assert.deepEqual(names(win.barEnd), ["copy-btn", "host-control", "term-kebab"]);

  const title = document.createElement("span");
  title.className = "host-title";
  win.addBarControl(title, "start");
  assert.deepEqual(names(win.barStart), ["traffic", "host-title"]);

  // The documented legacy route still lands in the left group, so existing consumers keep working.
  const legacy = document.createElement("span");
  legacy.className = "legacy";
  win.bar.insertBefore(legacy, win.barSpacer);
  assert.equal(win.bar.children[1], legacy, "inserting before the spacer left the left region");
  win.destroy();
});

test("`controlsSide` moves the window controls without disturbing the application group", () => {
  const host = makeHost();
  // `data-os` decides how the controls LOOK; this decides where they are. `start` is the default.
  const left = createTerminalWindow(host, { os: "linux", copyText: () => "x" });
  assert.ok(left.barStart.querySelector(".traffic"), "the default is not the left");
  left.destroy();

  const right = createTerminalWindow(host, { os: "linux", controlsSide: "end" });
  assert.ok(right.barEnd.querySelector(".traffic"), "`end` did not move the controls");
  // …and the ⋮ menu is STILL the last application control: with `order: 99` on the traffic cluster
  // the gap opens after the menu, pressing the window's controls against the host's title.
  const end = Array.from(right.barEnd.children).map((n) => String(n.className).split(" ")[0]);
  assert.equal(end[end.length - 1], "term-kebab");
  right.destroy();
});

// confirmation

test("the window's confirmation is an alertdialog with Cancel focused, and Escape cancels", async () => {
  const host = makeHost();
  const win = createTerminalWindow(host);
  win.show();

  const invoker = document.createElement("button");
  invoker.textContent = "Restart session…";
  document.body.append(invoker);
  invoker.focus();

  const answer = win.confirm({
    title: "Restart Session 1?",
    body: "Its variables will be lost.",
    confirmLabel: "Restart session",
    danger: true,
    returnFocus: invoker,
  });

  const panel = q<HTMLElement>(win.el, ".term-confirm")!;
  assert.ok(panel, "no dialog was drawn");
  assert.equal(panel.getAttribute("role"), "alertdialog");
  assert.equal(panel.getAttribute("aria-modal"), "true");
  // Named and described by real elements, not by a bare string nobody can find.
  assert.equal(
    document.getElementById(panel.getAttribute("aria-labelledby")!)?.textContent,
    "Restart Session 1?",
  );
  assert.equal(
    document.getElementById(panel.getAttribute("aria-describedby")!)?.textContent,
    "Its variables will be lost.",
  );
  const buttons = qa<HTMLButtonElement>(panel, "button");
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ["Cancel", "Restart session"],
  );
  assert.ok(buttons[1]!.classList.contains("term-confirm-danger"));
  assert.equal(document.activeElement, buttons[0], "Cancel is not focused");

  // A second request while one is open is refused, so a double press cannot act twice.
  assert.equal(await win.confirm({ title: "again", body: "again" }), false);
  assert.equal(qa(win.el, ".term-confirm").length, 1, "two dialogs were drawn");

  q<HTMLElement>(win.el, ".term-confirm-scrim")!.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(await answer, false, "Escape did not cancel");
  assert.equal(q(win.el, ".term-confirm"), null, "the dialog stayed on screen");
  assert.equal(document.activeElement, invoker, "the focus did not go back to the invoker");
  win.destroy();
});

test("confirming resolves true, and the ⋮ menu is closed before the question is asked", async () => {
  const host = makeHost();
  const win = createTerminalWindow(host, {
    menuItems: [{ label: "Restart session…", onSelect: () => undefined }],
  });
  win.show();
  // Open the menu the way a visitor does, then raise the question from inside it.
  q<HTMLButtonElement>(win.el, ".term-kebab")!.click();
  assert.ok(win.settings.classList.contains("show"), "the menu did not open");

  const row = qa<HTMLButtonElement>(win.settings, ".tmn-item").find(
    (b) => b.textContent === "Restart session…",
  )!;
  row.click();
  const answer = win.confirm({ title: "Restart?", body: "State is lost." });
  assert.equal(win.settings.classList.contains("show"), false, "the menu stayed open behind it");

  qa<HTMLButtonElement>(win.el, ".term-confirm-btn")[1]!.click();
  assert.equal(await answer, true);
  // Back to the row that raised it - not to the ⋮ button, and not to the document body.
  assert.equal(document.activeElement, row, "the focus did not return to the menu row");
  win.destroy();
});
