/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PNG_MAX_SIDE,
  adoptDisplayStyles,
  adoptStyles,
  pngDimensions,
  renderBundle,
  renderNotice,
  renderPng,
} from "../../src/display/render.js";
import { NOTICE_MIME } from "../../src/types.js";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A PNG header claiming the given size: enough for the budget check, never decoded. */
function pngClaiming(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return btoa(String.fromCharCode(...bytes));
}

const urls: string[] = [];
const ctx = () => ({ document, track: (url: string) => urls.push(url) });

describe("renderBundle", () => {
  afterEach(() => {
    urls.length = 0;
    vi.restoreAllMocks();
  });

  it("prefers HTML and sanitises it", () => {
    const node = renderBundle(
      { "text/plain": "df", "text/html": "<table><tr><td>1</td></tr></table><script>x</script>" },
      undefined,
      ctx(),
    );
    expect(node.classList.contains("fv-html")).toBe(true);
    expect(node.querySelector("td")?.textContent).toBe("1");
    expect(node.querySelector("script")).toBeNull();
  });

  it("renders a PNG through a tracked Blob URL, with metadata sizes", () => {
    URL.createObjectURL = vi.fn(() => "blob:fake-1");
    const node = renderBundle(
      { "text/plain": "<Figure>", "image/png": TINY_PNG },
      { "image/png": { width: 10, height: 20 } },
      ctx(),
    );
    const img = node.querySelector("img");
    expect(img?.getAttribute("src")).toBe("blob:fake-1");
    expect(img?.width).toBe(10);
    expect(urls).toEqual(["blob:fake-1"]);
  });

  it("refuses a PNG over the pixel budget before decoding it", () => {
    expect(pngDimensions(Uint8Array.from(atob(pngClaiming(3, 4)), (c) => c.charCodeAt(0)))).toEqual(
      {
        width: 3,
        height: 4,
      },
    );
    const node = renderPng(pngClaiming(PNG_MAX_SIDE + 1, 10), ctx());
    expect(node?.textContent).toMatch(/over the display budget/);
    expect(urls).toHaveLength(0);
  });

  it("falls back to text for a PNG that is not one", () => {
    const node = renderBundle(
      { "text/plain": "plain", "image/png": btoa("GIF89a") },
      undefined,
      ctx(),
    );
    expect(node.tagName).toBe("PRE");
    expect(node.textContent).toBe("plain");
  });

  it("shows an SVG as an image, never inline", () => {
    URL.createObjectURL = vi.fn(() => "blob:fake-svg");
    const node = renderBundle(
      {
        "text/plain": "s",
        "image/svg+xml": '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      },
      undefined,
      ctx(),
    );
    expect(node.querySelector("svg")).toBeNull();
    expect(node.querySelector("img")?.getAttribute("src")).toBe("blob:fake-svg");
  });

  it("draws the notice card and falls back to text for a malformed notice", () => {
    const card = renderBundle(
      {
        "text/plain": "RuntimeError: no JSPI",
        [NOTICE_MIME]: JSON.stringify({ notice: "needs-jspi", text: "RuntimeError: no JSPI\n" }),
      },
      undefined,
      ctx(),
    );
    expect(card.classList.contains("fv-notice-host")).toBe(true);
    expect(card.querySelector(".bp-notice")).not.toBeNull();
    expect(renderNotice("{not json", ctx())).toBeNull();
    expect(renderNotice(JSON.stringify({ notice: "other", text: "x" }), ctx())).toBeNull();
  });

  it("adopts the display rules once per root", () => {
    const before = document.adoptedStyleSheets?.length ?? 0;
    adoptDisplayStyles(document);
    adoptDisplayStyles(document);
    const after = document.adoptedStyleSheets?.length ?? 0;
    expect(after - before).toBeLessThanOrEqual(1);
    adoptStyles(document, "p{}");
    adoptStyles(document, "p{}");
    expect((document.adoptedStyleSheets?.length ?? 0) - after).toBeLessThanOrEqual(1);
    adoptDisplayStyles(null);
  });
});
