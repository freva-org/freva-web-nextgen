// @vitest-environment jsdom
// The notebook sheet over a page: a closed sheet keeps the frame - and the visitor's session - but
// never the keyboard, even when the notebook inside focuses itself after the sheet was closed.
import { afterEach, describe, expect, it, vi } from "vitest";

const { openNotebook } = await import("../src/ui/notebook/notebook-sheet.js");

afterEach(() => {
  vi.useRealTimers();
});

describe("the notebook sheet", () => {
  it("gives focus back when the closed notebook takes it", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div id="portal-overlay-root"></div><a id="opener" href="#">Open</a>`;
    const opener = document.getElementById("opener") as HTMLAnchorElement;
    opener.focus();
    openNotebook({ href: "/notebook/lab/index.html", frame: true }, undefined, document);
    const root = document.querySelector<HTMLElement>(".portal-notebook-sheet");
    const frame = document.querySelector<HTMLIFrameElement>("iframe.portal-notebook-frame");
    expect(root && frame).toBeTruthy();

    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(root!.dataset.closed).toBe("");
    expect(document.activeElement).toBe(opener);

    // The notebook, loading inside the closed sheet, focuses its own document.
    frame!.tabIndex = -1;
    frame!.focus();
    window.dispatchEvent(new Event("blur"));
    await vi.runAllTimersAsync();
    expect(document.activeElement).toBe(opener);
    expect(root!.inert).toBe(true);
  });
});
