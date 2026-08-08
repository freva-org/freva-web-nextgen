// The package used STANDALONE - no data browser anywhere in the process.
//
// That is the point of the seam: the window knows about text, segments and callbacks, and nothing
// about facets. If any of these tests needed application state, the seam would be leaking.

import "./helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

import { clipboardWrites, makeHost, rect, stubLayout, tick, window as win } from "./helpers.js";
import { createTerminal } from "../src/terminal.js";
import { STYLES } from "../src/styles.js";
import type { TerminalSegment, TerminalTab } from "../src/types.js";

const q = <T extends Element>(r: ParentNode, s: string): T | null => r.querySelector<T>(s);
const qa = <T extends Element>(r: ParentNode, s: string): T[] => [...r.querySelectorAll<T>(s)];

/**
 * A minimal host: one tab over a tiny "greet NAME" grammar. Deliberately NOT a facet browser - a
 * second freva-client command should be able to register a tab exactly like this.
 */
function greetTab(state: { text: string; commits: string[] }): TerminalTab {
  return {
    id: "greet",
    cssPrefix: "te",
    label: "greet",
    placeholder: "name=world",
    prefix: (): TerminalSegment[] => [
      { text: "$", kind: "prompt" },
      { text: " " },
      { text: "freva-client greet", kind: "fixed" },
    ],
    text: () => state.text,
    highlight: (text) => {
      const eq = text.indexOf("=");
      if (eq < 0) return { segments: [{ text, kind: "key" }] };
      return {
        segments: [
          { text: text.slice(0, eq), kind: "key" },
          { text: "=", kind: "eq" },
          { text: text.slice(eq + 1), kind: "value" },
        ],
        warning: text.startsWith("name=") ? undefined : "only `name` is a greeting option",
      };
    },
    complete: (text, caret) => {
      const typed = text.slice(0, caret);
      if (typed.includes("=")) return null;
      const candidates = ["name", "nickname"].filter((c) => c.startsWith(typed));
      const best = candidates.find((c) => c.length > typed.length);
      return {
        items: candidates.map((value) => ({ value, count: null })),
        ghost: best ? best.slice(typed.length) : "",
        ghostValue: best,
        apply: (value) => ({ text: `${value}=`, caret: value.length + 1 }),
      };
    },
    commit: (text) => {
      state.commits.push(text);
      return { dirty: false };
    },
    copyText: () => `freva-client greet ${state.text}`,
  };
}

function mountStandalone(): {
  host: HTMLElement;
  root: HTMLElement;
  state: { text: string; commits: string[] };
  handle: ReturnType<typeof createTerminal>;
} {
  const host = makeHost();
  const state = { text: "name=world", commits: [] as string[] };
  const handle = createTerminal(host, { tabs: [greetTab(state)] });
  return { host, root: handle.el, state, handle };
}

test("the package mounts, renders and commits with no host application at all", async () => {
  const { root, state, handle } = mountStandalone();
  handle.toggle(true);
  await tick();
  assert.ok(handle.isShown(), "the window opened");
  assert.match(q<HTMLElement>(root, ".cli-prefix")?.textContent ?? "", /freva-client greet/);
  assert.equal(
    (q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement).value,
    "name=world",
    "the buffer came from the tab model",
  );
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.focus();
  input.value = "name=freva";
  input.setSelectionRange(10, 10);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  assert.deepEqual(
    state.commits[state.commits.length - 1],
    "name=freva",
    "the host's commit callback ran",
  );
  handle.destroy();
});

