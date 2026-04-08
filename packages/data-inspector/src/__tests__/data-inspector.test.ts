import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { DataInspectorElement } from "../elements/data-inspector";

beforeAll(() => {
  if (!customElements.get("data-inspector")) {
    customElements.define("data-inspector", DataInspectorElement);
  }
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mount(attrs: Record<string, string> = {}): DataInspectorElement {
  const el = document.createElement("data-inspector") as DataInspectorElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

// ── Attribute accessors ──────────────────────────────────────────────────────

describe("attribute accessors", () => {
  it("open getter reflects attribute presence", () => {
    const el = mount();
    expect(el.open).toBe(false);
    el.setAttribute("open", "");
    expect(el.open).toBe(true);
  });

  it("open setter adds / removes attribute", () => {
    const el = mount();
    el.open = true;
    expect(el.hasAttribute("open")).toBe(true);
    el.open = false;
    expect(el.hasAttribute("open")).toBe(false);
  });

  it("file getter returns string for plain path", () => {
    const el = mount({ file: "/data/my.nc" });
    expect(el.file).toBe("/data/my.nc");
  });

  it("file getter parses JSON array", () => {
    const files = ["/a.nc", "/b.nc"];
    const el = mount({ file: JSON.stringify(files) });
    expect(el.file).toEqual(files);
  });

  it("file setter encodes array as JSON", () => {
    const el = mount();
    el.file = ["/a.nc", "/b.nc"];
    expect(el.getAttribute("file")).toBe(JSON.stringify(["/a.nc", "/b.nc"]));
  });

  it("file setter removes attribute when null", () => {
    const el = mount({ file: "/data/my.nc" });
    el.file = null;
    expect(el.hasAttribute("file")).toBe(false);
  });

  it("status defaults to ready when attribute absent", () => {
    const el = mount();
    expect(el.status).toBe("ready");
  });

  it("error getter returns null when absent", () => {
    const el = mount();
    expect(el.error).toBeNull();
  });

  it("error setter sets / removes attribute", () => {
    const el = mount();
    el.error = "something went wrong";
    expect(el.getAttribute("error")).toBe("something went wrong");
    el.error = null;
    expect(el.hasAttribute("error")).toBe(false);
  });

  it("zarrStatusCode getter parses integer", () => {
    const el = mount({ "zarr-status-code": "4" });
    expect(el.zarrStatusCode).toBe(4);
  });

  it("isAggregation reflects attribute presence", () => {
    const el = mount();
    expect(el.isAggregation).toBe(false);
    el.setAttribute("is-aggregation", "");
    expect(el.isAggregation).toBe(true);
  });
});

// ── Rendering ────────────────────────────────────────────────────────────────

describe("rendering", () => {
  it("renders nothing when not open", () => {
    const el = mount();
    expect(el.innerHTML.trim()).toBe("");
  });

  it("renders modal when open", () => {
    const el = mount({ open: "" });
    expect(el.querySelector("#nc-backdrop")).not.toBeNull();
  });

  it("renders close button when open", () => {
    const el = mount({ open: "" });
    expect(el.querySelector("#nc-close-btn")).not.toBeNull();
  });

  it("renders path input in single-file mode", () => {
    const el = mount({ open: "" });
    expect(el.querySelector("#nc-path-input")).not.toBeNull();
  });

  it("does not render path input in aggregation mode", () => {
    const el = mount({ open: "", "is-aggregation": "" });
    expect(el.querySelector("#nc-path-input")).toBeNull();
  });

  it("renders file list in aggregation mode", () => {
    const files = ["/a.nc", "/b.nc"];
    const el = mount({ open: "", "is-aggregation": "", file: JSON.stringify(files) });
    expect(el.innerHTML).toContain("/a.nc");
    expect(el.innerHTML).toContain("/b.nc");
  });

  it("renders error state", () => {
    const el = mount({
      open: "",
      status: "error",
      error: "File not found",
      "zarr-url": "https://z.example.com",
    });
    expect(el.innerHTML).toContain("File not found");
  });

  it("output setter triggers re-render", () => {
    const el = mount({ open: "", "zarr-url": "https://z.example.com" });
    el.output = "<table>metadata</table>";
    expect(el.innerHTML).toContain("metadata");
  });

  it("clears innerHTML when open is removed", () => {
    const el = mount({ open: "" });
    expect(el.innerHTML.trim()).not.toBe("");
    el.removeAttribute("open");
    expect(el.innerHTML.trim()).toBe("");
  });
});

// ── Events ───────────────────────────────────────────────────────────────────

describe("events", () => {
  it("emits inspector-close when close button is clicked", () => {
    const el = mount({ open: "" });
    const handler = vi.fn();
    el.addEventListener("inspector-close", handler);
    el.querySelector<HTMLButtonElement>("#nc-close-btn")!.click();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("emits inspector-submit with file when load button is clicked", () => {
    const el = mount({ open: "", file: "/data/my.nc" });
    const handler = vi.fn();
    el.addEventListener("inspector-submit", handler);

    const input = el.querySelector<HTMLInputElement>("#nc-path-input")!;
    input.value = "/data/my.nc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    el.querySelector<HTMLButtonElement>("#nc-load-btn")!.click();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.file).toBe("/data/my.nc");
  });

  it("emits inspector-submit on Enter key in path input", () => {
    const el = mount({ open: "" });
    const handler = vi.fn();
    el.addEventListener("inspector-submit", handler);

    const input = el.querySelector<HTMLInputElement>("#nc-path-input")!;
    input.value = "/data/enter.nc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("emits inspector-close when backdrop is clicked", () => {
    const el = mount({ open: "" });
    const handler = vi.fn();
    el.addEventListener("inspector-close", handler);

    const backdrop = el.querySelector<HTMLElement>("#nc-backdrop")!;
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("emits inspector-submit with aggregationConfig in aggregation mode", () => {
    const files = ["/a.nc", "/b.nc"];
    const el = mount({ open: "", "is-aggregation": "", file: JSON.stringify(files) });
    const handler = vi.fn();
    el.addEventListener("inspector-submit", handler);

    el.querySelector<HTMLButtonElement>("#nc-aggregate-btn")!.click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = handler.mock.calls[0][0].detail;
    expect(detail.aggregationConfig).not.toBeNull();
    expect(detail.file).toEqual(files);
  });

  it("auto-submits inspector-submit when opened with a file in single-file mode", () => {
    const el = mount({ file: "/auto.nc" });
    const handler = vi.fn();
    el.addEventListener("inspector-submit", handler);

    el.setAttribute("open", "");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.file).toBe("/auto.nc");
  });
});

// ── Tab switching ────────────────────────────────────────────────────────────

describe("tabs", () => {
  it("renders metadata and gridlook tab buttons when zarr-url is set", () => {
    const el = mount({ open: "", "zarr-url": "https://z.example.com", status: "ready" });
    el.output = "<table>data</table>";
    expect(el.querySelector('[data-tab="metadata"]')).not.toBeNull();
    expect(el.querySelector('[data-tab="gridlook"]')).not.toBeNull();
  });

  it("gridlook tab is disabled when output is not yet set", () => {
    const el = mount({ open: "", "zarr-url": "https://z.example.com", status: "loading" });
    const gridlookTab = el.querySelector<HTMLButtonElement>('[data-tab="gridlook"]')!;
    expect(gridlookTab.disabled).toBe(true);
  });

  it("metadata tab is active by default", () => {
    const el = mount({ open: "", "zarr-url": "https://z.example.com", status: "ready" });
    el.output = "<table>data</table>";
    expect(el.innerHTML).toContain("metadata");
  });
});
