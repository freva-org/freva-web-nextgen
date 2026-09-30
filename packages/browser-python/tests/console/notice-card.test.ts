/**
 * @vitest-environment happy-dom
 */
// The no-JSPI card: the visitor's browser, how far it is from one that works, what still works,
// and the ways out - Chrome first where switching is quicker than updating.
import { describe, expect, it } from "vitest";
import { describeBrowser } from "../../src/notices.js";
import { renderNeedsJspi, supportNote, trackPosition } from "../../src/console/notice-card.js";

const SAFARI_26 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15";
const CHROME_136 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1";

const card = (userAgent: string, origin: "error" | "hint" = "error") =>
  renderNeedsJspi(
    { notice: "needs-jspi", origin, text: "RuntimeError: plain text\n" },
    { document, browser: describeBrowser({ userAgent }) },
  );
const text = (root: Element, selector: string) =>
  [...root.querySelectorAll(selector)].map((n) => n.textContent ?? "");

describe("the no-JSPI card", () => {
  it("says the code is fine and shows the visitor's browser against the one that works", () => {
    const root = card(SAFARI_26);
    expect(root.querySelector(".bp-notice-title")?.textContent).toBe(
      "One browser update away from remote data",
    );
    expect(root.querySelector(".bp-notice-sub")?.textContent).toContain("Your code is fine");
    expect(text(root, ".bp-notice-you")).toEqual(["you: Safari 26.2"]);
    expect(text(root, ".bp-notice-need")).toEqual(["Safari 27 ✓"]);
    expect(root.querySelector(".bp-notice-track")?.getAttribute("aria-label")).toContain(
      "Safari 26.2 installed",
    );
  });

  it("lists what still works, and the one thing that does not", () => {
    const root = card(SAFARI_26);
    expect(root.querySelectorAll(".bp-notice-ok")).toHaveLength(3);
    expect(text(root, ".bp-notice-no")[0]).toContain("Opening datasets from a URL");
  });

  it("offers Chrome first on Safari, with the page link to copy, then the update", () => {
    const root = card(SAFARI_26);
    const routes = [...root.querySelectorAll(".bp-notice-route")];
    expect(routes).toHaveLength(2);
    expect(routes[0]?.textContent).toContain("Have Chrome? Skip the update");
    expect(routes[0]?.querySelector(".bp-notice-badge")?.textContent).toBe("Fastest");
    expect(text(routes[0]!, "button")).toEqual(["Copy page link"]);
    expect(routes[1]?.textContent).toContain("Keep Safari: update to 27+");
    const help = routes[1]?.querySelector("a");
    expect(help?.getAttribute("href")).toBe("https://support.apple.com/102665");
    expect(help?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("does not suggest Chrome to someone on an old Chrome: it updates itself", () => {
    const root = card(CHROME_136);
    expect(root.textContent).not.toContain("Have Chrome?");
    expect(root.textContent).toContain("Chrome updates itself");
    expect(root.querySelector(".bp-notice-route-title")?.textContent).toBe("Update Chrome to 137+");
  });

  it("on iPhone asks for a system update, never another browser", () => {
    const root = card(IPHONE);
    expect(root.textContent).not.toContain("Have Chrome?");
    expect(root.querySelector(".bp-notice-track")).toBeNull();
    expect(root.textContent).toContain("iOS/iPadOS 27");
  });

  it("keeps the plain message under Technical details", () => {
    const root = card(SAFARI_26);
    expect(root.querySelector("details .bp-notice-plain")?.textContent).toBe(
      "RuntimeError: plain text",
    );
  });

  it("as a startup hint, is one line until asked", () => {
    const root = card(SAFARI_26, "hint");
    const body = root.querySelector<HTMLElement>(".bp-notice-body")!;
    const toggle = root.querySelector<HTMLButtonElement>(".bp-notice-toggle")!;
    expect(root.getAttribute("role")).toBe("note");
    expect(body.hidden).toBe(true);
    toggle.click();
    expect(body.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("builds no markup from strings", () => {
    const root = renderNeedsJspi(
      { notice: "needs-jspi", origin: "error", text: "<img src=x onerror=alert(1)>" },
      { document, browser: describeBrowser({ userAgent: SAFARI_26 }) },
    );
    expect(root.querySelector("img")).toBeNull();
  });
});

describe("helpers", () => {
  it("places a version on the track within its ends", () => {
    expect(trackPosition(26, 27)).toBeCloseTo(0.9);
    expect(trackPosition(90, 137)).toBe(0.06);
  });

  it("writes an IT note naming the browser, the version needed and the page", () => {
    const note = supportNote(describeBrowser({ userAgent: SAFARI_26 }), "https://example.org/p");
    expect(note).toContain("Safari 26.2");
    expect(note).toContain("Safari 27 or later");
    expect(note).toContain("https://example.org/p");
  });
});

describe("the card's controls", () => {
  const withClipboard = (writeText: (text: string) => Promise<void>) =>
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const button = (root: Element, label: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent === label)!;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("copies the page the host names, not this document's address", async () => {
    const copied: string[] = [];
    withClipboard(async (text) => void copied.push(text));
    const root = renderNeedsJspi(
      { notice: "needs-jspi", origin: "error", text: "" },
      {
        document,
        browser: describeBrowser({ userAgent: SAFARI_26 }),
        pageUrl: () => "https://portal.example/datasets/",
      },
    );
    button(root, "Copy page link").click();
    await flush();
    expect(copied).toEqual(["https://portal.example/datasets/"]);
  });

  it("shows the text to select when the clipboard refuses, as the button says", async () => {
    withClipboard(() => Promise.reject(new Error("denied")));
    const root = renderNeedsJspi(
      { notice: "needs-jspi", origin: "error", text: "" },
      {
        document,
        browser: describeBrowser({ userAgent: SAFARI_26 }),
        pageUrl: () => "https://portal.example/datasets/",
      },
    );
    document.body.append(root);
    const copy = button(root, "Copy page link");
    copy.click();
    await flush();
    expect(copy.textContent).toBe("Copy failed - select it below");
    const field = root.querySelector<HTMLInputElement>(".bp-notice-reveal-field");
    expect(field?.value).toBe("https://portal.example/datasets/");
    expect(field?.readOnly).toBe(true);
    // The IT note is longer and multi-line capable: a text area, in its own route.
    button(root, "Copy note for IT support").click();
    await flush();
    const note = root.querySelector<HTMLTextAreaElement>("textarea.bp-notice-reveal-field");
    expect(note?.value).toContain("Safari 27 or later");
    root.remove();
  });

  it("opens links through the host when it can open them, and still shows the address", () => {
    const opened: string[] = [];
    const root = renderNeedsJspi(
      { notice: "needs-jspi", origin: "error", text: "" },
      {
        document,
        browser: describeBrowser({ userAgent: SAFARI_26 }),
        openExternal: () => (url) => opened.push(url),
      },
    );
    const get = [...root.querySelectorAll("a")].find((a) => a.textContent === "Get Chrome ↗")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    get.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual(["https://www.google.com/chrome/"]);
    expect(root.querySelector<HTMLInputElement>(".bp-notice-reveal-field")?.value).toBe(
      "https://www.google.com/chrome/",
    );
  });

  it("keeps its keys: nothing pressed on a control reaches the terminal around it", () => {
    const root = card(SAFARI_26);
    const outer = document.createElement("div");
    outer.append(root);
    const seen: string[] = [];
    for (const type of ["keydown", "keypress", "keyup"]) {
      outer.addEventListener(type, () => seen.push(type));
    }
    const copy = button(root, "Copy page link");
    for (const type of ["keydown", "keypress", "keyup"]) {
      const event = new KeyboardEvent(type, { key: "Tab", bubbles: true, cancelable: true });
      copy.dispatchEvent(event);
      // Propagation stopped, default untouched: Tab still moves focus.
      expect(event.defaultPrevented).toBe(false);
    }
    expect(seen).toEqual([]);
  });
});