test("it ships its own stylesheet, scoped to its own root", () => {
  const { root, handle } = mountStandalone();
  const style = q<HTMLElement>(root, "style");
  assert.ok(style, "the window injects its stylesheet itself - no host CSS required");
  assert.equal(style!.textContent, STYLES);
  // Everything is under `.freva-term`, so nothing leaks into a host page.
  const selectors = STYLES.split("\n").filter((l) => /^[.#a-zA-Z[].*\{\s*$/.test(l.trim()));
  const unscoped = selectors.filter((l) => !l.includes(".freva-term") && !l.trim().startsWith("@"));
  assert.deepEqual(unscoped, [], "every rule is scoped to the package root");
  handle.destroy();
});

test("the prefix and the command are inline SIBLINGS in one flow - no indent layer", () => {
  const { root, handle } = mountStandalone();
  const flow = q<HTMLElement>(root, ".te-flow");
  assert.ok(flow, "there is a shared flow container");
  const kids = [...flow!.children];
  // Prefix, command, then the two PRESENTATION-ONLY siblings: the ghost layer and the parked
  // caret. Both live outside the editable node on purpose - a ghost inside it would end up in
  // `Editor.value`, which is the buffer that gets committed, copied and parsed.
  assert.equal(kids.length, 4, "prefix, command, ghost layer, parked caret");
  assert.ok(kids[1].classList.contains("te-cmd"), "the command is the second child");
  assert.ok(kids[2].classList.contains("te-ghost"), "the ghost is a SIBLING of the command");
  assert.equal(kids[2].parentElement, flow, "the ghost is not inside the editable node");
  assert.ok(kids[3].classList.contains("te-caret"));
  assert.ok(kids[0].classList.contains("cli-prefix"));
  assert.ok(kids[1].classList.contains("te-cmd"));
  assert.match(STYLES, /\.te-flow\s*\{[^}]*white-space:\s*pre-wrap/);
  assert.match(STYLES, /\.cli-prefix\s*\{[^}]*position:\s*static/);
  assert.doesNotMatch(STYLES, /--te-indent/, "the indent variable is gone for good");
  assert.doesNotMatch(STYLES, /text-indent:\s*var\(/, "…and nothing writes an indent");
  handle.destroy();
});

test("a plain-textarea fallback is retained for engines without plaintext-only", () => {
  const { root, handle } = mountStandalone();
  // jsdom has no plaintext-only support, so the fallback is what mounted here.
  assert.ok(q(root, ".te-input"), "the textarea fallback is present");
  assert.ok(q(root, ".te-hl"), "…with its highlight overlay");
  assert.ok(q(root, ".cli-prefix-block"), "…and the prefix as a block above it");
  handle.destroy();
});

test("the open window is positioned in its CONTAINER's space, never the viewport's", () => {
  // A stylesheet-level guard on purpose. jsdom does not compute `position`, so only a real browser
  // can catch the window reverting to `position: fixed`, and that reversion is silent. `fixed`
  // inside a transformed or contained ancestor resolves against THAT ancestor, and inside an
  // `overflow: hidden` mount the window is simply clipped away.
  const rules = STYLES.match(/\.freva-term\.show\s*\{[^}]*\}/g) ?? [];
  assert.ok(rules.length > 0, "the open-window rule exists");
  const positioned = rules.filter((r) => /position:/.test(r));
  assert.equal(positioned.length, 1, "the window's position is declared in exactly ONE place");
  assert.match(positioned[0], /position:\s*absolute/, "…and it is absolute, in the mount's space");
  for (const rule of rules) {
    assert.doesNotMatch(rule, /position:\s*fixed/, "no rule re-pins the window to the viewport");
    assert.doesNotMatch(rule, /\d+vw/, "no viewport width units");
    assert.doesNotMatch(rule, /\d+vh/, "no viewport height units");
  }
  assert.match(positioned[0], /calc\(100% - /, "width is a share of the CONTAINER");
});

test("the settings menu opens ABOVE the bar when the window is minimized", async () => {
  const { root, handle } = mountStandalone();
  handle.toggle(true);
  await tick();
  const boxes = new Map<Element, DOMRect>();
  // A container 600px tall; the docked window is pinned to its bottom edge.
  boxes.set(root.parentElement as Element, rect(0, 0, 900, 600));
  boxes.set(root, rect(600, 560, 300, 40));
  boxes.set(q<HTMLElement>(root, ".term-bar") as Element, rect(600, 560, 300, 40));
  const restore = stubLayout(boxes, rect(0, 0, 900, 600));
  Object.defineProperty(win, "innerHeight", { value: 600, configurable: true });
  Object.defineProperty(win, "innerWidth", { value: 900, configurable: true });
  try {
    (q<HTMLElement>(root, ".tl.min") as HTMLElement).click();
    assert.ok(root.classList.contains("minimized"), "the window docked");
    (q<HTMLElement>(root, ".term-kebab") as HTMLElement).click();
    const menu = q<HTMLElement>(root, ".term-menu") as HTMLElement;
    assert.ok(menu.classList.contains("show"), "the settings menu opened while docked");
    assert.ok(
      menu.classList.contains("above"),
      "a menu anchored BELOW the bar of a bottom-pinned window opens off-screen",
    );
    assert.equal(menu.style.top, "auto");
    assert.match(menu.style.bottom, /calc\(100% \+/, "it is flipped over the title bar");
    // …and it is clamped to the container, so it cannot run off the top either.
    assert.ok(parseFloat(menu.style.maxHeight) <= 560, "clamped within the container");
    // The controls it exists for stay reachable.
    assert.ok(qa(menu, ".bg-sw").length > 0, "colour swatches are present");
    assert.ok(q(menu, ".term-alpha"), "the opacity control is present");
    assert.match(STYLES, /\.freva-term\.minimized \.term-menu\.show\s*\{\s*display:\s*block/);
  } finally {
    restore();
    handle.destroy();
  }
});

test("extra menu items from the host are rendered and stay clickable while docked", async () => {
  const host = makeHost();
  const state = { text: "", commits: [] as string[] };
  let helped = 0;
  const handle = createTerminal(host, {
    tabs: [greetTab(state)],
    menuItems: [
      { label: "How to install", onSelect: () => helped++ },
      { label: "Documentation ↗", href: "https://example.org/docs" },
    ],
  });
  handle.toggle(true);
  await tick();
  (q<HTMLElement>(handle.el, ".tl.min") as HTMLElement).click();
  (q<HTMLElement>(handle.el, ".term-kebab") as HTMLElement).click();
  const items = qa<HTMLElement>(handle.el, ".term-menu .tmn-item");
  assert.equal(items.length, 2);
  items[0].click();
  assert.equal(helped, 1, "the host's callback ran");
  assert.equal(items[1].getAttribute("rel"), "noopener noreferrer");
  assert.equal(items[1].getAttribute("target"), "_blank");
  handle.destroy();
});

test("window geometry is CONTAINER-relative, so it cannot be dragged out of its component", async () => {
  const host = makeHost();
  const state = { text: "", commits: [] as string[] };
  const handle = createTerminal(host, { tabs: [greetTab(state)], bounds: () => host });
  handle.toggle(true);
  await tick();
  const root = handle.el;
  const boxes = new Map<Element, DOMRect>();
  // The component occupies only part of a much larger page - the embedded-host shape.
  boxes.set(host, rect(200, 100, 600, 400));
  boxes.set(root, rect(500, 300, 300, 200));
  const restore = stubLayout(boxes, rect(200, 100, 600, 400));
  Object.defineProperty(win, "innerWidth", { value: 2000, configurable: true });
  Object.defineProperty(win, "innerHeight", { value: 1500, configurable: true });
  try {
    const bar = q<HTMLElement>(root, ".term-bar") as HTMLElement;
    bar.dispatchEvent(
      new win.MouseEvent("mousedown", { clientX: 520, clientY: 310, bubbles: true }),
    );
    // Drag far past the bottom-right of the PAGE - the container is the wall, not the viewport.
    win.dispatchEvent(new win.MouseEvent("mousemove", { clientX: 1900, clientY: 1400 }));
    const left = parseFloat(root.style.left);
    const top = parseFloat(root.style.top);
    assert.ok(left <= 600 - 300, `left ${left} stays inside the 600px-wide container`);
    assert.ok(top <= 400 - 200, `top ${top} stays inside the 400px-tall container`);
    assert.ok(left >= 0 && top >= 0, "…and not off its top-left either");
    win.dispatchEvent(new win.MouseEvent("mouseup", {}));
  } finally {
    restore();
    handle.destroy();
  }
});

test("copy uses the tab's own copyText", async () => {
  const { root, handle } = mountStandalone();
  clipboardWrites.length = 0;
  (q<HTMLElement>(root, ".copy-btn") as HTMLElement).click();
  await tick();
  assert.deepEqual(clipboardWrites, ["freva-client greet name=world"]);
  handle.destroy();
});

test("Tab completes, and Esc-then-Tab is the advertised way out (WCAG 2.1.2)", async () => {
  const { root, handle } = mountStandalone();
  handle.toggle(true);
  await tick();
  const input = q<HTMLTextAreaElement>(root, ".te-input") as HTMLTextAreaElement;
  input.focus();
  input.value = "nam";
  input.setSelectionRange(3, 3);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await tick();
  assert.equal(q<HTMLElement>(root, ".te-hl .te-ghost")?.textContent, "e", "a ghost is offered");
  const tab = (): boolean => {
    const e = new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    return e.defaultPrevented;
  };
  assert.equal(tab(), true, "Tab is the terminal's - it completes rather than moving focus");
  assert.equal(input.value, "name=", "…and it completed");
  // Esc arms the exit, and the footer hint says so.
  input.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  assert.match(q<HTMLElement>(root, ".te-hint")?.textContent ?? "", /now leaves the terminal/);
  assert.equal(tab(), false, "the armed Tab is allowed to move focus out");
  handle.destroy();
});

test("destroy() removes the window and leaves no listeners behind", async () => {
  const { host, handle, root } = mountStandalone();
  handle.toggle(true);
  await tick();
  handle.destroy();
  assert.equal(host.querySelector(".freva-term"), null, "the window is gone");
  // A stray window listener would throw or mutate the detached tree on the next event.
  win.dispatchEvent(new win.MouseEvent("mousemove", { clientX: 10, clientY: 10 }));
  win.dispatchEvent(new win.Event("resize"));
  await tick();
  assert.equal(root.isConnected, false);
});

test("two mounts are independent", async () => {
  const a = mountStandalone();
  const b = mountStandalone();
  a.handle.toggle(true);
  await tick();
  assert.ok(a.handle.isShown());
  assert.ok(!b.handle.isShown(), "opening one window does not open the other");
  const inputA = q<HTMLTextAreaElement>(a.root, ".te-input") as HTMLTextAreaElement;
  inputA.focus();
  inputA.value = "name=one";
  inputA.dispatchEvent(new win.Event("input", { bubbles: true }));
  assert.deepEqual(a.state.commits[a.state.commits.length - 1], "name=one");
  assert.equal(b.state.commits.length, 0, "the other instance saw nothing");
  a.handle.destroy();
  b.handle.destroy();
});

test("the plain surface is APPLIED on the first render, not just declared", () => {
  // Initialising `mode` to "plain" and then calling `setMode("plain")` must still write the DOM:
  // an early return there leaves `data-mode` unset, and `.te-plain` - which the stylesheet hides
  // until that attribute says otherwise - stays invisible. Python is always plain, so that gives
  // Python a textarea nobody can see, focus or click.
  const { root, handle } = mountStandalone();
  const editor = q<HTMLElement>(root, ".te-editor");
  assert.ok(editor, "there is an editor root");
  assert.equal(editor!.dataset.mode, "plain", "the mode is written to the DOM on the first render");
  const plain = q<HTMLElement>(root, ".te-plain");
  const flow = q<HTMLElement>(root, ".te-flow");
  assert.equal(plain!.style.display, "", "the plain surface is not inline-hidden");
  assert.equal(flow!.style.display, "none", "the rich flow is inline-hidden while plain is active");
  // …and the reveal is keyed off the GENERIC editor class, which every tab's root carries - not off
  // a per-tab class that python's `.py-wrap` root does not have.
  assert.ok(
    STYLES.includes('.te-editor[data-mode="plain"] .te-plain'),
    "the stylesheet reveals the plain surface via .te-editor",
  );
  const ta = q<HTMLTextAreaElement>(root, "textarea");
  ta!.focus();
  assert.equal(win.document.activeElement, ta, "the textarea can take focus");
  handle.destroy();
});

test("an unaccepted suggestion is never part of the buffer", () => {
  // The ghost is presentation. It lives OUTSIDE the editable node, so `Editor.value` - the buffer
  // that is committed, copied, parsed and retained - cannot contain it however the painting goes.
  const { root, handle } = mountStandalone();
  const input = q<HTMLTextAreaElement>(root, ".te-input")!;
  input.focus();
  input.value = "proj";
  input.setSelectionRange(4, 4);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  const ghosts = [...root.querySelectorAll(".te-ghost")];
  for (const g of ghosts) {
    assert.ok(!input.contains(g), "a ghost is never inside the editable node");
  }
  assert.equal(input.value, "proj", "the buffer is exactly what was typed");
  handle.destroy();
});

test("an active IME composition suppresses both the commit and the repaint", () => {
  const { root, handle, state } = mountStandalone();
  const input = q<HTMLTextAreaElement>(root, ".te-input")!;
  input.focus();
  const before = state.commits.length;
  input.dispatchEvent(new win.Event("compositionstart", { bubbles: true }));
  input.value = "project=cmip";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  assert.equal(state.commits.length, before, "a half-composed buffer was committed");
  input.value = "project=cmip6 ";
  input.dispatchEvent(new win.Event("compositionend", { bubbles: true }));
  assert.ok(state.commits.length > before, "compositionend did not settle the buffer");
  assert.equal(state.commits[state.commits.length - 1], "project=cmip6 ");
  handle.destroy();
});
